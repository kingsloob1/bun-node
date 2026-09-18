import type { BunRequest, SerializedError } from "@kingsleyweb/bun-common";
import type {
  DriverEvent,
  JobFlow,
  JobRecord,
  JobState,
  RepeatRecord,
  ResolvedJobOptions,
  RunRecord,
} from "../drivers/index";
import type { RemoteRunnerInfo, RunnerStatus } from "../runner/types";
import type { ResolvedJobsApiSerializers } from "./config";
import type { JobInclude } from "./contract/constants";
import type { EventWire } from "./ws/events";
import { JOB_INCLUDES } from "./contract/constants";

/**
 * What leaves the process, and how it is shaped.
 *
 * Every DTO is built by **picking** fields, never by spreading a record and
 * deleting the secret ones. The difference matters the day `JobRecord` gains a
 * field: a spread would publish it to every client without anyone deciding to,
 * while a pick leaves it out until someone does. `lockToken` — which lets its
 * holder complete or fail a job as if it were the worker — is the case in
 * point.
 */

/** A validation issue inside a problem, as bun-common's `validate()` reports it. */
export interface ProblemIssueDto {
  /** Which part of the request failed. */
  target: "params" | "query" | "body" | "headers";
  /** Dotted path within the target, or `""` for the target itself. */
  path: string;
  /** Human-readable description. */
  message: string;
}

/** Every error body, RFC 9457. Content-Type: `application/problem+json`. */
export interface ProblemDto {
  /** `urn:bun-jobs:error:<CODE>`; stable. */
  type: string;
  /** Short, stable, human title for the code (not the instance). */
  title: string;
  /** HTTP status, repeated for clients that lose it. */
  status: number;
  /** Machine code: a bun-jobs `JobsError.code`, `VALIDATION`, or an API code. */
  code: string;
  /** Human detail for this occurrence. For 5xx always the generic title: messages never leak. */
  detail?: string;
  /** The request path. */
  instance?: string;
  /** Validation issues, as bun-common's `validate()` reports them. */
  issues?: ProblemIssueDto[];
  /** Safe, whitelisted context (e.g. `{ state: "active" }`, `{ max: 1000 }`). Never `cause`. */
  context?: Record<string, unknown>;
}

/** An error as a client sees it: a `SerializedError`, with `stack` only on request. */
export interface ErrorDto {
  /** The error's class name. */
  name: string;
  /** The error's message. */
  message: string;
  /** Its `code`, when it had one. */
  code?: string | number;
  /** The stack trace; only with `serialize.exposeStacks`. */
  stack?: string;
  /** Extra own properties the error carried. */
  data?: Record<string, unknown>;
  /** The error's cause, shaped the same way. */
  cause?: ErrorDto;
}

/** Optional job fields a client asks for with `include=`. Defined in the contract. */
export { JOB_INCLUDES, type JobInclude };

/** What lists include by default: nothing optional, to keep pages small and payloads private. */
export const JOB_LIST_INCLUDE: ReadonlySet<JobInclude> = new Set<JobInclude>();

/** What a single read includes by default. */
export const JOB_READ_INCLUDE: ReadonlySet<JobInclude> = new Set<JobInclude>([
  "data",
  "returnValue",
  "opts",
]);

/** A job's place in a flow, with failures shaped as {@link ErrorDto}. */
export interface JobFlowDto extends Omit<JobFlow, "failures"> {
  /** Failures of children marked `ignoreFailure`, keyed `queue:id`. */
  failures: Record<string, ErrorDto>;
}

/** A job as a client sees it. Never carries `lockToken`. */
export interface JobDto {
  /** The queue the job is in. */
  queue: string;
  /** The job's id. */
  id: string;
  /** The job's name. */
  name: string;
  /** Where the job is. */
  state: JobState;
  /** Lower runs first. */
  priority: number;
  /** When the job becomes claimable, epoch ms. */
  runAt: number;
  /** When it was added, epoch ms. */
  createdAt: number;
  /** When the current or last attempt started, epoch ms. */
  processedOn: number | null;
  /** When it completed or died, epoch ms. */
  finishedOn: number | null;
  /** When retention removes it, epoch ms. */
  expiresAt: number | null;
  /** Attempts made so far. */
  attemptsMade: number;
  /** Attempts allowed in total. */
  maxAttempts: number;
  /** Times the job stalled and was recovered. */
  stalledCount: number;
  /** Latest progress value. */
  progress: unknown;
  /** The most recent failure. */
  failedReason: ErrorDto | null;
  /** When the holding worker's lock expires, epoch ms. */
  lockExpiresAt: number | null;
  /** Id of the worker holding it. */
  workerId: string | null;
  /** The repeat series that produced it. */
  repeatKey: string | null;
  /** Its place in a flow. */
  flow: JobFlowDto | null;
  /** The payload; with `include=data`. */
  data?: unknown;
  /** The processor's return value; with `include=returnValue`. */
  returnValue?: unknown;
  /**
   * Recent failures, newest first; with `include=stacktrace`. Despite the
   * name, an entry carries `stack` only when `serialize.exposeStacks` is on
   * (it is off by default); otherwise each entry is the error's `name` and
   * `message`, plus `code`, `data` and `cause` when it had them.
   */
  stacktrace?: ErrorDto[];
  /** Options after defaults; with `include=opts`. */
  opts?: ResolvedJobOptions;
}

