/**
 * What a writer to the store can and cannot do to an encrypted cache (the
 * encryption plan's §2.1, §4.3, §4.5, §4.6): a tampered byte in any region, a
 * swap within a namespace, a copy across namespaces or across caches with
 * another `aad`, a wrong or unknown key — each a miss with a `"decrypt"`
 * error, never deleted; stripped tags and a raised expiry gain nothing; a
 * replay of an older ciphertext of the same key is served (documented, not
 * preventable without a server-side version). Each guarantee has its control
 * on an unencrypted cache, where the same attack works.
 */
import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheDecryptError, CacheDriver } from "../../lib/index";
import { createCache, fileDriver, sqliteDriver } from "../../lib/index";
import { fakeClock } from "../../lib/testing/index";
import {
  decryptErrors,
  KEY_A,
  KEY_B,
  SENTINEL,
  setup,
  storedBytes,
  T0,
  testCipher,
} from "./encryptionHelpers";

/** The ring the victim cache uses. */
const RING = [{ id: "2026-10", key: KEY_A }];

/** Copies the stored entry at `from` over `to` (both in `fromNs`/`toNs`), as a store writer would. */
async function copyEntry(
  driver: CacheDriver,
  from: string,
  to: string,
  fromNs = "cache",
  toNs = fromNs,
): Promise<void> {
  const source = await driver.get(fromNs, from);
  if (source === undefined) {
    throw new Error(`nothing at ${fromNs}/${from}`);
  }
  await driver.set(toNs, { ...source, key: to });
}

describe("tampering", () => {
  /** Where each region of a built-in envelope with the 7-byte id "2026-10" lies, and what a flipped bit there reads as. */
  const L = 7;
  const REGIONS: {
    region: string;
    at: (length: number) => number;
    reason: CacheDecryptError["reason"];
    /** The bit flipped; 0x01 unless said. */
    bit?: number;
  }[] = [
    { region: "the version byte", at: () => 2, reason: "malformed" },
    { region: "the cipher id", at: () => 3, reason: "cipher" },
    // 7 → 6 names another id ("2026-1"); 7 → 71 is past the 32-byte cap.
    { region: "the key id length", at: () => 4, reason: "unknown-key" },
    {
      region: "the key id length's high bit",
      at: () => 4,
      reason: "malformed",
      bit: 0x40,
    },
    { region: "the key id", at: () => 5 + 6, reason: "unknown-key" },
    { region: "the salt", at: () => 5 + L + 3, reason: "auth" },
    { region: "the nonce", at: () => 5 + L + 16 + 5, reason: "auth" },
    {
      region: "the ciphertext",
      at: (length) => (5 + L + 28 + length - 16) >> 1,
      reason: "auth",
    },
    { region: "the tag", at: (length) => length - 3, reason: "auth" },
  ];

  for (const { region, at, reason, bit } of REGIONS) {
    test(`a flipped bit in ${region} is a miss (${reason}), and the entry is not deleted`, async () => {
      const { cache, driver, errors } = setup({ encrypt: { keys: RING } });
      await cache.set("k", SENTINEL);
      const stored = (await driver.get("cache", "k"))!;
      const value = stored.value.slice();
      value[at(value.length)] ^= bit ?? 0x01;
      await driver.set("cache", { ...stored, value });
      expect(await cache.get("k")).toBeUndefined();
      expect(decryptErrors(errors).map((error) => error.reason)).toEqual([
        reason,
      ]);
      expect(await driver.get("cache", "k")).toBeDefined();
    });
  }

  test("a truncated envelope is a miss (malformed)", async () => {
    const { cache, driver, errors } = setup({ encrypt: { keys: RING } });
    await cache.set("k", SENTINEL);
    const stored = (await driver.get("cache", "k"))!;
    await driver.set("cache", {
      ...stored,
      value: stored.value.subarray(0, 30),
    });
    expect(await cache.get("k")).toBeUndefined();
    expect(decryptErrors(errors).map((error) => error.reason)).toEqual([
      "malformed",
    ]);
  });
});

