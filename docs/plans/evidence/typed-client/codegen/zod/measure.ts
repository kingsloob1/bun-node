/**
 * Generated Zod: size and cost.
 *
 *   cd docs/plans/evidence/typed-client/codegen/zod && bun measure.ts
 *
 * 1. Emits classic and mini Zod modules for the codegen app (6 routes,
 *    committed as app.zod-*.gen.ts) and for a synthetic 50-route app with
 *    the inference spike's schema shapes (out/, git-ignored).
 * 2. Bundles each (browser, minified, zod included) and reports min/gzip, and
 *    the marginal bytes per route against a one-schema baseline.
 * 3. Times response validation of a 20-user list: the server's own schema,
 *    generated classic, generated mini, a JSON Schema validator
 *    (@cfworker/json-schema), with JSON.parse of the same body for scale.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { buildApp } from "../app";
import { buildModel } from "../describe";
import { emitZod } from "./emit-zod";
import { synthetic } from "./synthetic";

const here = import.meta.dir;
const out = join(here, "out");
mkdirSync(out, { recursive: true });

const gz = (b: Uint8Array) => Bun.gzipSync(b, { level: 9 }).length;
async function bundle(name: string, modulePath: string) {
  const entry = join(out, `${name}.entry.ts`);
  await Bun.write(entry, `import { schemas } from ${JSON.stringify(modulePath)};\nlet n = 0;\nfor (const k in schemas) n += Object.keys((schemas as Record<string, object>)[k]!).length;\nexport default n;\n(globalThis as any).__s = schemas;\n`);
  const r = await Bun.build({ entrypoints: [entry], target: "browser", minify: true, format: "esm", define: { "process.env.NODE_ENV": '"production"' } });
  if (!r.success) throw new AggregateError(r.logs, name);
  const bytes = new Uint8Array(await r.outputs[0]!.arrayBuffer());
  return { min: bytes.length, gzip: gz(bytes), evalFree: !/new Function|\beval\(/.test(new TextDecoder().decode(bytes)) };
}

const rows: string[] = [];
const log = (s: string) => { console.log(s); rows.push(s); };
log(`bun ${Bun.version}, zod ${(await import("zod/package.json")).version}`);

// 1 + 2: sizes
const appModel = buildModel(buildApp());
for (const f of ["classic", "mini"] as const) {
  const { source, warnings } = emitZod(appModel, f);
  await Bun.write(join(here, `app.zod-${f}.gen.ts`), source);
  if (f === "classic") for (const w of warnings) log(`emit warning: ${w}`);
}
const sizes: Record<string, { min: number; gzip: number; evalFree: boolean }> = {};
for (const n of [1, 50]) {
  const model = buildModel(synthetic(n));
  for (const f of ["classic", "mini"] as const) {
    const file = join(out, `synthetic-${n}.zod-${f}.gen.ts`);
    await Bun.write(file, emitZod(model, f).source);
    sizes[`${f}-${n}`] = await bundle(`synthetic-${n}-${f}`, file);
  }
}
for (const f of ["classic", "mini"] as const) {
  const one = sizes[`${f}-1`]!;
  const fifty = sizes[`${f}-50`]!;
  log(`size ${f.padEnd(7)} 1 route: ${one.min} min / ${one.gzip} gz; 50 routes: ${fifty.min} min / ${fifty.gzip} gz; per extra route ≈ ${((fifty.gzip - one.gzip) / 49).toFixed(0)} B gz; eval-free: ${fifty.evalFree}`);
}

// 3: validation cost
const User = z.object({ id: z.string(), name: z.string(), email: z.email(), role: z.enum(["admin", "member"]), createdAt: z.iso.datetime() });
const serverSchema = z.object({ items: z.array(User), next: z.number().nullable() });
const body = { items: Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: `user ${i}`, email: `u${i}@example.com`, role: i % 2 ? "admin" : "member", createdAt: new Date(1_760_000_000_000 + i).toISOString() })), next: 2 };
const text = JSON.stringify(body);
const classic = (await import(join(here, "app.zod-classic.gen.ts"))).schemas["GET /users"].responses[200];
const mini = (await import(join(here, "app.zod-mini.gen.ts"))).schemas["GET /users"].responses[200];
const { Validator } = await import("@cfworker/json-schema");
const jsonSchema = appModel.routes.find(r => r.key === "GET /users")!.responses["200"]!;
const cf = new Validator(jsonSchema as never, "2020-12", false);
const zodMini = await import("zod/mini");

function time(label: string, fn: () => unknown, iters = 20_000) {
  for (let i = 0; i < 2000; i++) fn();
  const t0 = Bun.nanoseconds();
  for (let i = 0; i < iters; i++) fn();
  const us = (Bun.nanoseconds() - t0) / iters / 1000;
  log(`cost ${label.padEnd(34)} ${us.toFixed(2)} µs/op`);
}
const ok = (r: { success: boolean }) => { if (!r.success) throw new Error("expected success"); };
time("JSON.parse of the body (reference)", () => JSON.parse(text));
time("server schema (zod classic)", () => ok(serverSchema.safeParse(body)));
time("generated classic (zod)", () => ok(classic.safeParse(body)));
time("generated mini (zod/mini)", () => ok(zodMini.safeParse(mini, body)));
time("@cfworker/json-schema", () => { if (!cf.validate(body).valid) throw new Error("invalid"); });

// failure shape: one bad field, as BunValidate's { target, message, path }
const bad = structuredClone(body) as { items: { email: string }[] };
bad.items[3]!.email = "nope";
const res = classic.safeParse(bad);
log(`failure: ${JSON.stringify(res.success ? null : res.error.issues.map((i: { message: string; path: PropertyKey[] }) => ({ target: "response", message: i.message, path: i.path.join(".") })))}`);
await Bun.write(join(here, "results.txt"), `${new Date().toISOString()}\n${rows.join("\n")}\n`);
