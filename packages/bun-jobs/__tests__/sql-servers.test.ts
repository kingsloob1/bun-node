import type { SqlAdapter } from "../lib/index";
import process from "node:process";
import { describe, expect, it } from "bun:test";
import { SqlDriver } from "../lib/index";
import { driverContract } from "./helpers/driverContract";

/**
 * The SQL driver against a real database server.
 *
 * SQLite is covered by `sqlite-driver.test.ts` and needs nothing; Postgres,
 * MySQL and MariaDB need a server, so they run only when their URL is set:
 *
 * ```bash
 * BUN_JOBS_TEST_POSTGRES_URL=postgres://user:pass@localhost/jobs bun test
 * BUN_JOBS_TEST_MYSQL_URL=mysql://user:pass@localhost/jobs bun test
 * BUN_JOBS_TEST_MARIADB_URL=mariadb://user:pass@localhost/jobs bun test
 * ```
 *
 * They run the same contract as every other driver, so "supported" means the
 * same thing for all of them. Each uses a unique namespace and purges it, so
 * a shared server can host several runs at once.
 */

/** The servers this suite can reach, if any. */
const SERVERS: { adapter: SqlAdapter; variable: string; url?: string }[] = [
  {
    adapter: "postgres",
    variable: "BUN_JOBS_TEST_POSTGRES_URL",
    url: process.env.BUN_JOBS_TEST_POSTGRES_URL,
  },
  {
    adapter: "mysql",
    variable: "BUN_JOBS_TEST_MYSQL_URL",
    url: process.env.BUN_JOBS_TEST_MYSQL_URL,
  },
  {
    adapter: "mariadb",
    variable: "BUN_JOBS_TEST_MARIADB_URL",
    url: process.env.BUN_JOBS_TEST_MARIADB_URL,
  },
];

for (const server of SERVERS) {
  if (!server.url) {
    describe.skip(`SQL driver: ${server.adapter} (set ${server.variable})`, () => {
      it("is not configured", () => {});
    });
    continue;
  }

  driverContract(server.adapter, async () => ({
    driver: new SqlDriver({
      url: server.url,
      adapter: server.adapter,
      // A prefix per run, so concurrent suites on one server never share a
      // table — the namespace keeps rows apart, this keeps migrations apart.
      tablePrefix: `bun_jobs_test_`,
    }),
  }));
}

describe("SQL driver: engine differences", () => {
  it("knows what each engine can do, so the driver need not guess", async () => {
    const { dialectFor } = await import("../lib/index");

    // Claiming: Postgres and MySQL skip locked rows; SQLite has one write
    // lock and nothing to skip.
    expect(dialectFor("postgres").supportsSkipLocked).toBe(true);
    expect(dialectFor("mysql").supportsSkipLocked).toBe(true);
    expect(dialectFor("sqlite").supportsSkipLocked).toBe(false);

    // Reading back a claim: MariaDB cannot return the updated row, so the
    // driver re-selects by the token instead.
    expect(dialectFor("postgres").supportsReturning).toBe(true);
    expect(dialectFor("sqlite").supportsReturning).toBe(true);
    expect(dialectFor("mariadb").supportsReturning).toBe(false);

    // Placeholders: Postgres numbers them, the others do not.
    expect(dialectFor("postgres").placeholder(3)).toBe("$3");
    expect(dialectFor("mysql").placeholder(3)).toBe("?");

    // MySQL cannot read the table it is updating without a derived table.
    expect(dialectFor("mysql").limitedIdSubquery("SELECT id FROM t")).toContain(
      "AS picked",
    );
    expect(dialectFor("postgres").limitedIdSubquery("SELECT id FROM t")).toBe(
      "SELECT id FROM t",
    );

    // JSON and identifier columns differ; MySQL's index limit bounds ids.
    expect(dialectFor("postgres").jsonType).toBe("JSONB");
    expect(dialectFor("mysql").jsonType).toBe("JSON");
    expect(dialectFor("sqlite").jsonType).toBe("TEXT");
    expect(dialectFor("mysql").idType).toBe("VARCHAR(191)");
  });

  it("decodes a JSON column however the engine returns it", async () => {
    const { dialectFor } = await import("../lib/index");
    const dialect = dialectFor("postgres");

    // Postgres hands back an object, SQLite a string; both arrive the same.
    expect(dialect.jsonOut<unknown>({ a: 1 }, null)).toEqual({ a: 1 });
    expect(dialect.jsonOut<unknown>('{"a":1}', null)).toEqual({ a: 1 });
    expect(dialect.jsonOut(null, "fallback")).toBe("fallback");
    expect(dialect.jsonOut("not json", "fallback")).toBe("fallback");
  });
});
