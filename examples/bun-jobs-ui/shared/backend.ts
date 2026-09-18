import type { DriverConfig } from "@kingsleyweb/bun-jobs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/**
 * Where an example keeps its jobs: the memory driver by default, or the
 * backend `EXAMPLE_DRIVER` names — the same variable, values and URL
 * variables as the `bun-jobs` examples use.
 *
 * ```bash
 * bun 05-demo/seeded-demo.ts                                  # memory
 * EXAMPLE_DRIVER=sqlite bun 05-demo/seeded-demo.ts --serve    # a temp SQLite file
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://localhost:6379/13 \
 *   bun 05-demo/seeded-demo.ts
 * ```
 *
 * A backend that needs a server and has no URL set skips the example
 * (a `skipped:` line and exit 0), so `bun run-all.ts` stays green without
 * databases.
 */

/** The backends `EXAMPLE_DRIVER` can name. */
export type ExampleBackend =
  | "memory"
  | "file"
  | "sqlite"
  | "postgres"
  | "mysql"
  | "mariadb"
  | "redis"
  | "mongodb";

/** The environment variable holding each server backend's connection URL. */
const URL_VARIABLES = {
  postgres: "EXAMPLE_POSTGRES_URL",
  mysql: "EXAMPLE_MYSQL_URL",
  mariadb: "EXAMPLE_MARIADB_URL",
  redis: "EXAMPLE_REDIS_URL",
  mongodb: "EXAMPLE_MONGODB_URL",
} as const;

/** The prefix given to every table, collection and key on a shared server. */
const EXAMPLE_PREFIX = "bun_jobs_ui_example_";

/** Which backend `EXAMPLE_DRIVER` names. Defaults to `"memory"`. */
export function exampleBackend(): ExampleBackend {
  return (process.env.EXAMPLE_DRIVER ?? "memory") as ExampleBackend;
}

/** A fresh temporary directory, removed when the process exits. */
function tempDir(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `bun-jobs-ui-example-${label}-`));
  process.once("exit", () => {
    rmSync(path, { recursive: true, force: true });
  });
  return path;
}

/** The URL in `variable`, or a `skipped:` line and a clean exit. */
function requireUrl(variable: string, example: string): string {
  const url = process.env[variable];
  if (!url) {
    console.log(
      `skipped: set ${variable} to run this example on EXAMPLE_DRIVER=${exampleBackend()}, e.g. ${variable}=${example}`,
    );
    process.exit(0);
  }
  return url;
}

/** The driver config `EXAMPLE_DRIVER` asks for. `BunJobs` closes what it builds from it. */
export function exampleDriver(): DriverConfig {
  const backend = exampleBackend();
  switch (backend) {
    case "memory":
      return { type: "memory" };
    case "file":
      return { type: "file", root: tempDir("file") };
    case "sqlite":
      return {
        type: "sql",
        url: `sqlite://${join(tempDir("sqlite"), "jobs.db")}`,
      };
    case "postgres":
    case "mysql":
    case "mariadb":
      return {
        type: "sql",
        adapter: backend,
        url: requireUrl(
          URL_VARIABLES[backend],
          `${backend}://user:pass@localhost/jobs`,
        ),
        tablePrefix: EXAMPLE_PREFIX,
      };
    case "redis":
      return {
        type: "redis",
        url: requireUrl(URL_VARIABLES.redis, "redis://localhost:6379/13"),
        keyPrefix: "examples-ui:",
      };
    case "mongodb":
      return {
        type: "mongodb",
        url: requireUrl(URL_VARIABLES.mongodb, "mongodb://localhost/jobs"),
        collectionPrefix: EXAMPLE_PREFIX,
      };
    default:
      throw new Error(
        `EXAMPLE_DRIVER="${backend as string}" is not one of memory, file, sqlite, postgres, mysql, mariadb, redis, mongodb`,
      );
  }
}

/**
 * A namespace for one run. A persistent backend outlives the process, so
 * there a suffix keeps one run from finding what an earlier run left.
 */
export function exampleNamespace(base: string): string {
  return exampleBackend() === "memory"
    ? base
    : `${base}-${Date.now().toString(36)}`;
}
