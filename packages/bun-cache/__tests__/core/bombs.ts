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

/** The decoded size of each of a zstd bomb's frames: 32 KiB, under every limit the tests set, so no one frame's declared size gives the bomb away: their sum does. */
const ZSTD_FRAME_BYTES = 32 * 1024;

/**
 * A zstd payload decoding to `mib` MiB of zeros: frames of 32 KiB (17 bytes
 * each), concatenated — zstd decodes a sequence of frames to the
 * concatenation of their outputs (RFC 8878 §3.1), and so does
 * `Bun.zstdDecompressSync`. Each frame declares its own size honestly, so the
 * read refuses it by their sum, before decoding (`decompress.ts`'s
 * `nativeBound`).
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

/** The most one zstd block may decode to (RFC 8878 §3.1.1.2.4), and what each RLE block of {@link zstdRleFrame} holds. */
const ZSTD_BLOCK_MAX = 128 * 1024;

/** A zstd skippable frame's first Magic_Number (RFC 8878 §3.1.2): decoders skip what it holds. */
const ZSTD_SKIPPABLE_MAGIC = 0x184d2a50;

/**
 * One zstd frame decoding to `actual` bytes of zeros, built by hand from RLE
 * blocks of 128 KiB (4 bytes each, so 256 MiB is 8 KiB of frame), that
 * **declares** `declared` as its Frame_Content_Size in a 4-byte field, or no
 * size at all when `declared` is undefined. Its window is 128 KiB, so the
 * frame is valid whatever it declares; only the declaration can lie.
 */
export function zstdRleFrame(
  actual: number,
  declared: number | undefined,
): Uint8Array {
  const blocks = Math.max(1, Math.ceil(actual / ZSTD_BLOCK_MAX));
  const header = declared === undefined ? 6 : 10;
  const out = new Uint8Array(header + blocks * 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0xfd2fb528, true);
  // Frame_Header_Descriptor: FCS_Field_Size flag 2 (4 bytes) or 0 (none),
  // not single-segment, no checksum, no dictionary.
  out[4] = declared === undefined ? 0 : 2 << 6;
  // Window_Descriptor: Exponent 7, Mantissa 0 — a 2^17-byte window.
  out[5] = 7 << 3;
  if (declared !== undefined) {
    view.setUint32(6, declared, true);
  }
  let left = actual;
  for (let i = 0; i < blocks; i++) {
    const size = Math.min(left, ZSTD_BLOCK_MAX);
    left -= size;
    // Block_Header: Last_Block, Block_Type 1 (RLE), Block_Size; then the byte.
    const block = (size << 3) | (1 << 1) | (i === blocks - 1 ? 1 : 0);
    out[header + i * 4] = block & 0xff;
    out[header + i * 4 + 1] = (block >> 8) & 0xff;
    out[header + i * 4 + 2] = (block >> 16) & 0xff;
  }
  return out;
}

/** A zstd skippable frame holding `length` zero bytes. */
export function zstdSkippableFrame(length: number): Uint8Array {
  const out = new Uint8Array(8 + length);
  const view = new DataView(out.buffer);
  view.setUint32(0, ZSTD_SKIPPABLE_MAGIC, true);
  view.setUint32(4, length, true);
  return out;
}

/** A frame that declares no content size and decodes to `mib` MiB: only a decoder's own limit stops it. */
export function zstdUnsizedBomb(mib: number): Uint8Array {
  return zstdRleFrame(mib * MiB, undefined);
}

/** One frame that declares 1,000 bytes and decodes to `mib` MiB: the lie the native decoder is handed. */
export function zstdLyingBomb(mib: number): Uint8Array {
  return zstdRleFrame(mib * MiB, 1000);
}

/** An honest 32 KiB frame, then a frame declaring 1,000 bytes that decodes to `mib` MiB: the lie is not in the first frame. */
export function zstdLyingTailBomb(mib: number): Uint8Array {
  return Buffer.concat([
    zstdRleFrame(ZSTD_FRAME_BYTES, ZSTD_FRAME_BYTES),
    zstdRleFrame(mib * MiB, 1000),
  ]);
}

