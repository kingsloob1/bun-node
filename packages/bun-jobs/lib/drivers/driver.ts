import type { LogLevel, SerializedError } from "@kingsleyweb/bun-common";
import type { JobDefaultKey, JobListSort } from "../api/contract/constants";
import type { ConnectionOptions } from "../shared/connection";
import type { RunLogStream } from "../shared/constants";
import type { DriverEvent, EventKind, EventOfKind } from "../shared/events";
import type { RunnerSchedule } from "../shared/schedule";
import type {
  WorkerConfigKey,
  WorkerConfigValues,
  WorkerControlAction,
  WorkerControlMode,
  WorkerState,
  WorkerStopPersistence,
  WorkerTargetInfo,
} from "../shared/workers";
import type { JobCursorKey } from "./jobCursor";
import type {
  BucketRange,
  BusynessSample,
  CounterBucket,
  JobCounters,
  MetricsOptions,
  MetricsSupport,
  RawBusynessBucket,
  RawDurationBucket,
  RunnerRunCounters,
  RunnerRunTotals,
  WorkerJobTotals,
  WorkerMetricsRef,
} from "./metrics";
import type { RunHistoryPage, RunHistoryQuery } from "./runHistory";
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
  /**
   * Whether the driver records and filters job attribution. Declaring it
   * promises all of the following, which the shared driver contract checks:
   *
   * - every claim path stores {@link JobRecord.processedBy} from
   *   {@link ClaimOptions.workerId} and {@link ClaimOptions.worker}, in the
   *   write the claim already makes;
   * - no settle, stall recovery or retry clears it — only the next claim
   *   replaces it;
   * - {@link QueueDriver.findJobs} honours {@link JobQuery.workerKeys},
   *   {@link JobQuery.workerIds}, {@link JobQuery.finishedFrom} and
   *   {@link JobQuery.finishedTo} exactly as `attribution.ts` defines them.
   *
   * Absent or `false`: `findJobPage` in `readApis.ts` never hands a query
   * using any of those four fields to the driver's `findJobs` — a driver
   * written before them would ignore them and return every job — and runs
   * `findJobsByScan` instead, which filters the records itself: correct, and
   * linear. The management API reports it as `features.jobAttribution`.
   */
  jobAttribution?: boolean;
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
  /**
   * How many lines this run's log holds, as the last append reported it.
   *
   * Written by the runner's capture when the run settles, so a history row can
   * say whether there is a log to link to without reading one. Absent when
   * nothing was captured — the driver stores no run logs, or capture was off —
   * and `0` when the run simply said nothing.
   */
  logLines?: number;
  /**
   * How many of this run's lines {@link RunLogCaps the caps} dropped, oldest
   * first. `0` when none were; absent alongside {@link RunRecord.logLines}.
   */
  logsDropped?: number;
}

/* --- run logs ------------------------------------------------------- */

/**
 * One captured line of a run's output, as the store hands it back.
 *
 * Run logs deliberately do **not** ride the {@link RunRecord}. A runner's
 * history is one document on the file, SQL and MongoDB drivers — rewritten
 * whole under a lock on every append — so a line arriving every few
 * milliseconds while a run talks would rewrite the entire history that often.
 * Lines therefore live in storage of their own, keyed by `runId`, and are
 * written a line at a time exactly as a job's log is.
 */
export interface RunLogLine {
  /**
   * The line's 1-based place in its run's output.
   *
   * Assigned by the store, never by the caller, and never reused: lines
   * dropped by a cap leave a gap, and that gap is how `dropped` is known. It
   * is also the cursor {@link RunLogQuery.since} takes.
   */
  seq: number;
  /** Which stream produced it. */
  stream: RunLogStream;
  /** When it was captured, in epoch milliseconds. */
  at: number;
  /** The text, with its trailing newline already removed. */
  text: string;
  /**
   * The level a `log`-stream line carried.
   *
   * Absent on `stdout` and `stderr`, which have no levels, and on a forwarded
   * log line that came without one. Stored from the start even though nothing
   * sets it yet: adding a field to five backends later is a migration, and
   * adding it now is a nullable column nobody writes to.
   */
  level?: LogLevel;
  /**
   * Set when capture cut this line at its per-line byte cap
   * (`DEFAULT_RUN_LOG_MAX_LINE_BYTES`), so a reader can say the line is short
   * rather than show a silently clipped one as if it were whole.
   *
   * Only ever `true`, and only stored when it is: absent is false. Capture
   * decides it; storage only carries it.
   */
  truncated?: true;
}

/**
 * A line as capture hands it over: everything but the number.
 *
 * The store numbers lines, because only the store knows what the run's last
 * number was — a capture that numbered its own would restart from 1 after a
 * process restart, and two gaps would be indistinguishable from one.
 */
export type RunLogInput = Omit<RunLogLine, "seq">;

/**
 * What bounds a run's log, applied by {@link RunnerDriver.appendRunLog} on the
 * write path.
 *
 * Enforced on write rather than by a sweeper, which is the whole shape of
 * this: there is no background task to schedule, nothing to forget to run,
 * and a log cannot be over its cap at any moment a reader could observe it.
 *
 * All three are "0 means unbounded", the same convention `keep` takes
 * throughout the contract.
 */
export interface RunLogCaps {
  /**
   * Most lines one run's log keeps; the oldest go first.
   * Defaults to `DEFAULT_RUN_LOG_MAX_LINES` (1,000) at the caller.
   */
  maxLines: number;
  /**
   * Most bytes of line text one run's log keeps, counted as UTF-8 bytes of
   * {@link RunLogLine.text} and nothing else — not the stream, the timestamp,
   * the level, the truncation flag, or whatever framing the backend stores
   * around them, so every driver bounds the same number. The oldest lines go
   * first.
   * Defaults to `DEFAULT_RUN_LOG_MAX_BYTES` (1 MiB) at the caller.
   */
  maxBytes: number;
  /**
   * How many of a runner's runs keep a log at all; the oldest run's log is
   * dropped whole.
   *
   * Applied on the write path too, for the same reason, and matched to the
   * runner's `keepHistory` by the caller so a run in the history and a run
   * with a log are the same set. Defaults to `DEFAULT_KEEP_HISTORY` (50).
   */
  keepRuns: number;
}

/** How much of a run's log to read, and which of it. */
export interface RunLogQuery {
  /** How many lines to skip, in the order asked for. */
  offset: number;
  /** How many lines to return. `0` returns none. */
  limit: number;
  /** `asc` is oldest first. */
  order: "asc" | "desc";
  /**
   * Only lines numbered **above** this — exclusive, so passing back the
   * {@link RunLogPage.lastSeq} of the previous read is a tail that never
   * repeats a line and never skips one.
   */
  since?: number;
  /** Only lines from this stream. */
  stream?: RunLogStream;
}

/** A page of a run's log, with what a reader needs to know about the rest. */
export interface RunLogPage {
  /** The page, in the order asked for. */
  lines: RunLogLine[];
  /**
   * How many lines match the filters in total — so with `since` or `stream`
   * set this is the filtered total, which is what pages the filtered list.
   */
  count: number;
  /**
   * How many of the run's lines the caps have dropped, in total.
   *
   * A property of the run's log rather than of the page, so the filters do not
   * change it: a reader shows "N earlier lines dropped" whatever it asked for.
   */
  dropped: number;
  /**
   * The highest number the run's log holds, or `0` when it holds nothing.
   *
   * Unfiltered, like `dropped`, which is what makes it a correct cursor: a
   * tail with a `stream` filter that resumed from the last *matching* line
   * would re-read everything the filter excluded.
   */
  lastSeq: number;
}

