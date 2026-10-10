/**
 * The one file a summoned unit runs for several queues, as
 * `02-queues/summoned-unit.ts` starts it:
 * `bun 02-queues/helpers/summoned-unit-entry.ts --bun-jobs-summon-id=… --bun-jobs-summon-queue=renders --bun-jobs-summon-queue=thumbs …`.
 * Not meant to be run alone.
 *
 * It builds one worker per queue in `summonedFromArgs().queues` and hands
 * them to `runSummoned(workers)` together. The backend comes from
 * `SUMMONED_DRIVER` (a driver config as JSON), and `SUMMONED_IDLE_FOR` sets
 * `idleFor`. Two more variables bend it for the tour's steps:
 *
 * - `SUMMONED_WORKERS`: comma-separated queues to build workers for instead
 *   of the arguments' queues — fewer than the arguments name, to show the
 *   refusal.
 * - `SUMMONED_HELD`: that queue's worker gets a driver whose `connect()`
 *   never returns, standing in for a region that is slow to answer, so it is
 *   still starting when the others are ready.
 *
 * Every decision `runSummoned` logs is written to stdout as one JSON line —
 * the last one, "Summoned worker stopped", carries the whole `SummonedExit`
 * — and so are three of its own: `workers` (each queue's worker id, before
 * anything runs), `ready` (a worker is up) and `refused` (`runSummoned`
 * rejected, with the error; the process then exits 1).
 *
 * Its jobs answer with the queue whose processor ran them and this
 * process's pid. `quick` returns at once; `slow` works for `data.ms`;
 * `gated` waits until the file at `data.gate` exists. Both of the last two
 * report progress `1` once they are running, so the tour can tell a job
 * this unit is working on from one merely claimed.
 */
import type { DriverConfig, JobsDriver } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import {
  BunJobs,
  BunQueueWorker,
  createDriver,
  runSummoned,
  summonedFromArgs,
} from "@kingsleyweb/bun-jobs";

/** What a job carries. */
interface Work {
  /** How long a `slow` job works, in ms. */
  ms?: number;
  /** The file a `gated` job waits for. */
  gate?: string;
}

/** What every job answers. */
interface Served {
  /** The queue whose processor ran it. */
  processor: string;
  /** The process that ran it. */
  pid: number;
}

/** Prints one line the tour reads. */
function say(message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ message, fields }));
}

const summon = summonedFromArgs();
if (!summon?.namespace || !summon.queues) {
  throw new Error("run me with --bun-jobs-summon-namespace= and -queue=");
}

const config = JSON.parse(process.env.SUMMONED_DRIVER!) as DriverConfig;
const jobs = new BunJobs({ namespace: summon.namespace, driver: config });

/** The processor for `queue`: the same code, answering with its queue. */
function processorFor(queue: string) {
  return async (job: {
    name: string;
    data: Work;
    updateProgress: (progress: number) => Promise<void>;
  }): Promise<Served> => {
    if (job.name !== "quick") {
      await job.updateProgress(1);
    }
    if (job.name === "slow") {
      await Bun.sleep(job.data.ms ?? 0);
    }
    if (job.name === "gated") {
      while (!(await Bun.file(job.data.gate!).exists())) {
        await Bun.sleep(20);
      }
    }
    return { processor: queue, pid: process.pid };
  };
}

/** A driver whose `connect()` never returns: its worker never gets past starting. */
function heldDriver(): JobsDriver {
  const driver = createDriver(config);
  driver.connect = async () => await new Promise<never>(() => {});
  return driver;
}

const queues = process.env.SUMMONED_WORKERS?.split(",") ?? [...summon.queues];
const options = { summon, pollInterval: 20, reportInterval: 200 };
const workers = queues.map((queue) =>
  queue === process.env.SUMMONED_HELD
    ? new BunQueueWorker<Work, Served>(queue, processorFor(queue), {
        ...options,
        namespace: summon.namespace!,
        driver: heldDriver(),
      })
    : jobs.worker<Work, Served>(queue, processorFor(queue), options),
);
for (const worker of workers) {
  worker.once("ready", () => say("ready", { queue: worker.ref.queue }));
}
say("workers", {
  ids: Object.fromEntries(
    workers.map((worker) => [worker.ref.queue, worker.id]),
  ),
});

try {
  await runSummoned(workers, {
    idleFor: Number(process.env.SUMMONED_IDLE_FOR ?? 500),
    idleCheckInterval: 50,
    logger: (event) => say(event.message, event.fields ?? {}),
  });
} catch (error) {
  const { name, message, code } = error as Error & { code?: string };
  say("refused", { name, message, code });
  await jobs.close();
  process.exit(1);
}
