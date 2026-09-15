/**
 * Response compression — a port of the `compression` package (1.8.x) onto
 * {@link BunResponse}, with `zstd` added beside `br`, `gzip` and `deflate`,
 * and opt-in dictionary compression (`dcb`/`dcz`, RFC 9842).
 *
 * `compression()` registers a {@link BunResponseTransform} on each response,
 * so it sees the native `Response` as it is produced — by `send`, `json`,
 * `sendFile`, a static file, or the first `write` — and decides there, as the
 * `compression` package decides when the headers are written:
 *
 * 1. `filter(req, res)` must pass (default {@link shouldCompress}: a
 *    compressible `Content-Type`);
 * 2. `Cache-Control` must not carry `no-transform`;
 * 3. `Vary: Accept-Encoding` is added (plus `Available-Dictionary` when
 *    dictionaries are configured) — from here on, whether or not the body
 *    ends up compressed;
 * 4. a body whose size is known must reach `threshold`; a stream's size is
 *    unknown, so it is compressed;
 * 5. the response must not already have a `Content-Encoding` (other than
 *    `identity`), and the request must not be `HEAD`;
 * 6. `Accept-Encoding` is negotiated, q-values and `*` included, with the
 *    server's `encodings` order breaking ties; `identity` can win.
 *
 * Beyond the package, 204/304 answers, partial content (206, `Content-Range`)
 * and any request carrying `Range` are never compressed, so byte ranges keep
 * referring to the identity body.
 *
 * A compressed response loses `Content-Length`; its `ETag` is left as it is,
 * as the package leaves it.
 */
import type { Transform } from "node:stream";
import type { BrotliOptions, ZlibOptions, ZstdOptions } from "node:zlib";
import type { BunRequest } from "./BunRequest";
import type {
  BunResponse,
  BunResponseTransformBody,
  BunResponseTransformContext,
} from "./BunResponse";
import type { NextFunction } from "./types/general";
import type {
  CompressionDictionaries,
  CompressionDictionaryResolver,
  DictionaryContentEncoding,
} from "./utils/native";
import { Buffer } from "node:buffer";
import * as zlib from "node:zlib";
import {
  appendVary,
  compressionDictionaryHash,
  dictionaryCompressedHeader,
  isArrayBufferView,
  parseAvailableDictionary,
  parseByteSize,
} from "./utils/native";

/* ------------------------------------------------------------------ *
 * Public types
 * ------------------------------------------------------------------ */

/** A content coding `compression()` produces without a dictionary. */
export type CompressionEncoding = "br" | "zstd" | "gzip" | "deflate";

/**
 * An `encodings` list: {@link CompressionEncoding}s in preference order,
 * where a `"*"` entry stands for every supported encoding not listed
 * explicitly, in {@link DEFAULT_COMPRESSION_ENCODINGS} order —
 * `["zstd", "*"]` is zstd first, then the rest. `"*"` alone is every
 * supported encoding. Typed so a misspelt encoding is a compile error.
 */
export type CompressionEncodingsOption =
  | "*"
  | readonly (CompressionEncoding | "*")[];

/**
 * Decides whether a response may be compressed, as the package's `filter`.
 * Called with the response's headers in place (`res.getHeader`), before any
 * other check.
 */
export type CompressionFilter = (req: BunRequest, res: BunResponse) => boolean;

/** The router middleware {@link compression} returns. */
export type CompressionMiddleware = (
  req: BunRequest,
  res: BunResponse,
  next: NextFunction,
) => unknown;

/** Options for {@link compression}. */
export interface CompressionOptions {
  /**
   * Smallest body, in bytes, that is compressed: a number, or a size string
   * such as `"1kb"` (units `b`, `kb`, `mb`, … of 1024). Bodies whose size is
   * unknown (streams) are always compressed. An unparseable value falls back
   * to the default, as in the package. Defaults to `"1kb"` (1024).
   */
  threshold?: number | string;
  /**
   * Whether to consider compressing a response at all; see
   * {@link CompressionFilter}. Defaults to {@link shouldCompress}.
   */
  filter?: CompressionFilter;
  /**
   * zlib compression level for `gzip`/`deflate`, `-1` (zlib's default, 6)
   * to `9`. Defaults to `-1`.
   */
  level?: number;
  /**
   * zlib's output chunk size, in bytes, for the streaming compressors of
   * `gzip`/`deflate`. Defaults to `16384`.
   */
  chunkSize?: number;
  /** zlib `memLevel` for `gzip`/`deflate`, `1` to `9`. Defaults to `8`. */
  memLevel?: number;
  /**
   * zlib `strategy` for `gzip`/`deflate` (`zlib.constants.Z_FILTERED`, …).
   * Defaults to `Z_DEFAULT_STRATEGY`.
   */
  strategy?: number;
  /**
   * zlib `windowBits` for `gzip`/`deflate`, `9` to `15` — Node's meaning;
   * the wrapper follows the encoding. Defaults to `15`.
   */
  windowBits?: number;
  /**
   * Options for `br` (and `dcb`), as `zlib.createBrotliCompress` takes them.
   * `params` is merged over the package's default of
   * `BROTLI_PARAM_QUALITY: 4`, a balanced speed and ratio (brotli's own
   * default, 11, is two orders of magnitude slower).
   */
  brotli?: BrotliOptions;
  /**
   * Options for `zstd` (and `dcz`), as `zlib.createZstdCompress` takes them.
   * With at most `params[ZSTD_c_compressionLevel]` set, buffered bodies use
   * Bun's native zstd; any other parameter goes through `node:zlib`. Defaults
   * to zstd's level 3. RFC 9659 caps the window at 8 MiB, which levels up to
   * 19 respect.
   */
  zstd?: ZstdOptions;
  /**
   * The encodings offered, in the server's order of preference, which breaks
   * ties between equally-weighted codings in `Accept-Encoding`; see
   * {@link CompressionEncodingsOption}. An unknown encoding, or one this
   * runtime lacks, throws. Defaults to {@link DEFAULT_COMPRESSION_ENCODINGS}.
   */
  encodings?: CompressionEncodingsOption;
  /**
   * The encoding used when the request sends no `Accept-Encoding` (or an
   * empty one). `"identity"` leaves such responses uncompressed, as the
   * package does; an encoding not in `encodings` is ignored. Defaults to
   * `"identity"`.
   */
  enforceEncoding?: CompressionEncoding | "identity";
  /**
   * Buffered bodies of at least this many bytes (a number or a size string)
   * are compressed on the thread pool instead of the event loop, and sent
   * without `Content-Length`. Smaller ones are compressed synchronously,
   * which is faster than the hop. `0` always goes off-thread; `Infinity`
   * never does. A `dcb`/`dcz` body goes off-thread whatever its size (unless
   * `Infinity`), as preparing the dictionary dominates. Defaults to
   * {@link DEFAULT_COMPRESSION_ASYNC_THRESHOLD}.
   */
  asyncThreshold?: number | string;
  /**
   * Dictionaries for Compression Dictionary Transport (RFC 9842): when a
   * request's `Available-Dictionary` names one of them by SHA-256 and its
   * `Accept-Encoding` allows `dcb`/`dcz`, the body is compressed against it.
   * The dictionaries themselves (bytes exactly as the client stored them), or
   * a resolver called with the SHA-256 and the coding — the same value
   * `decompressBody` takes. A resolver's answer must hash to what was asked,
   * or the response errors. Advertise a dictionary with a `Use-As-Dictionary`
   * header on the response that serves it ({@link formatUseAsDictionary}).
   * `dcb` is compressed at quality 5 or more, the lowest at which libbrotli
   * uses the dictionary at all. Unset by default: `dcb`/`dcz` are never
   * produced.
   */
  dictionaries?: CompressionDictionaries;
  /**
   * The dictionary codings offered when a dictionary matches, in preference
   * order; they rank ahead of `encodings` on equal q-values. A coding this
   * runtime cannot produce with a dictionary is dropped. Defaults to
   * {@link DEFAULT_DICTIONARY_ENCODINGS}.
   */
  dictionaryEncodings?: readonly DictionaryContentEncoding[];
}

