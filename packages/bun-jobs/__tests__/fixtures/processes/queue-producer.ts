import type { DriverConfig } from "./shared";
import process from "node:process";
import { BunJobs, noopLogger } from "./shared";

/**
 * A producer, as its own process.
 *
 * It knows nothing about the consumers: it names a namespace, a queue and a
 * backend, and adds jobs. That is the whole contract.
 */

const jobs = new BunJobs({
  namespace: process.env.NAMESPACE ?? "test",
  driver: JSON.parse(process.env.DRIVER_CONFIG ?? "{}") as DriverConfig,
  logger: noopLogger,
});

const queue = jobs.queue(process.env.QUEUE ?? "work");
const count = Number(process.env.JOB_COUNT ?? 10);
const prefix = process.env.JOB_PREFIX ?? "job";
const ids: string[] = [];

for (let i = 0; i < count; i++) {
  const job = await queue.add(
    "process",
    { producer: prefix, index: i },
    {
      jobId: `${prefix}-${i}`,
      ...(process.env.JOB_PRIORITY
        ? { priority: Number(process.env.JOB_PRIORITY) }
        : {}),
      ...(process.env.JOB_BACKOFF
        ? { backoff: Number(process.env.JOB_BACKOFF) }
        : {}),
      ...(process.env.JOB_ATTEMPTS
        ? { attempts: Number(process.env.JOB_ATTEMPTS) }
        : {}),
      removeOnComplete: false,
    },
  );
  ids.push(job.id);
}

console.log(JSON.stringify({ event: "produced", ids }));

await jobs.close();
process.exit(0);
