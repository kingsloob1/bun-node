/**
 * The one file a Local Compute unit runs (`platform.ts` starts it as
 * `bun compute/worker.ts --bun-jobs-summon-id=… …`): a summoned worker for
 * the queue its arguments name, which exits once that queue has nothing left
 * for it. Not meant to be run by hand.
 *
 * - **Identity** comes from the arguments (`summonedFromArgs()`), never the
 *   environment: the namespace, the queue, the attempt's id, its lifetime and
 *   the platform's grace.
 * - **The backend** comes from `PLAYGROUND_SUMMON_DRIVER`, a driver config as
 *   JSON: the summon policy's static `env`, which the provider hands the
 *   platform with every start, as a platform's task definition would carry it.
 * - **`runSummoned`** runs the worker, stops it after 10 s with nothing to do
 *   (`idle`), on the platform's `SIGTERM` (`signal`) or at the lifetime's end
 *   (`deadline`), and exits 0 — writing the exit mark that tells the
 *   controller this attempt ended cleanly.
 *
 * `LOCAL_COMPUTE_FAULT` is the platform's fault injection (see the control
 * page at `/local-compute`): `crash` exits 1 before the worker ever reports,
 * and `die` kills the process outright after its first job, leaving no exit
 * mark — both read as a `lost` attempt.
 */
import type { DriverConfig, Job } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, runSummoned, summonedFromArgs } from "@kingsleyweb/bun-jobs";

/** A render job's data. */
interface RenderData {
  /** What is rendered. */
  scene: string;
  /** How many frames. */
  frames: number;
}

const summon = summonedFromArgs();
if (!summon?.namespace || !summon.queue) {
  throw new Error("run me with --bun-jobs-summon-namespace= and -queue=");
}
const fault = process.env.LOCAL_COMPUTE_FAULT;

if (fault === "crash") {
  // Before the worker exists, so it never reports: the attempt is never
  // claimed, and the controller calls it lost once its boot budget passes.
  // The platform keeps this line as the unit's detail.
  console.error("render worker: cannot load the GPU driver (libvk.so.1)");
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

const worker = jobs.worker<RenderData, { frames: number; pid: number }>(
  summon.queue,
  async (job: Job<RenderData>) => {
    await job.log(
      `rendering ${job.data.scene} (${job.data.frames} frames) in unit ${process.env.LOCAL_COMPUTE_UNIT} (pid ${process.pid})`,
    );
    for (let frame = 1; frame <= job.data.frames; frame++) {
      await Bun.sleep(150 + Math.floor(Math.random() * 250));
      await job.updateProgress(Math.round((frame / job.data.frames) * 100));
    }
    return { frames: job.data.frames, pid: process.pid };
  },
  {
    summon,
    name: "render",
    concurrency: 2,
    // Reported often, so the Workers page keeps up with a short-lived worker.
    reportInterval: 2_000,
  },
);

if (fault === "die") {
  // Once a job is recorded: the process is killed outright, with no close and
  // no exit mark, as an OOM kill would. The claim says it registered; the
  // missing mark makes it `lost`, detail `died`, once its grace has passed.
  worker.on("completed", () => {
    process.kill(process.pid, "SIGKILL");
  });
}

await runSummoned(worker, {
  idleFor: 10_000,
  idleCheckInterval: 1_000,
  logger: noopLogger,
});
