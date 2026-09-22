import type { JobFlow, QueueRef } from "../lib/drivers/driver";
import type { SqlAdapter } from "../lib/index";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import { SqlDriver } from "../lib/index";
import { makeJob, makeTmpDir, testNamespace } from "./helpers";

/**
 * Retention sweeps that page past held flow children, and the count sweep
 * that runs once in a stretch of settles rather than on every one.
 *
 * A sweep used to be one `SELECT … LIMIT`, with the "is this a flow child its
 * parent has not recorded yet" check applied in JS afterwards. A page made of
 * held children removed nothing and hid every removable job behind it: the
 * worker's prune took the short batch for "nothing left", and the count sweep
 * kept everything past its 1,000-row window.
 */

/** Every engine available here: SQLite always, the servers when configured. */
const ENGINES: { adapter: SqlAdapter; url?: string }[] = [
  { adapter: "sqlite" },
  ...(
    [
      ["postgres", process.env.BUN_JOBS_TEST_POSTGRES_URL],
      ["mysql", process.env.BUN_JOBS_TEST_MYSQL_URL],
      ["mariadb", process.env.BUN_JOBS_TEST_MARIADB_URL],
    ] as const
  )
    .filter(([, url]) => url)
    .map(([adapter, url]) => ({ adapter, url })),
];

/** Temporary directories to remove when the suite ends. */
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** A driver on `engine`, on the test tables or a fresh SQLite file. */
async function openDriver(engine: {
  adapter: SqlAdapter;
  url?: string;
}): Promise<SqlDriver> {
  if (engine.url) {
    return new SqlDriver({
      url: engine.url,
      adapter: engine.adapter,
      tablePrefix: "bun_jobs_test_",
    });
  }
  const tmp = await makeTmpDir("bun-jobs-fix-sql-retention");
  cleanups.push(tmp.cleanup);
  return new SqlDriver({ url: `sqlite://${join(tmp.path, "jobs.db")}` });
}

/** A flow child whose parent has not recorded its outcome yet. */
const HELD: JobFlow = {
  parent: { queue: "parents", id: "p" },
  children: [],
  pending: 0,
  values: {},
  failures: {},
  recorded: false,
};

/** Claims `id` and completes it under `retention`. */
async function settle(
  driver: SqlDriver,
  q: QueueRef,
  id: string,
  retention: Parameters<SqlDriver["completeJob"]>[4],
  now: number,
): Promise<void> {
  await driver.addJob(q, makeJob({ id, runAt: now - 1, createdAt: now - 1 }));
  const claimed = await driver.claimJob(q, {
    workerId: "w",
    token: `t-${id}`,
    lockMs: 30_000,
    now,
  });
  expect(claimed?.id).toBe(id);
  expect(await driver.completeJob(q, id, `t-${id}`, null, retention, now)).toBe(
    true,
  );
}

