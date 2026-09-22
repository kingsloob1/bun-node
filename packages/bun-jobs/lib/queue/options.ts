import type { StoredJobOptions } from "../drivers/driver";
import type { ResolvedJobOptions, Retention } from "../drivers/index";
import type { JobDefaultsPatch } from "./jobDefaults";
import type { JobOptions } from "./types";
import { encodeName, MAX_ENCODED_NAME } from "../drivers/file-names";
import {
  DEFAULT_JOB_BACKOFF,
  DEFAULT_KEEP_STACKTRACES,
  DEFAULT_RESULT_TTL,
} from "../shared/constants";
import { ConfigError } from "../shared/errors";
import { fitName } from "../shared/fit";
import { assertSegment } from "../shared/keys";
import { explicitMaskOf } from "./optionBits";

/** Widest priority the drivers can order on; keeps marker names sortable. */
const PRIORITY_LIMIT = 1_048_576;

/**
 * Longest a caller-supplied id may be, in characters.
 *
 * One number for every backend, set by the tightest of them: MySQL and MariaDB
 * store ids as `VARCHAR(191)`, which is itself the widest a `utf8mb4` id column
 * can be while the composite claim index stays inside InnoDB's 3,072-byte key
 * limit (191 × 4 × 4 + 12 = 3,068). Past it MySQL silently *truncated*, so two
 * ids sharing a 191-character prefix merged into one job — and afterwards
 * neither id resolved. A single cap everywhere is what keeps an id that works
 * on one driver from being a data-loss bug on another.
 */
export const MAX_JOB_ID_LENGTH = 191;

/**
 * What a caller's own `repeat.key` is prefixed with.
 *
 * A generated series key is `<name>|<schedule>|<start>`, and nothing stopped a
 * caller passing exactly that string as `repeat.key` — taking over another
 * job's series. Namespacing every caller key puts the two in different spaces,
 * so neither can name the other.
 */
export const CALLER_REPEAT_KEY_PREFIX = "k:";

/**
 * Longest a caller's own `repeat.key` may be: {@link MAX_JOB_ID_LENGTH} less
 * the {@link CALLER_REPEAT_KEY_PREFIX} it is stored under, so the stored key
 * fits the same 191-character columns an id does (a job records the key of the
 * series it belongs to).
 */
export const MAX_REPEAT_KEY_LENGTH =
  MAX_JOB_ID_LENGTH - CALLER_REPEAT_KEY_PREFIX.length;

/**
 * What a name this package derives is fitted within: the tightest store's
 * bounds. {@link MAX_JOB_ID_LENGTH} characters for MySQL and MariaDB, and
 * {@link MAX_ENCODED_NAME} bytes once the file driver has encoded it — a bound
 * the character count alone does not imply, since an uppercase letter encodes
 * to two bytes and a character outside Latin to as many as nine.
 */
export const DERIVED_NAME_LIMITS = {
  maxLength: MAX_JOB_ID_LENGTH,
  measured: {
    max: MAX_ENCODED_NAME,
    measure: (value: string) => encodeName(value).length,
  },
} as const;

/**
 * A stored series key as it should be *shown* — and as its occurrence ids are
 * built from.
 *
 * The prefix is hidden for an ordinary caller key, so naming your own series
 * costs you nothing visible. It is **kept** when the key contains `|`, because
 * a generated key is `<name>|<schedule>|<start>` and therefore always contains
 * one: hiding the prefix there would make two genuinely different series
 * display identically.
 *
 * That is not cosmetic. The occurrence id is `repeat:<key>:<runAt>` and is the
 * idempotency key for scheduling an occurrence, so two series that displayed
 * alike would derive the *same* occurrence id at the same instant and silently
 * merge into one job — losing one series' run. Measured with a repro: a
 * `digest` series on `every: 60000` and a second series whose caller key was
 * that series' generated key produced byte-identical stripped ids.
 *
 * A key without `|` can never equal a generated one, so stripping it is safe.
 */
export function displayRepeatKey(stored: string): string {
  if (!stored.startsWith(CALLER_REPEAT_KEY_PREFIX)) {
    return stored;
  }

  const bare = stored.slice(CALLER_REPEAT_KEY_PREFIX.length);
  return bare.includes("|") ? stored : bare;
}

