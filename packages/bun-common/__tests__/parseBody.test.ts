/**
 * Tests for the object form of the `parseBody` request option: per-content-type
 * allowlist/config, size caps, and the DDoS-hardening 413 path.
 */
import type { App } from "supertest/types";
import { Buffer } from "node:buffer";
import {
  brotliCompressSync,
  deflateRawSync,
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import request from "supertest";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRequest, PayloadTooLargeError } from "../lib/BunRequest";
import {
  compressionDictionaryHash,
  dictionaryCompressedHeader,
  parseByteSize,
} from "../lib/utils/native";
import { makeRequest, testServer } from "./helpers";

/** node:zlib's zstd compressor; `@types/node` does not declare `dictionary` for it. */
const zstdWithDictionary: (
  bytes: Uint8Array,
  options: { dictionary: Uint8Array; maxOutputLength?: number },
) => Buffer = zstdCompressSync;

/** A `dcz` body (RFC 9842 §5): the header, then `bytes` compressed against `dictionary`. */
function dczBody(bytes: Uint8Array, dictionary: Uint8Array): Buffer {
  return Buffer.concat([
    dictionaryCompressedHeader("dcz", compressionDictionaryHash(dictionary)),
    zstdWithDictionary(bytes, { dictionary }),
  ]);
}

/** `bytes` gzipped `count` times, and the `Content-Encoding` naming each layer. */
function gzipLayers(bytes: Uint8Array, count: number): [Buffer, string] {
  let body: Buffer = Buffer.from(bytes);
  for (let i = 0; i < count; i++) {
    body = gzipSync(body);
  }
  return [body, Array.from({ length: count }).fill("gzip").join(", ")];
}

describe("parseByteSize", () => {
  it("returns finite non-negative numbers unchanged", () => {
    expect(parseByteSize(0)).toBe(0);
    expect(parseByteSize(2048)).toBe(2048);
  });

  it("parses human byte strings (powers of 1024)", () => {
    expect(parseByteSize("100kb")).toBe(100 * 1024);
    expect(parseByteSize("5mb")).toBe(5 * 1024 * 1024);
    expect(parseByteSize("1.5gb")).toBe(Math.floor(1.5 * 1024 ** 3));
    expect(parseByteSize("512")).toBe(512);
    expect(parseByteSize("  2 KB ")).toBe(2048);
  });

  it("returns undefined for unparseable or negative values", () => {
    expect(parseByteSize(-1)).toBeUndefined();
    expect(parseByteSize(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(parseByteSize("abc")).toBeUndefined();
    expect(parseByteSize("10zb")).toBeUndefined();
  });
});

describe("PayloadTooLargeError", () => {
  it("carries statusCode 413 and the cap details", () => {
    const err = new PayloadTooLargeError(100, 250);
    expect(err.statusCode).toBe(413);
    expect(err.limit).toBe(100);
    expect(err.length).toBe(250);
    expect(err.message).toContain("100");
    expect(err.message).toContain("250");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("parseBody: object form — size caps", () => {
  it("applies a default 100kb cap when none is specified", async () => {
    const big = "x".repeat(200 * 1024);
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: big,
      options: { parseBody: { contentTypes: "all" } },
    });
    expect(req.isPayloadTooLarge).toBe(true);
    expect(req.payloadTooLarge?.limit).toBe(100 * 1024);
  });

  it("parses a body within the cap", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
      options: { parseBody: { maxContentLength: "1kb" } },
    });
    expect(req.isPayloadTooLarge).toBe(false);
    expect(req.body).toEqual({ a: 1 });
  });

  it("rejects a body whose Content-Length exceeds the cap before reading", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: "y".repeat(5000) }),
      options: { parseBody: { maxContentLength: "1kb" } },
    });
    expect(req.isPayloadTooLarge).toBe(true);
    expect(req.payloadTooLarge?.limit).toBe(1024);
    expect(req.body).toBeUndefined();
  });

  it("enforces the cap on a streamed body with no Content-Length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // 8kb in 1kb chunks — no Content-Length is set for a stream body.
        for (let i = 0; i < 8; i++) {
          controller.enqueue(new Uint8Array(1024));
        }
        controller.close();
      },
    });

    const nativeRequest = new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: stream,
      // Required for a streaming request body.
      duplex: "half",
    } as RequestInit);

    const req = await BunRequest.init(nativeRequest, testServer, {
      parseBody: { maxContentLength: "2kb", contentTypes: "all" },
    });
    expect(req.isPayloadTooLarge).toBe(true);
    expect(req.payloadTooLarge?.limit).toBe(2048);
  });

  it("honours a per-content-type maxContentLength override", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
      options: {
        parseBody: {
          maxContentLength: "10mb",
          contentTypes: { json: { maxContentLength: "5b" } },
        },
      },
    });
    expect(req.isPayloadTooLarge).toBe(true);
    expect(req.payloadTooLarge?.limit).toBe(5);
  });

  it("leaves boolean parseBody uncapped", async () => {
    const big = "z".repeat(300 * 1024);
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: big,
      options: { parseBody: true },
    });
    expect(req.isPayloadTooLarge).toBe(false);
    expect(req.body).toBe(big);
  });

  it("defaults raw bodies to a 10mb cap (above the 100kb default)", async () => {
    // 200kb of binary — over the 100kb default, but under the 10mb raw default.
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.alloc(200 * 1024),
      options: { parseBody: { contentTypes: "all" } },
    });
    expect(req.isPayloadTooLarge).toBe(false);
    expect(Buffer.isBuffer(req.body)).toBe(true);
    expect((req.body as Buffer).length).toBe(200 * 1024);
  });

  it("still rejects a non-multipart/raw body over the 100kb default", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "x".repeat(200 * 1024),
      options: { parseBody: { contentTypes: "all" } },
    });
    expect(req.isPayloadTooLarge).toBe(true);
    expect(req.payloadTooLarge?.limit).toBe(100 * 1024);
  });

  it("lets an explicit config-level cap override the per-kind raw default", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.alloc(50 * 1024),
      options: { parseBody: { maxContentLength: "10kb", contentTypes: "all" } },
    });
    expect(req.isPayloadTooLarge).toBe(true);
    expect(req.payloadTooLarge?.limit).toBe(10 * 1024);
  });
});

