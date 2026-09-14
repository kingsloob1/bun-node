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

describe("file driver: a job changed or logged across a crash", () => {
  /**
   * The contract test sees a forgotten log only when the re-added job happens
   * to read the same file. A removal path that forgot it while the file name
   * differed would leak silently, so this looks at the disk itself.
   */
  it("leaves no log file behind, however the job goes", async () => {
    const tmp = await makeTmpDir("bun-jobs-log-files");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();
    const q = { ns: testNamespace(), queue: "log-files" };
    const now = Date.now();

    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const logs = join(tmp.path, q.ns, "queues", q.queue, "logs");
    const remaining = async () =>
      await readdir(logs).catch(() => [] as string[]);

    /** Adds a logged job, removes it with `remove`, and expects no log file. */
    async function removedWithoutTrace(
      id: string,
      remove: () => Promise<unknown>,
    ) {
      await driver.addJob(q, makeJob({ id, runAt: now }));
      expect(await driver.addJobLog(q, id, `line for ${id}`, 0)).toBe(1);
      expect(await remaining()).toHaveLength(1);

      await remove();

      expect(await driver.getJob(q, id)).toBeNull();
      expect(await remaining()).toEqual([]);
    }

    const claim = async () => {
      const token = `t-${Math.random()}`;
      await driver.claimJob(q, { workerId: "w", token, lockMs: 30_000, now });
      return token;
    };

    await removedWithoutTrace("removed", () => driver.removeJob(q, "removed"));
    await removedWithoutTrace("drained", () => driver.drainQueue(q, true));
    await removedWithoutTrace("completed", async () => {
      await driver.completeJob(q, "completed", await claim(), null, true, now);
    });
    await removedWithoutTrace("dead", async () => {
      await driver.failJob(
        q,
        "dead",
        await claim(),
        { name: "Error", message: "boom" },
        { retry: false, retention: true },
        now,
        1,
      );
    });
    await removedWithoutTrace("cleaned", async () => {
      await driver.completeJob(q, "cleaned", await claim(), null, false, now);
      await driver.cleanJobs(q, "completed", 0, 100, now + 1);
    });
    await removedWithoutTrace("expired", async () => {
      await driver.completeJob(
        q,
        "expired",
        await claim(),
        null,
        { ttl: 1 },
        now,
      );
      await driver.pruneExpired(q, now + 1_000, 100);
    });
    await removedWithoutTrace("capped", async () => {
      await driver.completeJob(q, "capped", await claim(), null, 0, now);
    });

    await driver.purge(q.ns);
    await driver.close();
  });

  /**
   * `updateJob` moves a job's marker out of the index while it rewrites the
   * record. A process that dies holding it must not take the job with it: the
   * hold is filed by whatever the record says once it is old enough to be
   * abandoned.
   */
  it("files a marker held by a process that died", async () => {
    const tmp = await makeTmpDir("bun-jobs-hold");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();
    const q = { ns: testNamespace(), queue: "held" };
    const now = Date.now();
    await driver.addJob(q, makeJob({ id: "orphan", runAt: now }));

    const { mkdir, readdir, rename } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = join(tmp.path, q.ns, "queues", q.queue);
    const [marker] = await readdir(join(dir, "index", "waiting"));

    // A hold taken two seconds ago by a process that never came back.
    await mkdir(join(dir, "held"), { recursive: true });
    await rename(
      join(dir, "index", "waiting", marker!),
      join(dir, "held", `${Date.now() - 2_000}.waiting.${marker}`),
    );
    expect((await driver.countJobs(q)).waiting).toBe(0);

    await driver.recoverStalled(q, now, 1, 100);

    expect(await readdir(join(dir, "held"))).toEqual([]);
    const claimed = await driver.claimJob(q, {
      workerId: "w",
      token: "t",
      lockMs: 30_000,
      now,
    });
    expect(claimed?.id).toBe("orphan");

    await driver.purge(q.ns);
    await driver.close();
  });

  /**
   * A claim renames the marker into `active` before it writes the record, so
   * a crash between the two leaves an active marker over a waiting record.
   * Once the lock that claim would have held expires, the job goes back.
   */
  it("returns a job whose claim died before writing the record", async () => {
    const tmp = await makeTmpDir("bun-jobs-half-claim");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();
    const q = { ns: testNamespace(), queue: "half-claimed" };
    const now = Date.now();
    await driver.addJob(q, makeJob({ id: "half", runAt: now }));

    const { readdir, rename } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const index = join(tmp.path, q.ns, "queues", q.queue, "index");
    const [marker] = await readdir(join(index, "waiting"));

    // Step one of a claim with a 1s lock, and only step one.
    await rename(
      join(index, "waiting", marker!),
      join(index, "active", `${String(now + 1_000).padStart(13, "0")}-half`),
    );

    // Not while the lock could still be live...
    await driver.recoverStalled(q, now, 1, 100);
    expect((await driver.countJobs(q)).active).toBe(1);

    // ...but once it has expired, the marker goes back where the record says.
    await driver.recoverStalled(q, now + 2_000, 1, 100);
    expect(await driver.countJobs(q)).toMatchObject({ waiting: 1, active: 0 });
    expect(
      (
        await driver.claimJob(q, {
          workerId: "w",
          token: "t",
          lockMs: 30_000,
          now,
        })
      )?.id,
    ).toBe("half");

    await driver.purge(q.ns);
    await driver.close();
  });

  it("lets a completion through while its job is being patched", async () => {
    const tmp = await makeTmpDir("bun-jobs-patch-active");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();
    const q = { ns: testNamespace(), queue: "patched-active" };
    const now = Date.now();
    await driver.addJob(q, makeJob({ id: "busy", runAt: now, data: { v: 1 } }));
    const claimed = await driver.claimJob(q, {
      workerId: "w",
      token: "t",
      lockMs: 30_000,
      now,
    });
    expect(claimed?.id).toBe("busy");

    // Many patches racing one completion: the completion must succeed rather
    // than read a held or renamed marker as a lost lock, and the job must end
    // up completed with its marker in `completed`.
    const patches = Array.from({ length: 20 }, async (_, v) => {
      return await driver.updateJob(q, "busy", { data: { v } }, now);
    });
    const [completed] = await Promise.all([
      driver.completeJob(q, "busy", "t", "done", false, now),
      ...patches,
    ]);

    expect(completed).toBe(true);
    expect((await driver.getJob(q, "busy"))?.state).toBe("completed");
    expect(await driver.countJobs(q)).toMatchObject({
      active: 0,
      completed: 1,
    });

    await driver.purge(q.ns);
    await driver.close();
  });
});

