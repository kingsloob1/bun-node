import { DEFAULT_JOBS_API_LIMITS } from "../config";
import { s } from "../schema/builder";
import { PageInfoSchema } from "./common";

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
  }),
);

/**
 * A worker consuming a queue. Mirrors `WorkerDto`: `host` and `pid` are
 * omitted when `serialize.exposeHosts` is off.
 */
export const WorkerSchema = s.named(
  "Worker",
  s.object({
    id: s.string(),
    queue: s.string(),
    concurrency: Count,
    active: Count,
    paused: s.boolean(),
    startedAt: s.integer(),
    heartbeatAt: s.integer(),
    expiresAt: s.integer(),
    host: s.optional(
      s.string({ description: "Omitted with `serialize.exposeHosts: false`." }),
    ),
    pid: s.optional(
      s.integer({
        description: "Omitted with `serialize.exposeHosts: false`.",
      }),
    ),
  }),
);

/** `GET /workers` and `GET /queues/:queue/workers`. */
export const WorkerListSchema = s.object({ items: s.array(WorkerSchema) });

/** The `minutes` a throughput or overview read covers. */
export function minutesQuerySchema(maxMinutes: number) {
  return s.query(
    s.object({
      minutes: s.optional(
        s.integer({
          minimum: 1,
          maximum: maxMinutes,
          default: 60,
          description: `Minutes back from the current one; at most ${maxMinutes}.`,
        }),
      ),
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
