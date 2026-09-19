import type {
  JobInclude,
  JobsApiAction,
  JobsApiMode,
  JobState,
} from "./constants";

/**
 * Every request and response of the management API's HTTP routes, as named
 * types a client can compile against.
 *
 * **Browser-safe**: this file imports only its sibling `constants.ts`, and
 * only types, so it never reaches a driver, bun-common or Bun's own types.
 *
 * **Cannot drift from the server.** Each type here restates a schema in
 * `lib/api/schemas/`, and `__tests__/api/api-contract.type-test.ts` asserts,
 * type by type, that it *equals* the type that schema infers (for a request,
 * once its defaults are applied). A field added to a schema and not here, or
 * the other way round, fails the typecheck.
 *
 * Naming: a response body is `…Dto`, a request body `…Body`, a query `…Query`.
 * A request field with a server default is optional here, because a client
 * need not send it.
 */

/* ------------------------------------------------------------------ *
 * Shared shapes
 * ------------------------------------------------------------------ */

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
  /** Human detail for this occurrence. For 5xx always the generic title. */
  detail?: string;
  /** The request path. */
  instance?: string;
  /** Validation issues. */
  issues?: ProblemIssueDto[];
  /** Safe, whitelisted context (e.g. `{ state: "active" }`, `{ max: 1000 }`). */
  context?: Record<string, unknown>;
}

/** An error as a client sees it. */
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
  /** The error's cause, shaped the same way (followed at most five levels). */
  cause?: ErrorDto;
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

/** A reference to a job: its queue and id. */
export interface JobRefDto {
  /** The queue the job is in. */
  queue: string;
  /** The job's id. */
  id: string;
}

/** A time a request may give: epoch milliseconds, or an RFC 3339 date-time. */
export type TimeInput = number | string;

/** Sort order of a list. */
export type SortOrder = "asc" | "desc";

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

/** How long finished jobs are kept: `true`/`false`, a count, or a count and an age. */
export type RetentionDto =
  | boolean
  | number
  | {
      /** Most finished jobs kept. */
      count?: number;
      /** Oldest finished job kept, in ms. */
      ttl?: number;
    };

/** A job's options after defaults. The server may add options this version does not know. */
export interface JobOptionsDto {
  /** Lower runs first. */
  priority: number;
  /** Attempts allowed in total. */
  attempts: number;
  /** Delay between attempts: fixed ms, or a strategy. */
  backoff:
    | number
    | {
        /** The strategy's name, e.g. `"exponential"`. */
        type?: string;
        /** Base delay, ms. */
        delay?: number;
        /** Growth factor. */
        factor?: number;
        /** Longest delay, ms. */
        max?: number;
        /** Randomisation: a fraction, or on/off. */
        jitter?: number | boolean;
      };
  /** Processor timeout, ms. */
  timeout: number;
  /** Retention of completed jobs. */
  removeOnComplete: RetentionDto;
  /** Retention of failed jobs. */
  removeOnFail: RetentionDto;
  /** How many failure stack traces are kept. */
  keepStacktraces: number;
  /** Queue a dead job is moved to. */
  deadLetter?: string;
  /** How many log lines are kept. */
  keepLogs?: number;
  /** Whether a flow parent ignores this child's failure. */
  ignoreFailure?: boolean;
}

/** A job's place in a flow. */
export interface JobFlowDto {
  /** Its parent, or `null` at the root. */
  parent: JobRefDto | null;
  /** Its children. */
  children: JobRefDto[];
  /** Children not yet finished. */
  pending: number;
  /** Children's return values, keyed `queue:id`. */
  values: Record<string, unknown>;
  /** Failures of children marked `ignoreFailure`, keyed `queue:id`. */
  failures: Record<string, ErrorDto>;
  /** Whether the flow was recorded on the parent. */
  recorded: boolean;
}

/** A job as a client sees it. Never carries a lock token. */
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
  opts?: JobOptionsDto;
}

/** `GET /queues/:queue/jobs`. */
export type JobPageDto = PageDto<JobDto>;

/** `GET /queues/:queue/jobs` query. */
export interface JobListQuery {
  /** States to list; every state when absent. */
  state?: JobState[];
  /** Jobs skipped. Defaults to `0`. */
  offset?: number;
  /** Page size. Defaults to `limits.defaultPageSize`; at most `limits.maxPageSize`. */
  limit?: number;
  /** Order within the states. Defaults to `"asc"`. */
  order?: SortOrder;
  /** Optional fields to include. */
  include?: JobInclude[];
  /** Only jobs with one of these names, exactly. */
  name?: string[];
  /** Only jobs whose id or name contains this, ignoring case. */
  search?: string;
  /** Also count every match. Defaults to `false`. */
  total?: boolean;
}

