import type { QueueRef } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunJobs, BunQueue, MemoryDriver } from "../lib/index";
import { FAN_OUT_LIMIT, mapConcurrent } from "../lib/shared/bounded";
import { testNamespace } from "./helpers";

/**
 * B12: the namespace-wide reads a dashboard polls fan out a bounded number
 * of driver calls at a time, not one per queue all at once.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.allSettled(closers.map((close) => close()));
  closers.length = 0;
});

describe("mapConcurrent", () => {
  it("keeps order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapConcurrent(
      Array.from({ length: 40 }, (_, index) => index),
      async (item) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Bun.sleep(item % 3);
        inFlight--;
        return item * 2;
      },
      5,
    );

    expect(out).toEqual(Array.from({ length: 40 }, (_, index) => index * 2));
    expect(peak).toBe(5);
    expect(await mapConcurrent([], async () => 1)).toEqual([]);
  });
});

describe("BunJobs.getQueueSummaries: bounded paused reads (B12)", () => {
  it("has at most FAN_OUT_LIMIT paused checks in flight across 50 queues", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();
    const jobs = new BunJobs({ namespace, driver, logger: noopLogger });
    closers.push(() => jobs.close());

    for (let index = 0; index < 50; index++) {
      const queue = new BunQueue(`q${String(index).padStart(2, "0")}`, {
        namespace,
        driver,
        logger: noopLogger,
      });
      await queue.add("x", {});
      await queue.close();
    }

    let inFlight = 0;
    let peak = 0;
    const original = driver.isQueuePaused.bind(driver);
    driver.isQueuePaused = async (ref: QueueRef) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        await Bun.sleep(2);
        return await original(ref);
      } finally {
        inFlight--;
      }
    };

    const summaries = await jobs.getQueueSummaries();
    expect(summaries).toHaveLength(50);
    expect(summaries.map((summary) => summary.name)).toEqual(
      [...summaries.map((summary) => summary.name)].sort(),
    );
    expect(summaries.every((summary) => summary.total === 1)).toBe(true);
    expect(peak).toBeLessThanOrEqual(FAN_OUT_LIMIT);
    expect(peak).toBeGreaterThan(1);
  });
});
