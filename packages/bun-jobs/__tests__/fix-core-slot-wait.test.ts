import type { Job } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { heapStats } from "bun:jsc";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueue, BunQueueWorker, MemoryDriver } from "../lib/index";
import { Pulse, waitForAny } from "../lib/shared/wait";
import { testNamespace, waitFor } from "./helpers";

/**
 * B1: a full worker waits for a slot on one pulse, not on every running
 * job's promise. The old wait left a reaction on each still-running job per
 * pass, so a long job beside a stream of short ones collected one per
 * completion for as long as it ran.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.allSettled(closers.map((close) => close()));
  closers.length = 0;
});

/** Live `Promise` objects after a full collection. */
function livePromises(): number {
  Bun.gc(true);
  return heapStats().objectTypeCounts.Promise ?? 0;
}

describe("Pulse", () => {
  it("ends every subscribed wait on notify, and a timed-out wait unsubscribes", async () => {
    const pulse = new Pulse();

    const timedOut = waitForAny(5, { pulse });
    expect(pulse.size).toBe(1);
    await timedOut;
    expect(pulse.size).toBe(0);

    let ended = 0;
    const waits = [1, 2, 3].map(async () => {
      await waitForAny(60_000, { pulse });
      ended += 1;
    });
    expect(pulse.size).toBe(3);
    pulse.notify();
    await Promise.all(waits);
    expect(ended).toBe(3);
    expect(pulse.size).toBe(0);
  });

  it("leaves nothing behind across many waits that time out", async () => {
    const pulse = new Pulse();
    for (let index = 0; index < 200; index++) {
      await waitForAny(0, { pulse });
    }

    expect(pulse.size).toBe(0);
  });
});

describe("BunQueueWorker: full-slot wait (B1)", () => {
  it("keeps no per-completion reaction on a long job still running", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();
    const queue = new BunQueue<{ long: boolean }>("work", {
      namespace,
      driver,
      logger: noopLogger,
      defaultJobOptions: { removeOnComplete: true },
    });

    let releaseLong!: () => void;
    const longDone = new Promise<void>((resolve) => {
      releaseLong = resolve;
    });
    let completed = 0;

    const worker = new BunQueueWorker<{ long: boolean }>(
      "work",
      async (job: Job<{ long: boolean }>) => {
        if (job.data.long) {
          await longDone;
        }
      },
      {
        namespace,
        driver,
        logger: noopLogger,
        concurrency: 2,
        pollInterval: 10,
        maxBlock: 20,
        metrics: { workers: false },
      },
    );
    worker.on("completed", () => {
      completed += 1;
    });
    closers.push(
      async () => {
        releaseLong();
        await worker.close({ force: true });
      },
      () => queue.close(),
    );

    await queue.add("long", { long: true });
    worker.run().catch(() => {});
    await waitFor(() => worker.activeCount === 1);

    /** Runs `count` short jobs beside the long one. */
    async function burst(count: number): Promise<void> {
      const target = completed + count;
      await queue.addBulk(
        Array.from({ length: count }, () => ({
          name: "short",
          data: { long: false },
        })),
      );
      await waitFor(() => completed >= target, { timeout: 30_000 });
    }

    await burst(2_000);
    const before = livePromises();
    await burst(10_000);
    const after = livePromises();

    // The old wait retained two promises per completion here (~20,000).
    expect(after - before).toBeLessThan(2_000);
    expect(worker.activeCount).toBe(1);
  }, 60_000);
});
