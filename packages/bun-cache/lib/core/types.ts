/**
 * The public types of `@kingsleyweb/bun-cache`: the driver contract
 * (plan §6.1), the stored-entry shape (§3.2), the cache's options and events,
 * and the typed-cache machinery (§3.13, bun-validate's V10).
 */
import type {
  Jsonify,
  LoggerLike,
  StandardSchemaV1,
} from "@kingsleyweb/bun-common";
import type { ValidationIssue } from "@kingsleyweb/bun-common/contract";

/* ------------------------------------------------------------------ */
/* The driver contract (plan §6.1)                                    */
/* ------------------------------------------------------------------ */

/**
 * What a driver stores: opaque bytes with an absolute expiry and tags. The
 * core encodes its header and the value's codec bytes into `value`; a driver
 * never decodes them (plan §3.2).
 */
export interface StoredEntry {
  /** The stored key: namespaced by the driver call's `ns`, hashed when long (§3.7). */
  key: string;
  /** Header + payload, opaque to the driver. */
  value: Uint8Array;
  /** The hard expiry, epoch ms; `null` never expires. The driver uses it for its native TTL or its sweeper. */
  expiresAt: number | null;
  /** The entry's tags. */
  tags: readonly string[];
}

/** The write-side tag fence (§3.6): refuse a write whose loader started before a tag's invalidation. */
export interface TagFence {
  /** The tags the write carries. */
  tags: readonly string[];
  /** When the load that produced the value started, epoch ms. */
  createdAt: number;
}

/** What a backend can do atomically, declared once per driver. */
export interface CacheDriverCapabilities {
  /** Whether several processes share what it stores (memory: `false`). */
  multiProcess: boolean;
  /** Who reclaims expired entries: the backend itself, or the core's sweeper calling {@link CacheDriver.sweep}. */
  ttl: "native" | "sweep";
  /** Whether {@link CacheDriver.increment} is atomic. */
  atomicIncrement: boolean;
  /** Whether {@link CacheDriver.acquireLock}/{@link CacheDriver.releaseLock} work. */
  lock: boolean;
  /** How tags invalidate (§3.6): eager deletion through an index plus the write fence, or lazy stamps checked on read. */
  tags: "index" | "stamps";
  /** For `tags: "index"`: whether `set` with a fence is one atomic operation, or a check followed by a write. */
  fence: "atomic" | "check-then-write";
  /** How the multi-tier bus delivers (later PRs): pushed, polled, or not at all. */
  bus: "push" | "poll" | "none";
  /** The backend's own per-entry byte limit, when it has one; the core's `maxEntryBytes` is capped by it. */
  maxEntryBytes?: number;
}

/** A message on the multi-tier bus (§4.2; the bus itself is a later PR). Carries keys, never values. */
export interface BusMessage {
  /** What changed. */
  type: "set" | "delete" | "invalidate-tags" | "clear";
  /** The namespace it changed in. */
  namespace: string;
  /** The stored keys, on `"set"` and `"delete"`. */
  keys?: readonly string[];
  /** The invalidated tags, on `"invalidate-tags"`. */
  tags?: readonly string[];
  /** When it happened, epoch ms. */
  at: number;
}

/** Options for {@link CacheDriver.syncSchema}. */
export interface SchemaSyncOptions {
  /** Report the plan without applying it. Defaults to `false`. */
  dryRun?: boolean;
}

/** One schema change {@link CacheDriver.syncSchema} made or would make. */
export interface SchemaChange {
  /** What changed or would change. */
  description: string;
  /** Whether it was applied (`false` under `dryRun`, or when it is not safe). */
  applied: boolean;
  /** Whether applying it blocks readers or writers (an SQLite index build). */
  blocking?: boolean;
}

/**
 * A cache driver: stores opaque entries under a namespace, and declares the
 * atomic primitives its backend has. The core emulates or refuses the rest,
 * the same way on every backend (plan §6.1).
 *
 * Construction follows bun-jobs' rule: a driver that receives an existing
 * client never closes it; one it built itself, it closes in {@link close}.
 */