/** What an append left behind, without reading the log back. */
export interface RunLogAppendResult {
  /** How many lines the run's log now holds, after the caps were applied. */
  count: number;
  /** How many of the run's lines the caps have dropped, in total. */
  dropped: number;
  /** The highest number the run's log holds, or `0` when it holds nothing. */
  lastSeq: number;
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
  /**
   * A page of the history, with the whole list's size.
   *
   * Optional, and unlike {@link RunnerDriver.getRunLog} its absence prunes
   * nothing: a driver without it is paged by reading
   * {@link RunnerDriver.listHistory} whole and slicing with `pageRunHistory`,
   * which is correct everywhere because the history is bounded by the runner's
   * `keepHistory`. Implement it to let the store do the slicing.
   *
   * The `total` is exact and must come from the **same read** as the records,
   * or a page and its count can disagree about a run that started between two
   * queries.
   *
   * **Honouring {@link RunHistoryQuery.after} — the keyset cursor — is opt-in,
   * and is declared by answering with {@link RunHistoryPage.offset}.** An
   * implementation that seeks resolves the cursor to a position and returns
   * it; one that cannot must leave `offset` out, and `readHistoryPage` then
   * reads the history whole and seeks with `pageRunHistory` rather than let a
   * cursor request be answered with page one — which a client cannot tell
   * apart from the end of the list.
   */
  pageHistory?: (
    ns: string,
    key: string,
    opts: RunHistoryQuery,
  ) => Promise<RunHistoryPage>;
  /**
   * Drops the history — **and, on a driver that has them, every run log this
   * runner holds**.
   *
   * The two are one store as far as a caller is concerned: a run the history
   * no longer mentions cannot be asked about, so a log left behind for it is
   * unreachable bytes that nothing would ever collect. Clearing both here is
   * what makes {@link RunnerDriver.appendRunLog}'s write-path trimming
   * sufficient and a sweeper unnecessary.
   */
  clearHistory: (ns: string, key: string) => Promise<void>;
  /**
   * Appends captured output to one run's log, applies
   * {@link RunLogCaps the caps}, and says what the log holds afterwards.
   *
   * The store numbers the lines, continuing the run's own 1-based sequence.
   * Lines are stored in the order given.
   *
   * **Keyed by `runId` alone.** It does not look for a run record and does not
   * create one: capture flushes on a timer, so the first flush can easily beat
   * {@link RunnerDriver.appendHistory}, and a line lost because the record was
   * not written yet would be exactly the line explaining a start-up failure.
   * A log outliving its record is collected by `keepRuns`, by
   * {@link RunnerDriver.clearRunLogs} and by `clearHistory`.
   *
   * Both per-run caps *and* `keepRuns` are applied here, on the write path.
   * There is no sweeper.
   *
   * Optional, so that a driver without it makes the API prune the route
   * rather than serve an endpoint that answers nothing.
   */
  appendRunLog?: (
    ns: string,
    key: string,
    runId: string,
    lines: RunLogInput[],
    caps: RunLogCaps,
  ) => Promise<RunLogAppendResult>;
  /**
   * A page of one run's log.
   *
   * A run the store knows nothing about — never logged, or dropped by
   * `keepRuns` — is not an error: it reads as an empty log,
   * `{ lines: [], count: 0, dropped: 0, lastSeq: 0 }`. Whether the run itself
   * exists is the history's question, not this one's.
   *
   * Optional, alongside {@link RunnerDriver.appendRunLog}.
   */
  getRunLog?: (
    ns: string,
    key: string,
    runId: string,
    opts: RunLogQuery,
  ) => Promise<RunLogPage>;
  /**
   * Drops one run's log, or every log this runner holds when `runId` is
   * omitted.
   *
   * Dropping a log also forgets what it dropped: the run reads back as empty
   * with `dropped: 0`, not as a log whose every line was lost.
   *
   * Optional, alongside {@link RunnerDriver.appendRunLog}.
   */
  clearRunLogs?: (ns: string, key: string, runId?: string) => Promise<void>;
  /**
   * Removes the named runs from this runner — each one's history record
   * **and**, on a driver that stores them, its run log — and answers with how
   * many records it removed.
   *
   * This is how "clear the history, but not the runs still going" is done,
   * and it is deliberately a method of its own rather than an argument to
   * {@link RunnerDriver.clearHistory}: a driver written before the argument
   * existed would ignore it and delete the run still in progress anyway, with
   * nothing to tell the caller. A driver without this method has the route
   * pruned instead, and `BunRunner.clearHistory` throws `NotSupportedError`.
   *
   * **Named runs go, everything else stays** — the reverse of a keep-list, on
   * purpose. The caller lists the history, decides which runs have finished,
   * and names those; a run that starts after it looked cannot be named, so it
   * cannot be removed, whatever the clocks or the interleaving. That is what
   * keeps a live run's record and log whole without the driver having to
   * decide anything or remove anything atomically across the two stores.
   *
   * - A name the history does not hold is not an error. Its log, if one
   *   survives, is removed all the same (a log outliving its record is bytes
   *   nothing can reach), and it does not count towards the answer.
   * - Every other run's record and log, and every other runner and namespace,
   *   are untouched. So are the runner's state fields — the lifetime
   *   `stat:*` counters, `lastRunId`, the pause flag — its lock, its queued
   *   triggers and its analytics series.
   * - An empty list removes nothing and answers `0`.
   *
   * Optional. {@link RunnerDriver.clearHistory} keeps its meaning of dropping
   * everything, in-progress runs included.
   */
  removeRuns?: (
    ns: string,
    key: string,
    runIds: readonly string[],
  ) => Promise<number>;
  /**
   * Counts one runner event — a run starting, finishing or being skipped — into
   * the analytics buckets, and its duration with it.
   *
   * **Never a round trip per run.** The counts go through a `MetricsBuffer`
   * (`drivers/metrics.ts`) and are written once a second onto a single shared
   * row per `(ns, runner, bucket)`, at every width the driver records and on
   * the namespace roll-up at the same time. A driver that can count inside a
   * script it is already sending may do so instead, but must still write both
   * widths: the second-to-minute roll-up is a dual write, never a background
   * job, because a background roll-up needs a leader and loses a minute of
   * counts when it dies.
   *
   * The lifetime `RunnerStats` counters stay exactly as they are. Cumulative
   * and resettable is a different thing from a series, and one cannot be
   * derived from the other.
   *
   * `at` is when the event happened, and is floored to each bucket. A run
   * counts in the bucket it **finished** in, which is why the duration travels
   * with the outcome rather than with the start.
   *
   * Optional, alongside {@link RunnerDriver.getRunnerMetrics}: a driver with
   * neither has its analytics routes pruned and reports
   * `features.runnerMetrics: false`.
   */
  countRunnerRun?: (
    ns: string,
    /** The runner's **key**, `runnerKey(id)` (`r:<id>`) — not its bare id. */
    runner: string,
    at: number,
    counts: RunnerRunDelta,
  ) => Promise<void>;
  /**
   * One runner's buckets: its runs by outcome, and its durations when they
   * were asked for and recorded.
   *
   * Sparse and oldest first, as {@link MetricsQuery} describes. A runner the
   * backend never counted for is not an error — it reads as no buckets, the
   * same as a runner that did nothing in the range. Counts that were never
   * kept cannot be reconstructed, so there is no fallback: a driver either
   * implements this or has the route pruned.
   *
   * Optional, alongside {@link RunnerDriver.countRunnerRun}.
   */
  getRunnerMetrics?: (
    ns: string,
    /**
     * The runner's **key**, `runnerKey(id)` (`r:<id>`) — not its bare id,
     * which reads as a runner never counted: empty buckets, no error.
     */
    runner: string,
    query: RunnerMetricsQuery,
  ) => Promise<RunnerMetricsRead>;
  /**
   * **Every** runner's totals over a range, in one read — the rows of
   * `GET /analytics/runners`, which rank by `started` and cap at
   * `MAX_ANALYTICS_ROWS`, and so need every runner's figure before they can
   * pick any. A read per runner instead was a database round trip per row
   * on every poll.
   *
   * One row per runner with something to report over the range: a counted
   * outcome or — when `durations` was asked for and is recorded — a finished
   * duration. A runner with nothing is **absent, not zero**, and so is one
   * outside `query.runners`. The namespace roll-up (`NAMESPACE_ENTITY`)
   * is never a row. Order is unspecified; each runner appears once.
   *
   * A row is exactly what `runnerTotalsOf(getRunnerMetrics(...))` gives for
   * that runner (`drivers/metrics.ts`) — a backend may sum in the engine
   * (`GROUP BY entity`) or reduce each entity's buckets with that helper, but
   * the numbers must match; the contract suite compares the two. When
   * durations were asked for and are recorded, every row carries them, with
   * `count: 0` for a runner none of whose runs finished in range.
   *
   * Optional, as a set with {@link RunnerDriver.getRunnerMetricsMany}; without
   * them a caller has only the read per runner.
   */
  getRunnerMetricsTotals?: (
    ns: string,
    query: RunnerMetricsTotalsQuery,
  ) => Promise<RunnerMetricsTotals[]>;
  /**
   * Several named runners' series, in one read — the `ids=` batch of
   * `GET /analytics/runners`, at most `MAX_ANALYTICS_SERIES` of them (the
   * route enforces that; the driver does not). The UI's rule that a page of
   * sparklines is one request depends on it also being one read.
   *
   * Each runner's entry is exactly what {@link RunnerDriver.getRunnerMetrics}
   * answers for it — sparse, oldest first, `durations` present when asked for
   * and recorded — plus its key. A runner with nothing in range (no run
   * bucket and, when asked, no duration bucket) is **absent**, not an entry
   * of empty arrays, and so is the roll-up's empty name if it is asked for.
   * A name asked for twice is answered once; order is unspecified.
   *
   * Optional, as a set with {@link RunnerDriver.getRunnerMetricsTotals}.
   */
  getRunnerMetricsMany?: (
    ns: string,
    /** Runner **keys**, each `runnerKey(id)` — not bare ids. */
    runners: readonly string[],
    query: RunnerMetricsQuery,
  ) => Promise<RunnerMetricsSeries[]>;
  /**
   * The namespace's own roll-up buckets, for the kinds asked for.
   *
   * Every per-entity count bumps these as it is written (§4f of the analytics
   * design), which is the whole reason they exist: an overview of a namespace
   * with three hundred workers costs the same three reads as one with three.
   * Summing the entities instead would be a read per entity per refresh.
   *
   * Declared identically on both halves of the contract, because the runner
   * half writes the `runs` roll-up and the queue half writes the other two,
   * and a `JobsDriver` implements the one method for all three.
   *
   * Optional; sparse and oldest first.
   */
  getNamespaceMetrics?: (
    ns: string,
    query: NamespaceMetricsQuery,
  ) => Promise<NamespaceMetricsRead>;
  /**
   * What this driver records and serves, so `/meta` can report it and a range
   * can be resolved against it. Built with `metricsSupportOf()` from the
   * driver's resolved `metrics` options.
   *
   * Optional and synchronous: a driver without it is taken to record nothing
   * beyond the shipped minute throughput.
   */
  getMetricsSupport?: () => MetricsSupport;
  /**
   * Writes the analytics counts this driver instance has gathered in memory and
   * not yet written, and resolves once they are written — or, for the ones that
   * failed, kept for the next attempt.
   *
   * Optional, and separate from {@link QueueDriver.flushThroughput} for the
   * same reason that one exists: a runner or worker closing awaits it whether
   * or not it owns the driver, because a process that shares one driver may
   * exit without ever closing it and the last second of counts would go with
   * the process.
   */
  flushMetrics?: () => Promise<void>;
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
  /**
   * Compare-and-pop: takes the oldest queued trigger **only if** its `id` is
   * `expectedId`, and returns it; otherwise returns `null` and changes
   * nothing.
   *
   * It is the second half of a paused drain. The drainer
   * {@link peekQueuedTrigger peeks} the head, decides whether it may run (is
   * it forced?), then pops *that record, by id*. A plain
   * {@link popQueuedTrigger} there would take whatever the head is by then:
   * another process may have taken the peeked record meanwhile and exposed an
   * ordinary one behind it, which would then run on a paused runner. With
   * this, drainers in several processes never pop a record they did not
   * inspect; on `null` a drainer peeks again and decides afresh.
   *
   * The check and the removal are **atomic** with respect to every other
   * caller in every other process — of this method, of `popQueuedTrigger`
   * and of `pushQueuedTrigger` — so of N callers racing with the same id,
   * exactly one gets the record and the rest get `null`. An empty list, a
   * different head, or a runner the backend does not know all answer `null`,
   * and like a peek it never creates a runner, so
   * {@link DriverLifecycle.listRunners} does not change. Required, for the
   * same reason as `peekQueuedTrigger`: there is no correct fallback.
   */
  popQueuedTriggerIf: (
    ns: string,
    key: string,
    expectedId: string,
  ) => Promise<QueuedTrigger | null>;
  /** How many triggers are queued. */
  countQueuedTriggers: (ns: string, key: string) => Promise<number>;
  /** Drops every queued trigger, returning how many were dropped. */
  clearQueuedTriggers: (ns: string, key: string) => Promise<number>;
}

