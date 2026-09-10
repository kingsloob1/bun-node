import type {
  QueueRef,
  RepeatRecord,
  ResolvedJobOptions,
} from "../drivers/index";
import type { RepeatOptions } from "./types";
import { nextCronDate } from "../shared/cron";
import { ConfigError } from "../shared/errors";

/**
 * Repeatable jobs.
 *
 * The whole design turns on one idea: the id of the next occurrence is
 * derived from the series key and the time it is due, so scheduling it is
 * idempotent*. Any number of workers may notice a series needs its next
 * occurrence and all of them may try to add it; the driver's add-if-absent
 * makes them agree, and no election or lock is needed anywhere.
 */

/** The id of the occurrence of `key` due at `runAt`. */
export function repeatJobId(key: string, runAt: number): string {
  return `repeat:${key}:${runAt}`;
}

/**
 * Identifies a series. Derived from what makes it distinct, so adding the
 * same repeat twice updates it rather than creating a rival series.
 */
export function repeatKeyFor(name: string, repeat: RepeatOptions): string {
  if (repeat.key) {
    return repeat.key;
  }

  const schedule = repeat.cron
    ? `${repeat.cron}${repeat.tz ? `@${repeat.tz}` : ""}`
    : `every:${repeat.every}`;
  const start = repeat.startAt ? toMs(repeat.startAt, "repeat.startAt") : "";

  return `${name}|${schedule}|${start}`;
}

/** Epoch milliseconds from a `Date` or number. */
function toMs(value: Date | number, what: string): number {
  const ms = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(ms)) {
    throw new ConfigError(`${what} must be a valid date or timestamp`, {
      value,
    });
  }
  return ms;
}

/**
 * When the occurrence after `from` is due, or `null` when the series has
 * finished — its limit reached, or its end passed.
 */
export function nextOccurrence(
  definition: Pick<
    RepeatRecord,
    | "cron"
    | "tz"
    | "every"
    | "startAt"
    | "endAt"
    | "limit"
    | "count"
    | "createdAt"
  >,
  from: number,
): number | null {
  if (definition.limit !== undefined && definition.count >= definition.limit) {
    return null;
  }

  const after = Math.max(from, (definition.startAt ?? 0) - 1);

  let next: number | null;
  if (definition.cron) {
    const date = nextCronDate(
      definition.cron,
      new Date(after),
      definition.tz ? { tz: definition.tz } : undefined,
    );
    next = date ? date.getTime() : null;
  } else if (definition.every && definition.every > 0) {
    // Anchored to the series, not to the caller's clock. Anchoring on `from`
    // makes the grid move every time it is asked: two `add` calls a
    // millisecond apart then compute different instants, derive different
    // ids, and the series that is meant to be idempotent gains a second
    // pending occurrence. The creation time is fixed, so the grid is too —
    // which also keeps a long-running series drift-free.
    const anchor = definition.startAt ?? definition.createdAt ?? after;
    const steps = Math.floor((after - anchor) / definition.every) + 1;
    next = anchor + Math.max(1, steps) * definition.every;
  } else {
    throw new ConfigError("A repeat needs either a cron expression or every", {
      repeat: definition,
    });
  }

  if (next === null) {
    return null;
  }

  if (definition.endAt !== undefined && next > definition.endAt) {
    return null;
  }

  return next;
}

/** Builds the stored definition for a series. */
export function toRepeatRecord(
  q: QueueRef,
  name: string,
  data: unknown,
  opts: ResolvedJobOptions,
  repeat: RepeatOptions,
  now: number,
): RepeatRecord {
  if (!repeat.cron && !(repeat.every && repeat.every > 0)) {
    throw new ConfigError("A repeat needs either a cron expression or every", {
      repeat,
    });
  }

  return {
    key: repeatKeyFor(name, repeat),
    name,
    data,
    opts,
    ...(repeat.cron ? { cron: repeat.cron } : {}),
    ...(repeat.tz ? { tz: repeat.tz } : {}),
    ...(repeat.every ? { every: repeat.every } : {}),
    ...(repeat.startAt !== undefined
      ? { startAt: toMs(repeat.startAt, "repeat.startAt") }
      : {}),
    ...(repeat.endAt !== undefined
      ? { endAt: toMs(repeat.endAt, "repeat.endAt") }
      : {}),
    ...(repeat.limit !== undefined ? { limit: repeat.limit } : {}),
    count: 0,
    nextRunAt: null,
    nextJobId: null,
    createdAt: now,
    updatedAt: now,
  };
}
