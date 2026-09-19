import type { SerializedError } from "@kingsleyweb/bun-common";
import type { ConnectionOptions } from "../shared/connection";
import type { DriverEvent, EventKind, EventOfKind } from "../shared/events";
import type { RunnerSchedule } from "../shared/schedule";
import type { SchemaChange, SchemaSyncOptions } from "./schemaSync";

/**
 * The storage contract both subsystems are built on.
 *
 * Everything that has to survive a process — a runner's lock, its state and
 * history, a queue's jobs — goes through this interface, and nothing above it
 * knows whether the backend is a `Map`, a directory, Redis or SQL. That is
 * what lets a runner in one process and a worker in another agree about who
 * holds what.
 *
 * Two rules hold for every implementation:
 *
 * - **Namespace everything.** Every method takes the namespace (directly, or
 *   inside a {@link QueueRef}) and must confine itself to it. Two services
 *   sharing a backend rely on this to keep identical runner ids and queue
 *   names apart.
 * - **Never read the clock.** Times arrive as parameters (`now`, `runAt`,
 *   `expiresAt`) so behaviour is identical across dialects and testable with
 *   a fake clock. A driver's own `NOW()` is never authoritative.
 */

/** What a backend can and cannot do, so callers can adapt rather than assume. */
export interface DriverCapabilities {
  /** Whether {@link QueueDriver.waitForJob} can block instead of polling. */
  blockingWait: boolean;
  /**
   * How events reach other processes: `"push"` (the backend delivers them),
   * `"poll"` (they are read on an interval), `"local"` (this process only).
   */
  events: "push" | "poll" | "local";
  /** Whether several processes on one host can share this backend safely. */
  multiProcess: boolean;
  /** Whether several hosts can share it safely. */
  multiHost: boolean;
}

/** Connection management, shared by both halves of the contract. */
export interface DriverLifecycle {
  /** Identifies the implementation, e.g. `"memory"`. Used in errors. */
  readonly name: string;
  /** What this backend supports; see {@link DriverCapabilities}. */
  readonly capabilities: DriverCapabilities;
  /** Opens the connection. Idempotent: callers may connect repeatedly. */
  connect: () => Promise<void>;
  /** Closes the connection and releases every resource it owns. */
  close: () => Promise<void>;
  /** Whether the backend is reachable right now. */
  ping: () => Promise<boolean>;
  /** Deletes everything under one namespace — and nothing outside it. */
  purge: (ns: string) => Promise<void>;
  /**
   * Brings an existing database in line with the schema this version expects,
   * reporting every difference found — including the ones it declined to make.
   *
   * **Optional**, because it only means anything for a backend with a schema.
   * The memory, file and Redis drivers have nothing to reconcile, so they do
   * not implement it; a caller should check before calling.
   *
   * Safe by default. A change that could stall a running queue is reported
   * with `blocking: true` and `applied: false` unless it was asked for by
   * name — see {@link SchemaSyncOptions.alterColumns}.
   */
  syncSchema?: (options?: SchemaSyncOptions) => Promise<SchemaChange[]>;
  /** Runner ids known to the backend in this namespace. */
  listRunners: (ns: string) => Promise<string[]>;
  /** Queue names known to the backend in this namespace. */
  listQueues: (ns: string) => Promise<string[]>;
}

/* ------------------------------------------------------------------ *
 * Runner storage
 * ------------------------------------------------------------------ */

/** Who holds a lock and until when. */
export interface LockInfo {
  /** The holder's token, which encodes host, pid and run id. */
  token: string;
  /** When the lock expires unless renewed, in epoch milliseconds. */
  expiresAt: number;
}

/** A trigger parked while another run holds the lock. */
export interface QueuedTrigger {
  /** Identifies the trigger, so a drain can be traced back to its request. */
  id: string;
  /** Arguments the queued run should receive. */
  args?: unknown;
  /** Whether the schedule or a caller asked for it. */
  source: "schedule" | "manual";
  /** When it was queued, in epoch milliseconds. */
  requestedAt: number;
  /** Token of the process that queued it. */
  requestedBy: string;
  /**
   * Whether the request asked to run even while the runner is paused.
   *
   * The pause is checked when a trigger is *requested*, but a drain happens
   * later and elsewhere, so without this a drainer cannot tell a forced
   * trigger from an ordinary one and runs whatever it pops.
   *
   * Optional, and absent on a record an earlier version wrote — which reads
   * as not forced, the safe default. Test it as `trigger.force === true`.
   */
  force?: boolean;
}

/** How a run was asked for. */
export type RunSource = "schedule" | "manual" | "queued" | "resume";

/** Where a run executed. */
export type ExecutionMode = "spawn" | "worker" | "in-process";

/** How a run ended. */
export type RunStatus = "running" | "success" | "failed" | "timeout" | "killed";

/** One entry in a runner's history. */
export interface RunRecord {
  /** Identifies the run. */
  runId: string;
  /** The runner that produced it. */
  runnerId: string;
  /** 1-based attempt number within the trigger. */
  attempt: number;
  /** What asked for the run. */
  source: RunSource;
  /** How it executed. */
  mode: ExecutionMode;
  /** Host the run executed on. */
  host: string;
  /** Process id, when the run had its own process. */
  pid?: number;
  /** When it started, in epoch milliseconds. */
  startedAt: number;
  /** When it finished, in epoch milliseconds. */
  finishedAt?: number;
  /** How long it took, in milliseconds. */
  durationMs?: number;
  /** Outcome; `"running"` until it settles. */
  status: RunStatus;
  /** The child's exit code, when it had one. */
  exitCode?: number | null;
  /** The signal that killed the child, when one did. */
  signal?: string | null;
  /** The failure, flattened for storage. */
  error?: SerializedError;
  /** The handler's return value, bounded by `maxResultBytes`. */
  result?: unknown;
  /**
   * Set when a timed-out in-process run could not actually be stopped: the
   * handler ignored its abort signal and is still running somewhere.
   */
  detached?: boolean;
}

