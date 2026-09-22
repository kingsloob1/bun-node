import type { SqlAdapter } from "../lib/index";
import process from "node:process";
import { SQL } from "bun";
import { describe, expect, it } from "bun:test";
import { SqlDriver } from "../lib/index";
import { makeJob, testNamespace } from "./helpers";

/**
 * MySQL and MariaDB read a write's affected rows off its result.
 *
 * The driver used to ask `ROW_COUNT()`, which answers only about its own
 * connection, so every write outside a transaction reserved a connection and
 * ran in one: reserve, set the isolation level, start, the write,
 * `ROW_COUNT()`, commit — five round trips for one statement. Bun's client
 * reports `affectedRows` on the result, with `ROW_COUNT()`'s meaning, so a
 * write naming its row by primary key is now one round trip. A write over a
 * range keeps its READ COMMITTED transaction, less the `ROW_COUNT()`.
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

for (const [adapter, url] of SERVERS) {
  describe(`SQL driver: ${adapter} affected rows`, () => {
    it("counts changed rows, as ROW_COUNT() does, which is what the driver relies on", async () => {
      const sql = client(adapter, url!);
      const connection = await sql.reserve();
      /** `affectedRows` of a result. */
      const affected = (result: unknown) =>
        (result as { affectedRows: number }).affectedRows;

      try {
        await connection.unsafe(
          "CREATE TEMPORARY TABLE fixsql_affected (id INT PRIMARY KEY, v INT)",
        );
        expect(
          affected(
            await connection.unsafe(
              "INSERT INTO fixsql_affected VALUES (1, 1), (2, 2)",
            ),
          ),
        ).toBe(2);
        // Matched but unchanged is 0: a conditional write that must change
        // its row (a state, a token, a version) reads 0 as "did not land".
        expect(
          affected(
            await connection.unsafe(
              "UPDATE fixsql_affected SET v = 1 WHERE id = 1",
            ),
          ),
        ).toBe(0);
        expect(
          affected(
            await connection.unsafe(
              "UPDATE fixsql_affected SET v = v + 1 WHERE id = 1",
            ),
          ),
        ).toBe(1);
        expect(
          affected(
            await connection.unsafe(
              "INSERT IGNORE INTO fixsql_affected VALUES (1, 9)",
            ),
          ),
        ).toBe(0);
        expect(
          affected(
            await connection.unsafe(
              "INSERT INTO fixsql_affected VALUES (1, 50) ON DUPLICATE KEY UPDATE v = VALUES(v)",
            ),
          ),
        ).toBe(2);
        expect(
          affected(
            await connection.unsafe(
              "DELETE FROM fixsql_affected WHERE id = 99",
            ),
          ),
        ).toBe(0);
        expect(
          affected(await connection.unsafe("DELETE FROM fixsql_affected")),
        ).toBe(2);
      } finally {
        await connection
          .unsafe("DROP TEMPORARY TABLE IF EXISTS fixsql_affected")
          .catch(() => {});
        connection.release();
        await sql.close();
      }
    });

    it("adds, completes and fails a job in one round trip each", async () => {
      const sql = client(adapter, url!);
      /** Statements sent through the pool, and connections reserved. */
      const sent = { statements: [] as string[], reserved: 0 };
      const counted = new Proxy(sql, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver) as unknown;
          if (key === "unsafe") {
            return (text: string, params?: unknown[]) => {
              sent.statements.push(text);
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
      const ns = testNamespace("fixsql-trips");
      const q = { ns, queue: "trips" };
      const now = Date.now();

      try {
        await driver.connect();
        await driver.ensureQueue(q);
        // Warm the pause cache, so its read is not counted below.
        await driver.claimJob(q, {
          workerId: "w",
          token: "warm",
          lockMs: 30_000,
          now,
        });

        /** What `work` sent: statements through the pool, and reservations. */
        const measure = async (work: () => Promise<unknown>) => {
          sent.statements = [];
          sent.reserved = 0;
          await work();
          return {
            statements: sent.statements.length,
            reserved: sent.reserved,
          };
        };

        expect(
          await measure(() =>
            driver.addJob(q, makeJob({ id: "a", runAt: now - 1 })),
          ),
        ).toEqual({ statements: 1, reserved: 0 });

        const token = "tok";
        await driver.claimJob(q, { workerId: "w", token, lockMs: 30_000, now });
        expect(
          await measure(async () => {
            expect(
              await driver.completeJob(q, "a", token, "ok", false, now),
            ).toBe(true);
          }),
        ).toEqual({ statements: 1, reserved: 0 });
        // Not the holder: still judged correctly from the result.
        expect(
          await measure(async () => {
            expect(
              await driver.completeJob(q, "a", token, "ok", false, now),
            ).toBe(false);
          }),
        ).toEqual({ statements: 1, reserved: 0 });

        await driver.addJob(q, makeJob({ id: "b", runAt: now - 1 }));
        await driver.claimJob(q, { workerId: "w", token, lockMs: 30_000, now });
        expect(
          await measure(async () => {
            expect(
              await driver.extendJobLock(q, "b", token, 60_000, now + 1),
            ).toBe(true);
          }),
        ).toEqual({ statements: 1, reserved: 0 });
      } finally {
        await driver.purge(ns).catch(() => {});
        await driver.close();
        await sql.close();
      }
    });
  });
}
