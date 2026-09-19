import type { JobsDriver, RepeatRecord } from "../lib/index";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  BunQueue,
  BunQueueWorker,
  ConfigError,
  createDriver,
  MemoryDriver,
} from "../lib/index";
import { occurrenceRecord } from "../lib/queue/repeatControl";
import { testNamespace, waitFor } from "./helpers";
import { crossProcessBackends } from "./helpers/backends";

/**
 * Disabling and enabling a repeat series: `BunQueue.disableRepeatable` /
 * `enableRepeatable`, and `Job.disable` / `enable` on an occurrence.
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

/** Every backend a series and its flag can be stored on. */
const STORAGE_BACKENDS = [
  { name: "memory", config: { type: "memory" } as const, available: true },
  ...(await crossProcessBackends({ cleanups: backendCleanups })),
];

for (const { name: backendName, config, available } of STORAGE_BACKENDS) {
  describe.skipIf(!available)(`disabling a series: ${backendName}`, () => {
    /** A queue on a fresh driver for this backend, purged when the suite ends. */
    async function openQueue() {
      const driver = createDriver(config);
      const namespace = testNamespace("disable");
      const queue = new BunQueue("repeats", {
        namespace,
        driver,
        logger: noopLogger,
      });
      backendCleanups.push(async () => {
        await queue.close();
        await driver.purge(namespace);
        await driver.close();
      });
      return { driver, queue };
    }

    it("removes the pending occurrence, lists the series disabled, and enables it from now", async () => {
      const { queue } = await openQueue();
      await queue.add("tick", {}, { repeat: { every: 60_000, key: "k" } });
      const [before] = await queue.listRepeatables();
      expect(before?.disabled).toBe(false);
      const pending = before!.nextJobId!;
      expect(await queue.getJob(pending)).not.toBeNull();

      expect(await queue.disableRepeatable("k")).toBe(true);
      expect(await queue.getJob(pending)).toBeNull();
      expect((await queue.listRepeatables())[0]?.disabled).toBe(true);
      // Already disabled.
      expect(await queue.disableRepeatable("k")).toBe(false);

      const enabledAt = Date.now();
      expect(await queue.enableRepeatable("k")).toBe(true);
      const [after] = await queue.listRepeatables();
      expect(after?.disabled).toBe(false);
      expect(after?.nextJobId).not.toBeNull();
      const next = await queue.getJob(after!.nextJobId!);
      expect(next?.state).toBe("delayed");
      // From now: the next interval, not a backlog.
      expect(next!.runAt).toBeGreaterThanOrEqual(enabledAt);
      expect(next!.runAt).toBeLessThanOrEqual(Date.now() + 60_000);
      expect(await queue.enableRepeatable("k")).toBe(false);

      expect(await queue.disableRepeatable("missing")).toBe(false);
      expect(await queue.enableRepeatable("missing")).toBe(false);
    });

    it("acts on an occurrence's series from the job, and refuses a job in none", async () => {
      const { queue } = await openQueue();
      const occurrence = await queue.add(
        "tick",
        {},
        { repeat: { every: 60_000, key: "from-job" } },
      );
      const plain = await queue.add("once", {});

      expect(await occurrence.disable()).toBe(true);
      expect((await queue.listRepeatables())[0]?.disabled).toBe(true);
      expect(await occurrence.disable()).toBe(false);
      expect(await occurrence.enable()).toBe(true);
      expect((await queue.listRepeatables())[0]?.disabled).toBe(false);

      await expect(plain.disable()).rejects.toThrow(ConfigError);
      await expect(plain.enable()).rejects.toThrow(ConfigError);
    });

    it("clears the flag when the series is removed, so one added again starts enabled", async () => {
      const { queue } = await openQueue();
      await queue.add("tick", {}, { repeat: { every: 60_000, key: "again" } });
      expect(await queue.disableRepeatable("again")).toBe(true);
      expect(await queue.removeRepeatable("again")).toBe(true);

      await queue.add("tick", {}, { repeat: { every: 60_000, key: "again" } });
      const [series] = await queue.listRepeatables();
      expect(series?.disabled).toBe(false);
      // Not disabled, so disabling it now is a change.
      expect(await queue.disableRepeatable("again")).toBe(true);
    });
  });
}

