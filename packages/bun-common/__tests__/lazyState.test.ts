import { gzipSync } from "node:zlib";
import { describe, expect, it } from "bun:test";
import { requestParsing, validateParseBodyOption } from "../lib";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRequest } from "../lib/BunRequest";
import { BunResponse } from "../lib/BunResponse";
import { makeRequest, makeResponse, testServer } from "./helpers";

/**
 * Rarely-read request and response state lives in a holder created on first
 * write, and the `parseBody` config is resolved only for a request that has a
 * body. Neither may be observable: defaults read the same, writes stick to
 * their own object, and a misconfiguration still fails where it is set.
 */

describe("BunRequest: lazily-held state", () => {
  it("reads the documented defaults before anything is written", async () => {
    const req = await makeRequest();
    expect(req.rawBody).toBeUndefined();
    expect(req.maxHeadersCount).toBe(0);
    expect(req.reusedSocket).toBe(false);
    expect(req.payloadTooLarge).toBeUndefined();
    expect(req.isPayloadTooLarge).toBe(false);
    expect(req.bodyDecodingError).toBeUndefined();
    expect(req.storageFiles).toEqual([]);
    expect(req.subdomains).toEqual([]);
  });

  it("keeps a write on its own request", async () => {
    const a = await makeRequest();
    const b = await makeRequest();
    a.maxHeadersCount = 50;
    a.reusedSocket = true;
    a.setHeader("x-a", "1");
    expect([a.maxHeadersCount, a.reusedSocket]).toEqual([50, true]);
    expect([b.maxHeadersCount, b.reusedSocket]).toEqual([0, false]);
    expect(a.headers["x-a"]).toBe("1");
    expect(b.headers["x-a"]).toBeUndefined();
  });

  it("derives headers and the parsed URL on first read, from the request", async () => {
    const req = await makeRequest({
      url: "http://api.example.com/p?q=1",
      headers: { "X-One": "1" },
    });
    expect(req.headers["x-one"]).toBe("1");
    expect(req.parsedUrl.pathname).toBe("/p");
    expect(req.parsedUrl).toBe(req.parsedUrl);
  });

  it("emits request events through a lazily created emitter", async () => {
    const req = await makeRequest({ method: "POST", body: "hello" });
    const seen: string[] = [];
    req.on("data", (chunk: Uint8Array) => {
      seen.push(new TextDecoder().decode(chunk));
    });
    await new Promise<void>((resolve) => req.on("end", () => resolve()));
    expect(seen.join("")).toBe("hello");
  });
});

describe("BunRequest: the parseBody config is resolved only for a body", () => {
  const badEncodings = { encodings: ["gzpi" as never] };

  it("a bodiless request never resolves it", async () => {
    const req = await BunRequest.init(new Request("http://h/"), testServer, {
      parseBody: badEncodings,
    });
    expect(req.body).toBeUndefined();
  });

  it("a request with a body resolves it at init, and caps apply", async () => {
    expect(() =>
      BunRequest.init(
        new Request("http://h/", {
          method: "POST",
          headers: { "content-encoding": "gzip" },
          body: gzipSync("{}"),
        }),
        testServer,
        { parseBody: badEncodings },
      ),
    ).toThrow(RangeError);

    const capped = await BunRequest.init(
      new Request("http://h/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ big: "x".repeat(100) }),
      }),
      testServer,
      { parseBody: { maxContentLength: 10 } },
    );
    expect(capped.isPayloadTooLarge).toBe(true);
  });

  it("a deferred body resolves it at init too", async () => {
    expect(() =>
      BunRequest.init(
        new Request("http://h/", { method: "POST", body: "x" }),
        testServer,
        { parseBody: badEncodings, deferBody: true },
      ),
    ).toThrow(RangeError);
  });

  it("resolves the per-request options, not a stale copy", async () => {
    const app = new BunHttpAdapter(0, {
      request: { parseBody: { maxContentLength: 10 }, deferBody: true },
    });
    app.use("/big", requestParsing({ parseBody: { maxContentLength: "1kb" } }));
    app.post("/big", (req, res) => res.json(req.body));
    app.post("/small", (req, res) => res.json(req.body));
    const body = JSON.stringify({ v: "x".repeat(100) });
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    };
    expect((await app.fetch("/big", init)).status).toBe(200);
    expect((await app.fetch("/small", init)).status).toBe(413);
  });
});

