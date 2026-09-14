/**
 * Option tour: `BunJobs` and `jobsFromContext` — every option set, every
 * member called, every behaviour asserted.
 *
 * ```bash
 * bun 10-options/bunjobs-options.ts
 * EXAMPLE_DRIVER=postgres EXAMPLE_POSTGRES_URL=postgres://user:pass@localhost/jobs bun 10-options/bunjobs-options.ts
 * ```
 *
 * The points that are easy to get wrong:
 *
 * - **Ownership follows the driver option's shape.** A config is built by the
 *   context and closed with it; an instance is lent and left open. Only a
 *   config can be handed to a child, so only then is `driverConfig` set.
 * - **Defined jobs share one queue** (`registryQueue`, `"jobs"` by default),
 *   dispatched by name — one worker for every kind of job.
 * - **Option precedence, bottom to top:** `defaultJobOptions`, then the
 *   definition's options, then the call's. `runnerDefaults` sit under a
 *   runner's own options; `publishEvents` under a queue's own `publish`.
 * - **`jobsFromContext` picks the driver the run can actually use:** the
 *   runner's instance in-process, its `driverConfig` in a child — and refuses
 *   to invent a private memory driver when there is neither.
 */
import type { DateParser, DriverEvent } from "@kingsleyweb/bun-jobs";
import type {
  FromContextArgs,
  FromContextReport,
} from "./handlers/bunjobs-from-context";
import type { DoubleData } from "./processors/bunjobs-double";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  BunRunnerManager,
  createDriver,
  JobBuilder,
  jobsFromContext,
} from "@kingsleyweb/bun-jobs";
import {
  crossProcessDriver,
  exampleDriver,
  exampleNamespace,
} from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Option tour: BunJobs");

/** Generous ceiling for anything a busy machine might slow down. */
const WAIT = { timeout: 30_000, interval: 10 };

const namespace = exampleNamespace("bunjobs-options");
const otherNamespace = exampleNamespace("bunjobs-options-other");
const config = exampleDriver();
/** One connection the lent-driver contexts share. */
const shared = createDriver(config);
await shared.connect();

/** Counts `close()` calls on a driver, optionally without closing it. */
function countCloses(
  driver: { close: () => Promise<void> },
  passThrough: boolean,
) {
  let calls = 0;
  const original = driver.close;
  driver.close = async () => {
    calls++;
    if (passThrough) {
      await original.call(driver);
    }
  };
  return {
    /** How many times `close()` was called. */
    calls: () => calls,
    /** Puts the real `close()` back. */
    restore: () => {
      driver.close = original;
    },
  };
}

/* ------------------------------------------------------------------ */
step("namespace and driver: config vs instance, driverConfig, ownership");

{
  const ownConfig = exampleDriver();
  const owned = new BunJobs({
    namespace,
    driver: ownConfig,
    logger: noopLogger,
  });
  const ownedCloses = countCloses(owned.driver, true);
  checkEqual("namespace", owned.namespace, namespace);
  checkEqual(
    "a config: driverConfig is that config",
    owned.driverConfig,
    ownConfig,
  );
  await owned.listQueues();
  await owned.close();
  checkEqual(
    "a config: the driver is closed with the context",
    ownedCloses.calls(),
    1,
  );

  const lent = new BunJobs({ namespace, driver: shared, logger: noopLogger });
  const lentCloses = countCloses(shared, false);
  checkEqual("an instance: used as is", lent.driver, shared);
  checkEqual("an instance: no driverConfig", lent.driverConfig, undefined);
  await lent.close();
  lentCloses.restore();
  checkEqual("an instance: never closed by the context", lentCloses.calls(), 0);

  const defaulted = new BunJobs({ namespace: "bunjobs-options-default" });
  checkEqual("no driver: a memory driver", defaulted.driver.name, "memory");
  await defaulted.close();
}

/* ------------------------------------------------------------------ */
step("The context under test: every option set");

const { logger, events: logEvents } = createTestLogger();

const paydayAt = new Date(Date.now() + 3_600_000);
paydayAt.setMilliseconds(0);

/** A date parser that knows one word. */
const payday: DateParser = {
  parse(text) {
    const index = text.indexOf("payday");
    return index < 0
      ? []
      : [{ index, text: "payday", start: { date: () => paydayAt } }];
  },
};

const jobs = new BunJobs({
  namespace,
  driver: shared,
  logger,
  defaultJobOptions: { attempts: 4, timeout: 45_000 },
  runnerDefaults: {
    executionMode: "in-process",
    timeout: 12_345,
    keepHistory: 7,
  },
  registryQueue: "registry",
  dateParser: payday,
  publishEvents: true,
});

