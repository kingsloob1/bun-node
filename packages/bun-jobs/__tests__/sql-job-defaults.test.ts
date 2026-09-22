import type {
  JobRecord,
  PendingOptionsRewrite,
  PendingOptionsRewriteResult,
  QueueRef,
  StoredJobOptions,
} from "../lib/drivers/driver";
import type { SqlAdapter } from "../lib/drivers/sql/dialect";
import { join } from "node:path";
import process from "node:process";
import { SQL } from "bun";
import { afterAll, describe, expect, it } from "bun:test";
import { claimIndexName } from "../lib/drivers/sql/schema";
import {
  rewritePageStatement,
  SQL_TABLES,
  SqlDriver,
} from "../lib/drivers/sql/sql-driver";
import { JOB_OPTION_BITS } from "../lib/queue/jobDefaults";
import { takeBooleanParam } from "../lib/shared/connection";
import { newId } from "../lib/shared/ids";
import { jobOptions, makeJob, makeTmpDir, testNamespace } from "./helpers";

/**
 * The SQL driver's `rewritePendingOptions`, `updateJob`'s priority bit and
 * their dialect helpers, on every engine: what the shared contract cannot see.
 *
 * The contract holds every backend to the same answers. This file holds the
 * SQL driver to the parts that are its own — both ways Postgres stores an
 * `opts` document (an object, or a JSON string holding one), batches that
 * cross the per-engine batch size, a rewrite racing real claims, the walk's
 * plan on each engine, and the MySQL / MariaDB index hint's fallback.
 *
 * SQLite always runs; Postgres, MySQL and MariaDB run when their URL is set:
 *
 * ```bash
 * BUN_JOBS_TEST_POSTGRES_URL=… BUN_JOBS_TEST_MYSQL_URL=… BUN_JOBS_TEST_MARIADB_URL=… bun test
 * ```
 *
 * Every case uses a namespace of its own and purges exactly that; the one
 * case that needs tables of its own drops exactly the tables it created.
 * Nothing here imports the package root, so it runs whatever else is
 * mid-edit.
 */

/** Every engine this file can reach. */
const ENGINES: { adapter: SqlAdapter; url?: string; variable?: string }[] = [
  { adapter: "sqlite" },
  {
    adapter: "postgres",
    url: process.env.BUN_JOBS_TEST_POSTGRES_URL,
    variable: "BUN_JOBS_TEST_POSTGRES_URL",
  },
  {
    adapter: "mysql",
    url: process.env.BUN_JOBS_TEST_MYSQL_URL,
    variable: "BUN_JOBS_TEST_MYSQL_URL",
  },
  {
    adapter: "mariadb",
    url: process.env.BUN_JOBS_TEST_MARIADB_URL,
    variable: "BUN_JOBS_TEST_MARIADB_URL",
  },
];

/** The rewrite's batch per engine, as `REWRITE_BATCH` sets it. */
const BATCH: Record<SqlAdapter, number> = {
  postgres: 500,
  mysql: 500,
  mariadb: 500,
  sqlite: 200,
};

/** The table prefix the server suites share; rows are kept apart by namespace. */
const SHARED_PREFIX = "bun_jobs_test_";

/** Work to run when the file ends: purges, closes, drops. */
const cleanups: (() => Promise<unknown>)[] = [];

afterAll(async () => {
  // In reverse: a purge runs before its driver closes.
  for (const cleanup of cleanups.toReversed()) {
    await cleanup().catch(() => undefined);
  }
});

/** A client for what the driver has no API for: `EXPLAIN`, raw reads, DDL. */
function rawClient(adapter: SqlAdapter, url: string): SQL {
  if (adapter !== "mysql" && adapter !== "mariadb") {
    const client = new SQL({ url });
    cleanups.push(async () => await client.close());
    return client;
  }

  const { url: bare, value } = takeBooleanParam(url, "allowPublicKeyRetrieval");
  const client = new SQL({
    url: bare,
    ...(value === undefined ? {} : { allowPublicKeyRetrieval: value }),
  });
  cleanups.push(async () => await client.close());
  return client;
}

