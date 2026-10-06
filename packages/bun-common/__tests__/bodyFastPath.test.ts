import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRequest } from "../lib/BunRequest";
import { testServer } from "./helpers";

/**
 * A body the constructor can read in one native call (no cap to enforce while
 * it streams, not multipart) is read with `arrayBuffer()` and parsed
 * synchronously, skipping `parseBody()`. These tests run every case both ways —
 * the fast path, and the general path forced by a subclass overriding
 * `parseBody` — and require the same observable state.
 */

/** Overriding `parseBody` sends the constructor down the general path. */
class GeneralPath extends BunRequest {
  /** How many times the constructor's read came through here. */
  static calls = 0;
  override parseBody(fresh = false) {
    GeneralPath.calls++;
    return super.parseBody(fresh);
  }
}

interface Case {
  name: string;
  body?: RequestInit["body"];
  headers?: Record<string, string>;
  options?: ConstructorParameters<typeof BunRequest>[2];
}

/** Everything a handler can see of the body, as a comparable value. */
async function observe(
  Impl: new (...args: ConstructorParameters<typeof BunRequest>) => BunRequest,
  { body, headers, options }: Case,
): Promise<unknown> {
  const req = new Impl(
    new Request("http://h/p", { method: "POST", body, headers }),
    testServer,
    { parseCookies: false, parseQuery: false, ...options } as never,
  );
  const events: [string, string][] = [];
  req.on("data", (chunk: Uint8Array) => {
    events.push(["data", new TextDecoder().decode(chunk)]);
  });
  req.on("end", () => {
    events.push(["end", ""]);
  });
  req.on("error", (error: unknown) => {
    events.push(["error", (error as Error).message]);
  });
  const settled = await req.ready();
  await Promise.resolve();
  const value = req.body as unknown;
  return {
    body: Buffer.isBuffer(value) ? `<Buffer ${value.toString("hex")}>` : value,
    bodyIsBuffer: Buffer.isBuffer(value),
    buffer: req.buffer ? req.buffer.toString("hex") : req.buffer,
    bufferIsBuffer: Buffer.isBuffer(req.buffer),
    parsed: req.isBodyParsed,
    complete: req.complete,
    tooLarge: req.payloadTooLarge,
    decoding: req.bodyDecodingError
      ? [req.bodyDecodingError.status, req.bodyDecodingError.message]
      : undefined,
    settled: settled.map((entry) => entry.status),
    events,
  };
}

const json = JSON.stringify({ n: 7, nested: { list: [1, "two", null] } });

const CASES: Case[] = [
  { name: "JSON", body: json, headers: { "content-type": "application/json" } },
  {
    name: "+json suffix",
    body: json,
    headers: { "content-type": "application/vnd.api+json; charset=utf-8" },
  },
  {
    name: "JSON with a reviver",
    body: json,
    headers: { "content-type": "application/json" },
    options: {
      parseBody: {
        contentTypes: {
          json: {
            opts: {
              reviver: (_key: string, value: unknown) =>
                typeof value === "number" ? value * 10 : value,
            },
          },
        },
      },
    },
  },
  {
    name: "invalid JSON",
    body: "{nope",
    headers: { "content-type": "application/json" },
  },
  {
    name: "empty JSON body",
    body: "",
    headers: { "content-type": "application/json", "content-length": "0" },
  },
  {
    name: "non-ASCII JSON",
    body: JSON.stringify({ s: "héllo ✓ 😀" }),
    headers: { "content-type": "application/json" },
  },
  {
    name: "invalid UTF-8 keeps its raw bytes",
    body: new Uint8Array([0x22, 0xff, 0xfe, 0x22]),
    headers: { "content-type": "application/json" },
  },
  {
    name: "urlencoded",
    body: "a=1&b[c]=2&r=1&r=2",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  },
  {
    name: "text, latin1",
    body: new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
    headers: { "content-type": "text/plain" },
    options: {
      parseBody: { contentTypes: { text: { opts: { encoding: "latin1" } } } },
    },
  },
  {
    name: "xml",
    body: "<a><b>1</b></a>",
    headers: { "content-type": "application/xml" },
  },
  {
    name: "octet-stream",
    body: new Uint8Array([1, 2, 3]),
    headers: { "content-type": "application/octet-stream" },
  },
  { name: "no content type, JSON-looking", body: json },
  { name: "no content type, form-looking", body: "a=1&b=2" },
  {
    name: "unknown media type",
    body: "x",
    headers: { "content-type": "application/x-custom" },
  },
  {
    name: "JSON kind disallowed",
    body: json,
    headers: { "content-type": "application/json" },
    options: { parseBody: { contentTypes: { text: true } } },
  },
  {
    name: "gzip JSON",
    body: gzipSync(json),
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
  },
  {
    name: "corrupt gzip",
    body: new Uint8Array([1, 2, 3, 4]),
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
  },
  {
    name: "refused coding",
    body: json,
    headers: { "content-type": "application/json", "content-encoding": "br" },
    options: { parseBody: { encodings: ["gzip"] } },
  },
  {
    name: "within a declared cap",
    body: json,
    headers: {
      "content-type": "application/json",
      "content-length": String(json.length),
    },
    // Kept as bytes: this suite compares the byte path with parseBody().
    options: { parseBody: { maxContentLength: 1000 }, retainBuffer: true },
  },
  {
    name: "declared over the cap",
    body: json,
    headers: {
      "content-type": "application/json",
      "content-length": String(json.length),
    },
    options: { parseBody: { maxContentLength: 10 } },
  },
  {
    name: "gzip within the cap that inflates past it",
    body: gzipSync("x".repeat(5000)),
    headers: { "content-type": "text/plain", "content-encoding": "gzip" },
    options: { parseBody: { maxContentLength: 1000 } },
  },
  {
    name: "a declared length smaller than the body, under a cap",
    body: "x".repeat(200),
    headers: { "content-type": "text/plain", "content-length": "5" },
    options: { parseBody: { maxContentLength: 100 } },
  },
];

