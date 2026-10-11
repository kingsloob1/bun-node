/**
 * Generates the inference spike's projects: out/<variant>-<N>/.
 *
 *   v0  today: statements on the real BunRouter; no route map, no client
 *   v1  the patched BunRouter (patch-router.ts): chained verb calls accumulate
 *       a route map; sub-routers mounted with use(); a flat "VERB /path" client
 *   v2  no BunRouter change: defineRoutes() registries of named operations;
 *       a tRPC-style client over the registry objects
 *
 * Every route has its own zod schemas (params, query, body on POST/PUT) and
 * two declared responses, so nothing is shared between routes' types.
 *
 *   bun gen.ts            # N = 50, 200, 1000
 *   bun gen.ts 200        # one size
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PER_MODULE = 50;
const sizes = process.argv.slice(2).map(Number);
const N_LIST = sizes.length ? sizes : [50, 200, 1000];
const VERBS = ["get", "post", "put", "delete", "get"] as const;
const rootRel = "../../../../../../..";

function route(k: number) {
  const verb = VERBS[k % VERBS.length]!;
  const path = verb === "post" ? `/r${k}/items` : `/r${k}/items/:id`;
  const params = verb === "post" ? "" : `params: z.object({ id${k}: z.string() }), `;
  const query = `query: z.object({ page: z.coerce.number().int().optional(), q${k}: z.string().optional() })`;
  const body = verb === "post" || verb === "put"
    ? `, body: z.object({ name: z.string(), tags: z.array(z.string()), n${k}: z.number(), meta: z.object({ a: z.boolean() }).optional() })`
    : "";
  const realPath = verb === "post" ? path : path.replace(":id", `:id${k}`);
  const schemas = `{ ${params}${query}${body} }`;
  const responses = `{ 200: z.object({ id: z.string(), name: z.string(), n${k}: z.number(), createdAt: z.date() }), 404: z.object({ type: z.string(), title: z.string(), status: z.literal(404) }) }`;
  // route 0 also proves the handler's req is still narrowed (not any) after the change
  const guard = k === 0 ? `\n    // @ts-expect-error page is number | undefined, not string\n    const bad: string = req.query.page; void bad;\n   ` : "";
  const handler = `(req, res) => {${guard} res.json({ id: String(req.query.page ?? 0), name: "x", n${k}: 1, createdAt: new Date() }); }`;
  return { verb, path: realPath, schemas, responses, handler };
}

function tsconfig(variant: string) {
  const lib = variant === "v1" ? "../../.patched/bun-common/lib/*" : `${rootRel}/packages/bun-common/lib/*`;
  return JSON.stringify({
    extends: `${rootRel}/tsconfig.base.json`,
    compilerOptions: { types: ["bun"], paths: { "#lib/*": [lib], "lib/*": [lib], "utils/*": [lib.replace("/*", "/utils/*")] } },
    include: ["./*.ts", "../../spike-types.ts"],
  }, null, 2);
}

for (const N of N_LIST) {
  const modules = Math.ceil(N / PER_MODULE);
  for (const variant of ["v0", "v1", "v2"]) {
    const dir = join(import.meta.dir, "out", `${variant}-${N}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tsconfig.json"), tsconfig(variant));
    const names: string[] = [];
    for (let m = 0; m < modules; m++) {
      const count = Math.min(PER_MODULE, N - m * PER_MODULE);
      const name = `m${m}`;
      names.push(name);
      const lines: string[] = [`import { z } from "zod";`];
      if (variant === "v2") {
        lines.push(`import { defineRoutes, v } from "../../spike-types";`);
        lines.push(`export const ${name} = defineRoutes("/${name}", (r) => ({`);
        for (let k = 0; k < count; k++) {
          const rt = route(k);
          lines.push(`  op${k}: r.${rt.verb}("${rt.path}", v(${rt.schemas}, ${rt.responses}), ${rt.handler}),`);
        }
        lines.push(`}));`);
      } else {
        lines.push(`import { BunRouter } from "#lib/BunRouter";`, `import { v } from "../../spike-types";`);
        if (variant === "v1") {
          lines.push(`export const ${name} = new BunRouter<"/${name}">()`);
          for (let k = 0; k < count; k++) {
            const rt = route(k);
            lines.push(`  .${rt.verb}("${rt.path}", v(${rt.schemas}, ${rt.responses}), ${rt.handler})`);
          }
          lines[lines.length - 1] += ";";
        } else {
          lines.push(`export const ${name} = new BunRouter<"/${name}">();`);
          for (let k = 0; k < count; k++) {
            const rt = route(k);
            lines.push(`${name}.${rt.verb}("${rt.path}", v(${rt.schemas}, ${rt.responses}), ${rt.handler});`);
          }
        }
      }
      writeFileSync(join(dir, `${name}.ts`), `${lines.join("\n")}\n`);
    }
    // the app
    const app: string[] = names.map(n => `import { ${n} } from "./${n}";`);
    if (variant === "v0") {
      app.push(`import { BunRouter } from "#lib/BunRouter";`, `export const app = new BunRouter();`);
      for (const n of names) app.push(`app.use("/${n}", ${n});`);
    } else if (variant === "v1") {
      app.push(`import { BunRouter } from "#lib/BunRouter";`);
      app.push(`export const app = new BunRouter()${names.map(n => `\n  .use("/${n}", ${n})`).join("")};`);
      app.push(`export type AppRoutes = typeof app extends BunRouter<string, unknown, string, infer R> ? R : never;`);
    } else {
      app.push(`export const api = { ${names.join(", ")} };`, `export type Api = typeof api;`);
    }
    writeFileSync(join(dir, "app.ts"), `${app.join("\n")}\n`);
    // the client, with positive and negative checks on a few routes
    if (variant !== "v0") {
      const c: string[] = [];
      const picks = [0, 1, 3].map(k => ({ m: modules - 1, k }));
      if (variant === "v1") {
        c.push(`import type { AppRoutes } from "./app";`, `import { createFlatClient } from "../../spike-types";`, `const client = createFlatClient<AppRoutes>("/");`, `export async function run() {`);
        for (const { m, k } of picks) {
          const rt = route(k);
          const full = `/m${m}${rt.path}`;
          const params = rt.path.includes(":") ? `params: { id${k}: "a" }, ` : "";
          const body = rt.verb === "post" ? `, body: { name: "n", tags: [], n${k}: 1 }` : "";
          c.push(`  const r${k} = await client.${rt.verb}("${full}", { ${params}query: { page: 2 }${body} });`);
          c.push(`  if (r${k}.status === 200) { const s: string = r${k}.data.createdAt; const n: number = r${k}.data.n${k}; void s; void n; }`);
          c.push(`  if (r${k}.status === 404) { const t: 404 = r${k}.data.status; void t; }`);
          c.push(`  // @ts-expect-error a page must be a number`);
          c.push(`  await client.${rt.verb}("${full}", { ${params}query: { page: "x" }${body} });`);
        }
        c.push(`  // @ts-expect-error no such route`);
        c.push(`  await client.get("/nope", {});`);
        c.push(`}`);
      } else {
        c.push(`import type { Api } from "./app";`, `import { createNamedClient } from "../../spike-types";`, `const client = createNamedClient<Api>("/");`, `export async function run() {`);
        for (const { m, k } of picks) {
          const rt = route(k);
          const params = rt.path.includes(":") ? `params: { id${k}: "a" }, ` : "";
          const body = rt.verb === "post" ? `, body: { name: "n", tags: [], n${k}: 1 }` : "";
          c.push(`  const r${k} = await client.m${m}.op${k}({ ${params}query: { page: 2 }${body} });`);
          c.push(`  if (r${k}.status === 200) { const s: string = r${k}.data.createdAt; const n: number = r${k}.data.n${k}; void s; void n; }`);
          c.push(`  if (r${k}.status === 404) { const t: 404 = r${k}.data.status; void t; }`);
          c.push(`  // @ts-expect-error a page must be a number`);
          c.push(`  await client.m${m}.op${k}({ ${params}query: { page: "x" }${body} });`);
        }
        c.push(`  // @ts-expect-error no such operation`);
        c.push(`  await client.m0.nope({});`);
        c.push(`}`);
      }
      writeFileSync(join(dir, "client.ts"), `${c.join("\n")}\n`);
    }
  }
  console.log(`generated N=${N}: ${modules} modules × 3 variants`);
}
