import type { JobState, QueueRef } from "../lib/index";
import { join } from "node:path";
import process from "node:process";
import { SQL } from "bun";
import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { hasPartialIndexes } from "../lib/drivers/sql/schema";
import { dialectFor, newToken, SQL_TABLES, SqlDriver } from "../lib/index";
import { takeBooleanParam } from "../lib/shared/connection";
import { makeJob, makeTmpDir, testNamespace } from "./helpers";

/**
 * The `IS NOT NULL` the SQL listing writes so a partial index can serve its
 * order (`SqlDriver`'s `#listNotNull`).
 *
 * The predicate is only sound because every `active` row has a
 * `lock_expires_at` and every `completed`/`dead` row a `finished_on`. That is
 * an invariant of the write paths, not of the schema — the columns are
 * nullable — so it is asserted here against the database, after every path
 * that reaches those states has been driven through the public API. If any of
 * them ever stops writing the column, the listing would start silently hiding
 * rows, and these fail instead.
 *
 * The listings themselves are checked against the same states read without the
 * predicate, so a page that lost or reordered a row fails too.
 */

/** One engine to run against. */
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

/** What one case gets: a driver over tables of its own, and raw SQL. */
interface Setup {
  /** The table prefix, unique to the case. */
  prefix: string;
  /** The case's driver, closed when the case ends. */
  driver: SqlDriver;
  /** Runs one statement the driver has no API for, returning its rows. */
  raw: (text: string) => Promise<Record<string, unknown>[]>;
}

