/**
 * Bounded decompression of a stored entry's payload (plan §3.11; the
 * encryption plan's Q18). Anyone who can write to the store can plant a small
 * entry that expands to gigabytes, so a read never decompresses past the
 * cache's entry limit: the bomb is refused before it is materialised.
 *
 * Two decoders, chosen per payload:
 *
 * - **Bun's native decoders** (`Bun.zstdDecompressSync`, `Bun.gunzipSync`,
 *   `Bun.inflateSync`) are 1.3–33× faster than node:zlib's (measured on Bun
 *   1.4.4: zstd 100 B 0.22–1.4 µs against 7.3 µs, 1 MB 100–780 µs against
 *   290–1,010 µs), but take no output limit: a 25 KB zstd entry and a 531 KB
 *   gzip one each grew the process by 650–730 MiB, decoding to 512 MiB. So
 *   they run only on a payload whose own bytes prove it decodes to at most the
 *   cap, and to at most {@link NATIVE_LIMIT} ({@link nativeBound}).
 * - **node:zlib's decoders** take `maxOutputLength` and stop as soon as the
 *   output passes it (the same entries, capped at 1 MiB: 1–2 MiB of growth),
 *   so they decode everything else: Brotli (Bun has no native decoder for it),
 *   a zstd payload whose frames do not all declare their size, a large gzip or
 *   DEFLATE payload, and anything malformed.
 *
 * One difference has to be made up for on the node:zlib path: its
 * `zstdDecompressSync` answers empty or partial output for a truncated frame
 * where Bun's throws (measured on Bun 1.4.4 and Node 24.2 alike). Every frame
 * this cache writes declares its content size (`Bun.zstdCompressSync` and
 * node:zlib's both write it), so a declared size is held to the output — which
 * also refuses a frame declaring more than the cap before anything is decoded.
 *
 * A user compressor is handed the cap and held to it by the core
 * (`compression.ts`, with {@link overLimit}).
 */
import { kMaxLength } from "node:buffer";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateRawSync,
  zstdDecompressSync,
} from "node:zlib";
import { COMPRESSOR_IDS, EntryDecodeError } from "./header";

/** The node:zlib decoder of each built-in compressor id. */
const DECODERS: ReadonlyMap<
  number,
  (payload: Uint8Array, options: { maxOutputLength: number }) => Uint8Array
> = new Map([
  [COMPRESSOR_IDS.zstd, zstdDecompressSync],
  [COMPRESSOR_IDS.gzip, gunzipSync],
  [COMPRESSOR_IDS.br, brotliDecompressSync],
  [COMPRESSOR_IDS.deflate, inflateRawSync],
]);

/**
 * The most a payload may prove it decodes to for a native decoder to run on
 * it: 16 MiB. It is Bun's own bound, not a tuning knob: `Bun.zstdDecompressSync`
 * reserves exactly the total its frames declare and decodes into that buffer
 * alone only while the total is at most 16 MiB; past it, or with a frame that
 * declares none, it streams into a growing buffer with no limit (measured on
 * Bun 1.4.2, 1.4.3 and 1.4.4: a frame declaring 15 MiB that holds 256 MiB grew
 * the process by 15 MiB before failing, one declaring 20 MiB by 384 MiB).
 * gzip and DEFLATE share it, so one figure bounds every native read.
 */
export const NATIVE_LIMIT = 16 * 1024 * 1024;

/**
 * The most bytes one byte of DEFLATE (RFC 1951) can decode to: 1,032. Every
 * Huffman code is at least one bit, so the cheapest output is a 258-byte
 * match (length code 285, no extra bits) at distance 1 (distance code 0, no
 * extra bits) in two bits — 129 bytes a bit; a literal is one byte a bit, a
 * stored block one byte a byte. zlib's best, on zeros, is 1,028.8 (64 MiB at
 * level 9, measured).
 */
export const DEFLATE_MAX_RATIO = 1032;

/**
 * The shortest gzip and raw DEFLATE payloads a native decoder is given: a
 * gzip member is at least its 10-byte header, a 2-byte empty block and its
 * 8-byte trailer (RFC 1952 §2.3), a DEFLATE stream at least one byte. Anything
 * shorter is corrupt, and node:zlib's error says so.
 */
const MIN_PAYLOAD: Readonly<Record<number, number>> = {
  [COMPRESSOR_IDS.gzip]: 20,
  [COMPRESSOR_IDS.deflate]: 1,
};

/**
 * The `maxOutputLength` a decoder is given for `cap`: node:zlib rejects a
 * limit of 0, so a cap under 1 asks for 1 byte and the caller's check refuses
 * it; a non-finite cap is `buffer.kMaxLength`.
 */
