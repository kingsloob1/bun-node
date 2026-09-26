import type { LogLevel } from "@kingsleyweb/bun-common";
import type {
  DriverConfig,
  ExecutionMode,
  JobsDriver,
  MetricsOptions,
  ResolvedMetricsOptions,
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

/** What {@link RunContext.log} may say about a line beyond its message. */
export interface RunLogOptions {
  /**
   * The level to store the line with, shown by a reader that colours by
   * level. Omitted, the line is stored without one — which is how a `stdout`
   * or `stderr` line is stored too, since those have no level.
   */
  level?: LogLevel;
  /**
   * Structured fields, rendered onto the end of the line as `key=value` pairs
   * in the order given. A value with whitespace, a quote or an `=` is
   * JSON-quoted; anything that is not a string is JSON. They are rendered
   * rather than stored apart because a run log is a log, not a table: one
   * text column is what every backend holds and what a reader greps.
   */
  fields?: LogFields;
}

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
 * Messages cross a process boundary as JSON in `child-process` and `worker-thread` mode, so
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
  /**
   * Writes one line to this run's captured log — the `log` stream, beside the
   * `stdout` and `stderr` lines a spawned run's pipes produce.
   *
   * **Fire and forget.** It returns `void`, never throws and is never awaited:
   * a store that is down, a run past its capture ceiling or a driver that
   * cannot hold run logs at all each drop the line quietly. Nothing a handler
   * writes here can fail its run, which is the whole reason it is not a
   * promise.
   *
   * The message and its fields are rendered to one line of text at capture
   * (`message key=value …`); `options.level` is stored alongside it. In
   * `child-process` and `worker-thread` mode the call crosses the existing IPC `log` channel,
   * so it also surfaces as the runner's `log` event — whether or not
   * `forwardLogs` is on.
   *
   * ```ts
   * ctx.log("rebuilding the index", { level: "info", fields: { shard } });
   * ```
   */
  log: (message: string, options?: RunLogOptions) => void;
  /**
   * Resolves once this run's buffered log lines have reached the store.
   *
   * Rarely needed: capture flushes on its own thresholds and again when the
   * run settles. It is here for a handler that wants its last words stored
   * before it does something drastic — `process.exit`, a deliberate crash.
   *
   * **What it waits for depends on the mode.** In `in-process` mode it awaits
   * the append itself. In `child-process` and `worker-thread` mode the lines are stored by
   * the *parent*, so it resolves once they are on the ordered IPC channel: the
   * parent has them before the run's outcome reaches it, and the flush at
   * settle stores them. It never rejects, in any mode.
   */
  flushLogs: () => Promise<void>;
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
  /** Concurrency cap in `parallel` mode; `Infinity` when unlimited. */
  maxConcurrency: number;
  /**
   * The three fields above with their code/override split: what the owner's
   * options asked for, what a remote override replaced, and whether this
   * instance adopted it.
   */
  config: RunnerConfigInfo;
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

/**
 * One runner setting a remote override may replace. Restated from the
 * contract's `RUNNER_CONFIG_KEYS` so the runtime does not depend on the API
 * layer for a union; `__tests__/runner-config.type-test.ts` pins the two
 * together.
 */
export type RunnerConfigKey = "executionMode" | "runMode" | "maxConcurrency";

/** A runner's executor and overlap settings, as one set of values. */
export interface RunnerConfigValues {
  /** Where a run executes. */
  executionMode: ExecutionMode;
  /** Whether runs may overlap. */
  runMode: "parallel" | "single";
  /**
   * Most concurrent runs in `parallel`, or `null` for unlimited — which is
   * `Number.POSITIVE_INFINITY` in `BunRunnerOptions.maxConcurrency`, a value
   * no override can carry over JSON. Meaningless in `single`.
   */
  maxConcurrency: number | null;
}

/**
 * A merge patch for a runner's remote configuration: a field left out is
 * untouched, and `null` clears that override so the runner goes back to what
 * its own code asked for.
 */
export interface RunnerConfigPatch {
  /**
   * Where runs execute, from the *next* run on: a run already in flight keeps
   * the mode it started with. Refused when the owner's `allowedOverrides`
   * does not permit it.
   */
  executionMode?: ExecutionMode | null;
  /**
   * The overlap policy. `maxConcurrency` only means anything in `parallel`,
   * so the two are written together and `null` clears both.
   *
   * `parallel` → `single` is not immediate across processes: a parallel run
   * holds no lock, so an owner that has adopted `single` can start while
   * another process's parallel run is still going. Pause the runner first
   * when exclusivity matters.
   */
  concurrency?:
    | {
        /** One run at a time, cluster-wide, held by the runner's lock. */
        runMode: "single";
      }
    | {
        /** Runs may overlap. */
        runMode: "parallel";
        /** Most concurrent runs (1 … 1000), or `null` for unlimited. Lowering it never kills a run in flight. */
        maxConcurrency: number | null;
      }
    | null;
}

/**
 * A runner's configuration: what it runs with, what its code asked for, and
 * whether an owner has adopted the stored override yet.
 */
export interface RunnerConfigInfo {
  /** In force now — what the owner adopted, not necessarily what is stored. */
  effective: RunnerConfigValues;
  /** What the owner's own options asked for; absent until an owner has started since remote configuration shipped. */
  code?: RunnerConfigValues;
  /**
   * Which settings an override is **stored** for, in
   * `executionMode, runMode, maxConcurrency` order. An override an owner
   * refused is still listed — {@link RunnerConfigInfo.error} says why.
   */
  overridden: RunnerConfigKey[];
  /** The execution modes the owner's code permits (its `allowedOverrides.executionModes`). */
  allowed?: ExecutionMode[];
  /** The override's version; `0` when nothing is stored. */
  seq: number;
  /** The version an owner has adopted; below `seq` means it has not been picked up yet. */
  appliedSeq?: number;
  /** Why an owner refused part of the override; absent when the last one was adopted whole. */
  error?: {
    /** When it was refused, epoch ms. */
    at: number;
    /** A safe message naming each refused setting. */
    message: string;
    /**
     * The settings the owner refused, in `executionMode, runMode,
     * maxConcurrency` order; every other overridden setting was adopted. A
     * whole-override refusal names every overridden key; `[]` on an error an
     * owner stored before this field existed.
     */
    keys: RunnerConfigKey[];
  };
  /** When the override was last written, epoch ms; absent when there is none. */
  updatedAt?: number;
}

/** What a remote controller may change about a runner. */
export interface RunnerAllowedOverrides {
  /**
   * The execution modes an override may choose. Defaults to all three, so a
   * code author forbids `in-process` on a shared API process by listing only
   * the other two. Persisted as the runner's `config:allowed`, so a
   * controller in another process can refuse before writing.
   */
  executionModes?: ExecutionMode[];
}

/**
 * What `maxResultBytes` stores in place of a result too large to keep: the
 * size it would have been and the start of its JSON.
 */
export interface TruncatedRunResult {
  /** Always `true`: marks the value as a stand-in. */
  __truncated: true;
  /** The size of the result's JSON, in bytes. */
  bytes: number;
  /** The start of the result's JSON. */
  preview: string;
}

/**
 * A run record as a {@link RunnerController} reads it: `result` typed as the
 * runner's result — or the marker stored when it was too large to keep.
 */
export type TypedRunRecord<TResult = unknown> = Omit<RunRecord, "result"> & {
  /** The handler's return value, or the marker `maxResultBytes` left in its place. */
  result?: TResult | TruncatedRunResult;
};

/**
 * A page of run history as a {@link RunnerController} reads it: the records typed
 * as {@link TypedRunRecord}, beside the whole history's size.
 */
export interface TypedRunHistoryPage<TResult = unknown> {
  /** The page's records, in the order asked for. */
  records: TypedRunRecord<TResult>[];
  /** How many records the history holds in total, not just on this page. */
  total: number;
  /**
   * Where the page's first record sits in the ordered history: the `offset`
   * asked for, or, when a `RunHistoryQuery.after` cursor was given, the
   * position the seek resolved to.
   */
  offset?: number;
}

/**
 * A snapshot of a runner assembled from what the backend holds, so it reads
 * the same from any process sharing the driver and namespace.
 *
 * The configuration fields are what the owning process persisted when it
 * started; a runner last started by a version that did not persist them
 * reports them as `undefined`.
 */
export interface SharedRunnerInfo<TResult = unknown> {
  /** The runner's id. */
  id: string;
  /** The namespace it belongs to. */
  namespace: string;
  /** Whether the controller delegates to a runner registered in this process. */
  isLocal: boolean;
  /** Its display name; the id when none was persisted. */
  name: string;
  /** The handler file, as its owner resolved it. */
  file?: string;
  /** Its schedule, normalised. */
  schedule: RunnerSchedule;
  /**
   * When the schedule next fires, computed from the stored schedule. An
   * interval without an anchor counts from now, so for one it is an estimate.
   */
  nextRunAt: Date | null;
  /** Where its runs execute. */
  executionMode?: ExecutionMode;
  /** Whether runs may overlap. */
  runMode?: "parallel" | "single";
  /** Whether its owner queues triggers that cannot start at once. */
  queueRuns?: boolean;
  /** The trigger queue's cap. */
  maxQueuedRuns?: number;
  /** Concurrency cap in `parallel` mode; `Infinity` when unlimited. */
  maxConcurrency?: number;
  /**
   * Its executor and overlap configuration, with the code/effective split and
   * any stored override. Absent when no owner has started since remote
   * configuration shipped — treat that as not configurable, because such an
   * owner would store the override and never adopt it.
   */
  config?: RunnerConfigInfo;
  /** Whether it is paused. */
  isPaused: boolean;
  /** Whether any process holds its single-run lock. */
  isRunning: boolean;
  /** Who is running it — host, pid, run id and since when — from the lock. */
  runningOn?: { host: string; pid: number; runId: string; since: number };
  /** Triggers waiting for an owner to drain them. */
  queuedTriggers: number;
  /** Lifetime counters. */
  stats: RunnerStats;
  /** The most recent run. */
  lastRun?: TypedRunRecord<TResult>;
  /** The most recent failure. */
  lastError?: { name: string; message: string };
  /** When its persisted state last changed, in epoch milliseconds. */
  updatedAt?: number;
  /**
   * This process's own view, present only when the runner is registered
   * here: its instance status, its runs in flight and its ticker's next fire.
   */
  local?: {
    /** The local instance's status. */
    status: RunnerStatus;
    /** Runs in flight in this process. */
    activeRuns: RunRecord[];
    /** When this instance's ticker next fires. */
    nextRunAt: Date | null;
  };
}

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
  /**
   * Where the child's stdout goes. Defaults to `"pipe"` while
   * {@link BunRunnerOptions.captureLogs} is on — a piped stream is written
   * through to this process's stdout as well as captured — and `"inherit"`
   * when it is off. Setting it explicitly wins, and a stream that is not
   * piped is not captured.
   */
  stdout?: "inherit" | "pipe" | "ignore";
  /** Where the child's stderr goes. Defaults exactly as `stdout` does. */
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

/**
 * Options accepted by {@link BunRunnerOptions.captureLogs}: whether a run's
 * output is stored, and what bounds it.
 *
 * The caps are the same three the store applies (`RunLogCaps`) plus the two
 * capture applies before it, and every one of them is "0 means unbounded",
 * the convention `keep` takes throughout the package.
 *
 * `keepRuns` is deliberately not here: it is the runner's `keepHistory`, so
 * that a run in the history and a run with a log are the same set.
 */
export interface RunLogCaptureOptions {
  /**
   * Whether to capture at all. Defaults to `true` — but only where the driver
   * can store run logs (`appendRunLog`); on one that cannot, nothing is
   * captured whatever this says.
   */
  enabled?: boolean;
  /**
   * How many lines one run's log keeps; the oldest go first. Defaults to
   * `DEFAULT_RUN_LOG_MAX_LINES` (1,000). Applied by the store on every append,
   * so a log is never over its cap at a moment a reader could see it.
   */
  maxLines?: number;
  /**
   * How many bytes of line text one run's log keeps, counted as UTF-8 bytes
   * of the text alone. Defaults to `DEFAULT_RUN_LOG_MAX_BYTES` (1 MiB).
   */
  maxBytes?: number;
  /**
   * The longest a single captured line may be, in UTF-8 bytes. Defaults to
   * `DEFAULT_RUN_LOG_MAX_LINE_BYTES` (8 KiB). A longer line is cut on a
   * character boundary and marked `truncated`, never dropped — a megabyte
   * written without a newline (a progress bar, a base64 blob) would otherwise
   * spend the whole per-run byte cap by itself.
   */
  maxLineBytes?: number;
  /**
   * The most one run may hand to the store over its whole life, in UTF-8
   * bytes of line text. Defaults to `DEFAULT_RUN_LOG_CAPTURE_BYTES` (8 MiB).
   *
   * The caps above bound what is *kept*; this bounds what is *written*, so a
   * run in a hot loop costs the backend a bounded number of writes rather than
   * one per line of the million it produced. At the ceiling capture stops and
   * stores one last `log` line saying so, so the log ends with a reason
   * instead of just ending.
   */
  captureBytes?: number;
  /**
   * Whether an `in-process` or `worker-thread` run's `console.log`, `info`, `debug`
   * (stored as `stdout`) and `warn`, `error` (stored as `stderr`) calls are
   * captured. Defaults to `true`. A spawned run's console is captured through
   * its pipes whatever this says.
   *
   * These runs share a `console` — an in-process run shares this process's
   * with the host and with every other in-process run — so the patch is
   * process-wide and each call is attributed to its run by async context: a
   * call made by the run's code, or by anything it scheduled, lands in that
   * run's log; a call from outside every run is never captured. The console
   * still prints exactly as before. What escapes: `process.stdout.write`,
   * native code writing to the file descriptors, a program the handler
   * launches with its own stdio, other console methods, and a reference to a
   * console method taken before the run began.
   */
  console?: boolean;
  /**
   * How secrets are scrubbed from captured lines before they are stored.
   * Defaults to `true`: the built-in rules (values of keys that look like a
   * password, secret, token, API key, authorization, cookie or session, bearer
   * tokens, credentials in a URL, JWTs). `false` stores lines verbatim; a
   * {@link RunLogRedactOptions} object adds keys and patterns, or replaces the
   * built-in rules.
   *
   * Applied before any cap counts the line, so `maxLineBytes`, `maxBytes` and
   * `captureBytes` all measure a line exactly as it is stored.
   */
  redact?: boolean | RunLogRedactOptions;
}

/**
 * Options accepted by {@link RunLogCaptureOptions.redact}.
 *
 * ```ts
 * captureLogs: { redact: { keys: ["ssn"], patterns: [/sk_live_\w+/] } }
 * ```
 */
export interface RunLogRedactOptions {
  /**
   * More key words: a key whose name contains one, case-insensitively, has its
   * value scrubbed, in every form the built-in keys are (`k=v`, `k: v`,
   * quoted, JSON). Added to the built-in list unless `defaults` is `false`.
   */
  keys?: readonly string[];
  /**
   * More patterns: every match is replaced, whole, by `replacement`. The `g`
   * flag is added when missing, so every match on a line is scrubbed, not just
   * the first. Keep them linear — a pattern that backtracks runs on every
   * captured line.
   */
  patterns?: readonly RegExp[];
  /**
   * Whether the built-in keys and patterns apply. Defaults to `true`; `false`
   * leaves only `keys` and `patterns`.
   */
  defaults?: boolean;
  /** What a scrubbed value becomes. Defaults to `"[REDACTED]"`. */
  replacement?: string;
}

/** A runner's capture settings with every default applied. */
export interface ResolvedRunLogCaptureOptions {
  /** Whether to capture at all. */
  enabled: boolean;
  /** How many lines one run's log keeps; `0` is unbounded. */
  maxLines: number;
  /** How many bytes of line text one run's log keeps; `0` is unbounded. */
  maxBytes: number;
  /** The longest a single stored line may be, in UTF-8 bytes; `0` is unbounded. */
  maxLineBytes: number;
  /** The most one run may hand to the store, in UTF-8 bytes; `0` is unbounded. */
  captureBytes: number;
  /** Whether an `in-process` or `worker-thread` run's console calls are captured. */
  console: boolean;
  /**
   * The compiled redactor every line passes through before it is measured
   * and stored, or `null` when redaction is off.
   */
  redact: ((text: string) => string) | null;
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
  /**
   * Where runs execute: `"child-process"` (the default), `"worker-thread"` or
   * `"in-process"`. The pre-1r spellings `"spawn"` and `"worker"` are a
   * `ConfigError` naming the current one.
   */
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
  /**
   * How many run records to keep. Defaults to 50.
   *
   * Above the management API's `limits.maxHistory` (200 by default) this
   * stores more than that API will serve **in one page** — not more than it
   * will serve at all: `GET /runners/{runner}/history` takes an uncapped
   * `offset`, so every record here is reachable by paging.
   */
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
   * Whether a run's output is captured and stored per run, so the history row
   * can link to its log. `true` (the default) or `false`, or a
   * {@link RunLogCaptureOptions} object to set the caps.
   *
   * What is captured depends on where the run executes. A `child-process` run's
   * `stdout` and `stderr` are captured line by line from its pipes, plus
   * anything it wrote with `ctx.log()`. A `worker-thread` or `in-process` run shares
   * this process's stdio, so its `ctx.log()` lines are captured, and so are
   * its `console.log/info/debug` (as `stdout`) and `console.warn/error` (as
   * `stderr`) calls, attributed to the run by async context (see
   * {@link RunLogCaptureOptions.console}). Output written by native code,
   * with `process.stdout.write`, or by a program the handler itself launched
   * with its own stdio, reaches neither.
   *
   * Every line is scrubbed of secrets before it is stored
   * ({@link RunLogCaptureOptions.redact}, on by default).
   *
   * **Gotcha: it changes the default stdio of a spawned run.** Capture needs
   * the pipes, so `spawn.stdout`/`spawn.stderr` default to `"pipe"` instead of
   * `"inherit"` while it is on. The child's output is still written straight
   * through to this process's own stdout and stderr, so nothing disappears —
   * but an explicit `spawn.stdout: "inherit"` is respected, and that stream is
   * then not captured.
   *
   * Nothing here can fail a run: a driver without run-log storage, a store
   * that throws and a run past its `captureBytes` ceiling each drop lines
   * quietly.
   */
  captureLogs?: boolean | RunLogCaptureOptions;
  /**
   * What this runner records into the analytics buckets: a series of its runs
   * by outcome (`started`, `succeeded`, `failed`, `timeout`, `killed`,
   * `skipped`) and a duration histogram, one write per settled run into the
   * bucket the run **finished** in. On by default, at per-second resolution.
   *
   * `runners: false` stops this runner writing its series and
   * `durations: false` its durations, whatever the driver; `resolution` and
   * `secondRetentionMs` reach only a driver built here from a config (one
   * that names its own `metrics` wins), never an instance passed in. The
   * lifetime counters in {@link RunnerStats} are kept either way.
   *
   * Recording never changes a run: a driver without the analytics methods
   * records nothing, and one that throws is logged once and ignored.
   */
  metrics?: MetricsOptions;
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
  /**
   * Subscribe to `control` events, so a change made through
   * `BunRunnerManager.controller()` in another process — pause, resume, a new
   * schedule, a configuration override, a queued trigger — applies within the
   * driver's event latency (tens of milliseconds on every backend) instead of
   * at the next `syncInterval`.
   *
   * `"auto"`, the default, listens where it is cheap: on a driver whose
   * events are pushed (Redis) or held in this process (memory), and not on one
   * that polls (SQL, MongoDB, the file driver), where a subscription is a
   * query every few dozen milliseconds **per runner**. `true` subscribes on
   * every backend and `false` on none; the sync adopts every change either
   * way, so the choice is about latency, never about whether remote control
   * works. It is the rule `BunQueueWorker` already resolves the `subscribe` of
   * its own `control` option with.
   */
  control?: boolean | "auto";
  /**
   * What a remote controller may change about this runner's executor and
   * overlap settings. Only `executionModes` today; it defaults to all three,
   * and the owner persists it so a controller elsewhere can refuse a mode
   * before writing it.
   */
  allowedOverrides?: RunnerAllowedOverrides;
  /** Child-process options, for `executionMode: "child-process"`. */
  spawn?: SpawnOptions;
  /** Worker options, for `executionMode: "worker-thread"`. */
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
  /**
   * Whether this runner subscribes to its `control` events, with `"auto"`
   * already decided against the driver: `true` where its events are pushed
   * (Redis) or local (memory), `false` where they are polled (SQL, MongoDB,
   * the file driver).
   */
  control: boolean;
  /** Run-log capture, with `true`/`false` expanded and every cap filled in. */
  captureLogs: ResolvedRunLogCaptureOptions;
  /**
   * The `metrics` option with every default applied. Only `runners` and
   * `durations` govern what this runner writes; the rest describes the driver
   * it would build from a config, and says nothing about an instance.
   */
  metrics: ResolvedMetricsOptions;
  /** The resolved absolute path (or URL string) of the handler file. */
  file: string;
  /** The normalised schedule. */
  schedule: RunnerSchedule;
  /** Default arguments for scheduled runs. */
  args?: TArgs;
  /** Driver config for children, when one is available. */
  childDriver?: DriverConfig;
  /** Remote-configuration limits, with the execution-mode allow-list filled in. */
  allowedOverrides: Required<RunnerAllowedOverrides>;
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
  /** A run called `ctx.log()`, or logged with `forwardLogs` on. */
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
  /**
   * The runner adopted a configuration change: its executor, overlap policy
   * or concurrency cap now differs from what it was running with. Emitted
   * only when a value actually changed, so a sync that finds the same
   * override again is silent.
   */
  configured: (config: RunnerConfigInfo) => void;
  /** The runner was paused. */
  paused: () => void;
  /** The runner was resumed. */
  resumed: () => void;
  /** The runner stopped. */
  stopped: () => void;
  /** Something failed outside a run (a tick, a driver read). */
  error: (error: Error, context: string) => void;
};
