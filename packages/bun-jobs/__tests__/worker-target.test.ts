import type {
  BunQueueWorkerOptions,
  Job,
  ProcessorContext,
  WorkerInfo,
  WorkerTarget,
  WorkerTargetAttempt,
  WorkerTargetContext,
  WorkerTargetMode,
} from "../lib/index";
import { join } from "node:path";
import process from "node:process";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { toWorkerDto } from "../lib/api/serialize";
import {
  BunQueue,
  BunQueueWorker,
  ConfigError,
  DEFAULT_LOCK_DURATION,
  defineProcessors,
  JobDefinitions,
  MemoryDriver,
  UnrecoverableJobError,
} from "../lib/index";
import { DEFAULT_CLOSE_TIMEOUT } from "../lib/shared/constants";
import { testNamespace, waitFor } from "./helpers";

/**
 * Running a job's processor in a child process or a `Worker`: the `target`
 * option's three local kinds, each behaving exactly as the `isolation` mode it
 * replaced did (`"child-process"` was `"spawn"`, `"worker-thread"` was
 * `"worker"`).
 *
 * The same processor file runs in each target, and each test checks what it
 * can only know by running there: which process or thread did the work, that
 * the job's log and progress still reached the store through the worker, and
 * that an error crossing the boundary still decides retries correctly.
 */

const handler = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

/** A queue and a worker running `file` on the `mode` target. */
function setup(
  mode: WorkerTargetMode,
  file: string,
  /** Lock tuning for the worker; the worker's defaults when absent. */
  lock: {
    /** The worker's `lockDuration`. */
    lockDuration?: number;
    /** The worker's `heartbeatInterval`. */
    heartbeatInterval?: number;
  } = {},
) {
  const driver = new MemoryDriver();
  const namespace = testNamespace();
  const queue = new BunQueue("isolated", {
    namespace,
    driver,
    logger: noopLogger,
  });
  const worker = new BunQueueWorker("isolated", handler(file), {
    namespace,
    driver,
    logger: noopLogger,
    pollInterval: 5,
    target:
      mode === "child-process"
        ? { kind: mode, closeTimeout: 200, killTimeout: 200 }
        : mode === "worker-thread"
          ? { kind: mode, closeTimeout: 200 }
          : mode,
    waitToExit: false,
    ...lock,
  });
  closers.push(
    () => queue.close(),
    () => worker.close({ force: true }),
  );
  void worker.run();
  return { queue, worker, driver };
}

