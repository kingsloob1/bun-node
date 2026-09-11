import { describe, expect, it } from "bun:test";
import { MemoryDriver, newToken } from "../lib/index";
import { makeJob, testNamespace } from "./helpers";
import { driverContract } from "./helpers/driverContract";

/**
 * The memory driver against the shared contract. It is the reference
 * implementation, so a failure here is a bug in the contract's expectations
 * as often as in the driver.
 */
driverContract("memory", async () => ({ driver: new MemoryDriver() }));

describe("memory driver: the waiting index", () => {
  /**
   * Claiming reads a maintained index rather than sorting every job, which is
   * what took the claim from 0.308ms at a backlog of 5,000 to 0.002ms. The
   * index is only correct while every state change goes through one setter,
   * and the failure mode if one does not is silent: a job that is simply never
   * claimed, or claimed out of order.
   *
   * So this drives every transition the driver has and then checks the claim
   * order against the definition — priority, then age, then insertion — worked
   * out independently.
   */
  it("stays in claim order through every transition", async () => {
    const driver = new MemoryDriver();
    const q = { ns: testNamespace(), queue: "index" };
    await driver.ensureQueue(q);

    const now = Date.now();
    const claim = async () =>
      await driver.claimJob(q, {
        now: Date.now() + 60_000,
        token: newToken(),
        workerId: "w",
        lockMs: 30_000,
      });

    // A spread of priorities and ages, added out of order on purpose.
    for (const [id, priority, age] of [
      ["c", 0, 2],
      ["a", -5, 3],
      ["e", 5, 0],
      ["b", -5, 9],
      ["d", 0, 7],
    ] as const) {
      await driver.addJob(
        q,
        makeJob({ id, priority, createdAt: now + age, runAt: now }),
      );
    }

    // Delayed and failed jobs that become claimable only once promoted.
    await driver.addJob(
      q,
      makeJob({
        id: "later",
        state: "delayed",
        runAt: now + 30_000,
        // Stated rather than defaulted: this test is about ordering, so the
        // key it is ordered by should not come from the wall clock.
        createdAt: now + 5,
        priority: 0,
      }),
    );

    // Churn: claim, complete, fail-with-retry, remove, retry — every path that
    // moves a job in or out of `waiting`.
    const first = await claim();
    expect(first?.id).toBe("a");
    await driver.completeJob(
      q,
      "a",
      first!.lockToken!,
      null,
      false,
      Date.now(),
    );

    const second = await claim();
    expect(second?.id).toBe("b");
    await driver.failJob(
      q,
      "b",
      second!.lockToken!,
      { name: "E", message: "x" },
      { retry: true, runAt: Date.now() },
      Date.now(),
      1,
    );

    await driver.removeJob(q, "d");
    await driver.promoteDelayed(q, Date.now() + 60_000, 100);

    // What is left, in the order the comparator defines it.
    const drained: string[] = [];
    for (;;) {
      const job = await claim();
      if (!job) break;
      drained.push(job.id);
      await driver.completeJob(
        q,
        job.id,
        job.lockToken!,
        null,
        true,
        Date.now(),
      );
    }

    // `b` was retried so it is claimable again; `d` was removed; `a` is done.
    // Priority orders the rest: `b` (-5) before `c` (0) before `e` (5), with
    // `later` promoted to priority 0 and ordered against `c` by age.
    expect(drained).toEqual(["b", "c", "later", "e"]);
    await driver.close();
  });
});
