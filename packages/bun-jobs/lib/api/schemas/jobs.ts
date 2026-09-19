import {
  JOB_INCLUDES,
  MAX_JOB_ID_LENGTH,
  MAX_JOB_REF_LENGTH,
} from "../contract/constants";
import { s } from "../schema/builder";
import {
  ErrorDtoSchema,
  JobRefSchema,
  JobStateSchema,
  PageInfoSchema,
} from "./common";

/**
 * Schemas for the job, bulk, repeatable and definition routes.
 */

/**
 * A job id that addresses an existing job: in a path, a bulk body or a lookup.
 * At most {@link MAX_JOB_REF_LENGTH} characters — deliberately wider than the
 * cap on a new id, because a backend may hold jobs whose ids predate that cap,
 * and those must stay readable, retryable and removable.
 */
export const JobIdRefSchema = s.string({
  minLength: 1,
  maxLength: MAX_JOB_REF_LENGTH,
  description: `A job id, at most ${MAX_JOB_REF_LENGTH} characters. Percent-encode it in a path: \`/\` is \`%2F\`.`,
});

/** The id schema of the first cut, kept for importers: the addressing rule. */
export const JobIdSchema = JobIdRefSchema;

/**
 * A job id a caller chooses for a new job (`opts.jobId`): at most
 * {@link MAX_JOB_ID_LENGTH} characters, the cap bun-jobs' `assertJobId`
 * applies. The schema is a first check only: `assertJobId` is the authority
 * (it counts UTF-16 units and refuses control characters, a leading `.` and a
 * lone surrogate),
 * and its refusal is answered 400 `INVALID_ARGUMENT`.
 */
export const NewJobIdSchema = s.string({
  minLength: 1,
  maxLength: MAX_JOB_ID_LENGTH,
  description: `A new job's id, at most ${MAX_JOB_ID_LENGTH} characters. bun-jobs may still refuse it (400 INVALID_ARGUMENT): control characters, a leading ".", a lone surrogate, or more than ${MAX_JOB_ID_LENGTH} UTF-16 units.`,
});

/** Optional fields a client asks for with `include`. */
export const JobIncludeSchema = s.enum(JOB_INCLUDES);

/** How long finished jobs are kept. Mirrors `Retention`. */
const RetentionSchema = s.union(
  s.boolean(),
  s.integer({ minimum: 0 }),
  s.object({
    count: s.optional(s.integer({ minimum: 0 })),
    ttl: s.optional(s.integer({ minimum: 0 })),
  }),
);

/**
 * A job's options after defaults. Mirrors `ResolvedJobOptions`. Open to extra
 * properties: a record written by another version may carry options this one
 * does not know, and they are passed through rather than hidden.
 */
export const JobOptionsSchema = s.named(
  "JobOptions",
  s.object(
    {
      priority: s.number(),
      attempts: s.integer({ minimum: 0 }),
      backoff: s.union(
        s.number({ minimum: 0 }),
        s.object(
          {
            type: s.optional(s.string()),
            delay: s.optional(s.number({ minimum: 0 })),
            factor: s.optional(s.number()),
            max: s.optional(s.number({ minimum: 0 })),
            jitter: s.optional(s.union(s.number(), s.boolean())),
          },
          { additionalProperties: true },
        ),
      ),
      timeout: s.number({ minimum: 0 }),
      removeOnComplete: RetentionSchema,
      removeOnFail: RetentionSchema,
      keepStacktraces: s.integer({ minimum: 0 }),
      deadLetter: s.optional(s.string()),
      keepLogs: s.optional(s.integer({ minimum: 0 })),
      ignoreFailure: s.optional(s.boolean()),
    },
    { additionalProperties: true },
  ),
);

/** A job's place in a flow. Mirrors `JobFlowDto`. */
export const JobFlowSchema = s.named(
  "JobFlow",
  s.object({
    parent: s.nullable(JobRefSchema),
    children: s.array(JobRefSchema),
    pending: s.integer({ minimum: 0 }),
    values: s.record(s.unknown()),
    failures: s.record(ErrorDtoSchema),
    recorded: s.boolean(),
  }),
);

/** Epoch milliseconds, or `null`. */
const MaybeTime = s.nullable(s.integer());

