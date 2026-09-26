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
 *   recovery, repeatable jobs, debounce and throttle windows, and retention.
 *
 * Built across both:
 *
 * - **flows** — parent jobs that wait on children, with failures burying the
 *   parent unless a child is marked to be ignored;
 * - the **registry** (`BunJobs`): the per-service context that fixes the
 *   namespace and driver once and derives every runner, queue and worker from
 *   them, defines named jobs, holds the `processEvery` scheduling interval and
 *   saves drafts (`JobDraft`) for later;
 * - the **notifier** (`JobsNotifier`): driver-backed pub/sub, so an event
 *   raised in one process reaches listeners in another;
 * - the **read APIs**: what a management UI needs — paged and searchable job
 *   listings with totals, per-queue counts and summaries, batch reads by id,
 *   the live worker inventory and per-minute throughput.
 *
 * Backends: memory, file, Redis, SQL (PostgreSQL, MySQL, MariaDB, SQLite)
 * and MongoDB.
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
  type JobsApiListQueues,
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
/**
 * Reads by creation time: the job list's sorts (`ListJobsOptions.sort`, the
 * API's `?sort=`) and the widest range the added-by-state routes count over.
 * Also in the browser-safe contract.
 */
export {
  JOB_LIST_SORTS,
  type JobListSort,
  MAX_ADDED_BY_STATE_SPAN_MS,
} from "./api/contract/constants";
/* ------------------------------------------------------------------ *
 * Analytics — the bucket machinery every backend shares, the optional
 * driver methods it serves, and the contract's range limits.
 *
 * Public because a driver written outside this package implements the same
 * optional methods (`countRunnerRun`, `getQueueMetrics`, …) and must agree
 * with the built-in five on what a bucket, a merge and a range mean: the
 * types it answers with, the merge helpers that make several writers' rows
 * one bucket, the buffers that batch a second's counts, and the resolver a
 * route reads its answer through. The same precedent as the throughput
 * helpers above (`ThroughputBuffer`, `sumBuckets`). That includes the four
 * grouped reads (`getRunnerMetricsTotals`/`Many`,
 * `getWorkerMetricsTotals`/`Many`) — their query and row types, and the
 * helpers defining a row (`runnerTotalsOf`, `workerTotalsOf`,
 * `hasMetricBuckets`, `workerMetricsEntity`, …) — which the analytics routes
 * use only when a driver implements all four.
 * ------------------------------------------------------------------ */
export {
  ANALYTICS_PRESETS,
  ANALYTICS_RESOLUTIONS,
  type AnalyticsPreset,
  type AnalyticsResolution,
  DEFAULT_ANALYTICS_PRESET,
  DEFAULT_ANALYTICS_RESOLUTION,
  DEFAULT_SECOND_RETENTION_MS,
  DURATION_HISTOGRAM_BOUNDS,
  MAX_ANALYTICS_BUCKETS,
  MAX_ANALYTICS_ROWS,
  MAX_ANALYTICS_SERIES,
  MAX_ANALYTICS_SPAN_MS,
  MAX_SECOND_RETENTION_MS,
  MIN_ANALYTICS_SPAN_MS,
  MINUTE_BUCKET_MS,
  MINUTE_RETENTION_MS,
  SECOND_BUCKET_MS,
} from "./api/contract/constants";
/* ------------------------------------------------------------------ *
 * Queue job defaults: an override stored per queue, which every producer
 * adds under within `jobDefaultsRefreshInterval`, and the bounded rewrite of
 * jobs already pending (`BunQueue.getJobDefaults` / `setJobDefaults` /
 * `resetJobDefaults` / `applyJobDefaults`). Public because a driver written
 * outside this package implements `rewritePendingOptions` with the same
 * per-job rule (`planPendingRewrite`), request check and cursor helpers.
 *
 * The keys, bounds and apply states are the browser-safe contract's, so a
 * form is built from the very numbers the server enforces.
 * ------------------------------------------------------------------ */
