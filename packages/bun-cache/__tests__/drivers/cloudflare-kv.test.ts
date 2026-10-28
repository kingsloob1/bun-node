/**
 * The Cloudflare KV driver (plan Status: PR-C10), against real KV in workerd:
 * the shipped Worker run by miniflare (`../cloudflare/harness.ts`), on port
 * 0, in memory — no account and no environment variable, so it always runs.
 * The conformance kit with its two-process pass, then the driver's
 * specifics, the core over it, and KV's write rate (Cloudflare's 429 on a
 * second write to a key within a second, which workerd does not reproduce)
 * through the tests' front.
 *
 * The REST API transport and Cloudflare's own KV run in the opt-in live lane,
 * `cloudflare-kv-live.test.ts`.
 */
import {
  afterAll,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { createTestLogger } from "@kingsleyweb/bun-common";
import type { CacheDriver, StoredEntry } from "../../lib/index";
import {
  cloudflareKvDriver,
  createCache,
  UnsupportedOperationError,
} from "../../lib/index";
import type { CloudflareKvDriverOptions } from "../../lib/drivers/cloudflare-kv";
import {
  CloudflareKvCacheDriver,
  decodeKvEntry,
  encodeKvEntry,
} from "../../lib/drivers/cloudflare-kv";
import { runCacheDriverConformance } from "../../lib/testing/index";
import { KV_BINDING, startLocalCloudflare } from "../cloudflare/harness";

// A generous per-test timeout: under `bun test --parallel`, any test that
// times out makes Bun SIGTERM the file's workerd (started at the top level by
// miniflare), and every later test then fails with ECONNREFUSED
// (oven-sh/bun#46373; measured on a machine at load 38, where the 1,050-key
// `clear` test passed 5 s). Remove once Bun stops killing processes the
// timed-out test did not start.
setDefaultTimeout(30_000);

const local = await startLocalCloudflare();
const limited = await startLocalCloudflare({ kvWriteRate: true });
afterAll(async () => {
  await local.stop();
  await limited.stop();
});

/** This run's prefix: every key the file writes is under it. */
const RUN = `bun-cache-test/${process.pid}-${Date.now()}`;

/** A driver on the local Worker, under its own prefix. */
function make(
  name: string,
  overrides: Partial<CloudflareKvDriverOptions> = {},
  server = local,
): CloudflareKvCacheDriver {
  return new CloudflareKvCacheDriver({
    endpoint: server.endpoint,
    apiToken: server.token,
    namespaceId: KV_BINDING,
    prefix: `${RUN}/${name}`,
    ...overrides,
  });
}

/** An entry for the specifics. */
function entry(
  key: string,
  bytes: number[],
  tags: readonly string[] = [],
  expiresAt: number | null = null,
): StoredEntry {
  return { key, value: new Uint8Array(bytes), expiresAt, tags };
}

/** The hex SHA-256 of a name, as the driver's keys use it. */
function sha(name: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(name);
  return hasher.digest("hex");
}

/** Every KV key under a prefix, with its expiry (epoch seconds), through the Worker's listing. */
async function listed(
  prefix: string,
): Promise<{ name: string; expiration?: number }[]> {
  const response = await fetch(
    `${local.endpoint}/storage/kv/namespaces/${KV_BINDING}/keys?prefix=${encodeURIComponent(prefix)}`,
    { headers: { authorization: `Bearer ${local.token}` } },
  );
  return (
    (await response.json()) as {
      result: { name: string; expiration?: number }[];
    }
  ).result;
}

const kitOptions: CloudflareKvDriverOptions = {
  endpoint: local.endpoint,
  apiToken: local.token,
  namespaceId: KV_BINDING,
  prefix: `${RUN}/kit`,
};

await runCacheDriverConformance(
  "cloudflare-kv",
  () => ({ driver: cloudflareKvDriver(kitOptions) }),
  {
    crossProcess: {
      module: new URL("../../lib/drivers/cloudflare-kv.ts", import.meta.url)
        .pathname,
      export: "cloudflareKvDriver",
      options: kitOptions,
    },
  },
);

describe("cloudflareKvDriver: options", () => {
  test("needs a namespaceId", () => {
    expect(
      () =>
        new CloudflareKvCacheDriver({
          endpoint: local.endpoint,
          apiToken: local.token,
          namespaceId: "",
        }),
    ).toThrow(/namespaceId/);
  });

  test("refuses an empty, absolute or over-long prefix, and drops a trailing /", () => {
    for (const prefix of ["", "/abs", "x".repeat(201)]) {
      expect(() => make("p", { prefix })).toThrow(/prefix/);
    }
    expect(make("p", { prefix: "app/" }).prefix).toBe("app");
    expect(
      new CloudflareKvCacheDriver({
        endpoint: local.endpoint,
        apiToken: local.token,
        namespaceId: KV_BINDING,
      }).prefix,
    ).toBe("bun-cache");
  });

  test("advertises KV's honest capabilities: native expiry, stamps, no counters, locks or bus", () => {
    expect(make("caps").capabilities).toEqual({
      multiProcess: true,
      ttl: "native",
      atomicIncrement: false,
      lock: false,
      tags: "stamps",
      fence: "atomic",
      bus: "none",
      maxEntryBytes: 24 * 1024 * 1024,
    });
    const driver: CacheDriver = make("caps");
    expect(driver.increment).toBeUndefined();
    expect(driver.acquireLock).toBeUndefined();
    expect(driver.sweep).toBeUndefined();
    expect(driver.publish).toBeUndefined();
  });

  test("a wrong secret fails, naming the status and Cloudflare's error", async () => {
    const driver = make("auth", { apiToken: "wrong" });
    await expect(driver.get("ns", "k")).rejects.toThrow(
      /401: 10000 Authentication error/,
    );
    await expect(driver.connect()).rejects.toThrow(/401/);
  });

  test("an unknown binding fails rather than reading as a miss", async () => {
    await expect(
      make("nb", { namespaceId: "NOPE" }).get("ns", "k"),
    ).rejects.toThrow(/404: 10013/);
  });

  test("connect checks the namespace answers; close stops it", async () => {
    const driver = make("life");
    await driver.connect();
    await driver.connect();
    await driver.close();
    await expect(driver.get("ns", "k")).rejects.toThrow(/closed/);
  });
});

describe("cloudflareKvDriver: layout and frame", () => {
  test("entries under <p>/<ns>/e/<sha256(key)>, stamps under s/<sha256(tag)>, the namespace encoded", async () => {
    const driver = make("layout");
    await driver.set("Ns/1", entry("user:1", [1, 2, 3], ["t"]));
    await driver.setStamps("Ns/1", ["t"], Date.now(), Date.now() + 60_000);
    const names = (await listed(`${driver.prefix}/`)).map((each) => each.name);
    expect(names.sort()).toEqual(
      [
        `${driver.prefix}/^ns~2f1/e/${sha("user:1")}`,
        `${driver.prefix}/^ns~2f1/s/${sha("t")}`,
      ].sort(),
    );
  });

  test("the frame round-trips expiry, tags and every byte value, and refuses foreign bytes", () => {
    const bytes = Array.from({ length: 256 }, (_, index) => index);
    const written = entry("k", bytes, ["a", "ünïcode"], 1_760_000_000_123);
    expect(decodeKvEntry("k", encodeKvEntry(written))).toEqual(written);
    expect(decodeKvEntry("k", encodeKvEntry(entry("k", [])))).toEqual(
      entry("k", []),
    );
    expect(decodeKvEntry("k", new Uint8Array([1, 2, 3]))).toBeUndefined();
    const truncated = encodeKvEntry(entry("k", [], ["tag"])).slice(0, 16);
    expect(decodeKvEntry("k", truncated)).toBeUndefined();
  });

  test("a value of foreign bytes under an entry key reads as a miss", async () => {
    const driver = make("foreign");
    await driver.client.kvPut(
      KV_BINDING,
      `${driver.prefix}/ns/e/${sha("k")}`,
      "not a frame",
      null,
      Date.now(),
    );
    expect(await driver.get("ns", "k")).toBeUndefined();
  });

  test("a long key stays a short KV key", async () => {
    const driver = make("long");
    const key = "k".repeat(5_000);
    await driver.set("ns", entry(key, [9]));
    expect((await driver.get("ns", key))?.value).toEqual(new Uint8Array([9]));
  });
});

describe("cloudflareKvDriver: expiry", () => {
  test("KV's 60 s floor: a 2 s entry is written with expiration ≥ 60 s ahead, and reads as a miss once its own expiry passes", async () => {
    const driver = make("floor");
    const before = Math.floor(Date.now() / 1000);
    await driver.set("ns", entry("short", [1], [], Date.now() + 2_000));
    const [key] = await listed(`${driver.prefix}/ns/e/`);
    expect(key.expiration).toBeGreaterThanOrEqual(before + 60);
    expect(key.expiration).toBeLessThanOrEqual(before + 62);
    expect((await driver.get("ns", "short"))?.value).toEqual(
      new Uint8Array([1]),
    );
    await Bun.sleep(2_100);
    expect(await driver.get("ns", "short")).toBeUndefined();
  });

  test("a long expiry is passed as it is, rounded up to the second", async () => {
    const driver = make("long-ttl");
    const now = Date.now();
    await driver.set("ns", entry("k", [1], [], now + 3_600_500));
    const [key] = await listed(`${driver.prefix}/ns/e/`);
    const expected = Math.floor(now / 1000) + 3601;
    expect(Math.abs((key.expiration ?? 0) - expected)).toBeLessThanOrEqual(1);
  });

  test("no expiry writes none", async () => {
    const driver = make("no-ttl");
    await driver.set("ns", entry("k", [1]));
    const [key] = await listed(`${driver.prefix}/ns/e/`);
    expect(key.expiration).toBeUndefined();
  });

  test("the driver's clock decides a read's expiry", async () => {
    let now = Date.now();
    const driver = make("clock", { now: () => now });
    await driver.set("ns", entry("k", [1], [], now + 120_000));
    expect(await driver.get("ns", "k")).toBeDefined();
    now += 120_000;
    expect(await driver.get("ns", "k")).toBeUndefined();
  });
});

describe("cloudflareKvDriver: entries", () => {
  test("setMany is one bulk write, and stores bytes exactly", async () => {
    const driver = make("bulk");
    const before = driver.client.requests;
    const entries = Array.from({ length: 150 }, (_, index) =>
      entry(
        `k${index}`,
        [index % 256, 0, 255],
        [`t${index % 3}`],
        Date.now() + 120_000,
      ),
    );
    await driver.setMany("ns", entries);
    expect(driver.client.requests - before).toBe(1);
    const read = await driver.getMany(
      "ns",
      entries.map((each) => each.key),
    );
    expect(read).toEqual(entries);
  });

  test("delete counts each key once, missing and repeated keys included", async () => {
    const driver = make("delete");
    await driver.setMany("ns", [entry("a", [1]), entry("b", [2])]);
    expect(await driver.delete("ns", ["a", "a", "b", "missing"])).toBe(2);
    expect(await driver.delete("ns", ["a"])).toBe(0);
    expect(await driver.delete("ns", [])).toBe(0);
  });

  test("clear pages through more than one listing page and keeps stamps and other namespaces", async () => {
    const driver = make("clear");
    await driver.setMany(
      "ns",
      Array.from({ length: 1_050 }, (_, index) => entry(`k${index}`, [1])),
    );
    await driver.set("other", entry("k", [2]));
    await driver.setStamps("ns", ["t"], 1, Date.now() + 60_000);
    await driver.clear("ns");
    expect(await listed(`${driver.prefix}/ns/e/`)).toEqual([]);
    expect((await driver.getStamps("ns", ["t"])).get("t")).toBe(1);
    expect((await driver.get("other", "k"))?.value).toEqual(
      new Uint8Array([2]),
    );
  });
});

describe("cloudflareKvDriver: stamps", () => {
  test("a stamp only moves forward, in time and in lifetime", async () => {
    const driver = make("stamps");
    const now = Date.now();
    await driver.setStamps("ns", ["t"], now, now + 60_000);
    await driver.setStamps("ns", ["t"], now - 5_000, now + 30_000);
    expect((await driver.getStamps("ns", ["t"])).get("t")).toBe(now);
    await driver.setStamps("ns", ["t"], now + 1, now + 30_000);
    expect((await driver.getStamps("ns", ["t"])).get("t")).toBe(now + 1);
    const [key] = await listed(`${driver.prefix}/ns/s/`);
    expect(key.expiration).toBeGreaterThanOrEqual(
      Math.floor((now + 60_000) / 1000),
    );
  });

  test("a lapsed stamp is not answered", async () => {
    let now = Date.now();
    const driver = make("lapsed", { now: () => now });
    await driver.setStamps("ns", ["t"], now, now + 70_000);
    now += 70_000;
    expect((await driver.getStamps("ns", ["t"])).has("t")).toBe(false);
  });

  test("more than 100 tags read back in pages of 100", async () => {
    const driver = make("many-tags");
    const tags = Array.from({ length: 230 }, (_, index) => `t${index}`);
    const at = Date.now();
    await driver.setStamps("ns", tags, at, at + 60_000);
    const before = driver.client.requests;
    const stamps = await driver.getStamps("ns", [...tags, "unset"]);
    expect(driver.client.requests - before).toBe(3);
    expect(stamps.size).toBe(230);
    expect(stamps.has("unset")).toBe(false);
  });

  test("an unchanged stamp is not rewritten", async () => {
    const driver = make("same");
    const at = Date.now();
    await driver.setStamps("ns", ["t"], at, at + 60_000);
    const before = driver.client.requests;
    await driver.setStamps("ns", ["t"], at, at + 60_000);
    expect(driver.client.requests - before).toBe(1);
  });
});

describe("cloudflareKvDriver: KV's write rate (the tests' front answers 429 to a second write within a second)", () => {
  test("a second set of one key within a second is retried after Retry-After and lands", async () => {
    await limited.reset();
    const driver = make("rate", {}, limited);
    await driver.set("ns", entry("hot", [1]));
    const started = Date.now();
    await driver.set("ns", entry("hot", [2]));
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect((await driver.get("ns", "hot"))?.value).toEqual(new Uint8Array([2]));
    expect(driver.client.rateLimited).toBe(1);
    expect((await limited.stats()).refused).toBe(1);
  });

  test("two invalidations of one tag within a second both land, the later kept", async () => {
    await limited.reset();
    const driver = make("rate-stamps", {}, limited);
    const at = Date.now();
    await driver.setStamps("ns", ["t"], at, at + 60_000);
    await driver.setStamps("ns", ["t"], at + 10, at + 60_000);
    expect((await driver.getStamps("ns", ["t"])).get("t")).toBe(at + 10);
    expect(driver.client.rateLimited).toBe(1);
  });

  test("a bulk write naming a hot key is retried whole", async () => {
    await limited.reset();
    const driver = make("rate-bulk", {}, limited);
    await driver.set("ns", entry("a", [1]));
    await driver.setMany("ns", [entry("a", [2]), entry("b", [3])]);
    expect(
      (await driver.getMany("ns", ["a", "b"])).map((each) => each?.value),
    ).toEqual([new Uint8Array([2]), new Uint8Array([3])]);
    expect(driver.client.rateLimited).toBe(1);
  });
});

describe("cloudflareKvDriver under the core", () => {
  test("get, set, tags through stamps, and a namespace", async () => {
    const cache = createCache({ driver: make("core"), tagStampCacheMs: 0 });
    await cache.set(
      "user:1",
      { name: "Ada" },
      { ttl: 120_000, tags: ["users"] },
    );
    expect(await cache.get("user:1")).toEqual({ name: "Ada" });
    await cache.invalidateTags(["users"]);
    expect(await cache.get("user:1")).toBeUndefined();
    const other = cache.namespace("other");
    await other.set("user:1", 2);
    expect(await other.get("user:1")).toBe(2);
    await cache.close();
  });

  test("a TTL under KV's 60 s floor is still exact", async () => {
    const cache = createCache({ driver: make("core-ttl") });
    await cache.set("k", "v", { ttl: 300 });
    expect(await cache.get("k")).toBe("v");
    await Bun.sleep(400);
    expect(await cache.get("k")).toBeUndefined();
    await cache.close();
  });

  test("increment is unsupported, even under the default failure policy", async () => {
    const cache = createCache({ driver: make("core-incr") });
    await expect(cache.increment("hits")).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
    await cache.close();
  });

  test("getOrSet with a lock warns once and still single-flights in process", async () => {
    const { logger, events } = createTestLogger();
    const cache = createCache({ driver: make("core-lock"), logger });
    let loads = 0;
    const load = async (): Promise<number> => {
      loads++;
      await Bun.sleep(50);
      return 7;
    };
    const values = await Promise.all(
      Array.from(
        { length: 10 },
        async () =>
          await cache.getOrSet("k", load, { lock: true, ttl: 120_000 }),
      ),
    );
    expect(values).toEqual(Array.from({ length: 10 }, () => 7));
    expect(loads).toBe(1);
    await cache.getOrSet("k2", load, { lock: true, ttl: 120_000 });
    expect(events.filter((event) => event.level === "warn").length).toBe(1);
    await cache.close();
  });

  test("the core never schedules a sweep: KV expires keys itself", async () => {
    const driver = make("core-sweep");
    const spy = spyOn(globalThis, "setInterval");
    const cache = createCache({ driver, sweepInterval: 10 });
    await cache.set("k", 1);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    await cache.close();
  });
});