/** A job. Mirrors `JobDto`; never carries a lock token. */
export const JobSchema = s.named(
  "Job",
  s.object({
    queue: s.string(),
    id: s.string(),
    name: s.string(),
    state: JobStateSchema,
    priority: s.number(),
    runAt: s.integer(),
    createdAt: s.integer(),
    processedOn: MaybeTime,
    finishedOn: MaybeTime,
    expiresAt: MaybeTime,
    attemptsMade: s.integer({ minimum: 0 }),
    maxAttempts: s.integer({ minimum: 0 }),
    stalledCount: s.integer({ minimum: 0 }),
    progress: s.nullable(
      s.union(
        s.number({ description: "The progress value, as a number." }),
        s.record(s.unknown(), {
          description: "The progress value, as a record of fields.",
        }),
      ),
    ),
    failedReason: s.nullable(ErrorDtoSchema),
    lockExpiresAt: MaybeTime,
    workerId: s.nullable(s.string()),
    repeatKey: s.nullable(s.string()),
    flow: s.nullable(JobFlowSchema),
    data: s.optional(s.unknown({ description: "With `include=data`." })),
    returnValue: s.optional(
      s.unknown({ description: "With `include=returnValue`." }),
    ),
    stacktrace: s.optional(
      s.array(ErrorDtoSchema, {
        description:
          "With `include=stacktrace`: recent failures, newest first. An entry carries `stack` only when the API was created with `serialize.exposeStacks` (off by default); otherwise it is the error's `name` and `message`, plus `code`, `data` and `cause` when it had them.",
      }),
    ),
    opts: s.optional(JobOptionsSchema),
  }),
);

/** A page of jobs. */
export const JobPageSchema = s.named(
  "JobPage",
  s.object({ items: s.array(JobSchema), page: PageInfoSchema }),
);

/** `include` as a query value: repeated, or comma-separated. */
const IncludeQuery = s.optional(s.array(JobIncludeSchema));

/** `GET /queues/:queue/jobs` query. */
export function jobListQuerySchema(
  defaultPageSize: number,
  maxPageSize: number,
) {
  return s.query(
    s.object({
      state: s.optional(
        s.array(JobStateSchema, {
          description: "States to list; every state when absent.",
        }),
      ),
      offset: s.optional(s.integer({ minimum: 0, default: 0 })),
      limit: s.optional(
        s.integer({
          minimum: 1,
          maximum: maxPageSize,
          default: defaultPageSize,
        }),
      ),
      order: s.optional(s.enum(["asc", "desc"], { default: "asc" })),
      include: IncludeQuery,
      name: s.optional(
        s.array(s.string({ minLength: 1, maxLength: 512 }), {
          description:
            "Only jobs with this name, exactly. Repeat the key, or comma-separate, for several.",
        }),
      ),
      search: s.optional(
        s.string({
          maxLength: 512,
          description:
            "Only jobs whose id or name contains this, ignoring case. Matched literally, never against the payload, and linear in the jobs in the states asked for.",
        }),
      ),
      total: s.optional(
        s.boolean({
          default: false,
          description:
            "Also count every job that matched. Costs a full count on a filtered read.",
        }),
      ),
    }),
  );
}

/** `include` alone, for single reads. */
export const IncludeQuerySchema = s.query(s.object({ include: IncludeQuery }));

/** `POST /queues/:queue/jobs/lookup` body. */
export function lookupBodySchema(maxBulkIds: number) {
  return s.object({
    ids: s.array(JobIdRefSchema, {
      minItems: 1,
      description: `At most ${maxBulkIds} ids; more is 400 BULK_LIMIT.`,
    }),
    include: s.optional(s.array(JobIncludeSchema)),
  });
}

/** `POST /queues/:queue/jobs/lookup` response: one entry per id, in order. */
export const LookupResultSchema = s.object({
  items: s.array(s.nullable(JobSchema)),
});

/** `GET /queues/:queue/jobs/:id/logs` query. */
export function logsQuerySchema(maxLogPage: number) {
  return s.query(
    s.object({
      offset: s.optional(s.integer({ minimum: 0, default: 0 })),
      limit: s.optional(
        s.integer({
          minimum: 1,
          maximum: maxLogPage,
          default: Math.min(100, maxLogPage),
        }),
      ),
      order: s.optional(s.enum(["asc", "desc"], { default: "asc" })),
    }),
  );
}

/** A page of log lines. */
export const LogPageSchema = s.object({
  items: s.array(s.string()),
  page: PageInfoSchema,
});

/** `GET /queues/:queue/jobs/:id/children` response. */
export const ChildrenSchema = s.object({
  parent: s.nullable(JobRefSchema),
  pending: s.integer({ minimum: 0 }),
  children: s.array(
    s.object({
      queue: s.string(),
      id: s.string(),
      job: s.nullable(JobSchema),
      value: s.optional(s.unknown()),
      failure: s.optional(ErrorDtoSchema),
    }),
  ),
  truncated: s.boolean(),
});

/** A time: epoch milliseconds, or an RFC 3339 date-time. */
const TimeInput = s.union(
  s.integer({ minimum: 0 }),
  s.string({ format: "date-time" }),
);

/** `PATCH /queues/:queue/jobs/:id` body. */
export const UpdateBodySchema = s.object({
  data: s.optional(s.unknown({ description: "The new payload." })),
  priority: s.optional(s.number()),
  runAt: s.optional(TimeInput),
  onlyIn: s.optional(s.array(JobStateSchema, { minItems: 1 })),
});

