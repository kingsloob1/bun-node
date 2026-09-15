import type { CompressionOptions } from "../lib/compression";
import type { RouterErrorMiddlewareHandler } from "../lib/types/general";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { afterAll, describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRouter } from "../lib/BunRouter";
import {
  compression,
  DEFAULT_COMPRESSION_ENCODINGS,
  dictionaryCompressionSupported,
  formatUseAsDictionary,
  isCompressible,
  rankEncodings,
  resolveEncodingOrder,
  shouldCompress,
  SUPPORTED_COMPRESSION_ENCODINGS,
} from "../lib/compression";
import { createServeStaticHandler } from "../lib/serveStatic";
import { compressionDictionaryHash } from "../lib/utils/native";

/** A JSON body of a few kilobytes — over the default 1 KiB threshold. */
const BODY = {
  items: Array.from({ length: 120 }, (_, i) => ({
    id: i,
    name: `item ${i}`,
    tags: ["alpha", i % 2 ? "beta" : "gamma"],
  })),
};
const TEXT = JSON.stringify(BODY);

/** Scratch directory for sendFile/static fixtures. */
const scratch = mkdtempSync(join(tmpdir(), "bun-common-compression-"));
const DATA_FILE = join(scratch, "data.json");
writeFileSync(DATA_FILE, TEXT);

/** Servers started by a test, closed at the end. */
const started: BunHttpAdapter[] = [];