/**
 * Checks an id the caller chose — a `jobId`, a flow child's id, a debounce or
 * throttle window id — and answers with it.
 *
 * A **denylist**, deliberately: it rejects what actually breaks a backend and
 * allows everything else, punctuation and unicode alike. An allow-list cannot
 * work here, because this package's own generated ids are built by joining
 * user text with `:` and `|` — a repeat series key is `<name>|<schedule>|<start>`,
 * and an ordinary cron series contributes spaces, `*`, `,`, `@` and `/` through
 * its expression and time zone. Anything narrow enough to look tidy would
 * reject the library's own ids.
 *
 * What is refused, and why each one:
 *
 * - **empty** — an id is an identity, and `""` names nothing;
 * - **over {@link MAX_JOB_ID_LENGTH} characters** — see that constant: MySQL
 *   used to truncate and merge two jobs into one;
 * - **control characters** (C0, DEL and C1) — NUL is rejected outright by
 *   PostgreSQL and every other driver accepted it, so the same id worked on
 *   one backend and failed on another;
 * - **a leading `.`** — `.` and `..` are directory entries, and a dotfile is
 *   hidden from the tooling people use to look at a queue's directory;
 * - **a lone surrogate** — a string that is not well-formed UTF-16 has no
 *   UTF-8 spelling, so a backend that stores UTF-8 replaces it with U+FFFD and
 *   two different ids collide, or rejects it outright.
 *
 * `/` and `\` are **allowed**, deliberately. It is tempting to refuse them
 * because the file driver turns an id into a file name, but `encodeName`
 * escapes every character, so a slash was never a path hazard — and what does
 * bound a file name is the encoded *byte* length, which that driver checks
 * itself. Refusing slashes would only break ids like `tenant/7`, which the
 * management API supports and URL-encodes on purpose.
 *
 * Derived ids that this package builds itself are *shortened* rather than
 * refused, so a long-but-legal id can never make a later step throw.
 */
export function assertJobId(value: string, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`${what} must be a non-empty string`, {
      [what]: value,
    });
  }

  if (value.length > MAX_JOB_ID_LENGTH) {
    throw new ConfigError(
      `${what} is ${value.length} characters long; the most is ${MAX_JOB_ID_LENGTH}`,
      { [what]: value, length: value.length, max: MAX_JOB_ID_LENGTH },
    );
  }

  // Scanned rather than matched with a regular expression: the ranges are C0
  // and C1, which a pattern can only spell as escapes that lint (rightly)
  // calls obscure, and a loop says plainly which character was found.
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);

    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      const named = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;

      throw new ConfigError(
        `${what} may not contain control characters, and has ${named} at index ${index}`,
        { [what]: value, character: named, index },
      );
    }
  }

  if (value.startsWith(".")) {
    throw new ConfigError(
      `${what} may not begin with "." (it would be a hidden file, and "." and ".." are directories)`,
      { [what]: value },
    );
  }

  if (!value.isWellFormed()) {
    throw new ConfigError(
      `${what} contains a lone surrogate, which no backend can store faithfully`,
      { [what]: value },
    );
  }

  return value;
}

/**
 * Checks a caller's own `repeat.key`, as {@link assertJobId} checks an id, and
 * answers with it.
 *
 * The same rules, because the key becomes part of an id (`repeat:<key>:<runAt>`)
 * and a stored name. One tighter bound: {@link MAX_REPEAT_KEY_LENGTH}, since it
 * is stored with {@link CALLER_REPEAT_KEY_PREFIX} in front.
 */
export function assertRepeatKey(value: string): string {
  assertJobId(value, "repeat.key");

  if (value.length > MAX_REPEAT_KEY_LENGTH) {
    throw new ConfigError(
      `repeat.key is ${value.length} characters long; the most is ${MAX_REPEAT_KEY_LENGTH} (it is stored with a "${CALLER_REPEAT_KEY_PREFIX}" prefix)`,
      {
        "repeat.key": value,
        length: value.length,
        max: MAX_REPEAT_KEY_LENGTH,
      },
    );
  }

  return value;
}

