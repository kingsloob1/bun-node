import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { BunRequest } from "../lib/BunRequest";
import { BunResponse } from "../lib/BunResponse";
import { FETCH_STUB_SERVER } from "../lib/BunRouter";
import { etag, signCookie } from "../lib/utils/native";
import { makeRequest, makeResponse, testServer } from "./helpers";

/** What `run` throws synchronously; `undefined` when it does not throw. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Resolves after the current tick's `process.nextTick` callbacks have run. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("BunResponse: construction", () => {
  it("can be created from a request", async () => {
    const req = await makeRequest();
    expect(new BunResponse(req)).toBeInstanceOf(BunResponse);
  });
});

describe("BunResponse: status & body", () => {
  it("status sets the response code", async () => {
    const res = await makeResponse();
    res.status(201);
    expect(res.statusCode).toBe(201);
  });

  it("defaults statusCode to 200", async () => {
    const res = await makeResponse();
    expect(res.statusCode).toBe(200);
  });

  it("json serialises an object body", async () => {
    const res = await makeResponse();
    res.json({ hello: "world" });
    const native = await res.getNativeResponse(1000);
    expect(native.headers.get("Content-Type")).toContain("application/json");
    expect(await native.json()).toEqual({ hello: "world" });
  });

  it("send delivers a string body and does not set an ETag by default", async () => {
    const res = await makeResponse();
    res.send("plain text");
    const native = await res.getNativeResponse(1000);
    expect(await native.text()).toBe("plain text");
    // ETag generation is opt-in.
    expect(native.headers.get("ETag")).toBeNull();
  });

  it("send computes an ETag when ETag is opted in", async () => {
    const res = await makeResponse();
    res.setEtag(true).send("plain text");
    const native = await res.getNativeResponse(1000);
    expect(native.headers.get("ETag")).toBeTruthy();
  });

  it("send serialises objects to JSON", async () => {
    const res = await makeResponse();
    await res.send({ a: 1 });
    const native = await res.getNativeResponse(1000);
    expect(await native.json()).toEqual({ a: 1 });
  });

  it("sendStatus sets the status and sends its reason phrase (Express)", async () => {
    const res = await makeResponse();
    res.sendStatus(404);
    const native = await res.getNativeResponse(1000);
    expect(native.status).toBe(404);
    expect(native.headers.get("Content-Type")).toBe("text/plain");
    expect(await native.text()).toBe("Not Found");
  });
});

describe("BunResponse: send with Bun-native body types", () => {
  it("send delivers a Buffer verbatim as application/octet-stream", async () => {
    const res = await makeResponse();
    const buffer = Buffer.from([0x00, 0xff, 0x10, 0x42]);
    res.send(buffer);

    const native = await res.getNativeResponse(1000);
    expect(native.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(new Uint8Array(await native.arrayBuffer())).toEqual(
      new Uint8Array(buffer),
    );
  });

  it("send delivers a Uint8Array", async () => {
    const res = await makeResponse();
    res.send(new TextEncoder().encode("hello bytes"));

    const native = await res.getNativeResponse(1000);
    expect(await native.text()).toBe("hello bytes");
  });

  it("send honours a typed array's byteOffset/byteLength window", async () => {
    const res = await makeResponse();
    // A view over the middle of a larger buffer — only those bytes must ship.
    const view = new Uint8Array([1, 2, 3, 4, 5]).subarray(1, 4);
    res.send(view);

    const native = await res.getNativeResponse(1000);
    expect(new Uint8Array(await native.arrayBuffer())).toEqual(
      new Uint8Array([2, 3, 4]),
    );
  });

  it("send delivers a non-byte typed array's raw bytes", async () => {
    const res = await makeResponse();
    res.send(new Uint16Array([0x0201, 0x0403]));

    const native = await res.getNativeResponse(1000);
    expect(new Uint8Array(await native.arrayBuffer()).byteLength).toBe(4);
  });

  it("send delivers a DataView", async () => {
    const res = await makeResponse();
    const bytes = new Uint8Array([9, 8, 7]);
    res.send(new DataView(bytes.buffer));

    const native = await res.getNativeResponse(1000);
    expect(new Uint8Array(await native.arrayBuffer())).toEqual(bytes);
  });

  it("send delivers an ArrayBuffer", async () => {
    const res = await makeResponse();
    const bytes = new TextEncoder().encode("array buffer");
    res.send(bytes.buffer as ArrayBuffer);

    const native = await res.getNativeResponse(1000);
    expect(await native.text()).toBe("array buffer");
  });

  it("send delivers a SharedArrayBuffer", async () => {
    const res = await makeResponse();
    const shared = new SharedArrayBuffer(3);
    new Uint8Array(shared).set([1, 2, 3]);
    res.send(shared);

    const native = await res.getNativeResponse(1000);
    expect(new Uint8Array(await native.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("send does not JSON-stringify binary bodies", async () => {
    const res = await makeResponse();
    res.send(Buffer.from("hi"));

    const native = await res.getNativeResponse(1000);
    // The old object path produced `{"0":104,"1":105}`.
    expect(await native.text()).toBe("hi");
  });

  it("an explicit Content-Type wins over the binary default", async () => {
    const res = await makeResponse();
    res.type("image/png").send(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const native = await res.getNativeResponse(1000);
    expect(native.headers.get("Content-Type")).toBe("image/png");
  });

  it("send computes an ETag over the bytes when opted in", async () => {
    const first = await makeResponse();
    first.setEtag(true).send(Buffer.from("same bytes"));
    const second = await makeResponse();
    second.setEtag(true).send(Buffer.from("same bytes"));
    const other = await makeResponse();
    other.setEtag(true).send(Buffer.from("other bytes!"));

    const firstTag = (await first.getNativeResponse(1000)).headers.get("ETag");
    const secondTag = (await second.getNativeResponse(1000)).headers.get(
      "ETag",
    );
    const otherTag = (await other.getNativeResponse(1000)).headers.get("ETag");

    expect(firstTag).toBeTruthy();
    expect(secondTag).toBe(firstTag as string);
    expect(otherTag).not.toBe(firstTag as string);
  });

  it("send does not set an ETag for binary bodies by default", async () => {
    const res = await makeResponse();
    res.send(Buffer.from("bytes"));
    const native = await res.getNativeResponse(1000);
    expect(native.headers.get("ETag")).toBeNull();
  });

  it("send delivers a Blob with its own type", async () => {
    const res = await makeResponse();
    res.send(new Blob(["blob body"], { type: "text/csv" }));

    const native = await res.getNativeResponse(1000);
    expect(await native.text()).toBe("blob body");
  });

  it("send delivers FormData with a generated multipart boundary", async () => {
    const res = await makeResponse();
    const form = new FormData();
    form.append("field", "value");
    res.send(form);

    const native = await res.getNativeResponse(1000);
    const contentType = native.headers.get("Content-Type") || "";
    expect(contentType).toContain("multipart/form-data");
    expect(contentType).toContain("boundary=");
    expect((await native.formData()).get("field")).toBe("value");
  });

  it("send delivers URLSearchParams as urlencoded", async () => {
    const res = await makeResponse();
    res.send(new URLSearchParams({ a: "1", b: "two" }));

    const native = await res.getNativeResponse(1000);
    expect(native.headers.get("Content-Type")).toContain(
      "application/x-www-form-urlencoded",
    );
    expect(await native.text()).toBe("a=1&b=two");
  });

  it("send streams an async generator function", async () => {
    const res = await makeResponse();
    res.send(async function* () {
      yield "chunk-1|";
      yield "chunk-2";
    });

    const native = await res.getNativeResponse(1000);
    expect(await native.text()).toBe("chunk-1|chunk-2");
  });

  it("send streams an async iterable", async () => {
    const res = await makeResponse();
    res.send({
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode("iter-");
        yield new TextEncoder().encode("able");
      },
    });

    const native = await res.getNativeResponse(1000);
    expect(await native.text()).toBe("iter-able");
  });

  it("getBody returns the binary body untouched", async () => {
    const res = await makeResponse();
    const buffer = Buffer.from("bytes");
    res.send(buffer);
    expect(res.getBody()).toBe(buffer);
  });

  it("end sends a binary body", async () => {
    const res = await makeResponse();
    await res.end(Buffer.from("ended"));

    const native = await res.getNativeResponse(1000);
    expect(await native.text()).toBe("ended");
  });

  it("write streams binary chunks without stringifying them", async () => {
    const res = await makeResponse();
    res.write(Buffer.from([104, 105]));
    res.write(new Uint8Array([33]));
    res.write(new Uint8Array([63]).buffer as ArrayBuffer);

    const native = await res.getNativeResponse(1000);
    const reader = (
      native.body as unknown as ReadableStream<Uint8Array>
    ).getReader();

    // Each queued chunk is enqueued individually, so one read drains one.
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 3; i++) {
      const { value } = await reader.read();
      if (value) chunks.push(value);
    }
    await reader.cancel();

    const text = chunks
      .map((chunk) => new TextDecoder().decode(chunk))
      .join("");
    expect(text).toBe("hi!?");
  });
});

describe("BunResponse: headers", () => {
  it("setHeader / getHeader round-trip", async () => {
    const res = await makeResponse();
    res.setHeader("X-Test", "value");
    expect(res.getHeader("X-Test")).toBe("value");
    expect(res.hasHeader("X-Test")).toBe(true);
  });

  it("append accumulates multiple values", async () => {
    const res = await makeResponse();
    res.append("X-Multi", "a");
    res.append("X-Multi", "b");
    expect(res.getHeader("X-Multi")).toBe("a, b");
  });

  it("removeHeader deletes a header", async () => {
    const res = await makeResponse();
    res.setHeader("X-Gone", "1");
    res.removeHeader("X-Gone");
    expect(res.hasHeader("X-Gone")).toBe(false);
  });

  it("setHeaders accepts a record", async () => {
    const res = await makeResponse();
    res.setHeaders({ "X-A": "1", "X-B": "2" });
    expect(res.getHeader("X-A")).toBe("1");
    expect(res.getHeader("X-B")).toBe("2");
  });

  it("type sets the Content-Type header", async () => {
    const res = await makeResponse();
    res.type("text/html");
    expect(res.getHeader("Content-Type")).toBe("text/html");
  });

  it("vary appends to the Vary header", async () => {
    const res = await makeResponse();
    res.vary("Accept");
    res.vary("Accept-Encoding");
    expect(res.getHeader("Vary")).toBe("Accept, Accept-Encoding");
  });

  it("writeHead applies status and headers", async () => {
    const res = await makeResponse();
    res.writeHead(207, { "X-Written": "yes" });
    expect(res.statusCode).toBe(207);
    expect(res.getHeader("X-Written")).toBe("yes");
  });

  it("writeHead(statusCode) alone sets the status, as Node", async () => {
    const res = await makeResponse();
    const before = res.getHeaders();
    expect(res.writeHead(404)).toBe(res);
    expect(res.statusCode).toBe(404);
    expect(res.getHeaders()).toEqual(before);

    res.send("gone");
    const native = await res.getNativeResponse(1000);
    expect(native.status).toBe(404);
  });

  it("writeHead(statusCode, statusMessage) sets both", async () => {
    const res = await makeResponse();
    res.writeHead(404, "Nothing Here");
    expect(res.statusCode).toBe(404);
    expect(res.nativeResponseOptions?.statusText).toBe("Nothing Here");

    res.send("gone");
    const native = await res.getNativeResponse(1000);
    expect([native.status, native.statusText]).toEqual([404, "Nothing Here"]);
  });

  it("writeHead(statusCode, statusMessage, headers) sets all three", async () => {
    const res = await makeResponse();
    res.writeHead(201, "Made", { "X-Id": "7", "X-Tags": ["a", "b"] });
    expect(res.statusCode).toBe(201);
    expect(res.nativeResponseOptions?.statusText).toBe("Made");
    expect(res.get("X-Id")).toBe("7");
    expect(res.get("X-Tags")).toBe("a, b");
  });

  it("get('set-cookie') answers every line as an array, as Node's getHeader", async () => {
    const res = await makeResponse();
    expect(res.get("set-cookie")).toBeUndefined();
    expect(res.get("Set-Cookie", [])).toEqual([]);

    res.cookie("old", "1", { expires: new Date(0) });
    res.cookie("new", "2");
    const lines = res.get("Set-Cookie");
    expect(lines).toHaveLength(2);
    // Joined, the comma in `Expires` would make the lines unsplittable.
    expect(lines?.[0]).toContain("old=1");
    expect(lines?.[0]).toContain("Expires=Thu, 01 Jan 1970");
    expect(lines?.[1]).toStartWith("new=2");
    // Every other header is still one string.
    res.append("X-Many", ["a", "b"]);
    expect(res.get("x-many")).toBe("a, b");
  });
});

describe("BunResponse: headers, as Node's OutgoingMessage", () => {
  it("getHeader('set-cookie') answers every line as an array, in any letter case", async () => {
    const res = await makeResponse();
    expect(res.getHeader("set-cookie")).toBeUndefined();
    // Any other absent header stays `null`, as `Headers.get`.
    expect(res.getHeader("X-Absent")).toBeNull();

    res.cookie("old", "1", { expires: new Date(0) });
    res.cookie("new", "2");
    const lines = res.getHeader("Set-Cookie");
    expect(lines).toHaveLength(2);
    // Joined, the comma in `Expires` would make the lines unsplittable.
    expect(lines?.[0]).toContain("Expires=Thu, 01 Jan 1970");
    expect(lines?.[1]).toStartWith("new=2");
    expect(res.getHeader("SET-COOKIE")).toEqual(lines);
    expect(res.get("set-cookie")).toEqual(lines);
  });

  it("setHeader('Set-Cookie', [...]) and appendHeader round-trip through getHeader", async () => {
    const res = await makeResponse();
    res.setHeader("Set-Cookie", ["a=1", "b=2; Expires=Thu, 01 Jan 1970"]);
    expect(res.getHeader("set-cookie")).toEqual([
      "a=1",
      "b=2; Expires=Thu, 01 Jan 1970",
    ]);
    expect(res.hasHeader("SET-COOKIE")).toBe(true);

    // setHeader replaces every line, as Node's.
    res.setHeader("Set-Cookie", "c=3");
    expect(res.getHeader("Set-Cookie")).toEqual(["c=3"]);

    // appendHeader adds lines, a string or an array.
    res.appendHeader("set-cookie", "d=4");
    res.appendHeader("Set-Cookie", ["e=5", "f=6"]);
    expect(res.getHeader("Set-Cookie")).toEqual(["c=3", "d=4", "e=5", "f=6"]);

    res.removeHeader("Set-Cookie");
    expect(res.hasHeader("set-cookie")).toBe(false);
    expect(res.getHeader("Set-Cookie")).toBeUndefined();

    // Every line reaches the client as its own header.
    res.setHeader("Set-Cookie", ["x=1", "y=2"]);
    const native = await res.send("").getNativeResponse(1000);
    expect(native.headers.getSetCookie()).toEqual(["x=1", "y=2"]);
  });

  it("getHeaders() is a prototype-less object: lower-cased names, set-cookie an array", async () => {
    const res = await makeResponse();
    expect(res.getHeaders()).toEqual({});

    res.setHeader("X-Trace", "abc");
    res.append("X-Many", ["a", "b"]);
    res.cookie("a", "1", { expires: new Date(0) });
    res.cookie("b", "2");
    const headers = res.getHeaders();

    expect(Object.getPrototypeOf(headers)).toBeNull();
    expect(headers["x-trace"]).toBe("abc");
    expect(headers["x-many"]).toBe("a, b");
    expect(headers["set-cookie"]).toHaveLength(2);
    expect(headers["set-cookie"]?.[1]).toStartWith("b=2");
    // A snapshot: changing it does not change the response.
    headers["x-trace"] = "changed";
    expect(res.getHeader("X-Trace")).toBe("abc");
  });

  it("getHeaderNames() lists set-cookie once, however many lines it has", async () => {
    const res = await makeResponse();
    res.setHeader("X-A", "1");
    res.setHeader("Set-Cookie", ["a=1", "b=2", "c=3"]);
    const names = res.getHeaderNames();
    // Order follows `Headers` iteration, not insertion, so compare as a set.
    expect(names).toHaveLength(2);
    expect(names.toSorted()).toEqual(["set-cookie", "x-a"]);
  });

  it("setHeaders(Headers | Map) keeps every Set-Cookie line whole", async () => {
    const res = await makeResponse();
    const incoming = new Headers();
    incoming.append("Set-Cookie", "a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    incoming.append("Set-Cookie", "b=2");
    incoming.set("X-From-Headers", "yes");
    res.setHeaders(incoming);
    expect(res.getHeader("Set-Cookie")).toEqual([
      "a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      "b=2",
    ]);
    expect(res.getHeader("X-From-Headers")).toBe("yes");

    // Replaces the lines set before, as setHeader('set-cookie', [...]) does.
    res.setHeaders(new Map([["set-cookie", "c=3"]]));
    expect(res.getHeader("Set-Cookie")).toEqual(["c=3"]);
  });
});

describe("BunResponse: cookies", () => {
  it("cookie appends a Set-Cookie header", async () => {
    const res = await makeResponse();
    res.cookie("session", "abc", { path: "/", httpOnly: true });
    const [line] = res.getHeader("Set-Cookie") ?? [];
    expect(line).toContain("session=abc");
    expect(line).toContain("HttpOnly");
  });

  it("clearCookie expires the cookie", async () => {
    const res = await makeResponse();
    res.clearCookie("session", undefined);
    const [line] = res.getHeader("Set-Cookie") ?? [];
    expect(line).toContain("session=");
    expect(line).toContain("Expires=");
  });

  it("cookie signs values when requested", async () => {
    const res = await makeResponse();
    res.cookie("token", "value", { signed: true, secret: "shh" });
    expect(res.getHeader("Set-Cookie")?.[0]).toContain("token=s%3A");
  });

  it("cookie defaults the path to / even when no options are passed", async () => {
    const res = await makeResponse();
    res.cookie("plain", "value");
    const [line] = res.getHeader("Set-Cookie") ?? [];
    expect(line).toContain("plain=value");
    expect(line).toContain("Path=/");
  });
});

describe("cookieSecret: signed cookies verified while the request is built, as cookieParser(secret)", () => {
  /** A `Cookie` header value for `name`, signed with `secret`. */
  function signedCookie(name: string, value: string, secret: string) {
    return `${name}=${encodeURIComponent(`s:${signCookie(value, secret)}`)}`;
  }

  it("verifies a valid signed cookie and sets req.secret", async () => {
    const req = await makeRequest({
      headers: {
        Cookie: `${signedCookie("session", "user-42", "k")}; theme=dark`,
      },
      options: { parseBody: false, cookieSecret: "k" },
    });
    expect(req.secret).toBe("k");
    expect(req.signedCookies).toEqual({ session: "user-42" });
    expect(req.cookies).toEqual({ theme: "dark" });
  });

  it("reports a tampered signed cookie as false and removes it from cookies", async () => {
    const tampered = signedCookie("session", "user-42", "k").replace(
      "user-42",
      "user-1",
    );
    const req = await makeRequest({
      headers: { Cookie: tampered },
      options: { parseBody: false, cookieSecret: "k" },
    });
    expect(req.signedCookies).toEqual({ session: false });
    expect(req.cookies).toEqual({});
  });

  it("rotates secrets: the first is req.secret, every one verifies, also on a re-parse", async () => {
    const req = await makeRequest({
      headers: {
        Cookie: `${signedCookie("old", "a", "old secret")}; ${signedCookie("new", "b", "new secret")}`,
      },
      options: { parseBody: false, cookieSecret: ["new secret", "old secret"] },
    });
    expect(req.secret).toBe("new secret");
    expect(req.signedCookies).toEqual({ old: "a", new: "b" });
    expect(
      req.parseCookies({ forceUpdateRequest: true }).signedCookies,
    ).toEqual({
      old: "a",
      new: "b",
    });
  });

  it("signs res.cookie(..., { signed: true }) with the configured secret", async () => {
    const res = await makeResponse({
      options: { parseBody: false, cookieSecret: ["new secret", "old secret"] },
    });
    res.cookie("token", "value", { signed: true });
    expect(res.getHeader("Set-Cookie")?.[0]).toContain(
      `token=${encodeURIComponent(`s:${signCookie("value", "new secret")}`)}`,
    );
  });

  it("sets req.secret even with parseCookies: false, and an empty secret is none", async () => {
    const unparsed = await makeRequest({
      options: { parseBody: false, parseCookies: false, cookieSecret: "k" },
    });
    expect(unparsed.secret).toBe("k");
    for (const cookieSecret of ["", []]) {
      const req = await makeRequest({
        headers: { Cookie: signedCookie("session", "x", "k") },
        options: { parseBody: false, cookieSecret },
      });
      expect(req.secret).toBeUndefined();
      expect(req.signedCookies).toEqual({});
    }
  });

  it("keeps the middleware route: parseCookies({ secret, forceUpdateRequest })", async () => {
    const req = await makeRequest({
      headers: { Cookie: signedCookie("session", "user-42", "k") },
    });
    expect(req.signedCookies).toEqual({});
    req.parseCookies({ secret: "k", forceUpdateRequest: true });
    expect(req.secret).toBe("k");
    expect(req.signedCookies).toEqual({ session: "user-42" });
  });
});