/** Fields of the `Use-As-Dictionary` response header (RFC 9842 §2.1). */
export interface UseAsDictionaryOptions {
  /**
   * The URL pattern (URLPattern syntax, relative to the dictionary's URL) of
   * the requests the dictionary may compress, e.g. `"/js/app.*.js"`. Required.
   */
  match: string;
  /**
   * The request destinations (`Sec-Fetch-Dest` values, e.g. `["script"]`) it
   * applies to. Omitted by default: any destination.
   */
  matchDest?: readonly string[];
  /**
   * An identifier, up to 1024 characters, the client sends back as
   * `Dictionary-ID`. Omitted by default.
   */
  id?: string;
  /** The dictionary format; RFC 9842 defines `"raw"`, the default. Omitted by default. */
  type?: "raw";
}

/* ------------------------------------------------------------------ *
 * Defaults and support
 * ------------------------------------------------------------------ */

/**
 * The default server preference: the package's `br` before `gzip` before
 * `deflate`, with `zstd` after `br`.
 */
export const DEFAULT_COMPRESSION_ENCODINGS: readonly CompressionEncoding[] =
  Object.freeze(["br", "zstd", "gzip", "deflate"]);

/**
 * The default `dictionaryEncodings`: `dcz` before `dcb`. node:zlib prepares
 * the dictionary on every call, which on Bun 1.4.3 costs `dcb` 0.3 ms (8 KiB
 * dictionary) to 3 ms (256 KiB) and `dcz` 5-15 times less; `dcb` is smaller
 * still, but both are a small fraction of plain `br`.
 */
export const DEFAULT_DICTIONARY_ENCODINGS: readonly DictionaryContentEncoding[] =
  Object.freeze(["dcz", "dcb"]);

/** The default `threshold`, in bytes: 1 KiB, as in the package. */
export const DEFAULT_COMPRESSION_THRESHOLD = 1024;

/**
 * The default `asyncThreshold`, in bytes (64 KiB). Measured on Bun 1.4.3: a
 * 64 KiB JSON body blocks the loop for about 0.4 ms (gzip, br) while the
 * thread-pool hop costs a fifth more; a 1 MiB body blocks for about 7 ms.
 */
export const DEFAULT_COMPRESSION_ASYNC_THRESHOLD = 64 * 1024;

/** The encodings this runtime can produce, in default preference order. */
export const SUPPORTED_COMPRESSION_ENCODINGS: readonly CompressionEncoding[] =
  Object.freeze(
    DEFAULT_COMPRESSION_ENCODINGS.filter((encoding) => {
      if (encoding === "br") {
        return typeof zlib.brotliCompressSync === "function";
      }
      if (encoding === "zstd") {
        return typeof Bun.zstdCompressSync === "function";
      }
      return true;
    }),
  );

/** Every name `encodings` and `enforceEncoding` may use. */
const KNOWN_ENCODINGS: ReadonlySet<string> = new Set<CompressionEncoding>([
  "br",
  "zstd",
  "gzip",
  "deflate",
]);

/** `node:zlib` options with the `dictionary` Bun honours but `@types/node` omits. */
interface WithDictionary {
  /** The raw dictionary the stream is compressed against. */
  dictionary?: Uint8Array;
}

/** Whether this runtime compresses `dcb`/`dcz` with a dictionary; probed once. */
let dictionarySupport: Record<DictionaryContentEncoding, boolean> | undefined;

/**
 * Whether `node:zlib` really honours `dictionary` when compressing
 * `encoding`'s format: Bun forwards it to libbrotli and libzstd, but a
 * runtime that ignored it would produce bodies no client can decode. A tiny
 * round trip decides — it must succeed with the dictionary and fail without.
 */
