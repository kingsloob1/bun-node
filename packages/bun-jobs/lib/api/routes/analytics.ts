import type { BunRequest } from "@kingsleyweb/bun-common";
import type {
  CounterBucket,
  DurationStats,
  JobsDriver,
  MetricsQuery,
  MetricsSupport,
  RawBusynessBucket,
  RawDurationBucket,
  ResolvedAnalyticsRange,
  RunnerMetricsTotals,
  WorkerInfo,
  WorkerMetricsRef,
  WorkerMetricsTotals,
} from "../../drivers/index";
import type { BunRunner } from "../../runner/BunRunner";
import type { ResolvedJobsApiConfig } from "../config";
import type { AnalyticsResolution } from "../contract/constants";
import type {
  AnalyticsRangeDto,
  AnalyticsSeriesDto,
  JobsBucketDto,
  JobsTotalsDto,
  MetaAnalyticsDto,
  OverviewAnalyticsDto,
  RunnerAnalyticsRowDto,
  RunnerAnalyticsSeriesDto,
  RunnerDurationBucketDto,
  RunnerDurationTotalsDto,
  RunnerRunsBucketDto,
  RunnerRunsTotalsDto,
  RunnersAnalyticsDto,
  WorkerAnalyticsRowDto,
  WorkerAnalyticsSeriesDto,
  WorkerBusynessBucketDto,
  WorkerBusynessTotalsDto,
  WorkerJobsTotalsDto,
  WorkersAnalyticsDto,
} from "../contract/types";
import type { AnyRouteDef, RouteServices } from "./define";
import {
  DEFAULT_ANALYTICS_SPAN_MS,
  emptyBusynessBucket,
  emptyBusynessStats,
  emptyDurationBucket,
  emptyDurationStats,
  fillBuckets,
  JOB_COUNTERS,
  mergeBusynessBuckets,
  mergeBusynessStats,
  mergeCounterBuckets,
  mergeDurationBuckets,
  mergeDurationStats,
  readBusyness,
  readDurations,
  resolveAnalyticsRange,
  RUNNER_RUN_COUNTERS,
  supportsWorkers,
  totalCounters,
  uniqueWorkerRefs,
  workerMetricsEntity,
  zeroCounters,
} from "../../drivers/index";
import { DEFAULT_REPORT_INTERVAL } from "../../queue/BunQueueWorker";
import { runnerKey } from "../../shared/keys";
import {
  MAX_ANALYTICS_BUCKETS,
  MAX_ANALYTICS_ROWS,
  MAX_ANALYTICS_SERIES,
  MAX_ANALYTICS_SPAN_MS,
  MIN_ANALYTICS_SPAN_MS,
} from "../contract/constants";
import { ApiError } from "../errors";
import {
  analyticsRangeQuerySchema,
  JobsSeriesSchema,
  RunnerAnalyticsSchema,
  runnersAnalyticsQuerySchema,
  RunnersAnalyticsSchema,
  WorkerAnalyticsSchema,
  workersAnalyticsQuerySchema,
  WorkersAnalyticsSchema,
} from "../schemas/analytics";
import { parseSegment } from "../sources";
import { defineRoute } from "./define";
import { ANALYTICS_METHODS, DRIVER_FEATURES, driverImplements } from "./meta";
import { visibleQueueNames } from "./queues";
import {
  mapBounded,
  QueueParams,
  queueTarget,
  RunnerParams,
  runnerTarget,
  toEpoch,
  WorkerConfigParams,
  workerKeyTarget,
} from "./support";

/**
 * The analytics read routes, and the pieces `/overview` and `/meta` share with
 * them.
 *
 * **Every read goes through the range once.** A request's `from`/`to` (`to`
 * exclusive) is resolved by `resolveAnalyticsRange` into bucket starts (`to`
 * inclusive) and a served resolution, checked against retention, and the
 * resolved range is what both the driver query and the response's
 * {@link AnalyticsRangeDto} are built from — so the two cannot disagree about
 * which buckets a series holds.
 *
 * **What a roll-up costs — two paths.** A driver implementing the four
 * grouped reads ({@link GROUPED_METRICS_METHODS}) answers every entity's
 * totals in one read (`getRunnerMetricsTotals`, `getWorkerMetricsTotals`) and
 * a named batch's series in one more (`getRunnerMetricsMany`,
 * `getWorkerMetricsMany`): a roll-up costs a fixed number of metrics reads
 * whatever the fleet, and an `ids=` / `keys=` batch adds **exactly one** read
 * of its kind. That is also what lets `/overview` carry the runners and
 * workers sections. A driver without them keeps the per-entity path: a read
 * per listed runner or worker key, the batch served from those same reads,
 * and `/overview` without the two sections, since they would put a read per
 * entity on every poll.
 *
 * `runningNow` is state, not a bucket, so no metrics read answers it: it is a
 * lock read per runner — on the grouped path only for the rows returned (at
 * most `MAX_ANALYTICS_ROWS`).
 */

/**
 * How often a worker samples its busyness when nothing says otherwise: the
 * worker's default `reportInterval` ({@link DEFAULT_REPORT_INTERVAL}), pinned
 * to it so the two cannot drift. The API cannot see the report interval of
 * workers in other processes, so this is what `/meta` reports and what a
 * busyness series' resolution is floored at.
 */
export const DEFAULT_BUSYNESS_INTERVAL_MS: number = DEFAULT_REPORT_INTERVAL;

/**
 * The grouped metrics reads. The routes use them only when a driver
 * implements **all four** — the contract suite treats them as one set — and
 * fall back to a read per entity otherwise.
 */
export const GROUPED_METRICS_METHODS = [
  "getRunnerMetricsTotals",
  "getRunnerMetricsMany",
  "getWorkerMetricsTotals",
  "getWorkerMetricsMany",
] as const;

/** Whether a driver answers the grouped reads: {@link GROUPED_METRICS_METHODS}. */
export function usesGroupedReads(driver: JobsDriver): boolean {
  return driverImplements(driver, GROUPED_METRICS_METHODS);
}

// Defined in `./meta`, where `DRIVER_FEATURES` is built from it; re-exported
// here, beside the routes it prunes.
export { ANALYTICS_METHODS };

/** Whether a driver serves analytics at all: {@link ANALYTICS_METHODS}. */
export function servesAnalytics(driver: JobsDriver): boolean {
  return driverImplements(driver, ANALYTICS_METHODS);
}

/**
 * `MetaDto.analytics`: what the driver serves, from its own
 * `getMetricsSupport()`, with the contract's caps and the busyness sample
 * interval. `null` when the driver serves no analytics.
 */
