import type { ClaimOptions, JobRecord, QueueRef } from "../lib/drivers/driver";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { claimJobBatch } from "../lib/drivers/claimBatch";
import { encodeName, encodeSegment } from "../lib/drivers/file-names";
import { FileDriver } from "../lib/index";
import { makeJob, makeTmpDir, testNamespace } from "./helpers";

/**
 * The file driver's fix-round optimisations (2026-09-22), each held to the
 * behaviour it must not change:
 *
 * - directories are made on `ENOENT` rather than before every write, so one
 *   deleted underneath a running driver has to come back by itself;
 * - the wake file is touched with `utimes`, and must still change on every
 *   wake, however close together;
 * - `claimJobs` claims a batch off one listing;
 * - `removeOnComplete: true` deletes without writing `completed` first;
 * - `addJobs` creates side by side, with one wake;
 * - `promoteDelayed` sorts only the due names, and `pruneExpired` skips
 *   records it lately found not due;
 * - `addJobLog` counts from memory when the log is the one it last wrote.
 */

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

/** A connected driver on a fresh directory, and a queue in a fresh namespace. */
async function setup(label: string): Promise<{
  root: string;
  driver: FileDriver;
  q: QueueRef;
  queueDir: string;
}> {
  const tmp = await makeTmpDir(`bun-jobs-fix-file-${label}`);
  cleanups.push(tmp.cleanup);
  const driver = new FileDriver({ root: tmp.path });
  await driver.connect();
  cleanups.push(async () => await driver.close());
  const q = { ns: testNamespace(), queue: label };
  const queueDir = join(
    tmp.path,
    encodeSegment(q.ns),
    "queues",
    encodeSegment(q.queue),
  );
  return { root: tmp.path, driver, q, queueDir };
}

/** Claim options for `token` at `now`. */
function claimAt(now: number, token = "t"): ClaimOptions {
  return { token, lockMs: 60_000, now, workerId: "w" };
}

/** Names in one of the queue's index directories, `[]` when it is absent. */
async function markers(queueDir: string, state: string): Promise<string[]> {
  return await readdir(join(queueDir, "index", state)).catch(() => []);
}

/** A page wide enough for every log line these tests write, oldest first. */
const logPage = { offset: 0, limit: 100, order: "asc" as const };

