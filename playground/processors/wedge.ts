import process from "node:process";
import { defineProcessor } from "@kingsleyweb/bun-jobs";

/**
 * A processor that **ignores its abort signal** — the case only
 * `target: "child-process"` can answer.
 *
 * It stands in for the third-party library everybody has: a synchronous
 * import that takes a minute, checks nothing, and cannot be persuaded to
 * stop. In-process there is no remedy at all — the worker's thread is gone
 * until the loop below finishes, timeout or no timeout. In a `Worker` the
 * thread can be terminated. In a child process it can be killed for certain,
 * which is what the `imports` worker does:
 *
 * 1. the job's `timeout` elapses, so the worker aborts the attempt;
 * 2. the executor asks the child to close, and waits `closeTimeout`;
 * 3. nothing happens (this processor is not listening), so `SIGTERM`;
 * 4. still nothing, so after `killTimeout`, `SIGKILL`.
 *
 * The job then fails with a `JobTimeoutError` and — with `attempts` left —
 * is retried in a fresh child. The worker itself never stops claiming.
 *
 * Nothing here is a mistake to be fixed: the spinning is the demonstration.
 * It is bounded by `spinMs` so a playground left running cannot accumulate
 * live children even if every kill somehow failed.
 */

/** What a wedged import job carries. */
export interface WedgeData {
  /** The archive being pretended to import, for the log line. */
  archive: string;
  /**
   * How long the processor blocks its thread, in ms. Longer than the job's
   * `timeout`, so the kill is always what ends it. Defaults to `60_000`.
   */
  spinMs?: number;
}

/** What a wedged import job would answer with, if it were ever allowed to finish. */
export interface WedgeResult {
  /** The archive it claims to have imported. */
  archive: string;
  /** How many times round the blocking loop it went. */
  spins: number;
  /** The pid that ran it — its own, since this only runs in a child process. */
  pid: number;
}

export default defineProcessor<WedgeData, WedgeResult>(async (job, ctx) => {
  await job.log(
    `importing ${job.data.archive} with a library that never checks its signal (pid ${process.pid})`,
  );
  await job.updateProgress({ step: "blocked", done: 0, of: 1 });

  // Deliberately never read. A well-behaved processor awaits this and unwinds;
  // this one is the other kind, which is the whole point of the queue it is on.
  void ctx.signal;

  const until = Date.now() + (job.data.spinMs ?? 60_000);
  let spins = 0;
  while (Date.now() < until) {
    spins++;
  }

  // Unreachable in practice: the `imports` worker's jobs time out long before.
  return { archive: job.data.archive, spins, pid: process.pid };
});