/** The runner half of the contract: locks, state, history, queued triggers. */
export interface RunnerDriver {
  /**
   * Takes `key` for `ttlMs` when it is free or expired. Must **fail closed** —
   * any error returns `false`, because running a `single`-mode job whose
   * exclusivity cannot be verified is worse than not running it.
   */
  acquireLock: (
    ns: string,
    key: string,
    token: string,
    ttlMs: number,
    now: number,
  ) => Promise<boolean>;
  /** Extends the lock, but only for its current holder. */
  renewLock: (
    ns: string,
    key: string,
    token: string,
    ttlMs: number,
    now: number,
  ) => Promise<boolean>;
  /** Releases the lock, but only for its current holder. */
  releaseLock: (ns: string, key: string, token: string) => Promise<boolean>;
  /** Who holds the lock, or `null` when it is free or expired. */
  getLock: (ns: string, key: string, now: number) => Promise<LockInfo | null>;
  /** The runner's stored state fields. Missing state reads as `{}`. */
  getState: (ns: string, key: string) => Promise<Record<string, string>>;
  /** Writes state fields; a `null` value deletes the field. */
  setState: (
    ns: string,
    key: string,
    fields: Record<string, string | number | null>,
  ) => Promise<void>;
  /** Applies deltas to counters, returning their new values. */
  incrementCounters: (
    ns: string,
    key: string,
    deltas: Record<string, number>,
  ) => Promise<Record<string, number>>;
  /** Prepends a record to the history, trimming it to `keep` entries. */
  appendHistory: (
    ns: string,
    key: string,
    record: RunRecord,
    keep: number,
  ) => Promise<void>;
  /** Patches a history record (typically finishing a `"running"` one). */
  updateHistory: (
    ns: string,
    key: string,
    runId: string,
    patch: Partial<RunRecord>,
  ) => Promise<boolean>;
  /** History, newest first. */
  listHistory: (
    ns: string,
    key: string,
    limit?: number,
  ) => Promise<RunRecord[]>;
  /** Drops the history. */
  clearHistory: (ns: string, key: string) => Promise<void>;
  /**
   * Queues a trigger, returning `false` when the list already holds `max` —
   * the length check and the push must be atomic, or two processes racing
   * both see room.
   */
  pushQueuedTrigger: (
    ns: string,
    key: string,
    trigger: QueuedTrigger,
    max: number,
  ) => Promise<boolean>;
  /** Takes the oldest queued trigger, or `null` when there is none. */
  popQueuedTrigger: (ns: string, key: string) => Promise<QueuedTrigger | null>;
  /**
   * The oldest queued trigger (the one {@link popQueuedTrigger} would take
   * next) **without** taking it, or `null` when there is none.
   *
   * It exists so a paused runner can look at the head before committing to
   * it: a forced trigger (`force === true`) runs despite the pause and is then
   * popped, while an ordinary one stays where it is, in order, for when the
   * runner resumes. Popping to look and pushing back would lose the head's
   * place in the queue and race every other drainer.
   *
   * Head only, strict FIFO, and read-only: it never removes, reorders or
   * creates anything. Asking about a runner the backend does not know returns
   * `null` and leaves it unknown, so {@link DriverLifecycle.listRunners} does
   * not change. Required rather than optional, because the runner calls it on
   * every drain while paused and there is no correct fallback to degrade to.
   */
  peekQueuedTrigger: (ns: string, key: string) => Promise<QueuedTrigger | null>;
  /** How many triggers are queued. */
  countQueuedTriggers: (ns: string, key: string) => Promise<number>;
  /** Drops every queued trigger, returning how many were dropped. */
  clearQueuedTriggers: (ns: string, key: string) => Promise<number>;
}

/* ------------------------------------------------------------------ *
 * Queue storage
 * ------------------------------------------------------------------ */

/** Identifies one queue: a namespace plus a name. */
export interface QueueRef {
  /** The namespace the queue lives in. */
  ns: string;
  /** The queue's name, unique within the namespace. */
  queue: string;
}

/**
 * Where a job is.
 *
 * `failed` and `dead` are deliberately distinct: `failed` is "this attempt
 * failed and another is due at `runAt`", `dead` is "attempts are exhausted or
 * the error was unrecoverable". A count of each answers different questions —
 * one is backoff, the other needs a human.
 */
export type JobState =
  | "waiting"
  | "delayed"
  | "active"
  | "completed"
  | "failed"
  | "dead"
  /** A parent in a flow, not yet runnable: some of its children have not settled. */
  | "waiting-children";

/** Where a job in a flow lives: its queue, in the same namespace, and its id. */
export interface JobRef {
  /** The queue the job belongs to. */
  queue: string;
  /** The job's id. */
  id: string;
}

/**
 * A job's place in a flow — a parent waiting on children, a child with a
 * parent, or both, in a tree more than one level deep.
 *
 * Kept as one value on the record so every driver stores it the same way:
 * one column, field or hash entry rather than one per detail.
 */
export interface JobFlow {
  /** The job this one is a child of, when it is one. */
  parent: JobRef | null;
  /** The jobs this one waits on, when it is a parent. */
  children: JobRef[];
  /** How many of `children` have not settled yet. */
  pending: number;
  /** Results of children that completed, keyed `queue:id`. */
  values: Record<string, unknown>;
  /** Failures of children marked `ignoreFailure`, keyed `queue:id`. */
  failures: Record<string, SerializedError>;
  /**
   * Whether this child's outcome has been recorded on its parent. Until it
   * has, the child is kept whatever its retention says, so its outcome can
   * still be delivered after a crash between the two steps.
   */
  recorded: boolean;
}

/** How a child ended, as recorded on its parent. */
export type ChildOutcome =
  | {
      /** The child completed. */
      completed: true;
      /** What its processor returned. */
      value: unknown;
    }
  | {
      /** The child failed for good. */
      completed: false;
      /** Why. */
      error: SerializedError;
      /** Whether the child was marked `ignoreFailure`, so the parent carries on. */
      ignored: boolean;
    };

/**
 * What recording a child's outcome on its parent did.
 *
 * Every answer but `"missing"` and `"parent-dead"` means the parent has what it
 * will ever need from this child, so the child's own retention may apply.
 */
