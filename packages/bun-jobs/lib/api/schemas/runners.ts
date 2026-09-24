import { DEFAULT_STALE_RUN_AFTER } from "../../runner/clearHistory";
import {
  EXECUTION_MODES,
  MAX_NAME_LENGTH,
  NAME_PARAM_PATTERN,
  RUN_LOG_LEVELS,
  RUN_LOG_STREAMS,
  RUNNER_CONFIG_BOUNDS,
  RUNNER_CONFIG_KEYS,
} from "../contract/constants";
import { s } from "../schema/builder";
import { ErrorDtoSchema, PageInfoSchema, TimeInputSchema } from "./common";

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

/**
 * A run id, as a path parameter: the id a trigger answered with and every run
 * record carries (a UUIDv7 for runs this library starts).
 *
 * Bounded, but deliberately **not** patterned the way {@link RunnerIdSchema}
 * is. A runner id names a key segment the drivers build storage paths from, so
 * a malformed one is refused before anything is read; a run id only addresses
 * a stored run, and every driver encodes it, so an id this backend has never
 * seen is an unknown run (404 `RUN_NOT_FOUND`) rather than a bad name.
 */
export const RunIdSchema = s.string({
  minLength: 1,
  maxLength: MAX_NAME_LENGTH,
  description: `A run id, at most ${MAX_NAME_LENGTH} characters. Percent-encode it in a path.`,
});

/** Where a run executed: the contract's {@link EXECUTION_MODES}, not a copy. */
const ExecutionModeSchema = s.enum(EXECUTION_MODES);

/** What a runner instance is doing. Mirrors `RunnerStatus`. */
/**
 * A runner's lifecycle in its own process: `idle` (not started), `running`
 * (started, schedule armed — not "a run is in flight", which is `isRunning`),
 * `paused`, `stopped`.
 */
const RunnerStatusSchema = s.enum(["idle", "running", "paused", "stopped"], {
  description:
    "The runner's lifecycle in its own process: `idle` = registered, not started; `running` = started with its schedule armed (a run may or may not be in flight: see `isRunning`); `paused`; `stopped`.",
});

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
    // Absent and `0` are different facts, which is why both are optional
    // rather than defaulted: absent means the backend stores no run logs at
    // all (`meta.features.runnerLogs` is `false`, and the log route answers
    // 409), `0` means the run was simply quiet. Absent on a run still going
    // means neither — capture writes both counters when the run settles.
    logLines: s.optional(
      s.integer({
        minimum: 0,
        description:
          "Lines this run's log holds, after the caps; `0` when it logged nothing. Written when the run settles, so a run still going has neither counter — read the log route for a live count. Absent on a settled run means the backend stores no run logs, or this run's log has aged out.",
      }),
    ),
    logsDropped: s.optional(
      s.integer({
        minimum: 0,
        description:
          "Lines the caps dropped from this run, oldest first; `0` when none were. Written with `logLines` when the run settles, and absent in the same cases.",
      }),
    ),
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

/** The overlap policies a runner accepts. */
const RunModeSchema = s.enum(["parallel", "single"]);

/**
 * A runner's executor and overlap settings. Mirrors `RunnerConfigValues`.
 *
 * `maxConcurrency` is a plain number rather than a bounded integer: what a
 * runner *reports* is a fact, not a request to validate, and its code may ask
 * for any cap at all (`resolveRunnerOptions` imposes no ceiling). The bounds
 * belong on {@link RunnerConfigBodySchema}, which is the request. `null` is
 * unlimited — `Number.POSITIVE_INFINITY` in code, which JSON cannot carry.
 */
export const RunnerConfigValuesSchema = s.named(
  "RunnerConfigValues",
  s.object({
    executionMode: ExecutionModeSchema,
    runMode: RunModeSchema,
    maxConcurrency: s.nullable(
      s.number({
        minimum: 1,
        description:
          "Most concurrent runs in `parallel`, or `null` for unlimited. Meaningless in `single`.",
      }),
    ),
  }),
);

/** The settings an override may replace, in `RUNNER_CONFIG_KEYS` order. */
const RunnerConfigKeys = s.array(s.enum(RUNNER_CONFIG_KEYS), {
  description: "Setting names, in `RUNNER_CONFIG_KEYS` order.",
});

