import type { IsolatedJob } from "../../../lib/runner/executors/executor";
import process from "node:process";

/**
 * Writes "50%" without a newline, then asks the worker to log a line: the
 * request must reach the worker (and be answered) despite the partial write.
 */
export default async (job: IsolatedJob) => {
  process.stdout.write("50%");
  const count = await job.log("after the partial write");
  return { count };
};