describe("BunRequest body fast path: same state as parseBody()", () => {
  for (const testCase of CASES) {
    it(testCase.name, async () => {
      const fast = await observe(BunRequest, testCase);
      const before = GeneralPath.calls;
      const general = await observe(GeneralPath, testCase);
      // The control really took the general path.
      expect(GeneralPath.calls).toBe(before + 1);
      expect(fast).toEqual(general);
    });
  }

  it("parses a JSON body as JSON.parse does, into a Buffer-backed request", async () => {
    const req = await BunRequest.init(
      new Request("http://h/", {
        method: "POST",
        body: json,
        headers: { "content-type": "application/json" },
      }),
      testServer,
      { parseBody: true, parseCookies: false, parseQuery: false },
    );
    expect(req.body).toEqual(JSON.parse(json));
    expect(Buffer.isBuffer(req.buffer)).toBe(true);
    expect(req.buffer!.toString()).toBe(json);
    expect(req.complete).toBe(true);
    // A second parse returns the cached result without reading again.
    expect((await req.parseBody()).body).toBe(req.body);
  });

  it("a declared length that understates the body is still caught by the cap", async () => {
    const req = await BunRequest.init(
      new Request("http://h/", {
        method: "POST",
        body: "x".repeat(200),
        headers: { "content-type": "text/plain", "content-length": "5" },
      }),
      testServer,
      { parseBody: { maxContentLength: 100 }, parseCookies: false },
    );
    expect(req.isPayloadTooLarge).toBe(true);
    expect(req.body).toBeUndefined();
  });
});

describe("served over a socket", () => {
  it("parses JSON, answers 413 over the cap, and streams a chunked body under it", async () => {
    const app = new BunHttpAdapter(0, {
      request: { parseBody: { maxContentLength: 64 } },
    });
    app.post("/echo", (req, res) => res.json(req.body ?? null));
    const server = await app.listen(0);
    const url = `http://127.0.0.1:${server.port}/echo`;
    try {
      const ok = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"n":7}',
      });
      expect([ok.status, await ok.json()]).toEqual([200, { n: 7 }]);

      const big = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ v: "x".repeat(200) }),
      });
      expect(big.status).toBe(413);

      // No Content-Length: the general, streamed read enforces the cap.
      const chunks = (parts: string[]) =>
        new ReadableStream({
          start(controller) {
            for (const part of parts) {
              controller.enqueue(new TextEncoder().encode(part));
            }
            controller.close();
          },
        });
      const streamed = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chunks(['{"a":', "1}"]),
      });
      expect([streamed.status, await streamed.json()]).toEqual([200, { a: 1 }]);
      const streamedBig = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chunks(["[", '"x",'.repeat(40), '"x"]']),
      });
      expect(streamedBig.status).toBe(413);
    } finally {
      await app.close();
    }
  });
});