/** Whether a process id is still alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const mode of ["child-process", "worker-thread", "in-process"] as const) {
  describe(`target: ${mode}`, () => {
    it("runs the job there, with its log and progress reaching the store", async () => {
      const { queue, worker } = setup(mode, "job-double");
      const progress: unknown[] = [];
      worker.on("progress", (_job, value) => progress.push(value));

      const job = await queue.add(
        "double",
        { n: 21 },
        { removeOnComplete: false },
      );

      await waitFor(
        async () => (await queue.getJob(job.id))?.state === "completed",
        { timeout: 20_000, message: `the ${mode} job never completed` },
      );

      const stored = await queue.getJob(job.id);
      const result = stored?.returnValue as {
        doubled: number;
        pid: number;
        child: string | null;
        mode: string | null;
        logged: number;
        lockHeld: boolean;
      };

      expect(result.doubled).toBe(42);
      expect(result.logged).toBe(1);
      expect(result.lockHeld).toBe(true);
      expect(progress).toContain(50);
      expect(stored?.progress).toBe(50);
      expect(await queue.getJobLogs(job.id)).toEqual({
        logs: ["doubling 21", "done"],
        count: 2,
      });

      // The target's own spelling reaches the processor: a worker thread
      // runs with BUN_JOBS_MODE=worker-thread, a child process with
      // =child-process — no mapping to the runner's pre-1r words.
      if (mode === "child-process") {
        expect(result.pid).not.toBe(process.pid);
        expect(result.child).toBe("1");
        expect(result.mode).toBe("child-process");
      } else if (mode === "worker-thread") {
        expect(result.pid).toBe(process.pid);
        expect(result.child).toBe("1");
        expect(result.mode).toBe("worker-thread");
      } else {
        expect(result.pid).toBe(process.pid);
        expect(result.child).toBeNull();
        expect(result.mode).toBeNull();
      }
    }, 30_000);

    it("retries a failing job, and records the error from where it ran", async () => {
      const { queue } = setup(mode, "job-fail");
      const job = await queue.add("fail", {}, { attempts: 2, backoff: 1 });

      await waitFor(
        async () => (await queue.getJob(job.id))?.state === "dead",
        { timeout: 20_000, message: "the job never ran out of attempts" },
      );

      const stored = await queue.getJob(job.id);
      expect(stored?.attemptsMade).toBe(2);
      expect(stored?.failedReason?.message).toBe("attempt 2 failed");
    }, 30_000);

    it("still honours an unrecoverable error thrown there", async () => {
      const { queue } = setup(mode, "job-fail");
      const job = await queue.add(
        "fail",
        { unrecoverable: true },
        { attempts: 5, backoff: 1 },
      );

      await waitFor(
        async () => (await queue.getJob(job.id))?.state === "dead",
        { timeout: 20_000 },
      );

      const stored = await queue.getJob(job.id);
      expect(stored?.attemptsMade).toBe(1);
      expect(stored?.failedReason?.name).toBe("UnrecoverableJobError");
    }, 30_000);

    it("gives a flow's jobs their parent, and the parent its children's values and failures", async () => {
      // Every job in the flow runs the same file here, so a child reads
      // `job.parent` and the parent reads its children, all in `mode`. In
      // `child-process` and `worker-thread` these used to be missing from the job object.
      const { queue } = setup(mode, "job-children");
      const flow = await queue.addFlow({
        name: "parent",
        data: {},
        opts: { removeOnComplete: false },
        children: [
          { name: "ok", data: {}, queue: "isolated" },
          {
            name: "bad",
            data: {},
            queue: "isolated",
            opts: { ignoreFailure: true },
          },
        ],
      });

      await waitFor(
        async () => (await queue.getJob(flow.job.id))?.state === "completed",
        { timeout: 20_000, message: `the ${mode} flow never completed` },
      );

      const ok = flow.children[0]!.job.id;
      const bad = flow.children[1]!.job.id;
      const stored = await queue.getJob(flow.job.id);

      expect(stored?.returnValue).toEqual({
        parent: null,
        values: {
          [`isolated:${ok}`]: {
            parent: { queue: "isolated", id: flow.job.id },
          },
        },
        failures: {
          [`isolated:${bad}`]: {
            isError: true,
            name: "UnrecoverableJobError",
            message: "optional source down",
          },
        },
      });
    }, 30_000);

    it("shows a caller's repeat key exactly as the worker's own Job does", async () => {
      // A key without `|` is shown bare; one with `|` keeps its stored `k:`
      // prefix (see `displayRepeatKey`). Isolated jobs used to report the raw
      // stored spelling, so the same job named its series differently.
      const { queue, worker } = setup(mode, "job-identity");
      const seen = new Map<
        string,
        { child: Record<string, unknown>; worker: Record<string, unknown> }
      >();
      worker.on("progress", (job, value) => {
        seen.set(job.name, {
          child: value as Record<string, unknown>,
          worker: {
            ...job.toJSON(),
            repeatKey: job.repeatKey,
            isRepeat: job.isRepeat,
          },
        });
      });

      await queue.add(
        "bare",
        {},
        { repeat: { every: 60_000, key: "nightly", immediately: true } },
      );
      await queue.add(
        "piped",
        {},
        { repeat: { every: 60_000, key: "report|daily", immediately: true } },
      );

      await waitFor(() => seen.size === 2, {
        timeout: 20_000,
        message: `the ${mode} repeat occurrences never ran`,
      });

      expect(seen.get("bare")!.child.repeatKey).toBe("nightly");
      expect(seen.get("bare")!.child.isRepeat).toBe(true);
      expect(seen.get("piped")!.child.repeatKey).toBe("k:report|daily");
      expect(seen.get("piped")!.child.isRepeat).toBe(true);
      for (const { child, worker: own } of seen.values()) {
        expect(child.repeatKey).toBe(own.repeatKey);
      }
    }, 30_000);

    it("hands the processor the same job members the worker's Job has", async () => {
      const { queue, worker } = setup(mode, "job-identity");
      let seen:
        | { child: Record<string, unknown>; worker: Record<string, unknown> }
        | undefined;
      worker.on("progress", (job, value) => {
        seen = {
          child: value as Record<string, unknown>,
          worker: {
            id: job.id,
            name: job.name,
            data: job.data,
            opts: job.opts,
            state: job.state,
            priority: job.priority,
            runAt: job.runAt,
            createdAt: job.createdAt,
            processedOn: job.processedOn,
            finishedOn: job.finishedOn,
            expiresAt: job.expiresAt,
            attemptsMade: job.attemptsMade,
            maxAttempts: job.maxAttempts,
            stalledCount: job.stalledCount,
            progress: job.progress,
            returnValue: job.returnValue,
            failedReason: job.failedReason?.message ?? null,
            stacktrace: job.stacktrace.map((error) => error.message),
            workerId: job.workerId,
            repeatKey: job.repeatKey,
            wasAdded: job.wasAdded,
            queue: job.queue,
            isRepeat: job.isRepeat,
            lockToken: job.lockToken,
            parent: job.parent,
          },
        };
      });

      // A repeat occurrence, so the derived members are exercised too.
      await queue.add(
        "plain",
        { n: 1 },
        {
          priority: 3,
          repeat: { every: 60_000, key: "members", immediately: true },
        },
      );
      await waitFor(() => seen !== undefined, {
        timeout: 20_000,
        message: `the ${mode} job never reported`,
      });

      expect(seen!.child).toStrictEqual(
        JSON.parse(JSON.stringify(seen!.worker)) as Record<string, unknown>,
      );
    }, 30_000);

    it("extends the lock by what extendLock(ms) asks, and heartbeat by lockDuration", async () => {
      // The worker's own renewal is pushed out of the way, and its
      // lockDuration made distinct from both the default and the asked-for
      // duration, so each of the three is visible in the lock's expiry.
      const lockDuration = 10_000;
      const { queue, worker, driver } = setup(mode, "job-extend-lock", {
        lockDuration,
        heartbeatInterval: 120_000,
      });
      const reads: Promise<{
        step: string;
        held: boolean;
        ahead: number | null;
      }>[] = [];
      worker.on("progress", (job, value) => {
        const { step, held, at } = value as {
          step: string;
          held: boolean;
          at: number;
        };
        reads.push(
          driver.getJob(worker.ref, job.id).then((record) => ({
            step,
            held,
            ahead:
              record?.lockExpiresAt == null ? null : record.lockExpiresAt - at,
          })),
        );
      });

      const job = await queue.add(
        "extend",
        { ms: 60_000, pause: 300 },
        { removeOnComplete: false },
      );
      await waitFor(
        async () => (await queue.getJob(job.id))?.state === "completed",
        { timeout: 20_000, message: `the ${mode} job never completed` },
      );

      const byStep = Object.fromEntries(
        (await Promise.all(reads)).map((read) => [read.step, read]),
      );
      // Each expiry is `now + duration` in the worker, a little before `at`
      // in the processor: so a little under the duration, never over it.
      const expectAhead = (step: string, duration: number) => {
        expect(byStep[step]?.held).toBe(true);
        expect(byStep[step]?.ahead).toBeLessThanOrEqual(duration);
        expect(byStep[step]?.ahead).toBeGreaterThan(duration - 2_000);
      };
      expectAhead("heartbeat", lockDuration);
      expectAhead("default", DEFAULT_LOCK_DURATION);
      expectAhead("ms", 60_000);
    }, 30_000);

    it("fails a job for good with job.fail(), however it then returns", async () => {
      const { queue, worker, driver } = setup(mode, "job-fail-method");
      const answers: unknown[] = [];
      const dead: string[] = [];
      worker.on("progress", (_job, value) => answers.push(value));
      worker.on("dead", (job) => dead.push(job.id));

      const job = await queue.add(
        "string",
        { reason: "not worth retrying" },
        { attempts: 5, backoff: 1, deadLetter: "graveyard" },
      );
      await waitFor(
        async () => (await queue.getJob(job.id))?.state === "dead",
        { timeout: 20_000, message: `the ${mode} job never went dead` },
      );

      const stored = await queue.getJob(job.id);
      expect(stored?.attemptsMade).toBe(1);
      expect(stored?.returnValue).toBeNull();
      expect(stored?.failedReason?.name).toBe("UnrecoverableJobError");
      expect(stored?.failedReason?.message).toBe("not worth retrying");
      // As `Job.fail()` builds it: a string reason has no cause.
      expect(stored?.failedReason?.cause).toBeUndefined();
      expect(answers).toEqual([{ answered: true }]);
      await waitFor(() => dead.includes(job.id), { timeout: 5_000 });

      // Delivered to its dead-letter queue like any other dead job.
      const graveyard = new BunQueue("graveyard", {
        namespace: worker.ref.ns,
        driver,
        logger: noopLogger,
      });
      closers.push(() => graveyard.close());
      await waitFor(async () => (await graveyard.count("waiting")) === 1, {
        timeout: 5_000,
        message: `the ${mode} job was never dead-lettered`,
      });
    }, 30_000);

    it("keeps an Error given to job.fail(), with its message and cause", async () => {
      const { queue } = setup(mode, "job-fail-method");
      const job = await queue.add("error", {}, { attempts: 3, backoff: 1 });

      await waitFor(
        async () => (await queue.getJob(job.id))?.state === "dead",
        { timeout: 20_000, message: `the ${mode} job never went dead` },
      );

      // The stored, serialized form: what every later reader rebuilds from.
      const reason = (await queue.getJob(job.id))?.toJSON().failedReason;
      expect(reason?.name).toBe("UnrecoverableJobError");
      expect(reason?.message).toBe("card declined");
      expect(reason?.cause?.message).toBe("card declined");
      expect(reason?.cause?.cause?.message).toBe("gateway timeout");
    }, 30_000);

    it("keeps the first job.fail() reason over a later one, and over a throw", async () => {
      const { queue, worker } = setup(mode, "job-fail-method");
      const answers: unknown[] = [];
      worker.on("progress", (_job, value) => answers.push(value));

      const job = await queue.add(
        "then-throw",
        {},
        { attempts: 3, backoff: 1 },
      );
      await waitFor(
        async () => (await queue.getJob(job.id))?.state === "dead",
        { timeout: 20_000, message: `the ${mode} job never went dead` },
      );

      const stored = await queue.getJob(job.id);
      expect(stored?.attemptsMade).toBe(1);
      expect(stored?.failedReason?.name).toBe("UnrecoverableJobError");
      expect(stored?.failedReason?.message).toBe("the first reason");
      expect(answers).toEqual([{ answered: true }]);
    }, 30_000);

    it("tells a flow's parent about a child that called job.fail()", async () => {
      const { queue } = setup(mode, "job-fail-method");
      const flow = await queue.addFlow({
        name: "parent",
        data: {},
        opts: { removeOnComplete: false },
        children: [
          {
            name: "child",
            data: {},
            queue: "isolated",
            opts: { attempts: 3, backoff: 1, ignoreFailure: true },
          },
        ],
      });

      await waitFor(
        async () => (await queue.getJob(flow.job.id))?.state === "completed",
        { timeout: 20_000, message: `the ${mode} flow never completed` },
      );

      const child = flow.children[0]!.job.id;
      expect((await queue.getJob(child))?.attemptsMade).toBe(1);
      expect((await queue.getJob(flow.job.id))?.returnValue).toEqual({
        [`isolated:${child}`]: {
          name: "UnrecoverableJobError",
          message: "optional source down",
        },
      });
    }, 30_000);

    it("shows a stored progress narrowed exactly as Job narrows it", async () => {
      const { queue, worker, driver } = setup(mode, "job-fail-method");
      let seen: { child: unknown; worker: unknown } | undefined;
      worker.on("progress", (job, value) => {
        seen = {
          child: (value as { seen: unknown }).seen,
          worker: job.progress,
        };
      });

      // Held back long enough to store a value no processor could report:
      // an array, which is an object but not a `RunProgress`.
      const job = await queue.add("progress", {}, { delay: 300 });
      await driver.updateProgress(worker.ref, job.id, [1, 2]);

      await waitFor(() => seen !== undefined, {
        timeout: 20_000,
        message: `the ${mode} job never reported`,
      });
      expect(seen).toEqual({ child: null, worker: null });
    }, 30_000);
  });
}

describe("target: what only a worker-thread or child-process can do", () => {
  it("kills a spawned processor that ignores its signal when the job times out", async () => {
    const { queue, worker } = setup("child-process", "job-hang");
    let pid: number | undefined;
    worker.on("progress", (_job, value) => {
      pid = (value as { pid?: number }).pid ?? pid;
    });

    // Long enough that the child certainly reports its pid before the deadline
    // passes, and no less a timeout for it: the fixture hangs for ever, so the
    // job still overruns and the child is still killed. At 300ms a loaded
    // machine could spawn slower than that, and a progress update arriving
    // after the abort is dropped by design — leaving this test waiting 20s for
    // an event that was never going to come.
    const job = await queue.add("hang", {}, { timeout: 2_000, attempts: 1 });

    await waitFor(() => pid !== undefined, { timeout: 20_000 });
    await waitFor(async () => (await queue.getJob(job.id))?.state === "dead", {
      timeout: 20_000,
      message: "the timed-out job never failed",
    });
    await waitFor(() => !isAlive(pid!), {
      timeout: 5_000,
      message: "the spawned processor was never killed",
    });

    expect((await queue.getJob(job.id))?.failedReason?.name).toBe(
      "JobTimeoutError",
    );
  }, 40_000);

  it("tells an off-thread processor plainly what it cannot do", async () => {
    const { queue } = setup("child-process", "job-unavailable");
    const job = await queue.add("try", {}, { removeOnComplete: false });

    await waitFor(
      async () => (await queue.getJob(job.id))?.state === "completed",
      { timeout: 20_000 },
    );

    expect((await queue.getJob(job.id))?.returnValue).toContain(
      "is not available in an isolated job",
    );
  }, 30_000);

  for (const mode of ["child-process", "worker-thread"] as const) {
    it(`says schedule(), update(), disable() and enable() are not available (${mode})`, async () => {
      const { queue } = setup(mode, "job-unavailable-series");
      const job = await queue.add("try", {}, { removeOnComplete: false });

      await waitFor(
        async () => (await queue.getJob(job.id))?.state === "completed",
        { timeout: 20_000 },
      );

      const told = (await queue.getJob(job.id))?.returnValue as Record<
        string,
        string
      >;
      expect(Object.keys(told).sort()).toEqual([
        "disable",
        "enable",
        "schedule",
        "update",
      ]);
      for (const [method, message] of Object.entries(told)) {
        expect(message).toBe(
          `job.${method}() is not available in an isolated job: it changes the stored job, and the driver stays in the worker process`,
        );
      }
    }, 30_000);
  }
});

/* --- resolution and errors ------------------------------------------------ */