export function dictionaryCompressionSupported(
  encoding: DictionaryContentEncoding,
): boolean {
  dictionarySupport ??= {
    dcb: roundTripsOnlyWithDictionary(
      (input, dictionary) =>
        zlib.brotliCompressSync(input, { dictionary } as BrotliOptions),
      (input, dictionary) =>
        zlib.brotliDecompressSync(input, { dictionary } as BrotliOptions),
    ),
    dcz:
      typeof zlib.zstdCompressSync === "function" &&
      roundTripsOnlyWithDictionary(
        (input, dictionary) =>
          zlib.zstdCompressSync(input, { dictionary } as ZstdOptions),
        (input, dictionary) =>
          zlib.zstdDecompressSync(input, { dictionary } as ZstdOptions),
      ),
  };
  return dictionarySupport[encoding];
}

/** See {@link dictionaryCompressionSupported}. */
function roundTripsOnlyWithDictionary(
  compress: (input: Uint8Array, dictionary: Uint8Array | undefined) => Buffer,
  decompress: (input: Uint8Array, dictionary: Uint8Array | undefined) => Buffer,
): boolean {
  const dictionary = Buffer.from("bun-common dictionary probe, ".repeat(8));
  const input = Buffer.from("bun-common dictionary probe, once more");
  try {
    const packed = compress(input, dictionary);
    if (!decompress(packed, dictionary).equals(input)) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    return !decompress(compress(input, dictionary), undefined).equals(input);
  } catch {
    return true;
  }
}

/* ------------------------------------------------------------------ *
 * Compressible types (the `compressible` package over mime-db 1.52)
 * ------------------------------------------------------------------ */

/** `compressible`'s fallback: any `text/*`, or a `+json`/`+text`/`+xml` suffix. */
const COMPRESSIBLE_TYPE_REGEXP = /^text\/|\+(?:json|text|xml)$/i;

/** `compressible`'s media-type extraction: up to `;` or whitespace. */
const EXTRACT_TYPE_REGEXP = /^\s*([^;\s]*)(?:;|\s|$)/;

/**
 * The mime-db 1.52 types flagged `compressible: true` that the regexp does
 * not already match. No type the regexp matches is flagged `false`, so this
 * set plus the regexp is exactly `compressible`'s answer.
 */
const COMPRESSIBLE_TYPES: ReadonlySet<string> = new Set([
  "application/dart",
  "application/ecmascript",
  "application/javascript",
  "application/json",
  "application/postscript",
  "application/raml+yaml",
  "application/rtf",
  "application/tar",
  "application/toml",
  "application/vnd.dart",
  "application/vnd.ms-fontobject",
  "application/vnd.ms-opentype",
  "application/wasm",
  "application/x-httpd-php",
  "application/x-javascript",
  "application/x-ns-proxy-autoconfig",
  "application/x-sh",
  "application/x-tar",
  "application/x-virtualbox-hdd",
  "application/x-virtualbox-ova",
  "application/x-virtualbox-ovf",
  "application/x-virtualbox-vbox",
  "application/x-virtualbox-vdi",
  "application/x-virtualbox-vhd",
  "application/x-virtualbox-vmdk",
  "application/x-www-form-urlencoded",
  "application/xml",
  "application/xml-dtd",
  "font/otf",
  "font/ttf",
  "image/bmp",
  "image/vnd.adobe.photoshop",
  "image/vnd.microsoft.icon",
  "image/vnd.ms-dds",
  "image/x-icon",
  "image/x-ms-bmp",
  "message/rfc822",
  "model/gltf-binary",
  "x-shader/x-fragment",
  "x-shader/x-vertex",
]);

/**
 * Whether a `Content-Type` is worth compressing, as the `compressible`
 * package answers over mime-db: parameters are ignored and the match is
 * case-insensitive. `null`/`undefined`/`""` are not.
 */
export function isCompressible(type: string | null | undefined): boolean {
  if (!type) {
    return false;
  }
  const mediaType = EXTRACT_TYPE_REGEXP.exec(type)?.[1]?.toLowerCase();
  if (!mediaType) {
    return false;
  }
  return (
    COMPRESSIBLE_TYPES.has(mediaType) ||
    COMPRESSIBLE_TYPE_REGEXP.test(mediaType)
  );
}

/**
 * The default `filter`, the package's `compression.filter`: compress when the
 * response's `Content-Type` is {@link isCompressible}.
 */
export function shouldCompress(_req: BunRequest, res: BunResponse): boolean {
  return isCompressible(res.getHeader("Content-Type"));
}

/* ------------------------------------------------------------------ *
 * Accept-Encoding negotiation (negotiator 0.6.4, with `preferred`)
 * ------------------------------------------------------------------ */

/** One parsed `Accept-Encoding` entry. */
interface AcceptedEncoding {
  /** The coding as written (`gzip`, `*`, `identity`). */
  encoding: string;
  /** Its q-value; `1` when absent, `NaN` when malformed (never acceptable). */
  q: number;
  /** Its position in the header. */
  i: number;
}

/** How well one offered encoding matches the header. */
interface EncodingPriority {
  /** The offered encoding. */
  encoding: string;
  /** The offered encoding's position in the server's list. */
  i: number;
  /** The position of the header entry that matched it (`-1`: none). */
  o: number;
  /** The matched entry's q-value (`0`: none). */
  q: number;
  /** Specificity: `1` for an exact match, `0` for `*`. */
  s: number;
}

/** negotiator's `simpleEncodingRegExp`. */
const SIMPLE_ENCODING_REGEXP = /^\s*([^\s;]+)\s*(?:;(.*))?$/;

/** Parses one `Accept-Encoding` entry, or `null` for an empty one. */
function parseEncoding(value: string, index: number): AcceptedEncoding | null {
  const match = SIMPLE_ENCODING_REGEXP.exec(value);
  if (!match) {
    return null;
  }

  let q = 1;
  if (match[2]) {
    for (const param of match[2].split(";")) {
      const [key, raw] = param.trim().split("=");
      if (key === "q") {
        q = Number.parseFloat(raw);
        break;
      }
    }
  }
  return { encoding: match[1], q, i: index };
}

/**
 * How `spec` matches `encoding`: exactly, through `*`, or not at all. An
 * explicit entry is more specific than `*`, which is how RFC 9110 §12.5.3's
 * "`*` matches any coding not explicitly listed" falls out.
 */
