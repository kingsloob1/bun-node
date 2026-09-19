import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  ConfigError,
  MemoryDriver,
  newToken,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * What a job can do to itself — and a queue to a job — after it was added:
 * change its data, priority and run time, and keep a log.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

/** A queue on a memory driver. */
function setup() {
  const driver = new MemoryDriver();
  const namespace = testNamespace();
  const queue = new BunQueue<{ v: number }>("methods", {
    namespace,
    driver,
    logger: noopLogger,
  });
  closers.push(() => queue.close());
  return { driver, namespace, queue };
}

describe("changing a job", () => {
  it("updateData replaces the payload and answers with the job as it now is", async () => {
    const { queue } = setup();
    const job = await queue.add("x", { v: 1 });

    const updated = await job.updateData({ v: 2 });

    expect(updated?.data).toEqual({ v: 2 });
    expect(updated?.wasAdded).toBe(false);
    expect((await queue.getJob(job.id))?.data).toEqual({ v: 2 });
    // The view it was called on stays what it was.
    expect(job.data).toEqual({ v: 1 });
  });

  it("setPriority moves a waiting job in claim order", async () => {
    const { driver, queue } = setup();
    await queue.add("x", { v: 1 }, { priority: 5 });
    const later = await queue.add("x", { v: 2 }, { priority: 5 });

    await later.setPriority(1);

    const claimed = await driver.claimJob(queue.ref, {
      workerId: "w",
      token: newToken(),
      lockMs: 10_000,
      now: Date.now(),
    });
    expect(claimed?.id).toBe(later.id);
    await expect(later.setPriority(Number.NaN)).rejects.toThrow(ConfigError);
  });

  it("reschedule moves a pending job, in words or as a date, and refuses a running one", async () => {
    const { driver, queue } = setup();
    const job = await queue.add("x", { v: 1 });

    const before = Date.now();
    const later = await job.reschedule("in 10 minutes");
    expect(later?.state).toBe("delayed");
    expect(later?.runAt).toBeGreaterThanOrEqual(before + 600_000);

    const now = await job.reschedule(new Date(Date.now() - 1_000));
    expect(now?.state).toBe("waiting");

    await driver.claimJob(queue.ref, {
      workerId: "w",
      token: newToken(),
      lockMs: 10_000,
      now: Date.now(),
    });
    expect(await job.reschedule(Date.now() + 60_000)).toBeNull();
  });

  it("queue.update changes what it names, conditionally on state", async () => {
    const { queue } = setup();
    const job = await queue.add("x", { v: 1 }, { delay: 60_000 });

    expect(
      await queue.update(job.id, { data: { v: 9 }, onlyIn: ["waiting"] }),
    ).toBeNull();

    const updated = await queue.update(job.id, {
      data: { v: 9 },
      priority: 3,
      runAt: new Date(Date.now() - 1),
      onlyIn: ["delayed"],
    });

    expect(updated?.data).toEqual({ v: 9 });
    expect(updated?.priority).toBe(3);
    expect(updated?.state).toBe("waiting");
    expect(await queue.update("missing", { priority: 1 })).toBeNull();
  });

  it("touch extends the lock of a running job", async () => {
    const { driver, namespace, queue } = setup();
    let touched: boolean | undefined;

    const worker = new BunQueueWorker(
      "methods",
      async (job) => {
        touched = await job.touch(60_000);
        return null;
      },
      { namespace, driver, logger: noopLogger, pollInterval: 5 },
    );
    closers.push(() => worker.close({ force: true }));
    void worker.run();

    await queue.add("x", { v: 1 });
    await waitFor(() => touched !== undefined, { timeout: 5_000 });
    expect(touched).toBe(true);
  });
});

