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
  /** Compresses a payload (a copy the compressor may keep). A user compressor's may answer a promise; the built-ins never do. */
  compress: (
    bytes: Uint8Array<ArrayBuffer>,
  ) => Uint8Array | PromiseLike<Uint8Array>;
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
      compress: builtInCompress(algorithm, level),
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
