/**
 * The L1 tier over a shared L2 (plan §4.1, §4.3, R13, R14), in one process:
 * two caches on one memory driver stand for two processes on one shared
 * store, each with its own L1, kept coherent by the driver's bus (the memory
 * driver's is in-process and synchronous) or by a test hub. The two-process
 * version, over real buses, is `crossprocess.test.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type {
  Cache,
  CacheDriver,
  CacheEventMap,
  CreateCacheOptions,
} from "../../lib/index";
import { createCache, fileDriver, memoryDriver } from "../../lib/index";
import type { FakeClock } from "../../lib/testing/index";
import { fakeClock } from "../../lib/testing/index";
import { testSchema } from "../helpers";
import { busHub, countingDriver, gate, gatedDriver, waitFor } from "./helpers";

/** Caches a test opened, closed after it. */
const opened: Cache[] = [];

afterEach(async () => {
  for (const cache of opened.splice(0)) {
    await cache.close();
  }
});

/**
 * A cache on `driver` with an L1, the sweeper off; closed after the test.
 * Resolves once its L1 is armed — with a bus, when the subscription holds
 * (its first flush).
 */
async function tiered(
  driver: CacheDriver,
  options: Partial<CreateCacheOptions> = {},
): Promise<Cache> {
  const cache = createCache({
    driver,
    l1: true,
    sweepInterval: 0,
    ...options,
  });
  opened.push(cache);
  if (options.bus !== false) {
    await waitFor(
      "the bus subscription",
      () => (cache.stats().l1?.flushes ?? 0) >= 1,
    );
  }
  return cache;
}

/** Records which tier served each `hit`. */
function hitTiers(cache: Cache): CacheEventMap["hit"]["tier"][] {
  const tiers: CacheEventMap["hit"]["tier"][] = [];
  cache.on("hit", (hit) => {
    tiers.push(hit.tier);
  });
  return tiers;
}

/** Two caches, "processes" A and B, on one memory driver, each with its own L1, on one fake clock. */
async function twoProcesses(
  options: Partial<CreateCacheOptions> = {},
): Promise<{
  /** The writer. */
  a: Cache;
  /** The reader. */
  b: Cache;
  /** The clock both run on. */
  clock: FakeClock;
  /** The shared L2, counting reads. */
  driver: ReturnType<typeof countingDriver>;
}> {
  const clock = fakeClock();
  const driver = countingDriver(memoryDriver({ now: clock.now }));
  const a = await tiered(driver, { now: clock.now, ...options });
  const b = await tiered(driver, { now: clock.now, ...options });
  return { a, b, clock, driver };
}

