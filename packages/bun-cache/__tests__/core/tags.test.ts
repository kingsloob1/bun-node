/**
 * Tags (plan §3.6): eager index invalidation with the write fence on the
 * memory driver, lazy stamps through `fromSimpleDriver`, and the race the
 * fence exists for.
 *
 * A stamp at an entry's own millisecond counts as newer than the entry:
 * Date.now() cannot order two events within one ms, so the tests separate
 * them with a clock instead of relying on wall-clock luck.
 */
import { describe, expect, test } from "bun:test";
import { createDeferred, sleep } from "@kingsleyweb/bun-common";
import type { CacheDriver, StoredEntry } from "../../lib/index";
import {
  createCache,
  fromSimpleDriver,
  memoryDriver,
  UnsupportedOperationError,
} from "../../lib/index";
import { fakeClock } from "../../lib/testing/index";
import { makeCache } from "../helpers";

describe("tags: index mode (memory)", () => {
  test("invalidateTags deletes every entry carrying any of the tags", async () => {
    const { cache } = makeCache();
    await cache.set("k1", 1, { tags: ["a"] });
    await cache.set("k2", 2, { tags: ["a", "b"] });
    await cache.set("k3", 3);
    await cache.invalidateTags(["a"]);
    expect(await cache.get("k1")).toBeUndefined();
    expect(await cache.get("k2")).toBeUndefined();
    expect(await cache.get("k3")).toBe(3);
    await cache.close();
  });

  test("an in-process load invalidated mid-flight is dropped, its value still returned", async () => {
    const { cache } = makeCache();
    const gate = createDeferred<void>();
    // Request A misses and starts a slow loader.
    const inflight = cache.getOrSet(
      "k",
      async () => {
        await gate.promise;
        return "pre-invalidation";
      },
      { tags: ["org:7"] },
    );
    await sleep(5);
    // The tag is invalidated while A's loader runs: A's flight is forgotten.
    await cache.invalidateTags(["org:7"]);
    gate.resolve();
    // A's caller still gets its value…
    expect(await inflight).toBe("pre-invalidation");
    // …but it was not stored.
    expect(await cache.get("k")).toBeUndefined();
    await cache.close();
  });

  test("the fence: another process's load, started before the invalidation, is refused", async () => {
    // Two caches on one driver stand in for two processes: the fence is the
    // cross-process protection (§3.6).
    const clock = fakeClock();
    const driver = memoryDriver({ now: clock.now });
    const a = createCache({ driver, sweepInterval: 0, now: clock.now });
    const b = createCache({ driver, sweepInterval: 0, now: clock.now });
    const fenced: string[] = [];
    a.on("fenced", (event) => {
      fenced.push(event.key);
    });
    const gate = createDeferred<void>();
    // Process A misses and starts a slow loader (its `createdAt` is now).
    const inflight = a.getOrSet(
      "k",
      async () => {
        await gate.promise;
        return "pre-invalidation";
      },
      { tags: ["org:7"] },
    );
    await sleep(5);
    clock.advance(5);
    // Process B invalidates the tag while A's loader runs.
    await b.invalidateTags(["org:7"]);
    gate.resolve();
    // A's caller still gets its value, and the refusal is an event…
    expect(await inflight).toBe("pre-invalidation");
    expect(fenced).toEqual(["k"]);
    // …but the pre-invalidation value never landed.
    expect(await a.get("k")).toBeUndefined();
    expect(await b.get("k")).toBeUndefined();
    await a.close();
  });

  test("invalidateTags forgets in-flight loads, so the next caller loads afresh", async () => {
    const { cache } = makeCache();
    const gate = createDeferred<void>();
    const inflight = cache.getOrSet("k", async () => {
      await gate.promise;
      return "old";
    });
    await sleep(5);
    await cache.invalidateTags(["anything"]);
    const fresh = await cache.getOrSet("k", async () => "new");
    expect(fresh).toBe("new");
    gate.resolve();
    expect(await inflight).toBe("old");
    expect(await cache.get("k")).toBe("new");
    await cache.close();
  });

  test('mode: "stale" needs softPurge on a plaintext index-mode cache, and says so', async () => {
    const { cache } = makeCache();
    await expect(
      cache.invalidateTags(["a"], { mode: "stale" }),
    ).rejects.toThrow(UnsupportedOperationError);
    await expect(
      cache.invalidateTags(["a"], { mode: "stale" }),
    ).rejects.toThrow(/softPurge: true/);
    await cache.close();
  });
});

describe("tags: stamps mode (fromSimpleDriver)", () => {
  /** A plain Map behind the simple-driver contract, on a fake clock shared with the cache. */
  function mapDriver(clock: ReturnType<typeof fakeClock>): {
    driver: CacheDriver;
    map: Map<string, StoredEntry>;
  } {
    const map = new Map<string, StoredEntry>();
    const driver = fromSimpleDriver({
      name: "map",
      capabilities: { multiProcess: false },
      get: (ns, key) => {
        const entry = map.get(`${ns}\n${key}`);
        if (
          entry !== undefined &&
          entry.expiresAt !== null &&
          entry.expiresAt <= clock.now()
        ) {
          map.delete(`${ns}\n${key}`);
          return Promise.resolve(undefined);
        }
        return Promise.resolve(entry);
      },
      set: (ns, entry) => {
        map.set(`${ns}\n${entry.key}`, entry);
        return Promise.resolve();
      },
      delete: (ns, key) => Promise.resolve(map.delete(`${ns}\n${key}`)),
      clear: (ns) => {
        for (const key of [...map.keys()]) {
          if (key.startsWith(`${ns}\n`)) {
            map.delete(key);
          }
        }
        return Promise.resolve();
      },
    });
    return { driver, map };
  }

  /** A cache over the Map driver, on one shared fake clock. */
  function mapCache() {
    const clock = fakeClock();
    const { driver, map } = mapDriver(clock);
    const cache = createCache({ driver, sweepInterval: 0, now: clock.now });
    return { cache, clock, map };
  }

  test("an invalidated tag reads as a miss, though the entry still lives in the store", async () => {
    const { cache, clock, map } = mapCache();
    await cache.set("k", "v", { tags: ["t"] });
    const storedBefore = map.size;
    clock.advance(1);
    await cache.invalidateTags(["t"]);
    // Lazy: nothing was deleted…
    expect(map.size).toBeGreaterThanOrEqual(storedBefore);
    // …but the read check sees the stamp.
    expect(await cache.get("k")).toBeUndefined();
    await cache.close();
  });

  test("an entry written after the invalidation survives it", async () => {
    const { cache, clock } = mapCache();
    await cache.set("k", "old", { tags: ["t"] });
    clock.advance(1);
    await cache.invalidateTags(["t"]);
    clock.advance(1);
    await cache.set("k", "new", { tags: ["t"] });
    expect(await cache.get("k")).toBe("new");
    await cache.close();
  });

  test("an untagged key is untouched by an invalidation", async () => {
    const { cache, clock } = mapCache();
    await cache.set("tagged", 1, { tags: ["t"] });
    await cache.set("plain", 2);
    clock.advance(1);
    await cache.invalidateTags(["t"]);
    expect(await cache.get("tagged")).toBeUndefined();
    expect(await cache.get("plain")).toBe(2);
    await cache.close();
  });
});
