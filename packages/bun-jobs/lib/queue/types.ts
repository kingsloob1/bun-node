import type { BackoffOptions } from "@kingsleyweb/bun-common";
import type {
  DriverConfig,
  ExecutionMode,
  JobsDriver,
  JobState,
  RepeatRecord,
  Retention,
} from "../drivers/index";
import type { Logger, LoggerLike } from "../shared/logger";
import type { Job } from "./Job";

/**
 * The queue's public types.
 *
 * A job is a name, a payload and a set of options; everything else here
 * describes when it may run, how often it may be retried, and how long its
 * outcome is kept.
 */

/** How a repeatable job repeats. */
export interface RepeatOptions {
  /** Cron expression, five- or six-field (seconds first). */
  cron?: string;
  /** IANA time zone the cron expression is read in. */
  tz?: string;
  /** Interval in milliseconds, as an alternative to `cron`. */
  every?: number;
  /** Do not run before this instant. */
  startAt?: Date | number;
  /** Do not run after this instant. */
  endAt?: Date | number;
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
  backoff?: number | BackoffOptions;
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
  /** Makes this a repeatable job. */
  repeat?: RepeatOptions;
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
   * Where a file-path processor runs. Only meaningful when the processor is
   * a path: the job then runs through the runner's executors, one child per
   * job. Defaults to `"in-process"`.
   */
  isolation?: ExecutionMode;
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
  | "dead";

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
