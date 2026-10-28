/**
 * The cache core (plan §3): everything that behaves the same on every
 * backend — keys, namespaces and TTLs; the codec and compression; `getOrSet`
 * with single-flight; stale-while-revalidate and stale-if-error; the tag
 * fence; events, statistics and the failure policy. A driver stores the
 * opaque entries this writes (§6.1).
 */
import type { Logger, StandardSchemaV1 } from "@kingsleyweb/bun-common";
import {
  createDeferred,
  noopLogger,
  resolveLogger,
  sleep,
} from "@kingsleyweb/bun-common";
import type { ValidationIssue } from "@kingsleyweb/bun-common/contract";
import { validateStandard } from "@kingsleyweb/bun-common/contract";
import { codecById, CODEC_IDS, resolveCodec } from "./codecs";
import type { ResolvedCompression } from "./compression";
import { decompressEntry, isPromiseLike, resolveCompress } from "./compression";
import {
  CacheDriverError,
  CircuitOpenError,
  EntryTooLargeError,
  LoaderTimeoutError,
  UnsupportedOperationError,
} from "./errors";
import { BusLink, driverBus } from "./bus";
import { CacheEvents } from "./events";
import type { Flight } from "./flight";
import { FlightMap } from "./flight";
import type { EntryHeader } from "./header";
import {
  COMPRESSOR_IDS,
  decodeEntry,
  encodeEntry,
  ENTRY_FLAGS,
  NO_FRESH_UNTIL,
} from "./header";
import { checkNamespace, fullNamespace, storedKey } from "./keys";
import { L1Store } from "./l1";
import { CacheStatsCounter } from "./stats";
import type {
  BusMessage,
  Cache,
  CacheBus,
  CacheCompressor,
  CacheDriver,
  CacheEntry,
  CacheEvent,
  CacheEventMap,
  CacheFencedReason,
  CacheLoader,
  CacheLockOptions,
  CacheSchema,
  CacheSchemaFrom,
  CacheStats,
  Codec,
  CreateCacheOptions,
  GetOrSetOptions,
  JsonifySchema,
  SchemaChange,
  SchemaSyncOptions,
  SetOptions,
  StoredEntry,
} from "./types";

// A deep import of this module (`lib/core/cache`) is where `createCache`
// lives; its options type belongs beside it.
export type { CreateCacheOptions } from "./types";

/** `createCache`'s defaults. */
const DEFAULTS = {
  /** The namespace when none is given. */
  namespace: "cache",
  /** `maxEntryBytes`: 4 MiB (§3.9). */
  maxEntryBytes: 4 * 1024 * 1024,
  /** `maxKeyLength`: keys longer than this many bytes are stored hashed (§3.7). */
  maxKeyLength: 200,
  /** `compress`: zstd above 16 KiB (§3.11). */
  compressThreshold: 16 * 1024,
  /** `failSafeBackoff`: a failed refresh's stale value stays fresh this much longer (§3.5). */
  failSafeBackoff: 10_000,
  /** `tagStampTtl`'s cap (§3.6). */
  tagStampTtlCap: 24 * 60 * 60 * 1000,
  /** `tagStampCacheMs` (§3.6). */
  tagStampCacheMs: 1_000,
  /** `sweepInterval` (§6.1). */
  sweepInterval: 60_000,
  /** `circuit`: 5 consecutive failures open it for 30 s (§3.14). */
  circuitFailures: 5,
  /** See {@link DEFAULTS.circuitFailures}. */
  circuitCooldown: 30_000,
  /** The cross-process lock's default TTL (§3.4). */
  lockTtl: 30_000,
  /** A lock waiter's default poll interval (§3.4). */
  lockWaitInterval: 50,
  /** A lock waiter's default patience (§3.4). */
  lockWaitTimeout: 5_000,
  /** How many entries one sweep pass reclaims at most. */
  sweepLimit: 1_000,
  /** `l1.maxEntries` (§4.1). */
  l1MaxEntries: 10_000,
  /** `l1.maxBytes`: 64 MiB of decoded payload (§4.1). */
  l1MaxBytes: 64 * 1024 * 1024,
  /** `l1.ttl`: the staleness bound with the bus down or absent (§4.3). */
  l1Ttl: 30_000,
} as const;

/** The failure policy warns at most once per this many ms per cache (§3.14). */
const WARN_EVERY_MS = 10_000;

/** The `#op` fallback marking a failed driver read, distinct from a real miss (a miss still checks for a counter; a failure must not — the probe would reset the circuit's failure count). */
const FAILED = Symbol("cache:driver-failed");

/** The reserved namespace a sweep's lock lives under. */
const SWEEP_NAMESPACE = "__bun_cache__";

/** A decoded stored entry, inside the core. */
interface DecodedValue {
  /** The decoded value; `undefined` for a negative marker. */
  value: unknown;
  /** Whether this is a cached negative (`cacheUndefined`). */
  negative: boolean;
  /** When the value's loader started, epoch ms. */
  createdAt: number;
  /** When it stops being fresh, epoch ms; `null` when never. */
  freshUntil: number | null;
  /** The hard expiry, epoch ms; `null` when never. */
  expiresAt: number | null;
  /** The last load's duration, in ms; 0 when unknown. */
  loadMs: number;
  /** The entry's tags. */
  tags: readonly string[];
  /** The stored size, in bytes. */
  bytes: number;
  /** The decoded payload's size, in bytes (before compression): what it costs the L1 tier. */
  size: number;
  /** A counter read through `getCounter` (§3.8): never copied into L1. */
  counter?: boolean;
  /** The stored payload was not compressed: a rewrite (the fail-safe backoff) keeps it so, honouring a per-call `compress: false`. */
  uncompressed?: boolean;
}

/** The outcome of the read pipeline. */
type ReadOutcome =
  | { kind: "fresh"; entry: DecodedValue }
  | { kind: "stale"; entry: DecodedValue }
  | { kind: "miss" };

/** What the encoder produced: the header's codec, flags and compressor fields, and the payload. */
interface Encoded {
  /** The codec id. */
  codecId: number;
  /** The flags, without compression bits (the header writes those). */
  flags: number;
  /** The compressor id; `COMPRESSOR_IDS.none` when stored uncompressed. */
  compressor: number;
  /** The payload as stored: compressed when `compressor` says so. */
  payload: Uint8Array;
  /** The codec's bytes before compression, which the L1 copy decodes without decompressing. */
  plain: Uint8Array;
}

/** What the decoder produced. */
interface Decoded {
  /** The decoded value; `undefined` for a negative marker. */
  value: unknown;
  /** Whether this is a negative marker. */
  negative: boolean;
  /** The entry's header. */
  header: EntryHeader;
  /** The decoded payload's size, in bytes (after decompression). */
  size: number;
}

/** The resolved `lock` option. */
interface ResolvedLock {
  /** The lock's TTL, in ms. */
  ttl: number;
  /** The waiter's poll interval, in ms. */
  waitInterval: number;
  /** The waiter's patience, in ms. */
  waitTimeout: number;
}

/** State shared by a cache and its namespace views. */
interface SharedState {
  /** The driver everything stores through. */
  driver: CacheDriver;
  /** The codec new entries are written with. */
  codec: Codec;
  /** The cache's custom codec, when `codec` was one — entries written with it decode too. */
  customCodec: Codec | undefined;
  /** How new entries are compressed; `undefined` when `compress: false`. */
  compress: ResolvedCompression | undefined;
  /** The user compressors that decompress, by id (`compress.algorithm`'s and `compress.previous`'s). */
  userCompressors: ReadonlyMap<number, CacheCompressor>;
  /** The resolved options. */
  options: CreateCacheOptions;
  /** The logger. */
  logger: Logger;
  /** The clock. */
  now: () => number;
  /** The randomness source. */
  random: () => number;
  /** The event emitter. */
  events: CacheEvents;
  /** The statistics. */
  stats: CacheStatsCounter;
  /** The single-flight map. */
  flights: FlightMap;
  /** The circuit: consecutive driver failures, and when an open circuit allows the next probe. */
  circuit: { failures: number; openUntil: number; probing: boolean };
  /** When the last driver-failure warning was logged (throttled, §3.14). */
  lastWarnAt: number;
  /** Whether the one `lock`-without-`capabilities.lock` warning has been logged. */
  warnedLock: boolean;
  /** The in-process tag-stamp cache for stamps-mode drivers, `${ns}\n${tag}` → the stamp and when this copy expires. */
  stampCache: Map<string, { at: number; expires: number }>;
  /** The `validate` map, split for matching: exact keys, and trailing-`*` prefixes in declaration order. */
  validators: {
    exact: Map<string, StandardSchemaV1>;
    prefixes: { prefix: string; schema: StandardSchemaV1 }[];
  };
  /** The sweeper's timer, when the driver sweeps. */
  sweepTimer: ReturnType<typeof setInterval> | undefined;
  /** Whether `close()` has run. */
  closed: boolean;
  /** The L1 tier, when `l1` is set (§4.1). */
  l1: L1Store<DecodedValue> | undefined;
  /** The bus link, when the cache has a bus (§4.2). */
  bus: BusLink | undefined;
  /** When the last bus-failure warning was logged (throttled like the driver's). */
  lastBusWarnAt: number;
}

/** The cache implementation; one instance per namespace view, over shared state. */
class CacheImpl<
  Schema extends CacheSchema = Record<string, unknown>,
  Tag extends string = string,
