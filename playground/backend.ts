import type { DriverConfig } from "@kingsleyweb/bun-jobs";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

/**
 * Which backend the playground runs on, chosen with `PLAYGROUND_DRIVER`.
 *
 * - `temp` (default): SQLite in a file of this process's own under
 *   `playground/.data/`, deleted when the playground stops — so, like
 *   `memory`, state is gone on restart. It is the default rather than
 *   `memory` because summoning (`summoning.ts`) needs a backend **another
 *   process** can reach: a summoned worker is a separate process, and the
 *   memory driver is refused by the summon controller.
 * - `memory`: nothing on disk at all, and events are only this process's own
 *   (the badge says `events: local`). Summoning is skipped: the providers are
 *   still listed, but no worker is summoned for `renders`.
 * - `file` / `sqlite`: kept in `playground/.data/`, so a restart keeps every
 *   queue, job and runner.
 * - `postgres`, `mysql`, `mariadb`, `redis`, `mongodb`: need
 *   `PLAYGROUND_URL` (e.g. `redis://localhost:6379/12`). The playground uses
 *   its own table/key prefix, so it never touches the test suites' data.
 *   `bun scripts/setup-databases.ts` provisions local servers.
 */
export type PlaygroundBackend =
  | "temp"
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

/** The backend named by `PLAYGROUND_DRIVER` (default `temp`). */
export function playgroundBackend(): PlaygroundBackend {
  return (process.env.PLAYGROUND_DRIVER ?? "temp") as PlaygroundBackend;
}

/** Whether the backend can be reached from another process, which summoning needs. */
export function isCrossProcess(): boolean {
  return playgroundBackend() !== "memory";
}

/**
 * The `temp` backend's file: named after this process, so two playgrounds in
 * one checkout never share one, and a stale one is recognisable.
 */
const TEMP_DB = join(DATA_DIR, `temp-${process.pid}.db`);

/** The `temp-<pid>.db*` files, with the pid each belongs to. */
function tempFiles(): { file: string; pid: number }[] {
  let names: string[];
  try {
    names = readdirSync(DATA_DIR);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const match = /^temp-(\d+)\.db/.exec(name);
    return match ? [{ file: join(DATA_DIR, name), pid: Number(match[1]) }] : [];
  });
}

/** Whether a process with this pid is alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, but is somebody else's.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Deletes the `temp` backend's files: this process's own when it stops, and
 * on start any a playground left that was killed before it could (its pid is
 * gone). A no-op on every other backend.
 */
export function removeTempData(scope: "mine" | "stale"): void {
  if (playgroundBackend() !== "temp") {
    return;
  }
  for (const { file, pid } of tempFiles()) {
    if (
      scope === "mine"
        ? pid === process.pid
        : pid !== process.pid && !isAlive(pid)
    ) {
      rmSync(file, { force: true });
    }
  }
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
/**
 * Bring an existing SQL or MongoDB schema up to date on connect.
 *
 * The playground keeps its state across restarts (`.data/jobs.db`, or a
 * database server), so its tables usually predate the checkout it runs. A
 * feature whose storage arrived later — the columns that record which worker
 * ran a job, say — then stays honestly OFF on that old table until the schema
 * is synced, and the screens that need it stay hidden. Syncing on connect
 * keeps the playground showing what the current code can do.
 *
 * It is the default sync: it adds columns and builds indexes, and reports but
 * does not perform a column-type rewrite (that needs `alterColumns`, which
 * locks the table). On SQLite an index build does block writers until it
 * finishes — about 1.7 s on a 2M-row table, reported as `blocking: true` — so
 * a big playground file may pause for a moment on the first start after an
 * upgrade. Postgres builds CONCURRENTLY and MySQL/MariaDB online. A real
 * deployment decides this for itself; the playground can.
 */
const SYNC_SCHEMA = true;

export function playgroundDriver(): DriverConfig {
  const backend = playgroundBackend();
  switch (backend) {
    case "temp":
      mkdirSync(DATA_DIR, { recursive: true });
      return { type: "sql", url: `sqlite://${TEMP_DB}` };
    case "memory":
      return { type: "memory" };
    case "file":
      mkdirSync(DATA_DIR, { recursive: true });
      return { type: "file", root: join(DATA_DIR, "file") };
    case "sqlite":
      mkdirSync(DATA_DIR, { recursive: true });
      return {
        type: "sql",
        url: `sqlite://${join(DATA_DIR, "jobs.db")}`,
        syncSchema: SYNC_SCHEMA,
      };
    case "postgres":
    case "mysql":
    case "mariadb":
      return {
        type: "sql",
        adapter: backend,
        url: requireUrl(`${backend}://user:pass@localhost/jobs`),
        tablePrefix: PREFIX,
        syncSchema: SYNC_SCHEMA,
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
        syncSchema: SYNC_SCHEMA,
      };
    default:
      console.error(
        `PLAYGROUND_DRIVER="${backend as string}" is not one of temp, memory, file, sqlite, postgres, mysql, mariadb, redis, mongodb`,
      );
      process.exit(1);
  }
}