export function analyticsMetaOf(driver: JobsDriver): MetaAnalyticsDto | null {
  if (!servesAnalytics(driver)) {
    return null;
  }
  const support = driver.getMetricsSupport!();
  return {
    resolutions: [...support.resolutions],
    retentionMs: { ...support.retentionMs },
    maxSpanMs: MAX_ANALYTICS_SPAN_MS,
    maxBuckets: MAX_ANALYTICS_BUCKETS,
    maxSeries: MAX_ANALYTICS_SERIES,
    recording: { ...support.recording },
    busynessIntervalMs: DEFAULT_BUSYNESS_INTERVAL_MS,
  };
}

/* ------------------------------------------------------------------ *
 * The range
 * ------------------------------------------------------------------ */

/** A range query as validated: times as epoch ms or date-times, `to` exclusive. */
export interface RangeQueryInput {
  /** Start, inclusive. */
  from?: number | string;
  /** End, **exclusive**. */
  to?: number | string;
  /** The finest width wanted, in seconds. */
  resolution?: AnalyticsResolution;
}

/** The 400 for a range that cannot be asked for at all. */
function badRange(message: string, context: Record<string, unknown>): ApiError {
  return new ApiError("INVALID_ARGUMENT", 400, message, { context });
}

/**
 * A request's `from`/`to` as epoch ms, defaulted (`to` now, `from` an hour
 * before `to`) and checked: `to` after `from`, and the span between
 * `MIN_ANALYTICS_SPAN_MS` and `maxSpanMs` — else 400 `INVALID_ARGUMENT`. `to`
 * stays **exclusive**.
 *
 * `maxSpanMs` defaults to `MAX_ANALYTICS_SPAN_MS`; the added-by-state routes
 * pass `MAX_ADDED_BY_STATE_SPAN_MS`, their own cap (equal today, and named
 * apart because one bounds buckets kept and the other job rows counted).
 */
export function requestedRange(
  query: RangeQueryInput,
  now: number,
  maxSpanMs: number = MAX_ANALYTICS_SPAN_MS,
): { from: number; to: number } {
  const to = query.to === undefined ? now : toEpoch(query.to);
  const from =
    query.from === undefined
      ? to - DEFAULT_ANALYTICS_SPAN_MS
      : toEpoch(query.from);
  if (to <= from) {
    throw badRange("`to` must be later than `from`; `to` is exclusive", {
      from,
      to,
    });
  }
  const span = to - from;
  if (span > maxSpanMs) {
    throw badRange(
      `A range may span at most ${maxSpanMs} ms (asked for ${span})`,
      { from, to, maxSpanMs },
    );
  }
  if (span < MIN_ANALYTICS_SPAN_MS) {
    throw badRange(
      `A range must span at least ${MIN_ANALYTICS_SPAN_MS} ms (asked for ${span})`,
      { from, to, minSpanMs: MIN_ANALYTICS_SPAN_MS },
    );
  }
  return { from, to };
}

/**
 * Resolves a request's range against what the driver serves: the finest
 * resolution kept for the whole span within `MAX_ANALYTICS_BUCKETS`, never
 * finer than asked (or than `minIntervalMs`), and `from` clamped forward to
 * retention. A range **wholly** older than retention is 400
 * `RANGE_NOT_RETAINED` rather than a 200 with an empty series: the two would
 * be indistinguishable to a client, and only one of them is true. A range
 * partly retained is clamped, with `reason: "retention"`.
 */
export function resolveRange(
  query: RangeQueryInput,
  support: MetricsSupport,
  now: number,
  minIntervalMs?: number,
): ResolvedAnalyticsRange {
  const { from, to } = requestedRange(query, now);
  const resolved = resolveAnalyticsRange(
    {
      from,
      to,
      now,
      ...(query.resolution === undefined
        ? {}
        : { resolution: query.resolution }),
      ...(minIntervalMs === undefined ? {} : { minIntervalMs }),
    },
    support,
  );
  if (resolved.outOfRetention) {
    throw new ApiError(
      "RANGE_NOT_RETAINED",
      400,
      `The whole range is older than the backend keeps; the oldest instant kept at ${resolved.resolution} s is ${new Date(resolved.retainedFrom).toISOString()}`,
      {
        context: {
          retainedFrom: resolved.retainedFrom,
          resolution: resolved.resolution,
        },
      },
    );
  }
  return resolved;
}

/**
 * The response's view of a resolved range. `to` is the start of the **last**
 * bucket — `resolveAnalyticsRange` already turned the request's exclusive `to`
 * into it — and `end` the exclusive end.
 */
export function rangeDto(range: ResolvedAnalyticsRange): AnalyticsRangeDto {
  return {
    resolution: range.resolution,
    interval: range.interval,
    from: range.from,
    to: range.to,
    end: range.end,
    requested: {
      from: range.requested.from,
      to: range.requested.to,
      ...(range.requested.resolution === undefined
        ? {}
        : { resolution: range.requested.resolution }),
    },
    clamped: range.clamped,
    ...(range.reason === undefined ? {} : { reason: range.reason }),
  };
}

/** The driver query for a resolved range: bucket starts, both inclusive. */
function metricsQuery(range: ResolvedAnalyticsRange): MetricsQuery {
  return { from: range.from, to: range.to, interval: range.interval };
}

/* ------------------------------------------------------------------ *
 * Series
 * ------------------------------------------------------------------ */

/**
 * A counter series: the sparse rows merged by bucket (several writers' rows,
 * or several entities' when a roll-up is summed), filled to be contiguous —
 * `fillBuckets` checks the bucket cap *before* allocating — and totalled.
 */
function counterSeries<K extends string>(
  sparse: Iterable<Partial<Record<K, number>> & { at: number }>,
  range: ResolvedAnalyticsRange,
  keys: readonly K[],
): AnalyticsSeriesDto<{ at: number } & Record<K, number>, Record<K, number>> {
  const merged = mergeCounterBuckets(
    [...sparse] as CounterBucket<Record<K, number>>[],
    range,
    keys,
  );
  const buckets = fillBuckets(merged, range, range.interval, (at) => ({
    at,
    ...zeroCounters(keys),
  })).map((bucket) => {
    const exact = { at: bucket.at } as { at: number } & Record<K, number>;
    for (const key of keys) {
      (exact as Record<K, number>)[key] = bucket[key] ?? 0;
    }
    return exact;
  });
  return {
    range: rangeDto(range),
    buckets,
    totals: totalCounters(buckets, keys),
  };
}

/** A jobs series (queue, namespace or worker throughput). */
function jobsSeries(
  sparse: Iterable<CounterBucket<{ completed: number; failed: number }>>,
  range: ResolvedAnalyticsRange,
): AnalyticsSeriesDto<JobsBucketDto, JobsTotalsDto> {
  return counterSeries(sparse, range, JOB_COUNTERS);
}

/** A runner runs-by-outcome series. */
function runsSeries(
  sparse: Iterable<CounterBucket<RunnerRunsTotalsDto>>,
  range: ResolvedAnalyticsRange,
): AnalyticsSeriesDto<RunnerRunsBucketDto, RunnerRunsTotalsDto> {
  return counterSeries(sparse, range, RUNNER_RUN_COUNTERS);
}

