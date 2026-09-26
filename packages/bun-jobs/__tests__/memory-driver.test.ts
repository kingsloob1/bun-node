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

describe("memory driver: the active index", () => {
  /**
   * `countDemand` reads `active` and `stalled` from a set of active job ids
   * rather than walking every retained job (8.99 ms against 0.131 ms at
   * 409,064 jobs). A set that misses one way out of `active` goes stale, and
   * `active` then over-counts for good, silently. So every entry and every
   * exit this driver has is driven here, and after each the set's figures are
   * checked against a walk: `countJobs` for `active`, a listing for
   * `stalled`. Each step also asserts the walk moved, so no comparison passes
   * by both sides being zero.
   */
  it("matches a walk after every way into and out of active", async () => {
    const driver = new MemoryDriver();
    const q = { ns: testNamespace("active-index"), queue: "q" };
    const now = Date.now();

    /** The set's figures against the walk's; answers the walk's `active`. */
    const check = async (): Promise<number> => {
      const counts = await driver.countDemand(q, now, { cap: 1_000 });
      const walked = await driver.listJobs(q, ["active"], {
        offset: 0,
        limit: 1_000,
        order: "asc",
      });
      const active = (await driver.countJobs(q)).active;

      expect(counts.active).toBe(active);
      expect(counts.active).toBe(walked.length);
      expect(counts.stalled).toBe(
        walked.filter(
          (job) => job.lockExpiresAt !== null && job.lockExpiresAt <= now,
        ).length,
      );
      return active;
    };

    /** Adds `id` and claims it, lapsed at `now` unless `live`. */
    const claim = async (id: string, live = false): Promise<string> => {
      const token = newToken();
      await driver.addJob(q, makeJob({ id, runAt: now - 120_000 }));
      const claimed = await driver.claimJob(q, {
        workerId: "w",
        token,
        lockMs: live ? 120_000 : 1_000,
        now: now - 60_000,
      });
      expect(claimed?.id).toBe(id);
      return token;
    };

    /** Runs `step`, then checks the set moved by `delta` with the walk. */
    const expectStep = async (
      delta: number,
      step: () => Promise<unknown>,
    ): Promise<void> => {
      const before = await check();
      await step();
      expect(await check()).toBe(before + delta);
    };

    // In: a claim, and a record added already active (with and without a lock).
    const tokens: Record<string, string> = {};
    for (const id of [
      "complete",
      "complete-removed",
      "retry",
      "dead",
      "dead-removed",
      "bury",
      "bury-removed",
      "recover",
      "recover-dead",
    ]) {
      await expectStep(1, async () => {
        tokens[id] = await claim(id, id === "complete");
      });
    }
    await expectStep(1, async () => {
      await driver.addJob(
        q,
        makeJob({
          id: "added-active",
          state: "active",
          lockToken: "t",
          lockExpiresAt: now - 1,
          expiresAt: now - 1,
        }),
      );
    });
    await expectStep(1, async () => {
      await driver.addJob(
        q,
        makeJob({ id: "lockless", state: "active", lockExpiresAt: null }),
      );
    });

    // Out: settled, kept or removed by retention.
    await expectStep(-1, async () => {
      await driver.completeJob(
        q,
        "complete",
        tokens.complete!,
        null,
        false,
        now,
      );
    });
    await expectStep(-1, async () => {
      await driver.completeJob(
        q,
        "complete-removed",
        tokens["complete-removed"]!,
        null,
        true,
        now,
      );
    });
    expect(await driver.getJob(q, "complete-removed")).toBeNull();

    // Out: failed, to a retry, to dead, and to dead then removed.
    const error = { name: "Error", message: "boom" };
    await expectStep(-1, async () => {
      await driver.failJob(
        q,
        "retry",
        tokens.retry!,
        error,
        { retry: true, runAt: now + 1_000 },
        now,
        5,
      );
    });
    await expectStep(-1, async () => {
      await driver.failJob(
        q,
        "dead",
        tokens.dead!,
        error,
        { retry: false, retention: false },
        now,
        5,
      );
    });
    await expectStep(-1, async () => {
      await driver.failJob(
        q,
        "dead-removed",
        tokens["dead-removed"]!,
        error,
        { retry: false, retention: true },
        now,
        5,
      );
    });
    expect(await driver.getJob(q, "dead-removed")).toBeNull();

    // Out: buried from outside the processor, kept and removed.
    await expectStep(-1, async () => {
      await driver.buryJob(
        q,
        "bury",
        error,
        { retention: false, keepStacktraces: 5, token: tokens.bury! },
        now,
      );
    });
    await expectStep(-1, async () => {
      await driver.buryJob(
        q,
        "bury-removed",
        error,
        { retention: true, keepStacktraces: 5, token: tokens["bury-removed"]! },
        now,
      );
    });

    // Out: recovered by the stalled sweep, to waiting and to dead.
    await expectStep(-1, () => driver.recoverStalled(q, now, 5, 1));
    await expectStep(-1, () => driver.recoverStalled(q, now, 0, 1));

    // Out: removed while active, by its retention TTL.
    await expectStep(-1, async () => {
      expect(await driver.pruneExpired(q, now, 10)).toBe(1);
    });
    expect(await driver.getJob(q, "added-active")).toBeNull();

    // What is left is the lockless job, which no sweep here recovers.
    expect(await check()).toBe(1);

    // Out: the whole namespace purged, and the queue read afresh.
    await driver.purge(q.ns);
    expect(await driver.countDemand(q, now, { cap: 1_000 })).toMatchObject({
      active: 0,
      stalled: 0,
    });
    expect(await check()).toBe(0);
  });
});
