import type { JobCounters, RunnerRunCounters } from "../lib/drivers/metrics";
import type {
  BunQueueWorkerOptions,
  BunRunnerOptions,
  Job,
  JobsDriver,
  RunRecord,
  TriggerOutcome,
} from "../lib/index";
import { join } from "node:path";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  MINUTE_BUCKET_MS,
  SECOND_BUCKET_MS,
} from "../lib/api/contract/constants";
import {
  bucketStart,
  JOB_COUNTERS,
  RUNNER_RUN_COUNTERS,
  totalCounters,
} from "../lib/drivers/metrics";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  BunRunner,
  createDriver,
  FileDriver,
  MemoryDriver,
  resolveDriver,
  SqlDriver,
} from "../lib/index";
import { runnerKey } from "../lib/shared/keys";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * The recording sites (W7): what a real runner and a real worker write into
 * the analytics buckets as they work — and, as importantly, what they never
 * let recording do to a run or a job.
 *
 * Every case runs against a real driver end to end. The ones that matter for
 * a buffered backend run against memory, the file driver and SQLite.
 */

const fixture = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  // Newest first: a worker closes before the driver it shares.
  for (const cleanup of cleanups.reverse()) {
    await cleanup().catch(() => undefined);
  }
  cleanups.length = 0;
});

const dirs: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(dirs.map((cleanup) => cleanup()));
});

/** The backends the end-to-end cases run against; none needs a server. */
const BACKENDS: {
  name: string;
  /** Whether it keeps per-second buckets (the file driver keeps minutes). */
  seconds: boolean;
  make: () => Promise<JobsDriver>;
}[] = [
  { name: "memory", seconds: true, make: async () => new MemoryDriver() },
  {
    name: "file",
    seconds: false,
    make: async () => {
      const tmp = await makeTmpDir("bun-jobs-w7-file");
      dirs.push(tmp.cleanup);
      return new FileDriver({ root: tmp.path, pollInterval: 10 });
    },
  },
  {
    name: "sqlite",
    seconds: true,
    make: async () => {
      const tmp = await makeTmpDir("bun-jobs-w7-sqlite");
      dirs.push(tmp.cleanup);
      return new SqlDriver({ url: `sqlite://${join(tmp.path, "jobs.db")}` });
    },
  },
];

/** A shared driver the test owns, closed after everything that uses it. */
async function sharedDriver(make: () => Promise<JobsDriver>) {
  const driver = await make();
  cleanups.push(async () => await driver.close());
  return driver;
}

/** A range covering the last ten minutes, as bucket starts. */
function recent(interval: number) {
  const now = Date.now();
  return {
    from: bucketStart(now - 10 * MINUTE_BUCKET_MS, interval),
    to: bucketStart(now + interval, interval),
    interval,
  };
}

/** A runner's series totals at one width, after the driver has written what it holds. */
async function runnerTotals(
  driver: JobsDriver,
  ns: string,
  id: string,
  interval = MINUTE_BUCKET_MS,
  options: { flush?: boolean } = {},
) {
  if (options.flush !== false) {
    await driver.flushMetrics?.();
  }
  const read = await driver.getRunnerMetrics!(ns, runnerKey(id), {
    ...recent(interval),
    durations: true,
  });
  return {
    read,
    runs: totalCounters<keyof RunnerRunCounters>(
      read.runs,
      RUNNER_RUN_COUNTERS,
    ),
    durations: (read.durations ?? []).reduce((sum, b) => sum + b.count, 0),
  };
}

/** A worker's series at one width, after the driver has written what it holds. */
async function workerSeries(
  driver: JobsDriver,
  ns: string,
  queue: string,
  key: string,
  interval = MINUTE_BUCKET_MS,
  options: { flush?: boolean } = {},
) {
  if (options.flush !== false) {
    await driver.flushMetrics?.();
  }
  const read = await driver.getWorkerMetrics!({ ns, queue }, key, {
    ...recent(interval),
    busyness: true,
  });
  return {
    read,
    jobs: totalCounters<keyof JobCounters>(read.jobs, JOB_COUNTERS),
    samples: (read.busyness ?? []).reduce((sum, b) => sum + b.samples, 0),
  };
}

