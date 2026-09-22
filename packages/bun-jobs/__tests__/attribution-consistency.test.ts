import type { JobsDriver } from "../lib/index";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BunJobs,
  BunQueueWorker,
  ConfigError,
  MemoryDriver,
  SqlDriver,
} from "../lib/index";
import { harness, openHarnesses } from "./api/fixtures";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * The library answers the job-list filters as the API does.
 *
 * The API refuses a worker filter on a backend that records no worker (400,
 * naming `syncSchema()`) and an empty or inverted range (400). `queue.list()`
 * and `queue.page()` used to answer both with an empty page, by a scan that
 * matched nothing — which reads as "that worker ran nothing", the wrong answer
 * given silently. Both are a `ConfigError` now; a range alone needs no stamp
 * and is answered everywhere.
 *
 * Also here: a SQL driver's `capabilities.jobAttribution` reads `false` until
 * connecting has confirmed the stamp's columns, and a SQLite index build is
 * reported as blocking, since SQLite's one writer holds the file for it.
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

/** A fresh SQLite file path in a temp directory removed after the case. */
async function tmpFile(name: string): Promise<string> {
  const tmp = await makeTmpDir("bun-jobs-attr-consistency");
  cleanups.push(tmp.cleanup);
  return join(tmp.path, name);
}

/** A SQLite file whose jobs table is the shape an older version made: no stamp columns. */
async function legacyFile(): Promise<string> {
  const file = await tmpFile("legacy.db");
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
  return file;
}

/** A context over `driver` in a namespace of the case's own, purged and closed after. */
function context(driver: JobsDriver, label: string): BunJobs {
  const namespace = testNamespace(label);
  const jobs = new BunJobs({ namespace, driver });
  cleanups.push(async () => {
    await jobs.close();
    await driver.purge(namespace);
    await driver.close();
  });
  return jobs;
}

/** Adds `ids`, runs one worker with `key` until all complete, then closes it. */
async function runAs(
  jobs: BunJobs,
  queue: string,
  key: string,
  ids: readonly string[],
): Promise<void> {
  for (const id of ids) {
    await jobs.queue(queue).add("work", {}, { jobId: id });
  }
  const worker = new BunQueueWorker(queue, async () => "ok", {
    namespace: jobs.namespace,
    driver: jobs.driver,
    key,
    pollInterval: 10,
  });
  cleanups.push(async () => await worker.close({ timeout: 2_000 }));
  void worker.run();
  await waitFor(
    async () => {
      for (const id of ids) {
        if ((await jobs.queue(queue).getJob(id))?.state !== "completed") {
          return false;
        }
      }
      return true;
    },
    { timeout: 10_000, interval: 10, message: `${ids} completed` },
  );
  await worker.close({ timeout: 2_000 });
}

/** The error a call rejects with, or a failure when it resolves. */
async function rejection(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

/** Asserts `work` throws the worker-filter refusal. */
async function expectWorkerRefusal(work: () => Promise<unknown>) {
  const error = await rejection(work);
  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toContain(
    "does not record which worker ran a job",
  );
  expect((error as Error).message).toContain("syncSchema()");
}

describe("queue.list()/page() refuse a worker filter without the capability", () => {
  it("memory with jobAttribution off: a worker filter throws, a range still answers", async () => {
    const driver = new MemoryDriver();
    // The declaration is what the API reads, so it is what the library reads.
    (driver.capabilities as { jobAttribution?: boolean }).jobAttribution =
      false;
    const jobs = context(driver, "attr-cons-mem");
    const before = Date.now();
    await runAs(jobs, "mail", "k-one", ["a1", "a2"]);
    const queue = jobs.queue("mail");

    for (const filter of [
      { workerKey: "k-one" },
      { workerKey: ["k-one", "k-two"] },
      { workerId: "anything" },
      { workerKey: "k-one", finishedFrom: before },
    ]) {
      await expectWorkerRefusal(
        async () => await queue.list("completed", filter),
      );
      await expectWorkerRefusal(
        async () => await queue.page("completed", filter),
      );
    }

    // A range needs no stamp: answered, and narrowing.
    expect(
      (await queue.list("completed", { finishedFrom: before }))
        .map((job) => job.id)
        .sort(),
    ).toEqual(["a1", "a2"]);
    expect(
      await queue.list("completed", { finishedFrom: Date.now() + 60_000 }),
    ).toEqual([]);
    const page = await queue.page("completed", {
      finishedFrom: before,
      finishedTo: Date.now() + 1,
    });
    expect(page.total).toBe(2);
  }, 30_000);

  it("memory with the capability on: the same worker filters answer, and narrow", async () => {
    const jobs = context(new MemoryDriver(), "attr-cons-mem-on");
    await runAs(jobs, "mail", "k-one", ["a1"]);
    await runAs(jobs, "mail", "k-two", ["b1"]);
    const queue = jobs.queue("mail");
    expect(
      (await queue.list("completed", { workerKey: "k-one" })).map((j) => j.id),
    ).toEqual(["a1"]);
    expect((await queue.page("completed", { workerKey: "k-two" })).total).toBe(
      1,
    );
  }, 30_000);

  it("a SQLite table from before the stamp's columns throws until syncSchema(), and answers after", async () => {
    const file = await legacyFile();
    const driver = new SqlDriver({ url: `sqlite://${file}`, pollInterval: 10 });
    const jobs = context(driver, "attr-cons-legacy");
    const before = Date.now();
    await runAs(jobs, "mail", "k-one", ["a1", "a2"]);
    const queue = jobs.queue("mail");
    expect(driver.capabilities.jobAttribution).toBe(false);

    await expectWorkerRefusal(
      async () => await queue.list("completed", { workerKey: "k-one" }),
    );
    await expectWorkerRefusal(
      async () => await queue.page("completed", { workerId: "anything" }),
    );
    // The range is answered on the unsynced table.
    expect(
      (await queue.list("completed", { finishedFrom: before }))
        .map((job) => job.id)
        .sort(),
    ).toEqual(["a1", "a2"]);

    await driver.syncSchema();
    expect(driver.capabilities.jobAttribution).toBe(true);
    await runAs(jobs, "mail", "k-two", ["b1"]);
    // Jobs run before the sync carry no stamp; the one after does.
    expect(
      (await queue.list("completed", { workerKey: "k-two" })).map((j) => j.id),
    ).toEqual(["b1"]);
    expect(await queue.list("completed", { workerKey: "k-one" })).toEqual([]);
    expect((await queue.page("completed", { workerKey: "k-two" })).total).toBe(
      1,
    );
  }, 30_000);
});

describe("queue.list()/page() refuse an empty or inverted range", () => {
  it("throws for finishedTo at or before finishedFrom, on any driver, with or without a worker filter", async () => {
    const jobs = context(new MemoryDriver(), "attr-cons-range");
    const queue = jobs.queue("mail");
    const at = Date.now();

    for (const range of [
      { finishedFrom: at, finishedTo: at },
      { finishedFrom: at, finishedTo: at - 1 },
      { finishedFrom: new Date(at), finishedTo: new Date(at - 60_000) },
      { finishedFrom: at, finishedTo: at - 1, workerKey: "k" },
    ]) {
      for (const read of [
        async () => await queue.list("completed", range),
        async () => await queue.page(["completed", "dead"], range),
      ]) {
        const error = await rejection(read);
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).toContain(
          "finishedTo must be later than finishedFrom",
        );
      }
    }

    // One millisecond wide is a real range.
    expect(
      await queue.list("completed", { finishedFrom: at, finishedTo: at + 1 }),
    ).toEqual([]);
  });
});