describe("workers and a disabled series", () => {
  /** A queue and a worker on one memory driver; the worker is not started. */
  function setup(options: {
    /** Whether the worker runs maintenance. */
    maintenance: boolean;
  }) {
    const driver = new MemoryDriver();
    const namespace = testNamespace("disabled-worker");
    const queue = new BunQueue("repeats", {
      namespace,
      driver,
      logger: noopLogger,
    });
    const runs: string[] = [];
    const worker = new BunQueueWorker(
      "repeats",
      async (job) => {
        runs.push(job.id);
        return null;
      },
      {
        namespace,
        driver,
        logger: noopLogger,
        pollInterval: 5,
        maxBlock: 10,
        maintenance: options.maintenance,
      },
    );
    closers.push(() => queue.close());
    closers.push(() => worker.close({ force: true }));
    return { driver, queue, worker, runs };
  }

  /**
   * Puts back an occurrence of `key` as a worker racing the disable would
   * have: scheduled just as the series was disabled, and pointed to.
   */
  async function raceAnOccurrence(
    driver: JobsDriver,
    queue: BunQueue,
    key: string,
    runAt: number,
  ): Promise<string> {
    const definition = (await driver.getRepeat(
      queue.ref,
      `k:${key}`,
    )) as RepeatRecord;
    const record = occurrenceRecord(definition, runAt, Date.now());
    await driver.addJob(queue.ref, record);
    await driver.upsertRepeat(queue.ref, {
      ...definition,
      nextRunAt: runAt,
      nextJobId: record.id,
    });
    return record.id;
  }

  it("runs an occurrence already scheduled, and schedules nothing after it", async () => {
    const { driver, queue, worker, runs } = setup({ maintenance: false });
    await queue.add("tick", {}, { repeat: { every: 60_000, key: "raced" } });
    expect(await queue.disableRepeatable("raced")).toBe(true);
    const raced = await raceAnOccurrence(driver, queue, "raced", Date.now());

    void worker.run();
    await waitFor(() => runs.length === 1);
    await Bun.sleep(50);

    expect(runs).toEqual([raced]);
    const series = await driver.getRepeat(queue.ref, "k:raced");
    // Still pointing at the occurrence that ran: nothing new was scheduled.
    expect(series?.nextJobId).toBe(raced);
    expect(await queue.count("delayed")).toBe(0);
    expect(await queue.count("waiting")).toBe(0);
  });

  it("maintenance removes a disabled series' pending occurrence and gives it no replacement", async () => {
    const { driver, queue, worker, runs } = setup({ maintenance: true });
    await queue.add("tick", {}, { repeat: { every: 60_000, key: "healed" } });
    expect(await queue.disableRepeatable("healed")).toBe(true);
    const raced = await raceAnOccurrence(
      driver,
      queue,
      "healed",
      Date.now() + 3_600_000,
    );

    void worker.run();
    await waitFor(async () => (await queue.getJob(raced)) === null);
    await Bun.sleep(50);

    expect(runs).toEqual([]);
    expect(await queue.count("delayed")).toBe(0);
    expect(await queue.count("waiting")).toBe(0);
  });

  it("keeps a re-enabled series going, even after reading it disabled", async () => {
    const { driver, queue, worker, runs } = setup({ maintenance: false });
    await queue.add(
      "tick",
      {},
      { repeat: { every: 40, key: "revived", immediately: true } },
    );
    // Stop the series and race one occurrence past the stop, so the worker
    // reads it disabled.
    expect(await queue.disableRepeatable("revived")).toBe(true);
    await raceAnOccurrence(driver, queue, "revived", Date.now());

    void worker.run();
    await waitFor(() => runs.length === 1);

    expect(await queue.enableRepeatable("revived")).toBe(true);
    // The occurrence enable scheduled must schedule the next, and so on.
    // Promoted here: maintenance is off, so the heal pass cannot tidy the
    // raced occurrence away before the worker reads the series disabled.
    await waitFor(
      async () => {
        await driver.promoteDelayed(queue.ref, Date.now(), 100);
        return runs.length >= 4;
      },
      { timeout: 2_000, interval: 10 },
    );
  });
});
