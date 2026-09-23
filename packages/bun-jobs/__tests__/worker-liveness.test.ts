import type { QueueRef, WorkerInfo } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { toWorkerDto } from "../lib/api/serialize";
import { BunQueue, BunQueueWorker, MemoryDriver } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * `maintenance` is two different things, and only one of them may be turned
 * off.
 *
 * **Liveness** — promoting delayed jobs, recovering stalled ones and healing
 * flows — is what keeps a queue moving at all. Each is the only thing that
 * moves a particular kind of stuck job, and a queue whose only worker had
 * them off stranded all three: observed in a real playground as a job
 * `active` for forty-five minutes and four jobs frozen at attempt 1 of 2. So
 * every worker does them, whatever `maintenance` says.
 *
 * **Housekeeping** — the minute timer: pruning expired results, healing
 * repeat series, and the two queue-state sweeps — is tidying. Nothing stalls
 * while it waits, so `maintenance: false` still opts out of it, and the
 * worker's record says so through `sweeps`.
 */

/** Cleanups to run after each test. */
const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.allSettled(closers.map((close) => close()));
  closers.length = 0;
});

/** A memory driver that counts the calls the housekeeping sweeps make. */
class CountingDriver extends MemoryDriver {
  /** How many times each counted method has been called. */
  readonly calls = {
    /** The expiry prune, from the minute sweep. */
    pruneExpired: 0,
    /** The repeat heal, from the minute sweep. */
    listRepeats: 0,
    /** Both queue-state sweeps: windows and worker controls. */
    listQueueState: 0,
    /**
     * Reads of the flow heal's lease (`__win:fheal`). Flow healing is
     * liveness — a parent that never heals never advances — and the lease is
     * how one worker per queue does it, so contending for it is how a worker
     * takes part. Every worker pays this read, opted out or not.
     */
    flowHealLease: 0,
    /** Liveness: the delayed promotion. */
    promoteDelayed: 0,
    /** Liveness: the stalled sweep. */
    recoverStalled: 0,
  };

  override async pruneExpired(
    ...args: Parameters<MemoryDriver["pruneExpired"]>
  ): Promise<number> {
    this.calls.pruneExpired++;
    return await super.pruneExpired(...args);
  }

  override async listRepeats(
    ...args: Parameters<MemoryDriver["listRepeats"]>
  ): ReturnType<MemoryDriver["listRepeats"]> {
    this.calls.listRepeats++;
    return await super.listRepeats(...args);
  }

  override async listQueueState(
    ...args: Parameters<MemoryDriver["listQueueState"]>
  ): ReturnType<MemoryDriver["listQueueState"]> {
    this.calls.listQueueState++;
    return await super.listQueueState(...args);
  }

  override async getQueueState(
    ...args: Parameters<MemoryDriver["getQueueState"]>
  ): ReturnType<MemoryDriver["getQueueState"]> {
    if (args[1] === "__win:fheal") {
      this.calls.flowHealLease++;
    }
    return await super.getQueueState(...args);
  }

  override async promoteDelayed(
    ...args: Parameters<MemoryDriver["promoteDelayed"]>
  ): ReturnType<MemoryDriver["promoteDelayed"]> {
    this.calls.promoteDelayed++;
    return await super.promoteDelayed(...args);
  }

  override async recoverStalled(
    ...args: Parameters<MemoryDriver["recoverStalled"]>
  ): ReturnType<MemoryDriver["recoverStalled"]> {
    this.calls.recoverStalled++;
    return await super.recoverStalled(...args);
  }
}

