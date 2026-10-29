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
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  brotliCompressSync,
  gunzipSync,
  inflateRawSync,
  zstdDecompressSync,
} from "node:zlib";
import {
  decompressBounded,
  DEFLATE_MAX_RATIO,
  NATIVE_LIMIT,
  nativeBound,
} from "../../lib/core/decompress";
import {
  COMPRESSOR_IDS,
  decodeEntry,
  EntryDecodeError,
} from "../../lib/core/header";
import type { CacheDriver, CacheEventMap } from "../../lib/index";
import { createCache, fileDriver, memoryDriver } from "../../lib/index";
import {
  BOMBS,
  plantEntry,
  REFUSAL_CAUSE,
  zstdBomb,
  zstdLyingBomb,
  zstdOverdeclaredBomb,
  zstdRleFrame,
  zstdSkippableFrame,
  zstdUnsizedBomb,
} from "./bombs";

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
      "a $name bomb reads as a miss, with an error event, and is deleted",
      async ({ compressor, build, refusal }) => {
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
        expect(error.message).toContain(
          refusal === "native"
            ? "bytes its frames declare (corrupt, or a frame larger than it declares)"
            : `past the ${LIMIT}-byte limit`,
        );
        // Which decoder ran, if any: node:zlib stopped at the limit
        // ("limit"), the frames' declared sizes refused it before any decoder
        // ran ("declared"), or Bun's decoder, handed a buffer of the declared
        // size, refused a frame holding more ("native"). Never the whole
        // 8 MiB decoded and measured afterwards.
        expect((error.cause as { code?: unknown } | undefined)?.code).toBe(
          REFUSAL_CAUSE[refusal],
        );
        await expectDeleted(driver, "bomb");
        await cache.close();
      },
    );

    test.each(BOMBS)(
      "getOrSet over a $name bomb loads and replaces it",
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

/** Seeded bytes that do not compress (xorshift32). */
function incompressible(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  let state = 0x9e3779b9;
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = state & 0xff;
  }
  return out;
}

/** JSON-like text that compresses about fivefold. */
function compressible(length: number): Uint8Array<ArrayBuffer> {
  let text = "";
  for (let i = 0; text.length < length; i++) {
    text += JSON.stringify({ id: i, name: `user-${i % 97}`, on: i % 3 === 0 });
  }
  return new Uint8Array(new TextEncoder().encode(text.slice(0, length)));
}

/** A view of `bytes` inside a larger buffer with other bytes around it, as a stored entry's payload is. */
function embedded(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.byteLength + 64).fill(0xa5);
  out.set(bytes, 32);
  return out.subarray(32, 32 + bytes.byteLength);
}

