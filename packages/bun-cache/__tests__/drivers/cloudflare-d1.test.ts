/**
 * The Cloudflare D1 driver (plan Status: PR-C11), against real D1 in workerd:
 * the shipped Worker run by miniflare (`../cloudflare/harness.ts`), on port
 * 0, in memory — no account and no environment variable, so it always runs.
 * The conformance kit with its two-process pass, the race the one-statement
 * fence must win (with the check-then-write control that loses it, as in the
 * spike), and the driver's specifics: the triggers keeping the tag index, hex
 * values and the 1,000,000-byte cap, string parameters, the sweeper and the
 * `maxEntries` cap.
 *
 * The REST API transport and Cloudflare's own D1 run in the opt-in live lane,
 * `cloudflare-d1-live.test.ts`.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { CacheDriver, StoredEntry } from "../../lib/index";
import {
  cloudflareD1Driver,
  createCache,
  EntryTooLargeError,
} from "../../lib/index";
import type { CloudflareD1DriverOptions } from "../../lib/drivers/cloudflare-d1";
import {
  CloudflareD1CacheDriver,
  D1_MAX_ENTRY_BYTES,
} from "../../lib/drivers/cloudflare-d1";
import { runCacheDriverConformance } from "../../lib/testing/index";
import { D1_BINDING, startLocalCloudflare } from "../cloudflare/harness";

// A generous per-test timeout: under `bun test --parallel`, any test that
// times out makes Bun SIGTERM the file's workerd (oven-sh/bun#46373), and
// every later test then fails with ECONNREFUSED.
setDefaultTimeout(30_000);

const local = await startLocalCloudflare();
afterAll(async () => {
  await local.stop();
});

/** Each driver's own table prefix, so tests never share rows. */
let serial = 0;

/** A driver on the local Worker, with its own tables. */
function make(
  overrides: Partial<CloudflareD1DriverOptions> = {},
): CloudflareD1CacheDriver {
  return new CloudflareD1CacheDriver({
    endpoint: local.endpoint,
    apiToken: local.token,
    databaseId: D1_BINDING,
    prefix: `t${process.pid}_${++serial}_`,
    ...overrides,
  });
}

/** An entry for the specifics. */
function entry(
  key: string,
  bytes: number[] | Uint8Array,
  tags: readonly string[] = [],
  expiresAt: number | null = null,
): StoredEntry {
  return { key, value: new Uint8Array(bytes), expiresAt, tags };
}

/** Rows of a raw query on the local database. */
async function rows(
  driver: CloudflareD1CacheDriver,
  sql: string,
  ...params: string[]
): Promise<Record<string, unknown>[]> {
  return (await driver.client.d1Query(D1_BINDING, [{ sql, params }]))[0]
    .results;
}

const kitOptions: CloudflareD1DriverOptions = {
  endpoint: local.endpoint,
  apiToken: local.token,
  databaseId: D1_BINDING,
  prefix: `kit${process.pid}_`,
};

await runCacheDriverConformance(
  "cloudflare-d1",
  () => ({
    driver: cloudflareD1Driver(kitOptions),
    rawDump: async () =>
      await local.rawD1(
        ["entries", "tags", "stamps", "locks"].map(
          (table) => `${kitOptions.prefix}${table}`,
        ),
      ),
  }),
  {
    crossProcess: {
      module: new URL("../../lib/drivers/cloudflare-d1.ts", import.meta.url)
        .pathname,
      export: "cloudflareD1Driver",
      options: kitOptions,
    },
  },
);

describe("cloudflareD1Driver: options", () => {
  test("needs a databaseId", () => {
    expect(() => make({ databaseId: "" })).toThrow(/databaseId/);
  });

  test("a prefix must be an SQL identifier; tables take the SQL drivers' rules, without a bus", () => {
    for (const prefix of ["", "1x", "a-b", "x".repeat(49)]) {
      expect(() => make({ prefix })).toThrow(/prefix/);
    }
    expect(() => make({ tables: { bus: "b" } })).toThrow(
      /tables\.bus is not a table this driver has/,
    );
    expect(() => make({ tables: { entries: "x", tags: "x" } })).toThrow(
      /would both be/,
    );
    expect(
      make({ prefix: "app_", tables: { entries: "cache" } }).tables,
    ).toEqual({
      entries: "cache",
      tags: "app_tags",
      stamps: "app_stamps",
      locks: "app_locks",
      bus: "app_bus",
    });
  });

  test("maxEntries must be a positive integer", () => {
    for (const maxEntries of [0, -1, 1.5]) {
      expect(() => make({ maxEntries })).toThrow(/maxEntries/);
    }
  });

  test("advertises SQLite's atomicity, one statement at a time, and no bus", () => {
    expect(make().capabilities).toEqual({
      multiProcess: true,
      ttl: "sweep",
      atomicIncrement: true,
      lock: true,
      tags: "index",
      fence: "atomic",
      bus: "none",
      maxEntryBytes: 1_000_000,
    });
    const driver: CacheDriver = make();
    expect(driver.publish).toBeUndefined();
    expect(driver.subscribe).toBeUndefined();
  });

  test("an unknown binding fails, naming Cloudflare's error", async () => {
    await expect(make({ databaseId: "NOPE" }).get("ns", "k")).rejects.toThrow(
      /404: 7404/,
    );
  });

  test("close stops it", async () => {
    const driver = make();
    await driver.close();
    await expect(driver.get("ns", "k")).rejects.toThrow(/closed/);
  });
});

