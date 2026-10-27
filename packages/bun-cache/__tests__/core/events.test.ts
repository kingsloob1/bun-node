/**
 * Events and statistics (plan §3.12): every event fires with its payload, a
 * throwing listener never breaks the operation, and `stats()` counts, rates
 * and resets.
 */
import { describe, expect, test } from "bun:test";
import { sleep } from "@kingsleyweb/bun-common";
import type { CacheEventMap } from "../../lib/index";
import { createCache, memoryDriver } from "../../lib/index";
import { makeCache } from "../helpers";

describe("events (§3.12)", () => {
  test("hit, miss, set, delete, invalidate, load each fire with their payload", async () => {
    const { cache } = makeCache({ namespace: "app" });
    const seen: [string, unknown][] = [];
    for (const event of [
      "hit",
      "miss",
      "set",
      "delete",
      "invalidate",
      "load",
    ] as const) {
      cache.on(event, (payload) => {
        seen.push([event, payload]);
      });
    }
    await cache.getOrSet("k", async () => 1, { tags: ["t"] }); // load + set
    await cache.get("k"); // hit
    await cache.get("absent"); // miss
    await cache.delete("k"); // delete
    await cache.invalidateTags(["t"]); // invalidate
    const kinds = seen.map(([kind]) => kind);
    expect(kinds).toEqual([
      "miss",
      "load",
      "set",
      "hit",
      "miss",
      "delete",
      "invalidate",
    ]);
    const load = seen.find(
      ([kind]) => kind === "load",
    )![1] as CacheEventMap["load"];
    expect(load.key).toBe("k");
    expect(load.namespace).toBe("app");
    expect(typeof load.duration).toBe("number");
    expect(load.shared).toBe(false);
    await cache.close();
  });

  test("a throwing listener is logged and never breaks the operation", async () => {
    const { cache } = makeCache();
    cache.on("hit", () => {
      throw new Error("listener boom");
    });
    await cache.set("k", 1);
    expect(await cache.get("k")).toBe(1);
    await cache.close();
  });

  test("an unsubscribed listener stops firing", async () => {
    const { cache } = makeCache();
    let hits = 0;
    const off = cache.on("hit", () => {
      hits++;
    });
    await cache.set("k", 1);
    await cache.get("k");
    off();
    await cache.get("k");
    expect(hits).toBe(1);
    await cache.close();
  });
});

describe("stats (§3.12)", () => {
  test("counts, the hit rate, load durations, and reset", async () => {
    const { cache } = makeCache();
    await cache.getOrSet("a", async () => {
      await sleep(5);
      return 1;
    }); // miss + load + set
    await cache.get("a"); // hit
    await cache.get("b"); // miss
    await cache.delete("a"); // delete
    const stats = cache.stats();
    expect(stats).toMatchObject({
      hits: 1,
      misses: 2,
      sets: 1,
      deletes: 1,
      loads: 1,
      loadErrors: 0,
    });
    expect(stats.hitRate).toBeCloseTo(1 / 3);
    expect(stats.loadDurations.count).toBe(1);
    expect(stats.loadDurations.p50).toBeGreaterThanOrEqual(0);
    expect(stats.bytesWritten).toBeGreaterThan(0);
    const reset = cache.stats({ reset: true });
    expect(reset.loads).toBe(1);
    expect(cache.stats().hits).toBe(0);
    expect(cache.stats().loadDurations.count).toBe(0);
    await cache.close();
  });

  test("evictions are counted from the driver's report", async () => {
    const driver = memoryDriver({ maxEntries: 2 });
    const cache = createCache({ driver, sweepInterval: 0 });
    const evicted: string[] = [];
    cache.on("evict", (event) => {
      evicted.push(event.key);
    });
    await cache.set("a", 1);
    await cache.set("b", 2);
    await cache.set("c", 3); // evicts a (LRU)
    expect(cache.stats().evictions).toBe(1);
    expect(evicted).toEqual(["a"]);
    await cache.close();
  });
});