describe("BunResponse: sendFile", () => {
  it("serves a file inline without forcing a download", async () => {
    const res = await makeResponse();
    await res.sendFile(import.meta.path, { root: "/" });
    expect(res.getHeader("Content-Disposition")).toBeNull();
    const native = await res.getNativeResponse(1000);
    expect(native.status).toBe(200);
  });

  it("download() sets Content-Disposition: attachment", async () => {
    const res = await makeResponse();
    await res.download(import.meta.path, "renamed.ts", { root: "/" });
    expect(res.getHeader("Content-Disposition")).toContain("attachment");
    expect(res.getHeader("Content-Disposition")).toContain("renamed.ts");
  });
});

describe("BunResponse: redirect & location", () => {
  it("redirect produces a redirect response", async () => {
    const res = await makeResponse();
    res.redirect("http://localhost/next", 302);
    const native = await res.getNativeResponse(1000);
    expect([301, 302]).toContain(native.status);
  });

  it("location encodes the Location header", async () => {
    const res = await makeResponse();
    res.location("/path with space");
    expect(res.getHeader("Location")).toBe("/path%20with%20space");
  });

  it("links builds a Link header", async () => {
    const res = await makeResponse();
    res.links({ next: "http://localhost/page/2" });
    expect(res.getHeader("Link")).toContain('rel="next"');
  });
});

