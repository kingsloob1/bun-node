import type { BunQueueWorkerOptions, Job } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunQueue,
  BunQueueWorker,
  MemoryDriver,
  UnrecoverableJobError,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * The consuming side: claiming, retrying, timing out, recovering, and
 * shutting down without losing work.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.allSettled(closers.map((close) => close()));
  closers.length = 0;
});

/** A queue and a worker sharing one driver, both tracked for cleanup. */
function makePair<TData = any, TResult = any>(
  processor: (job: Job<TData, TResult>, ctx: any) => any,
  options: Partial<BunQueueWorkerOptions> = {},
): {
  queue: BunQueue<TData, TResult, string>;
  worker: BunQueueWorker<TData, TResult>;
} {
  const driver = new MemoryDriver();
  const namespace = testNamespace();

  const queue = new BunQueue<TData, TResult, string>("work", {
    namespace,
    driver,
    logger: noopLogger,
  });

  const worker = new BunQueueWorker<TData, TResult>("work", processor, {
    namespace,
    driver,
    logger: noopLogger,
    pollInterval: 10,
    maxBlock: 20,
    stalledInterval: 50,
    ...options,
  });

  closers.push(
    () => worker.close({ force: true }),
    () => queue.close(),
  );
  return { queue, worker };
}

describe("BunQueueWorker: processing", () => {
  it("claims a job, runs it and stores the result", async () => {
    const { queue, worker } = makePair(async (job) => ({
      doubled: (job.data as { n: number }).n * 2,
    }));

    void worker.run();
    const added = await queue.add("double", { n: 21 });

    const completed = await new Promise<Job<any, any>>((resolve) => {
      worker.once("completed", resolve);
    });

    expect(completed.id).toBe(added.id);
    const stored = await queue.getJob(added.id);
    expect(stored?.state).toBe("completed");
    expect(stored?.returnValue).toEqual({ doubled: 42 });
    expect(stored?.attemptsMade).toBe(1);
    expect(stored?.finishedOn).toBeGreaterThan(0);
  });

  it("gives the processor a context describing the attempt", async () => {
    /** What the processor saw, so the assertion reads what it wrote. */
    interface Seen {
      /** The id of the worker that ran the job. */
      workerId: string;
      /** Which attempt this was. */
      attempt: number;
      /** Whether the attempt started already aborted. */
      aborted: boolean;
    }

    const captured: Seen[] = [];

    const { queue, worker } = makePair(
      async (_job, ctx) => {
        captured.push({
          workerId: ctx.workerId,
          attempt: ctx.attempt,
          aborted: ctx.signal.aborted,
        });
        return null;
      },
      { id: "worker-1" },
    );

    void worker.run();
    await queue.add("inspect", {});
    await waitFor(() => captured.length > 0);

    expect(captured[0]).toEqual({
      workerId: "worker-1",
      attempt: 1,
      aborted: false,
    });
  });

  it("runs jobs in priority then FIFO order", async () => {
    const order: string[] = [];
    const { queue, worker } = makePair(async (job) => {
      order.push(job.name);
      return null;
    });

    await queue.add("normal-1", {});
    await queue.add("normal-2", {});
    await queue.add("urgent", {}, { priority: -10 });

    void worker.run();
    await waitFor(() => order.length === 3);

    expect(order).toEqual(["urgent", "normal-1", "normal-2"]);
  });

  it("processes up to its concurrency at once", async () => {
    let active = 0;
    let peak = 0;

    const { queue, worker } = makePair(
      async () => {
        active++;
        peak = Math.max(peak, active);
        await Bun.sleep(20);
        active--;
        return null;
      },
      { concurrency: 3 },
    );

    for (let i = 0; i < 6; i++) {
      await queue.add("slow", { i });
    }

    void worker.run();
    await waitFor(async () => (await queue.count("completed")) === 6, {
      timeout: 5000,
    });

    expect(peak).toBe(3);
  });

  it("records progress a processor reports", async () => {
    const { queue, worker } = makePair(async (job) => {
      await job.updateProgress({ percent: 50 });
      return null;
    });

    void worker.run();
    const added = await queue.add("progressive", {});

    await waitFor(async () => (await queue.count("completed")) === 1);
    expect((await queue.getJob(added.id))?.progress).toEqual({ percent: 50 });
  });
});

