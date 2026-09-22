import type { JobQuery, JobState, QueueRef } from "../lib/drivers/driver";
import * as fsp from "node:fs/promises";
import { join, sep } from "node:path";
import { serializeError } from "@kingsleyweb/bun-common";
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { FileDriver } from "../lib/index";
import { makeJob, makeTmpDir, testNamespace } from "./helpers";

/**
 * Job attribution on the file driver, beyond the shared contract: the stamp as
 * it lies on disk, and what a `finishedOn` range costs — which job files it
 * opens, counted, and which state directories it lists.
 */

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

/** Every spy this file installs, restored after each case. */
const spies: { mockRestore: () => void }[] = [];

afterEach(() => {
  for (const spy of spies.splice(0)) {
    spy.mockRestore();
  }
});

/** One worker's identity, as the worker passes it to the claim. */
const ALPHA = { key: "svc.alpha", host: "host-a", pid: 101 };
/** A second worker, under another key. */
const BRAVO = { key: "svc.bravo", host: "host-b", pid: 202 };

/** A fresh driver on a temporary root, and a queue of its own. */
async function setup(): Promise<{
  driver: FileDriver;
  root: string;
  q: QueueRef;
}> {
  const tmp = await makeTmpDir("bun-jobs-file-attribution");
  const driver = new FileDriver({ root: tmp.path });
  await driver.connect();
  cleanups.push(async () => {
    await driver.close();
    await tmp.cleanup();
  });
  return {
    driver,
    root: tmp.path,
    q: { ns: testNamespace(), queue: "attr" },
  };
}

