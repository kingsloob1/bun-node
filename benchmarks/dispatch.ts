#!/usr/bin/env bun
/**
 * Dispatch-strategy benchmark — Bun 1.4.1.
 *
 * Where `bench.ts` compares *frameworks*, this compares the four ways to get a
 * request to a handler on Bun, using one identical route set:
 *
 *   - `bun-router`          BunRouter (`@kingsleyweb/bun-common`), pipeline
 *                           cache on (the default `routeCacheMax: 2000`)
 *   - `bun-router-nocache`  the same router with the matched-pipeline cache
 *                           defeated on every request (cold match each time)
 *   - `bun-router-methods`  BunRouter registering each path once per verb (the
 *                           Express idiom — a 5x larger route table)
 *   - `bun-serve-routes`    Bun's native `routes` table, bare-function form
 *   - `bun-serve-methods`   the same table declared with per-method objects
 *                           (`{ GET, POST, PUT, PATCH, DELETE }`)
 *   - `fs-router`           `Bun.FileSystemRouter` ("nextjs" style) driven from
 *                           a `fetch` handler
 *   - `fetch-manual`        a hand-written dispatcher inside `fetch`
 *
 * Two measurement modes:
 *
 *   - HTTP mode (default) — `autocannon` over loopback; end-to-end req/s, so
 *     the numbers include Bun's HTTP stack and the socket syscalls.
 *   - `--micro` — in-process, no sockets: times *only* the routing decision, so
 *     the differences between matchers are not buried under network cost.
 *     `bun-serve-routes` cannot participate: Bun's native route matcher is
 *     internal and is not callable outside a running server.
 *
 * Run `bun dispatch.ts --help` for all options.
 */
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
  | "optional-present"
  | "optional-absent"
  | "wildcard"
  | "notfound"
  | "cardinality"
  | "mixed";

interface RunningServer {
  /** Base URL (scheme + host + port) the load generator should target. */
  url: string;
  /** Shuts the server down and releases the port. */
  stop: () => Promise<void> | void;
}

interface Strategy {
  /** CLI id used by `--strategies`. */
  id: string;
  /** Human-readable name shown in the result tables. */
  label: string;
  /** Starts an HTTP server with the shared route set registered. */
  start: (port: number) => Promise<RunningServer>;
  /**
   * In-process routing-decision function for `--micro`, or `undefined` when the
   * strategy's matcher cannot be driven without a live server
   * (`bun-serve-routes`). Returns something truthy on a match so the JIT cannot
   * eliminate the call.
   */
  micro?: () => (pathname: string) => unknown;
}

interface BenchResult {
  strategy: string;
  scenario: ScenarioName;
  reqPerSec: number;
  latencyAvg: number;
  latencyP99: number;
  throughputMB: number;
  errors: number;
  timeouts: number;
  non2xx: number;
}

interface MicroResult {
  strategy: string;
  scenario: ScenarioName;
  /** Routing decisions per second, in-process. */
  opsPerSec: number;
  /** Average nanoseconds per routing decision. */
  nsPerOp: number;
}

/* ------------------------------------------------------------------ *
 * Shared route set
 * ------------------------------------------------------------------ *
 *
 * Every strategy exposes the same five logical routes, chosen to cover a range
 * of parameter shapes. Handlers return tiny payloads so the figure reflects
 * dispatch, not serialization.
 *
 *   GET /ping                                  0 params  (static)
 *   GET /user/:id                              1 required
 *   GET /api/v1/users/:userId/books/:bookId    2 required (deep)
 *   GET /search/:category/:page?               1 required + 1 OPTIONAL
 *   GET /assets/*                              catch-all
 */

/** Concrete URL each scenario hits. */
const HIT_PATH: Record<Exclude<ScenarioName, "mixed">, string> = {
  "static": "/ping",
  "param": "/user/42",
  "deep": "/api/v1/users/7/books/99",
  "optional-present": "/search/books/2",
  "optional-absent": "/search/books",
  "wildcard": "/assets/css/site/app.css",
  "notfound": "/no/such/route/exists",
  // Representative single path; the scenario actually rotates over
  // `CARDINALITY_PATHS` so the router's per-path cache is stressed.
  "cardinality": "/user/<0..N>",
};

const ALL_SCENARIOS: ScenarioName[] = [
  "static",
  "param",
  "deep",
  "optional-present",
  "optional-absent",
  "wildcard",
  "notfound",
  "cardinality",
  "mixed",
];

/** Paths the `mixed` scenario rotates through (every shape except 404). */
const MIXED_PATHS = [
  HIT_PATH.static,
  HIT_PATH.param,
  HIT_PATH.deep,
  HIT_PATH["optional-present"],
  HIT_PATH["optional-absent"],
  HIT_PATH.wildcard,
];

