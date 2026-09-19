/**
 * Option tour: `isolation` and `isolationOptions` — a worker running a
 * processor *file* in-process, in a `Worker`, or in a child process, each
 * behaviour asserted.
 *
 * ```bash
 * bun 10-options/worker-isolation.ts
 * EXAMPLE_DRIVER=sqlite bun 10-options/worker-isolation.ts
 * ```
 *
 * Worth knowing:
 *
 * - The file default-exports the same `(job, ctx)` function a function
 *   processor is; `defineProcessor` types it. It may be named by an absolute
 *   path, a path relative to `isolationOptions.spawn.cwd` (else the working
 *   directory), a `URL` or a `file://` string.
 * - The worker keeps the driver. In a child, `job.updateProgress`, `job.log`,
 *   `job.touch`/`extendLock`, `ctx.log` and `ctx.heartbeat` travel to the
 *   worker and are answered from there; every other operation that changes the
 *   stored job rejects with "not available in an isolated job" — `schedule`,
 *   `update`, `disable` and `enable` included.
 * - `job.fail(reason)` works in every mode: the child keeps the reason and
 *   reports it as the attempt's error when the processor settles, so the job
 *   goes to `dead` exactly as it would in-process.
 * - The worker owns the attempt's `timeout`: the job dies at the deadline.
 *   Under `"spawn"` the child is then asked to close, sent `SIGTERM`
 *   `closeTimeout` later, and `SIGKILL` `killTimeout` after that — the only
 *   mode where a processor that ignores its signal is stopped for certain.
 */
import type {
  IsolationMode,
  IsolationOptions,
  LoggerLike,
} from "@kingsleyweb/bun-jobs";
import type { FailData } from "./processors/isolation-fail";
import type { HangData } from "./processors/isolation-hang";
import type { JobFailData } from "./processors/isolation-job-fail";
import type { Report, ReportData } from "./processors/isolation-report";
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

title("Worker isolation");

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
const namespace = exampleNamespace("worker-isolation");
const processors = join(import.meta.dir, "processors");
const reportFile = join(processors, "isolation-report.ts");
/** Short waits, so the tour spends its time on the work. */
const fast = { pollInterval: 25, maxBlock: 50 };
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
step("1. Each mode runs the file, and the job channel reaches the worker");

/** How one mode is set up. */
interface ModeCase {
  /** Where each attempt runs. */
  mode: IsolationMode;
  /** The processor file, in one of the forms a worker accepts. */
  processor: string | URL;
  /** The worker's `isolationOptions`. */
  options: IsolationOptions;
}

const cases: ModeCase[] = [
  // An absolute path. `isolationOptions` do not apply in-process.
  { mode: "in-process", processor: reportFile, options: {} },
  // A URL.
  {
    mode: "worker",
    processor: new URL("./processors/isolation-report.ts", import.meta.url),
    options: {
      closeTimeout: 2_000,
      worker: {
        smol: true,
        name: "tour-isolated-worker",
        env: { TOUR_ISOLATION_ENV: "from worker.env" },
        argv: ["--from-worker-argv"],
      },
    },
  },
  // A relative path, resolved against `spawn.cwd`.
  {
    mode: "spawn",
    processor: "./isolation-report.ts",
    options: {
      closeTimeout: 2_000,
      killTimeout: 1_000,
      spawn: {
        cwd: processors,
        env: { TOUR_ISOLATION_ENV: "from spawn.env" },
        args: ["--from-spawn-args"],
      },
    },
  },
];