export function outputLimit(cap: number): number {
  return Number.isFinite(cap)
    ? Math.min(Math.max(Math.floor(cap), 1), kMaxLength)
    : kMaxLength;
}

/**
 * What a payload's own bytes prove about its decoded size, for
 * {@link decompressBounded}: `{ native: n }` when a native decoder may run,
 * which will answer exactly (zstd) or at most (gzip, DEFLATE) `n` bytes, `n`
 * no more than `limit`; `{ over: true }` when the payload's zstd frames
 * declare more than `limit` (so no decoder need run when `limit` is the cap);
 * `undefined` when nothing is proven, and node:zlib decodes it under the cap.
 *
 * - **zstd**: the payload is walked frame by frame and block by block (RFC
 *   8878 §3.1.1), as libzstd's `ZSTD_findDecompressedSize` walks it, and the
 *   frames' declared content sizes are summed. Proven only when the payload
 *   is nothing but zstd frames, each declaring its size, using no dictionary,
 *   with no reserved bit set, ending exactly at the payload's end. Bun then
 *   reserves exactly that sum (at most {@link NATIVE_LIMIT}) and libzstd's
 *   one-shot decoder never writes past it, and refuses a frame that decodes to
 *   anything but its declaration (a frame declaring 1,000 bytes that holds
 *   256 MiB failed with no growth).
 * - **gzip and raw DEFLATE**: no header declares a trustworthy size (gzip's
 *   ISIZE is the size mod 2^32, read only after decoding), but the payload's
 *   length bounds the output: at most {@link DEFLATE_MAX_RATIO} bytes for each
 *   of its bytes. gzip's ISIZE must not exceed the bound either, since Bun
 *   reserves that much up front (an honest one never does).
 *
 * @param compressor The header's compressor id.
 * @param payload The stored payload.
 * @param limit The most the payload may decode to: the cap, at most
 *   {@link NATIVE_LIMIT}.
 */
export function nativeBound(
  compressor: number,
  payload: Uint8Array,
  limit: number,
): { native: number } | { over: true } | undefined {
  if (compressor === COMPRESSOR_IDS.zstd) {
    const declared = zstdDeclaredSize(payload, limit);
    if (declared === undefined) {
      return undefined;
    }
    return declared > limit ? { over: true } : { native: declared };
  }
  if (
    compressor === COMPRESSOR_IDS.gzip ||
    compressor === COMPRESSOR_IDS.deflate
  ) {
    const bound = payload.byteLength * DEFLATE_MAX_RATIO;
    if (bound > limit || payload.byteLength < MIN_PAYLOAD[compressor]) {
      return undefined;
    }
    if (compressor === COMPRESSOR_IDS.gzip && gzipSize(payload) > bound) {
      return undefined;
    }
    return { native: bound };
  }
  return undefined;
}

/**
 * Decompresses an entry's payload as its header's compressor id says — zstd,
 * gzip, Brotli, raw DEFLATE, or none (the payload is returned as it is) —
 * producing at most `cap` bytes: natively where {@link nativeBound} proves
 * the output fits, through node:zlib with `maxOutputLength` otherwise. A user
 * compressor's id (128–255) is the core's to decode (`compression.ts`); here
 * it is an error.
 *
 * @param compressor The header's compressor id (`EntryHeader.compressor`).
 * @param payload The stored payload.
 * @param cap The most bytes the decoded payload may hold: the cache's entry
 *   limit (`maxEntryBytes`, capped by the driver's own). A non-finite cap
 *   (`Infinity`, `NaN`) decodes unbounded, up to `buffer.kMaxLength`.
 * @throws {EntryDecodeError} when the payload decodes past `cap`, without
 *   decoding the rest, or a zstd payload decodes to other than its frames
 *   declare; the decoder's own error for a corrupt payload.
 */
