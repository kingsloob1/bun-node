/**
 * The decompression cap (plan §3.11; the encryption plan's Q18): a read never
 * decompresses past the entry limit, so a decompression bomb planted in the
 * store by anyone who can write to it is a miss plus an `error` event (phase
 * `"decode"`) and is deleted — never materialised. Writes hold the payload
 * before compression to the same limit, so everything the cache writes still
 * reads back.
 *
 * Test data: one temporary directory for the file driver, made by this file
 * and deleted by this file alone.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, test } from "bun:test";
import { brotliCompressSync } from "node:zlib";
import { decompressBounded } from "../../lib/core/decompress";
import {
  COMPRESSOR_IDS,
  decodeEntry,
  EntryDecodeError,
} from "../../lib/core/header";
import type { CacheDriver, CacheEventMap } from "../../lib/index";
import { createCache, fileDriver, memoryDriver } from "../../lib/index";
import { BOMBS, plantEntry } from "./bombs";

/** The run's own directory, for the file driver. */
const dir = await mkdtemp(join(tmpdir(), `bun-cache-bomb-${process.pid}-`));

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The entry limit the tests run under: 64 KiB, so an 8 MiB bomb is 128 times over it. */
const LIMIT = 64 * 1024;

/** The drivers a bomb is planted in. */
const DRIVERS: { name: string; make: () => CacheDriver }[] = [
  { name: "memory", make: () => memoryDriver() },
  {
    name: "file",
    make: () => fileDriver({ root: join(dir, crypto.randomUUID()) }),
  },
];

/** Waits until the background delete of `key` landed (the file driver's is asynchronous I/O). */
async function expectDeleted(driver: CacheDriver, key: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while ((await driver.get("cache", key)) !== undefined) {
    if (Date.now() > deadline) {
      throw new Error(`the entry "${key}" was never deleted`);
    }
    await Bun.sleep(5);
  }
}

describe.each(DRIVERS)(
  "a decompression bomb on the $name driver",
  ({ make }) => {
    test.each(BOMBS)(
      "a $algorithm bomb reads as a miss, with an error event, and is deleted",
      async ({ compressor, build }) => {
        const driver = make();
        const cache = createCache({
          driver,
          codec: "raw",
          maxEntryBytes: LIMIT,
          sweepInterval: 0,
        });
        const errors: CacheEventMap["error"][] = [];
        cache.on("error", (event) => {
          errors.push(event);
        });
        await plantEntry(driver, "bomb", compressor, await build(8));
        expect(await cache.get("bomb")).toBeUndefined();
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({
          key: "bomb",
          phase: "decode",
          driver: driver.name,
        });
        const error = errors[0].error as EntryDecodeError;
        expect(error).toBeInstanceOf(EntryDecodeError);
        expect(error.message).toContain(`past the ${LIMIT}-byte limit`);
        // node:zlib stopped at the limit: it refused to produce more, rather
        // than the whole 8 MiB being decoded and measured afterwards.
        expect((error.cause as { code?: unknown }).code).toBe(
          "ERR_BUFFER_TOO_LARGE",
        );
        await expectDeleted(driver, "bomb");
        await cache.close();
      },
    );

    test.each(BOMBS)(
      "getOrSet over a $algorithm bomb loads and replaces it",
      async ({ compressor, build }) => {
        const driver = make();
        const cache = createCache({
          driver,
          codec: "raw",
          maxEntryBytes: LIMIT,
          sweepInterval: 0,
        });
        await plantEntry(driver, "bomb", compressor, await build(8));
        expect(await cache.getOrSet("bomb", async () => "loaded")).toBe(
          "loaded",
        );
        expect(await cache.get("bomb")).toBe("loaded");
        await cache.close();
      },
    );
  },
);

describe("entries at the limit", () => {
  for (const algorithm of ["zstd", "gzip", "br", "deflate"] as const) {
    test(`a ${algorithm}-compressed entry decoding to exactly the limit still reads`, async () => {
      const driver = memoryDriver();
      const cache = createCache({
        driver,
        codec: "raw",
        compress: { algorithm, threshold: 1024 },
        maxEntryBytes: LIMIT,
        sweepInterval: 0,
      });
      const value = new Uint8Array(LIMIT).fill(7);
      expect(await cache.set("k", value)).toBe(true);
      // It was stored compressed, so the read below decompresses to the limit.
      const stored = await driver.get("cache", "k");
      const { header, payload } = decodeEntry(stored!.value);
      expect(header.compressor).toBe(COMPRESSOR_IDS[algorithm]);
      expect(payload.byteLength).toBeLessThan(LIMIT / 10);
      expect(await cache.get("k")).toEqual(value);
      await cache.close();
    });

    test(`a ${algorithm} value that compresses under the limit but decodes past it is not written`, async () => {
      const driver = memoryDriver();
      const cache = createCache({
        driver,
        codec: "raw",
        compress: { algorithm, threshold: 1024 },
        maxEntryBytes: LIMIT,
        sweepInterval: 0,
      });
      const oversize: CacheEventMap["oversize"][] = [];
      cache.on("oversize", (event) => {
        oversize.push(event);
      });
      // Compressed it is a few hundred bytes, far under the limit; a read
      // could not decompress it, so the write refuses it.
      expect(await cache.set("k", new Uint8Array(LIMIT + 1))).toBe(false);
      expect(oversize).toEqual([
        { key: "k", namespace: "cache", bytes: LIMIT + 1, limit: LIMIT },
      ]);
      expect(await driver.get("cache", "k")).toBeUndefined();
      await cache.close();
    });
  }
});

