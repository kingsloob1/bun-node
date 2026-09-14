import type { JobsDriver, SchemaChange } from "../lib/index";
import process from "node:process";
import { SQL } from "bun";
import { afterAll, describe, expect, it } from "bun:test";
import { resolveSyncOptions } from "../lib/drivers/schemaSync";
import { createSchema, schemaDefinition } from "../lib/drivers/sql/schema";
import { syncSqlSchema } from "../lib/drivers/sql/sync";
import { ConfigError, dialectFor, MongoDriver, SqlDriver } from "../lib/index";
import { takeBooleanParam } from "../lib/shared/connection";
import { queueEvent } from "../lib/shared/events";
import { makeJob, testNamespace, waitFor } from "./helpers";

/**
 * Bringing an existing database in line with the schema the current version
 * expects.
 *
 * The schema is created with `IF NOT EXISTS`, so a table an earlier version
 * created keeps its original shape for good — which means every schema
 * improvement that ships with an upgrade reaches new installs only. These
 * cover the other case: a table that is already there and wrong.
 *
 * Each builds a stale schema on purpose and then checks the sync repaired it.
 * Running only against a fresh database would pass whether or not any of this
 * worked, which is most of the value here.
 */

/** The servers to test against, when they are configured. */
const POSTGRES = process.env.BUN_JOBS_TEST_POSTGRES_URL;
const MONGODB = process.env.BUN_JOBS_TEST_MONGODB_URL;

/**
 * One connection for every helper in this file.
 *
 * Opened lazily and shared, rather than one per call: each test also builds a
 * driver with a pool of its own, and a connection per statement on top of that
 * exhausts Postgres's `max_connections` partway through the file — which shows
 * up as `sorry, too many clients already` on whichever test happens to be
 * running, not on the one that caused it.
 */
let shared: SQL | undefined;

/** The shared connection, opened on first use. */
function connection(): SQL {
  shared ??= new SQL(POSTGRES!);
  return shared;
}

/** Drivers to close when the suite ends. */
const drivers: JobsDriver[] = [];
/** Table prefixes to drop when the suite ends. */
const prefixes: string[] = [];

afterAll(async () => {
  await Promise.allSettled(drivers.map((driver) => driver.close()));

  if (POSTGRES && prefixes.length > 0) {
    for (const prefix of prefixes) {
      for (const table of ["jobs", "locks", "kv", "events", "logs"]) {
        await connection()
          .unsafe(`DROP TABLE IF EXISTS ${prefix}${table} CASCADE`)
          .catch(() => undefined);
      }
    }
  }

  await shared?.close().catch(() => undefined);
});

/** A prefix nothing else in the suite uses, ending in `_` as the naming wants. */
function makePrefix(label: string): string {
  const prefix = `sy_${label}_${Math.random().toString(36).slice(2, 8)}_`;
  prefixes.push(prefix);
  return prefix;
}

/** SQL drivers made so far, closed as the next one is made. */
const sqlDrivers: SqlDriver[] = [];

/**
 * A driver on its own tables, so one case cannot disturb another.
 *
 * Each closes the ones before it. A driver holds a connection pool, and this
 * file makes one per test — kept open to the end they exhaust Postgres's
 * `max_connections` partway through, which surfaces as `sorry, too many
 * clients already` on whichever test happens to be running rather than on the
 * one that caused it. No test needs a driver after its own.
 */
function makeSqlDriver(
  prefix: string,
  options: { syncSchema?: boolean; eventRetentionMs?: number } = {},
): SqlDriver {
  const previous = sqlDrivers.splice(0, sqlDrivers.length);
  for (const stale of previous) {
    void stale.close().catch(() => undefined);
  }

  const driver = new SqlDriver({
    url: POSTGRES,
    tablePrefix: prefix,
    notify: false,
    ...options,
  });
  sqlDrivers.push(driver);
  drivers.push(driver);
  return driver;
}

/** Runs DDL the driver has no API for, which is the point of these tests. */
async function ddl(statements: string[]): Promise<void> {
  for (const statement of statements) await connection().unsafe(statement);
}

/** Reads back whatever the database says, for the assertions. */
async function query<T>(text: string): Promise<T[]> {
  return (await connection().unsafe(text)) as T[];
}

