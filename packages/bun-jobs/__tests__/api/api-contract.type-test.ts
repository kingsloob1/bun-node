import type { LogLevel } from "@kingsleyweb/bun-common";
import type * as Root from "@kingsleyweb/bun-jobs";
import type * as Contract from "@kingsleyweb/bun-jobs/api/contract";
import type { JobsApi } from "../../lib/api/config";
import type { Infer } from "../../lib/api/schema/builder";
import type {
  analyticsRangeQuerySchema,
  AnalyticsRangeSchema,
  JobsSeriesSchema,
  OverviewAnalyticsSchema,
  RunnerAnalyticsSchema,
  runnersAnalyticsQuerySchema,
  RunnersAnalyticsSchema,
  WorkerAnalyticsSchema,
  workersAnalyticsQuerySchema,
  WorkersAnalyticsSchema,
} from "../../lib/api/schemas/analytics";
import type {
  ErrorDtoSchema,
  JobRefSchema,
  PageInfoSchema,
  ProblemSchema,
} from "../../lib/api/schemas/common";
import type {
  AddBodySchema,
  AddResultSchema,
  bulkBodySchema,
  bulkRetryBodySchema,
  ChildrenSchema,
  DefinitionListSchema,
  IncludeQuerySchema,
  JobFlowSchema,
  jobListQuerySchema,
  JobOptionsSchema,
  JobPageSchema,
  JobSchema,
  LogPageSchema,
  logsQuerySchema,
  lookupBodySchema,
  LookupResultSchema,
  RepeatableSchema,
  retryAllBodySchema,
  RetryAllResultSchema,
  RetryBodySchema,
  UpdateBodySchema,
} from "../../lib/api/schemas/jobs";
import type * as JobSchemas from "../../lib/api/schemas/jobs";
import type {
  MetaCsrfSchema,
  MetaLimitsSchema,
  MetaSchema,
  PermissionsQuerySchema,
  PermissionsSchema,
} from "../../lib/api/schemas/meta";
import type {
  addedByStateQuerySchema,
  AddedByStateSchema,
  applyJobDefaultsBodySchema,
  ApplyJobDefaultsResultSchema,
  cleanBodySchema,
  CleanResultSchema,
  CountResultSchema,
  DrainBodySchema,
  JobCountsSchema,
  JobDefaultsBodySchema,
  JobDefaultsSchema,
  JobDefaultsValuesSchema,
  minutesQuerySchema,
  OverviewSchema,
  PausedSchema,
  QueueDetailSchema,
  QueueLimitsInputSchema,
  queueListQuerySchema,
  QueueListSchema,
  QueueSummarySchema,
  ResetJobDefaultsQuerySchema,
  StoredLimitsSchema,
  ThroughputBucketSchema,
  ThroughputSchema,
} from "../../lib/api/schemas/queues";
import type {
  historyQuerySchema,
  HistorySchema,
  KillBodySchema,
  KillResultSchema,
  ResumeBodySchema,
  RunLogLineSchema,
  RunLogPageSchema,
  runLogsQuerySchema,
  RunnerConfigBodySchema,
  RunnerConfigSchema,
  RunnerConfigValuesSchema,
  RunnerInfoSchema,
  RunnerListSchema,
  RunnerPausedSchema,
  RunnerScheduleSchema,
  RunnerStatsSchema,
  RunRecordSchema,
  ScheduleBodySchema,
  ScheduleResultSchema,
  TriggerBodySchema,
  TriggerOutcomeSchema,
} from "../../lib/api/schemas/runners";
import type * as RunnerSchemas from "../../lib/api/schemas/runners";
import type {
  queueWorkerListQuerySchema,
  WorkerConfigBodySchema,
  WorkerConfigListSchema,
  WorkerConfigOverrideSchema,
  WorkerConfigResultSchema,
  WorkerConfigSchema,
  WorkerControlBodySchema,
  WorkerControlResultSchema,
  WorkerControlSchema,
  workerListQuerySchema,
  WorkerListSchema,
  WorkerSchema,
} from "../../lib/api/schemas/workers";
import type * as Server from "../../lib/api/serialize";
import type * as Ws from "../../lib/api/ws/events";
import type * as Protocol from "../../lib/api/ws/protocol";
import type {
  ClearJobLogsResult as DriverClearJobLogsResult,
  RunLogLine as DriverRunLogLine,
  RunLogPage as DriverRunLogPage,
  RunLogQuery as DriverRunLogQuery,
  ExecutionMode,
  WorkerConfigInfo,
  WorkerControlInfo,
} from "../../lib/drivers/driver";
import type { THROUGHPUT_BUCKET_MS } from "../../lib/drivers/readApis";
import type { JobState } from "../../lib/index";
import type { ClearHistoryResult as RunnerClearHistoryResult } from "../../lib/runner/clearHistory";
import type { RunnerConfigInfo } from "../../lib/runner/types";
import type { RunLogStream as SharedRunLogStream } from "../../lib/shared/constants";
import type {
  QueueEventName,
  RunnerEventName,
  WorkerEventPayloads,
} from "../../lib/shared/events";
import type * as Workers from "../../lib/shared/workers";

/**
 * Compile-time proof that the browser-safe contract
 * (`@kingsleyweb/bun-jobs/api/contract`) cannot drift from the server.
 *
 * Every named type in `lib/api/contract/types.ts` is hand-written — the
 * contract may import nothing — so each one is asserted here to be *equal*
 * (not merely assignable: assignability both ways misses a new optional
 * field) to the type its schema infers. A request type is compared after its
 * server defaults are applied (`Defaulted`), since a client may omit what the
 * server fills in. Checked by `tsc` (`scripts/typecheck.ts`), not `bun test`.
 *
 * Negative controls are `@ts-expect-error` lines: if the assertion under one
 * stopped failing, the directive itself would become the error.
 */

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

/** Flattens an intersection so {@link Equal} compares one plain shape. */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** A request type as the server sees it once its defaulted keys `K` are filled in. */
type Defaulted<T, K extends keyof T> = Simplify<
  Omit<T, K> & { [P in K]-?: Exclude<T[P], undefined> }
>;

/** Recursively flattens, so nested intersections compare as plain shapes. */
type Deep<T> = T extends (infer U)[]
  ? Deep<U>[]
  : T extends object
    ? { [K in keyof T]: Deep<T[K]> }
    : T;

/** Equality after flattening both sides all the way down. */
type DeepEqual<X, Y> = Equal<Deep<X>, Deep<Y>>;

/* --- shared ---------------------------------------------------------- */

export type ProblemOk = Expect<
  DeepEqual<Contract.ProblemDto, Infer<typeof ProblemSchema>>
>;
export type PageInfoOk = Expect<
  DeepEqual<Contract.PageInfoDto, Infer<typeof PageInfoSchema>>
>;
export type JobRefOk = Expect<
  DeepEqual<Contract.JobRefDto, Infer<typeof JobRefSchema>>
>;
// The schema cannot recurse, so `cause` is `unknown` there; the contract names
// it precisely. The two agree on everything else, and the contract fits.
export type ErrorOk = Expect<
  DeepEqual<
    Omit<Contract.ErrorDto, "cause">,
    Omit<Infer<typeof ErrorDtoSchema>, "cause">
  >
>;
export type ErrorFits = Expect<
  Contract.ErrorDto extends Infer<typeof ErrorDtoSchema> ? true : false
>;
export type ServerErrorOk = Expect<Equal<Server.ErrorDto, Contract.ErrorDto>>;

/* --- jobs ------------------------------------------------------------ */

// A schema that holds an `ErrorDto` holds its loose-`cause` form: compare
// with the contract's errors loosened the same way.
type LooseErrors<T> = T extends Contract.ErrorDto & { cause?: unknown }
  ? "cause" extends keyof T
    ? Omit<T, "cause"> & { cause?: unknown }
    : { [K in keyof T]: LooseErrors<T[K]> }
  : T extends (infer U)[]
    ? LooseErrors<U>[]
    : T extends object
      ? { [K in keyof T]: LooseErrors<T[K]> }
      : T;

/** Contract type vs schema type, errors compared in their schema form. */
type Matches<C, S> = DeepEqual<LooseErrors<C>, S>;

export type JobOptionsOk = Expect<
  Matches<Contract.JobOptionsDto, Infer<typeof JobOptionsSchema>>
>;
export type JobFlowOk = Expect<
  Matches<Contract.JobFlowDto, Infer<typeof JobFlowSchema>>
>;
export type JobOk = Expect<Matches<Contract.JobDto, Infer<typeof JobSchema>>>;
// `processedBy`'s own shape, pinned outright: required and nullable, like
// every other `JobDto` field — a job never claimed says `null` rather than
// leaving a client to tell an absent key from an old server.
export type JobProcessedByOk = Expect<
  Equal<Contract.JobDto["processedBy"], Contract.JobWorkerDto | null>
>;
// It names a worker exactly as the worker listing does: the same four fields
// with the same types and optionality as `WorkerDto`'s, so `host`/`pid` are
// the very fields `serialize.exposeHosts` governs there.
export type JobWorkerOk = Expect<
  Equal<
    Contract.JobWorkerDto,
    Pick<Contract.WorkerDto, "id" | "key" | "host" | "pid">
  >
>;
// And the holder keeps its meaning beside it.
export type JobWorkerIdOk = Expect<
  Equal<Contract.JobDto["workerId"], string | null>
>;
// Progress is typed on the wire, not `unknown`: the contract restates the
// package's `RunProgress` rather than importing it, and the two must agree.
export type RunProgressOk = Expect<
  Equal<Contract.RunProgress, Root.RunProgress>
>;
export type JobProgressOk = Expect<
  Equal<Contract.JobDto["progress"], Root.RunProgress | null>
>;
export type JobSchemaProgressOk = Expect<
  Equal<Infer<typeof JobSchema>["progress"], Root.RunProgress | null>
>;
export type JobPageOk = Expect<
  Matches<Contract.JobPageDto, Infer<typeof JobPageSchema>>
>;
export type LookupResultOk = Expect<
  Matches<Contract.LookupResultDto, Infer<typeof LookupResultSchema>>
>;
export type LogPageOk = Expect<
  Matches<Contract.LogPageDto, Infer<typeof LogPageSchema>>
>;
export type ChildrenOk = Expect<
  Matches<Contract.ChildrenDto, Infer<typeof ChildrenSchema>>