/* --- runners ---------------------------------------------------------- */

/** An in-process runner over the outcome fixture, stopped after the test. */
function makeRunner(
  driver: JobsDriver,
  options: Partial<BunRunnerOptions<{ do?: string; ms?: number }>> = {},
) {
  const runner = new BunRunner<{ do?: string; ms?: number }>({
    id: "reports",
    namespace: testNamespace("w7"),
    file: fixture("outcome"),
    executionMode: "in-process",
    driver,
    logger: noopLogger,
    ...options,
  });
  cleanups.push(async () => await runner.stop({ force: true }));
  return runner;
}

/** Triggers a run and resolves with its record once it has settled. */
async function settle(
  runner: BunRunner<{ do?: string; ms?: number }>,
  args: { do?: string; ms?: number },
  during?: (outcome: TriggerOutcome) => Promise<void>,
): Promise<RunRecord> {
  const done = new Promise<RunRecord>((resolve) => {
    for (const event of ["finished", "failed", "timeout", "killed"] as const) {
      runner.once(event, (run: RunRecord) => resolve(run));
    }
  });
  const outcome = await runner.trigger({ args });
  await during?.(outcome);
  return await done;
}

describe("recording: runners", () => {
  for (const backend of BACKENDS) {
    it(`[${backend.name}] counts every settled run by outcome, with its duration`, async () => {
      const driver = await sharedDriver(backend.make);
      const runner = makeRunner(driver, { timeout: 0 });
      await runner.start();

      await settle(runner, { do: "ok" });
      await settle(runner, { do: "throw" });
      await settle(runner, { do: "sleep", ms: 5_000 }, async (outcome) => {
        // Skipped: single mode, a run in flight, nothing queued.
        expect((await runner.trigger()).outcome).toBe("skipped");
        await runner.kill((outcome as { runId: string }).runId);
      });

      const { runs, durations } = await runnerTotals(
        driver,
        runner.namespace,
        runner.id,
      );
      expect(runs).toEqual({
        started: 3,
        succeeded: 1,
        failed: 1,
        timeout: 0,
        killed: 1,
        skipped: 1,
      });
      // One duration per settled run: the finish carries it, a start does not.
      expect(durations).toBe(3);

      // The lifetime counters are untouched by the series beside them.
      expect(await runner.stats()).toMatchObject({
        total: 3,
        success: 1,
        failed: 2,
        killed: 1,
        skipped: 1,
      });
    });
  }

  it("counts a timeout under its own outcome, not under failed", async () => {
    const driver = await sharedDriver(async () => new MemoryDriver());
    const runner = makeRunner(driver, { timeout: 30 });
    await runner.start();

    const run = await settle(runner, { do: "sleep", ms: 5_000 });
    expect(run.status).toBe("timeout");

    const { runs, read } = await runnerTotals(
      driver,
      runner.namespace,
      runner.id,
    );
    expect(runs).toMatchObject({ started: 1, timeout: 1, failed: 0 });
    // Exact max: at least the timeout it outlived.
    expect(read.durations?.[0]?.maxMs).toBeGreaterThanOrEqual(30);
  });

  for (const backend of BACKENDS.filter((b) => b.seconds)) {
    it(`[${backend.name}] puts a run in the second it finished in, not the one it started in`, async () => {
      const driver = await sharedDriver(backend.make);
      const runner = makeRunner(driver);
      await runner.start();

      // Long enough to cross at least one second boundary.
      const run = await settle(runner, { do: "sleep", ms: 1_150 });
      const started = bucketStart(run.startedAt, SECOND_BUCKET_MS);
      const finished = bucketStart(run.finishedAt!, SECOND_BUCKET_MS);
      expect(finished).toBeGreaterThan(started);

      const { read } = await runnerTotals(
        driver,
        runner.namespace,
        runner.id,
        SECOND_BUCKET_MS,
      );
      const at = (ms: number) => read.runs.find((b) => b.at === ms);
      expect(at(started)).toMatchObject({ started: 1, succeeded: 0 });
      expect(at(finished)).toMatchObject({ started: 0, succeeded: 1 });

      const duration = read.durations?.find((b) => b.at === finished);
      expect(duration?.count).toBe(1);
      expect(duration?.minMs).toBe(run.durationMs!);
      expect(duration?.maxMs).toBe(run.durationMs!);
      expect(read.durations?.some((b) => b.at === started)).toBe(false);
    });
  }

  it("metrics: { runners: false } writes no series; the lifetime counters stay", async () => {
    const driver = await sharedDriver(async () => new MemoryDriver());
    const runner = makeRunner(driver, { metrics: { runners: false } });
    await runner.start();
    await settle(runner, { do: "ok" });

    const { runs } = await runnerTotals(driver, runner.namespace, runner.id);
    expect(runs.started + runs.succeeded).toBe(0);
    expect((await runner.stats()).success).toBe(1);
  });

  it("metrics: { durations: false } writes the outcomes and no durations", async () => {
    const driver = await sharedDriver(async () => new MemoryDriver());
    const calls: unknown[] = [];
    const count = driver.countRunnerRun!.bind(driver);
    driver.countRunnerRun = async (ns, runner, at, counts) => {
      calls.push(counts);
      await count(ns, runner, at, counts);
    };
    const runner = makeRunner(driver, { metrics: { durations: false } });
    await runner.start();
    await settle(runner, { do: "ok" });

    const { runs, durations } = await runnerTotals(
      driver,
      runner.namespace,
      runner.id,
    );
    expect(runs).toMatchObject({ started: 1, succeeded: 1 });
    expect(durations).toBe(0);
    expect(calls).toEqual([{ started: 1 }, { succeeded: 1 }]);
  });

  it("finishes a run exactly as before on a driver without the methods", async () => {
    const driver = await sharedDriver(async () => new MemoryDriver());
    Object.assign(driver, {
      countRunnerRun: undefined,
      flushMetrics: undefined,
    });
    const runner = makeRunner(driver);
    const errors: unknown[] = [];
    runner.on("error", (error) => errors.push(error));
    await runner.start();

    const run = await settle(runner, { do: "ok" });
    expect(run.status).toBe("success");
    await runner.stop();
    expect(errors).toEqual([]);
  });

  // The load-bearing one: capture must never change an outcome.
  for (const shape of ["throws", "rejects"] as const) {
    it(`never fails a run when the driver's countRunnerRun ${shape}, and logs it once`, async () => {
      const driver = await sharedDriver(async () => new MemoryDriver());
      const boom = new Error("metrics are down");
      driver.countRunnerRun =
        shape === "throws"
          ? () => {
              throw boom;
            }
          : async () => {
              throw boom;
            };
      driver.flushMetrics = async () => {
        throw boom;
      };
      const logs = createTestLogger();
      const runner = makeRunner(driver, { logger: logs.logger });
      const errors: unknown[] = [];
      runner.on("error", (error) => errors.push(error));
      await runner.start();

      const first = await settle(runner, { do: "ok" });
      const second = await settle(runner, { do: "throw" });
      await runner.stop();

      expect(first.status).toBe("success");
      expect(second.status).toBe("failed");
      const history = await runner.history();
      expect(history.map((run) => run.status).sort()).toEqual([
        "failed",
        "success",
      ]);
      expect(await runner.stats()).toMatchObject({
        total: 2,
        success: 1,
        failed: 1,
      });
      expect(errors).toEqual([]);
      const warned = logs.events.filter((event) =>
        event.message.includes("runner analytics"),
      );
      expect(warned).toHaveLength(1);
      expect(warned[0]!.level).toBe("warn");
    });
  }

  it("keeps the last second on stop, whether or not it owns the driver", async () => {
    // Read through a second driver on the same directory — another process's
    // view. Its reads flush only its own (empty) buffers, so the counts are on
    // disk only if the runner's stop flushed the shared driver it does not own.
    const tmp = await makeTmpDir("bun-jobs-w7-stop");
    dirs.push(tmp.cleanup);
    const driver = await sharedDriver(
      async () => new FileDriver({ root: tmp.path, pollInterval: 10 }),
    );
    const reader = await sharedDriver(
      async () => new FileDriver({ root: tmp.path, pollInterval: 10 }),
    );
    const runner = makeRunner(driver);
    await runner.start();
    const began = Date.now();
    await settle(runner, { do: "ok" });
    await runner.stop();

    const { runs } = await runnerTotals(reader, runner.namespace, runner.id);
    // Inside the buffer's one-second window, or its timer could have written it.
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(runs).toMatchObject({ started: 1, succeeded: 1 });
  });
});