/** Defaults every job gets unless the queue or the call overrides them. */
export const DEFAULT_JOB_OPTIONS: ResolvedJobOptions = {
  priority: 0,
  attempts: 1,
  backoff: DEFAULT_JOB_BACKOFF,
  timeout: 0,
  removeOnComplete: { ttl: DEFAULT_RESULT_TTL },
  removeOnFail: false,
  keepStacktraces: DEFAULT_KEEP_STACKTRACES,
};

/**
 * Applies queue defaults and this call's options over the built-in ones.
 *
 * The two-layer merge, unchanged: no stored override, no `define()` layer, and
 * no `explicit` mask on the result — so `resolveJobOptions(undefined,
 * undefined)` is still exactly {@link DEFAULT_JOB_OPTIONS}. The add path uses
 * {@link resolveLayeredJobOptions}.
 */
export function resolveJobOptions(
  queueDefaults: JobOptions | undefined,
  options: JobOptions | undefined,
): ResolvedJobOptions {
  return resolveMerged({ ...queueDefaults, ...options });
}

/**
 * The layers under a call's own options, lowest first: `code`, then
 * `definition`, then `override`. Each may be absent.
 */
export interface JobOptionLayers {
  /** The queue's own `defaultJobOptions` (`BunQueueOptions.defaultJobOptions`). */
  code?: JobOptions;
  /**
   * A `define()` definition's defaults for the job's name. Above `code` —
   * the per-name choice is the more specific one — and below `override`: a
   * queue's stored defaults reach defined names too (decision D3).
   */
  definition?: JobOptions;
  /**
   * The queue's stored override (`JobDefaultsCache.get()`). Omit it where a
   * result must not freeze it — a repeat series' definition stores the code's
   * resolution, so a later reset still has something to fall back to.
   */
  override?: JobDefaultsPatch;
}

/**
 * Copies `layer`'s own defined values onto `into`, so an absent key cannot
 * mask a lower layer. An absent layer costs one check, and an empty one a
 * loop that never runs.
 */
function assignDefined(into: JobOptions, layer: object | undefined): void {
  if (layer === undefined) {
    return;
  }

  const target = into as Record<string, unknown>;
  const source = layer as Record<string, unknown>;

  for (const key of Object.keys(source)) {
    const value = source[key];

    if (value !== undefined) {
      target[key] = value;
    }
  }
}

/**
 * Resolves a new job's options from every layer, highest first: an option
 * passed on the call itself (`options`), the queue's stored override, the
 * `define()` definition's defaults, the queue's `defaultJobOptions`, the
 * built-ins. Per key and shallow — an override's `backoff` replaces the
 * code's whole object.
 *
 * Also records **which editable options the call passed itself** as
 * `explicit` ({@link explicitMaskOf}) — always, `0` included, so a stored job
 * without one is unambiguously older than the mask — which is what lets
 * rewriting pending jobs keep them.
 *
 * Unlike {@link resolveJobOptions}, a key set to `undefined` in any layer is
 * treated as absent: `{ attempts: undefined }` on a call falls through to the
 * override rather than wiping it to the built-in.
 *
 * On the add path, so it merges into one object rather than spreading a
 * filtered copy of every layer: an absent layer is skipped outright, which is
 * the common case (no `define()` layer, an empty override).
 */
export function resolveLayeredJobOptions(
  layers: JobOptionLayers,
  options: JobOptions | undefined,
): StoredJobOptions {
  const merged: JobOptions = {};

  assignDefined(merged, layers.code);
  assignDefined(merged, layers.definition);
  assignDefined(merged, layers.override);
  assignDefined(merged, options);

  // Appended rather than spread in, so `explicit` stays the last key without
  // copying the resolved object a second time.
  const resolved = resolveMerged(merged) as StoredJobOptions;
  resolved.explicit = explicitMaskOf(options);
  return resolved;
}

