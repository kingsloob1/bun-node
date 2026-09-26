import type { LogEvent } from "@kingsleyweb/bun-common";
import type {
  DriverConfig,
  JobsDriver,
  RunSummonedOptions,
  WorkerTarget,
  WorkerTargetFactory,
} from "../../../lib/index";
import type { RunSummonedProbe } from "../../../lib/summon/worker";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  BunQueue,
  BunQueueWorker,
  MemoryDriver,
  runSummoned,
} from "../../../lib/index";
import { RESERVED_STATE_PREFIX } from "../../../lib/queue/windows";
import { RUN_SUMMONED_PROBE } from "../../../lib/summon/worker";

/**
 * A summoned worker's one file, for `run-summoned.test.ts`: it builds a
 * worker, hands it to `runSummoned`, and reports what happens on stdout as
 * JSON lines, so the test can send real signals to a real process and read
 * back what the process thought happened.
 *
 * Configured by the environment (test parameters, never summon identity) and
 * by `--bun-jobs-summon-*=` arguments, which `runSummoned` reads itself:
 *
 * - `DRIVER`: `memory` (default), `sqlite:<path>`, `unreachable` (a Postgres
 *   URL nothing listens on), or `slow-connect:<ms>` (memory, whose `connect()`
 *   takes that long).
 * - `TARGET`: `in-process` (default), `child-process`, or `custom-hang` (a
 *   custom target whose `close()` never returns).
 * - `PROCESSOR`: `quick` (in-process, returns after `JOB_MS`), `hang`
 *   (in-process, ignores its signal and never returns), `spin` (the file
 *   `job-spin-report.ts`: ignores its signal and spins), `nap` (the file
 *   `job-nap-report.ts`: returns after `JOB_MS`).
 * - `JOBS`: how many jobs to add once the worker is ready (default `0`).
 *   `PRE_JOBS`: how many to add before `runSummoned` starts.
 * - `OPTIONS`: `RunSummonedOptions` as JSON; `DEADLINE_IN_MS` sets
 *   `deadline` to that long after start.
 * - `PROBE=draft`: replaces the close rule with the draft's
 *   `close({ timeout: budget − 1000 })`, for the negative control.
 * - `PID_FILE`: where a file processor writes its pid.
 * - `LEAK_TIMER=1`: leaves a ref'd timer behind after the result, the
 *   negative control for "no timer left".
 *
 * Two signals stand in for an operator, calling the very methods remote
 * control calls: `SIGUSR1` parks the worker (`worker.stop()`), `SIGUSR2`
 * pauses it (`worker.pause()`). `SIGHUP` stands in for a producer: it adds
 * one job.
 *
 * Once `runSummoned` has resolved (with `exit: false`, or in
 * `"in-invocation"` mode), it reports the signal listeners left behind.
 */

/** Prints one JSON line with the wall clock, which the test shares. */
function report(event: string, fields: Record<string, unknown> = {}): void {
  // eslint-disable-next-line no-console -- stdout is this fixture's report
  console.log(JSON.stringify({ event, at: Date.now(), ...fields }));
}

const env = process.env;
const processorKind = env.PROCESSOR ?? "quick";
const targetKind = env.TARGET ?? "in-process";
const jobMs = Number(env.JOB_MS ?? 50);
const pidFile = env.PID_FILE ?? "";
const namespace = `run-summoned-${process.pid}`;
const queueName = "summoned";

/** A memory driver whose `connect()` is slow: a worker still booting. */
class SlowConnectDriver extends MemoryDriver {
  /** How long `connect()` takes, in ms. */
  readonly delay: number;

  constructor(delay: number) {
    super();
    this.delay = delay;
  }

  override async connect(): Promise<void> {
    await Bun.sleep(this.delay);
    await super.connect();
  }
}

function makeDriver(): JobsDriver | DriverConfig {
  const spec = env.DRIVER ?? "memory";
  if (spec === "memory") {
    return new MemoryDriver();
  }
  if (spec === "unreachable") {
    return {
      type: "sql",
      adapter: "postgres",
      url: "postgres://nobody:nothing@127.0.0.1:1/none",
    };
  }
  if (spec.startsWith("sqlite:")) {
    return { type: "sql", url: `sqlite://${spec.slice("sqlite:".length)}` };
  }
  if (spec.startsWith("slow-connect:")) {
    return new SlowConnectDriver(Number(spec.slice("slow-connect:".length)));
  }
  throw new Error(`unknown DRIVER ${spec}`);
}

const handlers = new URL("../handlers/", import.meta.url);
const files: Record<string, string> = {
  spin: fileURLToPath(new URL("job-spin-report.ts", handlers)),
  nap: fileURLToPath(new URL("job-nap-report.ts", handlers)),
};

