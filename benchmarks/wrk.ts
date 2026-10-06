#!/usr/bin/env bun
/**
 * Scenario benchmark: every framework on the same eight scenarios, with `wrk`
 * as the load tool.
 *
 *   bun wrk.ts [--targets a,b|all] [--scenarios s,t|all] [--rounds 3]
 *              [--duration 5] [--warmup 2] [--connections 64] [--threads 2]
 *              [--routes 1000] [--json out.json] [--markdown out.md]
 *
 * Method, chosen so a number means what it says:
 *
 * - One fresh server process per (target, scenario) cell
 *   (`scenarios/servers.ts`, or `hyper-express/scenarios.mjs`), so no cell
 *   inherits another's heap, JIT state or caches.
 * - The server pinned to CPU 0 and wrk to the others (`taskset`), so the two
 *   never trade cores. `wrk` is native: it is not the bottleneck the way an
 *   in-process JavaScript load generator is.
 * - Every scenario's response checked (status and body) before it is
 *   measured; a target that answers wrongly is reported, not timed.
 * - A discarded warm-up, then the measured run; rounds interleaved so a noisy
 *   minute lands on every target; medians reported.
 * - `BUN_OPTIONS` cleared for the servers (a shell's `--smol` would otherwise
 *   run every Bun target in its low-memory mode).
 *
 * Needs `wrk` on the PATH. The hyper-express targets need
 * `npm run setup` in `hyper-express/` (they are skipped otherwise).
 */
import { spawn, spawnSync } from "bun";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const ALL_TARGETS = [
  "bun-common",
  "bun-nest",
  "express",
  "hono",
  "elysia",
  "elysia2",
  "bun-serve",
  "hyper-express-node",
  "hyper-express-bun",
];
const ALL_SCENARIOS = [
  "static",
  "param",
  "wildcard",
  "middleware",
  "routes-1000",
  "param-random",
  "json",
  "async",
  "headers",
];

/** How each target is labelled in the report. */
const LABELS: Record<string, string> = {
  "bun-common": "bun-common (BunHttpAdapter)",
  "bun-nest": "bun-nest (Nest 11)",
  express: "Express 5 (on Bun)",
  hono: "Hono",
  elysia: "Elysia 1.4",
  elysia2: "Elysia 2 (beta)",
  "bun-serve": "Bun.serve routes (floor)",
  "hyper-express-node": "hyper-express (Node.js)",
  "hyper-express-bun": "hyper-express (Bun)",
};