describe("L1 reads (§4.1)", () => {
  test("a hit is served from L1 without an L2 read, and says so", async () => {
    const { a, driver } = await twoProcesses();
    const tiers = hitTiers(a);
    await a.set("k", { n: 1 });
    const before = driver.reads();
    expect(await a.get("k")).toEqual({ n: 1 });
    expect(await a.get("k")).toEqual({ n: 1 });
    expect(driver.reads()).toBe(before);
    expect(tiers).toEqual(["l1", "l1"]);
    expect(a.stats().l1).toMatchObject({ hits: 2, misses: 0, entries: 1 });
    expect(a.stats().hits).toBe(2);
  });

  test("an L2 hit backfills L1; the next read is L1's", async () => {
    const { a, b, driver } = await twoProcesses();
    const tiers = hitTiers(b);
    await a.set("k", "v");
    expect(await b.get("k")).toBe("v");
    const reads = driver.reads();
    expect(await b.get("k")).toBe("v");
    expect(driver.reads()).toBe(reads);
    expect(tiers).toEqual(["l2", "l1"]);
    expect(b.stats().l1).toMatchObject({ backfills: 1, misses: 1, hits: 1 });
  });

  test("backfill keeps the L2 entry's expiry, never a fresh TTL (R14)", async () => {
    const { a, b, clock } = await twoProcesses({ l1: { ttl: 60_000 } });
    await a.set("k", "v", { ttl: 1_000 });
    clock.advance(900);
    expect(await b.get("k")).toBe("v"); // backfilled with 100 ms left
    clock.advance(99);
    const tiers = hitTiers(b);
    expect(await b.get("k")).toBe("v");
    expect(tiers).toEqual(["l1"]);
    clock.advance(2);
    expect(await b.get("k")).toBeUndefined();
  });

  test("L1 never serves a stale value; the stale window is L2's", async () => {
    const { a, b, clock } = await twoProcesses();
    await a.set("k", "v", { ttl: 1_000, staleWhileRevalidate: 5_000 });
    expect(await b.get("k")).toBe("v");
    clock.advance(1_001);
    const tiers = hitTiers(b);
    // Stale: a miss for `get`, a stale entry for `getEntry` — read from L2.
    expect(await b.get("k")).toBeUndefined();
    const entry = await b.getEntry("k");
    expect(entry?.stale).toBe(true);
    expect(tiers).toEqual([]);
    expect(b.stats().l1?.hits).toBe(0);
  });

  test("l1.ttl bounds how long a copy is held (the staleness bound without a bus, §4.3)", async () => {
    const { a, b, clock } = await twoProcesses({
      bus: false,
      l1: { ttl: 500 },
    });
    await a.set("k", "v1");
    expect(await b.get("k")).toBe("v1");
    await a.set("k", "v2");
    // No bus: B is not told, and serves its copy …
    expect(await b.get("k")).toBe("v1");
    clock.advance(499);
    expect(await b.get("k")).toBe("v1");
    // … until l1.ttl.
    clock.advance(1);
    expect(await b.get("k")).toBe("v2");
  });

  test("getMany answers from both tiers, in order", async () => {
    const { a, b, driver } = await twoProcesses();
    await a.setMany([
      ["x", 1],
      ["y", 2],
    ]);
    expect(await b.get("x")).toBe(1); // x is in B's L1, y is not
    const tiers = hitTiers(b);
    const reads = driver.reads();
    expect(await b.getMany(["x", "missing", "y"])).toEqual([1, undefined, 2]);
    expect(tiers).toEqual(["l1", "l2"]);
    // Only the keys L1 could not answer reached L2 (the missing key's counter
    // probe is one more `get`).
    expect(driver.reads() - reads).toBe(3);
    const after = driver.reads();
    expect(await b.getMany(["x", "y"])).toEqual([1, 2]);
    expect(driver.reads()).toBe(after);
  });

  test("counters never enter L1 (§3.8)", async () => {
    const { a, b } = await twoProcesses();
    await a.increment("hits", 5);
    const tiers = hitTiers(b);
    expect(await b.get("hits")).toBe(5);
    expect(await b.get("hits")).toBe(5);
    expect(tiers).toEqual(["l2", "l2"]);
    expect(b.stats().l1?.entries).toBe(0);
    await a.increment("hits");
    expect(await b.get("hits")).toBe(6);
  });

  test("the LRU caps evict, counted in l1.evictions", async () => {
    const { a } = await twoProcesses({ l1: { maxEntries: 2 } });
    await a.set("one", 1);
    await a.set("two", 2);
    expect(await a.get("one")).toBe(1); // "two" is now the oldest
    await a.set("three", 3);
    const tiers = hitTiers(a);
    expect(await a.get("one")).toBe(1);
    expect(await a.get("two")).toBe(2);
    expect(tiers).toEqual(["l1", "l2"]);
    expect(a.stats().l1?.evictions).toBeGreaterThanOrEqual(1);

    const bytes = (await twoProcesses({ l1: { maxBytes: 100 } })).a;
    await bytes.set("big", "x".repeat(200));
    expect(bytes.stats().l1?.entries).toBe(0);
    await bytes.set("small", "x".repeat(10));
    expect(bytes.stats().l1).toMatchObject({ entries: 1 });
    expect(bytes.stats().l1!.bytes).toBeLessThanOrEqual(100);
  });

  test("an l1 option that is not positive throws", () => {
    expect(() =>
      createCache({ driver: memoryDriver(), l1: { ttl: 0 } }),
    ).toThrow(RangeError);
    expect(() =>
      createCache({ driver: memoryDriver(), l1: { maxEntries: -1 } }),
    ).toThrow(RangeError);
  });
});