/** Every driver event the context's notifier heard. */
const heard: DriverEvent[] = [];
const notifier = await jobs.notifier();
notifier.on("event", (event) => heard.push(event));

/** The events heard for one target, as `type`s. */
function heardFor(target: string): string[] {
  return heard
    .filter((event) => event.target === target)
    .map((event) => event.type);
}

/* ------------------------------------------------------------------ */
step("logger");

{
  jobs.logger.info("from the context");
  const line = logEvents.find((event) => event.message === "from the context");
  checkEqual(
    "logger: named for the namespace, bound to it",
    [line?.name, line?.bindings.namespace],
    [`jobs:${namespace}`, namespace],
  );
}

/* ------------------------------------------------------------------ */
step("queue(): same instance, defaultJobOptions, dateParser");

{
  const mail = jobs.queue("mail");
  check("queue(name) twice is the same instance", jobs.queue("mail") === mail);
  checkEqual(
    "dateParser reaches the queues created here",
    mail.dateParser,
    payday,
  );

  const plain = await mail.add("welcome", { to: "a@example.com" });
  checkEqual(
    "defaultJobOptions under every add",
    [plain.opts.attempts, plain.opts.timeout],
    [4, 45_000],
  );
  const ownDefaults = await jobs
    .queue("own-defaults", { defaultJobOptions: { attempts: 2 } })
    .add("x", {});
  checkEqual(
    "a queue's own defaultJobOptions win",
    ownDefaults.opts.attempts,
    2,
  );

  await checkRejects(
    "a dateParser that is not one",
    () =>
      new BunJobs({
        namespace,
        driver: shared,
        dateParser: {} as unknown as DateParser,
      }),
    { name: "ConfigError", code: "CONFIG" },
  );
}

/* ------------------------------------------------------------------ */
step("define(), definitions(), defineBackoff()");

{
  jobs.define<DoubleData, string>("double", () => "first definition");
  jobs.define<DoubleData, number>(
    "double",
    async (job, ctx) => {
      ctx.logger.info("doubling", { n: job.data.n });
      return job.data.n * 2;
    },
    { attempts: 3, concurrency: 3 },
  );

  let flakyCalls = 0;
  jobs.define("flaky", () => {
    flakyCalls++;
    if (flakyCalls === 1) {
      throw new Error("first attempt fails");
    }
    return "recovered";
  });

  checkEqual(
    "definitions(): redefining replaces",
    jobs
      .definitions()
      .map((definition) => [definition.name, definition.options]),
    [
      ["double", { attempts: 3, concurrency: 3 }],
      ["flaky", {}],
    ],
  );

  for (const concurrency of [0, 1.5]) {
    await checkRejects(
      `define: concurrency ${concurrency}`,
      () => jobs.define("bad", () => null, { concurrency }),
      {
        name: "ConfigError",
        code: "CONFIG",
      },
    );
  }
  await checkRejects(
    "define: an empty name",
    () => jobs.define("", () => null),
    { name: "ConfigError" },
  );

  await checkRejects(
    "defineBackoff: a built-in name",
    () => jobs.defineBackoff("fixed", () => 10),
    {
      name: "ConfigError",
      code: "CONFIG",
    },
  );
}

let strategyCalls = 0;
jobs.defineBackoff("tiny", () => {
  strategyCalls++;
  return 10;
});

/* ------------------------------------------------------------------ */
step("schedule / run / process / now, and registryQueue");

