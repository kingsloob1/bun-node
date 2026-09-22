import type { SqlDialect } from "../lib/drivers/sql/dialect";
import type { JobState, QueueRef } from "../lib/index";
import { join } from "node:path";
import process from "node:process";
import { SQL } from "bun";
import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { claimIndexName } from "../lib/drivers/sql/schema";
import {
  countAddedStatement,
  createdAtOrder,
} from "../lib/drivers/sql/sql-driver";
import { SQL_TABLES, SqlDriver } from "../lib/index";
import { takeBooleanParam } from "../lib/shared/connection";
import { makeJob, makeTmpDir } from "./helpers";

/**
 * Counting the jobs added in a range, and `sort: "createdAt"`, on the SQL
 * driver, beyond the shared contract (`driverContract`'s "jobs by creation
 * time"): what the contract's own tables cannot show.
 *
 * - **The tie-break is by code point whatever the id column's collation.**
 *   The contract's tables are fresh, so their ids are in the collation the
 *   driver declares today — binary on MySQL and MariaDB — and the test
 *   Postgres (an Alpine build, whose `en_US.utf8` compares bytes) sorts them
 *   by code point unasked. Here the id column is put in a real locale's
 *   collation first, as on a Postgres built against glibc or ICU, or a MySQL
 *   table created before ids were binary.
 * - **An empty range reads nothing**, which a result alone cannot prove.
 * - **The count is a covering scan of the claim index's `(ns[, queue])`
 *   prefix** where the plan is deterministic enough to assert (SQLite, once
 *   analysed, and MySQL, which is told to), and still answers on a MySQL
 *   table that has lost that index.
 */

/** One engine to run against, with how to reach it. */
interface Engine {
  /** The driver's adapter name. */
  adapter: "sqlite" | "postgres" | "mysql" | "mariadb";
  /** The server URL, or `undefined` when the suite has none configured. */
  url: string | undefined;
}

const ENGINES: Engine[] = [
  { adapter: "sqlite", url: "sqlite" },
  { adapter: "postgres", url: process.env.BUN_JOBS_TEST_POSTGRES_URL },
  { adapter: "mysql", url: process.env.BUN_JOBS_TEST_MYSQL_URL },
  { adapter: "mariadb", url: process.env.BUN_JOBS_TEST_MARIADB_URL },
];

/** Undo steps for what one case made, run as it ends — exact names only. */
const cleanups: (() => Promise<void>)[] = [];
/** Clients opened for raw SQL, closed when the suite ends. */
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
  return `ab_${label}_${Math.random().toString(36).slice(2, 8)}_`;
}

/** What one case gets: a driver over tables of its own, and raw SQL. */
interface Setup {
  /** The jobs table's name. */
  jobs: string;
  /** A connected driver over the case's tables; closed when the case ends. */
  driver: SqlDriver;
  /** Runs one statement the driver has no API for, returning its rows. */
  raw: (text: string, values?: unknown[]) => Promise<Record<string, unknown>[]>;
}

