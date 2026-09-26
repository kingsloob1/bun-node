import type { JobsDriver } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
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