describe("swaps and copies", () => {
  test("swapping two entries in one namespace makes both misses", async () => {
    const { cache, driver, errors } = setup({ encrypt: { keys: RING } });
    await cache.set("user:1", { name: "alice", admin: true });
    await cache.set("user:2", { name: "bob", admin: false });
    const one = (await driver.get("cache", "user:1"))!;
    const two = (await driver.get("cache", "user:2"))!;
    await driver.set("cache", { ...one, key: "user:2" });
    await driver.set("cache", { ...two, key: "user:1" });
    expect(await cache.get("user:1")).toBeUndefined();
    expect(await cache.get("user:2")).toBeUndefined();
    expect(decryptErrors(errors).map((error) => error.reason)).toEqual([
      "auth",
      "auth",
    ]);
  });

  test("control, unencrypted: the same swap serves alice's admin record as user:2", async () => {
    const { cache, driver } = setup();
    await cache.set("user:1", { name: "alice", admin: true });
    await cache.set("user:2", { name: "bob", admin: false });
    // An unencrypted entry carries its key in clear, so a store writer
    // rewrites it as well: the header's key check is no guard there.
    const plain = setup({}, { driver });
    const alice = await plain.cache.get("user:1");
    await plain.cache.set("user:2", alice);
    expect(await cache.get("user:2")).toEqual({ name: "alice", admin: true });
  });

  test("copying tenant a's entry over tenant b's, across namespaces, is a miss", async () => {
    const { driver, clock } = setup();
    const a = setup(
      { namespace: "tenant-a", encrypt: { keys: RING } },
      { driver, clock },
    );
    const b = setup(
      { namespace: "tenant-b", encrypt: { keys: RING } },
      { driver, clock },
    );
    await a.cache.set("invoice:8", { total: 1_000, tenant: "a" });
    await b.cache.set("invoice:8", { total: 5, tenant: "b" });
    await copyEntry(driver, "invoice:8", "invoice:8", "tenant-a", "tenant-b");
    expect(await b.cache.get("invoice:8")).toBeUndefined();
    expect(decryptErrors(b.errors).map((error) => error.reason)).toEqual([
      "auth",
    ]);
  });

  test("control, unencrypted: the same copy serves tenant a's invoice in tenant b", async () => {
    const { driver, clock } = setup();
    const a = setup({ namespace: "tenant-a" }, { driver, clock });
    const b = setup({ namespace: "tenant-b" }, { driver, clock });
    await a.cache.set("invoice:8", { total: 1_000, tenant: "a" });
    await b.cache.set("invoice:8", { total: 5, tenant: "b" });
    await copyEntry(driver, "invoice:8", "invoice:8", "tenant-a", "tenant-b");
    expect(await b.cache.get("invoice:8")).toEqual({
      total: 1_000,
      tenant: "a",
    });
  });

  test("an entry written under another aad does not open, under the same key", async () => {
    const staging = setup({ encrypt: { keys: RING, aad: "staging" } });
    const prod = setup(
      { encrypt: { keys: RING, aad: "prod" } },
      { driver: staging.driver, clock: staging.clock },
    );
    await staging.cache.set("config", { debug: true });
    expect(await prod.cache.get("config")).toBeUndefined();
    expect(decryptErrors(prod.errors).map((error) => error.reason)).toEqual([
      "auth",
    ]);
    const sameAad = setup(
      { encrypt: { keys: RING, aad: new TextEncoder().encode("staging") } },
      { driver: staging.driver, clock: staging.clock },
    );
    expect(await sameAad.cache.get("config")).toEqual({ debug: true });
  });
});