>;
export type AddResultOk = Expect<
  Matches<Contract.AddJobResultDto, Infer<typeof AddResultSchema>>
>;
export type RetryAllResultOk = Expect<
  Matches<Contract.RetryAllResultDto, Infer<typeof RetryAllResultSchema>>
>;
export type RepeatableOk = Expect<
  Matches<Contract.RepeatableDto, Infer<typeof RepeatableSchema>>
>;
export type DefinitionListOk = Expect<
  Matches<Contract.DefinitionListDto, Infer<typeof DefinitionListSchema>>
>;

// Whole, `sort` included: the schema serves it, defaulted to `"natural"`.
export type JobListQueryOk = Expect<
  DeepEqual<
    Defaulted<
      Contract.JobListQuery,
      "offset" | "limit" | "order" | "sort" | "total"
    >,
    Infer<ReturnType<typeof jobListQuerySchema>>
  >
>;
// The sort's own shape: one of the listed sorts, optional (the server defaults
// it to the natural order), and exactly the two the design settled.
export type JobListSortOk = Expect<
  Equal<Contract.JobListQuery["sort"], Contract.JobListSort | undefined>
>;
export type JobListSortsOk = Expect<
  Equal<Contract.JobListSort, "natural" | "createdAt">
>;
export type JobListSortsListOk = Expect<
  Equal<typeof Contract.JOB_LIST_SORTS, readonly ["natural", "createdAt"]>
>;
// The attribution filters' own shapes. The worker filters are repeatable exactly
// as the worker listing's `key` filter is; the range is the analytics
// convention's, `from` inclusive and `to` exclusive, over the same inputs.
export type JobListWorkerKeyOk = Expect<
  Equal<Contract.JobListQuery["workerKey"], Contract.WorkerListQuery["key"]>
>;
export type JobListWorkerIdOk = Expect<
  Equal<Contract.JobListQuery["workerId"], string[] | undefined>
>;
export type JobListFinishedFromOk = Expect<
  Equal<
    Contract.JobListQuery["finishedFrom"],
    Contract.AnalyticsRangeQuery["from"]
  >
>;
export type JobListFinishedToOk = Expect<
  Equal<Contract.JobListQuery["finishedTo"], Contract.AnalyticsRangeQuery["to"]>
>;
export type MaxJobFilterValuesOk = Expect<
  Equal<typeof Contract.MAX_JOB_FILTER_VALUES, 100>
>;
export type IncludeQueryOk = Expect<
  DeepEqual<Contract.IncludeQuery, Infer<typeof IncludeQuerySchema>>
>;
export type LogsQueryOk = Expect<
  DeepEqual<
    Defaulted<Contract.LogsQuery, "offset" | "limit" | "order">,
    Infer<ReturnType<typeof logsQuerySchema>>
  >
>;
export type LookupBodyOk = Expect<
  DeepEqual<Contract.LookupBody, Infer<ReturnType<typeof lookupBodySchema>>>
>;
export type UpdateBodyOk = Expect<
  DeepEqual<Contract.UpdateJobBody, Infer<typeof UpdateBodySchema>>
>;
export type RetryBodyOk = Expect<
  DeepEqual<
    Defaulted<Contract.RetryJobBody, "resetAttempts">,
    Infer<typeof RetryBodySchema>
  >
>;
export type BulkIdsBodyOk = Expect<
  DeepEqual<Contract.BulkIdsBody, Infer<ReturnType<typeof bulkBodySchema>>>
>;
export type BulkRetryBodyOk = Expect<
  DeepEqual<
    Defaulted<Contract.BulkRetryBody, "resetAttempts">,
    Infer<ReturnType<typeof bulkRetryBodySchema>>
  >
>;
export type RetryAllBodyOk = Expect<
  DeepEqual<
    Defaulted<Contract.RetryAllBody, "limit" | "resetAttempts">,
    Infer<ReturnType<typeof retryAllBodySchema>>
  >
>;
export type AddBodyOk = Expect<
  DeepEqual<Contract.AddJobBody, Infer<typeof AddBodySchema>>
>;

// The single-job and bulk results are built inline in `routes/jobs.ts`; their
// shapes are restated here exactly as the route builds them.
export type RetryResultShape = Expect<
  Equal<Contract.RetryJobResultDto, { retried: true }>
>;
export type PromoteResultShape = Expect<
  Equal<Contract.PromoteJobResultDto, { promoted: true }>
>;
export type BulkRetryResultShape = Expect<
  Equal<
    Deep<Contract.BulkRetryResultDto>,
    { retried: string[]; skipped: string[] }
  >
>;
export type BulkRemoveResultShape = Expect<
  Equal<
    Deep<Contract.BulkRemoveResultDto>,
    { removed: string[]; skipped: string[] }
  >
>;
export type BulkPromoteResultShape = Expect<
  Equal<
    Deep<Contract.BulkPromoteResultDto>,
    { promoted: string[]; skipped: string[] }
  >
>;

/* --- queues ---------------------------------------------------------- */

export type JobCountsOk = Expect<
  DeepEqual<Contract.JobCountsDto, Infer<typeof JobCountsSchema>>
>;
export type QueueSummaryOk = Expect<
  DeepEqual<Contract.QueueSummaryDto, Infer<typeof QueueSummarySchema>>
>;
export type QueueListOk = Expect<
  DeepEqual<Contract.QueueListDto, Infer<typeof QueueListSchema>>
>;
export type QueueListQueryOk = Expect<
  DeepEqual<
    Defaulted<Contract.QueueListQuery, "offset" | "limit">,
    Infer<ReturnType<typeof queueListQuerySchema>>
  >
>;
export type QueueLimitsOk = Expect<
  DeepEqual<Contract.QueueLimitsDto, Infer<typeof StoredLimitsSchema>>
>;
export type QueueLimitsBodyOk = Expect<
  DeepEqual<Contract.QueueLimitsBody, Infer<typeof QueueLimitsInputSchema>>
>;
export type QueueDetailOk = Expect<
  DeepEqual<Contract.QueueDetailDto, Infer<typeof QueueDetailSchema>>
>;
export type ThroughputBucketOk = Expect<
  DeepEqual<Contract.ThroughputBucketDto, Infer<typeof ThroughputBucketSchema>>
>;
export type QueueThroughputOk = Expect<
  DeepEqual<Contract.QueueThroughputDto, Infer<typeof ThroughputSchema>>
>;
export type MinutesQueryOk = Expect<
  DeepEqual<
    Defaulted<Contract.MinutesQuery, "minutes">,
    Infer<ReturnType<typeof minutesQuerySchema>>
  >
>;
// `OverviewSchema` declares `analytics` now that `/overview` serves it, so the
// whole shape compares — the temporary waiver that dropped the key is gone.
export type OverviewOk = Expect<
  DeepEqual<Contract.OverviewDto, Infer<typeof OverviewSchema>>
>;
// The added-by-state body and query compare whole against their schemas.
export type AddedByStateOk = Expect<
  DeepEqual<Contract.AddedByStateDto, Infer<typeof AddedByStateSchema>>
>;
// Queue job defaults: the read, both write bodies, the reset query and the
// apply answer, each whole against the schema its route validates with.
export type JobDefaultsValuesOk = Expect<
  DeepEqual<Contract.JobDefaultsValues, Infer<typeof JobDefaultsValuesSchema>>
>;
export type JobDefaultsOk = Expect<
  DeepEqual<Contract.JobDefaultsDto, Infer<typeof JobDefaultsSchema>>
>;
export type JobDefaultsPendingOk = Expect<
  DeepEqual<
    Contract.JobDefaultsPendingDto,
    Infer<typeof JobDefaultsSchema>["pending"]
  >
>;
export type JobDefaultsBodyOk = Expect<
  DeepEqual<Contract.JobDefaultsBody, Infer<typeof JobDefaultsBodySchema>>
>;
// Every editable key is in the body, and nothing else but `expectedSeq`.
export type JobDefaultsBodyKeysOk = Expect<
  Equal<keyof Contract.JobDefaultsBody, Contract.JobDefaultKey | "expectedSeq">
>;
export type ResetJobDefaultsQueryOk = Expect<
  DeepEqual<
    Contract.ResetJobDefaultsQuery,
    Infer<typeof ResetJobDefaultsQuerySchema>
  >
>;
export type ApplyJobDefaultsBodyOk = Expect<
  DeepEqual<
    Defaulted<
      Contract.ApplyJobDefaultsBody,
      "limit" | "dryRun" | "includeUnmarked"
    >,
    Infer<ReturnType<typeof applyJobDefaultsBodySchema>>
  >
>;
export type ApplyJobDefaultsResultOk = Expect<
  DeepEqual<
    Contract.ApplyJobDefaultsResultDto,
    Infer<typeof ApplyJobDefaultsResultSchema>
  >
>;
// `explicit` is the key-name list on the wire, never the stored number.
export type JobOptionsExplicitOk = Expect<
  Equal<
    Contract.JobOptionsDto["explicit"],
    Contract.JobDefaultKey[] | undefined
  >
>;
export type AddedByStateQuerySchemaOk = Expect<
  DeepEqual<
    Contract.AddedByStateQuery,
    Infer<ReturnType<typeof addedByStateQuerySchema>>
  >
>;
// And the shape the design settled, so a drift in both at once is caught too.
export type AddedByStateDtoOk = Expect<
  DeepEqual<
    Contract.AddedByStateDto,
    {
      from: number;
      to: number;
      at: number;
      counts: Contract.JobCountsDto;
      total: number;
      queues: number;
    }
  >
>;
// Its counts are the per-state counts every other count route answers — the
// one part of it a schema already pins.
export type AddedByStateCountsOk = Expect<
  DeepEqual<Contract.AddedByStateDto["counts"], Infer<typeof JobCountsSchema>>
>;
// The query is the analytics range without `resolution`: `from` inclusive,
// `to` exclusive, over the same inputs.
export type AddedByStateQueryOk = Expect<
  DeepEqual<
    Contract.AddedByStateQuery,
    Pick<Contract.AnalyticsRangeQuery, "from" | "to">
  >
>;
// The field itself: optional, and the analytics block when present.
export type OverviewAnalyticsFieldOk = Expect<
  Equal<
    Contract.OverviewDto["analytics"],
    Contract.OverviewAnalyticsDto | undefined
  >
