/**
 * `cacheStore`: bun-security's shared store over a bun-cache `Cache`
 * (topologies.md §3): one Redis, one SQLite file in WAL mode, one Postgres,
 * MySQL, MariaDB or MongoDB database serves every process's shared limits,
 * counted rules, bans, offence scores and distinct counts, beside the
 * cache's own entries, under a namespace of their own.
 *
 * - **Limits** count through bun-cache's `cacheThrottleStore`, in one round
 *   trip on Redis and the SQL engines, by the store's clock; `hybrid`
 *   limits through a {@link hybridThrottleStore} in front of it.
 * - **Everything** goes through a per-call timeout (50 ms by default) and a
 *   circuit breaker (5 failures, 30 s), so a sick store costs a request its
 *   fallback, never a wait (topologies.md §6.1). A read the cache answered
 *   with a miss because its driver failed (bun-cache's default policy, its
 *   `error` event, its open circuit) is a failure here, never "no bans".
 * - **The ban stream** is the cache's bus when given one (`bus`: `redisBus`,
 *   `pgBus`, or the cache's driver itself, which has `publish` and
 *   `subscribe`), and a poll of the ban log every `pollInterval` besides.
 *
 * The cache is the caller's: `close()` stops what this store started and
 * never closes the cache or the bus.
 */
import {
  createLogger,
  resolveLogger,
  toDurationMs,
} from "@kingsleyweb/bun-common";
import type {
  Duration,
  LoggerLike,
  ThrottleStore,
} from "@kingsleyweb/bun-common";
import type { BusMessage, Cache, CacheBus } from "@kingsleyweb/bun-cache";
import { cacheThrottleStore } from "@kingsleyweb/bun-cache/throttle";
import { SharedStoreError, StoreGuard } from "../engine/shared";
import type { SharedStateStore } from "../engine/shared";
import { hybridThrottleStore } from "./hybrid";

/** The default {@link CacheStoreOptions.namespace}. */
export const DEFAULT_STORE_NAMESPACE = "bun-security";

/** What {@link cacheStore} takes. */
export interface CacheStoreOptions {
  /**
   * The cache namespace the state lives under (`cache.namespace(namespace)`).
   * Processes that share bans, scores and limits use the same cache backend
   * and the same namespace; limits and counted rules are further keyed by
   * their policy's `service`, bans and scores are not (an address banned by
   * one service is banned by every service on the namespace). Default
   * `"bun-security"`.
   */
  readonly namespace?: string;
  /**
   * The bus that announces new bans to the other processes at once: a
   * bun-cache `CacheBus` (`redisBus(url)`, `pgBus(url)`), or the cache's
   * driver, whose `publish` and `subscribe` are the same. Without one, bans
   * reach the other processes within `pollInterval`. Never closed here.
   * (It is asked for again because a `Cache` does not expose its bus:
   * kingsloob1/bun-node#804 would let it default to the cache's own.)
   */
  readonly bus?: Pick<CacheBus, "name"> &
    Partial<Pick<CacheBus, "publish" | "subscribe">>;
  /** A store call slower than this fails (the rule falls back). Default `"50ms"`. */
  readonly timeout?: Duration;
  /** The circuit breaker: `failures` in a row (default 5) open it for `cooldown` (default `"30s"`). */
  readonly circuit?: {
    /** Failures in a row that open the circuit. A positive whole number. Default `5`. */
    readonly failures?: number;
    /** How long it stays open, then one call probes. Default `"30s"`. */
    readonly cooldown?: Duration;
  };
  /** How often `hybrid` limits and offence scores sync. Default `"250ms"`. */
  readonly syncInterval?: Duration;
  /** How often the ban log is read besides the bus's nudges. Default `"5s"`. */
  readonly pollInterval?: Duration;
  /** How often the whole ban set is reloaded and reconciled. Default `"60s"`. */
  readonly reconcileInterval?: Duration;
  /**
   * Which clock places a shared limit's request in its window on a backend
   * that counts itself (Redis, the SQL engines): `"store"`, the backend's
   * (the default; processes need no synchronised clocks), or `"process"`.
   * bun-cache's `cacheThrottleStore` option.
   */
  readonly clock?: "process" | "store";
  /** The clock for the timeouts, the circuit and the hybrid store. Default `Date.now`. */
  readonly now?: () => number;
  /** Where the hybrid store logs a failing sync. Default a console logger named `bun-security`. */
  readonly logger?: LoggerLike;
}