describe("file driver: removal and writes racing a patch", () => {
  /** Every path under the queue directory that names `id`. */
  async function traces(
    root: string,
    q: { ns: string; queue: string },
    id: string,
  ) {
    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const entries = await readdir(join(root, q.ns, "queues", q.queue), {
      recursive: true,
    });
    return entries.filter((entry) => entry.includes(id));
  }

  /**
   * A removal used to delete the marker and the record directly. Landing while
   * `updateJob` held the marker, it deleted a record the patch then wrote back:
   * a removed job, returned, with no marker — in no index, and never claimed.
   */
  it("keeps a removed job removed, however many patches race it", async () => {
    const tmp = await makeTmpDir("bun-jobs-remove-race");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();
    const q = { ns: testNamespace(), queue: "remove-race" };
    const now = Date.now();

    for (let round = 0; round < 25; round++) {
      const id = `r${round}x`;
      await driver.addJob(q, makeJob({ id, runAt: now, data: { v: -1 } }));
      await driver.addJobLog(q, id, "before", 0);

      const patch = (v: number) =>
        v % 3 === 0
          ? driver.updateJob(q, id, { runAt: now + 60_000, data: { v } }, now)
          : v % 3 === 1
            ? driver.updateJob(q, id, { priority: v }, now)
            : driver.updateJob(q, id, { runAt: now, data: { v } }, now);

      const racers: Promise<unknown>[] = [];
      let removed: Promise<boolean> | undefined;

      for (let v = 0; v < 30; v++) {
        if (v === 15) {
          removed = driver.removeJob(q, id);
          racers.push(removed);
        }
        racers.push(patch(v), driver.addJobLog(q, id, `line ${v}`, 5));
      }

      await Promise.all(racers);

      expect(await removed).toBe(true);
      expect(await driver.getJob(q, id)).toBeNull();
      // No record, no marker in any index, no hold, no log.
      expect(await traces(tmp.path, q, id)).toEqual([]);
    }

    expect(await driver.countJobs(q)).toMatchObject({ waiting: 0, delayed: 0 });

    await driver.purge(q.ns);
    await driver.close();
  });

  /**
   * `updateProgress` was a read and a write with nothing around it, which was
   * safe while nothing else rewrote an active record. `updateJob` does, and
   * each could write the other's change away.
   */
  it("loses neither a progress report nor a patch that races it", async () => {
    const tmp = await makeTmpDir("bun-jobs-progress-race");
    cleanups.push(tmp.cleanup);

    const driver = new FileDriver({ root: tmp.path });
    await driver.connect();
    const q = { ns: testNamespace(), queue: "progress-race" };
    const now = Date.now();
    await driver.addJob(q, makeJob({ id: "busy", runAt: now }));
    await driver.claimJob(q, {
      workerId: "w",
      token: "t",
      lockMs: 30_000,
      now,
    });

    for (let round = 0; round < 30; round++) {
      const [progressed, patched] = await Promise.all([
        driver.updateProgress(q, "busy", { round }),
        driver.updateJob(q, "busy", { data: { round } }, now),
      ]);
      expect(progressed).toBe(true);
      expect(patched).not.toBeNull();

      const job = await driver.getJob(q, "busy");
      expect(job?.progress).toEqual({ round });
      expect(job?.data).toEqual({ round });
    }

    // And the marker still agrees with the record, so the holder can finish.
    expect(await driver.completeJob(q, "busy", "t", null, false, now)).toBe(
      true,
    );
    expect(await driver.countJobs(q)).toMatchObject({
      active: 0,
      completed: 1,
    });

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
