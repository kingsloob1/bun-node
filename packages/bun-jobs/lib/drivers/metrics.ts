import type { AnalyticsResolution } from "../api/contract/constants";
import type { AnalyticsClampReason } from "../api/contract/types";
import {
  ANALYTICS_RESOLUTIONS,
  DEFAULT_SECOND_RETENTION_MS,
  DURATION_HISTOGRAM_BOUNDS,
  MAX_ANALYTICS_BUCKETS,
  MAX_SECOND_RETENTION_MS,
  MINUTE_BUCKET_MS,
  MINUTE_RETENTION_MS,
  SECOND_BUCKET_MS,
} from "../api/contract/constants";

/**
 * The parts of metric bucketing every driver agrees on, in one place.
 *
 * Five backends count jobs, runs, durations and busyness five different ways —
 * a Map, a JSONL file, rows, a Redis hash, documents — but every one of them
 * must floor a timestamp to the same bucket, merge two writers' rows to the
 * same numbers, put a duration in the same histogram bin and serve a range at
 * the same resolution, because one cross-driver suite asserts all of it. So the
 * arithmetic lives here rather than five times, the way `runLogs.ts` holds the
 * run-log semantics.
 *
 * Nothing here talks to a backend. The contract's own shapes are in
 * `driver.ts`, which imports this module; this module imports only the API
 * contract's constants, which import nothing at all.
 *
 * Three rules from the design are load-bearing and easy to undo by accident:
 *
 * - **A per-second count never rides inside a per-job statement.** Counts are
 *   gathered by {@link MetricsBuffer} and written once a second onto a *single
 *   shared row* per `(ns, entity, second)` — no shard fan-out, because at one
 *   write per entity per second the row contention that the shards exist for
 *   does not happen. It is the difference between 58 K rows and 1.25 M in a
 *   mid-sized namespace.
 * - **Second and minute are a dual write**, not a roll-up job: the same count
 *   bumps both buckets, and every per-entity count also bumps a namespace
 *   roll-up, so an overview costs three reads whatever the fleet size.
 * - **The bucket cap is applied before the empty buckets are filled in.** A day
 *   at one second is 86,400 objects; the cap is what stops a range ever
 *   allocating them.
 */

/* ------------------------------------------------------------------ *
 * Bucket arithmetic
 * ------------------------------------------------------------------ */

/** The default span an analytics range covers when the request names none: an hour. */
export const DEFAULT_ANALYTICS_SPAN_MS = 60 * 60 * 1_000;

/** The widths a count is written at when per-second recording is on, finest first. */
export const SECOND_INTERVALS: readonly number[] = [
  SECOND_BUCKET_MS,
  MINUTE_BUCKET_MS,
];

/** The widths a count is written at when only minutes are recorded. */
export const MINUTE_INTERVALS: readonly number[] = [MINUTE_BUCKET_MS];

/**
 * A span of whole buckets: `from` is the **first** bucket's start and `to` the
 * **last** bucket's start, both inclusive and both multiples of the width.
 *
 * Deliberately not the request's range, where `to` is exclusive: a driver is
 * given bucket starts, which is the convention `getThroughput` has shipped
 * with. {@link resolveAnalyticsRange} is the one place the two meet.
 */
export interface BucketRange {
  /** The first bucket's start, epoch ms. */
  from: number;
  /** The last bucket's start, epoch ms, inclusive. */
  to: number;
}

/** The start of the bucket of width `interval` that `at` falls in. */
export function bucketStart(at: number, interval: number): number {
  return Math.floor(at / interval) * interval;
}

/** How many buckets of width `interval` a {@link BucketRange} holds. */
export function bucketCount(range: BucketRange, interval: number): number {
  return Math.floor((range.to - range.from) / interval) + 1;
}

/**
 * The whole buckets covering `[from, toExclusive)` at `interval`.
 *
 * `toExclusive` is the request's `to`: an instant exactly on a bucket boundary
 * belongs to the bucket *before* it, so a range of exactly one minute is one
 * bucket rather than two. A range that ends where it starts still has the one
 * bucket its start falls in — a series with no buckets could not be plotted.
 */
export function alignBucketRange(
  from: number,
  toExclusive: number,
  interval: number,
): BucketRange {
  const first = bucketStart(from, interval);
  const last = bucketStart(Math.max(toExclusive - 1, from), interval);
  return { from: first, to: Math.max(first, last) };
}

/**
 * Throws when a range would hold more buckets than may be served.
 *
 * The guard exists because the order matters: a cap checked *after* the empty
 * buckets are filled in has already allocated an object per second of the
 * range. Every filler here calls it first.
 */
export function assertBucketCount(
  count: number,
  max: number = MAX_ANALYTICS_BUCKETS,
): void {
  if (count > max) {
    throw new RangeError(
      `a series may hold at most ${max} buckets, not ${count}: pick the resolution with resolveAnalyticsRange() before filling`,
    );
  }
}

/**
 * Buckets made contiguous: one entry per interval from `range.from` to
 * `range.to`, oldest first, with `empty(at)` wherever the backend stored
 * nothing.
 *
 * Charts need contiguous buckets — a gap is a different shape from a zero — and
 * the sparse form is what every driver returns, because storing empty buckets
 * would be storing nothing at all. An entry the range does not cover is
 * dropped; two entries at the same start would be a merge's job, and the last
 * one wins here.
 */
export function fillBuckets<T extends { at: number }>(
  /** What the backend had, in any order. */
  sparse: Iterable<T>,
  /** The buckets to produce. */
  range: BucketRange,
  /** Their width, ms. */
  interval: number,
  /** Makes the bucket for an interval nothing was stored for. */
  empty: (at: number) => T,
): T[] {
  const count = bucketCount(range, interval);
  assertBucketCount(count);

  const stored = new Map<number, T>();
  for (const entry of sparse) {
    stored.set(entry.at, entry);
  }

  const buckets: T[] = [];
  for (let at = range.from; at <= range.to; at += interval) {
    buckets.push(stored.get(at) ?? empty(at));
  }

  return buckets;
}

/* ------------------------------------------------------------------ *
 * Counters
 * ------------------------------------------------------------------ */

/**
 * A set of counters: one number per name.
 *
 * The generics below are constrained as `C extends Record<keyof C, number>`
 * rather than by this alias, so that an *interface* satisfies them: an
 * interface has no implicit index signature, and a plain
 * `Record<string, number>` constraint would reject every named counter set in
 * the contract.
 */
export type CounterSet = Record<string, number>;

/** One bucket of counters: when it starts, and what was counted in it. */
export type CounterBucket<C extends Record<keyof C, number>> = {
  at: number;
} & C;

/** What a queue, a worker or a namespace counted about jobs. */
export interface JobCounters {
  /** Jobs completed. */
  completed: number;
  /** Attempts failed — every attempt, retried or not, plus each job a sweep buried. */
  failed: number;
}

/** What a runner counted about its runs, by how they ended. */
export interface RunnerRunCounters {
  /** Runs started. */
  started: number;
  /** Runs that finished successfully. */
  succeeded: number;
  /** Runs that finished by throwing. */
  failed: number;
  /** Runs that finished by exceeding their timeout. */
  timeout: number;
  /** Runs that finished because they were killed. */
  killed: number;
  /** Runs skipped — an overlap the run mode refused. */
  skipped: number;
}

