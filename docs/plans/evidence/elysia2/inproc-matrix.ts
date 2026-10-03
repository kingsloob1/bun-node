/**
 * `inproc.ts` with one fresh process per cell (target x scenario), rounds
 * interleaved, median of the per-process best-of-5 figures. A process per
 * cell keeps one target's JIT state, GC heap and megamorphic call sites from
 * leaking into the next (a single-process run showed Elysia 2's
 * routes-1000 at 4.5 us one run and 2.8 us the next).
 *
 *   NODE_ENV=production BUN_OPTIONS= bun inproc-matrix.ts [targets] [scenarios] [rounds]
 */
import { spawnSync } from "bun";
import process from "node:process";

const targets = (process.argv[2] ?? "raw,elysia2,elysia1,bun-common,bun-nest").split(",");
const scenarios = (process.argv[3] ?? "static,param,middleware,routes-1000,param-random,json").split(",");
const rounds = Number(process.argv[4] ?? 3);
const results: Record<string, number[]> = {};

for (let r = 0; r < rounds; r++) {
  for (const t of targets) {
    for (const s of scenarios) {
      const out = spawnSync(["bun", "inproc.ts", t, s], {
        cwd: import.meta.dir,
        env: { ...process.env, N: process.env.N ?? "50000" },
      }).stdout.toString();
      const line = out.split("\n").find((l) => l.startsWith(t));
      const ns = Number(line?.trim().split(/\s+/).at(-1));
      (results[`${t} ${s}`] ??= []).push(ns);
    }
  }
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`Bun ${Bun.version}; ns/request, median of ${rounds} processes (each best of 5)\n`);
console.log(`${"target".padEnd(16)}${scenarios.map((s) => s.padStart(14)).join("")}`);
for (const t of targets) {
  console.log(`${t.padEnd(16)}${scenarios.map((s) => String(median(results[`${t} ${s}`])).padStart(14)).join("")}`);
}
console.log(`\nraw: ${JSON.stringify(results)}`);