describe("file driver: directories deleted underneath a running driver", () => {
  it("adds, claims and completes after another instance purged the namespace", async () => {
    const { root, driver, q } = await setup("purged");
    const now = Date.now();

    // Warm: this instance has now made (and remembered) the queue.
    await driver.addJob(q, makeJob({ id: "before", runAt: now }));
    const warm = await driver.claimJob(q, claimAt(now));
    expect(warm?.id).toBe("before");
    expect(await driver.completeJob(q, "before", "t", null, false, now)).toBe(
      true,
    );

    // Another process purges: this instance's memory of the queue is stale.
    const other = new FileDriver({ root });
    await other.purge(q.ns);

    expect(
      (await driver.addJob(q, makeJob({ id: "after", runAt: now }))).added,
    ).toBe(true);
    const claimed = await driver.claimJob(q, claimAt(now));
    expect(claimed?.id).toBe("after");
    expect(await driver.extendJobLock(q, "after", "t", 120_000, now + 1)).toBe(
      true,
    );
    expect(await driver.updateProgress(q, "after", 50)).toBe(true);
    expect(await driver.addJobLog(q, "after", "hello", 0)).toBe(1);
    expect(await driver.completeJob(q, "after", "t", "ok", false, now)).toBe(
      true,
    );
    expect((await driver.getJob(q, "after"))?.state).toBe("completed");
    expect((await driver.countJobs(q)).completed).toBe(1);
  });

  it("claims when only `index/active` is missing", async () => {
    const { driver, q, queueDir } = await setup("no-active");
    const now = Date.now();
    await driver.addJob(q, makeJob({ id: "warm", runAt: now }));
    await driver.claimJob(q, claimAt(now));
    await driver.completeJob(q, "warm", "t", null, true, now);

    await driver.addJob(q, makeJob({ id: "job", runAt: now }));
    await rm(join(queueDir, "index", "active"), { recursive: true });

    // Batch and single alike: the rename into `active/` makes the directory.
    const [claimed] = await claimJobBatch(driver, q, claimAt(now), 4);
    expect(claimed?.id).toBe("job");
    expect(await markers(queueDir, "active")).toHaveLength(1);
  });

  it("settles when the target state's directory is missing", async () => {
    const { driver, q, queueDir } = await setup("no-target");
    const now = Date.now();
    await driver.addJobs(q, [
      makeJob({ id: "done", runAt: now }),
      makeJob({ id: "failed", runAt: now, createdAt: now + 1 }),
    ]);
    await driver.claimJobs(q, claimAt(now), 2);

    await rm(join(queueDir, "index", "completed"), { recursive: true });
    await rm(join(queueDir, "index", "failed"), { recursive: true });

    expect(await driver.completeJob(q, "done", "t", null, false, now)).toBe(
      true,
    );
    expect(
      await driver.failJob(
        q,
        "failed",
        "t",
        { name: "Error", message: "boom" },
        { retry: true, runAt: now + 60_000 },
        now,
        5,
      ),
    ).toBe(true);
    expect(await markers(queueDir, "completed")).toHaveLength(1);
    expect(await markers(queueDir, "failed")).toHaveLength(1);
  });

  it("adds when `jobs/` is missing, and publishes when the queue is gone", async () => {
    const { driver, q, queueDir } = await setup("no-jobs");
    const now = Date.now();
    await driver.addJob(q, makeJob({ id: "warm", runAt: now }));
    await rm(join(queueDir, "jobs"), { recursive: true });

    expect(
      (await driver.addJob(q, makeJob({ id: "job", runAt: now }))).added,
    ).toBe(true);
    expect((await driver.getJob(q, "job"))?.id).toBe("job");

    await rm(queueDir, { recursive: true });
    await driver.publish({
      ns: q.ns,
      kind: "queue",
      target: q.queue,
      type: "added",
      jobId: "x",
      at: now,
    } as never);
    const log = await readFile(join(queueDir, "events.jsonl"), "utf8");
    expect(log.split("\n").filter(Boolean)).toHaveLength(1);
  });
});