function specify(
  encoding: string,
  spec: AcceptedEncoding,
  index: number,
): EncodingPriority | null {
  let s = 0;
  if (spec.encoding.toLowerCase() === encoding.toLowerCase()) {
    s |= 1;
  } else if (spec.encoding !== "*") {
    return null;
  }
  return { encoding, i: index, o: spec.i, q: spec.q, s };
}

/**
 * Parses `Accept-Encoding`. When no entry covers `identity` (neither named nor
 * `*`), it is added at the lowest q-value present, as negotiator does.
 */
function parseAcceptEncoding(accept: string): AcceptedEncoding[] {
  const parts = accept.split(",");
  const accepted: AcceptedEncoding[] = [];
  let hasIdentity = false;
  let minQuality = 1;

  for (let index = 0; index < parts.length; index++) {
    const spec = parseEncoding(parts[index].trim(), index);
    if (spec) {
      accepted.push(spec);
      hasIdentity ||= specify("identity", spec, 0) !== null;
      minQuality = Math.min(minQuality, spec.q || 1);
    }
  }

  if (!hasIdentity) {
    accepted.push({ encoding: "identity", q: minQuality, i: parts.length });
  }
  return accepted;
}

/**
 * Every acceptable member of `provided`, best first, for an `Accept-Encoding`
 * value — negotiator 0.6.4's `encodings(provided, preferred)`, which
 * `compression` 1.8 calls. Higher q wins; among equal q, members of
 * `preferred` come first in its order, then the rest by specificity and
 * header order. A member matched by nothing, or at `q=0`, is left out.
 *
 * Include `"identity"` in `provided` to let "no coding" win.
 */
export function rankEncodings(
  accept: string | null | undefined,
  provided: readonly string[],
  preferred: readonly string[],
): string[] {
  const accepted = parseAcceptEncoding(accept ?? "");

  const priorities = provided.map((encoding, index) => {
    let priority: EncodingPriority = { encoding, i: index, o: -1, q: 0, s: 0 };
    for (const spec of accepted) {
      const candidate = specify(encoding, spec, index);
      if (
        candidate &&
        (priority.s - candidate.s ||
          priority.q - candidate.q ||
          priority.o - candidate.o) < 0
      ) {
        priority = candidate;
      }
    }
    return priority;
  });

  return priorities
    .filter((priority) => priority.q > 0)
    .sort((a, b) => {
      if (a.q !== b.q) {
        return b.q - a.q;
      }
      const aPreferred = preferred.indexOf(a.encoding);
      const bPreferred = preferred.indexOf(b.encoding);
      if (aPreferred === -1 && bPreferred === -1) {
        return b.s - a.s || a.o - b.o || a.i - b.i;
      }
      if (aPreferred !== -1 && bPreferred !== -1) {
        return aPreferred - bPreferred;
      }
      return aPreferred === -1 ? 1 : -1;
    })
    .map((priority) => priority.encoding);
}

/**
 * Expands an {@link CompressionEncodingsOption} against the encodings
 * `available` (in default order): `"*"` entries become every available
 * encoding not listed explicitly. Throws a `TypeError` naming `option` for an
 * unknown encoding or one not available.
 */
export function resolveEncodingOrder(
  value: CompressionEncodingsOption,
  available: readonly CompressionEncoding[],
  option = "encodings",
): CompressionEncoding[] {
  const entries: readonly string[] = value === "*" ? ["*"] : value;
  if (!Array.isArray(entries)) {
    throw new TypeError(`\`${option}\` must be "*" or an array of encodings`);
  }

  const explicit = new Set<string>();
  for (const entry of entries) {
    if (entry === "*") {
      continue;
    }
    if (!KNOWN_ENCODINGS.has(entry)) {
      throw new TypeError(`\`${option}\`: unknown encoding "${String(entry)}"`);
    }
    if (!available.includes(entry as CompressionEncoding)) {
      throw new TypeError(
        `\`${option}\`: encoding "${entry}" is not available`,
      );
    }
    explicit.add(entry);
  }

  const resolved: CompressionEncoding[] = [];
  for (const entry of entries) {
    const expanded =
      entry === "*"
        ? available.filter((encoding) => !explicit.has(encoding))
        : [entry as CompressionEncoding];
    for (const encoding of expanded) {
      if (!resolved.includes(encoding)) {
        resolved.push(encoding);
      }
    }
  }
  return resolved;
}

/* ------------------------------------------------------------------ *
 * Use-As-Dictionary
 * ------------------------------------------------------------------ */

/** A Structured Field String (RFC 9651 §3.3.3): printable ASCII, quoted. */
function sfString(value: string, field: string): string {
  if (!/^[\x20-\x7E]*$/.test(value)) {
    throw new TypeError(
      `Use-As-Dictionary \`${field}\` must be printable ASCII`,
    );
  }
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * Builds a `Use-As-Dictionary` header value (RFC 9842 §2.1), which tells a
 * client to keep the response it is sent with as a dictionary for later
 * requests matching `match`:
 *
 * ```ts
 * res.setHeader("Use-As-Dictionary", formatUseAsDictionary({ match: "/app.*.js", id: "app-v1" }));
 * // match="/app.*.js", id="app-v1"
 * ```
 *
 * Throws a `TypeError` for a value that is not printable ASCII, or an `id`
 * over 1024 characters.
 */
export function formatUseAsDictionary(options: UseAsDictionaryOptions): string {
  const fields = [`match=${sfString(options.match, "match")}`];
  if (options.matchDest !== undefined) {
    fields.push(
      `match-dest=(${options.matchDest
        .map((dest) => sfString(dest, "matchDest"))
        .join(" ")})`,
    );
  }
  if (options.id !== undefined) {
    if (options.id.length > 1024) {
      throw new TypeError(
        "Use-As-Dictionary `id` is limited to 1024 characters",
      );
    }
    fields.push(`id=${sfString(options.id, "id")}`);
  }
  if (options.type !== undefined) {
    fields.push(`type=${options.type}`);
  }
  return fields.join(", ");
}

/* ------------------------------------------------------------------ *
 * Compressors
 * ------------------------------------------------------------------ */

/** Buffered input every compressor accepts. */
type CompressInput = string | Uint8Array;

/** A `node:zlib` streaming compressor. */
type ZlibStream = Transform & zlib.Zlib;

/** Every coding a response can be given. */
type ProducedEncoding = CompressionEncoding | DictionaryContentEncoding;

/** How one encoding is produced. */
interface Codec {
  /** Compresses a whole body on the calling thread. */
  sync: (input: CompressInput) => Uint8Array;
  /** Compresses a whole body on the thread pool. */
  async: (input: CompressInput) => Promise<Uint8Array>;
  /**
   * Creates a flushable streaming compressor; `undefined` when `node:zlib`
   * has none for the encoding, and `format` is streamed instead.
   */
  stream: (() => ZlibStream) | undefined;
  /** The `CompressionStream` format used when `stream` is `undefined`. */
  format: Bun.CompressionFormat;
  /** The flush kind that emits buffered output without ending the stream. */
  flushKind: number;
  /** Bytes the body starts with: the `dcb`/`dcz` header; `undefined` otherwise. */
  prefix: Uint8Array | undefined;
}

/** Resolves a `node:zlib` callback-style compression as a promise. */
function viaCallback(
  run: (callback: (error: Error | null, result: Buffer) => void) => void,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    run((error, result) => (error ? reject(error) : resolve(result)));
  });
}

