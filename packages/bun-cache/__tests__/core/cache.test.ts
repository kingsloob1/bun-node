/**
 * The core's everyday surface (plan §3.1, §3.3, §3.7): reads and writes,
 * namespaces and versions, TTLs (including `ttl: (value) => ms` and jitter),
 * `touch`, and the batch methods.
 */
import { describe, expect, test } from "bun:test";
import { createCache, memoryDriver } from "../../lib/index";
import { makeCache } from "../helpers";

describe("reads and writes", () => {
  test("set/get/has/delete", async () => {
    const { cache } = makeCache();
    await cache.set("k", { v: 1 });
    expect(await cache.get("k")).toEqual({ v: 1 });
    expect(await cache.has("k")).toBe(true);
    expect(await cache.delete("k")).toBe(true);
    expect(await cache.delete("k")).toBe(false);
    expect(await cache.get("k")).toBeUndefined();
    expect(await cache.has("k")).toBe(false);
    await cache.close();
  });

  test("getEntry exposes the metadata, fresh and stale", async () => {
    const { cache, clock } = makeCache();
    const t0 = clock.now();
    // A stale-if-error window keeps the entry past its freshness, so a stale
    // read has something to see.
    await cache.set("k", "v", { ttl: 1_000, staleIfError: 5_000, tags: ["t"] });
    const fresh = await cache.getEntry("k");
    expect(fresh).toMatchObject({
      key: "k",
      value: "v",
      createdAt: t0,
      freshUntil: t0 + 1_000,
      expiresAt: t0 + 1_000 + 5_000,
      tags: ["t"],
      stale: false,
    });
    clock.advance(1_500);
    const stale = await cache.getEntry("k");
    expect(stale?.stale).toBe(true);
    expect(await cache.get("k")).toBeUndefined();
    await cache.close();
  });

  test("getMany preserves order with holes; setMany counts the stored", async () => {
    const { cache } = makeCache();
    expect(
      await cache.setMany([
        ["a", 1],
        ["b", 2, { ttl: null }],
      ]),
    ).toBe(2);
    expect(await cache.getMany(["a", "missing", "b"])).toEqual([
      1,
      undefined,
      2,
    ]);
    await cache.close();
  });

  test("deleteMany counts what was there", async () => {
    const { cache } = makeCache();
    await cache.set("a", 1);
    await cache.set("b", 2);
    expect(await cache.deleteMany(["a", "b", "c"])).toBe(2);
    await cache.close();
  });

  test("clear empties the cache's namespace only", async () => {
    const { cache } = makeCache();
    const other = cache.namespace("other");
    await cache.set("k", "mine");
    await other.set("k", "theirs");
    await cache.clear();
    expect(await cache.get("k")).toBeUndefined();
    expect(await other.get("k")).toBe("theirs");
    await cache.close();
  });
});

describe("namespaces and versions (§3.7)", () => {
  test("a namespace view shares the driver but not the keys", async () => {
    const { cache } = makeCache({ namespace: "app" });
    const users = cache.namespace("users");
    await cache.set("k", "root");
    await users.set("k", "nested");
    expect(await cache.get("k")).toBe("root");
    expect(await users.get("k")).toBe("nested");
    // A chain: app:users:admins.
    const admins = users.namespace("admins");
    await admins.set("k", "deep");
    expect(await cache.namespace("users").namespace("admins").get("k")).toBe(
      "deep",
    );
    await cache.close();
  });

  test("a version joins the namespace: a bump hides the old entries", async () => {
    const driver = memoryDriver();
    const v1 = createCache({
      driver,
      namespace: "app",
      version: "v1",
      sweepInterval: 0,
    });
    await v1.set("k", "old");
    const v2 = createCache({
      driver,
      namespace: "app",
      version: "v2",
      sweepInterval: 0,
    });
    expect(await v2.get("k")).toBeUndefined();
    expect(await v1.get("k")).toBe("old");
    await v1.close();
  });

  test("a malformed namespace is a TypeError", () => {
    expect(() =>
      createCache({ driver: memoryDriver(), namespace: "a b" }),
    ).toThrow(TypeError);
    expect(() =>
      createCache({ driver: memoryDriver(), namespace: "" }),
    ).toThrow(TypeError);
  });

  test("events and stats are shared by a namespace view", async () => {
    const { cache } = makeCache();
    const hits: string[] = [];
    cache.on("hit", (event) => {
      hits.push(event.namespace);
    });
    const users = cache.namespace("users");
    await users.set("k", 1);
    await users.get("k");
    expect(hits).toEqual(["cache:users"]);
    expect(cache.stats().sets).toBe(1);
    await cache.close();
  });
});

describe("TTLs (§3.3)", () => {
  test("ttl: null never expires", async () => {
    const { cache, clock } = makeCache();
    await cache.set("k", "v", { ttl: null });
    clock.advance(10_000_000_000);
    expect(await cache.get("k")).toBe("v");
    await cache.close();
  });

  test("ttl: (value) => ms computes per value (R29)", async () => {
    const { cache, clock } = makeCache({
      ttl: (value) =>
        Array.isArray(value) && value.length === 0 ? 100 : 60_000,
    });
    await cache.set("empty", []);
    await cache.set("full", [1]);
    clock.advance(200);
    expect(await cache.get("empty")).toBeUndefined();
    expect(await cache.get("full")).toEqual([1]);
    await cache.close();
  });

  test("expiresAt is an absolute instant, exclusive with ttl", async () => {
    const { cache, clock } = makeCache();
    await cache.set("k", "v", { expiresAt: clock.now() + 5_000 });
    clock.advance(4_000);
    expect(await cache.get("k")).toBe("v");
    clock.advance(2_000);
    expect(await cache.get("k")).toBeUndefined();
    await cache.close();
  });

  test("jitter spreads the TTL within ± the fraction (R7)", async () => {
    const seen: number[] = [];
    for (const rand of [0, 0.25, 0.5, 0.75, 0.999]) {
      const { cache, clock } = makeCache({ jitter: 0.1, random: () => rand });
      await cache.set("k", "v", { ttl: 1_000 });
      const entry = await cache.getEntry("k");
      seen.push(entry!.freshUntil! - clock.now());
      await cache.close();
    }
    for (const ttl of seen) {
      expect(ttl).toBeGreaterThanOrEqual(900);
      expect(ttl).toBeLessThanOrEqual(1100);
    }
    expect(new Set(seen).size).toBeGreaterThan(1);
  });

  test("touch slides freshness and keeps the stale window's width", async () => {
    const { cache, clock } = makeCache();
    const t0 = clock.now();
    await cache.set("k", "v", { ttl: 1_000, staleIfError: 500 });
    clock.advance(800);
    expect(await cache.touch("k", 2_000)).toBe(true);
    const entry = await cache.getEntry("k");
    expect(entry!.freshUntil).toBe(t0 + 800 + 2_000);
    expect(entry!.expiresAt).toBe(t0 + 800 + 2_000 + 500);
    expect(await cache.touch("missing", 1_000)).toBe(false);
    clock.advance(2_500);
    expect(await cache.get("k")).toBeUndefined();
    await cache.close();
  });

  test("a counter's touch goes through the driver", async () => {
    const { cache, clock } = makeCache();
    await cache.increment("c", 1, { ttl: 1_000 });
    clock.advance(800);
    expect(await cache.touch("c", 5_000)).toBe(true);
    clock.advance(1_500);
    expect(await cache.get("c")).toBe(1);
    clock.advance(4_000);
    expect(await cache.get("c")).toBeUndefined();
    await cache.close();
  });
});