describe("BunResponse: getNativeResponse deferral", () => {
  it("resolves once a response is produced asynchronously", async () => {
    const res = await makeResponse();
    const pending = res.getNativeResponse(1000);
    queueMicrotask(() => {
      res.json({ deferred: true });
    });
    const native = await pending;
    expect(await native.json()).toEqual({ deferred: true });
  });

  it("rejects when no response arrives before the timeout", async () => {
    const res = await makeResponse();
    await expect(res.getNativeResponse(20)).rejects.toThrow("Timedout");
  });
});

describe("BunResponse: headersSent", () => {
  it("becomes true after a response is built", async () => {
    const res = await makeResponse();
    expect(res.headersSent).toBe(false);
    await res.send("done");
    expect(res.headersSent).toBe(true);
  });

  it("ignores a second send once headers are sent", async () => {
    const res = await makeResponse();
    await res.send("first");
    await res.send("second");
    const native = await res.getNativeResponse(1000);
    expect(await native.text()).toBe("first");
  });
});

describe("BunResponse: ServerResponse-style events", () => {
  it("emit returns false when nothing is listening", async () => {
    const res = await makeResponse();
    expect(res.emit("finish")).toBe(false);
  });

  it("on returns the response for chaining", async () => {
    const res = await makeResponse();
    expect(res.on("finish", () => {})).toBe(res);
  });

  it("emits finish when the response is produced", async () => {
    const res = await makeResponse();
    let finished = false;
    res.on("finish", () => {
      finished = true;
    });
    res.send("ok");
    expect(finished).toBe(true);
  });

  it("emits close after finish", async () => {
    const res = await makeResponse();
    const order: string[] = [];
    res.on("finish", () => order.push("finish"));
    res.on("close", () => order.push("close"));
    res.send("ok");
    await Bun.sleep(1);
    expect(order).toEqual(["finish", "close"]);
  });

  it("emits close when the request connection aborts", async () => {
    const controller = new AbortController();
    const request = new Request("http://localhost/stream", {
      signal: controller.signal,
    });
    const { BunRequest } = await import("../lib/BunRequest");
    const { testServer } = await import("./helpers");
    const req = await BunRequest.init(request, testServer, {
      parseBody: false,
      parseCookies: false,
      parseQuery: false,
    });
    const res = new BunResponse(req);

    let closed = false;
    res.on("close", () => {
      closed = true;
    });
    controller.abort();
    await Bun.sleep(1);
    expect(closed).toBe(true);
  });

  it("emits error via emitError", async () => {
    const res = await makeResponse();
    let received: unknown;
    res.on("error", (error: unknown) => {
      received = error;
    });
    const failure = new Error("stream failure");
    res.emitError(failure);
    expect(received).toBe(failure);
  });

  it("emits drain when a chunk is written to a streaming response", async () => {
    const res = await makeResponse();
    let drained = false;
    res.on("drain", () => {
      drained = true;
    });
    res.write("chunk");
    expect(drained).toBe(true);
  });

  it("emits pipe and unpipe for stream piping", async () => {
    const res = await makeResponse();
    const events: string[] = [];
    res.on("pipe", () => events.push("pipe"));
    res.on("unpipe", () => events.push("unpipe"));

    const source = Readable.from(["chunk"]);
    source.pipe(res as unknown as NodeJS.WritableStream);
    source.unpipe(res as unknown as NodeJS.WritableStream);
    source.destroy();

    expect(events).toEqual(["pipe", "unpipe"]);
  });

  it("supports listener introspection and removal", async () => {
    const res = await makeResponse();
    const listener = () => {};
    res.on("finish", listener);
    expect(res.listenerCount("finish")).toBe(1);
    expect(res.eventNames()).toContain("finish");

    res.off("finish", listener);
    expect(res.listenerCount("finish")).toBe(0);

    res.once("close", () => {});
    res.removeAllListeners();
    expect(res.eventNames()).toHaveLength(0);
  });

  it("fires a once listener a single time", async () => {
    const res = await makeResponse();
    let calls = 0;
    res.once("drain", () => {
      calls++;
    });
    res.emit("drain");
    res.emit("drain");
    expect(calls).toBe(1);
  });
});

