/**
 * Drives `servers.ts` targets with `oha` and records medians.
 *
 *   bun run.ts --verify                         # every target answers correctly
 *   bun run.ts [--targets a,b] [--scenarios s,t] [--rounds 3] [--duration 8]
 *              [--connections 64] [--out ../results/x.json]
 *
 * Each (target, scenario) cell runs in a fresh server process. Rounds are
 * interleaved — round 1 of every cell, then round 2 — so a noisy minute
 * lands on every target rather than on one. Before each
 * round it waits until the 1-minute load average is under LOAD_MAX (other
 * sessions share the machine), and records the load each cell started at.
 */
import { spawn } from "bun";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    verify: { type: "boolean", default: false },
    targets: { type: "string", default: "raw-routes,raw-fetch,bun-common,bun-common-lean,bun-nest,elysia" },
    scenarios: { type: "string", default: "static,param,middleware,routes-1000,param-random,json" },
    rounds: { type: "string", default: "3" },
    duration: { type: "string", default: "8" },
    connections: { type: "string", default: "64" },
    out: { type: "string" },
    routes: { type: "string", default: "1000" },
  },
});

const LOAD_MAX = Number(process.env.LOAD_MAX ?? 2);
const ROUTES = Number(values.routes);

interface Scenario {
  path: string;
  method?: string;
  body?: string;
  random?: boolean;
  expect: (port: number) => string;
}
const SCENARIOS: Record<string, Scenario> = {
  static: { path: "/static", expect: () => "ok" },
  param: { path: "/user/42", expect: () => "42" },
  middleware: { path: "/mw/hit", expect: () => "mw:3" },
  "routes-1000": { path: `/r${ROUTES - 1}/7`, expect: () => `r${ROUTES - 1}:7` },
  // a fresh id per request: defeats any per-path cache (BunRouter's is 50k)
  "param-random": { path: `/r${ROUTES - 1}/[0-9]{8}`, random: true, expect: () => "" },
  json: { path: "/json", method: "POST", body: '{"n":7}', expect: () => '{"ok":true,"n":7}' },
};