/** Where a page sits in its list. */
export interface PageInfoDto {
  /** Items skipped before this page. */
  offset: number;
  /** Most items the page could hold. */
  limit: number;
  /** Items in the whole list, when it was counted. */
  total?: number;
  /** Whether items follow this page. */
  hasMore: boolean;
}

/** One page of a list. */
export interface PageDto<T> {
  /** The page's items. */
  items: T[];
  /** Where the page sits. */
  page: PageInfoDto;
}

/** A page of jobs. */
export type JobPageDto = PageDto<JobDto>;

/** A queue at a glance. */
export interface QueueSummaryDto {
  /** The queue's name. */
  name: string;
  /** Jobs per state. */
  counts: Record<JobState, number>;
  /** Jobs in every state. */
  total: number;
  /** Whether the queue is paused. */
  paused: boolean;
}

/** A repeat series as a client sees it. */
export interface RepeatableDto extends Omit<RepeatRecord, "data"> {
  /** The queue the series belongs to. */
  queue: string;
  /** Payload given to each instance; with `include=data`. */
  data?: unknown;
}

/** One run as a client sees it. */
export interface RunRecordDto extends Omit<
  RunRecord,
  "host" | "pid" | "error"
> {
  /** Host the run executed on; omitted with `exposeHosts: false`. */
  host?: string;
  /** Process id; omitted with `exposeHosts: false`. */
  pid?: number;
  /** The failure. */
  error?: ErrorDto;
}

/**
 * A runner snapshot as a client sees it, for a runner registered in any
 * process: the backend's view (`RemoteRunnerInfo`), plus this process's own
 * view under `local` when the runner is registered here.
 */
export interface RunnerInfoDto extends Omit<
  RemoteRunnerInfo,
  "file" | "nextRunAt" | "lastRun" | "runningOn" | "local"
> {
  /** The handler file; only with `exposeRunnerFiles`, and only when it was persisted. */
  file?: string;
  /** When the stored schedule next fires, epoch ms, or `null`. */
  nextRunAt: number | null;
  /** The most recent run. */
  lastRun?: RunRecordDto;
  /** This process's view, present only when the runner is registered here. */
  local?: {
    /** The local instance's status. */
    status: RunnerStatus;
    /** Runs in flight in this process. */
    activeRuns: RunRecordDto[];
    /** When this instance's ticker next fires, epoch ms, or `null`. */
    nextRunAt: number | null;
  };
  /** Who is running it, from the lock. */
  runningOn?: {
    /** The run in flight. */
    runId: string;
    /** Since when, epoch ms. */
    since: number;
    /** The lock holder's host; omitted with `exposeHosts: false`. */
    host?: string;
    /** The lock holder's pid; omitted with `exposeHosts: false`. */
    pid?: number;
  };
}

/**
 * A notifier event as it leaves the process: `DriverEvent` minus `ns` and
 * `origin`, with every payload error shaped as an `ErrorDto` — what
 * {@link toEventDto} builds and the socket sends ({@link EventWire}).
 */
export type EventDto = EventWire;

/**
 * A worker as the backend reports it.
 *
 * **Placeholder for the 2.13 read APIs**, which add `WorkerInfo` to the driver
 * contract with exactly these fields. Replace this with an import of
 * `WorkerInfo` once 2.13 merges; the DTO below then follows it.
 */
export interface WorkerInfoLike {
  /** The worker's id. */
  id: string;
  /** The queue it consumes. */
  queue: string;
  /** The host it runs on. */
  host: string;
  /** Its process id. */
  pid: number;
  /** How many jobs it runs at once. */
  concurrency: number;
  /** How many jobs it was running at its last report. */
  active: number;
  /** Whether it was locally paused at its last report. */
  paused: boolean;
  /** When it started consuming, epoch ms. */
  startedAt: number;
  /** When it last reported, epoch ms. */
  heartbeatAt: number;
  /** When the record lapses unless the worker reports again, epoch ms. */
  expiresAt: number;
}

