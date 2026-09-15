/**
 * Option tour: every `CompressionOptions` field of `compression()`, the
 * helpers beside it and `res.flush()`, each asserted.
 *
 * ```bash
 * bun 12-options/compression-options.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - Each check builds a router with `compression(options)` in front of a JSON
 *   route and reads it with `router.fetch()`, which resolves the bytes exactly
 *   as sent — so every compressed body is decoded here with `node:zlib`.
 * - `Vary: Accept-Encoding` is set whenever compression was considered: past
 *   the filter and `no-transform`, even when the body is then too small.
 * - `"*"` in `encodings` means every supported encoding not listed
 *   explicitly; in `Accept-Encoding` it means every coding the client did not
 *   name (RFC 9110 §12.5.3).
 * - `res.flush()` needs a socket to observe, so that section binds port 0.
 */
import type { CompressionOptions } from "@kingsleyweb/bun-common";
import { Buffer } from "node:buffer";
import {
  brotliDecompressSync,
  constants,
  createGunzip,
  gunzipSync,
  inflateSync,
  zstdDecompressSync,
} from "node:zlib";
import {
  BunHttpAdapter,
  BunRouter,
  compression,
  compressionDictionaryHash,
  DEFAULT_COMPRESSION_ASYNC_THRESHOLD,
  DEFAULT_COMPRESSION_ENCODINGS,
  DEFAULT_COMPRESSION_THRESHOLD,
  DEFAULT_DICTIONARY_ENCODINGS,
  formatUseAsDictionary,
  isCompressible,
  rankEncodings,
  shouldCompress,
  SUPPORTED_COMPRESSION_ENCODINGS,
} from "@kingsleyweb/bun-common";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { step, title } from "../shared/console";

title("Option tour: CompressionOptions");

/** A body of several kilobytes that compresses measurably differently per setting. */
const TEXT = JSON.stringify(
  Array.from({ length: 300 }, (_, i) => ({
    id: i,
    code: (i * 2654435761) % 1000003,
    label: `item-${(i * 7919) % 997}`,
  })),
);

/** A router answering `GET /data` (TEXT) and `GET /tiny` through compression(options). */
function app(options?: CompressionOptions): BunRouter {
  const router = new BunRouter();
  router.use(compression(options));
  router.all("/data", (_req, res) => {
    res.type("json").send(TEXT);
  });
  router.get("/tiny", (_req, res) => {
    res.json({ ok: true });
  });
  router.get("/png", (_req, res) => {
    res.type("png").send(Buffer.from(TEXT));
  });
  router.get("/stream", (_req, res) => {
    res.type("json").send(new Blob([TEXT]).stream());
  });
  return router;
}

/** The result of one request: encoding, Vary, raw bytes, status. */
async function get(
  router: BunRouter,
  path: string,
  accept: string | null,
  headers: Record<string, string> = {},
) {
  const response = await router.fetch(path, {
    headers:
      accept === null ? headers : { "accept-encoding": accept, ...headers },
  });
  return {
    status: response.status,
    encoding: response.headers.get("content-encoding"),
    vary: response.headers.get("vary"),
    bytes: Buffer.from(await response.bytes()),
  };
}

/** Decodes bytes sent with `encoding`. */
function decode(encoding: string | null, bytes: Buffer): string {
  switch (encoding) {
    case "gzip":
      return gunzipSync(bytes).toString();
    case "deflate":
      return inflateSync(bytes).toString();
    case "br":
      return brotliDecompressSync(bytes).toString();
    case "zstd":
      return zstdDecompressSync(bytes).toString();
    default:
      return bytes.toString();
  }
}

/** The encoding `/data` is answered with for `accept`, checking it decodes. */
async function encodingFor(router: BunRouter, accept: string | null) {
  const result = await get(router, "/data", accept);
  if (decode(result.encoding, result.bytes) !== TEXT) {
    throw new Error(`body did not decode for ${accept}`);
  }
  return result.encoding;
}

/** Wire size of `/data` for `accept` through compression(options). */
async function sizeWith(options: CompressionOptions, accept: string) {
  return (await get(app(options), "/data", accept)).bytes.length;
}