/** Builds a worker with `options`, returning what the constructor threw. */
function thrownBy(
  processor: string | (() => Promise<unknown>),
  options: Record<string, unknown>,
): unknown {
  try {
    const worker = new BunQueueWorker("targets", processor, {
      namespace: testNamespace(),
      driver: new MemoryDriver(),
      logger: noopLogger,
      ...options,
    } as BunQueueWorkerOptions);
    closers.push(() => worker.close({ force: true }));
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Asserts `options` fail construction with a `ConfigError` matching `message`. */
function expectConfigError(
  processor: string | (() => Promise<unknown>),
  options: Record<string, unknown>,
  message: RegExp | string,
): ConfigError {
  const error = thrownBy(processor, options);
  expect(error).toBeInstanceOf(ConfigError);
  if (typeof message === "string") {
    expect((error as ConfigError).message).toBe(message);
  } else {
    expect((error as ConfigError).message).toMatch(message);
  }
  return error as ConfigError;
}

describe("target: resolution and errors", () => {
  const fn = async () => null;
  const file = handler("job-double");

  it("refuses a worker-thread or child-process target for a function", () => {
    for (const target of [
      "child-process",
      "worker-thread",
      { kind: "child-process" },
      { kind: "worker-thread", closeTimeout: 100 },
    ] as const) {
      const kind = typeof target === "string" ? target : target.kind;
      const error = expectConfigError(
        fn,
        { target },
        `target "${kind}" needs a processor file: a function cannot be sent to another process or Worker`,
      );
      // The phrase the examples match on stays, whatever the kind.
      expect(error.message).toMatch(/needs a processor file/);
      expect(error.context).toEqual({ target: kind });
    }
  });

  it("accepts in-process for a function, as a string, an object and by default", () => {
    for (const options of [
      {},
      { target: "in-process" },
      { target: { kind: "in-process" } },
    ]) {
      expect(thrownBy(fn, options)).toBeUndefined();
    }
  });

  it("refuses a value that is not a target, with one prefix for all of them", () => {
    expectConfigError(
      file,
      { target: "thread" },
      'target must be "in-process", "worker-thread" or "child-process", not "thread"',
    );
    expectConfigError(
      file,
      { target: { kind: "remote" } },
      'target must be "in-process", "worker-thread" or "child-process", not { kind: "remote" }',
    );
    for (const target of [42, true, ["child-process"]]) {
      expectConfigError(file, { target }, /^target must be /);
    }
  });

  it("points the old spellings at the current ones", () => {
    expectConfigError(
      file,
      { target: "spawn" },
      'target must be "in-process", "worker-thread" or "child-process", not "spawn": "spawn" is the old spelling of "child-process"',
    );
    expectConfigError(
      file,
      { target: "worker" },
      'target must be "in-process", "worker-thread" or "child-process", not "worker": "worker" is the old spelling of "worker-thread"',
    );
    expectConfigError(
      fn,
      { target: { kind: "spawn" } },
      /not \{ kind: "spawn" \}: "spawn" is the old spelling of "child-process"/,
    );
  });

  it("refuses settings that belong to another kind, from plain JavaScript", () => {
    expectConfigError(
      file,
      { target: { kind: "worker-thread", spawn: { cwd: "/" } } },
      'target { kind: "worker-thread" } does not take spawn: it takes closeTimeout, worker',
    );
    expectConfigError(
      file,
      { target: { kind: "child-process", worker: { smol: true } } },
      'target { kind: "child-process" } does not take worker: it takes closeTimeout, killTimeout, spawn',
    );
    expectConfigError(
      file,
      { target: { kind: "in-process", closeTimeout: 5 } },
      'target { kind: "in-process" } does not take closeTimeout: it takes no settings',
    );
    expectConfigError(
      file,
      { target: { kind: "child-process", killTimeout: -1 } },
      /^target killTimeout must be a number of milliseconds/,
    );
  });

  it("says isolation was replaced rather than ignoring it", () => {
    // Silently ignored, a file meant for a child process would run on the
    // claim loop's own thread with nothing to say so.
    for (const isolation of ["spawn", "worker", "in-process"]) {
      expectConfigError(
        file,
        { isolation },
        'isolation was replaced by target: use target: "child-process" (was "spawn") or "worker-thread" (was "worker")',
      );
    }
    expectConfigError(
      file,
      { target: "child-process", isolationOptions: { closeTimeout: 1 } },
      /^isolationOptions was replaced by target/,
    );
  });

  it("refuses a processor file that does not resolve, whatever the target", () => {
    for (const target of ["in-process", "worker-thread", "child-process"]) {
      expectConfigError(
        "./no/such/processor.ts",
        { target },
        /^Cannot resolve the processor file "\.\/no\/such\/processor\.ts"/,
      );
    }
  });

  it("resolves a relative file from a child-process target's cwd", () => {
    const fixtures = join(import.meta.dir, "fixtures", "handlers");
    expect(
      thrownBy("./job-double.ts", {
        target: { kind: "child-process", spawn: { cwd: fixtures } },
      }),
    ).toBeUndefined();
    expect(
      thrownBy("./job-double.ts", { target: "child-process" }),
    ).toBeInstanceOf(ConfigError);
  });
});

/* --- a custom target ------------------------------------------------------ */

describe("target: a custom factory", () => {
  it("is called once, after the id and logger exist, and runs every attempt", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();
    const contexts: WorkerTargetContext[] = [];
    const attempts: WorkerTargetAttempt[] = [];
    const processor = async () => "never called";
    const worker = new BunQueueWorker("custom", processor, {
      namespace,
      driver,
      logger: noopLogger,
      pollInterval: 5,
      waitToExit: false,
      target: (context) => {
        contexts.push(context);
        return {
          name: "echo-pool",
          run: async (attempt) => {
            attempts.push(attempt);
            await attempt.job.updateProgress(10);
            await attempt.job.log(`ran ${attempt.record.name}`);
            return {
              echoed: attempt.record.data,
              attempt: attempt.context.attempt,
            };
          },
        };
      },
    });
    const queue = new BunQueue("custom", {
      namespace,
      driver,
      logger: noopLogger,
    });
    closers.push(
      () => queue.close(),
      () => worker.close({ force: true }),
    );

    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.namespace).toBe(namespace);
    expect(contexts[0]!.queue).toBe("custom");
    expect(contexts[0]!.workerId).toBe(worker.id);
    expect(typeof contexts[0]!.logger.info).toBe("function");
    expect(contexts[0]!.processor).toEqual({ kind: "function", fn: processor });
    // No driver, deliberately: every write goes through `attempt.job`.
    expect(Object.keys(contexts[0]!).sort()).toEqual([
      "logger",
      "namespace",
      "processor",
      "queue",
      "workerId",
    ]);

    void worker.run();
    const job = await queue.add("echo", { n: 1 }, { removeOnComplete: false });
    await waitFor(
      async () => (await queue.getJob(job.id))?.state === "completed",
      { timeout: 10_000 },
    );

    const stored = await queue.getJob(job.id);
    expect(stored?.returnValue).toEqual({ echoed: { n: 1 }, attempt: 1 });
    expect(stored?.progress).toBe(10);
    expect((await queue.getJobLogs(job.id)).logs).toEqual(["ran echo"]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.record.id).toBe(job.id);
    expect(attempts[0]!.job.id).toBe(job.id);
    expect(attempts[0]!.context.workerId).toBe(worker.id);
    // One factory call for the worker's life, not one per attempt.
    expect(contexts).toHaveLength(1);
  }, 20_000);

  it("hands a file processor to the factory as its resolved path", () => {
    let seen: WorkerTargetContext["processor"] | undefined;
    expect(
      thrownBy(handler("job-double"), {
        target: (context: WorkerTargetContext) => {
          seen = context.processor;
          return { name: "files", run: async () => null };
        },
      }),
    ).toBeUndefined();
    expect(seen).toEqual({ kind: "file", path: handler("job-double") });
  });

  it("aborts a custom attempt's signal on the job's timeout, and retries by name", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();
    let aborted = 0;
    const worker = new BunQueueWorker("custom-abort", async () => null, {
      namespace,
      driver,
      logger: noopLogger,
      pollInterval: 5,
      waitToExit: false,
      target: () => ({
        name: "abortable",
        run: async ({ record, context }) => {
          if (record.name === "fatal") {
            // Rebuilt from a wire format: a plain Error named for the class.
            const error = new Error("never");
            error.name = "UnrecoverableJobError";
            throw error;
          }
          await new Promise<void>((resolve) => {
            context.signal.addEventListener(
              "abort",
              () => {
                aborted++;
                resolve();
              },
              { once: true },
            );
          });
          throw new Error("stopped");
        },
      }),
    });
    const queue = new BunQueue("custom-abort", {
      namespace,
      driver,
      logger: noopLogger,
    });
    closers.push(
      () => queue.close(),
      () => worker.close({ force: true }),
    );
    void worker.run();

    const slow = await queue.add("slow", {}, { attempts: 1, timeout: 200 });
    const fatal = await queue.add("fatal", {}, { attempts: 5 });
    await waitFor(
      async () =>
        (await queue.getJob(slow.id))?.state === "dead" &&
        (await queue.getJob(fatal.id))?.state === "dead",
      { timeout: 10_000 },
    );

    expect(aborted).toBe(1);
    expect((await queue.getJob(slow.id))?.failedReason?.name).toBe(
      "JobTimeoutError",
    );
    // Unrecoverable by name: one attempt of five.
    expect((await queue.getJob(fatal.id))?.attemptsMade).toBe(1);
  }, 20_000);

  it("refuses a factory that does not return an executor", () => {
    for (const made of [
      undefined,
      {},
      { name: "no-run" },
      { run: async () => null },
      { name: "", run: async () => null },
      { name: "x".repeat(65), run: async () => null },
      { name: "bad-close", run: async () => null, close: 1 },
    ]) {
      expectConfigError(
        async () => null,
        { target: () => made },
        "A target factory must return { name, run, close? }, with a name of 1 to 64 characters",
      );
    }
    expect(
      thrownBy(async () => null, {
        target: () => ({ name: "x".repeat(64), run: async () => null }),
      }),
    ).toBeUndefined();
  });

  it("closes the target once, after the worker's attempts have settled", async () => {
    const order: string[] = [];
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const driver = new MemoryDriver();
    const namespace = testNamespace();
    const worker = new BunQueueWorker("custom-close", async () => null, {
      namespace,
      driver,
      logger: noopLogger,
      pollInterval: 5,
      waitToExit: false,
      target: () => ({
        name: "closable",
        run: async () => {
          started();
          await Bun.sleep(100);
          order.push("attempt settled");
          return null;
        },
        close: async () => {
          order.push("target closed");
        },
      }),
    });
    const queue = new BunQueue("custom-close", {
      namespace,
      driver,
      logger: noopLogger,
    });
    closers.push(() => queue.close());
    void worker.run();
    await queue.add("one", {});
    await running;

    await worker.close();
    await worker.close();

    expect(order).toEqual(["attempt settled", "target closed"]);
  }, 20_000);

  it("tells the target's close() when the close is forced, and only then", async () => {
    /** What each worker's target close() was handed, by how it was closed. */
    const received = new Map<string, unknown[]>();

    for (const how of ["forced", "plain", "timed out"] as const) {
      const driver = new MemoryDriver();
      const namespace = testNamespace();
      let started!: () => void;
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      const worker = new BunQueueWorker("custom-force", async () => null, {
        namespace,
        driver,
        logger: noopLogger,
        pollInterval: 5,
        waitToExit: false,
        target: () => ({
          name: "forceful",
          // Ignores its signal, so a close with a timeout really runs out.
          run: async () => {
            started();
            await new Promise(() => {});
          },
          close: (...args: unknown[]) => {
            received.set(how, args);
          },
        }),
      });
      void worker.run();

      // A forced close and one that times out each have an attempt to give up
      // on; a plain close has none, or it would wait for it.
      if (how !== "plain") {
        const queue = new BunQueue("custom-force", {
          namespace,
          driver,
          logger: noopLogger,
        });
        closers.push(() => queue.close());
        await queue.add("stuck", {});
        await running;
      }

      await worker.close(
        how === "forced"
          ? { force: true }
          : how === "timed out"
            ? { timeout: 50 }
            : undefined,
      );
    }

    expect(received.get("forced")).toEqual([{ force: true }]);
    // Not `{ force: false }`: nothing at all, as before the option existed.
    expect(received.get("plain")).toEqual([]);
    expect(received.get("timed out")).toEqual([]);
  }, 20_000);

  it("does not let a target's close() that never resolves hang worker.close()", async () => {
    const { logger, events } = createTestLogger();
    let closeCalls = 0;
    const hung = () =>
      new Promise<void>(() => {
        closeCalls++;
      });
    const worker = new BunQueueWorker("custom-hang", async () => null, {
      namespace: testNamespace(),
      driver: new MemoryDriver(),
      logger,
      waitToExit: false,
      target: () => ({
        name: "never-drains",
        run: async () => null,
        close: hung,
      }),
    });
    void worker.run();

    const margin = DEFAULT_CLOSE_TIMEOUT + 3_000;
    const started = Date.now();
    let closedAt = 0;
    const [unbounded, outcome] = await Promise.all([
      // The negative control, side by side: the same close() awaited without
      // a bound is still pending when the bounded one has long returned — so
      // take the bound away and worker.close() would hang with it.
      Promise.race([
        hung().then(() => "resolved" as const),
        Bun.sleep(margin).then(() => "hung" as const),
      ]),
      Promise.race([
        worker.close().then(() => {
          closedAt = Date.now();
          return "closed" as const;
        }),
        Bun.sleep(margin).then(() => "hung" as const),
      ]),
    ]);

    expect(unbounded).toBe("hung");
    expect(outcome).toBe("closed");
    expect(closeCalls).toBe(2);
    // It waited out the bound, and no longer.
    expect(closedAt - started).toBeGreaterThanOrEqual(
      DEFAULT_CLOSE_TIMEOUT - 50,
    );
    expect(closedAt - started).toBeLessThan(margin);
    expect(
      events.some(
        (event) =>
          event.level === "warn" &&
          event.message.includes('"never-drains" did not close within'),
      ),
    ).toBe(true);
  }, 30_000);

  it("logs a target close() that rejects, and still closes", async () => {
    const { logger, events } = createTestLogger();
    const worker = new BunQueueWorker("custom-reject", async () => null, {
      namespace: testNamespace(),
      driver: new MemoryDriver(),
      logger,
      waitToExit: false,
      target: () => ({
        name: "breaks",
        run: async () => null,
        close: async () => {
          throw new Error("pool drain failed");
        },
      }),
    });
    void worker.run();
    await worker.close();
    expect(
      events.some(
        (event) =>
          event.level === "warn" &&
          event.message === 'Target "breaks" failed to close',
      ),
    ).toBe(true);
  });
});