/** Merged duration stats read without the histogram: what the totals carry. */
function durationSummary(stats: DurationStats): RunnerDurationTotalsDto {
  const { histogram: _histogram, ...totals } = readDurations(stats);
  return totals;
}

/** A duration summary without the histogram, over a set of rows. */
function durationTotals(
  rows: readonly RawDurationBucket[],
): RunnerDurationTotalsDto {
  const merged = emptyDurationStats();
  for (const row of rows) {
    mergeDurationStats(merged, row);
  }
  return durationSummary(merged);
}

/** A runner durations series. */
function durationsSeries(
  sparse: readonly RawDurationBucket[],
  range: ResolvedAnalyticsRange,
): AnalyticsSeriesDto<RunnerDurationBucketDto, RunnerDurationTotalsDto> {
  const raw = fillBuckets(
    mergeDurationBuckets([...sparse], range),
    range,
    range.interval,
    emptyDurationBucket,
  );
  return {
    range: rangeDto(range),
    buckets: raw.map((bucket) => ({ at: bucket.at, ...readDurations(bucket) })),
    totals: durationTotals(raw),
  };
}

/** Busyness over a set of rows, read. */
function busynessTotals(
  rows: readonly RawBusynessBucket[],
): WorkerBusynessTotalsDto {
  const merged = emptyBusynessStats();
  for (const row of rows) {
    mergeBusynessStats(merged, row);
  }
  return readBusyness(merged);
}

/** A worker busyness series, at its own (coarser) range. */
function busynessSeries(
  sparse: readonly RawBusynessBucket[],
  range: ResolvedAnalyticsRange,
): AnalyticsSeriesDto<WorkerBusynessBucketDto, WorkerBusynessTotalsDto> {
  const raw = fillBuckets(
    mergeBusynessBuckets([...sparse], range),
    range,
    range.interval,
    emptyBusynessBucket,
  );
  return {
    range: rangeDto(range),
    buckets: raw.map((bucket) => ({ at: bucket.at, ...readBusyness(bucket) })),
    totals: busynessTotals(raw),
  };
}

/* ------------------------------------------------------------------ *
 * Entities
 * ------------------------------------------------------------------ */

/** The 400 for an explicit batch over `MAX_ANALYTICS_SERIES`; de-duplicates in order otherwise. */
function batchOf(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  if (values.length > MAX_ANALYTICS_SERIES) {
    throw new ApiError(
      "BULK_LIMIT",
      400,
      `At most ${MAX_ANALYTICS_SERIES} series may be asked for at once`,
      { context: { max: MAX_ANALYTICS_SERIES } },
    );
  }
  return [...new Set(values)];
}

/** Rows capped at `MAX_ANALYTICS_ROWS`, with the list's length and whether it was cut. */
function capRows<T>(sorted: T[]): {
  rows: T[];
  truncated: boolean;
  totalRows: number;
} {
  return {
    rows: sorted.slice(0, MAX_ANALYTICS_ROWS),
    truncated: sorted.length > MAX_ANALYTICS_ROWS,
    totalRows: sorted.length,
  };
}

/**
 * Whether the caller sees the whole namespace's queues — every queue the
 * backend has, and no `authorize` filter — so the namespace roll-up is exactly
 * what they may see. Otherwise it would include queues they may not, and a
 * series is summed from the visible ones instead.
 */
function seesEveryQueue(config: ResolvedJobsApiConfig): boolean {
  return config.queues === "all" && config.listQueues !== "authorized";
}

/**
 * Whether the runners reachable are the namespace's — a manager, which reaches
 * every runner in it — rather than a fixed list, whose roll-up would include
 * runners outside the list.
 */
function seesEveryRunner(config: ResolvedJobsApiConfig): boolean {
  return config.runners !== false && !Array.isArray(config.runners);
}

/** The queues a caller may see, in the order the backend lists them. */
async function visibleQueues(
  services: RouteServices,
  req: BunRequest,
): Promise<string[]> {
  return await visibleQueueNames(services, req, await services.queues.names());
}

/**
 * The namespace jobs series over `range`: the roll-up (one read) when the
 * caller sees every queue, else the sum of `names`' own series (a read each,
 * at most `FAN_OUT` at a time).
 */
export async function namespaceJobsSeries(
  services: RouteServices,
  range: ResolvedAnalyticsRange,
  names: () => Promise<readonly string[]>,
): Promise<AnalyticsSeriesDto<JobsBucketDto, JobsTotalsDto>> {
  const { config } = services;
  const driver = config.driver;
  const query = metricsQuery(range);
  if (seesEveryQueue(config)) {
    const read = await driver.getNamespaceMetrics!(config.namespace, {
      ...query,
      kinds: ["jobs"],
    });
    return jobsSeries(read.jobs ?? [], range);
  }
  const reads = await mapBounded(await names(), async (queue) => {
    return await driver.getQueueMetrics!(
      { ns: config.namespace, queue },
      query,
    );
  });
  return jobsSeries(reads.flat(), range);
}

/** Whether this API serves runner analytics: it reaches runners, and the driver counts them. */
function servesRunnerAnalytics(config: ResolvedJobsApiConfig): boolean {
  return (
    config.runners !== false &&
    driverImplements(config.driver, DRIVER_FEATURES.runnerMetrics)
  );
}

/** Whether this API serves worker analytics: it has a jobs source, and the driver lists and counts workers. */
function servesWorkerAnalytics(config: ResolvedJobsApiConfig): boolean {
  return (
    config.jobs !== undefined &&
    supportsWorkers(config.driver) &&
    driverImplements(config.driver, DRIVER_FEATURES.workerMetrics)
  );
}

/**
 * `/overview`'s `analytics` block, or nothing when the driver serves none.
 *
 * The jobs series always; the runners and workers sections only on the
 * grouped path ({@link usesGroupedReads}) — there each costs a fixed number
 * of metrics reads whatever the fleet (plus a lock read per runner row
 * returned), where the per-entity path would cost a read per runner and per
 * worker key on every poll.
 */
export async function overviewAnalytics(
  services: RouteServices,
  req: BunRequest,
  query: RangeQueryInput,
  names: readonly string[],
  /**
   * The request's worker list, shared with the overview's `workers` count so
   * one request reads it once. Defaults to `jobs.listWorkers()`.
   */
  listWorkers?: () => Promise<WorkerInfo[]>,
): Promise<{ analytics?: OverviewAnalyticsDto }> {
  const { config } = services;
  const { driver } = config;
  if (!servesAnalytics(driver)) {
    return {};
  }
  const support = driver.getMetricsSupport!();
  const range = resolveRange(query, support, Date.now());
  const grouped = usesGroupedReads(driver);
  const [jobs, runners, workers] = await Promise.all([
    namespaceJobsSeries(services, range, async () => names),
    grouped && servesRunnerAnalytics(config)
      ? groupedRunnersRollup(services, range, support.recording.durations)
      : undefined,
    grouped && servesWorkerAnalytics(config)
      ? groupedWorkersRollup(
          services,
          req,
          range,
          recordsBusyness(driver, support),
          listWorkers,
        )
      : undefined,
  ]);
  return {
    analytics: {
      range: rangeDto(range),
      jobs,
      ...(runners ? { runners: runners.body } : {}),
      ...(workers ? { workers: workers.body } : {}),
    },
  };
}

