/**
 * Option tour: `BunQueueWorker` — every option, every public member and every
 * event, each asserted. Also every `ProcessorContext` field and the in-flight
 * `Job` members a processor uses.
 *
 * ```bash
 * bun 10-options/worker-options.ts
 * EXAMPLE_DRIVER=sqlite bun 10-options/worker-options.ts
 * ```
 *
 * Worth knowing:
 *
 * - A lock is kept by heartbeats, not by `lockDuration` alone: a job may run
 *   for many lock durations while `heartbeatInterval` renews it. A lost lock
 *   aborts `ctx.signal` and emits `lockLost`; `job.touch()` then answers
 *   `false`, and the late completion is refused.
 * - `maxStalledCount` counts recoveries: a job whose worker died goes back to
 *   the queue that many times, and is buried as `dead` the time after. Any
 *   running worker's stalled sweep does the recovering — here, paused ones.
 * - `maintenance: false` turns promotion and the stalled sweep off on that
 *   worker only; another worker's maintenance still serves the queue.
 * - Isolation (`isolation`, `isolationOptions`) has its own tour:
 *   `worker-isolation.ts`.
 * - Sections 6 and 14 start child processes, so on the memory default they use
 *   a temporary SQLite file (`crossProcessDriver()`).
 */
import type {
  DeadLetter,
  Job,
  JobsDriver,
  LoggerLike,
} from "@kingsleyweb/bun-jobs";
import process from "node:process";
import {
  BackoffStrategies,
  BunQueue,
  BunQueueWorker,
  createDriver,
} from "@kingsleyweb/bun-jobs";
import {
  crossProcessDriver,
  exampleDriver,
  exampleNamespace,
} from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Worker options");

/** A bare log sink: one of the shapes a `logger` option accepts. */
type LogSink = Extract<LoggerLike, (...args: never[]) => unknown>;
/** One record a sink receives. */
type LogEvent = Parameters<LogSink>[0];

/** Every record logged through {@link logger}. */
const logEvents: LogEvent[] = [];
const logger: LogSink = (event) => {
  logEvents.push(event);
};

const driver = createDriver(exampleDriver());
const crossConfig = crossProcessDriver();
const crossDriver = createDriver(crossConfig);
const namespace = exampleNamespace("worker-options");

/** Short waits, so the tour spends its time on the work. */
const fast = { pollInterval: 25, maxBlock: 50 };
/** How long to wait for anything a busy machine might slow down. */
const LONG = { timeout: 30_000 };

/** A hold on running jobs, released by hand. */
interface Gate {
  /** Resolves once {@link Gate.open} is called. */
  opened: Promise<void>;
  /** Lets every job waiting on the gate carry on. */
  open: () => void;
}

