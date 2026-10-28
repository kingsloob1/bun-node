/**
 * At-rest encryption (the encryption plan, PR-E1): the envelope and its size,
 * the order encode → compress → encrypt, the decompression cap after
 * decrypt, `keyId` on `hit` and `stale-hit`, `acceptUnencrypted`, writes that
 * cannot seal, the entry limit on the sealed size, `touch` and the fail-safe
 * rewrite, distinct salts and nonces, counters, and `createCache`'s checks.
 * The attacks are in `encryption-attacks.test.ts`, the keys in
 * `encryption-keys.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import type { CacheEventMap } from "../../lib/index";
import { CacheDecryptError, createCache, memoryDriver } from "../../lib/index";
import { EntryEncryption, isEnvelope } from "../../lib/core/encrypt";
import {
  COMPRESSOR_IDS,
  decodeEntry,
  encodeEntry,
  NO_FRESH_UNTIL,
} from "../../lib/core/header";
import { zstdBomb } from "./bombs";
import {
  contains,
  decryptErrors,
  KEY_A,
  KEY_B,
  SENTINEL,
  setup,
  storedBytes,
  T0,
  testCipher,
} from "./encryptionHelpers";

/** The ring most tests use: one key, id `"2026-10"`. */
const RING = [{ id: "2026-10", key: KEY_A }];

/** Opens stored bytes the way the cache at namespace `ns` would, with `RING`. */
async function openStored(
  bytes: Uint8Array,
  key: string,
  ns = "cache",
): Promise<{
  entry: Uint8Array;
  expiresAt: number | null;
  tags: readonly string[];
  keyId: string | undefined;
}> {
  const encryption = new EntryEncryption(
    { keys: RING },
    { now: () => T0, timeout: undefined, onProviderError: () => {} },
  );
  const opened = await encryption.open(ns, key, bytes);
  if (opened === undefined) {
    throw new Error("not an envelope");
  }
  return opened;
}

describe("the envelope", () => {
  test("every entry is sealed: the value round-trips, and no plaintext is stored", async () => {
    const { cache, driver, errors } = setup({ encrypt: { keys: RING } });
    const value = { name: SENTINEL, roles: ["admin"] };
    expect(await cache.set("user:1", value, { tags: ["users"] })).toBe(true);
    expect(await cache.get("user:1")).toEqual(value);
    const bytes = await storedBytes(driver, "user:1");
    expect(isEnvelope(bytes)).toBe(true);
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([
      0x42, 0x45, 1, 1,
    ]);
    expect(bytes[4]).toBe(7);
    expect(new TextDecoder().decode(bytes.subarray(5, 12))).toBe("2026-10");
    expect(contains(bytes, SENTINEL)).toBe(false);
    // The full key lives in the sealed header, not in clear in the value.
    expect(contains(bytes, "user:1")).toBe(false);
    expect(errors).toEqual([]);
  });

  test("the size is the plan's: 49 + L bytes, plus the sealed body's 11 and each tag's 2 + length", async () => {
    const { cache, driver } = setup({
      encrypt: { keys: RING },
      codec: "raw",
      ttl: null,
    });
    await cache.set("k", "v".repeat(100), { tags: ["users", "org:7"] });
    const bytes = await storedBytes(driver, "k");
    const opened = await openStored(bytes, "k");
    const tagBytes = 2 + 5 + (2 + 5);
    expect(bytes.byteLength).toBe(
      opened.entry.byteLength + 49 + "2026-10".length + 11 + tagBytes,
    );
    expect(opened.tags).toEqual(["users", "org:7"]);
    expect(opened.expiresAt).toBeNull();
    expect(opened.keyId).toBe("2026-10");
    expect(decodeEntry(opened.entry).header.key).toBe("k");
  });

  test("encode → compress → encrypt: the sealed entry is the compressed one", async () => {
    const { cache, driver } = setup({ encrypt: { keys: RING } });
    const value = SENTINEL.repeat(2_000); // ~80 KB, compressible
    await cache.set("big", value);
    const bytes = await storedBytes(driver, "big");
    expect(bytes.byteLength).toBeLessThan(10_000);
    const { entry } = await openStored(bytes, "big");
    expect(decodeEntry(entry).header.compressor).toBe(COMPRESSOR_IDS.zstd);
    expect(await cache.get("big")).toBe(value);
  });

  test("a compressor's format-2 entry is sealed and read back too (br)", async () => {
    const { cache, driver } = setup({
      encrypt: { keys: RING },
      compress: { algorithm: "br", threshold: 64 },
    });
    await cache.set("page", SENTINEL.repeat(50));
    const { entry } = await openStored(
      await storedBytes(driver, "page"),
      "page",
    );
    expect(entry[2]).toBe(2);
    expect(decodeEntry(entry).header.compressor).toBe(COMPRESSOR_IDS.br);
    expect(await cache.get("page")).toBe(SENTINEL.repeat(50));
  });

  test("the decompression cap still holds after decrypt: a sealed bomb is a miss", async () => {
    const { cache, driver, errors } = setup({
      encrypt: { keys: RING },
      maxEntryBytes: 1024 * 1024,
    });
    // A bomb sealed with the cache's own key: only the cap stands between
    // the read and 64 MiB.
    const encryption = new EntryEncryption(
      { keys: RING },
      { now: () => T0, timeout: undefined, onProviderError: () => {} },
    );
    const entry = encodeEntry(
      {
        codecId: 3,
        flags: 0,
        compressor: COMPRESSOR_IDS.zstd,
        createdAt: T0,
        freshUntil: NO_FRESH_UNTIL,
        loadMs: 0,
        key: "bomb",
      },
      zstdBomb(64),
    );
    const sealed = await encryption.seal("cache", "bomb", entry, null, []);
    await driver.set("cache", {
      key: "bomb",
      value: sealed,
      expiresAt: null,
      tags: [],
    });
    expect(await cache.get("bomb")).toBeUndefined();
    expect(errors.map((event) => event.phase)).toEqual(["decode"]);
    expect(String((errors[0].error as Error).message)).toContain(
      "decompresses past",
    );
  });
});