export function decompressBounded(
  compressor: number,
  payload: Uint8Array,
  cap: number,
): Uint8Array {
  if (compressor === COMPRESSOR_IDS.none) {
    return payload;
  }
  const decode = DECODERS.get(compressor);
  if (decode === undefined) {
    throw new EntryDecodeError(
      `compressor id ${compressor} is not a built-in one`,
    );
  }
  const bounded = Number.isFinite(cap);
  const proof = nativeBound(
    compressor,
    payload,
    bounded ? Math.min(cap, NATIVE_LIMIT) : NATIVE_LIMIT,
  );
  if (proof !== undefined && "native" in proof) {
    const output = decodeNative(compressor, payload, proof.native);
    if (output !== undefined) {
      if (bounded && output.byteLength > cap) {
        throw overLimit(cap);
      }
      return output;
    }
    // A gzip payload whose end is not its first member's trailer: Bun
    // decodes only the first member, node:zlib all of them, and node:zlib's
    // answer is the one this cache has always given (oven-sh/bun#47341;
    // remove this re-decode once a stable Bun decodes every member).
  } else if (proof !== undefined && bounded && cap <= NATIVE_LIMIT) {
    // The zstd frames declare more than the cap: refused before decoding.
    // (Under a larger cap they declare more than NATIVE_LIMIT, and node:zlib
    // decodes them.)
    throw overLimit(cap);
  }
  const declared =
    compressor === COMPRESSOR_IDS.zstd ? zstdContentSize(payload) : undefined;
  if (bounded && declared !== undefined && declared > cap) {
    throw overLimit(cap);
  }
  // node:zlib rejects a limit of 0; a 1-byte limit plus the check below
  // covers it (and a negative cap, which refuses everything).
  const maxOutputLength = outputLimit(cap);
  let output: Uint8Array;
  try {
    output = decode(payload, { maxOutputLength });
  } catch (error) {
    if (
      bounded &&
      (error as { code?: unknown } | null)?.code === "ERR_BUFFER_TOO_LARGE"
    ) {
      throw overLimit(cap, error);
    }
    throw error;
  }
  if (bounded && output.byteLength > cap) {
    throw overLimit(cap);
  }
  if (declared !== undefined && output.byteLength !== declared) {
    throw new EntryDecodeError(
      `the zstd payload decodes to ${output.byteLength} bytes, not the ${declared} its frame declares (truncated or corrupt)`,
    );
  }
  return output;
}

/**
 * Decodes a payload {@link nativeBound} proved fits in `bound` bytes with
 * Bun's own decoder. `undefined` for a gzip payload whose output is not the
 * size its last four bytes record: more than one member, or trailing bytes,
 * which Bun ignores and node:zlib does not.
 *
 * @throws {EntryDecodeError} when a zstd payload does not decode to the
 *   `bound` bytes its frames declare, with Bun's error as the cause; Bun's
 *   own error for a corrupt gzip or DEFLATE payload.
 */
function decodeNative(
  compressor: number,
  payload: Uint8Array,
  bound: number,
): Uint8Array | undefined {
  if (compressor === COMPRESSOR_IDS.zstd) {
    let output: Uint8Array;
    try {
      output = Bun.zstdDecompressSync(payload);
    } catch (error) {
      throw new EntryDecodeError(
        `the zstd payload does not decode to the ${bound} bytes its frames declare (corrupt, or a frame larger than it declares)`,
        { cause: error },
      );
    }
    if (output.byteLength !== bound) {
      // libzstd refuses this itself; held here so nothing depends on it.
      throw new EntryDecodeError(
        `the zstd payload decodes to ${output.byteLength} bytes, not the ${bound} its frames declare`,
      );
    }
    return output;
  }
  // Bun's decoders read a view's bytes, not the view: a subarray of the
  // stored entry decodes as itself.
  const bytes = payload as Uint8Array<ArrayBuffer>;
  if (compressor === COMPRESSOR_IDS.gzip) {
    // Bun decodes only the first member and ignores what follows it
    // (docs/bun-bugs/gunzip-sync-reads-first-member-only.md): the ISIZE
    // check sends anything else back to node:zlib. Remove it once fixed.
    const output = Bun.gunzipSync(bytes);
    return output.byteLength === gzipSize(payload) ? output : undefined;
  }
  return Bun.inflateSync(bytes);
}

/**
 * A gzip payload's ISIZE (RFC 1952 §2.3.1): the last four bytes, little
 * endian — the size of the last member's input, mod 2^32. The payload is at
 * least a member's length (`MIN_PAYLOAD`).
 */
function gzipSize(payload: Uint8Array): number {
  return new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  ).getUint32(payload.byteLength - 4, true);
}

/** A Zstandard frame's Magic_Number, read little-endian (RFC 8878 §3.1.1). */
const ZSTD_MAGIC = 0xfd2fb528;

/** The Block_Type of an RLE block: one byte repeated Block_Size times (RFC 8878 §3.1.1.2.2). */
const ZSTD_BLOCK_RLE = 1;

/** The reserved Block_Type: a frame holding one is corrupt (RFC 8878 §3.1.1.2.2). */
const ZSTD_BLOCK_RESERVED = 3;