/** A closed gate. */
function gate(): Gate {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/**
 * Waits out a window in which something must *not* happen. The only sleeps
 * in the tour: a negative cannot be waited for.
 */
async function quietWindow(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

/** A worker that never claims — it is paused — but sweeps for stalled jobs. */
interface Sweeper {
  /** The worker. */
  worker: BunQueueWorker;
  /** Ids from every `stalled` event it emitted, in order. */
  stalled: string[];
}

/** How a sweeper is set up. */
interface SweeperOptions {
  /** Where the queue lives. Defaults to the tour's driver. */
  driver?: JobsDriver;
  /** How many stalls a job survives. Defaults to the worker default, `1`. */
  maxStalledCount?: number;
}

/** Starts a paused worker that sweeps `queueName` every 100ms. */
async function startSweeper(
  queueName: string,
  options: SweeperOptions = {},
): Promise<Sweeper> {
  const worker = new BunQueueWorker<unknown, unknown>(
    queueName,
    async () => null,
    {
      namespace,
      driver: options.driver ?? driver,
      stalledInterval: 100,
      ...(options.maxStalledCount === undefined
        ? {}
        : { maxStalledCount: options.maxStalledCount }),
      ...fast,
    },
  );
  const stalled: string[] = [];
  worker.on("stalled", (ids) => {
    stalled.push(...ids);
  });
  // Paused before it runs, so it never claims — but maintenance still runs.
  await worker.pause();
  void worker.run();
  return { worker, stalled };
}

/** Child processes started here, killed on exit whatever happened. */
const children = new Set<ReturnType<typeof Bun.spawn>>();
process.once("exit", () => {
  for (const child of children) {
    child.kill("SIGKILL");
  }
});

/* ------------------------------------------------------------------ */
step("1. id, autorun, logger — and the in-flight job and its context");

/** What the basics processor saw while its job was running. */
interface InFlight {
  /** `ctx.workerId`. */
  workerId: string;
  /** `ctx.attempt`. */
  attempt: number;
  /** Whether `ctx.signal` was an `AbortSignal` that had not fired. */
  signalLive: boolean;
  /** `job.workerId` on the claimed record. */
  jobWorkerId: string | null;
  /** `job.lockToken`. */
  lockToken: string | null;
  /** `job.queue`. */
  queue: Job["queue"];
  /** `job.isRepeat`. */
  isRepeat: boolean;
  /** `job.toJSON().id`. */
  recordId: string;
  /** `job.toJSON().state`. */
  recordState: string;
  /** `job.refresh()` state. */
  refreshedState: string | undefined;
  /** `job.refresh()` worker id. */
  refreshedWorkerId: string | null | undefined;
  /** What `job.log()` answered. */
  jobLog: number;
  /** What `ctx.log()` answered. */
  ctxLog: number;
  /** What `job.getLogs()` answered. */
  logs: Awaited<ReturnType<Job["getLogs"]>>;
  /** What `job.extendLock(5_000)` answered. */
  extended: boolean;
  /** What `job.touch()` answered. */
  touched: boolean;
  /** The stored lock expiry after `extendLock(5_000)`. */
  lockAfterExtend: number;
  /** The stored lock expiry after `ctx.heartbeat()`, which renews for `lockDuration`. */
  lockAfterHeartbeat: number;
}

let inFlight: InFlight | undefined;
const basicsEvents: string[] = [];
const basicsProgress: unknown[] = [];
let basicsResult: string | undefined;
let scopedCompleted = 0;

const basicsQueue = new BunQueue<{ label: string }, string>("basics", {
  namespace,
  driver,
});
const basics = new BunQueueWorker<{ label: string }, string>(
  "basics",
  async (job, ctx) => {
    ctx.logger.info("processing the basics job");
    await job.updateProgress(40);
    const jobLog = await job.log("first line");
    const ctxLog = await ctx.log("second line");
    const logs = await job.getLogs();
    const extended = await job.extendLock(5_000);
    const lockAfterExtend = (await job.refresh())?.toJSON().lockExpiresAt ?? 0;
    await ctx.heartbeat();
    const refreshed = await job.refresh();
    const touched = await job.touch();
    const record = job.toJSON();

    inFlight = {
      workerId: ctx.workerId,
      attempt: ctx.attempt,
      signalLive: ctx.signal instanceof AbortSignal && !ctx.signal.aborted,
      jobWorkerId: job.workerId,
      lockToken: job.lockToken,
      queue: job.queue,
      isRepeat: job.isRepeat,
      recordId: record.id,
      recordState: record.state,
      refreshedState: refreshed?.state,
      refreshedWorkerId: refreshed?.workerId,
      jobLog,
      ctxLog,
      logs,
      extended,
      touched,
      lockAfterExtend,
      lockAfterHeartbeat: refreshed?.toJSON().lockExpiresAt ?? 0,
    };
    return `done: ${job.data.label}`;
  },
  // `autorun`: consuming starts here, with no `run()` call.
  { namespace, driver, id: "basics-worker", autorun: true, logger, ...fast },
);
checkEqual(
  "autorun: isRunning straight after construction",
  basics.isRunning,
  true,
);

basics.on("ready", () => {
  basicsEvents.push("ready");
});
basics.on("active", () => {
  basicsEvents.push("active");
});
basics.on("progress", (_job, value) => {
  basicsEvents.push("progress");
  basicsProgress.push(value);
});
basics.on("completed", (_job, result) => {
  basicsEvents.push("completed");
  basicsResult = result;
});
basics.on("completed:report", () => {
  scopedCompleted++;
});
basics.on("drained", () => {
  basicsEvents.push("drained");
});

// A second `run()` joins the running loop: it resolves when the worker closes.
let basicsRunResolved = false;
const basicsRun = basics.run().then(() => {
  basicsRunResolved = true;
});

await waitFor("ready", () => basicsEvents.includes("ready"), LONG);
checkEqual("id: worker.id", basics.id, "basics-worker");
checkEqual("worker.ref", basics.ref, { ns: namespace, queue: "basics" });
checkEqual("concurrency defaults to 1", basics.concurrency, 1);

basics.logger.info("hello from the tour");
const hello = logEvents.find(
  (event) => event.message === "hello from the tour",
);
checkEqual(
  "logger: worker.logger writes to it, bound to the worker",
  [hello?.bindings.workerId, hello?.bindings.queue],
  ["basics-worker", "basics"],
);

const basicsJob = await basicsQueue.add("report", { label: "basics" });
await waitFor(
  "the basics job to complete",
  () => basicsResult !== undefined,
  LONG,
);
await waitFor(
  "drained after it",
  () => basicsEvents.lastIndexOf("drained") > basicsEvents.indexOf("completed"),
  LONG,
);

checkEqual(
  "events: ready, active, progress, completed — in that order",
  basicsEvents.filter((event) => event !== "drained"),
  ["ready", "active", "progress", "completed"],
);
checkEqual("completed carries the result", basicsResult, "done: basics");
checkEqual("completed:<name> fires too", scopedCompleted, 1);
checkEqual("progress carries the value", basicsProgress, [40]);
checkEqual("id: recorded on the job", inFlight?.jobWorkerId, "basics-worker");
checkEqual("ctx.workerId", inFlight?.workerId, "basics-worker");
checkEqual("ctx.attempt is 1-based", inFlight?.attempt, 1);
checkEqual("ctx.signal is live while the job runs", inFlight?.signalLive, true);
const processing = logEvents.find(
  (event) => event.message === "processing the basics job",
);
checkEqual(
  "ctx.logger is bound to the job",
  [processing?.bindings.jobId, processing?.bindings.workerId],
  [basicsJob.id, "basics-worker"],
);
checkEqual("job.log() answers the line count", inFlight?.jobLog, 1);
checkEqual("ctx.log() appends to the same log", inFlight?.ctxLog, 2);
checkEqual("job.getLogs()", inFlight?.logs, {
  logs: ["first line", "second line"],
  count: 2,
});
checkEqual(
  "job.extendLock() and job.touch() answer true while the lock is ours",
  [inFlight?.extended, inFlight?.touched],
  [true, true],
);
check(
  "ctx.heartbeat() renews the lock for lockDuration (past extendLock(5_000))",
  (inFlight?.lockAfterHeartbeat ?? 0) > (inFlight?.lockAfterExtend ?? 0) &&
    (inFlight?.lockAfterExtend ?? 0) > 0,
  inFlight,
);
check(
  "job.lockToken is set while running",
  typeof inFlight?.lockToken === "string" && inFlight.lockToken.length > 0,
  inFlight?.lockToken,
);
checkEqual("job.queue", inFlight?.queue, { ns: namespace, queue: "basics" });
checkEqual("job.isRepeat", inFlight?.isRepeat, false);
checkEqual(
  "job.toJSON() is the claimed record",
  [inFlight?.recordId, inFlight?.recordState],
  [basicsJob.id, "active"],
);
checkEqual(
  "job.refresh() re-reads it: active, held by this worker",
  [inFlight?.refreshedState, inFlight?.refreshedWorkerId],
  ["active", "basics-worker"],
);
const basicsStored = await basicsQueue.getJob(basicsJob.id);
checkEqual(
  "stored: completed, with its result and progress",
  [basicsStored?.state, basicsStored?.returnValue, basicsStored?.progress],
  ["completed", "done: basics", 40],
);

await basics.close();
await basicsRun;
checkEqual("run() resolves once the worker is closed", basicsRunResolved, true);
checkEqual("isRunning is false after close", basics.isRunning, false);
await basicsQueue.close();

/* ------------------------------------------------------------------ */
step("2. concurrency, and changing it at runtime");

const concQueue = new BunQueue<{ n: number }, number>("concurrency", {
  namespace,
  driver,
});
const conc = { running: 0, peak: 0, done: 0 };
let concGate = gate();
const concurrent = new BunQueueWorker<{ n: number }, number>(
  "concurrency",
  async (job) => {
    conc.running++;
    conc.peak = Math.max(conc.peak, conc.running);
    try {
      await concGate.opened;
      return job.data.n;
    } finally {
      conc.running--;
      conc.done++;
    }
  },
  { namespace, driver, concurrency: 3, ...fast },
);
const concEvents: string[] = [];
concurrent.on("paused", () => {
  concEvents.push("paused");
});
concurrent.on("resumed", () => {
  concEvents.push("resumed");
});
void concurrent.run();
checkEqual("concurrency option", concurrent.concurrency, 3);

for (let n = 0; n < 8; n++) {
  await concQueue.add("hold", { n });
}
await waitFor("three jobs running", () => conc.running === 3, LONG);
await quietWindow(400);
checkEqual("never more than 3 at once", conc.peak, 3);
checkEqual("activeCount", concurrent.activeCount, 3);

concurrent.concurrency = 5;
checkEqual("the concurrency setter", concurrent.concurrency, 5);
await waitFor(
  "five jobs running after raising it",
  () => conc.running === 5,
  LONG,
);
await quietWindow(400);
checkEqual("never more than 5 at once", conc.peak, 5);

concGate.open();
await waitFor("all 8 jobs", () => conc.done === 8, LONG);

concurrent.concurrency = 0;
checkEqual("the setter floors at 1", concurrent.concurrency, 1);
concurrent.concurrency = 2.9;
checkEqual("the setter rounds down", concurrent.concurrency, 2);

/* ------------------------------------------------------------------ */
step("3. pause({ waitActive }), isPaused, resume");

concGate = gate();
await concQueue.add("hold", { n: 100 });
await concQueue.add("hold", { n: 101 });
await waitFor("two jobs running", () => conc.running === 2, LONG);

let pauseSettled = false;
const pausing = concurrent.pause({ waitActive: true }).then(() => {
  pauseSettled = true;
});
checkEqual("isPaused() after pause()", concurrent.isPaused(), true);
checkEqual("paused event", concEvents, ["paused"]);

const whilePaused = await concQueue.add("hold", { n: 102 });
await quietWindow(200);
checkEqual(
  "pause({ waitActive: true }) waits for jobs in flight",
  pauseSettled,
  false,
);

concGate.open();
await pausing;
checkEqual("…and resolves once they have settled", concurrent.activeCount, 0);
await quietWindow(500);
checkEqual(
  "a paused worker claims nothing",
  (await whilePaused.refresh())?.state,
  "waiting",
);

concurrent.resume();
checkEqual("isPaused() after resume()", concurrent.isPaused(), false);
checkEqual("resumed event", concEvents, ["paused", "resumed"]);
await waitFor(
  "the job added while paused to complete",
  async () => (await whilePaused.refresh())?.state === "completed",
  LONG,
);
check("resumed claiming", true);

await concurrent.close();
await concQueue.close();

/* ------------------------------------------------------------------ */
step("4. lockDuration + heartbeatInterval: heartbeats keep a long job's lock");

const hbQueue = new BunQueue("heartbeat", { namespace, driver });
const hbSweeper = await startSweeper("heartbeat");
const hbLockLost: string[] = [];
const hbWorker = new BunQueueWorker(
  "heartbeat",
  async () => {
    // Nearly three lock durations, never renewing by hand.
    await Bun.sleep(4_000);
    return "outlived its lock";
  },
  { namespace, driver, lockDuration: 1_500, heartbeatInterval: 250, ...fast },
);
hbWorker.on("lockLost", (job) => {
  hbLockLost.push(job.id);
});
void hbWorker.run();

const hbJob = await hbQueue.add("long", {});
await waitFor(
  "the long job to complete",
  async () => (await hbJob.refresh())?.state === "completed",
  LONG,
);
const hbDone = await hbJob.refresh();
check(
  "it ran for longer than its lockDuration",
  (hbDone?.finishedOn ?? 0) - (hbDone?.processedOn ?? 0) >= 3_000,
  hbDone?.toJSON(),
);
checkEqual(
  "not stalled, not lost, one attempt",
  [hbDone?.stalledCount, hbSweeper.stalled, hbLockLost, hbDone?.attemptsMade],
  [0, [], [], 1],
);

await hbWorker.close();
await hbSweeper.worker.close();
await hbQueue.close();

/* ------------------------------------------------------------------ */
step(
  "5. A lost lock: lockLost, touch() answers false, the late result is refused",
);

/** What the first attempt saw once its lock was gone. */
interface AfterLoss {
  /** What `job.touch()` answered. */
  touched: boolean;
  /** What `job.extendLock()` answered. */
  extended: boolean;
  /** Whether `ctx.signal` had fired after `ctx.heartbeat()` found the lock gone. */
  aborted: boolean;
}

const lostQueue = new BunQueue<Record<string, never>, string>("lock-lost", {
  namespace,
  driver,
});
// Recovers the job without burying it.
const lostSweeper = await startSweeper("lock-lost", { maxStalledCount: 5 });
let afterLoss: AfterLoss | undefined;
const lockLost: string[] = [];
const loser = new BunQueueWorker<Record<string, never>, string>(
  "lock-lost",
  async (job, ctx) => {
    if (job.stalledCount > 0) {
      return "the recovered attempt";
    }

    // No heartbeats (a minute apart against a 400ms lock): wait for the
    // sweeper to take the job back.
    await waitFor(
      "the sweeper to recover the job",
      () => lostSweeper.stalled.includes(job.id),
      LONG,
    );
    const touched = await job.touch();
    const extended = await job.extendLock();
    await ctx.heartbeat();
    afterLoss = { touched, extended, aborted: ctx.signal.aborted };
    return "the abandoned attempt";
  },
  {
    namespace,
    driver,
    lockDuration: 400,
    heartbeatInterval: 60_000,
    ...fast,
  },
);
loser.on("lockLost", (job) => {
  lockLost.push(job.id);
});
void loser.run();

const lostJob = await lostQueue.add("fragile", {}, { removeOnComplete: false });
await waitFor(
  "the recovered attempt to complete",
  async () =>
    (await lostJob.refresh())?.returnValue === "the recovered attempt",
  LONG,
);
const lostDone = await lostJob.refresh();
checkEqual(
  "job.touch() and job.extendLock() answer false once the lock is not ours",
  [afterLoss?.touched, afterLoss?.extended],
  [false, false],
);
checkEqual(
  "ctx.heartbeat() on a lost lock aborts ctx.signal",
  afterLoss?.aborted,
  true,
);
check("lockLost event", lockLost.includes(lostJob.id), lockLost);
checkEqual(
  "the abandoned attempt's result was refused",
  [lostDone?.state, lostDone?.returnValue, lostDone?.stalledCount],
  ["completed", "the recovered attempt", 1],
);

await loser.close();
await lostSweeper.worker.close();
await lostQueue.close();

/* ------------------------------------------------------------------ */
step(
  "6. stalledInterval + maxStalledCount: a worker killed twice buries the job",
);

const stallQueue = new BunQueue("stalls", {
  namespace,
  driver: crossDriver,
});
const stallSweeper = await startSweeper("stalls", {
  driver: crossDriver,
  maxStalledCount: 1,
});

/** Starts a consumer process that claims the job and hangs. */
function spawnStallingConsumer(workerId: string): ReturnType<typeof Bun.spawn> {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("./processors/worker-stalling-consumer.ts", import.meta.url)
        .pathname,
    ],
    {
      env: {
        ...process.env,
        NAMESPACE: namespace,
        DRIVER_CONFIG: JSON.stringify(crossConfig),
        WORKER_ID: workerId,
        QUEUE: "stalls",
      },
      stdout: "ignore",
      stderr: "inherit",
    },
  );
  children.add(child);
  return child;
}

