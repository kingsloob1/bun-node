import type { QueueRef, Retention } from "../lib/drivers/driver";
import type { JobRecord } from "../lib/index";
import { describe, expect, it } from "bun:test";
import { MemoryDriver } from "../lib/drivers/memory-driver";
import { makeJob, testNamespace } from "./helpers";

/**
 * C10/C11 on the memory driver: count retention reads a per-state index
 * instead of sorting every job on every finish, promotion and `nextDelayedAt`
 * read a heap instead of walking every job, `waitForJob` asks the waiting
 * index, and removing a job no longer scans the waiting index unless it was
 * waiting. These pin that the indexes answer exactly what the scans did.
 */

/** A fresh driver and queue. */
function setup(name: string) {
  const driver = new MemoryDriver();
  const q: QueueRef = { ns: testNamespace(`fixmem-${name}`), queue: "q" };
  return { driver, q };
}

/** Adds, claims and completes one job at `at` with a count retention. */
async function complete(
  driver: MemoryDriver,
  q: QueueRef,
  id: string,
  at: number,
  keep: Retention,
  extra: Partial<JobRecord> = {},
): Promise<void> {
  await driver.addJob(q, makeJob({ id, createdAt: 1, runAt: 1, ...extra }));
  const claimed = await driver.claimJob(q, {
    workerId: "w",
    token: id,
    lockMs: 60_000,
    now: at,
  });
  expect(claimed?.id).toBe(id);
  expect(await driver.completeJob(q, id, id, null, keep, at)).toBe(true);
}

/** The ids stored in `state`, sorted. */
async function idsIn(
  driver: MemoryDriver,
  q: QueueRef,
  state: JobRecord["state"],
): Promise<string[]> {
  const jobs = await driver.listJobs(q, [state], {
    offset: 0,
    limit: 1_000,
    order: "asc",
  });
  return jobs.map((job) => job.id).sort();
}

describe("memory count retention index (C10)", () => {
  it("keeps the newest by finish time, whatever order they finish in", async () => {
    const { driver, q } = setup("retain-order");

    await complete(driver, q, "a", 100, 2);
    await complete(driver, q, "b", 300, 2);
    await complete(driver, q, "c", 200, 2); // a goes
    expect(await idsIn(driver, q, "completed")).toEqual(["b", "c"]);

    // At an equal time the earlier added is the one kept — the old stable
    // newest-first sort's order — so d pushes out c, and e itself goes.
    await complete(driver, q, "d", 300, 2);
    expect(await idsIn(driver, q, "completed")).toEqual(["b", "d"]);
    await complete(driver, q, "e", 300, 2);
    expect(await idsIn(driver, q, "completed")).toEqual(["b", "d"]);

    // A later finish is kept and pushes out the later added of the two at 300.
    await complete(driver, q, "f", 400, 2);
    expect(await idsIn(driver, q, "completed")).toEqual(["b", "f"]);
  });

  it("counts only the finished state, never the backlog or the other state", async () => {
    const { driver, q } = setup("retain-state");

    for (let index = 0; index < 5; index++) {
      await driver.addJob(q, makeJob({ id: `w${index}`, priority: 9 }));
    }
    const token = "t";
    await driver.addJob(q, makeJob({ id: "x", priority: 0, runAt: 1 }));
    await driver.claimJob(q, { workerId: "w", token, lockMs: 60_000, now: 5 });
    await driver.failJob(
      q,
      "x",
      token,
      { name: "Error", message: "no" },
      { retry: false, retention: 1 },
      5,
      0,
    );

    await complete(driver, q, "c1", 10, 1, { priority: 0 });
    await complete(driver, q, "c2", 20, 1, { priority: 0 });

    expect(await idsIn(driver, q, "completed")).toEqual(["c2"]);
    expect(await idsIn(driver, q, "dead")).toEqual(["x"]);
    expect((await idsIn(driver, q, "waiting")).length).toBe(5);
  });

  it("keeps a child whose parent has not taken its outcome, and trims past it", async () => {
    const { driver, q } = setup("retain-flow");
    const child = {
      flow: {
        parent: { queue: "parents", id: "p" },
        children: [],
        pending: 0,
        values: {},
        failures: {},
        recorded: false,
      },
    } as Partial<JobRecord>;

    await complete(driver, q, "child", 10, 1, child);
    await complete(driver, q, "b", 20, 1);
    await complete(driver, q, "c", 30, 1);

    // The child stays although it is past the count; b does not.
    expect(await idsIn(driver, q, "completed")).toEqual(["c", "child"]);

    // Once delivered, the next trim takes it.
    await driver.markChildRecorded(q, "child", 1, 40);
    expect(await idsIn(driver, q, "completed")).toEqual(["c"]);
  });

  it("forgets a job retried out of the state", async () => {
    const { driver, q } = setup("retain-retry");

    await complete(driver, q, "a", 10, 5);
    await complete(driver, q, "b", 20, 5);
    expect(await driver.retryJob(q, "a", false, 25)).toBe(true);
    // a is waiting again: it must not be counted, nor removed, as completed.
    // Created earlier than a, so it is claimed ahead of the retried a.
    await complete(driver, q, "c", 30, 1, { createdAt: 0 });

    expect(await idsIn(driver, q, "completed")).toEqual(["c"]);
    expect((await driver.getJob(q, "a"))?.state).toBe("waiting");
  });
});

