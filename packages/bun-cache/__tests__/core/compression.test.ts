/**
 * Compression (plan §3.11; the encryption plan's §8, PR-Z1): the four
 * built-in algorithms at their levels, the format-1/format-2 header split,
 * entries written by the version before (byte fixtures), user compressors
 * sync and async, `compress.previous`, the per-call `compress: false`, the
 * option checks, and the decompression cap on every new path.
 */
import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { sleep } from "@kingsleyweb/bun-common";
import {
  brotliCompressSync,
  constants as zlibConstants,
  inflateRawSync,
  inflateSync,
} from "node:zlib";
import {
  COMPRESSOR_IDS,
  decodeEntry,
  encodeEntry,
  ENTRY_FORMAT,
  ENTRY_FORMAT_2,
  NO_FRESH_UNTIL,
} from "../../lib/core/header";
import type {
  CacheCompressor,
  CacheEventMap,
  CreateCacheOptions,
} from "../../lib/index";
import { createCache, memoryDriver } from "../../lib/index";
import { fakeClock } from "../../lib/testing/index";

/** The clock every fixture was written at. */
const T0 = 1_700_000_000_000;

/** A cache on a fresh memory driver and a fake clock, with the driver exposed for raw reads and plants. */
function setup(options: Omit<CreateCacheOptions, "driver"> = {}): {
  /** The cache. */
  cache: ReturnType<typeof createCache>;
  /** The driver under it. */
  driver: ReturnType<typeof memoryDriver>;
  /** The shared fake clock. */
  clock: ReturnType<typeof fakeClock>;
  /** Every `error` event. */
  errors: CacheEventMap["error"][];
} {
  const clock = fakeClock(T0);
  const driver = memoryDriver({ now: clock.now });
  const cache = createCache({
    driver,
    sweepInterval: 0,
    ...options,
    now: clock.now,
  });
  const errors: CacheEventMap["error"][] = [];
  cache.on("error", (event) => {
    errors.push(event);
  });
  return { cache, driver, clock, errors };
}

/** The stored bytes at `key` in the default namespace. */
async function storedBytes(
  driver: ReturnType<typeof memoryDriver>,
  key: string,
): Promise<Uint8Array> {
  const stored = await driver.get("cache", key);
  if (stored === undefined) {
    throw new Error(`nothing stored at ${key}`);
  }
  return stored.value;
}

/** Deterministic, compressible JSON-ish records, about `bytes` long once encoded as JSON. */
function records(
  bytes: number,
): { id: number; name: string; tags: string[] }[] {
  const out: { id: number; name: string; tags: string[] }[] = [];
  let length = 2;
  for (let i = 0; length < bytes; i++) {
    const record = { id: i, name: `user-${i % 97}`, tags: ["a", `t${i % 7}`] };
    out.push(record);
    length += JSON.stringify(record).length + 1;
  }
  return out;
}

/** The sizes the plan's test list names: 100 B, 4 KiB, 70 KB and 1 MiB. */
const SIZES = [100, 4 * 1024, 70_000, 1024 * 1024] as const;

/** Each built-in algorithm with its id and the levels to round-trip at: lowest, default, highest. */
const ALGORITHMS = [
  { algorithm: "zstd", id: COMPRESSOR_IDS.zstd, levels: [1, 3, 22] },
  { algorithm: "gzip", id: COMPRESSOR_IDS.gzip, levels: [0, 6, 9] },
  { algorithm: "br", id: COMPRESSOR_IDS.br, levels: [0, 4, 11] },
  { algorithm: "deflate", id: COMPRESSOR_IDS.deflate, levels: [0, 6, 9] },
] as const;

/**
 * Entries written by `develop` at 251a64f1 (before PR-Z1), by its own
 * `createCache` over the memory driver at T0 with `ttl: 60_000`, under the key
 * `"k"` (the generator is in the PR's notes). They pin what a rolling deploy
 * meets: the new version must read every one, and write the same bytes.
 */
