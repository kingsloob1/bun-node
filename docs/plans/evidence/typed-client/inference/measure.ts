/**
 * Measures tsc cost of the inference spike, and declaration emit.
 *
 *   bun patch-router.ts && bun gen.ts && bun measure.ts     # all sizes, 3 runs each
 *   RUNS=1 bun measure.ts 50                                # quick
 *
 * Per project out/<variant>-<N>: `tsc -p --extendedDiagnostics` RUNS times
 * (median reported), then `--declaration --emitDeclarationOnly` into
 * out/<v>-<N>/.dts (errors by code, app.d.ts and total .d.ts bytes), then the
 * client checked against those declarations instead of the sources.
 */
import { $ } from "bun";
import { cpSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TSC = join(import.meta.dir, "../../../../../node_modules/.bin/tsc");
const RUNS = Number(process.env.RUNS ?? 3);
const sizes = process.argv.slice(2).map(Number);
const N_LIST = sizes.length ? sizes : [50, 200, 1000];
const out = join(import.meta.dir, "out");

function stat(text: string, label: string): number {
  const m = new RegExp(`^${label}:\\s+([\\d.]+)(K|s)?`, "m").exec(text);
  return m ? Number(m[1]) : Number.NaN;
}
const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function diag(project: string, extra: string[] = []) {
  const r = await $`${TSC} -p ${project} --extendedDiagnostics ${extra}`.nothrow().quiet();
  const text = r.stdout.toString() + r.stderr.toString();
  const errors = [...text.matchAll(/error (TS\d+)/g)].map(m => m[1]!);
  return {
    exit: r.exitCode,
    errors,
    check: stat(text, "Check time"),
    total: stat(text, "Total time"),
    memMB: stat(text, "Memory used") / 1024,
    instantiations: stat(text, "Instantiations"),
    types: stat(text, "Types"),
    text,
  };
}
function dirBytes(dir: string): number {
  let n = 0;
  for (const f of readdirSync(dir, { recursive: true }) as string[]) {
    const p = join(dir, f);
    if (statSync(p).isFile() && p.endsWith(".d.ts")) n += statSync(p).size;
  }
  return n;
}

const rows: string[] = [];
const header = "variant    N     exit  check_s  total_s  mem_MB  instantiations  types    | dts: errors           app.d.ts  own.d.ts | client-vs-dts: exit check_s";
rows.push(header);
console.log(header);
for (const N of N_LIST) {
  for (const variant of ["v0", "v1", "v2"]) {
    const project = join(out, `${variant}-${N}`);
    if (!existsSync(project)) continue;
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await diag(project));
    const r0 = runs[0]!;
    // declaration emit
    const dts = join(project, ".dts");
    rmSync(dts, { recursive: true, force: true });
    const d = await diag(project, ["--noEmit", "false", "--declaration", "--emitDeclarationOnly", "--rootDir", join(import.meta.dir, "../../../../.."), "--outDir", dts]);
    const codes = Object.entries(d.errors.reduce<Record<string, number>>((a, c) => ((a[c] = (a[c] ?? 0) + 1), a), {}))
      .map(([c, n]) => `${c}x${n}`).join(",") || "none";
    const appDts = (() => {
      for (const f of readdirSync(dts, { recursive: true }) as string[]) if (f.endsWith("app.d.ts")) return statSync(join(dts, f)).size;
      return 0;
    })();
    // the client against the declarations (variants with a client)
    let clientCol = "-";
    if (variant !== "v0" && appDts > 0) {
      const appDir = (readdirSync(dts, { recursive: true }) as string[]).find(f => f.endsWith("app.d.ts"))!.replace(/app\.d\.ts$/, "");
      const cdir = join(dts, appDir);
      cpSync(join(project, "client.ts"), join(cdir, "client.ts"));
      writeFileSync(join(cdir, "tsconfig.json"), JSON.stringify({
        extends: join(project, "tsconfig.json"),
        include: ["./client.ts"],
      }));
      const c = await diag(cdir);
      clientCol = `${c.exit} ${c.check.toFixed(2)}${c.errors.length ? ` ${[...new Set(c.errors)].join(",")}` : ""}`;
    }
    const line = [
      variant.padEnd(10), String(N).padEnd(5), String(r0.exit).padEnd(5),
      median(runs.map(r => r.check)).toFixed(2).padStart(7), median(runs.map(r => r.total)).toFixed(2).padStart(8),
      median(runs.map(r => r.memMB)).toFixed(0).padStart(7), String(median(runs.map(r => r.instantiations))).padStart(15),
      String(median(runs.map(r => r.types))).padStart(8), "  |", codes.padEnd(20), String(appDts).padStart(9), String(dirBytes(join(dts, (readdirSync(dts, { recursive: true }) as string[]).find(f => f.endsWith("app.d.ts"))?.replace(/app\.d\.ts$/, "") ?? ""))).padStart(9), " |", clientCol,
    ].join(" ");
    rows.push(line);
    console.log(line);
    if (r0.exit !== 0) console.log(r0.text.split("\n").filter(l => l.includes("error")).slice(0, 5).join("\n"));
  }
}
writeFileSync(join(import.meta.dir, `results${sizes.length ? `-${sizes.join("-")}` : ""}.txt`), `${new Date().toISOString()} bun ${Bun.version} tsc ${(await $`${TSC} -v`.text()).trim()} runs=${RUNS}\n${rows.join("\n")}\n`);