describe("cloudflareD1Driver: schema", () => {
  test("connect creates the four tables, two indexes and five triggers, idempotently; the names follow `tables`", async () => {
    const driver = make({ tables: { entries: `e${process.pid}_named` } });
    await driver.connect();
    await driver.connect();
    const objects = await rows(
      driver,
      "SELECT type, name FROM sqlite_master WHERE tbl_name IN (SELECT value FROM json_each(?1)) ORDER BY type, name",
      JSON.stringify(Object.values(driver.tables)),
    );
    const names = (type: string) =>
      objects.filter((each) => each.type === type).map((each) => each.name);
    expect(names("table").sort()).toEqual(
      [
        driver.tables.entries,
        driver.tables.tags,
        driver.tables.stamps,
        driver.tables.locks,
      ].sort(),
    );
    expect(names("index")).toContain(`ix_${driver.tables.entries}_exp`);
    expect(names("trigger").length).toBe(5);
    expect(driver.tables.entries).toBe(`e${process.pid}_named`);
  });

  test("syncSchema answers [] (one schema version), and runs on connect when asked", async () => {
    const driver = make({ syncSchema: true });
    await driver.connect();
    expect(await driver.syncSchema({ dryRun: true })).toEqual([]);
    expect(await make().syncSchema()).toEqual([]);
  });
});

describe("cloudflareD1Driver: values and parameters", () => {
  test("every byte value, and an empty value, round-trip through unhex/hex", async () => {
    const driver = make();
    const all = Uint8Array.from({ length: 256 }, (_, index) => index);
    await driver.set("ns", entry("all", all));
    await driver.set("ns", entry("empty", []));
    expect((await driver.get("ns", "all"))?.value).toEqual(all);
    expect((await driver.get("ns", "empty"))?.value).toEqual(new Uint8Array(0));
  });

  test(`${D1_MAX_ENTRY_BYTES} bytes round-trip; one more is refused before it is sent`, async () => {
    const driver = make();
    const max = new Uint8Array(D1_MAX_ENTRY_BYTES).map(
      (_, index) => index % 251,
    );
    await driver.set("ns", entry("max", max));
    expect((await driver.get("ns", "max"))?.value).toEqual(max);
    const before = driver.client.requests;
    await expect(
      driver.set("ns", entry("over", new Uint8Array(D1_MAX_ENTRY_BYTES + 1))),
    ).rejects.toBeInstanceOf(EntryTooLargeError);
    await expect(
      driver.setMany("ns", [
        entry("over", new Uint8Array(D1_MAX_ENTRY_BYTES + 1)),
      ]),
    ).rejects.toBeInstanceOf(EntryTooLargeError);
    expect(driver.client.requests).toBe(before);
  });

  test("numbers and nulls travel as strings: a null expiry, a touch to null and back, a negative counter", async () => {
    const driver = make();
    const now = Date.now();
    await driver.set("ns", entry("k", [1], [], now + 60_000));
    expect((await driver.get("ns", "k"))?.expiresAt).toBe(now + 60_000);
    expect(await driver.touch("ns", "k", null)).toBe(true);
    expect((await driver.get("ns", "k"))?.expiresAt).toBeNull();
    expect(await driver.touch("ns", "k", now + 5_000)).toBe(true);
    expect((await driver.get("ns", "k"))?.expiresAt).toBe(now + 5_000);
    expect(await driver.increment("ns", "c", -3, null)).toBe(-3);
    expect(await driver.increment("ns", "c", 10, null)).toBe(7);
    const typed = await rows(
      driver,
      `SELECT typeof(exp) AS e, typeof(ca) AS c FROM "${driver.tables.entries}" WHERE k = 'k'`,
    );
    expect(typed).toEqual([{ e: "integer", c: "integer" }]);
  });

  test("getMany reads in chunks of ten, in the keys' order, with holes and repeats", async () => {
    const driver = make();
    await driver.setMany(
      "ns",
      Array.from({ length: 25 }, (_, index) => entry(`k${index}`, [index])),
    );
    const keys = [
      ...Array.from({ length: 25 }, (_, index) => `k${24 - index}`),
      "missing",
      "k3",
    ];
    const before = driver.client.requests;
    const read = await driver.getMany("ns", keys);
    expect(driver.client.requests - before).toBe(3);
    expect(read.map((each) => each?.value[0])).toEqual([
      ...Array.from({ length: 25 }, (_, index) => 24 - index),
      undefined,
      3,
    ]);
  });

  test("setMany batches 50 statements a request", async () => {
    const driver = make();
    await driver.connect();
    const before = driver.client.requests;
    await driver.setMany(
      "ns",
      Array.from({ length: 120 }, (_, index) => entry(`k${index}`, [1])),
    );
    expect(driver.client.requests - before).toBe(3);
  });
});

