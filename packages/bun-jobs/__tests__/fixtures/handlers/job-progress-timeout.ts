import { defineProcessor } from "../../../lib/index";

/**
 * Reports progress once and then overruns whatever `opts.timeout` the test
 * gives it — the shape that showed a failure record written before the
 * progress value the processor had already handed to the worker.
 */
export default defineProcessor<unknown, string>(async (job) => {
  await job.updateProgress(50);
  // Longer than any deadline a test sets: the worker gives up on this run and
  // stops the child where it stands.
  await Bun.sleep(30_000);
  return "done";
});
