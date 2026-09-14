/**
 * Job options — priority, delays, retries, timeouts, idempotency, retention.
 *
 * ```bash
 * bun 02-queues/job-options.ts
 * ```
 *
 * Everything here is an option on `queue.add(name, data, options)`; the same
 * options can be set as a queue's `defaultJobOptions`, or on a `BunJobs`
 * definition, and are merged in that order (built-in ← queue ← call).
 */
import {
  BunQueue,
  BunQueueWorker,
  createDriver,
  JobTimeoutError,
} from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { elapsed, show, step, title, waitFor } from "../shared/console";

/** The kinds of job this example adds. */
type TaskName = "report" | "flaky" | "slow" | "once";

/** Every job here carries a label and nothing else. */
interface Task {
  /** What to print when it runs. */
  label: string;
}

title("Job options");

const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("options");
const queue = new BunQueue<Task, string, TaskName>("tasks", {
  namespace,
  driver,
});

/** Labels of `report` jobs, in the order they ran. */
const ranInOrder: string[] = [];
/** Ids of jobs that completed or died, so each section can wait for its own. */
const settled = new Set<string>();

const worker = new BunQueueWorker<Task, string>(
  "tasks",
  async (job, ctx) => {
    switch (job.name as TaskName) {
      case "report":
        ranInOrder.push(job.data.label);
        return job.data.label;

      case "flaky":
        // `ctx.attempt` is 1-based. Fail the first two attempts.
        if (ctx.attempt < 3) {
          throw new Error(`upstream timed out (attempt ${ctx.attempt})`);
        }
        return `succeeded on attempt ${ctx.attempt}`;

      case "slow":
        // Takes a second unless the signal fires first — which it will, since
        // the job was added with a 150ms timeout.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 1_000);
          ctx.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(ctx.signal.reason);
            },
            { once: true },
          );
        });
        return "finished (should not happen)";

      default:
        return `ran at ${elapsed()}`;
    }
  },
  {
    namespace,
    driver,
    // Concurrency 1 makes the priority order visible.
    concurrency: 1,
    // How often an idle worker looks again. A delayed job becomes due while
    // the worker is waiting, so this bounds how late past its time it can
    // start. The 1000ms default suits production; a demo wants it snappier.
    // (Redis does not poll: it blocks and wakes within about a millisecond.)
    pollInterval: 50,
  },
);

worker.on("completed", (job) => settled.add(job.id));
worker.on("dead", (job, error) => {
  settled.add(job.id);
  show(`job ${job.id} (${job.name}) died`, `${error.name}: ${error.message}`);
});
worker.on("retrying", (job, error, runAt) => {
  show(
    `job ${job.id} will retry in ${runAt - Date.now()}ms`,
    `after "${error.message}"`,
  );
});

/* ------------------------------------------------------------------ */
step("priority: lower runs first, ties run in the order they were added");

// Added before the worker starts, so all three are waiting together.
await queue.add("report", { label: "weekly digest" }, { priority: 10 });
await queue.add("report", { label: "ad-hoc export" }); // priority 0
await queue.add("report", { label: "incident summary" }, { priority: -5 });

void worker.run();
await waitFor("three reports", () => ranInOrder.length === 3);
show("ran in order", ranInOrder);

/* ------------------------------------------------------------------ */
step("delay and runAt: not claimable until then");

const delayed = await queue.add("once", { label: "delay" }, { delay: 300 });
const scheduled = await queue.add(
  "once",
  { label: "runAt" },
  { runAt: new Date(Date.now() + 150) },
);
show("states right after adding", [delayed.state, scheduled.state]);

await waitFor("both delayed jobs", () => {
  return [delayed, scheduled].every((job) => settled.has(job.id));
});
show("runAt job's result", (await scheduled.refresh())?.returnValue);
show("delay job's result", (await delayed.refresh())?.returnValue);

/* ------------------------------------------------------------------ */
step("attempts and backoff: retry a failing job");

const flaky = await queue.add(
  "flaky",
  { label: "call partner API" },
  {
    attempts: 3, // total, including the first
    backoff: { type: "exponential", delay: 100 }, // 100ms, then 200ms
    keepStacktraces: 3, // keep the errors of the failed attempts
  },
);
await waitFor("the flaky job", () => settled.has(flaky.id));

const flakyDone = await flaky.refresh();
show("result", flakyDone?.returnValue);
show(
  "errors kept from failed attempts",
  flakyDone?.stacktrace.map((error) => error.message),
);

/* ------------------------------------------------------------------ */
step("timeout: an attempt that runs too long is aborted");

const slow = await queue.add(
  "slow",
  { label: "generate a huge PDF" },
  { timeout: 150 },
);
await waitFor("the slow job", () => settled.has(slow.id));

const slowDone = await slow.refresh();
show("state", slowDone?.state);
// Errors are stored flattened and rehydrated as plain `Error`s, so compare by
// name rather than with `instanceof`.
show(
  "failedReason",
  `${slowDone?.failedReason?.name}: ${slowDone?.failedReason?.message}`,
);
show(
  "is a JobTimeoutError",
  slowDone?.failedReason?.name === new JobTimeoutError(150).name,
);

/* ------------------------------------------------------------------ */
step("jobId: an idempotency key — adding it twice adds one job");

queue.on("duplicate", (job) => show("duplicate add ignored", job.id));

const invoice = await queue.add(
  "once",
  { label: "invoice #2026-09" },
  { jobId: "invoice-2026-09" },
);
const retried = await queue.add(
  "once",
  { label: "invoice #2026-09 (resent)" },
  { jobId: "invoice-2026-09" },
);
show("first add created it", invoice.wasAdded);
show("second add created it", retried.wasAdded);
show("data is still the first add's", retried.data.label);

await waitFor("the invoice job", () => settled.has(invoice.id));

/* ------------------------------------------------------------------ */
step("retention: what happens to a finished job");

const ephemeral = await queue.add(
  "once",
  { label: "remove me when done" },
  { removeOnComplete: true },
);
await waitFor("the ephemeral job", () => settled.has(ephemeral.id));
show("removeOnComplete: true — still stored", !!(await ephemeral.refresh()));

const kept = await invoice.refresh();
show(
  "default retention — kept for 24h, expiresAt in",
  `${Math.round(((kept?.expiresAt ?? 0) - Date.now()) / 3_600_000)}h`,
);

await worker.close();
await queue.close();
await driver.purge(namespace);
await driver.close();