describe("what L1 holds (§4.1)", () => {
  test("a write stores the decoded value — what an L2 read gives, not the caller's object", async () => {
    const { a } = await twoProcesses({ codec: "json" });
    const value = { at: new Date(0), list: [1] };
    await a.set("k", value);
    value.list.push(2);
    const tiers = hitTiers(a);
    const got = (await a.get("k")) as { at: unknown; list: number[] };
    expect(tiers).toEqual(["l1"]);
    expect(got.at).toBe("1970-01-01T00:00:00.000Z");
    expect(got.list).toEqual([1]);
  });

  test("clone: false (the default) shares the held object between hits", async () => {
    const { a } = await twoProcesses();
    await a.set("k", { n: 1 });
    const first = (await a.get("k")) as { n: number };
    first.n = 99;
    expect(await a.get("k")).toBe(first);
    expect(await a.get("k")).toEqual({ n: 99 });
  });

  test("clone: true returns a copy per hit, so a caller cannot mutate L1's", async () => {
    const { a, b } = await twoProcesses({ l1: { clone: true } });
    await a.set("k", { n: 1 });
    const first = (await a.get("k")) as { n: number };
    first.n = 99;
    expect(await a.get("k")).toEqual({ n: 1 });
    expect(await a.get("k")).not.toBe(await a.get("k"));
    // The backfilling read's own value is not L1's copy either.
    const read = (await b.get("k")) as { n: number };
    read.n = 7;
    expect(await b.get("k")).toEqual({ n: 1 });
  });

  test("a key `validate` covers is not copied on write; the next read validates it in", async () => {
    const schema = testSchema((value) =>
      typeof value === "number" ? undefined : "not a number",
    );
    const { a } = await twoProcesses({ validate: { "n:*": schema } });
    const tiers = hitTiers(a);
    await a.set("n:1", "oops");
    expect(await a.get("n:1")).toBeUndefined();
    await a.set("n:2", 2);
    expect(await a.get("n:2")).toBe(2);
    expect(await a.get("n:2")).toBe(2);
    expect(tiers).toEqual(["l2", "l1"]);
  });

  test('tier: "l2" reads the driver and leaves L1 alone; a "l2" write drops the copy', async () => {
    const { a } = await twoProcesses();
    const tiers = hitTiers(a);
    await a.set("k", "v1");
    expect(await a.get("k", { tier: "l2" })).toBe("v1");
    expect(await a.getEntry("k", { tier: "l2" })).toMatchObject({
      value: "v1",
    });
    expect(await a.has("k", { tier: "l2" })).toBe(true);
    expect(await a.getMany(["k"], { tier: "l2" })).toEqual(["v1"]);
    expect(tiers).toEqual(["l2", "l2", "l2"]);
    expect(a.stats().l1).toMatchObject({ hits: 0, misses: 0 });

    await a.set("k", "v2", { tier: "l2" });
    expect(a.stats().l1?.entries).toBe(0);
    expect(await a.get("k")).toBe("v2");
    expect(tiers.at(-1)).toBe("l2");
    expect(await a.getOrSet("other", () => "loaded", { tier: "l2" })).toBe(
      "loaded",
    );
    expect(a.stats().l1?.entries).toBe(1); // only "k", backfilled above
  });

  test("getOrSet: a loaded value is held in both tiers; its next call is L1's", async () => {
    const { a, b } = await twoProcesses();
    const tiers = hitTiers(b);
    let loads = 0;
    const loader = (): string => {
      loads++;
      return "loaded";
    };
    expect(await a.getOrSet("k", loader)).toBe("loaded");
    expect(await a.getOrSet("k", loader)).toBe("loaded");
    expect(await b.getOrSet("k", loader)).toBe("loaded");
    expect(await b.getOrSet("k", loader)).toBe("loaded");
    expect(loads).toBe(1);
    expect(tiers).toEqual(["l2", "l1"]);
  });
});