/** {@link JobCounters}' names, in the order counts are reported. */
export const JOB_COUNTERS = [
  "completed",
  "failed",
] as const satisfies readonly (keyof JobCounters)[];

/** {@link RunnerRunCounters}' names, in the order counts are reported. */
export const RUNNER_RUN_COUNTERS = [
  "started",
  "succeeded",
  "failed",
  "timeout",
  "killed",
  "skipped",
] as const satisfies readonly (keyof RunnerRunCounters)[];

/** A zero for every named counter. */
export function zeroCounters<K extends string>(
  keys: readonly K[],
): Record<K, number> {
  const counts = {} as Record<K, number>;
  for (const key of keys) {
    counts[key] = 0;
  }
  return counts;
}

/**
 * Rows summed into one bucket per start, oldest first, dropping any outside
 * `range` and any with nothing in them.
 *
 * For a backend that stores one bucket in more than one row — one per process,
 * or one per shard, so writers never contend on a row. Values are read through
 * `Number` because a SQL driver hands back strings for a `BIGINT`, and a
 * missing counter reads as zero rather than as a hole.
 *
 * Empty buckets are dropped here and filled back in by {@link fillBuckets},
 * once the resolution is settled: at one second, keeping them would allocate an
 * object per second of the range before anything had capped it.
 */
export function mergeCounterBuckets<K extends string>(
  /** The stored rows, in any order. */
  rows: Iterable<{ at: number } & Partial<Record<K, unknown>>>,
  /** The buckets wanted; anything outside is dropped. */
  range: BucketRange,
  /** The counters to sum. */
  keys: readonly K[],
): CounterBucket<Record<K, number>>[] {
  const byBucket = new Map<number, Record<K, number>>();

  for (const row of rows) {
    const at = Number(row.at);
    if (at < range.from || at > range.to) {
      continue;
    }

    let counts = byBucket.get(at);
    if (!counts) {
      counts = zeroCounters(keys);
      byBucket.set(at, counts);
    }

    for (const key of keys) {
      counts[key] += Number(row[key]) || 0;
    }
  }

  return [...byBucket]
    .filter(([, counts]) => keys.some((key) => counts[key] > 0))
    .sort(([a], [b]) => a - b)
    .map(([at, counts]) => ({ at, ...counts }));
}

/** Buckets summed over a whole range: one total per counter. */
export function totalCounters<K extends string>(
  /** The buckets to add up. */
  buckets: Iterable<Partial<Record<K, number>>>,
  /** The counters to total. */
  keys: readonly K[],
): Record<K, number> {
  const totals = zeroCounters(keys);
  for (const bucket of buckets) {
    for (const key of keys) {
      totals[key] += bucket[key] ?? 0;
    }
  }
  return totals;
}

/* ------------------------------------------------------------------ *
 * Durations
 * ------------------------------------------------------------------ */

/**
 * How many counts a duration histogram holds: one more than
 * `DURATION_HISTOGRAM_BOUNDS` has edges, the extra one being the overflow.
 */
export const DURATION_HISTOGRAM_SIZE = DURATION_HISTOGRAM_BOUNDS.length + 1;

/**
 * Which bin of the fixed log histogram a duration falls in.
 *
 * Bin `0` is `[0, 1)` ms, bin `i` is `[bounds[i - 1], bounds[i])` — so bin 1 is
 * `[1, 2)`, bin 2 is `[2, 4)` — and the last bin,
 * `DURATION_HISTOGRAM_SIZE - 1`, is the overflow, everything at or above the
 * final edge (`2**23` ms, about 2.3 hours). A duration exactly on an edge
 * belongs to the bin the edge *starts*.
 *
 * `Math.clz32` on the floored value rather than `Math.log2`: the bins are
 * powers of two, and a float logarithm rounding up at an edge would put a
 * duration in the wrong bin at exactly the values a test checks. Anything not a
 * finite number, and anything negative, counts as `0`.
 */
export function durationBin(ms: number): number {
  const last = DURATION_HISTOGRAM_SIZE - 1;

  if (!Number.isFinite(ms) || ms < 1) {
    return 0;
  }
  if (ms >= DURATION_HISTOGRAM_BOUNDS[DURATION_HISTOGRAM_BOUNDS.length - 1]!) {
    return last;
  }

  // 31 - clz32(v) is floor(log2(v)) exactly, and bin = that + 1 because bin 0
  // is the sub-millisecond one below the first edge.
  return 31 - Math.clz32(Math.floor(ms)) + 1;
}

/** A histogram with nothing counted in it. */
export function emptyHistogram(): number[] {
  return Array.from<number>({ length: DURATION_HISTOGRAM_SIZE }).fill(0);
}

/**
 * What a writer keeps about the durations in one bucket.
 *
 * Every field **merges by addition or by an extreme**, which is the whole point:
 * a mean cannot be merged across writers, so `sumMs` is stored and the mean is
 * derived on read — that is what lets `meanMs` be called exact while the
 * quantiles are not. `minMs` and `maxMs` are exact for the same reason; the
 * quantiles come off the histogram and are within a factor of two of the truth.
 */
export interface DurationStats {
  /** How many runs finished in the bucket. */
  count: number;
  /** Their durations added up, ms. */
  sumMs: number;
  /** The shortest, ms; `0` when `count` is `0`. */
  minMs: number;
  /** The longest, ms; `0` when `count` is `0`. */
  maxMs: number;
  /** {@link DURATION_HISTOGRAM_SIZE} counts, one per {@link durationBin}. */
  histogram: number[];
}

/** One bucket of durations as a backend stores it. */
export type RawDurationBucket = { at: number } & DurationStats;

/** Durations with nothing counted in them. */
export function emptyDurationStats(): DurationStats {
  return {
    count: 0,
    sumMs: 0,
    minMs: 0,
    maxMs: 0,
    histogram: emptyHistogram(),
  };
}

/** An empty bucket at `at`, for {@link fillBuckets}. */
export function emptyDurationBucket(at: number): RawDurationBucket {
  return { at, ...emptyDurationStats() };
}

/** Counts one run's duration into a writer's own stats. */
export function addDuration(stats: DurationStats, ms: number): void {
  const value = Number.isFinite(ms) && ms > 0 ? ms : 0;

  stats.minMs = stats.count === 0 ? value : Math.min(stats.minMs, value);
  stats.maxMs = stats.count === 0 ? value : Math.max(stats.maxMs, value);
  stats.count++;
  stats.sumMs += value;
  stats.histogram[durationBin(value)]!++;
}

/**
 * Adds one writer's stats into another's: counts and sums add, the extremes
 * take the extreme, and the histograms add element by element.
 *
 * Merging arrays wholesale rather than incrementing a bin remotely is what
 * makes the histogram free: each writer owns its row, writes its own 25
 * numbers, and a read adds them up.
 */