afterAll(async () => {
  for (const adapter of started) {
    await adapter.close();
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** Decodes a body sent with `encoding` (dictionary codings need `dictionary`). */
function decode(
  encoding: string | null,
  bytes: Uint8Array,
  dictionary?: Uint8Array,
): string {
  switch (encoding) {
    case "gzip":
      return zlib.gunzipSync(bytes).toString();
    case "deflate":
      return zlib.inflateSync(bytes).toString();
    case "br":
      return zlib.brotliDecompressSync(bytes).toString();
    case "zstd":
      return zlib.zstdDecompressSync(bytes).toString();
    case "dcb":
      return zlib
        .brotliDecompressSync(bytes.subarray(36), {
          dictionary,
        } as zlib.BrotliOptions)
        .toString();
    case "dcz":
      return zlib
        .zstdDecompressSync(bytes.subarray(40), {
          dictionary,
        } as zlib.ZstdOptions)
        .toString();
    default:
      return Buffer.from(bytes).toString();
  }
}

/** A router with `compression(options)` in front of a few routes. */
function app(options?: CompressionOptions): BunRouter {
  const router = new BunRouter();
  router.use(compression(options));
  router.all("/json", (_req, res) => {
    res.json(BODY);
  });
  router.get("/small", (_req, res) => {
    res.json({ ok: true });
  });
  router.get("/png", (_req, res) => {
    res.type("image/png").send(Buffer.from(TEXT));
  });
  router.get("/blob", (_req, res) => {
    res.send(new Blob([TEXT], { type: "application/json" }));
  });
  router.get("/tiny-blob", (_req, res) => {
    res.send(new Blob(["{}"], { type: "application/json" }));
  });
  router.get("/stream", (_req, res) => {
    res.type("json").send(new Blob(["{}"]).stream());
  });
  router.get("/tagged", (_req, res) => {
    res.setEtag();
    res.json(BODY);
  });
  router.get("/file", async (_req, res) => {
    await res.sendFile(DATA_FILE);
  });
  router.use(((error, _req, res, _next) => {
    res.status(500).json({ error: (error as Error).message });
  }) satisfies RouterErrorMiddlewareHandler);
  return router;
}

/** GETs `path` with an `Accept-Encoding` (none when `null`). */
async function get(
  router: BunRouter,
  path: string,
  acceptEncoding: string | null,
  headers: Record<string, string> = {},
  method = "GET",
) {
  const response = await router.fetch(path, {
    method,
    headers:
      acceptEncoding === null
        ? headers
        : { "accept-encoding": acceptEncoding, ...headers },
  });
  const bytes = await response.bytes();
  const encoding = response.headers.get("content-encoding");
  return { response, bytes, encoding, headers: response.headers };
}

describe("compression: negotiation", () => {
  const router = app();
  const matrix: [string | null, string | null][] = [
    ["gzip", "gzip"],
    ["deflate", "deflate"],
    ["br", "br"],
    ["zstd", "zstd"],
    ["GZIP", "gzip"],
    ["gzip, deflate, br, zstd", "br"],
    ["gzip, deflate, zstd", "zstd"],
    ["deflate, gzip", "gzip"],
    ["gzip;q=1, br;q=0.5", "gzip"],
    ["gzip;q=0.8, zstd;q=0.8, br;q=0.9", "br"],
    ["br;q=0, gzip", "gzip"],
    ["identity", null],
    ["identity;q=1, gzip;q=0.5", null],
    ["gzip, identity;q=0", "gzip"],
    ["x-unknown", null],
    ["gzip;q=abc", null],
    ["", null],
    [null, null],
    // Wildcards (RFC 9110 §12.5.3): `*` covers every coding not listed.
    ["*", "br"],
    ["*;q=0.5, gzip", "gzip"],
    ["gzip;q=0, *", "br"],
    ["br;q=0, zstd;q=0, *", "gzip"],
    ["br;q=0, *;q=0.5", "zstd"],
    ["*;q=0", null],
    ["*;q=0, identity", null],
    ["*;q=0, zstd", "zstd"],
    ["*;q=0, identity;q=0.5, deflate", "deflate"],
  ];

  for (const [accept, expected] of matrix) {
    it(`Accept-Encoding ${JSON.stringify(accept)} → ${expected ?? "identity"}`, async () => {
      const { encoding, bytes, headers } = await get(router, "/json", accept);
      expect(encoding).toBe(expected);
      expect(decode(encoding, bytes)).toBe(TEXT);
      expect(headers.get("vary")).toBe("Accept-Encoding");
    });
  }

  it("rankEncodings orders every acceptable coding", () => {
    const provided = ["br", "zstd", "gzip", "deflate", "identity"];
    const preferred = provided.slice(0, 4);
    expect(
      rankEncodings("gzip, br;q=0.5, *;q=0.1", provided, preferred),
    ).toEqual(["gzip", "br", "zstd", "deflate", "identity"]);
    expect(rankEncodings("*;q=0", provided, preferred)).toEqual([]);
    expect(rankEncodings(undefined, provided, preferred)).toEqual(["identity"]);
  });
});

describe("compression: encodings option", () => {
  it("defaults to every supported encoding in the default order", () => {
    expect(SUPPORTED_COMPRESSION_ENCODINGS).toEqual(
      DEFAULT_COMPRESSION_ENCODINGS,
    );
  });

  it("restricts to a list", async () => {
    const { encoding } = await get(
      app({ encodings: ["gzip"] }),
      "/json",
      "br, zstd, gzip",
    );
    expect(encoding).toBe("gzip");
    const none = await get(app({ encodings: ["gzip"] }), "/json", "br, zstd");
    expect(none.encoding).toBeNull();
  });

  it('accepts "*" alone', async () => {
    const { encoding } = await get(
      app({ encodings: "*" }),
      "/json",
      "gzip, br",
    );
    expect(encoding).toBe("br");
  });

  it("expands a trailing wildcard after an explicit order", async () => {
    const router = app({ encodings: ["zstd", "*"] });
    expect((await get(router, "/json", "gzip, br, zstd")).encoding).toBe(
      "zstd",
    );
    expect((await get(router, "/json", "gzip, br")).encoding).toBe("br");
  });

  it("puts explicit entries after a wildcard in place", async () => {
    // gzip, then zstd and deflate (the wildcard), then br.
    const router = app({ encodings: ["gzip", "*", "br"] });
    expect((await get(router, "/json", "br, deflate")).encoding).toBe(
      "deflate",
    );
  });

  it("never compresses with an empty list", async () => {
    const { encoding, headers } = await get(
      app({ encodings: [] }),
      "/json",
      "gzip",
    );
    expect(encoding).toBeNull();
    expect(headers.get("vary")).toBe("Accept-Encoding");
  });

  it("resolveEncodingOrder expands, de-duplicates and validates", () => {
    const all = ["br", "zstd", "gzip", "deflate"] as const;
    expect(resolveEncodingOrder("*", all)).toEqual([...all]);
    expect(resolveEncodingOrder(["deflate", "*"], all)).toEqual([
      "deflate",
      "br",
      "zstd",
      "gzip",
    ]);
    expect(resolveEncodingOrder(["gzip", "gzip", "*", "*"], all)).toEqual([
      "gzip",
      "br",
      "zstd",
      "deflate",
    ]);
    expect(() =>
      resolveEncodingOrder(["gzp" as "gzip"], all, "encodings"),
    ).toThrow(TypeError);
    expect(() => resolveEncodingOrder(["br"], ["gzip"])).toThrow(
      /not available/,
    );
  });

  it("throws for an unknown encoding at construction", () => {
    expect(() => compression({ encodings: ["lzma" as "gzip"] })).toThrow(
      /unknown encoding "lzma"/,
    );
  });
});

describe("compression: enforceEncoding", () => {
  it("leaves a request without Accept-Encoding uncompressed by default", async () => {
    expect((await get(app(), "/json", null)).encoding).toBeNull();
  });

  it("applies to a request with no, or an empty, Accept-Encoding", async () => {
    const router = app({ enforceEncoding: "gzip" });
    const absent = await get(router, "/json", null);
    expect(absent.encoding).toBe("gzip");
    expect(decode("gzip", absent.bytes)).toBe(TEXT);
    expect((await get(router, "/json", "")).encoding).toBe("gzip");
    expect((await get(router, "/json", "identity")).encoding).toBeNull();
  });

  it("is ignored for an encoding not offered", async () => {
    const router = app({ enforceEncoding: "br", encodings: ["gzip"] });
    expect((await get(router, "/json", null)).encoding).toBeNull();
  });
});

describe("compression: threshold", () => {
  it("skips a body under 1 KiB by default, still adding Vary", async () => {
    const { encoding, headers } = await get(app(), "/small", "gzip");
    expect(encoding).toBeNull();
    expect(headers.get("vary")).toBe("Accept-Encoding");
  });

  it("threshold: 0 compresses the smallest body", async () => {
    const { encoding, bytes } = await get(
      app({ threshold: 0 }),
      "/small",
      "gzip",
    );
    expect(encoding).toBe("gzip");
    expect(decode(encoding, bytes)).toBe('{"ok":true}');
  });

  it("accepts a size string", async () => {
    expect(
      (await get(app({ threshold: "10kb" }), "/json", "gzip")).encoding,
    ).toBeNull();
    expect(
      (await get(app({ threshold: "1b" }), "/small", "gzip")).encoding,
    ).toBe("gzip");
  });

  it("falls back to 1 KiB for an unparseable value, as the package does", async () => {
    const router = app({ threshold: "lots" });
    expect((await get(router, "/json", "gzip")).encoding).toBe("gzip");
    expect((await get(router, "/small", "gzip")).encoding).toBeNull();
  });

  it("sizes a Blob by its size", async () => {
    expect((await get(app(), "/tiny-blob", "gzip")).encoding).toBeNull();
    expect((await get(app(), "/blob", "gzip")).encoding).toBe("gzip");
  });

  it("honours a Content-Length header below the threshold", async () => {
    const router = new BunRouter();
    router.use(compression());
    router.get("/declared", (_req, res) => {
      res.setHeader("Content-Length", "2");
      res.type("json").send(new Blob(["{}"]).stream());
    });
    expect((await get(router, "/declared", "gzip")).encoding).toBeNull();
  });

  it("compresses a stream whatever its size (unknown)", async () => {
    const { encoding, bytes } = await get(app(), "/stream", "gzip");
    expect(encoding).toBe("gzip");
    expect(decode(encoding, bytes)).toBe("{}");
  });
});

describe("compression: filter", () => {
  it("skips an incompressible type, without Vary", async () => {
    const { encoding, headers } = await get(app(), "/png", "gzip");
    expect(encoding).toBeNull();
    expect(headers.get("vary")).toBeNull();
  });

  it("uses a custom filter", async () => {
    const everything = await get(app({ filter: () => true }), "/png", "gzip");
    expect(everything.encoding).toBe("gzip");
    const nothing = await get(app({ filter: () => false }), "/json", "gzip");
    expect(nothing.encoding).toBeNull();
    expect(nothing.headers.get("vary")).toBeNull();
  });

  it("lets the filter see a Blob's own type", async () => {
    let seen: string | null = null;
    const router = app({
      filter: (req, res) => {
        seen = res.getHeader("Content-Type");
        return shouldCompress(req, res);
      },
    });
    const { encoding, headers } = await get(router, "/blob", "gzip");
    expect(seen).toStartWith("application/json");
    expect(encoding).toBe("gzip");
    expect(headers.get("content-type")).toStartWith("application/json");
  });

  it("isCompressible follows compressible over mime-db", () => {
    for (const type of [
      "text/html",
      "text/plain; charset=utf-8",
      "application/json",
      "APPLICATION/JSON",
      "application/vnd.api+json",
      "image/svg+xml",
      "application/javascript",
      "font/ttf",
      "application/x-www-form-urlencoded",
      "text/event-stream",
    ]) {
      expect(isCompressible(type)).toBe(true);
    }
    for (const type of [
      "image/png",
      "application/octet-stream",
      "application/gzip",
      "video/mp4",
      "",
      null,
      undefined,
    ]) {
      expect(isCompressible(type)).toBe(false);
    }
  });
});

describe("compression: responses left alone", () => {
  it("honours Cache-Control: no-transform, without Vary", async () => {
    const router = new BunRouter();
    router.use(compression());
    router.get("/nt", (_req, res) => {
      res.setHeader("Cache-Control", "public, No-Transform");
      res.json(BODY);
    });
    const { encoding, headers } = await get(router, "/nt", "gzip");
    expect(encoding).toBeNull();
    expect(headers.get("vary")).toBeNull();
  });

  it("keeps an existing Content-Encoding", async () => {
    const router = new BunRouter();
    router.use(compression());
    router.get("/pre", (_req, res) => {
      res.setHeader("Content-Encoding", "gzip");
      res.type("json").send(zlib.gzipSync(TEXT));
    });
    const { encoding, bytes, headers } = await get(router, "/pre", "br");
    expect(encoding).toBe("gzip");
    expect(decode("gzip", bytes)).toBe(TEXT);
    expect(headers.get("vary")).toBe("Accept-Encoding");
  });

  it("treats Content-Encoding: identity as not encoded", async () => {
    const router = new BunRouter();
    router.use(compression());
    router.get("/identity", (_req, res) => {
      res.setHeader("Content-Encoding", "identity");
      res.json(BODY);
    });
    const { encoding, bytes } = await get(router, "/identity", "br");
    expect(encoding).toBe("br");
    expect(decode(encoding, bytes)).toBe(TEXT);
  });

  it("sends HEAD headers only, with Vary", async () => {
    const { encoding, headers } = await get(app(), "/json", "gzip", {}, "HEAD");
    expect(encoding).toBeNull();
    expect(headers.get("vary")).toBe("Accept-Encoding");
  });

  it("never compresses a 204", async () => {
    const router = new BunRouter();
    router.use(compression({ filter: () => true, threshold: 0 }));
    router.get("/empty", (_req, res) => {
      res.status(204).send("ignored");
    });
    const { response, encoding } = await get(router, "/empty", "gzip");
    expect(response.status).toBe(204);
    expect(encoding).toBeNull();
  });

  it("never compresses a 304, and keeps the ETag", async () => {
    const router = app();
    const first = await get(router, "/tagged", "gzip");
    const tag = first.headers.get("etag");
    expect(first.encoding).toBe("gzip");
    expect(tag).toBeTruthy();

    const identity = await get(router, "/tagged", null);
    expect(identity.headers.get("etag")).toBe(tag);

    const again = await get(router, "/tagged", "gzip", {
      "if-none-match": tag ?? "",
    });
    expect(again.response.status).toBe(304);
    expect(again.encoding).toBeNull();
    expect(again.bytes.length).toBe(0);
  });

  it("leaves a body-less response alone", async () => {
    const router = new BunRouter();
    router.use(compression({ threshold: 0 }));
    router.get("/nothing", async (_req, res) => {
      res.type("json");
      await res.end();
    });
    expect((await get(router, "/nothing", "gzip")).encoding).toBeNull();
  });
});

describe("compression: headers", () => {
  it("appends to an existing Vary", async () => {
    const router = new BunRouter();
    router.use(compression());
    router.get("/varied", (_req, res) => {
      res.vary("Origin");
      res.json(BODY);
    });
    const { headers } = await get(router, "/varied", "gzip");
    expect(headers.get("vary")).toBe("Origin, Accept-Encoding");
  });

  it("removes Content-Length when compressing, and reflects it on res", async () => {
    let seen: Record<string, string | null> = {};
    const router = new BunRouter();
    router.use(compression());
    router.get("/sized", (_req, res) => {
      res.setHeader("Content-Length", String(Buffer.byteLength(TEXT)));
      res.type("json").send(new Blob([TEXT]));
      seen = {
        encoding: res.getHeader("Content-Encoding"),
        length: res.getHeader("Content-Length"),
        vary: res.getHeader("Vary"),
      };
    });
    const plain = await get(router, "/sized", "identity");
    expect(plain.headers.get("content-length")).toBe(
      String(Buffer.byteLength(TEXT)),
    );

    const { encoding, headers, bytes } = await get(router, "/sized", "gzip");
    expect(encoding).toBe("gzip");
    expect(headers.get("content-length")).toBeNull();
    expect(decode(encoding, bytes)).toBe(TEXT);
    expect(seen).toEqual({
      encoding: "gzip",
      length: null,
      vary: "Accept-Encoding",
    });
  });
});

describe("compression: every encoding decodes back", () => {
  for (const encoding of SUPPORTED_COMPRESSION_ENCODINGS) {
    it(`${encoding}: buffered, via node:zlib and Bun`, async () => {
      const result = await get(app(), "/json", encoding);
      expect(result.encoding).toBe(encoding);
      expect(decode(encoding, result.bytes)).toBe(TEXT);

      const format = encoding === "br" ? "brotli" : encoding;
      const viaBun = await new Response(
        new Blob([result.bytes])
          .stream()
          .pipeThrough(
            new DecompressionStream(format as Bun.CompressionFormat),
          ),
      ).text();
      expect(viaBun).toBe(TEXT);
      if (encoding === "gzip") {
        expect(
          Buffer.from(
            Bun.gunzipSync(result.bytes as Uint8Array<ArrayBuffer>),
          ).toString(),
        ).toBe(TEXT);
      }
      if (encoding === "zstd") {
        expect(Bun.zstdDecompressSync(result.bytes).toString()).toBe(TEXT);
      }
    });

    it(`${encoding}: streamed and off-thread`, async () => {
      const stream = await get(app(), "/stream", encoding);
      expect(decode(encoding, stream.bytes)).toBe("{}");

      const offThread = await get(
        app({ asyncThreshold: 0 }),
        "/json",
        encoding,
      );
      expect(offThread.encoding).toBe(encoding);
      expect(decode(encoding, offThread.bytes)).toBe(TEXT);
    });
  }

  it("asyncThreshold accepts Infinity and size strings", async () => {
    for (const asyncThreshold of [Infinity, "2kb", "1mb"]) {
      const { bytes, encoding } = await get(
        app({ asyncThreshold }),
        "/json",
        "br",
      );
      expect(decode(encoding, bytes)).toBe(TEXT);
    }
  });
});

describe("compression: compressor options", () => {
  /** A body that compresses measurably differently at different settings. */
  const varied = JSON.stringify(
    Array.from({ length: 400 }, (_, i) => ({
      i,
      v: (i * 2654435761) % 1000003,
      s: `value-${(i * 7919) % 997}`,
    })),
  );

  /** A router answering `varied` through compression(options). */
  async function size(options: CompressionOptions, accept: string) {
    const router = new BunRouter();
    router.use(compression(options));
    router.get("/", (_req, res) => {
      res.type("json").send(varied);
    });
    const result = await get(router, "/", accept);
    expect(decode(result.encoding, result.bytes)).toBe(varied);
    return result.bytes.length;
  }

  it("level", async () => {
    expect(await size({ level: 0 }, "gzip")).toBeGreaterThan(
      await size({ level: 9 }, "gzip"),
    );
    expect(await size({ level: 0 }, "deflate")).toBeGreaterThan(
      await size({}, "deflate"),
    );
  });

  it("strategy, memLevel, windowBits and chunkSize", async () => {
    expect(
      await size({ strategy: zlib.constants.Z_HUFFMAN_ONLY }, "gzip"),
    ).toBeGreaterThan(await size({}, "gzip"));
    expect(await size({ memLevel: 1 }, "gzip")).toBeGreaterThan(0);
    expect(await size({ windowBits: 9 }, "gzip")).toBeGreaterThan(0);
    expect(await size({ windowBits: 9 }, "deflate")).toBeGreaterThan(0);

    const router = new BunRouter();
    router.use(compression({ chunkSize: 64 }));
    router.get("/s", (_req, res) => {
      res.type("json").send(new Blob([varied]).stream());
    });
    const streamed = await get(router, "/s", "gzip");
    expect(decode("gzip", streamed.bytes)).toBe(varied);
  });

  it("brotli params merge over quality 4", async () => {
    const q = zlib.constants.BROTLI_PARAM_QUALITY;
    expect(
      await size({ brotli: { params: { [q]: 0 } } }, "br"),
    ).toBeGreaterThan(await size({}, "br"));
    expect(await size({ brotli: {} }, "br")).toBe(await size({}, "br"));
  });

  it("zstd level, and parameters beyond the level", async () => {
    const level = zlib.constants.ZSTD_c_compressionLevel;
    expect(
      await size({ zstd: { params: { [level]: 1 } } }, "zstd"),
    ).toBeGreaterThanOrEqual(
      await size({ zstd: { params: { [level]: 19 } } }, "zstd"),
    );

    const router = new BunRouter();
    router.use(
      compression({
        zstd: { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } },
      }),
    );
    router.get("/", (_req, res) => {
      res.type("json").send(varied);
    });
    const { bytes } = await get(router, "/", "zstd");
    // Frame_Header_Descriptor bit 2: Content_Checksum_flag.
    expect(bytes[4] & 0b100).toBe(0b100);
    expect(decode("zstd", bytes)).toBe(varied);
  });
});

describe("compression: sendFile and static files", () => {
  it("compresses sendFile", async () => {
    const { encoding, bytes, headers } = await get(app(), "/file", "gzip");
    expect(encoding).toBe("gzip");
    expect(headers.get("content-type")).toStartWith("application/json");
    expect(decode(encoding, bytes)).toBe(TEXT);
  });

  it("never compresses a sendFile range (206)", async () => {
    const { response, encoding, bytes } = await get(app(), "/file", "gzip", {
      range: "bytes=0-9",
    });
    expect(response.status).toBe(206);
    expect(encoding).toBeNull();
    expect(Buffer.from(bytes).toString()).toBe(TEXT.slice(0, 10));
  });

  it("compresses a static file through the middleware", async () => {
    const router = new BunRouter();
    router.use(compression());
    const { prefix, handler } = createServeStaticHandler(scratch, {
      prefix: "/static",
      compression: false,
    });
    router.get(`${prefix}/*`, handler);
    const { encoding, bytes, headers } = await get(
      router,
      "/static/data.json",
      "br",
    );
    expect(encoding).toBe("br");
    expect(headers.get("content-length")).toBeNull();
    expect(headers.get("accept-ranges")).toBe("bytes");
    expect(decode(encoding, bytes)).toBe(TEXT);
  });

  it("serves a static range uncompressed through a real server", async () => {
    const adapter = new BunHttpAdapter();
    adapter.use(compression());
    adapter.useStaticAssets(scratch, { prefix: "/static", compression: false });
    await adapter.listen(0);
    started.push(adapter);
    const response = await fetch(
      `http://127.0.0.1:${adapter.listeningPort}/static/data.json`,
      {
        headers: { "accept-encoding": "gzip", range: "bytes=0-9" },
        decompress: false,
      },
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe(TEXT.slice(0, 10));
  });
});

describe("compression: streaming over a socket", () => {
  /** A `node:zlib` decoder that accumulates text as it goes. */
  function streamingDecoder(encoding: string) {
    const engine =
      encoding === "gzip"
        ? zlib.createGunzip()
        : encoding === "br"
          ? zlib.createBrotliDecompress()
          : encoding === "zstd"
            ? zlib.createZstdDecompress()
            : zlib.createInflate();
    let text = "";
    engine.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
    return {
      write: (chunk: Uint8Array) => engine.write(chunk),
      get text() {
        return text;
      },
    };
  }

  /** Reads until the decoder's text includes `expected`, or times out. */
  async function readUntil(
    reader: { read: () => Promise<{ done: boolean; value?: Uint8Array }> },
    decoder: ReturnType<typeof streamingDecoder>,
    expected: string,
  ) {
    const deadline = Date.now() + 3000;
    while (!decoder.text.includes(expected)) {
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${JSON.stringify(expected)}; got ${JSON.stringify(decoder.text)}`,
        );
      }
      const { value, done } = await reader.read();
      if (value) {
        decoder.write(value);
        await Bun.sleep(5);
      }
      if (done) {
        await Bun.sleep(20);
        break;
      }
    }
    return decoder.text;
  }

  /** Starts an adapter with compression() and `setup`'s routes. */
  async function serve(setup: (adapter: BunHttpAdapter) => void) {
    const adapter = new BunHttpAdapter();
    adapter.use(compression());
    setup(adapter);
    await adapter.listen(0);
    started.push(adapter);
    return `http://127.0.0.1:${adapter.listeningPort}`;
  }

  for (const encoding of SUPPORTED_COMPRESSION_ENCODINGS) {
    it(`${encoding}: flushes each server-sent event as it is written`, async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const base = await serve((adapter) => {
        adapter.get("/events", (_req, res) => {
          // As on Node, write() adds no Content-Type: an SSE endpoint sets it.
          res.setHeader("Content-Type", "text/event-stream");
          res.write("data: one\n\n");
          void (async () => {
            await gate;
            res.write("data: two\n\n");
            await res.end();
          })();
        });
      });

      const response = await fetch(`${base}/events`, {
        headers: { "accept-encoding": encoding },
        decompress: false,
      });
      expect(response.headers.get("content-encoding")).toBe(encoding);
      expect(response.headers.get("content-type")).toStartWith(
        "text/event-stream",
      );
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = streamingDecoder(encoding);

      // The first event decodes while the handler is still holding the second.
      expect(await readUntil(reader, decoder, "data: one\n\n")).toBe(
        "data: one\n\n",
      );
      release();
      expect(await readUntil(reader, decoder, "data: two\n\n")).toBe(
        "data: one\n\ndata: two\n\n",
      );
    });
  }

  it("res.flush() pushes out what a stream has written so far", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = await serve((adapter) => {
      adapter.get("/flushed", (_req, res) => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        });
        res.type("text/plain").send(body);
        void (async () => {
          controller.enqueue(new TextEncoder().encode("first part\n"));
          await Bun.sleep(50);
          res.flush();
          await gate;
          controller.enqueue(new TextEncoder().encode("second part\n"));
          controller.close();
        })();
      });
    });

    const response = await fetch(`${base}/flushed`, {
      headers: { "accept-encoding": "gzip" },
      decompress: false,
    });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = streamingDecoder("gzip");
    expect(await readUntil(reader, decoder, "first part\n")).toBe(
      "first part\n",
    );
    release();
    expect(await readUntil(reader, decoder, "second part\n")).toBe(
      "first part\nsecond part\n",
    );
  });
});

