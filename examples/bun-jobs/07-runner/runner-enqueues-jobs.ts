/**
 * A runner that fans work out as queue jobs — the runner decides, workers do.
 *
 * ```bash
 * bun 07-runner/runner-enqueues-jobs.ts
 * ```
 *
 * The runner's handler (`handlers/nightly-report.ts`) runs in a *child
 * process* and adds one `send-report` job per recipient. A worker in this
 * process sends them. They meet in the backend.
 *
 * `jobs.runner()` hands the child the context's driver *config* automatically
 * (`childDriver`) — a driver instance cannot cross a process boundary, a
 * description of one can — and the handler rebuilds it with
 * `jobsFromContext(ctx)`.
 */
import type { NightlyReportArgs } from "./handlers/nightly-report";
import { BunJobs } from "@kingsleyweb/bun-jobs";
import { crossProcessDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

title("A runner that enqueues jobs");

const jobs = new BunJobs({
  namespace: exampleNamespace("reports"),
  // Two processes share it, so not the in-memory default.
  driver: crossProcessDriver(),
});

/* ------------------------------------------------------------------ */
step("The worker: sends each report email");

const sent: string[] = [];
const mailer = jobs.worker<{ to: string; report: string }, string>(
  "mail",
  async (job) => {
    await Bun.sleep(10);
    sent.push(job.data.to);
    return `sent ${job.data.report} to ${job.data.to}`;
  },
  { concurrency: 3, pollInterval: 25 },
);
mailer.on("completed", (_job, result) => {
  show("worker", result);
});
void mailer.run();

/* ------------------------------------------------------------------ */
step("The runner: decides who gets one, in a child process");

const nightly = jobs.runner<NightlyReportArgs, { queued: number }>({
  id: "nightly-report",
  file: new URL("./handlers/nightly-report.ts", import.meta.url),
  executionMode: "child-process",
  schedule: { cron: "0 2 * * *", tz: "UTC" }, // 02:00 UTC, in production
  args: {
    recipients: ["ceo@example.com", "cfo@example.com", "ops@example.com"],
  },
});

nightly.on("finished", (run, result) => {
  show(`runner finished (pid ${run.pid})`, result);
});
nightly.on("failed", (_run, error) => {
  show("runner failed", error.message);
});

await nightly.start();
show("next scheduled run", nightly.nextRunAt()?.toISOString());

// Don't wait until 02:00.
show("triggered", await nightly.trigger());

await waitFor("three report emails", () => sent.length === 3, {
  timeout: 20_000,
});

step("Running it again queues nothing new: the job ids are idempotent");

const again = new Promise<{ queued: number }>((resolve) => {
  nightly.once("finished", (_run, result) => resolve(result));
});
await nightly.trigger();
show("second run queued", (await again).queued);

await jobs.purge();
await jobs.close(); // stops the runner and the worker, closes the driver