describe("parseBody: dynamic options", () => {
  it("parses a deferred body via parseBodyWithOptions", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
      options: { parseBody: false },
    });
    // parseBody was disabled at init — body untouched.
    expect(req.body).toBeUndefined();

    const parsed = await req.parseBodyWithOptions({ contentTypes: "all" });
    expect(parsed.contentType).toBe("json");
    expect(req.body).toEqual({ a: 1 });
  });

  it("applies a dynamically-set allowlist", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
      options: { parseBody: false },
    });
    // Only XML allowed → the JSON body is left as a raw buffer.
    await req.parseBodyWithOptions({ contentTypes: { xml: true } });
    expect(Buffer.isBuffer(req.body)).toBe(true);
    expect((req.body as Buffer).toString()).toBe(`{"a":1}`);
  });

  it("enforces a dynamically-set cap on a not-yet-read body", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "x".repeat(5000),
      options: { parseBody: false },
    });
    // parseBody throws on an oversized body; the 413 flag is still set.
    await expect(
      req.parseBodyWithOptions({
        maxContentLength: "1kb",
        contentTypes: "all",
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(req.isPayloadTooLarge).toBe(true);
    expect(req.payloadTooLarge?.limit).toBe(1024);
  });

  it("setParseBodyOptions returns the request for chaining", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
      options: { parseBody: false },
    });
    expect(req.setParseBodyOptions({ contentTypes: "all" })).toBe(req);
    await req.parseBody(true);
    expect(req.body).toEqual({ a: 1 });
  });
});

