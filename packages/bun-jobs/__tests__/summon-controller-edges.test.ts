import type {
  JobsDriver,
  SummonControllerOptions,
  SummonEventPayload,
  SummonRequest,
} from "../lib/index";
import process from "node:process";
import { createTestLogger, noopLogger } from "@kingsleyweb/bun-common";
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
  BunQueue,
  BunQueueWorker,
  createDriver,
  defineSummoner,
  JobsError,
  newId,
  registerWorkerRecord,
  SummonController,
} from "../lib/index";
import { LOCAL_ADD_HOOKS } from "../lib/queue/BunQueue";
import { setReservedState } from "../lib/queue/windows";
import {
  claimSummonAttempt,
  summonClaimName,
  sweepSummonClaims,
} from "../lib/summon/claim";
import { ATTACH_QUEUE } from "../lib/summon/controller";
import { SUMMON_MARKER } from "../lib/summon/marker";
import { testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * The controller's edges, from the #208 review: the demand cap, the private
 * local-add hook, a timed-out call, the claim sweep and live holders, a
 * marker from a newer build, scale-down on a paused queue, and the three
 * nits (reset's error, an inert check reading nothing, a failed events
 * subscription retried).
 */

setDefaultTimeout(60_000);

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
});

/** What one test opened, closed after it (drivers, controllers, queues). */
const perTest: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of perTest.splice(0)) {
    await cleanup().catch(() => {});
  }
});

const BACKENDS = await crossProcessBackends({ cleanups });
const SQLITE = BACKENDS.find((backend) => backend.name === "sqlite")!;

/** Triggers off and no cooldown: every check is one the test asked for. */
const QUIET: Partial<SummonControllerOptions> = {
  triggers: { onAdd: false, events: false, poll: false },
  cooldown: 0,
  logger: noopLogger,
};

/** A driver of `config` on a fresh namespace, purged and closed after the test. */
async function open(config: (typeof BACKENDS)[number]["config"]): Promise<{
  driver: JobsDriver;
  namespace: string;
  ref: { ns: string; queue: string };
}> {
  const driver = createDriver(config);
  await driver.connect();
  const namespace = testNamespace("summon-edges");
  perTest.push(async () => {
    await driver.purge(namespace);
    await driver.close();
  });
  return { driver, namespace, ref: { ns: namespace, queue: "work" } };
}

