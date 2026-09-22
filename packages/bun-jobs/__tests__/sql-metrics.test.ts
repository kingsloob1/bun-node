import type { SQL } from "bun";
import type { QueueRef } from "../lib/drivers/driver";
import type { MetricsOptions } from "../lib/drivers/metrics";
import type { SqlAdapter } from "../lib/index";
import { join } from "node:path";
import process from "node:process";
import { SQL as BunSQL } from "bun";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  MINUTE_BUCKET_MS,
  SECOND_BUCKET_MS,
} from "../lib/api/contract/constants";
import {
  bucketStart,
  DURATION_HISTOGRAM_SIZE,
  durationBin,
} from "../lib/drivers/metrics";
import {
  BUSYNESS_COLUMNS,
  createSchema,
  DURATION_BIN_COLUMNS,
  DURATION_STAT_COLUMNS,
  METRIC_KEY_COLUMNS,
  schemaDefinition,
} from "../lib/drivers/sql/schema";
import { dialectFor, SqlDriver } from "../lib/index";
import { takeBooleanParam } from "../lib/shared/connection";
import { makeTmpDir, testNamespace } from "./helpers";

/**
 * What is SQL-specific about the analytics tables.
 *
 * The behaviour every backend shares is the `analytics` block of the driver
 * contract, which this driver passes unchanged on all four engines. What is
 * only true here is the shape of the three tables, the rule that a bucket is
 * **one shared row** however many processes counted into it, that a flush is
 * **one statement per table** rather than one per row, that the retention
 * sweep runs **once a minute by range** rather than per entity, and that a
 * freshly created schema reports no drift.
 *
 * SQLite runs everywhere. The three servers run when their URL is set:
 *
 * ```bash
 * bun scripts/setup-databases.ts
 * BUN_JOBS_TEST_POSTGRES_URL=… BUN_JOBS_TEST_MYSQL_URL=… BUN_JOBS_TEST_MARIADB_URL=… bun test
 * ```
 *
 * **Every namespace this file creates is purged by name, and every table it
 * creates is dropped by its exact name** — never a `LIKE` sweep, because other
 * sessions share these servers.
 */

/** The eight tables the driver shipped with, before analytics. */
const SHIPPED_TABLES = [
  "jobs",
  "locks",
  "kv",
  "events",
  "logs",
  "run_logs",
  "workers",
  "metrics",
] as const;

/** The three tables the analytics buckets live in. */
const ANALYTICS_TABLES = [
  "queue_metrics",
  "worker_metrics",
  "runner_metrics",
] as const;

/** One engine this file can run against. */
interface Engine {
  /** Which engine. */
  adapter: SqlAdapter;
  /** Its connection URL, or `undefined` when the suite has none. */
  url?: string;
  /** The variable that would provide one. */
  variable: string;
}

const ENGINES: Engine[] = [
  {
    adapter: "postgres",
    variable: "BUN_JOBS_TEST_POSTGRES_URL",
    url: process.env.BUN_JOBS_TEST_POSTGRES_URL,
  },
  {
    adapter: "mysql",
    variable: "BUN_JOBS_TEST_MYSQL_URL",
    url: process.env.BUN_JOBS_TEST_MYSQL_URL,
  },
  {
    adapter: "mariadb",
    variable: "BUN_JOBS_TEST_MARIADB_URL",
    url: process.env.BUN_JOBS_TEST_MARIADB_URL,
  },
];

/** Raw clients opened here, closed when the suite ends. */
const clients: SQL[] = [];
/** The exact tables this run created, dropped by name at the end. */
const madeTables = new Set<{ client: SQL; table: string }>();
/** Temp directories to remove at the end. */
const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  // Every table this file's namespaces live in is one it created itself, so
  // dropping those takes the namespaces with them. By exact name, one at a
  // time: a prefix sweep here would take another session's tables with it.
  for (const { client, table } of madeTables) {
    await client.unsafe(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
  }

  await Promise.allSettled(clients.map(async (each) => await each.close()));
  await Promise.allSettled(cleanups.map(async (each) => await each()));
});

/**
 * A raw client on one engine's URL, for the queries the driver has no API for.
 *
 * Built the way the driver builds its own, `allowPublicKeyRetrieval`
 * included: Bun's client ignores that parameter inside a URL, and MySQL 8.4
 * over a connection without TLS needs it.
 */
