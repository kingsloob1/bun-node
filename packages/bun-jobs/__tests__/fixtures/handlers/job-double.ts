import process from "node:process";
import { defineProcessor } from "../../../lib/index";

/** Doubles a number, and reports where it ran and what the channel returned. */
export default defineProcessor<
  { n: number },
  {
    doubled: number;
    pid: number;
    child: string | null;
    logged: number;
    lockHeld: boolean;
  }
>(async (job, ctx) => {
  await job.updateProgress(50);
  const logged = await ctx.log(`doubling ${job.data.n}`);
  await job.log("done");
  const lockHeld = await job.touch();

  return {
    doubled: job.data.n * 2,
    pid: process.pid,
    child: process.env.BUN_JOBS_CHILD ?? null,
    logged,
    lockHeld,
  };
});
