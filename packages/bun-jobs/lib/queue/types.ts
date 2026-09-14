import type { SerializedError } from "@kingsleyweb/bun-common";
import type {
  DriverConfig,
  JobsDriver,
  JobState,
  RepeatRecord,
  Retention,
} from "../drivers/index";
import type { DateParser } from "../shared/humanTime";
import type { Logger, LoggerLike } from "../shared/logger";
import type {
  BackoffStrategies,
  BackoffStrategy,
  JobBackoffOptions,
} from "./backoff";
import type { IsolationMode, IsolationOptions } from "./isolation";
import type { Job } from "./Job";

/**
 * The queue's public types.
 *
 * A job is a name, a payload and a set of options; everything else here
 * describes when it may run, how often it may be retried, and how long its
 * outcome is kept.
 */

/**
 * How a repeatable job repeats.
 *
 * ```ts
 * { every: 60_000 }
 * { every: "2 days" }                                     // or "every 2 days", "daily"
 * { every: "0 9 * * 1", tz: "Europe/London" }             // cron, by its shape
 * { every: "every 2 weeks starting 1st december 2026" }   // interval + start
 * { every: "every day from 1 dec 2026 until 31 dec 2026" }// interval + window
 * { every: "1 hour", startAt: "tomorrow at 9am" }
 * ```
 *
 * Words are read when the job is added, so "starting tomorrow" means tomorrow
 * from then. Reading dates needs the optional `chrono-node`; an interval alone
 * does not. A series is identified by its schedule and start, so a phrase that
 * names a relative start gives a new series each time it resolves differently;
 * give `key` when re-adding one must update it.
 */
export interface RepeatOptions {
  /** Cron expression, five- or six-field (seconds first). */
  cron?: string;
  /** IANA time zone the cron expression is read in. */
  tz?: string;
  /**
   * How often, as an alternative to `cron`: milliseconds, a duration
   * (`"2 days"`), a cron expression, or a phrase that may also name the start
   * and end (`"every 2 weeks starting 1st december 2026"`). Dates inside the
   * phrase fill `startAt`/`endAt` only when those are not given.
   */
  every?: number | string;
  /** Do not run before this instant — a `Date`, epoch milliseconds, or words. */
  startAt?: Date | number | string;
  /** Do not run after this instant — a `Date`, epoch milliseconds, or words. */
  endAt?: Date | number | string;
  /** Stop after this many occurrences. */
  limit?: number;
  /** Identifies the series. Defaults to one derived from the other options. */
  key?: string;
  /** Run once as soon as the series is created, then follow the schedule. */
  immediately?: boolean;
  /**
   * Run every occurrence that was missed while nothing was consuming, rather
   * than skipping to the next one. Defaults to `false`.
   */
  catchUp?: boolean;
}

/** Everything `add()` accepts about one job. */
export interface JobOptions {
  /**
   * Identifies the job, and doubles as its idempotency key: adding the same
   * id twice returns the existing job untouched. Defaults to a fresh id.
   */
  jobId?: string;
  /** Lower runs first; ties break FIFO. Defaults to `0`. */
  priority?: number;
  /** Milliseconds to wait before the job may run. */
  delay?: number;
  /** Absolute time the job may run. Wins over `delay`. */
  runAt?: Date | number;
  /** Total attempts, including the first. Defaults to `1`. */
  attempts?: number;
  /**
   * Delay between attempts: a number of milliseconds, or a schedule.
   * Defaults to exponential from 1s, capped at 5 minutes, with jitter.
   */
  backoff?: number | JobBackoffOptions;
  /** Per-attempt timeout in milliseconds. `0` (the default) means none. */
  timeout?: number;
  /**
   * How long a completed job is kept: `true` removes it immediately, `false`
   * keeps it forever, a number keeps that many, `{ count, ttl }` does both.
   * Defaults to a 24-hour TTL.
   */
  removeOnComplete?: Retention;
  /** The same, for a job that exhausted its attempts. Defaults to `false`. */
  removeOnFail?: Retention;
  /** How many stack traces a failing job keeps. Defaults to `5`. */
  keepStacktraces?: number;
  /**
   * A queue, in the same namespace, that receives a copy of this job when it
   * dies — as a {@link DeadLetter} carrying the original id, data and error.
   * Wins over the worker's `deadLetterQueue`. The dead job itself is kept or
   * removed by `removeOnFail` as usual.
   */
  deadLetter?: string;
  /**
   * Keeps one pending job per `id` instead of adding another each time.
   *
   * While a job added under this id has not started, a further add replaces
   * its data and pushes its run time back to `ttl` from now; once it has
   * started, the next add is a new job. The first add's other options stay.
   * `ttl` is milliseconds or a duration such as `"30 seconds"`. Not with
   * `repeat`, `jobId` or `throttle`.
   */
  debounce?: DebounceOptions;
  /**
   * Adds at most one job per `id` per `ttl`: an add inside the window adds
   * nothing and answers with the job that opened it. Not with `repeat`,
   * `jobId` or `debounce`.
   */
  throttle?: DebounceOptions;
  /**
   * How many log lines the job keeps, newest last; older lines are dropped.
   * `0` keeps every line. Defaults to `1000`.
   */
  keepLogs?: number;
  /** Makes this a repeatable job. */
  repeat?: RepeatOptions;
}

