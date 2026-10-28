/**
 * The entry header (plan §3.2): the first bytes of every stored value.
 *
 * ```
 * offset  size  field
 * 0       2     magic "BC"
 * 2       1     format version (1 or 2)
 * 3       1     codec id (1 structured, 2 json, 3 raw, 128–255 custom)
 * 4       1     flags (bit0 zstd, bit1 gzip, bit2 counter, bit3 negative marker, bit4 raw-as-string)
 * 5       8     createdAt   f64 LE — when the loader started (the tag fence reads it)
 * 13      8     freshUntil  f64 LE — epoch ms, -1 when the entry never goes stale
 * 21      8     loadMs      f64 LE — the last load's duration (early expiry, §3.5); 0 when unknown
 * 29      4     key length  u32 LE — of the UTF-8 bytes that follow
 * 33      …     the full key — detects a long-key hash collision (§3.7)
 * …       …     the payload — codec bytes, compressed when flagged
 * ```
 *
 * Format 2 (the encryption plan's §8.3) has one more byte, the compressor id,
 * after the flags; its flags byte keeps bits 0–1 zero, and every later field
 * is one byte further on:
 *
 * ```
 * "BC" | 2 | codec | flags | compressor id | createdAt | freshUntil | loadMs | key length | key | payload
 * ```
 *
 * {@link encodeEntry} writes format 1 whenever it can express the entry (no
 * compression, zstd or gzip) and format 2 only for `br`, `deflate` or a user
 * compressor, so a cache configured as before writes what it always wrote and
 * a process on an older version reads it during a rolling deploy.
 *
 * The driver stores and returns these bytes untouched; only the core reads
 * them. An entry that does not parse is a miss, never a crash (§3.2).
 */

/** The format version byte of an entry with no compression, zstd or gzip. Bump on any incompatible change; old entries then decode-fail into misses. */
export const ENTRY_FORMAT = 1;

/** The format version byte of an entry that needs a compressor id: `br`, `deflate` or a user compressor (the encryption plan's §8.3). */
export const ENTRY_FORMAT_2 = 2;

/**
 * The compressor ids (the encryption plan's §8.3). 0–127 are the package's;
 * 128–255 are user compressors'. Format 1 expresses 0–2 in its flags byte;
 * the rest need format 2.
 */
export const COMPRESSOR_IDS = {
  /** Not compressed. */
  none: 0,
  /** zstd (`Bun.zstdCompressSync`). */
  zstd: 1,
  /** gzip (`Bun.gzipSync`). */
  gzip: 2,
  /** Brotli (`node:zlib`). */
  br: 3,
  /** Raw DEFLATE, RFC 1951 (`Bun.deflateSync`): not the zlib-wrapped form HTTP's `deflate` means. */
  deflate: 4,
} as const;

/** The sentinel {@link EntryHeader.freshUntil} takes for an entry that never goes stale. */
export const NO_FRESH_UNTIL = -1;

/** The flag bits of the header's flags byte. */
export const ENTRY_FLAGS = {
  /** Format 1: the payload is zstd-compressed. Read into {@link EntryHeader.compressor}, never left in {@link EntryHeader.flags}. */
  zstd: 1,
  /** Format 1: the payload is gzip-compressed. Read into {@link EntryHeader.compressor}, never left in {@link EntryHeader.flags}. */
  gzip: 2,
  /** The entry is a counter placeholder (counters live in the driver's own column; §3.8). */
  counter: 4,
  /** The entry is a cached negative: the loader answered `undefined` under `cacheUndefined` (§3.4). */
  negative: 8,
  /** The `"raw"` codec's payload was a string, so decode answers a string (§3.10). */
  rawString: 16,
} as const;

/** Format 1's fixed part's length: magic, format, codec, flags, three f64, one u32. */
const FIXED_LENGTH = 2 + 1 + 1 + 1 + 8 + 8 + 8 + 4;

/** The flag bits format 1 spends on compression; format 2 keeps them zero. */
const COMPRESSION_BITS = ENTRY_FLAGS.zstd | ENTRY_FLAGS.gzip;

/** Thrown by {@link decodeEntry} when the bytes are not a bun-cache entry, and by `decompressBounded` when a payload decodes past the entry limit; the core turns it into a miss plus an `error` event with `phase: "decode"`. */
export class EntryDecodeError extends Error {
  constructor(
    /** What is wrong with the bytes. */
    message: string,
    /** The standard `cause`: the decompressor's own error, for a payload over the limit. */
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EntryDecodeError";
  }
}

/** Everything the header carries. */
export interface EntryHeader {
  /** The codec id the payload was written with. */
  codecId: number;
  /** The flags byte (see {@link ENTRY_FLAGS}) without its compression bits, which {@link EntryHeader.compressor} carries. */
  flags: number;
  /** The payload's compressor id (see {@link COMPRESSOR_IDS}; 128–255 a user compressor); 0 when uncompressed. */
  compressor: number;
  /** When the value's loader started, epoch ms. */
  createdAt: number;
  /** When the entry stops being fresh, epoch ms; {@link NO_FRESH_UNTIL} when never. */
  freshUntil: number;
  /** The last load's duration, epoch ms duration; 0 when unknown. */
  loadMs: number;
  /** The full key as written, before any hashing. */
  key: string;
}

