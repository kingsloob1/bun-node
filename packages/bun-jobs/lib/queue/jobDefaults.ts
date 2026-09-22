import type {
  JobDefaultBackoff,
  JobDefaultsValues,
} from "../api/contract/types";
import type {
  EditableJobOptionKey,
  JobRecord,
  JobsDriver,
  JobState,
  PendingOptionsRewrite,
  PendingOptionsRewriteResult,
  QueueRef,
  ResolvedJobOptions,
  Retention,
  StoredJobOptions,
} from "../drivers/driver";
import { Buffer } from "node:buffer";
import {
  JOB_DEFAULT_BACKOFF_TYPES,
  JOB_DEFAULT_KEYS,
  JOB_DEFAULTS_APPLY_STATES,
  JOB_DEFAULTS_BOUNDS,
} from "../api/contract/constants";
import { DEFAULT_KEEP_LOGS } from "../shared/constants";
import { ConfigError, NotSupportedError } from "../shared/errors";
import { JOB_OPTION_BITS } from "./optionBits";
import { RESERVED_STATE_PREFIX, setReservedState } from "./windows";

export {
  ALL_JOB_OPTION_BITS,
  explicitMaskOf,
  JOB_OPTION_BITS,
} from "./optionBits";

/**
 * A queue's stored job defaults: an override an operator saves (from the
 * management API or `BunQueue`), which every producer on every process picks
 * up on its add path within `jobDefaultsRefreshInterval`.
 *
 * - **Storage** is one reserved queue-state entry, {@link JOB_DEFAULTS_STATE},
 *   written the way worker configuration is (`workerControl.ts`): a
 *   compare-and-set read-modify-write with a short retry, whose queue-state
 *   **version is its `seq`**, and a reset stores `{}` rather than deleting —
 *   a deleted entry restarts at version 1, and an apply pinned to `seq` 3
 *   would then look current when it is not.
 * - **Reading** is limits' model: a {@link JobDefaultsCache} per producer,
 *   trusted for `refreshMs` and re-read (awaited) once stale, so the bound on
 *   how long a change takes to reach a producer holds even after an idle hour.
 * - **Precedence**, highest first: an option passed explicitly on `add()`;
 *   the stored override; the code's defaults (a `define()` definition's for
 *   its name, then the queue's `defaultJobOptions`); the built-ins. See
 *   `resolveLayeredJobOptions` in `options.ts`.
 * - **Explicitness** is recorded on each new job as a bitmask,
 *   `opts.explicit` ({@link JOB_OPTION_BITS}), so rewriting jobs already
 *   pending ({@link planPendingRewrite}, the drivers'
 *   `rewritePendingOptions`) never replaces what a caller chose.
 */

/** The queue-state name the override is stored under — reserved, so no caller's `setQueueState` can forge it. */
export const JOB_DEFAULTS_STATE = `${RESERVED_STATE_PREFIX}jdef`;

/**
 * How long a producer trusts the override it last read before reading it
 * again, in milliseconds: the bound on how long a saved change takes to reach
 * it, plus one read. `0` reads on every add.
 */
export const DEFAULT_JOB_DEFAULTS_REFRESH_MS = 1_000;

/** How many times a compare-and-set write is retried before it reports contention. */
const CAS_ATTEMPTS = 5;

/* ------------------------------------------------------------------ *
 * Values
 * ------------------------------------------------------------------ */

/**
 * The values an override may store, per key. Narrower than a job's options in
 * one place: `backoff` is a fixed delay or one of the two strategies in
 * `JOB_DEFAULT_BACKOFF_TYPES`, because a remotely stored strategy must not
 * name one some worker has not registered.
 */
export interface JobDefaultsStoredValues {
  /** Attempts in total, including the first. */
  attempts: number;
  /** Delay between attempts: fixed ms, or `{ type: "fixed" | "exponential", delay, max?, jitter? }`. */
  backoff: JobDefaultBackoff;
  /** Per-attempt timeout, ms; `0` means none. */
  timeout: number;
  /** Lower runs first. */
  priority: number;
  /** Retention of a completed job. */
  removeOnComplete: Retention;
  /** Retention of a job that died. */
  removeOnFail: Retention;
  /** Log lines a job keeps; at least 1 (a stored override cannot turn on "keep every line"). */
  keepLogs: number;
  /** Failure stack traces a job keeps. */
  keepStacktraces: number;
}

/** A stored override: the keys it replaces and their values. `{}` replaces nothing. */
export type JobDefaultsPatch = Partial<JobDefaultsStoredValues>;

/** A merge patch over an override: a key left out is untouched, `null` clears it. */
export type JobDefaultsUpdate = {
  [K in EditableJobOptionKey]?: JobDefaultsStoredValues[K] | null;
};

/** Whether `key` names an editable job option. */
export function isJobDefaultKey(key: unknown): key is EditableJobOptionKey {
  return (
    typeof key === "string" &&
    (JOB_DEFAULT_KEYS as readonly string[]).includes(key)
  );
}