export {
  JOB_DEFAULT_BACKOFF_TYPES,
  JOB_DEFAULT_KEYS,
  JOB_DEFAULTS_APPLY_STATES,
  JOB_DEFAULTS_BOUNDS,
  type JobDefaultBackoffType,
  type JobDefaultKey,
  type JobDefaultsApplyState,
} from "./api/contract/constants";
/**
 * Runner configuration from another process: the execution modes, the
 * settings an override may replace and the bounds on the numeric one — the
 * browser-safe contract's, beside `WORKER_CONFIG_KEYS`/`WORKER_CONFIG_BOUNDS`,
 * so a form is built from the very values an owner enforces. Their types are
 * `ExecutionMode` and `RunnerConfigKey`, exported with the drivers and the
 * runner.
 */
export {
  EXECUTION_MODES,
  RUNNER_CONFIG_BOUNDS,
  RUNNER_CONFIG_KEYS,
} from "./api/contract/constants";
export type {
  JobDefaultBackoff,
  JobDefaultsValues,
} from "./api/contract/types";
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
export {
  BunJobs,
  type BunJobsConfig,
  type BunJobsOptions,
  type JobDefinitionOf,
  jobsFromContext,
  type RegistryQueueOption,
  type RegistryWorker,
  type TypedJobDefinition,
} from "./BunJobs";

/* ------------------------------------------------------------------ *
 * Storage drivers — the contract both subsystems are built on, and the
 * backends implementing it.
 * ------------------------------------------------------------------ */
export {
  type AddedRange,
  type AttributionFilter,
  attributionFilter,
  attributionOf,
  canMatchState,
  type ChildOutcome,
  type ChildRecordResult,
  type ClaimOptions,
  type ClearJobLogsResult,
  type CollectionLike,
  type ColumnRow,
  compareCreated,
  compareJobKey,
  countAdded,
  countAddedByScan,
  countQueues,
  createDriver,
  type CursorPart,
  type CursorPartType,
  type DbLike,
  decodeHistoryCursor,
  decodeJobCursor,
  decodePageCursor,
  type DemandCounts,
  detectAdapter,
  dialectFor,
  type DriverCapabilities,
  type DriverConfig,
  type DriverEvent,
  type DriverLifecycle,
  type EditableJobOptionKey,
  emptyAddedCounts,
  emptyCounts,
  encodeHistoryCursor,
  encodeJobCursor,
  encodePageCursor,
  escapeLike,
  escapeRegExp,
  type ExecutionMode,
  type FailOutcome,
  FileDriver,
  type FileDriverOptions,
  type FilterLike,
  type FindCursorLike,
  findJobPage,
  findJobsByScan,
  FINISHED_STATES,
  getJobsByIds,
  getJobsByLoop,
  hasRange,
  HISTORY_CURSOR_PREFIX,
  holderOf,
  inAddedRange,
  type IndexDescriptionLike,
  type IndexRow,
  inFinishedRange,
  isAfterJob,
  JOB_LIST_CURSOR_PREFIX,
  JOB_STATES,
  type JobCursorKey,
  jobCursorKey,
  jobFieldValue,
  type JobFilter,
  jobFilter,
  type JobFlow,
  type JobListWalk,
  type JobOrderField,
  jobOrderFields,
  type JobPage,
  type JobPatch,
  type JobQuery,
  type JobRecord,
  type JobRef,
  type JobsDriver,
  type JobState,
  jobWalkIsSeekable,
  type JobWorkerRef,
  listWorkerRecords,
  type LockInfo,
  matchesAttribution,
  matchesFilter,
  matchesNothing,
  MemoryDriver,
  MONGO_COLLECTIONS,
  type MongoClientConstructor,
  type MongoClientLike,
  type MongoClientOptionsLike,
  type MongoCollection,
  MongoDriver,
  type MongoDriverOptions,
  type ObjectIdLike,
  orderByIds,
  pageRunHistory,
  type PendingOptionsRewrite,
  type PendingOptionsRewriteResult,
  type PendingThroughput,
  type PromoteDelayedResult,
  type PromotionRead,
  type QueueDemand,
  type QueueDriver,
  type QueuedTrigger,
  type QueueRef,
  type QueueStateEntry,
  rangeMatchesNothing,
  readHistoryPage,
  readPromotion,
  RedisDriver,
  type RedisDriverOptions,
  RedisKeys,
  refuseUnseekableWalk,
  registerWorkerRecord,
  removeWorkerRecord,
  type RepeatRecord,
  type ResolvedJobOptions,
  resolveDriver,
  type ResolvedSyncOptions,
  type Retention,
  type RunHistoryCursorKey,
  type RunHistoryPage,
  type RunHistoryQuery,
  type RunHistoryWalk,
  type RunLogAppendResult,
  type RunLogCaps,
  type RunLogInput,
  type RunLogLine,
  type RunLogPage,
  type RunLogQuery,
  type RunnerDriver,
  type RunRecord,
  type RunSource,
  type RunStatus,
  type SchemaChange,
  type SchemaSyncOptions,
  seekJobIndex,
  sortByCreated,
  sortsByCreated,
  sortWorkers,
  SQL_TABLES,
  type SqlAdapter,
  type SqlDialect,
  SqlDriver,
  type SqlDriverOptions,
  type SqlTable,
  type StoredJobOptions,
  type StoredSchedule,
  sumBuckets,
  sumStates,
  supportsAttributionQuery,
  supportsCreatedSort,
  supportsWorkers,
  type SyncBackend,
  THROUGHPUT_BUCKET_MS,
  THROUGHPUT_FLUSH_MS,
  THROUGHPUT_RETENTION_MS,
  type ThroughputBucket,
  throughputBucket,
  ThroughputBuffer,
  type ThroughputWriteResult,
  type UpdateFilterLike,
  type UpdateResultLike,
  usesAttribution,
  WORKER_STATE_PREFIX,
  type WorkerConfigInfo,
  type WorkerControlInfo,
  type WorkerInfo,
} from "./drivers/index";

