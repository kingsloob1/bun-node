import type { JobsDriver } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  BunJobs,
  BunQueueWorker,
  ConfigError,
  createDriver,
  MemoryDriver,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * `jobs.processEvery(interval)`: Agenda's knob for how often the registry
 * looks for due work, mapped onto the registry worker's `pollInterval` (and
 * `maxBlock` on a blocking driver), which also sets the promotion sweep's
 * cadence up to its once-a-second cap.
 *
 * The mechanics are observed at the driver boundary — the budget each
 * `waitForJob` is given, and when `promoteDelayed` is called — because those
 * are what the option is meant to change, and a latency measurement alone
 * could pass for reasons that have nothing to do with it.
 */

const cleanups: (() => Promise<void>)[] = [];
const servers = await crossProcessBackends({ cleanups });

afterAll(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

/** A backend every case runs against. */
interface Backend {
  /** What the describe block is called. */
  name: string;
  /** Whether it can be reached; an unreachable one is skipped, visibly. */
  available: boolean;
  /** Builds a driver for it. */
  make: () => JobsDriver;
}

const backends: Backend[] = [
  { name: "memory", available: true, make: () => new MemoryDriver() },
  ...servers.map((server) => ({
    name: server.name,
    available: server.available,
    make: () => createDriver(server.config),
  })),
];

/**
 * Backends the cadence test runs on: it spends seconds per backend counting
 * timer ticks, and the timer is the worker's, not the driver's, so these three
 * — one in-process, one polling, one blocking — cover every path through it.
 */
const CADENCE_BACKENDS = new Set(["memory", "sqlite", "redis"]);

/**
 * Backends whose driver waits by blocking rather than polling. Named here so
 * the wait tests can be skipped by title; each such test also asserts the
 * driver's capability agrees, so this list cannot drift from the drivers.
 */
const BLOCKING_BACKENDS = new Set(["memory", "redis"]);

/** The longest a timer can wait, which the interval may not exceed. */
const MAX_TIMER_MS = 2_147_483_647;

/** One `waitForJob` call as the driver saw it. */
interface WaitCall {
  /** The budget the worker gave it. */
  ms: number;
  /** When it was made. */
  at: number;
}

/** Records every `waitForJob` budget the driver is given. */
function spyOnWaits(driver: JobsDriver): WaitCall[] {
  const calls: WaitCall[] = [];
  const original = driver.waitForJob.bind(driver);
  driver.waitForJob = async (q, ms, signal) => {
    calls.push({ ms, at: Date.now() });
    return await original(q, ms, signal);
  };
  return calls;
}

/** Records when `promoteDelayed` is called. */
function spyOnPromotions(driver: JobsDriver): number[] {
  const times: number[] = [];
  const original = driver.promoteDelayed.bind(driver);
  driver.promoteDelayed = async (q, now, limit) => {
    times.push(Date.now());
    return await original(q, now, limit);
  };
  return times;
}

/** How many entries `times` gains over `ms`. */
async function countOver(times: unknown[], ms: number): Promise<number> {
  const from = times.length;
  await Bun.sleep(ms);
  return times.length - from;
}

describe("processEvery: reading the interval", () => {
  const contexts: BunJobs[] = [];

  afterEach(async () => {
    await Promise.allSettled(contexts.map((jobs) => jobs.close()));
    contexts.length = 0;
  });

  /** A context with one definition, on its own memory driver. */
  function makeJobs(
    options: { driver?: JobsDriver; processEvery?: number | string } = {},
  ): BunJobs {
    const jobs = new BunJobs({
      namespace: testNamespace("every"),
      driver: options.driver ?? new MemoryDriver(),
      logger: noopLogger,
      ...(options.processEvery === undefined
        ? {}
        : { processEvery: options.processEvery }),
    });
    jobs.define("tick", async () => null);
    contexts.push(jobs);
    return jobs;
  }

  it("takes milliseconds, a duration, or 'every' and a duration", async () => {
    const cases: [number | string, number][] = [
      [1_500, 1_500],
      ["250ms", 250],
      ["every 2 seconds", 2_000],
      ["1m 30s", 90_000],
    ];

    for (const [input, expected] of cases) {
      const jobs = makeJobs();
      // Chainable, as the rest of the registry's configuration is.
      expect(jobs.processEvery(input)).toBe(jobs);

      const worker = await jobs.start();
      expect(worker.pollInterval).toBe(expected);
    }
  });

  it("refuses what is not a positive interval", () => {
    const jobs = makeJobs();

    for (const bad of [0, -5, Number.NaN, Infinity, "whenever", "0s", ""]) {
      expect(() => jobs.processEvery(bad)).toThrow(ConfigError);
      expect(() => jobs.processEvery(bad)).toThrow(/processEvery\(\)/);
    }
  });

  it("refuses an interval longer than a timer can wait, everywhere one is taken", () => {
    const jobs = makeJobs();
    const worker = jobs.worker("plain", async () => null);

    for (const tooLong of ["30 days", MAX_TIMER_MS + 1]) {
      expect(() => jobs.processEvery(tooLong)).toThrow(ConfigError);
      expect(() => jobs.processEvery(tooLong)).toThrow(/2147483647/);
      expect(
        () =>
          new BunJobs({
            namespace: testNamespace("every"),
            driver: new MemoryDriver(),
            processEvery: tooLong,
          }),
      ).toThrow(ConfigError);
    }

    expect(() => {
      worker.pollInterval = MAX_TIMER_MS + 1;
    }).toThrow(ConfigError);
    expect(() => {
      worker.maxBlock = MAX_TIMER_MS + 1;
    }).toThrow(ConfigError);
    expect(worker.pollInterval).toBe(1_000);
    expect(worker.maxBlock).toBe(5_000);

    // The longest a timer can wait is itself fine.
    expect(jobs.processEvery(MAX_TIMER_MS)).toBe(jobs);
    worker.pollInterval = MAX_TIMER_MS;
    worker.maxBlock = MAX_TIMER_MS;
  });

  it("waits, rather than spins, at the longest interval allowed", async () => {
    const driver = new MemoryDriver();
    const waits = spyOnWaits(driver);
    const jobs = makeJobs({ driver, processEvery: MAX_TIMER_MS });

    await jobs.start();
    await waitFor(() => waits.length > 0, { timeout: 3_000 });

    // A timer that overflowed would fire at once, and the loop would make
    // hundreds of waits in this time.
    expect(await countOver(waits, 300)).toBeLessThanOrEqual(2);
  });

  it("leaves the worker's defaults alone when it is never called", async () => {
    const driver = new MemoryDriver();
    const waits = spyOnWaits(driver);
    const jobs = makeJobs({ driver });

    const worker = await jobs.start();

    expect(worker.pollInterval).toBe(1_000);
    expect(worker.maxBlock).toBe(5_000);
    await waitFor(() => waits.length > 0, { timeout: 3_000 });
    // The memory driver wakes waiters directly, so it waits by `maxBlock`.
    expect(driver.capabilities.blockingWait).toBe(true);
    expect(waits[0]!.ms).toBe(5_000);
  });

  it("refuses a runtime interval on a worker that is not a positive number", () => {
    const jobs = makeJobs();
    const worker = jobs.worker("plain", async () => null);

    expect(() => {
      worker.pollInterval = 0;
    }).toThrow(ConfigError);
    expect(() => {
      worker.maxBlock = Number.NaN;
    }).toThrow(ConfigError);
    expect(worker.pollInterval).toBe(1_000);
    expect(worker.maxBlock).toBe(5_000);
  });

  it("arms no promotion timer on a worker that is not running", async () => {
    const driver = new MemoryDriver();
    const promotions = spyOnPromotions(driver);
    const jobs = makeJobs({ driver });

    // Never started: a changed interval is stored for run(), not acted on.
    const idle = jobs.worker("idle", async () => null);
    idle.pollInterval = 10;
    expect(await countOver(promotions, 200)).toBe(0);
    expect(idle.pollInterval).toBe(10);

    // Closed: its timers were cleared, and changing the interval arms none.
    const closed = jobs.worker("closed", async () => null);
    void closed.run();
    await waitFor(() => closed.isRunning, { timeout: 3_000 });
    await closed.close();

    closed.pollInterval = 10;
    expect(await countOver(promotions, 200)).toBe(0);
  });

  it("arms no promotion timer while run() is still connecting, when the connect then fails", async () => {
    const driver = new MemoryDriver();
    const promotions = spyOnPromotions(driver);
    let connects = 0;
    driver.connect = async () => {
      connects++;
      await Bun.sleep(50);
      throw new Error("backend unreachable");
    };

    const worker = new BunQueueWorker("unreachable", async () => null, {
      namespace: testNamespace("every"),
      driver,
      logger: noopLogger,
    });
    const running = worker.run().catch((error: unknown) => error);

    // While run() is awaiting the connect.
    worker.pollInterval = 10;

    const failure = await running;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("backend unreachable");
    expect(worker.isRunning).toBe(false);
    expect(await countOver(promotions, 300)).toBe(0);

    // A failed start is not a running worker: run() again tries to connect
    // again, and fails the same way, rather than joining the dead start.
    expect(await worker.run().catch((error: unknown) => error)).toBeInstanceOf(
      Error,
    );
    expect(connects).toBe(2);

    // And close() has nothing to wait for. It used to wait for a loop that
    // never started, forever.
    const closed = await Promise.race([
      worker.close().then(() => "closed" as const),
      Bun.sleep(1_000).then(() => "hung" as const),
    ]);
    expect(closed).toBe("closed");
    expect(worker.isRunning).toBe(false);
  });

  it("takes setters called while close() is in progress without arming anything", async () => {
    const driver = new MemoryDriver();
    const promotions = spyOnPromotions(driver);
    const jobs = makeJobs({ driver });
    const gate = Promise.withResolvers<void>();

    const worker = jobs.worker("closing", async () => {
      await gate.promise;
    });
    void worker.run();
    const queue = jobs.queue("closing");
    await queue.add("hold", {});
    await waitFor(() => worker.activeCount === 1, { timeout: 3_000 });

    // Waiting on the job in flight, so the close is still in progress below.
    const closing = worker.close();
    await Bun.sleep(20);

    worker.pollInterval = 10;
    worker.maxBlock = 10;
    expect(worker.pollInterval).toBe(10);
    expect(worker.maxBlock).toBe(10);
    expect(await countOver(promotions, 200)).toBe(0);

    // A closing worker claims nothing new, whatever its interval says.
    const late = await queue.add("late", {});

    gate.resolve();
    await closing;

    expect(worker.isRunning).toBe(false);
    expect((await queue.getJob(late.id))?.state).toBe("waiting");
    expect(await countOver(promotions, 100)).toBe(0);
  });

  describe("as a constructor option", () => {
    it("behaves as processEvery() called before start()", async () => {
      const jobs = makeJobs({ processEvery: "250ms" });
      const worker = await jobs.start();

      expect(worker.pollInterval).toBe(250);
      // Memory waits by `maxBlock`, which follows too.
      expect(worker.maxBlock).toBe(250);
    });

    it("yields to start()'s explicit options, and a later call wins over both", async () => {
      const jobs = makeJobs({ processEvery: "250ms" });
      const worker = await jobs.start({ pollInterval: 40, maxBlock: 60 });

      expect(worker.pollInterval).toBe(40);
      expect(worker.maxBlock).toBe(60);

      jobs.processEvery(90);
      expect(worker.pollInterval).toBe(90);
      expect(worker.maxBlock).toBe(90);
    });

    it("is validated at construction, as processEvery() is", () => {
      for (const bad of [0, -1, Number.NaN, "whenever", "0s"]) {
        expect(
          () =>
            new BunJobs({
              namespace: testNamespace("every"),
              driver: new MemoryDriver(),
              processEvery: bad,
            }),
        ).toThrow(/processEvery\(\)/);
      }
    });
  });

  describe("processEveryMs", () => {
    /** A context that is never started, so this reads what was *asked for*. */
    function context(processEvery?: number | string) {
      return new BunJobs({
        namespace: testNamespace("every"),
        driver: new MemoryDriver(),
        ...(processEvery === undefined ? {} : { processEvery }),
      });
    }

    it("is undefined when the interval was never set", () => {
      expect(context().processEveryMs).toBeUndefined();
    });

    it("reads back the constructor option, in milliseconds", () => {
      expect(context("250ms").processEveryMs).toBe(250);
      expect(context(400).processEveryMs).toBe(400);
    });

    it("reads back processEvery(), before start() has ever run", () => {
      const jobs = context();
      jobs.processEvery("1m 30s");

      // The point of the getter: no worker exists yet, and the value is
      // already normalised — both the option and the method parse eagerly.
      expect(jobs.processEveryMs).toBe(90_000);
    });

    it("follows the latest call", () => {
      const jobs = context("250ms");
      jobs.processEvery(90);
      expect(jobs.processEveryMs).toBe(90);
    });
  });
});

for (const backend of backends) {
  describe.skipIf(!backend.available)(`processEvery: ${backend.name}`, () => {
    let driver: JobsDriver;
    let jobs: BunJobs;
    /** Jobs the `tick` definition ran, by data. */
    let ran: unknown[];
    /** Releases the `hold` jobs, which run until it is called. */
    let release: () => void;

    beforeAll(async () => {
      driver = backend.make();
      await driver.connect();
    });

    afterAll(async () => {
      await driver.close();
    });

    beforeEach(() => {
      ran = [];
      const gate = Promise.withResolvers<void>();
      release = gate.resolve;

      jobs = new BunJobs({
        namespace: testNamespace("every"),
        driver,
        logger: noopLogger,
      });
      jobs.define("tick", async (job) => {
        ran.push(job.data);
      });
      jobs.define("hold", async () => {
        await gate.promise;
      });
    });

    afterEach(async () => {
      release();
      await jobs.stop().catch(() => {});
      await jobs.purge().catch(() => {});
      await jobs.close();
    });

    it(`applies before start, on the driver's own terms (${backend.name})`, async () => {
      jobs.processEvery("250ms");
      const worker = await jobs.start();

      expect(worker.pollInterval).toBe(250);
      // Only a blocking driver waits by `maxBlock`; elsewhere it is left as it was.
      expect(worker.maxBlock).toBe(
        driver.capabilities.blockingWait ? 250 : 5_000,
      );
    });

    it(`applies as a constructor option, on the driver's own terms (${backend.name})`, async () => {
      const configured = new BunJobs({
        namespace: testNamespace("every"),
        driver,
        logger: noopLogger,
        processEvery: "250ms",
      });
      configured.define("tick", async () => null);

      try {
        const worker = await configured.start();
        expect(worker.pollInterval).toBe(250);
        expect(worker.maxBlock).toBe(
          driver.capabilities.blockingWait ? 250 : 5_000,
        );
      } finally {
        await configured.purge().catch(() => {});
        await configured.close();
      }
    });

    it(`yields to start()'s explicit options, and a later call wins over them (${backend.name})`, async () => {
      jobs.processEvery(250);
      const worker = await jobs.start({ pollInterval: 40, maxBlock: 60 });

      expect(worker.pollInterval).toBe(40);
      expect(worker.maxBlock).toBe(60);

      jobs.processEvery(90);

      expect(worker.pollInterval).toBe(90);
      expect(worker.maxBlock).toBe(driver.capabilities.blockingWait ? 90 : 60);
    });

    it.skipIf(BLOCKING_BACKENDS.has(backend.name))(
      `cuts a polling driver's wait short (${backend.name})`,
      async () => {
        expect(driver.capabilities.blockingWait).toBe(false);
        const waits = spyOnWaits(driver);

        // A 30-second wait: nothing but an abort can end it within the check
        // below, so a prompt new wait proves the setter cut it short.
        const worker = await jobs.start({ pollInterval: 30_000 });
        await waitFor(() => waits.some((call) => call.ms === 30_000), {
          timeout: 5_000,
        });

        const changedAt = Date.now();
        jobs.processEvery(30);

        await waitFor(
          () => waits.some((call) => call.at >= changedAt && call.ms <= 30),
          { timeout: 1_500, message: "the 30s wait was not cut short" },
        );
        expect(worker.pollInterval).toBe(30);
      },
      15_000,
    );

    it.skipIf(!BLOCKING_BACKENDS.has(backend.name))(
      `leaves a blocking driver's wait to finish, applying the value from the next (${backend.name})`,
      async () => {
        expect(driver.capabilities.blockingWait).toBe(true);
        const waits = spyOnWaits(driver);

        await jobs.start();
        await waitFor(() => waits.length > 0, { timeout: 5_000 });
        const before = waits.length;

        const changedAt = Date.now();
        jobs.processEvery(30);

        // The wait in progress (5s by default) is not abandoned.
        expect(await countOver(waits, 300)).toBe(0);
        expect(waits.length).toBe(before);

        // A job ends it, and the wait after uses the new value.
        await jobs.now("tick", { n: 1 });
        await waitFor(() => ran.length === 1, { timeout: 3_000 });
        await waitFor(
          () => waits.some((call) => call.at >= changedAt && call.ms <= 30),
          {
            timeout: 3_000,
            message: "the next wait did not use the new value",
          },
        );
      },
      15_000,
    );

    it(`picks up a job added right after the interval changes, well inside the old wait (${backend.name})`, async () => {
      const waits = spyOnWaits(driver);
      await jobs.start();
      await waitFor(() => waits.length > 0, { timeout: 5_000 });
      await Bun.sleep(100);

      // Mid-wait, as a service reconfiguring itself would be.
      jobs.processEvery(3_000);
      await Bun.sleep(20);

      const addedAt = Date.now();
      await jobs.now("tick", { n: 1 });

      // Redis once took the whole new interval here: an abandoned blocking
      // pop swallowed the wake, leaving the next pop to wait out 3 seconds.
      await waitFor(() => ran.length === 1, {
        timeout: 1_500,
        message: () => `not picked up within ${Date.now() - addedAt}ms`,
      });
    }, 15_000);

    it(`reaches the next start() after a stop (${backend.name})`, async () => {
      const first = await jobs.start();
      await jobs.stop();

      jobs.processEvery(70);
      const second = await jobs.start();

      expect(second).not.toBe(first);
      expect(second.pollInterval).toBe(70);
    }, 15_000);

    it(`keeps running jobs after the interval changes at runtime (${backend.name})`, async () => {
      await jobs.start();
      jobs.processEvery("20ms");

      await jobs.now("tick", { n: 1 });
      await waitFor(() => ran.length === 1, { timeout: 8_000 });
      expect(ran).toEqual([{ n: 1 }]);
    }, 15_000);

    it.skipIf(!CADENCE_BACKENDS.has(backend.name))(
      `re-arms the promotion sweep at the new cadence, replacing the old timer (${backend.name})`,
      async () => {
        const promotions = spyOnPromotions(driver);
        const worker = await jobs.start({ concurrency: 1 });

        // Full, so the loop sleeps waiting for a slot and never promotes on
        // its own: every call counted below is the sweep's.
        await jobs.now("hold");
        await waitFor(() => worker.activeCount === 1, { timeout: 8_000 });
        await Bun.sleep(100);

        // The default: once a second.
        expect(await countOver(promotions, 1_100)).toBeLessThanOrEqual(2);

        jobs.processEvery(50);
        expect(await countOver(promotions, 1_000)).toBeGreaterThanOrEqual(8);

        // Past the cap, back to once a second — and the 50ms timer gone.
        jobs.processEvery(5_000);
        await Bun.sleep(100);
        expect(await countOver(promotions, 1_100)).toBeLessThanOrEqual(2);
      },
      20_000,
    );
  });
}