export interface CacheDriver {
  /** The backend's name (`"memory"`, `"postgres"`, `"my-driver"`). */
  readonly name: string;
  /** What the backend can do atomically. */
  readonly capabilities: CacheDriverCapabilities;
  /** Opens connections; idempotent. Optional: drivers connect lazily on first use. */
  connect?: () => Promise<void>;
  /** Closes what the driver created, never a client it was given. */
  close: () => Promise<void>;
  /** A cheap liveness probe for the circuit's half-open state. Optional. */
  ping?: () => Promise<void>;

  /** Reads one entry; `undefined` on a miss. An expired entry may be returned; the core checks. */
  get: (ns: string, key: string) => Promise<StoredEntry | undefined>;
  /** Reads several entries, in the keys' order, `undefined` per miss. */
  getMany: (
    ns: string,
    keys: readonly string[],
  ) => Promise<(StoredEntry | undefined)[]>;
  /**
   * Writes one entry. With `fence` (§3.6), a driver with `tags: "index"`
   * refuses the write when any of its tags was invalidated after
   * `fence.createdAt`, and answers `"fenced"`. Drivers with `tags: "stamps"`
   * never see a fence: the read-side check covers the race.
   */
  set: (
    ns: string,
    entry: StoredEntry,
    fence?: TagFence,
  ) => Promise<"stored" | "fenced">;
  /** Writes several entries. No fence: bulk writes come from explicit `setMany`, not from loads. */
  setMany: (ns: string, entries: readonly StoredEntry[]) => Promise<void>;
  /** Deletes keys; answers how many were deleted. */
  delete: (ns: string, keys: readonly string[]) => Promise<number>;
  /** Deletes every entry of one namespace, and its tag index. Never touches another namespace. */
  clear: (ns: string) => Promise<void>;
  /** Updates one entry's (or counter's) hard expiry; `false` when the key is absent. Optional. */
  touch?: (
    ns: string,
    key: string,
    expiresAt: number | null,
  ) => Promise<boolean>;

  /**
   * `tags: "index"`: deletes every entry carrying any of `tags`, writes a
   * stamp per tag living until `stampUntil`, and answers how many entries
   * were deleted (§3.6).
   */
  deleteByTags?: (
    ns: string,
    tags: readonly string[],
    stampUntil: number,
  ) => Promise<number>;
  /** Reads the invalidation stamps of `tags`: tag → when it was invalidated (epoch ms). Live stamps only. */
  getStamps: (
    ns: string,
    tags: readonly string[],
  ) => Promise<Map<string, number>>;
  /** Writes invalidation stamps: each tag invalidated at `at`, the stamp kept until `until` (epoch ms). */
  setStamps: (
    ns: string,
    tags: readonly string[],
    at: number,
    until: number,
  ) => Promise<void>;
  /**
   * Adds `by` to the counter at `key`, atomically, and answers the new value.
   * `expiresAt` applies only when the counter is created, so a rate-limit
   * window does not slide (§3.8).
   */
  increment?: (
    ns: string,
    key: string,
    by: number,
    expiresAt: number | null,
  ) => Promise<number>;
  /** Reads a counter, with its hard expiry; `undefined` when the key holds no counter. Required when `atomicIncrement` is advertised, so `get` on a counter key can answer. */
  getCounter?: (
    ns: string,
    key: string,
  ) => Promise<
    { value: number; expiresAt: number | null; createdAt: number } | undefined
  >;
  /** Takes a lock on `key` for `owner`, expiring in `ttlMs`; `false` when someone else holds it. */
  acquireLock?: (
    ns: string,
    key: string,
    owner: string,
    ttlMs: number,
  ) => Promise<boolean>;
  /** Releases the lock on `key` only when `owner` holds it; answers whether it did. */
  releaseLock?: (ns: string, key: string, owner: string) => Promise<boolean>;

