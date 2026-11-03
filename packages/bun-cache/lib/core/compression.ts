/**
 * Entry compression (plan §3.11; the encryption plan's §8): the built-in
 * algorithms — zstd, gzip, Brotli and raw DEFLATE — and user compressors,
 * resolved once at `createCache` into the shape the core calls.
 *
 * The built-ins stay synchronous: their async forms cost more per operation
 * and buy only an unblocked loop, which a cache entry capped at 4 MiB does not
 * need (the plan's §8.1). A user compressor may return a promise; the core
 * awaits only then.
 *
 * Nothing here is shared with bun-common's response compression but the
 * algorithm names, typed from its `CompressionEncoding`: its codecs are
 * HTTP-shaped (streams, zlib-wrapped deflate, dictionaries), and a cache
 * entry is one buffer whose bytes never reach HTTP (the plan's §8.5).
 */
import type { CompressionEncoding } from "@kingsleyweb/bun-common";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { decompressBounded, outputLimit, overLimit } from "./decompress";
import { COMPRESSOR_IDS } from "./header";
import type { CacheCompressor, CompressOptions } from "./types";

/** The ids a user compressor may take (0–127 are the package's). */
export const CUSTOM_COMPRESSOR_RANGE = { min: 128, max: 255 } as const;

/** A built-in algorithm's level: its default and the range `createCache` accepts. */
interface LevelRange {
  /** The level used when `compress.level` is unset. */
  default: number;
  /** The lowest accepted level. */
  min: number;
  /** The highest accepted level. */
  max: number;
}

/**
 * Each built-in algorithm's levels (the plan's §8.2). A `Record` over
 * bun-common's `CompressionEncoding`, so an encoding bun-common adds fails to
 * compile here until it is handled.
 */
const LEVELS: Readonly<Record<CompressionEncoding, LevelRange>> = {
  // zstd's own default; the byte output is what an unset level gave before.
  zstd: { default: 3, min: 1, max: 22 },
  // zlib's own default (6), likewise.
  gzip: { default: 6, min: 0, max: 9 },
  // bun-common's response compression uses quality 4 too
  // (lib/compression.ts, its `brotli` default; no constant is exported):
  // Brotli's own default, 11, took 90 ms for 70 KB against 0.64 ms at 4, for
  // at most 1.4× the ratio (the plan's §8.1).
  br: { default: 4, min: 0, max: 11 },
  deflate: { default: 6, min: 0, max: 9 },
};

/** How this cache compresses the entries it writes. */
export interface ResolvedCompression {
  /** The compressor id written into the entry header (see `COMPRESSOR_IDS`; 128–255 a user compressor). */
  id: number;
  /** Compress at or above this many encoded bytes. */
  threshold: number;
  /**
   * Compresses a payload. A user compressor's may answer a promise; the
   * built-ins never do, and answer the payload itself, unchanged, when their
   * probe says compressing it would not pay ({@link probeSays}): the core
   * then stores it uncompressed, as it stores any output that is not smaller.
   */
  compress: (
    bytes: Uint8Array<ArrayBuffer>,
  ) => Uint8Array | PromiseLike<Uint8Array>;
  /** Whether `compress` must be handed a copy of the payload: a user compressor may keep or change it; a built-in reads it and lets go. */
  copiesInput: boolean;
}

/** The resolved `compress` option. */
export interface ResolvedCompress {
  /** How new entries are compressed; `undefined` when `compress: false`. */
  write: ResolvedCompression | undefined;
  /** The user compressors that decompress, by id: `algorithm`'s and `previous`'s. */
  user: ReadonlyMap<number, CacheCompressor>;
}

