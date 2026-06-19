/**
 * Tests for the object form of the `parseBody` request option: per-content-type
 * allowlist/config, size caps, and the DDoS-hardening 413 path.
 */
import type { App } from "supertest/types";
import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import request from "supertest";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRequest, PayloadTooLargeError } from "../lib/BunRequest";
import { parseByteSize } from "../lib/utils/native";
import { makeRequest, testServer } from "./helpers";

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