const DEVELOP_FIXTURES = {
  /** `{ id: 42, name: "ada" }`, structured, uncompressed. */
  plain:
    "QkMBAQAAAIBW/rx4QgAAJmX+vHhCAAAAAAAAAAABAAAAaw4AAAACAgAAgGlkBSoAAAAEAACAbmFtZRADAACAYWRh/////w==",
  /** `"z".repeat(20_000)`, structured, zstd (format 1, flags bit 0). */
  zstd: "QkMBAQEAAIBW/rx4QgAAJmX+vHhCAAAAAAAAAAABAAAAayi1L/1gKU2NAABQDgAAABAgTgCAegEAHM4OkA==",
  /** `"g".repeat(20_000)`, structured, gzip (format 1, flags bit 1). */
  gzip: "QkMBAQIAAIBW/rx4QgAAJmX+vHhCAAAAAAAAAAABAAAAax+LCAAAAAAAAAPtwUEVACAIBbCfgGcEE1mDGkanBodtleTcl98AAAAAAAAAAAAAAAAAAAAAAAAA9AYD6mx1jSlOAAA=",
  /** `"r".repeat(64)`, the raw codec as a string, zstd above an 8-byte threshold. */
  rawString:
    "QkMBAxEAAIBW/rx4QgAAJmX+vHhCAAAAAAAAAAABAAAAayi1L/0gQEUAABBycgEAkwAW",
  /** A negative marker (`cacheUndefined`). */
  negative: "QkMBAQgAAIBW/rx4QgAAJmX+vHhCAAAAAAAAAAABAAAAaw==",
} as const;

/** The fixture's bytes. */
function fixture(name: keyof typeof DEVELOP_FIXTURES): Uint8Array {
  return new Uint8Array(Buffer.from(DEVELOP_FIXTURES[name], "base64"));
}

/** A user compressor over raw DEFLATE, counting its calls, synchronous or answering promises. */
function testCompressor(
  id: number,
  async: boolean,
): CacheCompressor & {
  /** How many times each function ran, and the last cap `decompress` was handed. */
  calls: { compress: number; decompress: number; lastLimit: number };
} {
  const calls = { compress: 0, decompress: 0, lastLimit: 0 };
  const compress = (bytes: Uint8Array): Uint8Array => {
    calls.compress++;
    return Bun.deflateSync(bytes.slice());
  };
  const decompress = (bytes: Uint8Array, limit: number): Uint8Array => {
    calls.decompress++;
    calls.lastLimit = limit;
    return inflateRawSync(bytes, { maxOutputLength: limit });
  };
  return async
    ? {
        id,
        calls,
        compress: async (bytes) => {
          await sleep(1);
          return compress(bytes);
        },
        decompress: async (bytes, limit) => {
          await sleep(1);
          return decompress(bytes, limit);
        },
      }
    : { id, calls, compress, decompress };
}