/** `include` alone: `GET /queues/:queue/jobs/:id` and `…/children`. */
export interface IncludeQuery {
  /** Optional fields to include. */
  include?: JobInclude[];
}

/** `POST /queues/:queue/jobs/lookup` body. */
export interface LookupBody {
  /** The ids, at most `limits.maxBulkIds`. */
  ids: string[];
  /** Optional fields to include. */
  include?: JobInclude[];
}

/** `POST /queues/:queue/jobs/lookup`: one entry per id, in order, `null` when missing. */
export interface LookupResultDto {
  /** The jobs, in the order asked. */
  items: (JobDto | null)[];
}

/** `GET /queues/:queue/jobs/:id/logs` query. */
export interface LogsQuery {
  /** Lines skipped. Defaults to `0`. */
  offset?: number;
  /** Page size. Defaults to `min(100, limits.maxLogPage)`; at most `limits.maxLogPage`. */
  limit?: number;
  /** Order. Defaults to `"asc"`. */
  order?: SortOrder;
}

/** `GET /queues/:queue/jobs/:id/logs`. */
export interface LogPageDto {
  /** The log lines. */
  items: string[];
  /** Where the page sits; `total` is always present. */
  page: PageInfoDto;
}

/** One child in {@link ChildrenDto}. */
export interface ChildDto {
  /** The child's queue. */
  queue: string;
  /** The child's id. */
  id: string;
  /** The child, or `null` when it is gone or in a queue this API cannot reach. */
  job: JobDto | null;
  /** Its return value, when the parent recorded one. */
  value?: unknown;
  /** Its ignored failure, when the parent recorded one. */
  failure?: ErrorDto;
}

/** `GET /queues/:queue/jobs/:id/children`. */
export interface ChildrenDto {
  /** The job's parent, or `null`. */
  parent: JobRefDto | null;
  /** Children not yet finished. */
  pending: number;
  /** At most `limits.maxBulkIds` children. */
  children: ChildDto[];
  /** Whether there were more children than listed. */
  truncated: boolean;
}

/** `PATCH /queues/:queue/jobs/:id` body. At least one of `data`, `priority`, `runAt`. */
export interface UpdateJobBody {
  /** The new payload. */
  data?: unknown;
  /** The new priority. */
  priority?: number;
  /** The new run time; only for a waiting or delayed job. */
  runAt?: TimeInput;
  /** Apply only while the job is in one of these states. */
  onlyIn?: JobState[];
}

/** `POST /queues/:queue/jobs/:id/retry` body. */
export interface RetryJobBody {
  /** Reset the attempt count. Defaults to `true`. */
  resetAttempts?: boolean;
}

/** `POST /queues/:queue/jobs/:id/retry`. */
export interface RetryJobResultDto {
  /** Always `true`: a refusal is a problem. */
  retried: true;
}

/** `POST /queues/:queue/jobs/:id/fail` body. */
export interface FailJobBody {
  /** Why the job is failed; becomes its `failedReason` message. */
  reason: string;
}

/** `POST /queues/:queue/jobs/:id/fail`. */
export interface FailJobResultDto {
  /** Always `true`: a refusal is a problem. */
  failed: true;
}

/** `POST /queues/:queue/repeatables/:key/disable`. */
export interface DisableRepeatableResultDto {
  /** Always `true`, including for a series that already was. */
  disabled: true;
}

/** `POST /queues/:queue/repeatables/:key/enable`. */
export interface EnableRepeatableResultDto {
  /** Always `true`, including for a series that already was. */
  enabled: true;
}

/** `POST /queues/:queue/jobs/:id/promote`. */
export interface PromoteJobResultDto {
  /** Always `true`: a refusal is a problem. */
  promoted: true;
}

/** `POST /queues/:queue/jobs/remove` and `…/promote` body. */
export interface BulkIdsBody {
  /** The ids, at most `limits.maxBulkIds`. */
  ids: string[];
}

/** `POST /queues/:queue/jobs/retry` body. */
export interface BulkRetryBody {
  /** The ids, at most `limits.maxBulkIds`. */
  ids: string[];
  /** Reset the attempt count. Defaults to `true`. */
  resetAttempts?: boolean;
}

/** `POST /queues/:queue/jobs/retry`. */
export interface BulkRetryResultDto {
  /** Ids returned to the queue. */
  retried: string[];
  /** Ids missing, running or already pending. */
  skipped: string[];
}

/** `POST /queues/:queue/jobs/remove`. */
export interface BulkRemoveResultDto {
  /** Ids removed. */
  removed: string[];
  /** Ids missing or running. */
  skipped: string[];
}