  /** Deletes expired rows, at most `limit` of them; answers how many went. Called by the core on `sweepInterval`. Optional. */
  sweep?: (now: number, limit: number) => Promise<number>;
  /** Publishes a bus message (the multi-tier bus is a later PR). Optional. */
  publish?: (message: BusMessage) => Promise<void>;
  /** Subscribes to the bus; answers an unsubscribe function. `onGap` signals a missed stretch of the log. Optional. */
  subscribe?: (
    onMessage: (message: BusMessage) => void,
    onGap: () => void,
  ) => Promise<() => Promise<void>>;
  /** Registers a listener for driver-side evictions (the memory driver's LRU and size caps). Optional. */
  onEviction?: (
    listener: (ns: string, key: string, reason: string) => void,
  ) => void;
  /** Creates or migrates the backend's schema. v1 drivers answer `[]`: the schema is new, there is nothing to sync (§7.4). */
  syncSchema?: (options?: SchemaSyncOptions) => Promise<SchemaChange[]>;
}

/**
 * The minimal driver shape {@link fromSimpleDriver} wraps into a full
 * {@link CacheDriver} (§7.9): single-key `get`/`set`/`delete`, optional
 * `clear`. The wrapper adds the batch loops and stores tag stamps as ordinary
 * entries, so a three-method driver still gets correct lazy tags.
 */
