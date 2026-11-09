import { defineProcessor } from "../../../lib/queue/types";

/**
 * Reports progress and returns as soon as its last update resolves — the
 * shape that showed a stale progress value to a reader seeing `completed`.
 */
export default defineProcessor<unknown, string>(async (job) => {
  await job.updateProgress(10);
  await job.updateProgress(100);
  return "done";
});