describe("parseBody: object form — contentTypes allowlist", () => {
  it('parses every kind when contentTypes is "all"', async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: "<a>1</a>",
      options: { parseBody: { contentTypes: "all", maxContentLength: "1mb" } },
    });
    expect(req.body).toEqual({ a: 1 });
  });

  it("treats an object contentTypes map as an allowlist", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: "<a>1</a>",
      options: { parseBody: { contentTypes: { json: true } } },
    });
    // XML is not in the allowlist → left as a raw buffer.
    expect(Buffer.isBuffer(req.body)).toBe(true);
    expect((req.body as Buffer).toString()).toBe("<a>1</a>");
  });

  it("disallows a kind explicitly set to false", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
      options: { parseBody: { contentTypes: { json: false } } },
    });
    expect(Buffer.isBuffer(req.body)).toBe(true);
    expect((req.body as Buffer).toString()).toBe(`{"a":1}`);
  });

  it("parses an allowed kind in the allowlist", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
      options: { parseBody: { contentTypes: { json: true } } },
    });
    expect(req.body).toEqual({ a: 1 });
  });
});

describe("parseBody: object form — per-content-type opts", () => {
  it("forwards XML parser opts via contentTypes.xml.opts", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: `<a x="1"><b>2</b></a>`,
      options: {
        parseBody: {
          contentTypes: { xml: { opts: { ignoreAttributes: true } } },
        },
      },
    });
    expect(req.body).toEqual({ a: { b: 2 } });
  });

  it("forwards a JSON reviver via contentTypes.json.opts", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1, b: 2 }),
      options: {
        parseBody: {
          contentTypes: {
            json: {
              opts: {
                reviver: (_key, value) =>
                  typeof value === "number" ? value * 10 : value,
              },
            },
          },
        },
      },
    });
    expect(req.body).toEqual({ a: 10, b: 20 });
  });
});

describe("parseBody: adapter 413 integration", () => {
  let adapter!: BunHttpAdapter;
  let app!: App;

  beforeAll(async () => {
    adapter = new BunHttpAdapter(30000, {
      router: { debug: false },
      request: { parseBody: { maxContentLength: "1kb", contentTypes: "all" } },
    });
    adapter.registerParserMiddleware(undefined, true);
    adapter.post("/echo", async (req, res) => {
      return res.json(req.body as Record<string, unknown>);
    });
    await adapter.listen(0);
    app = adapter as unknown as App;
  });

  afterAll(async () => {
    await adapter?.close();
  });

  it("returns 413 for an oversized body before the handler runs", async () => {
    const response = await request(app)
      .post("/echo")
      .set("Content-Type", "application/json")
      .send({ data: "q".repeat(5000) });

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({
      statusCode: 413,
      error: "Payload Too Large",
    });
  });

  it("processes a body within the cap normally", async () => {
    const payload = { name: "ok" };
    const response = await request(app)
      .post("/echo")
      .set("Content-Type", "application/json")
      .send(payload);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(payload);
  });
});

describe("parseBody: empty bodies (body-parser semantics)", () => {
  it("a declared empty JSON body is {}, and no body at all is undefined", async () => {
    const declared = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "0" },
      options: { parseBody: true },
    });
    expect(declared.body).toEqual({});

    const none = await makeRequest({
      headers: { "Content-Type": "application/json" },
      options: { parseBody: true },
    });
    expect(none.body).toBeUndefined();
  });
});

describe("handleBodyParsing: body-parser options", () => {
  const jsonPost = (body: string, headers: Record<string, string> = {}) =>
    makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });

  it("limit rejects a larger body with 413, even one already buffered", async () => {
    const req = await jsonPost('{"a":"0123456789"}');
    await expect(
      req.handleBodyParsing(true, { limit: 5 }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    await expect(
      req.handleBodyParsing(true, { limit: 5 }),
    ).rejects.toMatchObject({ status: 413, statusCode: 413 });
    expect(req.isPayloadTooLarge).toBe(true);

    const within = await jsonPost('{"a":1}');
    const buffer = await within.handleBodyParsing(true, { limit: "1kb" });
    expect(buffer?.toString()).toBe('{"a":1}');
  });

  it("returnBuffer: true resolves undefined when parseBody is off or the body was consumed", async () => {
    const off = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
      options: { parseBody: false },
    });
    expect(await off.handleBodyParsing(true)).toBeUndefined();

    const consumed = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
      options: { parseBody: false },
    });
    await consumed.request.text();
    consumed.setParseBodyOptions(true);
    expect(await consumed.handleBodyParsing(true)).toBeUndefined();
  });

  it("type (or the parser kind's default) skips a request that does not match", async () => {
    const req = await jsonPost('{"a":1}');
    expect(
      await req.handleBodyParsing(true, { type: "text/plain" }),
    ).toBeUndefined();
    expect(await req.handleBodyParsing(true, {}, "text")).toBeUndefined();
    expect((await req.handleBodyParsing(true, {}, "json"))?.toString()).toBe(
      '{"a":1}',
    );
    expect(
      await req.handleBodyParsing(true, { type: () => false }),
    ).toBeUndefined();
    expect(
      (
        await req.handleBodyParsing(true, { type: ["text/*", "json"] })
      )?.toString(),
    ).toBe('{"a":1}');
  });

  it("inflates a gzip body; inflate: false rejects an encoded body with 415", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      },
      body: Bun.gzipSync(Buffer.from('{"a":1}')),
    });
    expect(req.body).toEqual({ a: 1 });
    await expect(
      req.handleBodyParsing(true, { inflate: false }),
    ).rejects.toMatchObject({ statusCode: 415 });
  });
});