describe("coherence through the bus (§4.2, R13)", () => {
  test("another cache's set, delete, deleteMany, clear and invalidateTags drop this L1's copies", async () => {
    const { a, b, clock } = await twoProcesses();
    const warm = async (): Promise<void> => {
      // Past the last stamp's millisecond: a write in the same one is fenced.
      clock.advance(1);
      await a.setMany([
        ["k1", "v1", { tags: ["t"] }],
        ["k2", "v2"],
      ]);
      expect(await b.getMany(["k1", "k2"])).toEqual(["v1", "v2"]);
      expect(b.stats().l1?.entries).toBe(2);
    };
    await warm();
    await a.set("k1", "new");
    expect(await b.get("k1")).toBe("new");

    await warm();
    await a.delete("k1");
    expect(await b.get("k1")).toBeUndefined();

    await warm();
    await a.deleteMany(["k1", "k2"]);
    expect(await b.getMany(["k1", "k2"])).toEqual([undefined, undefined]);

    await warm();
    await a.invalidateTags(["t"]);
    expect(await b.get("k1")).toBeUndefined();
    expect(await b.get("k2")).toBe("v2");

    await warm();
    await a.clear();
    expect(await b.getMany(["k1", "k2"])).toEqual([undefined, undefined]);
    expect(b.stats().l1?.invalidations).toBeGreaterThanOrEqual(6);
  });

  test("read-your-writes in the writing process: its own delete, deleteMany, clear and invalidateTags drop its copies (§4.3)", async () => {
    const { a, clock } = await twoProcesses();
    const warm = async (): Promise<void> => {
      clock.advance(1);
      await a.setMany([
        ["k1", "v1", { tags: ["t"] }],
        ["k2", "v2"],
      ]);
      expect(a.stats().l1?.entries).toBe(2);
    };
    await warm();
    await a.delete("k1");
    expect(await a.get("k1")).toBeUndefined();
    await warm();
    await a.deleteMany(["k1", "k2"]);
    expect(await a.getMany(["k1", "k2"])).toEqual([undefined, undefined]);
    await warm();
    await a.invalidateTags(["t"]);
    expect(await a.get("k1")).toBeUndefined();
    await warm();
    await a.clear();
    expect(await a.getMany(["k1", "k2"])).toEqual([undefined, undefined]);
    expect(a.stats().l1?.entries).toBe(0);
  });

  test("a namespace view's change drops only that namespace's copies", async () => {
    const { a, b } = await twoProcesses();
    await a.namespace("x").set("k", "x");
    await a.namespace("y").set("k", "y");
    expect(await b.namespace("x").get("k")).toBe("x");
    expect(await b.namespace("y").get("k")).toBe("y");
    await a.namespace("x").clear();
    const tiers = hitTiers(b);
    expect(await b.namespace("y").get("k")).toBe("y");
    expect(await b.namespace("x").get("k")).toBeUndefined();
    expect(tiers).toEqual(["l1"]);
  });

  test("a cache skips its own messages: its own write stays in its L1", async () => {
    const { a } = await twoProcesses();
    const tiers = hitTiers(a);
    await a.set("k", "v");
    expect(await a.get("k")).toBe("v");
    expect(tiers).toEqual(["l1"]);
    expect(a.stats().l1?.invalidations).toBe(0);
  });

  test("messages carry stored keys and an origin, never values (R13)", async () => {
    const hub = busHub();
    const driver = memoryDriver();
    const a = await tiered(driver, { bus: hub.bus() });
    await a.set("k", { secret: "value" }, { tags: ["t"] });
    await a.delete("k");
    await a.invalidateTags(["t"]);
    await a.clear();
    expect(hub.published.map((message) => message.type)).toEqual([
      "set",
      "delete",
      "invalidate-tags",
      "clear",
    ]);
    for (const message of hub.published) {
      expect(JSON.stringify(message)).not.toContain("secret");
      expect(message.namespace).toBe("cache");
      expect(typeof message.origin).toBe("string");
    }
    expect(hub.published[0].keys).toEqual(["k"]);
    expect(hub.published[2].tags).toEqual(["t"]);
  });

  test("publishes in one microtask are batched: set keys merged per namespace", async () => {
    const hub = busHub();
    const a = await tiered(memoryDriver(), { bus: hub.bus() });
    await Promise.all([a.set("x", 1), a.set("y", 2), a.set("z", 3)]);
    const sets = hub.published.filter((message) => message.type === "set");
    expect(sets.length).toBeLessThan(3);
    expect(sets.flatMap((message) => message.keys).sort()).toEqual([
      "x",
      "y",
      "z",
    ]);
  });

  test("an invalidation landing during an L2 read keeps that read's value out of L1", async () => {
    const shared = memoryDriver();
    const held = gatedDriver(shared);
    const a = await tiered(shared);
    const b = await tiered(held);
    await a.set("k", "old");
    const at = gate();
    held.hold("get", at);
    const reading = b.get("k");
    await at.reached(); // B has read "old" from L2, not yet copied it
    await a.set("k", "new"); // … and A's message reaches B now
    at.open();
    expect(await reading).toBe("old"); // that read raced; fine
    const tiers = hitTiers(b);
    expect(await b.get("k")).toBe("new");
    expect(tiers).toEqual(["l2"]);
  });

  test("an invalidation landing during a write keeps that write's value out of L1", async () => {
    const shared = memoryDriver();
    const held = gatedDriver(shared);
    const a = await tiered(shared);
    const b = await tiered(held);
    const at = gate();
    held.hold("set", at);
    const writing = b.set("k", "from-b");
    await at.reached(); // B's value is in L2, not yet in B's L1
    await a.set("k", "from-a"); // A's write lands after it in L2
    at.open();
    expect(await writing).toBe(true);
    expect(await b.get("k")).toBe("from-a");
  });

  test("a bus gap flushes the whole L1, and the stamp cache", async () => {
    const hub = busHub();
    const a = await tiered(memoryDriver(), { bus: hub.bus() });
    await a.setMany([
      ["x", 1],
      ["y", 2],
    ]);
    expect(a.stats().l1?.entries).toBe(2);
    const flushes = a.stats().l1!.flushes;
    hub.gap();
    expect(a.stats().l1).toMatchObject({ entries: 0, flushes: flushes + 1 });
    const tiers = hitTiers(a);
    expect(await a.get("x")).toBe(1);
    expect(tiers).toEqual(["l2"]);
  });

  test("subscribing flushes (nothing published before reached it); a failed subscribe is retried, with an error event", async () => {
    const hub = busHub();
    hub.failSubscribes(1);
    const errors: CacheEventMap["error"][] = [];
    const a = createCache({
      driver: memoryDriver(),
      l1: true,
      bus: hub.bus("flaky"),
    });
    opened.push(a);
    a.on("error", (error) => errors.push(error));
    // The first subscribe failed: L1 is armed regardless (bounded by l1.ttl).
    await waitFor("the failed subscribe", () => errors.length === 1);
    await a.set("early", 1);
    expect(a.stats().l1?.entries).toBe(1);
    expect(a.stats().l1?.flushes).toBe(0);
    await waitFor("the retried subscription", () => hub.subscribers === 1);
    // The retry's success flushed what was held without a bus.
    expect(a.stats().l1).toMatchObject({ flushes: 1, entries: 0 });
    hub.failPublishes(1);
    expect(await a.set("k", "v")).toBe(true);
    expect(errors.map((error) => (error.error as Error).message)).toEqual([
      "injected subscribe failure",
      "injected publish failure",
    ]);
    expect(errors.every((error) => error.phase === "bus")).toBe(true);
    expect(errors.every((error) => error.driver === "flaky")).toBe(true);
  });

  test("L1 serves and holds nothing until the bus listens: what was published before never reached it", async () => {
    const hub = busHub();
    const at = gate();
    hub.holdSubscribes(at);
    const a = createCache({
      driver: memoryDriver(),
      l1: true,
      bus: hub.bus(),
      sweepInterval: 0,
    });
    opened.push(a);
    await at.reached();
    const tiers = hitTiers(a);
    await a.set("k", "v");
    expect(await a.get("k")).toBe("v");
    expect(tiers).toEqual(["l2"]);
    expect(a.stats().l1?.entries).toBe(0);
    at.open();
    await waitFor("the subscription", () => a.stats().l1!.flushes === 1);
    expect(await a.get("k")).toBe("v");
    expect(await a.get("k")).toBe("v");
    expect(tiers).toEqual(["l2", "l2", "l1"]);
  });

  test("a cache with a bus and no L1 still publishes, so the others' L1s stay coherent", async () => {
    const shared = memoryDriver();
    const writer = createCache({ driver: shared, bus: "auto" });
    opened.push(writer);
    const reader = await tiered(shared);
    await writer.set("k", "v1");
    expect(await reader.get("k")).toBe("v1");
    await writer.set("k", "v2");
    expect(await reader.get("k")).toBe("v2");
  });

  test("without l1, the bus defaults to off: nothing is published (the control)", async () => {
    const shared = memoryDriver();
    const writer = createCache({ driver: shared });
    opened.push(writer);
    const reader = await tiered(shared);
    await writer.set("k", "v1");
    expect(await reader.get("k")).toBe("v1");
    await writer.set("k", "v2");
    expect(await reader.get("k")).toBe("v1");
  });

  test("close() unsubscribes and closes an explicit bus; the driver's own bus is the driver's", async () => {
    const hub = busHub();
    const bus = hub.bus();
    const a = createCache({ driver: memoryDriver(), l1: true, bus });
    await waitFor("the subscription", () => hub.subscribers === 1);
    await a.set("k", "v");
    await a.close();
    await a.close();
    expect(bus.closed).toBe(true);
    expect(hub.subscribers).toBe(0);
    expect(hub.published.map((message) => message.type)).toEqual(["set"]);

    // "auto": the driver's bus is unsubscribed, and closed with the driver.
    const shared = memoryDriver();
    const own = createCache({ driver: shared, l1: true });
    await waitFor("the subscription", () => own.stats().l1!.flushes === 1);
    const received: string[] = [];
    await shared.subscribe!(
      (message) => received.push(message.type),
      () => {},
    );
    await own.close();
    expect(received).toEqual([]);
  });
});

