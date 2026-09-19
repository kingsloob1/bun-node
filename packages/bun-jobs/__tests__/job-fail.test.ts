import type { Job, JobsDriver } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunQueue,
  BunQueueWorker,
  ConfigError,
  MemoryDriver,
  NotSupportedError,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * `Job.fail()`: failing a job for good, from inside its processor or from
 * anywhere else.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

/** A queue on a memory driver, and what it takes to make more. */
function setup(driver: JobsDriver = new MemoryDriver()) {
  const namespace = testNamespace("fail");
  const queue = new BunQueue<{ v: number }, unknown>("work", {
    namespace,
    driver,
    logger: noopLogger,
  });
  closers.push(() => queue.close());
  return { driver, namespace, queue };
}

/** A worker on `queue`, running, closed after the test. */
function startWorker(
  namespace: string,
  driver: JobsDriver,
  processor: (job: Job<{ v: number }, unknown>) => Promise<unknown>,
  options: {
    /** Heartbeat interval, ms. */
    heartbeatInterval?: number;
    /** Whether maintenance runs. */
    maintenance?: boolean;
    /** Stalled sweep interval, ms. */
    stalledInterval?: number;
    /** The worker's dead-letter queue. */
    deadLetterQueue?: string;
    /** The queue to consume. */
    queue?: string;
  } = {},
) {
  const worker = new BunQueueWorker<{ v: number }, unknown>(
    options.queue ?? "work",
    processor,
    {
      namespace,
      driver,
      logger: noopLogger,
      pollInterval: 5,
      maintenance: options.maintenance ?? false,
      ...(options.heartbeatInterval !== undefined
        ? { heartbeatInterval: options.heartbeatInterval }
        : {}),
      ...(options.stalledInterval !== undefined
        ? { stalledInterval: options.stalledInterval }
        : {}),
      ...(options.deadLetterQueue !== undefined
        ? { deadLetterQueue: options.deadLetterQueue }
        : {}),
    },
  );
  closers.push(() => worker.close({ force: true }));
  void worker.run();
  return worker;
}

