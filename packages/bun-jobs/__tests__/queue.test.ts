import type { BunQueueOptions } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueue, ConfigError, MemoryDriver } from "../lib/index";
import { testNamespace } from "./helpers";

/**
 * The producing and managing side of a queue: what `add` stores, what it
 * refuses, and what the management calls do to jobs that are already there.
 * Consuming is `queue-worker.test.ts`.
 */

const queues: BunQueue<any, any, any>[] = [];

afterEach(async () => {
  await Promise.allSettled(queues.map((queue) => queue.close()));
  queues.length = 0;
});

/** A queue on its own memory driver, tracked for cleanup. */
function makeQueue<TData = any, TResult = any>(
  options: Partial<BunQueueOptions> = {},
): BunQueue<TData, TResult, string> {
  const queue = new BunQueue<TData, TResult, string>("orders", {
    namespace: testNamespace(),
    driver: new MemoryDriver(),
    logger: noopLogger,
    ...options,
  });

  queues.push(queue);
  return queue;
}

describe("BunQueue: adding", () => {
  it("stores a job ready to run", async () => {
    const queue = makeQueue();
    const job = await queue.add("ship", { orderId: 1 });

    expect(job.wasAdded).toBe(true);
    expect(job.state).toBe("waiting");
    expect(job.name).toBe("ship");
    expect(job.data).toEqual({ orderId: 1 });
    expect(job.attemptsMade).toBe(0);
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("treats the job id as an idempotency key", async () => {
    const queue = makeQueue();
    const duplicates: string[] = [];
    queue.on("duplicate", (job) => duplicates.push(job.id));

    const first = await queue.add("ship", { attempt: 1 }, { jobId: "order-7" });
    const second = await queue.add(
      "ship",
      { attempt: 2 },
      { jobId: "order-7" },
    );

    expect(first.wasAdded).toBe(true);
    expect(second.wasAdded).toBe(false);
    // The stored job is untouched: a retrying producer cannot double-enqueue.
    expect(second.data).toEqual({ attempt: 1 });
    expect(duplicates).toEqual(["order-7"]);
    expect(await queue.count("waiting")).toBe(1);
  });

  it("delays a job until its due time", async () => {
    const queue = makeQueue();
    const before = Date.now();

    const delayed = await queue.add("later", {}, { delay: 60_000 });
    expect(delayed.state).toBe("delayed");
    expect(delayed.runAt).toBeGreaterThanOrEqual(before + 60_000);

    const at = new Date(Date.now() + 120_000);
    const scheduled = await queue.add("scheduled", {}, { runAt: at });
    expect(scheduled.runAt).toBe(at.getTime());

    // runAt wins over delay when both are given.
    const both = await queue.add("both", {}, { delay: 5, runAt: at });
    expect(both.runAt).toBe(at.getTime());
  });

  it("applies the queue's defaults under each job's options", async () => {
    const queue = makeQueue({
      defaultJobOptions: { attempts: 5, priority: 3, timeout: 1000 },
    });

    const inherited = await queue.add("a", {});
    expect(inherited.opts).toMatchObject({
      attempts: 5,
      priority: 3,
      timeout: 1000,
    });

    const overridden = await queue.add("b", {}, { attempts: 1 });
    expect(overridden.opts).toMatchObject({ attempts: 1, priority: 3 });
  });

  it("adds many at once", async () => {
    const queue = makeQueue();
    const jobs = await queue.addBulk([
      { name: "a", data: { n: 1 } },
      { name: "b", data: { n: 2 }, opts: { priority: -1 } },
      { name: "c", data: { n: 3 }, opts: { jobId: "fixed" } },
    ]);

    expect(jobs).toHaveLength(3);
    expect(jobs.every((job) => job.wasAdded)).toBe(true);
    expect(jobs[2].id).toBe("fixed");
    expect(await queue.count("waiting")).toBe(3);
  });

  it("refuses what it cannot store or schedule", async () => {
    const queue = makeQueue();

    await expect(queue.add("bad", { big: 1n } as never)).rejects.toThrow(
      /job data/,
    );
    await expect(queue.add("bad", {}, { attempts: 0 })).rejects.toThrow(
      ConfigError,
    );
    await expect(queue.add("bad", {}, { delay: -1 })).rejects.toThrow(/delay/);
    await expect(
      queue.add("bad", {}, { runAt: new Date("nonsense") }),
    ).rejects.toThrow(/runAt/);
  });

  it("requires a namespace and a usable queue name", () => {
    expect(() => new BunQueue("orders", { namespace: "" })).toThrow(
      ConfigError,
    );
    expect(() => new BunQueue("a b", { namespace: "ns" })).toThrow(
      /queue name/,
    );
  });
});

describe("BunQueue: reading", () => {
  it("finds a job by id, and reports a miss", async () => {
    const queue = makeQueue();
    const added = await queue.add("find-me", { x: 1 });

    const found = await queue.getJob(added.id);
    expect(found?.data).toEqual({ x: 1 });
    expect(await queue.getJob("nope")).toBeNull();
  });

  it("lists a state in claim order", async () => {
    const queue = makeQueue();
    await queue.add("normal", {}, { jobId: "n1" });
    await queue.add("normal", {}, { jobId: "n2" });
    await queue.add("urgent", {}, { jobId: "u1", priority: -5 });

    const waiting = await queue.list("waiting");
    expect(waiting.map((job) => job.id)).toEqual(["u1", "n1", "n2"]);

    const page = await queue.list("waiting", { offset: 1, limit: 1 });
    expect(page.map((job) => job.id)).toEqual(["n1"]);
  });

  it("counts every state at once, or one", async () => {
    const queue = makeQueue();
    await queue.add("now", {});
    await queue.add("later", {}, { delay: 10_000 });

    expect(await queue.count()).toMatchObject({ waiting: 1, delayed: 1 });
    expect(await queue.count("waiting")).toBe(1);
    expect(await queue.count("dead")).toBe(0);
  });
});

describe("BunQueue: managing", () => {
  it("removes a job", async () => {
    const queue = makeQueue();
    const removed: string[] = [];
    queue.on("removed", (id) => removed.push(id));

    const job = await queue.add("gone", {});
    expect(await queue.remove(job.id)).toBe(true);
    expect(await queue.getJob(job.id)).toBeNull();
    expect(removed).toEqual([job.id]);
    expect(await queue.remove(job.id)).toBe(false);
  });

  it("promotes a delayed job", async () => {
    const queue = makeQueue();
    const job = await queue.add("later", {}, { delay: 60_000 });

    expect(await queue.promote(job.id)).toBe(true);
    expect((await queue.getJob(job.id))?.state).toBe("waiting");
  });

  it("pauses and resumes for every process", async () => {
    const queue = makeQueue();

    expect(await queue.isPaused()).toBe(false);
    await queue.pause();
    expect(await queue.isPaused()).toBe(true);
    await queue.resume();
    expect(await queue.isPaused()).toBe(false);
  });

  it("drains pending jobs, optionally including delayed ones", async () => {
    const queue = makeQueue();
    await queue.add("a", {});
    await queue.add("b", {}, { delay: 10_000 });

    expect(await queue.drain()).toBe(1);
    expect(await queue.count("delayed")).toBe(1);
    expect(await queue.drain({ delayed: true })).toBe(1);
    expect(await queue.count()).toMatchObject({ waiting: 0, delayed: 0 });
  });

  it("cleans finished jobs older than a cutoff", async () => {
    const queue = makeQueue();

    // Reach past the producer API to plant an old completed job.
    await queue.driver.addJob(queue.ref, {
      ...(await queue.add("old", {})).toJSON(),
      id: "stale",
      state: "completed",
      finishedOn: Date.now() - 100_000,
    });

    const cleaned = await queue.clean("completed", { olderThan: 50_000 });
    expect(cleaned).toEqual(["stale"]);
  });
});

describe("BunQueue: events", () => {
  it("reports what was added and where it went", async () => {
    const queue = makeQueue();
    const seen: string[] = [];

    queue.on("added", () => seen.push("added"));
    queue.on("waiting", () => seen.push("waiting"));
    queue.on("delayed", () => seen.push("delayed"));

    await queue.add("now", {});
    await queue.add("later", {}, { delay: 10_000 });

    expect(seen).toEqual(["added", "waiting", "added", "delayed"]);
  });

  it("costs nothing when nobody is listening", async () => {
    const queue = makeQueue();
    // No listener means no emitter is even built.
    expect(queue.eventNames()).toEqual([]);
    await queue.add("quiet", {});
  });
});
