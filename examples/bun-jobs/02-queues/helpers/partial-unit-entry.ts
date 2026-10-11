/**
 * An entry file that serves only some of the queues its summon names, as
 * `02-queues/summon-shared-unit.ts` starts it:
 * `bun 02-queues/helpers/partial-unit-entry.ts --bun-jobs-summon-id=… --bun-jobs-summon-queue=renders …`.
 * Not meant to be run alone.
 *
 * It stands in for an entry script that forgot a queue, or one older than
 * shared units, which reads one queue and builds one worker. It builds a
 * worker only for the queues in `PARTIAL_QUEUES` (comma-separated) and runs
 * them itself, with `run()`: `runSummoned(workers)` would refuse a set
 * missing a queue the arguments name before anything ran, which is the
 * right way to write a unit, and not the mistake shown here.
 *
 * The backend comes from `SUMMONED_DRIVER` (a driver config as JSON). It
 * prints one JSON line, `workers` (each queue's worker id), and runs until
 * SIGTERM, when it closes its workers and exits 0.
 */
import type { DriverConfig } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { BunJobs, summonedFromArgs } from "@kingsleyweb/bun-jobs";

const summon = summonedFromArgs();
if (!summon?.namespace || !summon.queues) {
  throw new Error("run me with --bun-jobs-summon-namespace= and -queue=");
}

const jobs = new BunJobs({
  namespace: summon.namespace,
  driver: JSON.parse(process.env.SUMMONED_DRIVER!) as DriverConfig,
});
const serving = process.env.PARTIAL_QUEUES!.split(",");
const workers = serving.map((queue) =>
  jobs.worker(queue, async () => ({ processor: queue, pid: process.pid }), {
    summon,
    pollInterval: 20,
    reportInterval: 200,
  }),
);

process.once("SIGTERM", () => {
  void (async () => {
    await Promise.all(workers.map(async (worker) => await worker.close()));
    await jobs.close();
    process.exit(0);
  })();
});

for (const worker of workers) {
  void worker.run();
}
console.log(
  JSON.stringify({
    message: "workers",
    fields: {
      ids: Object.fromEntries(
        workers.map((worker) => [worker.ref.queue, worker.id]),
      ),
    },
  }),
);
