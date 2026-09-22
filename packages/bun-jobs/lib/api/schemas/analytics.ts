import type { Schema } from "../schema/builder";
import {
  DURATION_HISTOGRAM_BOUNDS,
  MAX_ANALYTICS_ROWS,
  MAX_ANALYTICS_SERIES,
  MAX_DATE_MS,
} from "../contract/constants";
import { s } from "../schema/builder";
import { RunnerIdSchema } from "./runners";

/**
 * Schemas for the analytics routes: the range a request asks for, the range a
 * series was served over, the five bucket kinds, and the envelopes.
 *
 * Each mirrors its contract type in `contract/types.ts`, pinned by
 * `__tests__/api/api-contract.type-test.ts`.
 */

/** A count. */
const Count = s.integer({ minimum: 0 });

/** Epoch milliseconds. */
const Instant = s.integer();

/** A measured quantity that may be fractional: a mean, a quantile, a duration. */
const Measure = s.number({ minimum: 0 });

/**
 * What every description of the request's `to` says, because it is the single
 * easiest thing here to get wrong.
 */
const EXCLUSIVE_TO =
  "**Exclusive**: a bucket starting exactly here is not in the response. The response's `range.to` is *not* this instant — it is the start of the **last** bucket, and `range.end` is the exclusive end.";

/** A time a query gives: epoch milliseconds, or an RFC 3339 date-time. */
function timeInput(description: string): Schema<number | string> {
  return s.union(
    s.integer({
      minimum: 0,
      maximum: MAX_DATE_MS,
      description: `${description} As epoch ms.`,
    }),
    s.string({
      format: "date-time",
      description: `${description} As an RFC 3339 date-time.`,
    }),
  );
}

/**
 * The range properties every analytics route takes — and, beside their
 * deprecated `minutes`, the two routes that shipped before them. Mirrors
 * `AnalyticsRangeQuery`.
 */
export function rangeQueryProperties() {
  return {
    from: s.optional(
      timeInput(
        "Start of the range, **inclusive**. Defaults to `to` minus one hour.",
      ),
    ),
    to: s.optional(
      timeInput(`End of the range. ${EXCLUSIVE_TO} Defaults to now.`),
    ),
    resolution: s.optional(
      s.union(
        s.literal(1, {
          description:
            "One-second buckets, where the backend keeps them for the whole span.",
        }),
        s.literal(60, {
          description:
            "One-minute buckets. `resolution` is a **hint and an upper bound on fineness, never a demand**: the response is served at the finest width the backend keeps for the whole span within `maxBuckets`, which may be coarser, and `range.resolution` says what was served. Anything but 1 or 60 is 400 `VALIDATION`.",
        }),
      ),
    ),
  } as const;
}

/** `GET /analytics/jobs`, `GET /queues/{queue}/analytics/jobs` and the other single-series reads. */
export function analyticsRangeQuerySchema() {
  return s.query(s.object(rangeQueryProperties()));
}

/** `GET /analytics/runners`: the range, and the runners whose own series to return. */
export function runnersAnalyticsQuerySchema() {
  return s.query(
    s.object({
      ...rangeQueryProperties(),
      ids: s.optional(
        s.array(RunnerIdSchema, {
          description: `Runners whose own series to return as well, in \`seriesByRunner\` — the page on screen. Repeat the key or separate with commas. At most ${MAX_ANALYTICS_SERIES}; more is 400 \`BULK_LIMIT\`, not a truncation. An id this API cannot reach is left out.`,
        }),
      ),
    }),
  );
}

/** `GET /analytics/workers`: the range, and the worker keys whose own series to return. */
export function workersAnalyticsQuerySchema() {
  return s.query(
    s.object({
      ...rangeQueryProperties(),
      keys: s.optional(
        s.array(s.string({ minLength: 1 }), {
          description: `Stable worker keys whose own series to return as well, in \`seriesByKey\` — the page on screen. Repeat the key or separate with commas. At most ${MAX_ANALYTICS_SERIES}; more is 400 \`BULK_LIMIT\`, not a truncation. A key matches every queue the listing has it on; one no listed worker carries is left out.`,
        }),
      ),
    }),
  );
}