{
  const builders = [
    jobs.schedule("double"),
    jobs.run("double"),
    jobs.process("double"),
  ];
  check(
    "schedule, run and process answer with a JobBuilder",
    builders.every((builder) => builder instanceof JobBuilder),
  );

  for (const method of ["schedule", "run", "process"] as const) {
    await checkRejects(
      `${method}(undefined name)`,
      () => jobs[method]("undefined-job"),
      { name: "ConfigError", code: "CONFIG" },
    );
  }
  await checkRejects("now(undefined name)", () => jobs.now("undefined-job"), {
    name: "ConfigError",
    code: "CONFIG",
  });

  const onPayday = await jobs
    .run<DoubleData>("double", { n: 1 })
    .on("payday")
    .start();
  checkEqual(
    "dateParser: on('payday') is the parser's date",
    onPayday.runAt,
    paydayAt.getTime(),
  );
  checkEqual(
    "registryQueue: defined jobs go to that queue",
    onPayday.queue.queue,
    "registry",
  );

  const merged = await jobs.now<DoubleData>(
    "double",
    { n: 2 },
    { priority: 5 },
  );
  checkEqual(
    "precedence: definition over defaults, call over definition",
    [merged.opts.attempts, merged.opts.timeout, merged.priority],
    [3, 45_000, 5],
  );

  const repeat = await jobs
    .schedule("double")
    .withData({ n: 3 })
    .every("1 hour")
    .start();
  check(
    "schedule().every() adds a repeatable",
    repeat.isRepeat,
    repeat.repeatKey,
  );
  checkEqual(
    "the repeat lives on the registry queue",
    (await jobs.queue("registry").listRepeatables()).length,
    1,
  );
  await jobs.process("double").withData({ n: 4 }).in("1 hour").start();

  const queues = await jobs.listQueues();
  check(
    "listQueues: the registry queue, not 'jobs'",
    queues.includes("registry") && !queues.includes("jobs"),
    queues,
  );
}

/* ------------------------------------------------------------------ */
step("start(), stop(), drain()");

{
  // Empty the registry of what the previous section left, so counts are exact.
  await jobs.drain({ delayed: true });
  for (const repeatable of await jobs.queue("registry").listRepeatables()) {
    await jobs.queue("registry").removeRepeatable(repeatable.key);
  }

  const empty = new BunJobs({ namespace, driver: shared, logger: noopLogger });
  await checkRejects("start() with nothing defined", () => empty.start(), {
    name: "ConfigError",
    code: "CONFIG",
  });
  await empty.close();

  const worker = await jobs.start({ pollInterval: 25, concurrency: 4 });
  check(
    "start() twice returns the same worker",
    (await jobs.start()) === worker,
  );
  checkEqual(
    "start() stores each definition's concurrency as a name limit",
    (await jobs.queue("registry").getLimits())?.names?.double?.concurrency,
    3,
  );

  const results = new Map<string, unknown>();
  worker.on("completed", (job, result) => {
    results.set(job.id, result);
  });

  const doubled = await jobs.now<DoubleData>("double", { n: 21 });
  const flaky = await jobs.now(
    "flaky",
    {},
    { attempts: 2, backoff: { type: "tiny" } },
  );
  await waitFor(
    "the defined jobs",
    () => results.has(doubled.id) && results.has(flaky.id),
    WAIT,
  );
  checkEqual("the latest definition ran", results.get(doubled.id), 42);
  checkEqual(
    "defineBackoff: the named strategy set the retry delay",
    [results.get(flaky.id), strategyCalls],
    ["recovered", 1],
  );
  check(
    "logger: reaches processors run here",
    logEvents.some(
      (event) =>
        event.message === "doubling" && event.bindings.namespace === namespace,
    ),
    logEvents.map((event) => event.message),
  );

  await jobs.stop();
  check("stop() closes the registry worker", !worker.isRunning);

  await jobs.now("double", { n: 1 });
  await jobs.now("double", { n: 2 });
  await jobs.run("double", { n: 3 }).in("1 hour").start();
  checkEqual(
    "drain() removes waiting jobs only",
    [await jobs.drain(), await jobs.queue("registry").count("delayed")],
    [2, 1],
  );
  checkEqual(
    "drain({ delayed: true }) removes delayed ones too",
    await jobs.drain({ delayed: true }),
    1,
  );
}

/* ------------------------------------------------------------------ */
step("worker(): a function and a processor file");

{
  const fromFunction = jobs.worker<DoubleData, number>(
    "fn-work",
    (job) => job.data.n + 1,
    { pollInterval: 25 },
  );
  const fromFile = jobs.worker<DoubleData, number>(
    "file-work",
    new URL("./processors/bunjobs-double.ts", import.meta.url),
    { pollInterval: 25 },
  );
  const completed = new Map<string, number>();
  for (const worker of [fromFunction, fromFile]) {
    worker.on("completed", (job, result) => {
      completed.set(job.id, result);
    });
    void worker.run();
  }

  const a = await jobs.queue<DoubleData>("fn-work").add("add-one", { n: 1 });
  const b = await jobs.queue<DoubleData>("file-work").add("double", { n: 21 });
  await waitFor(
    "both workers' jobs",
    () => completed.has(a.id) && completed.has(b.id),
    WAIT,
  );
  checkEqual(
    "worker(function) and worker(file)",
    [completed.get(a.id), completed.get(b.id)],
    [2, 42],
  );
}

/* ------------------------------------------------------------------ */
step("runner(), runners, runnerDefaults, listRunners");

