import { join } from "node:path";
import { BunQueue, BunQueueWorker, SqlDriver } from "@kingsleyweb/bun-jobs";
/**
 * SQLite, table names, and schema sync.
 *
 * ```bash
 * bun 08-drivers/sqlite-and-schema-sync.ts
 * ```
 *
 * SQLite needs no server: one file, shared by every process on the host
 * (`BEGIN IMMEDIATE`, WAL and a busy timeout make claims exclusive). It is the
 * natural step up from the memory driver.
 *
 * **Schema sync.** Tables are created `IF NOT EXISTS`, so a table an older
 * version created keeps its old shape — schema improvements in an upgrade
 * reach new installs only. `syncSchema` brings an existing database up to
 * date, and the same API works on Postgres, MySQL, MariaDB and MongoDB:
 *
 * - by default it only does what cannot stall a running queue — adding
 *   columns and indexes, dropping and rebuilding its *own* indexes;
 * - changing a column's type rewrites the table under a lock, so it is
 *   reported with `blocking: true, applied: false` unless `alterColumns: true`;
 * - `dryRun: true` reports every change and applies none — a migration plan.
 */
import { Database } from "bun:sqlite";
import { tempDir } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

title("SQLite and schema sync");

const file = join(tempDir("schema"), "jobs.db");

const driver = new SqlDriver({
  url: `sqlite://${file}`,
  tablePrefix: "app_", // app_jobs, app_locks, app_kv, app_events, app_logs
});
await driver.connect();
show("adapter", driver.adapter);

// A second, ordinary connection — to look inside, as a DBA would.
const db = new Database(file);

show(
  "tables",
  db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name),
);

/* ------------------------------------------------------------------ */
step("It is an ordinary queue backend");

const queue = new BunQueue<{ n: number }, number>("work", {
  namespace: "sqlite-example",
  driver,
});
const worker = new BunQueueWorker<{ n: number }, number>(
  "work",
  async (job) => job.data.n * 2,
  { namespace: "sqlite-example", driver, pollInterval: 20 },
);
void worker.run();

for (let n = 1; n <= 3; n++) await queue.add("double", { n });
await waitFor("three jobs", async () => (await queue.count("completed")) === 3);
show("counts", await queue.count());

await worker.close();
await queue.close();

/* ------------------------------------------------------------------ */
step("syncSchema({ dryRun: true }) on a current schema: nothing to do");

show("changes", await driver.syncSchema({ dryRun: true }));

/* ------------------------------------------------------------------ */
step("Simulate an older install: an index this version defines is missing");

/** The driver's own indexes — it names them with an `ix_` convention. */
const indexes = () =>
  db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%ix\\_%' ESCAPE '\\' ORDER BY name",
    )
    .all()
    .map((row) => row.name);

const before = indexes();
show("driver indexes", before);

const victim = before[0];
if (victim) {
  db.run(`DROP INDEX "${victim}"`);
  show("dropped", victim);

  const plan = await driver.syncSchema({ dryRun: true });
  show(
    "dry run — the plan",
    plan.map(({ kind, table, target, blocking, applied, reason }) => ({
      kind,
      table,
      target,
      blocking,
      applied,
      reason,
    })),
  );

  const applied = await driver.syncSchema();
  show(
    "applied",
    applied.map(({ kind, target, applied }) => ({ kind, target, applied })),
  );
  show("index is back", indexes().includes(victim));
  show("dry run again", await driver.syncSchema({ dryRun: true }));
}

/* ------------------------------------------------------------------ */
step("In production: on connect, or in a maintenance window");

show(
  "on every connect (safe changes only)",
  "new SqlDriver({ url, syncSchema: true })",
);
show(
  "in a maintenance window",
  "await driver.syncSchema({ alterColumns: true })",
);

db.close();
await driver.purge("sqlite-example");
await driver.close();