/**
 * A runner's configuration: what it runs with, what its code asked for, and
 * whether an owner has adopted the stored override. Mirrors `RunnerConfigDto`.
 */
export const RunnerConfigSchema = s.named(
  "RunnerConfig",
  s.object({
    effective: RunnerConfigValuesSchema,
    code: s.optional(RunnerConfigValuesSchema),
    overridden: RunnerConfigKeys,
    allowed: s.optional(
      s.array(ExecutionModeSchema, {
        description:
          "The execution modes an override may choose and this runner's owner can adopt: its `remoteConfig.executionModes`, less `spawn` and `worker` when it was built from a driver instance (unless one is its code's own mode). May be empty. Absent means all three.",
      }),
    ),
    seq: s.integer({ minimum: 0 }),
    appliedSeq: s.optional(
      s.integer({
        minimum: 0,
        description:
          "The version an owner has adopted; below `seq` means it has not been picked up yet.",
      }),
    ),
    error: s.optional(
      s.object(
        {
          at: s.integer(),
          message: s.string(),
          keys: s.array(s.enum(RUNNER_CONFIG_KEYS), {
            description:
              "The settings the owner refused, in `RUNNER_CONFIG_KEYS` order; every other overridden setting was adopted. A whole-override refusal names every overridden key. `[]` on an error an owner recorded before this field existed.",
          }),
        },
        {
          description:
            "Why an owner refused the override, in whole or in part; absent when the last one was adopted entire. `keys` names the refused settings.",
        },
      ),
    ),
    updatedAt: s.optional(s.integer()),
  }),
);

/**
 * `PUT /runners/{runner}/config` body: a **merge patch**. A field left out is
 * untouched, and `null` clears that override so the runner goes back to what
 * its own code asked for.
 *
 * Every table here comes from the contract — {@link EXECUTION_MODES} and
 * {@link RUNNER_CONFIG_BOUNDS} — so the UI builds its form from the very
 * values the route enforces. `maxConcurrency: null` means unlimited and is
 * therefore not bounded; a number outside the range, or a fractional one, is
 * 400 `VALIDATION` at `concurrency.maxConcurrency`.
 */
export const RunnerConfigBodySchema = s.named(
  "RunnerConfigBody",
  s.object({
    executionMode: s.optional(
      s.nullable(
        s.enum(EXECUTION_MODES, {
          description:
            "Where runs execute, from the *next* run on. 409 CONFIG_NOT_ALLOWED when the runner's code does not permit it; `null` clears the override.",
        }),
      ),
    ),
    concurrency: s.optional(
      s.nullable(
        s.union(
          s.object(
            { runMode: s.literal("single") },
            {
              description:
                "One run at a time, cluster-wide, held by the runner's lock. A cap means nothing here, so none is accepted.",
            },
          ),
          s.object(
            {
              runMode: s.literal("parallel"),
              maxConcurrency: s.nullable(
                s.integer({
                  minimum: RUNNER_CONFIG_BOUNDS.maxConcurrency.min,
                  maximum: RUNNER_CONFIG_BOUNDS.maxConcurrency.max,
                  description: `Most concurrent runs, ${RUNNER_CONFIG_BOUNDS.maxConcurrency.min} … ${RUNNER_CONFIG_BOUNDS.maxConcurrency.max}, or \`null\` for unlimited. Lowering it never kills a run in flight.`,
                }),
              ),
            },
            {
              description:
                "Runs may overlap, up to `maxConcurrency`. `null` clears both settings, so the runner's own code applies again.",
            },
          ),
        ),
      ),
    ),
  }),
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
    config: s.optional(RunnerConfigSchema),
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
      isLocal: s.boolean({
        description:
          "Registered in this process. Every runner can be read, triggered, paused, resumed and rescheduled; only a local one can be killed or have its stats reset.",
      }),
      local: s.documented(
        s.boolean({
          description:
            "Deprecated: the same as `isLocal`, which matches the runner detail's name. Still sent; removed in a future major version.",
        }),
        { deprecated: true },
      ),
      name: s.optional(s.string()),
      status: s.optional(RunnerStatusSchema),
      isPaused: s.boolean({
        description:
          "Paused, from the backend: the same from every process, local or not.",
      }),
      isRunning: s.boolean({
        description:
          'A run is in flight anywhere, from the backend\'s lock. `status: "running"` means only that the runner is started with its schedule armed.',
      }),
    }),
  ),
});