describe("BunResponse: response introspection for logging", () => {
  it("getBody returns the object passed to json", async () => {
    const res = await makeResponse();
    res.json({ user: "ada" });
    expect(res.getBody()).toEqual({ user: "ada" });
  });

  it("getBody returns the body passed to send", async () => {
    const res = await makeResponse();
    res.send("plain text");
    expect(res.getBody()).toBe("plain text");
  });

  it("getBody returns the reason phrase for sendStatus", async () => {
    const res = await makeResponse();
    res.sendStatus(404);
    expect(res.getBody()).toBe("Not Found");
  });

  it("getBody is undefined before a response is produced", async () => {
    const res = await makeResponse();
    expect(res.getBody()).toBeUndefined();
  });

  it("exposes status, headers and body together (pino-http style)", async () => {
    const res = await makeResponse();
    res.setHeader("X-Trace", "abc123");
    res.status(201).json({ created: true });

    // The shape a logging middleware reads to report the response.
    expect(res.statusCode).toBe(201);
    const headers = res.getHeaders();
    expect(headers["x-trace"]).toBe("abc123");
    expect(headers["content-type"]).toContain("application/json");
    expect(res.getBody()).toEqual({ created: true });
  });

  it("getBody accumulates the chunks of a streamed response", async () => {
    const res = await makeResponse();
    res.write("chunk-1");
    res.write("chunk-2");
    expect(res.getBody()).toEqual(["chunk-1", "chunk-2"]);
  });

  it("a finish listener can read the full response", async () => {
    const res = await makeResponse();
    let logged: { status: number; body: unknown } | undefined;
    res.on("finish", () => {
      logged = { status: res.statusCode, body: res.getBody() };
    });
    res.status(200).json({ ok: true });
    expect(logged).toEqual({ status: 200, body: { ok: true } });
  });
});