describe("liveness is not optional: maintenance: false", () => {
  it("still promotes a delayed retry, so an attempt that failed runs again", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("live-promote");
    const queue = new BunQueue<{ n: number }, string, string>("work", {
      namespace,
      driver,
      logger: noopLogger,
    });
    closers.push(() => queue.close());

    const attempts: number[] = [];
    const worker = new BunQueueWorker<{ n: number }, string>(
      "work",
      async (job) => {
        // `attemptsMade` counts the attempt in progress, so it reads 1 then 2.
        attempts.push(job.attemptsMade);
        if (attempts.length === 1) {
          throw new Error("first attempt fails");
        }
        return "second attempt runs";
      },
      {
        namespace,
        driver,
        logger: noopLogger,
        pollInterval: 10,
        maxBlock: 20,
        // The whole point: the queue's only worker leaves maintenance alone.
        maintenance: false,
      },
    );
    closers.push(() => worker.close({ force: true }));

    void worker.run();
    const added = await queue.add(
      "retry",
      { n: 1 },
      { attempts: 2, backoff: { type: "fixed", delay: 100 } },
    );

    // Without liveness the retry sits `delayed` for ever: nothing on this
    // worker promotes it, and there is no other worker.
    await waitFor(async () => (await queue.count("completed")) === 1, {
      timeout: 5_000,
      message: async () =>
        `still ${await queue.count("delayed")} delayed, ${attempts.length} attempts made`,
    });

    expect(attempts).toEqual([1, 2]);
    expect((await queue.getJob(added.id))?.state).toBe("completed");
  });

  it("still recovers a job whose worker died", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("live-stalled");
    const queue = new BunQueue<{ n: number }, string, string>("work", {
      namespace,
      driver,
      logger: noopLogger,
    });
    closers.push(() => queue.close());

    const added = await queue.add("stall", { n: 1 });

    // Claimed by a process that then vanished, as a kill -9 leaves it.
    await driver.claimJob(queue.ref, {
      workerId: "ghost",
      token: "ghost-token",
      lockMs: 20,
      now: Date.now(),
    });
    expect(await queue.count("active")).toBe(1);

    const worker = new BunQueueWorker<{ n: number }, string>(
      "work",
      async () => "recovered",
      {
        namespace,
        driver,
        logger: noopLogger,
        pollInterval: 10,
        stalledInterval: 30,
        lockDuration: 500,
        maintenance: false,
      },
    );
    closers.push(() => worker.close({ force: true }));

    const stalled = new Promise<string[]>((resolve) => {
      worker.once("stalled", resolve);
    });

    void worker.run();
    expect(await stalled).toEqual([added.id]);

    await waitFor(async () => (await queue.count("completed")) === 1, {
      timeout: 5_000,
    });
    expect((await queue.getJob(added.id))?.stalledCount).toBe(1);
  });

  it("does no housekeeping, so the opt-out still means something", async () => {
    const driver = new CountingDriver();
    const namespace = testNamespace("live-nohouse");
    const queue = new BunQueue<{ n: number }, string, string>("work", {
      namespace,
      driver,
      logger: noopLogger,
    });
    closers.push(() => queue.close());

    const worker = new BunQueueWorker<{ n: number }, string>(
      "work",
      async () => "done",
      {
        namespace,
        driver,
        logger: noopLogger,
        pollInterval: 10,
        maxBlock: 20,
        stalledInterval: 30,
        reportInterval: 0,
        maintenance: false,
      },
    );
    closers.push(() => worker.close({ force: true }));

    void worker.run();
    // Long enough for the first pass of every sweep: each is run once
    // immediately on arming, and the stalled sweep again at 30ms.
    await waitFor(() => driver.calls.recoverStalled >= 2, { timeout: 5_000 });
    await queue.add("x", { n: 1 });
    await waitFor(async () => (await queue.count("completed")) === 1, {
      timeout: 5_000,
    });

    // Liveness ran, flow healing included: the worker still contends for the
    // heal's lease, which is what taking part in it means.
    expect(driver.calls.recoverStalled).toBeGreaterThan(0);
    expect(driver.calls.promoteDelayed).toBeGreaterThan(0);
    expect(driver.calls.flowHealLease).toBeGreaterThan(0);
    // Housekeeping did not: no prune, no repeat heal, and neither
    // queue-state sweep. That is the whole of what the option decides — the
    // minute timer — and it was never armed.
    expect(driver.calls.pruneExpired).toBe(0);
    expect(driver.calls.listRepeats).toBe(0);
    expect(driver.calls.listQueueState).toBe(0);
  });

  it("leaves the default worker doing both", async () => {
    const driver = new CountingDriver();
    const namespace = testNamespace("live-default");
    const queue = new BunQueue<{ n: number }, string, string>("work", {
      namespace,
      driver,
      logger: noopLogger,
    });
    closers.push(() => queue.close());

    const worker = new BunQueueWorker<{ n: number }, string>(
      "work",
      async () => "done",
      {
        namespace,
        driver,
        logger: noopLogger,
        pollInterval: 10,
        maxBlock: 20,
        stalledInterval: 30,
        reportInterval: 0,
      },
    );
    closers.push(() => worker.close({ force: true }));

    void worker.run();
    await waitFor(
      () =>
        driver.calls.pruneExpired > 0 &&
        driver.calls.listRepeats > 0 &&
        driver.calls.listQueueState > 0 &&
        driver.calls.recoverStalled > 0 &&
        driver.calls.promoteDelayed > 0 &&
        driver.calls.flowHealLease > 0,
      {
        timeout: 5_000,
        message: () => JSON.stringify(driver.calls),
      },
    );
  });
});

