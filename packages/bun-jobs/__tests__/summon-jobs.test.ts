import type { JobsDriver, SummonRequest } from "../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import {
  BunJobs,
  ConfigError,
  createDriver,
  SummonController,
} from "../lib/index";
import { SUMMON_ARGS } from "../lib/summon/args";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";
import { runBun } from "./helpers/spawnBun";

/**
 * `BunJobs` and summoning: the `summon` option, `summonController()`, the
 * `onAdd` hook on the queues the context creates, closing controllers first,
 * and inert controllers in summoned processes and runner children (Q42).
 * On SQLite, which other processes can share.
 */

setDefaultTimeout(30_000);

const tmp = await makeTmpDir("bun-jobs-summon-jobs");
const DRIVER = {
  type: "sql",
  url: `sqlite://${join(tmp.path, "jobs.db")}`,
} as const;
afterAll(async () => {
  await tmp.cleanup();
});

const perTest: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of perTest.splice(0)) {
    await cleanup().catch(() => {});
  }
});

/**
 * A driver whose `countDemand` calls are counted: one per check, since every
 * check reads demand exactly once and nothing else in these tests does.
 */
function countingDriver(): { driver: JobsDriver; checks: () => number } {
  const inner = createDriver(DRIVER);
  let checks = 0;
  const driver = new Proxy(inner, {
    get(target, property) {
      if (property === "countDemand") {
        return async (
          ...args: Parameters<NonNullable<JobsDriver["countDemand"]>>
        ) => {
          checks++;
          return await target.countDemand!(...args);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  perTest.push(async () => await inner.close());
  return { driver, checks: () => checks };
}

/** A context on a fresh namespace, closed and purged after the test. */
function context(
  driver: JobsDriver,
  summon: ConstructorParameters<typeof BunJobs>[0]["summon"],
): BunJobs {
  const namespace = testNamespace("summon-jobs");
  const jobs = new BunJobs({ namespace, driver, logger: noopLogger, summon });
  perTest.unshift(async () => {
    await jobs.close();
    await driver.purge(namespace);
  });
  return jobs;
}

describe("BunJobs summon", () => {
  it("builds a controller per queue in the summon option, and summonController() returns it", async () => {
    const { driver } = countingDriver();
    const jobs = context(driver, {
      work: { summoner: async () => {}, triggers: { poll: false } },
    });
    const controller = jobs.summonController("work");
    expect(controller).toBeInstanceOf(SummonController);
    expect(jobs.summonController("work")).toBe(controller);
    expect(controller.queue).toBe("work");
    expect(controller.namespace).toBe(jobs.namespace);
    expect(() => jobs.summonController("other")).toThrow(ConfigError);

    const made = jobs.summonController("other", {
      summoner: async () => {},
      triggers: { poll: false },
    });
    expect(jobs.summonController("other")).toBe(made);
  });

  it("refuses a summon policy on the memory driver, at construction", () => {
    expect(
      () =>
        new BunJobs({
          namespace: "n",
          driver: { type: "memory" },
          summon: { work: { summoner: async () => {} } },
        }),
    ).toThrow(ConfigError);
  });

  it("makes exactly one check for a 5,000-job addBulk, and summons once", async () => {
    const { driver, checks } = countingDriver();
    const calls: SummonRequest[] = [];
    const jobs = context(driver, {
      work: {
        summoner: async (request) => {
          calls.push(request);
        },
        triggers: { poll: false, events: false, debounce: 50 },
      },
    });
    const queue = jobs.queue("work");
    await queue.addBulk(
      Array.from({ length: 5_000 }, (_, index) => ({
        name: "bulk",
        data: { index },
      })),
    );
    await waitFor(() => calls.length === 1, { timeout: 5_000 });
    await Bun.sleep(300);

    expect(checks()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.reason).toBe("add");
    expect(calls[0]!.demand.waiting).toBe(5_000);
  });

  it("does nothing on an add while a serving worker is known", async () => {
    const { driver, checks } = countingDriver();
    const calls: SummonRequest[] = [];
    const jobs = context(driver, {
      work: {
        summoner: async (request) => {
          calls.push(request);
        },
        triggers: { poll: false, events: false, debounce: 10 },
      },
    });
    const worker = jobs.worker("work", async () => {}, {
      pollInterval: 20,
      reportInterval: 1_000,
      logger: noopLogger,
    });
    void worker.run();
    const controller = jobs.summonController("work");
    await waitFor(async () => (await jobs.listWorkers()).length === 1);
    // One check with the worker listed: it sets the fast path's window.
    expect((await controller.check()).action).toBe("none");
    const before = checks();

    const queue = jobs.queue("work");
    for (let index = 0; index < 200; index++) {
      await queue.add("fast", { index });
    }
    await Bun.sleep(200);
    expect(checks()).toBe(before);
    expect(calls).toHaveLength(0);
  });

  it("arms a one-shot timer for a delayed job due within the poll", async () => {
    const { driver } = countingDriver();
    const calls: SummonRequest[] = [];
    const jobs = context(driver, {
      work: {
        summoner: async (request) => {
          calls.push(request);
        },
        triggers: { poll: 60_000, events: false },
      },
    });
    await jobs.queue("work").add("later", {}, { delay: 300 });
    await Bun.sleep(100);
    expect(calls).toHaveLength(0);
    await waitFor(() => calls.length === 1, { timeout: 5_000 });
    expect(calls[0]!.reason).toBe("timer");
  });

  it("hears another process's published add through the events trigger", async () => {
    const { driver } = countingDriver();
    const calls: SummonRequest[] = [];
    const jobs = context(driver, {
      work: {
        summoner: async (request) => {
          calls.push(request);
        },
        triggers: { onAdd: false, poll: false, events: true, debounce: 10 },
      },
    });
    const producerDriver = createDriver(DRIVER);
    perTest.push(async () => await producerDriver.close());
    const producer = new BunJobs({
      namespace: jobs.namespace,
      driver: producerDriver,
      publishEvents: true,
      logger: noopLogger,
    });
    perTest.unshift(async () => await producer.close());
    // Let the subscription settle before the add it must hear.
    await Bun.sleep(200);
    await producer.queue("work").add("remote", {});
    await waitFor(() => calls.length === 1, { timeout: 10_000 });
    expect(calls[0]!.reason).toBe("event");
  });

  it("closes controllers first, letting a check in flight finish", async () => {
    const { driver } = countingDriver();
    let finished = false;
    const jobs = context(driver, {
      work: {
        summoner: async () => {
          await Bun.sleep(200);
          finished = true;
        },
        triggers: { poll: false, events: false },
      },
    });
    const controller = jobs.summonController("work");
    await jobs.queue("work").add("a", {});
    const inFlight = controller.check();
    await Bun.sleep(20);
    await jobs.close();
    expect(finished).toBe(true);
    expect(await inFlight).toMatchObject({
      action: "summoned",
      outcome: "started",
    });
    expect(await controller.check()).toEqual({
      action: "skipped",
      reason: "closed",
    });
  });
});

describe("inert controllers (Q42)", () => {
  const INERT = join(
    import.meta.dir,
    "fixtures",
    "processes",
    "summon-inert.ts",
  );

  /** Runs the fixture, answering what it printed. */
  async function run(
    env: Record<string, string>,
    args: string[] = [],
  ): Promise<Record<string, unknown>> {
    const namespace = testNamespace("summon-inert");
    const { lines, exitCode, stderr } = await runBun<Record<string, unknown>>(
      INERT,
      {
        SUMMON_TEST_DRIVER: JSON.stringify(DRIVER),
        SUMMON_TEST_NAMESPACE: namespace,
        ...env,
      },
      args,
    );
    expect(exitCode, stderr).toBe(0);
    const cleanup = createDriver(DRIVER);
    await cleanup.purge(namespace);
    await cleanup.close();
    return lines.at(-1)!;
  }

  it("is live in an ordinary process", async () => {
    expect(await run({})).toMatchObject({
      inert: false,
      action: "summoned",
      calls: 1,
    });
  });

  it("is inert in a summoned process, and summons nothing", async () => {
    expect(await run({}, [`${SUMMON_ARGS.id}=sm_parent`])).toMatchObject({
      inert: true,
      action: "skipped",
      reason: "inert",
      calls: 0,
    });
  });

  it("is live in a summoned process whose policy says fromSummoned", async () => {
    expect(
      await run({ SUMMON_TEST_FROM_SUMMONED: "1" }, [
        `${SUMMON_ARGS.id}=sm_parent`,
      ]),
    ).toMatchObject({ inert: false, action: "summoned" });
  });

  it("is inert in a process marked as a runner child", async () => {
    expect(await run({ BUN_JOBS_CHILD: "1" })).toMatchObject({
      inert: true,
      calls: 0,
    });
  });

  it("is live in a summoned process's own Bun.spawn descendant: it cannot know, and is one more controller under the same guards", async () => {
    const answer = await run({ SUMMON_TEST_SPAWN_CHILD: "1" }, [
      `${SUMMON_ARGS.id}=sm_parent`,
    ]);
    expect(answer).toMatchObject({ inert: true, calls: 0 });
    expect(answer.child).toMatchObject({ inert: false, action: "summoned" });
  });

  it("is inert inside a real child-process target", async () => {
    const driver = createDriver(DRIVER);
    const namespace = testNamespace("summon-child");
    const jobs = new BunJobs({ namespace, driver, logger: noopLogger });
    perTest.push(async () => {
      await jobs.close();
      await driver.purge(namespace);
      await driver.close();
    });
    const worker = jobs.worker(
      "probe",
      join(import.meta.dir, "fixtures", "handlers", "job-summon-inert.ts"),
      { target: "child-process", pollInterval: 20, logger: noopLogger },
    );
    void worker.run();
    const job = await jobs
      .queue("probe")
      .add("probe", { driver: DRIVER, namespace }, { removeOnComplete: false });
    await waitFor(
      async () =>
        (await jobs.queue("probe").getJob(job.id))?.state === "completed",
      { timeout: 20_000 },
    );
    expect((await jobs.queue("probe").getJob(job.id))?.returnValue).toEqual({
      inert: true,
      action: "skipped",
    });
  });
});
