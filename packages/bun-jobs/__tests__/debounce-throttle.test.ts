import type { JobsDriver } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  ConfigError,
  FileDriver,
  MemoryDriver,
  newToken,
} from "../lib/index";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * Debouncing and throttling: one job for many adds, across producers.
 *
 * Run against the memory driver and the file driver, which between them
 * cover an in-process compare-and-set and one that goes through the disk.
 */

/** What the test jobs carry. */
interface Doc {
  /** Which version of the document this add describes. */
  version: number;
}

const backends: {
  name: string;
  make: () => Promise<{ driver: JobsDriver; cleanup: () => Promise<void> }>;
}[] = [
  {
    name: "memory",
    make: async () => ({ driver: new MemoryDriver(), cleanup: async () => {} }),
  },
  {
    name: "file",
    make: async () => {
      const tmp = await makeTmpDir("windowed");
      return {
        driver: new FileDriver({ root: tmp.path }),
        cleanup: tmp.cleanup,
      };
    },
  },
];

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

for (const backend of backends) {
  describe(`debounce and throttle: ${backend.name}`, () => {
    /** A queue on a fresh backend. */
    async function setup() {
      const { driver, cleanup } = await backend.make();
      const namespace = testNamespace();
      const queue = new BunQueue<Doc>("windowed", {
        namespace,
        driver,
        logger: noopLogger,
      });
      closers.push(
        cleanup,
        () => driver.close(),
        () => queue.close(),
      );
      return { driver, namespace, queue };
    }

    /** Every job in the queue, whatever its state. */
    async function everyJob(queue: BunQueue<Doc>) {
      return await queue.list([
        "waiting",
        "delayed",
        "active",
        "completed",
        "failed",
        "dead",
      ]);
    }

    describe("debounce", () => {
      it("keeps one pending job, with the latest data and a pushed-back run time", async () => {
        const { queue } = await setup();
        const debounced: string[] = [];
        queue.on("debounced", (job) => debounced.push(job.id));

        const first = await queue.add(
          "reindex",
          { version: 1 },
          { debounce: { id: "doc-7", ttl: 5_000 } },
        );
        await Bun.sleep(20);
        const second = await queue.add(
          "reindex",
          { version: 2 },
          { debounce: { id: "doc-7", ttl: 5_000 } },
        );
        const beforeThird = Date.now();
        const third = await queue.add(
          "reindex",
          { version: 3 },
          { debounce: { id: "doc-7", ttl: "5 seconds" } },
        );

        expect(first.wasAdded).toBe(true);
        expect(second.id).toBe(first.id);
        expect(third.id).toBe(first.id);
        expect(third.wasAdded).toBe(false);
        expect(debounced).toEqual([first.id, first.id]);

        const jobs = await everyJob(queue);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.data).toEqual({ version: 3 });
        expect(jobs[0]!.state).toBe("delayed");
        expect(jobs[0]!.runAt).toBeGreaterThanOrEqual(beforeThird + 5_000);
        expect(jobs[0]!.runAt).toBeGreaterThan(first.runAt);
      });

      it("adds a new job once the debounced one has started", async () => {
        const { driver, queue } = await setup();
        const options = { debounce: { id: "doc-8", ttl: 1 } };

        const first = await queue.add("reindex", { version: 1 }, options);
        await Bun.sleep(5);
        // Added with a delay, so due now but still `delayed` until promoted;
        // not every driver promotes inside a claim.
        await driver.promoteDelayed(queue.ref, Date.now(), 10);
        const claimed = await driver.claimJob(queue.ref, {
          workerId: "w1",
          token: newToken(),
          lockMs: 30_000,
          now: Date.now(),
        });
        expect(claimed?.id).toBe(first.id);

        const next = await queue.add("reindex", { version: 2 }, options);
        expect(next.id).not.toBe(first.id);
        expect(next.wasAdded).toBe(true);
        expect((await queue.getJob(first.id))?.data).toEqual({ version: 1 });
      });

      it("makes many producers adding at once into one job", async () => {
        const { queue } = await setup();

        const added = await Promise.all(
          Array.from({ length: 20 }, async (_, index) => {
            return await queue.add(
              "reindex",
              { version: index },
              { debounce: { id: "burst", ttl: 10_000 } },
            );
          }),
        );

        expect(new Set(added.map((job) => job.id)).size).toBe(1);
        expect(await everyJob(queue)).toHaveLength(1);
      });

      it("runs once, with the last data, after the adds stop", async () => {
        const { driver, namespace, queue } = await setup();
        const ran: number[] = [];
        const worker = new BunQueueWorker<Doc>(
          "windowed",
          async (job) => {
            ran.push(job.data.version);
            return null;
          },
          {
            namespace,
            driver,
            logger: noopLogger,
            pollInterval: 5,
            maxBlock: 20,
          },
        );
        closers.push(() => worker.close({ force: true }));
        void worker.run();

        for (let version = 1; version <= 5; version++) {
          await queue.add(
            "reindex",
            { version },
            { debounce: { id: "settle", ttl: 150 } },
          );
          await Bun.sleep(20);
        }

        await waitFor(() => ran.length === 1, { timeout: 5_000 });
        await Bun.sleep(250);
        expect(ran).toEqual([5]);
      });

      it("recovers from a pointer to a job that no longer exists", async () => {
        const { queue } = await setup();
        const options = { debounce: { id: "gone", ttl: 10_000 } };

        const first = await queue.add("reindex", { version: 1 }, options);
        expect(await queue.remove(first.id)).toBe(true);

        const next = await queue.add("reindex", { version: 2 }, options);
        expect(next.wasAdded).toBe(true);
        expect(next.id).not.toBe(first.id);
      });
    });

    describe("throttle", () => {
      it("adds nothing inside the window, and answers with the job that opened it", async () => {
        const { queue } = await setup();
        const throttled: string[] = [];
        queue.on("throttled", (job) => throttled.push(job.id));
        const options = { throttle: { id: "digest", ttl: 5_000 } };

        const first = await queue.add("digest", { version: 1 }, options);
        const second = await queue.add("digest", { version: 2 }, options);

        expect(second.id).toBe(first.id);
        expect(second.wasAdded).toBe(false);
        expect(second.data).toEqual({ version: 1 });
        expect(throttled).toEqual([first.id]);
        expect(await everyJob(queue)).toHaveLength(1);
      });

      it("opens a new window once the last has passed", async () => {
        const { queue } = await setup();
        const options = { throttle: { id: "digest", ttl: 60 } };

        const first = await queue.add("digest", { version: 1 }, options);
        await Bun.sleep(100);
        const next = await queue.add("digest", { version: 2 }, options);

        expect(next.id).not.toBe(first.id);
        expect(next.wasAdded).toBe(true);
        expect(await everyJob(queue)).toHaveLength(2);
      });

      it("lets exactly one of many producers through", async () => {
        const { queue } = await setup();

        const added = await Promise.all(
          Array.from({ length: 20 }, async (_, index) => {
            return await queue.add(
              "digest",
              { version: index },
              { throttle: { id: "burst", ttl: 10_000 } },
            );
          }),
        );

        expect(new Set(added.map((job) => job.id)).size).toBe(1);
        expect(added.filter((job) => job.wasAdded)).toHaveLength(1);
        expect(await everyJob(queue)).toHaveLength(1);
      });

      it("keeps the job's own delay", async () => {
        const { queue } = await setup();
        const job = await queue.add(
          "digest",
          { version: 1 },
          { throttle: { id: "later", ttl: 1_000 }, delay: 60_000 },
        );
        expect(job.state).toBe("delayed");
      });
    });

    it("refuses combinations that cannot work", async () => {
      const { queue } = await setup();
      const window = { id: "x", ttl: 1_000 };

      for (const options of [
        { debounce: window, throttle: window },
        { debounce: window, jobId: "fixed" },
        { throttle: window, repeat: { every: 1_000 } },
        { debounce: { id: "", ttl: 1_000 } },
        { debounce: { id: "x", ttl: 0 } },
        { throttle: { id: "x", ttl: "whenever" } },
      ]) {
        await expect(queue.add("bad", { version: 0 }, options)).rejects.toThrow(
          ConfigError,
        );
      }
    });
  });
}

describe("debounce and throttle on the builder", () => {
  it("is available as methods and through withOptions", async () => {
    const jobs = new BunJobs({
      namespace: testNamespace(),
      driver: new MemoryDriver(),
      logger: noopLogger,
    });
    closers.push(() => jobs.close());
    jobs.define("reindex", async () => null);

    const a = await jobs
      .run("reindex", { v: 1 })
      .debounce("doc", "1 minute")
      .start();
    const b = await jobs
      .run("reindex", { v: 2 })
      .withOptions({ debounce: { id: "doc", ttl: 60_000 } })
      .start();
    expect(b.id).toBe(a.id);
    expect((await jobs.queue("jobs").getJob(a.id))?.data).toEqual({ v: 2 });

    const c = await jobs.run("reindex").throttle("feed", 60_000).start();
    const d = await jobs.run("reindex").throttle("feed", 60_000).start();
    expect(d.id).toBe(c.id);
    expect(d.wasAdded).toBe(false);
  });
});
