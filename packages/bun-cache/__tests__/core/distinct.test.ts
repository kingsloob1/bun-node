/**
 * Distinct counts on the cache (`pfAdd`/`pfCount`): inputs, a TTL set at
 * creation, unions, a long list sent in chunks, elements and keys hashed
 * under `encrypt.hashNames`, `delete` and `clear`, the refusal on a driver
 * without `distinctCount`, and a failure thrown under the default policy.
 */
import { describe, expect, test } from "bun:test";
import {
  createCache,
  fromSimpleDriver,
  memoryDriver,
  UnsupportedOperationError,
} from "../../lib/index";
import { faulty } from "../../lib/testing/index";
import { makeCache } from "../helpers";

/** A memory driver (through `faulty()`, a plain forwarding object) whose `pfAdd` and `pfCount` calls are recorded. */
function spiedMemory() {
  const driver = faulty(memoryDriver());
  const pfAdd = driver.pfAdd!;
  const pfCount = driver.pfCount!;
  const calls: {
    op: string;
    ns: string;
    keys: readonly string[];
    elements?: readonly string[];
    ttl?: number | null;
  }[] = [];
  driver.pfAdd = async (ns, key, elements, ttl) => {
    calls.push({ op: "pfAdd", ns, keys: [key], elements, ttl });
    return await pfAdd(ns, key, elements, ttl);
  };
  driver.pfCount = async (ns, keys) => {
    calls.push({ op: "pfCount", ns, keys });
    return await pfCount(ns, keys);
  };
  return { driver, calls };
}

describe("pfAdd and pfCount", () => {
  test("take one element or a list, answer whether the sketch changed, and count unions", async () => {
    const { cache } = makeCache();
    expect(await cache.pfAdd("ips:alice", "203.0.113.1")).toBe(true);
    expect(await cache.pfAdd("ips:alice", ["203.0.113.1", "203.0.113.2"])).toBe(
      true,
    );
    expect(await cache.pfAdd("ips:alice", ["203.0.113.2"])).toBe(false);
    expect(await cache.pfCount("ips:alice")).toBe(2);
    await cache.pfAdd("ips:bob", ["203.0.113.2", "198.51.100.9"]);
    expect(await cache.pfCount(["ips:alice", "ips:bob"])).toBe(3);
    expect(await cache.pfCount([])).toBe(0);
    expect(await cache.pfCount("nobody")).toBe(0);
    await cache.close();
  });

  test("the TTL is set at creation only, by the clock the driver keeps", async () => {
    const { cache, clock } = makeCache();
    await cache.pfAdd("w", ["a"], { ttl: 60_000 });
    clock.advance(30_000);
    await cache.pfAdd("w", ["b"], { ttl: 3_600_000 });
    expect(await cache.pfCount("w")).toBe(2);
    clock.advance(30_001);
    expect(await cache.pfCount("w")).toBe(0);
    await cache.close();
  });

  test("a sketch is not an entry: get misses it, delete and clear remove it", async () => {
    const { cache } = makeCache();
    await cache.pfAdd("k", ["a", "b"]);
    expect(await cache.get("k")).toBeUndefined();
    await cache.set("k", "an entry");
    expect(await cache.get("k")).toBe("an entry");
    expect(await cache.pfCount("k")).toBe(2);
    await cache.delete("k");
    expect(await cache.pfCount("k")).toBe(0);
    await cache.pfAdd("k2", ["a"]);
    await cache.clear();
    expect(await cache.pfCount("k2")).toBe(0);
    await cache.close();
  });

  test("namespace views keep their sketches apart", async () => {
    const { cache } = makeCache();
    await cache.namespace("a").pfAdd("k", ["x"]);
    expect(await cache.namespace("b").pfCount("k")).toBe(0);
    expect(await cache.namespace("a").pfCount("k")).toBe(1);
    await cache.close();
  });

  test("a long list goes in chunks of 1,000, the TTL the same on each", async () => {
    const { driver, calls } = spiedMemory();
    const cache = createCache({ driver, sweepInterval: 0 });
    const elements = Array.from({ length: 2_500 }, (_, i) => `e${i}`);
    expect(await cache.pfAdd("big", elements, { ttl: 60_000 })).toBe(true);
    expect(calls.map((call) => call.elements?.length)).toEqual([
      1_000, 1_000, 500,
    ]);
    expect(calls.map((call) => call.ttl)).toEqual([60_000, 60_000, 60_000]);
    const count = await cache.pfCount("big");
    expect(Math.abs(count - 2_500) / 2_500).toBeLessThanOrEqual(0.03);
    // An empty list still reaches the driver once (it creates the sketch).
    calls.length = 0;
    expect(await cache.pfAdd("empty", [])).toBe(true);
    expect(calls).toHaveLength(1);
    await cache.close();
  });

  test("under encrypt.hashNames the driver sees neither the keys nor the elements, and counts the same", async () => {
    const { driver, calls } = spiedMemory();
    const cache = createCache({
      driver,
      sweepInterval: 0,
      encrypt: {
        keys: [{ id: "k1", key: new Uint8Array(32).fill(7) }],
        hashNames: { key: new Uint8Array(32).fill(9) },
      },
    });
    await cache.pfAdd("usernames:203.0.113.5", [
      "alice@example.com",
      "bob@example.com",
    ]);
    await cache.pfAdd("usernames:203.0.113.5", ["alice@example.com"]);
    expect(await cache.pfCount("usernames:203.0.113.5")).toBe(2);
    const seen = JSON.stringify(calls);
    for (const plaintext of [
      "alice@example.com",
      "bob@example.com",
      "usernames:203.0.113.5",
    ]) {
      expect(seen).not.toContain(plaintext);
    }
    // Negative control: without hashNames the driver sees them.
    const plain = spiedMemory();
    const open = createCache({ driver: plain.driver, sweepInterval: 0 });
    await open.pfAdd("usernames:203.0.113.5", ["alice@example.com"]);
    expect(JSON.stringify(plain.calls)).toContain("alice@example.com");
    await cache.close();
    await open.close();
  });

  test("refuses bad input", async () => {
    const { cache } = makeCache();
    for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(cache.pfAdd("k", ["a"], { ttl })).rejects.toThrow(TypeError);
    }
    await expect(cache.pfAdd("k", [1] as unknown as string[])).rejects.toThrow(
      TypeError,
    );
    await expect(
      cache.pfAdd("k", { a: 1 } as unknown as string[]),
    ).rejects.toThrow(TypeError);
    await cache.close();
  });

  test("a driver without distinctCount refuses both, naming the capability", async () => {
    const map = new Map<string, unknown>();
    const cache = createCache({
      driver: fromSimpleDriver({
        get: async () => undefined,
        set: async (_ns, entry) => {
          map.set(entry.key, entry);
        },
        delete: async () => false,
      }),
      sweepInterval: 0,
    });
    await expect(cache.pfAdd("k", ["a"])).rejects.toThrow(
      UnsupportedOperationError,
    );
    await expect(cache.pfCount("k")).rejects.toThrow(/distinctCount/);
    await cache.close();
  });

  test("a failing driver throws, even under the default policy (no honest fallback for a count)", async () => {
    const driver = faulty(memoryDriver());
    const cache = createCache({ driver, sweepInterval: 0 });
    expect(driver.capabilities.distinctCount).toBe(true);
    driver.setFaults({ failRate: 1 });
    await expect(cache.pfAdd("k", ["a"])).rejects.toThrow();
    await expect(cache.pfCount("k")).rejects.toThrow();
    driver.setFaults({});
    expect(await cache.pfAdd("k", ["a"])).toBe(true);
    await cache.close();
  });
});
