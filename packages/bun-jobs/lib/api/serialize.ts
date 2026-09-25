import type { BunRequest, SerializedError } from "@kingsleyweb/bun-common";
import type {
  DriverEvent,
  JobFlow,
  JobRecord,
  JobState,
  JobWorkerRef,
  RepeatRecord,
  ResolvedJobOptions,
  RunLogLine,
  RunRecord,
  StoredJobOptions,
  WorkerInfo,
} from "../drivers/index";
import type {
  RunnerConfigInfo,
  RunnerStatus,
  SharedRunnerInfo,
} from "../runner/types";
import type { RunProgress } from "../shared/progress";
import type { ResolvedJobsApiSerializers } from "./config";
import type { JobDefaultKey, JobInclude } from "./contract/constants";
import type { EventWire } from "./ws/events";
import { explicitKeys } from "../queue/jobDefaults";
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
  /** Latest progress value, or `null` before any is reported. */
  progress: RunProgress | null;
  /** The most recent failure. */
  failedReason: ErrorDto | null;
  /** When the holding worker's lock expires, epoch ms. */
  lockExpiresAt: number | null;
  /**
   * Id of the worker holding it now: set while `active`, `null` once it
   * settles. Who ran a finished job is {@link JobDto.processedBy}.
   */
  workerId: string | null;
  /**
   * The worker that claimed the current or last attempt, kept after the job
   * settles; `null` for a job never claimed, or claimed where attribution is
   * not recorded. `host` and `pid` only with `exposeHosts`.
   */
  processedBy: JobWorkerDto | null;
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
  opts?: SerializedJobOptions;
}

/**
 * A job's options as a client sees them: the stored options, with the
 * explicit-option mask (`opts.explicit`, a number only the drivers read)
 * turned into the key names it marks. `explicit` is absent on a job added
 * before the mask existed, which is not the same as `[]`.
 */
export interface SerializedJobOptions extends ResolvedJobOptions {
  /** The options the job's own `add()` passed explicitly, in `JOB_DEFAULT_KEYS` order. */
  explicit?: JobDefaultKey[];
}

/**
 * Stored options as {@link SerializedJobOptions}: every option passed through
 * as it is stored (a record written by another version may carry options this
 * one does not know), except the mask, which is never sent as a number.
 */
export function toJobOptionsDto(
  opts: StoredJobOptions | ResolvedJobOptions,
): SerializedJobOptions {
  const { explicit, ...rest } = opts as StoredJobOptions;
  const keys = explicitKeys(explicit);
  return keys === undefined ? rest : { ...rest, explicit: keys };
}

/**
 * The worker that claimed a job's current or last attempt, as a client sees
 * it: the stored {@link JobWorkerRef} minus what `exposeHosts` hides — the
 * same rule, and the same four fields, as {@link WorkerDto}.
 */
export interface JobWorkerDto {
  /** The claiming incarnation's id (`WorkerDto.id`). */
  id: string;
  /** Its stable key (`WorkerDto.key`); absent when the claimer recorded only the id. */
  key?: string;
  /** The host it ran on; omitted with `exposeHosts: false`, and when not recorded. */
  host?: string;
  /** Its process id; omitted with `exposeHosts: false`, and when not recorded. */
  pid?: number;
}

