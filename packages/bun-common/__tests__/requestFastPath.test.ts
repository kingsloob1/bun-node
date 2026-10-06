import type { BunRequestCookies } from "../lib/BunRequest";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "bun:test";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRequest } from "../lib/BunRequest";
import { testServer } from "./helpers";

/**
 * The bodiless-request fast path (PR-2 of docs/plans/bun-native-routes.md):
 * a request with no body finishes its parse while it is built, so
 * `BunRequest.init` returns it without a promise. It must reach exactly the
 * state the full read reaches, which these tests take from the same request
 * forced down the full path (an empty body *stream*, which the fast path
 * leaves alone).
 */

const OPTIONS = { parseBody: true, parseCookies: true, parseQuery: true };

/** A bodiless request: no stream, no `Content-Length`, no `Transfer-Encoding`. */
function bodiless(
  url: string,
  headers?: Record<string, string>,
  method = "GET",
) {
  return new Request(url, { method, headers });
}

/** The same request with an empty body stream, which takes the full read. */
function emptyStream(
  url: string,
  headers?: Record<string, string>,
  method = "POST",
) {
  return new Request(url, {
    method,
    headers,
    body: new ReadableStream({ start: (controller) => controller.close() }),
  });
}

/** Everything a handler can observe about the parsed request. */
async function observe(req: BunRequest) {
  const events: string[] = [];
  req.on("data", () => events.push("data"));
  req.on("end", () => events.push("end"));
  req.on("error", () => events.push("error"));
  const settled = await req.ready();
  // Body events are flushed on a microtask after a listener is attached.
  await Promise.resolve();
  await Promise.resolve();
  return {
    body: req.body,
    bufferLength: req.buffer?.length,
    isBufferInstance: Buffer.isBuffer(req.buffer),
    isBodyParsed: req.isBodyParsed,
    complete: req.complete,
    query: req.query,
    cookies: req.cookies,
    signedCookies: req.signedCookies,
    isPayloadTooLarge: req.isPayloadTooLarge,
    bodyDecodingError: req.bodyDecodingError,
    settled: settled.map((result) =>
      result.status === "fulfilled"
        ? { status: result.status, value: result.value }
        : { status: result.status },
    ),
    events,
    // A later explicit parse returns the stored result.
    reparsed: await req.parseBody(),
  };
}

describe("BunRequest: bodiless fast path", () => {
  it("returns the request synchronously when nothing is left to read", () => {
    const created = BunRequest.init(
      bodiless("http://localhost/a?x=1&y=2", { cookie: "a=1; b=j:[1]" }),
      testServer,
      OPTIONS,
    );
    expect(created).toBeInstanceOf(BunRequest);
    const req = created as BunRequest;
    expect(req.query).toEqual({ x: "1", y: "2" });
    expect(req.cookies).toEqual({ a: "1", b: [1] });
    expect(req.body).toBeUndefined();
    expect(req.complete).toBe(true);
    expect(req.isBodyParsed).toBe(true);
  });

  it("still returns a promise when a body has to be read", () => {
    const created = BunRequest.init(
      new Request("http://localhost/a", { method: "POST", body: "{}" }),
      testServer,
      OPTIONS,
    );
    expect(created).toBeInstanceOf(Promise);
  });

  for (const [label, headers] of [
    ["no headers", undefined],
    ["a query, cookies and a signed cookie", { cookie: "a=1; s=s:v.bad" }],
    ["a JSON content type but no body", { "content-type": "application/json" }],
    ["a content encoding but no body", { "content-encoding": "gzip" }],
  ] as const) {
    it(`reaches the full read's state: ${label}`, async () => {
      const url = "http://localhost/p?q=1&arr=a&arr=b";
      const options = { ...OPTIONS, cookieSecret: "secret" };
      const fast = BunRequest.init(
        bodiless(url, headers, "POST"),
        testServer,
        options,
      );
      expect(fast).toBeInstanceOf(BunRequest);
      const full = await BunRequest.init(
        emptyStream(url, headers),
        testServer,
        options,
      );
      expect(await observe(fast as BunRequest)).toEqual(await observe(full));
      // Reading an absent body never marks it used (nor does the fast path);
      // reading the empty stream does, so that one field is checked apart.
      expect((fast as BunRequest).request.bodyUsed).toBe(false);
    });
  }

  it("leaves a request with a Content-Length to the full read", async () => {
    // `Content-Length: 0` is a body to type-is: JSON gives `{}`, not `undefined`.
    const req = await BunRequest.init(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "0" },
      }),
      testServer,
      OPTIONS,
    );
    expect(req.body).toEqual({});
  });

  it("ready() reports the query, body and cookie tasks in order", async () => {
    const req = BunRequest.init(
      bodiless("http://localhost/?k=v", { cookie: "c=1" }),
      testServer,
      OPTIONS,
    ) as BunRequest;
    const settled = await req.ready();
    expect(settled.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    const values = settled.map((result) =>
      result.status === "fulfilled" ? result.value : undefined,
    );
    expect(values[0]).toEqual({ k: "v" });
    expect(values[1]).toBeUndefined();
    expect((values[2] as BunRequestCookies).cookies).toEqual({ c: "1" });
  });

  it("serves bodiless and bodied requests alike through the adapter", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.use((req, _res, next) => {
      req.on("end", () => {});
      next();
    });
    adapter.all("/echo", (req, res) => {
      res.json({
        method: req.method,
        body: req.body ?? null,
        query: req.query,
        complete: req.complete,
      });
    });
    const get = await adapter.fetch("/echo?a=1");
    expect(await get.json()).toEqual({
      method: "GET",
      body: null,
      query: { a: "1" },
      complete: true,
    });
    const post = await adapter.fetch("/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ n: 7 }),
    });
    expect(await post.json()).toEqual({
      method: "POST",
      body: { n: 7 },
      query: {},
      complete: true,
    });
  });
});