/** Tables of the case's own on `engine`, every one dropped by name after it. */
async function setup(engine: Engine, label: string): Promise<Setup> {
  const prefix = `lp_${label}_${Math.random().toString(36).slice(2, 8)}_`;

  if (engine.adapter === "sqlite") {
    const tmp = await makeTmpDir("bun-jobs-listing");
    const file = join(tmp.path, "jobs.db");
    const db = new Database(file);
    const driver = new SqlDriver({
      url: `sqlite://${file}`,
      tablePrefix: prefix,
    });
    cleanups.push(async () => {
      await driver.close();
      db.close();
      await tmp.cleanup();
    });

    return {
      prefix,
      driver,
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

  const driver = new SqlDriver({
    url: engine.url,
    adapter: engine.adapter,
    tablePrefix: prefix,
    notify: false,
  });
  cleanups.push(async () => {
    await driver.close();
    for (const table of SQL_TABLES) {
      await client.unsafe(`DROP TABLE IF EXISTS ${prefix}${table}`);
    }
  });

  return {
    prefix,
    driver,
    raw: async (text) =>
      (await client.unsafe(text)) as Record<string, unknown>[],
  };
}

/**
 * Drives one job into each state the listing predicates rest on, through the
 * public API only — a claim for `active`, a completion, a failure with no
 * retry and a bury for the finished ones — plus the states that carry neither
 * column, so a listing of them is checked to be untouched.
 *
 * @param driver The case's driver.
 * @param q The queue to fill.
 * @returns The ids put into each state.
 */
async function fill(
  driver: SqlDriver,
  q: QueueRef,
): Promise<Record<string, string[]>> {
  const now = Date.now();
  // Named for creation order, which — every priority being equal — is claim
  // order. `j7` is not due, so it is the one job a claim never reaches.
  const ids = ["j0", "j1", "j2", "j3", "j4", "j5", "j6", "j7", "j8"];

  await driver.addJobs(
    q,
    ids.map((id, index) =>
      makeJob({
        id,
        // `j7` is added already scheduled — a record carries its own state, so
        // a future `runAt` alone would still be `waiting` and claimable.
        ...(id === "j7"
          ? { state: "delayed" as const, runAt: now + 600_000 }
          : { runAt: now }),
        createdAt: now + index,
        maxAttempts: 3,
      }),
    ),
  );

  /** Claims the head of the queue, returning it with its lock token. */
  const claim = async (): Promise<{ id: string; token: string }> => {
    const token = newToken();
    const job = await driver.claimJob(q, {
      workerId: "w-1",
      token,
      lockMs: 300_000,
      now,
    });
    if (!job) {
      throw new Error("nothing to claim");
    }
    return { id: job.id, token };
  };

  const claimed = [];
  for (let i = 0; i < 7; i += 1) {
    claimed.push(await claim());
  }
  // The invariant this test rests on is only meaningful if the states were
  // really reached the way a worker reaches them.
  if (claimed.map((c) => c.id).join(",") !== "j0,j1,j2,j3,j4,j5,j6") {
    throw new Error(
      `unexpected claim order: ${claimed.map((c) => c.id).join(",")}`,
    );
  }

  await driver.completeJob(q, "j0", claimed[0]!.token, 1, false, now);
  await driver.completeJob(q, "j1", claimed[1]!.token, 2, false, now);
  // A failure with no retry left settles as `dead`.
  await driver.failJob(
    q,
    "j2",
    claimed[2]!.token,
    { name: "Error", message: "no retry" },
    { retry: false, retention: false },
    now,
    5,
  );
  // The other way into `dead`: buried while held, so its token is given.
  await driver.buryJob!(
    q,
    "j3",
    { name: "Error", message: "buried" },
    { retention: false, keepStacktraces: 5, token: claimed[3]!.token },
    now,
  );
  // A retry leaves the job `failed` and due later, with no `finished_on` —
  // which is why `failed` is not one of the states carrying the predicate.
  await driver.failJob(
    q,
    "j4",
    claimed[4]!.token,
    { name: "Error", message: "retry" },
    { retry: true, runAt: now + 600_000 },
    now,
    5,
  );

  return {
    active: ["j5", "j6"],
    completed: ["j0", "j1"],
    dead: ["j2", "j3"],
    waiting: ["j8"],
    delayed: ["j7"],
    failed: ["j4"],
  };
}

for (const engine of ENGINES) {
  const label = `SQL listing predicates (${engine.adapter})`;

  if (!engine.url) {
    describe.skip(`${label} — no URL configured`, () => {
      it.skip("skipped", () => undefined);
    });
    continue;
  }

  describe(label, () => {
    it("never lists a row the predicate could hide: every active job has a lock, every finished job a finish time", async () => {
      const made = await setup(engine, "inv");
      const q: QueueRef = { ns: testNamespace("lp"), queue: "inv" };
      const expected = await fill(made.driver, q);

      // The invariant the predicate rests on, asked of the table itself.
      const table = `${made.prefix}jobs`;
      const [locks] = await made.raw(
        `SELECT COUNT(*) AS n FROM ${table} WHERE state = 'active' AND lock_expires_at IS NULL`,
      );
      expect(Number(locks!.n)).toBe(0);
      const [finished] = await made.raw(
        `SELECT COUNT(*) AS n FROM ${table} WHERE state IN ('completed', 'dead') AND finished_on IS NULL`,
      );
      expect(Number(finished!.n)).toBe(0);

      // And that the listing agrees with the counts, which never carry a
      // predicate: a hidden row would show up here as a short page.
      const counts = await made.driver.countJobs(q);
      for (const [state, ids] of Object.entries(expected)) {
        expect(counts[state as JobState]).toBe(ids.length);
        const listed = await made.driver.listJobs(q, [state as JobState], {
          offset: 0,
          limit: 50,
          order: "asc",
        });
        expect(listed.map((job) => job.id).sort()).toEqual(ids);
      }

      // The negative control: break the invariant by hand and the same checks
      // must notice. Without this, a listing that emits no predicate at all
      // would pass everything above.
      await made.raw(
        `UPDATE ${table} SET lock_expires_at = NULL WHERE state = 'active' AND id = 'j5'`,
      );
      const [broken] = await made.raw(
        `SELECT COUNT(*) AS n FROM ${table} WHERE state = 'active' AND lock_expires_at IS NULL`,
      );
      expect(Number(broken!.n)).toBe(1);
      const after = await made.driver.listJobs(q, ["active"], {
        offset: 0,
        limit: 50,
        order: "asc",
      });
      // Which is exactly the harm the invariant prevents — on the engines that
      // write the predicate, the row is gone from the listing while `countJobs`
      // still counts it.
      expect(after.map((job) => job.id)).toEqual(
        hasPartialIndexes(dialectFor(engine.adapter)) ? ["j6"] : ["j5", "j6"],
      );
      expect((await made.driver.countJobs(q)).active).toBe(2);
    }, 60_000);

    it("returns the same rows, in the same order, as the same listing read without the predicate", async () => {
      const made = await setup(engine, "same");
      const q: QueueRef = { ns: testNamespace("lp"), queue: "same" };
      await fill(made.driver, q);

      const table = `${made.prefix}jobs`;
      const escaped = q.ns.replaceAll("'", "''");

      for (const [state, column] of [
        ["active", "lock_expires_at"],
        ["completed", "finished_on"],
        ["dead", "finished_on"],
      ] as const) {
        for (const order of ["asc", "desc"] as const) {
          const direction = order === "desc" ? "DESC" : "ASC";
          // The listing as it was before the predicate existed, run directly.
          const raw = await made.raw(
            `SELECT id FROM ${table}
              WHERE ns = '${escaped}' AND queue = '${q.queue}'
                AND state = '${state}'
              ORDER BY ${column} ${direction}, id ${direction}
              LIMIT 50 OFFSET 0`,
          );
          const listed = await made.driver.listJobs(q, [state], {
            offset: 0,
            limit: 50,
            order,
          });
          expect(listed.map((job) => job.id)).toEqual(
            raw.map((row) => String(row.id)),
          );
          expect(listed.length).toBeGreaterThan(0);
        }
      }
    }, 60_000);

    it("agrees with its own total, and pages a filtered listing the same way", async () => {
      const made = await setup(engine, "find");
      const q: QueueRef = { ns: testNamespace("lp"), queue: "find" };
      const expected = await fill(made.driver, q);

      for (const state of ["active", "completed", "dead"] as const) {
        const whole = await made.driver.findJobs(q, {
          states: [state],
          offset: 0,
          limit: 50,
          order: "asc",
          total: true,
        });
        expect(whole.total).toBe(expected[state]!.length);
        expect(whole.jobs.map((job) => job.id).sort()).toEqual(
          expected[state]!,
        );

        // The second page of one, walked: the predicate is in the page and in
        // the count alike, so the two cannot disagree about how many there are.
        const second = await made.driver.findJobs(q, {
          states: [state],
          offset: 1,
          limit: 1,
          order: "asc",
          total: true,
        });
        expect(second.total).toBe(whole.total);
        expect(second.jobs.map((job) => job.id)).toEqual([whole.jobs[1]!.id]);
      }

      // Several states at once take no predicate at all — their order is
      // creation, which neither column serves.
      const both = await made.driver.findJobs(q, {
        states: ["completed", "dead"],
        offset: 0,
        limit: 50,
        order: "asc",
        total: true,
      });
      expect(both.total).toBe(4);
      expect(both.jobs.map((job) => job.id).sort()).toEqual(
        [...expected.completed!, ...expected.dead!].sort(),
      );

      // And a listing sorted by creation takes none either, on any state.
      const byCreated = await made.driver.findJobs(q, {
        states: ["completed"],
        sort: "createdAt",
        offset: 0,
        limit: 50,
        order: "asc",
        total: true,
      });
      expect(byCreated.total).toBe(2);
      expect(byCreated.jobs.map((job) => job.id).sort()).toEqual(
        expected.completed!,
      );
    }, 60_000);
  });
}