/** The connection URL for an engine: a fresh SQLite file, or the server's. */
async function urlOf(engine: (typeof ENGINES)[number]): Promise<string> {
  if (engine.adapter !== "sqlite") {
    return engine.url!;
  }

  const tmp = await makeTmpDir("bun-jobs-sql-jdef");
  cleanups.push(tmp.cleanup);
  return `sqlite://${join(tmp.path, "jobs.db")}`;
}

/** A job's options as stored, with every default filled in. */
function stored(overrides: Partial<StoredJobOptions> = {}): StoredJobOptions {
  return { ...jobOptions(), ...overrides };
}

/** One full request, every field at the value a case usually wants. */
function request(
  values: PendingOptionsRewrite["values"],
  extra: Partial<PendingOptionsRewrite> = {},
): PendingOptionsRewrite {
  return {
    states: ["waiting", "delayed", "failed", "waiting-children"],
    values,
    cursor: null,
    limit: 1_000,
    includeUnmarked: false,
    dryRun: false,
    now: Date.now(),
    ...extra,
  };
}

/** Calls the rewrite until the walk ends, summing the counts. */
async function walk(
  driver: SqlDriver,
  q: QueueRef,
  base: PendingOptionsRewrite,
): Promise<{ total: PendingOptionsRewriteResult; calls: number }> {
  const total: PendingOptionsRewriteResult = {
    examined: 0,
    rewritten: 0,
    unchanged: 0,
    skippedExplicit: 0,
    skippedUnmarked: 0,
    moved: 0,
    exhausted: 0,
    next: null,
  };
  let cursor: string | null = null;
  let calls = 0;

  do {
    const result = await driver.rewritePendingOptions(q, { ...base, cursor });
    calls++;
    expect(result.examined).toBeLessThanOrEqual(base.limit);

    for (const key of [
      "examined",
      "rewritten",
      "unchanged",
      "skippedExplicit",
      "skippedUnmarked",
      "moved",
      "exhausted",
    ] as const) {
      total[key] += result[key];
    }

    cursor = result.next;
    expect(calls).toBeLessThan(200);
  } while (cursor !== null);

  return { total, calls };
}

/** Claims everything claimable, in claim order, and answers the ids. */
async function drain(
  driver: SqlDriver,
  q: QueueRef,
  now: number,
): Promise<string[]> {
  const ids: string[] = [];

  for (;;) {
    const job = await driver.claimJob(q, {
      workerId: "w-sql-jdef",
      token: newId(),
      lockMs: 60_000,
      now,
    });

    if (!job) {
      return ids;
    }

    ids.push(job.id);
  }
}

