import type { QueueRef } from "../lib/drivers/driver";
import type { SqlAdapter } from "../lib/index";
import { join } from "node:path";
import process from "node:process";
import { SQL } from "bun";
import { afterAll, describe, expect, it } from "bun:test";
import { queueStateListStatement } from "../lib/drivers/sql/sql-driver";
import {
  BunQueue,
  BunQueueWorker,
  ConfigError,
  createDriver,
  dialectFor,
  SqlDriver,
} from "../lib/index";
import { takeBooleanParam } from "../lib/shared/connection";
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

/** Clients opened for the servers, closed when the suite ends. */
const clients: SQL[] = [];

/**
 * A client for queries the driver has no API for — seeding rows, `EXPLAIN`.
 *
 * Built from the same URL the drivers get, honouring the same
 * `allowPublicKeyRetrieval` parameter: Bun's client ignores it in a URL, and
 * MySQL 8.4 over a connection without TLS needs it. Closed in `afterAll`.
 */
function rawClient(url: string): SQL {
  const { url: bare, value } = takeBooleanParam(url, "allowPublicKeyRetrieval");
  const client = new SQL({
    url: bare,
    ...(value === undefined ? {} : { allowPublicKeyRetrieval: value }),
  });
  clients.push(client);
  return client;
}

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
  await Promise.allSettled(clients.map((client) => client.close()));
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

      /** How long one claim takes, asserting it finds nothing. */
      const timedMiss = async (q: QueueRef) => {
        const started = performance.now();
        expect(await claim(q)).toBeNull();
        return performance.now() - started;
      };

      /**
       * The least time a set of claims took. Load from anything else on the
       * machine only ever adds time, so the minimum is the best estimate of
       * what the claim itself costs; a median still moves with a burst that
       * covers half the samples.
       */
      const least = (times: number[]) => Math.min(...times);

      try {
        // Both piles are larger than any window a claim reads, so a bounded
        // claim does the same work on each and the costs should match. A 1,000
        // job pile was the comparison once, and it is not like for like: one
        // window covers it whole, so it is cheaper by design and the ratio sat
        // at the bound. An unbounded claim scans in proportion to the pile, and
        // five times the jobs is five times the cost — that is what fails here.
        const small = await pile("small", 4_000);
        const large = await pile("large", 20_000);

        // Warm the connection and the statement cache before timing anything.
        for (let warm = 0; warm < 3; warm++) {
          await timedMiss(small);
        }

        // Interleaved, not one batch after the other. The two costs are
        // sub-millisecond, and a burst of load from anything else on the
        // machine — the rest of the suite, typically — landing during one
        // batch skewed the ratio past the bound with nothing wrong. Taking the
        // pairs alternately puts any such burst on both sides at once.
        //
        // Each large miss moves the cursor on by a bounded window, so however
        // far the pairs walk into the pile, every claim is still a claim deep
        // inside skipped jobs.
        const smallTimes: number[] = [];
        const largeTimes: number[] = [];
        for (let pair = 0; pair < 25; pair++) {
          smallTimes.push(await timedMiss(small));
          largeTimes.push(await timedMiss(large));
        }

        const smallCost = least(smallTimes);
        const largeCost = least(largeTimes);

        // Equal work should cost about the same; an unbounded scan over five
        // times the jobs costs about five times as much.
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

/**
 * Queue state is listed in code-point order on every engine, whatever the
 * column's collation says.
 *
 * The contract test's names are all lower case, so it passes under a
 * case-insensitive collation too. These are the names that give it away:
 * MariaDB's default `utf8mb4_uca1400_ai_ci` puts `a` before `B` and `[` before
 * `Z` — the latter also empties a range ending at the successor of `Z` — and
 * a Postgres locale collation can reorder punctuation. Every name here is
 * distinct even case-insensitively, since the `kv` primary key is compared
 * in the column's collation.
 */
for (const engine of ENGINES) {
  describe(`SQL driver: ${engine.adapter} lists queue state`, () => {
    it("in code-point order, whatever the collation", async () => {
      let driver: SqlDriver;
      if (engine.url) {
        driver = new SqlDriver({
          url: engine.url,
          adapter: engine.adapter,
          tablePrefix: "bun_jobs_test_",
        });
      } else {
        const tmp = await makeTmpDir("bun-jobs-sqlite-state");
        cleanups.push(tmp.cleanup);
        driver = new SqlDriver({
          url: `sqlite://${join(tmp.path, "jobs.db")}`,
        });
      }

      const ns = testNamespace("state-order");
      const q: QueueRef = { ns, queue: "state-order" };
      const names = ["a", "B", "Zeta", "Zz", "[x", "_", "%", "b1", "Z%"];

      try {
        for (const name of names) {
          expect(await driver.setQueueState(q, name, {}, null)).toBe(1);
        }

        const sorted = [...names].sort();
        expect(
          await driver.listQueueState(q, { prefix: "", limit: 50 }),
        ).toEqual(sorted);
        expect(
          await driver.listQueueState(q, { prefix: "Z", limit: 50 }),
        ).toEqual(["Z%", "Zeta", "Zz"]);
        expect(
          await driver.listQueueState(q, { prefix: "Z%", limit: 50 }),
        ).toEqual(["Z%"]);

        // Paging by `after` visits every name once, in the same order.
        const paged: string[] = [];
        let after: string | undefined;
        for (;;) {
          const page = await driver.listQueueState(q, {
            prefix: "",
            after,
            limit: 2,
          });
          if (page.length === 0) {
            break;
          }
          paged.push(...page);
          after = page.at(-1);
        }
        expect(paged).toEqual(sorted);
      } finally {
        await driver.purge(ns);
        await driver.close();
      }
    });
  });
}

/**
 * `listQueueState` is an index range on every engine, not a scan of the
 * namespace.
 *
 * The statement is the driver's own, from the same builder `listQueueState`
 * calls, so the plan checked is the plan run. Enough rows are seeded, in this
 * namespace and a neighbouring one, that a planner has a reason to prefer the
 * index; a sort in the plan means the order came from somewhere other than an
 * index, which is the other half of what is being checked.
 *
 * - Postgres must use `ix_…_kv_order`, `(ns, kv_key COLLATE "C")`: its primary
 *   key is in the database's locale and cannot bound a `COLLATE "C"` range.
 * - MariaDB and MySQL must range-scan the primary key, which `kv_key`'s binary
 *   collation makes code-point ordered.
 * - SQLite must search its primary-key index, `BINARY` by default.
 */
for (const engine of ENGINES) {
  describe(`SQL driver: ${engine.adapter} plans listQueueState`, () => {
    it("as an index range, with no sort", async () => {
      let driver: SqlDriver;
      let url: string;
      const prefix = "bun_jobs_test_";
      if (engine.url) {
        url = engine.url;
        driver = new SqlDriver({
          url,
          adapter: engine.adapter,
          tablePrefix: prefix,
        });
      } else {
        const tmp = await makeTmpDir("bun-jobs-sqlite-plan");
        cleanups.push(tmp.cleanup);
        url = join(tmp.path, "jobs.db");
        driver = new SqlDriver({ url: `sqlite://${url}`, tablePrefix: prefix });
      }
      await driver.connect();

      const dialect = dialectFor(engine.adapter);
      const raw =
        engine.adapter === "sqlite"
          ? new SQL(`sqlite://${url}`)
          : rawClient(url);
      const kv = `${prefix}kv`;
      const ns = testNamespace("plan");
      const neighbour = testNamespace("plan-other");
      const base = "q:plan:state:";

      try {
        // Literal rows, a batch at a time: the values are generated here and
        // plain ASCII, and binding 4 parameters for each of 12,000 rows would
        // exceed what some engines accept in one statement.
        for (const target of [ns, neighbour]) {
          for (let start = 0; start < 6_000; start += 1_000) {
            const rows = Array.from(
              { length: 1_000 },
              (_, index) =>
                `('${target}', '${base}name-${start + index}', '{}', 0)`,
            );
            await raw.unsafe(
              `INSERT INTO ${kv} (ns, kv_key, value, updated_at) VALUES ${rows.join(", ")}`,
            );
          }
        }
        await raw.unsafe(dialect.analyze(kv) ?? "SELECT 1");

        const values: unknown[] = [];
        const bind = (value: unknown) => {
          values.push(value);
          return dialect.placeholder(values.length);
        };
        const statement = queueStateListStatement(dialect, kv, bind, {
          ns,
          base,
          prefix: "name-1",
          after: "name-10",
          limit: 20,
        });

        let plan: string;
        switch (engine.adapter) {
          case "postgres": {
            const rows = (await raw.unsafe(`EXPLAIN ${statement}`, values)) as {
              "QUERY PLAN": string;
            }[];
            plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
            expect(plan).toMatch(
              new RegExp(`Index (Only )?Scan using ix_${prefix}jobs_kv_order`),
            );
            expect(plan).toMatch(/Index Cond:.*kv_key/);
            break;
          }
          case "sqlite": {
            const rows = (await raw.unsafe(
              `EXPLAIN QUERY PLAN ${statement}`,
              values,
            )) as { detail: string }[];
            plan = rows.map((row) => row.detail).join("\n");
            expect(plan).toMatch(
              /USING (COVERING )?INDEX sqlite_autoindex_\w+_kv_1 \(ns=\? AND kv_key>\? AND kv_key<\?\)/,
            );
            break;
          }
          default: {
            // The tabular form: MySQL and MariaDB shape their JSON plans
            // differently (MySQL nests the table under `ordering_operation`,
            // MariaDB under `nested_loop`), but agree on these columns.
            const [row] = (await raw.unsafe(
              `EXPLAIN ${statement}`,
              values,
            )) as { type: string; key: string; Extra: string | null }[];
            plan = JSON.stringify(row);
            expect(row!.key).toBe("PRIMARY");
            expect(row!.type).toBe("range");
          }
        }
        expect(plan).not.toMatch(/\bSort\b|filesort|TEMP B-TREE/i);

        // And the range answers what the contract expects of it.
        expect(
          await driver.listQueueState(
            { ns, queue: "plan" },
            { prefix: "name-1", after: "name-10", limit: 3 },
          ),
        ).toEqual(["name-100", "name-1000", "name-1001"]);
      } finally {
        await raw.unsafe(
          `DELETE FROM ${kv} WHERE ns IN ('${ns}', '${neighbour}')`,
        );
        await raw.close();
        await driver.close();
      }
    }, 120_000);
  });
}

/**
 * Several workers claiming, completing, failing and promoting on one queue
 * keep every job moving.
 *
 * On InnoDB they collide: the promote sweep's `id IN (SELECT … LIMIT)` takes
 * shared next-key locks under REPEATABLE READ and deadlocks against claims
 * (1213), and MariaDB 11.8's `innodb_snapshot_isolation` refuses a claim that
 * reads a row changed since its snapshot (1020). Both are "try again". The
 * driver's transaction retry is meant to take them, but the error arrives
 * wrapped in a `DriverError` whose own message says nothing of the engine's,
 * so it was never recognised: each one escaped to the worker instead. There a
 * failed completion leaves the job `active` until the stalled sweep, 30s plus
 * later, and a failed claim leaks the per-name capacity it had reserved, which
 * caps that name until the worker closes. Either way the queue stalls with
 * nothing in the log unless someone listens for `error`.
 *
 * Every ingredient is here on purpose: separate drivers (so separate
 * connection pools, like separate processes), concurrency above one, a
 * per-name limit, jobs that fail their first attempt and back off briefly, and
 * delayed jobs, so the promote sweep contends with claims.
 */
for (const engine of ENGINES) {
  describe(`SQL driver: ${engine.adapter} under contending workers`, () => {
    it("settles every job exactly once, well inside the lock duration", async () => {
      /** Workers on the queue, each on its own driver and connection pool. */
      const WORKERS = 4;
      /** Jobs added. */
      const JOBS = 120;
      /** The lock a claim takes; a stranded job is invisible for this long. */
      const LOCK_MS = 30_000;
      /** How long every job has to settle: a third of the lock. */
      const SETTLE_MS = 10_000;

      let url: string;
      if (engine.url) {
        url = engine.url;
      } else {
        const tmp = await makeTmpDir("bun-jobs-sqlite-contention");
        cleanups.push(tmp.cleanup);
        url = `sqlite://${join(tmp.path, "jobs.db")}`;
      }

      /** A driver of its own, so each worker contends as another process would. */
      const openDriver = () =>
        new SqlDriver({
          url,
          ...(engine.url
            ? { adapter: engine.adapter, tablePrefix: "bun_jobs_test_" }
            : {}),
        });

      const namespace = testNamespace("contend");
      const queueName = "contended";
      const producerDriver = openDriver();
      const queue = new BunQueue<{ index: number }>(queueName, {
        namespace,
        driver: producerDriver,
      });

      /** The attempts that ran, by job index, in the order they started. */
      const attempts = new Map<number, number[]>();
      /** How many times a job was reported completed, by job index. */
      const completions = new Map<number, number>();
      /** Everything the workers reported through `error`, with its causes. */
      const errors: string[] = [];

      /** An error and each `cause` beneath it, since the driver wraps them. */
      const describeChain = (error: unknown): string => {
        const parts: string[] = [];
        for (let at = error, depth = 0; at != null && depth < 5; depth++) {
          const { message, errno } = at as {
            message?: unknown;
            errno?: unknown;
          };
          parts.push(
            `${String(message)}${errno === undefined ? "" : ` (${String(errno)})`}`,
          );
          at = (at as { cause?: unknown }).cause;
        }
        return parts.join(" <- ");
      };

      const drivers: SqlDriver[] = [];
      const workers: BunQueueWorker<{ index: number }>[] = [];

      try {
        // A per-name cap, so a claim that fails after reserving capacity shows
        // up as a stall rather than passing unnoticed.
        await queue.setLimits({ names: { capped: { concurrency: 2 } } });

        for (let worker = 0; worker < WORKERS; worker++) {
          const driver = openDriver();
          drivers.push(driver);

          const consumer = new BunQueueWorker<{ index: number }>(
            queueName,
            async (job, context) => {
              const { index } = job.data;
              attempts.set(index, [
                ...(attempts.get(index) ?? []),
                context.attempt,
              ]);

              // Every fourth job fails its first attempt, so it is written back
              // as failed, backs off, and has to be promoted again.
              if (index % 4 === 0 && context.attempt === 1) {
                throw new Error(`first attempt of ${index} fails`);
              }

              await Bun.sleep(1 + (index % 3));
              return index;
            },
            {
              namespace,
              driver,
              concurrency: 6,
              pollInterval: 5,
              lockDuration: LOCK_MS,
              autorun: true,
            },
          );

          consumer.on("completed", (job) => {
            const { index } = job.data;
            completions.set(index, (completions.get(index) ?? 0) + 1);
          });
          consumer.on("error", (error, context) => {
            errors.push(`${context}: ${describeChain(error)}`);
          });

          workers.push(consumer);
        }

        for (let index = 0; index < JOBS; index++) {
          await queue.add(
            index % 3 === 0 ? "capped" : "plain",
            { index },
            {
              attempts: 3,
              backoff: 20,
              // Every fifth is delayed, so the promote sweep has work alongside
              // the retries.
              ...(index % 5 === 0 ? { delay: 30 } : {}),
            },
          );
        }

        const deadline = Date.now() + SETTLE_MS;
        while (completions.size < JOBS && Date.now() < deadline) {
          await Bun.sleep(25);
        }

        // Diagnostics first: when the queue stalls, this says why.
        expect(errors).toEqual([]);
        expect(completions.size).toBe(JOBS);

        // Exactly once: one completion per job, and no attempt ran twice.
        for (let index = 0; index < JOBS; index++) {
          expect(completions.get(index)).toBe(1);
          const ran = attempts.get(index) ?? [];
          expect(ran).toEqual(index % 4 === 0 ? [1, 2] : [1]);
        }

        const counts = await queue.count();
        expect(counts.completed).toBe(JOBS);
        expect(counts.active).toBe(0);
      } finally {
        await Promise.allSettled(
          workers.map(async (worker) => await worker.close()),
        );
        await producerDriver.purge(namespace).catch(() => {});
        await queue.close();
        await Promise.allSettled(
          drivers.map(async (driver) => await driver.close()),
        );
        await producerDriver.close();
      }
    }, 60_000);
  });
}

/** The MySQL server's URL, when one is configured. */
const MYSQL = process.env.BUN_JOBS_TEST_MYSQL_URL;

describe("SQL driver: allowPublicKeyRetrieval in a connection URL", () => {
  it("is taken out of the URL, with every other parameter left as written", () => {
    const url = "mysql://u:p%40ss@db:3306/jobs";
    expect(
      takeBooleanParam(
        `${url}?allowPublicKeyRetrieval=true`,
        "allowPublicKeyRetrieval",
      ),
    ).toEqual({ url, value: true });
    expect(
      takeBooleanParam(
        `${url}?allowPublicKeyRetrieval=false`,
        "allowPublicKeyRetrieval",
      ),
    ).toEqual({ url, value: false });
    expect(
      takeBooleanParam(
        `${url}?sslmode=require&allowPublicKeyRetrieval=1&ssl=true`,
        "allowPublicKeyRetrieval",
      ),
    ).toEqual({ url: `${url}?sslmode=require&ssl=true`, value: true });
    expect(
      takeBooleanParam(`${url}?sslmode=disable`, "allowPublicKeyRetrieval"),
    ).toEqual({ url: `${url}?sslmode=disable`, value: undefined });
    expect(takeBooleanParam(url, "allowPublicKeyRetrieval")).toEqual({
      url,
      value: undefined,
    });
    expect(() =>
      takeBooleanParam(
        `${url}?allowPublicKeyRetrieval=maybe`,
        "allowPublicKeyRetrieval",
      ),
    ).toThrow(ConfigError);
  });
});

describe.skipIf(!MYSQL)("SQL driver: mysql authentication without TLS", () => {
  /** The configured URL without the parameter, and its parts as fields. */
  const bare = MYSQL
    ? takeBooleanParam(MYSQL, "allowPublicKeyRetrieval").url
    : "";

  it("connects from the URL alone when it carries the parameter", async () => {
    const driver = new SqlDriver({
      url: `${bare}${bare.includes("?") ? "&" : "?"}allowPublicKeyRetrieval=true`,
      tablePrefix: "bun_jobs_test_",
    });
    try {
      await driver.connect();
      expect(await driver.ping()).toBe(true);
    } finally {
      await driver.close();
    }
  });

  it("says what to change when the URL lacks it, rather than failing opaquely", async () => {
    const driver = new SqlDriver({ url: bare, tablePrefix: "bun_jobs_test_" });
    try {
      const failure = await driver.connect().then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ConfigError);
      const message = String((failure as Error).message);
      expect(message).toContain("?allowPublicKeyRetrieval=true");
      expect(message).toMatch(/TLS/);
    } finally {
      await driver.close();
    }
  });

  it("takes the option in the connection form, through a config that crossed JSON", async () => {
    const parsed = new URL(bare);
    // What a spawned child receives: the config serialised and parsed again.
    const config = JSON.parse(
      JSON.stringify({
        type: "sql",
        adapter: "mysql",
        tablePrefix: "bun_jobs_test_",
        connection: {
          host: parsed.hostname,
          port: Number(parsed.port),
          user: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password),
          database: parsed.pathname.slice(1),
          allowPublicKeyRetrieval: true,
        },
      }),
    );
    expect(config.connection.allowPublicKeyRetrieval).toBe(true);

    const driver = createDriver(config);
    try {
      await driver.connect();
      expect(await driver.ping()).toBe(true);
    } finally {
      await driver.close();
    }
  });
});

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
    // Identifiers compare exactly on MySQL and MariaDB too: binary, `NO PAD`
    // collations, named on the column rather than left to a case-insensitive
    // server default.
    expect(dialectFor("mysql").idType).toBe(
      "VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
    );
    expect(dialectFor("mariadb").idType).toBe(
      "VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin",
    );
    expect(dialectFor("mariadb").nameType).toContain("utf8mb4_nopad_bin");
    // Postgres orders code points through a collated index, not the column.
    expect(dialectFor("postgres").codePointCollation).toBe('"C"');
    expect(dialectFor("sqlite").codePointCollation).toBeNull();
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
