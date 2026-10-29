/**
 * The public types of `@kingsleyweb/bun-cache`: the driver contract
 * (plan §6.1), the stored-entry shape (§3.2), the cache's options and events,
 * and the typed-cache machinery (§3.13, bun-validate's V10).
 */
import type {
  CompressionEncoding,
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
  /** How the multi-tier bus (§4.2) delivers: pushed, polled, or not at all. With `"none"`, a cache's `bus: "auto"` finds no bus. */
  bus: "push" | "poll" | "none";
  /** The backend's own per-entry byte limit, when it has one; the core's `maxEntryBytes` is capped by it. */
  maxEntryBytes?: number;
}

/**
 * A message on the multi-tier bus (§4.2): what changed in the shared tier, so
 * other processes drop their L1 copies. Carries keys, never values (R13), so
 * nothing stale or oversized can arrive by it. A driver or a {@link CacheBus}
 * carries it as it is (JSON), every field included.
 */
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
  /**
   * Which cache published it: an id per `createCache` call, so a cache skips
   * its own messages (its L1 is already up to date) and acts on every other
   * cache's, in this process or another. Absent on a message from a publisher
   * that sets none; such a message is always acted on.
   */
  origin?: string;
}

/**
 * The multi-tier bus on its own (§4.2), separable from the driver: `bus:
 * redisBus(url)` or `bus: pgBus(url)` on `createCache` replaces the driver's
 * own bus — S3 as the shared tier with a Redis bus, for instance. Delivery is
 * at most once; a subscriber that may have missed messages is told so through
 * `onGap`, and flushes its whole L1.
 */
