import type { LogLevel } from "@kingsleyweb/bun-common";
import type {
  DriverConfig,
  ExecutionMode,
  JobsDriver,
  RunRecord,
  RunSource,
  RunStatus,
} from "../drivers/index";
import type { LogFields, Logger, LoggerLike } from "../shared/logger";
import type { RunProgress } from "../shared/progress";
import type { RunnerSchedule, ScheduleInput } from "../shared/schedule";

/**
 * The runner's public types: what a handler receives, what a trigger
 * reports, and what a runner tells you about itself.
 *
 * Every type parameter defaults to `unknown`: a runner that declares nothing
 * accepts and reports anything, exactly as before the parameters existed.
 */

// Defined in `shared`, so a job's progress can name the same type.
export type { RunProgress };

/** What a runner's file must default-export. */
export type RunnerHandler<
  TArgs = unknown,
  TResult = unknown,
  TToHandler = unknown,
  TFromHandler = unknown,
> = (
  ctx: RunContext<TArgs, TToHandler, TFromHandler>,
) => TResult | Promise<TResult>;

/**
 * Identity function that types a handler at its definition site, so a file's
 * default export is checked where it is written rather than where it is run.
 *
 * ```ts
 * export default defineHandler<{ since: string }, number>(async (ctx) => {
 *   ctx.logger.info("cleaning", { since: ctx.args.since });
 *   return 42;
 * });
 * ```
 */
export function defineHandler<
  TArgs = unknown,
  TResult = unknown,
  TToHandler = unknown,
  TFromHandler = unknown,
>(
  handler: RunnerHandler<TArgs, TResult, TToHandler, TFromHandler>,
): RunnerHandler<TArgs, TResult, TToHandler, TFromHandler> {
  return handler;
}

/**
 * What a handler is given when it runs.
 *
 * `TToHandler` is what `runner.send()` delivers to `ctx.onMessage` listeners;
 * `TFromHandler` is what `ctx.send()` delivers to the runner's `message` event.
 * Messages cross a process boundary as JSON in `spawn` and `worker` mode, so
 * declare shapes that survive it.
 */
export interface RunContext<
  TArgs = unknown,
  TToHandler = unknown,
  TFromHandler = unknown,
> {
  /** Identifies this run. */
  runId: string;
  /** The runner that started it. */
  runnerId: string;
  /** The runner's display name. */
  runnerName: string;
  /** The namespace the runner belongs to. */
  namespace: string;
  /** 1-based attempt number. */
  attempt: number;
  /** What asked for the run. */
  source: RunSource;
  /** Where the run is executing. */
  mode: ExecutionMode;
  /** When the run started, in epoch milliseconds. */
  startedAt: number;
  /** When the run will be aborted, or `null` when it has no timeout. */
  deadline: number | null;
  /** Arguments for this run: the trigger's, else the runner's defaults. */
  args: TArgs;
  /**
   * Aborted when the run is stopped, killed or times out. Long work should
   * check it — an in-process run cannot be killed any other way.
   */
  signal: AbortSignal;
  /** Logger bound to this run's ids. */
  logger: Logger;
  /** Reports progress; surfaces as the runner's `progress` event. */
  progress: (value: RunProgress) => void;
  /** Sends a message to the parent; surfaces as the `message` event. */
  send: (message: TFromHandler) => void;
  /** Listens for messages sent with `runner.send()`. Returns an unsubscribe. */
  onMessage: (listener: (message: TToHandler) => void) => () => void;
  /**
   * How to build a driver for the runner's backend. Present whenever the
   * runner was given one, and the only form a spawned child can receive.
   */
  driverConfig?: DriverConfig;
  /**
   * The runner's own driver instance. Only in `in-process` mode — an
   * instance cannot cross a process boundary.
   */
  driver?: JobsDriver;
}

/** What a trigger did. */
export type TriggerOutcome =
  | { outcome: "started"; runId: string }
  | { outcome: "queued"; position: number }
  | {
      outcome: "skipped";
      reason:
        | "paused"
        | "busy"
        | "lock-held"
        | "max-concurrency"
        | "queue-full"
        | "stopped";
    };

