import type { DurationStats } from "../lib/drivers/metrics";
import { describe, expect, it } from "bun:test";
import {
  durationBin,
  emptyBusynessStats,
  emptyDurationStats,
  emptyHistogram,
  hasMetricBuckets,
  NAMESPACE_ENTITY,
  RUNNER_RUN_COUNTERS,
  runnerTotalsOf,
  splitWorkerMetricsEntity,
  totalBusynessStats,
  totalDurationStats,
  uniqueWorkerRefs,
  workerMetricsEntity,
  workerTotalsOf,
  zeroCounters,
} from "../lib/drivers/metrics";

/**
 * The shared helpers behind the grouped analytics reads
 * (`getRunnerMetricsTotals`, `getWorkerMetricsTotals`, and the `…Many`
 * batches). The cross-driver behaviour is in `helpers/driverContract.ts`; this
 * is the arithmetic and the naming, directly.
 */
describe("grouped metrics helpers", () => {
  it("encodes a worker entity as queue:key and splits it back on the first colon", () => {
    expect(workerMetricsEntity("orders", "w-1")).toBe("orders:w-1");
    expect(splitWorkerMetricsEntity("orders:w-1")).toEqual({
      queue: "orders",
      key: "w-1",
    });
    // A key may hold colons; a queue name may not, so the first one splits.
    expect(
      splitWorkerMetricsEntity(workerMetricsEntity("orders", "host:7:a")),
    ).toEqual({ queue: "orders", key: "host:7:a" });
  });

  it("never splits the namespace roll-up, or anything else that is not a worker, into one", () => {
    expect(splitWorkerMetricsEntity(NAMESPACE_ENTITY)).toBeUndefined();
    expect(splitWorkerMetricsEntity("no-colon")).toBeUndefined();
    expect(splitWorkerMetricsEntity(":empty-queue")).toBeUndefined();
  });

  it("drops repeated worker refs, keeping the first", () => {
    expect(
      uniqueWorkerRefs([
        { queue: "orders", key: "a" },
        { queue: "mail", key: "a" },
        { queue: "orders", key: "a" },
      ]),
    ).toEqual([
      { queue: "orders", key: "a" },
      { queue: "mail", key: "a" },
    ]);
  });

  it("totals durations across rows — counts and sums add, extremes are extremes, bins add", () => {
    const a: DurationStats = {
      count: 2,
      sumMs: 905,
      minMs: 5,
      maxMs: 900,
      histogram: emptyHistogram(),
    };
    a.histogram[durationBin(5)]!++;
    a.histogram[durationBin(900)]!++;
    const b: DurationStats = {
      count: 1,
      sumMs: 3,
      minMs: 3,
      maxMs: 3,
      histogram: emptyHistogram(),
    };
    b.histogram[durationBin(3)]!++;

    const expected = emptyHistogram();
    for (const ms of [5, 900, 3]) {
      expected[durationBin(ms)]!++;
    }
    expect(totalDurationStats([a, b, emptyDurationStats()])).toEqual({
      count: 3,
      sumMs: 908,
      minMs: 3,
      maxMs: 900,
      histogram: expected,
    });
    expect(totalDurationStats([])).toEqual(emptyDurationStats());
  });

  it("totals busyness across rows, keeping the latest sample's concurrency", () => {
    expect(
      totalBusynessStats([
        { samples: 1, activeSum: 3, activeMax: 3, concurrency: 8, lastAt: 20 },
        { samples: 2, activeSum: 2, activeMax: 1, concurrency: 4, lastAt: 10 },
      ]),
    ).toEqual({
      samples: 3,
      activeSum: 5,
      activeMax: 3,
      concurrency: 8,
      lastAt: 20,
    });
    expect(totalBusynessStats([])).toEqual(emptyBusynessStats());
  });

  it("reduces a runner's read to totals, and to nothing when it has nothing to report", () => {
    expect(
      runnerTotalsOf({
        runs: [
          { ...zeroCounters(RUNNER_RUN_COUNTERS), started: 2 },
          { ...zeroCounters(RUNNER_RUN_COUNTERS), started: 1, failed: 1 },
        ],
      }),
    ).toEqual({
      runs: { ...zeroCounters(RUNNER_RUN_COUNTERS), started: 3, failed: 1 },
    });

    // Nothing counted, nothing timed: absent, not a row of zeros.
    expect(runnerTotalsOf({ runs: [] })).toBeUndefined();
    expect(runnerTotalsOf({ runs: [], durations: [] })).toBeUndefined();

    // Durations read: present on the row, even when empty.
    expect(
      runnerTotalsOf({
        runs: [{ ...zeroCounters(RUNNER_RUN_COUNTERS), started: 1 }],
        durations: [],
      })?.durations,
    ).toEqual(emptyDurationStats());
  });

  it("reduces a worker's read to totals; busyness alone is something to report", () => {
    expect(workerTotalsOf({ jobs: [] })).toBeUndefined();
    expect(workerTotalsOf({ jobs: [], busyness: [] })).toBeUndefined();

    const idle = workerTotalsOf({
      jobs: [],
      busyness: [
        { samples: 1, activeSum: 0, activeMax: 0, concurrency: 4, lastAt: 1 },
      ],
    });
    expect(idle).toEqual({
      jobs: { completed: 0, failed: 0 },
      busyness: {
        samples: 1,
        activeSum: 0,
        activeMax: 0,
        concurrency: 4,
        lastAt: 1,
      },
    });
  });

  it("says whether a batch entry has any bucket in it", () => {
    expect(hasMetricBuckets([], undefined)).toBe(false);
    expect(hasMetricBuckets([], [])).toBe(false);
    expect(hasMetricBuckets([], [{ at: 0 }])).toBe(true);
    expect(hasMetricBuckets([{ at: 0 }])).toBe(true);
  });
});
