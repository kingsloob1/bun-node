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