describe("the built-in algorithms (encryption plan §8.1–§8.2)", () => {
  for (const { algorithm, id, levels } of ALGORITHMS) {
    test(`${algorithm} round-trips at 100 B, 4 KiB, 70 KB and 1 MiB, compressing when smaller`, async () => {
      const { cache, driver } = setup({
        compress: { algorithm, threshold: 0 },
      });
      for (const size of SIZES) {
        const value = records(size);
        expect(await cache.set(`k${size}`, value)).toBe(true);
        expect(await cache.get(`k${size}`)).toEqual(value);
        const { header } = decodeEntry(await storedBytes(driver, `k${size}`));
        // 100 B of JSON does not shrink under every algorithm; from 4 KiB
        // up, every one compresses these records.
        if (size >= 4 * 1024) {
          expect(header.compressor).toBe(id);
        }
      }
      await cache.close();
    });

    test(`${algorithm} round-trips at levels ${levels.join(", ")}`, async () => {
      for (const level of levels) {
        const { cache, driver } = setup({
          compress: { algorithm, level, threshold: 0 },
        });
        const value = records(4 * 1024);
        expect(await cache.set("k", value)).toBe(true);
        expect(await cache.get("k")).toEqual(value);
        // Level 0 of gzip and deflate stores; then the "only if smaller"
        // rule keeps the payload uncompressed.
        const { header } = decodeEntry(await storedBytes(driver, "k"));
        expect([id, COMPRESSOR_IDS.none] as number[]).toContain(
          header.compressor,
        );
        await cache.close();
      }
    });
  }

  test("an incompressible payload is stored uncompressed (only if smaller, §3.11)", async () => {
    const { cache, driver } = setup({
      codec: "raw",
      compress: { algorithm: "br", threshold: 0 },
    });
    const random = crypto.getRandomValues(new Uint8Array(4096));
    await cache.set("k", random);
    expect(decodeEntry(await storedBytes(driver, "k")).header.compressor).toBe(
      COMPRESSOR_IDS.none,
    );
    expect(await cache.get("k")).toEqual(random);
    await cache.close();
  });

  test("the threshold stays 16 KiB for every algorithm", async () => {
    for (const { algorithm, id } of ALGORITHMS) {
      const { cache, driver } = setup({
        codec: "raw",
        compress: { algorithm },
      });
      await cache.set("under", "u".repeat(16 * 1024 - 1));
      await cache.set("at", "a".repeat(16 * 1024));
      expect(
        decodeEntry(await storedBytes(driver, "under")).header.compressor,
      ).toBe(COMPRESSOR_IDS.none);
      expect(
        decodeEntry(await storedBytes(driver, "at")).header.compressor,
      ).toBe(id);
      await cache.close();
    }
  });

  test('"deflate" is raw DEFLATE (RFC 1951), not the zlib-wrapped form', async () => {
    const { cache, driver } = setup({
      codec: "raw",
      compress: { algorithm: "deflate" },
    });
    const text = "d".repeat(20_000);
    await cache.set("k", text);
    const { payload } = decodeEntry(await storedBytes(driver, "k"));
    expect(new TextDecoder().decode(inflateRawSync(payload))).toBe(text);
    expect(() => inflateSync(payload)).toThrow();
    await cache.close();
  });

  test("the default levels are zstd 3, gzip 6, br 4 and deflate 6", async () => {
    const value = "L".repeat(10_000) + records(20_000).length;
    const expected: Record<string, (bytes: Uint8Array) => Uint8Array> = {
      zstd: (bytes) => Bun.zstdCompressSync(bytes.slice(), { level: 3 }),
      gzip: (bytes) => Bun.gzipSync(bytes.slice(), { level: 6 }),
      br: (bytes) =>
        brotliCompressSync(bytes, {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
        }),
      deflate: (bytes) => Bun.deflateSync(bytes.slice(), { level: 6 }),
    };
    for (const { algorithm } of ALGORITHMS) {
      const { cache, driver } = setup({
        codec: "raw",
        compress: { algorithm, threshold: 0 },
      });
      await cache.set("k", value);
      const { payload } = decodeEntry(await storedBytes(driver, "k"));
      expect([...payload]).toEqual([
        ...expected[algorithm](new TextEncoder().encode(value)),
      ]);
      await cache.close();
    }
  });
});

