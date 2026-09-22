import type {
  JobRecord,
  JobsDriver,
  QueueStateEntry,
  StoredJobOptions,
} from "../lib/index";
import { join } from "node:path";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  ConfigError,
  FileDriver,
  JOB_DEFAULTS_STATE,
  JOB_OPTION_BITS,
  JobDefaultsChangedError,
  MemoryDriver,
  NotSupportedError,
  SqlDriver,
} from "../lib/index";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * Queue job defaults on the producer side: the stored override reaching every
 * add path (plain, bulk, flow, repeat, windowed, defined names), its cache,
 * and `BunQueue`'s get / set / reset / apply.
 */

const closers: (() => Promise<unknown>)[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.allSettled(closers.map(async (close) => await close()));
  closers.length = 0;
});

afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
});

/** A job's stored options, with the mask its type keeps optional. */
function optsOf(job: { opts: unknown }): StoredJobOptions {
  return job.opts as StoredJobOptions;
}

/** A queue on `driver`, closed after the test. */
function makeQueue(
  driver: JobsDriver,
  namespace: string,
  options: {
    /** `BunQueueOptions.jobDefaultsRefreshInterval`. */
    refresh?: number;
    /** `BunQueueOptions.defaultJobOptions`. */
    defaults?: ConstructorParameters<typeof BunQueue>[1]["defaultJobOptions"];
    /** The queue's name; `"jdef"` by default. */
    name?: string;
  } = {},
): BunQueue {
  const queue = new BunQueue(options.name ?? "jdef", {
    namespace,
    driver,
    logger: noopLogger,
    ...(options.refresh === undefined
      ? {}
      : { jobDefaultsRefreshInterval: options.refresh }),
    ...(options.defaults === undefined
      ? {}
      : { defaultJobOptions: options.defaults }),
  });
  closers.push(async () => await queue.close());
  return queue;
}

/**
 * Counts the reads of the stored job defaults `driver` answers, by wrapping
 * its `getQueueState` in place.
 */
function countDefaultsReads(driver: JobsDriver): { reads: number } {
  const counter = { reads: 0 };
  const original = driver.getQueueState!.bind(driver);

  driver.getQueueState = async (q, name): Promise<QueueStateEntry | null> => {
    if (name === JOB_DEFAULTS_STATE) {
      counter.reads++;
    }
    return await original(q, name);
  };

  return counter;
}

/** Removes a method from one driver instance, so it looks unimplemented. */
function without(driver: JobsDriver, ...methods: (keyof JobsDriver)[]): void {
  for (const method of methods) {
    Object.defineProperty(driver, method, {
      value: undefined,
      configurable: true,
    });
  }
}

/** The backends the propagation and repeat cases run on. */
const backends: {
  /** Label. */
  name: string;
  /** A connected driver, and how to dispose of it. */
  make: () => Promise<JobsDriver>;
}[] = [
  { name: "memory", make: async () => new MemoryDriver() },
  {
    name: "file",
    make: async () => {
      const tmp = await makeTmpDir("bun-jobs-qdef-file");
      cleanups.push(tmp.cleanup);
      const driver = new FileDriver({ root: tmp.path });
      closers.push(async () => await driver.close());
      return driver;
    },
  },
  {
    name: "sqlite",
    make: async () => {
      const tmp = await makeTmpDir("bun-jobs-qdef-sqlite");
      cleanups.push(tmp.cleanup);
      const driver = new SqlDriver({
        url: `sqlite://${join(tmp.path, "jobs.db")}`,
      });
      closers.push(async () => await driver.close());
      return driver;
    },
  },
];

