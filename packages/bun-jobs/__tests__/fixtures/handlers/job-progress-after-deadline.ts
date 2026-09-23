import { defineProcessor } from "../../../lib/index";

/**
 * Reports progress every 25ms for five seconds, ignoring its abort signal —
 * long enough to outlive any deadline a test sets, short enough to be gone
 * soon after the test that used it.
 *
 * Run `"in-process"` nothing stops it: the worker has given up on the attempt
 * but the function keeps going, and every value it reports from then on
 * belongs to a job whose failure has already been written.
 */
export default defineProcessor<unknown, string>(async (job) => {
  for (let value = 1; value <= 200; value++) {
    await job.updateProgress(value);
    await Bun.sleep(25);
  }

  return "done";
});