describe("compression: dictionaries (RFC 9842)", () => {
  // A previous version of the body, as a client would hold it.
  const dictionary = Buffer.from(TEXT.replace(/item 1(\d)\b/g, "item one-$1"));
  const hash = compressionDictionaryHash(dictionary);
  const available = `:${hash.toString("base64")}:`;

  it("this runtime compresses with dictionaries", () => {
    expect(dictionaryCompressionSupported("dcb")).toBe(true);
    expect(dictionaryCompressionSupported("dcz")).toBe(true);
  });

  it("answers dcb for a matching Available-Dictionary", async () => {
    const router = app({
      dictionaries: [dictionary],
      dictionaryEncodings: ["dcb", "dcz"],
    });
    const { encoding, bytes, headers } = await get(
      router,
      "/json",
      "gzip, br, zstd, dcb, dcz",
      { "available-dictionary": available },
    );
    expect(encoding).toBe("dcb");
    expect([...bytes.subarray(0, 4)]).toEqual([0xff, 0x44, 0x43, 0x42]);
    expect(Buffer.from(bytes.subarray(4, 36)).equals(hash)).toBe(true);
    expect(decode("dcb", bytes, dictionary)).toBe(TEXT);
    expect(headers.get("vary")).toBe("Accept-Encoding, Available-Dictionary");
    // Against a dictionary this close, far smaller than plain brotli.
    const plain = await get(router, "/json", "br");
    expect(bytes.length).toBeLessThan(plain.bytes.length);
  });

  it("prefers dcz by default, with the zstd header", async () => {
    const router = app({ dictionaries: [dictionary] });
    const { encoding, bytes } = await get(router, "/json", "br, dcb, dcz", {
      "available-dictionary": available,
    });
    expect(encoding).toBe("dcz");
    expect(Buffer.from(bytes.subarray(0, 8)).toString("hex")).toBe(
      "5e2a4d1820000000",
    );
    expect(Buffer.from(bytes.subarray(8, 40)).equals(hash)).toBe(true);
    expect(decode("dcz", bytes, dictionary)).toBe(TEXT);
  });

  it("uses dictionary codings off-thread and streamed", async () => {
    for (const coding of ["dcb", "dcz"] as const) {
      const offThread = await get(
        app({
          dictionaries: [dictionary],
          dictionaryEncodings: [coding],
          asyncThreshold: 0,
        }),
        "/json",
        coding,
        { "available-dictionary": available },
      );
      expect(offThread.encoding).toBe(coding);
      expect(decode(coding, offThread.bytes, dictionary)).toBe(TEXT);

      const router = new BunRouter();
      router.use(
        compression({
          dictionaries: [dictionary],
          dictionaryEncodings: [coding],
        }),
      );
      router.get("/s", (_req, res) => {
        res.type("json").send(new Blob([TEXT]).stream());
      });
      const streamed = await get(router, "/s", coding, {
        "available-dictionary": available,
      });
      expect(streamed.encoding).toBe(coding);
      expect(decode(coding, streamed.bytes, dictionary)).toBe(TEXT);
    }
  });

  it("falls back to the other encodings when dcb/dcz is not accepted", async () => {
    const router = app({ dictionaries: [dictionary] });
    const { encoding, headers } = await get(router, "/json", "gzip, br", {
      "available-dictionary": available,
    });
    expect(encoding).toBe("br");
    expect(headers.get("vary")).toBe("Accept-Encoding, Available-Dictionary");
  });

  it("ignores an unknown or malformed Available-Dictionary", async () => {
    const router = app({ dictionaries: [dictionary] });
    const unknown = `:${Buffer.alloc(32, 7).toString("base64")}:`;
    for (const value of [unknown, "not-a-hash", ":AAAA:"]) {
      const { encoding } = await get(router, "/json", "dcb, dcz, gzip", {
        "available-dictionary": value,
      });
      expect(encoding).toBe("gzip");
    }
  });

  it("never offers dcb/dcz without dictionaries", async () => {
    const { encoding, headers } = await get(app(), "/json", "dcb, dcz", {
      "available-dictionary": available,
    });
    expect(encoding).toBeNull();
    expect(headers.get("vary")).toBe("Accept-Encoding");
  });

  it("accepts a resolver, and verifies its answer", async () => {
    const asked: string[] = [];
    const router = app({
      dictionaries: (requested, coding) => {
        asked.push(
          `${coding}:${requested.toString("hex") === hash.toString("hex")}`,
        );
        return requested.equals(hash) ? dictionary : undefined;
      },
    });
    const { encoding, bytes } = await get(router, "/json", "dcb", {
      "available-dictionary": available,
    });
    expect(encoding).toBe("dcb");
    expect(decode("dcb", bytes, dictionary)).toBe(TEXT);
    expect(asked).toContain("dcb:true");

    const lying = new BunHttpAdapter();
    lying.use(compression({ dictionaries: () => Buffer.from("not it") }));
    lying.get("/json", (_req, res) => {
      res.json(BODY);
    });
    const failed = await lying.fetch("/json", {
      headers: { "accept-encoding": "dcb", "available-dictionary": available },
    });
    expect(failed.status).toBe(500);
  });

  it("formatUseAsDictionary builds the response header", () => {
    expect(formatUseAsDictionary({ match: "/app.*.js" })).toBe(
      'match="/app.*.js"',
    );
    expect(
      formatUseAsDictionary({
        match: '/a"b\\c',
        matchDest: ["script", "style"],
        id: "v1",
        type: "raw",
      }),
    ).toBe(
      'match="/a\\"b\\\\c", match-dest=("script" "style"), id="v1", type=raw',
    );
    expect(() => formatUseAsDictionary({ match: "/é" })).toThrow(TypeError);
    expect(() =>
      formatUseAsDictionary({ match: "/", id: "x".repeat(1025) }),
    ).toThrow(TypeError);
  });
});