describe("queue job defaults: precedence", () => {
  it("resolves explicit > override > definition > code > built-in, and records only the explicit", async () => {
    const driver = new MemoryDriver();
    const jobs = new BunJobs({
      namespace: testNamespace("qdef"),
      driver,
      logger: noopLogger,
      // The code layer.
      defaultJobOptions: { attempts: 2, timeout: 100, keepStacktraces: 4 },
    });
    closers.push(async () => await jobs.close());

    // The definition layer, over the code's.
    jobs.define("mail", async () => null, {
      attempts: 5,
      timeout: 200,
      priority: 3,
    });
    const queue = jobs.queue("jobs");

    // The override, over the definition's.
    await queue.setJobDefaults({ attempts: 7, keepLogs: 50 });

    const plain = await jobs.run("mail").start();
    expect(plain.opts).toMatchObject({
      attempts: 7, // override beats definition (D3)
      timeout: 200, // definition beats code
      priority: 3, // definition
      keepStacktraces: 4, // code
      keepLogs: 50, // override
      removeOnFail: false, // built-in
    });
    expect(plain.maxAttempts).toBe(7);
    expect(plain.priority).toBe(3);
    // Nothing was passed on the call itself: a definition is a default.
    expect(optsOf(plain).explicit).toBe(0);

    // An explicit option beats the override.
    const explicit = await jobs.run("mail").attempts(2).priority(9).start();
    expect(explicit.opts).toMatchObject({ attempts: 2, priority: 9 });
    expect(explicit.maxAttempts).toBe(2);
    expect(optsOf(explicit).explicit).toBe(
      JOB_OPTION_BITS.attempts | JOB_OPTION_BITS.priority,
    );

    // A draft goes the same way.
    const drafted = await jobs.create("mail").save();
    expect(drafted.opts).toMatchObject({ attempts: 7, timeout: 200 });
    expect(optsOf(drafted).explicit).toBe(0);
  });

  it("keeps a definition's other options (delay, deadLetter) as before", async () => {
    const driver = new MemoryDriver();
    const jobs = new BunJobs({
      namespace: testNamespace("qdef"),
      driver,
      logger: noopLogger,
    });
    closers.push(async () => await jobs.close());
    jobs.define("later", async () => null, {
      delay: 60_000,
      deadLetter: "graveyard",
      attempts: 3,
    });

    const job = await jobs.run("later").start();

    expect(job.state).toBe("delayed");
    expect(job.opts.deadLetter).toBe("graveyard");
    expect(job.opts.attempts).toBe(3);
    expect(optsOf(job).explicit).toBe(0);
  });

  it("puts the override between a plain queue's defaultJobOptions and the call", async () => {
    const queue = makeQueue(new MemoryDriver(), testNamespace("qdef"), {
      defaults: { attempts: 2, backoff: 10, timeout: 5 },
    });
    await queue.setJobDefaults({
      attempts: 4,
      backoff: { type: "exponential", delay: 100 },
    });

    const defaulted = await queue.add("x", {});
    expect(defaulted.opts).toMatchObject({
      attempts: 4,
      backoff: { type: "exponential", delay: 100 },
      timeout: 5,
    });
    expect(optsOf(defaulted).explicit).toBe(0);

    const explicit = await queue.add("x", {}, { attempts: 1, backoff: 7 });
    expect(explicit.opts).toMatchObject({ attempts: 1, backoff: 7 });
    expect(optsOf(explicit).explicit).toBe(
      JOB_OPTION_BITS.attempts | JOB_OPTION_BITS.backoff,
    );
  });

  it("gives each flow node its own queue's override", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("qdef");
    const parents = makeQueue(driver, namespace, { name: "parents" });
    const children = makeQueue(driver, namespace, { name: "children" });
    await parents.setJobDefaults({ attempts: 3 });
    await children.setJobDefaults({ attempts: 8 });

    const {
      job,
      children: [child],
    } = await parents.addFlow({
      name: "parent",
      data: {},
      children: [{ name: "child", data: {}, queue: "children" }],
    });

    expect(job.opts.attempts).toBe(3);
    expect(child!.job.opts.attempts).toBe(8);
    expect(child!.job.maxAttempts).toBe(8);
  });

  it("reaches debounced and throttled adds", async () => {
    const queue = makeQueue(new MemoryDriver(), testNamespace("qdef"));
    await queue.setJobDefaults({ timeout: 900 });

    const debounced = await queue.add(
      "d",
      {},
      { debounce: { id: "a", ttl: 60_000 } },
    );
    const throttled = await queue.add(
      "t",
      {},
      { throttle: { id: "b", ttl: 60_000 }, priority: 2 },
    );

    expect(debounced.opts.timeout).toBe(900);
    expect(throttled.opts.timeout).toBe(900);
    expect(optsOf(throttled).explicit).toBe(JOB_OPTION_BITS.priority);
  });
});

