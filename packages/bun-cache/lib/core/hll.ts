/**
 * Distinct counts (`pfAdd`/`pfCount`, capability `distinctCount`): a
 * HyperLogLog sketch per key, written once here and stored as bytes by every
 * driver that has no native one (Redis has `PFADD`/`PFCOUNT`). Internal:
 * nothing here is exported from the package.
 *
 * - **Precision** 14: 16,384 registers, a standard error of about 0.81%
 *   (1.04/√16384); estimates below about 40,000 use linear counting, which
 *   is close to exact for the small sets distinct counts are mostly about.
 * - **Hash**: 64 bits from two MurmurHash3 x86_32 passes over the element's
 *   UTF-8, with fixed seeds. Pure JavaScript, so every process (and every
 *   Bun version) places an element in the same register: sketches written
 *   by different processes merge correctly. The register is the top 14
 *   bits; the rank is the position of the first set bit in the other 50, so
 *   at most 51.
 * - **Encoding** (`BH` and a kind byte): **sparse** for small sets, 3 bytes
 *   per non-empty register (index and rank, sorted by index), up to
 *   {@link SPARSE_MAX} registers; **dense** past that, 16,384 6-bit registers
 *   packed into 12,288 bytes. A sketch is therefore at most 12,291 bytes.
 * - **Union** (`pfCount` over several keys) is the register-wise maximum.
 *
 * Only registers are stored, never an element: a sketch says how many
 * distinct elements went in, not which.
 */

/** The precision: the register index's bit count. */
const PRECISION = 14;

/** The registers in a sketch. */
export const HLL_REGISTERS = 1 << PRECISION;

/** The bias correction for {@link HLL_REGISTERS} registers. */
const ALPHA = 0.7213 / (1 + 1.079 / HLL_REGISTERS);

/** A sketch's first two bytes, `BH`. */
const MAGIC_0 = 0x42;
/** The second magic byte. */
const MAGIC_1 = 0x48;
/** The sparse kind byte. */
const SPARSE = 1;
/** The dense kind byte. */
const DENSE = 2;
/** The header's length: magic and kind. */
const HEADER = 3;
/** The most registers kept sparse (6 KiB); past it, the sketch is dense. */
export const SPARSE_MAX = 2048;
/** A dense sketch's body: 16,384 registers of 6 bits. */
const DENSE_BYTES = (HLL_REGISTERS * 6) / 8;

/** The most bytes a sketch takes (dense). */
export const HLL_MAX_BYTES = HEADER + DENSE_BYTES;

/** 2^-rank, for every rank a register can hold. */
const INVERSE_POWERS = Float64Array.from(
  { length: 64 },
  (_, rank) => 2 ** -rank,
);

/** The UTF-8 encoder, shared. */
const ENCODER = new TextEncoder();

