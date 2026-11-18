/**
 * The analytics page's range (ui.md §7, PR-U2): the kit's range model bound
 * to the page's presets, from 15 minutes to 30 days, plus a custom span of
 * at most 400 days (CP5's longest read). The tier a read asks for follows
 * the range as the server's default does (README §8.3): a minute tier up to
 * 6 hours, an hour tier up to 14 days, a day tier beyond.
 */
import type { TimeRange } from "../../kit/range";
import { ANALYTICS_READ_LIMITS } from "@kingsleyweb/bun-security/control/contract";
import { createRangeModel, rangeLength } from "../../kit/range";

/** The presets, in seconds. */
export const ANALYTICS_PRESETS = [
  900, 3_600, 21_600, 86_400, 604_800, 2_592_000,
] as const;

/** A preset. */
export type AnalyticsPreset = (typeof ANALYTICS_PRESETS)[number];

/** The analytics page's range model. */
export const ANALYTICS_RANGE = createRangeModel<AnalyticsPreset>({
  presets: ANALYTICS_PRESETS,
  defaultPreset: 86_400,
  labels: {
    900: "Last 15 minutes",
    3_600: "Last hour",
    21_600: "Last 6 hours",
    86_400: "Last 24 hours",
    604_800: "Last 7 days",
    2_592_000: "Last 30 days",
  },
  maxSpanMs: ANALYTICS_READ_LIMITS.rangeMs,
  minSpanMs: 60_000,
});

/** The page's range. */
export type AnalyticsRange = TimeRange<AnalyticsPreset>;

/** A counter tier. */
export type Tier = "minute" | "hour" | "day";

/** The tier a range reads at. */
export function tierOf(range: AnalyticsRange, now = Date.now()): Tier {
  const span = rangeLength(range, now);
  return span <= 6 * 3_600_000
    ? "minute"
    : span <= 14 * 86_400_000
      ? "hour"
      : "day";
}

/** A tier's bucket, ms. */
export const TIER_MS: Readonly<Record<Tier, number>> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/** Whether a range ends now (a preset): then it refreshes live. */
export function endsNow(range: AnalyticsRange): boolean {
  return range.kind === "preset";
}
