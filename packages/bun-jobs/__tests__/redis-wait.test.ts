import type { QueueRef } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueue, BunQueueWorker, RedisDriver } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * Redis waits, and the wake token an abandoned one used to swallow.
 *
 * `BLPOP` cannot be called off, so a wait whose caller gives up — `pause()`,
 * `resume()`, the concurrency setter, a sweep that recovered something —
 * leaves its pop parked on the blocking connection. The pop is a *destructive*
 * read of a list, so when the next `add()` pushes a wake token that parked pop
 * takes it and throws it away, and the job it announced then waits out a whole
 * further block. Both tests below measure that: they assert how quickly work
 * is noticed, and fail on the old behaviour by seconds, not milliseconds.
 */

const url = process.env.BUN_JOBS_TEST_REDIS_URL;

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

describe.skipIf(!url)("redis: a wait that was given up on", () => {
  /** A driver, a queue and their own namespace, all torn down afterwards. */
  function setup() {
    const driver = new RedisDriver({
      url: url!,
      keyPrefix: `wait-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    });
    const namespace = testNamespace("wait");
    const q: QueueRef = { ns: namespace, queue: "orders" };
    const queue = new BunQueue<{ v: number }>("orders", {
      namespace,
      driver,
      logger: noopLogger,
    });

    closers.push(
      () => queue.close(),
      // Exactly the namespace this test made — never a prefix sweep.
      async () => {
        await driver.purge(namespace).catch(() => undefined);
        await driver.close();
      },
    );

    return { driver, q, queue };
  }

  it("still delivers the wake that arrived after it was abandoned", async () => {
    const { driver, q, queue } = setup();
    await driver.connect();

    // A wait nobody is listening to any more. Its pop stays parked.
    const abort = new AbortController();
    const abandoned = driver.waitForJob(q, 30_000, abort.signal);
    await Bun.sleep(100);
    abort.abort();
    await abandoned;

    // The wake this sends is taken by that parked pop, with no one to hand it
    // to. It must not simply vanish.
    await queue.add("reindex", { v: 1 });
    await Bun.sleep(150);

    const started = Date.now();
    await driver.waitForJob(q, 30_000);
    const elapsed = Date.now() - started;

    // Before the fix this waited out a full block (5s by default) because the
    // token had been swallowed.
    expect(elapsed).toBeLessThan(1_000);
  });

  it("lets a worker pick up an add promptly after pause and resume", async () => {
    const { driver, q, queue } = setup();
    const ran: number[] = [];

    // Long waits and long polls, so nothing but the wake can save this.
    const worker = new BunQueueWorker<{ v: number }>(
      "orders",
      async (job) => {
        ran.push(job.data.v);
        return null;
      },
      {
        namespace: q.ns,
        driver,
        logger: noopLogger,
        pollInterval: 5_000,
        maxBlock: 5_000,
        reportInterval: 0,
      },
    );
    closers.push(() => worker.close({ force: true }));

    void worker.run();
    await waitFor(() => worker.isRunning, { timeout: 5_000 });
    // Long enough to be sitting inside a blocking wait.
    await Bun.sleep(300);

    // Both abort the wait in progress, leaving its pop parked.
    await worker.pause();
    worker.resume();
    await Bun.sleep(50);

    const started = Date.now();
    await queue.add("reindex", { v: 1 });
    await waitFor(() => ran.length === 1, {
      timeout: 15_000,
      message: "the worker never picked up the job added after resume()",
    });

    expect(ran).toEqual([1]);
    // Before the fix this took the whole of `maxBlock`.
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
