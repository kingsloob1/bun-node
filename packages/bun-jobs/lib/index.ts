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
  type ColumnRow,
  createDriver,
  detectAdapter,
  dialectFor,
  type DriverCapabilities,
  type DriverConfig,
  type DriverEvent,
  type DriverLifecycle,
  type ExecutionMode,
  type FailOutcome,
  FileDriver,
  type FileDriverOptions,
  type IndexRow,
  type JobPatch,
  type JobRecord,
  type JobsDriver,
  type JobState,
  type LockInfo,
  MemoryDriver,
  MONGO_COLLECTIONS,
  type MongoCollection,
  MongoDriver,
  type MongoDriverOptions,
  type QueueDriver,
  type QueuedTrigger,
  type QueueRef,
  type QueueStateEntry,
  RedisDriver,
  type RedisDriverOptions,
  RedisKeys,
  type RepeatRecord,
  type ResolvedJobOptions,
  resolveDriver,
  type ResolvedSyncOptions,
  type Retention,
  type RunnerDriver,
  type RunRecord,
  type RunSource,
  type RunStatus,
  type SchemaChange,
  type SchemaSyncOptions,
  SQL_TABLES,
  type SqlAdapter,
  type SqlDialect,
  SqlDriver,
  type SqlDriverOptions,
  type SqlTable,
  type StoredSchedule,
  type SyncBackend,
} from "./drivers/index";

/* ------------------------------------------------------------------ *
 * The queue — producers, consumers and the job they exchange.
 * ------------------------------------------------------------------ */
export {
  type BackoffContext,
  BackoffStrategies,
  type BackoffStrategy,
  BUILT_IN_BACKOFFS,
  BunQueue,
  type BunQueueEvents,
  type BunQueueOptions,
  BunQueueWorker,
  type BunQueueWorkerEvents,
  type BunQueueWorkerOptions,
  type DeadLetter,
  type DebounceOptions,
  DEFAULT_JOB_OPTIONS,
  defineProcessor,
  IsolatedProcessor,
  type IsolationMode,
  type IsolationOptions,
  Job,
  type JobBackoffOptions,
  JobBuilder,
  type JobBuilderOptions,
  type JobDefinition,
  type JobDefinitionOptions,
  JobDefinitions,
  type JobOptions,
  type JobProcessor,
  type NameLimits,
  nextOccurrence,
  type ProcessorContext,
  QueueLimiter,
  type QueueLimits,
  type RateLimit,
  type Repeatable,
  repeatJobId,
  repeatKeyFor,
  type RepeatOptions,
  resolveJobOptions,
  resolveRunAt,
  retentionExpiry,
  type RetryAllOptions,
  type StoredLimits,
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
export {
  type ConnectionInput,
  type ConnectionOptions,
  databaseFromUrl,
  resolveConnectionUrl,
  resolveNames,
  toConnectionUrl,
  type UrlDefaults,
} from "./shared/connection";

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
  RunKilledError,
  RunnerStoppedError,
  SerializationError,
  UnrecoverableJobError,
  WorkerClosedError,
} from "./shared/errors";
// Reading dates in phrases: the parser interface, and the chrono range.
export {
  assertDateParser,
  CHRONO_VERSION_RANGE,
  type DateParseComponent,
  type DateParseOptions,
  type DateParser,
  type DateParseResult,
} from "./shared/humanTime";
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