export type ChildRecordResult =
  /**
   * The outcome was new and is now on the parent, which still waits on other
   * children — or is `dead`, and keeps a completed or ignored outcome for when
   * it is retried.
   */
  | "recorded"
  /**
   * The outcome was new, and was the last one the parent waited on: it is now
   * `waiting`, or `delayed` when its `runAt` is later.
   */
  | "released"
  /** The outcome was a failure not ignored, and buried the parent: `dead`. */
  | "buried"
  /** The parent already had it, or has moved on and no longer waits. */
  | "already"
  /**
   * The parent is `dead` and the outcome is a failure not ignored, so nothing
   * was stored. The child should stay as it is — a retry of the parent sees it
   * unsettled, and the child can be retried in turn.
   */
  | "parent-dead"
  /**
   * There is no such parent, or it does not list this child: a flow still
   * being added children first, one cut short, or a parent removed.
   */
  | "missing";

/**
 * How long finished jobs are kept.
 *
 * Neither a count sweep nor a TTL ever removes a child in a flow whose outcome
 * its parent has not recorded yet (`flow.parent` set, `flow.recorded` false).
 */
export type Retention = boolean | number | { count?: number; ttl?: number };

/** A job's options after defaults are applied. */
export interface ResolvedJobOptions {
  /** Lower runs first; ties break FIFO by creation time. */
  priority: number;
  /** Total attempts, including the first. */
  attempts: number;
  /**
   * Delay schedule between attempts.
   *
   * `type` is a built-in strategy or the name of one registered on the worker
   * that runs the job — a name rather than a function, because this has to
   * survive being stored and read back by another process.
   */
  backoff:
    | number
    | {
        type?: string;
        delay?: number;
        factor?: number;
        max?: number;
        jitter?: number | boolean;
      };
  /** Per-attempt timeout in milliseconds; `0` means none. */
  timeout: number;
  /** Retention for a completed job. */
  removeOnComplete: Retention;
  /** Retention for a dead job. */
  removeOnFail: Retention;
  /** How many stack traces a failing job keeps. */
  keepStacktraces: number;
  /**
   * The queue a copy of the job is added to when it dies, in the same
   * namespace. Absent unless the job, or the worker running it, names one.
   */
  deadLetter?: string;
  /**
   * How many log lines the job keeps, newest last. Absent unless the job set
   * one; readers fall back to the default.
   */
  keepLogs?: number;
  /**
   * For a child in a flow: whether its failing leaves its parent to carry on
   * rather than failing it. Absent means `false`.
   */
  ignoreFailure?: boolean;
}

/** A job as stored. */
export interface JobRecord {
  /** Identifies the job; also its idempotency key. */
  id: string;
  /** The job's name, chosen by the producer. */
  name: string;
  /** The producer's payload. JSON only. */
  data: unknown;
  /** Options after defaults. */
  opts: ResolvedJobOptions;
  /** Where the job is. */
  state: JobState;
  /** Lower runs first. */
  priority: number;
  /** When the job becomes claimable, in epoch milliseconds. */
  runAt: number;
  /** When it was added, in epoch milliseconds. */
  createdAt: number;
  /** When the current or last attempt started. */
  processedOn: number | null;
  /** When it completed or died. */
  finishedOn: number | null;
  /** When retention removes it, in epoch milliseconds. */
  expiresAt: number | null;
  /** How many attempts have been made. */
  attemptsMade: number;
  /** How many attempts are allowed in total. */
  maxAttempts: number;
  /** How many times the job stalled and was recovered. */
  stalledCount: number;
  /** Latest progress value reported by the processor. */
  progress: unknown;
  /** The processor's return value, once complete. */
  returnValue: unknown;
  /** The most recent failure. */
  failedReason: SerializedError | null;
  /** Recent failures, newest first, capped by `keepStacktraces`. */
  stacktrace: SerializedError[];
  /** Token of the worker holding the job, while active. */
  lockToken: string | null;
  /** When that lock expires, in epoch milliseconds. */
  lockExpiresAt: number | null;
  /** Id of the worker holding it. */
  workerId: string | null;
  /** The repeat definition that produced it, when it is a repeat instance. */
  repeatKey: string | null;
  /** Its place in a flow, or `null` for a job that is in none. */
  flow: JobFlow | null;
}

/** A value stored on a queue, and the version a write must name to replace it. */
export interface QueueStateEntry {
  /** The value, as it was written. JSON only. */
  value: unknown;
  /** Increases with every write, so a compare-and-set can tell it changed. */
  version: number;
}

/** What a worker presents when claiming. */
export interface ClaimOptions {
  /**
   * Job names not to claim this time. Jobs with these names are *skipped*,
   * not waited behind: the claim takes whatever comes next in claim order as
   * if they were not there. Absent or empty means any name.
   *
   * This is how a per-name limit stops one kind of job without stalling the
   * rest of the queue. A driver must honour it on every claim path, singular
   * and plural, or a capped name would run past its cap.
   */
  excludeNames?: string[];
  /** The claiming worker's id. */
  workerId: string;
  /** The lock token to stamp on the job. */
  token: string;
  /** How long the claim's lock lives, in milliseconds. */
  lockMs: number;
  /** The caller's clock, in epoch milliseconds. */
  now: number;
}

/** What {@link QueueDriver.updateJob} changes. Anything left out stays as it is. */
export interface JobPatch {
  /** The new payload. JSON only; `undefined` leaves the payload alone. */
  data?: unknown;
  /** The new priority. Lower runs first. */
  priority?: number;
  /** When the job becomes claimable. Only a `waiting` or `delayed` job moves. */
  runAt?: number;
  /** Change the job only while it is in one of these states. */
  onlyIn?: JobState[];
}

/** What should happen to a job whose attempt failed. */
export type FailOutcome =
  | { retry: true; runAt: number }
  | { retry: false; retention: Retention };

/** A repeatable job's definition. */
export interface RepeatRecord {
  /** Identifies the series within its queue. */
  key: string;
  /** Name given to each instance. */
  name: string;
  /** Payload given to each instance. */
  data: unknown;
  /** Options given to each instance. */
  opts: ResolvedJobOptions;
  /** Cron expression driving the series, when it is cron-driven. */
  cron?: string;
  /** Time zone the cron expression is read in. */
  tz?: string;
  /** Interval in milliseconds, when it is interval-driven. */
  every?: number;
  /** Not before this instant, in epoch milliseconds. */
  startAt?: number;
  /** Not after this instant, in epoch milliseconds. */
  endAt?: number;
  /** Stop after this many instances. */
  limit?: number;
  /**
   * Run every occurrence missed while nothing was consuming, rather than
   * skipping to the next one. Defaults to `false`.
   *
   * Stored on the series rather than taken from the caller each time, because
   * the decision is made by whichever worker happens to schedule the next
   * occurrence — which is not the process that created the series, and may not
   * even be the same machine.
   */
  catchUp?: boolean;
  /** How many instances have been scheduled so far. */
  count: number;
  /** When the next instance is due, or `null` when the series is finished. */
  nextRunAt: number | null;
  /** Id of the job already scheduled for `nextRunAt`. */
  nextJobId: string | null;
  /** When the series was created. */
  createdAt: number;
  /** When it was last updated. */
  updatedAt: number;
}