/** Whether `value` is a whole number inside `bound`, inclusive. */
function wholeWithin(
  value: unknown,
  bound: { readonly min: number; readonly max: number },
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= bound.min &&
    value <= bound.max
  );
}

/** "a whole number between min and max" for a message. */
function wholeRange(bound: { readonly min: number; readonly max: number }) {
  return `a whole number from ${bound.min} to ${bound.max}`;
}

/** Whether `value` is a plain object (not an array, not null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why a stored backoff cannot be used, or `null`. */
function backoffIssue(value: unknown): string | null {
  if (typeof value === "number") {
    return wholeWithin(value, JOB_DEFAULTS_BOUNDS.backoffDelay)
      ? null
      : `backoff as a fixed delay must be ${wholeRange(JOB_DEFAULTS_BOUNDS.backoffDelay)} ms`;
  }

  if (!isRecord(value)) {
    return "backoff must be a number of ms or { type, delay, max?, jitter? }";
  }

  for (const field of Object.keys(value)) {
    if (!["type", "delay", "max", "jitter"].includes(field)) {
      return `backoff has an unknown field "${field}"`;
    }
  }

  if (!(JOB_DEFAULT_BACKOFF_TYPES as readonly unknown[]).includes(value.type)) {
    return `backoff.type must be one of ${JOB_DEFAULT_BACKOFF_TYPES.join(", ")}`;
  }

  if (!wholeWithin(value.delay, JOB_DEFAULTS_BOUNDS.backoffDelay)) {
    return `backoff.delay must be ${wholeRange(JOB_DEFAULTS_BOUNDS.backoffDelay)} ms`;
  }

  if (value.max !== undefined) {
    if (!wholeWithin(value.max, JOB_DEFAULTS_BOUNDS.backoffMax)) {
      return `backoff.max must be ${wholeRange(JOB_DEFAULTS_BOUNDS.backoffMax)} ms`;
    }

    if (value.max < value.delay) {
      return "backoff.max must be at least backoff.delay";
    }
  }

  if (value.jitter !== undefined) {
    const { min, max } = JOB_DEFAULTS_BOUNDS.backoffJitter;

    if (
      typeof value.jitter !== "number" ||
      !Number.isFinite(value.jitter) ||
      value.jitter < min ||
      value.jitter > max
    ) {
      return `backoff.jitter must be a number from ${min} to ${max}`;
    }
  }

  return null;
}

/** Why a stored retention cannot be used, or `null`. */
function retentionIssue(key: string, value: unknown): string | null {
  if (typeof value === "boolean") {
    return null;
  }

  if (typeof value === "number") {
    return wholeWithin(value, JOB_DEFAULTS_BOUNDS.retentionCount)
      ? null
      : `${key} as a count must be ${wholeRange(JOB_DEFAULTS_BOUNDS.retentionCount)}`;
  }

  if (!isRecord(value)) {
    return `${key} must be true, false, a count, or { count?, ttl? }`;
  }

  for (const field of Object.keys(value)) {
    if (field !== "count" && field !== "ttl") {
      return `${key} has an unknown field "${field}"`;
    }
  }

  if (value.count === undefined && value.ttl === undefined) {
    return `${key} needs a count, a ttl, or both`;
  }

  if (
    value.count !== undefined &&
    !wholeWithin(value.count, JOB_DEFAULTS_BOUNDS.retentionCount)
  ) {
    return `${key}.count must be ${wholeRange(JOB_DEFAULTS_BOUNDS.retentionCount)}`;
  }

  if (
    value.ttl !== undefined &&
    !wholeWithin(value.ttl, JOB_DEFAULTS_BOUNDS.retentionTtl)
  ) {
    return `${key}.ttl must be ${wholeRange(JOB_DEFAULTS_BOUNDS.retentionTtl)} ms`;
  }

  return null;
}

/**
 * Why `value` cannot be stored as `key`'s default, or `null` when it can —
 * checked against `JOB_DEFAULTS_BOUNDS`, the numbers the API enforces.
 *
 * Used on the way in (a write refuses what fails) and on the way out (a read
 * drops what fails), because the entry comes off shared storage: a newer
 * version, or a person with a database client, may have put anything there.
 */
export function jobDefaultIssue(
  key: EditableJobOptionKey,
  value: unknown,
): string | null {
  switch (key) {
    case "backoff":
      return backoffIssue(value);
    case "removeOnComplete":
    case "removeOnFail":
      return retentionIssue(key, value);
    default:
      return wholeWithin(value, JOB_DEFAULTS_BOUNDS[key])
        ? null
        : `${key} must be ${wholeRange(JOB_DEFAULTS_BOUNDS[key])}`;
  }
}

/**
 * A copy of a value that passed {@link jobDefaultIssue}, with its fields in a
 * fixed order and nothing but them — so what is stored, compared and written
 * onto jobs never shares a reference with the caller's object.
 */