describe("queue job defaults: the producer's cache", () => {
  for (const backend of backends) {
    describe(backend.name, () => {
      it("reaches another producer on the same backend within its refresh interval", async () => {
        const driver = await backend.make();
        const namespace = testNamespace("qdef");
        const producer = makeQueue(driver, namespace, { refresh: 300 });
        const operator = makeQueue(driver, namespace, { refresh: 300 });

        // Warms the producer's cache with "no override".
        expect((await producer.add("x", {})).opts.attempts).toBe(1);

        const written = await operator.setJobDefaults({ attempts: 6 });
        expect(written.contended).toBe(false);
        expect(written.seq).toBeGreaterThan(0);

        // The writer sees its own write at once...
        expect((await operator.add("x", {})).opts.attempts).toBe(6);
        // ...another producer only once its read has aged out.
        expect((await producer.add("x", {})).opts.attempts).toBe(1);

        const changedAt = Date.now();
        await waitFor(
          async () => (await producer.add("x", {})).opts.attempts === 6,
          { timeout: 3_000, interval: 25 },
        );
        // Within the interval plus a read, not "eventually".
        expect(Date.now() - changedAt).toBeLessThan(300 + 500);

        // A reset reaches it the same way.
        await operator.resetJobDefaults();
        await waitFor(
          async () => (await producer.add("x", {})).opts.attempts === 1,
          { timeout: 3_000, interval: 25 },
        );
      });

      it("reads on every add with jobDefaultsRefreshInterval: 0", async () => {
        const driver = await backend.make();
        const namespace = testNamespace("qdef");
        const producer = makeQueue(driver, namespace, { refresh: 0 });
        const operator = makeQueue(driver, namespace);

        await producer.add("x", {});
        await operator.setJobDefaults({ priority: 5 });

        const job = await producer.add("x", {});
        expect(job.opts.priority).toBe(5);
        expect(job.priority).toBe(5);
      });

      it("stores a repeat series' code layers, and gives each occurrence the current override", async () => {
        const driver = await backend.make();
        const namespace = testNamespace("qdef");
        const queue = makeQueue(driver, namespace, {
          defaults: { timeout: 50 },
        });
        await queue.setJobDefaults({ attempts: 4, timeout: 70 });

        const first = await queue.add(
          "tick",
          {},
          { repeat: { every: 60_000, immediately: true }, priority: 2 },
        );
        // The first occurrence has the override; the series does not.
        expect(first.opts).toMatchObject({ attempts: 4, timeout: 70 });
        const [series] = await driver.listRepeats(queue.ref);
        expect(series!.opts).toMatchObject({
          attempts: 1,
          timeout: 50,
          priority: 2,
        });
        expect(optsOf(series!).explicit).toBe(JOB_OPTION_BITS.priority);

        let completed = 0;
        const worker = new BunQueueWorker(
          "jdef",
          async () => {
            return null;
          },
          {
            namespace,
            driver,
            logger: noopLogger,
            pollInterval: 10,
            jobDefaultsRefreshInterval: 0,
          },
        );
        closers.push(async () => await worker.close({ force: true }));
        worker.on("completed", () => {
          completed++;
        });

        // The override changes while the first occurrence waits: the next
        // occurrence takes the new one, never the explicit priority.
        await queue.setJobDefaults({
          attempts: 9,
          timeout: null,
          priority: 7,
        });
        void worker.run();

        await waitFor(async () => completed >= 1, { timeout: 5_000 });
        let next: JobRecord | null = null;
        await waitFor(
          async () => {
            const [after] = await driver.listRepeats(queue.ref);
            next = after?.nextJobId
              ? await driver.getJob(queue.ref, after.nextJobId)
              : null;
            return next !== null && next.id !== first.id;
          },
          { timeout: 5_000 },
        );

        expect(next!.opts).toMatchObject({
          attempts: 9,
          timeout: 50,
          priority: 2,
        });
        expect(next!.maxAttempts).toBe(9);
        expect(next!.priority).toBe(2);
        expect(optsOf(next!).explicit).toBe(JOB_OPTION_BITS.priority);
      });
    });
  }

  it("costs an add no read while fresh, and addBulk one read per call", async () => {
    const driver = new MemoryDriver();
    const counter = countDefaultsReads(driver);
    const queue = makeQueue(driver, testNamespace("qdef"), { refresh: 60_000 });

    await queue.add("x", {});
    const afterFirst = counter.reads;
    // One read (the connect's prefetch, which the first add joins).
    expect(afterFirst).toBe(1);

    for (let i = 0; i < 20; i++) {
      await queue.add("x", {});
    }
    await queue.addBulk(
      Array.from({ length: 50 }, () => ({ name: "x", data: {} })),
    );
    expect(counter.reads).toBe(afterFirst);
  });

  it("reads once per addBulk call, however many entries, at refresh 0", async () => {
    const driver = new MemoryDriver();
    const counter = countDefaultsReads(driver);
    const queue = makeQueue(driver, testNamespace("qdef"), { refresh: 0 });
    await queue.connect();
    // Let the connect's prefetch land, so it is not counted below.
    await Bun.sleep(0);
    const before = counter.reads;

    await queue.setJobDefaults({ attempts: 3 });
    const beforeBulk = counter.reads;
    const added = await queue.addBulk(
      Array.from({ length: 100 }, (_, i) => ({ name: "x", data: { i } })),
    );

    expect(counter.reads - beforeBulk).toBe(1);
    expect(added.every((job) => job.opts.attempts === 3)).toBe(true);

    // And a plain add at refresh 0 reads each time.
    const beforeAdds = counter.reads;
    await queue.add("x", {});
    await queue.add("x", {});
    expect(counter.reads - beforeAdds).toBe(2);
    expect(before).toBeGreaterThanOrEqual(1);
  });

  it("refuses a bad jobDefaultsRefreshInterval when built", () => {
    expect(
      () =>
        new BunQueue("jdef", {
          namespace: testNamespace("qdef"),
          driver: new MemoryDriver(),
          jobDefaultsRefreshInterval: -1,
        }),
    ).toThrow(ConfigError);
    expect(
      () =>
        new BunQueueWorker("jdef", async () => null, {
          namespace: testNamespace("qdef"),
          driver: new MemoryDriver(),
          jobDefaultsRefreshInterval: 1.5,
        }),
    ).toThrow(ConfigError);
  });

  it("gives a healed repeat occurrence the override too", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("qdef");
    const queue = makeQueue(driver, namespace);
    await queue.add("fragile", {}, { repeat: { every: 60_000 } });
    const [before] = await queue.listRepeatables();
    await driver.removeJob(queue.ref, before!.nextJobId!);
    await queue.setJobDefaults({ attempts: 11 });

    const worker = new BunQueueWorker("jdef", async () => null, {
      namespace,
      driver,
      logger: noopLogger,
      pollInterval: 10,
    });
    closers.push(async () => await worker.close({ force: true }));
    void worker.run();

    let healed: JobRecord | null = null;
    await waitFor(
      async () => {
        const [after] = await queue.listRepeatables();
        healed = after?.nextJobId
          ? await driver.getJob(queue.ref, after.nextJobId)
          : null;
        return healed !== null;
      },
      { timeout: 10_000, message: "the series was never healed" },
    );

    expect(healed!.opts.attempts).toBe(11);
    expect(healed!.maxAttempts).toBe(11);
  });

  it("leaves a series stored before the explicit mask as it was", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace("qdef");
    const queue = makeQueue(driver, namespace);
    await queue.add("legacy", {}, { repeat: { every: 60_000 } });
    const [series] = await driver.listRepeats(queue.ref);
    // As an older version stored it: no mask.
    const { explicit: _explicit, ...unmarked } = optsOf(series!);
    await driver.upsertRepeat(queue.ref, { ...series!, opts: unmarked });
    await driver.removeJob(queue.ref, series!.nextJobId!);
    await queue.setJobDefaults({ attempts: 11 });

    const worker = new BunQueueWorker("jdef", async () => null, {
      namespace,
      driver,
      logger: noopLogger,
      pollInterval: 10,
    });
    closers.push(async () => await worker.close({ force: true }));
    void worker.run();

    let healed: JobRecord | null = null;
    await waitFor(
      async () => {
        const [after] = await queue.listRepeatables();
        healed = after?.nextJobId
          ? await driver.getJob(queue.ref, after.nextJobId)
          : null;
        return healed !== null;
      },
      { timeout: 10_000 },
    );

    expect(healed!.opts.attempts).toBe(1);
  });
});

