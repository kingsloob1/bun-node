import { MAX_NAME_LENGTH, NAME_PARAM_PATTERN } from "../contract/constants";
import { s } from "../schema/builder";
import { ErrorDtoSchema } from "./common";

/**
 * Schemas for the runner routes.
 */

/**
 * A runner id, as a path parameter. Validated as a key segment before
 * `authorize` by the route (400 `INVALID_NAME`), and documented with that
 * rule as its pattern.
 */
export const RunnerIdSchema = s.documented(
  s.string({
    minLength: 1,
    maxLength: MAX_NAME_LENGTH,
    description:
      'Letters, digits, "_", "." and "-", and not "." or "..". Anything else is 400 INVALID_NAME.',
  }),
  { pattern: NAME_PARAM_PATTERN },
);

/** Where a run executed. Mirrors `ExecutionMode`. */
const ExecutionModeSchema = s.enum(["spawn", "worker", "in-process"]);

/** What a runner instance is doing. Mirrors `RunnerStatus`. */
const RunnerStatusSchema = s.enum(["idle", "running", "paused", "stopped"]);

/** One run. Mirrors `RunRecordDto`. */
export const RunRecordSchema = s.named(
  "RunRecord",
  s.object({
    runId: s.string(),
    runnerId: s.string(),
    attempt: s.integer({ minimum: 0 }),
    source: s.enum(["schedule", "manual", "queued", "resume"]),
    mode: ExecutionModeSchema,
    host: s.optional(s.string()),
    pid: s.optional(s.integer()),
    startedAt: s.integer(),
    finishedAt: s.optional(s.integer()),
    durationMs: s.optional(s.number({ minimum: 0 })),
    status: s.enum(["running", "success", "failed", "timeout", "killed"]),
    exitCode: s.optional(s.nullable(s.integer())),
    signal: s.optional(s.nullable(s.string())),
    error: s.optional(ErrorDtoSchema),
    result: s.optional(s.unknown()),
    detached: s.optional(s.boolean()),
  }),
);

/** A normalised schedule. Mirrors `RunnerSchedule`. */
export const RunnerScheduleSchema = s.named(
  "RunnerSchedule",
  s.nullable(
    s.union(
      s.object({ cron: s.string(), tz: s.optional(s.string()) }),
      s.object({
        every: s.integer({ minimum: 1 }),
        anchor: s.optional(s.integer()),
      }),
      s.object({ at: s.integer() }),
    ),
  ),
);

/** A runner's lifetime counters. Mirrors `RunnerStats`. */
export const RunnerStatsSchema = s.named(
  "RunnerStats",
  s.object({
    success: s.integer({ minimum: 0 }),
    failed: s.integer({ minimum: 0 }),
    timeout: s.integer({ minimum: 0 }),
    killed: s.integer({ minimum: 0 }),
    skipped: s.integer({ minimum: 0 }),
    queued: s.integer({ minimum: 0 }),
    total: s.integer({ minimum: 0 }),
  }),
);

/** A runner snapshot. Mirrors `RunnerInfoDto`. */
export const RunnerInfoSchema = s.named(
  "RunnerInfo",
  s.object({
    id: s.string(),
    namespace: s.string(),
    isLocal: s.boolean(),
    name: s.string(),
    file: s.optional(s.string()),
    schedule: RunnerScheduleSchema,
    nextRunAt: s.nullable(s.integer()),
    executionMode: s.optional(ExecutionModeSchema),
    runMode: s.optional(s.enum(["parallel", "single"])),
    queueRuns: s.optional(s.boolean()),
    maxQueuedRuns: s.optional(s.integer({ minimum: 0 })),
    maxConcurrency: s.optional(s.integer({ minimum: 1 })),
    isPaused: s.boolean(),
    isRunning: s.boolean(),
    runningOn: s.optional(
      s.object({
        runId: s.string(),
        since: s.integer(),
        host: s.optional(s.string()),
        pid: s.optional(s.integer()),
      }),
    ),
    queuedTriggers: s.integer({ minimum: 0 }),
    stats: RunnerStatsSchema,
    lastRun: s.optional(RunRecordSchema),
    lastError: s.optional(s.object({ name: s.string(), message: s.string() })),
    updatedAt: s.optional(s.integer()),
    local: s.optional(
      s.object({
        status: RunnerStatusSchema,
        activeRuns: s.array(RunRecordSchema),
        nextRunAt: s.nullable(s.integer()),
      }),
    ),
  }),
);