const stallJob = await stallQueue.add("fragile", {});

for (const [round, workerId] of ["doomed-1", "doomed-2"].entries()) {
  const child = spawnStallingConsumer(workerId);
  await waitFor(
    `${workerId} to claim the job`,
    async () => (await stallJob.refresh())?.workerId === workerId,
    LONG,
  );
  child.kill("SIGKILL");
  await child.exited;
  children.delete(child);
  show(`${workerId} killed with SIGKILL`);

  if (round === 0) {
    await waitFor(
      "the first stall to be recovered",
      async () => (await stallJob.refresh())?.state === "waiting",
      LONG,
    );
    checkEqual(
      "stall 1 of maxStalledCount 1: back to waiting",
      (await stallJob.refresh())?.stalledCount,
      1,
    );
  }
}

await waitFor(
  "the second stall to bury the job",
  async () => (await stallJob.refresh())?.state === "dead",
  LONG,
);
checkEqual(
  "stall 2 of maxStalledCount 1: dead",
  (await stallJob.refresh())?.stalledCount,
  2,
);
// The sweeper emits `stalled` once the driver's recovery call has returned,
// so a read here can see the job dead a moment before that event lands (seen
// on MariaDB). Give it a short grace rather than reading one instant.
const stalledSeen = (): number =>
  stallSweeper.stalled.filter((id) => id === stallJob.id).length;