/** Copies the entries of `source` whose value is not `undefined`. */
function definedOnly<T extends object>(source: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/** The option objects each family of compressors is built from. */
interface CodecOptions {
  /** `gzip`/`deflate` options for `node:zlib`. */
  zlib: ZlibOptions;
  /** `gzip` options for `Bun.gzipSync`; `undefined` when node:zlib must be used. */
  bunGzip: Bun.ZlibCompressionOptions | undefined;
  /** `br`/`dcb` options, the default quality merged in. */
  brotli: BrotliOptions;
  /** `zstd`/`dcz` options. */
  zstd: ZstdOptions;
  /** `Bun.zstdCompress(Sync)` options, when they can express `zstd`. */
  bunZstd: { level?: number } | undefined;
  /** Whether Bun's native zstd can express the `zstd` options. */
  bunZstdCapable: boolean;
}

/** Normalises the compressor options once per middleware. */
function resolveCodecOptions(options: CompressionOptions): CodecOptions {
  const constants = zlib.constants;
  const zstd: ZstdOptions = { ...options.zstd };
  const zstdParams = zstd.params ?? {};
  const levelKey = constants.ZSTD_c_compressionLevel;
  const zstdLevel = zstdParams[levelKey];

  return {
    zlib: definedOnly({
      level: options.level,
      chunkSize: options.chunkSize,
      memLevel: options.memLevel,
      strategy: options.strategy,
      windowBits: options.windowBits,
    }),
    // Bun.gzipSync (zlib, same bytes as node:zlib) honours `level` alone: on
    // Bun 1.4.3 it silently ignores memLevel and strategy, and its windowBits
    // differs from Node's. Any of those goes through node:zlib instead.
    bunGzip:
      options.memLevel === undefined &&
      options.strategy === undefined &&
      options.windowBits === undefined
        ? (definedOnly({ level: options.level }) as Bun.ZlibCompressionOptions)
        : undefined,
    brotli: {
      ...options.brotli,
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 4,
        ...options.brotli?.params,
      },
    },
    zstd,
    bunZstd: typeof zstdLevel === "number" ? { level: zstdLevel } : undefined,
    bunZstdCapable:
      typeof zlib.zstdCompressSync !== "function" ||
      Object.keys(zstdParams).every((key) => Number(key) === levelKey),
  };
}

/** Builds the compressors for `encoding`; `dictionary` for `dcb`/`dcz`. */
function createCodec(
  encoding: ProducedEncoding,
  options: CodecOptions,
  dictionary?: { bytes: Uint8Array; hash: Uint8Array },
): Codec {
  const constants = zlib.constants;
  switch (encoding) {
    case "gzip": {
      const bunGzip = options.bunGzip;
      return {
        sync: bunGzip
          ? (input) => Bun.gzipSync(input as Uint8Array<ArrayBuffer>, bunGzip)
          : (input) => zlib.gzipSync(input, options.zlib),
        async: (input) =>
          viaCallback((callback) => zlib.gzip(input, options.zlib, callback)),
        stream: () => zlib.createGzip(options.zlib),
        format: "gzip",
        flushKind: constants.Z_SYNC_FLUSH,
        prefix: undefined,
      };
    }
    // HTTP `deflate` is zlib-wrapped (RFC 9110 §8.4.1.2); Bun.deflateSync
    // writes raw DEFLATE whatever windowBits says, so node:zlib it is.
    case "deflate":
      return {
        sync: (input) => zlib.deflateSync(input, options.zlib),
        async: (input) =>
          viaCallback((callback) =>
            zlib.deflate(input, options.zlib, callback),
          ),
        stream: () => zlib.createDeflate(options.zlib),
        format: "deflate",
        flushKind: constants.Z_SYNC_FLUSH,
        prefix: undefined,
      };
    case "br":
    case "dcb": {
      const quality = constants.BROTLI_PARAM_QUALITY;
      const brotli: BrotliOptions & WithDictionary = dictionary
        ? {
            ...options.brotli,
            params: {
              ...options.brotli.params,
              // libbrotli ignores an attached dictionary below quality 5
              // (measured on Bun 1.4.3), so dcb would only add its header.
              [quality]: Math.max(
                5,
                Number(options.brotli.params?.[quality] ?? 4),
              ),
            },
            dictionary: dictionary.bytes,
          }
        : options.brotli;
      return {
        sync: (input) => zlib.brotliCompressSync(input, brotli),
        async: (input) =>
          viaCallback((callback) =>
            zlib.brotliCompress(input, brotli, callback),
          ),
        stream: () => zlib.createBrotliCompress(brotli),
        format: "brotli",
        flushKind: constants.BROTLI_OPERATION_FLUSH,
        prefix:
          dictionary && dictionaryCompressedHeader("dcb", dictionary.hash),
      };
    }
    case "zstd":
    case "dcz": {
      // Cast rather than intersected: some @types/node releases declare
      // `dictionary` on ZstdOptions with a wider type of their own.
      const zstd = (
        dictionary
          ? ({
              ...options.zstd,
              dictionary: dictionary.bytes,
            } satisfies ZstdOptions & WithDictionary)
          : options.zstd
      ) as ZstdOptions;
      // Bun's own zstd is the fastest, but ignores a dictionary.
      const native = !dictionary && options.bunZstdCapable;
      const bunZstd = options.bunZstd;
      return {
        sync: native
          ? (input) => Bun.zstdCompressSync(input, bunZstd)
          : (input) => zlib.zstdCompressSync(input, zstd),
        async: native
          ? (input) => Bun.zstdCompress(input, bunZstd)
          : (input) =>
              viaCallback((callback) =>
                zlib.zstdCompress(input, zstd, callback),
              ),
        stream:
          typeof zlib.createZstdCompress === "function"
            ? () => zlib.createZstdCompress(zstd)
            : undefined,
        format: "zstd",
        flushKind: constants.ZSTD_e_flush,
        prefix:
          dictionary && dictionaryCompressedHeader("dcz", dictionary.hash),
      };
    }
  }
}

