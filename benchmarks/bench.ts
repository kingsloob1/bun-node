#!/usr/bin/env bun
/**
 * Router throughput benchmark.
 *
 * Stress-tests and compares the request-routing speed of:
 *   - BunRouter      — `@kingsleyweb/bun-common`'s `BunHttpAdapter`
 *   - Express 5      — the Express 5 router on Bun
 *   - Bun.serve      — Bun's native `routes` table
 *   - Elysia         — the Elysia framework
 *   - Hono           — the Hono framework (served via `Bun.serve`)
 *
 * Every framework registers the same logical routes; `autocannon` then
 * hammers one (or several) of them and reports requests/sec and latency.
 *
 * Run `bun bench.ts --help` for all options.
 */
import type { Server as NodeHttpServer } from "node:http";
import process from "node:process";
import { parseArgs } from "node:util";
import { BunHttpAdapter } from "../packages/bun-common/lib/index";

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

type ScenarioName =
  | "static"
  | "param"
  | "deep"
  | "wildcard"
  | "middleware"
  | "notfound"
  | "mixed";

interface RunningServer {
  url: string;
  stop: () => Promise<void> | void;
}

interface Framework {
  id: string;
  label: string;
  /** Builds and starts the server with every benchmark route registered. */
  start: (port: number, middlewareCount: number) => Promise<RunningServer>;
}