for (let waited = 0; stalledSeen() < 2 && waited < 2_000; waited += 20) {
  await Bun.sleep(20);
}
// On failure, print what the sweeper did see, so a missing recovery can be
// told apart from a duplicate or an unrelated id.
check(
  "stalled event, once per recovery (requeued and buried alike)",
  stalledSeen() === 2,
  {
    job: stallJob.id,
    sweeperSawStalled: stallSweeper.stalled,
    finalState: (await stallJob.refresh())?.toJSON(),
  },
);

await stallSweeper.worker.close();
await stallQueue.close();

/* ------------------------------------------------------------------ */
step("7. pollInterval and maxBlock: how long an idle worker waits");

// The wait is the driver's `waitForJob(ref, ms)`: `maxBlock` on a driver that
// can block, `pollInterval` on one that polls. Recorded by wrapping it.
const budgets: number[] = [];
const originalWait = driver.waitForJob.bind(driver);
driver.waitForJob = async (...args: Parameters<JobsDriver["waitForJob"]>) => {
  if (args[0].queue === "polling") {
    budgets.push(args[1]);
  }
  return await originalWait(...args);
};

const expectedBudget = driver.capabilities.blockingWait ? 90 : 70;
const pollQueue = new BunQueue("polling", { namespace, driver });
const poller = new BunQueueWorker("polling", async () => "polled", {
  namespace,
  driver,
  pollInterval: 70,
  maxBlock: 90,
});
void poller.run();

