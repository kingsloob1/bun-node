import type { SerializedError } from "@kingsleyweb/bun-common";
import type { ConnectionOptions } from "../shared/connection";
import type { RunnerSchedule } from "../shared/schedule";

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
  | "dead";

/** How long finished jobs are kept. */
export type Retention = boolean | number | { count?: number; ttl?: number };

/** A job's options after defaults are applied. */
export interface ResolvedJobOptions {
  /** Lower runs first; ties break FIFO by creation time. */
  priority: number;
  /** Total attempts, including the first. */
  attempts: number;
  /** Delay schedule between attempts. */
  backoff:
    | number
    | {
        type?: "fixed" | "exponential";
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
}

/** What a worker presents when claiming. */
export interface ClaimOptions {
  /** The claiming worker's id. */
  workerId: string;
  /** The lock token to stamp on the job. */
  token: string;
  /** How long the claim's lock lives, in milliseconds. */
  lockMs: number;
  /** The caller's clock, in epoch milliseconds. */
  now: number;
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

/** A cross-process notification. */
export interface DriverEvent {
  /** Envelope version, so a rolling upgrade can tell shapes apart. */
  v: 1;
  /** The namespace it belongs to. Subscribers ignore anything else. */
  ns: string;
  /** Which subsystem emitted it. */
  kind: "queue" | "runner";
  /** The queue name or runner id. */
  target: string;
  /** The event name, e.g. `"completed"`. */
  type: string;
  /** The job or run id it concerns. */
  id?: string;
  /** When it was emitted, in epoch milliseconds. */
  at: number;
  /** A small payload; kept minimal because some transports cap the size. */
  payload?: unknown;
  /** Token of the emitting process, so it can ignore its own echoes. */
  origin: string;
}

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
  /** One job by id, or `null`. */
  getJob: (q: QueueRef, id: string) => Promise<JobRecord | null>;
  /** Jobs in the given states, ordered by their state's natural order. */
  listJobs: (
    q: QueueRef,
    states: JobState[],
    opts: { offset: number; limit: number; order: "asc" | "desc" },
  ) => Promise<JobRecord[]>;
  /** How many jobs are in each state. */
  countJobs: (q: QueueRef) => Promise<Record<JobState, number>>;
  /** Removes a job. Refuses (returns `false`) while it is active. */
  removeJob: (q: QueueRef, id: string) => Promise<boolean>;
  /** Returns a finished job to `waiting`, optionally resetting its attempts. */
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
  /** Removes finished jobs older than `olderThanMs`, returning their ids. */
  cleanJobs: (
    q: QueueRef,
    state: "completed" | "failed" | "dead" | "waiting" | "delayed",
    olderThanMs: number,
    limit: number,
    now: number,
  ) => Promise<string[]>;
  /** Removes jobs whose retention TTL has passed. */
  pruneExpired: (q: QueueRef, now: number, limit: number) => Promise<number>;
  /** Removes every pending job, returning how many went. */
  drainQueue: (q: QueueRef, includeDelayed: boolean) => Promise<number>;
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
  /** Subscribes to events; resolves with an unsubscribe function. */
  subscribe: (
    ns: string,
    kind: "queue" | "runner",
    target: string,
    listener: (event: DriverEvent) => void,
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
      /** Exact table names, for an existing schema. */
      tables?: Partial<Record<"jobs" | "locks" | "kv" | "events", string>>;
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
      /** Exact collection names, for an existing database. */
      collections?: Partial<Record<"jobs" | "locks" | "kv" | "events", string>>;
    };

/** A schedule stored alongside a runner's state. */
export type StoredSchedule = RunnerSchedule;
