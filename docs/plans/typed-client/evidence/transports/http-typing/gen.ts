/**
 * Generates the HTTP typing projects (typed-client plan §3.1, PR-C2): N
 * routes in `defineRoutes` registries of 50 (bun-common, zod 4), every route
 * with its own zod schemas: GETs with params, a coerced and defaulted query
 * and fields, POSTs with params and a body; each with a 200 body and a
 * shared 404 problem.
 *
 *   bun http-typing/gen.ts            # N = 50, 200, 1000
 *
 * out/base-N/: the registries alone, no client: the cost of the server code.
 * out/infer-N/: the registries, `interface Api extends RoutesOf<typeof m0>, …`,
 *   and a client over it (`Client<Api>`, bun-client): the monorepo opt-in.
 * out/gen-N/: `api.gen.ts`, written by bun-client's generator
 *   (`generateRoutes`) from the registries' OpenAPI document, and the same
 *   client over it: the default (§3.4). No server code in the program.
 *
 * Each client module calls every route once, with `@ts-expect-error`
 * negative controls (a wrong param type, an unknown route, a wrong body
 * field), so a clean check proves the types bind.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { BunRouter } from "@kingsleyweb/bun-common";
import { generateOpenApi } from "@kingsleyweb/bun-common/lib/docs";
import { generateRoutes } from "@kingsleyweb/bun-client/codegen";

const out = join(import.meta.dir, "out");
const ROOT = join(import.meta.dir, "../../../../../..");
const sizes = process.argv.slice(2).map(Number);
const N_LIST = sizes.length ? sizes : [50, 200, 1000];
const PER_MODULE = 50;

/** The repo's base config, so bun-common's sources check as they do in the repo. */
const tsconfig = (dir: string, include: string[]) =>
  JSON.stringify(
    {
      extends: relative(dir, join(ROOT, "tsconfig.base.json")),
      compilerOptions: { types: ["bun"], noEmit: true },
      include,
    },
    null,
    2,
  );

const KINDS = [
  ["z.string().min(1)", '"s"'],
  ["z.number().int()", "1"],
  ["z.boolean()", "true"],
  ["z.array(z.string())", '["s"]'],
  ['z.enum(["a", "b", "c"])', '"a"'],
  ["z.string().optional()", ""],
  ["z.coerce.number()", "2"],
  ["z.object({ x: z.number(), y: z.number() })", "{ x: 1, y: 2 }"],
] as const;
/** A field set, varied per seed so no two schemas are identical; f0 is never optional. */
const fields = (seed: number) =>
  Array.from({ length: 3 + (seed % 4) }, (_, i) => `f${i}: ${KINDS[(seed + i) % KINDS.length]![0]}`)
    .join(", ")
    .replace(/^f0: z\.string\(\)\.optional\(\)/, "f0: z.string()");
/** A valid value for `fields(seed)`; with `wrongF0`, its f0 of another type (the negative control). */
const value = (seed: number, wrongF0 = false) =>
  `{ ${Array.from({ length: 3 + (seed % 4) }, (_, i) => {
    const k = (seed + i) % KINDS.length;
    if (i === 0 && wrongF0) return [0, 4, 5].includes(k) ? "f0: 1" : 'f0: "wrong"';
    if (i === 0 && k === 5) return 'f0: "s"';
    return k === 5 ? "" : `f${i}: ${KINDS[k]![1]}`;
  })
    .filter(Boolean)
    .join(", ")} }`;

const isGet = (r: number) => r % 2 === 0;

function registry(m: number, routes: number[]): string {
  const lines = [
    'import { defineRoutes, validate } from "@kingsleyweb/bun-common";',
    'import { z } from "zod";',
    "",
    "const Problem = z.object({ type: z.string(), title: z.string(), code: z.string() });",
    'const P = { type: "about:blank", title: "Not Found", code: "NOT_FOUND" };',
    "",
    `export const m${m} = defineRoutes("/m${m}", (r) => ({`,
  ];
  for (const r of routes) {
    const request = isGet(r)
      ? `params: z.object({ id: z.string() }), query: z.object({ page: z.coerce.number().default(1), ${fields(r * 7)} })`
      : `params: z.object({ id: z.string() }), body: z.object({ ${fields(r * 7)} })`;
    lines.push(
      `  r${r}: r.${isGet(r) ? "get" : "post"}(`,
      `    "/r${r}/:id",`,
      `    validate({ ${request} }, { responses: { 200: z.object({ ${fields(r * 13 + 1)} }), 404: Problem } }),`,
      "    (_req, res) => res.status(404).json(P),",
      "  ),",
    );
  }
  lines.push("}));", "");
  return lines.join("\n");
}

