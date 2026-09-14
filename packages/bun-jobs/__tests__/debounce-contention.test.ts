import { noopLogger } from "@kingsleyweb/bun-common";
import { afterEach, describe, expect, it } from "bun:test";
import { BunQueue, MemoryDriver } from "../lib/index";
import { testNamespace } from "./helpers";

/**
 * A debounced add must update the pending job, not replace it, even when the
 * driver fails to reach that job on the first try.
 *
 * `updateJob` answers `null` for a job that has started or is gone, and also,
 * on the file driver, when another process holds the job's marker for longer
 * than it waits. Under load that happens: three back-to-back debounced adds
 * produced three jobs. A driver stub makes that second kind of `null`
 * deterministic here.
 */

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
});
