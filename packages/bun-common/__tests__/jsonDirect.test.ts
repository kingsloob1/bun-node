import type { RouterErrorMiddlewareHandler } from "../lib/types/general";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "bun:test";
import { requestParsing } from "../lib";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRequest } from "../lib/BunRequest";
import { testServer } from "./helpers";

/**
 * A body declared JSON with no `Content-Encoding`, no cap and no reviver is
 * read and parsed in one native call (`request.json()`) unless the request
 * keeps its bytes (`retainBuffer`). The requests here carry the
 * `Content-Length` a served request has: an in-process `Request` built from
 * a string has none, and is read as bytes.
 */

const JSON_BODY = '{"n":7,"s":"é"}';
const LENGTH = String(Buffer.byteLength(JSON_BODY));

/** A served-shaped JSON POST. */
const post = (
  body = JSON_BODY,
  headers: Record<string, string> = {},
): Request =>
  new Request("http://h/j", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      ...headers,
    },
    body,
  });

const build = (
  request: Request,
  options: ConstructorParameters<typeof BunRequest>[2] = { parseBody: true },
) => BunRequest.init(request, testServer, options) as Promise<BunRequest>;

describe("a JSON body read with request.json()", () => {
  it("parses as before, and keeps no bytes", async () => {
    const req = await build(post());
    expect(req.body).toEqual({ n: 7, s: "é" });
    expect(req.buffer).toBeUndefined();
    expect(req.isBodyParsed).toBe(true);
    expect(req.complete).toBe(true);
    expect((await req.parseBody()).body).toEqual({ n: 7, s: "é" });
    // A fresh parse has no bytes to parse again: it answers what it parsed.
    expect((await req.parseBody(true)).body).toEqual({ n: 7, s: "é" });
  });

  it("refuses invalid JSON with body-parser's 400, without err.body", async () => {
    const req = await build(post('{"n":'));
    expect(req.body).toBeUndefined();
    expect(req.bodyDecodingError).toMatchObject({
      status: 400,
      type: "entity.parse.failed",
    });
    expect("body" in req.bodyDecodingError!).toBe(false);
    expect(req.complete).toBe(false);

    const app = new BunHttpAdapter(0);
    let routed = false;
    app.post("/j", (_req, res) => {
      routed = true;
      res.send("routed");
    });
    const response = (await app.fetch(post('{"n":')))!;
    expect(response.status).toBe(400);
    expect(routed).toBe(false);
  });

  it("emits end, and no data, to a body listener", async () => {
    const req = await build(post());
    const events: string[] = [];
    req.on("data", () => events.push("data"));
    req.on("end", () => events.push("end"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["end"]);
  });

  it("serves a JSON reply through the adapter", async () => {
    const app = new BunHttpAdapter(0);
    app.post("/j", (req, res) => {
      res.json({ got: req.body, buffer: req.buffer === undefined });
    });
    const response = (await app.fetch(post()))!;
    expect(await response.json()).toEqual({
      got: { n: 7, s: "é" },
      buffer: true,
    });
  });
});

describe("read as bytes, as before", () => {
  it("with retainBuffer: buffer holds exactly what was received", async () => {
    const req = await build(post(), { parseBody: true, retainBuffer: true });
    expect(req.body).toEqual({ n: 7, s: "é" });
    expect(req.buffer?.toString()).toBe(JSON_BODY);
    expect(req.buffer?.length).toBe(Number(LENGTH));

    const invalid = await build(post('{"n":'), {
      parseBody: true,
      retainBuffer: true,
    });
    expect(invalid.bodyDecodingError).toMatchObject({ body: '{"n":' });
  });

  it("with a cap, a Content-Encoding, a reviver, or an empty or absent length", async () => {
    // A cap on an in-process (fetch()) request: the read is measured.
    const app = new BunHttpAdapter(0, {
      request: { parseBody: { maxContentLength: "1kb" } },
    });
    app.post("/j", (req, res) => {
      res.json({ bytes: req.buffer?.toString() ?? null });
    });
    expect(await (await app.fetch(post())).json()).toEqual({
      bytes: JSON_BODY,
    });
    // A reviver changes the parse.
    const revived = await build(post(), {
      parseBody: {
        contentTypes: {
          json: {
            opts: {
              reviver: (key: string, value: unknown) =>
                key === "n" ? Number(value) * 2 : value,
            },
          },
        },
      },
    });
    expect(revived.body).toEqual({ n: 14, s: "é" });
    expect(revived.buffer).toBeDefined();
    // A Content-Encoding is decoded from bytes.
    const zipped = Bun.gzipSync(Buffer.from(JSON_BODY));
    const encoded = await build(
      new Request("http://h/j", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": String(zipped.length),
        },
        body: zipped,
      }),
    );
    expect(encoded.body).toEqual({ n: 7, s: "é" });
    expect(encoded.buffer?.toString()).toBe(JSON_BODY);
    // Content-Length: 0 is the declared-empty body: `{}`.
    const empty = await build(
      new Request("http://h/j", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "0",
        },
      }),
    );
    expect(empty.body).toEqual({});
    // No length at all (an in-process body): read as bytes.
    const inProcess = await build(
      new Request("http://h/j", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON_BODY,
      }),
    );
    expect(inProcess.buffer?.toString()).toBe(JSON_BODY);
  });

  it("for a body not declared JSON", async () => {
    const req = await build(
      post("a=1", { "content-type": "application/x-www-form-urlencoded" }),
    );
    expect(req.body).toEqual({ a: "1" });
    expect(req.buffer?.toString()).toBe("a=1");
  });
});

