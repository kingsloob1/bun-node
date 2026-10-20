#!/usr/bin/env bun
/**
 * Router performance regression guard.
 *
 * Times the request path of bun-common's `BunHttpAdapter` and of bun-nest's
 * adapter under a Nest app **without a socket** — `adapter.fetch(request)`
 * runs the production `handleNativeRequest` — so the figure is the router and
 * its pipeline, not the network. bun-common is also timed at the matcher
 * alone (`getMatchedLayers`), where a 2x matching regression is not diluted
 * by the request and response wrappers around it. Hono's `app.fetch` on the
 * same routes is the rival: the figure that records who led each scenario.
 *
 * ```bash
 * bun router-guard.ts                    # measure and print the table
 * bun router-guard.ts --compare          # fail if anything regressed
 * bun router-guard.ts --save-baseline    # re-record baselines/router.json
 * bun router-guard.ts --verify           # check every response, time nothing
 * bun router-guard.ts --help
 * ```
 *
 * Method: one freshly spawned process per (target, scenario, round), so one
 * scenario's shapes never make another's call sites polymorphic, and rounds
 * are interleaved (every cell of round 1, then round 2), so drift on a shared
 * machine spreads over every cell rather than biasing one. Each process
 * verifies its scenario's response, warms up, then keeps the best of
 * `--batches` timed batches (the noise is one-sided: preemption, GC and
 * frequency scaling only ever slow a batch). A cell's figure is the best of
 * its rounds, for the same reason one level up: on a shared machine a round
 * that lands on a busy minute is slower, never faster (measured: rounds at a
 * load of 16-18 ran 10-20% slower than rounds at 2.6 in the same run, while
 * the quiet rounds agreed within a few percent). Its median is recorded too,
 * and its spread is (max - min) / best over the rounds. Each round waits,
 * up to `--max-wait` seconds, for the 1-minute load to fall under
 * `--max-load` before it starts, and records the load it started at.
 *
 * `--root <dir>` measures another checkout (a worktree, a Nest matrix copy):
 * bun-common, bun-nest and the Nest packages are all loaded from that tree, so
 * one copy of this script benchmarks any revision. `--roots base=<dir>,pr=<dir>`
 * is the PR gate: an A/B of two checkouts in one session, every cell
 * alternating between them, judged against the first (`AB_TOLERANCE`, on
 * the best of the rounds and the median of the per-round ratios together). See `README.md`, "Router regression guard",
 * for both tolerances and how they were calibrated.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { Hono } from "hono";

/* ------------------------------------------------------------------ *
 * Scenarios
 * ------------------------------------------------------------------ */

/** What is being timed. */
type TargetId = "bun-common" | "bun-nest" | "hono";

/**
 * How much of the request path is timed, each level judged against its own
 * baseline cells, so a change to one stage lands on its own cells:
 *
 * - `match`: `getMatchedLayers()` alone, the matcher.
 * - `route`: the route walk, `router.dispatch()` on a `BunRequest` and
 *   `BunResponse` built before the clock starts: matching, every layer and the
 *   handler's `res.send`, without `fetch()`'s entry or the `Response`.
 * - `fetch`: `adapter.fetch(new Request(...))`, socket-free: the request
 *   built from a `Request`, the walk, the `Response`.
 * - `served`: a real `Bun.serve` on port 0, a `fetch()` round trip over
 *   loopback, one request at a time.
 */
type Level = "match" | "route" | "fetch" | "served";

/** Build-time additions a scenario needs, made only in its own process. */
type Variant = "prefix" | "host" | "specificity" | "validate";

/** One scenario: the request (or rotation of requests) and its answer. */
interface Scenario {
  /** CLI and baseline id. */
  id: string;
  /** What it exercises, for the table. */
  what: string;
  /** Targets that run it. */
  targets: TargetId[];
  /** The path of request `i`; a fixed path ignores `i`. */
  path: (i: number) => string;
  /** The request method (default GET). */
  method?: string;
  /** The request's host (default `localhost`). */
  host?: string;
  /** The expected status of request `i`. */
  status: number;
  /** The expected body of request `i`, or a substring it must contain. */
  body: (i: number) => string | { includes: string };
  /**
   * Distinct paths in rotation. Above the route cache (50,000 by default)
   * every request is a cache miss: the cold matching path.
   */
  rotation?: number;
  /** Also timed over a real socket (the `served` level). */
  served?: boolean;
  /**
   * What the build adds for this scenario alone. A host-scoped route changes
   * every cache key of its router, and route specificity every pipeline's
   * order, so neither may leak into another scenario's process.
   */
  variant?: Variant;
}

/** Routes registered on every target, as the wrk scenarios do. */
const ROUTES = 1000;
/** Distinct paths a `-cold` scenario rotates through: above the route cache. */
const COLD_ROTATION = 120_000;

const ALL: TargetId[] = ["bun-common", "hono"];
const ALL_AND_NEST: TargetId[] = ["bun-common", "hono", "bun-nest"];
const OURS: TargetId[] = ["bun-common", "bun-nest"];

const SCENARIOS: Scenario[] = [
  {
    id: "static",
    what: "GET /static",
    targets: ALL_AND_NEST,
    path: () => "/static",
    status: 200,
    body: () => "ok",
    served: true,
  },
  {
    id: "param",
    what: "GET /user/42 (/user/:id)",
    targets: ALL_AND_NEST,
    path: () => "/user/42",
    status: 200,
    body: () => "42",
    served: true,
  },
  {
    id: "deep",
    what: "GET /api/v1/users/7/books/99, two params",
    targets: ALL,
    path: () => "/api/v1/users/7/books/99",
    status: 200,
    body: () => "7/99",
  },
  {
    id: "wildcard",
    what: "GET /assets/css/site/app.css (/assets/*; Nest assets/*path)",
    targets: ALL_AND_NEST,
    path: () => "/assets/css/site/app.css",
    status: 200,
    body: () => "ok",
  },
  {
    id: "wildcard-named",
    what: "GET /files/a/b/c.txt (/files/*path)",
    targets: ALL,
    path: () => "/files/a/b/c.txt",
    status: 200,
    body: () => "ok",
  },
  {
    id: "routes-1000",
    what: `GET /r999/42 among ${ROUTES} /r<i>/:id routes`,
    targets: ALL_AND_NEST,
    path: () => `/r${ROUTES - 1}/42`,
    status: 200,
    body: () => `r${ROUTES - 1}:42`,
  },
  {
    id: "routes-1000-specificity",
    what: "routes-1000 with routeSpecificity: true (matched layers re-ordered)",
    targets: OURS,
    path: () => `/r${ROUTES - 1}/42`,
    status: 200,
    body: () => `r${ROUTES - 1}:42`,
    variant: "specificity",
  },
  {
    id: "routes-1000-cold",
    what: `/r999/<id>, ${COLD_ROTATION} ids: every request a cache miss`,
    targets: ALL_AND_NEST,
    path: (i) => `/r${ROUTES - 1}/${i % COLD_ROTATION}`,
    status: 200,
    body: (i) => `r${ROUTES - 1}:${i % COLD_ROTATION}`,
    rotation: COLD_ROTATION,
  },
  {
    id: "param-cold",
    what: `/user/<id>, ${COLD_ROTATION} ids: every request a cache miss`,
    targets: ALL,
    path: (i) => `/user/${i % COLD_ROTATION}`,
    status: 200,
    body: (i) => String(i % COLD_ROTATION),
    rotation: COLD_ROTATION,
  },
  {
    id: "head",
    what: "HEAD /user/42, answered by the GET route",
    targets: ALL_AND_NEST,
    path: () => "/user/42",
    method: "HEAD",
    status: 200,
    body: () => ({ includes: "" }),
  },
  {
    id: "host",
    what: "GET acme.example.com/tenant/users/7, a domain(':tenant.example.com') route",
    targets: OURS,
    path: () => "/tenant/users/7",
    host: "acme.example.com",
    status: 200,
    body: () => "acme/7",
    variant: "host",
  },
  {
    id: "validate",
    what: "GET /validated/42 behind validate({ params }) (a Standard Schema)",
    targets: ["bun-common"],
    path: () => "/validated/42",
    status: 200,
    body: () => "number:42",
    variant: "validate",
  },
  {
    id: "notfound",
    what: "GET /no/such/route/exists, a 404",
    targets: ALL_AND_NEST,
    path: () => "/no/such/route/exists",
    status: 404,
    body: () => ({ includes: "" }),
    served: true,
  },
  {
    id: "middleware",
    what: "GET /mw/hit behind three /mw middleware",
    targets: ALL_AND_NEST,
    path: () => "/mw/hit",
    status: 200,
    body: () => "mw:3",
  },
  {
    id: "mounted",
    what: "GET /api/v2/acme/items/5, a sub-router at /api/v2/:org",
    targets: ALL,
    path: () => "/api/v2/acme/items/5",
    status: 200,
    body: () => "5",
  },
  {
    id: "prefix-param",
    what: "Nest global prefix v1: GET /v1/user/42",
    targets: ["bun-nest"],
    path: () => "/v1/user/42",
    status: 200,
    body: () => "42",
    variant: "prefix",
  },
  {
    id: "prefix-notfound-inside",
    what: "Nest global prefix v1: GET /v1/no/such, a 404 under the prefix",
    targets: ["bun-nest"],
    path: () => "/v1/no/such",
    status: 404,
    body: () => ({ includes: "Cannot GET" }),
    variant: "prefix",
  },
  {
    id: "prefix-notfound-outside",
    what: "Nest global prefix v1: GET /no/such, a 404 outside it",
    targets: ["bun-nest"],
    path: () => "/no/such",
    status: 404,
    body: () => ({ includes: "Cannot GET" }),
    variant: "prefix",
  },
];

