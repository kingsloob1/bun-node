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

  it("keeps a job's priority and its options in agreement", async () => {
    const driver = makeDriver();
    const ns = testNamespace();
    const q = { ns, queue: "reprioritised" };

    await driver.addJob(q, makeJob({ id: "moved-up", priority: 5 }));
    const updated = await driver.updateJob(q, "moved-up", { priority: 1 }, 0);

    // `opts` is stored as a JSON string, so the plain field changing is not
    // enough: both have to read back as the new value.
    expect(updated?.priority).toBe(1);
    expect(updated?.opts.priority).toBe(1);
    expect((await driver.getJob(q, "moved-up"))?.opts.priority).toBe(1);

    await driver.purge(ns);
  });

  it("keeps log lines off the job, and sweeps the ones a job left behind", async () => {
    const driver = makeDriver();
    const ns = testNamespace();
    const q = { ns, queue: "log-sweep" };
    const now = Date.now();

    await driver.addJob(q, makeJob({ id: "chatty", runAt: now }));
    await driver.addJobLog(q, "chatty", "one", 0);
    await driver.addJobLog(q, "chatty", "two", 0);

    const token = "sweep-token";
    const claimed = await driver.claimJob(q, {
      workerId: "w1",
      token,
      lockMs: 5_000,
      now,
    });
    // A claim returns the whole document, which is why lines are not on it.
    expect(Object.keys(claimed ?? {})).not.toContain("logs");

    // Retention `true` deletes in one operation and leaves the lines behind.
    await driver.completeJob(q, "chatty", token, null, true, now);

    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(URL!);
    await client.connect();

    try {
      const lines = client
        .db(driver.database)
        .collection(driver.collections.jobLogs);

      expect(await lines.countDocuments({ ns })).toBe(2);

      // The worker's periodic maintenance pass collects them.
      await driver.pruneExpired(q, now, 100);
      expect(await lines.countDocuments({ ns })).toBe(0);
    } finally {
      await client.close();
      await driver.purge(ns);
    }
  });

  it("purges a namespace's log lines with the rest of it", async () => {
    const driver = makeDriver();
    const ns = testNamespace();
    const q = { ns, queue: "log-purge" };

    await driver.addJob(q, makeJob({ id: "logged" }));
    await driver.addJobLog(q, "logged", "kept until purge", 0);
    await driver.purge(ns);

    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(URL!);
    await client.connect();

    try {
      expect(
        await client
          .db(driver.database)
          .collection(driver.collections.jobLogs)
          .countDocuments({ ns }),
      ).toBe(0);
    } finally {
      await client.close();
      await driver.purge(ns);
    }
  });

  it("claims past a large block of excluded jobs in bounded steps", async () => {
    const driver = makeDriver();
    const ns = testNamespace();
    const q = { ns, queue: "exclude-timing" };
    const now = Date.now();
    const pile = 10_000;

    await driver.addJobs(
      q,
      Array.from({ length: pile }, (_u, index) => {
        return makeJob({
          id: `capped-${index}`,
          name: "capped",
          runAt: now,
          createdAt: now + index,
        });
      }),
    );

    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(URL!);
    await client.connect();

    try {
      const jobs = client
        .db(driver.database)
        .collection<{ _id: string }>(driver.collections.jobs);
      const due = {
        ns,
        queue: q.queue,
        state: "waiting",
        runAt: { $lte: now },
      };
      const sort = { priority: 1, createdAt: 1, _id: 1 } as const;

      /** Documents the server examined to answer a claim-shaped read. */
      const examined = async (
        filter: object,
        limit: number,
      ): Promise<number> => {
        const plan = await jobs
          .find(filter)
          .sort(sort)
          .limit(limit)
          .explain("executionStats");
        return Number(plan.executionStats?.totalDocsExamined);
      };

      const claim = async () =>
        await driver.claimJob(q, {
          workerId: "w1",
          token: "timing",
          lockMs: 30_000,
          now,
          excludeNames: ["capped"],
        });

      // Before: a `$nin` in the claim filter walks the whole block, on every
      // retry, while the name stays capped.
      const filterStarted = performance.now();
      await jobs.findOne({ ...due, name: { $nin: ["capped"] } }, { sort });
      const filterMs = performance.now() - filterStarted;
      const filterExamined = await examined(
        { ...due, name: { $nin: ["capped"] } },
        1,
      );

      // After: one claim reads a head window and one continuation window,
      // whatever the size of the block.
      const idleStarted = performance.now();
      expect(await claim()).toBeNull();
      const idleMs = performance.now() - idleStarted;
      const headExamined = await examined(due, 64);
      const continuationExamined = await examined(
        {
          ...due,
          $or: [
            { priority: { $gt: 0 } },
            { priority: 0, createdAt: { $gt: now + 63 } },
            { priority: 0, createdAt: now + 63, _id: { $gt: "" } },
          ],
        },
        1_000,
      );

      // The window bounds the work, not the pile. Explain counts a little
      // more than the limit (the three merged index branches each read ahead,
      // and plan selection's trial work is included), so the bound is the
      // order of magnitude that matters rather than the exact window size.
      expect(filterExamined).toBeGreaterThanOrEqual(pile);
      expect(headExamined).toBeLessThanOrEqual(2 * 64);
      expect(continuationExamined).toBeLessThanOrEqual(2 * 1_000);

      await driver.addJob(
        q,
        makeJob({
          id: "free",
          name: "free",
          runAt: now,
          createdAt: now + pile + 1,
        }),
      );

      // Each claim moves a window further in, so the free job comes out in
      // about pile / 1,000 claims rather than never being reached cheaply.
      const reachStarted = performance.now();
      let found = null;
      let claims = 0;
      while (!found && claims < Math.ceil(pile / 1_000) + 3) {
        claims++;
        found = await claim();
      }
      const reachMs = performance.now() - reachStarted;

      expect(found?.id).toBe("free");
      expect((await driver.countJobs(q)).active).toBe(1);

      process.stdout.write(
        `[mongo exclusions, ${pile} capped] before: ${filterExamined} docs examined, ` +
          `${filterMs.toFixed(1)}ms per claim attempt; after: ${headExamined} + ` +
          `${continuationExamined} docs examined, ${idleMs.toFixed(1)}ms per idle claim, ` +
          `${claims} claims in ${reachMs.toFixed(1)}ms to reach the free job\n`,
      );
    } finally {
      await client.close();
      await driver.purge(ns);
    }
  }, 120_000);

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
      jobLogs: "custom_jobLogs",
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
