import type { LogEvent } from "@kingsleyweb/bun-common";
import type {
  DriverConfig,
  JobsDriver,
  RunSummonedOptions,
} from "../../../lib/index";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  BunQueue,
  BunQueueWorker,
  MemoryDriver,
  runSummoned,
  summonedFromArgs,
} from "../../../lib/index";

/**
 * A summoned unit serving several queues, for `run-summoned-several.test.ts`:
 * it builds one worker per queue the `--bun-jobs-summon-queue=` arguments
 * name (or the queues `WORKERS` lists), hands them all to `runSummoned`, and
 * reports on stdout as JSON lines.
 *
 * Configured by the environment (test parameters, never summon identity):
 *
 * - `DRIVER`: a driver config as JSON, or absent for one shared memory
 *   driver.
 * - `NAMESPACE`: the namespace when no argument names one.
 * - `WORKERS`: comma-separated queues to build workers for, instead of the
 *   arguments' queues.
 * - `PRE_JOBS`: `{ "<queue>": n }` as JSON, added before `runSummoned`.
 * - `JOB_MS`: how long each job takes (default `50`). `SLOW_QUEUE` and
 *   `SLOW_MS`: that queue's jobs take this long instead.
 * - `FAIL_QUEUE`: that queue's worker gets a driver whose `connect()` fails,
 *   `FAIL_AFTER_MS` (default `100`) in, so its `run()` fails.
 * - `OWNER_CLOSE`: `<queue>:<ms>[,<queue>:<ms>…]`: the fixture closes each
 *   such queue's worker itself, that long after start, as an owner would.
 * - `SINGLE=1`: calls `runSummoned(worker)` with the first worker alone.
 * - `CHILD_QUEUE`: that queue's worker runs a `child-process` target with
 *   the processor file `job-spin-report.ts`, which writes its pid to
 *   `PID_FILE` and then spins deaf to every signal but a kill; its jobs
 *   carry what that processor reads.
 * - `SLOW_CONNECT_QUEUE` (comma-separated) and `SLOW_CONNECT_MS`: those
 *   queues' workers share a memory driver of their own whose `connect()`
 *   takes that long, so they are still starting when the others are ready;
 *   their `PRE_JOBS` go there.
 * - `SLOW_STATE_QUEUE` (comma-separated) and `SLOW_STATE_MS`: those queues'
 *   workers share a memory driver of their own whose `getQueueState()`
 *   takes that long once the process has received `SIGTERM`, so writing the
 *   exit marks on their summon claims is slow; their `PRE_JOBS` go there.
 * - `HOLD_QUEUE`: once that queue's worker is ready, the fixture pauses it
 *   (`worker.pause()`, as an operator would) and then adds one job to its
 *   queue, which therefore has work no worker takes; reports `held`.
 * - `OPTIONS`: `RunSummonedOptions` as JSON; `DEADLINE_IN_MS` sets
 *   `deadline` to that long after start.
 * - `REPORT_WAITING=1`: once `runSummoned` resolves (which needs
 *   `exit: false` in `OPTIONS`), reports each queue's waiting jobs as
 *   `waiting` lines before exiting with the result's code.
 *
 * `SIGUSR1` parks the worker of `PARK_QUEUE` (`*` for every worker) with
 * `worker.stop()`, as remote control does; with `PARK_ADD=1`, once that has
 * resolved, one job is added to each parked queue and `park-backlog` is
 * reported.
 */