export interface SimpleCacheDriver {
  /** The backend's name; defaults to `"simple"`. */
  name?: string;
  /** Capability overrides; the wrapper's defaults describe a least-capable store. */
  capabilities?: Partial<CacheDriverCapabilities>;
  /** Reads one entry; `undefined` on a miss. */
  get: (ns: string, key: string) => Promise<StoredEntry | undefined>;
  /** Writes one entry. */
  set: (ns: string, entry: StoredEntry) => Promise<void>;
  /** Deletes one entry; answers whether it existed. */
  delete: (ns: string, key: string) => Promise<boolean>;
  /** Deletes every entry of one namespace. Optional. */
  clear?: (ns: string) => Promise<void>;
  /** Closes what the driver created. Optional. */
  close?: () => Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Codecs (§3.10)                                                     */
/* ------------------------------------------------------------------ */

/**
 * A value codec. Ids 0–127 are reserved for the package (`1` structured
 * clone, `2` JSON, `3` raw); a custom codec uses 128–255. The id is stored in
 * each entry's header, so entries written with different codecs coexist, and
 * a value whose codec the cache does not know decodes as a miss (§3.2).
 */
export interface Codec {
  /** The id stored in the entry header: 128–255 for a custom codec. */
  id: number;
  /** Encodes a value. */
  encode: (value: unknown) => Uint8Array;
  /** Decodes what {@link encode} wrote. */
  decode: (bytes: Uint8Array) => unknown;
}

/** How entries are compressed once their encoded size passes a threshold (§3.11). */
export interface CompressOptions {
  /** The algorithm; defaults to `"zstd"`. */
  algorithm?: "zstd" | "gzip";
  /** Compress at or above this many encoded bytes; defaults to 16 KiB. An entry is compressed only when that makes it smaller. */
  threshold?: number;
  /** The algorithm's level (zstd 1–22, gzip 0–9); the library's default when unset. */
  level?: number;
}

/* ------------------------------------------------------------------ */
/* Events and statistics (§3.12)                                      */
/* ------------------------------------------------------------------ */

/** The phases an `error` event reports. */
export type CacheErrorPhase =
  "driver" | "decode" | "validate" | "refresh" | "lock";

/** Why a `fenced` event's write was dropped: the driver's tag fence, or a local delete/clear/invalidation that forgot the flight (§3.4, §3.6). */
export type CacheFencedReason = "fence" | "local";

/** The events a cache emits (§3.12). Listeners are synchronous and isolated: a throwing one is logged, never breaks the operation. */
export interface CacheEventMap {
  /** A read found a fresh entry. */
  hit: { key: string; namespace: string };
  /** A stale entry was served (inside its stale-while-revalidate window, or after a soft timeout). */
  "stale-hit": { key: string; namespace: string };
  /** A read found nothing usable (absent, expired, undecodable, invalidated, or refused by `validate`). */
  miss: { key: string; namespace: string };
  /** An entry was stored. */
  set: { key: string; namespace: string; bytes: number };
  /**
   * A loaded value was not stored because an invalidation won the race
   * (§3.4, §3.6). The value is still returned to its loader's caller.
   */
  fenced: {
    key: string;
    namespace: string;
    /** The tags the dropped entry would have carried (empty for an untagged write). */
    tags: readonly string[];
    /**
     * Who refused the write. `"fence"`: the driver's tag fence — one of
     * `tags` was invalidated after the load started, by any cache on the
     * driver, in this process or another. `"local"`: a `delete`,
     * `deleteMany`, `clear`, `invalidateTags` or `increment` on this cache,
     * in the load's own namespace, ran while the load ran and forgot the
     * flight; the write is dropped before it reaches the driver, tagged or
     * not, and whichever tags were invalidated.
     */
    reason: CacheFencedReason;
  };
  /** A key was deleted. */
  delete: { key: string; namespace: string };
  /** Tags were invalidated. */
  invalidate: { namespace: string; tags: readonly string[] };
  /** A loader ran. `shared` is true when other callers joined the same flight (§3.4). */
  load: { key: string; namespace: string; duration: number; shared: boolean };
  /** A background refresh stored a fresh value. */
  refresh: { key: string; namespace: string; duration: number };
  /** A loader failed or hard-timed out and the stale value was served instead (§3.5). */
  "stale-if-error": { key: string; namespace: string; error: unknown };
  /** A `getOrSet` with `lock` found the lock held and started waiting. */
  "lock-wait": { key: string; namespace: string };
  /** Waiting on a lock gave up (the waiter loads itself without storing, or throws). */
  "lock-timeout": { key: string; namespace: string };
  /** The driver evicted an entry (the memory driver's LRU and size caps). */
  evict: { key: string; namespace: string; reason: string };
  /** A `set` encoded above `maxEntryBytes` and was skipped (§3.9). */
  oversize: { key: string; namespace: string; bytes: number; limit: number };
  /** Something failed: a driver operation, a decode, a `validate` refusal, a background refresh. */
  error: {
    key?: string;
    namespace?: string;
    phase: CacheErrorPhase;
    driver: string;
    error: unknown;
    /** The issues a `validate` refusal produced, each with `target: "cache"` and value-free (V10). */
    issues?: readonly ValidationIssue[];
  };
  /** A driver's circuit opened after too many consecutive failures (§3.14). */
  "circuit-open": { driver: string; failures: number };
  /** A driver's circuit closed again after a successful probe. */
  "circuit-close": { driver: string };
}

/** The event names a cache emits. */
export type CacheEvent = keyof CacheEventMap;

/** The load-duration percentiles of {@link CacheStats}, over a rolling 60 s window. */
export interface CacheLoadDurations {
  /** How many loads the window holds. */
  count: number;
  /** The median load, in ms; 0 with no samples. */
  p50: number;
  /** The 95th percentile, in ms; 0 with no samples. */
  p95: number;
  /** The 99th percentile, in ms; 0 with no samples. */
  p99: number;
}

/** What {@link Cache.stats} returns (§3.12). */
export interface CacheStats {
  /** Fresh reads served. */
  hits: number;
  /** Stale reads served. */
  staleHits: number;
  /** Reads that found nothing usable. */
  misses: number;
  /** Entries stored. */
  sets: number;
  /** Loaded values not stored because an invalidation won the race: every `fenced` event, whatever its `reason`. */
  fenced: number;
  /** Keys deleted (delete, deleteMany, clear, tag invalidation). */
  deletes: number;
  /** Loader runs. */
  loads: number;
  /** Loader failures (throws, rejections, hard timeouts). */
  loadErrors: number;
  /** `getOrSet` calls that waited on a cross-process lock. */
  lockWaits: number;
  /** Driver-side evictions reported through `onEviction`. */
  evictions: number;
  /** Encoded bytes read from the driver. */
  bytesRead: number;
  /** Encoded bytes written to the driver. */
  bytesWritten: number;
  /** `hits / (hits + misses)`; 0 before any read. */
  hitRate: number;
  /** Load-duration percentiles over a rolling 60 s window. */
  loadDurations: CacheLoadDurations;
}

/* ------------------------------------------------------------------ */
/* The cache API (§3.1)                                               */
/* ------------------------------------------------------------------ */

/** A decoded entry, as {@link Cache.getEntry} returns it. */
export interface CacheEntry<V = unknown> {
  /** The key, as passed to `set` (no namespace). */
  key: string;
  /** The decoded value; `undefined` for a cached negative (`cacheUndefined`). */
  value: V;
  /** When the value was produced (the loader's start), epoch ms. */
  createdAt: number;
  /** When it stops being fresh, epoch ms; `null` when it never expires. */
  freshUntil: number | null;
  /** When the entry is gone for good, epoch ms; `null` when it never expires. */
  expiresAt: number | null;
  /** Its tags. */
  tags: readonly string[];
  /** Past `freshUntil` but still inside its stale window. */
  stale: boolean;
}

/** Per-call or per-cache write options. Durations are milliseconds; `ttl: null` means no expiry. */
export interface SetOptions<Tag extends string = string> {
  /** Fresh-for this long, in ms; `null` never expires. Defaults to the cache's `ttl`. Exclusive with `expiresAt`. */
  ttl?: number | null;
  /** Fresh until this instant (epoch ms or a `Date`). Exclusive with `ttl`. */
  expiresAt?: number | Date | null;
  /** The entry's tags, for {@link Cache.invalidateTags}. */
  tags?: readonly Tag[];
  /** After freshness, serve stale for this long while refreshing in the background (§3.5). Defaults to the cache's. */
  staleWhileRevalidate?: number;
  /** Serve stale for this long when the loader fails (§3.5). Defaults to the cache's. */
  staleIfError?: number;
  /** Spread this entry's TTL by up to ± this fraction (`0.1` = ±10%), so bulk-written entries do not expire together. Defaults to the cache's `jitter` (0). */
  jitter?: number;
}

/** How a cross-process lock wait behaves (§3.4). */
export interface CacheLockOptions {
  /** The lock's TTL, in ms; defaults to 30 s, or the hard timeout when that is shorter… never below 1 s. */
  ttl?: number;
  /** How a process that lost the lock waits. */
  wait?: {
    /** Poll the key this often, in ms; defaults to 50. */
    interval?: number;
    /** Give up after this long, in ms; defaults to 5000. Then `onLockTimeout` decides. */
    timeout?: number;
  };
}

/** Per-call or per-cache `getOrSet` options, on top of {@link SetOptions}. */
export interface GetOrSetOptions<
  Tag extends string = string,
> extends SetOptions<Tag> {
  /**
   * Take a cross-process lock on the key before loading (§3.4), on drivers
   * with `capabilities.lock`; `true` for the defaults. On a driver without
   * locks, one `warn` is logged per cache and the in-process single-flight
   * still applies.
   */
  lock?: boolean | CacheLockOptions;
  /** What a process that lost the lock does after `wait.timeout`: load itself without storing (`"load"`, the default), or throw `LoaderTimeoutError` (`"throw"`). */
  onLockTimeout?: "load" | "throw";
  /**
   * Aborts waiting. The loader's own signal aborts only when *every* waiting
   * caller has aborted (§3.4), so one impatient caller cannot cancel work
   * others wait on.
   */
  signal?: AbortSignal;
  /** When a stale value exists and the loader outlasts this, return the stale value now and let the loader finish in the background (§3.5). */
  softTimeout?: number;
  /** Stop waiting on the loader after this and throw `LoaderTimeoutError`; stale-if-error still applies (§3.5). */
  hardTimeout?: number;
  /** Eager refresh: a hit in the last fraction of the TTL (`0.2` = the last fifth) refreshes in the background while the hit is served. Off by default. */
  refreshAhead?: number;
  /** Probabilistic early expiration (XFetch, §3.5): recompute when `now - loadMs * beta * ln(rand()) >= freshUntil`. Off by default. */
  earlyExpiry?: { beta: number };
  /** Cache a loader's `undefined` as a negative marker. Defaults to the cache's `cacheUndefined` (`false`). */
  cacheUndefined?: boolean;
  /** The negative marker's TTL, in ms; defaults to the entry's own TTL. */
  negativeTtl?: number;
}

/** What a `getOrSet` loader receives. */
export interface CacheLoaderContext {
  /** Aborts when every waiting caller aborted, or on the hard timeout. */
  signal: AbortSignal;
}

/** A `getOrSet` loader: produces the value, or `undefined` for a negative (not cached unless `cacheUndefined`). */
export type CacheLoader<V = unknown> = (
  context: CacheLoaderContext,
) => V | undefined | Promise<V | undefined>;

/** What a key pattern in `createCache`'s `validate` becomes as a schema key: a trailing `*` widens to `string`. */
export type CachePatternKey<Pattern extends string = string> =
  Pattern extends `${infer Head}*` ? `${Head}${string}` : Pattern;

/**
 * The `Cache` schema implied by a `validate` map (bun-validate's V10):
 * `CacheSchemaFrom<{ "user:*": typeof UserSchema }>` is
 * `{ [k: \`user:${string}\`]: User }` when `UserSchema` outputs `User`.
 */
export type CacheSchemaFrom<
  M extends Record<string, StandardSchemaV1> = Record<string, StandardSchemaV1>,
> = {
  [
    P in keyof M as CachePatternKey<Extract<P, string>>
  ]: StandardSchemaV1.InferOutput<M[P]>;
};

/** The schema a cache with `codec: "json"` truthfully has: JSON's view of every value (§3.13). */
export type JsonifySchema<
  Schema extends Record<string, unknown> = Record<string, unknown>,
> = {
  [K in keyof Schema]: Jsonify<Schema[K]>;
};

/** The schema constraint of {@link Cache}: key pattern → value type. */
export type CacheSchema = Record<string, unknown>;

/** The keys of `Schema` whose value is a number (the only keys `increment` accepts). Untyped schemas allow every key. */
export type CacheCounterKeys<Schema extends CacheSchema = CacheSchema> =
  string extends keyof Schema
    ? string
    : {
        [K in Extract<keyof Schema, string>]: Schema[K] extends number
          ? K
          : never;
      }[Extract<keyof Schema, string>];

/**
 * The cache (§3.1). `Schema` maps key patterns — literals and template
 * literals — to value types; `Tag` narrows the tags. Both default to
 * untyped: `Cache` is `Cache<Record<string, unknown>, string>`.
 */
export interface Cache<
  Schema extends CacheSchema = Record<string, unknown>,
  Tag extends string = string,
> {
  /** The full namespace prefix this view stores under (`"app"`, `"app:users"`), including any `version`. */
  /** Reads a fresh value; `undefined` on a miss. A stale entry is a miss here — `getEntry` exposes it. */
  get: <K extends Extract<keyof Schema, string>>(
    key: K,
  ) => Promise<Schema[K] | undefined>;
  /** Reads an entry with its metadata, stale ones included (within their hard expiry). */
  getEntry: <K extends Extract<keyof Schema, string>>(
    key: K,
  ) => Promise<CacheEntry<Schema[K]> | undefined>;
  /** Whether a fresh entry (or a live counter) exists. */
  has: <K extends Extract<keyof Schema, string>>(key: K) => Promise<boolean>;
  /** Reads several keys, in order, `undefined` per miss. */
  getMany: <K extends Extract<keyof Schema, string>>(
    keys: readonly K[],
  ) => Promise<(Schema[K] | undefined)[]>;

  /** Writes a value; `false` when the write was skipped (oversize, fenced, or a driver failure under the default policy). */
  set: <K extends Extract<keyof Schema, string>>(
    key: K,
    value: Schema[K],
    options?: SetOptions<Tag>,
  ) => Promise<boolean>;
  /** Writes several entries; answers how many were stored. */
  setMany: <K extends Extract<keyof Schema, string>>(
    entries: readonly (readonly [
      K,
      Schema[K],
      (SetOptions<Tag> | undefined)?,
    ])[],
  ) => Promise<number>;
  /** Refreshes a key's TTL without changing its value; `false` when the key is absent. */
  touch: <K extends Extract<keyof Schema, string>>(
    key: K,
    ttl: number | null,
  ) => Promise<boolean>;

  /** Deletes a key; `true` when something was there. */
  delete: <K extends Extract<keyof Schema, string>>(key: K) => Promise<boolean>;
  /** Deletes several keys; answers how many were there. */
  deleteMany: <K extends Extract<keyof Schema, string>>(
    keys: readonly K[],
  ) => Promise<number>;
  /** Deletes every entry of this namespace (never the whole backend). */
  clear: () => Promise<void>;
  /**
   * Invalidates every entry carrying any of `tags` (§3.6). `mode: "stale"`
   * (a soft purge) is a later PR and throws `UnsupportedOperationError` today.
   */
  invalidateTags: (
    tags: readonly Tag[],
    options?: { mode?: "delete" | "stale" },
  ) => Promise<void>;

  /**
   * Reads the key, and on a miss runs `loader` — once, however many callers
   * asked at the same time (§3.4). A loader's throw rejects every waiter with
   * the one error and is never cached; a loader's `undefined` is not cached
   * unless `cacheUndefined`.
   */
  getOrSet: <K extends Extract<keyof Schema, string>>(
    key: K,
    loader: CacheLoader<Schema[K]>,
    options?: GetOrSetOptions<Tag>,
  ) => Promise<Schema[K] | undefined>;
  /** Wraps `fn` so identical calls share one run and its cached result; `key` receives `fn`'s own arguments (§3.4). */
  wrap: <Args extends unknown[], K extends Extract<keyof Schema, string>>(
    fn: (...args: Args) => Promise<Schema[K]>,
    options: {
      /** Builds the cache key from `fn`'s arguments. */
      key: (...args: Args) => K;
    } & GetOrSetOptions<Tag>,
  ) => (...args: Args) => Promise<Schema[K] | undefined>;

  /** Adds to a counter, atomically; answers the new value. The TTL is set only when the counter is created (§3.8). */
  increment: <K extends CacheCounterKeys<Schema>>(
    key: K,
    by?: number,
    options?: { ttl?: number | null },
  ) => Promise<number>;
  /** Subtracts from a counter; `increment(key, -by)`. */
  decrement: <K extends CacheCounterKeys<Schema>>(
    key: K,
    by?: number,
    options?: { ttl?: number | null },
  ) => Promise<number>;

  /** A view of the same cache under a longer namespace: `cache.namespace("users")` on `"app"` stores `app:users:*` (§3.7). */
  namespace: (name: string) => Cache<Schema, Tag>;

  /** Listens for an event; answers an unsubscribe function. */
  on: <E extends CacheEvent>(
    event: E,
    listener: (payload: CacheEventMap[E]) => void,
  ) => () => void;
  /** The counters (§3.12); `stats({ reset: true })` reads and zeroes them. */
  stats: (options?: { reset?: boolean }) => CacheStats;

  /** Stops the sweeper and closes the driver. Idempotent. */
  close: () => Promise<void>;
  /** Creates or migrates the driver's schema; `[]` when the driver has nothing to sync. */
  syncSchema: (options?: SchemaSyncOptions) => Promise<SchemaChange[]>;
}

/* ------------------------------------------------------------------ */
/* createCache's options                                              */
/* ------------------------------------------------------------------ */

/** `createCache`'s options (§3.1). */
export interface CreateCacheOptions {
  /** The driver to store through — `memoryDriver()`, a future built-in, or a custom {@link CacheDriver}. */
  driver: CacheDriver;
  /** Every key is stored under this namespace; `cache.namespace("x")` extends it. Defaults to `"cache"`. */
  namespace?: string;
  /** A version that joins the namespace (`app@v3:`): a deploy that changes a value's shape bumps it instead of flushing (§3.7). */
  version?: string;
  /** The default TTL in ms; `null` means no expiry; a function computes it per value (§3.1). */
  ttl?: number | null | ((value: unknown) => number | null);
  /** The value codec (§3.10): `"structured"` (the default, `bun:jsc`), `"json"`, `"raw"`, or a custom {@link Codec}. */
  codec?: "structured" | "json" | "raw" | Codec;
  /** Compress entries whose encoded size passes the threshold (§3.11); `false` disables. Defaults to zstd above 16 KiB. */
  compress?: false | CompressOptions;
  /** The encoded size cap per entry, in bytes; defaults to 4 MiB, capped by the driver's own limit. Oversize writes resolve `false` with an `oversize` event. */
  maxEntryBytes?: number;
  /** Keys longer than this many bytes are stored as `#` + their SHA-256 (§3.7). Defaults to 200. */
  maxKeyLength?: number;

