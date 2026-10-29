/**
 * `toKeyvStore` (plan §10.4, PR-K1), driven the way each Keyv major calls a
 * store, without Keyv: the package keeps no Keyv dependency. The real
 * Keyv 5.6.0 and 6.1.0, cache-manager 7.2.9 and `@nestjs/cache-manager`
 * 12.0.1 drive it in the bench (`bench/compat/toKeyvStore.compat.ts`).
 */
import type { Cache, CacheDriver, CreateCacheOptions } from "../../lib/index";
import type { BunCacheKeyvStore } from "../../lib/keyv/index";
import { describe, expect, test } from "bun:test";
import { createCache, memoryDriver } from "../../lib/index";
import { cacheWithCodec } from "../../lib/core/cache";
import { CODEC_IDS } from "../../lib/core/codecs";
import { decodeEntry, ENTRY_FLAGS } from "../../lib/core/header";
import { toKeyvStore } from "../../lib/keyv/index";
import { fakeClock, faulty } from "../../lib/testing/index";

/** A cache on a fresh memory driver with its driver at hand, the sweeper off. */
function setup(options: Omit<CreateCacheOptions, "driver"> = {}): {
  /** The cache. */
  cache: Cache;
  /** The driver under it, read directly to see what was stored. */
  driver: CacheDriver;
} {
  const driver = memoryDriver({ now: options.now });
  const cache = createCache({ driver, sweepInterval: 0, ...options });
  return { cache, driver };
}

/** Switches a store to Keyv 6's contract, as Keyv 6's `resolveStore` does. */
function asKeyv6(store: BunCacheKeyvStore): BunCacheKeyvStore {
  expect(store.capabilities.expires).toBe(true);
  return store;
}

/** The stored header and payload of `key` in `view`, read from the driver. */
async function storedEntry(driver: CacheDriver, view: Cache, key: string) {
  const name = view.describeKey(key);
  const raw = await driver.get(name.namespace, name.key);
  expect(raw).toBeDefined();
  return { ...decodeEntry(raw!.value), expiresAt: raw!.expiresAt };
}

/** Keyv 5's envelope, as its default serialiser writes it. */
const ENVELOPE =
  '{"value":{"a":1,"d":"1970-01-01T00:00:00.000Z"},"expires":null}';

describe("the cache it takes", () => {
  test("any cache: a typed schema, a json codec, a namespace view", async () => {
    // Compile-time first: each call below is a type error if `toKeyvStore`
    // takes only the default `Cache` (a typed or json-codec cache is a
    // different `Cache<…>`); `bun test --check` checks this file.
    const typed = createCache<{ [k: `user:${number}`]: { name: string } }>({
      driver: memoryDriver(),
    });
    const json = createCache({ driver: memoryDriver(), codec: "json" });
    const stores = [
      toKeyvStore(typed),
      toKeyvStore(json),
      toKeyvStore(typed.namespace("v")),
    ];
    for (const store of stores) {
      await store.set("keyv:k", "v");
      expect(await store.get<string>("keyv:k")).toBe("v");
      await store.disconnect();
    }
  });
});