> implements Cache<Schema, Tag> {
  readonly #state: SharedState;

  /** This view's full namespace. */
  readonly #ns: string;

  constructor(state: SharedState, ns: string) {
    this.#state = state;
    this.#ns = ns;
    this.#startSweep();
  }

  /* ---------------------------------------------------------------- */
  /* small pieces                                                      */
  /* ---------------------------------------------------------------- */

  /** The stored form of a user key (hashed when long, §3.7). */
  #storedKey(key: string): string {
    return storedKey(
      key,
      this.#state.options.maxKeyLength ?? DEFAULTS.maxKeyLength,
    );
  }

  /** The flight-map key of a stored key. */
  #flightKey(stored: string): string {
    return `${this.#ns}\n${stored}`;
  }

  /** Emits an event. */
  #emit<E extends CacheEvent>(event: E, payload: CacheEventMap[E]): void {
    this.#state.events.emit(event, payload);
  }

  /**
   * Reports a loaded value that was not stored because an invalidation won
   * the race: the `fenced` event and the `fenced` stat, the same for the
   * driver's tag fence and for a flight a local delete/clear/invalidation
   * forgot (§3.4, §3.6).
   */
  #reportFenced(
    key: string,
    tags: readonly Tag[],
    reason: CacheFencedReason,
  ): void {
    this.#state.stats.fenced++;
    this.#emit("fenced", { key, namespace: this.#ns, tags, reason });
  }

  /**
   * The failure policy (§3.14) around one driver operation.
   *
   * - The circuit open: the operation is bypassed — a read is a miss, a
   *   write resolves `fallback`; `strict: true` throws `CircuitOpenError`.
   * - A failure (throw, rejection, or `timeout`): counted; `circuit.failures`
   *   in a row open the circuit for `circuit.cooldown`. Under the default
   *   policy the operation degrades to `fallback`, with an `error` event and
   *   a `warn` logged at most once per 10 s; under `strict` it throws a
   *   `CacheDriverError`.
   * - After the cooldown the next operation is the probe; its success closes
   *   the circuit (`circuit-close`), and operations arriving while it runs
   *   bypass rather than pile onto a backend that may still be down.
   */
  async #op<T>(op: string, run: () => Promise<T>, fallback: T): Promise<T> {
    const state = this.#state;
    const now = state.now();
    const circuit = state.circuit;
    const failures =
      state.options.circuit?.failures ?? DEFAULTS.circuitFailures;
    const cooldown =
      state.options.circuit?.cooldown ?? DEFAULTS.circuitCooldown;

    if (circuit.openUntil > now) {
      if (state.options.strict === true) {
        throw new CircuitOpenError(state.driver.name, circuit.openUntil);
      }
      return fallback;
    }
    // The first operation after the cooldown is the probe.
    const isProbe = circuit.openUntil > 0 && circuit.openUntil <= now;
    if (isProbe && circuit.probing) {
      if (state.options.strict === true) {
        throw new CircuitOpenError(state.driver.name, circuit.openUntil);
      }
      return fallback;
    }
    if (isProbe) {
      circuit.probing = true;
    }

    try {
      const timeout = state.options.timeout;
      let result: T;
      if (timeout !== undefined && timeout > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          result = await new Promise<T>((resolve, reject) => {
            timer = setTimeout(() => {
              reject(
                new Error(`the ${op} operation timed out after ${timeout} ms`),
              );
            }, timeout);
            timer.unref?.();
            run().then(resolve, reject);
          });
        } finally {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
        }
      } else {
        result = await run();
      }
      circuit.failures = 0;
      if (circuit.openUntil > 0) {
        circuit.openUntil = 0;
        circuit.probing = false;
        this.#emit("circuit-close", { driver: state.driver.name });
      }
      return result;
    } catch (cause) {
      circuit.probing = false;
      circuit.failures++;
      if (circuit.failures >= failures && circuit.openUntil <= now) {
        circuit.openUntil = now + cooldown;
        this.#emit("circuit-open", {
          driver: state.driver.name,
          failures: circuit.failures,
        });
      }
      const error =
        cause instanceof CacheDriverError
          ? cause
          : new CacheDriverError({ driver: state.driver.name, op, cause });
      this.#emit("error", {
        phase: "driver",
        driver: state.driver.name,
        error,
      });
      if (now - state.lastWarnAt >= WARN_EVERY_MS) {
        state.lastWarnAt = now;
        state.logger.warn(
          `cache driver "${state.driver.name}" failed on ${op}`,
          { error },
        );
      }
      if (state.options.strict === true) {
        throw error;
      }
      return fallback;
    }
  }

  /** The schema a `validate` pattern maps this key to, if any (exact match first, then the first matching `prefix*`). */
  #validatorFor(key: string): StandardSchemaV1 | undefined {
    const { exact, prefixes } = this.#state.validators;
    const exactMatch = exact.get(key);
    if (exactMatch !== undefined) {
      return exactMatch;
    }
    for (const { prefix, schema } of prefixes) {
      if (key.startsWith(prefix)) {
        return schema;
      }
    }
    return undefined;
  }

  /**
   * The live stamps of `tags` on a stamps-mode driver, cached in process for
   * `tagStampCacheMs` (§3.6). A driver failure fails open — no stamps — with
   * an `error` event, per the failure policy.
   */
  async #stampsFor(tags: readonly string[]): Promise<Map<string, number>> {
    const state = this.#state;
    const now = Date.now();
    const out = new Map<string, number>();
    const missing: string[] = [];
    for (const tag of tags) {
      const cached = state.stampCache.get(`${this.#ns}\n${tag}`);
      if (cached !== undefined && cached.expires > now) {
        if (cached.at > 0) {
          out.set(tag, cached.at);
        }
      } else {
        missing.push(tag);
      }
    }
    if (missing.length > 0) {
      const fetched = await this.#op(
        "getStamps",
        async () => await state.driver.getStamps(this.#ns, missing),
        new Map<string, number>(),
      );
      const expires =
        now + (state.options.tagStampCacheMs ?? DEFAULTS.tagStampCacheMs);
      for (const tag of missing) {
        const at = fetched.get(tag) ?? 0;
        state.stampCache.set(`${this.#ns}\n${tag}`, { at, expires });
        if (at > 0) {
          out.set(tag, at);
        }
      }
    }
    return out;
  }

  /** Deletes a stored entry in the background (an expired, corrupt or refused one); never throws. */
  #deleteInBackground(stored: string): void {
    void this.#op(
      "delete",
      async () => await this.#state.driver.delete(this.#ns, [stored]),
      0,
    );
  }

  /* ---------------------------------------------------------------- */
  /* encode / decode                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Encodes a value into the payload bytes and the header's codec, flags and
   * compressor fields, keeping the payload before compression (`plain`, which
   * a read decompresses back to). Synchronous unless a user compressor answers
   * a promise; `compress: false` (per call) stores the payload uncompressed.
   */
  #encodeValue(
    value: unknown,
    negative: boolean,
    compress?: false,
  ): Encoded | Promise<Encoded> {
    const state = this.#state;
    if (negative) {
      const empty = new Uint8Array(0);
      return {
        codecId: state.codec.id,
        flags: ENTRY_FLAGS.negative,
        compressor: COMPRESSOR_IDS.none,
        payload: empty,
        plain: empty,
      };
    }
    let flags = 0;
    const plain = state.codec.encode(value);
    if (state.codec.id === CODEC_IDS.raw && typeof value === "string") {
      flags |= ENTRY_FLAGS.rawString;
    }
    const uncompressed: Encoded = {
      codecId: state.codec.id,
      flags,
      compressor: COMPRESSOR_IDS.none,
      payload: plain,
      plain,
    };
    const algorithm = state.compress;
    if (
      compress === false ||
      algorithm === undefined ||
      plain.byteLength < algorithm.threshold
    ) {
      return uncompressed;
    }
    // A copy: a codec may answer a view into a larger buffer.
    const compressed = algorithm.compress(plain.slice());
    const choose = (bytes: Uint8Array): Encoded => {
      if (!(bytes instanceof Uint8Array)) {
        throw new TypeError(
          "a user compressor's compress must answer a Uint8Array",
        );
      }
      // Compressed only when that makes it smaller (§3.11).
      return bytes.byteLength < plain.byteLength
        ? { ...uncompressed, compressor: algorithm.id, payload: bytes }
        : uncompressed;
    };
    return isPromiseLike(compressed)
      ? Promise.resolve(compressed).then(choose)
      : choose(compressed);
  }

  /** The per-entry byte limit: `maxEntryBytes` (default 4 MiB), capped by the driver's own. Writes hold the stored entry and its uncompressed payload to it; reads decompress no further. */
  #entryLimit(): number {
    const state = this.#state;
    return Math.min(
      state.options.maxEntryBytes ?? DEFAULTS.maxEntryBytes,
      state.driver.capabilities.maxEntryBytes ?? Number.POSITIVE_INFINITY,
    );
  }

  /**
   * Decodes a stored entry's bytes. Throws (→ a miss with an `error` event)
   * on any corruption, a key mismatch, an unknown codec or compressor, or a
   * payload that decompresses past the entry limit. Synchronous unless a
   * user compressor answers a promise.
   */
  #decodeValue(bytes: Uint8Array, key: string): Decoded | Promise<Decoded> {
    const { header, payload: rawPayload } = decodeEntry(bytes);
    if (header.key !== key) {
      // The key was hashed for storage and this entry's full key differs: a
      // hash collision (§3.7). A miss, never the wrong value.
      throw new Error(
        "the stored entry's key does not match (a long-key hash collision)",
      );
    }
    // Never past the entry limit, whatever the compressor: a planted bomb is
    // refused, not materialised (Q18). What this cache writes always fits
    // (`#write` holds the uncompressed payload to the same limit).
    const payload = decompressEntry(
      header.compressor,
      rawPayload,
      this.#entryLimit(),
      this.#state.userCompressors,
    );
    return isPromiseLike(payload)
      ? Promise.resolve(payload).then((plain) =>
          this.#decodePayload(header, plain),
        )
      : this.#decodePayload(header, payload);
  }

  /** Decodes an entry's uncompressed payload with the codec its header names. */
  #decodePayload(header: EntryHeader, payload: Uint8Array): Decoded {
    if ((header.flags & ENTRY_FLAGS.negative) !== 0) {
      return { value: undefined, negative: true, header, size: 0 };
    }
    const codec = codecById(header.codecId, this.#state.customCodec);
    if (codec === undefined) {
      throw new Error(
        `the entry's codec id ${header.codecId} is not known to this cache`,
      );
    }
    let value = codec.decode(payload);
    if (
      (header.flags & ENTRY_FLAGS.rawString) !== 0 &&
      codec.id === CODEC_IDS.raw
    ) {
      value = new TextDecoder().decode(value as Uint8Array);
    }
    return { value, negative: false, header, size: payload.byteLength };
  }

  /* ---------------------------------------------------------------- */
  /* the read pipeline                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Reads one key: driver read (with a counter fallback), hard-expiry check,
   * decode, the stamps-mode tag check (§3.6), and the `validate` check
   * (V10). Pure with respect to `hit`/`miss` events and stats — the callers
   * record those.
   */
  async #readStored(key: string, stored: string): Promise<ReadOutcome> {
    const state = this.#state;
    const driver = state.driver;
    const now = state.now();
    const raw = await this.#op<StoredEntry | undefined | typeof FAILED>(
      "get",
      async () => await driver.get(this.#ns, stored),
      FAILED,
    );
    if (raw === FAILED) {
      return { kind: "miss" };
    }
    if (raw === undefined) {
      // A counter lives outside the entry bytes (§3.8).
      if (driver.getCounter !== undefined) {
        const counter = await this.#op(
          "getCounter",
          async () => await driver.getCounter?.(this.#ns, stored),
          undefined,
        );
        if (
          counter !== undefined &&
          (counter.expiresAt === null || counter.expiresAt > now)
        ) {
          return {
            kind: "fresh",
            entry: {
              value: counter.value,
              negative: false,
              createdAt: counter.createdAt,
              freshUntil: counter.expiresAt,
              expiresAt: counter.expiresAt,
              loadMs: 0,
              tags: [],
              bytes: 0,
              size: 0,
              counter: true,
            },
          };
        }
      }
      return { kind: "miss" };
    }
    return await this.#decodeStored(key, stored, raw);
  }

  /** The read pipeline past the driver's `get` (shared by `getMany`). */
  async #decodeStored(
    key: string,
    stored: string,
    raw: StoredEntry,
  ): Promise<ReadOutcome> {
    const state = this.#state;
    const now = state.now();
    state.stats.bytesRead += raw.value.byteLength;
    if (raw.expiresAt !== null && raw.expiresAt <= now) {
      // Past its hard expiry: a miss, and reclaim the space in the background.
      this.#deleteInBackground(stored);
      return { kind: "miss" };
    }
    let decoded: Decoded;
    try {
      const result = this.#decodeValue(raw.value, key);
      decoded = isPromiseLike(result) ? await result : result;
    } catch (error) {
      // An entry that fails to decode is a miss; it is deleted (§3.2).
      this.#deleteInBackground(stored);
      this.#emit("error", {
        key,
        namespace: this.#ns,
        phase: "decode",
        driver: state.driver.name,
        error,
      });
      return { kind: "miss" };
    }
    const { header } = decoded;
    // The stamps-mode read check (§3.6): an entry older than one of its
    // tags' invalidation stamps is a miss, whatever the bytes say.
    if (state.driver.capabilities.tags === "stamps" && raw.tags.length > 0) {
      const stamps = await this.#stampsFor(raw.tags);
      let invalidated = false;
      for (const tag of raw.tags) {
        const at = stamps.get(tag);
        // A stamp at the entry's own millisecond counts as newer: Date.now()
        // cannot order two events within one ms, so the safe side wins (a
        // wrongly-missed entry is reloaded; a wrongly-served one is stale).
        if (at !== undefined && at >= header.createdAt) {
          invalidated = true;
          break;
        }
      }
      if (invalidated) {
        return { kind: "miss" };
      }
    }
    // V10: a stored value that fails its schema is a miss and is deleted,
    // with an `error` event whose issues target "cache".
    const schema = this.#validatorFor(key);
    let value = decoded.value;
    if (schema !== undefined && !decoded.negative) {
      const outcome = await validateStandard(schema, value, "cache", key);
      if (!outcome.ok) {
        this.#deleteInBackground(stored);
        const issues: readonly ValidationIssue[] = outcome.issues;
        this.#emit("error", {
          key,
          namespace: this.#ns,
          phase: "validate",
          driver: state.driver.name,
          error: new Error(
            `the cached value for "${key}" failed its schema (${issues.length} issue${issues.length === 1 ? "" : "s"})`,
          ),
          issues,
        });
        return { kind: "miss" };
      }
      value = outcome.value;
    }
    const freshUntil =
      header.freshUntil === NO_FRESH_UNTIL ? null : header.freshUntil;
    const entry: DecodedValue = {
      value,
      negative: decoded.negative,
      createdAt: header.createdAt,
      freshUntil,
      expiresAt: raw.expiresAt,
      loadMs: header.loadMs,
      tags: raw.tags,
      bytes: raw.value.byteLength,
      size: decoded.size,
      uncompressed: header.compressor === COMPRESSOR_IDS.none,
    };
    if (freshUntil !== null && now > freshUntil) {
      return { kind: "stale", entry };
    }
    return { kind: "fresh", entry };
  }

  /**
   * The tiered read (§4.1): L1, then the driver. A fresh L1 copy answers at
   * once; otherwise the driver's read is copied into L1 when it is fresh (and
   * not a counter), unless an invalidation covering it landed while it was in
   * flight (`L1Store.fill`). `tier: "l2"` reads the driver and leaves L1 alone.
   */
  async #read(
    key: string,
    stored: string,
    tier: "l2" | undefined,
  ): Promise<{ read: ReadOutcome; tier: "l1" | "l2" }> {
    const state = this.#state;
    const l1 = state.l1;
    if (l1 === undefined || tier === "l2") {
      return { read: await this.#readStored(key, stored), tier: "l2" };
    }
    const copy = l1.get(this.#ns, stored, state.now());
    if (copy !== undefined) {
      l1.counts.hits++;
      return { read: { kind: "fresh", entry: copy }, tier: "l1" };
    }
    l1.counts.misses++;
    const token = l1.begin();
    try {
      const read = await this.#readStored(key, stored);
      this.#fillL1(stored, read, token);
      return { read, tier: "l2" };
    } finally {
      l1.end();
    }
  }

  /** Copies a fresh driver read into L1 (never a counter, never a stale entry). */
  #fillL1(stored: string, read: ReadOutcome, token: number): void {
    const l1 = this.#state.l1;
    if (
      l1 !== undefined &&
      read.kind === "fresh" &&
      read.entry.counter !== true
    ) {
      l1.fill(
        this.#ns,
        stored,
        read.entry,
        read.entry.size,
        token,
        this.#state.now(),
      );
    }
  }

  /** Publishes on the bus, when the cache has one (§4.2); never throws — a failure is an `error` event. */
  async #publish(
    message: Omit<BusMessage, "namespace" | "at" | "origin">,
  ): Promise<void> {
    const bus = this.#state.bus;
    if (bus === undefined) {
      return;
    }
    await bus.publish({
      ...message,
      namespace: this.#ns,
      at: this.#state.now(),
    });
  }

  /* ---------------------------------------------------------------- */
  /* the write pipeline                                                */
  /* ---------------------------------------------------------------- */

  /** Resolves the fresh-for of a write: the call's `ttl`/`expiresAt`, then the cache's `ttl` (a function computes it from the value). */
  #resolveTtl(
    value: unknown,
    options: SetOptions<Tag> | undefined,
  ): number | null {
    if (options?.expiresAt !== undefined) {
      if (options.expiresAt === null) {
        return null;
      }
      const at =
        options.expiresAt instanceof Date
          ? options.expiresAt.getTime()
          : options.expiresAt;
      return Math.max(0, at - this.#state.now());
    }
    let ttl = options?.ttl;
    if (ttl === undefined) {
      const own = this.#state.options.ttl;
      ttl = typeof own === "function" ? own(value) : own;
    }
    if (ttl === undefined || ttl === null) {
      return null;
    }
    const jitter = options?.jitter ?? this.#state.options.jitter ?? 0;
    if (jitter > 0) {
      ttl = ttl * (1 + jitter * (this.#state.random() * 2 - 1));
    }
    return Math.max(0, Math.round(ttl));
  }

  /**
   * Encodes and stores a value; answers whether it was stored. An oversized
   * entry is skipped with an `oversize` event (a throw under `strict`);
   * a fenced one answers `false` with a `fenced` event (§3.6, §3.9).
   */
  async #write(
    key: string,
    stored: string,
    value: unknown,
    init: {
      /** The fresh-for, in ms; `null` never goes stale. */
      ttl: number | null;
      /** The entry's tags. */
      tags: readonly Tag[];
      /** When the value's loader started (the fence reads it). */
      createdAt: number;
      /** The load's duration, for early expiry. */
      loadMs: number;
      /** The stale-while-revalidate window, in ms. */
      staleWhileRevalidate: number;
      /** The stale-if-error window, in ms. */
      staleIfError: number;
      /** Whether this is a negative marker. */
      negative: boolean;
      /** `"l2"`: write the driver only; this process's L1 copy is dropped, not replaced. */
      tier?: "l2";
      /** `false`: store the payload uncompressed (the per-call option). */
      compress?: false;
      /**
       * A load's L1 token, taken when its loader started (`L1Store.begin`):
       * an invalidation that landed during the load then keeps its value out
       * of L1 — on a stamps-mode driver nothing else would, since there is no
       * driver fence there. Absent: the write takes its own.
       */
      l1Token?: number;
    },
  ): Promise<boolean> {
    const state = this.#state;
    const now = state.now();
    const encoding = this.#encodeValue(value, init.negative, init.compress);
    const encoded = isPromiseLike(encoding) ? await encoding : encoding;
    const freshUntil = init.ttl === null ? NO_FRESH_UNTIL : now + init.ttl;
    const expiresAt =
      init.ttl === null
        ? null
        : freshUntil +
          Math.max(init.staleWhileRevalidate, init.staleIfError, 0);
    const header: EntryHeader = {
      codecId: encoded.codecId,
      flags: encoded.flags,
      compressor: encoded.compressor,
      createdAt: init.createdAt,
      freshUntil,
      loadMs: init.loadMs,
      key,
    };
    const bytes = encodeEntry(header, encoded.payload);
    // The stored entry and the payload it decompresses to are both held to
    // the limit, since a read decompresses no further (`#decodeValue`): a
    // value that compresses under it but decodes past it is never written.
    const limit = this.#entryLimit();
    const entrySize = Math.max(bytes.byteLength, encoded.plain.byteLength);
    if (entrySize > limit) {
      const error = new EntryTooLargeError(key, entrySize, limit);
      this.#emit("oversize", {
        key,
        namespace: this.#ns,
        bytes: entrySize,
        limit,
      });
      if (state.options.strict === true) {
        throw error;
      }
      return false;
    }
    const entry: StoredEntry = {
      key: stored,
      value: bytes,
      expiresAt,
      tags: init.tags,
    };
    // The fence (§3.6): an indexed driver refuses the write when one of its
    // tags was invalidated after the load started. Stamps-mode drivers need
    // none — the read-side check sees the stamp either way.
    const fence =
      init.tags.length > 0 && state.driver.capabilities.tags === "index"
        ? { tags: init.tags, createdAt: init.createdAt }
        : undefined;
    // §4.1's write order: L2, then L1, then the bus. The token is taken
    // before the L2 write, so an invalidation that lands while it runs keeps
    // this value out of L1 (which write L2 kept last is unknowable here).
    const l1 = state.l1;
    const own = l1 !== undefined && init.l1Token === undefined;
    const token = init.l1Token ?? (own ? l1.begin() : 0);
    try {
      const result = await this.#op(
        "set",
        async () => await state.driver.set(this.#ns, entry, fence),
        "fenced" as const,
      );
      if (result === "fenced") {
        // Fenced, or failed: L2 kept what it had, and so does every other
        // process's L1 — only this process's copy, if any, is dropped.
        l1?.afterWrite(this.#ns, stored, undefined, 0, token, state.now());
        this.#reportFenced(key, init.tags, "fence");
        return false;
      }
      state.stats.sets++;
      state.stats.bytesWritten += bytes.byteLength;
      this.#emit("set", { key, namespace: this.#ns, bytes: bytes.byteLength });
      if (l1 !== undefined) {
        // The codec's bytes, never the caller's own (the raw codec passes a
        // Uint8Array through): the stored copy's payload when uncompressed,
        // else a copy of the bytes the compressor was given.
        const plain =
          encoded.compressor === COMPRESSOR_IDS.none
            ? bytes.subarray(bytes.byteLength - encoded.payload.byteLength)
            : encoded.plain.slice();
        const [copy, size] = this.#l1CopyOfWrite(
          key,
          header,
          plain,
          entry,
          init,
        );
        l1.afterWrite(this.#ns, stored, copy, size, token, state.now());
      }
      await this.#publish({ type: "set", keys: [stored] });
      return true;
    } finally {
      if (own) {
        l1.end();
      }
    }
  }

  /**
   * What L1 holds for a value this process just wrote: the **decoded** bytes,
   * so an L1 hit gives what an L2 read would (`codec: "json"` turns a `Date`
   * into a string in both) and never the caller's own object. Decoded from
   * the payload before compression, so it never decompresses (nor awaits a
   * user compressor). Nothing when the call asked for `tier: "l2"`, or when
   * `validate` covers the key — the next read validates it on its way in.
   */
  #l1CopyOfWrite(
    key: string,
    header: EntryHeader,
    plain: Uint8Array,
    entry: StoredEntry,
    init: {
      /** When the value's loader started. */
      createdAt: number;
      /** The load's duration. */
      loadMs: number;
      /** The per-call tier. */
      tier?: "l2";
    },
  ): [DecodedValue | undefined, number] {
    if (init.tier === "l2" || this.#validatorFor(key) !== undefined) {
      return [undefined, 0];
    }
    try {
      const decoded = this.#decodePayload(header, plain);
      const freshUntil =
        decoded.header.freshUntil === NO_FRESH_UNTIL
          ? null
          : decoded.header.freshUntil;
      return [
        {
          value: decoded.value,
          negative: decoded.negative,
          createdAt: init.createdAt,
          freshUntil,
          expiresAt: entry.expiresAt,
          loadMs: init.loadMs,
          tags: entry.tags,
          bytes: entry.value.byteLength,
          size: decoded.size,
          uncompressed: header.compressor === COMPRESSOR_IDS.none,
        },
        decoded.size,
      ];
    } catch {
      return [undefined, 0];
    }
  }

  /* ---------------------------------------------------------------- */
  /* getOrSet: the load path                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Runs `loader` for a key nothing fresh is known for, through the
   * single-flight (§3.4): the first caller leads, everyone else awaits the
   * leader's promise.
   */
  #loadFlighted(
    key: string,
    stored: string,
    loader: CacheLoader<unknown>,
    options: GetOrSetOptions<Tag>,
    staleEntry: DecodedValue | undefined,
  ): Promise<unknown> {
    const state = this.#state;
    const flightKey = this.#flightKey(stored);
    const existing = state.flights.get<unknown>(flightKey);
    if (existing !== undefined) {
      if (options.signal !== undefined) {
        state.flights.leaveOnAbort(existing, options.signal);
      }
      return withCallerSignal(state.flights.join(existing), options.signal);
    }
    const flight = state.flights.lead<unknown>(flightKey);
    if (flight === undefined) {
      // Lost a race: a flight appeared between the two calls.
      return this.#loadFlighted(key, stored, loader, options, staleEntry);
    }
    if (options.signal !== undefined) {
      state.flights.leaveOnAbort(flight, options.signal);
    }
    const deferred = createDeferred<unknown>();
    state.flights.bind(flightKey, flight, deferred.promise);
    void this.#runLeader(
      flightKey,
      flight,
      deferred,
      key,
      stored,
      loader,
      options,
      staleEntry,
      { background: false },
    );
    return withCallerSignal(deferred.promise, options.signal);
  }

  /** Resolves the `lock` option; `undefined` when no lock was asked for. */
  #resolveLock(options: GetOrSetOptions<Tag>): ResolvedLock | undefined {
    const lock = options.lock;
    if (lock === undefined || lock === false) {
      return undefined;
    }
    const asOptions: CacheLockOptions = lock === true ? {} : lock;
    const hardTimeout = options.hardTimeout ?? this.#state.options.hardTimeout;
    return {
      ttl: Math.max(1_000, asOptions.ttl ?? hardTimeout ?? DEFAULTS.lockTtl),
      waitInterval: asOptions.wait?.interval ?? DEFAULTS.lockWaitInterval,
      waitTimeout: asOptions.wait?.timeout ?? DEFAULTS.lockWaitTimeout,
    };
  }

  /**
   * The leader's work: the optional cross-process lock, then the load with
   * its soft and hard timeouts, the write with its fence, and the lock's
   * release. Settles `deferred` for every waiter; never throws out.
   */
  async #runLeader(
    flightKey: string,
    flight: Flight<unknown>,
    deferred: {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
    },
    key: string,
    stored: string,
    loader: CacheLoader<unknown>,
    options: GetOrSetOptions<Tag>,
    staleEntry: DecodedValue | undefined,
    context: {
      /** A background refresh: its outcome is a `refresh`/`error` event, and it still serves joiners. */
      background: boolean;
    },
  ): Promise<void> {
    const state = this.#state;
    const driver = state.driver;
    /** Set when this process holds the lock (and must release it). */
    let lockOwner: string | undefined;
    /** Whether the loaded value is stored — false after a lock-timeout self-load (§3.4), or once the loader called `noStore()`. */
    let stores = true;
    try {
      const lock = this.#resolveLock(options);
      if (lock !== undefined) {
        if (
          driver.capabilities.lock &&
          driver.acquireLock !== undefined &&
          driver.releaseLock !== undefined
        ) {
          const owner = crypto.randomUUID();
          const acquired = await this.#op(
            "acquireLock",
            async () =>
              await driver.acquireLock!(this.#ns, stored, owner, lock.ttl),
            false,
          );
          if (acquired) {
            lockOwner = owner;
          } else {
            const outcome = await this.#waitOnLock(
              flight,
              deferred,
              key,
              stored,
              lock,
              owner,
              options,
            );
            if (outcome === "done") {
              state.flights.settle(flightKey, flight);
              return;
            }
            if (outcome === "self") {
              // The lock wait timed out: load, but the lock holder's write
              // stays the one that counts (§3.4).
              stores = false;
            } else {
              // "lead": the lock came free and this process holds it now.
              lockOwner = owner;
            }
          }
        } else if (!state.warnedLock) {
          state.warnedLock = true;
          state.logger.warn(
            `cache: the "${driver.name}" driver has no cross-process lock; "lock" falls back to the in-process single-flight`,
            { key },
          );
        }
      }
    } catch (error) {
      deferred.reject(error);
      if (lockOwner !== undefined && driver.releaseLock !== undefined) {
        const owner = lockOwner;
        void this.#op(
          "releaseLock",
          async () => await driver.releaseLock!(this.#ns, stored, owner),
          false,
        );
      }
      state.flights.settle(flightKey, flight);
      return;
    }

    const loadStarted = state.now();
    // The L1 token is the load's, not the write's: an invalidation that lands
    // while the loader runs keeps its value out of L1 (see `#write`).
    const l1Token = state.l1?.begin();
    const hardTimeout = options.hardTimeout ?? state.options.hardTimeout;
    const softTimeout = options.softTimeout ?? state.options.softTimeout;
    let settled = false;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let softTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (): void => {
      if (l1Token !== undefined) {
        state.l1?.end();
      }
      if (softTimer !== undefined) {
        clearTimeout(softTimer);
      }
      if (hardTimer !== undefined) {
        clearTimeout(hardTimer);
      }
      if (lockOwner !== undefined && driver.releaseLock !== undefined) {
        const owner = lockOwner;
        void this.#op(
          "releaseLock",
          async () => await driver.releaseLock!(this.#ns, stored, owner),
          false,
        );
      }
      state.flights.settle(flightKey, flight);
    };

    /** The stale value served instead of a failure, when its window allows it. Answers whether it settled the waiters. */
    const serveStale = (error: unknown): boolean => {
      if (settled) {
        return true;
      }
      if (
        staleEntry !== undefined &&
        this.#withinStaleIfError(staleEntry, options)
      ) {
        settled = true;
        state.stats.staleHits++;
        this.#emit("stale-if-error", { key, namespace: this.#ns, error });
        void this.#pushFailSafeBackoff(key, stored, staleEntry);
        deferred.resolve(staleEntry.value);
        return true;
      }
      return false;
    };

    if (
      staleEntry !== undefined &&
      softTimeout !== undefined &&
      softTimeout > 0
    ) {
      softTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        state.stats.staleHits++;
        this.#emit("stale-hit", { key, namespace: this.#ns });
        deferred.resolve(staleEntry.value);
      }, softTimeout);
      softTimer.unref?.();
    }

    if (hardTimeout !== undefined && hardTimeout > 0) {
      hardTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        const error = new LoaderTimeoutError(key, hardTimeout);
        flight.abort();
        state.stats.recordLoadError(hardTimeout);
        if (!serveStale(error)) {
          settled = true;
          deferred.reject(error);
        }
      }, hardTimeout);
      hardTimer.unref?.();
    }

    let loaderPromise: Promise<unknown>;
    try {
      loaderPromise = Promise.resolve(
        loader({
          signal: flight.signal,
          noStore: () => {
            stores = false;
          },
        }),
      );
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejects with what the loader threw, unchanged
      loaderPromise = Promise.reject(error);
    }

    loaderPromise.then(
      (value) => {
        void (async () => {
          const loadMs = Math.max(0, state.now() - loadStarted);
          try {
            if (
              value === undefined &&
              !(options.cacheUndefined ?? state.options.cacheUndefined ?? false)
            ) {
              // A negative is not cached by default (§3.4).
              state.stats.recordLoad(loadMs);
              if (!settled) {
                settled = true;
                if (!context.background) {
                  this.#emit("load", {
                    key,
                    namespace: this.#ns,
                    duration: loadMs,
                    shared: flight.waiters > 1,
                  });
                }
                deferred.resolve(undefined);
              }
              return;
            }
            state.stats.recordLoad(loadMs);
            // The `load` before the `set`: the loader ran, then its value was
            // (maybe) stored.
            if (!settled && !context.background) {
              this.#emit("load", {
                key,
                namespace: this.#ns,
                duration: loadMs,
                shared: flight.waiters > 1,
              });
            }
            let storedValue = false;
            // A delete, clear or invalidateTags that landed while we loaded
            // forgot this flight (§3.4): its write is dropped — the fence
            // covers tagged keys, this covers the rest — and reported like a
            // fenced one, so listeners and stats see every dropped write.
            const forgotten = state.flights.get(flightKey) !== flight;
            if (stores && forgotten) {
              this.#reportFenced(key, options.tags ?? [], "local");
            }
            if (stores && !forgotten) {
              // `options` is read here, after the loader, not when the call
              // started: `cacheResponse()` (lib/http) fills `ttl`, `tags` and
              // the windows from the response its loader captured, and
              // `__tests__/http/` pins that down.
              storedValue = await this.#write(key, stored, value, {
                ttl: this.#ttlForLoad(value, options),
                tags: options.tags ?? [],
                createdAt: loadStarted,
                loadMs,
                staleWhileRevalidate:
                  options.staleWhileRevalidate ??
                  state.options.staleWhileRevalidate ??
                  0,
                staleIfError:
                  options.staleIfError ?? state.options.staleIfError ?? 0,
                negative: value === undefined,
                tier: options.tier,
                compress: options.compress,
                l1Token,
              });
            }
            if (context.background && storedValue) {
              this.#emit("refresh", {
                key,
                namespace: this.#ns,
                duration: loadMs,
              });
            }
            if (!settled) {
              settled = true;
              deferred.resolve(value);
            }
          } catch (error) {
            state.stats.recordLoadError(loadMs);
            if (!settled) {
              if (!serveStale(error)) {
                settled = true;
                deferred.reject(error);
              }
            } else {
              this.#emit("error", {
                key,
                namespace: this.#ns,
                phase: context.background ? "refresh" : "driver",
                driver: driver.name,
                error,
              });
            }
          } finally {
            finish();
          }
        })();
      },
      (error: unknown) => {
        void (async () => {
          const loadMs = Math.max(0, state.now() - loadStarted);
          try {
            state.stats.recordLoadError(loadMs);
            if (settled) {
              // The waiters already have the stale value (soft timeout) or a
              // hard-timeout verdict; a late failure is an event, never a
              // throw (§3.5).
              this.#emit("error", {
                key,
                namespace: this.#ns,
                phase: "refresh",
                driver: driver.name,
                error,
              });
              if (staleEntry !== undefined) {
                await this.#pushFailSafeBackoff(key, stored, staleEntry);
              }
              return;
            }
            if (context.background) {
              // A failed refresh emits `error` and keeps the stale value;
              // it never throws into a caller (§3.5). A joiner gets the
              // stale value when there is one, the error otherwise.
              settled = true;
              this.#emit("error", {
                key,
                namespace: this.#ns,
                phase: "refresh",
                driver: driver.name,
                error,
              });
              if (staleEntry !== undefined) {
                await this.#pushFailSafeBackoff(key, stored, staleEntry);
                deferred.resolve(staleEntry.value);
              } else {
                deferred.reject(error);
              }
              return;
            }
            if (!serveStale(error)) {
              settled = true;
              deferred.reject(error);
            }
          } finally {
            finish();
          }
        })();
      },
    );
  }

  /** Whether `staleEntry` is inside its stale-if-error window right now. */
  #withinStaleIfError(
    staleEntry: DecodedValue,
    options: GetOrSetOptions<Tag>,
  ): boolean {
    const sie = options.staleIfError ?? this.#state.options.staleIfError ?? 0;
    if (sie <= 0 || staleEntry.freshUntil === null) {
      return false;
    }
    return this.#state.now() <= staleEntry.freshUntil + sie;
  }

  /**
   * After a failed refresh, pushes the stale value's freshness forward by
   * `failSafeBackoff` (never past its hard expiry), so the origin sees one
   * retry per backoff instead of one per request (§3.5). Best-effort.
   */
  async #pushFailSafeBackoff(
    key: string,
    stored: string,
    staleEntry: DecodedValue,
  ): Promise<void> {
    const state = this.#state;
    const backoff = state.options.failSafeBackoff ?? DEFAULTS.failSafeBackoff;
    if (backoff <= 0 || staleEntry.freshUntil === null) {
      return;
    }
    try {
      const now = state.now();
      const hardExpiry = staleEntry.expiresAt;
      const capped =
        hardExpiry !== null
          ? Math.min(now + backoff, hardExpiry)
          : now + backoff;
      await this.#op(
        "set",
        async () => {
          const encoding = this.#encodeValue(
            staleEntry.value,
            staleEntry.negative,
            staleEntry.uncompressed === true ? false : undefined,
          );
          const { codecId, flags, compressor, payload } = isPromiseLike(
            encoding,
          )
            ? await encoding
            : encoding;
          return await state.driver.set(this.#ns, {
            key: stored,
            value: encodeEntry(
              {
                codecId,
                flags,
                compressor,
                createdAt: staleEntry.createdAt,
                freshUntil: capped,
                loadMs: staleEntry.loadMs,
                key,
              },
              payload,
            ),
            expiresAt: staleEntry.expiresAt,
            tags: staleEntry.tags,
          });
        },
        "fenced" as const,
      );
    } catch (error) {
      state.logger.warn("cache: failed to push a stale value's backoff", {
        error,
        key,
      });
    }
  }

  /**
   * The lock loser's wait (§3.4): poll for the winner's value until it
   * appears, the lock frees (and we lead), or `wait.timeout` passes — then
   * `onLockTimeout`: load without storing (`"load"`), or throw (`"throw"`).
   */
  async #waitOnLock(
    flight: Flight<unknown>,
    deferred: {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
    },
    key: string,
    stored: string,
    lock: ResolvedLock,
    owner: string,
    options: GetOrSetOptions<Tag>,
  ): Promise<"lead" | "self" | "done"> {
    const state = this.#state;
    const driver = state.driver;
    state.stats.lockWaits++;
    this.#emit("lock-wait", { key, namespace: this.#ns });
    const deadline = Date.now() + lock.waitTimeout;
    let attempt = 0;
    while (Date.now() < deadline) {
      if (flight.signal.aborted) {
        // Nobody is waiting any more; nothing to resolve.
        return "done";
      }
      await sleep(Math.min(lock.waitInterval * 1.5 ** attempt, 1_000), {
        unref: true,
      }).catch(() => {});
      attempt++;
      const read = await this.#readStored(key, stored);
      if (read.kind === "fresh") {
        deferred.resolve(read.entry.value);
        return "done";
      }
      if (
        (await this.#op(
          "acquireLock",
          async () =>
            await driver.acquireLock!(this.#ns, stored, owner, lock.ttl),
          false,
        )) === true
      ) {
        return "lead";
      }
    }
    this.#emit("lock-timeout", { key, namespace: this.#ns });
    if (options.onLockTimeout === "throw") {
      deferred.reject(
        new LoaderTimeoutError(key, lock.waitTimeout, "the cache lock"),
      );
      return "done";
    }
    return "self";
  }

  /**
   * A background refresh (§3.5): through the same single-flight, so a burst
   * of stale hits starts one refresh. Its outcome is a `refresh` or `error`
   * event; it never throws into a caller.
   */
  #backgroundRefresh(
    key: string,
    stored: string,
    loader: CacheLoader<unknown>,
    options: GetOrSetOptions<Tag>,
    staleEntry: DecodedValue | undefined,
  ): void {
    const state = this.#state;
    const flightKey = this.#flightKey(stored);
    const flight = state.flights.lead<unknown>(flightKey);
    if (flight === undefined) {
      return;
    }
    const deferred = createDeferred<unknown>();
    state.flights.bind(flightKey, flight, deferred.promise);
    void this.#runLeader(
      flightKey,
      flight,
      deferred,
      key,
      stored,
      loader,
      options,
      staleEntry,
      { background: true },
    );
  }

  /** On a fresh `getOrSet` hit: eager refresh near expiry (`refreshAhead`), or probabilistic early expiry (`earlyExpiry`, §3.5). */
  #maybeEagerRefresh(
    key: string,
    stored: string,
    entry: DecodedValue,
    loader: CacheLoader<unknown>,
    options: GetOrSetOptions<Tag>,
  ): void {
    const state = this.#state;
    const now = state.now();
    const refreshAhead =
      options.refreshAhead ?? state.options.refreshAhead ?? 0;
    if (refreshAhead > 0 && entry.freshUntil !== null && !entry.negative) {
      const window = entry.freshUntil - entry.createdAt;
      if (window > 0 && now >= entry.freshUntil - window * refreshAhead) {
        this.#backgroundRefresh(key, stored, loader, options, entry);
        return;
      }
    }
    const earlyExpiry = options.earlyExpiry ?? state.options.earlyExpiry;
    if (
      earlyExpiry !== undefined &&
      entry.loadMs > 0 &&
      entry.freshUntil !== null
    ) {
      const rand = Math.max(state.random(), Number.EPSILON);
      if (
        now - entry.loadMs * earlyExpiry.beta * Math.log(rand) >=
        entry.freshUntil
      ) {
        this.#backgroundRefresh(key, stored, loader, options, entry);
      }
    }
  }

  /** The TTL of a loaded value: the negative marker's own when that applies, then the call's or the cache's. */
  #ttlForLoad(value: unknown, options: GetOrSetOptions<Tag>): number | null {
    if (value === undefined) {
      const negativeTtl =
        options.negativeTtl ?? this.#state.options.negativeTtl;
      if (negativeTtl !== undefined) {
        return negativeTtl;
      }
    }
    return this.#resolveTtl(value, options);
  }

  /* ---------------------------------------------------------------- */
  /* the public API                                                    */
  /* ---------------------------------------------------------------- */

  async get<K extends Extract<keyof Schema, string>>(
    key: K,
    options?: { tier?: "l2" },
  ): Promise<Schema[K] | undefined> {
    const { read, tier } = await this.#read(
      key,
      this.#storedKey(key),
      options?.tier,
    );
    if (read.kind === "fresh") {
      this.#state.stats.hits++;
      this.#emit("hit", { key, namespace: this.#ns, tier });
      return read.entry.value as Schema[K] | undefined;
    }
    this.#state.stats.misses++;
    this.#emit("miss", { key, namespace: this.#ns });
    return undefined;
  }

  async getEntry<K extends Extract<keyof Schema, string>>(
    key: K,
    options?: { tier?: "l2" },
  ): Promise<CacheEntry<Schema[K]> | undefined> {
    const { read, tier } = await this.#read(
      key,
      this.#storedKey(key),
      options?.tier,
    );
    if (read.kind === "miss") {
      this.#state.stats.misses++;
      this.#emit("miss", { key, namespace: this.#ns });
      return undefined;
    }
    if (read.kind === "fresh") {
      this.#state.stats.hits++;
      this.#emit("hit", { key, namespace: this.#ns, tier });
    } else {
      this.#state.stats.staleHits++;
      this.#emit("stale-hit", { key, namespace: this.#ns });
    }
    const { entry } = read;
    return {
      key,
      value: entry.value as Schema[K],
      createdAt: entry.createdAt,
      freshUntil: entry.freshUntil,
      expiresAt: entry.expiresAt,
      tags: entry.tags,
      stale: read.kind === "stale",
    };
  }

  async has<K extends Extract<keyof Schema, string>>(
    key: K,
    options?: { tier?: "l2" },
  ): Promise<boolean> {
    const { read } = await this.#read(key, this.#storedKey(key), options?.tier);
    return read.kind === "fresh";
  }

  async getMany<K extends Extract<keyof Schema, string>>(
    keys: readonly K[],
    options?: { tier?: "l2" },
  ): Promise<(Schema[K] | undefined)[]> {
    const state = this.#state;
    const stored = keys.map((key) => this.#storedKey(key));
    const l1 = options?.tier === "l2" ? undefined : state.l1;
    /** Each key's L1 copy, when L1 has a fresh one. */
    const copies = stored.map((key) => {
      if (l1 === undefined) {
        return undefined;
      }
      const copy = l1.get(this.#ns, key, state.now());
      if (copy === undefined) {
        l1.counts.misses++;
      } else {
        l1.counts.hits++;
      }
      return copy;
    });
    /** The indexes L1 could not answer, in order: the driver's batch. */
    const wanted = keys.flatMap((_key, index) =>
      copies[index] === undefined ? [index] : [],
    );
    const token = l1?.begin() ?? 0;
    try {
      const raws =
        wanted.length === 0
          ? []
          : await this.#op<(StoredEntry | undefined)[] | typeof FAILED>(
              "getMany",
              async () =>
                await state.driver.getMany(
                  this.#ns,
                  wanted.map((index) => stored[index]),
                ),
              FAILED,
            );
      const rawFor = new Map<number, StoredEntry | undefined>();
      if (raws !== FAILED) {
        wanted.forEach((index, at) => rawFor.set(index, raws[at]));
      }
      return await Promise.all(
        keys.map(async (key, index) => {
          const copy = copies[index];
          if (copy !== undefined) {
            state.stats.hits++;
            this.#emit("hit", { key, namespace: this.#ns, tier: "l1" });
            return copy.value as Schema[K] | undefined;
          }
          // A failed batch is a miss for every key, without per-key retries —
          // they would each count against the circuit.
          const raw = rawFor.get(index);
          const read =
            raws === FAILED
              ? ({ kind: "miss" } as const)
              : raw === undefined
                ? await this.#readStored(key, stored[index])
                : await this.#decodeStored(key, stored[index], raw);
          if (l1 !== undefined) {
            this.#fillL1(stored[index], read, token);
          }
          if (read.kind === "fresh") {
            state.stats.hits++;
            this.#emit("hit", { key, namespace: this.#ns, tier: "l2" });
            return read.entry.value as Schema[K] | undefined;
          }
          state.stats.misses++;
          this.#emit("miss", { key, namespace: this.#ns });
          return undefined;
        }),
      );
    } finally {
      l1?.end();
    }
  }

  async set<K extends Extract<keyof Schema, string>>(
    key: K,
    value: Schema[K],
    options?: SetOptions<Tag>,
  ): Promise<boolean> {
    return await this.#write(key, this.#storedKey(key), value, {
      ttl: this.#resolveTtl(value, options),
      tags: options?.tags ?? [],
      createdAt: this.#state.now(),
      loadMs: 0,
      staleWhileRevalidate:
        options?.staleWhileRevalidate ??
        this.#state.options.staleWhileRevalidate ??
        0,
      staleIfError:
        options?.staleIfError ?? this.#state.options.staleIfError ?? 0,
      negative: false,
      tier: options?.tier,
      compress: options?.compress,
    });
  }

  async setMany<K extends Extract<keyof Schema, string>>(
    entries: readonly (readonly [
      K,
      Schema[K],
      (SetOptions<Tag> | undefined)?,
    ])[],
  ): Promise<number> {
    let stored = 0;
    for (const [key, value, options] of entries) {
      if (await this.set(key, value, options)) {
        stored++;
      }
    }
    return stored;
  }

  async touch<K extends Extract<keyof Schema, string>>(
    key: K,
    ttl: number | null,
  ): Promise<boolean> {
    const state = this.#state;
    const stored = this.#storedKey(key);
    const now = state.now();
    const expiresAt = ttl === null ? null : now + ttl;
    const raw = await this.#op(
      "get",
      async () => await state.driver.get(this.#ns, stored),
      undefined,
    );
    if (raw !== undefined && (raw.expiresAt === null || raw.expiresAt > now)) {
      try {
        const decoding = this.#decodeValue(raw.value, key);
        const decoded = isPromiseLike(decoding) ? await decoding : decoding;
        // Keep the stale window's width; slide the freshness (a driver-level
        // `touch` cannot: `freshUntil` lives in the header, §3.2).
        const window =
          raw.expiresAt !== null && decoded.header.freshUntil !== NO_FRESH_UNTIL
            ? Math.max(0, raw.expiresAt - decoded.header.freshUntil)
            : 0;
        return await this.#write(key, stored, decoded.value, {
          ttl,
          tags: raw.tags as readonly Tag[],
          createdAt: decoded.header.createdAt,
          loadMs: decoded.header.loadMs,
          staleWhileRevalidate: window,
          staleIfError: 0,
          negative: decoded.negative,
          // An entry stored uncompressed (a per-call `compress: false`, or
          // under the threshold) stays so.
          compress:
            decoded.header.compressor === COMPRESSOR_IDS.none
              ? false
              : undefined,
        });
      } catch {
        return false;
      }
    }
    // A counter has no entry bytes; the driver's own `touch` covers it.
    if (
      state.driver.touch !== undefined &&
      state.driver.getCounter !== undefined
    ) {
      const counter = await this.#op(
        "getCounter",
        async () => await state.driver.getCounter?.(this.#ns, stored),
        undefined,
      );
      if (counter !== undefined) {
        return await this.#op(
          "touch",
          async () => await state.driver.touch!(this.#ns, stored, expiresAt),
          false,
        );
      }
    }
    return false;
  }

  async delete<K extends Extract<keyof Schema, string>>(
    key: K,
  ): Promise<boolean> {
    const stored = this.#storedKey(key);
    // A delete forgets the flight (§3.4): callers arriving afterwards load
    // afresh, and the forgotten leader's write is dropped.
    this.#state.flights.forget(this.#flightKey(stored));
    const count = await this.#op(
      "delete",
      async () => await this.#state.driver.delete(this.#ns, [stored]),
      0,
    );
    // §4.1: L2, then L1, then the bus.
    this.#state.l1?.invalidateKeys(this.#ns, [stored]);
    await this.#publish({ type: "delete", keys: [stored] });
    if (count > 0) {
      this.#state.stats.deletes += count;
      this.#emit("delete", { key, namespace: this.#ns });
      return true;
    }
    return false;
  }

  async deleteMany<K extends Extract<keyof Schema, string>>(
    keys: readonly K[],
  ): Promise<number> {
    const stored = keys.map((key) => this.#storedKey(key));
    for (const key of stored) {
      this.#state.flights.forget(this.#flightKey(key));
    }
    const count = await this.#op(
      "delete",
      async () => await this.#state.driver.delete(this.#ns, stored),
      0,
    );
    this.#state.l1?.invalidateKeys(this.#ns, stored);
    await this.#publish({ type: "delete", keys: stored });
    this.#state.stats.deletes += count;
    return count;
  }

  async clear(): Promise<void> {
    this.#state.flights.forgetAll(`${this.#ns}\n`);
    await this.#op(
      "clear",
      async () => await this.#state.driver.clear(this.#ns),
      undefined,
    );
    this.#state.l1?.invalidateNamespace(this.#ns);
    await this.#publish({ type: "clear" });
  }

  async invalidateTags(
    tags: readonly Tag[],
    options?: { mode?: "delete" | "stale" },
  ): Promise<void> {
    if (options?.mode === "stale") {
      throw new UnsupportedOperationError(
        this.#state.driver.name,
        'invalidateTags mode "stale"',
        "a soft purge ships in a later PR (plan §3.6, R21)",
      );
    }
    if (tags.length === 0) {
      return;
    }
    const state = this.#state;
    // Forget this namespace's flights: a load in flight for a tagged key must
    // not be joined (§3.4); its write is fenced or dropped.
    state.flights.forgetAll(`${this.#ns}\n`);
    const now = state.now();
    const until = now + this.#tagStampTtl();
    const driver = state.driver;
    if (
      driver.capabilities.tags === "index" &&
      driver.deleteByTags !== undefined
    ) {
      const count = await this.#op(
        "deleteByTags",
        async () => await driver.deleteByTags!(this.#ns, tags, until),
        0,
      );
      state.stats.deletes += count;
    } else {
      await this.#op(
        "setStamps",
        async () => await driver.setStamps(this.#ns, tags, now, until),
        undefined,
      );
      // This process sees the invalidation at once, cache or no cache.
      const expires =
        Date.now() +
        (state.options.tagStampCacheMs ?? DEFAULTS.tagStampCacheMs);
      for (const tag of tags) {
        state.stampCache.set(`${this.#ns}\n${tag}`, { at: now, expires });
      }
    }
    state.l1?.invalidateTags(this.#ns, tags);
    await this.#publish({ type: "invalidate-tags", tags });
    this.#emit("invalidate", { namespace: this.#ns, tags });
  }

  /** The stamp TTL: the cache's longest entry lifetime, capped at 24 h (§3.6). */
  #tagStampTtl(): number {
    const options = this.#state.options;
    if (options.tagStampTtl !== undefined) {
      return options.tagStampTtl;
    }
    const ttl = typeof options.ttl === "number" ? options.ttl : null;
    if (ttl === null) {
      return DEFAULTS.tagStampTtlCap;
    }
    return Math.min(
      ttl +
        Math.max(options.staleWhileRevalidate ?? 0, options.staleIfError ?? 0),
      DEFAULTS.tagStampTtlCap,
    );
  }

  async getOrSet<K extends Extract<keyof Schema, string>>(
    key: K,
    loader: CacheLoader<Schema[K]>,
    options: GetOrSetOptions<Tag> = {},
  ): Promise<Schema[K] | undefined> {
    const stored = this.#storedKey(key);
    const { read, tier } = await this.#read(key, stored, options.tier);
    const now = this.#state.now();
    if (read.kind === "fresh") {
      this.#state.stats.hits++;
      this.#emit("hit", { key, namespace: this.#ns, tier });
      this.#maybeEagerRefresh(
        key,
        stored,
        read.entry,
        loader as CacheLoader<unknown>,
        options,
      );
      return read.entry.value as Schema[K] | undefined;
    }
    if (read.kind === "stale") {
      const swr =
        options.staleWhileRevalidate ??
        this.#state.options.staleWhileRevalidate ??
        0;
      if (
        swr > 0 &&
        read.entry.freshUntil !== null &&
        now <= read.entry.freshUntil + swr
      ) {
        this.#state.stats.staleHits++;
        this.#emit("stale-hit", { key, namespace: this.#ns });
        this.#backgroundRefresh(
          key,
          stored,
          loader as CacheLoader<unknown>,
          options,
          read.entry,
        );
        return read.entry.value as Schema[K] | undefined;
      }
      // Outside the window: load, with the stale entry kept for
      // stale-if-error and the soft timeout.
      this.#state.stats.misses++;
      this.#emit("miss", { key, namespace: this.#ns });
      return (await this.#loadFlighted(
        key,
        stored,
        loader as CacheLoader<unknown>,
        options,
        read.entry,
      )) as Schema[K] | undefined;
    }
    this.#state.stats.misses++;
    this.#emit("miss", { key, namespace: this.#ns });
    return (await this.#loadFlighted(
      key,
      stored,
      loader as CacheLoader<unknown>,
      options,
      undefined,
    )) as Schema[K] | undefined;
  }

  wrap<Args extends unknown[], K extends Extract<keyof Schema, string>>(
    fn: (...args: Args) => Promise<Schema[K]>,
    options: {
      /** Builds the cache key from `fn`'s arguments. */
      key: (...args: Args) => K;
    } & GetOrSetOptions<Tag>,
  ): (...args: Args) => Promise<Schema[K] | undefined> {
    const { key, ...rest } = options;
    return async (...args: Args) =>
      await this.getOrSet(key(...args), async () => await fn(...args), rest);
  }

  increment: Cache<Schema, Tag>["increment"] = async (key, by = 1, options) => {
    const state = this.#state;
    const driver = state.driver;
    if (
      driver.increment === undefined ||
      !driver.capabilities.atomicIncrement
    ) {
      throw new UnsupportedOperationError(
        driver.name,
        "increment",
        "the driver does not advertise atomicIncrement",
      );
    }
    const stored = this.#storedKey(key);
    const ttl = options?.ttl;
    const expiresAt =
      ttl === undefined || ttl === null ? null : state.now() + ttl;
    // There is no honest fallback value for a counter: a failed increment
    // throws even under the default policy (§3.14 covers reads and plain writes).
    return await this.#opStrict("increment", async () => {
      state.flights.forget(this.#flightKey(stored));
      return await driver.increment!(this.#ns, stored, by, expiresAt);
    });
  };

  decrement: Cache<Schema, Tag>["decrement"] = async (key, by = 1, options) =>
    await this.increment(key, -by, options);

  /**
   * {@link #op} for operations with no honest fallback (counters): the
   * circuit and the wrapping apply, but a failure throws even without
   * `strict`.
   */
  async #opStrict<T>(op: string, run: () => Promise<T>): Promise<T> {
    const state = this.#state;
    const now = state.now();
    if (state.circuit.openUntil > now) {
      throw new CircuitOpenError(state.driver.name, state.circuit.openUntil);
    }
    try {
      return await run();
    } catch (cause) {
      const error =
        cause instanceof CacheDriverError
          ? cause
          : new CacheDriverError({ driver: state.driver.name, op, cause });
      this.#emit("error", {
        phase: "driver",
        driver: state.driver.name,
        error,
      });
      throw error;
    }
  }

  namespace(name: string): Cache<Schema, Tag> {
    const segment = checkNamespace(name, "namespace(name)");
    return new CacheImpl<Schema, Tag>(this.#state, `${this.#ns}:${segment}`);
  }

  on<E extends CacheEvent>(
    event: E,
    listener: (payload: CacheEventMap[E]) => void,
  ): () => void {
    return this.#state.events.on(event, listener);
  }

  stats(options?: { reset?: boolean }): CacheStats {
    const snapshot = this.#state.stats.stats(options);
    const l1 = this.#state.l1;
    if (l1 !== undefined) {
      snapshot.l1 = { ...l1.counts, entries: l1.entries, bytes: l1.bytes };
      if (options?.reset === true) {
        l1.counts = {
          hits: 0,
          misses: 0,
          backfills: 0,
          invalidations: 0,
          evictions: 0,
          flushes: 0,
        };
      }
    }
    return snapshot;
  }

  async close(): Promise<void> {
    const state = this.#state;
    if (state.closed) {
      return;
    }
    state.closed = true;
    if (state.sweepTimer !== undefined) {
      clearInterval(state.sweepTimer);
      state.sweepTimer = undefined;
    }
    // The bus first: its queued publishes go out, and the driver's own bus
    // is unsubscribed before the driver closes under it.
    await state.bus?.close();
    state.l1?.clear();
    await state.driver.close();
  }

  async syncSchema(options?: SchemaSyncOptions): Promise<SchemaChange[]> {
    return (await this.#state.driver.syncSchema?.(options)) ?? [];
  }

  /**
   * The sweeper (§6.1): the core calls the driver's `sweep` on an unref'd
   * timer, under the driver's lock when it has one, so one process sweeps at
   * a time. Runs once per shared state, not per namespace view.
   */
  #startSweep(): void {
    const state = this.#state;
    const driver = state.driver;
    if (state.sweepTimer !== undefined || driver.sweep === undefined) {
      return;
    }
    const sweepInterval = state.options.sweepInterval ?? DEFAULTS.sweepInterval;
    if (!(sweepInterval > 0)) {
      return;
    }
    state.sweepTimer = setInterval(() => {
      void (async () => {
        if (state.closed) {
          return;
        }
        let owner: string | undefined;
        try {
          if (
            driver.acquireLock !== undefined &&
            driver.releaseLock !== undefined
          ) {
            owner = crypto.randomUUID();
            const got = await this.#op(
              "acquireLock",
              async () =>
                await driver.acquireLock!(
                  SWEEP_NAMESPACE,
                  "sweep",
                  owner!,
                  sweepInterval * 2,
                ),
              false,
            );
            if (!got) {
              return;
            }
          }
          await this.#op(
            "sweep",
            async () => await driver.sweep!(state.now(), DEFAULTS.sweepLimit),
            0,
          );
        } finally {
          if (owner !== undefined && driver.releaseLock !== undefined) {
            const held = owner;
            void this.#op(
              "releaseLock",
              async () =>
                await driver.releaseLock!(SWEEP_NAMESPACE, "sweep", held),
              false,
            );
          }
        }
      })();
    }, sweepInterval);
    state.sweepTimer.unref?.();
  }
}

