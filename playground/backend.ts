import type { DriverConfig } from "@kingsleyweb/bun-jobs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

/**
 * Which backend the playground runs on, chosen with `PLAYGROUND_DRIVER`.
 *
 * - `memory` (default): nothing to set up; state is gone on restart, and
 *   events are only this process's own (the badge says `events: local`).
 * - `file` / `sqlite`: kept in `playground/.data/`, so a restart keeps every
 *   queue, job and runner.
 * - `postgres`, `mysql`, `mariadb`, `redis`, `mongodb`: need
 *   `PLAYGROUND_URL` (e.g. `redis://localhost:6379/12`). The playground uses
 *   its own table/key prefix, so it never touches the test suites' data.
 *   `bun scripts/setup-databases.ts` provisions local servers.
 */
export type PlaygroundBackend =
  | "memory"
  | "file"
  | "sqlite"
  | "postgres"
  | "mysql"
  | "mariadb"
  | "redis"
  | "mongodb";

/** The prefix for tables, keys and collections on a shared server. */
const PREFIX = "bun_node_playground_";

/** Where the file and SQLite backends keep their data. */
const DATA_DIR = join(import.meta.dir, ".data");

/** The backend named by `PLAYGROUND_DRIVER` (default `memory`). */
export function playgroundBackend(): PlaygroundBackend {
  return (process.env.PLAYGROUND_DRIVER ?? "memory") as PlaygroundBackend;
}

/** `PLAYGROUND_URL`, or a clear exit when it is missing. */
function requireUrl(example: string): string {
  const url = process.env.PLAYGROUND_URL;
  if (!url) {
    console.error(
      `PLAYGROUND_DRIVER=${playgroundBackend()} needs PLAYGROUND_URL, e.g. PLAYGROUND_URL=${example}`,
    );
    process.exit(1);
  }
  return url;
}

/** The driver config for the chosen backend. */
export function playgroundDriver(): DriverConfig {
  const backend = playgroundBackend();
  switch (backend) {
    case "memory":
      return { type: "memory" };
    case "file":
      mkdirSync(DATA_DIR, { recursive: true });
      return { type: "file", root: join(DATA_DIR, "file") };
    case "sqlite":
      mkdirSync(DATA_DIR, { recursive: true });
      return { type: "sql", url: `sqlite://${join(DATA_DIR, "jobs.db")}` };
    case "postgres":
    case "mysql":
    case "mariadb":
      return {
        type: "sql",
        adapter: backend,
        url: requireUrl(`${backend}://user:pass@localhost/jobs`),
        tablePrefix: PREFIX,
      };
    case "redis":
      return {
        type: "redis",
        url: requireUrl("redis://localhost:6379/12"),
        keyPrefix: "bun-node-playground:",
      };
    case "mongodb":
      return {
        type: "mongodb",
        url: requireUrl("mongodb://localhost/jobs"),
        collectionPrefix: PREFIX,
      };
    default:
      console.error(
        `PLAYGROUND_DRIVER="${backend as string}" is not one of memory, file, sqlite, postgres, mysql, mariadb, redis, mongodb`,
      );
      process.exit(1);
  }
}