/** Where a page sits in its list. */
export interface PageInfoDto {
  /**
   * Items skipped before this page — and, on a page reached with a `cursor`,
   * where the seek landed, so a walked page can still say where it sits.
   *
   * **Absent only on a cursor page whose backend did not count what precedes
   * it.** `GET /queues/{queue}/jobs` on SQL or MongoDB is that case, and it is
   * deliberate: counting the jobs before the key is an index range scan of
   * exactly the size the `offset` would have walked, so answering it would
   * make a cursor page cost what the offset page cost. Every offset page has
   * it, and so does every page of the runner history, whose whole list the
   * backend holds anyway.
   */
  offset?: number;
  /** Most items the page could hold. */
  limit: number;
  /** Items in the whole list, when it was counted. */
  total?: number;
  /** Whether items follow this page. */
  hasMore: boolean;
  /**
   * Opaque cursor continuing the walk after this page's last item — send it
   * back as `cursor` — or `null` when the walk is complete. Present only where
   * the route pages by cursor, and `next === null` is that route's
   * end-of-list signal.
   */
  next?: string | null;
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
export interface RepeatableDto extends Omit<RepeatRecord, "data" | "opts"> {
  /** The queue the series belongs to. */
  queue: string;
  /** Options each occurrence gets, the explicit-option mask as key names. */
  opts: SerializedJobOptions;
  /** Payload given to each instance; with `include=data`. */
  data?: unknown;
  /** Whether the series is disabled: it schedules nothing until enabled. */
  disabled: boolean;
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
 * One captured line of a run's output as a client sees it: the store's line
 * exactly, except that its `text` is sent as `message` — what a job log line
 * is called, so a reader has one name for a logged line.
 */
export interface RunLogLineDto extends Omit<RunLogLine, "text"> {
  /** The line's text, with its trailing newline already removed. */
  message: string;
}

/**
 * A runner snapshot as a client sees it, for a runner registered in any
 * process: the backend's view (`SharedRunnerInfo`), plus this process's own
 * view under `local` when the runner is registered here.
 */
export interface RunnerInfoDto extends Omit<
  SharedRunnerInfo,
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
 * A worker as the backend reports it: the driver's own heartbeat record.
 *
 * An alias rather than a shape of its own — it was a placeholder for the
 * record the 2.13 read APIs added, and the DTO below now follows
 * {@link WorkerInfo} field for field, so the two can no longer drift.
 */
export type WorkerInfoLike = WorkerInfo;

/**
 * A worker as a client sees it: its record, minus what `exposeHosts` hides,
 * plus the `stale` flag the server computes (the record carries the
 * heartbeat, not the verdict).
 */
export interface WorkerDto extends Omit<WorkerInfo, "host" | "pid"> {
  /**
   * Whether it has missed a report — `now - heartbeatAt` past
   * {@link STALE_REPORTS} times its effective `reportInterval`. Absent on a
   * worker that reports no config, where there is no interval to judge it by.
   */
  stale?: boolean;
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
    progress: toProgress(record.progress),
    failedReason: record.failedReason
      ? toErrorDto(record.failedReason, options)
      : null,
    lockExpiresAt: record.lockExpiresAt,
    workerId: record.workerId,
    processedBy: record.processedBy
      ? toJobWorkerDto(record.processedBy, options)
      : null,
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
    dto.opts = toJobOptionsDto(record.opts);
  }
  return options.job ? options.job(dto, record, input.req) : dto;
}

/**
 * Shapes a job's attribution stamp, picked field by field; `host` and `pid`
 * only with `exposeHosts`, exactly as {@link toWorkerDto} decides them.
 */
export function toJobWorkerDto(
  stamp: JobWorkerRef,
  options: Pick<ResolvedJobsApiSerializers, "exposeHosts">,
): JobWorkerDto {
  const dto: JobWorkerDto = { id: stamp.id };
  if (stamp.key !== undefined) {
    dto.key = stamp.key;
  }
  if (options.exposeHosts) {
    if (stamp.host !== undefined) {
      dto.host = stamp.host;
    }
    if (stamp.pid !== undefined) {
      dto.pid = stamp.pid;
    }
  }
  return dto;
}

/**
 * A stored progress value as the wire types it: what `updateProgress()`
 * accepts — a number, or a record of fields. The record keeps `unknown`
 * progress because a driver stores whatever it was given; anything else (a
 * value written outside this package) is reported as `null` rather than sent
 * under a type it does not have.
 */
export function toProgress(value: unknown): RunProgress | null {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
}

/** Shapes a repeat series, then applies `serialize.repeatable`. */
export function toRepeatableDto(
  record: RepeatRecord & {
    /** Whether the series is disabled; absent reads as `false`. */
    disabled?: boolean;
  },
  input: JobDtoInput,
  options: ResolvedJobsApiSerializers,
): RepeatableDto {
  const dto: RepeatableDto = {
    queue: input.queue,
    key: record.key,
    name: record.name,
    opts: toJobOptionsDto(record.opts),
    count: record.count,
    // A disabled series has no next occurrence, whatever a stale pointer says.
    nextRunAt: record.disabled ? null : record.nextRunAt,
    nextJobId: record.disabled ? null : record.nextJobId,
    disabled: record.disabled ?? false,
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
  // Every optional field is copied only when the record has it, which is what
  // the two run-log counters need: absent says this backend stores no run
  // logs, `0` says the run was quiet, and a `?? 0` would turn the first into
  // the second for every driver that cannot capture.
  for (const key of [
    "finishedAt",
    "durationMs",
    "exitCode",
    "signal",
    "result",
    "detached",
    "logLines",
    "logsDropped",
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
 * Shapes one captured run-log line for the wire.
 *
 * The one rename in the whole surface: the store's `text` is the DTO's
 * `message`, which is what a job log line is called. Nothing is redacted —
 * a line is the run's own output, and `exposeHosts`/`exposeStacks` have no
 * say over what a program printed — and the two optional fields are sent only
 * when they are set, so `truncated` absent means the line is whole.
 */
export function toRunLogLineDto(line: RunLogLine): RunLogLineDto {
  const dto: RunLogLineDto = {
    seq: line.seq,
    at: line.at,
    stream: line.stream,
    message: line.text,
  };
  if (line.level !== undefined) {
    dto.level = line.level;
  }
  if (line.truncated) {
    dto.truncated = true;
  }
  return dto;
}

/**
 * A runner's configuration as a client sees it: the runtime's record field
 * for field — every one of them is already safe to publish — so the DTO and
 * the record cannot drift, as `WorkerInfoLike` does for a worker's.
 */
export type RunnerConfigDto = RunnerConfigInfo;

/**
 * Shapes a runner's configuration for a client: its values, what its code
 * asked for, and how far an owner has adopted the stored override.
 *
 * Picked field by field like every other DTO here, not spread — a field added
 * to `RunnerConfigInfo` is then published only once somebody decides to.
 */
export function toRunnerConfigDto(config: RunnerConfigInfo): RunnerConfigDto {
  return {
    effective: { ...config.effective },
    ...(config.code ? { code: { ...config.code } } : {}),
    overridden: [...config.overridden],
    ...(config.allowed ? { allowed: [...config.allowed] } : {}),
    seq: config.seq,
    ...(config.appliedSeq === undefined
      ? {}
      : { appliedSeq: config.appliedSeq }),
    ...(config.error
      ? {
          error: {
            at: config.error.at,
            message: config.error.message,
            keys: [...config.error.keys],
          },
        }
      : {}),
    ...(config.updatedAt === undefined ? {} : { updatedAt: config.updatedAt }),
  };
}

/**
 * Shapes a runner snapshot — what `RunnerController.info()` returns, for a
 * runner registered here or in another process alike — then applies
 * `serialize.runner`.
 */
export function toRunnerInfoDto(
  info: SharedRunnerInfo,
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
  if (info.config) {
    dto.config = toRunnerConfigDto(info.config);
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

/**
 * How many report intervals a worker may miss before it is `stale`.
 *
 * Under three (`REPORT_LIFETIMES`, after which the record lapses and the
 * worker stops being listed at all) and over one, since a report landing a
 * few milliseconds late is ordinary jitter, not a sick worker.
 */
export const STALE_REPORTS = 1.5;

/**
 * Whether a worker has missed a report. `undefined` when it reports no
 * config, so there is no interval to judge it by — an older worker is
 * reported honestly as unknown rather than guessed at with a default.
 */
export function isWorkerStale(
  worker: WorkerInfoLike,
  now: number,
): boolean | undefined {
  const interval = worker.config?.effective.reportInterval;
  if (typeof interval !== "number" || !Number.isFinite(interval)) {
    return undefined;
  }
  return now - worker.heartbeatAt > interval * STALE_REPORTS;
}

/**
 * Shapes a worker; host and pid only with `exposeHosts`, and `stale` computed
 * here because the record carries the heartbeat rather than the verdict.
 */
export function toWorkerDto(
  worker: WorkerInfoLike,
  options: Pick<ResolvedJobsApiSerializers, "exposeHosts">,
  now: number = Date.now(),
): WorkerDto {
  const stale = isWorkerStale(worker, now);
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
  if (worker.key !== undefined) {
    dto.key = worker.key;
  }
  if (worker.service !== undefined) {
    dto.service = worker.service;
  }
  if (worker.state !== undefined) {
    dto.state = worker.state;
  }
  if (worker.processStartedAt !== undefined) {
    dto.processStartedAt = worker.processStartedAt;
  }
  if (stale !== undefined) {
    dto.stale = stale;
  }
  if (worker.version !== undefined) {
    dto.version = worker.version;
  }
  // Only when the record carries them: absent (a worker from before the
  // counters) and `0` (one that has finished nothing yet) are different
  // answers, as with a run's log counters.
  if (worker.completed !== undefined) {
    dto.completed = worker.completed;
  }
  if (worker.failed !== undefined) {
    dto.failed = worker.failed;
  }
  // The same rule for the two heartbeat samples: absent (a worker that does
  // not report them, or one whose first write has not returned yet) is a
  // different answer from `0`.
  if (worker.rssBytes !== undefined) {
    dto.rssBytes = worker.rssBytes;
  }
  if (worker.heartbeatRttMs !== undefined) {
    dto.heartbeatRttMs = worker.heartbeatRttMs;
  }
  // And for `sweeps`: absent (a worker from before the field) means "too old
  // to say", which a reader must not read as `false`.
  if (worker.sweeps !== undefined) {
    dto.sweeps = worker.sweeps;
  }
  if (worker.config !== undefined) {
    dto.config = toWorkerConfigDto(worker.config);
  }
  if (worker.control !== undefined) {
    dto.control = toWorkerControlDto(worker.control);
  }
  if (options.exposeHosts) {
    dto.host = worker.host;
    dto.pid = worker.pid;
  }
  return dto;
}

/** Shapes a worker's settings: copied field by field, like every other DTO. */
function toWorkerConfigDto(
  config: NonNullable<WorkerInfo["config"]>,
): NonNullable<WorkerDto["config"]> {
  return {
    effective: { ...config.effective },
    code: { ...config.code },
    overridden: [...config.overridden],
    ...(config.derived === undefined ? {} : { derived: [...config.derived] }),
    seq: config.seq,
    ...(config.updatedAt === undefined ? {} : { updatedAt: config.updatedAt }),
  };
}

/** Shapes what a worker says about being controlled from outside. */
function toWorkerControlDto(
  control: NonNullable<WorkerInfo["control"]>,
): NonNullable<WorkerDto["control"]> {
  return {
    enabled: control.enabled,
    mode: control.mode,
    appliedSeq: control.appliedSeq,
    configSeq: control.configSeq,
    pending: control.pending,
    stopPersistence: control.stopPersistence,
    stopPersistenceOverridable: control.stopPersistenceOverridable,
    ...(control.lastError === undefined
      ? {}
      : {
          lastError: {
            at: control.lastError.at,
            message: control.lastError.message,
            ...(control.lastError.action === undefined
              ? {}
              : { action: control.lastError.action }),
            ...(control.lastError.seq === undefined
              ? {}
              : { seq: control.lastError.seq }),
          },
        }),
  };
}