describe("cloudflareD1Driver: the tag index follows entries.tg (triggers)", () => {
  /** The tag rows of a namespace, as `tag:key`. */
  async function tagRows(driver: CloudflareD1CacheDriver): Promise<string[]> {
    return (
      await rows(
        driver,
        `SELECT tag, k FROM "${driver.tables.tags}" WHERE ns = 'ns' ORDER BY tag, k`,
      )
    ).map((each) => `${String(each.tag)}:${String(each.k)}`);
  }

  test("a set adds the rows, a re-tag replaces them, a delete removes them", async () => {
    const driver = make();
    await driver.set("ns", entry("a", [1], ["x", "y"]));
    await driver.set("ns", entry("b", [1], ["y"]));
    expect(await tagRows(driver)).toEqual(["x:a", "y:a", "y:b"]);
    await driver.set("ns", entry("a", [2], ["z"]));
    expect(await tagRows(driver)).toEqual(["y:b", "z:a"]);
    await driver.set("ns", entry("a", [3]));
    expect(await tagRows(driver)).toEqual(["y:b"]);
    expect(await driver.delete("ns", ["b", "b", "missing"])).toBe(1);
    expect(await tagRows(driver)).toEqual([]);
  });

  test("a counter written over a tagged entry takes its tag rows with it", async () => {
    const driver = make();
    await driver.set("ns", entry("k", [1], ["t"]));
    await driver.increment("ns", "k", 1, null);
    expect(await tagRows(driver)).toEqual([]);
    expect(await driver.deleteByTags("ns", ["t"], Date.now() + 60_000)).toBe(0);
    expect((await driver.getCounter("ns", "k"))?.value).toBe(1);
  });

  test("an invalidation deletes the tagged entries and their rows in one statement, and counts them", async () => {
    const driver = make();
    await driver.set("ns", entry("a", [1], ["t"]));
    await driver.set("ns", entry("b", [1], ["t", "u"]));
    await driver.set("ns", entry("c", [1], ["u"]));
    await driver.set("other", entry("a", [1], ["t"]));
    expect(await driver.deleteByTags("ns", ["t"], Date.now() + 60_000)).toBe(2);
    expect(await tagRows(driver)).toEqual(["u:c"]);
    expect(await driver.get("other", "a")).toBeDefined();
  });

  test("a stamp is an invalidation here: setStamps deletes the tag's entries too", async () => {
    const driver = make();
    await driver.set("ns", entry("a", [1], ["t"]));
    await driver.setStamps("ns", ["t"], Date.now(), Date.now() + 60_000);
    expect(await driver.get("ns", "a")).toBeUndefined();
  });
});