describe("the entry header: format 1 or 2 (encryption plan §8.3)", () => {
  test("none, zstd and gzip write format 1; br and deflate write format 2 with their id", async () => {
    const cases = [
      { compress: false, format: ENTRY_FORMAT, id: COMPRESSOR_IDS.none },
      { compress: { algorithm: "zstd" }, format: ENTRY_FORMAT, id: 1 },
      { compress: { algorithm: "gzip" }, format: ENTRY_FORMAT, id: 2 },
      { compress: { algorithm: "br" }, format: ENTRY_FORMAT_2, id: 3 },
      { compress: { algorithm: "deflate" }, format: ENTRY_FORMAT_2, id: 4 },
    ] as const;
    for (const { compress, format, id } of cases) {
      const { cache, driver } = setup({ codec: "raw", compress });
      await cache.set("k", "c".repeat(20_000));
      const bytes = await storedBytes(driver, "k");
      expect(bytes[2]).toBe(format);
      if (format === ENTRY_FORMAT_2) {
        // The flags keep format 1's compression bits zero; the id follows.
        expect(bytes[4] & 0b11).toBe(0);
        expect(bytes[5]).toBe(id);
      } else {
        expect(bytes[4] & 0b11).toBe(id);
      }
      expect(decodeEntry(bytes).header.compressor).toBe(id);
      await cache.close();
    }
  });

  test("an uncompressed entry on a br cache is still format 1", async () => {
    const { cache, driver } = setup({ compress: { algorithm: "br" } });
    await cache.set("small", { a: 1 });
    expect((await storedBytes(driver, "small"))[2]).toBe(ENTRY_FORMAT);
    await cache.close();
  });

  test("a user compressor writes format 2 with its own id", async () => {
    const { cache, driver } = setup({
      codec: "raw",
      compress: { algorithm: testCompressor(200, false) },
    });
    await cache.set("k", "u".repeat(20_000));
    const bytes = await storedBytes(driver, "k");
    expect(bytes[2]).toBe(ENTRY_FORMAT_2);
    expect(bytes[5]).toBe(200);
    await cache.close();
  });

  test("format 2 round-trips every header field", () => {
    const header = {
      codecId: 2,
      flags: 8,
      compressor: 131,
      createdAt: 1_700_000_000_123,
      freshUntil: NO_FRESH_UNTIL,
      loadMs: 7.25,
      key: "user:ä",
    };
    const bytes = encodeEntry(header, new Uint8Array([9, 8, 7]));
    expect(bytes[2]).toBe(ENTRY_FORMAT_2);
    expect(decodeEntry(bytes)).toEqual({
      header,
      payload: new Uint8Array([9, 8, 7]),
    });
  });

  test("a format-2 entry with format 1's compression flags, a format-1 entry flagged both, and a truncated format-2 header are misses", async () => {
    const good = encodeEntry(
      {
        codecId: 3,
        flags: 0,
        compressor: COMPRESSOR_IDS.br,
        createdAt: T0,
        freshUntil: NO_FRESH_UNTIL,
        loadMs: 0,
        key: "k",
      },
      new Uint8Array(0),
    );
    const flagged = good.slice();
    flagged[4] |= 1;
    const both = fixture("zstd");
    both[4] |= 3;
    for (const bytes of [flagged, both, good.slice(0, 33)]) {
      const { cache, driver, errors } = setup();
      await driver.set("cache", {
        key: "k",
        value: bytes,
        expiresAt: null,
        tags: [],
      });
      expect(await cache.get("k")).toBeUndefined();
      expect(errors.map((event) => event.phase)).toEqual(["decode"]);
      await cache.close();
    }
  });
});

