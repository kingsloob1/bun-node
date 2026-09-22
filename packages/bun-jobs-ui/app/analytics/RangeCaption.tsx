import type { AnalyticsRangeDto } from "../api/types";
import { describeResolution } from "../api/analytics";
import "./analytics.css";

/**
 * What one section is actually showing, taken from the response's own
 * `range` — never from what the request asked for.
 *
 * It is how a user learns that the 10-minute preset came back at minute
 * buckets: the server serves the finest resolution it can keep for the whole
 * span, says so in `resolution`, and explains the difference with `clamped`
 * and `reason`. Without a caption a chart is quietly labelled with a range it
 * does not cover.
 */

/** How each `AnalyticsClampReason` reads, with the resolution served filled in. */
const REASONS: Readonly<Record<string, (range: AnalyticsRangeDto) => string>> =
  {
    retention: (range) =>
      `this API does not keep that far back at the resolution asked for, so it answered with ${describeResolution(range)}.`,
    maxBuckets: (range) =>
      `that span at the resolution asked for is more points than one response carries, so it answered with ${describeResolution(range)}.`,
    resolution: (range) =>
      `this API does not serve the resolution asked for, so it answered with ${describeResolution(range)}.`,
    driver: (range) =>
      `this backend cannot record that fineness at all, so it answered with ${describeResolution(range)}.`,
  };

/** Props of {@link RangeCaption}. */
export interface RangeCaptionProps {
  /**
   * The range the response reports. `undefined` while the read is in flight
   * or failed, which renders nothing.
   */
  range: AnalyticsRangeDto | undefined;
  /**
   * Also caption an unclamped response, saying which buckets it is drawn at.
   * Defaults to `false`: a response that covers exactly what was asked for
   * needs no explanation.
   */
  always?: boolean;
  /** Test id on the caption. Defaults to `range-caption`. */
  testId?: string;
}

/** Says what a section is showing when that is not what was asked for. */
export function RangeCaption({
  range,
  always = false,
  testId = "range-caption",
}: RangeCaptionProps) {
  if (!range) {
    return null;
  }
  if (!range.clamped) {
    return always ? (
      <p
        className="range-caption"
        data-testid={testId}
      >
        Shown in {describeResolution(range)}.
      </p>
    ) : null;
  }
  const explain = range.reason ? REASONS[range.reason] : undefined;
  return (
    <p
      className="range-caption"
      data-testid={testId}
      data-clamp-reason={range.reason ?? "unknown"}
    >
      This is not exactly the range asked for:{" "}
      {explain
        ? explain(range)
        : `it was answered with ${describeResolution(range)}.`}
    </p>
  );
}