/** A buffered body as compressor input, without copying. */
function toInput(
  body: string | ArrayBufferView | ArrayBufferLike,
): CompressInput {
  if (typeof body === "string") {
    return body;
  }
  if (isArrayBufferView(body)) {
    return body instanceof Uint8Array
      ? body
      : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  return new Uint8Array(body);
}

/** `output` with `prefix` in front, when there is one. */
function withPrefix(
  prefix: Uint8Array | undefined,
  output: Uint8Array,
): Uint8Array {
  return prefix ? Buffer.concat([prefix, output]) : output;
}

/**
 * Whether `body` is smaller than `limit` bytes. A string is sized without
 * encoding it when its length decides: UTF-8 takes at least one byte and at
 * most three per UTF-16 code unit.
 */
function isSmallerThan(body: BunResponseTransformBody, limit: number): boolean {
  if (typeof body === "string") {
    if (body.length >= limit) {
      return false;
    }
    if (body.length * 3 < limit) {
      return true;
    }
    return Buffer.byteLength(body) < limit;
  }
  if (body instanceof Blob) {
    return body.size < limit;
  }
  return body.byteLength < limit;
}

/** A stream of one chunk: `pending`'s result, or its error. */
function promisedStream(
  pending: Promise<Uint8Array>,
): ReadableStream<Uint8Array> {
  // A response abandoned before it is read must not surface as unhandled.
  pending.catch(() => undefined);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        controller.enqueue(await pending);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

/** Runs a controller call that throws once the consumer has gone. */
function quietly(run: () => void): void {
  try {
    run();
  } catch {
    // The consumer cancelled; nothing is waiting for this.
  }
}

/**
 * Compresses `source` through a `node:zlib` stream, reading it as the output
 * is consumed and starting with `prefix`. With `flushEachChunk`, every chunk
 * is flushed as it is written (server-sent events); `flush()` flushes on
 * demand (`res.flush()`).
 */
function zlibReadable(
  source: ReadableStream<Uint8Array>,
  engine: ZlibStream,
  codec: Codec,
  flushEachChunk: boolean,
): { readable: ReadableStream<Uint8Array>; flush: () => void } {
  const reader = source.getReader();
  let closing = false;
  // Enqueued by the first `pull`, not `start`: on Bun 1.4.3 a chunk enqueued
  // in `start` leaves `pull` never called, and the stream hangs.
  let prefix = codec.prefix;
  let settle: (() => void) | undefined;
  const ended = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      engine.on("data", (chunk: Buffer) => {
        quietly(() => controller.enqueue(chunk));
      });
      engine.once("end", () => {
        quietly(() => controller.close());
        settle?.();
      });
      engine.once("error", (error: Error) => {
        quietly(() => controller.error(error));
        reader.cancel(error).catch(() => undefined);
        settle?.();
      });
    },
    async pull(controller) {
      if (prefix) {
        controller.enqueue(prefix);
        prefix = undefined;
      }
      if (closing) {
        await ended;
        return;
      }
      const { done, value } = await reader.read();
      if (done) {
        closing = true;
        engine.end();
        await ended;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        engine.write(value, (error) => (error ? reject(error) : resolve()));
      });
      if (flushEachChunk) {
        await new Promise<void>((resolve) => {
          engine.flush(codec.flushKind, resolve);
        });
      }
    },
    async cancel(reason) {
      closing = true;
      engine.destroy();
      settle?.();
      await reader.cancel(reason);
    },
  });

  return {
    readable,
    flush: () => {
      if (!closing) {
        engine.flush(codec.flushKind);
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * The middleware
 * ------------------------------------------------------------------ */

/**
 * `Cache-Control: no-transform` (RFC 9111 §5.2.2.6). The package's pattern,
 * matched case-insensitively as cache directives are.
 */
const NO_TRANSFORM_REGEXP = /(?:^|,)\s*no-transform\s*(?:,|$)/i;

/** A `text/event-stream` response, flushed after every chunk. */
const EVENT_STREAM_REGEXP = /^\s*text\/event-stream\s*(?:;|$)/i;

/** Everything a `compression()` instance resolves once. */
interface CompressionConfig {
  /** See {@link CompressionOptions.filter}. */
  filter: CompressionFilter;
  /** See {@link CompressionOptions.threshold}, in bytes. */
  threshold: number;
  /** See {@link CompressionOptions.asyncThreshold}, in bytes. */
  asyncThreshold: number;
  /** The offered encodings, in preference order. */
  encodings: readonly CompressionEncoding[];
  /** The offered encodings followed by `identity`, for negotiation. */
  provided: readonly string[];
  /** The resolved `enforceEncoding`, or `undefined` when ignored. */
  enforce: CompressionEncoding | "identity" | undefined;
  /** The compressor options. */
  codecOptions: CodecOptions;
  /** The dictionary-less compressors, built on first use. */
  codecs: Map<CompressionEncoding, Codec>;
  /** See {@link CompressionOptions.dictionaries}; `undefined` when unset. */
  dictionaries: DictionaryLookup | undefined;
  /** The `Vary` fields this instance adds. */
  vary: readonly string[];
}

/** Resolved dictionary configuration. */
interface DictionaryLookup {
  /** The dictionary codings offered, supported ones only, in order. */
  encodings: readonly DictionaryContentEncoding[];
  /** An array's dictionaries by lower-case hex SHA-256. */
  index: Map<string, Uint8Array> | undefined;
  /** A resolver, when one was given. */
  resolver: CompressionDictionaryResolver | undefined;
  /** Compressors per dictionary, built on first use. */
  codecs: WeakMap<Uint8Array, Map<DictionaryContentEncoding, Codec>>;
  /** Resolver answers already verified against their hash. */
  verified: WeakMap<Uint8Array, string>;
}

/** Parses a byte-size option, answering `fallback` for anything unusable. */
function byteOption(
  value: number | string | undefined,
  fallback: number,
): number {
  if (value === Infinity) {
    return Infinity;
  }
  return value === undefined ? fallback : (parseByteSize(value) ?? fallback);
}

/** Resolves {@link CompressionOptions} into a {@link CompressionConfig}. */
function resolveConfig(options: CompressionOptions): CompressionConfig {
  const encodings = resolveEncodingOrder(
    options.encodings ?? "*",
    SUPPORTED_COMPRESSION_ENCODINGS,
  );
  const enforceEncoding = options.enforceEncoding ?? "identity";

  let dictionaries: DictionaryLookup | undefined;
  if (options.dictionaries !== undefined) {
    const source = options.dictionaries;
    let index: Map<string, Uint8Array> | undefined;
    if (typeof source !== "function") {
      index = new Map();
      for (const dictionary of source) {
        index.set(
          compressionDictionaryHash(dictionary).toString("hex"),
          dictionary,
        );
      }
    }
    dictionaries = {
      encodings: (
        options.dictionaryEncodings ?? DEFAULT_DICTIONARY_ENCODINGS
      ).filter(
        (encoding, position, list) =>
          list.indexOf(encoding) === position &&
          dictionaryCompressionSupported(encoding),
      ),
      index,
      resolver: typeof source === "function" ? source : undefined,
      codecs: new WeakMap(),
      verified: new WeakMap(),
    };
  }

  return {
    filter: options.filter ?? shouldCompress,
    threshold: byteOption(options.threshold, DEFAULT_COMPRESSION_THRESHOLD),
    asyncThreshold: byteOption(
      options.asyncThreshold,
      DEFAULT_COMPRESSION_ASYNC_THRESHOLD,
    ),
    encodings,
    provided: [...encodings, "identity"],
    enforce:
      enforceEncoding === "identity" ||
      encodings.includes(enforceEncoding as CompressionEncoding)
        ? enforceEncoding
        : undefined,
    codecOptions: resolveCodecOptions(options),
    codecs: new Map(),
    dictionaries,
    vary:
      dictionaries === undefined
        ? ["Accept-Encoding"]
        : ["Accept-Encoding", "Available-Dictionary"],
  };
}

/** The dictionaries a request's `Available-Dictionary` names, per coding. */
function findDictionaries(
  lookup: DictionaryLookup,
  req: BunRequest,
): Map<DictionaryContentEncoding, Uint8Array> | undefined {
  if (lookup.encodings.length === 0) {
    return undefined;
  }
  const hash = parseAvailableDictionary(req.getHeader("Available-Dictionary"));
  if (!hash) {
    return undefined;
  }
  const hex = hash.toString("hex");
  const found = new Map<DictionaryContentEncoding, Uint8Array>();

  for (const encoding of lookup.encodings) {
    let dictionary: Uint8Array | undefined;
    if (lookup.index) {
      dictionary = lookup.index.get(hex);
    } else if (lookup.resolver) {
      dictionary = lookup.resolver(Buffer.from(hash), encoding);
      if (dictionary !== undefined && lookup.verified.get(dictionary) !== hex) {
        if (compressionDictionaryHash(dictionary).toString("hex") !== hex) {
          throw new Error(
            `The "${encoding}" dictionary resolver answered a dictionary whose SHA-256 is not ${hex}`,
          );
        }
        lookup.verified.set(dictionary, hex);
      }
    }
    if (dictionary !== undefined) {
      found.set(encoding, dictionary);
    }
  }
  return found.size > 0 ? found : undefined;
}

/** The compressor for a chosen coding, built once and reused. */
function codecFor(
  config: CompressionConfig,
  encoding: ProducedEncoding,
  dictionary: Uint8Array | undefined,
): Codec {
  if (encoding === "dcb" || encoding === "dcz") {
    const lookup = config.dictionaries as DictionaryLookup;
    const bytes = dictionary as Uint8Array;
    let perDictionary = lookup.codecs.get(bytes);
    if (!perDictionary) {
      perDictionary = new Map();
      lookup.codecs.set(bytes, perDictionary);
    }
    let codec = perDictionary.get(encoding);
    if (!codec) {
      codec = createCodec(encoding, config.codecOptions, {
        bytes,
        hash: compressionDictionaryHash(bytes),
      });
      perDictionary.set(encoding, codec);
    }
    return codec;
  }

  let codec = config.codecs.get(encoding);
  if (!codec) {
    codec = createCodec(encoding, config.codecOptions);
    config.codecs.set(encoding, codec);
  }
  return codec;
}

/** `response` with `fields` added to its `Vary`. */
function withVary(response: Response, fields: readonly string[]): Response {
  const vary = appendVary(response.headers.get("Vary") ?? "", [...fields]);
  try {
    response.headers.set("Vary", vary);
    return response;
  } catch {
    // Immutable headers (a `Response.redirect`, a fetched response).
    const headers = new Headers(response.headers);
    headers.set("Vary", vary);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/** What {@link chooseEncoding} decided for one response. */
interface EncodingChoice {
  /** Whether `Vary` is due — compression was considered. */
  varied: boolean;
  /** The coding to apply; `undefined` to send the body as it is. */
  encoding?: ProducedEncoding;
  /** The dictionary for `dcb`/`dcz`. */
  dictionary?: Uint8Array;
}

/** Decides whether, and how, to compress `response`. */
function chooseEncoding(
  config: CompressionConfig,
  req: BunRequest,
  response: Response,
  context: BunResponseTransformContext,
): EncodingChoice {
  const { res, body } = context;
  const headers = response.headers;

  // The filter reads `res`; a Content-Type only the native response knows
  // (a Blob's own type) is brought across first.
  if (!res.hasHeader("Content-Type")) {
    const type =
      headers.get("Content-Type") ??
      (body instanceof Blob && body.type ? body.type : null);
    if (type) {
      res.setHeader("Content-Type", type);
    }
  }

  if (!config.filter(req, res)) {
    return { varied: false };
  }
  if (NO_TRANSFORM_REGEXP.test(headers.get("Cache-Control") ?? "")) {
    return { varied: false };
  }

  const length = headers.get("Content-Length");
  if (
    (length !== null && Number(length) < config.threshold) ||
    (body !== undefined && isSmallerThan(body, config.threshold))
  ) {
    return { varied: true };
  }

  const current = headers.get("Content-Encoding") || "identity";
  if (current !== "identity" || req.method === "HEAD") {
    return { varied: true };
  }

  const status = response.status;
  if (
    status === 204 ||
    status === 304 ||
    status === 206 ||
    headers.has("Content-Range") ||
    req.getHeader("Range") !== null
  ) {
    return { varied: true };
  }

  const accept = req.getHeader("Accept-Encoding");
  if (!accept) {
    const enforced = config.enforce;
    return enforced === undefined || enforced === "identity"
      ? { varied: true }
      : { varied: true, encoding: enforced };
  }

  const dictionaries = config.dictionaries
    ? findDictionaries(config.dictionaries, req)
    : undefined;
  let provided = config.provided;
  let preferred: readonly string[] = config.encodings;
  if (dictionaries) {
    const offered = [...dictionaries.keys()];
    provided = [...offered, ...config.provided];
    preferred = [...offered, ...config.encodings];
  }

  const method = rankEncodings(accept, provided, preferred)[0];
  if (method === undefined || method === "identity") {
    return { varied: true };
  }
  return {
    varied: true,
    encoding: method as ProducedEncoding,
    dictionary: dictionaries?.get(method as DictionaryContentEncoding),
  };
}

/** Applies the middleware's decision to one produced `Response`. */
function transformResponse(
  config: CompressionConfig,
  req: BunRequest,
  response: Response,
  context: BunResponseTransformContext,
  onStream: (flush: () => void) => void,
): Response {
  const { varied, encoding, dictionary } = chooseEncoding(
    config,
    req,
    response,
    context,
  );
  if (!varied) {
    return response;
  }

  const { res, body } = context;
  res.vary([...config.vary]);
  if (encoding === undefined) {
    return withVary(response, config.vary);
  }

  const codec = codecFor(config, encoding, dictionary);
  let compressed: Bun.BodyInit;
  if (body !== undefined && !(body instanceof Blob)) {
    const input = toInput(body);
    // Preparing a dictionary costs the same whatever the body's size, so a
    // dictionary coding goes off-thread unless asyncThreshold is Infinity.
    const onLoop =
      dictionary === undefined
        ? isSmallerThan(body, config.asyncThreshold)
        : config.asyncThreshold === Infinity;
    compressed = onLoop
      ? withPrefix(codec.prefix, codec.sync(input))
      : promisedStream(
          codec.async(input).then((output) => withPrefix(codec.prefix, output)),
        );
  } else {
    const source = body instanceof Blob ? body.stream() : response.body;
    if (source === null) {
      return withVary(response, config.vary);
    }
    if (codec.stream) {
      const piped = zlibReadable(
        source,
        codec.stream(),
        codec,
        EVENT_STREAM_REGEXP.test(res.getHeader("Content-Type") ?? ""),
      );
      onStream(piped.flush);
      compressed = piped.readable;
    } else {
      compressed = source.pipeThrough(new CompressionStream(codec.format));
    }
  }

  const headers = new Headers(response.headers);
  const contentType = res.getHeader("Content-Type");
  if (contentType && !headers.has("Content-Type")) {
    headers.set("Content-Type", contentType);
  }
  headers.set("Content-Encoding", encoding);
  headers.delete("Content-Length");
  headers.set("Vary", appendVary(headers.get("Vary") ?? "", [...config.vary]));

  res.setHeader("Content-Encoding", encoding);
  res.removeHeader("Content-Length");

  return new Response(compressed, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Compresses responses, with the options and semantics of the `compression`
 * package (1.8.x) — see this module's overview and
 * {@link CompressionOptions}. Register it ahead of the routes it covers:
 *
 * ```ts
 * router.use(compression());
 * adapter.use(compression({ threshold: "2kb", encodings: ["zstd", "*"] }));
 * app.use(compression()); // NestJS, on the bun-nest adapter
 * ```
 *
 * A streamed response is compressed as it is written; `text/event-stream`
 * is flushed after every chunk, and `res.flush()` flushes on demand.
 *
 * Throws a `TypeError` for an unknown or unavailable entry in `encodings`.
 */
export function compression(
  options: CompressionOptions = {},
): CompressionMiddleware {
  const config = resolveConfig(options);

  return function compressionMiddleware(
    req: BunRequest,
    res: BunResponse,
    next: NextFunction,
  ) {
    let flushStream: (() => void) | undefined;
    res.addResponseTransform({
      transform: (response, context) =>
        transformResponse(config, req, response, context, (flush) => {
          flushStream = flush;
        }),
      flush: () => flushStream?.(),
    });
    return next();
  };
}