{
  const runner = jobs.runner({
    id: "defaults-runner",
    file: new URL("./handlers/runner-work.ts", import.meta.url),
  });
  checkEqual(
    "runner(): in the context's namespace, on its driver",
    [runner.namespace, runner.driver === shared],
    [namespace, true],
  );
  checkEqual(
    "runnerDefaults under every runner",
    [
      runner.options.executionMode,
      runner.options.timeout,
      runner.options.keepHistory,
    ],
    ["in-process", 12_345, 7],
  );
  checkEqual("publishEvents: runners publish", runner.options.publish, true);
  checkEqual(
    "a lent driver: no childDriver for the runner",
    runner.options.childDriver,
    undefined,
  );

  const overridden = jobs.runner({
    id: "override-runner",
    file: new URL("./handlers/runner-work.ts", import.meta.url),
    timeout: 1,
    publish: false,
  });
  checkEqual(
    "a runner's own options win over runnerDefaults",
    [overridden.options.timeout, overridden.options.publish],
    [1, false],
  );

  check(
    "runners is a manager in the namespace",
    jobs.runners instanceof BunRunnerManager &&
      jobs.runners.namespace === namespace,
  );
  checkEqual(
    "runners holds what runner() created",
    jobs.runners.list().map((registered) => registered.id),
    ["defaults-runner", "override-runner"],
  );

  await jobs.runners.startAll();
  const finished = new Promise<void>((resolve) => {
    runner.once("finished", () => resolve());
  });
  await runner.trigger({ args: { tag: "published" } });
  await finished;
  // `override-runner` has started but never run; a started runner is known to
  // the backend all the same.
  const runners = await jobs.listRunners();
  check(
    "listRunners: both runners",
    ["defaults-runner", "override-runner"].every((id) => runners.includes(id)),
    runners,
  );
}

/* ------------------------------------------------------------------ */
step("publishEvents and notifier()");

{
  // Followed up front, so nothing a quiet producer might publish is missed.
  await notifier.follow("queue", "muted");
  await notifier.follow("queue", "quiet");
  const quietContext = new BunJobs({
    namespace,
    driver: shared,
    logger: noopLogger,
  });

  await jobs.queue("muted", { publish: false }).add("m", {});
  await quietContext.queue("quiet").add("q", {});
  // A sentinel published after both: once it is heard, anything they
  // published would have been too.
  await jobs.queue("mail").add("sentinel", {});

  // Every event checked below is waited for: on a polling backend an event
  // whose write commits late is delivered late, and not in publish order.
  await waitFor(
    "the published events",
    () => {
      return (
        heardFor("mail").filter((type) => type === "added").length >= 2 &&
        ["started", "succeeded"].every((type) =>
          heardFor("defaults-runner").includes(type),
        ) &&
        heardFor("fn-work").includes("completed") &&
        heardFor("file-work").includes("completed")
      );
    },
    WAIT,
  );
  check(
    "publishEvents: queues publish (added)",
    heardFor("mail").includes("added"),
    heardFor("mail"),
  );
  check(
    "publishEvents: workers publish (completed)",
    heardFor("fn-work").includes("completed") &&
      heardFor("file-work").includes("completed"),
    heard.map((event) => [event.target, event.type]),
  );
  check(
    "publishEvents: runners publish (started, succeeded)",
    ["started", "succeeded"].every((type) =>
      heardFor("defaults-runner").includes(type),
    ),
    heardFor("defaults-runner"),
  );
  checkEqual("a queue's own publish: false wins", heardFor("muted"), []);
  checkEqual(
    "a context without publishEvents publishes nothing",
    heardFor("quiet"),
    [],
  );
  checkEqual(
    "a runner's own publish: false wins",
    heardFor("override-runner"),
    [],
  );
  await quietContext.close();

  const scoped = await jobs.notifier({ queues: ["mail"], runners: [] });
  checkEqual(
    "notifier(options): follows only what it was given",
    scoped.following,
    ["queue:mail"],
  );
  const iterator = scoped[Symbol.asyncIterator]();
  const next = iterator.next();
  await jobs.queue("mail").add("iterated", {});
  const first = await next;
  checkEqual(
    "notifier: an async iterator of events",
    [first.done, first.value?.kind, first.value?.target],
    [false, "queue", "mail"],
  );
  await iterator.return?.();
}

/* ------------------------------------------------------------------ */
step("jobsFromContext()");