/** Checks one merged set of options and fills its gaps with the built-ins. */
function resolveMerged(merged: JobOptions): ResolvedJobOptions {
  const attempts = merged.attempts ?? DEFAULT_JOB_OPTIONS.attempts;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new ConfigError("attempts must be a whole number of at least 1", {
      attempts,
    });
  }

  const priority = merged.priority ?? DEFAULT_JOB_OPTIONS.priority;
  if (!Number.isFinite(priority)) {
    throw new ConfigError("priority must be a number", { priority });
  }

  return {
    // Clamped rather than rejected: a caller reaching for "highest possible"
    // means it, and the drivers order on a bounded range.
    priority: Math.max(-PRIORITY_LIMIT, Math.min(PRIORITY_LIMIT, priority)),
    attempts,
    backoff: merged.backoff ?? DEFAULT_JOB_OPTIONS.backoff,
    timeout: merged.timeout ?? DEFAULT_JOB_OPTIONS.timeout,
    removeOnComplete:
      merged.removeOnComplete ?? DEFAULT_JOB_OPTIONS.removeOnComplete,
    removeOnFail: merged.removeOnFail ?? DEFAULT_JOB_OPTIONS.removeOnFail,
    keepStacktraces:
      merged.keepStacktraces ?? DEFAULT_JOB_OPTIONS.keepStacktraces,
    ...(merged.keepLogs === undefined
      ? {}
      : { keepLogs: nonNegativeInteger(merged.keepLogs, "keepLogs") }),
    // Only present when named, so the stored options of every other job are
    // exactly what they were.
    ...(merged.deadLetter === undefined
      ? {}
      : {
          deadLetter: assertSegment(merged.deadLetter, "deadLetter queue name"),
        }),
    // Only present when set, like the others above.
    ...(merged.ignoreFailure ? { ignoreFailure: true } : {}),
  };
}

/**
 * Brings an id this package *derived* within {@link DERIVED_NAME_LIMITS} —
 * {@link MAX_JOB_ID_LENGTH} characters and the file driver's encoded-byte
 * budget — by keeping as much of the front as fits and ending it with a hash
 * of the whole.
 *
 * Derived ids are shortened rather than refused, because refusing one would
 * throw somewhere the caller never chose: a dead-letter id is built from the
 * dying job's (`<queue>:<id>:<createdAt>`), so a job with a legal, near-limit
 * id would otherwise fail *inside the worker's failure path* — the one place
 * an error helps nobody. The same goes for a repeat occurrence
 * (`repeat:<key>:<runAt>`) and a debounced job.
 *
 * **It must stay a pure function of its input.** Two workers independently
 * scheduling the same occurrence both derive `repeat:<key>:<runAt>` and rely
 * on reaching the same id, which is what makes the add idempotent. A
 * shortening that varied — by clock, by host, by random suffix — would let
 * both adds win and run the occurrence twice.
 *
 * The hash keeps ids that share a long prefix apart, which is exactly the case
 * plain truncation gets wrong: `<queue>:<very long id>:<t1>` and
 * `…:<t2>` differ only at the end.
 */
export function shortenJobId(id: string): string {
  return fitName(id, DERIVED_NAME_LIMITS);
}

/** A whole number of zero or more, or a `ConfigError` naming the option. */
function nonNegativeInteger(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${what} must be a whole number of zero or more`, {
      [what]: value,
    });
  }

  return value;
}

/** When a job becomes claimable: `runAt` if given, else `delay` from now. */
export function resolveRunAt(
  options: JobOptions | undefined,
  now: number,
): number {
  if (options?.runAt !== undefined) {
    const runAt =
      options.runAt instanceof Date ? options.runAt.getTime() : options.runAt;

    if (!Number.isFinite(runAt)) {
      throw new ConfigError("runAt must be a valid date or timestamp", {
        runAt: options.runAt,
      });
    }

    return runAt;
  }

  const delay = options?.delay ?? 0;
  if (!Number.isFinite(delay) || delay < 0) {
    throw new ConfigError("delay must be a non-negative number of ms", {
      delay,
    });
  }

  return now + delay;
}

/** When a finished job expires, given its retention. */
export function retentionExpiry(
  retention: Retention,
  now: number,
): number | null {
  if (typeof retention !== "object" || retention === null) {
    return null;
  }

  return retention.ttl && retention.ttl > 0 ? now + retention.ttl : null;
}