describe.skipIf(!POSTGRES)("schema sync: SQL", () => {
  it("finds nothing to do against the schema it just created", async () => {
    const driver = makeSqlDriver(makePrefix("fresh"));
    await driver.connect();

    // The baseline everything else is measured against. If a freshly created
    // schema reported drift, every "it repaired it" assertion below would be
    // meaningless — and a sync that ran on connect would never settle.
    expect(await driver.syncSchema({ dryRun: true })).toEqual([]);
  }, 45_000);

  it("adds a column an older schema never had", async () => {
    const prefix = makePrefix("col");
    const driver = makeSqlDriver(prefix);
    await driver.connect();
    await ddl([`ALTER TABLE ${prefix}jobs DROP COLUMN repeat_key`]);

    const planned = await driver.syncSchema({ dryRun: true });
    expect(planned.map((c) => [c.kind, c.target])).toEqual([
      ["add-column", "repeat_key"],
    ]);
    expect(planned[0]!.applied).toBe(false);
    expect(planned[0]!.blocking).toBe(false);

    const applied = await driver.syncSchema();
    expect(applied[0]!.applied).toBe(true);
    expect(await driver.syncSchema({ dryRun: true })).toEqual([]);
  }, 45_000);

  it("drops an index the driver no longer defines", async () => {
    const prefix = makePrefix("ix");
    const driver = makeSqlDriver(prefix);
    await driver.connect();

    // `ix_..._done` is exactly this case: dropped as redundant with
    // `ix_..._claim`'s prefix, but an older deployment still pays a write per
    // insert for it.
    const stale = `ix_${prefix}jobs_done`;
    await ddl([
      `CREATE INDEX ${stale} ON ${prefix}jobs (ns, queue, state, finished_on)`,
    ]);

    expect(
      (await driver.syncSchema({ dryRun: true })).map((c) => [
        c.kind,
        c.target,
      ]),
    ).toEqual([["drop-index", stale]]);

    await driver.syncSchema();
    expect(await driver.syncSchema({ dryRun: true })).toEqual([]);
  }, 45_000);

  it("leaves an index it did not create alone", async () => {
    const prefix = makePrefix("keep");
    const driver = makeSqlDriver(prefix);
    await driver.connect();

    // Outside the driver's own `ix_` naming, so it is somebody else's.
    // Dropping it would be the worst thing a sync could do.
    const mine = `by_hand_${prefix}idx`;
    await ddl([`CREATE INDEX ${mine} ON ${prefix}jobs (name)`]);

    expect(await driver.syncSchema({ dryRun: true })).toEqual([]);
    await driver.syncSchema();

    const found = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = '${prefix}jobs'`,
    );
    expect(found.map((r) => String(r.indexname))).toContain(mine);
  }, 45_000);

  it("rebuilds an index whose predicate changed", async () => {
    const prefix = makePrefix("part");
    const driver = makeSqlDriver(prefix);
    await driver.connect();

    // The pre-partial shape of `ix_..._exp`: an entry for every row, including
    // the overwhelming majority whose `expires_at` is null.
    const name = `ix_${prefix}jobs_exp`;
    await ddl([
      `DROP INDEX ${name}`,
      `CREATE INDEX ${name} ON ${prefix}jobs (expires_at)`,
    ]);

    expect(
      (await driver.syncSchema({ dryRun: true })).map((c) => c.kind),
    ).toEqual(["drop-index", "create-index"]);

    await driver.syncSchema();

    const [row] = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = '${prefix}jobs' AND indexname = '${name}'`,
    );
    expect(String(row?.indexdef)).toContain("WHERE");
    expect(await driver.syncSchema({ dryRun: true })).toEqual([]);
  }, 45_000);

  it("builds the code-point index on kv concurrently, as a safe change", async () => {
    const prefix = makePrefix("kvord");
    const driver = makeSqlDriver(prefix);
    await driver.connect();

    // An install from before `listQueueState` had an index to range over.
    const name = `ix_${prefix}jobs_kv_order`;
    await ddl([`DROP INDEX ${name}`]);

    const planned = await driver.syncSchema({ dryRun: true });
    expect(planned.map((c) => [c.kind, c.target, c.blocking])).toEqual([
      ["create-index", name, false],
    ]);
    expect(planned[0]!.statement).toBe(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON ${prefix}kv (ns, kv_key COLLATE "C")`,
    );

    // Safe, so a plain sync makes it.
    expect((await driver.syncSchema())[0]!.applied).toBe(true);
    expect(await driver.syncSchema({ dryRun: true })).toEqual([]);

    const [row] = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = '${prefix}kv' AND indexname = '${name}'`,
    );
    expect(String(row?.indexdef)).toContain(`kv_key COLLATE "C"`);
  }, 45_000);

  it("rebuilds the code-point index when it lost its collation", async () => {
    const prefix = makePrefix("kvcoll");
    const driver = makeSqlDriver(prefix);
    await driver.connect();

    // The right name over the wrong order: the default collation, which the
    // primary key already provides and which cannot bound a `COLLATE "C"`
    // range.
    const name = `ix_${prefix}jobs_kv_order`;
    await ddl([
      `DROP INDEX ${name}`,
      `CREATE INDEX ${name} ON ${prefix}kv (ns, kv_key)`,
    ]);

    const planned = await driver.syncSchema({ dryRun: true });
    expect(planned.map((c) => [c.kind, c.target, c.blocking])).toEqual([
      ["drop-index", name, false],
      ["create-index", name, false],
    ]);
    expect(planned[0]!.reason).toMatch(/collation/);

    await driver.syncSchema();
    expect(await driver.syncSchema({ dryRun: true })).toEqual([]);
  }, 45_000);

  it("reports a column retype but will not make it unasked", async () => {
    const prefix = makePrefix("type");
    const driver = makeSqlDriver(prefix);
    await driver.connect();

    // `jsonb` is what this driver used to create. Converting it rewrites the
    // table under a lock that stops the queue, so a plain sync must decline.
    await ddl([
      `ALTER TABLE ${prefix}jobs ALTER COLUMN data TYPE jsonb USING data::jsonb`,
    ]);

    const planned = await driver.syncSchema({ dryRun: true });
    expect(planned.map((c) => [c.kind, c.target])).toEqual([
      ["alter-column", "data"],
    ]);
    expect(planned[0]!.blocking).toBe(true);

    // Seen, reported, and left alone.
    expect((await driver.syncSchema())[0]!.applied).toBe(false);
    expect(
      String(
        (
          await query<{ data_type: string }>(
            `SELECT data_type FROM information_schema.columns
              WHERE table_name = '${prefix}jobs' AND column_name = 'data'`,
          )
        )[0]?.data_type,
      ),
    ).toBe("jsonb");

    // Asked for by name, it does it.
    expect((await driver.syncSchema({ alterColumns: true }))[0]!.applied).toBe(
      true,
    );
    expect(await driver.syncSchema({ dryRun: true })).toEqual([]);
  }, 60_000);

  it("repairs on connect when the option says to", async () => {
    const prefix = makePrefix("auto");
    const first = makeSqlDriver(prefix);
    await first.connect();
    await ddl([`ALTER TABLE ${prefix}jobs DROP COLUMN worker_id`]);

    // A second driver over the same tables, told to reconcile as it connects.
    // This is also what proves connecting cannot deadlock on its own sync.
    const second = makeSqlDriver(prefix, { syncSchema: true });
    await second.connect();

    expect(await second.syncSchema({ dryRun: true })).toEqual([]);
  }, 45_000);

  it("creates the log table an install from before job logs never had", async () => {
    const prefix = makePrefix("logs");
    const first = makeSqlDriver(prefix);
    await first.connect();

    // What a deployment upgrading from a version without job logs has: every
    // other table, and no log table or its index.
    await ddl([`DROP TABLE ${prefix}logs`]);

    // A whole new table is not a sync's to add — the sync only compares what
    // exists — so this is really asserting that connecting creates it, and
    // that nothing about it is then reported as drift.
    const second = makeSqlDriver(prefix, { syncSchema: true });
    await second.connect();
    expect(await second.syncSchema({ dryRun: true })).toEqual([]);

    const found = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = '${prefix}logs'`,
    );
    expect(found.map((r) => String(r.indexname))).toContain(
      `ix_${prefix}jobs_logs`,
    );

    // And the upgraded install can actually keep a log.
    const q = { ns: testNamespace(), queue: "logs-after-upgrade" };
    await second.addJob(q, makeJob({ id: "logged" }));
    expect(await second.addJobLog(q, "logged", "hello", 0)).toBe(1);
    expect(
      await second.getJobLogs(q, "logged", {
        offset: 0,
        limit: 10,
        order: "asc",
      }),
    ).toEqual({ logs: ["hello"], count: 1 });
  }, 45_000);

  it("says how to get job logs on a jobs table without log_key, and sync adds it", async () => {
    const prefix = makePrefix("logkey");
    const first = makeSqlDriver(prefix);
    await first.connect();

    // A `jobs` table from before job logs: `CREATE TABLE IF NOT EXISTS` leaves
    // it exactly as it is, so the column only arrives through a sync.
    await ddl([`ALTER TABLE ${prefix}jobs DROP COLUMN log_key`]);

    const driver = makeSqlDriver(prefix);
    const q = { ns: testNamespace(), queue: "logs-unsynced" };
    await driver.addJob(q, makeJob({ id: "unsynced" }));

    // The engine's "column does not exist" names neither the feature nor the
    // fix, so the driver says both.
    const failure = await driver
      .addJobLog(q, "unsynced", "hello", 0)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConfigError);
    expect(String((failure as Error).message)).toMatch(/log_key.*syncSchema/s);

    // Everything else keeps working: removing a job tidies logs, and there
    // can be none without the column, so it must not fail over it.
    expect(await driver.removeJob(q, "unsynced")).toBe(true);
    expect(await driver.pruneExpired(q, Date.now(), 10)).toBe(0);

    // A new column is a safe change: planned as non-blocking, applied by a
    // plain sync.
    const planned = await driver.syncSchema({ dryRun: true });
    expect(planned.map((c) => [c.kind, c.target, c.blocking])).toEqual([
      ["add-column", "log_key", false],
    ]);
    expect((await driver.syncSchema())[0]!.applied).toBe(true);
    expect(await driver.syncSchema({ dryRun: true })).toEqual([]);

    await driver.addJob(q, makeJob({ id: "synced" }));
    expect(await driver.addJobLog(q, "synced", "hello", 0)).toBe(1);
    expect(
      await driver.getJobLogs(q, "synced", {
        offset: 0,
        limit: 10,
        order: "asc",
      }),
    ).toEqual({ logs: ["hello"], count: 1 });
  }, 45_000);

  it("leaves a repaired schema usable as a queue", async () => {
    const prefix = makePrefix("use");
    const driver = makeSqlDriver(prefix);
    await driver.connect();
    await ddl([`ALTER TABLE ${prefix}jobs DROP COLUMN repeat_key`]);
    await driver.syncSchema();

    // Repairing a schema is only worth anything if the driver can then use it.
    const q = { ns: testNamespace(), queue: "after-sync" };
    await driver.ensureQueue(q);
    await driver.addJob(q, makeJob({ id: "works" }));

    const claimed = await driver.claimJob(q, {
      now: Date.now(),
      token: "t",
      workerId: "w",
      lockMs: 5_000,
    });
    expect(claimed?.id).toBe("works");
  }, 45_000);
});

/** The five table names under `prefix`. */
function tablesFor(prefix: string) {
  return {
    jobs: `${prefix}jobs`,
    locks: `${prefix}locks`,
    kv: `${prefix}kv`,
    events: `${prefix}events`,
    logs: `${prefix}logs`,
  };
}

/**
 * MySQL and MariaDB, when configured: the engines whose identifier collation
 * the driver names, and whose migrations recollate columns.
 */
const MYSQL_FAMILY: {
  /** Which engine. */
  adapter: "mysql" | "mariadb";
  /** Its server, or undefined when the suite has none. */
  url: string | undefined;
  /** The binary `NO PAD` collation the driver gives identifiers there. */
  binary: string;
}[] = [
  {
    adapter: "mariadb",
    url: process.env.BUN_JOBS_TEST_MARIADB_URL,
    binary: "utf8mb4_nopad_bin",
  },
  {
    adapter: "mysql",
    url: process.env.BUN_JOBS_TEST_MYSQL_URL,
    binary: "utf8mb4_0900_bin",
  },
];

/** Table prefixes to drop when the suite ends, with the client to drop them on. */
const familyTables: { client: SQL; prefix: string }[] = [];
/** Clients opened for MySQL-family servers, closed when the suite ends. */
const familyClients: SQL[] = [];

afterAll(async () => {
  for (const { client, prefix } of familyTables) {
    for (const table of ["jobs", "locks", "kv", "events", "logs"]) {
      await client
        .unsafe(`DROP TABLE IF EXISTS ${prefix}${table}`)
        .catch(() => undefined);
    }
  }
  await Promise.allSettled(familyClients.map((client) => client.close()));
});

/**
 * The case- and accent-insensitive identifiers an older version created.
 * Named rather than left to the server's default, so a test means the same
 * thing on every server; `utf8mb4_general_ci` exists on both engines.
 */
function legacyDialect(adapter: "mysql" | "mariadb") {
  return {
    ...dialectFor(adapter),
    idType: "VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci",
    nameType: "TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci",
  };
}

for (const engine of MYSQL_FAMILY) {
  const { adapter, url, binary } = engine;

  /** This engine's client, opened on first use. */
  let shared: SQL | undefined;
  const client = (): SQL => {
    if (!shared) {
      // For the DDL the driver has no API for. Honours the URL's
      // `allowPublicKeyRetrieval` as the driver does; Bun's client ignores it.
      const { url: bare, value } = takeBooleanParam(
        url!,
        "allowPublicKeyRetrieval",
      );
      shared = new SQL({
        url: bare,
        ...(value === undefined ? {} : { allowPublicKeyRetrieval: value }),
      });
      familyClients.push(shared);
    }
    return shared;
  };

  /** A prefix nothing else uses, dropped when the suite ends. */
  const prefixFor = (label: string): string => {
    const prefix = `sy_${label}_${Math.random().toString(36).slice(2, 8)}_`;
    familyTables.push({ client: client(), prefix });
    return prefix;
  };

  /** A driver over `prefix`'s tables, on this engine's client. */
  const driverFor = (prefix: string): SqlDriver => {
    const driver = new SqlDriver({
      url,
      adapter,
      tablePrefix: prefix,
    });
    drivers.push(driver);
    return driver;
  };

  /** A backend over this engine's client, recording what it runs. */
  const recordingBackend = (run: string[] = []) => ({
    all: async <T>(text: string, params: unknown[]) =>
      (await client().unsafe(text, params)) as T[],
    run: async (text: string) => {
      run.push(text);
      return await client().unsafe(text);
    },
  });

  describe.skipIf(!url)(`schema sync: ${adapter} collation`, () => {
    it("finds nothing to do against the schema it just created", async () => {
      const driver = driverFor(prefixFor(`${adapter}_fresh`));
      await driver.connect();

      // Also the regression for MariaDB spelling `JSON` as `longtext`: before
      // the dialect said so, this reported eight blocking retypes, forever.
      expect(await driver.syncSchema({ dryRun: true })).toEqual([]);
    }, 45_000);

    it("reports a case-insensitive collation as blocking, and repairs it only when asked", async () => {
      const prefix = prefixFor(`${adapter}_coll`);
      const tables = tablesFor(prefix);
      for (const statement of createSchema(tables, legacyDialect(adapter))) {
        await client().unsafe(statement);
      }

      const driver = driverFor(prefix);
      const q = { ns: testNamespace(), queue: "collation" };
      const later = Date.now() + 60_000;

      // The fixture really has the bug: `report` collides with `Report`.
      expect(
        (await driver.addJob(q, makeJob({ id: "Report", runAt: later }))).added,
      ).toBe(true);
      expect(
        (await driver.addJob(q, makeJob({ id: "report", runAt: later }))).added,
      ).toBe(false);

      // Every identifier column, and nothing else, reported as one blocking
      // change each.
      const planned = await driver.syncSchema({ dryRun: true });
      expect(new Set(planned.map((c) => c.kind))).toEqual(
        new Set(["alter-column"]),
      );
      expect(planned.every((c) => c.blocking && !c.applied)).toBe(true);
      const targets = planned.map((c) => `${c.table}.${c.target}`);
      for (const column of [
        "jobs.ns",
        "jobs.queue",
        "jobs.id",
        "jobs.name",
        "jobs.state",
        "jobs.lock_token",
        "jobs.worker_id",
        "jobs.repeat_key",
        "jobs.log_key",
        "locks.lock_key",
        "locks.token",
        "kv.ns",
        "kv.kv_key",
        "events.channel",
        "logs.job_id",
      ]) {
        expect(targets).toContain(`${prefix}${column}`);
      }
      for (const column of [
        "jobs.data",
        "jobs.opts",
        "logs.message",
        "kv.value",
      ]) {
        expect(targets).not.toContain(`${prefix}${column}`);
      }
      const id = planned.find(
        (c) => c.target === "id" && c.table === tables.jobs,
      )!;
      expect(id.reason).toMatch(new RegExp(`utf8mb4_general_ci.*${binary}`));
      // The whole definition, so `MODIFY` keeps the column `NOT NULL`.
      expect(id.statement).toMatch(new RegExp(`COLLATE ${binary} NOT NULL$`));

      // A plain sync declines every one of them.
      expect((await driver.syncSchema()).some((c) => c.applied)).toBe(false);

      // Asked for by name, it makes them, and then there is nothing left.
      const applied = await driver.syncSchema({ alterColumns: true });
      expect(applied.length).toBe(planned.length);
      expect(applied.every((c) => c.applied)).toBe(true);
      expect(await driver.syncSchema({ dryRun: true })).toEqual([]);

      const nullable = (await client().unsafe(
        `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${tables.jobs}'
            AND IS_NULLABLE = 'YES' AND COLUMN_NAME IN ('ns', 'queue', 'id', 'name', 'state')`,
      )) as { name: string }[];
      expect(nullable).toEqual([]);

      // And what the contract asks of ids, state names and queue names holds
      // on the repaired tables — trailing spaces included, which a padding
      // collation would fold together.
      const variants = [
        "Report",
        "report",
        "REPORT",
        "résumé",
        "resume",
        "report ",
      ];
      for (const variant of variants.slice(1)) {
        expect(
          (await driver.addJob(q, makeJob({ id: variant, runAt: later })))
            .added,
        ).toBe(true);
      }
      for (const variant of variants) {
        expect((await driver.getJob(q, variant))?.id).toBe(variant);
        expect(await driver.setQueueState(q, variant, { variant }, null)).toBe(
          1,
        );
      }
      expect((await driver.countJobs(q)).waiting).toBe(variants.length);
      expect(await driver.listQueueState(q, { prefix: "", limit: 10 })).toEqual(
        [...variants].sort(),
      );

      const upper = { ns: q.ns, queue: "Mail" };
      const lower = { ns: q.ns, queue: "mail" };
      await driver.addJob(upper, makeJob({ id: "shared", runAt: later }));
      expect(
        (await driver.addJob(lower, makeJob({ id: "shared", runAt: later })))
          .added,
      ).toBe(true);
      expect((await driver.countJobs(upper)).waiting).toBe(1);
      expect((await driver.countJobs(lower)).waiting).toBe(1);
    }, 90_000);
  });

  describe.skipIf(!url)(`schema sync: ${adapter} index columns`, () => {
    it("rebuilds an index whose columns changed, as a safe change", async () => {
      const prefix = prefixFor(`${adapter}_ixcol`);
      const driver = driverFor(prefix);
      await driver.connect();

      // The claim index as it stood before MySQL's gained `id`: the right name
      // over the wrong columns. Neither engine renders a definition, so only
      // the column list can show the difference.
      const name = `ix_${prefix}jobs_claim`;
      const expected = dialectFor(adapter).claimIndexNamesId
        ? "ns, queue, state, priority, created_at, id"
        : "ns, queue, state, priority, created_at";
      await client().unsafe(`DROP INDEX ${name} ON ${prefix}jobs`);
      await client().unsafe(
        `CREATE INDEX ${name} ON ${prefix}jobs (ns, queue, state, run_at)`,
      );

      const planned = await driver.syncSchema({ dryRun: true });
      expect(planned.map((c) => [c.kind, c.target, c.blocking])).toEqual([
        ["drop-index", name, false],
        ["create-index", name, false],
      ]);
      expect(planned[0]!.reason).toContain("ns,queue,state,run_at");
      expect(planned[1]!.statement).toBe(
        `CREATE INDEX ${name} ON ${prefix}jobs (${expected})`.replace(
          "CREATE INDEX ",
          `CREATE INDEX ${dialectFor(adapter).indexIfNotExists ? "IF NOT EXISTS " : ""}`,
        ),
      );

      // Safe, so a plain sync makes it, and then there is nothing left.
      expect((await driver.syncSchema()).every((c) => c.applied)).toBe(true);
      expect(await driver.syncSchema({ dryRun: true })).toEqual([]);

      const columns = (await client().unsafe(
        `SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', ') AS c
           FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${prefix}jobs'
            AND INDEX_NAME = '${name}'`,
      )) as { c: string }[];
      expect(columns[0]?.c).toBe(expected);
    }, 60_000);
  });

  /**
   * A migration rewrites each table once, however many of its columns change.
   *
   * Every `ALTER TABLE` that retypes or recollates a column copies the whole
   * table under a lock. One per column made the collation migration nine copies
   * of `jobs`; one per table is one.
   *
   * Counted by running the sync over a backend that records every statement:
   * exact, and unaffected by anything else the server is doing, where a
   * server-wide `Com_alter_table` counter would not be.
   */
  describe.skipIf(!url)(
    `schema sync: one rewrite per table on ${adapter}`,
    () => {
      it("issues exactly one ALTER per table, and still reports every column", async () => {
        const prefix = prefixFor(`${adapter}_one`);
        const tables = tablesFor(prefix);
        const dialect = dialectFor(adapter);
        for (const statement of createSchema(tables, legacyDialect(adapter))) {
          await client().unsafe(statement);
        }

        const run: string[] = [];
        const backend = recordingBackend(run);
        const definition = schemaDefinition(tables, dialect);

        // A dry run still reports one change per column, each with the statement
        // that changes that column alone.
        const planned = await syncSqlSchema(
          backend,
          dialect,
          definition,
          resolveSyncOptions({ dryRun: true }),
        );
        const alters = planned.filter((c) => c.kind === "alter-column");
        expect(alters.filter((c) => c.table === tables.jobs)).toHaveLength(9);
        for (const change of alters) {
          expect(change.blocking).toBe(true);
          expect(change.statement.match(/MODIFY COLUMN/g)).toHaveLength(1);
        }
        expect(run).toEqual([]);

        const applied = await syncSqlSchema(
          backend,
          dialect,
          definition,
          resolveSyncOptions({ alterColumns: true }),
        );

        // The same changes, reported the same way, and every one applied.
        const shape = (c: SchemaChange) => [
          c.kind,
          c.table,
          c.target,
          c.statement,
          c.blocking,
        ];
        expect(applied.map(shape)).toEqual(planned.map(shape));
        expect(applied.every((c) => c.applied)).toBe(true);

        // One ALTER per table with changes, carrying all of that table's columns.
        const changedTables = [...new Set(alters.map((c) => c.table))];
        const statements = run.filter((text) => text.startsWith("ALTER TABLE"));
        expect(statements).toHaveLength(changedTables.length);
        for (const table of changedTables) {
          const mine = statements.filter((text) =>
            text.startsWith(`ALTER TABLE ${table} `),
          );
          expect(mine).toHaveLength(1);
          expect(mine[0]!.match(/MODIFY COLUMN/g)).toHaveLength(
            alters.filter((c) => c.table === table).length,
          );
        }

        // And the result is what the driver would have created.
        expect(
          await syncSqlSchema(
            backend,
            dialect,
            definition,
            resolveSyncOptions({ dryRun: true }),
          ),
        ).toEqual([]);
      }, 90_000);

      it("applies none of a table's columns when its ALTER fails, and throws", async () => {
        const prefix = prefixFor(`${adapter}_fail`);
        const tables = tablesFor(prefix);
        const dialect = dialectFor(adapter);
        for (const statement of createSchema(tables, legacyDialect(adapter))) {
          await client().unsafe(statement);
        }

        // Make the combined statement for `jobs` fail the way a real one can:
        // `name` is loosened to nullable and given a null, so redefining it
        // `NOT NULL` alongside the other eight columns is refused by the server.
        await client().unsafe(
          `ALTER TABLE ${tables.jobs} MODIFY COLUMN name TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NULL`,
        );
        await client().unsafe(
          `INSERT INTO ${tables.jobs} (ns, queue, id, name, state, run_at, created_at) VALUES ('n', 'q', 'broken', NULL, 'waiting', 0, 0)`,
        );
        const backend = recordingBackend();

        await expect(
          syncSqlSchema(
            backend,
            dialect,
            schemaDefinition(tables, dialect),
            resolveSyncOptions({ alterColumns: true }),
          ),
        ).rejects.toThrow();

        // One statement, so all or nothing: not one of the other eight columns
        // was recollated on its own ahead of the one that failed.
        const collations = (await client().unsafe(
          `SELECT DISTINCT COLLATION_NAME AS c FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${tables.jobs}'
            AND COLUMN_NAME IN ('ns', 'queue', 'id', 'state', 'lock_token', 'worker_id', 'repeat_key', 'log_key')`,
        )) as { c: string }[];
        expect(collations.map((row) => row.c)).toEqual(["utf8mb4_general_ci"]);

        // Still reported, still blocking, and not applied.
        const after = await syncSqlSchema(
          backend,
          dialect,
          schemaDefinition(tables, dialect),
          resolveSyncOptions({ dryRun: true }),
        );
        const jobs = after.filter(
          (c) => c.kind === "alter-column" && c.table === tables.jobs,
        );
        expect(jobs).toHaveLength(9);
        expect(jobs.every((c) => c.blocking && !c.applied)).toBe(true);
      }, 90_000);
    },
  );
}

/** Whether the Postgres role may create an event trigger, which needs superuser. */
const POSTGRES_SUPERUSER = POSTGRES
  ? await (async () => {
      const probe = new SQL(POSTGRES);
      try {
        const [row] = (await probe.unsafe(
          "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
        )) as { rolsuper: boolean }[];
        return row?.rolsuper === true;
      } finally {
        await probe.close();
      }
    })()
  : false;

describe.skipIf(!POSTGRES_SUPERUSER)(
  "schema sync: one rewrite per table on Postgres (needs a superuser)",
  () => {
    it("rewrites jobs once for several retyped columns", async () => {
      const prefix = makePrefix("pone");
      const driver = makeSqlDriver(prefix);
      await driver.connect();

      // The `jsonb` payloads an older version created, on three columns.
      await ddl(
        ["data", "opts", "progress"].map(
          (column) =>
            `ALTER TABLE ${prefix}jobs ALTER COLUMN ${column} TYPE jsonb USING ${column}::jsonb`,
        ),
      );

      // Postgres reports each actual rewrite to a `table_rewrite` event
      // trigger — the engine's own count, not an inference from statements.
      const log = `${prefix}rewrites`;
      const fn = `${prefix}count_rewrite`;
      const trigger = `${prefix}rewrite_trigger`;
      await ddl([
        `CREATE TABLE ${log} (tbl text)`,
        `CREATE FUNCTION ${fn}() RETURNS event_trigger LANGUAGE plpgsql AS $$
           BEGIN
             IF pg_event_trigger_table_rewrite_oid()::regclass::text LIKE '${prefix}%' THEN
               INSERT INTO ${log} VALUES (pg_event_trigger_table_rewrite_oid()::regclass::text);
             END IF;
           END $$`,
        `CREATE EVENT TRIGGER ${trigger} ON table_rewrite EXECUTE FUNCTION ${fn}()`,
      ]);

      try {
        const applied = await driver.syncSchema({ alterColumns: true });
        const jobs = applied.filter(
          (c) => c.kind === "alter-column" && c.table === `${prefix}jobs`,
        );
        expect(jobs.map((c) => c.target)).toEqual(["data", "opts", "progress"]);
        expect(jobs.every((c) => c.blocking && c.applied)).toBe(true);

        const rewrites = await query<{ tbl: string }>(`SELECT tbl FROM ${log}`);
        expect(rewrites.map((row) => row.tbl)).toEqual([`${prefix}jobs`]);
        expect(await driver.syncSchema({ dryRun: true })).toEqual([]);
      } finally {
        await ddl([
          `DROP EVENT TRIGGER IF EXISTS ${trigger}`,
          `DROP FUNCTION IF EXISTS ${fn}()`,
          `DROP TABLE IF EXISTS ${log}`,
        ]);
      }
    }, 60_000);
  },
);

describe.skipIf(!MONGODB)("schema sync: MongoDB", () => {
  it("finds nothing to do against the indexes it just created", async () => {
    const driver = new MongoDriver({
      url: MONGODB,
      collectionPrefix: `sy_fresh_${Math.random().toString(36).slice(2, 8)}_`,
    });
    drivers.push(driver);
    await driver.connect();

    expect(await driver.syncSchema({ dryRun: true })).toEqual([]);
  }, 45_000);

  it("retires an index an older version created", async () => {
    const prefix = `sy_old_${Math.random().toString(36).slice(2, 8)}_`;
    const driver = new MongoDriver({ url: MONGODB, collectionPrefix: prefix });
    drivers.push(driver);
    await driver.connect();

    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(MONGODB!);
    await client.connect();

    try {
      // The claim index from before `_id` joined the key, which is the whole
      // reason `RETIRED_INDEXES` exists.
      const jobs = client.db().collection(`${prefix}jobs`);
      await jobs.createIndex({
        ns: 1,
        queue: 1,
        state: 1,
        priority: 1,
        createdAt: 1,
      });

      const planned = await driver.syncSchema({ dryRun: true });
      expect(planned.map((c) => c.kind)).toEqual(["drop-index"]);
      expect(planned[0]!.applied).toBe(false);

      await driver.syncSchema();

      const names = (await jobs.indexes()).map((index) => String(index.name));
      expect(names).not.toContain(
        "ns_1_queue_1_state_1_priority_1_createdAt_1",
      );

      await client
        .db()
        .collection(`${prefix}jobs`)
        .drop()
        .catch(() => undefined);
    } finally {
      await client.close();
    }
  }, 45_000);
});

describe.skipIf(!POSTGRES)("event retention", () => {
  /**
   * The contract test calls `cleanEvents` directly, which proves it works and
   * not that anything calls it. The complaint was never "there is no way to
   * prune" — it was that nothing ever did, so a stored event log grew for as
   * long as the queue ran.
   */
  it("prunes as it publishes, without being asked", async () => {
    const prefix = makePrefix("evret");
    // Short enough that the sweep is due on the second publish; the interval
    // between sweeps is a quarter of this, floored at a second.
    const driver = makeSqlDriver(prefix, { eventRetentionMs: 1_200 });
    await driver.connect();

    const ns = testNamespace();
    const count = async () =>
      Number(
        (
          await query<{ n: number }>(
            `SELECT count(*)::int AS n FROM ${prefix}events WHERE ns = '${ns}'`,
          )
        )[0]?.n ?? 0,
      );

    await driver.publish(
      queueEvent(
        { ns, target: "q", type: "promoted", origin: "test" },
        { id: "first" },
      ),
    );
    expect(await count()).toBe(1);

    // Older than the retention window by the time the next publish sweeps.
    await Bun.sleep(1_400);

    await driver.publish(
      queueEvent(
        { ns, target: "q", type: "promoted", origin: "test" },
        { id: "second" },
      ),
    );

    // The sweep is fired and not awaited — a publisher should not wait on
    // housekeeping — so the row goes shortly after, not synchronously.
    await waitFor(async () => (await count()) === 1, {
      message: "the stale event was never pruned",
      timeout: 5_000,
    });
  }, 30_000);
});