/** The levels a target is timed at (`served` only for `served` scenarios). */
const LEVELS: Record<TargetId, Level[]> = {
  "bun-common": ["match", "route", "fetch", "served"],
  "bun-nest": ["route", "fetch", "served"],
  hono: ["fetch", "served"],
};

/** The levels `target` is timed at on `scenario`. */
function levelsOf(target: TargetId, scenario: Scenario): Level[] {
  return LEVELS[target].filter(
    (level) => level !== "served" || scenario.served,
  );
}

/** Which contender is the rival a figure of ours is recorded against. */
const RIVAL_OF: Partial<Record<TargetId, TargetId>> = { "bun-common": "hono" };

/** Contenders whose cells measure the machine rather than our code. */
const RIVALS = new Set<TargetId>(
  Object.values(RIVAL_OF).filter((t): t is TargetId => t !== undefined),
);

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const DEFAULT_BASELINE = new URL("baselines/router.json", import.meta.url)
  .pathname;

/**
 * How far a figure may fall behind its baseline before it counts as a
 * regression: the cell's ns per request may grow by at most this fraction,
 * net of the machine's drift.
 *
 * Calibrated to measured noise, not chosen; README, "Router regression
 * guard", has the figures per level and the controls measured against it.
 */
export const TOLERANCE = 0.15;

/**
 * `--compare`'s exit status when nothing regressed but some cells ran with
 * other router options than the baseline recorded (a changed default, say):
 * those cells were not judged, so the baseline is due a `--save-baseline`,
 * not the code a fix. A regression elsewhere wins, with exit 1; 2 is a usage
 * error.
 */
export const EXIT_OPTIONS_CHANGED = 3;

/**
 * How far a cell of an A/B side may fall behind the base side (the first of
 * `--roots`) before it counts as a regression, per level. A cell fails when
 * both of two estimates grew past it: its best of the rounds against the
 * base's, and the median, over the rounds, of each round's side / base ratio.
 * Noise moves one of them at a time (a lucky best, a busy round); a change in
 * the code moves both.
 *
 * Far tighter than {@link TOLERANCE}, because both sides run in the same
 * session, alternating per cell, so a round's two figures were measured a few
 * seconds apart and drift cancels in their ratio. Calibrated to measured
 * same-build A/Bs (one checkout given twice): over 368 cells on one Bun build
 * nothing moved more than 4.7% either way, and the 404 negative control moved
 * its three cells 7.6-8.1%. README, "The PR gate", has the figures. The same
 * figure on every level: four runs did not separate them.
 */
export const AB_TOLERANCE: Record<Level, number> = {
  match: 0.05,
  route: 0.05,
  fetch: 0.05,
  served: 0.05,
};

function printHelp(): void {
  console.log(`
Router regression guard (Bun ${Bun.version})

Usage: bun router-guard.ts [options]

  --compare             Fail (exit 1) if a figure regressed against the baseline;
                        exit ${EXIT_OPTIONS_CHANGED} if nothing did but some cells ran with other router
                        options than it recorded (re-record it with --save-baseline)
  --save-baseline       Record this run as the baseline
  --baseline <file>     Baseline file           (default: baselines/router.json)
  --verify              Check every scenario's responses; time nothing
  --root <dir>          Checkout to measure     (default: this script's repo)
  --roots base=<dir>,pr=<dir>
                        A/B, the PR gate: the same cells on each checkout,
                        alternating per cell (A B, then B A). The first root is
                        the base; a side fails (exit 1) when both a cell's best and
                        its median per-round ratio to the base grew past ${(AB_TOLERANCE.fetch * 100).toFixed(0)}%, and
                        exits ${EXIT_OPTIONS_CHANGED} when nothing did but router options differ
  --rounds <n>          Rounds, interleaved     (default: 5)
  --targets <list>      bun-common,bun-nest,hono (default: all)
  --scenarios <list>    Scenario ids or 'all'   (default: all)
  --levels <list>       match,route,fetch,served (default: all)
  --batches <n>         Timed batches per process; the best is kept (default: 9)
  --batch-ms <n>        Length of one batch     (default: 80)
  --warmup-ms <n>       Warm-up per level       (default: 400)
  --max-load <n>        Each round first waits for the 1-minute load to fall
                        under this               (default: cores / 4)
  --max-wait <s>        ...for at most this long (default: 300)
  --json <file>         Write every round's figures to a file
  --label <text>        A name for the run, shown in the table and the JSON
  --from <file>         Judge a run saved with --json instead of measuring:
                        an A/B file is judged as an A/B (its first root the
                        base); a single run with --compare
  -h, --help            This text

Scenarios:
${SCENARIOS.map((s) => `  ${s.id.padEnd(24)} ${s.what} [${s.targets.join(", ")}]`).join("\n")}
`);
}

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    compare: { type: "boolean", default: false },
    "save-baseline": { type: "boolean", default: false },
    baseline: { type: "string" },
    verify: { type: "boolean", default: false },
    root: { type: "string" },
    roots: { type: "string" },
    rounds: { type: "string" },
    targets: { type: "string" },
    scenarios: { type: "string" },
    levels: { type: "string" },
    batches: { type: "string" },
    "batch-ms": { type: "string" },
    "warmup-ms": { type: "string" },
    "max-load": { type: "string" },
    "max-wait": { type: "string" },
    json: { type: "string" },
    label: { type: "string" },
    from: { type: "string" },
    child: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

/** A positive integer option, or its default. */
function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const config = {
  root: resolve(values.root ?? join(import.meta.dir, "..")),
  rounds: int(values.rounds, 5),
  batches: int(values.batches, 9),
  batchMs: int(values["batch-ms"], 80),
  warmupMs: int(values["warmup-ms"], 400),
  maxLoad: Number(values["max-load"] ?? cpus().length / 4),
  maxWaitS: int(values["max-wait"], 300),
  baseline: resolve(values.baseline ?? DEFAULT_BASELINE),
  levels: values.levels
    ? (values.levels.split(",") as Level[])
    : (["match", "route", "fetch", "served"] as Level[]),
};

/* ------------------------------------------------------------------ *
 * Building each target (in the child process)
 * ------------------------------------------------------------------ */

/** The router options a target ran with, recorded in the baseline. */
export interface RouterOptions {
  /** The route cache's capacity (`routeCacheMax`); 0 is off. */
  routeCacheMax: number | null;
  /** Whether paths match case-sensitively (`caseSensitive`). */
  caseSensitive: boolean;
  /** `routeSpecificity`, as this script configured it (not readable back). */
  routeSpecificity: boolean;
}

/** The route walk of a target, without `fetch()`'s entry. */
interface RouteEntry {
  /** Builds the pipeline options for one request (before the clock starts). */
  prepare: (request: Request) => PipelineLike;
  /** Runs the walk: `router.dispatch(options)`. */
  run: (options: PipelineLike) => unknown;
}

/** What {@link RouteEntry} hands between its two halves. */
interface PipelineLike {
  /** The response the layers wrote to. */
  response: { getNativeResponse: (timeout?: number) => Promise<Response> };
}

/** A live server for the `served` level. */
interface Served {
  /** Base URL, scheme to port. */
  url: string;
  /** Closes it, force-closing keep-alive sockets (`stop(true)`). */
  close: () => Promise<void> | void;
}

/** A built target: how to send it a request, and how to match one. */
interface Built {
  /** Sends a request through the target's whole socket-free path. */
  fetch: (request: Request) => Promise<Response> | Response;
  /** The matcher alone, where the target exposes one. */
  match?: (path: string, host: string, method: string) => number;
  /** The route walk, where the target exposes one. */
  route?: RouteEntry;
  /** Starts a real server on port 0. */
  listen: () => Promise<Served>;
  /** The router options, for the baseline. */
  options?: RouterOptions;
}

type BunCommon = typeof import("../packages/bun-common/lib/index");
type BunNest = typeof import("../packages/bun-nest/lib/index");
type NestCommon = typeof import("@nestjs/common");
type NestCore = typeof import("@nestjs/core");
type BunRouterLike = InstanceType<BunCommon["BunRouter"]>;

