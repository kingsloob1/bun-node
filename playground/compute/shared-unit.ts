/**
 * The entry the `uploads` `localCompute()` instance runs (`summoning.ts`):
 * **one unit for three queues**, `ingest`, `captions` and `search-index`,
 * summoned by the `uploads` summon group's shared unit
 * (`group: { name: "uploads", unit: "shared" }`). Not meant to be run by
 * hand.
 *
 * - **One worker per queue the arguments name.** A shared unit gets one
 *   `--bun-jobs-summon-queue=` per queue (`summonedFromArgs().queues`); this
 *   builds a worker for each and hands them to `runSummoned(workers)`
 *   together: one idle clock (the unit exits once all three are idle), one
 *   close, one exit mark per queue.
 * - **A 3 s pause before the workers exist**, so the attempt stays pending
 *   long enough to read its per-queue coverage on a Summon panel
 *   (`pending[0].coverage`: every queue `pending`, then `registered`).
 * - **One pid for three queues.** Every job's result has the unit's `pid` and
 *   the `queues` it serves, so three completed jobs of one upload show the
 *   same process.
 *
 * `LOCAL_COMPUTE_FAULT` is the playground's fault injection
 * (`compute/units.ts`, the page at `/playground/compute`), queued on
 * `ingest`, the unit's first queue:
 *
 * - `forget-queue`: the last queue's worker is built **without** `summon`, as
 *   an entry script that forgot a queue would be. `runSummoned` accepts it
 *   (it checks only that every named queue has a worker), and the worker
 *   runs, but registers nothing for the attempt: the unit is registered on
 *   the other queues only, so the attempt is `registered` with detail
 *   `partial:search-index`, `missing: ["search-index"]`, and one failure.
 * - `crash`: the unit exits 1 before any worker exists, so every queue is
 *   missing and the attempt is `lost` after the boot budget, its detail this
 *   unit's last stderr line.
 * - `slow-boot`: 25 s before the workers exist, past the 15 s boot budget:
 *   `lost`, then the late workers register and drain the queues anyway.
 */
import type { DriverConfig, Job } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, runSummoned, summonedFromArgs } from "@kingsleyweb/bun-jobs";

/** A job's data, on every queue this entry serves: one upload. */
interface UploadData {
  /** The uploaded file's name. */
  upload: string;
  /** How many steps of work. */
  steps: number;
}

/** What a job returns. */
interface UploadResult {
  /** The steps done. */
  steps: number;
  /** This unit's pid: the same for every queue it serves. */
  pid: number;
  /** The summon attempt that started this unit. */
  summonId: string;
  /** Every queue this unit serves, from its arguments. */
  queues: readonly string[];
  /** Whether this queue's worker was built with `summon` (`false` under `forget-queue`). */
  summoned: boolean;
}

/** How one queue's jobs are run. */
interface Processor {
  /** The worker's name: `compute.<queue>.<name>` on the Workers page. */
  name: string;
  /** The verb in the job's log. */
  verb: string;
  /** How long a step takes, in ms: [least, most]. */
  stepMs: [number, number];
  /** How many jobs at once. */
  concurrency: number;
}

/** What each queue runs, by queue name. */
const PROCESSORS: Record<string, Processor> = {
  ingest: {
    name: "ingest",
    verb: "ingesting",
    stepMs: [150, 350],
    concurrency: 2,
  },
  captions: {
    name: "caption",
    verb: "captioning",
    stepMs: [200, 450],
    concurrency: 2,
  },
  "search-index": {
    name: "index",
    verb: "indexing",
    stepMs: [100, 250],
    concurrency: 1,
  },
};

const summon = summonedFromArgs();
if (!summon?.namespace || !summon.queues || summon.queues.length === 0) {
  throw new Error(
    "run me with --bun-jobs-summon-namespace= and one --bun-jobs-summon-queue= per queue",
  );
}
const queues = summon.queues;
const fault = process.env.LOCAL_COMPUTE_FAULT;

// One line to stdout, so the instance's `output` file has something to show
// for every unit.
console.log(
  `shared unit up: queues ${queues.join(", ")}, pid ${process.pid}, attempt ${summon.id ?? "?"}${fault === undefined ? "" : `, fault ${fault}`}`,
);

if (fault === "crash") {
  // Before any worker exists: no queue ever registers, so the attempt is
  // lost at the boot budget, with this line as the unit's `status()` detail.
  console.error(
    `shared unit: cannot open the upload store (${queues.length} queues unserved)`,
  );
  process.exit(1);
}

// The boot pause: long enough to read the attempt's coverage while it is
// pending; `slow-boot` stretches it past the 15 s boot budget.
await Bun.sleep(fault === "slow-boot" ? 25_000 : 3_000);

const jobs = new BunJobs({
  namespace: summon.namespace,
  // What the Workers page groups it under.
  service: "compute",
  driver: JSON.parse(process.env.PLAYGROUND_SUMMON_DRIVER!) as DriverConfig,
  publishEvents: true,
  logger: noopLogger,
});

/** A random whole number in [least, most]. */
function between([least, most]: [number, number]): number {
  return least + Math.floor(Math.random() * (most - least + 1));
}

const workers = queues.map((queue, index) => {
  const processor = PROCESSORS[queue];
  if (processor === undefined) {
    throw new Error(`no processor for queue "${queue}"`);
  }
  // `forget-queue`: the last queue's worker carries no `summon`, so it runs
  // as an ordinary worker and the attempt never hears from it.
  const summoned = !(fault === "forget-queue" && index === queues.length - 1);
  return jobs.worker<UploadData, UploadResult>(
    queue,
    async (job: Job<UploadData>) => {
      await job.log(
        `${processor.verb} ${job.data.upload} (${job.data.steps} steps) in pid ${process.pid}`,
      );
      for (let step = 1; step <= job.data.steps; step++) {
        await Bun.sleep(between(processor.stepMs));
        await job.updateProgress(Math.round((step / job.data.steps) * 100));
      }
      return {
        steps: job.data.steps,
        pid: process.pid,
        summonId: summon.id ?? "",
        queues,
        summoned,
      };
    },
    {
      ...(summoned ? { summon } : {}),
      name: processor.name,
      concurrency: processor.concurrency,
      // Reported often, so the Workers page keeps up with a short-lived unit.
      reportInterval: 2_000,
    },
  );
});

// One idle clock for the three: the unit exits once every worker has had
// nothing to do for 10 s, writing each queue's exit mark.
await runSummoned(workers, {
  idleFor: 10_000,
  idleCheckInterval: 1_000,
  logger: noopLogger,
});