/* --- the heartbeat record's target ---------------------------------------- */

/** A reporting worker on its own driver, and a way to read its record. */
function reporting(
  processor: string | (() => Promise<unknown>),
  target?: WorkerTarget,
) {
  const driver = new MemoryDriver();
  const namespace = testNamespace();
  const worker = new BunQueueWorker("reported", processor, {
    namespace,
    driver,
    logger: noopLogger,
    reportInterval: 40,
    pollInterval: 10,
    waitToExit: false,
    ...(target === undefined ? {} : { target }),
  });
  closers.push(() => worker.close({ force: true }));
  void worker.run();
  return {
    worker,
    async record(): Promise<WorkerInfo> {
      let found: WorkerInfo | undefined;
      await waitFor(
        async () => {
          found = (
            await driver.listWorkers(
              { ns: namespace, queue: "reported" },
              Date.now(),
            )
          ).find((info) => info.id === worker.id);
          return found !== undefined;
        },
        { timeout: 5_000, message: "the worker never reported" },
      );
      return found!;
    },
  };
}

describe("target: the heartbeat record", () => {
  const file = handler("job-double");

  it("describes every reachable pair of kind and processor", async () => {
    const cases: [
      string | (() => Promise<unknown>),
      WorkerTarget | undefined,
      WorkerInfo["target"],
    ][] = [
      [
        async () => null,
        undefined,
        { kind: "in-process", processor: "function" },
      ],
      [file, "in-process", { kind: "in-process", processor: "file", file }],
      [
        file,
        "worker-thread",
        { kind: "worker-thread", processor: "file", file },
      ],
      [
        file,
        { kind: "child-process", killTimeout: 100 },
        { kind: "child-process", processor: "file", file },
      ],
      [
        async () => null,
        () => ({ name: "grpc-pool", run: async () => null }),
        { kind: "custom", processor: "function", name: "grpc-pool" },
      ],
      [
        file,
        () => ({ name: "file-pool", run: async () => null }),
        { kind: "custom", processor: "file", name: "file-pool", file },
      ],
    ];

    for (const [processor, target, expected] of cases) {
      const { record } = reporting(processor, target);
      expect((await record()).target).toEqual(expected);
    }
  });

  it("serves the file path only with exposeProcessorFiles", async () => {
    const { record } = reporting(file, "child-process");
    const info = await record();

    expect(toWorkerDto(info, { exposeHosts: true }).target).toEqual({
      kind: "child-process",
      processor: "file",
    });
    expect(
      toWorkerDto(info, { exposeHosts: true, exposeProcessorFiles: false })
        .target,
    ).not.toHaveProperty("file");
    expect(
      toWorkerDto(info, { exposeHosts: true, exposeProcessorFiles: true })
        .target,
    ).toEqual({ kind: "child-process", processor: "file", file });
  });

  it("leaves target off a record from an older worker, rather than defaulting it", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace();
    const now = Date.now();
    // What a worker from before the field wrote.
    await driver.registerWorker(
      { ns, queue: "old" },
      {
        id: "old.1",
        queue: "old",
        host: "h",
        pid: 1,
        concurrency: 1,
        active: 0,
        paused: false,
        startedAt: now,
        heartbeatAt: now,
        expiresAt: now + 60_000,
      },
    );
    const [read] = await driver.listWorkers({ ns, queue: "old" }, now);

    expect("target" in read!).toBe(false);
    // Absent is "too old to say", never "in-process".
    const dto = toWorkerDto(read!, {
      exposeHosts: true,
      exposeProcessorFiles: true,
    });
    expect("target" in dto).toBe(false);
  });
});