/** `POST /queues/:queue/jobs/promote`. */
export interface BulkPromoteResultDto {
  /** Ids made claimable. */
  promoted: string[];
  /** Ids missing or not delayed. */
  skipped: string[];
}

/** `POST /queues/:queue/jobs/retry-all` body. */
export interface RetryAllBody {
  /** The state to re-drive. */
  state: "dead" | "failed" | "completed";
  /** Only jobs with this name. */
  name?: string;
  /** A substring of the last failure, as `"<error name>: <message>"`. */
  reason?: string;
  /** Most jobs moved. Defaults to, and is at most, `limits.maxRetryAll`. */
  limit?: number;
  /** Reset the attempt count. Defaults to `true`. */
  resetAttempts?: boolean;
}

/** `POST /queues/:queue/jobs/retry-all`. */
export interface RetryAllResultDto {
  /** Jobs retried. */
  count: number;
  /** The first 1000 ids retried. */
  ids: string[];
  /** Whether more were retried than `ids` lists. */
  truncated: boolean;
}

/** The options `POST /queues/:queue/jobs` accepts: a safe subset. */
export interface AddJobOptions {
  /**
   * A caller-chosen id, at most `MAX_JOB_ID_LENGTH` (191) characters; an
   * existing one answers that job with `added: false`. bun-jobs may still
   * refuse it (400 `INVALID_ARGUMENT`): control characters, a leading `.`, a
   * lone surrogate, or more than 191 UTF-16 units.
   */
  jobId?: string;
  /** Lower runs first. */
  priority?: number;
  /** Delay before the job is claimable, ms. */
  delay?: number;
  /** When the job becomes claimable. */
  runAt?: TimeInput;
  /** Attempts allowed in total. */
  attempts?: number;
  /** Fixed delay between attempts, ms. */
  backoff?: number;
  /** Processor timeout, ms. */
  timeout?: number;
}

/** `POST /queues/:queue/jobs` body. */
export interface AddJobBody {
  /** The job name; must be addable (see `MetaDto.addableNames`). */
  name: string;
  /** The payload. JSON; `null` is allowed. */
  data: unknown;
  /** A safe subset of options. */
  opts?: AddJobOptions;
}

/** `POST /queues/:queue/jobs`: 201 when added, 200 when `jobId` matched an existing job. */
export interface AddJobResultDto {
  /** `false` when `jobId` matched an existing job, which is returned. */
  added: boolean;
  /** The job. */
  job: JobDto;
}

/** A repeat series as a client sees it. */
export interface RepeatableDto {
  /** The queue the series belongs to. */
  queue: string;
  /** The series key. */
  key: string;
  /** The job name each occurrence gets. */
  name: string;
  /** Options each occurrence gets. */
  opts: JobOptionsDto;
  /** Cron expression. */
  cron?: string;
  /** Cron time zone. */
  tz?: string;
  /** Interval, ms. */
  every?: number;
  /** First occurrence not before, epoch ms. */
  startAt?: number;
  /** No occurrence after, epoch ms. */
  endAt?: number;
  /** Most occurrences. */
  limit?: number;
  /** Whether missed occurrences are caught up. */
  catchUp?: boolean;
  /** Occurrences so far. */
  count: number;
  /** Next occurrence, epoch ms, or `null` — always `null` while disabled. */
  nextRunAt: number | null;
  /** Id of the scheduled occurrence, or `null` — always `null` while disabled. */
  nextJobId: string | null;
  /** Whether the series is disabled: it schedules nothing until enabled. */
  disabled: boolean;
  /** When created, epoch ms. */
  createdAt: number;
  /** When last changed, epoch ms. */
  updatedAt: number;
  /** Payload given to each occurrence; with `include=data`. */
  data?: unknown;
}

/** `GET /queues/:queue/repeatables` query. */
export interface RepeatableListQuery {
  /** `["data"]` to include each series' payload. */
  include?: "data"[];
}

/** `GET /queues/:queue/repeatables`. */
export interface RepeatableListDto {
  /** The series. */
  items: RepeatableDto[];
}

/** One definition in {@link DefinitionListDto}. */
export interface DefinitionDto {
  /** The job name. */
  name: string;
  /** The definition's job options, as JSON. */
  options: Record<string, unknown>;
}

/** `GET /definitions`. */
export interface DefinitionListDto {
  /** Every definition, handlers never included. */
  items: DefinitionDto[];
}

/* ------------------------------------------------------------------ *
 * Queues
 * ------------------------------------------------------------------ */

/** Jobs per state. */
export type JobCountsDto = Record<JobState, number>;