/* --- workers ---------------------------------------------------------- */

interface WorkData {
  fail?: boolean;
  ms?: number;
}

/** A queue and a worker on one shared driver, both closed after the test. */
function makePair(
  driver: JobsDriver,
  options: Partial<BunQueueWorkerOptions> = {},
  namespace = testNamespace("w7"),
) {
  const queue = new BunQueue<WorkData>("work", {
    namespace,
    driver,
    logger: noopLogger,
  });
  const worker = new BunQueueWorker<WorkData>(
    "work",
    async (job: Job<WorkData>) => {
      if (job.data.ms) {
        await Bun.sleep(job.data.ms);
      }
      if (job.data.fail) {
        throw new Error("asked to fail");
      }
      return "done";
    },
    {
      namespace,
      driver,
      logger: noopLogger,
      pollInterval: 10,
      maxBlock: 20,
      waitToExit: false,
      ...options,
    },
  );
  cleanups.push(
    async () => await queue.close(),
    async () => await worker.close({ force: true }),
  );
  return { queue, worker, namespace };
}

/** Adds jobs and waits until the worker has settled every one of them. */
async function processJobs(
  queue: BunQueue<WorkData>,
  worker: BunQueueWorker<WorkData>,
  jobs: WorkData[],
) {
  let settled = 0;
  const onSettled = () => {
    settled += 1;
  };
  worker.on("completed", onSettled);
  worker.on("failed", onSettled);
  for (const data of jobs) {
    await queue.add("task", data, { attempts: 1 });
  }
  await waitFor(() => settled >= jobs.length, {
    timeout: 5_000,
    message: () => `settled ${settled} of ${jobs.length}`,
  });
  worker.off("completed", onSettled);
  worker.off("failed", onSettled);
}

