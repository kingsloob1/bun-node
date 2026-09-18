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
 * The management API — an HTTP API and a live-events WebSocket over a
 * `BunJobs` context, with OpenAPI 3.1 and AsyncAPI 3.0 documents for
 * exactly what it routes. Mount it with `use(api.basePath, api.router)`.
 *
 * The DTOs and the socket's message types are exported because they are the
 * contract a client is written against, and the types the options reference
 * (`JobsApiCsrfOptions`, `OpenApiSecurityScheme`, …) because a consumer
 * compiling our source must be able to name them.
 * ------------------------------------------------------------------ */
export {
  type AsyncApiDocument,
  DEFAULT_JOBS_API_LIMITS,
  JOBS_API_ACTIONS,
  JOBS_API_MUTATIONS,
  JOBS_API_OPT_IN_ACTIONS,
  type JobsApi,
  type JobsApiAction,
  type JobsApiAuthorize,
  type JobsApiAuthorizeContext,
  type JobsApiAuthorizeResult,
  type JobsApiConfig,
  type JobsApiCsrfOptions,
  type JobsApiDocsOptions,
  type JobsApiLimits,
  type JobsApiMode,
  type JobsApiRouteInfo,
  type JobsApiSerializers,
  type JobsApiSocketData,
  type JobsApiWebSocket,
  type JobsApiWebSocketOptions,
  type OpenApiDocument,
  type OpenApiSecurityScheme,
} from "./api/config";
/** Job-id escaping for job channel names; also in the browser-safe contract. */
export { decodeJobId, encodeJobId } from "./api/contract/constants";
export { createJobsApi } from "./api/createJobsApi";
export { JOBS_API_PROTOCOL_VERSION } from "./api/routes/meta";
export type {
  ErrorDto,
  EventDto,
  JobDto,
  JobFlowDto,
  JobInclude,
  JobPageDto,
  MetaDto,
  PageDto,
  PageInfoDto,
  ProblemDto,
  ProblemIssueDto,
  QueueSummaryDto,
  RepeatableDto,
  RunnerInfoDto,
  RunRecordDto,
  WorkerDto,
} from "./api/serialize";
export {
  JOBS_API_WS_CLOSE,
  JOBS_API_WS_SUBPROTOCOL,
  type JobsApiAckMessage,
  type JobsApiAckRejection,
  type JobsApiClientMessage,
  type JobsApiErrorMessage,
  type JobsApiEventMessage,
  type JobsApiGapMessage,
  type JobsApiGapReason,
  type JobsApiHeartbeatMessage,
  type JobsApiHelloMessage,
  type JobsApiPingMessage,
  type JobsApiPongMessage,
  type JobsApiServerMessage,
  type JobsApiSubscribeMessage,
  type JobsApiUnsubscribeMessage,
  type JobsApiWsErrorCode,
} from "./api/ws/protocol";

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
  type ChildOutcome,
  type ChildRecordResult,
  type ClaimOptions,
  type ColumnRow,
  countQueues,
  createDriver,
  detectAdapter,
  dialectFor,
  type DriverCapabilities,
  type DriverConfig,
  type DriverEvent,
  type DriverLifecycle,
  emptyCounts,
  escapeLike,
  escapeRegExp,
  type ExecutionMode,
  type FailOutcome,
  FileDriver,
  type FileDriverOptions,
  findJobPage,
  findJobsByScan,
  getJobsByIds,
  getJobsByLoop,
  type IndexRow,
  JOB_STATES,
  type JobFilter,
  jobFilter,
  type JobFlow,
  type JobPage,
  type JobPatch,
  type JobQuery,
  type JobRecord,
  type JobRef,
  type JobsDriver,
  type JobState,
  listWorkerRecords,
  type LockInfo,
  matchesFilter,
  MemoryDriver,
  MONGO_COLLECTIONS,
  type MongoCollection,
  MongoDriver,
  type MongoDriverOptions,
  orderByIds,
  type PendingThroughput,
  type QueueDriver,
  type QueuedTrigger,
  type QueueRef,
  type QueueStateEntry,
  RedisDriver,
  type RedisDriverOptions,
  RedisKeys,
  registerWorkerRecord,
  removeWorkerRecord,
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
  sortWorkers,
  SQL_TABLES,
  type SqlAdapter,
  type SqlDialect,
  SqlDriver,
  type SqlDriverOptions,
  type SqlTable,
  type StoredSchedule,
  sumBuckets,
  sumStates,
  supportsWorkers,
  type SyncBackend,
  THROUGHPUT_BUCKET_MS,
  THROUGHPUT_FLUSH_MS,
  THROUGHPUT_RETENTION_MS,
  type ThroughputBucket,
  throughputBucket,
  ThroughputBuffer,
  type ThroughputWriteResult,
  WORKER_STATE_PREFIX,
  type WorkerInfo,
} from "./drivers/index";

// One stream of every event in a namespace.
export {
  JobsNotifier,
  type JobsNotifierEvents,
  type JobsNotifierOptions,
} from "./notifier";

export type { BackoffWarningFields } from "./queue/backoff";
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
  JobDraft,
  type JobOptions,
  type JobProcessor,
  type JobsPage,
  type ListJobsOptions,
  MAX_TIMER_MS,
  type NameLimits,
  nextOccurrence,
  type ProcessorContext,
  QueueLimiter,
  type QueueLimits,
  type QueueSummary,
  type QueueThroughput,
  type RateLimit,
  type Repeatable,
  type RepeatEveryOptions,
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

export type {
  IsolatedJob,
  IsolatedJobProcessor,
} from "./runner/executors/executor";

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

// Remote runner control: a runner registered by any process sharing the
// driver and namespace, reached through `BunRunnerManager.remote()`.
export {
  RemoteRunner,
  type RemoteRunnerInfo,
  type RemoteRunnerOptions,
  type RemoteRunRecord,
  type TruncatedRunResult,
} from "./runner/index";
export type {
  JobChannelErrorReply,
  JobChannelOperation,
  JobChannelReplies,
  JobChannelReply,
  JobChannelRequest,
  JobChannelValueReply,
} from "./runner/protocol";
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
  ChildFailedError,
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
export {
  type ErrorContext,
  NotSupportedError,
  ProtocolError,
} from "./shared/errors";
export { RunnerNotFoundError } from "./shared/errors";
export { runnerEvent } from "./shared/events";

// runner/shared types
//
// One contiguous block, kept last so a change here never collides with edits
// to the sections above. Sorting would scatter it among them by path, which is
// the one thing this block exists to avoid.

export type { RunnerControlAction } from "./shared/events";
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
export type { RunProgress } from "./shared/progress";
export {
  createTicker,
  nextFireDate,
  normalizeSchedule,
  type RunnerSchedule,
  type ScheduleInput,
  type Ticker,
  type TickerOptions,
} from "./shared/schedule";
