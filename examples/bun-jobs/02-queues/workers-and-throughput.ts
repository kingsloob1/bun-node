/**
 * Who is consuming a queue, how much it is getting through, and what every
 * queue in the namespace looks like — a dashboard, in one script.
 *
 * ```bash
 * bun 02-queues/workers-and-throughput.ts
 * EXAMPLE_DRIVER=sqlite bun 02-queues/workers-and-throughput.ts
 * ```
 *
 * Worth knowing:
 *
 * - A worker writes a heartbeat record on its `reportInterval` (10 seconds by
 *   default), **never per job**, so listing workers costs the backend nothing
 *   per job. The first report is not awaited, so a worker appears moments
 *   after `ready` rather than by it — wait for it rather than assuming.
 * - A record lapses three intervals after its last write: a worker that dies
 *   drops out of the list within 30 seconds by default, and one that closes
 *   removes its record at once.
 * - Throughput is counted by the *driver* as jobs finish, so it covers every
 *   worker in every process and outlives retention removing the jobs. `failed`
 *   counts every failed **attempt**, including ones that went on to be
 *   retried.
 * - `getQueueSummaries()` lives on `BunJobs` rather than `BunQueue`: it is a
 *   question about the namespace, and a queue knows only itself.
 */
import { BunJobs } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

/** An email waiting to go out. */
interface Email {
  /** Who it goes to. */
  to: string;
  /** Whether the fake transport should refuse it. */
  bounces?: boolean;
}

title("Workers, throughput and a queue dashboard");

const jobs = new BunJobs({
  namespace: exampleNamespace("dashboard"),
  driver: exampleDriver(),
});

// Keep finished jobs, so the per-state counts below have something to show.
// Throughput is counted as jobs finish and would survive their removal.
const keep = {
  defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
};
const emails = jobs.queue<Email, string>("emails", keep);
const thumbnails = jobs.queue<{ id: string }, string>("thumbnails", keep);

/* ------------------------------------------------------------------ */
step("Two workers, reporting often enough to watch");

const emailWorker = jobs.worker<Email, string>(
  "emails",
  async (job) => {
    if (job.data.bounces) {
      throw new Error(`mailbox full: ${job.data.to}`);
    }
    return `sent to ${job.data.to}`;
  },
  {
    id: "emails-1",
    concurrency: 4,
    // The default is 10 seconds. A short interval here only so the example
    // does not spend ten seconds waiting for the first heartbeat.
    reportInterval: 500,
    pollInterval: 25,
  },
);

const thumbnailWorker = jobs.worker<{ id: string }, string>(
  "thumbnails",
  async (job) => `thumbnail for ${job.data.id}`,
  { id: "thumbs-1", concurrency: 2, reportInterval: 500, pollInterval: 25 },
);

void emailWorker.run();
void thumbnailWorker.run();

// The first report is deliberately not awaited inside `run()`, so a worker is
// listed moments after it is ready. Wait for the record, never for a clock.
await waitFor(
  "both workers to report",
  async () => (await jobs.listWorkers()).length === 2,
);

/* ------------------------------------------------------------------ */
step("listWorkers: who is consuming, from any process");

for (const worker of await jobs.listWorkers()) {
  show(`${worker.queue} / ${worker.id}`, {
    host: worker.host,
    pid: worker.pid,
    concurrency: worker.concurrency,
    active: worker.active,
    paused: worker.paused,
    // The record stands until this moment unless the worker reports again.
    lapsesIn: `${worker.expiresAt - Date.now()}ms`,
  });
}

// `queue.listWorkers()` is the same read, narrowed to one queue.
show(
  "emails queue workers",
  (await emails.listWorkers()).map((worker) => worker.id),
);

/* ------------------------------------------------------------------ */
step("Do some work — including two jobs that fail every attempt");

await emails.addBulk([
  ...Array.from({ length: 8 }, (_, index) => ({
    name: "welcome",
    data: { to: `user${index + 1}@example.com` },
  })),
  // Two attempts each, with no wait between them: four failed attempts.
  {
    name: "welcome",
    data: { to: "full@example.com", bounces: true },
    opts: { attempts: 2, backoff: 0 },
  },
  {
    name: "digest",
    data: { to: "nobody@example.com", bounces: true },
    opts: { attempts: 2, backoff: 0 },
  },
]);

await thumbnails.addBulk(
  Array.from({ length: 5 }, (_, index) => ({
    name: "resize",
    data: { id: `img-${index + 1}` },
  })),
);

await waitFor(
  "every email to finish",
  async () =>
    (await emails.count("completed")) === 8 &&
    (await emails.count("dead")) === 2,
);
await waitFor(
  "every thumbnail to finish",
  async () => (await thumbnails.count("completed")) === 5,
);

/* ------------------------------------------------------------------ */
step("getThroughput: completions and failed attempts, a minute per bucket");

// A reader in this process sees its own counts: the drivers that gather
// counts in memory write them before answering.
const throughput = await emails.getThroughput({ minutes: 5 });

show("window", {
  minutes: throughput.buckets.length,
  bucket: `${throughput.interval}ms`,
  from: new Date(throughput.from).toISOString(),
  to: new Date(throughput.to).toISOString(),
});
show("completed", throughput.completed);
// Ten jobs were added and two died, but each of those two failed twice — and
// every failed attempt counts, retried or not.
show("failed attempts (2 jobs × 2 attempts)", throughput.failed);

for (const bucket of throughput.buckets) {
  const minute = new Date(bucket.at).toISOString().slice(11, 16);
  const bar = "#".repeat(bucket.completed) + "x".repeat(bucket.failed);
  show(`  ${minute}`, `${bar || "·"} (${bucket.completed}/${bucket.failed})`);
}

/* ------------------------------------------------------------------ */
step("getQueueSummaries: every queue in the namespace");

// Pausing is cluster-wide, and a summary says so — a dashboard's red light.
await thumbnails.pause();
await emails.add("welcome", { to: "later@example.com" }, { delay: 60_000 });

const summaries = await jobs.getQueueSummaries();

show("queues", summaries.length);
for (const summary of summaries) {
  const states = Object.entries(summary.counts)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${state}=${count}`)
    .join(" ");
  show(
    `  ${summary.name.padEnd(12)}${summary.paused ? "[paused]" : "        "}`,
    `${String(summary.total).padStart(3)} jobs   ${states}`,
  );
}

/* ------------------------------------------------------------------ */
step("A closing worker removes its record at once");

await emailWorker.close();
show(
  "workers after closing the email worker",
  (await jobs.listWorkers()).map((worker) => `${worker.queue}/${worker.id}`),
);

/* ------------------------------------------------------------------ */
step("Cleanup");

await jobs.purge();
// Closes the workers it started and the driver it built from the config.
await jobs.close();
