import type { AnalyticsPreset } from "../api/contract";
import {
  ANALYTICS_PRESETS,
  DEFAULT_ANALYTICS_PRESET,
  MAX_ANALYTICS_SPAN_MS,
  MIN_ANALYTICS_SPAN_MS,
} from "../api/contract";

/**
 * The time range the analytics views are read over: a rolling preset ("the
 * last 10 minutes") or a fixed custom span between two instants.
 *
 * A preset is stored as its duration, not as the instants it resolved to, so
 * a screen left open keeps following the clock; a custom range is stored as
 * the two instants, so it stays where it was put. Both live in the URL, so a
 * view is shareable and survives a reload.
 */

/**
 * The rolling presets and the default, from the contract: the server decides
 * what it offers, and the UI must not hold a second list that can drift.
 */
export const RANGE_PRESETS = ANALYTICS_PRESETS;

/** One rolling preset, in seconds. */
export type RangePreset = AnalyticsPreset;

/** The preset a view opens on: the last hour, as the Overview always used. */
export const DEFAULT_PRESET: RangePreset = DEFAULT_ANALYTICS_PRESET;

/** How each preset reads. */
export const PRESET_LABELS: Readonly<Record<RangePreset, string>> = {
  60: "Last 60 seconds",
  300: "Last 5 minutes",
  600: "Last 10 minutes",
  1800: "Last 30 minutes",
  3600: "Last hour",
  21600: "Last 6 hours",
  86400: "Last 24 hours",
};

/** A rolling window ending now. */
export interface PresetRange {
  /** Discriminator. */
  kind: "preset";
  /** Its length in seconds. */
  seconds: RangePreset;
}

/** A fixed span between two instants. */
export interface CustomRange {
  /** Discriminator. */
  kind: "custom";
  /** Start, epoch ms, inclusive. */
  from: number;
  /** End, epoch ms, exclusive. */
  to: number;
}

/** What an analytics view is read over. */
export type TimeRange = PresetRange | CustomRange;

/**
 * The longest span a view asks for, from the contract. A deployment reports
 * its own in `meta.analytics.maxSpanMs`, which a picker passes as `maxSpan`;
 * this is the fallback for an API that reports none.
 */
export const MAX_RANGE_MS = MAX_ANALYTICS_SPAN_MS;

/** The shortest custom span that still holds a bucket, from the contract. */
export const MIN_RANGE_MS = MIN_ANALYTICS_SPAN_MS;

/** The default range: {@link DEFAULT_PRESET}, rolling. */
export function defaultRange(): TimeRange {
  return { kind: "preset", seconds: DEFAULT_PRESET };
}

/** The instants a range covers right now; a preset resolves against `now`. */
export function rangeBounds(
  range: TimeRange,
  now = Date.now(),
): { from: number; to: number } {
  return range.kind === "preset"
    ? { from: now - range.seconds * 1_000, to: now }
    : { from: range.from, to: range.to };
}

/** A range's length in ms. */
export function rangeLength(range: TimeRange, now = Date.now()): number {
  const { from, to } = rangeBounds(range, now);
  return to - from;
}

/** How a span reads in a message: "24 hours", "31 days", "90 minutes". */
function describeSpan(ms: number): string {
  const units: [number, string][] = [
    [24 * 60 * 60 * 1_000, "day"],
    [60 * 60 * 1_000, "hour"],
    [60 * 1_000, "minute"],
    [1_000, "second"],
  ];
  for (const [size, name] of units) {
    if (ms >= size && ms % size === 0) {
      const count = ms / size;
      return `${count} ${name}${count === 1 ? "" : "s"}`;
    }
  }
  return `${Math.round(ms / 1_000)} seconds`;
}

/**
 * Why a custom range is not usable, or `null` when it is. `maxSpan` is what
 * the API says it can serve (`meta.analytics.maxSpanMs`), falling back to
 * {@link MAX_RANGE_MS}; `null` means no longest span (a job list's
 * `finishedOn` window, which the API does not bound).
 */
export function rangeProblem(
  from: number,
  to: number,
  maxSpan: number | null = MAX_RANGE_MS,
): string | null {
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return "Give both a start and an end.";
  }
  if (to <= from) {
    return "The end must be after the start.";
  }
  if (to - from < MIN_RANGE_MS) {
    return "That range is shorter than a second.";
  }
  if (maxSpan !== null && to - from > maxSpan) {
    return `That range is longer than ${describeSpan(maxSpan)}, which is as far back as this API keeps.`;
  }
  return null;
}

/**
 * A range written for the URL: `60s` / `3600s` for a preset, `<from>-<to>`
 * (epoch ms) for a custom one. `null` for the default, which is left out.
 */
export function writeRange(range: TimeRange): string | null {
  if (range.kind === "preset") {
    return range.seconds === DEFAULT_PRESET ? null : `${range.seconds}s`;
  }
  return `${range.from}-${range.to}`;
}

/** A range read back from the URL; anything malformed falls back to the default. */
export function readRange(raw: string | null): TimeRange {
  if (raw === null || raw === "") {
    return defaultRange();
  }
  const preset = /^(\d+)s$/.exec(raw);
  if (preset) {
    const seconds = Number(preset[1]);
    const known = RANGE_PRESETS.find((candidate) => candidate === seconds);
    return known === undefined
      ? defaultRange()
      : { kind: "preset", seconds: known };
  }
  const custom = /^(\d+)-(\d+)$/.exec(raw);
  if (custom) {
    const from = Number(custom[1]);
    const to = Number(custom[2]);
    return rangeProblem(from, to) === null
      ? { kind: "custom", from, to }
      : defaultRange();
  }
  return defaultRange();
}

/** How a range reads in a heading: the preset's label, or the two instants. */
export function describeRange(range: TimeRange): string {
  if (range.kind === "preset") {
    return PRESET_LABELS[range.seconds];
  }
  const format = (value: number) =>
    new Date(value).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  return `${format(range.from)} — ${format(range.to)}`;
}

/**
 * The bucket size a range is **asked** to be read at, in seconds: one second
 * for anything up to 15 minutes, otherwise one minute.
 *
 * It is a hint and an upper bound on fineness, never what a chart is labelled
 * with. The server answers with the resolution it served and says when it
 * coarsened one (`clamped`, with `reason: "retention"` when the range reaches
 * past what it keeps per second — the default is five minutes, so the
 * ten-minute preset lands there). Label an axis from the response.
 */
export function bucketSeconds(range: TimeRange, now = Date.now()): 1 | 60 {
  return rangeLength(range, now) <= 15 * 60 * 1_000 ? 1 : 60;
}