/** Which debounce or throttle a job belongs to, and for how long. */
export interface DebounceOptions {
  /** Jobs sharing this id are debounced or throttled together. */
  id: string;
  /** The window: milliseconds, or a duration such as `"30 seconds"`. */
  ttl: number | string;
}

/** What a worker calls for each job. */
export type JobProcessor<TData = unknown, TResult = unknown> = (
  job: Job<TData, TResult>,
  ctx: ProcessorContext,
) => TResult | Promise<TResult>;

/** The second argument a processor receives. */
export interface ProcessorContext {
  /**
   * Aborted when the attempt times out, the worker is closing, or the job's
   * lock is lost. Long work should check it.
   */
  signal: AbortSignal;
  /** Logger bound to this job's ids. */
  logger: Logger;
  /** The worker's id. */
  workerId: string;
  /** 1-based attempt number. */
  attempt: number;
  /**
   * Extends the job's lock now, rather than waiting for the next heartbeat.
   * For a step that will take longer than `lockDuration` on its own.
   */
  heartbeat: () => Promise<void>;
  /**
   * Appends a line to the job's log, which outlives this attempt — readable
   * with `job.getLogs()` or `queue.getJobLogs(id)` from anywhere. Answers with
   * how many lines the log keeps.
   */
  log: (line: string) => Promise<number>;
}

/** Options for a {@link BunQueue}. */
export interface BunQueueOptions {
  /**
   * The namespace this queue belongs to. Required: the same queue name in
   * two namespaces is two queues, which is what keeps services sharing a
   * backend from colliding.
   */
  namespace: string;
  /** Where jobs live. A config is built and closed here; an instance is shared. */
  driver?: JobsDriver | DriverConfig;
  /** Logger, or anything `resolveLogger` accepts. */
  logger?: LoggerLike;
  /** Defaults merged under every `add()`. */
  defaultJobOptions?: JobOptions;
  /**
   * Re-emit events from other processes, so a producer can watch jobs a
   * worker elsewhere is running. Off by default: it costs a subscription.
   */
  subscribe?: boolean;
  /**
   * Publish this queue's events for other processes to receive.
   *
   * Separate from {@link BunQueueOptions.subscribe}, which it used to be
   * folded into — publishing was gated on whether *this* instance also
   * listened. That is the wrong way round for the arrangement it matters most
   * in: a dashboard subscribes and never produces, while the producers it
   * wants to watch listen to nothing and therefore said nothing.
   *
   * Defaults to whatever `subscribe` is, so existing behaviour is unchanged;
   * set it explicitly to publish without listening. It is not on by default
   * because each event is a round trip, and on a busy queue that is a round
   * trip per job.
   */
  publish?: boolean;
  /**
   * Awaited before each event is published. `BunJobs` passes one so an event
   * published the moment a queue, worker or runner is created waits for the
   * notifiers it opened to finish subscribing, instead of being lost. Unset,
   * nothing is awaited.
   */
  publishGate?: () => Promise<void>;
  /**
   * Reads the dates in phrases — `on("2nd december 2026")`, `every("every 2
   * weeks from payday")`, `repeat: { startAt: "tomorrow at 9am" }`. Defaults
   * to `chrono-node`, loaded when a phrase first needs it.
   *
   * Give one to read dates `chrono-node` does not, or to avoid installing it.
   * Checked when the queue is built; see `DateParser` for the shape.
   */
  dateParser?: DateParser;
}