export interface CacheBus {
  /** The bus's name, for events and logs (`"redis"`, `"postgres"`). */
  readonly name: string;
  /** Publishes a message to every subscriber, this process's included. */
  publish: (message: BusMessage) => Promise<void>;
  /**
   * Subscribes; answers an unsubscribe function. `onGap` is called whenever
   * messages may have been lost — a reconnect, a pruned or truncated log.
   */
  subscribe: (
    onMessage: (message: BusMessage) => void,
    onGap: () => void,
  ) => Promise<() => Promise<void>>;
  /** Closes what the bus created (never a client it was given). Idempotent; the cache's `close()` calls it. */
  close: () => Promise<void>;
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
  /** Publishes a bus message (§4.2); a cache's `bus: "auto"` uses it with {@link subscribe}. Optional. */
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
  /**
   * Registers a listener for a combinator's member events (`redundant()`,
   * §5.4): a member's circuit opening (`member-down`), a member that missed a
   * write or delete (`member-dirty`), and a member serving reads again
   * (`member-up`). `createCache` forwards each to `cache.on`. Optional, like
   * {@link onEviction}: a driver made of no other drivers has none.
   */
  onMemberEvent?: (
    listener: <E extends CacheMemberEvent>(
      event: E,
      payload: CacheEventMap[E],
    ) => void,
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

/**
 * How entries are compressed once their encoded size passes a threshold
 * (§3.11; the encryption plan's §8). Every built-in algorithm always
 * decompresses, whatever this says, so changing `algorithm` needs no flush.
 */
export interface CompressOptions {
  /**
   * The algorithm: `"zstd"` (the default), `"gzip"`, `"br"` (Brotli) or
   * `"deflate"` (**raw** DEFLATE, RFC 1951 — not the zlib-wrapped form HTTP's
   * `deflate` means; the bytes never reach HTTP), or a user
   * {@link CacheCompressor}. `"br"`, `"deflate"` and a user compressor write
   * a format-2 entry header, which a process on a version before them reads
   * as a miss: only the deploy that turns one on sees those misses.
   */
  algorithm?: CompressionEncoding | CacheCompressor;
  /** Compress at or above this many encoded bytes; defaults to 16 KiB for every algorithm. An entry is compressed only when that makes it smaller. */
  threshold?: number;
  /**
   * The built-in algorithm's level: zstd 1–22 (default 3), gzip 0–9
   * (default 6), `br` quality 0–11 (default 4, as bun-common's response
   * compression: Brotli's own 11 is two orders of magnitude slower), deflate
   * 0–9 (default 6). Outside the range, or beside a user compressor, it is a
   * `TypeError` at `createCache`.
   */
  level?: number;
  /**
   * User compressors that still decompress: entries written by an earlier
   * {@link CacheCompressor} stay readable after `algorithm` moves on. Without
   * one, such an entry is a miss (an `error` event with `phase: "decode"`).
   * Ids must be 128–255 and differ from each other and from `algorithm`'s.
   */
  previous?: readonly CacheCompressor[];
}

/**
 * A user compressor (the encryption plan's §8.4), given as
 * {@link CompressOptions.algorithm} — a dictionary-trained zstd through
 * `node:zlib`, say. Either function may be synchronous or return a promise;
 * the core awaits only a returned promise, so a synchronous one pays nothing
 * for the option.
 */
export interface CacheCompressor {
  /**
   * Stored in each compressed entry's header: an integer in 128–255 (0–127 are
   * the package's). Entries keep the id they were written with, so a new
   * compressor takes a new id, and the old one goes in
   * {@link CompressOptions.previous} while its entries live.
   */
  id: number;
  /** Compresses an encoded payload. A result no smaller than the input is discarded, and the payload stored uncompressed. */
  compress: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  /**
   * Reverses {@link compress}. `maxOutputLength` is the cap the core enforces
   * on every decompression (`maxEntryBytes`): stop and throw past it, so a
   * planted entry cannot expand to gigabytes. A longer result is refused
   * anyway, as a miss, but only after it was built.
   */
  decompress: (
    bytes: Uint8Array,
    maxOutputLength: number,
  ) => Uint8Array | Promise<Uint8Array>;
}

/* ------------------------------------------------------------------ */
/* At-rest encryption (the encryption plan)                           */
/* ------------------------------------------------------------------ */

/**
 * One key of the built-in cipher's ring (the encryption plan's §5): exactly
 * 32 bytes, as a `Uint8Array` or a string that decodes to 32 bytes as hex,
 * base64 or base64url (`openssl rand -base64 32`). Anything else is a
 * `TypeError` at `createCache`. There are no passphrases.
 */
export interface CacheKey {
  /**
   * Written into every entry this key seals, so a read picks its key
   * directly: 1–32 characters of `A-Z a-z 0-9 . _ -`, unique in the ring.
   * A date (`"2026-10"`) is a good id. It is not secret.
   */
  id: string;
  /** The 32 key bytes, or their hex, base64 or base64url spelling. Secret: never logged or put in an event. */
  key: string | Uint8Array;
}

/** The built-in cipher's keys: the **first** seals new entries, and **every** key opens the entries written with it. Not empty; ids unique. */
export type CacheKeyRing = readonly CacheKey[];

/**
 * What the core hands a {@link CacheCipher} with each seal and open: the
 * entry's plaintext names and the AAD it built from them.
 */
export interface CacheCipherContext {
  /** The full namespace, plaintext (`app@v3:users`). */
  namespace: string;
  /** The full key, plaintext. */
  key: string;
  /**
   * The additional authenticated data the core built (the encryption plan's
   * §4.5): a label, the namespace, the key, `encrypt.aad` and the envelope's
   * first four bytes. The cipher **must** authenticate it, so that an entry
   * moved to another key or namespace does not open;
   * `runCacheCipherConformance` fails a cipher that does not.
   */
  aad: Uint8Array;
}

/** What `encrypt.hashNames.hash` is told about the name it hashes. */
export interface CacheNameContext {
  /** What the name is: a cache's full namespace, a key, or a tag. */
  kind: "namespace" | "key" | "tag";
  /** The full namespace, plaintext (`app@v3:users`); for a `"namespace"`, the name itself. A key or tag hashed apart per namespace keeps a dump from showing which namespaces share one. */
  namespace: string;
}

/**
 * A user cipher (the encryption plan's §6), given as
 * `encrypt.cipher` ({@link CacheEncryptOptions}) in place of the built-in
 * `"aes-256-gcm"`: a KMS, an HSM, a library cipher. Its key management is its
 * own. Either function may be synchronous or return a promise; the core
 * awaits only a returned promise. Check one with `runCacheCipherConformance`
 * from `@kingsleyweb/bun-cache/testing`.
 */
export interface CacheCipher {
  /**
   * Stored in each entry's envelope: an integer in 128–255 (1–127 are the
   * package's). Entries keep the id they were sealed with, so a new cipher
   * takes a new id and the old one goes in `encrypt.previous`
   * while its entries live.
   */
  id: number;
  /**
   * Seals `plaintext`, authenticating `context.aad`. The output is stored
   * after the envelope's four-byte prefix, as it is: it carries the cipher's
   * own key id, nonce and tag. Two seals of one input must differ (a random
   * nonce).
   */
  seal: (
    plaintext: Uint8Array,
    context: CacheCipherContext,
  ) => Uint8Array | Promise<Uint8Array>;
  /** Opens what {@link seal} wrote, and **throws** when it does not authenticate (a changed byte, `aad`, namespace or key). A throw is a miss. */
  open: (
    sealed: Uint8Array,
    context: CacheCipherContext,
  ) => Uint8Array | Promise<Uint8Array>;
}

/**
 * `encrypt.hashNames` with the built-in HMAC: exactly one of `key` and
 * `hash`, so `hash` is typed `never` here.
 */
export interface CacheHashNamesKey {
  /** The HMAC key: 32 bytes, or their hex, base64 or base64url spelling. Secret, and never rotated. */
  key: string | Uint8Array;
  /** Not beside `key`: `hashNames` takes exactly one of the two (a `TypeError` at `createCache` otherwise). */
  hash?: never;
}

/**
 * `encrypt.hashNames` with a hash of your own: exactly one of `key` and
 * `hash`, so `key` is typed `never` here.
 */
export interface CacheHashNamesHash {
  /** Answers a name's stored form: deterministic, 1–200 bytes, no NUL or newline. */
  hash: (name: string, context: CacheNameContext) => string;
  /** Not beside `hash`: `hashNames` takes exactly one of the two (a `TypeError` at `createCache` otherwise). */
  key?: never;
}

/** What both of `encrypt`'s shapes take, whichever cipher seals. */
interface CacheEncryptCommonOptions {
  /** User ciphers that still open: entries sealed by an earlier {@link CacheCipher} stay readable after `cipher` moves on. Ids 128–255, unique. Beside the built-in's `keys` too. */
  previous?: readonly CacheCipher[];
  /**
   * Extra context bound into every entry's AAD — an environment (`"prod"`),
   * an app id — so an entry written by a cache with another `aad` does not
   * open here, even under the same key. At most 1 KiB. Default: none.
   */
  aad?: string | Uint8Array;
  /**
   * Store keys, namespaces and tags as keyed hashes, so a dump of the store
   * shows none of them (the encryption plan's §7). Default: off. It needs a
   * cipher, which both of `encrypt`'s shapes have: `keys`, or a user
   * `cipher`.
   *
   * - `{ key }`: HMAC-SHA-256 under this key — 32 bytes, or their hex,
   *   base64 or base64url spelling — answering 32 hex characters per name,
   *   each key and tag bound to its namespace. Its own key: **never** one of
   *   `keys`, and never rotated. Changing it, or turning hashing on, is a
   *   flush: the old entries sit under names nobody asks for any more until
   *   they expire (`clear()` first, or accept the orphans).
   * - `{ hash }`: a function of your own (to match an existing scheme). It
   *   must be deterministic and answer 1–200 bytes with no NUL or newline;
   *   both are checked on first use (a `TypeError`).
   *
   * Exactly one of the two: both, or neither, is a compile error (and a
   * `TypeError` at `createCache`).
   *
   * The drivers, L1, the bus, the stamp cache and the core's log lines all
   * see the hashed names; events keep the plaintext ones, except `evict`,
   * which only the driver knows. Counters' names are hashed, their values
   * not. `cache.describeKey(key, tags)` answers the stored forms, to find an
   * entry in a dump. The long-key hashing (`maxKeyLength`) does not apply.
   */
  hashNames?: CacheHashNamesKey | CacheHashNamesHash;
  /**
   * Read entries written without encryption, during a migration. Writes are
   * always sealed. Off by default, and best left off: while it is on,
   * anyone who can write to the store can plant a plaintext value the cache
   * serves.
   */
  acceptUnencrypted?: boolean;
}

/** `encrypt` with a user {@link CacheCipher}: it manages its own keys, so `keys` and `keyRefresh` are typed `never`. */
export interface CacheEncryptWithCipher extends CacheEncryptCommonOptions {
  /** Not beside a user cipher, which manages its own keys (a `TypeError` at `createCache` otherwise). `keys` belongs to the built-in `"aes-256-gcm"`. */
  keys?: never;
  /** Not beside a user cipher: it refreshes a `keys` function, which only the built-in takes (a `TypeError` at `createCache` otherwise). */
  keyRefresh?: never;
  /** The user cipher that seals, in place of the built-in `"aes-256-gcm"`: a KMS, an HSM, a library cipher. Ids 128–255. */
  cipher: CacheCipher;
}

/** `encrypt` with the built-in `"aes-256-gcm"`: `keys` is required. */
export interface CacheEncryptWithKeys extends CacheEncryptCommonOptions {
  /**
   * The built-in cipher's keys: the first seals, all open. Or a function
   * answering them, or a promise of them (a KMS, Vault): called on first use
   * — operations wait for it, a read at most `timeout` — then every
   * `keyRefresh` ms, and early (at most once per 10 s) when a read meets an
   * unknown key id. A rejection, or an invalid ring, is an `error` event and
   * the previous ring stays. Required by the built-in, and refused beside a
   * user {@link CacheCipher} (`encrypt`'s other shape).
   */
  keys: CacheKeyRing | (() => CacheKeyRing | Promise<CacheKeyRing>);
  /** Re-call a `keys` function after this many ms (checked as operations run). Default: never after the first answer; an unknown key id still triggers one refresh per 10 s. Only with a `keys` function (a `TypeError` beside a static ring). */
  keyRefresh?: number;
  /** `"aes-256-gcm"`, the default: `node:crypto`, a key per entry by HKDF from a random 128-bit salt, a 96-bit nonce. A user {@link CacheCipher} is `encrypt`'s other shape. */
  cipher?: "aes-256-gcm";
}

/**
 * `createCache`'s `encrypt` option (the encryption plan's §10): every entry is
 * sealed — its header, full key, payload, tags and hard expiry — with
 * AES-256-GCM under a key derived per entry, or with a user cipher. Order on
 * write: encode → compress → encrypt; on read the reverse. Counters stay
 * plaintext integers (the backend adds to them). Names (keys, namespaces,
 * tags) stay in clear in the store unless `hashNames` is on.
 *
 * One of two shapes, so a cache cannot be configured without a cipher:
 * `{ keys, cipher?: "aes-256-gcm", keyRefresh? }` for the built-in, or
 * `{ cipher: CacheCipher }` for a user cipher, with no `keys`. Either takes
 * `previous`, `aad`, `hashNames` and `acceptUnencrypted`. Neither `keys` nor
 * a user `cipher`, or both, is a compile error (and a `TypeError` at
 * `createCache`, for JavaScript callers and casts).
 */
// The order and the names are the error message's: given neither `keys` nor
// `cipher`, tsc 6 and `bun check` both report the union's last shape, and
// "Property 'keys' is missing ... in type 'CacheEncryptWithKeys'" is the fix
// most callers need. tsc 6 orders the shapes as declared, `bun check` by
// name; both put this one last (measured 2026-10-29: renaming it to sort
// first, or declaring it first, makes that checker name `cipher` instead).
export type CacheEncryptOptions = CacheEncryptWithCipher | CacheEncryptWithKeys;

/* ------------------------------------------------------------------ */
/* Events and statistics (§3.12)                                      */
/* ------------------------------------------------------------------ */

/** The phases an `error` event reports. `"encrypt"`: a write could not seal (it resolved `false`); `"decrypt"`: an entry did not open (a miss; its error is a `CacheDecryptError`). */
export type CacheErrorPhase =
  | "driver"
  | "decode"
  | "validate"
  | "refresh"
  | "lock"
  | "bus"
  | "encrypt"
  | "decrypt";

/** Why a `fenced` event's write was dropped: the driver's tag fence, or a local delete/clear/invalidation that forgot the flight (§3.4, §3.6). */
export type CacheFencedReason = "fence" | "local";

/** The events a cache emits (§3.12). Listeners are synchronous and isolated: a throwing one is logged, never breaks the operation. */
export interface CacheEventMap {
  /** A read found a fresh entry. */
  hit: {
    key: string;
    namespace: string;
    /** Which tier served it: `"l1"`, the process's own memory tier (§4.1), or `"l2"`, the driver. Always `"l2"` without an L1. */
    tier: "l1" | "l2";
    /** The id of the ring key that sealed the entry, on an encrypted cache's built-in cipher: watch an old key drain before dropping it. Absent otherwise. */
    keyId?: string;
  };
  /** A stale entry was served (inside its stale-while-revalidate window, or after a soft timeout). */
  "stale-hit": {
    key: string;
    namespace: string;
    /** As on `hit`: the id of the ring key that sealed the entry, when there is one. */
    keyId?: string;
  };
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
  invalidate: {
    namespace: string;
    tags: readonly string[];
    /** How: `"delete"` removed the entries, `"stale"` (a soft purge, R21) marked them stale. */
    mode: "delete" | "stale";
  };
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
  /** The driver evicted an entry (the memory driver's LRU and size caps). Its `key` and `namespace` are the stored forms the driver holds: hashed under `encrypt.hashNames`, `#`-hashed for a long key. */
  evict: { key: string; namespace: string; reason: string };
  /** A `set` encoded above `maxEntryBytes`, stored or before compression, and was skipped (§3.9); `bytes` is the larger of the two sizes. */
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
  /** A `redundant()` member's own circuit opened (§5.4): it gets no reads or writes until a `ping()` probe closes it. */
  "member-down": {
    /** The combinator's `name`. */
    driver: string;
    /** The member's position in the `redundant([...])` list; 0 is the primary. */
    index: number;
    /** The member's own driver `name`. */
    member: string;
    /** The consecutive failures or timeouts that opened it (1 for a failed `connect`). */
    failures: number;
  };
  /** A `redundant()` member serves reads again (§5.4): its circuit closed after a probe, or a member marked dirty was emptied. */
  "member-up": {
    /** The combinator's `name`. */
    driver: string;
    /** The member's position; 0 is the primary. */
    index: number;
    /** The member's own driver `name`. */
    member: string;
    /** Whether it was emptied first: it rejoined empty because it had missed a write or delete (§5.3). */
    cleared: boolean;
  };
  /**
   * A `redundant()` member missed a write or delete (§5.3): reads skip it
   * until it has been emptied (`clear()` of every namespace the combinator
   * wrote to in this process), and then `member-up` follows. Emitted once
   * per episode, for the first miss.
   */
  "member-dirty": {
    /** The combinator's `name`. */
    driver: string;
    /** The member's position; 0 is the primary. */
    index: number;
    /** The member's own driver `name`. */
    member: string;
    /** The operation it missed (`"set"`, `"delete"`, `"deleteByTags"`, …). */
    op: string;
    /** Why: its circuit was open (`"down"`), the call failed or timed out (`"failed"`), or `write: "primary"`'s replication queue was full (`"overflow"`). */
    reason: "down" | "failed" | "overflow";
  };
}

/** The events a driver made of other drivers reports through {@link CacheDriver.onMemberEvent} (`redundant()`, §5.4). */
export type CacheMemberEvent = "member-down" | "member-up" | "member-dirty";

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
  /**
   * The L1 tier's own counts (§4.1, §3.12), present only when the cache has
   * an L1. The top-level `hits` include L1's; `hits - l1.hits` were served by
   * the driver.
   */
  l1?: {
    /** Fresh reads L1 served. */
    hits: number;
    /** Reads L1 could not serve, which went on to the driver (`tier: "l2"` reads are not counted). */
    misses: number;
    /** Entries copied into L1 from a driver read. */
    backfills: number;
    /** L1 entries dropped because their key, tag or namespace changed (here, or on the bus). */
    invalidations: number;
    /** L1 entries dropped to stay under `l1.maxEntries` / `l1.maxBytes`. */
    evictions: number;
    /** Whole-L1 flushes: a bus gap, or the bus (re)subscribing. */
    flushes: number;
    /** Entries L1 holds now (not reset by `reset`). */
    entries: number;
    /** The decoded payload bytes L1 holds now (not reset by `reset`). */
    bytes: number;
  };
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
  /**
   * `"l2"`: this call bypasses the L1 tier (§4.3) — it neither reads nor
   * fills L1, so it sees the driver's value, not a copy another process may
   * not have invalidated yet. A write still drops this process's L1 copy and
   * publishes on the bus. A no-op without an L1.
   */
  tier?: "l2";
  /**
   * `false`: store this value uncompressed, whatever the cache's `compress`
   * says — for bytes already compressed (images, archives), where gzip,
   * deflate and Brotli would spend up to 20 ms per MiB before discarding
   * their result, and for a value mixing a secret with attacker-chosen text,
   * whose compressed length would leak the secret (the CRIME/BREACH class).
   * A `touch` or a fail-safe rewrite keeps such an entry uncompressed.
   */
  compress?: false;
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
  /**
   * Keeps this load's value out of the cache: it is still returned to every
   * caller sharing the flight, and nothing is written (no `set`, no
   * `fenced`). On a background refresh the stale entry stays as it was.
   * For a value only the loader can judge (Spring's `unless`, a response
   * that says `no-store`); a negative is simpler as `undefined`.
   */
  noStore: () => void;
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
    options?: {
      /** `"l2"`: read the driver, bypassing (and not filling) the L1 tier (§4.3). */
      tier?: "l2";
    },
  ) => Promise<Schema[K] | undefined>;
  /** Reads an entry with its metadata, stale ones included (within their hard expiry). */
  getEntry: <K extends Extract<keyof Schema, string>>(
    key: K,
    options?: {
      /** `"l2"`: read the driver, bypassing (and not filling) the L1 tier (§4.3). */
      tier?: "l2";
    },
  ) => Promise<CacheEntry<Schema[K]> | undefined>;
  /** Whether a fresh entry (or a live counter) exists. */
  has: <K extends Extract<keyof Schema, string>>(
    key: K,
    options?: {
      /** `"l2"`: read the driver, bypassing (and not filling) the L1 tier (§4.3). */
      tier?: "l2";
    },
  ) => Promise<boolean>;
  /** Reads several keys, in order, `undefined` per miss. */
  getMany: <K extends Extract<keyof Schema, string>>(
    keys: readonly K[],
    options?: {
      /** `"l2"`: read the driver, bypassing (and not filling) the L1 tier (§4.3). */
      tier?: "l2";
    },
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
   * Invalidates every entry carrying any of `tags` (§3.6).
   *
   * `mode: "delete"` (the default) removes them. `mode: "stale"` is a soft
   * purge (R21, Fastly's): the entries stay, but stop being fresh at the
   * purge — `get` and `has` miss them, `getEntry` answers them `stale`,
   * `getOrSet` serves them within `staleWhileRevalidate` (refreshing) or
   * `staleIfError` (when the loader fails), counted from the purge, and a
   * refresh replaces them. Their hard expiry is not shortened. A load that
   * began before the purge still stores, and reads stale. Needs
   * `softPurge: true` on the cache, on every driver; throws
   * `UnsupportedOperationError` without it. A process on an older version
   * serves soft-purged entries as fresh until they expire (rolling deploys).
   */
  invalidateTags: (
    tags: readonly Tag[],
    options?: { mode?: "delete" | "stale" },
  ) => Promise<void>;

  /**
   * Reads the key, and on a miss runs `loader` — once, however many callers
   * asked at the same time (§3.4). A loader's throw rejects every waiter with
   * the one error and is never cached; a loader's `undefined` is not cached
   * unless `cacheUndefined`. Callers that ask while a load for the key runs
   * join it without reading, and callers that ask while a read of the key
   * runs share that read — so concurrent callers are answered the same value
   * object, a hit's as a load's (mutating a cached value is a bug either way).
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

  /**
   * The names this cache stores `key` and `tags` under, in this view's
   * namespace: to find an entry in a dump, a `redis-cli` session or a SQL
   * row. Under `encrypt.hashNames`, their hashes; otherwise the namespace,
   * the key (`#`-hashed when longer than `maxKeyLength`) and the tags as
   * they are. Reads and writes nothing.
   */
  describeKey: (
    key: string,
    tags?: readonly Tag[],
  ) => { namespace: string; key: string; tags: string[] };

  /** Listens for an event; answers an unsubscribe function. */
  on: <E extends CacheEvent>(
    event: E,
    listener: (payload: CacheEventMap[E]) => void,
  ) => () => void;
  /** The counters (§3.12); `stats({ reset: true })` reads and zeroes them. */
  stats: (options?: { reset?: boolean }) => CacheStats;

  /** Stops the sweeper, unsubscribes from the bus, and closes the driver and an explicit bus. Idempotent. */
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
  /** The size cap per entry, in bytes; defaults to 4 MiB, capped by the driver's own limit. It holds both the stored entry and its payload before compression: oversize writes resolve `false` with an `oversize` event, and a read decompresses no further (a stored entry that would is a miss, with an `error` event of phase `"decode"`). */
  maxEntryBytes?: number;
  /** Keys longer than this many bytes are stored as `#` + their SHA-256 (§3.7). Defaults to 200. */
  maxKeyLength?: number;
  /**
   * At-rest encryption (the encryption plan): every entry sealed, bound to
   * its namespace and key, with its tags and hard expiry sealed too. An entry
   * that does not open is a miss with an `error` event (`phase: "decrypt"`),
   * and is **not** deleted; a write that cannot seal resolves `false`. Off by
   * default.
   */
  encrypt?: CacheEncryptOptions;

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
  /**
   * Lets the cache soft-purge, `invalidateTags(tags, { mode: "stale" })`
   * (R21). Defaults to `false`; every cache needs it, on every driver,
   * encrypted or not — without it `mode: "stale"` throws
   * `UnsupportedOperationError`.
   *
   * The cost: its tagged reads then check the tags' stale stamps, one stamp
   * lookup per tag per `tagStampCacheMs` per process (the in-process stamp
   * cache). On an index-mode driver (memory, SQLite, Postgres, MySQL,
   * MariaDB, MongoDB, Redis, Cloudflare D1) without `encrypt`, whose reads
   * otherwise read no stamps, that is a new lookup; on a stamps-mode driver
   * (file, S3, Azure, Cloudflare KV, `fromSimpleDriver`) or an encrypted
   * cache it joins the ordinary stamps' call, as one more stamp per tag (a
   * file or an object of its own on a stamps-mode driver). Without the
   * option no stale stamp is ever read. A stale stamp lives for
   * `tagStampTtl`, like any stamp: an entry that outlives it reads fresh
   * again.
   */
  softPurge?: boolean;

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

  /**
   * The L1 tier (§4.1): a per-process memory tier over the driver, holding
   * **decoded values**, so a hit skips both the round trip and the decode.
   * `true` for the defaults. Off by default.
   *
   * - **Values are shared, not copied**: a hit returns the object L1 holds,
   *   so a caller that mutates it mutates every later hit's value in this
   *   process (and not the driver's). `clone: true` returns a
   *   `structuredClone` instead. Mutating a cached value is a bug with or
   *   without L1.
   * - **Only fresh copies**: an entry is held until the first of its
   *   freshness, its driver expiry and `ttl` — copied from the driver's entry
   *   on a read, never a fresh TTL (R14), so a stale value is never served
   *   from L1; the stale windows (§3.5) are the driver's.
   * - **Counters never enter L1** (§3.8): an increment is the driver's alone.
   * - **Kept coherent by the bus** (`bus`): another cache's write or
   *   invalidation drops this process's copy once its message arrives; a bus
   *   gap flushes the whole tier. With no bus, a copy can be stale for up to
   *   `ttl` (§4.3).
   */
  l1?:
    | true
    | {
        /** At most this many entries; the least recently used go first. Defaults to 10,000. */
        maxEntries?: number;
        /** At most this many decoded payload bytes (the codec's bytes, before compression). Defaults to 64 MiB. */
        maxBytes?: number;
        /** The longest an entry is held, in ms — the staleness bound when the bus is down or absent (§4.3). Defaults to 30,000. */
        ttl?: number;
        /** Return a `structuredClone` of each hit (and store a clone of each value), so callers cannot mutate L1's copy. Defaults to `false`. */
        clone?: boolean;
      };
  /**
   * The bus that keeps L1s coherent (§4.2): `"auto"` uses the driver's own
   * (Postgres `LISTEN`/`NOTIFY`, the polled SQLite/MySQL/MariaDB/file logs,
   * the memory driver's in-process one) when it has one; a {@link CacheBus}
   * (`redisBus(url)`, `pgBus(url)`) replaces it, and is closed by the
   * cache's `close()`; `false` uses none. Defaults to `"auto"` with an `l1`,
   * `false` without.
   *
   * A cache with a bus and no `l1` still **publishes** its writes and
   * invalidations, so a process that writes the shared tier keeps the other
   * processes' L1s coherent without holding one itself; it also receives
   * other caches' tag invalidations into its tag-stamp cache (§3.6).
   */
  bus?: "auto" | false | CacheBus;

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