describe("decompressBounded", () => {
  const data = new Uint8Array(1000).fill(1);

  test("an uncompressed payload is returned as it is, whatever the cap", () => {
    expect(decompressBounded(0, data, 10)).toBe(data);
  });

  test("a user compressor's id is not a built-in one", () => {
    expect(() => decompressBounded(200, data, 10)).toThrow(EntryDecodeError);
  });

  test("decodes up to and including the cap, refuses one byte past it", () => {
    for (const [flag, packed] of [
      [COMPRESSOR_IDS.zstd, Bun.zstdCompressSync(data)],
      [COMPRESSOR_IDS.gzip, Bun.gzipSync(data)],
      [COMPRESSOR_IDS.br, brotliCompressSync(data)],
      [COMPRESSOR_IDS.deflate, Bun.deflateSync(data)],
    ] as const) {
      expect(decompressBounded(flag, packed, 1000)).toEqual(data);
      expect(() => decompressBounded(flag, packed, 999)).toThrow(
        EntryDecodeError,
      );
      // node:zlib rejects a limit of 0: a 0 cap still refuses the payload.
      expect(() => decompressBounded(flag, packed, 0)).toThrow(
        EntryDecodeError,
      );
      // A non-finite cap is unbounded (an `Infinity` maxEntryBytes).
      expect(decompressBounded(flag, packed, Infinity)).toEqual(data);
    }
  });

  test("a zstd frame declaring more than the cap is refused before anything is decoded", () => {
    const frame = Bun.zstdCompressSync(new Uint8Array(1024 * 1024));
    let thrown: unknown;
    try {
      decompressBounded(COMPRESSOR_IDS.zstd, frame, LIMIT);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EntryDecodeError);
    expect((thrown as Error).message).toContain(`past the ${LIMIT}-byte limit`);
    // No decoder ran, so none reported its limit.
    expect((thrown as Error).cause).toBeUndefined();
  });

  test("a truncated zstd payload is refused, though node:zlib answers it short", () => {
    const packed = Bun.zstdCompressSync(data);
    // Inside the magic, inside the frame header, inside the blocks.
    for (const cut of [3, 6, packed.byteLength >> 1, packed.byteLength - 1]) {
      expect(() =>
        decompressBounded(
          COMPRESSOR_IDS.zstd,
          packed.subarray(0, cut),
          1 << 20,
        ),
      ).toThrow(EntryDecodeError);
    }
    // Something that is not a zstd frame at all.
    expect(() =>
      decompressBounded(COMPRESSOR_IDS.zstd, new Uint8Array(16), 1 << 20),
    ).toThrow(EntryDecodeError);
  });

  test("a corrupt gzip payload throws node:zlib's own error, not the limit's", () => {
    const packed = Bun.gzipSync(data);
    for (const corrupt of [
      packed.subarray(0, packed.byteLength - 1),
      new Uint8Array([1, 2, 3]),
    ]) {
      let thrown: unknown;
      try {
        decompressBounded(COMPRESSOR_IDS.gzip, corrupt, 1 << 20);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(EntryDecodeError);
    }
  });

  test("through the cache, a truncated zstd entry is a miss, not a short value", async () => {
    const driver = memoryDriver();
    const cache = createCache({
      driver,
      codec: "raw",
      compress: { algorithm: "zstd", threshold: 1024 },
      sweepInterval: 0,
    });
    const errors: CacheEventMap["error"][] = [];
    cache.on("error", (event) => {
      errors.push(event);
    });
    expect(await cache.set("k", new Uint8Array(8192).fill(9))).toBe(true);
    const stored = await driver.get("cache", "k");
    const { header, payload } = decodeEntry(stored!.value);
    expect(header.compressor).toBe(COMPRESSOR_IDS.zstd);
    await plantEntry(
      driver,
      "k",
      COMPRESSOR_IDS.zstd,
      payload.subarray(0, payload.byteLength - 1),
    );
    expect(await cache.get("k")).toBeUndefined();
    expect(errors.map((event) => event.phase)).toEqual(["decode"]);
    expect(errors[0].error).toBeInstanceOf(EntryDecodeError);
    await cache.close();
  });
});

describe("the read's memory stays bounded", () => {
  // A 256 MiB bomb against a 1 MiB limit, read in a fresh process so the
  // peak RSS is the read's alone. Uncapped, Bun's decoders grew the process
  // by 330 MiB and more (the negative control); capped, by a few MiB.
  test.each(BOMBS)(
    "a 256 MiB $algorithm bomb raises the peak RSS by under 64 MiB",
    async ({ algorithm }) => {
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "bomb-rss-worker.ts"),
          algorithm,
          "256",
          String(1024 * 1024),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      const result = JSON.parse(stdout) as {
        value: string;
        phase: string;
        cause: string;
        growthMiB: number;
      };
      expect(result).toMatchObject({
        value: "miss",
        phase: "decode",
        cause: "ERR_BUFFER_TOO_LARGE",
      });
      expect(result.growthMiB).toBeLessThan(64);
    },
    30_000,
  );
});
