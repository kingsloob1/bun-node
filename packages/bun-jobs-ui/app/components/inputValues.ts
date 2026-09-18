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

/** The browser's time zone name (e.g. `"Europe/London"`), or `"local time"` when unknown. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  } catch {
    return "local time";
  }
}
