import type { QueueRef } from "../lib/drivers/driver";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueue, BunQueueWorker, MemoryDriver } from "../lib/index";
import { testNamespace } from "./helpers";

/**
 * The idle wait's 1ms floor is for a driver that keeps answering at once with
 * nothing claimable, not for a job that arrived a moment ago.
 *
 * After the fix round, a full worker woke on its slot a few microtasks
 * sooner (B1's `Pulse`), so on the memory driver it reached its next claim
 * before a producer reacting to the completion had added the next job: the
 * claim came back empty, the wait found the job already there and answered at
 * once, and the floor charged that round trip a millisecond. That was a third
 * of all round trips, p90 92µs -> 1.15ms on a backend with no I/O. The floor
 * now applies only to the second instant answer in a row.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.allSettled(closers.map((close) => close()));
  closers.length = 0;
});

/**
 * Counts the 1ms timers started while `run` executes: the idle floor is the
 * only thing on these paths that asks for exactly one millisecond.
 */
async function countOneMsTimers(run: () => Promise<void>): Promise<number> {
  const original = globalThis.setTimeout;
  let count = 0;
  const counting = ((...args: Parameters<typeof setTimeout>) => {
    if (args[1] === 1) {
      count += 1;
    }
    return original(...args);
  }) as typeof setTimeout;
  globalThis.setTimeout = counting;

  try {
    await run();
  } finally {
    globalThis.setTimeout = original;
  }

  return count;
}

describe("BunQueueWorker: idle floor", () => {
  it("does not sleep the floor when the next job arrives as the last one finishes", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();
    // A padded payload, as the round-trip benchmark sends: the producer's add
    // takes long enough that the woken worker's claim comes first.
    const pad = "x".repeat(4096);
    const queue = new BunQueue<{ seq: number; pad: string }>("rt", {
      namespace,
      driver,
      logger: noopLogger,
      defaultJobOptions: { attempts: 1, removeOnComplete: true },
    });

    let pending: { seq: number; settle: () => void } | null = null;
    const worker = new BunQueueWorker<{ seq: number; pad: string }>(
      "rt",
      (job) => {
        if (pending && job.data.seq === pending.seq) {
          const { settle } = pending;
          pending = null;
          settle();
        }
      },
      {
        namespace,
        driver,
        logger: noopLogger,
        concurrency: 1,
        autorun: false,
        metrics: { workers: false },
      },
    );
    closers.push(
      () => worker.close({ force: true }),
      () => queue.close(),
    );
    worker.run().catch(() => {});
    await Bun.sleep(20);

    /** Adds one job and resolves when the worker has run it. */
    async function roundTrip(seq: number): Promise<void> {
      const arrived = new Promise<void>((resolve) => {
        pending = { seq, settle: resolve };
      });
      await queue.add("rt", { seq, pad });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expiry = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`job ${seq} lost`)), 10_000);
      });
      try {
        await Promise.race([arrived, expiry]);
      } finally {
        clearTimeout(timer);
      }
    }

    for (let seq = 0; seq < 5; seq++) {
      await roundTrip(seq);
    }

    const rounds = 200;
    const floors = await countOneMsTimers(async () => {
      for (let seq = 0; seq < rounds; seq++) {
        await roundTrip(seq);
      }
    });

    // Measured on the unfixed worker: 40 floors in these 200 round trips (68
    // in 205 in the benchmark). Now 0; the bound leaves room for a genuinely
    // empty pass or two.
    expect(floors).toBeLessThan(rounds / 20);
  }, 30_000);

  it("still floors a driver that keeps answering at once with nothing claimable", async () => {
    /**
     * A driver whose wait for work never waits — until it has been asked far
     * more often than a floored worker could, after which it does wait, so a
     * worker without the floor fails this test instead of starving the event
     * loop (and the test's own timeout) for good.
     */
    class InstantWaitDriver extends MemoryDriver {
      /** How many times the worker asked to wait for work. */
      waits = 0;

      override async waitForJob(
        _q: QueueRef,
        _timeoutMs: number,
        _signal?: AbortSignal,
      ): Promise<void> {
        this.waits += 1;
        if (this.waits > 5_000) {
          await Bun.sleep(5);
        }
      }
    }

    const driver = new InstantWaitDriver();
    const namespace = testNamespace();
    const worker = new BunQueueWorker("empty", () => {}, {
      namespace,
      driver,
      logger: noopLogger,
      autorun: false,
      maintenance: false,
      metrics: { workers: false },
    });
    closers.push(() => worker.close({ force: true }));

    const windowMs = 200;
    const floors = await countOneMsTimers(async () => {
      worker.run().catch(() => {});
      await Bun.sleep(windowMs);
    });

    // A spin would ask tens of thousands of times in the window; the floor
    // allows at most about two passes per millisecond.
    expect(driver.waits).toBeGreaterThan(10);
    expect(driver.waits).toBeLessThan(windowMs * 3);
    expect(floors).toBeGreaterThan(0);
  }, 10_000);
});
