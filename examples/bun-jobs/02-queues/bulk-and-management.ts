/**
 * Bulk adds and queue management — counting, listing, pausing, draining,
 * cleaning.
 *
 * ```bash
 * bun 02-queues/bulk-and-management.ts
 * ```
 *
 * Everything here is what an admin endpoint or an ops script calls. None of
 * it needs the worker's process: `pause()` stops every worker on every host,
 * because the flag lives in the backend.
 */
import { BunQueue, BunQueueWorker, createDriver } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

/** One row of a CSV import. */
interface ImportRow {
  /** The row's line number in the file. */
  line: number;
  /** The email address on that row. */
  email: string;
}

title("Bulk adds and queue management");

const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("imports");
const imports = new BunQueue<ImportRow, void>("csv-import", {
  namespace,
  driver,
  // Keep completed jobs so there is something to count and clean below.
  defaultJobOptions: { removeOnComplete: false },
});

/* ------------------------------------------------------------------ */
step("addBulk: many jobs in one round trip");

const rows: ImportRow[] = Array.from({ length: 30 }, (_, index) => ({
  line: index + 1,
  email: `user${index + 1}@example.com`,
}));

const toEntry = (row: ImportRow) => ({
  name: "import-row",
  data: row,
  // An id derived from the input makes re-running the import safe.
  opts: { jobId: `line-${row.line}` },
});

const added = await imports.addBulk(rows.map(toEntry));
show("added", added.filter((job) => job.wasAdded).length);

const rerun = await imports.addBulk(rows.slice(0, 10).map(toEntry));
show(
  "re-running the first 10 added",
  rerun.filter((job) => job.wasAdded).length,
);

/* ------------------------------------------------------------------ */
step("count, list and update");

show("counts", await imports.count());
show(
  "first three waiting",
  (await imports.list("waiting", { limit: 3 })).map((job) => job.id),
);

// Jump the last row to the front of the queue.
const bumped = await imports.update("line-30", { priority: -1 });
show("line-30 priority is now", bumped?.priority);

/* ------------------------------------------------------------------ */
step("pause: workers everywhere stop claiming");

await imports.pause();
show("isPaused", await imports.isPaused());

const processed: number[] = [];
const worker = new BunQueueWorker<ImportRow, void>(
  "csv-import",
  async (job) => {
    processed.push(job.data.line);
    await Bun.sleep(10);
  },
  { namespace, driver, concurrency: 2 },
);
void worker.run();

await Bun.sleep(300);
show("processed while paused", processed.length);

step("resume: they start again");
// Workers cache the shared paused flag for about a second rather than reading
// it before every claim, so a resume (or a pause) reaches them within that.
await imports.resume();

await waitFor("ten rows", () => processed.length >= 10);
show("first row processed (the bumped one)", processed[0]);

/* ------------------------------------------------------------------ */
step("drain: drop whatever is still waiting");

await imports.pause();
// Let the jobs already claimed finish; drain never touches active jobs.
await worker.pause({ waitActive: true });

const dropped = await imports.drain();
show("dropped", dropped);
show("counts", await imports.count());

/* ------------------------------------------------------------------ */
step("clean: remove finished jobs older than a cutoff");

const removed = await imports.clean("completed", { olderThan: 0 });
show("removed completed jobs", removed.length);
show("counts", await imports.count());

await worker.close();
await imports.close();
await driver.purge(namespace);
await driver.close();
