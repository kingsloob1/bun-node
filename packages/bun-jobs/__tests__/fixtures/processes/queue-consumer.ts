import type { DriverConfig } from "./shared";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { BunJobs, noopLogger } from "./shared";

/**
 * A consumer, as its own process.
 *
 * Every job it takes is appended to a shared log with this process's id, so
 * the test can prove that each job was processed exactly once and see which
 * consumer took it.
 */

const jobs = new BunJobs({
  namespace: process.env.NAMESPACE ?? "test",
  driver: JSON.parse(process.env.DRIVER_CONFIG ?? "{}") as DriverConfig,
  logger: noopLogger,
});

const consumerId = process.env.CONSUMER_ID ?? String(process.pid);
const log = process.env.RUN_LOG ?? "";
const failFirst = process.env.FAIL_FIRST === "1";
const seen = new Set<string>();

const worker = jobs.worker(
  process.env.QUEUE ?? "work",
  async (job) => {
    // A job that fails its first attempt proves a retry is picked up by
    // whichever consumer is free, not necessarily the one that failed it.
    if (failFirst && !seen.has(job.id)) {
      seen.add(job.id);
      throw new Error(`first attempt at ${job.id} failed`);
    }

    if (log) {
      appendFileSync(log, `${consumerId}:${job.id}\n`);
    }

    await Bun.sleep(Number(process.env.JOB_MS ?? 5));
    return { by: consumerId };
  },
  {
    id: consumerId,
    concurrency: Number(process.env.CONCURRENCY ?? 2),
    pollInterval: 20,
    maxBlock: 50,
    lockDuration: 2000,
    stalledInterval: 200,
  },
);

void worker.run();
console.log(JSON.stringify({ event: "ready", consumerId }));

// Consume until the deadline, then shut down cleanly.
await Bun.sleep(Number(process.env.RUN_FOR_MS ?? 2000));
await worker.close({ timeout: 2000 });

console.log(JSON.stringify({ event: "closed", consumerId }));
await jobs.close();
process.exit(0);