describe("file driver: the wake file", () => {
  it("changes on every wake, however close together", async () => {
    const { driver, q, queueDir } = await setup("wake");
    const wake = join(queueDir, "wake");
    const now = Date.now();
    const seen = new Set<number>();

    for (let i = 0; i < 20; i++) {
      await driver.addJob(q, makeJob({ id: `w${i}`, runAt: now }));
      seen.add((await stat(wake)).mtimeMs);
    }

    // Twenty adds inside a few milliseconds: each one a distinct change.
    expect(seen.size).toBe(20);
  });

  it("wakes a waiting instance when another adds", async () => {
    const { root, driver, q } = await setup("wake-cross");
    const producer = new FileDriver({ root });
    await driver.addJob(q, makeJob({ id: "first", runAt: Date.now() }));
    await driver.claimJob(q, claimAt(Date.now()));

    const started = performance.now();
    const waited = driver.waitForJob(q, 5_000);
    await Bun.sleep(30);
    await producer.addJob(q, makeJob({ id: "second", runAt: Date.now() }));
    await waited;

    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("file driver: claimJobs", () => {
  it("claims a batch in claim order, each job once across two instances", async () => {
    const { root, driver, q } = await setup("claim-batch");
    const other = new FileDriver({ root });
    const now = Date.now();
    const jobs: JobRecord[] = [];

    for (let i = 0; i < 40; i++) {
      jobs.push(
        makeJob({
          id: `j${String(i).padStart(2, "0")}`,
          priority: i % 3 === 0 ? -1 : 0,
          createdAt: now + i,
          runAt: now,
        }),
      );
    }
    await driver.addJobs(q, jobs);

    const first = await driver.claimJobs(q, claimAt(now, "a"), 7);
    expect(first).toHaveLength(7);
    // Priority first (the `-1`s), then creation order.
    const expected = jobs
      .toSorted((a, b) => a.priority - b.priority || a.createdAt - b.createdAt)
      .map((job) => job.id);
    expect(first.map((job) => job.id)).toEqual(expected.slice(0, 7));
    expect(first.every((job) => job.state === "active")).toBe(true);
    expect(first.every((job) => job.lockToken === "a")).toBe(true);

    const [x, y] = await Promise.all([
      driver.claimJobs(q, claimAt(now, "b"), 50),
      other.claimJobs(q, claimAt(now, "c"), 50),
    ]);
    const ids = [...first, ...x, ...y].map((job) => job.id);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
    expect(await driver.claimJobs(q, claimAt(now), 5)).toEqual([]);
  });

  it("honours pause, due time and excluded names", async () => {
    const { driver, q } = await setup("claim-batch-rules");
    const now = Date.now();
    await driver.addJobs(q, [
      makeJob({ id: "a", name: "capped", runAt: now, createdAt: now }),
      makeJob({ id: "b", name: "free", runAt: now, createdAt: now + 1 }),
      makeJob({
        id: "later",
        name: "free",
        state: "delayed",
        runAt: now + 60_000,
        createdAt: now + 2,
      }),
    ]);

    await driver.pauseQueue(q);
    expect(await driver.claimJobs(q, claimAt(now), 5)).toEqual([]);
    await driver.resumeQueue(q);

    const claimed = await driver.claimJobs(
      q,
      { ...claimAt(now), excludeNames: ["capped"] },
      5,
    );
    expect(claimed.map((job) => job.id)).toEqual(["b"]);
    expect((await driver.getJob(q, "a"))?.state).toBe("waiting");
  });
});

describe("file driver: removeOnComplete: true", () => {
  it("leaves no record, marker, hold or log, and still counts the completion", async () => {
    const { driver, q, queueDir } = await setup("remove");
    const now = Date.now();
    await driver.addJob(q, makeJob({ id: "gone", runAt: now }));
    await driver.claimJob(q, claimAt(now));
    await driver.addJobLog(q, "gone", "a line", 0);

    expect(await driver.completeJob(q, "gone", "wrong", null, true, now)).toBe(
      false,
    );
    expect(await driver.completeJob(q, "gone", "t", "r", true, now)).toBe(true);
    expect(await driver.completeJob(q, "gone", "t", "r", true, now)).toBe(
      false,
    );

    expect(await driver.getJob(q, "gone")).toBeNull();
    for (const state of ["active", "completed"]) {
      expect(await markers(queueDir, state)).toEqual([]);
    }
    expect(await readdir(join(queueDir, "held")).catch(() => [])).toEqual([]);
    expect(await readdir(join(queueDir, "logs")).catch(() => [])).toEqual([]);

    const buckets = await driver.getThroughput(q, {
      from: now - 60_000,
      to: now + 60_000,
    } as never);
    const completed = (buckets as { completed: number }[]).reduce(
      (sum, bucket) => sum + bucket.completed,
      0,
    );
    expect(completed).toBe(1);
  });

  it("lets exactly one of two racing completions win", async () => {
    const { root, driver, q } = await setup("remove-race");
    const other = new FileDriver({ root });
    const now = Date.now();
    await driver.addJob(q, makeJob({ id: "raced", runAt: now }));
    await driver.claimJob(q, claimAt(now));

    const results = await Promise.all([
      driver.completeJob(q, "raced", "t", null, true, now),
      other.completeJob(q, "raced", "t", null, true, now),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await driver.getJob(q, "raced")).toBeNull();
  });

  it("completes after a lock extension renamed the marker", async () => {
    const { driver, q } = await setup("remove-extended");
    const now = Date.now();
    await driver.addJob(q, makeJob({ id: "ext", runAt: now }));
    await driver.claimJob(q, claimAt(now));
    await driver.extendJobLock(q, "ext", "t", 90_000, now + 5);
    await driver.updateProgress(q, "ext", 10);

    expect(await driver.completeJob(q, "ext", "t", null, true, now)).toBe(true);
    expect(await driver.getJob(q, "ext")).toBeNull();
  });
});

describe("file driver: addJobs", () => {
  it("adds a repeated id once, and answers the repeats with that job", async () => {
    const { driver, q } = await setup("bulk-dup");
    const now = Date.now();
    const results = await driver.addJobs(q, [
      makeJob({ id: "x", data: { n: 1 }, runAt: now }),
      makeJob({ id: "y", runAt: now }),
      makeJob({ id: "x", data: { n: 2 }, runAt: now }),
    ]);

    expect(results.map((r) => [r.job.id, r.added])).toEqual([
      ["x", true],
      ["y", true],
      ["x", false],
    ]);
    expect(results[2]!.job.data).toEqual({ n: 1 });
    expect((await driver.getJob(q, "x"))?.data).toEqual({ n: 1 });
    expect((await driver.countJobs(q)).waiting).toBe(2);
  });

  it("keeps input order across a batch wider than its concurrency", async () => {
    const { driver, q, queueDir } = await setup("bulk-order");
    const now = Date.now();
    const jobs: JobRecord[] = [];
    for (let i = 0; i < 100; i++) {
      jobs.push(makeJob({ id: `b${i}`, runAt: now, createdAt: now + 99 - i }));
    }
    const results = await driver.addJobs(q, jobs);

    expect(results.map((r) => r.job.id)).toEqual(jobs.map((job) => job.id));
    expect(results.every((r) => r.added)).toBe(true);
    expect(await markers(queueDir, "waiting")).toHaveLength(100);
    // Claim order is by marker, so by `createdAt`: the last given comes first.
    expect((await driver.claimJob(q, claimAt(now)))?.id).toBe("b99");
  });

  it("refuses an over-long id before adding any of the batch", async () => {
    const { driver, q } = await setup("bulk-long");
    const now = Date.now();

    await expect(
      driver.addJobs(q, [
        makeJob({ id: "fine", runAt: now }),
        makeJob({ id: "一".repeat(191), runAt: now }),
      ]),
    ).rejects.toThrow("addJob");
    expect(await driver.getJob(q, "fine")).toBeNull();
  });
});

describe("file driver: picking by marker name", () => {
  it("count retention keeps the newest by finish time, whatever order they finished in", async () => {
    const { driver, q } = await setup("retain");
    const base = Date.now() - 100_000;
    // Finish times deliberately out of order, so the oldest are not the
    // last to finish.
    const finishes = [50, 10, 90, 30, 70, 20, 80, 40, 60, 100, 5, 95];
    const jobs = finishes.map((_, i) =>
      makeJob({ id: `r${i}`, runAt: base, createdAt: base + i }),
    );
    await driver.addJobs(q, jobs);
    const claimed = await driver.claimJobs(q, claimAt(base + 200), 50);
    expect(claimed).toHaveLength(finishes.length);

    for (const [i, offset] of finishes.entries()) {
      await driver.completeJob(q, `r${i}`, "t", null, 4, base + 1_000 + offset);
    }

    const kept = await driver.listJobs(q, ["completed"], {
      offset: 0,
      limit: 50,
    } as never);
    const keptFinishes = (kept as JobRecord[])
      .map((job) => (job.finishedOn ?? 0) - base - 1_000)
      .toSorted((a, b) => a - b);
    // The last completion's retention left the four newest; one written
    // after an older one survives only if it is among them.
    expect(keptFinishes).toEqual([80, 90, 95, 100]);
  });

  it("count retention keeps the newest across a wide, shuffled listing", async () => {
    const { driver, q } = await setup("retain-wide");
    const base = Date.now() - 100_000;
    // 60 finishes in a fixed shuffle, capped at 20: once over the cap each
    // completion has one name too many among 21.
    const finishes: number[] = [];
    for (let i = 0; i < 60; i++) {
      finishes.push((i * 37) % 60);
    }
    const jobs: JobRecord[] = [];
    for (const [i] of finishes.entries()) {
      jobs.push(makeJob({ id: `r${i}`, runAt: base, createdAt: base + i }));
    }
    await driver.addJobs(q, jobs);
    await driver.claimJobs(q, claimAt(base + 200), 100);

    for (const [i, offset] of finishes.entries()) {
      await driver.completeJob(
        q,
        `r${i}`,
        "t",
        null,
        20,
        base + 1_000 + offset,
      );
    }

    const kept = (await driver.listJobs(q, ["completed"], {
      offset: 0,
      limit: 100,
    } as never)) as JobRecord[];
    const keptFinishes = kept
      .map((job) => (job.finishedOn ?? 0) - base - 1_000)
      .toSorted((a, b) => a - b);
    // Keeping the newest 20 at every step keeps the newest 20 overall.
    expect(keptFinishes).toEqual(Array.from({ length: 20 }, (_, i) => 40 + i));
  });

  it("nextDelayedAt and promoteDelayed find the due jobs in an unsorted listing", async () => {
    const { driver, q } = await setup("delayed");
    const now = Date.now();
    const offsets = [5_000, -2, 9_000, 0, -1, 1, 3_000];
    await driver.addJobs(
      q,
      offsets.map((offset, i) =>
        makeJob({
          id: `d${i}`,
          state: "delayed",
          runAt: now + offset,
          createdAt: now + i,
        }),
      ),
    );

    expect(await driver.nextDelayedAt(q)).toBe(now - 2);

    // Due at `now` exactly counts; one millisecond later does not. A
    // fractional `now` is floored, like the marker's prefix.
    expect(await driver.promoteDelayed(q, now + 0.5, 100)).toBe(3);
    const states = await Promise.all(
      offsets.map(async (_, i) => (await driver.getJob(q, `d${i}`))?.state),
    );
    expect(states).toEqual([
      "delayed",
      "waiting",
      "delayed",
      "waiting",
      "waiting",
      "delayed",
      "delayed",
    ]);
    expect(await driver.nextDelayedAt(q)).toBe(now + 1);
    expect(await driver.promoteDelayed(q, now + 1, 100)).toBe(1);
  });

  it("pruneExpired removes expired jobs in batches, and only those", async () => {
    const { driver, q } = await setup("prune");
    const base = Date.now() - 100_000;
    const jobs: JobRecord[] = [];
    for (let i = 0; i < 30; i++) {
      const id = `p${String(i).padStart(2, "0")}`;
      jobs.push(makeJob({ id, runAt: base, createdAt: base + i }));
    }
    await driver.addJobs(q, jobs);
    await driver.claimJobs(q, claimAt(base + 100), 50);

    // Interleaved: every third job keeps for an hour, the rest expire.
    for (const [i, job] of jobs.entries()) {
      const ttl = i % 3 === 0 ? 3_600_000 : 1;
      await driver.completeJob(q, job.id, "t", null, { ttl }, base + 1_000 + i);
    }

    const now = base + 50_000;
    expect(await driver.pruneExpired(q, now, 7)).toBe(7);
    expect(await driver.pruneExpired(q, now, 7)).toBe(7);
    expect(await driver.pruneExpired(q, now, 100)).toBe(6);
    expect(await driver.pruneExpired(q, now, 100)).toBe(0);

    const left = await Promise.all(
      jobs.map(async (job) => (await driver.getJob(q, job.id)) !== null),
    );
    expect(left).toEqual(jobs.map((_, i) => i % 3 === 0));
  });
});

describe("file driver: pruneExpired's not-due memory", () => {
  it("reads a record again once it can be due, and removes it then", async () => {
    const { driver, q } = await setup("prune-later");
    const base = Date.now() - 100_000;
    await driver.addJob(q, makeJob({ id: "soon", runAt: base }));
    await driver.claimJob(q, claimAt(base));
    // Expires at base + 1,010.
    await driver.completeJob(q, "soon", "t", null, { ttl: 10 }, base + 1_000);

    expect(await driver.pruneExpired(q, base + 1_005, 100)).toBe(0);
    // Remembered as not due until its expiry, not for the full window.
    expect(await driver.pruneExpired(q, base + 1_009, 100)).toBe(0);
    expect(await driver.pruneExpired(q, base + 1_010, 100)).toBe(1);
    expect(await driver.getJob(q, "soon")).toBeNull();
  });

  it("forgets a job this process changed, such as a flow child marked recorded", async () => {
    const { driver, q } = await setup("prune-recorded");
    const base = Date.now() - 100_000;
    const child = makeJob({
      id: "child",
      runAt: base,
      flow: {
        parent: { queue: "parents", id: "parent" },
        children: [],
        pending: 0,
        values: {},
        failures: {},
        recorded: false,
      },
    } as Partial<JobRecord>);
    await driver.addJob(q, child);
    await driver.claimJob(q, claimAt(base));
    await driver.completeJob(q, "child", "t", null, { ttl: 1 }, base + 1_000);

    // Its parent has not taken the outcome: kept, and remembered as not due.
    expect(await driver.pruneExpired(q, base + 2_000, 100)).toBe(0);

    // Recorded, which re-stamps the TTL from `now`; due straight after.
    expect(
      await driver.markChildRecorded(q, "child", { ttl: 1 }, base + 2_000),
    ).toBe(true);
    expect(await driver.pruneExpired(q, base + 2_001, 100)).toBe(1);
  });
});

describe("file driver: addJobLog's remembered count", () => {
  it("counts right across appends, a clear and a trim", async () => {
    const { driver, q } = await setup("log");
    const now = Date.now();
    await driver.addJob(q, makeJob({ id: "l", runAt: now }));

    for (let i = 1; i <= 5; i++) {
      expect(await driver.addJobLog(q, "l", `line ${i}`, 0)).toBe(i);
    }
    expect((await driver.getJobLogs(q, "l", logPage)).count).toBe(5);

    expect(await driver.clearJobLogs(q, "l")).toEqual({
      status: "cleared",
      removed: 5,
    });
    expect(await driver.addJobLog(q, "l", "after clear", 0)).toBe(1);

    expect(await driver.addJobLog(q, "l", "two", 3)).toBe(2);
    expect(await driver.addJobLog(q, "l", "three", 3)).toBe(3);
    expect(await driver.addJobLog(q, "l", "four", 3)).toBe(3);
    expect(await driver.addJobLog(q, "l", "five", 0)).toBe(4);
    expect((await driver.getJobLogs(q, "l", logPage)).logs).toEqual([
      "two",
      "three",
      "four",
      "five",
    ]);
  });

  it("notices lines another instance appended or trimmed", async () => {
    const { root, driver, q } = await setup("log-cross");
    const other = new FileDriver({ root });
    const now = Date.now();
    await driver.addJob(q, makeJob({ id: "l", runAt: now }));

    expect(await driver.addJobLog(q, "l", "a", 0)).toBe(1);
    expect(await driver.addJobLog(q, "l", "b", 0)).toBe(2);
    expect(await other.addJobLog(q, "l", "c", 0)).toBe(3);
    expect(await driver.addJobLog(q, "l", "d", 0)).toBe(4);
    // A trim elsewhere rewrites the log to fewer lines.
    expect(await other.addJobLog(q, "l", "e", 2)).toBe(2);
    expect(await driver.addJobLog(q, "l", "f", 0)).toBe(3);
    expect((await driver.getJobLogs(q, "l", logPage)).logs).toEqual([
      "d",
      "e",
      "f",
    ]);
  });

  it("recounts a log whose last line was left partial", async () => {
    const { driver, q, queueDir } = await setup("log-partial");
    const now = Date.now();
    const job = makeJob({ id: "l", runAt: now, createdAt: now });
    await driver.addJob(q, job);
    expect(await driver.addJobLog(q, "l", "a", 0)).toBe(1);

    // A crash mid-append elsewhere: a line with no newline.
    const path = join(queueDir, "logs", `${encodeName("l")}.${now}.jsonl`);
    await Bun.write(path, `${await readFile(path, "utf8")}"partial`);

    expect(await driver.addJobLog(q, "l", "b", 0)).toBe(2);
    expect((await driver.getJobLogs(q, "l", logPage)).logs).toEqual(["a", "b"]);
  });
});