describe("target: the worker's own getter", () => {
  const file = handler("job-double");

  /** Each kind a worker resolves, with the processor it takes. */
  const cases: [
    string,
    string | (() => Promise<unknown>),
    WorkerTarget | undefined,
    WorkerInfo["target"],
  ][] = [
    [
      "in-process, a function",
      async () => null,
      undefined,
      { kind: "in-process", processor: "function" },
    ],
    [
      "in-process, a file",
      file,
      "in-process",
      { kind: "in-process", processor: "file", file },
    ],
    [
      "worker-thread",
      file,
      "worker-thread",
      { kind: "worker-thread", processor: "file", file },
    ],
    [
      "child-process",
      file,
      { kind: "child-process", killTimeout: 100 },
      { kind: "child-process", processor: "file", file },
    ],
    [
      "custom, with its name",
      async () => null,
      () => ({ name: "grpc-pool", run: async () => null }),
      { kind: "custom", processor: "function", name: "grpc-pool" },
    ],
  ];

  for (const [label, processor, target, expected] of cases) {
    it(`equals what the heartbeat record reports (${label})`, async () => {
      const { worker, record } = reporting(processor, target);

      // Known before any report lands.
      expect(worker.target).toEqual(expected!);
      expect((await record()).target).toEqual(worker.target);
    });
  }

  it("cannot be changed through, so the record keeps what the worker does", async () => {
    const { worker, record } = reporting(file, "child-process");
    const described = worker.target;

    expect(Object.isFrozen(described)).toBe(true);
    // The same object every time, and the one the record carries.
    expect(worker.target).toBe(described);
    expect(() => {
      (described as { kind: string }).kind = "custom";
    }).toThrow(TypeError);
    expect(() => {
      delete (described as { file?: string }).file;
    }).toThrow(TypeError);

    expect((await record()).target).toEqual({
      kind: "child-process",
      processor: "file",
      file,
    });
  });
});