describe("the 2.12 job methods", () => {
  it("schedule moves a pending job as reschedule does", async () => {
    const { queue } = setup();
    const job = await queue.add("x", { v: 1 });

    const before = Date.now();
    const later = await job.schedule("in 10 minutes");
    expect(later?.state).toBe("delayed");
    expect(later?.runAt).toBeGreaterThanOrEqual(before + 600_000);
    expect((await job.schedule(new Date(0)))?.state).toBe("waiting");
  });

  it("update changes data, priority and run time in one step, conditionally on state", async () => {
    const { queue } = setup();
    const job = await queue.add("x", { v: 1 }, { delay: 60_000 });

    expect(
      await job.update({ data: { v: 2 }, onlyIn: ["waiting"] }),
    ).toBeNull();
    expect((await queue.getJob(job.id))?.data).toEqual({ v: 1 });

    const updated = await job.update({
      data: { v: 3 },
      priority: 4,
      runAt: "in 1 hour",
      onlyIn: ["delayed"],
    });
    expect(updated?.data).toEqual({ v: 3 });
    expect(updated?.priority).toBe(4);
    expect(updated?.runAt).toBeGreaterThan(Date.now() + 3_000_000);
    expect(updated?.wasAdded).toBe(false);

    await expect(job.update({ priority: Number.NaN })).rejects.toThrow(
      ConfigError,
    );
    await queue.remove(job.id);
    expect(await job.update({ priority: 1 })).toBeNull();
  });

  it("a refreshed or updated view is still the processor's own", async () => {
    const { driver, namespace, queue } = setup();
    const answers: boolean[] = [];

    const worker = new BunQueueWorker<{ v: number }>(
      "methods",
      async (job) => {
        const refreshed = await job.refresh();
        answers.push(await refreshed!.touch(60_000));
        const updated = await job.updateData({ v: 2 });
        answers.push(await updated!.extendLock(60_000));
        return null;
      },
      { namespace, driver, logger: noopLogger, pollInterval: 5 },
    );
    closers.push(() => worker.close({ force: true }));
    void worker.run();

    await queue.add("x", { v: 1 });
    await waitFor(() => answers.length === 2, { timeout: 5_000 });
    expect(answers).toEqual([true, true]);
  });

  it("extendLock and touch answer false from a view that is not the processor's", async () => {
    const { driver, namespace, queue } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;

    const worker = new BunQueueWorker<{ v: number }>(
      "methods",
      async () => {
        started = true;
        await gate;
        return null;
      },
      { namespace, driver, logger: noopLogger, pollInterval: 5 },
    );
    closers.push(() => worker.close({ force: true }));
    void worker.run();

    const job = await queue.add("x", { v: 1 });
    await waitFor(() => started);

    const outside = await queue.getJob(job.id);
    expect(outside?.state).toBe("active");
    expect(outside?.lockToken).not.toBeNull();
    expect(await outside!.extendLock(600_000)).toBe(false);
    expect(await outside!.touch(600_000)).toBe(false);
    // The lock is where the worker put it, not ten minutes out.
    const record = await driver.getJob(queue.ref, job.id);
    expect(record!.lockExpiresAt!).toBeLessThan(Date.now() + 300_000);
    release();
  });

  it("remove, promote and retry emit and publish what the queue's own methods do", async () => {
    const { driver, namespace, queue } = setup();
    const local: string[] = [];
    queue.on("removed", (id) => {
      local.push(`removed ${id}`);
    });
    queue.on("promoted", (id) => {
      local.push(`promoted ${id}`);
    });
    queue.on("retried", (ids) => {
      local.push(`retried ${ids.join(",")}`);
    });

    const listener = new BunQueue("methods", {
      namespace,
      driver,
      logger: noopLogger,
      subscribe: true,
    });
    closers.push(() => listener.close());
    await listener.connect();
    const remote: string[] = [];
    listener.on("removed", (id) => {
      remote.push(`removed ${id}`);
    });
    listener.on("promoted", (id) => {
      remote.push(`promoted ${id}`);
    });
    listener.on("retried", (ids) => {
      remote.push(`retried ${ids.join(",")}`);
    });
    const publisher = new BunQueue<{ v: number }>("methods", {
      namespace,
      driver,
      logger: noopLogger,
      publish: true,
    });
    closers.push(() => publisher.close());

    const later = await queue.add("x", { v: 1 }, { delay: 60_000 });
    const gone = await queue.add("x", { v: 2 });
    const dead = await queue.add("x", { v: 3 });
    await dead.fail("to retry");

    expect(await later.promote()).toBe(true);
    expect(await gone.remove()).toBe(true);
    expect(await dead.retry()).toBe(true);
    expect(local).toEqual([
      `promoted ${later.id}`,
      `removed ${gone.id}`,
      `retried ${dead.id}`,
    ]);

    // A view from a publishing queue is heard in other processes.
    const published = await publisher.add("x", { v: 4 }, { delay: 60_000 });
    await published.promote();
    await published.fail("stop");
    await published.retry();
    await waitFor(() => remote.length >= 2);
    expect(remote).toEqual([
      `promoted ${published.id}`,
      `retried ${published.id}`,
    ]);

    // Nothing is announced for a change that did not happen.
    expect(await gone.remove()).toBe(false);
    expect(local).toHaveLength(3);
  });

  it("reads progress as a number, a record, or null", async () => {
    const { driver, queue } = setup();
    const job = await queue.add("x", { v: 1 });
    expect(job.progress).toBeNull();

    await job.updateProgress(40);
    expect((await job.refresh())?.progress).toBe(40);
    await job.updateProgress({ step: "b" });
    expect((await job.refresh())?.progress).toEqual({ step: "b" });

    // A value `updateProgress` would never have written reads as none.
    await driver.updateProgress(queue.ref, job.id, ["not", "progress"]);
    expect((await job.refresh())?.progress).toBeNull();
  });
});

