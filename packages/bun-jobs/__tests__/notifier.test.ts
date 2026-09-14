import type { DriverEvent } from "../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  BunRunner,
  JobsNotifier,
  MemoryDriver,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * One stream of every event in a namespace.
 *
 * Producers, workers and runners here share one memory driver, which is what
 * separate processes sharing a backend reduce to for the purpose of this
 * test: the notifier learns of events only through the driver.
 */

const fixture = (name: string) =>
  join(import.meta.dir, "fixtures", "handlers", `${name}.ts`);

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

/** A shared driver and namespace, and a notifier recording what it hears. */
async function setup(
  options: ConstructorParameters<typeof JobsNotifier>[2] = {},
) {
  const driver = new MemoryDriver();
  const namespace = testNamespace();
  const notifier = new JobsNotifier(driver, namespace, {
    discoveryInterval: 20,
    ...options,
  });
  const heard: DriverEvent[] = [];
  notifier.on("event", (event) => heard.push(event));
  closers.push(() => notifier.close());
  return { driver, namespace, notifier, heard };
}

/** A description of an event that is easy to compare. */
const describeEvent = (event: DriverEvent) =>
  `${event.kind}:${event.target}:${event.type}`;

describe("JobsNotifier", () => {
  it("hears queue and worker events, including a queue first used after it started", async () => {
    const { driver, namespace, notifier, heard } = await setup();
    await notifier.start();

    const queue = new BunQueue("mail", {
      namespace,
      driver,
      logger: noopLogger,
      publish: true,
    });
    const worker = new BunQueueWorker("mail", async () => "sent", {
      namespace,
      driver,
      logger: noopLogger,
      publish: true,
      pollInterval: 5,
      waitToExit: false,
    });
    closers.push(
      () => queue.close(),
      () => worker.close({ force: true }),
    );

    // The queue exists only once used; discovery has to find it.
    await driver.ensureQueue({ ns: namespace, queue: "mail" });
    await waitFor(() => notifier.following.includes("queue:mail"), {
      timeout: 5_000,
      message: "the notifier never discovered the new queue",
    });

    void worker.run();
    const job = await queue.add("welcome", { to: "ops" });

    await waitFor(
      () =>
        heard.some(
          (event) =>
            event.kind === "queue" &&
            event.type === "completed" &&
            event.payload.id === job.id,
        ),
      { timeout: 5_000 },
    );

    const described = heard.map(describeEvent);
    expect(described).toContain("queue:mail:added");
    expect(described).toContain("queue:mail:active");
    expect(described).toContain("queue:mail:completed");
  });

  it("hears runner events, including the reason a run was killed", async () => {
    const { driver, namespace, notifier, heard } = await setup();

    const runner = new BunRunner({
      id: "report",
      namespace,
      file: fixture("graceful"),
      executionMode: "in-process",
      driver,
      logger: noopLogger,
      waitToExit: false,
      publish: true,
      args: { ms: 10_000 },
    });
    closers.push(() => runner.stop({ force: true }));
    await runner.start();

    const outcome = await runner.trigger();
    await notifier.start();
    await waitFor(() => notifier.following.includes("runner:report"), {
      timeout: 5_000,
    });

    const runId = outcome.outcome === "started" ? outcome.runId : undefined;
    // Heard as `killed`, with the reason, even though the handler unwinds
    // cleanly on its signal: a run stopped on request is a kill in every mode.
    await runner.kill(runId, { reason: "operator cancelled" });

    await waitFor(
      () =>
        heard.some(
          (event) => event.kind === "runner" && event.type !== "started",
        ),
      { timeout: 5_000 },
    );

    const second = await runner.trigger();
    await waitFor(
      () =>
        heard.some(
          (event) =>
            event.kind === "runner" &&
            event.type === "started" &&
            second.outcome === "started" &&
            event.payload.runId === second.runId,
        ),
      { timeout: 5_000 },
    );
    expect(heard.map(describeEvent)).toContain("runner:report:started");
  });

  it("follows only the queues and runners it was given", async () => {
    const { driver, namespace, notifier, heard } = await setup({
      queues: ["kept"],
      runners: [],
    });
    await notifier.start();

    const kept = new BunQueue("kept", {
      namespace,
      driver,
      logger: noopLogger,
      publish: true,
    });
    const ignored = new BunQueue("ignored", {
      namespace,
      driver,
      logger: noopLogger,
      publish: true,
    });
    closers.push(
      () => kept.close(),
      () => ignored.close(),
    );

    await kept.add("x", {});
    await ignored.add("x", {});
    await Bun.sleep(100);

    expect(notifier.following).toEqual(["queue:kept"]);
    // Each add is heard as `added` and `waiting`, all from the kept queue.
    expect(heard.length).toBeGreaterThan(0);
    expect(new Set(heard.map((event) => event.target))).toEqual(
      new Set(["kept"]),
    );
  });

  it("works as an async iterator, and ends it on close", async () => {
    const { driver, namespace, notifier } = await setup({ queues: ["stream"] });
    await notifier.start();

    const queue = new BunQueue("stream", {
      namespace,
      driver,
      logger: noopLogger,
      publish: true,
    });
    closers.push(() => queue.close());

    const collected: string[] = [];
    const reading = (async () => {
      for await (const event of notifier) {
        // Each add publishes `added` then `waiting`; count the adds.
        if (event.type === "added") {
          collected.push(event.type);
        }
        if (collected.length === 3) {
          break;
        }
      }
    })();

    for (let index = 0; index < 3; index++) {
      await queue.add("x", { index });
    }
    await reading;
    expect(collected).toEqual(["added", "added", "added"]);

    // A second iterator ends when the notifier closes.
    const ended = (async () => {
      for await (const _event of notifier) {
        // Nothing is published after this point.
      }
      return "ended";
    })();
    await notifier.close();
    expect(await ended).toBe("ended");
  });

  it("delivers nothing after close", async () => {
    const { driver, namespace, notifier, heard } = await setup({
      queues: ["quiet"],
    });
    await notifier.start();
    const queue = new BunQueue("quiet", {
      namespace,
      driver,
      logger: noopLogger,
      publish: true,
    });
    closers.push(() => queue.close());

    await notifier.close();
    await queue.add("x", {});
    await Bun.sleep(50);

    expect(heard).toEqual([]);
    expect(notifier.following).toEqual([]);
  });
});