/** A queue at a glance. */
export interface QueueSummaryDto {
  /** The queue's name. */
  name: string;
  /** Jobs per state. */
  counts: JobCountsDto;
  /** Jobs in every state. */
  total: number;
  /** Whether the queue is paused. */
  paused: boolean;
}

/** `GET /queues` query. */
export interface QueueListQuery {
  /** A substring of the queue name, ignoring case. */
  search?: string;
  /** Queues skipped, after filtering. Defaults to `0`. */
  offset?: number;
  /** Page size. Defaults to, and is at most, `limits.maxQueues`. */
  limit?: number;
}

/** `GET /queues`. */
export interface QueueListDto {
  /** The page's queues, sorted by name. */
  items: QueueSummaryDto[];
  /** Whether queues follow this page (the same as `page.hasMore`). */
  truncated: boolean;
  /** Where the page sits; `total` counts every matching queue. */
  page: PageInfoDto;
}

/** A rate as stored: the window in ms. */
export interface StoredRateDto {
  /** Most jobs per window. */
  max: number;
  /** The window, ms. */
  duration: number;
}

/** A queue's limits as stored. */
export interface QueueLimitsDto {
  /** Queue-wide rate. */
  rate?: StoredRateDto;
  /** Queue-wide concurrency. */
  concurrency?: number;
  /** Per-name limits. */
  names?: Record<
    string,
    {
      /** Rate for this name. */
      rate?: StoredRateDto;
      /** Concurrency for this name. */
      concurrency?: number;
    }
  >;
}

/** A rate as `PUT` takes it: the window in ms or as a duration such as `"1 minute"`. */
export interface RateInput {
  /** Most jobs per window. */
  max: number;
  /** The window: ms, or a duration phrase. */
  duration: number | string;
}

/** `PUT /queues/:queue/limits` body (or `null` to remove them). */
export interface QueueLimitsBody {
  /** Queue-wide rate. */
  rate?: RateInput;
  /** Queue-wide concurrency. */
  concurrency?: number;
  /** Per-name limits. */
  names?: Record<
    string,
    {
      /** Rate for this name. */
      rate?: RateInput;
      /** Concurrency for this name. */
      concurrency?: number;
    }
  >;
}

/** `GET /queues/:queue`. */
export interface QueueDetailDto {
  /** The queue's name. */
  name: string;
  /** Jobs per state. */
  counts: JobCountsDto;
  /** Jobs in every state. */
  total: number;
  /** Whether the queue is paused. */
  paused: boolean;
  /** Stored limits (`null` for none); absent when the backend cannot store them. */
  limits?: QueueLimitsDto | null;
}

/** One minute of throughput. */
export interface ThroughputBucketDto {
  /** The start of the minute, epoch ms. */
  at: number;
  /** Jobs completed in that minute. */
  completed: number;
  /** Attempts failed in that minute. */
  failed: number;
}

/** `GET /queues/:queue/throughput`. */
export interface QueueThroughputDto {
  /** Bucket length, ms: `60000`. */
  interval: number;
  /** Start of the oldest bucket, epoch ms. */
  from: number;
  /** Start of the newest bucket (the current minute), epoch ms. */
  to: number;
  /** One bucket per minute, oldest first. */
  buckets: ThroughputBucketDto[];
  /** Jobs completed across every bucket. */
  completed: number;
  /** Attempts failed across every bucket. */
  failed: number;
}

/** `GET /overview` and `GET /queues/:queue/throughput` query. */
export interface MinutesQuery {
  /** Minutes back from the current one. Defaults to `60`; at most `1440`. */
  minutes?: number;
}

/** `GET /overview`. */
export interface OverviewDto {
  /** Queues summarised. */
  queues: number;
  /** Of those, how many are paused. */
  pausedQueues: number;
  /** Jobs per state across them. */
  counts: JobCountsDto;
  /** Jobs in every state across them. */
  total: number;
  /** Whether more queues exist than `limits.maxQueues` summarised. */
  truncated: boolean;
  /** Live workers across them; absent when the backend keeps no worker records. */
  workers?: number;
  /** What finished across them; absent when the backend does not count it. */
  throughput?: {
    /** Minutes covered. */
    minutes: number;
    /** Jobs completed. */
    completed: number;
    /** Attempts failed. */
    failed: number;
  };
  /**
   * The same, per minute: each minute summed over the queues summarised, in
   * the shape of `GET /queues/:queue/throughput`. Present exactly when
   * `throughput` is.
   */
  throughputSeries?: QueueThroughputDto;
}

