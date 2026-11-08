/**
 * `@kingsleyweb/bun-cache/throttle`: a `ThrottleStore` for bun-common's
 * `throttle()` over a bun-cache `Cache`, so one limit holds across every
 * process that shares the cache's backend (Redis, Postgres, MySQL, MariaDB,
 * SQLite, MongoDB, …).
 *
 * ```ts
 * import { BunRouter } from "@kingsleyweb/bun-common";
 * import { createCache, redisDriver } from "@kingsleyweb/bun-cache";
 * import { cacheThrottleStore } from "@kingsleyweb/bun-cache/throttle";
 *
 * const cache = createCache({ driver: redisDriver({ url: process.env.REDIS_URL }) });
 * const router = new BunRouter({
 *   throttle: { limit: 100, window: "1m", store: cacheThrottleStore(cache) },
 * });
 * ```
 *
 * How it maps `throttle()`'s two calls onto the cache:
 *
 * - **`increment(key, cost, ttl)`** is `cache.increment(key, cost, { ttl })`:
 *   atomic on every driver that advertises `atomicIncrement`, and the
 *   lifetime is set only when the counter is created (§3.8), so a busy key
 *   still expires on time. A failed increment **throws** even under the
 *   cache's default failure policy (§3.14), and an open circuit throws
 *   `CircuitOpenError` at once; `throttle()`'s `failMode` decides what the
 *   request gets either way.
 * - **`get(key)`** reads the counter with `tier: "l2"`. Counters never enter
 *   an L1 tier (§3.8), and reading past it besides means an L1 can never make
 *   a count per-process. A failed read is a miss under the cache's default
 *   policy (it throws under `strict`), so a request then counts its current
 *   window alone; the `increment` beside it reports the failure.
 *
 * `throttle()` builds every key whole — its prefix, the limit's name, the
 * window's length in milliseconds, the scope, the client and the window's
 * index — so two windows (or two window lengths) never share a counter, and
 * the store keeps each key as it is, under its own namespace of the cache.
 *
 * **On Redis, Postgres, MySQL, MariaDB and SQLite the backend counts.** The
 * store then has `countWindow` and `consumeGcra` too, and `throttle()` uses
 * them: each step is one round trip (a Lua script on Redis, one statement on
 * Postgres, one multi-statement query on MySQL and MariaDB, one transaction
 * on SQLite), and, with `clock: "store"` (the default), the backend's own
 * clock places it (Redis `TIME`, Postgres `clock_timestamp()`, MySQL and
 * MariaDB `UTC_TIMESTAMP(6)`, SQLite `julianday('now')`). The processes
 * sharing the store then need no synchronised clocks, and GCRA
 * (`algorithm: "gcra"`) runs across processes: the bucket is read, judged
 * and written in that one step. These steps go to the driver directly,
 * past the cache's failure policy, circuit breaker, events and statistics;
 * a failure is the store's, for `throttle()`'s `failMode`.
 *
 * **Elsewhere** (memory, file, MongoDB, D1, Azure, S3, `redundant()`, a
 * wrapped driver) the two calls above are all there is. GCRA is not offered
 * there, since a cache counter cannot do a compare-and-set, so
 * `throttle({ algorithm: "gcra" })` refuses the store; and each process
 * places a request in a window by its own clock (`throttle()`'s `now`), with
 * a counter's expiry computed from the cache's clock (`createCache`'s
 * `now`) in the process that creates it. Those processes need synchronised
 * clocks (NTP): a skew of `s` ms between two of them moves their window
 * edges, and the counters' lifetimes, `s` ms apart.
 * {@link CacheThrottleStoreOptions.expiryMargin} covers a backend that
 * expires keys by its own clock (Redis's `PEXPIREAT`).
 */
