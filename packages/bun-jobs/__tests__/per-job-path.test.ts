import type { LogEvent } from "@kingsleyweb/bun-common";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueue, BunQueueWorker, MemoryDriver } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * What a job's trip through the worker must still do after the work it does
 * for every job was trimmed: scoped events reach whoever listens, however late
 * they started or stopped listening; a processor's logger is bound to its job;
 * and a result is stored exactly as JSON would carry it.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

/** A queue and a worker on one memory driver, with `processor` running jobs. */
function setup<TResult>(
  processor: ConstructorParameters<typeof BunQueueWorker<unknown, TResult>>[1],
  logger = noopLogger,
) {
  const driver = new MemoryDriver();
  const namespace = testNamespace();
  const queue = new BunQueue<unknown, TResult>("path", {
    namespace,
    driver,
    logger: noopLogger,
    defaultJobOptions: { removeOnComplete: false },
  });
  const worker = new BunQueueWorker<unknown, TResult>("path", processor, {
    namespace,
    driver,
    logger,
    pollInterval: 5,
    waitToExit: false,
  });
  closers.push(
    () => queue.close(),
    () => worker.close({ force: true }),
  );
  return { queue, worker };
}

describe("BunQueueWorker: scoped events", () => {
  it("reaches a scoped listener added while the worker runs", async () => {
    const { queue, worker } = setup(async () => "done");
    void worker.run();

    // A job first, with no scoped listener anywhere.
    await queue.add("mail", {});
    await Bun.sleep(50);

    const heard: string[] = [];
    worker.on("completed:mail" as "completed", (job) => heard.push(job.id));
    const second = await queue.add("mail", {});

    await waitFor(() => heard.includes(second.id), { timeout: 5_000 });
  });

  it("stops after off(), and after removeAllListeners()", async () => {
    const { queue, worker } = setup(async () => "done");
    const heard: string[] = [];
    const listener = (job: { id: string }) => heard.push(job.id);
    worker.on("completed:mail" as "completed", listener as never);
    void worker.run();

    const first = await queue.add("mail", {});
    await waitFor(() => heard.includes(first.id), { timeout: 5_000 });

    worker.off("completed:mail" as "completed", listener as never);
    const unheard = await queue.add("mail", {});
    await waitFor(
      async () => (await queue.getJob(unheard.id))?.state === "completed",
      { timeout: 5_000 },
    );
    expect(heard).not.toContain(unheard.id);

    // Back on, then everything removed at once.
    worker.on("completed:mail" as "completed", listener as never);
    worker.removeAllListeners();
    const alsoUnheard = await queue.add("mail", {});
    await waitFor(
      async () => (await queue.getJob(alsoUnheard.id))?.state === "completed",
      { timeout: 5_000 },
    );
    expect(heard).toEqual([first.id]);
  });

  it("delivers a once() scoped listener exactly once", async () => {
    const { queue, worker } = setup(async () => "done");
    const heard: string[] = [];
    worker.once("completed:mail" as "completed", (job) => heard.push(job.id));
    void worker.run();

    const first = await queue.add("mail", {});
    const second = await queue.add("mail", {});
    await waitFor(
      async () => (await queue.getJob(second.id))?.state === "completed",
      { timeout: 5_000 },
    );
    expect(heard).toEqual([first.id]);
  });
});

describe("BunQueueWorker: a processor's logger", () => {
  it("is bound to the job it runs", async () => {
    const { logger, events } = createTestLogger();
    const { queue, worker } = setup(async (_job, context) => {
      context.logger.info("working");
      return null;
    }, logger);
    void worker.run();

    const job = await queue.add("report", {});
    await waitFor(
      () => events.some((event: LogEvent) => event.message === "working"),
      { timeout: 5_000 },
    );

    const line = events.find((event: LogEvent) => event.message === "working")!;
    expect(line.bindings).toMatchObject({ jobId: job.id, jobName: "report" });
  });
});

describe("BunQueueWorker: stored results", () => {
  const cases: [string, unknown, unknown][] = [
    ["a string", "done", "done"],
    ["an empty string", "", ""],
    ["a number", 42, 42],
    ["false", false, false],
    ["undefined", undefined, null],
    ["NaN", Number.NaN, null],
    ["Infinity", Number.POSITIVE_INFINITY, null],
  ];

  for (const [label, returned, stored] of cases) {
    it(`stores ${label} as JSON would`, async () => {
      const { queue, worker } = setup(async () => returned);
      void worker.run();

      const job = await queue.add("value", {});
      await waitFor(
        async () => (await queue.getJob(job.id))?.state === "completed",
        { timeout: 5_000 },
      );
      expect((await queue.getJob(job.id))?.returnValue).toEqual(stored);
    });
  }

  it("stores an object as it was when returned, even if mutated before the write", async () => {
    // A networked driver awaits before it serialises, so the write lands a
    // moment after the processor returns. The memory driver copies at once;
    // slowing its completion opens the same window.
    const driver = new MemoryDriver();
    const completeJob = driver.completeJob.bind(driver);
    driver.completeJob = async (...args: Parameters<typeof completeJob>) => {
      await Bun.sleep(20);
      return await completeJob(...args);
    };

    const namespace = testNamespace();
    const queue = new BunQueue("value", {
      namespace,
      driver,
      logger: noopLogger,
      defaultJobOptions: { removeOnComplete: false },
    });
    const worker = new BunQueueWorker(
      "value",
      async () => {
        const result = { count: 1, when: new Date(0) };
        // Changed after it is returned, inside the window before the write.
        setTimeout(() => {
          result.count = 2;
        }, 5);
        return result;
      },
      {
        namespace,
        driver,
        logger: noopLogger,
        pollInterval: 5,
        waitToExit: false,
      },
    );
    closers.push(
      () => queue.close(),
      () => worker.close({ force: true }),
    );
    void worker.run();

    const job = await queue.add("value", {});
    await waitFor(
      async () => (await queue.getJob(job.id))?.state === "completed",
      { timeout: 5_000 },
    );

    expect((await queue.getJob(job.id))?.returnValue as unknown).toEqual({
      count: 1,
      when: "1970-01-01T00:00:00.000Z",
    });
  });
});
