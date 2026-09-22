import type {
  JobDefaultBackoffType,
  JobDefaultKey,
} from "../../../../api/contract";
import type {
  JobDefaultBackoff,
  JobDefaultsBody,
  JobDefaultsDto,
  JobDefaultsValues,
  RetentionDto,
} from "../../../../api/types";
import {
  JOB_DEFAULT_BACKOFF_TYPES,
  JOB_DEFAULT_KEYS,
  JOB_DEFAULTS_BOUNDS,
} from "../../../../api/contract";
import { formatNumber } from "../../../../format";
import { formatMs } from "../../duration";

/**
 * The job-defaults form's model: what each contract key edits as, the draft
 * the inputs hold, and the merge patch a save sends. Every list and bound
 * comes from the contract (`JOB_DEFAULT_KEYS`, `JOB_DEFAULT_BACKOFF_TYPES`,
 * `JOB_DEFAULTS_BOUNDS`); {@link KEY_KIND} is typed against `JobDefaultKey`,
 * so a key the contract adds fails to compile here until it has an editor.
 */

/** How one key is edited: a whole number, a backoff, or a retention. */
export type KeyKind = "number" | "backoff" | "retention";

/** The editor of each key the contract lets a queue store. */
export const KEY_KIND = {
  attempts: "number",
  backoff: "backoff",
  timeout: "number",
  priority: "number",
  removeOnComplete: "retention",
  removeOnFail: "retention",
  keepLogs: "number",
  keepStacktraces: "number",
} as const satisfies Readonly<Record<JobDefaultKey, KeyKind>>;

/** The keys edited as one whole number; each has its own `JOB_DEFAULTS_BOUNDS` entry. */
export type NumberKey = {
  [K in JobDefaultKey]: (typeof KEY_KIND)[K] extends "number" ? K : never;
}[JobDefaultKey];

/** The keys edited as a retention. */
export type RetentionKey = {
  [K in JobDefaultKey]: (typeof KEY_KIND)[K] extends "retention" ? K : never;
}[JobDefaultKey];

/** Each key's label and one-line explanation, under its input and in the summary. */
export const KEY_TEXT: Readonly<
  Record<JobDefaultKey, { label: string; hint: string }>
> = {
  attempts: {
    label: "Attempts",
    hint: "How many times a job runs before it is dead, the first run included.",
  },
  backoff: {
    label: "Backoff",
    hint: "How long a failed job waits before its next attempt.",
  },
  timeout: {
    label: "Timeout (ms)",
    hint: "How long one attempt may run before it fails; 0 means no timeout.",
  },
  priority: {
    label: "Priority",
    hint: "Lower runs first.",
  },
  removeOnComplete: {
    label: "Completed jobs",
    hint: "How long a completed job is kept.",
  },
  removeOnFail: {
    label: "Dead jobs",
    hint: "How long a job that ran out of attempts is kept.",
  },
  keepLogs: {
    label: "Log lines kept",
    hint: "The newest log lines each job keeps.",
  },
  keepStacktraces: {
    label: "Stack traces kept",
    hint: "The failure stack traces each job keeps.",
  },
};

/** The inclusive bounds of a number key, from the contract. */
export function numberBounds(key: NumberKey): { min: number; max: number } {
  return JOB_DEFAULTS_BOUNDS[key];
}

/** A backoff as the form holds it. */
export interface BackoffDraft {
  /** The strategy: one of `JOB_DEFAULT_BACKOFF_TYPES`. */
  type: JobDefaultBackoffType;
  /** Base delay, ms; `undefined` while the box is empty. */
  delay: number | undefined;
  /** Longest delay, ms; `undefined` for uncapped. */
  max: number | undefined;
  /** Fraction of each delay randomised, 0 … 1; `undefined` for none. */
  jitter: number | undefined;
}

/** What a retention does: keep forever (`false`), remove at once (`true`), or keep some. */
export type RetentionMode = "keep" | "remove" | "limit";

/** A retention as the form holds it. */
export interface RetentionDraft {
  /** Keep forever, remove at once, or keep up to a count and/or an age. */
  mode: RetentionMode;
  /** With `limit`: most jobs kept; `undefined` for no count. */
  count: number | undefined;
  /** With `limit`: oldest job kept, ms; `undefined` for no age. */
  ttl: number | undefined;
}

/** The form's value of one key. */
export type DraftOf<K extends JobDefaultKey> = K extends JobDefaultKey
  ? (typeof KEY_KIND)[K] extends "number"
    ? number | undefined
    : (typeof KEY_KIND)[K] extends "backoff"
      ? BackoffDraft
      : RetentionDraft
  : never;

/** A key marked "use the code value": the save sends `null` for it. */
export const USE_CODE = "code" as const;

/**
 * What has been edited: only keys the user touched are present, each with its
 * value or {@link USE_CODE}. An untouched key is left out of the patch.
 */
export type Draft = {
  [K in JobDefaultKey]?: DraftOf<K> | typeof USE_CODE;
};

