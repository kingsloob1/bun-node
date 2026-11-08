/**
 * Where `throttle()` keeps its counters: the {@link ThrottleStore} contract,
 * and {@link memoryThrottleStore}, the bounded in-process store every
 * `throttle()` gets unless it is given another.
 *
 * The contract is structural and small on purpose, so a store over any
 * backend is a few lines: an atomic `increment` that sets a lifetime when
 * it creates a counter, and a `get`. That is all the default algorithm (a
 * sliding-window counter) and the fixed window need, and it is what Redis
 * (`INCRBY` + `PEXPIRE NX`), SQL (an upsert) and bun-cache's `increment`
 * all offer. `@kingsleyweb/bun-cache/throttle` implements it over a
 * bun-cache `Cache`, which is how a limit holds across processes.
 *
 * GCRA (the token bucket's exact form) needs a compare-and-set on one
 * value, which plain counters cannot give; a store that can do it atomically
 * implements the optional {@link ThrottleStore.consumeGcra}. The memory
 * store does (one process, one thread); `throttle({ algorithm: "gcra" })`
 * refuses a store without it at construction.
 *
 * A shared store may also offer {@link ThrottleStore.countWindow} (and
 * {@link ThrottleStore.deleteWindow}): one window step in one round trip,
 * placed by the store's own clock when it keeps one. bun-cache's store does,
 * over a script or a statement per backend, so the processes sharing it no
 * longer need synchronised clocks.
 */
import { ConfigError } from "./errors";

/** A value, or a promise of it: a store may answer synchronously. */
export type MaybePromise<T> = T | Promise<T>;

/** What {@link ThrottleStore.consumeGcra} is asked to do. */
export interface GcraRequest {
  /** The quota: how many units fit in one {@link window} (the bucket's capacity). */
  readonly limit: number;
  /** The window, in milliseconds: a full bucket refills over this long. */
  readonly window: number;
  /** How many units this request takes; `0` only reads. */
  readonly cost: number;
  /**
   * The current time, epoch milliseconds, from the throttle's clock. A store
   * that keeps its own clock (one that reads the server's time, so that
   * processes need no synchronised clocks) ignores it.
   */
  readonly now: number;
}

/** What {@link ThrottleStore.countWindow} is asked to do. */
export interface WindowCountRequest {
  /** The window, in milliseconds; windows are aligned to the epoch (`floor(now / window)`). */
  readonly window: number;
  /**
   * Units added to the current window's counter. `0` only reads: no counter
   * is created.
   */
  readonly cost: number;
  /**
   * Whether the previous window's count is wanted too (the sliding window).
   * `false` for the fixed window, whose counter then only needs to live to
   * its window's end; with `true` it lives until the next window ends, when
   * it is read as the previous one.
   */
  readonly previous: boolean;
  /**
   * The current time, epoch milliseconds, from the throttle's clock. A store
   * that keeps its own clock places the request by that clock instead.
   */
  readonly now: number;
}

/** What {@link ThrottleStore.countWindow} answers. */
export interface WindowCount {
  /** The current window's count, this request's cost included. */
  readonly current: number;
  /** The previous window's count; `0` when there is none or it was not asked for. */
  readonly previous: number;
  /** Milliseconds into the current window, by the clock that placed the request. */
  readonly elapsed: number;
}

/** What {@link ThrottleStore.deleteWindow} is asked to do. */
export interface WindowDeleteRequest {
  /** The window, in milliseconds. */
  readonly window: number;
  /** The current time, epoch milliseconds, from the throttle's clock (ignored by a store with its own clock). */
  readonly now: number;
}

/** What {@link ThrottleStore.consumeGcra} answers. */
export interface GcraOutcome {
  /** Whether the request fits; when `false`, nothing was taken. */
  readonly allowed: boolean;
  /** Whole units left after this request (before it, when refused). */
  readonly remaining: number;
  /** Milliseconds until the bucket is full again. */
  readonly resetAfter: number;
  /** Milliseconds until a request of this cost would fit; `0` when allowed. */
  readonly retryAfter: number;
}

