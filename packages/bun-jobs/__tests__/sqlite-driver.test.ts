import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { detectAdapter, SqlDriver, toConnectionUrl } from "../lib/index";
import { makeJob, makeTmpDir, testNamespace } from "./helpers";
import { driverContract } from "./helpers/driverContract";

/**
 * The SQL driver on SQLite: the engine that needs no service, so it runs
 * everywhere the suite does. Postgres and MySQL run the same contract when
 * their URLs are set (see `postgres-driver.test.ts`).
 */

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

/** A driver on a fresh database file. */
async function makeDriver(): Promise<SqlDriver> {
  const tmp = await makeTmpDir("bun-jobs-sqlite");
  cleanups.push(tmp.cleanup);
  return new SqlDriver({ url: `sqlite://${join(tmp.path, "jobs.db")}` });
}

driverContract("sqlite", async () => ({ driver: await makeDriver() }));

describe("SQL driver: dialect", () => {
  it("works out the engine from the connection string", () => {
    expect(detectAdapter("postgres://localhost/db")).toBe("postgres");
    expect(detectAdapter("postgresql://localhost/db")).toBe("postgres");
    expect(detectAdapter("mysql://localhost/db")).toBe("mysql");
    expect(detectAdapter("mariadb://localhost/db")).toBe("mariadb");
    expect(detectAdapter("sqlite:///tmp/x.db")).toBe("sqlite");
    expect(detectAdapter("file:/tmp/x.db")).toBe("sqlite");
    expect(detectAdapter(":memory:")).toBe("sqlite");
    expect(detectAdapter("/var/lib/jobs.db")).toBe("sqlite");

    expect(() => detectAdapter("redis://localhost")).toThrow(
      /which SQL engine/,
    );
    expect(() => detectAdapter(undefined)).toThrow(/needs a url/);
  });

  it("describes what SQLite can and cannot do", async () => {
    const driver = await makeDriver();

    expect(driver.adapter).toBe("sqlite");
    // No row locks to skip: SQLite takes one write lock for the database.
    expect(driver.dialect.supportsSkipLocked).toBe(false);
    expect(driver.dialect.supportsReturning).toBe(true);
    expect(driver.capabilities).toMatchObject({
      multiProcess: true,
      multiHost: true,
    });

    await driver.close();
  });
});

describe("SQL driver: connection and naming options", () => {
  it("accepts a connection as fields instead of a URL", async () => {
    const tmp = await makeTmpDir("bun-jobs-sqlite-fields");
    cleanups.push(tmp.cleanup);

    // Fields do not name an engine the way a URL scheme does, so the adapter
    // has to be explicit.
    expect(
      () => new SqlDriver({ connection: { host: "db", database: "jobs" } }),
    ).toThrow(/needs an explicit adapter/);

    const driver = new SqlDriver({
      adapter: "postgres",
      connection: {
        host: "db.internal",
        port: 5433,
        user: "jobs",
        password: "s3cret",
        database: "work",
      },
    });

    expect(driver.adapter).toBe("postgres");
    await driver.close().catch(() => {});
  });

  it("builds the URL a connection object describes", () => {
    expect(
      toConnectionUrl(
        {
          host: "db.internal",
          port: 5433,
          user: "jobs",
          password: "p@ss",
          database: "work",
          params: { sslmode: "require" },
        },
        { scheme: "postgres", host: "127.0.0.1", port: 5432 },
      ),
    ).toBe("postgres://jobs:p%40ss@db.internal:5433/work?sslmode=require");
  });

  it("names its tables, by prefix or outright", async () => {
    const tmp = await makeTmpDir("bun-jobs-sqlite-names");
    cleanups.push(tmp.cleanup);
    const url = `sqlite://${join(tmp.path, "jobs.db")}`;

    const prefixed = new SqlDriver({ url, tablePrefix: "custom_" });
    await prefixed.connect();
    await prefixed.ensureQueue({ ns: "a", queue: "q" });

    const named = new SqlDriver({
      url,
      tables: { jobs: "legacy_work_items" },
    });
    await named.connect();

    const ns = testNamespace();
    const q = { ns, queue: "named" };
    await named.addJob(q, makeJob({ id: "elsewhere" }));

    // The explicit name is used as given, and the default-named driver
    // therefore cannot see the row.
    expect(await named.getJob(q, "elsewhere")).not.toBeNull();

    const defaults = new SqlDriver({ url });
    await defaults.connect();
    expect(await defaults.getJob(q, "elsewhere")).toBeNull();

    await Promise.all([prefixed.close(), named.close(), defaults.close()]);
  });
});