describe("SqlDriver capabilities.jobAttribution before connect", () => {
  it("reads false until connect has confirmed the columns, then true", async () => {
    const file = await tmpFile("fresh.db");
    const driver = new SqlDriver({ url: `sqlite://${file}` });
    cleanups.push(async () => await driver.close());
    // Unknown is not "yes": nothing has looked at the table yet.
    expect(driver.capabilities.jobAttribution).toBe(false);
    // Reading it does not connect, or start anything that would.
    expect(driver.capabilities.jobAttribution).toBe(false);
    await driver.connect();
    expect(driver.capabilities.jobAttribution).toBe(true);
  });

  it("reads false before and after connect on a table without them, and true once synced", async () => {
    const file = await legacyFile();
    const driver = new SqlDriver({ url: `sqlite://${file}` });
    cleanups.push(async () => await driver.close());
    expect(driver.capabilities.jobAttribution).toBe(false);
    await driver.connect();
    expect(driver.capabilities.jobAttribution).toBe(false);
    // A dry run adds nothing, and the answer stays `false`.
    await driver.syncSchema({ dryRun: true });
    expect(driver.capabilities.jobAttribution).toBe(false);
    await driver.syncSchema();
    expect(driver.capabilities.jobAttribution).toBe(true);
  });

  it("the API's worker filter connects before it reads the capability", async () => {
    // A fresh SQL driver no request has connected yet: the filter must be
    // answered, not refused on the pre-connect `false`.
    const file = await tmpFile("api.db");
    const driver = new SqlDriver({ url: `sqlite://${file}` });
    const jobs = context(driver, "attr-cons-api");
    const h = harness({ jobs, queues: ["mail"] });
    expect(driver.capabilities.jobAttribution).toBe(false);
    const response = await h.call("GET", "/queues/mail/jobs?workerKey=k-one");
    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([]);
    expect(driver.capabilities.jobAttribution).toBe(true);
  });
});

describe("SQLite schema sync reports an index build as blocking", () => {
  it("plans a missing index as a blocking create-index, and still builds it by default", async () => {
    const file = await tmpFile("sync.db");
    const driver = new SqlDriver({ url: `sqlite://${file}` });
    cleanups.push(async () => await driver.close());
    await driver.connect();
    // The fresh-schema baseline: no drift.
    expect(await driver.syncSchema({ dryRun: true })).toEqual([]);

    const name = "ix_bun_jobs_jobs_due";
    const db = new Database(file);
    db.run(`DROP INDEX ${name}`);
    db.close();

    const planned = await driver.syncSchema({ dryRun: true });
    expect(
      planned.map((change) => [change.kind, change.target, change.blocking]),
    ).toEqual([["create-index", name, true]]);
    const applied = await driver.syncSchema();
    expect(applied.map((change) => change.applied)).toEqual([true]);
    expect(await driver.syncSchema({ dryRun: true })).toEqual([]);
  });
});
