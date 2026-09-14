/**
 * A job's lifecycle — changing it before it runs, watching it run, reading
 * its log, and bringing it back after it dies.
 *
 * ```bash
 * bun 02-queues/job-lifecycle.ts
 * ```
 *
 * States: `delayed` → `waiting` → `active` → `completed`, or → `failed`
 * (between attempts) → `dead` (attempts exhausted). A `Job` is an immutable
 * view of the stored record; every method that changes it answers with a fresh
 * view, and `refresh()` re-reads what another process may have changed.
 */
import { BunQueue, BunQueueWorker, createDriver } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

/** A document to render. */
interface RenderDocument {
  /** The document's title. */
  title: string;
  /** How many pages to render; a negative count makes the job fail. */
  pages: number;
}

title("Job lifecycle");

const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("lifecycle");
const documents = new BunQueue<RenderDocument, string>("documents", {
  namespace,
  driver,
});

/* ------------------------------------------------------------------ */
step("Changing a job before it runs");

const job = await documents.add(
  "render",
  { title: "Q3 report (draft)", pages: 6 },
  { delay: 60 * 60_000 }, // an hour from now
);
show("added", { id: job.id, state: job.state, priority: job.priority });

await job.updateData({ title: "Q3 report (final)", pages: 10 });
await job.setPriority(-1);
// Words, a Date or epoch milliseconds.
const moved = await job.reschedule("in 30 minutes");
show("after updateData, setPriority and reschedule", {
  data: moved?.data,
  priority: moved?.priority,
  runsInMinutes: Math.round(((moved?.runAt ?? 0) - Date.now()) / 60_000),
});

// A producer can write to the job's log too, not only the processor.
await job.log("approved by finance");

/* ------------------------------------------------------------------ */
step("Running it now, and watching progress");

const worker = new BunQueueWorker<RenderDocument, string>(
  "documents",
  async (current, ctx) => {
    if (current.data.pages < 0) {
      throw new RangeError(`cannot render ${current.data.pages} pages`);
    }

    for (let page = 1; page <= current.data.pages; page++) {
      await Bun.sleep(5);
      await current.updateProgress(
        Math.round((page / current.data.pages) * 100),
      );

      if (page % 5 === 0) {
        await ctx.log(`rendered page ${page}`);
      }
    }

    return `${current.data.title}.pdf`;
  },
  { namespace, driver },
);

worker.on("progress", (current, value) => {
  if (value === 50 || value === 100) {
    show(`job ${current.id} progress`, `${value}%`);
  }
});
void worker.run();

// Delayed jobs can be made claimable immediately.
await job.promote();
show("state after promote", (await job.refresh())?.state);

await waitFor(
  "the report to complete",
  async () => (await job.refresh())?.state === "completed",
);

const done = await job.refresh();
show("returnValue", done?.returnValue);
show("progress", done?.progress);

// The log outlives the attempt and is readable from any process.
const { logs, count } = await documents.getJobLogs(job.id);
show(`log (${count} lines)`, logs);

/* ------------------------------------------------------------------ */
step("A job that dies, is fixed, and is retried");

const broken = await documents.add(
  "render",
  { title: "corrupt upload", pages: -1 },
  { attempts: 2, backoff: 50 },
);

await waitFor(
  "the broken job to die",
  async () => (await broken.refresh())?.state === "dead",
);

const dead = await broken.refresh();
show("state", dead?.state);
show(
  "failedReason",
  `${dead?.failedReason?.name}: ${dead?.failedReason?.message}`,
);
show("attempts made", dead?.attemptsMade);

// Fix the data, then return it to the queue with its attempts reset.
await documents.update(broken.id, {
  data: { title: "corrupt upload (repaired)", pages: 2 },
});
show("retried", await broken.retry());

await waitFor(
  "the repaired job to complete",
  async () => (await broken.refresh())?.state === "completed",
);
show("repaired job's result", (await broken.refresh())?.returnValue);

/* ------------------------------------------------------------------ */
step("Removing a job that is no longer wanted");

const unwanted = await documents.add(
  "render",
  { title: "cancelled order", pages: 1 },
  { delay: 60_000 },
);
show("removed", await unwanted.remove());
show("still stored", (await documents.getJob(unwanted.id)) !== null);

await worker.close();
await documents.close();
await driver.purge(namespace);
await driver.close();