/* ------------------------------------------------------------------ */
step("Defaults");
{
  checkEqual(
    "DEFAULT_COMPRESSION_THRESHOLD is 1 KiB",
    DEFAULT_COMPRESSION_THRESHOLD,
    1024,
  );
  checkEqual(
    "DEFAULT_COMPRESSION_ASYNC_THRESHOLD is 64 KiB",
    DEFAULT_COMPRESSION_ASYNC_THRESHOLD,
    64 * 1024,
  );
  checkEqual(
    "DEFAULT_COMPRESSION_ENCODINGS",
    [...DEFAULT_COMPRESSION_ENCODINGS],
    ["br", "zstd", "gzip", "deflate"],
  );
  checkEqual(
    "every one is supported on this Bun",
    [...SUPPORTED_COMPRESSION_ENCODINGS],
    [...DEFAULT_COMPRESSION_ENCODINGS],
  );
  checkEqual(
    "DEFAULT_DICTIONARY_ENCODINGS",
    [...DEFAULT_DICTIONARY_ENCODINGS],
    ["dcz", "dcb"],
  );

  const router = app();
  const result = await get(router, "/data", "gzip, deflate, br, zstd");
  checkEqual("a browser's Accept-Encoding gets br", result.encoding, "br");
  checkEqual("…with Vary: Accept-Encoding", result.vary, "Accept-Encoding");
  checkEqual("…and it decodes", decode(result.encoding, result.bytes), TEXT);
  checkEqual(
    "no Accept-Encoding: not compressed",
    await encodingFor(router, null),
    null,
  );
}

/* ------------------------------------------------------------------ */
step("Accept-Encoding negotiation: q-values, identity and *");
{
  const router = app();
  const cases: [string, string | null][] = [
    ["gzip;q=1, br;q=0.5", "gzip"],
    ["gzip, zstd", "zstd"],
    ["br;q=0, gzip", "gzip"],
    ["identity;q=1, gzip;q=0.5", null],
    ["gzip, identity;q=0", "gzip"],
    ["*", "br"],
    ["br;q=0, *", "zstd"],
    ["gzip;q=0, br;q=0, zstd;q=0, *", "deflate"],
    ["*;q=0", null],
    ["*;q=0, identity", null],
    ["*;q=0, zstd", "zstd"],
  ];
  for (const [accept, expected] of cases) {
    checkEqual(
      `Accept-Encoding: ${accept}`,
      await encodingFor(router, accept),
      expected,
    );
  }
  checkEqual(
    "rankEncodings lists every acceptable coding, best first",
    rankEncodings("gzip, *;q=0.5", ["br", "gzip", "identity"], ["br", "gzip"]),
    ["gzip", "br", "identity"],
  );
}

/* ------------------------------------------------------------------ */
step("threshold");
checkEqual(
  "default: a tiny body stays as it is",
  (await get(app(), "/tiny", "gzip")).encoding,
  null,
);
checkEqual(
  "…with Vary all the same",
  (await get(app(), "/tiny", "gzip")).vary,
  "Accept-Encoding",
);
checkEqual(
  "threshold: 0 compresses it",
  (await get(app({ threshold: 0 }), "/tiny", "gzip")).encoding,
  "gzip",
);
checkEqual(
  'threshold: "100kb" leaves /data alone',
  await encodingFor(app({ threshold: "100kb" }), "gzip"),
  null,
);
checkEqual(
  "threshold: 64 (bytes) compresses /data",
  await encodingFor(app({ threshold: 64 }), "gzip"),
  "gzip",
);
checkEqual(
  'an unparseable threshold falls back to 1 KiB ("lots")',
  (await get(app({ threshold: "lots" }), "/tiny", "gzip")).encoding,
  null,
);
checkEqual(
  "a stream has no known size, so it is always compressed",
  (await get(app({ threshold: "1mb" }), "/stream", "gzip")).encoding,
  "gzip",
);

/* ------------------------------------------------------------------ */
step("filter, shouldCompress and isCompressible");
{
  const png = await get(app(), "/png", "gzip");
  checkEqual("default filter: image/png is not compressed", png.encoding, null);
  checkEqual("…and gets no Vary", png.vary, null);
  checkEqual(
    "filter: () => true compresses it",
    (await get(app({ filter: () => true }), "/png", "gzip")).encoding,
    "gzip",
  );

  const seen: string[] = [];
  const custom = app({
    filter: (req, res) => {
      seen.push(`${req.path} ${res.getHeader("Content-Type")}`);
      return req.path !== "/data" && shouldCompress(req, res);
    },
  });
  checkEqual(
    "a filter answering false leaves the body alone",
    await encodingFor(custom, "gzip"),
    null,
  );
  check(
    "…and was called with the response's Content-Type",
    seen[0]?.startsWith("/data application/json") === true,
    seen,
  );

  checkEqual(
    "isCompressible follows the compressible package",
    [
      "text/css",
      "application/json; charset=utf-8",
      "image/svg+xml",
      "application/vnd.api+json",
      "font/ttf",
      "image/png",
      "application/zip",
      null,
    ].map(isCompressible),
    [true, true, true, true, true, false, false, false],
  );
}