/** A runner's lifetime counters. */
export interface RunnerStats {
  /** Runs that finished successfully. */
  success: number;
  /** Runs that failed, including timeouts and kills. */
  failed: number;
  /** Runs that outlived their timeout. */
  timeout: number;
  /** Runs that were killed. */
  killed: number;
  /** Triggers that never became runs. */
  skipped: number;
  /** Triggers that were queued for later. */
  queued: number;
  /** Runs started in total. */
  total: number;
}

/** A snapshot of a runner, local state merged with what the driver knows. */
export interface RunnerInfo {
  /** The runner's id. */
  id: string;
  /** Its display name. */
  name: string;
  /** The namespace it belongs to. */
  namespace: string;
  /** The handler file it runs. */
  file: string;
  /** Its schedule, normalised. */
  schedule: RunnerSchedule;
  /** When it next fires locally, or `null`. */
  nextRunAt: Date | null;
  /** Where its runs execute. */
  executionMode: ExecutionMode;
  /** Whether runs may overlap. */
  runMode: "parallel" | "single";
  /** Whether triggers are queued when a run is already in flight. */
  queueRuns: boolean;
  /** Concurrency cap in `parallel` mode. */
  maxConcurrency: number;
  /** This instance's status. */
  status: RunnerStatus;
  /** Whether it is paused — a persisted flag, shared across processes. */
  isPaused: boolean;
  /** Whether *any* process is running it, from the lock. */
  isRunning: boolean;
  /**
   * Who is running it, when the lock says so: the lock holder's host and pid,
   * the run it started most recently — the one in flight — and since when.
   */
  runningOn?: { host: string; pid: number; runId: string; since: number };
  /** Runs in flight in this process. */
  activeRuns: RunRecord[];
  /** Triggers waiting for the lock holder to drain them. */
  queuedTriggers: number;
  /** Lifetime counters. */
  stats: RunnerStats;
  /** The most recent run. */
  lastRun?: RunRecord;
  /** The most recent failure. */
  lastError?: { name: string; message: string };
}

/** What a runner instance is doing. */
export type RunnerStatus = "idle" | "running" | "paused" | "stopped";

/** A run in flight in this process. */
export interface RunHandle {
  /** The run's record, updated as it progresses. */
  record: RunRecord;
  /** Aborts the run; `force` skips to the end of the kill escalation. */
  abort: (reason: string, options?: { force?: boolean }) => void;
  /**
   * Sends a message to the running handler. `unknown` on purpose: this is the
   * transport-level handle, like `ExecutorHandle`. `BunRunner.send()` is the
   * typed entry point. A generic parameter here would make every `BunRunner`
   * invariant in its message type, so typed runners could no longer share a
   * registry such as `BunRunnerManager`.
   */
  send: (message: unknown) => boolean;
  /** Resolves when the run settles. */
  done: Promise<RunStatus>;
}

/** Options accepted by {@link BunRunnerOptions.spawn}. */
export interface SpawnOptions {
  /** Working directory for the child. Defaults to the parent's. */
  cwd?: string;
  /** Extra environment variables for the child. */
  env?: Record<string, string>;
  /** Extra arguments appended to the child's command line. */
  args?: string[];
  /** Executable to run. Defaults to the current `bun` binary. */
  execPath?: string;
  /** Where the child's stdout goes. Defaults to `"inherit"`. */
  stdout?: "inherit" | "pipe" | "ignore";
  /** Where the child's stderr goes. Defaults to `"inherit"`. */
  stderr?: "inherit" | "pipe" | "ignore";
  /** How long the child has to report readiness before the run fails. */
  startTimeout?: number;
}

/** Options accepted by {@link BunRunnerOptions.worker}. */
export interface WorkerOptions {
  /** Runs the worker in low-memory mode. */
  smol?: boolean;
  /** Name shown in diagnostics. */
  name?: string;
  /** Extra environment variables for the worker. */
  env?: Record<string, string>;
  /** Arguments exposed to the worker as `process.argv`. */
  argv?: string[];
}