/** Mirrors `AnalyticsRangeRequestedDto`. */
const RangeRequestedSchema = s.object(
  {
    from: s.integer({
      description: "`from` as asked, or the default, epoch ms, inclusive.",
    }),
    to: s.integer({
      description:
        "`to` as asked, or the default (now), epoch ms, **exclusive**.",
    }),
    resolution: s.optional(s.union(s.literal(1), s.literal(60))),
  },
  { description: "What the request asked for, before any clamping." },
);

/** Mirrors `AnalyticsRangeDto`. */
export const AnalyticsRangeSchema = s.named(
  "AnalyticsRange",
  s.object(
    {
      resolution: s.union(s.literal(1), s.literal(60)),
      interval: s.integer({
        minimum: 1,
        description: "The served width in ms.",
      }),
      from: s.integer({
        description: "Start of the **first** bucket, epoch ms.",
      }),
      to: s.integer({
        description:
          "Start of the **last** bucket, epoch ms, inclusive — not the request's exclusive `to`.",
      }),
      end: s.integer({
        description:
          "`to + interval`: the exclusive end of the covered time. An axis runs `from … end`.",
      }),
      requested: RangeRequestedSchema,
      clamped: s.boolean({
        description:
          "Whether the served range or resolution differs from what was asked.",
      }),
      reason: s.optional(
        s.enum(["retention", "maxBuckets", "resolution", "driver"], {
          description:
            "Why, when `clamped`: `retention` (older than kept at the finer width), `maxBuckets` (too many buckets at it), `resolution` (the kind cannot be observed that finely), `driver` (the backend does not record it).",
        }),
      ),
    },
    {
      description:
        "What one series covers. `from` is the first bucket's start, `to` the **last** bucket's start and `end` the exclusive end; one resolution per series.",
    },
  ),
);

/** Mirrors `JobsBucketDto`. */
const JobsBucketSchema = s.named(
  "JobsBucket",
  s.object({ at: Instant, completed: Count, failed: Count }),
);

/** Mirrors `JobsTotalsDto`. */
const JobsTotalsSchema = s.named(
  "JobsTotals",
  s.object({ completed: Count, failed: Count }),
);

/** The six runner outcome counters, shared by the bucket and the totals. */
const runnerRunCounts = {
  started: Count,
  succeeded: Count,
  failed: Count,
  timeout: Count,
  killed: Count,
  skipped: Count,
} as const;

/** Mirrors `RunnerRunsBucketDto`. */
const RunnerRunsBucketSchema = s.named(
  "RunnerRunsBucket",
  s.object({ at: Instant, ...runnerRunCounts }),
);

/** Mirrors `RunnerRunsTotalsDto`. */
const RunnerRunsTotalsSchema = s.named(
  "RunnerRunsTotals",
  s.object(runnerRunCounts, {
    description:
      "`started` does not balance the rest: runs straddle the range's edges. The honest in-flight number is `runningNow`.",
  }),
);

/** The duration summary fields, shared by the bucket and the totals. */
const durationFields = {
  count: Count,
  minMs: Measure,
  maxMs: Measure,
  meanMs: Measure,
  p50Ms: s.optional(Measure),
  p95Ms: s.optional(Measure),
} as const;

/** Mirrors `RunnerDurationBucketDto`. */
const RunnerDurationBucketSchema = s.named(
  "RunnerDurationBucket",
  s.object(
    {
      at: Instant,
      ...durationFields,
      histogram: s.optional(
        s.array(Count, {
          minItems: DURATION_HISTOGRAM_BOUNDS.length + 1,
          maxItems: DURATION_HISTOGRAM_BOUNDS.length + 1,
        }),
      ),
    },
    {
      description:
        "Runs that **finished** in the bucket. `minMs`/`maxMs`/`meanMs` are exact; `p50Ms`/`p95Ms` come from a 24-bin log histogram (ratio 2) and are always within a factor of 2 of the truth, typically within 20–30%.",
    },
  ),
);

/** Mirrors `RunnerDurationTotalsDto`. */
const RunnerDurationTotalsSchema = s.named(
  "RunnerDurationTotals",
  s.object(durationFields),
);

/** Mirrors `WorkerJobsBucketDto`. */
const WorkerJobsBucketSchema = s.named(
  "WorkerJobsBucket",
  s.object({ at: Instant, completed: Count, failed: Count }),
);

/** Mirrors `WorkerJobsTotalsDto`. */
const WorkerJobsTotalsSchema = s.named(
  "WorkerJobsTotals",
  s.object({ completed: Count, failed: Count }),
);

