import type { TimeRange } from "../analytics/range";
import type { ApiClient, QueryParams } from "./client";
import type { AnalyticsResolution } from "./contract";
import type {
  AnalyticsRangeDto,
  AnalyticsSeriesDto,
  JobsBucketDto,
  JobsTotalsDto,
  RunnerAnalyticsDto,
  RunnerRunsBucketDto,
  RunnersAnalyticsDto,
  WorkerAnalyticsDto,
  WorkersAnalyticsDto,
} from "./types";
import { bucketSeconds, rangeBounds } from "../analytics/range";
import { segment } from "./client";
import {
  ANALYTICS_RESOLUTIONS,
  DEFAULT_ANALYTICS_RESOLUTION,
} from "./contract";
import { isApiError } from "./errors";

/**
 * The analytics routes: the namespace jobs series, one queue's, the runners
 * and workers roll-ups, and one runner's or one worker's detail.
 *
 * Every read sends `from`/`to`/`resolution` — never the deprecated `minutes`,
 * which stays only on the two shipped routes (`/overview`,
 * `/queues/:queue/throughput`). `resolution` is a **hint and an upper bound on
 * fineness**: the server answers with the resolution it could serve, in
 * `range.resolution`, and that — never what was asked — is what an axis is
 * labelled from.
 *
 * **The 200-worker rule.** A section reads one summed series and a page of
 * scalar rows from the roll-up, then one batch request for the sparklines of
 * the rows actually on screen. A namespace with 200 workers therefore costs
 * two requests, not 200; {@link MAX_ANALYTICS_SERIES} (also
 * `meta.analytics.maxSeries`) is both the batch cap and the page size, so a
 * page is always exactly one batch request.
 */

/* ------------------------------------------------------------------ *
 * Resolving a range into a request
 * ------------------------------------------------------------------ */

/** The query one analytics read sends: the contract's `AnalyticsRangeQuery`, resolved to instants. */
export interface AnalyticsRequest {
  /** Start of the range, epoch ms, **inclusive**. */
  from: number;
  /** End of the range, epoch ms, **exclusive** — a bucket starting exactly here is not in the response. */
  to: number;
  /** The finest bucket width wanted, in seconds. A hint: the response says what was served. */
  resolution: AnalyticsResolution;
}

/**
 * The resolution a range is **asked** for: what the range wants
 * ({@link bucketSeconds}), from the contract's `ANALYTICS_RESOLUTIONS`.
 *
 * Deliberately *not* pre-coarsened to `meta.analytics.resolutions`. Against
 * the real API that hid the one explanation the user needs: the file driver
 * keeps minutes only, and asked for a minute over "the last 60 seconds" it
 * answers unclamped — so the section drew two minute buckets under a
 * 60-second label and said nothing. Asked for the second the range wants, the
 * server answers with minutes **and** `clamped: true, reason: "driver"`,
 * which `RangeCaption` turns into a sentence. The server decides what
 * it serves; the request says what the range wanted.
 */
export function requestResolution(
  range: TimeRange,
  now = Date.now(),
): AnalyticsResolution {
  const wanted = bucketSeconds(range, now);
  return (
    ANALYTICS_RESOLUTIONS.find((candidate) => candidate === wanted) ??
    DEFAULT_ANALYTICS_RESOLUTION
  );
}

/**
 * The instants and resolution a range is read over, resolved against `now`.
 *
 * A rolling preset resolves afresh on every fetch, which is what keeps a live
 * view following the clock; a custom range resolves to the instants it was
 * given. This is called **inside** the query function, never to build a key —
 * see {@link analyticsKeys}.
 *
 * A preset starts at the **first whole bucket inside** its window, not at
 * `now − length`. The server clamps for retention by bucket, comparing the
 * bucket `from` falls in with the bucket `serverNow − retention` falls in; a
 * preset as long as the retention (the last 24 hours) sat on that line, so
 * whenever clock skew plus latency carried the server's instant across a
 * bucket boundary, the answer came back clamped and the section captioned a
 * range the user never shortened. Starting a bucket in tolerates a whole
 * bucket of skew, and costs only the partial bucket at the far end, which
 * the chart could not draw whole anyway. A custom range is sent as given.
 */