/* ------------------------------------------------------------------ */
step("zlib options: level, memLevel, strategy, windowBits, chunkSize");
{
  check(
    "level: 0 is larger than level: 9",
    (await sizeWith({ level: 0 }, "gzip")) >
      (await sizeWith({ level: 9 }, "gzip")),
  );
  check(
    "level applies to deflate too",
    (await sizeWith({ level: 0 }, "deflate")) > (await sizeWith({}, "deflate")),
  );
  check(
    "strategy: Z_HUFFMAN_ONLY is larger than the default",
    (await sizeWith({ strategy: constants.Z_HUFFMAN_ONLY }, "gzip")) >
      (await sizeWith({}, "gzip")),
  );
  check(
    "memLevel: 1 changes the output",
    (await sizeWith({ memLevel: 1 }, "gzip")) !== (await sizeWith({}, "gzip")),
  );
  checkEqual(
    "windowBits: 9 still decodes",
    await encodingFor(app({ windowBits: 9 }), "deflate"),
    "deflate",
  );
  const chunked = await get(app({ chunkSize: 64 }), "/stream", "gzip");
  checkEqual(
    "chunkSize: 64 — a stream still decodes",
    decode(chunked.encoding, chunked.bytes),
    TEXT,
  );
}

/* ------------------------------------------------------------------ */
step("brotli and zstd");
{
  const quality = constants.BROTLI_PARAM_QUALITY;
  check(
    "brotli params: quality 0 is larger than the default quality 4",
    (await sizeWith({ brotli: { params: { [quality]: 0 } } }, "br")) >
      (await sizeWith({}, "br")),
  );
  checkEqual(
    "brotli: {} keeps quality 4",
    await sizeWith({ brotli: {} }, "br"),
    await sizeWith({}, "br"),
  );

  const level = constants.ZSTD_c_compressionLevel;
  check(
    "zstd level 19 is no larger than level 1",
    (await sizeWith({ zstd: { params: { [level]: 19 } } }, "zstd")) <=
      (await sizeWith({ zstd: { params: { [level]: 1 } } }, "zstd")),
  );
  const checksummed = await get(
    app({ zstd: { params: { [constants.ZSTD_c_checksumFlag]: 1 } } }),
    "/data",
    "zstd",
  );
  checkEqual(
    "zstd params beyond the level apply (checksum flag set)",
    checksummed.bytes[4] & 0b100,
    0b100,
  );
}

/* ------------------------------------------------------------------ */
step('encodings: a list, "*" and wildcard entries');
checkEqual(
  '["gzip"] offers gzip alone',
  await encodingFor(app({ encodings: ["gzip"] }), "br, zstd, gzip"),
  "gzip",
);
checkEqual(
  '["gzip"] and a client without gzip: identity',
  await encodingFor(app({ encodings: ["gzip"] }), "br"),
  null,
);
checkEqual(
  '"*" is every supported encoding',
  await encodingFor(app({ encodings: "*" }), "gzip, br"),
  "br",
);
checkEqual(
  '["zstd", "*"]: zstd first',
  await encodingFor(app({ encodings: ["zstd", "*"] }), "gzip, br, zstd"),
  "zstd",
);
checkEqual(
  '["zstd", "*"]: then the rest in default order',
  await encodingFor(app({ encodings: ["zstd", "*"] }), "gzip, br"),
  "br",
);
checkEqual(
  '["gzip", "*", "br"]: br last',
  await encodingFor(app({ encodings: ["gzip", "*", "br"] }), "br, deflate"),
  "deflate",
);
checkEqual(
  "[] never compresses",
  await encodingFor(app({ encodings: [] }), "gzip"),
  null,
);
await checkRejects(
  "an unknown encoding throws",
  () => compression({ encodings: ["lzma" as "gzip"] }),
  {
    name: "TypeError",
    message: /unknown encoding "lzma"/,
  },
);

/* ------------------------------------------------------------------ */
step("enforceEncoding");
{
  const enforced = app({ enforceEncoding: "gzip" });
  checkEqual(
    "no Accept-Encoding: the enforced encoding",
    await encodingFor(enforced, null),
    "gzip",
  );
  checkEqual(
    "an empty Accept-Encoding too",
    await encodingFor(enforced, ""),
    "gzip",
  );
  checkEqual(
    "a header is negotiated as usual",
    await encodingFor(enforced, "identity"),
    null,
  );
  checkEqual(
    "an encoding not offered is ignored",
    await encodingFor(
      app({ enforceEncoding: "br", encodings: ["gzip"] }),
      null,
    ),
    null,
  );
}

/* ------------------------------------------------------------------ */
step("asyncThreshold");
for (const asyncThreshold of [0, Infinity, "2kb"] as const) {
  checkEqual(
    `asyncThreshold: ${String(asyncThreshold)} — the same body`,
    await encodingFor(app({ asyncThreshold }), "zstd"),
    "zstd",
  );
}