/* --- defineProcessors ------------------------------------------------------ */

describe("defineProcessors", () => {
  for (const mode of ["in-process", "child-process"] as const) {
    it(`dispatches on the job's name in one processor file (${mode})`, async () => {
      const { queue } = setup(mode, "job-registry");
      const double = await queue.add(
        "double",
        { n: 4 },
        { removeOnComplete: false },
      );
      const shout = await queue.add(
        "shout",
        { text: "hi" },
        { removeOnComplete: false },
      );
      const unknown = await queue.add(
        "whisper",
        {},
        { attempts: 3, removeOnFail: false },
      );

      await waitFor(
        async () =>
          (await queue.getJob(double.id))?.state === "completed" &&
          (await queue.getJob(shout.id))?.state === "completed" &&
          (await queue.getJob(unknown.id))?.state === "dead",
        { timeout: 20_000 },
      );

      const doubled = (await queue.getJob(double.id))?.returnValue as {
        doubled: number;
        pid: number;
      };
      expect(doubled.doubled).toBe(8);
      if (mode === "child-process") {
        expect(doubled.pid).not.toBe(process.pid);
      } else {
        expect(doubled.pid).toBe(process.pid);
      }
      expect((await queue.getJob(shout.id))?.returnValue).toBe("HI");
      // A name nothing defines is unrecoverable: one attempt of three, even
      // after crossing a process boundary.
      const dead = await queue.getJob(unknown.id);
      expect(dead?.attemptsMade).toBe(1);
      expect(dead?.failedReason?.name).toBe("UnrecoverableJobError");
      expect(dead?.failedReason?.message).toBe(
        'No processor is defined for "whisper" in this processor file',
      );
    }, 30_000);
  }

  it("takes jobs.definitions() and plain objects, and checks their shape", async () => {
    const defs = new JobDefinitions();
    defs.set({ name: "a", handler: async () => "A", options: {} });
    const fromRegistry = defineProcessors(defs);
    const fromList = defineProcessors([
      { name: "a", handler: async () => "first" },
      { name: "a", handler: async () => "later wins" },
    ]);
    const job = { name: "a" } as Job<unknown, unknown>;
    const ctx = {} as ProcessorContext;

    expect(await fromRegistry(job, ctx)).toBe("A");
    expect(await fromList(job, ctx)).toBe("later wins");
    expect(() =>
      defineProcessors([{ name: "", handler: async () => null }]),
    ).toThrow(ConfigError);
    expect(() =>
      defineProcessors([
        { name: "x", handler: "nope" } as unknown as {
          name: string;
          handler: () => Promise<null>;
        },
      ]),
    ).toThrow(ConfigError);
    await expect(
      fromList({ name: "b" } as Job<unknown, unknown>, ctx),
    ).rejects.toBeInstanceOf(UnrecoverableJobError);
  });
});