import type {
  GcraOutcome,
  GcraRequest,
  ThrottleStore,
  WindowCount,
  WindowCountRequest,
  WindowDeleteRequest,
} from "@kingsleyweb/bun-common";
import { ConfigError } from "@kingsleyweb/bun-common";
import type { Cache, CacheDriver, CacheSchema } from "../core/types";
import { cacheDriverOf } from "../core/cache";
import { storedKey } from "../core/keys";
import type { ThrottleCounters } from "../core/throttle-counters";
import {
  THROTTLE_BASE_MAX,
  throttleCountersOf,
} from "../core/throttle-counters";
import { RedundantDriver } from "../drivers/redundant";

/** The default {@link CacheThrottleStoreOptions.namespace}. */
export const DEFAULT_THROTTLE_NAMESPACE = "throttle";

/** The default {@link CacheThrottleStoreOptions.expiryMargin}, in ms. */
export const DEFAULT_THROTTLE_EXPIRY_MARGIN = 1_000;

/** What {@link cacheThrottleStore} takes. */
export interface CacheThrottleStoreOptions {
  /**
   * The namespace of the cache the counters live under:
   * `cache.namespace(namespace)`, so they never mix with the cache's own
   * entries and `clear()` empties this namespace alone. Default
   * `"throttle"`. Processes that must share a limit use the same cache
   * namespace and the same value here (and `throttle()`'s `prefix`); two
   * independent sets of limits on one backend can use different ones.
   */
  readonly namespace?: string;
  /**
   * Milliseconds added to every counter's lifetime. A counter's key carries
   * its window's index, so a longer life changes no count; it only keeps a
   * backend that expires keys by its **own** clock (Redis's `PEXPIREAT` runs
   * on the server's) from dropping a counter while a process whose clock is
   * behind the server's is still counting in that window, which would hand
   * the window a fresh budget. Cover the clock skew you expect. Default
   * `1000`; `0` stores exactly the lifetime `throttle()` asks for. A
   * non-negative finite number.
   */
  readonly expiryMargin?: number;
  /**
   * Which clock places a request in a window, on a backend that counts
   * itself (Redis, Postgres, MySQL, MariaDB, SQLite; see the module header):
   *
   * - `"store"` (the default): the backend's own clock. Every process
   *   sharing the store agrees on the window whatever its clock says, so
   *   none needs NTP; `throttle()`'s `now` is not used for counting.
   * - `"process"`: `throttle()`'s `now`, as on every other backend: what a
   *   test that drives a fake clock wants. Still one round trip a step, and
   *   GCRA still works across processes.
   *
   * Ignored elsewhere, where the process's clock is the only one.
   */
  readonly clock?: "process" | "store";
}

/** What {@link cacheThrottleStore} returns: a `ThrottleStore` whose every method answers a promise. */
export interface CacheThrottleStore extends ThrottleStore {
  /** `"bun-cache:<driver name>"` (`"bun-cache:redis"`); `"bun-cache"` for a `Cache` that `createCache` did not make. */
  readonly name: string;
  /** The full namespace the counters are stored under (the cache's, then {@link CacheThrottleStoreOptions.namespace}), as the driver sees it: its hash under `encrypt.hashNames`. */
  readonly namespace: string;
  /**
   * Adds `cost` to the counter at `key` and answers the new total, atomically
   * across every process on the backend; creates it with a lifetime of `ttl`
   * ms (plus the {@link CacheThrottleStoreOptions.expiryMargin}) when there
   * is none. `cost` must be a safe integer: the shared backends store
   * integer counters (Redis `HINCRBY`, a SQL `BIGINT`), so a fractional cost
   * is refused on every driver alike rather than only in production.
   */
  readonly increment: (
    key: string,
    cost: number,
    ttl: number,
  ) => Promise<number>;
  /** Reads the counter at `key` from the driver (never an L1 tier); `undefined` when there is none or it has expired. */
  readonly get: (key: string) => Promise<number | undefined>;
  /**
   * The clock that places a request: `"store"` when the backend counts by
   * its own clock, `"process"` when `throttle()`'s `now` does (the
   * `clock` option, or a backend that cannot count itself).
   */
  readonly clock: "process" | "store";
  /** One window step in one round trip; present only on a backend that counts itself (see the module header). */
  readonly countWindow?: (
    base: string,
    request: WindowCountRequest,
  ) => Promise<WindowCount>;
  /** Forgets the current and previous windows under `base`, as {@link countWindow} placed them; present with it. */
  readonly deleteWindow?: (
    base: string,
    request: WindowDeleteRequest,
  ) => Promise<void>;
  /** One GCRA step, atomically on the backend; present only on a backend that counts itself, so `algorithm: "gcra"` runs across processes. */
  readonly consumeGcra?: (
    key: string,
    request: GcraRequest,
  ) => Promise<GcraOutcome>;
  /** Deletes the counter at `key`: the client's count starts again from zero (bun-common's `handler.reset`). */
  readonly delete: (key: string) => Promise<void>;
  /** Deletes every counter in this store's namespace, and nothing outside it. */
  readonly clear: () => Promise<void>;
}

