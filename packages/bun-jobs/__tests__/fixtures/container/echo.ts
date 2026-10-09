import type { ProcessorContext } from "../../../lib/queue/types";
import type { IsolatedJob } from "../../../lib/runner/executors/executor";
import process from "node:process";

/**
 * A container processor that reports where it ran: its uid, its
 * environment's names, and `BUN_JOBS_MODE`. It prints to stdout and stderr
 * (which must become job log lines), logs and reports progress over the
 * channel, and echoes its data. Imports nothing at run time, so it loads in
 * any image that has bun-jobs.
 */
export default async (job: IsolatedJob, ctx: ProcessorContext) => {
  // eslint-disable-next-line no-console -- the output is what the test reads
  console.log("hello from the container");
  // eslint-disable-next-line no-console -- the output is what the test reads
  console.error("a line on stderr");
  await job.log("a line through the channel");
  await job.updateProgress(50);
  const lockHeld = await ctx.heartbeat().then(() => true);
  return {
    data: job.data,
    uid: process.getuid?.(),
    mode: process.env.BUN_JOBS_MODE,
    env: Object.keys(process.env).sort(),
    secret: process.env.I1_SECRET_PROBE ?? null,
    lockHeld,
    workerId: ctx.workerId,
  };
};
