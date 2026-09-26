/**
 * An isolated processor that reports where it ran and what the job channel
 * answered: its log, its lock, its heartbeats.
 *
 * Run by `worker-targets.ts` on each local target. Not meant to be run on
 * its own.
 */
import process from "node:process";
import { isMainThread } from "node:worker_threads";
import { defineProcessor } from "@kingsleyweb/bun-jobs";

/** What a report job carries. */
export interface ReportData {
  /** Written into the job's log, so each mode's log is recognisable. */
  label: string;
  /** How many times to call `ctx.heartbeat()` before returning. Defaults to `0`. */
  beats?: number;
  /** Milliseconds between heartbeats. Defaults to `0`. */
  beatEvery?: number;
  /**
   * How many extra progress values to report, back to back, before the final
   * `100`. Defaults to `0`: the processor then reports `25` and then `100`, as
   * every other step expects. A processor that reports per item makes a burst
   * like this, and it is what makes the *ordering* of an isolated
   * `updateProgress` observable — see `worker-targets.ts` step 2.
   */
  progressSteps?: number;
}

/** What a report job returns. */
export interface Report {
  /** The process id the processor ran in. */
  pid: number;
  /** Whether it ran on a process's main thread (false inside a `Worker`). */
  isMainThread: boolean;
  /**
   * `BUN_JOBS_CHILD`, set to `"1"` on a `"worker-thread"` or `"child-process"`
   * target (by the runner's worker-thread and child-process executors, which they share).
   */
  child: string | null;
  /**
   * `BUN_JOBS_MODE`, the executor that started it, in the target's own word:
   * `"worker-thread"` or `"child-process"`, unset in-process.
   */
  mode: string | null;
  /**
   * `TOUR_ISOLATION_ENV`, set through the target's `spawn.env` or
   * `worker.env`.
   */
  env: string | null;
  /** The working directory it ran in. */
  cwd: string;
  /** Its `process.argv`, to see `spawn.args` and `worker.argv`. */
  argv: string[];
  /** `ctx.workerId`. */
  workerId: string;
  /** `ctx.attempt`. */
  attempt: number;
  /** `job.id`. */
  jobId: string;
  /** `job.queue`. */
  queue: { ns: string; queue: string };
  /** `job.isRepeat`. */
  isRepeat: boolean;
  /** Whether `job.lockToken` was a non-empty string. */
  hasLockToken: boolean;
  /** `job.toJSON().id`. */
  recordId: string;
  /** What `job.log()` and then `ctx.log()` answered: the log's line count. */
  logged: number[];
  /** What `job.touch()` answered. */
  touched: boolean;
  /** What `job.extendLock()` answered. */
  extended: boolean;
  /** How many heartbeats it sent. */
  heartbeats: number;
}

export default defineProcessor<ReportData, Report>(async (job, ctx) => {
  await job.updateProgress(25);
  const first = await job.log(`hello from ${job.data.label}`);
  const second = await ctx.log("second line");
  ctx.logger.info("isolated logger line", { label: job.data.label });

  const touched = await job.touch();
  const extended = await job.extendLock();

  let heartbeats = 0;
  for (let beat = 0; beat < (job.data.beats ?? 0); beat++) {
    await Bun.sleep(job.data.beatEvery ?? 0);
    await ctx.heartbeat();
    heartbeats++;
  }

  // Back to back, each awaited: every one is a message to the worker, and the
  // final `100` below must be the value the store keeps.
  for (
    let reported = 1;
    reported <= (job.data.progressSteps ?? 0);
    reported++
  ) {
    await job.updateProgress(reported);
  }

  await job.updateProgress(100);

  return {
    pid: process.pid,
    isMainThread,
    child: process.env.BUN_JOBS_CHILD ?? null,
    mode: process.env.BUN_JOBS_MODE ?? null,
    env: process.env.TOUR_ISOLATION_ENV ?? null,
    cwd: process.cwd(),
    argv: [...process.argv],
    workerId: ctx.workerId,
    attempt: ctx.attempt,
    jobId: job.id,
    queue: job.queue,
    isRepeat: job.isRepeat,
    hasLockToken: typeof job.lockToken === "string" && job.lockToken.length > 0,
    recordId: job.toJSON().id,
    logged: [first, second],
    touched,
    extended,
    heartbeats,
  };
});
