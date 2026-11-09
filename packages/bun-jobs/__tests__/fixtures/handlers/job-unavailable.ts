import { defineProcessor } from "../../../lib/queue/types";

/** Tries an operation an isolated job cannot do, and returns what it was told. */
export default defineProcessor<unknown, string>(async (job) => {
  try {
    await job.updateData({ changed: true });
    return "no error";
  } catch (error) {
    return (error as Error).message;
  }
});
