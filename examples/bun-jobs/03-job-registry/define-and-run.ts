/**
 * The job registry — define jobs by name once, add them from anywhere.
 *
 * ```bash
 * bun 03-job-registry/define-and-run.ts
 * ```
 *
 * `jobs.define(name, handler, defaults)` records what a job *is*: how to run
 * it, and the options every job of that name gets — retries, timeout,
 * backoff. Call sites then only say *when* and *with what*:
 *
 * - `jobs.now(name, data, options?)`            — as soon as possible
 * - `jobs.run(name).in("5 minutes").start()`   — after a delay
 * - `jobs.process(name).on(date).start()`      — at a moment
 * - `jobs.schedule(name).every("1 hour").start()` — repeatedly
 *
 * `schedule`, `run` and `process` are the same method under three names; use
 * whichever reads best. Nothing is added until `start()`.
 */
import { BunJobs, ConfigError } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

/** What an invoice job carries. */
interface Invoice {
  /** The customer being billed. */
  customerId: string;
  /** Amount, in cents. */
  amountCents: number;
}

/** What a CRM sync job carries. */
interface CrmSync {
  /** The user whose record to sync. */
  userId: string;
}

title("Job registry: define and run");

const jobs = new BunJobs({
  namespace: exampleNamespace("billing"),
  driver: exampleDriver(),
  // Defaults under every job added through this context.
  defaultJobOptions: { removeOnComplete: false },
});

/* ------------------------------------------------------------------ */
step("define: a handler and the defaults for every job of that name");

jobs.define<Invoice, { pdf: string }>(
  "generateInvoice",
  async (job, ctx) => {
    await ctx.log(`billing ${job.data.customerId}`);
    await Bun.sleep(15);
    return { pdf: `invoices/${job.data.customerId}-${job.id}.pdf` };
  },
  {
    attempts: 3,
    backoff: { type: "exponential", delay: 500 },
    timeout: 30_000,
  },
);

jobs.define<CrmSync, string>("syncCrm", async (job) => {
  await Bun.sleep(5);
  return `synced ${job.data.userId}`;
});

jobs.define("heartbeat", () => new Date().toISOString());

show(
  "defined",
  jobs.definitions().map(({ name, options }) => ({ name, options })),
);

/* ------------------------------------------------------------------ */
step("start: one worker runs every defined name");

const worker = await jobs.start({ concurrency: 4, pollInterval: 50 });

let completed = 0;
worker.on("completed", (job, result) => {
  completed++;
  show(`${job.name} completed`, result);
});

/* ------------------------------------------------------------------ */
step("now, run().in(), process().on(), schedule().every()");

const invoice = await jobs.now("generateInvoice", {
  customerId: "cus_42",
  amountCents: 12_900,
});
// The definition's defaults reached the job without the call site saying so.
show("invoice job's attempts and timeout", {
  attempts: invoice.opts.attempts,
  timeout: invoice.opts.timeout,
});

// Per-call options go on top of the definition's; the rest are kept.
const urgent = await jobs.now(
  "generateInvoice",
  { customerId: "cus_7", amountCents: 990 },
  { priority: -10 },
);
show("urgent invoice", {
  priority: urgent.priority,
  attempts: urgent.opts.attempts,
});

await jobs.run<CrmSync>("syncCrm", { userId: "u_1" }).in("300ms").start();

await jobs
  .process<CrmSync>("syncCrm")
  .withData({ userId: "u_2" })
  .on(new Date(Date.now() + 500))
  .start();

await jobs
  .schedule("heartbeat")
  .every("200ms")
  .immediately() // first occurrence now, then every 200ms
  .limit(3) // three occurrences in total
  .start();

/* ------------------------------------------------------------------ */
step("A name nobody defined is refused where it is added");

try {
  await jobs.now("sendFax", { to: "+1 555 0100" });
} catch (error) {
  if (error instanceof ConfigError) {
    show("ConfigError", error.message);
  } else {
    throw error;
  }
}

await waitFor("2 invoices, 2 syncs and 3 heartbeats", () => completed === 7);

show("queues in this namespace", await jobs.listQueues());

await jobs.purge();
await jobs.close();
