import { gzipSync } from "node:zlib";
import { describe, expect, it } from "bun:test";
import { requestParsing } from "../lib";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRequest } from "../lib/BunRequest";
import { testServer } from "./helpers";

/**
 * A body parser registered on the adapter (`useBodyParser`,
 * `registerParserMiddleware` — what Nest calls) passes a request with no body
 * on synchronously, before its type, encoding or size, as body-parser's
 * `read()` does (`if (!hasBody(req)) { next(); return }`).
 */

/** Exposes the adapter's served request path to the test. */
class Probe extends BunHttpAdapter {
  serve(request: Request) {
    return this.serveNativeRequest(request, {
      requestIP: () => null,
      upgrade: () => false,
    } as never);
  }
}

describe("BunRequest.hasBody", () => {
  const build = (init?: RequestInit) =>
    BunRequest.init(new Request("http://h/", init), testServer, {
      parseBody: false,
    }) as BunRequest;

  it("is false with no body, no Content-Length and no Transfer-Encoding", () => {
    expect(build().hasBody).toBe(false);
    expect(build({ method: "DELETE" }).hasBody).toBe(false);
    // A type alone is not a body (type-is's hasBody).
    expect(
      build({ headers: { "content-type": "application/json" } }).hasBody,
    ).toBe(false);
  });

  it("is true for a declared length — 0 included — or a chunked body", () => {
    expect(
      build({ method: "POST", headers: { "content-length": "0" }, body: "" })
        .hasBody,
    ).toBe(true);
    expect(
      build({
        method: "POST",
        headers: { "transfer-encoding": "chunked" },
        body: "x",
      }).hasBody,
    ).toBe(true);
  });

  it("is true for an in-process Request that has a body and no length header", () => {
    expect(build({ method: "POST", body: "x" }).hasBody).toBe(true);
  });
});

describe("body parser middleware: a request with no body", () => {
  for (const [name, register] of [
    [
      "useBodyParser",
      (app: BunHttpAdapter) => app.useBodyParser("json", true, {}),
    ],
    [
      "registerParserMiddleware",
      (app: BunHttpAdapter) => app.registerParserMiddleware(undefined, true),
    ],
  ] as const) {
    it(`is passed on synchronously by ${name}`, async () => {
      const app = new Probe(0);
      register(app);
      app.get("/g", (req, res) => {
        res.json({ body: req.body ?? null, rawBody: req.rawBody ?? null });
      });
      const served = app.serve(new Request("http://localhost/g"));
      // No promise anywhere: the parser did not wait on one.
      expect(served).toBeInstanceOf(Response);
      // body-parser sets rawBody (its verify hook) only for a body it read.
      expect(await (served as Response).json()).toEqual({
        body: null,
        rawBody: null,
      });
    });
  }

  it("never looks at its encoding or type, as body-parser does not", async () => {
    const app = new BunHttpAdapter(0);
    app.useBodyParser("json", false, {
      inflate: false,
      type: () => {
        throw new Error("type checked for a bodiless request");
      },
    });
    app.get("/g", (_req, res) => res.send("ok"));
    const response = await app.fetch("/g", {
      headers: {
        "content-encoding": "gzip",
        "content-type": "application/json",
      },
    });
    expect([response.status, await response.text()]).toEqual([200, "ok"]);
  });

  it("still parses, caps and refuses a request that has one", async () => {
    const app = new BunHttpAdapter(0, { request: { deferBody: true } });
    app.useBodyParser("json", true, { limit: 64, inflate: false });
    app.post("/p", (req, res) => {
      res.json({ body: req.body, raw: req.rawBody?.toString() });
    });
    const ok = await app.fetch("/p", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
    expect(await ok.json()).toEqual({ body: { a: 1 }, raw: '{"a":1}' });
    const big = await app.fetch("/p", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: "x".repeat(100) }),
    });
    expect(big.status).toBe(413);
    const gzipped = await app.fetch("/p", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: gzipSync('{"a":1}'),
    });
    expect(gzipped.status).toBe(415);
  });
});

describe("parseBody: false is the master switch", () => {
  const post = (app: BunHttpAdapter, path: string, body: string) =>
    app.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

  it("a registered parser parses nothing, and applies no limit, while it is off", async () => {
    const app = new BunHttpAdapter(0, { request: { parseBody: false } });
    app.useBodyParser("json", true, { limit: 8 });
    app.registerParserMiddleware(undefined, true);
    app.post("/x", (req, res) => {
      res.json({ body: req.body ?? null, raw: req.rawBody ?? null });
    });
    const response = await post(
      app,
      "/x",
      JSON.stringify({ big: "x".repeat(50) }),
    );
    expect([response.status, await response.json()]).toEqual([
      200,
      { body: null, raw: null },
    ]);
  });

  it("requestParsing() turns it on for its routes, and a parser after it then runs", async () => {
    const app = new BunHttpAdapter(0, { request: { parseBody: false } });
    app.use("/on", requestParsing({ parseBody: { maxContentLength: 64 } }));
    app.useBodyParser("json", true, { limit: 32 });
    app.post("/on/x", (req, res) => {
      res.json({
        body: req.body ?? null,
        raw: req.rawBody?.toString() ?? null,
      });
    });
    app.post("/off", (req, res) => res.json({ body: req.body ?? null }));
    expect(await (await post(app, "/on/x", '{"a":1}')).json()).toEqual({
      body: { a: 1 },
      raw: '{"a":1}',
    });
    // Over the parser's own limit, now that it parses.
    expect(
      (await post(app, "/on/x", JSON.stringify({ v: "x".repeat(30) }))).status,
    ).toBe(413);
    // Other routes stay off.
    expect(await (await post(app, "/off", '{"a":1}')).json()).toEqual({
      body: null,
    });
  });
});
