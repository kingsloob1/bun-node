import { defineProcessor } from "../../../lib/queue/types";

/** Appends one line to its log and returns the count the worker answered. */
export default defineProcessor<unknown, number>(
  async (job) => await job.log("one line"),
);