/** Rejects a waiter's promise when its own signal aborts; the flight itself aborts only when every waiter has (§3.4). */
function withCallerSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  if (signal.aborted) {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejects with the caller's own abort reason, unchanged
    return Promise.reject(signal.reason as unknown);
  }
  return new Promise<T>((resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejects with the caller's own abort reason, unchanged
        reject(signal.reason as unknown);
      },
      { once: true },
    );
    promise.then(resolve, reject);
  });
}

/**
 * Creates a cache (plan §3.1). With `validate` (V10) and no explicit schema
 * type, the cache's type is inferred from the schemas
 * ({@link CacheSchemaFrom}); with `codec: "json"`, every value's type is its
 * JSON view ({@link JsonifySchema}, §3.13).
 */
export function createCache<
  M extends Record<string, StandardSchemaV1>,
  Tag extends string = string,
>(
  options: CreateCacheOptions & { validate: M },
): Cache<CacheSchemaFrom<M>, Tag>;
export function createCache<
  Schema extends CacheSchema = Record<string, unknown>,
  Tag extends string = string,
>(
  options: CreateCacheOptions & { codec: "json" },
): Cache<JsonifySchema<Schema>, Tag>;
export function createCache<
  Schema extends CacheSchema = Record<string, unknown>,
  Tag extends string = string,