export {
  addBusynessSample,
  addDuration,
  alignBucketRange,
  type AnalyticsRangeInput,
  assertBucketCount,
  bucketCount,
  type BucketRange,
  bucketStart,
  type BufferWriteResult,
  type BusynessSample,
  type BusynessStats,
  type BusynessSummary,
  type CounterBucket,
  type CounterSet,
  DEFAULT_ANALYTICS_SPAN_MS,
  DURATION_HISTOGRAM_SIZE,
  durationBin,
  type DurationStats,
  type DurationSummary,
  emptyBusynessBucket,
  emptyBusynessStats,
  emptyDurationBucket,
  emptyDurationStats,
  emptyHistogram,
  fillBuckets,
  hasMetricBuckets,
  histogramQuantile,
  JOB_COUNTERS,
  type JobCounters,
  mergeBusynessBuckets,
  mergeBusynessStats,
  mergeCounterBuckets,
  mergeDurationBuckets,
  mergeDurationStats,
  METRICS_RESOLUTIONS,
  MetricsBuffer,
  type MetricsLimits,
  type MetricsOptions,
  MetricsPruneClock,
  metricsPruneCutoff,
  type MetricsQuery,
  type MetricsRecording,
  metricsRetentionFor,
  type MetricsSupport,
  metricsSupportOf,
  MINUTE_INTERVALS,
  NAMESPACE_ENTITY,
  type NamespaceMetricKind,
  type NamespaceMetricsQuery,
  type NamespaceMetricsRead,
  PendingBuffer,
  type PendingMetric,
  type RawBusynessBucket,
  type RawDurationBucket,
  readBusyness,
  readDurations,
  resolveAnalyticsRange,
  type ResolvedAnalyticsRange,
  type ResolvedMetricsOptions,
  resolveMetricsOptions,
  RUNNER_RUN_COUNTERS,
  type RunnerMetricsQuery,
  type RunnerMetricsRead,
  type RunnerMetricsSeries,
  type RunnerMetricsTotals,
  type RunnerMetricsTotalsQuery,
  type RunnerRunCounters,
  type RunnerRunDelta,
  type RunnerRunTotals,
  runnerTotalsOf,
  SECOND_INTERVALS,
  splitWorkerMetricsEntity,
  totalBusynessStats,
  totalCounters,
  totalDurationStats,
  uniqueWorkerRefs,
  type WorkerJobTotals,
  workerMetricsEntity,
  type WorkerMetricsQuery,
  type WorkerMetricsRead,
  type WorkerMetricsRef,
  type WorkerMetricsSeries,
  type WorkerMetricsTotals,
  type WorkerMetricsTotalsQuery,
  workerTotalsOf,
  zeroCounters,
} from "./drivers/index";
// One stream of every event in a namespace.
export {
  JobsNotifier,
  type JobsNotifierEvents,
  type JobsNotifierOptions,
  type NotifierFollowSource,
} from "./notifier";

