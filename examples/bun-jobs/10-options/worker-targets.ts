/**
 * Option tour: `target` — a worker running a processor *file* on each local
 * kind (`"in-process"`, `"worker-thread"`, `"child-process"`), each behaviour
 * asserted.
 *
 * ```bash
 * bun 10-options/worker-targets.ts
 * EXAMPLE_DRIVER=sqlite bun 10-options/worker-targets.ts
 * ```
 *
 * Worth knowing:
 *
 * - A target is the string, or `{ kind, ...tuning }`, and each kind takes only
 *   its own tuning: `"in-process"` none, `"worker-thread"` `closeTimeout` and
 *   `worker`, `"child-process"` `closeTimeout`, `killTimeout` and `spawn`.
 *   Tuning for the wrong kind is a type error, and a `ConfigError` from plain
 *   JavaScript (step 8).
 * - Runners and workers name the two mechanisms in the same words: a
 *   runner's `executionMode` and a worker's `target` are both
 *   `"worker-thread"` or `"child-process"`, and the attempt's own process
 *   sees that same word in `BUN_JOBS_MODE`. Step 1 asserts that last part.
 * - The file default-exports the same `(job, ctx)` function a function
 *   processor is; `defineProcessor` types it. It may be named by an absolute
 *   path, a path relative to a `"child-process"` target's `spawn.cwd` (else
 *   the working directory), a `URL` or a `file://` string.
 * - The worker keeps the driver. In a child, `job.updateProgress`, `job.log`,
 *   `job.touch`/`extendLock`, `ctx.log` and `ctx.heartbeat` travel to the
 *   worker and are answered from there; every other operation that changes the
 *   stored job rejects with "not available in an isolated job" — `schedule`,
 *   `update`, `disable` and `enable` included.
 * - `job.updateProgress` is the one job-channel call that is *sent* rather than
 *   asked, so it costs no round trip however often a processor reports. What
 *   awaiting it buys is ordering: the worker has the value and will write it,
 *   in the order the processor reported it, before it records how the job ended
 *   — not that the driver has it at that instant. That holds however the
 *   attempt ended and wherever it ran, and it holds for `job.log` too, awaited
 *   or not: the worker waits for whatever the attempt still has in flight
 *   before it writes the completion or the failure. The wait is bounded, and
 *   step 3 demonstrates both halves of that.
 * - `job.fail(reason)` works on every target: the child keeps the reason and
 *   reports it as the attempt's error when the processor settles, so the job
 *   goes to `dead` exactly as it would in-process.
 * - The worker owns the attempt's `timeout`: the job dies at the deadline.
 *   On a `"child-process"` target the child is then asked to close, sent
 *   `SIGTERM` `closeTimeout` later, and `SIGKILL` `killTimeout` after that —
 *   the only target where a processor that ignores its signal is stopped for
 *   certain.
 */
import type {
  JobsDriver,
  LocalWorkerTarget,
  LoggerLike,
} from "@kingsleyweb/bun-jobs";
import type { FailData } from "./processors/isolation-fail";
import type { HangData } from "./processors/isolation-hang";
import type { JobFailData } from "./processors/isolation-job-fail";
import type { Report, ReportData } from "./processors/isolation-report";
import type { SlowWriteData } from "./processors/isolation-slow-write";
import type {
  Unavailable,
  UnavailableData,
} from "./processors/isolation-unavailable";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  createDriver,
} from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Worker targets");

/** A bare log sink: one of the shapes a `logger` option accepts. */
type LogSink = Extract<LoggerLike, (...args: never[]) => unknown>;
/** One record a sink receives. */
type LogEvent = Parameters<LogSink>[0];

/** Every record the workers logged, so forwarded child logs can be checked. */
const logEvents: LogEvent[] = [];
const logger: LogSink = (event) => {
  logEvents.push(event);
};

const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("worker-targets");
const processors = join(import.meta.dir, "processors");
const reportFile = join(processors, "isolation-report.ts");
/** The processor whose one write is still in flight when its attempt ends. */
const slowWriteFile = join(processors, "isolation-slow-write.ts");
/** Short waits, so the tour spends its time on the work. */
const fast = { pollInterval: 25, maxBlock: 50 };
/**
 * How often the tour's workers sweep for stalled jobs, in milliseconds — the
 * `stalledInterval` option, whose default is 30s, far longer than a tour can
 * wait.
 *
 * Every worker on a queue is given it, not only the sweeper a step is about.
 * The queue's repair cadence is the fleet's rather than any one worker's: each
 * worker sweeps on its own `stalledInterval`, so the shortest on the queue is
 * what sets the pace, and a fleet that elected one sweeper per queue would
 * take the elected worker's instead. No step can name the worker whose
 * interval will count, so this one is set on all of them.
 */
const SWEEP_INTERVAL = 100;
/** How long to wait for anything that involves starting a process. */
const LONG = { timeout: 30_000 };