for (const engine of ENGINES) {
  describe(`SQL driver: ${engine.adapter} retention sweeps`, () => {
    it("prunes past a page of held flow children", async () => {
      const driver = await openDriver(engine);
      const ns = testNamespace("fixsql-prune");
      const q = { ns, queue: "prune" };
      const now = Date.now();

      try {
        // Held children first in every order an engine might read them in —
        // id, due time and expiry — so the first page is all held.
        await driver.addJobs(q, [
          ...[...Array.from({ length: 5 }).keys()].map((index) =>
            makeJob({
              id: `a-held-${index}`,
              state: "completed",
              runAt: now - 20_000 + index,
              finishedOn: now - 20_000 + index,
              expiresAt: now - 20_000 + index,
              flow: HELD,
            }),
          ),
          ...[...Array.from({ length: 5 }).keys()].map((index) =>
            makeJob({
              id: `b-plain-${index}`,
              state: "completed",
              runAt: now - 10_000 + index,
              finishedOn: now - 10_000 + index,
              expiresAt: now - 10_000 + index,
            }),
          ),
        ]);

        // A full batch: the worker reads it as "more may be left".
        expect(await driver.pruneExpired(q, now, 5)).toBe(5);
        expect((await driver.countJobs(q)).completed).toBe(5);
        for (let index = 0; index < 5; index++) {
          expect(await driver.getJob(q, `a-held-${index}`)).not.toBeNull();
        }
        expect(await driver.pruneExpired(q, now, 5)).toBe(0);
      } finally {
        await driver.purge(ns).catch(() => {});
        await driver.close();
      }
    }, 60_000);

    it("sweeps by count past more held children than one sweep reads", async () => {
      const driver = await openDriver(engine);
      const ns = testNamespace("fixsql-count");
      const q = { ns, queue: "count" };
      const now = Date.now();

      try {
        // 1,000 held children fill the whole window a sweep used to read,
        // with five removable jobs older than all of them.
        await driver.addJobs(q, [
          ...[...Array.from({ length: 1000 }).keys()].map((index) =>
            makeJob({
              id: `held-${String(index).padStart(4, "0")}`,
              state: "completed",
              finishedOn: now - 10_000 + index,
              flow: HELD,
            }),
          ),
          ...[...Array.from({ length: 5 }).keys()].map((index) =>
            makeJob({
              id: `old-${index}`,
              state: "completed",
              finishedOn: now - 60_000 + index,
            }),
          ),
        ]);

        await settle(driver, q, "newest", 1, now);

        expect(await driver.getJob(q, "newest")).not.toBeNull();
        for (let index = 0; index < 5; index++) {
          expect(await driver.getJob(q, `old-${index}`)).toBeNull();
        }
        expect((await driver.countJobs(q)).completed).toBe(1001);
      } finally {
        await driver.purge(ns).catch(() => {});
        await driver.close();
      }
    }, 60_000);

    it("keeps a small count exact on every settle", async () => {
      const driver = await openDriver(engine);
      const ns = testNamespace("fixsql-exact");
      const q = { ns, queue: "exact" };
      const now = Date.now();

      try {
        for (let index = 0; index < 8; index++) {
          await settle(driver, q, `job-${index}`, { count: 3 }, now + index);
          expect((await driver.countJobs(q)).completed).toBe(
            Math.min(3, index + 1),
          );
        }
        // The newest three, by finish time.
        for (const id of ["job-5", "job-6", "job-7"]) {
          expect(await driver.getJob(q, id)).not.toBeNull();
        }
      } finally {
        await driver.purge(ns).catch(() => {});
        await driver.close();
      }
    }, 60_000);

    it("sweeps a larger count once per tenth of it, down to the count", async () => {
      const driver = await openDriver(engine);
      const ns = testNamespace("fixsql-amortised");
      const q = { ns, queue: "amortised" };
      const now = Date.now();
      /** The count kept; a sweep runs every `COUNT / 10` settles. */
      const COUNT = 30;

      try {
        // Left over by an earlier process: the first settle sweeps it away.
        await driver.addJobs(
          q,
          [...Array.from({ length: 40 }).keys()].map((index) =>
            makeJob({
              id: `left-${String(index).padStart(2, "0")}`,
              state: "completed",
              finishedOn: now - 100_000 + index,
            }),
          ),
        );
        await settle(driver, q, "s-00", COUNT, now);
        expect((await driver.countJobs(q)).completed).toBe(COUNT);

        const seen: number[] = [];
        for (let index = 1; index <= 9; index++) {
          await settle(
            driver,
            q,
            `s-${String(index).padStart(2, "0")}`,
            COUNT,
            now + index,
          );
          seen.push((await driver.countJobs(q)).completed);
        }

        // Never more than the slack over, and back to exactly `COUNT` on
        // every third settle.
        expect(seen).toEqual([31, 32, 30, 31, 32, 30, 31, 32, 30]);
        expect(await driver.getJob(q, "s-09")).not.toBeNull();
        expect(await driver.getJob(q, "left-19")).toBeNull();
        expect(await driver.getJob(q, "left-20")).not.toBeNull();
      } finally {
        await driver.purge(ns).catch(() => {});
        await driver.close();
      }
    }, 60_000);
  });
}
