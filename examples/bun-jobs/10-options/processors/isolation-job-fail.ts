/**
 * Calls `job.fail()` from an isolated processor, so `worker-isolation.ts` can
 * see that it works in a child process and in a `Worker` as it does
 * in-process. What `fail()` answered is reported as progress. Not meant to be
 * run on its own.
 */
import { defineProcessor } from "@kingsleyweb/bun-jobs";

/** What a job failed from inside an isolated processor carries. */
export interface JobFailData {
  /**
   * `"string"`: fail with a string, then return normally. `"error"`: fail
   * with an `Error` that has a cause of its own, then throw.
   */
  how: "string" | "error";
}

export default defineProcessor<JobFailData>(async (job) => {
  if (job.data.how === "string") {
    const answered = await job.fail("the input can never be processed");
    await job.updateProgress({ answered });
    return "returned anyway";
  }

  const answered = await job.fail(
    new Error("card declined", { cause: new Error("gateway timeout") }),
  );
  await job.updateProgress({ answered });
  // The reason given to fail() wins over this.
  throw new Error("thrown after fail()");
});