describe("entries written before PR-Z1 (a rolling deploy)", () => {
  test("every develop fixture reads, on a cache configured with any algorithm", async () => {
    const expected = {
      plain: { id: 42, name: "ada" },
      zstd: "z".repeat(20_000),
      gzip: "g".repeat(20_000),
    } as const;
    for (const compress of [
      undefined,
      false,
      { algorithm: "gzip" },
      { algorithm: "br" },
      { algorithm: "deflate" },
      { algorithm: testCompressor(150, true) },
    ] as const) {
      for (const [name, value] of Object.entries(expected)) {
        // Each fixture's header names the key "k".
        const { cache, driver, errors } = setup({ compress });
        await driver.set("cache", {
          key: "k",
          value: fixture(name as keyof typeof expected),
          expiresAt: null,
          tags: [],
        });
        expect(await cache.get("k")).toEqual(value);
        expect(errors).toEqual([]);
        await cache.close();
      }
    }
    const raw = setup({ codec: "raw" });
    await raw.driver.set("cache", {
      key: "k",
      value: fixture("rawString"),
      expiresAt: null,
      tags: [],
    });
    expect(await raw.cache.get("k")).toBe("r".repeat(64));
    await raw.cache.close();
    const negative = setup({ cacheUndefined: true });
    await negative.driver.set("cache", {
      key: "k",
      value: fixture("negative"),
      expiresAt: null,
      tags: [],
    });
    let loads = 0;
    expect(
      await negative.cache.getOrSet("k", async () => {
        loads++;
        return "loaded";
      }),
    ).toBeUndefined();
    expect(loads).toBe(0);
    await negative.cache.close();
  });

  test("a cache configured as before writes the bytes develop wrote", async () => {
    const cases = [
      { name: "plain", options: {}, value: { id: 42, name: "ada" } },
      { name: "zstd", options: {}, value: "z".repeat(20_000) },
      {
        name: "gzip",
        options: { compress: { algorithm: "gzip" } },
        value: "g".repeat(20_000),
      },
      {
        name: "rawString",
        options: { codec: "raw", compress: { threshold: 8 } },
        value: "r".repeat(64),
      },
    ] as const;
    for (const { name, options, value } of cases) {
      const { cache, driver } = setup({ ttl: 60_000, ...options });
      await cache.set("k", value);
      expect([...(await storedBytes(driver, "k"))]).toEqual([...fixture(name)]);
      await cache.close();
    }
    const { cache, driver } = setup({ ttl: 60_000, cacheUndefined: true });
    await cache.getOrSet("k", async () => undefined);
    expect([...(await storedBytes(driver, "k"))]).toEqual([
      ...fixture("negative"),
    ]);
    await cache.close();
  });
});