describe("wrong and unknown keys", () => {
  test("a ring without the writer's key id: a miss (unknown-key), not deleted; the right ring then reads it", async () => {
    const writer = setup({ encrypt: { keys: RING } });
    const stranger = setup(
      { encrypt: { keys: [{ id: "2026-11", key: KEY_B }] } },
      { driver: writer.driver, clock: writer.clock },
    );
    await writer.cache.set("k", SENTINEL);
    expect(await stranger.cache.get("k")).toBeUndefined();
    expect(await stranger.cache.getEntry("k")).toBeUndefined();
    const [error] = decryptErrors(stranger.errors);
    expect([error.reason, error.keyId]).toEqual(["unknown-key", "2026-10"]);
    expect(error.message).toBe(
      'cache entry did not open (unknown-key, key id "2026-10")',
    );
    // Let any background delete run: there must be none.
    await Bun.sleep(5);
    expect(await writer.driver.get("cache", "k")).toBeDefined();
    expect(await writer.cache.get("k")).toBe(SENTINEL);
  });

  test("the writer's id with other key bytes: a miss (auth), not deleted", async () => {
    const writer = setup({ encrypt: { keys: RING } });
    const impostor = setup(
      { encrypt: { keys: [{ id: "2026-10", key: KEY_B }] } },
      { driver: writer.driver, clock: writer.clock },
    );
    await writer.cache.set("k", SENTINEL);
    expect(await impostor.cache.get("k")).toBeUndefined();
    expect(decryptErrors(impostor.errors).map((error) => error.reason)).toEqual(
      ["auth"],
    );
    await Bun.sleep(5);
    expect(await writer.cache.get("k")).toBe(SENTINEL);
  });

  test("a getOrSet over an entry that does not open loads, and overwrites it", async () => {
    const writer = setup({ encrypt: { keys: RING } });
    const other = setup(
      { encrypt: { keys: [{ id: "2026-11", key: KEY_B }] } },
      { driver: writer.driver, clock: writer.clock },
    );
    await writer.cache.set("k", "old");
    expect(await other.cache.getOrSet("k", () => "loaded")).toBe("loaded");
    expect(await other.cache.get("k")).toBe("loaded");
  });

  test("a decrypt failure is never thrown, not even under strict", async () => {
    const writer = setup({ encrypt: { keys: RING } });
    const strict = setup(
      { encrypt: { keys: [{ id: "x", key: KEY_B }] }, strict: true },
      { driver: writer.driver, clock: writer.clock },
    );
    await writer.cache.set("k", 1);
    expect(await strict.cache.get("k")).toBeUndefined();
  });
});

describe("the sealed tags win over the store's", () => {
  /** Rewrites the stored entry at `key` with no tags: in its clear copy and, on an index driver, out of the index. */
  async function stripTags(driver: CacheDriver, key: string): Promise<void> {
    const stored = (await driver.get("cache", key))!;
    await driver.delete("cache", [key]);
    await driver.set("cache", { ...stored, tags: [] });
  }

  /** Each kind of driver: the memory driver (an index), SQLite (an index in tables), and the file driver (stamps). */
  const DRIVERS: {
    name: string;
    make: (clock: ReturnType<typeof fakeClock>) => Promise<{
      driver: CacheDriver;
      cleanup: () => Promise<void>;
    }>;
  }[] = [
    {
      name: "memory (index)",
      make: async (clock) => {
        const { memoryDriver } = await import("../../lib/index");
        return {
          driver: memoryDriver({ now: clock.now }),
          cleanup: async () => {},
        };
      },
    },
    {
      name: "sqlite (index)",
      make: async (clock) => {
        const dir = await mkdtemp(join(tmpdir(), "bc-e1-sqlite-"));
        const driver = sqliteDriver({
          path: join(dir, "cache.db"),
          now: clock.now,
        });
        return {
          driver,
          cleanup: async () => {
            await driver.close();
            await rm(dir, { recursive: true, force: true });
          },
        };
      },
    },
    {
      name: "file (stamps)",
      make: async (clock) => {
        const dir = await mkdtemp(join(tmpdir(), "bc-e1-file-"));
        const driver = fileDriver({ root: dir, now: clock.now });
        return {
          driver,
          cleanup: async () => {
            await driver.close();
            await rm(dir, { recursive: true, force: true });
          },
        };
      },
    },
  ];

  for (const { name, make } of DRIVERS) {
    test(`${name}: an entry whose tags were stripped in the store misses after invalidateTags`, async () => {
      const clock = fakeClock(T0);
      const { driver, cleanup } = await make(clock);
      try {
        const cache = createCache({
          driver,
          now: clock.now,
          sweepInterval: 0,
          encrypt: { keys: RING },
        });
        await cache.set("report", SENTINEL, { tags: ["org:7"] });
        await stripTags(driver, "report");
        clock.advance(10);
        await cache.invalidateTags(["org:7"]);
        expect(await cache.get("report")).toBeUndefined();
        // Another process, with no stamp cached: the driver's stamp decides.
        const peer = createCache({
          driver,
          now: clock.now,
          sweepInterval: 0,
          encrypt: { keys: RING },
        });
        expect(await peer.get("report")).toBeUndefined();
        // A value written after the invalidation is served.
        clock.advance(10);
        await cache.set("report", "fresh", { tags: ["org:7"] });
        expect(await peer.get("report")).toBe("fresh");
      } finally {
        await cleanup();
      }
    });

    test(`${name}, control: unencrypted, the stripped entry survives invalidateTags`, async () => {
      const clock = fakeClock(T0);
      const { driver, cleanup } = await make(clock);
      try {
        const cache = createCache({ driver, now: clock.now, sweepInterval: 0 });
        await cache.set("report", SENTINEL, { tags: ["org:7"] });
        await stripTags(driver, "report");
        clock.advance(10);
        await cache.invalidateTags(["org:7"]);
        expect(await cache.get("report")).toBe(SENTINEL);
      } finally {
        await cleanup();
      }
    });
  }

  test("getEntry reports the sealed tags, not the store's", async () => {
    const { cache, driver } = setup({ encrypt: { keys: RING } });
    await cache.set("k", 1, { tags: ["a", "b"] });
    const stored = (await driver.get("cache", "k"))!;
    await driver.set("cache", { ...stored, tags: ["forged"] });
    expect((await cache.getEntry("k"))?.tags).toEqual(["a", "b"]);
  });
});