/** Loads a package's entry from the measured checkout, not from this one. */
async function fromRoot<T>(
  specifier: string,
  from = "packages/bun-nest",
): Promise<T> {
  return (await import(
    Bun.resolveSync(specifier, join(config.root, from))
  )) as T;
}

/** bun-common from the measured checkout (the copy bun-nest resolves too). */
async function bunCommonLib(): Promise<BunCommon> {
  return fromRoot<BunCommon>("@kingsleyweb/bun-common");
}

/** One `/mw` middleware's work: count itself on the request. */
function bump(req: { hits?: number }): void {
  req.hits = (req.hits ?? 0) + 1;
}

/** Shape of the request and response handlers below use, on every target. */
interface Req {
  params: Record<string, string>;
  hits?: number;
}
interface Res {
  send: (body: string) => unknown;
}
type Handler = (req: Req, res: Res, next: () => void) => unknown;

/**
 * A Standard Schema written by hand (no dependency): `{ id }` with `id` a
 * string of digits, output as a number.
 */
const ID_PARAMS = {
  "~standard": {
    version: 1 as const,
    vendor: "router-guard",
    validate(value: unknown) {
      const id = (value as { id?: unknown } | null)?.id;
      return typeof id === "string" && /^\d+$/.test(id)
        ? { value: { id: Number(id) } }
        : { issues: [{ message: "id must be digits", path: ["id"] }] };
    },
  },
};

/** The router options of a bun-common router, read back where readable. */
function optionsOf(router: BunRouterLike, specificity: boolean): RouterOptions {
  const internal = router as unknown as {
    routeCacheMax?: number;
    localOptions?: { caseSensitive?: boolean };
  };
  return {
    routeCacheMax: internal.routeCacheMax ?? null,
    caseSensitive: internal.localOptions?.caseSensitive ?? false,
    routeSpecificity: specificity,
  };
}

/** The route walk of `router`, on requests built as `adapter` builds them. */
function routeEntry(
  lib: BunCommon,
  router: BunRouterLike,
  requestOpts: unknown,
): RouteEntry {
  const server = lib.FETCH_STUB_SERVER;
  type Init = Parameters<BunCommon["BunRequest"]["init"]>;
  return {
    prepare(request) {
      const req = lib.BunRequest.init(request, server, requestOpts as Init[2]);
      if (!(req instanceof lib.BunRequest)) {
        throw new TypeError("a bodiless request should build synchronously");
      }
      const res = new lib.BunResponse(req, {});
      return new lib.RequestPipelineOptions(
        req,
        res,
        req.method,
        req.path,
        undefined,
      ) as unknown as PipelineLike;
    },
    run: (options) =>
      router.dispatch(
        options as unknown as Parameters<BunRouterLike["dispatch"]>[0],
      ),
  };
}

async function buildBunCommon(scenario: Scenario): Promise<Built> {
  const lib = (await import(
    join(config.root, "packages/bun-common/lib/index.ts")
  )) as BunCommon;
  // Parsing off, so the figure is routing rather than request pre-processing,
  // as dispatch.ts and bench.ts measure it.
  const adapter = new lib.BunHttpAdapter(0, {
    request: { parseBody: false, parseCookies: false, parseQuery: false },
  });
  const router = adapter.instance;
  const app = adapter as unknown as Record<
    "get" | "use",
    (path: string, ...handlers: Handler[]) => unknown
  >;
  const ok: Handler = (_req, res) => res.send("ok");
  app.get("/static", ok);
  app.get("/user/:id", (req, res) => res.send(String(req.params.id)));
  const deep: Handler = (req, res) =>
    res.send(`${req.params.userId}/${req.params.bookId}`);
  app.get("/api/v1/users/:userId/books/:bookId", deep);
  app.get("/assets/*", ok);
  app.get("/files/*path", ok);
  for (let i = 0; i < ROUTES; i++) {
    app.get(`/r${i}/:id`, (req, res) => res.send(`r${i}:${req.params.id}`));
  }
  for (let m = 0; m < 3; m++) {
    app.use("/mw", (req, _res, next) => {
      bump(req);
      next();
    });
  }
  app.get("/mw/hit", (req, res) => res.send(`mw:${req.hits}`));
  const sub = new lib.BunRouter() as unknown as typeof app;
  sub.get("/items/:id", (req, res) => res.send(String(req.params.id)));
  app.use("/api/v2/:org", sub as unknown as Handler);

  if (scenario.variant === "host") {
    const domain = (
      adapter as unknown as {
        domain: (host: string, define: (r: typeof app) => void) => unknown;
      }
    ).domain.bind(adapter);
    domain(":tenant.example.com", (tenant) => {
      tenant.get("/tenant/users/:id", (req, res) =>
        res.send(`${req.params.tenant}/${req.params.id}`),
      );
    });
  }
  if (scenario.variant === "validate") {
    const validator = lib.validate({ params: ID_PARAMS });
    app.get("/validated/:id", validator as unknown as Handler, (req, res) =>
      res.send(`${typeof req.params.id}:${req.params.id}`),
    );
  }
  const specificity = scenario.variant === "specificity";
  if (specificity) router.setRouteSpecificity(true);

  return {
    fetch: (request) => adapter.fetch(request),
    match: (path, host, method) =>
      adapter.getMatchedLayers({
        requestHost: host,
        requestMethod: method,
        requestUrl: path,
      }).length,
    route: routeEntry(lib, router, adapter.requestOpts),
    async listen() {
      await adapter.listen(0);
      return {
        url: `http://127.0.0.1:${adapter.listeningPort}`,
        close: () => adapter.close(),
      };
    },
    options: optionsOf(router, specificity),
  };
}

function buildHono(): Built {
  const app = new Hono();
  app.get("/static", (c) => c.text("ok"));
  app.get("/user/:id", (c) => c.text(c.req.param("id")));
  app.get("/api/v1/users/:userId/books/:bookId", (c) => {
    return c.text(`${c.req.param("userId")}/${c.req.param("bookId")}`);
  });
  app.get("/assets/*", (c) => c.text("ok"));
  app.get("/files/:path{.+}", (c) => c.text("ok"));
  for (let i = 0; i < ROUTES; i++) {
    app.get(`/r${i}/:id`, (c) => c.text(`r${i}:${c.req.param("id")}`));
  }
  interface HonoReq {
    raw: unknown;
  }
  const hits = new WeakMap<HonoReq["raw"] & object, number>();
  for (let m = 0; m < 3; m++) {
    app.use("/mw/*", async (c, next) => {
      const raw = c.req.raw;
      hits.set(raw, (hits.get(raw) ?? 0) + 1);
      await next();
    });
  }
  app.get("/mw/hit", (c) => c.text(`mw:${hits.get(c.req.raw)}`));
  const sub = new Hono();
  sub.get("/items/:id", (c) => c.text(c.req.param("id")));
  app.route("/api/v2/:org", sub);
  return {
    fetch: (request) => app.fetch(request),
    async listen() {
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => app.fetch(request),
      });
      return {
        url: `http://127.0.0.1:${server.port}`,
        close: () => server.stop(true),
      };
    },
  };
}

/**
 * The shared route set as a Nest app on bun-nest's adapter, initialised but
 * not listening. Decorators are applied as calls, so the build does not
 * depend on which `tsconfig.json` Bun reads the decorator options from (it
 * reads the working directory's, not the file's: a param decorator can be
 * dropped silently).
 */