describe("tags and the fence across tiers (§3.6, §4.3)", () => {
  test("a loader that started before an invalidation is fenced out of every tier", async () => {
    const { a, b } = await twoProcesses();
    const at = gate();
    const loading = b.getOrSet(
      "k",
      async () => {
        await at.wait();
        return "pre-invalidation";
      },
      { tags: ["t"] },
    );
    await at.reached();
    await a.invalidateTags(["t"]);
    at.open();
    expect(await loading).toBe("pre-invalidation");
    expect(b.stats().l1?.entries).toBe(0);
    expect(await b.get("k")).toBeUndefined();
    expect(await a.get("k")).toBeUndefined();
  });

  test("stamps mode: a load that started before another cache's invalidation is kept out of L1 (no driver fence there)", async () => {
    const root = mkdtempSync(join(tmpdir(), "bun-cache-l1-load-"));
    const caches: Cache[] = [];
    try {
      for (let index = 0; index < 2; index++) {
        caches.push(
          await tiered(fileDriver({ root, busPollInterval: 10 }), {
            tagStampCacheMs: 0,
          }),
        );
      }
      const [a, b] = caches;
      const at = gate();
      const loading = b.getOrSet(
        "k",
        async () => {
          await at.wait();
          return "pre-invalidation";
        },
        { tags: ["t"] },
      );
      await at.reached();
      await a.invalidateTags(["t"]);
      await Bun.sleep(100); // B's poll delivers the message mid-load
      at.open();
      expect(await loading).toBe("pre-invalidation");
      const tiers = hitTiers(b);
      // L2's read check misses it (older than the stamp); L1 must not hold it.
      expect(await b.get("k")).toBeUndefined();
      expect(tiers).toEqual([]);
    } finally {
      for (const cache of caches) {
        await cache.close();
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stamps mode: another cache's invalidation is pushed into this cache's stamp cache, L1 or not (R12)", async () => {
    const root = mkdtempSync(join(tmpdir(), "bun-cache-l1-stamps-"));
    const make = (bus: "auto" | false): Cache => {
      const cache = createCache({
        driver: fileDriver({ root, busPollInterval: 10 }),
        bus,
        sweepInterval: 0,
        tagStampCacheMs: 60_000,
      });
      opened.push(cache);
      return cache;
    };
    try {
      for (const bus of ["auto", false] as const) {
        const writer = make(bus);
        const reader = make(bus);
        await Bun.sleep(30); // the polled subscriptions start
        await writer.set(`k-${String(bus)}`, "v", {
          tags: [`t-${String(bus)}`],
        });
        // The reader caches "no stamp for t" for tagStampCacheMs (60 s).
        expect(await reader.get(`k-${String(bus)}`)).toBe("v");
        await writer.invalidateTags([`t-${String(bus)}`]);
        await Bun.sleep(150);
        // With the bus, the stamp reached the reader; without, its cached
        // "no stamp" serves the invalidated entry (the control).
        expect(await reader.get(`k-${String(bus)}`)).toBe(
          bus === "auto" ? undefined : "v",
        );
      }
    } finally {
      for (const cache of opened.splice(0)) {
        await cache.close();
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("hit event payload", () => {
  test('a cache without an L1 reports tier "l2", and has no l1 stats', async () => {
    const cache = createCache({ driver: memoryDriver(), sweepInterval: 0 });
    opened.push(cache);
    const tiers = hitTiers(cache);
    await cache.set("k", 1);
    expect(await cache.get("k")).toBe(1);
    expect(tiers).toEqual(["l2"]);
    expect(cache.stats().l1).toBeUndefined();
  });

  test("stats({ reset: true }) zeroes the L1 counts, not what it holds", async () => {
    const { a } = await twoProcesses();
    await a.set("k", 1);
    await a.get("k");
    const before = a.stats({ reset: true }).l1!;
    expect(before.hits).toBe(1);
    expect(a.stats().l1).toMatchObject({ hits: 0, entries: 1 });
  });
});