/** Prints one JSON line with the wall clock, which the test shares. */
function report(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({ event, at: Date.now(), ...fields })}\n`,
  );
}

/**
 * A memory driver whose `connect()` takes `SLOW_CONNECT_MS` once `slow` is
 * set: after the fixture has added its jobs, so only the worker's waits.
 */
class SlowConnectDriver extends MemoryDriver {
  /** Whether `connect()` is slow yet. */
  slow = false;

  override async connect(): Promise<void> {
    if (this.slow) {
      await Bun.sleep(Number(process.env.SLOW_CONNECT_MS ?? 0));
    }
    await super.connect();
  }
}

/**
 * A memory driver whose `getQueueState()` takes `SLOW_STATE_MS` once `slow`
 * is set: on `SIGTERM`, so only the exit marks' reads wait.
 */
class SlowStateDriver extends MemoryDriver {
  /** Whether `getQueueState()` is slow yet. */
  slow = false;

  override async getQueueState(
    ...args: Parameters<MemoryDriver["getQueueState"]>
  ): ReturnType<MemoryDriver["getQueueState"]> {
    if (this.slow) {
      await Bun.sleep(Number(process.env.SLOW_STATE_MS ?? 0));
    }
    return await super.getQueueState(...args);
  }
}

/** A memory driver whose `connect()` fails after `FAIL_AFTER_MS`. */
class FailingDriver extends MemoryDriver {
  override async connect(): Promise<void> {
    await Bun.sleep(Number(process.env.FAIL_AFTER_MS ?? 100));
    throw new Error("connect refused (FAIL_QUEUE)");
  }
}

const env = process.env;
const summon = summonedFromArgs();
const namespace =
  summon?.namespace ?? env.NAMESPACE ?? `several-${process.pid}`;
const queues =
  env.WORKERS === undefined
    ? [...(summon?.queues ?? [])]
    : env.WORKERS.split(",");
const driver: JobsDriver | DriverConfig =
  env.DRIVER === undefined
    ? new MemoryDriver()
    : (JSON.parse(env.DRIVER) as DriverConfig);
const jobMs = Number(env.JOB_MS ?? 50);
const slowMs = Number(env.SLOW_MS ?? jobMs);
const startedAt = Date.now();

/** The queues whose workers connect slowly. */
const slowQueues = env.SLOW_CONNECT_QUEUE?.split(",") ?? [];
/** The slow-connecting queues' own driver, when there are any. */
const slowDriver =
  slowQueues.length === 0 ? undefined : new SlowConnectDriver();

/** The queues whose drivers read queue state slowly after `SIGTERM`. */
const slowStateQueues = env.SLOW_STATE_QUEUE?.split(",") ?? [];
/** The slow-state queues' own driver, when there are any. */
const slowStateDriver =
  slowStateQueues.length === 0 ? undefined : new SlowStateDriver();
if (slowStateDriver !== undefined) {
  // Installed before `runSummoned`'s own handler, so it runs first.
  process.on("SIGTERM", () => {
    slowStateDriver.slow = true;
    report("slow-state");
  });
}

/** The driver `queue`'s worker, and the jobs added to it, use. */
function driverFor(queue: string): JobsDriver | DriverConfig {
  if (queue === env.FAIL_QUEUE) {
    return new FailingDriver();
  }
  if (slowStateQueues.includes(queue)) {
    return slowStateDriver!;
  }
  return slowQueues.includes(queue) ? slowDriver! : driver;
}

/** The spinning processor file the `CHILD_QUEUE` worker runs off-thread. */
const spinFile = fileURLToPath(
  new URL("../handlers/job-spin-report.ts", import.meta.url),
);

const workers = queues.map((queue) => {
  const options = {
    namespace,
    driver: driverFor(queue),
    summon,
    logger: noopLogger,
    pollInterval: 20,
    reportInterval: 200,
    concurrency: 4,
  };
  if (queue === env.CHILD_QUEUE) {
    return new BunQueueWorker(queue, spinFile, {
      ...options,
      target: {
        kind: "child-process",
        closeTimeout: 30_000,
        killTimeout: 30_000,
      },
    });
  }
  return new BunQueueWorker(
    queue,
    async (): Promise<unknown> => {
      report("processing", { queue });
      await Bun.sleep(queue === env.SLOW_QUEUE ? slowMs : jobMs);
      report("processed", { queue });
      return "done";
    },
    options,
  );
});
for (const worker of workers) {
  worker.on("ready", () => report("ready", { queue: worker.ref.queue }));
  if (worker.ref.queue === env.HOLD_QUEUE) {
    worker.once("ready", () => {
      void (async () => {
        await worker.pause();
        await new BunQueue(worker.ref.queue, {
          namespace,
          driver: driverFor(worker.ref.queue),
          logger: noopLogger,
        }).add("work", { held: true });
        report("held", { queue: worker.ref.queue });
      })();
    });
  }
  worker.on("closed", () => report("closed", { queue: worker.ref.queue }));
}

const pre = JSON.parse(env.PRE_JOBS ?? "{}") as Record<string, number>;
for (const [queue, count] of Object.entries(pre)) {
  const adding = new BunQueue(queue, {
    namespace,
    driver: driverFor(queue),
    logger: noopLogger,
  });
  for (let index = 0; index < count; index++) {
    await adding.add(
      "work",
      queue === env.CHILD_QUEUE
        ? { pidFile: env.PID_FILE!, spinMs: 120_000 }
        : { index },
      { attempts: 1 },
    );
  }
}

for (const entry of env.OWNER_CLOSE?.split(",") ?? []) {
  const [queue, ms] = entry.split(":") as [string, string];
  setTimeout(() => {
    report("owner-close", { queue });
    void workers
      .find((worker) => worker.ref.queue === queue)
      ?.close()
      .then(() => report("owner-close-resolved", { queue }));
  }, Number(ms));
}

process.on("SIGUSR1", () => {
  for (const worker of workers) {
    if (env.PARK_QUEUE === "*" || worker.ref.queue === env.PARK_QUEUE) {
      report("park", { queue: worker.ref.queue });
      void worker.stop().then(async () => {
        if (env.PARK_ADD !== "1") {
          return;
        }
        await new BunQueue(worker.ref.queue, {
          namespace,
          driver: driverFor(worker.ref.queue),
          logger: noopLogger,
        }).add("work", { parked: true }, { attempts: 1 });
        report("park-backlog", { queue: worker.ref.queue });
      });
    }
  }
});

const options = JSON.parse(env.OPTIONS ?? "{}") as RunSummonedOptions;
if (env.DEADLINE_IN_MS !== undefined) {
  options.deadline = startedAt + Number(env.DEADLINE_IN_MS);
}
options.logger = (event: LogEvent) => {
  report("log", {
    level: event.level,
    message: event.message,
    fields: event.fields,
  });
};

if (slowDriver !== undefined) {
  slowDriver.slow = true;
}
report("starting", { queues });
const result =
  env.SINGLE === "1"
    ? await runSummoned(workers[0]!, options)
    : await runSummoned(workers, options);
report("result", { result });
if (env.REPORT_WAITING === "1") {
  for (const queue of queues) {
    const count = await new BunQueue(queue, {
      namespace,
      driver: driverFor(queue),
      logger: noopLogger,
    }).count("waiting");
    report("waiting", { queue, count });
  }
}
process.exit(result.code);
