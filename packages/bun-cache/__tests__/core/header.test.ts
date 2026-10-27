/**
 * The entry header (plan §3.2): the byte layout, the corruption cases that
 * read as misses, and the pin that notices a format change (§18).
 */
import { describe, expect, test } from "bun:test";
import {
  decodeEntry,
  encodeEntry,
  ENTRY_FLAGS,
  EntryDecodeError,
  NO_FRESH_UNTIL,
} from "../../lib/core/header";
import { createCache, memoryDriver } from "../../lib/index";
import { makeCache } from "../helpers";

describe("the entry header", () => {
  test("round-trips every field", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const bytes = encodeEntry(
      {
        codecId: 1,
        flags: ENTRY_FLAGS.zstd | ENTRY_FLAGS.negative,
        createdAt: 1_700_000_000_000,
        freshUntil: 1_700_000_060_000,
        loadMs: 42.5,
        key: "user:42",
      },
      payload,
    );
    const { header, payload: readPayload } = decodeEntry(bytes);
    expect(header).toEqual({
      codecId: 1,
      flags: ENTRY_FLAGS.zstd | ENTRY_FLAGS.negative,
      createdAt: 1_700_000_000_000,
      freshUntil: 1_700_000_060_000,
      loadMs: 42.5,
      key: "user:42",
    });
    expect(readPayload).toEqual(payload);
  });

  test("pins the format's first bytes, so a Bun or format change is noticed (§18)", () => {
    const bytes = encodeEntry(
      {
        codecId: 1,
        flags: 0,
        createdAt: 0,
        freshUntil: NO_FRESH_UNTIL,
        loadMs: 0,
        key: "k",
      },
      new Uint8Array([0xde, 0xad]),
    );
    // "BC", format 1, codec 1, flags 0; createdAt 0; freshUntil -1 (f64);
    // loadMs 0; key length 1; "k"; the payload.
    expect([...bytes]).toEqual([
      0x42, 0x43, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 240, 191,
      0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0x6b, 0xde, 0xad,
    ]);
  });

  test("garbage, a bad magic, a wrong format and a truncated key all throw EntryDecodeError", () => {
    expect(() => decodeEntry(new Uint8Array(0))).toThrow(EntryDecodeError);
    expect(() => decodeEntry(new Uint8Array(10))).toThrow(EntryDecodeError);
    const good = encodeEntry(
      {
        codecId: 1,
        flags: 0,
        createdAt: 0,
        freshUntil: NO_FRESH_UNTIL,
        loadMs: 0,
        key: "k",
      },
      new Uint8Array(0),
    );
    const badMagic = good.slice();
    badMagic[0] = 0x00;
    expect(() => decodeEntry(badMagic)).toThrow(EntryDecodeError);
    const badFormat = good.slice();
    badFormat[2] = 99;
    expect(() => decodeEntry(badFormat)).toThrow(EntryDecodeError);
    expect(() => decodeEntry(good.slice(0, good.length - 1))).toThrow(
      EntryDecodeError,
    );
  });

  test("a corrupt entry is a miss, is deleted, and fires error with phase decode (§3.2)", async () => {
    const driver = memoryDriver();
    // A foreign byte string at the key, behind the cache's back.
    await driver.set("cache", {
      key: "k",
      value: new TextEncoder().encode("not a bun-cache entry"),
      expiresAt: null,
      tags: [],
    });
    const errors: { phase?: string; key?: string }[] = [];
    const cache = createCache({ driver, sweepInterval: 0 });
    cache.on("error", (event) => {
      errors.push({ phase: event.phase, key: event.key });
    });
    expect(await cache.get("k")).toBeUndefined();
    expect(errors).toEqual([{ phase: "decode", key: "k" }]);
    // The corrupt entry was deleted.
    expect(await driver.get("cache", "k")).toBeUndefined();
    await cache.close();
  });

  test("a long key is stored hashed, and the full key in the header guards collisions (§3.7)", async () => {
    const { cache } = makeCache({ maxKeyLength: 16 });
    const long = `k${"x".repeat(100)}`;
    await cache.set(long, "v");
    expect(await cache.get(long)).toBe("v");
    await cache.close();
  });
});
