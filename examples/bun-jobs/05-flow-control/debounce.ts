/**
 * Debounce — many adds, one job, with the latest data.
 *
 * ```bash
 * bun 05-flow-control/debounce.ts
 * ```
 *
 * A document autosaves on every keystroke; reindexing it on each save is
 * wasted work. With `debounce: { id, ttl }`, while a job added under that id
 * has not started, a further add *replaces its data* and pushes its run time
 * back to `ttl` from now. Once it has started, the next add is a new job.
 *
 * The same through the registry's builder:
 *
 * ```ts
 * await jobs.run("reindex", { docId }).debounce(docId, "30 seconds").start();
 * ```
 */
import { BunQueue, BunQueueWorker, createDriver } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

/** What a reindex job carries. */
interface Reindex {
  /** The document to reindex. */
  docId: string;
  /** Which save triggered it. */
  revision: number;
}

title("Debounce");

const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("search");
const queue = new BunQueue<Reindex, void>("search-index", {
  namespace,
  driver,
});

/** Every reindex that actually ran, in order. */
const reindexed: Reindex[] = [];

const worker = new BunQueueWorker<Reindex, void>(
  "search-index",
  async (job) => {
    reindexed.push(job.data);
    show(`reindexing ${job.data.docId}`, `revision ${job.data.revision}`);
  },
  { namespace, driver, pollInterval: 25 },
);
void worker.run();

queue.on("debounced", (job) => {
  show(`debounced into ${job.id}`, `now carries revision ${job.data.revision}`);
});

/* ------------------------------------------------------------------ */
step("Five saves of doc-1, 80ms apart, debounced by 300ms");

const ids = new Set<string>();
for (let revision = 1; revision <= 5; revision++) {
  const job = await queue.add(
    "reindex",
    { docId: "doc-1", revision },
    { debounce: { id: "doc-1", ttl: 300 } },
  );
  ids.add(job.id);
  await Bun.sleep(80);
}

// A different id is debounced separately.
await queue.add(
  "reindex",
  { docId: "doc-2", revision: 1 },
  { debounce: { id: "doc-2", ttl: "300ms" } },
);

show("distinct jobs behind the five doc-1 adds", ids.size);

await waitFor("doc-1 and doc-2 to be reindexed", () => reindexed.length === 2);
show("what ran", reindexed);

/* ------------------------------------------------------------------ */
step("Once it has started, the next save is a new job");

await queue.add(
  "reindex",
  { docId: "doc-1", revision: 6 },
  { debounce: { id: "doc-1", ttl: 100 } },
);
await waitFor("revision 6", () => reindexed.length === 3);

/* ------------------------------------------------------------------ */
step("cleanWindows: drop pointers that no longer stand for anything");

// Each debounce id leaves a small pointer. Workers sweep them once a minute;
// this does it now — e.g. from a maintenance script.
show("pointers removed", await queue.cleanWindows());

await worker.close();
await queue.close();
await driver.purge(namespace);
await driver.close();
