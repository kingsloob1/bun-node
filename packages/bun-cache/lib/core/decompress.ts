/**
 * Bounded decompression of a stored entry's payload (plan §3.11; the
 * encryption plan's Q18). Anyone who can write to the store can plant a small
 * entry that expands to gigabytes, so a read never decompresses past the
 * cache's entry limit: the bomb is refused before it is materialised.
 *
 * `Bun.zstdDecompressSync` and `Bun.gunzipSync` take no output limit (measured
 * on Bun 1.4.4: a 25 KB zstd entry and a 531 KB gzip one each grew the
 * process by 650–730 MiB, decoding to 512 MiB). node:zlib's decoders take
 * `maxOutputLength` and stop as soon as the output passes it (the same
 * entries, capped at 1 MiB: 1–2 MiB of growth), so they decode every
 * compressed entry.
 *
 * One difference has to be made up for: node:zlib's `zstdDecompressSync`
 * answers empty or partial output for a truncated frame where Bun's threw
 * (measured on Bun 1.4.4 and Node 24.2 alike). Every frame this cache writes
 * declares its content size (`Bun.zstdCompressSync` and node:zlib's both
 * write it), so a declared size is held to the output — which also refuses a
 * frame declaring more than the cap before anything is decoded.
 *
 * Brotli and raw DEFLATE (PR-Z1) go through the same node:zlib bound
 * (`brotliDecompressSync`, `inflateRawSync`); a user compressor is handed the
 * cap and held to it by the core (`compression.ts`, with {@link overLimit}).
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
 * Decompresses an entry's payload as its header's compressor id says — zstd,
 * gzip, Brotli, raw DEFLATE, or none (the payload is returned as it is) —
 * producing at most `cap` bytes. A user compressor's id (128–255) is the
 * core's to decode (`compression.ts`); here it is an error.
 *
 * @param compressor The header's compressor id (`EntryHeader.compressor`).
 * @param payload The stored payload.
 * @param cap The most bytes the decoded payload may hold: the cache's entry
 *   limit (`maxEntryBytes`, capped by the driver's own). A non-finite cap
 *   (`Infinity`, `NaN`) decodes unbounded, up to `buffer.kMaxLength`.
 * @throws {EntryDecodeError} when the payload decodes past `cap`, without
 *   decoding the rest; node:zlib's own error for a corrupt payload.
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

/** A Zstandard frame's Magic_Number, read little-endian (RFC 8878 §3.1.1). */
const ZSTD_MAGIC = 0xfd2fb528;

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