/** One runner's reads: its buckets and whether it is running. */
interface RunnerRead {
  /** The runner's id. */
  runner: string;
  /** Its runs by outcome, sparse. */
  runs: CounterBucket<RunnerRunsTotalsDto>[];
  /** Its durations, sparse, when recorded. */
  durations?: RawDurationBucket[];
  /** Runs in flight now. */
  runningNow: number;
}

/**
 * Runs in flight now: whether the runner's lock is held — **one** driver read
 * — and, when the runner is registered in this process, its own runs in
 * flight, which it holds in memory. At least this many: a `parallel` run in
 * another process holds no single-run lock to see.
 */
async function runningNowOf(
  services: RouteServices,
  runner: string,
  local: BunRunner<any, any> | undefined,
): Promise<number> {
  const { driver, namespace } = services.config;
  const lock = await driver.getLock(namespace, runnerKey(runner), Date.now());
  return Math.max(local?.activeRuns.size ?? 0, lock ? 1 : 0);
}

/** Reads one runner's series and running state. */
async function readRunner(
  services: RouteServices,
  runner: string,
  local: BunRunner<any, any> | undefined,
  range: ResolvedAnalyticsRange,
  durations: boolean,
): Promise<RunnerRead> {
  const { driver, namespace } = services.config;
  const [read, runningNow] = await Promise.all([
    driver.getRunnerMetrics!(namespace, runnerKey(runner), {
      ...metricsQuery(range),
      ...(durations ? { durations: true } : {}),
    }),
    runningNowOf(services, runner, local),
  ]);
  return {
    runner,
    runs: read.runs,
    ...(read.durations === undefined ? {} : { durations: read.durations }),
    runningNow,
  };
}

/** The runners a request reaches: ids in listing order, and the local ones by id. */
async function listedRunners(services: RouteServices): Promise<{
  listed: string[];
  local: Map<string, BunRunner<any, any>>;
}> {
  const { local, remote } = await services.runners.list();
  const byId = new Map(local.map((runner) => [runner.id, runner]));
  return { listed: [...byId.keys(), ...remote], local: byId };
}

/**
 * The runner id a stored key names — the inverse of `runnerKey` — or
 * `undefined` for a key that is not a runner's.
 */
function runnerIdOf(key: string): string | undefined {
  const prefix = runnerKey("");
  return key.startsWith(prefix) && key.length > prefix.length
    ? key.slice(prefix.length)
    : undefined;
}

/** Rows sorted as listed: started runs descending, then id. */
function byStartedThenId(
  a: { runner: string; totals: RunnerRunsTotalsDto },
  b: { runner: string; totals: RunnerRunsTotalsDto },
): number {
  return (
    b.totals.started - a.totals.started || a.runner.localeCompare(b.runner)
  );
}

/** The runners roll-up, and how to answer an `ids=` batch against it. */
interface RunnersRollup {
  /** The roll-up, without `seriesByRunner`. */
  body: RunnersAnalyticsDto;
  /** The batch's series, for the ids asked, in order; unreachable ones left out. */
  batch: (ids: readonly string[]) => Promise<RunnerAnalyticsSeriesDto[]>;
}

/**
 * The runners roll-up on the grouped path:
 *
 * - rows: **one** `getRunnerMetricsTotals`, plus a zero row for each listed
 *   runner the read leaves out (it has nothing in range) — every listed
 *   runner has a row, as on the per-entity path. Through a manager, which
 *   reaches every runner in the namespace, the read is unfiltered, so **any
 *   key with counts in the range keeps its row** — including one the manager
 *   does not list — and the rows add up to the series; with a fixed list it
 *   is filtered to the list, and a runner outside it is never counted.
 *   Retiring a runner is *not* how that happens: nothing removes a runner's
 *   record, so `runners.remove()` unregisters it in its own process only and
 *   it stays listed and reachable. Counts outlive a registration; a
 *   registration does not end;
 * - series: the namespace roll-up (one read) through a manager; with a fixed
 *   list, one `getRunnerMetricsMany` over the runners the totals found,
 *   summed (none when it found none);
 * - `runningNow`: a lock read per row **returned**; the envelope's figure adds
 *   the in-process runs of local runners beyond the cap, which cost nothing,
 *   and does not read a remote runner beyond it;
 * - batch: one `getRunnerMetricsMany` for the reachable ids.
 */
async function groupedRunnersRollup(
  services: RouteServices,
  range: ResolvedAnalyticsRange,
  durations: boolean,
): Promise<RunnersRollup> {
  const { config } = services;
  const { driver, namespace } = config;
  const query = metricsQuery(range);
  const { listed: registered, local } = await listedRunners(services);
  const idByKey = new Map(registered.map((id) => [runnerKey(id), id]));
  const everyRunner = seesEveryRunner(config);

  const totals: RunnerMetricsTotals[] = await driver.getRunnerMetricsTotals!(
    namespace,
    {
      ...query,
      ...(durations ? { durations: true } : {}),
      // Omitted means every runner the namespace counted for — registered or
      // not. A fixed list is the boundary of what this API reaches.
      ...(everyRunner ? {} : { runners: [...idByKey.keys()] }),
    },
  );
  const found = new Map<string, RunnerMetricsTotals>();
  for (const row of totals) {
    let id = idByKey.get(row.runner);
    if (id === undefined && everyRunner) {
      id = runnerIdOf(row.runner);
      if (id !== undefined) {
        // A key with counts that the manager did not list. Reachable from
        // here on, so the batch serves its series as well. Not produced by
        // retiring a runner: nothing removes a runner's record.
        idByKey.set(row.runner, id);
      }
    }
    if (id !== undefined) {
      found.set(id, row);
    }
  }
  const known = new Set(registered);
  const listed = [
    ...registered,
    ...[...found.keys()].filter((id) => !known.has(id)),
  ];

  const sorted = listed
    .map((runner) => {
      const row = found.get(runner);
      const summary =
        row?.durations && row.durations.count > 0
          ? durationSummary(row.durations)
          : undefined;
      return {
        runner,
        totals: totalCounters(row ? [row.runs] : [], RUNNER_RUN_COUNTERS),
        ...(summary ? { durations: summary } : {}),
      };
    })
    .sort(byStartedThenId);
  const capped = capRows(sorted);
  const running = await mapBounded(capped.rows, async (row) => {
    return await runningNowOf(services, row.runner, local.get(row.runner));
  });
  const rows: RunnerAnalyticsRowDto[] = capped.rows.map((row, index) => ({
    runner: row.runner,
    totals: row.totals,
    runningNow: running[index]!,
    ...(row.durations ? { durations: row.durations } : {}),
  }));
  const beyondCap = sorted
    .slice(MAX_ANALYTICS_ROWS)
    .reduce(
      (sum, row) => sum + (local.get(row.runner)?.activeRuns.size ?? 0),
      0,
    );

  let series: RunnersAnalyticsDto["series"];
  if (seesEveryRunner(config)) {
    const read = await driver.getNamespaceMetrics!(namespace, {
      ...query,
      kinds: ["runs"],
    });
    series = runsSeries(read.runs ?? [], range);
  } else {
    const keys = [...found.keys()].map(runnerKey);
    const reads =
      keys.length === 0
        ? []
        : await driver.getRunnerMetricsMany!(namespace, keys, query);
    series = runsSeries(
      reads.flatMap((read) => read.runs),
      range,
    );
  }

  return {
    body: {
      series,
      runningNow:
        rows.reduce((sum, row) => sum + row.runningNow, 0) + beyondCap,
      rows,
      truncated: capped.truncated,
      totalRows: capped.totalRows,
    },
    batch: async (ids) => {
      const reachable = ids.filter((id) => idByKey.has(runnerKey(id)));
      if (reachable.length === 0) {
        return [];
      }
      const reads = await driver.getRunnerMetricsMany!(
        namespace,
        reachable.map(runnerKey),
        query,
      );
      const byKey = new Map(reads.map((read) => [read.runner, read]));
      return reachable.map((runner) => ({
        runner,
        runs: runsSeries(byKey.get(runnerKey(runner))?.runs ?? [], range),
      }));
    },
  };
}

