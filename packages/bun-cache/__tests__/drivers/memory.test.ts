/**
 * The memory driver (plan §7.1): the conformance kit's first proof, plus the
 * driver-specific behaviors — LRU and byte caps, instance isolation, the
 * local bus.
 */
import { describe, expect, test } from "bun:test";
import type { StoredEntry } from "../../lib/index";
import { memoryDriver } from "../../lib/index";
import { memoryDriverDump } from "../../lib/drivers/memory";
import { runCacheDriverConformance } from "../../lib/testing/index";

// The kit's first proof: the memory driver conforms. Its raw store is its
// maps, through the driver's test hook.
await runCacheDriverConformance("memory", () => {
  const driver = memoryDriver();
  return { driver, rawDump: () => memoryDriverDump(driver) };
});

describe("memoryDriver specifics", () => {
  const entry = (key: string, size: number): StoredEntry => ({
    key,
    value: new Uint8Array(size),
    expiresAt: null,
    tags: [],
  });

  test("maxEntries evicts least-recently-used first, with a report per eviction", async () => {
    const driver = memoryDriver({ maxEntries: 2 });
    const evicted: string[] = [];
    driver.onEviction!((_ns, key) => {
      evicted.push(key);
    });
    await driver.set("ns", entry("a", 1));
    await driver.set("ns", entry("b", 1));
    await driver.get("ns", "a"); // a is now the most recently used
    await driver.set("ns", entry("c", 1)); // evicts b, not a
    expect(evicted).toEqual(["b"]);
    expect(await driver.get("ns", "a")).toBeDefined();
    expect(await driver.get("ns", "b")).toBeUndefined();
    await driver.close();
  });

  test("maxBytes caps the encoded bytes", async () => {
    const driver = memoryDriver({ maxBytes: 100 });
    await driver.set("ns", entry("a", 60));
    await driver.set("ns", entry("b", 60)); // evicts a
    expect(await driver.get("ns", "a")).toBeUndefined();
    expect((await driver.get("ns", "b"))?.value).toHaveLength(60);
    await driver.close();
  });

  test("two instances share nothing", async () => {
    const one = memoryDriver();
    const two = memoryDriver();
    await one.set("ns", entry("k", 1));
    expect(await two.get("ns", "k")).toBeUndefined();
    await one.close();
    await two.close();
  });
});
