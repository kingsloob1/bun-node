/**
 * Option tour: every error class the package exports — each raised for real
 * through the public API, and checked for its class, `name`, `code` and the
 * fields it carries.
 *
 * ```bash
 * bun 10-options/errors.ts
 * EXAMPLE_DRIVER=postgres EXAMPLE_POSTGRES_URL=postgres://… bun 10-options/errors.ts
 * ```
 *
 * The points worth knowing:
 *
 * - **Branch on `code`, not on the class.** An error that crossed a process
 *   boundary — a stored `failedReason`, a spawned run's failure — is rebuilt
 *   as a plain `Error`. `instanceof` is gone; `name`, `message`, `code` and
 *   the error's own fields (`ms`, `reason`, `exitCode`, `context`) survive.
 * - **Not every failure throws.** A runner whose trigger queue is full answers
 *   `{ outcome: "skipped", reason: "queue-full" }`, a closed worker's `run()`
 *   simply resolves. Four classes — `LockUnavailableError`, `LockLostError`,
 *   `WorkerClosedError`, `QueueFullError` — are exported for custom drivers
 *   and handlers but raised by no public path today; the last section
 *   constructs them to show their shape.
 * - **`UnrecoverableJobError` is recognised by name**, so it still stops
 *   retries when thrown in an isolated (spawned) processor.
 * - **`NotSupportedError` is a `ConfigError`.** Every feature that needs a
 *   driver method the driver lacks — `cleanWindows()`, `getThroughput()`,
 *   `job.log()` and the rest — raises it, with `context.driver`,
 *   `context.method` and `context.needs`. It keeps the `CONFIG` code, so a
 *   branch on `CONFIG` catches both.
 * - **JSON is the boundary.** A cycle or a `BigInt` in job data is a
 *   `SerializationError` at `add()`; a function is silently dropped, because
 *   that is what JSON does with one.
 */
import type { JobsDriver, RunRecord } from "@kingsleyweb/bun-jobs";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  BunRunner,
  BunRunnerManager,
  ChildExitError,
  ConfigError,
  createDriver,
  DriverError,
  InvalidHandlerError,
  JobsError,
  JobTimeoutError,
  LockLostError,
  LockUnavailableError,
  MAX_JOB_ID_LENGTH,
  NotSupportedError,
  QueueClosedError,
  QueueFullError,
  RESERVED_STATE_PREFIX,
  RunKilledError,
  RunnerNotFoundError,
  RunnerStoppedError,
  SerializationError,
  UnrecoverableJobError,
  WorkerClosedError,
} from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Option tour: errors");

const namespace = exampleNamespace("tour-errors");
// One shared instance for everything here, closed at the end. The runners in
// `child-process` mode use it too: their children never touch the backend, so there
// is nothing a second process needs to share.
const driver = createDriver(exampleDriver());

/** A helper file next to this tour, as a URL a runner or worker accepts. */
function helper(name: string): URL {
  return new URL(`./helpers/${name}`, import.meta.url);
}

/** The code, context and own fields an error may carry, for reading loosely. */
interface ErrorFields {
  /** The package's stable failure identifier. */
  code?: string;
  /** Extra detail the error was constructed with. */
  context?: Record<string, unknown>;
}

/** Reads an error's `code`/`context` without asserting its class. */
function fields(error: unknown): ErrorFields & Record<string, unknown> {
  // An absent error reads as having no fields, so a failed check reports
  // `undefined` rather than crashing the tour.
  return (error ?? {}) as ErrorFields & Record<string, unknown>;
}

/** Checks what every error from this package has in common. */
function checkJobsError(
  label: string,
  error: Error | undefined,
  name: string,
  code: string,
): void {
  check(
    `${label}: instanceof JobsError and Error`,
    error instanceof JobsError && error instanceof Error,
    error,
  );
  checkEqual(`${label}: name`, error?.name, name);
  checkEqual(`${label}: code`, fields(error).code, code);
}

/* ------------------------------------------------------------------ */
step("JobsError: the base class");

const base = new JobsError(
  "something broke",
  "SOMETHING",
  { part: "a" },
  {
    cause: new Error("underneath"),
  },
);
checkJobsError("JobsError", base, "JobsError", "SOMETHING");
checkEqual("JobsError: context", base.context, { part: "a" });
checkEqual("JobsError: cause", (base.cause as Error).message, "underneath");
// `name` comes from `new.target`, so every subclass names itself.
checkEqual(
  "a subclass's name is its own",
  new ConfigError("x").name,
  "ConfigError",
);

/* ------------------------------------------------------------------ */
step("QueueClosedError: using a queue after close()");

const closedQueue = new BunQueue("closed-queue", { namespace, driver });
await closedQueue.close();

const closedError = await checkRejects(
  "add() after close()",
  async () => {
    await closedQueue.add("x", {});
  },
  {
    name: "QueueClosedError",
    code: "QUEUE_CLOSED",
    message: /Queue closed-queue is closed/,
  },
);
checkJobsError(
  "QueueClosedError",
  closedError,
  "QueueClosedError",
  "QUEUE_CLOSED",
);
check("QueueClosedError: instanceof", closedError instanceof QueueClosedError);
checkEqual("QueueClosedError: context.queue", fields(closedError).context, {
  queue: "closed-queue",
});

