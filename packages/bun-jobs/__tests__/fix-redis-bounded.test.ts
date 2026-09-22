import type { QueueRef } from "../lib/index";
import process from "node:process";
import { RedisClient as BunRedis } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import {
  CLEAN_SCAN_BUDGET,
  DRAIN_BATCH,
  RETAIN_CAP_BATCH,
} from "../lib/drivers/redis/scripts";
import { RedisDriver } from "../lib/index";
import { makeJob, testNamespace } from "./helpers";

/**
 * C16 of the 2026-09-22 fix round: `DRAIN`, `CLEAN` on the pending sets and
 * the count-cap retention each did unbounded work inside one script, which
 * holds Redis's only thread — seconds on a large queue. Each is now bounded
 * per call; the driver loops across calls where the operation needs it.
 */

const URL = process.env.BUN_JOBS_TEST_REDIS_URL;

/** Cleanups to run after each test, newest first. */
const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

/** A driver whose client counts `evalsha`/`eval` calls, and its namespace. */
function setup(prefix: string) {
  const real = new BunRedis(URL!);
  const counter = { scripts: 0 };
  const client = new Proxy(real, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        if (property === "evalsha" || property === "eval") {
          counter.scripts++;
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const driver = new RedisDriver({ url: URL, client });
  const ns = testNamespace(prefix);
  cleanups.push(async () => {
    await driver.purge(ns);
    await driver.close();
    real.close();
  });
  return { driver, ns, counter };
}

/** `count` jobs in one state, added in bulk. */
async function seed(
  driver: RedisDriver,
  q: QueueRef,
  prefix: string,
  count: number,
  overrides: Parameters<typeof makeJob>[0] = {},
): Promise<void> {
  const now = Date.now();
  const jobs = [];
  for (let i = 0; i < count; i++) {
    jobs.push(
      makeJob({
        id: `${prefix}${i}`,
        runAt: now,
        createdAt: now,
        ...overrides,
      }),
    );
  }
  await driver.addJobs(q, jobs);
}

describe.skipIf(!URL)("redis: bounded maintenance scripts (C16)", () => {
  it("drains a queue larger than one batch, a bounded batch per call", async () => {
    const { driver, ns, counter } = setup("c16d");
    const q: QueueRef = { ns, queue: "drain" };
    const now = Date.now();
    await seed(driver, q, "w", DRAIN_BATCH * 2 + 500);
    await seed(driver, q, "d", 700, { state: "delayed", runAt: now + 60_000 });

    counter.scripts = 0;
    expect(await driver.drainQueue(q, false)).toBe(DRAIN_BATCH * 2 + 500);
    // Three bounded calls, not one that holds the server for all of them.
    expect(counter.scripts).toBe(3);
    expect((await driver.countJobs(q)).waiting).toBe(0);
    expect((await driver.countJobs(q)).delayed).toBe(700);

    expect(await driver.drainQueue(q, true)).toBe(700);
    expect(await driver.countJobs(q)).toMatchObject({ waiting: 0, delayed: 0 });
    // Every job's hash went with it.
    expect(await driver.getJob(q, "w0")).toBeNull();
    expect(await driver.getJob(q, "d0")).toBeNull();
  }, 30_000);

  it("cleans old pending jobs behind more young ones than one call examines", async () => {
    const { driver, ns, counter } = setup("c16c");
    const q: QueueRef = { ns, queue: "clean" };
    const now = Date.now();

    // Young at the head (priority 0), old at the back (priority 5).
    await seed(driver, q, "young", CLEAN_SCAN_BUDGET + 300);
    await seed(driver, q, "old", 20, {
      createdAt: now - 3_600_000,
      priority: 5,
    });

    counter.scripts = 0;
    const removed = await driver.cleanJobs(q, "waiting", 60_000, 100, now);
    expect(removed.sort()).toEqual(
      Array.from({ length: 20 }, (_u, i) => `old${i}`).sort(),
    );
    // Two bounded calls: the first stopped at its budget, the second resumed.
    expect(counter.scripts).toBe(2);
    expect((await driver.countJobs(q)).waiting).toBe(CLEAN_SCAN_BUDGET + 300);

    // A limit reached early stops early.
    await seed(driver, q, "old2-", 5, {
      createdAt: now - 3_600_000,
      priority: 9,
    });
    expect(await driver.cleanJobs(q, "waiting", 60_000, 2, now)).toHaveLength(
      2,
    );
  }, 30_000);

  it("trims a lowered count cap a bounded batch per settle", async () => {
    const { driver, ns } = setup("c16r");
    const q: QueueRef = { ns, queue: "cap" };
    const now = Date.now();
    const kept = RETAIN_CAP_BATCH * 2 + 50;

    // Completed and kept for good, as a queue does before its cap is lowered.
    await seed(driver, q, "done", kept, {
      state: "completed",
      finishedOn: now - 10_000,
    });

    const settle = async (id: string): Promise<number> => {
      await driver.addJob(q, makeJob({ id, runAt: now }));
      await driver.claimJob(q, {
        workerId: "w",
        token: id,
        lockMs: 60_000,
        now,
      });
      expect(await driver.completeJob(q, id, id, null, 10, now)).toBe(true);
      return (await driver.countJobs(q)).completed;
    };

    // One settle removes at most RETAIN_CAP_BATCH past the cap, not all of
    // them at once; the excess drains over the next settles.
    expect(await settle("s1")).toBe(kept + 1 - RETAIN_CAP_BATCH);
    expect(await settle("s2")).toBe(kept + 2 - 2 * RETAIN_CAP_BATCH);
    expect(await settle("s3")).toBe(10);
    expect(await settle("s4")).toBe(10);
    // Newest kept: the settles themselves survive the cap.
    expect(await driver.getJob(q, "s4")).not.toBeNull();
  }, 30_000);
});
