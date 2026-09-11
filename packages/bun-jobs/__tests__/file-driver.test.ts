import { afterAll, describe, expect, it } from "bun:test";
import { FileDriver } from "../lib/index";
import { makeJob, makeTmpDir, testNamespace } from "./helpers";
import { driverContract } from "./helpers/driverContract";

/**
 * The file driver against the shared contract, plus the guarantees that are
 * specific to a filesystem: markers healing after a crash, and one directory
 * per namespace.
 */

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

driverContract("file", async () => {
  const tmp = await makeTmpDir("bun-jobs-contract");
  cleanups.push(tmp.cleanup);
  return { driver: new FileDriver({ root: tmp.path }) };
});

describe("file driver: filesystem specifics", () => {
  it("heals an index marker whose record is gone", async () => {
    const tmp = await makeTmpDir("bun-jobs-heal");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();

    const q = { ns: testNamespace(), queue: "healing" };
    const now = Date.now();
    await driver.addJob(q, makeJob({ id: "ghost", runAt: now }));

    // Simulate a crash between the record write and the marker write by
    // deleting the record out from under the index.
    const { rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await rm(join(tmp.path, q.ns, "queues", q.queue, "jobs", "ghost.json"));

    // The claim must skip and clean up rather than hand out a broken job.
    expect(
      await driver.claimJob(q, {
        workerId: "w1",
        token: "t1",
        lockMs: 1000,
        now,
      }),
    ).toBeNull();
    expect((await driver.countJobs(q)).waiting).toBe(0);

    await driver.close();
  });

  it("gives each namespace its own directory", async () => {
    const tmp = await makeTmpDir("bun-jobs-ns");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();

    const first = testNamespace("alpha");
    const second = testNamespace("beta");
    await driver.addJob({ ns: first, queue: "shared" }, makeJob({ id: "x" }));
    await driver.addJob({ ns: second, queue: "shared" }, makeJob({ id: "x" }));

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(tmp.path);
    expect(entries).toContain(first);
    expect(entries).toContain(second);

    await driver.purge(first);
    expect(await readdir(tmp.path)).not.toContain(first);
    expect(
      await driver.getJob({ ns: second, queue: "shared" }, "x"),
    ).not.toBeNull();

    await driver.close();
  });

  it("keeps claim order across a restart", async () => {
    const tmp = await makeTmpDir("bun-jobs-order");
    cleanups.push(tmp.cleanup);

    const ns = testNamespace();
    const q = { ns, queue: "ordered" };
    const now = Date.now();

    const first = new FileDriver({ root: tmp.path });
    await first.connect();
    await first.addJobs(q, [
      makeJob({ id: "a", priority: 0, createdAt: now, runAt: now }),
      makeJob({ id: "b", priority: -1, createdAt: now + 1, runAt: now }),
      makeJob({ id: "c", priority: 0, createdAt: now + 2, runAt: now }),
    ]);
    await first.close();

    // A different instance — a restarted process — sees the same order,
    // because the order lives in the index file names.
    const second = new FileDriver({ root: tmp.path });
    await second.connect();

    const claimed: string[] = [];
    for (let i = 0; i < 3; i++) {
      const job = await second.claimJob(q, {
        workerId: "w",
        token: `t${i}`,
        lockMs: 5000,
        now,
      });
      if (job) {
        claimed.push(job.id);
      }
    }

    expect(claimed).toEqual(["b", "a", "c"]);
    await second.close();
  });
});

describe("file driver: promotion racing a claim", () => {
  /**
   * A job must survive being promoted while someone else is claiming.
   *
   * Promotion has two steps — move the marker out of `failed` into `waiting`,
   * and rewrite the record — and between them the marker says `waiting` while
   * the record still says `failed`. That is indistinguishable from the litter
   * a crash leaves behind, and claiming used to delete such a marker. The
   * record itself was untouched, so the job ended up in no index at all: gone,
   * silently, with no error anywhere.
   *
   * The cross-process retry suite found this as jobs that never completed, and
   * spent 45 seconds timing out on each before saying so.
   *
   * The half-promoted state is built directly rather than raced for, because a
   * race that reproduces once in twenty runs is not a regression test.
   */
  it("does not delete the marker of a half-promoted job", async () => {
    const tmp = await makeTmpDir("bun-jobs-race");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();
    const q = { ns: testNamespace(), queue: "raced" };
    const now = Date.now();

    // A job mid-retry: failed, with its backoff already elapsed.
    await driver.addJob(
      q,
      makeJob({ id: "mid", state: "failed", runAt: now - 1000 }),
    );

    const { readdir, rename } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const index = join(tmp.path, q.ns, "queues", q.queue, "index");

    // Step one of a promotion, and only step one.
    const [marker] = await readdir(join(index, "failed"));
    await rename(
      join(index, "failed", marker!),
      join(index, "waiting", marker!),
    );

    // The claim heals it forward rather than skipping it: the record's time
    // has come, so the only thing between it and `waiting` was a write this
    // claim is about to make anyway.
    const claimed = await driver.claimJob(q, {
      workerId: "w1",
      token: "t1",
      lockMs: 5000,
      now,
    });

    expect(claimed?.id).toBe("mid");

    // And the marker moved on to `active` rather than being deleted, which is
    // what used to strand the record in no index at all.
    expect(await readdir(join(index, "waiting"))).toEqual([]);
    expect((await readdir(join(index, "active"))).length).toBe(1);
    expect((await driver.countJobs(q)).active).toBe(1);

    await driver.purge(q.ns);
    await driver.close();
  });
});

describe("file driver: waiting for work that is already there", () => {
  /**
   * A job added before the wait starts must not cost a full poll interval.
   *
   * `waitForJob` watches a `wake` file for a change, and the snapshot it
   * compares against is taken when the wait begins. A job that lands between a
   * claim coming back empty and the wait starting has already touched `wake`,
   * so the snapshot is of the *new* value and nothing changes it again — the
   * worker then sleeps out its whole budget with a claimable job sitting in
   * the queue.
   *
   * That is the round-trip p90 of 1001ms against a p50 of 1.69ms: a lost
   * wakeup, and `DEFAULT_POLL_INTERVAL` is exactly 1,000ms.
   */
  it("returns at once when a job is already waiting", async () => {
    const tmp = await makeTmpDir("bun-jobs-wake");
    const driver = new FileDriver({ root: tmp.path });

    try {
      const q = { ns: testNamespace(), queue: "already-there" };
      await driver.ensureQueue(q);

      // Exactly the order that loses the wakeup: the job lands, touching
      // `wake`, and only then does anybody wait.
      await driver.addJob(q, makeJob({ id: "present" }));

      const started = performance.now();
      await driver.waitForJob(q, 1_000);
      const waited = performance.now() - started;

      // Generous, because the point is the difference between "noticed" and
      // "slept the whole budget", not a precise timing.
      expect(waited).toBeLessThan(250);
    } finally {
      await driver.close();
      await tmp.cleanup();
    }
  }, 15_000);
});
