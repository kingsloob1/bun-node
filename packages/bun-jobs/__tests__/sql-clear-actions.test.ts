import type { QueueRef } from "../lib/index";
import { join } from "node:path";
import process from "node:process";
import { SQL } from "bun";
import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { SQL_TABLES, SqlDriver } from "../lib/index";
import { takeBooleanParam } from "../lib/shared/connection";
import { makeJob, makeTmpDir } from "./helpers";

/**
 * `clearJobLogs` on the SQL driver, beyond the shared contract ("clearing a
 * job's log"): what the contract, which only ever calls one method at a time,
 * cannot see.
 *
 * - **The active refusal is decided under the job's row lock.** A claim that
 *   lands while the clear waits for the row makes the clear answer `active`
 *   and remove nothing — a clear that read the state first, and wrote after,
 *   would empty a running job's log.
 * - **The key is rotated, not just emptied.** A line an append wrote under
 *   the old key after the clear's delete is counted by no read, and the
 *   maintenance sweep removes it: nothing leaks.
 *
 * Postgres, MySQL and MariaDB run only when their URL is set; SQLite always.
 * Every case makes tables of its own and drops exactly those.
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

/** A second connection that can hold a transaction open. */
interface Holder {
  /** Starts a write transaction. */
  begin: () => Promise<void>;
  /** Runs one statement inside it. */
  run: (text: string) => Promise<void>;
  /** Commits it and gives the connection back. */
  commit: () => Promise<void>;
}

/** What one case gets: a driver over tables of its own, and raw SQL. */
interface Setup {
  /** The jobs table's name. */
  jobs: string;
  /** The job-log table's name. */
  logs: string;
  /** A connected driver over the case's tables; closed when the case ends. */
  driver: SqlDriver;
  /** Runs one statement the driver has no API for, returning its rows. */
  raw: (text: string) => Promise<Record<string, unknown>[]>;
  /** Opens a second connection to hold a transaction on. */
  holder: () => Promise<Holder>;
}

/** A prefix nothing else uses, ending in `_` as the naming wants. */
function uniquePrefix(label: string): string {
  return `cl_${label}_${Math.random().toString(36).slice(2, 8)}_`;
}

/** Tables of the case's own on `engine`, every one dropped by name after it. */
async function setup(engine: Engine, label: string): Promise<Setup> {
  const prefix = uniquePrefix(label);
  const names = { jobs: `${prefix}jobs`, logs: `${prefix}logs` };

  if (engine.adapter === "sqlite") {
    const tmp = await makeTmpDir("bun-jobs-clear");
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
      ...names,
      driver,
      raw: async (text) =>
        db.query(text).all() as unknown as Record<string, unknown>[],
      holder: async () => {
        const held = new Database(file);
        cleanups.push(async () => held.close());
        return {
          begin: async () => {
            held.run("BEGIN IMMEDIATE");
          },
          run: async (text) => {
            held.run(text);
          },
          commit: async () => {
            held.run("COMMIT");
          },
        };
      },
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
    ...names,
    driver,
    raw: async (text) =>
      (await client.unsafe(text)) as Record<string, unknown>[],
    holder: async () => {
      const reserved = await client.reserve();
      let open = false;
      cleanups.push(async () => {
        if (open) {
          await reserved.unsafe("ROLLBACK").catch(() => undefined);
        }
        reserved.release();
      });
      return {
        begin: async () => {
          await reserved.unsafe("BEGIN");
          open = true;
        },
        run: async (text) => {
          await reserved.unsafe(text);
        },
        commit: async () => {
          await reserved.unsafe("COMMIT");
          open = false;
        },
      };
    },
  };
}

/** The whole log, oldest first. */
const ALL = { offset: 0, limit: 1000, order: "asc" } as const;

/** A fixed instant the cases build around. */
const T = 1_700_000_000_000;

/** `WHERE` for one job, spelled with literals every engine reads alike. */
function jobWhere(q: QueueRef, id: string): string {
  return `ns = '${q.ns}' AND queue = '${q.queue}' AND id = '${id}'`;
}

for (const engine of ENGINES) {
  describe.skipIf(!engine.url)(
    `SqlDriver (${engine.adapter}) clearJobLogs`,
    () => {
      it("answers active, removing nothing, for a job claimed while the clear waited for its row", async () => {
        const env = await setup(engine, "race");
        const { driver, jobs } = env;
        const q: QueueRef = { ns: "clear", queue: "race" };

        await driver.addJob(q, makeJob({ id: "busy", runAt: T }));
        await driver.addJobLog(q, "busy", "started", 0);
        await driver.addJobLog(q, "busy", "working", 0);

        // Another connection claims the job and holds its row, uncommitted.
        const holder = await env.holder();
        await holder.begin();
        await holder.run(
          `UPDATE ${jobs} SET state = 'active' WHERE ${jobWhere(q, "busy")}`,
        );

        const clearing = driver.clearJobLogs(q, "busy");
        // Long enough for the clear to reach the row and wait on it.
        await Bun.sleep(150);
        await holder.commit();

        expect(await clearing).toEqual({ status: "active" });
        expect(await driver.getJobLogs(q, "busy", ALL)).toEqual({
          logs: ["started", "working"],
          count: 2,
        });
        // And the running job keeps logging under the key it had.
        expect(await driver.addJobLog(q, "busy", "still going", 0)).toBe(3);
      });

      it("never counts a line written under the old key after the clear, and the sweep removes it", async () => {
        const { driver, jobs, logs, raw } = await setup(engine, "rotate");
        const q: QueueRef = { ns: "clear", queue: "rotate" };

        await driver.addJob(q, makeJob({ id: "job", runAt: T }));
        await driver.addJobLog(q, "job", "old", 0);
        const [before] = await raw(
          `SELECT log_key FROM ${jobs} WHERE ${jobWhere(q, "job")}`,
        );
        const oldKey = String(before!.log_key);

        expect(await driver.clearJobLogs(q, "job")).toEqual({
          status: "cleared",
          removed: 1,
        });

        // An append that read the job's key before the clear, landing after it.
        await raw(
          `INSERT INTO ${logs} (ns, queue, job_id, log_key, message)
         VALUES ('${q.ns}', '${q.queue}', 'job', '${oldKey}', 'straggler')`,
        );

        expect(await driver.addJobLog(q, "job", "new", 0)).toBe(1);
        expect(await driver.getJobLogs(q, "job", ALL)).toEqual({
          logs: ["new"],
          count: 1,
        });

        // The maintenance tick's sweep finds it keyed to no job, and removes it.
        await driver.pruneExpired(q, Date.now(), 100);
        const left = await raw(
          `SELECT message FROM ${logs} WHERE log_key = '${oldKey}'`,
        );
        expect(left).toEqual([]);
        expect(await driver.getJobLogs(q, "job", ALL)).toEqual({
          logs: ["new"],
          count: 1,
        });
      });
    },
  );
}