const { values } = parseArgs({
  options: {
    targets: { type: "string", default: "all" },
    scenarios: { type: "string", default: "all" },
    rounds: { type: "string", default: "3" },
    duration: { type: "string", default: "5" },
    warmup: { type: "string", default: "2" },
    connections: { type: "string", default: "64" },
    threads: { type: "string", default: "2" },
    routes: { type: "string", default: "1000" },
    json: { type: "string" },
    markdown: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(
    `Usage: bun wrk.ts [--targets ${ALL_TARGETS.join(",")}|all]\n` +
      `                  [--scenarios ${ALL_SCENARIOS.join(",")}|all]\n` +
      "                  [--rounds 3] [--duration 5] [--warmup 2] [--connections 64]\n" +
      "                  [--threads 2] [--routes 1000] [--json f] [--markdown f]",
  );
  process.exit(0);
}

const ROUTES = Number(values.routes);
const list = (value: string, all: string[]) =>
  value === "all" ? all : value.split(",").map((v) => v.trim());
const targets = list(values.targets!, ALL_TARGETS);
const scenarios = list(values.scenarios!, ALL_SCENARIOS);

if (spawnSync(["sh", "-c", "command -v wrk"]).exitCode !== 0) {
  console.error("wrk is not installed (e.g. `apt install wrk`).");
  process.exit(1);
}

const tmp = mkdtempSync(join(os.tmpdir(), "bench-wrk-"));
const lua = (name: string, body: string) => {
  const path = join(tmp, `${name}.lua`);
  writeFileSync(path, body);
  return path;
};

interface Scenario {
  /** What it exercises, for the report. */
  about: string;
  path: string;
  /** A wrk Lua script (a POST body, a fresh id per request). */
  script?: string;
  /** The request the response check sends. */
  check: { path: string; init?: RequestInit; body: (text: string) => boolean };
}

const SCENARIOS: Record<string, Scenario> = {
  static: {
    about: "GET /static",
    path: "/static",
    check: { path: "/static", body: (t) => t === "ok" },
  },
  param: {
    about: "GET /user/42",
    path: "/user/42",
    check: { path: "/user/42", body: (t) => t === "42" },
  },
  wildcard: {
    about: "GET /assets/css/site/app.css, a /assets/* route",
    path: "/assets/css/site/app.css",
    check: { path: "/assets/css/site/app.css", body: (t) => t === "ok" },
  },
  middleware: {
    about: "GET /mw/hit behind 3 middleware",
    path: "/mw/hit",
    check: { path: "/mw/hit", body: (t) => t === "mw:3" },
  },
  "routes-1000": {
    about: `GET /r${ROUTES - 1}/7, the last of ${ROUTES} param routes`,
    path: `/r${ROUTES - 1}/7`,
    check: { path: `/r${ROUTES - 1}/7`, body: (t) => t === `r${ROUTES - 1}:7` },
  },
  "param-random": {
    about: `GET /r${ROUTES - 1}/<fresh 8-digit id> per request`,
    path: "/",
    script: lua(
      "random",
      `math.randomseed(os.time())\nrequest = function()\n  return wrk.format("GET", "/r${ROUTES - 1}/" .. math.random(10000000, 99999999))\nend\n`,
    ),
    check: {
      path: `/r${ROUTES - 1}/12345678`,
      body: (t) => t === `r${ROUTES - 1}:12345678`,
    },
  },
  json: {
    about: 'POST /json {"n":7}, JSON reply',
    path: "/json",
    script: lua(
      "json",
      `wrk.method = "POST"\nwrk.body = '{"n":7}'\nwrk.headers["Content-Type"] = "application/json"\n`,
    ),
    check: {
      path: "/json",
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"n":7}',
      },
      body: (t) => {
        try {
          const parsed = JSON.parse(t) as { ok?: boolean; n?: number };
          return parsed.ok === true && parsed.n === 7;
        } catch {
          return false;
        }
      },
    },
  },
  async: {
    about: "GET /async, a handler that awaits once",
    path: "/async",
    check: { path: "/async", body: (t) => t === "ok" },
  },
  headers: {
    about: "GET /headers, 3 response headers set",
    path: "/headers",
    check: { path: "/headers", body: (t) => t === "ok" },
  },
};

for (const name of scenarios) {
  if (!SCENARIOS[name]) {
    console.error(
      `unknown scenario ${name} (known: ${ALL_SCENARIOS.join(", ")})`,
    );
    process.exit(1);
  }
}
for (const name of targets) {
  if (!LABELS[name]) {
    console.error(`unknown target ${name} (known: ${ALL_TARGETS.join(", ")})`);
    process.exit(1);
  }
}

const hasTaskset = spawnSync(["sh", "-c", "command -v taskset"]).exitCode === 0;
const cpus = os.cpus().length;
const pin = (cpuList: string, argv: string[]) =>
  hasTaskset && cpus > 1 ? ["taskset", "-c", cpuList, ...argv] : argv;

/** The servers' environment: production, and no `BUN_OPTIONS` (see above). */
const serverEnv: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key !== "BUN_OPTIONS" && value !== undefined) {
    serverEnv[key] = value;
  }
}
serverEnv.ROUTES = String(ROUTES);
serverEnv.NODE_ENV = "production";

/** The command that serves `target`. */
function serverCommand(target: string): { argv: string[]; cwd: string } {
  if (target.startsWith("hyper-express-")) {
    const runtime = target === "hyper-express-node" ? "node" : process.execPath;
    return {
      argv: [runtime, "scenarios.mjs"],
      cwd: join(import.meta.dir, "hyper-express"),
    };
  }
  return {
    argv: [
      process.execPath,
      join(import.meta.dir, "scenarios/servers.ts"),
      target,
    ],
    cwd: import.meta.dir,
  };
}

