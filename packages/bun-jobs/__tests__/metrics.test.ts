import type { JobCounters, PendingMetric } from "../lib/drivers/metrics";
import { describe, expect, it } from "bun:test";
import {
  DURATION_HISTOGRAM_BOUNDS,
  MAX_ANALYTICS_BUCKETS,
  MAX_SECOND_RETENTION_MS,
  MINUTE_BUCKET_MS,
  SECOND_BUCKET_MS,
} from "../lib/api/contract/constants";
import {
  addBusynessSample,
  addDuration,
  alignBucketRange,
  assertBucketCount,
  bucketCount,
  bucketStart,
  DURATION_HISTOGRAM_SIZE,
  durationBin,
  emptyDurationBucket,
  emptyDurationStats,
  emptyHistogram,
  fillBuckets,
  histogramQuantile,
  JOB_COUNTERS,
  mergeBusynessBuckets,
  mergeCounterBuckets,
  mergeDurationBuckets,
  mergeDurationStats,
  MetricsBuffer,
  MetricsPruneClock,
  metricsPruneCutoff,
  metricsSupportOf,
  readBusyness,
  readDurations,
  resolveAnalyticsRange,
  resolveMetricsOptions,
  RUNNER_RUN_COUNTERS,
  totalCounters,
  zeroCounters,
} from "../lib/drivers/metrics";
import { sumBuckets, throughputBucket } from "../lib/drivers/readApis";

/**
 * The bucket machinery every driver shares, tested on its own.
 *
 * Three of these are load-bearing rather than merely correct, and each was
 * proved by breaking it: the histogram's indexing (bin 0 is sub-millisecond, so
 * every bin is one above `floor(log2)`), the bucket cap being applied *before*
 * the empty buckets are filled in, and the dual write that puts one count in
 * both widths and in the namespace roll-up.
 */

/** Minute-resolution support, as a file-like driver reports it. */
const MINUTE_ONLY = metricsSupportOf(
  resolveMetricsOptions(undefined, { seconds: false }),
);

/** Second-and-minute support with the default five-minute retention. */
const WITH_SECONDS = metricsSupportOf(resolveMetricsOptions());

describe("bucket arithmetic", () => {
  it("floors to the start of the bucket, at either width", () => {
    const at = 1_700_000_123_456;

    expect(bucketStart(at, SECOND_BUCKET_MS)).toBe(1_700_000_123_000);
    expect(bucketStart(at, MINUTE_BUCKET_MS)).toBe(1_700_000_100_000);
    // A start is its own bucket, and the instant before it is the one before.
    expect(bucketStart(1_700_000_100_000, MINUTE_BUCKET_MS)).toBe(
      1_700_000_100_000,
    );
    expect(bucketStart(1_700_000_099_999, MINUTE_BUCKET_MS)).toBe(
      1_700_000_040_000,
    );
  });

  it("is the same flooring the shipped minute path uses", () => {
    for (const at of [0, 1, 59_999, 60_000, 1_700_000_123_456]) {
      expect(throughputBucket(at)).toBe(bucketStart(at, MINUTE_BUCKET_MS));
    }
  });

  it("aligns an exclusive end onto whole buckets", () => {
    // Exactly one minute is one bucket, not two: the end is exclusive.
    expect(alignBucketRange(60_000, 120_000, MINUTE_BUCKET_MS)).toEqual({
      from: 60_000,
      to: 60_000,
    });
    expect(alignBucketRange(60_000, 120_001, MINUTE_BUCKET_MS)).toEqual({
      from: 60_000,
      to: 120_000,
    });
    // An empty range still has the bucket its start falls in.
    expect(alignBucketRange(90_000, 90_000, MINUTE_BUCKET_MS)).toEqual({
      from: 60_000,
      to: 60_000,
    });
    expect(bucketCount({ from: 0, to: 4 * 60_000 }, MINUTE_BUCKET_MS)).toBe(5);
  });
});

