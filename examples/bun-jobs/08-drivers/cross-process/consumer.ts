/**
 * A consumer process. Started by `main.ts`; everything arrives in the
 * environment. Runs until `SIGTERM`, then finishes what it holds and exits —
 * the shape of any worker service under a process manager or orchestrator.
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

// A running worker keeps the process alive (`waitToExit`, on by default), so
// this service stays up while the queue is idle until it is told to stop.
// `void` rather than a top-level `await`: nothing needs its result here.
void worker.run();

process.once("SIGTERM", async () => {
  // Stop claiming, let jobs in flight finish (up to 5s), close the backend.
  // `close()` holds the process open until it has fully settled.
  await jobs.close({ timeout: 5_000 });
  await Bun.write(Bun.stdout, `${JSON.stringify({ id, processed })}\n`);
  process.exit(0);
});