/**
 * Whether `driver` can never count atomically. A `redundant()` combinator
 * counts on its primary only, and reports `atomicIncrement: false` while that
 * primary is down — a passing state, not a missing capability — so for it
 * only a missing `increment` (a primary without counters, or
 * `counters: "refuse"`) is permanent.
 */
function lacksAtomicIncrement(driver: CacheDriver): boolean {
  if (typeof driver.increment !== "function") return true;
  if (driver instanceof RedundantDriver) return false;
  return !driver.capabilities.atomicIncrement;
}

/**
 * A `ThrottleStore` over a bun-cache `Cache`: pass it as `throttle()`'s
 * `store` (bun-common) to share one limit across processes. See the module
 * header for how each call maps onto the cache.
 *
 * Throws a `ConfigError` at once for a cache whose driver has no atomic
 * increment (`cloudflareKvDriver`, `s3Driver` with `conditionalWrites:
 * false`, a `redundant()` whose primary has none or with `counters:
 * "refuse"`, a `fromSimpleDriver` store): a read-then-write counter would
 * let concurrent requests through uncounted. A `Cache` that `createCache`
 * did not make cannot be inspected and is accepted; its `increment` decides.
 */
export function cacheThrottleStore<
  Schema extends CacheSchema = CacheSchema,
  Tag extends string = string,
>(
  cache: Cache<Schema, Tag>,
  options: CacheThrottleStoreOptions = {},
): CacheThrottleStore {
  const driver = cacheDriverOf(cache);
  if (driver !== undefined && lacksAtomicIncrement(driver)) {
    throw new ConfigError(
      `cacheThrottleStore: the cache's driver "${driver.name}" has no atomic increment, so it cannot count requests (a read-then-write would let concurrent requests through uncounted). Use a driver that has one — redisDriver, postgresDriver, mysqlDriver, mariadbDriver, mongoDriver, sqliteDriver, fileDriver, cloudflareD1Driver, azureBlobDriver, s3Driver with conditional writes, or redundant() over a primary with counters — or, for one process, bun-common's memoryThrottleStore()`,
      { driver: driver.name },
    );
  }
  const segment = options.namespace ?? DEFAULT_THROTTLE_NAMESPACE;
  if (typeof segment !== "string" || segment === "") {
    throw new ConfigError(
      `cacheThrottleStore: namespace must be a non-empty string; got ${JSON.stringify(segment)}`,
      { namespace: segment },
    );
  }
  const margin = options.expiryMargin ?? DEFAULT_THROTTLE_EXPIRY_MARGIN;
  if (typeof margin !== "number" || !Number.isFinite(margin) || margin < 0) {
    throw new ConfigError(
      `cacheThrottleStore: expiryMargin must be a non-negative finite number of milliseconds; got ${String(margin)}`,
      { expiryMargin: margin },
    );
  }
  const clockOption = options.clock ?? "store";
  if (clockOption !== "store" && clockOption !== "process") {
    throw new ConfigError(
      `cacheThrottleStore: clock must be "store" or "process"; got ${JSON.stringify(clockOption)}`,
      { clock: clockOption },
    );
  }
  // Any cache, a typed one included: the store reads and writes the keys
  // throttle() builds, which no schema of the cache describes.
  const counters = (cache as unknown as Cache).namespace(segment);
  const name = driver === undefined ? "bun-cache" : `bun-cache:${driver.name}`;
  const namespace = counters.describeKey("_").namespace;
  const scripted =
    driver === undefined ? undefined : throttleCountersOf(driver);
  const backend =
    scripted === undefined
      ? {}
      : backendSteps(
          scripted,
          namespace,
          (key) => counters.describeKey(key).key,
          margin,
          clockOption === "store",
        );

  return {
    name,
    namespace,
    clock:
      scripted !== undefined && clockOption === "store" ? "store" : "process",
    ...backend,
    async increment(key, cost, ttl) {
      if (!Number.isSafeInteger(cost)) {
        throw new TypeError(
          `cacheThrottleStore: a request's cost must be an integer (the shared backends count in integers); got ${String(cost)}`,
        );
      }
      return await counters.increment(key, cost, { ttl: ttl + margin });
    },
    async get(key) {
      const value = await counters.get(key, { tier: "l2" });
      return typeof value === "number" ? value : undefined;
    },
    async delete(key) {
      await counters.delete(key);
    },
    async clear() {
      await counters.clear();
    },
  };
}

