/**
 * The MongoDB driver (plan §7.6): the conformance kit — with its two-process
 * pass and the bus-gap case — plus the behaviours specific to MongoDB, on the
 * server `BUN_CACHE_TEST_MONGODB_URL` (or `BUN_JOBS_TEST_MONGODB_URL`) names, and
 * again on the replica set `BUN_CACHE_TEST_MONGODB_RS_URL` names.
 *
 * The bus reads a change stream on a replica set and a tailable cursor on a
 * standalone server; the bus cases run in every mode the server has (a
 * replica set runs both, through the internal `busMode` option). Cases that
 * need the server's test commands (`configureFailPoint`) skip visibly where
 * they are off.
 *
 * Test data: the run's own collections (`bun_cache_test_<pid>_…`), dropped
 * by name at the end. A backend whose URL is unset skips visibly; one whose
 * URL is set but unreachable fails, naming the variable.
 */
import process from "node:process";
import {
  afterAll,
  describe,
  expect,
  it,
  setDefaultTimeout,
  test,
} from "bun:test";
import { MongoClient } from "mongodb";
import * as jobsConnection from "../../../bun-jobs/lib/shared/connection";
import type { BusMessage, StoredEntry } from "../../lib/index";
import { createCache, mongoDriver } from "../../lib/index";
import type { MongoDriverOptions } from "../../lib/drivers/mongo";
import {
  databaseFromUrl,
  MONGO_CACHE_COLLECTIONS,
  MongoCacheDriver,
} from "../../lib/drivers/mongo";
import { runCacheDriverConformance } from "../../lib/testing/index";
import { mongoBackend, mongoRsBackend, runPrefix } from "./backends";

// Every case here is a fixed amount of work against a server other runs
// share, and none asserts on how long it takes: a wait that matters names
// what never came, with its own bound. bun:test's 5 s was a deadline they
// were never meant to meet under load. Measured with 8 copies of this file
// on one server at loads of 25-65: two processes sweeping 15.9 s, the fence
// race 15.2 s, and a second process's start alone past 5 s.
setDefaultTimeout(30_000);

describe("drift: bun-cache's copied databaseFromUrl behaves like bun-jobs'", () => {
  test("the same database for every URL shape", () => {
    for (const url of [
      "mongodb://127.0.0.1:27017/bun_cache_test",
      "mongodb://127.0.0.1:27017/",
      "mongodb://127.0.0.1:27017",
      "mongodb://u:p%40ss@h1:1,h2:2/app?replicaSet=rs0",
      "mongodb+srv://cluster.example.com/my%20db?retryWrites=true",
      "mongodb://h/db%2Fx",
      "not a url",
      "",
    ]) {
      expect(databaseFromUrl(url)).toBe(jobsConnection.databaseFromUrl(url));
    }
  });
});

/**
 * The servers this file runs against: the standalone one (the bus tails a
 * capped collection) and the replica set (the bus reads a change stream, and
 * both modes are tested there). Each is its own suite, titled by `label`.
 */
const backends = [
  { label: "mongodb", ...mongoBackend() },
  { label: "mongodb-rs", ...mongoRsBackend() },
];

/** An entry for the specifics. */
function entry(
  key: string,
  bytes: number[],
  tags: readonly string[] = [],
  expiresAt: number | null = null,
): StoredEntry {
  return { key, value: new Uint8Array(bytes), expiresAt, tags };
}

