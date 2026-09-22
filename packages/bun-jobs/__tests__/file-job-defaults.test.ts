import type {
  JobRecord,
  PendingOptionsRewrite,
  QueueRef,
  StoredJobOptions,
} from "../lib/drivers/driver";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { FileDriver } from "../lib/drivers/file-driver";
import { encodeName } from "../lib/drivers/file-names";
import { JOB_OPTION_BITS } from "../lib/queue/jobDefaults";
import { jobOptions, makeJob, makeTmpDir, testNamespace } from "./helpers";

/**
 * The file driver's half of queue job defaults beyond the shared contract:
 * how its marker walk reorders, finds held markers, sees `moved`, and stays
 * whole against claims running beside it.
 */

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
});

/** A connected driver in a fresh directory, and a queue of its own. */
async function setup(name: string): Promise<{
  driver: FileDriver;
  root: string;
  q: QueueRef;
}> {
  const tmp = await makeTmpDir(`bun-jobs-jdef-${name}`);
  cleanups.push(tmp.cleanup);
  const driver = new FileDriver({ root: tmp.path });
  await driver.connect();
  cleanups.push(async () => await driver.close());
  return { driver, root: tmp.path, q: { ns: testNamespace(), queue: "jdef" } };
}

/** Stored options with a mask: `explicit` 0 unless given. */
function opts(overrides: Partial<StoredJobOptions> = {}): StoredJobOptions {
  return { ...jobOptions(), explicit: 0, ...overrides };
}

/** A full request with the usual values. */
function request(
  values: PendingOptionsRewrite["values"],
  extra: Partial<PendingOptionsRewrite> = {},
): PendingOptionsRewrite {
  return {
    states: ["waiting", "delayed", "failed", "waiting-children"],
    values,
    cursor: null,
    limit: 1_000,
    includeUnmarked: false,
    dryRun: false,
    now: Date.now(),
    ...extra,
  };
}

/** The directory of one state's markers. */
function indexDir(root: string, q: QueueRef, state: string): string {
  return join(root, q.ns, "queues", q.queue, "index", state);
}

/** Claims every waiting job, in the order the driver hands them out. */
async function claimAll(driver: FileDriver, q: QueueRef): Promise<string[]> {
  const ids: string[] = [];

  for (;;) {
    const job = await driver.claimJob(q, {
      workerId: "w",
      token: `t${ids.length}`,
      lockMs: 30_000,
      now: Date.now(),
    });

    if (!job) {
      return ids;
    }

    ids.push(job.id);
  }
}