describe("caps and re-parsing a body that kept no bytes", () => {
  it("requestParsing() checks its cap against Content-Length (413)", async () => {
    const app = new BunHttpAdapter(0);
    app.use("/j", requestParsing({ parseBody: { maxContentLength: 4 } }));
    app.post("/j", (req, res) => {
      res.json(req.body);
    });
    app.use(((err, _req, res, _next) => {
      res.status((err as { status: number }).status).send("refused");
    }) satisfies RouterErrorMiddlewareHandler);
    const response = (await app.fetch(post()))!;
    expect(response.status).toBe(413);
    const fits = new BunHttpAdapter(0);
    fits.use("/j", requestParsing({ parseBody: { maxContentLength: "1kb" } }));
    fits.post("/j", (req, res) => {
      res.json(req.body);
    });
    expect(await (await fits.fetch(post()))!.json()).toEqual({
      n: 7,
      s: "é",
    });
  });

  it("a body parser's limit is checked against Content-Length", async () => {
    const app = new BunHttpAdapter(0);
    app.useBodyParser("json", false, { limit: 4 });
    app.post("/j", (req, res) => {
      res.json(req.body);
    });
    app.use(((err, _req, res, _next) => {
      res.status((err as { status: number }).status).send("refused");
    }) satisfies RouterErrorMiddlewareHandler);
    expect((await app.fetch(post()))!.status).toBe(413);
  });

  it("requestParsing({ retainBuffer }) applies to a deferred body", async () => {
    const app = new BunHttpAdapter(0, { request: { deferBody: true } });
    app.use("/keep", requestParsing({ retainBuffer: true }));
    app.post("/keep", (req, res) => {
      res.json({ body: req.body, bytes: req.buffer?.toString() ?? null });
    });
    app.post("/drop", (req, res) => {
      res.json({ body: req.body, bytes: req.buffer?.toString() ?? null });
    });
    const keep = (await app.fetch(
      new Request("http://h/keep", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": LENGTH,
        },
        body: JSON_BODY,
      }),
    ))!;
    expect(await keep.json()).toEqual({
      body: { n: 7, s: "é" },
      bytes: JSON_BODY,
    });
    const drop = (await app.fetch(
      new Request("http://h/drop", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": LENGTH,
        },
        body: JSON_BODY,
      }),
    ))!;
    expect(await drop.json()).toEqual({ body: { n: 7, s: "é" }, bytes: null });
  });

  it("requestParsing() rejects a retainBuffer that is not a boolean", () => {
    expect(() =>
      requestParsing({ retainBuffer: "yes" as unknown as boolean }),
    ).toThrow(TypeError);
  });

  it("a body parser registered with rawBody keeps every body's bytes", async () => {
    const app = new BunHttpAdapter(0);
    app.useBodyParser("json", true, {});
    app.post("/j", (req, res) => {
      res.json({ raw: req.rawBody?.toString() ?? null });
    });
    expect(app.requestOpts.retainBuffer).toBe(true);
    // Replacing the request options keeps it.
    app.setRequestOpts({ parseCookies: false });
    expect(app.requestOpts.retainBuffer).toBe(true);
    expect(await (await app.fetch(post()))!.json()).toEqual({
      raw: JSON_BODY,
    });
  });
});