function client(m: number, routes: number[], from: string): string {
  const lines = [
    'import type { Client } from "@kingsleyweb/bun-client";',
    `import type { ${from === "./api.gen" ? "Routes as Api" : "Api"} } from "${from}";`,
    "",
    "declare const api: Client<Api>;",
    "",
    "export async function use(): Promise<void> {",
  ];
  for (const r of routes) {
    const path = `/m${m}/r${r}/:id`;
    const call = isGet(r)
      ? `api.get("${path}", { params: { id: "1" }, query: { page: 1, ${value(r * 7).slice(2, -2)} } })`
      : `api.post("${path}", { params: { id: "1" }, body: ${value(r * 7)} })`;
    lines.push(`  const r${r} = await ${call};`, `  if (r${r}.ok) void r${r}.data.f0;`, `  else void r${r}.error.code;`);
    if (r === routes[0]) {
      lines.push(
        "  // @ts-expect-error the id is a string",
        `  void ${call.replace('{ id: "1" }', "{ id: 1 }")};`,
        "  // @ts-expect-error not a route",
        `  void api.get("/m${m}/nope");`,
      );
    }
    if (!isGet(r) && r === routes[1]) {
      lines.push("  // @ts-expect-error f0 has another type", `  void api.post("${path}", { params: { id: "1" }, body: ${value(r * 7, true)} });`);
    }
  }
  lines.push("}", "");
  return lines.join("\n");
}

rmSync(out, { recursive: true, force: true });
for (const N of N_LIST) {
  const modules = Array.from({ length: Math.ceil(N / PER_MODULE) }, (_, m) =>
    Array.from({ length: Math.min(PER_MODULE, N - m * PER_MODULE) }, (_, i) => m * PER_MODULE + i),
  );
  for (const variant of ["base", "infer", "gen"] as const) {
    const dir = join(out, `${variant}-${N}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tsconfig.json"), tsconfig(dir, ["./**/*.ts"]));
    if (variant !== "gen") {
      modules.forEach((routes, m) => writeFileSync(join(dir, `registry${m}.ts`), registry(m, routes)));
    }
    if (variant === "infer") {
      writeFileSync(
        join(dir, "api.ts"),
        [
          'import type { RoutesOf } from "@kingsleyweb/bun-common";',
          ...modules.map((_, m) => `import type { m${m} } from "./registry${m}";`),
          "",
          `export interface Api extends ${modules.map((_, m) => `RoutesOf<typeof m${m}>`).join(", ")} {}`,
          "",
        ].join("\n"),
      );
    }
    if (variant !== "base") {
      modules.forEach((routes, m) =>
        writeFileSync(join(dir, `client${m}.ts`), client(m, routes, variant === "gen" ? "./api.gen" : "./api")),
      );
    }
  }
  // The generated map: the registries documented in process, as `generate --module` does.
  const router = new BunRouter();
  for (let m = 0; m < modules.length; m++) {
    const mod = (await import(join(out, `base-${N}`, `registry${m}.ts`))) as Record<string, { mount: string; router: BunRouter }>;
    const registryModule = mod[`m${m}`]!;
    router.use(registryModule.mount, registryModule.router);
  }
  const t = performance.now();
  const { code, routes } = generateRoutes(generateOpenApi(router, { title: "API", version: "1" }).document);
  console.log(`N=${N}: generated ${routes} routes, ${(code.length / 1024).toFixed(0)} KB, in ${(performance.now() - t).toFixed(0)} ms`);
  writeFileSync(join(out, `gen-${N}`, "api.gen.ts"), code);
}