describe("Content-Encoding: decompression limits and errors", () => {
  const json = Buffer.from('{"a":1}');
  /** 10 MiB of zeros: a few KB gzipped, far past any sensible body limit. */
  const bomb = gzipSync(Buffer.alloc(10 * 1024 * 1024));

  /** A JSON request sent with `encoding`, parsed while it is built. */
  const encoded = (
    body: Uint8Array,
    encoding: string,
    parseBody: Parameters<BunRequest["setParseBodyOptions"]>[0] = true,
  ) =>
    makeRequest({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": encoding,
      },
      body,
      options: { parseBody },
    });

  /** The same request with its body still unread, for `handleBodyParsing`. */
  const unread = async (
    body: Uint8Array,
    encoding: string,
    parseBody: Parameters<BunRequest["setParseBodyOptions"]>[0] = true,
  ) => {
    const req = await encoded(body, encoding, false);
    req.setParseBodyOptions(parseBody);
    return req;
  };

  it("parses a gzip, deflate and br JSON body", async () => {
    for (const [encoding, body] of [
      ["gzip", gzipSync(json)],
      ["deflate", deflateSync(json)],
      ["br", brotliCompressSync(json)],
    ] as const) {
      const req = await encoded(body, encoding);
      expect(req.body).toEqual({ a: 1 });
    }
  });

  it("a gzip bomb inflating past the limit is a 413, on the fast path", async () => {
    const req = await encoded(bomb, "gzip", { maxContentLength: "64kb" });
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(req.isPayloadTooLarge).toBe(true);
    expect(req.payloadTooLarge?.limit).toBe(64 * 1024);
    expect(BunRequest.payloadTooLargeResponse(req).status).toBe(413);

    const later = await unread(bomb, "gzip");
    await expect(
      later.handleBodyParsing(true, { limit: "64kb" }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(later.isPayloadTooLarge).toBe(true);
  });

  it("a gzip bomb is a 413 with decompressionFastPathLimit: 0 (node:zlib, capped)", async () => {
    const req = await unread(bomb, "gzip");
    await expect(
      req.handleBodyParsing(true, {
        limit: "64kb",
        decompressionFastPathLimit: 0,
      }),
    ).rejects.toMatchObject({ status: 413, statusCode: 413 });
    expect(req.payloadTooLarge?.limit).toBe(64 * 1024);
  });

  it("a body inflating within the limit parses with either path", async () => {
    for (const decompressionFastPathLimit of [0, undefined]) {
      const req = await unread(gzipSync(json), "gzip");
      const buffer = await req.handleBodyParsing(true, {
        limit: "1kb",
        decompressionFastPathLimit,
      });
      expect(buffer?.toString()).toBe('{"a":1}');
      expect(req.body).toEqual({ a: 1 });
    }
  });

  it("corrupt gzip is a 400", async () => {
    const corrupt = Buffer.from(gzipSync(json));
    corrupt.fill(0xff, 10, 20);
    const req = await unread(corrupt, "gzip");
    await expect(req.handleBodyParsing(true)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("raw deflate sent as deflate is a 400", async () => {
    const req = await unread(deflateRawSync(json), "deflate");
    await expect(req.handleBodyParsing(true)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("an unsupported encoding (compress) is a 415", async () => {
    const req = await unread(json, "compress");
    await expect(req.handleBodyParsing(true)).rejects.toMatchObject({
      statusCode: 415,
      message: 'unsupported content encoding "compress"',
    });
  });

  it("a literal * Content-Encoding is not a wildcard: a 415", async () => {
    const req = await unread(json, "*");
    await expect(req.handleBodyParsing(true)).rejects.toMatchObject({
      statusCode: 415,
    });
  });

  it("parses a zstd body, and stacked codings decoded last to first", async () => {
    for (const [encoding, body] of [
      ["zstd", Bun.zstdCompressSync(json)],
      ["gzip, br", brotliCompressSync(gzipSync(json))],
      ["deflate, zstd", Bun.zstdCompressSync(deflateSync(json))],
      [" GZIP ,, identity, Br", brotliCompressSync(gzipSync(json))],
    ] as const) {
      expect((await encoded(body, encoding)).body).toEqual({ a: 1 });
      const later = await unread(body, encoding);
      expect((await later.handleBodyParsing(true))?.toString()).toBe('{"a":1}');
    }
  });

  it("a zstd bomb is a 413; truncated zstd is a 400, never a partial body", async () => {
    const zstdBomb = Bun.zstdCompressSync(Buffer.alloc(10 * 1024 * 1024));
    const req = await encoded(zstdBomb, "zstd", { maxContentLength: "64kb" });
    expect(req.isPayloadTooLarge).toBe(true);
    expect(req.payloadTooLarge?.limit).toBe(64 * 1024);

    const frame = Bun.zstdCompressSync(json);
    const truncated = await unread(frame.subarray(0, frame.length - 1), "zstd");
    await expect(truncated.handleBodyParsing(true)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(truncated.body).toBeUndefined();
  });

  it("a layer decoding past the limit is a 413 even when the outer layer fits", async () => {
    const req = await unread(brotliCompressSync(bomb), "gzip, br");
    await expect(
      req.handleBodyParsing(true, { limit: "64kb" }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("a corrupt inner layer is a 400", async () => {
    const corrupt = Buffer.from(gzipSync(json));
    corrupt.fill(0xff, 10, 20);
    const req = await unread(brotliCompressSync(corrupt), "gzip, br");
    await expect(req.handleBodyParsing(true)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("more stacked codings than maxContentCodings (default 5) is a 415, before decoding", async () => {
    const [six, sixHeader] = gzipLayers(json, 6);
    const refused = await unread(six, sixHeader);
    await expect(refused.handleBodyParsing(true)).rejects.toMatchObject({
      statusCode: 415,
      message: "too many content encodings (6, at most 5)",
    });

    const raised = await unread(six, sixHeader);
    expect(
      (
        await raised.handleBodyParsing(true, { maxContentCodings: 6 })
      )?.toString(),
    ).toBe('{"a":1}');

    const [two, twoHeader] = gzipLayers(json, 2);
    const lowered = await unread(two, twoHeader);
    await expect(
      lowered.handleBodyParsing(true, { maxContentCodings: 1 }),
    ).rejects.toMatchObject({ statusCode: 415 });

    const invalid = await unread(two, twoHeader);
    await expect(
      invalid.handleBodyParsing(true, { maxContentCodings: -1 }),
    ).rejects.toThrow(RangeError);
  });

  it("encodings: a coding outside the allowlist is a 415, in any layer", async () => {
    const onlyBr = await unread(brotliCompressSync(json), "br");
    await expect(
      onlyBr.handleBodyParsing(true, { encodings: ["gzip"] }),
    ).rejects.toMatchObject({
      statusCode: 415,
      message: 'unsupported content encoding "br"',
    });

    const stacked = await unread(
      brotliCompressSync(gzipSync(json)),
      "gzip, br",
    );
    await expect(
      stacked.handleBodyParsing(true, { encodings: ["gzip"] }),
    ).rejects.toMatchObject({ statusCode: 415 });

    const alias = await unread(gzipSync(json), "x-gzip");
    await alias.handleBodyParsing(true, { encodings: ["gzip"] });
    expect(alias.body).toEqual({ a: 1 });

    const wildcard = await unread(Bun.zstdCompressSync(json), "zstd");
    await wildcard.handleBodyParsing(true, { encodings: ["gzip", "*"] });
    expect(wildcard.body).toEqual({ a: 1 });

    const misspelt = await unread(gzipSync(json), "gzip");
    await expect(
      misspelt.handleBodyParsing(true, { encodings: ["gzpi" as never] }),
    ).rejects.toThrow(RangeError);
  });

  it("compressionDictionaries: dcz decodes with its dictionary, is a 400 without it, a 415 with none", async () => {
    const dictionary = Buffer.from('{"a":1,"dictionary":"shared"}');
    const body = dczBody(json, dictionary);

    const decoded = await unread(body, "dcz");
    await decoded.handleBodyParsing(true, {
      compressionDictionaries: [dictionary],
    });
    expect(decoded.body).toEqual({ a: 1 });

    const unknown = await unread(body, "dcz");
    await expect(
      unknown.handleBodyParsing(true, {
        compressionDictionaries: [Buffer.from("another")],
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "unknown compression dictionary",
    });

    const none = await unread(body, "dcz");
    await expect(none.handleBodyParsing(true)).rejects.toMatchObject({
      statusCode: 415,
    });

    const invalid = await unread(body, "dcz");
    await expect(
      invalid.handleBodyParsing(true, {
        compressionDictionaries: "shared" as never,
      }),
    ).rejects.toThrow(TypeError);
  });

  it("inflate: false refuses an unread gzip body with a 415", async () => {
    const req = await unread(gzipSync(json), "gzip");
    await expect(
      req.handleBodyParsing(true, { inflate: false }),
    ).rejects.toMatchObject({ statusCode: 415 });
  });
});

describe("Content-Encoding: parseBody's decoding options, applied while the request is built", () => {
  const json = Buffer.from('{"a":1}');

  /** A JSON request sent with `encoding`, parsed by `init` with `parseBody`. */
  const built = (
    body: Uint8Array,
    encoding: string,
    parseBody: Parameters<BunRequest["setParseBodyOptions"]>[0],
  ) =>
    makeRequest({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": encoding,
      },
      body,
      options: { parseBody },
    });

  it("parseBody.inflate: false refuses a gzip body at init, recorded as bodyDecodingError (415)", async () => {
    const req = await built(gzipSync(json), "gzip", { inflate: false });
    expect(req.body).toBeUndefined();
    expect(req.isPayloadTooLarge).toBe(false);
    expect(req.bodyDecodingError).toMatchObject({
      status: 415,
      statusCode: 415,
      expose: true,
      message: "content encoding unsupported",
    });
  });

  it("parseBody.inflate: false still parses an identity body", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: json,
      options: { parseBody: { inflate: false } },
    });
    expect(req.body).toEqual({ a: 1 });
    expect(req.bodyDecodingError).toBeUndefined();
  });

  it("records a 400 for a corrupt stream and a 415 for an unsupported coding at init", async () => {
    const corrupt = Buffer.from(gzipSync(json));
    corrupt.fill(0xff, 10, 20);
    expect((await built(corrupt, "gzip", {})).bodyDecodingError?.status).toBe(
      400,
    );
    expect((await built(json, "compress", {})).bodyDecodingError?.status).toBe(
      415,
    );
  });

  it("parseBody.encodings, maxContentCodings and compressionDictionaries reach the init parse", async () => {
    expect((await built(Bun.zstdCompressSync(json), "zstd", {})).body).toEqual({
      a: 1,
    });

    const onlyGzip = { encodings: ["gzip"] } as const;
    expect((await built(gzipSync(json), "gzip", onlyGzip)).body).toEqual({
      a: 1,
    });
    const refused = await built(brotliCompressSync(json), "br", onlyGzip);
    expect(refused.body).toBeUndefined();
    expect(refused.bodyDecodingError).toMatchObject({
      status: 415,
      message: 'unsupported content encoding "br"',
    });

    const [two, twoHeader] = gzipLayers(json, 2);
    const tooDeep = await built(two, twoHeader, { maxContentCodings: 1 });
    expect(tooDeep.bodyDecodingError?.status).toBe(415);
    expect((await built(two, twoHeader, {})).body).toEqual({ a: 1 });

    const dictionary = Buffer.from('{"a":1,"dictionary":"shared"}');
    const dcz = dczBody(json, dictionary);
    expect(
      (await built(dcz, "dcz", { compressionDictionaries: [dictionary] })).body,
    ).toEqual({ a: 1 });
    expect((await built(dcz, "dcz", {})).bodyDecodingError?.status).toBe(415);
    expect(
      (
        await built(dcz, "dcz", {
          compressionDictionaries: [Buffer.from("another")],
        })
      ).bodyDecodingError,
    ).toMatchObject({ status: 400, message: "unknown compression dictionary" });
  });

  it("an invalid encodings, maxContentCodings or compressionDictionaries is a misconfiguration at init", async () => {
    await expect(
      built(gzipSync(json), "gzip", { encodings: ["gzpi" as never] }),
    ).rejects.toThrow(RangeError);
    await expect(
      built(gzipSync(json), "gzip", { maxContentCodings: Number.NaN }),
    ).rejects.toThrow(RangeError);
    await expect(
      built(gzipSync(json), "gzip", { compressionDictionaries: {} as never }),
    ).rejects.toThrow(TypeError);
  });

  it("a request with no body is never refused for its Content-Encoding", async () => {
    const req = await makeRequest({
      headers: { "Content-Encoding": "gzip" },
      options: { parseBody: { inflate: false } },
    });
    expect(req.bodyDecodingError).toBeUndefined();
    expect(req.body).toBeUndefined();
  });

  it("the object form without inflate, and parseBody: true, still inflate", async () => {
    for (const parseBody of [true, {}, { inflate: true }] as const) {
      const req = await built(gzipSync(json), "gzip", parseBody);
      expect(req.body).toEqual({ a: 1 });
      expect(req.bodyDecodingError).toBeUndefined();
    }
  });

  it("parseBody.decompressionFastPathLimit reaches the init parse: a bomb is a 413 by node:zlib", async () => {
    const bomb = gzipSync(Buffer.alloc(10 * 1024 * 1024));
    const gunzip = spyOn(Bun, "gunzipSync");
    try {
      // Control: by default the bomb's worst case fits the 32 MiB fast path,
      // so Bun's own decoder runs (and the size is checked afterwards).
      const fast = await built(bomb, "gzip", { maxContentLength: "64kb" });
      expect(fast.isPayloadTooLarge).toBe(true);
      expect(gunzip).toHaveBeenCalledTimes(1);
      gunzip.mockClear();

      const req = await built(bomb, "gzip", {
        maxContentLength: "64kb",
        decompressionFastPathLimit: 0,
      });
      expect(req.isPayloadTooLarge).toBe(true);
      expect(req.payloadTooLarge?.limit).toBe(64 * 1024);
      // `0` disables Bun's uncapped decoder: node:zlib stopped at the limit.
      expect(gunzip).not.toHaveBeenCalled();
    } finally {
      gunzip.mockRestore();
    }
  });

  it("setParseBodyOptions re-resolves the decoding options, back to the defaults when omitted", async () => {
    const req = await built(gzipSync(json), "gzip", false);
    req.setParseBodyOptions({ inflate: false });
    await expect(req.parseBody()).rejects.toMatchObject({ statusCode: 415 });

    const reset = await built(gzipSync(json), "gzip", false);
    reset.setParseBodyOptions({ inflate: false });
    reset.setParseBodyOptions({});
    expect((await reset.parseBody()).body).toEqual({ a: 1 });
  });

  it("a decompressionFastPathLimit that is not a non-negative number is a RangeError", async () => {
    const req = await built(gzipSync(json), "gzip", false);
    for (const decompressionFastPathLimit of [-1, Number.NaN]) {
      expect(() =>
        req.setParseBodyOptions({ decompressionFastPathLimit }),
      ).toThrow(RangeError);
      await expect(
        req.handleBodyParsing(true, { decompressionFastPathLimit }),
      ).rejects.toBeInstanceOf(RangeError);
    }
  });
});