describe("counter buckets", () => {
  it("merges several writers' rows into one bucket each", () => {
    const merged = mergeCounterBuckets(
      [
        { at: 60_000, completed: 2, failed: 0 },
        { at: 60_000, completed: 3, failed: 1 },
        { at: 0, completed: 1, failed: 0 },
      ],
      { from: 0, to: 60_000 },
      JOB_COUNTERS,
    );

    expect(merged).toEqual([
      { at: 0, completed: 1, failed: 0 },
      { at: 60_000, completed: 5, failed: 1 },
    ]);
  });

  it("drops rows outside the range, empty buckets, and reads strings as numbers", () => {
    const merged = mergeCounterBuckets(
      [
        { at: "60000", completed: "7", failed: "2" },
        { at: 0, completed: 0, failed: 0 },
        { at: 120_000, completed: 9, failed: 9 },
      ] as unknown as { at: number; completed: unknown; failed: unknown }[],
      { from: 0, to: 60_000 },
      JOB_COUNTERS,
    );

    expect(merged).toEqual([{ at: 60_000, completed: 7, failed: 2 }]);
  });

  it("answers a counter a row does not carry as zero", () => {
    expect(
      mergeCounterBuckets([{ at: 0, started: 2 }], { from: 0, to: 0 }, [
        "started",
        "failed",
      ]),
    ).toEqual([{ at: 0, started: 2, failed: 0 }]);
    expect(zeroCounters(RUNNER_RUN_COUNTERS).skipped).toBe(0);
  });

  it("totals the buckets over the range", () => {
    expect(
      totalCounters(
        [
          { completed: 1, failed: 2 },
          { completed: 4, failed: 0 },
        ],
        JOB_COUNTERS,
      ),
    ).toEqual({ completed: 5, failed: 2 });
  });

  it("is what the shipped sumBuckets now is", () => {
    const rows = [
      { at: 0, completed: 1, failed: 0 },
      { at: 0, completed: 1, failed: 1 },
      { at: 60_000, completed: 0, failed: 0 },
    ];

    expect(sumBuckets(rows, { from: 0, to: 60_000 })).toEqual(
      mergeCounterBuckets(rows, { from: 0, to: 60_000 }, JOB_COUNTERS),
    );
  });
});

describe("filling", () => {
  it("makes a sparse series contiguous", () => {
    const filled = fillBuckets(
      [{ at: 60_000, completed: 3, failed: 0 }],
      { from: 0, to: 120_000 },
      MINUTE_BUCKET_MS,
      (at) => ({ at, completed: 0, failed: 0 }),
    );

    expect(filled).toEqual([
      { at: 0, completed: 0, failed: 0 },
      { at: 60_000, completed: 3, failed: 0 },
      { at: 120_000, completed: 0, failed: 0 },
    ]);
  });

  it("refuses to fill more buckets than may be served", () => {
    const day = 24 * 60 * 60 * 1_000;

    expect(() =>
      fillBuckets(
        [],
        { from: 0, to: day - SECOND_BUCKET_MS },
        SECOND_BUCKET_MS,
        (at) => ({ at }),
      ),
    ).toThrow(/at most 1500 buckets/);
    expect(() => assertBucketCount(MAX_ANALYTICS_BUCKETS)).not.toThrow();
    expect(() => assertBucketCount(MAX_ANALYTICS_BUCKETS + 1)).toThrow();
  });
});