>(options: CreateCacheOptions): Cache<Schema, Tag>;
export function createCache(
  options: CreateCacheOptions,
): Cache<Record<string, unknown>, string> {
  const now = options.now ?? Date.now;
  const logger = resolveLogger(options.logger, noopLogger);
  const codec = resolveCodec(options.codec);
  const compress = resolveCompress(
    options.compress,
    DEFAULTS.compressThreshold,
  );
  const validators = {
    exact: new Map<string, StandardSchemaV1>(),
    prefixes: [] as { prefix: string; schema: StandardSchemaV1 }[],
  };
  for (const [pattern, schema] of Object.entries(options.validate ?? {})) {
    if (pattern.endsWith("*")) {
      validators.prefixes.push({ prefix: pattern.slice(0, -1), schema });
    } else {
      validators.exact.set(pattern, schema);
    }
  }
  const state: SharedState = {
    driver: options.driver,
    codec,
    customCodec: typeof options.codec === "object" ? options.codec : undefined,
    compress: compress.write,
    userCompressors: compress.user,
    options,
    logger,
    now,
    random: options.random ?? Math.random,
    events: new CacheEvents(logger),
    stats: new CacheStatsCounter(now),
    flights: new FlightMap(),
    circuit: { failures: 0, openUntil: 0, probing: false },
    lastWarnAt: 0,
    warnedLock: false,
    stampCache: new Map(),
    validators,
    sweepTimer: undefined,
    closed: false,
    l1: resolveL1(options.l1),
    bus: undefined,
    lastBusWarnAt: 0,
  };
  const namespace = fullNamespace(
    options.namespace ?? DEFAULTS.namespace,
    options.version,
  );
  const cache = new CacheImpl(state, namespace);
  // Driver-side evictions (the memory driver's caps) are `evict` events.
  options.driver.onEviction?.((ns, key, reason) => {
    state.stats.evictions++;
    state.events.emit("evict", { key, namespace: ns, reason });
  });
  state.bus = linkBus(state);
  state.bus?.start();
  return cache as Cache<Record<string, unknown>, string>;
}

