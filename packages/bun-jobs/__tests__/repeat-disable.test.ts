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
    async function openQueue(options?: {
      /** Whether the queue publishes its events for other instances; off by default, as on a queue. */
      publish?: boolean;
    }) {
      const driver = createDriver(config);
      const namespace = testNamespace("disable");
      const queue = new BunQueue("repeats", {
        namespace,
        driver,
        logger: noopLogger,
        publish: options?.publish ?? false,
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

    for (const immediately of [false, true]) {
      it(`keeps a disabled series silent when it is added again${immediately ? ", immediately" : ""}`, async () => {
        const { driver, queue } = await openQueue({ publish: true });
        const repeat = { every: 60_000, key: "silent", immediately };
        await queue.add("tick", { v: 1 }, { repeat });
        expect(await queue.disableRepeatable("silent")).toBe(true);

        // Everything this queue announces from here, locally and on the wire.
        const local: string[] = [];
        queue.on("repeatScheduled", () => local.push("repeatScheduled"));
        queue.on("added", () => local.push("added"));
        queue.on("duplicate", () => local.push("duplicate"));
        const published: string[] = [];
        const publish = driver.publish.bind(driver);
        driver.publish = async (event) => {
          published.push(event.type);
          await publish(event);
        };

        const again = await queue.add("tick", { v: 2 }, { repeat });

        expect(again.wasAdded).toBe(false);
        expect(again.repeatKey).toBe("silent");
        expect(await queue.getJob(again.id)).toBeNull();
        expect(await queue.count("waiting")).toBe(0);
        expect(await queue.count("delayed")).toBe(0);
        expect(local).toEqual([]);
        expect(published).toEqual([]);

        const [series] = await queue.listRepeatables();
        expect(series?.disabled).toBe(true);
        // The definition took the update all the same.
        expect(series?.data).toEqual({ v: 2 });

        const enabledAt = Date.now();
        expect(await queue.enableRepeatable("silent")).toBe(true);
        const [after] = await queue.listRepeatables();
        expect(after?.disabled).toBe(false);
        const next = await queue.getJob(after!.nextJobId!);
        expect(next?.state).toBe("delayed");
        expect(next?.data).toEqual({ v: 2 });
        expect(next!.runAt).toBeGreaterThan(enabledAt);
        expect(next!.runAt).toBeLessThanOrEqual(Date.now() + 60_000);
      });
    }

    it("takes a disabled series' new schedule when it is added again, and enables it on that schedule", async () => {
      const { queue } = await openQueue();
      await queue.add("tick", {}, { repeat: { every: 60_000, key: "moved" } });
      expect(await queue.disableRepeatable("moved")).toBe(true);

      const hourly = { every: 3_600_000, key: "moved" };
      const again = await queue.add("tick", {}, { repeat: hourly });
      expect(again.wasAdded).toBe(false);
      const [series] = await queue.listRepeatables();
      expect(series?.disabled).toBe(true);
      expect(series?.every).toBe(3_600_000);

      const enabledAt = Date.now();
      expect(await queue.enableRepeatable("moved")).toBe(true);
      const [after] = await queue.listRepeatables();
      const next = await queue.getJob(after!.nextJobId!);
      // The hour it was given while disabled, not the minute it had before.
      expect(next!.runAt).toBeGreaterThan(enabledAt + 120_000);
      expect(next!.runAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
    });

    it("announces a disabled series added again nowhere: not locally, not to another instance", async () => {
      const { driver, queue } = await openQueue({ publish: true });
      await queue.add("tick", {}, { repeat: { every: 60_000, key: "hushed" } });
      expect(await queue.disableRepeatable("hushed")).toBe(true);

      // A second instance on the same queue, on its own connection where the
      // backend has one, hears only what is published.
      const remoteDriver =
        backendName === "memory" ? driver : createDriver(config);
      const remote = new BunQueue("repeats", {
        namespace: queue.namespace,
        driver: remoteDriver,
        logger: noopLogger,
        subscribe: true,
      });
      backendCleanups.push(async () => {
        await remote.close();
        if (remoteDriver !== driver) {
          await remoteDriver.close();
        }
      });
      await remote.connect();

      const local: number[] = [];
      const heard: number[] = [];
      queue.on("repeatScheduled", (_key, nextRunAt) => local.push(nextRunAt));
      remote.on("repeatScheduled", (_key, nextRunAt) => heard.push(nextRunAt));

      await queue.add("tick", {}, { repeat: { every: 60_000, key: "hushed" } });

      // Enabling does announce, everywhere; it is the control that proves the
      // listeners work, and — events arriving in order — that nothing from
      // the add is still on its way.
      expect(await queue.enableRepeatable("hushed")).toBe(true);
      const [after] = await queue.listRepeatables();
      await waitFor(() => heard.length > 0, { timeout: 5_000 });
      await Bun.sleep(50);

      expect(local).toEqual([after!.nextRunAt!]);
      expect(heard).toEqual([after!.nextRunAt!]);
    });

    it("clears a disabled series' next occurrence, in the stored record and as listed, and sets it again on enable", async () => {
      const { driver, queue } = await openQueue();
      await queue.add("tick", {}, { repeat: { every: 60_000, key: "ptr" } });
      expect(await queue.disableRepeatable("ptr")).toBe(true);

      const [listed] = await queue.listRepeatables();
      expect([listed?.nextRunAt, listed?.nextJobId]).toEqual([null, null]);
      const stored = await driver.getRepeat(queue.ref, "k:ptr");
      expect([stored?.nextRunAt, stored?.nextJobId]).toEqual([null, null]);

      // Added again while disabled: still nothing next.
      await queue.add("tick", {}, { repeat: { every: 60_000, key: "ptr" } });
      const [readded] = await queue.listRepeatables();
      expect([readded?.nextRunAt, readded?.nextJobId]).toEqual([null, null]);

      expect(await queue.enableRepeatable("ptr")).toBe(true);
      const [after] = await queue.listRepeatables();
      const next = await queue.getJob(after!.nextJobId!);
      expect(next?.state).toBe("delayed");
      expect(after?.nextRunAt).toBe(next!.runAt);
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
    // Which is not reported as the series' next: it is disabled.
    const [listed] = await queue.listRepeatables();
    expect([listed?.nextRunAt, listed?.nextJobId]).toEqual([null, null]);
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
