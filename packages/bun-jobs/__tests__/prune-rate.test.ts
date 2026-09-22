import type { DriverConfig, JobsDriver, QueueRef } from "../lib/index";
import { join } from "node:path";
import process from "node:process";
import { noopLogger } from "@kingsleyweb/bun-common";
import { afterAll, describe, expect, it } from "bun:test";
import { BunQueueWorker, createDriver, MemoryDriver } from "../lib/index";
import { makeJob, makeTmpDir, testNamespace, waitFor } from "./helpers";

/**
 * How fast expired jobs leave: the worker's prune sweep, and the drivers'
 * `pruneExpired` beneath it.
 *
 * - **The sweep's rate.** A worker used to call `pruneExpired` once a minute
 *   with a batch of 100, so a queue finishing more than about 1.7 jobs a
 *   second under the default 24-hour retention fell behind for good. One
 *   maintenance tick now keeps taking batches while they come back full.
 * - **What sits ahead of the expired.** The finished sets are ordered by when
 *   a job finished, not when it expires, so a job kept for good can sit ahead
 *   of expired ones. Redis once read only the first `limit` entries, and
 *   `limit` such jobs at the head hid every expired job behind them for good.
 *
 * Memory, file and SQLite always run; each server backend runs when its
 * `BUN_JOBS_TEST_*_URL` is set, and skips visibly otherwise.
 */

/** Work to undo when the file ends: namespaces, drivers, temp directories. */
const cleanups: (() => Promise<unknown>)[] = [];

afterAll(async () => {
  for (const cleanup of cleanups.toReversed()) {
    await cleanup().catch(() => undefined);
  }
});

/** A backend this file runs against. */
interface Backend {
  /** Name shown in the test titles. */
  name: string;
  /** Builds a fresh driver, or `undefined` for the memory driver. */
  config: DriverConfig | undefined;
  /** Why it is skipped, when it is. */
  skip?: string;
}

/** The server backends and the variable naming each one's server. */
const SERVERS: {
  name: string;
  variable: string;
  toConfig: (url: string) => DriverConfig;
}[] = [
  {
    name: "postgres",
    variable: "BUN_JOBS_TEST_POSTGRES_URL",
    toConfig: (url) => ({ type: "sql", url, adapter: "postgres" }),
  },
  {
    name: "mysql",
    variable: "BUN_JOBS_TEST_MYSQL_URL",
    toConfig: (url) => ({ type: "sql", url, adapter: "mysql" }),
  },
  {
    name: "mariadb",
    variable: "BUN_JOBS_TEST_MARIADB_URL",
    toConfig: (url) => ({ type: "sql", url, adapter: "mariadb" }),
  },
  {
    name: "mongodb",
    variable: "BUN_JOBS_TEST_MONGODB_URL",
    toConfig: (url) => ({ type: "mongodb", url }),
  },
  {
    name: "redis",
    variable: "BUN_JOBS_TEST_REDIS_URL",
    toConfig: (url) => ({ type: "redis", url }),
  },
];

const tmp = await makeTmpDir("bun-jobs-prune-rate");
cleanups.push(tmp.cleanup);

const BACKENDS: Backend[] = [
  { name: "memory", config: undefined },
  { name: "file", config: { type: "file", root: join(tmp.path, "file") } },
  {
    name: "sqlite",
    config: { type: "sql", url: `sqlite://${join(tmp.path, "jobs.db")}` },
  },
  ...SERVERS.map((server) => {
    const url = process.env[server.variable];
    return url
      ? { name: server.name, config: server.toConfig(url) }
      : {
          name: server.name,
          config: undefined,
          skip: `${server.variable} is not set`,
        };
  }),
];

/** A connected driver for `backend`, closed when the file ends. */
async function connect(backend: Backend): Promise<JobsDriver> {
  const driver = backend.config
    ? createDriver(backend.config)
    : new MemoryDriver();
  await driver.connect();
  cleanups.push(() => driver.close());
  return driver;
}

/** A namespace of this file's, purged (exactly it) when the file ends. */
function space(driver: JobsDriver, name: string): string {
  const ns = testNamespace(`prune-${name}`);
  // Registered after the driver's close, so it runs before it.
  cleanups.push(() => driver.purge(ns));
  return ns;
}

/**
 * Stores `count` finished jobs, each finished at `finishedAt(index)` and
 * expiring at `expiresAt(index)`, alternating completed and dead.
 */
async function store(
  driver: JobsDriver,
  q: QueueRef,
  count: number,
  prefix: string,
  times: (index: number) => { finishedOn: number; expiresAt: number | null },
): Promise<void> {
  const chunk = 500;
  for (let start = 0; start < count; start += chunk) {
    const jobs = [];
    for (let index = start; index < Math.min(count, start + chunk); index++) {
      const { finishedOn, expiresAt } = times(index);
      jobs.push(
        makeJob({
          id: `${prefix}-${String(index).padStart(6, "0")}`,
          state: index % 2 === 0 ? "completed" : "dead",
          createdAt: finishedOn - 10,
          runAt: finishedOn - 10,
          processedOn: finishedOn - 5,
          finishedOn,
          expiresAt,
        }),
      );
    }
    await driver.addJobs(q, jobs);
  }
}

