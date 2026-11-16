/**
 * `hybridThrottleStore`: the `hybrid` state mode (topologies.md §3.2) as a
 * plain `ThrottleStore` in front of a shared one, so any `throttle()` can
 * use it, bun-security's limits included.
 *
 * A request counts in this process, synchronously, against the shared
 * count as last seen plus what this process counted since; every
 * `syncInterval` the counts are added to the shared store in one call per
 * key, whose answer (the total across every process) becomes the new
 * shared count. No request waits on the store, and a limit holds across
 * processes to within about `rate × syncInterval × processes`.
 *
 * A key counted here within the last ten intervals is read back at each
 * sync even with nothing to send, so the other processes' counts reach it
 * while it is in use.
 *
 * When a sync fails the store says so: `increment` and `get` throw (a
 * throttle's `failMode` decides, bun-security's limits their
 * `onStoreError`) until a sync, or a probe of the shared store, succeeds.
 * What was counted before the failure is kept and sent then. Keys are
 * bounded by `maxKeys`, the oldest dropped first (with their unsent counts).
 *
 * The shared store's window counters are placed by this process's clock
 * (it has no `countWindow`), so processes sharing a hybrid limit need
 * synchronised clocks (NTP); and GCRA, which needs a compare-and-set on
 * the store, is not offered.
 */
import {
  createLogger,
  resolveLogger,
  toDurationMs,
} from "@kingsleyweb/bun-common";
import type {
  Duration,
  Logger,
  LoggerLike,
  ThrottleStore,
} from "@kingsleyweb/bun-common";
import { SharedStoreError } from "../engine/shared";

/** The default {@link HybridThrottleStoreOptions.syncInterval}, in ms. */
export const DEFAULT_SYNC_INTERVAL_MS = 250;

/** The key a failing store's recovery is probed with. */
const PROBE_KEY = "bun-security:hybrid-probe";

/** Keys sent per batch of a sync. */
const BATCH = 256;

/** A duration in milliseconds, or `undefined` for a bare number or anything not a duration. */
function durationMs(value: Duration): number | undefined {
  if (typeof value === "number") return undefined;
  try {
    return toDurationMs(value, "duration");
  } catch {
    return undefined;
  }
}

/** What {@link hybridThrottleStore} takes. */
export interface HybridThrottleStoreOptions {
  /** How often counts are sent to the shared store, its unit written. Default `"250ms"`. */
  readonly syncInterval?: Duration;
  /** The most keys held; past it the oldest are dropped, unsent counts and all. A positive whole number. Default `100_000`. */
  readonly maxKeys?: number;
  /** The clock, epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /** Where a failing sync is logged (at most once every 10 s). Default a console logger named `bun-security`. */
  readonly logger?: LoggerLike;
}

/** What {@link hybridThrottleStore} returns. */
export interface HybridThrottleStore extends ThrottleStore {
  /** Counts here, synchronously; throws while the shared store is failing. */
  readonly increment: (key: string, cost: number, ttl: number) => number;
  /** The count as this process sees it; throws while the shared store is failing. */
  readonly get: (key: string) => number | undefined;
  /** Forgets `key` here and in the shared store (when it has `delete`). */
  readonly delete: (key: string) => void;
  /** Sends what was counted since the last sync now. Never rejects. */
  readonly flush: () => Promise<void>;
  /** Stops the sync timer after a last sync. Never closes the shared store. */
  readonly close: () => Promise<void>;
  /** Whether the last sync (or probe) succeeded. */
  readonly healthy: boolean;
  /** Keys held. */
  readonly size: number;
}

/** One key's counts. */
interface Entry {
  /** The total across processes at the last sync. */
  base: number;
  /** Counted here since, not yet sent (fractions of a unit wait for a whole one). */
  pending: number;
  /** When its window counter ends, epoch ms. */
  readonly expiresAt: number;
  /** The lifetime it was created with. */
  readonly ttl: number;
  /** When it was last counted here, epoch ms. */
  hitAt: number;
}

/**
 * A `ThrottleStore` that counts in this process and syncs to `shared` in
 * batches: the `hybrid` mode. See the module's description.
 *
 * @example
 * ```ts
 * import { throttle } from "@kingsleyweb/bun-common";
 * import { cacheThrottleStore } from "@kingsleyweb/bun-cache/throttle";
 * import { hybridThrottleStore } from "@kingsleyweb/bun-security/stores";
 *
 * const store = hybridThrottleStore(cacheThrottleStore(cache), { syncInterval: "250ms" });
 * app.use(throttle({ limit: 600, window: "1m", store, failMode: memoryThrottleStore() }));
 * ```
 */
