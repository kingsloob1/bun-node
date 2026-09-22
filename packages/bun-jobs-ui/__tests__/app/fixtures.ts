import type {
  AnalyticsRangeDto,
  AnalyticsSeriesDto,
  JobsBucketDto,
  JobsTotalsDto,
  MetaDto,
  Overview,
  Permissions,
  ProblemDto,
  QueueList,
  QueueThroughput,
  RunnersAnalyticsDto,
  WorkerList,
  WorkersAnalyticsDto,
} from "../../app/api/types";
import type { UiConfig } from "../../lib/shared/config.ts";
import {
  ANALYTICS_RESOLUTIONS,
  DEFAULT_SECOND_RETENTION_MS,
  JOBS_API_ACTIONS,
  JOBS_API_OPT_IN_ACTIONS,
  MAX_ANALYTICS_BUCKETS,
  MAX_ANALYTICS_SERIES,
  MAX_ANALYTICS_SPAN_MS,
  MINUTE_RETENTION_MS,
} from "../../app/api/contract";

/**
 * Response fixtures, recorded from a real `createJobsApi` over the memory
 * driver (namespace `shop`, one queue) and typed against the package's
 * contract types, so a shape change fails the typecheck.
 */

/** A resolved UI config, as `jobsUi()` would inject it. */
export function uiConfig(overrides: Partial<UiConfig> = {}): UiConfig {
  return {
    version: 1,
    title: "Shop jobs",
    basePath: "/jobs",
    assetsPath: "/jobs/assets",
    apiBase: "/jobs-api",
    csrfHeader: null,
    websocket: { path: "/jobs-api/ws", port: null },
    docs: {
      openapi: "/jobs-api/openapi.json",
      asyncapi: "/jobs-api/asyncapi.json",
    },
    sections: { manage: true, docs: true },
    theme: "system",
    ...overrides,
  };
}

/** `GET /meta` from the memory driver in mode `both`. */
export function metaFixture(overrides: Partial<MetaDto> = {}): MetaDto {
  return {
    namespace: "shop",
    mode: "both",
    readOnly: false,
    protocol: 1,
    driver: {
      name: "memory",
      capabilities: {
        blockingWait: true,
        events: "local",
        multiProcess: false,
        multiHost: false,
        // Off, to match `features.jobAttribution` below; the UI reads only
        // the feature, never this.
        jobAttribution: false,
      },
    },
    features: {
      logs: true,
      update: true,
      limits: true,
      flows: true,
      search: true,
      workers: true,
      workerControl: true,
      runnerLogs: true,
      runnerMetrics: true,
      workerMetrics: true,
      // False until bun-jobs records who ran a job; tests of the attribution
      // UI turn it on for themselves.
      jobAttribution: false,
      // False until bun-jobs serves the added-in-range counts and
      // `sort=createdAt`; tests of those turn it on for themselves.
      addedByState: false,
      // Served on every built-in backend (false only in `runner` mode).
      jobDefaults: true,
      jobDefaultsApply: true,
      throughput: true,
    },
    // A backend recording everything, with the shipped defaults: per-second
    // buckets kept five minutes, minute buckets a day.
    analytics: {
      resolutions: [...ANALYTICS_RESOLUTIONS],
      retentionMs: {
        1: DEFAULT_SECOND_RETENTION_MS,
        60: MINUTE_RETENTION_MS,
      },
      maxSpanMs: MAX_ANALYTICS_SPAN_MS,
      maxBuckets: MAX_ANALYTICS_BUCKETS,
      maxSeries: MAX_ANALYTICS_SERIES,
      recording: {
        resolution: "second",
        secondRetentionMs: DEFAULT_SECOND_RETENTION_MS,
        workers: true,
        runners: true,
        durations: true,
      },
      busynessIntervalMs: 10_000,
    },
    events: "local",
    publishing: null,
    websocket: {
      path: "/jobs-api/ws",
      heartbeatMs: 25000,
      maxSubscriptions: 50,
    },
    docs: {
      openapi: "/jobs-api/openapi.json",
      asyncapi: "/jobs-api/asyncapi.json",
    },
    csrf: { header: null, requireJson: true },
    limits: {
      defaultPageSize: 20,
      maxPageSize: 100,
      maxBulkIds: 1000,
      maxRetryAll: 10000,
      maxRetryAllIds: 1000,
      maxClean: 10000,
      maxApplyDefaults: 1000,
      defaultClean: 1000,
      maxLogPage: 500,
      maxHistory: 200,
      maxJobDataBytes: 1048576,
      maxQueues: 500,
    },
    addableNames: [],
    runnerTriggerArgs: false,
    ...overrides,
  };
}

