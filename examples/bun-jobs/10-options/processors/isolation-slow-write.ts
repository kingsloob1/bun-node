/**
 * A processor whose one write is deliberately unfinished at the moment the
 * worker records how its job ended — the two ways that happens.
 *
 * It reports a progress value and waits for it, and it logs a line and does
 * not. `worker-targets.ts` runs it against a driver that holds those two
 * writes back, so the ordering its step 3 asserts is a certainty rather than a
 * race: the progress write is still in flight when the job's deadline passes,
 * and the log write is still in flight when the processor returns.
 *
 * Not meant to be run on its own.
 */
import { defineProcessor } from "@kingsleyweb/bun-jobs";

/** What a slow-write job carries. */
export interface SlowWriteData {
  /**
   * A progress value to report and wait for. Left out, none is reported.
   *
   * The wait is the point: the tour holds this write until past the job's
   * `timeout`, so the processor is still inside `updateProgress` when the
   * worker gives up on the attempt.
   */
  progress?: number;
  /**
   * A line to log without waiting for it. Left out, nothing is logged.
   *
   * `job.log()` puts its request on the job channel straight away, so the
   * worker has the line before it has the result — but the write it starts is
   * still in flight when the attempt ends.
   */
  line?: string;
}

export default defineProcessor<SlowWriteData, string>(async (job) => {
  if (job.data.progress !== undefined) {
    // Awaited. On a worker thread or in a child process this means the worker
    // has the value and will write it; in-process it is the driver write
    // itself, and the one the tour holds past the deadline.
    await job.updateProgress(job.data.progress);
  }

  if (job.data.line !== undefined) {
    // Deliberately not awaited: nothing here waits for the line to be stored,
    // and the processor returns while the write is on its way.
    void job.log(job.data.line).catch(() => undefined);
  }

  return "returned";
});
