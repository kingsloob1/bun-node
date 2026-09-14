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
