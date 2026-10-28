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
import {
  CacheDriverError,
  CircuitOpenError,
  EntryTooLargeError,
  LoaderTimeoutError,
  UnsupportedOperationError,
} from "./errors";
import { CacheEvents } from "./events";
import type { Flight } from "./flight";
import { FlightMap } from "./flight";
import type { EntryHeader } from "./header";
import {
  decodeEntry,
  encodeEntry,
  ENTRY_FLAGS,
  NO_FRESH_UNTIL,
} from "./header";
import { checkNamespace, fullNamespace, storedKey } from "./keys";
import { CacheStatsCounter } from "./stats";
import type {
  Cache,
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
}

/** The outcome of the read pipeline. */
type ReadOutcome =
  | { kind: "fresh"; entry: DecodedValue }
  | { kind: "stale"; entry: DecodedValue }
  | { kind: "miss" };

/** What the decoder produced. */
interface Decoded {
  /** The decoded value; `undefined` for a negative marker. */
  value: unknown;
  /** Whether this is a negative marker. */
  negative: boolean;
  /** The entry's header. */
  header: EntryHeader;
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
  /** The compression options; `undefined` when disabled. */
  compress:
    | { algorithm: "zstd" | "gzip"; threshold: number; level?: number }
    | undefined;
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

  /** Encodes a value into the payload bytes and the header's codec/flags fields. */
  #encodeValue(
    value: unknown,
    negative: boolean,
  ): { codecId: number; flags: number; payload: Uint8Array } {
    const state = this.#state;
    if (negative) {
      return {
        codecId: state.codec.id,
        flags: ENTRY_FLAGS.negative,
        payload: new Uint8Array(0),
      };
    }
    let flags = 0;
    let payload = state.codec.encode(value);
    if (state.codec.id === CODEC_IDS.raw && typeof value === "string") {
      flags |= ENTRY_FLAGS.rawString;
    }
    const compress = state.compress;
    if (compress !== undefined && payload.byteLength >= compress.threshold) {
      const compressed =
        compress.algorithm === "gzip"
          ? Bun.gzipSync(
              payload.slice(),
              compress.level === undefined
                ? undefined
                : {
                    level: compress.level as
                      0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9,
                  },
            )
          : Bun.zstdCompressSync(
              payload.slice(),
              compress.level === undefined
                ? undefined
                : { level: compress.level },
            );
      if (compressed.byteLength < payload.byteLength) {
        payload = compressed;
        flags |=
          compress.algorithm === "gzip" ? ENTRY_FLAGS.gzip : ENTRY_FLAGS.zstd;
      }
    }
    return { codecId: state.codec.id, flags, payload };
  }

  /** Decodes a stored entry's bytes. Throws (→ a miss with an `error` event) on any corruption, a key mismatch, or an unknown codec. */
  #decodeValue(bytes: Uint8Array, key: string): Decoded {
    const { header, payload: rawPayload } = decodeEntry(bytes);
    if (header.key !== key) {
      // The key was hashed for storage and this entry's full key differs: a
      // hash collision (§3.7). A miss, never the wrong value.
      throw new Error(
        "the stored entry's key does not match (a long-key hash collision)",
      );
    }
    let payload = rawPayload;
    if ((header.flags & ENTRY_FLAGS.zstd) !== 0) {
      payload = Bun.zstdDecompressSync(payload.slice());
    } else if ((header.flags & ENTRY_FLAGS.gzip) !== 0) {
      payload = Bun.gunzipSync(payload.slice());
    }
    if ((header.flags & ENTRY_FLAGS.negative) !== 0) {
      return { value: undefined, negative: true, header };
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
    return { value, negative: false, header };
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
      decoded = this.#decodeValue(raw.value, key);
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
    };
    if (freshUntil !== null && now > freshUntil) {
      return { kind: "stale", entry };
    }
    return { kind: "fresh", entry };
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
    },
  ): Promise<boolean> {
    const state = this.#state;
    const now = state.now();
    const { codecId, flags, payload } = this.#encodeValue(value, init.negative);
    const freshUntil = init.ttl === null ? NO_FRESH_UNTIL : now + init.ttl;
    const expiresAt =
      init.ttl === null
        ? null
        : freshUntil +
          Math.max(init.staleWhileRevalidate, init.staleIfError, 0);
    const bytes = encodeEntry(
      {
        codecId,
        flags,
        createdAt: init.createdAt,
        freshUntil,
        loadMs: init.loadMs,
        key,
      },
      payload,
    );
    const limit = Math.min(
      state.options.maxEntryBytes ?? DEFAULTS.maxEntryBytes,
      state.driver.capabilities.maxEntryBytes ?? Number.POSITIVE_INFINITY,
    );
    if (bytes.byteLength > limit) {
      const error = new EntryTooLargeError(key, bytes.byteLength, limit);
      this.#emit("oversize", {
        key,
        namespace: this.#ns,
        bytes: bytes.byteLength,
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
    const result = await this.#op(
      "set",
      async () => await state.driver.set(this.#ns, entry, fence),
      "fenced" as const,
    );
    if (result === "fenced") {
      this.#reportFenced(key, init.tags, "fence");
      return false;
    }
    state.stats.sets++;
    state.stats.bytesWritten += bytes.byteLength;
    this.#emit("set", { key, namespace: this.#ns, bytes: bytes.byteLength });
    return true;
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
    const hardTimeout = options.hardTimeout ?? state.options.hardTimeout;
    const softTimeout = options.softTimeout ?? state.options.softTimeout;
    let settled = false;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let softTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (): void => {
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
          const { codecId, flags, payload } = this.#encodeValue(
            staleEntry.value,
            staleEntry.negative,
          );
          return await state.driver.set(this.#ns, {
            key: stored,
            value: encodeEntry(
              {
                codecId,
                flags,
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
  ): Promise<Schema[K] | undefined> {
    const read = await this.#readStored(key, this.#storedKey(key));
    if (read.kind === "fresh") {
      this.#state.stats.hits++;
      this.#emit("hit", { key, namespace: this.#ns });
      return read.entry.value as Schema[K] | undefined;
    }
    this.#state.stats.misses++;
    this.#emit("miss", { key, namespace: this.#ns });
    return undefined;
  }

  async getEntry<K extends Extract<keyof Schema, string>>(
    key: K,
  ): Promise<CacheEntry<Schema[K]> | undefined> {
    const read = await this.#readStored(key, this.#storedKey(key));
    if (read.kind === "miss") {
      this.#state.stats.misses++;
      this.#emit("miss", { key, namespace: this.#ns });
      return undefined;
    }
    if (read.kind === "fresh") {
      this.#state.stats.hits++;
      this.#emit("hit", { key, namespace: this.#ns });
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

  async has<K extends Extract<keyof Schema, string>>(key: K): Promise<boolean> {
    const read = await this.#readStored(key, this.#storedKey(key));
    return read.kind === "fresh";
  }

  async getMany<K extends Extract<keyof Schema, string>>(
    keys: readonly K[],
  ): Promise<(Schema[K] | undefined)[]> {
    const state = this.#state;
    const stored = keys.map((key) => this.#storedKey(key));
    const raws = await this.#op<(StoredEntry | undefined)[] | typeof FAILED>(
      "getMany",
      async () => await state.driver.getMany(this.#ns, stored),
      FAILED,
    );
    return await Promise.all(
      keys.map(async (key, index) => {
        // A failed batch is a miss for every key, without per-key retries —
        // they would each count against the circuit.
        const read =
          raws === FAILED || raws[index] === undefined
            ? raws === FAILED
              ? ({ kind: "miss" } as const)
              : await this.#readStored(key, stored[index])
            : await this.#decodeStored(key, stored[index], raws[index]);
        if (read.kind === "fresh") {
          state.stats.hits++;
          this.#emit("hit", { key, namespace: this.#ns });
          return read.entry.value as Schema[K] | undefined;
        }
        state.stats.misses++;
        this.#emit("miss", { key, namespace: this.#ns });
        return undefined;
      }),
    );
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
        const decoded = this.#decodeValue(raw.value, key);
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
    const read = await this.#readStored(key, stored);
    const now = this.#state.now();
    if (read.kind === "fresh") {
      this.#state.stats.hits++;
      this.#emit("hit", { key, namespace: this.#ns });
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
    return this.#state.stats.stats(options);
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
  const compress =
    options.compress === false
      ? undefined
      : {
          algorithm: options.compress?.algorithm ?? ("zstd" as const),
          threshold: options.compress?.threshold ?? DEFAULTS.compressThreshold,
          level: options.compress?.level,
        };
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
    compress,
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
  return cache as Cache<Record<string, unknown>, string>;
}
