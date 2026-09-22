import type { JobsDriver } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueue, BunQueueWorker, MemoryDriver } from "../lib/index";
import { QueueLimiter } from "../lib/queue/limits";
import { testNamespace, waitFor } from "./helpers";

/**
 * B7: a job claimed while the queue had no limits was never counted on the
 * worker's lease, so its end must not be subtracted from it; and the lease
 * renewal stops once limits are gone and nothing is held.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.allSettled(closers.map((close) => close()));
  closers.length = 0;
});

describe("limits: releases only for reserved jobs (B7)", () => {
  it("keeps counting jobs claimed under limits after a clear, a stream of unlimited jobs and a re-set", async () => {
    const driver: JobsDriver = new MemoryDriver();
    const namespace = testNamespace();
    const queue = new BunQueue<{ gate: boolean }>("limited", {
      namespace,
      driver,
      logger: noopLogger,
    });
    closers.push(() => queue.close());

    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let running = 0;
    let finished = 0;

    const worker = new BunQueueWorker<{ gate: boolean }>(
      "limited",
      async (job) => {
        running++;
        try {
          if (job.data.gate) {
            await gate;
          }
        } finally {
          running--;
          finished++;
        }
      },
      {
        namespace,
        driver,
        logger: noopLogger,
        concurrency: 8,
        pollInterval: 5,
        maxBlock: 20,
        limitsRefreshInterval: 20,
        // Renews the lease every 100ms.
        lockDuration: 300,
      },
    );
    closers.push(async () => {
      open();
      await worker.close({ force: true });
    });

    await queue.setLimits({ concurrency: 2 });
    await queue.add("long", { gate: true });
    await queue.add("long", { gate: true });
    void worker.run();
    await waitFor(() => running === 2, { timeout: 5_000 });

    await queue.setLimits(null);
    for (let index = 0; index < 5; index++) {
      await queue.add("fast", { gate: false });
    }
    await waitFor(() => finished === 5, { timeout: 5_000 });

    // Two renewals: each writes whatever releases are pending.
    await Bun.sleep(250);

    await queue.setLimits({ concurrency: 2 });
    await Bun.sleep(60);
    await queue.add("third", { gate: false });
    await Bun.sleep(200);

    // The two long jobs still run under the cap of 2: nothing else may start.
    expect(running).toBe(2);
    expect(finished).toBe(5);

    open();
    await waitFor(() => finished === 8, { timeout: 5_000 });
  }, 20_000);
});

describe("limits: lease renewal after a clear (B7)", () => {
  it("stops renewing once limits are gone and nothing is held, and starts again on the next grant", async () => {
    const driver: JobsDriver = new MemoryDriver();
    const namespace = testNamespace();
    const queue = new BunQueue("limited", {
      namespace,
      driver,
      logger: noopLogger,
    });
    closers.push(() => queue.close());

    const limiter = new QueueLimiter(driver, queue.ref, "holder-1", 300, 0);
    closers.push(() => limiter.close());

    await queue.setLimits({ concurrency: 2 });
    const reservation = await limiter.reserve(1, Date.now());
    expect(reservation?.grant).toBe(1);
    await limiter.commit(reservation!, ["a"], Date.now());
    expect(limiter.renewing).toBe(true);

    await queue.setLimits(null);
    // Reads the limits again (refresh 0): gone.
    expect(await limiter.reserve(1, Date.now())).toBeNull();

    // Still holding "a": the renewal must go on.
    await limiter.renew(Date.now());
    expect(limiter.renewing).toBe(true);

    limiter.release("a");
    await limiter.renew(Date.now());
    expect(limiter.renewing).toBe(false);

    await queue.setLimits({ concurrency: 2 });
    const again = await limiter.reserve(1, Date.now());
    expect(again?.grant).toBe(1);
    expect(limiter.renewing).toBe(true);
  });
});