describe("cloudflareD1Driver: the fence, one statement", () => {
  test("refuses a load older than its tag's stamp, stores a newer one, and ignores a lapsed stamp", async () => {
    let now = Date.now();
    const driver = make({ now: () => now });
    await driver.deleteByTags("ns", ["t"], now + 60_000);
    expect(
      await driver.set("ns", entry("k", [1], ["t"]), {
        tags: ["t"],
        createdAt: now - 1,
      }),
    ).toBe("fenced");
    expect(await driver.get("ns", "k")).toBeUndefined();
    expect(
      await driver.set("ns", entry("k", [2], ["t"]), {
        tags: ["t"],
        createdAt: now + 1,
      }),
    ).toBe("stored");
    now += 60_001;
    expect(
      await driver.set("ns", entry("old", [3], ["t"]), {
        tags: ["t"],
        createdAt: 0,
      }),
    ).toBe("stored");
  });

  /**
   * The race (§3.6): a write of a load that started before an invalidation,
   * sent at the same moment as the invalidation. Afterwards the entry must
   * not exist — fenced, or written and then deleted. The spike measured 0 of
   * 60 survivors for the one-statement fence and 60 of 60 for a check, then a
   * write; the control below keeps proving the test can tell them apart.
   */
  async function race(
    driver: CloudflareD1CacheDriver,
    write: (ns: string, createdAt: number) => Promise<unknown>,
    rounds: number,
  ): Promise<number> {
    let survivors = 0;
    for (let round = 0; round < rounds; round++) {
      const ns = `race${round}`;
      const createdAt = Date.now();
      await Promise.all([
        write(ns, createdAt),
        (async () => {
          await Bun.sleep(round % 2);
          await driver.deleteByTags(ns, ["g"], Date.now() + 60_000);
        })(),
      ]);
      if ((await driver.get(ns, "k")) !== undefined) {
        survivors++;
      }
    }
    return survivors;
  }

  test("a pre-invalidation write never survives a concurrent invalidation (60 rounds)", async () => {
    const driver = make();
    await driver.connect();
    const survivors = await race(
      driver,
      async (ns, createdAt) =>
        await driver.set(ns, entry("k", [1], ["g"]), {
          tags: ["g"],
          createdAt,
        }),
      60,
    );
    expect(survivors).toBe(0);
  });

  test("the control: a check, then a write, in two requests, loses that race", async () => {
    const driver = make();
    await driver.connect();
    const survivors = await race(
      driver,
      async (ns, createdAt) => {
        const [hit] = await rows(
          driver,
          `SELECT 1 AS hit FROM "${driver.tables.stamps}" WHERE ns = ?1 AND tag = 'g' AND at >= ?2`,
          ns,
          String(createdAt),
        );
        await Bun.sleep(createdAt % 3);
        if (hit === undefined) {
          await driver.set(ns, entry("k", [1], ["g"]));
        }
      },
      30,
    );
    expect(survivors).toBeGreaterThan(0);
  });
});

describe("cloudflareD1Driver: locks and counters across contenders", () => {
  test("50 contenders on a free lock: one winner; a lapsed lock is taken over; release needs the owner", async () => {
    let now = Date.now();
    const driver = make({ now: () => now });
    const won = await Promise.all(
      Array.from(
        { length: 50 },
        async (_, index) =>
          await driver.acquireLock("ns", "k", `o${index}`, 10_000),
      ),
    );
    expect(won.filter(Boolean).length).toBe(1);
    const winner = `o${won.indexOf(true)}`;
    expect(await driver.releaseLock("ns", "k", "someone-else")).toBe(false);
    now += 10_001;
    expect(await driver.acquireLock("ns", "k", "late", 10_000)).toBe(true);
    expect(await driver.releaseLock("ns", "k", winner)).toBe(false);
    expect(await driver.releaseLock("ns", "k", "late")).toBe(true);
  });

  test("an expired counter restarts with its new expiry", async () => {
    let now = Date.now();
    const driver = make({ now: () => now });
    expect(await driver.increment("ns", "c", 5, now + 1_000)).toBe(5);
    expect(await driver.increment("ns", "c", 1, now + 99_000)).toBe(6);
    expect((await driver.getCounter("ns", "c"))?.expiresAt).toBe(now + 1_000);
    now += 1_001;
    expect(await driver.getCounter("ns", "c")).toBeUndefined();
    expect(await driver.increment("ns", "c", 2, now + 5_000)).toBe(2);
    expect((await driver.getCounter("ns", "c"))?.expiresAt).toBe(now + 5_000);
  });
});

