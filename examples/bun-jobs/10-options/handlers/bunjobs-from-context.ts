/**
 * A runner handler that reaches its backend through `jobsFromContext(ctx)`,
 * adds one job, and reports how the context it built was wired — so
 * `bunjobs-options.ts` can assert the in-process and spawned cases differ
 * exactly as documented.
 */
import { defineHandler, jobsFromContext } from "@kingsleyweb/bun-jobs";

/** Arguments the handler accepts. */
export interface FromContextArgs {
  /** The queue to add a job to. */
  queue: string;
}

/** What the handler found. */
export interface FromContextReport {
  /** Whether the context reused the runner's own driver instance. */
  usedDriverInstance: boolean;
  /** The context's `driverConfig`, or `null`. */
  driverConfig: unknown;
  /** The context's namespace. */
  namespace: string;
  /** The id of the job it added. */
  jobId: string;
}

export default defineHandler<FromContextArgs, FromContextReport>(
  async (ctx) => {
    const jobs = jobsFromContext(ctx);

    try {
      const job = await jobs
        .queue(ctx.args.queue)
        .add("from-handler", { mode: ctx.mode });
      return {
        usedDriverInstance:
          ctx.driver !== undefined && jobs.driver === ctx.driver,
        driverConfig: jobs.driverConfig ?? null,
        namespace: jobs.namespace,
        jobId: job.id,
      };
    } finally {
      // Closes a driver it built from a config; leaves a lent instance open.
      await jobs.close();
    }
  },
);
