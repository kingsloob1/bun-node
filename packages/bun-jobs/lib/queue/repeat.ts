import type {
  QueueRef,
  RepeatRecord,
  ResolvedJobOptions,
} from "../drivers/index";
import type { DateParser } from "../shared/humanTime";
import type { RepeatOptions } from "./types";
import { nextCronDate } from "../shared/cron";
import { ConfigError } from "../shared/errors";
import { fitName } from "../shared/fit";
import {
  looksLikeCron,
  parseDuration,
  parseWhen,
  readRecurrence,
} from "../shared/humanTime";
import { MAX_JOB_ID_LENGTH } from "./options";

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
 *
 * A generated key is fitted to {@link MAX_JOB_ID_LENGTH} characters — a job
 * records its series' key in a column of that width on MySQL and MariaDB —
 * deterministically, so every producer derives the same key for one series.
 * A caller's own key is returned as given; it is checked, not fitted.
 */
export function repeatKeyFor(name: string, repeat: ResolvedRepeat): string {
  if (repeat.key) {
    return repeat.key;
  }

  const schedule = repeat.cron
    ? `${repeat.cron}${repeat.tz ? `@${repeat.tz}` : ""}`
    : `every:${repeat.every}`;
  const start = repeat.startAt ?? "";

  return fitName(`${name}|${schedule}|${start}`, {
    maxLength: MAX_JOB_ID_LENGTH,
  });
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
    //
    // The first point on the grid strictly after `after`. Step zero is the
    // anchor itself, which is due when a series starts at `startAt` — `after`
    // is `startAt - 1` then, the same "not before" rule cron follows, so
    // "every 2 days from 1 December" runs on the 1st rather than the 3rd.
    // Without `startAt` the anchor is the creation time, never after `after`,
    // so the grid's first step comes out as one interval on by itself.
    const anchor = definition.startAt ?? definition.createdAt ?? after;
    const steps = Math.floor((after - anchor) / definition.every) + 1;
    next = anchor + Math.max(0, steps) * definition.every;
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

/**
 * Whether `zone` names a time zone this runtime knows. `Intl` is the
 * authority the schedule is later read with, so asking it now gives the same
 * answer that an occurrence would.
 */
export function isTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone.length === 0) {
    return false;
  }

  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuses a time zone this runtime does not know, with a `ConfigError` that
 * names it: `<where> does not know the time zone "<zone>"`, carrying the zone
 * as `context.tz` alongside `context`. Every place a repeat's zone arrives
 * checks it through here, so they all refuse it alike.
 */
export function assertTimeZone(
  zone: unknown,
  where: string,
  context: Record<string, unknown> = {},
): asserts zone is string {
  if (!isTimeZone(zone)) {
    throw new ConfigError(
      `${where} does not know the time zone "${String(zone)}"`,
      { ...context, tz: zone },
    );
  }
}

/** A repeat with every word read: intervals and instants as milliseconds. */
export type ResolvedRepeat = Omit<
  RepeatOptions,
  "every" | "startAt" | "endAt"
> & {
  /** Interval in milliseconds. */
  every?: number;
  /** Epoch milliseconds the series may begin. */
  startAt?: number;
  /** Epoch milliseconds the series ends. */
  endAt?: number;
};

/**
 * Reads the words in a repeat, against `now`.
 *
 * `every` may be milliseconds, a duration, a cron expression or a phrase with
 * dates in it; `startAt` and `endAt` may be words too. Dates a phrase names
 * fill `startAt`/`endAt` only when those were not given, since saying one
 * directly is the more specific thing to have said.
 *
 * Everything that reads a repeat goes through here first, so the series key,
 * the stored record and the first occurrence are all worked out from the same
 * numbers.
 */
export function resolveRepeat(
  repeat: RepeatOptions,
  now: number,
  what = "repeat",
  parser?: DateParser,
): ResolvedRepeat {
  const { every, startAt, endAt, ...rest } = repeat;

  // Checked first, so a zone the runtime does not know is refused the same
  // way however the repeat was given (`add()`'s `repeat`, a builder's
  // `repeatEvery()` or `withOptions()`, a draft) and before anything is
  // written. A cron series would otherwise fail later, through whatever the
  // cron parser says, and an interval series would store the zone unread.
  if (repeat.tz !== undefined) {
    assertTimeZone(repeat.tz, `${what}.tz`, { option: `${what}.tz` });
  }

  const resolved: ResolvedRepeat = { ...rest };
  let phraseStart: number | undefined;
  let phraseEnd: number | undefined;

  if (typeof every === "number") {
    resolved.every = every;
  } else if (typeof every === "string") {
    const duration = parseDuration(
      every.trim().replace(/^(?:every|each)\s+/i, ""),
    );

    if (duration !== null) {
      resolved.every = duration;
    } else if (looksLikeCron(every)) {
      if (repeat.cron !== undefined && repeat.cron !== every) {
        throw new ConfigError(
          `${what} was given two cron expressions, in cron and in every`,
          { cron: repeat.cron, every },
        );
      }

      resolved.cron = every;
    } else {
      const recurrence = readRecurrence(every, `${what}.every`, now, parser);
      resolved.every = recurrence.every;
      phraseStart = recurrence.startAt;
      phraseEnd = recurrence.endAt;
    }
  }

  const start = startAt ?? phraseStart;
  const end = endAt ?? phraseEnd;

  if (start !== undefined) {
    resolved.startAt = readInstant(start, `${what}.startAt`, now, parser);
  }

  if (end !== undefined) {
    resolved.endAt = readInstant(end, `${what}.endAt`, now, parser);
  }

  return resolved;
}

/** Epoch milliseconds from a `Date`, a number, or words. */
function readInstant(
  value: Date | number | string,
  what: string,
  now: number,
  parser: DateParser | undefined,
): number {
  return typeof value === "string"
    ? parseWhen(value, what, now, parser)
    : toMs(value, what);
}

/** Builds the stored definition for a series. */
export function toRepeatRecord(
  q: QueueRef,
  name: string,
  data: unknown,
  opts: ResolvedJobOptions,
  options: RepeatOptions,
  now: number,
  parser?: DateParser,
): RepeatRecord {
  const repeat = resolveRepeat(options, now, "repeat", parser);

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
    ...(repeat.startAt !== undefined ? { startAt: repeat.startAt } : {}),
    ...(repeat.endAt !== undefined ? { endAt: repeat.endAt } : {}),
    ...(repeat.limit !== undefined ? { limit: repeat.limit } : {}),
    // Stored as given, `false` included, so a series reads back the way it was
    // created. Left out only when unset — the worker reads absent as `false`,
    // which is also how a series stored before `false` was kept reads back.
    ...(repeat.catchUp !== undefined ? { catchUp: repeat.catchUp } : {}),
    count: 0,
    nextRunAt: null,
    nextJobId: null,
    createdAt: now,
    updatedAt: now,
  };
}
