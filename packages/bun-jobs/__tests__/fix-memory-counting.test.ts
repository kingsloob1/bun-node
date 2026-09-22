import type { QueueRef } from "../lib/drivers/driver";
import { describe, expect, it } from "bun:test";
import {
  MINUTE_BUCKET_MS,
  SECOND_BUCKET_MS,
} from "../lib/api/contract/constants";
import { MemoryDriver } from "../lib/drivers/memory-driver";
import { makeJob, testNamespace } from "./helpers";

/**
 * A3: the memory driver counts a finished job into buckets it found once for
 * the current second, not a dozen `Map` lookups per job. The cache is only an
 * optimisation, so every test here is about what it must never change: the
 * series a reader sees, across seconds, out-of-order times, a sweep and a
 * purge.
 */

/** Adds, claims and finishes one job at `at`; `failed` fails it for good. */
async function finish(
  driver: MemoryDriver,
  q: QueueRef,
  id: string,
  at: number,
  failed = false,
): Promise<void> {
  await driver.addJob(q, makeJob({ id, createdAt: at, runAt: at }));
  const token = `t-${id}`;
  const claimed = await driver.claimJob(q, {
    workerId: "w",
    token,
    lockMs: 60_000,
    now: at,
  });
  expect(claimed?.id).toBe(id);

  const done = failed
    ? await driver.failJob(
        q,
        id,
        token,
        { name: "Error", message: "boom" },
        { retry: false, retention: false },
        at,
        0,
      )
    : await driver.completeJob(q, id, token, null, false, at);
  expect(done).toBe(true);
}

/** One width's buckets of the queue over `[from, to]`. */
function range(from: number, to: number, interval: number) {
  return { from, to, interval };
}

/** A second-aligned instant a little in the past, inside every retention. */
function recentSecond(): number {
  const minute = Math.floor(Date.now() / MINUTE_BUCKET_MS) * MINUTE_BUCKET_MS;
  // The start of the previous minute plus 58 s: two seconds before a minute
  // boundary, so a test can cross one.
  return minute - MINUTE_BUCKET_MS + 58_000;
}

describe("memory driver job counting (A3)", () => {
  it("counts every second, minute, roll-up and throughput bucket as before", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("fixmem-count");
    const q: QueueRef = { ns, queue: "orders" };
    const t0 = recentSecond();
    const t1 = t0 + SECOND_BUCKET_MS; // the next second, same minute
    const t2 = t0 + 2 * SECOND_BUCKET_MS; // the next minute

    await finish(driver, q, "a", t0 + 10);
    await finish(driver, q, "b", t0 + 900, true);
    await finish(driver, q, "c", t1 + 1);
    await finish(driver, q, "d", t2 + 5);
    await finish(driver, q, "e", t2 + 6, true);

    expect(
      await driver.getQueueMetrics(q, range(t0, t2, SECOND_BUCKET_MS)),
    ).toEqual([
      { at: t0, completed: 1, failed: 1 },
      { at: t1, completed: 1, failed: 0 },
      { at: t2, completed: 1, failed: 1 },
    ]);

    const m0 = t0 - 58_000;
    const m1 = m0 + MINUTE_BUCKET_MS;
    const minutes = [
      { at: m0, completed: 2, failed: 1 },
      { at: m1, completed: 1, failed: 1 },
    ];
    expect(
      await driver.getQueueMetrics(q, range(m0, m1, MINUTE_BUCKET_MS)),
    ).toEqual(minutes);
    expect(
      (
        await driver.getNamespaceMetrics(ns, {
          ...range(m0, m1, MINUTE_BUCKET_MS),
          kinds: ["jobs"],
        })
      ).jobs,
    ).toEqual(minutes);
    expect(
      await driver.getThroughput(q, { from: m0, to: m1 + MINUTE_BUCKET_MS }),
    ).toEqual(minutes);
  });

  it("goes back to an earlier second when times arrive out of order", async () => {
    const driver = new MemoryDriver();
    const q: QueueRef = { ns: testNamespace("fixmem-order"), queue: "q" };
    const t0 = recentSecond();
    const t1 = t0 + SECOND_BUCKET_MS;

    await finish(driver, q, "a", t1);
    await finish(driver, q, "b", t0);
    await finish(driver, q, "c", t1 + 500);

    expect(
      await driver.getQueueMetrics(q, range(t0, t1, SECOND_BUCKET_MS)),
    ).toEqual([
      { at: t0, completed: 1, failed: 0 },
      { at: t1, completed: 2, failed: 0 },
    ]);
  });

  it("keeps counting into stored buckets after a sweep deletes the cached ones", async () => {
    const driver = new MemoryDriver();
    const ns = testNamespace("fixmem-sweep");
    const q: QueueRef = { ns, queue: "q" };
    const t0 = recentSecond();

    await finish(driver, q, "a", t0);

    // A count far ahead drives the once-a-minute sweep with its own time, so
    // every bucket at t0 is past retention and deleted — including the ones
    // the queue's cache points at.
    await driver.countWorkerJobs(q, "k", t0 + 30 * 24 * 3600_000, {
      completed: 1,
    });
    expect(
      await driver.getQueueMetrics(q, range(t0, t0, SECOND_BUCKET_MS)),
    ).toEqual([]);

    // The same second again: the count must land in a bucket a reader sees,
    // not in the swept one the cache still held.
    await finish(driver, q, "b", t0 + 1);

    expect(
      await driver.getQueueMetrics(q, range(t0, t0, SECOND_BUCKET_MS)),
    ).toEqual([{ at: t0, completed: 1, failed: 0 }]);
    expect(
      (
        await driver.getNamespaceMetrics(ns, {
          ...range(t0, t0, SECOND_BUCKET_MS),
          kinds: ["jobs"],
        })
      ).jobs,
    ).toEqual([{ at: t0, completed: 1, failed: 0 }]);
  });

  it("starts from nothing after the namespace is purged", async () => {
    const driver = new MemoryDriver();
    const q: QueueRef = { ns: testNamespace("fixmem-purge"), queue: "q" };
    const t0 = recentSecond();

    await finish(driver, q, "a", t0);
    await driver.purge(q.ns);
    await finish(driver, q, "b", t0 + 1);

    expect(
      await driver.getQueueMetrics(q, range(t0, t0, SECOND_BUCKET_MS)),
    ).toEqual([{ at: t0, completed: 1, failed: 0 }]);
  });
});