/* ------------------------------------------------------------------ */
step("dictionaries and dictionaryEncodings (RFC 9842)");
{
  const dictionary = Buffer.from(TEXT.replace(/item-1/g, "item-one"));
  const hash = compressionDictionaryHash(dictionary);
  const headers = { "available-dictionary": `:${hash.toString("base64")}:` };

  const withArray = app({
    dictionaries: [dictionary],
    dictionaryEncodings: ["dcb", "dcz"],
  });
  const dcb = await get(withArray, "/data", "br, dcb, dcz", headers);
  checkEqual("a matching Available-Dictionary gets dcb", dcb.encoding, "dcb");
  checkEqual(
    "…starting with the dcb magic and the dictionary's SHA-256",
    [
      dcb.bytes.subarray(0, 4).toString("hex"),
      dcb.bytes.subarray(4, 36).equals(hash),
    ],
    ["ff444342", true],
  );
  checkEqual(
    "…decoding against the dictionary",
    brotliDecompressSync(dcb.bytes.subarray(36), { dictionary } as Parameters<
      typeof brotliDecompressSync
    >[1]).toString(),
    TEXT,
  );
  checkEqual(
    "…with Vary: Accept-Encoding, Available-Dictionary",
    dcb.vary,
    "Accept-Encoding, Available-Dictionary",
  );
  const br = await get(withArray, "/data", "br");
  check("…far smaller than br", dcb.bytes.length < br.bytes.length / 2, {
    dcb: dcb.bytes.length,
    br: br.bytes.length,
  });

  const dcz = await get(
    app({ dictionaries: [dictionary] }),
    "/data",
    "dcb, dcz",
    headers,
  );
  checkEqual(
    "by default, a client accepting both gets dcz (far cheaper to produce)",
    dcz.encoding,
    "dcz",
  );
  checkEqual(
    "…decoding against the dictionary",
    zstdDecompressSync(dcz.bytes.subarray(40), { dictionary } as Parameters<
      typeof zstdDecompressSync
    >[1]).toString(),
    TEXT,
  );

  checkEqual(
    "a client not accepting dcb/dcz gets plain br",
    (await get(withArray, "/data", "br", headers)).encoding,
    "br",
  );
  checkEqual(
    "an unknown dictionary hash is ignored",
    (
      await get(withArray, "/data", "gzip, dcb", {
        "available-dictionary": `:${Buffer.alloc(32).toString("base64")}:`,
      })
    ).encoding,
    "gzip",
  );

  const asked: string[] = [];
  const resolved = app({
    dictionaries: (requested, coding) => {
      asked.push(coding);
      return requested.equals(hash) ? dictionary : undefined;
    },
  });
  checkEqual(
    "a resolver works like an array",
    (await get(resolved, "/data", "dcb", headers)).encoding,
    "dcb",
  );
  checkEqual("…called per dictionary coding", asked, ["dcz", "dcb"]);

  checkEqual(
    "formatUseAsDictionary builds the advertising header",
    formatUseAsDictionary({
      match: "/data.*.json",
      matchDest: ["empty"],
      id: "data-v1",
    }),
    'match="/data.*.json", match-dest=("empty"), id="data-v1"',
  );
}

/* ------------------------------------------------------------------ */
step("res.flush() — over a real socket");
{
  const adapter = new BunHttpAdapter();
  adapter.use(compression());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  adapter.get("/flushed", (_req, res) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    res.type("text/plain").send(
      new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      }),
    );
    void (async () => {
      controller.enqueue(new TextEncoder().encode("first\n"));
      await Bun.sleep(50);
      res.flush();
      await gate;
      controller.enqueue(new TextEncoder().encode("second\n"));
      controller.close();
    })();
  });
  await adapter.listen(0);
  try {
    const response = await fetch(`${adapter.url}/flushed`, {
      headers: { "accept-encoding": "gzip" },
      decompress: false,
    });
    const gunzip = createGunzip();
    let text = "";
    gunzip.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const deadline = Date.now() + 3000;
    while (!text.includes("first") && Date.now() < deadline) {
      const { value } = await reader.read();
      if (value) {
        gunzip.write(value);
      }
      await Bun.sleep(10);
    }
    checkEqual(
      "what was written before flush() decodes before the rest is sent",
      text,
      "first\n",
    );
    release();
    for (;;) {
      const { value, done } = await reader.read();
      if (value) {
        gunzip.write(value);
      }
      if (done) {
        break;
      }
    }
    await Bun.sleep(20);
    checkEqual("…and the rest follows", text, "first\nsecond\n");
  } finally {
    await adapter.close();
  }
}

summary();
