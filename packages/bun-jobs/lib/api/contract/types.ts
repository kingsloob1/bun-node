import type {
  AnalyticsResolution,
  EXECUTION_MODES,
  JobDefaultBackoffType,
  JobDefaultKey,
  JobDefaultsApplyState,
  JobInclude,
  JobListSort,
  JobsApiAction,
  JobsApiMode,
  JobState,
  RunLogLevel,
  RunLogStream,
  RunnerConfigKey,
  WorkerConfigKey,
  WorkerControlAction,
  WorkerControlMode,
  WorkerDesiredState,
  WorkerState,
  WorkerStopPersistence,
  WorkerTargetKind,
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

/**
 * What a job or a run reports as its progress: a percentage, or a record of
 * whatever the work wants to say. The same type as the package's own
 * `RunProgress`, restated here so the contract imports nothing from the
 * server; `__tests__/api/api-contract.type-test.ts` asserts the two are equal.
 */
export type RunProgress = number | Record<string, unknown>;

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
  /**
   * The options this job's own `add()` passed explicitly, which stored queue
   * defaults never replace, in `JOB_DEFAULT_KEYS` order. Absent on a job added
   * before bun-jobs recorded it — nothing can say which of its options were
   * explicit, so the apply action skips it unless told otherwise.
   */
  explicit?: JobDefaultKey[];
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

/**
 * The worker that ran a job's **last** attempt — {@link JobDto.processedBy}.
 *
 * Recorded when that attempt was claimed, in the claim's own write, and
 * **kept after the job settles**: a completed, failed or dead job keeps naming
 * the worker that ran it for exactly as long as the job itself is retained,
 * and goes when the job does. Nothing else stores it.
 *
 * **Last attempt only.** A job that failed on one worker and completed on
 * another names only the second; earlier attempts are not recorded here, so
 * a `workerKey` or `workerId` filter naming the first worker does not list
 * it. A stalled job keeps the dead worker's stamp until its next claim
 * overwrites it — "last touched by the worker that died".
 */
export interface JobWorkerDto {
  /**
   * The incarnation's id — `WorkerDto.id` of the process that claimed the
   * attempt. Lifecycle control addresses this, but only while that process
   * lives: a restart gives the worker a new id, so on a finished job this
   * usually names a worker that is gone.
   */
  id: string;
  /**
   * The stable key — `WorkerDto.key`, the identity a config override is
   * keyed by, surviving restarts and shared by every replica. A worker page
   * is addressed by this and the job's queue (a key is unique within its
   * queue only); its live instances are `GET /queues/{queue}/workers?key=`,
   * which needs `workers.list`. Absent when the attempt was claimed by a
   * worker or driver that recorded only the id.
   */
  key?: string;
  /**
   * The host it ran on; omitted with `serialize.exposeHosts: false`, and when
   * not recorded. The same rule as `WorkerDto.host`: it is stored with the job
   * either way, and the setting decides only whether it is shown.
   */
  host?: string;
  /** Its pid; omitted with `serialize.exposeHosts: false`, and when not recorded. The same rule as `WorkerDto.pid`. */
  pid?: number;
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
  /**
   * When it completed or died, epoch ms. **Set only in the two final states,
   * `completed` and `dead`**, and `null` in every other: `waiting`, `delayed`,
   * `active`, `waiting-children`, and **`failed`**, which is a job that failed
   * an attempt and is waiting for its retry. A job that exhausts its attempts
   * goes to `dead`, not `failed`, and gets its `finishedOn` there. So only
   * `completed` and `dead` jobs can match `finishedFrom`/`finishedTo`. A job
   * retried or promoted out of a final state loses it again.
   */
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
   * Id of the worker holding the job while it is active — set only while
   * `state` is `"active"`, and `null` again once the attempt settles or
   * stalls. Not who ran a finished job: that is {@link JobDto.processedBy},
   * which is kept.
   */
  workerId: string | null;
  /**
   * The worker that ran the job's **last** attempt, recorded when it was
   * claimed and kept after the job settles, for exactly as long as the job is
   * retained. `host` and `pid` follow `serialize.exposeHosts`, as on
   * `WorkerDto`.
   *
   * Only the last attempt: a job that failed on one worker and completed on
   * another shows only the second. A stalled job keeps the dead worker's
   * stamp until its next claim. `null` for a job never claimed, one last
   * claimed before attribution was recorded, and on a backend that does not
   * record it (`MetaDto.features.jobAttribution` is `false`). See
   * {@link JobWorkerDto}.
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
  opts?: JobOptionsDto;
}

/** `GET /queues/:queue/jobs`. */
export type JobPageDto = PageDto<JobDto>;

/** `GET /queues/:queue/jobs` query. */
export interface JobListQuery {
  /** States to list; every state when absent. */
  state?: JobState[];
  /**
   * The previous page's `page.next`, to continue the walk at the job after the
   * last one you were shown.
   *
   * **Opaque — never build or parse one**: it holds the backend's ordering
   * key, and the backends do not agree on it. One this route did not issue, or
   * one belonging to another queue, other states, the other sort or the other
   * order, is 400 `INVALID_ARGUMENT`, never a silent restart at page one.
   * Takes precedence over `offset`. Unlike an offset it cannot jump to page N
   * — it walks — and unlike an offset nothing shifts under it when a job
   * leaves the list ahead of it. Refused for `state: ["active"]` in the
   * natural order, whose key every lock renewal rewrites.
   */
  cursor?: string;
  /** Jobs skipped; how a client jumps to page N. Ignored with `cursor`. Defaults to `0`. */
  offset?: number;
  /** Page size. Defaults to `limits.defaultPageSize`; at most `limits.maxPageSize`. */
  limit?: number;
  /**
   * `"asc"` is the order `sort` names, `"desc"` its reverse — so newest first
   * is `order=desc`, with either sort. Defaults to `"asc"`.
   */
  order?: SortOrder;
  /**
   * What the page is ordered by, one of `JOB_LIST_SORTS`. Defaults to
   * `"natural"`, the order this list has always used, so a client that sends
   * no `sort` sees no change:
   *
   * - one state: `waiting` by priority then `createdAt` (claim order),
   *   `delayed` and `failed` by `runAt`, `active` by lock expiry
   *   (`lockExpiresAt`), `completed` and `dead` by `finishedOn`,
   *   `waiting-children` by `createdAt`;
   * - several states, or none named (every state): by `createdAt`.
   *
   * `"createdAt"` orders by `createdAt` whatever the states, ties in one
   * millisecond by `id`, so "newest first" means the same on every tab. It is
   * served only where `MetaDto.features.addedByState` is `true` (the memory,
   * SQL and MongoDB drivers); elsewhere it is 400 `INVALID_ARGUMENT`, with a
   * detail saying why, rather than a page silently in the natural order. (Not
   * a 5xx: the API sends no detail on one, and this is the same refusal a
   * worker filter gets where `features.jobAttribution` is `false`.)
   * `"natural"` is accepted everywhere.
   *
   * **Keep pages modest on SQL and MongoDB.** Their claim index is ordered
   * `(state, priority, createdAt)`, so it cannot hand back one state already
   * ordered by `createdAt`: a page of a large single state (`completed`,
   * `dead`) sorted this way is a top-N sort over every job of that state, not
   * an index walk. Several states cost what they cost today, since that view
   * is already ordered by `createdAt`.
   */
  sort?: JobListSort;
  /** Optional fields to include. */
  include?: JobInclude[];
  /** Only jobs with one of these names, exactly. */
  name?: string[];
  /** Only jobs whose id or name contains this, ignoring case. */
  search?: string;
  /**
   * Only jobs whose **last** attempt was run by a worker with one of these
   * stable keys (`processedBy.key`), exactly. Repeat the key for several
   * (a single value is also split at commas, as on every list filter); at
   * most `MAX_JOB_FILTER_VALUES`. A job never claimed, or last claimed before
   * attribution was recorded, never matches, and neither does one whose
   * earlier attempt this key ran but whose last attempt another worker did.
   *
   * ANDed with every other filter. On a large queue, pair it with
   * `finishedFrom`/`finishedTo`: the key is matched within the states and
   * range asked for, not through an index of its own.
   */
  workerKey?: string[];
  /**
   * Only jobs whose **last** attempt was run by one of these incarnations
   * (`processedBy.id`), exactly. Repeatable like `workerKey`, at most
   * `MAX_JOB_FILTER_VALUES`. An incarnation's id changes when its process
   * restarts, so a worker page lists by `workerKey`, and this narrows to one
   * process.
   */
  workerId?: string[];
  /**
   * Only jobs that finished at or after this instant — over `finishedOn`,
   * **inclusive**, epoch ms or an RFC 3339 date-time. The same convention as
   * {@link AnalyticsRangeQuery.from}.
   *
   * A job with no `finishedOn` — waiting, delayed, active, waiting on
   * children, or failed with a retry pending — **never matches a range**,
   * from either end. So a worker page lists a key's running jobs with
   * `state=active` and no range, and its finished ones with `state=completed`
   * (or `dead`) and one.
   */
  finishedFrom?: TimeInput;
  /**
   * Only jobs that finished before this instant — over `finishedOn`,
   * **exclusive**, like {@link AnalyticsRangeQuery.to}. A `finishedTo` not
   * after `finishedFrom` is 400 `INVALID_ARGUMENT`. A job with no
   * `finishedOn` never matches, as for `finishedFrom`.
   */
  finishedTo?: TimeInput;
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

/**
 * `DELETE /queues/:queue/jobs/:id/logs` — operation `clearJobLogs`, action
 * `jobs.clearLogs`: a mutation, so `readOnly` removes it, and on by default,
 * as `jobs.remove` is.
 *
 * Empties the job's log for good. Afterwards the log reads as one never
 * written: `GET …/logs` counts `0`, the next line the job logs is its first,
 * and `keepLogs` trims from there. The job itself, its state, and every
 * counter, throughput figure and analytics series are untouched.
 *
 * **Refused while the job is active** — 409 `JOB_ACTIVE`, the same rule and
 * code as `DELETE /queues/:queue/jobs/:id`: a worker is still writing the log,
 * and clearing it would leave one that looks whole while missing its start.
 * The backend checks the state in the same step as the removal, so a job
 * claimed while the request was in flight is refused too, never half-cleared.
 *
 * Other errors: 400 `INVALID_NAME`, 404 `QUEUE_NOT_FOUND`, 404
 * `JOB_NOT_FOUND`. A backend that cannot clear a job's log has the route
 * pruned — `jobs.clearLogs` is then absent from `GET /meta/permissions` —
 * rather than answering 501.
 */
export interface ClearJobLogsResultDto {
  /**
   * How many lines were removed: what the log held a moment before, so `0`
   * for a job that had logged nothing. A success either way.
   */
  removed: number;
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
  /**
   * Why the job is failed; becomes its `failedReason` message exactly as sent.
   * It must contain a character other than whitespace, or the request is 400
   * `VALIDATION`.
   */
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
  /**
   * Attempts failed in that minute — the attempts that failed, retries included, and those whose retry later
   * succeeded: not the jobs in the `failed` state (waiting to retry) nor the
   * `dead` ones (gave up).
   */
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
  /** Attempts failed across every bucket, counted as each bucket's `failed` is. */
  failed: number;
}

/**
 * `GET /overview` and `GET /queues/:queue/throughput` query: the deprecated
 * `minutes`, or the analytics range, which wins when `from` or `to` is given.
 * `/queues/:queue/throughput` still answers a minute per bucket whatever
 * `resolution` hints.
 */
export interface MinutesQuery extends AnalyticsRangeQuery {
  /**
   * Minutes back from the current one. Defaults to `60`; at most `1440`.
   *
   * @deprecated Superseded by {@link AnalyticsRangeQuery}'s `from`/`to`/
   * `resolution`, which say what they cover instead of counting backwards from
   * an implicit now, and can be served at a second's resolution. It stays on
   * these two routes for the clients already sending it, and appears on no new
   * one.
   */
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
    /**
     * Attempts failed — every failed attempt, retries included, not the jobs
     * now in the `failed` or `dead` state.
     */
    failed: number;
  };
  /**
   * The same, per minute: each minute summed over the queues summarised, in
   * the shape of `GET /queues/:queue/throughput`. Present exactly when
   * `throughput` is.
   */
  throughputSeries?: QueueThroughputDto;
  /**
   * The namespace's analytics over the range the request asked for (the last
   * hour by default), read from the roll-up buckets rather than per queue —
   * one read whatever the queue count. Absent when the backend records no
   * analytics at all (`MetaDto.analytics` is `null`).
   *
   * `range` and `jobs` always. The runner and worker sections only on a
   * backend with the grouped reads (`getRunnerMetricsTotals` and the other
   * three), where each costs a fixed number of reads whatever the fleet;
   * without them each row would cost a read per runner and per worker key on
   * every overview poll, so they are served by `GET /analytics/runners` and
   * `GET /analytics/workers` alone.
   */
  analytics?: OverviewAnalyticsDto;
}

/* ------------------------------------------------------------------ *
 * Jobs added over a range, by current state
 * ------------------------------------------------------------------ */

/**
 * `GET /overview/added` (operation `getAddedByState`, action `metrics.read`,
 * summed over every queue the caller may see) and
 * `GET /queues/{queue}/counts/added` (operation `getQueueAddedByState`, action
 * `queues.read`, one queue) query: the jobs whose `createdAt` is in
 * `[from, to)`.
 *
 * The analytics routes' range rules without their buckets: `from`
 * **inclusive**, `to` **exclusive** (as in {@link AnalyticsRangeQuery}), `to`
 * defaults to now and `from` to an hour before `to`. A `to` not after `from`,
 * or a span over `MAX_ADDED_BY_STATE_SPAN_MS` (a day) or under
 * `MIN_ANALYTICS_SPAN_MS`, is 400 `INVALID_ARGUMENT`. There is no resolution
 * and no retention clamp: the counts come from the jobs themselves, not from
 * the analytics roll-up.
 *
 * Both routes exist only where `MetaDto.features.addedByState` is `true`.
 * Each read counts job records, not a roll-up, so **poll it every 15–30 s,
 * not at the overview's 5 s**.
 */
export interface AddedByStateQuery {
  /** Start, **inclusive**: epoch ms or an ISO 8601 date-time. Defaults to `to − 1 hour`. */
  from?: TimeInput;
  /** End, **exclusive**: epoch ms or an ISO 8601 date-time. Defaults to now. */
  to?: TimeInput;
}

/**
 * `GET /overview/added` and `GET /queues/{queue}/counts/added`: of the jobs
 * **added** during a range, how many are in each state **now**.
 *
 * What the numbers mean, precisely — a card showing them should say so:
 *
 * - **Added in the range and still stored.** `counts` sums to `total`, the
 *   jobs added in the range *that are still stored*, not every job added. A
 *   job removed since — by `removeOnComplete`/`removeOnFail` retention, or by
 *   a remove, clean or drain — is not counted anywhere. So for a queue that
 *   removes finished jobs (or caps how many it keeps), `completed` and `dead`
 *   undercount, and `total` is less than what was added.
 * - **Bucketed by creation time.** They do not match the analytics series
 *   (`GET /analytics/jobs`, `/overview`'s `analytics.jobs`), which counts
 *   completions and failed attempts when they happen — by **finish** time,
 *   over every job whenever it was added, retention or not. A job added
 *   yesterday and completed in the range is in the series and not here; one
 *   added in the range and still waiting is here and not there. Show the two
 *   apart, never as one figure.
 * - **Scheduled runs count as added.** A repeatable's next instance is created
 *   ahead of its run time, so its future runs appear here as added and
 *   `delayed`.
 * - **`createdAt` is the producer's clock**: the host that added the job
 *   stamped it, so clock skew between hosts moves a job across the range's
 *   edges.
 * - **The states.** `failed` is the *state* — failed and waiting to retry —
 *   not failed attempts; `dead` is the jobs that gave up. `active` and
 *   `waiting` change from one read to the next.
 */
export interface AddedByStateDto {
  /** Start of the range read, **inclusive**, epoch ms. */
  from: number;
  /** End of the range read, **exclusive**, epoch ms. */
  to: number;
  /** When the counts were read, epoch ms: the "now" every state is as of. */
  at: number;
  /** How many of the jobs added in the range, and still stored, are in each state now. */
  counts: JobCountsDto;
  /** The sum of `counts`: jobs added in the range and still stored. */
  total: number;
  /**
   * Queues summed. On `GET /overview/added`, every queue the caller may see
   * (`listQueues`, the `queues` allowlist); `1` on the per-queue route.
   */
  queues: number;
}

/* ------------------------------------------------------------------ *
 * Analytics and time ranges
 * ------------------------------------------------------------------ */

/**
 * The range every analytics route is read over, superseding
 * {@link MinutesQuery}.
 *
 * **`to` is exclusive**, and the response's `to` is *not* the same instant —
 * it is the start of the last bucket, with `end` the exclusive end. Read
 * {@link AnalyticsRangeDto} before writing an axis; the design calls this the
 * single easiest thing here to get wrong.
 */
export interface AnalyticsRangeQuery {
  /** Start of the range, **inclusive**. Defaults to `to − 1 hour`. */
  from?: TimeInput;
  /**
   * End of the range, **exclusive** — a bucket starting exactly here is not
   * in the response. Defaults to now.
   */
  to?: TimeInput;
  /**
   * The finest bucket width wanted, in seconds; one of
   * `ANALYTICS_RESOLUTIONS`, anything else 400 `VALIDATION`. (A `to` not
   * after `from`, or a span outside `MIN_ANALYTICS_SPAN_MS` …
   * `MAX_ANALYTICS_SPAN_MS`, is 400 `INVALID_ARGUMENT`.)
   *
   * **A hint and an upper bound on fineness, never a demand.** The server
   * serves the finest resolution it can keep for the *whole* span within
   * `MAX_ANALYTICS_BUCKETS`, which may be coarser than this; it is never
   * finer. What was actually served is {@link AnalyticsRangeDto.resolution},
   * and that — not this — is what an axis is labelled from.
   */
  resolution?: AnalyticsResolution;
}

/**
 * Why a response does not cover exactly what was asked for.
 *
 * - `retention`: `from` is older than the backend keeps at the resolution
 *   implied, so the range moved forward or the resolution coarsened — the
 *   10-minute preset against a 5-minute per-second retention is this;
 * - `maxBuckets`: the span at the resolution asked for would exceed
 *   `MAX_ANALYTICS_BUCKETS`, so a coarser one was served;
 * - `resolution`: the resolution asked for is not one this backend serves;
 * - `driver`: the backend cannot serve that fineness at all (the file driver
 *   records minutes only).
 */
export type AnalyticsClampReason =
  | "retention"
  | "maxBuckets"
  | "resolution"
  | "driver";

/** What the request asked for, echoed in {@link AnalyticsRangeDto}. */
export interface AnalyticsRangeRequestedDto {
  /** `from` as asked, or the default, epoch ms, **inclusive**. */
  from: number;
  /** `to` as asked, or the default (now), epoch ms, **exclusive**. */
  to: number;
  /**
   * The `resolution` asked for, in seconds; absent when the request named
   * none — so a client can say "you asked for 1 s and got 60 s" only when it
   * really did ask.
   */
  resolution?: AnalyticsResolution;
}

/**
 * What one series actually covers.
 *
 * **The three instants are not interchangeable**, and this is where a chart
 * usually goes wrong:
 *
 * - `from` is the start of the **first** bucket;
 * - `to` is the start of the **last** bucket — inclusive, the same meaning
 *   `QueueThroughputDto.to` has shipped with, and *not* the request's
 *   exclusive `to`;
 * - `end` is `to + interval`, the exclusive end of the covered time.
 *
 * So an axis runs `from … end`, and the last bucket is plotted at `to`.
 *
 * **One resolution per response.** A span that straddles the per-second
 * retention window is served entirely at 60 s rather than at mixed widths,
 * which cannot be plotted honestly; `clamped` and `reason` say so.
 */
export interface AnalyticsRangeDto {
  /** The bucket width served, in seconds. Label the axis from this, never from what was asked. */
  resolution: AnalyticsResolution;
  /** The same width in milliseconds — the name `QueueThroughputDto` already uses. */
  interval: number;
  /** Start of the first bucket, epoch ms. */
  from: number;
  /** Start of the **last** bucket, epoch ms, inclusive. */
  to: number;
  /** `to + interval`: the exclusive end of what the series covers, epoch ms. */
  end: number;
  /** What the request asked for, before any clamping. */
  requested: AnalyticsRangeRequestedDto;
  /** Whether the served range or resolution differs from what was asked. */
  clamped: boolean;
  /** Why, when `clamped`; absent when it is not. */
  reason?: AnalyticsClampReason;
}

/**
 * One series: the range it covers, its buckets oldest first, and its totals
 * over the whole range.
 *
 * Buckets are **contiguous** — an interval nothing happened in is present with
 * zeros, so a chart needs no gap-filling — and `totals` is the sum over them,
 * given separately so a caller need not add them up.
 */
export interface AnalyticsSeriesDto<TBucket, TTotals> {
  /** What this series covers, and at what resolution. */
  range: AnalyticsRangeDto;
  /** One bucket per interval, oldest first, contiguous. */
  buckets: TBucket[];
  /** The buckets summed. */
  totals: TTotals;
}

/** One interval of job throughput. */
export interface JobsBucketDto {
  /** The start of the bucket, epoch ms. */
  at: number;
  /** Jobs completed in it. */
  completed: number;
  /**
   * Attempts failed in it — the attempts that failed, retries included, and those whose retry later
   * succeeded: not the jobs in the `failed` state (waiting to retry) nor the
   * `dead` ones (gave up).
   */
  failed: number;
}

/** Job throughput over a whole range. */
export interface JobsTotalsDto {
  /** Jobs completed. */
  completed: number;
  /** Attempts failed, counted as each bucket's `failed` is: attempts, not jobs. */
  failed: number;
}

/** One interval of runner runs, counted by how they ended. */
export interface RunnerRunsBucketDto {
  /** The start of the bucket, epoch ms. */
  at: number;
  /** Runs that **started** in it. */
  started: number;
  /** Runs that finished in it successfully. */
  succeeded: number;
  /** Runs that finished in it by throwing. */
  failed: number;
  /** Runs that finished in it by exceeding their timeout. */
  timeout: number;
  /** Runs that finished in it because they were killed. */
  killed: number;
  /** Runs that were skipped in it — an overlap the run mode refused. */
  skipped: number;
}

/**
 * Runner outcomes over a whole range.
 *
 * **`started` does not balance the rest**: a run that starts near the end of
 * the range finishes outside it, and a run that started before it finishes
 * inside. A client deriving in-flight counts as
 * `started − succeeded − failed − timeout − killed` must label the figure as
 * derived; it drifts across a range boundary. The honest instantaneous number
 * is the `runningNow` scalar.
 */
export interface RunnerRunsTotalsDto {
  /** Runs started. */
  started: number;
  /** Runs that succeeded. */
  succeeded: number;
  /** Runs that threw. */
  failed: number;
  /** Runs that timed out. */
  timeout: number;
  /** Runs that were killed. */
  killed: number;
  /** Runs that were skipped. */
  skipped: number;
}

/**
 * One interval of run durations. A run counts in the bucket it **finished**
 * in, not the one it started in — a five-minute run appears once, at its end.
 *
 * **`minMs` and `maxMs` are exact; the quantiles are not.** They are read off
 * a fixed 24-bin log histogram (`DURATION_HISTOGRAM_BOUNDS`, ratio 2) by
 * interpolating inside the bin a quantile falls in, so each is **always within
 * a factor of 2 of the truth and typically within 20–30%**. That is the price
 * of a summary that merges across writers and buckets without storing a single
 * duration; show a quantile as approximate, and use `minMs`/`maxMs` when an
 * exact figure matters.
 */
export interface RunnerDurationBucketDto {
  /** The start of the bucket, epoch ms. */
  at: number;
  /** Runs that finished in it. `0` means the other fields are meaningless. */
  count: number;
  /** The shortest of them, ms. Exact. */
  minMs: number;
  /** The longest of them, ms. Exact. */
  maxMs: number;
  /** Their mean, ms. Exact — it is a sum over a count, not a histogram read. */
  meanMs: number;
  /** Their approximate median, ms; absent when the backend keeps no histogram. */
  p50Ms?: number;
  /** Their approximate 95th percentile, ms; absent when the backend keeps no histogram. */
  p95Ms?: number;
  /**
   * The raw histogram: one count more than `DURATION_HISTOGRAM_BOUNDS` has
   * edges. Index `0` is `[0, bounds[0])`, index `i` is
   * `[bounds[i − 1], bounds[i])`, and the last is the overflow, everything at
   * or above the final edge. Absent when the backend keeps none — then the
   * quantiles are absent too. Present, it can be re-bucketed or merged with
   * another range's by adding element-wise.
   */
  histogram?: number[];
}

/**
 * Run durations over a whole range. The same caveat as
 * {@link RunnerDurationBucketDto}: `minMs`/`maxMs`/`meanMs` exact, the
 * quantiles within a factor of 2 and typically within 20–30%.
 */
export interface RunnerDurationTotalsDto {
  /** Runs that finished in the range. */
  count: number;
  /** The shortest, ms. Exact. */
  minMs: number;
  /** The longest, ms. Exact. */
  maxMs: number;
  /** The mean, ms. Exact. */
  meanMs: number;
  /** The approximate median, ms; absent when the backend keeps no histogram. */
  p50Ms?: number;
  /** The approximate 95th percentile, ms; absent when the backend keeps no histogram. */
  p95Ms?: number;
}

/**
 * One interval of one worker's throughput.
 *
 * Counted by the worker itself, in memory, and written once an interval — the
 * driver knows the lock token, not the worker, so attributing a completion
 * inside the queue's hot path is not something this feature is willing to buy.
 */
export interface WorkerJobsBucketDto {
  /** The start of the bucket, epoch ms. */
  at: number;
  /** Jobs this worker completed in it. */
  completed: number;
  /** Attempts this worker failed in it: attempts, retries included, not jobs in a state. */
  failed: number;
}

/** One worker's throughput over a whole range. */
export interface WorkerJobsTotalsDto {
  /** Jobs completed. */
  completed: number;
  /** Attempts failed. */
  failed: number;
}

/**
 * One interval of how busy a worker was.
 *
 * **Sampled on the heartbeat, not counted.** The worker's `reportInterval`
 * (10 s by default, and `MetaDto.analytics.busynessIntervalMs` reports it) is
 * the only moment this is observed, so a busyness series carries **its own
 * resolution** — coarser than the throughput series beside it, and its
 * `range` says which. There is deliberately no second timer: an idle worker
 * would then write once a second forever, which is the one cost here not
 * bounded by activity.
 */
export interface WorkerBusynessBucketDto {
  /** The start of the bucket, epoch ms. */
  at: number;
  /** Heartbeats that landed in it. **`0` means the worker was not reporting** — not that it was idle. */
  samples: number;
  /** Mean jobs in flight across those samples; `0` when there were none. */
  activeMean: number;
  /** The most jobs in flight any of them saw; `0` when there were none. */
  activeMax: number;
  /** The concurrency it was running with, as of the last sample; `0` when there were none. */
  concurrency: number;
}

/** One worker's busyness over a whole range; the same sampling caveat as {@link WorkerBusynessBucketDto}. */
export interface WorkerBusynessTotalsDto {
  /** Heartbeats in the range. `0` means the worker was not reporting. */
  samples: number;
  /** Mean jobs in flight across them. */
  activeMean: number;
  /** The most jobs in flight any of them saw. */
  activeMax: number;
  /** The concurrency of the last sample. */
  concurrency: number;
}

/**
 * One runner's numbers over the range, with no series of its own: what an
 * overview table's row shows. A sparkline for a row is fetched from the batch
 * endpoint, for the visible page only.
 */
export interface RunnerAnalyticsRowDto {
  /** The runner's id. */
  runner: string;
  /** Its outcomes over the range. */
  totals: RunnerRunsTotalsDto;
  /**
   * Runs in flight **right now**, read from the locks — an instant, not a
   * figure about the range, and the only honest answer to "is it running":
   * being in flight is state, and a bucket counts events.
   */
  runningNow: number;
  /** Its durations over the range; absent when the backend records none, or nothing finished. */
  durations?: RunnerDurationTotalsDto;
}

/**
 * One worker's numbers over the range, with no series of its own.
 *
 * **Keyed by `key`, the stable identity, never the per-incarnation `id`**: a
 * rolling redeploy would otherwise end one row and start another, shredding
 * the chart. The Workers table lists incarnations; group them by this to chart
 * them.
 */
export interface WorkerAnalyticsRowDto {
  /** The worker's stable key — what config is stored against, and what the series is keyed by. */
  key: string;
  /** The queue it consumes. */
  queue: string;
  /** Its throughput over the range. */
  totals: WorkerJobsTotalsDto;
  /** How busy it was; absent when the backend records no busyness. */
  busyness?: WorkerBusynessTotalsDto;
}

/** The Overview's runner section: one summed series, plus a row per runner. */
export interface OverviewRunnersAnalyticsDto {
  /** Every runner's outcomes, summed — one read, whatever the runner count. */
  series: AnalyticsSeriesDto<RunnerRunsBucketDto, RunnerRunsTotalsDto>;
  /** Runs in flight right now, across every runner. */
  runningNow: number;
  /**
   * A row per runner, at most `MAX_ANALYTICS_ROWS`, sorted by started runs
   * descending then by id.
   */
  rows: RunnerAnalyticsRowDto[];
  /** Whether more runners have numbers in this range than `rows` holds. */
  truncated: boolean;
  /**
   * How many runners matched **before** the `MAX_ANALYTICS_ROWS` cap — the
   * "214" in "showing the 100 busiest of 214". Equal to `rows.length` when
   * `truncated` is `false`, so a caption can be written from this alone.
   *
   * It costs nothing: the row set is the runners the namespace already listed
   * in memory, so this is that list's length, not a second read.
   */
  totalRows: number;
}

/** The Overview's worker section: one summed series, plus a row per worker key. */
export interface OverviewWorkersAnalyticsDto {
  /** Every worker's throughput, summed — one read, whatever the worker count. */
  series: AnalyticsSeriesDto<WorkerJobsBucketDto, WorkerJobsTotalsDto>;
  /**
   * A row per worker key, at most `MAX_ANALYTICS_ROWS`, sorted by `completed`
   * descending then by key.
   */
  rows: WorkerAnalyticsRowDto[];
  /** Whether more worker keys have numbers in this range than `rows` holds. */
  truncated: boolean;
  /**
   * How many worker keys matched **before** the `MAX_ANALYTICS_ROWS` cap — the
   * "214" in "showing the 100 busiest of 214". Equal to `rows.length` when
   * `truncated` is `false`, so a caption can be written from this alone.
   *
   * It costs nothing: the row set is the live worker records the route
   * already listed in full (the same read `GET /workers` makes) — joined, on a
   * backend with grouped reads, with the keys no longer live that still have
   * counts in range — so this is that set's size, not a second read.
   */
  totalRows: number;
}

/**
 * `GET /overview`'s `analytics` block: the namespace at a glance over one
 * range, from the roll-up buckets.
 *
 * Every series here shares one {@link AnalyticsRangeDto} — they are read over
 * the same request — except that a busyness series, sampled on the heartbeat,
 * carries its own; there is none at this level, only in the per-worker detail.
 */
export interface OverviewAnalyticsDto {
  /** The range the whole block covers. Each series repeats it; this is the one to caption from. */
  range: AnalyticsRangeDto;
  /** Jobs across every queue in the namespace. */
  jobs: AnalyticsSeriesDto<JobsBucketDto, JobsTotalsDto>;
  /**
   * Runners — what `GET /analytics/runners` answers, without a batch. Absent
   * when the API reaches no runners, the backend records no runner metrics,
   * or it lacks the grouped reads (`getRunnerMetricsTotals` and the other
   * three), without which each row would cost a read on every poll.
   */
  runners?: OverviewRunnersAnalyticsDto;
  /**
   * Workers — what `GET /analytics/workers` answers, without a batch. Absent
   * when the backend lists or counts no workers, or lacks the grouped reads.
   */
  workers?: OverviewWorkersAnalyticsDto;
}

/**
 * One runner's own series, as the `ids=` batch of
 * {@link RunnersAnalyticsDto} returns it.
 *
 * The sparkline, and nothing more: durations are on the detail route
 * (`GET /runners/{runner}/analytics`), because the batch exists to fill in the
 * series for the rows *on screen* at the cost of one request.
 */
export interface RunnerAnalyticsSeriesDto {
  /** The runner's id, as it was named in `ids=`. */
  runner: string;
  /** Its runs by outcome over the range. */
  runs: AnalyticsSeriesDto<RunnerRunsBucketDto, RunnerRunsTotalsDto>;
}

/** `GET /analytics/runners` query: the range, and the batch. */
export interface RunnersAnalyticsQuery extends AnalyticsRangeQuery {
  /**
   * Runners whose own series to return in `seriesByRunner` — the page on
   * screen. At most `MAX_ANALYTICS_SERIES`; more is 400 `BULK_LIMIT`. An id
   * the API cannot reach is left out of the answer rather than failing it.
   */
  ids?: string[];
}

/**
 * `GET /analytics/runners`: the runners roll-up (the
 * {@link OverviewRunnersAnalyticsDto} shape) plus, when the request named
 * `ids=`, one series per runner named.
 *
 * **The 200-worker rule applies to runners too**, at the request level: a
 * section is this request plus one batch for the page on screen, at most
 * `MAX_ANALYTICS_SERIES` ids, beyond which the request is 400 `BULK_LIMIT`
 * rather than silently truncated — truncation is for a listing, a 400 is for
 * an explicit over-ask. `series` is the namespace roll-up, one backend read;
 * each row costs a read of its runner's series and of its lock, and the batch
 * is answered from those same reads, adding none.
 */
export interface RunnersAnalyticsDto extends OverviewRunnersAnalyticsDto {
  /**
   * One series per runner named in `ids=`, in the order asked for; absent when
   * the request named none. A reachable runner with no runs in the range still
   * gets an entry, with zeroed buckets; an id the API cannot reach gets none.
   */
  seriesByRunner?: RunnerAnalyticsSeriesDto[];
}

/**
 * One worker key's own series, as the `keys=` batch of
 * {@link WorkersAnalyticsDto} returns it.
 *
 * Throughput only; busyness is on the detail route
 * (`GET /queues/{queue}/analytics/workers/{key}`), where it can carry its own
 * range.
 */
export interface WorkerAnalyticsSeriesDto {
  /**
   * The worker's stable key, as it was named in `keys=` — never the
   * per-incarnation id, which a rolling redeploy changes.
   */
  key: string;
  /**
   * The queue it consumes. Carried because a key is only unique within its
   * queue, and because the detail route is addressed by the pair.
   */
  queue: string;
  /** Its throughput over the range. */
  jobs: AnalyticsSeriesDto<WorkerJobsBucketDto, WorkerJobsTotalsDto>;
}

/** `GET /analytics/workers` query: the range, and the batch. */
export interface WorkersAnalyticsQuery extends AnalyticsRangeQuery {
  /**
   * Stable worker keys whose own series to return in `seriesByKey` — the page
   * on screen. At most `MAX_ANALYTICS_SERIES`; more is 400 `BULK_LIMIT`. A key
   * matches every queue the listing has it on; one no listed worker carries
   * is left out.
   */
  keys?: string[];
}

/**
 * `GET /analytics/workers`: the workers roll-up (the
 * {@link OverviewWorkersAnalyticsDto} shape) plus, when the request named
 * `keys=`, one series per key named.
 *
 * A namespace with 200 workers costs this request plus one batch for the
 * visible page — two requests, not 200. `series` is the namespace roll-up, one
 * backend read; each row costs a read of its key's series, and the batch is
 * answered from those same reads. More than `MAX_ANALYTICS_SERIES` keys is 400
 * `BULK_LIMIT`.
 */
export interface WorkersAnalyticsDto extends OverviewWorkersAnalyticsDto {
  /**
   * One series per (queue, key) the keys named in `keys=` matched, in the
   * order asked for; absent when the request named none. A listed key with
   * nothing in the range still gets an entry, with zeroed buckets; a key no
   * listed worker carries gets none.
   */
  seriesByKey?: WorkerAnalyticsSeriesDto[];
}

/**
 * `GET /runners/{runner}/analytics`: one runner over the range.
 *
 * **There is no shared `range` here.** Each series carries its own
 * {@link AnalyticsRangeDto}, and they are read over the same request, so
 * `runs.range` is the one to caption from — but read it off a series, never
 * off the envelope.
 */
export interface RunnerAnalyticsDto {
  /** The runner this is about, echoed from the path. */
  runner: string;
  /** Its runs by outcome. */
  runs: AnalyticsSeriesDto<RunnerRunsBucketDto, RunnerRunsTotalsDto>;
  /**
   * Runs in flight **right now**, read from the locks — an instant, not a
   * figure about the range. A client deriving in-flight counts from the
   * buckets must label them derived; this is the honest number.
   */
  runningNow: number;
  /**
   * Its run durations; absent when the backend records none
   * (`MetaDto.analytics.recording.durations` is `false`).
   */
  durations?: AnalyticsSeriesDto<
    RunnerDurationBucketDto,
    RunnerDurationTotalsDto
  >;
}

/**
 * `GET /queues/{queue}/analytics/workers/{key}`: one worker over the range.
 *
 * **Two ranges, not one.** `jobs` is counted and `busyness` is *sampled*, on
 * the worker's heartbeat (`MetaDto.analytics.busynessIntervalMs`, 10 s by
 * default), so busyness can never be finer than that however fine the
 * throughput series is served. Each carries its own
 * {@link AnalyticsRangeDto}, and there is deliberately no envelope-level one
 * to mistake for both.
 */
export interface WorkerAnalyticsDto {
  /** The worker's stable key, echoed from the path. Not the incarnation id. */
  key: string;
  /** The queue it consumes, echoed from the path. */
  queue: string;
  /** Its throughput over the range. */
  jobs: AnalyticsSeriesDto<WorkerJobsBucketDto, WorkerJobsTotalsDto>;
  /**
   * How busy it was — **its own range and resolution**, coarser than `jobs`.
   * Absent when the backend records no busyness. A bucket with `samples: 0`
   * means the worker was not reporting, not that it was idle.
   */
  busyness?: AnalyticsSeriesDto<
    WorkerBusynessBucketDto,
    WorkerBusynessTotalsDto
  >;
}

/** What a deployment is recording, as `MetaDto.analytics.recording` reports it. */
export interface MetaAnalyticsRecordingDto {
  /** The finest resolution being recorded. `"minute"` means no per-second bucket exists to serve. */
  resolution: "minute" | "second";
  /**
   * How long per-second buckets are kept, ms; `0` when only minutes are
   * recorded. At most `MAX_SECOND_RETENTION_MS`, and
   * `DEFAULT_SECOND_RETENTION_MS` unless configured — which is why a
   * 10-minute preset usually comes back at 60 s with
   * `reason: "retention"`.
   */
  secondRetentionMs: number;
  /**
   * Whether per-worker series are recorded. **The first thing to turn off on a
   * large fleet**: workers are the term that scales with the fleet, so a
   * namespace with 300 workers pays most of its analytics cost here.
   */
  workers: boolean;
  /** Whether per-runner outcome series are recorded. */
  runners: boolean;
  /** Whether run durations (and their histograms) are recorded. */
  durations: boolean;
}

/**
 * `MetaDto.analytics`: what this deployment can serve, so a client sizes its
 * picker and its requests from the deployment's own numbers rather than from
 * the contract's defaults.
 */
export interface MetaAnalyticsDto {
  /** The bucket widths this backend serves, in seconds, finest first. A subset of `ANALYTICS_RESOLUTIONS`. */
  resolutions: AnalyticsResolution[];
  /**
   * How long each resolution is kept, in ms, keyed by the resolution in
   * seconds as a string (`"1"`, `"60"`) — JSON object keys are strings. One
   * entry per member of `resolutions`, and no entry for a resolution this
   * backend does not serve.
   */
  retentionMs: Partial<Record<`${AnalyticsResolution}`, number>>;
  /** The longest span one request may cover, ms. A picker clamps itself to this. */
  maxSpanMs: number;
  /** Most buckets one series may hold; what decides the resolution a span is served at. */
  maxBuckets: number;
  /** Most series one request may name (`ids=`, `keys=`); beyond it, 400 `BULK_LIMIT`. Also the page size a table should use. */
  maxSeries: number;
  /** What is being recorded, and therefore what can be asked for. */
  recording: MetaAnalyticsRecordingDto;
  /**
   * The worker heartbeat interval in ms — how often busyness is sampled, and
   * so the finest a busyness series can ever be, whatever `resolutions` says
   * about throughput.
   */
  busynessIntervalMs: number;
}

/**
 * Every editable worker setting and its value: milliseconds except
 * `concurrency` and `maxStalledCount`, which are counts.
 * `WORKER_CONFIG_BOUNDS` holds the range each one is validated against.
 */
export type WorkerConfigValues = Record<WorkerConfigKey, number>;

/**
 * A worker's settings: what it runs with, what its own code asked for, and
 * which of the two an override replaced.
 */
export interface WorkerConfigDto {
  /** What the worker is actually running with. */
  effective: WorkerConfigValues;
  /** What the process's own code and options asked for, before any override. */
  code: WorkerConfigValues;
  /** The keys an override currently replaces, in `WORKER_CONFIG_KEYS` order; `[]` when there is none. */
  overridden: WorkerConfigKey[];
  /** Keys whose `code` value is derived rather than given (today only `heartbeatInterval`, a third of `lockDuration`). Absent when none is. */
  derived?: WorkerConfigKey[];
  /** The stored override's version; send it back as `expectedSeq` for a safe read-modify-write. `0` when nothing is stored. */
  seq: number;
  /** When the override was last written, epoch ms; absent when there is none. */
  updatedAt?: number;
}

/**
 * Where a worker's attempts run, as its record describes it
 * (`WorkerDto.target`).
 *
 * The combinations that occur, since a function cannot be sent to a thread
 * or a process: `"in-process"` with `"function"` or `"file"`;
 * `"worker-thread"` and `"child-process"` with `"file"` only; `"custom"`
 * with `"function"` or `"file"`. A UI need not render any other pair.
 */
export interface WorkerTargetInfoDto {
  /**
   * Where the attempts run: `"in-process"`, `"worker-thread"`,
   * `"child-process"`, or `"custom"` (a target the application supplied).
   * One of `WORKER_TARGET_KINDS`; a kind this client does not know should be
   * shown as the raw string, since a later server may add one.
   */
  kind: WorkerTargetKind;
  /**
   * Whether the attempts run a function or a processor file. The pairs that
   * occur: `"in-process"` + `"function"` | `"file"`; `"worker-thread"` +
   * `"file"`; `"child-process"` + `"file"`; `"custom"` + `"function"` |
   * `"file"`.
   */
  processor: "function" | "file";
  /** For `"custom"`: the target's own name, e.g. `"grpc-pool"`. Absent for every other kind. */
  name?: string;
  /**
   * For a file processor: the absolute path it resolved to. Omitted unless
   * the server enables `serialize.exposeProcessorFiles`.
   */
  file?: string;
}

/**
 * Where a summoned worker came from, as its record describes it
 * (`WorkerDto.summon`): what a Workers-page badge shows.
 */
export interface WorkerSummonProvenanceDto {
  /** The summon attempt's id: always present on a summoned worker. */
  id: string;
  /** The summoner's kind, e.g. `"ecs"` or `"fly"`: what the badge names. */
  kind?: string;
  /**
   * The platform's own name for the unit (a task ARN, a Fly machine id).
   * Infrastructure detail — an ECS task ARN contains the AWS account id — so
   * omitted unless the server enables `serialize.exposeSummonHandles`
   * (default `false`).
   */
  handle?: string;
  /**
   * The mode **as requested by the summoner**: `"exit-on-idle"`,
   * `"until-stopped"` or `"in-invocation"`. Absent when none was requested;
   * never defaulted. Show a mode this client does not know as the raw
   * string: a later server may add one.
   */
  mode?: "exit-on-idle" | "until-stopped" | "in-invocation";
  /**
   * The latest it should stop, epoch ms, **as requested by the summoner**.
   * Absent when none was requested; never defaulted.
   */
  deadlineAt?: number;
}

/** What a worker says about being controlled from outside its process. */
export interface WorkerControlDto {
  /** Whether this worker listens for control at all: its `control` option, and a backend that can store the desired state. */
  enabled: boolean;
  /** How it hears about a change: a driver subscription, or only its own polling. */
  mode: WorkerControlMode;
  /** The lifecycle instruction version it has applied; below the stored `seq` means not applied yet. */
  appliedSeq: number;
  /** The config-override version it has applied; below {@link WorkerConfigDto.seq} means not applied yet. */
  configSeq: number;
  /** Whether it is mid-apply — the same moment as `state === "restarting"`. */
  pending: boolean;
  /**
   * Where a `stop` on this worker persists, as its process is configured
   * (the `stopPersistence` option). Defaults to `"process"`: a redeploy brings
   * the worker back running. `"key"` re-applies the stop at every startup.
   */
  stopPersistence: WorkerStopPersistence;
  /**
   * Whether one request may override {@link WorkerControlDto.stopPersistence} by sending
   * `persist` on the stop route. Defaults to `false`, in which case a request
   * that sends a *different* `persist` is refused 409
   * `WORKER_PERSISTENCE_NOT_ALLOWED` — so the process, not the caller, decides
   * whether a stop outlives it.
   */
  stopPersistenceOverridable: boolean;
  /** The last control it could not apply, and why; absent when the last one applied. */
  lastError?: {
    /** When it failed, epoch ms. */
    at: number;
    /** A safe message: never a driver's or a handler's own text. */
    message: string;
    /** Which instruction failed, where one is known. */
    action?: WorkerControlAction;
    /** The version that failed. */
    seq?: number;
  };
}

/** A worker consuming a queue. */
export interface WorkerDto {
  /**
   * The incarnation's id: unique among live workers, and new each time the
   * process restarts. Lifecycle control (`pause`/`resume`/`stop`/`start`) is
   * addressed by this.
   */
  id: string;
  /**
   * The stable identity a config override is keyed by — `${service}.${queue}`,
   * or the explicit `id`/`name` the worker was built with. Survives restarts
   * and reaches every replica. Absent on a worker that predates remote
   * control; show `id` then.
   */
  key?: string;
  /** The service the worker belongs to (`BunJobs`'s `service` option); absent when none was set. */
  service?: string;
  /** The queue it consumes. */
  queue: string;
  /** What it is doing. Absent on a worker that predates remote control — read `paused` then. */
  state?: WorkerState;
  /** How many jobs it runs at once (its *effective* `concurrency`). */
  concurrency: number;
  /** How many it was running at its last report. */
  active: number;
  /** Whether it was locally paused at its last report. Kept for compatibility with `state === "paused"`. */
  paused: boolean;
  /** When it started consuming, epoch ms. */
  startedAt: number;
  /** When its process started, epoch ms (`performance.timeOrigin`); absent on an older worker. */
  processStartedAt?: number;
  /** When it last reported, epoch ms. */
  heartbeatAt: number;
  /** When the record lapses unless it reports again, epoch ms. */
  expiresAt: number;
  /**
   * Whether it has missed a report (`now - heartbeatAt > 1.5 ×
   * reportInterval`): live in the registry but late, so its numbers are stale
   * and a control request may not be picked up. Absent from a server that does
   * not compute it.
   */
  stale?: boolean;
  /** The bun-jobs version the worker runs; absent on an older worker. */
  version?: string;
  /**
   * Jobs this incarnation has completed since it started, as of its last
   * report — written with the heartbeat, so a workers table has its headline
   * without an analytics read. Per incarnation: a restart starts it at `0`;
   * the series that survives restarts is keyed by `key`
   * (`GET /queues/{queue}/analytics/workers/{key}`). Absent on an older worker.
   */
  completed?: number;
  /** Attempts this incarnation has failed since it started, as of its last report. Absent on an older worker. */
  failed?: number;
  /**
   * Resident set size in bytes at its last report
   * (`process.memoryUsage.rss()`).
   *
   * **The memory of the process, not of the worker.** Two workers in one
   * process report the same number, so **never sum it across rows** — to size
   * a host, take one row per `pid` (with `host`) and add those. Absent on an
   * older worker.
   */
  rssBytes?: number;
  /**
   * How long this worker's own heartbeat record write took, in milliseconds:
   * the round trip to the driver, **not** a network ping — the driver's work
   * and whatever was queued in front of it.
   *
   * **The last sample, not an average**: a write cannot time itself, so this
   * is the previous report's round trip, and one slow figure may be a single
   * stalled write rather than a trend. Absent on a worker's first report and
   * on an older worker.
   */
  heartbeatRttMs?: number;
  /**
   * Whether this worker **takes part in** the queue's housekeeping sweeps —
   * the minute pass: pruning expired results, healing repeat series, sweeping
   * stale queue state — which is what its `maintenance` option decides.
   *
   * Taking part, not performing: the minute pass is leased, so on a queue of
   * five `true` workers exactly one holds the lease on any given pass and the
   * rest stand down. Do not show it as "sweeping now" — a worker that stood
   * down this minute is not a queue without a sweeper.
   *
   * **It says nothing about liveness**: promoting delayed jobs, recovering
   * stalled ones and healing flows happen on every worker and cannot be
   * turned off, so a queue whose live workers all report `false` still runs —
   * it just accumulates what nobody tidies.
   *
   * Absent on an older worker, and **absent is not `false`**: it means the
   * worker is too old to say. Warn that a queue has no sweeper only when at
   * least one live worker reports `false` **and** none reports `true`. A queue
   * whose live workers all omit the field has said nothing, and warning about
   * it would make every fleet that has not upgraded yet read as broken. Even
   * then, "may be nobody": a worker too old to say may be sweeping unseen.
   */
  sweeps?: boolean;
  /**
   * Where its attempts run: in-process, on a worker thread, in a child
   * process, or a custom target — and whether it runs a function or a file.
   *
   * Absent on an older worker, and **absent is not `"in-process"`**: it means
   * the worker is too old to say. `"in-process"` is the default, so reading
   * absence as in-process would mislabel every worker that has not been
   * upgraded. Show absence as unknown ("—"), never as a default.
   *
   * Unrelated to the `target` of a worker *event*'s envelope, which is the
   * queue name.
   */
  target?: WorkerTargetInfoDto;
  /**
   * Where it was summoned from: the attempt, the summoner's kind, and the
   * mode and deadline the summoner requested (and the platform's handle with
   * `serialize.exposeSummonHandles`).
   *
   * **Absent means one of two things, and a client cannot tell which:** the
   * worker was not summoned, or it is too old to say. So absence means "no
   * summon badge", never a claim about how the worker was started.
   */
  summon?: WorkerSummonProvenanceDto;
  /** Its settings. Absent on an older worker, and when the backend keeps no config. */
  config?: WorkerConfigDto;
  /** Its control state. Absent on a worker that predates remote control — treat that as not controllable. */
  control?: WorkerControlDto;
  /** Its host; omitted with `serialize.exposeHosts: false`. */
  host?: string;
  /** Its pid; omitted with `serialize.exposeHosts: false`. */
  pid?: number;
}

/**
 * `GET /workers` query. Every filter is exact and repeatable
 * (`?state=paused&state=stopped`), and the filters are ANDed.
 */
export interface WorkerListQuery {
  /** Only workers on these queues. */
  queue?: string[];
  /** Only workers in these services. */
  service?: string[];
  /** Only workers on these hosts; refused 400 `INVALID_ARGUMENT` when `serialize.exposeHosts` is off. */
  host?: string[];
  /** Only workers in these states. */
  state?: WorkerState[];
  /** Only workers with these stable keys. */
  key?: string[];
  /** Also report stored overrides whose worker is no longer live. Defaults to `false`. */
  includeOffline?: boolean;
}

/** One stored config override, whether or not a worker carrying its key is live. */
export interface WorkerConfigOverrideDto {
  /** The queue it is stored on. */
  queue: string;
  /** The stable worker key it applies to. */
  key: string;
  /** The values it replaces; a key absent from it is left at the worker's own. */
  values: Partial<WorkerConfigValues>;
  /** Its version, bumped on every write. */
  seq: number;
  /** When it was written, epoch ms. */
  updatedAt: number;
  /** Live workers carrying this key, and whether each has applied this version. */
  instances: {
    /** The incarnation's id. */
    id: string;
    /** Whether that worker has applied this `seq`. */
    applied: boolean;
  }[];
}

/** `GET /workers` and `GET /queues/:queue/workers`. */
export interface WorkerListDto {
  /** Live workers, oldest first. */
  items: WorkerDto[];
  /** Stored overrides with no live worker; present only when `includeOffline` was asked for. */
  offline?: WorkerConfigOverrideDto[];
}

/** `GET /queues/:queue/worker-configs`. */
export interface WorkerConfigListDto {
  /** Every override stored on the queue. */
  items: WorkerConfigOverrideDto[];
}

/**
 * `PUT /queues/:queue/worker-configs/:key` body — a **merge patch**: a key
 * left out is untouched, and `null` clears that key's override so the worker
 * goes back to its own value. Each bound is
 * `WORKER_CONFIG_BOUNDS`'s, restated here for the reader.
 */
export interface WorkerConfigBody {
  /** Jobs run at once: 1 … 1 000. */
  concurrency?: number | null;
  /** How often an idle worker looks for work, ms: 10 … 3 600 000. */
  pollInterval?: number | null;
  /** Longest one blocking wait for work, ms: 10 … 3 600 000. */
  maxBlock?: number | null;
  /** A job's lock lease, ms: 1 000 … 86 400 000. Also the limiter's lease, so lowering it under a slow job risks a double run. */
  lockDuration?: number | null;
  /** How often a running job's lock is renewed, ms: 100 … 43 200 000, **and at most half the effective `lockDuration`**. */
  heartbeatInterval?: number | null;
  /** How often stalled jobs are swept, ms: 1 000 … 86 400 000. */
  stalledInterval?: number | null;
  /** How many times a job may stall before it fails: 0 … 100. */
  maxStalledCount?: number | null;
  /** How often the worker reports itself, ms: 1 000 … 600 000. `0` is refused: it would make the worker invisible and so uncontrollable. */
  reportInterval?: number | null;
  /** How long `drain` waits for work to appear, ms: 0 … 86 400 000. */
  drainDelay?: number | null;
  /** The `seq` last read. Answered 409 `CONTROL_CONTENDED` when it no longer matches. Optional: omit it for a last-writer-wins write. */
  expectedSeq?: number;
}

/** `POST /queues/:queue/workers/:worker/{pause,resume,stop,start}` body. */
export interface WorkerControlBody {
  /**
   * Wait up to this many ms for the worker to acknowledge, 0 … 30 000.
   * Defaults to `0`: the route stores the instruction and answers 202 at once.
   */
  wait?: number;
  /**
   * `stop` only: abandon the jobs still running after this many ms instead of
   * waiting for them (their locks then lapse and another worker recovers
   * them). Defaults to no abandon — the worker waits.
   */
  timeout?: number;
  /**
   * `stop` only: how far this stop should persist, overriding the worker's own
   * {@link WorkerControlDto.stopPersistence}. Refused 409
   * `WORKER_PERSISTENCE_NOT_ALLOWED` unless the worker reports
   * {@link WorkerControlDto.stopPersistenceOverridable}. Defaults to the
   * worker's configured value.
   */
  persist?: WorkerStopPersistence;
}

/** What a worker control route answers with. */
export interface WorkerControlResultDto {
  /** The state that was asked for. `stopping` and `restarting` are transients a caller never requests. */
  desired: WorkerDesiredState;
  /** The instruction's version, for polling the worker's `control.appliedSeq`. */
  seq: number;
  /** Whether the worker has been seen to apply it — always `false` without `wait`, unless it was already in that state. */
  applied: boolean;
  /**
   * `stop` only: the persistence that actually applied — the worker's
   * configured value, or the request's `persist` when the worker allowed the
   * override. Absent on the other three actions.
   */
  persisted?: WorkerStopPersistence;
  /** The worker as it now reads; absent when its record has not been rewritten yet. */
  worker?: WorkerDto;
}

/** What the worker config routes answer with. */
export interface WorkerConfigResultDto {
  /** The queue the override is stored on. */
  queue: string;
  /** The stable worker key it applies to. */
  key: string;
  /** The override now stored; `{}` after a reset. */
  values: Partial<WorkerConfigValues>;
  /** Its new version; send it back as `expectedSeq` on the next write. */
  seq: number;
  /** The live workers it reaches, and whether each has applied it yet. */
  instances: {
    /** The incarnation's id. */
    id: string;
    /** Whether that worker has applied this `seq`. */
    applied: boolean;
    /** What it is doing, when the record says. */
    state?: WorkerState;
  }[];
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
 * Queue job defaults
 * ------------------------------------------------------------------ */

/** A backoff a stored default may set: a fixed delay in ms, or one of two strategies. */
export type JobDefaultBackoff =
  | number
  | {
      /** `"fixed"` waits `delay` every time; `"exponential"` doubles it per attempt. */
      type: JobDefaultBackoffType;
      /** Base delay, ms: `JOB_DEFAULTS_BOUNDS.backoffDelay`. */
      delay: number;
      /** Longest delay before jitter, ms: `JOB_DEFAULTS_BOUNDS.backoffMax`, and at least `delay`. Absent means uncapped. */
      max?: number;
      /** Fraction of each delay randomised, 0 … 1. Absent means none. */
      jitter?: number;
    };

/**
 * Every editable job option and its value, as a job would get it. `backoff`
 * and the two retentions have their `JobOptionsDto` shapes, because a *code*
 * value may use any strategy or retention form; only what a client may *store*
 * is narrower ({@link JobDefaultsBody}).
 */
export interface JobDefaultsValues {
  /** Attempts in total, including the first. */
  attempts: number;
  /** Delay between attempts. */
  backoff: JobOptionsDto["backoff"];
  /** Per-attempt timeout, ms; `0` means none. */
  timeout: number;
  /** Lower runs first. */
  priority: number;
  /** Retention of a completed job. */
  removeOnComplete: RetentionDto;
  /** Retention of a job that died. */
  removeOnFail: RetentionDto;
  /** Log lines a job keeps, newest last; `0` (a code value only) keeps every line. */
  keepLogs: number;
  /** Failure stack traces a job keeps. */
  keepStacktraces: number;
}

/** How many jobs wait in each state the apply action rewrites, and all of them. */
export type JobDefaultsPendingDto = Record<JobDefaultsApplyState, number> & {
  /** The four summed. */
  total: number;
};

/**
 * A queue's job defaults: what a job added now gets, what the code asks for,
 * and which of the two a stored override replaced. Mirrors `WorkerConfigDto`.
 *
 * Precedence, highest first: an option passed explicitly on the job's own
 * `add()`; the stored override; the code's defaults (a `define()`
 * definition's for its name, then the queue's `defaultJobOptions`); bun-jobs'
 * built-ins. The override beats a `define()` default: only `add()` wins.
 */
export interface JobDefaultsDto {
  /** The queue. */
  queue: string;
  /** What a job added now, passing none of these options and under no `define()` defaults, gets. */
  effective: JobDefaultsValues;
  /**
   * What the code asks for before any override: the `defaultJobOptions` of the
   * queue instance **this API** holds, over bun-jobs' built-ins. A producer in
   * another process built with different `defaultJobOptions` asks for its own,
   * and a `define()` definition may ask for its own per name; the override
   * replaces all of them alike. See `codeSource`.
   */
  code: JobDefaultsValues;
  /**
   * Where `code` came from: `"api"` — this API's own queue instance. Named so a
   * UI can say "as configured in this service" rather than imply every
   * producer agrees.
   */
  codeSource: "api";
  /** The keys the stored override replaces, in `JOB_DEFAULT_KEYS` order; `[]` when there is none. */
  overridden: JobDefaultKey[];
  /** The stored override itself; `{}` when there is none. */
  override: Partial<JobDefaultsValues>;
  /** The stored override's version; send it back as `expectedSeq`, and as `seq` to apply it. `0` when nothing was ever stored. */
  seq: number;
  /** When the override was last written, epoch ms; absent when it never was. */
  updatedAt?: number;
  /**
   * How long a producer may keep adding jobs with the previous defaults after a
   * change: its `jobDefaultsRefreshInterval`, as this API's queue is
   * configured (default 1 000 ms). Another process may be configured otherwise.
   */
  propagationMs: number;
  /**
   * Jobs pending in each state the apply action rewrites, from the queue's
   * counts — an **upper bound** on what it would change (jobs whose options are
   * explicit, or that predate the explicit record, are inside it). Run the
   * apply action with `dryRun` for the exact figure.
   */
  pending: JobDefaultsPendingDto;
}

/**
 * `PUT /queues/:queue/job-defaults` body — a **merge patch**: a key left out
 * is untouched, and `null` clears it so the code's value applies again. Each
 * bound is `JOB_DEFAULTS_BOUNDS`'s, restated here for the reader.
 */
export interface JobDefaultsBody {
  /** Attempts in total, including the first: 1 … 1 000. */
  attempts?: number | null;
  /** Delay between attempts: fixed ms (0 … 86 400 000), or `{ type: "fixed" | "exponential", delay, max?, jitter? }`. */
  backoff?: JobDefaultBackoff | null;
  /** Per-attempt timeout, ms: 0 (none) … 86 400 000. */
  timeout?: number | null;
  /** Lower runs first: −1 048 576 … 1 048 576. */
  priority?: number | null;
  /** Completed-job retention: `true` removes at once, `false` keeps forever, a count (0 … 1 000 000), or `{ count?, ttl? }` with at least one (`ttl` ms, at most a year). */
  removeOnComplete?: RetentionDto | null;
  /** Dead-job retention, in the same forms. */
  removeOnFail?: RetentionDto | null;
  /** Log lines a job keeps: 1 … 100 000. `0` (keep every line) is refused. */
  keepLogs?: number | null;
  /** Failure stack traces a job keeps: 0 … 100. */
  keepStacktraces?: number | null;
  /** The `seq` last read. Answered 409 `CONTROL_CONTENDED` when it no longer matches. Optional: omit it for a last-writer-wins write. */
  expectedSeq?: number;
}

/** `DELETE /queues/:queue/job-defaults` query. */
export interface ResetJobDefaultsQuery {
  /** The `seq` last read. Answered 409 `CONTROL_CONTENDED` when it no longer matches, and nothing is reset. Omit it to reset whatever is stored. */
  expectedSeq?: number;
}

/**
 * `POST /queues/:queue/job-defaults/apply` body: rewrite jobs already pending
 * with the stored override's values. One call examines at most `limit` jobs;
 * loop on the answer's `next` until `done`. Irreversible: a later reset does
 * not restore what it wrote.
 */
export interface ApplyJobDefaultsBody {
  /**
   * The override version being applied — the `seq` the user confirmed.
   * Required. Answered 409 `DEFAULTS_CHANGED` when the stored override has
   * moved on, so a walk of many calls applies one version or stops.
   */
  seq: number;
  /** Which overridden keys to write. Defaults to every key the override sets; naming one it does not set is 400 `INVALID_ARGUMENT`. */
  keys?: JobDefaultKey[];
  /** Which states to walk. Defaults to all of `JOB_DEFAULTS_APPLY_STATES`. */
  states?: JobDefaultsApplyState[];
  /** Most jobs to examine in this call: 1 … the API's `limits.maxApplyDefaults` (default 1 000). Defaults to 1 000, or `limits.maxApplyDefaults` when that is lower. */
  limit?: number;
  /** The previous call's `next`, to continue a walk. Opaque; a malformed one is 400 `INVALID_ARGUMENT`. */
  cursor?: string;
  /** Examine and count, write nothing. Defaults to `false`. */
  dryRun?: boolean;
  /**
   * Also rewrite jobs added before bun-jobs recorded which options were
   * explicit, treating every option of theirs as defaulted — which may replace
   * a value their `add()` did pass. Defaults to `false`: they are counted in
   * `skippedUnmarked` and left alone.
   */
  includeUnmarked?: boolean;
}

/**
 * What one apply call did. `rewritten`, `unchanged`, `skippedExplicit`,
 * `skippedUnmarked` and `moved` add up to `examined`; `exhausted` counts
 * within `rewritten`.
 */
export interface ApplyJobDefaultsResultDto {
  /** The override version applied. */
  seq: number;
  /** The keys written. */
  keys: JobDefaultKey[];
  /** Whether this was a `dryRun` (then "rewritten" means "would be"). */
  dryRun: boolean;
  /** Jobs looked at in this call. */
  examined: number;
  /** Jobs at least one of whose options changed. */
  rewritten: number;
  /** Jobs that already had every value (including ones met again after their own priority change moved them ahead of the walk). */
  unchanged: number;
  /** Jobs left alone because every key that would change was passed explicitly on their `add()`. A job with only some keys explicit is `rewritten`, keeping those. */
  skippedExplicit: number;
  /** Jobs added before the explicit record existed, left alone (see `includeUnmarked`). */
  skippedUnmarked: number;
  /**
   * Jobs seen in this call's batch that had left the walked states by the time
   * of their write — claimed, removed, promoted into a state not walked — and
   * were not touched. **A lower bound**: backends that lock or run a batch
   * atomically (Redis, SQL, memory) never see one and report `0`.
   */
  moved: number;
  /**
   * Rewritten jobs whose `attemptsMade` already reaches the new `attempts`.
   * They are not dropped: each runs once more, and dies if that attempt fails.
   */
  exhausted: number;
  /** Where the next call continues, or `null` when the walk is complete. */
  next: string | null;
  /** `next === null`. */
  done: boolean;
}

/* ------------------------------------------------------------------ *
 * Runners
 * ------------------------------------------------------------------ */

/** Where a run executes; one of {@link EXECUTION_MODES}. */
export type ExecutionModeDto = (typeof EXECUTION_MODES)[number];

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
  /**
   * How many log lines this run's log holds, after the caps. `0` when the run
   * logged nothing.
   *
   * **Written when the run settles, not while it runs.** Capture counts in
   * memory and puts both counters on the record at the end, so a *running*
   * run has neither — which is why a link to the log is shown on
   * `logLines > 0 || status === "running"`, the second arm covering exactly
   * that. While a run is live, the log read itself is the only count there
   * is; its `lastSeq` and `page.total` are always current.
   *
   * Absent on a settled run means something else: either the backend cannot
   * store run logs at all (`MetaDto.features.runnerLogs` is `false`), or this
   * run's log has aged out while its record survived. The log route answers
   * 409 `LOGS_NOT_RETAINED` for both.
   */
  logLines?: number;
  /**
   * How many of this run's lines the caps dropped, oldest first. `0` when none
   * were.
   *
   * A property of the run, not of any page, so a reader can say "N earlier
   * lines dropped" before it has read a line. Written with `logLines` when the
   * run settles, and absent in the same cases.
   */
  logsDropped?: number;
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

/** A runner's executor and overlap settings, as one set of values. */
export interface RunnerConfigValues {
  /** Where a run executes. */
  executionMode: ExecutionModeDto;
  /** Whether runs may overlap. */
  runMode: "parallel" | "single";
  /** Most concurrent runs in `parallel`, or `null` for unlimited. Meaningless in `single`. */
  maxConcurrency: number | null;
}

/**
 * `PUT /runners/:runner/config` body — a **merge patch**: a field left out is
 * untouched, and `null` clears that override so the runner goes back to what
 * its own code asked for.
 */
export interface RunnerConfigBody {
  /**
   * Where runs execute, from the *next* run on: a run already in flight keeps
   * the mode it started with. Refused 409 `CONFIG_NOT_ALLOWED` when the
   * runner's code does not permit it (see {@link RunnerConfigDto.allowed}).
   */
  executionMode?: ExecutionModeDto | null;
  /**
   * The overlap policy. `maxConcurrency` only means anything in `parallel`, so
   * the two are set together and `null` clears both.
   *
   * **`parallel` → `single` is not immediate across processes**: a parallel
   * run holds no lock, so an owner that has adopted `single` can start while
   * another process's parallel run is still going. Pause the runner first when
   * exclusivity matters.
   */
  concurrency?:
    | {
        /** One run at a time, cluster-wide, held by the runner's lock. */
        runMode: "single";
      }
    | {
        /** Runs may overlap. */
        runMode: "parallel";
        /** Most concurrent runs — `RUNNER_CONFIG_BOUNDS.maxConcurrency`, 1 … 1 000 — or `null` for unlimited. Lowering it never kills a run in flight. */
        maxConcurrency: number | null;
      }
    | null;
}

/**
 * A runner's configuration: what it runs with, what its code asked for, and
 * whether an owner has adopted the override yet.
 */
export interface RunnerConfigDto {
  /** In force now. */
  effective: RunnerConfigValues;
  /** What the owner's code asked for; absent until an owner has started since remote config shipped. */
  code?: RunnerConfigValues;
  /** Which of the three an override replaces, in the order above; `[]` when there is none. */
  overridden: RunnerConfigKey[];
  /**
   * The execution modes an override may choose and this runner's owner can adopt:
   * its `allowedOverrides.executionModes`, less `child-process` and `worker-thread` when it was built from a driver instance (unless one is its code's own mode). May be empty. Absent means all three.
   */
  allowed?: ExecutionModeDto[];
  /** The override's version; `0` when nothing is stored. */
  seq: number;
  /** The version an owner has adopted; below `seq` means it has not been picked up yet. */
  appliedSeq?: number;
  /**
   * Why an owner refused the override, in whole or in part; absent when the
   * last one was adopted entire. A refusal is per setting: the owner adopts
   * what it can and names the rest in `keys`.
   */
  error?: {
    /** When it was refused, epoch ms. */
    at: number;
    /** A safe message. */
    message: string;
    /**
     * The settings the owner refused, in `RUNNER_CONFIG_KEYS` order; every
     * other overridden setting was adopted. A whole-override refusal names
     * every overridden key. `[]` on an error an owner recorded before this
     * field existed — which settings it covered is not known.
     */
    keys: RunnerConfigKey[];
  };
  /** When the override was written, epoch ms; absent when there is none. */
  updatedAt?: number;
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
  /**
   * Its executor and overlap configuration, with the code/effective split and
   * any stored override. Absent on a runner from a deployment that predates
   * remote configuration — treat that as not configurable.
   */
  config?: RunnerConfigDto;
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
  /**
   * The previous page's `page.next`, continuing the walk at the record after
   * the last one shown. **Opaque — never build or parse one**: it holds the
   * backend's ordering key, and the backends do not agree on it. One this
   * route did not issue, or one belonging to another runner or the other
   * `order`, is 400 `INVALID_ARGUMENT`, never a silent restart at page one.
   * Takes precedence over `offset`.
   *
   * A cursor **walks** the list and cannot jump to page N; `offset` samples it
   * and can. The difference that matters: nothing shifts under a cursor when a
   * run starts between two requests, and in `asc` nothing shifts under it when
   * `keepHistory` trims either.
   */
  cursor?: string;
  /**
   * Runs skipped before the page. Defaults to `0`, and has no ceiling: a
   * runner's `keepHistory` may be far larger than `limits.maxHistory`, and
   * this is what reaches the records past the first page. Ignored when
   * `cursor` is sent.
   */
  offset?: number;
  /**
   * Runs on the page. Defaults to `min(50, limits.maxHistory)`; at most
   * `limits.maxHistory`, which bounds **a page** and not how far back
   * `offset` may read. More is 400 `VALIDATION`.
   */
  limit?: number;
  /**
   * Which end to read from, by start time. Defaults to `"desc"` — newest
   * first, the order this route served before it could page.
   */
  order?: "asc" | "desc";
}

/** `GET /runners/:runner/history`, newest first unless `order` says otherwise. */
export interface RunnerHistoryDto {
  /** The runs. */
  items: RunRecordDto[];
  /**
   * Where the page sits. Its `total` is always present and exact: the history
   * is a bounded list every backend holds whole, so counting it costs nothing
   * the page has not already read. Its `next` is always present too — the
   * cursor for the following page, or `null` at the end of the walk — whether
   * or not this page was reached with one.
   */
  page: PageInfoDto;
}

/* --- run logs -------------------------------------------------------- */

/**
 * One captured line of a run's output.
 *
 * A run keeps its log for as long as the run itself is in the runner's
 * history, capped in lines and in bytes; the oldest lines go first, and
 * {@link RunLogPageDto.dropped} says how many have gone.
 *
 * **Two fields are deliberately absent.** There is no `fields`: a structured
 * line is rendered to text at capture, so what is stored and what is sent is
 * one string, and a client never has to render a log entry itself. And there
 * is no `partial`: a line is whole or it is {@link RunLogLineDto.truncated},
 * with nothing in between to stitch together.
 */
export interface RunLogLineDto {
  /**
   * The line's 1-based place in its run's output, assigned by the store and
   * never reused.
   *
   * Two things follow. A **gap** in the sequence means those lines were
   * dropped by a cap, not that they are elsewhere in the page. And it is the
   * cursor for tailing: pass the page's `lastSeq` back as
   * {@link RunLogsQuery.since}, which is exclusive, and the next read neither
   * repeats a line nor skips one.
   */
  seq: number;
  /** When it was captured, epoch ms. */
  at: number;
  /** Which stream produced it; one of `RUN_LOG_STREAMS`. */
  stream: RunLogStream;
  /** The line's text, with its trailing newline already removed. */
  message: string;
  /**
   * The severity a `log`-stream line carried; one of `RUN_LOG_LEVELS`.
   * Absent on `stdout` and `stderr`, which have no levels, and on a forwarded
   * line that came without one.
   */
  level?: RunLogLevel;
  /**
   * Present, and only ever `true`, when capture cut this line at the per-line
   * byte cap (8 KiB of UTF-8). Absent means the line is whole — a reader shows
   * a truncated one as short rather than as complete.
   */
  truncated?: true;
}

/** `GET /runners/:runner/runs/:runId/logs` query. */
export interface RunLogsQuery {
  /**
   * Only lines numbered **above** this — an exclusive lower bound on
   * {@link RunLogLineDto.seq}. Paired with {@link RunLogPageDto.lastSeq} it is
   * a polling tail: read, then ask again with `since` set to the `lastSeq` the
   * page reported. Absent reads from the start of what is kept.
   */
  since?: number;
  /** Lines skipped, within what `since` and `stream` leave. Defaults to `0`. */
  offset?: number;
  /** Page size. Defaults to `min(100, limits.maxLogPage)`; at most `limits.maxLogPage`. */
  limit?: number;
  /** Order. Defaults to `"asc"`. */
  order?: SortOrder;
  /** Only lines from this stream; every stream when absent. */
  stream?: RunLogStream;
}

/**
 * `GET /runners/:runner/runs/:runId/logs` — operation `getRunLogs`, action
 * `runners.logs` (a read: it is not opt-in and not a mutation).
 *
 * **409 `LOGS_NOT_RETAINED` is not the same as a 200 with no items.** The 409
 * says this run's log is not there to read — the backend stores none
 * (`MetaDto.features.runnerLogs` is `false`), or the run's log has been
 * dropped whole because the run fell out of the retained set. A 200 with an
 * empty `items` means the run is known, its log is retained, and it simply
 * logged nothing. A UI must tell a missing log from a silent run.
 */
export interface RunLogPageDto {
  /** The page's lines, in the order asked for. */
  items: RunLogLineDto[];
  /**
   * Where the page sits; `total` is always present, and counts the lines the
   * query's `since` and `stream` leave, not the run's whole log.
   */
  page: PageInfoDto;
  /**
   * How many of this run's lines the caps have dropped, in total — the run's
   * own number, unfiltered by the query, so a reader can say "N earlier lines
   * dropped" whatever page it asked for.
   */
  dropped: number;
  /**
   * Whether a cap is trimming this run's log: its oldest lines are going as
   * new ones arrive, so what is here is a tail. Independent of `dropped` being
   * non-zero only in that `dropped` is history and this is the state now.
   */
  capped: boolean;
  /** Whether the run is still going, so more lines may follow this page. */
  live: boolean;
  /**
   * The highest `seq` this run's log holds, or `0` when it holds nothing.
   * The run's own, unfiltered by the query — which is what makes it a correct
   * cursor: a tail filtered by `stream` that resumed from its last *matching*
   * line would re-read everything the filter excluded.
   */
  lastSeq: number;
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

/** `DELETE /runners/:runner/history` query. */
export interface ClearRunnerHistoryQuery {
  /**
   * How long, in milliseconds, a run whose record still says `running` counts
   * as in progress when nothing else vouches for it. Defaults to one day
   * (86 400 000), which is also the minimum — the API can only make a clear
   * keep more, never clear a live run sooner; at most thirty days. Out of
   * range is 400 `VALIDATION`.
   */
  staleAfter?: number;
}

/**
 * `DELETE /runners/:runner/history` — operation `clearRunnerHistory`, action
 * `runners.clearHistory`: a mutation, so `readOnly` removes it, and on by
 * default, as `runners.resetStats` is.
 *
 * Removes every **finished** run — its history record and its run log — and
 * leaves each run **still in progress** untouched, record and log whole, so a
 * live run's log never loses its start and its record is never half-cleared.
 * The lifetime counters (`GET /runners/:runner/stats`) and the analytics
 * series are not touched: resetting the counters is
 * `POST /runners/:runner/stats/reset`.
 *
 * **Works for a runner registered in another process.** Unlike
 * `POST /runners/:runner/stats/reset` and `POST /runners/:runner/kill`, which
 * answer 409 `RUNNER_NOT_LOCAL`, this is an operation on what the backend
 * stores, keyed by namespace and runner, and needs no owner to be reachable.
 *
 * In progress means: a run the serving process is executing (when the runner
 * is registered there); the run the runner's live lock holder is executing;
 * or any run whose record still says `running` and started less than
 * `staleAfter` ago (one day unless {@link ClearRunnerHistoryQuery} raises it).
 * A `running` record none of those vouch for is a run whose process crashed,
 * and is removed with the finished ones — so a crash cannot pin a run in the
 * history for good. The limit that follows: a parallel run holds no lock, so a
 * live parallel run in another process that started longer than `staleAfter`
 * ago is removed too, and when it settles it finds no record to update.
 *
 * Errors: 400 `INVALID_NAME`, 400 `VALIDATION` (a `staleAfter` out of range),
 * 404 `RUNNER_NOT_FOUND`. A backend that cannot remove individual runs has
 * the route pruned — `runners.clearHistory` is then absent from
 * `GET /meta/permissions` — rather than answering 501, and never falls back
 * to dropping the runs in progress too.
 */
export interface ClearRunnerHistoryResultDto {
  /** How many runs were removed, each with its record and its log. */
  removed: number;
  /**
   * The runs left in place because they are still in progress, newest first.
   * `[]` when nothing was running.
   */
  kept: string[];
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
  /**
   * Whether the backend records who ran each job's last attempt
   * (`JobDto.processedBy`) and filters on it — the driver's own declaration,
   * `false` when it makes none. What the API serves is
   * `MetaDto.features.jobAttribution`, which also follows the mode.
   */
  jobAttribution: boolean;
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
  /** Most jobs one `POST /queues/{queue}/job-defaults/apply` call examines (its largest `limit`). */
  maxApplyDefaults: number;
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
    /**
     * Worker control from another process: the backend can both list workers
     * and record what they should be, so the lifecycle and configuration
     * routes exist. A worker also has to be started with `control` (a
     * `BunJobs` context's `workerControl`, on by default) to obey them,
     * which `WorkerDto.control.enabled` says worker by worker.
     */
    workerControl: boolean;
    /** Throughput metrics. */
    throughput: boolean;
    /**
     * Run logs: the backend can store a runner's captured output per run, so
     * `GET /runners/:runner/runs/:runId/logs` exists and a run record carries
     * `logLines`. `false` means no run has a log to read anywhere — every
     * such read is 409 `LOGS_NOT_RETAINED` — not that this particular run
     * was quiet.
     */
    runnerLogs: boolean;
    /**
     * Runner analytics: the backend can both record a runner's outcomes per
     * interval and read them back, so `GET /analytics/runners` and
     * `GET /runners/{runner}/analytics` exist and `/overview` carries
     * `analytics.runners`. `false` prunes those routes rather than answering
     * 501. What can then be asked for — which resolutions, over what span —
     * is `analytics`, not this.
     */
    runnerMetrics: boolean;
    /**
     * Worker analytics: the backend can both record a worker's throughput per
     * interval and read it back, **and** keeps worker records — the series are
     * keyed by `WorkerDto.key`, and the rows come from the worker listing, so
     * a backend with the counters but no registry has no rows to serve.
     * `false` prunes `GET /analytics/workers` and
     * `GET /queues/{queue}/analytics/workers/{key}`.
     */
    workerMetrics: boolean;
    /**
     * Job attribution: the backend records the worker that ran each job's
     * last attempt (`JobDto.processedBy`), and the job list
     * (`GET /queues/{queue}/jobs`) serves `workerKey`, `workerId`,
     * `finishedFrom` and `finishedTo` natively. Like every flag here it
     * follows the API's mode: `false` in `runner` mode, where the job list is
     * not served.
     *
     * `false` means every `processedBy` is `null`, so a worker filter can
     * match nothing: a UI hides "processed by" and a worker's job list rather
     * than show them empty, and a client sends those four filters only when
     * this is `true`. A worker page's instance list is a different read
     * (`GET /queues/{queue}/workers?key=`, `features.workers`, action
     * `workers.list`) and does not depend on this.
     */
    jobAttribution: boolean;
    /**
     * Reads by creation time: the backend answers them from an index or from
     * memory, never by reading every job record. Two things exist exactly
     * when this is `true`:
     *
     * - `GET /overview/added` and `GET /queues/{queue}/counts/added` — how
     *   many of the jobs added in a range are in each state now
     *   (`AddedByStateDto`, which says why those numbers are shown apart from
     *   the analytics series);
     * - `sort=createdAt` on the job list (`JobListQuery.sort`), which is 400
     *   `INVALID_ARGUMENT` where this is `false`.
     *
     * One flag for both because the same backends serve both: the memory, SQL
     * and MongoDB drivers. `false` on the Redis and file drivers, whose
     * stored order and markers are not by `createdAt`, so a UI shows the
     * analytics series' completed and failed attempts alone and keeps each
     * tab's natural order. Like every flag here it follows the API's mode:
     * `false` in `runner` mode.
     */
    addedByState: boolean;
    /**
     * Stored queue job defaults: the backend can hold a queue's override, so
     * `GET`/`PUT`/`DELETE /queues/{queue}/job-defaults` exist, and producers on
     * this version read it.
     */
    jobDefaults: boolean;
    /**
     * Rewriting pending jobs with them: the backend implements the batched
     * rewrite, so `POST /queues/{queue}/job-defaults/apply` exists.
     */
    jobDefaultsApply: boolean;
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
   * What the analytics routes can serve here — resolutions and their
   * retention, the span and bucket caps, and what is being recorded — or
   * `null` when this backend serves none of it, in which case every analytics
   * route is pruned rather than answering 501.
   *
   * The flat `features` booleans say *whether* runner and worker series
   * exist; this says *what* can be asked for, and — being non-`null` — that
   * the jobs series (`GET /analytics/jobs`, `GET /queues/{queue}/analytics/jobs`,
   * `/overview`'s `analytics`) exist. There is no separate flag for those:
   * every analytics route requires what makes this non-`null`.
   */
  analytics: MetaAnalyticsDto | null;
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
