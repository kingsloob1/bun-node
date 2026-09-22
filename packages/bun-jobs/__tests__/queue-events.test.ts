import type { JobsDriver } from "../lib/index";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import {
  BunQueue,
  BunQueueWorker,
  MemoryDriver,
  RedisDriver,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * The events a producer can observe about work it did not run.
 *
 * Every one of these was declared and never fired. `BunQueue` listed
 * `active`, `progress`, `completed`, `failed`, `retrying`, `dead` and
 * `stalled` in its event map, but only a worker knows any of them happened and
 * the worker never published — so a producer, or a dashboard, could observe
 * only what it had done itself.
 *
 * These check the whole path: the worker publishes, the driver carries it, and
 * the queue re-emits it with the arguments its *local* signature takes. That
 * last part is what the old code got wrong for half the events, and it is only
 * visible end to end.
 */

/** The server to test the cross-process path against, when one is configured. */
const REDIS = process.env.BUN_JOBS_TEST_REDIS_URL;

/** Drivers to close when the suite ends. */
const drivers: JobsDriver[] = [];

afterAll(async () => {
  await Promise.allSettled(drivers.map((driver) => driver.close()));
});

/** A queue and a worker over one driver, both announcing and listening. */
async function pair(driver: JobsDriver, queueName: string) {
  const namespace = testNamespace();
  const queue = new BunQueue(queueName, {
    driver,
    namespace,
    subscribe: true,
    defaultJobOptions: { attempts: 1, removeOnComplete: false },
  });

  return { namespace, queue };
}

describe("queue events: what a producer can see of a worker's run", () => {
  it("carries a job's whole life back to the producer", async () => {
    const driver = new MemoryDriver();
    drivers.push(driver);
    const { namespace, queue } = await pair(driver, "lifecycle");

    /** Every event the producer saw, with the arguments it was given. */
    const seen: [string, ...unknown[]][] = [];
    for (const name of [
      "added",
      "waiting",
      "active",
      "progress",
      "completed",
    ] as const) {
      queue.on(name, (...args: unknown[]) => seen.push([name, ...args]));
    }

    const worker = new BunQueueWorker(
      "lifecycle",
      async (job) => {
        await job.updateProgress(42);
        return { ok: true };
      },
      {
        driver,
        namespace,
        publish: true,
        concurrency: 1,
        pollInterval: 10,
        maxBlock: 20,
      },
    );

    try {
      // `run()` resolves when the worker stops, not when it starts.
      void worker.run();
      await queue.add("work", { hello: "world" });
      await waitFor(() => seen.some(([name]) => name === "completed"), {
        message: "the producer never saw the job complete",
        timeout: 10_000,
      });

      const names = seen.map(([name]) => name);
      expect(names).toContain("added");
      expect(names).toContain("waiting");
      expect(names).toContain("active");
      expect(names).toContain("progress");
      expect(names).toContain("completed");

      // The arguments, not just the names. This is what the old receive path
      // got wrong: it handed every listener `(job)` whatever the signature.
      const progress = seen.find(([name]) => name === "progress");
      expect(progress?.[2]).toBe(42);

      const completed = seen.find(([name]) => name === "completed");
      expect(completed?.[2]).toEqual({ ok: true });
    } finally {
      await worker.close({ force: true });
      await queue.close();
    }
  }, 30_000);

  it("reports a failure with a real Error, not a serialised one", async () => {
    const driver = new MemoryDriver();
    drivers.push(driver);
    const { namespace, queue } = await pair(driver, "failing");

    const failures: unknown[] = [];
    queue.on("failed", (_job, error) => failures.push(error));
    queue.on("dead", (_job, error) => failures.push(error));

    const worker = new BunQueueWorker(
      "failing",
      async () => {
        throw new Error("deliberate");
      },
      {
        driver,
        namespace,
        publish: true,
        concurrency: 1,
        pollInterval: 10,
        maxBlock: 20,
      },
    );

    try {
      void worker.run();
      await queue.add("work", {});
      await waitFor(() => failures.length >= 2, {
        message: "the producer never saw the failure",
        timeout: 10_000,
      });

      // An `Error` cannot cross JSON, so the wire carries a `SerializedError`.
      // A listener should never have to know that.
      for (const failure of failures) {
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe("deliberate");
      }
    } finally {
      await worker.close({ force: true });
      await queue.close();
    }
  }, 30_000);

  it.skipIf(!REDIS)(
    "crosses a real transport",
    async () => {
      // The memory driver delivers in-process, which proves the wiring but not
      // the envelope: Redis round-trips it through JSON on a pub/sub channel,
      // which is where a payload that does not serialise would show up.
      const producerDriver = new RedisDriver({ url: REDIS });
      const workerDriver = new RedisDriver({ url: REDIS });
      drivers.push(producerDriver, workerDriver);

      const namespace = testNamespace();
      const queue = new BunQueue("across", {
        driver: producerDriver,
        namespace,
        subscribe: true,
        defaultJobOptions: { attempts: 1, removeOnComplete: false },
      });

      const seen: [string, ...unknown[]][] = [];
      for (const name of ["active", "progress", "completed"] as const) {
        queue.on(name, (...args: unknown[]) => seen.push([name, ...args]));
      }

      const worker = new BunQueueWorker(
        "across",
        async (job) => {
          await job.updateProgress({ percent: 50 });
          return { done: true };
        },
        {
          driver: workerDriver,
          namespace,
          publish: true,
          concurrency: 1,
          pollInterval: 10,
          maxBlock: 20,
        },
      );

      try {
        void worker.run();
        await queue.add("work", { across: true });
        await waitFor(() => seen.some(([name]) => name === "completed"), {
          message: "nothing crossed the transport",
          timeout: 15_000,
        });

        expect(seen.map(([name]) => name)).toContain("active");
        expect(seen.find(([name]) => name === "progress")?.[2]).toEqual({
          percent: 50,
        });
        expect(seen.find(([name]) => name === "completed")?.[2]).toEqual({
          done: true,
        });
      } finally {
        await worker.close({ force: true });
        await queue.close();
        // Exactly the namespace this test made, never a prefix sweep: the
        // server is shared. Through both drivers, since each forgets only
        // the analytics it buffered itself, and a buffer left behind would
        // be written back when that driver closes.
        await workerDriver.purge(namespace);
        await producerDriver.purge(namespace);
      }
    },
    45_000,
  );
});

describe("per-job-name events", () => {
  /**
   * `completed:sendEmail` fires only for jobs named `sendEmail`.
   *
   * A consumer running twenty kinds of job through one queue would otherwise
   * filter by name inside every listener — noisier to write, and slower,
   * because every listener runs for every job.
   */
  it("fires for the named job and no other", async () => {
    const driver = new MemoryDriver();
    drivers.push(driver);
    const { namespace, queue } = await pair(driver, "by-name");

    const emails: string[] = [];
    const reports: string[] = [];
    const all: string[] = [];

    queue.on("completed:sendEmail", (job) => emails.push(job.id));
    queue.on("completed:buildReport", (job) => reports.push(job.id));
    queue.on("completed", (job) => all.push(job.id));

    const worker = new BunQueueWorker("by-name", async () => null, {
      driver,
      namespace,
      publish: true,
      concurrency: 1,
      pollInterval: 10,
      maxBlock: 20,
    });

    try {
      void worker.run();
      const email = await queue.add("sendEmail", {});
      const report = await queue.add("buildReport", {});

      await waitFor(() => all.length >= 2, {
        message: "both jobs should have completed",
        timeout: 10_000,
      });

      // Each qualified listener saw only its own, and the unqualified one saw
      // both — a listener that wants everything is unaffected by this.
      expect(emails).toEqual([email.id]);
      expect(reports).toEqual([report.id]);
      expect(all.sort()).toEqual([email.id, report.id].sort());
    } finally {
      await worker.close({ force: true });
      await queue.close();
    }
  }, 30_000);

  it("reaches a listener that only wants the qualified form", async () => {
    const driver = new MemoryDriver();
    drivers.push(driver);
    const { namespace, queue } = await pair(driver, "only-qualified");

    // A remote event costs a fetch, so one nobody wants is dropped before
    // paying for it — and that check used to ask only about the unqualified
    // name. Someone listening for `progress:slowThing` alone would have been
    // skipped, which is the whole case the qualified form exists for.
    const progress: unknown[] = [];
    queue.on("progress:slowThing", (_job, value) => progress.push(value));

    const worker = new BunQueueWorker(
      "only-qualified",
      async (job) => {
        await job.updateProgress(75);
        return null;
      },
      {
        driver,
        namespace,
        publish: true,
        concurrency: 1,
        pollInterval: 10,
        maxBlock: 20,
      },
    );

    try {
      void worker.run();
      await queue.add("slowThing", {});

      await waitFor(() => progress.length > 0, {
        message: "the qualified listener never heard anything",
        timeout: 10_000,
      });
      expect(progress).toEqual([75]);
    } finally {
      await worker.close({ force: true });
      await queue.close();
    }
  }, 30_000);
});
