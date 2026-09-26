import type { JobsDriver } from "../lib/index";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { readDemand } from "../lib/drivers/readApis";
import {
  BunQueue,
  BunQueueWorker,
  ConfigError,
  MemoryDriver,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * `queue.getDemand()` end to end: the public read over `readDemand` and the
 * driver's `countDemand`. What each driver counts is the contract suite's
 * (`countDemand` in `helpers/driverContract.ts`); this is the queue's side.
 */

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

/** A queue on `driver` (a fresh memory driver by default), closed afterwards. */
function makeQueue(driver: JobsDriver = new MemoryDriver()): BunQueue {
  const queue = new BunQueue("demand", {
    namespace: testNamespace("demand"),
    driver,
    logger: noopLogger,
  });
  cleanups.push(async () => await queue.close());
  return queue;
}

describe("BunQueue.getDemand", () => {
  it("reports waiting work and when the next scheduled job comes due", async () => {
    const queue = makeQueue();
    await queue.add("a", {});
    await queue.add("b", {});
    const later = await queue.add("later", {}, { delay: 60_000 });

    const demand = await queue.getDemand();
    expect(demand).toMatchObject({
      paused: false,
      waiting: 2,
      dueNow: 0,
      stalled: 0,
      active: 0,
      workers: 0,
      nextDueAt: later.runAt,
      demand: 2,
      outstanding: 2,
      capped: false,
      exact: true,
    });
    expect(demand.at).toBeLessThanOrEqual(Date.now());
  });

  it("counts a delayed job that fell due with no worker to promote it", async () => {
    const queue = makeQueue();
    await queue.add("soon", {}, { delay: 20 });
    expect((await queue.getDemand()).demand).toBe(0);

    await Bun.sleep(40);

    // Nothing promoted it, and nothing needs to for it to count.
    expect(await queue.count("delayed")).toBe(1);
    expect(await queue.getDemand()).toMatchObject({
      waiting: 0,
      dueNow: 1,
      demand: 1,
      nextDueAt: null,
    });
    // And reading it promoted nothing.
    expect(await queue.count("delayed")).toBe(1);
  });

  it("counts running jobs and live workers, and a paused queue demands nothing", async () => {
    const driver = new MemoryDriver();
    const queue = makeQueue(driver);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const worker = new BunQueueWorker("demand", async () => await held, {
      namespace: queue.namespace,
      driver,
      logger: noopLogger,
      pollInterval: 10,
    });
    cleanups.push(async () => {
      release();
      await worker.close({ timeout: 2_000 });
    });
    void worker.run();

    await queue.add("running", {});
    await waitFor(() => worker.activeCount === 1, { timeout: 5_000 });
    await queue.add("queued", {});

    await waitFor(async () => (await queue.getDemand()).workers === 1, {
      timeout: 5_000,
      message: "the worker's record never appeared",
    });
    expect(await queue.getDemand()).toMatchObject({
      waiting: 1,
      active: 1,
      stalled: 0,
      workers: 1,
      demand: 1,
      outstanding: 2,
    });

    await queue.pause();
    // The backlog is still there to see; it asks for no worker.
    expect(await queue.getDemand()).toMatchObject({
      paused: true,
      waiting: 1,
      active: 1,
      demand: 0,
      outstanding: 0,
    });
    await queue.resume();
  });

  it("counts up to cap, and says when a figure went past it", async () => {
    const queue = makeQueue();
    for (let i = 0; i < 5; i++) {
      await queue.add("job", {});
    }

    expect(await queue.getDemand({ cap: 5 })).toMatchObject({
      waiting: 5,
      demand: 5,
      capped: false,
    });
    expect(await queue.getDemand({ cap: 3 })).toMatchObject({
      waiting: 3,
      demand: 3,
      capped: true,
    });
    await expect(queue.getDemand({ cap: 0 })).rejects.toThrow(ConfigError);
  });

  it("falls back, and says it is approximate, on a driver without countDemand", async () => {
    const memory = new MemoryDriver();
    const bare = new Proxy(memory, {
      get(target, property) {
        if (property === "countDemand") {
          return undefined;
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const queue = makeQueue(bare);
    await queue.add("a", {});
    await queue.add("due", {}, { delay: 1 });
    await queue.add("due-too", {}, { delay: 1 });
    await Bun.sleep(10);

    // Two jobs are due; the fallback can only say that something is.
    expect(await queue.getDemand()).toMatchObject({
      waiting: 1,
      dueNow: 1,
      demand: 2,
      exact: false,
    });
  });
});

describe("readDemand when the driver fails", () => {
  /**
   * A memory driver without `countDemand` whose `countJobs` and
   * `isQueuePaused` both fail, the first either by rejecting or by throwing
   * outright, as a non-`async` third-party method would.
   */
  function failing(sync: boolean): JobsDriver {
    return new Proxy(new MemoryDriver(), {
      get(target, property) {
        if (property === "countDemand") {
          return undefined;
        }
        if (property === "countJobs") {
          return sync
            ? () => {
                throw new Error("down: countJobs");
              }
            : async () => {
                throw new Error("down: countJobs");
              };
        }
        if (property === "isQueuePaused") {
          return async () => {
            await Bun.sleep(5);
            throw new Error("down: isQueuePaused");
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  // A controller polling a third-party driver through an outage catches the
  // one rejection it is given. A second read left un-awaited behind it would
  // reject with nobody listening, and an unhandled rejection ends a Bun
  // process: a plain try/catch cannot see that, so the listener is the check.
  for (const sync of [false, true]) {
    it(`rejects once, leaving no rejection unhandled (${sync ? "a synchronous throw" : "a rejection"})`, async () => {
      const unhandled: unknown[] = [];
      const listen = (reason: unknown) => void unhandled.push(reason);
      process.on("unhandledRejection", listen);

      try {
        const q = { ns: testNamespace("demand-down"), queue: "q" };
        await expect(readDemand(failing(sync), q)).rejects.toThrow(/^down: /);
        // Long enough for the slower read to fail, and for its rejection to
        // be reported if nothing awaited it.
        await Bun.sleep(50);
      } finally {
        process.off("unhandledRejection", listen);
      }

      expect(unhandled).toEqual([]);
    });
  }
});
