/**
 * A shared store on one SQLite file: two processes (here two engines, each
 * with its own cache and store, as two processes would have) share limits,
 * counted rules and bans.
 *
 * ```bash
 * bun 14-shared-store/sqlite.ts
 * ```
 *
 * - `cacheStore(cache)` from `@kingsleyweb/bun-security/stores` puts the
 *   engine's shared state in any bun-cache backend: Redis, Postgres, MySQL,
 *   MariaDB, MongoDB or a SQLite file (several processes on one host).
 * - A store needs a `secret`, the same in every process sharing it.
 * - Bans are always looked up in memory; a ban is written to the store's ban
 *   log and every process reads it (on the bus where the backend has one,
 *   every `pollInterval` besides, 5 s by default; 200 ms here).
 * - The file is a temporary one, deleted at the end.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteDriver } from "@kingsleyweb/bun-cache";
import { summary } from "../shared/check";
import { title } from "../shared/console";
import { walkTheFleet } from "./helpers/fleet";

title("a shared store on SQLite");

const dir = mkdtempSync(join(tmpdir(), "bun-security-example-"));
try {
  await walkTheFleet(() =>
    sqliteDriver({ path: join(dir, "security.sqlite") }),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

summary();