/** `GET /meta/permissions` with every action granted except the opt-in ones (`JOBS_API_OPT_IN_ACTIONS`), which a host must list itself. */
export function permissionsFixture(
  overrides: Permissions["actions"] = {},
): Permissions {
  const actions: Permissions["actions"] = {};
  for (const action of JOBS_API_ACTIONS) {
    if (!JOBS_API_OPT_IN_ACTIONS.has(action)) {
      actions[action] = true;
    }
  }
  return { actions: { ...actions, ...overrides } };
}

/** `GET /overview`. */
export function overviewFixture(overrides: Partial<Overview> = {}): Overview {
  return {
    queues: 2,
    pausedQueues: 1,
    counts: {
      waiting: 1204,
      delayed: 3,
      active: 7,
      completed: 98231,
      failed: 12,
      dead: 2,
      "waiting-children": 0,
    },
    total: 99459,
    truncated: false,
    workers: 4,
    throughput: { minutes: 60, completed: 5120, failed: 9 },
    ...overrides,
  };
}

/** `GET /queues`. */
export function queueListFixture(
  overrides: Partial<QueueList> = {},
): QueueList {
  return {
    items: [
      {
        name: "emails",
        counts: {
          waiting: 1200,
          delayed: 3,
          active: 5,
          completed: 90000,
          failed: 10,
          dead: 2,
          "waiting-children": 0,
        },
        total: 91220,
        paused: false,
      },
      {
        name: "reports",
        counts: {
          waiting: 4,
          delayed: 0,
          active: 2,
          completed: 8231,
          failed: 2,
          dead: 0,
          "waiting-children": 0,
        },
        total: 8239,
        paused: true,
      },
    ],
    truncated: false,
    page: { offset: 0, limit: 500, total: 2, hasMore: false },
    ...overrides,
  };
}

/** `GET /queues/:queue/throughput?minutes=3`. */
export function throughputFixture(
  overrides: Partial<QueueThroughput> = {},
): QueueThroughput {
  return {
    interval: 60000,
    from: 1789730400000,
    to: 1789730520000,
    buckets: [
      { at: 1789730400000, completed: 10, failed: 0 },
      { at: 1789730460000, completed: 25, failed: 1 },
      { at: 1789730520000, completed: 7, failed: 0 },
    ],
    completed: 42,
    failed: 1,
    ...overrides,
  };
}

/** `GET /workers`. */
export const workersFixture: WorkerList = { items: [] };

/** A problem body, as the API sends it. */
export function problem(
  status: number,
  code: string,
  title: string,
  extra: Partial<ProblemDto> = {},
): ProblemDto {
  return {
    type: `urn:bun-jobs:error:${code}`,
    title,
    status,
    code,
    ...extra,
  };
}

/* ------------------------------------------------------------------ *
 * Analytics
 * ------------------------------------------------------------------ */

/** The instant every analytics fixture is anchored on, so a bucket's `at` is stable. */
export const ANALYTICS_NOW = 1_789_730_400_000;

/**
 * An {@link AnalyticsRangeDto} covering `buckets` intervals of `resolution`
 * seconds ending at {@link ANALYTICS_NOW}.
 *
 * `to` is the start of the **last** bucket and `end` its exclusive end, as
 * the contract defines them — not the request's exclusive `to`.
 */
export function rangeFixture(
  overrides: Partial<AnalyticsRangeDto> = {},
  buckets = 3,
): AnalyticsRangeDto {
  const resolution = overrides.resolution ?? 60;
  const interval = resolution * 1_000;
  const from = ANALYTICS_NOW - (buckets - 1) * interval;
  return {
    resolution,
    interval,
    from,
    to: ANALYTICS_NOW,
    end: ANALYTICS_NOW + interval,
    requested: { from, to: ANALYTICS_NOW + interval },
    clamped: false,
    ...overrides,
  };
}

/** A clamped range: the ten-minute preset answered at minute buckets. */
export function clampedRangeFixture(
  reason: NonNullable<AnalyticsRangeDto["reason"]> = "retention",
): AnalyticsRangeDto {
  return rangeFixture({
    clamped: true,
    reason,
    requested: {
      from: ANALYTICS_NOW - 600_000,
      to: ANALYTICS_NOW,
      resolution: 1,
    },
  });
}