describe("recording: workers", () => {
  for (const backend of BACKENDS) {
    it(`[${backend.name}] counts completions and failed attempts under the stable key`, async () => {
      const driver = await sharedDriver(backend.make);
      const { queue, worker, namespace } = makePair(driver);
      void worker.run();

      await processJobs(queue, worker, [
        {},
        {},
        {},
        { fail: true },
        { fail: true },
      ]);
      await worker.close();

      expect(worker.key).not.toBe(worker.id);
      const byKey = await workerSeries(driver, namespace, "work", worker.key);
      expect(byKey.jobs).toEqual({ completed: 3, failed: 2 });
      // Nothing under the incarnation's id.
      const byId = await workerSeries(driver, namespace, "work", worker.id);
      expect(byId.jobs).toEqual({ completed: 0, failed: 0 });
    });

    it(`[${backend.name}] continues one series across two incarnations of a key`, async () => {
      const driver = await sharedDriver(backend.make);
      const namespace = testNamespace("w7");

      const first = makePair(driver, {}, namespace);
      void first.worker.run();
      await processJobs(first.queue, first.worker, [{}, {}]);
      await first.worker.close();

      const second = makePair(driver, {}, namespace);
      void second.worker.run();
      await processJobs(second.queue, second.worker, [{}, {}, { fail: true }]);
      await second.worker.close();

      // A rolling redeploy: same key, new incarnation.
      expect(second.worker.key).toBe(first.worker.key);
      expect(second.worker.id).not.toBe(first.worker.id);

      const series = await workerSeries(
        driver,
        namespace,
        "work",
        first.worker.key,
      );
      expect(series.jobs).toEqual({ completed: 4, failed: 1 });
    });
  }

  it("puts the cumulative completed and failed on the heartbeat record", async () => {
    const driver = await sharedDriver(async () => new MemoryDriver());
    const { queue, worker } = makePair(driver, { reportInterval: 50 });
    void worker.run();
    await processJobs(queue, worker, [{}, {}, { fail: true }]);

    await waitFor(
      async () => {
        const [info] = await queue.listWorkers();
        return info?.completed === 2 && info.failed === 1;
      },
      { message: async () => JSON.stringify(await queue.listWorkers()) },
    );
  });

  it("samples busyness on each heartbeat, and an idle worker writes nothing else", async () => {
    const driver = await sharedDriver(async () => new MemoryDriver());
    const calls = { register: 0, sample: 0, count: 0 };
    const register = driver.registerWorker!.bind(driver);
    const sample = driver.sampleWorkerBusyness!.bind(driver);
    const count = driver.countWorkerJobs!.bind(driver);
    driver.registerWorker = async (...args) => {
      calls.register += 1;
      await register(...args);
    };
    driver.sampleWorkerBusyness = async (...args) => {
      calls.sample += 1;
      await sample(...args);
    };
    driver.countWorkerJobs = async (...args) => {
      calls.count += 1;
      await count(...args);
    };

    const { worker, namespace } = makePair(driver, {
      reportInterval: 100,
      concurrency: 3,
    });
    void worker.run();
    // Idle for longer than a second: a once-a-second timer would have fired.
    await Bun.sleep(1_300);
    await worker.close();

    expect(calls.count).toBe(0);
    expect(calls.sample).toBeGreaterThanOrEqual(5);
    // One sample per heartbeat written, and no other source of them.
    expect(calls.sample).toBe(calls.register);

    const series = await workerSeries(driver, namespace, "work", worker.key);
    expect(series.samples).toBe(calls.sample);
    expect(series.read.busyness?.at(-1)).toMatchObject({
      activeMax: 0,
      concurrency: 3,
    });
  });

  it("samples jobs in flight while the worker is busy", async () => {
    const driver = await sharedDriver(async () => new MemoryDriver());
    const { queue, worker, namespace } = makePair(driver, {
      reportInterval: 40,
      concurrency: 2,
    });
    void worker.run();
    await processJobs(queue, worker, [{ ms: 300 }, { ms: 300 }]);
    await worker.close();

    const series = await workerSeries(driver, namespace, "work", worker.key);
    const max = Math.max(
      ...(series.read.busyness ?? []).map((b) => b.activeMax),
    );
    expect(max).toBe(2);
  });

  it("metrics: { workers: false } writes no worker series, and keeps the record's counts", async () => {
    const driver = await sharedDriver(async () => new MemoryDriver());
    const calls = { sample: 0, count: 0 };
    driver.sampleWorkerBusyness = async () => {
      calls.sample += 1;
    };
    driver.countWorkerJobs = async () => {
      calls.count += 1;
    };
    const { queue, worker } = makePair(driver, {
      reportInterval: 30,
      metrics: { workers: false },
    });
    void worker.run();
    await processJobs(queue, worker, [{}, { fail: true }]);
    await waitFor(async () => (await queue.listWorkers())[0]?.completed === 1);
    await worker.close();

    expect(calls).toEqual({ sample: 0, count: 0 });
  });

  it("finishes every job exactly as before on a driver without the methods", async () => {
    const driver = await sharedDriver(async () => new MemoryDriver());
    Object.assign(driver, {
      countWorkerJobs: undefined,
      sampleWorkerBusyness: undefined,
      flushMetrics: undefined,
    });
    const { queue, worker } = makePair(driver, { reportInterval: 20 });
    const errors: unknown[] = [];
    worker.on("error", (error) => errors.push(error));
    void worker.run();
    await processJobs(queue, worker, [{}, { fail: true }]);
    await worker.close();

    expect(errors).toEqual([]);
    expect(await queue.count()).toMatchObject({ completed: 1, dead: 1 });
  });

  it("never lets a throwing driver reach a job or the error event, and logs it once", async () => {
    const driver = await sharedDriver(async () => new MemoryDriver());
    const boom = new Error("metrics are down");
    driver.countWorkerJobs = async () => {
      throw boom;
    };
    // Synchronously, inside the heartbeat report.
    driver.sampleWorkerBusyness = () => {
      throw boom;
    };
    driver.flushMetrics = async () => {
      throw boom;
    };
    const logs = createTestLogger();
    const { queue, worker } = makePair(driver, {
      reportInterval: 20,
      logger: logs.logger,
    });
    const errors: unknown[] = [];
    worker.on("error", (error) => errors.push(error));
    void worker.run();

    await processJobs(queue, worker, [{}, {}, { fail: true }]);
    // Long enough for the count buffer to flush and for several reports.
    await Bun.sleep(1_200);
    await worker.close();

    expect(await queue.count()).toMatchObject({ completed: 2, dead: 1 });
    expect(errors).toEqual([]);
    const warned = logs.events.filter((event) =>
      event.message.includes("worker analytics"),
    );
    expect(warned).toHaveLength(1);
  });

  it("keeps the last second on close, whether or not it owns the driver", async () => {
    const driver = await sharedDriver(async () => new MemoryDriver());
    const { queue, worker, namespace } = makePair(driver);
    void worker.run();
    const began = Date.now();
    await processJobs(queue, worker, [{}, {}]);
    await worker.close();

    const series = await workerSeries(
      driver,
      namespace,
      "work",
      worker.key,
      MINUTE_BUCKET_MS,
      {
        flush: false,
      },
    );
    // Inside the worker's one-second window, or its timer could have written it.
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(series.jobs).toEqual({ completed: 2, failed: 0 });
  });
});