/** A worker as a client sees it. */
export interface WorkerDto extends Omit<WorkerInfoLike, "host" | "pid"> {
  /** The host it runs on; omitted with `exposeHosts: false`. */
  host?: string;
  /** Its process id; omitted with `exposeHosts: false`. */
  pid?: number;
}

/** What `/meta` answers. Defined in the contract, which a browser client imports. */
export type { MetaDto } from "./contract/types";

/** How deep an error's cause chain is followed. */
const MAX_CAUSE_DEPTH = 5;

/** Shapes a stored error; `stack` only when stacks are exposed. */
export function toErrorDto(
  error: SerializedError,
  options: Pick<ResolvedJobsApiSerializers, "exposeStacks">,
  depth = 0,
): ErrorDto {
  const dto: ErrorDto = { name: error.name, message: error.message };
  if (error.code !== undefined) {
    dto.code = error.code;
  }
  if (options.exposeStacks && error.stack !== undefined) {
    dto.stack = error.stack;
  }
  if (error.data !== undefined) {
    dto.data = error.data;
  }
  if (error.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    dto.cause = toErrorDto(error.cause, options, depth + 1);
  }
  return dto;
}

/** Shapes a flow. */
function toFlowDto(
  flow: JobFlow,
  options: ResolvedJobsApiSerializers,
): JobFlowDto {
  return {
    parent: flow.parent
      ? { queue: flow.parent.queue, id: flow.parent.id }
      : null,
    children: flow.children.map((child) => ({
      queue: child.queue,
      id: child.id,
    })),
    pending: flow.pending,
    values: flow.values,
    failures: Object.fromEntries(
      Object.entries(flow.failures).map(([key, failure]) => [
        key,
        toErrorDto(failure, options),
      ]),
    ),
    recorded: flow.recorded,
  };
}

/** What a job DTO is built for. */
export interface JobDtoInput {
  /** The queue the job is in. */
  queue: string;
  /** Optional fields to include. */
  include: ReadonlySet<JobInclude>;
  /** The request, handed to the `serialize.job` hook. */
  req: BunRequest;
}

/** Shapes a job, then applies `serialize.job`. */
export function toJobDto(
  record: JobRecord,
  input: JobDtoInput,
  options: ResolvedJobsApiSerializers,
): JobDto {
  const dto: JobDto = {
    queue: input.queue,
    id: record.id,
    name: record.name,
    state: record.state,
    priority: record.priority,
    runAt: record.runAt,
    createdAt: record.createdAt,
    processedOn: record.processedOn,
    finishedOn: record.finishedOn,
    expiresAt: record.expiresAt,
    attemptsMade: record.attemptsMade,
    maxAttempts: record.maxAttempts,
    stalledCount: record.stalledCount,
    progress: record.progress,
    failedReason: record.failedReason
      ? toErrorDto(record.failedReason, options)
      : null,
    lockExpiresAt: record.lockExpiresAt,
    workerId: record.workerId,
    repeatKey: record.repeatKey,
    flow: record.flow ? toFlowDto(record.flow, options) : null,
  };
  if (input.include.has("data")) {
    dto.data = record.data;
  }
  if (input.include.has("returnValue")) {
    dto.returnValue = record.returnValue;
  }
  if (input.include.has("stacktrace")) {
    dto.stacktrace = record.stacktrace.map((entry) =>
      toErrorDto(entry, options),
    );
  }
  if (input.include.has("opts")) {
    dto.opts = record.opts;
  }
  return options.job ? options.job(dto, record, input.req) : dto;
}