/**
 * The runners roll-up on the per-entity path: a read of every listed
 * runner's series and of its lock, the rows and a fixed list's series summed
 * from them, and the batch served from those same reads.
 */
async function perEntityRunnersRollup(
  services: RouteServices,
  range: ResolvedAnalyticsRange,
  durations: boolean,
): Promise<RunnersRollup> {
  const { config } = services;
  const { driver } = config;
  const { listed, local } = await listedRunners(services);

  const reads = await mapBounded(listed, async (runner) => {
    return await readRunner(
      services,
      runner,
      local.get(runner),
      range,
      durations,
    );
  });
  const byId = new Map(reads.map((read) => [read.runner, read]));

  const series = seesEveryRunner(config)
    ? runsSeries(
        (
          await driver.getNamespaceMetrics!(config.namespace, {
            ...metricsQuery(range),
            kinds: ["runs"],
          })
        ).runs ?? [],
        range,
      )
    : runsSeries(
        reads.flatMap((read) => read.runs),
        range,
      );

  const rows: RunnerAnalyticsRowDto[] = reads
    .map((read) => {
      const totals = totalCounters(read.runs, RUNNER_RUN_COUNTERS);
      const summary =
        read.durations === undefined
          ? undefined
          : durationTotals(read.durations);
      return {
        runner: read.runner,
        totals,
        runningNow: read.runningNow,
        ...(summary && summary.count > 0 ? { durations: summary } : {}),
      };
    })
    .sort(byStartedThenId);

  return {
    body: {
      series,
      runningNow: reads.reduce((sum, read) => sum + read.runningNow, 0),
      ...capRows(rows),
    },
    batch: async (ids) =>
      ids.flatMap((id): RunnerAnalyticsSeriesDto[] => {
        const read = byId.get(id);
        return read ? [{ runner: id, runs: runsSeries(read.runs, range) }] : [];
      }),
  };
}

/** A worker key on a queue: the identity a worker's series is keyed by. */
type WorkerIdentity = WorkerMetricsRef;

/** Identities sorted by queue, then key. */
function byQueueThenKey(a: WorkerIdentity, b: WorkerIdentity): number {
  return a.queue.localeCompare(b.queue) || a.key.localeCompare(b.key);
}

/**
 * The (queue, key) pairs of the live workers on `allowed` queues, once each,
 * sorted by queue then key. The key is the one the recording writes under:
 * the stable key, or the id when the record has none (an older worker) or
 * an empty one.
 */
function liveWorkerKeys(
  workers: readonly WorkerInfo[],
  allowed: ReadonlySet<string>,
): WorkerIdentity[] {
  const seen = new Map<string, WorkerIdentity>();
  for (const worker of workers) {
    if (!allowed.has(worker.queue)) {
      continue;
    }
    const key = worker.key || worker.id;
    seen.set(workerMetricsEntity(worker.queue, key), {
      queue: worker.queue,
      key,
    });
  }
  return [...seen.values()].sort(byQueueThenKey);
}

/**
 * The (queue, key) pairs of the live workers a caller may see — the listing
 * `GET /workers` makes, by the same rules — once each, sorted by queue then
 * key.
 */
async function visibleWorkerKeys(
  services: RouteServices,
  req: BunRequest,
): Promise<WorkerIdentity[]> {
  const workers: WorkerInfo[] = await services.config.jobs!.listWorkers();
  // Re-read when a worker's queue is newer than the cached list, as
  // `GET /workers` does.
  const reachable = await services.queues.confirm(
    workers.map((worker) => worker.queue),
  );
  const consumed = [...reachable].sort();
  const allowed = new Set(await visibleQueueNames(services, req, consumed));
  return liveWorkerKeys(workers, allowed);
}

/** One worker key's reads over a range. */
interface WorkerRead extends WorkerIdentity {
  /** Jobs it finished, sparse. */
  jobs: CounterBucket<WorkerJobsTotalsDto>[];
  /** Its busyness, sparse, when recorded. */
  busyness?: RawBusynessBucket[];
}

/** Whether the driver records busyness at all, and this deployment records workers. */
function recordsBusyness(driver: JobsDriver, support: MetricsSupport): boolean {
  return (
    support.recording.workers &&
    driverImplements(driver, ["sampleWorkerBusyness"])
  );
}

/** Compares two rows' `completed`, then their keys: the order rows are listed in. */
function byCompletedThenKey(
  a: WorkerAnalyticsRowDto,
  b: WorkerAnalyticsRowDto,
): number {
  return (
    b.totals.completed - a.totals.completed ||
    a.key.localeCompare(b.key) ||
    a.queue.localeCompare(b.queue)
  );
}

/**
 * The (queue, key) pairs a `keys=` batch names: every identity in `among`
 * carrying one of `keys`, in the order the keys were asked, each key's pairs
 * by queue.
 */
function expandKeys(
  keys: readonly string[],
  among: readonly WorkerIdentity[],
): WorkerIdentity[] {
  const sorted = [...among].sort(byQueueThenKey);
  return uniqueWorkerRefs(
    keys.flatMap((key) => sorted.filter((identity) => identity.key === key)),
  );
}