/** The job file of `id`, parsed straight off the disk. */
async function onDisk(
  root: string,
  q: QueueRef,
  id: string,
): Promise<Record<string, unknown>> {
  const path = join(root, q.ns, "queues", q.queue, "jobs", `${id}.json`);
  return JSON.parse(await fsp.readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
}

/**
 * Adds `id` and claims it alone as `workerId` for `worker`, at `now`. Added one
 * at a time, so the claim cannot pick another job.
 */
async function addAndClaim(
  driver: FileDriver,
  q: QueueRef,
  id: string,
  workerId: string,
  worker: typeof ALPHA | undefined,
  now: number,
  lockMs = 30_000,
): Promise<string> {
  await driver.addJob(q, makeJob({ id, runAt: now, createdAt: now }));
  const token = `tok-${id}-${now}`;
  const claimed = await driver.claimJob(q, {
    workerId,
    token,
    lockMs,
    now,
    ...(worker ? { worker } : {}),
  });
  expect(claimed?.id).toBe(id);
  return token;
}

/**
 * Counts the job files the driver opens from here on: every `readFile` of a
 * path under the queue's `jobs` directory, by id.
 */
function countJobOpens(root: string, q: QueueRef): string[] {
  const jobsDir = join(root, q.ns, "queues", q.queue, "jobs") + sep;
  const opened: string[] = [];
  const original = fsp.readFile;
  const spy = spyOn(fsp, "readFile").mockImplementation(((
    path: Parameters<typeof fsp.readFile>[0],
    ...rest: unknown[]
  ) => {
    if (typeof path === "string" && path.startsWith(jobsDir)) {
      opened.push(path.slice(jobsDir.length).replace(/\.json$/, ""));
    }
    return (original as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fsp.readFile);
  spies.push(spy);
  return opened;
}

/** Counts the index directories the driver lists from here on, by state. */
function countIndexLists(root: string, q: QueueRef): string[] {
  const indexDir = join(root, q.ns, "queues", q.queue, "index") + sep;
  const listed: string[] = [];
  const original = fsp.readdir;
  const spy = spyOn(fsp, "readdir").mockImplementation(((
    path: Parameters<typeof fsp.readdir>[0],
    ...rest: unknown[]
  ) => {
    if (typeof path === "string" && path.startsWith(indexDir)) {
      listed.push(path.slice(indexDir.length));
    }
    return (original as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fsp.readdir);
  spies.push(spy);
  return listed;
}

/** A page query with the usual defaults. */
function query(over: Partial<JobQuery> & Pick<JobQuery, "states">): JobQuery {
  return { offset: 0, limit: 100, order: "asc", total: true, ...over };
}

describe("file driver: job attribution on disk", () => {
  it("writes the stamp with the claim and keeps it in the file through every settle", async () => {
    const { driver, root, q } = await setup();
    const now = Date.now();
    const failure = serializeError(new Error("attribution"));

    const completed = await addAndClaim(driver, q, "done", "a-1", ALPHA, now);
    expect((await onDisk(root, q, "done")).processedBy).toEqual({
      id: "a-1",
      ...ALPHA,
    });
    await driver.completeJob(q, "done", completed, null, false, now + 1);
    const done = await onDisk(root, q, "done");
    expect(done.processedBy).toEqual({ id: "a-1", ...ALPHA });
    expect(done.workerId).toBeNull();

    const retried = await addAndClaim(driver, q, "retry", "b-1", BRAVO, now);
    await driver.failJob(
      q,
      "retry",
      retried,
      failure,
      { retry: true, runAt: now + 60_000 },
      now + 1,
      1,
    );
    const retry = await onDisk(root, q, "retry");
    expect(retry.state).toBe("failed");
    expect(retry.processedBy).toEqual({ id: "b-1", ...BRAVO });
    expect(retry.workerId).toBeNull();

    // A lock that runs out: stall recovery re-files it and keeps the stamp.
    await addAndClaim(driver, q, "stall", "a-2", ALPHA, now, 1);
    await driver.recoverStalled(q, now + 10, 5, 10);
    const stalled = await onDisk(root, q, "stall");
    expect(stalled.state).toBe("waiting");
    expect(stalled.processedBy).toEqual({ id: "a-2", ...ALPHA });
    expect(stalled.workerId).toBeNull();
  });

  it("treats a record written before attribution as unattributed", async () => {
    const { driver, q } = await setup();
    const now = Date.now();
    // Stored as an older version wrote it: finished, and no `processedBy` key.
    await driver.addJob(
      q,
      makeJob({
        id: "legacy",
        state: "completed",
        createdAt: now,
        finishedOn: now,
      }),
    );

    expect((await driver.getJob(q, "legacy"))?.processedBy ?? null).toBeNull();
    const byKey = await driver.findJobs(
      q,
      query({ states: ["completed"], workerKeys: [ALPHA.key] }),
    );
    expect(byKey).toEqual({ jobs: [], total: 0 });

    // A range still finds it: the date is on every finished record.
    const byRange = await driver.findJobs(
      q,
      query({ states: ["completed"], finishedFrom: now, finishedTo: now + 1 }),
    );
    expect(byRange.jobs.map((job) => job.id)).toEqual(["legacy"]);
  });
});

describe("file driver: a finishedOn range opens only the jobs inside it", () => {
  /**
   * Ten finished jobs, one a second from `t0`, alternating between the two
   * workers — completed, except every third, which dies — and three waiting
   * ones that no range can match.
   */
  async function seed(): Promise<{
    driver: FileDriver;
    root: string;
    q: QueueRef;
    t0: number;
  }> {
    const { driver, root, q } = await setup();
    const t0 = 1_700_000_000_000;
    const failure = serializeError(new Error("dies"));

    for (let i = 0; i < 10; i++) {
      const id = `j${i}`;
      const at = t0 + i * 1000;
      const [workerId, worker] = i % 2 === 0 ? ["a", ALPHA] : ["b", BRAVO];
      const token = await addAndClaim(driver, q, id, workerId, worker, at);

      if (i % 3 === 2) {
        await driver.failJob(
          q,
          id,
          token,
          failure,
          { retry: false, retention: false },
          at,
          1,
        );
      } else {
        await driver.completeJob(q, id, token, null, false, at);
      }
    }

    for (let i = 0; i < 3; i++) {
      await driver.addJob(
        q,
        makeJob({ id: `w${i}`, runAt: t0 + 99_000, createdAt: t0 + 3500 }),
      );
    }

    return { driver, root, q, t0 };
  }

  it("one state: opens the jobs finished inside the range, and no other", async () => {
    const { driver, root, q, t0 } = await seed();
    const opened = countJobOpens(root, q);

    // [t0+3s, t0+7s): j3 j4 j6 completed, j5 dead.
    const page = await driver.findJobs(
      q,
      query({
        states: ["completed"],
        finishedFrom: t0 + 3000,
        finishedTo: t0 + 7000,
      }),
    );

    expect(page.jobs.map((job) => job.id)).toEqual(["j3", "j4", "j6"]);
    expect(page.total).toBe(3);
    expect(opened.sort()).toEqual(["j3", "j4", "j6"]);
  });

  it("with a worker filter: still opens only the range, and matches inside it", async () => {
    const { driver, root, q, t0 } = await seed();
    const opened = countJobOpens(root, q);

    const page = await driver.findJobs(
      q,
      query({
        states: ["completed", "dead"],
        finishedFrom: t0 + 3000,
        finishedTo: t0 + 7000,
        workerKeys: [BRAVO.key],
      }),
    );

    // Bravo ran the odd ones: j3 completed, j5 dead.
    expect(page.jobs.map((job) => job.id)).toEqual(["j3", "j5"]);
    expect(page.total).toBe(2);
    expect(opened.sort()).toEqual(["j3", "j4", "j5", "j6"]);
  });

  it("several states: never lists or opens a state a range cannot match", async () => {
    const { driver, root, q, t0 } = await seed();
    const opened = countJobOpens(root, q);
    const listed = countIndexLists(root, q);
    const states: JobState[] = ["waiting", "active", "completed", "dead"];

    const page = await driver.findJobs(
      q,
      query({ states, finishedFrom: t0 + 8000 }),
    );

    // j8 dead, j9 completed; ordered by creation, as several states are.
    expect(page.jobs.map((job) => job.id)).toEqual(["j8", "j9"]);
    expect(page.total).toBe(2);
    expect(opened.sort()).toEqual(["j8", "j9"]);
    expect(listed.sort()).toEqual(["completed", "dead"]);
  });

  it("an empty range, or one over no finished state, reads nothing at all", async () => {
    const { driver, root, q, t0 } = await seed();
    const opened = countJobOpens(root, q);
    const listed = countIndexLists(root, q);

    expect(
      await driver.findJobs(
        q,
        query({
          states: ["completed"],
          finishedFrom: t0 + 5000,
          finishedTo: t0 + 5000,
        }),
      ),
    ).toEqual({ jobs: [], total: 0 });
    expect(
      await driver.findJobs(
        q,
        query({ states: ["waiting", "active"], finishedFrom: t0 }),
      ),
    ).toEqual({ jobs: [], total: 0 });

    expect(opened).toEqual([]);
    expect(listed).toEqual([]);
  });

  it("desc with a limit: the newest inside the range, stopping once the page is full", async () => {
    const { driver, root, q, t0 } = await seed();
    const opened = countJobOpens(root, q);

    const page = await driver.findJobs(
      q,
      query({
        states: ["completed"],
        finishedFrom: t0,
        finishedTo: t0 + 7000,
        order: "desc",
        limit: 2,
        total: false,
      }),
    );

    expect(page.jobs.map((job) => job.id)).toEqual(["j6", "j4"]);
    // One bounded batch of the markers inside the range: j0 j1 j3 j4 j6.
    expect(opened.sort()).toEqual(["j0", "j1", "j3", "j4", "j6"]);
  });
});