describe("user compressors (encryption plan §8.4)", () => {
  for (const async of [false, true]) {
    test(`a ${async ? "promise-answering" : "synchronous"} compressor round-trips, through L1 without decompressing`, async () => {
      const compressor = testCompressor(201, async);
      const { cache, driver } = setup({
        codec: "raw",
        compress: { algorithm: compressor },
        l1: { maxEntries: 10 },
      });
      const text = "s".repeat(50_000);
      await sleep(5); // L1 serves once the memory driver's bus listens
      expect(await cache.set("k", text)).toBe(true);
      expect(compressor.calls.compress).toBe(1);
      // L1 holds the copy decoded before compression.
      expect(await cache.get("k")).toBe(text);
      expect(compressor.calls.decompress).toBe(0);
      // The driver's bytes decompress with it, handed the cap.
      expect(await cache.get("k", { tier: "l2" })).toBe(text);
      expect(compressor.calls.decompress).toBe(1);
      expect(compressor.calls.lastLimit).toBe(4 * 1024 * 1024);
      expect(
        decodeEntry(await storedBytes(driver, "k")).header.compressor,
      ).toBe(201);
      // getMany and touch go through it too.
      expect(await cache.getMany(["k"], { tier: "l2" })).toEqual([text]);
      expect(await cache.touch("k", 10_000)).toBe(true);
      expect(await cache.get("k", { tier: "l2" })).toBe(text);
      await cache.close();
    });
  }

  test("the L1 copy of a write never aliases the caller's bytes, compressed or not (raw codec)", async () => {
    for (const compress of [false, { threshold: 0 }] as const) {
      const { cache, driver } = setup({
        codec: "raw",
        compress,
        l1: { maxEntries: 10 },
      });
      await sleep(5); // L1 serves once the memory driver's bus listens
      const mine = new Uint8Array(20_000).fill(7);
      await cache.set("k", mine);
      expect(
        decodeEntry(await storedBytes(driver, "k")).header.compressor,
      ).toBe(compress === false ? COMPRESSOR_IDS.none : COMPRESSOR_IDS.zstd);
      mine.fill(9);
      const copy = (await cache.get("k")) as Uint8Array;
      expect(copy).not.toBe(mine);
      expect(copy.every((byte) => byte === 7)).toBe(true);
      expect(cache.stats().l1?.hits).toBe(1);
      await cache.close();
    }
  });

  test("compress.previous keeps an earlier compressor's entries readable; without it they are misses", async () => {
    const driver = memoryDriver();
    const old = testCompressor(140, false);
    const writer = createCache({
      driver,
      codec: "raw",
      sweepInterval: 0,
      compress: { algorithm: old },
    });
    await writer.set("k", "p".repeat(30_000));
    const withPrevious = createCache({
      driver,
      codec: "raw",
      sweepInterval: 0,
      compress: { algorithm: testCompressor(141, true), previous: [old] },
    });
    expect(await withPrevious.get("k")).toBe("p".repeat(30_000));
    const without = createCache({
      driver,
      codec: "raw",
      sweepInterval: 0,
      compress: { algorithm: "br" },
    });
    const errors: CacheEventMap["error"][] = [];
    without.on("error", (event) => {
      errors.push(event);
    });
    expect(await without.get("k")).toBeUndefined();
    expect(errors.map((event) => event.phase)).toEqual(["decode"]);
    expect(String(errors[0].error)).toContain("compressor id 140");
    for (const cache of [writer, withPrevious, without]) {
      await cache.close();
    }
  });

  test("a compressor whose output is not smaller is discarded", async () => {
    const { cache, driver } = setup({
      codec: "raw",
      compress: {
        algorithm: {
          id: 199,
          compress: (bytes) => new Uint8Array(bytes.byteLength + 1),
          decompress: () => {
            throw new Error("never called");
          },
        },
      },
    });
    await cache.set("k", "n".repeat(20_000));
    expect(decodeEntry(await storedBytes(driver, "k")).header.compressor).toBe(
      COMPRESSOR_IDS.none,
    );
    expect(await cache.get("k")).toBe("n".repeat(20_000));
    await cache.close();
  });

  test("a compressor that throws or answers a non-Uint8Array fails the write to its caller", async () => {
    const boom = new Error("compressor down");
    const throwing = setup({
      codec: "raw",
      compress: {
        algorithm: {
          id: 198,
          compress: async () => await Promise.reject(boom),
          decompress: (bytes) => bytes,
        },
      },
    });
    await expect(throwing.cache.set("k", "t".repeat(20_000))).rejects.toBe(
      boom,
    );
    await throwing.cache.close();
    const wrong = setup({
      codec: "raw",
      compress: {
        algorithm: {
          id: 197,
          compress: () => "nope" as unknown as Uint8Array,
          decompress: (bytes) => bytes,
        },
      },
    });
    await expect(wrong.cache.set("k", "t".repeat(20_000))).rejects.toThrow(
      TypeError,
    );
    await wrong.cache.close();
  });
});