describe("failing a job from outside its processor", () => {
  it("buries a waiting, delayed or retry-pending job for good, whatever attempts it has left", async () => {
    const { queue } = setup();
    const waiting = await queue.add("x", { v: 1 }, { attempts: 5 });
    const delayed = await queue.add("x", { v: 2 }, { delay: 60_000 });

    const cause = new TypeError("bad input");
    expect(await waiting.fail(cause)).toBe(true);
    expect(await delayed.fail("changed my mind")).toBe(true);

    const buried = await queue.getJob(waiting.id);
    expect(buried?.state).toBe("dead");
    expect(buried?.attemptsMade).toBe(0);
    expect(buried?.failedReason?.name).toBe("UnrecoverableJobError");
    expect(buried?.failedReason?.message).toBe("bad input");
    expect((await queue.getJob(delayed.id))?.failedReason?.message).toBe(
      "changed my mind",
    );
    expect(await queue.count("dead")).toBe(2);
  });

  it("answers false for a job that is finished or gone", async () => {
    const { queue } = setup();
    const job = await queue.add("x", { v: 1 });

    expect(await job.fail("once")).toBe(true);
    expect(await job.fail("twice")).toBe(false);
    expect((await queue.getJob(job.id))?.failedReason?.message).toBe("once");

    const removed = await queue.add("x", { v: 2 });
    await queue.remove(removed.id);
    expect(await removed.fail("gone")).toBe(false);
  });

  it("emits and publishes failed and dead, as a job that died running does", async () => {
    const { driver, namespace, queue } = setup();
    const heard: string[] = [];
    queue.on("failed", (job, error) => {
      heard.push(`local failed ${job.id} ${error.message}`);
    });
    queue.on("dead", (job) => heard.push(`local dead ${job.id}`));

    // Another process's queue, as far as events go.
    const elsewhere = new BunQueue("work", {
      namespace,
      driver,
      logger: noopLogger,
      subscribe: true,
    });
    closers.push(() => elsewhere.close());
    await elsewhere.connect();
    elsewhere.on("dead", (job, error) => {
      heard.push(`remote dead ${job.id} ${error.message}`);
    });

    const publishing = new BunQueue<{ v: number }>("work", {
      namespace,
      driver,
      logger: noopLogger,
      publish: true,
    });
    closers.push(() => publishing.close());

    const job = await publishing.add("x", { v: 1 });
    // Through the queue that is listened to, and the one that publishes.
    await (await queue.getJob(job.id))!.fail("stop");
    const other = await publishing.add("x", { v: 2 });
    await other.fail("stop too");

    await waitFor(() => heard.some((line) => line.startsWith("remote")));
    expect(heard).toContain(`local failed ${job.id} stop`);
    expect(heard).toContain(`local dead ${job.id}`);
    expect(heard).toContain(`remote dead ${other.id} stop too`);
  });

  it("buries an active job under its lock: the worker loses it, and its result is discarded", async () => {
    const { driver, namespace, queue } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;

    const worker = startWorker(
      namespace,
      driver,
      async (_job) => {
        started = true;
        await gate;
        return "finished anyway";
      },
      { heartbeatInterval: 20 },
    );
    const lost: string[] = [];
    const completed: string[] = [];
    worker.on("lockLost", (job) => lost.push(job.id));
    worker.on("completed", (job) => completed.push(job.id));

    const job = await queue.add("x", { v: 1 });
    await waitFor(() => started);

    const active = await queue.getJob(job.id);
    expect(active?.state).toBe("active");
    expect(await active!.fail("pulled")).toBe(true);

    // The next heartbeat finds the lock gone and aborts the attempt.
    await waitFor(() => lost.length > 0, { timeout: 2_000 });
    release();
    // Its completion is refused too: reported as a lost lock, never as done.
    await waitFor(() => lost.length >= 2, { timeout: 2_000 });

    expect(completed).toEqual([]);
    const after = await queue.getJob(job.id);
    expect(after?.state).toBe("dead");
    expect(after?.returnValue).toBeNull();
    expect(after?.failedReason?.message).toBe("pulled");
  });

  it("files a copy in the job's own deadLetter queue, never a worker's", async () => {
    const { driver, namespace, queue } = setup();
    const letters = new BunQueue("letters", {
      namespace,
      driver,
      logger: noopLogger,
    });
    closers.push(() => letters.close());

    const job = await queue.add("x", { v: 7 }, { deadLetter: "letters" });
    const plain = await queue.add("x", { v: 8 });
    expect(await job.fail("to the letters")).toBe(true);
    expect(await plain.fail("nowhere to go")).toBe(true);

    const filed = await letters.list("waiting");
    expect(filed).toHaveLength(1);
    expect(filed[0]?.data).toMatchObject({
      queue: "work",
      id: job.id,
      data: { v: 7 },
      failedReason: { message: "to the letters" },
    });
  });

  it("refuses to file a letter in the job's own queue, with the job dead regardless", async () => {
    const { queue } = setup();
    const job = await queue.add("x", { v: 1 }, { deadLetter: "work" });

    await expect(job.fail("loop")).rejects.toThrow(ConfigError);
    expect((await queue.getJob(job.id))?.state).toBe("dead");
    expect(await queue.count("waiting")).toBe(0);
  });

  it("fails a flow child's parent once maintenance delivers the child's failure", async () => {
    const { driver, namespace, queue } = setup();
    const flow = await queue.addFlow({
      name: "parent",
      data: { v: 0 },
      children: [{ name: "child", data: { v: 1 }, queue: "kids" }],
    });
    const child = flow.children[0]!.job;
    expect((await queue.getJob(flow.job.id))?.state).toBe("waiting-children");

    expect(await child.fail("child gave up")).toBe(true);

    // Maintenance on the child's queue finds the undelivered failure.
    startWorker(namespace, driver, async () => null, {
      queue: "kids",
      maintenance: true,
      stalledInterval: 20,
    });
    await waitFor(
      async () => (await queue.getJob(flow.job.id))?.state === "dead",
      { timeout: 3_000 },
    );
  });

  it("throws NotSupportedError on a driver without buryJob", async () => {
    const memory = new MemoryDriver();
    const limited = new Proxy(memory, {
      get(target, property) {
        if (property === "buryJob") {
          return undefined;
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as JobsDriver;
    const { queue } = setup(limited);
    const job = await queue.add("x", { v: 1 });

    await expect(job.fail("nope")).rejects.toThrow(NotSupportedError);
    expect((await queue.getJob(job.id))?.state).toBe("waiting");
  });
});

describe("failing a job from its own processor", () => {
  it("ends the attempt dead once the processor returns, with no retry", async () => {
    const { driver, namespace, queue } = setup();
    const events: string[] = [];
    const worker = startWorker(namespace, driver, async (job) => {
      expect(await job.fail("not worth retrying")).toBe(true);
      return "ignored";
    });
    worker.on("completed", () => events.push("completed"));
    worker.on("retrying", () => events.push("retrying"));
    worker.on("dead", (_job, error) => events.push(`dead ${error.message}`));

    const job = await queue.add("x", { v: 1 }, { attempts: 3 });
    await waitFor(async () => (await queue.getJob(job.id))?.state === "dead");

    const dead = await queue.getJob(job.id);
    expect(dead?.attemptsMade).toBe(1);
    expect(dead?.returnValue).toBeNull();
    expect(dead?.failedReason?.name).toBe("UnrecoverableJobError");
    expect(dead?.failedReason?.message).toBe("not worth retrying");
    await waitFor(() => events.length > 0);
    expect(events).toEqual(["dead not worth retrying"]);
  });

  it("keeps the reason given to fail over whatever is thrown after it", async () => {
    const { driver, namespace, queue } = setup();
    startWorker(namespace, driver, async (job) => {
      await job.fail("the real reason");
      throw new Error("thrown to stop");
    });

    const job = await queue.add("x", { v: 1 }, { attempts: 3 });
    await waitFor(async () => (await queue.getJob(job.id))?.state === "dead");
    const dead = await queue.getJob(job.id);
    expect(dead?.failedReason?.message).toBe("the real reason");
    expect(dead?.attemptsMade).toBe(1);
  });

  it("files the letter in the worker's deadLetterQueue, as any death there does", async () => {
    const { driver, namespace, queue } = setup();
    const letters = new BunQueue("worker-letters", {
      namespace,
      driver,
      logger: noopLogger,
    });
    closers.push(() => letters.close());
    startWorker(
      namespace,
      driver,
      async (job) => {
        await job.fail("dead here");
        return null;
      },
      { deadLetterQueue: "worker-letters" },
    );

    const job = await queue.add("x", { v: 1 });
    await waitFor(async () => (await letters.count("waiting")) === 1);
    expect((await letters.list("waiting"))[0]?.data).toMatchObject({
      id: job.id,
    });
  });

  it("buries like anyone else once the attempt has settled", async () => {
    const { driver, namespace, queue } = setup();
    let kept: Job<{ v: number }, unknown> | undefined;
    startWorker(namespace, driver, async (job) => {
      kept = job;
      return "done";
    });

    const job = await queue.add("x", { v: 1 }, { removeOnComplete: false });
    await waitFor(
      async () => (await queue.getJob(job.id))?.state === "completed",
    );
    // The processor's own view, after the fact: the job is finished.
    expect(await kept!.fail("too late")).toBe(false);
    expect((await queue.getJob(job.id))?.state).toBe("completed");
  });
});
