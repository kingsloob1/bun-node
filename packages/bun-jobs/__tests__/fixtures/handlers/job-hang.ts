import process from "node:process";
import { defineProcessor } from "../../../lib/index";

/** Reports its process id, then ignores its signal and never finishes. */
export default defineProcessor(async (job) => {
  await job.updateProgress({ pid: process.pid });
  await new Promise(() => {});
});