/**
 * Which jobs {@link QueueDriver.findJobs} reads, in what order, and whether to
 * count them.
 *
 * `states`, `offset`, `limit` and `order` mean exactly what they mean to
 * {@link QueueDriver.listJobs}, and the order is the same one. The two filters
 * narrow the jobs *before* the page is cut, so `offset` counts matches and a
 * page is never short because non-matching jobs sat inside it.
 */
export interface JobQuery {
  /** The states to read. Several are ordered by creation, as `listJobs` does. */
  states: JobState[];
  /** Matching jobs to skip. */
  offset: number;
  /** The most jobs to return. */
  limit: number;
  /** `asc` is the states' natural order, `desc` its reverse. */
  order: "asc" | "desc";
  /**
   * Only jobs whose name is exactly one of these — case, accents and all.
   * Absent means any name; an empty array matches nothing.
   */
  names?: string[];
  /**
   * Only jobs whose id or name contains this, ignoring case. Taken literally:
   * `%`, `_`, `*`, quotes and regular-expression characters match themselves.
   * Absent or empty means no search.
   *
   * Case is folded for ASCII on every backend. Beyond ASCII it follows the
   * engine: SQLite's `LOWER` folds ASCII only, so `É` does not match `é` there.
   * The payload is never searched.
   */
  search?: string;
  /** Also count every match, ignoring `offset` and `limit`. Defaults to `false`. */
  total?: boolean;
}

/** A page of jobs, and how many matched in all when that was asked for. */
export interface JobPage {
  /** The page, in the query's order. */
  jobs: JobRecord[];
  /** Every match, ignoring `offset` and `limit`; present only when asked for. */
  total?: number;
}

/**
 * A worker's heartbeat record: who is consuming a queue, from where, and how
 * busy it is — what `listWorkers` reports.
 *
 * Written on the worker's report interval, never per job, so `active` and
 * `paused` are as fresh as the last report rather than exact.
 */
export interface WorkerInfo {
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
  /** When it started consuming, in epoch milliseconds. */
  startedAt: number;
  /** When it last reported, in epoch milliseconds. */
  heartbeatAt: number;
  /**
   * When the record lapses unless the worker reports again, in epoch
   * milliseconds. A worker that died stops reporting, and from then it is not
   * listed.
   */
  expiresAt: number;
}

/** How many jobs a queue finished in one minute. */
export interface ThroughputBucket {
  /** The start of the minute, in epoch milliseconds: a multiple of 60,000. */
  at: number;
  /** Jobs completed in that minute. */
  completed: number;
  /**
   * Failures in that minute: every attempt that failed, whether it will be
   * retried or not — a job failing three times counts three — plus each job
   * the stalled sweep buried and each flow parent a child's failure buried.
   */
  failed: number;
}

/** A cross-process notification. */
/**
 * What a driver publishes and delivers.
 *
 * A discriminated union on `kind` and then `type`, defined in
 * `shared/events.ts` — so a subscriber that switches on `event.type` narrows
 * to exactly the fields that event carries. It used to be one interface with
 * `type: string` and `payload?: unknown`, which told a subscriber nothing and
 * let a publisher put anything anywhere.
 */
export type {
  DriverEvent,
  EventKind,
  EventOfKind,
  QueueDriverEvent,
  QueueEventName,
  QueueEventPayloads,
  RunnerDriverEvent,
  RunnerEventName,
  RunnerEventPayloads,
} from "../shared/events";