describe("queue job defaults: get / set / reset", () => {
  it("describes code, override and effective, and primes its own cache", async () => {
    const queue = makeQueue(new MemoryDriver(), testNamespace("qdef"), {
      defaults: { attempts: 2 },
      refresh: 60_000,
    });

    const empty = await queue.getJobDefaults();
    expect(empty).toMatchObject({
      seq: 0,
      override: {},
      overridden: [],
      propagationMs: 60_000,
    });
    expect(empty.code.attempts).toBe(2);
    expect(empty.effective.attempts).toBe(2);
    expect(empty.updatedAt).toBeUndefined();

    const set = await queue.setJobDefaults(
      { attempts: 5, removeOnComplete: { count: 10 } },
      { expectedSeq: 0, by: "ops" },
    );
    expect(set).toMatchObject({
      contended: false,
      override: { attempts: 5, removeOnComplete: { count: 10 } },
      overridden: ["attempts", "removeOnComplete"],
    });
    expect(set.code.attempts).toBe(2);
    expect(set.effective.attempts).toBe(5);
    expect(set.seq).toBeGreaterThan(0);
    expect(typeof set.updatedAt).toBe("number");
    // Primed: this queue adds under it at once, whatever its interval.
    expect((await queue.add("x", {})).opts.attempts).toBe(5);

    // A stale expectedSeq changes nothing.
    const stale = await queue.setJobDefaults(
      { attempts: 9 },
      { expectedSeq: 0 },
    );
    expect(stale.contended).toBe(true);
    expect(stale.override.attempts).toBe(5);

    // null clears one key.
    const cleared = await queue.setJobDefaults({ attempts: null });
    expect(cleared.overridden).toEqual(["removeOnComplete"]);

    const reset = await queue.resetJobDefaults({ expectedSeq: cleared.seq });
    expect(reset).toMatchObject({ contended: false, override: {} });
    expect(reset.seq).toBeGreaterThan(cleared.seq);
    expect((await queue.add("x", {})).opts.removeOnComplete).toEqual(
      reset.code.removeOnComplete,
    );
  });

  it("refuses an out-of-bounds or unknown value before writing", async () => {
    const queue = makeQueue(new MemoryDriver(), testNamespace("qdef"));

    await expect(queue.setJobDefaults({ attempts: 0 })).rejects.toThrow(
      ConfigError,
    );
    await expect(
      queue.setJobDefaults({ nope: 1 } as unknown as { attempts: number }),
    ).rejects.toThrow(ConfigError);
    expect((await queue.getJobDefaults()).seq).toBe(0);
  });
});