/** Options for a {@link BunQueueWorker}. */
export interface BunQueueWorkerOptions {
  /**
   * Publish this worker's job events for other processes to receive.
   *
   * Off by default, and worth turning on for the case it exists for: the
   * worker is the only thing that knows a job became active, reported
   * progress, completed, failed or stalled, so without this a producer or a
   * dashboard elsewhere can only observe what it did itself.
   *
   * Each event is a round trip. On a queue draining thousands of jobs a second
   * that is the dominant cost of turning it on, which is why it is a choice.
   */
  publish?: boolean;
  /**
   * Awaited before each event is published. `BunJobs` passes one so an event
   * published the moment a queue, worker or runner is created waits for the
   * notifiers it opened to finish subscribing, instead of being lost. Unset,
   * nothing is awaited.
   */
  publishGate?: () => Promise<void>;
  /** The namespace to consume from. Must match the producer's. */
  namespace: string;
  /** Where jobs live. A config is built and closed here; an instance is shared. */
  driver?: JobsDriver | DriverConfig;
  /** Logger, or anything `resolveLogger` accepts. */
  logger?: LoggerLike;
  /** Identifies this worker in job records and logs. Defaults to a fresh id. */
  id?: string;
  /** How many jobs to process at once. Defaults to `1`. */
  concurrency?: number;
  /** How long a claim's lock lives. Defaults to 30000. */
  lockDuration?: number;
  /** How often to renew it. Defaults to a third of `lockDuration`. */
  heartbeatInterval?: number;
  /** How often to sweep for jobs whose worker died. Defaults to 30000. */
  stalledInterval?: number;
  /** How many times a job may stall before it is buried. Defaults to `1`. */
  maxStalledCount?: number;
  /** How long to wait between claim attempts. Defaults to 1000. */
  pollInterval?: number;
  /** Longest to block waiting for work on a blocking driver. Defaults to 5000. */
  maxBlock?: number;
  /**
   * Also promote delayed jobs, recover stalled ones, prune expired results
   * and heal repeat series. Every worker does this by default: each
   * operation is idempotent, so no leader election is needed and no single
   * process is load-bearing.
   */
  maintenance?: boolean;
  /** Start consuming as soon as it is constructed. Defaults to `false`. */
  autorun?: boolean;
  /** Milliseconds of quiet before `drained` is emitted. Defaults to 0. */
  drainDelay?: number;
  /**
   * Where a processor *file* runs each attempt:
   *
   * - `"in-process"` (the default) imports it once and calls it on the
   *   worker's thread, exactly like a function processor.
   * - `"worker"` runs each attempt in a fresh `Worker`: a separate JavaScript
   *   context that can be terminated, in the same process.
   * - `"spawn"` runs each attempt in a child process: the only mode where a
   *   processor that ignores its signal can be killed for certain.
   *
   * Only for a processor given as a file path or URL. The file default-exports
   * the same `(job, ctx) => result` a function processor is; `defineProcessor`
   * types it. In a child, `job.log`, `job.updateProgress`, `job.touch` and
   * `ctx.heartbeat` work through the worker; operations that change the
   * stored job directly are unavailable.
   */
  isolation?: IsolationMode;
  /** Timeouts and executor options for isolated processors. */
  isolationOptions?: IsolationOptions;
  /**
   * Named backoff strategies, for jobs whose `backoff.type` names one.
   *
   * Resolved here, on the worker, because a job's options are stored and a
   * function cannot be. A job naming a strategy this worker was not given
   * falls back to the default backoff and logs a warning rather than losing
   * its remaining attempts. A worker from `BunJobs` is given the strategies
   * registered with `defineBackoff`.
   */
  backoffStrategies?: BackoffStrategies | Record<string, BackoffStrategy>;
  /**
   * The dead-letter queue for jobs that do not name their own `deadLetter`.
   * Unset by default: a dead job stays where it died.
   */
  deadLetterQueue?: string;
  /**
   * How long the queue's stored limits are trusted before a worker reads them
   * again, in milliseconds. A change made with `queue.setLimits()` reaches
   * every worker within this. Defaults to `1000`.
   */
  limitsRefreshInterval?: number;
  /**
   * Whether a running worker keeps the process alive while it waits for work.
   * Defaults to `true`, as `BunRunner`'s option of the same name does.
   *
   * Every wait the worker makes is unref'd, so that it never holds up a
   * process that has other reasons to exit. Without this, a process whose
   * only work *is* a worker — a worker service — would exit the moment its
   * queue went idle. Set `false` for a script that runs a worker alongside
   * work of its own and should exit when that work is done.
   */
  waitToExit?: boolean;
}