describe("BunResponse: upgradeToWebsocket default data", () => {
  it("includes the accepting server's port", async () => {
    const res = await makeResponse({ url: "http://localhost/ws?room=1" });
    res.upgradeToWebsocket();
    expect(res.upgradeToWsData?.port).toBe(testServer.port);
    expect(res.upgradeToWsData?.path).toBe("/ws");
  });

  it("leaves port absent when the server has none (the fetch stub)", async () => {
    const req = await BunRequest.init(
      new Request("http://localhost/ws"),
      FETCH_STUB_SERVER,
      { parseBody: false },
    );
    const res = new BunResponse(req);
    res.upgradeToWebsocket();
    expect(res.upgradeToWsData).toBeDefined();
    expect(res.upgradeToWsData && "port" in res.upgradeToWsData).toBe(false);
  });

  it("keeps data the caller passed as is", async () => {
    const res = await makeResponse();
    const data = {
      host: "h",
      path: "/",
      search: "",
      hash: "",
      originalUrl: "/",
      headers: new Headers(),
      custom: undefined,
    };
    res.upgradeToWebsocket(data);
    expect(res.upgradeToWsData).toBe(data);
  });
});

describe("BunResponse: keep-alive detection", () => {
  it("reports isLongLived only once setKeepAlive(true) is called", async () => {
    const res = await makeResponse();

    // Untouched socket: the shim is never built, and the response is not
    // long-lived — this is the path `headersSent` takes on every request.
    expect(res.isLongLived).toBe(false);
    expect(res.headersSent).toBe(false);

    res.req.socket.setKeepAlive(true);
    expect(res.req.isKeepAlive).toBe(true);
    expect(res.isLongLived).toBe(true);
    expect(res.headersSent).toBe(true);
  });

  it("setKeepAlive(false) leaves the response short-lived", async () => {
    const res = await makeResponse();
    res.req.socket.setKeepAlive(false);

    expect(res.req.isKeepAlive).toBe(false);
    expect(res.isLongLived).toBe(false);
  });

  it("isKeepAlive stays false while the socket shim is untouched", async () => {
    const res = await makeResponse();
    expect(res.req.isKeepAlive).toBe(false);
    // Reading the shim must not change the answer.
    expect(res.req.socket.keepAlive).toBe(false);
    expect(res.req.isKeepAlive).toBe(false);
  });
});