describe("retainBuffer per content type (parseBody.contentTypes.<kind>.retainBuffer)", () => {
  /** A served-shaped POST of `body` declared `type`. */
  const typed = (type: string, body: string) =>
    post(body, { "content-type": type });

  it("a served request under a cap reads JSON without its bytes, by default", async () => {
    const req = await build(post(), {
      parseBody: { maxContentLength: "1kb" },
    });
    expect(req.body).toEqual({ n: 7, s: "é" });
    expect(req.buffer).toBeUndefined();
    // Over the cap: refused (413) from the declared length, as before.
    const over = await build(post(), { parseBody: { maxContentLength: 4 } });
    expect(over.isPayloadTooLarge).toBe(true);
  });

  it("overrides the request option, both ways", async () => {
    const kept = await build(post(), {
      parseBody: { contentTypes: { json: { retainBuffer: true } } },
    });
    expect(kept.buffer?.toString()).toBe(JSON_BODY);
    const dropped = await build(post(), {
      retainBuffer: true,
      parseBody: { contentTypes: { json: { retainBuffer: false } } },
    });
    expect(dropped.body).toEqual({ n: 7, s: "é" });
    expect(dropped.buffer).toBeUndefined();
  });

  it("text, urlencoded and xml keep their bytes unless told not to", async () => {
    const text = await build(typed("text/plain", "héllo"));
    expect([text.body, text.buffer?.toString()]).toEqual(["héllo", "héllo"]);

    const options = {
      parseBody: {
        contentTypes: {
          text: { retainBuffer: false },
          urlencoded: { retainBuffer: false },
          xml: { retainBuffer: false },
        },
      },
    };
    const textDirect = await build(typed("text/plain", "héllo"), options);
    expect([textDirect.body, textDirect.buffer]).toEqual(["héllo", undefined]);
    const form = await build(
      typed("application/x-www-form-urlencoded", "a=1&b=x%20y"),
      options,
    );
    expect([form.body, form.buffer]).toEqual([{ a: "1", b: "x y" }, undefined]);
    const xml = await build(
      typed("application/xml", "<a><b>1</b></a>"),
      options,
    );
    expect(xml.body).toEqual(
      (await build(typed("application/xml", "<a><b>1</b></a>"))).body,
    );
    expect(xml.buffer).toBeUndefined();
  });

  it("a global retainBuffer: false applies to every kind it can", async () => {
    const text = await build(typed("text/plain", "plain"), {
      parseBody: true,
      retainBuffer: false,
    });
    expect([text.body, text.buffer]).toEqual(["plain", undefined]);
  });

  it("has no effect where the bytes are needed: raw, multipart, a non-UTF-8 text encoding", async () => {
    const raw = await build(typed("application/octet-stream", "bytes"), {
      parseBody: { contentTypes: { raw: { retainBuffer: false } } },
    });
    expect(Buffer.isBuffer(raw.body)).toBe(true);
    expect(raw.buffer?.toString()).toBe("bytes");

    const latin1 = Buffer.from("café", "latin1");
    const encoded = await build(
      new Request("http://h/t", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "content-length": String(latin1.length),
        },
        body: latin1,
      }),
      {
        parseBody: {
          contentTypes: {
            text: { retainBuffer: false, opts: { encoding: "latin1" } },
          },
        },
      },
    );
    expect(encoded.body).toBe("café");
    expect(encoded.buffer).toBeDefined();
  });

  it("must be a boolean, checked where it is configured", () => {
    expect(
      () =>
        new BunHttpAdapter(0, {
          request: {
            parseBody: {
              contentTypes: {
                json: { retainBuffer: "yes" as unknown as boolean },
              },
            },
          },
        }),
    ).toThrow(TypeError);
  });
});
