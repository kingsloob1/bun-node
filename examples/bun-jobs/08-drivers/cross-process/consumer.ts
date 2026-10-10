/**
 * A consumer process. Started by `main.ts`; everything arrives in the
 * environment. Runs until `SIGTERM`, then finishes what it holds and exits —
 * the shape of any worker service under a process manager or orchestrator.
 *
 * It writes two lines to stdout: `{ id, ready: true }` once a `SIGTERM` will
 * be handled, and `{ id, processed, error? }` when it stops.
 */
import type { DriverConfig } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { BunJobs } from "@kingsleyweb/bun-jobs";

const id = process.env.CONSUMER_ID ?? `consumer-${process.pid}`;

const jobs = new BunJobs({
  namespace: process.env.NAMESPACE ?? "fleet",
  driver: JSON.parse(process.env.DRIVER_CONFIG ?? "{}") as DriverConfig,
});

let processed = 0;

const worker = jobs.worker<{ orderId: string }, { by: string }>(
  "orders",
  async () => {
    await Bun.sleep(5 + Math.random() * 15); // uneven work, so consumers interleave
    processed++;
    return { by: id };
  },
  { id, concurrency: 4, pollInterval: 25 },
);

worker.on("error", (error, context) => {
  console.error(`[${id}] worker error during ${context}:`, error);
});

process.once("SIGTERM", async () => {
  // Stop claiming, let jobs in flight finish (up to 5s), close the backend.
  // `close()` holds the process open until it has fully settled. Whatever it
  // does, the process reports before it exits: a failed close goes in the
  // report rather than leaving the parent with nothing to read.
  let error: string | undefined;
  try {
    await jobs.close({ timeout: 5_000 });
  } catch (caught) {
    error =
      caught instanceof Error
        ? `${caught.name}: ${caught.message}`
        : String(caught);
  }
  await Bun.write(Bun.stdout, `${JSON.stringify({ id, processed, error })}\n`);
  process.exit(error === undefined ? 0 : 1);
});

// A running worker keeps the process alive (`waitToExit`, on by default), so
// this service stays up while the queue is idle until it is told to stop.
// `void` rather than `await`: `run()` settles only once the worker stops.
void worker.run();

// Until the handler above is installed, a `SIGTERM` takes its default action
// and kills the process on the spot, reporting nothing. Say when that window
// has closed, as a readiness probe would, so the parent never stops a
// consumer that cannot yet stop gracefully.
await Bun.write(Bun.stdout, `${JSON.stringify({ id, ready: true })}\n`);