/** How many finished jobs the queue holds. */
async function finished(driver: JobsDriver, q: QueueRef): Promise<number> {
  const counts = await driver.countJobs(q);
  return counts.completed + counts.dead;
}

for (const backend of BACKENDS) {
  describe.skipIf(backend.skip !== undefined)(
    `prune rate: ${backend.name}${backend.skip ? ` (skipped: ${backend.skip})` : ""}`,
    () => {
      it("one maintenance tick prunes more than one batch", async () => {
        const driver = await connect(backend);
        const ns = space(driver, "tick");
        const q: QueueRef = { ns, queue: "work" };
        const now = Date.now();

        // Two and a half batches' worth, all long expired.
        await store(driver, q, 250, "old", (index) => ({
          finishedOn: now - 60_000 + index,
          expiresAt: now - 30_000,
        }));
        expect(await finished(driver, q)).toBe(250);

        const worker = new BunQueueWorker(q.queue, async () => null, {
          namespace: ns,
          driver,
          logger: noopLogger,
          // Nothing but the first maintenance tick runs in the window below:
          // the next one is a minute away.
          stalledInterval: 60_000,
        });
        cleanups.push(() => worker.close({ force: true }));
        void worker.run();

        // Well inside the minute before the next tick, and no catch-up is
        // owed for a backlog this far under one tick's budget, so only the
        // first tick can have done it.
        await waitFor(async () => (await finished(driver, q)) === 0, {
          timeout: 5_000,
          interval: 20,
          message: async () =>
            `${await finished(driver, q)} of 250 expired jobs are still stored after the first maintenance tick`,
        });
        await worker.close({ force: true });
      });

      it("finds expired jobs behind more kept ones than one batch", async () => {
        const driver = await connect(backend);
        const ns = space(driver, "head");
        const q: QueueRef = { ns, queue: "work" };
        const now = Date.now();

        // Kept for good, and finished first, so they lead the finished sets:
        // 150 of each, more than one batch of either.
        await store(driver, q, 300, "kept", (index) => ({
          finishedOn: now - 120_000 + index,
          expiresAt: null,
        }));
        await store(driver, q, 50, "gone", (index) => ({
          finishedOn: now - 60_000 + index,
          expiresAt: now - 30_000,
        }));

        expect(await driver.pruneExpired(q, now, 100)).toBe(50);
        expect(await finished(driver, q)).toBe(300);
        expect(await driver.getJob(q, "kept-000000")).not.toBeNull();
      });

      it("reaches expired jobs behind a kept head longer than any one call reads", async () => {
        const driver = await connect(backend);
        const ns = space(driver, "long-head");
        const q: QueueRef = { ns, queue: "work" };
        const now = Date.now();

        // Far more than one call reads of each set, however it walks.
        await store(driver, q, 5_000, "kept", (index) => ({
          finishedOn: now - 600_000 + index,
          expiresAt: null,
        }));
        await store(driver, q, 30, "gone", (index) => ({
          finishedOn: now - 60_000 + index,
          expiresAt: now - 30_000,
        }));

        // A bounded number of calls, each bounded in what it reads.
        let removed = 0;
        for (let call = 0; call < 10 && removed < 30; call++) {
          removed += await driver.pruneExpired(q, now, 100);
        }

        expect(removed).toBe(30);
        expect(await finished(driver, q)).toBe(5_000);
      });
    },
  );
}

describe("prune rate: catching up", () => {
  it("clears a backlog larger than one tick's budget without waiting a minute", async () => {
    const driver = new MemoryDriver();
    await driver.connect();
    cleanups.push(() => driver.close());
    const ns = testNamespace("prune-backlog");
    const q: QueueRef = { ns, queue: "work" };
    const now = Date.now();

    // More than the 5,000 one tick removes, so the catch-up has to run.
    await store(driver, q, 12_000, "old", (index) => ({
      finishedOn: now - 60_000 + index,
      expiresAt: now - 30_000,
    }));

    const worker = new BunQueueWorker(q.queue, async () => null, {
      namespace: ns,
      driver,
      logger: noopLogger,
      stalledInterval: 60_000,
    });
    cleanups.push(() => worker.close({ force: true }));
    void worker.run();

    await waitFor(async () => (await finished(driver, q)) === 0, {
      timeout: 5_000,
      interval: 50,
      message: async () =>
        `${await finished(driver, q)} of 12,000 expired jobs are still stored`,
    });
    await worker.close({ force: true });
  });
});
