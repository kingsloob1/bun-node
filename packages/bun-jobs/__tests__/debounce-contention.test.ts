import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueue, DriverError, FileDriver, MemoryDriver } from "../lib/index";
import { makeTmpDir, testNamespace } from "./helpers";

/**
 * A debounced add must update the pending job, not replace it, even when the
 * driver fails to reach that job on the first try.
 *
 * `updateJob` answers `null` for a job that has started or is gone. The file
 * driver used to answer it too when another process held the job's marker for
 * longer than it waited, and under load three back-to-back debounced adds
 * produced three jobs; it now throws a `DriverError` instead. A custom driver
 * may still answer `null` for a job it could not reach, and a driver stub
 * makes that kind of `null` deterministic here.
 */

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
  cleanups.length = 0;
});

const queues: BunQueue<any, any>[] = [];

afterEach(async () => {
  await Promise.allSettled(queues.map(async (queue) => await queue.close()));
  queues.length = 0;
});

describe("debounce under contention", () => {
  it("updates the pending job when an update misses it without it having started", async () => {
    const driver = new MemoryDriver();
    const updateJob = driver.updateJob.bind(driver);
    let missed = 0;

    // The first update after the job exists fails to reach it, as a held
    // marker would make it; the job itself is untouched and still delayed.
    driver.updateJob = async (...args: Parameters<typeof updateJob>) => {
      if (missed === 0) {
        missed++;
        return null;
      }
      return await updateJob(...args);
    };

    const queue = new BunQueue<{ n: number }>("docs", {
      namespace: testNamespace(),
      driver,
      logger: noopLogger,
    });
    queues.push(queue);

    const debounce = { id: "doc-7", ttl: 5_000 };
    const first = await queue.add("save", { n: 1 }, { debounce });
    const second = await queue.add("save", { n: 2 }, { debounce });
    const third = await queue.add("save", { n: 3 }, { debounce });

    expect(missed).toBe(1);
    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);

    // One pending job, carrying the last add's data.
    expect(
      (await queue.count("delayed")) + (await queue.count("waiting")),
    ).toBe(1);
    expect((await queue.getJob(first.id))?.data).toEqual({ n: 3 });
  });

  /**
   * On the file driver a marker another change keeps held is a `DriverError`,
   * not a `null`: the add fails, and the window is left with the job it has,
   * rather than moved to a second one while the first is still pending.
   */
  it("fails the add, and keeps one job, when the pending job's marker stays held", async () => {
    const { mkdir, readdir, rename } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const tmp = await makeTmpDir("bun-jobs-debounce-held");
    cleanups.push(tmp.cleanup);

    const namespace = testNamespace();
    const queue = new BunQueue<{ n: number }>("docs", {
      namespace,
      driver: new FileDriver({ root: tmp.path }),
      logger: noopLogger,
    });
    queues.push(queue);

    const debounce = { id: "doc-8", ttl: 60_000 };
    const first = await queue.add("save", { n: 1 }, { debounce });
    expect(first.state).toBe("delayed");

    // Held the way another process's change holds it, stamped ahead so that
    // healing never takes it for a dead holder's.
    const dir = join(tmp.path, namespace, "queues", "docs");
    const index = join(dir, "index", "delayed");
    // The queue's only job, so its only marker; the name encodes the id.
    const markers = await readdir(index);
    expect(markers).toHaveLength(1);
    const marker = markers[0]!;
    const held = join(dir, "held", `${Date.now() + 60_000}.delayed.${marker}`);
    await mkdir(join(dir, "held"), { recursive: true });
    await rename(join(index, marker), held);

    const error = await queue.add("save", { n: 2 }, { debounce }).then(
      (job) => job,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DriverError);
    expect(error).toMatchObject({ operation: "updateJob" });

    // Let go, and the next add debounces into the same job.
    await rename(held, join(index, marker));
    const third = await queue.add("save", { n: 3 }, { debounce });
    expect(third.id).toBe(first.id);
    expect(
      (await queue.count("delayed")) + (await queue.count("waiting")),
    ).toBe(1);
    expect((await queue.getJob(first.id))?.data).toEqual({ n: 3 });
  }, 30_000);
});