export function mergeDurationStats(
  into: DurationStats,
  from: DurationStats,
): void {
  if (from.count === 0) {
    return;
  }

  into.minMs = into.count === 0 ? from.minMs : Math.min(into.minMs, from.minMs);
  into.maxMs = into.count === 0 ? from.maxMs : Math.max(into.maxMs, from.maxMs);
  into.count += from.count;
  into.sumMs += from.sumMs;

  for (let bin = 0; bin < DURATION_HISTOGRAM_SIZE; bin++) {
    into.histogram[bin] =
      (into.histogram[bin] ?? 0) + (from.histogram[bin] ?? 0);
  }
}

/**
 * Duration rows merged into one bucket per start, oldest first, dropping any
 * outside `range` and any that counted nothing. The counterpart of
 * {@link mergeCounterBuckets}, and read through `Number` for the same reason.
 */
export function mergeDurationBuckets(
  /** The stored rows, in any order. */
  rows: Iterable<{ at: number } & Partial<DurationStats>>,
  /** The buckets wanted; anything outside is dropped. */
  range: BucketRange,
): RawDurationBucket[] {
  const byBucket = new Map<number, RawDurationBucket>();

  for (const row of rows) {
    const at = Number(row.at);
    if (at < range.from || at > range.to) {
      continue;
    }

    let bucket = byBucket.get(at);
    if (!bucket) {
      bucket = emptyDurationBucket(at);
      byBucket.set(at, bucket);
    }

    mergeDurationStats(bucket, {
      count: Number(row.count) || 0,
      sumMs: Number(row.sumMs) || 0,
      minMs: Number(row.minMs) || 0,
      maxMs: Number(row.maxMs) || 0,
      histogram: row.histogram ?? [],
    });
  }

  return [...byBucket.values()]
    .filter((bucket) => bucket.count > 0)
    .sort((a, b) => a.at - b.at);
}

/** Durations as a reader reports them: the exact figures, and the approximate ones. */
export interface DurationSummary {
  /** How many runs finished. `0` means every other field is meaningless. */
  count: number;
  /** The shortest, ms. Exact. */
  minMs: number;
  /** The longest, ms. Exact. */
  maxMs: number;
  /** Their mean, ms. Exact — a sum over a count, not a histogram read. */
  meanMs: number;
  /** The approximate median, ms; absent when no histogram was kept. */
  p50Ms?: number;
  /** The approximate 95th percentile, ms; absent when no histogram was kept. */
  p95Ms?: number;
  /** The histogram itself, when one was kept, so a caller can re-bucket or merge it. */
  histogram?: number[];
}

/**
 * A quantile read off a histogram, by interpolating inside the bin it falls in.
 *
 * Bins are a factor of two wide, so the answer is **always within a factor of
 * two of the truth and typically within 20–30%** — the price of a summary that
 * merges across writers and buckets without storing a single duration. A
 * quantile landing in the overflow bin answers with its lower edge: there is no
 * upper edge to interpolate towards.
 */
export function histogramQuantile(
  /** {@link DURATION_HISTOGRAM_SIZE} counts, as {@link durationBin} indexes them. */
  histogram: readonly number[],
  /** The quantile wanted, `0`–`1` (`0.5` is the median). */
  quantile: number,
): number {
  let total = 0;
  for (const count of histogram) {
    total += count;
  }

  if (total === 0) {
    return 0;
  }

  const target = Math.min(Math.max(quantile, 0), 1) * total;
  const last = DURATION_HISTOGRAM_SIZE - 1;
  let below = 0;

  for (let bin = 0; bin < histogram.length; bin++) {
    const count = histogram[bin] ?? 0;
    if (count === 0) {
      continue;
    }

    if (below + count < target) {
      below += count;
      continue;
    }

    const low = bin === 0 ? 0 : (DURATION_HISTOGRAM_BOUNDS[bin - 1] ?? 0);
    if (bin >= last) {
      return low;
    }

    const high = DURATION_HISTOGRAM_BOUNDS[bin] ?? low;
    return low + (high - low) * ((target - below) / count);
  }

  return 0;
}

/**
 * Stats as a reader reports them: the mean derived from the sum, the quantiles
 * read off the histogram. A bucket that counted nothing reports zeros and no
 * quantiles — `count: 0` is how a caller knows the rest says nothing.
 */
export function readDurations(stats: DurationStats): DurationSummary {
  if (stats.count === 0) {
    return { count: 0, minMs: 0, maxMs: 0, meanMs: 0 };
  }

  const summary: DurationSummary = {
    count: stats.count,
    minMs: stats.minMs,
    maxMs: stats.maxMs,
    meanMs: stats.sumMs / stats.count,
  };

  const counted = stats.histogram.reduce((sum, count) => sum + count, 0);
  if (counted > 0) {
    summary.p50Ms = histogramQuantile(stats.histogram, 0.5);
    summary.p95Ms = histogramQuantile(stats.histogram, 0.95);
    summary.histogram = [...stats.histogram];
  }

  return summary;
}

/* ------------------------------------------------------------------ *
 * Busyness
 * ------------------------------------------------------------------ */

/** What one heartbeat says about how busy a worker is. */
export interface BusynessSample {
  /** How many jobs it was running at that moment. */
  active: number;
  /** How many it was allowed to run at once. */
  concurrency: number;
}

/**
 * What a writer keeps about the busyness samples in one bucket.
 *
 * `activeSum` rather than a mean, for {@link DurationStats}' reason. `lastAt`
 * is what makes `concurrency` well defined once a bucket holds two writers'
 * rows: the later sample's setting is the current one.
 */
export interface BusynessStats {
  /** Heartbeats that landed in the bucket. `0` means the worker was not reporting. */
  samples: number;
  /** Their `active` figures added up. */
  activeSum: number;
  /** The most jobs any of them saw in flight. */
  activeMax: number;
  /** The concurrency of the latest sample. */
  concurrency: number;
  /** When that latest sample was taken, epoch ms; `0` when there were none. */
  lastAt: number;
}

/** One bucket of busyness as a backend stores it. */
export type RawBusynessBucket = { at: number } & BusynessStats;

/** Busyness with nothing sampled. */
export function emptyBusynessStats(): BusynessStats {
  return { samples: 0, activeSum: 0, activeMax: 0, concurrency: 0, lastAt: 0 };
}

/** An empty bucket at `at`, for {@link fillBuckets}. */
export function emptyBusynessBucket(at: number): RawBusynessBucket {
  return { at, ...emptyBusynessStats() };
}

/** Counts one heartbeat's sample, taken at `at`, into a writer's own stats. */
export function addBusynessSample(
  /** The stats to add to. */
  stats: BusynessStats,
  /** When the sample was taken, epoch ms — not the bucket's start. */
  at: number,
  /** What the heartbeat saw. */
  sample: BusynessSample,
): void {
  stats.samples++;
  stats.activeSum += sample.active;
  stats.activeMax = Math.max(stats.activeMax, sample.active);

  if (at >= stats.lastAt) {
    stats.lastAt = at;
    stats.concurrency = sample.concurrency;
  }
}

/** Adds one writer's busyness stats into another's, keeping the later `concurrency`. */
export function mergeBusynessStats(
  into: BusynessStats,
  from: BusynessStats,
): void {
  if (from.samples === 0) {
    return;
  }

  into.samples += from.samples;
  into.activeSum += from.activeSum;
  into.activeMax = Math.max(into.activeMax, from.activeMax);

  if (from.lastAt >= into.lastAt) {
    into.lastAt = from.lastAt;
    into.concurrency = from.concurrency;
  }
}

