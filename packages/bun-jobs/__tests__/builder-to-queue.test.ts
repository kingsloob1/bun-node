import type { Job, JobsDriver } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  BunJobs,
  BunQueue,
  ConfigError,
  FileDriver,
  JobBuilder,
  MemoryDriver,
  SerializationError,
} from "../lib/index";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * Sending a builder's job to a named queue: `jobs.schedule(...).toQueue(name)`
 * and `jobs.queue(name).schedule(...)`, one builder behind both.
 *
 * A queue other than the registry's is *foreign*: whatever works it runs the
 * job, so a registry definition lends no defaults there. `jobs.schedule()`
 * still refuses an undefined name at once, as it always has, so such a name
 * reaches a foreign queue only through `jobs.queue(name).<verb>`. The
 * registry queue, named explicitly either way, behaves exactly as the plain
 * builder does.
 *
 * Every case reads the stored record back, not only the job handed back, and
 * runs on the memory and file drivers.
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
    make: async () => ({
      driver: new MemoryDriver(),
      cleanup: async () => {},
    }),
  },
  {
    name: "file",
    make: async () => {
      const tmp = await makeTmpDir("builder-to-queue");
      return {
        driver: new FileDriver({ root: tmp.path }),
        cleanup: tmp.cleanup,
      };
    },
  },
];

/** The options `define()` gives "resize", none of which a foreign queue takes. */
const RESIZE_DEFAULTS = { attempts: 5, priority: 3, timeout: 4_000 };