/**
 * Encodes `header` and `payload` into the stored bytes: format 1 when the
 * compressor is none, zstd or gzip, format 2 otherwise.
 */
export function encodeEntry(
  header: EntryHeader,
  payload: Uint8Array,
): Uint8Array {
  const keyBytes = new TextEncoder().encode(header.key);
  const flags = header.flags & ~COMPRESSION_BITS;
  const format1 =
    header.compressor === COMPRESSOR_IDS.none ||
    header.compressor === COMPRESSOR_IDS.zstd ||
    header.compressor === COMPRESSOR_IDS.gzip;
  // Format 2's compressor byte shifts every later field by one.
  const shift = format1 ? 0 : 1;
  const fixed = FIXED_LENGTH + shift;
  const out = new Uint8Array(fixed + keyBytes.length + payload.length);
  const view = new DataView(out.buffer);
  out[0] = 0x42; // "B"
  out[1] = 0x43; // "C"
  out[3] = header.codecId;
  if (format1) {
    out[2] = ENTRY_FORMAT;
    out[4] =
      flags |
      (header.compressor === COMPRESSOR_IDS.zstd
        ? ENTRY_FLAGS.zstd
        : header.compressor === COMPRESSOR_IDS.gzip
          ? ENTRY_FLAGS.gzip
          : 0);
  } else {
    out[2] = ENTRY_FORMAT_2;
    out[4] = flags;
    out[5] = header.compressor;
  }
  view.setFloat64(5 + shift, header.createdAt, true);
  view.setFloat64(13 + shift, header.freshUntil, true);
  view.setFloat64(21 + shift, header.loadMs, true);
  view.setUint32(29 + shift, keyBytes.length, true);
  out.set(keyBytes, fixed);
  out.set(payload, fixed + keyBytes.length);
  return out;
}

/**
 * Decodes the header, format 1 or 2, and returns it with the payload slice (a
 * view into `bytes`, not a copy). Throws {@link EntryDecodeError} on anything
 * that is not a well-formed entry. The compressor id is not checked here: an
 * unknown one is the core's miss, as an unknown codec id is.
 */
export function decodeEntry(bytes: Uint8Array): {
  /** The decoded header. */
  header: EntryHeader;
  /** The payload, a view into the input. */
  payload: Uint8Array;
} {
  if (bytes.length < FIXED_LENGTH) {
    throw new EntryDecodeError(
      `entry is ${bytes.length} bytes, under the ${FIXED_LENGTH}-byte header`,
    );
  }
  if (bytes[0] !== 0x42 || bytes[1] !== 0x43) {
    throw new EntryDecodeError("entry does not start with the BC magic");
  }
  const format = bytes[2];
  if (format !== ENTRY_FORMAT && format !== ENTRY_FORMAT_2) {
    throw new EntryDecodeError(
      `entry format ${format} is not ${ENTRY_FORMAT} or ${ENTRY_FORMAT_2}`,
    );
  }
  const shift = format === ENTRY_FORMAT ? 0 : 1;
  const fixed = FIXED_LENGTH + shift;
  if (bytes.length < fixed) {
    throw new EntryDecodeError(
      `entry is ${bytes.length} bytes, under the ${fixed}-byte format-${format} header`,
    );
  }
  const rawFlags = bytes[4];
  let compressor: number;
  if (format === ENTRY_FORMAT) {
    const bits = rawFlags & COMPRESSION_BITS;
    if (bits === COMPRESSION_BITS) {
      throw new EntryDecodeError("entry is flagged both zstd and gzip");
    }
    compressor =
      bits === ENTRY_FLAGS.zstd
        ? COMPRESSOR_IDS.zstd
        : bits === ENTRY_FLAGS.gzip
          ? COMPRESSOR_IDS.gzip
          : COMPRESSOR_IDS.none;
  } else {
    if ((rawFlags & COMPRESSION_BITS) !== 0) {
      throw new EntryDecodeError(
        "a format-2 entry has format 1's compression flags set",
      );
    }
    compressor = bytes[5];
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keyLength = view.getUint32(29 + shift, true);
  if (fixed + keyLength > bytes.length) {
    throw new EntryDecodeError(
      `entry's key of ${keyLength} bytes overruns its ${bytes.length} bytes`,
    );
  }
  const key = new TextDecoder().decode(
    bytes.subarray(fixed, fixed + keyLength),
  );
  return {
    header: {
      codecId: bytes[3],
      flags: rawFlags & ~COMPRESSION_BITS,
      compressor,
      createdAt: view.getFloat64(5 + shift, true),
      freshUntil: view.getFloat64(13 + shift, true),
      loadMs: view.getFloat64(21 + shift, true),
      key,
    },
    payload: bytes.subarray(fixed + keyLength),
  };
}