describe("the duration histogram", () => {
  it("indexes every edge, the sub-millisecond bin and the overflow", () => {
    expect(DURATION_HISTOGRAM_SIZE).toBe(DURATION_HISTOGRAM_BOUNDS.length + 1);

    // Bin 0 is [0, 1).
    expect(durationBin(0)).toBe(0);
    expect(durationBin(0.5)).toBe(0);
    expect(durationBin(0.999)).toBe(0);

    // Bin i is [bounds[i - 1], bounds[i]): the edge belongs to the bin it opens.
    DURATION_HISTOGRAM_BOUNDS.forEach((bound, index) => {
      expect(durationBin(bound)).toBe(index + 1);
      expect(durationBin(bound - 0.001)).toBe(index);
      if (index + 1 < DURATION_HISTOGRAM_BOUNDS.length) {
        expect(durationBin(bound + 0.5)).toBe(index + 1);
      }
    });

    // The last bin is the overflow, and nothing is above it.
    const last =
      DURATION_HISTOGRAM_BOUNDS[DURATION_HISTOGRAM_BOUNDS.length - 1]!;
    expect(durationBin(last)).toBe(DURATION_HISTOGRAM_SIZE - 1);
    expect(durationBin(last * 1_000)).toBe(DURATION_HISTOGRAM_SIZE - 1);
    expect(durationBin(Number.POSITIVE_INFINITY)).toBe(0);
    expect(durationBin(-5)).toBe(0);
  });

  it("counts a duration into exactly one bin", () => {
    const stats = emptyDurationStats();
    expect(stats.histogram).toHaveLength(DURATION_HISTOGRAM_SIZE);

    for (const ms of [0.5, 1, 3, 1_000]) {
      addDuration(stats, ms);
    }

    expect(stats.count).toBe(4);
    expect(stats.sumMs).toBe(1_004.5);
    expect(stats.minMs).toBe(0.5);
    expect(stats.maxMs).toBe(1_000);
    expect(stats.histogram[0]).toBe(1); // 0.5
    expect(stats.histogram[1]).toBe(1); // 1
    expect(stats.histogram[2]).toBe(1); // 3 → [2, 4)
    expect(stats.histogram[10]).toBe(1); // 1000 → [512, 1024)
    expect(stats.histogram.reduce((sum, count) => sum + count, 0)).toBe(4);
  });

  it("reads a median it can be held to, off a distribution whose own is known", () => {
    const stats = emptyDurationStats();
    for (let ms = 1; ms <= 100; ms++) {
      addDuration(stats, ms);
    }

    const read = readDurations(stats);
    const trueMedian = 50.5;

    expect(read.count).toBe(100);
    expect(read.minMs).toBe(1);
    expect(read.maxMs).toBe(100);
    // The mean is exact: a sum over a count, never a histogram read.
    expect(read.meanMs).toBe(50.5);
    // The median is interpolated inside a factor-of-two bin, so it is within a
    // factor of two of the truth — and in practice far closer.
    expect(read.p50Ms).toBeGreaterThan(trueMedian / 2);
    expect(read.p50Ms).toBeLessThan(trueMedian * 2);
    expect(Math.abs(read.p50Ms! - trueMedian) / trueMedian).toBeLessThan(0.3);
    expect(read.p95Ms).toBeGreaterThan(95 / 2);
    expect(read.p95Ms).toBeLessThanOrEqual(128);
  });

  it("interpolates inside the bin, and answers the overflow's lower edge", () => {
    const histogram = emptyHistogram();
    // Ten values in [2, 4): the median sits halfway across the bin.
    histogram[2] = 10;
    expect(histogramQuantile(histogram, 0.5)).toBe(3);
    expect(histogramQuantile(histogram, 0)).toBe(2);

    const overflow = emptyHistogram();
    overflow[DURATION_HISTOGRAM_SIZE - 1] = 4;
    expect(histogramQuantile(overflow, 0.5)).toBe(
      DURATION_HISTOGRAM_BOUNDS[DURATION_HISTOGRAM_BOUNDS.length - 1],
    );

    expect(histogramQuantile(emptyHistogram(), 0.5)).toBe(0);
  });

  it("merges writers' stats by addition, and their histograms element by element", () => {
    const a = emptyDurationStats();
    const b = emptyDurationStats();
    addDuration(a, 4);
    addDuration(b, 2);
    addDuration(b, 64);

    mergeDurationStats(a, b);

    expect(a.count).toBe(3);
    expect(a.sumMs).toBe(70);
    expect(a.minMs).toBe(2);
    expect(a.maxMs).toBe(64);
    expect(a.histogram[durationBin(2)]).toBe(1);
    expect(a.histogram[durationBin(4)]).toBe(1);
    expect(a.histogram[durationBin(64)]).toBe(1);

    // Merging nothing in changes nothing, which is what lets a reader merge an
    // empty bucket without special-casing it.
    mergeDurationStats(a, emptyDurationStats());
    expect(a.count).toBe(3);
    expect(a.minMs).toBe(2);
  });

  it("merges duration rows by bucket, dropping the empty and the out-of-range", () => {
    const rows = [
      { ...emptyDurationBucket(0), count: 1, sumMs: 5, minMs: 5, maxMs: 5 },
      { ...emptyDurationBucket(0), count: 1, sumMs: 15, minMs: 15, maxMs: 15 },
      emptyDurationBucket(60_000),
      {
        ...emptyDurationBucket(120_000),
        count: 1,
        sumMs: 1,
        minMs: 1,
        maxMs: 1,
      },
    ];

    const merged = mergeDurationBuckets(rows, { from: 0, to: 60_000 });

    expect(merged).toHaveLength(1);
    expect(merged[0]!.at).toBe(0);
    expect(merged[0]!.count).toBe(2);
    expect(readDurations(merged[0]!).meanMs).toBe(10);
    expect(readDurations(merged[0]!).minMs).toBe(5);
  });

  it("reports nothing about a bucket that counted nothing", () => {
    const read = readDurations(emptyDurationStats());
    expect(read).toEqual({ count: 0, minMs: 0, maxMs: 0, meanMs: 0 });
    expect(read.p50Ms).toBeUndefined();
    expect(read.histogram).toBeUndefined();
  });
});

