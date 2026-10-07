/**
 * The entry the library's `localCompute()` runs for every queue of the
 * playground's media summon group, and for `ledger` and `secure-exports`
 * (`summoning.ts`): `bun compute/worker.ts --bun-jobs-summon-*=…`, a child
 * process of the playground. Not meant to be run by hand.
 *
 * - **One file serving a group's queues.** A group's policy names one
 *   summoner, and so one entry; the queue each unit serves is in its
 *   arguments (`summonedFromArgs().queue`), and that chooses the processor,
 *   from {@link PROCESSORS}.
 * - **Identity** comes from the arguments, never the environment: the
 *   namespace, the queue, the attempt's id, its mode, lifetime and grace.
 * - **The backend** comes from `PLAYGROUND_SUMMON_DRIVER`, a driver config as
 *   JSON: the summon policy's static `env`, which `localCompute()` adds on top
 *   of its own allowlist.
 * - **Its own arguments** come before the summon arguments: the instance's
 *   `args` (`--tier=standard` on media, `--tier=replica` on ledger) reach
 *   every job's result as `tier`.
 * - **What the environment allowlist let through** is in every job's result
 *   (`env`): `PLAYGROUND_REGION` arrives because the media instance names it
 *   in `passEnv`, `PLAYGROUND_POOL` because its `env` sets it, and
 *   `PLAYGROUND_HOST_SECRET`, which the playground sets in its own
 *   environment, does **not** — the allowlist kept it out.
 * - **`runSummoned`** runs the worker, stops it after 10 s with nothing to do
 *   (`idle`), on `localCompute()`'s stop signal (`signal`) or before its
 *   lifetime's end (`deadline`), and exits 0 — writing the exit mark that
 *   tells the controller this attempt ended cleanly. A `ledger` unit is
 *   summoned by a scale-style summoner, whose mode is `until-stopped`: it
 *   never exits on idle, only when the summoner releases it.
 *
 * `LOCAL_COMPUTE_FAULT` is the playground's fault injection
 * (`compute/units.ts`, the page at `/playground/compute`): `crash`, `die`,
 * `slow-boot` and `ignore-stop`, each described there.
 */
import type { DriverConfig, Job } from "@kingsleyweb/bun-jobs";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { BunJobs, runSummoned, summonedFromArgs } from "@kingsleyweb/bun-jobs";

/** A job's data, on every queue this entry serves. */
interface WorkData {
  /** What the job is about: a scene, an account, an export. */
  subject: string;
  /** How many steps of work. */
  steps: number;
}