/** Whether a backoff strategy may be stored remotely. */
function isStorableType(type: unknown): type is JobDefaultBackoffType {
  return (JOB_DEFAULT_BACKOFF_TYPES as readonly unknown[]).includes(type);
}

/** The form's starting value of a backoff: a bare number is a fixed delay; a strategy that cannot be stored starts as `fixed`. */
export function backoffDraft(
  value: JobDefaultsValues["backoff"],
): BackoffDraft {
  if (typeof value === "number") {
    return { type: "fixed", delay: value, max: undefined, jitter: undefined };
  }
  return {
    type: isStorableType(value.type) ? value.type : "fixed",
    delay: value.delay,
    max: value.max,
    // A code value may say `jitter: true`, which a stored default cannot.
    jitter: typeof value.jitter === "number" ? value.jitter : undefined,
  };
}

/** The form's starting value of a retention. */
export function retentionDraft(value: RetentionDto): RetentionDraft {
  if (value === true) {
    return { mode: "remove", count: undefined, ttl: undefined };
  }
  if (value === false) {
    return { mode: "keep", count: undefined, ttl: undefined };
  }
  if (typeof value === "number") {
    return { mode: "limit", count: value, ttl: undefined };
  }
  return { mode: "limit", count: value.count, ttl: value.ttl };
}

/** The form's value of `key`, starting from a value the API sent. */
export function draftOf<K extends JobDefaultKey>(
  key: K,
  value: JobDefaultsValues[K],
): DraftOf<K> {
  const kind: KeyKind = KEY_KIND[key];
  if (kind === "backoff") {
    return backoffDraft(value as JobDefaultsValues["backoff"]) as DraftOf<K>;
  }
  if (kind === "retention") {
    return retentionDraft(value as RetentionDto) as DraftOf<K>;
  }
  return value as DraftOf<K>;
}

/** Why a whole number is refused, or `undefined` when it is fine. */
function wholeProblem(
  value: number | undefined,
  bounds: { min: number; max: number },
  what: string,
): string | undefined {
  if (value === undefined) {
    return `Enter ${what}.`;
  }
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    return `${capitalise(what)} must be a whole number from ${formatNumber(bounds.min)} to ${formatNumber(bounds.max)}.`;
  }
  return undefined;
}

/** `"a delay"` → `"A delay"`. */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A key's value to store, or why the form cannot send it. */
export type Parsed<T> = { value: T } | { error: string };

/** The backoff to store, from the form. */
export function parseBackoff(draft: BackoffDraft): Parsed<JobDefaultBackoff> {
  const delayProblem = wholeProblem(
    draft.delay,
    JOB_DEFAULTS_BOUNDS.backoffDelay,
    "a delay",
  );
  if (delayProblem) {
    return { error: delayProblem };
  }
  const delay = draft.delay!;
  if (draft.max !== undefined) {
    const maxProblem = wholeProblem(
      draft.max,
      JOB_DEFAULTS_BOUNDS.backoffMax,
      "the longest delay",
    );
    if (maxProblem) {
      return { error: maxProblem };
    }
    if (draft.max < delay) {
      return { error: "The longest delay must be at least the delay." };
    }
  }
  const jitterBounds = JOB_DEFAULTS_BOUNDS.backoffJitter;
  if (
    draft.jitter !== undefined &&
    !(draft.jitter >= jitterBounds.min && draft.jitter <= jitterBounds.max)
  ) {
    return {
      error: `Jitter must be from ${jitterBounds.min} to ${jitterBounds.max}.`,
    };
  }
  return {
    value: {
      type: draft.type,
      delay,
      ...(draft.max === undefined ? {} : { max: draft.max }),
      ...(draft.jitter === undefined ? {} : { jitter: draft.jitter }),
    },
  };
}

/** The retention to store, from the form. */
export function parseRetention(draft: RetentionDraft): Parsed<RetentionDto> {
  if (draft.mode === "keep") {
    return { value: false };
  }
  if (draft.mode === "remove") {
    return { value: true };
  }
  if (draft.count === undefined && draft.ttl === undefined) {
    return { error: "Enter a count, an age, or both." };
  }
  if (draft.count !== undefined) {
    const problem = wholeProblem(
      draft.count,
      JOB_DEFAULTS_BOUNDS.retentionCount,
      "the count",
    );
    if (problem) {
      return { error: problem };
    }
  }
  if (draft.ttl !== undefined) {
    const problem = wholeProblem(
      draft.ttl,
      JOB_DEFAULTS_BOUNDS.retentionTtl,
      "the age",
    );
    if (problem) {
      return { error: problem };
    }
  }
  return {
    value: {
      ...(draft.count === undefined ? {} : { count: draft.count }),
      ...(draft.ttl === undefined ? {} : { ttl: draft.ttl }),
    },
  };
}

