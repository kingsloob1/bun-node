/**
 * Timeouts, cancellation, graceful shutdown and stalled-job recovery.
 *
 * ```bash
 * bun 06-failures/timeouts-and-cancellation.ts
 * ```
 *
 * A processor receives `ctx.signal`, aborted when its attempt times out, the
 * worker closes, or its lock is lost. JavaScript cannot stop a function from
 * outside, so work that checks the signal stops promptly and work that
 * ignores it runs on, unobserved.
 *
 * What protects the job when a process dies is the **lock**: a worker renews
 * it while a job runs. A worker that crashes stops renewing, the lock lapses,
 * and any other worker's stalled sweep returns the job to the queue. Work is
 * delayed, never lost.
 */
import type { DriverConfig } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { BunQueue, BunQueueWorker, createDriver } from "@kingsleyweb/bun-jobs";
import {
  crossProcessDriver,
  exampleDriver,
  exampleNamespace,
} from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

/** What an export job carries. */
interface Export {
  /** How many rows to write. */
  rows: number;
}

title("Timeouts, cancellation and stalled jobs");

const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("exports");
const exports = new BunQueue<Export, number>("exports", { namespace, driver });

/**
 * Writes rows until done or asked to stop, reporting each one. The check of
 * `signal` between rows is what makes the attempt cancellable.
 */
async function writeRows(
  rows: number,
  signal: AbortSignal,
  onRow: (row: number) => Promise<void>,
): Promise<number> {
  for (let row = 1; row <= rows; row++) {
    signal.throwIfAborted();
    await Bun.sleep(10);
    await onRow(row);
  }
  return rows;
}

/* ------------------------------------------------------------------ */
step("1. A per-attempt timeout aborts the signal");

const worker = new BunQueueWorker<Export, number>(
  "exports",
  async (job, ctx) => {
    return await writeRows(job.data.rows, ctx.signal, async (row) => {
      await job.updateProgress(row);
    });
  },
  { namespace, driver, pollInterval: 20 },
);
void worker.run();

const tooBig = await exports.add("export", { rows: 1_000 }, { timeout: 200 });
await waitFor("the oversized export to die", async () => {
  return (await tooBig.refresh())?.state === "dead";
});
const timedOut = await tooBig.refresh();
show("state", timedOut?.state);
show("rows written before the abort", timedOut?.progress);
show("reason", timedOut?.failedReason?.message);

/* ------------------------------------------------------------------ */
step("2. close() waits for jobs in flight");

const small = await exports.add("export", { rows: 15 });
await waitFor("the small export to start", async () => {
  return (await small.refresh())?.state === "active";
});

show("closing the worker while the job runs");
// Waits up to `timeout` for jobs in flight, then aborts their signals.
// `close({ force: true })` aborts at once and does not wait.
await worker.close({ timeout: 5_000 });
show("closed; the job's state is", (await small.refresh())?.state);

await exports.close();
await driver.purge(namespace);
await driver.close();

/* ------------------------------------------------------------------ */
step("3. A worker process is killed holding a job; another recovers it");

// A crash needs a second process, and so a backend two processes share. On
// the memory default, a temporary SQLite file stands in.
const sharedConfig: DriverConfig = crossProcessDriver();
const sharedDriver = createDriver(sharedConfig);
const shared = new BunQueue<Export, number>("exports", {
  namespace,
  driver: sharedDriver,
});

const orphan = await shared.add("export", { rows: 5 });

// Both processes take the same short `stalledInterval`, and the child's matters
// as much as the rescuer's. One worker per queue runs the repair sweeps, under
// a lease it renews on its own sweep cadence, and the lease lasts twice that
// cadence. So a holder that is killed hands the sweeps over on *its* cadence —
// a fast survivor cannot shorten someone else's lease. At the defaults that is
// 90 seconds, far longer than this example waits, which is why the cadence is
// set small on both sides rather than only on the rescuer.
const child = Bun.spawn(
  [
    process.execPath,
    new URL("./helpers/crashing-consumer.ts", import.meta.url).pathname,
  ],
  {
    env: {
      ...process.env,
      NAMESPACE: namespace,
      DRIVER_CONFIG: JSON.stringify(sharedConfig),
      LOCK_DURATION: "500",
      STALLED_INTERVAL: "100",
    },
    stdout: "ignore",
    stderr: "inherit",
  },
);

await waitFor("the child process to claim the job", async () => {
  return (await orphan.refresh())?.workerId === "doomed-worker";
});
show("child claimed it", {
  pid: child.pid,
  state: (await orphan.refresh())?.state,
});

child.kill("SIGKILL");
await child.exited;
show("child killed with SIGKILL; job state", (await orphan.refresh())?.state);

const rescuer = new BunQueueWorker<Export, number>(
  "exports",
  async (job, ctx) => {
    return await writeRows(job.data.rows, ctx.signal, async () => {});
  },
  {
    namespace,
    driver: sharedDriver,
    id: "rescuer",
    pollInterval: 20,
    stalledInterval: 100, // sweep for lapsed locks every 100ms (default 30s)
  },
);
rescuer.on("stalled", (ids) => {
  show("rescuer recovered stalled jobs", ids);
});
void rescuer.run();

await waitFor("the orphaned export to complete", async () => {
  return (await orphan.refresh())?.state === "completed";
});
const recovered = await orphan.refresh();
show("returnValue", recovered?.returnValue);
show("stalledCount", recovered?.stalledCount);

await rescuer.close();
await shared.close();
await sharedDriver.purge(namespace);
await sharedDriver.close();
