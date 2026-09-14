import type { JobsDriver } from "../lib/index";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import { ConfigError, MongoDriver, toConnectionUrl } from "../lib/index";
import { makeJob, testNamespace } from "./helpers";
import { driverContract } from "./helpers/driverContract";

/**
 * The MongoDB driver.
 *
 * It runs the same contract as every other driver, so "supported" means the
 * same thing here as it does for SQL or Redis. A server is needed:
 *
 * ```bash
 * bun scripts/setup-databases.ts --docker --only=mongodb
 * BUN_JOBS_TEST_MONGODB_URL=mongodb://127.0.0.1:27017/bun_jobs_test bun test
 * ```
 *
 * Without that URL the suite skips, visibly.
 */

/** The server to test against, when one is configured. */
const URL = process.env.BUN_JOBS_TEST_MONGODB_URL;

/** Drivers to close when the suite ends. */
const drivers: JobsDriver[] = [];

afterAll(async () => {
  await Promise.allSettled(drivers.map((driver) => driver.close()));
});

/** A driver on the configured server, tracked for cleanup. */
function makeDriver(options: { collectionPrefix?: string } = {}): MongoDriver {
  const driver = new MongoDriver({ url: URL, ...options });
  drivers.push(driver);
  return driver;
}

if (URL) {
  driverContract("mongodb", async () => ({ driver: makeDriver() }));
} else {
  describe.skip("driver contract: mongodb (set BUN_JOBS_TEST_MONGODB_URL)", () => {
    it("is not configured", () => {});
  });
}