>;
export type WorkerOk = Expect<
  DeepEqual<Contract.WorkerDto, Infer<typeof WorkerSchema>>
>;
export type WorkerListOk = Expect<
  DeepEqual<Contract.WorkerListDto, Infer<typeof WorkerListSchema>>
>;
export type WorkerConfigOk = Expect<
  DeepEqual<Contract.WorkerConfigDto, Infer<typeof WorkerConfigSchema>>
>;
export type WorkerControlOk = Expect<
  DeepEqual<Contract.WorkerControlDto, Infer<typeof WorkerControlSchema>>
>;
export type WorkerConfigOverrideOk = Expect<
  DeepEqual<
    Contract.WorkerConfigOverrideDto,
    Infer<typeof WorkerConfigOverrideSchema>
  >
>;
export type WorkerConfigListOk = Expect<
  DeepEqual<Contract.WorkerConfigListDto, Infer<typeof WorkerConfigListSchema>>
>;
export type WorkerListQueryOk = Expect<
  DeepEqual<
    // The path fixes the queue on the scoped listing, so only the
    // namespace-wide one carries a `queue` filter; `includeOffline` is
    // defaulted by the server.
    Defaulted<Contract.WorkerListQuery, "includeOffline">,
    Infer<ReturnType<typeof workerListQuerySchema>>
  >
>;
export type WorkerScopedListQueryOk = Expect<
  DeepEqual<
    Defaulted<Omit<Contract.WorkerListQuery, "queue">, "includeOffline">,
    Infer<ReturnType<typeof queueWorkerListQuerySchema>>
  >
>;
export type WorkerControlBodyOk = Expect<
  DeepEqual<Contract.WorkerControlBody, Infer<typeof WorkerControlBodySchema>>
>;
export type WorkerControlResultOk = Expect<
  DeepEqual<
    Contract.WorkerControlResultDto,
    Infer<typeof WorkerControlResultSchema>
  >
>;
export type WorkerConfigBodyOk = Expect<
  DeepEqual<Contract.WorkerConfigBody, Infer<typeof WorkerConfigBodySchema>>
>;
export type WorkerConfigResultOk = Expect<
  DeepEqual<
    Contract.WorkerConfigResultDto,
    Infer<typeof WorkerConfigResultSchema>
  >
>;
/*
 * Beside the schema comparisons above, these assert the contract against
 * *itself*: invariants a client relies on that no single schema states. Each
 * one is a real constraint — a setting added to `WORKER_CONFIG_KEYS` without
 * its body field, or a persistence field typed loosely, fails here.
 */

/** Every editable setting is carried by the values record, and nothing else is. */
export type WorkerConfigValuesOk = Expect<
  Equal<keyof Contract.WorkerConfigValues, Contract.WorkerConfigKey>
>;
/** The patch body is exactly those settings plus the compare-and-set token. */
export type WorkerConfigBodyKeysOk = Expect<
  Equal<
    keyof Contract.WorkerConfigBody,
    Contract.WorkerConfigKey | "expectedSeq"
  >
>;
/** And every setting on it is nullable, so one key's override can be cleared. */
export type WorkerConfigBodyValuesOk = Expect<
  Equal<
    Contract.WorkerConfigBody[Contract.WorkerConfigKey],
    number | null | undefined
  >
>;
/** A caller can only ask for a settled state: `stopping`/`restarting` are transients. */
export type WorkerDesiredOk = Expect<
  Equal<
    Contract.WorkerControlResultDto["desired"],
    "running" | "paused" | "stopped"
  >
>;
/**
 * Stop persistence is one type in all three places: what the worker reports,
 * what a request may ask for, and what actually applied.
 */
export type WorkerStopPersistenceOk = Expect<
  Equal<
    [
      Contract.WorkerControlDto["stopPersistence"],
      Contract.WorkerControlDto["stopPersistenceOverridable"],
      Contract.WorkerControlBody["persist"],
      Contract.WorkerControlResultDto["persisted"],
    ],
    [
      Contract.WorkerStopPersistence,
      boolean,
      Contract.WorkerStopPersistence | undefined,
      Contract.WorkerStopPersistence | undefined,
    ]
  >
>;
/** `overridden` names settings, never free strings. */
export type WorkerOverriddenOk = Expect<
  Equal<Contract.WorkerConfigDto["overridden"], Contract.WorkerConfigKey[]>
>;
/** A worker's `state` and the list are one thing. */
export type WorkerStateOk = Expect<
  Equal<Contract.WorkerDto["state"], Contract.WorkerState | undefined>
>;
/** The list's `offline` rows are the same override shape the config routes answer with. */
export type WorkerOfflineOk = Expect<
  Equal<
    Contract.WorkerListDto["offline"],
    Contract.WorkerConfigOverrideDto[] | undefined
  >
>;
/** A runner's override covers exactly the three settings the list names. */
export type RunnerConfigValuesOk = Expect<
  Equal<keyof Contract.RunnerConfigValues, Contract.RunnerConfigKey>
>;
export type RunnerConfigKeyOk = Expect<
  Equal<Contract.RunnerConfigKey, (typeof Contract.RUNNER_CONFIG_KEYS)[number]>
>;
/** The execution modes are one list: the union is read off it, not restated. */
export type ExecutionModeOk = Expect<
  Equal<Contract.ExecutionModeDto, (typeof Contract.EXECUTION_MODES)[number]>
>;
/** And they are the runner subsystem's own three. */
export type ExecutionModeRuntimeOk = Expect<
  Equal<Contract.ExecutionModeDto, ExecutionMode>
>;
/** Only the numeric setting is bounded; the other two are enumerations. */
export type RunnerBoundsKeysOk = Expect<
  Equal<keyof typeof Contract.RUNNER_CONFIG_BOUNDS, "maxConcurrency">
>;
export type RunnerBoundsShapeOk = Expect<
  Equal<
    (typeof Contract.RUNNER_CONFIG_BOUNDS)["maxConcurrency"],
    (typeof Contract.WORKER_CONFIG_BOUNDS)[Contract.WorkerConfigKey]
  >
>;
/** `maxConcurrency` only exists on the `parallel` arm, so `single` cannot carry one. */
export type RunnerConcurrencyOk = Expect<
  Equal<
    Contract.RunnerConfigBody["concurrency"],
    | { runMode: "single" }
    | { runMode: "parallel"; maxConcurrency: number | null }
    | null
    | undefined
  >
>;
/** And a runner snapshot carries it, optionally. */
export type RunnerInfoConfigOk = Expect<
  Equal<Contract.RunnerInfoDto["config"], Contract.RunnerConfigDto | undefined>
>;

export type PausedOk = Expect<
  DeepEqual<Contract.QueuePausedDto, Infer<typeof PausedSchema>>
>;
export type DrainBodyOk = Expect<
  DeepEqual<
    Defaulted<Contract.DrainQueueBody, "delayed">,
    Infer<typeof DrainBodySchema>
  >
>;
export type CountResultOk = Expect<
  DeepEqual<Contract.CountResultDto, Infer<typeof CountResultSchema>>
>;
export type CleanBodyOk = Expect<
  DeepEqual<
    Defaulted<Contract.CleanQueueBody, "limit">,
    Infer<ReturnType<typeof cleanBodySchema>>
  >
>;
export type CleanResultOk = Expect<
  DeepEqual<Contract.CleanResultDto, Infer<typeof CleanResultSchema>>
>;

/* --- runners --------------------------------------------------------- */

export type RunRecordOk = Expect<
  Matches<Contract.RunRecordDto, Infer<typeof RunRecordSchema>>
>;
// The two run-log counters, pinned on the contract side as well as compared
// against the schema above: optional, and a plain count when present. The
// optionality is the load-bearing part — absent means the backend stores no
// run logs at all, `0` means the run was quiet, so neither may be defaulted.
export type RunRecordLogLinesOk = Expect<
  Equal<Contract.RunRecordDto["logLines"], number | undefined>
>;
export type RunRecordLogsDroppedOk = Expect<
  Equal<Contract.RunRecordDto["logsDropped"], number | undefined>
>;
export type RunnerScheduleOk = Expect<
  DeepEqual<Contract.RunnerScheduleDto, Infer<typeof RunnerScheduleSchema>>
>;
export type RunnerStatsOk = Expect<
  DeepEqual<Contract.RunnerStatsDto, Infer<typeof RunnerStatsSchema>>
>;
export type RunnerInfoOk = Expect<
  Matches<Contract.RunnerInfoDto, Infer<typeof RunnerInfoSchema>>
>;
export type RunnerConfigValuesSchemaOk = Expect<
  DeepEqual<Contract.RunnerConfigValues, Infer<typeof RunnerConfigValuesSchema>>
>;
export type RunnerConfigOk = Expect<
  DeepEqual<Contract.RunnerConfigDto, Infer<typeof RunnerConfigSchema>>
>;
export type RunnerConfigBodyOk = Expect<
  DeepEqual<Contract.RunnerConfigBody, Infer<typeof RunnerConfigBodySchema>>
>;
// The DTO is the runtime's own record, as a worker's config block is: the
// route hands `RunnerConfigInfo` straight out, so the two must be equal.
export type RunnerConfigInfoOk = Expect<
  DeepEqual<Contract.RunnerConfigDto, RunnerConfigInfo>
>;
export type RunnerListOk = Expect<
  DeepEqual<Contract.RunnerListDto, Infer<typeof RunnerListSchema>>
>;
export type RunnerHistoryOk = Expect<
  Matches<Contract.RunnerHistoryDto, Infer<typeof HistorySchema>>
>;

/* --- run logs --------------------------------------------------------- */

// The contract restates the runtime's stream table and bun-common's levels,
// because it may import neither. Restatements have to be the *same* types, not
// two lists that happen to read alike today.
export type RunLogStreamOk = Expect<
  Equal<Contract.RunLogStream, SharedRunLogStream>
>;
export type RunLogLevelOk = Expect<Equal<Contract.RunLogLevel, LogLevel>>;
// The line the store keeps and the line the wire carries are the same fields,
// with the store's `text` named `message` for a client.
export type RunLogLineOk = Expect<
  Equal<Omit<Contract.RunLogLineDto, "message">, Omit<DriverRunLogLine, "text">>
>;
export type RunLogLineMessageOk = Expect<
  Equal<Contract.RunLogLineDto["message"], DriverRunLogLine["text"]>