/** One frame declaring 20 MiB — past `NATIVE_LIMIT`, under a 32 MiB cap — that decodes to `mib` MiB. */
export function zstdOverdeclaredBomb(mib: number): Uint8Array {
  return zstdRleFrame(mib * MiB, 20 * MiB);
}

/** An honest 32 KiB frame, a skippable frame, then a frame with no declared size decoding to `mib` MiB. */
export function zstdSkippableBomb(mib: number): Uint8Array {
  return Buffer.concat([
    zstdRleFrame(ZSTD_FRAME_BYTES, ZSTD_FRAME_BYTES),
    zstdSkippableFrame(16),
    zstdRleFrame(mib * MiB, undefined),
  ]);
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

/**
 * How a read refuses a bomb, which says which decoder (if any) ran:
 *
 * - `"limit"`: node:zlib stopped at the cap (its `ERR_BUFFER_TOO_LARGE` is the cause);
 * - `"declared"`: the zstd frames declare more than the cap, so no decoder ran (no cause);
 * - `"native"`: Bun's decoder ran, within the size the frames declare, and refused a frame
 *   holding more than it declares (Bun's `ERR_ZSTD` is the cause).
 */
export type BombRefusal = "limit" | "declared" | "native";

/** One kind of bomb: its name, its algorithm, the header's compressor id, its builder, and how a read under a cap of 64 KiB to 1 MiB refuses it. */
export interface BombKind {
  /** The bomb's name: its algorithm's, then how it is built when an algorithm has several. */
  name: string;
  /** The compression algorithm. */
  algorithm: "zstd" | "gzip" | "br" | "deflate";
  /** The header's compressor id for a payload compressed with it. */
  compressor: number;
  /** Builds a payload decoding to this many MiB. */
  build: (mib: number) => Uint8Array | Promise<Uint8Array>;
  /** How a read under a cap of 64 KiB to 1 MiB refuses it. */
  refusal: BombRefusal;
}

/** Every built-in compressor's bombs, zstd's in each shape its proof has to refuse. */
export const BOMBS: BombKind[] = [
  {
    name: "zstd",
    algorithm: "zstd",
    compressor: COMPRESSOR_IDS.zstd,
    build: zstdBomb,
    refusal: "declared",
  },
  {
    name: "zstd-unsized",
    algorithm: "zstd",
    compressor: COMPRESSOR_IDS.zstd,
    build: zstdUnsizedBomb,
    refusal: "limit",
  },
  {
    name: "zstd-lying",
    algorithm: "zstd",
    compressor: COMPRESSOR_IDS.zstd,
    build: zstdLyingBomb,
    refusal: "native",
  },
  {
    name: "zstd-lying-tail",
    algorithm: "zstd",
    compressor: COMPRESSOR_IDS.zstd,
    build: zstdLyingTailBomb,
    refusal: "native",
  },
  {
    name: "zstd-skippable",
    algorithm: "zstd",
    compressor: COMPRESSOR_IDS.zstd,
    build: zstdSkippableBomb,
    refusal: "limit",
  },
  {
    name: "zstd-overdeclared",
    algorithm: "zstd",
    compressor: COMPRESSOR_IDS.zstd,
    build: zstdOverdeclaredBomb,
    refusal: "declared",
  },
  {
    name: "gzip",
    algorithm: "gzip",
    compressor: COMPRESSOR_IDS.gzip,
    build: gzipBomb,
    refusal: "limit",
  },
  {
    name: "br",
    algorithm: "br",
    compressor: COMPRESSOR_IDS.br,
    build: brBomb,
    refusal: "limit",
  },
  {
    name: "deflate",
    algorithm: "deflate",
    compressor: COMPRESSOR_IDS.deflate,
    build: deflateBomb,
    refusal: "limit",
  },
];

/** The error `cause`'s code each refusal carries (`undefined`: no cause). */
export const REFUSAL_CAUSE: Readonly<Record<BombRefusal, string | undefined>> =
  {
    limit: "ERR_BUFFER_TOO_LARGE",
    declared: undefined,
    native: "ERR_ZSTD",
  };
