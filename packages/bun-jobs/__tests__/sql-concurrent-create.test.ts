/**
 * Several drivers creating the schema at once, on a brand-new table prefix:
 * every `connect()` succeeds.
 *
 * Postgres's `CREATE TABLE IF NOT EXISTS` is not atomic against itself: two
 * sessions both pass the check and the loser fails on the catalog's unique
 * index (`23505` on `pg_type_typname_nsp_index`). Before the migration
 * retried that (`isConcurrentCreate`), a worker and a producer starting
 * together on a fresh database lost one of the two: measured in the
 * high-availability runs (2026-11-03), the worker's `run()` rejected with
 * "sql driver failed during migrate" and it never claimed a job. MySQL,
 * MariaDB and SQLite serialise DDL; they run the same case as a control.
 *
 * Test data: tables under a prefix of each round's own, dropped by name.
 */
import process from "node:process";
import { SQL } from "bun";
import { afterAll, describe, expect, it } from "bun:test";
import { dialectFor } from "../lib/drivers/sql/dialect";
import { SQL_TABLES, SqlDriver } from "../lib/index";
import { takeBooleanParam } from "../lib/shared/connection";
import { reachError, reportUnreachable } from "./helpers/backends";

/** Drivers per round, and rounds per engine: enough for the race to land (it did in every round measured with 4 drivers). */
const DRIVERS = 4;
const ROUNDS = 5;

const SERVERS = [
  { name: "postgres", variable: "BUN_JOBS_TEST_POSTGRES_URL" },
  { name: "mysql", variable: "BUN_JOBS_TEST_MYSQL_URL" },
  { name: "mariadb", variable: "BUN_JOBS_TEST_MARIADB_URL" },
] as const;

describe("isConcurrentCreate", () => {
  it("is Postgres's catalog race only", () => {
    const race = Object.assign(new Error("duplicate key value"), {
      errno: "23505",
    });
    const wrapped = new Error("sql driver failed during migrate", {
      cause: race,
    });
    expect(dialectFor("postgres").isConcurrentCreate(wrapped)).toBe(true);
    expect(
      dialectFor("postgres").isConcurrentCreate(
        Object.assign(new Error("x"), { code: "42710" }),
      ),
    ).toBe(true);
    expect(
      dialectFor("postgres").isConcurrentCreate(new Error("syntax error")),
    ).toBe(false);
    for (const adapter of ["mysql", "mariadb", "sqlite"] as const) {
      expect(dialectFor(adapter).isConcurrentCreate(wrapped)).toBe(false);
    }
  });
});

for (const server of SERVERS) {
  const url = process.env[server.variable];
  if (url === undefined || url === "") {
    describe.skip(`${server.name}: concurrent schema creation — skipped: ${server.variable} is not set`, () => {
      it("skipped", () => {});
    });
    continue;
  }
  const unreachable = await reachError({
    type: "sql",
    url,
    adapter: server.name,
    tablePrefix: `bun_jobs_cc_probe_${process.pid}_`,
  });
  if (unreachable !== undefined) {
    reportUnreachable(server.name, server.variable, unreachable);
    continue;
  }

  describe(`${server.name}: concurrent schema creation`, () => {
    /** Every prefix a round created, dropped by name at the end (and the probe's). */
    const prefixes = [`bun_jobs_cc_probe_${process.pid}_`];

    afterAll(async () => {
      const { url: bare, value: allowKey } = takeBooleanParam(
        url,
        "allowPublicKeyRetrieval",
      );
      const sql =
        server.name === "postgres"
          ? new SQL(bare)
          : new SQL({
              url: bare.replace(/^mariadb:/, "mysql:"),
              allowPublicKeyRetrieval: allowKey ?? false,
            });
      for (const prefix of prefixes) {
        for (const table of SQL_TABLES) {
          await sql.unsafe(`DROP TABLE IF EXISTS ${prefix}${table}`);
        }
      }
      await sql.close();
    }, 60_000);

    it(`${DRIVERS} drivers connecting at once on a fresh prefix all succeed, ${ROUNDS} rounds`, async () => {
      const failures: string[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const prefix = `bun_jobs_cc_${process.pid}_${round}_`;
        prefixes.push(prefix);
        const drivers = Array.from(
          { length: DRIVERS },
          () =>
            new SqlDriver({ url, adapter: server.name, tablePrefix: prefix }),
        );
        const outcomes = await Promise.allSettled(
          drivers.map(async (driver) => await driver.connect()),
        );
        for (const outcome of outcomes) {
          if (outcome.status === "rejected") {
            const cause = (outcome.reason as { cause?: { message?: string } })
              .cause;
            failures.push(
              `round ${round}: ${String(cause?.message ?? outcome.reason)}`,
            );
          }
        }
        await Promise.all(drivers.map(async (driver) => await driver.close()));
      }
      expect(failures).toEqual([]);
    }, 60_000);
  });
}