>;
// The query the route takes, once its defaults are applied, is the query the
// driver is asked — so a `since`/`stream` tail means the same at both ends.
export type RunLogsQueryOk = Expect<
  DeepEqual<
    Defaulted<Contract.RunLogsQuery, "offset" | "limit" | "order">,
    DriverRunLogQuery
  >
>;
// The page's three run-wide numbers are the driver's own, not the page's.
export type RunLogPageCountersOk = Expect<
  DeepEqual<
    Pick<Contract.RunLogPageDto, "dropped" | "lastSeq">,
    Pick<DriverRunLogPage, "dropped" | "lastSeq">
  >
>;
// `capped` and `live` are the route's, not the store's: nothing in the driver
// page reports them, which is why they are named here and not compared.
export type RunLogPageCappedOk = Expect<
  Equal<Contract.RunLogPageDto["capped"], boolean>
>;
export type RunLogPageLiveOk = Expect<
  Equal<Contract.RunLogPageDto["live"], boolean>
>;
// …and the same three against the route's own schemas and serializer, so the
// wire cannot drift from the contract in either direction.
export type RunLogLineSchemaOk = Expect<
  DeepEqual<Contract.RunLogLineDto, Infer<typeof RunLogLineSchema>>
>;
export type RunLogPageSchemaOk = Expect<
  DeepEqual<Contract.RunLogPageDto, Infer<typeof RunLogPageSchema>>
>;
export type RunLogsQuerySchemaOk = Expect<
  DeepEqual<
    Defaulted<Contract.RunLogsQuery, "offset" | "limit" | "order">,
    Infer<ReturnType<typeof runLogsQuerySchema>>
  >
>;
// The serializer emits exactly the DTO: the `text` → `message` rename is the
// only difference between the store's line and the wire's, and it happens here.
export type RunLogLineSerializedOk = Expect<
  Equal<ReturnType<typeof Server.toRunLogLineDto>, Contract.RunLogLineDto>
>;
export type HistoryQueryOk = Expect<
  DeepEqual<
    Defaulted<Contract.HistoryQuery, "limit">,
    Infer<ReturnType<typeof historyQuerySchema>>
  >
>;
export type TriggerBodyOk = Expect<
  DeepEqual<Contract.TriggerRunnerBody, Infer<typeof TriggerBodySchema>>
>;
export type TriggerOutcomeOk = Expect<
  DeepEqual<Contract.TriggerOutcomeDto, Infer<typeof TriggerOutcomeSchema>>
>;
export type RunnerPausedOk = Expect<
  DeepEqual<Contract.RunnerPausedDto, Infer<typeof RunnerPausedSchema>>
>;
export type ResumeBodyOk = Expect<
  DeepEqual<
    Defaulted<Contract.ResumeRunnerBody, "triggerNow">,
    Infer<typeof ResumeBodySchema>
  >
>;
export type KillBodyOk = Expect<
  DeepEqual<
    Defaulted<Contract.KillRunnerBody, "force" | "wait">,
    Infer<typeof KillBodySchema>
  >
>;
export type KillResultOk = Expect<
  DeepEqual<Contract.KillResultDto, Infer<typeof KillResultSchema>>
>;
export type ScheduleBodyOk = Expect<
  DeepEqual<Contract.ScheduleRunnerBody, Infer<typeof ScheduleBodySchema>>
>;
export type ScheduleResultOk = Expect<
  DeepEqual<Contract.ScheduleResultDto, Infer<typeof ScheduleResultSchema>>
>;

/* --- analytics and time ranges --------------------------------------- */

// The minute the contract names is the minute the runtime buckets by. Both
// are literal-typed constants, so this is a compile-time pin of the *value*,
// not merely of `number` — the same guarantee the run-log tables get, for the
// one number a chart's axis and the driver's storage must agree on.
export type MinuteBucketMsOk = Expect<
  Equal<typeof Contract.MINUTE_BUCKET_MS, typeof THROUGHPUT_BUCKET_MS>
>;
export type SecondBucketMsOk = Expect<
  Equal<typeof Contract.SECOND_BUCKET_MS, 1000>
>;
type MinuteIsSecond = Equal<
  typeof Contract.MINUTE_BUCKET_MS,
  typeof Contract.SECOND_BUCKET_MS
>;
// @ts-expect-error — the pin above compares values: two different widths are
// two different types, so a drift would not slip through as `number`.
export type MinuteIsSecondCaught = Expect<MinuteIsSecond>;

// The wire's resolutions are a closed set, on the request as on the response:
// `resolution` is a hint about fineness, not an arbitrary number of seconds.
export type AnalyticsResolutionOk = Expect<
  Equal<Contract.AnalyticsResolution, 1 | 60>
>;
export type AnalyticsQueryResolutionOk = Expect<
  Equal<
    Contract.AnalyticsRangeQuery["resolution"],
    Contract.AnalyticsResolution | undefined
  >
>;
export type AnalyticsServedResolutionOk = Expect<
  Equal<Contract.AnalyticsRangeDto["resolution"], Contract.AnalyticsResolution>
>;
// @ts-expect-error — 30 s is not a resolution the API serves.
export const badResolution: Contract.AnalyticsRangeQuery = { resolution: 30 };

export type AnalyticsPresetOk = Expect<
  Equal<Contract.AnalyticsPreset, 60 | 300 | 600 | 1800 | 3600 | 21600 | 86400>
>;
// @ts-expect-error — a span that is not one of the offered presets.
export const badPreset: Contract.AnalyticsPreset = 120;

// The three instants of a served range are all plain epoch milliseconds — the
// difference between them is meaning, not type, which is exactly why each one
// says in its JSDoc whether it is a start, the last bucket, or the exclusive
// end.
export type AnalyticsRangeInstantsOk = Expect<
  Equal<
    Pick<Contract.AnalyticsRangeDto, "from" | "to" | "end">,
    { from: number; to: number; end: number }
  >
>;
export type AnalyticsClampReasonOk = Expect<
  Equal<
    Contract.AnalyticsClampReason,
    "retention" | "maxBuckets" | "resolution" | "driver"
  >
>;
export type AnalyticsClampedOk = Expect<
  Equal<
    Pick<Contract.AnalyticsRangeDto, "clamped" | "reason">,
    { clamped: boolean; reason?: Contract.AnalyticsClampReason }
  >
>;
// What was asked for is echoed, and only the resolution may be absent.
export type AnalyticsRequestedOk = Expect<
  Equal<
    Contract.AnalyticsRangeDto["requested"],
    Contract.AnalyticsRangeRequestedDto
  >
>;
export type AnalyticsRequestedShapeOk = Expect<
  Equal<
    Contract.AnalyticsRangeRequestedDto,
    { from: number; to: number; resolution?: Contract.AnalyticsResolution }
  >
>;

// Every analytics wire type against the schema its route validates with.
// `WorkerAnalyticsSeriesDto` and friends are reached through the envelopes.
export type AnalyticsRangeQueryOk = Expect<
  DeepEqual<
    Contract.AnalyticsRangeQuery,
    Infer<ReturnType<typeof analyticsRangeQuerySchema>>
  >
>;
export type RunnersAnalyticsQueryOk = Expect<
  DeepEqual<
    Contract.RunnersAnalyticsQuery,
    Infer<ReturnType<typeof runnersAnalyticsQuerySchema>>
  >
>;
export type WorkersAnalyticsQueryOk = Expect<
  DeepEqual<
    Contract.WorkersAnalyticsQuery,
    Infer<ReturnType<typeof workersAnalyticsQuerySchema>>
  >
>;
export type AnalyticsRangeSchemaOk = Expect<
  DeepEqual<Contract.AnalyticsRangeDto, Infer<typeof AnalyticsRangeSchema>>
>;
export type JobsSeriesSchemaOk = Expect<
  DeepEqual<
    Contract.AnalyticsSeriesDto<Contract.JobsBucketDto, Contract.JobsTotalsDto>,
    Infer<typeof JobsSeriesSchema>
  >
>;
export type RunnersAnalyticsSchemaOk = Expect<
  DeepEqual<Contract.RunnersAnalyticsDto, Infer<typeof RunnersAnalyticsSchema>>
>;
export type WorkersAnalyticsSchemaOk = Expect<
  DeepEqual<Contract.WorkersAnalyticsDto, Infer<typeof WorkersAnalyticsSchema>>
>;
export type RunnerAnalyticsSchemaOk = Expect<
  DeepEqual<Contract.RunnerAnalyticsDto, Infer<typeof RunnerAnalyticsSchema>>
>;
export type WorkerAnalyticsSchemaOk = Expect<
  DeepEqual<Contract.WorkerAnalyticsDto, Infer<typeof WorkerAnalyticsSchema>>
>;
export type OverviewAnalyticsSchemaOk = Expect<
  DeepEqual<
    Contract.OverviewAnalyticsDto,
    Infer<typeof OverviewAnalyticsSchema>
  >
>;
type WorkerSchemaIsRunner = DeepEqual<
  Contract.RunnerAnalyticsDto,
  Infer<typeof WorkerAnalyticsSchema>
>;
// @ts-expect-error — the pins compare shapes: the worker envelope is not the
// runner one, so a schema served under the wrong route would be caught.
export type WorkerSchemaIsRunnerCaught = Expect<WorkerSchemaIsRunner>;

// The jobs bucket is the shape `GET /queues/:queue/throughput` already ships,
// restated with resolution-neutral wording — the analytics routes supersede
// that one, so the two must stay the same three fields.
export type JobsBucketMatchesShippedOk = Expect<
  Equal<Contract.JobsBucketDto, Contract.ThroughputBucketDto>
>;
type JobsBucketIsRunnerRuns = Equal<
  Contract.JobsBucketDto,
  Contract.RunnerRunsBucketDto
>;
// @ts-expect-error — the equality above is a real comparison: a bucket with
// other fields is not the jobs bucket.
export type JobsBucketIsRunnerRunsCaught = Expect<JobsBucketIsRunnerRuns>;

// Every series' totals are its bucket without the instant: one shape to sum
// into, and a field added to a bucket and not to its totals is caught here.
export type JobsTotalsOk = Expect<
  Equal<Omit<Contract.JobsBucketDto, "at">, Contract.JobsTotalsDto>
>;
export type RunnerRunsTotalsOk = Expect<
  Equal<Omit<Contract.RunnerRunsBucketDto, "at">, Contract.RunnerRunsTotalsDto>