export type { BackoffWarningFields } from "./queue/backoff";
/* ------------------------------------------------------------------ *
 * The queue — producers, consumers and the job they exchange.
 * ------------------------------------------------------------------ */
export {
  type AdHocJobName,
  assertJobId,
  assertRepeatKey,
  assertWritableStateName,
  AttemptWrites,
  type BackoffContext,
  BackoffStrategies,
  type BackoffStrategy,
  BUILT_IN_BACKOFFS,
  type BulkEntriesOf,
  type BulkJobsOf,
  BunQueue,
  type BunQueueEvents,
  type BunQueueOptions,
  BunQueueWorker,
  type BunQueueWorkerEvents,
  type BunQueueWorkerOptions,
  CALLER_REPEAT_KEY_PREFIX,
  type ChildProcessTarget,
  type DataArgs,
  type DataField,
  type DeadLetter,
  DEBOUNCE_PREFIX,
  type DebounceOptions,
  DEFAULT_JOB_OPTIONS,
  defineProcessor,
  defineProcessors,
  displayRepeatKey,
  type FlowNode,
  type FlowNodeOf,
  type FlowResult,
  type ForeignFlowNode,
  type InProcessTarget,
  Job,
  type JobAddArgs,
  type JobBackoffOptions,
  JobBuilder,
  type JobBuilderOptions,
  type JobDataOf,
  type JobDefinition,
  type JobDefinitionOptions,
  JobDefinitions,
  JobDraft,
  type JobEntryData,
  type JobEntryResult,
  type JobEvent,
  type JobHandlerResultOf,
  type JobHooks,
  type JobMap,
  type JobMapData,
  type JobMapOf,
  type JobMapResult,
  type JobName,
  type JobOptions,
  type JobProcessor,
  type JobResultOf,
  type JobsPage,
  type JobsWalkPage,
  type JobTypeEntry,
  type JobUpdate,
  type ListJobsOptions,
  type LocalWorkerTarget,
  MAX_JOB_ID_LENGTH,
  MAX_REPEAT_KEY_LENGTH,
  MAX_TIMER_MS,
  type NameLimits,
  nextOccurrence,
  type ProcessorContext,
  type QueueEventsOf,
  type QueueJobOf,
  QueueLimiter,
  type QueueLimits,
  type QueueSummary,
  type QueueThroughput,
  type RateLimit,
  type RegistryBulkEntry,
  type RegistryFlowChild,
  type RegistryFlowNode,
  type RegistryQueue,
  type RegistryQueueEvents,
  type RegistryWorkerEvents,
  type Repeatable,
  type RepeatableInfo,
  type RepeatEveryOptions,
  repeatJobId,
  repeatKeyFor,
  type RepeatOptions,
  RESERVED_STATE_PREFIX,
  resolveJobOptions,
  resolveRunAt,
  retentionExpiry,
  type RetryAllOptions,
  type RetryAllOptionsOf,
  type RetryJobOf,
  shortenJobId,
  type StoredLimits,
  THROTTLE_PREFIX,
  toRepeatRecord,
  type TypedJob,
  type TypedJobName,
  type TypedJobProcessor,
  type UntypedJobName,
  type UpdateDataOf,
  type WhenDeclared,
  type WhenUndeclared,
  type WorkerConfigResult,
  type WorkerControlOptions,
  type WorkerControlResult,
  type WorkerEventsOf,
  type WorkerSelector,
  type WorkerTarget,
  type WorkerTargetAttempt,
  type WorkerTargetCloseOptions,
  type WorkerTargetContext,
  type WorkerTargetExecutor,
  type WorkerTargetFactory,
  type WorkerTargetMode,
  type WorkerThreadTarget,
} from "./queue/index";
/** Queue job defaults, the queue side: see the contract's keys and bounds above. */
export {
  ALL_JOB_OPTION_BITS,
  type ApplyJobDefaultsOptions,
  type ApplyJobDefaultsResult,
  assertRewriteRequest,
  decodeRewriteCursor,
  DEFAULT_JOB_DEFAULTS_REFRESH_MS,
  describeJobDefaults,
  emptyRewriteResult,
  encodeRewriteCursor,
  explicitKeys,
  explicitMaskOf,
  isJobDefaultKey,
  JOB_DEFAULTS_STATE,
  JOB_OPTION_BITS,
  jobDefaultIssue,
  JobDefaultsCache,
  JobDefaultsChangedError,
  type JobDefaultsEntry,
  type JobDefaultsInfo,
  type JobDefaultsPatch,
  type JobDefaultsStoredValues,
  type JobDefaultsUpdate,
  jobDefaultsValuesOf,
  type JobDefaultsWriteOptions,
  type JobDefaultsWriteResult,
  type JobOptionLayers,
  maskOfKeys,
  overlayJobDefaults,
  overriddenKeys,
  type PendingRewritePlan,
  planPendingRewrite,
  readJobDefaults,
  resetJobDefaults,
  resolveLayeredJobOptions,
  type RewritableJob,
  sameOptionValue,
  sanitizeJobDefaults,
  type StoredJobDefaults,
  supportsJobDefaults,
  tallyMoved,
  tallyRewrite,
  writeJobDefaults,
} from "./queue/index";

