import { defineProcessor, UnrecoverableJobError } from "../../../lib/index";

/** Fails every attempt: unrecoverably when the job says so. */
export default defineProcessor<{ unrecoverable?: boolean }>(async (job) => {
  if (job.data.unrecoverable) {
    throw new UnrecoverableJobError("no point retrying this one");
  }

  throw new Error(`attempt ${job.attemptsMade} failed`);
});