describe("queue job defaults: apply", () => {
  /** A queue on the memory driver with three pending jobs of different kinds. */
  async function seeded(driver: JobsDriver = new MemoryDriver()) {
    const queue = makeQueue(driver, testNamespace("qdef"));
    const defaulted = await queue.add("a", {});
    const explicit = await queue.add("b", {}, { attempts: 2 });
    const delayed = await queue.add("c", {}, { delay: 60_000 });
    return { queue, driver, defaulted, explicit, delayed };
  }

  for (const make of [
    { name: "memory", driver: async () => new MemoryDriver() },
    { name: "file", driver: async () => await backends[1]!.make() },
  ]) {
    it(`rewrites pending jobs, keeping what their add passed (${make.name})`, async () => {
      const { queue, driver, defaulted, explicit, delayed } = await seeded(
        await make.driver(),
      );
      const { seq } = await queue.setJobDefaults({ attempts: 6, timeout: 30 });

      const dry = await queue.applyJobDefaults({ seq, dryRun: true });
      expect(dry).toMatchObject({
        seq,
        keys: ["attempts", "timeout"],
        dryRun: true,
        examined: 3,
        rewritten: 3,
        next: null,
      });
      expect(
        (await driver.getJob(queue.ref, defaulted.id))!.opts.attempts,
      ).toBe(1);

      const applied = await queue.applyJobDefaults({ seq });
      expect(applied).toMatchObject({
        dryRun: false,
        rewritten: 3,
        next: null,
      });

      const a = (await driver.getJob(queue.ref, defaulted.id))!;
      const b = (await driver.getJob(queue.ref, explicit.id))!;
      const c = (await driver.getJob(queue.ref, delayed.id))!;
      expect(a.opts).toMatchObject({ attempts: 6, timeout: 30 });
      expect(a.maxAttempts).toBe(6);
      // Its explicit attempts kept; its defaulted timeout written.
      expect(b.opts).toMatchObject({ attempts: 2, timeout: 30 });
      expect(b.maxAttempts).toBe(2);
      expect(c.opts).toMatchObject({ attempts: 6, timeout: 30 });

      // Applying again changes nothing.
      const again = await queue.applyJobDefaults({ seq });
      expect(again.rewritten).toBe(0);
    });
  }

  it("walks in bounded calls to the end, and narrows by keys and states", async () => {
    const { queue, driver, defaulted, delayed } = await seeded();
    const { seq } = await queue.setJobDefaults({ attempts: 6, timeout: 30 });

    let cursor: string | null = null;
    let examined = 0;
    let calls = 0;
    do {
      const page: Awaited<ReturnType<BunQueue["applyJobDefaults"]>> =
        await queue.applyJobDefaults({
          seq,
          keys: ["timeout"],
          states: ["waiting"],
          limit: 1,
          cursor,
        });
      expect(page.keys).toEqual(["timeout"]);
      examined += page.examined;
      cursor = page.next;
      calls++;
    } while (cursor !== null && calls < 10);

    expect(examined).toBe(2);
    const a = (await driver.getJob(queue.ref, defaulted.id))!;
    expect(a.opts).toMatchObject({ attempts: 1, timeout: 30 });
    // Not walked: delayed.
    expect((await driver.getJob(queue.ref, delayed.id))!.opts.timeout).toBe(0);
  });

  it("refuses an override that moved on (DEFAULTS_CHANGED), writing nothing", async () => {
    const { queue, driver, defaulted } = await seeded();
    const first = await queue.setJobDefaults({ attempts: 6 });
    await queue.setJobDefaults({ attempts: 7 });

    const error = await queue
      .applyJobDefaults({ seq: first.seq })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(JobDefaultsChangedError);
    const changed = error as JobDefaultsChangedError;
    expect(changed.code).toBe("DEFAULTS_CHANGED");
    expect(changed.context.expectedSeq).toBe(first.seq);
    expect(changed.context.seq).toBeGreaterThan(first.seq);
    expect((await driver.getJob(queue.ref, defaulted.id))!.opts.attempts).toBe(
      1,
    );
  });

  it("refuses nothing to apply, and a key the override does not set", async () => {
    const { queue } = await seeded();

    await expect(queue.applyJobDefaults({ seq: 0 })).rejects.toThrow(
      /override nothing/,
    );

    const { seq } = await queue.setJobDefaults({ attempts: 3 });
    await expect(
      queue.applyJobDefaults({ seq, keys: ["timeout"] }),
    ).rejects.toThrow(/do not override "timeout"/);
    await expect(
      queue.applyJobDefaults({ seq, cursor: "junk" }),
    ).rejects.toThrow(ConfigError);
  });

  it("skips jobs added before the explicit mask unless told otherwise", async () => {
    const driver = new MemoryDriver();
    const queue = makeQueue(driver, testNamespace("qdef"));
    const job = await queue.add("old", {});
    const stored = (await driver.getJob(queue.ref, job.id))!;
    const { explicit: _explicit, ...unmarked } = optsOf(stored);
    await driver.removeJob(queue.ref, job.id);
    await driver.addJob(queue.ref, { ...stored, opts: unmarked });
    const { seq } = await queue.setJobDefaults({ attempts: 4 });

    const skipped = await queue.applyJobDefaults({ seq });
    expect(skipped).toMatchObject({ skippedUnmarked: 1, rewritten: 0 });

    const included = await queue.applyJobDefaults({
      seq,
      includeUnmarked: true,
    });
    expect(included.rewritten).toBe(1);
    expect((await driver.getJob(queue.ref, job.id))!.maxAttempts).toBe(4);
  });
});

