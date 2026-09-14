import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  BunQueue,
  BunQueueWorker,
  MemoryDriver,
  RedisDriver,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * A worker must not accumulate `abort` listeners as it runs jobs.
 *
 * Its wake signal lives as long as the worker, and it used to be handed to
 * sleeps that were abandoned whenever a job finished first — at concurrency
 * one, every job. Each left a listener behind until its timer fired, a lock
 * duration later, so a busy worker carried thousands, every new listener cost
 * a walk of all the old ones, and the Redis round trip grew by 15%.
 *
 * Counted by wrapping `EventTarget`, which `AbortSignal` inherits from, per
 * signal: added minus removed is what is still attached to each. Per signal,
 * because every job has a signal of its own that is dropped when it ends,
 * listeners and all — that is not a leak. One signal gathering them is.
 */

const outstanding = new Map<AbortSignal, number>();
/** The most listeners still attached to any one signal. */
const worst = () => Math.max(0, ...outstanding.values());
const add = EventTarget.prototype.addEventListener;
const remove = EventTarget.prototype.removeEventListener;

beforeAll(() => {
  EventTarget.prototype.addEventListener = function (
    this: EventTarget,
    ...args: Parameters<EventTarget["addEventListener"]>
  ) {
    if (this instanceof AbortSignal && args[0] === "abort") {
      outstanding.set(this, (outstanding.get(this) ?? 0) + 1);
    }
    return add.apply(this, args);
  };
  EventTarget.prototype.removeEventListener = function (
    this: EventTarget,
    ...args: Parameters<EventTarget["removeEventListener"]>
  ) {
    if (this instanceof AbortSignal && args[0] === "abort") {
      outstanding.set(this, (outstanding.get(this) ?? 0) - 1);
    }
    return remove.apply(this, args);
  };
});

afterAll(() => {
  EventTarget.prototype.addEventListener = add;
  EventTarget.prototype.removeEventListener = remove;
});

describe("BunQueueWorker: abort listeners", () => {
  it("does not leave one behind per job", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();
    const queue = new BunQueue("listeners", {
      namespace,
      driver,
      logger: noopLogger,
      defaultJobOptions: { removeOnComplete: true },
    });
    let done = 0;
    // Concurrency one, so every job fills the worker and it waits on the job
    // — the race that used to abandon a sleep each time.
    const worker = new BunQueueWorker(
      "listeners",
      async () => {
        await Bun.sleep(0);
        done++;
      },
      {
        namespace,
        driver,
        logger: noopLogger,
        concurrency: 1,
        pollInterval: 5,
        waitToExit: false,
      },
    );

    try {
      await queue.addBulk(
        Array.from({ length: 500 }, (_, index) => ({
          name: "x",
          data: { index },
        })),
      );
      outstanding.clear();
      void worker.run();
      await waitFor(() => done === 500, { timeout: 20_000 });

      // A handful are legitimately attached while the worker idles; one per
      // job is what must not happen.
      expect(worst()).toBeLessThan(20);
    } finally {
      await worker.close({ force: true });
      await queue.close();
    }
  }, 30_000);

  // The Redis driver waits by racing a blocking pop against a sleep bound to
  // the worker's signal, which the pop wins whenever a job is waiting.
  it.skipIf(!process.env.BUN_JOBS_TEST_REDIS_URL)(
    "does not leave one behind per job on Redis",
    async () => {
      const driver = new RedisDriver({
        url: process.env.BUN_JOBS_TEST_REDIS_URL,
      });
      const namespace = testNamespace();
      const queue = new BunQueue("listeners", {
        namespace,
        driver,
        logger: noopLogger,
        defaultJobOptions: { removeOnComplete: true },
      });
      let done = 0;
      const worker = new BunQueueWorker(
        "listeners",
        async () => {
          done++;
        },
        {
          namespace,
          driver,
          logger: noopLogger,
          concurrency: 1,
          waitToExit: false,
        },
      );

      try {
        outstanding.clear();
        void worker.run();
        // One at a time, so every job arrives while the worker is waiting.
        for (let index = 0; index < 300; index++) {
          await queue.add("x", { index });
          await waitFor(() => done === index + 1, { timeout: 5_000 });
        }

        expect(worst()).toBeLessThan(20);
      } finally {
        await worker.close({ force: true });
        await driver.purge(namespace).catch(() => {});
        await queue.close();
        await driver.close();
      }
    },
    60_000,
  );
});