/** What a trigger did. Mirrors `TriggerOutcome`. */
export const TriggerOutcomeSchema = s.named(
  "TriggerOutcome",
  s.union(
    s.object({ outcome: s.literal("started"), runId: s.string() }),
    s.object({ outcome: s.literal("queued"), position: s.integer() }),
    s.object({
      outcome: s.literal("skipped"),
      reason: s.enum([
        "paused",
        "busy",
        "lock-held",
        "max-concurrency",
        "queue-full",
        "stopped",
      ]),
    }),
  ),
);

/** `GET /runners` response. */
export const RunnerListSchema = s.object({
  items: s.array(
    s.object({
      id: s.string(),
      local: s.boolean({
        description:
          "Registered in this process. Every runner can be read, triggered, paused, resumed and rescheduled; only a local one can be killed or have its stats reset.",
      }),
      name: s.optional(s.string()),
      status: s.optional(RunnerStatusSchema),
    }),
  ),
});

/** `GET /runners/:runner/history` query. */
export function historyQuerySchema(maxHistory: number) {
  return s.query(
    s.object({
      limit: s.optional(
        s.integer({
          minimum: 1,
          maximum: maxHistory,
          default: Math.min(50, maxHistory),
        }),
      ),
    }),
  );
}

/** `GET /runners/:runner/history` response, newest first. */
export const HistorySchema = s.object({ items: s.array(RunRecordSchema) });

/** `POST /runners/:runner/trigger` body. */
export const TriggerBodySchema = s.object({
  force: s.optional(s.boolean({ description: "Run even while paused." })),
  args: s.optional(
    s.unknown({
      description:
        "Arguments for the run. Refused (400 ARGS_NOT_ALLOWED) unless the API was created with `runnerTriggerArgs: true`.",
    }),
  ),
});

/** `POST /runners/:runner/resume` body. */
export const ResumeBodySchema = s.object({
  triggerNow: s.optional(
    s.boolean({
      default: false,
      description: "Also ask for a run straight away.",
    }),
  ),
});

/** Whether a runner is paused, after pausing or resuming it. */
export const RunnerPausedSchema = s.object({ paused: s.boolean() });

/** `POST /runners/:runner/kill` body. */
export const KillBodySchema = s.object({
  runId: s.optional(
    s.string({
      minLength: 1,
      description: "One run; every active run when absent.",
    }),
  ),
  force: s.optional(
    s.boolean({
      default: false,
      description: "Skip straight to the end of the kill escalation.",
    }),
  ),
  reason: s.optional(s.string({ minLength: 1, maxLength: 200 })),
  wait: s.optional(
    s.boolean({
      default: false,
      description:
        "Answer only once the runs have settled (200), instead of at once (202).",
    }),
  ),
});

/** `POST /runners/:runner/kill` response. */
export const KillResultSchema = s.object({ runIds: s.array(s.string()) });

/** A time: epoch milliseconds, or an RFC 3339 date-time. */
const TimeInput = s.union(
  s.integer({ minimum: 0 }),
  s.string({ format: "date-time" }),
);

/** `PUT /runners/:runner/schedule` body. Mirrors `ScheduleInput`, minus `Date`. */
export const ScheduleBodySchema = s.object({
  schedule: s.nullable(
    s.union(
      s.string({
        minLength: 1,
        maxLength: 200,
        description: "A cron expression.",
      }),
      s.integer({ minimum: 1, description: "An interval in milliseconds." }),
      s.object({
        cron: s.string({ minLength: 1, maxLength: 200 }),
        tz: s.optional(s.string({ minLength: 1, maxLength: 100 })),
      }),
      s.object({
        every: s.integer({ minimum: 1 }),
        anchor: s.optional(TimeInput),
      }),
      s.object({ at: TimeInput }),
    ),
  ),
});

/** `PUT /runners/:runner/schedule` response. */
export const ScheduleResultSchema = s.object({
  schedule: RunnerScheduleSchema,
  nextRunAt: s.nullable(s.integer()),
});
