import type { DriverConfig, JobProcessor } from "../../lib/index";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, runSummoned, summonedFromArgs } from "../../lib/index";

/**
 * One entry file for every queue of a summon group (`summon-groups.test.ts`):
 * the summoner starts this same file for `emails` and for `images`, and the
 * `--bun-jobs-summon-queue=` argument chooses the processor. Exactly the
 * recipe the README gives:
 *
 * ```ts
 * const summon = summonedFromArgs();
 * const queue = summon?.queue ?? "emails";
 * const worker = jobs.worker(queue, processors[queue], { summon });
 * await runSummoned(worker);
 * ```
 *
 * Test control — never identity — arrives in the environment:
 * `SUMMON_TEST_DRIVER`, the driver config as JSON.
 *
 * Prints one JSON line per fact: `ready` (with the queue it consumes), and
 * `exit` once `runSummoned` has stopped it for being idle.
 */

const say = (line: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

/** One processor per queue of the group; each says which one ran. */
const processors: Record<string, JobProcessor> = {
  emails: async (job) => ({
    processor: "emails",
    job: job.name,
    pid: process.pid,
  }),
  images: async (job) => ({
    processor: "images",
    job: job.name,
    pid: process.pid,
  }),
};

const summon = summonedFromArgs();
if (summon?.namespace === undefined || summon.queue === undefined) {
  throw new Error("run me with --bun-jobs-summon-namespace= and -queue=");
}
const processor = processors[summon.queue];
if (processor === undefined) {
  throw new Error(`no processor for queue "${summon.queue}"`);
}

const jobs = new BunJobs({
  namespace: summon.namespace,
  driver: JSON.parse(process.env.SUMMON_TEST_DRIVER!) as DriverConfig,
  logger: noopLogger,
});
const worker = jobs.worker(summon.queue, processor, {
  summon,
  pollInterval: 20,
  reportInterval: 200,
});
say({ event: "ready", pid: process.pid, queue: summon.queue });
const result = await runSummoned(worker, {
  idleFor: 300,
  idleCheckInterval: 50,
  exit: false,
});
await jobs.close();
say({
  event: "exit",
  pid: process.pid,
  queue: summon.queue,
  reason: result.reason,
});
process.exit(0);