function rawClient(url: string): SQL {
  const { url: bare, value } = takeBooleanParam(url, "allowPublicKeyRetrieval");
  const client = new BunSQL({
    url: bare,
    ...(value === undefined ? {} : { allowPublicKeyRetrieval: value }),
  });
  clients.push(client);
  return client;
}

/** A prefix nothing else uses, whose tables are dropped by name at the end. */
function makePrefix(client: SQL, label: string): string {
  const prefix = `mx_${label}_${Math.random().toString(36).slice(2, 8)}_`;

  for (const table of [...SHIPPED_TABLES, ...ANALYTICS_TABLES]) {
    madeTables.add({ client, table: `${prefix}${table}` });
  }

  return prefix;
}

/**
 * A client that remembers every statement the driver sent through it.
 *
 * Passed in as `sql`, which is the driver's own option for bringing a
 * connection — so what it records is exactly what the driver ran, not an
 * approximation of it.
 */
function recordingClient(real: SQL): { sql: SQL; statements: string[] } {
  const statements: string[] = [];

  const sql = new Proxy(real, {
    get(target, property, receiver) {
      if (property === "unsafe") {
        return (text: string, params?: unknown[]) => {
          statements.push(text);
          return target.unsafe(text, params as never);
        };
      }

      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SQL;

  return { sql, statements };
}

/** How many of `statements` are a write of `kind` against `table`. */
function countStatements(
  statements: readonly string[],
  kind: "INSERT INTO" | "DELETE FROM",
  table: string,
): number {
  return statements.filter((text) => text.includes(`${kind} ${table}`)).length;
}

/** One engine's database, opened once for a whole block of cases. */
interface EngineDatabase {
  /** A raw client on it, for reading rows back and seeding a legacy schema. */
  client: SQL;
  /** The table prefix the block's cases share. */
  prefix: string;
  /** A prefix nothing has created tables under yet, dropped by name at the end. */
  freshPrefix: () => string;
  /** A driver on one of those prefixes. */
  open: (prefix: string, sql?: SQL, metrics?: MetricsOptions) => SqlDriver;
}

/** A whole minute that has already passed, so nothing straddles a boundary. */
function lastMinute(): number {
  return bucketStart(Date.now() - MINUTE_BUCKET_MS, MINUTE_BUCKET_MS);
}

/* --- the definition, which needs no database ------------------------ */

describe("SQL analytics: the three tables", () => {
  const dialect = dialectFor("postgres");
  const names = {
    jobs: "j",
    locks: "l",
    kv: "k",
    events: "e",
    logs: "g",
    run_logs: "rl",
    workers: "w",
    metrics: "m",
    queue_metrics: "qm",
    worker_metrics: "wm",
    runner_metrics: "rm",
  };
  const { tables, indexes } = schemaDefinition(names, dialect);
  const byName = new Map(tables.map((table) => [table.name, table]));
  const columnsOf = (table: string): string[] =>
    byName.get(table)!.columns.map((column) => column.name);

  it("keys every bucket by namespace, entity, width and start", () => {
    // A read names an entity, a width and a range of starts — in that order,
    // so it is a range of the key rather than a scan. `ns` leads, as every
    // index in this schema does.
    expect(METRIC_KEY_COLUMNS).toEqual([
      "ns",
      "entity",
      "interval_ms",
      "bucket",
    ]);
    for (const table of ["qm", "wm", "rm"]) {
      expect(byName.get(table)?.primaryKey).toEqual([...METRIC_KEY_COLUMNS]);
    }
  });

  it("carries the counters each kind has, and nothing it does not", () => {
    expect(columnsOf("qm")).toEqual([
      ...METRIC_KEY_COLUMNS,
      "completed",
      "failed",
    ]);
    expect(columnsOf("wm")).toEqual([
      ...METRIC_KEY_COLUMNS,
      "completed",
      "failed",
      ...BUSYNESS_COLUMNS,
    ]);
    expect(columnsOf("rm")).toEqual([
      ...METRIC_KEY_COLUMNS,
      "started",
      "succeeded",
      "failed",
      "timeout",
      "killed",
      "skipped",
      ...DURATION_STAT_COLUMNS,
      ...DURATION_BIN_COLUMNS,
    ]);
  });

  it("gives the histogram one column per bin, in `durationBin`'s own order", () => {
    expect(DURATION_BIN_COLUMNS).toHaveLength(DURATION_HISTOGRAM_SIZE);
    expect(DURATION_BIN_COLUMNS[0]).toBe("h00");
    expect(DURATION_BIN_COLUMNS[DURATION_HISTOGRAM_SIZE - 1]).toBe(
      `h${DURATION_HISTOGRAM_SIZE - 1}`,
    );
    // No second indexing invented: the column a duration lands in is the bin
    // the shared helper puts it in.
    expect(DURATION_BIN_COLUMNS[durationBin(900)]).toBe("h10");
  });

  it("indexes each table for the prune, which names no entity", () => {
    for (const [table, name] of [
      ["qm", "ix_j_qmx_prune"],
      ["wm", "ix_j_wmx_prune"],
      ["rm", "ix_j_rmx_prune"],
    ] as const) {
      const index = indexes.find((each) => each.name === name);
      expect(index?.table).toBe(table);
      expect(index?.columns).toEqual(["ns", "interval_ms", "bucket"]);
    }
  });

  it("leaves the shipped throughput table exactly as it was", () => {
    // The analytics buckets are deliberately not on it, and take none of its
    // eight-way `shard` fan-out — that shard exists for per-job contention,
    // which a once-a-second buffered write does not have.
    expect(columnsOf("m")).toEqual([
      "ns",
      "queue",
      "bucket",
      "shard",
      "completed",
      "failed",
    ]);
    for (const table of ["qm", "wm", "rm"]) {
      expect(columnsOf(table)).not.toContain("shard");
    }
  });

  it("names its tables in lower case, as `run_logs` had to", () => {
    // A mixed-case key would give `resolveNames` a mixed-case table name,
    // which Postgres folds to lower case when it creates it unquoted — and
    // `describeIndexes` would then match nothing, so the sync would propose
    // creating this table's indexes on every run, forever.
    for (const table of ANALYTICS_TABLES) {
      expect(String(table)).toBe(table.toLowerCase());
    }
  });

  it("leaves the analytics tables out for a caller that does not name them", () => {
    const shipped = schemaDefinition(
      {
        jobs: "j",
        locks: "l",
        kv: "k",
        events: "e",
        logs: "g",
        run_logs: "rl",
        workers: "w",
        metrics: "m",
      },
      dialect,
    );

    expect(shipped.tables.map((table) => table.name)).not.toContain("qm");
    expect(shipped.indexes.map((index) => index.name)).not.toContain(
      "ix_j_qmx_prune",
    );
  });
});

/* --- per engine ------------------------------------------------------ */

for (const engine of ENGINES) {
  if (!engine.url) {
    describe.skip(`SQL analytics: ${engine.adapter} (set ${engine.variable})`, () => {
      it("is not configured", () => {});
    });
  }
}

/**
 * Runs the engine-specific cases.
 *
 * `open` makes a driver on a database of this engine's, `client` a raw
 * connection to the same place, and `prefix` a table prefix nothing else uses.
 */
function engineCases(
  adapter: SqlAdapter,
  /**
   * Opens this engine's database once for the whole block.
   *
   * Once, not per case: a driver carries a connection pool, and a file that
   * made one per test exhausted Postgres's `max_connections` partway through
   * — which surfaces as `sorry, too many clients already` on whichever case
   * happens to be running rather than on the one that caused it.
   */
  setUp: () => Promise<EngineDatabase>,
): void {
  describe(`SQL analytics: ${adapter}`, () => {
    /** This block's database, opened once. */
    let engine: EngineDatabase;
    /** The drivers the running case opened, closed as it ends. */
    let opened: SqlDriver[] = [];

    beforeAll(async () => {
      engine = await setUp();

      // The schema, created once and by one driver. `CREATE TABLE IF NOT
      // EXISTS` is not safe against itself on Postgres — four drivers
      // connecting at once race on `pg_type` and one of them fails — and the
      // shared-row case is four drivers on a brand-new prefix.
      const first = engine.open(engine.prefix);
      await first.connect();
      await first.close();
    });

    afterEach(async () => {
      const closing = opened;
      opened = [];
      await Promise.allSettled(closing.map(async (each) => await each.close()));
    });

    /** A driver on this block's database, closed when the case ends. */
    const open = (
      options: {
        /** A connection to use instead of one of the driver's own. */
        sql?: SQL;
        /** A prefix other than the block's shared one. */
        prefix?: string;
        /** What to record; everything at one second by default. */
        metrics?: MetricsOptions;
      } = {},
    ): SqlDriver => {
      const driver = engine.open(
        options.prefix ?? engine.prefix,
        options.sql,
        options.metrics,
      );
      opened.push(driver);
      return driver;
    };

    /** Everything a case needs of the shared database. */
    const make = (): { client: SQL; prefix: string } => ({
      client: engine.client,
      prefix: engine.prefix,
    });

    it("keeps one shared row per (ns, entity, bucket, width), however many processes counted", async () => {
      const { client, prefix } = make();
      // Four drivers is four processes as far as these tables are concerned:
      // each has its own buffer, its own connection and its own flush.
      const writers = [open(), open(), open(), open()];
      const ns = testNamespace("mx-shared");
      const q: QueueRef = { ns, queue: "orders" };
      const at = lastMinute() + 30_000;

      for (const writer of writers) {
        for (let count = 0; count < 5; count++) {
          await writer.countWorkerJobs!(q, "w-1", at, { completed: 1 });
        }
      }
      await Promise.all(
        writers.map(async (each) => await each.flushMetrics!()),
      );

      const rows = (await client.unsafe(
        `SELECT entity, interval_ms, bucket, completed FROM ${prefix}worker_metrics
          WHERE ns = ${adapter === "postgres" ? "$1" : "?"}`,
        [ns] as never,
      )) as {
        entity: string;
        interval_ms: number | string;
        bucket: number | string;
        completed: number | string;
      }[];

      // Twenty counts from four writers, into two widths, for one worker and
      // the namespace roll-up: **four rows**. With the shipped throughput
      // table's per-process shard it would be sixteen, and at a mid-sized
      // namespace's scale that is the difference between 19.5 K rows and
      // 1.25 M.
      expect(rows).toHaveLength(4);
      expect(
        rows.filter((row) => Number(row.interval_ms) === SECOND_BUCKET_MS),
      ).toHaveLength(2);
      expect([...new Set(rows.map((row) => row.entity))].sort()).toEqual([
        "",
        "orders:w-1",
      ]);
      // And nothing was lost by sharing: every row holds all twenty.
      for (const row of rows) {
        expect(Number(row.completed)).toBe(20);
      }

      // The reads agree with the rows.
      expect(
        (
          await writers[0]!.getWorkerMetrics!(q, "w-1", {
            from: bucketStart(at, MINUTE_BUCKET_MS),
            to: bucketStart(at, MINUTE_BUCKET_MS),
            interval: MINUTE_BUCKET_MS,
          })
        ).jobs,
      ).toEqual([
        { at: bucketStart(at, MINUTE_BUCKET_MS), completed: 20, failed: 0 },
      ]);
    }, 45_000);

    it("writes a flush as one upsert per table, not one per row", async () => {
      const { client, prefix } = make();
      const recorder = recordingClient(client);
      const driver = open({ sql: recorder.sql });
      const ns = testNamespace("mx-batch");
      const q: QueueRef = { ns, queue: "orders" };
      const at = lastMinute() + 10_000;

      await driver.connect();
      recorder.statements.length = 0;

      // Forty workers, two widths each, plus the roll-up: 82 rows.
      for (let worker = 0; worker < 40; worker++) {
        await driver.countWorkerJobs!(q, `w-${worker}`, at, { completed: 1 });
      }
      await driver.flushMetrics!();

      const table = `${prefix}worker_metrics`;
      expect(countStatements(recorder.statements, "INSERT INTO", table)).toBe(
        1,
      );

      // Eighty-two rows in it: forty workers at two widths, and the roll-up
      // merged into one row per width however many workers fed it.
      const [counted] = (await client.unsafe(
        `SELECT COUNT(*) AS total FROM ${table} WHERE ns = ${adapter === "postgres" ? "$1" : "?"}`,
        [ns] as never,
      )) as { total: number | string }[];
      expect(Number(counted?.total)).toBe(82);

      // And a batch past the chunk size is split rather than sent whole: 250
      // more workers is 502 further rows, which is three statements.
      recorder.statements.length = 0;
      for (let worker = 0; worker < 250; worker++) {
        await driver.countWorkerJobs!(q, `b-${worker}`, at + 1_000, {
          completed: 1,
        });
      }
      await driver.flushMetrics!();

      expect(countStatements(recorder.statements, "INSERT INTO", table)).toBe(
        3,
      );
    }, 60_000);

    it("sweeps by range once a minute, not per entity and not per flush", async () => {
      const { client, prefix } = make();
      const recorder = recordingClient(client);
      const driver = open({ sql: recorder.sql });
      const ns = testNamespace("mx-prune");
      const q: QueueRef = { ns, queue: "orders" };
      const now = Date.now();
      const minute = lastMinute();

      await driver.connect();
      recorder.statements.length = 0;

      // The first flush spends the clock's first tick, so the ancient buckets
      // below are certain to be stored before a sweep can reach them.
      await driver.countWorkerJobs!(q, "w-warm", minute, { completed: 1 });
      await driver.flushMetrics!();

      const table = `${prefix}worker_metrics`;
      // Two widths on this table — six deletes across the three — and every
      // one of them names a range rather than an entity.
      expect(countStatements(recorder.statements, "DELETE FROM", table)).toBe(
        2,
      );
      for (const text of recorder.statements.filter((each) =>
        each.includes(`DELETE FROM ${table}`),
      )) {
        expect(text).toContain("bucket <");
        expect(text).not.toContain("entity");
      }

      // A second flush straight after is not due, so it sweeps nothing.
      recorder.statements.length = 0;
      await driver.countWorkerJobs!(q, "w-warm", minute, { completed: 1 });
      await driver.flushMetrics!();
      expect(countStatements(recorder.statements, "DELETE FROM", table)).toBe(
        0,
      );

      // Two ancient buckets, one of which nothing ever writes to again.
      const ancient = bucketStart(now - 25 * 60 * 60_000, MINUTE_BUCKET_MS);
      for (const key of ["w-kept", "w-gone"]) {
        await driver.countWorkerJobs!(q, key, ancient, { completed: 1 });
      }
      await driver.flushMetrics!();

      const range = {
        from: ancient,
        to: ancient,
        interval: MINUTE_BUCKET_MS,
      };
      expect(
        (await driver.getWorkerMetrics!(q, "w-gone", range)).jobs,
      ).toHaveLength(1);

      // A count far enough ahead that the sweep is due again. `w-gone` has had
      // no write since, so a prune driven by an entity's own writes would
      // never reach it.
      const ahead = bucketStart(now + 10 * MINUTE_BUCKET_MS, MINUTE_BUCKET_MS);
      await driver.countWorkerJobs!(q, "w-kept", ahead, { completed: 1 });
      await driver.flushMetrics!();

      expect((await driver.getWorkerMetrics!(q, "w-kept", range)).jobs).toEqual(
        [],
      );
      expect((await driver.getWorkerMetrics!(q, "w-gone", range)).jobs).toEqual(
        [],
      );
      // The sweep is this namespace's, so it cannot reach another session's
      // rows on the same shared table.
      for (const text of recorder.statements.filter((each) =>
        each.includes(`DELETE FROM ${table}`),
      )) {
        expect(text).toContain("ns =");
      }
    }, 60_000);

    it("stores a duration in the column its bin names, and adds the bins on merge", async () => {
      const { client, prefix } = make();
      const first = open();
      const second = open();
      const ns = testNamespace("mx-hist");
      const runner = "reports";
      const at = lastMinute() + 20_000;

      // Two writers, the same bucket, the same bin — and, for one of them, a
      // second run far enough away to land in another.
      await first.countRunnerRun!(ns, runner, at, {
        succeeded: 1,
        durationMs: 900,
      });
      await second.countRunnerRun!(ns, runner, at, {
        succeeded: 1,
        durationMs: 900,
      });
      await second.countRunnerRun!(ns, runner, at, {
        succeeded: 1,
        durationMs: 5,
      });
      await first.flushMetrics!();
      await second.flushMetrics!();

      const minute = bucketStart(at, MINUTE_BUCKET_MS);
      const rows = (await client.unsafe(
        `SELECT ${DURATION_BIN_COLUMNS.join(", ")}, dur_count, dur_min_ms, dur_max_ms, dur_sum_ms
           FROM ${prefix}runner_metrics
          WHERE ns = ${adapter === "postgres" ? "$1" : "?"}
            AND entity = ${adapter === "postgres" ? "$2" : "?"}
            AND interval_ms = ${adapter === "postgres" ? "$3" : "?"}
            AND bucket = ${adapter === "postgres" ? "$4" : "?"}`,
        [ns, runner, MINUTE_BUCKET_MS, minute] as never,
      )) as Record<string, number | string>[];

      // One row, shared by both writers.
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(Number(row[DURATION_BIN_COLUMNS[durationBin(900)]!])).toBe(2);
      expect(Number(row[DURATION_BIN_COLUMNS[durationBin(5)]!])).toBe(1);
      expect(Number(row.dur_count)).toBe(3);
      expect(Number(row.dur_sum_ms)).toBe(1_805);
      // The extremes are guarded by the count: a row the outcome counters
      // touched first has `dur_min_ms` zero, and taking the minimum blindly
      // would report the fastest run as instant.
      expect(Number(row.dur_min_ms)).toBe(5);
      expect(Number(row.dur_max_ms)).toBe(900);

      const read = await first.getRunnerMetrics!(ns, runner, {
        from: minute,
        to: minute,
        interval: MINUTE_BUCKET_MS,
        durations: true,
      });
      expect(read.durations?.[0]?.count).toBe(3);
      expect(read.durations?.[0]?.histogram[durationBin(900)]).toBe(2);
    }, 45_000);

    it("merges two writers' busyness into one row, keeping the later sample's concurrency", async () => {
      const early = open();
      const late = open();
      const ns = testNamespace("mx-busy");
      const q: QueueRef = { ns, queue: "orders" };
      const minute = lastMinute();

      // Written in the wrong order on purpose: a rolling redeploy has two
      // incarnations under one key, and the earlier heartbeat must not become
      // "the concurrency as of the last sample".
      await late.sampleWorkerBusyness!(q, "w", minute + 20_000, {
        active: 6,
        concurrency: 9,
      });
      await late.flushMetrics!();
      await early.sampleWorkerBusyness!(q, "w", minute + 10_000, {
        active: 2,
        concurrency: 5,
      });
      await early.flushMetrics!();

      const read = await early.getWorkerMetrics!(q, "w", {
        from: minute,
        to: minute,
        interval: MINUTE_BUCKET_MS,
        busyness: true,
      });

      expect(read.busyness).toEqual([
        {
          at: minute,
          samples: 2,
          activeSum: 8,
          activeMax: 6,
          concurrency: 9,
          lastAt: minute + 20_000,
        },
      ]);
    }, 45_000);

    it("records only what it was told to, and says so", async () => {
      const { client, prefix } = make();
      // The levers a large fleet reaches for: per-second off, and the worker
      // series — the term that scales with the fleet — off with it.
      const driver = open({
        metrics: { resolution: "minute", workers: false },
      });
      const ns = testNamespace("mx-options");
      const q: QueueRef = { ns, queue: "orders" };
      const minute = lastMinute();

      expect(driver.getMetricsSupport!()).toEqual({
        resolutions: [60],
        retentionMs: { 60: 24 * 60 * 60_000 },
        recording: {
          resolution: "minute",
          secondRetentionMs: 0,
          workers: false,
          runners: true,
          durations: true,
        },
      });

      await driver.countWorkerJobs!(q, "w", minute, { completed: 1 });
      await driver.countRunnerRun!(ns, "nightly", minute, { started: 1 });
      await driver.flushMetrics!();

      // A worker count that was turned off is not written at all.
      const [workers] = (await client.unsafe(
        `SELECT COUNT(*) AS total FROM ${prefix}worker_metrics WHERE ns = ${adapter === "postgres" ? "$1" : "?"}`,
        [ns] as never,
      )) as { total: number | string }[];
      expect(Number(workers?.total)).toBe(0);

      // The runner's is — at the minute only, never the second.
      const [runners] = (await client.unsafe(
        `SELECT COUNT(*) AS total FROM ${prefix}runner_metrics
          WHERE ns = ${adapter === "postgres" ? "$1" : "?"}
            AND interval_ms = ${adapter === "postgres" ? "$2" : "?"}`,
        [ns, SECOND_BUCKET_MS] as never,
      )) as { total: number | string }[];
      expect(Number(runners?.total)).toBe(0);
      expect(
        (
          await driver.getRunnerMetrics!(ns, "nightly", {
            from: minute,
            to: minute,
            interval: MINUTE_BUCKET_MS,
          })
        ).runs,
      ).toHaveLength(1);

      // And a kind that is not recorded is absent from the roll-up rather
      // than answering zeros.
      const roll = await driver.getNamespaceMetrics!(ns, {
        from: minute,
        to: minute,
        interval: MINUTE_BUCKET_MS,
        kinds: ["jobs", "runs", "workerJobs"],
      });
      expect(roll.workerJobs).toBeUndefined();
      expect(roll.runs).toHaveLength(1);
    }, 45_000);

    it("finds nothing to sync against the schema it just created", async () => {
      const driver = open();
      await driver.connect();

      // The baseline the whole sync rests on, and the one a new table breaks
      // first: a serial reported back as `bigint` needs `retype: false`, and
      // a mixed-case table name would have the indexes proposed every run.
      expect(await driver.syncSchema({ dryRun: true })).toEqual([]);
    }, 45_000);

    it("creates the analytics tables on an install that predates them, with nothing left to sync", async () => {
      const { client } = make();
      // Its own prefix: the shared one already has every table, so a legacy
      // fixture built on it would prove nothing.
      const prefix = engine.freshPrefix();
      const shipped = Object.fromEntries(
        SHIPPED_TABLES.map((table) => [table, `${prefix}${table}`]),
      ) as Record<(typeof SHIPPED_TABLES)[number], string>;

      // The schema as a version before analytics would have created it.
      for (const statement of createSchema(shipped, dialectFor(adapter))) {
        await client.unsafe(statement);
      }

      const driver = open({ prefix });
      await driver.connect();
      const ns = testNamespace("mx-upgrade");

      // `createSchema` is `IF NOT EXISTS`, so connecting is what adds them.
      await driver.countWorkerJobs!(
        { ns, queue: "orders" },
        "w",
        lastMinute(),
        { completed: 1 },
      );
      await driver.flushMetrics!();

      expect(
        (
          await driver.getWorkerMetrics!({ ns, queue: "orders" }, "w", {
            from: lastMinute(),
            to: lastMinute(),
            interval: MINUTE_BUCKET_MS,
          })
        ).jobs,
      ).toHaveLength(1);
      expect(await driver.syncSchema({ dryRun: true })).toEqual([]);
    }, 45_000);
  });
}

engineCases("sqlite", async () => {
  const tmp = await makeTmpDir("bun-jobs-sql-metrics");
  cleanups.push(tmp.cleanup);
  const url = `sqlite://${join(tmp.path, "metrics.db")}`;
  // The file is this block's own, so its tables go with the directory and
  // nothing here needs dropping by name.
  const fresh = (): string => `mx_${Math.random().toString(36).slice(2, 8)}_`;

  return {
    client: rawClient(url),
    prefix: fresh(),
    freshPrefix: fresh,
    open: (prefix, sql, metrics) =>
      new SqlDriver({
        url,
        tablePrefix: prefix,
        ...(sql ? { sql } : {}),
        ...(metrics ? { metrics } : {}),
      }),
  };
});

for (const engine of ENGINES) {
  if (!engine.url) {
    continue;
  }

  engineCases(engine.adapter, async () => {
    const client = rawClient(engine.url!);
    const fresh = (): string => makePrefix(client, engine.adapter);

    return {
      client,
      prefix: fresh(),
      freshPrefix: fresh,
      open: (prefix, sql, metrics) =>
        new SqlDriver({
          url: engine.url,
          adapter: engine.adapter,
          tablePrefix: prefix,
          notify: false,
          ...(sql ? { sql } : {}),
          ...(metrics ? { metrics } : {}),
        }),
    };
  });
}