/**
 * Busyness rows merged into one bucket per start, oldest first, dropping any
 * outside `range` and any with no samples in them.
 */
export function mergeBusynessBuckets(
  /** The stored rows, in any order. */
  rows: Iterable<{ at: number } & Partial<BusynessStats>>,
  /** The buckets wanted; anything outside is dropped. */
  range: BucketRange,
): RawBusynessBucket[] {
  const byBucket = new Map<number, RawBusynessBucket>();

  for (const row of rows) {
    const at = Number(row.at);
    if (at < range.from || at > range.to) {
      continue;
    }

    let bucket = byBucket.get(at);
    if (!bucket) {
      bucket = emptyBusynessBucket(at);
      byBucket.set(at, bucket);
    }

    mergeBusynessStats(bucket, {
      samples: Number(row.samples) || 0,
      activeSum: Number(row.activeSum) || 0,
      activeMax: Number(row.activeMax) || 0,
      concurrency: Number(row.concurrency) || 0,
      lastAt: Number(row.lastAt) || 0,
    });
  }

  return [...byBucket.values()]
    .filter((bucket) => bucket.samples > 0)
    .sort((a, b) => a.at - b.at);
}

/** Busyness as a reader reports it: the mean derived, the rest as sampled. */
export interface BusynessSummary {
  /** Heartbeats in the range. **`0` means the worker was not reporting** — not that it was idle. */
  samples: number;
  /** Mean jobs in flight across them; `0` when there were none. */
  activeMean: number;
  /** The most any of them saw; `0` when there were none. */
  activeMax: number;
  /** The concurrency of the latest sample; `0` when there were none. */
  concurrency: number;
}

/** Stats as a reader reports them; `samples: 0` reports zeros throughout. */
export function readBusyness(stats: BusynessStats): BusynessSummary {
  return {
    samples: stats.samples,
    activeMean: stats.samples === 0 ? 0 : stats.activeSum / stats.samples,
    activeMax: stats.activeMax,
    concurrency: stats.concurrency,
  };
}

/* ------------------------------------------------------------------ *
 * Grouped reads: many entities at once
 * ------------------------------------------------------------------ */

/**
 * Duration rows added up over a whole range: one {@link DurationStats}, still
 * mergeable. The duration counterpart of {@link totalCounters}.
 */
export function totalDurationStats(
  /** The rows to add up, in any order; their `at` is ignored. */
  rows: Iterable<Partial<DurationStats>>,
): DurationStats {
  const total = emptyDurationStats();
  for (const row of rows) {
    mergeDurationStats(total, {
      count: Number(row.count) || 0,
      sumMs: Number(row.sumMs) || 0,
      minMs: Number(row.minMs) || 0,
      maxMs: Number(row.maxMs) || 0,
      histogram: row.histogram ?? [],
    });
  }
  return total;
}

/**
 * Busyness rows added up over a whole range: one {@link BusynessStats}, the
 * `concurrency` of the latest sample. The busyness counterpart of
 * {@link totalCounters}.
 */
export function totalBusynessStats(
  /** The rows to add up, in any order; their `at` is ignored. */
  rows: Iterable<Partial<BusynessStats>>,
): BusynessStats {
  const total = emptyBusynessStats();
  for (const row of rows) {
    mergeBusynessStats(total, {
      samples: Number(row.samples) || 0,
      activeSum: Number(row.activeSum) || 0,
      activeMax: Number(row.activeMax) || 0,
      concurrency: Number(row.concurrency) || 0,
      lastAt: Number(row.lastAt) || 0,
    });
  }
  return total;
}

/**
 * One runner's totals over a range: what a row of a grouped runner read
 * carries, less the runner's name.
 */
export interface RunnerRunTotals {
  /** Its runs by outcome over the range, every counter present. */
  runs: RunnerRunCounters;
  /**
   * Its durations over the range, merged — present whenever durations were
   * asked for and the driver records them, with `count: 0` when none finished.
   */
  durations?: DurationStats;
}

/**
 * One worker key's totals over a range: what a row of a grouped worker read
 * carries, less the worker's identity.
 */
export interface WorkerJobTotals {
  /** The jobs it finished over the range, both counters present. */
  jobs: JobCounters;
  /**
   * Its busyness over the range, merged — present whenever busyness was asked
   * for and the driver records it, with `samples: 0` when it never reported.
   */
  busyness?: BusynessStats;
}

/**
 * A runner's per-entity read reduced to its totals, or `undefined` when it has
 * nothing to report — no run counted and, when durations were read, none
 * finished.
 *
 * **This is the definition of a grouped totals row**: a backend that reads
 * each entity's sparse buckets builds its rows with it, and one that sums in
 * the engine (`GROUP BY entity`, `$group`) must answer exactly what this
 * would have. The contract suite asserts the two agree.
 *
 * The read must already be limited to the range — every driver read is.
 */
export function runnerTotalsOf(
  /** The runner's sparse buckets, as `getRunnerMetrics` answers them. */
  read: {
    /** Runs by outcome, sparse. */
    runs: readonly Partial<RunnerRunCounters>[];
    /** Durations, sparse; absent when not read or not recorded. */
    durations?: readonly Partial<DurationStats>[];
  },
): RunnerRunTotals | undefined {
  const runs = totalCounters(read.runs, RUNNER_RUN_COUNTERS);
  const durations =
    read.durations === undefined
      ? undefined
      : totalDurationStats(read.durations);

  const counted = RUNNER_RUN_COUNTERS.some((key) => runs[key] > 0);
  if (!counted && (durations?.count ?? 0) === 0) {
    return undefined;
  }

  return durations === undefined ? { runs } : { runs, durations };
}

/**
 * A worker's per-entity read reduced to its totals, or `undefined` when it has
 * nothing to report — no job counted and, when busyness was read, no sample.
 * The worker counterpart of {@link runnerTotalsOf}, and the definition of a
 * grouped worker row in the same way.
 */
export function workerTotalsOf(
  /** The worker's sparse buckets, as `getWorkerMetrics` answers them. */
  read: {
    /** Jobs it finished, sparse. */
    jobs: readonly Partial<JobCounters>[];
    /** Its busyness, sparse; absent when not read or not recorded. */
    busyness?: readonly Partial<BusynessStats>[];
  },
): WorkerJobTotals | undefined {
  const jobs = totalCounters(read.jobs, JOB_COUNTERS);
  const busyness =
    read.busyness === undefined ? undefined : totalBusynessStats(read.busyness);

  const counted = JOB_COUNTERS.some((key) => jobs[key] > 0);
  if (!counted && (busyness?.samples ?? 0) === 0) {
    return undefined;
  }

  return busyness === undefined ? { jobs } : { jobs, busyness };
}

/**
 * Whether a per-entity series read has anything in it: the presence rule for a
 * batch read (`getRunnerMetricsMany`, `getWorkerMetricsMany`), where an entity
 * with nothing in range is absent rather than a row of empty arrays.
 *
 * Every array but the first is optional, so one test covers runners
 * (`runs`, `durations`) and workers (`jobs`, `busyness`) alike.
 */
