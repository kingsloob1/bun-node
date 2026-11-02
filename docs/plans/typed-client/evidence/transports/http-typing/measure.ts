/**
 * Type-check cost of the HTTP client, inferred (`RoutesOf`) vs generated (bun-client's generator), typed-client plan §3.1.
 *
 *   bun http-typing/gen.ts && bun http-typing/measure.ts        # RUNS=3 by default
 *
 * Per project out/<variant>-<N>: `tsc -p --extendedDiagnostics` (TypeScript
 * 6.0.3, the repo's) RUNS times, median reported; then a bare `bun --check`
 * in the project directory (TypeScript 7, the repo's checker), wall time,
 * median of RUNS. Both must exit 0: the clients carry `@ts-expect-error`
 * negative controls, so a clean check proves the types bind.
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../../../..");
const TSC = join(ROOT, "node_modules/.bin/tsc");
const RUNS = Number(process.env.RUNS ?? 3);
const out = join(import.meta.dir, "out");
const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const stat = (text: string, label: string) => {
  const m = new RegExp(`^${label}:\\s+([\\d.]+)`, "m").exec(text);
  return m ? Number(m[1]) : Number.NaN;
};
const env = { ...process.env };
delete env.CLAUDECODE;
delete env.AGENT;
delete env.REPL_ID;

const header = "variant  N     tsc: exit check_s  mem_MB  instantiations | bun --check: exit wall_ms";
console.log(header);
for (const N of [50, 200, 1000]) {
  for (const variant of ["base", "infer", "gen"]) {
    const dir = join(out, `${variant}-${N}`);
    if (!existsSync(dir)) continue;
    const checks: number[] = [];
    const mems: number[] = [];
    let inst = 0;
    let exit = 0;
    for (let i = 0; i < RUNS; i++) {
      const r = await $`${TSC} -p ${dir} --extendedDiagnostics`.nothrow().quiet();
      const text = r.stdout.toString();
      exit ||= r.exitCode;
      checks.push(stat(text, "Check time"));
      mems.push(stat(text, "Memory used") / 1024);
      inst = stat(text, "Instantiations");
    }
    const walls: number[] = [];
    let bexit = 0;
    for (let i = 0; i < RUNS; i++) {
      const t = performance.now();
      const r = await $`bun --check`.cwd(dir).env(env).nothrow().quiet();
      walls.push(performance.now() - t);
      bexit ||= r.exitCode;
    }
    console.log(
      `${variant.padEnd(8)} ${String(N).padEnd(5)} ${String(exit).padStart(9)} ${median(checks).toFixed(2).padStart(7)} ${median(mems).toFixed(0).padStart(7)} ${String(inst).padStart(15)} | ${String(bexit).padStart(16)} ${median(walls).toFixed(0).padStart(7)}`,
    );
  }
}