/**
 * What a dead-letter queue receives: the job that died, as it was.
 *
 * Added under the original job's name, so a worker on the dead-letter queue
 * can dispatch on it exactly as the original worker did, and with an id
 * derived from the original's, so a failure noticed twice files one letter.
 */
export interface DeadLetter<TData = unknown> {
  /** The queue the job died in. */
  queue: string;
  /** Its id there. */
  id: string;
  /** Its name. */
  name: string;
  /** What it carried. */
  data: TData;
  /** The failure that killed it. */
  failedReason: SerializedError;
  /** How many attempts it had made. */
  attemptsMade: number;
  /** When it died, in epoch milliseconds. */
  diedAt: number;
}

/** Which finished jobs {@link BunQueue.retryAll} returns to the queue. */
export interface RetryAllOptions<TData = unknown, TResult = unknown> {
  /** Only jobs with this name. */
  name?: string;
  /**
   * Only jobs whose last failure matches: a substring of, or a pattern tested
   * against, `"<error name>: <message>"`. A job with no failure never matches,
   * so this selects nothing among completed jobs.
   */
  reason?: string | RegExp;
  /** Only jobs this returns `true` for. Applied after `name` and `reason`. */
  filter?: (job: Job<TData, TResult>) => boolean;
  /** Stop after this many. Defaults to every match. */
  limit?: number;
  /** Start their attempts again from zero. Defaults to `true`, as `retry()` does. */
  resetAttempts?: boolean;
}

/**
 * The events that are about one job, and so can be scoped to its name.
 *
 * Everything else is about the queue — it was paused, it was drained — or
 * about an id with no name to hand: `removed` and `promoted` carry an id, and
 * `stalled` carries several. Scoping those would mean fetching a record to
 * work out an event name, which is the wrong way round.
 */
export type JobScopedEvent =
  | "added"
  | "duplicate"
  | "waiting"
  | "delayed"
  | "active"
  | "progress"
  | "completed"
  | "failed"
  | "retrying"
  | "dead"
  | "deadLettered"
  | "debounced"
  | "throttled";

/**
 * The same job events, qualified by the job's name.
 *
 * `queue.on("completed:sendEmail", ...)` fires only for jobs named
 * `sendEmail`, with exactly the arguments `completed` takes. A consumer that
 * runs twenty kinds of job through one queue would otherwise filter by name in
 * every listener, which is both noisier and slower — every listener runs for
 * every job.
 *
 * The unqualified event still fires as well, so a listener that wants all of
 * them is unaffected.
 */
export type JobScopedEvents<TEvents, TName extends string = string> = {
  [Event in keyof TEvents &
    JobScopedEvent as `${Event}:${TName}`]: TEvents[Event];
};