/**
 * Where `throttle()` counts. Implement it over any backend; every method
 * may answer synchronously or with a promise, and a synchronous store keeps
 * a request synchronous end to end.
 *
 * Keys arrive fully formed and namespaced by `throttle()` (prefix, limit
 * name, window, scope, client, window index), so a store stores them as it
 * gets them. A throwing or rejecting call is a store failure: `throttle()`'s
 * `failMode` decides what the request gets.
 */
export interface ThrottleStore {
  /** A short name for logs and errors (`"memory"`, `"bun-cache:redis"`). */
  readonly name: string;
  /**
   * Adds `cost` to the counter at `key` and answers the new total,
   * atomically across everything that shares the store. A counter that does
   * not exist is created at `0` first, with a lifetime of `ttl` milliseconds;
   * the lifetime is set **only** on creation (Redis `PEXPIRE … NX`), so a
   * busy key still expires on time.
   */
  increment: (key: string, cost: number, ttl: number) => MaybePromise<number>;
  /** Reads the counter at `key`; `undefined` (or `0`) when there is none. */
  get: (key: string) => MaybePromise<number | undefined>;
  /**
   * One GCRA step on `key`, atomically: take `request.cost` units when they
   * fit, and say when the bucket refills. Optional: only a store that can
   * read, decide and write one value atomically implements it, and only
   * `algorithm: "gcra"` calls it.
   */
  consumeGcra?: (
    key: string,
    request: GcraRequest,
  ) => MaybePromise<GcraOutcome>;
  /**
   * One window step in one call: add `request.cost` to the current window's
   * counter under `base` (creating it with its lifetime), and answer it with
   * the previous window's count and how far into the window the request is.
   * Optional. A store that has it is used through it by the sliding and fixed
   * windows instead of {@link increment} and {@link get}: one round trip
   * rather than two, and, for a store that keeps its own clock (the
   * server's `TIME` or `now()`), a window index every process agrees on
   * whatever its own clock says. The store names the window's counter
   * itself (`base` plus the window's index is the usual choice).
   */
  countWindow?: (
    base: string,
    request: WindowCountRequest,
  ) => MaybePromise<WindowCount>;
  /**
   * Forgets the current and previous windows' counters under `base`, as
   * placed by the clock {@link countWindow} uses: what
   * `ThrottleHandler.reset()` calls on a store that has `countWindow`.
   * Optional; without it `reset()` deletes the counters it would have named
   * itself, which needs {@link delete}.
   */
  deleteWindow?: (
    base: string,
    request: WindowDeleteRequest,
  ) => MaybePromise<void>;
  /**
   * Forgets the counter (or GCRA state) at `key`: what
   * `ThrottleHandler.reset()` calls for one client. Optional; `reset()`
   * refuses a store without it.
   */
  delete?: (key: string) => MaybePromise<void>;
  /** Forgets every counter (tests, an operator's reset). Optional. */
  clear?: () => MaybePromise<void>;
}

/** What {@link memoryThrottleStore} takes. */
export interface MemoryThrottleStoreOptions {
  /**
   * The most counters kept at once. When a new one would pass it, expired
   * counters go first, then the oldest: a client rotating keys (addresses,
   * tokens) to grow the map cannot take it past this, though it can push
   * other clients' counters out early (they restart at zero). Default
   * `100_000`, a few tens of megabytes at most. A positive integer.
   */
  readonly maxKeys?: number;
  /** The clock, epoch milliseconds. Default `Date.now`; tests pass a fake one. */
  readonly now?: () => number;
}

/** One counter (or, for GCRA, one theoretical arrival time) and when it ends. */
interface MemoryEntry {
  /** The count, or the GCRA theoretical arrival time. */
  value: number;
  /** Epoch milliseconds after which the entry is gone. */
  expiresAt: number;
}