/** The busyness fields, shared by the bucket and the totals. */
const busynessFields = {
  samples: Count,
  activeMean: Measure,
  activeMax: Count,
  concurrency: Count,
} as const;

/** Mirrors `WorkerBusynessBucketDto`. */
const WorkerBusynessBucketSchema = s.named(
  "WorkerBusynessBucket",
  s.object(
    { at: Instant, ...busynessFields },
    {
      description:
        "Sampled on the worker's heartbeat, not counted. `samples: 0` means the worker was not reporting, not that it was idle.",
    },
  ),
);

/** Mirrors `WorkerBusynessTotalsDto`. */
const WorkerBusynessTotalsSchema = s.named(
  "WorkerBusynessTotals",
  s.object(busynessFields),
);

/** One series of `bucket`s over one range, with their `totals`. Mirrors `AnalyticsSeriesDto`. */
function seriesSchema<B, T>(
  name: string,
  bucket: Schema<B>,
  totals: Schema<T>,
) {
  return s.named(
    name,
    s.object(
      {
        range: AnalyticsRangeSchema,
        buckets: s.array(bucket, {
          description: "One bucket per interval, oldest first, contiguous.",
        }),
        totals,
      },
      {
        description:
          "One series: what it covers, its contiguous buckets, and their sums.",
      },
    ),
  );
}

/** Mirrors `AnalyticsSeriesDto<JobsBucketDto, JobsTotalsDto>`. */
export const JobsSeriesSchema = seriesSchema(
  "JobsSeries",
  JobsBucketSchema,
  JobsTotalsSchema,
);

/** Mirrors `AnalyticsSeriesDto<RunnerRunsBucketDto, RunnerRunsTotalsDto>`. */
const RunnerRunsSeriesSchema = seriesSchema(
  "RunnerRunsSeries",
  RunnerRunsBucketSchema,
  RunnerRunsTotalsSchema,
);

/** Mirrors `AnalyticsSeriesDto<RunnerDurationBucketDto, RunnerDurationTotalsDto>`. */
const RunnerDurationSeriesSchema = seriesSchema(
  "RunnerDurationSeries",
  RunnerDurationBucketSchema,
  RunnerDurationTotalsSchema,
);

/** Mirrors `AnalyticsSeriesDto<WorkerJobsBucketDto, WorkerJobsTotalsDto>`. */
const WorkerJobsSeriesSchema = seriesSchema(
  "WorkerJobsSeries",
  WorkerJobsBucketSchema,
  WorkerJobsTotalsSchema,
);

/** Mirrors `AnalyticsSeriesDto<WorkerBusynessBucketDto, WorkerBusynessTotalsDto>`. */
const WorkerBusynessSeriesSchema = seriesSchema(
  "WorkerBusynessSeries",
  WorkerBusynessBucketSchema,
  WorkerBusynessTotalsSchema,
);

/** Runs in flight right now, as every runner envelope describes it. */
const RunningNow = s.integer({
  minimum: 0,
  description:
    "Runs in flight **right now**, from the locks: an instant, not a figure about the range. At least this many — a run in another process in `parallel` mode holds no single-run lock to see.",
});

/** Mirrors `RunnerAnalyticsRowDto`. */
const RunnerAnalyticsRowSchema = s.named(
  "RunnerAnalyticsRow",
  s.object({
    runner: s.string(),
    totals: RunnerRunsTotalsSchema,
    runningNow: RunningNow,
    durations: s.optional(RunnerDurationTotalsSchema),
  }),
);

/** Mirrors `WorkerAnalyticsRowDto`. */
const WorkerAnalyticsRowSchema = s.named(
  "WorkerAnalyticsRow",
  s.object({
    key: s.string({
      description: "The worker's stable key — never the per-incarnation id.",
    }),
    queue: s.string(),
    totals: WorkerJobsTotalsSchema,
    busyness: s.optional(WorkerBusynessTotalsSchema),
  }),
);

/** The rows cap and its counters, shared by both roll-ups. */
const rowCaps = {
  truncated: s.boolean({
    description: `Whether more rows matched than the ${MAX_ANALYTICS_ROWS} \`rows\` holds.`,
  }),
  totalRows: s.integer({
    minimum: 0,
    description:
      "How many rows matched before the cap: the list the route already held, never a second read.",
  }),
} as const;

