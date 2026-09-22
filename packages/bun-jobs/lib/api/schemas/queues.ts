import type { Schema } from "../schema/builder";
import { DEFAULT_JOBS_API_LIMITS } from "../config";
import {
  JOB_DEFAULT_BACKOFF_TYPES,
  JOB_DEFAULT_KEYS,
  JOB_DEFAULTS_APPLY_STATES,
  JOB_DEFAULTS_BOUNDS,
  MAX_ADDED_BY_STATE_SPAN_MS,
  MAX_DATE_MS,
  MIN_ANALYTICS_SPAN_MS,
} from "../contract/constants";
import { s } from "../schema/builder";
import { OverviewAnalyticsSchema, rangeQueryProperties } from "./analytics";
import { PageInfoSchema } from "./common";
import { BackoffSchema, RetentionSchema } from "./jobs";

/**
 * Schemas for the queue routes: counts, summaries, limits and the queue-wide
 * operations.
 */

/** A count of jobs. */
const Count = s.integer({ minimum: 0 });

/** Jobs per state. Mirrors `Record<JobState, number>`. */
export const JobCountsSchema = s.named(
  "JobCounts",
  s.object({
    waiting: Count,
    delayed: Count,
    active: Count,
    completed: Count,
    failed: Count,
    dead: Count,
    "waiting-children": Count,
  }),
);

/** A queue at a glance. Mirrors `QueueSummaryDto`. */
export const QueueSummarySchema = s.named(
  "QueueSummary",
  s.object({
    name: s.string(),
    counts: JobCountsSchema,
    total: Count,
    paused: s.boolean(),
  }),
);

/** A rate as stored: the window in milliseconds. */
const StoredRateSchema = s.object({
  max: s.integer({ minimum: 1 }),
  duration: s.integer({ minimum: 1 }),
});

/** Limits as stored. Mirrors `StoredLimits`. */
export const StoredLimitsSchema = s.named(
  "QueueLimits",
  s.object({
    rate: s.optional(StoredRateSchema),
    concurrency: s.optional(s.integer({ minimum: 1 })),
    names: s.optional(
      s.record(
        s.object({
          rate: s.optional(StoredRateSchema),
          concurrency: s.optional(s.integer({ minimum: 1 })),
        }),
      ),
    ),
  }),
);

/** A rate as given: the window in milliseconds or as a duration such as `"1 minute"`. */
const RateInputSchema = s.object({
  max: s.integer({ minimum: 1 }),
  duration: s.union(
    s.integer({ minimum: 1 }),
    s.string({ minLength: 1, maxLength: 100 }),
  ),
});

/** Limits as `PUT` takes them. Mirrors `QueueLimits`. */
export const QueueLimitsInputSchema = s.object({
  rate: s.optional(RateInputSchema),
  concurrency: s.optional(s.integer({ minimum: 1 })),
  names: s.optional(
    s.record(
      s.object({
        rate: s.optional(RateInputSchema),
        concurrency: s.optional(s.integer({ minimum: 1 })),
      }),
    ),
  ),
});

/** One queue in detail: its summary, and its limits where the backend can store them. */
export const QueueDetailSchema = s.named(
  "QueueDetail",
  s.object({
    name: s.string(),
    counts: JobCountsSchema,
    total: Count,
    paused: s.boolean(),
    limits: s.optional(s.nullable(StoredLimitsSchema)),
  }),
);

/** One minute of throughput. Mirrors `ThroughputBucket`. */
export const ThroughputBucketSchema = s.named(
  "ThroughputBucket",
  s.object({ at: s.integer(), completed: Count, failed: Count }),
);

/** A queue's recent throughput. Mirrors `QueueThroughput`. */
export const ThroughputSchema = s.named(
  "QueueThroughput",
  s.object({
    interval: s.integer({ minimum: 1 }),
    from: s.integer(),
    to: s.integer(),
    buckets: s.array(ThroughputBucketSchema),
    completed: Count,
    failed: Count,
  }),
);

