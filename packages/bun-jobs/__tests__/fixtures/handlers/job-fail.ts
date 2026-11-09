// The package root on purpose, as an application's processor imports it: this
// and `environment.ts` keep that path covered in every mode. Other fixtures
// take `defineProcessor` from `lib/queue/types`, since each job loads them afresh.
import { defineProcessor, UnrecoverableJobError } from "../../../lib/index";

/** Fails every attempt: unrecoverably when the job says so. */
export default defineProcessor<{ unrecoverable?: boolean }>(async (job) => {
  if (job.data.unrecoverable) {
    throw new UnrecoverableJobError("no point retrying this one");
  }

  throw new Error(`attempt ${job.attemptsMade} failed`);
});
