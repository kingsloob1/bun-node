import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { describe, expect, it } from "bun:test";
import { BunResponse } from "../lib/BunResponse";
import { makeRequest, makeResponse } from "./helpers";

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

  it("sendStatus writes the status as the body", async () => {
    const res = await makeResponse();
    res.sendStatus(404);
    const native = await res.getNativeResponse(1000);
    expect(await native.text()).toBe("404");
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
});

describe("BunResponse: cookies", () => {
  it("cookie appends a Set-Cookie header", async () => {
    const res = await makeResponse();
    res.cookie("session", "abc", { path: "/", httpOnly: true });
    expect(res.getHeader("Set-Cookie")).toContain("session=abc");
    expect(res.getHeader("Set-Cookie")).toContain("HttpOnly");
  });

  it("clearCookie expires the cookie", async () => {
    const res = await makeResponse();
    res.clearCookie("session", undefined);
    expect(res.getHeader("Set-Cookie")).toContain("session=");
    expect(res.getHeader("Set-Cookie")).toContain("Expires=");
  });

  it("cookie signs values when requested", async () => {
    const res = await makeResponse();
    res.cookie("token", "value", { signed: true, secret: "shh" });
    expect(res.getHeader("Set-Cookie")).toContain("token=s%3A");
  });

  it("cookie defaults the path to / even when no options are passed", async () => {
    const res = await makeResponse();
    res.cookie("plain", "value");
    expect(res.getHeader("Set-Cookie")).toContain("plain=value");
    expect(res.getHeader("Set-Cookie")).toContain("Path=/");
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

  it("getBody returns the status string for sendStatus", async () => {
    const res = await makeResponse();
    res.sendStatus(404);
    expect(res.getBody()).toBe("404");
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