await waitFor("a few idle waits", () => budgets.length >= 3, LONG);
show(
  `blockingWait: ${driver.capabilities.blockingWait}; waits asked for`,
  budgets.slice(0, 5),
);
check(
  `each idle wait is ${driver.capabilities.blockingWait ? "maxBlock (90)" : "pollInterval (70)"}`,
  budgets.every((ms) => ms === expectedBudget),
  budgets,
);
const polled = await pollQueue.add("job", {});
await waitFor(
  "a job added to the idle worker to complete",
  async () => (await polled.refresh())?.state === "completed",
  LONG,
);
check("an idle worker still picks up work", true);

await poller.close();
driver.waitForJob = originalWait;
await pollQueue.close();

/* ------------------------------------------------------------------ */
step("8. maintenance: false — no promotion by that worker");

const maintQueue = new BunQueue("maintenance", { namespace, driver });
const ranBy: string[] = [];
const noMaintenance = new BunQueueWorker(
  "maintenance",
  async (_job, ctx) => {
    ranBy.push(ctx.workerId);
    return "ran";
  },
  { namespace, driver, id: "no-maintenance", maintenance: false, ...fast },
);
let noMaintenanceReady = false;
noMaintenance.on("ready", () => {
  noMaintenanceReady = true;
});
void noMaintenance.run();
await waitFor("the worker to be ready", () => noMaintenanceReady, LONG);

const delayed = await maintQueue.add("later", {}, { delay: 200 });
await quietWindow(1_500);
// Promotion is maintenance's job on every backend: a claim never promotes a
// due job itself, so this worker alone leaves it delayed however long it waits.
checkEqual(
  "a due delayed job stays delayed with only that worker",
  [(await delayed.refresh())?.state, ranBy.length],
  ["delayed", 0],
);

const promoter = await startSweeper("maintenance");
await waitFor(
  "another worker's maintenance to promote it",
  async () => (await delayed.refresh())?.state === "completed",
  LONG,
);
checkEqual("…and the maintenance-free worker still claims it", ranBy, [
  "no-maintenance",
]);

await noMaintenance.close();
await promoter.worker.close();
await maintQueue.close();

/* ------------------------------------------------------------------ */
step("9. drainDelay: drained only after quiet");

const drainQueue = new BunQueue("drain", { namespace, driver });
const drainedAt: number[] = [];
let drainReadyAt = 0;
let processorEndedAt = 0;
const drainy = new BunQueueWorker(
  "drain",
  async () => {
    await Bun.sleep(50);
    processorEndedAt = Date.now();
    return "ok";
  },
  { namespace, driver, drainDelay: 500, ...fast },
);
drainy.on("ready", () => {
  drainReadyAt = Date.now();
});
drainy.on("drained", () => {
  drainedAt.push(Date.now());
});

let eagerDrains = 0;
const eager = new BunQueueWorker("drain-eager", async () => "ok", {
  namespace,
  driver,
  ...fast,
});
eager.on("drained", () => {
  eagerDrains++;
});

void drainy.run();
void eager.run();

await waitFor("the first drained", () => drainedAt.length === 1, LONG);
check(
  "the first drained comes 500ms after the worker found the queue empty",
  drainedAt[0]! - drainReadyAt >= 490,
  { readyAt: drainReadyAt, drainedAt },
);
await drainQueue.add("job", {});
await waitFor("drained after the job", () => drainedAt.length === 2, LONG);
check(
  "…and again 500ms after the job ended",
  drainedAt[1]! - processorEndedAt >= 490,
  { processorEndedAt, drainedAt },
);
await quietWindow(1_500);
checkEqual("once per quiet spell, not once per poll", drainedAt.length, 2);
check(
  "with the default drainDelay of 0, drained fires on every empty pass",
  eagerDrains >= 3,
  eagerDrains,
);

await drainy.close();
await eager.close();
await drainQueue.close();

/* ------------------------------------------------------------------ */
step("10. backoffStrategies — an instance, a record, and a name nobody gave");

await checkRejects(
  "BackoffStrategies refuses a built-in name",
  () => new BackoffStrategies().define("fixed", () => 1),
  { name: "ConfigError", code: "CONFIG" },
);

const steadyCalls: number[] = [];
const steady = new BackoffStrategies().define("steady", ({ attempt }) => {
  steadyCalls.push(attempt);
  return attempt * 150;
});

const instanceQueue = new BunQueue("backoff-instance", { namespace, driver });
const startedAt: number[] = [];
const outcome = { failed: 0, retrying: 0, dead: 0 };
const retryRunAts: number[] = [];
const instanceWorker = new BunQueueWorker(
  "backoff-instance",
  async () => {
    startedAt.push(Date.now());
    throw new Error("always fails");
  },
  { namespace, driver, backoffStrategies: steady, ...fast },
);
instanceWorker.on("failed", () => {
  outcome.failed++;
});
instanceWorker.on("retrying", (_job, _error, runAt) => {
  outcome.retrying++;
  retryRunAts.push(runAt);
});
instanceWorker.on("dead", () => {
  outcome.dead++;
});
void instanceWorker.run();

const steadyJob = await instanceQueue.add(
  "steady",
  {},
  { attempts: 3, backoff: { type: "steady" } },
);
await waitFor(
  "the steady job to use its attempts",
  async () => (await steadyJob.refresh())?.state === "dead",
  LONG,
);
checkEqual(
  "the named strategy was called per failed attempt",
  steadyCalls,
  [1, 2],
);
check(
  "each retry waited at least the strategy's delay (150ms, then 300ms)",
  startedAt.length === 3 &&
    startedAt[1]! - startedAt[0]! >= 150 &&
    startedAt[2]! - startedAt[1]! >= 300,
  startedAt,
);
checkEqual(
  "failed ×3, retrying ×2, dead ×1",
  [outcome.failed, outcome.retrying, outcome.dead],
  [3, 2, 1],
);
check(
  "retrying carries the next run time",
  retryRunAts.every((at) => at > 0),
  retryRunAts,
);