/* ------------------------------------------------------------------ *
 * Worker control from another process: what a worker can be asked to be, what
 * may be changed about it, and the controller that writes both.
 *
 * The constants are the single source the management API's browser-safe
 * contract mirrors — a UI builds its form from `WORKER_CONFIG_BOUNDS` rather
 * than from numbers typed a second time.
 * ------------------------------------------------------------------ */
export {
  deriveWorkerKey,
  incarnationTag,
  listWorkerConfigs,
  type LocalWorker,
  readWorkerConfig,
  readWorkerControl,
  readWorkerStop,
  removeWorkerControl,
  supportsWorkerControl,
  sweepWorkerControls,
  WORKER_CONFIG_PREFIX,
  WORKER_CONTROL_GRACE_LIFETIMES,
  WORKER_CONTROL_PREFIX,
  WORKER_CONTROL_SWEEP_LIMIT,
  WORKER_STOP_PREFIX,
  WORKER_STOP_TIMEOUT_MAX,
  type WorkerConfigEntry,
  workerConfigName,
  type WorkerConfigOverride,
  type WorkerControlEntry,
  WorkerController,
  WorkerControllerManager,
  type WorkerControllerOptions,
  workerControlName,
  type WorkerControlSweep,
  type WorkerStopEntry,
  workerStopName,
  workerStopTimeoutIssue,
  writeWorkerConfig,
  writeWorkerControl,
  writeWorkerStop,
} from "./queue/index";
export { WorkerStateConflictError } from "./queue/WorkerController";
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
  type ClearHistoryOptions,
  type ClearHistoryResult,
  clearRunnerHistory,
  createRedactor,
  DEFAULT_REDACT_KEYS,
  DEFAULT_REDACT_REPLACEMENT,
  DEFAULT_STALE_RUN_AFTER,
  defineHandler,
  describeRunnerConfig,
  type Executor,
  type ExecutorHandle,
  type ExecutorStartOptions,
  type HistoryClearInput,
  type HistoryClearPlan,
  InProcessExecutor,
  type InProcessOptions,
  isExecutionMode,
  isRunnerChild,
  type ParentToChild,
  planHistoryClear,
  PROTOCOL_VERSION,
  type ResolvedRunLogCaptureOptions,
  type ResolvedRunnerConfig,
  type ResolvedRunnerOptions,
  resolveRunnerConfig,
  type ResolveRunnerConfigInput,
  resolveRunnerOptions,
  type RunContext,
  type RunHandle,
  RunLogCapture,
  type RunLogCaptureInit,
  type RunLogCaptureOptions,
  type RunLogOptions,
  type RunLogRedactOptions,
  type RunLogRedactor,
  type RunLogTotals,
  RUNNER_CONFIG_STATE,
  type RunnerAllowedOverrides,
  runnerConfigFields,
  type RunnerConfigFieldsOptions,
  type RunnerConfigInfo,
  type RunnerConfigKey,
  type RunnerConfigPatch,
  runnerConfigResetFields,
  type RunnerConfigValues,
  type RunnerHandler,
  type RunnerInfo,
  type RunnerStats,
  type RunnerStatus,
  type RunOutcome,
  type SerializableContext,
  SpawnExecutor,
  type SpawnOptions,
  type StoredRunnerConfig,
  type StoredRunnerOverride,
  type TriggerOutcome,
  UNLIMITED_CONCURRENCY,
  WorkerExecutor,
  type WorkerOptions,
  writeRunnerConfig,
} from "./runner/index";