/** A worker consuming a queue. */
export interface WorkerDto {
  /** The worker's id. */
  id: string;
  /** The queue it consumes. */
  queue: string;
  /** How many jobs it runs at once. */
  concurrency: number;
  /** How many it was running at its last report. */
  active: number;
  /** Whether it was locally paused at its last report. */
  paused: boolean;
  /** When it started consuming, epoch ms. */
  startedAt: number;
  /** When it last reported, epoch ms. */
  heartbeatAt: number;
  /** When the record lapses unless it reports again, epoch ms. */
  expiresAt: number;
  /** Its host; omitted with `serialize.exposeHosts: false`. */
  host?: string;
  /** Its pid; omitted with `serialize.exposeHosts: false`. */
  pid?: number;
}

/** `GET /workers` and `GET /queues/:queue/workers`. */
export interface WorkerListDto {
  /** Live workers. */
  items: WorkerDto[];
}

/** `POST /queues/:queue/pause` and `…/resume`. */
export interface QueuePausedDto {
  /** Whether the queue is now paused. */
  paused: boolean;
}

/** `POST /queues/:queue/drain` body. */
export interface DrainQueueBody {
  /** Also drop delayed jobs. Defaults to `false`. */
  delayed?: boolean;
}

/** `POST /queues/:queue/drain`. */
export interface CountResultDto {
  /** Jobs touched. */
  count: number;
}

/** `POST /queues/:queue/clean` body. */
export interface CleanQueueBody {
  /** The state to clean. */
  state:
    | "completed"
    | "failed"
    | "dead"
    | "waiting"
    | "delayed"
    | "waiting-children";
  /** Only jobs older than this many ms. */
  olderThan: number;
  /** Most jobs removed. Defaults to `min(1000, limits.maxClean)`; at most `limits.maxClean`. */
  limit?: number;
}

/** `POST /queues/:queue/clean`. */
export interface CleanResultDto {
  /** Jobs removed. */
  count: number;
  /** Their ids. */
  ids: string[];
}

/* ------------------------------------------------------------------ *
 * Runners
 * ------------------------------------------------------------------ */

/** Where a run executes. */
export type ExecutionModeDto = "spawn" | "worker" | "in-process";

/**
 * A runner instance's lifecycle in its own process — not whether a run is in
 * progress (that is `isRunning`, and `local.activeRuns`):
 *
 * - `idle`: registered, not started yet;
 * - `running`: started, its schedule armed — whether or not a run is in flight;
 * - `paused`: started, and paused (the schedule does not fire);
 * - `stopped`: stopped for good.
 */
export type RunnerStatusDto = "idle" | "running" | "paused" | "stopped";

/** One run as a client sees it. */
export interface RunRecordDto {
  /** The run's id. */
  runId: string;
  /** The runner's id. */
  runnerId: string;
  /** Attempt number. */
  attempt: number;
  /** What started it. */
  source: "schedule" | "manual" | "queued" | "resume";
  /** Where it executed. */
  mode: ExecutionModeDto;
  /** Host; omitted with `exposeHosts: false`. */
  host?: string;
  /** Pid; omitted with `exposeHosts: false`. */
  pid?: number;
  /** When it started, epoch ms. */
  startedAt: number;
  /** When it finished, epoch ms. */
  finishedAt?: number;
  /** How long it took, ms. */
  durationMs?: number;
  /** Its outcome, or `"running"`. */
  status: "running" | "success" | "failed" | "timeout" | "killed";
  /** Exit code of a spawned process. */
  exitCode?: number | null;
  /** Signal that ended a spawned process. */
  signal?: string | null;
  /** The failure. */
  error?: ErrorDto;
  /** What the handler returned. */
  result?: unknown;
  /** Whether the run outlived its owner. */
  detached?: boolean;
}

/** A normalised schedule, or `null` for none. */
export type RunnerScheduleDto =
  | {
      /** Cron expression. */
      cron: string;
      /** Time zone. */
      tz?: string;
    }
  | {
      /** Interval, ms. */
      every: number;
      /** Anchor, epoch ms. */
      anchor?: number;
    }
  | {
      /** One-off time, epoch ms. */
      at: number;
    }
  | null;

/** A runner's lifetime counters. */
export interface RunnerStatsDto {
  /** Successful runs. */
  success: number;
  /** Failed runs. */
  failed: number;
  /** Runs that timed out. */
  timeout: number;
  /** Runs killed. */
  killed: number;
  /** Runs skipped. */
  skipped: number;
  /** Triggers queued. */
  queued: number;
  /** Every run. */
  total: number;
}