async function buildNest(scenario: Scenario): Promise<Built> {
  await fromRoot<unknown>("reflect-metadata");
  const common = await fromRoot<NestCommon>("@nestjs/common");
  const core = await fromRoot<NestCore>("@nestjs/core");
  const bunNest = (await import(
    join(config.root, "packages/bun-nest/lib/index.ts")
  )) as BunNest;
  const lib = await bunCommonLib();
  const {
    Controller,
    Get,
    HostParam,
    Module,
    Param,
    Req: ReqDecorator,
  } = common;

  /** Applies a method decorator to `cls.prototype[name]`. */
  function route(cls: { prototype: object }, name: string, path: string): void {
    const descriptor = Object.getOwnPropertyDescriptor(cls.prototype, name)!;
    Get(path)(cls.prototype, name, descriptor);
  }

  class BenchController {
    static() {
      return "ok";
    }

    assets() {
      return "ok";
    }

    user(id: string) {
      return id;
    }

    mw(req: { hits?: number }) {
      return `mw:${req.hits}`;
    }
  }
  route(BenchController, "static", "static");
  route(BenchController, "assets", "assets/*path");
  Param("id")(BenchController.prototype, "user", 0);
  route(BenchController, "user", "user/:id");
  ReqDecorator()(BenchController.prototype, "mw", 0);
  route(BenchController, "mw", "mw/hit");
  Controller()(BenchController);

  const controllers: unknown[] = [BenchController];
  for (let i = 0; i < ROUTES; i++) {
    class RouteController {
      handle(id: string) {
        return `r${i}:${id}`;
      }
    }
    Param("id")(RouteController.prototype, "handle", 0);
    route(RouteController, "handle", ":id");
    Controller(`r${i}`)(RouteController);
    controllers.push(RouteController);
  }

  if (scenario.variant === "host") {
    class TenantController {
      user(tenant: string, id: string) {
        return `${tenant}/${id}`;
      }
    }
    HostParam("tenant")(TenantController.prototype, "user", 0);
    Param("id")(TenantController.prototype, "user", 1);
    route(TenantController, "user", "users/:id");
    Controller({ host: ":tenant.example.com", path: "tenant" })(
      TenantController,
    );
    controllers.push(TenantController);
  }

  class Bump {
    use(req: { hits?: number }, _res: unknown, next: () => void) {
      bump(req);
      next();
    }
  }
  class Bump2 extends Bump {}
  class Bump3 extends Bump {}

  class AppModule {
    configure(consumer: {
      apply: (...m: unknown[]) => { forRoutes: (...r: string[]) => unknown };
    }) {
      consumer.apply(Bump, Bump2, Bump3).forRoutes("mw/*path");
    }
  }
  Module({ controllers: controllers as never[] })(AppModule);

  const adapter = new bunNest.BunHttpAdapter(undefined, {
    request: { parseBody: false, parseCookies: false, parseQuery: false },
  });
  const app = await core.NestFactory.create(AppModule, adapter, {
    logger: false,
  });
  if (scenario.variant === "prefix") {
    app.setGlobalPrefix("v1");
  }
  await app.init();
  const router = adapter.instance as unknown as BunRouterLike;
  const specificity = scenario.variant === "specificity";
  if (specificity) router.setRouteSpecificity(true);
  return {
    fetch: (request) => adapter.fetch(request),
    route: routeEntry(lib, router, adapter.requestOpts),
    async listen() {
      await app.listen(0, "127.0.0.1");
      return {
        url: `http://127.0.0.1:${adapter.listeningPort}`,
        close: () => app.close(),
      };
    },
    options: optionsOf(router, specificity),
  };
}

async function build(target: TargetId, scenario: Scenario): Promise<Built> {
  switch (target) {
    case "bun-common":
      return buildBunCommon(scenario);
    case "hono":
      return buildHono();
    case "bun-nest":
      return buildNest(scenario);
  }
}

/* ------------------------------------------------------------------ *
 * Timing (in the child process)
 * ------------------------------------------------------------------ */

/** Read after the loops so the JIT cannot prove the results dead. */
let sink: unknown;

/** Per-process figures for one level. */
interface LevelFigures {
  /** Best batch, ns per request: the figure. */
  best: number;
  /** Median batch, ns per request. */
  median: number;
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Times `batches` batches of a synchronous call, after a warm-up. */
function timeSync(run: (i: number) => unknown): LevelFigures {
  let i = 0;
  const warmupEnd = Bun.nanoseconds() + config.warmupMs * 1e6;
  const started = Bun.nanoseconds();
  while (Bun.nanoseconds() < warmupEnd) {
    for (let k = 0; k < 256; k++) sink = run(i++);
  }
  const perOp = (Bun.nanoseconds() - started) / i;
  const batch = Math.max(1000, Math.round((config.batchMs * 1e6) / perOp));
  const samples: number[] = [];
  for (let b = 0; b < config.batches; b++) {
    Bun.gc(true);
    const t0 = Bun.nanoseconds();
    for (let k = 0; k < batch; k++) sink = run(i++);
    samples.push((Bun.nanoseconds() - t0) / batch);
  }
  return { best: Math.min(...samples), median: median(samples) };
}

/** {@link timeSync} for a call that may return a promise. */
async function timeAsync(
  run: (i: number) => Promise<unknown> | unknown,
): Promise<LevelFigures> {
  let i = 0;
  const warmupEnd = Bun.nanoseconds() + config.warmupMs * 1e6;
  const started = Bun.nanoseconds();
  while (Bun.nanoseconds() < warmupEnd) {
    for (let k = 0; k < 64; k++) sink = await run(i++);
  }
  const perOp = (Bun.nanoseconds() - started) / i;
  const batch = Math.max(200, Math.round((config.batchMs * 1e6) / perOp));
  const samples: number[] = [];
  for (let b = 0; b < config.batches; b++) {
    Bun.gc(true);
    const t0 = Bun.nanoseconds();
    for (let k = 0; k < batch; k++) sink = await run(i++);
    samples.push((Bun.nanoseconds() - t0) / batch);
  }
  return { best: Math.min(...samples), median: median(samples) };
}

/** How many requests the `route` level builds before each timed stretch. */
const ROUTE_CHUNK = 1024;

/**
 * Times the route walk alone: each stretch of {@link ROUTE_CHUNK} requests is
 * built (`BunRequest`, `BunResponse`, pipeline options) before the clock
 * starts, and only `run` is timed, awaited only when it returns a promise. A
 * batch adds stretches until it has `--batch-ms` of walking.
 */
async function timeRoute(
  route: RouteEntry,
  request: (i: number) => Request,
): Promise<LevelFigures> {
  let i = 0;
  const prepare = (): PipelineLike[] => {
    const out: PipelineLike[] = [];
    for (let k = 0; k < ROUTE_CHUNK; k++) out.push(route.prepare(request(i++)));
    return out;
  };
  const walk = async (chunk: PipelineLike[]): Promise<number> => {
    const t0 = Bun.nanoseconds();
    for (const options of chunk) {
      const result = route.run(options);
      sink =
        result && typeof (result as Promise<unknown>).then === "function"
          ? await result
          : result;
    }
    return Bun.nanoseconds() - t0;
  };
  const warmupEnd = Date.now() + config.warmupMs;
  while (Date.now() < warmupEnd) await walk(prepare());
  const samples: number[] = [];
  for (let b = 0; b < config.batches; b++) {
    Bun.gc(true);
    let spent = 0;
    let count = 0;
    while (spent < config.batchMs * 1e6) {
      const chunk = prepare();
      spent += await walk(chunk);
      count += chunk.length;
    }
    samples.push(spent / count);
  }
  return { best: Math.min(...samples), median: median(samples) };
}

/** Whether a status and body are the scenario's answer to request `i`. */
function answerProblem(
  scenario: Scenario,
  i: number,
  where: string,
  status: number,
  text: string,
): string | undefined {
  const want = scenario.body(i);
  if (status !== scenario.status) {
    return `${where}: status ${status}, want ${scenario.status} (${text.slice(0, 80)})`;
  }
  const bodyOk =
    typeof want === "string" ? text === want : text.includes(want.includes);
  if (!bodyOk) {
    return `${where}: body ${JSON.stringify(text.slice(0, 80))}, want ${JSON.stringify(want)}`;
  }
  return undefined;
}

/** The URL of request `i` against `origin` (default: the scenario's host). */
function urlOf(scenario: Scenario, i: number, origin?: string): string {
  return `${origin ?? `http://${scenario.host ?? "localhost"}`}${scenario.path(i)}`;
}

/** Checks request `i`'s answer at every level it is timed at. */
async function check(
  built: Built,
  scenario: Scenario,
  i: number,
  levels: Level[],
): Promise<string[]> {
  const method = scenario.method ?? "GET";
  const path = scenario.path(i);
  const problems: string[] = [];
  const response = await built.fetch(
    new Request(urlOf(scenario, i), { method }),
  );
  const problem = answerProblem(
    scenario,
    i,
    `fetch ${path}`,
    response.status,
    await response.text(),
  );
  if (problem) problems.push(problem);

  if (levels.includes("route") && built.route) {
    const options = built.route.prepare(
      new Request(urlOf(scenario, i), { method }),
    );
    const outcome = await built.route.run(options);
    if (scenario.status === 404) {
      // A 404 is a walk no route answered: the not-found handlers run after
      // it, in the adapter, outside this level.
      if (outcome) problems.push(`route ${path}: a route answered a 404 path`);
    } else if (!outcome) {
      problems.push(`route ${path}: no route answered`);
    } else {
      const native = await options.response.getNativeResponse(1000);
      const text = method === "HEAD" ? "" : await native.text();
      const routeProblem = answerProblem(
        scenario,
        i,
        `route ${path}`,
        native.status,
        text,
      );
      if (routeProblem) problems.push(routeProblem);
    }
  }
  return problems;
}

/** What a child prints, as one JSON line. */
interface ChildResult {
  target: TargetId;
  scenario: string;
  /** Problems found verifying the responses (none means it answered right). */
  problems: string[];
  /** Figures per level; absent under --verify or when verification failed. */
  levels: Partial<Record<Level, LevelFigures>>;
  /** The router options it ran with. */
  options?: RouterOptions;
  /**
   * The child's `Bun.revision`. The parent spawns `process.execPath`, so a Bun
   * upgraded mid-run puts the later cells on another build than the earlier
   * ones (seen 2026-10-20); the parent refuses such a run.
   */
  bunRevision?: string;
}

async function runChild(target: TargetId, scenarioId: string): Promise<void> {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const levels = levelsOf(target, scenario).filter((l) =>
    config.levels.includes(l),
  );
  const built = await build(target, scenario);
  const result: ChildResult = {
    target,
    scenario: scenarioId,
    problems: [],
    levels: {},
    options: built.options,
    bunRevision: Bun.revision,
  };
  const method = scenario.method ?? "GET";

  // A fixed path once; a rotation at a spread of its ids, the last included.
  const samples = scenario.rotation
    ? [0, 1, 7, scenario.rotation - 1, scenario.rotation + 3]
    : [0];
  for (const i of samples) {
    result.problems.push(...(await check(built, scenario, i, levels)));
  }

  const timing = !values.verify && result.problems.length === 0;
  const count = scenario.rotation ?? 1;
  const urls = Array.from({ length: count }, (_unused, i) =>
    urlOf(scenario, i),
  );
  const paths = Array.from({ length: count }, (_unused, i) => scenario.path(i));
  const host = scenario.host ?? "localhost";

  if (timing && levels.includes("match") && built.match) {
    const match = built.match;
    result.levels.match = timeSync((i) =>
      match(paths[i % count]!, host, method),
    );
  }
  if (timing && levels.includes("route") && built.route) {
    result.levels.route = await timeRoute(
      built.route,
      (i) => new Request(urls[i % count]!, { method }),
    );
  }
  if (timing && levels.includes("fetch")) {
    const fetchIt = built.fetch;
    result.levels.fetch = await timeAsync((i) =>
      fetchIt(new Request(urls[i % count]!, { method })),
    );
  }
  if (levels.includes("served") && result.problems.length === 0) {
    const served = await built.listen();
    try {
      const target0 = urlOf(scenario, 0, served.url);
      const first = await fetch(target0, { method });
      const problem = answerProblem(
        scenario,
        0,
        `served ${scenario.path(0)}`,
        first.status,
        await first.text(),
      );
      if (problem) result.problems.push(problem);
      else if (timing) {
        const servedUrls = urls.map((_url, i) =>
          urlOf(scenario, i, served.url),
        );
        result.levels.served = await timeAsync(async (i) => {
          const response = await fetch(servedUrls[i % count]!, { method });
          return response.arrayBuffer();
        });
      }
    } finally {
      await served.close();
    }
  }

  if (sink === Symbol.for("router-guard.never")) console.log("");
  console.log(JSON.stringify({ guard: result }));
}

/* ------------------------------------------------------------------ *
 * The parent: rounds, table, baseline, comparison
 * ------------------------------------------------------------------ */

/** One measured cell over every round. */
interface Cell {
  /** `<target>/<level>/<scenario>`. */
  key: string;
  target: TargetId;
  level: Level;
  scenario: string;
  /** Each round's per-process figure (best batch), ns per request. */
  rounds: number[];
  /** The router options the cell ran with. */
  options?: RouterOptions;
}

/** A baseline entry: one cell, reduced. */
export interface BaselineEntry {
  target: TargetId;
  level: Level;
  scenario: string;
  /** Best (lowest) over the rounds, ns per request: the figure compared. */
  nsPerOp: number;
  /** Median over the rounds, ns per request. */
  median: number;
  /** (max - min) / best over the rounds. */
  spread: number;
  /** Every round's figure, ns per request. */
  rounds: number[];
  /** The rival's figure on the same scenario, when the target has one. */
  rival?: { contender: TargetId; nsPerOp: number };
  /** Router options, only where they differ from the target's `routerOptions`. */
  options?: RouterOptions;
}

/** The committed baseline, with what is needed to know when it applies. */
export interface Baseline {
  recordedAt: string;
  /** `Bun.version`. */
  bun: string;
  /** `Bun.revision`. */
  bunRevision: string;
  /** `process.platform-process.arch`. */
  platform: string;
  /** CPU model and logical cores. */
  cpu: string;
  /** The measured checkout's commit, or "unknown" outside git. */
  gitSha: string;
  /** Whether the measured checkout had uncommitted changes. */
  gitDirty: boolean;
  /** `@nestjs/core`'s version in the measured checkout. */
  nest: string;
  /**
   * Each target's router options (`routeCacheMax`, `caseSensitive`,
   * `routeSpecificity`), as most of its cells ran; a cell that ran with
   * others (`routes-1000-specificity`) records its own.
   */
  routerOptions?: Partial<Record<TargetId, RouterOptions>>;
  /** How it was measured. */
  method: {
    rounds: number;
    batches: number;
    batchMs: number;
    warmupMs: number;
  };
  /** The 1-minute load at the start of each round. */
  loads?: number[];
  /** The tolerance in force when it was recorded. */
  tolerance: number;
  entries: Record<string, BaselineEntry>;
}

function cellKey(target: TargetId, level: Level, scenario: string): string {
  return `${target}/${level}/${scenario}`;
}

function spreadOf(rounds: number[]): number {
  return rounds.length
    ? (Math.max(...rounds) - Math.min(...rounds)) / Math.min(...rounds)
    : 0;
}

function git(root: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function nestVersion(root: string): string {
  try {
    const pkg = Bun.resolveSync(
      "@nestjs/core/package.json",
      join(root, "packages/bun-nest"),
    );
    return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string })
      .version;
  } catch {
    return "unknown";
  }
}

