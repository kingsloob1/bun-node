/**
 * The one entry file a summon group's platform runs, for every queue of the
 * group: `02-queues/summon-groups.ts` starts it as
 * `bun 02-queues/helpers/summoned-group-entry.ts --bun-jobs-summon-id=… …`,
 * once for `emails` and once for `images`. Not meant to be run alone.
 *
 * It is the bun-jobs README's recipe ("One policy for several queues"): the
 * attempt's `--bun-jobs-summon-queue=` argument picks the processor from a
 * map, so one file serves the whole group. The backend comes from
 * `SUMMONED_DRIVER` (a driver config as JSON) and `SUMMONED_IDLE_FOR` sets
 * `idleFor`, so the tour's children exit soon after their work rather than
 * after the default 30 s.
 *
 * Each processor answers with the queue it was written for and this
 * process's pid, so the tour can tell which processor ran, and where.
 */
import type { DriverConfig, JobProcessor } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { BunJobs, runSummoned, summonedFromArgs } from "@kingsleyweb/bun-jobs";

/** What every processor here answers. */
interface Served {
  /** The queue the processor was written for. */
  processor: string;
  /** The job's name. */
  job: string;
  /** The process that ran it. */
  pid: number;
}

/** One processor per queue of the group. */
const processors: Record<string, JobProcessor<unknown, Served>> = {
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
const queue = summon?.queue ?? "emails";
const processor = processors[queue];
if (!processor) {
  throw new Error(`no processor for queue "${queue}"`);
}
const jobs = new BunJobs({
  namespace: summon?.namespace ?? "shop",
  driver: JSON.parse(process.env.SUMMONED_DRIVER!) as DriverConfig,
});
const worker = jobs.worker(queue, processor, {
  summon,
  pollInterval: 20,
  reportInterval: 200,
});
await runSummoned(worker, {
  idleFor: Number(process.env.SUMMONED_IDLE_FOR ?? 300),
  idleCheckInterval: 50,
}); // runs, then exits the process