/** The workers roll-up, and how to answer a `keys=` batch against it. */
interface WorkersRollup {
  /** The roll-up, without `seriesByKey`. */
  body: WorkersAnalyticsDto;
  /** The batch's series, for the keys asked, in order; unknown keys left out. */
  batch: (keys: readonly string[]) => Promise<WorkerAnalyticsSeriesDto[]>;
}

/**
 * The workers roll-up on the grouped path:
 *
 * - rows: **one** `getWorkerMetricsTotals`, joined with the live
 *   `(queue, key)` listing — a zero row for a live worker with nothing in
 *   range, and **a row for a key no longer live that still has counts in
 *   range**: the rows answer "who did the work in this window", and a worker
 *   that has since stopped did some of it. A caller who sees every queue
 *   reads it unfiltered, so a queue that no longer exists (obliterated, or
 *   never listed because it never held a job) keeps its workers' rows and
 *   the rows add up to the series; a restricted caller's read is filtered to
 *   the queues it may see, and a hidden queue is never counted;
 * - series: the namespace roll-up (one read) when the caller sees every
 *   queue; otherwise one `getWorkerMetricsMany` over the keys the totals
 *   found, summed — so it counts stopped keys too, as the roll-up does;
 * - batch: one `getWorkerMetricsMany` for the pairs the keys name among the
 *   rows.
 */
async function groupedWorkersRollup(
  services: RouteServices,
  req: BunRequest,
  range: ResolvedAnalyticsRange,
  busyness: boolean,
  /** The worker list, when the caller already reads it; else `jobs.listWorkers()`. */
  listWorkers?: () => Promise<WorkerInfo[]>,
): Promise<WorkersRollup> {
  const { config } = services;
  const { driver, namespace } = config;
  const query = metricsQuery(range);
  const workers = await (listWorkers
    ? listWorkers()
    : config.jobs!.listWorkers());
  // Confirmed first, so a worker's queue newer than the cached list refreshes
  // it before the visible queues are read from it.
  await services.queues.confirm(workers.map((worker) => worker.queue));
  const queues = await visibleQueues(services, req);
  const allowed = new Set(queues);
  const live = liveWorkerKeys(workers, allowed);
  const everyQueue = seesEveryQueue(config);

  const totals: WorkerMetricsTotals[] = await driver.getWorkerMetricsTotals!(
    namespace,
    {
      ...query,
      ...(busyness ? { busyness: true } : {}),
      // Omitted means every queue, listed or not. Restricted, the filter is
      // the permission boundary.
      ...(everyQueue ? {} : { queues }),
    },
  );

  const idle = busyness ? readBusyness(emptyBusynessStats()) : undefined;
  const byEntity = new Map<string, WorkerAnalyticsRowDto>();
  for (const identity of live) {
    byEntity.set(workerMetricsEntity(identity.queue, identity.key), {
      key: identity.key,
      queue: identity.queue,
      totals: zeroCounters(JOB_COUNTERS),
      ...(idle ? { busyness: { ...idle } } : {}),
    });
  }
  const counted: WorkerIdentity[] = [];
  for (const row of totals) {
    if (!everyQueue && !allowed.has(row.queue)) {
      continue;
    }
    counted.push({ queue: row.queue, key: row.key });
    const stats = row.busyness ? readBusyness(row.busyness) : idle;
    byEntity.set(workerMetricsEntity(row.queue, row.key), {
      key: row.key,
      queue: row.queue,
      totals: totalCounters([row.jobs], JOB_COUNTERS),
      ...(stats ? { busyness: { ...stats } } : {}),
    });
  }
  const rows = [...byEntity.values()].sort(byCompletedThenKey);

  let series: WorkersAnalyticsDto["series"];
  if (seesEveryQueue(config)) {
    const read = await driver.getNamespaceMetrics!(namespace, {
      ...query,
      kinds: ["workerJobs"],
    });
    series = jobsSeries(read.workerJobs ?? [], range);
  } else {
    const reads =
      counted.length === 0
        ? []
        : await driver.getWorkerMetricsMany!(namespace, counted, query);
    series = jobsSeries(
      reads.flatMap((read) => read.jobs),
      range,
    );
  }

  const identities = rows.map((row) => ({ queue: row.queue, key: row.key }));
  return {
    body: { series, ...capRows(rows) },
    batch: async (keys) => {
      const refs = expandKeys(keys, identities);
      if (refs.length === 0) {
        return [];
      }
      const reads = await driver.getWorkerMetricsMany!(namespace, refs, query);
      const byRef = new Map(
        reads.map((read) => [workerMetricsEntity(read.queue, read.key), read]),
      );
      return refs.map((ref) => ({
        key: ref.key,
        queue: ref.queue,
        jobs: jobsSeries(
          byRef.get(workerMetricsEntity(ref.queue, ref.key))?.jobs ?? [],
          range,
        ),
      }));
    },
  };
}

/**
 * The workers roll-up on the per-entity path: a read of every live key's
 * series, the rows and a restricted series summed from them, and the batch
 * served from those same reads. Live keys only: there is no read that would
 * find a stopped one.
 */
async function perEntityWorkersRollup(
  services: RouteServices,
  req: BunRequest,
  range: ResolvedAnalyticsRange,
  busyness: boolean,
): Promise<WorkersRollup> {
  const { config } = services;
  const { driver } = config;
  const identities = await visibleWorkerKeys(services, req);

  const reads: WorkerRead[] = await mapBounded(identities, async (identity) => {
    const read = await driver.getWorkerMetrics!(
      { ns: config.namespace, queue: identity.queue },
      identity.key,
      {
        ...metricsQuery(range),
        ...(busyness ? { busyness: true } : {}),
      },
    );
    return {
      ...identity,
      jobs: read.jobs,
      ...(read.busyness === undefined ? {} : { busyness: read.busyness }),
    };
  });

  const series = seesEveryQueue(config)
    ? jobsSeries(
        (
          await driver.getNamespaceMetrics!(config.namespace, {
            ...metricsQuery(range),
            kinds: ["workerJobs"],
          })
        ).workerJobs ?? [],
        range,
      )
    : jobsSeries(
        reads.flatMap((read) => read.jobs),
        range,
      );

  const rows: WorkerAnalyticsRowDto[] = reads
    .map((read) => ({
      key: read.key,
      queue: read.queue,
      totals: totalCounters(read.jobs, JOB_COUNTERS),
      ...(read.busyness === undefined
        ? {}
        : { busyness: busynessTotals(read.busyness) }),
    }))
    .sort(byCompletedThenKey);

  return {
    body: { series, ...capRows(rows) },
    batch: async (keys) =>
      keys.flatMap((key): WorkerAnalyticsSeriesDto[] =>
        reads
          .filter((read) => read.key === key)
          .map((read) => ({
            key: read.key,
            queue: read.queue,
            jobs: jobsSeries(read.jobs, range),
          })),
      ),
  };
}