export function hasMetricBuckets(
  /** The series of one entity's read, each sparse. */
  ...series: (readonly unknown[] | undefined)[]
): boolean {
  return series.some((buckets) => (buckets?.length ?? 0) > 0);
}

/** A worker's series identity: the queue it consumes, then its stable key. */
export interface WorkerMetricsRef {
  /** The queue the worker consumes. */
  queue: string;
  /**
   * Its stable `WorkerInfo.key` — or its id, for a record whose key is empty,
   * which is what the recording falls back to.
   */
  key: string;
}

/**
 * The single entity name a worker's series is stored under: `queue:key`.
 *
 * Scoped by queue because a worker record is, so two queues' workers sharing a
 * key stay two series. A queue name cannot hold a colon (`assertSegment`
 * allows `[A-Za-z0-9_.-]` only) while a key may, so the **first** colon always
 * splits the pair back the same way — {@link splitWorkerMetricsEntity}.
 */
export function workerMetricsEntity(queue: string, key: string): string {
  return `${queue}:${key}`;
}

/**
 * A stored worker entity split back into its queue and key, or `undefined` for
 * a name that is not one — the namespace roll-up ({@link NAMESPACE_ENTITY})
 * above all, which a grouped read must never report as a worker.
 */
export function splitWorkerMetricsEntity(
  entity: string,
): WorkerMetricsRef | undefined {
  // The roll-up's empty name has no colon; neither has anything else that
  // is not a worker's. A leading colon would be an empty queue name.
  const colon = entity.indexOf(":");
  if (colon <= 0) {
    return undefined;
  }
  return { queue: entity.slice(0, colon), key: entity.slice(colon + 1) };
}

/**
 * A batch's worker refs with repeats dropped, first occurrence kept: a grouped
 * read answers each entity once however often it was named.
 */
export function uniqueWorkerRefs(
  refs: Iterable<WorkerMetricsRef>,
): WorkerMetricsRef[] {
  const seen = new Map<string, WorkerMetricsRef>();
  for (const ref of refs) {
    const entity = workerMetricsEntity(ref.queue, ref.key);
    if (!seen.has(entity)) {
      seen.set(entity, { queue: ref.queue, key: ref.key });
    }
  }
  return [...seen.values()];
}

/* ------------------------------------------------------------------ *
 * Recording options, and what a driver can serve
 * ------------------------------------------------------------------ */

/**
 * What a deployment asks to have recorded. Recording is what costs, so this is
 * opt-*out*: every field defaults to on.
 */
export interface MetricsOptions {
  /**
   * The finest width counts are written at. `"second"` by default; `"minute"`
   * turns the per-second buckets off everywhere and is what a backend that
   * cannot afford them is left with.
   */
  resolution?: "minute" | "second";
  /**
   * How long per-second buckets are kept, ms. `DEFAULT_SECOND_RETENTION_MS`
   * (5 minutes) by default, capped at `MAX_SECOND_RETENTION_MS` (15). Per-second
   * bucketing costs O(entities), not O(jobs), so this number — not the job rate
   * — is what the storage bill is made of.
   */
  secondRetentionMs?: number;
  /**
   * Whether per-worker series are recorded. **The first lever to turn off on a
   * large fleet**: workers are the term that scales with the fleet.
   */
  workers?: boolean;
  /** Whether per-runner outcome series are recorded. */
  runners?: boolean;
  /** Whether run durations and their histograms are recorded. */
  durations?: boolean;
}

/** What a backend can do, whatever it was asked for. */
export interface MetricsLimits {
  /**
   * Whether it can keep per-second buckets at all. `false` forces
   * `resolution: "minute"` — the file driver's case, where a second would mean
   * a directory listing per queue per flush.
   */
  seconds?: boolean;
}

/** {@link MetricsOptions} with every default and every cap applied. */
export interface ResolvedMetricsOptions {
  /** The finest width counts are written at. */
  resolution: "minute" | "second";
  /** How long per-second buckets are kept, ms; `0` when none are written. */
  secondRetentionMs: number;
  /** How long minute buckets are kept, ms: a day, and not configurable in this round. */
  minuteRetentionMs: number;
  /** Whether per-worker series are recorded. */
  workers: boolean;
  /** Whether per-runner outcome series are recorded. */
  runners: boolean;
  /** Whether run durations are recorded. */
  durations: boolean;
  /** The widths every count is written at, finest first — the dual write. */
  intervals: readonly number[];
}

/** {@link MetricsOptions} resolved against the defaults and a backend's limits. */
export function resolveMetricsOptions(
  /** What the deployment asked for, if anything. */
  input?: MetricsOptions,
  /** What the backend can actually do. */
  limits?: MetricsLimits,
): ResolvedMetricsOptions {
  const seconds = limits?.seconds !== false && input?.resolution !== "minute";
  const asked = input?.secondRetentionMs ?? DEFAULT_SECOND_RETENTION_MS;
  const retention = Math.min(
    Math.max(Math.floor(asked), SECOND_BUCKET_MS),
    MAX_SECOND_RETENTION_MS,
  );

  return {
    resolution: seconds ? "second" : "minute",
    secondRetentionMs: seconds ? retention : 0,
    minuteRetentionMs: MINUTE_RETENTION_MS,
    workers: input?.workers ?? true,
    runners: input?.runners ?? true,
    durations: input?.durations ?? true,
    intervals: seconds ? SECOND_INTERVALS : MINUTE_INTERVALS,
  };
}

/** What is being recorded, as `/meta` reports it. */
export interface MetricsRecording {
  /** The finest width counts are written at. */
  resolution: "minute" | "second";
  /** How long per-second buckets are kept, ms; `0` when only minutes are recorded. */
  secondRetentionMs: number;
  /** Whether per-worker series are recorded. */
  workers: boolean;
  /** Whether per-runner outcome series are recorded. */
  runners: boolean;
  /** Whether run durations are recorded. */
  durations: boolean;
}

/**
 * What a driver can serve: the widths it keeps, for how long, and what it is
 * recording. `MetaDto.analytics` is built from this, and
 * {@link resolveAnalyticsRange} picks a resolution out of it.
 */
export interface MetricsSupport {
  /** The widths it serves, in seconds, finest first. A subset of `ANALYTICS_RESOLUTIONS`. */
  resolutions: AnalyticsResolution[];
  /** How long each is kept, ms, keyed by the width in seconds as a string — JSON keys are strings. */
  retentionMs: Partial<Record<`${AnalyticsResolution}`, number>>;
  /** What is being recorded, and therefore what can be asked for. */
  recording: MetricsRecording;
}

/** What a driver running with these options can serve. */
export function metricsSupportOf(
  options: ResolvedMetricsOptions,
): MetricsSupport {
  const seconds = options.resolution === "second";

  return {
    resolutions: seconds ? [1, 60] : [60],
    retentionMs: {
      ...(seconds ? { 1: options.secondRetentionMs } : {}),
      60: options.minuteRetentionMs,
    },
    recording: {
      resolution: options.resolution,
      secondRetentionMs: options.secondRetentionMs,
      workers: options.workers,
      runners: options.runners,
      durations: options.durations,
    },
  };
}

/** How long buckets of `interval` are kept, ms; `0` when none are written. */
export function metricsRetentionFor(
  options: ResolvedMetricsOptions,
  interval: number,
): number {
  return interval === SECOND_BUCKET_MS
    ? options.secondRetentionMs
    : options.minuteRetentionMs;
}

