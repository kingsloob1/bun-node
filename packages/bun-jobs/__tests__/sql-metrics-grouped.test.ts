import type { SQL } from "bun";
import type { QueueRef } from "../lib/drivers/driver";
import type { SqlAdapter } from "../lib/index";
import { join } from "node:path";
import process from "node:process";
import { SQL as BunSQL } from "bun";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { MINUTE_BUCKET_MS } from "../lib/api/contract/constants";
import { bucketStart, NAMESPACE_ENTITY } from "../lib/drivers/metrics";
import { SQL_TABLES, SqlDriver } from "../lib/index";
import { takeBooleanParam } from "../lib/shared/connection";
import { makeTmpDir, testNamespace } from "./helpers";

/**
 * What is SQL-specific about the grouped analytics reads.
 *
 * The behaviour every backend shares is the contract's `analytics: grouped
 * reads` block, which this driver passes unchanged on all four engines. What
 * only this driver promises is **how**: a totals read is one `GROUP BY entity`
 * statement and a batch read one `entity IN (...)` statement, however many
 * entities answer; the presence rule is a `HAVING` (busyness shares
 * `worker_metrics` rows with the job counters); every figure is coerced with
 * `Number()` on the way out, because Postgres answers a `SUM` as a string;
 * and a worker key holding a colon splits back whole.
 *
 * SQLite runs everywhere; the three servers when their URL is set. Every
 * table this file creates is under a prefix of its own and dropped by its
 * exact name at the end — never a `LIKE` sweep, since other sessions share
 * these servers.
 */

/** One server engine this file can run against. */
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
const madeTables: { client: SQL; table: string }[] = [];
/** Temp directories to remove at the end. */
const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const { client, table } of madeTables) {
    await client.unsafe(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
  }
  await Promise.allSettled(clients.map(async (each) => await each.close()));
  await Promise.allSettled(cleanups.map(async (each) => await each()));
});

/** A raw client on a URL, built the way the driver builds its own. */
function rawClient(url: string): SQL {
  const { url: bare, value } = takeBooleanParam(url, "allowPublicKeyRetrieval");
  const client = new BunSQL({
    url: bare,
    ...(value === undefined ? {} : { allowPublicKeyRetrieval: value }),
  });
  clients.push(client);
  return client;
}

/**
 * A client that remembers every statement the driver sent through it — passed
 * as the driver's own `sql` option, so what it records is what the driver ran.
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

/** How many of `statements` are a read of `table`. */
function reads(statements: readonly string[], table: string): number {
  return statements.filter(
    (text) => /^\s*SELECT\b/i.test(text) && text.includes(table),
  ).length;
}

/** The start of the minute before last: a whole minute, already past. */
function twoMinutesAgo(): number {
  return bucketStart(Date.now() - 2 * MINUTE_BUCKET_MS, MINUTE_BUCKET_MS);
}

/** One whole minute at minute width. */
function oneMinute(at: number): { from: number; to: number; interval: number } {
  return { from: at, to: at, interval: MINUTE_BUCKET_MS };
}

/** One engine's database, shared by a block's cases. */
interface EngineDatabase {
  /** A raw client on it. */
  client: SQL;
  /** The block's table prefix. */
  prefix: string;
  /** A driver on that prefix, optionally over a given connection. */
  open: (sql?: SQL) => SqlDriver;
}