/* ------------------------------------------------------------------ *
 * The routes
 * ------------------------------------------------------------------ */

/** What every range description must say. */
const RANGE_NOTE =
  '**`to` is exclusive; the response\'s `range.to` is the start of the last bucket, and `range.end` the exclusive end** — an axis runs `range.from … range.end`, with the last bucket plotted at `range.to`. `resolution` is a hint and an upper bound on fineness: one resolution per series, the finest kept for the whole span within `maxBuckets`, and `range.clamped`/`range.reason` say when that is not what was asked. A range partly older than retention is clamped forward (`reason: "retention"`); one **wholly** older is 400 `RANGE_NOT_RETAINED`, because a 200 with an empty series would read as "nothing happened". Buckets are contiguous: an interval nothing happened in is present with zeros.';

/** Errors every range read can answer with. */
const RANGE_ERRORS = ["INVALID_ARGUMENT", "RANGE_NOT_RETAINED"] as const;

/** The analytics routes. */
export function analyticsRoutes(): AnyRouteDef[] {
  return [
    defineRoute({
      method: "GET",
      path: "/analytics/jobs",
      operationId: "getJobsAnalytics",
      action: "metrics.read",
      mode: "jobs",
      requires: ANALYTICS_METHODS,
      summary: "Job throughput across the namespace, over a range",
      description: `Jobs completed and attempts failed per bucket across every queue the caller may see. Read from the namespace roll-up — one read, whatever the queue count — unless the API is restricted (a \`queues\` list, or \`listQueues: "authorized"\`), where the roll-up would count queues the caller may not see and the visible queues are summed instead, a read each.\n\n${RANGE_NOTE}\n\nA backend that records no analytics has this route pruned, so it never answers 501.`,
      tags: ["Analytics"],
      query: analyticsRangeQuerySchema(),
      responses: { 200: JobsSeriesSchema },
      errors: RANGE_ERRORS,
      handler: async ({ req, query, services }) => {
        const range = resolveRange(
          query,
          services.config.driver.getMetricsSupport!(),
          Date.now(),
        );
        return {
          body: await namespaceJobsSeries(services, range, async () => {
            return await visibleQueues(services, req);
          }),
        };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/queues/:queue/analytics/jobs",
      operationId: "getQueueJobsAnalytics",
      action: "metrics.read",
      mode: "jobs",
      requires: ANALYTICS_METHODS,
      summary: "One queue's throughput, over a range",
      description: `Supersedes \`GET /queues/{queue}/throughput\`: the same counts, at the resolution the range resolves to rather than always a minute.\n\n${RANGE_NOTE}`,
      tags: ["Analytics"],
      params: QueueParams,
      query: analyticsRangeQuerySchema(),
      responses: { 200: JobsSeriesSchema },
      errors: ["INVALID_NAME", "QUEUE_NOT_FOUND", ...RANGE_ERRORS],
      target: ({ params }) => queueTarget(params.queue),
      handler: async ({ params, query, services }) => {
        const { driver, namespace } = services.config;
        const queue = await services.queues.get(params.queue);
        const range = resolveRange(
          query,
          driver.getMetricsSupport!(),
          Date.now(),
        );
        const sparse = await driver.getQueueMetrics!(
          { ns: namespace, queue: queue.name },
          metricsQuery(range),
        );
        return { body: jobsSeries(sparse, range) };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/analytics/runners",
      operationId: "getRunnersAnalytics",
      action: "metrics.read",
      mode: "runner",
      requires: DRIVER_FEATURES.runnerMetrics,
      summary:
        "Every runner's outcomes summed, a row per runner, and a batch of series",
      description: `\`series\` is every runner's outcomes summed — the namespace roll-up, one read, when the API reaches the namespace's runners through a manager; the listed runners summed when it was given a fixed list. \`rows\` holds a row per reachable runner — its totals over the range (zeros for one with nothing in it), \`runningNow\` from its lock, and its durations where recorded — and, through a manager on a backend with grouped reads, a row for each key with counts in the range that the manager does not list, so the rows add up to \`series\` (retiring a runner does not produce one: nothing removes a runner's record, so \`runners.remove()\` unregisters it in its own process only and it stays listed and reachable); at most ${MAX_ANALYTICS_ROWS}, sorted by started runs descending then by id; \`truncated\` says when there were more and \`totalRows\` how many.\n\n\`ids\` names up to ${MAX_ANALYTICS_SERIES} runners — the page on screen — whose own series come back in \`seriesByRunner\`, in the order asked; a reachable runner with nothing in range gets zeroed buckets. More than ${MAX_ANALYTICS_SERIES} is 400 \`BULK_LIMIT\`; an id this API cannot reach is left out.\n\n**What it costs.** On a backend with grouped reads (all four of \`getRunnerMetricsTotals\`, \`getRunnerMetricsMany\`, \`getWorkerMetricsTotals\`, \`getWorkerMetricsMany\`) the rows are **one** read of every runner's totals, a fixed list's series one more, and a batch **exactly one** read of its own, whatever the runner count. \`runningNow\` is state no bucket holds, so it is a lock read per row **returned** (at most ${MAX_ANALYTICS_ROWS}); the envelope's \`runningNow\` adds the in-process runs of runners beyond the cap and does not read a remote one beyond it. On a backend without them each runner costs a read of its series and one of its lock, and the batch is served from those same reads.\n\n${RANGE_NOTE}`,
      tags: ["Analytics"],
      query: runnersAnalyticsQuerySchema(),
      responses: { 200: RunnersAnalyticsSchema },
      errors: ["BULK_LIMIT", "INVALID_NAME", ...RANGE_ERRORS],
      handler: async ({ query, services }) => {
        const { driver } = services.config;
        const ids = batchOf(query.ids)?.map((id) => parseSegment(id, "runner"));
        const support = driver.getMetricsSupport!();
        const range = resolveRange(query, support, Date.now());
        const rollup = await (
          usesGroupedReads(driver)
            ? groupedRunnersRollup
            : perEntityRunnersRollup
        )(services, range, support.recording.durations);
        const body: RunnersAnalyticsDto = rollup.body;
        if (ids) {
          body.seriesByRunner = await rollup.batch(ids);
        }
        return { body };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/runners/:runner/analytics",
      operationId: "getRunnerAnalytics",
      action: "metrics.read",
      mode: "runner",
      requires: DRIVER_FEATURES.runnerMetrics,
      summary: "One runner's runs by outcome and its durations, over a range",
      description: `A run counts in \`runs.started\` in the bucket it started in, and in its outcome and \`durations\` in the bucket it **finished** in. \`durations\` is present where the backend records them (\`meta.analytics.recording.durations\`): \`minMs\`/\`maxMs\`/\`meanMs\` exact, \`p50Ms\`/\`p95Ms\` read off a 24-bin log histogram and always within a factor of 2, typically 20–30%. \`runningNow\` is read from the lock — an instant, not a figure about the range.\n\n${RANGE_NOTE}`,
      tags: ["Analytics"],
      params: RunnerParams,
      query: analyticsRangeQuerySchema(),
      responses: { 200: RunnerAnalyticsSchema },
      errors: ["INVALID_NAME", "RUNNER_NOT_FOUND", ...RANGE_ERRORS],
      target: ({ params }) => runnerTarget(params.runner),
      handler: async ({ params, query, services }) => {
        const resolved = await services.runners.resolve(params.runner);
        const { id } = resolved;
        const support = services.config.driver.getMetricsSupport!();
        const range = resolveRange(query, support, Date.now());
        const read = await readRunner(
          services,
          id,
          resolved.local ? resolved.runner : undefined,
          range,
          support.recording.durations,
        );
        return {
          body: {
            runner: id,
            runs: runsSeries(read.runs, range),
            runningNow: read.runningNow,
            ...(read.durations === undefined
              ? {}
              : { durations: durationsSeries(read.durations, range) }),
          },
        };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/analytics/workers",
      operationId: "getWorkersAnalytics",
      action: "metrics.read",
      mode: "jobs",
      needsJobsSource: true,
      enabledWhen: (config) => supportsWorkers(config.driver),
      requires: DRIVER_FEATURES.workerMetrics,
      summary:
        "Every worker's throughput summed, a row per worker key, and a batch of series",
      description: `Keyed by the worker's **stable key**, never its per-incarnation id, so a rolling redeploy keeps one row. \`series\` is every worker's throughput summed — the namespace roll-up, one read, unless the API is restricted to some queues, where the visible workers are summed instead. \`rows\` holds a row per (queue, key) the caller may see, at most ${MAX_ANALYTICS_ROWS}, sorted by \`completed\` descending then by key; \`truncated\` says when there were more and \`totalRows\` how many.\n\n\`keys\` names up to ${MAX_ANALYTICS_SERIES} keys — the page on screen — whose own series come back in \`seriesByKey\`, a key on two queues twice; a listed key with nothing in range gets zeroed buckets. More than ${MAX_ANALYTICS_SERIES} is 400 \`BULK_LIMIT\`; a key no row carries is left out.\n\n**Two paths.** On a backend with grouped reads (all four of \`getRunnerMetricsTotals\`, \`getRunnerMetricsMany\`, \`getWorkerMetricsTotals\`, \`getWorkerMetricsMany\`) the rows are **one** read of every visible queue's worker totals, joined with the live workers — the listing \`GET /workers\` makes — so a live worker with nothing in range has a zero row, **and a key no longer live that still has counts in range keeps its row**: the rows answer "who did the work in this window", and a worker that has since stopped did some of it. A caller who sees every queue gets rows on queues that no longer exist too, so the rows add up to \`series\`; a caller restricted by \`queues\` or \`listQueues: "authorized"\` gets only the queues it may see. A restricted series is one more read, and a batch **exactly one** read of its own, whatever the worker count. On a backend without them the rows are the live workers only, each a read of its series, and the batch is served from those same reads.\n\n${RANGE_NOTE}`,
      tags: ["Analytics"],
      query: workersAnalyticsQuerySchema(),
      responses: { 200: WorkersAnalyticsSchema },
      errors: ["BULK_LIMIT", ...RANGE_ERRORS],
      handler: async ({ req, query, services }) => {
        const { driver } = services.config;
        const keys = batchOf(query.keys);
        const support = driver.getMetricsSupport!();
        const range = resolveRange(query, support, Date.now());
        const rollup = await (
          usesGroupedReads(driver)
            ? groupedWorkersRollup
            : perEntityWorkersRollup
        )(services, req, range, recordsBusyness(driver, support));
        const body: WorkersAnalyticsDto = rollup.body;
        if (keys) {
          body.seriesByKey = await rollup.batch(keys);
        }
        return { body };
      },
    }),
    defineRoute({
      method: "GET",
      path: "/queues/:queue/analytics/workers/:key",
      operationId: "getWorkerAnalytics",
      action: "metrics.read",
      mode: "jobs",
      enabledWhen: (config) => supportsWorkers(config.driver),
      requires: DRIVER_FEATURES.workerMetrics,
      summary: "One worker key's throughput and busyness, over a range",
      description: `By the worker's **stable key**, so it answers across restarts; a key nothing was counted for reads as zeros, not 404 — a worker that has since stopped still has its history.\n\n**Two ranges, not one.** \`jobs\` is counted and resolves like any series; \`busyness\` is *sampled* on the worker's heartbeat (\`meta.analytics.busynessIntervalMs\`), so it is never served finer than that and carries its own \`range\` — typically coarser than \`jobs.range\`. A busyness bucket with \`samples: 0\` means the worker was not reporting, not that it was idle. \`busyness\` is absent where the backend records none.\n\n${RANGE_NOTE}`,
      tags: ["Analytics"],
      params: WorkerConfigParams,
      query: analyticsRangeQuerySchema(),
      responses: { 200: WorkerAnalyticsSchema },
      errors: ["INVALID_NAME", "QUEUE_NOT_FOUND", ...RANGE_ERRORS],
      target: ({ params }) => workerKeyTarget(params.queue, params.key),
      handler: async ({ params, query, services }) => {
        const { driver, namespace } = services.config;
        const queue = await services.queues.get(params.queue);
        const key = parseSegment(params.key, "worker key");
        const support = driver.getMetricsSupport!();
        const now = Date.now();
        const range = resolveRange(query, support, now);
        const ref = { ns: namespace, queue: queue.name };

        if (!recordsBusyness(driver, support)) {
          const read = await driver.getWorkerMetrics!(
            ref,
            key,
            metricsQuery(range),
          );
          return {
            body: {
              key,
              queue: queue.name,
              jobs: jobsSeries(read.jobs, range),
            },
          };
        }

        const busyRange = resolveRange(
          query,
          support,
          now,
          DEFAULT_BUSYNESS_INTERVAL_MS,
        );
        // One read when both series resolve to the same buckets; two when
        // busyness is coarser, which is the usual case.
        const sameBuckets =
          busyRange.interval === range.interval &&
          busyRange.from === range.from &&
          busyRange.to === range.to;
        const [jobsRead, busyRead] = sameBuckets
          ? await driver.getWorkerMetrics!(ref, key, {
              ...metricsQuery(range),
              busyness: true,
            }).then((read) => [read, read] as const)
          : await Promise.all([
              driver.getWorkerMetrics!(ref, key, metricsQuery(range)),
              driver.getWorkerMetrics!(ref, key, {
                ...metricsQuery(busyRange),
                busyness: true,
              }),
            ]);
        return {
          body: {
            key,
            queue: queue.name,
            jobs: jobsSeries(jobsRead.jobs, range),
            busyness: busynessSeries(busyRead.busyness ?? [], busyRange),
          },
        };
      },
    }),
  ];
}