/** The runner roll-up's properties: `OverviewRunnersAnalyticsDto`. */
const runnersRollup = {
  series: RunnerRunsSeriesSchema,
  runningNow: RunningNow,
  rows: s.array(RunnerAnalyticsRowSchema, {
    maxItems: MAX_ANALYTICS_ROWS,
    description: `A row per runner, at most ${MAX_ANALYTICS_ROWS}, sorted by started runs descending then by id.`,
  }),
  ...rowCaps,
} as const;

/** The worker roll-up's properties: `OverviewWorkersAnalyticsDto`. */
const workersRollup = {
  series: WorkerJobsSeriesSchema,
  rows: s.array(WorkerAnalyticsRowSchema, {
    maxItems: MAX_ANALYTICS_ROWS,
    description: `A row per worker key, at most ${MAX_ANALYTICS_ROWS}, sorted by \`completed\` descending then by key.`,
  }),
  ...rowCaps,
} as const;

/** Mirrors `RunnerAnalyticsSeriesDto`. */
const RunnerAnalyticsSeriesSchema = s.named(
  "RunnerAnalyticsSeries",
  s.object({ runner: s.string(), runs: RunnerRunsSeriesSchema }),
);

/** Mirrors `WorkerAnalyticsSeriesDto`. */
const WorkerAnalyticsSeriesSchema = s.named(
  "WorkerAnalyticsSeries",
  s.object({
    key: s.string(),
    queue: s.string(),
    jobs: WorkerJobsSeriesSchema,
  }),
);

/** `GET /analytics/runners`. Mirrors `RunnersAnalyticsDto`. */
export const RunnersAnalyticsSchema = s.named(
  "RunnersAnalytics",
  s.object({
    ...runnersRollup,
    seriesByRunner: s.optional(
      s.array(RunnerAnalyticsSeriesSchema, {
        maxItems: MAX_ANALYTICS_SERIES,
        description:
          "One series per runner named in `ids`, in the order asked; absent when `ids` named none.",
      }),
    ),
  }),
);

/** `GET /analytics/workers`. Mirrors `WorkersAnalyticsDto`. */
export const WorkersAnalyticsSchema = s.named(
  "WorkersAnalytics",
  s.object({
    ...workersRollup,
    seriesByKey: s.optional(
      s.array(WorkerAnalyticsSeriesSchema, {
        description:
          "One series per (queue, key) the keys in `keys` matched, in the order asked; absent when `keys` named none.",
      }),
    ),
  }),
);

/** `GET /runners/{runner}/analytics`. Mirrors `RunnerAnalyticsDto`. */
export const RunnerAnalyticsSchema = s.named(
  "RunnerAnalytics",
  s.object({
    runner: RunnerIdSchema,
    runs: RunnerRunsSeriesSchema,
    runningNow: RunningNow,
    durations: s.optional(RunnerDurationSeriesSchema),
  }),
);

/** `GET /queues/{queue}/analytics/workers/{key}`. Mirrors `WorkerAnalyticsDto`. */
export const WorkerAnalyticsSchema = s.named(
  "WorkerAnalytics",
  s.object({
    key: s.string(),
    queue: s.string(),
    jobs: WorkerJobsSeriesSchema,
    busyness: s.optional(WorkerBusynessSeriesSchema),
  }),
);

/** `GET /overview`'s `analytics`. Mirrors `OverviewAnalyticsDto`. */
export const OverviewAnalyticsSchema = s.named(
  "OverviewAnalytics",
  s.object(
    {
      range: AnalyticsRangeSchema,
      jobs: JobsSeriesSchema,
      runners: s.optional(
        s.named("OverviewRunnersAnalytics", s.object(runnersRollup)),
      ),
      workers: s.optional(
        s.named("OverviewWorkersAnalytics", s.object(workersRollup)),
      ),
    },
    {
      description:
        "The namespace's analytics over the requested range, from the roll-up buckets. `runners` and `workers` are the roll-ups `GET /analytics/runners` and `GET /analytics/workers` answer (without a batch), present only on a backend with the grouped reads, where each costs a fixed number of reads whatever the fleet (plus a lock read per runner row returned). Without them they are left out: each row would cost a read per runner and per worker key on every overview poll.",
    },
  ),
);
