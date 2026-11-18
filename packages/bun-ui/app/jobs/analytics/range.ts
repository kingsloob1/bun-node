import type { AnalyticsPreset } from "../api/contract";
import type {
  CustomRange as KitCustomRange,
  PresetRange as KitPresetRange,
  RangeModel,
  TimeRange as KitTimeRange,
} from "../../kit/range";
import { createRangeModel, rangeBounds, rangeLength } from "../../kit/range";
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
export type PresetRange = KitPresetRange<RangePreset>;

/** A fixed span between two instants. */
export type CustomRange = KitCustomRange;

/** What an analytics view is read over. */
export type TimeRange = KitTimeRange<RangePreset>;

/**
 * The longest span a view asks for, from the contract. A deployment reports
 * its own in `meta.analytics.maxSpanMs`, which a picker passes as `maxSpan`;
 * this is the fallback for an API that reports none.
 */
export const MAX_RANGE_MS = MAX_ANALYTICS_SPAN_MS;

/** The shortest custom span that still holds a bucket, from the contract. */
export const MIN_RANGE_MS = MIN_ANALYTICS_SPAN_MS;

/** The jobs UI's range model: the kit's, bound to the contract's presets (PR-U2). */
export const RANGE_MODEL: RangeModel<RangePreset> = createRangeModel({
  presets: RANGE_PRESETS,
  defaultPreset: DEFAULT_PRESET,
  labels: PRESET_LABELS,
  maxSpanMs: MAX_RANGE_MS,
  minSpanMs: MIN_RANGE_MS,
});

/** The default range: {@link DEFAULT_PRESET}, rolling. */
export const defaultRange = RANGE_MODEL.defaultRange;

export { rangeBounds, rangeLength };

/**
 * Why a custom range is not usable, or `null` when it is. `maxSpan` is what
 * the API says it can serve (`meta.analytics.maxSpanMs`), falling back to
 * {@link MAX_RANGE_MS}; `null` means no longest span (a job list's
 * `finishedOn` window, which the API does not bound).
 */
export const rangeProblem = RANGE_MODEL.rangeProblem;

/**
 * A range written for the URL: `60s` / `3600s` for a preset, `<from>-<to>`
 * (epoch ms) for a custom one. `null` for the default, which is left out.
 */
export const writeRange = RANGE_MODEL.writeRange;

/** A range read back from the URL; anything malformed falls back to the default. */
export const readRange = RANGE_MODEL.readRange;

/** How a range reads in a heading: the preset's label, or the two instants. */
export const describeRange = RANGE_MODEL.describeRange;

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