{
  const file = new URL("./handlers/bunjobs-from-context.ts", import.meta.url);

  // In-process: the runner's own instance.
  const inProcess = jobs.runner<FromContextArgs, FromContextReport>({
    id: "from-context-in-process",
    file,
    publish: false,
  });
  await inProcess.start();
  const inProcessReport = new Promise<FromContextReport>((resolve, reject) => {
    inProcess.once("finished", (_run, result) => resolve(result));
    inProcess.once("failed", (_run, error) => reject(error));
  });
  await inProcess.trigger({ args: { queue: "from-context" } });
  const local = await inProcessReport;
  checkEqual(
    "in-process: the runner's driver instance, no config",
    [local.usedDriverInstance, local.driverConfig, local.namespace],
    [true, null, namespace],
  );
  check(
    "in-process: the job it added is in the backend",
    (await jobs.queue("from-context").getJob(local.jobId)) !== null,
  );

  // Spawned: only a config can cross, so the context is built from one.
  const crossConfig = crossProcessDriver();
  const crossJobs = new BunJobs({
    namespace,
    driver: crossConfig,
    logger: noopLogger,
    runnerDefaults: { executionMode: "spawn" },
  });
  const spawned = crossJobs.runner<FromContextArgs, FromContextReport>({
    id: "from-context-spawn",
    file,
  });
  checkEqual(
    "a config context hands its runners childDriver",
    spawned.options.childDriver,
    crossConfig,
  );
  await spawned.start();
  const spawnedReport = new Promise<FromContextReport>((resolve, reject) => {
    spawned.once("finished", (_run, result) => resolve(result));
    spawned.once("failed", (_run, error) => reject(error));
  });
  await spawned.trigger({ args: { queue: "from-context" } });
  const remote = await spawnedReport;
  checkEqual(
    "spawn: built from driverConfig",
    [remote.usedDriverInstance, remote.driverConfig],
    [false, crossConfig],
  );
  check(
    "spawn: the child's job is in the shared backend",
    (await crossJobs.queue("from-context").getJob(remote.jobId)) !== null,
  );
  await crossJobs.purge();
  await crossJobs.close();

  // Neither: refused, not a private memory driver.
  await checkRejects(
    "jobsFromContext with neither driver nor driverConfig",
    () => jobsFromContext({ namespace }),
    {
      name: "ConfigError",
      code: "CONFIG",
    },
  );
  const stranded = jobs.runner<FromContextArgs, FromContextReport>({
    id: "from-context-stranded",
    file,
    executionMode: "spawn",
    publish: false,
  });
  await stranded.start();
  const strandedError = new Promise<string>((resolve) => {
    stranded.once("failed", (_run, error) => resolve(error.name));
    stranded.once("finished", () => resolve("finished"));
  });
  await stranded.trigger({ args: { queue: "from-context" } });
  checkEqual(
    "a spawned run on a lent driver cannot reach the backend",
    await strandedError,
    "ConfigError",
  );
}

/* ------------------------------------------------------------------ */
step("purge(): this namespace only");

{
  const other = new BunJobs({
    namespace: otherNamespace,
    driver: shared,
    logger: noopLogger,
  });
  const kept = await other.queue("mail").add("kept", {});

  await jobs.purge();
  checkEqual(
    "purge: this namespace's queues are gone",
    (await jobs.queue("mail").count()).waiting,
    0,
  );
  checkEqual(
    "purge: this namespace's runners are gone",
    (await jobs.listRunners()).filter((id) => id === "from-context-in-process"),
    [],
  );
  check(
    "purge: another namespace is untouched",
    (await other.queue("mail").getJob(kept.id)) !== null,
  );

  await other.purge();
  await other.close();
}

/* ------------------------------------------------------------------ */
step("close()");

{
  const runner = jobs.runners.get("defaults-runner");
  const mail = jobs.queue("mail");
  const worker = jobs.worker("closing", () => null, { pollInterval: 25 });
  void worker.run();
  await waitFor("the worker to run", () => worker.isRunning, WAIT);

  await jobs.close();
  checkEqual("close: runners stopped", runner?.status, "stopped");
  check("close: workers closed", !worker.isRunning);
  await checkRejects("close: queues closed", () => mail.add("late", {}), {
    name: "QueueClosedError",
  });
  checkEqual(
    "close: notifiers closed",
    (await notifier[Symbol.asyncIterator]().next()).done,
    true,
  );
}

/* ------------------------------------------------------------------ */
step("Clean up");

await shared.purge(namespace);
await shared.purge(otherNamespace);
await shared.close();
show("namespaces purged", [namespace, otherNamespace]);

summary();
