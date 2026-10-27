/**
 * The entry header (plan §3.2): the first bytes of every stored value.
 *
 * ```
 * offset  size  field
 * 0       2     magic "BC"
 * 2       1     format version (1)
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
 * The driver stores and returns these bytes untouched; only the core reads
 * them. An entry that does not parse is a miss, never a crash (§3.2).
 */

/** The format version byte. Bump on any incompatible change; old entries then decode-fail into misses. */
export const ENTRY_FORMAT = 1;

/** The sentinel {@link EntryHeader.freshUntil} takes for an entry that never goes stale. */
export const NO_FRESH_UNTIL = -1;

/** The flag bits of the header's flags byte. */
export const ENTRY_FLAGS = {
  /** The payload is zstd-compressed. */
  zstd: 1,
  /** The payload is gzip-compressed. */
  gzip: 2,
  /** The entry is a counter placeholder (counters live in the driver's own column; §3.8). */
  counter: 4,
  /** The entry is a cached negative: the loader answered `undefined` under `cacheUndefined` (§3.4). */
  negative: 8,
  /** The `"raw"` codec's payload was a string, so decode answers a string (§3.10). */
  rawString: 16,
} as const;

/** The fixed part's length: magic, format, codec, flags, three f64, one u32. */
const FIXED_LENGTH = 2 + 1 + 1 + 1 + 8 + 8 + 8 + 4;

/** Thrown by {@link decodeEntry} when the bytes are not a bun-cache entry; the core turns it into a miss plus an `error` event with `phase: "decode"`. */
export class EntryDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EntryDecodeError";
  }
}

/** Everything the header carries. */
export interface EntryHeader {
  /** The codec id the payload was written with. */
  codecId: number;
  /** The flags byte (see {@link ENTRY_FLAGS}). */
  flags: number;
  /** When the value's loader started, epoch ms. */
  createdAt: number;
  /** When the entry stops being fresh, epoch ms; {@link NO_FRESH_UNTIL} when never. */
  freshUntil: number;
  /** The last load's duration, epoch ms duration; 0 when unknown. */
  loadMs: number;
  /** The full key as written, before any hashing. */
  key: string;
}

/** Encodes `header` and `payload` into the stored bytes. */
export function encodeEntry(
  header: EntryHeader,
  payload: Uint8Array,
): Uint8Array {
  const keyBytes = new TextEncoder().encode(header.key);
  const out = new Uint8Array(FIXED_LENGTH + keyBytes.length + payload.length);
  const view = new DataView(out.buffer);
  out[0] = 0x42; // "B"
  out[1] = 0x43; // "C"
  out[2] = ENTRY_FORMAT;
  out[3] = header.codecId;
  out[4] = header.flags;
  view.setFloat64(5, header.createdAt, true);
  view.setFloat64(13, header.freshUntil, true);
  view.setFloat64(21, header.loadMs, true);
  view.setUint32(29, keyBytes.length, true);
  out.set(keyBytes, 33);
  out.set(payload, 33 + keyBytes.length);
  return out;
}

/**
 * Decodes the header and returns it with the payload slice (a view into
 * `bytes`, not a copy). Throws {@link EntryDecodeError} on anything that is
 * not a well-formed entry.
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
  if (bytes[2] !== ENTRY_FORMAT) {
    throw new EntryDecodeError(
      `entry format ${bytes[2]} is not ${ENTRY_FORMAT}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const keyLength = view.getUint32(29, true);
  if (FIXED_LENGTH + keyLength > bytes.length) {
    throw new EntryDecodeError(
      `entry's key of ${keyLength} bytes overruns its ${bytes.length} bytes`,
    );
  }
  const key = new TextDecoder().decode(
    bytes.subarray(FIXED_LENGTH, FIXED_LENGTH + keyLength),
  );
  return {
    header: {
      codecId: bytes[3],
      flags: bytes[4],
      createdAt: view.getFloat64(5, true),
      freshUntil: view.getFloat64(13, true),
      loadMs: view.getFloat64(21, true),
      key,
    },
    payload: bytes.subarray(FIXED_LENGTH + keyLength),
  };
}
