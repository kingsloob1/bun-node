import { defineProcessor } from "../../../lib/index";

/**
 * Reports progress for as long as it is allowed to — including after its
 * `opts.timeout` has passed and the worker has stopped waiting for it. Every
 * value it sends once the attempt is over must be dropped rather than written
 * over the failed job's own.
 */
export default defineProcessor<unknown, string>(async (job) => {
  // Bounded rather than endless: 50 seconds of reporting outlives any deadline
  // a test sets, and the loop still ends if the child is somehow never stopped.
  for (let value = 1; value <= 2000; value++) {
    await job.updateProgress(value);
    await Bun.sleep(25);
  }
  return "done";
});
