/**
 * The generated map at scale: how long does a client file take to check
 * against a generated `Routes` interface of N routes, and how big is it?
 *   bun scale.ts            (N = 50, 200, 1000)
 */
import { $ } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildModel } from "./describe";
import { emitRoutes } from "./emit-dts";
import { synthetic } from "./zod/synthetic";

const TSC = join(import.meta.dir, "../../../../../node_modules/.bin/tsc");
const lines: string[] = [];
for (const n of [50, 200, 1000]) {
  const dir = join(import.meta.dir, "zod/out", `scale-${n}`);
  mkdirSync(dir, { recursive: true });
  const t0 = performance.now();
  const model = buildModel(synthetic(n));
  const t1 = performance.now();
  const ts = emitRoutes(model);
  const t2 = performance.now();
  writeFileSync(join(dir, "routes.gen.ts"), ts);
  writeFileSync(join(dir, "client.ts"), `import type { Routes } from "./routes.gen";
import { createFlatClient } from "../../../client-types";
const c = createFlatClient<Routes>("/");
export async function run() {
  const a = await c.get("/r0/items/:id0", { params: { id0: "x" }, query: { page: 1 } });
  if (a.status === 200) { const s: string = a.data.createdAt; void s; }
  await c.post("/r1/items", { body: { name: "n", tags: [], n1: 1 } });
  // @ts-expect-error page is a number
  await c.get("/r${n - 1}/items/:id${n - 1}", { params: { id${n - 1}: "x" }, query: { page: "1" } });
}
`);
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ extends: "../../../../../../../../tsconfig.base.json", compilerOptions: { types: [], lib: ["ESNext", "DOM"] }, include: ["./client.ts"] }));
  const r = await $`${TSC} -p ${dir} --extendedDiagnostics`.nothrow().quiet();
  const text = r.stdout.toString();
  const get = (l: string) => /^(?:\S.*?):\s+([\d.]+)/m.exec(text.split("\n").find(x => x.startsWith(l)) ?? "")?.[1];
  const line = `N=${n}: model ${(t1 - t0).toFixed(0)} ms, emit ${(t2 - t1).toFixed(0)} ms, routes.gen.ts ${ts.length} B; client check exit ${r.exitCode}, check ${get("Check time")} s, memory ${(Number(get("Memory used")) / 1024).toFixed(0)} MB, instantiations ${get("Instantiations")}`;
  console.log(line);
  lines.push(line);
}
await Bun.write(join(import.meta.dir, "scale-results.txt"), `${new Date().toISOString()} bun ${Bun.version}\n${lines.join("\n")}\n`);