/** A runner snapshot, from any process. */
export interface RunnerInfoDto {
  /** The runner's id. */
  id: string;
  /** Its namespace. */
  namespace: string;
  /** Whether it is registered in this process. */
  isLocal: boolean;
  /** Its display name. */
  name: string;
  /** Handler file; only with `exposeRunnerFiles`. */
  file?: string;
  /** Its schedule. */
  schedule: RunnerScheduleDto;
  /** When the stored schedule next fires, epoch ms, or `null`. */
  nextRunAt: number | null;
  /** Where runs execute. */
  executionMode?: ExecutionModeDto;
  /** Whether runs may overlap. */
  runMode?: "parallel" | "single";
  /** Whether triggers queue while busy. */
  queueRuns?: boolean;
  /** Most queued triggers. */
  maxQueuedRuns?: number;
  /** Most concurrent runs. */
  maxConcurrency?: number;
  /** Whether it is paused. */
  isPaused: boolean;
  /** Whether a run is in flight anywhere. */
  isRunning: boolean;
  /** Who is running it, from the lock. */
  runningOn?: {
    /** The run in flight. */
    runId: string;
    /** Since when, epoch ms. */
    since: number;
    /** The lock holder's host. */
    host?: string;
    /** The lock holder's pid. */
    pid?: number;
  };
  /** Triggers waiting. */
  queuedTriggers: number;
  /** Lifetime counters. */
  stats: RunnerStatsDto;
  /** The most recent run. */
  lastRun?: RunRecordDto;
  /** The most recent error. */
  lastError?: {
    /** Error name. */
    name: string;
    /** Error message. */
    message: string;
  };
  /** When the stored state last changed, epoch ms. */
  updatedAt?: number;
  /** This process's view, when the runner is registered here. */
  local?: {
    /** The local instance's lifecycle ({@link RunnerStatusDto}): not whether a run is in flight, which is `activeRuns`. */
    status: RunnerStatusDto;
    /** Runs in flight in this process. */
    activeRuns: RunRecordDto[];
    /** When this instance's ticker next fires, epoch ms, or `null`. */
    nextRunAt: number | null;
  };
}

/** One runner in {@link RunnerListDto}. */
export interface RunnerListItemDto {
  /** The runner's id. */
  id: string;
  /** Registered in this process; only a local runner can be killed or have its stats reset. Named as {@link RunnerInfoDto.isLocal} is. */
  isLocal: boolean;
  /**
   * The same as {@link RunnerListItemDto.isLocal}.
   *
   * @deprecated Use `isLocal`. On `RunnerInfoDto` a `local` field is a block
   * of this process's view, not a boolean, so the list's boolean `local` read
   * as the same name for a different thing. Still sent; removed in a future
   * major version.
   */
  local: boolean;
  /** Its name; local runners only. */
  name?: string;
  /** Its lifecycle in this process ({@link RunnerStatusDto}); local runners only. */
  status?: RunnerStatusDto;
  /** Whether it is paused, from the backend, so the same from every process. */
  isPaused: boolean;
  /** Whether a run is in flight anywhere, from the backend's lock. */
  isRunning: boolean;
}

/** `GET /runners`. */
export interface RunnerListDto {
  /** Local runners, then the ids of runners only other processes registered. */
  items: RunnerListItemDto[];
}

/** `GET /runners/:runner/history` query. */
export interface HistoryQuery {
  /** Runs returned. Defaults to `min(50, limits.maxHistory)`; at most `limits.maxHistory`. */
  limit?: number;
}

/** `GET /runners/:runner/history`, newest first. */
export interface RunnerHistoryDto {
  /** The runs. */
  items: RunRecordDto[];
}

/** `POST /runners/:runner/trigger` body. */
export interface TriggerRunnerBody {
  /** Run even while paused. */
  force?: boolean;
  /** Run arguments; refused unless `MetaDto.runnerTriggerArgs`. */
  args?: unknown;
}

/** `POST /runners/:runner/trigger`: 202 when started or queued, 200 when skipped. */
export type TriggerOutcomeDto =
  | {
      /** The run started. */
      outcome: "started";
      /** Its id. */
      runId: string;
    }
  | {
      /** The run was queued. */
      outcome: "queued";
      /** Its place in the queue. */
      position: number;
    }
  | {
      /** Nothing ran. */
      outcome: "skipped";
      /** Why. */
      reason:
        | "paused"
        | "busy"
        | "lock-held"
        | "max-concurrency"
        | "queue-full"
        | "stopped";
    };

/** `POST /runners/:runner/pause` and `…/resume`. */
export interface RunnerPausedDto {
  /** Whether the runner is now paused. */
  paused: boolean;
}

/** `POST /runners/:runner/resume` body. */
export interface ResumeRunnerBody {
  /** Also ask for a run straight away. Defaults to `false`. */
  triggerNow?: boolean;
}