describe("BunQueueWorker: failure", () => {
  it("retries with backoff, then buries the job", async () => {
    let attempts = 0;
    const { queue, worker } = makePair(async () => {
      attempts++;
      throw new Error(`attempt ${attempts}`);
    });

    const retries: number[] = [];
    worker.on("retrying", (_job, _error, runAt) => retries.push(runAt));

    void worker.run();
    const added = await queue.add("flaky", {}, { attempts: 3, backoff: 10 });

    await waitFor(async () => (await queue.count("dead")) === 1, {
      timeout: 5000,
    });

    expect(attempts).toBe(3);
    expect(retries).toHaveLength(2);

    const stored = await queue.getJob(added.id);
    expect(stored?.state).toBe("dead");
    expect(stored?.attemptsMade).toBe(3);
    expect(stored?.failedReason?.message).toBe("attempt 3");
    // Stack traces accumulate newest-first, capped by keepStacktraces.
    expect(stored?.stacktrace).toHaveLength(3);
  });

  it("waits the backoff before the next attempt", async () => {
    const at: number[] = [];
    const { queue, worker } = makePair(async () => {
      at.push(Date.now());
      throw new Error("again");
    });

    void worker.run();
    await queue.add("slow-retry", {}, { attempts: 2, backoff: 120 });

    await waitFor(() => at.length === 2, { timeout: 5000 });
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(100);
  });

  it("buries an unrecoverable failure without retrying", async () => {
    let attempts = 0;
    const { queue, worker } = makePair(async () => {
      attempts++;
      throw new UnrecoverableJobError("the input is malformed");
    });

    void worker.run();
    const added = await queue.add("doomed", {}, { attempts: 5, backoff: 5 });

    await waitFor(async () => (await queue.count("dead")) === 1, {
      timeout: 5000,
    });

    // Five attempts were allowed; the job asked for none of them.
    expect(attempts).toBe(1);
    expect((await queue.getJob(added.id))?.failedReason?.message).toBe(
      "the input is malformed",
    );
  });

  it("aborts an attempt that outlives its timeout", async () => {
    let aborted = false;

    const { queue, worker } = makePair(async (_job, ctx) => {
      const until = Date.now() + 2000;
      while (Date.now() < until) {
        if (ctx.signal.aborted) {
          aborted = true;
          throw new Error("aborted");
        }
        await Bun.sleep(5);
      }
      return null;
    });

    void worker.run();
    const added = await queue.add("slow", {}, { timeout: 50, attempts: 1 });

    await waitFor(async () => (await queue.count("dead")) === 1, {
      timeout: 5000,
    });

    expect(aborted).toBe(true);
    expect((await queue.getJob(added.id))?.failedReason?.name).toBe(
      "JobTimeoutError",
    );
  });

  it("recovers a job whose worker died holding it", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();

    const queue = new BunQueue("work", {
      namespace,
      driver,
      logger: noopLogger,
    });
    closers.push(() => queue.close());

    const added = await queue.add("orphan", {}, { attempts: 3 });

    // Claim it and then vanish, as a killed process would.
    await driver.claimJob(queue.ref, {
      workerId: "ghost",
      token: "ghost-token",
      lockMs: 20,
      now: Date.now(),
    });
    expect(await queue.count("active")).toBe(1);

    const worker = new BunQueueWorker("work", async () => "recovered", {
      namespace,
      driver,
      logger: noopLogger,
      pollInterval: 10,
      stalledInterval: 30,
      lockDuration: 500,
    });
    closers.push(() => worker.close({ force: true }));

    const stalled = new Promise<string[]>((resolve) => {
      worker.once("stalled", resolve);
    });

    void worker.run();
    expect(await stalled).toEqual([added.id]);

    await waitFor(async () => (await queue.count("completed")) === 1, {
      timeout: 5000,
    });
    expect((await queue.getJob(added.id))?.stalledCount).toBe(1);
  });
});

