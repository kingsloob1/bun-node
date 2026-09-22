import type { JobsDriver } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueue, MemoryDriver } from "../lib/index";
import { QueueLimiter } from "../lib/queue/limits";
import { testNamespace, waitFor } from "./helpers";

/**
 * C14: the job-defaults and limits caches read ahead of expiry in the
 * background, so a busy producer or worker never awaits the refresh — and
 * still never trusts an answer older than the refresh interval.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.allSettled(closers.map((close) => close()));
  closers.length = 0;
});

/** A memory driver whose queue-state reads take `ms`, counting them. */
function slowStateDriver(ms: number): {
  driver: JobsDriver;
  reads: () => number;
} {
  const driver = new MemoryDriver();
  const original = driver.getQueueState.bind(driver);
  let reads = 0;
  driver.getQueueState = async (...args: Parameters<typeof original>) => {
    reads++;
    const entry = await original(...args);
    await Bun.sleep(ms);
    return entry;
  };
  return { driver, reads: () => reads };
}

describe("job defaults: read ahead (C14)", () => {
  it("never makes a steady stream of adds wait on the refresh", async () => {
    // The read (60ms) lands well inside the last quarter of the interval
    // (100ms of 400), so every renewal is in place before expiry.
    const { driver, reads } = slowStateDriver(60);
    const namespace = testNamespace();
    const queue = new BunQueue("q", {
      namespace,
      driver,
      logger: noopLogger,
      jobDefaultsRefreshInterval: 400,
    });
    closers.push(() => queue.close());

    await queue.add("warm", {});
    const first = reads();

    // An add that awaits the refresh takes at least the 60ms read.
    let awaited = 0;
    const end = Date.now() + 1_500;
    while (Date.now() < end) {
      const startedAt = performance.now();
      await queue.add("x", {});
      if (performance.now() - startedAt >= 55) {
        awaited++;
      }
      await Bun.sleep(5);
    }

    expect(reads() - first).toBeGreaterThanOrEqual(3);
    expect(awaited).toBe(0);
  });

  it("still reaches a producer within the interval plus one read", async () => {
    const { driver } = slowStateDriver(5);
    const namespace = testNamespace();
    const producer = new BunQueue("q", {
      namespace,
      driver,
      logger: noopLogger,
      jobDefaultsRefreshInterval: 100,
    });
    const operator = new BunQueue("q", {
      namespace,
      driver,
      logger: noopLogger,
    });
    closers.push(
      () => producer.close(),
      () => operator.close(),
    );

    await producer.add("warm", {});
    await operator.setJobDefaults({ attempts: 7 });
    const savedAt = Date.now();

    let seenAt: number | undefined;
    while (Date.now() - savedAt < 1_000) {
      const job = await producer.add("x", {});
      if (job.opts.attempts === 7) {
        seenAt = Date.now();
        break;
      }
      await Bun.sleep(2);
    }

    expect(seenAt).toBeDefined();
    // 100ms interval + one 5ms read, with slack for a loaded machine.
    expect(seenAt! - savedAt).toBeLessThan(250);
  });
});

describe("limits: read ahead (C14)", () => {
  it("renews a known-unlimited answer before it expires, without an await", async () => {
    const { driver, reads } = slowStateDriver(10);
    const namespace = testNamespace();
    const queue = new BunQueue("q", { namespace, driver, logger: noopLogger });
    closers.push(() => queue.close());

    const limiter = new QueueLimiter(driver, queue.ref, "h", 30_000, 400);
    closers.push(() => limiter.close());

    const readAt = Date.now();
    expect(await limiter.reserve(1, readAt)).toBeNull();
    const first = reads();
    expect(limiter.knownUnlimited(Date.now())).toBe(true);
    expect(reads()).toBe(first);

    // Three quarters in (300ms of 400): still trusted, and a read starts in
    // the background rather than on the next claim's path.
    await Bun.sleep(320 - (Date.now() - readAt));
    expect(limiter.knownUnlimited(Date.now())).toBe(true);
    await waitFor(() => reads() === first + 1);

    // Past the first read's expiry: the renewed answer is trusted.
    await Bun.sleep(Math.max(0, 450 - (Date.now() - readAt)));
    expect(Date.now() - readAt).toBeGreaterThanOrEqual(400);
    expect(limiter.knownUnlimited(Date.now())).toBe(true);
  });

  it("sees limits set meanwhile within the interval", async () => {
    const { driver } = slowStateDriver(5);
    const namespace = testNamespace();
    const queue = new BunQueue("q", { namespace, driver, logger: noopLogger });
    closers.push(() => queue.close());

    const limiter = new QueueLimiter(driver, queue.ref, "h", 30_000, 100);
    closers.push(() => limiter.close());

    expect(await limiter.reserve(1, Date.now())).toBeNull();
    await queue.setLimits({ concurrency: 1 });
    const setAt = Date.now();

    await waitFor(() => !limiter.knownUnlimited(Date.now()), {
      timeout: 1_000,
    });
    expect(Date.now() - setAt).toBeLessThanOrEqual(150);
  });
});
