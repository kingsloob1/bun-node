import type { JobsDriver, JobState } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueueWorker, MemoryDriver } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * C12: flow healing walks the queue's shared state on one worker per queue
 * (whoever holds the lease), not on every worker; another takes over when the
 * holder is gone.
 */

const open: BunQueueWorker<unknown, unknown>[] = [];

afterEach(async () => {
  await Promise.allSettled(
    open.map(async (worker) => worker.close({ force: true })),
  );
  open.length = 0;
});

/** A view of `inner` counting the heal walks' `listJobs` pages. */
function countingView(inner: MemoryDriver): {
  driver: JobsDriver;
  walks: () => number;
} {
  let walks = 0;
  const driver = new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") {
        return value;
      }
      if (prop === "listJobs") {
        return async (...args: unknown[]) => {
          const states = args[1] as JobState[];
          if (
            states.includes("completed") ||
            states.includes("dead") ||
            states.includes("waiting-children")
          ) {
            walks++;
          }
          return await (value as (...a: unknown[]) => unknown).apply(
            target,
            args,
          );
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  }) as JobsDriver;
  return { driver, walks: () => walks };
}

/** A worker on `inner` through its own counting view. */
function worker(
  inner: MemoryDriver,
  ns: string,
): {
  instance: BunQueueWorker<unknown, unknown>;
  walks: () => number;
} {
  const view = countingView(inner);
  const instance = new BunQueueWorker<unknown, unknown>("q", async () => null, {
    namespace: ns,
    driver: view.driver,
    logger: noopLogger,
    stalledInterval: 50,
    pollInterval: 20,
    waitToExit: false,
    metrics: { workers: false },
  });
  open.push(instance);
  return { instance, walks: view.walks };
}

describe("flow healing: one worker per queue (C12)", () => {
  it("walks on one of five workers, and hands over when it closes", async () => {
    const inner = new MemoryDriver();
    const ns = testNamespace("c12");
    const workers = Array.from({ length: 5 }, () => worker(inner, ns));
    for (const { instance } of workers) {
      void instance.run();
    }

    await Bun.sleep(600);
    const walking = workers.filter(({ walks }) => walks() > 0);
    expect(walking).toHaveLength(1);

    const holder = walking[0]!;
    await holder.instance.close({ force: true });
    const others = workers.filter((one) => one !== holder);
    const before = others.map(({ walks }) => walks());

    // The lease lasts two stalled intervals (100ms); another takes it after.
    await waitFor(
      () => others.some(({ walks }, index) => walks() > before[index]!),
      { timeout: 2_000, message: "no worker took the lease over" },
    );
  });
});