/** Resolves the `l1` option into a store; `undefined` without one. */
function resolveL1(
  l1: CreateCacheOptions["l1"],
): L1Store<DecodedValue> | undefined {
  if (l1 === undefined) {
    return undefined;
  }
  const given = l1 === true ? {} : l1;
  const positive = (
    name: string,
    value: number | undefined,
    fallback: number,
  ) => {
    const resolved = value ?? fallback;
    if (!(resolved > 0)) {
      throw new RangeError(
        `createCache: l1.${name} must be a positive number, got ${String(value)}`,
      );
    }
    return resolved;
  };
  return new L1Store<DecodedValue>({
    maxEntries: positive("maxEntries", given.maxEntries, DEFAULTS.l1MaxEntries),
    maxBytes: positive("maxBytes", given.maxBytes, DEFAULTS.l1MaxBytes),
    ttl: positive("ttl", given.ttl, DEFAULTS.l1Ttl),
    clone: given.clone ?? false,
  });
}

/**
 * The cache's bus (§4.2), from the `bus` option — `"auto"` (the default with
 * an `l1`) is the driver's own — wired to the L1 and the tag-stamp cache;
 * `undefined` when there is none.
 */
function linkBus(state: SharedState): BusLink | undefined {
  const option = state.options.bus ?? (state.l1 === undefined ? false : "auto");
  if (option === false) {
    return undefined;
  }
  const bus: CacheBus | undefined =
    option === "auto" ? driverBus(state.driver) : option;
  if (bus === undefined) {
    if (state.l1 !== undefined) {
      state.logger.info(
        `cache: the "${state.driver.name}" driver has no bus, so an L1 copy can be stale for up to l1.ttl (${state.l1.options.ttl} ms) after another process changes it`,
      );
    }
    return undefined;
  }
  const flush = (): void => {
    state.l1?.flush();
    state.stampCache.clear();
  };
  // L1 serves nothing until the bus listens (or fails to): see `L1Store`.
  state.l1?.disarm();
  return new BusLink(bus, option !== "auto", {
    onMessage: (message) => {
      applyBusMessage(state, message, flush);
    },
    onFlush: flush,
    onError: (error) => {
      // A bus that cannot subscribe leaves L1 bounded by `l1.ttl` (§4.3).
      state.l1?.arm();
      state.events.emit("error", {
        phase: "bus",
        driver: bus.name,
        error,
      });
      const now = Date.now();
      if (now - state.lastBusWarnAt >= WARN_EVERY_MS) {
        state.lastBusWarnAt = now;
        state.logger.warn(`cache bus "${bus.name}" failed`, { error });
      }
    },
  });
}

/** Applies another cache's bus message: drops L1 copies, and pushes tag invalidations into the stamp cache (§3.6, §4.2). */
function applyBusMessage(
  state: SharedState,
  message: BusMessage,
  flush: () => void,
): void {
  const ns = message.namespace;
  if (typeof ns !== "string") {
    // Not a message this package wrote: the only safe reading is "anything".
    flush();
    return;
  }
  switch (message.type) {
    case "set":
    case "delete":
      if (message.keys === undefined) {
        state.l1?.invalidateNamespace(ns);
      } else {
        state.l1?.invalidateKeys(ns, message.keys);
      }
      return;
    case "invalidate-tags": {
      const tags = message.tags ?? [];
      state.l1?.invalidateTags(ns, tags);
      // The next stamps-mode read of these tags asks the driver again.
      for (const tag of tags) {
        state.stampCache.delete(`${ns}\n${tag}`);
      }
      return;
    }
    case "clear":
      state.l1?.invalidateNamespace(ns);
      return;
    default:
      flush();
  }
}