/* ------------------------------------------------------------------ */
step("SerializationError: job data that is not JSON");

const queue = new BunQueue<unknown, unknown>("errors", { namespace, driver });

/** An object that contains itself. */
interface Circular {
  /** Points back at the object. */
  self?: Circular;
}
const circular: Circular = {};
circular.self = circular;

const cycleError = await checkRejects(
  "a circular object",
  async () => {
    await queue.add("x", circular);
  },
  {
    name: "SerializationError",
    code: "SERIALIZATION",
    message: /job data is not JSON-serialisable/,
  },
);
checkJobsError(
  "SerializationError",
  cycleError,
  "SerializationError",
  "SERIALIZATION",
);
check(
  "SerializationError: instanceof",
  cycleError instanceof SerializationError,
);
checkEqual("SerializationError: context.what", fields(cycleError).context, {
  what: "job data",
});
check(
  "SerializationError: cause is the TypeError",
  cycleError?.cause instanceof TypeError,
  cycleError?.cause,
);

await checkRejects(
  "a BigInt",
  async () => {
    await queue.add("x", { amount: 10n });
  },
  { name: "SerializationError", message: /job data/ },
);

// Not an error: JSON drops a function, and the job keeps what survives.
const lossy = await queue.add("x", { keep: 1, callback: () => "gone" });
checkEqual("a function is dropped, not rejected", lossy.data, { keep: 1 });
await lossy.remove();

/* ------------------------------------------------------------------ */
step("ConfigError: options that are missing, malformed or contradictory");

/** Asserts a ConfigError, and that it is one of ours. */
async function checkConfig(
  label: string,
  run: () => unknown,
  message: RegExp,
): Promise<void> {
  const error = await checkRejects(label, run, {
    name: "ConfigError",
    code: "CONFIG",
    message,
  });
  check(
    `${label}: instanceof ConfigError and JobsError`,
    error instanceof ConfigError && error instanceof JobsError,
  );
}

await checkConfig(
  "a namespace with a separator in it",
  () => {
    return new BunQueue("q", { namespace: "billing:eu", driver });
  },
  /namespace may only contain letters, digits/,
);
await checkConfig(
  "an empty queue name",
  () => {
    return new BunQueue("", { namespace, driver });
  },
  /queue name is required/,
);
await checkConfig(
  "a cron expression with minute 61",
  () => {
    return new BunRunner({
      id: "bad-cron",
      namespace,
      driver,
      file: helper("errors-wait-for-stop.ts"),
      schedule: "61 * * * *",
    });
  },
  /Invalid cron expression "61 \* \* \* \*"/,
);
await checkConfig(
  "a runner file that does not exist",
  () => {
    return new BunRunner({
      id: "no-file",
      namespace,
      driver,
      file: "./does-not-exist-anywhere.ts",
    });
  },
  /Cannot resolve the runner file/,
);
await checkConfig(
  "attempts: 0",
  async () => {
    await queue.add("x", {}, { attempts: 0 });
  },
  /attempts must be a whole number of at least 1/,
);
await checkConfig(
  "a negative delay",
  async () => {
    await queue.add("x", {}, { delay: -5 });
  },
  /delay must be a non-negative number of ms/,
);
await checkConfig(
  "a date phrase that means nothing",
  async () => {
    await queue.add(
      "x",
      {},
      { repeat: { every: "1 hour", startAt: "blorf zzz" } },
    );
  },
  /repeat\.startAt could not be understood as a date/,
);
await checkConfig(
  "a rate limit of zero jobs",
  async () => {
    await queue.setLimits({ rate: { max: 0, duration: 1_000 } });
  },
  /limits\.rate\.max must be a whole number of at least 1/,
);
await checkConfig(
  "a rate window that is not a duration",
  async () => {
    await queue.setLimits({ rate: { max: 1, duration: "soonish" } });
  },
  /limits\.rate\.duration must be a positive number/,
);
await checkConfig(
  "debounced and throttled at once",
  async () => {
    await queue.add(
      "x",
      {},
      { debounce: { id: "a", ttl: 100 }, throttle: { id: "a", ttl: 100 } },
    );
  },
  /cannot be both debounced and throttled/,
);
await checkConfig(
  "a child-process target without a processor file",
  () => {
    return new BunQueueWorker("errors", () => null, {
      namespace,
      driver,
      target: "child-process",
    });
  },
  /needs a processor file/,
);
await checkConfig(
  "an unknown driver type",
  () => {
    return createDriver({ type: "carrier-pigeon" } as never);
  },
  /Unrecognised driver config/,
);
await checkConfig(
  "BunJobs.start() with nothing defined",
  async () => {
    const empty = new BunJobs({ namespace, driver });
    try {
      await empty.start();
    } finally {
      await empty.close();
    }
  },
  /start\(\) has nothing to run/,
);

