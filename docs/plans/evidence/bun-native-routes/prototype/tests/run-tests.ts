/**
 * Runs a package's own test suite against the prototype adapter in three
 * modes and reports every test whose outcome differs between them:
 *
 *   stock    preload on, both switches off — must equal a plain `bun test`
 *   served   BNR_SERVED=1: fetch() over a real socket, no native routes
 *   native   BNR_SERVED=1 BNR_NATIVE=1: the same, through Bun's route table
 *   index    BNR_INDEX=1 BNR_RINGCACHE=1: in-process fetch(), every router
 *            with the JS candidate index and the ring-buffer FIFO route cache
 *            (compared against stock)
 *
 * A test failing in `native` but passing in `served` is a semantic break of
 * native routing. One failing in `served` already is an artefact of the
 * served-fetch harness (a socket has a peer, a stub server does not), not of
 * native routing, and is listed separately.
 *
 *   bun run-tests.ts bun-common [--out ../../results/prototype-tests-bun-common.json]
 *   bun run-tests.ts bun-nest
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const pkg = process.argv[2] ?? "bun-common";
const outIndex = process.argv.indexOf("--out");
const out = outIndex > 0 ? process.argv[outIndex + 1] : undefined;
const root = resolve(import.meta.dir, "../../../../../..");
const cwd = `${root}/packages/${pkg}`;
const preload = resolve(import.meta.dir, "preload.ts");
const scratch = process.env.BNR_SCRATCH ?? "/tmp";

type Outcome = "pass" | "fail" | "skip";

function parseJunit(xml: string): Map<string, Outcome> {
  const results = new Map<string, Outcome>();
  const re = /<testcase name="([^"]*)" classname="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(re)) {
    const body = m[4] ?? "";
    const outcome: Outcome = /<failure|<error/.test(body) ? "fail" : /<skipped/.test(body) ? "skip" : "pass";
    results.set(`${m[2]} > ${m[1]}`, outcome);
  }
  return results;
}

function run(mode: string, env: Record<string, string>) {
  const file = `${scratch}/bnr-junit-${pkg}-${mode}-${process.pid}.xml`;
  const started = performance.now();
  const proc = Bun.spawnSync(
    ["bun", "test", "--preload", preload, "--reporter=junit", `--reporter-outfile=${file}`],
    { cwd, env: { ...process.env, ...env, BNR_NEST: pkg === "bun-nest" ? "1" : "0" }, stdout: "pipe", stderr: "pipe" },
  );
  const seconds = (performance.now() - started) / 1000;
  const tail = proc.stderr.toString().trim().split("\n").slice(-6).join("\n");
  let results = new Map<string, Outcome>();
  try {
    results = parseJunit(readFileSync(file, "utf8"));
    rmSync(file);
  } catch {
    console.error(`${mode}: no junit output\n${tail}`);
  }
  const count = (o: Outcome) => [...results.values()].filter((v) => v === o).length;
  console.log(`${mode.padEnd(7)} pass ${count("pass")}  fail ${count("fail")}  skip ${count("skip")}  (${seconds.toFixed(1)}s, exit ${proc.exitCode})`);
  return results;
}

console.log(`${pkg}: bun test --preload prototype/tests/preload.ts, Bun ${Bun.version} (${Bun.revision})\n`);
const stock = run("stock", { BNR_SERVED: "0", BNR_NATIVE: "0" });
const served = run("served", { BNR_SERVED: "1", BNR_NATIVE: "0" });
const native = run("native", { BNR_SERVED: "1", BNR_NATIVE: "1" });
const indexed = run("index", { BNR_SERVED: "0", BNR_NATIVE: "0", BNR_INDEX: "1", BNR_RINGCACHE: "1" });
const indexBreaks = [...indexed].filter(([name, o]) => o === "fail" && stock.get(name) === "pass").map(([n]) => n);

const breaks = [...native].filter(([name, o]) => o === "fail" && served.get(name) === "pass").map(([n]) => n);
const fixedByNative = [...native].filter(([name, o]) => o === "pass" && served.get(name) === "fail").map(([n]) => n);
const harness = [...served].filter(([name, o]) => o === "fail" && stock.get(name) === "pass").map(([n]) => n);
const stockFails = [...stock].filter(([, o]) => o === "fail").map(([n]) => n);

console.log(`\nstock failures (preload itself broke something): ${stockFails.length}`);
for (const n of stockFails) console.log(`  ${n}`);
console.log(`native breaks (fail native, pass served): ${breaks.length}`);
for (const n of breaks) console.log(`  ${n}`);
console.log(`pass native, fail served: ${fixedByNative.length}`);
for (const n of fixedByNative) console.log(`  ${n}`);
console.log(`served-harness artefacts (fail served, pass stock): ${harness.length}`);
for (const n of harness) console.log(`  ${n}`);
console.log(`index breaks (fail index, pass stock): ${indexBreaks.length}`);
for (const n of indexBreaks) console.log(`  ${n}`);

if (out) {
  writeFileSync(out, `${JSON.stringify({ pkg, bun: `${Bun.version} (${Bun.revision})`, stockFails, breaks, fixedByNative, harness, indexBreaks, totals: { stock: stock.size, served: served.size, native: native.size, index: indexed.size } }, null, 2)}\n`);
}
