import type { QueueRef } from "../lib/drivers/driver";
import type { SqlAdapter } from "../lib/index";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import { SqlDriver } from "../lib/index";
import { makeJob, makeTmpDir, testNamespace } from "./helpers";
import { driverContract } from "./helpers/driverContract";

/**
 * The SQL driver against a real database server.
 *
 * SQLite is covered by `sqlite-driver.test.ts` and needs nothing; Postgres,
 * MySQL and MariaDB need a server, so they run only when their URL is set:
 *
 * ```bash
 * BUN_JOBS_TEST_POSTGRES_URL=postgres://user:pass@localhost/jobs bun test
 * BUN_JOBS_TEST_MYSQL_URL=mysql://user:pass@localhost/jobs bun test
 * BUN_JOBS_TEST_MARIADB_URL=mariadb://user:pass@localhost/jobs bun test
 * ```
 *
 * They run the same contract as every other driver, so "supported" means the
 * same thing for all of them. Each uses a unique namespace and purges it, so
 * a shared server can host several runs at once.
 */

/** The servers this suite can reach, if any. */
const SERVERS: { adapter: SqlAdapter; variable: string; url?: string }[] = [
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

for (const server of SERVERS) {
  if (!server.url) {
    describe.skip(`SQL driver: ${server.adapter} (set ${server.variable})`, () => {
      it("is not configured", () => {});
    });
    continue;
  }

  driverContract(server.adapter, async () => ({
    driver: new SqlDriver({
      url: server.url,
      adapter: server.adapter,
      // A prefix per run, so concurrent suites on one server never share a
      // table — the namespace keeps rows apart, this keeps migrations apart.
      tablePrefix: `bun_jobs_test_`,
    }),
  }));
}

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

/**
 * A claim that skips names costs the same however many skipped jobs sit ahead.
 *
 * The contract suite checks that such a claim gets past them; this checks it
 * does so without its cost growing with the pile. `name NOT IN (…)` alone is a
 * filter the claim index scan walks every skipped row to apply — on Postgres
 * a claim took 0.89ms with nothing skipped, 5.3ms behind 20,000 skipped jobs
 * and 25.7ms behind 100,000 — and a worker repeats that claim every ~100ms
 * while the name stays capped. SQLite runs here too, since it needs no server.
 *
 * The bound is relative, not absolute: the same claim behind a pile a
 * twentieth the size is the yardstick, so a slow or busy machine slows both.
 */
const ENGINES: { adapter: SqlAdapter; url?: string }[] = [
  ...SERVERS.filter((server) => server.url),
  { adapter: "sqlite" },
];

for (const engine of ENGINES) {
  describe(`SQL driver: ${engine.adapter} claims past skipped names`, () => {
    it("keeps a claim's cost flat behind 20,000 skipped jobs", async () => {
      let driver: SqlDriver;
      if (engine.url) {
        driver = new SqlDriver({
          url: engine.url,
          adapter: engine.adapter,
          tablePrefix: "bun_jobs_test_",
        });
      } else {
        const tmp = await makeTmpDir("bun-jobs-sqlite-pile");
        cleanups.push(tmp.cleanup);
        driver = new SqlDriver({
          url: `sqlite://${join(tmp.path, "jobs.db")}`,
        });
      }

      const ns = testNamespace("pile");
      const now = Date.now();

      /** A queue holding `size` waiting jobs of the skipped name. */
      const pile = async (queue: string, size: number): Promise<QueueRef> => {
        const q: QueueRef = { ns, queue };
        for (let start = 0; start < size; start += 2_000) {
          const jobs = Array.from(
            { length: Math.min(2_000, size - start) },
            (_, index) =>
              makeJob({
                id: `${queue}-${start + index}`,
                name: "capped",
                runAt: now,
                createdAt: now + start + index,
              }),
          );
          await driver.addJobs(q, jobs);
        }
        return q;
      };

      const claim = async (q: QueueRef) =>
        await driver.claimJob(q, {
          workerId: "w1",
          token: "pile-token",
          lockMs: 30_000,
          now,
          excludeNames: ["capped"],
        });

      /** The median time of `count` claims that must each find nothing. */
      const medianMiss = async (q: QueueRef, count: number) => {
        const times: number[] = [];
        for (let attempt = 0; attempt < count; attempt++) {
          const started = performance.now();
          expect(await claim(q)).toBeNull();
          times.push(performance.now() - started);
        }
        return times.sort((a, b) => a - b)[count >> 1]!;
      };

      try {
        const small = await pile("small", 1_000);
        const large = await pile("large", 20_000);

        // Warm the connection and the statement cache before timing anything.
        await medianMiss(small, 3);

        // Nine misses on the large pile stay well short of its end, so every
        // one of them is a claim deep inside the skipped jobs.
        const smallCost = await medianMiss(small, 9);
        const largeCost = await medianMiss(large, 9);

        expect(largeCost).toBeLessThan(smallCost * 3);

        // And a job behind the whole pile is still reached.
        await driver.addJob(
          large,
          makeJob({
            id: "behind-20000",
            name: "free",
            runAt: now,
            createdAt: now + 20_000,
          }),
        );

        let found = null;
        for (let attempt = 0; attempt < 25 && !found; attempt++) {
          found = await claim(large);
        }
        expect(found?.id).toBe("behind-20000");
      } finally {
        await driver.purge(ns);
        await driver.close();
      }
    }, 300_000);
  });
}

describe("SQL driver: engine differences", () => {
  it("knows what each engine can do, so the driver need not guess", async () => {
    const { dialectFor } = await import("../lib/index");

    // Claiming: Postgres and MySQL skip locked rows; SQLite has one write
    // lock and nothing to skip.
    expect(dialectFor("postgres").supportsSkipLocked).toBe(true);
    expect(dialectFor("mysql").supportsSkipLocked).toBe(true);
    expect(dialectFor("sqlite").supportsSkipLocked).toBe(false);

    // Reading back a claim: MariaDB cannot return the updated row, so the
    // driver re-selects by the token instead.
    expect(dialectFor("postgres").supportsReturning).toBe(true);
    expect(dialectFor("sqlite").supportsReturning).toBe(true);
    expect(dialectFor("mariadb").supportsReturning).toBe(false);

    // Placeholders: Postgres numbers them, the others do not.
    expect(dialectFor("postgres").placeholder(3)).toBe("$3");
    expect(dialectFor("mysql").placeholder(3)).toBe("?");

    // MySQL cannot read the table it is updating without a derived table.
    expect(dialectFor("mysql").limitedIdSubquery("SELECT id FROM t")).toContain(
      "AS picked",
    );
    expect(dialectFor("postgres").limitedIdSubquery("SELECT id FROM t")).toBe(
      "SELECT id FROM t",
    );

    // JSON and identifier columns differ; MySQL's index limit bounds ids.
    // Postgres stores `json`, not `jsonb`: nothing indexes into the payload
    // columns, so the parse into binary on write would buy nothing.
    expect(dialectFor("postgres").jsonType).toBe("JSON");
    expect(dialectFor("mysql").jsonType).toBe("JSON");
    expect(dialectFor("sqlite").jsonType).toBe("TEXT");

    // Partial indexes, which keep the rows that never run out of the indexes
    // that only ask about the ones that do. MySQL and MariaDB have none, and
    // must produce an empty clause rather than invalid SQL.
    expect(dialectFor("postgres").partialIndex("x IS NOT NULL")).toBe(
      " WHERE x IS NOT NULL",
    );
    expect(dialectFor("sqlite").partialIndex("x IS NOT NULL")).toBe(
      " WHERE x IS NOT NULL",
    );
    expect(dialectFor("mysql").partialIndex("x IS NOT NULL")).toBe("");
    expect(dialectFor("mariadb").partialIndex("x IS NOT NULL")).toBe("");
    expect(dialectFor("mysql").idType).toBe("VARCHAR(191)");
  });

  it("decodes a JSON column however the engine returns it", async () => {
    const { dialectFor } = await import("../lib/index");
    const dialect = dialectFor("postgres");

    // Postgres hands back an object, SQLite a string; both arrive the same.
    expect(dialect.jsonOut<unknown>({ a: 1 }, null)).toEqual({ a: 1 });
    expect(dialect.jsonOut<unknown>('{"a":1}', null)).toEqual({ a: 1 });
    expect(dialect.jsonOut(null, "fallback")).toBe("fallback");
    expect(dialect.jsonOut("not json", "fallback")).toBe("fallback");
  });
});