/** `GET /analytics/jobs` (and `GET /queues/:queue/analytics/jobs`). */
export function jobsSeriesFixture(
  overrides: Partial<AnalyticsSeriesDto<JobsBucketDto, JobsTotalsDto>> = {},
): AnalyticsSeriesDto<JobsBucketDto, JobsTotalsDto> {
  const range = overrides.range ?? rangeFixture();
  return {
    range,
    buckets: [
      { at: range.from, completed: 10, failed: 0 },
      { at: range.from + range.interval, completed: 25, failed: 1 },
      { at: range.to, completed: 7, failed: 0 },
    ],
    totals: { completed: 42, failed: 1 },
    ...overrides,
  };
}

/** Three runner buckets summing to the totals below. */
function runnerBuckets(range: AnalyticsRangeDto) {
  return [range.from, range.from + range.interval, range.to].map((at, i) => ({
    at,
    started: [2, 3, 1][i]!,
    succeeded: [2, 2, 1][i]!,
    failed: [0, 1, 0][i]!,
    timeout: 0,
    killed: 0,
    skipped: 0,
  }));
}

/**
 * `GET /analytics/runners`. `runners` names the rows; `ids` (the batch) adds
 * one series per named runner, exactly as the route would.
 */
export function runnersAnalyticsFixture(
  runners: readonly string[] = ["nightly", "hourly"],
  options: {
    ids?: readonly string[];
    truncated?: boolean;
    /** How many runners the range holds, `truncated` or not. Defaults to the rows returned. */
    totalRows?: number;
  } = {},
): RunnersAnalyticsDto {
  const range = rangeFixture();
  const series = {
    range,
    buckets: runnerBuckets(range),
    totals: {
      started: 6,
      succeeded: 5,
      failed: 1,
      timeout: 0,
      killed: 0,
      skipped: 0,
    },
  };
  return {
    series,
    runningNow: 1,
    rows: runners.map((runner) => ({
      runner,
      totals: {
        started: 6,
        succeeded: 5,
        failed: 1,
        timeout: 0,
        killed: 0,
        skipped: 0,
      },
      runningNow: 0,
    })),
    truncated: options.truncated ?? false,
    totalRows: options.totalRows ?? runners.length,
    ...(options.ids && options.ids.length > 0
      ? {
          seriesByRunner: options.ids.map((runner) => ({
            runner,
            runs: {
              range,
              buckets: runnerBuckets(range),
              totals: series.totals,
            },
          })),
        }
      : {}),
  };
}

/** Three worker buckets summing to the totals below. */
function workerBuckets(range: AnalyticsRangeDto) {
  return [range.from, range.from + range.interval, range.to].map((at, i) => ({
    at,
    completed: [4, 6, 2][i]!,
    failed: [0, 1, 0][i]!,
  }));
}

/**
 * `GET /analytics/workers`. `keys` names the rows (**stable keys**, never
 * incarnation ids); `options.keys` (the batch) adds one series per named key.
 */
export function workersAnalyticsFixture(
  keys: readonly string[] = ["emails-1", "reports-1"],
  options: {
    keys?: readonly string[];
    truncated?: boolean;
    /** How many worker keys the range holds, `truncated` or not. Defaults to the rows returned. */
    totalRows?: number;
  } = {},
): WorkersAnalyticsDto {
  const range = rangeFixture();
  const series = {
    range,
    buckets: workerBuckets(range),
    totals: { completed: 12, failed: 1 },
  };
  return {
    series,
    rows: keys.map((key) => ({
      key,
      queue: key.split("-")[0] ?? "emails",
      totals: { completed: 12, failed: 1 },
      busyness: { samples: 6, activeMean: 1.5, activeMax: 3, concurrency: 4 },
    })),
    truncated: options.truncated ?? false,
    totalRows: options.totalRows ?? keys.length,
    ...(options.keys && options.keys.length > 0
      ? {
          seriesByKey: options.keys.map((key) => ({
            key,
            // The contract carries the queue beside the key: a key is unique
            // per queue, not namespace-wide.
            queue: key.split("-")[0] ?? "emails",
            jobs: {
              range,
              buckets: workerBuckets(range),
              totals: series.totals,
            },
          })),
        }
      : {}),
  };
}
