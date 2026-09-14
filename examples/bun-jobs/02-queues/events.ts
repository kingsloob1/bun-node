/**
 * Events — what a queue and a worker tell you, and how to hear another
 * process's.
 *
 * ```bash
 * bun 02-queues/events.ts
 * ```
 *
 * - A **queue** emits what its producer did (`added`, `waiting`, `delayed`,
 *   `duplicate`, `paused`, `drained`, `cleaned`, ...).
 * - A **worker** emits what happened to the jobs it ran (`active`,
 *   `progress`, `completed`, `failed`, `retrying`, `dead`, `stalled`, ...).
 * - Every job event also fires under the job's name — `completed:refund` —
 *   so a listener for one kind of job need not filter.
 * - Across processes: a worker with `publish: true` announces its events, and
 *   a queue with `subscribe: true` re-emits them. A dashboard that never runs
 *   a job can watch every worker that does.
 */
import { BunQueue, BunQueueWorker, createDriver } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

/** The kinds of job on the `payments` queue. */
type PaymentJob = "charge" | "refund";

/** What a payment job carries. */
interface Payment {
  /** The order being paid for. */
  orderId: string;
  /** Amount in cents. */
  cents: number;
  /** How many attempts should fail before one succeeds; `99` never succeeds. */
  failures?: number;
}

title("Events");

const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("events");

/* ------------------------------------------------------------------ */
step("Producer-side events, on the queue");

const payments = new BunQueue<Payment, string, PaymentJob>("payments", {
  namespace,
  driver,
});

payments.on("added", (job) => show(`queue: added ${job.name} ${job.id}`));
payments.on("delayed", (job, runAt) => {
  show(`queue: ${job.id} delayed by ${runAt - Date.now()}ms`);
});
payments.on("duplicate", (job) => show(`queue: duplicate ${job.id} ignored`));

/* ------------------------------------------------------------------ */
step("Watching from somewhere else: a subscribed queue");

// In real life this is another process — an admin dashboard, say. It shares
// nothing with the worker but the backend, namespace and queue name.
const dashboard = new BunQueue<Payment, string, PaymentJob>("payments", {
  namespace,
  driver,
  subscribe: true,
});
let dashboardSaw = 0;
dashboard.on("completed", (job) => {
  dashboardSaw++;
  show(`dashboard: ${job.name} ${job.id} completed elsewhere`);
});
await dashboard.connect(); // opens the subscription now rather than lazily

/* ------------------------------------------------------------------ */
step("Consumer-side events, on the worker");

const worker = new BunQueueWorker<Payment, string>(
  "payments",
  async (job, ctx) => {
    await job.updateProgress(50);

    if (ctx.attempt <= (job.data.failures ?? 0)) {
      throw new Error(`card declined for ${job.data.orderId}`);
    }

    const verb = job.name === "refund" ? "refunded" : "charged";
    return `${verb} ${job.data.cents}c for ${job.data.orderId}`;
  },
  // `publish` is what lets the dashboard above hear this worker.
  { namespace, driver, concurrency: 2, publish: true },
);

let settled = 0;
worker.on("ready", () => show("worker: ready"));
worker.on("active", (job) => show(`worker: active ${job.id}`));
worker.on("progress", (job, value) => show(`worker: ${job.id} at ${value}%`));
worker.on("completed", (job, result) => {
  settled++;
  show(`worker: completed ${job.id}`, result);
});
worker.on("failed", (job, error) => {
  show(`worker: attempt failed ${job.id}`, error.message);
});
worker.on("retrying", (job, _error, runAt) => {
  show(`worker: ${job.id} retries in ${runAt - Date.now()}ms`);
});
worker.on("dead", (job, error) => {
  settled++;
  show(`worker: dead ${job.id}`, error.message);
});
worker.on("drained", () => show("worker: drained — nothing left to claim"));
worker.on("closing", () => show("worker: closing"));
worker.on("closed", () => show("worker: closed"));
worker.on("error", (error, context) => {
  console.error(`worker error during ${context}:`, error);
});

// Name-scoped: fires for `refund` jobs only, with the same arguments.
worker.on("completed:refund", (job) => {
  show(`worker: a REFUND completed (${job.data.orderId})`);
});

void worker.run();

/* ------------------------------------------------------------------ */
step("Adding jobs");

await payments.add("charge", { orderId: "A-1", cents: 1999 });
await payments.add(
  "charge",
  { orderId: "A-2", cents: 4500, failures: 1 },
  { attempts: 2, backoff: 50 },
);
await payments.add("refund", { orderId: "A-3", cents: 500 }, { delay: 100 });
await payments.add("charge", { orderId: "A-4", cents: 100, failures: 99 });
await payments.add(
  "refund",
  { orderId: "A-3", cents: 500 },
  { jobId: "refund-A-3" },
);
await payments.add(
  "refund",
  { orderId: "A-3", cents: 500 },
  { jobId: "refund-A-3" },
);

await waitFor("all five jobs to settle", () => settled === 5);
await waitFor(
  "the dashboard to hear the four completions",
  () => dashboardSaw === 4,
);

await worker.close();
await dashboard.close();
await payments.close();
await driver.purge(namespace);
await driver.close();
