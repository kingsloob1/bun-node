import type { DriverConfig } from "@kingsleyweb/bun-jobs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/**
 * Where the examples keep their jobs.
 *
 * Every example that does not exist to show one particular backend calls
 * {@link exampleDriver}, so the same script runs against any of them:
 *
 * ```bash
 * bun 02-queues/producer-and-worker.ts                        # memory
 * EXAMPLE_DRIVER=sqlite bun 02-queues/producer-and-worker.ts  # a temp SQLite file
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://localhost:6379/13 \
 *   bun 02-queues/producer-and-worker.ts
 * ```
 */

/** The backends an example can be pointed at with `EXAMPLE_DRIVER`. */
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
export const URL_VARIABLES = {
  postgres: "EXAMPLE_POSTGRES_URL",
  mysql: "EXAMPLE_MYSQL_URL",
  mariadb: "EXAMPLE_MARIADB_URL",
  redis: "EXAMPLE_REDIS_URL",
  mongodb: "EXAMPLE_MONGODB_URL",
} as const;

/** Which backend `EXAMPLE_DRIVER` names. Defaults to `"memory"`. */
export function exampleBackend(): ExampleBackend {
  return (process.env.EXAMPLE_DRIVER ?? "memory") as ExampleBackend;
}

/**
 * A fresh temporary directory, removed when the process exits.
 *
 * The file and SQLite drivers need somewhere to write; a directory per run
 * means an example never reads what an earlier run left behind.
 */
export function tempDir(label: string): string {
  const path = mkdtempSync(join(tmpdir(), `bun-jobs-example-${label}-`));

  process.once("exit", () => {
    rmSync(path, { recursive: true, force: true });
  });

  return path;
}

/**
 * The connection URL in `variable`, or — when it is unset — a line saying how
 * to set it and a clean exit.
 *
 * An example that needs a server skips rather than fails without one, so
 * `bun run-all.ts` stays green on a machine with no databases installed.
 */
export function requireUrl(variable: string, example: string): string {
  const url = process.env[variable];

  if (!url) {
    console.log(`skipped: set ${variable} to run this example, e.g.`);
    console.log(`  ${variable}=${example} bun ${process.argv[1] ?? ""}`);
    process.exit(0);
  }

  return url;
}

/**
 * The prefix the examples give every table, collection and key on a server.
 *
 * A development server is shared — with the package's test suite, with other
 * projects — and tables created with the default names by any earlier version
 * keep that version's shape. A prefix of their own means the examples always
 * create tables in the current shape, and never touch anyone else's.
 */
export const EXAMPLE_PREFIX = "bun_jobs_example_";

/**
 * The driver config `EXAMPLE_DRIVER` asks for.
 *
 * A config rather than an instance, because a config can be handed to a
 * spawned child (the runner examples need that) and `BunJobs` closes a driver
 * it built from one.
 */
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
        keyPrefix: "examples:",
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
 * A driver config that more than one process can share.
 *
 * What `EXAMPLE_DRIVER` asks for, except that the memory default — which
 * lives inside one process — is swapped for a temporary SQLite file. Used by
 * the examples that spawn a child: a runner in `spawn` mode, a consumer that
 * is killed mid-job, a producer and consumers in separate processes.
 */
export function crossProcessDriver(): DriverConfig {
  return exampleBackend() === "memory"
    ? { type: "sql", url: `sqlite://${join(tempDir("shared"), "jobs.db")}` }
    : exampleDriver();
}

/**
 * A namespace for one run of an example.
 *
 * On the memory driver the plain name is used. A persistent backend outlives
 * the process, so there a short suffix keeps one run from finding the jobs an
 * earlier run left — namespaces are how bun-jobs keeps anything apart.
 */
export function exampleNamespace(base: string): string {
  return exampleBackend() === "memory"
    ? base
    : `${base}-${Date.now().toString(36)}`;
}