// Ids a caller chooses are checked where they are given — see
// `ids-and-keys.ts` for every rule. One of each, to show the shape.
const idError = await checkRejects(
  "a jobId over the cap",
  () => queue.add("x", {}, { jobId: "a".repeat(MAX_JOB_ID_LENGTH + 1) }),
  { name: "ConfigError", code: "CONFIG", message: /the most is 191/ },
);
checkEqual(
  "…context: the length and the max",
  [fields(idError).context?.length, fields(idError).context?.max],
  [MAX_JOB_ID_LENGTH + 1, MAX_JOB_ID_LENGTH],
);
await checkConfig(
  "a control character in a jobId",
  () => queue.add("x", {}, { jobId: `a${String.fromCharCode(7)}b` }),
  /may not contain control characters, and has U\+0007 at index 1/,
);
await checkConfig(
  "a debounce id beginning with a dot",
  () => queue.add("x", {}, { debounce: { id: ".x", ttl: 1_000 } }),
  /^debounce\.id may not begin with "\."/,
);
await checkConfig(
  "a queue-state name under the reserved prefix",
  () =>
    driver.setQueueState!(queue.ref, `${RESERVED_STATE_PREFIX}mine`, 1, null),
  /reserved by bun-jobs/,
);
{
  const registry = new BunJobs({ namespace, driver });
  registry.define("mail", async () => null);
  await checkConfig(
    "a series setter before repeatEvery()",
    () => registry.create("mail").limit(3),
    /^limit\(\) sets one option of a repeating series, so it needs repeatEvery\(\) before it$/,
  );
  await checkConfig(
    "a draft date phrase that cannot be read — at save(), naming the setter",
    () => registry.create("mail").schedule("the twelfth of Octember").save(),
    /^schedule\(\) could not read "the twelfth of Octember" as a date$/,
  );
  await registry.close();
}

/* ------------------------------------------------------------------ */
step("NotSupportedError: a driver without a method a feature needs");

// A driver may leave some methods out — a custom driver, or one written
// before they existed. The feature that needs one then throws
// NotSupportedError: a ConfigError subclass, so it keeps the CONFIG code and a
// branch on `code === "CONFIG"` catches both, with `context.driver`,
// `context.method` and `context.needs` saying which is missing and why.

/**
 * The same driver with some optional methods hidden. Methods are bound to the
 * real driver so its private state still works.
 */