describe("BunResponse: removeAllListeners argument handling", () => {
  it("removes every listener when called with no argument", async () => {
    const res = await makeResponse();
    res.on("finish", () => {});
    res.once("close", () => {});
    res.on("error", () => {});

    res.removeAllListeners();

    expect(res.eventNames()).toHaveLength(0);
    expect(res.listenerCount("finish")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
    expect(res.listenerCount("error")).toBe(0);
  });

  it("removes only the named event when given one", async () => {
    const res = await makeResponse();
    res.on("finish", () => {});
    res.on("close", () => {});

    res.removeAllListeners("finish");

    expect(res.listenerCount("finish")).toBe(0);
    expect(res.listenerCount("close")).toBe(1);
    expect(res.eventNames()).toEqual(["close"]);
  });

  it("is a no-op before any listener is registered", async () => {
    const res = await makeResponse();
    expect(() => res.removeAllListeners()).not.toThrow();
    expect(res.eventNames()).toHaveLength(0);
  });
});

describe("BunResponse: Express parity", () => {
  it("204 strips Content-Type and Content-Length even for a string body", async () => {
    const res = await makeResponse();
    res.status(204).set("Content-Type", "text/html").set("Content-Length", "7");
    const native = await res.send("ignored").getNativeResponse(0);
    expect(native.headers.get("Content-Type")).toBeNull();
    expect(native.headers.get("Content-Length")).toBeNull();
    expect(await native.text()).toBe("");
  });

  it("sets the automatic ETag before freshness, so a match answers 304", async () => {
    const res = await makeResponse({
      headers: { "If-None-Match": etag("body") },
    });
    const native = await res.setEtag().send("body").getNativeResponse(0);
    expect(native.status).toBe(304);
    expect(native.headers.get("Content-Type")).toBeNull();
    expect(await native.text()).toBe("");
  });

  it("json() gets the automatic ETag and revalidates to 304", async () => {
    const first = await (await makeResponse())
      .setEtag()
      .json({ a: 1 })
      .getNativeResponse(0);
    expect(first.headers.get("ETag")).toBe(etag('{"a":1}'));
    expect(first.headers.get("Content-Type")).toBe("application/json");

    const again = await makeResponse({
      headers: { "If-None-Match": etag('{"a":1}') },
    });
    expect(
      (await again.setEtag().json({ a: 1 }).getNativeResponse(0)).status,
    ).toBe(304);
  });

  it("sendStatus() sets the status code, not just the body", async () => {
    const res = await makeResponse();
    res.sendStatus(301);
    const native = await res.getNativeResponse(0);
    expect(native.status).toBe(301);
    expect(await native.text()).toBe("Moved Permanently");
  });

  it("attachment(path) uses the basename and the extension's type", async () => {
    const res = await makeResponse();
    expect(res.attachment("/var/data/report.csv")).toBe(res);
    expect(res.getHeader("Content-Disposition")).toBe(
      'attachment; filename="report.csv"',
    );
    expect(res.getHeader("Content-Type")).toBe("text/csv");

    const unicode = await makeResponse();
    unicode.attachment("résumé€.pdf");
    expect(unicode.getHeader("Content-Disposition")).toBe(
      `attachment; filename="résumé?.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%E2%82%AC.pdf`,
    );
  });

  it("type() maps a name or extension to a media type", async () => {
    const res = await makeResponse();
    expect(res.type("json").get("Content-Type")).toBe("application/json");
    expect(res.type(".html").get("Content-Type")).toBe("text/html");
    expect(res.type("application/x-custom").get("Content-Type")).toBe(
      "application/x-custom",
    );
    expect(res.type("no-such-ext").get("Content-Type")).toBe(
      "application/octet-stream",
    );
  });

  it("location('back') reads the standard Referer header", async () => {
    const res = await makeResponse({ headers: { Referer: "/from" } });
    expect(res.location("back").getHeader("Location")).toBe("/from");
  });

  it("format() with no match and no default answers 406", async () => {
    const res = await makeResponse({ headers: { Accept: "image/png" } });
    res.format({ json: (_req, r) => r.json({}) });
    const native = await res.getNativeResponse(0);
    expect(native.status).toBe(406);
    expect(res.getHeader("Vary")).toBe("Accept");
  });

  it("format() passes a 406 error to req.next when the pipeline provides one", async () => {
    const res = await makeResponse({ headers: { Accept: "image/png" } });
    let received: unknown;
    Object.assign(res.req, {
      next: (err: unknown) => {
        received = err;
      },
    });
    res.format({ json: (_req, r) => r.json({}) });
    expect(received).toMatchObject({
      status: 406,
      types: ["application/json"],
    });
    expect(res.headersSent).toBe(false);
  });

  it("end(object) on a stream throws ERR_INVALID_ARG_TYPE, as Node, and streams nothing", async () => {
    const res = await makeResponse();
    res.write("a");
    // `Reflect.apply`: plain JS can pass what the types rule out.
    const error = thrownBy(() => Reflect.apply(res.end, res, [{ a: 1 }]));
    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
    expect((error as TypeError).message).toContain(
      "Received an instance of Object",
    );

    // The stream is still open, and no "[object Object]" reached it.
    await res.end("b");
    const native = await res.getNativeResponse(0);
    expect(await native.text()).toBe("ab");
  });

  it("end(object) without a stream throws too, sending nothing", async () => {
    const res = await makeResponse();
    const error = thrownBy(() => Reflect.apply(res.end, res, [{ a: 1 }]));
    expect(error).toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
    expect(res.headersSent).toBe(false);
  });

  it("write() rejects a non-chunk as Node: ERR_INVALID_ARG_TYPE, null ERR_STREAM_NULL_VALUES", async () => {
    const res = await makeResponse();
    const number = thrownBy(() => Reflect.apply(res.write, res, [123]));
    expect(number).toBeInstanceOf(TypeError);
    expect(number).toMatchObject({ code: "ERR_INVALID_ARG_TYPE" });
    expect((number as TypeError).message).toContain(
      "Received type number (123)",
    );
    const nullChunk = thrownBy(() => Reflect.apply(res.write, res, [null]));
    expect(nullChunk).toMatchObject({ code: "ERR_STREAM_NULL_VALUES" });
    expect(res.isLongLived).toBe(false);
  });

  it("write() after send([...]) answers false, emits ERR_STREAM_WRITE_AFTER_END and leaves the body alone", async () => {
    const res = await makeResponse();
    const errors: unknown[] = [];
    res.on("error", (error) => {
      errors.push(error);
    });
    const body = [1, 2];
    res.send(body);

    expect(res.write("late")).toBe(false);
    // Emitted on the next tick, as Node's `OutgoingMessage`.
    expect(errors).toEqual([]);
    await nextTick();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "ERR_STREAM_WRITE_AFTER_END",
      message: "write after end",
    });

    // The caller's array is untouched, and still what was sent.
    expect(body).toEqual([1, 2]);
    expect(res.getBody()).toBe(body);
    expect(res.isLongLived).toBe(false);
    const native = await res.getNativeResponse(0);
    expect(await native.json()).toEqual([1, 2]);
  });

  it("write() and end(chunk) after a stream ended are refused; end() alone is not an error", async () => {
    const res = await makeResponse();
    const errors: unknown[] = [];
    res.on("error", (error) => {
      errors.push(error);
    });
    res.write("a");
    await res.end();

    expect(res.write("b")).toBe(false);
    expect(await res.end("c")).toBe(res);
    expect(await res.end()).toBe(res);
    await nextTick();
    expect(errors).toHaveLength(2);
    expect(res.getBody()).toEqual(["a"]);
  });

  it("end() on a stream resolves the response and flushes unpulled writes", async () => {
    const res = await makeResponse();
    res.write("a");
    res.write("b");
    const ended = res.end("c");
    const native = await res.getNativeResponse(0);
    expect(await native.text()).toBe("abc");
    expect(await ended).toBe(res);
  });

  it("end() after a microtask still delivers every chunk", async () => {
    const res = await makeResponse();
    const reader = (
      await (async () => {
        res.write("one ");
        return res.getNativeResponse(0);
      })()
    ).body!.getReader();
    res.write("two");
    await res.end();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += new TextDecoder().decode(value);
    }
    expect(text).toBe("one two");
  });

  it("a first write() keeps a Content-Type already set and adds no header, as Node", async () => {
    const res = await makeResponse();
    res.setHeader("Content-Type", "application/x-ndjson");
    res.write('{"n":1}\n');
    expect(res.get("Content-Type")).toBe("application/x-ndjson");
    expect(res.get("Cache-Control")).toBeUndefined();
    expect(res.get("Connection")).toBeUndefined();
    const native = await res.getNativeResponse(0);
    expect(native.headers.get("content-type")).toBe("application/x-ndjson");
    expect(native.headers.get("cache-control")).toBeNull();
    await res.end();
    expect(await native.text()).toBe('{"n":1}\n');
  });

  it("a plain write() with no Content-Type sets none", async () => {
    const res = await makeResponse();
    res.write("chunk");
    expect(res.get("Content-Type")).toBeUndefined();
    const native = await res.getNativeResponse(0);
    expect(native.headers.get("content-type")).toBeNull();
    expect(native.headers.get("cache-control")).toBeNull();
    await res.end();
    expect(await native.text()).toBe("chunk");
  });

  it("writeHead() headers survive flushHeaders() and write(), as NestJS's @Sse() sets them", async () => {
    const res = await makeResponse();
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "Cache-Control":
        "private, no-cache, no-store, must-revalidate, max-age=0, no-transform",
    });
    expect(res.flushHeaders()).toBe(true);
    res.write("data: hi\n\n");
    const native = await res.getNativeResponse(0);
    expect(native.headers.get("content-type")).toBe("text/event-stream");
    expect(native.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, must-revalidate, max-age=0, no-transform",
    );
    await res.end();
    expect(await native.text()).toBe("data: hi\n\n");
  });

  it("cookie() accepts object values and string maxAge without casts, and leaves opts untouched", async () => {
    const res = await makeResponse();
    const opts = { maxAge: "60000" };
    res.cookie("prefs", { theme: "dark" }, opts);
    const line = res.getHeader("Set-Cookie")?.[0] ?? "";
    expect(line).toContain(`prefs=${encodeURIComponent('j:{"theme":"dark"}')}`);
    expect(line).toContain("Max-Age=60");
    expect(opts).toEqual({ maxAge: "60000" });

    const signed = await makeResponse();
    signed.cookie("s", 42, { signed: true, secret: "k" });
    expect(signed.getHeader("Set-Cookie")?.[0]).toContain(
      encodeURIComponent(`s:${signCookie("42", "k")}`),
    );
  });

  it("send() accepts a number", async () => {
    const res = await makeResponse();
    const native = await res.send(42).getNativeResponse(0);
    expect(await native.text()).toBe("42");
  });

  it("jsonp() wraps the body in the callback from the query", async () => {
    const res = await makeResponse({ url: "http://localhost/?callback=cb.fn" });
    const native = await res.jsonp({ a: 1 }).getNativeResponse(0);
    expect(native.headers.get("Content-Type")).toBe("text/javascript");
    expect(native.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await native.text()).toBe(
      `/**/ typeof cb.fn === 'function' && cb.fn({"a":1});`,
    );

    const plain = await makeResponse();
    const plainNative = await plain.jsonp({ a: 1 }).getNativeResponse(0);
    expect(plainNative.headers.get("Content-Type")).toBe("application/json");
    expect(await plainNative.text()).toBe('{"a":1}');
  });
});