function engineCases(
  adapter: SqlAdapter,
  setUp: () => Promise<EngineDatabase>,
): void {
  describe(`SQL grouped analytics reads: ${adapter}`, () => {
    let engine: EngineDatabase;
    let opened: SqlDriver[] = [];
    /** Namespaces the cases made, purged by exact name. */
    const namespaces: string[] = [];

    beforeAll(async () => {
      engine = await setUp();
      const first = engine.open();
      await first.connect();
      await first.close();
    });

    afterEach(async () => {
      const closing = opened;
      opened = [];
      await Promise.allSettled(closing.map(async (each) => await each.close()));
    });

    afterAll(async () => {
      const driver = engine.open();
      for (const ns of namespaces) {
        await driver.purge(ns);
      }
      await driver.close();
    });

    const open = (sql?: SQL): SqlDriver => {
      const driver = engine.open(sql);
      opened.push(driver);
      return driver;
    };

    const scope = (name: string): string => {
      const ns = testNamespace(name);
      namespaces.push(ns);
      return ns;
    };

    /** A placeholder for the raw client's own statements. */
    const p = (index: number): string =>
      adapter === "postgres" ? `$${index}` : "?";

    it("answers a totals read and a batch read in one statement each, however many entities", async () => {
      const recorder = recordingClient(engine.client);
      const driver = open(recorder.sql);
      const ns = scope("grs-count");
      const minute = twoMinutesAgo();
      const runners = Array.from({ length: 30 }, (_, i) => `r:job-${i}`);
      const keys = Array.from({ length: 30 }, (_, i) => `w-${i}`);
      const q: QueueRef = { ns, queue: "orders" };

      for (const [i, runner] of runners.entries()) {
        await driver.countRunnerRun(ns, runner, minute + 1_000, {
          succeeded: i + 1,
          durationMs: 10 * (i + 1),
        });
      }
      for (const key of keys) {
        await driver.countWorkerJobs(q, key, minute + 1_000, { completed: 1 });
        await driver.sampleWorkerBusyness(q, key, minute + 2_000, {
          active: 1,
          concurrency: 2,
        });
      }
      await driver.flushMetrics();

      const runnerTable = `${engine.prefix}runner_metrics`;
      const workerTable = `${engine.prefix}worker_metrics`;
      const range = oneMinute(minute);

      recorder.statements.length = 0;
      const totals = await driver.getRunnerMetricsTotals(ns, {
        ...range,
        durations: true,
      });
      expect(totals).toHaveLength(30);
      expect(reads(recorder.statements, runnerTable)).toBe(1);

      recorder.statements.length = 0;
      const batch = await driver.getRunnerMetricsMany(
        ns,
        runners.slice(0, 20),
        {
          ...range,
          durations: true,
        },
      );
      expect(batch).toHaveLength(20);
      expect(reads(recorder.statements, runnerTable)).toBe(1);

      recorder.statements.length = 0;
      const workers = await driver.getWorkerMetricsTotals(ns, {
        ...range,
        busyness: true,
      });
      expect(workers).toHaveLength(30);
      expect(reads(recorder.statements, workerTable)).toBe(1);

      recorder.statements.length = 0;
      const workerBatch = await driver.getWorkerMetricsMany(
        ns,
        keys.slice(0, 20).map((key) => ({ queue: "orders", key })),
        { ...range, busyness: true },
      );
      expect(workerBatch).toHaveLength(20);
      expect(reads(recorder.statements, workerTable)).toBe(1);

      // And nothing at all for a request that can answer nothing.
      recorder.statements.length = 0;
      expect(
        await driver.getRunnerMetricsTotals(ns, { ...range, runners: [] }),
      ).toEqual([]);
      expect(
        await driver.getWorkerMetricsTotals(ns, { ...range, queues: [] }),
      ).toEqual([]);
      expect(await driver.getRunnerMetricsMany(ns, [], range)).toEqual([]);
      expect(await driver.getWorkerMetricsMany(ns, [], range)).toEqual([]);
      expect(reads(recorder.statements, engine.prefix)).toBe(0);
    }, 60_000);

    it("keeps a busyness-only worker out unless busyness is asked for (the HAVING)", async () => {
      const driver = open();
      const ns = scope("grs-having");
      const q: QueueRef = { ns, queue: "orders" };
      const minute = twoMinutesAgo();

      await driver.sampleWorkerBusyness(q, "idle", minute + 5_000, {
        active: 0,
        concurrency: 3,
      });
      await driver.countWorkerJobs(q, "busy", minute + 5_000, { completed: 1 });
      await driver.flushMetrics();

      // The row is there, with zero counters — so what keeps it out is the
      // HAVING, not the absence of a row.
      const stored = (await engine.client.unsafe(
        `SELECT completed, failed, samples FROM ${engine.prefix}worker_metrics
          WHERE ns = ${p(1)} AND entity = ${p(2)} AND interval_ms = ${p(3)}`,
        [ns, "orders:idle", MINUTE_BUCKET_MS] as never,
      )) as Record<string, unknown>[];
      expect(stored).toHaveLength(1);
      expect(Number(stored[0]!.completed)).toBe(0);
      expect(Number(stored[0]!.samples)).toBe(1);

      const range = oneMinute(minute);
      const plain = await driver.getWorkerMetricsTotals(ns, range);
      expect(plain.map((row) => row.key)).toEqual(["busy"]);

      const asked = await driver.getWorkerMetricsTotals(ns, {
        ...range,
        busyness: true,
      });
      const idle = asked.find((row) => row.key === "idle");
      expect(asked).toHaveLength(2);
      expect(idle?.jobs).toEqual({ completed: 0, failed: 0 });
      expect(idle?.busyness).toEqual({
        samples: 1,
        activeSum: 0,
        activeMax: 0,
        concurrency: 3,
        lastAt: minute + 5_000,
      });

      // A runner row with nothing in it — counters and durations all zero —
      // is not a runner with something to report either.
      await engine.client.unsafe(
        `INSERT INTO ${engine.prefix}runner_metrics (ns, entity, interval_ms, bucket)
         VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)})`,
        [ns, "r:empty", MINUTE_BUCKET_MS, minute] as never,
      );
      expect(
        await driver.getRunnerMetricsTotals(ns, { ...range, durations: true }),
      ).toEqual([]);
    }, 60_000);

    it("never answers the roll-up row, which is stored beside the entities", async () => {
      const driver = open();
      const ns = scope("grs-rollup");
      const minute = twoMinutesAgo();

      await driver.countRunnerRun(ns, "r:only", minute + 1_000, { started: 2 });
      await driver.flushMetrics();

      const stored = (await engine.client.unsafe(
        `SELECT entity FROM ${engine.prefix}runner_metrics
          WHERE ns = ${p(1)} AND interval_ms = ${p(2)}`,
        [ns, MINUTE_BUCKET_MS] as never,
      )) as { entity: string }[];
      expect(stored.map((row) => row.entity).sort()).toEqual([
        NAMESPACE_ENTITY,
        "r:only",
      ]);

      const totals = await driver.getRunnerMetricsTotals(ns, oneMinute(minute));
      expect(totals.map((row) => row.runner)).toEqual(["r:only"]);
    }, 60_000);

    it("coerces every summed figure to a number", async () => {
      const driver = open();
      const ns = scope("grs-coerce");
      const q: QueueRef = { ns, queue: "orders" };
      const minute = twoMinutesAgo();

      await driver.countRunnerRun(ns, "r:a", minute + 1_000, {
        succeeded: 1,
        durationMs: 250,
      });
      await driver.countRunnerRun(ns, "r:a", minute + 2_000, {
        succeeded: 1,
        durationMs: 750,
      });
      await driver.countWorkerJobs(q, "w", minute + 1_000, { completed: 3 });
      await driver.sampleWorkerBusyness(q, "w", minute + 1_000, {
        active: 2,
        concurrency: 4,
      });
      await driver.flushMetrics();

      if (adapter === "postgres") {
        // The hazard is real: a SUM over a BIGINT comes back as a string.
        const [raw] = (await engine.client.unsafe(
          `SELECT SUM(dur_sum_ms) AS total FROM ${engine.prefix}runner_metrics
            WHERE ns = ${p(1)} AND entity = ${p(2)}`,
          [ns, "r:a"] as never,
        )) as { total: unknown }[];
        expect(typeof raw?.total).toBe("string");
      }

      const range = oneMinute(minute);
      const [runner] = await driver.getRunnerMetricsTotals(ns, {
        ...range,
        durations: true,
      });
      const [worker] = await driver.getWorkerMetricsTotals(ns, {
        ...range,
        busyness: true,
      });

      const figures = [
        ...Object.values(runner!.runs),
        runner!.durations!.count,
        runner!.durations!.sumMs,
        runner!.durations!.minMs,
        runner!.durations!.maxMs,
        ...runner!.durations!.histogram,
        ...Object.values(worker!.jobs),
        ...Object.values(worker!.busyness!),
      ];
      for (const figure of figures) {
        expect(typeof figure).toBe("number");
      }
      expect(runner!.durations).toMatchObject({
        count: 2,
        sumMs: 1_000,
        minMs: 250,
        maxMs: 750,
      });
      expect(runner!.runs.succeeded).toBe(2);
      expect(worker!.jobs.completed).toBe(3);
    }, 60_000);

    it("splits a worker key holding colons back whole, and filters queues exactly", async () => {
      const driver = open();
      const ns = scope("grs-colon");
      const minute = twoMinutesAgo();
      const count = async (queue: string, key: string, n: number) =>
        await driver.countWorkerJobs({ ns, queue }, key, minute + 1_000, {
          completed: n,
        });

      await count("orders", "host:7:a", 1);
      // `_` is a LIKE wildcard and SQLite's LIKE ignores case: neither
      // neighbour may answer for `or_ers`.
      await count("or_ers", "w", 2);
      await count("orders", "w", 3);
      await count("OR_ERS", "w", 4);
      await driver.flushMetrics();

      const range = oneMinute(minute);
      const all = await driver.getWorkerMetricsTotals(ns, range);
      expect(
        all
          .map(({ queue, key, jobs }) => [queue, key, jobs.completed])
          .sort(
            (a, b) =>
              String(a[0]).localeCompare(String(b[0])) ||
              String(a[1]).localeCompare(String(b[1])),
          ),
      ).toEqual(
        [
          ["OR_ERS", "w", 4],
          ["or_ers", "w", 2],
          ["orders", "host:7:a", 1],
          ["orders", "w", 3],
        ].sort(
          (a, b) =>
            String(a[0]).localeCompare(String(b[0])) ||
            String(a[1]).localeCompare(String(b[1])),
        ),
      );

      const filtered = await driver.getWorkerMetricsTotals(ns, {
        ...range,
        queues: ["or_ers"],
      });
      expect(filtered.map(({ queue, key }) => [queue, key])).toEqual([
        ["or_ers", "w"],
      ]);

      // A filter entry with a colon names no queue, and must not work as a
      // prefix of another queue's keys.
      expect(
        await driver.getWorkerMetricsTotals(ns, {
          ...range,
          queues: ["orders:host"],
        }),
      ).toEqual([]);

      const batch = await driver.getWorkerMetricsMany(
        ns,
        [{ queue: "orders", key: "host:7:a" }],
        range,
      );
      expect(batch.map(({ queue, key }) => [queue, key])).toEqual([
        ["orders", "host:7:a"],
      ]);
    }, 60_000);
  });
}