// Runner control from another process: a runner registered by any process
// sharing the driver and namespace, reached through
// `BunRunnerManager.controller()`.
export {
  RunnerController,
  type RunnerControllerOptions,
  type SharedRunnerInfo,
  type TruncatedRunResult,
  type TypedRunRecord,
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
export { runnerEvent, workerEvent } from "./shared/events";
export type { WorkerDriverEvent, WorkerEventPayloads } from "./shared/events";
export type { RunnerControlAction } from "./shared/events";

// runner/shared types
//
// One contiguous block, kept last so a change here never collides with edits
// to the sections above. Sorting would scatter it among them by path, which is
// the one thing this block exists to avoid.

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
export {
  isWorkerConfigKey,
  isWorkerState,
  WORKER_CONFIG_BOUNDS,
  WORKER_CONFIG_KEYS,
  WORKER_CONTROL_ACTIONS,
  WORKER_EVENT_TYPES,
  WORKER_STATES,
  WORKER_STOP_PERSISTENCE,
  WORKER_TARGET_KINDS,
  type WorkerConfigBound,
  workerConfigCrossFieldIssue,
  workerConfigIssue,
  type WorkerConfigKey,
  type WorkerConfigPatch,
  type WorkerConfigValues,
  type WorkerControlAction,
  type WorkerControlMode,
  type WorkerDesiredState,
  type WorkerEventName,
  type WorkerState,
  type WorkerStopPersistence,
  type WorkerSummonProvenance,
  type WorkerTargetInfo,
  type WorkerTargetKind,
} from "./shared/workers";

/* ------------------------------------------------------------------ *
 * Summoned workers: where a worker started on demand came from. A summoned
 * worker passes `summon: summonedFromArgs()`, and its heartbeat record says
 * so (`WorkerInfo.summon`, `WorkerDto.summon`).
 * ------------------------------------------------------------------ */
export {
  SUMMON_ARGS,
  type SummonedArgs,
  summonedFromArgs,
} from "./summon/args";

/* ------------------------------------------------------------------ *
 * Summoning: a controller that starts compute when a queue has work and no
 * worker, and the summoners it calls. Also at `@kingsleyweb/bun-jobs/summon`.
 * ------------------------------------------------------------------ */
export {
  defineSummoner,
  type DefineSummonerOptions,
  type PendingSummon,
  type ProviderApiVersions,
  type ProviderCallContext,
  type ProviderIdentity,
  type SummonCapabilities,
  type SummonCheckResult,
  SummonController,
  type SummonControllerEvents,
  type SummonControllerOptions,
  type SummonDedupe,
  type Summoner,
  type SummonerFunction,
  type SummonEventPayload,
  type SummonFacet,
  type SummonLastOutcome,
  type SummonMarker,
  type SummonOutcomeKind,
  type SummonPolicy,
  type SummonReason,
  type SummonReleaseRequest,
  type SummonRequest,
  type SummonResult,
  type SummonSkipReason,
  type SummonStatus,
  type UnitStatus,
} from "./summon/index";