const hangingTarget: WorkerTargetFactory = () => ({
  name: "hang-on-close",
  run: async (attempt) => {
    const { signal } = attempt.context;
    return await new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve("aborted"));
    });
  },
  close: async () => await new Promise<void>(() => {}),
});

const target: WorkerTarget =
  targetKind === "custom-hang"
    ? hangingTarget
    : targetKind === "child-process"
      ? { kind: "child-process", closeTimeout: 30_000, killTimeout: 30_000 }
      : "in-process";

const driver = makeDriver();
const options = JSON.parse(env.OPTIONS ?? "{}") as RunSummonedOptions;
const startedAt = Date.now();
if (env.DEADLINE_IN_MS !== undefined) {
  options.deadline = startedAt + Number(env.DEADLINE_IN_MS);
}
options.logger = (event: LogEvent) => {
  report("log", {
    level: event.level,
    message: event.message,
    fields: event.fields,
    ...(event.error ? { error: event.error.message } : {}),
  });
};
if (env.PROBE === "draft") {
  const probe: RunSummonedProbe = {
    closeRule: ({ budget, kind }) => ({
      force: false,
      timeout: Math.max(0, budget - 1_000),
      budget,
      targetClose: kind === "in-process" ? 0 : 4_500,
    }),
  };
  (options as { [RUN_SUMMONED_PROBE]?: RunSummonedProbe })[RUN_SUMMONED_PROBE] =
    probe;
}

const processor =
  processorKind === "hang"
    ? async () => await new Promise<never>(() => {})
    : processorKind === "quick"
      ? async () => {
          await Bun.sleep(jobMs);
          return "done";
        }
      : files[processorKind]!;

const worker = new BunQueueWorker(queueName, processor, {
  namespace,
  driver,
  logger: noopLogger,
  pollInterval: 20,
  target,
});

// The queue the jobs are added through: the worker's own driver instance,
// or its own connection to the same store when the driver is a config.
const queue =
  env.DRIVER === "unreachable"
    ? undefined
    : new BunQueue(queueName, { namespace, driver, logger: noopLogger });

const jobData = { pidFile, spinMs: 120_000, napMs: jobMs };

worker.on("ready", () => {
  report("ready");
  const jobs = Number(env.JOBS ?? 0);
  for (let index = 0; index < jobs; index++) {
    void queue?.add("work", jobData, { attempts: 1 });
  }
});
worker.on("active", (job) => report("active", { id: job.id }));
worker.on("completed", (job) => report("completed", { id: job.id }));
worker.on("paused", () => report("paused", { paused: worker.isPaused() }));
worker.on("resumed", () => report("resumed", { paused: worker.isPaused() }));

process.on("SIGUSR1", () => {
  report("operator-stop");
  void worker.stop();
});
process.on("SIGUSR2", () => {
  report("operator-pause");
  void worker.pause();
});
process.on("SIGHUP", () => {
  void queue?.add("work", jobData, { attempts: 1 }).then(() => report("added"));
});

for (let index = 0; index < Number(env.PRE_JOBS ?? 0); index++) {
  await queue?.add("work", jobData, { attempts: 1 });
}

// Sweep leases this worker holds, read straight from queue state.
async function leasesHeld(): Promise<number> {
  const store = worker.driver;
  if (!store.listQueueState || !store.getQueueState) {
    return -1;
  }
  const names = await store.listQueueState(worker.ref, {
    prefix: RESERVED_STATE_PREFIX,
    limit: 200,
  });
  let held = 0;
  for (const name of names) {
    const entry = await store.getQueueState(worker.ref, name);
    const lease = entry?.value as { holder?: string } | null | undefined;
    if (lease?.holder === worker.id) {
      held++;
    }
  }
  return held;
}

if (env.REPORT_LEASES === "1") {
  worker.once("ready", () => {
    setTimeout(() => {
      void leasesHeld().then((held) => report("leases-running", { held }));
    }, 300);
  });
}

// `runSummoned` installs its signal handlers synchronously, before it
// returns its promise: "booting" is printed after that, so a test that
// signals on seeing it never races the installation.
const summoned = runSummoned(worker, options);
report("booting", { pid: process.pid });
const result = await summoned;
report("result", { ...result });

if (env.REPORT_LEASES === "1") {
  // Read through the worker's driver: a memory driver the worker was handed
  // is not closed with it, so its store is still there to read.
  report("leases-after", { held: await leasesHeld() });
}
await queue?.close();

if (env.LEAK_TIMER === "1") {
  setInterval(() => {}, 1_000);
}
report("end", {
  listeners: Object.fromEntries(
    (["SIGTERM", "SIGINT", "SIGTSTP", "SIGCONT"] as const).map((signal) => [
      signal,
      process.listenerCount(signal),
    ]),
  ),
});