/** Options accepted by {@link BunRunnerOptions.inProcess}. */
export interface InProcessOptions {
  /**
   * Re-imports the handler file on every run by appending a cache-busting
   * query. Useful in development; it leaks one module instance per run.
   */
  reloadOnEachRun?: boolean;
}

/** Everything a {@link BunRunner} accepts. */
export interface BunRunnerOptions<TArgs = unknown> {
  /** Identifies the runner within its namespace. Keys derive from it. */
  id: string;
  /**
   * The namespace this runner belongs to. Required: two services sharing a
   * backend rely on it to keep identically-named runners apart.
   */
  namespace: string;
  /** Display name. Defaults to `id`. */
  name?: string;
  /** The handler file. Resolved once, relative to `spawn.cwd` or the cwd. */
  file: string | URL;
  /**
   * When to run: a cron expression (five- or six-field), an interval in
   * milliseconds, a `Date`, or one of the schedule objects. Omit for a runner
   * driven only by `trigger()`.
   */
  schedule?: ScheduleInput;
  /** Where runs execute. Defaults to `"spawn"`. */
  executionMode?: ExecutionMode;
  /**
   * `"single"` (the default) holds a cluster-wide lock so only one run
   * happens at a time anywhere; `"parallel"` lets runs overlap, bounded by
   * `maxConcurrency`, with no lock at all.
   */
  runMode?: "parallel" | "single";
  /** Queue a trigger that cannot start now instead of dropping it. */
  queueRuns?: boolean;
  /** How many triggers may be queued. Defaults to 100. */
  maxQueuedRuns?: number;
  /** Concurrency cap in `parallel` mode. Defaults to unlimited. */
  maxConcurrency?: number;
  /** Per-run timeout in milliseconds. `0` (the default) means none. */
  timeout?: number;
  /** Grace after asking a run to stop, before `SIGTERM`. Defaults to 5000. */
  closeTimeout?: number;
  /** Grace after `SIGTERM`, before `SIGKILL`. Defaults to 2000. */
  killTimeout?: number;
  /**
   * Keep the process alive for the schedule. `false` unrefs every timer and
   * child, so a process with nothing else to do exits. Defaults to `true`.
   */
  waitToExit?: boolean;
  /** How long the single-run lock lives. Defaults to 30000. */
  lockTtl?: number;
  /** How often the lock is renewed. Defaults to a third of `lockTtl`. */
  heartbeatInterval?: number;
  /** What to do when the lock is lost mid-run. Defaults to `"abort"`. */
  onLockLost?: "abort" | "continue";
  /** How many run records to keep. Defaults to 50. */
  keepHistory?: number;
  /** Cap on a stored run result, in bytes. Defaults to 16384. */
  maxResultBytes?: number;
  /**
   * Where state lives. A config is built here and closed with the runner; an
   * instance is shared and never closed by the runner. Defaults to memory,
   * which cannot coordinate across processes.
   */
  driver?: JobsDriver | DriverConfig;
  /**
   * Driver config handed to handlers as `ctx.driverConfig`, so a spawned or
   * worker run can reach the same backend. Defaults to `driver` when that was
   * given as a config.
   */
  childDriver?: DriverConfig;
  /** Logger, or anything `resolveLogger` accepts. */
  logger?: LoggerLike;
  /** Default arguments for scheduled runs. */
  args?: TArgs;
  /** Start the runner as soon as it is constructed. Defaults to `false`. */
  autostart?: boolean;
  /** Start paused, so nothing fires until `resume()`. */
  startPaused?: boolean;
  /** How often to re-read the paused flag and schedule. Defaults to 30000. */
  syncInterval?: number;
  /** Forward a child's `ctx.logger` calls to the parent's `log` event. */
  forwardLogs?: boolean;
  /**
   * Whether this runner publishes its events — started, succeeded, failed,
   * timeout, killed, queued, skipped — for listeners in other processes, such
   * as a `JobsNotifier` behind a dashboard. Defaults to `false`: publishing
   * costs a write per event on backends that store events.
   */
  publish?: boolean;
  /**
   * Awaited before each event is published. `BunJobs` passes one so an event
   * published the moment a queue, worker or runner is created waits for the
   * notifiers it opened to finish subscribing, instead of being lost. Unset,
   * nothing is awaited.
   */
  publishGate?: () => Promise<void>;
  /** Child-process options, for `executionMode: "spawn"`. */
  spawn?: SpawnOptions;
  /** Worker options, for `executionMode: "worker"`. */
  worker?: WorkerOptions;
  /** In-process options, for `executionMode: "in-process"`. */
  inProcess?: InProcessOptions;
}