describe("publishEvents on BunJobs", () => {
  it("makes everything the context creates publish, and the notifier hear it", async () => {
    const jobs = new BunJobs({
      namespace: testNamespace(),
      driver: new MemoryDriver(),
      logger: noopLogger,
      publishEvents: true,
    });
    closers.push(() => jobs.close());
    jobs.define("mail", async () => "sent");

    const notifier = await jobs.notifier({ discoveryInterval: 20 });
    const heard: string[] = [];
    notifier.on("event", (event) => heard.push(describeEvent(event)));

    await jobs.start({ pollInterval: 5, waitToExit: false });
    await jobs.now("mail", {});

    await waitFor(() => heard.includes("queue:jobs:completed"), {
      timeout: 5_000,
      message: "nothing the context created was published",
    });
  });

  it("keeps a notifier given a list to that list, whatever the context creates", async () => {
    const jobs = new BunJobs({
      namespace: testNamespace(),
      driver: new MemoryDriver(),
      logger: noopLogger,
      publishEvents: true,
    });
    closers.push(() => jobs.close());
    jobs.define("mail", async () => "sent");
    // Created before the notifier, and after it.
    jobs.queue("early");

    const notifier = await jobs.notifier({
      queues: ["jobs"],
      runners: [],
      discoveryInterval: 20,
    });
    const heard: string[] = [];
    notifier.on("event", (event) => heard.push(describeEvent(event)));

    await jobs.queue("late").add("x", {});
    await jobs.start({ pollInterval: 5, waitToExit: false });
    await jobs.now("mail", {});
    await waitFor(() => heard.includes("queue:jobs:completed"), {
      timeout: 5_000,
    });

    expect(notifier.following).toEqual(["queue:jobs"]);
    expect(heard.every((event) => event.startsWith("queue:jobs:"))).toBe(true);
  });

  it("hears an event published the instant its queue is created, however slow the subscribe", async () => {
    const driver = new MemoryDriver();
    // A networked driver's subscribe takes a round trip; this makes the window
    // between creating a queue and being subscribed to it wide and certain.
    const subscribe = driver.subscribe.bind(driver);
    driver.subscribe = (async (ns, kind, target, listener) => {
      await Bun.sleep(50);
      return await subscribe(ns, kind, target, listener);
    }) as typeof driver.subscribe;

    const jobs = new BunJobs({
      namespace: testNamespace(),
      driver,
      logger: noopLogger,
      publishEvents: true,
    });
    closers.push(() => jobs.close());

    const notifier = await jobs.notifier({ discoveryInterval: 60_000 });
    const heard: string[] = [];
    notifier.on("event", (event) => heard.push(describeEvent(event)));

    // No await between creating the queue and publishing from it.
    await jobs.queue("instant").add("x", {});

    await waitFor(() => heard.includes("queue:instant:added"), {
      timeout: 2_000,
      message: "the add was published before the notifier had subscribed",
    });
  });

  it("publishes nothing by default", async () => {
    const jobs = new BunJobs({
      namespace: testNamespace(),
      driver: new MemoryDriver(),
      logger: noopLogger,
    });
    closers.push(() => jobs.close());
    jobs.define("mail", async () => "sent");

    const notifier = await jobs.notifier({ discoveryInterval: 20 });
    const heard: string[] = [];
    notifier.on("event", (event) => heard.push(describeEvent(event)));

    await jobs.start({ pollInterval: 5, waitToExit: false });
    const job = await jobs.now("mail", {});
    await waitFor(
      async () =>
        (await jobs.queue("jobs").getJob(job.id))?.state === "completed",
      { timeout: 5_000 },
    );
    await Bun.sleep(50);

    expect(heard).toEqual([]);
  });
});
