/**
 * Compile-time assertions for `compression()`, its options, the response
 * transform hook, and the static-file `precompressed`/`compression` options.
 *
 * - Every option is accepted with its documented type; a misspelt encoding in
 *   `encodings`, `enforceEncoding`, `dictionaryEncodings` or a precompressed
 *   extension map is a compile error, while `"*"` stays allowed.
 * - The middleware is a `RouterMiddlewareHandler`, so `router.use`,
 *   `adapter.use` and bun-nest's `app.use` accept it.
 *
 * Runtime behaviour lives in `compression.test.ts` and `serveStatic.test.ts`.
 */
import type { BunRequest } from "../lib/BunRequest";
import type {
  BunResponse,
  BunResponseTransform,
  BunResponseTransformContext,
} from "../lib/BunResponse";
import type {
  CompressionEncoding,
  CompressionEncodingsOption,
  CompressionMiddleware,
  CompressionOptions,
} from "../lib/compression";
import type {
  RouterMiddlewareHandler,
  ServeStaticOptions,
} from "../lib/types/general";
import * as zlib from "node:zlib";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import { compression, rankEncodings } from "../lib/compression";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

/* --- the middleware -------------------------------------------------- */

const _default = compression();
type _defaultIsMiddleware = Expect<
  Equal<typeof _default, CompressionMiddleware>
>;
const _asHandler: RouterMiddlewareHandler = compression();

new BunRouter().use(compression());
new BunRouter().use("/api", compression({ threshold: "2kb" }));
new BunHttpAdapter().use(compression({ encodings: ["zstd", "*"] }));

/* --- every option ---------------------------------------------------- */

const _every: CompressionOptions = {
  threshold: 1024,
  filter: (req, res) => {
    type _req = Expect<Equal<typeof req, BunRequest>>;
    type _res = Expect<Equal<typeof res, BunResponse>>;
    return res.getHeader("Content-Type") !== null;
  },
  level: 6,
  chunkSize: 16 * 1024,
  memLevel: 8,
  strategy: zlib.constants.Z_DEFAULT_STRATEGY,
  windowBits: 15,
  brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } },
  zstd: { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } },
  encodings: ["br", "zstd", "gzip", "deflate"],
  enforceEncoding: "gzip",
  asyncThreshold: "64kb",
  dictionaries: [new Uint8Array(8)],
  dictionaryEncodings: ["dcz", "dcb"],
};
const _sizes: CompressionOptions = { threshold: "1kb", asyncThreshold: 0 };
const _identity: CompressionOptions = { enforceEncoding: "identity" };
const _resolver: CompressionOptions = {
  dictionaries: (hash, _coding) => {
    type _codingIsDictionaryCoding = Expect<
      Equal<typeof _coding, "dcb" | "dcz">
    >;
    return hash.length === 32 ? new Uint8Array(1) : undefined;
  },
};

/* --- encodings: literals and wildcards ------------------------------- */

const _star: CompressionOptions = { encodings: "*" };
const _starList: CompressionOptions = { encodings: ["*"] };
const _trailing: CompressionOptions = { encodings: ["zstd", "*"] };
const _middle: CompressionEncodingsOption = ["gzip", "*", "br"];
const _empty: CompressionOptions = { encodings: [] };
const _readonly = ["br", "gzip"] as const;
const _fromConst: CompressionOptions = { encodings: _readonly };

// @ts-expect-error a misspelt encoding
const _typo: CompressionOptions = { encodings: ["gzp"] };
// @ts-expect-error a bare encoding is not the list form; only "*" is
const _bare: CompressionOptions = { encodings: "gzip" };
// @ts-expect-error dcb/dcz go in dictionaryEncodings
const _dictionaryInEncodings: CompressionOptions = { encodings: ["dcb"] };
// @ts-expect-error enforceEncoding takes an encoding or "identity"
const _enforce: CompressionOptions = { enforceEncoding: "*" };
const _dictionaryEncodings: CompressionOptions = {
  // @ts-expect-error dictionaryEncodings takes dcb/dcz only
  dictionaryEncodings: ["br"],
};
// @ts-expect-error a filter answers a boolean
const _filter: CompressionOptions = { filter: () => "yes" };
// @ts-expect-error threshold is bytes or a size string
const _threshold: CompressionOptions = { threshold: true };

const _encoding: CompressionEncoding = "zstd";
const _ranked: string[] = rankEncodings("gzip", ["gzip", "identity"], ["gzip"]);

/* --- the response hook ----------------------------------------------- */

const _transform: BunResponseTransform = {
  transform: (response, _context) => {
    type _contextIsTyped = Expect<
      Equal<typeof _context, BunResponseTransformContext>
    >;
    return response;
  },
  flush: () => undefined,
};
function _register(res: BunResponse): void {
  const _chained: BunResponse = res.addResponseTransform(_transform);
  const _flushed: void = res.flush();
}

/* --- static files ---------------------------------------------------- */

const _precompressedOn: ServeStaticOptions = { precompressed: true };
const _precompressedFull: ServeStaticOptions = {
  precompressed: {
    enabled: true,
    extensions: { br: ".br", gzip: [".gz", ".gzip"], zstd: [] },
    encodings: ["gzip", "*"],
    fallback: "identity",
  },
  compression: { threshold: "2kb", encodings: ["gzip"] },
};
const _onTheFlyOff: ServeStaticOptions = { compression: false };

const _unknownSibling: ServeStaticOptions = {
  // @ts-expect-error an unknown coding in the extension map
  precompressed: { extensions: { lzma: [".xz"] } },
};
const _fallback: ServeStaticOptions = {
  // @ts-expect-error fallback is "compress" or "identity"
  precompressed: { fallback: "gzip" },
};