for (const engine of ENGINES) {
  const configured = engine.adapter === "sqlite" || engine.url !== undefined;

  describe.skipIf(!configured)(
    `SQL job defaults: ${engine.adapter}${configured ? "" : ` (set ${engine.variable})`}`,
    () => {
      /** The engine's driver for the file, on the shared tables, and its URL. */
      let shared: { driver: SqlDriver; url: string } | undefined;

      /** One driver per engine for the file, on the shared tables. */
      async function driverOf(): Promise<SqlDriver> {
        if (!shared) {
          const url = await urlOf(engine);
          const driver = new SqlDriver({
            url,
            adapter: engine.adapter,
            tablePrefix: SHARED_PREFIX,
          });
          cleanups.push(async () => await driver.close());
          shared = { driver, url };
        }

        return shared.driver;
      }

      /** A queue in a namespace of this case's own, purged when the file ends. */
      async function scope(
        name: string,
      ): Promise<{ driver: SqlDriver; q: QueueRef }> {
        const driver = await driverOf();
        const ns = testNamespace(`sql-jdef-${name}`);
        cleanups.push(async () => await driver.purge(ns));
        return { driver, q: { ns, queue: "jdef" } };
      }

      it("rewrites and marks a job added alone as well as one added in a batch", async () => {
        // On Postgres a single-row insert stores `opts` as a JSON string
        // holding the object, a batch as the object itself: the setters must
        // unwrap the first and leave the second as it is.
        const { driver, q } = await scope("storage");
        const now = Date.now();

        await driver.addJob(
          q,
          makeJob({ id: "alone", runAt: now, opts: stored({ explicit: 0 }) }),
        );
        await driver.addJobs(q, [
          makeJob({ id: "batch", runAt: now, opts: stored({ explicit: 0 }) }),
        ]);

        const backoff = { type: "exponential" as const, delay: 250 };
        const result = await driver.rewritePendingOptions(
          q,
          request({ backoff, timeout: 900, removeOnFail: { count: 3 } }),
        );
        expect(result).toMatchObject({ examined: 2, rewritten: 2 });

        for (const id of ["alone", "batch"]) {
          const job = (await driver.getJob(q, id))!;
          // Objects stored as objects, not strings holding them.
          expect(job.opts.backoff).toEqual(backoff);
          expect(job.opts.removeOnFail).toEqual({ count: 3 });
          expect(job.opts.timeout).toBe(900);
          // Everything else survives the write.
          expect(job.opts).toMatchObject({
            attempts: 1,
            keepStacktraces: 5,
            explicit: 0,
          });

          const updated = await driver.updateJob(q, id, { priority: 4 }, now);
          expect(updated?.opts).toMatchObject({
            priority: 4,
            explicit: JOB_OPTION_BITS.priority,
            timeout: 900,
            backoff,
          });
        }
      });

      it("ORs the priority bit into an existing mask, and leaves a mask that is not a number alone", async () => {
        const { driver, q } = await scope("bit");
        const now = Date.now();

        await driver.addJobs(q, [
          makeJob({
            id: "masked",
            runAt: now,
            opts: stored({
              explicit: JOB_OPTION_BITS.timeout | JOB_OPTION_BITS.priority,
            }),
          }),
          makeJob({
            id: "odd",
            runAt: now,
            // Not a mask this version writes; nothing to OR into.
            opts: stored({ explicit: "4" as unknown as number }),
          }),
          makeJob({ id: "legacy", runAt: now }),
        ]);

        // Added alone, so on Postgres its `opts` is a JSON string holding the
        // object, never rewritten since: the bit must reach inside it.
        await driver.addJob(
          q,
          makeJob({
            id: "alone",
            runAt: now,
            opts: stored({ explicit: JOB_OPTION_BITS.attempts }),
          }),
        );

        await driver.updateJob(q, "masked", { priority: 1 }, now);
        await driver.updateJob(q, "odd", { priority: 1 }, now);
        await driver.updateJob(q, "legacy", { priority: 1 }, now);
        await driver.updateJob(q, "alone", { priority: 1 }, now);

        expect((await driver.getJob(q, "alone"))?.opts).toMatchObject({
          explicit: JOB_OPTION_BITS.attempts | JOB_OPTION_BITS.priority,
          priority: 1,
          attempts: 1,
          keepStacktraces: 5,
        });

        expect((await driver.getJob(q, "masked"))?.opts.explicit).toBe(
          JOB_OPTION_BITS.timeout | JOB_OPTION_BITS.priority,
        );
        expect((await driver.getJob(q, "odd"))?.opts.explicit).toBe(
          "4" as unknown as number,
        );
        const legacy = (await driver.getJob(q, "legacy"))!;
        expect(legacy.opts.explicit).toBeUndefined();
        expect(legacy.opts.priority).toBe(1);
        expect(legacy.priority).toBe(1);
      });

      it("walks across batch boundaries: every job once, FIFO kept, and `next: null` exactly at the limit", async () => {
        const { driver, q } = await scope("batches");
        const now = Date.now();
        const count = BATCH[engine.adapter] * 2 + 7;

        const jobs: JobRecord[] = [];
        for (let index = 0; index < count; index++) {
          jobs.push(
            makeJob({
              id: `j${String(index).padStart(5, "0")}`,
              runAt: now,
              // Pairs share a millisecond, so `id` breaks ties inside a batch.
              createdAt: now + Math.floor(index / 2),
              // Every tenth keeps its priority: it is explicit.
              opts: stored({
                explicit: index % 10 === 0 ? JOB_OPTION_BITS.priority : 0,
              }),
            }),
          );
        }

        for (let at = 0; at < jobs.length; at += 500) {
          await driver.addJobs(q, jobs.slice(at, at + 500));
        }

        // Exactly the limit: one call, and it says the walk is over.
        const dry = await driver.rewritePendingOptions(
          q,
          request({ priority: 2 }, { limit: count, dryRun: true }),
        );
        expect(dry).toMatchObject({
          examined: count,
          rewritten: count - Math.ceil(count / 10),
          skippedExplicit: Math.ceil(count / 10),
          next: null,
        });

        // A limit that does not divide the batch, so pages end mid-batch. A
        // value that moves nothing, so every job is met exactly once.
        const { total, calls } = await walk(
          driver,
          q,
          request({ timeout: 5 }, { limit: BATCH[engine.adapter] + 3 }),
        );
        expect(calls).toBe(Math.ceil(count / (BATCH[engine.adapter] + 3)));
        expect(total).toMatchObject({
          examined: count,
          rewritten: count,
          unchanged: 0,
          moved: 0,
        });

        // A new priority moves each rewritten job ahead of the walk; within
        // one call it is passed over when met again, never counted twice.
        const moved = await driver.rewritePendingOptions(
          q,
          request({ priority: 2 }, { limit: count * 2 }),
        );
        expect(moved).toEqual({ ...dry, next: null });

        // The explicit ones now run first, then the rest in their old order.
        const expected = [
          ...jobs.filter((_, index) => index % 10 === 0),
          ...jobs.filter((_, index) => index % 10 !== 0),
        ].map((job) => job.id);
        expect(await drain(driver, q, now + 10)).toEqual(expected);
      });

      it("never half-writes a job a claim takes while the rewrite runs", async () => {
        const { driver, q } = await scope("race");
        const now = Date.now();
        const count = BATCH[engine.adapter] * 2;

        const jobs: JobRecord[] = [];
        for (let index = 0; index < count; index++) {
          jobs.push(
            makeJob({
              id: `r${String(index).padStart(5, "0")}`,
              runAt: now,
              createdAt: now + index,
              opts: stored({ explicit: 0 }),
            }),
          );
        }
        for (let at = 0; at < jobs.length; at += 500) {
          await driver.addJobs(q, jobs.slice(at, at + 500));
        }

        const claimer = async (): Promise<number> => {
          let taken = 0;
          for (let turn = 0; turn < count / 4; turn++) {
            const job = await driver.claimJob(q, {
              workerId: `w-${turn}`,
              token: newId(),
              lockMs: 60_000,
              now: now + 10,
            });
            if (!job) {
              break;
            }
            taken++;
          }
          return taken;
        };

        const [result] = await Promise.all([
          driver.rewritePendingOptions(
            q,
            request({ attempts: 4, timeout: 99 }, { limit: count * 2 }),
          ),
          claimer(),
          claimer(),
        ]);

        let rewritten = 0;
        for (const { id } of jobs) {
          const job = (await driver.getJob(q, id))!;
          const fresh = job.opts.timeout === 99;

          // Options, attempts and the column all moved together, or none did.
          expect({
            attempts: job.opts.attempts,
            maxAttempts: job.maxAttempts,
          }).toEqual(
            fresh
              ? { attempts: 4, maxAttempts: 4 }
              : { attempts: 1, maxAttempts: 1 },
          );

          // A job still waiting was walked, so it has the new values.
          if (job.state === "waiting") {
            expect(fresh).toBe(true);
          }

          rewritten += fresh ? 1 : 0;
        }

        expect(result.rewritten).toBe(rewritten);
        expect(result.moved).toBe(0);
      });

      it.skipIf(engine.adapter === "sqlite")(
        "neither writes nor counts a job claimed while the walk waits on its row",
        async () => {
          // SQLite has no row locks: its transaction holds the whole database,
          // so no claim can land inside a batch there at all.
          const { driver, q } = await scope("lock");
          const now = Date.now();
          const ids = ["l1", "l2", "l3"];

          await driver.addJobs(
            q,
            ids.map((id, index) =>
              makeJob({
                id,
                runAt: now,
                createdAt: now + index,
                opts: stored({ explicit: 0 }),
              }),
            ),
          );

          const raw = rawClient(engine.adapter, shared!.url);
          const table = `${SHARED_PREFIX}jobs`;
          const row = `ns = '${q.ns}' AND queue = '${q.queue}' AND id = 'l2'`;
          let walk: Promise<PendingOptionsRewriteResult> | undefined;

          // Another transaction holds `l2` — as a claim does between picking
          // the row and moving it — while the walk reaches it, then moves it
          // to `active` and commits. The walk must wait, see it gone, and
          // carry on without it.
          //
          // Locked through the claim index, as the claim's own read locks it.
          // Locking only the primary key and then moving the row (which
          // rewrites its claim-index entry) is a lock-order cycle with a walk
          // that holds that entry — InnoDB answers it with a deadlock, and
          // the dialect's transaction retries the loser.
          const hint = driver.dialect.indexHint(claimIndexName(table));
          await raw.begin(async (tx) => {
            await tx.unsafe(
              `SELECT id FROM ${table}${hint} WHERE ${row} AND state = 'waiting' FOR UPDATE`,
            );
            walk = driver.rewritePendingOptions(
              q,
              request({ timeout: 77 }, { states: ["waiting"] }),
            );
            await Bun.sleep(300);
            await tx.unsafe(
              `UPDATE ${table} SET state = 'active' WHERE ${row}`,
            );
          });

          expect(await walk!).toMatchObject({
            examined: 2,
            rewritten: 2,
            moved: 0,
            next: null,
          });
          expect((await driver.getJob(q, "l2"))?.opts.timeout).toBe(0);
          expect((await driver.getJob(q, "l1"))?.opts.timeout).toBe(77);
          expect((await driver.getJob(q, "l3"))?.opts.timeout).toBe(77);
        },
      );

      it("refuses a stale failure by the child's own row, read in the parent's transaction", async () => {
        const { driver, q } = await scope("stale");
        const now = Date.now();
        const error = { name: "Error", message: "boom" };
        const failure = { completed: false as const, error, ignored: false };

        /** A parent waiting on `child`, which is added as `state` (or not at all). */
        const setup = async (
          parent: string,
          child: string,
          state: JobRecord["state"] | null,
          recorded: boolean,
        ) => {
          await driver.addJobs(q, [
            makeJob({
              id: parent,
              state: "waiting-children",
              runAt: now,
              flow: {
                parent: null,
                children: [{ queue: q.queue, id: child }],
                pending: 1,
                values: {},
                failures: {},
                recorded: false,
              },
            }),
            ...(state === null
              ? []
              : [
                  makeJob({
                    id: child,
                    state,
                    runAt: now,
                    finishedOn: state === "dead" ? now : null,
                    flow: {
                      parent: { queue: q.queue, id: parent },
                      children: [],
                      pending: 0,
                      values: {},
                      failures: {},
                      recorded,
                    },
                  }),
                ]),
          ]);
        };

        // Retried since the failure (its `recorded` reset): only its state,
        // no longer `dead`, says the failure is stale.
        await setup("p-retried", "c-retried", "waiting", false);
        // Already delivered once.
        await setup("p-recorded", "c-recorded", "dead", true);
        // Failed again, not yet delivered: a live failure.
        await setup("p-dead", "c-dead", "dead", false);
        // No record at all: still buries.
        await setup("p-gone", "c-gone", null, false);

        const record = async (parent: string, child: string) =>
          await driver.recordChild(
            q,
            parent,
            { queue: q.queue, id: child },
            failure,
            now,
          );

        expect(await record("p-retried", "c-retried")).toBe("already");
        expect(await record("p-recorded", "c-recorded")).toBe("already");
        expect(await record("p-dead", "c-dead")).toBe("buried");
        expect(await record("p-gone", "c-gone")).toBe("buried");

        expect((await driver.getJob(q, "p-retried"))?.state).toBe(
          "waiting-children",
        );
        expect((await driver.getJob(q, "p-recorded"))?.state).toBe(
          "waiting-children",
        );
        expect((await driver.getJob(q, "p-dead"))?.state).toBe("dead");
        expect((await driver.getJob(q, "p-gone"))?.state).toBe("dead");
      });

      it("reads each page as a range on the claim index", async () => {
        const { driver, q } = await scope("plan");
        const now = Date.now();
        // Enough rows that a full read and sort per page would show: at a few
        // thousand, Postgres rightly prefers exactly that.
        const count = 20_000;
        const jobs: JobRecord[] = [];
        for (let index = 0; index < count; index++) {
          jobs.push(
            makeJob({
              id: `p${String(index).padStart(5, "0")}`,
              runAt: now,
              createdAt: now + index,
              opts: stored({ explicit: 0 }),
            }),
          );
        }
        for (let at = 0; at < jobs.length; at += 500) {
          await driver.addJobs(q, jobs.slice(at, at + 500));
        }

        const raw = rawClient(engine.adapter, shared!.url);
        const table = `${SHARED_PREFIX}jobs`;
        const index = claimIndexName(table);
        const dialect = driver.dialect;
        // As the driver itself does after a large write: plans follow data.
        await raw.unsafe(dialect.analyze(table) ?? "ANALYZE");

        const plan = async (after: boolean): Promise<string> => {
          const values: unknown[] = [];
          const bind = (value: unknown) => {
            values.push(value);
            return dialect.placeholder(values.length);
          };
          const text = rewritePageStatement(dialect, table, bind, {
            ns: q.ns,
            queue: q.queue,
            state: "waiting",
            after: after
              ? {
                  priority: 0,
                  createdAt: now + count / 2,
                  id: `p${String(count / 2).padStart(5, "0")}`,
                }
              : null,
            limit: BATCH[engine.adapter],
            lock: false,
            hinted: true,
          });
          const explain =
            engine.adapter === "sqlite"
              ? "EXPLAIN QUERY PLAN"
              : engine.adapter === "postgres"
                ? "EXPLAIN (COSTS OFF)"
                : "EXPLAIN";
          const rows = (await raw.unsafe(
            `${explain} ${text}`,
            values as never,
          )) as Record<string, unknown>[];
          return rows.map((row) => Object.values(row).join(" | ")).join("\n");
        };

        for (const after of [false, true]) {
          const text = await plan(after);
          expect(text).toContain(index);
          expect(text).not.toMatch(
            /Seq Scan|SCAN bun_jobs_test_jobs\b|\| ALL \|/,
          );

          if (engine.adapter === "mysql" || engine.adapter === "mariadb") {
            // Neither a sort of the page nor a `ref` over the whole state.
            expect(text).not.toContain("filesort");
            if (after) {
              expect(text).toContain("| range |");
            }
          }
        }
      });
    },
  );
}

