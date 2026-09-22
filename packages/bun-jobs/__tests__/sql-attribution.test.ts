import type { QueueRef } from "../lib/index";
import { join } from "node:path";
import process from "node:process";
import { SQL } from "bun";
import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { ConfigError, newToken, SQL_TABLES, SqlDriver } from "../lib/index";
import { takeBooleanParam } from "../lib/shared/connection";
import { makeJob, makeTmpDir, testNamespace } from "./helpers";

/**
 * Job attribution on the SQL driver, beyond the shared contract: what the
 * schema declares for it on each engine, and what an upgraded install whose
 * table predates the stamp's columns does until it syncs.
 *
 * The contract (`driverContract`'s "job attribution") holds the behaviour on a
 * synced table; these hold the schema and the fallback, which it cannot see.
 */

/** One engine to run against, with how to reach it and its raw DDL. */
interface Engine {
  /** The driver's adapter name. */
  adapter: "sqlite" | "postgres" | "mysql" | "mariadb";
  /** The server URL, or `undefined` when the suite has none configured. */
  url: string | undefined;
  /**
   * Whether the schema defines the partial finished-jobs index here: SQLite
   * only. Postgres has partial indexes but not this one, since it slowed
   * completions by a quarter or more.
   */
  finIndex: boolean;
}

const ENGINES: Engine[] = [
  { adapter: "sqlite", url: "sqlite", finIndex: true },
  {
    adapter: "postgres",
    url: process.env.BUN_JOBS_TEST_POSTGRES_URL,
    finIndex: false,
  },
  {
    adapter: "mysql",
    url: process.env.BUN_JOBS_TEST_MYSQL_URL,
    finIndex: false,
  },
  {
    adapter: "mariadb",
    url: process.env.BUN_JOBS_TEST_MARIADB_URL,
    finIndex: false,
  },
];

/** Undo steps for what one case made, run as it ends — exact names only. */
const cleanups: (() => Promise<void>)[] = [];
/** Clients opened for raw DDL, closed when the suite ends. */
const clients: SQL[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0, cleanups.length).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

afterAll(async () => {
  await Promise.allSettled(clients.map((client) => client.close()));
});

/** A prefix nothing else uses, ending in `_` as the naming wants. */
function uniquePrefix(label: string): string {
  return `at_${label}_${Math.random().toString(36).slice(2, 8)}_`;
}

/** What one case gets: a way to make drivers over its tables, and raw SQL. */
interface Setup {
  /** The table prefix. */
  prefix: string;
  /** A new driver over the case's tables; closed when the case ends. */
  driver: () => SqlDriver;
  /** Runs one statement the driver has no API for, returning its rows. */
  raw: (text: string) => Promise<Record<string, unknown>[]>;
}

/** Tables of the case's own on `engine`, every one dropped by name after it. */
async function setup(engine: Engine, label: string): Promise<Setup> {
  const prefix = uniquePrefix(label);

  if (engine.adapter === "sqlite") {
    const tmp = await makeTmpDir("bun-jobs-attr");
    const file = join(tmp.path, "jobs.db");
    const db = new Database(file);
    cleanups.push(async () => {
      db.close();
      await tmp.cleanup();
    });

    return {
      prefix,
      driver: () => {
        const driver = new SqlDriver({
          url: `sqlite://${file}`,
          tablePrefix: prefix,
        });
        cleanups.push(async () => await driver.close());
        return driver;
      },
      raw: async (text) =>
        db.query(text).all() as unknown as Record<string, unknown>[],
    };
  }

  const { url: bare, value } = takeBooleanParam(
    engine.url!,
    "allowPublicKeyRetrieval",
  );
  const client = new SQL({
    url: bare,
    ...(value === undefined ? {} : { allowPublicKeyRetrieval: value }),
  });
  clients.push(client);
  cleanups.push(async () => {
    for (const table of SQL_TABLES) {
      await client.unsafe(`DROP TABLE IF EXISTS ${prefix}${table}`);
    }
  });

  return {
    prefix,
    driver: () => {
      const driver = new SqlDriver({
        url: engine.url,
        adapter: engine.adapter,
        tablePrefix: prefix,
        notify: false,
      });
      cleanups.push(async () => await driver.close());
      return driver;
    },
    raw: async (text) =>
      (await client.unsafe(text)) as Record<string, unknown>[],
  };
}