describe("events", () => {
  test("hit and stale-hit carry the sealing key's id; an unencrypted cache's carry none", async () => {
    const hits: CacheEventMap["hit"][] = [];
    const stale: CacheEventMap["stale-hit"][] = [];
    const { cache, clock } = setup({ encrypt: { keys: RING } });
    cache.on("hit", (event) => hits.push(event));
    cache.on("stale-hit", (event) => stale.push(event));
    await cache.set("k", 1, { ttl: 1_000, staleWhileRevalidate: 10_000 });
    await cache.get("k");
    await cache.getMany(["k"]);
    await cache.getOrSet("k", () => 2);
    clock.advance(2_000);
    await cache.getEntry("k");
    await cache.getOrSet("k", () => 3, { staleWhileRevalidate: 10_000 });
    expect(hits.map((event) => event.keyId)).toEqual([
      "2026-10",
      "2026-10",
      "2026-10",
    ]);
    expect(stale.map((event) => event.keyId)).toEqual(["2026-10", "2026-10"]);

    const plain = setup();
    const plainHits: CacheEventMap["hit"][] = [];
    plain.cache.on("hit", (event) => plainHits.push(event));
    await plain.cache.set("k", 1);
    await plain.cache.get("k");
    expect(plainHits).toEqual([{ key: "k", namespace: "cache", tier: "l2" }]);
    expect("keyId" in plainHits[0]).toBe(false);
  });

  test("an L1 hit carries the key id of the entry it copied, from a write and from a read", async () => {
    const hits: CacheEventMap["hit"][] = [];
    // No bus: L1 serves at once (a bus would hold it until it listens).
    const { cache, driver, clock } = setup({
      encrypt: { keys: RING },
      l1: true,
      bus: false,
    });
    cache.on("hit", (event) => hits.push(event));
    await cache.set("written", 1);
    await cache.get("written");
    const reader = setup(
      { encrypt: { keys: RING }, l1: true, bus: false },
      { driver, clock },
    );
    const readerHits: CacheEventMap["hit"][] = [];
    reader.cache.on("hit", (event) => readerHits.push(event));
    await reader.cache.get("written");
    await reader.cache.get("written");
    expect(hits).toEqual([
      { key: "written", namespace: "cache", tier: "l1", keyId: "2026-10" },
    ]);
    expect(readerHits.map((event) => [event.tier, event.keyId])).toEqual([
      ["l2", "2026-10"],
      ["l1", "2026-10"],
    ]);
    await cache.close();
    await reader.cache.close();
  });

  test("a failed open is logged at most once per 10 s per reason, naming the key id only", async () => {
    const { cache, driver, logs, errors } = setup({ encrypt: { keys: RING } });
    const other = setup(
      { encrypt: { keys: [{ id: "2026-09", key: KEY_B }] } },
      { driver },
    );
    await other.cache.set("a", SENTINEL);
    await other.cache.set("b", SENTINEL);
    await driver.set("cache", {
      key: "plain",
      value: new TextEncoder().encode("not an envelope"),
      expiresAt: null,
      tags: [],
    });
    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.get("b")).toBeUndefined();
    expect(await cache.get("plain")).toBeUndefined();
    expect(decryptErrors(errors).map((error) => error.reason)).toEqual([
      "unknown-key",
      "unknown-key",
      "unencrypted",
    ]);
    const warnings = logs.filter((log) => log.level === "warn");
    expect(warnings.map((log) => log.message)).toEqual([
      'cache: an entry did not open (unknown-key, key id "2026-09"); read as a miss',
      "cache: an entry did not open (unencrypted); read as a miss",
    ]);
    for (const log of warnings) {
      expect(JSON.stringify(log)).not.toContain(SENTINEL);
    }
  });
});