/** A runner's options with every default applied. */
export interface ResolvedRunnerOptions<TArgs = unknown> extends Required<
  Pick<
    BunRunnerOptions<TArgs>,
    | "id"
    | "namespace"
    | "name"
    | "executionMode"
    | "runMode"
    | "queueRuns"
    | "maxQueuedRuns"
    | "maxConcurrency"
    | "timeout"
    | "closeTimeout"
    | "killTimeout"
    | "waitToExit"
    | "lockTtl"
    | "heartbeatInterval"
    | "onLockLost"
    | "keepHistory"
    | "maxResultBytes"
    | "autostart"
    | "startPaused"
    | "syncInterval"
    | "forwardLogs"
    | "publish"
  >
> {
  /** The resolved absolute path (or URL string) of the handler file. */
  file: string;
  /** The normalised schedule. */
  schedule: RunnerSchedule;
  /** Default arguments for scheduled runs. */
  args?: TArgs;
  /** Driver config for children, when one is available. */
  childDriver?: DriverConfig;
  /** Child-process options with defaults applied. */
  spawn: Required<Pick<SpawnOptions, "stdout" | "stderr" | "startTimeout">> &
    SpawnOptions;
  /** Worker options. */
  worker: WorkerOptions;
  /** In-process options. */
  inProcess: InProcessOptions;
}

/**
 * Events a {@link BunRunner} emits. A `type`, not an `interface`: interfaces
 * are open to augmentation and so lack the implicit index signature
 * `TypedEmitterBase`'s `Record<string, …>` constraint needs.
 */
// eslint-disable-next-line ts/consistent-type-definitions
export type BunRunnerEvents<
  TArgs = unknown,
  TResult = unknown,
  TFromHandler = unknown,
> = {
  /** The next fire time changed. */
  scheduled: (next: Date | null) => void;
  /** A run started. */
  started: (run: RunRecord) => void;
  /** A run reported progress. */
  progress: (run: RunRecord, value: RunProgress) => void;
  /** A run sent a message with `ctx.send()`. */
  message: (run: RunRecord, data: TFromHandler) => void;
  /** A run logged something, when `forwardLogs` is on. */
  log: (
    run: RunRecord,
    level: LogLevel,
    message: string,
    fields: LogFields,
  ) => void;
  /** A child wrote to stdout or stderr, when it is piped. */
  output: (run: RunRecord, stream: "stdout" | "stderr", chunk: string) => void;
  /** A run finished successfully. */
  finished: (run: RunRecord, result: TResult) => void;
  /** A run failed. */
  failed: (run: RunRecord, error: Error) => void;
  /** A run outlived its timeout. */
  timeout: (run: RunRecord) => void;
  /** A run was killed. */
  killed: (run: RunRecord, reason: string) => void;
  /** A trigger did not become a run. */
  skipped: (outcome: TriggerOutcome & { outcome: "skipped" }) => void;
  /** A trigger was queued. */
  queued: (trigger: { id: string; args?: TArgs }) => void;
  /** A queued trigger was taken off the queue to run. */
  dequeued: (trigger: { id: string; args?: TArgs }) => void;
  /** The single-run lock was lost mid-run. */
  lockLost: (run: RunRecord) => void;
  /** The runner was paused. */
  paused: () => void;
  /** The runner was resumed. */
  resumed: () => void;
  /** The runner stopped. */
  stopped: () => void;
  /** Something failed outside a run (a tick, a driver read). */
  error: (error: Error, context: string) => void;
};