/** What a job returns. */
interface WorkResult {
  /** The steps done. */
  steps: number;
  /** This unit's pid: not the playground's. */
  pid: number;
  /** The summon attempt that started this unit. */
  summonId: string;
  /** From the instance's `args` (`--tier=`), or `null`. */
  tier: string | null;
  /** What reached this unit's environment, and what the allowlist kept out. */
  env: {
    /** From the host, through the instance's `passEnv`. */
    region: string | null;
    /** From the instance's own `env`. */
    pool: string | null;
    /** The host's made-up secret: `"kept out"` under the allowlist. */
    hostSecret: "visible" | "kept out";
  };
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

const summon = summonedFromArgs();
if (!summon?.namespace || !summon.queue) {
  throw new Error("run me with --bun-jobs-summon-namespace= and -queue=");
}
const queue = summon.queue;
/** The instance's own argument, `--tier=<name>`, ahead of the summon arguments. */
const tier =
  process.argv
    .find((arg) => arg.startsWith("--tier="))
    ?.slice("--tier=".length) ?? null;
const fault = process.env.LOCAL_COMPUTE_FAULT;

// One line to stdout, so the instance's `output` (a file, a logger) has
// something to show for every unit.
console.log(
  `unit up: queue ${queue}, tier ${tier ?? "none"}, pid ${process.pid}, attempt ${summon.id ?? "?"}${fault === undefined ? "" : `, fault ${fault}`}`,
);

if (fault === "crash") {
  // Before the worker exists, so it never reports: the attempt is never
  // registered, and the controller calls it lost once its boot budget passes.
  // localCompute keeps this last stderr line as the unit's `status()` detail.
  console.error(`${queue} worker: cannot load the GPU driver (libvk.so.1)`);
  process.exit(1);
}

if (fault === "slow-boot") {
  // Past the boot budget (15 s on the media instance): the attempt is lost
  // first, then this worker registers late and drains the queue anyway.
  await Bun.sleep(25_000);
}

const jobs = new BunJobs({
  namespace: summon.namespace,
  // What the Workers page groups it under.
  service: "compute",
  driver: JSON.parse(process.env.PLAYGROUND_SUMMON_DRIVER!) as DriverConfig,
  publishEvents: true,
  logger: noopLogger,
});

/** What each queue this entry serves runs, by queue name. */
const PROCESSORS: Record<string, Processor> = {
  renders: {
    name: "render",
    verb: "rendering",
    stepMs: [150, 400],
    concurrency: 2,
  },
  transcodes: {
    name: "transcode",
    verb: "transcoding",
    stepMs: [150, 400],
    concurrency: 2,
  },
  thumbnails: {
    name: "thumbnail",
    verb: "thumbnailing",
    stepMs: [100, 250],
    concurrency: 2,
  },
  // One long job at a time, and a steady supply, so a unit never goes idle
  // and runs to its 45 s lifetime.
  marathon: {
    name: "leg",
    verb: "running a leg of",
    stepMs: [600, 900],
    concurrency: 1,
  },
  // Never reached: every brittle unit crashes first (its override's env).
  brittle: {
    name: "brittle",
    verb: "trying",
    stepMs: [150, 400],
    concurrency: 1,
  },
  ledger: { name: "post", verb: "posting", stepMs: [200, 500], concurrency: 2 },
  "secure-exports": {
    name: "export",
    verb: "exporting",
    stepMs: [200, 500],
    concurrency: 1,
  },
};
const processor = PROCESSORS[queue];
if (processor === undefined) {
  throw new Error(`no processor for queue "${queue}"`);
}

/** A random whole number in [least, most]. */
function between([least, most]: [number, number]): number {
  return least + Math.floor(Math.random() * (most - least + 1));
}

const worker = jobs.worker<WorkData, WorkResult>(
  queue,
  async (job: Job<WorkData>) => {
    await job.log(
      `${processor.verb} ${job.data.subject} (${job.data.steps} steps) in pid ${process.pid}`,
    );
    for (let step = 1; step <= job.data.steps; step++) {
      await Bun.sleep(between(processor.stepMs));
      await job.updateProgress(Math.round((step / job.data.steps) * 100));
    }
    return {
      steps: job.data.steps,
      pid: process.pid,
      summonId: summon.id ?? "",
      tier,
      env: {
        region: process.env.PLAYGROUND_REGION ?? null,
        pool: process.env.PLAYGROUND_POOL ?? null,
        hostSecret:
          process.env.PLAYGROUND_HOST_SECRET === undefined
            ? "kept out"
            : "visible",
      },
    };
  },
  {
    summon,
    name: processor.name,
    concurrency: processor.concurrency,
    // Reported often, so the Workers page keeps up with a short-lived worker.
    reportInterval: 2_000,
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

if (fault === "ignore-stop") {
  // A unit that will not stop: none of runSummoned's signal handlers, its own
  // that swallow both signals, and a deadline a day away. Only localCompute's
  // lifetime timer ends it: the stop signal at the policy's maxLifetime,
  // swallowed, then SIGKILL after the grace (exit 137, detail
  // `max-lifetime`).
  process.on("SIGTERM", () => {
    console.error(`${queue} worker: ignoring SIGTERM`);
  });
  process.on("SIGINT", () => {
    console.error(`${queue} worker: ignoring SIGINT`);
  });
}

await runSummoned(worker, {
  idleFor: 10_000,
  idleCheckInterval: 1_000,
  logger: noopLogger,
  ...(fault === "ignore-stop"
    ? { signals: false as const, deadline: Date.now() + 86_400_000 }
    : {}),
});