  /** Default stale-while-revalidate window, in ms (§3.5). Defaults to 0. */
  staleWhileRevalidate?: number;
  /** Default stale-if-error window, in ms (§3.5). Defaults to 0. */
  staleIfError?: number;
  /** Default soft loader timeout, in ms (§3.5). Off by default. */
  softTimeout?: number;
  /** Default hard loader timeout, in ms (§3.5). Off by default. */
  hardTimeout?: number;
  /** Default eager-refresh fraction (§3.5). Off by default. */
  refreshAhead?: number;
  /** Default probabilistic early expiration (§3.5). Off by default. */
  earlyExpiry?: { beta: number };
  /** Spread every TTL by up to ± this fraction (§3.3). Defaults to 0. */
  jitter?: number;
  /** Cache loaders' `undefined` results as negative markers (§3.4). Defaults to `false`. */
  cacheUndefined?: boolean;
  /** The default TTL of negative markers, in ms; the entry's own TTL when unset. */
  negativeTtl?: number;
  /** After a failed refresh, the stale value's freshness is pushed forward by this, in ms (§3.5). Defaults to 10 s. */
  failSafeBackoff?: number;
  /** How long an invalidation stamp lives, in ms (§3.6). Defaults to the cache's longest TTL, capped at 24 h. */
  tagStampTtl?: number;
  /** How long a stamps-mode driver caches tag stamps in process, in ms (§3.6). Defaults to 1000. */
  tagStampCacheMs?: number;

