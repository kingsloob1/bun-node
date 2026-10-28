/**
 * Every dropped write is reported (plan §3.4, §3.6). A load whose result an
 * invalidation outran is not stored, and says so with a `fenced` event and
 * the `fenced` stat, whichever mechanism dropped it:
 *
 * - `reason: "local"` — this cache (or a namespace view of it) ran `delete`,
 *   `deleteMany`, `clear`, `invalidateTags` or `increment` while the load ran,
 *   which forgot the flight; the core drops the write before the driver.
 * - `reason: "fence"` — the driver's tag fence refused it: another cache on
 *   the driver (another process, in production) invalidated one of its tags.
 *
 * In both, the loader's caller still gets its value; only the store is
 * skipped. Which writes are dropped is the flight and fence tests' business
 * (`flight.test.ts`, `tags.test.ts`); these pin down what is reported.
 */
import { describe, expect, test } from "bun:test";
import { createDeferred, sleep } from "@kingsleyweb/bun-common";
import type { Cache, CacheEventMap } from "../../lib/index";
import { createCache, memoryDriver } from "../../lib/index";
import { fakeClock } from "../../lib/testing/index";
import { makeCache } from "../helpers";

/** Records every `fenced`, `set` and `refresh` event a cache emits, in order. */
function record(cache: Cache): {
  /** The `fenced` payloads. */
  fenced: CacheEventMap["fenced"][];
  /** The kinds, in order: `"fenced"`, `"set"` or `"refresh"`. */
  kinds: string[];
} {
  const fenced: CacheEventMap["fenced"][] = [];
  const kinds: string[] = [];
  cache.on("fenced", (event) => {
    fenced.push(event);
    kinds.push("fenced");
  });
  cache.on("set", () => kinds.push("set"));
  cache.on("refresh", () => kinds.push("refresh"));
  return { fenced, kinds };
}

/** A loader that waits on `gate` before answering `value`; `started` resolves once it runs. */
function gatedLoader<T>(value: T): {
  /** The loader. */
  loader: () => Promise<T>;
  /** Opens the gate. */
  release: () => void;
  /** Resolves once the loader is running. */
  started: Promise<void>;
} {
  const gate = createDeferred<void>();
  const started = createDeferred<void>();
  return {
    loader: async () => {
      started.resolve();
      await gate.promise;
      return value;
    },
    release: () => gate.resolve(),
    started: started.promise,
  };
}

describe("fenced: a local invalidation mid-load (§3.4)", () => {
  test("invalidateTags: reported with the load's own tags; the value is returned, not stored", async () => {
    const { cache } = makeCache({ namespace: "app" });
    const seen = record(cache);
    const load = gatedLoader("pre-invalidation");
    const inflight = cache.getOrSet("k", load.loader, {
      tags: ["org:7", "user:1"],
    });
    await load.started;
    await cache.invalidateTags(["org:7"]);
    load.release();
    // The caller still gets its value…
    expect(await inflight).toBe("pre-invalidation");
    // …the drop is reported, with the tags the entry would have carried…
    expect(seen.fenced).toEqual([
      {
        key: "k",
        namespace: "app",
        tags: ["org:7", "user:1"],
        reason: "local",
      },
    ]);
    expect(seen.kinds).toEqual(["fenced"]);
    // …and nothing was stored.
    expect(await cache.get("k")).toBeUndefined();
    const stats = cache.stats();
    expect(stats.fenced).toBe(1);
    expect(stats.sets).toBe(0);
    expect(stats.bytesWritten).toBe(0);
    await cache.close();
  });

  test("invalidateTags of unrelated tags forgets an untagged load too, and that is reported", async () => {
    // invalidateTags forgets every flight of its namespace (§3.4); the drop
    // is reported with the load's own (empty) tags.
    const { cache } = makeCache({ namespace: "app" });
    const seen = record(cache);
    const load = gatedLoader("v");
    const inflight = cache.getOrSet("k", load.loader);
    await load.started;
    await cache.invalidateTags(["unrelated"]);
    load.release();
    expect(await inflight).toBe("v");
    expect(seen.fenced).toEqual([
      { key: "k", namespace: "app", tags: [], reason: "local" },
    ]);
    expect(await cache.get("k")).toBeUndefined();
    await cache.close();
  });

  /** The local operations that forget a key's flight (§3.4), each run on the key being loaded. */
  const forgetting: [string, (cache: Cache) => Promise<unknown>][] = [
    ["delete", async (cache) => await cache.delete("k")],
    ["deleteMany", async (cache) => await cache.deleteMany(["k", "other"])],
    ["clear", async (cache) => await cache.clear()],
    ["increment", async (cache) => await cache.increment("k")],
  ];

  test.each(forgetting)(
    "%s: an untagged load is reported, its value returned, not stored",
    async (_name, invalidate) => {
      const { cache } = makeCache({ namespace: "app" });
      const seen = record(cache);
      const load = gatedLoader("loaded");
      const inflight = cache.getOrSet("k", load.loader);
      await load.started;
      await invalidate(cache);
      load.release();
      expect(await inflight).toBe("loaded");
      expect(seen.fenced).toEqual([
        { key: "k", namespace: "app", tags: [], reason: "local" },
      ]);
      expect(seen.kinds).toEqual(["fenced"]);
      // The loaded value never landed (an increment's counter may have).
      expect(await cache.get("k")).not.toBe("loaded");
      expect(cache.stats().fenced).toBe(1);
      await cache.close();
    },
  );

  test("delete of a tagged key: reported with the load's tags", async () => {
    const { cache } = makeCache();
    const seen = record(cache);
    const load = gatedLoader(1);
    const inflight = cache.getOrSet("k", load.loader, { tags: ["t"] });
    await load.started;
    await cache.delete("k");
    load.release();
    expect(await inflight).toBe(1);
    expect(seen.fenced.map(({ tags, reason }) => ({ tags, reason }))).toEqual([
      { tags: ["t"], reason: "local" },
    ]);
    await cache.close();
  });

  test("through a namespace view: the view's namespace, on the shared listeners and stats", async () => {
    const { cache } = makeCache({ namespace: "app" });
    const users = cache.namespace("users");
    // Listeners on the root see the view's events (one emitter, §3.12).
    const seen = record(cache);
    const load = gatedLoader("u");
    const inflight = users.getOrSet("k", load.loader, { tags: ["team"] });
    await load.started;
    await users.invalidateTags(["team"]);
    load.release();
    expect(await inflight).toBe("u");
    expect(seen.fenced).toEqual([
      { key: "k", namespace: "app:users", tags: ["team"], reason: "local" },
    ]);
    expect(await users.get("k")).toBeUndefined();
    expect(cache.stats().fenced).toBe(1);
    await cache.close();
  });

  test("a load nothing disturbed is stored and reports nothing", async () => {
    const { cache } = makeCache();
    const seen = record(cache);
    expect(await cache.getOrSet("k", async () => 1, { tags: ["t"] })).toBe(1);
    expect(seen.kinds).toEqual(["set"]);
    expect(cache.stats().fenced).toBe(0);
    await cache.close();
  });

  test("a forgotten load of undefined (not cached) has no write to drop, so reports nothing", async () => {
    const { cache } = makeCache();
    const seen = record(cache);
    const load = gatedLoader(undefined);
    const inflight = cache.getOrSet("k", load.loader);
    await load.started;
    await cache.delete("k");
    load.release();
    expect(await inflight).toBeUndefined();
    expect(seen.kinds).toEqual([]);
    expect(cache.stats().fenced).toBe(0);
    await cache.close();
  });
});

