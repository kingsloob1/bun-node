import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  ConfigError,
  FileDriver,
  MemoryDriver,
} from "../lib/index";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * Namespaces.
 *
 * Services sharing a backend reuse names — `cleanup`, `mail`, `sync` — and
 * without a namespace the second service to deploy silently takes over the
 * first's locks, state and jobs. That is not hypothetical: it is what the
 * implementation this package replaces did until a per-service prefix was
 * bolted on. Here the namespace is required everywhere and enforced, and
 * these tests are what keeps it that way.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.allSettled(closers.map((close) => close()));
  closers.length = 0;
});

/** The runner handler used by the namespace tests. */
const HANDLER = join(import.meta.dir, "fixtures", "handlers", "echo.ts");

describe("namespaces are required", () => {
  it("rejects a namespace that cannot be a key, a path or a column", () => {
    for (const namespace of ["", " ", "a b", "a:b", "a/b", "../x", ".", ".."]) {
      expect(
        () => new BunQueue("q", { namespace, driver: new MemoryDriver() }),
      ).toThrow(ConfigError);
      expect(
        () => new BunJobs({ namespace, driver: new MemoryDriver() }),
      ).toThrow(ConfigError);
    }
  });

  it("accepts the characters that are safe everywhere", () => {
    for (const namespace of ["account", "a", "a-b_c.d", "Service1"]) {
      const jobs = new BunJobs({ namespace, driver: new MemoryDriver() });
      expect(jobs.namespace).toBe(namespace);
      closers.push(() => jobs.close());
    }
  });

  it("is exposed by everything that has one", () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();

    const jobs = new BunJobs({ namespace, driver });
    const queue = new BunQueue("q", { namespace, driver });
    const worker = new BunQueueWorker("q", async () => null, {
      namespace,
      driver,
    });
    const runner = jobs.runner({
      id: "r",
      file: HANDLER,
      executionMode: "in-process",
      waitToExit: false,
    });

    closers.push(
      () => jobs.close(),
      () => queue.close(),
      () => worker.close({ force: true }),
    );

    for (const subject of [jobs, queue, worker, runner, jobs.runners]) {
      expect(subject.namespace).toBe(namespace);
    }
  });
});

describe("namespaces isolate queues", () => {
  it("keeps the same queue name in two namespaces apart", async () => {
    const driver = new MemoryDriver();
    const mine = new BunQueue("mail", {
      namespace: testNamespace("account"),
      driver,
      logger: noopLogger,
    });
    const theirs = new BunQueue("mail", {
      namespace: testNamespace("billing"),
      driver,
      logger: noopLogger,
    });
    closers.push(
      () => mine.close(),
      () => theirs.close(),
    );

    // The same job id in both: two different jobs.
    await mine.add("welcome", { from: "account" }, { jobId: "shared-id" });
    await theirs.add("invoice", { from: "billing" }, { jobId: "shared-id" });

    expect((await mine.getJob("shared-id"))?.data).toEqual({
      from: "account",
    });
    expect((await theirs.getJob("shared-id"))?.data).toEqual({
      from: "billing",
    });

    // Pausing one leaves the other running.
    await mine.pause();
    expect(await mine.isPaused()).toBe(true);
    expect(await theirs.isPaused()).toBe(false);

    // Draining one leaves the other's jobs alone.
    await mine.resume();
    expect(await mine.drain()).toBe(1);
    expect(await theirs.count("waiting")).toBe(1);
  });

  it("keeps a worker to its own namespace", async () => {
    const driver = new MemoryDriver();
    const ours = testNamespace("ours");
    const theirs = testNamespace("theirs");

    const ourQueue = new BunQueue("work", {
      namespace: ours,
      driver,
      logger: noopLogger,
    });
    const theirQueue = new BunQueue("work", {
      namespace: theirs,
      driver,
      logger: noopLogger,
    });
    closers.push(
      () => ourQueue.close(),
      () => theirQueue.close(),
    );

    const taken: string[] = [];
    const worker = new BunQueueWorker(
      "work",
      async (job) => {
        taken.push(job.name);
        return null;
      },
      { namespace: ours, driver, logger: noopLogger, pollInterval: 10 },
    );
    closers.push(() => worker.close({ force: true }));

    await theirQueue.add("not-yours", {});
    await ourQueue.add("yours", {});

    void worker.run();
    await waitFor(() => taken.length === 1, { timeout: 5000 });
    await Bun.sleep(80);

    // It never saw the other namespace's job, however long it ran.
    expect(taken).toEqual(["yours"]);
    expect(await theirQueue.count("waiting")).toBe(1);
  });

  it("purges one namespace and leaves its neighbour intact", async () => {
    const driver = new MemoryDriver();
    const doomed = new BunJobs({
      namespace: testNamespace("doomed"),
      driver,
      logger: noopLogger,
    });
    const kept = new BunJobs({
      namespace: testNamespace("kept"),
      driver,
      logger: noopLogger,
    });
    closers.push(
      () => doomed.close(),
      () => kept.close(),
    );

    await doomed.queue("work").add("a", {});
    await kept.queue("work").add("b", {});

    await doomed.purge();

    expect(await doomed.queue("work").count("waiting")).toBe(0);
    expect(await kept.queue("work").count("waiting")).toBe(1);
  });
});