>;
export type WorkerJobsTotalsOk = Expect<
  Equal<Omit<Contract.WorkerJobsBucketDto, "at">, Contract.WorkerJobsTotalsDto>
>;
export type WorkerBusynessTotalsOk = Expect<
  Equal<
    Omit<Contract.WorkerBusynessBucketDto, "at">,
    Contract.WorkerBusynessTotalsDto
  >
>;
// Durations are the exception: the raw histogram is per bucket, and the totals
// carry the quantiles read off it rather than the array.
export type RunnerDurationTotalsOk = Expect<
  Equal<
    Omit<Contract.RunnerDurationBucketDto, "at" | "histogram">,
    Contract.RunnerDurationTotalsDto
  >
>;
export type RunnerDurationHistogramOk = Expect<
  Equal<Contract.RunnerDurationBucketDto["histogram"], number[] | undefined>
>;

// "Running now" is instantaneous state read from the locks, so it is a scalar
// on the roll-up and on each row — and deliberately not a bucket field.
export type OverviewRunningNowOk = Expect<
  Equal<Contract.OverviewRunnersAnalyticsDto["runningNow"], number>
>;
export type RunnerRowRunningNowOk = Expect<
  Equal<Contract.RunnerAnalyticsRowDto["runningNow"], number>
>;
// A bucket counts events over an interval; being in flight is not one, so no
// bucket may carry it.
type RunningNowIsBucketed =
  "runningNow" extends keyof Contract.RunnerRunsBucketDto ? true : false;
// @ts-expect-error — `runningNow` is a scalar, never a bucket field.
export type RunningNowIsBucketedCaught = Expect<RunningNowIsBucketed>;

// A worker row is keyed by the stable key. Keyed by the incarnation id, a
// rolling redeploy would end one series and start another.
export type WorkerRowKeysOk = Expect<
  Equal<
    keyof Contract.WorkerAnalyticsRowDto,
    "key" | "queue" | "totals" | "busyness"
  >
>;
declare const workerRow: Contract.WorkerAnalyticsRowDto;
export const workerRowKey: string = workerRow.key;
// @ts-expect-error — never the incarnation id.
export const workerRowId = workerRow.id;

// The overview's sections: one summed series, a capped page of scalar rows,
// and whether there were more.
export type OverviewJobsSeriesOk = Expect<
  Equal<
    Contract.OverviewAnalyticsDto["jobs"],
    Contract.AnalyticsSeriesDto<Contract.JobsBucketDto, Contract.JobsTotalsDto>
  >
>;
export type OverviewRunnersSeriesOk = Expect<
  Equal<
    Contract.OverviewRunnersAnalyticsDto["series"],
    Contract.AnalyticsSeriesDto<
      Contract.RunnerRunsBucketDto,
      Contract.RunnerRunsTotalsDto
    >
  >
>;
export type OverviewWorkersSeriesOk = Expect<
  Equal<
    Contract.OverviewWorkersAnalyticsDto["series"],
    Contract.AnalyticsSeriesDto<
      Contract.WorkerJobsBucketDto,
      Contract.WorkerJobsTotalsDto
    >
  >
>;
export type OverviewRowsOk = Expect<
  Equal<
    [
      Contract.OverviewRunnersAnalyticsDto["rows"],
      Contract.OverviewRunnersAnalyticsDto["truncated"],
      Contract.OverviewWorkersAnalyticsDto["rows"],
      Contract.OverviewWorkersAnalyticsDto["truncated"],
    ],
    [
      Contract.RunnerAnalyticsRowDto[],
      boolean,
      Contract.WorkerAnalyticsRowDto[],
      boolean,
    ]
  >
>;
// Both sections are optional: a backend may record jobs and neither of them.
export type OverviewAnalyticsShapeOk = Expect<
  Equal<
    Contract.OverviewAnalyticsDto,
    {
      range: Contract.AnalyticsRangeDto;
      jobs: Contract.AnalyticsSeriesDto<
        Contract.JobsBucketDto,
        Contract.JobsTotalsDto
      >;
      runners?: Contract.OverviewRunnersAnalyticsDto;
      workers?: Contract.OverviewWorkersAnalyticsDto;
    }
  >
>;

// A capped listing says how much it capped: `truncated` alone cannot write
// "showing the 100 busiest of 214". Required, not optional — every route that
// caps knows the number, it is the length of a list it is already holding.
export type OverviewRowTotalsOk = Expect<
  Equal<
    [
      Contract.OverviewRunnersAnalyticsDto["totalRows"],
      Contract.OverviewWorkersAnalyticsDto["totalRows"],
    ],
    [number, number]
  >
>;
type RowTotalOptional = Equal<
  Contract.OverviewRunnersAnalyticsDto["totalRows"],
  number | undefined
>;
// @ts-expect-error — `totalRows` is always sent: a caption that appears only
// on some responses is a caption nobody writes.
export type RowTotalOptionalCaught = Expect<RowTotalOptional>;

// The batch endpoints are the overview's own sections plus the series for the
// page on screen, so they are declared as exactly that — a restatement is how
// the two would drift apart.
export type RunnersAnalyticsShapeOk = Expect<
  DeepEqual<
    Contract.RunnersAnalyticsDto,
    Simplify<
      Contract.OverviewRunnersAnalyticsDto & {
        seriesByRunner?: Contract.RunnerAnalyticsSeriesDto[];
      }
    >
  >
>;
export type WorkersAnalyticsShapeOk = Expect<
  DeepEqual<
    Contract.WorkersAnalyticsDto,
    Simplify<
      Contract.OverviewWorkersAnalyticsDto & {
        seriesByKey?: Contract.WorkerAnalyticsSeriesDto[];
      }
    >
  >
>;
type RunnersAnalyticsIsTheSection = Equal<
  Contract.RunnersAnalyticsDto,
  Contract.OverviewRunnersAnalyticsDto
>;
// @ts-expect-error — the envelope really does add the batch: the equality
// above is not satisfied by the section alone.
export type RunnersSectionCaught = Expect<RunnersAnalyticsIsTheSection>;

// A batch entry carries the sparkline and the identity to join it on, and
// nothing else: durations and busyness are the detail routes' job.
export type RunnerAnalyticsSeriesOk = Expect<
  Equal<
    Contract.RunnerAnalyticsSeriesDto,
    {
      runner: string;
      runs: Contract.AnalyticsSeriesDto<
        Contract.RunnerRunsBucketDto,
        Contract.RunnerRunsTotalsDto
      >;
    }
  >
>;
export type WorkerAnalyticsSeriesOk = Expect<
  Equal<
    Contract.WorkerAnalyticsSeriesDto,
    {
      key: string;
      queue: string;
      jobs: Contract.AnalyticsSeriesDto<
        Contract.WorkerJobsBucketDto,
        Contract.WorkerJobsTotalsDto
      >;
    }
  >
>;
declare const workerSeries: Contract.WorkerAnalyticsSeriesDto;
export const workerSeriesKey: string = workerSeries.key;
// @ts-expect-error — keyed by the stable key, never the incarnation id: a
// rolling redeploy would otherwise end one series and start another.
export const workerSeriesId = workerSeries.id;

// One runner's detail: the runs series, the instantaneous scalar, and the
// durations when they are recorded.
export type RunnerAnalyticsOk = Expect<
  Equal<
    Contract.RunnerAnalyticsDto,
    {
      runner: string;
      runs: Contract.AnalyticsSeriesDto<
        Contract.RunnerRunsBucketDto,
        Contract.RunnerRunsTotalsDto
      >;
      runningNow: number;
      durations?: Contract.AnalyticsSeriesDto<
        Contract.RunnerDurationBucketDto,
        Contract.RunnerDurationTotalsDto
      >;
    }
  >
>;
type RunnerDurationsAreTotals = Equal<
  Contract.RunnerAnalyticsDto["durations"],
  Contract.RunnerDurationTotalsDto | undefined
>;
// @ts-expect-error — the detail route serves a duration *series*, bucket by
// bucket; the bare totals are what a row carries.
export type RunnerDurationsAreTotalsCaught = Expect<RunnerDurationsAreTotals>;

// One worker's detail carries **two ranges**, one per series: busyness is
// sampled on the heartbeat and so is coarser than the throughput beside it.
export type WorkerAnalyticsOk = Expect<
  Equal<
    Contract.WorkerAnalyticsDto,
    {
      key: string;
      queue: string;
      jobs: Contract.AnalyticsSeriesDto<
        Contract.WorkerJobsBucketDto,
        Contract.WorkerJobsTotalsDto
      >;
      busyness?: Contract.AnalyticsSeriesDto<
        Contract.WorkerBusynessBucketDto,
        Contract.WorkerBusynessTotalsDto
      >;
    }
  >
>;
export type WorkerAnalyticsRangesOk = Expect<
  Equal<
    [
      Contract.WorkerAnalyticsDto["jobs"]["range"],
      NonNullable<Contract.WorkerAnalyticsDto["busyness"]>["range"],
    ],
    [Contract.AnalyticsRangeDto, Contract.AnalyticsRangeDto]
  >
>;
type WorkerAnalyticsSharesARange =
  "range" extends keyof Contract.WorkerAnalyticsDto ? true : false;
// @ts-expect-error — there is deliberately no envelope-level `range` to
// mistake for both: each series carries its own.
export type WorkerSharedRangeCaught = Expect<WorkerAnalyticsSharesARange>;

// `/meta`'s analytics block is keyed by the resolutions themselves, as JSON
// object keys: a resolution added to the list must appear here too.
export type MetaAnalyticsRetentionKeysOk = Expect<
  Equal<
    keyof Contract.MetaAnalyticsDto["retentionMs"],
    `${Contract.AnalyticsResolution}`
  >
>;
export type MetaAnalyticsResolutionsOk = Expect<
  Equal<
    Contract.MetaAnalyticsDto["resolutions"],
    Contract.AnalyticsResolution[]
  >
>;
export type MetaAnalyticsRecordingOk = Expect<
  Equal<
    Contract.MetaAnalyticsRecordingDto,
    {
      resolution: "minute" | "second";
      secondRetentionMs: number;
      workers: boolean;
      runners: boolean;
      durations: boolean;
    }
  >