/** A duration option in milliseconds, checked: its unit written, within `min` and `max`. */
function durationOption(
  value: Duration | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value === "number") {
    throw new TypeError(
      `cacheStore(): ${name} must be a duration with its unit, such as "5s"`,
    );
  }
  let ms: number;
  try {
    ms = toDurationMs(value, `cacheStore(): ${name}`);
  } catch (error) {
    throw new TypeError(
      `cacheStore(): ${name} must be a duration such as "5s"`,
      { cause: error },
    );
  }
  if (ms < min || ms > max) {
    throw new TypeError(
      `cacheStore(): ${name} must be from ${min} ms to ${max} ms; got ${ms} ms`,
    );
  }
  return ms;
}

/** A namespace this store accepts. */
const NAMESPACE_RE = /^[\w.-]{1,64}$/;

/**
 * bun-security's shared store over a bun-cache `Cache`: pass it as
 * `createSecurity({ store })`. See the module's description.
 *
 * @example
 * ```ts
 * import { createCache, redisBus, redisDriver } from "@kingsleyweb/bun-cache";
 * import { createSecurity } from "@kingsleyweb/bun-security";
 * import { cacheStore } from "@kingsleyweb/bun-security/stores";
 *
 * const driver = redisDriver({ url: process.env.REDIS_URL });
 * const cache = createCache({ driver });
 * const security = createSecurity({
 *   policy,
 *   store: cacheStore(cache, { bus: driver }),
 * });
 * await security.ready();
 * ```
 */
