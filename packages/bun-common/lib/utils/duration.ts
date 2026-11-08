/**
 * Durations written the way people say them — `"90s"`, `"1m"`, `"1h 30m"`,
 * `"2 days"` — read as milliseconds.
 *
 * The grammar is bun-jobs' `parseDuration` (`packages/bun-jobs/lib/shared/
 * humanTime.ts`), copied rather than imported because bun-jobs depends on
 * bun-common and not the other way round: one or more `<number><unit>` pairs,
 * with or without spaces, units from `ms` to `y` in their short and long
 * spellings. A month is 30.4375 days and a year 365.25, the averages a
 * *duration* can mean.
 */
import { ConfigError } from "../errors";

/** Milliseconds in each unit a duration may be written in. */
const UNITS: readonly (readonly [RegExp, number])[] = [
  [/^(?:ms|milliseconds?)$/i, 1],
  [/^(?:s|secs?|seconds?)$/i, 1_000],
  [/^(?:m|mins?|minutes?)$/i, 60_000],
  [/^(?:h|hrs?|hours?)$/i, 3_600_000],
  [/^(?:d|days?)$/i, 86_400_000],
  [/^(?:w|wks?|weeks?)$/i, 604_800_000],
  [/^(?:mo|mons?|months?)$/i, 2_629_800_000],
  [/^(?:y|yrs?|years?)$/i, 31_557_600_000],
];

/** One `<number><unit>` pair, with or without a space between them. */
const PART = /(\d+(?:\.\d+)?)\s*([a-z]+)/gi;

/**
 * A duration with its units spelled out, summed: `{ seconds: 30 }`,
 * `{ minutes: 1, seconds: 30 }`. At least one field; each a non-negative
 * finite number.
 */
export interface DurationObject {
  /** Milliseconds. */
  readonly ms?: number;
  /** Seconds. */
  readonly seconds?: number;
  /** Minutes. */
  readonly minutes?: number;
  /** Hours. */
  readonly hours?: number;
  /** Days (24 h). */
  readonly days?: number;
  /** Weeks (7 days). */
  readonly weeks?: number;
}

/**
 * A duration, its unit always explicit: a string such as `"30s"`, `"1m"`,
 * `"1h 30m"` or `"2 days"` (see {@link parseDuration}), or a
 * {@link DurationObject} such as `{ seconds: 30 }`. Never a bare number: is
 * `60` a minute or 60 ms? (ConcaveHR's `THROTTLE_TTL=60` was read as 60 ms
 * by `@nestjs/throttler` 6, which disabled its throttling.)
 */
export type Duration = DurationObject | string;

/** Milliseconds per {@link DurationObject} field. */
const OBJECT_UNITS: Readonly<Record<keyof DurationObject, number>> = {
  ms: 1,
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
};

/**
 * Reads a duration string (`"90s"`, `"1h 30m"`, `"2 days"`) as
 * milliseconds; `null` when the string is not a duration at all (an unknown
 * unit, words left over, nothing to read). A bare number in a string
 * (`"500"`) is not a duration: write the unit.
 */
export function parseDuration(input: string): number | null {
  const text = input.trim();
  if (text.length === 0) {
    return null;
  }
  let total = 0;
  let matched = false;
  PART.lastIndex = 0;
  for (let part = PART.exec(text); part !== null; part = PART.exec(text)) {
    const unitText = part[2];
    const unit = UNITS.find(([pattern]) => pattern.test(unitText));
    if (unit === undefined) {
      return null;
    }
    total += Number(part[1]) * unit[1];
    matched = true;
  }
  if (!matched) {
    return null;
  }
  // Everything that was not a pair has to be separators: "2 days after
  // friday" is not a duration, and answering 172800000 would be worse than
  // saying so.
  return text.replace(PART, "").trim().length === 0 ? total : null;
}

/** A {@link DurationObject} as milliseconds; `null` when it is not one. */
function objectMs(value: object): number | null {
  let total = 0;
  let fields = 0;
  for (const [field, amount] of Object.entries(value)) {
    const unit = OBJECT_UNITS[field as keyof DurationObject] as
      number | undefined;
    if (
      unit === undefined ||
      typeof amount !== "number" ||
      !Number.isFinite(amount) ||
      amount < 0
    ) {
      return null;
    }
    total += amount * unit;
    fields++;
  }
  return fields === 0 ? null : total;
}

/**
 * A {@link Duration} as whole milliseconds, checked: a string
 * {@link parseDuration} reads or a {@link DurationObject}, positive. A bare
 * number is refused, as is anything else, with a {@link ConfigError} naming
 * `what`, so a bad option fails at startup.
 *
 * @param value The duration given.
 * @param what  The option's name, for the error (`"throttle(): window"`).
 */
export function toDurationMs(value: Duration, what: string): number {
  if (typeof value === "number") {
    throw new ConfigError(
      `${what}: a bare number is ambiguous (milliseconds or seconds?); write the unit: "${String(value)}ms", "${String(value)}s", or { seconds: ${String(value)} }`,
      { value },
    );
  }
  const ms =
    typeof value === "string"
      ? parseDuration(value)
      : value !== null && typeof value === "object"
        ? objectMs(value)
        : null;
  if (ms === null || !Number.isFinite(ms) || Math.round(ms) <= 0) {
    throw new ConfigError(
      `${what} must be a positive duration such as "1m", "30s" or { seconds: 30 }; got ${JSON.stringify(value)}`,
      { value },
    );
  }
  return Math.round(ms);
}
