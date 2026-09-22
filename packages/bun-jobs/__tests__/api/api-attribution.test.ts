import type { JobsDriver } from "../../lib/index";
import type { HarnessResponse } from "./fixtures";
import { hostname } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import {
  BunJobs,
  BunQueueWorker,
  FileDriver,
  MemoryDriver,
  MongoDriver,
  RedisDriver,
  SqlDriver,
} from "../../lib/index";
import { makeTmpDir, testNamespace, waitFor } from "../helpers";
import { harness, openHarnesses } from "./fixtures";

/**
 * Worker attribution end to end: real `BunQueueWorker`s claim real jobs on a
 * real backend, and the management API is asked what they did — `processedBy`
 * on a job read, the four job-list filters, and `/meta.features.jobAttribution`.
 *
 * Every filter is checked to *narrow*: a filter the route accepted and then
 * dropped answers 200 with every job, which is exactly what a UI must never
 * be shown, so each case asserts what a filter excludes as well as what it
 * keeps. Runs on every built-in backend a URL is configured for, and on a
 * SQLite table created before the stamp's columns existed (an upgraded
 * install that has not synced), where the flag must read `false` and a worker
 * filter must be refused rather than ignored.
 */

/** Undo steps, run as each case ends — exact names only. */
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const created of openHarnesses) {
    expect(created.mismatches()).toEqual([]);
  }
  openHarnesses.length = 0;
  for (const cleanup of cleanups.splice(0, cleanups.length).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

afterAll(async () => {
  for (const cleanup of cleanups.splice(0, cleanups.length).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

/** A backend to run the flow on: how to build its driver, or why it is skipped. */
interface Backend {
  /** Shown in the test titles. */
  name: string;
  /** Builds a driver over the case's own storage; `undefined` when unavailable. */
  make: (() => Promise<JobsDriver>) | undefined;
}

/** A driver over a fresh SQLite file, cleaned up after the case. */
async function sqliteFile(): Promise<{ file: string }> {
  const tmp = await makeTmpDir("bun-jobs-api-attr");
  cleanups.push(tmp.cleanup);
  return { file: join(tmp.path, "jobs.db") };
}

/** Closes a driver after the case. */
function closing<T extends JobsDriver>(driver: T): T {
  cleanups.push(async () => await driver.close());
  return driver;
}

/** A server-backed backend, skipped when its variable is unset. */
function server(
  name: string,
  variable: string,
  build: (url: string) => JobsDriver,
): Backend {
  const url = process.env[variable];
  return {
    name,
    make: url ? async () => closing(build(url)) : undefined,
  };
}

const BACKENDS: Backend[] = [
  { name: "memory", make: async () => closing(new MemoryDriver()) },
  {
    name: "file",
    make: async () => {
      const tmp = await makeTmpDir("bun-jobs-api-attr-file");
      cleanups.push(tmp.cleanup);
      return closing(new FileDriver({ root: tmp.path, pollInterval: 10 }));
    },
  },
  {
    name: "sqlite",
    make: async () => {
      const { file } = await sqliteFile();
      return closing(new SqlDriver({ url: `sqlite://${file}` }));
    },
  },
  // The shared test tables (`bun_jobs_test_*`) the driver contract uses: each
  // case writes only its own namespace, and purges exactly that.
  server(
    "postgres",
    "BUN_JOBS_TEST_POSTGRES_URL",
    (url) =>
      new SqlDriver({
        url,
        adapter: "postgres",
        tablePrefix: "bun_jobs_test_",
        pollInterval: 10,
      }),
  ),
  server(
    "mysql",
    "BUN_JOBS_TEST_MYSQL_URL",
    (url) =>
      new SqlDriver({
        url,
        adapter: "mysql",
        tablePrefix: "bun_jobs_test_",
        pollInterval: 10,
      }),
  ),
  server(
    "mariadb",
    "BUN_JOBS_TEST_MARIADB_URL",
    (url) =>
      new SqlDriver({
        url,
        adapter: "mariadb",
        tablePrefix: "bun_jobs_test_",
        pollInterval: 10,
      }),
  ),
  server(
    "mongodb",
    "BUN_JOBS_TEST_MONGODB_URL",
    (url) => new MongoDriver({ url, pollInterval: 10 }),
  ),
  server("redis", "BUN_JOBS_TEST_REDIS_URL", (url) => new RedisDriver({ url })),
];

/** A context over `driver` in a namespace of the case's own, purged after. */
function context(driver: JobsDriver, label: string): BunJobs {
  const namespace = testNamespace(label);
  const jobs = new BunJobs({ namespace, driver });
  cleanups.push(async () => {
    await jobs.close();
    await driver.purge(namespace);
  });
  return jobs;
}

/** A running worker with a stable key, closed after the case. */
function startWorker(
  jobs: BunJobs,
  queue: string,
  key: string,
  processor: () => Promise<unknown> = async () => "ok",
): BunQueueWorker {
  const worker = new BunQueueWorker(queue, processor, {
    namespace: jobs.namespace,
    driver: jobs.driver,
    key,
    pollInterval: 10,
  });
  cleanups.push(async () => await worker.close({ timeout: 2_000 }));
  void worker.run();
  return worker;
}

/** Ids of a page, sorted, so a comparison ignores order. */
function ids(response: HarnessResponse): string[] {
  expect(response.status).toBe(200);
  return (response.body.items as { id: string }[]).map((job) => job.id).sort();
}

/** Waits until every named job is completed. */
async function completed(
  jobs: BunJobs,
  queue: string,
  names: readonly string[],
): Promise<void> {
  await waitFor(
    async () => {
      for (const id of names) {
        if ((await jobs.queue(queue).getJob(id))?.state !== "completed") {
          return false;
        }
      }
      return true;
    },
    { timeout: 10_000, interval: 10, message: `jobs ${names} completed` },
  );
}

/** Adds `jobIds`, runs one worker with `key` until all complete, then closes it. */
async function runAs(
  jobs: BunJobs,
  queue: string,
  key: string,
  jobIds: readonly string[],
): Promise<BunQueueWorker> {
  for (const id of jobIds) {
    await jobs.queue(queue).add("work", { id }, { jobId: id });
  }
  const worker = startWorker(jobs, queue, key);
  await completed(jobs, queue, jobIds);
  await worker.close({ timeout: 2_000 });
  return worker;
}

describe.each(BACKENDS)("job attribution through the API: $name", (backend) => {
  it.skipIf(!backend.make)(
    "records the worker, filters by it and by finishedOn, and names only a retried job's last worker",
    async () => {
      const driver = await backend.make!();
      const jobs = context(driver, "api-attr");
      const h = harness({ jobs });
      const hidden = harness({ jobs, serialize: { exposeHosts: false } });
      const queue = "mail";

      // Read before anything has connected the driver: `/meta` connects it
      // itself, so a SQL driver's capability, `false` until connect has
      // confirmed the stamp's columns, is already `true` here. The first
      // assertion proves nothing did connect it beforehand.
      if (driver instanceof SqlDriver) {
        expect(driver.capabilities.jobAttribution).toBe(false);
      }
      const meta = (await h.call("GET", "/meta")).body;
      expect(meta.features.jobAttribution).toBe(true);
      expect(meta.driver.capabilities.jobAttribution).toBe(true);

      // A job no worker ever runs: it must never match a worker filter.
      await jobs
        .queue(queue)
        .add("later", {}, { jobId: "delayed-1", delay: 3_600_000 });

      const before = Date.now();
      const one = await runAs(jobs, queue, "k-one", ["a1", "a2", "a3"]);
      // A gap, so a range can fall between the two workers' finishes.
      await Bun.sleep(25);
      const middle = Date.now();
      await Bun.sleep(25);
      const two = await runAs(jobs, queue, "k-two", ["b1", "b2"]);
      const after = Date.now() + 1;

      // `processedBy` on a single read, with the worker's real identity.
      const read = await h.call("GET", `/queues/${queue}/jobs/a1`);
      expect(read.status).toBe(200);
      expect(read.body.workerId).toBeNull();
      expect(read.body.processedBy).toEqual({
        id: one.id,
        key: "k-one",
        host: hostname(),
        pid: process.pid,
      });
      // …and without host and pid when the API hides them.
      const bare = await hidden.call("GET", `/queues/${queue}/jobs/a1`);
      expect(bare.body.processedBy).toEqual({ id: one.id, key: "k-one" });
      // A job never claimed says `null`.
      expect(
        (await h.call("GET", `/queues/${queue}/jobs/delayed-1`)).body
          .processedBy,
      ).toBeNull();
      // Lists carry it too, under the same rule.
      const listed = await hidden.call(
        "GET",
        `/queues/${queue}/jobs?state=completed&workerKey=k-two`,
      );
      for (const job of listed.body.items) {
        expect(job.processedBy).toEqual({ id: two.id, key: "k-two" });
      }

      const list = async (query: string) =>
        ids(await h.call("GET", `/queues/${queue}/jobs?${query}`));

      // workerKey narrows — across every state, so the delayed job and the
      // other worker's are excluded, not merely absent from one state.
      expect(await list("workerKey=k-one")).toEqual(["a1", "a2", "a3"]);
      expect(await list("workerKey=k-two")).toEqual(["b1", "b2"]);
      expect(await list("workerKey=k-one&workerKey=k-two")).toEqual([
        "a1",
        "a2",
        "a3",
        "b1",
        "b2",
      ]);
      expect(await list("workerKey=nobody")).toEqual([]);
      // workerId narrows to one incarnation.
      expect(await list(`workerId=${encodeURIComponent(two.id)}`)).toEqual([
        "b1",
        "b2",
      ]);
      expect(await list("workerId=nobody")).toEqual([]);
      // The brief's exact query: a worker's completed jobs in a range.
      expect(
        await list(
          `state=completed&workerKey=k-one&finishedFrom=${before}&finishedTo=${after}`,
        ),
      ).toEqual(["a1", "a2", "a3"]);
      // finishedFrom / finishedTo narrow by finishedOn, from/to on each side.
      expect(await list(`finishedFrom=${middle}`)).toEqual(["b1", "b2"]);
      expect(await list(`finishedTo=${middle}`)).toEqual(["a1", "a2", "a3"]);
      expect(
        await list(
          `finishedFrom=${new Date(before).toISOString()}&finishedTo=${new Date(middle).toISOString()}`,
        ),
      ).toEqual(["a1", "a2", "a3"]);
      expect(await list(`workerKey=k-two&finishedTo=${middle}`)).toEqual([]);
      // A total agrees with the page.
      const counted = await h.call(
        "GET",
        `/queues/${queue}/jobs?workerKey=k-one&total=true`,
      );
      expect(counted.body.page.total).toBe(3);

      // An inverted or empty range is refused, not answered empty.
      for (const [from, to] of [
        [after, before],
        [middle, middle],
      ]) {
        const refused = await h.call(
          "GET",
          `/queues/${queue}/jobs?finishedFrom=${from}&finishedTo=${to}`,
        );
        expect(refused.status).toBe(400);
        expect(refused.body.code).toBe("INVALID_ARGUMENT");
      }

      // An active job is stamped at its claim, and never matches a range.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const slow = startWorker(jobs, queue, "k-slow", async () => await held);
      await jobs.queue(queue).add("work", {}, { jobId: "active-1" });
      await waitFor(
        async () =>
          (await jobs.queue(queue).getJob("active-1"))?.state === "active",
        { timeout: 10_000, interval: 10, message: "active-1 claimed" },
      );
      const active = await h.call("GET", `/queues/${queue}/jobs/active-1`);
      expect(active.body.workerId).toBe(slow.id);
      expect(active.body.processedBy).toMatchObject({
        id: slow.id,
        key: "k-slow",
      });
      expect(await list("state=active&workerKey=k-slow")).toEqual(["active-1"]);
      expect(await list(`workerKey=k-slow&finishedFrom=${before}`)).toEqual([]);
      expect(await list(`finishedFrom=${before}`)).not.toContain("active-1");
      expect(await list(`state=active&finishedFrom=${before}`)).toEqual([]);
      release();
      await completed(jobs, queue, ["active-1"]);
      await slow.close({ timeout: 2_000 });

      // A job failed by one worker and completed by another names only the
      // second, and the first's filter no longer lists it. The backoff keeps
      // the failing worker from taking the retry before it is closed.
      await jobs
        .queue(queue)
        .add("flaky", {}, { jobId: "flaky-1", attempts: 2, backoff: 400 });
      const failing = startWorker(jobs, queue, "k-fail", async () => {
        throw new Error("first attempt fails");
      });
      await waitFor(
        async () =>
          ((await jobs.queue(queue).getJob("flaky-1"))?.attemptsMade ?? 0) >= 1,
        { timeout: 10_000, interval: 10, message: "flaky-1 failed once" },
      );
      await failing.close({ timeout: 2_000 });
      const retried = startWorker(jobs, queue, "k-retry");
      await completed(jobs, queue, ["flaky-1"]);
      await retried.close({ timeout: 2_000 });
      const flaky = await h.call("GET", `/queues/${queue}/jobs/flaky-1`);
      expect(flaky.body.processedBy).toEqual({
        id: retried.id,
        key: "k-retry",
        host: hostname(),
        pid: process.pid,
      });
      expect(await list("workerKey=k-fail")).toEqual([]);
      expect(await list("workerKey=k-retry")).toEqual(["flaky-1"]);
    },
    60_000,
  );
});

describe("job attribution through the API: SQLite table from before the stamp's columns", () => {
  it("reads false and refuses a worker filter until syncSchema(), then records and filters", async () => {
    const { file } = await sqliteFile();
    // The schema an older version made: every column but the stamp's.
    const creator = new SqlDriver({ url: `sqlite://${file}` });
    await creator.connect();
    await creator.close();
    const db = new Database(file);
    for (const column of [
      "processed_by_id",
      "processed_by_key",
      "processed_by_host",
      "processed_by_pid",
    ]) {
      db.run(`ALTER TABLE bun_jobs_jobs DROP COLUMN ${column}`);
    }
    db.close();

    const driver = closing(
      new SqlDriver({ url: `sqlite://${file}`, pollInterval: 10 }),
    );
    const jobs = context(driver, "api-attr-legacy");
    const h = harness({ jobs });
    const queue = "mail";

    // Known from connect, before any claim has tried the stamped statement.
    await driver.connect();
    const meta = (await h.call("GET", "/meta")).body;
    expect(meta.features.jobAttribution).toBe(false);
    expect(meta.driver.capabilities.jobAttribution).toBe(false);

    // Work still runs: the claim falls back to the statement without them.
    const before = Date.now();
    await jobs
      .queue(queue)
      .add("later", {}, { jobId: "delayed-1", delay: 3_600_000 });
    await runAs(jobs, queue, "k-one", ["a1", "a2"]);
    const read = await h.call("GET", `/queues/${queue}/jobs/a1`);
    expect(read.status).toBe(200);
    expect(read.body.processedBy).toBeNull();

    // A worker filter is refused — never a 200 that ignored it.
    for (const query of ["workerKey=k-one", "workerId=anything"]) {
      const refused = await h.call("GET", `/queues/${queue}/jobs?${query}`);
      expect({
        query,
        status: refused.status,
        code: refused.body.code,
      }).toEqual({ query, status: 400, code: "INVALID_ARGUMENT" });
      expect(refused.body.detail).toContain("syncSchema()");
    }
    // A range needs no stamp, and is answered, narrowing to finished jobs.
    const ranged = await h.call(
      "GET",
      `/queues/${queue}/jobs?finishedFrom=${before}`,
    );
    expect(ids(ranged)).toEqual(["a1", "a2"]);

    // A sync adds the columns: the flag turns on at once, and work from then
    // on is stamped and filterable.
    await driver.syncSchema();
    const synced = (await h.call("GET", "/meta")).body;
    expect(synced.features.jobAttribution).toBe(true);
    expect(synced.driver.capabilities.jobAttribution).toBe(true);
    const worker = await runAs(jobs, queue, "k-two", ["b1"]);
    expect(
      (await h.call("GET", `/queues/${queue}/jobs/b1`)).body.processedBy,
    ).toEqual({
      id: worker.id,
      key: "k-two",
      host: hostname(),
      pid: process.pid,
    });
    expect(
      ids(await h.call("GET", `/queues/${queue}/jobs?workerKey=k-two`)),
    ).toEqual(["b1"]);
    // Jobs from before the sync have no stamp, so no key matches them.
    expect(
      ids(await h.call("GET", `/queues/${queue}/jobs?workerKey=k-one`)),
    ).toEqual([]);
  }, 60_000);
});