export function analyticsRequest(
  range: TimeRange,
  now = Date.now(),
): AnalyticsRequest {
  const { from, to } = rangeBounds(range, now);
  const resolution = requestResolution(range, now);
  if (range.kind === "custom") {
    return { from, to, resolution };
  }
  const interval = resolution * 1_000;
  return {
    from: Math.floor(from / interval) * interval + interval,
    to,
    resolution,
  };
}

/** An {@link AnalyticsRequest} as query parameters. Never sends `minutes`. */
export function analyticsQuery(request: AnalyticsRequest): QueryParams {
  return {
    from: request.from,
    to: request.to,
    resolution: request.resolution,
  };
}

/* ------------------------------------------------------------------ *
 * Query keys
 * ------------------------------------------------------------------ */

/**
 * A range as it appears in a query key.
 *
 * A **custom** range is keyed by its two instants, so two custom ranges never
 * share a cache entry. A **preset** is keyed by its length rather than by the
 * instants it happens to resolve to right now: a rolling window is one query
 * that refetches, and keying it by the resolved instants would mint a fresh
 * cache entry every bucket — at one-second buckets, sixty a minute, none of
 * which is ever read again. The resolution is part of the key either way, so
 * "the last 10 minutes at 1 s" and "at 60 s" are different entries.
 */
export type RangeKey =
  | {
      /** Discriminator. */
      kind: "preset";
      /** The rolling window's length, in seconds. */
      seconds: number;
      /** The resolution asked for, in seconds. */
      resolution: AnalyticsResolution;
    }
  | {
      /** Discriminator. */
      kind: "custom";
      /** Start, epoch ms, inclusive. */
      from: number;
      /** End, epoch ms, exclusive. */
      to: number;
      /** The resolution asked for, in seconds. */
      resolution: AnalyticsResolution;
    };

/** The key fragment identifying one range at one requested resolution. */
export function rangeKey(
  range: TimeRange,
  resolution: AnalyticsResolution,
): RangeKey {
  return range.kind === "preset"
    ? { kind: "preset", seconds: range.seconds, resolution }
    : { kind: "custom", from: range.from, to: range.to, resolution };
}

/**
 * TanStack Query keys of the analytics reads.
 *
 * Every key sits under the `analyticsAll` prefix, and every *kind* of read has
 * its own prefix above the range fragment, so an invalidation can target
 * exactly as much as it means to: `analyticsAll` for everything, `jobsAll` for
 * every jobs series whatever range it covers, `jobs(range, …)` for one. That
 * distinction is the one `queryKeys.overviewAll` vs `queryKeys.overview()`
 * exists for — invalidating the narrow key refreshes nothing when the screen
 * is showing a different range.
 */
