import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { detectAdapter, SqlDriver } from "../lib/index";
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