/** Process ids of spawned processors, killed on exit whatever happened. */
const pids = new Set<number>();
process.once("exit", () => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

/** Whether a process is still alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
step("1. Each target runs the file, and the job channel reaches the worker");

/** How one target is set up. */
interface TargetCase {
  /**
   * Where each attempt runs, with its kind's own tuning: `"in-process"` takes
   * none, so a `closeTimeout` there would be a type error.
   */
  target: LocalWorkerTarget;
  /** The processor file, in one of the forms a worker accepts. */
  processor: string | URL;
}

const cases: TargetCase[] = [
  // An absolute path. In-process there is nothing to tune.
  { target: { kind: "in-process" }, processor: reportFile },
  // A URL.
  {
    target: {
      kind: "worker-thread",
      closeTimeout: 2_000,
      worker: {
        smol: true,
        name: "tour-isolated-worker",
        env: { TOUR_ISOLATION_ENV: "from worker.env" },
        argv: ["--from-worker-argv"],
      },
    },
    processor: new URL("./processors/isolation-report.ts", import.meta.url),
  },
  // A relative path, resolved against `spawn.cwd`.
  {
    target: {
      kind: "child-process",
      closeTimeout: 2_000,
      killTimeout: 1_000,
      spawn: {
        cwd: processors,
        env: { TOUR_ISOLATION_ENV: "from spawn.env" },
        args: ["--from-spawn-args"],
      },
    },
    processor: "./isolation-report.ts",
  },
];

for (const { target, processor } of cases) {
  const mode = target.kind;
  const queueName = `report-${mode}`;
  const queue = new BunQueue<ReportData, Report>(queueName, {
    namespace,
    driver,
  });
  const worker = new BunQueueWorker<ReportData, Report>(queueName, processor, {
    namespace,
    driver,
    logger,
    target,
    ...fast,
  });
  const progress: unknown[] = [];
  worker.on("progress", (_job, value) => {
    progress.push(value);
  });
  void worker.run();

  const job = await queue.add(
    "report",
    { label: mode },
    { removeOnComplete: false },
  );
  // The state flip need not be the last write. Off the worker's thread every
  // `job.updateProgress` is a message to the worker, so the value is written
  // by the worker rather than by the processor — and a version without the
  // ordering step 2 asserts could write it *after* the completion, leaving a
  // reader who looked the instant the state flipped with the previous value.
  // So the wait is for the record to have settled, not for the state alone:
  // both progress checks below then read a finished job rather than racing
  // that write, whatever version they run against. The processor sends two
  // updates, and the stored value must be the later of them; *which* values
  // they are is what the checks assert, so nothing is assumed here. All three
  // targets share this wait.
  await waitFor(
    `the ${mode} report to complete, with its last progress written`,
    async () => {
      const settling = await queue.getJob(job.id);
      return (
        settling?.state === "completed" &&
        progress.length === 2 &&
        settling.progress === progress.at(-1)
      );
    },
    LONG,
  );

  const stored = await queue.getJob(job.id);
  const report = stored?.returnValue as Report;
  show(`${mode} ran in`, {
    pid: report.pid,
    isMainThread: report.isMainThread,
    mode: report.mode,
  });

  checkEqual(`${mode}: returns the processor's result`, report.jobId, job.id);
  if (mode === "child-process") {
    check(`${mode}: another process`, report.pid !== process.pid, report.pid);
  } else {
    checkEqual(`${mode}: this process`, report.pid, process.pid);
  }
  checkEqual(
    `${mode}: isMainThread`,
    report.isMainThread,
    mode !== "worker-thread",
  );
  // The target's own word: the executor that starts a child or a Worker sets
  // `BUN_JOBS_MODE` from its mode, and in-process nothing sets it.
  checkEqual(
    `${mode}: BUN_JOBS_CHILD / BUN_JOBS_MODE`,
    [report.child, report.mode],
    [mode === "in-process" ? null : "1", mode === "in-process" ? null : mode],
  );

  if (mode === "worker-thread") {
    checkEqual(`${mode}: worker.env`, report.env, "from worker.env");
    check(
      `${mode}: worker.argv becomes process.argv`,
      report.argv.includes("--from-worker-argv"),
      report.argv,
    );
  } else if (mode === "child-process") {
    checkEqual(`${mode}: spawn.env`, report.env, "from spawn.env");
    checkEqual(`${mode}: spawn.cwd`, report.cwd, processors);
    check(
      `${mode}: spawn.args are appended to the command line`,
      report.argv.includes("--from-spawn-args"),
      report.argv,
    );
  } else {
    checkEqual(`${mode}: no executor env`, report.env, null);
  }

  checkEqual(
    `${mode}: job.log then ctx.log answer the line count`,
    report.logged,
    [1, 2],
  );
  checkEqual(
    `${mode}: both lines reached the stored log`,
    await queue.getJobLogs(job.id),
    { logs: [`hello from ${mode}`, "second line"], count: 2 },
  );
  checkEqual(
    `${mode}: job.updateProgress reached the worker's progress event`,
    progress,
    [25, 100],
  );
  checkEqual(`${mode}: …and the store`, stored?.progress, 100);
  checkEqual(
    `${mode}: job.touch() and job.extendLock() hold the lock`,
    [report.touched, report.extended],
    [true, true],
  );
  checkEqual(`${mode}: ctx.workerId`, report.workerId, worker.id);
  checkEqual(`${mode}: ctx.attempt`, report.attempt, 1);
  checkEqual(`${mode}: job.queue`, report.queue, {
    ns: namespace,
    queue: queueName,
  });
  checkEqual(
    `${mode}: job.isRepeat, job.lockToken, job.toJSON()`,
    [report.isRepeat, report.hasLockToken, report.recordId],
    [false, true, job.id],
  );
  const forwarded = logEvents.find(
    (event) =>
      event.message === "isolated logger line" && event.fields.label === mode,
  );
  check(
    `${mode}: ctx.logger records reach the worker's logger`,
    forwarded !== undefined,
    logEvents.map((event) => event.message),
  );

  await worker.close();
  await queue.close();
}

/* ------------------------------------------------------------------ */
step("2. An awaited updateProgress is written before the completion is");

// Step 1 waits for the record to settle before reading it, and should: that is
// what a reader does against any version. This step waits for no write at all.
// It reads the record the instant the worker announces a job `completed` — the
// earliest moment a reader could look — and asserts that read already carries
// the value the processor reported last.
//
// That is the ordering a worker guarantees off its own thread. A child's
// `job.updateProgress` is *sent*, not asked: awaiting it does not mean the
// driver has the value, it means the worker has it and will write it — in the
// order the processor reported it, and before it records how the job ended. So
// the completion cannot overtake a progress value the processor awaited.
//
// The conditions are deliberate, because the ordering is only observable under
// load: one job reporting twice keeps its order by luck, its progress write
// going out a tick ahead of the completion and winning. So each processor
// reports a burst (`progressSteps`) and ten of them run at once, which leaves a
// dozen writes per job contending for the driver's pool. Measured on MySQL
// against a version without this guarantee, 8 to 9 of these ten jobs read back
// an intermediate value at their own completion; with it, none do, on every
// backend.
//
// The conditions are also this step's limits: ten jobs contending, every value
// awaited, every processor returning normally. Step 3 takes the two cases they
// leave out — a deadline that abandons the run, and a write nobody awaited at
// all — and asserts the same ordering there.

/** How many values each processor reports before its final `100`. */
const BURST = 10;
/** How many of those jobs run at once, so their writes contend. */
const TOGETHER = 10;

for (const mode of ["worker-thread", "child-process"] as const) {
  const queueName = `ordered-${mode}`;
  const queue = new BunQueue<ReportData, Report>(queueName, {
    namespace,
    driver,
  });
  const worker = new BunQueueWorker<ReportData, Report>(queueName, reportFile, {
    namespace,
    driver,
    // Collected rather than printed: ten processors each log a line, and the
    // step is about the writes, not the logging.
    logger,
    target: { kind: mode, closeTimeout: 2_000 },
    concurrency: TOGETHER,
    ...fast,
  });
  /** What the record carried on the read fired at each job's `completed`. */
  const atCompletion = new Map<string, { state: string; progress: unknown }>();
  /** Those reads, so the checks below cannot run before one finishes. */
  const reads: Promise<void>[] = [];
  worker.on("completed", (done) => {
    reads.push(
      (async () => {
        const record = await queue.getJob(done.id);
        // The first read of each job only. A second would be a later look, and
        // a later look is exactly what this step is not allowed to take.
        if (!atCompletion.has(done.id)) {
          atCompletion.set(done.id, {
            state: record?.state ?? "gone",
            progress: record?.progress,
          });
        }
      })(),
    );
  });
  void worker.run();

  const ids: string[] = [];
  for (let n = 0; n < TOGETHER; n++) {
    const job = await queue.add(
      "report",
      { label: `${mode}-ordered-${n}`, progressSteps: BURST },
      { removeOnComplete: false },
    );
    ids.push(job.id);
  }
  await waitFor(
    `all ${TOGETHER} ${mode} jobs to be announced completed`,
    () => atCompletion.size === TOGETHER,
    LONG,
  );
  await Promise.all(reads);

  const stale = ids.filter((id) => atCompletion.get(id)?.progress !== 100);
  show(`${mode}: the read taken at each job's completion`, {
    jobs: TOGETHER,
    valuesReportedEach: BURST + 2,
    carriedTheLastValue: TOGETHER - stale.length,
    carriedAnEarlierOne: stale.length,
  });
  checkEqual(
    `${mode}: every completion read already carries the last progress value`,
    stale.map((id) => atCompletion.get(id)),
    [],
  );
  checkEqual(
    `${mode}: …and each of those reads really was of a completed job`,
    [...new Set(ids.map((id) => atCompletion.get(id)?.state))],
    ["completed"],
  );

  await worker.close();
  await queue.close();
}

/* ------------------------------------------------------------------ */
step("3. A deadline keeps that ordering, and so does a write nobody awaited");

// Step 2 makes its writes contend and reads what comes of it. These two
// demonstrations remove the race instead: the tour's driver holds the one write
// each is about, so that write is *certainly* unfinished at the moment the
// record of the ending is made. Nothing else about them is unusual — one job
// each, one worker each, the ordinary options.
//
// They are the two cases step 2 cannot reach:
//
// - A job that hits its `opts.timeout` has its run abandoned rather than waited
//   for — the whole point of a deadline is not to wait — and here it is
//   abandoned *inside* a progress write, on an `"in-process"` target, where
//   there is no job channel to blame: the processor is calling the driver
//   itself. The value still lands before the failure record.
// - A child that calls `job.log()` and never awaits it has returned while the
//   line is still on its way. The completion write is the one the worker
//   deliberately does not wait for either, so this is the ordinary happy path's
//   half of the same question, with no timeout involved at all.
//
// What is *not* promised is an unbounded wait, and the bound is a rule rather
// than a figure. An attempt that reached its own end — returned, threw, called
// `job.fail()` — is given a quarter of its worker's `lockDuration`, which the
// `show` below derives from the lock this step sets. One the worker gave up on
// is given a short flat floor instead, which is also the least the first can
// ever be, so a `lockDuration` of zero still means some budget rather than
// none. The reason is the part worth keeping: past the lock the job belongs to
// the stalled sweep, so waiting longer than a fraction of the lock buys nothing
// and costs a worker a concurrency slot. Reach the cap — a write still in
// flight when the budget runs out — and the ending is recorded anyway, and that
// write may land after it, exactly as every write could before this ordering
// existed. A store that has stopped answering cannot pin a worker to a job that
// is already over. Both holds below are deliberately well inside their budget;
// a store slower than its worker's budget is one whose last write can still
// lose the race.

/** The deadline the timed-out job below is given, in milliseconds. */
const WRITE_DEADLINE = 600;
/**
 * How long after that deadline the held progress write lands, in milliseconds.
 *
 * Far enough past it that a worker recording the failure and moving on would be
 * caught doing so — the read below happens within a poll of the job reading
 * `dead` — and well inside the flat floor an abandoned attempt's writes are
 * given.
 */
const WRITE_OVERRUN = 150;
/** How long the un-awaited log write below is held, in milliseconds. */
const LOG_HOLD = 300;
/** The lock the completing worker below holds, so the budget shown is its own. */
const WRITE_LOCK = 8_000;

/** How long {@link held} holds a progress write, in milliseconds. */
let holdProgress = 0;
/** How long {@link held} holds a log write, in milliseconds. */
let holdLog = 0;

/**
 * The tour's driver with the two writes an attempt keeps in flight —
 * `updateProgress` and `addJobLog` — held back by {@link holdProgress} and
 * {@link holdLog} milliseconds. Every other call goes straight through, and the
 * steps above and below use the driver itself.
 *
 * A slowed wrapper rather than a slow backend, because what this step asserts
 * is an *order*: it is only worth asserting when the write it is about is
 * certainly unfinished at the moment the ending is recorded, and on a quick
 * store a single job's writes finish so fast that both orders look alike. The
 * library's own tests do the same thing for the same reason.
 */
const held: JobsDriver = new Proxy(driver, {
  get(target, property) {
    // Read from, and called on, the real driver: a driver holds private fields,
    // and a method whose `this` is the proxy cannot see them.
    const value = Reflect.get(target, property, target) as unknown;

    if (typeof value !== "function") {
      return value;
    }

    const method = value as (...args: unknown[]) => unknown;
    const holding =
      property === "updateProgress"
        ? (): number => holdProgress
        : property === "addJobLog"
          ? (): number => holdLog
          : undefined;

    if (!holding) {
      return method.bind(target);
    }

    return async (...args: unknown[]): Promise<unknown> => {
      const hold = holding();

      if (hold > 0) {
        await Bun.sleep(hold);
      }

      return await method.apply(target, args);
    };
  },
});

{
  // Held until the deadline has passed: the processor is inside
  // `job.updateProgress` when the worker gives up on its attempt.
  holdProgress = WRITE_DEADLINE + WRITE_OVERRUN;
  holdLog = 0;

  const queue = new BunQueue<SlowWriteData, string>("timed-write", {
    namespace,
    driver: held,
  });
  const worker = new BunQueueWorker<SlowWriteData, string>(
    "timed-write",
    slowWriteFile,
    {
      namespace,
      driver: held,
      logger,
      target: "in-process",
      ...fast,
    },
  );
  void worker.run();

  const job = await queue.add(
    "slow",
    { progress: 42 },
    { attempts: 1, timeout: WRITE_DEADLINE, removeOnFail: false },
  );
  /** What the record carried on the read that first found the job dead. */
  let atDeath: { progress: unknown; failedWith?: string } | undefined;
  await waitFor(
    "the in-process job to be read dead",
    async () => {
      const record = await queue.getJob(job.id);

      if (record?.state !== "dead") {
        return false;
      }

      // The first read only, and the one that found it: a second look would be
      // a later look, which is what this must not take.
      atDeath = {
        progress: record.progress,
        failedWith: record.failedReason?.name,
      };
      return true;
    },
    { ...LONG, interval: 5 },
  );
  show("the read that first found the in-process job dead", {
    ...atDeath,
    deadline: WRITE_DEADLINE,
    theWriteLandedAfterTheDeadlineBy: WRITE_OVERRUN,
  });
  checkEqual(
    "in-process: a progress write still in flight at the deadline lands before the failure record",
    [atDeath?.progress, atDeath?.failedWith],
    [42, "JobTimeoutError"],
  );

  await worker.close();
  await queue.close();
}

{
  // Held past the moment the processor returns: the line is on its way while
  // the worker has the result in hand.
  holdProgress = 0;
  holdLog = LOG_HOLD;

  const queue = new BunQueue<SlowWriteData, string>("unawaited-log", {
    namespace,
    driver: held,
  });
  const worker = new BunQueueWorker<SlowWriteData, string>(
    "unawaited-log",
    slowWriteFile,
    {
      namespace,
      driver: held,
      logger,
      target: { kind: "child-process", closeTimeout: 2_000 },
      lockDuration: WRITE_LOCK,
      ...fast,
    },
  );
  void worker.run();

  const job = await queue.add(
    "slow",
    { line: "sent, never waited for" },
    { attempts: 1, removeOnComplete: false },
  );
  /** The log as it read the moment the job first read `completed`. */
  let atCompletion: { logs: string[]; count: number } | undefined;
  await waitFor(
    "the spawned job to be read completed",
    async () => {
      if ((await queue.getJob(job.id))?.state !== "completed") {
        return false;
      }

      atCompletion = await queue.getJobLogs(job.id);
      return true;
    },
    { ...LONG, interval: 5 },
  );
  show("what this worker's lock gives the wait for its writes", {
    lockDuration: WRITE_LOCK,
    aQuarterOfIt: WRITE_LOCK / 4,
    theWriteWasHeldFor: LOG_HOLD,
  });
  show("the log as it read the moment the spawned job read completed", {
    ...atCompletion,
  });
  checkEqual(
    "child-process: a log line the child never waited for is stored before the completion record",
    atCompletion,
    { logs: ["sent, never waited for"], count: 1 },
  );

  await worker.close();
  await queue.close();
}

/* ------------------------------------------------------------------ */
step("4. ctx.heartbeat() from a child keeps a long job's lock");

// The worker's own renewal is effectively off (a minute apart, against a
// 3-second lock), so only the child's heartbeats can keep the job. A paused
// worker sweeps for stalled jobs every SWEEP_INTERVAL ms and would take it
// back — as would `beating` itself, so both are given that cadence and either
// one's sweep is quick enough to catch a lock that lapses.
const heartbeatQueue = new BunQueue<ReportData, Report>("heartbeats", {
  namespace,
  driver,
});
const sweeper = new BunQueueWorker("heartbeats", async () => null, {
  namespace,
  driver,
  stalledInterval: SWEEP_INTERVAL,
  ...fast,
});
/** Ids the queue's stalled sweep recovered, from whichever worker ran it. */
const swept: string[] = [];
sweeper.on("stalled", (ids) => {
  swept.push(...ids);
});
await sweeper.pause();
void sweeper.run();

const beating = new BunQueueWorker<ReportData, Report>(
  "heartbeats",
  reportFile,
  {
    namespace,
    driver,
    target: { kind: "child-process", closeTimeout: 2_000 },
    lockDuration: 3_000,
    heartbeatInterval: 60_000,
    // The same cadence as the sweeper beside it: the checks below need a sweep
    // inside the ~6s the job runs, whichever worker's sweep that turns out to
    // be — otherwise nothing sweeps in time and the two would pass for the
    // wrong reason.
    stalledInterval: SWEEP_INTERVAL,
    ...fast,
  },
);
beating.on("stalled", (ids) => {
  swept.push(...ids);
});
void beating.run();

const longJob = await heartbeatQueue.add(
  "report",
  { label: "heartbeats", beats: 10, beatEvery: 600 },
  { removeOnComplete: false },
);
await waitFor(
  "the long isolated job to complete",
  async () => (await heartbeatQueue.getJob(longJob.id))?.state === "completed",
  LONG,
);
const beaten = await heartbeatQueue.getJob(longJob.id);
checkEqual(
  "it sent 10 heartbeats over ~6s",
  (beaten?.returnValue as Report).heartbeats,
  10,
);
check(
  "it ran for longer than its lock lasts",
  (beaten?.finishedOn ?? 0) - (beaten?.processedOn ?? 0) >= 5_000,
  { processedOn: beaten?.processedOn, finishedOn: beaten?.finishedOn },
);
checkEqual("never stalled", beaten?.stalledCount, 0);
// `swept` collects both workers' `stalled` events, so this holds whichever of
// them ran the sweep — and is not satisfied by no sweep having run at all.
check(
  "neither worker's sweep recovered it",
  !swept.includes(longJob.id),
  swept,
);

await beating.close();
await sweeper.close();
await heartbeatQueue.close();

/* ------------------------------------------------------------------ */
step("5. Operations that change the stored job are unavailable in a child");

const unavailableFile = join(processors, "isolation-unavailable.ts");
const isolatedOnly = [
  "updateData",
  "setPriority",
  "reschedule",
  "remove",
  "retry",
  "promote",
  "refresh",
  "getLogs",
  "schedule",
  "update",
  "disable",
  "enable",
];

for (const mode of ["child-process", "worker-thread", "in-process"] as const) {
  const queueName = `unavailable-${mode}`;
  const queue = new BunQueue<UnavailableData, Unavailable>(queueName, {
    namespace,
    driver,
  });
  const worker = new BunQueueWorker<UnavailableData, Unavailable>(
    queueName,
    unavailableFile,
    {
      namespace,
      driver,
      // Built per kind: `"in-process"` takes no tuning, so it gets none.
      target:
        mode === "in-process" ? mode : { kind: mode, closeTimeout: 2_000 },
      ...fast,
    },
  );
  void worker.run();

  // In-process the job is the real `Job`, so only the harmless ones are tried.
  const methods =
    mode === "in-process"
      ? ["updateData", "setPriority", "refresh", "getLogs"]
      : isolatedOnly;
  const job = await queue.add("try", { methods }, { removeOnComplete: false });
  await waitFor(
    `the ${mode} attempt to complete`,
    async () => (await queue.getJob(job.id))?.state === "completed",
    LONG,
  );
  const outcome = (await queue.getJob(job.id))?.returnValue ?? {};

  if (mode === "in-process") {
    checkEqual(
      "in-process: the same calls work on the real Job",
      Object.values(outcome),
      ["ok", "ok", "ok", "ok"],
    );
  } else {
    for (const method of isolatedOnly) {
      check(
        `${mode}: job.${method}() rejects as not available`,
        new RegExp(
          `job\\.${method}\\(\\) is not available in an isolated job`,
        ).test(outcome[method] ?? ""),
        outcome[method],
      );
    }
  }

  await worker.close();
  await queue.close();
}

/* ------------------------------------------------------------------ */
step("6. Errors cross the boundary and still decide retries; so does fail()");

const failFile = join(processors, "isolation-fail.ts");

for (const mode of ["child-process", "worker-thread"] as const) {
  const queueName = `fail-${mode}`;
  const queue = new BunQueue<FailData>(queueName, { namespace, driver });
  const worker = new BunQueueWorker<FailData>(queueName, failFile, {
    namespace,
    driver,
    target: { kind: mode, closeTimeout: 2_000 },
    ...fast,
  });
  const dead: string[] = [];
  worker.on("dead", (job) => {
    dead.push(job.id);
  });
  void worker.run();

  const doomed = await queue.add(
    "fail",
    { unrecoverable: true },
    { attempts: 5, backoff: 1 },
  );
  const flaky = await queue.add("fail", {}, { attempts: 2, backoff: 1 });
  await waitFor(`both ${mode} jobs to die`, () => dead.length === 2, LONG);

  const doomedNow = await queue.getJob(doomed.id);
  const flakyNow = await queue.getJob(flaky.id);
  checkEqual(
    `${mode}: UnrecoverableJobError kills the job on its first attempt`,
    [doomedNow?.state, doomedNow?.attemptsMade, doomedNow?.failedReason?.name],
    ["dead", 1, "UnrecoverableJobError"],
  );
  checkEqual(
    `${mode}: a plain Error is retried to its attempts`,
    [flakyNow?.state, flakyNow?.attemptsMade, flakyNow?.failedReason?.message],
    ["dead", 2, "attempt 2 failed"],
  );

  await worker.close();
  await queue.close();
}

// `job.fail()` needs no driver in the child: the reason is kept there and
// reported as the attempt's error when the processor settles.
const jobFailFile = join(processors, "isolation-job-fail.ts");

for (const mode of ["child-process", "worker-thread"] as const) {
  const queueName = `job-fail-${mode}`;
  const queue = new BunQueue<JobFailData>(queueName, { namespace, driver });
  const worker = new BunQueueWorker<JobFailData>(queueName, jobFailFile, {
    namespace,
    driver,
    target: { kind: mode, closeTimeout: 2_000 },
    ...fast,
  });
  /** Local `dead` events, by job id, with their error's message. */
  const dead = new Map<string, string>();
  worker.on("dead", (job, error) => {
    dead.set(job.id, error.message);
  });
  void worker.run();

  const options = { attempts: 3, backoff: 1 } as const;
  const byString = await queue.add("fail", { how: "string" }, options);
  const byError = await queue.add("fail", { how: "error" }, options);
  await waitFor(`both ${mode} fail() jobs to die`, () => dead.size === 2, LONG);
  // What `fail()` answered travels as progress. That write is ordered ahead of
  // the failure record — the worker settles an attempt's writes before it
  // records how the job ended, and it ends both ways here, one processor
  // returning and one throwing — so this is no longer waiting on a race; step 3
  // is where that ordering is asserted. It is kept as the read's own guard:
  // `progress` starts as `null`, so waiting for it to be anything at all says
  // plainly that the store is caught up before the checks below look.
  await waitFor(
    `both ${mode} fail() answers to reach the store`,
    async () => {
      const settling = await Promise.all([
        queue.getJob(byString.id),
        queue.getJob(byError.id),
      ]);
      // A record not there yet counts as not written, not as written.
      return settling.every((record) => (record?.progress ?? null) !== null);
    },
    LONG,
  );

  const stringNow = await queue.getJob(byString.id);
  const errorNow = await queue.getJob(byError.id);
  checkEqual(
    `${mode}: job.fail() answered true in the child`,
    [stringNow?.progress, errorNow?.progress],
    [{ answered: true }, { answered: true }],
  );
  checkEqual(
    `${mode}: dead after one attempt of three, though the processor returned`,
    [
      stringNow?.state,
      stringNow?.attemptsMade,
      stringNow?.returnValue,
      stringNow?.failedReason?.name,
      stringNow?.failedReason?.message,
      stringNow?.failedReason?.cause,
    ],
    [
      "dead",
      1,
      null,
      "UnrecoverableJobError",
      "the input can never be processed",
      undefined,
    ],
  );
  const cause = errorNow?.failedReason?.cause as Error | undefined;
  checkEqual(
    `${mode}: an Error reason wins over the later throw, and keeps its cause`,
    [
      errorNow?.state,
      errorNow?.attemptsMade,
      errorNow?.failedReason?.message,
      cause?.message,
      (cause?.cause as Error | undefined)?.message,
    ],
    ["dead", 1, "card declined", "card declined", "gateway timeout"],
  );
  checkEqual(
    `${mode}: the worker's dead events carry the reasons`,
    [dead.get(byString.id), dead.get(byError.id)],
    ["the input can never be processed", "card declined"],
  );

  await worker.close();
  await queue.close();
}

/* ------------------------------------------------------------------ */
step("7. timeout stops a child-process processor that ignores its signal");

const hangFile = join(processors, "isolation-hang.ts");

/** One way a hanging child is stopped. */
interface Escalation {
  /** What the scenario shows. */
  label: string;
  /** What the job carries. */
  data: HangData;
  /** The `"child-process"` target's `closeTimeout`. */
  closeTimeout: number;
  /** The `"child-process"` target's `killTimeout`. */
  killTimeout: number;
}

const escalations: Escalation[] = [
  {
    label: "SIGTERM after closeTimeout",
    data: {},
    closeTimeout: 2_000,
    killTimeout: 20_000,
  },
  {
    label:
      "SIGKILL after closeTimeout + killTimeout, for one that survives SIGTERM",
    data: { ignoreSigterm: true },
    closeTimeout: 1_000,
    killTimeout: 2_000,
  },
];

for (const [index, escalation] of escalations.entries()) {
  const queueName = `hang-${index}`;
  const queue = new BunQueue<HangData>(queueName, { namespace, driver });
  const worker = new BunQueueWorker<HangData>(queueName, hangFile, {
    namespace,
    driver,
    target: {
      kind: "child-process",
      closeTimeout: escalation.closeTimeout,
      killTimeout: escalation.killTimeout,
    },
    ...fast,
  });
  let pid: number | undefined;
  worker.on("progress", (_job, value) => {
    pid = (value as { pid?: number }).pid ?? pid;
    if (pid !== undefined) {
      pids.add(pid);
    }
  });
  void worker.run();

  const job = await queue.add("hang", escalation.data, {
    // Long enough to cover starting a process, because the deadline is measured
    // from the attempt, spawn included. The child reports its pid first thing
    // and the step needs that value: a value reported once the attempt is over
    // is dropped rather than merely late — an abort ends the attempt for its
    // writes too — so a deadline a loaded machine could beat to it would leave
    // this waiting for a progress event that is never coming. The job still
    // overruns whatever this is; the fixture blocks its thread for good.
    timeout: 2_000,
    attempts: 1,
  });
  await waitFor(
    "the hanging child to report its pid",
    () => pid !== undefined,
    LONG,
  );
  await waitFor(
    "the job to die at its timeout",
    async () => (await queue.getJob(job.id))?.state === "dead",
    LONG,
  );
  const died = await queue.getJob(job.id);
  const aliveWhenJobDied = isAlive(pid!);

  const budget = escalation.closeTimeout + escalation.killTimeout;
  await waitFor(
    `the child to be stopped (${escalation.label})`,
    () => !isAlive(pid!),
    {
      // Short of `closeTimeout + killTimeout` in the first scenario, so only
      // SIGTERM can have done it.
      timeout: index === 0 ? 15_000 : 25_000,
    },
  );
  const goneAfter = Date.now() - (died?.finishedOn ?? 0);
  show(`child stopped ${goneAfter}ms after the job died`, escalation.label);

  checkEqual(
    `${escalation.label}: the job died of JobTimeoutError`,
    died?.failedReason?.name,
    "JobTimeoutError",
  );
  check(
    `${escalation.label}: the job died at the deadline, while the child still ran`,
    aliveWhenJobDied,
  );
  if (index === 0) {
    check(
      `${escalation.label}: stopped after closeTimeout and well before killTimeout`,
      goneAfter >= escalation.closeTimeout - 1_000 && goneAfter < budget,
      { goneAfter, closeTimeout: escalation.closeTimeout, budget },
    );
  } else {
    check(
      `${escalation.label}: SIGTERM did not stop it; SIGKILL did`,
      goneAfter >= budget - 1_000,
      { goneAfter, budget },
    );
  }

  await worker.close();
  await queue.close();
}

/* ------------------------------------------------------------------ */
step("8. Configuration errors");

await checkRejects(
  'a function processor with target: "child-process"',
  () =>
    new BunQueueWorker("config", async () => null, {
      namespace,
      driver,
      target: "child-process",
    }),
  { name: "ConfigError", code: "CONFIG", message: /needs a processor file/ },
);
await checkRejects(
  'a function processor with target: "worker-thread"',
  () =>
    new BunQueueWorker("config", async () => null, {
      namespace,
      driver,
      target: "worker-thread",
    }),
  { name: "ConfigError", code: "CONFIG", message: /needs a processor file/ },
);
const inProcessFunction = new BunQueueWorker("config", async () => null, {
  namespace,
  driver,
  target: "in-process",
});
checkEqual(
  'a function processor with target: "in-process" is fine',
  inProcessFunction.isRunning,
  false,
);
await checkRejects(
  "a target that does not exist",
  () =>
    new BunQueueWorker("config", reportFile, {
      namespace,
      driver,
      // @ts-expect-error -- not a target, to the type or to the worker
      target: "thread",
    }),
  {
    name: "ConfigError",
    message:
      /target must be "in-process", "worker-thread" or "child-process", not "thread"/,
  },
);
// The spelling runners used before they took these words is the likeliest
// wrong value, so it gets its own hint.
await checkRejects(
  'the old runner spelling, "spawn", as a target',
  () =>
    new BunQueueWorker("config", reportFile, {
      namespace,
      driver,
      // @ts-expect-error -- the old spelling of "child-process"
      target: "spawn",
    }),
  {
    name: "ConfigError",
    message: /"spawn" is the old spelling of "child-process"/,
  },
);
// Each kind takes only its own tuning: `spawn` belongs to "child-process".
await checkRejects(
  'tuning for another kind: spawn on a "worker-thread" target',
  () =>
    new BunQueueWorker("config", reportFile, {
      namespace,
      driver,
      target: {
        kind: "worker-thread",
        // @ts-expect-error -- `spawn` is "child-process" tuning
        spawn: { cwd: processors },
      },
    }),
  {
    name: "ConfigError",
    message:
      /target \{ kind: "worker-thread" \} does not take spawn: it takes closeTimeout, worker/,
  },
);
await checkRejects(
  "a processor file that does not resolve",
  () =>
    new BunQueueWorker("config", "./no/such/processor.ts", {
      namespace,
      driver,
      target: "child-process",
    }),
  { name: "ConfigError", message: /Cannot resolve the processor file/ },
);

/* ------------------------------------------------------------------ */
step("9. jobs.worker(name, file, options) through BunJobs");

const jobs = new BunJobs({ namespace, driver, logger });

const viaUrl = jobs.worker<ReportData, Report>(
  "via-bunjobs-child-process",
  pathToFileURL(reportFile).href,
  { target: { kind: "child-process", closeTimeout: 2_000 }, ...fast },
);
const viaPath = jobs.worker<ReportData, Report>(
  "via-bunjobs-worker-thread",
  reportFile,
  { target: { kind: "worker-thread", closeTimeout: 2_000 }, ...fast },
);
void viaUrl.run();
void viaPath.run();

const spawnQueue = jobs.queue<ReportData, Report>("via-bunjobs-child-process");
const workerQueue = jobs.queue<ReportData, Report>("via-bunjobs-worker-thread");
const spawned = await spawnQueue.add(
  "report",
  { label: "bunjobs-child-process" },
  { removeOnComplete: false },
);
const threaded = await workerQueue.add(
  "report",
  { label: "bunjobs-worker-thread" },
  { removeOnComplete: false },
);
await waitFor(
  "both BunJobs workers to complete their job",
  async () =>
    (await spawnQueue.getJob(spawned.id))?.state === "completed" &&
    (await workerQueue.getJob(threaded.id))?.state === "completed",
  LONG,
);
const spawnReport = (await spawnQueue.getJob(spawned.id))
  ?.returnValue as Report;
const workerReport = (await workerQueue.getJob(threaded.id))
  ?.returnValue as Report;
// `mode` is `BUN_JOBS_MODE`, the target's own word.
check(
  "a file:// string ran in a child process",
  spawnReport.pid !== process.pid && spawnReport.mode === "child-process",
  spawnReport,
);
checkEqual(
  "a path ran in a Worker",
  [workerReport.mode, workerReport.isMainThread],
  ["worker-thread", false],
);
checkEqual(
  "the job channel works through BunJobs too",
  await spawnQueue.getJobLogs(spawned.id),
  { logs: ["hello from bunjobs-child-process", "second line"], count: 2 },
);

await jobs.close();

/* ------------------------------------------------------------------ */
step("Cleanup");

await driver.purge(namespace);
await driver.close();

summary();