describe("queue job defaults: a driver without support", () => {
  it("refuses apply without rewritePendingOptions, but saves and adds", async () => {
    const driver = new MemoryDriver();
    without(driver, "rewritePendingOptions");
    const queue = makeQueue(driver, testNamespace("qdef"));

    const { seq } = await queue.setJobDefaults({ attempts: 3 });
    expect((await queue.add("x", {})).opts.attempts).toBe(3);

    const error = await queue
      .applyJobDefaults({ seq })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotSupportedError);
    expect((error as NotSupportedError).context.method).toBe(
      "rewritePendingOptions",
    );
  });

  it("has no override without queue state: reads answer none, writes refuse", async () => {
    const driver = new MemoryDriver();
    without(driver, "getQueueState", "setQueueState");
    const queue = makeQueue(driver, testNamespace("qdef"), {
      defaults: { attempts: 2 },
    });

    expect((await queue.add("x", {})).opts.attempts).toBe(2);
    expect(await queue.getJobDefaults()).toMatchObject({
      seq: 0,
      override: {},
    });
    await expect(queue.setJobDefaults({ attempts: 3 })).rejects.toThrow(
      NotSupportedError,
    );
    await expect(queue.resetJobDefaults()).rejects.toThrow(NotSupportedError);
    await expect(queue.applyJobDefaults({ seq: 0 })).rejects.toThrow(
      NotSupportedError,
    );
  });
});
