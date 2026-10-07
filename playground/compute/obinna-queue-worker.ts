/**
 * The entry the library's `localCompute()` runs for `obinna-queue`
 * (`summoning.ts`, the `obinna` instance): `bun compute/obinna-queue-worker.ts
 * --bun-jobs-summon-*=…`, a child process of the playground. Not meant to be
 * run by hand. Its jobs "ping obinna": each carries a `dataId` and returns
 * what it pinged, with the pid of the unit that did it.
 *
 * - **Identity** comes from the arguments (`summonedFromArgs()`), never the
 *   environment: the namespace, the queue, the attempt's id, its lifetime and
 *   the provider's grace.
 * - **The backend** comes from `PLAYGROUND_SUMMON_DRIVER`, a driver config as
 *   JSON: the summon policy's static `env`, which `localCompute()` passes to
 *   every unit it starts.
 * - **The obinna instance passes the host's whole environment**
 *   (`env: "inherit"`), so `hostEnv` in each result says `"inherited"`: the
 *   playground's made-up `PLAYGROUND_HOST_SECRET` reached this unit, where
 *   the media group's units, under the allowlist, never see it.
 * - **Its output goes to a logger** (`output: { logger }`): the `unit up`
 *   line below shows in the playground's terminal as an `info` line bound
 *   with the unit's handle, and anything on stderr as a `warn`.
 * - **It is stopped with `SIGINT`** (the instance's `shutdown.signal`), which
 *   `runSummoned` handles like `SIGTERM`: close the worker, exit 0.
 * - **`runSummoned`** runs the worker, stops it after 10 s with nothing to do
 *   (`idle`), on the stop signal (`signal`) or before its lifetime's end
 *   (`deadline`), and exits 0, writing the exit mark that tells the
 *   controller this attempt ended cleanly.
 *
 * `LOCAL_COMPUTE_FAULT` is the playground's fault injection, targeted at this
 * queue from `/playground/compute` (`?kind=crash&queue=obinna-queue`):
 * `crash` exits 1 before the worker ever reports, and `die` kills the process
 * outright after its first job, leaving no exit mark — both read as a `lost`
 * attempt.
 */
import type { DriverConfig, Job } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, runSummoned, summonedFromArgs } from "@kingsleyweb/bun-jobs";

/** A ping-obinna job's data. */
export interface PingObinnaJobData {
  /** Which piece of data to ping obinna with. */
  dataId: `data-${number}`;
}

/** A ping-obinna job worker response. */
export interface PingObinnaJobResponse {
  /** The job's data, echoed. */
  data: PingObinnaJobData;
  /** What was done. */
  result: string;
  /** The pid of the unit that did it: not the playground's. */
  pid: number;
  /** Whether this unit was given the host's whole environment (`env: "inherit"`) or the allowlist. */
  hostEnv: "inherited" | "allowlist";
}

const summon = summonedFromArgs();
if (!summon?.namespace || !summon.queue) {
  throw new Error("run me with --bun-jobs-summon-namespace= and -queue=");
}
const fault = process.env.LOCAL_COMPUTE_FAULT;

// To the instance's `output`: a logger, so it lands in the playground's
// terminal bound with this unit's handle.
console.log(
  `obinna unit up: pid ${process.pid}, attempt ${summon.id ?? "?"}${fault === undefined ? "" : `, fault ${fault}`}`,
);

if (fault === "crash") {
  // Before the worker exists, so it never reports: the attempt is never
  // registered, and the controller calls it lost once its boot budget passes.
  // localCompute keeps this last stderr line as the unit's `status()` detail.
  console.error(
    "obinna worker: cannot load the Networking driver (libnwk.so.1)",
  );
  process.exit(1);
}

const jobs = new BunJobs({
  namespace: summon.namespace,
  // What the Workers page groups it under.
  service: "compute",
  driver: JSON.parse(process.env.PLAYGROUND_SUMMON_DRIVER!) as DriverConfig,
  publishEvents: true,
  logger: noopLogger,
});

const worker = jobs.worker<PingObinnaJobData, PingObinnaJobResponse>(
  summon.queue,
  async (job: Job<PingObinnaJobData>) => {
    await job.log(
      `pinging obinna with ${job.data.dataId} in attempt ${summon.id ?? "?"} (pid ${process.pid})`,
    );
    await Bun.sleep(150 + Math.floor(Math.random() * 250));
    await job.log(`Pinged obinna with ${job.data.dataId}`);
    return {
      data: job.data,
      result: `Pinged obinna with ${job.data.dataId}`,
      pid: process.pid,
      hostEnv:
        process.env.PLAYGROUND_HOST_SECRET === undefined
          ? "allowlist"
          : "inherited",
    };
  },
  {
    summon,
    // `compute.obinna-queue.obinna-pinger-local-compute` on the Workers page.
    name: "obinna-pinger-local-compute",
    concurrency: 2,
    // Reported often, so the Workers page keeps up with a short-lived worker.
    reportInterval: 1_000,
  },
);

if (fault === "die") {
  // Once a job is recorded: the process is killed outright, with no close and
  // no exit mark, as an OOM kill would. The claim says it registered; the
  // missing mark makes it `lost` once its grace has passed, explained by
  // localCompute's `status()`: detail `SIGKILL`.
  worker.on("completed", () => {
    process.kill(process.pid, "SIGKILL");
  });
}

await runSummoned(worker, {
  idleFor: 10_000,
  idleCheckInterval: 1_000,
  logger: noopLogger,
});