describe("BunQueueWorker: control", () => {
  it("stops and starts claiming on request", async () => {
    const processed: string[] = [];
    const { queue, worker } = makePair(async (job) => {
      processed.push(job.name);
      return null;
    });

    void worker.run();
    await waitFor(() => worker.isRunning);

    await worker.pause();
    await queue.add("while-paused", {});
    await Bun.sleep(60);
    expect(processed).toEqual([]);

    worker.resume();
    await waitFor(() => processed.length === 1, { timeout: 5000 });
  });

  it("stops claiming when the queue is paused for everyone", async () => {
    const processed: string[] = [];
    const { queue, worker } = makePair(async (job) => {
      processed.push(job.name);
      return null;
    });

    await queue.pause();
    void worker.run();
    await queue.add("held", {});
    await Bun.sleep(80);
    expect(processed).toEqual([]);

    await queue.resume();
    await waitFor(() => processed.length === 1, { timeout: 5000 });
  });

  it("finishes what it started before closing", async () => {
    let finished = false;
    const { queue, worker } = makePair(async () => {
      await Bun.sleep(120);
      finished = true;
      return "done";
    });

    void worker.run();
    const added = await queue.add("in-flight", {});
    await waitFor(() => worker.activeCount === 1, { timeout: 5000 });

    await worker.close();

    expect(finished).toBe(true);
    expect((await queue.getJob(added.id))?.state).toBe("completed");
  });

  it("leaves a forced-out job to be recovered rather than lost", async () => {
    const { queue, worker } = makePair(async (_job, ctx) => {
      await Bun.sleep(5000);
      return ctx.signal.aborted ? "aborted" : "done";
    });

    void worker.run();
    const added = await queue.add("interrupted", {}, { attempts: 2 });
    await waitFor(() => worker.activeCount === 1, { timeout: 5000 });

    await worker.close({ force: true });

    // Still active with an expiring lock: the stalled sweep is what returns
    // it to the queue, so the job is never silently dropped.
    const stored = await queue.getJob(added.id);
    expect(["active", "waiting", "failed"]).toContain(stored?.state ?? "gone");
  });

  it("changes concurrency at runtime", async () => {
    const { worker } = makePair(async () => null, { concurrency: 1 });

    expect(worker.concurrency).toBe(1);
    worker.concurrency = 4;
    expect(worker.concurrency).toBe(4);
  });
});

describe("drainDelay", () => {
  /**
   * `drained` used to fire on every empty pass, which on an idle worker is
   * once per poll, forever — a heartbeat rather than an event. The option that
   * was meant to debounce it was resolved into the worker's options and never
   * read.
   */
  it("waits for quiet, and says so once", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();
    const worker = new BunQueueWorker("drain-delay", async () => null, {
      driver,
      namespace,
      logger: noopLogger,
      pollInterval: 5,
      maxBlock: 10,
      drainDelay: 150,
    });

    let drains = 0;
    worker.on("drained", () => drains++);

    try {
      void worker.run();

      // Well inside the delay: many empty passes, and none of them an event.
      await Bun.sleep(60);
      expect(drains).toBe(0);

      // Past it: exactly one, however many passes went by.
      await Bun.sleep(250);
      expect(drains).toBe(1);
    } finally {
      await worker.close({ force: true });
      await driver.close();
    }
  }, 15_000);

  it("starts a new quiet spell after work arrives", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();
    const queue = new BunQueue("drain-again", { driver, namespace });
    const worker = new BunQueueWorker("drain-again", async () => null, {
      driver,
      namespace,
      logger: noopLogger,
      pollInterval: 5,
      maxBlock: 10,
      drainDelay: 120,
    });

    let drains = 0;
    worker.on("drained", () => drains++);

    try {
      void worker.run();
      await Bun.sleep(200);
      expect(drains).toBe(1);

      // A job resets the spell, so the next quiet period is its own event
      // rather than a continuation of the first.
      await queue.add("work", {});
      await Bun.sleep(300);
      expect(drains).toBe(2);
    } finally {
      await worker.close({ force: true });
      await queue.close();
      await driver.close();
    }
  }, 15_000);
});
