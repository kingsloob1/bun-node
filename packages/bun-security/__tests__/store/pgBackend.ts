/**
 * The Postgres server the store's suites run against:
 * `BUN_SECURITY_TEST_POSTGRES_URL`, falling back to bun-cache's and
 * bun-jobs' (`bun scripts/setup-databases.ts --print-env`). Unset, the suite
 * skips visibly; set but unreachable, it fails, named. Each case's tables
 * carry a prefix of their own and are dropped by their exact names.
 */
import process from "node:process";
import { SQL } from "bun";
import { describe, it } from "bun:test";
import { storeTables } from "../../lib/store/index";

/** The URL, if one is set. */
export const POSTGRES_URL =
  process.env.BUN_SECURITY_TEST_POSTGRES_URL ||
  process.env.BUN_CACHE_TEST_POSTGRES_URL ||
  process.env.BUN_JOBS_TEST_POSTGRES_URL ||
  undefined;

/** The variable that names it. */
export const VARIABLE = "BUN_SECURITY_TEST_POSTGRES_URL";

let prefixes = 0;

/** A fresh table prefix of this run's (at most 40 characters). */
export function freshPrefix(): string {
  prefixes += 1;
  return `bsec_d2_${process.pid}_${prefixes}_`;
}

/** Drops exactly the store's three tables under `prefix`. */
export async function dropStore(prefix: string): Promise<void> {
  const sql = new SQL(POSTGRES_URL!);
  try {
    for (const table of Object.values(storeTables(prefix))) {
      await sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
    }
  } finally {
    await sql.close();
  }
}

/** Why the server cannot be reached, or `undefined` when it can. */
export async function reachError(): Promise<Error | undefined> {
  const sql = new SQL({ url: POSTGRES_URL!, connectionTimeout: 5 });
  try {
    await sql.unsafe("SELECT 1");
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  } finally {
    await sql.close().catch(() => undefined);
  }
}

/**
 * Registers the visible skip (unset) or the named failure (unreachable);
 * answers whether the suite should register its cases.
 */
export async function postgresAvailable(): Promise<boolean> {
  if (POSTGRES_URL === undefined) {
    describe.skip("backend postgres: not configured", () => {
      it(`set ${VARIABLE} (bun scripts/setup-databases.ts --print-env) to run it`, () => {});
    });
    return false;
  }
  const error = await reachError();
  if (error !== undefined) {
    describe("backend postgres: unreachable", () => {
      it(`connects to the server ${VARIABLE} points at`, () => {
        throw new Error(
          `${VARIABLE} (or its fallback) is set, but the server could not be reached: ${error.message}`,
          { cause: error },
        );
      });
    });
    return false;
  }
  return true;
}
