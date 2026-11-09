/**
 * A processor file for `BunJobsModule.registerWorker`: runs wherever its target
 * puts it, with no Nest around it. Answers with the thread and process it ran
 * on, so a test can see the target applied.
 */
import { isMainThread } from "node:worker_threads";
import process from "node:process";
import { defineProcessor } from "@kingsleyweb/bun-jobs";

export default defineProcessor(async (job) => ({
  name: job.name,
  mainThread: isMainThread,
  pid: process.pid,
}));