/**
 * Distinct `/user/:id` paths the `cardinality` scenario rotates through. Real
 * API traffic hits one *route* with a huge number of *values*; a router that
 * caches per resolved path (BunRouter does, keyed by host+path+method) only
 * wins while that working set fits in `routeCacheMax`. Above it the FIFO
 * evicts an entry the caller is about to need again, so every request pays a
 * cold match *plus* the cache bookkeeping.
 */
let cardinalityPathsCache: string[] | undefined;

/** Builds (once) the rotation of distinct `/user/:id` paths. */
function cardinalityPaths(): string[] {
  cardinalityPathsCache ??= Array.from(
    { length: config.cardinality },
    (_unused, index) => `/user/${index}`,
  );
  return cardinalityPathsCache;
}

const ALL_STRATEGY_IDS = [
  "bun-router",
  "bun-router-nocache",
  "bun-router-methods",
  "bun-router-tuned",
  "bun-serve-routes",
  "bun-serve-methods",
  "fs-router",
  "fetch-manual",
] as const;

/** Directory holding the `Bun.FileSystemRouter` page fixtures. */
const PAGES_DIR = new URL("./pages", import.meta.url).pathname;

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function printHelp(): void {
  console.log(`
Dispatch-strategy benchmark (Bun ${Bun.version})

Compares BunRouter (cached / uncached), Bun.serve native routes,
Bun.FileSystemRouter and a hand-written fetch dispatcher over one identical
route set with varying required/optional parameters.

Usage: bun dispatch.ts [options]

Options:
  -c, --connections <n>   Concurrent connections            (default: 50)
  -d, --duration <s>      Measured seconds per run          (default: 10)
  -p, --pipelining <n>    Pipelined requests per conn.      (default: 1)
  -w, --warmup <s>        Warmup seconds (discarded)        (default: 3)
  -r, --route <names>     Scenario(s): comma list or 'all'  (default: all)
                          static|param|deep|optional-present|optional-absent|
                          wildcard|notfound|cardinality|mixed
  -s, --strategies <ids>  Strategy(ies): comma list or 'all'
                          bun-router|bun-router-nocache|bun-router-methods|
                          bun-router-tuned|bun-serve-routes|bun-serve-methods|
                          fs-router|fetch-manual
      --method <verb>     HTTP verb the load fires; every strategy answers
                          GET/POST/PUT/PATCH/DELETE       (default: GET)
      --micro             In-process routing-decision benchmark (no sockets).
                          Excludes bun-serve-routes (matcher not exposed).
      --verify            Assert every strategy returns identical, correct
                          responses for every scenario, then exit.
      --iterations <n>    Iterations per scenario in --micro (default: 300000)
      --repeats <n>       Timed passes per --micro scenario; the fastest is
                          reported                          (default: 5)
      --cardinality <n>   Distinct /user/:id paths the 'cardinality' scenario
                          rotates through. Above BunRouter's routeCacheMax
                          (2000) the pipeline cache thrashes. (default: 5000)
      --workers <n>       autocannon worker threads         (default: 0)
      --port <n>          Base port                         (default: 42000)
      --json              Emit raw JSON results
  -h, --help              Show this help

Examples:
  bun dispatch.ts                                 # every scenario, HTTP mode
  bun dispatch.ts --micro                         # isolate matcher cost
  bun dispatch.ts -r optional-absent -c 200 -p 8  # optional-param path, heavy
  bun dispatch.ts -s bun-router,bun-router-nocache --micro
`);
}

