/**
 * A queue processor file: `jobs.worker(name, file)` imports it and calls its
 * default export with each job, exactly as it would a function processor.
 */
import { defineProcessor } from "@kingsleyweb/bun-jobs";

/** What a doubling job carries. */
export interface DoubleData {
  /** The number to double. */
  n: number;
}

export default defineProcessor<DoubleData, number>((job) => {
  return job.data.n * 2;
});
