/**
 * The core's read of one key (`lib/core/read.ts`, `#readStored`): one call
 * to a driver's one-round-trip reader when it offers one, `get` then
 * `getCounter` otherwise, and `getMany`'s missing keys read for a counter
 * only. Over the memory driver, with a reader added the way the SQL and
 * MongoDB drivers carry theirs.
 */
import { describe, expect, test } from "bun:test";
import type { CacheDriver } from "../../lib/index";
import { CacheDriverError, createCache, memoryDriver } from "../../lib/index";
import type { EntryOrCounterReader } from "../../lib/core/read";
import { ENTRY_OR_COUNTER } from "../../lib/core/read";
import { fakeClock } from "../../lib/testing/index";

/** A memory driver carrying a reader over its own `get` and `getCounter`, and what was called. */
function withReader(now?: () => number): {
  driver: CacheDriver;
  calls: string[];
  reader: { read: EntryOrCounterReader["read"] };
} {
  const driver = memoryDriver(now === undefined ? {} : { now });
  const calls: string[] = [];
  const reader: EntryOrCounterReader = {
    get: driver.get,
    getCounter: driver.getCounter!,
    read: async (ns, key) => {
      calls.push(`read ${key}`);
      const entry = await driver.get(ns, key);
      if (entry !== undefined) {
        return { entry };
      }
      const counter = await driver.getCounter!(ns, key);
      return counter === undefined ? undefined : { counter };
    },
  };
  Object.defineProperty(driver, ENTRY_OR_COUNTER, { value: reader });
  return { driver, calls, reader };
}

/** `driver` behind a Proxy that records each method called by name (bound copies, so no reader is used through it). */
function recorded(driver: CacheDriver): {
  driver: CacheDriver;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    driver: new Proxy(driver, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) => {
          calls.push(String(property));
          return (value as (...args: unknown[]) => unknown).apply(target, args);
        };
      },
    }),
  };
}

describe("the one-round-trip read", () => {
  test("an entry, a counter, an expired counter and a missing key each take one read", async () => {
    const clock = fakeClock();
    const { driver, calls } = withReader(clock.now);
    const cache = createCache({ driver, sweepInterval: 0, now: clock.now });
    await cache.set("e", { a: 1 });
    await cache.increment("c", 3);
    await cache.increment("t", 1, { ttl: 1_000 });
    calls.length = 0;
    expect(await cache.get("e")).toEqual({ a: 1 });
    expect(await cache.get("c")).toBe(3);
    expect(await cache.getEntry("c")).toMatchObject({ value: 3, stale: false });
    expect(await cache.get("t")).toBe(1);
    clock.advance(1_000);
    expect(await cache.get("t")).toBeUndefined();
    expect(await cache.get("none")).toBeUndefined();
    expect(calls).toEqual([
      "read e",
      "read c",
      "read c",
      "read t",
      "read t",
      "read none",
    ]);
    const stats = cache.stats();
    expect(stats.hits).toBe(4);
    expect(stats.misses).toBe(2);
    await cache.close();
  });

  test("a failed read is a miss with an error event under the default policy, and throws under strict", async () => {
    const { driver, reader } = withReader();
    reader.read = () => Promise.reject(new Error("down"));
    const errors: unknown[] = [];
    const cache = createCache({ driver, sweepInterval: 0 });
    cache.on("error", (event) => errors.push(event.error));
    expect(await cache.get("k")).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(CacheDriverError);
    expect((errors[0] as CacheDriverError).op).toBe("get");
    await cache.close();
    const strict = createCache({ driver, sweepInterval: 0, strict: true });
    await expect(strict.get("k")).rejects.toThrow(CacheDriverError);
    await strict.close();
  });

  test("a driver without one is read with get, then getCounter on a miss", async () => {
    const { driver, calls } = recorded(memoryDriver());
    const cache = createCache({ driver, sweepInterval: 0 });
    await cache.increment("c", 2);
    calls.length = 0;
    expect(await cache.get("c")).toBe(2);
    expect(await cache.get("none")).toBeUndefined();
    expect(calls).toEqual(["get", "getCounter", "get", "getCounter"]);
    await cache.close();
  });
});

describe("getMany's missing keys", () => {
  test("are read for a counter only: the batch already said no entry is there", async () => {
    const { driver, calls } = recorded(memoryDriver());
    const cache = createCache({ driver, sweepInterval: 0 });
    await cache.set("e", "v");
    await cache.increment("c", 5);
    calls.length = 0;
    expect(await cache.getMany(["e", "c", "none"])).toEqual([
      "v",
      5,
      undefined,
    ]);
    expect(calls.filter((call) => call !== "onEviction")).toEqual([
      "getMany",
      "getCounter",
      "getCounter",
    ]);
    await cache.close();
  });
});