function normalized<K extends EditableJobOptionKey>(
  key: K,
  value: JobDefaultsStoredValues[K],
): JobDefaultsStoredValues[K] {
  if (!isRecord(value)) {
    return value;
  }

  if (key === "backoff") {
    const backoff = value as Exclude<JobDefaultBackoff, number>;
    return {
      type: backoff.type,
      delay: backoff.delay,
      ...(backoff.max === undefined ? {} : { max: backoff.max }),
      ...(backoff.jitter === undefined ? {} : { jitter: backoff.jitter }),
    } as JobDefaultsStoredValues[K];
  }

  const retention = value as { count?: number; ttl?: number };
  return {
    ...(retention.count === undefined ? {} : { count: retention.count }),
    ...(retention.ttl === undefined ? {} : { ttl: retention.ttl }),
  } as JobDefaultsStoredValues[K];
}

/**
 * The usable part of a stored override: unknown keys dropped, each value
 * re-checked against the bounds and dropped when it fails — with why, so a
 * reader can surface it rather than silently applying less than was saved.
 */
export function sanitizeJobDefaults(values: unknown): {
  /** What may be applied, in `JOB_DEFAULT_KEYS` order. */
  values: JobDefaultsPatch;
  /** Why each dropped key was dropped; empty when nothing was. */
  issues: string[];
} {
  const clean: JobDefaultsPatch = {};
  const issues: string[] = [];

  if (!isRecord(values)) {
    return {
      values: clean,
      issues: values === undefined ? [] : ["stored values are not an object"],
    };
  }

  for (const key of JOB_DEFAULT_KEYS) {
    const value = values[key];

    if (value === undefined) {
      continue;
    }

    const issue = jobDefaultIssue(key, value);

    if (issue === null) {
      assign(clean, key, value as JobDefaultsStoredValues[typeof key]);
    } else {
      issues.push(issue);
    }
  }

  for (const key of Object.keys(values)) {
    if (!isJobDefaultKey(key)) {
      issues.push(`"${key}" is not an editable job option`);
    }
  }

  return { values: clean, issues };
}

/** Sets one key of a patch to a normalised copy of `value`. */
function assign<K extends EditableJobOptionKey>(
  patch: JobDefaultsPatch,
  key: K,
  value: JobDefaultsStoredValues[K],
): void {
  patch[key] = normalized(key, value);
}

/** The keys an override sets, in `JOB_DEFAULT_KEYS` order. */
export function overriddenKeys(
  values: JobDefaultsPatch,
): EditableJobOptionKey[] {
  return JOB_DEFAULT_KEYS.filter((key) => values[key] !== undefined);
}

/* ------------------------------------------------------------------ *
 * The explicit mask
 * ------------------------------------------------------------------ */

/** The mask of `keys`. */
export function maskOfKeys(keys: readonly EditableJobOptionKey[]): number {
  let mask = 0;

  for (const key of keys) {
    mask |= JOB_OPTION_BITS[key];
  }

  return mask;
}

/**
 * A stored mask as the list of keys it marks, in `JOB_DEFAULT_KEYS` order —
 * how the API serialises it (`JobOptionsDto.explicit`). `undefined` for a job
 * with no mask (one added before it existed), which is not the same as `[]`.
 * Bits this version does not know are ignored.
 */