/**
 * The oldest bucket of `interval` still worth keeping at `now`: a driver
 * deletes every bucket whose start is **below** this.
 *
 * Pruning is by range rather than per entity on purpose. A prune driven by new
 * writes to a series never reaches a series nobody writes to any more — a
 * worker that died leaves its buckets behind for good — so it is one
 * `DELETE WHERE bucket < cutoff` per table, on {@link MetricsPruneClock}.
 */
export function metricsPruneCutoff(
  options: ResolvedMetricsOptions,
  interval: number,
  now: number,
): number {
  return bucketStart(now - metricsRetentionFor(options, interval), interval);
}

/**
 * Says when a prune is due: once a minute per process, whatever the write rate.
 *
 * `now` is passed in rather than read, so a caller drives it and a test can
 * step it. The first call is always due — a process that starts with a day of
 * somebody else's buckets behind it should sweep them, not wait a minute.
 */
export class MetricsPruneClock {
  /** How long between prunes, ms. */
  readonly #everyMs: number;
  /** When the last prune was due, or `undefined` before the first. */
  #last: number | undefined;

  constructor(
    /** How long between prunes; a minute, which is one bucket of the coarser width. */
    everyMs: number = MINUTE_BUCKET_MS,
  ) {
    this.#everyMs = everyMs;
  }

  /** Whether to prune at `now`, marking it done when it says yes. */
  due(now: number): boolean {
    if (this.#last !== undefined && now - this.#last < this.#everyMs) {
      return false;
    }

    this.#last = now;
    return true;
  }
}

/* ------------------------------------------------------------------ *
 * Resolution selection
 * ------------------------------------------------------------------ */

/** What a request asks a series to cover. */
export interface AnalyticsRangeInput {
  /** Start, **inclusive**, epoch ms. Defaults to `to − 1 hour`. */
  from?: number;
  /** End, **exclusive**, epoch ms. Defaults to `now`. */
  to?: number;
  /**
   * The finest width wanted, in seconds. A **hint and an upper bound on
   * fineness**: the answer is never finer than this, and may be coarser.
   */
  resolution?: AnalyticsResolution;
  /** The instant the request is read at, epoch ms. */
  now: number;
  /**
   * The finest width this *kind* of series can be observed at, ms, when that is
   * coarser than the backend's buckets. Busyness is the case: it is sampled on
   * the worker's heartbeat, so a 1 s busyness series would be mostly empty
   * buckets pretending to be measurements.
   */
  minIntervalMs?: number;
  /** Most buckets one series may hold. Defaults to `MAX_ANALYTICS_BUCKETS`. */
  maxBuckets?: number;
}

/** The buckets a series will actually be served at, and how that differs from what was asked. */
export interface ResolvedAnalyticsRange extends BucketRange {
  /** The width served, in seconds. An axis is labelled from this, never from what was asked. */
  resolution: AnalyticsResolution;
  /** The same width in ms. */
  interval: number;
  /** `to + interval`: the exclusive end of what the series covers. */
  end: number;
  /** How many buckets it holds — at most `maxBuckets`, always at least one. */
  count: number;
  /** What the request asked for, before any clamping. */
  requested: {
    /** `from` as asked, or the default, **inclusive**. */
    from: number;
    /** `to` as asked, or the default (now), **exclusive**. */
    to: number;
    /** The width asked for, when one was named. */
    resolution?: AnalyticsResolution;
  };
  /** Whether the served range or width differs from what was asked. */
  clamped: boolean;
  /** Why, when it does. */
  reason?: AnalyticsClampReason;
  /** The oldest instant kept at the width served, epoch ms. */
  retainedFrom: number;
  /**
   * Whether the **whole** requested range is older than what is kept. A route
   * answers 400 `RANGE_NOT_RETAINED` rather than 200 with an empty series: the
   * two are indistinguishable to a client, and only one of them is true.
   */
  outOfRetention: boolean;
}

/**
 * Picks the buckets a request is served at: the finest width the backend keeps
 * for the **whole** span, within the bucket cap.
 *
 * **One resolution per response.** A span straddling the per-second retention
 * window is served entirely at 60 s — mixed widths in one series cannot be
 * plotted honestly — and `clamped`/`reason` say so, which is what lets a UI
 * caption the difference instead of quietly drawing the wrong chart.
 *
 * The cap is applied here, **before** any bucket is filled in: a day at one
 * second is 86,400 buckets, and the point of choosing the resolution first is
 * that such a series is never allocated at all.
 */
export function resolveAnalyticsRange(
  /** What the request asked for. */
  input: AnalyticsRangeInput,
  /** What the backend can serve. */
  support: MetricsSupport,
): ResolvedAnalyticsRange {
  const maxBuckets = input.maxBuckets ?? MAX_ANALYTICS_BUCKETS;
  const to = input.to ?? input.now;
  const from = input.from ?? to - DEFAULT_ANALYTICS_SPAN_MS;
  const served: AnalyticsResolution[] =
    support.resolutions.length > 0 ? support.resolutions : [60];
  const coarsest: AnalyticsResolution = served[served.length - 1] ?? 60;

  // Never finer than asked for, and never finer than the kind can be observed.
  const candidates = served.filter(
    (resolution) =>
      (input.resolution === undefined || resolution >= input.resolution) &&
      resolution * 1_000 >= (input.minIntervalMs ?? 0),
  );

  let reason: AnalyticsClampReason | undefined;
  let resolution: AnalyticsResolution | undefined;

  // Both checks compare **buckets**, not instants: the first bucket served is
  // the one `from` falls in, so a request is only short of retention when that
  // bucket is gone. Compared as instants, "the last 24 hours" read against a
  // 24 h retention came out clamped whenever the client's clock ran a few ms
  // behind the server's — which is every time.
  for (const candidate of candidates) {
    const candidateInterval = candidate * 1_000;
    const retained = support.retentionMs[`${candidate}`] ?? 0;
    if (
      bucketStart(from, candidateInterval) <
      bucketStart(input.now - retained, candidateInterval)
    ) {
      reason ??= "retention";
      continue;
    }
    if (
      bucketCount(
        alignBucketRange(from, to, candidateInterval),
        candidateInterval,
      ) > maxBuckets
    ) {
      reason ??= "maxBuckets";
      continue;
    }

    resolution = candidate;
    break;
  }

  if (resolution === undefined) {
    resolution = candidates[candidates.length - 1] ?? coarsest;
  }

  // A width the backend does not record at all is the backend's answer, not a
  // clamp of the range; a width this *kind* cannot be observed at is the kind's.
  if (
    input.resolution !== undefined &&
    resolution !== input.resolution &&
    !served.includes(input.resolution)
  ) {
    reason = "driver";
  } else if (
    input.minIntervalMs !== undefined &&
    input.resolution !== undefined &&
    resolution !== input.resolution &&
    input.resolution * 1_000 < input.minIntervalMs
  ) {
    reason = "resolution";
  }

  const interval = resolution * 1_000;
  const retainedFrom = input.now - (support.retentionMs[`${resolution}`] ?? 0);
  const start = Math.max(from, retainedFrom);

  if (bucketStart(start, interval) > bucketStart(from, interval)) {
    reason ??= "retention";
  }

  const range = alignBucketRange(start, to, interval);
  let first = range.from;

  if (bucketCount({ from: first, to: range.to }, interval) > maxBuckets) {
    first = range.to - (maxBuckets - 1) * interval;
    reason ??= "maxBuckets";
  }

  const count = bucketCount({ from: first, to: range.to }, interval);

  return {
    resolution,
    interval,
    from: first,
    to: range.to,
    end: range.to + interval,
    count,
    requested: {
      from,
      to,
      ...(input.resolution === undefined
        ? {}
        : { resolution: input.resolution }),
    },
    clamped: reason !== undefined,
    ...(reason === undefined ? {} : { reason }),
    retainedFrom,
    outOfRetention: to <= retainedFrom,
  };
}

