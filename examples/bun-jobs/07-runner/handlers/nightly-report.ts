/**
 * A runner handler that enqueues queue jobs.
 *
 * The classic split: a scheduled runner *decides* what needs doing (query who
 * should get a report) and fans the work out as jobs, which any number of
 * workers then *do*. Retries, rate limits and dead letters apply per email
 * rather than to the whole run.
 *
 * `jobsFromContext(ctx)` builds a `BunJobs` on the runner's namespace and
 * backend in any execution mode: in-process it reuses the runner's driver; in
 * a child process or `Worker` it builds one from `ctx.driverConfig`.
 */
import { defineHandler, jobsFromContext } from "@kingsleyweb/bun-jobs";

/** Arguments a nightly report run accepts. */
export interface NightlyReportArgs {
  /** Who receives the report. */
  recipients: string[];
}

export default defineHandler<NightlyReportArgs, { queued: number }>(
  async (ctx) => {
    const jobs = jobsFromContext(ctx);

    try {
      const mail = jobs.queue<{ to: string; report: string }>("mail");
      const report = `report-${new Date(ctx.startedAt).toISOString().slice(0, 10)}`;

      const added = await mail.addBulk(
        ctx.args.recipients.map((to) => ({
          name: "send-report",
          data: { to, report },
          // One email per recipient per report, however often this reruns.
          opts: { jobId: `${report}:${to}`, attempts: 3 },
        })),
      );

      ctx.logger.info("queued report emails", { count: added.length });
      return { queued: added.filter((job) => job.wasAdded).length };
    } finally {
      // Closes what this context built; a driver it was lent stays open.
      await jobs.close();
    }
  },
);
