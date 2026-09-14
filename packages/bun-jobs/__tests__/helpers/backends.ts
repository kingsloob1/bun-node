import type { DriverConfig } from "../../lib/index";
import { join } from "node:path";
import process from "node:process";
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
 * quietly passing tests that did nothing.
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

/** Whether a driver of this shape can be built and reached. */
async function isAvailable(config: DriverConfig): Promise<boolean> {
  try {
    const driver = createDriver(config);
    await driver.connect();
    await driver.close();
    return true;
  } catch {
    return false;
  }
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
      continue;
    }

    const config = server.toConfig(url);
    backends.push({
      name: server.name,
      config,
      available: await isAvailable(config),
    });
  }

  return backends;
}
