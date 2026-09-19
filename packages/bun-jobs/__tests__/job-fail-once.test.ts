import type { JobsDriver } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { BunQueue, BunQueueWorker, createDriver } from "../lib/index";
import { testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * A running job failed from outside is reported once.
 *
 * `Job.fail()` buries the job and announces `failed` and `dead` itself. The
 * worker that was running it then has its own write refused — whether its
 * processor throws or returns — and used to announce the failure a second
 * time. It must report a lost lock instead, while a refusal that only means
 * its own earlier write landed (the reply was lost) still reports the
 * failure, once.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

/** Temp directories and server namespaces to release once the suite ends. */
const backendCleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(backendCleanups.map((cleanup) => cleanup()));
});

/** Memory, SQLite and every configured server. */
const BACKENDS = [
  { name: "memory", config: { type: "memory" } as const, available: true },
  ...(await crossProcessBackends({ cleanups: backendCleanups })).filter(
    (backend) => backend.name !== "file",
  ),
];

for (const { name: backendName, config, available } of BACKENDS) {
  describe.skipIf(!available)(`a job failed once: ${backendName}`, () => {
    /**
     * A driver for this backend, a publishing queue, a second queue that
     * hears what is published, and the events each saw.
     */
    async function setup(wrap?: (driver: JobsDriver) => void) {
      const driver = createDriver(config);
      const namespace = testNamespace("fail-once");
      backendCleanups.push(async () => {
        await driver.purge(namespace);
        await driver.close();
      });
      wrap?.(driver);

      const queue = new BunQueue<{ v: number }>("once", {
        namespace,
        driver,
        logger: noopLogger,
        publish: true,
      });
      const listener = new BunQueue("once", {
        namespace,
        driver,
        logger: noopLogger,
        subscribe: true,
      });
      closers.push(() => queue.close());
      closers.push(() => listener.close());
      await listener.connect();

      /** Every event, as `<who> <event>`. */
      const heard: string[] = [];
      for (const event of ["failed", "dead", "completed"] as const) {
        queue.on(event, () => {
          heard.push(`queue ${event}`);
        });
        listener.on(event, () => {
          heard.push(`published ${event}`);
        });
      }
      return { driver, namespace, queue, heard };
    }

    /** A publishing worker, started, whose events are added to `heard`. */
    function startWorker(
      driver: JobsDriver,
      namespace: string,
      heard: string[],
      processor: () => Promise<unknown>,
    ) {
      const worker = new BunQueueWorker<{ v: number }>("once", processor, {
        namespace,
        driver,
        logger: noopLogger,
        pollInterval: 5,
        maintenance: false,
        publish: true,
        // Long, so the lost lock is found by the settling write, not a beat.
        heartbeatInterval: 60_000,
        lockDuration: 120_000,
      });
      for (const event of [
        "failed",
        "dead",
        "completed",
        "lockLost",
      ] as const) {
        worker.on(event, () => {
          heard.push(`worker ${event}`);
        });
      }
      closers.push(() => worker.close({ force: true }));
      void worker.run();
      return worker;
    }

    /** Runs a job, fails it from outside mid-run, then lets it `finish`. */
    async function failMidRun(finish: "throw" | "return") {
      const { driver, namespace, queue, heard } = await setup();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = false;

      startWorker(driver, namespace, heard, async () => {
        started = true;
        await gate;
        if (finish === "throw") {
          throw new Error("stopped after being failed");
        }
        return "finished anyway";
      });

      const job = await queue.add("x", { v: 1 }, { attempts: 3 });
      await waitFor(() => started, { timeout: 5_000 });
      expect(await (await queue.getJob(job.id))!.fail("pulled")).toBe(true);
      release();

      await waitFor(() => heard.includes("worker lockLost"), {
        timeout: 5_000,
      });
      await waitFor(
        () => heard.filter((line) => line.startsWith("published")).length >= 2,
        { timeout: 5_000 },
      );
      // Time for a duplicate to arrive, were one coming.
      await Bun.sleep(150);

      const after = await queue.getJob(job.id);
      expect(after?.state).toBe("dead");
      expect(after?.failedReason?.message).toBe("pulled");
      return heard;
    }

    it("reports an outside fail once when the processor then throws", async () => {
      const heard = await failMidRun("throw");
      expect(heard.toSorted()).toEqual([
        "published dead",
        "published failed",
        "queue dead",
        "queue failed",
        "worker lockLost",
      ]);
    });

    it("reports an outside fail once, and no completion, when the processor then returns", async () => {
      const heard = await failMidRun("return");
      expect(heard.toSorted()).toEqual([
        "published dead",
        "published failed",
        "queue dead",
        "queue failed",
        "worker lockLost",
      ]);
    });

    it("still reports its own failure once when the write landed and only its reply was lost", async () => {
      let lostOne = false;
      const { driver, namespace, queue, heard } = await setup((driver) => {
        const failJob = driver.failJob.bind(driver);
        driver.failJob = async (...args) => {
          const landed = await failJob(...args);
          if (!lostOne) {
            lostOne = true;
            throw new Error("Connection reset: the reply never came");
          }
          return landed;
        };
      });

      startWorker(driver, namespace, heard, async () => {
        throw new Error("the job's own failure");
      });

      const job = await queue.add("x", { v: 1 }, { attempts: 1 });
      await waitFor(
        () => heard.filter((line) => line.startsWith("published")).length >= 2,
        { timeout: 5_000 },
      );
      await Bun.sleep(150);

      expect(lostOne).toBe(true);
      const after = await queue.getJob(job.id);
      expect(after?.state).toBe("dead");
      expect(after?.failedReason?.message).toBe("the job's own failure");
      expect(heard.toSorted()).toEqual([
        "published dead",
        "published failed",
        "worker dead",
        "worker failed",
      ]);
    });
  });
}