function toBaseline(cells: Cell[], root: string): Baseline {
  const entries: Record<string, BaselineEntry> = {};
  for (const cell of cells) {
    if (!cell.rounds.length) continue;
    entries[cell.key] = {
      target: cell.target,
      level: cell.level,
      scenario: cell.scenario,
      nsPerOp: Math.min(...cell.rounds),
      median: median(cell.rounds),
      spread: spreadOf(cell.rounds),
      rounds: cell.rounds,
    };
  }
  // A target's options are what its plain cells ran with (`static`, else the
  // first cell); a cell that differs keeps its own.
  const routerOptions: Partial<Record<TargetId, RouterOptions>> = {};
  for (const cell of cells) {
    if (!cell.options) continue;
    if (cell.scenario === "static" || !routerOptions[cell.target]) {
      routerOptions[cell.target] = cell.options;
    }
  }
  for (const cell of cells) {
    const usual = routerOptions[cell.target];
    const entry = entries[cell.key];
    if (
      entry &&
      cell.options &&
      JSON.stringify(cell.options) !== JSON.stringify(usual)
    ) {
      entry.options = cell.options;
    }
  }
  for (const entry of Object.values(entries)) {
    const rival = RIVAL_OF[entry.target];
    const theirs =
      rival && entries[cellKey(rival, entry.level, entry.scenario)];
    if (theirs) entry.rival = { contender: rival, nsPerOp: theirs.nsPerOp };
  }
  const cpu = cpus();
  return {
    recordedAt: new Date().toISOString(),
    bun: Bun.version,
    bunRevision: Bun.revision,
    platform: `${process.platform}-${process.arch}`,
    cpu: `${cpu[0]?.model ?? "unknown"} (${cpu.length} logical cores)`,
    gitSha: git(root, ["rev-parse", "HEAD"]) ?? "unknown",
    gitDirty: Boolean(git(root, ["status", "--porcelain", "--", "packages"])),
    nest: nestVersion(root),
    routerOptions,
    method: {
      rounds: config.rounds,
      batches: config.batches,
      batchMs: config.batchMs,
      warmupMs: config.warmupMs,
    },
    tolerance: TOLERANCE,
    entries,
  };
}

/** The router options compared between a run and its baseline. */
const OPTION_KEYS = [
  "routeCacheMax",
  "caseSensitive",
  "routeSpecificity",
] as const satisfies readonly (keyof RouterOptions)[];

/**
 * The router options a cell of `run` ran with: its own, else its target's;
 * `undefined` where none were recorded (Hono, a file from before them).
 */
function cellOptions(run: Baseline, key: string): RouterOptions | undefined {
  const entry = run.entries[key];
  return entry && (entry.options ?? run.routerOptions?.[entry.target]);
}

/**
 * Each option that differs, as `caseSensitive true → false`; none when either
 * side is unknown, so a file without options is judged as before.
 */
function optionChanges(was?: RouterOptions, now?: RouterOptions): string[] {
  if (!was || !now) return [];
  return OPTION_KEYS.filter((k) => was[k] !== now[k]).map(
    (k) => `${k} ${String(was[k])} → ${String(now[k])}`,
  );
}

/** A cell that ran with other router options than its baseline: not judged. */
interface OptionsChanged {
  key: string;
  target: TargetId;
  /** Each differing option, `caseSensitive true → false`. */
  changes: string[];
  /** The baseline's figure. */
  was: string;
  /** This run's figure, with its delta raw and net of drift. */
  now: string;
}

/** One way a run differs from its baseline. */
interface Regression {
  key: string;
  kind: "slower" | "overtaken" | "missing" | "drift" | "noise";
  was: string;
  now: string;
}