export function explicitKeys(
  mask: number | undefined,
): EditableJobOptionKey[] | undefined {
  if (typeof mask !== "number" || !Number.isInteger(mask) || mask < 0) {
    return undefined;
  }

  return JOB_DEFAULT_KEYS.filter((key) => (mask & JOB_OPTION_BITS[key]) !== 0);
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

/**
 * The stored override, as it is written.
 *
 * `v` is the shape's version, so a later field can be added without a reader
 * from this version mistaking what it finds.
 */
export interface JobDefaultsEntry {
  /** Entry version. */
  v: 1;
  /** The values it replaces. Empty after a reset. */
  values: JobDefaultsPatch;
  /** When it was last written, epoch ms. */
  at: number;
  /** Who wrote it, when the writer says. Never interpreted, only stored. */
  by?: string;
}

/** A queue's override as a reader sees it. */
export interface StoredJobDefaults {
  /** The usable values, sanitised; `{}` when there is none. */
  values: JobDefaultsPatch;
  /** The entry's queue-state version; `0` when nothing was ever stored. */
  seq: number;
  /** When it was last written, epoch ms; absent when it never was. */
  updatedAt?: number;
  /** Who last wrote it, when the writer said. */
  by?: string;
  /** Why part of what is stored was dropped on read, when part was. */
  issues?: string[];
}

/** What a queue with no stored override reads as. */
const NO_DEFAULTS: StoredJobDefaults = Object.freeze({
  values: Object.freeze({}) as JobDefaultsPatch,
  seq: 0,
});

/**
 * Whether a driver can store an override at all: it has queue state. Without
 * it a {@link JobDefaultsCache} reads "no override" and never asks, and the
 * management routes are pruned.
 */
export function supportsJobDefaults(driver: JobsDriver): boolean {
  return (
    typeof driver.getQueueState === "function" &&
    typeof driver.setQueueState === "function"
  );
}

/** The override stored on `q`, sanitised. `seq: 0` and `{}` when there is none. */
export async function readJobDefaults(
  driver: JobsDriver,
  q: QueueRef,
): Promise<StoredJobDefaults> {
  if (typeof driver.getQueueState !== "function") {
    return { ...NO_DEFAULTS, values: {} };
  }

  const entry = await driver.getQueueState(q, JOB_DEFAULTS_STATE);

  if (!entry) {
    return { ...NO_DEFAULTS, values: {} };
  }

  const stored = isRecord(entry.value)
    ? (entry.value as Partial<JobDefaultsEntry>)
    : undefined;
  const { values, issues } = sanitizeJobDefaults(stored?.values ?? {});

  return {
    values,
    seq: entry.version,
    ...(typeof stored?.at === "number" ? { updatedAt: stored.at } : {}),
    ...(typeof stored?.by === "string" ? { by: stored.by } : {}),
    ...(issues.length > 0 ? { issues } : {}),
  };
}

/**
 * Merges `update` into `q`'s override and stores it, answering what is now
 * stored. A key set to `null` is removed, so the code's value applies again.
 *
 * **Refuses rather than drops**: an unknown key, or a value outside
 * `JOB_DEFAULTS_BOUNDS`, throws a `ConfigError` before anything is read or
 * written (the API validates first and answers 400; this is the in-code
 * guard). A driver without queue state throws `NotSupportedError`.
 *
 * `expectedSeq` makes it a safe read-modify-write: the write is refused —
 * `contended: true`, nothing changed — when the entry has moved on since the
 * caller read it (`0` = "nothing was ever stored"). Without it the last writer
 * wins key by key. Losing the compare-and-set {@link CAS_ATTEMPTS} times in a
 * row also answers `contended: true`.
 */
export async function writeJobDefaults(
  driver: JobsDriver,
  q: QueueRef,
  update: Readonly<JobDefaultsUpdate>,
  options?: {
    /** Refuse unless the stored version is still this; `0` means nothing stored yet. */
    expectedSeq?: number;
    /** Drop every stored key first: a reset (with an empty `update`) or a full replace. */
    replace?: boolean;
    /** When the write happened, epoch ms; defaults to now. */
    now?: number;
    /**
     * Who is writing. Stored with the entry and returned by
     * `readJobDefaults()` as `by`; never interpreted, and not surfaced by
     * `getJobDefaults()` or the management API.
     */
    by?: string;
  },
): Promise<{
  /** What is stored now (after a contended write: what somebody else stored). */
  stored: StoredJobDefaults;
  /** Whether the write was refused because the entry moved on, so nothing changed. */
  contended: boolean;
}> {
  if (!supportsJobDefaults(driver)) {
    throw new NotSupportedError(driver.name, "setQueueState", {
      feature: "job defaults",
    });
  }

  const changes: [EditableJobOptionKey, unknown][] = [];

  for (const [key, value] of Object.entries(update)) {
    if (!isJobDefaultKey(key)) {
      throw new ConfigError(`"${key}" is not an editable job option`, {
        key,
        keys: JOB_DEFAULT_KEYS,
      });
    }

    if (value === undefined) {
      continue;
    }

    if (value !== null) {
      const issue = jobDefaultIssue(key, value);

      if (issue !== null) {
        throw new ConfigError(issue, { key, value });
      }
    }

    changes.push([key, value]);
  }

  const now = options?.now ?? Date.now();

  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const current = await readJobDefaults(driver, q);

    if (
      options?.expectedSeq !== undefined &&
      options.expectedSeq !== current.seq
    ) {
      return { stored: current, contended: true };
    }

    const values: JobDefaultsPatch = options?.replace
      ? {}
      : { ...current.values };

    for (const [key, value] of changes) {
      if (value === null) {
        delete values[key];
      } else {
        assign(values, key, value as JobDefaultsStoredValues[typeof key]);
      }
    }

    // Written in key order, so two writers' entries compare byte for byte.
    const ordered: JobDefaultsPatch = {};
    for (const key of overriddenKeys(values)) {
      assign(ordered, key, values[key] as JobDefaultsStoredValues[typeof key]);
    }

    const entry: JobDefaultsEntry = {
      v: 1,
      values: ordered,
      at: now,
      ...(options?.by === undefined ? {} : { by: options.by }),
    };

    const seq = await setReservedState(
      driver,
      q,
      JOB_DEFAULTS_STATE,
      entry,
      current.seq === 0 ? null : current.seq,
    );

    if (seq !== null) {
      return {
        stored: {
          values: ordered,
          seq,
          updatedAt: now,
          ...(options?.by === undefined ? {} : { by: options.by }),
        },
        contended: false,
      };
    }
  }

  return { stored: await readJobDefaults(driver, q), contended: true };
}

/**
 * Removes every key of `q`'s override, so the code's values apply again to
 * jobs added from now on. Stores `{}` rather than deleting, so `seq` keeps
 * rising. Jobs already pending keep what they were given.
 */
