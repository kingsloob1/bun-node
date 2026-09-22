import type { SqlAdapter } from "../lib/index";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import { SqlDriver } from "../lib/index";
import { makeJob, makeTmpDir, testNamespace } from "./helpers";

/**
 * The idle pass's reads, rewritten to be index probes.
 *
 * `nextDelayedAt` is now one `MIN` per state on the server engines, combined
 * with `LEAST` — which is NULL on MySQL and MariaDB when either side is, so
 * each side falls back to the other there. The wait's poll asks whether a
 * waiting job exists rather than counting them. Both must answer exactly what
 * they answered before.
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
      notify: false,
    });
  }
  const tmp = await makeTmpDir("bun-jobs-fix-sql-idle");
  cleanups.push(tmp.cleanup);
  return new SqlDriver({ url: `sqlite://${join(tmp.path, "jobs.db")}` });
}

for (const engine of ENGINES) {
  describe(`SQL driver: ${engine.adapter} idle-pass reads`, () => {
    it("answers the earliest delayed or failed due time, with either side missing", async () => {
      const driver = await openDriver(engine);
      const ns = testNamespace("fixsql-next");
      const q = { ns, queue: "next" };

      try {
        expect(await driver.nextDelayedAt(q)).toBeNull();

        // Neither waiting nor finished jobs count.
        await driver.addJobs(q, [
          makeJob({ id: "w", state: "waiting", runAt: 100 }),
          makeJob({ id: "c", state: "completed", runAt: 50, finishedOn: 50 }),
        ]);
        expect(await driver.nextDelayedAt(q)).toBeNull();

        await driver.addJobs(q, [
          makeJob({ id: "f", state: "failed", runAt: 5_000 }),
        ]);
        expect(await driver.nextDelayedAt(q)).toBe(5_000);

        await driver.addJobs(q, [
          makeJob({ id: "d", state: "delayed", runAt: 7_000 }),
        ]);
        expect(await driver.nextDelayedAt(q)).toBe(5_000);

        await driver.addJobs(q, [
          makeJob({ id: "d2", state: "delayed", runAt: 3_000 }),
        ]);
        expect(await driver.nextDelayedAt(q)).toBe(3_000);

        await driver.removeJob(q, "f");
        await driver.removeJob(q, "d2");
        expect(await driver.nextDelayedAt(q)).toBe(7_000);

        // Another queue's jobs are not this one's.
        expect(await driver.nextDelayedAt({ ns, queue: "other" })).toBeNull();
      } finally {
        await driver.purge(ns).catch(() => {});
        await driver.close();
      }
    }, 30_000);

    it("ends a wait on a due waiting job, and not on one that is not due yet", async () => {
      const driver = await openDriver(engine);
      const ns = testNamespace("fixsql-poll");
      const q = { ns, queue: "poll" };
      const now = Date.now();

      try {
        await driver.addJobs(q, [
          makeJob({ id: "later", state: "waiting", runAt: now + 60_000 }),
        ]);
        let started = performance.now();
        await driver.waitForJob(q, 300);
        expect(performance.now() - started).toBeGreaterThanOrEqual(250);

        await driver.addJobs(q, [
          makeJob({ id: "due", state: "waiting", runAt: now - 1 }),
        ]);
        started = performance.now();
        await driver.waitForJob(q, 5_000);
        expect(performance.now() - started).toBeLessThan(1_000);
      } finally {
        await driver.purge(ns).catch(() => {});
        await driver.close();
      }
    }, 30_000);
  });
}