/** `POST /runners/:runner/kill` body. */
export interface KillRunnerBody {
  /** One run; every active run when absent. */
  runId?: string;
  /** Skip to the end of the kill escalation. Defaults to `false`. */
  force?: boolean;
  /** Why, recorded on the run. */
  reason?: string;
  /** Answer once the runs have settled (200) instead of at once (202). Defaults to `false`. */
  wait?: boolean;
}

/** `POST /runners/:runner/kill`. */
export interface KillResultDto {
  /** The runs targeted. */
  runIds: string[];
}

/** `PUT /runners/:runner/schedule` body. */
export interface ScheduleRunnerBody {
  /** A cron expression, an interval in ms, `{ cron, tz? }`, `{ every, anchor? }`, `{ at }`, or `null`. */
  schedule:
    | string
    | number
    | {
        /** Cron expression. */
        cron: string;
        /** Time zone. */
        tz?: string;
      }
    | {
        /** Interval, ms. */
        every: number;
        /** Anchor. */
        anchor?: TimeInput;
      }
    | {
        /** One-off time. */
        at: TimeInput;
      }
    | null;
}

/** `PUT /runners/:runner/schedule`. */
export interface ScheduleResultDto {
  /** The schedule now stored. */
  schedule: RunnerScheduleDto;
  /** When it next fires, epoch ms, or `null`. */
  nextRunAt: number | null;
}

/* ------------------------------------------------------------------ *
 * Meta
 * ------------------------------------------------------------------ */

/** What a backend supports. */
export interface DriverCapabilitiesDto {
  /** Whether a worker can block instead of polling. */
  blockingWait: boolean;
  /** How events reach other processes. */
  events: "push" | "poll" | "local";
  /** Whether several processes on one host can share the backend. */
  multiProcess: boolean;
  /** Whether several hosts can share it. */
  multiHost: boolean;
}

/**
 * The caps the routes enforce, as configured. Each is the very value the
 * route reads, so a client can size a page or a bulk selection without
 * hitting a 400.
 */
export interface MetaLimitsDto {
  /** `limit` of a job list when none is given. */
  defaultPageSize: number;
  /** Largest `limit` a job list accepts. */
  maxPageSize: number;
  /** Most ids in a bulk body (`lookup`, bulk retry/remove/promote); more is 400 `BULK_LIMIT`. Also the most children `…/children` lists. */
  maxBulkIds: number;
  /** Most jobs one `retry-all` may move (its largest `limit`). */
  maxRetryAll: number;
  /** Most ids a `retry-all` answers with; when it moved more, `ids` holds the first this many and `truncated` is `true`. Fixed at `1000`. */
  maxRetryAllIds: number;
  /** Largest `limit` for `clean`. */
  maxClean: number;
  /** The `limit` a `clean` uses when none is given: `min(1000, maxClean)`. */
  defaultClean: number;
  /** Largest log page. */
  maxLogPage: number;
  /** Largest runner history page. */
  maxHistory: number;
  /** Largest request body for `jobs.add`/`jobs.update` (and any mutation), in bytes; more is 413. */
  maxJobDataBytes: number;
  /** Most queues `/overview` summarises, and the largest `limit` of `GET /queues`. */
  maxQueues: number;
}

/** The CSRF rules mutations are held to. */
export interface MetaCsrfDto {
  /** A header every mutation must carry (any non-empty value), lower case, or `null` for none. */
  header: string | null;
  /** Whether every `POST` (and any mutation with a body) must be `Content-Type: application/json`, bodiless or not. */
  requireJson: boolean;
}