/** The queue half of the contract. */
export interface QueueDriver {
  /** Creates whatever the backend needs before a queue is used. Idempotent. */
  ensureQueue: (q: QueueRef) => Promise<void>;
  /**
   * Adds a job. Idempotent on `id`: an existing job is returned untouched
   * with `added: false`, which is what makes repeat scheduling safe under
   * several workers.
   */
  addJob: (
    q: QueueRef,
    job: JobRecord,
  ) => Promise<{ job: JobRecord; added: boolean }>;
  /** Adds several jobs, with the same per-id idempotency. */
  addJobs: (
    q: QueueRef,
    jobs: JobRecord[],
  ) => Promise<{ job: JobRecord; added: boolean }[]>;
  /**
   * Moves the next due job to `active` and stamps the claim on it, atomically:
   * exactly one caller may receive any given job. `null` when the queue is
   * empty, paused, or nothing is due yet.
   */
  claimJob: (q: QueueRef, opts: ClaimOptions) => Promise<JobRecord | null>;
  /**
   * Claims up to `limit` jobs in one go, when the backend can.
   *
   * Optional: a driver without it is driven through a loop of
   * {@link QueueDriver.claimJob} by `claimJobBatch`, which is what every caller
   * uses. Implement it when the backend can take several rows in one round
   * trip — claiming one at a time caps a drain at one over the claim latency,
   * however high the worker's concurrency is.
   *
   * Two rules, both load-bearing:
   *
   * - **Each returned job is claimed exactly once**, as with `claimJob`. The
   *   batch itself is *not* required to be atomic, so returning fewer than
   *   `limit` is normal and a short result does not mean the queue is empty.
   * - **Never throw after claiming anything.** Jobs already taken are `active`
   *   with the caller's token; throwing abandons them to the stalled sweep and
   *   spends a `stalledCount` on each. Return what was taken instead.
   *
   * Returned jobs must be in claim order — `priority`, then `createdAt`, then
   * `id` — which is not the order a backend hands them back in: `RETURNING`, a
   * re-select and a re-read all leave row order undefined.
   */
  claimJobs?: (
    q: QueueRef,
    opts: ClaimOptions,
    limit: number,
  ) => Promise<JobRecord[]>;
  /** Extends an active job's lock, for its holder only. */
  extendJobLock: (
    q: QueueRef,
    id: string,
    token: string,
    lockMs: number,
    now: number,
  ) => Promise<boolean>;
  /** Completes a job, for its lock holder only. */
  completeJob: (
    q: QueueRef,
    id: string,
    token: string,
    result: unknown,
    retention: Retention,
    now: number,
  ) => Promise<boolean>;
  /**
   * Completes several jobs held under one token, in as few statements as the
   * backend allows.
   *
   * Optional: without it `completeJobBatch` calls {@link QueueDriver.completeJob}
   * once each, which is what every driver did before. Implement it where a
   * backend can settle a set in one round trip — a worker at concurrency 16
   * finishes jobs in bursts, and one statement per job is what its own claim
   * loop ends up contending with.
   *
   * Returns the ids actually settled. An id missing from the result lost its
   * lock and is someone else's to finish, exactly as `false` from the singular
   * form means.
   */
  completeJobs?: (
    q: QueueRef,
    token: string,
    completions: { id: string; result: unknown; retention: Retention }[],
    now: number,
  ) => Promise<string[]>;
  /** Fails an attempt, for its lock holder only. */
  failJob: (
    q: QueueRef,
    id: string,
    token: string,
    error: SerializedError,
    outcome: FailOutcome,
    now: number,
    keepStacktraces: number,
  ) => Promise<boolean>;
  /** Records progress reported by a processor. */
  updateProgress: (
    q: QueueRef,
    id: string,
    progress: unknown,
  ) => Promise<boolean>;
  /**
   * Changes a stored job's data, priority or due time, and answers with the
   * job as it now is — or `null` when there is no such job, or it is in a state
   * the patch does not allow.
   *
   * Optional, so a driver written against an earlier contract still compiles;
   * every built-in driver implements it, and what depends on it — changing a
   * job's data or priority, debouncing — says so when a driver lacks it.
   *
   * The rules:
   *
   * - **`runAt` moves only a `waiting` or `delayed` job**, and anything else
   *   comes back `null` untouched: an active job belongs to its worker, and a
   *   finished one has nothing to be due for. The state follows the new time —
   *   later than `now` is `delayed`, otherwise `waiting` — so a job moved into
   *   the future is not claimable and one moved to now does not wait for
   *   promotion.
   * - **A new priority reorders a waiting job** among the others.
   * - **`onlyIn` is checked in the same step as the write.** A job claimed
   *   between a caller reading it and calling this is not changed when
   *   `onlyIn` leaves out `active`, which is what makes replacing a pending
   *   job's data safe while workers are claiming.
   */
  updateJob?: (
    q: QueueRef,
    id: string,
    patch: JobPatch,
    now: number,
  ) => Promise<JobRecord | null>;
  /**
   * Appends one line to a job's log, and says how many lines it now keeps —
   * `0`, storing nothing, when there is no such job.
   *
   * `keep` caps the log at its most recent lines, dropping the oldest; `0`
   * keeps every line.
   *
   * **A log lives exactly as long as its job**, however the job goes: removed,
   * cleaned, drained, pruned, or deleted on completion by retention. A job
   * added later under the same id starts with an empty log, rather than
   * inheriting the lines of the one it replaced.
   *
   * Optional, as {@link QueueDriver.updateJob} is.
   */
  addJobLog?: (
    q: QueueRef,
    id: string,
    line: string,
    keep: number,
  ) => Promise<number>;
  /**
   * A page of a job's log, and how many lines it keeps in total.
   *
   * `asc` is oldest first. A job with no log, or no such job, has none.
   */
  getJobLogs?: (
    q: QueueRef,
    id: string,
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ) => Promise<{ logs: string[]; count: number }>;
  /**
   * Records how a child ended on its parent, in `q`, and moves the parent on,
   * atomically.
   *
   * Repeat-safe: an outcome the parent already holds changes nothing and
   * answers `"already"`, which is what lets a crash between completing a child
   * and recording it be healed by recording again. A parent that does not list
   * `child` among its children answers `"missing"`, as a parent that does not
   * exist does.
   *
   * - **Parent in `waiting-children`:** a completed child, or a failure marked
   *   ignored, is stored and counted off — `"recorded"`, or `"released"` when
   *   none are left and the parent becomes `waiting` (or `delayed`, if its
   *   `runAt` is later). A failure not ignored buries the parent: `dead`, with
   *   `error` as its reason — `"buried"`.
   * - **Parent `dead`:** a completed or ignored outcome is stored, with no
   *   change to the state or the count, so a retry of the parent finds it —
   *   `"recorded"`. A failure not ignored stores nothing — `"parent-dead"`.
   * - **Any other state:** `"already"`.
   */
  recordChild?: (
    q: QueueRef,
    parentId: string,
    child: JobRef,
    outcome: ChildOutcome,
    now: number,
  ) => Promise<ChildRecordResult>;
  /**
   * Returns a parent that was buried by a child's failure to waiting on the
   * children it has no outcome for, with the reason it was buried cleared.
   * Answers whether it moved.
   *
   * Acts only on a `dead` job with a flow. The count left is taken in the same
   * atomic step, from the parent's children with no entry in `values` or
   * `failures` — never from the children's states, since a child removed after
   * its outcome was stored has settled, and a failed child removed before one
   * was has not. Outcomes already recorded are kept. With none left the parent
   * goes to `waiting`, or `delayed` when its `runAt` is later; otherwise to
   * `waiting-children`.
   *
   * This, not {@link QueueDriver.retryJob}, is how a queue retries a buried
   * parent. Optional, with `recordChild` and `markChildRecorded`: a driver
   * without all three cannot run flows.
   */
  requeueParent?: (q: QueueRef, id: string, now: number) => Promise<boolean>;
  /**
   * Marks a child's outcome as recorded on its parent, and applies the
   * retention its completion or failure deferred.
   *
   * `retention` is the child's `removeOnComplete` or `removeOnFail`, applied
   * exactly as `completeJob` and `failJob` would have: removal, a TTL expiry,
   * or the count sweep — only while the job is `completed` or `dead`. Answers
   * `false` when there is no such job.
   *
   * Also how a flow's top-level parent, buried by a child, gets the
   * `removeOnFail` its bury could not apply: it has no parent, so the mark
   * itself means nothing for it.
   */
  markChildRecorded?: (
    q: QueueRef,
    id: string,
    retention: Retention,
    now: number,
  ) => Promise<boolean>;
  /** One job by id, or `null`. */
  getJob: (q: QueueRef, id: string) => Promise<JobRecord | null>;
  /**
   * Jobs in the given states, ordered by their state's natural order, which
   * every driver shares for a single state: `waiting` by priority then
   * creation, `delayed` and `failed` by when they are due, `active` by lock
   * expiry, `completed` and `dead` by when they finished. Several states are
   * ordered by creation. `asc` is that order, `desc` its reverse.
   */
  listJobs: (
    q: QueueRef,
    states: JobState[],
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ) => Promise<JobRecord[]>;
  /** How many jobs are in each state. */
  countJobs: (q: QueueRef) => Promise<Record<JobState, number>>;
  /**
   * A page of jobs narrowed by name or a search, and optionally how many
   * matched in all.
   *
   * Optional: `findJobPage` in `readApis.ts` pages through
   * {@link QueueDriver.listJobs} and filters when a driver lacks it, which is
   * correct everywhere and linear in the jobs in those states. The option lives
   * here rather than on `listJobs` because a driver written before it would
   * ignore an unknown option and hand back an unfiltered page.
   *
   * With no filter this is `listJobs`, and `total` is the sum of those states'
   * counts. A driver must never match against the payload. See
   * {@link JobQuery} for what each field means.
   */
  findJobs?: (q: QueueRef, query: JobQuery) => Promise<JobPage>;
  /**
   * Several jobs by id, in one round trip where the backend allows: one entry
   * per id given, in the same order, `null` for an id with no job. An id given
   * twice is answered twice.
   *
   * Optional: `getJobsByIds` in `readApis.ts` calls {@link QueueDriver.getJob}
   * a bounded number at a time when a driver lacks it.
   */
  getJobs?: (q: QueueRef, ids: string[]) => Promise<(JobRecord | null)[]>;
  /**
   * Writes a worker's heartbeat record, replacing the one it wrote before.
   * The record lapses at `worker.expiresAt`.
   *
   * Optional, with {@link QueueDriver.listWorkers} and
   * {@link QueueDriver.removeWorker}: a driver without the three keeps the
   * records in queue state instead (see `readApis.ts`), and one without queue
   * state either has no worker inventory. A worker writes once per report
   * interval, never per job.
   *
   * While writing, a driver removes the queue's records already lapsed at
   * `worker.heartbeatAt`, so a dead worker's record goes when any live worker
   * on the queue reports rather than only when somebody lists. Where the
   * backend expires keys itself, their lifetime must be relative to the
   * server's clock, never an absolute time taken from the caller's.
   */
  registerWorker?: (q: QueueRef, worker: WorkerInfo) => Promise<void>;
  /** Removes a worker's heartbeat record, answering whether there was one. */
  removeWorker?: (q: QueueRef, id: string) => Promise<boolean>;
  /**
   * The workers whose records have not lapsed at `now` — `expiresAt` later
   * than it — ordered by `startedAt`, then id. A lapsed record is never
   * listed, and a driver may remove lapsed records while answering.
   */
  listWorkers?: (q: QueueRef, now: number) => Promise<WorkerInfo[]>;
  /**
   * How many jobs are in each state, for every queue in the namespace that
   * holds any, in one query where the backend allows.
   *
   * Optional: without it a caller counts each queue `listQueues` names. A
   * queue with no jobs may be absent; every state of a queue present is.
   */
  countJobsByQueue?: (
    ns: string,
  ) => Promise<Record<string, Record<JobState, number>>>;
  /**
   * How many jobs the queue completed, and how many attempts failed, in each
   * minute whose start is in `[from, to]`, oldest first. A minute with neither
   * may be absent.
   *
   * A driver that implements this counts in {@link QueueDriver.completeJob},
   * {@link QueueDriver.completeJobs} and {@link QueueDriver.failJob}, by the
   * minute of the `now` each is given — only for a write that took effect —
   * and must not add a round trip per job to do it: the count rides in the
   * same statement or script where the engine allows, and is otherwise
   * gathered in memory and written in one statement a second. Minutes are kept
   * for `THROUGHPUT_RETENTION_MS` (a day): removed once they are that much
   * older than the latest minute counted, or — on a backend that expires keys
   * itself, as Redis does — that long after they began, by the server's clock.
   *
   * Optional, and with no fallback: counts that were never kept cannot be
   * reconstructed from jobs retention has removed.
   *
   * `failed` also counts each job {@link QueueDriver.recoverStalled} buries and
   * each parent {@link QueueDriver.recordChild} buries, counted by those writes.
   * They happen in maintenance rather than per job, so a driver may gather
   * those in memory even where it counts completions inside the statement.
   */
  getThroughput?: (
    q: QueueRef,
    range: { from: number; to: number },
  ) => Promise<ThroughputBucket[]>;
  /**
   * Writes the throughput counts this driver instance has gathered in memory
   * and not yet written, and resolves once they are written — or, for the ones
   * that failed, kept for the next attempt.
   *
   * Optional: only a driver that gathers counts in memory needs it. A worker
   * or queue awaits it when closing whether or not it owns the driver, because
   * a process that shares one driver across its workers may exit without ever
   * closing it, and the last second of counts would go with the process.
   */
  flushThroughput?: () => Promise<void>;
  /** Removes a job. Refuses (returns `false`) while it is active. */
  removeJob: (q: QueueRef, id: string) => Promise<boolean>;
  /**
   * Returns a finished job to `waiting`, optionally resetting its attempts.
   *
   * Refuses (returns `false`) a job that is `active`, `waiting` or
   * `waiting-children` — the last is not finished, and moving it would run a
   * parent before its children have settled.
   *
   * **Not flow-aware, on purpose.** A `dead` parent that a child's failure
   * buried goes straight to `waiting` here, and would run without the results
   * it waits on. A queue must route such a parent through
   * {@link QueueDriver.requeueParent} instead, as `BunQueue.retry`,
   * `retryJobs`, `retryAll` and `Job.retry` all do; calling this directly on
   * one is the caller's decision to run the parent regardless.
   *
   * A child in a flow has its `flow.recorded` cleared by the same write: the
   * outcome it will end with has not reached its parent yet, so until it does
   * its retention must wait and maintenance must be able to find it.
   */
  retryJob: (
    q: QueueRef,
    id: string,
    resetAttempts: boolean,
    now: number,
  ) => Promise<boolean>;
  /** Makes a delayed or retry-pending job claimable now. */
  promoteJob: (q: QueueRef, id: string, now: number) => Promise<boolean>;
  /** Promotes every job whose `runAt` has passed, up to `limit`. */
  promoteDelayed: (q: QueueRef, now: number, limit: number) => Promise<number>;
  /**
   * Recovers jobs whose worker died holding them: back to `waiting`, or to
   * `dead` once they have stalled `maxStalledCount` times.
   */
  recoverStalled: (
    q: QueueRef,
    now: number,
    maxStalledCount: number,
    limit: number,
  ) => Promise<{ requeued: string[]; dead: string[] }>;
  /**
   * Removes jobs in `state` older than `olderThanMs`, returning their ids.
   *
   * Age is `finishedOn` when the job has one, else `createdAt`. Cleaning a
   * parent in `waiting-children` leaves its children: they record into a
   * missing parent, then their own retention applies.
   */
  cleanJobs: (
    q: QueueRef,
    state:
      | "completed"
      | "failed"
      | "dead"
      | "waiting"
      | "delayed"
      | "waiting-children",
    olderThanMs: number,
    limit: number,
    now: number,
  ) => Promise<string[]>;
  /**
   * Removes jobs whose retention TTL has passed.
   *
   * Like the count sweep every retention runs, it skips a child in a flow whose
   * outcome has not been recorded on its parent (`flow.parent` set,
   * `flow.recorded` false): removing it would lose that outcome.
   */
  pruneExpired: (q: QueueRef, now: number, limit: number) => Promise<number>;
  /** Removes every pending job, returning how many went. */
  drainQueue: (q: QueueRef, includeDelayed: boolean) => Promise<number>;
  /**
   * A named value stored on a queue, with its version, or `null`.
   *
   * Optional, with {@link QueueDriver.setQueueState}: the pair is what
   * cluster-wide limits are built on. Limits are shared state every worker in
   * every process has to agree on, and a compare-and-set is the one primitive
   * each backend can make atomic in its own way, so the limiting logic itself
   * is written once, above the driver.
   */
  getQueueState?: (
    q: QueueRef,
    name: string,
  ) => Promise<QueueStateEntry | null>;
  /**
   * Writes a named value on a queue, but only if it is still at `expected` —
   * `null` meaning only if there is no value yet — and answers with the new
   * version, or `null` when somebody else wrote first and nothing changed.
   *
   * A `value` of `null` deletes the entry, under the same condition, and
   * answers `0`. The check and the write are one atomic step: two callers
   * naming the same version cannot both succeed. Versions only increase, and
   * a deleted then re-created entry starts again from `1`. Purging the
   * namespace removes every entry.
   */
  setQueueState?: (
    q: QueueRef,
    name: string,
    value: unknown,
    expected: number | null,
    /**
     * Carries this package's private token on a write to one of its own
     * reserved entries. A caller leaves it unset, and cannot forge it; a name
     * under the reserved prefix is then refused. A driver hands it, untouched,
     * to `assertWritableStateName`. Optional, so an external driver that
     * ignores it keeps working.
     */
    options?: { internal?: symbol },
  ) => Promise<number | null>;
  /**
   * Names of a queue's state entries that begin with `prefix`, in ascending
   * **code-point order** — only those after `after` when it is given — at most
   * `limit`.
   *
   * Code-point order is UTF-8 byte order, which is what a byte comparison
   * gives on every backend; it is not JavaScript's default `sort()`, which
   * compares UTF-16 units. `compareCodePoints` in `shared/strings.ts` is the
   * reference. Names are compared exactly — case and accents included — and
   * `prefix` is matched literally, with no pattern characters.
   *
   * Optional, with the other queue-state methods. It exists so entries whose
   * purpose has passed can be found and removed: a debounce pointer to a job
   * that has run, a throttle window that has closed. Without it they would
   * accumulate, one per id ever used, for as long as the queue exists.
   *
   * Paging by `after` is what keeps a sweep bounded however many entries
   * there are. A deleted entry is not listed.
   */
  listQueueState?: (
    q: QueueRef,
    options: { prefix: string; after?: string; limit: number },
  ) => Promise<string[]>;
  /** Pauses claiming across every process. */
  pauseQueue: (q: QueueRef) => Promise<void>;
  /** Resumes claiming across every process. */
  resumeQueue: (q: QueueRef) => Promise<void>;
  /** Whether claiming is paused. */
  isQueuePaused: (q: QueueRef) => Promise<boolean>;
  /** Creates or updates a repeat definition. */
  upsertRepeat: (q: QueueRef, def: RepeatRecord) => Promise<void>;
  /** One repeat definition by key. */
  getRepeat: (q: QueueRef, key: string) => Promise<RepeatRecord | null>;
  /** Every repeat definition in the queue. */
  listRepeats: (q: QueueRef) => Promise<RepeatRecord[]>;
  /** Removes a repeat definition. */
  removeRepeat: (q: QueueRef, key: string) => Promise<boolean>;
  /** Earliest `runAt` among not-yet-due jobs, for budgeting a wait. */
  nextDelayedAt: (q: QueueRef) => Promise<number | null>;
  /**
   * Waits until work may be available or `timeoutMs` elapses. A hint, not a
   * guarantee: a caller must still handle an empty claim. Rejects only on
   * abort.
   */
  waitForJob: (
    q: QueueRef,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  /** Publishes an event to other processes. */
  publish: (event: DriverEvent) => Promise<void>;
  /**
   * Removes stored events older than `before`, and says how many went.
   *
   * **Optional**, because only a backend that *stores* events has anything to
   * remove. Redis publishes to a channel and keeps nothing; the memory driver
   * calls its listeners and keeps nothing. The other three append a row, a
   * document or a line per event and, until this existed, never removed one —
   * an event log that grows for as long as the queue runs.
   *
   * Events are a live notification channel rather than an audit trail: a
   * subscriber that has been down long enough to care about an hour-old event
   * has a larger problem than the event. Drivers that store them prune on
   * their own; this is the same thing on demand.
   */
  cleanEvents?: (ns: string, before: number) => Promise<number>;
  /**
   * Subscribes to events; resolves with an unsubscribe function.
   *
   * Generic in `kind` so the listener is handed the union for that subsystem
   * alone: a queue subscriber never has to consider a runner event, and a
   * `switch` on `event.type` narrows the payload from there.
   */
  subscribe: <TKind extends EventKind>(
    ns: string,
    kind: TKind,
    target: string,
    listener: (event: EventOfKind<TKind>) => void,
  ) => Promise<() => Promise<void>>;
}

/** Everything a backend must implement. */
export interface JobsDriver
  extends DriverLifecycle, RunnerDriver, QueueDriver {}

/**
 * How to build a driver, when one is not passed as an instance.
 *
 * Every backend accepts a connection either way: `url` for what a platform
 * hands you in an environment variable, `connection` for what a config file
 * or a secrets manager gives you a field at a time. A config has to survive
 * `JSON.stringify`, because it is what a spawned child receives — an
 * instance cannot cross a process boundary, a description of one can.
 */
export type DriverConfig =
  | { type: "memory" }
  | {
      type: "file";
      /** Directory the driver owns. */
      root: string;
      /** How often to poll for new work and events. Defaults to 25ms. */
      pollInterval?: number;
      /** How long a stored event is kept, in milliseconds. `0` keeps everything. */
      eventRetentionMs?: number;
    }
  | {
      type: "redis";
      /** A connection string. */
      url?: string;
      /** The connection as fields, when a URL is not what you have. */
      connection?: ConnectionOptions;
      /** Whether the server is a cluster, which changes how keys are grouped. */
      cluster?: boolean;
      /** Prepended to every key, ahead of the namespace. */
      keyPrefix?: string;
      /** How long a single blocking wait lasts, at most. Defaults to 5 seconds. */
      maxBlockSeconds?: number;
    }
  | {
      type: "sql";
      /** A connection string; its scheme names the engine. */
      url?: string;
      /** The connection as fields; `adapter` then names the engine. */
      connection?: ConnectionOptions;
      /** Overrides the engine detected from the URL. */
      adapter?: "postgres" | "mysql" | "mariadb" | "sqlite";
      /** Prepended to every table name. */
      tablePrefix?: string;
      /** Exact table names, for an existing schema. Any subset; the rest are defaulted. */
      tables?: Partial<
        Record<
          "jobs" | "locks" | "kv" | "events" | "logs" | "workers" | "metrics",
          string
        >
      >;
      /**
       * Announce new jobs over Postgres `LISTEN`/`NOTIFY` as well as polling.
       *
       * On by default where the engine supports it, because it is free. The
       * signal rides inside the insert rather than following it, so there is no
       * extra round trip: measured over alternating runs, bulk enqueue is
       * 19,414/s without it and 19,334/s with — a 0.4% difference inside the
       * run-to-run spread. Round-trip latency is about 3% better and, more
       * usefully, far steadier: three runs gave 2.96/2.97/2.96ms with it
       * against 3.23/3.05/3.02ms without.
       *
       * Polling always continues underneath as the correctness floor. A
       * notification can be missed while a listener reconnects, and a job
       * promoted by another process's maintenance sweep is never announced at
       * all.
       *
       * Set `false` to poll only — worth doing if the one extra listening
       * connection is unwelcome, or when running through a pooler that cannot
       * pin a session. Ignored on every engine but Postgres.
       */
      notify?: boolean;
      /**
       * Reconcile an existing database with this version's schema on connect.
       *
       * Off by default. The schema is created with `IF NOT EXISTS`, so a table
       * an earlier version created keeps its original shape — which means
       * schema improvements that ship with an upgrade reach new installs only.
       * This is how a deployment that already has tables gets them.
       *
       * `true` does everything that cannot stall a running queue: adds missing
       * columns and indexes, drops indexes the driver no longer defines, and
       * rebuilds one whose predicate changed. On Postgres the index work is
       * `CONCURRENTLY`, so writes continue throughout.
       *
       * Changing a column's type is **not** included — it rewrites the table
       * under a lock that blocks every reader and writer. Ask for it in a
       * maintenance window: `{ alterColumns: true }`.
       */
      syncSchema?: boolean | SchemaSyncOptions;
      /** How often a wait re-checks for work. Defaults to 50ms. */
      pollInterval?: number;
      /** How long a stored event is kept, in milliseconds. `0` keeps everything. */
      eventRetentionMs?: number;
    }
  | {
      type: "mongodb";
      /** A connection string. */
      url?: string;
      /** The connection as fields, when a URL is not what you have. */
      connection?: ConnectionOptions;
      /** Database to use; defaults to the one named in the URL. */
      database?: string;
      /** Prepended to every collection name. */
      collectionPrefix?: string;
      /** Exact collection names, for an existing database. Any subset; the rest are defaulted. */
      collections?: Partial<
        Record<"jobs" | "locks" | "kv" | "events" | "jobLogs", string>
      >;
      /**
       * Options passed to the `MongoClient` this driver creates.
       *
       * Declared as plain JSON values, not the driver library's
       * `MongoClientOptions`: a config has to survive `JSON.stringify` to
       * reach a spawned child, and that type admits functions, streams and
       * TLS buffers which would not. Pass those to the constructor instead.
       */
      clientOptions?: Record<string, unknown>;
      /** How often a wait re-checks for work. Defaults to 50ms. */
      pollInterval?: number;
      /** How long a stored event is kept, in milliseconds. `0` keeps everything. */
      eventRetentionMs?: number;
      /**
       * Reconcile the collections' indexes with this version's on connect.
       *
       * Off by default, though less consequential here than on SQL: MongoDB
       * has no column types, so there is nothing a sync can do to a collection
       * that could block it, and `createIndex` is idempotent — connecting
       * already creates what is missing. What this adds is the report, and the
       * retirement of indexes older versions created.
       */
      syncSchema?: boolean | SchemaSyncOptions;
    };

/** A schedule stored alongside a runner's state. */
export type StoredSchedule = RunnerSchedule;