describe("values: one serialisation", () => {
  test("Keyv's string is stored with the raw codec, its UTF-8 bytes as they are", async () => {
    const { cache, driver } = setup();
    const store = toKeyvStore(cache);
    expect(await store.set("k", ENVELOPE)).toBe(true);
    const { header, payload } = await storedEntry(driver, cache, "k");
    expect(header.codecId).toBe(CODEC_IDS.raw);
    expect(header.flags & ENTRY_FLAGS.rawString).toBe(ENTRY_FLAGS.rawString);
    expect(payload).toEqual(new TextEncoder().encode(ENVELOPE));
    expect(await store.get<string>("k")).toBe(ENVELOPE);
  });

  test("whatever the cache's own codec is", async () => {
    for (const codec of ["structured", "json"] as const) {
      const { cache, driver } = setup({ codec });
      const store = toKeyvStore(cache);
      await store.set("k", ENVELOPE);
      expect((await storedEntry(driver, cache, "k")).header.codecId).toBe(
        CODEC_IDS.raw,
      );
      expect(await store.get<string>("k")).toBe(ENVELOPE);
    }
  });

  test("bytes (a Keyv compression adapter's output) are stored raw and come back as bytes", async () => {
    const { cache, driver } = setup();
    const store = toKeyvStore(cache);
    const bytes = new Uint8Array([0, 1, 2, 250]);
    await store.set("k", bytes);
    const { header } = await storedEntry(driver, cache, "k");
    expect(header.codecId).toBe(CODEC_IDS.raw);
    expect(header.flags & ENTRY_FLAGS.rawString).toBe(0);
    expect(await store.get<unknown>("k")).toEqual(bytes);
  });

  test("an object (Keyv's serialisation off) is stored with the cache's codec, its only encoding", async () => {
    const { cache, driver } = setup();
    const store = toKeyvStore(cache);
    const envelope = { value: { at: new Date(0) }, expires: undefined };
    await store.set("k", envelope);
    expect((await storedEntry(driver, cache, "k")).header.codecId).toBe(
      CODEC_IDS.structured,
    );
    expect(await store.get<unknown>("k")).toEqual(envelope);
  });

  test("an object on a raw-codec cache cannot be stored: an error event and false", async () => {
    const { cache } = setup({ codec: "raw" });
    const store = toKeyvStore(cache);
    const errors: unknown[] = [];
    store.on("error", (error) => errors.push(error));
    expect(await store.set("k", { value: 1 })).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(TypeError);
  });

  test("a Cache that createCache did not make is used as it is, with its own codec", async () => {
    const { cache, driver } = setup();
    // A hand-written Cache: every method delegates, nothing is a CacheImpl.
    const methods = Object.getOwnPropertyNames(
      Object.getPrototypeOf(cache),
    ).filter((name) => name !== "constructor");
    const foreign = Object.fromEntries(
      methods.map((name) => [
        name,
        (...args: unknown[]) =>
          (Reflect.get(cache, name) as (...rest: unknown[]) => unknown).apply(
            cache,
            args,
          ),
      ]),
    ) as unknown as Cache;
    expect(cacheWithCodec(cache, "raw")).toBeDefined();
    expect(cacheWithCodec(foreign, "raw")).toBeUndefined();
    const store = toKeyvStore(foreign);
    await store.set("k", ENVELOPE);
    expect((await storedEntry(driver, cache, "k")).header.codecId).toBe(
      CODEC_IDS.structured,
    );
    expect(await store.get<string>("k")).toBe(ENVELOPE);
  });
});

describe("cacheWithCodec", () => {
  test("a raw view of a structured cache: its writes are raw, both read each other's entries", async () => {
    const { cache, driver } = setup();
    const raw = cacheWithCodec(cache, "raw")!;
    await raw.set("r", "text");
    await cache.set("s", "text");
    expect((await storedEntry(driver, cache, "r")).header.codecId).toBe(
      CODEC_IDS.raw,
    );
    expect((await storedEntry(driver, cache, "s")).header.codecId).toBe(
      CODEC_IDS.structured,
    );
    expect(await cache.get("r")).toBe("text");
    expect(await raw.get("s")).toBe("text");
  });

  test("namespace() on the view keeps its codec", async () => {
    const { cache, driver } = setup();
    const raw = cacheWithCodec(cache, "raw")!.namespace("sub");
    await raw.set("k", "text");
    expect(
      (await storedEntry(driver, cache.namespace("sub"), "k")).header.codecId,
    ).toBe(CODEC_IDS.raw);
  });
});

describe("TTL: Keyv 5's relative TTL in ms", () => {
  test("a TTL in ms: fresh for exactly that long", async () => {
    const clock = fakeClock();
    const { cache } = setup({ now: clock.now });
    const store = toKeyvStore(cache);
    await store.set("k", "v", 40);
    expect((await cache.getEntry("k"))!.expiresAt).toBe(clock.now() + 40);
    clock.advance(39);
    expect(await store.get<unknown>("k")).toBe("v");
    clock.advance(2);
    expect(await store.get<unknown>("k")).toBeUndefined();
  });

  test("none, 0, negative or non-finite: never expires, the cache's own ttl not applied", async () => {
    const clock = fakeClock();
    const { cache } = setup({ now: clock.now, ttl: 10 });
    const store = toKeyvStore(cache);
    for (const ttl of [undefined, 0, -5, Number.NaN, Infinity]) {
      await store.set("k", "v", ttl);
      expect((await cache.getEntry("k"))!.expiresAt).toBeNull();
    }
  });

  test("the cache's jitter and stale windows are not applied", async () => {
    const clock = fakeClock();
    const { cache } = setup({
      now: clock.now,
      jitter: 0.5,
      random: () => 0.99,
      staleWhileRevalidate: 60_000,
      staleIfError: 60_000,
    });
    const store = toKeyvStore(cache);
    await store.set("k", "v", 1_000);
    const entry = (await cache.getEntry("k"))!;
    expect(entry.freshUntil).toBe(clock.now() + 1_000);
    expect(entry.expiresAt).toBe(clock.now() + 1_000);
  });
});