/** The value to store for one key, from its form value. */
export function parseKey(
  key: JobDefaultKey,
  draft: DraftOf<JobDefaultKey>,
): Parsed<unknown> {
  const kind: KeyKind = KEY_KIND[key];
  if (kind === "backoff") {
    return parseBackoff(draft as BackoffDraft);
  }
  if (kind === "retention") {
    return parseRetention(draft as RetentionDraft);
  }
  const problem = wholeProblem(
    draft as number | undefined,
    numberBounds(key as NumberKey),
    "a value",
  );
  return problem ? { error: problem } : { value: draft };
}

/**
 * A value in one canonical form, so two spellings of one setting compare
 * equal: a bare-number backoff is a fixed delay, a bare-number retention a
 * count, and object keys are sorted with absent fields dropped.
 */
export function canonical(key: JobDefaultKey, value: unknown): string {
  let normal = value;
  if (KEY_KIND[key] === "backoff" && typeof value === "number") {
    normal = { type: "fixed", delay: value };
  } else if (KEY_KIND[key] === "retention" && typeof value === "number") {
    normal = { count: value };
  }
  if (typeof normal === "object" && normal !== null) {
    const record = normal as Record<string, unknown>;
    return JSON.stringify(
      Object.fromEntries(
        Object.keys(record)
          .filter((name) => record[name] !== undefined)
          .sort()
          .map((name) => [name, record[name]]),
      ),
    );
  }
  return JSON.stringify(normal);
}

/** What a save would send, and what stops it. */
export interface PatchPlan {
  /** The merge patch: only changed keys, `null` for "use the code value", and `expectedSeq`. */
  body: JobDefaultsBody;
  /** The keys the patch changes, in `JOB_DEFAULT_KEYS` order. */
  changed: JobDefaultKey[];
  /** Why a key cannot be sent, by key; a save is refused while any is present. */
  errors: Partial<Record<JobDefaultKey, string>>;
}

/**
 * The merge patch for a draft, against the defaults it was edited from. A key
 * is sent only when its value differs from what a job gets now (`effective`);
 * "use the code value" sends `null`, and only for a key that is overridden
 * (otherwise it already is the code's). `expectedSeq` is the `seq` read, so a
 * save racing another answers 409 instead of overwriting it.
 */
export function planPatch(defaults: JobDefaultsDto, draft: Draft): PatchPlan {
  const body: JobDefaultsBody = {};
  const fields = body as Record<string, unknown>;
  const changed: JobDefaultKey[] = [];
  const errors: Partial<Record<JobDefaultKey, string>> = {};
  for (const key of JOB_DEFAULT_KEYS) {
    if (!(key in draft)) {
      continue;
    }
    const edited = draft[key];
    if (edited === USE_CODE) {
      if (defaults.overridden.includes(key)) {
        fields[key] = null;
        changed.push(key);
      }
      continue;
    }
    const parsed = parseKey(key, edited as DraftOf<JobDefaultKey>);
    if ("error" in parsed) {
      errors[key] = parsed.error;
      continue;
    }
    if (
      canonical(key, parsed.value) !== canonical(key, defaults.effective[key])
    ) {
      fields[key] = parsed.value;
      changed.push(key);
    }
  }
  body.expectedSeq = defaults.seq;
  return { body, changed, errors };
}

/** A retention in words. */
function describeRetention(value: RetentionDto): string {
  if (value === true) {
    return "removed at once";
  }
  if (value === false) {
    return "kept forever";
  }
  if (typeof value === "number") {
    return `the newest ${formatNumber(value)} kept`;
  }
  const parts = [
    value.count !== undefined && `the newest ${formatNumber(value.count)}`,
    value.ttl !== undefined && `for ${formatMs(value.ttl)}`,
  ].filter(Boolean);
  return parts.length > 0 ? `kept: ${parts.join(", ")}` : "kept forever";
}

/** A backoff in words. */
function describeBackoff(value: JobDefaultsValues["backoff"]): string {
  if (typeof value === "number") {
    return value === 0 ? "none" : `fixed, ${formatMs(value)}`;
  }
  const parts = [
    `${value.type ?? "fixed"}, ${formatMs(value.delay ?? 0)}`,
    value.max !== undefined && `at most ${formatMs(value.max)}`,
    value.jitter === true && "jitter",
    typeof value.jitter === "number" &&
      value.jitter > 0 &&
      `${Math.round(value.jitter * 100)}% jitter`,
  ].filter(Boolean);
  return parts.join(", ");
}

/** One key's value in words, for the summary and the dialogs. */
export function describeValue(key: JobDefaultKey, value: unknown): string {
  if (value === undefined || value === null) {
    return "—";
  }
  switch (key) {
    case "backoff":
      return describeBackoff(value as JobDefaultsValues["backoff"]);
    case "removeOnComplete":
    case "removeOnFail":
      return describeRetention(value as RetentionDto);
    case "timeout":
      return value === 0 ? "none" : formatMs(value as number);
    case "keepLogs":
      return value === 0 ? "every line" : formatNumber(value as number);
    default:
      return formatNumber(value as number);
  }
}