describe("acceptUnencrypted", () => {
  /** Writes a plain entry with an unencrypted cache on `driver`. */
  async function writePlain(
    driver: ReturnType<typeof memoryDriver>,
  ): Promise<void> {
    const plain = createCache({ driver, sweepInterval: 0 });
    await plain.set("legacy", SENTINEL);
  }

  test('off (the default): a plain entry is a miss with an "unencrypted" error, and is not deleted', async () => {
    const { cache, driver, errors } = setup({ encrypt: { keys: RING } });
    await writePlain(driver);
    expect(await cache.get("legacy")).toBeUndefined();
    expect(decryptErrors(errors).map((error) => error.reason)).toEqual([
      "unencrypted",
    ]);
    expect(decryptErrors(errors)[0]).toBeInstanceOf(CacheDecryptError);
    expect(await driver.get("cache", "legacy")).toBeDefined();
  });

  test("on: a plain entry reads, and every write is still sealed", async () => {
    const { cache, driver, errors } = setup({
      encrypt: { keys: RING, acceptUnencrypted: true },
    });
    await writePlain(driver);
    expect(await cache.get("legacy")).toBe(SENTINEL);
    await cache.set("legacy", "rewritten");
    expect(isEnvelope(await storedBytes(driver, "legacy"))).toBe(true);
    expect(await cache.get("legacy")).toBe("rewritten");
    expect(errors).toEqual([]);
  });
});

describe("writes that cannot seal", () => {
  /** A user cipher whose seal throws. */
  const broken = {
    ...testCipher(),
    seal: () => {
      throw new Error("the HSM is down");
    },
  };

  test('resolve false with an "encrypt" error, store nothing, and never store plaintext', async () => {
    const { cache, driver, errors } = setup({ encrypt: { cipher: broken } });
    expect(await cache.set("k", SENTINEL)).toBe(false);
    expect(await driver.get("cache", "k")).toBeUndefined();
    expect(errors.map((event) => [event.phase, event.key])).toEqual([
      ["encrypt", "k"],
    ]);
    expect(cache.stats().sets).toBe(0);
  });

  test("throw under strict", async () => {
    const { cache } = setup({ encrypt: { cipher: broken }, strict: true });
    await expect(cache.set("k", 1)).rejects.toThrow("the HSM is down");
  });

  test("a getOrSet still answers the loaded value", async () => {
    const { cache, driver } = setup({ encrypt: { cipher: broken } });
    expect(await cache.getOrSet("k", () => "loaded")).toBe("loaded");
    expect(await driver.get("cache", "k")).toBeUndefined();
  });

  test("a sealing failure does not count against the driver's circuit", async () => {
    const opened: string[] = [];
    const { cache } = setup({
      encrypt: { cipher: broken },
      circuit: { failures: 2 },
    });
    cache.on("circuit-open", (event) => opened.push(event.driver));
    for (let i = 0; i < 5; i++) {
      await cache.set(`k${i}`, i);
    }
    expect(opened).toEqual([]);
  });
});