function ns(value: number): string {
  return value >= 10_000
    ? `${(value / 1000).toFixed(1)}µs`
    : `${value.toFixed(0)}ns`;
}

/**
 * Compares a run with a baseline. Only cells the baseline has are checked, so
 * a new scenario fails nothing before a baseline records it; a cell the
 * baseline has and this run attempted but could not measure is a failure. A
 * cell that ran with other router options than the baseline's is reported in
 * `optionsChanged` and neither passed nor failed: its figure measures a
 * different configuration.
 */
function compare(
  baseline: Baseline,
  current: Baseline,
  attempted: Set<string>,
): {
  regressions: Regression[];
  optionsChanged: OptionsChanged[];
  drifts: LevelDrift[];
} {
  const regressions: Regression[] = [];
  const optionsChanged: OptionsChanged[] = [];
  const drifts = machineDrift(baseline, current);
  const driftOf = new Map(drifts.map((d) => [d.level, d.drift]));
  for (const { level, drift, rivals } of drifts) {
    if (rivals && (drift > 1 + TOLERANCE || drift < 1 / (1 + TOLERANCE))) {
      regressions.push({
        key: `(machine, ${level})`,
        kind: "drift",
        was: "the rival's figures",
        now: `moved ${pct(drift - 1)} with no change to their code: too busy (or too different) a machine to judge; re-run on a quiet one`,
      });
    }
  }
  for (const [key, was] of Object.entries(baseline.entries)) {
    const now = current.entries[key];
    if (!now) {
      if (attempted.has(key)) {
        regressions.push({
          key,
          kind: "missing",
          was: ns(was.nsPerOp),
          now: "not measured",
        });
      }
      continue;
    }
    // A rival's code never changes here (this directory's lockfile pins
    // it), so its cells measure the machine, not a regression: they set the
    // drift and are never failed themselves.
    if (RIVALS.has(was.target)) continue;
    const drift = driftOf.get(was.level) ?? 1;
    const grew = now.nsPerOp / was.nsPerOp / drift - 1;
    const changes = optionChanges(
      cellOptions(baseline, key),
      cellOptions(current, key),
    );
    if (changes.length) {
      optionsChanged.push({
        key,
        target: was.target,
        changes,
        was: ns(was.nsPerOp),
        now: `${ns(now.nsPerOp)} (${pct(now.nsPerOp / was.nsPerOp - 1)}, ${pct(grew)} net of drift)`,
      });
      continue;
    }
    if (grew > TOLERANCE) {
      regressions.push({
        key,
        kind: "slower",
        was: ns(was.nsPerOp),
        now: `${ns(now.nsPerOp)} (${pct(now.nsPerOp / was.nsPerOp - 1)}, ${pct(grew)} net of drift)`,
      });
    }
    // The self-normalising check: a busy machine slows the rival too.
    if (
      was.rival &&
      now.rival &&
      was.nsPerOp < was.rival.nsPerOp &&
      now.nsPerOp >= now.rival.nsPerOp
    ) {
      regressions.push({
        key,
        kind: "overtaken",
        was: `ahead of ${was.rival.contender} (${ns(was.rival.nsPerOp)})`,
        now: `behind it: ${ns(now.nsPerOp)} vs ${ns(now.rival.nsPerOp)}`,
      });
    }
  }
  return { regressions, optionsChanged, drifts };
}

/** One level's drift: how the rival cells it was taken from moved. */
interface LevelDrift {
  level: Level;
  /** Median now / was over the rival cells used (1 with none). */
  drift: number;
  /** How many rival cells it was taken from. */
  rivals: number;
  /** Where they came from: this level's own rival cells, or every level's. */
  source: "own" | "all";
}

/**
 * How much the machine moved between the baseline and this run, per level:
 * the median of now / was over that level's rival cells, or over every rival
 * cell for a level with none (1 when the run measured no rival). Our cells
 * are judged net of their level's drift, so a uniformly slower machine does
 * not read as a regression. Measured: a run at a 1-minute load of about 4, against a
 * baseline recorded at 2.5-3, moved every Hono cell by +2% to +24% (median
 * +7.9%), and failed Hono's own `routes-1000` at +24% before this existed.
 */
function machineDrift(baseline: Baseline, current: Baseline): LevelDrift[] {
  const ratios = new Map<Level | "all", number[]>([["all", []]]);
  const levels = new Set<Level>();
  for (const [key, was] of Object.entries(baseline.entries)) {
    const now = current.entries[key];
    if (!now) continue;
    levels.add(was.level);
    if (!RIVALS.has(was.target)) continue;
    const ratio = now.nsPerOp / was.nsPerOp;
    ratios.get("all")!.push(ratio);
    ratios.set(was.level, [...(ratios.get(was.level) ?? []), ratio]);
  }
  const all = ratios.get("all")!;
  return [...levels].map((level) => {
    const own = ratios.get(level);
    // A level with no rival of its own (match, route: Hono has neither) takes
    // the machine's drift from every rival cell measured.
    const used = own?.length ? own : all;
    return {
      level,
      drift: used.length ? median(used) : 1,
      rivals: used.length,
      source: own?.length ? ("own" as const) : ("all" as const),
    };
  });
}

/** A signed percentage. */
function pct(fraction: number): string {
  return `${fraction >= 0 ? "+" : ""}${(fraction * 100).toFixed(1)}%`;
}

function printTable(
  current: Baseline,
  label: string | undefined,
  base?: Baseline,
): void {
  console.log(
    `\n${label ? `${label}: ` : ""}${current.gitSha.slice(0, 8)}${current.gitDirty ? " (dirty)" : ""}, ` +
      `Nest ${current.nest}, Bun ${current.bun}, ${current.cpu}`,
  );
  console.log(
    `${"cell".padEnd(42)} ${"best".padStart(9)} ${"spread".padStart(7)}` +
      `${base ? `${"baseline".padStart(10)} ${"delta".padStart(7)}` : ""} ${"rival".padStart(9)}`,
  );
  for (const [key, entry] of Object.entries(current.entries)) {
    const was = base?.entries[key];
    const delta = was
      ? `${((entry.nsPerOp / was.nsPerOp - 1) * 100).toFixed(1)}%`
      : "";
    const changed =
      base &&
      optionChanges(cellOptions(base, key), cellOptions(current, key)).length;
    console.log(
      `${key.padEnd(42)} ${ns(entry.nsPerOp).padStart(9)} ${`${(entry.spread * 100).toFixed(1)}%`.padStart(7)}` +
        `${base ? `${(was ? ns(was.nsPerOp) : "-").padStart(10)} ${delta.padStart(7)}` : ""}` +
        ` ${(entry.rival ? ns(entry.rival.nsPerOp) : "").padStart(9)}` +
        `${changed ? "  options changed" : ""}`,
    );
  }
}

/** A run saved with `--json`, to judge again without measuring. */
async function loadSaved(file: string): Promise<{
  measured: (Baseline & { label: string })[];
  attempted: Set<string>;
  problems: string[];
}> {
  const measured = (await Bun.file(file).json()) as (Baseline & {
    label: string;
  })[];
  return {
    measured,
    attempted: new Set(Object.keys(measured[0]?.entries ?? {})),
    problems: [],
  };
}

/** One cell of an A/B side, against the base side. */
interface ABCell {
  key: string;
  level: Level;
  /** Best over the rounds, side / base - 1. */
  best: number;
  /**
   * Median over the rounds of each round's side / base - 1. Round `r` of both
   * sides ran back to back, so drift cancels in the ratio, where best-vs-best
   * compares figures from different minutes.
   */
  paired: number;
  /** Whether the rounds could be paired (equal counts); else `paired` is `best`. */
  pairedRounds: boolean;
  /**
   * The judged figure: the move `best` and `paired` agree on, the one nearer
   * zero when they point the same way, else 0. Noise moves one of them at a
   * time; a real change moves both.
   */
  agreed: number;
}

/** The move two estimates agree on: the smaller when both point one way, else 0. */
function agreedMove(a: number, b: number): number {
  if (a > 0 && b > 0) return Math.min(a, b);
  if (a < 0 && b < 0) return Math.max(a, b);
  return 0;
}

/** An A/B side judged against the base side. */
interface ABVerdict {
  /** The side judged. */
  label: string;
  cells: ABCell[];
  regressions: Regression[];
  optionsChanged: OptionsChanged[];
}

/**
 * Judges `side` against `base`, both measured in one A/B session. A cell of
 * ours fails as **slower** when both its best-of-rounds and the median of its
 * per-round ratios to the base grew past its level's {@link AB_TOLERANCE}
 * (`agreed`); a cell the base has and the side
 * lacks fails as **missing**; a cell whose router options differ is neither
 * passed nor failed (`optionsChanged`). Hono's code is the same on both sides
 * (this directory's copy), so its cells are an A = A pair inside every A/B: one
 * that moved past the tolerance either way fails the run as **noise**, as
 * `--compare`'s drift does, since our cells were measured no better.
 */