/** `GET /meta`. */
export interface MetaDto {
  /** The namespace managed. */
  namespace: string;
  /** The effective mode. */
  mode: JobsApiMode;
  /** Whether mutations are disabled. */
  readOnly: boolean;
  /** The API protocol version. */
  protocol: 1;
  /** The backend: its name and capabilities, never connection details. */
  driver: {
    /** The driver's name, e.g. `"redis"`. */
    name: string;
    /** What the backend supports. */
    capabilities: DriverCapabilitiesDto;
  };
  /** Optional features this backend supports, so a UI can explain an absent button. */
  features: {
    /** Job logs. */
    logs: boolean;
    /** Job updates. */
    update: boolean;
    /** Queue limits. */
    limits: boolean;
    /** Flows. */
    flows: boolean;
    /** Name/id search. */
    search: boolean;
    /** Worker listing. */
    workers: boolean;
    /** Throughput metrics. */
    throughput: boolean;
  };
  /** How events reach this process. */
  events: "push" | "poll" | "local";
  /**
   * Whether the context publishes events — its resolved `publishEvents` —
   * or `null` when the API was built without a `BunJobs` to ask.
   */
  publishing: boolean | null;
  /** The socket, or `null` when it is off. */
  websocket: {
    /** Full socket path. */
    path: string;
    /** Heartbeat interval in ms. */
    heartbeatMs: number;
    /** Most subscriptions per connection. */
    maxSubscriptions: number;
    /** The dedicated port (the bound one, when configured as `0`); absent when the socket shares the host's port. */
    port?: number;
  } | null;
  /** Docs endpoints, or `null` when they are off. */
  docs: {
    /** OpenAPI JSON path. */
    openapi: string;
    /** AsyncAPI JSON path, when the socket is on. */
    asyncapi?: string;
    /** Swagger UI path, when the UI is on. */
    ui?: string;
    /** AsyncAPI viewer path, when the UI is on and the socket exists. */
    asyncapiUi?: string;
  } | null;
  /** The CSRF rules mutations are held to; `{ header: null, requireJson: false }` with `csrf: false`. */
  csrf: MetaCsrfDto;
  /** The caps the routes enforce. */
  limits: MetaLimitsDto;
  /**
   * The job names `POST /queues/:queue/jobs` accepts right now, or `null` when
   * it accepts any name (`addableNames: "any"`). `[]` when nothing can be
   * added: the route is not registered (`jobs.add` off, `readOnly`, runner
   * mode), or no name is allowed. With the default (`addableNames` unset) this
   * is the names of `jobs.definitions()` at request time.
   */
  addableNames: string[] | null;
  /** Whether `POST /runners/:runner/trigger` is registered and accepts `args`. */
  runnerTriggerArgs: boolean;
}

/** `GET /meta/permissions` query. */
export interface PermissionsQuery {
  /** Ask queue-side actions about this queue. */
  queue?: string;
  /** Ask runner actions about this runner. */
  runner?: string;
  /** Also preview whether subscribing to this WebSocket channel would be authorized. */
  channel?: string;
}

/** Whether a channel subscription would be authorized, in {@link PermissionsDto}. */
export interface ChannelPermissionDto {
  /** The channel as asked; `key` is its canonical form. */
  channel: string;
  /**
   * The canonical channel name (the job id re-encoded), whenever the name
   * parsed — including when it was refused afterwards (`CHANNEL_NOT_AVAILABLE`,
   * `QUEUE_NOT_FOUND`, `RUNNER_NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`).
   * Absent only for `INVALID_CHANNEL`.
   */
  key?: string;
  /** Whether a `subscribe` to it would be accepted. */
  allowed: boolean;
  /**
   * Why not, when refused: the code a `subscribe` ack would reject it with
   * (`INVALID_CHANNEL`, `CHANNEL_NOT_AVAILABLE`, `QUEUE_NOT_FOUND`,
   * `RUNNER_NOT_FOUND`, `UNAUTHORIZED` or `FORBIDDEN`).
   */
  code?: string;
  /** The HTTP-equivalent status of the refusal. */
  status?: number;
  /** A safe, human reason for the refusal. */
  detail?: string;
}

/** `GET /meta/permissions`. */
export interface PermissionsDto {
  /**
   * For every action the API routes (plus the socket's two, when it has one),
   * whether the caller may perform it. Keyed by action: an action whose routes
   * are pruned — by `mode`, `readOnly`, `actions` or the driver — is absent,
   * not `false`, so read it as `actions[action] === true`.
   */
  actions: Partial<Record<JobsApiAction, boolean>>;
  /** The channel preview, when `channel` was asked. */
  channel?: ChannelPermissionDto;
}

/* ------------------------------------------------------------------ *
 * The API object
 * ------------------------------------------------------------------ */

/**
 * What a created API reports about itself (`api.info`): the resolved values,
 * the same ones `/meta` reports, available without a request.
 */
export interface JobsApiInfo {
  /** The normalised `basePath`, no trailing slash. */
  readonly basePath: string;
  /** The namespace managed. */
  readonly namespace: string;
  /** The effective mode. */
  readonly mode: JobsApiMode;
  /** Whether mutations are disabled. */
  readonly readOnly: boolean;
  /** The CSRF rules mutations are held to. */
  readonly csrf: Readonly<MetaCsrfDto>;
  /** The registered docs documents' full paths, or `null` when none is routed. */
  readonly docs: {
    /** OpenAPI JSON path. */
    readonly openapi: string;
    /** AsyncAPI JSON path, when the socket and docs are both on. */
    readonly asyncapi?: string;
  } | null;
  /** The socket, or `null` when there is none. */
  readonly websocket: {
    /** Full path, `basePath + websocket.path`. */
    readonly path: string;
    /** The dedicated port (the bound one, when configured as `0`); absent on the host's port. */
    readonly port?: number;
  } | null;
}