/* ------------------------------------------------------------------ *
 * Queue storage
 * ------------------------------------------------------------------ */

/**
 * What one {@link QueueDriver.promoteDelayed} call did, and when the next
 * scheduled job comes due.
 */
export interface PromoteDelayedResult {
  /** How many jobs moved to `waiting`. */
  promoted: number;
  /**
   * The earliest `runAt` among the queue's `delayed` and `failed` jobs as the
   * promotion left them, or `null` when none is scheduled — the answer
   * {@link QueueDriver.nextDelayedAt} would give straight afterwards.
   *
   * It can be at or before `now`: when more than `limit` jobs were due, the
   * ones left behind are still scheduled, and a caller should promote again
   * rather than wait.
   */
  nextDueAt: number | null;
}

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
  /**
   * The outcome was a failure not ignored, and buried the parent: `dead`. Also
   * answered for a completed or ignored outcome the backend could not store —
   * on MongoDB, one that would take the parent past the 16 MB document limit —
   * which buries the parent with a `ChildFailedError` saying so, rather than
   * leaving it waiting on a delivery that can never land.
   */
  | "buried"
  /** The parent already had it, or has moved on and no longer waits. */
  | "already"
  /**
   * The parent is `dead` and the outcome is a failure not ignored, so nothing
   * was stored. The child should stay as it is — a retry of the parent sees it
   * unsettled, and the child can be retried in turn. Also answered when a
   * completed or ignored outcome for a `dead` parent could not be stored (the
   * MongoDB document limit): nothing is kept, and a retry of the parent
   * delivers it again.
   */
  | "parent-dead"
  /**
   * There is no such parent, or it does not list this child: a flow still
   * being added children first, one cut short, or a parent removed.
   */
  | "missing";

/**
 * What {@link QueueDriver.clearJobLogs} did. Only `"cleared"` removed anything.
 */
export type ClearJobLogsResult =
  | {
      /** The job's log is now empty. */
      status: "cleared";
      /**
       * How many lines were removed: what the log kept a moment before, so
       * `0` for a job that had logged nothing (or whose lines `keepLogs` had
       * already trimmed to none).
       */
      removed: number;
    }
  | {
      /**
       * The job is `active`, so nothing was removed. A worker is still
       * writing the log, and clearing it would leave a log that looks whole
       * while missing its start — the same reason removing an active job is
       * refused.
       */
      status: "active";
    }
  | {
      /** There is no such job. */
      status: "missing";
    };

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

/**
 * A job's options as stored: {@link ResolvedJobOptions} plus the explicit
 * mask. Kept off `ResolvedJobOptions` itself until the management API's wire
 * schema carries it (as a list of keys, `JobOptionsDto.explicit`), so the
 * public options type and the schema stay equal.
 */
export interface StoredJobOptions extends ResolvedJobOptions {
  /**
   * Which of the editable options ({@link EditableJobOptionKey}) the job's own
   * `add()` passed explicitly, as a bitmask (`JOB_OPTION_BITS` in
   * `queue/jobDefaults.ts`). Written on every job this version adds — `0` when
   * none was — so *absent* means the job predates it and nothing can say which
   * of its options were explicit.
   *
   * A driver stores it with the rest of `opts` and never interprets it, with
   * two exceptions: {@link QueueDriver.updateJob} with a `priority` sets the
   * priority bit (an operator's per-job priority is explicit) on a job that
   * has a mask, and {@link QueueDriver.rewritePendingOptions} never writes a
   * key whose bit is set.
   */
  explicit?: number;
}

/**
 * The job options a queue's stored defaults may replace — the contract's
 * `JobDefaultKey`, named for the driver layer.
 */
export type EditableJobOptionKey = JobDefaultKey;

/** One call's worth of {@link QueueDriver.rewritePendingOptions}. */
export interface PendingOptionsRewrite {
  /**
   * The states to walk, in this order: a non-empty subset of `waiting`,
   * `delayed`, `failed` and `waiting-children` (`JOB_DEFAULTS_APPLY_STATES`),
   * without repeats. Never `active`, `completed` or `dead`.
   */
  states: JobState[];
  /**
   * The values to write, already validated. A key absent is not touched.
   * `attempts` also sets the job's `maxAttempts`; `priority` also sets its
   * `priority` column / score, reordering a waiting job.
   */
  values: Partial<Pick<ResolvedJobOptions, EditableJobOptionKey>>;
  /**
   * Where the previous call stopped (its `next`), or `null` to start. Opaque
   * and driver-defined; one the driver cannot read — or one naming a state
   * not in `states` — is refused with a `ConfigError`.
   */
  cursor: string | null;
  /** Most jobs to examine in this call, at least 1. The driver may batch internally below it. */
  limit: number;
  /**
   * Treat a job with no `opts.explicit` (added before the mask existed) as
   * all-defaulted and rewrite it, rather than counting it `skippedUnmarked`.
   */
  includeUnmarked: boolean;
  /** Examine and count exactly as a real call would, but write nothing. */
  dryRun: boolean;
  /** The caller's clock, in epoch milliseconds. */
  now: number;
}