function judgeAB(
  base: Baseline,
  side: Baseline & { label: string },
): ABVerdict {
  const cells: ABCell[] = [];
  const regressions: Regression[] = [];
  const optionsChanged: OptionsChanged[] = [];
  for (const [key, was] of Object.entries(base.entries)) {
    const now = side.entries[key];
    if (!now) {
      regressions.push({
        key,
        kind: "missing",
        was: ns(was.nsPerOp),
        now: "not measured",
      });
      continue;
    }
    const best = now.nsPerOp / was.nsPerOp - 1;
    const pairedRounds =
      was.rounds.length > 0 && was.rounds.length === now.rounds.length;
    const paired = pairedRounds
      ? median(was.rounds.map((w, r) => now.rounds[r]! / w)) - 1
      : best;
    const agreed = agreedMove(paired, best);
    cells.push({ key, level: was.level, best, paired, pairedRounds, agreed });
    const tolerance = AB_TOLERANCE[was.level];
    const figures = `${ns(now.nsPerOp)} (${pct(best)} best, ${pct(paired)} paired)`;
    if (RIVALS.has(was.target)) {
      if (Math.abs(agreed) > tolerance) {
        regressions.push({
          key,
          kind: "noise",
          was: ns(was.nsPerOp),
          now: `${figures}: the same code on both sides moved past ${pct(tolerance)}; too noisy a session to judge, re-run on a quiet machine`,
        });
      }
      continue;
    }
    const changes = optionChanges(
      cellOptions(base, key),
      cellOptions(side, key),
    );
    if (changes.length) {
      optionsChanged.push({
        key,
        target: was.target,
        changes,
        was: ns(was.nsPerOp),
        now: figures,
      });
      continue;
    }
    if (agreed > tolerance) {
      regressions.push({
        key,
        kind: "slower",
        was: ns(was.nsPerOp),
        now: figures,
      });
    }
  }
  return { label: side.label, cells, regressions, optionsChanged };
}

/**
 * The A/B table: the base's best and spread, then for each other side its
 * best, spread, best-vs-best delta and paired delta, flagged when judged.
 */
function printAB(
  measured: (Baseline & { label: string })[],
  verdicts: ABVerdict[],
): void {
  const [first, ...rest] = measured;
  for (const [i, run] of measured.entries()) {
    console.log(
      `${i ? "" : "\n"}${i ? "side" : "base"} ${run.label}: ${run.gitSha.slice(0, 8)}${run.gitDirty ? " (dirty)" : ""}, Nest ${run.nest}, Bun ${run.bun}`,
    );
  }
  console.log(
    `\n${"cell".padEnd(42)} ${first!.label.padStart(9)} ${"spread".padStart(7)}${rest
      .map(
        (r) =>
          ` ${r.label.padStart(9)} ${"spread".padStart(7)} ${"best".padStart(7)} ${"paired".padStart(7)}`,
      )
      .join("")}`,
  );
  const flagOf = new Map<string, string>();
  for (const v of verdicts) {
    for (const r of v.regressions) flagOf.set(`${v.label} ${r.key}`, r.kind);
    for (const c of v.optionsChanged)
      flagOf.set(`${v.label} ${c.key}`, "options");
  }
  for (const [key, entry] of Object.entries(first!.entries)) {
    let line = `${key.padEnd(42)} ${ns(entry.nsPerOp).padStart(9)} ${`${(entry.spread * 100).toFixed(1)}%`.padStart(7)}`;
    const flags: string[] = [];
    for (const [i, run] of rest.entries()) {
      const other = run.entries[key];
      const cell = verdicts[i]!.cells.find((c) => c.key === key);
      line +=
        other && cell
          ? ` ${ns(other.nsPerOp).padStart(9)} ${`${(other.spread * 100).toFixed(1)}%`.padStart(7)} ${pct(cell.best).padStart(7)} ${`${pct(cell.paired)}${cell.pairedRounds ? "" : "*"}`.padStart(7)}`
          : ` ${"-".padStart(9)}`;
      const flag = flagOf.get(`${run.label} ${key}`);
      if (flag) flags.push(rest.length > 1 ? `${run.label}: ${flag}` : flag);
    }
    console.log(`${line}${flags.length ? `  ${flags.join(", ")}` : ""}`);
  }
}

/**
 * Prints each side's verdict against the base and returns the exit status:
 * 1 when any side regressed (or the run had problems), else
 * {@link EXIT_OPTIONS_CHANGED} when some cell ran with other router options
 * than the base, else 0.
 */
function reportAB(
  measured: (Baseline & { label: string })[],
  problems: string[],
): number {
  const [base, ...sides] = measured;
  const verdicts = sides.map((side) => judgeAB(base!, side));
  printAB(measured, verdicts);
  const tolerances = [...new Set(Object.values(AB_TOLERANCE))];
  const tol =
    tolerances.length === 1
      ? pct(tolerances[0]!).slice(1)
      : Object.entries(AB_TOLERANCE)
          .map(([level, t]) => `${level} ${pct(t).slice(1)}`)
          .join(", ");
  console.log(
    `\nA/B verdict, base ${base!.label} (the first of --roots); a cell fails when its best and the median of its per-round ratios to the base both grew past ${tol}:`,
  );
  let regressed = problems.length > 0;
  let optionsChanged = 0;
  for (const v of verdicts) {
    const ours = v.cells.filter(
      (c) => !RIVALS.has(base!.entries[c.key]!.target),
    );
    const worst = ours.reduce<ABCell | undefined>(
      (w, c) => (w && w.agreed >= c.agreed ? w : c),
      undefined,
    );
    const noise = v.cells
      .filter((c) => RIVALS.has(base!.entries[c.key]!.target))
      .reduce((m, c) => Math.max(m, Math.abs(c.agreed)), 0);
    const noiseNote =
      v.cells.length > ours.length
        ? `; the rival's cells (the same code on both sides) moved at most ${pct(noise).slice(1)}`
        : "";
    for (const c of v.optionsChanged) {
      console.log(
        `  OPTS  ${v.label} ${c.key.padEnd(42)} ${c.changes.join(", ")}  ${c.was}  ->  ${c.now}; not judged`,
      );
    }
    for (const r of v.regressions) {
      console.log(
        `  FAIL  ${v.label} ${r.key.padEnd(42)} ${r.kind.padEnd(7)} ${r.was}  ->  ${r.now}`,
      );
    }
    if (v.regressions.length === 0) {
      console.log(
        `  ok    ${v.label}: no ${v.optionsChanged.length ? "judged " : ""}cell of ${ours.length - v.optionsChanged.length} grew past the tolerance` +
          `${worst ? ` (worst ${worst.key}, ${pct(worst.agreed)} agreed)` : ""}${noiseNote}.`,
      );
    } else {
      regressed = true;
      console.log(
        `  ${v.label}: ${v.regressions.length} failing cell(s) against ${base!.label}${noiseNote}.`,
      );
    }
    optionsChanged += v.optionsChanged.length;
  }
  if (regressed) {
    console.log(
      `\nverdict: regression (exit 1)${problems.length ? `; ${problems.length} problem(s) above` : ""}${optionsChanged ? `; ${optionsChanged} cell(s) with changed options not judged` : ""}.`,
    );
    return 1;
  }
  if (optionsChanged) {
    console.log(
      `\nverdict: options changed (exit ${EXIT_OPTIONS_CHANGED}). ${optionsChanged} cell(s) ran with other router options ` +
        `than the base, so they measure another configuration and were not judged; every other cell passed.`,
    );
    return EXIT_OPTIONS_CHANGED;
  }
  console.log(`\nverdict: pass (exit 0).`);
  return 0;
}

