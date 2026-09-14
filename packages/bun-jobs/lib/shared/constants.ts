/**
 * Every default the package applies, named in one place.
 *
 * Options resolve against these in their constructors, so a default is
 * discoverable without reading the class that consumes it, and changing one
 * is a single edit.
 */

/** Default namespace prefix ahead of a namespace in a Redis key. */
export const DEFAULT_KEY_PREFIX = "bun-jobs";

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
