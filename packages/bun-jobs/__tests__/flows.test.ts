import type { DriverConfig, JobRecord, JobsDriver } from "../lib/index";
import type { Backend } from "./helpers/backends";
import { noopLogger, serializeError } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  BunQueue,
  BunQueueWorker,
  ChildFailedError,
  ConfigError,
  createDriver,
  MemoryDriver,
  UnrecoverableJobError,
} from "../lib/index";
import { makeJob, testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * Flows: a job that runs once the jobs it waits on have settled.
 *
 * Driven end to end — producer, workers in two queues, and the maintenance
 * that heals what a crash leaves half done. Most cases run on the memory
 * driver; a representative subset runs on every backend at the bottom. Every
 * driver holds the same contract, checked piece by piece in the driver
 * contract.
 */

const closers: (() => Promise<unknown>)[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

afterAll(async () => {
  for (const cleanup of cleanups) {
    await cleanup().catch(() => undefined);
  }
});

type Processor = ConstructorParameters<typeof BunQueueWorker<any, any>>[1];

/** A namespace with a producer queue and workers for the named queues. */
function setup(
  processors: Record<string, Processor>,
  driver: JobsDriver = new MemoryDriver(),
  options: {
    /** Whether maintenance heals flows quickly; off, only delivery itself can work. */
    healing?: boolean;
    /** Told of every worker error, with its context. */
    onError?: (context: string) => void;
    /** Whether the producer queue hears other processes' events, and publishes its own. */
    subscribe?: boolean;
    /** Whether the workers publish their events. */
    publish?: boolean;
  } = {},
) {
  const namespace = testNamespace();
  // Registered before anything that writes to it, so it runs after every
  // queue and worker below has closed and flushed — closers run in reverse —
  // and before the driver itself closes. Exactly this namespace, never a
  // prefix sweep: the servers are shared.
  closers.push(() => driver.purge(namespace));
  const queue = new BunQueue("reports", {
    namespace,
    driver,
    logger: noopLogger,
    defaultJobOptions: { removeOnComplete: false },
    subscribe: options.subscribe ?? false,
  });
  closers.push(() => queue.close());

  const workers: Record<string, BunQueueWorker<any, any>> = {};

  const start = () => {
    for (const [name, processor] of Object.entries(processors)) {
      const worker = new BunQueueWorker(name, processor, {
        namespace,
        driver,
        logger: noopLogger,
        pollInterval: 5,
        // Healing rides the stalled sweep; far apart, it cannot stand in for
        // delivery within a test.
        stalledInterval: options.healing === false ? 60_000 : 20,
        waitToExit: false,
        publish: options.publish ?? false,
      });
      worker.on("error", (_error, context) => options.onError?.(context));
      workers[name] = worker;
      closers.push(() => worker.close({ force: true }));
      void worker.run();
    }
  };

  const stateOf = async (queueName: string, id: string) =>
    (await driver.getJob({ ns: namespace, queue: queueName }, id))?.state;

  /** A second producer on another queue of the same namespace. */
  const other = (name: string, subscribe = false) => {
    const opened = new BunQueue(name, {
      namespace,
      driver,
      logger: noopLogger,
      subscribe,
    });
    closers.push(() => opened.close());
    return opened;
  };

  return { namespace, driver, queue, start, stateOf, workers, other };
}

describe("flows", () => {
  it("runs a parent once its children in two queues are done, and hands it their results", async () => {
    let seen: Record<string, unknown> | undefined;
    const { queue, start, stateOf } = setup(
      {
        reports: async (job) => {
          seen = await job.getChildrenValues();
          return "report ready";
        },
        // Finishing after the workers' first maintenance pass, so that pass
        // cannot deliver the result either: only delivery itself can.
        fetch: async (job) => {
          await Bun.sleep(30);
          return { rows: job.data.rows };
        },
      },
      new MemoryDriver(),
      { healing: false },
    );

    const flow = await queue.addFlow({
      name: "report",
      data: {},
      children: [
        { name: "orders", data: { rows: 3 }, queue: "fetch" },
        { name: "refunds", data: { rows: 1 }, queue: "fetch" },
      ],
    });

    expect(flow.job.state).toBe("waiting-children");
    expect(flow.children.map((child) => child.job.parent)).toEqual([
      { queue: "reports", id: flow.job.id },
      { queue: "reports", id: flow.job.id },
    ]);
    // Added children first: the parent postdates every child it lists.
    for (const child of flow.children) {
      expect(flow.job.createdAt).toBeGreaterThanOrEqual(child.job.createdAt);
    }

    start();
    await waitFor(
      async () => (await stateOf("reports", flow.job.id)) === "completed",
      { timeout: 5_000 },
    );

    const [orders, refunds] = flow.children;
    expect(seen).toEqual({
      [`fetch:${orders!.job.id}`]: { rows: 3 },
      [`fetch:${refunds!.job.id}`]: { rows: 1 },
    });
  });

  it("buries a parent when a child fails, and carries that up the flow", async () => {
    const ran: string[] = [];
    const { queue, start, stateOf, driver, namespace } = setup({
      reports: async (job) => {
        ran.push(job.name);
        return null;
      },
      fetch: async (job) => {
        if (job.name === "broken") {
          throw new UnrecoverableJobError("source is gone");
        }
        return "ok";
      },
    });

    const flow = await queue.addFlow({
      name: "top",
      data: {},
      children: [
        {
          name: "middle",
          data: {},
          children: [{ name: "broken", data: {}, queue: "fetch" }],
        },
      ],
    });
    start();

    const middle = flow.children[0]!;
    await waitFor(
      async () => (await stateOf("reports", flow.job.id)) === "dead",
      { timeout: 5_000 },
    );

    expect(await stateOf("reports", middle.job.id)).toBe("dead");
    expect(ran).toEqual([]);

    const buriedMiddle = await driver.getJob(
      { ns: namespace, queue: "reports" },
      middle.job.id,
    );
    expect(buriedMiddle?.failedReason?.name).toBe("ChildFailedError");
    expect(buriedMiddle?.failedReason?.message).toContain(
      `fetch:${middle.children[0]!.job.id}`,
    );

    const top = await driver.getJob(
      { ns: namespace, queue: "reports" },
      flow.job.id,
    );
    expect(top?.failedReason?.name).toBe("ChildFailedError");
    expect(top?.failedReason?.message).toContain(`reports:${middle.job.id}`);
    expect(top?.failedReason?.message).toContain("source is gone");
  });

  it("lets a parent run past a child marked ignoreFailure", async () => {
    let failures: Record<string, Error> | undefined;
    const { queue, start, stateOf } = setup({
      reports: async (job) => {
        failures = await job.getChildrenFailures();
        return "partial";
      },
      fetch: async () => {
        throw new UnrecoverableJobError("optional source down");
      },
    });

    const flow = await queue.addFlow({
      name: "report",
      data: {},
      children: [
        {
          name: "optional",
          data: {},
          queue: "fetch",
          opts: { ignoreFailure: true },
        },
      ],
    });
    start();

    await waitFor(
      async () => (await stateOf("reports", flow.job.id)) === "completed",
      { timeout: 5_000 },
    );

    const key = `fetch:${flow.children[0]!.job.id}`;
    expect(Object.keys(failures ?? {})).toEqual([key]);
    expect(failures?.[key]?.message).toBe("optional source down");
  });

  it("completes a flow after its buried parent and failed child are retried", async () => {
    let attempts = 0;
    const { queue, start, stateOf, other } = setup({
      reports: async () => "done",
      fetch: async () => {
        attempts++;
        if (attempts === 1) {
          throw new UnrecoverableJobError("first try fails");
        }
        return "fixed";
      },
    });

    const flow = await queue.addFlow({
      name: "report",
      data: {},
      children: [{ name: "flaky", data: {}, queue: "fetch" }],
    });
    start();

    await waitFor(
      async () => (await stateOf("reports", flow.job.id)) === "dead",
      { timeout: 5_000 },
    );

    // The parent goes back to waiting on its child, not straight to running.
    expect(await queue.retry(flow.job.id)).toBe(true);
    expect(await stateOf("reports", flow.job.id)).toBe("waiting-children");

    // Maintenance runs every 20ms here. The failure that buried the parent was
    // delivered once already, so it does not bury the retried parent again:
    // the parent waits for its child to be retried too.
    await Bun.sleep(200);
    expect(await stateOf("reports", flow.job.id)).toBe("waiting-children");

    expect(await other("fetch").retry(flow.children[0]!.job.id)).toBe(true);

    await waitFor(
      async () => (await stateOf("reports", flow.job.id)) === "completed",
      { timeout: 5_000 },
    );
  });

  it("sends a buried parent back to waiting on its children from every retry path", async () => {
    const driver = new MemoryDriver();
    const { queue, namespace } = setup({}, driver);
    const ref = { ns: namespace, queue: "reports" };

    // Three parents, each buried by its only child, failed from outside
    // before it ever ran. Dead first: a failure delivered from a child that is
    // not dead is stale, and refused.
    const bury = async () => {
      const flow = await queue.addFlow({
        name: "report",
        data: {},
        children: [{ name: "flaky", data: {}, queue: "fetch" }],
      });
      const child = flow.children[0]!.job;
      await driver.buryJob(
        { ns: namespace, queue: "fetch" },
        child.id,
        serializeError(new Error("broke")),
        { retention: false, keepStacktraces: 1 },
        Date.now(),
      );
      await driver.recordChild(
        ref,
        flow.job.id,
        { queue: "fetch", id: child.id },
        {
          completed: false,
          error: serializeError(new Error("broke")),
          ignored: false,
        },
        Date.now(),
      );
      expect((await driver.getJob(ref, flow.job.id))?.state).toBe("dead");
      return flow.job.id;
    };

    const viaJob = await bury();
    const viaRetryJobs = await bury();
    const viaRetryAll = await bury();

    const job = await queue.getJob(viaJob);
    expect(await job!.retry()).toBe(true);
    expect(await queue.retryJobs([viaRetryJobs])).toEqual([viaRetryJobs]);
    expect(await queue.retryAll("dead")).toEqual([viaRetryAll]);

    for (const id of [viaJob, viaRetryJobs, viaRetryAll]) {
      const record = await driver.getJob(ref, id);
      expect(record?.state).toBe("waiting-children");
      expect(record?.flow?.pending).toBe(1);
    }

    // And a parent still waiting is not finished, so no path moves it.
    expect(await queue.retry(viaJob)).toBe(false);
    expect((await driver.getJob(ref, viaJob))?.state).toBe("waiting-children");
  });

  it("keeps a sibling's result that arrives while its parent is buried, so the retried flow completes with both", async () => {
    let badAttempts = 0;
    let seen: Record<string, unknown> | undefined;
    const { queue, start, stateOf, other } = setup(
      {
        reports: async (job) => {
          seen = await job.getChildrenValues();
          return "done";
        },
        fetch: async (job) => {
          if (job.name === "bad") {
            badAttempts++;
            if (badAttempts === 1) {
              throw new UnrecoverableJobError("boom");
            }
            return "fixed";
          }
          // Finishes after its sibling has buried the parent.
          await Bun.sleep(150);
          return "slow-ok";
        },
      },
      new MemoryDriver(),
    );

    const flow = await queue.addFlow({
      name: "p",
      data: {},
      children: [
        { name: "bad", data: {}, queue: "fetch" },
        {
          name: "slow",
          data: {},
          queue: "fetch",
          opts: { removeOnComplete: true },
        },
      ],
    });
    const [bad, slow] = flow.children;
    start();

    await waitFor(
      async () => (await stateOf("reports", flow.job.id)) === "dead",
      { timeout: 5_000 },
    );
    // The sibling completes against a buried parent: its result is kept there,
    // and its own retention then removes it.
    await waitFor(
      async () => (await stateOf("fetch", slow!.job.id)) === undefined,
      { timeout: 5_000, message: "the sibling was never released" },
    );
    expect(await stateOf("reports", flow.job.id)).toBe("dead");

    // Retry the parent first, then the failed child.
    expect(await queue.retry(flow.job.id)).toBe(true);
    expect(await other("fetch").retry(bad!.job.id)).toBe(true);

    await waitFor(
      async () => (await stateOf("reports", flow.job.id)) === "completed",
      { timeout: 5_000, message: "the retried flow never completed" },
    );
    expect(seen).toEqual({
      [`fetch:${bad!.job.id}`]: "fixed",
      [`fetch:${slow!.job.id}`]: "slow-ok",
    });
  });

  it("completes a flow whose failed child is retried before its buried parent", async () => {
    let attempts = 0;
    const { queue, start, stateOf, other } = setup({
      reports: async (job) => await job.getChildrenValues(),
      fetch: async () => {
        attempts++;
        if (attempts === 1) {
          throw new UnrecoverableJobError("boom");
        }
        return "fixed";
      },
    });

    const flow = await queue.addFlow({
      name: "p",
      data: {},
      children: [
        {
          name: "bad",
          data: {},
          queue: "fetch",
          opts: { removeOnComplete: true },
        },
      ],
    });
    const child = flow.children[0]!;
    start();

    await waitFor(
      async () => (await stateOf("reports", flow.job.id)) === "dead",
      { timeout: 5_000 },
    );
    expect(await other("fetch").retry(child.job.id)).toBe(true);
    // It completes against the buried parent, which keeps the result.
    await waitFor(
      async () => (await stateOf("fetch", child.job.id)) === undefined,
      { timeout: 5_000 },
    );

    expect(await queue.retry(flow.job.id)).toBe(true);
    await waitFor(
      async () => (await stateOf("reports", flow.job.id)) === "completed",
      { timeout: 5_000, message: "the parent waited on a result it had" },
    );
    expect((await queue.getJob(flow.job.id))?.returnValue).toEqual({
      [`fetch:${child.job.id}`]: "fixed",
    });
  });

  it("rejects a flow holding the same job twice, or a job under itself, before writing anything", async () => {
    const driver = new MemoryDriver();
    const { queue, namespace } = setup({}, driver);

    const nothingWritten = async () => {
      for (const name of ["reports", "fetch"]) {
        const counts = await driver.countJobs({ ns: namespace, queue: name });
        expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(0);
      }
    };

    // Two siblings with one id.
    const duplicate = queue.addFlow({
      name: "p",
      data: {},
      children: [
        { name: "c1", data: {}, queue: "fetch", opts: { jobId: "dup" } },
        { name: "c2", data: {}, queue: "fetch", opts: { jobId: "dup" } },
      ],
    });
    await expect(duplicate).rejects.toBeInstanceOf(ConfigError);
    await expect(duplicate).rejects.toThrow("more than once");
    await nothingWritten();

    // A child with its parent's id, in its parent's queue.
    const self = queue.addFlow({
      name: "p",
      data: {},
      opts: { jobId: "self" },
      children: [{ name: "c", data: {}, opts: { jobId: "self" } }],
    });
    await expect(self).rejects.toBeInstanceOf(ConfigError);
    await expect(self).rejects.toThrow("child of itself");
    await nothingWritten();

    // A grandchild with its grandparent's id, found only by walking the tree;
    // the valid first branch must not have been written either.
    const deep = queue.addFlow({
      name: "top",
      data: {},
      opts: { jobId: "root" },
      children: [
        { name: "fine", data: {}, queue: "fetch" },
        {
          name: "middle",
          data: {},
          children: [{ name: "loop", data: {}, opts: { jobId: "root" } }],
        },
      ],
    });
    await expect(deep).rejects.toBeInstanceOf(ConfigError);
    await nothingWritten();

    // The same id in two different queues is two different jobs.
    const distinct = await queue.addFlow({
      name: "p",
      data: {},
      opts: { jobId: "shared" },
      children: [
        { name: "c", data: {}, queue: "fetch", opts: { jobId: "shared" } },
      ],
    });
    expect(distinct.children[0]!.job.id).toBe("shared");
  });

  it("delivers a child that finished before its parent was added, without waiting for maintenance", async () => {
    const driver = new MemoryDriver();
    const addJob = driver.addJob.bind(driver);
    const order: string[] = [];
    let namespace = "";

    // Holds the parent's add until its child has completed, the way a quick
    // child can beat a slow add over the network.
    driver.addJob = async (ref, record) => {
      order.push(`${ref.queue}:${record.state}`);
      if (record.state === "waiting-children") {
        const childId = record.flow!.children[0]!.id;
        await waitFor(
          async () =>
            (await driver.getJob({ ns: namespace, queue: "fetch" }, childId))
              ?.state === "completed",
          { timeout: 5_000, message: "the child never completed" },
        );
      }
      return await addJob(ref, record);
    };

    const env = setup(
      {
        reports: async (job) => await job.getChildrenValues(),
        fetch: async () => "early",
      },
      driver,
      // Maintenance a minute apart: only a prompt retry can deliver it.
      { healing: false },
    );
    namespace = env.namespace;
    env.start();

    const flow = await env.queue.addFlow({
      name: "report",
      data: {},
      children: [{ name: "quick", data: {}, queue: "fetch" }],
    });
    expect(order).toEqual(["fetch:waiting", "reports:waiting-children"]);

    await waitFor(
      async () => (await env.stateOf("reports", flow.job.id)) === "completed",
      { timeout: 5_000, message: "the early result was never delivered" },
    );
    expect((await env.queue.getJob(flow.job.id))?.returnValue).toEqual({
      [`fetch:${flow.children[0]!.job.id}`]: "early",
    });
    // Kept until delivered, then marked.
    const child = await driver.getJob(
      { ns: env.namespace, queue: "fetch" },
      flow.children[0]!.job.id,
    );
    expect(child?.flow?.recorded).toBe(true);
  });

  it("keeps a child marked removeOnComplete until its parent has its result", async () => {
    const driver = new MemoryDriver();
    const recordChild = driver.recordChild.bind(driver);
    // Every delivery fails until the worker has given up on it, as if the
    // worker died before telling the parent.
    let failing = true;
    let gaveUp = false;
    driver.recordChild = async (...args: Parameters<typeof recordChild>) => {
      if (failing) {
        throw new Error("the parent could not be told");
      }
      return await recordChild(...args);
    };
    const onError = (context: string) => {
      if (context === "flow") {
        gaveUp = true;
        failing = false;
      }
    };

    const { queue, start, stateOf } = setup(
      {
        reports: async (job) => await job.getChildrenValues(),
        fetch: async () => "value",
      },
      driver,
      { onError },
    );

    const flow = await queue.addFlow({
      name: "report",
      data: {},
      children: [
        {
          name: "short-lived",
          data: {},
          queue: "fetch",
          opts: { removeOnComplete: true },
        },
      ],
    });
    start();

    await waitFor(
      async () => (await stateOf("reports", flow.job.id)) === "completed",
      {
        timeout: 10_000,
        message: "the child was gone before its parent had it",
      },
    );
    expect(gaveUp).toBe(true);

    const parent = await queue.getJob(flow.job.id);
    expect(parent?.returnValue).toEqual({
      [`fetch:${flow.children[0]!.job.id}`]: "value",
    });
    // Once the parent has it, the child's own retention applies.
    await waitFor(
      async () =>
        (await stateOf("fetch", flow.children[0]!.job.id)) === undefined,
      { timeout: 5_000 },
    );
  });

  it("emits and publishes failed and dead for a parent a child buried, and dead-letters it", async () => {
    const localEvents: string[] = [];
    const heard: string[] = [];
    const { queue, start, stateOf, workers, driver, namespace } = setup(
      {
        reports: async (job) => {
          if (job.name === "broken") {
            throw new UnrecoverableJobError("no");
          }
          return "ok";
        },
      },
      new MemoryDriver(),
      { subscribe: true, publish: true },
    );
    await queue.connect();
    queue.on("failed", (job) => heard.push(`failed:${job.name}`));
    queue.on("dead", (job) => heard.push(`dead:${job.name}`));

    const flow = await queue.addFlow({
      name: "parent",
      data: {},
      opts: { deadLetter: "graveyard" },
      // In the parent's own queue, so the worker burying it is its worker.
      children: [{ name: "broken", data: {} }],
    });
    start();
    const worker = workers.reports!;
    worker.on("dead", (job) => localEvents.push(`dead:${job.name}`));
    worker.on("failed", (job) => localEvents.push(`failed:${job.name}`));

    await waitFor(
      async () => (await stateOf("reports", flow.job.id)) === "dead",
      { timeout: 5_000 },
    );
    await waitFor(
      async () =>
        heard.includes("dead:parent") && heard.includes("failed:parent"),
      { timeout: 5_000, message: `heard only ${heard.join(", ")}` },
    );
    await waitFor(async () => localEvents.includes("dead:parent"), {
      timeout: 5_000,
      message: `emitted only ${localEvents.join(", ")}`,
    });
    expect(localEvents).toContain("failed:parent");

    // Filed like any dead job's letter, naming the parent's queue.
    const letterId = `reports:${flow.job.id}:${flow.job.createdAt}`;
    await waitFor(
      async () =>
        (await driver.getJob(
          { ns: namespace, queue: "graveyard" },
          letterId,
        )) !== null,
      { timeout: 5_000, message: "no dead letter for the buried parent" },
    );
    const letter = await driver.getJob(
      { ns: namespace, queue: "graveyard" },
      letterId,
    );
    expect(letter?.data).toMatchObject({ queue: "reports", id: flow.job.id });
  });

  it("applies removeOnFail to a top-level parent a child buried, and defers a nested parent's to its own parent", async () => {
    const { queue, start, stateOf } = setup({
      reports: async () => "never",
      fetch: async () => {
        throw new UnrecoverableJobError("broke");
      },
    });

    // A top-level parent with removeOnFail: gone once buried, so it cannot be
    // retried — that is what fail by default with removeOnFail means.
    const lone = await queue.addFlow({
      name: "lone",
      data: {},
      opts: { removeOnFail: true },
      children: [{ name: "child", data: {}, queue: "fetch" }],
    });

    // A nested parent with removeOnFail under a top that keeps its failures:
    // the middle stays until the top has recorded it, then goes.
    const nested = await queue.addFlow({
      name: "top",
      data: {},
      children: [
        {
          name: "middle",
          data: {},
          opts: { removeOnFail: true },
          children: [{ name: "leaf", data: {}, queue: "fetch" }],
        },
      ],
    });
    start();

    await waitFor(
      async () => (await stateOf("reports", lone.job.id)) === undefined,
      { timeout: 5_000, message: "the buried top-level parent was kept" },
    );

    await waitFor(
      async () => (await stateOf("reports", nested.job.id)) === "dead",
      { timeout: 5_000 },
    );
    await waitFor(
      async () =>
        (await stateOf("reports", nested.children[0]!.job.id)) === undefined,
      { timeout: 5_000, message: "the nested parent's retention never ran" },
    );
    expect(await stateOf("reports", nested.job.id)).toBe("dead");
  });

  it("publishes waiting on the parent's queue when its last child releases it", async () => {
    const waiting: string[] = [];
    const { queue, start } = setup(
      // No worker on reports: the released parent stays waiting.
      { fetch: async () => "v" },
      new MemoryDriver(),
      { subscribe: true, publish: true },
    );
    await queue.connect();
    queue.on("waiting", (job) => waiting.push(job.id));

    const flow = await queue.addFlow({
      name: "report",
      data: {},
      children: [{ name: "c", data: {}, queue: "fetch" }],
    });
    start();

    await waitFor(async () => waiting.includes(flow.job.id), {
      timeout: 5_000,
      message: "no waiting event for the released parent",
    });
  });

  it("announces added on each child's own queue", async () => {
    const onFetch: string[] = [];
    const onReports: string[] = [];
    const { queue, other } = setup({}, new MemoryDriver(), {
      subscribe: true,
    });
    const fetch = other("fetch", true);
    await fetch.connect();
    await queue.connect();
    fetch.on("added", (job) => onFetch.push(job.id));
    queue.on("added", (job) => onReports.push(job.id));

    const flow = await queue.addFlow({
      name: "report",
      data: {},
      children: [
        { name: "a", data: {}, queue: "fetch" },
        { name: "b", data: {}, queue: "fetch" },
      ],
    });
    const childIds = flow.children.map((child) => child.job.id);

    await waitFor(async () => childIds.every((id) => onFetch.includes(id)), {
      timeout: 5_000,
      message: `fetch heard only ${onFetch.join(", ")}`,
    });
    // The calling queue hears about its own job only.
    expect(onReports).toEqual([flow.job.id]);
    expect(onFetch).not.toContain(flow.job.id);
  });
});

describe("flows: healing", () => {
  it("delivers a child's result that a crash kept from its parent", async () => {
    const driver = new MemoryDriver();
    const recordChild = driver.recordChild.bind(driver);
    let failing = true;
    let gaveUp = false;
    driver.recordChild = async (...args: Parameters<typeof recordChild>) => {
      if (failing) {
        throw new Error("the parent could not be told");
      }
      return await recordChild(...args);
    };
    const onError = (context: string) => {
      if (context === "flow") {
        gaveUp = true;
        failing = false;
      }
    };

    const { queue, start, stateOf } = setup(
      {
        reports: async (job) => await job.getChildrenValues(),
        fetch: async () => 42,
      },
      driver,
      { onError },
    );

    const flow = await queue.addFlow({
      name: "report",
      data: {},
      children: [{ name: "count", data: {}, queue: "fetch" }],
    });
    start();

    await waitFor(
      async () => (await stateOf("reports", flow.job.id)) === "completed",
      { timeout: 10_000, message: "the parent never got its child's result" },
    );
    expect(gaveUp).toBe(true);
  });

  it("finishes a child's retention after marking it recorded failed", async () => {
    const driver = new MemoryDriver();
    const markChildRecorded = driver.markChildRecorded.bind(driver);
    let failing = true;
    let calls = 0;
    driver.markChildRecorded = async (
      ...args: Parameters<typeof markChildRecorded>
    ) => {
      calls++;
      if (failing && args[0].queue === "fetch") {
        throw new Error("the mark could not be written");
      }
      return await markChildRecorded(...args);
    };
    let mending: ReturnType<typeof setTimeout> | undefined;
    closers.push(async () => clearTimeout(mending));

    const { queue, start, stateOf } = setup(
      {
        reports: async (job) => await job.getChildrenValues(),
        fetch: async () => "v",
      },
      driver,
      {
        // Maintenance a minute apart: only the remembered delivery can finish.
        healing: false,
        onError: (context) => {
          // Mended a second after the first give-up, when every write retry
          // in flight has long run out — so what applies the mark is a
          // delivery the worker remembered, not a straggling retry. (The
          // parent's worker delivers too, on its first maintenance pass.)
          if (context === "flow" && !mending) {
            mending = setTimeout(() => {
              failing = false;
            }, 1_000);
          }
        },
      },
    );

    const flow = await queue.addFlow({
      name: "report",
      data: {},
      children: [
        {
          name: "c",
          data: {},
          queue: "fetch",
          opts: { removeOnComplete: true },
        },
      ],
    });
    start();

    // The result reached the parent before the mark failed.
    await waitFor(
      async () => (await stateOf("reports", flow.job.id)) === "completed",
      { timeout: 5_000 },
    );
    await waitFor(
      async () =>
        (await stateOf("fetch", flow.children[0]!.job.id)) === undefined,
      { timeout: 5_000, message: "the child's retention never ran" },
    );
    expect(calls).toBeGreaterThan(1);
  });

  it("finds finished children no worker remembers, delivers them, and releases orphans past the grace period", async () => {
    const driver = new MemoryDriver();
    const { namespace, start, stateOf } = setup(
      { fetch: async () => "unused" },
      driver,
    );
    const fetchRef = { ns: namespace, queue: "fetch" };
    const reportsRef = { ns: namespace, queue: "reports" };
    const now = Date.now();
    const childFlow = (parentId: string) => ({
      parent: { queue: "reports", id: parentId },
      children: [],
      pending: 0,
      values: {},
      failures: {},
      recorded: false,
    });

    // A parent that already ran, holding the result: the mark was lost.
    await driver.addJob(
      reportsRef,
      makeJob({
        id: "ran",
        state: "completed",
        finishedOn: now,
        flow: {
          parent: null,
          children: [{ queue: "fetch", id: "unmarked" }],
          pending: 0,
          values: { "fetch:unmarked": 1 },
          failures: {},
          recorded: false,
        },
      }),
    );
    await driver.addJobs(fetchRef, [
      makeJob({
        id: "unmarked",
        state: "completed",
        finishedOn: now,
        returnValue: 1,
        opts: { ...makeJob().opts, removeOnComplete: true },
        flow: childFlow("ran"),
      }),
      // Its parent never arrived, and it finished long ago.
      makeJob({
        id: "orphan",
        state: "completed",
        finishedOn: now - 10 * 60_000,
        returnValue: 2,
        opts: { ...makeJob().opts, removeOnComplete: true },
        flow: childFlow("never-added"),
      }),
      // Its parent never arrived either, but it finished just now: kept.
      makeJob({
        id: "early",
        state: "completed",
        finishedOn: now,
        returnValue: 3,
        opts: { ...makeJob().opts, removeOnComplete: true },
        flow: childFlow("still-coming"),
      }),
    ]);
    start();

    await waitFor(
      async () => (await stateOf("fetch", "unmarked")) === undefined,
      {
        timeout: 5_000,
        message: "an unrecorded child was never found",
      },
    );
    await waitFor(
      async () => (await stateOf("fetch", "orphan")) === undefined,
      {
        timeout: 5_000,
        message: "an orphan was never released",
      },
    );
    expect((await driver.getJob(fetchRef, "early"))?.flow?.recorded).toBe(
      false,
    );
  });

  it("reaches parents past the first page of maintenance", async () => {
    const driver = new MemoryDriver();
    const { namespace, start, stateOf } = setup(
      { reports: async () => "ran" },
      driver,
    );
    const fetchRef = { ns: namespace, queue: "fetch" };
    const reportsRef = { ns: namespace, queue: "reports" };
    const now = Date.now();
    const flowOf = (overrides: Partial<NonNullable<JobRecord["flow"]>>) => ({
      parent: null,
      children: [],
      pending: 0,
      values: {},
      failures: {},
      recorded: false,
      ...overrides,
    });

    // A full page of parents whose children are still waiting — nothing on
    // "fetch" runs them, so maintenance finds nothing to do for any of them.
    for (let i = 0; i < 100; i++) {
      await driver.addJob(
        fetchRef,
        makeJob({
          id: `w${i}`,
          flow: flowOf({ parent: { queue: "reports", id: `p${i}` } }),
        }),
      );
      await driver.addJob(
        reportsRef,
        makeJob({
          id: `p${i}`,
          state: "waiting-children",
          createdAt: now - 10_000 + i,
          flow: flowOf({
            children: [{ queue: "fetch", id: `w${i}` }],
            pending: 1,
          }),
        }),
      );
    }
    // The 101st: its child completed and the delivery was lost. Only
    // maintenance on "reports" can release it.
    await driver.addJob(
      fetchRef,
      makeJob({
        id: "done",
        state: "completed",
        finishedOn: now,
        returnValue: 7,
        flow: flowOf({ parent: { queue: "reports", id: "late" } }),
      }),
    );
    await driver.addJob(
      reportsRef,
      makeJob({
        id: "late",
        state: "waiting-children",
        createdAt: now,
        flow: flowOf({
          children: [{ queue: "fetch", id: "done" }],
          pending: 1,
        }),
      }),
    );
    start();

    await waitFor(
      async () => (await stateOf("reports", "late")) === "completed",
      {
        timeout: 5_000,
        message: "maintenance never looked past the first page",
      },
    );
  });

  it("fails a parent whose child never arrived, once the grace period has passed", async () => {
    const driver = new MemoryDriver();
    const { queue, start, stateOf, namespace } = setup(
      { reports: async () => "never" },
      driver,
    );

    // A parent listing a child that was never added — a flow cut short — and
    // old enough to be past the grace period.
    const old = Date.now() - 10 * 60_000;
    const parent: JobRecord = {
      ...(await queue.add("placeholder", {})).toJSON(),
      id: "orphaned",
      state: "waiting-children",
      createdAt: old,
      runAt: old,
      flow: {
        parent: null,
        children: [{ queue: "fetch", id: "never-added" }],
        pending: 1,
        values: {},
        failures: {},
        recorded: false,
      },
    };
    await driver.addJob({ ns: namespace, queue: "reports" }, parent);
    start();

    await waitFor(
      async () => (await stateOf("reports", "orphaned")) === "dead",
      { timeout: 5_000 },
    );
    const buried = await driver.getJob(
      { ns: namespace, queue: "reports" },
      "orphaned",
    );
    expect(buried?.failedReason?.name).toBe(ChildFailedError.name);
    expect(buried?.failedReason?.message).toContain("fetch:never-added");
    expect(buried?.failedReason?.message).toContain("does not exist");
  });
});

/* --- every backend ------------------------------------------------------ */

/**
 * The backends a flow runs on end to end, beyond memory: file and SQLite
 * always, and each server whose URL is set. One whose server is unreachable
 * is skipped visibly rather than passing without running.
 */
/**
 * Every backend the per-backend cases run on: the memory driver too, the one
 * that is always there, so each case also runs where no server is configured,
 * and a race it guards shows on the reference driver as well.
 */
const backends: Backend[] = [
  { name: "memory", config: { type: "memory" }, available: true },
  ...(await crossProcessBackends({ cleanups })),
];

/**
 * A test timeout for each case on a server, above the waits inside it: a flow
 * there makes dozens of round trips, and under a loaded full suite the default
 * five seconds is not always enough.
 */
const BACKEND_TEST_TIMEOUT = 30_000;

for (const backend of backends) {
  describe.skipIf(!backend.available)(`flows on ${backend.name}`, () => {
    /** A fresh driver on the backend, closed after the test. */
    const makeDriver = (): JobsDriver => {
      const config = (
        backend.config.type === "sql"
          ? { ...backend.config, syncSchema: true }
          : backend.config
      ) as DriverConfig;
      const driver = createDriver(config);
      // Registered first, so it closes after the workers and queues using it.
      closers.push(() => driver.close());
      return driver;
    };

    it(
      "delivers children's results in two queues to their parent",
      async () => {
        const { queue, start, stateOf } = setup(
          {
            reports: async (job) => await job.getChildrenValues(),
            fetch: async (job) => job.data.n * 2,
          },
          makeDriver(),
          { healing: false },
        );

        const flow = await queue.addFlow({
          name: "report",
          data: {},
          children: [
            { name: "a", data: { n: 1 }, queue: "fetch" },
            { name: "b", data: { n: 2 }, queue: "fetch" },
          ],
        });
        start();

        await waitFor(
          async () => (await stateOf("reports", flow.job.id)) === "completed",
          { timeout: 15_000 },
        );
        expect((await queue.getJob(flow.job.id))?.returnValue).toEqual({
          [`fetch:${flow.children[0]!.job.id}`]: 2,
          [`fetch:${flow.children[1]!.job.id}`]: 4,
        });
      },
      BACKEND_TEST_TIMEOUT,
    );

    it(
      "buries a parent up the flow when a child fails",
      async () => {
        const { queue, start, stateOf } = setup(
          {
            reports: async () => null,
            fetch: async () => {
              throw new UnrecoverableJobError("gone");
            },
          },
          makeDriver(),
        );

        const flow = await queue.addFlow({
          name: "top",
          data: {},
          children: [
            {
              name: "middle",
              data: {},
              children: [{ name: "broken", data: {}, queue: "fetch" }],
            },
          ],
        });
        start();

        await waitFor(
          async () => (await stateOf("reports", flow.job.id)) === "dead",
          { timeout: 15_000 },
        );
        expect(await stateOf("reports", flow.children[0]!.job.id)).toBe("dead");
      },
      BACKEND_TEST_TIMEOUT,
    );

    // Both orders, since a retry promises either works. Parent first is the
    // one that raced: a failure delivery maintenance decided from a view older
    // than the bury can still be waiting on the parent's hold, and land after
    // the parent's retry — or after both retries. Every driver refuses it
    // either way, as stale: a child recorded, or no longer dead (pinned
    // deterministically in the driver contract). Child first, the child's
    // result is kept on the still-buried parent before its retry, so such a
    // delivery finds an outcome already there.
    for (const order of ["parent first", "child first"] as const) {
      const title =
        order === "parent first"
          ? "completes a buried flow once its parent and failed child are retried"
          : "completes a buried flow once its failed child and then its parent are retried";

      it(
        title,
        async () => {
          let attempts = 0;
          const { queue, start, stateOf, other, driver, namespace } = setup(
            {
              reports: async (job) => await job.getChildrenValues(),
              fetch: async (job) => {
                if (job.name === "bad" && attempts++ === 0) {
                  throw new UnrecoverableJobError("first try fails");
                }
                return job.name;
              },
            },
            makeDriver(),
          );

          const flow = await queue.addFlow({
            name: "report",
            data: {},
            children: [
              { name: "bad", data: {}, queue: "fetch" },
              { name: "good", data: {}, queue: "fetch" },
            ],
          });
          start();

          const [bad, good] = flow.children;
          const parentRef = { ns: namespace, queue: "reports" };
          const childRef = { ns: namespace, queue: "fetch" };
          /** Where the flow stands, for a wait that runs out. */
          const explain = async () => {
            const read = async (ref: typeof parentRef, id: string) => {
              const record = await driver.getJob(ref, id);
              return {
                state: record?.state,
                recorded: record?.flow?.recorded,
                pending: record?.flow?.pending,
                values: record?.flow?.values,
                failedReason: record?.failedReason?.message,
              };
            };
            return JSON.stringify({
              order,
              parent: await read(parentRef, flow.job.id),
              bad: await read(childRef, bad!.job.id),
              good: await read(childRef, good!.job.id),
            });
          };

          await waitFor(
            async () => (await stateOf("reports", flow.job.id)) === "dead",
            { timeout: 15_000, message: explain },
          );
          await waitFor(
            async () => (await stateOf("fetch", good!.job.id)) === "completed",
            { timeout: 15_000, message: explain },
          );
          // The failure that buried it has been delivered in full.
          await waitFor(
            async () =>
              (await driver.getJob(childRef, bad!.job.id))?.flow?.recorded ===
              true,
            { timeout: 15_000, message: explain },
          );

          if (order === "parent first") {
            // Back to back, as a person retrying both would.
            expect(await queue.retry(flow.job.id)).toBe(true);
            expect(await other("fetch").retry(bad!.job.id)).toBe(true);
          } else {
            expect(await other("fetch").retry(bad!.job.id)).toBe(true);
            await waitFor(
              async () =>
                Object.hasOwn(
                  (await driver.getJob(parentRef, flow.job.id))?.flow?.values ??
                    {},
                  `fetch:${bad!.job.id}`,
                ),
              { timeout: 15_000, message: explain },
            );
            expect(await stateOf("reports", flow.job.id)).toBe("dead");
            expect(await queue.retry(flow.job.id)).toBe(true);
          }

          await waitFor(
            async () => (await stateOf("reports", flow.job.id)) === "completed",
            { timeout: 15_000, message: explain },
          );
          expect((await queue.getJob(flow.job.id))?.returnValue).toEqual({
            [`fetch:${bad!.job.id}`]: "bad",
            [`fetch:${good!.job.id}`]: "good",
          });
        },
        BACKEND_TEST_TIMEOUT,
      );
    }

    it(
      "does not bury a retried parent again with the failure that buried it",
      async () => {
        // Delivering a failure is two writes: bury the parent, then mark the
        // child recorded. A retry of the parent landing between them used to
        // leave a dead, unrecorded child that maintenance delivered again,
        // burying the parent a second time; the retried child's result then
        // reached a dead parent, which never ran. Deferring the mark makes
        // that window as wide as the test needs.
        const driver = makeDriver();
        const mark = driver.markChildRecorded!.bind(driver);
        let badId = "";
        let released = false;
        const deferred: Parameters<typeof mark>[] = [];
        // Every worker's mark of the failed child is answered at once but
        // written only on release, maintenance's repeats included: one of
        // those landing would close the window by itself, and one kept
        // waiting would stall the maintenance that reburies. The retry's own
        // mark is the fix, and goes straight through — told apart by its
        // caller, since a maintenance mark during the retry must still wait.
        driver.markChildRecorded = async (...args: Parameters<typeof mark>) => {
          const fromRetry =
            new Error("caller").stack?.includes("markBuryDelivered") === true;
          if (args[1] === badId && !fromRetry && !released) {
            deferred.push(args);
            return true;
          }
          return await mark(...args);
        };
        // Maintenance in the children's queue delivers dead children from a
        // page it listed earlier, and a page listed before the retry's mark
        // can still bury the parent after it — a separate, narrower race this
        // test does not cover. So that sweep never sees the failed child while
        // the mark is out; the parents' sweep, which reads the child fresh,
        // is the one that buried a second time.
        const listJobs = driver.listJobs.bind(driver);
        driver.listJobs = async (...args: Parameters<typeof listJobs>) => {
          const page = await listJobs(...args);
          return released || args[0].queue !== "fetch"
            ? page
            : page.filter((record) => record.id !== badId);
        };
        const release = async () => {
          released = true;
          for (const args of deferred.splice(0)) {
            await mark(...args);
          }
        };
        let attempts = 0;
        const { queue, start, stateOf, other } = setup(
          {
            reports: async (job) => await job.getChildrenValues(),
            fetch: async (job) => {
              if (job.name === "bad" && attempts++ === 0) {
                throw new UnrecoverableJobError("first try fails");
              }
              return job.name;
            },
          },
          driver,
        );

        const flow = await queue.addFlow({
          name: "report",
          data: {},
          children: [
            { name: "bad", data: {}, queue: "fetch" },
            { name: "good", data: {}, queue: "fetch" },
          ],
        });
        const [bad, good] = flow.children;
        badId = bad!.job.id;
        start();

        await waitFor(
          async () => (await stateOf("reports", flow.job.id)) === "dead",
          { timeout: 15_000 },
        );
        await waitFor(
          async () => (await stateOf("fetch", good!.job.id)) === "completed",
          { timeout: 15_000 },
        );
        await waitFor(() => deferred.length > 0, { timeout: 15_000 });

        expect(await queue.retry(flow.job.id)).toBe(true);
        // Many maintenance passes (every 20 ms) while the mark is still out.
        await Bun.sleep(300);
        expect(await stateOf("reports", flow.job.id)).toBe("waiting-children");

        await release();
        expect(await other("fetch").retry(bad!.job.id)).toBe(true);
        await waitFor(
          async () => (await stateOf("reports", flow.job.id)) === "completed",
          { timeout: 15_000 },
        );
        expect((await queue.getJob(flow.job.id))?.returnValue).toEqual({
          [`fetch:${bad!.job.id}`]: "bad",
          [`fetch:${good!.job.id}`]: "good",
        });
      },
      BACKEND_TEST_TIMEOUT,
    );

    it(
      "heals a delivery a crash kept from its parent",
      async () => {
        const driver = makeDriver();
        const recordChild = driver.recordChild!.bind(driver);
        let failing = true;
        driver.recordChild = async (
          ...args: Parameters<typeof recordChild>
        ) => {
          if (failing) {
            throw new Error("the parent could not be told");
          }
          return await recordChild(...args);
        };

        const { queue, start, stateOf } = setup(
          {
            reports: async (job) => await job.getChildrenValues(),
            fetch: async () => "healed",
          },
          driver,
          {
            onError: (context) => {
              if (context === "flow") {
                failing = false;
              }
            },
          },
        );

        const flow = await queue.addFlow({
          name: "report",
          data: {},
          children: [{ name: "c", data: {}, queue: "fetch" }],
        });
        start();

        await waitFor(
          async () => (await stateOf("reports", flow.job.id)) === "completed",
          { timeout: 15_000 },
        );
        expect((await queue.getJob(flow.job.id))?.returnValue).toEqual({
          [`fetch:${flow.children[0]!.job.id}`]: "healed",
        });
      },
      BACKEND_TEST_TIMEOUT,
    );
  });
}