/** Starts `target` pinned to CPU 0; throws with the server's own error. */
async function startTarget(target: string) {
  if (
    target.startsWith("hyper-express-") &&
    !(await Bun.file(
      join(
        import.meta.dir,
        "hyper-express/node_modules/hyper-express/package.json",
      ),
    ).exists())
  ) {
    throw new Error(
      "not installed: run `npm run setup` in benchmarks/hyper-express",
    );
  }
  const { argv, cwd } = serverCommand(target);
  const proc = spawn(pin("0", argv), {
    cwd,
    env: serverEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  let text = "";
  const deadline = Date.now() + 120_000;
  const exited = proc.exited.then(() => null);
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), exited]);
    if (chunk === null || chunk.done) {
      break;
    }
    text += new TextDecoder().decode(chunk.value);
    const ready = /READY (\d+)/.exec(text);
    if (ready) {
      reader.releaseLock();
      return { proc, port: Number(ready[1]) };
    }
  }
  proc.kill();
  const stderr = await new Response(proc.stderr).text();
  const reason =
    stderr
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\w*Error: /.test(line))
      .at(-1) ??
    (stderr.trim().split("\n").at(-1) || "it did not print READY");
  throw new Error(reason);
}

/** Sends the scenario's check request; `undefined` when the reply is right. */
async function checkResponse(
  port: number,
  scenario: Scenario,
): Promise<string | undefined> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}${scenario.check.path}`,
      scenario.check.init,
    );
    const text = await response.text();
    if (response.status !== 200 || !scenario.check.body(text)) {
      return `answered ${response.status} ${JSON.stringify(text.slice(0, 60))}`;
    }
    return undefined;
  } catch (error) {
    return `request failed: ${(error as Error).message}`;
  }
}

interface WrkResult {
  rps: number;
  p50: number;
  p99: number;
  non2xx: number;
  errors: number;
}

/** wrk's `--latency` figure in ms. */
function latencyMs(out: string, percentile: string): number {
  const match = new RegExp(`\\s${percentile}%\\s+([\\d.]+)(us|ms|s)`).exec(out);
  if (!match) {
    return Number.NaN;
  }
  const value = Number(match[1]);
  return match[2] === "us"
    ? value / 1000
    : match[2] === "s"
      ? value * 1000
      : value;
}

function wrk(port: number, scenario: Scenario, seconds: string): WrkResult {
  const argv = [
    "wrk",
    "-t",
    values.threads!,
    "-c",
    values.connections!,
    "-d",
    `${seconds}s`,
    "--latency",
  ];
  if (scenario.script) {
    argv.push("-s", scenario.script);
  }
  argv.push(`http://127.0.0.1:${port}${scenario.path}`);
  const out = spawnSync(
    pin(`1-${Math.max(1, cpus - 1)}`, argv),
  ).stdout.toString();
  const socketErrors =
    /Socket errors: connect (\d+), read (\d+), write (\d+), timeout (\d+)/.exec(
      out,
    );
  return {
    rps: Number(/Requests\/sec:\s+([\d.]+)/.exec(out)?.[1] ?? Number.NaN),
    p50: latencyMs(out, "50"),
    p99: latencyMs(out, "99"),
    non2xx: Number(/Non-2xx or 3xx responses: (\d+)/.exec(out)?.[1] ?? 0),
    errors: socketErrors
      ? socketErrors.slice(1).reduce((sum, n) => sum + Number(n), 0)
      : 0,
  };
}

const runs: Record<string, WrkResult[]> = {};
/** Why a whole target, or one of its cells, was not measured. */
const skipped: Record<string, string> = {};
const key = (target: string, scenario: string) => `${target}\t${scenario}`;

console.error(
  `Scenario benchmark — Bun ${Bun.version} · ${cpus} CPUs · wrk -t${values.threads} -c${values.connections} · ` +
    `${values.rounds} rounds × ${values.duration}s (warm-up ${values.warmup}s) · ${ROUTES} param routes` +
    `${hasTaskset && cpus > 1 ? " · server on CPU 0, wrk on the rest" : ""}`,
);