/* --- options ---------------------------------------------------------- */

describe("recording: the metrics option", () => {
  it("reaches a driver built from a config, unless the config names its own", async () => {
    const minute = createDriver({
      type: "memory",
      metrics: { resolution: "minute" },
    });
    expect(minute.getMetricsSupport!().resolutions).toEqual([60]);

    const given = resolveDriver({ type: "memory" }, { workers: false });
    expect(given.owned).toBe(true);
    expect(given.driver.getMetricsSupport!().recording.workers).toBe(false);

    const own = resolveDriver(
      { type: "memory", metrics: { workers: true } },
      { workers: false },
    );
    expect(own.driver.getMetricsSupport!().recording.workers).toBe(true);

    const none = resolveDriver(undefined, { secondRetentionMs: 60_000 });
    expect(none.driver.getMetricsSupport!().retentionMs[1]).toBe(60_000);

    const instance = new MemoryDriver();
    const shared = resolveDriver(instance, { workers: false });
    expect(shared.driver).toBe(instance);
    expect(shared.owned).toBe(false);
    expect(instance.getMetricsSupport!().recording.workers).toBe(true);

    const tmp = await makeTmpDir("bun-jobs-w7-config");
    dirs.push(tmp.cleanup);
    const file = createDriver({
      type: "file",
      root: tmp.path,
      metrics: { runners: false },
    });
    expect(file.getMetricsSupport!().recording.runners).toBe(false);
    await Promise.all(
      [minute, given.driver, own.driver, none.driver, file].map((d) =>
        d.close(),
      ),
    );
  });

  it("BunJobs hands it to its driver and under every runner and worker", async () => {
    const jobs = new BunJobs({
      namespace: testNamespace("w7"),
      driver: { type: "memory" },
      logger: noopLogger,
      metrics: { workers: false, resolution: "minute" },
    });
    cleanups.push(async () => await jobs.close());

    expect(jobs.driver.getMetricsSupport!().resolutions).toEqual([60]);
    expect(jobs.driver.getMetricsSupport!().recording.workers).toBe(false);

    const worker = jobs.worker("work", async () => "ok", {
      // More specific, and still does not undo the context's `workers: false`.
      metrics: { durations: false },
    });
    const calls = { count: 0 };
    const count = jobs.driver.countWorkerJobs!.bind(jobs.driver);
    jobs.driver.countWorkerJobs = async (...args) => {
      calls.count += 1;
      await count(...args);
    };
    void worker.run();
    await jobs.queue("work").add("task", {});
    await waitFor(
      async () => (await jobs.queue("work").count()).completed === 1,
    );
    await worker.close();
    expect(calls.count).toBe(0);

    const runner = jobs.runner({
      id: "nightly",
      file: fixture("outcome"),
      executionMode: "in-process",
      metrics: { runners: false },
    });
    expect(runner.options.metrics).toMatchObject({
      workers: false,
      runners: false,
      resolution: "minute",
    });
  });
});

