/**
 * `run.ts` with `wrk` as the load tool, for machines without `oha`.
 *
 *   bun wrk-run.ts [--targets a,b] [--scenarios s,t] [--rounds 3]
 *                  [--duration 5] [--warmup 2] [--connections 64]
 *                  [--threads 2] [--out ../results/x.json]
 *                  [--base /path/to/another/checkout]
 *
 * Same method as run.ts: one fresh server process per (target, scenario)
 * cell, a discarded warm-up, rounds interleaved so a noisy minute lands on
 * every target, medians reported. The server is pinned to CPU 0 and wrk to the
 * remaining CPUs when `taskset` exists, so the two do not trade cores.
 * `param-random` and `json` use Lua scripts (a fresh 8-digit id per request,
 * and a POST body).
 *
 * A target written `base/<target>` runs `<target>` from the checkout given by
 * `--base` (a `git worktree` of the comparison commit, with `bun install` run
 * in it and in its `benchmarks/`), so a before/after pair shares one run.
 */
import { spawn, spawnSync } from "bun";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    targets: { type: "string", default: "raw-routes,elysia,elysia2,bun-common,bun-nest" },
    scenarios: { type: "string", default: "static,param,middleware,routes-1000,param-random,json" },
    rounds: { type: "string", default: "3" },
    duration: { type: "string", default: "5" },
    warmup: { type: "string", default: "2" },
    connections: { type: "string", default: "64" },
    threads: { type: "string", default: "2" },
    routes: { type: "string", default: "1000" },
    out: { type: "string" },
    base: { type: "string" },
  },
});

const ROUTES = Number(values.routes);
const tmp = mkdtempSync(join(os.tmpdir(), "wrk-run-"));
const lua = (name: string, body: string) => {
  const path = join(tmp, `${name}.lua`);
  writeFileSync(path, body);
  return path;
};

interface Scenario { path: string; script?: string }
const SCENARIOS: Record<string, Scenario> = {
  "static": { path: "/static" },
  "param": { path: "/user/42" },
  "middleware": { path: "/mw/hit" },
  "routes-1000": { path: `/r${ROUTES - 1}/7` },
  "param-random": {
    path: "/",
    script: lua(
      "random",
      `math.randomseed(os.time())\nrequest = function()\n  return wrk.format("GET", "/r${ROUTES - 1}/" .. math.random(10000000, 99999999))\nend\n`,
    ),
  },
  "json": {
    path: "/json",
    script: lua(
      "json",
      `wrk.method = "POST"\nwrk.body = '{"n":7}'\nwrk.headers["Content-Type"] = "application/json"\n`,
    ),
  },
};

const hasTaskset = spawnSync(["sh", "-c", "command -v taskset"]).exitCode === 0;
const cpus = os.cpus().length;
const pin = (cpuList: string, argv: string[]) => (hasTaskset && cpus > 1 ? ["taskset", "-c", cpuList, ...argv] : argv);

async function startTarget(target: string) {
  let script = `${import.meta.dir}/servers.ts`;
  if (target.startsWith("base/")) {
    if (!values.base) throw new Error(`${target} needs --base`);
    script = join(values.base, "docs/plans/evidence/bun-native-routes/bench/servers.ts");
    target = target.slice("base/".length);
  }
  const proc = spawn(pin("0", ["bun", script, target]), {
    env: { ...process.env, ROUTES: String(ROUTES), NODE_ENV: "production" },
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = proc.stdout.getReader();
  let text = "";
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
    const m = /READY (\d+)/.exec(text);
    if (m) return { proc, port: Number(m[1]) };
  }
  proc.kill();
  throw new Error(`${target} did not start: ${text}`);
}

function wrk(port: number, s: Scenario, seconds: string): { rps: number; non2xx: number } {
  const argv = ["wrk", "-t", values.threads!, "-c", values.connections!, "-d", `${seconds}s`, "--latency"];
  if (s.script) argv.push("-s", s.script);
  argv.push(`http://127.0.0.1:${port}${s.path}`);
  const out = spawnSync(pin(`1-${Math.max(1, cpus - 1)}`, argv)).stdout.toString();
  const rps = Number(/Requests\/sec:\s+([\d.]+)/.exec(out)?.[1] ?? Number.NaN);
  const non2xx = Number(/Non-2xx or 3xx responses: (\d+)/.exec(out)?.[1] ?? 0);
  return { rps, non2xx };
}

const targets = values.targets!.split(",");
const scenarios = values.scenarios!.split(",");
const runs: Record<string, number[]> = {};
for (let round = 0; round < Number(values.rounds); round++) {
  for (const target of targets) {
    for (const scenario of scenarios) {
      const s = SCENARIOS[scenario];
      if (!s) throw new Error(`unknown scenario ${scenario}`);
      const { proc, port } = await startTarget(target);
      try {
        wrk(port, s, values.warmup!);
        const { rps, non2xx } = wrk(port, s, values.duration!);
        if (non2xx) console.error(`  ! ${target} ${scenario}: ${non2xx} non-2xx`);
        (runs[`${target}\t${scenario}`] ??= []).push(rps);
        console.error(`round ${round + 1} ${target.padEnd(18)} ${scenario.padEnd(13)} ${Math.round(rps)}`);
      } finally {
        proc.kill();
        await proc.exited;
      }
    }
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
console.log(`| target | ${scenarios.join(" | ")} |`);
console.log(`|---|${scenarios.map(() => "---:").join("|")}|`);
for (const target of targets) {
  const cells = scenarios.map((sc) => Math.round(median(runs[`${target}\t${sc}`] ?? [Number.NaN])).toLocaleString("en-US"));
  console.log(`| ${target} | ${cells.join(" | ")} |`);
}
if (values.out) {
  writeFileSync(values.out, JSON.stringify({ bun: Bun.version, cpus, connections: values.connections, duration: values.duration, runs }, null, 2));
}