interface BenchResult {
  framework: string;
  scenario: ScenarioName;
  reqPerSec: number;
  latencyAvg: number;
  latencyP99: number;
  throughputMB: number;
  errors: number;
  timeouts: number;
  non2xx: number;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const ALL_SCENARIOS: ScenarioName[] = [
  "static",
  "param",
  "deep",
  "wildcard",
  "middleware",
  "notfound",
  "mixed",
];

const ALL_FRAMEWORK_IDS = [
  "bun-router",
  "express",
  "bun-serve",
  "elysia",
  "hono",
] as const;

/** Concrete URL paths autocannon targets for each scenario. */
const HIT_PATH: Record<Exclude<ScenarioName, "mixed">, string> = {
  static: "/ping",
  param: "/user/42",
  deep: "/api/v1/users/7/books/99",
  wildcard: "/assets/css/site/app.css",
  middleware: "/chain",
  notfound: "/no/such/route/exists/here",
};

const MIXED_PATHS = [
  "/ping",
  "/user/42",
  "/api/v1/users/7/books/99",
  "/assets/css/site/app.css",
  "/chain",
];

function printHelp(): void {
  console.log(`
Router throughput benchmark

Usage: bun bench.ts [options]

Options:
  -c, --connections <n>      Concurrent connections          (default: 50)
  -d, --duration <s>         Measured seconds per run        (default: 10)
  -p, --pipelining <n>       Pipelined requests per conn.    (default: 1)
  -w, --warmup <s>           Warmup seconds (discarded)      (default: 3)
  -r, --route <names>        Scenario(s): comma list or 'all'(default: static)
                             static|param|deep|wildcard|middleware|notfound|mixed
  -f, --frameworks <ids>     Framework(s): comma list or 'all'
                             bun-router|express|bun-serve|elysia|hono
      --method <verb>        HTTP method                     (default: GET)
      --middleware-count <n> Middlewares in the chain route  (default: 5)
      --workers <n>          autocannon worker threads       (default: 0)
      --port <n>             Base port                       (default: 41000)
      --json                 Emit raw JSON results
  -h, --help                 Show this help

Examples:
  bun bench.ts                                  # static route, 50 conns, 10s
  bun bench.ts -r all -c 100 -d 15              # every scenario, heavier load
  bun bench.ts -r param,deep -f bun-router,hono # focused comparison
  bun bench.ts -r mixed -c 200 -p 8 --workers 4 # pipelined, multi-worker load
`);
}

const { values } = parseArgs({
  options: {
    connections: { type: "string", short: "c", default: "50" },
    duration: { type: "string", short: "d", default: "10" },
    pipelining: { type: "string", short: "p", default: "1" },
    warmup: { type: "string", short: "w", default: "3" },
    route: { type: "string", short: "r", default: "static" },
    frameworks: { type: "string", short: "f", default: "all" },
    method: { type: "string", default: "GET" },
    "middleware-count": { type: "string", default: "5" },
    workers: { type: "string", default: "0" },
    port: { type: "string", default: "41000" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  printHelp();
  process.exit(0);
}

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const config = {
  connections: Math.max(1, toInt(values.connections, 50)),
  duration: Math.max(1, toInt(values.duration, 10)),
  pipelining: Math.max(1, toInt(values.pipelining, 1)),
  warmup: Math.max(0, toInt(values.warmup, 3)),
  method: String(values.method).toUpperCase(),
  middlewareCount: Math.max(0, toInt(values["middleware-count"], 5)),
  workers: Math.max(0, toInt(values.workers, 0)),
  basePort: toInt(values.port, 41000),
  json: !!values.json,
};

const scenarios: ScenarioName[] =
  values.route === "all"
    ? ALL_SCENARIOS
    : (String(values.route)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean) as ScenarioName[]);

for (const scenario of scenarios) {
  if (!ALL_SCENARIOS.includes(scenario)) {
    console.error(`Unknown scenario: "${scenario}"`);
    process.exit(1);
  }
}

const selectedFrameworkIds =
  values.frameworks === "all"
    ? [...ALL_FRAMEWORK_IDS]
    : String(values.frameworks)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

/* ------------------------------------------------------------------ *
 * Framework adapters — each registers the identical route set
 * ------------------------------------------------------------------ */

/**
 * Logical routes every framework exposes (handlers return tiny payloads so
 * the measurement isolates routing, not serialization):
 *   GET /ping                                     -> "ok"
 *   GET /user/:id                                 -> the id
 *   GET /api/v1/users/:userId/books/:bookId       -> "userId/bookId"
 *   GET /assets/*                                 -> "ok"
 *   GET /chain  (preceded by N pass-through MWs)  -> "ok"
 */

const bunRouterFramework: Framework = {
  id: "bun-router",
  label: "BunRouter (bun-common)",
  async start(port, middlewareCount) {
    // Body/cookie/query parsing disabled so the figure reflects routing.
    const adapter = new BunHttpAdapter(0, {
      request: { parseBody: false, parseCookies: false, parseQuery: false },
    });

    adapter.get("/ping", (_req, res) => res.send("ok"));
    adapter.get("/user/:id", (req, res) => res.send(String(req.params.id)));
    adapter.get("/api/v1/users/:userId/books/:bookId", (req, res) =>
      res.send(`${req.params.userId}/${req.params.bookId}`),
    );
    adapter.get("/assets/*", (_req, res) => res.send("ok"));

    const middlewares = Array.from(
      { length: middlewareCount },
      () => (_req: unknown, _res: unknown, next: () => void) => next(),
    );
    adapter.get("/chain", ...middlewares, (_req, res) => res.send("ok"));

    await adapter.listen(port);
    return {
      url: `http://127.0.0.1:${adapter.listeningPort}`,
      stop: () => adapter.close(),
    };
  },
};

const bunServeFramework: Framework = {
  id: "bun-serve",
  label: "Bun.serve (native routes)",
  async start(port) {
    // Bun's native route table has no per-route middleware concept, so the
    // `/chain` route is a plain route here.
    const server = Bun.serve({
      port,
      routes: {
        "/ping": () => new Response("ok"),
        "/user/:id": (req) => new Response(String(req.params.id)),
        "/api/v1/users/:userId/books/:bookId": (req) =>
          new Response(`${req.params.userId}/${req.params.bookId}`),
        "/assets/*": () => new Response("ok"),
        "/chain": () => new Response("ok"),
      },
      fetch: () => new Response("not found", { status: 404 }),
    });
    return {
      url: `http://127.0.0.1:${server.port}`,
      stop: () => server.stop(true),
    };
  },
};

const expressFramework: Framework = {
  id: "express",
  label: "Express 5",
  async start(port, middlewareCount) {
    const { default: express } = (await import("express")) as {
      default: () => any;
    };
    const app = express();

    app.get("/ping", (_req: any, res: any) => res.send("ok"));
    app.get("/user/:id", (req: any, res: any) => res.send(req.params.id));
    app.get("/api/v1/users/:userId/books/:bookId", (req: any, res: any) =>
      res.send(`${req.params.userId}/${req.params.bookId}`),
    );
    // Express 5 requires a named wildcard.
    app.get("/assets/*splat", (_req: any, res: any) => res.send("ok"));

    const middlewares = Array.from(
      { length: middlewareCount },
      () => (_req: any, _res: any, next: () => void) => next(),
    );
    app.get("/chain", ...middlewares, (_req: any, res: any) => res.send("ok"));

    const server: NodeHttpServer = app.listen(port);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    return {
      url: `http://127.0.0.1:${port}`,
      stop: () =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    };
  },
};

const elysiaFramework: Framework = {
  id: "elysia",
  label: "Elysia",
  async start(port, middlewareCount) {
    const { Elysia } = (await import("elysia")) as { Elysia: any };
    const beforeHandle = Array.from({ length: middlewareCount }, () => () => {});

    const app = new Elysia()
      .get("/ping", () => "ok")
      .get("/user/:id", ({ params }: any) => params.id)
      .get(
        "/api/v1/users/:userId/books/:bookId",
        ({ params }: any) => `${params.userId}/${params.bookId}`,
      )
      .get("/assets/*", () => "ok")
      .get("/chain", () => "ok", { beforeHandle })
      .listen(port);

    return {
      url: `http://127.0.0.1:${app.server?.port ?? port}`,
      stop: () => app.stop(),
    };
  },
};

const honoFramework: Framework = {
  id: "hono",
  label: "Hono",
  async start(port, middlewareCount) {
    const { Hono } = (await import("hono")) as { Hono: any };
    const app = new Hono();

    app.get("/ping", (c: any) => c.text("ok"));
    app.get("/user/:id", (c: any) => c.text(c.req.param("id")));
    app.get("/api/v1/users/:userId/books/:bookId", (c: any) =>
      c.text(`${c.req.param("userId")}/${c.req.param("bookId")}`),
    );
    app.get("/assets/*", (c: any) => c.text("ok"));

    for (let i = 0; i < middlewareCount; i++) {
      app.use("/chain", async (_c: any, next: () => Promise<void>) => {
        await next();
      });
    }
    app.get("/chain", (c: any) => c.text("ok"));

    const server = Bun.serve({ port, fetch: app.fetch });
    return {
      url: `http://127.0.0.1:${server.port}`,
      stop: () => server.stop(true),
    };
  },
};

const FRAMEWORKS: Record<string, Framework> = {
  "bun-router": bunRouterFramework,
  "express": expressFramework,
  "bun-serve": bunServeFramework,
  "elysia": elysiaFramework,
  "hono": honoFramework,
};

/* ------------------------------------------------------------------ *
 * Load runner
 * ------------------------------------------------------------------ */

async function loadAutocannon(): Promise<any> {
  try {
    const mod = (await import("autocannon")) as { default?: any };
    return mod.default ?? mod;
  } catch {
    console.error(
      "Could not load `autocannon`. Run `bun install` inside benchmarks/.",
    );
    process.exit(1);
  }
}

let autocannon: any;

async function fire(
  url: string,
  scenario: ScenarioName,
  duration: number,
  useWorkers: boolean,
): Promise<any> {
  const base: Record<string, unknown> = {
    connections: config.connections,
    pipelining: config.pipelining,
    duration,
    method: config.method,
  };

  if (scenario === "mixed") {
    // autocannon cycles through the request list.
    return autocannon({
      ...base,
      url,
      requests: MIXED_PATHS.map((path) => ({ path })),
    });
  }

  const target = `${url}${HIT_PATH[scenario]}`;
  // Worker threads keep the load generator off the server's event loop.
  return autocannon({
    ...base,
    url: target,
    ...(useWorkers && config.workers > 0 ? { workers: config.workers } : {}),
  });
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** Column widths for the result table. */
const COLUMNS: { title: string; width: number }[] = [
  { title: "Framework", width: 26 },
  { title: "Req/s", width: 12 },
  { title: "Latency avg", width: 13 },
  { title: "Latency p99", width: 13 },
  { title: "Throughput", width: 14 },
  { title: "vs best", width: 13 },
];
const COLUMN_GAP = "  ";

function renderRow(cells: string[]): string {
  return (
    "  " +
    cells
      .map((cell, i) =>
        i === 0
          ? cell.padEnd(COLUMNS[i].width)
          : cell.padStart(COLUMNS[i].width),
      )
      .join(COLUMN_GAP)
  );
}

function printScenarioTable(scenario: ScenarioName, rows: BenchResult[]): void {
  const sorted = [...rows].sort((a, b) => b.reqPerSec - a.reqPerSec);
  const best = sorted[0]?.reqPerSec ?? 0;

  const target = scenario === "mixed" ? "(rotating paths)" : HIT_PATH[scenario];
  console.log(
    `\n  Scenario: ${scenario}  ${config.method} ${target}` +
      `  —  ${config.connections} conns, ${config.duration}s, pipelining ${config.pipelining}`,
  );

  const header = renderRow(COLUMNS.map((c) => c.title));
  const rule = `  ${"-".repeat(header.length - 2)}`;
  console.log(rule);
  console.log(header);
  console.log(rule);

  for (const row of sorted) {
    const ratio = best > 0 ? best / row.reqPerSec : 1;
    const flags: string[] = [];
    if (row.errors) flags.push(`${row.errors} err`);
    if (row.timeouts) flags.push(`${row.timeouts} timeout`);
    if (row.non2xx && scenario !== "notfound") {
      flags.push(`${row.non2xx} non-2xx`);
    }

    const line = renderRow([
      row.framework,
      formatNumber(row.reqPerSec),
      `${row.latencyAvg.toFixed(2)} ms`,
      `${row.latencyP99.toFixed(2)} ms`,
      `${row.throughputMB.toFixed(2)} MB/s`,
      ratio <= 1.001 ? "1.00x (best)" : `${ratio.toFixed(2)}x`,
    ]);
    console.log(flags.length ? `${line}${COLUMN_GAP}${flags.join(", ")}` : line);
  }
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  autocannon = await loadAutocannon();

  const targets: Framework[] = [];
  for (const id of selectedFrameworkIds) {
    const framework = FRAMEWORKS[id];
    if (!framework) {
      console.error(`Unknown framework: "${id}"`);
      process.exit(1);
    }
    targets.push(framework);
  }

  console.log("Router throughput benchmark");
  console.log(`  Bun ${Bun.version}  ·  ${navigator.hardwareConcurrency} CPUs`);
  console.log(
    `  frameworks: ${targets.map((t) => t.id).join(", ")}` +
      `  ·  scenarios: ${scenarios.join(", ")}`,
  );
  if (scenarios.includes("middleware")) {
    console.log(`  middleware chain length: ${config.middlewareCount}`);
  }

  const results: BenchResult[] = [];
  let portCursor = config.basePort;

  for (const framework of targets) {
    const port = portCursor;
    // Leave a gap so a closing server never collides with the next one.
    portCursor += 10;

    let server: RunningServer | undefined;
    try {
      server = await framework.start(port, config.middlewareCount);
    } catch (error) {
      console.error(
        `\n  ! Skipping ${framework.label}: failed to start —`,
        error instanceof Error ? error.message : error,
      );
      continue;
    }

    try {
      // Warm the JIT and connection pool before measuring.
      if (config.warmup > 0) {
        await fire(server.url, scenarios[0], config.warmup, false);
      }

      for (const scenario of scenarios) {
        const result = await fire(server.url, scenario, config.duration, true);
        results.push({
          framework: framework.label,
          scenario,
          reqPerSec: result.requests.average,
          latencyAvg: result.latency.average,
          latencyP99: result.latency.p99,
          throughputMB: result.throughput.average / (1024 * 1024),
          errors: result.errors ?? 0,
          timeouts: result.timeouts ?? 0,
          non2xx: result.non2xx ?? 0,
        });
        process.stdout.write(".");
      }
      process.stdout.write("\n");
    } finally {
      await server.stop();
      // Give the OS a moment to release the listening socket.
      await Bun.sleep(150);
    }
  }

  if (config.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  for (const scenario of scenarios) {
    printScenarioTable(
      scenario,
      results.filter((r) => r.scenario === scenario),
    );
  }
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