/**
 * The longest history cursor this route accepts; the ones it mints hold a
 * namespace, a runner name, an order, a timestamp and a run id, so they are
 * far shorter. The same cap the apply-defaults walk puts on its cursor.
 */
const MAX_HISTORY_CURSOR_LENGTH = 2048;

/** `GET /runners/:runner/history` query. Mirrors `HistoryQuery`. */
export function historyQuerySchema(maxHistory: number) {
  return s.query(
    s.object({
      cursor: s.optional(
        s.string({
          minLength: 1,
          maxLength: MAX_HISTORY_CURSOR_LENGTH,
          description:
            "The previous page's `page.next`, to continue the walk at the record after the last one you were shown. **Opaque — never build or parse one**: it holds the backend's ordering key, and the backends do not agree on it. One this route did not issue, or one belonging to another runner or the other `order`, is 400 `INVALID_ARGUMENT`, never a silent restart at page one. Takes precedence over `offset`. Unlike an offset it cannot jump to page N — it walks — and unlike an offset nothing shifts under it when a run starts between two requests.",
        }),
      ),
      offset: s.optional(
        s.integer({
          minimum: 0,
          default: 0,
          description:
            "Records skipped before the page. Deliberately uncapped: `keepHistory` may store far more runs than `limits.maxHistory`, and paging is what makes every one of them reachable. This is how a client jumps to page N; `cursor` is how it walks the list without losing a record to a run starting meanwhile. Ignored when `cursor` is sent.",
        }),
      ),
      limit: s.optional(
        s.integer({
          minimum: 1,
          maximum: maxHistory,
          default: Math.min(50, maxHistory),
          description: `Records on the page, at most \`limits.maxHistory\`. The cap bounds a **page**, not how far back you can read — ask for more and it is 400 \`VALIDATION\`, never a silently shortened page.`,
        }),
      ),
      order: s.optional(
        s.enum(["asc", "desc"], {
          default: "desc",
          description:
            "By start time: `desc` — the default, and the only order served before paging existed — is newest first; `asc` is oldest first. The same list, paged from opposite ends.",
        }),
      ),
    }),
  );
}

/** `GET /runners/:runner/history` response. Mirrors `RunnerHistoryDto`. */
export const HistorySchema = s.object({
  items: s.array(RunRecordSchema),
  page: PageInfoSchema,
});

/**
 * The range `DELETE /runners/:runner/history` accepts for `staleAfter`, in
 * milliseconds. The floor is the library's own default, one day, so the API
 * can only make a clear keep *more*: lowering it would let any caller with
 * the action clear a live parallel run in another process after minutes. The
 * ceiling, thirty days, keeps the value a real duration.
 */
export const CLEAR_HISTORY_STALE_AFTER = {
  /** Smallest `staleAfter` accepted, and the default: one day. */
  min: DEFAULT_STALE_RUN_AFTER,
  /** Largest `staleAfter` accepted: thirty days. */
  max: 30 * DEFAULT_STALE_RUN_AFTER,
} as const;

/** `DELETE /runners/:runner/history` query. */
export const ClearHistoryQuerySchema = s.query(
  s.object({
    staleAfter: s.optional(
      s.integer({
        minimum: CLEAR_HISTORY_STALE_AFTER.min,
        maximum: CLEAR_HISTORY_STALE_AFTER.max,
        default: CLEAR_HISTORY_STALE_AFTER.min,
        description:
          "How long, in milliseconds, a run whose record still says `running` counts as in progress when nothing else vouches for it — neither this process executing it nor the runner's live lock holder. Older, it is taken for a run whose process crashed and is removed. Defaults to one day, which is also the minimum: raise it for runners whose runs legitimately last longer. At most thirty days.",
      }),
    ),
  }),
);