/** The indexes on the case's jobs table: name, and definition where known. */
async function jobIndexes(
  engine: Engine,
  { prefix, raw }: Setup,
): Promise<{ name: string; definition: string }[]> {
  const table = `${prefix}jobs`;

  switch (engine.adapter) {
    case "sqlite":
      return (
        await raw(
          `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = '${table}' AND sql IS NOT NULL`,
        )
      ).map((row) => ({ name: String(row.name), definition: String(row.sql) }));
    case "postgres":
      return (
        await raw(
          `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = '${table}'`,
        )
      ).map((row) => ({
        name: String(row.indexname),
        definition: String(row.indexdef),
      }));
    default: {
      // No definitions here: the columns, in order, stand in for one.
      const rows = await raw(
        `SELECT INDEX_NAME AS name, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
           FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}'
          GROUP BY INDEX_NAME`,
      );
      return rows.map((row) => ({
        name: String(row.name),
        definition: String(row.cols),
      }));
    }
  }
}

/** The stamp's columns, as the schema names them. */
const STAMP = [
  "processed_by_id",
  "processed_by_key",
  "processed_by_host",
  "processed_by_pid",
];

/** Drops the stamp's four columns, leaving the table an older version made. */
async function dropStampColumns(
  engine: Engine,
  { prefix, raw }: Setup,
): Promise<void> {
  const table = `${prefix}jobs`;

  if (engine.adapter === "sqlite") {
    for (const column of STAMP) {
      await raw(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
    return;
  }

  await raw(
    `ALTER TABLE ${table} ${STAMP.map((column) => `DROP COLUMN ${column}`).join(", ")}`,
  );
}

/** One job's holder and stamp columns, read raw. */
async function rawStamp(
  { prefix, raw }: Setup,
  q: QueueRef,
  id: string,
): Promise<Record<string, unknown>> {
  const [row] = await raw(
    `SELECT worker_id, ${STAMP.join(", ")} FROM ${prefix}jobs
      WHERE ns = '${q.ns}' AND queue = '${q.queue}' AND id = '${id}'`,
  );
  return {
    worker_id: row?.worker_id ?? null,
    ...Object.fromEntries(
      STAMP.map((column) => [
        column,
        column === "processed_by_pid" && row?.[column] != null
          ? Number(row[column])
          : (row?.[column] ?? null),
      ]),
    ),
  };
}

/** A worker identity, as the worker passes it to the claim. */
const ALPHA = { key: "svc.emails", host: "host-a", pid: 101 };

for (const engine of ENGINES) {
  describe.skipIf(!engine.url)(`SQL attribution: ${engine.adapter}`, () => {
    it(
      engine.finIndex
        ? "defines a partial index on finished jobs, and none on the worker key"
        : "defines no finished-jobs index, and none on the worker key",
      async () => {
        const made = await setup(engine, "ix");
        const driver = made.driver();
        await driver.connect();

        // The baseline: a schema the driver just created has no drift.
        expect(await driver.syncSchema({ dryRun: true })).toEqual([]);

        const indexes = await jobIndexes(engine, made);
        const finished = indexes.find(
          (index) => index.name === `ix_${made.prefix}jobs_fin`,
        );

        if (engine.finIndex) {
          expect(finished).toBeDefined();
          expect(finished!.definition).toMatch(
            /\(ns, queue, state, finished_on\)/,
          );
          expect(finished!.definition).toMatch(
            /WHERE \(?finished_on IS NOT NULL\)?/i,
          );
        } else {
          // On MySQL and MariaDB, without a predicate, it would be written on
          // every insert and state change; on Postgres, even partial, it cost
          // completions a quarter or more of their throughput. Neither is a
          // price the schema pays.
          expect(finished).toBeUndefined();
          expect(
            indexes.filter((index) =>
              /(?:^|,)finished_on(?:,|$)/.test(index.definition),
            ),
          ).toEqual([]);
        }

        expect(
          indexes.filter((index) => /processed_by_/.test(index.definition)),
        ).toEqual([]);
      },
      45_000,
    );

    it("leaves a new index on an existing table to syncSchema, which builds it without blocking writes", async () => {
      const made = await setup(engine, "noblock");
      await made.driver().connect();

      // An existing jobs table from before these indexes: the finished-jobs
      // index where the schema defines one, and `ix_..._due` everywhere, so
      // every engine is held to the same rule.
      const missing = [
        `ix_${made.prefix}jobs_due`,
        ...(engine.finIndex ? [`ix_${made.prefix}jobs_fin`] : []),
      ];
      for (const name of missing) {
        await made.raw(
          engine.adapter === "sqlite" || engine.adapter === "postgres"
            ? `DROP INDEX ${name}`
            : `DROP INDEX ${name} ON ${made.prefix}jobs`,
        );
      }

      // The next process to connect — an upgrade starting — builds nothing:
      // a plain CREATE INDEX there would block every write for the build.
      const upgraded = made.driver();
      await upgraded.connect();
      const after = (await jobIndexes(engine, made)).map((index) => index.name);
      for (const name of missing) {
        expect(after).not.toContain(name);
      }

      // The sync reports each: concurrent on Postgres, online on MySQL and
      // MariaDB, and blocking on SQLite, whose one writer holds the file for
      // the build.
      const planned = await upgraded.syncSchema({ dryRun: true });
      expect(planned.map((c) => [c.kind, c.target]).sort()).toEqual(
        missing.map((name) => ["create-index", name]).sort(),
      );
      for (const change of planned) {
        expect(change.blocking).toBe(engine.adapter === "sqlite");
        if (engine.adapter === "postgres") {
          expect(change.statement).toMatch(/^CREATE INDEX CONCURRENTLY /);
        }
      }
      expect((await upgraded.syncSchema()).every((c) => c.applied)).toBe(true);
      const synced = (await jobIndexes(engine, made)).map(
        (index) => index.name,
      );
      for (const name of missing) {
        expect(synced).toContain(name);
      }
      expect(await upgraded.syncSchema({ dryRun: true })).toEqual([]);
    }, 60_000);

    it("stores the stamp in its own columns, kept by every settle, while worker_id goes with the lock", async () => {
      const made = await setup(engine, "kept");
      const driver = made.driver();
      const q: QueueRef = { ns: testNamespace("attr"), queue: "kept" };
      const now = Date.now();
      await driver.addJobs(q, [
        makeJob({ id: "done", runAt: now, createdAt: now }),
        makeJob({ id: "failed", runAt: now, createdAt: now + 1 }),
        makeJob({ id: "buried", runAt: now, createdAt: now + 2 }),
        makeJob({ id: "stalled", runAt: now, createdAt: now + 3 }),
      ]);

      const stamp = {
        processed_by_id: "alpha-1",
        processed_by_key: ALPHA.key,
        processed_by_host: ALPHA.host,
        processed_by_pid: ALPHA.pid,
      };
      const claim = async (lockMs = 30_000) => {
        const token = newToken();
        const job = await driver.claimJob(q, {
          workerId: "alpha-1",
          worker: ALPHA,
          token,
          lockMs,
          now,
        });
        return { job: job!, token };
      };

      // While active, the holder and the stamp agree.
      const done = await claim();
      expect(done.job.id).toBe("done");
      expect(await rawStamp(made, q, "done")).toEqual({
        worker_id: "alpha-1",
        ...stamp,
      });
      expect(
        await driver.completeJob(q, "done", done.token, null, false, now + 5),
      ).toBe(true);

      const failed = await claim();
      expect(
        await driver.failJob(
          q,
          "failed",
          failed.token,
          { name: "Error", message: "x" },
          { retry: false, retention: false },
          now + 5,
          5,
        ),
      ).toBe(true);

      const buried = await claim();
      expect(
        (
          await driver.buryJob!(
            q,
            "buried",
            { name: "Error", message: "y" },
            { retention: false, keepStacktraces: 5, token: buried.token },
            now + 5,
          )
        )?.state,
      ).toBe("dead");

      await claim(1);
      expect(await driver.recoverStalled(q, now + 10, 5, 100)).toEqual({
        requeued: ["stalled"],
        dead: [],
      });

      // Every settle cleared the holder, and none touched the stamp.
      for (const id of ["done", "failed", "buried", "stalled"]) {
        const row: Record<string, unknown> = {
          id,
          ...(await rawStamp(made, q, id)),
        };
        expect(row).toEqual({
          id,
          worker_id: null,
          ...stamp,
        });
        const read = await driver.getJob(q, id);
        expect(read?.workerId).toBeNull();
        expect(read?.processedBy).toEqual({ id: "alpha-1", ...ALPHA });
      }

      // A settle by a version from before the stamp clears `worker_id` with
      // the lock, and knows nothing of the stamp — so leaves it as it was.
      await driver.addJob(
        q,
        makeJob({ id: "legacy", runAt: now, createdAt: now + 4 }),
      );
      expect((await claim()).job.id).toBe("legacy");
      await made.raw(
        `UPDATE ${made.prefix}jobs
            SET state = 'completed', finished_on = ${now + 5},
                lock_token = NULL, lock_expires_at = NULL, worker_id = NULL
          WHERE id = 'legacy'`,
      );
      const legacy = await driver.getJob(q, "legacy");
      expect(legacy?.workerId).toBeNull();
      expect(legacy?.processedBy).toEqual({ id: "alpha-1", ...ALPHA });
    }, 60_000);

    it("keeps claiming on a table without the stamp's columns, and a sync brings stamps", async () => {
      const made = await setup(engine, "unsynced");
      await made.driver().connect();
      await dropStampColumns(engine, made);

      // A fresh driver, as a process started after the upgrade gets.
      const driver = made.driver();
      const q: QueueRef = { ns: testNamespace("attr"), queue: "unsynced" };
      const now = Date.now();
      await driver.addJobs(q, [
        makeJob({ id: "one", runAt: now, createdAt: now }),
        makeJob({ id: "two", runAt: now, createdAt: now + 1 }),
      ]);

      // The claim names the stamp's columns and must not fail over them: it
      // falls back to the statement without, which stamps nothing. The holder
      // is still recorded, as it always was.
      const token = newToken();
      const claimed = await driver.claimJob(q, {
        workerId: "alpha-1",
        worker: ALPHA,
        token,
        lockMs: 30_000,
        now,
      });
      expect(claimed?.id).toBe("one");
      expect(claimed?.workerId).toBe("alpha-1");
      expect(claimed?.processedBy).toBeUndefined();

      // Remembered: the next claim goes straight to the old statement.
      const second = await driver.claimJob(q, {
        workerId: "alpha-1",
        worker: ALPHA,
        token,
        lockMs: 30_000,
        now,
      });
      expect(second?.id).toBe("two");

      // Settling works as it always did.
      expect(
        await driver.completeJob(q, "one", token, null, false, now + 5),
      ).toBe(true);
      const settled = await driver.getJob(q, "one");
      expect(settled?.workerId).toBeNull();
      expect(settled?.processedBy).toBeUndefined();

      // A stamped record still goes in, without the stamp it cannot keep —
      // as an older version would have inserted it.
      const restored = makeJob({
        id: "restored",
        state: "completed",
        finishedOn: now,
        processedOn: now - 1,
        attemptsMade: 1,
        processedBy: { id: "old-1", key: "old.key", host: "h", pid: 7 },
      });
      expect((await driver.addJob(q, restored)).added).toBe(true);
      expect(
        (await driver.addJobs(q, [{ ...restored, id: "restored-2" }]))[0]
          ?.added,
      ).toBe(true);
      expect((await driver.getJob(q, "restored"))?.processedBy).toBeUndefined();

      // A range needs nothing new; a worker filter has no answer to give.
      const ranged = await driver.findJobs(q, {
        states: ["completed"],
        finishedFrom: now,
        finishedTo: now + 6,
        offset: 0,
        limit: 10,
        order: "asc",
      });
      expect(ranged.jobs.map((job) => job.id).sort()).toEqual(
        ["one", "restored", "restored-2"].sort(),
      );

      for (const filter of [
        { workerKeys: [ALPHA.key] },
        { workerIds: ["alpha-1"] },
      ]) {
        const refused = await driver
          .findJobs(q, {
            states: ["completed"],
            ...filter,
            offset: 0,
            limit: 10,
            order: "asc",
          })
          .catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(ConfigError);
        expect(String((refused as Error).message)).toMatch(
          /processed_by_id.*syncSchema\(\)/s,
        );
      }

      // The sync adds them, as safe changes.
      const planned = await driver.syncSchema({ dryRun: true });
      expect(planned.map((c) => [c.kind, c.target, c.blocking])).toEqual(
        STAMP.map((column) => ["add-column", column, false]),
      );
      expect((await driver.syncSchema()).every((c) => c.applied)).toBe(true);
      expect(await driver.syncSchema({ dryRun: true })).toEqual([]);

      // A fresh driver, as the next deployment gets: Postgres will not reuse a
      // statement a connection prepared against the old columns.
      const synced = made.driver();
      await synced.addJob(
        q,
        makeJob({ id: "three", runAt: now, createdAt: now + 2 }),
      );
      const stamped = await synced.claimJob(q, {
        workerId: "alpha-2",
        worker: ALPHA,
        token: newToken(),
        lockMs: 30_000,
        now,
      });
      expect(stamped?.id).toBe("three");
      expect(stamped?.processedBy).toEqual({ id: "alpha-2", ...ALPHA });
      const byKey = await synced.findJobs(q, {
        states: ["active"],
        workerKeys: [ALPHA.key],
        offset: 0,
        limit: 10,
        order: "asc",
      });
      expect(byKey.jobs.map((job) => job.id)).toEqual(["three"]);
    }, 60_000);
  });
}

/** Postgres, which the finished-jobs index was once built on. */
const POSTGRES = ENGINES.find((engine) => engine.adapter === "postgres")!;

describe.skipIf(!POSTGRES.url)(
  "SQL attribution: postgres, upgrading from a finished-jobs index",
  () => {
    it("leaves the index alone on connect, and syncSchema drops it without blocking writes", async () => {
      const made = await setup(POSTGRES, "finold");
      await made.driver().connect();

      // The table as the version that defined the index left it: built with
      // the exact statement that version ran.
      const name = `ix_${made.prefix}jobs_fin`;
      await made.raw(
        `CREATE INDEX ${name} ON ${made.prefix}jobs (ns, queue, state, finished_on) WHERE finished_on IS NOT NULL`,
      );
      const names = async () =>
        (await jobIndexes(POSTGRES, made)).map((index) => index.name);

      // A process connecting after the upgrade touches no index on a table it
      // did not create, so the index is still there.
      const upgraded = made.driver();
      await upgraded.connect();
      expect(await names()).toContain(name);

      // The plan: one drop, safe, concurrent, and nothing else.
      const planned = await upgraded.syncSchema({ dryRun: true });
      expect(
        planned.map((c) => ({
          kind: c.kind,
          target: c.target,
          blocking: c.blocking,
          applied: c.applied,
          statement: c.statement,
        })),
      ).toEqual([
        {
          kind: "drop-index",
          target: name,
          blocking: false,
          applied: false,
          statement: `DROP INDEX CONCURRENTLY IF EXISTS ${name}`,
        },
      ]);
      // A dry run changed nothing.
      expect(await names()).toContain(name);

      const applied = await upgraded.syncSchema();
      expect(applied.map((c) => [c.kind, c.target, c.applied])).toEqual([
        ["drop-index", name, true],
      ]);
      expect(await names()).not.toContain(name);

      // And the schema has settled.
      expect(await upgraded.syncSchema({ dryRun: true })).toEqual([]);
    }, 60_000);
  },
);