describe("the sealed expiry wins over the store's", () => {
  test("a raised clear expiry: a miss after the sealed one", async () => {
    const { cache, driver, clock } = setup({ encrypt: { keys: RING } });
    await cache.set("k", SENTINEL, { ttl: 1_000, staleWhileRevalidate: 1_000 });
    const stored = (await driver.get("cache", "k"))!;
    expect(stored.expiresAt).toBe(T0 + 2_000);
    await driver.set("cache", { ...stored, expiresAt: T0 + 86_400_000 });
    clock.advance(1_500);
    expect((await cache.getEntry("k"))?.stale).toBe(true);
    clock.advance(1_000);
    expect(await cache.getEntry("k")).toBeUndefined();
    expect(await cache.touch("k", 60_000)).toBe(false);
  });

  test("control, unencrypted: the raised expiry is served", async () => {
    const { cache, driver, clock } = setup();
    await cache.set("k", SENTINEL, { ttl: 1_000, staleWhileRevalidate: 1_000 });
    const stored = (await driver.get("cache", "k"))!;
    await driver.set("cache", { ...stored, expiresAt: T0 + 86_400_000 });
    clock.advance(2_500);
    expect((await cache.getEntry("k"))?.value).toBe(SENTINEL);
  });

  test("getEntry reports the sealed expiry", async () => {
    const { cache, driver } = setup({ encrypt: { keys: RING } });
    await cache.set("k", 1, { ttl: 1_000 });
    const stored = (await driver.get("cache", "k"))!;
    await driver.set("cache", { ...stored, expiresAt: null });
    expect((await cache.getEntry("k"))?.expiresAt).toBe(T0 + 1_000);
  });
});

describe("replay (documented, not preventable)", () => {
  test("an older ciphertext of the same key is served, at most as fresh as it was written", async () => {
    const { cache, driver, clock } = setup({ encrypt: { keys: RING } });
    await cache.set("price", 100, { ttl: 1_000 });
    const old = await storedBytes(driver, "price");
    await cache.set("price", 120, { ttl: 60_000 });
    const current = (await driver.get("cache", "price"))!;
    await driver.set("cache", { ...current, value: old, expiresAt: null });
    expect(await cache.get("price")).toBe(100);
    // Its sealed freshness and expiry still bound it.
    clock.advance(1_001);
    expect(await cache.get("price")).toBeUndefined();
  });
});