describe.skipIf(!URL)("MongoDB driver: storage", () => {
  it("keeps a payload byte-for-byte, whatever its keys", async () => {
    const driver = makeDriver();
    const ns = testNamespace();
    const q = { ns, queue: "shapes" };

    // BSON forbids "." and "$" in field names, and a job's data belongs to
    // the caller — so payloads are stored as JSON rather than as documents.
    const data = {
      "dotted.key": 1,
      $dollar: 2,
      nested: { "a.b": [1, { $c: true }] },
      unicode: "héllo",
      empty: null,
    };

    await driver.addJob(q, makeJob({ id: "awkward", data }));
    expect((await driver.getJob(q, "awkward"))?.data).toEqual(data);
  });

  it("gives one job to exactly one claimer, however many ask at once", async () => {
    const driver = makeDriver();
    const ns = testNamespace();
    const q = { ns, queue: "contested" };
    const now = Date.now();

    await driver.addJob(q, makeJob({ id: "only-one", runAt: now }));

    const claim = (index: number) =>
      driver.claimJob(q, {
        workerId: `w${index}`,
        token: `t${index}`,
        lockMs: 5000,
        now,
      });

    // Ten simultaneous claims: the server decides, and only one can win.
    const claims = await Promise.all(
      Array.from({ length: 10 }, (_u, i) => claim(i)),
    );

    const winners = claims.filter((job) => job !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.id).toBe("only-one");
    expect(winners[0]?.attemptsMade).toBe(1);
  });

  it("gives one lock to exactly one holder", async () => {
    const driver = makeDriver();
    const ns = testNamespace();
    const now = Date.now();

    const acquire = (index: number) =>
      driver.acquireLock(ns, "r:contested", `token-${index}`, 5000, now);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_u, i) => acquire(i)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("bounds queued triggers without a read-modify-write race", async () => {
    const driver = makeDriver();
    const ns = testNamespace();
    const key = "r:bounded";

    const push = (index: number) =>
      driver.pushQueuedTrigger(
        ns,
        key,
        {
          id: `t${index}`,
          source: "manual",
          requestedAt: Date.now(),
          requestedBy: "test",
        },
        3,
      );

    // The bound is part of the update's filter, so ten concurrent pushes
    // cannot all find room for themselves.
    const pushes = await Promise.all(
      Array.from({ length: 10 }, (_u, i) => push(i)),
    );

    expect(pushes.filter(Boolean).length).toBeLessThanOrEqual(3);
    expect(await driver.countQueuedTriggers(ns, key)).toBeLessThanOrEqual(3);
  });

  it("trims history on the server, newest first", async () => {
    const driver = makeDriver();
    const ns = testNamespace();
    const key = "r:history";

    for (let i = 0; i < 6; i++) {
      await driver.appendHistory(
        ns,
        key,
        {
          runId: `run-${i}`,
          runnerId: "history",
          attempt: 1,
          source: "manual",
          mode: "in-process",
          host: "test",
          startedAt: i,
          status: "running",
        },
        3,
      );
    }

    const history = await driver.listHistory(ns, key);
    expect(history.map((entry) => entry.runId)).toEqual([
      "run-5",
      "run-4",
      "run-3",
    ]);
  });
});

describe.skipIf(!URL)("MongoDB driver: options", () => {
  it("names its collections, by prefix or outright", async () => {
    const prefixed = makeDriver({ collectionPrefix: "custom_" });
    expect(prefixed.collections).toEqual({
      jobs: "custom_jobs",
      locks: "custom_locks",
      kv: "custom_kv",
      events: "custom_events",
    });

    const named = new MongoDriver({
      url: URL,
      collections: { jobs: "legacy_work_items" },
    });
    drivers.push(named);

    // An explicit name is used as given, prefix and all.
    expect(named.collections.jobs).toBe("legacy_work_items");
    expect(named.collections.locks).toBe("bun_jobs_locks");
  });

  it("actually uses the collections it was told to", async () => {
    const driver = makeDriver({ collectionPrefix: "renamed_" });
    const ns = testNamespace();
    const q = { ns, queue: "named" };

    await driver.addJob(q, makeJob({ id: "somewhere-else" }));

    // Read it back through a driver pointed at the same names, and confirm a
    // driver on the default names cannot see it.
    const same = makeDriver({ collectionPrefix: "renamed_" });
    expect(await same.getJob(q, "somewhere-else")).not.toBeNull();

    const other = makeDriver();
    expect(await other.getJob(q, "somewhere-else")).toBeNull();

    await driver.purge(ns);
  });

  it("takes the database from the URL, or from the option", () => {
    const fromUrl = new MongoDriver({
      url: "mongodb://127.0.0.1:27017/from_the_url",
    });
    expect(fromUrl.database).toBe("from_the_url");

    const explicit = new MongoDriver({
      url: "mongodb://127.0.0.1:27017/from_the_url",
      database: "from_the_option",
    });
    expect(explicit.database).toBe("from_the_option");

    const neither = new MongoDriver({ url: "mongodb://127.0.0.1:27017" });
    expect(neither.database).toBe("bun_jobs");
  });
});

describe("MongoDB driver: connection options", () => {
  it("accepts a connection as fields instead of a URL", () => {
    const driver = new MongoDriver({
      connection: {
        host: "db.internal",
        port: 27018,
        user: "jobs",
        password: "s3cret",
        database: "work",
        params: { authSource: "admin", replicaSet: "rs0" },
      },
    });

    expect(driver.database).toBe("work");
  });

  it("builds the URL a connection object describes", () => {
    expect(
      toConnectionUrl(
        {
          host: "db.internal",
          port: 27018,
          user: "jobs",
          password: "p@ss word",
          database: "work",
          params: { authSource: "admin" },
        },
        { scheme: "mongodb", host: "127.0.0.1", port: 27017 },
      ),
    ).toBe(
      "mongodb://jobs:p%40ss%20word@db.internal:27018/work?authSource=admin",
    );
  });

  it("supports several hosts, for a replica set", () => {
    expect(
      toConnectionUrl(
        {
          host: "a.internal",
          hosts: [{ host: "b.internal" }, { host: "c.internal", port: 27020 }],
          database: "work",
          params: { replicaSet: "rs0" },
        },
        { scheme: "mongodb", port: 27017 },
      ),
    ).toBe(
      "mongodb://a.internal:27017,b.internal:27017,c.internal:27020/work?replicaSet=rs0",
    );
  });

  it("refuses a driver with neither a URL nor fields", () => {
    expect(() => new MongoDriver({})).toThrow(ConfigError);
    expect(() => new MongoDriver({})).toThrow(/url or a connection object/);
  });
});