describe("busyness", () => {
  it("keeps the later sample's concurrency when writers merge", () => {
    const merged = mergeBusynessBuckets(
      [
        {
          at: 0,
          samples: 2,
          activeSum: 6,
          activeMax: 4,
          concurrency: 8,
          lastAt: 5_000,
        },
        {
          at: 0,
          samples: 2,
          activeSum: 2,
          activeMax: 2,
          concurrency: 3,
          lastAt: 9_000,
        },
        {
          at: 60_000,
          samples: 0,
          activeSum: 0,
          activeMax: 0,
          concurrency: 0,
          lastAt: 0,
        },
      ],
      { from: 0, to: 60_000 },
    );

    expect(merged).toHaveLength(1);
    expect(readBusyness(merged[0]!)).toEqual({
      samples: 4,
      activeMean: 2,
      activeMax: 4,
      concurrency: 3,
    });
  });

  it("samples say nothing when there were none", () => {
    const stats = {
      samples: 0,
      activeSum: 0,
      activeMax: 0,
      concurrency: 0,
      lastAt: 0,
    };
    expect(readBusyness(stats).activeMean).toBe(0);

    addBusynessSample(stats, 1_000, { active: 3, concurrency: 5 });
    addBusynessSample(stats, 500, { active: 1, concurrency: 9 });

    // The earlier sample does not overwrite the later one's concurrency.
    expect(readBusyness(stats)).toEqual({
      samples: 2,
      activeMean: 2,
      activeMax: 3,
      concurrency: 5,
    });
  });
});

describe("recording options", () => {
  it("defaults to per-second at five minutes, and caps the retention", () => {
    const resolved = resolveMetricsOptions();

    expect(resolved.resolution).toBe("second");
    expect(resolved.secondRetentionMs).toBe(5 * 60_000);
    expect(resolved.intervals).toEqual([SECOND_BUCKET_MS, MINUTE_BUCKET_MS]);
    expect(resolved.workers).toBe(true);

    expect(
      resolveMetricsOptions({ secondRetentionMs: 60 * 60_000 })
        .secondRetentionMs,
    ).toBe(MAX_SECOND_RETENTION_MS);
  });

  it("a backend that cannot keep seconds is left with minutes, whatever it was asked", () => {
    const resolved = resolveMetricsOptions(
      { resolution: "second", secondRetentionMs: 60_000 },
      { seconds: false },
    );

    expect(resolved.resolution).toBe("minute");
    expect(resolved.secondRetentionMs).toBe(0);
    expect(resolved.intervals).toEqual([MINUTE_BUCKET_MS]);
    expect(MINUTE_ONLY.resolutions).toEqual([60]);
    expect(MINUTE_ONLY.retentionMs).toEqual({ 60: 24 * 60 * 60 * 1_000 });
  });

  it("prunes by range, once a minute", () => {
    const options = resolveMetricsOptions();
    const now = 10 * 60 * 60 * 1_000;

    expect(metricsPruneCutoff(options, SECOND_BUCKET_MS, now)).toBe(
      now - options.secondRetentionMs,
    );
    expect(metricsPruneCutoff(options, MINUTE_BUCKET_MS, now)).toBe(
      now - options.minuteRetentionMs,
    );

    const clock = new MetricsPruneClock();
    expect(clock.due(now)).toBe(true);
    expect(clock.due(now + 59_000)).toBe(false);
    expect(clock.due(now + 60_000)).toBe(true);
  });
});

