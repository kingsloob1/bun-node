/**
 * `@kingsleyweb/bun-jobs` — background work for Bun.
 *
 * Two subsystems share one driver contract and one required `namespace`:
 *
 * - the **runner** (`BunRunner`): run a JS/TS file on a schedule or on
 *   demand, in a child process, a `Worker` or in-process, with cluster-wide
 *   single-run locking, queued triggers, timeouts and kill escalation;
 * - the **queue** (`BunQueue` / `BunQueueWorker`): queue and process jobs
 *   across processes and services with priorities, delays, retries, stalled
 *   recovery, repeatable jobs and retention.
 *
 * The public surface is assembled here in grouped, alphabetised export
 * blocks as each subsystem lands.
 */

/* ------------------------------------------------------------------ *
 * The per-service context — a namespace and a backend, set once, with
 * every runner, queue and worker derived from it.
 * ------------------------------------------------------------------ */
export { BunJobs, type BunJobsOptions, jobsFromContext } from "./BunJobs";

/* ------------------------------------------------------------------ *
 * Storage drivers — the contract both subsystems are built on, and the
 * backends implementing it.
 * ------------------------------------------------------------------ */
export {
  type ClaimOptions,
  createDriver,
  type DriverCapabilities,
  type DriverConfig,
  type DriverEvent,
  type DriverLifecycle,
  type ExecutionMode,
  type FailOutcome,
  FileDriver,
  type FileDriverOptions,
  type JobRecord,
  type JobsDriver,
  type JobState,
  type LockInfo,
  MemoryDriver,
  type QueueDriver,
  type QueuedTrigger,
  type QueueRef,
  type RepeatRecord,
  type ResolvedJobOptions,
  resolveDriver,
  type Retention,
  type RunnerDriver,
  type RunRecord,
  type RunSource,
  type RunStatus,
  type StoredSchedule,
} from "./drivers/index";

/* ------------------------------------------------------------------ *
 * The queue — producers, consumers and the job they exchange.
 * ------------------------------------------------------------------ */
export {
  BunQueue,
  type BunQueueEvents,
  type BunQueueOptions,
  BunQueueWorker,
  type BunQueueWorkerEvents,
  type BunQueueWorkerOptions,
  DEFAULT_JOB_OPTIONS,
  Job,
  type JobOptions,
  type JobProcessor,
  nextOccurrence,
  type ProcessorContext,
  type Repeatable,
  repeatJobId,
  repeatKeyFor,
  type RepeatOptions,
  resolveJobOptions,
  resolveRunAt,
  retentionExpiry,
  toRepeatRecord,
} from "./queue/index";

/* ------------------------------------------------------------------ *
 * The runner — run a JS/TS file on a schedule or on demand.
 * ------------------------------------------------------------------ */
export {
  BunRunner,
  type BunRunnerEvents,
  BunRunnerManager,
  type BunRunnerManagerOptions,
  type BunRunnerOptions,
  CHILD_ENV,
  type ChildToParent,
  defineHandler,
  type Executor,
  type ExecutorHandle,
  type ExecutorStartOptions,
  InProcessExecutor,
  type InProcessOptions,
  isRunnerChild,
  type ParentToChild,
  PROTOCOL_VERSION,
  type ResolvedRunnerOptions,
  resolveRunnerOptions,
  type RunContext,
  type RunHandle,
  type RunnerHandler,
  type RunnerInfo,
  type RunnerStats,
  type RunnerStatus,
  type RunOutcome,
  type SerializableContext,
  SpawnExecutor,
  type SpawnOptions,
  type TriggerOutcome,
  WorkerExecutor,
  type WorkerOptions,
} from "./runner/index";
/* ------------------------------------------------------------------ *
 * Shared building blocks used across the package, exported because a
 * consumer writing a custom driver or handler needs them too.
 * ------------------------------------------------------------------ */
export * from "./shared/constants";

/* ------------------------------------------------------------------ *
 * Scheduling — cron with optional seconds, plus the schedule shapes a
 * runner (and a repeatable job) accepts.
 * ------------------------------------------------------------------ */
export {
  type CronOptions,
  nextCronDate,
  parseCron,
  type ParsedCron,
  validateCron,
} from "./shared/cron";

export { TypedEmitterBase } from "./shared/emitter";

/* ------------------------------------------------------------------ *
 * Errors — every failure this package raises, each with a stable `code`.
 * ------------------------------------------------------------------ */
export {
  ChildExitError,
  ConfigError,
  DriverError,
  InvalidHandlerError,
  JobsError,
  JobTimeoutError,
  LockLostError,
  LockUnavailableError,
  QueueClosedError,
  QueueFullError,
  RunnerStoppedError,
  SerializationError,
  UnrecoverableJobError,
  WorkerClosedError,
} from "./shared/errors";
export { HOST, newId, newToken, parseToken } from "./shared/ids";
export { assertJsonSafe, safeJsonParse, stringifyBounded } from "./shared/json";
export {
  assertNamespace,
  assertSegment,
  queueKey,
  runnerKey,
} from "./shared/keys";
export {
  createJobsLogger,
  type LogFields,
  type Logger,
  type LoggerLike,
  resolveLogger,
} from "./shared/logger";
export {
  createTicker,
  nextFireDate,
  normalizeSchedule,
  type RunnerSchedule,
  type ScheduleInput,
  type Ticker,
  type TickerOptions,
} from "./shared/schedule";