describe("SQL driver: schema", () => {
  it("creates its tables once, and tolerates being asked again", async () => {
    const tmp = await makeTmpDir("bun-jobs-sqlite-schema");
    cleanups.push(tmp.cleanup);
    const url = `sqlite://${join(tmp.path, "jobs.db")}`;

    const first = new SqlDriver({ url });
    await first.connect();
    await first.connect();
    await first.ensureQueue({ ns: "a", queue: "q" });
    await first.close();

    // A second driver over the same file finds the schema already there.
    const second = new SqlDriver({ url });
    await second.connect();
    await second.ensureQueue({ ns: "a", queue: "q" });
    expect(await second.ping()).toBe(true);
    await second.close();
  });

  it("keeps rows of different namespaces apart in one table", async () => {
    const driver = await makeDriver();
    const first = testNamespace("alpha");
    const second = testNamespace("beta");

    // Same queue name, same job id, one table.
    await driver.addJob(
      { ns: first, queue: "q" },
      makeJob({ id: "same", name: "mine" }),
    );
    await driver.addJob(
      { ns: second, queue: "q" },
      makeJob({ id: "same", name: "theirs" }),
    );

    expect((await driver.getJob({ ns: first, queue: "q" }, "same"))?.name).toBe(
      "mine",
    );
    expect(
      (await driver.getJob({ ns: second, queue: "q" }, "same"))?.name,
    ).toBe("theirs");

    await driver.purge(first);
    expect(await driver.getJob({ ns: first, queue: "q" }, "same")).toBeNull();
    expect(
      await driver.getJob({ ns: second, queue: "q" }, "same"),
    ).not.toBeNull();

    await driver.close();
  });

  it("round-trips a job's JSON columns", async () => {
    const driver = await makeDriver();
    const ns = testNamespace();
    const q = { ns, queue: "json" };

    const data = { nested: { list: [1, 2, 3], flag: true }, text: "hello" };
    await driver.addJob(q, makeJob({ id: "shapes", data }));

    const stored = await driver.getJob(q, "shapes");
    expect(stored?.data).toEqual(data);
    expect(stored?.opts).toMatchObject({ priority: 0, attempts: 1 });
    expect(stored?.stacktrace).toEqual([]);
    expect(stored?.failedReason).toBeNull();

    await driver.close();
  });
});

describe("SQL driver: several connections to one SQLite file", () => {
  /**
   * Two drivers on one file must not wedge each other.
   *
   * SQLite's own answer to contention is `busy_timeout`, and on a
   * single-threaded runtime it is a trap: the busy handler sleeps in the
   * calling thread, which is the same thread that has to run the *other*
   * connection's COMMIT. A generous timeout therefore does not make the wait
   * shorter, it makes it exactly as long as the timeout. The driver keeps that
   * value tiny and does the waiting in JavaScript instead, where yielding lets
   * the holder finish.
   *
   * Left unfixed this was not a slow test, it was an infinite one: three
   * workers on one file processed nothing at all.
   */
  it("lets a second driver write while a first is mid-transaction", async () => {
    const tmp = await makeTmpDir("bun-jobs-sqlite-contended");
    cleanups.push(tmp.cleanup);

    const url = `sqlite://${join(tmp.path, "shared.db")}`;
    const a = new SqlDriver({ url });
    const b = new SqlDriver({ url });
    const ns = testNamespace();
    const q = { ns, queue: "contended" };

    await a.ensureQueue(q);
    await b.ensureQueue(q);

    await a.addJob(q, makeJob({ id: "shared" }));

    // Whichever of the two gets it, the other must come back promptly with
    // `null` rather than sitting on the file's write lock.
    const started = Date.now();
    const [first, second] = await Promise.all([
      a.claimJob(q, {
        workerId: "a",
        token: "ta",
        lockMs: 5000,
        now: Date.now(),
      }),
      b.claimJob(q, {
        workerId: "b",
        token: "tb",
        lockMs: 5000,
        now: Date.now(),
      }),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2000);

    await a.close();
    await b.close();
  });

  it("drains a queue with three drivers competing on one file", async () => {
    const tmp = await makeTmpDir("bun-jobs-sqlite-drain");
    cleanups.push(tmp.cleanup);

    const url = `sqlite://${join(tmp.path, "drain.db")}`;
    const drivers = [
      new SqlDriver({ url }),
      new SqlDriver({ url }),
      new SqlDriver({ url }),
    ];
    const ns = testNamespace();
    const q = { ns, queue: "drain" };

    await drivers[0]!.ensureQueue(q);
    const seeded = [];
    for (let index = 0; index < 30; index++) {
      seeded.push(makeJob({ id: `j${index}` }));
    }
    await drivers[0]!.addJobs(q, seeded);

    // Every driver claims and completes until nothing is left. A job claimed
    // twice or lost would show up in the tally.
    const claimed: string[] = [];
    await Promise.all(
      drivers.map(async (driver, index) => {
        for (;;) {
          const now = Date.now();
          const job = await driver.claimJob(q, {
            workerId: `w${index}`,
            token: `t${index}`,
            lockMs: 5000,
            now,
          });
          if (!job) return;
          claimed.push(job.id);
          await driver.completeJob(q, job.id, `t${index}`, null, true, now);
        }
      }),
    );

    expect(claimed).toHaveLength(30);
    expect(new Set(claimed).size).toBe(30);

    await Promise.all(drivers.map((driver) => driver.close()));
  });
});