/** MurmurHash3 x86_32 of `bytes` with `seed`. */
export function murmur3(bytes: Uint8Array, seed: number): number {
  let h = seed >>> 0;
  const length = bytes.length;
  const blocks = length & ~3;
  for (let i = 0; i < blocks; i += 4) {
    let k =
      (bytes[i] ?? 0) |
      ((bytes[i + 1] ?? 0) << 8) |
      ((bytes[i + 2] ?? 0) << 16) |
      ((bytes[i + 3] ?? 0) << 24);
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  const tail = length & 3;
  if (tail > 0) {
    let k = 0;
    if (tail === 3) k ^= (bytes[blocks + 2] ?? 0) << 16;
    if (tail >= 2) k ^= (bytes[blocks + 1] ?? 0) << 8;
    k ^= bytes[blocks] ?? 0;
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
  }
  h ^= length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Where an element lands: its register and the rank it offers. */
export function place(element: string): { index: number; rank: number } {
  const bytes = ENCODER.encode(element);
  const high = murmur3(bytes, 0x9747b28c);
  const low = murmur3(bytes, 0x5bd1e995);
  const index = high >>> (32 - PRECISION);
  // The 50 bits after the index: the high word's low 18, then the low word.
  const rest = high & ((1 << (32 - PRECISION)) - 1);
  let rank: number;
  if (rest !== 0) {
    rank = Math.clz32(rest) - PRECISION + 1;
  } else if (low !== 0) {
    rank = 32 - PRECISION + Math.clz32(low) + 1;
  } else {
    rank = 64 - PRECISION + 1;
  }
  return { index, rank };
}

/** A stored sketch that is not one. */
export class SketchFormatError extends TypeError {
  constructor(why: string) {
    super(`not a bun-cache distinct-count sketch: ${why}`);
    this.name = "SketchFormatError";
  }
}

/**
 * A stored sketch's registers, one byte each. `undefined` or an empty value
 * is an empty sketch. Throws a {@link SketchFormatError} for bytes that are
 * not a sketch.
 */
export function decodeSketch(stored: Uint8Array | undefined): Uint8Array {
  const registers = new Uint8Array(HLL_REGISTERS);
  if (stored === undefined || stored.length === 0) return registers;
  if (
    stored.length < HEADER ||
    stored[0] !== MAGIC_0 ||
    stored[1] !== MAGIC_1
  ) {
    throw new SketchFormatError("bad header");
  }
  if (stored[2] === SPARSE) {
    const body = stored.length - HEADER;
    if (body % 3 !== 0 || body / 3 > SPARSE_MAX) {
      throw new SketchFormatError("bad sparse length");
    }
    for (let at = HEADER; at < stored.length; at += 3) {
      const packed =
        ((stored[at] ?? 0) << 16) |
        ((stored[at + 1] ?? 0) << 8) |
        (stored[at + 2] ?? 0);
      const index = packed >>> 6;
      const rank = packed & 63;
      if (index >= HLL_REGISTERS || rank === 0) {
        throw new SketchFormatError("bad sparse register");
      }
      registers[index] = rank;
    }
    return registers;
  }
  if (stored[2] === DENSE) {
    if (stored.length !== HLL_MAX_BYTES) {
      throw new SketchFormatError("bad dense length");
    }
    for (let index = 0; index < HLL_REGISTERS; index++) {
      const bit = index * 6;
      const at = HEADER + (bit >>> 3);
      const word = (stored[at] ?? 0) | ((stored[at + 1] ?? 0) << 8);
      registers[index] = (word >>> (bit & 7)) & 63;
    }
    return registers;
  }
  throw new SketchFormatError("unknown kind");
}

/** Registers encoded: sparse while at most {@link SPARSE_MAX} are set, dense past it. */
export function encodeSketch(registers: Uint8Array): Uint8Array {
  let used = 0;
  for (const rank of registers) if (rank !== 0) used++;
  if (used <= SPARSE_MAX) {
    const out = new Uint8Array(HEADER + used * 3);
    out[0] = MAGIC_0;
    out[1] = MAGIC_1;
    out[2] = SPARSE;
    let at = HEADER;
    for (let index = 0; index < HLL_REGISTERS; index++) {
      const rank = registers[index] ?? 0;
      if (rank === 0) continue;
      const packed = (index << 6) | rank;
      out[at] = packed >>> 16;
      out[at + 1] = (packed >>> 8) & 0xff;
      out[at + 2] = packed & 0xff;
      at += 3;
    }
    return out;
  }
  const out = new Uint8Array(HLL_MAX_BYTES);
  out[0] = MAGIC_0;
  out[1] = MAGIC_1;
  out[2] = DENSE;
  for (let index = 0; index < HLL_REGISTERS; index++) {
    const rank = registers[index] ?? 0;
    if (rank === 0) continue;
    const bit = index * 6;
    const at = HEADER + (bit >>> 3);
    const shifted = rank << (bit & 7);
    out[at] = (out[at] ?? 0) | (shifted & 0xff);
    if (shifted > 0xff) out[at + 1] = (out[at + 1] ?? 0) | (shifted >>> 8);
  }
  return out;
}

/**
 * Adds `elements` to a stored sketch (`undefined` for none yet): the sketch
 * to store, and whether it changed — a register rose, or the sketch did not
 * exist before (Redis's `PFADD` answer).
 */
export function sketchAdd(
  stored: Uint8Array | undefined,
  elements: readonly string[],
): { sketch: Uint8Array; changed: boolean } {
  const fresh = stored === undefined || stored.length === 0;
  const registers = decodeSketch(stored);
  let changed = fresh;
  for (const element of elements) {
    const { index, rank } = place(element);
    if (rank > (registers[index] ?? 0)) {
      registers[index] = rank;
      changed = true;
    }
  }
  return {
    sketch: changed || stored === undefined ? encodeSketch(registers) : stored,
    changed,
  };
}

/** The estimated count of distinct elements in the union of the sketches (missing ones are empty). */
export function sketchCount(
  stored: readonly (Uint8Array | undefined)[],
): number {
  let union: Uint8Array | undefined;
  for (const one of stored) {
    if (one === undefined || one.length === 0) continue;
    const registers = decodeSketch(one);
    if (union === undefined) {
      union = registers;
    } else {
      for (let index = 0; index < HLL_REGISTERS; index++) {
        const rank = registers[index] ?? 0;
        if (rank > (union[index] ?? 0)) union[index] = rank;
      }
    }
  }
  if (union === undefined) return 0;
  let sum = 0;
  let zeros = 0;
  for (const rank of union) {
    sum += INVERSE_POWERS[rank] ?? 0;
    if (rank === 0) zeros++;
  }
  let estimate = (ALPHA * HLL_REGISTERS * HLL_REGISTERS) / sum;
  if (estimate <= 2.5 * HLL_REGISTERS && zeros > 0) {
    estimate = HLL_REGISTERS * Math.log(HLL_REGISTERS / zeros);
  }
  return Math.round(estimate);
}

/**
 * The namespace a SQL or MongoDB driver keeps a namespace's sketches under,
 * beside its entries: `<ns>#d`. A namespace's segments hold only letters,
 * digits, `.`, `_` and `-` (and a built-in `hashNames` hash is hex), so no
 * namespace a cache uses can be this one.
 */
export function sketchNamespace(ns: string): string {
  return `${ns}#d`;
}