describe("TTL: Keyv 6's absolute expiry in epoch ms", () => {
  test("reading capabilities switches the third argument to an absolute expiry", async () => {
    // A frozen clock: the cache turns the instant into a TTL and back, so a
    // millisecond ticking between the two reads would move it by one.
    const clock = fakeClock();
    const { cache } = setup({ now: clock.now });
    const store = asKeyv6(toKeyvStore(cache));
    const expires = clock.now() + 60_000;
    await store.set("k", "v", expires);
    expect((await cache.getEntry("k"))!.expiresAt).toBe(expires);
  });

  test("an expiry already past deletes the key and answers true", async () => {
    const { cache } = setup();
    const store = asKeyv6(toKeyvStore(cache));
    await store.set("k", "old");
    expect(await store.set("k", "new", Date.now() - 1)).toBe(true);
    expect(await cache.get("k")).toBeUndefined();
  });

  test("none or non-finite: never expires", async () => {
    const { cache } = setup();
    const store = asKeyv6(toKeyvStore(cache));
    for (const expires of [undefined, Number.NaN, Infinity]) {
      await store.set("k", "v", expires);
      expect((await cache.getEntry("k"))!.expiresAt).toBeNull();
    }
  });

  test("without the switch the same number is a relative TTL", async () => {
    const clock = fakeClock();
    const { cache } = setup({ now: clock.now });
    const store = toKeyvStore(cache);
    await store.set("k", "v", 5_000);
    expect((await cache.getEntry("k"))!.expiresAt).toBe(clock.now() + 5_000);
  });
});

describe("bulk operations", () => {
  test("setMany: Keyv 5's ttl and Keyv 6's expires per entry, strings raw and objects encoded", async () => {
    const clock = fakeClock();
    const { cache, driver } = setup({ now: clock.now });
    const store = toKeyvStore(cache);
    const results = await store.setMany([
      { key: "a", value: "A", ttl: 1_000 },
      { key: "b", value: { value: 2 }, expires: clock.now() + 2_000 },
      { key: "c", value: "C" },
    ]);
    expect(results).toEqual([true, true, true]);
    expect((await cache.getEntry("a"))!.expiresAt).toBe(clock.now() + 1_000);
    expect((await cache.getEntry("b"))!.expiresAt).toBe(clock.now() + 2_000);
    expect((await cache.getEntry("c"))!.expiresAt).toBeNull();
    expect((await storedEntry(driver, cache, "a")).header.codecId).toBe(
      CODEC_IDS.raw,
    );
    expect((await storedEntry(driver, cache, "b")).header.codecId).toBe(
      CODEC_IDS.structured,
    );
    expect(await store.getMany<unknown>(["a", "b", "x", "c"])).toEqual([
      "A",
      { value: 2 },
      undefined,
      "C",
    ]);
  });

  test("setMany: an entry already past is deleted and reported stored", async () => {
    const { cache } = setup();
    const store = toKeyvStore(cache);
    await store.set("old", "x");
    expect(
      await store.setMany([
        { key: "old", value: "y", expires: Date.now() - 1 },
        { key: "new", value: "z" },
      ]),
    ).toEqual([true, true]);
    expect(await cache.get("old")).toBeUndefined();
    expect(await cache.get("new")).toBe("z");
  });

  test("setMany: a batch the cache stored only part of reports false for all of it", async () => {
    const { cache } = setup({ maxEntryBytes: 512, compress: false });
    const store = toKeyvStore(cache);
    expect(
      await store.setMany([
        { key: "small", value: "s" },
        { key: "big", value: "x".repeat(4_096) },
      ]),
    ).toEqual([false, false]);
    expect(await cache.get("small")).toBe("s");
  });

  test("deleteMany under Keyv 5: whether every key was there", async () => {
    const { cache } = setup();
    const store = toKeyvStore(cache);
    await store.set("a", "1");
    await store.set("b", "2");
    expect(await store.deleteMany(["a", "b"])).toBe(true);
    await store.set("a", "1");
    expect(await store.deleteMany(["a", "absent"])).toBe(false);
    expect(await cache.get("a")).toBeUndefined();
  });

  test("deleteMany under Keyv 6: one boolean per key", async () => {
    const { cache } = setup();
    const store = asKeyv6(toKeyvStore(cache));
    await store.set("a", "1");
    // The first overload names Keyv 5's `boolean`; Keyv 6's store answers `boolean[]`.
    expect<unknown>(await store.deleteMany(["a", "absent"])).toEqual([
      true,
      false,
    ]);
  });

  test("has and hasMany see only unexpired values", async () => {
    const clock = fakeClock();
    const { cache } = setup({ now: clock.now });
    const store = toKeyvStore(cache);
    await store.set("live", "1");
    await store.set("short", "2", 10);
    clock.advance(11);
    expect(await store.has("live")).toBe(true);
    expect(await store.has("short")).toBe(false);
    expect(await store.hasMany(["live", "short", "absent"])).toEqual([
      true,
      false,
      false,
    ]);
    expect(await store.delete("live")).toBe(true);
    expect(await store.delete("live")).toBe(false);
  });
});