describe("limits and statistics count the sealed bytes", () => {
  test("maxEntryBytes holds the sealed size: a value that fits plain but not sealed is oversize", async () => {
    const oversize: CacheEventMap["oversize"][] = [];
    const plain = setup({ codec: "raw", compress: false });
    await plain.cache.set("k", "x".repeat(100));
    const plainSize = (await storedBytes(plain.driver, "k")).byteLength;
    const { cache, driver } = setup({
      codec: "raw",
      compress: false,
      encrypt: { keys: RING },
      maxEntryBytes: plainSize + 10,
    });
    cache.on("oversize", (event) => oversize.push(event));
    expect(await cache.set("k", "x".repeat(100))).toBe(false);
    expect(await driver.get("cache", "k")).toBeUndefined();
    expect(oversize).toEqual([
      {
        key: "k",
        namespace: "cache",
        bytes: plainSize + 49 + 7 + 11,
        limit: plainSize + 10,
      },
    ]);
  });

  test("the set event and stats().bytesWritten report the sealed size", async () => {
    const sets: CacheEventMap["set"][] = [];
    const { cache, driver } = setup({ encrypt: { keys: RING } });
    cache.on("set", (event) => sets.push(event));
    await cache.set("k", SENTINEL);
    const size = (await storedBytes(driver, "k")).byteLength;
    expect(sets[0].bytes).toBe(size);
    expect(cache.stats().bytesWritten).toBe(size);
    await cache.get("k");
    expect(cache.stats().bytesRead).toBe(size);
  });
});

describe("rewrites stay sealed", () => {
  test("touch rewrites a sealed entry, keeping its sealed tags", async () => {
    const { cache, driver, clock } = setup({ encrypt: { keys: RING } });
    await cache.set("k", SENTINEL, { ttl: 1_000, tags: ["t"] });
    expect(await cache.touch("k", 60_000)).toBe(true);
    clock.advance(30_000);
    const bytes = await storedBytes(driver, "k");
    const opened = await openStored(bytes, "k");
    expect(opened.tags).toEqual(["t"]);
    expect(opened.expiresAt).toBe(T0 + 60_000);
    expect(await cache.get("k")).toBe(SENTINEL);
  });

  test("the fail-safe backoff's rewrite is sealed", async () => {
    const { cache, driver, clock, errors } = setup({
      encrypt: { keys: RING },
      staleIfError: 60_000,
      failSafeBackoff: 5_000,
    });
    await cache.set("k", SENTINEL, { ttl: 1_000 });
    clock.advance(2_000);
    const value = await cache.getOrSet("k", () => {
      throw new Error("origin down");
    });
    expect(value).toBe(SENTINEL);
    // The backoff is written in the background.
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    await Bun.sleep(5);
    const bytes = await storedBytes(driver, "k");
    expect(isEnvelope(bytes)).toBe(true);
    const entry = await cache.getEntry("k");
    expect(entry?.stale).toBe(false);
    expect(entry?.freshUntil).toBe(T0 + 2_000 + 5_000);
    expect(errors.filter((event) => event.phase === "decrypt")).toEqual([]);
  });
});

describe("salts and nonces", () => {
  test("100,000 seals draw 100,000 distinct salts and nonces", () => {
    const encryption = new EntryEncryption(
      { keys: RING },
      { now: () => T0, timeout: undefined, onProviderError: () => {} },
    );
    const entry = new Uint8Array(40);
    const salts = new Set<string>();
    const nonces = new Set<string>();
    const saltAt = 5 + "2026-10".length;
    for (let i = 0; i < 100_000; i++) {
      const sealed = encryption.seal(
        "cache",
        "k",
        entry,
        null,
        [],
      ) as Uint8Array;
      salts.add(
        Buffer.from(sealed.subarray(saltAt, saltAt + 16)).toString("hex"),
      );
      nonces.add(
        Buffer.from(sealed.subarray(saltAt + 16, saltAt + 28)).toString("hex"),
      );
    }
    expect(salts.size).toBe(100_000);
    expect(nonces.size).toBe(100_000);
  });
});

describe("counters stay plaintext integers", () => {
  test("increment works on an encrypted cache, and the stored counter is a plain number", async () => {
    const { cache, driver } = setup({ encrypt: { keys: RING } });
    expect(await cache.increment("hits:home", 2)).toBe(2);
    expect(await cache.increment("hits:home")).toBe(3);
    expect(await cache.get("hits:home")).toBe(3);
    expect((await driver.getCounter?.("cache", "hits:home"))?.value).toBe(3);
  });
});

