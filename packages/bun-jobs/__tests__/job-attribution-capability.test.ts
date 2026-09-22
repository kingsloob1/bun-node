import type { JobsDriver } from "../lib/index";
import { hostname } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import {
  BunJobs,
  BunQueueWorker,
  FileDriver,
  MemoryDriver,
  MongoDriver,
  RedisDriver,
  SqlDriver,
} from "../lib/index";
import { makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * `capabilities.jobAttribution` must say exactly what the claim does.
 *
 * The shared driver contract's attribution block is all-or-nothing: a driver
 * whose claim stamps nothing reads as having opted out, and passes. So the
 * declaration is what holds a driver to the block, and a driver that stopped
 * stamping while still declaring it — or stamped without declaring it, so
 * `/meta` hid a feature that works and the job list scanned — would slip
 * through. This file pins the two together on every built-in backend, through
 * a real `BunQueueWorker`, so it also covers the claim site passing the
 * worker's identity: on the singular claim (concurrency 1) and the plural one
 * (a batch of four).
 *
 * And the relation holds both ways: a SQL table from before the stamp's
 * columns cannot stamp, so the SQL driver must not declare it there.
 */

/** Undo steps, run as each case ends — exact names only. */
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0, cleanups.length).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

/** A driver over a fresh temp directory's file. */
async function tmpFile(name: string): Promise<string> {
  const tmp = await makeTmpDir("bun-jobs-attr-cap");
  cleanups.push(tmp.cleanup);
  return join(tmp.path, name);
}

/** A backend and how to build it, or `undefined` where no server is set. */
interface Backend {
  /** Shown in the test titles. */
  name: string;
  /** Builds its driver; `undefined` when unavailable. */
  make: (() => Promise<JobsDriver>) | undefined;
}

/** A server-backed backend, skipped when its variable is unset. */
function server(
  name: string,
  variable: string,
  build: (url: string) => JobsDriver,
): Backend {
  const url = process.env[variable];
  return { name, make: url ? async () => build(url) : undefined };
}

/** Every built-in driver. A new one belongs here. */
const BACKENDS: Backend[] = [
  { name: "memory", make: async () => new MemoryDriver() },
  {
    name: "file",
    make: async () => {
      const root = await tmpFile("root");
      return new FileDriver({ root, pollInterval: 10 });
    },
  },
  {
    name: "sqlite",
    make: async () =>
      new SqlDriver({ url: `sqlite://${await tmpFile("jobs.db")}` }),
  },
  server(
    "postgres",
    "BUN_JOBS_TEST_POSTGRES_URL",
    (url) =>
      new SqlDriver({
        url,
        adapter: "postgres",
        tablePrefix: "bun_jobs_test_",
      }),
  ),
  server(
    "mysql",
    "BUN_JOBS_TEST_MYSQL_URL",
    (url) =>
      new SqlDriver({ url, adapter: "mysql", tablePrefix: "bun_jobs_test_" }),
  ),
  server(
    "mariadb",
    "BUN_JOBS_TEST_MARIADB_URL",
    (url) =>
      new SqlDriver({ url, adapter: "mariadb", tablePrefix: "bun_jobs_test_" }),
  ),
  server(
    "mongodb",
    "BUN_JOBS_TEST_MONGODB_URL",
    (url) => new MongoDriver({ url, pollInterval: 10 }),
  ),
  server("redis", "BUN_JOBS_TEST_REDIS_URL", (url) => new RedisDriver({ url })),
];

/**
 * What a driver declares and what its claims actually record, through a real
 * worker: one job claimed alone, then four claimed as one batch.
 */
async function declaredAndStamped(
  driver: JobsDriver,
): Promise<{ declared: boolean; single: boolean; batch: boolean }> {
  const namespace = testNamespace("attr-cap");
  const jobs = new BunJobs({ namespace, driver });
  cleanups.push(async () => {
    await jobs.close();
    await driver.purge(namespace);
    await driver.close();
  });
  await driver.connect();
  const declared = driver.capabilities.jobAttribution === true;

  /** Runs `ids` through a worker with `concurrency`, returning whether each was stamped by it. */
  const run = async (ids: string[], concurrency: number): Promise<boolean> => {
    const queue = jobs.queue(`cap-${concurrency}`);
    for (const id of ids) {
      await queue.add("work", {}, { jobId: id });
    }
    const key = `key-${concurrency}`;
    const worker = new BunQueueWorker(queue.name, async () => "ok", {
      namespace,
      driver,
      key,
      concurrency,
      pollInterval: 10,
    });
    cleanups.push(async () => await worker.close({ timeout: 2_000 }));
    void worker.run();
    await waitFor(
      async () => {
        for (const id of ids) {
          if ((await queue.getJob(id))?.state !== "completed") {
            return false;
          }
        }
        return true;
      },
      { timeout: 10_000, interval: 10, message: `${ids} completed` },
    );
    await worker.close({ timeout: 2_000 });
    const stamps = await Promise.all(
      ids.map(async (id) => (await queue.getJob(id))?.processedBy),
    );
    return stamps.every(
      (stamp) =>
        stamp?.id === worker.id &&
        stamp.key === key &&
        stamp.host === hostname() &&
        stamp.pid === process.pid,
    );
  };

  const single = await run(["s1"], 1);
  const batch = await run(["b1", "b2", "b3", "b4"], 4);
  return { declared, single, batch };
}

describe.each(BACKENDS)(
  "jobAttribution matches the claim: $name",
  (backend) => {
    it.skipIf(!backend.make)(
      "declares the capability, and its claims stamp the worker, singly and in a batch",
      async () => {
        expect(await declaredAndStamped(await backend.make!())).toEqual({
          declared: true,
          single: true,
          batch: true,
        });
      },
      30_000,
    );
  },
);

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

describe("jobAttribution matches the claim: SQLite table from before the stamp's columns", () => {
  it("declares nothing where nothing can be stamped, and both once synced", async () => {
    const file = await legacyFile();

    expect(
      await declaredAndStamped(new SqlDriver({ url: `sqlite://${file}` })),
    ).toEqual({ declared: false, single: false, batch: false });

    const synced = new SqlDriver({ url: `sqlite://${file}`, syncSchema: true });
    expect(await declaredAndStamped(synced)).toEqual({
      declared: true,
      single: true,
      batch: true,
    });
  }, 30_000);

  it("notices a sync another process ran, without claiming, once its answer is a minute old", async () => {
    // A process serving only the API never claims, so nothing else would
    // tell it the columns arrived.
    const file = await legacyFile();
    const reader = new SqlDriver({ url: `sqlite://${file}` });
    cleanups.push(async () => await reader.close());
    await reader.connect();
    expect(reader.capabilities.jobAttribution).toBe(false);

    const syncer = new SqlDriver({ url: `sqlite://${file}` });
    cleanups.push(async () => await syncer.close());
    await syncer.syncSchema();
    // Within the minute the old answer stands: no probe per read.
    expect(reader.capabilities.jobAttribution).toBe(false);

    try {
      setSystemTime(new Date(Date.now() + 61_000));
      // The first read past the minute starts a probe and still reports the
      // old answer; a later read sees the probe's.
      expect(reader.capabilities.jobAttribution).toBe(false);
      await waitFor(() => reader.capabilities.jobAttribution === true, {
        timeout: 5_000,
        message: "the capability turned on after the re-probe",
      });
    } finally {
      setSystemTime();
    }
  }, 30_000);
});