describe("native decoding, where the payload proves its size", () => {
  const MiB = 1024 * 1024;
  const zstd = COMPRESSOR_IDS.zstd;
  const gzip = COMPRESSOR_IDS.gzip;
  const deflate = COMPRESSOR_IDS.deflate;
  const spies: { mockRestore: () => void }[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) {
      spy.mockRestore();
    }
  });
  /** Spies on Bun's native decoders, so a test can say which decoder ran. */
  function spyNative(): {
    zstd: ReturnType<typeof spyOn>;
    gzip: ReturnType<typeof spyOn>;
    deflate: ReturnType<typeof spyOn>;
  } {
    const spied = {
      zstd: spyOn(Bun, "zstdDecompressSync"),
      gzip: spyOn(Bun, "gunzipSync"),
      deflate: spyOn(Bun, "inflateSync"),
    };
    spies.push(spied.zstd, spied.gzip, spied.deflate);
    return spied;
  }

  test("what this cache writes decodes natively, and to what node:zlib decodes", () => {
    const native = spyNative();
    for (const make of [compressible, incompressible]) {
      for (const length of [0, 100, 10_000, 70_000, MiB, 4 * MiB]) {
        const data = make(length);
        const zstdPacked = Bun.zstdCompressSync(data);
        expect(nativeBound(zstd, zstdPacked, 4 * MiB)).toEqual({
          native: length,
        });
        const viaZstd = decompressBounded(zstd, embedded(zstdPacked), 4 * MiB);
        expect(viaZstd).toEqual(data);
        expect(viaZstd).toEqual(zstdDecompressSync(zstdPacked));
        for (const [id, packed, node] of [
          [gzip, Bun.gzipSync(data), gunzipSync],
          [deflate, Bun.deflateSync(data), inflateRawSync],
        ] as const) {
          const out = decompressBounded(id, embedded(packed), 4 * MiB);
          expect(out).toEqual(data);
          expect(out).toEqual(new Uint8Array(node(packed)));
        }
      }
    }
    // zstd: every size this cache writes (the cap is 4 MiB).
    expect(native.zstd).toHaveBeenCalledTimes(12);
    // gzip and DEFLATE: those whose payload is at most 4 MiB / 1,032 bytes.
    expect(native.gzip.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(native.deflate.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  test("a zstd payload of several honest frames is proven by their sum", () => {
    const frames = Buffer.concat([
      Bun.zstdCompressSync(new Uint8Array(1000).fill(1)),
      zstdRleFrame(300_000, 300_000),
      Bun.zstdCompressSync(new Uint8Array(0)),
      Bun.zstdCompressSync(compressible(5000)),
    ]);
    expect(nativeBound(zstd, frames, 4 * MiB)).toEqual({ native: 306_000 });
    expect(decompressBounded(zstd, frames, 306_000).byteLength).toBe(306_000);
    expect(() => decompressBounded(zstd, frames, 305_999)).toThrow(
      EntryDecodeError,
    );
  });

  test("a zstd payload proves nothing unless it is only sized frames, ending at its end", () => {
    const honest = Bun.zstdCompressSync(compressible(10_000));
    const withChecksum = (() => {
      // The same frame with Content_Checksum_Flag set and four bytes after
      // it: still proven (the walk steps over the checksum).
      const frame = zstdRleFrame(1000, 1000);
      const out = Buffer.concat([frame, new Uint8Array(4)]);
      out[4] |= 0x04;
      return out;
    })();
    expect(nativeBound(zstd, withChecksum, MiB)).toEqual({ native: 1000 });
    const reservedBit = honest.slice();
    reservedBit[4] |= 0x08;
    const dictionary = honest.slice();
    dictionary[4] |= 0x01;
    const reservedBlock = zstdRleFrame(1000, 1000);
    // Block_Type 3, reserved.
    reservedBlock[10] |= 0x06;
    for (const [what, payload] of [
      ["no Frame_Content_Size", zstdRleFrame(1000, undefined)],
      ["a second frame with none", Buffer.concat([honest, zstdUnsizedBomb(1)])],
      [
        "a skippable frame first",
        Buffer.concat([zstdSkippableFrame(8), honest]),
      ],
      [
        "a skippable frame last",
        Buffer.concat([honest, zstdSkippableFrame(8)]),
      ],
      ["trailing bytes", Buffer.concat([honest, new Uint8Array([1, 2, 3])])],
      ["truncated by a byte", honest.subarray(0, -1)],
      ["truncated in the header", honest.subarray(0, 5)],
      ["empty", new Uint8Array(0)],
      ["not zstd", new Uint8Array(32).fill(7)],
      ["the reserved bit", reservedBit],
      ["a dictionary id", dictionary],
      ["a reserved block type", reservedBlock],
    ] as const) {
      expect({ what, proof: nativeBound(zstd, payload, MiB) }).toEqual({
        what,
        proof: undefined,
      });
    }
  });

  test("a zstd payload declaring more than the limit is refused by the walk, which stops there", () => {
    expect(nativeBound(zstd, zstdBomb(8), 64 * 1024)).toEqual({ over: true });
    expect(nativeBound(zstd, zstdOverdeclaredBomb(1), MiB)).toEqual({
      over: true,
    });
    // The sum passes the limit at the third frame: what follows is never
    // read, so a broken tail does not turn the refusal into "unproven".
    const tail = Buffer.concat([zstdBomb(1), new Uint8Array([1, 2, 3])]);
    expect(nativeBound(zstd, tail, 64 * 1024)).toEqual({ over: true });
    // An over-declared frame under a cap past NATIVE_LIMIT is not refused,
    // only left to node:zlib.
    const big = Bun.zstdCompressSync(new Uint8Array(NATIVE_LIMIT + 1));
    expect(nativeBound(zstd, big, NATIVE_LIMIT)).toEqual({ over: true });
    const native = spyNative();
    expect(decompressBounded(zstd, big, Infinity).byteLength).toBe(
      NATIVE_LIMIT + 1,
    );
    expect(native.zstd).not.toHaveBeenCalled();
  });

  test("a lying zstd frame proven by its declaration is refused by Bun's decoder, within the declared size", () => {
    const native = spyNative();
    for (const cap of [64 * 1024, 4 * MiB, Infinity]) {
      let thrown: unknown;
      try {
        decompressBounded(zstd, zstdLyingBomb(64), cap);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(EntryDecodeError);
      expect((thrown as Error).message).toContain(
        "the 1000 bytes its frames declare",
      );
      expect(((thrown as Error).cause as { code?: unknown }).code).toBe(
        "ERR_ZSTD",
      );
    }
    expect(native.zstd).toHaveBeenCalledTimes(3);
    // And one declaring more than it holds.
    expect(() =>
      decompressBounded(zstd, zstdRleFrame(1000, 2000), MiB),
    ).toThrow("the 2000 bytes its frames declare");
  });

  test("gzip and DEFLATE are proven by the payload's length: 1,032 bytes out for each byte in", () => {
    const small = Bun.gzipSync(compressible(20_000));
    expect(small.byteLength * DEFLATE_MAX_RATIO).toBeLessThanOrEqual(4 * MiB);
    expect(nativeBound(gzip, small, 4 * MiB)).toEqual({
      native: small.byteLength * DEFLATE_MAX_RATIO,
    });
    const raw = Bun.deflateSync(compressible(20_000));
    expect(nativeBound(deflate, raw, 4 * MiB)).toEqual({
      native: raw.byteLength * DEFLATE_MAX_RATIO,
    });
    // One byte more than the cap allows, and it is node:zlib's.
    const atCap = small.byteLength * DEFLATE_MAX_RATIO;
    expect(nativeBound(gzip, small, atCap)).toEqual({ native: atCap });
    expect(nativeBound(gzip, small, atCap - 1)).toBeUndefined();
    expect(
      nativeBound(deflate, raw, raw.byteLength * 1032 - 1),
    ).toBeUndefined();
    // The bound is real: zlib's best case, zeros at level 9, stays under it.
    const zeros = Bun.deflateSync(new Uint8Array(16 * MiB), { level: 9 });
    expect(zeros.byteLength * DEFLATE_MAX_RATIO).toBeGreaterThan(16 * MiB);
    // Brotli has no native decoder.
    expect(
      nativeBound(COMPRESSOR_IDS.br, brotliCompressSync(small), 4 * MiB),
    ).toBeUndefined();
  });

  test("a gzip payload whose ISIZE passes the bound is node:zlib's: Bun would reserve it up front", () => {
    const packed = Bun.gzipSync(compressible(20_000));
    const lying = packed.slice();
    new DataView(lying.buffer).setUint32(lying.byteLength - 4, 200 * MiB, true);
    expect(nativeBound(gzip, lying, 4 * MiB)).toBeUndefined();
    const native = spyNative();
    expect(() => decompressBounded(gzip, lying, 4 * MiB)).toThrow(
      "incorrect length check",
    );
    expect(native.gzip).not.toHaveBeenCalled();
    // Shorter than a gzip member: node:zlib's error, as before.
    expect(nativeBound(gzip, packed.subarray(0, 19), 4 * MiB)).toBeUndefined();
    expect(nativeBound(deflate, new Uint8Array(0), 4 * MiB)).toBeUndefined();
  });

  test("a gzip payload of two members, or with bytes after its member, reads as node:zlib reads it", () => {
    // Bun.gunzipSync decodes only the first member and ignores what
    // follows; node:zlib decodes every member and refuses trailing bytes.
    const one = Bun.gzipSync(
      new Uint8Array(new TextEncoder().encode("hello ")),
    );
    const two = Buffer.concat([
      one,
      Bun.gzipSync(new Uint8Array(new TextEncoder().encode("world"))),
    ]);
    const native = spyNative();
    expect(new TextDecoder().decode(decompressBounded(gzip, two, MiB))).toBe(
      "hello world",
    );
    expect(native.gzip).toHaveBeenCalledTimes(1);
    const trailing = Buffer.concat([one, new Uint8Array([1, 2, 3, 4, 5])]);
    expect(() => decompressBounded(gzip, trailing, MiB)).toThrow();
  });
});

/** Reads the bomb `name` of `mib` MiB under `cap` in a fresh process (`bomb-rss-worker.ts`), so the peak RSS growth is the read's alone. */
async function readInFreshProcess(
  name: string,
  mib: number,
  cap: number,
): Promise<{
  value: string;
  phase: string;
  cause?: string;
  growthMiB: number;
}> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "bomb-rss-worker.ts"),
      name,
      String(mib),
      String(cap),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  return JSON.parse(stdout) as {
    value: string;
    phase: string;
    cause?: string;
    growthMiB: number;
  };
}

describe("the read's memory stays bounded", () => {
  // A 256 MiB bomb against a 1 MiB limit, read in a fresh process so the
  // peak RSS is the read's alone. Uncapped, Bun's decoders grew the process
  // by 330 MiB and more (the negative control); capped, by a few MiB —
  // whether node:zlib stopped it, the declared sizes refused it, or Bun's
  // decoder ran into a buffer of the declared size.
  test.each(BOMBS)(
    "a 256 MiB $name bomb raises the peak RSS by under 64 MiB",
    async ({ name, refusal }) => {
      const result = await readInFreshProcess(name, 256, 1024 * 1024);
      expect(result).toMatchObject({ value: "miss", phase: "decode" });
      expect(result.cause).toBe(REFUSAL_CAUSE[refusal]);
      expect(result.growthMiB).toBeLessThan(64);
    },
    30_000,
  );

  test("under a cap past NATIVE_LIMIT, a frame declaring 20 MiB that holds 256 MiB is node:zlib's, and stops at the cap", async () => {
    // Bun's decoder streams a frame declaring more than 16 MiB with no
    // limit (384 MiB of growth for this one, measured), so it never runs on
    // one: node:zlib stops it at the 32 MiB cap.
    const result = await readInFreshProcess(
      "zstd-overdeclared",
      256,
      32 * 1024 * 1024,
    );
    expect(result).toMatchObject({
      value: "miss",
      phase: "decode",
      cause: "ERR_BUFFER_TOO_LARGE",
    });
    expect(result.growthMiB).toBeLessThan(128);
  }, 30_000);
});
