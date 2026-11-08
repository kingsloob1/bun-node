import type { JobRecord, JobsDriver, QueueRef } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunJobs, FileDriver, MemoryDriver } from "../lib/index";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * `removeRepeatable()` while a worker is scheduling the series' next
 * occurrence.
 *
 * A worker claiming an occurrence reads the series, adds the next occurrence
 * and writes the series back pointing at it. A removal landing between the
 * read and the write was undone by that write: `removeRepeatable()` answered
 * `true`, `listRepeatables()` was empty for a moment, and then the series was
 * back and ran on for good. Seen as `builder-to-queue.test.ts`'s repeat case
 * failing about one run in 150 on the file driver, whose writes are slow
 * enough to open the window.
 *
 * Here the window is held open: the worker's add of the next occurrence
 * waits on a gate, the series is removed meanwhile, and the gate opens. The
 * series must stay removed, the occurrence the worker added must go, and
 * nothing may run afterwards. The fallback (a driver without `updateRepeat`)
 * is held to the same.
 */

/** A backend to run every case against. */
interface Backend {
  /** What the describe block is called. */
  name: string;
  /** Builds a driver, and whatever removing it afterwards takes. */
  make: () => Promise<{ driver: JobsDriver; cleanup: () => Promise<void> }>;
}

const backends: Backend[] = [
  {
    name: "memory",
    make: async () => ({ driver: new MemoryDriver(), cleanup: async () => {} }),
  },
  {
    name: "file",
    make: async () => {
      const tmp = await makeTmpDir("repeat-remove-race");
      return {
        driver: new FileDriver({ root: tmp.path }),
        cleanup: tmp.cleanup,
      };
    },
  },
  {
    // A third-party driver without `updateRepeat`: the core reads, then
    // upserts.
    name: "memory without updateRepeat",
    make: async () => {
      const driver = new MemoryDriver();
      Object.defineProperty(driver, "updateRepeat", { value: undefined });
      return { driver, cleanup: async () => {} };
    },
  },
];

/** What closing a case takes. */
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});

for (const backend of backends) {
  describe(`removing a repeat mid-schedule: ${backend.name}`, () => {
    it("stays removed when a worker was between reading the series and writing it back", async () => {
      const { driver, cleanup } = await backend.make();
      const jobs = new BunJobs({
        namespace: testNamespace(),
        driver,
        logger: noopLogger,
      });
      closers.push(async () => {
        await jobs.close();
        await driver.close();
        await cleanup();
      });

      // The gate: the next add of an occurrence of the series waits here,
      // which is after the worker read the series and before it writes it.
      const addJob = driver.addJob.bind(driver);
      let armed = false;
      let reached!: () => void;
      const atGate = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      driver.addJob = async (q: QueueRef, record: JobRecord) => {
        if (armed && record.repeatKey) {
          armed = false;
          reached();
          await gate;
        }
        return await addJob(q, record);
      };

      const queue = jobs.queue("ticks");
      await queue.add("tick", {}, { repeat: { every: 50 } });
      const [series] = await queue.listRepeatables();
      expect(series).toBeDefined();

      const ran: string[] = [];
      const worker = jobs.worker("ticks", async (job) => {
        ran.push(job.id);
      });
      armed = true;
      void worker.run();

      // The worker has claimed the first occurrence and read the series.
      await atGate;
      expect(await queue.removeRepeatable(series.key)).toBe(true);
      expect(await queue.listRepeatables()).toEqual([]);
      open();

      // The worker finishes the occurrence it claimed, and that is all.
      await waitFor(() => ran.length >= 1, { timeout: 5_000 });
      await waitFor(
        async () => {
          const counts = await queue.count();
          return counts.active + counts.waiting + counts.delayed === 0;
        },
        { timeout: 5_000 },
      );
      expect(await queue.listRepeatables()).toEqual([]);
      const settled = ran.length;
      // Several intervals: a series written back would have run again.
      await Bun.sleep(300);
      expect(ran.length).toBe(settled);
      expect(await queue.listRepeatables()).toEqual([]);
      expect(settled).toBe(1);
    });
  });
}