>;
// The keys are the resolutions, not any string: a typo'd key would not
// compile against this map.
type LooseRetentionKeys = Equal<
  keyof Contract.MetaAnalyticsDto["retentionMs"],
  string
>;
// @ts-expect-error — `retentionMs` is not keyed by an arbitrary string.
export type LooseRetentionKeysCaught = Expect<LooseRetentionKeys>;

/* --- meta ------------------------------------------------------------ */

export type MetaOk = Expect<
  DeepEqual<Contract.MetaDto, Infer<typeof MetaSchema>>
>;
// The field itself: required and nullable, like `publishing` — a backend that
// records nothing says so with `null` rather than by omitting the key, so a
// client never has to tell "absent" from "serves none".
export type MetaAnalyticsFieldOk = Expect<
  Equal<Contract.MetaDto["analytics"], Contract.MetaAnalyticsDto | null>
>;
// `features` is a flat boolean map, and every key of it must be named in
// `DRIVER_FEATURES` (whose `satisfies Record<keyof MetaDto["features"], …>`
// is the other half of this): a flag with no method list behind it cannot be
// probed, and a method list with no flag reports nothing.
export type MetaFeatureKeysOk = Expect<
  Equal<
    keyof Contract.MetaDto["features"],
    | "logs"
    | "update"
    | "limits"
    | "flows"
    | "search"
    | "workers"
    | "workerControl"
    | "throughput"
    | "runnerLogs"
    | "runnerMetrics"
    | "workerMetrics"
    | "jobAttribution"
    | "addedByState"
    | "jobDefaults"
    | "jobDefaultsApply"
  >
>;
export type MetaFeatureValuesOk = Expect<
  Equal<
    Contract.MetaDto["features"][keyof Contract.MetaDto["features"]],
    boolean
  >
>;
type MetricsFlagsOptional = Equal<
  Pick<Contract.MetaDto["features"], "runnerMetrics" | "workerMetrics">,
  { runnerMetrics?: boolean; workerMetrics?: boolean }
>;
// @ts-expect-error — both flags are always reported: a client hides a screen
// on `false`, and an absent key would leave it guessing.
export type MetricsFlagsOptionalCaught = Expect<MetricsFlagsOptional>;
type AttributionFlagOptional = Equal<
  Pick<Contract.MetaDto["features"], "jobAttribution">,
  { jobAttribution?: boolean }
>;
// @ts-expect-error — always reported, `false` included: a UI hides "processed
// by" and a worker's job list on `false`, and must not have to guess.
export type AttributionFlagOptionalCaught = Expect<AttributionFlagOptional>;
type AddedByStateFlagOptional = Equal<
  Pick<Contract.MetaDto["features"], "addedByState">,
  { addedByState?: boolean }
>;
// @ts-expect-error — always reported: a UI hides the added-by-state counts and
// the "newest first" sort on `false`, and must not have to guess.
export type AddedByStateFlagOptionalCaught = Expect<AddedByStateFlagOptional>;
type JobDefaultsFlagsOptional = Equal<
  Pick<Contract.MetaDto["features"], "jobDefaults" | "jobDefaultsApply">,
  { jobDefaults?: boolean; jobDefaultsApply?: boolean }
>;
// @ts-expect-error — both always reported: a UI hides the defaults panel and
// the apply button on `false`, and must not have to guess.
export type JobDefaultsFlagsOptionalCaught = Expect<JobDefaultsFlagsOptional>;
export type MetaCsrfOk = Expect<
  DeepEqual<Contract.MetaCsrfDto, Infer<typeof MetaCsrfSchema>>
>;
export type MetaLimitsOk = Expect<
  DeepEqual<Contract.MetaLimitsDto, Infer<typeof MetaLimitsSchema>>
>;
export type PermissionsOk = Expect<
  DeepEqual<Contract.PermissionsDto, Infer<typeof PermissionsSchema>>
>;
export type PermissionsQueryOk = Expect<
  DeepEqual<Contract.PermissionsQuery, Infer<typeof PermissionsQuerySchema>>
>;
// `/meta.driver.capabilities` names every driver capability, each always
// reported: `/meta` picks them from the driver one by one, so a capability
// added to the driver contract without the DTO would silently go unreported.
export type DriverCapabilitiesOk = Expect<
  Equal<Contract.DriverCapabilitiesDto, Required<Root.DriverCapabilities>>
>;
// The server's `MetaDto` is the contract's, not a copy of it.
export type ServerMetaOk = Expect<Equal<Server.MetaDto, Contract.MetaDto>>;
export type InfoOk = Expect<Equal<JobsApi["info"], Contract.JobsApiInfo>>;

/* --- what the server builds fits the contract ------------------------ */

// The serializer's DTOs are built from driver types; each must fit the wire
// type a client compiles against.
export type ServerJobFits = Expect<
  Server.JobDto extends Contract.JobDto ? true : false
>;
// And the stamp the serializer builds is the wire's, field for field.
export type ServerJobWorkerOk = Expect<
  Equal<Server.JobWorkerDto, Contract.JobWorkerDto>
>;
export type ServerRepeatableFits = Expect<
  Server.RepeatableDto extends Contract.RepeatableDto ? true : false
>;
export type ServerRunRecordFits = Expect<
  Server.RunRecordDto extends Contract.RunRecordDto ? true : false
>;
export type ServerRunnerInfoFits = Expect<
  Server.RunnerInfoDto extends Contract.RunnerInfoDto ? true : false
>;
export type ServerWorkerOk = Expect<
  DeepEqual<Server.WorkerDto, Contract.WorkerDto>
>;
export type ServerQueueSummaryOk = Expect<
  DeepEqual<Server.QueueSummaryDto, Contract.QueueSummaryDto>
>;
export type ServerProblemOk = Expect<
  DeepEqual<Server.ProblemDto, Contract.ProblemDto>
>;

/* --- constants ------------------------------------------------------- */

export type JobStateOk = Expect<Equal<Contract.JobState, JobState>>;
export type QueueEventOk = Expect<
  Equal<Contract.QueueEventName, QueueEventName>
>;
export type RunnerEventOk = Expect<
  Equal<Contract.RunnerEventName, RunnerEventName>
>;
export type EventNameOk = Expect<
  Equal<
    Contract.EventName,
    QueueEventName | RunnerEventName | Workers.WorkerEventName
  >
>;

/*
 * The worker tables exist twice on purpose: `lib/shared/workers.ts` is the
 * runtime's copy, and the contract restates it because the contract may
 * import nothing. These hold the two together — values *and* types — so a
 * setting, a state or an action added to one and not the other fails here.
 * The dependency may only ever run one way: the runtime may import the
 * contract, never the reverse (`api-contract.test.ts` holds the import graph).
 */
export type WorkerStatesValueOk = Expect<
  Equal<typeof Contract.WORKER_STATES, typeof Workers.WORKER_STATES>
>;
export type WorkerStateTypeOk = Expect<
  Equal<Contract.WorkerState, Workers.WorkerState>
>;
export type WorkerDesiredStateOk = Expect<
  Equal<Contract.WorkerDesiredState, Workers.WorkerDesiredState>
>;
export type WorkerControlModeOk = Expect<
  Equal<Contract.WorkerControlMode, Workers.WorkerControlMode>
>;
export type WorkerConfigKeysValueOk = Expect<
  Equal<typeof Contract.WORKER_CONFIG_KEYS, typeof Workers.WORKER_CONFIG_KEYS>
>;
export type WorkerConfigKeyTypeOk = Expect<
  Equal<Contract.WorkerConfigKey, Workers.WorkerConfigKey>
>;
export type WorkerConfigBoundsOk = Expect<
  Equal<
    typeof Contract.WORKER_CONFIG_BOUNDS,
    typeof Workers.WORKER_CONFIG_BOUNDS
  >
>;
export type WorkerConfigValuesTypeOk = Expect<
  Equal<Contract.WorkerConfigValues, Workers.WorkerConfigValues>
>;
export type WorkerConfigPatchOk = Expect<
  Equal<Partial<Contract.WorkerConfigValues>, Workers.WorkerConfigPatch>
>;
export type WorkerEventTypesValueOk = Expect<
  Equal<typeof Contract.WORKER_EVENT_TYPES, typeof Workers.WORKER_EVENT_TYPES>
>;
export type WorkerEventNameTypeOk = Expect<
  Equal<Contract.WorkerEventName, Workers.WorkerEventName>
>;
export type WorkerControlActionsValueOk = Expect<
  Equal<
    typeof Contract.WORKER_CONTROL_ACTIONS,
    typeof Workers.WORKER_CONTROL_ACTIONS
  >
>;
export type WorkerControlActionTypeOk = Expect<
  Equal<Contract.WorkerControlAction, Workers.WorkerControlAction>
>;
export type WorkerStopPersistenceValueOk = Expect<
  Equal<
    typeof Contract.WORKER_STOP_PERSISTENCE,
    typeof Workers.WORKER_STOP_PERSISTENCE
  >
>;
export type WorkerStopPersistenceTypeOk = Expect<
  Equal<Contract.WorkerStopPersistence, Workers.WorkerStopPersistence>
>;
/**
 * And the worker payloads the socket sends are the driver's own: no error is
 * reshaped on the way out, so the two are equal outright.
 */
export type WorkerEventPayloadsOk = Expect<
  DeepEqual<Contract.WorkerEventPayloadsWire, WorkerEventPayloads>
>;
/**
 * `previous` is optional on `state`: a worker's first announcement since it
 * started has none, and a client must handle that rather than read `undefined`
 * as a state.
 */
export type WorkerStatePreviousOptional = Expect<
  Equal<
    Contract.WorkerEventPayloadsWire["state"]["previous"],
    Contract.WorkerState | undefined
  >
>;
export type WorkerStatePreviousKeyOptional = Expect<
  Omit<
    Contract.WorkerEventPayloadsWire["state"],
    "previous"
  > extends Contract.WorkerEventPayloadsWire["state"]
    ? true
    : false
>;
/**
 * And the two blocks a worker record carries are the DTO's own, so
 * `toWorkerDto` copies them across rather than rebuilding them — the place
 * where a field silently stops being reported.
 */
export type WorkerConfigInfoOk = Expect<
  DeepEqual<Contract.WorkerConfigDto, WorkerConfigInfo>
>;
export type WorkerControlInfoOk = Expect<
  DeepEqual<Contract.WorkerControlDto, WorkerControlInfo>
>;

/* --- negative controls ----------------------------------------------- */