/** `GET /overview`. */
export const OverviewSchema = s.named(
  "Overview",
  s.object({
    queues: Count,
    pausedQueues: Count,
    counts: JobCountsSchema,
    total: Count,
    truncated: s.boolean({
      description:
        "Whether more queues exist than `limits.maxQueues` summarised.",
    }),
    workers: s.optional(
      s.integer({
        minimum: 0,
        description:
          "Live workers across every queue summarised. Absent when the backend keeps no worker records.",
      }),
    ),
    throughput: s.optional(
      s.object({
        minutes: s.integer({ minimum: 1 }),
        completed: Count,
        failed: Count,
      }),
    ),
    throughputSeries: s.optional(
      s.named(
        "OverviewThroughputSeries",
        s.object(
          {
            interval: s.integer({ minimum: 1 }),
            from: s.integer(),
            to: s.integer(),
            buckets: s.array(ThroughputBucketSchema),
            completed: Count,
            failed: Count,
          },
          {
            description:
              "Namespace-wide throughput, one bucket per minute, in the shape of a queue's: each minute summed over the queues summarised. Present exactly when `throughput` is.",
          },
        ),
      ),
    ),
    analytics: s.optional(OverviewAnalyticsSchema),
  }),
);

/**
 * `GET /overview/added` and `GET /queues/{queue}/counts/added`: of the jobs
 * added in a range, how many are in each state now. Mirrors `AddedByStateDto`.
 */
export const AddedByStateSchema = s.named(
  "AddedByState",
  s.object(
    {
      from: s.integer({
        description: "Start of the range read, **inclusive**, epoch ms.",
      }),
      to: s.integer({
        description: "End of the range read, **exclusive**, epoch ms.",
      }),
      at: s.integer({
        description:
          "When the counts were read, epoch ms: the instant every state is as of.",
      }),
      counts: JobCountsSchema,
      total: s.integer({
        minimum: 0,
        description:
          "The sum of `counts`: the jobs added in the range that are still stored.",
      }),
      queues: s.integer({
        minimum: 0,
        description:
          "Queues summed: on `GET /overview/added` every queue the caller may see; `1` on the per-queue route.",
      }),
    },
    {
      description:
        "Of the jobs **added** (by `createdAt`) during the range, how many are in each state **now**. Only jobs still stored are counted: one removed since, by retention or a remove, clean or drain, is not, so `total` can be less than what was added. Not the analytics series: that counts completions and failed attempts by **finish** time over every job; `failed` here is the state (failed, a retry pending) and `dead` the jobs that gave up.",
    },
  ),
);