describe("resolution selection", () => {
  /** A minute-aligned instant, so a bucket count is the span divided by the width. */
  const now = 10_000_020_000;

  it("serves the finest width kept for the whole span", () => {
    const range = resolveAnalyticsRange(
      { from: now - 60_000, to: now, now },
      WITH_SECONDS,
    );

    expect(range.resolution).toBe(1);
    expect(range.interval).toBe(1_000);
    expect(range.count).toBe(60);
    expect(range.clamped).toBe(false);
    expect(range.reason).toBeUndefined();
    expect(range.end).toBe(range.to + range.interval);
    expect(range.requested).toEqual({ from: now - 60_000, to: now });
  });

  it("coarsens at the retention boundary rather than mixing widths", () => {
    const retention = WITH_SECONDS.retentionMs["1"]!;

    // Wholly inside the per-second window: seconds.
    expect(
      resolveAnalyticsRange(
        { from: now - retention, to: now, now },
        WITH_SECONDS,
      ).resolution,
    ).toBe(1);

    // One millisecond past it: the whole response is minutes, and says why.
    const straddling = resolveAnalyticsRange(
      { from: now - retention - 1, to: now, now },
      WITH_SECONDS,
    );
    expect(straddling.resolution).toBe(60);
    expect(straddling.clamped).toBe(true);
    expect(straddling.reason).toBe("retention");
  });

  it("caps the buckets before anything is filled in", () => {
    const day = 24 * 60 * 60 * 1_000;
    const range = resolveAnalyticsRange(
      { from: now - day, to: now, resolution: 1, now },
      { ...WITH_SECONDS, retentionMs: { 1: day, 60: day } },
    );

    // A day at one second would be 86,400 buckets. The cap is what stops the
    // series being allocated at all, so the resolution moves, not the fill.
    expect(range.resolution).toBe(60);
    expect(range.count).toBe(1_440);
    expect(range.count).toBeLessThanOrEqual(MAX_ANALYTICS_BUCKETS);
    expect(range.reason).toBe("maxBuckets");
    expect(() =>
      fillBuckets([], range, range.interval, (at) => ({ at })),
    ).not.toThrow();
  });

  it("clamps the range forward when it reaches past retention", () => {
    const range = resolveAnalyticsRange(
      { from: now - 48 * 60 * 60 * 1_000, to: now, now },
      WITH_SECONDS,
    );

    expect(range.resolution).toBe(60);
    expect(range.clamped).toBe(true);
    expect(range.reason).toBe("retention");
    expect(range.from).toBeGreaterThanOrEqual(range.retainedFrom - 60_000);
    expect(range.outOfRetention).toBe(false);
    expect(range.requested.from).toBe(now - 48 * 60 * 60 * 1_000);
  });

  it("says when the whole range is older than anything kept", () => {
    const range = resolveAnalyticsRange(
      {
        from: now - 72 * 60 * 60 * 1_000,
        to: now - 48 * 60 * 60 * 1_000,
        now,
      },
      WITH_SECONDS,
    );

    expect(range.outOfRetention).toBe(true);
  });

  it("blames the driver for a width it never records", () => {
    const range = resolveAnalyticsRange(
      { from: now - 60_000, to: now, resolution: 1, now },
      MINUTE_ONLY,
    );

    expect(range.resolution).toBe(60);
    expect(range.clamped).toBe(true);
    expect(range.reason).toBe("driver");
    expect(range.requested.resolution).toBe(1);
  });

  it("blames the kind for a width it cannot be observed at", () => {
    const range = resolveAnalyticsRange(
      {
        from: now - 60_000,
        to: now,
        resolution: 1,
        now,
        minIntervalMs: 10_000,
      },
      WITH_SECONDS,
    );

    expect(range.resolution).toBe(60);
    expect(range.reason).toBe("resolution");
  });

  it("never serves finer than it was asked for", () => {
    const range = resolveAnalyticsRange(
      { from: now - 60_000, to: now, resolution: 60, now },
      WITH_SECONDS,
    );

    expect(range.resolution).toBe(60);
    // Asking for what you get is not a clamp.
    expect(range.clamped).toBe(false);
  });
});