/** `POST /queues/:queue/jobs/:id/fail` body. */
export const FailBodySchema = s.object({
  reason: s.string({
    minLength: 1,
    maxLength: 4096,
    description: "Why the job is failed; becomes its `failedReason` message.",
  }),
});

/** `POST /queues/:queue/jobs/:id/retry` body. */
export const RetryBodySchema = s.object({
  resetAttempts: s.optional(s.boolean({ default: true })),
});

/** A bulk body: ids, capped by `limits.maxBulkIds`. */
export function bulkBodySchema(maxBulkIds: number) {
  return s.object({
    ids: s.array(JobIdRefSchema, {
      minItems: 1,
      description: `At most ${maxBulkIds} ids; more is 400 BULK_LIMIT.`,
    }),
  });
}

/** `POST /queues/:queue/jobs/retry` body. */
export function bulkRetryBodySchema(maxBulkIds: number) {
  return s.object({
    ids: s.array(JobIdRefSchema, {
      minItems: 1,
      description: `At most ${maxBulkIds} ids; more is 400 BULK_LIMIT.`,
    }),
    resetAttempts: s.optional(s.boolean({ default: true })),
  });
}

/** `POST /queues/:queue/jobs/retry-all` body, capped by `limits.maxRetryAll`. */
export function retryAllBodySchema(maxRetryAll: number) {
  return s.object({
    state: s.enum(["dead", "failed", "completed"]),
    name: s.optional(s.string({ minLength: 1, maxLength: 200 })),
    reason: s.optional(
      s.string({
        minLength: 1,
        maxLength: 500,
        description:
          'A substring of the last failure, as "<error name>: <message>". Patterns are not accepted.',
      }),
    ),
    limit: s.optional(
      s.integer({ minimum: 1, maximum: maxRetryAll, default: maxRetryAll }),
    ),
    resetAttempts: s.optional(s.boolean({ default: true })),
  });
}

/**
 * The most ids a retry-all answers with; `truncated` is `true` when it moved
 * more. Reported by `/meta` as `limits.maxRetryAllIds`.
 */
export const RETRY_ALL_MAX_IDS = 1000;

/** `POST /queues/:queue/jobs/retry-all` response. */
export const RetryAllResultSchema = s.object({
  count: s.integer({ minimum: 0 }),
  ids: s.array(s.string(), {
    description: `The first ${RETRY_ALL_MAX_IDS} ids retried.`,
  }),
  truncated: s.boolean(),
});

/** `POST /queues/:queue/jobs` body: a name, a payload, and a safe subset of options. */
export const AddBodySchema = s.object({
  name: s.string({ minLength: 1, maxLength: 200 }),
  data: s.unknown({ description: "The payload. JSON; `null` is allowed." }),
  opts: s.optional(
    s.object(
      {
        jobId: s.optional(NewJobIdSchema),
        priority: s.optional(s.number()),
        delay: s.optional(s.integer({ minimum: 0 })),
        runAt: s.optional(TimeInput),
        attempts: s.optional(s.integer({ minimum: 1 })),
        backoff: s.optional(s.integer({ minimum: 0 })),
        timeout: s.optional(s.integer({ minimum: 0 })),
      },
      {
        description:
          "Repeat, debounce, throttle, dead-letter, retention and flow options are not accepted over HTTP.",
      },
    ),
  ),
});

/** `POST /queues/:queue/jobs` response. */
export const AddResultSchema = s.object({
  added: s.boolean({
    description:
      "`false` when `jobId` matched an existing job, which is returned.",
  }),
  job: JobSchema,
});

/** A repeat series. Mirrors `RepeatableDto`. */
export const RepeatableSchema = s.named(
  "Repeatable",
  s.object({
    queue: s.string(),
    key: s.string(),
    name: s.string(),
    opts: JobOptionsSchema,
    cron: s.optional(s.string()),
    tz: s.optional(s.string()),
    every: s.optional(s.integer({ minimum: 1 })),
    startAt: s.optional(s.integer()),
    endAt: s.optional(s.integer()),
    limit: s.optional(s.integer({ minimum: 0 })),
    catchUp: s.optional(s.boolean()),
    count: s.integer({ minimum: 0 }),
    nextRunAt: s.nullable(
      s.integer({
        description: "Next occurrence, epoch ms; `null` while disabled.",
      }),
    ),
    nextJobId: s.nullable(
      s.string({
        description: "Id of the scheduled occurrence; `null` while disabled.",
      }),
    ),
    disabled: s.boolean({
      description:
        "Whether the series is disabled: it schedules nothing until enabled.",
    }),
    createdAt: s.integer(),
    updatedAt: s.integer(),
    data: s.optional(s.unknown({ description: "With `include=data`." })),
  }),
);

/** `GET /definitions` response. `handler` is never serialised. */
export const DefinitionListSchema = s.object({
  items: s.array(
    s.object({
      name: s.string(),
      options: s.record(s.unknown(), {
        description: "The definition's job options, as JSON.",
      }),
    }),
  ),
});