/** One bound of an added-by-state range: epoch ms or an RFC 3339 date-time. */
function addedBound(description: string): Schema<number | string> {
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
 * `GET /overview/added` and `GET /queues/{queue}/counts/added` query: the
 * range, over `createdAt`. Mirrors `AddedByStateQuery`.
 */
export function addedByStateQuerySchema() {
  return s.query(
    s.object({
      from: s.optional(
        addedBound(
          "Start of the range over `createdAt`, **inclusive**. Defaults to `to` minus one hour.",
        ),
      ),
      to: s.optional(
        addedBound(
          `End of the range over \`createdAt\`, **exclusive**: a job created exactly here is not counted. Defaults to now. Not after \`from\`, a span over ${MAX_ADDED_BY_STATE_SPAN_MS} ms (a day) or under ${MIN_ANALYTICS_SPAN_MS} ms is 400 \`INVALID_ARGUMENT\`.`,
        ),
      ),
    }),
  );
}

/**
 * The worker schemas live in `./workers`, beside the routes that answer with
 * them, and are re-exported here because `GET /queues/{queue}/workers` is a
 * queue route in every other respect.
 */
export {
  WorkerConfigListSchema,
  WorkerConfigOverrideSchema,
  WorkerConfigSchema,
  WorkerControlSchema,
  WorkerListSchema,
  WorkerSchema,
  WorkerStateSchema,
} from "./workers";

/**
 * What a throughput or overview read covers: the deprecated `minutes`, or the
 * analytics range (`from`, `to` exclusive, `resolution`), which wins when
 * `from` or `to` is given.
 */
export function minutesQuerySchema(maxMinutes: number) {
  return s.query(
    s.object({
      minutes: s.optional(
        s.documented(
          s.integer({
            minimum: 1,
            maximum: maxMinutes,
            default: 60,
            description: `Deprecated: use \`from\`/\`to\`. Minutes back from the current one; at most ${maxMinutes}. Ignored when \`from\` or \`to\` is given.`,
          }),
          { deprecated: true },
        ),
      ),
      ...rangeQueryProperties(),
    }),
  );
}

/** `GET /queues`. */
export const QueueListSchema = s.object({
  items: s.array(QueueSummarySchema),
  truncated: s.boolean({
    description: "Whether more queues follow this page: `page.hasMore`.",
  }),
  page: PageInfoSchema,
});

/** `GET /queues` query, paged up to `limits.maxQueues` at a time. */
export function queueListQuerySchema(maxQueues: number) {
  return s.query(
    s.object({
      search: s.optional(
        s.string({
          maxLength: 200,
          description: "A substring of the queue name, ignoring case.",
        }),
      ),
      offset: s.optional(
        s.integer({
          minimum: 0,
          default: 0,
          description: "Matching queues skipped, in name order.",
        }),
      ),
      limit: s.optional(
        s.integer({
          minimum: 1,
          maximum: maxQueues,
          default: maxQueues,
          description: `Queues summarised; at most ${maxQueues} (\`limits.maxQueues\`).`,
        }),
      ),
    }),
  );
}

/**
 * `GET /queues` query with the default `limits.maxQueues`. Kept for callers
 * of the earlier export; the route builds its own from the configured cap.
 */
export const QueueListQuerySchema = queueListQuerySchema(
  DEFAULT_JOBS_API_LIMITS.maxQueues,
);

/** Whether a queue is paused, after pausing or resuming it. */
export const PausedSchema = s.object({ paused: s.boolean() });

/** `POST /queues/:queue/drain` body. */
export const DrainBodySchema = s.object({
  delayed: s.optional(
    s.boolean({
      default: false,
      description: "Also drop delayed jobs.",
    }),
  ),
});

/** How many jobs an operation touched. */
export const CountResultSchema = s.object({ count: Count });

/** The `limit` a clean uses when none is given, unless `maxClean` is lower. */
export const CLEAN_DEFAULT_LIMIT = 1000;

/**
 * The `limit` a clean uses when none is given: {@link CLEAN_DEFAULT_LIMIT},
 * or `maxClean` when that is lower. The body schema's default and `/meta`'s
 * `limits.defaultClean` both come from here.
 */
export function defaultCleanLimit(maxClean: number): number {
  return Math.min(CLEAN_DEFAULT_LIMIT, maxClean);
}

/** `POST /queues/:queue/clean` body, capped by `limits.maxClean`. */
export function cleanBodySchema(maxClean: number) {
  return s.object({
    state: s.enum([
      "completed",
      "failed",
      "dead",
      "waiting",
      "delayed",
      "waiting-children",
    ]),
    olderThan: s.integer({
      minimum: 0,
      description: "Only jobs older than this many milliseconds.",
    }),
    limit: s.optional(
      s.integer({
        minimum: 1,
        maximum: maxClean,
        default: defaultCleanLimit(maxClean),
      }),
    ),
  });
}

/** `POST /queues/:queue/clean` response. */
export const CleanResultSchema = s.object({
  count: Count,
  ids: s.array(s.string()),
});

/* ------------------------------------------------------------------ *
 * Queue job defaults
 * ------------------------------------------------------------------ */

/** A whole number inside one of `JOB_DEFAULTS_BOUNDS`, described with it. */
function bounded(
  bound: keyof typeof JOB_DEFAULTS_BOUNDS,
  description: string,
): Schema<number> {
  const { min, max } = JOB_DEFAULTS_BOUNDS[bound];
  return s.integer({
    minimum: min,
    maximum: max,
    description: `${description} ${min} … ${max}.`,
  });
}

/** Every editable option and its value, as a job would get it. Mirrors `JobDefaultsValues`. */
export const JobDefaultsValuesSchema = s.named(
  "JobDefaultsValues",
  s.object({
    attempts: s.integer({ minimum: 0 }),
    backoff: BackoffSchema,
    timeout: s.number({ minimum: 0 }),
    priority: s.number(),
    removeOnComplete: RetentionSchema,
    removeOnFail: RetentionSchema,
    keepLogs: s.integer({
      minimum: 0,
      description:
        "Log lines a job keeps; `0` (a code value only) keeps every line.",
    }),
    keepStacktraces: s.integer({ minimum: 0 }),
  }),
);

/** The stored override: the keys it sets. Mirrors `Partial<JobDefaultsValues>`. */
const JobDefaultsOverrideSchema = s.object(
  {
    attempts: s.optional(s.integer({ minimum: 0 })),
    backoff: s.optional(BackoffSchema),
    timeout: s.optional(s.number({ minimum: 0 })),
    priority: s.optional(s.number()),
    removeOnComplete: s.optional(RetentionSchema),
    removeOnFail: s.optional(RetentionSchema),
    keepLogs: s.optional(s.integer({ minimum: 0 })),
    keepStacktraces: s.optional(s.integer({ minimum: 0 })),
  },
  { description: "The stored override itself; `{}` when there is none." },
);

/** One editable job option's name. */
const JobDefaultKeySchema = s.enum(JOB_DEFAULT_KEYS);

/** A state the apply action walks. */
const JobDefaultsApplyStateSchema = s.enum(JOB_DEFAULTS_APPLY_STATES);

/** `GET`/`PUT`/`DELETE /queues/:queue/job-defaults`. Mirrors `JobDefaultsDto`. */
export const JobDefaultsSchema = s.named(
  "JobDefaults",
  s.object(
    {
      queue: s.string(),
      effective: JobDefaultsValuesSchema,
      code: JobDefaultsValuesSchema,
      codeSource: s.literal("api", {
        description:
          "`code` is this API's own queue instance's `defaultJobOptions` over the built-ins; another producer may be configured otherwise.",
      }),
      overridden: s.array(JobDefaultKeySchema, {
        description:
          "The keys the stored override replaces, in `JOB_DEFAULT_KEYS` order.",
      }),
      override: JobDefaultsOverrideSchema,
      seq: s.integer({
        minimum: 0,
        description:
          "The override's version: send it as `expectedSeq`, and as `seq` to apply it. `0` when nothing was ever stored.",
      }),
      updatedAt: s.optional(
        s.integer({
          description:
            "When the override was last written, epoch ms; absent when it never was.",
        }),
      ),
      propagationMs: s.integer({
        minimum: 0,
        description:
          "How long a producer may keep adding jobs with the previous defaults after a change: this API's queue's `jobDefaultsRefreshInterval`.",
      }),
      pending: s.named(
        "JobDefaultsPending",
        s.object(
          {
            waiting: Count,
            delayed: Count,
            failed: Count,
            "waiting-children": Count,
            total: Count,
          },
          {
            description:
              "Jobs pending in each state the apply action walks, from the queue's counts: an upper bound on what it would change. Apply with `dryRun` for the exact figure.",
          },
        ),
      ),
    },
    {
      description:
        "A queue's job defaults. Precedence, highest first: an option passed on the job's own `add()`; the stored override; the code's defaults (a `define()` definition's, then the queue's `defaultJobOptions`); the built-ins.",
    },
  ),
);

/** A backoff a client may store: fixed ms, or `fixed`/`exponential`. Mirrors `JobDefaultBackoff`. */
const JobDefaultBackoffSchema = s.union(
  bounded("backoffDelay", "A fixed delay between attempts, ms:"),
  s.object({
    type: s.enum(JOB_DEFAULT_BACKOFF_TYPES),
    delay: bounded("backoffDelay", "Base delay, ms:"),
    max: s.optional(
      bounded(
        "backoffMax",
        "Longest delay before jitter, ms, and at least `delay`:",
      ),
    ),
    jitter: s.optional(
      s.number({
        minimum: JOB_DEFAULTS_BOUNDS.backoffJitter.min,
        maximum: JOB_DEFAULTS_BOUNDS.backoffJitter.max,
        description: "Fraction of each delay randomised.",
      }),
    ),
  }),
);

/** A retention a client may store. Mirrors `RetentionDto`, bounded. */
const JobDefaultRetentionSchema = s.union(
  s.boolean(),
  bounded("retentionCount", "Most finished jobs kept:"),
  s.object({
    count: s.optional(bounded("retentionCount", "Most finished jobs kept:")),
    ttl: s.optional(bounded("retentionTtl", "Oldest finished job kept, ms:")),
  }),
);

/** `PUT /queues/:queue/job-defaults` body. Mirrors `JobDefaultsBody`. */
export const JobDefaultsBodySchema = s.named(
  "JobDefaultsBody",
  s.object(
    {
      attempts: s.optional(
        s.nullable(
          bounded("attempts", "Attempts in total, including the first:"),
        ),
      ),
      backoff: s.optional(s.nullable(JobDefaultBackoffSchema)),
      timeout: s.optional(
        s.nullable(bounded("timeout", "Per-attempt timeout, ms, 0 for none:")),
      ),
      priority: s.optional(
        s.nullable(bounded("priority", "Lower runs first:")),
      ),
      removeOnComplete: s.optional(s.nullable(JobDefaultRetentionSchema)),
      removeOnFail: s.optional(s.nullable(JobDefaultRetentionSchema)),
      keepLogs: s.optional(
        s.nullable(
          bounded(
            "keepLogs",
            "Log lines a job keeps (`0`, keep every line, is refused):",
          ),
        ),
      ),
      keepStacktraces: s.optional(
        s.nullable(bounded("keepStacktraces", "Failure stack traces kept:")),
      ),
      expectedSeq: s.optional(
        s.integer({
          minimum: 0,
          description:
            "The `seq` last read. Answered 409 CONTROL_CONTENDED when it no longer matches. Omit it for a last-writer-wins write.",
        }),
      ),
    },
    {
      description:
        "A merge patch: a key left out is untouched, `null` clears it so the code's value applies again. A retention object needs `count`, `ttl` or both, and a backoff's `max` is at least its `delay` (400 VALIDATION otherwise).",
    },
  ),
);

/** `DELETE /queues/:queue/job-defaults` query. Mirrors `ResetJobDefaultsQuery`. */
export const ResetJobDefaultsQuerySchema = s.query(
  s.object({
    expectedSeq: s.optional(
      s.integer({
        minimum: 0,
        description:
          "The `seq` last read. Answered 409 CONTROL_CONTENDED when it no longer matches, and nothing is reset.",
      }),
    ),
  }),
);

/** How many jobs an apply call examines when none is named, unless `maxApplyDefaults` is lower. */
export const APPLY_DEFAULTS_DEFAULT_LIMIT = 1000;

/**
 * The `limit` an apply call uses when none is given:
 * {@link APPLY_DEFAULTS_DEFAULT_LIMIT}, or `maxApplyDefaults` when lower.
 */
export function defaultApplyDefaultsLimit(maxApplyDefaults: number): number {
  return Math.min(APPLY_DEFAULTS_DEFAULT_LIMIT, maxApplyDefaults);
}

/** The longest cursor an apply call accepts; the drivers' are far shorter. */
const MAX_APPLY_CURSOR_LENGTH = 2048;

/** `POST /queues/:queue/job-defaults/apply` body, capped by `limits.maxApplyDefaults`. Mirrors `ApplyJobDefaultsBody`. */
export function applyJobDefaultsBodySchema(maxApplyDefaults: number) {
  return s.object({
    seq: s.integer({
      minimum: 0,
      description:
        "The override version being applied: the `seq` the user confirmed. 409 DEFAULTS_CHANGED when the stored override has moved on.",
    }),
    keys: s.optional(
      s.array(JobDefaultKeySchema, {
        minItems: 1,
        description:
          "Which overridden keys to write. Defaults to every key the override sets; one it does not set is 400 INVALID_ARGUMENT.",
      }),
    ),
    states: s.optional(
      s.array(JobDefaultsApplyStateSchema, {
        minItems: 1,
        description:
          "Which states to walk, in this order. Defaults to waiting, delayed, failed, waiting-children; a repeat is 400 INVALID_ARGUMENT.",
      }),
    ),
    limit: s.optional(
      s.integer({
        minimum: 1,
        maximum: maxApplyDefaults,
        default: defaultApplyDefaultsLimit(maxApplyDefaults),
        description: `Most jobs to examine in this call; at most ${maxApplyDefaults} (\`limits.maxApplyDefaults\`).`,
      }),
    ),
    cursor: s.optional(
      s.string({
        minLength: 1,
        maxLength: MAX_APPLY_CURSOR_LENGTH,
        description:
          "The previous call's `next`, to continue the walk. Opaque; one this walk did not issue is 400 INVALID_ARGUMENT.",
      }),
    ),
    dryRun: s.optional(
      s.boolean({
        default: false,
        description: "Examine and count exactly as a real call, write nothing.",
      }),
    ),
    includeUnmarked: s.optional(
      s.boolean({
        default: false,
        description:
          "Also rewrite jobs added before bun-jobs recorded which options were explicit, treating every option of theirs as defaulted.",
      }),
    ),
  });
}

/** What one apply call did. Mirrors `ApplyJobDefaultsResultDto`. */
export const ApplyJobDefaultsResultSchema = s.named(
  "ApplyJobDefaultsResult",
  s.object(
    {
      seq: Count,
      keys: s.array(JobDefaultKeySchema),
      dryRun: s.boolean(),
      examined: Count,
      rewritten: Count,
      unchanged: Count,
      skippedExplicit: Count,
      skippedUnmarked: Count,
      moved: s.integer({
        minimum: 0,
        description:
          "Jobs that left the walked states between this call's read and its write, untouched. A lower bound: Redis, SQL and memory lock or run a batch atomically and report 0.",
      }),
      exhausted: s.integer({
        minimum: 0,
        description:
          "Rewritten jobs whose `attemptsMade` already reaches the new `attempts`: each runs once more and dies if that attempt fails. Counted within `rewritten`.",
      }),
      next: s.nullable(
        s.string({
          description:
            "Where the next call continues (send it as `cursor`), or null when the walk is complete.",
        }),
      ),
      done: s.boolean({ description: "`next === null`." }),
    },
    {
      description:
        "`rewritten`, `unchanged`, `skippedExplicit`, `skippedUnmarked` and `moved` add up to `examined`.",
    },
  ),
);
