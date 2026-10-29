/**
 * The vocabulary of the cache benchmark (plan `docs/plans/bun-cache/` §15).
 *
 * A *contender* is one library configured against one backend. Results are
 * grouped by backend and only ranked inside a group: a Redis figure next to a
 * Postgres one measures the database, not the library.
 */

/** A storage backend a contender can be configured against. */
export type Backend =
  | "memory"
  | "file"
  | "sqlite"
  | "redis"
  | "postgres"
  | "mysql"
  | "mariadb"
  | "mongodb";

/** Every backend, in the order the report prints them. */
export const ALL_BACKENDS: readonly Backend[] = [
  "memory",
  "file",
  "sqlite",
  "redis",
  "postgres",
  "mysql",
  "mariadb",
  "mongodb",
];

/** What a contender is measured doing (§15.1, one row per figure). */
export type Scenario =
  | "get-hit-100b"
  | "get-hit-10kb"
  | "get-hit-1mb"
  | "get-miss"
  | "set-100b"
  | "set-10kb"
  | "set-1mb"
  | "get-many-100"
  | "set-many-100"
  | "stampede"
  | "tags-set"
  | "tags-invalidate"
  | "tier-hit"
  | "tier-invalidate"
  | "http-hit"
  | "http-304"
  | "http-miss"
  | "http-uncached";

/** Every scenario, in the order they are run. */
export const ALL_SCENARIOS: readonly Scenario[] = [
  "get-hit-100b",
  "get-hit-10kb",
  "get-hit-1mb",
  "get-miss",
  "set-100b",
  "set-10kb",
  "set-1mb",
  "get-many-100",
  "set-many-100",
  "stampede",
  "tags-set",
  "tags-invalidate",
  "tier-hit",
  "tier-invalidate",
  "http-hit",
  "http-304",
  "http-miss",
  "http-uncached",
];

/** Everything a contender needs to build itself for one measured run. */
export interface SetupContext {
  /** The backend's connection string; empty for the in-process backends. */
  url: string;
  /**
   * A name unique to this child run, safe in a table, collection, key prefix
   * and directory name (`[a-z0-9_]`). Everything the contender creates carries
   * it, and its `close()` deletes exactly that.
   */
  run: string;
  /** A scratch directory of this child's own, for the file and SQLite backends; removed when the child ends. */
  scratch: string;
}

/**
 * A live cache, reduced to the calls the scenarios make.
 *
 * Every method awaits the backend's answer: a contender whose library is
 * synchronous (lru-cache) is called inside the same awaited shape, so every
 * figure includes one promise per operation.
 */
export interface CacheHandle {
  /** Reads a key; `undefined` on a miss. */
  get: (key: string) => Promise<unknown>;
  /** Writes a key, with tags when the scenario passes them. */
  set: (key: string, value: unknown, tags?: readonly string[]) => Promise<void>;
  /** Reads several keys in as few round trips as the library allows. */
  getMany?: (keys: readonly string[]) => Promise<unknown[]>;
  /** Writes several keys in as few round trips as the library allows. */
  setMany?: (entries: readonly (readonly [string, unknown])[]) => Promise<void>;
  /** Reads the key, and on a miss runs `loader` (once, when the library is single-flight). */
  getOrSet?: (key: string, loader: () => Promise<unknown>) => Promise<unknown>;
  /** Invalidates every entry carrying any of `tags`. */
  invalidateTags?: (tags: readonly string[]) => Promise<void>;
  /** Releases connections and timers, and deletes exactly what this run created. */
  close: () => Promise<void>;
}

/** A cache with a per-process memory tier over a shared one, kept coherent by a bus (§4). */
export interface TierHandle {
  /** Reads a key through the memory tier. */
  get: (key: string) => Promise<unknown>;
  /** Writes a key: the shared tier, and a bus message to the other processes. */
  set: (key: string, value: unknown) => Promise<void>;
  /** Releases connections and timers; the writer's also deletes what the run created. */
  close: () => Promise<void>;
}

/** The two routes the HTTP scenarios fetch, socket-free through `router.fetch()`. */
export interface HttpHandle {
  /** Runs one request through the router's real pipeline. */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Releases the cache, and deletes exactly what this run created. */
  close: () => Promise<void>;
}

/** One library configured against one backend. */
export interface CacheContender {
  /** Stable id, used on the command line and as the child-process selector. */
  id: string;
  /** Human-readable name for the report. */
  label: string;
  /** Which backend this entry talks to. */
  backend: Backend;
  /** True for the library this repository ships. */
  ours?: boolean;
  /** The scenarios this contender takes part in. */
  scenarios: readonly Scenario[];
  /** A caveat printed under the table, for anything that makes the number less than face value. */
  note?: string;
  /** Builds a live cache, for every scenario but the tier and HTTP ones. */
  setup?: (ctx: SetupContext) => CacheHandle | Promise<CacheHandle>;
  /**
   * Builds a tiered cache. `writer` is the process that measures and owns the
   * run's data; `reader` is the second process of `tier-invalidate`, built on
   * the same `run` so both share one namespace and bus.
   */
  tier?: (
    ctx: SetupContext,
    role: "writer" | "reader",
  ) => TierHandle | Promise<TierHandle>;
  /** Builds the router of the HTTP scenarios: `/cached` behind the response cache, `/uncached` without it. */
  http?: (ctx: SetupContext) => HttpHandle | Promise<HttpHandle>;
}

/** Percentiles and extremes of a latency sample, in milliseconds. */
export interface LatencySummary {
  /** Median. */
  p50: number;
  /** 90th percentile. */
  p90: number;
  /** 99th percentile. */
  p99: number;
  /** Slowest sample. */
  max: number;
  /** Arithmetic mean, for comparison with the median. */
  mean: number;
}

/** The one number a measurement is ranked and guarded by. */
export interface Figure {
  /** The value: operations per second, or milliseconds. */
  value: number;
  /** Whether higher is better: throughput yes, latency no. */
  higherIsBetter: boolean;
  /** What the value is, for the tables (`ops/s`, `p99`, `p50`). */
  label: string;
}

/** What one contender measured in one scenario. */
export interface Measurement {
  /** The contender's id. */
  contender: string;
  /** The scenario it ran. */
  scenario: Scenario;
  /** The backend it ran against. */
  backend: Backend;
  /** The figure the scenario is ranked and guarded by; absent when skipped or failed. */
  figure?: Figure;
  /** Operations per second, for the throughput scenarios. */
  opsPerSec?: number;
  /** Latency percentiles, for the scenarios that sample them. */
  latency?: LatencySummary;
  /** How many times the loader ran, in `stampede` (per round, the worst round). */
  loaderCalls?: number;
  /** How many operations (or samples) the figure is based on. */
  count: number;
  /** Wall-clock milliseconds the measured phase took. */
  elapsedMs: number;
  /** Set when the contender could not answer, replacing every figure above. */
  skipped?: string;
  /** Set when the run produced a wrong result, so a failure can never read as a fast time. */
  failed?: string;
}
