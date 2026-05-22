import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { handleMultipartAnyFiles, transformUploadOptions } from "../lib";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRequest } from "../lib/BunRequest";
import { BunResponse } from "../lib/BunResponse";
import { makeRequest, testServer } from "./helpers";

let httpAdapter!: BunHttpAdapter;

beforeAll(async () => {
  httpAdapter = new BunHttpAdapter(30000);
  httpAdapter.registerParserMiddleware(undefined, true);
  httpAdapter.post("/test", async (req, res) => {
    return res.json(req.body as Record<string, unknown>);
  });
  await httpAdapter.listen(0);
});

afterAll(async () => {
  await httpAdapter?.close();
});

const buildUrl = (path: string, adapter: BunHttpAdapter = httpAdapter) =>
  `http://${adapter.listeningHost}:${adapter.listeningPort}${path}`;

describe("BunRequest: construction & basics", () => {
  it("initialises from a native Request", async () => {
    const req = await makeRequest({ url: "http://localhost/path?x=1" });
    expect(req).toBeInstanceOf(BunRequest);
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/path?x=1");
    expect(req.hostname).toBe("localhost");
  });

  it("parses the query string", async () => {
    const req = await makeRequest({
      url: "http://localhost/?a=1&b[c]=2",
    });
    expect(req.query).toEqual({ a: "1", b: { c: "2" } });
  });

  it("parses dotted, bracketed, indexed and repeated query keys", async () => {
    const req = await makeRequest({
      url: "http://localhost/?user.name=ada&items[0]=x&items[1]=y&tag=a&tag=b",
    });
    expect(req.query).toEqual({
      user: { name: "ada" },
      items: ["x", "y"],
      tag: ["a", "b"],
    });
  });

  it("returns an empty object for a request without a query string", async () => {
    const req = await makeRequest({ url: "http://localhost/path" });
    expect(req.query).toEqual({});
  });

  it("derives protocol from X-Forwarded-Proto", async () => {
    const req = await makeRequest({
      headers: { "X-Forwarded-Proto": "https, http" },
    });
    expect(req.protocol).toBe("https");
    expect(req.secure).toBe(true);
  });

  it("reports xhr based on X-Requested-With", async () => {
    const xhr = await makeRequest({
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    expect(xhr.xhr).toBe(true);
    const plain = await makeRequest();
    expect(plain.xhr).toBe(false);
  });
});

describe("BunRequest: URL parsing with diverse characters", () => {
  it("parses a simple path", async () => {
    const req = await makeRequest({ url: "http://localhost/users" });
    expect(req.path).toBe("/users");
    expect(req.originalUrl).toBe("/users");
    expect(req.host).toBe("localhost");
    expect(req.hostname).toBe("localhost");
  });

  it("treats the root path correctly", async () => {
    const req = await makeRequest({ url: "http://localhost/" });
    expect(req.path).toBe("/");
  });

  it("normalizes a host-only URL to the root path", async () => {
    const req = await makeRequest({ url: "http://localhost" });
    expect(req.path).toBe("/");
    expect(req.host).toBe("localhost");
  });

  it("keeps the query string in path / originalUrl", async () => {
    const req = await makeRequest({ url: "http://localhost/search?q=bun" });
    expect(req.path).toBe("/search?q=bun");
    expect(req.originalUrl).toBe("/search?q=bun");
  });

  it("handles a query string with no path", async () => {
    const req = await makeRequest({ url: "http://localhost?q=1" });
    expect(req.path).toBe("/?q=1");
    expect(req.query).toEqual({ q: "1" });
  });

  it("keeps a hash fragment in the path", async () => {
    const req = await makeRequest({ url: "http://localhost/page#section" });
    expect(req.path).toBe("/page#section");
  });

  it("keeps query and hash together", async () => {
    const req = await makeRequest({ url: "http://localhost/p?a=1#frag" });
    expect(req.path).toBe("/p?a=1#frag");
  });

  it("preserves percent-encoded characters in the path", async () => {
    const req = await makeRequest({
      url: "http://localhost/files/my%20file%20(1).txt",
    });
    expect(req.path).toBe("/files/my%20file%20(1).txt");
  });

  it("encodes and preserves non-ASCII path characters", async () => {
    const req = await makeRequest({ url: "http://localhost/café/menü" });
    expect(req.path).toBe("/caf%C3%A9/men%C3%BC");
  });

  it("preserves semicolons and matrix-style segments", async () => {
    const req = await makeRequest({ url: "http://localhost/x;y=z/a" });
    expect(req.path).toBe("/x;y=z/a");
  });

  it("preserves consecutive slashes", async () => {
    const req = await makeRequest({ url: "http://localhost//a//b//" });
    expect(req.path).toBe("//a//b//");
  });

  it("resolves dot and dot-dot path segments", async () => {
    const dotDot = await makeRequest({ url: "http://localhost/a/b/../c" });
    expect(dotDot.path).toBe("/a/c");
    const dot = await makeRequest({ url: "http://localhost/a/./b" });
    expect(dot.path).toBe("/a/b");
  });

  it("extracts the host with a port", async () => {
    const req = await makeRequest({ url: "http://localhost:8080/api" });
    expect(req.host).toBe("localhost:8080");
    expect(req.hostname).toBe("localhost");
    expect(req.path).toBe("/api");
  });

  it("strips userinfo from the host", async () => {
    const req = await makeRequest({ url: "http://user:pass@localhost/x" });
    expect(req.host).toBe("localhost");
    expect(req.path).toBe("/x");
  });

  it("handles an IPv6 host", async () => {
    const req = await makeRequest({ url: "http://[::1]:3000/health" });
    expect(req.host).toBe("[::1]:3000");
    expect(req.path).toBe("/health");
  });

  it("decodes percent-encoded query values", async () => {
    const req = await makeRequest({
      url: "http://localhost/s?q=hello%20world&tag=a%26b",
    });
    expect(req.query).toEqual({ q: "hello world", tag: "a&b" });
  });

  it("reports protocol and secure for an https URL", async () => {
    const req = await makeRequest({ url: "https://localhost/secure" });
    expect(req.protocol).toBe("https");
    expect(req.secure).toBe(true);
  });

  it("reports protocol and secure for an http URL", async () => {
    const req = await makeRequest({ url: "http://localhost/plain" });
    expect(req.protocol).toBe("http");
    expect(req.secure).toBe(false);
  });

  it("extracts subdomains from a multi-label host", async () => {
    const req = await makeRequest({ url: "http://api.staging.example.com/v1" });
    expect(req.host).toBe("api.staging.example.com");
    expect(req.subdomains).toEqual(["api", "staging"]);
  });

  it("has no subdomains for a bare host", async () => {
    const req = await makeRequest({ url: "http://example.com/" });
    expect(req.subdomains).toEqual([]);
  });

  it("agrees with the lazily-parsed URL object", async () => {
    const req = await makeRequest({
      url: "http://localhost:9000/a/b?x=1&y=2#h",
    });
    const parsed = req.parsedUrl;
    expect(req.path).toBe(`${parsed.pathname}${parsed.search}${parsed.hash}`);
    expect(req.host).toBe(parsed.host);
  });
});

describe("BunRequest: headers", () => {
  it("exposes header helpers", async () => {
    const req = await makeRequest({
      headers: { "X-Custom": "value", Accept: "application/json" },
    });
    expect(req.getHeader("x-custom")).toBe("value");
    expect(req.hasHeader("Accept")).toBe(true);
    expect(req.getHeaderNames()).toContain("x-custom");
  });

  it("sets and removes headers", async () => {
    const req = await makeRequest();
    req.setHeader("X-New", "1");
    expect(req.getHeader("X-New")).toBe("1");
    req.removeHeader("X-New");
    expect(req.hasHeader("X-New")).toBe(false);
  });

  it("get returns a default when the header is absent", async () => {
    const req = await makeRequest();
    expect(req.get("X-Missing", "fallback")).toBe("fallback");
  });

  it("getRawHeaderNames title-cases header names", async () => {
    const req = await makeRequest({ headers: { "x-test": "1" } });
    expect(req.getRawHeaderNames()).toContain("X-Test");
  });
});

describe("BunRequest: cookies", () => {
  it("parses request cookies", async () => {
    const req = await makeRequest({
      headers: { Cookie: "a=1; b=hello" },
    });
    expect(req.cookies).toEqual({ a: "1", b: "hello" });
  });

  it("parses signed cookies with a secret", async () => {
    const plain = await makeRequest();
    plain.secret = "topsecret";
    const req = await makeRequest({
      headers: { Cookie: "session=s%3Avalue.invalidsig" },
    });
    req.secret = "topsecret";
    const parsed = req.parseCookies({ secret: "topsecret" });
    expect(parsed.cookies).toBeDefined();
  });
});

describe("BunRequest: content negotiation", () => {
  it("accepts resolves a matching type", async () => {
    const req = await makeRequest({
      headers: { Accept: "application/json" },
    });
    expect(req.accepts("json")).toBe("json");
    expect(req.accepts("html")).toBe(false);
  });

  it("is checks the Content-Type", async () => {
    const body = JSON.stringify({ a: 1 });
    const req = await makeRequest({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
      },
      body,
    });
    expect(req.is("json")).toBe("json");
    expect(req.is("html")).toBe(false);
  });

  it("range parses the Range header", async () => {
    const req = await makeRequest({ headers: { Range: "bytes=0-99" } });
    const parsed = req.range(1000, {});
    expect(Array.isArray(parsed)).toBe(true);
  });
});

describe("BunRequest: body parsing over HTTP", () => {
  it("parses a JSON body with Content-Type", async () => {
    const res = await fetch(buildUrl("/test"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "value" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "value" });
  });

  it("parses a URL-encoded body", async () => {
    const res = await fetch(buildUrl("/test"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "key=value",
    });
    expect(await res.json()).toEqual({ key: "value" });
  });

  it("parses a plain text body", async () => {
    const res = await fetch(buildUrl("/test"), {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "key=value",
    });
    expect(await res.text()).toBe(JSON.stringify("key=value"));
  });

  it("auto-detects JSON without a Content-Type", async () => {
    const res = await fetch(buildUrl("/test"), {
      method: "POST",
      body: JSON.stringify({ key: "value" }),
    });
    expect(await res.json()).toEqual({ key: "value" });
  });

  it("parses a raw octet-stream body", async () => {
    const adapter = new BunHttpAdapter(30000);
    adapter.registerParserMiddleware(undefined, true);
    adapter.instance.post("/test", async (req, res) => {
      return res.send(req.body?.toString());
    });
    await adapter.listen(0);

    try {
      const raw = Buffer.from([0x01, 0x02, 0x03]);
      const res = await fetch(buildUrl("/test", adapter), {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: raw,
      });
      expect(res.status).toBe(200);
      const echoed = Buffer.from(await res.arrayBuffer());
      expect(echoed.compare(raw as unknown as Uint8Array)).toBe(0);
    } finally {
      await adapter.close();
    }
  });

  it("auto-parses multipart form data with files and fields", async () => {
    const adapter = new BunHttpAdapter(30000);
    adapter.registerParserMiddleware(undefined, true);
    adapter.use(async (req, res, next) => {
      const { files, body } = await handleMultipartAnyFiles(
        req,
        transformUploadOptions({ storageType: "memory" }),
      );
      req.setStorageFiles(files);
      req.body = body;
      next();
    });
    adapter.instance.post("/test", async (req, res) => {
      return res.json({ files: req.files, body: req.body });
    });
    await adapter.listen(0);

    try {
      const formData = new FormData();
      formData.set("blob1", new Blob(["hello1"]));
      formData.set("blob2", new Blob(["hello2"]));
      formData.append("name", "0");
      formData.append("name", "1");
      formData.set("json", JSON.stringify({ key: "values" }));

      const res = await fetch(buildUrl("/test", adapter), {
        method: "POST",
        body: formData,
      });
      expect(res.status).toBe(200);

      const json = (await res.json()) as {
        files: { fieldname: string }[];
        body: Record<string, unknown>;
      };
      expect(Array.isArray(json.files)).toBe(true);
      expect(json.files).toHaveLength(2);
      expect(
        json.files.every((f) => ["blob1", "blob2"].includes(f.fieldname)),
      ).toBe(true);
      expect(typeof json.body).toBe("object");
    } finally {
      await adapter.close();
    }
  });
});

describe("BunRequest: IncomingMessage-style events", () => {
  it("emit returns false when nothing is listening", async () => {
    const req = await makeRequest();
    expect(req.emit("close")).toBe(false);
  });

  it("on returns the request for chaining", async () => {
    const req = await makeRequest();
    expect(req.on("close", () => {})).toBe(req);
  });

  it("does not allocate an emitter until a listener is registered", async () => {
    const req = await makeRequest();
    // No listeners yet — introspection works without forcing an emitter.
    expect(req.eventNames()).toHaveLength(0);
    expect(req.listenerCount("close")).toBe(0);
  });

  it("emits aborted, close and end when the connection aborts", async () => {
    const controller = new AbortController();
    const request = new Request("http://localhost/stream", {
      signal: controller.signal,
    });
    const req = await BunRequest.init(request, testServer, {
      parseBody: false,
      parseCookies: false,
      parseQuery: false,
    });

    const order: string[] = [];
    req.on("aborted", () => order.push("aborted"));
    req.on("close", () => order.push("close"));
    req.on("end", () => order.push("end"));

    controller.abort();
    await Bun.sleep(1);
    expect(order).toEqual(["aborted", "close", "end"]);
  });

  it("fires a once listener a single time", async () => {
    const req = await makeRequest();
    let calls = 0;
    req.once("close", () => {
      calls++;
    });
    req.emit("close");
    req.emit("close");
    expect(calls).toBe(1);
  });

  it("emits abort when a streaming response bound to it is cancelled", async () => {
    const req = await makeRequest();
    const res = new BunResponse(req);

    let abortReason: unknown;
    req.on("abort", (reason) => {
      abortReason = reason;
    });

    // Open the response's writable stream, then abort it.
    res.write("data");
    await res.getWritable().abort("client gone");

    expect(abortReason).toBe("client gone");
  });

  it("supports listener introspection and removal", async () => {
    const req = await makeRequest();
    const listener = () => {};
    req.on("close", listener);
    expect(req.listenerCount("close")).toBe(1);
    expect(req.eventNames()).toContain("close");

    req.off("close", listener);
    expect(req.listenerCount("close")).toBe(0);

    req.once("end", () => {});
    req.removeAllListeners();
    expect(req.eventNames()).toHaveLength(0);
  });
});
