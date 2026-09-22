import type { SqlAdapter } from "../lib/index";
import process from "node:process";
import { SQL } from "bun";
import { describe, expect, it } from "bun:test";
import { SqlDriver } from "../lib/index";
import { makeJob, testNamespace } from "./helpers";

/**
 * A guarded write that leaves its row exactly as it was still lands.
 *
 * MySQL and MariaDB report the rows an `UPDATE` *changed*, not the rows it
 * matched, and Bun's client offers no `CLIENT_FOUND_ROWS`. So a lock
 * extension writing the expiry the row already holds — `job.touch()` then
 * `job.extendLock()`, or either and the worker's heartbeat, in one
 * millisecond — counted 0, and the driver answered "lock lost" for a lock its
 * holder had. The heartbeat then aborted the job.
 *
 * The write stays one round trip. Only a count of 0 costs a second: a point
 * read asking whether the row matches the write's condition *and* already
 * holds what it wrote. If so, the write was a no-op, and it is as though it
 * ran at the moment of that read.
 */

/** The servers to test against, when configured. */
const SERVERS = (
  [
    ["mysql", process.env.BUN_JOBS_TEST_MYSQL_URL],
    ["mariadb", process.env.BUN_JOBS_TEST_MARIADB_URL],
  ] as [SqlAdapter, string | undefined][]
).filter(([, url]) => url);

/** A client from a test URL, with the parameter Bun takes as an option. */
function client(adapter: SqlAdapter, url: string): SQL {
  return new SQL({
    url: url.replace(/[?&]allowPublicKeyRetrieval=true/, ""),
    adapter,
    allowPublicKeyRetrieval: true,
  } as ConstructorParameters<typeof SQL>[0]);
}

if (SERVERS.length === 0) {
  it.skip("SQL matched rows: set BUN_JOBS_TEST_MYSQL_URL or BUN_JOBS_TEST_MARIADB_URL", () => {});
}

for (const [adapter, url] of SERVERS) {
  describe(`SQL driver: ${adapter} matched rows`, () => {
    it("answers a same-value write by what it matched, in one round trip unless it counted 0", async () => {
      const sql = client(adapter, url!);
      /** Statements sent through the pool, and connections reserved. */
      const sent = { statements: 0, reserved: 0 };
      const counted = new Proxy(sql, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver) as unknown;
          if (key === "unsafe") {
            return (text: string, params?: unknown[]) => {
              sent.statements++;
              return target.unsafe(text, params as never);
            };
          }
          if (key === "reserve") {
            return async () => {
              sent.reserved++;
              return await target.reserve();
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const driver = new SqlDriver({
        sql: counted,
        adapter,
        tablePrefix: "bun_jobs_test_",
      });
      const ns = testNamespace("matched-rows");
      const q = { ns, queue: "matched" };
      const now = Date.now();

      /** The answer `work` gave, with what it sent. */
      const measure = async <T>(work: () => Promise<T>) => {
        sent.statements = 0;
        sent.reserved = 0;
        const answer = await work();
        return {
          answer,
          statements: sent.statements,
          reserved: sent.reserved,
        };
      };

      try {
        await driver.connect();
        await driver.ensureQueue(q);
        await driver.addJob(q, makeJob({ id: "a", runAt: now - 1 }));
        // Claimed with the same lock the first extension writes below.
        const token = "tok";
        await driver.claimJob(q, { workerId: "w", token, lockMs: 30_000, now });

        // Unchanged row: 0 counted, then the read that proves the match.
        expect(
          await measure(() => driver.extendJobLock(q, "a", token, 30_000, now)),
        ).toEqual({ answer: true, statements: 2, reserved: 0 });
        // A changed row: one statement, as C1 made it.
        expect(
          await measure(() =>
            driver.extendJobLock(q, "a", token, 30_000, now + 1),
          ),
        ).toEqual({ answer: true, statements: 1, reserved: 0 });
        // Not the holder: the read finds no match, so still false.
        expect(
          await measure(() =>
            driver.extendJobLock(q, "a", "not-mine", 30_000, now + 1),
          ),
        ).toEqual({ answer: false, statements: 2, reserved: 0 });

        expect(
          await measure(() => driver.updateProgress(q, "a", { pct: 1 })),
        ).toEqual({ answer: true, statements: 1, reserved: 0 });
        expect(
          await measure(() => driver.updateProgress(q, "a", { pct: 1 })),
        ).toEqual({ answer: true, statements: 2, reserved: 0 });
        expect(
          await measure(() => driver.updateProgress(q, "a", "text")),
        ).toEqual({ answer: true, statements: 1, reserved: 0 });
        expect(
          await measure(() => driver.updateProgress(q, "a", "text")),
        ).toEqual({ answer: true, statements: 2, reserved: 0 });
        expect(
          await measure(() => driver.updateProgress(q, "nope", 1)),
        ).toEqual({ answer: false, statements: 2, reserved: 0 });

        const key = "runner:matched";
        expect(
          await measure(() => driver.acquireLock(ns, key, token, 5000, now)),
        ).toEqual({ answer: true, statements: 1, reserved: 0 });
        // Re-acquired to the same expiry: the insert is ignored, the update
        // counts 0, the read proves it.
        expect(
          await measure(() => driver.acquireLock(ns, key, token, 5000, now)),
        ).toEqual({ answer: true, statements: 3, reserved: 0 });
        expect(
          await measure(() => driver.renewLock(ns, key, token, 5000, now)),
        ).toEqual({ answer: true, statements: 2, reserved: 0 });
        expect(
          await measure(() => driver.renewLock(ns, key, token, 6000, now)),
        ).toEqual({ answer: true, statements: 1, reserved: 0 });
        expect(
          await measure(() => driver.renewLock(ns, key, "theirs", 6000, now)),
        ).toEqual({ answer: false, statements: 2, reserved: 0 });
        expect(
          await measure(() => driver.acquireLock(ns, key, "theirs", 6000, now)),
        ).toEqual({ answer: false, statements: 3, reserved: 0 });
      } finally {
        await driver.purge(ns).catch(() => {});
        await driver.close();
        await sql.close();
      }
    });
  });
}