export async function resetJobDefaults(
  driver: JobsDriver,
  q: QueueRef,
  options?: {
    /** Refuse unless the stored version is still this. */
    expectedSeq?: number;
    /** When the reset happened, epoch ms; defaults to now. */
    now?: number;
    /**
     * Who is resetting. Stored with the entry and returned by
     * `readJobDefaults()` as `by`; never interpreted, and not surfaced by
     * `getJobDefaults()` or the management API.
     */
    by?: string;
  },
): Promise<{
  /** What is stored now. */
  stored: StoredJobDefaults;
  /** Whether the reset was refused because the entry moved on. */
  contended: boolean;
}> {
  return await writeJobDefaults(driver, q, {}, { ...options, replace: true });
}

/* ------------------------------------------------------------------ *
 * The producer's cache
 * ------------------------------------------------------------------ */

/**
 * A producer's view of one queue's override: trusted for `refreshMs`, then
 * read again — **awaited**, not served stale while revalidating, so a
 * producer idle for an hour does not stamp its next job with an hour-old
 * answer. One per `BunQueue` (and one per `BunQueueWorker`, for repeat
 * occurrences).
 *
 * A busy producer need not pay that await, though: {@link refresh} reads
 * ahead of expiry in the background (`BunQueue` asks once three quarters of
 * the interval have passed), so the answer is renewed before it goes stale and no add
 * waits on it — while nothing older than `refreshMs` is ever served.
 *
 * Cost: at most one `getQueueState` per `refreshMs`, and only while adds
 * happen. Concurrent callers of a stale cache share one read, except with
 * `refreshMs: 0`, where every call reads for itself (that is what `0` asks).
 */
export class JobDefaultsCache {
  /** The driver holding the override. */
  readonly #driver: JobsDriver;
  /** The queue it belongs to. */
  readonly #ref: QueueRef;
  /** How long a read is trusted, ms. */
  readonly #refreshMs: number;
  /** The last answer and when it was read. */
  #cached: { stored: StoredJobDefaults; readAt: number } | undefined;
  /** The read in flight, shared by concurrent callers. */
  #inflight: Promise<StoredJobDefaults> | undefined;
  /**
   * Bumped by {@link prime} and {@link invalidate}, so a read that started
   * before either cannot overwrite what they set when it lands.
   */
  #generation = 0;

  constructor(
    /** The driver holding the override. Without queue state the cache answers "no override" and never reads. */
    driver: JobsDriver,
    /** The queue. */
    ref: QueueRef,
    /** How long a read is trusted, ms: a whole number ≥ 0, default {@link DEFAULT_JOB_DEFAULTS_REFRESH_MS}; `0` reads on every call. */
    refreshMs: number = DEFAULT_JOB_DEFAULTS_REFRESH_MS,
  ) {
    if (!Number.isInteger(refreshMs) || refreshMs < 0) {
      throw new ConfigError(
        "jobDefaultsRefreshInterval must be a whole number of ms, 0 or more",
        { jobDefaultsRefreshInterval: refreshMs },
      );
    }

    this.#driver = driver;
    this.#ref = ref;
    this.#refreshMs = refreshMs;
  }

  /** How long a read is trusted, ms — the propagation bound this producer promises. */
  get refreshMs(): number {
    return this.#refreshMs;
  }

  /** The stored override's values, from cache when fresh. `{}` when there is none. */
  async get(now: number = Date.now()): Promise<JobDefaultsPatch> {
    return (await this.read(now)).values;
  }

  /** The stored override with its `seq`, from cache when fresh. */
  async read(now: number = Date.now()): Promise<StoredJobDefaults> {
    if (typeof this.#driver.getQueueState !== "function") {
      return NO_DEFAULTS;
    }

    if (this.#cached && now - this.#cached.readAt < this.#refreshMs) {
      return this.#cached.stored;
    }

    if (this.#inflight && this.#refreshMs > 0) {
      return await this.#inflight;
    }

    return await this.#readNow(now);
  }

  /** One read, cached unless a prime or invalidate lands meanwhile. */
  async #readNow(now: number): Promise<StoredJobDefaults> {
    const generation = this.#generation;
    const reading = readJobDefaults(this.#driver, this.#ref);
    this.#inflight = reading;

    try {
      const stored = await reading;

      if (generation === this.#generation) {
        this.#cached = { stored, readAt: now };
      }

      return stored;
    } finally {
      if (this.#inflight === reading) {
        this.#inflight = undefined;
      }
    }
  }

  /**
   * Reads the override now, whether or not the cached answer is fresh, and
   * caches it — sharing a read already in flight. For reading ahead of
   * expiry; the answer is `readAt` the moment this was called.
   */
  async refresh(now: number = Date.now()): Promise<StoredJobDefaults> {
    if (typeof this.#driver.getQueueState !== "function") {
      return NO_DEFAULTS;
    }

    if (this.#inflight) {
      return await this.#inflight;
    }

    return await this.#readNow(now);
  }

  /**
   * Replaces the cached answer with one the caller knows is current — what a
   * write just stored — so the writer's own adds see it at once rather than
   * after `refreshMs`.
   */
  prime(stored: StoredJobDefaults, now: number = Date.now()): void {
    this.#generation++;
    this.#cached = { stored, readAt: now };
  }

