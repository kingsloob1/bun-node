/**
 * The one-round-trip read (`lib/core/read.ts`) on a driver that offers it
 * (Postgres, MySQL, MariaDB, MongoDB): it answers what `get` and
 * `getCounter` answer, the core uses it for every read, and a wrapper that
 * replaced `get` is read through its own `get`. Registered by `sqlSuite.ts`
 * and `mongodb.test.ts`.
 */
import process from "node:process";
import { expect, test } from "bun:test";
import type { CacheDriver, StoredEntry } from "../../lib/index";
import { createCache } from "../../lib/index";
import type { EntryOrCounterReader } from "../../lib/core/read";
import { ENTRY_OR_COUNTER, entryOrCounterReader } from "../../lib/core/read";

/** A stored entry of `bytes`. */
function entry(
  key: string,
  bytes: number[],
  expiresAt: number | null = null,
): StoredEntry {
  return { key, value: new Uint8Array(bytes), expiresAt, tags: [] };
}

/** The reader the driver offers, read straight off it. */
function readerOf(driver: CacheDriver): EntryOrCounterReader {
  return (driver as unknown as { [ENTRY_OR_COUNTER]: EntryOrCounterReader })[
    ENTRY_OR_COUNTER
  ];
}

/** Registers the tests on `driver`, each in a namespace of its own. */
export function registerEntryOrCounterTests(
  /** The driver under test; closed by the caller. */
  driver: CacheDriver,
): void {
  let serial = 0;
  const ns = (): string => `eoc-${process.pid}-${++serial}`;

  test("the one-round-trip read answers what get and getCounter answer, key by key", async () => {
    const namespace = ns();
    const reader = entryOrCounterReader(driver);
    expect(reader).toBeDefined();
    await driver.set(namespace, entry("e", [1, 2, 3]));
    await driver.increment!(namespace, "c", 7, null);
    await driver.increment!(namespace, "gone", 1, Date.now() + 40);
    await driver.set(namespace, entry("old", [9], Date.now() + 40));
    await driver.increment!(namespace, "flip", 2, null);
    await driver.set(namespace, entry("flip", [4]));
    await driver.set(namespace, entry("flop", [5]));
    await driver.increment!(namespace, "flop", 3, null);
    await Bun.sleep(80);
    for (const key of ["e", "c", "gone", "old", "flip", "flop", "none"]) {
      const viaContract = await driver.get(namespace, key);
      const counter = await driver.getCounter!(namespace, key);
      const expected =
        viaContract !== undefined
          ? { entry: viaContract }
          : counter !== undefined
            ? { counter }
            : undefined;
      expect({ key, read: await reader!.read(namespace, key) }).toEqual({
        key,
        read: expected,
      });
    }
    // And what each key holds, so the comparison above compared something.
    expect(await reader!.read(namespace, "e")).toMatchObject({
      entry: { key: "e", value: new Uint8Array([1, 2, 3]) },
    });
    expect(await reader!.read(namespace, "c")).toMatchObject({
      counter: { value: 7, expiresAt: null },
    });
    expect(await reader!.read(namespace, "flip")).toMatchObject({
      entry: { value: new Uint8Array([4]) },
    });
    expect(await reader!.read(namespace, "flop")).toMatchObject({
      counter: { value: 3 },
    });
    for (const key of ["gone", "old", "none"]) {
      expect(await reader!.read(namespace, key)).toBeUndefined();
    }
  });

  test("a cache reads every key with it, once, and never asks getCounter", async () => {
    const reader = readerOf(driver);
    const read = reader.read;
    let reads = 0;
    // Counted on the reader itself: the driver's `get` and `getCounter`
    // stay the ones the reader stands for, so the cache uses it.
    (reader as { read: EntryOrCounterReader["read"] }).read = async (
      ...args
    ) => {
      reads++;
      return await read(...args);
    };
    try {
      const cache = createCache({ driver, namespace: ns(), sweepInterval: 0 });
      await cache.set("e", { a: 1 });
      await cache.increment("c", 4);
      reads = 0;
      expect(await cache.get("e")).toEqual({ a: 1 });
      expect(await cache.get("c")).toBe(4);
      expect(await cache.get("none")).toBeUndefined();
      expect(await cache.has("none")).toBe(false);
      expect(reads).toBe(4);
    } finally {
      (reader as { read: EntryOrCounterReader["read"] }).read = read;
    }
  });

  test("a wrapper that replaced get or getCounter is read through them, not around them", async () => {
    const namespace = ns();
    await driver.increment!(namespace, "c", 5, null);
    await createCache({ driver, namespace, sweepInterval: 0 }).set("e", "v");
    const reader = readerOf(driver);
    const read = reader.read;
    let reads = 0;
    (reader as { read: EntryOrCounterReader["read"] }).read = async (
      ...args
    ) => {
      reads++;
      return await read(...args);
    };
    try {
      for (const replaced of ["get", "getCounter"] as const) {
        const seen: string[] = [];
        // The instance's own method shadows its class's (a wrapper that
        // hides key "e" and records what it was asked); the symbol is still
        // there, unchanged.
        const original = driver[replaced]! as (
          ns: string,
          key: string,
        ) => Promise<unknown>;
        Object.defineProperty(driver, replaced, {
          configurable: true,
          writable: true,
          async value(
            this: CacheDriver,
            ns: string,
            key: string,
          ): Promise<unknown> {
            seen.push(key);
            return key === "e" ? undefined : await original.call(this, ns, key);
          },
        });
        try {
          expect(entryOrCounterReader(driver)).toBeUndefined();
          const cache = createCache({ driver, namespace, sweepInterval: 0 });
          reads = 0;
          const counter = await cache.get("c");
          const value = await cache.get("e");
          expect(reads).toBe(0);
          expect(counter).toBe(5);
          if (replaced === "get") {
            // The replaced `get` was asked for both keys, and hid "e".
            expect(value).toBeUndefined();
            expect(seen).toEqual(["c", "e"]);
          } else {
            // The replaced `getCounter` answered the counter; "e" was an entry.
            expect(value).toBe("v");
            expect(seen).toEqual(["c"]);
          }
        } finally {
          delete (driver as unknown as Record<string, unknown>)[replaced];
        }
      }
      // A delegating Proxy that hands out bound copies is read through them too.
      const bound = new Proxy(driver, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      expect(entryOrCounterReader(bound)).toBeUndefined();
      expect(entryOrCounterReader(driver)).toBeDefined();
    } finally {
      (reader as { read: EntryOrCounterReader["read"] }).read = read;
    }
  });
}
