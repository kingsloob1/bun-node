import type { DriverConfig, QueueRef } from "../lib/index";
import { afterAll, describe, expect, it } from "bun:test";
import {
  createDriver,
  FileDriver,
  MemoryDriver,
  MongoDriver,
  RedisDriver,
  SqlDriver,
} from "../lib/index";
import { makeTmpDir, testNamespace } from "./helpers";

/**
 * `createDriver` and {@link DriverConfig}: the JSON-safe description of a
 * backend.
 *
 * This matters beyond convenience. A driver *instance* cannot cross a process
 * boundary, so a spawned runner receives a config and rebuilds the driver on
 * the other side — which means an option missing from the config is an option
 * a spawned runner silently cannot have. Every tuning option here is therefore
 * checked through the config, not through the constructor.
 *
 * Live objects — Redis `client`, SQL `sql`, Mongo `client` — deliberately stay
 * constructor-only, because they cannot be serialised at all.
 */

const cleanups: (() => Promise<unknown>)[] = [];

afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup().catch(() => undefined);
  }
});

/** A config, and the same config after a trip through JSON. */
function roundTrip(config: DriverConfig): DriverConfig {
  return JSON.parse(JSON.stringify(config)) as DriverConfig;
}

describe("createDriver: the config surface", () => {
  it("survives JSON unchanged, which is what a spawned runner receives", async () => {
    const tmp = await makeTmpDir("config");
    cleanups.push(tmp.cleanup);

    const configs: DriverConfig[] = [
      { type: "memory" },
      { type: "file", root: tmp.path, pollInterval: 10, eventRetentionMs: 0 },
      {
        type: "redis",
        url: "redis://127.0.0.1:6379/15",
        keyPrefix: "cfg",
        maxBlockSeconds: 0.25,
        firstConnectTimeout: 2_000,
        connectionTimeout: 5_000,
        maxRetries: 5,
        autoReconnect: true,
      },
      {
        type: "sql",
        url: "sqlite://:memory:",
        tables: { events: "legacy_events" },
        pollInterval: 15,
        eventRetentionMs: 60_000,
      },
      {
        type: "mongodb",
        url: "mongodb://127.0.0.1:27017/x",
        clientOptions: { maxPoolSize: 5 },
        pollInterval: 15,
        eventRetentionMs: 60_000,
      },
    ];

    for (const config of configs) {
      expect(roundTrip(config)).toEqual(config);
    }
  });

  it("builds each backend, and forwards what it was given", async () => {
    const tmp = await makeTmpDir("config");
    cleanups.push(tmp.cleanup);

    expect(createDriver({ type: "memory" })).toBeInstanceOf(MemoryDriver);

    const file = createDriver(
      roundTrip({ type: "file", root: tmp.path, pollInterval: 10 }),
    );
    expect(file).toBeInstanceOf(FileDriver);
    expect((file as FileDriver).root).toBe(tmp.path);

    const redis = createDriver(
      roundTrip({ type: "redis", url: "redis://127.0.0.1:6379/15" }),
    );
    expect(redis).toBeInstanceOf(RedisDriver);

    const mongo = createDriver(
      roundTrip({
        type: "mongodb",
        url: "mongodb://127.0.0.1:27017/ignored",
        database: "chosen",
        collectionPrefix: "cfg_",
        clientOptions: { maxPoolSize: 5 },
        pollInterval: 15,
      }),
    );
    expect(mongo).toBeInstanceOf(MongoDriver);
    // Observable proof the config reached the constructor.
    expect((mongo as MongoDriver).database).toBe("chosen");
    expect((mongo as MongoDriver).collections.jobs).toBe("cfg_jobs");
  });

  it("carries a partial `tables` through, defaulting the rest", () => {
    const sql = createDriver(
      roundTrip({
        type: "sql",
        url: "sqlite://:memory:",
        tables: { events: "legacy_events" },
        eventRetentionMs: 0,
      }),
    ) as SqlDriver;

    expect(sql).toBeInstanceOf(SqlDriver);
    expect(sql.adapter).toBe("sqlite");
    // SQLite is a file on one machine, however it was built.
    expect(sql.capabilities.multiHost).toBe(false);
  });

  it("refuses a config it does not recognise", () => {
    expect(() =>
      createDriver({ type: "cassandra" } as unknown as DriverConfig),
    ).toThrow(/Unrecognised driver config/);
  });
});

const redisUrl = process.env.BUN_JOBS_TEST_REDIS_URL;

describe.skipIf(!redisUrl)("createDriver: redis maxBlockSeconds", () => {
  it("bounds a blocking wait, through the config", async () => {
    // The sharpest available proof that a tuning option reaches the driver:
    // the wait is asked for ten seconds and comes back in a fraction of one,
    // which can only happen if `maxBlockSeconds` was forwarded.
    const driver = createDriver(
      roundTrip({
        type: "redis",
        url: redisUrl!,
        keyPrefix: `cfg-${Date.now()}`,
        maxBlockSeconds: 0.25,
      }),
    );
    const q: QueueRef = { ns: testNamespace("cfg"), queue: "orders" };
    cleanups.push(async () => {
      // Exactly the namespace this test made, never a prefix sweep.
      await driver.purge(q.ns).catch(() => undefined);
      await driver.close();
    });

    await driver.connect();

    const started = Date.now();
    await driver.waitForJob(q, 10_000);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(3_000);
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });
});