/**
 * A base name as the backend's counters take it: the cache's stored form of
 * the key (its hash under `encrypt.hashNames`), hashed again when longer than
 * {@link THROTTLE_BASE_MAX} bytes so `<base>:<index>` fits a SQL key column.
 */
function counterName(stored: string): string {
  return storedKey(stored, THROTTLE_BASE_MAX);
}

/** The store's `countWindow`, `deleteWindow` and `consumeGcra` over a driver's own counters. */
function backendSteps(
  scripted: ThrottleCounters,
  namespace: string,
  stored: (key: string) => string,
  margin: number,
  storeClock: boolean,
): Pick<CacheThrottleStore, "consumeGcra" | "countWindow" | "deleteWindow"> {
  const checkCost = (cost: number): void => {
    if (!Number.isSafeInteger(cost)) {
      throw new TypeError(
        `cacheThrottleStore: a request's cost must be an integer (the shared backends count in integers; a negative one is a refund); got ${String(cost)}`,
      );
    }
  };
  return {
    async countWindow(base, request) {
      checkCost(request.cost);
      const counted = await scripted.window(
        namespace,
        counterName(stored(base)),
        {
          window: request.window,
          cost: request.cost,
          previous: request.previous,
          now: storeClock ? undefined : request.now,
          margin,
        },
      );
      const at = storeClock ? counted.now : request.now;
      return {
        current: counted.current,
        previous: counted.previous,
        elapsed: at - Math.floor(at / request.window) * request.window,
      };
    },
    async deleteWindow(base, request) {
      await scripted.deleteWindow(
        namespace,
        counterName(stored(base)),
        request.window,
        storeClock ? undefined : request.now,
      );
    },
    async consumeGcra(key, request) {
      checkCost(request.cost);
      // In µs, so a fractional emission interval loses nothing that matters.
      const interval = (request.window * 1000) / request.limit;
      const step = Math.ceil(request.cost * interval);
      const capacity = request.window * 1000;
      const answer = await scripted.gcra(namespace, counterName(stored(key)), {
        step,
        capacity,
        now: storeClock ? undefined : request.now * 1000,
        margin,
      });
      const ahead = answer.tat - answer.now;
      if (!answer.allowed) {
        return {
          allowed: false,
          remaining: Math.max(
            0,
            Math.floor((capacity - ahead) / interval + 1e-9),
          ),
          resetAfter: ahead / 1000,
          retryAfter: Math.max(0, ahead + step - capacity) / 1000,
        };
      }
      return {
        allowed: true,
        remaining: Math.max(
          0,
          Math.floor((capacity - ahead) / interval + 1e-9),
        ),
        resetAfter: ahead / 1000,
        retryAfter: 0,
      };
    },
  };
}