describe("compress: false per call (encryption plan §8.5)", () => {
  test("set, setMany, getOrSet and wrap store the payload uncompressed; the default call compresses", async () => {
    const { cache, driver } = setup({ codec: "raw" });
    const text = "f".repeat(20_000);
    await cache.set("default", text);
    await cache.set("set", text, { compress: false });
    await cache.setMany([["many", text, { compress: false }]]);
    await cache.getOrSet("getOrSet", async () => text, { compress: false });
    const wrapped = cache.wrap(async (_id: number) => text, {
      key: (id) => `wrap:${id}`,
      compress: false,
    });
    await wrapped(1);
    expect(
      decodeEntry(await storedBytes(driver, "default")).header.compressor,
    ).toBe(COMPRESSOR_IDS.zstd);
    for (const key of ["set", "many", "getOrSet", "wrap:1"]) {
      expect(
        decodeEntry(await storedBytes(driver, key)).header.compressor,
      ).toBe(COMPRESSOR_IDS.none);
      expect(await cache.get(key)).toBe(text);
    }
    await cache.close();
  });

  test("touch and the fail-safe backoff keep an uncompressed entry uncompressed", async () => {
    const { cache, driver, clock } = setup({
      codec: "raw",
      ttl: 1_000,
      staleIfError: 60_000,
      failSafeBackoff: 30_000,
    });
    const text = "b".repeat(20_000);
    await cache.set("k", text, { compress: false });
    expect(await cache.touch("k", 1_000)).toBe(true);
    expect(decodeEntry(await storedBytes(driver, "k")).header.compressor).toBe(
      COMPRESSOR_IDS.none,
    );
    clock.advance(2_000); // stale, inside stale-if-error
    expect(
      await cache.getOrSet("k", async () => {
        throw new Error("origin down");
      }),
    ).toBe(text);
    await sleep(5); // the backoff rewrite lands
    const { header } = decodeEntry(await storedBytes(driver, "k"));
    expect(header.freshUntil).toBe(clock.now() + 30_000);
    expect(header.compressor).toBe(COMPRESSOR_IDS.none);
    await cache.close();
  });
});

describe("option checks (encryption plan §10.4)", () => {
  /** A compressor that is never called. */
  const idle = (id: number): CacheCompressor => ({
    id,
    compress: (bytes) => bytes,
    decompress: (bytes) => bytes,
  });

  test("a user compressor's id outside 128–255 is refused at createCache", () => {
    for (const id of [0, 3, 127, 256, 128.5, Number.NaN]) {
      expect(() => setup({ compress: { algorithm: idle(id) } })).toThrow(
        /compress\.algorithm: a user compressor's id must be an integer in 128–255/,
      );
      expect(() => setup({ compress: { previous: [idle(id)] } })).toThrow(
        /compress\.previous\[0\]: a user compressor's id/,
      );
    }
    expect(() => setup({ compress: { algorithm: idle(128) } })).not.toThrow();
    expect(() => setup({ compress: { algorithm: idle(255) } })).not.toThrow();
  });

  test("duplicate compressor ids are refused", () => {
    expect(() =>
      setup({ compress: { algorithm: idle(130), previous: [idle(130)] } }),
    ).toThrow(/compress\.previous\[0\]: compressor id 130 is already taken/);
    expect(() =>
      setup({ compress: { previous: [idle(131), idle(131)] } }),
    ).toThrow(/compress\.previous\[1\]/);
  });

  test("a level outside its algorithm's range, or beside a user compressor, is refused", () => {
    for (const [algorithm, bad] of [
      ["zstd", [0, 23]],
      ["gzip", [-1, 10]],
      ["br", [-1, 12]],
      ["deflate", [-1, 10]],
    ] as const) {
      for (const level of [...bad, 2.5]) {
        expect(() => setup({ compress: { algorithm, level } })).toThrow(
          new RegExp(`compress\\.level for "${algorithm}" must be an integer`),
        );
      }
    }
    expect(() =>
      setup({ compress: { algorithm: idle(150), level: 3 } }),
    ).toThrow(/compress\.level applies to the built-in algorithms/);
  });

  test("an unknown algorithm name, or a compressor without functions, is refused", () => {
    expect(() =>
      setup({
        compress: { algorithm: "lz4" as unknown as "zstd" },
      }),
    ).toThrow(/compress\.algorithm must be "zstd", "gzip", "br", "deflate"/);
    expect(() =>
      setup({
        compress: {
          algorithm: {
            id: 150,
            compress: (bytes: Uint8Array) => bytes,
          } as never,
        },
      }),
    ).toThrow(/needs compress and decompress functions/);
  });
});