describe("namespaces", () => {
  test("Keyv 5's namespace is a namespace view, its key kept as Keyv prefixed it", async () => {
    const { cache } = setup();
    const store = toKeyvStore(cache);
    store.namespace = "keyv";
    await store.set("keyv:k", "v");
    expect(await cache.namespace("keyv").get("keyv:k")).toBe("v");
    expect(await cache.get("keyv:k")).toBeUndefined();
  });

  test("a namespace set after construction applies to the next call", async () => {
    const { cache } = setup();
    const store = toKeyvStore(cache);
    await store.set("k", "none");
    store.namespace = "late";
    expect(await store.get<unknown>("k")).toBeUndefined();
    await store.set("k", "late");
    expect(await cache.namespace("late").get("k")).toBe("late");
    store.namespace = "";
    expect(store.namespace).toBeUndefined();
    expect(await store.get<unknown>("k")).toBe("none");
  });

  test("clear() clears the current namespace only: not another, not the cache's own entries", async () => {
    const { cache } = setup();
    await cache.set("app-entry", "kept");
    const one = toKeyvStore(cache);
    const two = toKeyvStore(cache);
    one.namespace = "one";
    two.namespace = "two";
    await one.set("k", "1");
    await two.set("k", "2");
    await one.clear();
    expect(await one.get<unknown>("k")).toBeUndefined();
    expect(await two.get<unknown>("k")).toBe("2");
    expect(await cache.get("app-entry")).toBe("kept");
  });

  test("the namespace option roots the store under the cache, so a no-namespace clear() spares the cache", async () => {
    const { cache } = setup();
    await cache.set("app-entry", "kept");
    const store = toKeyvStore(cache, { namespace: "keyv-store" });
    await store.set("k", "v");
    expect(await cache.namespace("keyv-store").get("k")).toBe("v");
    await store.clear();
    expect(await store.get<unknown>("k")).toBeUndefined();
    expect(await cache.get("app-entry")).toBe("kept");
  });

  test("a Keyv namespace cache.namespace() would refuse is hex-encoded, and cannot meet a plain one", async () => {
    const { cache } = setup();
    const store = toKeyvStore(cache);
    store.namespace = "my app";
    await store.set("k", "spaced");
    expect(await cache.namespace("_:6d7920617070").get("k")).toBe("spaced");
    store.namespace = "_";
    await store.set("k", "underscore");
    expect(await cache.namespace("_").get("k")).toBe("underscore");
    store.namespace = "my app";
    expect(await store.get<unknown>("k")).toBe("spaced");
    await store.clear();
    store.namespace = "_";
    expect(await store.get<unknown>("k")).toBe("underscore");
  });
});