export function hybridThrottleStore(
  shared: ThrottleStore,
  options: HybridThrottleStoreOptions = {},
): HybridThrottleStore {
  if (
    typeof shared !== "object" ||
    shared === null ||
    typeof shared.increment !== "function"
  ) {
    throw new TypeError(
      "hybridThrottleStore(): the shared store must be a ThrottleStore",
    );
  }
  const interval = durationMs(
    options.syncInterval ?? { ms: DEFAULT_SYNC_INTERVAL_MS },
  );
  if (interval === undefined || interval < 10 || interval > 60_000) {
    throw new TypeError(
      'hybridThrottleStore(): syncInterval must be a duration with its unit, from "10ms" to "1m"',
    );
  }
  const maxKeys = options.maxKeys ?? 100_000;
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) {
    throw new TypeError(
      "hybridThrottleStore(): maxKeys must be a positive whole number",
    );
  }
  const now = options.now ?? Date.now;
  const logger: Logger = resolveLogger(
    options.logger,
    createLogger({ name: "bun-security" }),
  );
  const entries = new Map<string, Entry>();
  let healthy = true;
  let lastWarn = Number.NEGATIVE_INFINITY;
  let syncing: Promise<void> | undefined;
  let closed = false;

  const failing = (): never => {
    throw new SharedStoreError(
      `the shared throttle store "${shared.name}" is failing (hybrid sync)`,
    );
  };

  const live = (key: string, at: number): Entry | undefined => {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt > at) return entry;
    if (entry.pending === 0) entries.delete(key);
    return undefined;
  };

  const failed = (error: unknown): void => {
    healthy = false;
    const at = now();
    if (at - lastWarn < 10_000) return;
    lastWarn = at;
    logger.warn(
      `bun-security: the hybrid store's sync to "${shared.name}" failed; its limits run as their onStoreError says until it recovers`,
      { error },
    );
  };

  /**
   * One sync: every key with a whole unit unsent, and every key counted
   * here lately (read back, adding 0), in batches; a probe when failing with
   * nothing to send.
   */
  const sync = async (): Promise<void> => {
    const at = now();
    const due: [string, Entry, number][] = [];
    for (const [key, entry] of entries) {
      const whole = Math.trunc(entry.pending);
      if (entry.expiresAt <= at && whole === 0) entries.delete(key);
      else if (whole !== 0 || at - entry.hitAt < 10 * interval) {
        due.push([key, entry, whole]);
      }
    }
    if (due.length === 0) {
      if (healthy) return;
      try {
        await shared.increment(PROBE_KEY, 0, 1000);
        healthy = true;
      } catch (error) {
        failed(error);
      }
      return;
    }
    let ok = true;
    for (let i = 0; i < due.length; i += BATCH) {
      const batch = due.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async ([key, entry, whole]) =>
          Number(
            await shared.increment(
              key,
              whole,
              Math.max(1, entry.expiresAt - at),
            ),
          ),
        ),
      );
      results.forEach((result, j) => {
        const item = batch[j];
        if (item === undefined) return;
        const [key, entry, whole] = item;
        if (result.status === "rejected") {
          ok = false;
          failed(result.reason);
          return;
        }
        entry.pending -= whole;
        entry.base = Number(result.value);
        if (entry.expiresAt <= now() && Math.trunc(entry.pending) === 0) {
          entries.delete(key);
        }
      });
    }
    if (ok) healthy = true;
  };

  const flush = (): Promise<void> => {
    syncing ??= sync()
      .catch(failed)
      .finally(() => {
        syncing = undefined;
      });
    return syncing;
  };

  const timer = setInterval(() => {
    if (!closed) void flush();
  }, interval);
  timer.unref?.();

  return {
    name: `hybrid:${shared.name}`,
    increment(key: string, cost: number, ttl: number): number {
      if (!healthy) failing();
      const at = now();
      let entry = live(key, at);
      if (entry === undefined) {
        entry = { base: 0, pending: 0, expiresAt: at + ttl, ttl, hitAt: at };
        entries.delete(key);
        entries.set(key, entry);
        while (entries.size > maxKeys) {
          const oldest = entries.keys().next();
          if (oldest.done === true) break;
          entries.delete(oldest.value);
        }
      }
      entry.pending += cost;
      entry.hitAt = at;
      return entry.base + entry.pending;
    },
    get(key: string): number | undefined {
      if (!healthy) failing();
      const entry = live(key, now());
      return entry === undefined ? undefined : entry.base + entry.pending;
    },
    delete(key: string): void {
      entries.delete(key);
      const remove = shared.delete;
      if (remove !== undefined) {
        Promise.resolve()
          .then(() => remove(key))
          .catch(failed);
      }
    },
    clear(): void {
      entries.clear();
    },
    flush,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await flush();
    },
    get healthy(): boolean {
      return healthy;
    },
    get size(): number {
      return entries.size;
    },
  };
}