const recordQueue = new BunQueue("backoff-record", { namespace, driver });
const recordWorker = new BunQueueWorker(
  "backoff-record",
  async () => {
    throw new Error("fails too");
  },
  {
    namespace,
    driver,
    logger,
    // A strategy answering `false` ends retries, attempts left or not.
    backoffStrategies: { giveUp: () => false },
    ...fast,
  },
);
void recordWorker.run();

const giveUpJob = await recordQueue.add(
  "give-up",
  {},
  { attempts: 5, backoff: { type: "giveUp" } },
);
const unknownJob = await recordQueue.add(
  "unknown",
  {},
  { attempts: 2, backoff: { type: "no-such-strategy" } },
);
await waitFor(
  "both record-form jobs to die",
  async () =>
    (await giveUpJob.refresh())?.state === "dead" &&
    (await unknownJob.refresh())?.state === "dead",
  LONG,
);
checkEqual(
  "record form: a strategy answering false stops at attempt 1 of 5",
  (await giveUpJob.refresh())?.attemptsMade,
  1,
);
checkEqual(
  "an unknown name still retries, on the default backoff",
  (await unknownJob.refresh())?.attemptsMade,
  2,
);
const unknownWarning = logEvents.find(
  (event) =>
    event.level === "warn" && event.message.includes('"no-such-strategy"'),
);
check(
  "…and logs a warning naming it",
  unknownWarning !== undefined,
  logEvents
    .filter((event) => event.level === "warn")
    .map((event) => event.message),
);

await instanceWorker.close();
await recordWorker.close();
await instanceQueue.close();
await recordQueue.close();

/* ------------------------------------------------------------------ */
step("11. deadLetterQueue, the deadLettered and error events");

const dlqSource = new BunQueue<{ n: number }>("dlq-source", {
  namespace,
  driver,
});
const dlq = new BunQueue<DeadLetter<{ n: number }>>("dlq", {
  namespace,
  driver,
});
const dlqOwn = new BunQueue<DeadLetter<{ n: number }>>("dlq-own", {
  namespace,
  driver,
});
const letters = new Map<string, string>();
const deadIds: string[] = [];
const workerErrors: string[] = [];
const dlqWorker = new BunQueueWorker<{ n: number }>(
  "dlq-source",
  async (job) => {
    throw new Error(`cannot process ${job.name}`);
  },
  { namespace, driver, deadLetterQueue: "dlq", ...fast },
);
dlqWorker.on("dead", (job) => {
  deadIds.push(job.id);
});
dlqWorker.on("deadLettered", (job, letter) => {
  letters.set(job.id, letter.id);
});
dlqWorker.on("error", (error, context) => {
  workerErrors.push(`${context}: ${error.name}`);
});
void dlqWorker.run();

const plain = await dlqSource.add("plain", { n: 1 });
const own = await dlqSource.add("own", { n: 2 }, { deadLetter: "dlq-own" });
const self = await dlqSource.add(
  "self",
  { n: 3 },
  { deadLetter: "dlq-source" },
);
await waitFor(
  "three deaths, two letters and one error",
  () => deadIds.length === 3 && letters.size === 2 && workerErrors.length >= 1,
  LONG,
);

const plainLetter = await dlq.getJob(letters.get(plain.id) ?? "");
checkEqual(
  "deadLetterQueue: a job naming none is copied there",
  [
    plainLetter?.name,
    plainLetter?.data.queue,
    plainLetter?.data.id,
    plainLetter?.data.data,
    plainLetter?.data.failedReason.message,
    plainLetter?.data.attemptsMade,
  ],
  ["plain", "dlq-source", plain.id, { n: 1 }, "cannot process plain", 1],
);
check(
  "the letter's id derives from the original's",
  (letters.get(plain.id) ?? "").startsWith(`dlq-source:${plain.id}:`),
  letters.get(plain.id),
);
checkEqual(
  "a job's own deadLetter wins over the worker's",
  [
    (await dlqOwn.getJob(letters.get(own.id) ?? ""))?.data.id,
    await dlq.count("waiting"),
  ],
  [own.id, 1],
);
checkEqual(
  "error event: a job naming its own queue as dead-letter queue",
  [workerErrors, letters.has(self.id)],
  [["deadLetter: ConfigError"], false],
);

await dlqWorker.close();
await Promise.all([dlqSource.close(), dlq.close(), dlqOwn.close()]);

/* ------------------------------------------------------------------ */
step("12. limitsRefreshInterval: how soon a worker sees queue.setLimits()");

/** The most jobs a limits scenario ran at once, before and after the limit was lifted. */
interface LimitPeaks {
  /** Under `concurrency: 1`. */
  before: number;
  /** After `setLimits(null)`, once the worker has had time to re-read. */
  after: number;
}