/**
 * What one {@link QueueDriver.rewritePendingOptions} call did.
 *
 * `rewritten`, `unchanged`, `skippedExplicit`, `skippedUnmarked` and `moved`
 * add up to `examined`; `exhausted` is a part of `rewritten`.
 */
export interface PendingOptionsRewriteResult {
  /** Jobs looked at in this call. */
  examined: number;
  /** Jobs at least one of whose options changed (in a dry run: would have). */
  rewritten: number;
  /** Jobs that already had every value — including a job met again after its own priority change moved it ahead of the walk. */
  unchanged: number;
  /** Jobs left alone because every key that would change is explicit on them. */
  skippedExplicit: number;
  /** Jobs with no `opts.explicit`, left alone because `includeUnmarked` was off. */
  skippedUnmarked: number;
  /**
   * Jobs read for this call that had left `states` by the time of their
   * write, and were not touched. A lower bound: a backend that runs a batch
   * atomically never sees one and reports `0`.
   */
  moved: number;
  /**
   * Rewritten jobs given a new `attempts` their `attemptsMade` already
   * reaches: each runs once more, and dies if that attempt fails.
   */
  exhausted: number;
  /** Where the next call continues, or `null` when every state has been walked. */
  next: string | null;
}

/** A job as stored. */
export interface JobRecord {
  /** Identifies the job; also its idempotency key. */
  id: string;
  /** The job's name, chosen by the producer. */
  name: string;
  /** The producer's payload. JSON only. */
  data: unknown;
  /** Options after defaults, with the explicit mask when the job has one. */
  opts: StoredJobOptions;
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
  /**
   * Id of the worker holding it — set by the claim, and `null` again once the
   * attempt settles, stalls or is released. Readers take it to mean "holding
   * it now", so a driver that keeps the claimer's id in storage after the
   * settle (as the attribution does) reports it here only while the job is
   * `active`, and reads who ran a finished job from `processedBy` instead.
   */
  workerId: string | null;
  /**
   * Who claimed the current or last attempt. Written by the claim, in the same
   * write that sets `workerId`, and — unlike `workerId` — never cleared by a
   * settle, a stall recovery or a retry: only the next claim replaces it, so it
   * lasts as long as the job does. **Last attempt only**: a job retried on
   * another worker names that one.
   *
   * `null` (or absent) for a job never claimed, or last claimed by a driver or
   * worker from before attribution existed. Optional so a driver written
   * before it still compiles; one declaring
   * {@link DriverCapabilities.jobAttribution} must store it. A record added
   * with it — restored from elsewhere — keeps it.
   */
  processedBy?: JobWorkerRef | null;
  /** The repeat definition that produced it, when it is a repeat instance. */
  repeatKey: string | null;
  /** Its place in a flow, or `null` for a job that is in none. */
  flow: JobFlow | null;
}

/**
 * Who claimed a job's current or last attempt, as the claim stamped it: see
 * {@link JobRecord.processedBy}.
 */