export const analyticsKeys = {
  /** Everything read from an analytics route: what a broad invalidation targets. */
  all: ["analytics"] as const,
  /** Every namespace jobs series, whatever range. */
  jobsAll: ["analytics", "jobs"] as const,
  /** `GET /analytics/jobs`. */
  jobs: (key: RangeKey) => ["analytics", "jobs", key] as const,
  /** Every per-queue jobs series of one queue, whatever range. */
  queueJobsAll: (queue: string) =>
    ["analytics", "queue", queue, "jobs"] as const,
  /** `GET /queues/:queue/analytics/jobs`. */
  queueJobs: (queue: string, key: RangeKey) =>
    ["analytics", "queue", queue, "jobs", key] as const,
  /** Every runners roll-up, whatever range. */
  runnersAll: ["analytics", "runners"] as const,
  /** `GET /analytics/runners` (the roll-up and its rows; no `ids=`). */
  runners: (key: RangeKey) => ["analytics", "runners", "rollup", key] as const,
  /** `GET /analytics/runners?ids=…` for one visible page. */
  runnerSeries: (ids: readonly string[], key: RangeKey) =>
    ["analytics", "runners", "series", [...ids], key] as const,
  /** Everything about one runner's analytics, whatever range. */
  runnerAll: (runner: string) => ["analytics", "runner", runner] as const,
  /** `GET /runners/:runner/analytics`. */
  runner: (runner: string, key: RangeKey) =>
    ["analytics", "runner", runner, key] as const,
  /** Every workers roll-up, whatever range. */
  workersAll: ["analytics", "workers"] as const,
  /** `GET /analytics/workers` (the roll-up and its rows; no `keys=`). */
  workers: (key: RangeKey) => ["analytics", "workers", "rollup", key] as const,
  /** `GET /analytics/workers?keys=…` for one visible page. */
  workerSeries: (keys: readonly string[], key: RangeKey) =>
    ["analytics", "workers", "series", [...keys], key] as const,
  /** Everything about one worker key's analytics, whatever range. */
  workerAll: (queue: string, key: string) =>
    ["analytics", "worker", queue, key] as const,
  /** `GET /queues/:queue/analytics/workers/:key`. */
  worker: (queue: string, workerKey: string, key: RangeKey) =>
    ["analytics", "worker", queue, workerKey, key] as const,
};

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/** `GET /analytics/jobs`: the namespace's job throughput, from the roll-up buckets. */
export function getJobsAnalytics(
  api: ApiClient,
  request: AnalyticsRequest,
  signal?: AbortSignal,
): Promise<AnalyticsSeriesDto<JobsBucketDto, JobsTotalsDto>> {
  return api.request("GET", "/analytics/jobs", {
    query: analyticsQuery(request),
    signal,
  });
}

/** `GET /queues/:queue/analytics/jobs`: one queue's throughput (supersedes `/throughput`). */
export function getQueueJobsAnalytics(
  api: ApiClient,
  queue: string,
  request: AnalyticsRequest,
  signal?: AbortSignal,
): Promise<AnalyticsSeriesDto<JobsBucketDto, JobsTotalsDto>> {
  return api.request("GET", `/queues/${segment(queue)}/analytics/jobs`, {
    query: analyticsQuery(request),
    signal,
  });
}

/**
 * `GET /analytics/runners`: every runner's outcomes summed, plus a scalar row
 * per runner (at most `MAX_ANALYTICS_ROWS`, `truncated` beyond it).
 *
 * `ids` names the runners whose own series to return as well — the visible
 * page, and at most `meta.analytics.maxSeries`; an explicit over-ask is 400
 * `BULK_LIMIT`, not a truncation.
 */
export function getRunnersAnalytics(
  api: ApiClient,
  request: AnalyticsRequest,
  ids?: readonly string[],
  signal?: AbortSignal,
): Promise<RunnersAnalyticsDto> {
  return api.request("GET", "/analytics/runners", {
    query: {
      ...analyticsQuery(request),
      ids: ids && ids.length > 0 ? [...ids] : undefined,
    },
    signal,
  });
}

/** `GET /runners/:runner/analytics`: one runner's runs by outcome, and its durations. */
export function getRunnerAnalytics(
  api: ApiClient,
  runner: string,
  request: AnalyticsRequest,
  signal?: AbortSignal,
): Promise<RunnerAnalyticsDto> {
  return api.request("GET", `/runners/${segment(runner)}/analytics`, {
    query: analyticsQuery(request),
    signal,
  });
}

/**
 * `GET /analytics/workers`: every worker's throughput summed, plus a scalar
 * row per worker **key** (at most `MAX_ANALYTICS_ROWS`, `truncated` beyond
 * it).
 *
 * `keys` names the worker keys whose own series to return as well — the
 * visible page, and at most `meta.analytics.maxSeries`.
 */