/** A worker that reports fast, with nothing to do, closed after the test. */
function reportingWorker(
  driver: MemoryDriver,
  namespace: string,
  options: { maintenance?: boolean } = {},
): BunQueueWorker<unknown, unknown> {
  const worker = new BunQueueWorker<unknown, unknown>(
    "work",
    async () => null,
    {
      namespace,
      driver,
      logger: noopLogger,
      pollInterval: 10,
      maxBlock: 20,
      reportInterval: 40,
      waitToExit: false,
      ...(options.maintenance === undefined
        ? {}
        : { maintenance: options.maintenance }),
    },
  );
  closers.push(() => worker.close({ force: true }));
  void worker.run();
  return worker;
}

/** The first live record for `id`, once one exists. */
async function recordFor(
  driver: MemoryDriver,
  q: QueueRef,
  id: string,
): Promise<WorkerInfo> {
  let found: WorkerInfo | undefined;
  await waitFor(
    async () => {
      found = (await driver.listWorkers(q, Date.now())).find(
        (info) => info.id === id,
      );
      return found !== undefined;
    },
    { timeout: 5_000 },
  );
  return found!;
}

describe("the worker record's sweeps", () => {
  it("is true on a worker that sweeps and false on one that does not", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("sweeps-flag");
    const q: QueueRef = { ns: namespace, queue: "work" };

    const sweeper = reportingWorker(driver, namespace);
    const idler = reportingWorker(driver, namespace, { maintenance: false });

    expect((await recordFor(driver, q, sweeper.id)).sweeps).toBe(true);
    expect((await recordFor(driver, q, idler.id)).sweeps).toBe(false);
  });

  it("reaches the API's DTO both ways", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("sweeps-dto");
    const q: QueueRef = { ns: namespace, queue: "work" };
    const now = Date.now();

    const sweeper = reportingWorker(driver, namespace);
    const idler = reportingWorker(driver, namespace, { maintenance: false });

    const on = toWorkerDto(
      await recordFor(driver, q, sweeper.id),
      { exposeHosts: true },
      now,
    );
    const off = toWorkerDto(
      await recordFor(driver, q, idler.id),
      { exposeHosts: true },
      now,
    );

    expect(on.sweeps).toBe(true);
    expect(off.sweeps).toBe(false);
  });

  it("reads a record written without it as absent, not false", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("sweeps-older");
    const now = Date.now();
    // What a worker from before the field wrote. Absent means "too old to
    // say", which is not the same answer as "does not sweep" — a reader
    // warning about a queue with no sweeper must not warn on this.
    const older: WorkerInfo = {
      id: "work.old",
      key: "work",
      queue: "work",
      host: "test-host",
      pid: 4_242,
      concurrency: 1,
      active: 0,
      paused: false,
      startedAt: now - 1_000,
      heartbeatAt: now,
      expiresAt: now + 60_000,
    };
    await driver.registerWorker({ ns, queue: "work" }, older);

    const [read] = await driver.listWorkers({ ns, queue: "work" }, now);
    expect(read!.sweeps).toBeUndefined();
    expect("sweeps" in read!).toBe(false);

    const dto = toWorkerDto(read!, { exposeHosts: true }, now);
    expect("sweeps" in dto).toBe(false);
  });
});