/** Waits until `condition` holds, checking every 10 ms; throws after `timeoutMs`. */
async function waitFor(
  what: string,
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${what}`);
    }
    await Bun.sleep(10);
  }
}

/** Connects once to see whether the server is there; answers the failure, not a boolean. */
async function reachError(url: string): Promise<Error | undefined> {
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 3_000 });
  try {
    await client.connect();
    await client.db().command({ ping: 1 });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  } finally {
    await client.close().catch(() => undefined);
  }
}

for (const backend of backends) {
  if (backend.url === undefined) {
    describe.skip(`backend ${backend.label}: not configured`, () => {
      it(`set ${backend.variable} (bun scripts/setup-databases.ts --print-env) to run it`, () => {});
    });
  } else {
    const unreachable = await reachError(backend.url);
    if (unreachable !== undefined) {
      // bun-jobs' `reportUnreachable`, as the SQL suites have it.
      describe(`backend ${backend.label}: unreachable`, () => {
        it(`connects to the server ${backend.variable} points at`, () => {
          throw new Error(
            `${backend.variable} (or its BUN_JOBS_TEST_* fallback) is set, but the ${backend.label} server it names could not be reached, so every ${backend.label} test would have been skipped and the run would still have been green. Start the server (bun scripts/setup-databases.ts), fix the URL, or unset the variable to skip ${backend.label} deliberately.\n  ${unreachable.message}`,
            { cause: unreachable },
          );
        });
      });
    } else {
      await registerMongoSuite(backend.url, backend.label);
    }
  }
}

/** Registers the whole suite against a reachable server. */
async function registerMongoSuite(url: string, label: string): Promise<void> {
  const raw = new MongoClient(url);
  await raw.connect();
  const db = raw.db(databaseFromUrl(url) ?? "bun_cache");
  const hello = await db.command({ hello: 1 });
  const replicaSet = typeof hello.setName === "string";
  /**
   * Whether the server takes `configureFailPoint` (test commands on). Read,
   * never probed by configuring one: `failCommand` is one fail point for the
   * whole server, so setting it here, even `mode: "off"`, would disarm the
   * one another run of this file (another copy's, another worktree's) has
   * just armed.
   */
  const failPoints = await raw
    .db("admin")
    .command({ getParameter: 1, enableTestCommands: 1 })
    .then(
      (reply) => reply.enableTestCommands === true,
      () => false,
    );
  const busModes: ("change-stream" | "tailable")[] = replicaSet
    ? ["change-stream", "tailable"]
    : ["tailable"];

  /** Every collection this run made or named, dropped by name at the end. */
  const owned = new Set<string>();
  /** A prefix of this run's, its four collections recorded for the end. */
  const prefix = (suffix: string): string => {
    const value = runPrefix(suffix);
    for (const which of MONGO_CACHE_COLLECTIONS) {
      owned.add(`${value}${which}`);
    }
    return value;
  };
  /** A collection name of this run's. */
  const named = (suffix: string): string => {
    const value = runPrefix(suffix);
    owned.add(value);
    return value;
  };
  /** A driver on this run's collections. */
  /** Every driver the suite made, closed before the drop: a subscriber left open by a failed test would recreate its bus collection after it. */
  const made: MongoCacheDriver[] = [];
  const make = (suffix: string, extra: Partial<MongoDriverOptions> = {}) => {
    const driver = new MongoCacheDriver({
      url,
      prefix: prefix(suffix),
      ...extra,
    });
    made.push(driver);
    return driver;
  };

  afterAll(
    async () => {
      // `close` is idempotent, so the ones a test closed are no-ops.
      await Promise.all(made.map(async (driver) => await driver.close()));
      // Side by side: one at a time, the hundred-odd drops took past
      // bun:test's 5 s with 8 copies of this file on one loaded server, and
      // the hook was cut short with collections still there (side by side:
      // at most 1.1 s, measured the same way).
      await Promise.all(
        [...owned].map(
          async (name) =>
            await db
              .collection(name)
              .drop()
              .catch(() => undefined),
        ),
      );
      await raw.close();
    },
    { timeout: 30_000 },
  );

  // The kit, on its own collections.
  const kitOptions = { url, prefix: prefix("kit_") };
  const kitDriver = mongoDriver(kitOptions);
  // Connected first, so the capabilities the kit gates on include what the
  // server reports (`maxEntryBytes`).
  await kitDriver.connect!();
  await runCacheDriverConformance(
    label,
    () => ({ driver: kitDriver, cleanup: async () => await kitDriver.close() }),
    {
      crossProcess: {
        module: new URL("../../lib/drivers/mongo.ts", import.meta.url).pathname,
        export: "mongoDriver",
        options: kitOptions,
      },
      // A loss under a live subscriber: its bus collection dropped. A
      // tailing cursor dies (QueryPlanKilled), a change stream is
      // invalidated; either way it must reopen and report the gap.
      busGap: async () => {
        await db.collection(`${kitOptions.prefix}bus`).drop();
      },
    },
  );

  describe(`${label} collection names and schema sync`, () => {
    test("names its collections by prefix or outright: a `collections` name is used as given", async () => {
      const entries = named("legacy_docs");
      const options = { collections: { entries } };
      const driver = make("named_", options);
      await driver.set("ns", entry("k", [1, 2], ["t"]));
      expect(
        (await db.collection(entries).find({}).toArray()).map(
          (doc) => (doc._id as unknown as { k: string }).k,
        ),
      ).toEqual(["k"]);
      // The collections not named keep the prefix.
      await driver.setStamps("ns", ["t"], 1, Date.now() + 60_000);
      expect(
        await db.collection(`${runPrefix("named_")}stamps`).countDocuments({}),
      ).toBe(1);
      // The prefix alone names another entries collection.
      const prefixed = make("named_");
      expect(await prefixed.get("ns", "k")).toBeUndefined();
      const again = make("named_", options);
      expect([...(await again.get("ns", "k"))!.value]).toEqual([1, 2]);
      await Promise.all([driver.close(), prefixed.close(), again.close()]);
    });

    test("bad names throw before anything connects", () => {
      for (const collections of [
        { entries: "bad name" },
        { entries: "x$y" },
        { entries: "9lives" },
        { entries: "system.cache" },
        { entries: "t".repeat(121) },
        { entries: "same", stamps: "same" },
        { entries: "bun_cache_stamps" },
        { jobs: "nope" },
      ] as Record<string, string>[]) {
        expect(() => mongoDriver({ url, collections })).toThrow(TypeError);
      }
      for (const prefixValue of ["bad prefix", "x$", "", "system."]) {
        expect(() => mongoDriver({ url, prefix: prefixValue })).toThrow(
          TypeError,
        );
      }
      expect(() => mongoDriver({})).toThrow(TypeError);
      for (const bad of [0, -1, 1.5, Number.NaN]) {
        expect(() => mongoDriver({ url, maxEntries: bad })).toThrow(TypeError);
      }
      expect(() => mongoDriver({ url, busSize: 4095 })).toThrow(TypeError);
    });

    test("the database: the option, then the connection's, then the URL's, then bun_cache", () => {
      const base = "mongodb://127.0.0.1:27017";
      const of = (options: MongoDriverOptions): string =>
        (mongoDriver(options) as MongoCacheDriver).database;
      expect(of({ url: `${base}/app`, database: "other" })).toBe("other");
      expect(of({ url: `${base}/app` })).toBe("app");
      expect(of({ url: base })).toBe("bun_cache");
      expect(of({ connection: { database: "fields" } })).toBe("fields");
    });

    test("connect creates the TTL indexes and the tag index, MongoDB-named", async () => {
      const driver = make("idx_");
      await driver.connect();
      const indexes = async (which: string) =>
        await db.collection(`${runPrefix("idx_")}${which}`).indexes();
      const entries = await indexes("entries");
      expect(entries.find((index) => index.name === "exp_1")).toMatchObject({
        expireAfterSeconds: 0,
      });
      expect(entries.map((index) => index.name)).toContain("_id.ns_1_tags_1");
      for (const which of ["stamps", "locks"]) {
        expect(
          (await indexes(which)).find((index) => index.name === "exp_1"),
        ).toMatchObject({ expireAfterSeconds: 0 });
      }
      await driver.close();
    });

    test("syncSchema: nothing to change on a fresh schema; a missing index is planned, then created; an index of someone else's is never dropped", async () => {
      const driver = make("sync_");
      expect(await driver.syncSchema()).toEqual([]);
      const entries = db.collection(`${runPrefix("sync_")}entries`);
      await entries.dropIndex("_id.ns_1_tags_1");
      // An operator's own index: not on RETIRED_INDEXES, so it stays.
      await entries.createIndex({ hand: 1 });
      const planned = await driver.syncSchema({ dryRun: true });
      expect(planned).toEqual([
        {
          description: `create index _id.ns_1_tags_1 on ${runPrefix("sync_")}entries`,
          applied: false,
          blocking: false,
        },
      ]);
      expect(
        (await entries.indexes()).map((index) => index.name),
      ).not.toContain("_id.ns_1_tags_1");
      const applied = await driver.syncSchema();
      expect(applied.map((change) => change.applied)).toEqual([true]);
      const names = (await entries.indexes()).map((index) => index.name);
      expect(names).toContain("_id.ns_1_tags_1");
      expect(names).toContain("hand_1");
      expect(await driver.syncSchema()).toEqual([]);
      await driver.close();
    });

    test("syncSchema: runs on connect when set; never when unset", async () => {
      const calls: unknown[] = [];
      const spy = (driver: MongoCacheDriver): void => {
        const target = driver as unknown as {
          migrateSchema: (db: unknown, options: unknown) => Promise<unknown>;
        };
        const original = target.migrateSchema.bind(driver);
        target.migrateSchema = async (database, options) => {
          calls.push(options);
          return await original(database, options);
        };
      };
      const off = make("syncoff_");
      spy(off);
      await off.connect();
      expect(calls).toEqual([]);
      await off.close();
      const on = make("syncon_", { syncSchema: true });
      spy(on);
      await on.set("ns", entry("k", [1]));
      await on.connect();
      expect(calls).toEqual([{}]);
      await on.close();
      const dry = make("syncdry_", { syncSchema: { dryRun: true } });
      spy(dry);
      await dry.connect();
      expect(calls).toEqual([{}, { dryRun: true }]);
      await dry.close();
    });

    test("an existing bus collection that is not capped is refused, naming it", async () => {
      const bus = named("plain_bus");
      await db.createCollection(bus);
      const driver = make("plainbus_", { collections: { bus } });
      await expect(
        driver.publish({ type: "clear", namespace: "x", at: 0 }),
      ).rejects.toThrow(/not capped/);
      await driver.close();
    });
  });

  describe(`${label} maxEntries (§3.9)`, () => {
    /** The entries left in a prefix's collection, `ns:k`, sorted (counters excluded). */
    const keysIn = async (value: string): Promise<string[]> =>
      (
        await db
          .collection(`${value}entries`)
          .find({ v: { $exists: true } })
          .toArray()
      )
        .map((doc) => {
          const id = doc._id as unknown as { ns: string; k: string };
          return `${id.ns}:${id.k}`;
        })
        .sort();

    test("a sweep evicts down to the cap, nearest to expiry first, then the oldest unexpiring write; counters stay", async () => {
      let now = Date.now();
      const driver = make("cap1_", { maxEntries: 3, now: () => now });
      const evicted: string[] = [];
      driver.onEviction((ns, key, reason) => {
        evicted.push(`${ns}:${key}:${reason}`);
      });
      const put = async (
        key: string,
        expiresAt: number | null,
      ): Promise<void> => {
        await driver.set("ns", entry(key, [1], [], expiresAt));
        now++;
      };
      await driver.increment("ns", "hits", 1, null);
      now++;
      await put("a", now + 30_000);
      await put("b", now + 10_000);
      await put("c", null);
      await put("d", now + 20_000);
      await put("e", null);
      await put("f", null);
      expect(await driver.sweep(now, 1_000)).toBe(0);
      expect(evicted).toEqual(["ns:b:cap", "ns:d:cap", "ns:a:cap"]);
      expect(await keysIn(runPrefix("cap1_"))).toEqual([
        "ns:c",
        "ns:e",
        "ns:f",
      ]);
      expect((await driver.getCounter("ns", "hits"))?.value).toBe(1);
      await put("g", null);
      await driver.sweep(now, 1_000);
      expect(evicted.at(-1)).toBe("ns:c:cap");
      expect(await keysIn(runPrefix("cap1_"))).toEqual([
        "ns:e",
        "ns:f",
        "ns:g",
      ]);
      expect((await driver.getCounter("ns", "hits"))?.value).toBe(1);
      await driver.sweep(now, 1_000);
      expect(evicted).toHaveLength(4);
      await driver.close();
    });

    test("the cap counts every namespace and evicts at most `limit` per pass", async () => {
      let now = Date.now();
      const driver = make("cap2_", { maxEntries: 2, now: () => now });
      for (const [ns, key] of [
        ["one", "k1"],
        ["two", "k2"],
        ["one", "k3"],
        ["two", "k4"],
        ["one", "k5"],
      ] as const) {
        await driver.set(ns, entry(key, [1], ["t", `t-${key}`]));
        now++;
      }
      await driver.sweep(now, 1);
      expect(await keysIn(runPrefix("cap2_"))).toEqual([
        "one:k3",
        "one:k5",
        "two:k2",
        "two:k4",
      ]);
      await driver.sweep(now, 10);
      expect(await keysIn(runPrefix("cap2_"))).toEqual(["one:k5", "two:k4"]);
      expect(await driver.deleteByTags("one", ["t"], now + 60_000)).toBe(1);
      await driver.close();
    });

    test("through the cache: each eviction is an `evict` event and counts in stats()", async () => {
      const driver = make("cap3_", { maxEntries: 2 });
      const cache = createCache({ driver, sweepInterval: 0 });
      const events: string[] = [];
      cache.on("evict", (event) => {
        events.push(event.reason);
      });
      for (let index = 0; index < 5; index++) {
        await cache.set(`k${index}`, index, { ttl: 60_000 + index });
      }
      await driver.sweep(Date.now(), 1_000);
      expect(events).toEqual(["cap", "cap", "cap"]);
      expect(cache.stats().evictions).toBe(3);
      expect(await cache.get("k0")).toBeUndefined();
      expect(await cache.get("k4")).toBe(4);
      await cache.close();
    });

    test("two processes sweeping at once hold the cap exactly — no double eviction", async () => {
      for (let round = 0; round < 3; round++) {
        const options = {
          url,
          prefix: prefix(`capx${round}_`),
          maxEntries: 15,
        };
        const driver = mongoDriver(options);
        let evicted = 0;
        driver.onEviction!(() => {
          evicted++;
        });
        for (let index = 0; index < 20; index++) {
          await driver.set("p", entry(`parent-${index}`, [1], ["parent"]));
        }
        // The SQL drivers' cap worker is driver-agnostic: it builds the
        // driver from a module, an export and options.
        const child = Bun.spawn({
          cmd: [
            process.execPath,
            new URL("./sql-cap-worker.ts", import.meta.url).pathname,
            new URL("../../lib/drivers/mongo.ts", import.meta.url).pathname,
            "mongoDriver",
            JSON.stringify(options),
            "20",
            "c",
          ],
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        let text = "";
        while (!text.includes("\n")) {
          const { done, value } = await reader.read();
          if (done) {
            throw new Error(
              `worker exited before ready: ${await new Response(child.stderr).text()}`,
            );
          }
          text += decoder.decode(value, { stream: true });
        }
        void child.stdin.end();
        await driver.sweep!(Date.now(), 1_000);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          text += decoder.decode(value, { stream: true });
        }
        expect(await child.exited).toBe(0);
        const theirs = (
          JSON.parse(text.trim().split("\n").at(-1)!) as { evicted: number }
        ).evicted;
        expect(await keysIn(options.prefix)).toHaveLength(15);
        expect(evicted + theirs).toBe(25);
        await driver.close();
      }
    }, 30_000);

    test("no cap by default", async () => {
      const driver = make("cap5_");
      for (let index = 0; index < 50; index++) {
        await driver.set("ns", entry(`k${index}`, [1]));
      }
      await driver.sweep(Date.now(), 1_000);
      expect(await keysIn(runPrefix("cap5_"))).toHaveLength(50);
      await driver.close();
    });
  });

  describe(`${label} specifics`, () => {
    const driver = make("spec_");
    const ns = `spec-${process.pid}`;

    afterAll(async () => {
      await driver.close();
    });

    test("keys are exact, long names need no hashing, and the value comes back as a plain Uint8Array", async () => {
      await driver.set(ns, entry("a", [1]));
      await driver.set(ns, entry("A", [2]));
      await driver.set(ns, entry("a ", [3]));
      const long = "k".repeat(5_000);
      await driver.set(ns, entry(long, [4], ["t".repeat(2_000)]));
      expect([...(await driver.get(ns, "a"))!.value]).toEqual([1]);
      expect([...(await driver.get(ns, "A"))!.value]).toEqual([2]);
      expect([...(await driver.get(ns, "a "))!.value]).toEqual([3]);
      const read = await driver.get(ns, long);
      expect(read?.key).toBe(long);
      expect(read?.value.constructor).toBe(Uint8Array);
      expect(
        await driver.deleteByTags(ns, ["t".repeat(2_000)], Date.now() + 60_000),
      ).toBe(1);
      expect(await driver.delete(ns, ["a", "A", "a "])).toBe(3);
    });

    test("counters: below zero, replacing an entry, replaced by a set, restarting once expired", async () => {
      expect(await driver.increment(ns, "neg", -3, null)).toBe(-3);
      expect(await driver.increment(ns, "neg", -2, null)).toBe(-5);
      expect(await driver.increment(ns, "neg", 7, null)).toBe(2);
      // Past 32 bits: MongoDB promotes the stored int to a long.
      expect(await driver.increment(ns, "big", 2 ** 31 - 1, null)).toBe(
        2 ** 31 - 1,
      );
      expect(await driver.increment(ns, "big", 10, null)).toBe(2 ** 31 + 9);

      await driver.set(ns, entry("was-entry", [9], ["x"]));
      expect(await driver.increment(ns, "was-entry", 4, null)).toBe(4);
      expect(await driver.get(ns, "was-entry")).toBeUndefined();
      expect(await driver.deleteByTags(ns, ["x"], Date.now() + 60_000)).toBe(0);
      expect((await driver.getCounter(ns, "was-entry"))?.value).toBe(4);

      await driver.set(ns, entry("was-entry", [5]));
      expect(await driver.getCounter(ns, "was-entry")).toBeUndefined();
      expect([...(await driver.get(ns, "was-entry"))!.value]).toEqual([5]);

      await driver.increment(ns, "expiring", 10, Date.now() - 1);
      const later = Date.now() + 60_000;
      expect(await driver.increment(ns, "expiring", 1, later)).toBe(1);
      expect((await driver.getCounter(ns, "expiring"))?.expiresAt).toBe(later);

      await expect(driver.increment(ns, "frac", 0.5, null)).rejects.toThrow(
        TypeError,
      );
    });

    test("an expired document the TTL monitor has not reached is a miss everywhere, and the sweeper takes it", async () => {
      const sweepDriver = make("sweep_");
      const past = Date.now() - 1_000;
      await sweepDriver.set(ns, entry("dead", [1], ["t"], past));
      await sweepDriver.set(ns, entry("live", [2], ["t"]));
      await sweepDriver.increment(ns, "dead-counter", 1, past);
      // Still stored: the TTL monitor runs once a minute.
      expect(
        await db.collection(`${runPrefix("sweep_")}entries`).countDocuments({}),
      ).toBe(3);
      expect(await sweepDriver.get(ns, "dead")).toBeUndefined();
      expect(
        (await sweepDriver.getMany(ns, ["dead", "live"]))[0],
      ).toBeUndefined();
      expect(await sweepDriver.touch(ns, "dead", null)).toBe(false);
      expect(await sweepDriver.getCounter(ns, "dead-counter")).toBeUndefined();
      expect(await sweepDriver.sweep(Date.now(), 1_000)).toBe(2);
      expect(
        await db.collection(`${runPrefix("sweep_")}entries`).countDocuments({}),
      ).toBe(1);
      await sweepDriver.close();
    });

    test("touch to the same expiry still answers true", async () => {
      const at = Date.now() + 60_000;
      await driver.set(ns, entry("same", [1], [], at));
      expect(await driver.touch(ns, "same", at)).toBe(true);
      expect(await driver.touch(ns, "same", at)).toBe(true);
    });

    test("a lock re-taken by its owner is refreshed, not refused", async () => {
      expect(await driver.acquireLock(ns, "re", "me", 30_000)).toBe(true);
      expect(await driver.acquireLock(ns, "re", "me", 30_000)).toBe(true);
      expect(await driver.acquireLock(ns, "re", "you", 30_000)).toBe(false);
    });

    test("the fence holds under a concurrent invalidation: a pre-invalidation write never survives it", async () => {
      // Each round races a fenced write, whose load began before, against an
      // invalidation of its tag. Whichever lands first, nothing may be left:
      // either the write was fenced (or took itself back), or the
      // invalidation deleted it.
      // Its own driver: the cases after this one patch `driver`'s methods,
      // and a round still in flight here must never call into a patch.
      const racer = make("specrace_");
      const raceNs = `race-${process.pid}`;
      const survivors: number[] = [];
      for (let round = 0; round < 60; round++) {
        const key = `k${round}`;
        const tag = `t${round}`;
        const startedAt = Date.now() - 1;
        await Promise.all([
          racer.set(raceNs, entry(key, [1], [tag]), {
            tags: [tag],
            createdAt: startedAt,
          }),
          (async () => {
            await Bun.sleep(round % 3);
            await racer.deleteByTags(raceNs, [tag], Date.now() + 60_000);
          })(),
        ]);
        if ((await racer.get(raceNs, key)) !== undefined) {
          survivors.push(round);
        }
      }
      expect(survivors).toEqual([]);
      await racer.close();
    });

    test("an invalidation between the fence's check and its write: the write takes itself back", async () => {
      // The interleaving the re-check exists for, made deterministic: the
      // whole invalidation (stamp, then delete) runs after the fence's first
      // stamp read answered "nothing", so the write lands after the delete.
      const fenceNs = `between-${process.pid}`;
      const target = driver as unknown as {
        getStamps: MongoCacheDriver["getStamps"];
      };
      const original = target.getStamps.bind(driver);
      let calls = 0;
      target.getStamps = async (n, tags) => {
        calls++;
        const answer = await original(n, tags);
        if (calls === 1) {
          await driver.deleteByTags(n, tags, Date.now() + 60_000);
        }
        return answer;
      };
      try {
        expect(
          await driver.set(fenceNs, entry("k", [1], ["t"]), {
            tags: ["t"],
            createdAt: Date.now() - 1,
          }),
        ).toBe("fenced");
      } finally {
        target.getStamps = original;
      }
      expect(await driver.get(fenceNs, "k")).toBeUndefined();
    });

    test("an invalidation writes its stamps before it deletes (the order the fence's re-check relies on)", async () => {
      const orderNs = `order-${process.pid}`;
      await driver.set(orderNs, entry("k", [1], ["t"]));
      const target = driver as unknown as {
        setStamps: MongoCacheDriver["setStamps"];
      };
      const original = target.setStamps.bind(driver);
      let presentAtStamp: boolean | undefined;
      target.setStamps = async (n, tags, at, until) => {
        presentAtStamp = (await driver.get(n, "k")) !== undefined;
        await original(n, tags, at, until);
      };
      try {
        expect(
          await driver.deleteByTags(orderNs, ["t"], Date.now() + 60_000),
        ).toBe(1);
      } finally {
        target.setStamps = original;
      }
      expect(presentAtStamp).toBe(true);
    });

    test("the fence's take-back removes only its own write, never a newer one", async () => {
      const fenceNs = `takeback-${process.pid}`;
      // A newer write lands between the fenced write and its re-check: the
      // re-check sees the stamp, and must not delete the newer value.
      const target = driver as unknown as {
        getStamps: MongoCacheDriver["getStamps"];
      };
      const original = target.getStamps.bind(driver);
      let calls = 0;
      target.getStamps = async (n, tags) => {
        calls++;
        if (calls === 2) {
          // The re-check: first an invalidation, then a newer, unfenced write.
          await original(n, tags);
          await driver.setStamps(n, tags, Date.now(), Date.now() + 60_000);
          await driver.set(n, entry("k", [2], ["t"]));
        }
        return await original(n, tags);
      };
      try {
        expect(
          await driver.set(fenceNs, entry("k", [1], ["t"]), {
            tags: ["t"],
            createdAt: Date.now() - 1,
          }),
        ).toBe("fenced");
      } finally {
        target.getStamps = original;
      }
      expect([...(await driver.get(fenceNs, "k"))!.value]).toEqual([2]);
    });

    test("an existing client is used and never closed", async () => {
      const client = new MongoClient(url);
      const shared = mongoDriver({
        client,
        database: db.databaseName,
        prefix: prefix("shared_"),
      });
      await shared.set(ns, entry("k", [1]));
      await shared.close();
      expect((await client.db().command({ ping: 1 })).ok).toBe(1);
      await client.close();
    });

    test("syncSchema reports nothing to change", async () => {
      expect(await driver.syncSchema()).toEqual([]);
      expect(await driver.syncSchema({ dryRun: true })).toEqual([]);
    });

    test("a cache over the driver: getOrSet, tags, counters", async () => {
      const cache = createCache({
        driver: make("cache_"),
        namespace: `cache-${process.pid}`,
        sweepInterval: 0,
      });
      let loads = 0;
      const load = async () => {
        loads++;
        return { n: loads };
      };
      expect(await cache.getOrSet("k", load, { tags: ["g"] })).toEqual({
        n: 1,
      });
      expect(await cache.getOrSet("k", load, { tags: ["g"] })).toEqual({
        n: 1,
      });
      await cache.invalidateTags(["g"]);
      expect(await cache.getOrSet("k", load, { tags: ["g"] })).toEqual({
        n: 2,
      });
      expect(await cache.increment("hits", 5)).toBe(5);
      expect(await cache.get("hits")).toBe(5);
      await cache.close();
    });

    test("maxEntryBytes is the server's maxBsonObjectSize less room for the fields", () => {
      expect(kitDriver.capabilities.maxEntryBytes).toBe(
        (hello.maxBsonObjectSize as number) - 64 * 1024,
      );
    });
  });

  for (const mode of busModes) {
    describe(`${label} bus (${mode})`, () => {
      test("a second driver instance receives what the first publishes; two collection sets are two buses", async () => {
        const a = make("bus_", { busMode: mode });
        const b = make("bus_", { busMode: mode });
        const other = make("busother_", { busMode: mode });
        const received: BusMessage[] = [];
        const unsubscribe = await b.subscribe(
          (message) => {
            received.push(message);
          },
          () => {},
        );
        await other.publish({ type: "clear", namespace: "elsewhere", at: 0 });
        const message: BusMessage = {
          type: "invalidate-tags",
          namespace: "app",
          tags: ["users"],
          at: Date.now(),
          origin: "cache-a",
        };
        await a.publish(message);
        await waitFor("the message", () => received.length > 0);
        await Bun.sleep(100);
        expect(received).toEqual([message]);
        await unsubscribe();
        await Promise.all([a.close(), b.close(), other.close()]);
      });

      test("a message too big for the bus becomes a clear of its namespace", async () => {
        const bus = make("busbig_", { busMode: mode });
        const received: BusMessage[] = [];
        const unsubscribe = await bus.subscribe(
          (message) => {
            received.push(message);
          },
          () => {},
        );
        await bus.publish({
          type: "delete",
          namespace: "big",
          keys: Array.from({ length: 10_000 }, (_, index) => `key-${index}`),
          at: 1,
          origin: "o",
        });
        await waitFor("the flush", () => received.length > 0);
        // The origin stays, so the publisher still skips its own message.
        expect(received).toEqual([
          { type: "clear", namespace: "big", at: 1, origin: "o" },
        ]);
        await unsubscribe();
        await bus.close();
      });

      test("a cursor killed under a subscriber resumes where it was: nothing lost, no gap", async () => {
        const options = { busMode: mode };
        const bus = make("buskill_", options);
        const writer = make("buskill_", options);
        let gaps = 0;
        const received: string[] = [];
        const unsubscribe = await bus.subscribe(
          (message) => {
            received.push(message.namespace);
          },
          () => {
            gaps++;
          },
        );
        await writer.publish({ type: "clear", namespace: "before", at: 1 });
        await waitFor("the first message", () => received.includes("before"));
        const ns = `${db.databaseName}.${runPrefix("buskill_")}bus`;
        const ops = await raw
          .db("admin")
          .aggregate([
            { $currentOp: { idleCursors: true, allUsers: true } },
            { $match: { ns } },
          ])
          .toArray();
        const ids = ops
          .map(
            (op) =>
              (
                op.cursor as
                  { cursorId?: { toString: () => string } } | undefined
              )?.cursorId,
          )
          .filter((id) => id !== undefined)
          .map((id) => id.toString());
        expect(ids.length).toBeGreaterThan(0);
        // Another process kills the cursor and publishes while this one's
        // event loop is blocked (spawnSync), so the message lands after the
        // kill and before the subscriber can reopen: only a resume from where
        // it had read (the change stream's token, the tailing cursor's
        // timestamp) delivers it; a fresh start from "now" would lose it.
        const child = Bun.spawnSync({
          cmd: [
            process.execPath,
            "-e",
            `const { MongoClient, Long } = await import("mongodb");
             const c = new MongoClient(${JSON.stringify(url)});
             await c.connect();
             const db = c.db(${JSON.stringify(db.databaseName)});
             const name = ${JSON.stringify(`${runPrefix("buskill_")}bus`)};
             await db.command({ killCursors: name, cursors: ${JSON.stringify(ids)}.map((id) => Long.fromString(id)) });
             await db.collection(name).updateOne({ _id: "between-" + Date.now() }, { $setOnInsert: { m: { type: "clear", namespace: "between", at: 2 } }, $currentDate: { ts: { $type: "timestamp" } } }, { upsert: true });
             await c.close();`,
          ],
          cwd: new URL("../..", import.meta.url).pathname,
          stderr: "pipe",
        });
        expect(child.exitCode, child.stderr.toString()).toBe(0);
        await writer.publish({ type: "clear", namespace: "after", at: 3 });
        await waitFor("the message after the kill", () =>
          received.includes("after"),
        );
        expect(received).toEqual(["before", "between", "after"]);
        expect(gaps).toBe(0);
        await unsubscribe();
        await Promise.all([bus.close(), writer.close()]);
      });

      test("two caches with an L1 each stay coherent over the driver's bus", async () => {
        const options = { busMode: mode };
        const namespace = `l1-${process.pid}`;
        const a = createCache({
          driver: make("busl1_", options),
          namespace,
          l1: true,
          sweepInterval: 0,
        });
        const b = createCache({
          driver: make("busl1_", options),
          namespace,
          l1: true,
          sweepInterval: 0,
        });
        try {
          await a.set("k", 1);
          expect(await b.get("k")).toBe(1);
          // b's L1 holds 1 now; a's write must reach it over the bus.
          await a.set("k", 2);
          const deadline = Date.now() + 5_000;
          while ((await b.get("k")) !== 2) {
            if (Date.now() > deadline) {
              throw new Error("b's L1 kept the old value");
            }
            await Bun.sleep(10);
          }
          await a.delete("k");
          const gone = Date.now() + 5_000;
          while ((await b.get("k")) !== undefined) {
            if (Date.now() > gone) {
              throw new Error("b's L1 kept a deleted value");
            }
            await Bun.sleep(10);
          }
        } finally {
          await Promise.all([a.close(), b.close()]);
        }
      });

      if (mode === "tailable") {
        test("a subscriber overrun by the capped collection reports a gap, then delivers again", async () => {
          const options = { busMode: mode, busSize: 4096 };
          const bus = make("busrun_", options);
          const writer = make("busrun_", options);
          let gaps = 0;
          const received: string[] = [];
          const unsubscribe = await bus.subscribe(
            (message) => {
              received.push(message.namespace);
            },
            () => {
              gaps++;
            },
          );
          await writer.publish({ type: "clear", namespace: "first", at: 0 });
          await waitFor("the first message", () => received.includes("first"));
          // Another process overwrites the 4 KiB collection many times over
          // while this one's event loop is blocked (spawnSync), so the
          // cursor's place is gone by its next getMore: CappedPositionLost.
          // One bulk write, one command: 400 upserts one at a time each
          // waited for the replica set's journal, and took 17-20 s of the
          // case's 20 s with 8 copies of this file on one loaded server.
          const burst = Bun.spawnSync({
            cmd: [
              process.execPath,
              "-e",
              `const { MongoClient } = await import("mongodb");
               const c = new MongoClient(${JSON.stringify(url)});
               await c.connect();
               const bus = c.db(${JSON.stringify(db.databaseName)}).collection(${JSON.stringify(`${runPrefix("busrun_")}bus`)});
               await bus.bulkWrite(Array.from({ length: 400 }, (_, i) => ({ updateOne: { filter: { _id: "burst-" + i }, update: { $setOnInsert: { m: { type: "clear", namespace: "burst", at: i } }, $currentDate: { ts: { $type: "timestamp" } } }, upsert: true } })));
               await c.close();`,
            ],
            cwd: new URL("../..", import.meta.url).pathname,
            stderr: "pipe",
          });
          expect(burst.exitCode, burst.stderr.toString()).toBe(0);
          await waitFor("the gap", () => gaps > 0, 10_000);
          await writer.publish({ type: "clear", namespace: "later", at: 1 });
          await waitFor("delivery after the gap", () =>
            received.includes("later"),
          );
          await unsubscribe();
          await Promise.all([bus.close(), writer.close()]);
        }, 20_000);
      }

      if (mode === "change-stream") {
        (failPoints ? test : test.skip)(
          `a stream lost on its very first read resumes from where it opened: no gap${failPoints ? "" : " — skipped: the server's test commands are off (configureFailPoint)"}`,
          async () => {
            // The first read is the stream's aggregate and its first getMore
            // in one call, so a loss there comes before any read has
            // answered. It must resume from where the stream opened (or the
            // token the aggregate left), not restart from now with a gap.
            // Armed before subscribing, for this driver's client alone: an
            // error the client does not resume over itself (BadValue), so
            // the driver's own resume is what is tested.
            const appName = runPrefix("busfirst");
            const bus = make("busfirst_", {
              busMode: mode,
              clientOptions: { appName },
            });
            const writer = make("busfirst_", { busMode: mode });
            let gaps = 0;
            const received: string[] = [];
            await raw.db("admin").command({
              configureFailPoint: "failCommand",
              mode: { times: 1 },
              data: { failCommands: ["getMore"], errorCode: 2, appName },
            });
            const unsubscribe = await bus.subscribe(
              (message) => {
                received.push(message.namespace);
              },
              () => {
                gaps++;
              },
            );
            await writer.publish({ type: "clear", namespace: "one", at: 0 });
            await waitFor("the message", () => received.includes("one"));
            await writer.publish({ type: "clear", namespace: "two", at: 1 });
            await waitFor("the next message", () => received.includes("two"));
            expect(received).toEqual(["one", "two"]);
            expect(gaps).toBe(0);
            await unsubscribe();
            await Promise.all([bus.close(), writer.close()]);
          },
        );

        (failPoints ? test : test.skip)(
          `a change stream whose history is lost reports a gap, then delivers again${failPoints ? "" : " — skipped: the server's test commands are off (configureFailPoint)"}`,
          async () => {
            // Its own client name, so the fail point below fails this
            // driver's getMore and no other run's.
            const appName = runPrefix("bushist");
            const bus = make("bushist_", {
              busMode: mode,
              clientOptions: { appName },
            });
            let gaps = 0;
            const received: string[] = [];
            const unsubscribe = await bus.subscribe(
              (message) => {
                received.push(message.namespace);
              },
              () => {
                gaps++;
              },
            );
            await bus.publish({ type: "clear", namespace: "first", at: 0 });
            await waitFor("the first message", () =>
              received.includes("first"),
            );
            // ChangeStreamHistoryLost: not resumable, so the client gives up
            // and the driver must reopen and say so. The fail point is one
            // per server, shared with every other run on it, and the last to
            // configure it wins. So it names this driver's client; a publish
            // ends the getMore in flight, so the next one (the one that
            // fails) follows in milliseconds rather than after the driver's
            // 1 s await; and it is armed again while no gap has come, in
            // case another run replaced it in between.
            const gapped = (): boolean => gaps > 0;
            const deadline = Date.now() + 15_000;
            let armed = 0;
            while (!gapped()) {
              if (Date.now() > deadline) {
                throw new Error(
                  `Timed out waiting for: the gap (fail point armed ${armed} times)`,
                );
              }
              await raw.db("admin").command({
                configureFailPoint: "failCommand",
                mode: { times: 1 },
                data: { failCommands: ["getMore"], errorCode: 286, appName },
              });
              await bus.publish({
                type: "clear",
                namespace: `nudge-${armed++}`,
                at: 0,
              });
              const since = Date.now();
              while (!gapped() && Date.now() - since < 2_000) {
                await Bun.sleep(10);
              }
            }
            await bus.publish({ type: "clear", namespace: "later", at: 1 });
            await waitFor("delivery after the gap", () =>
              received.includes("later"),
            );
            await unsubscribe();
            await bus.close();
          },
          // Past the 15 s of re-arming and the 5 s wait for delivery, so the
          // failure names what never came. Measured with 8 and 12 copies of
          // this file on one server: the gap within 4.1 s (at most 3 arms).
          30_000,
        );
      }
    });
  }
}