/** The widths this build knows about, finest first — every backend serves a subset. */
export const METRICS_RESOLUTIONS: readonly AnalyticsResolution[] =
  ANALYTICS_RESOLUTIONS;

/* ------------------------------------------------------------------ *
 * Buffers
 * ------------------------------------------------------------------ */

/**
 * What a buffered writer answers with: the entries that did not land, and why
 * — so only those are written again, and the failure still reaches whoever
 * asked for the write.
 */
export interface BufferWriteResult<TEntry> {
  /** Entries that did not land, to be written again on the next tick. */
  unwritten: TEntry[];
  /**
   * The first failure behind them, when there was one. The flush that wrote the
   * batch rejects with it once the unwritten entries are back.
   */
  error?: unknown;
}

/**
 * Entries gathered in memory and written once a second, for a backend that
 * cannot count inside its own statement.
 *
 * Counting is a `Map` update — no I/O — and the write is one batch per second
 * per process however much was counted, so nothing ever pays a round trip per
 * job. The price is honesty about two things: a count reaches the backend up to
 * `flushMs` after the event, and a process that dies hard loses what it had not
 * written yet.
 *
 * A writer answers with the entries that did **not** land, and only those are
 * merged back and tried again. Putting the whole batch back on any failure — as
 * the throughput buffer first did — counted twice everything that had landed
 * before the failure, because the writes are separate statements.
 *
 * The timer is unref'd and armed only once something is counted, so an idle
 * driver holds no process open and does no work. This is the engine
 * {@link MetricsBuffer} and `ThroughputBuffer` are both built on; neither of
 * them re-implements any of it.
 */
export class PendingBuffer<TEntry> {
  /** Writes one batch, answering with the entries that did not land. */
  readonly #write: (batch: TEntry[]) => Promise<BufferWriteResult<TEntry>>;
  /** What an entry is merged by: two entries with the same key are one row. */
  readonly #key: (entry: TEntry) => string;
  /** Folds a second entry into the one already held for its key. */
  readonly #merge: (into: TEntry, from: TEntry) => void;
  /** Which namespace an entry belongs to, for {@link PendingBuffer.forget}. */
  readonly #ns: (entry: TEntry) => string;
  /** How long after the first entry the batch is written, ms. */
  readonly #flushMs: number;

  /** What has been gathered and not yet written, by key. */
  #pending = new Map<string, TEntry>();
  /** The flush timer, while one is armed. */
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** The write in flight, so flushes never overlap. */
  #flushing: Promise<void> | undefined;
  /**
   * Bumped whenever a held entry may have left {@link PendingBuffer.#pending}
   * — a flush taking the batch, or a `forget`. An entry {@link PendingBuffer.add}
   * returned may be merged into directly only while this has not moved.
   */
  #generation = 0;

  constructor(options: {
    /**
     * Writes one batch and answers with the entries that did not land and why;
     * called at most once at a time. Throwing puts the whole batch back, so a
     * writer that can tell what landed should answer rather than throw.
     */
    write: (batch: TEntry[]) => Promise<BufferWriteResult<TEntry>>;
    /** What an entry is merged by; two entries sharing a key become one. */
    key: (entry: TEntry) => string;
    /** Folds a second entry into the one already held for its key. */
    merge: (into: TEntry, from: TEntry) => void;
    /** Which namespace an entry belongs to. Defaults to its `ns` field. */
    ns?: (entry: TEntry) => string;
    /** How long to gather before writing, ms. Defaults to a second. */
    flushMs?: number;
  }) {
    this.#write = options.write;
    this.#key = options.key;
    this.#merge = options.merge;
    this.#ns = options.ns ?? ((entry) => (entry as { ns?: string }).ns ?? "");
    this.#flushMs = options.flushMs ?? SECOND_BUCKET_MS;
  }

  /** How many rows are waiting to be written. */
  get size(): number {
    return this.#pending.size;
  }

  /**
   * Which gathering the held entries belong to. While it reads the same, an
   * entry {@link PendingBuffer.add} returned is still the one that will be
   * written, so a caller may add to it in place instead of adding again.
   */
  get generation(): number {
    return this.#generation;
  }

  /**
   * Gathers one entry, merging it into the one held for its key if there is
   * one, and answers with the entry now held for that key.
   */
  add(entry: TEntry): TEntry {
    const key = this.#key(entry);
    let held = this.#pending.get(key);

    if (held) {
      this.#merge(held, entry);
    } else {
      this.#pending.set(key, entry);
      held = entry;
    }

    if (!this.#timer) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        void this.flush().catch(() => undefined);
      }, this.#flushMs);
      this.#timer.unref?.();
    }

    return held;
  }

  /** Forgets everything gathered for a namespace, as purging it must. */
  forget(ns: string): void {
    this.#generation += 1;

    for (const [key, entry] of this.#pending) {
      if (this.#ns(entry) === ns) {
        this.#pending.delete(key);
      }
    }
  }

  /**
   * Writes everything gathered so far, waiting for a write already in flight
   * first. Resolves once nothing gathered before the call is still pending.
   */
  async flush(): Promise<void> {
    // A write another caller started failing is that caller's to hear about:
    // this one only needs it finished before taking what is left.
    while (this.#flushing) {
      await this.#flushing.catch(() => undefined);
    }

    if (this.#pending.size === 0) {
      return;
    }

    const batch = [...this.#pending.values()];
    this.#pending = new Map();
    this.#generation += 1;

    this.#flushing = (async () => {
      let result: BufferWriteResult<TEntry>;

      try {
        result = await this.#write(batch);
      } catch (error) {
        // A writer that throws says nothing about what landed.
        this.#restore(batch);
        throw error;
      }

      this.#restore(result.unwritten);

      // Only the entries that failed go back, but the failure is still this
      // caller's to hear about: swallowed, a write failing the same way every
      // second would look, from outside, like a queue with nothing to count.
      if (result.error !== undefined) {
        throw result.error;
      }
    })().finally(() => {
      this.#flushing = undefined;
    });

    await this.#flushing;
  }

  /** Puts entries that did not land back, for the next tick to write. */
  #restore(entries: TEntry[]): void {
    for (const entry of entries) {
      this.add(entry);
    }
  }

  /** Stops the timer and writes what is left. */
  async close(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }

    await this.flush().catch(() => undefined);

    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}

/** The entity a namespace roll-up bucket is stored under: the empty name. */
export const NAMESPACE_ENTITY = "";