for (let round = 0; round < Number(values.rounds); round++) {
  for (const target of targets) {
    if (skipped[target]) {
      continue;
    }
    for (const name of scenarios) {
      if (skipped[key(target, name)]) {
        continue;
      }
      const scenario = SCENARIOS[name];
      let server: Awaited<ReturnType<typeof startTarget>>;
      try {
        server = await startTarget(target);
      } catch (error) {
        skipped[target] = `failed to start — ${(error as Error).message}`;
        console.error(`  ! ${LABELS[target]}: ${skipped[target]}`);
        break;
      }
      try {
        if (round === 0) {
          const wrong = await checkResponse(server.port, scenario);
          if (wrong) {
            skipped[key(target, name)] = wrong;
            console.error(
              `  ! ${LABELS[target]} ${name}: ${wrong} — not measured`,
            );
            continue;
          }
        }
        wrk(server.port, scenario, values.warmup!);
        const result = wrk(server.port, scenario, values.duration!);
        if (result.non2xx || result.errors) {
          console.error(
            `  ! ${LABELS[target]} ${name}: ${result.non2xx} non-2xx, ${result.errors} socket errors`,
          );
        }
        (runs[key(target, name)] ??= []).push(result);
        console.error(
          `round ${round + 1}  ${target.padEnd(19)} ${name.padEnd(13)} ${Math.round(result.rps).toLocaleString("en-US").padStart(9)} req/s`,
        );
      } finally {
        server.proc.kill();
        await server.proc.exited;
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const medianOf = (target: string, scenario: string, field: keyof WrkResult) => {
  const cell = runs[key(target, scenario)];
  return cell?.length ? median(cell.map((r) => r[field])) : Number.NaN;
};
const fmt = (n: number) =>
  Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—";
const measured = targets.filter((t) => !skipped[t]);

const lines: string[] = [];
lines.push(`# Scenario benchmark (wrk)`);
lines.push("");
lines.push(
  `Bun ${Bun.version} · ${cpus} CPUs · wrk -t${values.threads} -c${values.connections} · ` +
    `${values.rounds} rounds × ${values.duration}s after a ${values.warmup}s warm-up, medians · ` +
    `a fresh server process per cell${hasTaskset && cpus > 1 ? ", pinned to CPU 0 (wrk on the rest)" : ""}.`,
);
lines.push("");
lines.push("| Scenario | What it does |");
lines.push("|---|---|");
for (const name of scenarios) {
  lines.push(`| ${name} | ${SCENARIOS[name].about} |`);
}
lines.push("");
lines.push("## Requests per second (median)");
lines.push("");
lines.push(`| Framework | ${scenarios.join(" | ")} |`);
lines.push(`|---|${scenarios.map(() => "---:").join("|")}|`);
const best: Record<string, number> = {};
for (const name of scenarios) {
  best[name] = Math.max(
    ...measured.map((t) => medianOf(t, name, "rps")).filter(Number.isFinite),
  );
}
for (const target of measured) {
  const cells = scenarios.map((name) => {
    if (skipped[key(target, name)]) {
      return "✗";
    }
    const rps = medianOf(target, name, "rps");
    return rps === best[name] ? `**${fmt(rps)}**` : fmt(rps);
  });
  lines.push(`| ${LABELS[target]} | ${cells.join(" | ")} |`);
}
lines.push("");
lines.push("## Relative to the fastest in each scenario");
lines.push("");
lines.push(`| Framework | ${scenarios.join(" | ")} |`);
lines.push(`|---|${scenarios.map(() => "---:").join("|")}|`);
for (const target of measured) {
  const cells = scenarios.map((name) => {
    const rps = medianOf(target, name, "rps");
    return Number.isFinite(rps)
      ? `${Math.round((rps / best[name]) * 100)}%`
      : "✗";
  });
  lines.push(`| ${LABELS[target]} | ${cells.join(" | ")} |`);
}
lines.push("");
lines.push("## Latency p50 / p99 (ms, median of rounds)");
lines.push("");
lines.push(`| Framework | ${scenarios.join(" | ")} |`);
lines.push(`|---|${scenarios.map(() => "---:").join("|")}|`);
for (const target of measured) {
  const cells = scenarios.map((name) => {
    const p50 = medianOf(target, name, "p50");
    const p99 = medianOf(target, name, "p99");
    return Number.isFinite(p50) ? `${p50.toFixed(2)} / ${p99.toFixed(2)}` : "✗";
  });
  lines.push(`| ${LABELS[target]} | ${cells.join(" | ")} |`);
}
const notes = Object.entries(skipped);
if (notes.length) {
  lines.push("");
  lines.push("## Not measured");
  lines.push("");
  for (const [what, why] of notes) {
    const [target, scenario] = what.split("\t");
    lines.push(
      `- ${LABELS[target]}${scenario ? ` · ${scenario}` : ""}: ${why}`,
    );
  }
}

const report = lines.join("\n");
console.log(report);
if (values.markdown) {
  writeFileSync(values.markdown, `${report}\n`);
}
if (values.json) {
  writeFileSync(
    values.json,
    JSON.stringify(
      {
        bun: Bun.version,
        cpus,
        threads: values.threads,
        connections: values.connections,
        duration: values.duration,
        warmup: values.warmup,
        rounds: values.rounds,
        routes: ROUTES,
        runs,
        skipped,
      },
      null,
      2,
    ),
  );
}
