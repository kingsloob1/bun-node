/**
 * The servers bun-sql's engine suites run against, under the repository's
 * rules (bun-jobs' `__tests__/helpers/backends.ts`, bun-cache's
 * `drivers/backends.ts`):
 *
 * - **Unset**: the backend skips, visibly (`describe.skip("backend X: not
 *   configured")`).
 * - **Set but unreachable**: a named, failing test — a set variable is a claim
 *   of coverage.
 * - **The variable** is `BUN_SQL_TEST_<X>_URL`, falling back to
 *   `BUN_JOBS_TEST_<X>_URL`, so a machine set up for bun-jobs tests bun-sql
 *   with no extra export (`bun scripts/setup-databases.ts --print-env`).
 * - **Own data**: every table or collection a run makes carries the prefix
 *   `bun_sql_test_<pid>_`, and is dropped by its exact name — never a prefix
 *   sweep.
 *
 * SQLite always runs, on a file of its own in the system's temporary
 * directory.
 */
import type { SQL } from "bun";
import type { SqlAdapter } from "../../lib/index";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, it } from "bun:test";
import { openSqlClient } from "../../lib/index";

/** One SQL engine to run a suite on. */
export interface SqlBackend {
  /** The adapter, as in the test titles. */
  readonly name: SqlAdapter;
  /** The variable that points at it (bun-sql's, even when the URL came from the fallback); none for SQLite. */
  readonly variable: string | undefined;
  /** The URL, when one is set (always for SQLite). */
  readonly url: string | undefined;
}

/** The URL for an engine: bun-sql's variable, then bun-jobs'. */
function urlFor(engine: string): string | undefined {
  return (
    process.env[`BUN_SQL_TEST_${engine}_URL`] ||
    process.env[`BUN_JOBS_TEST_${engine}_URL`] ||
    undefined
  );
}

/** A SQLite file for this process, removed when it exits. */
let sqliteDir: string | undefined;

/** The SQLite URL for this process. */
function sqliteUrl(): string {
  if (sqliteDir === undefined) {
    const dir = mkdtempSync(join(tmpdir(), "bun-sql-test-"));
    sqliteDir = dir;
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  }
  return `sqlite://${join(sqliteDir, "test.sqlite")}`;
}

/** Every SQL engine, with its URL resolved from the environment. */
export function sqlBackends(): SqlBackend[] {
  return [
    { name: "sqlite", variable: undefined, url: sqliteUrl() },
    ...(["postgres", "mysql", "mariadb"] as const).map((name) => ({
      name,
      variable: `BUN_SQL_TEST_${name.toUpperCase()}_URL`,
      url: urlFor(name.toUpperCase()),
    })),
  ];
}

/** The MongoDB server, under the same rules. */
export function mongoBackend(): {
  /** The variable that points at it. */
  readonly variable: string;
  /** The URL, when one is set. */
  readonly url: string | undefined;
} {
  return { variable: "BUN_SQL_TEST_MONGODB_URL", url: urlFor("MONGODB") };
}

/** A client on a backend, connecting the way bun-sql's helpers do. */
export function clientFor(backend: SqlBackend): SQL {
  return openSqlClient(backend.name, { url: backend.url! }, "the test", {
    max: 4,
    connectionTimeout: 5,
  });
}

/** Connects once and runs `SELECT 1`; answers the failure, not a boolean. */
export async function reachError(
  backend: SqlBackend,
): Promise<Error | undefined> {
  const sql = clientFor(backend);
  try {
    await sql.unsafe("SELECT 1");
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  } finally {
    await sql.close().catch(() => undefined);
  }
}

/** Registers a failing test for a backend whose URL is set but unreachable. */
export function reportUnreachable(
  /** Backend name, as in the test titles. */
  name: string,
  /** The variable that pointed at it. */
  variable: string,
  /** Why the connection failed. */
  error: Error,
): void {
  describe(`backend ${name}: unreachable`, () => {
    it(`connects to the server ${variable} points at`, () => {
      throw new Error(
        `${variable} (or its BUN_JOBS_TEST_* fallback) is set, but the ${name} server it names could not be reached, so every ${name} test would have been skipped and the run would still have been green. Start the server (bun scripts/setup-databases.ts), fix the URL, or unset the variable to skip ${name} deliberately.\n  ${error.message}`,
        { cause: error },
      );
    });
  });
}

/** Registers the visible skip for a backend with no URL. */
export function reportNotConfigured(name: string, variable: string): void {
  describe.skip(`backend ${name}: not configured`, () => {
    it(`set ${variable} (bun scripts/setup-databases.ts --print-env) to run it`, () => {});
  });
}

/** How many prefixes this process has handed out. */
let prefixes = 0;

/** A fresh table or collection prefix of this run's. */
export function runPrefix(): string {
  prefixes += 1;
  return `bun_sql_test_${process.pid}_${prefixes}_`;
}

/**
 * The reachable backends, each registered for its suite by `register`; an
 * unset one skips visibly and an unreachable one fails, named. Await it at
 * the test file's top level.
 */
export async function forEachSqlBackend(
  register: (backend: SqlBackend) => void,
): Promise<void> {
  for (const backend of sqlBackends()) {
    if (backend.url === undefined) {
      reportNotConfigured(backend.name, backend.variable!);
      continue;
    }
    const unreachable = await reachError(backend);
    if (unreachable !== undefined) {
      reportUnreachable(
        backend.name,
        backend.variable ?? "sqlite",
        unreachable,
      );
      continue;
    }
    register(backend);
  }
}