async function startTarget(target: string) {
  const proc = spawn(["bun", `${import.meta.dir}/servers.ts`, target], {
    env: { ...process.env, ROUTES: String(ROUTES), NODE_ENV: "production" },
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = proc.stdout.getReader();
  let text = "";
  const deadline = Date.now() + 60_000;
  while (!/READY (\d+)/.test(text)) {
    if (Date.now() > deadline) throw new Error(`${target} did not start`);
    const { value, done } = await reader.read();
    if (done) throw new Error(`${target} exited before READY: ${text}`);
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const port = Number(/READY (\d+)/.exec(text)![1]);
  return { port, stop: () => proc.kill() /* by PID: proc is our child */, pid: proc.pid };
}

async function waitForQuiet(): Promise<number> {
  for (let i = 0; ; i++) {
    const load = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
    if (load < LOAD_MAX) return load;
    if (i % 6 === 0) console.error(`  load ${load} >= ${LOAD_MAX}, waiting…`);
    if (i > 90) {
      console.error(`  load never fell under ${LOAD_MAX} (15 min); running at ${load}`);
      return load;
    }
    await Bun.sleep(10_000);
  }
}

function oha(port: number, s: Scenario, seconds: number, connections: number) {
  const url = `http://127.0.0.1:${port}${s.path}`;
  const args = ["oha", "-z", `${seconds}s`, "-c", String(connections), "--no-tui", "--output-format", "json"];
  if (s.method) args.push("-m", s.method);
  if (s.body) args.push("-d", s.body, "-T", "application/json");
  if (s.random) args.push("--rand-regex-url");
  args.push(url);
  const out = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  const json = JSON.parse(out.stdout.toString()) as {
    summary: { requestsPerSec: number; successRate: number };
    latencyPercentiles: { p50: number; p99: number };
    statusCodeDistribution: Record<string, number>;
  };
  return {
    rps: json.summary.requestsPerSec,
    p50ms: json.latencyPercentiles.p50 * 1000,
    p99ms: json.latencyPercentiles.p99 * 1000,
    status: json.statusCodeDistribution,
  };
}

const targets = values.targets!.split(",");
/** Cells that cannot answer by construction: the lean adapter parses no body. */
const SKIP = new Set(["bun-common-lean:json", "proto-native-lean:json", "proto-ceiling-lean:json", "proto-index-lean:json", "proto-index-rc-lean:json"]);
const scenarios = values.scenarios!.split(",");

if (values.verify) {
  let failures = 0;
  for (const target of targets) {
    const server = await startTarget(target);
    for (const name of scenarios) {
      const s = SCENARIOS[name];
      const path = s.random ? `/r${ROUTES - 1}/12345678` : s.path;
      const expected = s.random ? `r${ROUTES - 1}:12345678` : s.expect(server.port);
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: s.method ?? "GET",
        body: s.body,
        headers: s.body ? { "content-type": "application/json" } : undefined,
      });
      const text = await res.text();
      const ok = res.status === 200 && text === expected;
      if (!ok) failures++;
      console.log(`${ok ? "ok  " : "FAIL"} ${target.padEnd(18)} ${name.padEnd(13)} ${res.status} ${JSON.stringify(text)}`);
    }
    server.stop();
  }
  process.exit(failures ? 1 : 0);
}

const rounds = Number(values.rounds);
const seconds = Number(values.duration);
const connections = Number(values.connections);
const raw: Record<string, Record<string, ReturnType<typeof oha>[]>> = {};
const loads: number[] = [];

for (let round = 0; round < rounds; round++) {
  // The benchmark itself holds the 1-minute load near 2 (one server core plus
  // oha's workers), so the quiet check gates each round, not each cell.
  await waitForQuiet();
  for (const name of scenarios) {
    for (const target of targets) {
      if (SKIP.has(`${target}:${name}`)) continue;
      const load = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
      loads.push(load);
      const server = await startTarget(target);
      try {
        oha(server.port, SCENARIOS[name], 2, connections); // warm-up, discarded
        const r = oha(server.port, SCENARIOS[name], seconds, connections);
        ((raw[target] ??= {})[name] ??= []).push(r);
        console.error(`round ${round + 1} ${name.padEnd(13)} ${target.padEnd(18)} ${Math.round(r.rps).toString().padStart(7)} req/s  p99 ${r.p99ms.toFixed(2)}ms  load ${load}`);
      } finally {
        server.stop();
        await Bun.sleep(300);
      }
    }
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const table: Record<string, Record<string, { rps: number; p99ms: number; runs: number[] }>> = {};
for (const target of targets) {
  for (const name of scenarios) {
    const runs = raw[target]?.[name];
    if (!runs) continue;
    (table[target] ??= {})[name] = {
      rps: Math.round(median(runs.map((r) => r.rps))),
      p99ms: Number(median(runs.map((r) => r.p99ms)).toFixed(3)),
      runs: runs.map((r) => Math.round(r.rps)),
    };
  }
}

console.log(`\n| target | ${scenarios.join(" | ")} |`);
console.log(`|---|${scenarios.map(() => "---:").join("|")}|`);
for (const target of targets) {
  console.log(`| ${target} | ${scenarios.map((s) => table[target][s]?.rps.toLocaleString("en") ?? "—").join(" | ")} |`);
}

const meta = {
  date: new Date().toISOString(),
  bun: `${Bun.version} (${Bun.revision})`,
  cpu: os.cpus()[0].model,
  cores: os.cpus().length,
  tool: Bun.spawnSync(["oha", "--version"]).stdout.toString().trim(),
  connections,
  seconds,
  warmupSeconds: 2,
  rounds,
  routes: ROUTES,
  loadAtStart: { min: Math.min(...loads), max: Math.max(...loads) },
  statistic: "median of rounds, req/s",
};
if (values.out) {
  writeFileSync(values.out, `${JSON.stringify({ meta, table, raw }, null, 2)}\n`);
  console.error(`wrote ${values.out}`);
}