/** Runs gated jobs under a queue concurrency of 1, lifts it, and runs more. */
async function limitScenario(
  queueName: string,
  limitsRefreshInterval: number,
): Promise<LimitPeaks> {
  const queue = new BunQueue(queueName, { namespace, driver });
  await queue.setLimits({ concurrency: 1 });

  const state = { running: 0, peak: 0, done: 0 };
  let hold = gate();
  const worker = new BunQueueWorker(
    queueName,
    async () => {
      state.running++;
      state.peak = Math.max(state.peak, state.running);
      try {
        await hold.opened;
      } finally {
        state.running--;
        state.done++;
      }
    },
    { namespace, driver, concurrency: 4, limitsRefreshInterval, ...fast },
  );
  void worker.run();

  for (let n = 0; n < 3; n++) {
    await queue.add("limited", {});
  }
  await waitFor(
    `${queueName}: one job running`,
    () => state.running === 1,
    LONG,
  );
  await quietWindow(400);
  const before = state.peak;
  hold.open();
  await waitFor(`${queueName}: the first three`, () => state.done === 3, LONG);

  await queue.setLimits(null);
  await quietWindow(600);

  state.peak = 0;
  hold = gate();
  for (let n = 0; n < 3; n++) {
    await queue.add("unlimited", {});
  }
  await waitFor(`${queueName}: a job running`, () => state.running >= 1, LONG);
  await quietWindow(600);
  const after = state.peak;
  hold.open();
  await waitFor(`${queueName}: the next three`, () => state.done === 6, LONG);

  await worker.close();
  await queue.close();
  return { before, after };
}

const quick = await limitScenario("limits-quick", 150);
const slow = await limitScenario("limits-slow", 600_000);
show("peaks (before lifting, after lifting)", { quick, slow });
checkEqual(
  "the stored limit holds both workers to 1",
  [quick.before, slow.before],
  [1, 1],
);
check("a 150ms interval sees the limit lifted", quick.after >= 2, quick);
checkEqual(
  "a 10-minute interval is still trusting the limit it read",
  slow.after,
  1,
);

/* ------------------------------------------------------------------ */
step("13. publish: job events for other processes");

const loudObserver = new BunQueue("published", {
  namespace,
  driver,
  subscribe: true,
});
const quietObserver = new BunQueue("unpublished", {
  namespace,
  driver,
  subscribe: true,
});
await loudObserver.connect();
await quietObserver.connect();
const heardLoud: string[] = [];
const heardQuiet: string[] = [];
loudObserver.on("active", (job) => {
  heardLoud.push(`active ${job.id}`);
});
loudObserver.on("completed", (job) => {
  heardLoud.push(`completed ${job.id}`);
});
quietObserver.on("active", (job) => {
  heardQuiet.push(`active ${job.id}`);
});
quietObserver.on("completed", (job) => {
  heardQuiet.push(`completed ${job.id}`);
});

let quietDone = false;
const quietWorker = new BunQueueWorker("unpublished", async () => "quiet", {
  namespace,
  driver,
  ...fast,
});
quietWorker.on("completed", () => {
  quietDone = true;
});
const loudWorker = new BunQueueWorker("published", async () => "loud", {
  namespace,
  driver,
  publish: true,
  ...fast,
});
void quietWorker.run();
void loudWorker.run();

// Producers that publish nothing themselves, so only the workers can be heard.
const quietProducer = new BunQueue("unpublished", { namespace, driver });
const loudProducer = new BunQueue("published", { namespace, driver });

await quietProducer.add("job", {});
await waitFor("the unpublished job to complete", () => quietDone, LONG);
const loudJob = await loudProducer.add("job", {});
// Every published event is delivered, but on a polling backend an event whose
// write commits late arrives late — so wait for both, and compare them without
// assuming `active` is heard before `completed`.
await waitFor(
  "the observer to hear the published active and completed",
  () => {
    return (
      heardLoud.includes(`active ${loudJob.id}`) &&
      heardLoud.includes(`completed ${loudJob.id}`)
    );
  },
  LONG,
);
checkEqual(
  "publish: true — active and completed reach a subscriber",
  [...heardLoud].sort(),
  [`active ${loudJob.id}`, `completed ${loudJob.id}`].sort(),
);
checkEqual("publish off (the default) — nothing is heard", heardQuiet, []);

await Promise.all([quietWorker.close(), loudWorker.close()]);
await Promise.all(
  [loudObserver, quietObserver, quietProducer, loudProducer].map(
    async (queue) => await queue.close(),
  ),
);

/* ------------------------------------------------------------------ */
step("14. waitToExit: whether an idle worker keeps its process alive");

/** A running idle-worker process and what it has printed so far. */
interface IdleChild {
  /** The process. */
  child: ReturnType<typeof Bun.spawn>;
  /** Its stdout so far. */
  output: () => string;
  /** Its exit code, once it has exited. */
  exitCode: () => number | undefined;
}

/**
 * Starts a process whose only work is an idle worker; with `closeAfterMs` it
 * closes that worker (and so the driver it built) that long after it is ready.
 */
function startIdleChild(waitToExit: boolean, closeAfterMs = 0): IdleChild {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("./processors/worker-idle.ts", import.meta.url).pathname,
    ],
    {
      env: {
        ...process.env,
        NAMESPACE: namespace,
        DRIVER_CONFIG: JSON.stringify(crossConfig),
        WAIT_TO_EXIT: String(waitToExit),
        CLOSE_AFTER_MS: String(closeAfterMs),
      },
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  children.add(child);

  let output = "";
  let exitCode: number | undefined;
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      output += decoder.decode(chunk, { stream: true });
    }
  })();
  void child.exited.then((code) => {
    exitCode = code;
  });

  return { child, output: () => output, exitCode: () => exitCode };
}

const staying = startIdleChild(true);
await waitFor(
  "the waitToExit: true child to be ready",
  () => staying.output().includes("ready") || staying.exitCode() !== undefined,
  LONG,
);
await quietWindow(2_000);
checkEqual(
  "waitToExit: true (the default) — still running on an idle queue",
  staying.exitCode(),
  undefined,
);
staying.child.kill("SIGKILL");
await staying.child.exited;
children.delete(staying.child);