for (const backend of backends) {
  describe(`builder toQueue: ${backend.name}`, () => {
    let driver: JobsDriver;
    let cleanup: () => Promise<void>;
    let jobs: BunJobs;
    /** What the registry's handler for "resize" has run, by job id. */
    let registryRan: string[];

    beforeEach(async () => {
      ({ driver, cleanup } = await backend.make());
      jobs = new BunJobs({
        namespace: testNamespace(),
        driver,
        logger: noopLogger,
      });
      registryRan = [];
      jobs.define(
        "resize",
        async (job) => {
          registryRan.push(job.id);
        },
        RESIZE_DEFAULTS,
      );
    });

    afterEach(async () => {
      await jobs.close();
      await driver.close();
      await cleanup();
    });

    /** The record stored for `job` on the queue named, or `null`. */
    async function storedOn(
      queue: string,
      job: Job<unknown, unknown>,
    ): Promise<Job<unknown, unknown> | null> {
      return await jobs.queue<unknown, unknown>(queue).getJob(job.id);
    }

    /* --- where the job goes ---------------------------------------------- */

    describe("routing", () => {
      it("toQueue() adds the job to the named queue, not the registry's", async () => {
        const job = await jobs
          .schedule("resize", { id: 1 })
          .toQueue("images")
          .start();

        expect(job.queue.queue).toBe("images");
        const stored = await storedOn("images", job);
        expect(stored?.name).toBe("resize");
        expect(stored?.data).toEqual({ id: 1 });
        expect(await storedOn("jobs", job)).toBeNull();
        expect(await jobs.queue("jobs").count("waiting")).toBe(0);
      });

      it("a worker on the named queue runs it, and the registry's worker does not", async () => {
        const ran: string[] = [];
        const worker = jobs.worker("images", async (job) => {
          ran.push(`${job.name}:${job.id}`);
          return "done";
        });
        void worker.run();
        await jobs.start();

        const job = await jobs
          .schedule("resize", { id: 2 })
          .toQueue("images")
          .start();

        await waitFor(
          async () => (await storedOn("images", job))?.state === "completed",
        );
        expect(ran).toEqual([`resize:${job.id}`]);
        expect(registryRan).toEqual([]);
      });

      it("jobs.queue(name).schedule() stores what toQueue() stores", async () => {
        const viaToQueue = await jobs
          .schedule("resize", { id: 3 })
          .toQueue("images")
          .in("5 minutes")
          .priority(7)
          .start();
        const viaQueue = await jobs
          .queue("images")
          .schedule("resize", { id: 3 })
          .in("5 minutes")
          .priority(7)
          .start();

        const a = await storedOn("images", viaToQueue);
        const b = await storedOn("images", viaQueue);
        expect(a?.state).toBe("delayed");
        expect(b?.state).toBe("delayed");
        for (const stored of [a, b]) {
          expect(stored?.name).toBe("resize");
          expect(stored?.data).toEqual({ id: 3 });
          expect(stored?.priority).toBe(7);
          expect(stored?.maxAttempts).toBe(viaQueue.maxAttempts);
        }
        expect(Math.abs(a!.runAt - b!.runAt)).toBeLessThan(2_000);
      });

      it("the last toQueue() wins, including back to the registry queue", async () => {
        const job = await jobs
          .schedule("resize", { id: 4 })
          .toQueue("images")
          .toQueue("jobs")
          .start();

        const stored = await storedOn("jobs", job);
        expect(stored?.name).toBe("resize");
        // Back on the registry queue, so the definition's defaults are back.
        expect(stored?.maxAttempts).toBe(RESIZE_DEFAULTS.attempts);
        expect(await storedOn("images", job)).toBeNull();
      });

      it("uses the context's namespace", async () => {
        const job = await jobs.schedule("resize").toQueue("images").start();
        expect(job.queue).toEqual({ ns: jobs.namespace, queue: "images" });
      });
    });

    /* --- names the registry never defined ---------------------------------- */

    describe("undefined names", () => {
      it("jobs.schedule/run/process/create(undefined) still throw at the verb, as on develop", () => {
        expect(() => jobs.schedule("never-defined")).toThrow(ConfigError);
        expect(() => jobs.run("never-defined")).toThrow(ConfigError);
        expect(() => jobs.process("never-defined")).toThrow(
          'No job is defined for "never-defined"',
        );
        expect(() => jobs.create("never-defined")).toThrow(ConfigError);
      });

      it("go to another queue through jobs.queue(name).<verb>, by every verb", async () => {
        const images = jobs.queue("images");
        const scheduled = await images
          .schedule("never-defined", { n: 1 })
          .start();
        const run = await images.run("never-defined", { n: 2 }).start();
        const now = await images.now("never-defined", { n: 3 });
        const saved = await images.create("never-defined", { n: 4 }).save();

        for (const job of [scheduled, run, now, saved]) {
          expect((await storedOn("images", job))?.name).toBe("never-defined");
        }
        expect(await jobs.queue("jobs").count("waiting")).toBe(0);
      });

      it("toQueue() back to the registry queue throws at once for one", () => {
        const builder = jobs.queue("images").schedule("never-defined");
        expect(() => builder.toQueue("jobs")).toThrow(ConfigError);
        const draft = jobs.queue("images").create("never-defined");
        expect(() => draft.toQueue("jobs")).toThrow(ConfigError);
      });

      it("still need a JSON-safe payload, as every add does", async () => {
        await expect(
          jobs.schedule("resize", { big: 1n }).toQueue("images").start(),
        ).rejects.toThrow(SerializationError);
        await expect(
          jobs.queue("images").now("never-defined", { big: 1n }),
        ).rejects.toThrow(SerializationError);
        expect(await jobs.queue("images").count("waiting")).toBe(0);
      });
    });

    /* --- options ------------------------------------------------------------ */

    describe("options on a foreign queue", () => {
      it("take only what the call passes, not the registry definition's", async () => {
        const bare = await jobs.queue("images").schedule("plain").start();
        const viaToQueue = await jobs
          .schedule("resize", { id: 5 })
          .toQueue("images")
          .start();
        const viaQueue = await jobs
          .queue("images")
          .schedule("resize", { id: 5 })
          .start();

        for (const job of [viaToQueue, viaQueue]) {
          const stored = await storedOn("images", job);
          // What the queue gives a job nobody said anything about.
          expect(stored?.maxAttempts).toBe(bare.maxAttempts);
          expect(stored?.priority).toBe(bare.priority);
          expect(stored?.opts.timeout).toBe(bare.opts.timeout);
          expect(stored?.maxAttempts).not.toBe(RESIZE_DEFAULTS.attempts);
        }
      });

      it("keep what the builder was told, before toQueue() or after it", async () => {
        const job = await jobs
          .schedule("resize", { id: 6 })
          .priority(4)
          .toQueue("images")
          .attempts(2)
          .start();

        const stored = await storedOn("images", job);
        expect(stored?.priority).toBe(4);
        expect(stored?.maxAttempts).toBe(2);
        expect(stored?.opts.timeout).not.toBe(RESIZE_DEFAULTS.timeout);
      });
    });

    /* --- the registry queue, named explicitly ------------------------------ */

    describe("the registry queue by name", () => {
      it("jobs.queue('jobs').schedule() is the plain builder: definition defaults applied", async () => {
        const plain = await jobs.schedule("resize", { id: 7 }).start();
        const named = await jobs
          .queue("jobs")
          .schedule("resize", { id: 7 })
          .start();

        for (const job of [plain, named]) {
          const stored = await storedOn("jobs", job);
          expect(stored?.maxAttempts).toBe(RESIZE_DEFAULTS.attempts);
          expect(stored?.priority).toBe(RESIZE_DEFAULTS.priority);
          expect(stored?.opts.timeout).toBe(RESIZE_DEFAULTS.timeout);
        }
      });

      it("jobs.queue('jobs') refuses an undefined name as the plain verbs do", async () => {
        const registry = jobs.queue("jobs");
        expect(() => registry.schedule("never-defined")).toThrow(ConfigError);
        expect(() => registry.run("never-defined")).toThrow(ConfigError);
        expect(() => registry.create("never-defined")).toThrow(ConfigError);
        // now() is async on both, so it rejects, as jobs.now() does.
        await expect(registry.now("never-defined")).rejects.toThrow(
          ConfigError,
        );
        expect(await registry.count("waiting")).toBe(0);
      });

      it("follows a renamed registry queue: 'work' is the registry, 'jobs' is foreign", async () => {
        const work = new BunJobs({
          namespace: testNamespace(),
          driver,
          logger: noopLogger,
          registryQueue: "work",
        });
        work.define("resize", async () => {}, RESIZE_DEFAULTS);
        try {
          const registry = await work.queue("work").schedule("resize").start();
          expect(registry.maxAttempts).toBe(RESIZE_DEFAULTS.attempts);
          expect(() => work.queue("work").schedule("never-defined")).toThrow(
            ConfigError,
          );

          const foreign = await work
            .queue("jobs")
            .schedule("never-defined")
            .start();
          expect(foreign.queue.queue).toBe("jobs");
          const viaToQueue = await work
            .schedule("resize")
            .toQueue("jobs")
            .start();
          expect(viaToQueue.maxAttempts).not.toBe(RESIZE_DEFAULTS.attempts);
        } finally {
          await work.close();
        }
      });
    });

    /* --- each verb ---------------------------------------------------------- */

    describe("each verb", () => {
      it("now(): jobs.queue(name).now() adds at once, with only the options given", async () => {
        const job = await jobs
          .queue("images")
          .now("never-defined", { n: 1 }, { priority: 2 });

        const stored = await storedOn("images", job);
        expect(stored?.state).toBe("waiting");
        expect(stored?.priority).toBe(2);
        expect(stored?.data).toEqual({ n: 1 });

        const registry = await jobs.queue("jobs").now("resize", { id: 8 });
        expect(registry.maxAttempts).toBe(RESIZE_DEFAULTS.attempts);
      });

      it("run() and process() take toQueue() as schedule() does, without the defaults", async () => {
        const run = await jobs.run("resize").toQueue("images").start();
        const processed = await jobs
          .process("resize")
          .toQueue("images")
          .start();
        const queueRun = await jobs.queue("images").run("resize").start();

        for (const job of [run, processed, queueRun]) {
          const stored = await storedOn("images", job);
          expect(stored?.name).toBe("resize");
          expect(stored?.maxAttempts).not.toBe(RESIZE_DEFAULTS.attempts);
        }
      });

      it("create(): the draft's toQueue() saves to the named queue, without the defaults", async () => {
        const draft = jobs
          .create("resize", { n: 1 })
          .toQueue("images")
          .priority(1);
        const job = await draft.save();

        const stored = await storedOn("images", job);
        expect(stored?.name).toBe("resize");
        expect(stored?.priority).toBe(1);
        expect(stored?.maxAttempts).not.toBe(RESIZE_DEFAULTS.attempts);
        expect(draft.job?.id).toBe(job.id);

        const viaQueue = await jobs
          .queue("images")
          .create("never-defined", { n: 2 })
          .save();
        expect((await storedOn("images", viaQueue))?.data).toEqual({ n: 2 });
      });

      it("create(): toQueue() after a save is a change, which a second save refuses", async () => {
        const draft = jobs.create("resize").toQueue("images");
        await draft.save();
        draft.toQueue("other");
        await expect(draft.save()).rejects.toThrow(ConfigError);
      });

      it("now() with repeat and jobId keys the series by jobId; add() derives the key", async () => {
        const images = jobs.queue("images");
        await images.now(
          "tick",
          {},
          { repeat: { every: 3_600_000 }, jobId: "by-now" },
        );
        await images.add(
          "tock",
          {},
          { repeat: { every: 3_600_000 }, jobId: "by-add" },
        );

        const keys = (await images.listRepeatables()).map((record) => [
          record.name,
          record.key,
        ]);
        expect(keys).toContainEqual(["tick", "by-now"]);
        const tock = keys.find(([name]) => name === "tock");
        expect(tock?.[1]).not.toBe("by-add");
        expect(tock?.[1]).toStartWith("tock|");
      });

      it("a repeating series goes to the named queue too", async () => {
        await jobs.schedule("resize").toQueue("images").every("1 hour").start();

        const series = await jobs.queue("images").listRepeatables();
        expect(series.map((record) => record.name)).toEqual(["resize"]);
        expect(await jobs.queue("jobs").listRepeatables()).toEqual([]);
      });
    });

    /* --- options that cross toQueue() --------------------------------------- */

    describe("options crossing toQueue()", () => {
      it("unique(): the id names the job on the named queue, separately from the registry's", async () => {
        const moved = await jobs
          .schedule("resize", { id: 1 })
          .unique("u-1")
          .toQueue("images")
          .in("5 minutes")
          .start();
        expect(moved.id).toBe("u-1");
        expect((await storedOn("images", moved))?.state).toBe("delayed");

        // Adding the same id there again is idempotent, as on any queue.
        const again = await jobs
          .schedule("resize", { id: 2 })
          .toQueue("images")
          .unique("u-1")
          .in("5 minutes")
          .start();
        expect(again.id).toBe("u-1");
        expect(await jobs.queue("images").count("delayed")).toBe(1);
        expect((await storedOn("images", again))?.data).toEqual({ id: 1 });

        // The registry queue's "u-1" is another job altogether.
        const registry = await jobs.schedule("resize").unique("u-1").start();
        expect(registry.queue.queue).toBe("jobs");
        expect((await storedOn("jobs", registry))?.name).toBe("resize");
        expect(await jobs.queue("images").count("delayed")).toBe(1);
      });

      it("debounce(): a second add with the id replaces the first, on the named queue only", async () => {
        const first = await jobs
          .schedule("resize", { v: 1 })
          .toQueue("images")
          .debounce("deb", "10 minutes")
          .in("1 minute")
          .start();
        const second = await jobs
          .schedule("resize", { v: 2 })
          .debounce("deb", "10 minutes")
          .toQueue("images")
          .in("1 minute")
          .start();

        expect(second.id).toBe(first.id);
        expect((await storedOn("images", second))?.data).toEqual({ v: 2 });

        // The same debounce id on the registry queue is a key of its own.
        const registry = await jobs
          .schedule("resize", { v: 3 })
          .debounce("deb", "10 minutes")
          .in("1 minute")
          .start();
        expect(registry.id).not.toBe(first.id);
        expect(registry.queue.queue).toBe("jobs");
        expect((await storedOn("images", first))?.data).toEqual({ v: 2 });
      });

      it("throttle(): a second add inside the window is the first job", async () => {
        const first = await jobs
          .schedule("resize", { v: 1 })
          .toQueue("images")
          .throttle("thr", "10 minutes")
          .start();
        const second = await jobs
          .schedule("resize", { v: 2 })
          .toQueue("images")
          .throttle("thr", "10 minutes")
          .start();

        expect(second.id).toBe(first.id);
        expect(first.queue.queue).toBe("images");
        expect(await jobs.queue("images").count("waiting")).toBe(1);
        expect(await jobs.queue("jobs").count("waiting")).toBe(0);
      });

      it("deadLetter(), backoff() and keepLogs() are stored on the named queue's job", async () => {
        const job = await jobs
          .schedule("resize")
          .deadLetter("dlq")
          .backoff(99)
          .toQueue("images")
          .keepLogs(3)
          .start();

        const stored = await storedOn("images", job);
        expect(stored?.opts.deadLetter).toBe("dlq");
        expect(stored?.opts.backoff).toBe(99);
        expect(stored?.opts.keepLogs).toBe(3);
      });

      it("a repeat fires on the named queue, never the registry's, and is removed there", async () => {
        const ran: string[] = [];
        const worker = jobs.worker("images", async (job) => {
          ran.push(job.name);
        });
        void worker.run();
        await jobs.start();

        await jobs.schedule("resize").toQueue("images").every(100).start();

        await waitFor(() => ran.length >= 2, { timeout: 5_000 });
        expect(new Set(ran)).toEqual(new Set(["resize"]));
        expect(registryRan).toEqual([]);
        expect(await jobs.queue("jobs").listRepeatables()).toEqual([]);

        const series = await jobs.queue("images").listRepeatables();
        expect(series.map((record) => record.name)).toEqual(["resize"]);
        expect(
          await jobs.queue("images").removeRepeatable(series[0]!.key),
        ).toBe(true);
        expect(await jobs.queue("images").listRepeatables()).toEqual([]);

        // Removing it took its pending occurrence; let one already claimed
        // finish, and then nothing more may run.
        await waitFor(
          async () => {
            const counts = await jobs.queue("images").count();
            return counts.active + counts.waiting + counts.delayed === 0;
          },
          { timeout: 5_000 },
        );
        const settled = ran.length;
        await Bun.sleep(400);
        expect(ran.length).toBe(settled);
      });
    });

    /* --- queue names and the queues toQueue() makes ------------------------ */

    describe("queue names", () => {
      it("toQueue() refuses a name a queue cannot have, with ConfigError, on the builder and the draft", () => {
        for (const bad of ["", "a:b", "has space", "x".repeat(201)]) {
          expect(() => jobs.schedule("resize").toQueue(bad)).toThrow(
            ConfigError,
          );
          expect(() => jobs.create("resize").toQueue(bad)).toThrow(ConfigError);
        }
      });

      it("a queue toQueue() made is the instance jobs.queue() answers later, options and all", async () => {
        jobs.schedule("resize").toQueue("images");
        const later = jobs.queue("images", {
          defaultJobOptions: { attempts: 9 },
        });

        // The documented order: configure first. Too late here, so the
        // options passed now are not the queue's.
        expect(later).toBe(jobs.queue("images"));
        const job = await later.now("plain");
        expect(job.maxAttempts).not.toBe(9);
      });
    });

    /* --- a builder made directly ------------------------------------------- */

    describe("new JobBuilder on a context's queue", () => {
      it("toQueue() routes through the router its queue carries", async () => {
        const builder = new JobBuilder<unknown, unknown>(
          jobs.queue<unknown, unknown>("thumbs"),
          "resize",
          { id: 9 },
        );

        const moved = await builder.toQueue("images").start();
        expect(moved.queue.queue).toBe("images");
        expect((await storedOn("images", moved))?.data).toEqual({ id: 9 });
        expect(moved.maxAttempts).not.toBe(RESIZE_DEFAULTS.attempts);

        // Back to the registry queue: its definition applies, as anywhere.
        const back = await new JobBuilder<unknown, unknown>(
          jobs.queue<unknown, unknown>("thumbs"),
          "resize",
        )
          .toQueue("jobs")
          .start();
        expect(back.queue.queue).toBe("jobs");
        expect(back.maxAttempts).toBe(RESIZE_DEFAULTS.attempts);

        expect(() =>
          new JobBuilder(jobs.queue("thumbs"), "never-defined").toQueue("jobs"),
        ).toThrow(ConfigError);
      });
    });

    /* --- a queue no context made ------------------------------------------- */

    describe("a standalone BunQueue", () => {
      it("has the verbs, and refuses toQueue() to another queue", async () => {
        const solo = new BunQueue("solo", {
          namespace: testNamespace(),
          driver,
          logger: noopLogger,
        });
        try {
          const job = await solo.schedule("anything", { n: 1 }).start();
          expect((await solo.getJob(job.id))?.name).toBe("anything");
          expect((await solo.now("other")).queue.queue).toBe("solo");

          // Its own name is no move at all.
          const same = await solo.schedule("anything").toQueue("solo").start();
          expect(same.queue.queue).toBe("solo");

          expect(() => solo.schedule("anything").toQueue("elsewhere")).toThrow(
            ConfigError,
          );
        } finally {
          await solo.close();
        }
      });
    });
  });
}