/** Events a {@link BunQueue} emits. */
// eslint-disable-next-line ts/consistent-type-definitions
type BunQueueBaseEvents<TData = unknown, TResult = unknown> = {
  /** A job was added. */
  added: (job: Job<TData, TResult>) => void;
  /** An `add()` matched an existing id, so nothing was added. */
  duplicate: (job: Job<TData, TResult>) => void;
  /** A job became claimable. */
  waiting: (job: Job<TData, TResult>) => void;
  /** A job was added for later. */
  delayed: (job: Job<TData, TResult>, runAt: number) => void;
  /** A worker claimed a job. */
  active: (job: Job<TData, TResult>) => void;
  /** A job reported progress. */
  progress: (job: Job<TData, TResult>, value: unknown) => void;
  /** A job completed. */
  completed: (job: Job<TData, TResult>, result: TResult) => void;
  /** An attempt failed. */
  failed: (job: Job<TData, TResult>, error: Error) => void;
  /** An attempt failed and another is due. */
  retrying: (job: Job<TData, TResult>, error: Error, runAt: number) => void;
  /** A job exhausted its attempts, or failed unrecoverably. */
  dead: (job: Job<TData, TResult>, error: Error) => void;
  /**
   * Jobs were recovered from workers that died holding them.
   *
   * A batch, matching `BunQueueWorkerEvents.stalled` and the wire. It used to
   * be `(jobId: string)` here and `(ids: string[])` there, for one event that
   * only ever has one source — so a listener saw a different shape depending
   * on which object it attached to, and the cross-process path could not have
   * satisfied both.
   */
  stalled: (ids: string[]) => void;
  /** A job was removed. */
  removed: (jobId: string) => void;
  /** A job was made claimable early. */
  promoted: (jobId: string) => void;
  /** The queue was paused. */
  paused: () => void;
  /** The queue was resumed. */
  resumed: () => void;
  /** Pending jobs were dropped. */
  drained: (count: number) => void;
  /** Finished jobs were removed. */
  cleaned: (ids: string[], state: JobState) => void;
  /** Finished jobs were returned to the queue together, by `retryJobs` or `retryAll`. */
  retried: (ids: string[]) => void;
  /**
   * An add found a pending job with the same debounce id, replaced its data
   * and pushed its run time back, rather than adding another.
   */
  debounced: (job: Job<TData, TResult>) => void;
  /** An add fell inside a throttle window; `job` is the one that opened it. */
  throttled: (job: Job<TData, TResult>) => void;
  /** A repeat series scheduled its next occurrence. */
  repeatScheduled: (key: string, nextRunAt: number) => void;
  /** Something failed outside a job. */
  error: (error: Error, context: string) => void;
};

/**
 * Everything a {@link BunQueue} emits: each event, and the same
 * events qualified by a job's name.
 */
export type BunQueueEvents<
  TData = unknown,
  TResult = unknown,
> = BunQueueBaseEvents<TData, TResult> &
  JobScopedEvents<BunQueueBaseEvents<TData, TResult>>;

/** Events a {@link BunQueueWorker} emits. */
// eslint-disable-next-line ts/consistent-type-definitions
type BunQueueWorkerBaseEvents<TData = unknown, TResult = unknown> = {
  /** The worker connected and started consuming. */
  ready: () => void;
  /** A job was claimed. */
  active: (job: Job<TData, TResult>) => void;
  /** A job reported progress. */
  progress: (job: Job<TData, TResult>, value: unknown) => void;
  /** A job completed. */
  completed: (job: Job<TData, TResult>, result: TResult) => void;
  /** An attempt failed. */
  failed: (job: Job<TData, TResult>, error: Error) => void;
  /** An attempt failed and another is due. */
  retrying: (job: Job<TData, TResult>, error: Error, runAt: number) => void;
  /** A job exhausted its attempts. */
  dead: (job: Job<TData, TResult>, error: Error) => void;
  /** A dead job was copied to its dead-letter queue, as `letter`. */
  deadLettered: (
    job: Job<TData, TResult>,
    letter: Job<DeadLetter<TData>, unknown>,
  ) => void;
  /** Jobs were recovered from workers that died holding them. */
  stalled: (ids: string[]) => void;
  /** A job's lock was lost mid-attempt. */
  lockLost: (job: Job<TData, TResult>) => void;
  /** There was nothing left to claim. */
  drained: () => void;
  /** The worker stopped claiming. */
  paused: () => void;
  /** The worker resumed claiming. */
  resumed: () => void;
  /** The worker began shutting down. */
  closing: () => void;
  /** The worker finished shutting down. */
  closed: () => void;
  /** Something failed outside a job. */
  error: (error: Error, context: string) => void;
};

/**
 * Everything a {@link BunQueueWorker} emits: each event, and the same
 * events qualified by a job's name.
 */
export type BunQueueWorkerEvents<
  TData = unknown,
  TResult = unknown,
> = BunQueueWorkerBaseEvents<TData, TResult> &
  JobScopedEvents<BunQueueWorkerBaseEvents<TData, TResult>>;

/** A repeat definition as reported by `listRepeatables()`. */
export type Repeatable = RepeatRecord;