const { values } = parseArgs({
  options: {
    connections: { type: "string", short: "c", default: "50" },
    duration: { type: "string", short: "d", default: "10" },
    pipelining: { type: "string", short: "p", default: "1" },
    warmup: { type: "string", short: "w", default: "3" },
    route: { type: "string", short: "r", default: "all" },
    strategies: { type: "string", short: "s", default: "all" },
    method: { type: "string", default: "GET" },
    micro: { type: "boolean", default: false },
    verify: { type: "boolean", default: false },
    iterations: { type: "string", default: "300000" },
    repeats: { type: "string", default: "5" },
    cardinality: { type: "string", default: "5000" },
    "micro-child": { type: "string" },
    workers: { type: "string", default: "0" },
    port: { type: "string", default: "42000" },
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
  iterations: Math.max(1000, toInt(values.iterations, 300000)),
  repeats: Math.max(1, toInt(values.repeats, 5)),
  method: String(values.method).toUpperCase(),
  cardinality: Math.max(2, toInt(values.cardinality, 5000)),
  workers: Math.max(0, toInt(values.workers, 0)),
  basePort: toInt(values.port, 42000),
  micro: !!values.micro,
  verify: !!values.verify,
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

const selectedStrategyIds =
  values.strategies === "all"
    ? [...ALL_STRATEGY_IDS]
    : String(values.strategies)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

/* ------------------------------------------------------------------ *
 * 1. BunRouter — cached and uncached
 * ------------------------------------------------------------------ */

/**
 * A {@link BunHttpAdapter} whose matched-pipeline cache is dropped before every
 * match, so each request pays the full cold cost: match every registered route,
 * order the matches, and flatten their callbacks into layers.
 *
 * Note this only defeats *BunRouter's* cache. Each `@routejs/router` `Route`
 * keeps its own internal 250-entry LRU of compiled-regex match results, which
 * is private and cannot be disabled — so "no cache" here means "no pipeline
 * cache", not "no memoization anywhere".
 */
class NoCacheBunHttpAdapter extends BunHttpAdapter {
  override getMatchedLayers(
    options: Parameters<BunHttpAdapter["getMatchedLayers"]>[0],
  ): ReturnType<BunHttpAdapter["getMatchedLayers"]> {
    this.clearRouteCache();
    return super.getMatchedLayers(options);
  }
}

/** The five verbs every strategy answers, so `--method` can fire any of them. */
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** Lowercased verb names, matching BunRouter's per-verb registration methods. */
const ROUTER_VERBS = ["get", "post", "put", "patch", "delete"] as const;

/**
 * The shared route set as `[path, handler]` pairs, in BunRouter's calling
 * convention. Kept separate from registration so the same five handlers can be
 * registered either method-agnostically (`all`) or once per verb.
 */
const BUN_ROUTER_ROUTES: [
  string,
  (req: { params: Record<string, string> }, res: any) => unknown,
][] = [
  ["/ping", (_req, res) => res.send("ok")],
  ["/user/:id", (req, res) => res.send(String(req.params.id))],
  [
    "/api/v1/users/:userId/books/:bookId",
    (req, res) => res.send(`${req.params.userId}/${req.params.bookId}`),
  ],
  // `:page?` — BunRouter/@routejs supports optional params natively.
  [
    "/search/:category/:page?",
    (req, res) => res.send(`${req.params.category}/${req.params.page ?? "-"}`),
  ],
  // BunRouter exposes a bare `*` capture under the numeric key "0".
  ["/assets/*", (req, res) => res.send(String(req.params[0] ?? ""))],
];

/**
 * Builds a BunRouter adapter with request pre-processing disabled.
 *
 * @param noCache   Defeat the matched-pipeline cache on every request.
 * @param perMethod Register each path once per verb (`get`/`post`/… — the
 *   Express idiom, and a 5x larger route table) instead of once with `all`
 *   (one route that answers every verb, mirroring Bun's bare-function form).
 * @param routeCacheMax Pipeline-cache cap; omitted leaves BunRouter's default
 *   of 2000. The cache is keyed by resolved path, so this must exceed the
 *   number of distinct paths in flight or every request misses *and* pays
 *   eviction.
 */
function makeBunRouterAdapter(
  noCache: boolean,
  perMethod: boolean,
  routeCacheMax?: number,
): BunHttpAdapter {
  const Ctor = noCache ? NoCacheBunHttpAdapter : BunHttpAdapter;
  // Body/cookie/query parsing off so the figure reflects routing, matching
  // bench.ts and keeping the comparison against the raw strategies fair.
  const adapter = new Ctor(0, {
    request: { parseBody: false, parseCookies: false, parseQuery: false },
    ...(routeCacheMax !== undefined ? { routeCacheMax } : {}),
  });

  for (const [path, handler] of BUN_ROUTER_ROUTES) {
    if (perMethod) {
      for (const verb of ROUTER_VERBS) {
        (adapter as any)[verb](path, handler);
      }
    } else {
      (adapter as any).all(path, handler);
    }
  }
  return adapter;
}

/**
 * Builds a BunRouter-backed strategy.
 *
 * @param id        CLI id.
 * @param label     Name shown in the tables.
 * @param noCache   Defeat the matched-pipeline cache on every request.
 * @param perMethod Register one route per verb rather than a single `all`.
 * @param routeCacheMax Pipeline-cache cap; omitted uses the default of 2000.
 */
function bunRouterStrategy(
  id: string,
  label: string,
  noCache: boolean,
  perMethod = false,
  routeCacheMax?: number,
): Strategy {
  return {
    id,
    label,
    async start(port) {
      const adapter = makeBunRouterAdapter(noCache, perMethod, routeCacheMax);
      await adapter.listen(port);
      return {
        url: `http://127.0.0.1:${adapter.listeningPort}`,
        // Force-close: a graceful stop leaves keep-alive sockets alive and,
        // with SO_REUSEPORT, the next server on this port would receive
        // requests served by the stale one.
        stop: () => adapter.close(),
      };
    },
    micro() {
      const adapter = makeBunRouterAdapter(noCache, perMethod, routeCacheMax);
      return (pathname) =>
        adapter.getMatchedLayers({
          requestHost: "127.0.0.1",
          requestMethod: config.method,
          requestUrl: pathname,
        }).length;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 2. Bun.serve native `routes` table
 * ------------------------------------------------------------------ */

/**
 * Bun's native route table has **no optional-parameter syntax**. Writing
 * `/search/:category/:page?` does not fail — Bun parses it as a required param
 * literally *named* `page?`, which silently never matches `/search/books`. The
 * only correct encoding is to register both concrete arities, below.
 *
 * A bare `*` also captures nothing into `req.params`, so the wildcard handler
 * recovers the tail from the URL by hand.
 */
/**
 * The shared route set in Bun's native `routes` shape, as bare functions — one
 * handler per path, answering **every** HTTP verb. Six entries rather than
 * five, because the optional parameter needs one route per arity.
 */
const BUN_SERVE_HANDLERS: Record<string, (req: any) => Response> = {
  "/ping": () => new Response("ok"),
  "/user/:id": (req) => new Response(req.params.id),
  "/api/v1/users/:userId/books/:bookId": (req) =>
    new Response(`${req.params.userId}/${req.params.bookId}`),
  // Optional param emulated with one route per arity.
  "/search/:category": (req) => new Response(`${req.params.category}/-`),
  "/search/:category/:page": (req) =>
    new Response(`${req.params.category}/${req.params.page}`),
  "/assets/*": (req) =>
    new Response(pathnameOf(req.url).slice("/assets/".length)),
};

const bunServeRoutesStrategy: Strategy = {
  id: "bun-serve-routes",
  label: "Bun.serve routes (fn)",
  async start(port) {
    const server = Bun.serve({
      port,
      routes: BUN_SERVE_HANDLERS,
      fetch: () => new Response("not found", { status: 404 }),
    });
    return {
      url: `http://127.0.0.1:${server.port}`,
      stop: () => server.stop(true),
    };
  },
  // No `micro`: Bun's native matcher lives in the server and is not callable
  // in isolation.
};

/**
 * The same route table declared with **per-method objects** —
 * `{ GET, POST, PUT, PATCH, DELETE }` per path instead of one bare function.
 * This is the idiomatic REST form, and isolates what Bun's method dispatch
 * costs on top of path matching: the paths, handlers and payloads are
 * identical to {@link bunServeRoutesStrategy}, only the declaration differs.
 */
const bunServeMethodsStrategy: Strategy = {
  id: "bun-serve-methods",
  label: "Bun.serve routes (methods)",
  async start(port) {
    const routes: Record<string, Record<string, (req: any) => Response>> = {};
    for (const [path, handler] of Object.entries(BUN_SERVE_HANDLERS)) {
      const byMethod: Record<string, (req: any) => Response> = {};
      for (const method of METHODS) {
        byMethod[method] = handler;
      }
      routes[path] = byMethod;
    }

    const server = Bun.serve({
      port,
      routes,
      fetch: () => new Response("not found", { status: 404 }),
    });
    return {
      url: `http://127.0.0.1:${server.port}`,
      stop: () => server.stop(true),
    };
  },
  // No `micro`, for the same reason as bun-serve-routes.
};

/* ------------------------------------------------------------------ *
 * 3. Bun.FileSystemRouter
 * ------------------------------------------------------------------ */

/** Handler signature exported by every file under `pages/`. */
type PageHandler = (params: Record<string, string>) => Response;

/**
 * Builds the FileSystemRouter and eagerly imports every page module once, as a
 * real application would — so the per-request cost is `match()` plus a `Map`
 * lookup, not module resolution.
 */
async function buildFsRouter(): Promise<{
  router: Bun.FileSystemRouter;
  handlers: Map<string, PageHandler>;
}> {
  const router = new Bun.FileSystemRouter({
    dir: PAGES_DIR,
    style: "nextjs",
  });

  const handlers = new Map<string, PageHandler>();
  for (const [name, filePath] of Object.entries(router.routes)) {
    const mod = (await import(filePath)) as { handler: PageHandler };
    handlers.set(name, mod.handler);
  }
  return { router, handlers };
}

const fsRouterStrategy: Strategy = {
  id: "fs-router",
  label: "Bun.FileSystemRouter",
  async start(port) {
    const { router, handlers } = await buildFsRouter();
    const notFound = new Response("not found", { status: 404 });

    const server = Bun.serve({
      port,
      fetch(req) {
        const matched = router.match(req);
        if (!matched) {
          return notFound.clone();
        }
        const handler = handlers.get(matched.name);
        return handler ? handler(matched.params) : notFound.clone();
      },
    });
    return {
      url: `http://127.0.0.1:${server.port}`,
      stop: () => server.stop(true),
    };
  },
  micro() {
    const router = new Bun.FileSystemRouter({
      dir: PAGES_DIR,
      style: "nextjs",
    });
    return (pathname) => router.match(pathname);
  },
};

/* ------------------------------------------------------------------ *
 * 4. Hand-written `fetch` dispatcher
 * ------------------------------------------------------------------ */

/**
 * Extracts the pathname from an absolute request URL without allocating a
 * `URL`. `new URL(req.url).pathname` is by far the most common way to do this
 * and is also the single biggest avoidable cost in a hand-rolled dispatcher —
 * this walks the string instead.
 */
function pathnameOf(url: string): string {
  // Skip past "scheme://host" to the third '/'.
  const authority = url.indexOf("//");
  const start = url.indexOf("/", authority < 0 ? 0 : authority + 2);
  if (start < 0) {
    return "/";
  }
  const query = url.indexOf("?", start);
  return query < 0 ? url.slice(start) : url.slice(start, query);
}

/** The routing decision a hand-written dispatcher produces for one request. */
interface ManualMatch {
  /** Which logical route matched, in the same naming as the other strategies. */
  route: string;
  /** Path parameters extracted from the URL. */
  params: Record<string, string>;
}

/**
 * A good-faith fast hand-written router: one pass over the path segments, a
 * switch on the first segment, no regex. It is kept *match-only* — returning
 * the route plus params rather than a `Response` — so `--micro` compares the
 * same unit of work across every strategy. This is the practical floor for
 * dispatch cost on Bun, the number the others are measured against.
 */
function manualMatch(pathname: string): ManualMatch | undefined {
  if (pathname === "/ping") {
    return { route: "ping", params: {} };
  }

  // Strip the leading '/' before splitting so segment 0 is meaningful.
  const segments = pathname.slice(1).split("/");

  switch (segments[0]) {
    case "user":
      // /user/:id
      if (segments.length === 2 && segments[1]) {
        return { route: "user", params: { id: segments[1] } };
      }
      return undefined;

    case "api":
      // /api/v1/users/:userId/books/:bookId
      if (
        segments.length === 6 &&
        segments[1] === "v1" &&
        segments[2] === "users" &&
        segments[4] === "books"
      ) {
        return {
          route: "book",
          params: { userId: segments[3], bookId: segments[5] },
        };
      }
      return undefined;

    case "search":
      // /search/:category/:page?  — the optional segment is just a length check.
      if (segments.length === 2 && segments[1]) {
        return { route: "search", params: { category: segments[1] } };
      }
      if (segments.length === 3 && segments[1]) {
        return {
          route: "search",
          params: { category: segments[1], page: segments[2] },
        };
      }
      return undefined;

    case "assets":
      // /assets/*
      if (segments.length > 1) {
        return {
          route: "assets",
          params: { path: pathname.slice("/assets/".length) },
        };
      }
      return undefined;

    default:
      return undefined;
  }
}

/** Turns a {@link ManualMatch} into the shared route set's response body. */
function manualRespond(match: ManualMatch): Response {
  const { params } = match;
  switch (match.route) {
    case "ping":
      return new Response("ok");
    case "user":
      return new Response(params.id);
    case "book":
      return new Response(`${params.userId}/${params.bookId}`);
    case "search":
      return new Response(`${params.category}/${params.page ?? "-"}`);
    default:
      return new Response(params.path);
  }
}

const fetchManualStrategy: Strategy = {
  id: "fetch-manual",
  label: "Bun.serve fetch (manual)",
  async start(port) {
    const server = Bun.serve({
      port,
      fetch(req) {
        const match = manualMatch(pathnameOf(req.url));
        return match
          ? manualRespond(match)
          : new Response("not found", { status: 404 });
      },
    });
    return {
      url: `http://127.0.0.1:${server.port}`,
      stop: () => server.stop(true),
    };
  },
  micro() {
    return (pathname) => manualMatch(pathname);
  },
};

const STRATEGIES: Record<string, Strategy> = {
  "bun-router": bunRouterStrategy("bun-router", "BunRouter (cache on)", false),
  "bun-router-nocache": bunRouterStrategy(
    "bun-router-nocache",
    "BunRouter (cache off)",
    true,
  ),
  "bun-router-methods": bunRouterStrategy(
    "bun-router-methods",
    "BunRouter (per-method)",
    false,
    true,
  ),
  "bun-router-tuned": bunRouterStrategy(
    "bun-router-tuned",
    "BunRouter (cache sized)",
    false,
    false,
    // Comfortably above the `cardinality` scenario's working set, so the
    // pipeline cache actually holds the paths in flight.
    200_000,
  ),
  "bun-serve-routes": bunServeRoutesStrategy,
  "bun-serve-methods": bunServeMethodsStrategy,
  "fs-router": fsRouterStrategy,
  "fetch-manual": fetchManualStrategy,
};

/* ------------------------------------------------------------------ *
 * Correctness check
 * ------------------------------------------------------------------ *
 *
 * A dispatcher that 404s everything would top the throughput table, so every
 * strategy is asserted to produce the same status and body for the same path
 * before any timing figure is worth reading.
 */

/** Expected `status` and body for each scenario path, shared by all strategies. */
const EXPECTED: Record<
  Exclude<ScenarioName, "mixed">,
  { status: number; body: string }
> = {
  "static": { status: 200, body: "ok" },
  "param": { status: 200, body: "42" },
  "deep": { status: 200, body: "7/99" },
  "optional-present": { status: 200, body: "books/2" },
  "optional-absent": { status: 200, body: "books/-" },
  "wildcard": { status: 200, body: "css/site/app.css" },
  "notfound": { status: 404, body: "" },
  "cardinality": { status: 200, body: "0" },
};

/**
 * Starts each strategy, replays every scenario path against it and reports any
 * mismatch. Returns `true` when every strategy agreed with {@link EXPECTED}.
 */
async function runVerify(targets: Strategy[]): Promise<boolean> {
  let allPassed = true;
  let portCursor = config.basePort;

  for (const strategy of targets) {
    const port = portCursor;
    portCursor += 10;

    const server = await strategy.start(port);
    const failures: string[] = [];

    try {
      for (const scenario of ALL_SCENARIOS) {
        if (scenario === "mixed") {
          continue;
        }
        const expected = EXPECTED[scenario];
        // `cardinality` has no single hit path — check the first of its rotation.
        const path =
          scenario === "cardinality" ? cardinalityPaths()[0] : HIT_PATH[scenario];
        const response = await fetch(`${server.url}${path}`, {
          method: config.method,
        });
        const body = await response.text();

        if (response.status !== expected.status) {
          failures.push(
            `${path}: status ${response.status}, expected ${expected.status}`,
          );
        } else if (expected.status === 200 && body !== expected.body) {
          failures.push(
            `${path}: body "${body}", expected "${expected.body}"`,
          );
        }
      }
    } finally {
      await server.stop();
      await Bun.sleep(150);
    }

    if (failures.length) {
      allPassed = false;
      console.log(`  FAIL  ${strategy.label}`);
      for (const failure of failures) {
        console.log(`          ${failure}`);
      }
    } else {
      console.log(`  ok    ${strategy.label}`);
    }
  }

  return allPassed;
}

/* ------------------------------------------------------------------ *
 * Load runner (HTTP mode)
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

  if (scenario === "mixed" || scenario === "cardinality") {
    const paths = scenario === "mixed" ? MIXED_PATHS : cardinalityPaths();
    return autocannon({
      ...base,
      url,
      requests: paths.map((path) => ({ path })),
    });
  }

  return autocannon({
    ...base,
    url: `${url}${HIT_PATH[scenario]}`,
    ...(useWorkers && config.workers > 0 ? { workers: config.workers } : {}),
  });
}

/* ------------------------------------------------------------------ *
 * Micro runner (in-process, no sockets)
 * ------------------------------------------------------------------ */

/**
 * Escape hatch for every match result. Assigning to a module-scope binding that
 * is read after the loop stops JavaScriptCore from proving the result is dead
 * and scalar-replacing (or eliding) the allocation — without it, a strategy
 * whose match result is a plain object literal gets optimized into nothing and
 * posts a physically impossible figure.
 */
let microSink: unknown;

/**
 * Times `iterations` routing decisions for one path, after a warmup pass that
 * lets the JIT settle.
 */
function timeMatcher(
  match: (pathname: string) => unknown,
  paths: string[],
  iterations: number,
): { opsPerSec: number; nsPerOp: number } {
  const count = paths.length;

  // Rotate through the paths *within* the timed loop rather than measuring each
  // path in its own batch: a batched loop keeps one path resident in every
  // cache and would hide exactly the thrashing the `cardinality` scenario
  // exists to expose. For single-path scenarios `count` is 1 and the index
  // arithmetic is a predictable no-op.
  let cursor = 0;
  const warmup = Math.min(20_000, iterations);
  for (let i = 0; i < warmup; i++) {
    microSink = match(paths[cursor]);
    cursor = cursor + 1 === count ? 0 : cursor + 1;
  }

  cursor = 0;
  const started = Bun.nanoseconds();
  for (let i = 0; i < iterations; i++) {
    microSink = match(paths[cursor]);
    cursor = cursor + 1 === count ? 0 : cursor + 1;
  }
  const elapsed = Bun.nanoseconds() - started;

  // Observe `microSink` so the assignments above cannot be optimized away.
  if (microSink === Symbol.for("bun-node.dispatch.never")) {
    console.log("");
  }

  return {
    opsPerSec: (iterations / elapsed) * 1e9,
    nsPerOp: elapsed / iterations,
  };
}

/** Paths a micro scenario cycles through — `mixed` rotates, others are fixed. */
function microPaths(scenario: ScenarioName): string[] {
  if (scenario === "mixed") {
    return MIXED_PATHS;
  }
  if (scenario === "cardinality") {
    return cardinalityPaths();
  }
  return [HIT_PATH[scenario]];
}

/**
 * Measures one strategy against one scenario, keeping the **fastest** of
 * `config.repeats` timed passes. Best-of-N rather than mean: the noise on this
 * machine is one-sided (scheduler preemption, GC, frequency scaling can only
 * ever make a pass slower), so the minimum is the closest estimate of the
 * routing cost itself.
 */
function measureScenario(
  match: (pathname: string) => unknown,
  scenario: ScenarioName,
): { opsPerSec: number; nsPerOp: number } {
  const paths = microPaths(scenario);
  let bestNsPerOp = Infinity;

  for (let repeat = 0; repeat < config.repeats; repeat++) {
    const { nsPerOp } = timeMatcher(match, paths, config.iterations);
    if (nsPerOp < bestNsPerOp) {
      bestNsPerOp = nsPerOp;
    }
  }

  return { opsPerSec: 1e9 / bestNsPerOp, nsPerOp: bestNsPerOp };
}

/**
 * Runs the micro benchmark for a **single** strategy in this process and emits
 * the results as one JSON line. Invoked by {@link runMicro} in a child process
 * (`--micro-child <id>`): measuring several strategies in one process lets one
 * matcher's shapes make another's call sites polymorphic, which was observed to
 * move figures by 3x run-to-run. One process per strategy removes that.
 */
function runMicroChild(strategyId: string): void {
  const strategy = STRATEGIES[strategyId];
  if (!strategy?.micro) {
    console.log(JSON.stringify([]));
    return;
  }

  const match = strategy.micro();
  const results: MicroResult[] = scenarios.map((scenario) => {
    const { opsPerSec, nsPerOp } = measureScenario(match, scenario);
    return { strategy: strategy.label, scenario, opsPerSec, nsPerOp };
  });

  console.log(JSON.stringify(results));
}

/**
 * Runs each strategy's micro benchmark in its own freshly-spawned Bun process
 * and collects the results.
 */
async function runMicro(targets: Strategy[]): Promise<MicroResult[]> {
  const results: MicroResult[] = [];

  for (const strategy of targets) {
    if (!strategy.micro) {
      console.log(
        `  ! ${strategy.label}: skipped in --micro ` +
          `(Bun's native route matcher is not callable outside a live server)`,
      );
      continue;
    }

    const proc = Bun.spawn(
      [
        process.execPath,
        import.meta.path,
        "--micro-child",
        strategy.id,
        "--iterations",
        String(config.iterations),
        "--repeats",
        String(config.repeats),
        "--route",
        scenarios.join(","),
        "--method",
        config.method,
        "--cardinality",
        String(config.cardinality),
      ],
      { stdout: "pipe", stderr: "inherit", cwd: import.meta.dir },
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error(`\n  ! ${strategy.label}: child exited ${exitCode}`);
      continue;
    }

    // The child prints exactly one JSON line; ignore anything else on stdout.
    const line = stdout
      .trim()
      .split("\n")
      .findLast((candidate) => candidate.startsWith("["));

    if (!line) {
      console.error(`\n  ! ${strategy.label}: child produced no results`);
      continue;
    }

    results.push(...(JSON.parse(line) as MicroResult[]));
    process.stdout.write(".");
  }

  process.stdout.write("\n");
  return results;
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

const HTTP_COLUMNS: { title: string; width: number }[] = [
  { title: "Strategy", width: 26 },
  { title: "Req/s", width: 12 },
  { title: "Latency avg", width: 13 },
  { title: "Latency p99", width: 13 },
  { title: "Throughput", width: 14 },
  { title: "vs best", width: 13 },
];

const MICRO_COLUMNS: { title: string; width: number }[] = [
  { title: "Strategy", width: 26 },
  { title: "Matches/s", width: 15 },
  { title: "ns / match", width: 13 },
  { title: "vs best", width: 13 },
];

const COLUMN_GAP = "  ";

function renderRow(
  columns: { title: string; width: number }[],
  cells: string[],
): string {
  return (
    "  " +
    cells
      .map((cell, i) =>
        i === 0 ? cell.padEnd(columns[i].width) : cell.padStart(columns[i].width),
      )
      .join(COLUMN_GAP)
  );
}

function printHeader(
  columns: { title: string; width: number }[],
  title: string,
): void {
  console.log(`\n  ${title}`);
  const header = renderRow(columns, columns.map((c) => c.title));
  const rule = `  ${"-".repeat(header.length - 2)}`;
  console.log(rule);
  console.log(header);
  console.log(rule);
}

function printHttpTable(scenario: ScenarioName, rows: BenchResult[]): void {
  const sorted = [...rows].sort((a, b) => b.reqPerSec - a.reqPerSec);
  const best = sorted[0]?.reqPerSec ?? 0;
  const target = scenario === "mixed" ? "(rotating paths)" : HIT_PATH[scenario];

  printHeader(
    HTTP_COLUMNS,
    `Scenario: ${scenario}  ${config.method} ${target}` +
      `  —  ${config.connections} conns, ${config.duration}s, pipelining ${config.pipelining}`,
  );

  for (const row of sorted) {
    const ratio = best > 0 && row.reqPerSec > 0 ? best / row.reqPerSec : 1;
    const flags: string[] = [];
    if (row.errors) flags.push(`${row.errors} err`);
    if (row.timeouts) flags.push(`${row.timeouts} timeout`);
    if (row.non2xx && scenario !== "notfound") {
      flags.push(`${row.non2xx} non-2xx`);
    }

    const line = renderRow(HTTP_COLUMNS, [
      row.strategy,
      formatNumber(row.reqPerSec),
      `${row.latencyAvg.toFixed(2)} ms`,
      `${row.latencyP99.toFixed(2)} ms`,
      `${row.throughputMB.toFixed(2)} MB/s`,
      ratio <= 1.001 ? "1.00x (best)" : `${ratio.toFixed(2)}x`,
    ]);
    console.log(flags.length ? `${line}${COLUMN_GAP}${flags.join(", ")}` : line);
  }
}

function printMicroTable(scenario: ScenarioName, rows: MicroResult[]): void {
  const sorted = [...rows].sort((a, b) => b.opsPerSec - a.opsPerSec);
  const best = sorted[0]?.opsPerSec ?? 0;
  const target =
    scenario === "mixed"
      ? "(rotating paths)"
      : scenario === "cardinality"
        ? `(${formatNumber(config.cardinality)} distinct /user/:id)`
        : HIT_PATH[scenario];

  printHeader(
    MICRO_COLUMNS,
    `Scenario: ${scenario}  ${target}  —  ${formatNumber(config.iterations)} iterations, in-process`,
  );

  for (const row of sorted) {
    const ratio = best > 0 && row.opsPerSec > 0 ? best / row.opsPerSec : 1;
    console.log(
      renderRow(MICRO_COLUMNS, [
        row.strategy,
        formatNumber(row.opsPerSec),
        row.nsPerOp.toFixed(1),
        ratio <= 1.001 ? "1.00x (best)" : `${ratio.toFixed(2)}x`,
      ]),
    );
  }
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  // Child process spawned by `runMicro`: measure one strategy, print JSON, exit.
  if (values["micro-child"]) {
    runMicroChild(String(values["micro-child"]));
    return;
  }

  const targets: Strategy[] = [];
  for (const id of selectedStrategyIds) {
    const strategy = STRATEGIES[id];
    if (!strategy) {
      console.error(`Unknown strategy: "${id}"`);
      process.exit(1);
    }
    targets.push(strategy);
  }

  console.log(
    config.micro
      ? "Dispatch-strategy benchmark — micro (in-process routing decision)"
      : "Dispatch-strategy benchmark — HTTP",
  );
  console.log(`  Bun ${Bun.version}  ·  ${navigator.hardwareConcurrency} CPUs`);
  console.log(
    `  strategies: ${targets.map((t) => t.id).join(", ")}` +
      `  ·  scenarios: ${scenarios.join(", ")}`,
  );

  if (config.verify) {
    console.log("");
    const passed = await runVerify(targets);
    console.log("");
    process.exit(passed ? 0 : 1);
  }

  if (config.micro) {
    const microResults = await runMicro(targets);
    if (config.json) {
      console.log(JSON.stringify(microResults, null, 2));
      return;
    }
    for (const scenario of scenarios) {
      printMicroTable(
        scenario,
        microResults.filter((r) => r.scenario === scenario),
      );
    }
    console.log("");
    return;
  }

  autocannon = await loadAutocannon();

  const results: BenchResult[] = [];
  let portCursor = config.basePort;

  for (const strategy of targets) {
    const port = portCursor;
    // Leave a gap so a closing server never collides with the next one.
    portCursor += 10;

    let server: RunningServer | undefined;
    try {
      server = await strategy.start(port);
    } catch (error) {
      console.error(
        `\n  ! Skipping ${strategy.label}: failed to start —`,
        error instanceof Error ? error.message : error,
      );
      continue;
    }

    try {
      if (config.warmup > 0) {
        await fire(server.url, scenarios[0], config.warmup, false);
      }

      for (const scenario of scenarios) {
        const result = await fire(server.url, scenario, config.duration, true);
        results.push({
          strategy: strategy.label,
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
    printHttpTable(
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