  /** How often the core calls the driver's `sweep`, in ms; 0 disables. Defaults to 60 s. */
  sweepInterval?: number;
  /** A timeout around every driver operation, in ms; off by default (the memory driver is synchronous). */
  timeout?: number;
  /** Throw on driver failures instead of degrading to misses and `false` (§3.14). Defaults to `false`. */
  strict?: boolean;
  /** Open the circuit after this many consecutive driver failures, for `cooldown` ms (§3.14). Defaults to 5 and 30 s. */
  circuit?: { failures?: number; cooldown?: number };

  /**
   * Runtime-checked reads (bun-validate's V10): a map of key patterns
   * (`"user:*"`, or an exact key) to any Standard Schema. A stored value that
   * fails its schema is a miss, is deleted, and emits an `error` event whose
   * issues target `"cache"`. Opt-in: it costs a schema run per hit. When it
   * is the only schema given, the cache's type is inferred from it
   * ({@link CacheSchemaFrom}).
   */
  validate?: Record<string, StandardSchemaV1>;

  /** The logger; a `LoggerLike`, resolved once with bun-common's `resolveLogger`. Defaults to a no-op. */
  logger?: LoggerLike;

  /**
   * The clock, epoch ms. Internal: for tests, with
   * `@kingsleyweb/bun-cache/testing`'s `fakeClock()`. Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * The randomness source for jitter and early expiry, in `[0, 1)`. Internal:
   * for tests. Defaults to `Math.random`.
   */
  random?: () => number;
}