describe("createCache's checks", () => {
  /** Answers the TypeError `createCache` throws for `encrypt`, or fails. */
  function refused(encrypt: unknown): string {
    try {
      createCache({
        driver: memoryDriver(),
        sweepInterval: 0,
        encrypt: encrypt as never,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      return (error as Error).message;
    }
    throw new Error("createCache accepted it");
  }

  test("a key that is not 32 bytes, in any spelling, and never echoed", () => {
    for (const key of [
      new Uint8Array(31),
      new Uint8Array(33),
      "a passphrase, not a key",
      "00".repeat(31),
      Buffer.from(new Uint8Array(31)).toString("base64"),
      "",
    ]) {
      const message = refused({ keys: [{ id: "k1", key }] });
      expect(message).toContain("encrypt.keys[0].key must be exactly 32 bytes");
      expect(message).toContain("openssl rand -base64 32");
      if (typeof key === "string" && key !== "") {
        expect(message).not.toContain(key);
      }
    }
  });

  test("the spellings of one key: bytes, hex, base64 and base64url all read the same entry", async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const { cache, driver } = setup({
      encrypt: { keys: [{ id: "k", key: raw }] },
    });
    await cache.set("k", SENTINEL);
    for (const spelling of [
      Buffer.from(raw).toString("hex"),
      Buffer.from(raw).toString("hex").toUpperCase(),
      Buffer.from(raw).toString("base64"),
      Buffer.from(raw).toString("base64url"),
    ]) {
      const other = setup(
        { encrypt: { keys: [{ id: "k", key: spelling }] } },
        { driver },
      );
      expect(await other.cache.get("k")).toBe(SENTINEL);
    }
  });

  test("malformed, empty and duplicate key ids, and an empty ring", () => {
    expect(refused({ keys: [] })).toBe(
      "encrypt.keys must hold at least one key",
    );
    expect(refused({ keys: [{ id: "", key: KEY_A }] })).toContain(
      "encrypt.keys[0].id must be 1–32 characters",
    );
    expect(refused({ keys: [{ id: "a b", key: KEY_A }] })).toContain(
      "encrypt.keys[0].id",
    );
    expect(refused({ keys: [{ id: "x".repeat(33), key: KEY_A }] })).toContain(
      "encrypt.keys[0].id",
    );
    expect(
      refused({
        keys: [
          { id: "a", key: KEY_A },
          { id: "a", key: KEY_B },
        ],
      }),
    ).toBe('encrypt.keys[1].id "a" is already in the ring');
  });

  test("keys required by the built-in, refused beside a user cipher; keyRefresh only with a keys function", () => {
    expect(refused({})).toContain("encrypt.keys is required");
    expect(refused({ cipher: "aes-256-gcm" })).toContain(
      "encrypt.keys is required",
    );
    expect(refused({ cipher: testCipher(), keys: RING })).toContain(
      "a user cipher (encrypt.cipher) manages its own keys",
    );
    expect(refused({ keys: RING, keyRefresh: 1_000 })).toBe(
      "encrypt.keyRefresh applies to a keys function, not to a static ring",
    );
    expect(refused({ keys: () => RING, keyRefresh: 0 })).toContain(
      "encrypt.keyRefresh must be a positive number",
    );
    expect(refused({ cipher: "chacha20-poly1305", keys: RING })).toContain(
      'encrypt.cipher must be "aes-256-gcm" or a user cipher',
    );
  });

  test("cipher and previous ids outside 128–255, or taken twice", () => {
    expect(refused({ cipher: testCipher({ id: 1 }) })).toContain(
      "encrypt.cipher: a user cipher's id must be an integer in 128–255",
    );
    expect(refused({ cipher: testCipher({ id: 256 }) })).toContain("128–255");
    expect(
      refused({
        cipher: testCipher({ id: 200 }),
        previous: [testCipher({ id: 200 })],
      }),
    ).toBe(
      "encrypt.previous[0]: cipher id 200 is already taken by another cipher",
    );
    expect(
      refused({ keys: RING, previous: [testCipher({ id: 127 })] }),
    ).toContain("encrypt.previous[0]: a user cipher's id");
    expect(refused({ keys: RING, previous: [{ id: 130 }] })).toContain(
      "encrypt.previous[0] must be",
    );
  });

  test("aad over 1 KiB", () => {
    expect(refused({ keys: RING, aad: "x".repeat(1025) })).toBe(
      "encrypt.aad is at most 1024 bytes, not 1025",
    );
    expect(() =>
      createCache({
        driver: memoryDriver(),
        sweepInterval: 0,
        encrypt: { keys: RING, aad: "x".repeat(1024) },
      }),
    ).not.toThrow();
  });
});