/** `driver`, with the named methods replaced. Everything else goes to it. */
function wrap(
  driver: JobsDriver,
  replace: Partial<Record<keyof JobsDriver, unknown>>,
): JobsDriver {
  return new Proxy(driver, {
    get(target, property) {
      if (property in replace) {
        return replace[property as keyof JobsDriver];
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A controller, closed after the test. */
function controller(options: SummonControllerOptions): SummonController {
  const one = new SummonController({ ...QUIET, ...options });
  perTest.unshift(async () => await one.close());
  return one;
}

/** A summoner that records its requests. */
function recorder(): {
  calls: SummonRequest[];
  invoke: (request: SummonRequest) => Promise<void>;
} {
  const calls: SummonRequest[] = [];
  return {
    calls,
    invoke: async (request) => {
      calls.push(request);
    },
  };
}

describe("the demand cap (§6.4 D3)", () => {
  it("is raised to maxWorkers × jobsPerWorker, so 30,000 jobs at 500 a worker want 50 workers", async () => {
    const { driver, namespace } = await open(SQLITE.config);
    const queue = new BunQueue("work", {
      namespace,
      driver,
      logger: noopLogger,
    });
    perTest.unshift(async () => await queue.close());
    for (let batch = 0; batch < 6; batch++) {
      await queue.addBulk(
        Array.from({ length: 5_000 }, (_, index) => ({
          name: "job",
          data: { batch, index },
        })),
      );
    }
    const { calls, invoke } = recorder();
    const summon = controller({
      driver,
      namespace,
      queue: "work",
      summoner: invoke,
      maxWorkers: 50,
      maxPending: 50,
      jobsPerWorker: 500,
    });
    const result = await summon.check();
    expect(result).toMatchObject({ action: "summoned" });
    expect(calls[0]!.count).toBe(50);
    // Counted to 50 × 500 = 25,000 (capped past it), enough to want all 50.
    expect(result.demand).toMatchObject({ waiting: 25_000, capped: true });
  });

  it("warns once, naming the driver, when demand is approximate (no countDemand)", async () => {
    const { driver, namespace } = await open(SQLITE.config);
    const { logger, events } = createTestLogger();
    const summon = controller({
      driver: wrap(driver, { countDemand: undefined }),
      namespace,
      queue: "work",
      summoner: async () => {},
      logger,
    });
    expect((await summon.check()).demand?.exact).toBe(false);
    expect((await summon.check()).demand?.exact).toBe(false);
    const warns = events.filter(
      (event) =>
        event.level === "warn" && event.message.includes("approximate"),
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain("sql");
  });
});

describe("the onAdd hook is private (not the public `added` event)", () => {
  const SUBSCRIBERS = BACKENDS.filter((backend) =>
    ["sqlite", "redis"].includes(backend.name),
  );
  for (const backend of SUBSCRIBERS) {
    it.skipIf(!backend.available)(
      `a subscribing queue does not fetch another process's adds for it: ${backend.name}`,
      async () => {
        const { driver, namespace } = await open(backend.config);
        let fetched = 0;
        const counting = wrap(driver, {
          getJob: async (...args: Parameters<JobsDriver["getJob"]>) => {
            fetched++;
            return await driver.getJob(...args);
          },
        });
        const consumer = new BunQueue("work", {
          namespace,
          driver: counting,
          subscribe: true,
          logger: noopLogger,
        });
        await consumer.connect();
        perTest.unshift(async () => await consumer.close());
        const summon = controller({
          driver,
          namespace,
          queue: "work",
          summoner: async () => {},
          triggers: { onAdd: true, events: false, poll: false },
        });
        summon[ATTACH_QUEUE](consumer);

        const producerDriver = createDriver(backend.config);
        perTest.push(async () => await producerDriver.close());
        const producer = new BunQueue("work", {
          namespace,
          driver: producerDriver,
          publish: true,
          logger: noopLogger,
        });
        perTest.unshift(async () => await producer.close());
        const addSome = async (count: number): Promise<void> => {
          for (let index = 0; index < count; index++) {
            await producer.add("remote", { index });
          }
        };

        await addSome(200);
        await Bun.sleep(1_000);
        expect(fetched).toBe(0);

        // The control: a public `added` listener does make it fetch each one,
        // so the events did arrive and the zero above means something.
        consumer.on("added", () => {});
        await addSome(200);
        await waitFor(() => fetched >= 200, { timeout: 20_000 });
      },
    );
  }

  it("is not detached by removeAllListeners('added')", async () => {
    const { driver } = await open(SQLITE.config);
    const calls: SummonRequest[] = [];
    const jobs = new BunJobs({
      namespace: testNamespace("summon-edges"),
      driver,
      logger: noopLogger,
      summon: {
        work: {
          summoner: async (request) => {
            calls.push(request);
          },
          triggers: { poll: false, events: false, debounce: 10 },
        },
      },
    });
    perTest.unshift(async () => {
      await jobs.close();
      await driver.purge(jobs.namespace);
    });
    const queue = jobs.queue("work");
    queue.removeAllListeners("added");
    queue.removeAllListeners();
    await queue.add("a", {});
    await waitFor(() => calls.length === 1, { timeout: 5_000 });
    expect(calls[0]!.reason).toBe("add");
  });
});

for (const backend of BACKENDS) {
  describe.skipIf(!backend.available)(
    `controller edges: ${backend.name}`,
    () => {
      it("keeps a timed-out attempt pending until its until, then counts it lost", async () => {
        const { driver, namespace } = await open(backend.config);
        const queue = new BunQueue("work", {
          namespace,
          driver,
          logger: noopLogger,
        });
        perTest.unshift(async () => await queue.close());
        let calls = 0;
        const events: SummonEventPayload[] = [];
        const summon = controller({
          driver,
          namespace,
          queue: "work",
          summoner: async () => {
            calls++;
            await new Promise(() => {});
          },
          summonTimeout: 100,
          // Room for the checks below, not a wait: `until` is stamped as the
          // first check starts, and on a loaded machine that check alone took
          // 540–830 ms on MongoDB (its round trips around the 100 ms timeout),
          // so at 500 the attempt was already lost when the second check read
          // it. The wait for `until` below is on the attempt's own `until`.
          bootBudget: 2_000,
          backoff: { initial: 60_000 },
        });
        summon.on("summon", (event) => events.push(event));
        await queue.add("a", {});

        expect(await summon.check()).toMatchObject({ outcome: "failed" });
        let status = await summon.status();
        expect(status.pending).toHaveLength(1);
        const until = status.pending[0]!.until;
        expect(status.failures).toBe(0);
        expect(status.backoffUntil).toBeUndefined();
        expect(status.last).toMatchObject({
          outcome: "failed",
          detail: "timeout",
        });
        // It may still start: no second attempt while it is on its way. (The
        // first assertion says the check is still inside the budget, so a
        // machine too slow for it fails here, saying so.)
        expect(Date.now()).toBeLessThan(until);
        expect(await summon.check()).toMatchObject({ reason: "pending" });
        expect(calls).toBe(1);

        // Its `until` passes with nothing registered: lost.
        await Bun.sleep(Math.max(0, until - Date.now()) + 20);
        expect(await summon.check()).toMatchObject({ reason: "backoff" });
        status = await summon.status();
        expect(status.pending).toHaveLength(0);
        expect(status.failures).toBe(1);
        expect(events.map((event) => event.outcome)).toEqual([
          "failed",
          "lost",
        ]);
      });

      it("never sweeps a claim whose holder is live, however old", async () => {
        const { driver, ref } = await open(backend.config);
        const claimant = (worker: string) => ({
          worker,
          host: "h",
          pid: 1,
          at: Date.now(),
          until: Date.now(),
        });
        expect(
          await claimSummonAttempt(driver, ref, "sm_live", claimant("alive")),
        ).toBe(true);
        expect(
          await claimSummonAttempt(driver, ref, "sm_dead", claimant("gone")),
        ).toBe(true);
        await registerWorkerRecord(driver, ref, {
          id: "alive",
          queue: "work",
          host: "h",
          pid: 1,
          concurrency: 1,
          active: 0,
          paused: false,
          startedAt: Date.now(),
          heartbeatAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        });

        // Everything counts as old: only the live holder keeps its entry.
        const removed = await sweepSummonClaims(
          driver,
          ref,
          Date.now() + 1,
          Date.now(),
        );
        expect(removed).toBe(1);
        expect(
          await driver.getQueueState!(ref, summonClaimName("sm_live")),
        ).not.toBeNull();
        expect(
          await driver.getQueueState!(ref, summonClaimName("sm_dead")),
        ).toBeNull();
      });

      it("leaves a marker from a newer build alone, goes inert, and then reads nothing", async () => {
        const { driver, namespace, ref } = await open(backend.config);
        const queue = new BunQueue("work", {
          namespace,
          driver,
          logger: noopLogger,
        });
        perTest.unshift(async () => await queue.close());
        await queue.add("a", {});
        await driver.ensureQueue(ref);
        const future = {
          v: 2,
          shape: "from the future",
          pending: "not an array",
        };
        const version = await setReservedState(
          driver,
          ref,
          SUMMON_MARKER,
          future,
          null,
        );
        expect(version).not.toBeNull();

        let calls = 0;
        let reads = 0;
        const counting = new Proxy(driver, {
          get(target, property) {
            const value = Reflect.get(target, property, target) as unknown;
            if (typeof value !== "function") {
              return value;
            }
            return (...args: unknown[]) => {
              reads++;
              return (value as (...a: unknown[]) => unknown).apply(
                target,
                args,
              );
            };
          },
        });
        const { logger, events } = createTestLogger();
        const summon = controller({
          driver: counting,
          namespace,
          queue: "work",
          logger,
          summoner: async () => {
            calls++;
          },
        });
        expect(await summon.check()).toEqual({
          action: "skipped",
          reason: "inert",
        });
        expect(summon.inert).toBe(true);
        const status = await summon.status();
        expect(status).toMatchObject({
          inert: true,
          inertReason: "newer-marker",
        });
        await summon.reset();

        // Untouched: same value, same version.
        const entry = await driver.getQueueState!(ref, SUMMON_MARKER);
        expect(entry).toEqual({ value: future, version: version! });
        expect(calls).toBe(0);
        expect(
          events.filter((event) => event.message.includes("newer bun-jobs")),
        ).toHaveLength(1);

        // Inert now: a check answers without touching the driver at all.
        reads = 0;
        expect(await summon.check()).toEqual({
          action: "skipped",
          reason: "inert",
        });
        expect(reads).toBe(0);
      });

      it("writes over a marker that is plain garbage, as before", async () => {
        const { driver, namespace, ref } = await open(backend.config);
        const queue = new BunQueue("work", {
          namespace,
          driver,
          logger: noopLogger,
        });
        perTest.unshift(async () => await queue.close());
        await queue.add("a", {});
        await driver.ensureQueue(ref);
        await setReservedState(driver, ref, SUMMON_MARKER, "garbage", null);
        const summon = controller({
          driver,
          namespace,
          queue: "work",
          summoner: async () => {},
        });
        expect(await summon.check()).toMatchObject({ action: "summoned" });
        expect(
          (await driver.getQueueState!(ref, SUMMON_MARKER))?.value,
        ).toMatchObject({ v: 1 });
      });

      /** A scale-style controller whose releases are recorded, and its queue. */
      async function scaled(): Promise<{
        driver: JobsDriver;
        ref: { ns: string; queue: string };
        queue: BunQueue<unknown>;
        summon: SummonController;
        releases: number[];
      }> {
        const { driver, namespace, ref } = await open(backend.config);
        const queue = new BunQueue("work", {
          namespace,
          driver,
          logger: noopLogger,
        });
        perTest.unshift(async () => await queue.close());
        const releases: number[] = [];
        const summon = controller({
          driver,
          namespace,
          queue: "work",
          scaleDown: { after: 100 },
          summoner: defineSummoner({
            style: "scale",
            invoke: async () => {},
            release: async (request) => {
              releases.push(request.target);
            },
          }),
        });
        return { driver, ref, queue, summon, releases };
      }

      it("scale style: a paused queue is never released while a job is active", async () => {
        const { driver, ref, queue, summon, releases } = await scaled();
        await queue.addBulk([
          { name: "a", data: {} },
          { name: "b", data: {} },
        ]);
        // One job running (its holder alive somewhere), one waiting; paused.
        expect(
          await driver.claimJob(ref, {
            workerId: "elsewhere",
            token: newId(),
            lockMs: 60_000,
            now: Date.now(),
          }),
        ).not.toBeNull();
        await queue.pause();
        expect((await summon.check()).action).toBe("none");
        await Bun.sleep(150);
        const result = await summon.check();
        expect(result.demand).toMatchObject({
          paused: true,
          active: 1,
          waiting: 1,
        });
        expect(result.action).toBe("none");
        expect(releases).toEqual([]);
      });

      it("scale style: a paused queue with nothing running is released after scaleDown.after, waiting jobs or not", async () => {
        const { queue, summon, releases } = await scaled();
        await queue.add("a", {});
        await queue.pause();
        expect((await summon.check()).action).toBe("none");
        expect(releases).toEqual([]);
        await Bun.sleep(150);
        const result = await summon.check();
        expect(result.demand).toMatchObject({
          paused: true,
          active: 0,
          waiting: 1,
        });
        expect(result.action).toBe("released");
        expect(releases).toEqual([0]);
      });

      it("reset throws a contention error, not a config error, when every write loses", async () => {
        const { driver, namespace, ref } = await open(backend.config);
        await driver.ensureQueue(ref);
        const queue = new BunQueue("work", {
          namespace,
          driver,
          logger: noopLogger,
        });
        perTest.unshift(async () => await queue.close());
        await queue.add("a", {});
        let resetting = false;
        const summon = controller({
          driver: wrap(driver, {
            setQueueState: async (
              ...args: Parameters<NonNullable<JobsDriver["setQueueState"]>>
            ) => (resetting ? null : await driver.setQueueState!(...args)),
          }),
          namespace,
          queue: "work",
          summoner: async () => {},
        });
        await summon.check();
        resetting = true;
        const error = await summon.reset().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(JobsError);
        expect((error as JobsError).code).toBe("SUMMON_MARKER_CONTENDED");
        expect((error as Error).name).not.toBe("ConfigError");
      });
    },
  );
}

describe("a failed events subscription", () => {
  it("warns once and is retried on each poll until it succeeds", async () => {
    const { driver, namespace } = await open(SQLITE.config);
    let attempts = 0;
    const { logger, events } = createTestLogger();
    const summon = controller({
      driver: wrap(driver, {
        subscribe: async (...args: Parameters<JobsDriver["subscribe"]>) => {
          attempts++;
          if (attempts <= 3) {
            throw new Error("not yet");
          }
          return await driver.subscribe(...args);
        },
      }),
      namespace,
      queue: "work",
      summoner: async () => {},
      logger,
      triggers: { onAdd: false, events: true, poll: 50 },
    });
    await waitFor(() => attempts >= 4, { timeout: 5_000 });
    expect(
      events.filter(
        (event) =>
          event.level === "warn" &&
          event.message.includes("subscription failed"),
      ),
    ).toHaveLength(1);
    await Bun.sleep(200);
    expect(attempts).toBe(4);
    expect(summon.inert).toBe(false);
  });
});

describe("the onAdd hook hears every kind of local add (round 4)", () => {
  /** A queue on SQLite with a controller hooked into it, and its summon calls. */
  async function hooked(): Promise<{
    queue: BunQueue<unknown>;
    summon: SummonController;
    calls: SummonRequest[];
  }> {
    const { driver, namespace } = await open(SQLITE.config);
    const queue = new BunQueue("work", {
      namespace,
      driver,
      logger: noopLogger,
    });
    perTest.unshift(async () => await queue.close());
    const { calls, invoke } = recorder();
    const summon = controller({
      driver,
      namespace,
      queue: "work",
      summoner: invoke,
      triggers: { onAdd: true, events: false, poll: false, debounce: 10 },
    });
    summon[ATTACH_QUEUE](queue);
    return { queue, summon, calls };
  }

  /** Waits for the one summon an add should cause, then makes sure it stays one. */
  async function expectOneSummon(calls: SummonRequest[]): Promise<void> {
    await waitFor(() => calls.length >= 1, { timeout: 5_000 });
    await Bun.sleep(100);
    expect(calls).toHaveLength(1);
  }

  it("a plain add", async () => {
    const { queue, calls } = await hooked();
    await queue.add("a", {});
    await expectOneSummon(calls);
  });

  it("a repeat added with `immediately`", async () => {
    const { queue, calls } = await hooked();
    await queue.add(
      "r",
      {},
      { repeat: { every: 3_600_000, immediately: true } },
    );
    await expectOneSummon(calls);
  });

  it("a flow, whose children are in this queue", async () => {
    const { queue, calls } = await hooked();
    await queue.addFlow({
      name: "parent",
      data: {},
      children: [
        { name: "child-1", data: {} },
        { name: "child-2", data: {} },
      ],
    });
    await expectOneSummon(calls);
  });

  it("a delayed add, once it is due", async () => {
    const { queue, calls } = await hooked();
    await queue.add("later", {}, { delay: 200 });
    await Bun.sleep(100);
    expect(calls).toHaveLength(0);
    await expectOneSummon(calls);
  });
});

describe("closing removes the hook (round 4)", () => {
  it("controller.close() takes its hook off, and jobs.close() leaves none (undefined)", async () => {
    const { driver } = await open(SQLITE.config);
    const jobs = new BunJobs({
      namespace: testNamespace("summon-edges"),
      driver,
      logger: noopLogger,
      summon: {
        work: {
          summoner: async () => {},
          triggers: { poll: false, events: false },
        },
        other: {
          summoner: async () => {},
          triggers: { poll: false, events: false },
        },
      },
    });
    perTest.unshift(async () => {
      await jobs.close();
      await driver.purge(jobs.namespace);
    });
    const work = jobs.queue("work");
    const other = jobs.queue("other");
    expect(work[LOCAL_ADD_HOOKS]).toHaveLength(1);
    expect(other[LOCAL_ADD_HOOKS]).toHaveLength(1);

    // The design: an empty list is put back to `undefined`, which is what
    // lets the add path skip the hooks with one property read.
    await jobs.summonController("work").close();
    expect(work[LOCAL_ADD_HOOKS]).toBeUndefined();
    expect(other[LOCAL_ADD_HOOKS]).toHaveLength(1);

    await jobs.close();
    expect(other[LOCAL_ADD_HOOKS]).toBeUndefined();
  });
});

describe("a delayed job past the longest timer (round 4)", () => {
  it("arms no overflowing timer: no TimeoutOverflowWarning, and no check before it is due", async () => {
    const { driver, namespace } = await open(SQLITE.config);
    let checks = 0;
    const counting = wrap(driver, {
      countDemand: async (
        ...args: Parameters<NonNullable<JobsDriver["countDemand"]>>
      ) => {
        checks++;
        return await driver.countDemand!(...args);
      },
    });
    const queue = new BunQueue("work", {
      namespace,
      driver,
      logger: noopLogger,
    });
    perTest.unshift(async () => await queue.close());
    const summon = controller({
      driver: counting,
      namespace,
      queue: "work",
      summoner: async () => {},
      triggers: { onAdd: true, events: false, poll: false, debounce: 10 },
    });
    summon[ATTACH_QUEUE](queue);
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.name);
    process.on("warning", onWarning);
    perTest.unshift(async () => {
      process.off("warning", onWarning);
    });

    // About 40 days out: beyond a timer's 2^31 - 1 ms.
    await queue.add("far", {}, { delay: 40 * 86_400_000 });
    await Bun.sleep(300);
    expect(warnings).not.toContain("TimeoutOverflowWarning");
    expect(checks).toBe(0);
  });
});

describe("a failed claim read (round 4)", () => {
  it("leaves summon off that one report's record, and does not demote the worker", async () => {
    const { driver, namespace, ref } = await open(SQLITE.config);
    let failNext = false;
    const flaky = wrap(driver, {
      getQueueState: async (
        ...args: Parameters<NonNullable<JobsDriver["getQueueState"]>>
      ) => {
        if (failNext && args[1] === summonClaimName("sm_flaky")) {
          failNext = false;
          throw new Error("read failed once");
        }
        return await driver.getQueueState!(...args);
      },
    });
    const worker = new BunQueueWorker("work", async () => {}, {
      namespace,
      driver: flaky,
      pollInterval: 20,
      reportInterval: 150,
      logger: noopLogger,
      summon: { id: "sm_flaky" },
    });
    worker.on("error", () => {});
    perTest.unshift(async () => await worker.close({ force: true }));
    void worker.run();

    // Every heartbeat the worker writes, in order: summoned or not.
    const seen: boolean[] = [];
    const record = async () =>
      (await driver.listWorkers!(ref, Date.now())).find(
        (one) => one.id === worker.id,
      );
    const watch = async (until: () => boolean) => {
      let last = -1;
      const deadline = Date.now() + 5_000;
      while (!until()) {
        if (Date.now() > deadline) {
          throw new Error(
            `reports seen, summoned or not: ${JSON.stringify(seen)}`,
          );
        }
        const mine = await record();
        if (mine && mine.heartbeatAt !== last) {
          last = mine.heartbeatAt;
          seen.push(mine.summon !== undefined);
        }
        await Bun.sleep(10);
      }
    };
    await watch(() => seen.includes(true));

    failNext = true;
    await watch(() => !failNext && seen.at(-1) === false);
    expect(worker.summon?.id).toBe("sm_flaky");
    // The next report's read succeeds and puts it back.
    await watch(() => seen.at(-1) === true);
    expect(worker.summon?.id).toBe("sm_flaky");
  });
});