describe("a job's log", () => {
  it("is written from the processor and read from anywhere", async () => {
    const { driver, namespace, queue } = setup();

    const worker = new BunQueueWorker<{ v: number }>(
      "methods",
      async (job, context) => {
        await context.log("starting");
        await job.log(`processing v${job.data.v}`);
        await context.log("done");
        return null;
      },
      { namespace, driver, logger: noopLogger, pollInterval: 5 },
    );
    closers.push(() => worker.close({ force: true }));

    const job = await queue.add("x", { v: 4 }, { removeOnComplete: false });
    void worker.run();
    await waitFor(
      async () => (await queue.getJob(job.id))?.state === "completed",
      { timeout: 5_000 },
    );

    expect(await queue.getJobLogs(job.id)).toEqual({
      logs: ["starting", "processing v4", "done"],
      count: 3,
    });
    expect(await job.getLogs({ order: "desc", limit: 1 })).toEqual({
      logs: ["done"],
      count: 3,
    });
  });

  it("keeps only as many lines as the job asks for", async () => {
    const { queue } = setup();
    const job = await queue.add("x", { v: 1 }, { keepLogs: 2 });

    for (const line of ["one", "two", "three"]) {
      await job.log(line);
    }

    expect(await job.getLogs()).toEqual({ logs: ["two", "three"], count: 2 });
  });

  it("refuses a keepLogs that is not a whole number", async () => {
    const { queue } = setup();
    await expect(queue.add("x", { v: 1 }, { keepLogs: -1 })).rejects.toThrow(
      ConfigError,
    );
  });

  it("is set from the builder", async () => {
    const jobs = new BunJobs({
      namespace: testNamespace(),
      driver: new MemoryDriver(),
      logger: noopLogger,
    });
    closers.push(() => jobs.close());
    jobs.define("x", async () => null);

    const job = await jobs.run("x").keepLogs(1).start();
    await job.log("a");
    await job.log("b");
    expect((await job.getLogs()).logs).toEqual(["b"]);
  });
});