/* --- the lock handoff these cases exposed ------------------------------ */

/**
 * Back-to-back triggers — the next one fired the moment the last run's event
 * arrives — race the drain that releases the single-run lock. On the file
 * driver the counts case above hung about once in ten runs: the trigger came
 * back `skipped: lock-held` from this very instance's lock. Both windows are
 * forced open here with gates, so neither case depends on timing.
 */
describe("single-run lock: a trigger racing the drain's release", () => {
  /** Resolves when opened; the gate a wrapped driver method waits on. */
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  }

  it("waits for its own release in flight instead of reporting lock-held", async () => {
    const driver = await sharedDriver(async () => new MemoryDriver());
    const release = driver.releaseLock.bind(driver);
    const parked = gate();
    let releasing = false;
    driver.releaseLock = async (...args) => {
      releasing = true;
      await parked.opened;
      return await release(...args);
    };
    const runner = makeRunner(driver);
    await runner.start();

    await settle(runner, { do: "ok" });
    await waitFor(() => releasing, { message: "the drain never released" });

    // The token is gone, the lock is not: an acquire now would be refused.
    const triggered = runner.trigger({ args: { do: "ok" } });
    await Bun.sleep(0);
    parked.open();

    expect((await triggered).outcome).toBe("started");
  });

  it("does not release the lock under a trigger that is reusing it", async () => {
    const driver = await sharedDriver(async () => new MemoryDriver());
    const renew = driver.renewLock.bind(driver);
    const release = driver.releaseLock.bind(driver);
    const pop = driver.popQueuedTrigger.bind(driver);
    const parked = gate();
    let renewing = false;
    let drained = 0;
    let releasedDuringRenew = false;
    driver.renewLock = async (...args) => {
      renewing = true;
      await parked.opened;
      renewing = false;
      return await renew(...args);
    };
    driver.releaseLock = async (...args) => {
      releasedDuringRenew ||= renewing;
      return await release(...args);
    };
    driver.popQueuedTrigger = async (...args) => {
      const taken = await pop(...args);
      drained += 1;
      return taken;
    };
    const runner = makeRunner(driver);
    await runner.start();

    let second: Promise<TriggerOutcome> | undefined;
    runner.once("finished", () => {
      // Synchronously from the event, ahead of the drain that follows it.
      second = runner.trigger({ args: { do: "ok" } });
    });
    await settle(runner, { do: "ok" });
    // The drain has read an empty queue; its release decision is next.
    await waitFor(() => drained > 0);
    await new Promise((resolve) => setImmediate(resolve));
    parked.open();

    expect((await second!).outcome).toBe("started");
    expect(releasedDuringRenew).toBe(false);

    // And the lock is let go once that run is done, so a third can start.
    await waitFor(
      async () =>
        (await driver.getLock(
          runner.namespace,
          runnerKey(runner.id),
          Date.now(),
        )) === null,
    );
    expect((await settle(runner, { do: "ok" })).status).toBe("success");
  });
});