  /** Forgets the cached answer; the next call reads. */
  invalidate(): void {
    this.#generation++;
    this.#cached = undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Applying an override to stored options
 * ------------------------------------------------------------------ */

/** Whether two option values are the same JSON value, whatever their key order. */
export function sameOptionValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }

  if (!isRecord(a) || !isRecord(b)) {
    return false;
  }

  const keys = Object.keys(a).filter((key) => a[key] !== undefined);

  if (
    keys.length !== Object.keys(b).filter((key) => b[key] !== undefined).length
  ) {
    return false;
  }

  return keys.every((key) => sameOptionValue(a[key], b[key]));
}

/** A deep copy of a JSON option value. */
function copyValue<T>(value: T): T {
  return isRecord(value) ? (structuredClone(value) as T) : value;
}

/**
 * `opts` with every key of `values` written over it whose bit is **not** set
 * in `opts.explicit` — how a stored override reaches options resolved without
 * it (a repeat series' definition, resolved from the code's defaults, when the
 * worker builds its next occurrence).
 *
 * A mask-less `opts` (resolved before the mask existed) is returned as it is,
 * unless `includeUnmarked`: nothing can say which of its options were
 * explicit. The mask itself is carried over unchanged. `record.priority` and
 * `record.maxAttempts` must follow `opts.priority` / `opts.attempts`; that is
 * the caller's.
 */
export function overlayJobDefaults<T extends StoredJobOptions>(
  opts: T,
  values: JobDefaultsPatch,
  options?: {
    /** Write over a mask-less `opts` too, treating all of it as defaulted. */
    includeUnmarked?: boolean;
  },
): T {
  const mask = opts.explicit;

  if (mask === undefined && !options?.includeUnmarked) {
    return opts;
  }

  const next: T = { ...opts };
  const writable = next as unknown as Record<EditableJobOptionKey, unknown>;

  for (const key of overriddenKeys(values)) {
    if (((mask ?? 0) & JOB_OPTION_BITS[key]) === 0) {
      writable[key] = copyValue(values[key]);
    }
  }

  return next;
}

/** The part of a job {@link planPendingRewrite} reads. */
export type RewritableJob = Pick<
  JobRecord,
  "opts" | "priority" | "maxAttempts" | "attemptsMade"
>;

/** What rewriting one pending job with an override would do. */
export type PendingRewritePlan =
  | {
      /** The job has no mask and `includeUnmarked` is off: leave it. */
      outcome: "skippedUnmarked";
    }
  | {
      /** Every key that would change is explicit on it: leave it. */
      outcome: "skippedExplicit";
    }
  | {
      /** It already has every value: nothing to write. */
      outcome: "unchanged";
    }
  | {
      /** Write it. */
      outcome: "rewritten";
      /** Its new `opts` (a fresh object; the mask carried over unchanged). */
      opts: StoredJobOptions;
      /** Its new `priority` column / score: `opts.priority`. */
      priority: number;
      /** Its new `maxAttempts`: `opts.attempts`. */
      maxAttempts: number;
      /** The keys that change, in `JOB_DEFAULT_KEYS` order. */
      keys: EditableJobOptionKey[];
      /** Whether `attempts` is among them and the job's `attemptsMade` already reaches it. */
      exhausted: boolean;
    };

/**
 * What rewriting one pending job with `values` would do — the per-job rule of
 * `rewritePendingOptions`, shared so every driver that computes it in
 * JavaScript (memory, file, MongoDB) computes the same thing, and a driver
 * that computes it in SQL or Lua has one reference to match.
 *
 * - no `opts.explicit` → `skippedUnmarked`, unless `includeUnmarked` (then
 *   treated as mask `0`);
 * - a key is written only when its bit is clear **and** its value differs
 *   (`attempts` also compares `maxAttempts`, `priority` also the `priority`
 *   column, since both are copies the claim and retry read);
 * - nothing to write, but some explicit key would have changed →
 *   `skippedExplicit`; nothing to write at all → `unchanged`;
 * - `exhausted` when `attempts` is written and `attemptsMade >=` it.
 */
export function planPendingRewrite(
  job: RewritableJob,
  values: PendingOptionsRewrite["values"],
  includeUnmarked: boolean,
): PendingRewritePlan {
  const stored = job.opts.explicit;

  if (typeof stored !== "number" && !includeUnmarked) {
    return { outcome: "skippedUnmarked" };
  }

  const mask = typeof stored === "number" ? stored : 0;
  const current = job.opts as unknown as Record<EditableJobOptionKey, unknown>;
  const keys: EditableJobOptionKey[] = [];
  let blocked = false;

  for (const key of JOB_DEFAULT_KEYS) {
    const value = values[key];

    if (value === undefined) {
      continue;
    }

    const differs =
      !sameOptionValue(current[key], value) ||
      (key === "attempts" && job.maxAttempts !== value) ||
      (key === "priority" && job.priority !== value);

    if (!differs) {
      continue;
    }

    if ((mask & JOB_OPTION_BITS[key]) !== 0) {
      blocked = true;
    } else {
      keys.push(key);
    }
  }

  if (keys.length === 0) {
    return { outcome: blocked ? "skippedExplicit" : "unchanged" };
  }

  const opts: StoredJobOptions = { ...job.opts };
  const writable = opts as unknown as Record<EditableJobOptionKey, unknown>;

  for (const key of keys) {
    writable[key] = copyValue(values[key]);
  }

  return {
    outcome: "rewritten",
    opts,
    priority: keys.includes("priority") ? opts.priority : job.priority,
    maxAttempts: keys.includes("attempts") ? opts.attempts : job.maxAttempts,
    keys,
    exhausted: keys.includes("attempts") && job.attemptsMade >= opts.attempts,
  };
}

