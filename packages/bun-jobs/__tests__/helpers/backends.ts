import type { DriverConfig } from "../../lib/index";
import { join } from "node:path";
import process from "node:process";
import { describe, it } from "bun:test";
import { createDriver } from "../../lib/index";
import { makeTmpDir } from "../helpers";

/**
 * The backends the cross-process suites run against.
 *
 * There is one list, deliberately. Each suite used to keep its own, and the
 * lists drifted: MariaDB was added to one and forgotten in the other, so it
 * ran the driver contract and never once had two processes contend over it.
 * A backend added here is picked up by every suite that matters.
 *
 * A backend with no server configured is *skipped*, visibly, rather than
 * quietly passing tests that did nothing. A backend whose variable is set but
 * whose server cannot be reached is a *failure* — see `reportUnreachable`.
 */

/** A backend a spawned process can build for itself. */
export interface Backend {
  /** Name shown in the test titles. */
  name: string;
  /**
   * How to build it. A config, not an instance: a driver cannot cross a
   * process boundary, but a description of one can.
   */
  config: DriverConfig;
  /** Whether a server is actually reachable. */
  available: boolean;
}

/** A server-backed backend and the variable that points at it. */
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

/**
 * Connects once to see whether a server of this shape is really there.
 *
 * Returns the failure rather than a boolean, because the two callers want
 * different things from it and a boolean throws the interesting half away:
 * "unreachable" and "not configured" are the same bit, and that is exactly the
 * confusion this module exists to prevent.
 */
export async function reachError(
  config: DriverConfig,
): Promise<Error | undefined> {
  try {
    const driver = createDriver(config);
    await driver.connect();
    await driver.close();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Registers a failing test for a backend whose URL is set but whose server
 * cannot be reached.
 *
 * **A set variable is a claim of coverage, so a broken one fails rather than
 * skips.** Setting `BUN_JOBS_TEST_MYSQL_URL` says "I have a MySQL server, test
 * against it"; leaving it unset says "I do not". Treating an unreachable server
 * as unconfigured collapses those two into one, and the suite then reports a
 * clean pass for an engine it never touched — measured at 272 pass / 0 fail
 * before this, against 238 pass / 36 silent skips with the port changed by one
 * digit. A skip, however loud, is still a green run; only a failure reliably
 * tells you your coverage is missing.
 *
 * The backend is still marked unavailable, so the rest of the file skips
 * instead of producing a storm of connection timeouts on top of this one
 * named, explained failure.
 */
export function reportUnreachable(
  /** Backend name, as it appears in the test titles. */
  name: string,
  /** The variable that pointed at it, so the reader knows what to fix. */
  variable: string,
  /** Why the connection failed. */
  error: Error,
): void {
  describe(`backend ${name}: unreachable`, () => {
    it(`connects to the server ${variable} points at`, () => {
      throw new Error(
        `${variable} is set, but the ${name} server it names could not be reached, so every ${name} test would have been skipped and the run would still have been green. Start the server (bun scripts/setup-databases.ts), fix the URL, or unset the variable to skip ${name} deliberately.\n  ${error.message}`,
        { cause: error },
      );
    });
  });
}

/**
 * Every backend that can carry work between processes, with its availability
 * already resolved so a suite can skip rather than discover it mid-test.
 *
 * The memory driver is absent on purpose: it says `multiProcess: false`, and
 * these suites are about what happens when it is `true`.
 */
export async function crossProcessBackends(options?: {
  /** Temp-directory cleanups to register, for the file and sqlite backends. */
  cleanups?: (() => Promise<void>)[];
}): Promise<Backend[]> {
  const backends: Backend[] = [];

  // Two backends need no server, so they always run.
  const fileDir = await makeTmpDir("bun-jobs-xproc-file");
  options?.cleanups?.push(fileDir.cleanup);
  backends.push({
    name: "file",
    config: { type: "file", root: join(fileDir.path, "driver") },
    available: true,
  });

  const sqliteDir = await makeTmpDir("bun-jobs-xproc-sqlite");
  options?.cleanups?.push(sqliteDir.cleanup);
  backends.push({
    name: "sqlite",
    config: { type: "sql", url: `sqlite://${join(sqliteDir.path, "jobs.db")}` },
    available: true,
  });

  for (const server of SERVERS) {
    const url = process.env[server.variable];
    if (!url) {
      // Registered rather than merely skipped over: dropping the backend from
      // the list silently is how a suite reports "56 pass, 0 skip" on seven
      // backends and "56 pass, 0 skip" on eight. The unset case is meant to be
      // a *visible* skip, so it needs something in the output to be visible in.
      describe.skip(`backend ${server.name}: not configured`, () => {
        it(`runs when ${server.variable} is set`, () => {});
      });
      continue;
    }

    const config = server.toConfig(url);
    const error = await reachError(config);
    if (error) {
      reportUnreachable(server.name, server.variable, error);
    }

    backends.push({
      name: server.name,
      config,
      available: error === undefined,
    });
  }

  return backends;
}