// Worker attribution. Each pin above is a real comparison.

type ProcessedByOptional = Equal<
  Contract.JobDto["processedBy"],
  Contract.JobWorkerDto | null | undefined
>;
// @ts-expect-error — `processedBy` is required: an optional one is caught.
export type ProcessedByOptionalCaught = Expect<ProcessedByOptional>;

type JobWorkerNoPid = Equal<
  Contract.JobWorkerDto,
  Pick<Contract.WorkerDto, "id" | "key" | "host">
>;
// @ts-expect-error — a worker field missing from the stamp is caught.
export type JobWorkerNoPidCaught = Expect<JobWorkerNoPid>;

type JobWorkerKeyRequired = Equal<
  Contract.JobWorkerDto,
  Required<Pick<Contract.WorkerDto, "id" | "key">> &
    Pick<Contract.WorkerDto, "host" | "pid">
>;
// @ts-expect-error — `key` is optional (an older claimer records only the id).
export type JobWorkerKeyRequiredCaught = Expect<JobWorkerKeyRequired>;

type ProcessedByMissing = Matches<
  Contract.JobDto,
  Omit<Infer<typeof JobSchema>, "processedBy">
>;
// @ts-expect-error — a schema without `processedBy` is caught.
export type ProcessedByMissingCaught = Expect<ProcessedByMissing>;

type NestedJobDrift = Matches<
  Contract.PageDto<Contract.JobDto & { lockToken?: string }>,
  Infer<typeof JobPageSchema>
>;
// @ts-expect-error — an extra field on a nested job is caught.
export type NestedJobDriftCaught = Expect<NestedJobDrift>;

type ServerJobWithoutStamp =
  Omit<Server.JobDto, "processedBy"> extends Contract.JobDto ? true : false;
// @ts-expect-error — a serializer that stopped building `processedBy` is caught.
export type ServerJobWithoutStampCaught = Expect<ServerJobWithoutStamp>;

type FilterDrift = DeepEqual<
  Defaulted<
    Omit<Contract.JobListQuery, "workerKey">,
    "offset" | "limit" | "order" | "total"
  >,
  Infer<ReturnType<typeof jobListQuerySchema>>
>;
// @ts-expect-error — the schema's `workerKey` without the contract's is caught.
export type FilterDriftCaught = Expect<FilterDrift>;

type WorkerKeySingle = Equal<
  Contract.JobListQuery["workerKey"],
  string | undefined
>;
// @ts-expect-error — the worker filters are repeatable: a single value is caught.
export type WorkerKeySingleCaught = Expect<WorkerKeySingle>;

type FinishedFromEpochOnly = Equal<
  Contract.JobListQuery["finishedFrom"],
  number | undefined
>;
// @ts-expect-error — the range takes epoch ms *or* a date-time, like analytics.
export type FinishedFromEpochOnlyCaught = Expect<FinishedFromEpochOnly>;

type MetaWithoutAttribution = DeepEqual<
  Omit<Contract.MetaDto["features"], "jobAttribution">,
  Infer<typeof MetaSchema>["features"]
>;
// @ts-expect-error — `MetaSchema` carries the flag too: the contract dropping it is caught.
export type MetaWithoutAttributionCaught = Expect<MetaWithoutAttribution>;

type MetaWithoutJobDefaults = DeepEqual<
  Omit<Contract.MetaDto["features"], "jobDefaults" | "jobDefaultsApply">,
  Infer<typeof MetaSchema>["features"]
>;
// @ts-expect-error — `MetaSchema` carries both job-defaults flags: the contract dropping them is caught.
export type MetaWithoutJobDefaultsCaught = Expect<MetaWithoutJobDefaults>;

type DriftedJobDefaults = DeepEqual<
  Omit<Contract.JobDefaultsDto, "pending">,
  Infer<typeof JobDefaultsSchema>
>;
// @ts-expect-error — a job-defaults DTO missing `pending` is caught.
export type DriftedJobDefaultsCaught = Expect<DriftedJobDefaults>;

type MetaWithoutAddedByState = DeepEqual<
  Omit<Contract.MetaDto["features"], "addedByState">,
  Infer<typeof MetaSchema>["features"]
>;
// @ts-expect-error — `MetaSchema` carries `addedByState`: the contract dropping it is caught.
export type MetaWithoutAddedByStateCaught = Expect<MetaWithoutAddedByState>;

type SortAnyString = Equal<Contract.JobListQuery["sort"], string | undefined>;
// @ts-expect-error — `sort` takes the listed sorts only, not any string.
export type SortAnyStringCaught = Expect<SortAnyString>;

type SortsWidened = Equal<Contract.JobListSort, "createdAt">;
// @ts-expect-error — the natural order is a sort a client can name, not only an absence.
export type SortsWidenedCaught = Expect<SortsWidened>;

type SortUndefaulted = DeepEqual<
  Defaulted<Contract.JobListQuery, "offset" | "limit" | "order" | "total">,
  Infer<ReturnType<typeof jobListQuerySchema>>
>;
// @ts-expect-error — the schema defaults `sort`: a contract calling it required is caught.
export type SortUndefaultedCaught = Expect<SortUndefaulted>;

type JobListWithoutSort = DeepEqual<
  Defaulted<
    Omit<Contract.JobListQuery, "sort">,
    "offset" | "limit" | "order" | "total"
  >,
  Infer<ReturnType<typeof jobListQuerySchema>>
>;
// @ts-expect-error — the schema serves `sort`: a contract dropping it is caught.
export type JobListWithoutSortCaught = Expect<JobListWithoutSort>;

type AddedSchemaWithoutQueues = DeepEqual<
  Omit<Contract.AddedByStateDto, "queues">,
  Infer<typeof AddedByStateSchema>
>;
// @ts-expect-error — `AddedByStateSchema` carries `queues`: the contract dropping it is caught.
export type AddedSchemaWithoutQueuesCaught = Expect<AddedSchemaWithoutQueues>;

type AddedQueryResolution = DeepEqual<
  Contract.AnalyticsRangeQuery,
  Infer<ReturnType<typeof addedByStateQuerySchema>>
>;
// @ts-expect-error — the query schema takes no `resolution`: there are no buckets.
export type AddedQueryResolutionCaught = Expect<AddedQueryResolution>;

type AddedWithoutAt = DeepEqual<
  Omit<Contract.AddedByStateDto, "at">,
  {
    from: number;
    to: number;
    at: number;
    counts: Contract.JobCountsDto;
    total: number;
    queues: number;
  }
>;
// @ts-expect-error — an added-by-state body missing a field is caught.
export type AddedWithoutAtCaught = Expect<AddedWithoutAt>;

type AddedCountsPartial = DeepEqual<
  Partial<Contract.AddedByStateDto["counts"]>,
  Infer<typeof JobCountsSchema>
>;
// @ts-expect-error — every state is present in the counts, zeros included.
export type AddedCountsPartialCaught = Expect<AddedCountsPartial>;

type AddedQueryWithResolution = DeepEqual<
  Contract.AddedByStateQuery,
  Contract.AnalyticsRangeQuery
>;
// @ts-expect-error — the query has no `resolution`: there are no buckets.
export type AddedQueryWithResolutionCaught = Expect<AddedQueryWithResolution>;

type DriftedMeta = Omit<Contract.MetaDto, "limits">;
type DriftedMetaEqual = DeepEqual<DriftedMeta, Infer<typeof MetaSchema>>;
// @ts-expect-error — a contract type missing a field is caught.
export type DriftedMetaCaught = Expect<DriftedMetaEqual>;

type ExtraOptional = Contract.QueueListDto & { cursor?: string };
type ExtraOptionalEqual = DeepEqual<
  ExtraOptional,
  Infer<typeof QueueListSchema>
>;
// @ts-expect-error — an extra optional field is caught (assignability would not).
export type ExtraOptionalCaught = Expect<ExtraOptionalEqual>;

type UndefaultedEqual = DeepEqual<
  Contract.RetryJobBody,
  Infer<typeof RetryBodySchema>
>;
// @ts-expect-error — a defaulted key compared as optional is caught.
export type UndefaultedCaught = Expect<UndefaultedEqual>;

type DriftedWorkerBody = Omit<Contract.WorkerConfigBody, "drainDelay">;
type DriftedWorkerBodyEqual = Equal<
  keyof DriftedWorkerBody,
  Contract.WorkerConfigKey | "expectedSeq"
>;
// @ts-expect-error — an editable setting with no field on the patch body is caught.
export type DriftedWorkerBodyCaught = Expect<DriftedWorkerBodyEqual>;

type DriftedRunnerConfig = Omit<Contract.RunnerConfigDto, "allowed">;
type DriftedRunnerConfigEqual = DeepEqual<
  DriftedRunnerConfig,
  Infer<typeof RunnerConfigSchema>
>;
// @ts-expect-error — a runner config field the contract stopped naming is caught.
export type DriftedRunnerConfigCaught = Expect<DriftedRunnerConfigEqual>;

type DriftedRunnerInfo = Omit<Contract.RunnerInfoDto, "config">;
type DriftedRunnerInfoEqual = Matches<
  DriftedRunnerInfo,
  Infer<typeof RunnerInfoSchema>
>;
// @ts-expect-error — the waiver this assertion carried until `config` shipped.
export type DriftedRunnerInfoCaught = Expect<DriftedRunnerInfoEqual>;

/* --- clearing a job's log, clearing a runner's history --------------- */

// Each result DTO is pinned both ways: to what its route's schema infers (the
// wire), and to the runtime result the route serialises (the driver's
// `ClearJobLogsResult` minus its `status`, and the runner's
// `ClearHistoryResult`), so no one of the three can drift alone.
type ClearedJobLogs = Extract<DriverClearJobLogsResult, { status: "cleared" }>;

export type ClearJobLogsResultOk = Expect<
  DeepEqual<
    Contract.ClearJobLogsResultDto,
    Infer<typeof JobSchemas.ClearJobLogsResultSchema>
  >
>;
export type ClearJobLogsResultRuntimeOk = Expect<
  DeepEqual<Contract.ClearJobLogsResultDto, Omit<ClearedJobLogs, "status">>
>;
export type ClearRunnerHistoryResultOk = Expect<
  DeepEqual<
    Contract.ClearRunnerHistoryResultDto,
    Infer<typeof RunnerSchemas.ClearHistoryResultSchema>
  >
