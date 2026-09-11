import type { JobsDriver } from "../lib/index";
import process from "node:process";
import { SQL } from "bun";
import { afterAll, describe, expect, it } from "bun:test";
import { MongoDriver, SqlDriver } from "../lib/index";
import { makeJob, testNamespace } from "./helpers";

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

/** Drivers to close when the suite ends. */
const drivers: JobsDriver[] = [];
/** Table prefixes to drop when the suite ends. */
const prefixes: string[] = [];

afterAll(async () => {
  await Promise.allSettled(drivers.map((driver) => driver.close()));

  if (POSTGRES && prefixes.length > 0) {
    const sql = new SQL(POSTGRES);
    for (const prefix of prefixes) {
      for (const table of ["jobs", "locks", "kv", "events"]) {
        await sql
          .unsafe(`DROP TABLE IF EXISTS ${prefix}${table} CASCADE`)
          .catch(() => undefined);
      }
    }
    await sql.close();
  }
});

/** A prefix nothing else in the suite uses, ending in `_` as the naming wants. */
function makePrefix(label: string): string {
  const prefix = `sy_${label}_${Math.random().toString(36).slice(2, 8)}_`;
  prefixes.push(prefix);
  return prefix;
}

/** A driver on its own tables, so one case cannot disturb another. */
function makeSqlDriver(
  prefix: string,
  options: { syncSchema?: boolean } = {},
): SqlDriver {
  const driver = new SqlDriver({
    url: POSTGRES,
    tablePrefix: prefix,
    notify: false,
    ...options,
  });
  drivers.push(driver);
  return driver;
}

/** Runs DDL the driver has no API for, which is the point of these tests. */
async function ddl(statements: string[]): Promise<void> {
  const sql = new SQL(POSTGRES!);
  try {
    for (const statement of statements) await sql.unsafe(statement);
  } finally {
    await sql.close();
  }
}

/** Reads back whatever the database says, for the assertions. */
async function query<T>(text: string): Promise<T[]> {
  const sql = new SQL(POSTGRES!);
  try {
    return (await sql.unsafe(text)) as T[];
  } finally {
    await sql.close();
  }
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
