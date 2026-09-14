import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunQueue,
  BunQueueWorker,
  ConfigError,
  MemoryDriver,
  repeatJobId,
} from "../lib/index";
import { testNamespace, waitFor } from "./helpers";

/**
 * Repeatable jobs.
 *
 * The design turns on one property: the next occurrence's id is derived from
 * the series and the time it is due, so scheduling it is idempotent. That is
 * what lets every worker try, with no leader and no lock, and it is the
 * property most worth testing.
 */

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.allSettled(closers.map((close) => close()));
  closers.length = 0;
});

/** A queue on a shared driver, tracked for cleanup. */
function makeQueue(driver: MemoryDriver, namespace: string) {
  const queue = new BunQueue("repeats", {
    namespace,
    driver,
    logger: noopLogger,
  });
  closers.push(() => queue.close());
  return queue;
}

/** A worker on the same queue, tracked for cleanup. */
function makeWorker(
  driver: MemoryDriver,
  namespace: string,
  processor: (job: any) => unknown,
) {
  const worker = new BunQueueWorker("repeats", processor as never, {
    namespace,
    driver,
    logger: noopLogger,
    pollInterval: 10,
    maxBlock: 20,
  });
  closers.push(() => worker.close({ force: true }));
  return worker;
}

describe("repeatable jobs", () => {
  it("creates the series and schedules its first occurrence", async () => {
    const queue = makeQueue(new MemoryDriver(), testNamespace());

    const job = await queue.add(
      "digest",
      { to: "ops" },
      { repeat: { every: 60_000 } },
    );

    expect(job.isRepeat).toBe(true);
    expect(job.repeatKey).toBe("digest|every:60000|");
    expect(job.state).toBe("delayed");

    const [definition] = await queue.listRepeatables();
    expect(definition).toMatchObject({
      key: "digest|every:60000|",
      every: 60_000,
      count: 0,
      nextJobId: job.id,
    });
    expect(definition.nextRunAt).toBe(job.runAt);
  });

  it("runs the first occurrence at once when asked", async () => {
    const queue = makeQueue(new MemoryDriver(), testNamespace());

    const job = await queue.add(
      "now",
      {},
      { repeat: { every: 60_000, immediately: true } },
    );

    expect(job.state).toBe("waiting");
  });

  it("accepts cron, including with seconds", async () => {
    const queue = makeQueue(new MemoryDriver(), testNamespace());

    const daily = await queue.add(
      "nightly",
      {},
      { repeat: { cron: "0 3 * * *" } },
    );
    expect(daily.runAt).toBeGreaterThan(Date.now());

    const often = await queue.add(
      "often",
      {},
      { repeat: { cron: "*/10 * * * * *" } },
    );
    // A six-field expression fires on the wall-clock mark.
    expect(new Date(often.runAt).getSeconds() % 10).toBe(0);
  });

  it("is idempotent: adding the same series twice adds one job", async () => {
    const queue = makeQueue(new MemoryDriver(), testNamespace());

    const first = await queue.add("dedupe", {}, { repeat: { every: 60_000 } });
    const second = await queue.add("dedupe", {}, { repeat: { every: 60_000 } });

    expect(second.id).toBe(first.id);
    expect(second.wasAdded).toBe(false);
    expect(await queue.count("delayed")).toBe(1);
    expect(await queue.listRepeatables()).toHaveLength(1);
  });

  it("schedules the next occurrence when one is claimed", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();
    const queue = makeQueue(driver, namespace);

    const ran: number[] = [];
    const worker = makeWorker(driver, namespace, () => {
      ran.push(Date.now());
      return null;
    });

    await queue.add("ticker", {}, { repeat: { every: 40, immediately: true } });
    void worker.run();

    await waitFor(() => ran.length >= 3, {
      timeout: 10_000,
      message: "the series stopped repeating",
    });

    const [definition] = await queue.listRepeatables();
    expect(definition.count).toBeGreaterThanOrEqual(3);
    // There is always exactly one occurrence pending.
    expect(definition.nextJobId).toBe(
      repeatJobId(definition.key, definition.nextRunAt!),
    );
  });

  it("stops at its limit", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();
    const queue = makeQueue(driver, namespace);

    let ran = 0;
    const worker = makeWorker(driver, namespace, () => {
      ran++;
      return null;
    });

    await queue.add(
      "limited",
      {},
      { repeat: { every: 20, immediately: true, limit: 3 } },
    );
    void worker.run();

    await waitFor(
      async () => {
        const [definition] = await queue.listRepeatables();
        return definition?.nextRunAt === null;
      },
      { timeout: 10_000, message: "the series never reached its limit" },
    );

    await Bun.sleep(120);
    expect(ran).toBe(3);
    expect(await queue.count("waiting")).toBe(0);
    expect(await queue.count("delayed")).toBe(0);
  });

  it("stops after its end time", async () => {
    const queue = makeQueue(new MemoryDriver(), testNamespace());

    await expect(
      queue.add(
        "expired",
        {},
        { repeat: { every: 1000, endAt: Date.now() - 1000 } },
      ),
    ).rejects.toThrow(/no occurrences left/);
  });

  it("removes the series and its pending occurrence", async () => {
    const queue = makeQueue(new MemoryDriver(), testNamespace());

    const job = await queue.add("doomed", {}, { repeat: { every: 60_000 } });
    const [definition] = await queue.listRepeatables();

    expect(await queue.removeRepeatable(definition.key)).toBe(true);
    expect(await queue.listRepeatables()).toEqual([]);
    expect(await queue.getJob(job.id)).toBeNull();
    expect(await queue.removeRepeatable(definition.key)).toBe(false);
  });

  it("never double-schedules with two workers on the same series", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();
    const queue = makeQueue(driver, namespace);

    const ran: string[] = [];
    for (const id of ["w1", "w2"]) {
      const worker = new BunQueueWorker(
        "repeats",
        async (job) => {
          ran.push(`${id}:${job.id}`);
          return null;
        },
        {
          namespace,
          driver,
          id,
          logger: noopLogger,
          pollInterval: 5,
          maxBlock: 10,
        },
      );
      closers.push(() => worker.close({ force: true }));
      void worker.run();
    }

    await queue.add(
      "contested",
      {},
      { repeat: { every: 25, immediately: true } },
    );

    await waitFor(() => ran.length >= 4, {
      timeout: 10_000,
      message: "the contested series stopped",
    });

    // Each occurrence ran exactly once, however many workers noticed it.
    const jobIds = ran.map((entry) => entry.split(":").slice(1).join(":"));
    expect(new Set(jobIds).size).toBe(jobIds.length);
  });

  it("heals a series whose pending occurrence was deleted", async () => {
    const driver = new MemoryDriver();
    const namespace = testNamespace();
    const queue = makeQueue(driver, namespace);

    await queue.add("fragile", {}, { repeat: { every: 30 } });
    const [before] = await queue.listRepeatables();

    // Something removed the pending job out from under the series.
    await driver.removeJob(queue.ref, before.nextJobId!);
    expect(await queue.getJob(before.nextJobId!)).toBeNull();

    const worker = new BunQueueWorker("repeats", async () => null, {
      namespace,
      driver,
      logger: noopLogger,
      pollInterval: 10,
    });
    closers.push(() => worker.close({ force: true }));

    // A worker's maintenance sweep runs on startup, which is when a series
    // is most likely to need repairing, and notices the gap.
    void worker.run();

    await waitFor(
      async () => {
        const [after] = await queue.listRepeatables();
        return after?.nextJobId !== before.nextJobId;
      },
      { timeout: 10_000, message: "the series was never healed" },
    );
  });

  it("refuses a repeat with neither cron nor every", async () => {
    const queue = makeQueue(new MemoryDriver(), testNamespace());

    await expect(queue.add("nonsense", {}, { repeat: {} })).rejects.toThrow(
      ConfigError,
    );
  });
});