/** One metric row waiting to be written. */
export interface PendingMetric<C extends Record<keyof C, number>> {
  /** The namespace. */
  ns: string;
  /** The queue, worker key or runner id — or {@link NAMESPACE_ENTITY} for the roll-up. */
  entity: string;
  /** The bucket's start, epoch ms. */
  at: number;
  /** The bucket's width, ms. */
  interval: number;
  /** What was counted, every counter present. */
  counts: C;
}

/** The rows one entity's counts went into for one second, in {@link MetricsBuffer}. */
interface HotRows<C extends Record<keyof C, number>> {
  /** The start of the finest width's bucket the rows were found for. */
  second: number;
  /** The held rows a count in that second adds to: each width, own and roll-up. */
  rows: PendingMetric<C>[];
}

/**
 * Counts gathered per `(ns, entity, bucket)` and written once a second.
 *
 * It is where three of the design's rules live, so that no driver has to
 * remember them:
 *
 * - **One shared row per `(ns, entity, second)`**, not one per shard. The eight
 *   metric shards exist because *per-job* statements contend on a row — 1,421 ms
 *   against 2 ms, measured — and at one write per entity per second they
 *   cannot. Fanning out here instead would turn a mid-sized namespace's 58 K
 *   rows into 1.25 M.
 * - **Second and minute are a dual write**: one count bumps both buckets, so
 *   every shipped minute-resolution read keeps behaving exactly as it did, and
 *   nothing needs a leader to roll seconds up (which would lose a minute of
 *   counts whenever the leader died).
 * - **Every per-entity count also bumps the namespace roll-up**, so an overview
 *   costs three reads whether the namespace has three workers or three hundred.
 */
export class MetricsBuffer<C extends Record<keyof C, number>> {
  /** The gathering and flushing engine. */
  readonly #buffer: PendingBuffer<PendingMetric<C>>;
  /** The counters this buffer carries. */
  readonly #keys: readonly (keyof C & string)[];
  /** The widths each count is written at. */
  readonly #intervals: readonly number[];
  /** Whether a per-entity count also bumps the namespace roll-up. */
  readonly #rollUp: boolean;
  /**
   * The rows each entity's counts went into this second, by namespace then
   * entity — so the next count in the same second adds to them in place
   * rather than building a key string and a row per width all over again.
   * Emptied whenever the buffer's generation moves (a flush or a `forget`),
   * so it only ever holds rows still waiting to be written.
   */
  readonly #hot = new Map<string, Map<string, HotRows<C>>>();
  /** The {@link PendingBuffer.generation} {@link MetricsBuffer.#hot} was filled in. */
  #hotGeneration = 0;

  constructor(options: {
    /**
     * Writes one batch of rows and answers with those that did not land;
     * called at most once at a time.
     */
    write: (
      batch: PendingMetric<C>[],
    ) => Promise<BufferWriteResult<PendingMetric<C>>>;
    /** The counters carried, which is also what a merge adds up. */
    keys: readonly (keyof C & string)[];
    /**
     * The widths each count is written at, finest first — the dual write.
     * `ResolvedMetricsOptions.intervals`, which is a minute alone when
     * per-second recording is off.
     */
    intervals?: readonly number[];
    /**
     * Whether each per-entity count also bumps the namespace roll-up. `true` by
     * default; `false` only for a backend that must write the roll-up some
     * other way (Redis, where a namespace key is outside the queue's hash tag
     * and a script cannot touch both).
     */
    rollUp?: boolean;
    /** How long to gather before writing, ms. Defaults to a second. */
    flushMs?: number;
  }) {
    this.#keys = options.keys;
    this.#intervals = options.intervals ?? SECOND_INTERVALS;
    this.#rollUp = options.rollUp ?? true;
    this.#buffer = new PendingBuffer<PendingMetric<C>>({
      write: options.write,
      key: (entry) =>
        `${entry.ns}\n${entry.entity}\n${entry.interval}\n${entry.at}`,
      merge: (into, from) => {
        for (const key of this.#keys) {
          into.counts[key] = ((into.counts[key] ?? 0) +
            (from.counts[key] ?? 0)) as C[keyof C & string];
        }
      },
      ns: (entry) => entry.ns,
      ...(options.flushMs === undefined ? {} : { flushMs: options.flushMs }),
    });
  }

  /** How many rows are waiting to be written. */
  get size(): number {
    return this.#buffer.size;
  }

  /**
   * Counts something for one entity at `now`: one row per width, plus the
   * namespace's own. Counting nothing — every delta zero or absent — does
   * nothing at all, so an idle process never arms the timer.
   */
  count(
    /** The namespace. */
    ns: string,
    /** The queue, worker key or runner id. */
    entity: string,
    /** When it happened, epoch ms; floored to each width. */
    now: number,
    /** The deltas; anything absent is zero. */
    counts: Partial<C>,
  ): void {
    const keys = this.#keys;
    let any = false;
    for (const key of keys) {
      if ((counts[key] ?? 0) !== 0) {
        any = true;
        break;
      }
    }
    if (!any) {
      return;
    }

    const generation = this.#buffer.generation;
    if (generation !== this.#hotGeneration) {
      this.#hot.clear();
      this.#hotGeneration = generation;
    }

    const second = bucketStart(now, this.#intervals[0] ?? SECOND_BUCKET_MS);
    let entities = this.#hot.get(ns);
    const hot = entities?.get(entity);

    if (hot !== undefined && hot.second === second) {
      // Every width is a whole number of the finest, so the same finest
      // bucket means the same bucket at every width: the rows held are
      // exactly the ones the adds below would merge into.
      for (const row of hot.rows) {
        const into = row.counts;
        for (const key of keys) {
          const delta = counts[key];
          if (delta !== undefined && delta !== 0) {
            into[key] = (into[key] + delta) as C[keyof C & string];
          }
        }
      }
      return;
    }

    const rows: PendingMetric<C>[] = [];
    for (const interval of this.#intervals) {
      const at = bucketStart(now, interval);
      rows.push(this.#buffer.add(this.#row(ns, entity, at, interval, counts)));

      if (this.#rollUp && entity !== NAMESPACE_ENTITY) {
        rows.push(
          this.#buffer.add(
            this.#row(ns, NAMESPACE_ENTITY, at, interval, counts),
          ),
        );
      }
    }

    if (!entities) {
      entities = new Map();
      this.#hot.set(ns, entities);
    }
    entities.set(entity, { second, rows });
  }

  /** Forgets everything counted for a namespace, as purging it must. */
  forget(ns: string): void {
    this.#buffer.forget(ns);
  }

  /** Writes everything counted so far. */
  async flush(): Promise<void> {
    await this.#buffer.flush();
  }

  /** Stops the timer and writes what is left. */
  async close(): Promise<void> {
    await this.#buffer.close();
  }

  /** One row, with every counter present so a merge is a plain addition. */
  #row(
    ns: string,
    entity: string,
    at: number,
    interval: number,
    counts: Partial<C>,
  ): PendingMetric<C> {
    const full = {} as C;
    for (const key of this.#keys) {
      full[key] = (counts[key] ?? 0) as C[keyof C & string];
    }
    return { ns, entity, at, interval, counts: full };
  }
}
