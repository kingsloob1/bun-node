import type { IsolatedJob } from "../../../lib/runner/executors/executor";

/** Returns a string of `job.data.bytes` characters. */
export default async (job: IsolatedJob) =>
  "x".repeat((job.data as { bytes: number }).bytes);