/** Whether `value` is a promise (or any thenable), which the core then awaits. */
export function isPromiseLike<T>(
  value: T | PromiseLike<T>,
): value is PromiseLike<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Throws a `TypeError` unless `compressor` is a well-formed user compressor. */
function checkCompressor(compressor: CacheCompressor, where: string): void {
  if (
    !Number.isInteger(compressor.id) ||
    compressor.id < CUSTOM_COMPRESSOR_RANGE.min ||
    compressor.id > CUSTOM_COMPRESSOR_RANGE.max
  ) {
    throw new TypeError(
      `${where}: a user compressor's id must be an integer in ${CUSTOM_COMPRESSOR_RANGE.min}–${CUSTOM_COMPRESSOR_RANGE.max} (0–127 are reserved), not ${String(
        compressor.id,
      )}`,
    );
  }
  if (
    typeof compressor.compress !== "function" ||
    typeof compressor.decompress !== "function"
  ) {
    throw new TypeError(
      `${where}: a user compressor needs compress and decompress functions`,
    );
  }
}

/** A payload at least this large is probed before a built-in algorithm compresses it whole. */
export const PROBE_FROM_BYTES = 256 * 1024;

/** How many slices a probe takes, spread over the payload: its start, its end and between. */
const PROBE_SLICES = 4;

/** A probe slice's length: 1/256 of the payload (so a probe reads 1/64 of it), at most 4 KiB. */
const PROBE_SLICE_MAX = 4096;

/** A probe says "compress" when its sample shrinks below this fraction of its size: by at least 2%. */
const PROBE_KEEP_RATIO = 0.98;

/**
 * Whether compressing `bytes` whole is worth trying, by compressing a sample
 * of it: {@link PROBE_SLICES} slices, evenly spread, each 1/256 of the
 * payload and at most 4 KiB, so the probe costs about 1/64 of the whole and
 * never more than 16 KiB of work. Data that will not shrink — random bytes,
 * a JPEG, something compressed already — is then stored as it is, rather
 * than compressed whole only to be thrown away by the "only if smaller"
 * rule (§3.11): 1 MiB of random bytes cost zstd 319 µs for nothing
 * (measured, 2026-11-02). The judgment is the sample's: a payload whose
 * sample does not shrink by 2% is stored uncompressed even if a part the
 * sample missed would have.
 */
export function probeSays(
  compress: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array,
  bytes: Uint8Array<ArrayBuffer>,
): boolean {
  const slice = Math.min(PROBE_SLICE_MAX, Math.floor(bytes.byteLength / 256));
  const sample = new Uint8Array(slice * PROBE_SLICES);
  const step = (bytes.byteLength - slice) / (PROBE_SLICES - 1);
  for (let index = 0; index < PROBE_SLICES; index++) {
    const start = Math.floor(step * index);
    sample.set(bytes.subarray(start, start + slice), index * slice);
  }
  return compress(sample).byteLength < sample.byteLength * PROBE_KEEP_RATIO;
}

/**
 * A built-in algorithm's compress function, probing a payload of at least
 * {@link PROBE_FROM_BYTES} first: one the probe judges will not shrink comes
 * back as it was given, which the core stores uncompressed.
 */
function probing(
  compress: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array,
): (bytes: Uint8Array<ArrayBuffer>) => Uint8Array {
  return (bytes) =>
    bytes.byteLength >= PROBE_FROM_BYTES && !probeSays(compress, bytes)
      ? bytes
      : compress(bytes);
}

/** The synchronous compress function of a built-in algorithm at `level`. */
function builtInCompress(
  algorithm: CompressionEncoding,
  level: number,
): (bytes: Uint8Array<ArrayBuffer>) => Uint8Array {
  switch (algorithm) {
    case "zstd":
      return (bytes) => Bun.zstdCompressSync(bytes, { level });
    case "gzip":
      return (bytes) =>
        Bun.gzipSync(bytes, {
          level: level as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9,
        });
    case "br":
      return (bytes) =>
        brotliCompressSync(bytes, {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: level },
        });
    case "deflate":
      // Raw DEFLATE (RFC 1951): Bun.deflateSync writes no zlib wrapper.
      return (bytes) =>
        Bun.deflateSync(bytes, {
          level: level as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9,
        });
    default: {
      const unhandled: never = algorithm;
      throw new TypeError(
        `compress.algorithm "${String(unhandled)}" is not supported`,
      );
    }
  }
}