async function runCell(
  root: string,
  target: TargetId,
  scenario: string,
): Promise<ChildResult | string> {
  const args = [
    process.execPath,
    import.meta.path,
    "--child",
    `${target}:${scenario}`,
    "--root",
    root,
    "--batches",
    String(config.batches),
    "--batch-ms",
    String(config.batchMs),
    "--warmup-ms",
    String(config.warmupMs),
    "--levels",
    config.levels.join(","),
  ];
  if (values.verify) args.push("--verify");
  const proc = Bun.spawn(args, {
    // This directory's tsconfig.json for every root, so every checkout is
    // transpiled with the same decorator options.
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NODE_ENV: "production" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const line = stdout.split("\n").findLast((l) => l.startsWith('{"guard":'));
  if (exitCode !== 0 || !line) {
    return `exit ${exitCode}: ${stderr.trim().split("\n").slice(-5).join(" | ")}`;
  }
  return (JSON.parse(line) as { guard: ChildResult }).guard;
}

/** Runs every planned cell in fresh processes, round by round. */
async function measure(): Promise<{
  measured: (Baseline & { label: string })[];
  attempted: Set<string>;
  problems: string[];
}> {
  const targets = (values.targets?.split(",") ?? [
    "bun-common",
    "hono",
    "bun-nest",
  ]) as TargetId[];
  const wanted =
    !values.scenarios || values.scenarios === "all"
      ? SCENARIOS.map((s) => s.id)
      : values.scenarios.split(",");
  for (const id of wanted) {
    if (!SCENARIOS.some((s) => s.id === id)) {
      console.error(`unknown scenario: ${id}`);
      process.exit(2);
    }
  }
  // `--roots a=<dir>,b=<dir>`: an A/B run of the same cells on each checkout.
  const roots = values.roots
    ? values.roots.split(",").map((spec) => {
        const at = spec.indexOf("=");
        return { label: spec.slice(0, at), dir: resolve(spec.slice(at + 1)) };
      })
    : [{ label: values.label ?? "run", dir: config.root }];
  if (roots.length > 1 && (values.compare || values["save-baseline"])) {
    console.error("--compare and --save-baseline take one root, not --roots");
    process.exit(2);
  }
  const plan = SCENARIOS.filter((s) => wanted.includes(s.id)).flatMap((s) =>
    targets
      .filter((t) => s.targets.includes(t))
      .map((t) => ({ target: t, scenario: s.id })),
  );

  // Each root's cells; with several roots every cell alternates between them
  // (A B, then B A the next round), so drift cannot favour one.
  const runs = roots.map((root) => ({
    ...root,
    cells: new Map<string, Cell>(),
  }));
  const attempted = new Set<string>();
  const problems: string[] = [];
  const rounds = values.verify ? 1 : config.rounds;

  console.log(
    `router-guard: ${plan.length} cells x ${rounds} round(s) x ${runs.length} root(s), Bun ${Bun.version} (${Bun.revision.slice(0, 9)}), load ${(await loadAvg()).toFixed(2)}`,
  );
  for (const run of runs) console.log(`  ${run.label}: ${run.dir}`);
  const roundLoads: number[] = [];
  for (let round = 0; round < rounds; round++) {
    if (!values.verify) roundLoads.push(await waitForQuiet());
    const order = round % 2 ? runs.toReversed() : runs;
    for (const { target, scenario } of plan) {
      const levels = levelsOf(
        target,
        SCENARIOS.find((s) => s.id === scenario)!,
      ).filter((level) => config.levels.includes(level));
      for (const level of levels) {
        attempted.add(cellKey(target, level, scenario));
      }
      for (const run of order) {
        const result = await runCell(run.dir, target, scenario);
        const where = `${runs.length > 1 ? `${run.label} ` : ""}${target}/${scenario}`;
        if (typeof result === "string") {
          problems.push(`${where}: ${result}`);
          continue;
        }
        problems.push(...result.problems.map((p) => `${where}: ${p}`));
        if (result.bunRevision && result.bunRevision !== Bun.revision) {
          problems.push(
            `${where}: ran on Bun ${result.bunRevision.slice(0, 9)}, but the run started on ${Bun.revision.slice(0, 9)}: ` +
              `Bun changed mid-run, so its figures mix two builds; re-run`,
          );
        }
        for (const [level, figures] of Object.entries(result.levels) as [
          Level,
          LevelFigures,
        ][]) {
          const key = cellKey(target, level, scenario);
          const cell = run.cells.get(key) ?? {
            key,
            target,
            level,
            scenario,
            rounds: [],
          };
          cell.rounds.push(figures.best);
          cell.options ??= result.options;
          run.cells.set(key, cell);
        }
      }
    }
    process.stdout.write(
      `  round ${round + 1}/${rounds} done, load ${(await loadAvg()).toFixed(2)}\n`,
    );
  }

  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of new Set(problems)) console.log(`  FAIL  ${p}`);
  }
  if (values.verify) {
    console.log(
      problems.length
        ? ""
        : `\nverify: every scenario answered correctly on every target.`,
    );
    process.exit(problems.length ? 1 : 0);
  }

  const measured = runs.map((run) => ({
    label: run.label,
    ...toBaseline([...run.cells.values()], run.dir),
    loads: roundLoads,
  }));
  return { measured, attempted, problems };
}

async function main(): Promise<void> {
  if (values.help) {
    printHelp();
    return;
  }

  if (values.child) {
    const [target, scenario] = values.child.split(":") as [TargetId, string];
    await runChild(target, scenario);
    process.exit(0);
  }

  const { measured, attempted, problems } = values.from
    ? await loadSaved(values.from)
    : await measure();
  if (values.json && !values.from) {
    await Bun.write(values.json, `${JSON.stringify(measured, null, 2)}\n`);
  }
  if (measured.length > 1) {
    process.exit(reportAB(measured, problems));
  }

  const current = measured[0]!;
  const baselineFile = Bun.file(config.baseline);
  const base = (await baselineFile.exists())
    ? ((await baselineFile.json()) as Baseline)
    : undefined;
  printTable(current, values.label, values.compare ? base : undefined);

  let failed = problems.length > 0;
  let optionsChangedCount = 0;
  if (values["save-baseline"]) {
    if (failed) {
      console.log(`\nNot recording a baseline from a run with problems.`);
    } else {
      const { label: _label, ...record } = current;
      await Bun.write(config.baseline, `${JSON.stringify(record, null, 2)}\n`);
      console.log(
        `\nRecorded ${Object.keys(current.entries).length} cells to ${config.baseline}.`,
      );
    }
  }
  if (values.compare) {
    if (!base) {
      console.log(
        `\nNo baseline at ${config.baseline}. Record one with --save-baseline.`,
      );
      process.exit(1);
    }
    const { regressions, optionsChanged, drifts } = compare(
      base,
      current,
      attempted,
    );
    optionsChangedCount = optionsChanged.length;
    console.log(
      `\nCompared against ${base.gitSha.slice(0, 8)}, recorded ${base.recordedAt.slice(0, 10)} on ${base.cpu}, Bun ${base.bun}.`,
    );
    for (const d of drifts) {
      console.log(
        d.rivals
          ? `  ${d.level.padEnd(6)} drift ${pct(d.drift - 1)} (median of ${d.rivals} rival cells${d.source === "all" ? ", every level's" : ""}); its cells are judged net of it`
          : `  ${d.level.padEnd(6)} no rival cells measured: no drift correction`,
      );
    }
    // Per target, each distinct set of differing options and how many cells
    // it covers; then every such cell, with its figures, unjudged.
    const byTarget = Map.groupBy(
      optionsChanged,
      (c) =>
        `${c.target}: router options differ from the baseline: ${c.changes.join(", ")}`,
    );
    for (const [line, cells] of byTarget) {
      console.log(
        `  OPTS  ${line} (${cells.length} cell${cells.length === 1 ? "" : "s"})`,
      );
    }
    for (const c of optionsChanged) {
      console.log(
        `  OPTS  ${c.key.padEnd(42)} options changed  ${c.was}  ->  ${c.now}; not judged`,
      );
    }
    const unjudged = optionsChanged.length
      ? ` (${optionsChanged.length} cell(s) with changed options not judged)`
      : "";
    if (regressions.length === 0) {
      console.log(
        `  ok    no ${optionsChanged.length ? "judged " : ""}cell grew more than ${(TOLERANCE * 100).toFixed(0)}% net of drift, and every lead held${unjudged}.`,
      );
    } else {
      for (const r of regressions) {
        console.log(
          `  FAIL  ${r.key.padEnd(42)} ${r.kind.padEnd(9)} ${r.was}  ->  ${r.now}`,
        );
      }
      console.log(
        `\n${regressions.length} regression(s)${unjudged}. A baseline only means anything on the machine ` +
          `that recorded it: on different hardware, re-record rather than chase it.`,
      );
      failed = true;
    }
  }
  if (!failed && optionsChangedCount) {
    console.log(
      `\nverdict: options changed (exit ${EXIT_OPTIONS_CHANGED}). ${optionsChangedCount} cell(s) ran with other router ` +
        `options than the baseline, so their figures measure another configuration and were not judged; ` +
        `every other cell passed. If the change is deliberate, re-record the baseline with --save-baseline ` +
        `in the same PR: this is not a regression to fix.`,
    );
    process.exit(EXIT_OPTIONS_CHANGED);
  }
  process.exit(failed ? 1 : 0);
}

/**
 * Waits for the 1-minute load to fall under `--max-load`, for at most
 * `--max-wait` seconds, and returns the load the round starts at. It does not
 * fail when the machine stays busy: the round runs anyway, its load is
 * recorded, and the best-of-rounds figure discounts it.
 */
async function waitForQuiet(): Promise<number> {
  const deadline = Date.now() + config.maxWaitS * 1000;
  let load = await loadAvg();
  while (load >= config.maxLoad && Date.now() < deadline) {
    await Bun.sleep(5000);
    load = await loadAvg();
  }
  return load;
}

/** The 1-minute load average, recorded with each round. */
async function loadAvg(): Promise<number> {
  try {
    return Number((await Bun.file("/proc/loadavg").text()).split(" ")[0]);
  } catch {
    return Number.NaN;
  }
}

await main();