describe("a cache without encrypt, over sealed entries (a misconfigured peer)", () => {
  /** An encrypted cache that wrote `keys` (a built-in entry under "2026-10", one tagged, one by a user cipher), and a plain cache on the same store. */
  async function seeded(plainOptions: Parameters<typeof setup>[0] = {}) {
    const writer = setup({ encrypt: { keys: RING } });
    const shared = { driver: writer.driver, clock: writer.clock };
    await writer.cache.set("a", SENTINEL);
    await writer.cache.set("b", { n: 2 }, { tags: ["t"], ttl: 60_000 });
    const userCipher = setup({ encrypt: { cipher: testCipher() } }, shared);
    await userCipher.cache.set("c", 3);
    const before = new Map<string, Uint8Array>();
    for (const key of ["a", "b", "c"]) {
      before.set(key, (await storedBytes(writer.driver, key)).slice());
    }
    const plain = setup(plainOptions, shared);
    return { writer, userCipher, plain, before };
  }

  /** Asserts every seeded entry is still stored, byte for byte, after any background delete had its chance. */
  async function expectIntact(
    driver: CacheDriver,
    before: Map<string, Uint8Array>,
  ): Promise<void> {
    await Bun.sleep(5);
    for (const [key, bytes] of before) {
      const now = await driver.get("cache", key);
      expect({
        key,
        intact:
          now !== undefined &&
          Buffer.from(now.value).equals(Buffer.from(bytes)),
      }).toEqual({ key, intact: true });
    }
  }

  test("every read is a miss with a decrypt error (cipher), and no entry is deleted", async () => {
    const { writer, userCipher, plain, before } = await seeded();
    expect(await plain.cache.get("a")).toBeUndefined();
    expect(await plain.cache.getEntry("b")).toBeUndefined();
    expect(await plain.cache.has("c")).toBe(false);
    expect(await plain.cache.getMany(["a", "b", "c"])).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(await plain.cache.touch("a", 60_000)).toBe(false);
    const errors = decryptErrors(plain.errors);
    expect(errors.map((error) => [error.reason, error.keyId])).toEqual([
      ["cipher", "2026-10"],
      ["cipher", "2026-10"],
      ["cipher", undefined],
      ["cipher", "2026-10"],
      ["cipher", "2026-10"],
      ["cipher", undefined],
      ["cipher", "2026-10"],
    ]);
    expect(plain.errors.every((event) => event.phase === "decrypt")).toBe(true);
    await expectIntact(writer.driver, before);
    // The encrypted caches still read them all.
    expect(await writer.cache.get("a")).toBe(SENTINEL);
    expect(await writer.cache.get("b")).toEqual({ n: 2 });
    expect(await userCipher.cache.get("c")).toBe(3);
  });

  test("with an L1: a miss, nothing copied into L1, nothing deleted", async () => {
    const { writer, plain, before } = await seeded({ l1: true, bus: false });
    expect(await plain.cache.get("a")).toBeUndefined();
    expect(await plain.cache.get("a")).toBeUndefined();
    expect(plain.cache.stats().l1?.entries).toBe(0);
    await expectIntact(writer.driver, before);
    expect(await writer.cache.get("a")).toBe(SENTINEL);
  });

  test("getOrSet loads, and its own write replaces the sealed entry — an explicit write of the app's, as any set is", async () => {
    const { writer, plain } = await seeded();
    expect(await plain.cache.getOrSet("a", () => "loaded")).toBe("loaded");
    const now = await storedBytes(writer.driver, "a");
    expect(new TextDecoder().decode(now.subarray(0, 2))).toBe("BC");
    // The encrypted cache now meets a plain entry: a miss ("unencrypted"),
    // and it too leaves it in place.
    expect(await writer.cache.get("a")).toBeUndefined();
    expect(decryptErrors(writer.errors).map((error) => error.reason)).toEqual([
      "unencrypted",
    ]);
    await Bun.sleep(5);
    expect(await writer.driver.get("cache", "a")).toBeDefined();
  });

  test("a planted envelope's key id is reported only when it is a well-formed id", async () => {
    const plain = setup();
    const planted = new Uint8Array(64);
    planted.set([0x42, 0x45, 1, 1, 4]);
    planted.set(new TextEncoder().encode("a b\n"), 5);
    await plain.driver.set("cache", {
      key: "x",
      value: planted,
      expiresAt: null,
      tags: [],
    });
    expect(await plain.cache.get("x")).toBeUndefined();
    expect(
      decryptErrors(plain.errors).map((error) => [error.reason, error.keyId]),
    ).toEqual([["cipher", undefined]]);
    await Bun.sleep(5);
    expect(await plain.driver.get("cache", "x")).toBeDefined();
  });

  test("bytes that are neither an envelope nor an entry are still a decode miss, deleted, as before", async () => {
    const plain = setup();
    await plain.driver.set("cache", {
      key: "junk",
      value: new TextEncoder().encode("not an entry"),
      expiresAt: null,
      tags: [],
    });
    expect(await plain.cache.get("junk")).toBeUndefined();
    expect(plain.errors.map((event) => event.phase)).toEqual(["decode"]);
    await Bun.sleep(5);
    expect(await plain.driver.get("cache", "junk")).toBeUndefined();
  });
});