function without(real: JobsDriver, methods: (keyof JobsDriver)[]): JobsDriver {
  return new Proxy(real, {
    get(target, property) {
      if (methods.includes(property as keyof JobsDriver)) {
        return undefined;
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const bare = without(driver, [
  "getThroughput",
  "listQueueState",
  "getQueueState",
  "setQueueState",
  "getJobLogs",
  "addJobLog",
  "updateJob",
  "buryJob",
]);
const bareQueue = new BunQueue("bare", { namespace, driver: bare });
const plainJob = await bareQueue.add("x", {});
// A series needs no queue state to exist, only to be disabled or enabled.
const bareOccurrence = await bareQueue.add(
  "tick",
  {},
  { repeat: { every: 60_000, key: "bare-series" } },
);
checkEqual(
  "without queue state, listRepeatables() reports every series enabled",
  (await bareQueue.listRepeatables()).map((series) => series.disabled),
  [false],
);

for (const [label, run, method, needs] of [
  [
    "queue.getThroughput()",
    () => bareQueue.getThroughput(),
    "getThroughput",
    "getThroughput()",
  ],
  [
    "queue.cleanWindows()",
    () => bareQueue.cleanWindows(),
    "listQueueState",
    "cleanWindows()",
  ],
  [
    "queue.getJobLogs()",
    () => bareQueue.getJobLogs(plainJob.id),
    "getJobLogs",
    "getJobLogs()",
  ],
  [
    "queue.update()",
    () => bareQueue.update(plainJob.id, { priority: 1 }),
    "updateJob",
    "update()",
  ],
  ["job.log()", () => plainJob.log("hello"), "addJobLog", "log()"],
  ["job.getLogs()", () => plainJob.getLogs(), "getJobLogs", "getLogs()"],
  [
    "a debounced add",
    () => bareQueue.add("x", {}, { debounce: { id: "d", ttl: 1_000 } }),
    "getQueueState",
    "add({ debounce })",
  ],
  [
    "a throttled add",
    () => bareQueue.add("x", {}, { throttle: { id: "t", ttl: 1_000 } }),
    "getQueueState",
    "add({ throttle })",
  ],
  [
    "job.updateData()",
    () => plainJob.updateData({}),
    "updateJob",
    "updateData()",
  ],
  [
    "job.setPriority()",
    () => plainJob.setPriority(3),
    "updateJob",
    "setPriority()",
  ],
  [
    "job.reschedule()",
    () => plainJob.reschedule(Date.now() + 60_000),
    "updateJob",
    "reschedule()",
  ],
  [
    "job.schedule()",
    () => plainJob.schedule("in 1 hour"),
    "updateJob",
    "schedule()",
  ],
  [
    "job.update()",
    () => plainJob.update({ priority: 1 }),
    "updateJob",
    "update()",
  ],
  ["job.fail()", () => plainJob.fail("no buryJob"), "buryJob", "fail()"],
  [
    "job.disable()",
    () => bareOccurrence.disable(),
    "setQueueState",
    "disable()",
  ],
  ["job.enable()", () => bareOccurrence.enable(), "setQueueState", "enable()"],
  // The queue's methods name themselves, not the job's step: `needs` is
  // always the method the caller called.
  [
    "queue.disableRepeatable()",
    () => bareQueue.disableRepeatable("bare-series"),
    "setQueueState",
    "disableRepeatable()",
  ],
  [
    "queue.enableRepeatable()",
    () => bareQueue.enableRepeatable("bare-series"),
    "setQueueState",
    "enableRepeatable()",
  ],
  // They check for queue state before looking the key up, so a key no series
  // has is refused the same way: it does not answer `false`, as it would on a
  // driver with queue state.
  [
    "queue.disableRepeatable() of an unknown key",
    () => bareQueue.disableRepeatable("no-such-series"),
    "setQueueState",
    "disableRepeatable()",
  ],
  [
    "queue.enableRepeatable() of an unknown key",
    () => bareQueue.enableRepeatable("no-such-series"),
    "setQueueState",
    "enableRepeatable()",
  ],
] as const) {
  const error = await checkRejects(label, run, {
    name: "NotSupportedError",
    code: "CONFIG",
    message: new RegExp(`does not support ${method}\\(\\)`),
  });
  check(
    `${label}: instanceof NotSupportedError, ConfigError and JobsError`,
    error instanceof NotSupportedError &&
      error instanceof ConfigError &&
      error instanceof JobsError,
  );
  checkEqual(`${label}: context`, fields(error).context, {
    driver: driver.name,
    method,
    needs,
  });
}
await bareQueue.close();

/* ------------------------------------------------------------------ */
step("DriverError: a backend that cannot be reached");

// Port 1 is never a Postgres server, so the connection is refused at once.
// This runs whatever EXAMPLE_DRIVER says: it needs no server, only its absence.
const unreachable = createDriver({
  type: "sql",
  url: "postgres://nobody:nothing@127.0.0.1:1/nowhere",
});
const driverError = await checkRejects(
  "connect() to a closed port",
  async () => {
    await unreachable.connect();
  },
  {
    name: "DriverError",
    code: "DRIVER_ERROR",
    message: /sql driver failed during migrate/,
  },
);
await unreachable.close().catch(() => {});
checkJobsError("DriverError", driverError, "DriverError", "DRIVER_ERROR");
check("DriverError: instanceof", driverError instanceof DriverError);
checkEqual(
  "DriverError: driver",
  (driverError as DriverError | undefined)?.driver,
  "sql",
);
checkEqual(
  "DriverError: operation",
  (driverError as DriverError | undefined)?.operation,
  "migrate",
);
checkEqual("DriverError: context.adapter", fields(driverError).context, {
  adapter: "postgres",
});
check(
  "DriverError: cause is the client's own error",
  driverError?.cause instanceof Error,
  driverError?.cause,
);
show("cause", (driverError?.cause as Error | undefined)?.message);

/* ------------------------------------------------------------------ */
step("RunnerStoppedError: triggering a stopped runner");

const stoppedRunner = new BunRunner({
  id: "stopped",
  namespace,
  driver,
  file: helper("errors-wait-for-stop.ts"),
  executionMode: "in-process",
});
await stoppedRunner.start();
await stoppedRunner.stop();

const stoppedError = await checkRejects(
  "a manual trigger()",
  async () => {
    await stoppedRunner.trigger();
  },
  {
    name: "RunnerStoppedError",
    code: "RUNNER_STOPPED",
    message: /Runner stopped is stopped/,
  },
);
checkJobsError(
  "RunnerStoppedError",
  stoppedError,
  "RunnerStoppedError",
  "RUNNER_STOPPED",
);
check(
  "RunnerStoppedError: instanceof",
  stoppedError instanceof RunnerStoppedError,
);
checkEqual("RunnerStoppedError: context.id", fields(stoppedError).context, {
  id: "stopped",
});
// Only a manual trigger throws; anything else is told it was skipped.
checkEqual(
  "a scheduled trigger is skipped instead",
  await stoppedRunner.trigger({ source: "schedule" }),
  { outcome: "skipped", reason: "stopped" },
);

/* ------------------------------------------------------------------ */
step("RunnerNotFoundError: controlling a runner nobody registered");

const notFound = await checkRejects(
  "BunRunnerManager.controller() with an unknown id",
  () => new BunRunnerManager({ namespace, driver }).controller("nobody"),
  {
    name: "RunnerNotFoundError",
    code: "RUNNER_NOT_FOUND",
    message: /No runner "nobody" is known in namespace/,
  },
);
checkJobsError(
  "RunnerNotFoundError",
  notFound,
  "RunnerNotFoundError",
  "RUNNER_NOT_FOUND",
);
check(
  "RunnerNotFoundError: instanceof",
  notFound instanceof RunnerNotFoundError,
);
checkEqual("RunnerNotFoundError: context", fields(notFound).context, {
  id: "nobody",
  namespace,
});

/* ------------------------------------------------------------------ */
step("Runs that fail: a recorder for runner outcomes");

/** What one run ended with, as the runner's events reported it. */
interface RunEnding {
  /** The error the `failed` event carried. */
  error: Error;
  /** The reason the `killed` event carried, when there was one. */
  killedWith?: string;
  /** The run record at the time. */
  run: RunRecord;
}

/** Records every run's failure by run id. */
function recordFailures(runner: BunRunner<any, any>): Map<string, RunEnding> {
  const endings = new Map<string, RunEnding>();
  const killed = new Map<string, string>();
  runner.on("killed", (run, reason) => {
    killed.set(run.runId, reason);
  });
  runner.on("failed", (run, error) => {
    endings.set(run.runId, { error, run, killedWith: killed.get(run.runId) });
  });
  return endings;
}

/** Triggers a run, insisting that it started, and answers with its id. */
async function startRun(runner: BunRunner<any, any>): Promise<string> {
  const outcome = await runner.trigger();
  if (outcome.outcome !== "started") {
    throw new Error(
      `expected the run to start, got ${JSON.stringify(outcome)}`,
    );
  }
  return outcome.runId;
}

/* ------------------------------------------------------------------ */
step("InvalidHandlerError: a runner file with no usable default export");

for (const mode of ["in-process", "worker-thread", "child-process"] as const) {
  for (const [file, detail] of [
    ["errors-no-default.ts", /there is no default export/],
    ["errors-bad-default.ts", /the default export is number/],
  ] as const) {
    const runner = new BunRunner({
      id: `invalid-${mode}-${file.replace(".ts", "")}`,
      namespace,
      driver,
      file: helper(file),
      executionMode: mode,
      runMode: "parallel",
    });
    const endings = recordFailures(runner);
    await runner.start();
    const runId = await startRun(runner);
    await waitFor(`${file} in ${mode} to fail`, () => endings.has(runId));

    const error = endings.get(runId)?.error;
    const label = `InvalidHandlerError (${mode}, ${file})`;
    checkEqual(`${label}: name`, error?.name, "InvalidHandlerError");
    checkEqual(`${label}: code`, fields(error).code, "INVALID_HANDLER");
    check(
      `${label}: message names the problem`,
      detail.test(error?.message ?? ""),
      error?.message,
    );
    check(
      `${label}: message names the file`,
      (error?.message ?? "").includes(file),
      error?.message,
    );

    const [stored] = await runner.history(1);
    checkEqual(
      `${label}: history records it`,
      [stored?.status, stored?.error?.name],
      ["failed", "InvalidHandlerError"],
    );
    await runner.stop();
  }
}

// Constructed directly, a real instance.
check(
  "InvalidHandlerError: instanceof",
  new InvalidHandlerError("x.ts", "why") instanceof JobsError,
);

/* ------------------------------------------------------------------ */
step("ChildExitError: a spawned handler that exits without reporting");

const exiting = new BunRunner({
  id: "exits",
  namespace,
  driver,
  file: helper("errors-exit.ts"),
  executionMode: "child-process",
});
const exitEndings = recordFailures(exiting);
await exiting.start();
const exitRun = await startRun(exiting);
await waitFor("the exiting child to be reported", () => {
  return exitEndings.has(exitRun);
});

const exitError = exitEndings.get(exitRun)?.error;
checkEqual("ChildExitError: name", exitError?.name, "ChildExitError");
checkEqual("ChildExitError: code", fields(exitError).code, "CHILD_EXIT");
check(
  "ChildExitError: message has the exit code",
  /Child exited \(code 3, signal null\) before reporting a result/.test(
    exitError?.message ?? "",
  ),
  exitError?.message,
);
checkEqual(
  "ChildExitError: exitCode survives the boundary",
  fields(exitError).exitCode,
  3,
);
checkEqual("ChildExitError: signalCode", fields(exitError).signalCode, null);
checkEqual(
  "the run record has the exit code",
  exitEndings.get(exitRun)?.run.exitCode,
  3,
);
await exiting.stop();

const directExit = new ChildExitError(null, "SIGKILL");
check("ChildExitError: instanceof", directExit instanceof JobsError);
checkEqual(
  "ChildExitError: fields",
  [directExit.exitCode, directExit.signalCode, directExit.context],
  [null, "SIGKILL", { exitCode: null, signalCode: "SIGKILL" }],
);

/* ------------------------------------------------------------------ */
step("RunKilledError: kill() with a reason, in every execution mode");

for (const mode of ["child-process", "worker-thread", "in-process"] as const) {
  const runner = new BunRunner({
    id: `killed-${mode}`,
    namespace,
    driver,
    file: helper("errors-wait-for-stop.ts"),
    executionMode: mode,
    closeTimeout: 2_000,
    killTimeout: 1_000,
  });
  const endings = recordFailures(runner);
  const started = new Set<string>();
  const finished = new Map<string, RunRecord>();
  runner.on("progress", (run) => {
    started.add(run.runId);
  });
  runner.on("finished", (run) => {
    finished.set(run.runId, run);
  });
  await runner.start();

  const runId = await startRun(runner);
  // Kill only once the handler is actually running and listening.
  await waitFor(`the ${mode} run to start`, () => started.has(runId));
  await runner.kill(runId, { reason: "operator cancelled" });
  await waitFor(
    `the ${mode} kill to settle`,
    () => endings.has(runId) || finished.has(runId),
  );

  // The handler checks its signal and returns cleanly, yet the run is a kill in
  // every mode: "a run asked to stop may well have unwound cleanly".
  check(
    `RunKilledError (${mode}): not reported as finished`,
    !finished.has(runId),
    finished.get(runId),
  );
  const ending = endings.get(runId);
  const label = `RunKilledError (${mode})`;
  checkEqual(`${label}: name`, ending?.error.name, "RunKilledError");
  checkEqual(`${label}: code`, fields(ending?.error).code, "RUN_KILLED");
  checkEqual(
    `${label}: message`,
    ending?.error.message,
    "Run was killed: operator cancelled",
  );
  checkEqual(
    `${label}: reason survives`,
    fields(ending?.error).reason,
    "operator cancelled",
  );
  checkEqual(
    `${label}: the killed event had the reason`,
    ending?.killedWith,
    "operator cancelled",
  );
  checkEqual(`${label}: run status`, ending?.run.status, "killed");
  await runner.stop();
}

check(
  "RunKilledError: instanceof",
  new RunKilledError("why") instanceof JobsError,
);
checkEqual(
  "RunKilledError: reason field",
  new RunKilledError("why").reason,
  "why",
);

/* ------------------------------------------------------------------ */
step("JobTimeoutError: a run and a job attempt that outlive their timeout");

const slowRunner = new BunRunner({
  id: "times-out",
  namespace,
  driver,
  file: helper("errors-wait-for-stop.ts"),
  executionMode: "in-process",
  timeout: 150,
});
const timeoutEndings = recordFailures(slowRunner);
await slowRunner.start();
const slowRun = await startRun(slowRunner);
await waitFor("the run to time out", () => timeoutEndings.has(slowRun));

const runTimeout = timeoutEndings.get(slowRun);
checkEqual("run timeout: name", runTimeout?.error.name, "JobTimeoutError");
checkEqual("run timeout: code", fields(runTimeout?.error).code, "JOB_TIMEOUT");
checkEqual(
  "run timeout: message",
  runTimeout?.error.message,
  "Timed out after 150ms",
);
checkEqual("run timeout: ms", fields(runTimeout?.error).ms, 150);
checkEqual("run timeout: status", runTimeout?.run.status, "timeout");
await slowRunner.stop();

/** A failure with a class of its own, to show what survives storage. */
class PaymentDeclinedError extends Error {
  /** The gateway's code for the decline. */
  readonly code = "DECLINED";

  constructor(message: string) {
    super(message);
    this.name = "PaymentDeclinedError";
  }
}

const worker = new BunQueueWorker<unknown, unknown>(
  "errors",
  async (job, ctx) => {
    switch (job.name) {
      case "slow":
        // Waits for the attempt's signal, which the timeout aborts.
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw ctx.signal.reason;
      case "declined":
        throw new PaymentDeclinedError(`declined on attempt ${ctx.attempt}`);
      case "unrecoverable":
        throw new UnrecoverableJobError("card expired", { orderId: "o-2" });
      case "unrecoverable-caused":
        // The third argument is the standard error options: `cause` is the
        // error that decided it.
        throw new UnrecoverableJobError(
          "card expired",
          { orderId: "o-4" },
          { cause: new PaymentDeclinedError("the issuer said no") },
        );
      default:
        return null;
    }
  },
  { namespace, driver, pollInterval: 10 },
);

/** Errors from the worker's local `dead` event, by job id. */
const deadEvents = new Map<string, Error>();
worker.on("dead", (job, error) => {
  deadEvents.set(job.id, error);
});
void worker.run();

/** Adds a job and waits until it is dead, answering with its stored form. */
async function addAndWaitDead(
  name: string,
  options: Parameters<typeof queue.add>[2],
) {
  const job = await queue.add(name, {}, options);
  await waitFor(`the ${name} job to die`, async () => {
    return (await job.refresh())?.state === "dead";
  });
  await waitFor(`the ${name} dead event`, () => deadEvents.has(job.id));
  const stored = await job.refresh();
  if (!stored) {
    throw new Error(`the ${name} job disappeared`);
  }
  return stored;
}

const timedOutJob = await addAndWaitDead("slow", { timeout: 150 });
const jobTimeout = timedOutJob.failedReason;
check(
  "job timeout: failedReason is a rebuilt Error, not the class",
  jobTimeout instanceof Error && !(jobTimeout instanceof JobTimeoutError),
  jobTimeout,
);
checkEqual("job timeout: name", jobTimeout?.name, "JobTimeoutError");
checkEqual(
  "job timeout: message",
  jobTimeout?.message,
  "Timed out after 150ms",
);
checkEqual(
  "job timeout: code survives storage",
  fields(jobTimeout).code,
  "JOB_TIMEOUT",
);
checkEqual("job timeout: ms survives storage", fields(jobTimeout).ms, 150);
checkEqual(
  "job timeout: context names the job",
  (fields(jobTimeout).context as { jobId?: string } | undefined)?.jobId,
  timedOutJob.id,
);

check(
  "JobTimeoutError: instanceof",
  new JobTimeoutError(5) instanceof JobsError,
);
checkEqual(
  "JobTimeoutError: ms and context",
  [new JobTimeoutError(5).ms, new JobTimeoutError(5).context],
  [5, { ms: 5 }],
);

/* ------------------------------------------------------------------ */
step("Across a boundary: failedReason and stacktrace are rebuilt Errors");

const declined = await addAndWaitDead("declined", { attempts: 2, backoff: 0 });
checkEqual("attempts made", declined.attemptsMade, 2);
check(
  "failedReason is an Error, but not the original class",
  declined.failedReason instanceof Error &&
    !(declined.failedReason instanceof PaymentDeclinedError),
);
checkEqual(
  "failedReason: name and message",
  [declined.failedReason?.name, declined.failedReason?.message],
  ["PaymentDeclinedError", "declined on attempt 2"],
);
checkEqual(
  "failedReason: code",
  fields(declined.failedReason).code,
  "DECLINED",
);
check(
  "failedReason: stack kept",
  (declined.failedReason?.stack ?? "").includes("PaymentDeclinedError"),
  declined.failedReason?.stack,
);
checkEqual(
  // `Job.stacktrace`: "Recent failures, newest first."
  "stacktrace: one rebuilt Error per attempt, newest first",
  declined.stacktrace.map((error) => [
    error instanceof Error,
    error.name,
    error.message,
  ]),
  [
    [true, "PaymentDeclinedError", "declined on attempt 2"],
    [true, "PaymentDeclinedError", "declined on attempt 1"],
  ],
);
// The local event still has the thrown instance.
check(
  "the local dead event carries the original instance",
  deadEvents.get(declined.id) instanceof PaymentDeclinedError,
);

/* ------------------------------------------------------------------ */
step(
  "UnrecoverableJobError: stops retries, in-process and in a spawned processor",
);

const unrecoverable = await addAndWaitDead("unrecoverable", {
  attempts: 5,
  backoff: 0,
});
checkEqual(
  "in-process: one attempt of five",
  [unrecoverable.attemptsMade, unrecoverable.maxAttempts],
  [1, 5],
);
checkEqual(
  "in-process: failedReason name",
  unrecoverable.failedReason?.name,
  "UnrecoverableJobError",
);
checkEqual(
  "in-process: code",
  fields(unrecoverable.failedReason).code,
  "UNRECOVERABLE_JOB",
);
checkEqual(
  "in-process: context survives storage",
  fields(unrecoverable.failedReason).context,
  { orderId: "o-2" },
);
check(
  "in-process: the dead event has the class",
  deadEvents.get(unrecoverable.id) instanceof UnrecoverableJobError,
);
checkEqual(
  "in-process: without a cause option, the stored failure has none",
  unrecoverable.failedReason?.cause,
  undefined,
);

const caused = await addAndWaitDead("unrecoverable-caused", {
  attempts: 5,
  backoff: 0,
});
checkEqual(
  "in-process: with { cause }, it still stops retries",
  [caused.attemptsMade, caused.failedReason?.name],
  [1, "UnrecoverableJobError"],
);
const storedCause = caused.failedReason?.cause as Error | undefined;
checkEqual(
  "in-process: the cause survives storage, with its name, message and code",
  [storedCause?.name, storedCause?.message, fields(storedCause).code],
  ["PaymentDeclinedError", "the issuer said no", "DECLINED"],
);

await worker.close();

const isolatedQueue = new BunQueue<{ orderId: string }, never>(
  "errors-isolated",
  { namespace, driver },
);
const isolatedWorker = new BunQueueWorker<{ orderId: string }, never>(
  "errors-isolated",
  helper("errors-unrecoverable.ts"),
  { namespace, driver, target: "child-process", pollInterval: 10 },
);
/** The error the isolated worker's `dead` event carried. */
let isolatedDead: Error | undefined;
isolatedWorker.on("dead", (_job, error) => {
  isolatedDead = error;
});
void isolatedWorker.run();

const isolatedJob = await isolatedQueue.add(
  "charge",
  { orderId: "o-9" },
  { attempts: 5, backoff: 0 },
);
await waitFor(
  "the isolated job to die",
  async () => {
    return (await isolatedJob.refresh())?.state === "dead";
  },
  { timeout: 30_000 },
);
const isolatedStored = await isolatedJob.refresh();
checkEqual(
  "child-process: one attempt of five",
  [isolatedStored?.attemptsMade, isolatedStored?.maxAttempts],
  [1, 5],
);
checkEqual(
  "child-process: failedReason name and message",
  [isolatedStored?.failedReason?.name, isolatedStored?.failedReason?.message],
  ["UnrecoverableJobError", "card expired"],
);
checkEqual(
  "child-process: context crossed two boundaries",
  fields(isolatedStored?.failedReason).context,
  { orderId: "o-9" },
);
await waitFor("the isolated dead event", () => isolatedDead !== undefined);
check(
  "child-process: the dead event is a rebuilt Error, recognised by name",
  isolatedDead?.name === "UnrecoverableJobError" &&
    !(isolatedDead instanceof UnrecoverableJobError),
  isolatedDead,
);

await isolatedWorker.close();
await isolatedQueue.close();

check(
  "UnrecoverableJobError: instanceof",
  new UnrecoverableJobError("x") instanceof JobsError,
);

// `(message, context?, options?: { cause })`: the cause is the standard
// `Error.cause`, and leaving the options out leaves no `cause` at all.
const rootCause = new Error("gateway timeout");
const withCause = new UnrecoverableJobError(
  "card declined",
  { orderId: "o-5" },
  { cause: rootCause },
);
checkEqual(
  "UnrecoverableJobError: options.cause is the Error's cause",
  [withCause.cause === rootCause, withCause.context, withCause.code],
  [true, { orderId: "o-5" }, "UNRECOVERABLE_JOB"],
);
checkEqual(
  "UnrecoverableJobError: a cause without a context",
  new UnrecoverableJobError("x", undefined, { cause: rootCause }).cause,
  rootCause,
);
check(
  "UnrecoverableJobError: no options, no cause property",
  !("cause" in new UnrecoverableJobError("x", { orderId: "o-6" })),
);

/* ------------------------------------------------------------------ */
step(
  "Exported, but raised by no public path: their shapes, and what happens instead",
);

// A full trigger queue is an outcome, not a QueueFullError.
const busy = new BunRunner({
  id: "busy",
  namespace,
  driver,
  file: helper("errors-wait-for-stop.ts"),
  executionMode: "in-process",
  queueRuns: true,
  maxQueuedRuns: 1,
});
const busyStarted = new Set<string>();
busy.on("progress", (run) => {
  busyStarted.add(run.runId);
});
await busy.start();
const busyRun = await startRun(busy);
await waitFor("the busy run to start", () => busyStarted.has(busyRun));
checkEqual(
  "second trigger is queued",
  (await busy.trigger()).outcome,
  "queued",
);
checkEqual(
  "third trigger: skipped as queue-full, not thrown",
  await busy.trigger(),
  { outcome: "skipped", reason: "queue-full" },
);
await busy.stop({ force: true });

const queueFull = new QueueFullError("runner busy's trigger queue", 1);
checkJobsError("QueueFullError", queueFull, "QueueFullError", "QUEUE_FULL");
checkEqual(
  "QueueFullError: message and context",
  [queueFull.message, queueFull.context],
  [
    "runner busy's trigger queue is full (max 1)",
    { what: "runner busy's trigger queue", max: 1 },
  ],
);

// A closed worker's run() resolves at once rather than raising WorkerClosedError.
let runAfterClose: unknown = "resolved";
await worker.run().catch((error: unknown) => {
  runAfterClose = error;
});
checkEqual(
  "run() on a closed worker resolves",
  [runAfterClose, worker.isRunning],
  ["resolved", false],
);

const workerClosed = new WorkerClosedError("worker-1");
checkJobsError(
  "WorkerClosedError",
  workerClosed,
  "WorkerClosedError",
  "WORKER_CLOSED",
);
checkEqual(
  "WorkerClosedError: message and context",
  [workerClosed.message, workerClosed.context],
  ["Worker worker-1 is closed", { id: "worker-1" }],
);

// Lock contention is reported as outcomes too (`lock-held`, the `lockLost`
// event); these two exist for custom drivers and handlers.
const unavailable = new LockUnavailableError("r:nightly", { holder: "host:1" });
checkJobsError(
  "LockUnavailableError",
  unavailable,
  "LockUnavailableError",
  "LOCK_UNAVAILABLE",
);
checkEqual(
  "LockUnavailableError: message and context",
  [unavailable.message, unavailable.context],
  ["Lock r:nightly is held elsewhere", { key: "r:nightly", holder: "host:1" }],
);

const lost = new LockLostError("q:mail");
checkJobsError("LockLostError", lost, "LockLostError", "LOCK_LOST");
checkEqual(
  "LockLostError: message and context",
  [lost.message, lost.context],
  ["Lock q:mail was lost", { key: "q:mail" }],
);

/* ------------------------------------------------------------------ */
step("Clean up");

await queue.close();
await driver.purge(namespace);
await driver.close();

summary();
