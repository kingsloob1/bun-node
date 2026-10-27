/**
 * Counters (plan §3.8): atomic increment/decrement, the TTL set at creation
 * only, `get` on a counter key, and the refusal on a driver without them.
 */
import { describe, expect, test } from "bun:test";
import {
  createCache,
  fromSimpleDriver,
  UnsupportedOperationError,
} from "../../lib/index";
import { makeCache } from "../helpers";

describe("counters (§3.8)", () => {
  test("increment answers the new value; decrement subtracts", async () => {
    const { cache } = makeCache();
    expect(await cache.increment("c")).toBe(1);
    expect(await cache.increment("c", 4)).toBe(5);
    expect(await cache.decrement("c")).toBe(4);
    expect(await cache.decrement("c", 10)).toBe(-6);
    await cache.close();
  });

  test("200 concurrent increments are exact", async () => {
    const { cache } = makeCache();
    await Promise.all(Array.from({ length: 200 }, () => cache.increment("c")));
    expect(await cache.get("c")).toBe(200);
    await cache.close();
  });

  test("the TTL is set at creation only, so a rate-limit window does not slide", async () => {
    const { cache, clock } = makeCache();
    await cache.increment("c", 1, { ttl: 1_000 });
    clock.advance(800);
    await cache.increment("c", 1, { ttl: 60_000 });
    clock.advance(300); // 1_100 past creation: the window did not slide
    expect(await cache.get("c")).toBeUndefined();
    await cache.close();
  });

  test("has() and getEntry() see a counter", async () => {
    const { cache } = makeCache();
    await cache.increment("c", 7);
    expect(await cache.has("c")).toBe(true);
    const entry = await cache.getEntry("c");
    expect(entry?.value).toBe(7);
    await cache.close();
  });

  test("a driver without atomicIncrement refuses with UnsupportedOperationError", async () => {
    const simple = fromSimpleDriver({
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(false),
    });
    const noCounters = createCache({ driver: simple, sweepInterval: 0 });
    await expect(noCounters.increment("c")).rejects.toThrow(
      UnsupportedOperationError,
    );
    await noCounters.close();
  });
});