describe("fenced: a forgotten background refresh (§3.5)", () => {
  test("stale-while-revalidate: the refresh is reported instead of a `refresh` event", async () => {
    const { cache, clock } = makeCache({
      ttl: 1_000,
      staleWhileRevalidate: 5_000,
    });
    await cache.set("k", "v1", { tags: ["t"] });
    clock.advance(2_000); // stale, inside the window
    const seen = record(cache);
    const load = gatedLoader("v2");
    // The stale value is served; the refresh runs in the background.
    expect(await cache.getOrSet("k", load.loader, { tags: ["t"] })).toBe("v1");
    await load.started;
    await cache.invalidateTags(["t"]);
    load.release();
    await sleep(20); // the refresh's write is dropped
    expect(seen.fenced).toEqual([
      { key: "k", namespace: "cache", tags: ["t"], reason: "local" },
    ]);
    expect(seen.kinds).toEqual(["fenced"]);
    expect(await cache.get("k")).toBeUndefined();
    expect(cache.stats().fenced).toBe(1);
    await cache.close();
  });

  test("refreshAhead: a refresh outrun by a delete is reported", async () => {
    const { cache, clock } = makeCache({ ttl: 1_000, refreshAhead: 0.2 });
    await cache.set("k", "v1");
    clock.advance(900); // the last fifth of the TTL
    const seen = record(cache);
    const load = gatedLoader("v2");
    expect(await cache.getOrSet("k", load.loader)).toBe("v1");
    await load.started;
    await cache.delete("k");
    load.release();
    await sleep(20);
    expect(seen.fenced.map(({ key, reason }) => ({ key, reason }))).toEqual([
      { key: "k", reason: "local" },
    ]);
    expect(seen.kinds).toEqual(["fenced"]);
    expect(await cache.get("k")).toBeUndefined();
    await cache.close();
  });
});

describe('fenced: the driver\'s tag fence (§3.6) — reason "fence"', () => {
  test("another cache's invalidation: the driver refuses, reported with the fence's reason", async () => {
    // Two caches on one driver stand in for two processes.
    const clock = fakeClock();
    const driver = memoryDriver({ now: clock.now });
    const a = createCache({
      driver,
      sweepInterval: 0,
      now: clock.now,
      namespace: "app",
    });
    const b = createCache({
      driver,
      sweepInterval: 0,
      now: clock.now,
      namespace: "app",
    });
    const seen = record(a);
    const load = gatedLoader("pre-invalidation");
    const inflight = a.getOrSet("k", load.loader, { tags: ["org:7"] });
    await load.started;
    clock.advance(5); // the stamp lands after the load started
    await b.invalidateTags(["org:7"]);
    load.release();
    expect(await inflight).toBe("pre-invalidation");
    expect(seen.fenced).toEqual([
      { key: "k", namespace: "app", tags: ["org:7"], reason: "fence" },
    ]);
    expect(seen.kinds).toEqual(["fenced"]);
    expect(await a.get("k")).toBeUndefined();
    // Counted the same way as a local drop: a `fenced`, never a `set`.
    expect(a.stats()).toMatchObject({ fenced: 1, sets: 0, bytesWritten: 0 });
    // The invalidating cache dropped nothing of its own.
    expect(b.stats().fenced).toBe(0);
    await a.close();
    await b.close();
  });

  test("stats({ reset: true }) zeroes the count", async () => {
    const { cache } = makeCache();
    const load = gatedLoader(1);
    const inflight = cache.getOrSet("k", load.loader);
    await load.started;
    await cache.delete("k");
    load.release();
    await inflight;
    expect(cache.stats({ reset: true }).fenced).toBe(1);
    expect(cache.stats().fenced).toBe(0);
    await cache.close();
  });
});
