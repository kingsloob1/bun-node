import type { Job, JobsDriver } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueue, BunQueueWorker, MemoryDriver } from "../lib/index";
import { makeJob, testNamespace, waitFor } from "./helpers";

/**
 * C8: an empty pass reads the next due time from the promotion it runs (step
 * 1), and skips the promotion while a remembered due time is still in the
 * future (step 2). The bound step 2 accepts: a job another process schedules
 * earlier is promoted by the sweep, within its cadence (a second at most),
 * rather than by the next empty pass.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.allSettled(closers.map(async (close) => await close()));
  closers.length = 0;
});

/** Counts the schedule reads and writes a driver is asked for, by caller-visible name. */
function spyOnSchedule(driver: JobsDriver): {
  promotions: number[];
  nextDelayedAt: number[];
} {
  const promotions: number[] = [];
  const nextDelayedAt: number[] = [];
  const promote = driver.promoteDelayed.bind(driver);
  const next = driver.nextDelayedAt.bind(driver);
  driver.promoteDelayed = async (q, now, limit) => {
    promotions.push(Date.now());
    return await promote(q, now, limit);
  };
  driver.nextDelayedAt = async (q) => {
    nextDelayedAt.push(Date.now());
    return await next(q);
  };
  return { promotions, nextDelayedAt };
}

/** A queue and a worker on `driver`, both closed after the case. */
function setup(
  driver: JobsDriver,
  processor: (job: Job<{ n: number }>) => Promise<void>,
  options: { pollInterval?: number } = {},
) {
  const namespace = testNamespace("idle");
  const queue = new BunQueue<{ n: number }>("idle", {
    namespace,
    driver,
    logger: noopLogger,
    defaultJobOptions: { removeOnComplete: true },
  });
  const worker = new BunQueueWorker<{ n: number }>("idle", processor, {
    namespace,
    driver,
    logger: noopLogger,
    concurrency: 1,
    metrics: { workers: false },
    waitToExit: false,
    ...options,
  });
  closers.push(
    async () => await worker.close({ force: true }),
    async () => await queue.close(),
  );
  return { queue, worker };
}

describe("BunQueueWorker: idle pass (C8)", () => {
  it("asks the driver nothing about the schedule on an empty pass after a completion", async () => {
    const driver = new MemoryDriver();
    const spy = spyOnSchedule(driver);
    let done = 0;
    const { queue, worker } = setup(driver, async () => {
      done += 1;
    });
    worker.run().catch(() => {});
    await Bun.sleep(20);

    // One job at a time, each added once the last has finished: every
    // completion is followed by an empty pass.
    const startedAt = Date.now();
    const promotionsBefore = spy.promotions.length;
    const nextBefore = spy.nextDelayedAt.length;
    const rounds = 50;
    for (let n = 0; n < rounds; n++) {
      await queue.add("round", { n });
      await waitFor(() => done === n + 1, { timeout: 5_000 });
    }
    const elapsed = Date.now() - startedAt;

    // The sweep's own calls only: one a second, plus the one it makes as it
    // is armed. Before C8 each of the 50 empty passes added a promotion and a
    // `nextDelayedAt`.
    expect(spy.nextDelayedAt.length - nextBefore).toBe(0);
    expect(spy.promotions.length - promotionsBefore).toBeLessThanOrEqual(
      Math.ceil(elapsed / 1_000) + 1,
    );
  });

  it("promotes a delayed job another producer adds within the sweep's bound", async () => {
    // The worker's driver never hears of the job: it is written straight to
    // the store, as another process's queue would, so nothing tells the
    // worker's remembered due time (none) that it changed.
    const driver = new MemoryDriver();
    const ran: { n: number; at: number }[] = [];
    const { queue, worker } = setup(driver, async (job) => {
      ran.push({ n: job.data.n, at: Date.now() });
    });
    worker.run().catch(() => {});
    await Bun.sleep(50);

    const dueAt = Date.now() + 100;
    await driver.addJob(
      queue.ref,
      makeJob({
        id: "elsewhere",
        name: "elsewhere",
        data: { n: 1 },
        state: "delayed",
        runAt: dueAt,
      }),
    );

    // The sweep runs every `min(pollInterval, 1s)` — 1s here — whatever the
    // worker remembers, so the job runs at most that long after it is due,
    // plus the poll interval's worth of slack for the claim.
    await waitFor(() => ran.length === 1, { timeout: 3_000 });
    expect(ran[0]?.at).toBeGreaterThanOrEqual(dueAt);
    expect(ran[0]!.at - dueAt).toBeLessThan(1_000 + 1_000);
  });

  it("does not hold back a delayed job this process schedules through the same driver", async () => {
    // The worker is busy when the job is added, so the pass after it reads
    // the remembered due time — none, from the sweep that ran as the worker
    // started. Only the note the queue leaves makes that pass promote; without
    // it the job waits for the next sweep, about a second after the start.
    const driver = new MemoryDriver();
    const ran: { n: number; at: number }[] = [];
    let queueRef: BunQueue<{ n: number }> | undefined;
    const { queue, worker } = setup(driver, async (job) => {
      ran.push({ n: job.data.n, at: Date.now() });
      if (job.data.n === 1) {
        await Bun.sleep(50);
        await queueRef!.add("later", { n: 2 }, { delay: 20 });
        await Bun.sleep(250);
      }
    });
    queueRef = queue;

    await queue.add("first", { n: 1 });
    const startedAt = Date.now();
    worker.run().catch(() => {});

    await waitFor(() => ran.length === 2, { timeout: 3_000 });
    const [first, second] = ran;
    // It ran as soon as the first job let go of the only slot (~300ms), not at
    // the sweep a second after the start.
    expect(second!.n).toBe(2);
    expect(second!.at - first!.at).toBeLessThan(600);
    expect(second!.at - startedAt).toBeLessThan(800);
  });

  it("falls back to nextDelayedAt for a driver that answers promoteDelayed with a count", async () => {
    // Typed as the contract, which still allows the bare count.
    const driver: JobsDriver = new MemoryDriver();
    const promote = driver.promoteDelayed.bind(driver);
    // The older contract: the count alone.
    driver.promoteDelayed = async (q, now, limit) => {
      const result = await promote(q, now, limit);
      return typeof result === "number" ? result : result.promoted;
    };
    const spy = spyOnSchedule(driver);
    const ran: number[] = [];
    const { queue, worker } = setup(
      driver,
      async (job) => {
        ran.push(job.data.n);
      },
      { pollInterval: 1_000 },
    );
    worker.run().catch(() => {});
    await Bun.sleep(20);

    const addedAt = Date.now();
    await queue.add("round", { n: 1 });
    await waitFor(() => ran.length === 1, { timeout: 2_000 });
    await queue.add("delayed", { n: 2 }, { delay: 150 });
    await waitFor(() => ran.length === 2, { timeout: 3_000 });

    expect(spy.nextDelayedAt.length).toBeGreaterThan(0);
    expect(Date.now() - addedAt).toBeLessThan(2_000);
  });
});