describe("BunResponse: sendFile follows Express / send", () => {
  let dir = "";
  const body = "a,b\n1,2\n";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "bun-common-sendfile-"));
    await Bun.write(join(dir, "report.csv"), body);
    await Bun.write(join(dir, ".secret"), "hidden");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function served(
    path: string,
    options?: Parameters<BunResponse["sendFile"]>[1],
    headers: Record<string, string> = {},
  ) {
    const res = await makeResponse({ headers });
    await res.sendFile(path, options);
    return { res, native: await res.getNativeResponse(0) };
  }

  it("writes the file's real mtime and the default caching headers", async () => {
    const { native } = await served("report.csv", { root: dir });
    expect(native.status).toBe(200);
    expect(native.headers.get("Last-Modified")).toBe(
      new Date(Bun.file(join(dir, "report.csv")).lastModified).toUTCString(),
    );
    expect(native.headers.get("Cache-Control")).toBe("public, max-age=0");
    expect(native.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await native.text()).toBe(body);
  });

  it("maxAge is milliseconds or an ms string", async () => {
    expect(
      (
        await served("report.csv", { root: dir, maxAge: 60_000 })
      ).native.headers.get("Cache-Control"),
    ).toBe("public, max-age=60");
    expect(
      (
        await served("report.csv", { root: dir, maxAge: "1h", immutable: true })
      ).native.headers.get("Cache-Control"),
    ).toBe("public, max-age=3600, immutable");
  });

  it("keeps a Cache-Control already set, with or without cacheControl", async () => {
    const res = await makeResponse();
    res.set("Cache-Control", "no-store");
    await res.sendFile("report.csv", { root: dir, maxAge: 60_000 });
    expect(res.getHeader("Cache-Control")).toBe("no-store");

    const off = await makeResponse();
    off.set("Cache-Control", "no-store");
    await off.sendFile("report.csv", { root: dir, cacheControl: false });
    expect(off.getHeader("Cache-Control")).toBe("no-store");
    expect(
      (
        await served("report.csv", {
          root: dir,
          cacheControl: false,
          lastModified: false,
        })
      ).native.headers.get("Cache-Control"),
    ).toBeNull();
  });

  it("an absolute path needs no root; a relative one without root throws", async () => {
    expect((await served(join(dir, "report.csv"))).native.status).toBe(200);
    const res = await makeResponse();
    await expect(res.sendFile("report.csv")).rejects.toThrow(TypeError);
  });

  it("with root, an absolute path resolves under root and .. is forbidden", async () => {
    expect((await served("/report.csv", { root: dir })).native.status).toBe(
      200,
    );
    expect((await served("../report.csv", { root: dir })).native.status).toBe(
      403,
    );
  });

  it("dotfiles: ignore (default) 404, deny 403, allow serves", async () => {
    expect((await served(".secret", { root: dir })).native.status).toBe(404);
    expect(
      (await served(".secret", { root: dir, dotfiles: "deny" })).native.status,
    ).toBe(403);
    const allowed = await served(".secret", { root: dir, dotfiles: "allow" });
    expect(allowed.native.status).toBe(200);
    expect(await allowed.native.text()).toBe("hidden");
  });

  it("acceptRanges serves a single range as 206 and rejects an unsatisfiable one", async () => {
    const partial = await served(
      "report.csv",
      { root: dir },
      { Range: "bytes=0-2" },
    );
    expect(partial.native.status).toBe(206);
    expect(partial.native.headers.get("Content-Range")).toBe("bytes 0-2/8");
    expect(await partial.native.text()).toBe("a,b");

    const unsatisfiable = await served(
      "report.csv",
      { root: dir },
      { Range: "bytes=100-200" },
    );
    expect(unsatisfiable.native.status).toBe(416);
    expect(unsatisfiable.native.headers.get("Content-Range")).toBe("bytes */8");
  });

  it("acceptRanges: false (and the deprecated accepRanges) ignores Range", async () => {
    for (const options of [
      { root: dir, acceptRanges: false },
      { root: dir, accepRanges: false },
    ]) {
      const { native } = await served("report.csv", options, {
        Range: "bytes=0-2",
      });
      expect(native.status).toBe(200);
      expect(native.headers.get("Accept-Ranges")).toBeNull();
      expect(await native.text()).toBe(body);
    }
  });

  it("answers 304 to a fresh conditional request", async () => {
    const { native } = await served(
      "report.csv",
      { root: dir },
      {
        "If-Modified-Since": new Date(Date.now() + 60_000).toUTCString(),
      },
    );
    expect(native.status).toBe(304);
  });

  it("download() without a filename uses the basename", async () => {
    const res = await makeResponse();
    await res.download(join(dir, "report.csv"));
    expect(res.getHeader("Content-Disposition")).toBe(
      'attachment; filename="report.csv"',
    );
  });
});
