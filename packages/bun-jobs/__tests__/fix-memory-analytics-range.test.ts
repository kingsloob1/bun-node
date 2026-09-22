import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SECOND_RETENTION_MS,
  MINUTE_RETENTION_MS,
} from "../lib/api/contract/constants";
import {
  metricsSupportOf,
  resolveAnalyticsRange,
  resolveMetricsOptions,
} from "../lib/drivers/metrics";

/**
 * B13: "the last 24 hours" was reported as clamped for retention every time.
 * The client computes `from = its now − 24 h` a few ms before the server's
 * `now − 24 h`, and the check compared instants — although the first bucket
 * served was the very bucket asked for. The checks now compare buckets.
 */

/** Second-and-minute support with the default retentions (5 min, 24 h). */
const SUPPORT = metricsSupportOf(resolveMetricsOptions());

/** A server `now` in the middle of a minute and of a second. */
const NOW = 1_789_978_443_768 - (1_789_978_443_768 % 60_000) + 30_500;

describe("resolveAnalyticsRange clamps by bucket, not by instant (B13)", () => {
  it("does not clamp exactly a day ending now, asked a few ms early, at 60 s", () => {
    const from = NOW - MINUTE_RETENTION_MS - 4;
    const range = resolveAnalyticsRange(
      { from, to: NOW, resolution: 60, now: NOW },
      SUPPORT,
    );

    expect(range.resolution).toBe(60);
    expect(range.clamped).toBe(false);
    expect(range.reason).toBeUndefined();
    // The first bucket served is the one `from` falls in, and the echo is raw.
    expect(range.from).toBe(from - (from % 60_000));
    expect(range.requested.from).toBe(from);
  });

  it("clamps a day plus one whole bucket for retention, at 60 s", () => {
    const from = NOW - MINUTE_RETENTION_MS - 60_000;
    const range = resolveAnalyticsRange(
      { from, to: NOW, resolution: 60, now: NOW },
      SUPPORT,
    );

    expect(range.clamped).toBe(true);
    expect(range.reason).toBe("retention");
    expect(range.from).toBeGreaterThan(from);
  });

  it("serves exactly the second tier's retention at 1 s when asked a few ms early", () => {
    const from = NOW - DEFAULT_SECOND_RETENTION_MS - 4;
    const range = resolveAnalyticsRange(
      { from, to: NOW, resolution: 1, now: NOW },
      SUPPORT,
    );

    expect(range.resolution).toBe(1);
    expect(range.clamped).toBe(false);
    expect(range.reason).toBeUndefined();
    expect(range.requested.from).toBe(from);
  });

  it("moves to minutes, for retention, one whole second past the 1 s tier", () => {
    const from = NOW - DEFAULT_SECOND_RETENTION_MS - 1_000;
    const range = resolveAnalyticsRange(
      { from, to: NOW, resolution: 1, now: NOW },
      SUPPORT,
    );

    expect(range.resolution).toBe(60);
    expect(range.clamped).toBe(true);
    expect(range.reason).toBe("retention");
  });
});
