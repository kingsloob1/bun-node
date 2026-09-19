import type * as Root from "@kingsleyweb/bun-jobs";
import type * as Contract from "@kingsleyweb/bun-jobs/api/contract";
import type { JobsApi } from "../../lib/api/config";
import type { Infer } from "../../lib/api/schema/builder";
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
import type {
  MetaCsrfSchema,
  MetaLimitsSchema,
  MetaSchema,
  PermissionsQuerySchema,
  PermissionsSchema,
} from "../../lib/api/schemas/meta";
import type {
  cleanBodySchema,
  CleanResultSchema,
  CountResultSchema,
  DrainBodySchema,
  JobCountsSchema,
  minutesQuerySchema,
  OverviewSchema,
  PausedSchema,
  QueueDetailSchema,
  QueueLimitsInputSchema,
  queueListQuerySchema,
  QueueListSchema,
  QueueSummarySchema,
  StoredLimitsSchema,
  ThroughputBucketSchema,
  ThroughputSchema,
  WorkerListSchema,
  WorkerSchema,
} from "../../lib/api/schemas/queues";
import type {
  historyQuerySchema,
  HistorySchema,
  KillBodySchema,
  KillResultSchema,
  ResumeBodySchema,
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
import type * as Server from "../../lib/api/serialize";
import type * as Ws from "../../lib/api/ws/events";
import type * as Protocol from "../../lib/api/ws/protocol";
import type { JobState } from "../../lib/index";
import type { QueueEventName, RunnerEventName } from "../../lib/shared/events";

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

export type JobListQueryOk = Expect<
  DeepEqual<
    Defaulted<Contract.JobListQuery, "offset" | "limit" | "order" | "total">,
    Infer<ReturnType<typeof jobListQuerySchema>>
  >
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
export type OverviewOk = Expect<
  DeepEqual<Contract.OverviewDto, Infer<typeof OverviewSchema>>
>;
export type WorkerOk = Expect<
  DeepEqual<Contract.WorkerDto, Infer<typeof WorkerSchema>>
>;
export type WorkerListOk = Expect<
  DeepEqual<Contract.WorkerListDto, Infer<typeof WorkerListSchema>>
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
export type RunnerScheduleOk = Expect<
  DeepEqual<Contract.RunnerScheduleDto, Infer<typeof RunnerScheduleSchema>>
>;
export type RunnerStatsOk = Expect<
  DeepEqual<Contract.RunnerStatsDto, Infer<typeof RunnerStatsSchema>>
>;
export type RunnerInfoOk = Expect<
  Matches<Contract.RunnerInfoDto, Infer<typeof RunnerInfoSchema>>
>;
export type RunnerListOk = Expect<
  DeepEqual<Contract.RunnerListDto, Infer<typeof RunnerListSchema>>
>;
export type RunnerHistoryOk = Expect<
  Matches<Contract.RunnerHistoryDto, Infer<typeof HistorySchema>>
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

/* --- meta ------------------------------------------------------------ */

export type MetaOk = Expect<
  DeepEqual<Contract.MetaDto, Infer<typeof MetaSchema>>
>;
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
// The server's `MetaDto` is the contract's, not a copy of it.
export type ServerMetaOk = Expect<Equal<Server.MetaDto, Contract.MetaDto>>;
export type InfoOk = Expect<Equal<JobsApi["info"], Contract.JobsApiInfo>>;

/* --- what the server builds fits the contract ------------------------ */

// The serializer's DTOs are built from driver types; each must fit the wire
// type a client compiles against.
export type ServerJobFits = Expect<
  Server.JobDto extends Contract.JobDto ? true : false
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
  Equal<Contract.EventName, QueueEventName | RunnerEventName>
>;

/* --- negative controls ----------------------------------------------- */

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