describe("memory promotion heap (C10) and idle reads (C11)", () => {
  it("promotes only what is due, earliest first, within the limit", async () => {
    const { driver, q } = setup("promote");

    for (const [id, runAt] of [
      ["late", 5_000],
      ["due2", 200],
      ["due1", 100],
      ["due3", 300],
    ] as const) {
      await driver.addJob(q, makeJob({ id, state: "delayed", runAt }));
    }

    expect(await driver.nextDelayedAt(q)).toBe(100);
    expect((await driver.promoteDelayed(q, 1_000, 2)).promoted).toBe(2);
    expect(await idsIn(driver, q, "waiting")).toEqual(["due1", "due2"]);
    expect(await driver.nextDelayedAt(q)).toBe(300);
    expect((await driver.promoteDelayed(q, 1_000, 10)).promoted).toBe(1);
    expect(await driver.nextDelayedAt(q)).toBe(5_000);
    expect((await driver.promoteDelayed(q, 1_000, 10)).promoted).toBe(0);
  });

  it("follows runAt changes, removals and retries", async () => {
    const { driver, q } = setup("promote-change");

    await driver.addJob(q, makeJob({ id: "a", state: "delayed", runAt: 500 }));
    await driver.addJob(q, makeJob({ id: "b", state: "delayed", runAt: 900 }));

    // Earlier while staying delayed: seen at the new time.
    await driver.updateJob(q, "b", { runAt: 400 }, 0);
    expect(await driver.nextDelayedAt(q)).toBe(400);
    // Later while staying delayed: not promoted at the old time.
    await driver.updateJob(q, "a", { runAt: 2_000 }, 0);
    expect((await driver.promoteDelayed(q, 600, 10)).promoted).toBe(1);
    expect(await idsIn(driver, q, "waiting")).toEqual(["b"]);
    expect(await driver.nextDelayedAt(q)).toBe(2_000);

    expect(await driver.removeJob(q, "a")).toBe(true);
    expect(await driver.nextDelayedAt(q)).toBeNull();

    // A retried failure is scheduled at its retry time.
    await driver.claimJob(q, {
      workerId: "w",
      token: "t",
      lockMs: 1,
      now: 700,
    });
    await driver.failJob(
      q,
      "b",
      "t",
      { name: "Error", message: "again" },
      { retry: true, runAt: 1_500 },
      700,
      0,
    );
    expect(await driver.nextDelayedAt(q)).toBe(1_500);
    expect((await driver.promoteDelayed(q, 1_499, 10)).promoted).toBe(0);
    expect((await driver.promoteDelayed(q, 1_500, 10)).promoted).toBe(1);
  });

  it("stays right after many scheduled jobs come and go", async () => {
    const { driver, q } = setup("promote-churn");

    for (let index = 0; index < 3_000; index++) {
      await driver.addJob(
        q,
        makeJob({ id: `d${index}`, state: "delayed", runAt: 10 + index }),
      );
    }
    await driver.addJob(
      q,
      makeJob({ id: "keep", state: "delayed", runAt: 99_999 }),
    );
    for (let index = 0; index < 3_000; index++) {
      await driver.removeJob(q, `d${index}`);
    }

    expect(await driver.nextDelayedAt(q)).toBe(99_999);
    expect((await driver.promoteDelayed(q, 100_000, 10)).promoted).toBe(1);
    expect(await driver.nextDelayedAt(q)).toBeNull();
  });

  it("waitForJob returns at once for a due waiting job among many finished", async () => {
    const { driver, q } = setup("wait");

    for (let index = 0; index < 200; index++) {
      await complete(driver, q, `c${index}`, 10, false);
    }
    await driver.addJob(q, makeJob({ id: "live", runAt: Date.now() - 1 }));

    const started = performance.now();
    await driver.waitForJob(q, 2_000);
    expect(performance.now() - started).toBeLessThan(1_000);

    // Paused, nothing is claimable: it waits out the timeout.
    await driver.pauseQueue(q);
    const paused = performance.now();
    await driver.waitForJob(q, 50);
    expect(performance.now() - paused).toBeGreaterThanOrEqual(40);
  });

  it("removing finished jobs leaves the waiting index intact", async () => {
    const { driver, q } = setup("delete-guard");

    for (let index = 0; index < 5; index++) {
      await driver.addJob(q, makeJob({ id: `w${index}`, priority: 5 }));
    }
    for (let index = 0; index < 3; index++) {
      await complete(driver, q, `c${index}`, 10 + index, 10, { priority: 0 });
    }
    for (let index = 0; index < 3; index++) {
      expect(await driver.removeJob(q, `c${index}`)).toBe(true);
    }

    const claimed: string[] = [];
    for (let index = 0; index < 5; index++) {
      const job = await driver.claimJob(q, {
        workerId: "w",
        token: `t${index}`,
        lockMs: 60_000,
        now: Date.now(),
      });
      claimed.push(job?.id ?? "none");
    }
    expect(claimed).toEqual(["w0", "w1", "w2", "w3", "w4"]);
  });
});