>;
export type ClearRunnerHistoryResultRuntimeOk = Expect<
  DeepEqual<Contract.ClearRunnerHistoryResultDto, RunnerClearHistoryResult>
>;
export type ClearRunnerHistoryQueryOk = Expect<
  DeepEqual<
    Defaulted<Contract.ClearRunnerHistoryQuery, "staleAfter">,
    Infer<typeof RunnerSchemas.ClearHistoryQuerySchema>
  >
>;
// The query's one field is the library option of the same name, so what the
// route accepts is what `clearHistory` takes.
export type ClearRunnerHistoryQueryRuntimeOk = Expect<
  Equal<keyof Contract.ClearRunnerHistoryQuery, keyof Root.ClearHistoryOptions>
>;

// Both actions are named, and both are mutations.
export type ClearActionsNamedOk = Expect<
  Equal<
    Extract<Contract.JobsApiAction, "jobs.clearLogs" | "runners.clearHistory">,
    "jobs.clearLogs" | "runners.clearHistory"
  >
>;

type ClearJobLogsWithStatus = Contract.ClearJobLogsResultDto & {
  status?: "cleared";
};
type ClearJobLogsWithStatusEqual = DeepEqual<
  ClearJobLogsWithStatus,
  Omit<ClearedJobLogs, "status">
>;
// @ts-expect-error — the wire result carries no `status`: a refusal is a 409, not a body.
export type ClearJobLogsStatusCaught = Expect<ClearJobLogsWithStatusEqual>;

type KeptAsCount = Omit<Contract.ClearRunnerHistoryResultDto, "kept"> & {
  kept: number;
};
type KeptAsCountEqual = DeepEqual<KeptAsCount, RunnerClearHistoryResult>;
// @ts-expect-error — `kept` names the runs, so a count in its place is caught.
export type KeptAsCountCaught = Expect<KeptAsCountEqual>;

type LogsDrift = Contract.ClearJobLogsResultDto & {
  bogus: string;
};
type LogsDriftEqual = DeepEqual<
  LogsDrift,
  Infer<typeof JobSchemas.ClearJobLogsResultSchema>
>;
// @ts-expect-error — a field the job-log schema does not declare is caught.
export type LogsDriftCaught = Expect<LogsDriftEqual>;

type HistoryDrift = Contract.ClearRunnerHistoryResultDto & {
  bogus: string;
};
type HistoryDriftEqual = DeepEqual<
  HistoryDrift,
  Infer<typeof RunnerSchemas.ClearHistoryResultSchema>
>;
// @ts-expect-error — a field the history schema does not declare is caught.
export type HistoryDriftCaught = Expect<HistoryDriftEqual>;

/* --- permissions are keyed by action --------------------------------- */

// `actions` is keyed by `JobsApiAction`, on the contract and on what the
// schema infers alike, and every key is optional (a pruned action is absent).
export type PermissionActionsOk = Expect<
  Equal<
    Contract.PermissionsDto["actions"],
    Partial<Record<Contract.JobsApiAction, boolean>>
  >
>;
export type PermissionActionsInferredOk = Expect<
  DeepEqual<
    Infer<typeof PermissionsSchema>["actions"],
    Partial<Record<Contract.JobsApiAction, boolean>>
  >
>;

declare const permissions: Contract.PermissionsDto;
export const canRetry: boolean | undefined = permissions.actions["jobs.retry"];
// @ts-expect-error — a string that is not an action does not index the map.
export const notAnAction = permissions.actions["jobs.frobnicate"];
declare const someString: string;
// @ts-expect-error — nor does an arbitrary string.
export const anyString = permissions.actions[someString];

/* --- the socket ------------------------------------------------------ */

// The contract restates the socket's frames and events; each must equal the
// server's own type (`ws/protocol.ts`, `ws/events.ts`).
export type ErrorWireOk = Expect<DeepEqual<Contract.ErrorWire, Ws.ErrorWire>>;
// The server's event types are the contract's own (re-exported), so they are
// compared exactly — an empty payload (`paused`, `resumed`) included, which a
// server-side mapping once turned into an index signature of errors.
type Normalized<E> = Deep<E>;
export type EventWireOk = Expect<
  Equal<Normalized<Contract.EventWire>, Normalized<Ws.EventWire>>
>;
export type EmptyPayloadIsEmpty = Expect<
  Equal<
    Extract<Contract.EventWire, { type: "paused" }>["payload"],
    Record<string, never>
  >
>;
export type ServerEventDtoOk = Expect<Equal<Server.EventDto, Ws.EventWire>>;
export type WsErrorCodeOk = Expect<
  Equal<Contract.JobsApiWsErrorCode, Protocol.JobsApiWsErrorCode>
>;
export type SubscribeOk = Expect<
  DeepEqual<Contract.JobsApiSubscribeMessage, Protocol.JobsApiSubscribeMessage>
>;
export type UnsubscribeOk = Expect<
  DeepEqual<
    Contract.JobsApiUnsubscribeMessage,
    Protocol.JobsApiUnsubscribeMessage
  >
>;
export type PingOk = Expect<
  DeepEqual<Contract.JobsApiPingMessage, Protocol.JobsApiPingMessage>
>;
export type ClientMessageOk = Expect<
  DeepEqual<Contract.JobsApiClientMessage, Protocol.JobsApiClientMessage>
>;
export type HelloOk = Expect<
  DeepEqual<Contract.JobsApiHelloMessage, Protocol.JobsApiHelloMessage>
>;
export type AckOk = Expect<
  DeepEqual<Contract.JobsApiAckMessage, Protocol.JobsApiAckMessage>
>;
export type EventMessageOk = Expect<
  DeepEqual<
    Omit<Contract.JobsApiEventMessage, "event">,
    Omit<Protocol.JobsApiEventMessage, "event">
  >
>;
export type EventMessageEventOk = Expect<
  Equal<
    Normalized<Contract.JobsApiEventMessage["event"]>,
    Normalized<Protocol.JobsApiEventMessage["event"]>
  >
>;
export type GapOk = Expect<
  DeepEqual<Contract.JobsApiGapMessage, Protocol.JobsApiGapMessage>
>;
export type HeartbeatOk = Expect<
  DeepEqual<Contract.JobsApiHeartbeatMessage, Protocol.JobsApiHeartbeatMessage>
>;
export type PongOk = Expect<
  DeepEqual<Contract.JobsApiPongMessage, Protocol.JobsApiPongMessage>
>;
export type ErrorMessageOk = Expect<
  DeepEqual<Contract.JobsApiErrorMessage, Protocol.JobsApiErrorMessage>
>;
export type ServerMessageOk = Expect<
  DeepEqual<
    Exclude<Contract.JobsApiServerMessage, { type: "event" }>,
    Exclude<Protocol.JobsApiServerMessage, { type: "event" }>
  >
>;

type DriftedEvent = Exclude<Contract.EventWire, { type: "paused" }>;
type DriftedEventEqual = Equal<
  Normalized<DriftedEvent>,
  Normalized<Ws.EventWire>
>;
// @ts-expect-error — an event missing from the contract is caught.
export type DriftedEventCaught = Expect<DriftedEventEqual>;

/* --- one definition: the root's socket types ARE the contract's ------- */

// The root entry (`@kingsleyweb/bun-jobs`) re-exports the server's socket
// types; a client may import them from either place and mix the two, so each
// must be *equal* to the contract's — no normalising. An empty payload
// (`paused`, `resumed`) once differed here: the server mapped it to an index
// signature of errors, and a root `JobsApiEventMessage` was not assignable to
// the contract's (TS2322).
export type RootEventWireOk = Expect<Equal<Root.EventDto, Contract.EventWire>>;
export type ServerEventWireOk = Expect<Equal<Ws.EventWire, Contract.EventWire>>;
export type ServerErrorWireOk = Expect<Equal<Ws.ErrorWire, Contract.ErrorWire>>;
export type RootSubscribeOk = Expect<
  Equal<Root.JobsApiSubscribeMessage, Contract.JobsApiSubscribeMessage>
>;
export type RootUnsubscribeOk = Expect<
  Equal<Root.JobsApiUnsubscribeMessage, Contract.JobsApiUnsubscribeMessage>
>;
export type RootPingOk = Expect<
  Equal<Root.JobsApiPingMessage, Contract.JobsApiPingMessage>
>;
export type RootClientMessageOk = Expect<
  Equal<Root.JobsApiClientMessage, Contract.JobsApiClientMessage>
>;
export type RootHelloOk = Expect<
  Equal<Root.JobsApiHelloMessage, Contract.JobsApiHelloMessage>
>;
export type RootAckOk = Expect<
  Equal<Root.JobsApiAckMessage, Contract.JobsApiAckMessage>
>;
export type RootAckRejectionOk = Expect<
  Equal<Root.JobsApiAckRejection, Contract.JobsApiAckRejection>
>;
export type RootEventMessageOk = Expect<
  Equal<Root.JobsApiEventMessage, Contract.JobsApiEventMessage>
>;
export type RootGapOk = Expect<
  Equal<Root.JobsApiGapMessage, Contract.JobsApiGapMessage>
>;
export type RootGapReasonOk = Expect<
  Equal<Root.JobsApiGapReason, Contract.JobsApiGapReason>
>;
export type RootHeartbeatOk = Expect<
  Equal<Root.JobsApiHeartbeatMessage, Contract.JobsApiHeartbeatMessage>
>;
export type RootPongOk = Expect<
  Equal<Root.JobsApiPongMessage, Contract.JobsApiPongMessage>
>;
export type RootErrorMessageOk = Expect<
  Equal<Root.JobsApiErrorMessage, Contract.JobsApiErrorMessage>
>;
export type RootServerMessageOk = Expect<
  Equal<Root.JobsApiServerMessage, Contract.JobsApiServerMessage>
>;
export type RootWsErrorCodeOk = Expect<
  Equal<Root.JobsApiWsErrorCode, Contract.JobsApiWsErrorCode>
>;

/** The peer's reproduction: a root event frame handed to contract-typed code. */
export function acceptsContractFrame(
  frame: Root.JobsApiEventMessage,
): Contract.JobsApiEventMessage {
  return frame;
}
/** And the other way round. */
export function acceptsRootFrame(
  frame: Contract.JobsApiServerMessage,
): Root.JobsApiServerMessage {
  return frame;
}
