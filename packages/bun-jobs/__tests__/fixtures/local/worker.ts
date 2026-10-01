import type { DriverConfig } from "../../../lib/index";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, runSummoned, summonedFromArgs } from "../../../lib/index";

/**
 * The worker `localCompute` summons in the end-to-end test: the recipe a
 * user's entry follows. Its identity comes from its arguments; the driver
 * config from `LOCAL_TEST_DRIVER`, the summon policy's static `env`. It
 * prints one line per job (`processed <id> <pid>`) and exits once the queue
 * has been idle for `LOCAL_TEST_IDLE_MS` (default 500).
 */

const summon = summonedFromArgs();
if (summon?.namespace === undefined || summon.queue === undefined) {
  throw new Error("run me with --bun-jobs-summon-namespace= and -queue=");
}
const jobs = new BunJobs({
  namespace: summon.namespace,
  driver: JSON.parse(process.env.LOCAL_TEST_DRIVER!) as DriverConfig,
  logger: noopLogger,
});
const worker = jobs.worker(
  summon.queue,
  async (job) => {
    process.stdout.write(`processed ${job.id} ${process.pid}\n`);
    return { pid: process.pid };
  },
  { summon, concurrency: 2, pollInterval: 20, reportInterval: 200 },
);
await runSummoned(worker, {
  idleFor: Number(process.env.LOCAL_TEST_IDLE_MS ?? 500),
  idleCheckInterval: 50,
  logger: noopLogger,
});