/** A result with every count at zero and the walk finished. */
export function emptyRewriteResult(): PendingOptionsRewriteResult {
  return {
    examined: 0,
    rewritten: 0,
    unchanged: 0,
    skippedExplicit: 0,
    skippedUnmarked: 0,
    moved: 0,
    exhausted: 0,
    next: null,
  };
}

/** Counts one examined job's plan into `result`. */
export function tallyRewrite(
  result: PendingOptionsRewriteResult,
  plan: PendingRewritePlan,
): void {
  result.examined++;

  switch (plan.outcome) {
    case "rewritten":
      result.rewritten++;
      if (plan.exhausted) {
        result.exhausted++;
      }
      break;
    case "unchanged":
      result.unchanged++;
      break;
    case "skippedExplicit":
      result.skippedExplicit++;
      break;
    case "skippedUnmarked":
      result.skippedUnmarked++;
      break;
  }
}

/** Counts one examined job that had left the walked states before its write. */
export function tallyMoved(result: PendingOptionsRewriteResult): void {
  result.examined++;
  result.moved++;
}

/**
 * Refuses a malformed {@link PendingOptionsRewrite} with a `ConfigError`: the
 * states must be a non-empty, repeat-free subset of `JOB_DEFAULTS_APPLY_STATES`,
 * the limit a whole number of at least 1, and every value one a stored
 * override could hold. A driver calls it first, so every backend refuses
 * the same requests the same way.
 */
export function assertRewriteRequest(request: PendingOptionsRewrite): void {
  const allowed = JOB_DEFAULTS_APPLY_STATES as readonly JobState[];

  if (
    !Array.isArray(request.states) ||
    request.states.length === 0 ||
    new Set(request.states).size !== request.states.length ||
    request.states.some((state) => !allowed.includes(state))
  ) {
    throw new ConfigError(
      `states must be a non-empty subset of ${allowed.join(", ")}, without repeats`,
      { states: request.states },
    );
  }

  if (!Number.isInteger(request.limit) || request.limit < 1) {
    throw new ConfigError("limit must be a whole number of at least 1", {
      limit: request.limit,
    });
  }

  for (const [key, value] of Object.entries(request.values)) {
    if (!isJobDefaultKey(key)) {
      throw new ConfigError(`"${key}" is not an editable job option`, { key });
    }

    const issue = value === undefined ? null : jobDefaultIssue(key, value);

    if (issue !== null) {
      throw new ConfigError(issue, { key, value });
    }
  }
}

/** What every apply cursor `BunQueue.applyJobDefaults` hands out starts with. */
const WALK_CURSOR_PREFIX = "ja1.";

/** Which walk an apply cursor belongs to: everything that decides what the walk visits. */
export interface JobDefaultsWalk {
  /** The namespace. */
  ns: string;
  /** The queue walked. */
  queue: string;
  /** The override version applied. */
  seq: number;
  /** The states walked, in order. */
  states: readonly string[];
  /** The keys written. */
  keys: readonly string[];
}

/**
 * Wraps a driver's rewrite cursor in an envelope naming the walk it belongs
 * to, so {@link openWalkCursor} can refuse it anywhere else (B15). Mismatch
 * detection, not security: nothing is signed.
 */
export function sealWalkCursor(walk: JobDefaultsWalk, cursor: string): string {
  const envelope = {
    v: 1,
    ns: walk.ns,
    queue: walk.queue,
    seq: walk.seq,
    states: [...walk.states],
    keys: [...walk.keys],
    c: cursor,
  };
  return `${WALK_CURSOR_PREFIX}${Buffer.from(JSON.stringify(envelope)).toString("base64url")}`;
}

/**
 * The driver cursor inside an apply cursor from {@link sealWalkCursor} — or
 * a `ConfigError` when it is not one, or belongs to another walk: another
 * queue, another override version, or other states or keys.
 *
 * A driver's cursor says only where it stopped in a state, so one from
 * another walk used to be accepted and resumed from a position that meant
 * nothing here, silently skipping jobs.
 */