describe("errors are events, never throws", () => {
  test("a driver failure under the default policy: the cache's error event reaches the store's listeners, once", async () => {
    const driver = faulty(memoryDriver(), { failOn: ["get", "set"] });
    const cache = createCache({ driver, sweepInterval: 0 });
    const store = toKeyvStore(cache);
    const errors: unknown[] = [];
    store.on("error", (error) => errors.push(error));
    expect(await store.set("k", "v")).toBe(false);
    expect(errors).toHaveLength(1);
    expect(await store.get<unknown>("k")).toBeUndefined();
    expect(errors).toHaveLength(2);
  });

  test("a strict cache throws and emits the same error: the store emits it once and answers a miss", async () => {
    const driver = faulty(memoryDriver(), { failOn: ["get"] });
    const cache = createCache({ driver, sweepInterval: 0, strict: true });
    const store = toKeyvStore(cache);
    const errors: unknown[] = [];
    store.on("error", (error) => errors.push(error));
    expect(await store.get<unknown>("k")).toBeUndefined();
    // The cache's event and the throw carry one error: it arrives once.
    expect(errors).toHaveLength(1);
    expect(await store.has("k")).toBe(false);
    expect(await store.getMany<unknown>(["k", "j"])).toEqual([
      undefined,
      undefined,
    ]);
    expect(await store.hasMany(["k"])).toEqual([false]);
    // getMany on the memory driver reads key by key: two failures, two errors.
    expect(errors.length).toBeGreaterThanOrEqual(4);
    expect(new Set(errors).size).toBe(errors.length);
  });

  test("every method answers its neutral value when the backend is down", async () => {
    const driver = faulty(memoryDriver(), { down: true });
    const cache = createCache({ driver, sweepInterval: 0, strict: true });
    const store = toKeyvStore(cache);
    const errors: unknown[] = [];
    store.on("error", (error) => errors.push(error));
    expect(await store.set("k", "v")).toBe(false);
    expect(await store.setMany([{ key: "k", value: "v" }])).toEqual([false]);
    expect(await store.delete("k")).toBe(false);
    expect(await store.deleteMany(["k"])).toBe(false);
    expect<unknown>(await asKeyv6(store).deleteMany(["k"])).toEqual([false]);
    expect(await store.clear()).toBeUndefined();
    expect(errors.length).toBeGreaterThanOrEqual(6);
  });

  test("with no listener a failure is dropped, not thrown", async () => {
    const driver = faulty(memoryDriver(), { down: true });
    const cache = createCache({ driver, sweepInterval: 0, strict: true });
    const store = toKeyvStore(cache);
    expect(await store.get<unknown>("k")).toBeUndefined();
  });
});

describe("the store's shape, as Keyv and @nestjs/cache-manager inspect it", () => {
  test("every storage method is an async function (Keyv 6 checks the constructor's name)", () => {
    const { cache } = setup();
    const store = toKeyvStore(cache);
    for (const name of [
      "get",
      "getMany",
      "has",
      "hasMany",
      "set",
      "setMany",
      "delete",
      "deleteMany",
      "clear",
      "disconnect",
    ] as const) {
      expect(store[name].constructor.name).toBe("AsyncFunction");
    }
  });

  test("capabilities: a full storage adapter with expires, and no iterator", () => {
    const { cache } = setup();
    const { capabilities } = toKeyvStore(cache);
    expect(capabilities.compatible).toBe(true);
    expect(capabilities.store).toBe("keyvStorage");
    expect(capabilities.methods.deleteMany).toEqual({
      exists: true,
      methodType: "async",
    });
    expect(capabilities.methods.iterator).toEqual({
      exists: false,
      methodType: "none",
    });
  });

  test("opts and namespace, but no hooks or stats: @nestjs/cache-manager wraps it in a Keyv", () => {
    const { cache } = setup();
    const store = toKeyvStore(cache);
    expect(store.opts).toEqual({ dialect: "bun-cache" });
    expect("namespace" in store).toBe(true);
    expect(store.namespace).toBeUndefined();
    expect("hooks" in store).toBe(false);
    expect("stats" in store).toBe(false);
    expect(store.on("error", () => {})).toBe(store);
  });

  test("disconnect() closes the cache, and with it the driver", async () => {
    const { cache, driver } = setup();
    let closed = 0;
    const close = driver.close.bind(driver);
    driver.close = async () => {
      closed++;
      await close();
    };
    const store = toKeyvStore(cache);
    store.on("error", () => {});
    await store.disconnect();
    expect(closed).toBe(1);
  });
});
