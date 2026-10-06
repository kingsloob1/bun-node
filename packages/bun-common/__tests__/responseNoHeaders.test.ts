import type { BunRequest } from "../lib/BunRequest";
import type { BunResponse } from "../lib/BunResponse";
import net from "node:net";
import { describe, expect, it } from "bun:test";
import { compression, etag } from "../lib";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { makeResponse } from "./helpers";

/**
 * A text or JSON body sent when no header was set goes out with no `Headers`
 * object (the cheapest `Response` Bun can build). The defaults are the types
 * Bun itself writes — `text/plain;charset=utf-8` for text,
 * `application/json;charset=utf-8` for JSON — on both paths, so a response's
 * `Content-Type` never depends on whether some other header was set.
 */

const TEXT = "text/plain;charset=utf-8";
const JSON_TYPE = "application/json;charset=utf-8";

/** Sends a raw request and returns the response head (lower-cased) and body. */
function raw(
  port: number,
  method: string,
  path: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      const [head, ...rest] = data.split("\r\n\r\n");
      const [statusLine, ...lines] = head.split("\r\n");
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const colon = line.indexOf(":");
        headers[line.slice(0, colon).toLowerCase()] = line
          .slice(colon + 1)
          .trim();
      }
      resolve({
        status: Number(statusLine.split(" ")[1]),
        headers,
        body: rest.join("\r\n\r\n"),
      });
    });
    socket.write(
      `${method} ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
    );
  });
}

/** A handler for every response shape these tests compare. */
function routes(adapter: BunHttpAdapter) {
  adapter.get("/text", (_req, res) => res.send("hello"));
  adapter.get("/created", (_req, res) => res.status(201).send("made"));
  adapter.get("/json", (_req, res) => res.json({ a: 1, b: [true, null] }));
  adapter.get("/object", (_req, res) => res.send({ via: "send" }));
  adapter.get("/null", (_req, res) => res.json(null));
  adapter.get("/header", (_req, res) => res.set("x-h", "1").send("hello"));
  adapter.get("/json-header", (_req, res) => {
    res.set("x-h", "1").json({ a: 1 });
  });
  adapter.get("/typed", (_req, res) => res.type("html").send("<p>"));
}

describe("BunResponse: sending with no headers set", () => {
  it("builds the Response without a Headers object, for text and JSON", async () => {
    const text = await makeResponse();
    const native = await text.send("hi").getNativeResponse(0);
    // Bun writes the type on the wire; the Response object carries none.
    expect(native.headers.has("content-type")).toBe(false);
    expect(await native.text()).toBe("hi");

    const json = await makeResponse();
    const jsonNative = await json.json({ a: 1 }).getNativeResponse(0);
    expect(jsonNative.headers.get("content-type")).toBe(JSON_TYPE);
    expect(await jsonNative.json()).toEqual({ a: 1 });
  });

  it("reports the implicit Content-Type to header reads after the send", async () => {
    const res = await makeResponse();
    res.send("hi");
    expect(res.getHeader("Content-Type")).toBe(TEXT);
    expect(res.hasHeader("content-type")).toBe(true);
    expect(res.getHeaders()).toEqual(
      Object.assign(Object.create(null), { "content-type": TEXT }),
    );
    expect(res.get("content-type")).toBe(TEXT);
    expect(res.getHeaderNames()).toEqual(["content-type"]);

    const json = await makeResponse();
    json.json([1]);
    expect(json.getHeader("content-type")).toBe(JSON_TYPE);
  });

  it("is not taken off the fast path by reading a header first", async () => {
    const res = await makeResponse();
    expect(res.getHeader("x-missing")).toBeNull();
    expect(res.hasHeader("x-missing")).toBe(false);
    expect(res.getHeaders()).toEqual(Object.create(null));
    const native = await res.send("hi").getNativeResponse(0);
    expect(native.headers.has("content-type")).toBe(false);
  });

  it("gives a response with other headers the same default type", async () => {
    const res = await makeResponse();
    const native = await res.set("x-h", "1").send("hi").getNativeResponse(0);
    expect(native.headers.get("content-type")).toBe(TEXT);
    expect(native.headers.get("x-h")).toBe("1");

    const json = await makeResponse();
    const jsonNative = await json.set("x-h", "1").json({}).getNativeResponse(0);
    expect(jsonNative.headers.get("content-type")).toBe(JSON_TYPE);
  });

  it("keeps the status and reason phrase", async () => {
    const res = await makeResponse();
    res.status(201).statusText("Made It").send("x");
    const native = await res.getNativeResponse(0);
    expect([native.status, native.statusText]).toEqual([201, "Made It"]);
    const json = await makeResponse();
    expect((await json.status(202).json({}).getNativeResponse(0)).status).toBe(
      202,
    );
  });

  it("still strips the body and type of a 204, 205 or 304", async () => {
    for (const code of [204, 205, 304]) {
      for (const send of [
        (res: BunResponse) => res.send("gone"),
        (res: BunResponse) => res.json({ gone: true }),
      ]) {
        const res = await makeResponse();
        const native = await send(res.status(code)).getNativeResponse(0);
        expect(native.status).toBe(code);
        expect(await native.text()).toBe("");
        // 204 and 304 drop the type too; 205 only empties the body, as
        // Express's res.send does.
        if (code !== 205) {
          expect(native.headers.has("content-type")).toBe(false);
        }
      }
    }
  });

  it("takes the full path when an ETag is to be computed, and revalidates", async () => {
    const res = await makeResponse();
    const native = await res.setEtag().send("hi").getNativeResponse(0);
    expect(native.headers.get("etag")).toBe(etag("hi"));
    expect(native.headers.get("content-type")).toBe(TEXT);

    const again = await makeResponse({
      headers: { "If-None-Match": etag("hi") },
    });
    expect((await again.setEtag().send("hi").getNativeResponse(0)).status).toBe(
      304,
    );
  });

  it("never answers 304 without a validator, as before", async () => {
    const res = await makeResponse({ headers: { "If-None-Match": "*" } });
    expect((await res.send("hi").getNativeResponse(0)).status).toBe(200);
  });

  it("sends JSON edge values as JSON.stringify does", async () => {
    const cases: [unknown, string][] = [
      [null, "null"],
      [0, "0"],
      ["s", '"s"'],
      [[1, "a"], '[1,"a"]'],
      [{ toJSON: () => ({ t: 1 }) }, '{"t":1}'],
      [{ skip: undefined, keep: 1 }, '{"keep":1}'],
      [undefined, ""],
    ];
    for (const [value, expected] of cases) {
      const res = await makeResponse();
      const native = await res.json(value as never).getNativeResponse(0);
      expect(await native.text()).toBe(expected);
    }
    const bad = await makeResponse();
    expect(() => bad.json(1n as never)).toThrow(TypeError);
  });

  it("works under compression(), which needs the full path", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.use(compression({ threshold: 0 }));
    adapter.get("/c", (_req, res) => res.send("x".repeat(2000)));
    const response = await adapter.fetch("/c", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    // A socket-free fetch() does not decode the body; a client would.
    const body = Bun.gunzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(new TextDecoder().decode(body)).toBe("x".repeat(2000));
  });
});

describe("BunResponse: served and fetch() agree with no headers set", () => {
  it("answers each path the same way over a socket and through fetch()", async () => {
    const adapter = new BunHttpAdapter(0);
    routes(adapter);
    const server = await adapter.listen(0);
    try {
      for (const path of [
        "/text",
        "/created",
        "/json",
        "/object",
        "/null",
        "/header",
        "/json-header",
        "/typed",
      ]) {
        const served = await raw(server.port!, "GET", path);
        const fetched = await adapter.fetch(path);
        expect({ path, status: fetched.status }).toEqual({
          path,
          status: served.status,
        });
        expect({ path, type: fetched.headers.get("content-type") }).toEqual({
          path,
          type: served.headers["content-type"],
        });
        expect(await fetched.text()).toBe(served.body);
      }
      const served = await raw(server.port!, "GET", "/text");
      expect(served.headers["content-type"]).toBe(TEXT);
      expect(served.headers["content-length"]).toBe("5");
    } finally {
      await adapter.close();
    }
  });

  it("answers HEAD with the headers and no body, served and through fetch()", async () => {
    const adapter = new BunHttpAdapter(0);
    routes(adapter);
    const server = await adapter.listen(0);
    try {
      for (const path of ["/text", "/json"]) {
        const served = await raw(server.port!, "HEAD", path);
        const fetched = await adapter.fetch(path, { method: "HEAD" });
        expect(served.body).toBe("");
        expect(await fetched.text()).toBe("");
        expect(fetched.headers.get("content-type")).toBe(
          served.headers["content-type"],
        );
        // HEAD carries its type explicitly (Bun adds none to a HEAD response
        // built without headers).
        expect(served.headers["content-type"]).toBe(
          path === "/text" ? TEXT : JSON_TYPE,
        );
      }
    } finally {
      await adapter.close();
    }
  });

  it("a router's own fetch() adds the type too", async () => {
    const adapter = new BunHttpAdapter(0);
    adapter.get("/t", (_req: BunRequest, res: BunResponse) => res.send("t"));
    const response = await adapter.fetch("/t");
    expect(response.headers.get("content-type")).toBe(TEXT);
  });
});
