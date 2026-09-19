import { MAX_DATE_MS } from "../api/contract";

/**
 * Value conversions of the kit's inputs, pure. The `datetime-local` value
 * (`YYYY-MM-DDTHH:mm[:ss]`) is wall-clock time in the browser's own time
 * zone.
 */

/** Parses an `<input type="number">` value: `""` (empty or unparsable) → `undefined`. */
export function parseNumberInput(text: string): number | undefined {
  if (text.trim() === "") {
    return undefined;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/** Pads to two digits. */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Epoch ms → a `datetime-local` value in local time. Seconds are included
 * when `withSeconds` is set; otherwise the value is truncated to the minute.
 * `undefined`/`NaN` → `""`.
 */
export function toDateTimeLocal(
  ms: number | undefined | null,
  withSeconds = false,
): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) {
    return "";
  }
  const date = new Date(ms);
  const day = `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `${day}T${time}${withSeconds ? `:${pad(date.getSeconds())}` : ""}`;
}

/** The shape a `datetime-local` value takes. */
const DATE_TIME_LOCAL =
  /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

/** A `datetime-local` value → epoch ms, read as local time; `undefined` when empty or malformed. */
export function fromDateTimeLocal(text: string): number | undefined {
  const match = DATE_TIME_LOCAL.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const [, year, month, day, hours, minutes, seconds, fraction] = match;
  const ms = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds ?? 0),
    Number((fraction ?? "0").padEnd(3, "0")),
  ).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/** Shown for a `datetime-local` value the browser could not read, or that is malformed. */
export const DATE_TIME_UNREADABLE =
  "Not a date and time this browser can read. Pick one again, or clear the field.";

/**
 * Shown for a time outside what the API accepts: epoch ms from 0 to
 * `MAX_DATE_MS`, the last instant a `Date` holds (the API refuses anything
 * else with 400 `VALIDATION` at the field).
 */
export const DATE_TIME_OUT_OF_RANGE =
  "Pick a time from 1 January 1970 to 13 September 275760 (UTC): the API accepts no other.";

/** What {@link readDateTimeLocal} found in a `datetime-local` value. */
export type DateTimeReading =
  /** Nothing: the field was cleared. */
  | { kind: "empty" }
  /** A time the API accepts, epoch ms. */
  | { kind: "time"; ms: number }
  /** Something unusable; `problem` says why, for the field's error. */
  | { kind: "problem"; problem: string };

/**
 * Reads a `datetime-local` value the way the API will judge it. Empty is
 * `empty` unless the browser flags a half-typed entry (`badInput`, for which
 * it reports `""`). A malformed value, or one naming a day that does not
 * exist, is {@link DATE_TIME_UNREADABLE}; a time before the epoch or after
 * `MAX_DATE_MS` (which `Date` cannot even build) is
 * {@link DATE_TIME_OUT_OF_RANGE}.
 */
export function readDateTimeLocal(
  text: string,
  badInput = false,
): DateTimeReading {
  const trimmed = text.trim();
  if (trimmed === "") {
    return badInput
      ? { kind: "problem", problem: DATE_TIME_UNREADABLE }
      : { kind: "empty" };
  }
  const match = DATE_TIME_LOCAL.exec(trimmed);
  if (!match) {
    return { kind: "problem", problem: DATE_TIME_UNREADABLE };
  }
  const [, year, month, day, hours, minutes, seconds] = match.map(Number);
  if (
    month! < 1 ||
    month! > 12 ||
    day! < 1 ||
    day! > daysInMonth(year!, month!) ||
    hours! > 23 ||
    minutes! > 59 ||
    (seconds ?? 0) > 59
  ) {
    return { kind: "problem", problem: DATE_TIME_UNREADABLE };
  }
  const ms = fromDateTimeLocal(trimmed);
  if (ms === undefined || ms < 0 || ms > MAX_DATE_MS) {
    return { kind: "problem", problem: DATE_TIME_OUT_OF_RANGE };
  }
  return { kind: "time", ms };
}

/** Days in a month (1-12) of a proleptic Gregorian year. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** The browser's time zone name (e.g. `"Europe/London"`), or `"local time"` when unknown. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  } catch {
    return "local time";
  }
}
