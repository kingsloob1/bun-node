import type { IsolatedJob } from "../../../lib/runner/executors/executor";

/** Prints `job.data.lines` lines of 100 characters to stdout, then returns. */
export default async (job: IsolatedJob) => {
  const { lines } = job.data as { lines: number };
  for (let i = 0; i < lines; i++) {
    // eslint-disable-next-line no-console -- the output is what the test reads
    console.log(`${String(i).padStart(6, "0")} ${"y".repeat(93)}`);
  }
  return lines;
};