for (const engine of ENGINES.filter(
  (candidate) =>
    candidate.adapter === "mysql" || candidate.adapter === "mariadb",
)) {
  describe.skipIf(engine.url === undefined)(
    `SQL job defaults: ${engine.adapter} without its claim index`,
    () => {
      it("walks unhinted when the index its hint names is gone", async () => {
        // Tables of this case's own: dropping an index from the shared ones
        // would slow every other suite on the server.
        const prefix = `bun_jobs_jdef_${newId().replaceAll("-", "").slice(-10)}_`;
        const driver = new SqlDriver({
          url: engine.url,
          adapter: engine.adapter,
          tablePrefix: prefix,
        });
        const raw = rawClient(engine.adapter, engine.url!);
        cleanups.push(async () => {
          for (const name of SQL_TABLES) {
            await raw.unsafe(`DROP TABLE IF EXISTS ${prefix}${name}`);
          }
        });
        cleanups.push(async () => await driver.close());

        const q = { ns: testNamespace("sql-jdef-noindex"), queue: "jdef" };
        const now = Date.now();
        await driver.addJobs(q, [
          makeJob({ id: "a", runAt: now, opts: stored({ explicit: 0 }) }),
          makeJob({ id: "b", runAt: now, opts: stored({ explicit: 0 }) }),
        ]);

        await raw.unsafe(
          `DROP INDEX ${claimIndexName(`${prefix}jobs`)} ON ${prefix}jobs`,
        );

        for (const round of [1, 2]) {
          // The first round meets the refusal and retries; the second walks
          // unhinted from the start.
          const result = await driver.rewritePendingOptions(
            q,
            request({ timeout: 10 * round }),
          );
          expect(result).toMatchObject({ examined: 2, rewritten: 2 });
          expect((await driver.getJob(q, "b"))?.opts.timeout).toBe(10 * round);
        }
      });
    },
  );
}