describe("MetricsBuffer", () => {
  /** A buffer whose writes are collected, never flushed by the timer. */
  function collecting(options?: {
    intervals?: readonly number[];
    rollUp?: boolean;
    unwritten?: (
      batch: PendingMetric<JobCounters>[],
    ) => PendingMetric<JobCounters>[];
  }) {
    const batches: PendingMetric<JobCounters>[][] = [];
    const buffer = new MetricsBuffer<JobCounters>({
      write: async (batch) => {
        batches.push(batch);
        return { unwritten: options?.unwritten?.(batch) ?? [] };
      },
      keys: JOB_COUNTERS,
      ...(options?.intervals === undefined
        ? {}
        : { intervals: options.intervals }),
      ...(options?.rollUp === undefined ? {} : { rollUp: options.rollUp }),
      flushMs: 60_000,
    });

    return { batches, buffer };
  }

  it("writes both widths and the namespace roll-up from one count", async () => {
    const { batches, buffer } = collecting();

    buffer.count("ns", "queue-a", 61_500, { completed: 1 });
    await buffer.flush();
    await buffer.close();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([
      {
        ns: "ns",
        entity: "queue-a",
        at: 61_000,
        interval: 1_000,
        counts: { completed: 1, failed: 0 },
      },
      {
        ns: "ns",
        entity: "",
        at: 61_000,
        interval: 1_000,
        counts: { completed: 1, failed: 0 },
      },
      {
        ns: "ns",
        entity: "queue-a",
        at: 60_000,
        interval: 60_000,
        counts: { completed: 1, failed: 0 },
      },
      {
        ns: "ns",
        entity: "",
        at: 60_000,
        interval: 60_000,
        counts: { completed: 1, failed: 0 },
      },
    ]);
  });

  it("keeps one shared row per entity and bucket, however many counts land in it", async () => {
    const { batches, buffer } = collecting({ intervals: [1_000] });

    for (let index = 0; index < 500; index++) {
      buffer.count("ns", "queue-a", 61_000 + index, { completed: 1 });
    }
    buffer.count("ns", "queue-b", 61_000, { failed: 2 });
    await buffer.flush();
    await buffer.close();

    // 500 jobs in one second are one row for the queue and one for the
    // namespace — not 500, and not one per shard.
    expect(batches[0]).toHaveLength(3);
    expect(batches[0]![0]).toEqual({
      ns: "ns",
      entity: "queue-a",
      at: 61_000,
      interval: 1_000,
      counts: { completed: 500, failed: 0 },
    });
    expect(batches[0]![1]!.counts).toEqual({ completed: 500, failed: 2 });
    expect(batches[0]![1]!.entity).toBe("");
  });

  it("counts nothing for a delta of nothing", async () => {
    const { batches, buffer } = collecting();

    buffer.count("ns", "queue-a", 1_000, {});
    buffer.count("ns", "queue-a", 1_000, { completed: 0, failed: 0 });
    expect(buffer.size).toBe(0);
    await buffer.flush();
    await buffer.close();

    expect(batches).toHaveLength(0);
  });

  it("can leave the roll-up to a backend that must write it another way", async () => {
    const { batches, buffer } = collecting({
      intervals: [60_000],
      rollUp: false,
    });

    buffer.count("ns", "queue-a", 0, { completed: 1 });
    await buffer.flush();
    await buffer.close();

    expect(batches[0]).toHaveLength(1);
    expect(batches[0]![0]!.entity).toBe("queue-a");
  });

  it("puts back only the rows a write did not land, and forgets a purged namespace", async () => {
    const { batches, buffer } = collecting({
      intervals: [60_000],
      unwritten: (batch) =>
        batches.length === 1 ? batch.filter((row) => row.ns === "b") : [],
    });

    buffer.count("a", "q", 0, { completed: 1 });
    buffer.count("b", "q", 0, { completed: 1 });
    await buffer.flush();
    await buffer.flush();

    expect(batches[0]!.map((row) => row.ns)).toEqual(["a", "a", "b", "b"]);
    expect(batches[1]!.map((row) => row.ns)).toEqual(["b", "b"]);

    buffer.count("b", "q", 0, { completed: 1 });
    buffer.forget("b");
    expect(buffer.size).toBe(0);
    await buffer.close();
    expect(batches).toHaveLength(2);
  });
});