describe("cloudflareD1Driver: clear and the sweeper", () => {
  test("clear empties the namespace's entries, tag rows, stamps and locks, and nothing else", async () => {
    const driver = make();
    await driver.set("ns", entry("k", [1], ["t"]));
    await driver.setStamps("ns", ["s"], 1, Date.now() + 60_000);
    await driver.acquireLock("ns", "l", "o", 60_000);
    await driver.set("other", entry("k", [2], ["t"]));
    await driver.clear("ns");
    expect(await driver.get("ns", "k")).toBeUndefined();
    expect((await driver.getStamps("ns", ["s"])).size).toBe(0);
    expect(await driver.acquireLock("ns", "l", "p", 60_000)).toBe(true);
    expect((await driver.get("other", "k"))?.value).toEqual(
      new Uint8Array([2]),
    );
    expect(
      await rows(
        driver,
        `SELECT k FROM "${driver.tables.tags}" WHERE ns = 'ns'`,
      ),
    ).toEqual([]);
  });

  test("sweep deletes expired entries and counters (up to the limit), lapsed stamps and locks, with their tag rows", async () => {
    let now = Date.now();
    const driver = make({ now: () => now });
    for (let index = 0; index < 5; index++) {
      await driver.set("ns", entry(`dead${index}`, [1], ["t"], now + 1_000));
    }
    await driver.set("ns", entry("live", [1], ["t"], now + 60_000));
    await driver.increment("ns", "c", 1, now + 1_000);
    await driver.setStamps("ns", ["s"], now, now + 1_000);
    await driver.acquireLock("ns", "l", "o", 1_000);
    now += 1_001;
    expect(await driver.sweep(now, 4)).toBe(4);
    expect(await driver.sweep(now, 100)).toBe(2);
    expect(await driver.sweep(now, 100)).toBe(0);
    expect((await driver.get("ns", "live"))?.value).toEqual(
      new Uint8Array([1]),
    );
    expect(
      await rows(
        driver,
        `SELECT k FROM "${driver.tables.tags}" WHERE ns = 'ns'`,
      ),
    ).toEqual([{ k: "live" }]);
    expect(
      await rows(driver, `SELECT count(*) AS c FROM "${driver.tables.stamps}"`),
    ).toEqual([{ c: 0 }]);
    expect(
      await rows(driver, `SELECT count(*) AS c FROM "${driver.tables.locks}"`),
    ).toEqual([{ c: 0 }]);
  });

  test("maxEntries: the sweep evicts nearest to expiry first, then the oldest unexpiring, never counters, and reports each", async () => {
    let now = Date.now();
    const driver = make({ now: () => now, maxEntries: 3 });
    const evicted: string[] = [];
    driver.onEviction((ns, key, reason) =>
      evicted.push(`${ns}/${key}/${reason}`),
    );
    // The counters are the oldest rows with no expiry, so a cap that counted
    // them, or chose among them, would show it.
    for (let index = 0; index < 5; index++) {
      await driver.increment("c", `n${index}`, 1, null);
    }
    now++;
    await driver.set("a", entry("late", [1], [], now + 90_000));
    now++;
    await driver.set("a", entry("soon", [1], ["t"], now + 10_000));
    now++;
    await driver.set("b", entry("old", [1]));
    now++;
    await driver.set("b", entry("new", [1]));
    now++;
    await driver.set("b", entry("newest", [1]));
    expect(await driver.sweep(now, 1)).toBe(0);
    expect(evicted).toEqual(["a/soon/cap"]);
    await driver.sweep(now, 100);
    expect(evicted).toEqual(["a/soon/cap", "a/late/cap"]);
    expect(await driver.get("b", "old")).toBeDefined();
    await driver.set("b", entry("fourth", [1]));
    await driver.sweep(now, 100);
    expect(evicted).toEqual(["a/soon/cap", "a/late/cap", "b/old/cap"]);
    for (let index = 0; index < 5; index++) {
      expect((await driver.getCounter("c", `n${index}`))?.value).toBe(1);
    }
    expect(
      await rows(
        driver,
        `SELECT k FROM "${driver.tables.tags}" WHERE ns = 'a'`,
      ),
    ).toEqual([]);
  });

  test("the core's evict event reports a cap eviction", async () => {
    let now = Date.now();
    const driver = make({ now: () => now, maxEntries: 1 });
    const cache = createCache({ driver, now: () => now, sweepInterval: 0 });
    const events: string[] = [];
    cache.on("evict", (event) => events.push(`${event.key}:${event.reason}`));
    await cache.set("a", 1);
    now++;
    await cache.set("b", 2);
    await driver.sweep(now, 100);
    expect(events).toEqual(["a:cap"]);
    await cache.close();
  });
});

describe("cloudflareD1Driver under the core", () => {
  test("increment, invalidateTags and getOrSet with a cross-process lock", async () => {
    const cache = createCache({ driver: make() });
    expect(await cache.increment("hits", 5)).toBe(5);
    expect(await cache.decrement("hits", 2)).toBe(3);
    await cache.set("user:1", { name: "Ada" }, { tags: ["users"] });
    await cache.invalidateTags(["users"]);
    expect(await cache.get("user:1")).toBeUndefined();
    let loads = 0;
    const values = await Promise.all(
      Array.from(
        { length: 5 },
        async () =>
          await cache.getOrSet(
            "report",
            async () => {
              loads++;
              await Bun.sleep(30);
              return 42;
            },
            { lock: true },
          ),
      ),
    );
    expect(values).toEqual([42, 42, 42, 42, 42]);
    expect(loads).toBe(1);
    await cache.close();
  });
});
