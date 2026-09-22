import { NOW_TICK_MS } from "../hooks/useNow";

/** Units from the smallest up, with how many seconds each spans. */
const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 1],
  ["minute", 60],
  ["hour", 3_600],
  ["day", 86_400],
  ["week", 604_800],
  ["month", 2_629_800],
  ["year", 31_557_600],
];

/** When to switch to the next unit: 45 s → minutes, 45 min → hours, 22 h → days, 6 d → weeks, 4 w → months, 11 mo → years. */
const THRESHOLDS: Readonly<
  Partial<Record<Intl.RelativeTimeFormatUnit, number>>
> = {
  second: 45,
  minute: 45,
  hour: 22,
  day: 6,
  week: 4,
  month: 11,
};

/** Formatters by locale, built once. */
const formatters = new Map<string, Intl.RelativeTimeFormat>();

/** A narrow, `numeric: "auto"` formatter for a locale ("3m ago", "in 2h", "now", "yesterday"). */
function formatter(locale: string | undefined): Intl.RelativeTimeFormat {
  const key = locale ?? "";
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.RelativeTimeFormat(locale, {
      numeric: "auto",
      style: "narrow",
    });
    formatters.set(key, found);
  }
  return found;
}

/**
 * How far ahead of `now` an instant may be and still read "now": one tick of
 * the shared clock. Every relative time in the app is rendered against that
 * cached clock, so anything recorded since its last tick is legitimately
 * ahead of it — a worker's heartbeat written a moment ago rendered as
 * "in 2s" until the clock caught up. Beyond a tick it is a real future time
 * (a delayed job, a next run) and is shown as one.
 */
const FUTURE_TOLERANCE_S = NOW_TICK_MS / 1_000;

/**
 * `ms` relative to `now`: "3m ago", "in 2h", "now", "yesterday". The unit
 * is the largest that keeps the number at or above 1. An instant up to
 * {@link FUTURE_TOLERANCE_S} ahead reads "now".
 */
export function formatRelativeTime(
  ms: number,
  now: number,
  locale?: string,
): string {
  const ahead = (ms - now) / 1000;
  const seconds = ahead > 0 && ahead <= FUTURE_TOLERANCE_S ? 0 : ahead;
  const abs = Math.abs(seconds);
  for (let i = 0; i < UNITS.length; i++) {
    const [unit, span] = UNITS[i]!;
    const limit = THRESHOLDS[unit];
    if (limit === undefined || abs / span < limit) {
      return formatter(locale).format(Math.round(seconds / span), unit);
    }
  }
  return formatter(locale).format(Math.round(seconds / 31_557_600), "year");
}

/** Normalises a time input to epoch ms; `null` for missing or invalid. */
export function toEpochMs(
  value: number | string | Date | null | undefined,
): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