/** The store {@link memoryThrottleStore} returns: a {@link ThrottleStore} that can also report its size. */
export interface MemoryThrottleStore extends ThrottleStore {
  /** The memory store implements GCRA. */
  consumeGcra: (key: string, request: GcraRequest) => GcraOutcome;
  /** Synchronous, as every memory-store answer is. */
  increment: (key: string, cost: number, ttl: number) => number;
  /** Synchronous. */
  get: (key: string) => number | undefined;
  /** Synchronous. */
  delete: (key: string) => void;
  /** Synchronous. */
  clear: () => void;
  /** How many counters are held now (expired ones not yet dropped included). */
  readonly size: number;
  /** The `maxKeys` bound in force. */
  readonly maxKeys: number;
}

/** The default {@link MemoryThrottleStoreOptions.maxKeys}. */
export const DEFAULT_MEMORY_THROTTLE_MAX_KEYS = 100_000;

/** How many of the oldest entries an insert checks for expiry, so expiry costs O(1) per write. */
const SWEEP_PER_INSERT = 2;

/**
 * The bounded, in-process {@link ThrottleStore}: a `Map` in insertion
 * order, so the oldest counter is the first one. Each insert drops up to two
 * expired counters from the front, and, at {@link MemoryThrottleStoreOptions.maxKeys},
 * the oldest one whatever its expiry: memory is bounded by the cap however
 * many keys a client invents. Every answer is synchronous, so a throttle
 * over it never makes a request asynchronous.
 *
 * Counts are per process: behind several instances each one throttles on
 * its own (`limit × instances` in all). Share a store across processes with
 * `cacheThrottleStore()` from `@kingsleyweb/bun-cache/throttle`.
 */
export function memoryThrottleStore(
  options: MemoryThrottleStoreOptions = {},
): MemoryThrottleStore {
  const maxKeys = options.maxKeys ?? DEFAULT_MEMORY_THROTTLE_MAX_KEYS;
  if (!Number.isInteger(maxKeys) || maxKeys < 1) {
    throw new ConfigError(
      `memoryThrottleStore: maxKeys must be a positive integer; got ${String(maxKeys)}`,
      { maxKeys },
    );
  }
  const now = options.now ?? Date.now;
  const entries = new Map<string, MemoryEntry>();

  /** The live entry at `key`, dropping it when it has expired. */
  const live = (key: string, at: number): MemoryEntry | undefined => {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= at) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };

  /** Makes room for one new entry: a little expiry, then the cap. */
  const admit = (at: number): void => {
    let checked = 0;
    for (const [key, entry] of entries) {
      if (checked++ >= SWEEP_PER_INSERT) break;
      if (entry.expiresAt <= at) entries.delete(key);
    }
    while (entries.size >= maxKeys) {
      const oldest = entries.keys().next();
      if (oldest.done === true) break;
      entries.delete(oldest.value);
    }
  };

  return {
    name: "memory",
    maxKeys,
    get size() {
      return entries.size;
    },
    increment(key, cost, ttl) {
      const at = now();
      const entry = live(key, at);
      if (entry !== undefined) {
        entry.value += cost;
        return entry.value;
      }
      admit(at);
      entries.set(key, { value: cost, expiresAt: at + ttl });
      return cost;
    },
    get(key) {
      return live(key, now())?.value;
    },
    consumeGcra(key, request) {
      const at = request.now;
      const interval = request.window / request.limit;
      const entry = live(key, at);
      const tat = Math.max(entry?.value ?? at, at);
      const next = tat + request.cost * interval;
      // The bucket holds `window` ms of emissions: a request fits when the
      // new arrival time is no further ahead than that.
      if (next - at > request.window) {
        return {
          allowed: false,
          remaining: Math.max(
            0,
            Math.floor((request.window - (tat - at)) / interval + 1e-9),
          ),
          resetAfter: tat - at,
          retryAfter: next - at - request.window,
        };
      }
      if (request.cost > 0) {
        if (entry === undefined) {
          admit(at);
          entries.set(key, { value: next, expiresAt: next });
        } else {
          entry.value = next;
          entry.expiresAt = next;
        }
      }
      return {
        allowed: true,
        remaining: Math.max(
          0,
          Math.floor((request.window - (next - at)) / interval + 1e-9),
        ),
        resetAfter: next - at,
        retryAfter: 0,
      };
    },
    delete(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
  };
}