engineCases("sqlite", async () => {
  const tmp = await makeTmpDir("bun-jobs-sql-grouped");
  cleanups.push(tmp.cleanup);
  const url = `sqlite://${join(tmp.path, "grouped.db")}`;
  const prefix = `grs_${Math.random().toString(36).slice(2, 8)}_`;

  return {
    client: rawClient(url),
    prefix,
    open: (sql) =>
      new SqlDriver({ url, tablePrefix: prefix, ...(sql ? { sql } : {}) }),
  };
});

for (const engine of ENGINES) {
  if (!engine.url) {
    describe.skip(`SQL grouped analytics reads: ${engine.adapter} (set ${engine.variable})`, () => {
      it("is not configured", () => {});
    });
    continue;
  }

  engineCases(engine.adapter, async () => {
    const client = rawClient(engine.url!);
    const prefix = `grs_${engine.adapter}_${Math.random().toString(36).slice(2, 8)}_`;
    for (const table of SQL_TABLES) {
      madeTables.push({ client, table: `${prefix}${table}` });
    }

    return {
      client,
      prefix,
      open: (sql) =>
        new SqlDriver({
          url: engine.url,
          adapter: engine.adapter,
          tablePrefix: prefix,
          notify: false,
          ...(sql ? { sql } : {}),
        }),
    };
  });
}