/** Shapes a repeat series, then applies `serialize.repeatable`. */
export function toRepeatableDto(
  record: RepeatRecord,
  input: JobDtoInput,
  options: ResolvedJobsApiSerializers,
): RepeatableDto {
  const dto: RepeatableDto = {
    queue: input.queue,
    key: record.key,
    name: record.name,
    opts: record.opts,
    count: record.count,
    nextRunAt: record.nextRunAt,
    nextJobId: record.nextJobId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  for (const key of [
    "cron",
    "tz",
    "every",
    "startAt",
    "endAt",
    "limit",
    "catchUp",
  ] as const) {
    if (record[key] !== undefined) {
      (dto as unknown as Record<string, unknown>)[key] = record[key];
    }
  }
  if (input.include.has("data")) {
    dto.data = record.data;
  }
  return options.repeatable ? options.repeatable(dto, record, input.req) : dto;
}

/** Shapes a run record, then applies `serialize.run`. */
export function toRunRecordDto(
  record: RunRecord,
  req: BunRequest,
  options: ResolvedJobsApiSerializers,
): RunRecordDto {
  const dto: RunRecordDto = {
    runId: record.runId,
    runnerId: record.runnerId,
    attempt: record.attempt,
    source: record.source,
    mode: record.mode,
    startedAt: record.startedAt,
    status: record.status,
  };
  if (options.exposeHosts) {
    dto.host = record.host;
    if (record.pid !== undefined) {
      dto.pid = record.pid;
    }
  }
  for (const key of [
    "finishedAt",
    "durationMs",
    "exitCode",
    "signal",
    "result",
    "detached",
  ] as const) {
    if (record[key] !== undefined) {
      (dto as unknown as Record<string, unknown>)[key] = record[key];
    }
  }
  if (record.error) {
    dto.error = toErrorDto(record.error, options);
  }
  return options.run ? options.run(dto, record, req) : dto;
}

/**
 * Shapes a runner snapshot — what `RemoteRunner.info()` returns, for a local
 * or a remote runner alike — then applies `serialize.runner`.
 */
export function toRunnerInfoDto(
  info: RemoteRunnerInfo,
  req: BunRequest,
  options: ResolvedJobsApiSerializers,
): RunnerInfoDto {
  const dto: RunnerInfoDto = {
    id: info.id,
    namespace: info.namespace,
    isLocal: info.isLocal,
    name: info.name,
    schedule: info.schedule,
    nextRunAt: info.nextRunAt ? info.nextRunAt.getTime() : null,
    isPaused: info.isPaused,
    isRunning: info.isRunning,
    queuedTriggers: info.queuedTriggers,
    stats: { ...info.stats },
  };
  for (const key of [
    "executionMode",
    "runMode",
    "queueRuns",
    "maxQueuedRuns",
    "maxConcurrency",
    "updatedAt",
  ] as const) {
    const value = info[key];
    // `maxConcurrency` is `Infinity` when unlimited, which JSON would turn
    // into `null`; an unlimited cap is reported by leaving it out.
    if (
      value !== undefined &&
      (typeof value !== "number" || Number.isFinite(value))
    ) {
      (dto as unknown as Record<string, unknown>)[key] = value;
    }
  }
  if (options.exposeRunnerFiles && info.file !== undefined) {
    dto.file = info.file;
  }
  if (info.local) {
    dto.local = {
      status: info.local.status,
      activeRuns: info.local.activeRuns.map((run) =>
        toRunRecordDto(run, req, options),
      ),
      nextRunAt: info.local.nextRunAt ? info.local.nextRunAt.getTime() : null,
    };
  }
  if (info.runningOn) {
    dto.runningOn = {
      runId: info.runningOn.runId,
      since: info.runningOn.since,
    };
    if (options.exposeHosts) {
      dto.runningOn.host = info.runningOn.host;
      dto.runningOn.pid = info.runningOn.pid;
    }
  }
  if (info.lastRun) {
    dto.lastRun = toRunRecordDto(info.lastRun as RunRecord, req, options);
  }
  if (info.lastError) {
    dto.lastError = {
      name: info.lastError.name,
      message: info.lastError.message,
    };
  }
  return options.runner ? options.runner(dto, info, req) : dto;
}

/** Whether a payload value is a serialised error. */
function isSerializedError(value: unknown): value is SerializedError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/**
 * Shapes an event for one session: drops `ns` and `origin` (a process token
 * that decodes to host and pid), strips stacks, then applies `serialize.event`,
 * which may drop the event with `null`.
 */
export function toEventDto(
  event: DriverEvent,
  req: BunRequest,
  options: ResolvedJobsApiSerializers,
): EventDto | null {
  const payload = event.payload as Record<string, unknown>;
  const shaped =
    "error" in payload && isSerializedError(payload.error)
      ? { ...payload, error: toErrorDto(payload.error, options) }
      : payload;
  const dto = {
    v: event.v,
    kind: event.kind,
    type: event.type,
    target: event.target,
    at: event.at,
    ...(event.id === undefined ? {} : { id: event.id }),
    payload: shaped,
  } as EventDto;
  return options.event ? options.event(dto, event, req) : dto;
}

/** Shapes a worker; host and pid only with `exposeHosts`. */
export function toWorkerDto(
  worker: WorkerInfoLike,
  options: Pick<ResolvedJobsApiSerializers, "exposeHosts">,
): WorkerDto {
  const dto: WorkerDto = {
    id: worker.id,
    queue: worker.queue,
    concurrency: worker.concurrency,
    active: worker.active,
    paused: worker.paused,
    startedAt: worker.startedAt,
    heartbeatAt: worker.heartbeatAt,
    expiresAt: worker.expiresAt,
  };
  if (options.exposeHosts) {
    dto.host = worker.host;
    dto.pid = worker.pid;
  }
  return dto;
}