// `false` releases only the worker's own hold on the process. Memory, file and
// SQLite drivers hold nothing else, and neither does Bun's MySQL client (MySQL
// and MariaDB), so there the process exits by itself. The Redis, Postgres and
// MongoDB clients keep a connection that cannot be unref'd — so with those the
// script closes the worker, which closes the driver it built, once its own
// work is done (BunQueueWorkerOptions.waitToExit says so).
const holdsProcess =
  crossConfig.type === "redis" ||
  crossConfig.type === "mongodb" ||
  (crossConfig.type === "sql" &&
    (crossConfig.adapter === "postgres" ||
      /^postgres(?:ql)?:/.test(crossConfig.url ?? "")));

if (!holdsProcess) {
  const leaving = startIdleChild(false);
  await waitFor(
    "the waitToExit: false child to exit by itself",
    () => {
      return leaving.exitCode() !== undefined;
    },
    LONG,
  ).catch(() => {});
  checkEqual(
    "waitToExit: false — the process exits once only the worker is left",
    [leaving.output().includes("ready"), leaving.exitCode()],
    [true, 0],
  );
  if (leaving.exitCode() === undefined) {
    leaving.child.kill("SIGKILL");
  }
  children.delete(leaving.child);
} else {
  const held = startIdleChild(false);
  await waitFor(
    "the waitToExit: false child to be ready",
    () => {
      return held.output().includes("ready") || held.exitCode() !== undefined;
    },
    LONG,
  );
  await quietWindow(2_000);
  checkEqual(
    "waitToExit: false on Redis, Postgres or MongoDB — the open connection still holds the process",
    held.exitCode(),
    undefined,
  );
  held.child.kill("SIGKILL");
  await held.child.exited;
  children.delete(held.child);

  const closing = startIdleChild(false, 500);
  await waitFor(
    "the child to exit once it has closed its worker",
    () => {
      return closing.exitCode() !== undefined;
    },
    LONG,
  ).catch(() => {});
  checkEqual(
    "waitToExit: false + close() — the process exits once the worker and its driver are closed",
    [closing.output().includes("ready"), closing.exitCode()],
    [true, 0],
  );
  if (closing.exitCode() === undefined) {
    closing.child.kill("SIGKILL");
  }
  children.delete(closing.child);
}

/* ------------------------------------------------------------------ */
step("15. close(): graceful, { timeout }, { force }");

/** Jobs that ignore their signal hold this gate, which is never opened. */
const never = gate();
const signals: AbortSignal[] = [];

/** A worker whose jobs ignore their signal and wait on `hold`. */
function stubbornWorker(queueName: string, hold: Gate): BunQueueWorker {
  return new BunQueueWorker(
    queueName,
    async (_job, ctx) => {
      signals.push(ctx.signal);
      await hold.opened;
      return "finished";
    },
    { namespace, driver, ...fast },
  );
}

// Graceful: waits for the job in flight, and its completion.
const gracefulQueue = new BunQueue("closing-graceful", { namespace, driver });
const release = gate();
const graceful = stubbornWorker("closing-graceful", release);
void graceful.run();
const gracefulJob = await gracefulQueue.add("job", {});
await waitFor(
  "the graceful job to start",
  () => graceful.activeCount === 1,
  LONG,
);
let gracefulClosed = false;
const gracefulClosing = graceful.close().then(() => {
  gracefulClosed = true;
});
await quietWindow(300);
checkEqual("close() waits for jobs in flight", gracefulClosed, false);
release.open();
await gracefulClosing;
checkEqual(
  "…and their completion is written before it resolves",
  (await gracefulJob.refresh())?.state,
  "completed",
);

// { timeout }: gives up on a job that ignores its signal.
const patientQueue = new BunQueue("closing-timeout", { namespace, driver });
const patient = stubbornWorker("closing-timeout", never);
const lifecycle: string[] = [];
patient.on("closing", () => {
  lifecycle.push("closing");
});
patient.on("closed", () => {
  lifecycle.push("closed");
});
let patientRunResolved = false;
const patientRun = patient.run().then(() => {
  patientRunResolved = true;
});
const stuck = await patientQueue.add("job", {});
await waitFor("the stuck job to start", () => patient.activeCount === 1, LONG);
const patientStarted = Date.now();
await patient.close({ timeout: 300 });
const patientTook = Date.now() - patientStarted;
check(
  "close({ timeout: 300 }) waits the timeout, not lockDuration (30s)",
  patientTook >= 290 && patientTook < 10_000,
  patientTook,
);
checkEqual("…aborting the job's signal", signals.at(-1)?.aborted, true);
checkEqual("closing then closed", lifecycle, ["closing", "closed"]);
await patientRun;
checkEqual(
  "run() resolved and isRunning is false",
  [patientRunResolved, patient.isRunning],
  [true, false],
);
checkEqual(
  "the abandoned job is left active, for the stalled sweep",
  (await stuck.refresh())?.state,
  "active",
);

// { force }: no wait at all.
const forcedQueue = new BunQueue("closing-force", { namespace, driver });
const forced = stubbornWorker("closing-force", never);
let forcedClosed = false;
forced.on("closed", () => {
  forcedClosed = true;
});
void forced.run();
await forcedQueue.add("job", {});
await waitFor("the forced job to start", () => forced.activeCount === 1, LONG);
const forcedStarted = Date.now();
await forced.close({ force: true, timeout: 20_000 });
const forcedTook = Date.now() - forcedStarted;
check(
  "close({ force: true }) does not wait, even with a timeout given",
  forcedTook < 10_000,
  forcedTook,
);
checkEqual(
  "…aborting the signal and emitting closed",
  [signals.at(-1)?.aborted, forcedClosed],
  [true, true],
);

await Promise.all([
  gracefulQueue.close(),
  patientQueue.close(),
  forcedQueue.close(),
]);

/* ------------------------------------------------------------------ */
step("Cleanup");

await driver.purge(namespace);
await crossDriver.purge(namespace);
await driver.close();
await crossDriver.close();

summary();