describe("parseBody misconfiguration fails where it is configured", () => {
  it("validateParseBodyOption throws for invalid decoding options", () => {
    expect(() =>
      validateParseBodyOption({ encodings: ["gzpi" as never] }),
    ).toThrow(RangeError);
    expect(() =>
      validateParseBodyOption({ maxContentCodings: Number.NaN }),
    ).toThrow(RangeError);
    expect(() =>
      validateParseBodyOption({ compressionDictionaries: {} as never }),
    ).toThrow(TypeError);
    expect(() => validateParseBodyOption(true)).not.toThrow();
    expect(() => validateParseBodyOption(undefined)).not.toThrow();
    expect(() =>
      validateParseBodyOption({ encodings: ["gzip"], maxContentCodings: 2 }),
    ).not.toThrow();
  });

  it("rejects a size that does not parse, instead of ignoring it", () => {
    for (const bad of ["lots", "-5", "1.5 parsecs", -5, Number.NaN, Infinity]) {
      expect(() =>
        validateParseBodyOption({ maxContentLength: bad as never }),
      ).toThrow(/parseBody\.maxContentLength must be/);
      expect(() =>
        validateParseBodyOption({
          contentTypes: { json: { maxContentLength: bad as never } },
        }),
      ).toThrow(/parseBody\.contentTypes\.json\.maxContentLength must be/);
    }
    for (const good of [0, 1024, "100kb", "1.5mb", "  2 KB "]) {
      expect(() =>
        validateParseBodyOption({ maxContentLength: good }),
      ).not.toThrow();
    }
    expect(
      () =>
        new BunHttpAdapter(0, {
          request: { parseBody: { maxContentLength: "lots" as never } },
        }),
    ).toThrow(RangeError);
    expect(() =>
      requestParsing({ parseBody: { maxContentLength: -5 } }),
    ).toThrow(RangeError);
  });

  it("maxContentCodings must be a non-negative integer or Infinity", () => {
    for (const bad of [1.5, -1, Number.NaN, "2" as never]) {
      expect(() => validateParseBodyOption({ maxContentCodings: bad })).toThrow(
        /non-negative integer/,
      );
    }
    for (const good of [0, 1, 5, Infinity]) {
      expect(() =>
        validateParseBodyOption({ maxContentCodings: good }),
      ).not.toThrow();
    }
  });

  it("the adapter throws at construction and keeps its options on a bad replace", async () => {
    expect(
      () =>
        new BunHttpAdapter(0, {
          request: { parseBody: { encodings: ["gzpi" as never] } },
        }),
    ).toThrow(RangeError);

    const app = new BunHttpAdapter(0, {
      request: { parseBody: { maxContentLength: 10 } },
    });
    expect(() =>
      app.setRequestOpts({ parseBody: { maxContentCodings: -1 } }),
    ).toThrow(RangeError);
    // The rejected options never took effect.
    app.post("/", (req, res) => res.json(req.body));
    const response = await app.fetch("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: "x".repeat(100) }),
    });
    expect(response.status).toBe(413);
  });

  it("requestParsing() throws at creation", () => {
    expect(() =>
      requestParsing({ parseBody: { encodings: ["gzpi" as never] } }),
    ).toThrow(RangeError);
  });
});

describe("BunResponse: lazily-held state", () => {
  it("reads the documented defaults before anything is written", async () => {
    const res = await makeResponse();
    expect(res.isStreamOpen).toBe(false);
    expect(res.writableEnded).toBe(false);
    expect(res.headersSent).toBe(false);
  });

  it("keeps listeners and stream state on their own response", async () => {
    const a = await makeResponse();
    const b = await makeResponse();
    let finished = 0;
    a.on("finish", () => finished++);
    a.write("one");
    expect(a.isStreamOpen).toBe(true);
    expect(b.isStreamOpen).toBe(false);
    a.end("two");
    const native = await a.getNativeResponse(0);
    expect(await native.text()).toBe("onetwo");
    expect(a.writableEnded).toBe(true);
    expect(b.writableEnded).toBe(false);
    expect(finished).toBe(1);
    expect(b.send("b")).toBe(b);
    expect(await (await b.getNativeResponse(0)).text()).toBe("b");
  });

  it("an upgrade's data lives on the response that asked for it", async () => {
    const req = await makeRequest();
    const a = new BunResponse<{ id: number }>(req);
    const b = new BunResponse<{ id: number }>(req);
    a.upgradeToWebsocket({ id: 1 } as never);
    expect(a.upgradeToWsData).toEqual({ id: 1 } as never);
    expect(b.upgradeToWsData).toBeUndefined();
  });
});
