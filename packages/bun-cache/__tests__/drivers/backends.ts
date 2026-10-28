/**
 * The SQL servers bun-cache's driver suites run against (plan §13.2): the
 * same rules as bun-jobs' `__tests__/helpers/backends.ts`.
 *
 * - **Unset**: the backend skips, visibly (`describe.skip("backend X: not
 *   configured")`).
 * - **Set but unreachable**: a named, failing test — a set variable is a
 *   claim of coverage, and a skip, however loud, is still a green run.
 * - **The variable** is `BUN_CACHE_TEST_<X>_URL`, falling back to
 *   `BUN_JOBS_TEST_<X>_URL`, so a machine set up for bun-jobs tests bun-cache
 *   with no extra export. `bun scripts/setup-databases.ts` provides both.
 * - **Own data**: each run's tables carry the prefix `bun_cache_test_<pid>_`,
 *   and the run drops exactly those tables — never a prefix sweep.
 *
 * No `bun:test` here: the visible skip and the named failure are registered
 * by `sqlSuite.ts`.
 */
import process from "node:process";
import { SQL } from "bun";
import type { CacheDriver } from "../../lib/index";
import { mariadbDriver, mysqlDriver, postgresDriver } from "../../lib/index";
import type { MysqlDriverOptions } from "../../lib/drivers/mysql";
import type { PostgresDriverOptions } from "../../lib/drivers/postgres";
import { sqlClientOptions } from "../../lib/drivers/sql-connection";

/** One SQL server backend. */
export interface SqlBackend {
  /** `postgres`, `mysql` or `mariadb`, as in the test titles. */
  name: "postgres" | "mysql" | "mariadb";
  /** The variable that points at it (the bun-cache one, even when the URL came from the fallback). */
  variable: string;
  /** The URL, when one is set. */
  url: string | undefined;
  /** The factory's export name in its module, for the kit's two-process pass. */
  exportName: "postgresDriver" | "mysqlDriver" | "mariadbDriver";
  /** The module the factory lives in, as an absolute path. */
  module: string;
  /** Builds a driver on this backend. */
  make: (options: PostgresDriverOptions & MysqlDriverOptions) => CacheDriver;
}

/** Every SQL backend, with its URL resolved from the environment. */
export function sqlBackends(): SqlBackend[] {
  const url = (engine: string): string | undefined =>
    process.env[`BUN_CACHE_TEST_${engine}_URL`] ||
    process.env[`BUN_JOBS_TEST_${engine}_URL`] ||
    undefined;
  const postgresModule = new URL(
    "../../lib/drivers/postgres.ts",
    import.meta.url,
  ).pathname;
  const mysqlModule = new URL("../../lib/drivers/mysql.ts", import.meta.url)
    .pathname;
  return [
    {
      name: "postgres",
      variable: "BUN_CACHE_TEST_POSTGRES_URL",
      url: url("POSTGRES"),
      exportName: "postgresDriver",
      module: postgresModule,
      make: postgresDriver,
    },
    {
      name: "mysql",
      variable: "BUN_CACHE_TEST_MYSQL_URL",
      url: url("MYSQL"),
      exportName: "mysqlDriver",
      module: mysqlModule,
      make: mysqlDriver,
    },
    {
      name: "mariadb",
      variable: "BUN_CACHE_TEST_MARIADB_URL",
      url: url("MARIADB"),
      exportName: "mariadbDriver",
      module: mysqlModule,
      make: mariadbDriver,
    },
  ];
}

/** The run's table prefix: its own tables, dropped by {@link dropTables}. */
export function runPrefix(suffix = ""): string {
  return `bun_cache_test_${process.pid}_${suffix}`;
}

/** A raw client on a backend's URL, connecting the way the driver does. */
export function rawClient(backend: SqlBackend): SQL {
  return new SQL(sqlClientOptions(backend.name, { url: backend.url! }, "test"));
}

/** Drops exactly the tables a prefix names (never a pattern). */
export async function dropTables(
  backend: SqlBackend,
  prefix: string,
): Promise<void> {
  const sql = rawClient(backend);
  try {
    for (const table of ["entries", "tags", "stamps", "locks", "bus"]) {
      await sql.unsafe(`DROP TABLE IF EXISTS ${prefix}${table}`);
    }
  } finally {
    await sql.close();
  }
}

/** Connects once to see whether the server is there; answers the failure, not a boolean. */
export async function reachError(
  backend: SqlBackend,
): Promise<Error | undefined> {
  const driver = backend.make({
    url: backend.url,
    prefix: runPrefix("probe_"),
  });
  try {
    await driver.connect!();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  } finally {
    await driver.close().catch(() => undefined);
    await dropTables(backend, runPrefix("probe_")).catch(() => undefined);
  }
}