for (const { mode, processor, options } of cases) {
  const queueName = `report-${mode}`;
  const queue = new BunQueue<ReportData, Report>(queueName, {
    namespace,
    driver,
  });
  const worker = new BunQueueWorker<ReportData, Report>(queueName, processor, {
    namespace,
    driver,
    logger,
    isolation: mode,
    isolationOptions: options,
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
  await waitFor(
    `the ${mode} report to complete`,
    async () => (await queue.getJob(job.id))?.state === "completed",
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
  if (mode === "spawn") {
    check(`${mode}: another process`, report.pid !== process.pid, report.pid);
  } else {
    checkEqual(`${mode}: this process`, report.pid, process.pid);
  }
  checkEqual(`${mode}: isMainThread`, report.isMainThread, mode !== "worker");
  checkEqual(
    `${mode}: BUN_JOBS_CHILD / BUN_JOBS_MODE`,
    [report.child, report.mode],
    mode === "in-process" ? [null, null] : ["1", mode],
  );

  if (mode === "worker") {
    checkEqual(`${mode}: worker.env`, report.env, "from worker.env");
    check(
      `${mode}: worker.argv becomes process.argv`,
      report.argv.includes("--from-worker-argv"),
      report.argv,
    );
  } else if (mode === "spawn") {
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
step("2. ctx.heartbeat() from a child keeps a long job's lock");

// The worker's own renewal is effectively off (a minute apart, against a
// 3-second lock), so only the child's heartbeats can keep the job. A paused
// worker sweeps for stalled jobs every 100ms, and would take it back.
const heartbeatQueue = new BunQueue<ReportData, Report>("heartbeats", {
  namespace,
  driver,
});
const sweeper = new BunQueueWorker("heartbeats", async () => null, {
  namespace,
  driver,
  stalledInterval: 100,
  ...fast,
});
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
    isolation: "spawn",
    isolationOptions: { closeTimeout: 2_000 },
    lockDuration: 3_000,
    heartbeatInterval: 60_000,
    ...fast,
  },
);
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
check("the sweeper recovered nothing", !swept.includes(longJob.id), swept);

await beating.close();
await sweeper.close();
await heartbeatQueue.close();

/* ------------------------------------------------------------------ */
step("3. Operations that change the stored job are unavailable in a child");

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

for (const mode of ["spawn", "worker", "in-process"] as const) {
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
      isolation: mode,
      isolationOptions: { closeTimeout: 2_000 },
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
step("4. Errors cross the boundary and still decide retries; so does fail()");

const failFile = join(processors, "isolation-fail.ts");

for (const mode of ["spawn", "worker"] as const) {
  const queueName = `fail-${mode}`;
  const queue = new BunQueue<FailData>(queueName, { namespace, driver });
  const worker = new BunQueueWorker<FailData>(queueName, failFile, {
    namespace,
    driver,
    isolation: mode,
    isolationOptions: { closeTimeout: 2_000 },
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

for (const mode of ["spawn", "worker"] as const) {
  const queueName = `job-fail-${mode}`;
  const queue = new BunQueue<JobFailData>(queueName, { namespace, driver });
  const worker = new BunQueueWorker<JobFailData>(queueName, jobFailFile, {
    namespace,
    driver,
    isolation: mode,
    isolationOptions: { closeTimeout: 2_000 },
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
step("5. timeout stops a spawned processor that ignores its signal");

const hangFile = join(processors, "isolation-hang.ts");

/** One way a hanging child is stopped. */
interface Escalation {
  /** What the scenario shows. */
  label: string;
  /** What the job carries. */
  data: HangData;
  /** `isolationOptions.closeTimeout`. */
  closeTimeout: number;
  /** `isolationOptions.killTimeout`. */
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
    isolation: "spawn",
    isolationOptions: {
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
    timeout: 300,
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
step("6. Configuration errors");

await checkRejects(
  'a function processor with isolation: "spawn"',
  () =>
    new BunQueueWorker("config", async () => null, {
      namespace,
      driver,
      isolation: "spawn",
    }),
  { name: "ConfigError", code: "CONFIG", message: /needs a processor file/ },
);
await checkRejects(
  'a function processor with isolation: "worker"',
  () =>
    new BunQueueWorker("config", async () => null, {
      namespace,
      driver,
      isolation: "worker",
    }),
  { name: "ConfigError", code: "CONFIG", message: /needs a processor file/ },
);
const inProcessFunction = new BunQueueWorker("config", async () => null, {
  namespace,
  driver,
  isolation: "in-process",
});
checkEqual(
  'a function processor with isolation: "in-process" is fine',
  inProcessFunction.isRunning,
  false,
);
await checkRejects(
  "an isolation mode that does not exist",
  () =>
    new BunQueueWorker("config", reportFile, {
      namespace,
      driver,
      isolation: "thread" as IsolationMode,
    }),
  { name: "ConfigError", message: /isolation must be/ },
);
await checkRejects(
  "a processor file that does not resolve",
  () =>
    new BunQueueWorker("config", "./no/such/processor.ts", {
      namespace,
      driver,
      isolation: "spawn",
    }),
  { name: "ConfigError", message: /Cannot resolve the processor file/ },
);

/* ------------------------------------------------------------------ */
step("7. jobs.worker(name, file, options) through BunJobs");

const jobs = new BunJobs({ namespace, driver, logger });

const viaUrl = jobs.worker<ReportData, Report>(
  "via-bunjobs-spawn",
  pathToFileURL(reportFile).href,
  { isolation: "spawn", isolationOptions: { closeTimeout: 2_000 }, ...fast },
);
const viaPath = jobs.worker<ReportData, Report>(
  "via-bunjobs-worker",
  reportFile,
  { isolation: "worker", isolationOptions: { closeTimeout: 2_000 }, ...fast },
);
void viaUrl.run();
void viaPath.run();

const spawnQueue = jobs.queue<ReportData, Report>("via-bunjobs-spawn");
const workerQueue = jobs.queue<ReportData, Report>("via-bunjobs-worker");
const spawned = await spawnQueue.add(
  "report",
  { label: "bunjobs-spawn" },
  { removeOnComplete: false },
);
const threaded = await workerQueue.add(
  "report",
  { label: "bunjobs-worker" },
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
check(
  "a file:// string ran in a child process",
  spawnReport.pid !== process.pid && spawnReport.mode === "spawn",
  spawnReport,
);
checkEqual(
  "a path ran in a Worker",
  [workerReport.mode, workerReport.isMainThread],
  ["worker", false],
);
checkEqual(
  "the job channel works through BunJobs too",
  await spawnQueue.getJobLogs(spawned.id),
  { logs: ["hello from bunjobs-spawn", "second line"], count: 2 },
);

await jobs.close();

/* ------------------------------------------------------------------ */
step("Cleanup");

await driver.purge(namespace);
await driver.close();

summary();
