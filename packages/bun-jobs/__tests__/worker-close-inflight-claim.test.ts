import type { JobsDriver, QueueRef } from "../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueue, BunQueueWorker, MemoryDriver } from "../lib/index";
import { LIMITER_STATE } from "../lib/queue/limits";
import { testNamespace, waitFor } from "./helpers";

/**
 * A forced close does not wait for the claim loop, so a claim already out when
 * `close({ force: true })` starts can come back with records after the worker
 * — and its target — have closed. Started, such a record met the closed
 * target's refusal and was recorded as a failed attempt: a job that never ran,
 * dead on its only attempt.
 *
 * The race is forced, not hoped for: the driver's claim is held until the
 * close has finished, then lets the claim through.
 */

const processor = join(import.meta.dir, "fixtures", "handlers", "job-ran.ts");

/** Where the fixture notes which workers ran it. */
const store = globalThis as { __jobRanBy?: string[] };

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
  store.__jobRanBy = undefined;
});

/** Capacity in use under the queue's limits: running jobs and rate counts. */
async function usage(
  driver: JobsDriver,
  ref: QueueRef,
): Promise<{ running: number; counted: number }> {
  const entry = await driver.getQueueState!(ref, LIMITER_STATE);
  const state = entry?.value as
    | {
        holders: Record<string, { total: number }>;
        windows: Record<string, { count: number }>;
      }
    | undefined;
  let running = 0;
  let counted = 0;
  for (const holder of Object.values(state?.holders ?? {})) {
    running += holder.total;
  }
  for (const window of Object.values(state?.windows ?? {})) {
    counted += window.count;
  }
  return { running, counted };
}

/** A worker on the queue, running the fixture in-process. */
function worker(driver: JobsDriver, namespace: string): BunQueueWorker {
  const created = new BunQueueWorker("close-race", processor, {
    namespace,
    driver,
    logger: noopLogger,
    target: "in-process",
    concurrency: 1,
    pollInterval: 5,
    lockDuration: 400,
    stalledInterval: 50,
    limitsRefreshInterval: 20,
    waitToExit: false,
  });
  closers.push(async () => await created.close({ force: true }));
  return created;
}

describe("a forced close and a claim still out", () => {
  it("leaves what the claim brings back unstarted, gives back its capacity, and the job runs later", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();
    const queue = new BunQueue("close-race", {
      namespace,
      driver,
      logger: noopLogger,
    });
    closers.push(async () => await queue.close());

    await queue.setLimits({
      concurrency: 5,
      rate: { max: 100, duration: 60_000 },
    });
    const job = await queue.add("once", {}, { attempts: 1 });
    const before = await usage(driver, queue.ref);

    // Hold the first claim until the close has finished.
    let held!: () => void;
    const claimHeld = new Promise<void>((resolve) => {
      held = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claimed: string | undefined;
    const claimJob = driver.claimJob.bind(driver);
    let first = true;
    driver.claimJob = async (q, opts) => {
      if (!first) {
        return await claimJob(q, opts);
      }
      first = false;
      held();
      await gate;
      const record = await claimJob(q, opts);
      claimed = record?.id;
      return record;
    };

    const closing = worker(driver, namespace);
    const loop = closing.run();
    await claimHeld;
    await closing.close({ force: true });
    release();
    await loop;

    // The claim did bring the job back: without that this test shows nothing.
    expect(claimed).toBe(job.id);

    const after = await queue.getJob(job.id);
    // Never run, and not failed: still `active` under the lock nobody renews,
    // with no reason recorded. `attemptsMade` is 1 — the claim itself counts
    // it in the store, as it does for any job that later stalls — not an
    // attempt recorded as failed.
    expect(store.__jobRanBy ?? []).not.toContain(closing.id);
    expect(after?.state).toBe("active");
    expect(after?.failedReason ?? null).toBeNull();
    expect(after?.attemptsMade).toBe(1);

    // What was reserved for the claim is all back.
    expect(await usage(driver, queue.ref)).toEqual(before);

    // The lock lapses, the stalled sweep requeues it — one stall, within the
    // default `maxStalledCount` of 1 — and a later worker runs it.
    const later = worker(driver, namespace);
    void later.run();
    await waitFor(
      async () => (await queue.getJob(job.id))?.state === "completed",
      { timeout: 10_000, message: "the unstarted job was never recovered" },
    );
    const done = await queue.getJob(job.id);
    expect(done?.returnValue).toBe("ran");
    expect(done?.stalledCount).toBe(1);
    expect(store.__jobRanBy).toEqual([later.id]);
  }, 30_000);
});