export function openWalkCursor(walk: JobDefaultsWalk, cursor: string): string {
  const malformed = () =>
    new ConfigError("cursor is not one this walk issued", { cursor });

  if (typeof cursor !== "string" || !cursor.startsWith(WALK_CURSOR_PREFIX)) {
    throw malformed();
  }

  let envelope: Partial<JobDefaultsWalk> & { v?: unknown; c?: unknown };

  try {
    envelope = JSON.parse(
      Buffer.from(
        cursor.slice(WALK_CURSOR_PREFIX.length),
        "base64url",
      ).toString("utf8"),
    ) as typeof envelope;
  } catch {
    throw malformed();
  }

  if (
    typeof envelope !== "object" ||
    envelope === null ||
    envelope.v !== 1 ||
    typeof envelope.c !== "string"
  ) {
    throw malformed();
  }

  const same = (a: unknown, b: readonly string[]) =>
    Array.isArray(a) &&
    a.length === b.length &&
    a.every((item, index) => item === b[index]);

  if (
    envelope.ns !== walk.ns ||
    envelope.queue !== walk.queue ||
    envelope.seq !== walk.seq ||
    !same(envelope.states, walk.states) ||
    !same(envelope.keys, walk.keys)
  ) {
    throw new ConfigError("this cursor belongs to another walk", {
      queue: walk.queue,
      seq: walk.seq,
      cursorQueue: envelope.queue,
      cursorSeq: envelope.seq,
    });
  }

  return envelope.c;
}

/** What every rewrite cursor this module encodes starts with, and its format version. */
const CURSOR_PREFIX = "jd1.";

/**
 * An opaque rewrite cursor: the state being walked and the ordering key of the
 * last job examined in it. A driver chooses what the key holds (numbers and
 * strings); this only makes it opaque and checks it on the way back.
 */
export function encodeRewriteCursor(
  state: JobState,
  key: readonly (string | number)[],
): string {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify([state, ...key])).toString("base64url")}`;
}

/**
 * The state and key a cursor from {@link encodeRewriteCursor} holds. A cursor
 * that is not one, that names a state not in `states`, or whose key does not
 * match `keyTypes` part for part (a `"number"` must be finite) is refused with
 * a `ConfigError` (the API answers 400 `INVALID_ARGUMENT`).
 */
export function decodeRewriteCursor(
  cursor: string,
  states: readonly JobState[],
  keyTypes: readonly ("number" | "string")[],
): {
  /** The state the walk was in. */
  state: JobState;
  /** The last examined job's ordering key in that state, typed as `keyTypes` says. */
  key: (string | number)[];
} {
  const malformed = () =>
    new ConfigError("cursor is not one this walk issued", { cursor });

  if (typeof cursor !== "string" || !cursor.startsWith(CURSOR_PREFIX)) {
    throw malformed();
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(
      Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString(
        "utf8",
      ),
    );
  } catch {
    throw malformed();
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length !== keyTypes.length + 1 ||
    !states.includes(parsed[0] as JobState) ||
    keyTypes.some((type, index) => {
      const part: unknown = parsed[index + 1];
      return type === "number"
        ? typeof part !== "number" || !Number.isFinite(part)
        : typeof part !== "string";
    })
  ) {
    throw malformed();
  }

  return {
    state: parsed[0] as JobState,
    key: parsed.slice(1) as (string | number)[],
  };
}

/* ------------------------------------------------------------------ *
 * Describing
 * ------------------------------------------------------------------ */

/**
 * The editable options of resolved `opts`, as `JobDefaultsValues` — every key
 * present (`keepLogs` falls back to the default a reader uses).
 */
export function jobDefaultsValuesOf(
  opts: ResolvedJobOptions,
): JobDefaultsValues {
  return {
    attempts: opts.attempts,
    backoff: copyValue(opts.backoff),
    timeout: opts.timeout,
    priority: opts.priority,
    removeOnComplete: copyValue(opts.removeOnComplete),
    removeOnFail: copyValue(opts.removeOnFail),
    keepLogs: opts.keepLogs ?? DEFAULT_KEEP_LOGS,
    keepStacktraces: opts.keepStacktraces,
  };
}

/**
 * A queue's job defaults as `GET …/job-defaults` shows them: what the code
 * asks for (`code`: options resolved from the code's defaults alone, e.g.
 * `resolveJobOptions(queue.defaultJobOptions, undefined)`), the stored
 * override, and what a job passing none of the options gets (`effective`).
 */
export function describeJobDefaults(
  code: ResolvedJobOptions,
  stored: StoredJobDefaults,
): {
  /** What the code asks for, before the override. */
  code: JobDefaultsValues;
  /** What a job added now, passing none of these options, gets. */
  effective: JobDefaultsValues;
  /** The stored override itself; `{}` when there is none. */
  override: JobDefaultsPatch;
  /** The keys it replaces, in `JOB_DEFAULT_KEYS` order. */
  overridden: EditableJobOptionKey[];
  /** Its version; `0` when nothing was ever stored. */
  seq: number;
  /** When it was last written; absent when it never was. */
  updatedAt?: number;
} {
  const codeValues = jobDefaultsValuesOf(code);
  const effective = jobDefaultsValuesOf(
    overlayJobDefaults(code, stored.values, { includeUnmarked: true }),
  );

  return {
    code: codeValues,
    effective,
    override: stored.values,
    overridden: overriddenKeys(stored.values),
    seq: stored.seq,
    ...(stored.updatedAt === undefined ? {} : { updatedAt: stored.updatedAt }),
  };
}
