import { defineProcessor } from "../../../lib/index";

/**
 * Logs one line and then overruns whatever `opts.timeout` the test gives it.
 *
 * The line is *awaited*, so the child is inside the round trip when the
 * deadline passes and the write is certainly in flight — the shape that showed
 * a failure record written before a log line the worker had already been
 * handed.
 */
export default defineProcessor<unknown, string>(async (job) => {
  await job.log("halfway");
  // Longer than any deadline a test sets: the worker gives up on this run and
  // stops the child where it stands.
  await Bun.sleep(30_000);
  return "done";
});
