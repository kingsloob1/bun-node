/**
 * The one file a summoned platform runs, as `02-queues/summoned-worker.ts`
 * starts it: `bun 02-queues/helpers/summoned-entry.ts --bun-jobs-summon-id=… …`.
 * Not meant to be run alone.
 *
 * The summoner's arguments name the namespace and queue; the backend comes
 * from `SUMMONED_DRIVER` (a driver config as JSON), and `SUMMONED_IDLE_FOR`
 * sets `idleFor`. Every decision `runSummoned` logs is written to stdout as
 * one JSON line, so the tour can read why the process exited — the last one,
 * "Summoned worker stopped", carries the whole `SummonedExit`.
 *
 * Its jobs: `quick` returns at once; `slow` works for `data.ms` and finishes
 * even when asked to stop, so a drain can be seen; `hang` never ends.
 */
import type { DriverConfig } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { BunJobs, runSummoned, summonedFromArgs } from "@kingsleyweb/bun-jobs";

/** What a job carries. */
interface Work {
  /** How long a `slow` job works, in ms. */
  ms?: number;
}

const summon = summonedFromArgs();
if (!summon?.namespace || !summon.queue) {
  throw new Error("run me with --bun-jobs-summon-namespace= and -queue=");
}

const jobs = new BunJobs({
  namespace: summon.namespace,
  driver: JSON.parse(process.env.SUMMONED_DRIVER!) as DriverConfig,
});
const worker = jobs.worker<Work, string>(
  summon.queue,
  async (job) => {
    if (job.name === "hang") {
      return await new Promise<never>(() => {});
    }
    if (job.name === "slow") {
      await Bun.sleep(job.data.ms ?? 0);
    }
    return `${job.name} done`;
  },
  { summon, pollInterval: 20, reportInterval: 200 },
);

await runSummoned(worker, {
  idleFor: Number(process.env.SUMMONED_IDLE_FOR ?? 500),
  idleCheckInterval: 50,
  logger: (event) => {
    console.log(
      JSON.stringify({ message: event.message, fields: event.fields }),
    );
  },
});
