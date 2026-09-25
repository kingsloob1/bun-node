/**
 * Fails every attempt — unrecoverably when the job says so — so
 * `worker-targets.ts` can see that an error crossing the process or thread
 * boundary still decides retries. Not meant to be run on its own.
 */
import { defineProcessor, UnrecoverableJobError } from "@kingsleyweb/bun-jobs";

/** What a failing job carries. */
export interface FailData {
  /** Throw an `UnrecoverableJobError` rather than a plain `Error`. */
  unrecoverable?: boolean;
}

export default defineProcessor<FailData>(async (job) => {
  if (job.data.unrecoverable) {
    throw new UnrecoverableJobError("the input can never be processed");
  }

  throw new Error(`attempt ${job.attemptsMade} failed`);
});