/**
 * Resolves `createCache`'s `compress` option, or throws a `TypeError` naming
 * what is wrong: an unknown algorithm, a level outside its range (or beside a
 * user compressor), a user compressor's id outside 128–255, or a duplicate id
 * among `algorithm` and `previous`.
 */
export function resolveCompress(
  option: false | CompressOptions | undefined,
  defaultThreshold: number,
): ResolvedCompress {
  if (option === false) {
    return { write: undefined, user: new Map() };
  }
  const algorithm = option?.algorithm ?? "zstd";
  const threshold = option?.threshold ?? defaultThreshold;
  const user = new Map<number, CacheCompressor>();
  let write: ResolvedCompression;
  if (typeof algorithm === "object") {
    checkCompressor(algorithm, "compress.algorithm");
    if (option?.level !== undefined) {
      throw new TypeError(
        "compress.level applies to the built-in algorithms, not to a user compressor",
      );
    }
    user.set(algorithm.id, algorithm);
    write = {
      id: algorithm.id,
      threshold,
      compress: (bytes) => algorithm.compress(bytes),
      copiesInput: true,
    };
  } else {
    const range = LEVELS[algorithm] as LevelRange | undefined;
    if (range === undefined) {
      throw new TypeError(
        `compress.algorithm must be "zstd", "gzip", "br", "deflate" or a user compressor, not ${JSON.stringify(
          algorithm,
        )}`,
      );
    }
    const level = option?.level ?? range.default;
    if (!Number.isInteger(level) || level < range.min || level > range.max) {
      throw new TypeError(
        `compress.level for "${algorithm}" must be an integer in ${range.min}–${range.max}, not ${String(
          level,
        )}`,
      );
    }
    write = {
      id: COMPRESSOR_IDS[algorithm],
      threshold,
      compress: probing(builtInCompress(algorithm, level)),
      copiesInput: false,
    };
  }
  for (const [index, previous] of (option?.previous ?? []).entries()) {
    const where = `compress.previous[${index}]`;
    checkCompressor(previous, where);
    if (user.has(previous.id)) {
      throw new TypeError(
        `${where}: compressor id ${previous.id} is already taken by another compressor`,
      );
    }
    user.set(previous.id, previous);
  }
  return { write, user };
}

/** Checks a user compressor's output: a `Uint8Array`, at most `cap` bytes. */
function checkDecompressed(output: unknown, cap: number): Uint8Array {
  if (!(output instanceof Uint8Array)) {
    throw new TypeError(
      "a user compressor's decompress must answer a Uint8Array",
    );
  }
  if (Number.isFinite(cap) && output.byteLength > cap) {
    throw overLimit(cap);
  }
  return output;
}

/**
 * Decompresses a stored payload by its header's compressor id, never past
 * `cap` bytes (the entry limit). The built-ins go through
 * `decompressBounded` (`decompress.ts`), which stops their decoders at the
 * cap; a user compressor is handed it as `maxOutputLength`, and its answer is
 * refused past it anyway. Throws on an unknown id — a miss, as an unknown
 * codec id is.
 */
export function decompressEntry(
  compressor: number,
  payload: Uint8Array,
  cap: number,
  user: ReadonlyMap<number, CacheCompressor>,
): Uint8Array | PromiseLike<Uint8Array> {
  if (compressor < CUSTOM_COMPRESSOR_RANGE.min) {
    return decompressBounded(compressor, payload, cap);
  }
  const custom = user.get(compressor);
  if (custom === undefined) {
    throw new Error(
      `the entry's compressor id ${compressor} is not known to this cache (a user compressor missing from compress.previous?)`,
    );
  }
  // A copy: the compressor may keep or change what it is given.
  const output = custom.decompress(payload.slice(), outputLimit(cap));
  return isPromiseLike(output)
    ? Promise.resolve(output).then((bytes) => checkDecompressed(bytes, cap))
    : checkDecompressed(output, cap);
}