/**
 * The sum of the Frame_Content_Sizes a payload's zstd frames declare, read
 * from the frame and block headers alone; `undefined` unless the payload is
 * nothing but zstd frames that each declare a size, use no dictionary, set no
 * reserved bit and end exactly at its end (a skippable frame, which this cache
 * never writes, is left to node:zlib too). The walk stops once the sum passes
 * `stopAbove`, and answers that partial sum: the payload declares more than
 * `stopAbove` whatever follows.
 */
function zstdDeclaredSize(
  payload: Uint8Array,
  stopAbove: number,
): number | undefined {
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const end = payload.byteLength;
  let total = 0;
  let at = 0;
  do {
    if (end - at < 6 || view.getUint32(at, true) !== ZSTD_MAGIC) {
      return undefined;
    }
    // Frame_Header_Descriptor: FCS_Field_Size flag (bits 7–6),
    // Single_Segment_Flag (bit 5), reserved (bit 3), Content_Checksum_Flag
    // (bit 2), Dictionary_ID_Flag (bits 1–0).
    const descriptor = payload[at + 4];
    if ((descriptor & 0x0b) !== 0) {
      // A dictionary, or the reserved bit: libzstd refuses both here.
      return undefined;
    }
    const singleSegment = (descriptor & 0x20) !== 0;
    const size = [singleSegment ? 1 : 0, 2, 4, 8][descriptor >> 6];
    if (size === 0) {
      // No Frame_Content_Size: Bun would stream it, unbounded.
      return undefined;
    }
    const field = at + 5 + (singleSegment ? 0 : 1);
    if (field + size > end) {
      return undefined;
    }
    total +=
      size === 1
        ? view.getUint8(field)
        : size === 2
          ? // The 2-byte field is offset by 256 (§3.1.1.4).
            view.getUint16(field, true) + 256
          : size === 4
            ? view.getUint32(field, true)
            : Number(view.getBigUint64(field, true));
    if (total > stopAbove) {
      return total;
    }
    at = field + size;
    // The blocks: a 3-byte header each (Last_Block bit 0, Block_Type bits
    // 1–2, Block_Size bits 3–23), then Block_Size bytes, or one for RLE.
    let last: boolean;
    do {
      if (at + 3 > end) {
        return undefined;
      }
      const header =
        payload[at] | (payload[at + 1] << 8) | (payload[at + 2] << 16);
      const type = (header >> 1) & 3;
      if (type === ZSTD_BLOCK_RESERVED) {
        return undefined;
      }
      last = (header & 1) === 1;
      at += 3 + (type === ZSTD_BLOCK_RLE ? 1 : header >>> 3);
    } while (!last);
    if ((descriptor & 0x04) !== 0) {
      at += 4; // Content_Checksum
    }
    if (at > end) {
      return undefined;
    }
  } while (at < end);
  return total;
}

/**
 * The Frame_Content_Size the payload's first zstd frame declares, or
 * `undefined` when it declares none (RFC 8878 §3.1.1.1). Reads the frame
 * header only.
 *
 * @throws {EntryDecodeError} when the payload does not start with a whole
 *   zstd frame header (this cache writes nothing else; a skippable frame
 *   first is refused too).
 */
function zstdContentSize(payload: Uint8Array): number | undefined {
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  if (payload.byteLength < 5 || view.getUint32(0, true) !== ZSTD_MAGIC) {
    throw new EntryDecodeError("the payload is not a zstd frame");
  }
  // Frame_Header_Descriptor: FCS_Field_Size flag (bits 7–6),
  // Single_Segment_Flag (bit 5), Dictionary_ID_Flag (bits 1–0).
  const descriptor = payload[4];
  const fcsFlag = descriptor >> 6;
  const singleSegment = (descriptor & 0x20) !== 0;
  const offset = 5 + (singleSegment ? 0 : 1) + [0, 1, 2, 4][descriptor & 3];
  const size = [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag];
  if (payload.byteLength < offset + size) {
    throw new EntryDecodeError("the zstd frame header is truncated");
  }
  switch (size) {
    case 1:
      return view.getUint8(offset);
    case 2:
      // The 2-byte field is offset by 256 (§3.1.1.4).
      return view.getUint16(offset, true) + 256;
    case 4:
      return view.getUint32(offset, true);
    case 8:
      return Number(view.getBigUint64(offset, true));
    default:
      return undefined;
  }
}

/** The error a payload that decodes past `cap` throws (a user compressor's answer too). */
export function overLimit(cap: number, cause?: unknown): EntryDecodeError {
  return new EntryDecodeError(
    `the entry decompresses past the ${cap}-byte limit (maxEntryBytes)`,
    cause === undefined ? undefined : { cause },
  );
}