describe("the decompression cap on the new paths", () => {
  /** Plants a format-2 entry of `payload` under `compressor`, raw codec. */
  async function plant(
    driver: ReturnType<typeof memoryDriver>,
    compressor: number,
    payload: Uint8Array,
  ): Promise<void> {
    await driver.set("cache", {
      key: "bomb",
      value: encodeEntry(
        {
          codecId: 3, // raw: a bomb that got through would decode and be served
          flags: 0,
          compressor,
          createdAt: T0,
          freshUntil: NO_FRESH_UNTIL,
          loadMs: 0,
          key: "bomb",
        },
        payload,
      ),
      expiresAt: null,
      tags: [],
    });
  }

  /** 1 MiB of zeros: past a 64 KiB `maxEntryBytes`. */
  const zeros = new Uint8Array(1024 * 1024);
  const limit = 64 * 1024;

  for (const [name, id, compressed] of [
    [
      "br",
      COMPRESSOR_IDS.br,
      () =>
        brotliCompressSync(zeros, {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 },
        }),
    ],
    ["deflate", COMPRESSOR_IDS.deflate, () => Bun.deflateSync(zeros)],
  ] as const) {
    test(`a ${name} bomb past maxEntryBytes reads as a miss with a decode error, and is deleted`, async () => {
      const { cache, driver, errors } = setup({
        codec: "raw",
        maxEntryBytes: limit,
      });
      const bomb = compressed();
      expect(bomb.byteLength).toBeLessThan(limit);
      await plant(driver, id, bomb);
      expect(await cache.get("bomb")).toBeUndefined();
      expect(errors.map((event) => event.phase)).toEqual(["decode"]);
      expect(String(errors[0].error)).toContain(`past the ${limit}-byte limit`);
      await sleep(1);
      expect(await driver.get("cache", "bomb")).toBeUndefined();
      // The same payload under the cap reads.
      const ok = setup({ codec: "raw" });
      await plant(ok.driver, id, bomb);
      expect(((await ok.cache.get("bomb")) as Uint8Array).byteLength).toBe(
        zeros.byteLength,
      );
      await ok.cache.close();
      await cache.close();
    });
  }

  test("a user compressor is handed the cap, and an answer past it is a miss", async () => {
    const greedy: CacheCompressor & { limits: number[] } = {
      id: 160,
      limits: [],
      compress: (bytes) => bytes,
      // Ignores the cap it is handed.
      decompress(_bytes, maxOutputLength) {
        greedy.limits.push(maxOutputLength);
        return zeros;
      },
    };
    const { cache, driver, errors } = setup({
      codec: "raw",
      maxEntryBytes: limit,
      compress: { algorithm: greedy },
    });
    await plant(driver, 160, new Uint8Array(10));
    expect(await cache.get("bomb")).toBeUndefined();
    expect(greedy.limits).toEqual([limit]);
    expect(errors.map((event) => event.phase)).toEqual(["decode"]);
    expect(String(errors[0].error)).toContain(`past the ${limit}-byte limit`);
    await cache.close();
  });

  test("a payload past the cap is never written compressed with br, deflate or a user compressor (it could not be read back)", async () => {
    for (const algorithm of [
      "br",
      "deflate",
      testCompressor(170, false),
    ] as const) {
      const { cache } = setup({
        codec: "raw",
        maxEntryBytes: limit,
        compress: { algorithm },
      });
      const oversize: CacheEventMap["oversize"][] = [];
      cache.on("oversize", (event) => {
        oversize.push(event);
      });
      // Compresses to a few hundred bytes, but decompresses past the cap.
      expect(await cache.set("k", zeros)).toBe(false);
      expect(oversize).toHaveLength(1);
      // At the cap it is written and reads back.
      expect(await cache.set("k", zeros.subarray(0, limit - 100))).toBe(true);
      expect(((await cache.get("k")) as Uint8Array).byteLength).toBe(
        limit - 100,
      );
      await cache.close();
    }
  });
});