/** `DELETE /runners/:runner/history` response. */
export const ClearHistoryResultSchema = s.object({
  removed: s.integer({
    minimum: 0,
    description:
      "How many runs were removed, each with its record and its log.",
  }),
  kept: s.array(s.string(), {
    description:
      "The runs left in place because they are still in progress, newest first. `[]` when nothing was running.",
  }),
});

/** Which stream produced a line: the contract's {@link RUN_LOG_STREAMS}, not a copy. */
const RunLogStreamSchema = s.enum(RUN_LOG_STREAMS);

/** One captured line of a run's output. Mirrors `RunLogLineDto`. */
export const RunLogLineSchema = s.named(
  "RunLogLine",
  s.object({
    seq: s.integer({
      minimum: 1,
      description:
        "The line's 1-based place in its run's output, assigned by the store and never reused. A gap means the caps dropped those lines; the page's `lastSeq` sent back as `since` is the tail cursor.",
    }),
    at: s.integer({ description: "When it was captured, epoch ms." }),
    stream: RunLogStreamSchema,
    message: s.string({
      description:
        "The line's text, with its trailing newline already removed. The store calls this field `text`.",
    }),
    level: s.optional(
      s.enum(RUN_LOG_LEVELS, {
        description:
          "The severity a `log`-stream line carried. Absent on `stdout` and `stderr`, which have no levels, and on a forwarded line that came without one.",
      }),
    ),
    truncated: s.optional(
      s.literal(true, {
        description:
          "Only ever `true`: capture cut this line at the per-line byte cap. Absent means the line is whole.",
      }),
    ),
  }),
);

/** `GET /runners/:runner/runs/:runId/logs` query. Mirrors `RunLogsQuery`. */
export function runLogsQuerySchema(maxLogPage: number) {
  return s.query(
    s.object({
      since: s.optional(
        s.integer({
          minimum: 0,
          description:
            "Only lines numbered **above** this — an exclusive lower bound on `seq`. Send back the previous page's `lastSeq` to tail without repeating or skipping a line.",
        }),
      ),
      offset: s.optional(
        s.integer({
          minimum: 0,
          default: 0,
          description: "Lines skipped, within what `since` and `stream` leave.",
        }),
      ),
      limit: s.optional(
        s.integer({
          minimum: 1,
          maximum: maxLogPage,
          default: Math.min(100, maxLogPage),
        }),
      ),
      order: s.optional(s.enum(["asc", "desc"], { default: "asc" })),
      stream: s.optional(
        s.enum(RUN_LOG_STREAMS, {
          description: "Only lines from this stream; every stream when absent.",
        }),
      ),
    }),
  );
}

/**
 * `GET /runners/:runner/runs/:runId/logs` response. Mirrors `RunLogPageDto`.
 *
 * `dropped` and `lastSeq` come from the store unfiltered; `capped` and `live`
 * are the route's own, derived from the run — see the route.
 */
export const RunLogPageSchema = s.named(
  "RunLogPage",
  s.object({
    items: s.array(RunLogLineSchema),
    page: PageInfoSchema,
    dropped: s.integer({
      minimum: 0,
      description:
        "How many of this run's lines the caps have dropped, in total. The run's own number, unfiltered by `since` or `stream`.",
    }),
    capped: s.boolean({
      description:
        "Whether a cap is trimming this run's log right now, so the page is a moving tail. Derived by the route, not stored.",
    }),
    live: s.boolean({
      description:
        "Whether the run is still going, so more lines may follow. Derived by the route from the run's status, not stored.",
    }),
    lastSeq: s.integer({
      minimum: 0,
      description:
        "The highest `seq` this run's log holds, or `0` when it holds nothing. Unfiltered, which is what makes it a correct `since` cursor for a filtered tail.",
    }),
  }),
);

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
        anchor: s.optional(TimeInputSchema),
      }),
      s.object({ at: TimeInputSchema }),
    ),
  ),
});

/** `PUT /runners/:runner/schedule` response. */
export const ScheduleResultSchema = s.object({
  schedule: RunnerScheduleSchema,
  nextRunAt: s.nullable(s.integer()),
});