export function getWorkersAnalytics(
  api: ApiClient,
  request: AnalyticsRequest,
  keys?: readonly string[],
  signal?: AbortSignal,
): Promise<WorkersAnalyticsDto> {
  return api.request("GET", "/analytics/workers", {
    query: {
      ...analyticsQuery(request),
      keys: keys && keys.length > 0 ? [...keys] : undefined,
    },
    signal,
  });
}

/** `GET /queues/:queue/analytics/workers/:key`: one worker key's throughput and busyness. */
export function getWorkerAnalytics(
  api: ApiClient,
  queue: string,
  workerKey: string,
  request: AnalyticsRequest,
  signal?: AbortSignal,
): Promise<WorkerAnalyticsDto> {
  return api.request(
    "GET",
    `/queues/${segment(queue)}/analytics/workers/${segment(workerKey)}`,
    { query: analyticsQuery(request), signal },
  );
}

/* ------------------------------------------------------------------ *
 * Reading a response's range
 * ------------------------------------------------------------------ */

/**
 * How the resolution a response was **served** at reads: "1-second buckets",
 * "1-minute buckets". Always taken from {@link AnalyticsRangeDto.resolution},
 * never from what the request asked for.
 */
export function describeResolution(range: AnalyticsRangeDto): string {
  return range.resolution === 1 ? "1-second buckets" : "1-minute buckets";
}

/**
 * How a range's axis reads in a sparkline's label: the resolution **served**,
 * and the instants covered.
 *
 * The axis runs from the first bucket's start (`from`) to the exclusive end
 * (`end`); the last bucket is plotted at `to`, which is the last bucket's
 * start and *not* the request's exclusive `to`.
 */
export function describeAxis(range: AnalyticsRangeDto): string {
  const format = (value: number) =>
    new Date(value).toLocaleTimeString(undefined, { timeStyle: "short" });
  return `${describeResolution(range)} from ${format(range.from)} to ${format(range.end)}`;
}

/**
 * The axis a series is plotted on: `from` is the first bucket's start, `to`
 * the **last** bucket's start (inclusive, not the request's exclusive `to`)
 * and `end` the exclusive end. So an axis runs `from … end` and the last
 * bucket sits at `to`. The single easiest thing here to get wrong.
 */
export function axisBounds(range: AnalyticsRangeDto): {
  /** Start of the axis: the first bucket's start, epoch ms. */
  start: number;
  /** End of the axis: `range.end`, the exclusive end of the covered time. */
  end: number;
  /** Start of the last bucket, epoch ms — where the final point is drawn. */
  lastBucket: number;
} {
  return { start: range.from, end: range.end, lastBucket: range.to };
}

/**
 * An in-flight series derived from a runs series:
 * `inFlight[i] = inFlight[i - 1] + started − succeeded − failed − timeout −
 * killed`, starting at zero.
 *
 * **Derived, and it must be labelled so.** A run that started before the range
 * finishes inside it and a run that starts near the end finishes outside, so
 * the line drifts across a range boundary. The honest instantaneous number is
 * the `runningNow` scalar, which is read from the locks.
 */
export function derivedInFlight(
  buckets: readonly RunnerRunsBucketDto[],
): number[] {
  let running = 0;
  return buckets.map((bucket) => {
    running = Math.max(
      0,
      running +
        bucket.started -
        bucket.succeeded -
        bucket.failed -
        bucket.timeout -
        bucket.killed,
    );
    return running;
  });
}

/**
 * Whether `error` is the API saying the **whole** range is older than it
 * keeps (400 `RANGE_NOT_RETAINED`). Not a failure to retry: the same range
 * fails the same way, and the UI explains it rather than raising an alarm.
 */
export function isRangeNotRetained(error: unknown): boolean {
  return isApiError(error) && error.code === "RANGE_NOT_RETAINED";
}