export function cacheStore(
  cache: Cache,
  options: CacheStoreOptions = {},
): SharedStateStore {
  if (
    typeof cache !== "object" ||
    cache === null ||
    typeof cache.namespace !== "function" ||
    typeof cache.increment !== "function"
  ) {
    throw new TypeError("cacheStore(): the first argument must be a Cache");
  }
  const namespace = options.namespace ?? DEFAULT_STORE_NAMESPACE;
  if (typeof namespace !== "string" || !NAMESPACE_RE.test(namespace)) {
    throw new TypeError(
      "cacheStore(): namespace must be 1 to 64 letters, digits, '_', '.' or '-'",
    );
  }
  const given = options.bus;
  if (
    given !== undefined &&
    (typeof given !== "object" ||
      given === null ||
      typeof given.publish !== "function" ||
      typeof given.subscribe !== "function")
  ) {
    throw new TypeError(
      "cacheStore(): bus must have publish and subscribe (a CacheBus, or a cache driver that has a bus)",
    );
  }
  const bus = given as Pick<CacheBus, "publish" | "subscribe"> | undefined;
  const failures = options.circuit?.failures ?? 5;
  if (!Number.isSafeInteger(failures) || failures < 1) {
    throw new TypeError(
      "cacheStore(): circuit.failures must be a positive whole number",
    );
  }
  const now = options.now ?? Date.now;
  const guard = new StoreGuard({
    timeout: durationOption(options.timeout, 50, "timeout", 1, 60_000),
    failures,
    cooldown: durationOption(
      options.circuit?.cooldown,
      30_000,
      "circuit.cooldown",
      1,
      3_600_000,
    ),
    now,
  });
  const intervals = Object.freeze({
    sync: durationOption(options.syncInterval, 250, "syncInterval", 10, 60_000),
    poll: durationOption(
      options.pollInterval,
      5_000,
      "pollInterval",
      10,
      3_600_000,
    ),
    reconcile: durationOption(
      options.reconcileInterval,
      60_000,
      "reconcileInterval",
      100,
      3_600_000,
    ),
  });
  const view = cache.namespace(namespace);

  // A miss is a failure when the cache's driver failed meanwhile (bun-cache's
  // default policy answers a failed read with a miss) or its circuit is open.
  let driverErrors = 0;
  let circuitOpen = false;
  const unsubscribe = [
    cache.on("error", (event) => {
      if (event.phase === "driver") driverErrors++;
    }),
    cache.on("circuit-open", () => {
      circuitOpen = true;
    }),
    cache.on("circuit-close", () => {
      circuitOpen = false;
    }),
  ];
  const checked = async <T>(read: () => Promise<T>): Promise<T> => {
    if (circuitOpen) {
      throw new SharedStoreError("the cache's circuit is open");
    }
    const before = driverErrors;
    const value = await read();
    if (driverErrors !== before || circuitOpen) {
      throw new SharedStoreError(
        "the cache's driver failed during the read (answered as a miss)",
      );
    }
    return value;
  };

  const inner = cacheThrottleStore(view, {
    namespace: "throttle",
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  const guarded = <A extends unknown[], R>(
    what: string,
    call: ((...args: A) => R | Promise<R>) | undefined,
  ): ((...args: A) => Promise<R>) | undefined =>
    call === undefined
      ? undefined
      : (...args: A) => guard.run(what, async () => await call(...args));
  const increment = guarded("increment", inner.increment);
  // The cache answers a failed counter read with a miss: a failure here.
  const get = guarded("get", (key: string) => checked(() => inner.get(key)));
  if (increment === undefined || get === undefined) {
    throw new TypeError(
      "cacheStore(): the cache's throttle store is incomplete",
    );
  }
  const throttle: ThrottleStore = {
    name: inner.name,
    increment,
    get,
    ...optional("countWindow", guarded("countWindow", inner.countWindow)),
    ...optional("consumeGcra", guarded("consumeGcra", inner.consumeGcra)),
    ...optional("deleteWindow", guarded("deleteWindow", inner.deleteWindow)),
    ...optional("delete", guarded("delete", inner.delete)),
  };
  const hybrid = hybridThrottleStore(throttle, {
    syncInterval: { ms: intervals.sync },
    now,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const logger = resolveLogger(
    options.logger,
    createLogger({ name: "bun-security" }),
  );
  const busNamespace = `bun-security:${namespace}`;
  const origin = `bun-security:${crypto.randomUUID()}`;

  return {
    name: inner.name,
    throttle,
    hybrid,
    intervals,
    get: (key) =>
      guard.run("get", () => checked(() => view.get(key, { tier: "l2" }))),
    getMany: (keys) =>
      guard.run("getMany", () =>
        checked(() => view.getMany(keys, { tier: "l2" })),
      ),
    set: (key, value, ttl) =>
      guard.run("set", async () => {
        const stored = await checked(() => view.set(key, value, { ttl }));
        if (!stored) {
          throw new SharedStoreError(`the cache did not store "${key}"`);
        }
      }),
    increment: (key, by, ttl) =>
      guard.run("increment", () => view.increment(key, by, { ttl })),
    touch: (key, ttl) =>
      guard.run("touch", async () => {
        await checked(() => view.touch(key, ttl));
      }),
    pfAdd: (key, elements, ttl) =>
      guard.run("pfAdd", () => view.pfAdd(key, elements, { ttl })),
    pfCount: (key) => guard.run("pfCount", () => view.pfCount(key)),
    ...(bus === undefined
      ? {}
      : {
          notify: async (): Promise<void> => {
            const message: BusMessage = {
              type: "set",
              namespace: busNamespace,
              keys: ["bans"],
              at: now(),
              origin,
            };
            await guard.run("publish", () => bus.publish(message));
          },
          listen: (onNotify: () => void, onGap: () => void) =>
            bus.subscribe((message) => {
              if (message.namespace === busNamespace) onNotify();
            }, onGap),
        }),
    flush: () => hybrid.flush(),
    health: () => guard.health(),
    close: async () => {
      for (const off of unsubscribe) off();
      try {
        await hybrid.close();
      } catch (error) {
        logger.warn("bun-security: closing the hybrid store failed", {
          error,
        });
      }
    },
  };
}

/** `{ [name]: value }`, or nothing when `value` is undefined (an optional store method). */
function optional<K extends string, V>(
  name: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [name]: value } as Record<K, V>);
}
