/**
 * Every default the package applies, named in one place.
 *
 * Options resolve against these in their constructors, so a default is
 * discoverable without reading the class that consumes it, and changing one
 * is a single edit.
 */

/** Default namespace prefix ahead of a namespace in a Redis key. */
export const DEFAULT_KEY_PREFIX = "bun-jobs";

/**
 * The package's own version, as a worker reports it in its heartbeat record.
 *
 * Written down rather than read from `package.json`, because the package
 * ships its sources and a consumer compiles them: a `package.json` import
 * would have to resolve from wherever the file landed in their tree. A test
 * pins it to the manifest, so it cannot quietly drift.
 */
export const JOBS_VERSION = "2.2.0";

/* --- runner ------------------------------------------------------- */

/** How long a runner's single-run lock lives before it is considered stale. */
export const DEFAULT_LOCK_TTL = 30_000;

/** Grace period after an IPC `close` before the child is sent `SIGTERM`. */
export const DEFAULT_CLOSE_TIMEOUT = 5_000;

/** Grace period after `SIGTERM` before the child is sent `SIGKILL`. */
export const DEFAULT_KILL_TIMEOUT = 2_000;

/** How long a spawned child has to report `ready` before the run fails. */
export const DEFAULT_START_TIMEOUT = 10_000;

/** How many run records a runner keeps in its history. */
export const DEFAULT_KEEP_HISTORY = 50;

/** How many triggers a `single`-mode runner queues while a run holds the lock. */
export const DEFAULT_MAX_QUEUED_RUNS = 100;

/** Cap on a run result stored in history, in bytes. */
export const DEFAULT_MAX_RESULT_BYTES = 16_384;

/** How often a runner re-reads its paused flag and schedule from the driver. */
export const DEFAULT_SYNC_INTERVAL = 30_000;

/* --- runner run logs ------------------------------------------------ */

// The streams a captured run-log line can come from, defined once in the
// contract (which imports nothing) and re-exported here, like
// `RUN_LOG_HINT_MS` below: the runtime importing the contract is what keeps
// the two from drifting.
export { RUN_LOG_STREAMS } from "../api/contract/constants";
export type { RunLogStream } from "../api/contract/constants";

/**
 * How many lines one run's log keeps, in lines.
 *
 * The oldest are dropped first, and how many were dropped is reported, so a
 * reader is told its log is a tail rather than shown a silently short one.
 * Matches {@link DEFAULT_KEEP_LOGS} for a job, for the same reason.
 */
export const DEFAULT_RUN_LOG_MAX_LINES = 1_000;

/**
 * How much of one run's log is kept, in bytes of line text (UTF-8).
 *
 * Applied alongside {@link DEFAULT_RUN_LOG_MAX_LINES}, because a thousand
 * lines is a very different amount of storage depending on how long they are.
 * Whichever cap bites first drops the oldest lines.
 */
export const DEFAULT_RUN_LOG_MAX_BYTES = 1_048_576;

/**
 * The longest a single captured line may be, in bytes of UTF-8 text.
 *
 * A line over this is truncated rather than dropped, and marked as truncated:
 * a run that writes a megabyte without a newline — a progress bar, a base64
 * blob — would otherwise be one "line" that spends the whole per-run byte cap
 * by itself.
 *
 * **Capture applies it, before the store's {@link DEFAULT_RUN_LOG_MAX_BYTES}
 * total; storage does not enforce it.** It lives here with its siblings
 * because the runner and the route both name it.
 */
export const DEFAULT_RUN_LOG_MAX_LINE_BYTES = 8_192;

/**
 * The most a single run may hand to the store over its whole life, in bytes.
 *
 * The per-run caps bound what is *kept*; this bounds what is *written*. A run
 * in a hot loop would otherwise keep a thousand lines while costing the
 * backend a write for every one of the million it produced. Past the ceiling
 * capture stops and says so.
 */
export const DEFAULT_RUN_LOG_CAPTURE_BYTES = 8_388_608;

/** How many buffered lines trigger a flush to the store. */
export const RUN_LOG_FLUSH_LINES = 64;

/** How many buffered bytes of line text trigger a flush to the store. */
export const RUN_LOG_FLUSH_BYTES = 65_536;

/** How long a partial buffer waits before it is flushed anyway, in ms. */
export const RUN_LOG_FLUSH_MS = 250;

/**
 * How long after a run settles its capture keeps draining, in milliseconds.
 *
 * A child's last writes are still in flight when it exits, so cutting capture
 * at the exit loses exactly the lines that explain a failure.
 */
export const RUN_LOG_GRACE_MS = 1_000;

/**
 * The least time between two `logs` hint events for one run, in milliseconds.
 *
 * The hint tells a subscriber that a run's stored log grew, so a tail can
 * re-read with `?since=` instead of polling blind. Flushes are not a rate
 * limit by themselves — a chatty run flushes every 64 lines, far more often
 * than every `RUN_LOG_FLUSH_MS` — so the hint is throttled separately: the
 * first append in a window is announced at once, the rest collapse into one
 * trailing hint carrying the newest `lastSeq`, and a run that settles
 * announces its last `lastSeq` without waiting out the window.
 *
 * Defined once, in the browser-safe contract (which imports nothing, so this
 * re-export creates no cycle), because a client names the same rate.
 */
export { RUN_LOG_HINT_MS } from "../api/contract/constants";

/* --- queue -------------------------------------------------------- */

/** How long a claimed job's lock lives before a stalled sweep may reclaim it. */
export const DEFAULT_LOCK_DURATION = 30_000;

/** How often a worker sweeps for jobs whose lock expired mid-flight. */
export const DEFAULT_STALLED_INTERVAL = 30_000;

/** How many times a job may stall before it is moved to the dead set. */
export const DEFAULT_MAX_STALLED = 1;

/** How long a worker waits between claim attempts on a polling driver. */
export const DEFAULT_POLL_INTERVAL = 1_000;

/** Longest a worker blocks waiting for work on a blocking driver. */
export const DEFAULT_MAX_BLOCK = 5_000;

/** How long a completed job's result is retained by default. */
export const DEFAULT_RESULT_TTL = 86_400_000;

/** How many stack traces a failing job keeps. */
export const DEFAULT_KEEP_STACKTRACES = 5;

/**
 * How many log lines a job keeps, newest last, when it names no `keepLogs`.
 * Enough for a long job's story; bounded so a chatty loop cannot grow one
 * record's log without end.
 */
export const DEFAULT_KEEP_LOGS = 1_000;

/** Default backoff between a job's attempts. */
export const DEFAULT_JOB_BACKOFF = {
  type: "exponential",
  delay: 1_000,
  max: 300_000,
  jitter: 0.1,
} as const;