describe("namespaces isolate runners", () => {
  it("gives the same runner id two independent locks", async () => {
    const driver = new MemoryDriver();

    const runners = [testNamespace("a"), testNamespace("b")].map(
      (namespace) => {
        const jobs = new BunJobs({ namespace, driver, logger: noopLogger });
        closers.push(() => jobs.close());
        return jobs.runner({
          id: "cleanup",
          file: HANDLER,
          executionMode: "in-process",
          waitToExit: false,
        });
      },
    );

    await Promise.all(runners.map((runner) => runner.start()));

    // Same id, different namespaces: both hold a lock, so both run.
    for (const runner of runners) {
      expect((await runner.trigger()).outcome).toBe("started");
    }

    // And pausing one says nothing about the other.
    await runners[0].pause();
    expect((await runners[1].info()).isPaused).toBe(false);
  });

  it("refuses to manage a runner from another namespace", () => {
    const driver = new MemoryDriver();
    const jobs = new BunJobs({ namespace: testNamespace(), driver });
    const other = new BunJobs({ namespace: testNamespace(), driver });
    closers.push(
      () => jobs.close(),
      () => other.close(),
    );

    const foreign = other.runner({
      id: "foreign",
      file: HANDLER,
      executionMode: "in-process",
      waitToExit: false,
    });

    expect(() => jobs.runners.add(foreign)).toThrow(/belongs to namespace/);
  });
});

describe("namespaces on the file driver", () => {
  it("gives each namespace its own directory tree", async () => {
    const tmp = await makeTmpDir("bun-jobs-ns-file");
    closers.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    const first = testNamespace("alpha");
    const second = testNamespace("beta");

    const queues = [first, second].map((namespace) => {
      const queue = new BunQueue("orders", {
        namespace,
        driver,
        logger: noopLogger,
      });
      closers.push(() => queue.close());
      return queue;
    });

    await queues[0].add("a", {}, { jobId: "same" });
    await queues[1].add("b", {}, { jobId: "same" });

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(tmp.path);
    expect(entries).toContain(first);
    expect(entries).toContain(second);

    expect((await queues[0].getJob("same"))?.name).toBe("a");
    expect((await queues[1].getJob("same"))?.name).toBe("b");

    await driver.close();
  });
});

describe("BunJobs context", () => {
  it("derives everything from one namespace and one backend", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();
    const jobs = new BunJobs({ namespace, driver, logger: noopLogger });
    closers.push(() => jobs.close());

    const queue = jobs.queue("mail");
    const worker = jobs.worker("mail", async () => null);
    const runner = jobs.runner({
      id: "cleanup",
      file: HANDLER,
      executionMode: "in-process",
      waitToExit: false,
    });

    for (const subject of [queue, worker, runner]) {
      expect(subject.namespace).toBe(namespace);
      expect(subject.driver).toBe(driver);
    }

    // The runner is registered, so startAll/stopAll reach it.
    expect(jobs.runners.get("cleanup")).toBe(runner);
  });

  it("returns the same queue instance for a name", () => {
    const jobs = new BunJobs({
      namespace: testNamespace(),
      driver: new MemoryDriver(),
    });
    closers.push(() => jobs.close());

    // Otherwise listeners attached to the first one would be orphaned.
    expect(jobs.queue("mail")).toBe(jobs.queue("mail"));
    expect(jobs.queue("mail")).not.toBe(jobs.queue("sms"));
  });

  it("lists what the backend holds for this namespace only", async () => {
    const driver = new MemoryDriver();
    const jobs = new BunJobs({
      namespace: testNamespace(),
      driver,
      logger: noopLogger,
    });
    const other = new BunJobs({
      namespace: testNamespace(),
      driver,
      logger: noopLogger,
    });
    closers.push(
      () => jobs.close(),
      () => other.close(),
    );

    await jobs.queue("mine").add("a", {});
    await other.queue("theirs").add("b", {});

    expect(await jobs.listQueues()).toEqual(["mine"]);
    expect(await other.listQueues()).toEqual(["theirs"]);
  });

  it("closes what it created and leaves a shared driver open", async () => {
    const driver = new MemoryDriver();
    const jobs = new BunJobs({
      namespace: testNamespace(),
      driver,
      logger: noopLogger,
    });

    const runner = jobs.runner({
      id: "r",
      file: HANDLER,
      executionMode: "in-process",
      waitToExit: false,
    });
    await runner.start();

    await jobs.close();

    expect(runner.status).toBe("stopped");
    // The driver was passed in, so it is still usable by whoever owns it.
    expect(await driver.ping()).toBe(true);
  });

  it("hands children a driver config, since an instance cannot be sent", () => {
    const fromConfig = new BunJobs({
      namespace: testNamespace(),
      driver: { type: "memory" },
    });
    const fromInstance = new BunJobs({
      namespace: testNamespace(),
      driver: new MemoryDriver(),
    });
    closers.push(
      () => fromConfig.close(),
      () => fromInstance.close(),
    );

    expect(fromConfig.driverConfig).toEqual({ type: "memory" });
    expect(fromInstance.driverConfig).toBeUndefined();
  });
});