export interface JobWorkerRef {
  /** The claiming worker's incarnation id ({@link ClaimOptions.workerId}); a restart gives the worker a new one. */
  id: string;
  /** Its stable key, which outlives restarts; absent when the claimer did not say (an older worker). */
  key?: string;
  /** The host it ran on; absent when the claimer did not say. Stored whatever the API exposes. */
  host?: string;
  /** Its process id; absent when the claimer did not say. */
  pid?: number;
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
  /**
   * The claiming worker's stable key, host and pid, stamped with `workerId`
   * as the job's {@link JobRecord.processedBy} — in the write the claim
   * already makes, never a round trip of its own. Absent (an older worker):
   * the stamp is `{ id: workerId }`. A driver without
   * {@link DriverCapabilities.jobAttribution} may ignore it.
   */
  worker?: { key: string; host: string; pid: number };
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
 * {@link QueueDriver.listJobs}, and the order is the same one — no filter
 * changes it. Every filter narrows the jobs *before* the page is cut, so
 * `offset` counts matches and a page is never short because non-matching jobs
 * sat inside it; the filters AND together. The attribution filters
 * (`workerKeys`, `workerIds`, `finishedFrom`, `finishedTo`) are defined once, in
 * `attribution.ts`, which every backend matches against.
 *
 * The one thing that changes the order is {@link JobQuery.sort}: `"createdAt"`
 * orders by creation whatever the states. Absent, or `"natural"`, it is the
 * `listJobs` order.
 */
export interface JobQuery {
  /** The states to read. Several are ordered by creation, as `listJobs` does. */
  states: JobState[];
  /** Matching jobs to skip. */
  offset: number;
  /** The most jobs to return. */
  limit: number;
  /**
   * `asc` is the order {@link JobQuery.sort} names — the states' natural
   * order by default — and `desc` its exact reverse, tie-breaks included.
   */
  order: "asc" | "desc";
  /**
   * What the page is ordered by. Absent means `"natural"`, and the two are the
   * same query:
   *
   * - `"natural"` — the {@link QueueDriver.listJobs} order, unchanged: one
   *   state by its own key (`waiting` by priority then creation, `delayed` and
   *   `failed` by `runAt`, `active` by lock expiry, `completed` and `dead` by
   *   `finishedOn`), several states by creation;
   * - `"createdAt"` — by `createdAt`, ascending, whatever the states, and jobs
   *   created in the same millisecond by `id`, compared by code point (the
   *   order `compareCodePoints` in `shared/strings.ts` gives, and a byte
   *   comparison on every backend). `order: "desc"` reverses both keys, so
   *   "newest first" is one well-defined sequence and an `offset` page never
   *   skips or repeats a job. `compareCreated` in `added.ts` is the definition.
   *
   * Honoured only by a driver that implements
   * {@link QueueDriver.countAddedJobs} — implementing it is the promise to
   * (see there). For any other, `findJobPage` in `readApis.ts` never hands
   * this query to the driver's `findJobs`, which would ignore the field and
   * answer in the natural order: it reads by scan and sorts instead. The
   * queue refuses the sort outright on such a driver with a `ConfigError`,
   * since that scan reads every job in the states asked for.
   */
  sort?: JobListSort;
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
  /**
   * Only jobs whose `processedBy.key` is exactly one of these. A job never
   * claimed, or whose stamp carries no key, never matches. Absent means any;
   * an empty array matches nothing.
   *
   * Honoured only by a driver declaring
   * {@link DriverCapabilities.jobAttribution}; for any other, `findJobPage`
   * filters by scan rather than trust its `findJobs` with it.
   */
  workerKeys?: string[];
  /**
   * Only jobs whose `processedBy.id` is exactly one of these. Absent means
   * any; an empty array matches nothing. Gated like `workerKeys`.
   */
  workerIds?: string[];
  /**
   * Only `completed` or `dead` jobs with `finishedOn >= finishedFrom` (epoch
   * ms, **inclusive**). Every other state — waiting, delayed, active,
   * waiting-children, a `failed` retry pending — never matches a range, and
   * neither does a job with no `finishedOn`. Gated like `workerKeys`.
   */
  finishedFrom?: number;
  /**
   * Only `completed` or `dead` jobs with `finishedOn < finishedTo` (epoch ms,
   * **exclusive**), the same analytics convention as `finishedFrom`. Not after
   * `finishedFrom` matches nothing. Gated like `workerKeys`.
   */
  finishedTo?: number;
  /** Also count every match, ignoring `offset` and `limit`. Defaults to `false`. */
  total?: boolean;
  /**
   * Seek position: start the page at the job **after** this one, in the order
   * asked for, instead of counting {@link JobQuery.offset} matches in.
   *
   * The ordering key of the last job the previous page returned — a driver
   * mints it and a client only ever echoes it back, encoded, as
   * `encodeJobCursor` in `jobCursor.ts` makes it. When set, `offset` is
   * ignored.
   *
   * Honoured by declaration rather than by capability: a driver that honours it
   * says so by answering {@link JobPage.offset}, and one that does not — a
   * driver written before this existed ignores the field and hands back page
   * one, which reads exactly like the end of a list — has its page discarded
   * by `findJobPage` and the query re-read by scan.
   */
  after?: JobCursorKey;
}

/**
 * The range {@link QueueDriver.countAddedJobs} counts over: jobs whose
 * `createdAt` is at or after `from` and before `to`, both epoch ms.
 */
export interface AddedRange {
  /** Start, epoch ms, **inclusive**. */
  from: number;
  /** End, epoch ms, **exclusive**. Not after `from` matches nothing. */
  to: number;
}

/** A page of jobs, and how many matched in all when that was asked for. */
export interface JobPage {
  /** The page, in the query's order. */
  jobs: JobRecord[];
  /** Every match, ignoring `offset` and `limit`; present only when asked for. */
  total?: number;
  /**
   * **How a driver declares it honoured {@link JobQuery.after}**, and where
   * the seek landed. Three answers, and they are three different statements:
   *
   * - **`undefined`** — "I did not seek." Either no cursor was asked for, or
   *   this driver does not know the field. On a cursor request `findJobPage`
   *   discards the page and re-reads the query by scan, because a page that
   *   ignored the cursor is page one, and a client walking a list cannot tell
   *   page one from the end of it.
   * - **`null`** — "I sought past the cursor, and I did not count how many
   *   jobs precede the page." This is the normal answer on SQL and MongoDB.
   *   Counting them is an index range scan of exactly the size the `OFFSET`
   *   would have walked, so answering it would make a cursor page cost what
   *   the offset page cost — which is most of the reason to have a cursor on
   *   the deep lists at all.
   * - **a number** — "I sought, and the page starts here." Free on the
   *   backends that already know: the memory and file drivers put the listing
   *   in order to read it, Redis resolves the seek to a `ZRANK`, and the
   *   shared scan counts as it goes.
   *
   * On an **offset** request a driver leaves this out; `findJobPage` fills in
   * `query.offset`.
   */
  offset?: number | null;
}

/**
 * A worker's heartbeat record: who is consuming a queue, from where, and how
 * busy it is — what `listWorkers` reports.
 *
 * Written on the worker's report interval, never per job, so `active` and
 * `paused` are as fresh as the last report rather than exact.
 */
export interface WorkerInfo {
  /**
   * The worker's id: its **incarnation**, unique among live workers and new
   * every time the process starts, unless the worker was given an explicit
   * one. Load-bearing — it names the heartbeat record, the lock token and the
   * limiter's lease — so two live workers must never share it.
   */
  id: string;
  /**
   * The **stable** identity a configuration override is keyed by, so an
   * override survives restarts, redeploys and rescheduling onto new hosts,
   * and reaches every replica of the same worker. Derived as
   * `[service.]queue[.name|.ordinal]`.
   *
   * Optional: a record written by a worker from before this existed has none,
   * and a reader falls back to {@link WorkerInfo.id}.
   */
  key?: string;
  /**
   * The service the worker belongs to — its `BunJobs` context's `service`
   * option. Absent when none was set.
   */
  service?: string;
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
  /**
   * Whether it was locally paused at its last report. Kept for compatibility
   * with readers older than {@link WorkerInfo.state}, which says the same
   * thing and four more besides.
   */
  paused: boolean;
  /**
   * What it was doing at its last report. Absent on a record written before
   * this existed, where {@link WorkerInfo.paused} is all there is to read.
   */
  state?: WorkerState;
  /** When it started consuming, in epoch milliseconds. */
  startedAt: number;
  /**
   * When its *process* started, in epoch milliseconds — `performance.timeOrigin`
   * rounded. It is what tells one incarnation of a worker from the next when
   * the id was given explicitly, so a controller's instruction can never be
   * applied by a process that restarted since it was written.
   */
  processStartedAt?: number;
  /** When it last reported, in epoch milliseconds. */
  heartbeatAt: number;
  /**
   * When the record lapses unless the worker reports again, in epoch
   * milliseconds. A worker that died stops reporting, and from then it is not
   * listed.
   */
  expiresAt: number;
  /** The `@kingsleyweb/bun-jobs` version the worker runs. */
  version?: string;
  /**
   * Jobs this incarnation has completed since it started, as of its last
   * report. Counted by the worker when a completion it wrote landed, and
   * written with the heartbeat record — so it costs no I/O of its own and a
   * workers table has its headline without an analytics read.
   *
   * Per incarnation, like {@link WorkerInfo.id}: a restart starts it at `0`.
   * The series that survives restarts is the one keyed by
   * {@link WorkerInfo.key}. Absent on a record from before this existed.
   */
  completed?: number;
  /**
   * Attempts this incarnation has failed since it started, as of its last
   * report — every failed attempt, retried or not, whose write landed.
   * Per incarnation, like {@link WorkerInfo.completed}. Absent on a record
   * from before this existed.
   */
  failed?: number;
  /**
   * Resident set size in bytes at its last report, from
   * `process.memoryUsage.rss()`.
   *
   * **The memory of the process, not of the worker.** Two workers running in
   * one process report the same number, and nothing apportions it between
   * them — so **never sum it across rows**. To size a host, take one row per
   * `pid` (with {@link WorkerInfo.host}) and add those.
   *
   * Absent on a record from before this existed, and wherever the runtime does
   * not report it.
   */
  rssBytes?: number;
  /**
   * How long this worker's own heartbeat record write took, in milliseconds:
   * the round trip to the driver — a Redis script, a SQL upsert, a MongoDB
   * replace, a file rename — measured around the write itself.
   *
   * **Not a network ping.** It is the driver's work and whatever is queued in
   * front of it, so it reads the path the worker actually depends on rather
   * than the link to the backend.
   *
   * **The last sample, not an average.** A write cannot time itself, so the
   * record carries the *previous* report's round trip, and one slow figure is
   * as likely to be a single stalled write as a trend. Absent on a worker's
   * first report, on a record from before this existed, and wherever no write
   * has yet completed.
   */
  heartbeatRttMs?: number;
  /**
   * Whether this worker **takes part in** the queue's housekeeping sweeps —
   * the minute pass: the expiry prune, the repeat heal and the queue-state
   * sweeps — which is what its `maintenance` option decides. `true` by
   * default.
   *
   * Taking part, not performing: the minute pass is leased, so on a queue of
   * five `true` workers exactly one holds the lease on any given pass and the
   * other four stand down. `true` therefore means "arms the housekeeping
   * timer and contends for its lease", which is the question a reader
   * actually wants answered — a worker that stood down this minute is not a
   * queue without a sweeper.
   *
   * **It says nothing about liveness.** Promoting delayed jobs, recovering
   * stalled ones and healing flows happen on every worker and cannot be
   * turned off, so a queue whose live workers all report `false` keeps
   * running; it just accumulates what nobody tidies.
   *
   * Absent on a record from before this existed, like
   * {@link WorkerInfo.rssBytes} — and absent is not `false`: it means the
   * worker is too old to say. So a reader warning that a queue has no sweeper
   * wants *both* halves: at least one live worker saying `false`, and none
   * saying `true`. A queue whose live workers all omit the field has told it
   * nothing and must not be warned about — otherwise every fleet that has not
   * upgraded yet reads as broken. Even then the warning is "may be nobody",
   * since a worker too old to say may well be sweeping unseen.
   */
  sweeps?: boolean;
  /**
   * Where this worker's attempts run, as it is actually running them.
   *
   * Written on every report from the same resolved target the worker
   * dispatches to, the way {@link WorkerInfo.sweeps} is written from the value
   * maintenance branches on, so the record cannot disagree with what the
   * worker does.
   *
   * Absent on a record from a worker older than this field, like
   * {@link WorkerInfo.rssBytes} — and **absent is not `"in-process"`**.
   * `"in-process"` is the default, so reading absence as in-process would
   * confidently mislabel every worker that has not been upgraded. Absent
   * means "too old to say": show it as unknown, never as a default.
   */
  target?: WorkerTargetInfo;
  /**
   * Its settings: what it runs with, what its own code asked for, and which of
   * them an override replaces. Absent on a worker from before remote
   * configuration existed.
   */
  config?: WorkerConfigInfo;
  /**
   * What it says about being controlled remotely. Absent on a worker from
   * before remote control existed, which is therefore not controllable.
   */
  control?: WorkerControlInfo;
}

/**
 * A worker's settings as it reports them: what is in force, what its code
 * asked for, and the difference between the two.
 */
export interface WorkerConfigInfo {
  /** What the worker is actually running with. */
  effective: WorkerConfigValues;
  /** What its own code and options asked for, before any override. */
  code: WorkerConfigValues;
  /** The keys an override currently replaces, in `WORKER_CONFIG_KEYS` order. */
  overridden: WorkerConfigKey[];
  /**
   * Keys whose `code` value was derived rather than given — today only
   * `heartbeatInterval`, a third of `lockDuration`. Absent when none were.
   */
  derived?: WorkerConfigKey[];
  /**
   * The stored override's version, `0` when there is none. A controller sends
   * it back as `expectedSeq` for a safe read-modify-write.
   */
  seq: number;
  /** When the override was last written, epoch ms; absent when there is none. */
  updatedAt?: number;
}

/** What a worker says about being controlled from another process. */
export interface WorkerControlInfo {
  /**
   * Whether it listens for control at all: it was started with
   * `control`, and its driver can store the entries.
   */
  enabled: boolean;
  /**
   * How it hears about a change — a driver subscription, or only its own
   * polling. The report is a fallback under both.
   */
  mode: WorkerControlMode;
  /** The version of the lifecycle instruction it has applied. */
  appliedSeq: number;
  /** The version of the configuration override it has applied. */
  configSeq: number;
  /** Whether it is mid-apply; see `state: "restarting"` and `"stopping"`. */
  pending: boolean;
  /**
   * How long a stop given to this worker lasts, as its process is configured
   * — `"process"` (the default: back running after a restart) or `"key"`
   * (recorded against {@link WorkerInfo.key} and reapplied at startup).
   * Reported so a dashboard can say "stopped until restart" rather than guess.
   */
  stopPersistence: WorkerStopPersistence;
  /**
   * Whether one instruction may ask for the other persistence — the
   * `stopPersistenceOverridable` option. `false` by default, so the process
   * rather than the caller decides whether a stop outlives it.
   */
  stopPersistenceOverridable: boolean;
  /** The last instruction it could not apply, and why. Absent when none failed. */
  lastError?: {
    /** When it failed, epoch ms. */
    at: number;
    /** What went wrong, safe to show. */
    message: string;
    /** Which instruction failed, where one is known. */
    action?: WorkerControlAction;
    /** The version that failed, where one is known. */
    seq?: number;
  };
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

/**
 * Which buckets an analytics read wants: a width, and the first and last
 * bucket to answer with.
 *
 * `from` and `to` are **bucket starts, both inclusive** — `getThroughput`'s
 * convention, not the HTTP range's exclusive `to`. A route turns the one into
 * the other exactly once, in `resolveAnalyticsRange` (`drivers/metrics.ts`),
 * which is also what picked `interval`.
 *
 * A driver answers **sparsely**: a bucket it stored nothing for may be absent,
 * and `fillBuckets` makes the series contiguous afterwards. Filling in the
 * driver would mean every backend allocating an object per second of the range
 * before anything had capped it.
 */
export interface MetricsQuery extends BucketRange {
  /**
   * The bucket width, ms: `SECOND_BUCKET_MS` or `MINUTE_BUCKET_MS`. A width the
   * driver does not keep answers empty rather than throwing — the route asks
   * for one it reported in {@link MetricsSupport}.
   */
  interval: number;
}

/**
 * What one runner event counts as: the outcome, and the run's duration when it
 * has just finished.
 *
 * The duration rides with the outcome so a finished run is **one** write, not
 * two — the histogram is free precisely because nothing extra is sent for it.
 */
export interface RunnerRunDelta extends Partial<RunnerRunCounters> {
  /**
   * The run's duration, ms, when this delta reports a run *finishing*. A run
   * counts in the bucket it finished in, not the one it started in.
   */
  durationMs?: number;
}

/** What a runner's analytics read asks for. */
export interface RunnerMetricsQuery extends MetricsQuery {
  /**
   * Whether to read the duration buckets too. Off by default: a sparkline
   * needs the outcome counts alone, and the histograms are 25 numbers a
   * bucket.
   */
  durations?: boolean;
}

/** What a runner's analytics read answers with. */
export interface RunnerMetricsRead {
  /** Runs by outcome, sparse, oldest first. */
  runs: CounterBucket<RunnerRunCounters>[];
  /**
   * Durations, sparse, oldest first — absent when none were asked for, and
   * absent when the driver records none.
   */
  durations?: RawDurationBucket[];
}

/** What a worker's analytics read asks for. */
export interface WorkerMetricsQuery extends MetricsQuery {
  /**
   * Whether to read the busyness buckets too. They are sampled on the
   * heartbeat, so they are typically served at a coarser `interval` than the
   * throughput beside them — read them in their own call when they are.
   */
  busyness?: boolean;
}

/** What a worker's analytics read answers with. */
export interface WorkerMetricsRead {
  /** Jobs the worker finished, sparse, oldest first. */
  jobs: CounterBucket<JobCounters>[];
  /** Its busyness, sparse, oldest first; absent when none was asked for or recorded. */
  busyness?: RawBusynessBucket[];
}

/** Which namespace-wide roll-up a read wants. */
export type NamespaceMetricKind = "jobs" | "runs" | "workerJobs";

/** What a namespace roll-up read asks for. */
export interface NamespaceMetricsQuery extends MetricsQuery {
  /**
   * The roll-ups wanted. A driver may answer with fewer — one it does not
   * record is absent, never an array of zeros, so a caller can tell "nothing
   * happened" and "nothing is recorded" apart.
   */
  kinds: readonly NamespaceMetricKind[];
}

/**
 * The namespace's own buckets: what makes an overview three reads whatever the
 * fleet size, because every per-entity count bumps these as it is written.
 */
export interface NamespaceMetricsRead {
  /** Every queue's throughput, summed, sparse. */
  jobs?: CounterBucket<JobCounters>[];
  /** Every runner's outcomes, summed, sparse. */
  runs?: CounterBucket<RunnerRunCounters>[];
  /**
   * Every worker's throughput, summed, sparse. Not the same series as
   * {@link NamespaceMetricsRead.jobs}: a queue counts what its backend
   * finished, a worker counts what it finished itself, and jobs finished by a
   * process that records no worker metrics are in one and not the other.
   */
  workerJobs?: CounterBucket<JobCounters>[];
}

/**
 * What a grouped runner read asks for: a range, and optionally which runners.
 *
 * The rows of `GET /analytics/runners` — every runner's totals, ranked by the
 * caller — in one read however many runners there are.
 */
export interface RunnerMetricsTotalsQuery extends MetricsQuery {
  /**
   * Whether to total the durations too. Off by default, as on
   * {@link RunnerMetricsQuery.durations}.
   */
  durations?: boolean;
  /**
   * Only these runners — their stored keys, as counted (`runnerKey(id)`).
   * Omitted: every runner the namespace counted for. **An empty list answers
   * nothing**, never everything: a caller restricted to no runner must not
   * fall through to all of them. A runner filtered out is absent from the
   * answer, not a row of zeros.
   */
  runners?: readonly string[];
}

/** One runner's row of a grouped read: its key, and its totals over the range. */
export interface RunnerMetricsTotals extends RunnerRunTotals {
  /** The runner's stored key, as counted (`runnerKey(id)`). Never the roll-up. */
  runner: string;
}

/**
 * What a grouped worker read asks for: a range, and optionally which queues'
 * workers.
 */
export interface WorkerMetricsTotalsQuery extends MetricsQuery {
  /**
   * Whether to total the busyness too, at this query's `interval`. Off by
   * default, as on {@link WorkerMetricsQuery.busyness}.
   */
  busyness?: boolean;
  /**
   * Only the workers of these queues. Omitted: every queue. **An empty list
   * answers nothing**, never everything. The queue is the filter because it is
   * the permission boundary — a caller restricted by `queues` or
   * `listQueues: "authorized"` must never see a hidden queue's worker counted.
   */
  queues?: readonly string[];
}

/** One worker key's row of a grouped read: its identity, and its totals over the range. */
export interface WorkerMetricsTotals
  extends WorkerMetricsRef, WorkerJobTotals {}

/** One runner's series in a batch read: {@link RunnerMetricsRead}, named. */
export interface RunnerMetricsSeries extends RunnerMetricsRead {
  /** The runner's stored key, as asked for. */
  runner: string;
}

/** One worker key's series in a batch read: {@link WorkerMetricsRead}, named. */
export interface WorkerMetricsSeries
  extends WorkerMetricsRef, WorkerMetricsRead {}

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
   *
   * The stamp includes {@link JobRecord.processedBy}, built by
   * `attributionOf(opts)` in `attribution.ts` and written in the same
   * statement or script as `workerId`, replacing any earlier attempt's — on a
   * driver declaring {@link DriverCapabilities.jobAttribution}. Settles never
   * clear it. The same holds for {@link QueueDriver.claimJobs}.
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
  /**
   * Completes a job, for its lock holder only. Like every settle (`failJob`,
   * `buryJob`, the batched completion), it clears the lock and `workerId`
   * and keeps `processedBy`.
   */
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
  /**
   * Fails a job for good from outside its processor — `Job.fail()` — and
   * answers with the job as it now is, or `null` when nothing changed.
   *
   * A `waiting`, `delayed`, `failed` (retry pending) or `waiting-children`
   * job goes to `dead`, and so does an `active` one whose lock is still
   * `opts.token`; an active job without the token, a `completed` or `dead`
   * one, or no job at all is left alone and answers `null`. The write and the
   * check are one atomic step.
   *
   * Burying is what `failJob` does with `retry: false`, minus the lock: the
   * reason becomes `failedReason` and heads `stacktrace` (capped at
   * `keepStacktraces`), `finishedOn` is `now`, the lock is cleared and
   * `retention` applies, and a driver that counts throughput counts one
   * failure. `attemptsMade` is untouched — no attempt ran — and so is
   * `flow.recorded`: a buried child's outcome reaches its parent the way any
   * dead child's does, through maintenance.
   *
   * Optional, so a driver written against an earlier contract still compiles;
   * every built-in driver implements it.
   */
  buryJob?: (
    q: QueueRef,
    id: string,
    error: SerializedError,
    opts: {
      /** Retention for the dead job, as `failJob` applies it. */
      retention: Retention;
      /** How many stack traces it keeps. */
      keepStacktraces: number;
      /** The lock an active job must still be under to be buried. */
      token?: string;
    },
    now: number,
  ) => Promise<JobRecord | null>;
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
   * - **A new priority reorders a waiting job** among the others, and marks
   *   the job's priority explicit: it sets the priority bit of
   *   {@link StoredJobOptions.explicit} (and keeps `opts.priority` in step),
   *   so a later rewrite with a queue's stored defaults keeps it. A job with no
   *   mask (added before it existed) is left without one — a mask of only
   *   that bit would claim every other option was defaulted.
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
   * Empties one job's log, and says how many lines went.
   *
   * - **Refused while the job is `active`** — `{ status: "active" }`, nothing
   *   removed — and **checked in the same step as the removal**, as
   *   {@link QueueDriver.removeJob} checks it: a job claimed between a caller
   *   reading it and calling this keeps every line its worker writes.
   * - **No such job** is `{ status: "missing" }`, removing nothing — not even
   *   lines a removed job might have left behind under the id, which
   *   {@link QueueDriver.addJobLog} already guarantees no later job sees.
   * - **Afterwards the log reads as one that was never written.** Every
   *   driver derives the count {@link QueueDriver.getJobLogs} and
   *   {@link QueueDriver.addJobLog} answer with from the lines it stores —
   *   there is no separate counter — so the lines must actually go: the next
   *   `addJobLog` answers `1`, `keep` trims from there, and `getJobLogs`
   *   counts `0` until then. A driver that owns lines through a per-job token
   *   (the SQL and MongoDB `log_key`) may delete the token's lines or give the
   *   job a new token; either way no line written before the clear may be
   *   counted or read after it.
   * - Only the job's log changes. Its record, its state and every counter,
   *   throughput figure and analytics series stay exactly as they were.
   *
   * Optional, as {@link QueueDriver.addJobLog} is: a driver without it has
   * the route pruned, and `BunQueue.clearJobLogs` throws `NotSupportedError`.
   */
  clearJobLogs?: (q: QueueRef, id: string) => Promise<ClearJobLogsResult>;
  /**
   * Writes `request.values` over the options of pending jobs, walking
   * `request.states` in order from `request.cursor`, examining at most
   * `request.limit` jobs — the storage half of applying a queue's stored job
   * defaults to jobs already waiting.
   *
   * The rules, which the shared driver contract checks:
   *
   * - **Per job, atomic, state re-checked.** A job's `opts`, `maxAttempts` and
   *   `priority` change in one write that re-checks the job is still in
   *   `states` — {@link JobPatch.onlyIn}'s guarantee. A job claimed first is
   *   not written (counted `moved` where the backend can see it); one claimed
   *   after reads the whole rewritten record. `active`, `completed` and `dead`
   *   jobs are never written.
   * - **Explicit keys are kept.** A key whose bit is set in `opts.explicit` is
   *   not written, per job; a job whose every changing key is explicit is
   *   `skippedExplicit`. A job with no `opts.explicit` is `skippedUnmarked`
   *   unless `includeUnmarked`, which treats it as all-defaulted. The mask
   *   itself is never changed.
   * - **Priority reorders** a waiting job exactly as `updateJob` does, keeping
   *   its FIFO place among equal priorities.
   * - **A keyset walk, never an offset.** Each state is walked in a fixed
   *   order from the cursor. A job moved ahead of the cursor by its own
   *   rewrite may be met again, and counts `unchanged`; no job that was in a
   *   walked state for the whole walk is skipped.
   * - **A dry run writes nothing** and counts exactly as the real call would.
   * - Bounded: a call's writes block claims for at most a few milliseconds at a
   *   time on a backend where a write blocks them (a Redis script, a SQLite
   *   transaction).
   *
   * An `attempts` lower than a job's `attemptsMade` is written, not clamped,
   * and counted `exhausted`.
   *
   * Optional: without it the apply route is pruned; saving defaults still
   * works, since that needs only queue state.
   */
  rewritePendingOptions?: (
    q: QueueRef,
    request: PendingOptionsRewrite,
  ) => Promise<PendingOptionsRewriteResult>;
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
   *   `error` as its reason — `"buried"`. Except a stale one, decided from
   *   an earlier view of the child: when the child's own record, read in the
   *   same atomic step as the bury (under the parent's hold, transaction or
   *   script), exists and either has `flow.recorded === true` (its failure
   *   was delivered already — it buried this parent, which has been retried
   *   since) or is in any state but `dead` (it has been retried since), the
   *   answer is `"already"`, with nothing changed. A child with no record
   *   still buries the parent, and so does one `dead` and unrecorded.
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
   * The parent's own `flow.recorded` is reset to `false` in the same step, as
   * `retryJob` resets a retried job's: the outcome it ends with this time has
   * not reached its own parent. Without it, a nested parent retried and
   * buried again would have that failure refused by its parent's
   * `recordChild` as already delivered, stranding the flow.
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
   *
   * Always the natural order: {@link JobQuery.sort} is a `findJobs` field
   * only, for the reason every filter is — a driver written before it would
   * ignore an unknown option.
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
   *
   * The attribution filters reach this only on a driver declaring
   * {@link DriverCapabilities.jobAttribution}, for the same reason: a
   * `findJobs` written before them would ignore them. {@link JobQuery.sort}
   * `"createdAt"` reaches it only on a driver implementing
   * {@link QueueDriver.countAddedJobs}, which promises to honour it.
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
   * Of the jobs **added** in a range — `createdAt` in `[range.from, range.to)`,
   * `from` inclusive and `to` exclusive — how many are in each state **now**,
   * per queue: every queue of the namespace, or only `queue` when given.
   *
   * - **Only jobs still stored.** A job retention or a remove, clean, drain or
   *   obliterate has deleted is not counted, so the states sum to the jobs
   *   added in the range that are still there — not to every job ever added.
   * - **Every state of a queue present is present**, zero where none is in
   *   it. A queue with no job in the range may be absent, and one other than
   *   `queue`, when given, must be. `countAdded` in `readApis.ts` fills both
   *   in for a caller.
   * - `range.to <= range.from` matches nothing: answer `{}` without reading.
   * - Confined to `ns`, like everything else.
   *
   * `inAddedRange`, `emptyAddedCounts` and `countAddedByScan` in `added.ts`
   * are the definition, and the shared driver contract compares each backend
   * against them.
   *
   * **Implementing this also promises {@link JobQuery.sort}.** Both read by
   * `createdAt` and are served by the same backends, so one method stands for
   * both: a driver implementing it must honour `sort: "createdAt"` in its
   * {@link QueueDriver.findJobs} (a driver without `findJobs` is sorted by the
   * scan fallback). The management API reports the pair as the single
   * `features.addedByState`.
   *
   * Optional, and with no fallback: without it the queue refuses the sort,
   * and the API prunes the counts routes and reports the flag `false`.
   * Implement it only where the answer is bounded by an index or by memory,
   * never by reading every job record — a UI polls it.
   */
  countAddedJobs?: (
    ns: string,
    range: AddedRange,
    queue?: string,
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
  /**
   * One queue's throughput at an arbitrary width — what
   * {@link QueueDriver.getThroughput} is, generalised past the minute.
   *
   * The same counts, read at the width the request resolved to, so a minute
   * query answers exactly what `getThroughput` answers and a second query
   * answers the per-second buckets beside them. It is a separate method rather
   * than a third argument because `getThroughput` is shipped API: widening it
   * would change what an existing driver has to implement.
   *
   * Sparse and oldest first. Optional, and with no fallback.
   */
  getQueueMetrics?: (
    q: QueueRef,
    query: MetricsQuery,
  ) => Promise<CounterBucket<JobCounters>[]>;
  /**
   * Counts jobs one **worker** finished, keyed by its stable
   * {@link WorkerInfo.key}.
   *
   * **The worker counts its own, in memory, and writes once a second.** The
   * driver knows the lock token, not the worker, so attributing a completion
   * inside the queue's hot script would push per-worker cardinality into the
   * one path that must stay cheap — this feature is not willing to buy that.
   * One writer per series is also why there are no shards here.
   *
   * Keyed by `key`, never by {@link WorkerInfo.id}: an id is an incarnation, so
   * a rolling redeploy would shred the series into a new one per replica.
   *
   * Like {@link RunnerDriver.countRunnerRun}, one call writes every width and
   * bumps the namespace roll-up.
   *
   * Optional, alongside {@link QueueDriver.getWorkerMetrics}.
   */
  countWorkerJobs?: (
    q: QueueRef,
    key: string,
    at: number,
    counts: Partial<JobCounters>,
  ) => Promise<void>;
  /**
   * Records one busyness sample for a worker: how many jobs it had in flight,
   * and what it was allowed to run at once.
   *
   * **Sampled on the heartbeat, not counted.** The worker's `reportInterval`
   * (10 s by default) is the only moment busyness is observed, so this is
   * called from the report and costs no I/O of its own beyond the row, and a
   * busyness series is served at its own, coarser resolution. There is
   * deliberately no second timer: an idle worker would then write once a
   * second forever, which is the one cost here not bounded by activity.
   *
   * `at` is when the sample was taken — kept, not just floored, so that merging
   * two writers' rows can take `concurrency` from the later one.
   *
   * Optional even for a driver that has {@link QueueDriver.countWorkerJobs}:
   * without it, a worker's series carries throughput and no busyness, which is
   * exactly what the busyness fields being optional on the wire means.
   */
  sampleWorkerBusyness?: (
    q: QueueRef,
    key: string,
    at: number,
    sample: BusynessSample,
  ) => Promise<void>;
  /**
   * One worker's buckets: the jobs it finished, and its busyness when that was
   * asked for and recorded.
   *
   * Keyed by {@link WorkerInfo.key}, so it answers for the worker across
   * restarts rather than for one incarnation. A key the backend never counted
   * for reads as no buckets, not an error.
   *
   * Sparse and oldest first. Optional, alongside
   * {@link QueueDriver.countWorkerJobs}.
   */
  getWorkerMetrics?: (
    q: QueueRef,
    key: string,
    query: WorkerMetricsQuery,
  ) => Promise<WorkerMetricsRead>;
  /**
   * **Every** worker key's totals over a range, in one read — the rows of
   * `GET /analytics/workers`, which rank by `completed` and cap at
   * `MAX_ANALYTICS_ROWS`. With 200 workers a read per key was 200 round trips
   * a poll; this is one.
   *
   * One row per `(queue, key)` with something to report over the range: a
   * counted job or — when `busyness` was asked for and is recorded — a
   * heartbeat sample. A key with nothing is **absent, not zero**, and so is
   * every worker of a queue outside `query.queues`. The namespace roll-up
   * (`NAMESPACE_ENTITY`) is never a row. Order is unspecified; each
   * pair appears once.
   *
   * A row is exactly what `workerTotalsOf(getWorkerMetrics(...))` gives for
   * that pair (`drivers/metrics.ts`); the contract suite compares the two.
   * When busyness was asked for and is recorded, every row carries it, with
   * `samples: 0` for a key that did not report in range.
   *
   * Whether a worker is still live is not its business: a key that stopped
   * reporting keeps its counts, and the caller's own listing decides which
   * rows it shows.
   *
   * Optional, as a set with {@link QueueDriver.getWorkerMetricsMany}.
   */
  getWorkerMetricsTotals?: (
    ns: string,
    query: WorkerMetricsTotalsQuery,
  ) => Promise<WorkerMetricsTotals[]>;
  /**
   * Several named worker keys' series, in one read — the `keys=` batch of
   * `GET /analytics/workers`, at most `MAX_ANALYTICS_SERIES` pairs (enforced
   * by the route, not the driver).
   *
   * Each entry is exactly what {@link QueueDriver.getWorkerMetrics} answers
   * for that `(queue, key)` — sparse, oldest first, `busyness` present when
   * asked for and recorded — plus its identity. A pair with nothing in range
   * (no job bucket and, when asked, no busyness bucket) is **absent**, not an
   * entry of empty arrays. A pair asked for twice is answered once
   * (`uniqueWorkerRefs`); order is unspecified.
   *
   * Optional, as a set with {@link QueueDriver.getWorkerMetricsTotals}.
   */
  getWorkerMetricsMany?: (
    ns: string,
    workers: readonly WorkerMetricsRef[],
    query: WorkerMetricsQuery,
  ) => Promise<WorkerMetricsSeries[]>;
  /**
   * The namespace's own roll-up buckets. Identical to
   * {@link RunnerDriver.getNamespaceMetrics}, and declared on both halves
   * because each half writes some of the kinds; a `JobsDriver` implements it
   * once, for all three.
   */
  getNamespaceMetrics?: (
    ns: string,
    query: NamespaceMetricsQuery,
  ) => Promise<NamespaceMetricsRead>;
  /** What this driver records and serves. See {@link RunnerDriver.getMetricsSupport}. */
  getMetricsSupport?: () => MetricsSupport;
  /**
   * Writes the analytics counts gathered in memory. See
   * {@link RunnerDriver.flushMetrics}, which this is the same method as.
   */
  flushMetrics?: () => Promise<void>;
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
  /**
   * Promotes every `delayed` or `failed` job whose `runAt` has passed, up to
   * `limit`, and reports when the next one comes due.
   *
   * Every driver in this package resolves a {@link PromoteDelayedResult}: the
   * count, plus the earliest `runAt` still scheduled once the promotion is
   * done, read in the same round trip where the backend allows it. That is
   * what lets an idle worker budget its wait without a separate
   * {@link QueueDriver.nextDelayedAt} call.
   *
   * A plain `number` (the count alone) is still accepted, for a driver
   * written against the older contract: the worker then asks
   * `nextDelayedAt` itself, as it always did. `readPromotion` reads either
   * shape.
   */
  promoteDelayed: (
    q: QueueRef,
    now: number,
    limit: number,
  ) => Promise<number | PromoteDelayedResult>;
  /**
   * Recovers jobs whose worker died holding them: back to `waiting`, or to
   * `dead` once they have stalled `maxStalledCount` times. Clears the lock
   * and `workerId`, but keeps `processedBy`: "last claimed by the worker that
   * died" is the diagnostic.
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
export type DriverConfig = {
  /**
   * What the driver built from this config records for analytics: the finest
   * bucket width, how long per-second buckets are kept, and whether worker,
   * runner and duration series are written. Everything is on by default, at
   * per-second resolution with five minutes of per-second retention.
   *
   * A config handed to a runner, worker or `BunJobs` that has its own
   * `metrics` option gets that option here unless it names its own, which
   * wins. `{ workers: false }` is the first lever for a large fleet. The file
   * driver records minutes only, whatever `resolution` asks for.
   */
  metrics?: MetricsOptions;
} & (
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
      /**
       * Exact table names, for an existing schema. Any subset; the rest are
       * defaulted. The keys are `SqlDriver`'s `SQL_TABLES`, spelled out rather
       * than derived: the SQL driver imports this module, so deriving them
       * would make the two import each other. `driver-config-names.type-test.ts`
       * pins them together instead, so a table added to that list fails the
       * typecheck until it is added here too.
       */
      tables?: Partial<
        Record<
          | "jobs"
          | "locks"
          | "kv"
          | "events"
          | "logs"
          | "run_logs"
          | "workers"
          | "metrics"
          | "queue_metrics"
          | "worker_metrics"
          | "runner_metrics",
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
      /**
       * Exact collection names, for an existing database. Any subset; the rest
       * are defaulted. The keys are `MongoDriver`'s `MONGO_COLLECTIONS`, spelled out for the
       * same reason as the SQL `tables` keys and pinned to that list the same
       * way.
       */
      collections?: Partial<
        Record<
          | "jobs"
          | "locks"
          | "kv"
          | "events"
          | "jobLogs"
          | "runLogs"
          | "metrics",
          string
        >
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
    }
);

/** A schedule stored alongside a runner's state. */
export type StoredSchedule = RunnerSchedule;
