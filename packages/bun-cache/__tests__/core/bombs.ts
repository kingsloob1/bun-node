/**
 * Decompression bombs for the Q18 tests: small entries that expand to many
 * MiB, built without ever holding the expansion in memory (so a test's peak
 * RSS measures the read, not the bomb's making), and a helper that plants one
 * in a driver behind the cache's back, as anyone who can write to the store
 * could.
 */
import { Buffer } from "node:buffer";
import {
  constants,
  crc32,
  createBrotliCompress,
  deflateRawSync,
} from "node:zlib";
import type { CacheDriver } from "../../lib/index";
import {
  COMPRESSOR_IDS,
  encodeEntry,
  NO_FRESH_UNTIL,
} from "../../lib/core/header";

/** One MiB, the unit the bombs are built in. */
const MiB = 1024 * 1024;

/** The decoded size of each of a zstd bomb's frames: 32 KiB, under every limit the tests set, so no frame's declared size gives the bomb away and the decoder's own limit is what stops it. */
const ZSTD_FRAME_BYTES = 32 * 1024;

/**
 * A zstd payload decoding to `mib` MiB of zeros: frames of 32 KiB (17 bytes
 * each), concatenated — zstd decodes a sequence of frames to the
 * concatenation of their outputs (RFC 8878 §3.1), and so does
 * `Bun.zstdDecompressSync`. Each frame declares its own size honestly; only
 * the first is read before decoding.
 */
export function zstdBomb(mib: number): Uint8Array {
  const frame = Bun.zstdCompressSync(new Uint8Array(ZSTD_FRAME_BYTES));
  const count = (mib * MiB) / ZSTD_FRAME_BYTES;
  const bomb = new Uint8Array(frame.byteLength * count);
  for (let i = 0; i < count; i++) {
    bomb.set(frame, i * frame.byteLength);
  }
  return bomb;
}

/**
 * A raw DEFLATE payload (PR-Z1's `"deflate"`) decoding to `mib` MiB of zeros:
 * the same full-flushed one-MiB blocks as {@link gzipBomb}, repeated, then an
 * empty final block, with no wrapper.
 */
export function deflateBomb(mib: number): Uint8Array {
  const blocks = deflateRawSync(new Uint8Array(MiB), {
    finishFlush: constants.Z_FULL_FLUSH,
  });
  return Buffer.concat([
    ...Array.from({ length: mib }, () => blocks),
    deflateRawSync(new Uint8Array(0)),
  ]);
}

/**
 * A Brotli payload (PR-Z1's `"br"`) decoding to `mib` MiB of zeros, streamed
 * through one compressor a MiB at a time (the same zeroed MiB each time), so
 * the expansion is never held: a Brotli stream cannot be concatenated as
 * DEFLATE blocks can, and node:zlib's Brotli has no synchronous streaming.
 */
export async function brBomb(mib: number): Promise<Uint8Array> {
  const compressor = createBrotliCompress({
    params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
  });
  const chunks: Uint8Array[] = [];
  compressor.on("data", (chunk: Uint8Array) => {
    chunks.push(chunk);
  });
  const done = new Promise<void>((resolve, reject) => {
    compressor.on("end", resolve);
    compressor.on("error", reject);
  });
  const zeros = new Uint8Array(MiB);
  for (let i = 0; i < mib; i++) {
    if (!compressor.write(zeros)) {
      await new Promise((resolve) => compressor.once("drain", resolve));
    }
  }
  compressor.end();
  await done;
  return Buffer.concat(chunks);
}

/**
 * A gzip payload decoding to `mib` MiB of zeros, as **one** member (so
 * `Bun.gunzipSync`, which decodes only the first, expands all of it): the
 * DEFLATE blocks of one MiB, ended by a full flush so they stand alone, are
 * repeated, then closed by an empty final block, between a gzip header and a
 * trailer with the real CRC-32 and size (RFC 1952).
 */
export function gzipBomb(mib: number): Uint8Array {
  const zeros = new Uint8Array(MiB);
  const blocks = deflateRawSync(zeros, {
    finishFlush: constants.Z_FULL_FLUSH,
  });
  const last = deflateRawSync(new Uint8Array(0));
  let crc = 0;
  for (let i = 0; i < mib; i++) {
    crc = crc32(zeros, crc);
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc >>> 0, 0);
  trailer.writeUInt32LE((mib * MiB) >>> 0, 4);
  return Buffer.concat([
    // Magic, CM 8 (deflate), no flags, no mtime, no XFL, OS unknown.
    new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]),
    ...Array.from({ length: mib }, () => blocks),
    last,
    trailer,
  ]);
}

/**
 * Writes a well-formed entry for `key` whose payload is `payload`,
 * compressed with `compressor` (a `COMPRESSOR_IDS` value; format 1 for zstd
 * and gzip, format 2 for br and deflate), straight into `driver` under
 * the default namespace — the cache's own codec ("raw", id 3) would answer
 * the decoded bytes, so only the cap stands between a read and the bomb.
 */
export async function plantEntry(
  driver: CacheDriver,
  key: string,
  compressor: number,
  payload: Uint8Array,
): Promise<void> {
  await driver.set("cache", {
    key,
    value: encodeEntry(
      {
        codecId: 3,
        flags: 0,
        compressor,
        createdAt: Date.now(),
        freshUntil: NO_FRESH_UNTIL,
        loadMs: 0,
        key,
      },
      payload,
    ),
    expiresAt: null,
    tags: [],
  });
}

/** One kind of bomb: its algorithm's name, the header's compressor id, and its builder. */
export interface BombKind {
  /** The compression algorithm. */
  algorithm: "zstd" | "gzip" | "br" | "deflate";
  /** The header's compressor id for a payload compressed with it. */
  compressor: number;
  /** Builds a payload decoding to this many MiB. */
  build: (mib: number) => Uint8Array | Promise<Uint8Array>;
}

/** Every built-in compressor, with the bomb builder for each. */
export const BOMBS: BombKind[] = [
  { algorithm: "zstd", compressor: COMPRESSOR_IDS.zstd, build: zstdBomb },
  { algorithm: "gzip", compressor: COMPRESSOR_IDS.gzip, build: gzipBomb },
  { algorithm: "br", compressor: COMPRESSOR_IDS.br, build: brBomb },
  {
    algorithm: "deflate",
    compressor: COMPRESSOR_IDS.deflate,
    build: deflateBomb,
  },
];