/** Tables of the case's own on `engine`, every one dropped by name after it. */
async function setup(engine: Engine, label: string): Promise<Setup> {
  const prefix = uniquePrefix(label);

  if (engine.adapter === "sqlite") {
    const tmp = await makeTmpDir("bun-jobs-added");
    const file = join(tmp.path, "jobs.db");
    const driver = new SqlDriver({
      url: `sqlite://${file}`,
      tablePrefix: prefix,
    });
    await driver.connect();
    const db = new Database(file);
    cleanups.push(async () => {
      db.close();
      await driver.close();
      await tmp.cleanup();
    });

    return {
      jobs: `${prefix}jobs`,
      driver,
      raw: async (text, values = []) =>
        db.query(text).all(...(values as never[])) as unknown as Record<
          string,
          unknown
        >[],
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

  const driver = new SqlDriver({
    url: engine.url,
    adapter: engine.adapter,
    tablePrefix: prefix,
    notify: false,
  });
  await driver.connect();
  // Pushed after the drop, so it runs first: the driver lets go of the tables.
  cleanups.push(async () => await driver.close());

  return {
    jobs: `${prefix}jobs`,
    driver,
    raw: async (text, values = []) =>
      (await client.unsafe(text, values)) as Record<string, unknown>[],
  };
}

/** A fixed instant, far from any clock a backend might react to. */
const T = 1_700_000_000_000;

/**
 * The statement to put a jobs table's `id` column in a locale's collation,
 * where `tie-a` sorts before `tie-B` — or `null` where there is no such
 * collation to use. SQLite cannot change a column's collation without
 * rebuilding the table, and its `BINARY` default is code-point order anyway.
 */
async function localeIdStatement(
  engine: Engine,
  { jobs, raw }: Setup,
): Promise<string | null> {
  switch (engine.adapter) {
    case "postgres": {
      // ICU's English: what a glibc `en_US.utf8` database orders like too.
      const found = await raw(
        `SELECT 1 AS ok FROM pg_collation WHERE collname = 'en-x-icu'`,
      );
      return found.length === 0
        ? null
        : `ALTER TABLE ${jobs} ALTER COLUMN id TYPE TEXT COLLATE "en-x-icu"`;
    }
    case "mysql":
    case "mariadb":
      // The case-insensitive collation an id had before ids were binary.
      return `ALTER TABLE ${jobs} MODIFY id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL`;
    default:
      return null;
  }
}

/** Every state at zero, then `changes`. */
function countsOf(
  changes: Partial<Record<JobState, number>>,
): Record<JobState, number> {
  return {
    waiting: 0,
    delayed: 0,
    active: 0,
    completed: 0,
    failed: 0,
    dead: 0,
    "waiting-children": 0,
    ...changes,
  };
}

describe("createdAtOrder", () => {
  /** Just what the order reads of a dialect. */
  const dialect = (
    name: SqlDialect["name"],
    codePointCollation: string | null,
  ): SqlDialect => ({ name, codePointCollation }) as SqlDialect;

  it("orders both keys the same way, the id by code point on every engine", () => {
    expect(createdAtOrder(dialect("postgres", '"C"'), "asc")).toBe(
      'created_at ASC, id COLLATE "C" ASC',
    );
    expect(createdAtOrder(dialect("postgres", '"C"'), "desc")).toBe(
      'created_at DESC, id COLLATE "C" DESC',
    );
    expect(createdAtOrder(dialect("mysql", null), "desc")).toBe(
      "created_at DESC, CAST(id AS BINARY) DESC",
    );
    expect(createdAtOrder(dialect("mariadb", null), "asc")).toBe(
      "created_at ASC, CAST(id AS BINARY) ASC",
    );
    expect(createdAtOrder(dialect("sqlite", null), "desc")).toBe(
      "created_at DESC, id DESC",
    );
  });
});

describe("countAddedJobs on an empty range", () => {
  it("answers {} without reading, on a driver that could not connect", async () => {
    // Its database lives in a directory that does not exist: any read fails.
    const driver = new SqlDriver({
      url: "sqlite:///bun-jobs-no-such-directory/jobs.db",
    });

    try {
      expect(await driver.countAddedJobs("ns", { from: T, to: T })).toEqual({});
      expect(
        await driver.countAddedJobs("ns", { from: T + 1, to: T }, "queue"),
      ).toEqual({});
      // The premise: a range that could match does try to read, and fails.
      await expect(
        driver.countAddedJobs("ns", { from: T, to: T + 1 }),
      ).rejects.toThrow();
    } finally {
      await driver.close();
    }
  });
});

for (const engine of ENGINES) {
  describe.skipIf(!engine.url)(`added by state on ${engine.adapter}`, () => {
    it("breaks createdAt ties by code point on an id column in a locale collation", async () => {
      const setupFor = await setup(engine, "ties");
      const statement = await localeIdStatement(engine, setupFor);
      if (statement === null) {
        // SQLite: its ids are compared in `BINARY`, which the contract covers.
        expect(engine.adapter).toBe("sqlite");
        return;
      }

      const { driver, jobs, raw } = setupFor;
      await raw(statement);

      const q: QueueRef = { ns: "ties", queue: "q" };
      // Added against every order that could stand in for the right one.
      await driver.addJobs(q, [
        makeJob({ id: "tie-a", createdAt: T + 5, runAt: T + 5 }),
        makeJob({ id: "early", createdAt: T + 1, runAt: T + 1 }),
        makeJob({ id: "tie-B", createdAt: T + 5, runAt: T + 5 }),
        makeJob({ id: "late", createdAt: T + 9, runAt: T + 9 }),
      ]);

      // The premise: the column now puts `tie-a` first when left to itself.
      const byColumn = await raw(
        `SELECT id FROM ${jobs} WHERE id IN ('tie-a', 'tie-B') ORDER BY id`,
      );
      expect(byColumn.map((row) => row.id)).toEqual(["tie-a", "tie-B"]);

      const ids = async (order: "asc" | "desc"): Promise<string[]> =>
        (
          await driver.findJobs(q, {
            states: ["waiting"],
            offset: 0,
            limit: 10,
            order,
            sort: "createdAt",
          })
        ).jobs.map((job) => job.id);

      expect(await ids("asc")).toEqual(["early", "tie-B", "tie-a", "late"]);
      expect(await ids("desc")).toEqual(["late", "tie-a", "tie-B", "early"]);
    });

    it("counts by queue and state over the claim index", async () => {
      const { driver, jobs, raw } = await setup(engine, "plan");
      const ns = "plan";
      await driver.addJobs({ ns, queue: "a" }, [
        makeJob({ id: "a-1", createdAt: T + 1, runAt: T + 1 }),
        makeJob({ id: "a-2", createdAt: T + 2, runAt: T + 2 }),
        makeJob({ id: "a-old", createdAt: T - 1, runAt: T - 1 }),
      ]);
      await driver.addJobs({ ns, queue: "b" }, [
        makeJob({ id: "b-1", createdAt: T + 3, runAt: T + 3 }),
      ]);

      const range = { from: T, to: T + 10 };
      expect(await driver.countAddedJobs(ns, range)).toEqual({
        a: countsOf({ waiting: 2 }),
        b: countsOf({ waiting: 1 }),
      });
      expect(await driver.countAddedJobs(ns, range, "b")).toEqual({
        b: countsOf({ waiting: 1 }),
      });

      // Where the plan is the driver's to decide, it is the claim index.
      const plan = async (queue?: string): Promise<string> => {
        const values: unknown[] = [];
        const bind = (value: unknown): string => {
          values.push(value);
          return engine.adapter === "postgres" ? `$${values.length}` : "?";
        };
        const text = countAddedStatement(driver.dialect, jobs, bind, {
          ns,
          ...(queue === undefined ? {} : { queue }),
          ...range,
        });
        const rows = await raw(
          engine.adapter === "sqlite"
            ? `EXPLAIN QUERY PLAN ${text}`
            : `EXPLAIN ${text}`,
          values,
        );
        return JSON.stringify(rows);
      };

      if (engine.adapter === "sqlite") {
        // Enough analysed rows (all before the range) for SQLite to weigh a
        // skip-scan: with `created_at` searchable it picks one, `ANY(ns) AND
        // ANY(queue) AND ...`, whose cost grows with the range's width.
        const before = (queue: string, at: number) =>
          makeJob({
            id: `${queue}-before-${at}`,
            state: "completed",
            createdAt: T - 1_000 + at,
            processedOn: T - 1_000 + at,
            finishedOn: T - 1_000 + at,
          });
        for (const queue of ["a", "b"]) {
          const ats = [...Array.from({ length: 200 }).keys()];
          await driver.addJobs(
            { ns, queue },
            ats.map((at) => before(queue, at)),
          );
        }
        await raw("ANALYZE");

        expect(await plan()).toContain(
          `USING COVERING INDEX ${claimIndexName(jobs)} (ns=?)`,
        );
        expect(await plan("b")).toContain(
          `USING COVERING INDEX ${claimIndexName(jobs)} (ns=? AND queue=?)`,
        );
        expect(await driver.countAddedJobs(ns, range)).toEqual({
          a: countsOf({ waiting: 2 }),
          b: countsOf({ waiting: 1 }),
        });
      }
      if (engine.adapter === "mysql") {
        for (const queue of [undefined, "b"]) {
          expect(await plan(queue)).toContain(
            `"key":"${claimIndexName(jobs)}"`,
          );
        }

        // And a table without it still answers: the hint is ignored, not an
        // error, as `FORCE INDEX` would be.
        await raw(`DROP INDEX ${claimIndexName(jobs)} ON ${jobs}`);
        expect(await driver.countAddedJobs(ns, range)).toEqual({
          a: countsOf({ waiting: 2 }),
          b: countsOf({ waiting: 1 }),
        });
      }
    });
  });
}