describe("file driver: rewritePendingOptions", () => {
  it("renames a waiting marker to its new priority, keeping FIFO among equals", async () => {
    const { driver, root, q } = await setup("order");
    // In the past, so every job is due by the time `claimAll` asks: a claim
    // passes over a waiting job whose `runAt` (here its `createdAt`) is ahead.
    const now = Date.now() - 1_000;

    // a and c are defaulted; b pinned its priority on add.
    await driver.addJobs(q, [
      makeJob({
        id: "a",
        createdAt: now,
        opts: opts({ priority: 5 }),
        priority: 5,
      }),
      makeJob({
        id: "b",
        createdAt: now + 1,
        opts: opts({ priority: 5, explicit: JOB_OPTION_BITS.priority }),
        priority: 5,
      }),
      makeJob({
        id: "c",
        createdAt: now + 2,
        opts: opts({ priority: 5 }),
        priority: 5,
      }),
      makeJob({
        id: "d",
        createdAt: now + 3,
        opts: opts({ priority: 1 }),
        priority: 1,
      }),
    ]);

    const result = await driver.rewritePendingOptions(
      q,
      request({ priority: 1 }),
    );
    expect(result).toMatchObject({
      rewritten: 2,
      skippedExplicit: 1,
      unchanged: 1,
      moved: 0,
      next: null,
    });

    // The priority is the marker's prefix: a and c now sit beside d, in
    // creation order, and b keeps its place behind them.
    const markers = (await readdir(indexDir(root, q, "waiting"))).sort();
    expect(markers.map((marker) => marker.split("-")[0])).toEqual([
      "01048577",
      "01048577",
      "01048577",
      "01048581",
    ]);
    expect(markers.at(-1)!.endsWith(`-${encodeName("b")}`)).toBe(true);

    expect(await claimAll(driver, q)).toEqual(["a", "c", "d", "b"]);
  });

  it("walks a marker another change holds at listing time, once it is back", async () => {
    const { driver, root, q } = await setup("held");
    await driver.addJobs(q, [
      makeJob({ id: "free", opts: opts() }),
      makeJob({ id: "busy", opts: opts() }),
    ]);

    // Take busy's marker the way `#holdJob` does, with a fresh stamp so no
    // healing pass files it early, and put it back a moment into the walk.
    const dir = indexDir(root, q, "waiting");
    const marker = (await readdir(dir)).find((name) =>
      name.endsWith(`-${encodeName("busy")}`),
    )!;
    const heldDir = join(root, q.ns, "queues", q.queue, "held");
    await mkdir(heldDir, { recursive: true });
    const hold = join(heldDir, `${Date.now()}.waiting.${marker}`);
    await rename(join(dir, marker), hold);

    const walking = driver.rewritePendingOptions(q, request({ attempts: 4 }));
    await Bun.sleep(40);
    await rename(hold, join(dir, marker));

    const result = await walking;
    expect(result).toMatchObject({ examined: 2, rewritten: 2, moved: 0 });
    expect((await driver.getJob(q, "busy"))?.maxAttempts).toBe(4);
    expect(await readdir(heldDir)).toEqual([]);
  });

  it("counts a job that left the walked state before its write as moved, and leaves it alone", async () => {
    const { driver, root, q } = await setup("moved");
    await driver.addJobs(q, [
      makeJob({ id: "stays", opts: opts() }),
      makeJob({ id: "gone", opts: opts() }),
    ]);

    // A claim renames the marker before it writes the record; freeze one
    // half-way the other way round: the record already says active while the
    // listing still finds the waiting marker.
    const path = join(
      root,
      q.ns,
      "queues",
      q.queue,
      "jobs",
      `${encodeName("gone")}.json`,
    );
    const record = JSON.parse(await readFile(path, "utf8")) as JobRecord;
    await writeFile(path, JSON.stringify({ ...record, state: "active" }));

    const result = await driver.rewritePendingOptions(
      q,
      request({ timeout: 900 }),
    );
    expect(result).toMatchObject({ examined: 2, rewritten: 1, moved: 1 });
    expect((await driver.getJob(q, "gone"))?.opts.timeout).toBe(0);
    expect((await driver.getJob(q, "stays"))?.opts.timeout).toBe(900);
  });

  it("re-checks the state under the hold: a job claimed while the walk waited for it is not written", async () => {
    const { driver, root, q } = await setup("claimed-under");
    await driver.addJobs(q, [makeJob({ id: "taken", opts: opts() })]);

    // Somebody else holds the marker, so the walk reads a waiting record and
    // then waits for the hold...
    const dir = indexDir(root, q, "waiting");
    const [marker] = await readdir(dir);
    const heldDir = join(root, q.ns, "queues", q.queue, "held");
    await mkdir(heldDir, { recursive: true });
    const hold = join(heldDir, `${Date.now()}.waiting.${marker}`);
    await rename(join(dir, marker!), hold);

    const walking = driver.rewritePendingOptions(q, request({ attempts: 7 }));
    await Bun.sleep(40);

    // ...and while it waits, a claim takes the job, the way `claimJob` does:
    // marker renamed to its active name first, then the record written.
    const lockExpiresAt = Date.now() + 30_000;
    await mkdir(indexDir(root, q, "active"), { recursive: true });
    await rename(
      hold,
      join(
        indexDir(root, q, "active"),
        `${String(lockExpiresAt).padStart(13, "0")}-${encodeName("taken")}`,
      ),
    );
    const path = join(
      root,
      q.ns,
      "queues",
      q.queue,
      "jobs",
      `${encodeName("taken")}.json`,
    );
    const record = JSON.parse(await readFile(path, "utf8")) as JobRecord;
    await writeFile(
      path,
      JSON.stringify({
        ...record,
        state: "active",
        lockToken: "t",
        lockExpiresAt,
        workerId: "w",
        attemptsMade: 1,
      }),
    );

    const result = await walking;
    expect(result).toMatchObject({ examined: 1, rewritten: 0, moved: 1 });
    const after = await driver.getJob(q, "taken");
    expect(after?.state).toBe("active");
    expect(after?.maxAttempts).toBe(1);
    expect(after?.opts.attempts).toBe(1);
  });

  it("pages by marker across states, each job examined once when nothing moves", async () => {
    const { driver, q } = await setup("paging");
    const now = Date.now();
    const jobs: JobRecord[] = [];

    for (let index = 0; index < 23; index++) {
      jobs.push(
        makeJob({ id: `w${index}`, createdAt: now + index, opts: opts() }),
      );
    }

    for (let index = 0; index < 17; index++) {
      jobs.push(
        makeJob({
          id: `d${index}`,
          state: "delayed",
          runAt: now + 60_000 + index,
          opts: opts(),
        }),
      );
    }

    await driver.addJobs(q, jobs);

    let cursor: string | null = null;
    let examined = 0;
    let rewritten = 0;
    let calls = 0;

    do {
      const page = await driver.rewritePendingOptions(
        q,
        request({ keepStacktraces: 9 }, { cursor, limit: 7 }),
      );
      expect(page.examined).toBeLessThanOrEqual(7);
      examined += page.examined;
      rewritten += page.rewritten;
      cursor = page.next;
      calls++;
    } while (cursor !== null && calls < 50);

    expect({ examined, rewritten, calls }).toEqual({
      examined: 40,
      rewritten: 40,
      // 40 / 7 rounds up to 6, and the walk ending exactly on no boundary
      // needs no empty call more.
      calls: 6,
    });

    for (const job of jobs) {
      expect((await driver.getJob(q, job.id))?.opts.keepStacktraces).toBe(9);
    }
  });

  it("never half-writes a job against claims running beside it", async () => {
    const { driver, root, q } = await setup("claims");
    // In the past, so every job is due and claimable from the start.
    const now = Date.now() - 1_000;
    const count = 300;

    /** One job of the backlog, defaulted, at priority 3 and one attempt. */
    const backlogJob = (index: number): JobRecord =>
      makeJob({
        id: `j${index}`,
        createdAt: now + index,
        opts: opts({ attempts: 1, priority: 3 }),
        priority: 3,
        maxAttempts: 1,
      });
    const jobs = Array.from({ length: count }, (_, index) => backlogJob(index));
    await driver.addJobs(q, jobs);

    const claimed: JobRecord[] = [];
    /** Set when the walk is over; an object so the loops see the change. */
    const run = { stop: false };
    let tokens = 0;
    const claimer = async () => {
      while (!run.stop) {
        const job = await driver.claimJob(q, {
          workerId: "w",
          token: `t${tokens++}`,
          lockMs: 30_000,
          now: Date.now(),
        });

        if (job) {
          claimed.push(job);
        } else {
          await Bun.sleep(1);
        }
      }
    };
    const claimers = [claimer(), claimer(), claimer()];

    // The claims are under way before the walk starts, and go on until it
    // ends: paged, so the walk re-lists while they take markers.
    while (claimed.length === 0) {
      await Bun.sleep(1);
    }

    const result = { examined: 0, rewritten: 0, unchanged: 0, moved: 0 };
    let cursor: string | null = null;

    do {
      const page = await driver.rewritePendingOptions(
        q,
        request({ attempts: 6, priority: 2 }, { cursor, limit: 25 }),
      );
      result.examined += page.examined;
      result.rewritten += page.rewritten;
      result.unchanged += page.unchanged;
      result.moved += page.moved;
      cursor = page.next;
    } while (cursor !== null);

    run.stop = true;
    await Promise.all(claimers);

    expect(claimed.length).toBeGreaterThan(0);
    // A priority raised ahead of the cursor is met again, as unchanged.
    expect(result.rewritten + result.moved + result.unchanged).toBe(
      result.examined,
    );

    const all = await Promise.all(
      Array.from(
        { length: count },
        async (_, index) => await driver.getJob(q, `j${index}`),
      ),
    );

    for (const job of all) {
      expect(job).not.toBeNull();
      // Whole: attempts, maxAttempts and both priorities move together.
      const fresh = job!.opts.attempts === 6;
      expect(job!.maxAttempts).toBe(fresh ? 6 : 1);
      expect(job!.opts.priority).toBe(fresh ? 2 : 3);
      expect(job!.priority).toBe(fresh ? 2 : 3);

      // Only a claimed job can have been missed.
      if (!fresh) {
        expect(job!.state).toBe("active");
      }
    }

    // Every claim got one whole copy, and no marker was left in `held/`.
    for (const job of claimed) {
      expect(job.maxAttempts).toBe(job.opts.attempts);
      expect(job.priority).toBe(job.opts.priority);
    }

    const held = await readdir(
      join(root, q.ns, "queues", q.queue, "held"),
    ).catch(() => []);
    expect(held).toEqual([]);

    const waiting = await readdir(indexDir(root, q, "waiting")).catch(() => []);
    const active = await readdir(indexDir(root, q, "active")).catch(() => []);
    expect(waiting.length + active.length).toBe(count);
  });

  it("writes nothing in a dry run, marker names included", async () => {
    const { driver, root, q } = await setup("dry");
    await driver.addJobs(q, [
      makeJob({ id: "x", opts: opts({ priority: 4 }), priority: 4 }),
    ]);
    const before = await readdir(indexDir(root, q, "waiting"));
    const path = join(
      root,
      q.ns,
      "queues",
      q.queue,
      "jobs",
      `${encodeName("x")}.json`,
    );
    const record = await readFile(path, "utf8");

    const result = await driver.rewritePendingOptions(
      q,
      request({ priority: 0 }, { dryRun: true }),
    );
    expect(result).toMatchObject({ examined: 1, rewritten: 1 });
    expect(await readdir(indexDir(root, q, "waiting"))).toEqual(before);
    expect(await readFile(path, "utf8")).toBe(record);
  });
});

describe("file driver: updateJob and the explicit mask", () => {
  it("ORs the priority bit into the stored record, and leaves a mask-less one without", async () => {
    const { driver, root, q } = await setup("bit");
    await driver.addJobs(q, [
      makeJob({
        id: "marked",
        opts: opts({ explicit: JOB_OPTION_BITS.attempts }),
      }),
      makeJob({ id: "old", opts: jobOptions() }),
    ]);

    await driver.updateJob(q, "marked", { priority: 0 }, Date.now());
    await driver.updateJob(q, "old", { priority: 2 }, Date.now());

    const onDisk = async (id: string) =>
      (
        JSON.parse(
          await readFile(
            join(
              root,
              q.ns,
              "queues",
              q.queue,
              "jobs",
              `${encodeName(id)}.json`,
            ),
            "utf8",
          ),
        ) as JobRecord
      ).opts;

    expect((await onDisk("marked")).explicit).toBe(
      JOB_OPTION_BITS.attempts | JOB_OPTION_BITS.priority,
    );
    expect("explicit" in (await onDisk("old"))).toBe(false);
  });
});
