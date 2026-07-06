import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  DEFAULT_PARSE_QUERY_OPTS,
  handleMultipartAnyFiles,
  transformUploadOptions,
} from "../lib";
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
    expect(req.path).toBe("/path");
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

  // A client that percent-encodes the array *structure* itself (`%5B` = `[`,
  // `%5D` = `]`). picoquery detects nesting before decoding, so bun-common
  // decodes just these brackets up front — safely, by default.
  const encodedArrayUrl =
    "http://localhost/?payrollrunid%5B0%5D=10186&payrollrunid%5B1%5D=10188&payrollrunid%5B2%5D=10190";

  it("builds arrays from encoded brackets by default (no option needed)", async () => {
    const req = await makeRequest({ url: encodedArrayUrl });
    expect(req.query).toEqual({
      payrollrunid: ["10186", "10188", "10190"],
    });
  });

  it("decodes encoded brackets identically when full decodeURIComponent is on", async () => {
    const req = await makeRequest({
      url: encodedArrayUrl,
      options: {
        parseQueryOpts: {
          ...DEFAULT_PARSE_QUERY_OPTS,
          decodeURIComponent: true,
        },
      },
    });
    expect(req.query).toEqual({
      payrollrunid: ["10186", "10188", "10190"],
    });
  });

  it("does not double-decode a value's encoded delimiter under the default", async () => {
    // `%26` is a genuinely-encoded literal `&`. The default bracket-only decode
    // leaves it alone, so it stays part of the value (unlike a blanket decode).
    const req = await makeRequest({ url: "http://localhost/?q=a%26b" });
    expect(req.query).toEqual({ q: "a&b" });
  });

  it("leaves encoded brackets in a value unchanged (structure only)", async () => {
    // Brackets in the value position are not nesting syntax; the result is the
    // same whether or not they are pre-decoded.
    const req = await makeRequest({ url: "http://localhost/?q=%5Bx%5D" });
    expect(req.query).toEqual({ q: "[x]" });
  });

  it("honours the full decodeURIComponent flag via parseQuery()", async () => {
    const req = await makeRequest({
      url: encodedArrayUrl,
      options: { parseQuery: false },
    });
    // Default parse already builds the array from the encoded brackets.
    expect(req.parseQuery()).toEqual({
      payrollrunid: ["10186", "10188", "10190"],
    });
    // The full-decode escape hatch yields the same result here.
    expect(
      req.parseQuery({
        ...DEFAULT_PARSE_QUERY_OPTS,
        decodeURIComponent: true,
      }),
    ).toEqual({ payrollrunid: ["10186", "10188", "10190"] });
  });

  it("double-decodes encoded delimiters only when decodeURIComponent is on", async () => {
    // The documented trade-off: `%26` is a genuinely-encoded literal `&`.
    // Without the option it stays part of the value; with it, it splits.
    const encodedDelimiterUrl = "http://localhost/?q=a%26b";

    const off = await makeRequest({ url: encodedDelimiterUrl });
    expect(off.query).toEqual({ q: "a&b" });

    const on = await makeRequest({
      url: encodedDelimiterUrl,
      options: {
        parseQueryOpts: {
          ...DEFAULT_PARSE_QUERY_OPTS,
          decodeURIComponent: true,
        },
      },
    });
    expect(on.query).toEqual({ q: "a", b: "" });
  });

  it("falls back to the raw string on a malformed percent-sequence", async () => {
    // `%E0%A4%A` is an incomplete UTF-8 sequence — decodeURIComponent throws,
    // so parsing must not blow up and should use the raw string instead.
    const req = await makeRequest({
      url: "http://localhost/?bad=%E0%A4%A&ok=1",
      options: {
        parseQueryOpts: {
          ...DEFAULT_PARSE_QUERY_OPTS,
          decodeURIComponent: true,
        },
      },
    });
    expect(req.query).toEqual({ bad: "%E0%A4%A", ok: "1" });
  });

  it("uses a custom decode function when provided", async () => {
    // A bespoke decoder that swaps a `~` separator for `&` before parsing.
    const req = await makeRequest({
      url: "http://localhost/?a=1~b=2",
      options: {
        parseQueryOpts: {
          ...DEFAULT_PARSE_QUERY_OPTS,
          decode: (query) => query.replace(/~/g, "&"),
        },
      },
    });
    expect(req.query).toEqual({ a: "1", b: "2" });
  });

  it("lets the custom decode function override decodeURIComponent", async () => {
    // Both are set; `decode` wins, so `%26` is left encoded (not split).
    const req = await makeRequest({
      url: "http://localhost/?q=a%26b",
      options: {
        parseQueryOpts: {
          ...DEFAULT_PARSE_QUERY_OPTS,
          decodeURIComponent: true,
          decode: (query) => query,
        },
      },
    });
    expect(req.query).toEqual({ q: "a&b" });
  });

  it("falls back to the default bracket decode when custom decode throws", async () => {
    const req = await makeRequest({
      url: encodedArrayUrl,
      options: {
        parseQueryOpts: {
          ...DEFAULT_PARSE_QUERY_OPTS,
          decode: () => {
            throw new Error("boom");
          },
        },
      },
    });
    // The thrown decoder is ignored; encoded brackets still build the array.
    expect(req.query).toEqual({
      payrollrunid: ["10186", "10188", "10190"],
    });
  });

  it("honours a custom decode function passed straight to parseQuery()", async () => {
    const req = await makeRequest({
      url: "http://localhost/?a=1~b=2",
      options: { parseQuery: false },
    });
    expect(
      req.parseQuery({
        ...DEFAULT_PARSE_QUERY_OPTS,
        decode: (query) => query.replace(/~/g, "&"),
      }),
    ).toEqual({ a: "1", b: "2" });
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

  it("keeps the path query-free but exposes it via search / originalUrl", async () => {
    const req = await makeRequest({ url: "http://localhost/search?q=bun" });
    expect(req.path).toBe("/search");
    expect(req.search).toBe("?q=bun");
    expect(req.querystring).toBe("q=bun");
    expect(req.hash).toBe("");
    expect(req.originalUrl).toBe("/search?q=bun");
  });

  it("handles a query string with no path", async () => {
    const req = await makeRequest({ url: "http://localhost?q=1" });
    expect(req.path).toBe("/");
    expect(req.search).toBe("?q=1");
    expect(req.originalUrl).toBe("/?q=1");
    expect(req.query).toEqual({ q: "1" });
  });

  it("splits a hash fragment out of the path", async () => {
    const req = await makeRequest({ url: "http://localhost/page#section" });
    expect(req.path).toBe("/page");
    expect(req.search).toBe("");
    expect(req.hash).toBe("#section");
    expect(req.originalUrl).toBe("/page#section");
  });

  it("splits query and hash out of the path, keeping order in originalUrl", async () => {
    const req = await makeRequest({ url: "http://localhost/p?a=1#frag" });
    expect(req.path).toBe("/p");
    expect(req.search).toBe("?a=1");
    expect(req.querystring).toBe("a=1");
    expect(req.hash).toBe("#frag");
    expect(req.originalUrl).toBe("/p?a=1#frag");
  });

  it("treats a '?' after a '#' as part of the fragment", async () => {
    const req = await makeRequest({ url: "http://localhost/p#frag?notquery" });
    expect(req.path).toBe("/p");
    expect(req.search).toBe("");
    expect(req.hash).toBe("#frag?notquery");
    expect(req.query).toEqual({});
  });

  it("reports empty search / hash for a plain path", async () => {
    const req = await makeRequest({ url: "http://localhost/users" });
    expect(req.search).toBe("");
    expect(req.querystring).toBe("");
    expect(req.hash).toBe("");
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
    expect(req.path).toBe(parsed.pathname);
    expect(req.search).toBe(parsed.search);
    expect(req.hash).toBe(parsed.hash);
    expect(req.originalUrl).toBe(
      `${parsed.pathname}${parsed.search}${parsed.hash}`,
    );
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

describe("BunRequest: XML body parsing", () => {
  it("parses an application/xml body", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: "<note><to>Tove</to><from>Jani</from></note>",
    });
    const parsed = await req.parseBody();
    expect(parsed.contentType).toBe("xml");
    expect(req.body).toEqual({ note: { to: "Tove", from: "Jani" } });
  });

  it("parses a text/xml body", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: `<list><item>a</item><item>b</item></list>`,
    });
    const parsed = await req.parseBody();
    expect(parsed.contentType).toBe("xml");
    expect(req.body).toEqual({ list: { item: ["a", "b"] } });
  });

  it("parses a +xml suffixed media type", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/rss+xml" },
      body: `<rss version="2.0"><channel>news</channel></rss>`,
    });
    expect((await req.parseBody()).contentType).toBe("xml");
    expect(req.body).toEqual({
      rss: { "@_version": 2, channel: "news" },
    });
  });

  it("honours custom XML parser options", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: `<a x="1"><b>2</b></a>`,
      options: { parseXmlOpts: { ignoreAttributes: true } },
    });
    await req.parseBody();
    expect(req.body).toEqual({ a: { b: 2 } });
  });

  it("auto-detects an XML body without a Content-Type", async () => {
    const req = await makeRequest({
      method: "POST",
      body: "<root><a>1</a></root>",
    });
    const parsed = await req.parseBody();
    expect(parsed.contentType).toBe("xml");
    expect(req.body).toEqual({ root: { a: 1 } });
  });
});

describe("BunRequest: allowedContentTypes", () => {
  it("leaves a disallowed XML body as a raw buffer, preserving its header", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: "<a>1</a>",
      options: { allowedContentTypes: ["json", "urlencoded"] },
    });
    const parsed = await req.parseBody();
    expect(parsed.contentType).toBe("buffer");
    expect(Buffer.isBuffer(req.body)).toBe(true);
    expect((req.body as Buffer).toString()).toBe("<a>1</a>");
    expect(req.getHeader("Content-Type")).toContain("application/xml");
  });

  it("leaves a disallowed JSON body unparsed", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
      options: { allowedContentTypes: ["xml"] },
    });
    const parsed = await req.parseBody();
    expect(parsed.contentType).toBe("buffer");
    expect(Buffer.isBuffer(req.body)).toBe(true);
    expect((req.body as Buffer).toString()).toBe(`{"a":1}`);
  });

  it("still parses an allowed content type", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
      options: { allowedContentTypes: ["json"] },
    });
    await req.parseBody();
    expect(req.body).toEqual({ a: 1 });
  });

  it("skips auto-detection for omitted kinds without a Content-Type", async () => {
    const req = await makeRequest({
      method: "POST",
      body: JSON.stringify({ a: 1 }),
      options: { allowedContentTypes: ["xml"] },
    });
    const parsed = await req.parseBody();
    expect(parsed.contentType).toBe("buffer");
    expect(Buffer.isBuffer(req.body)).toBe(true);
  });

  it("can be toggled at runtime via setAllowedContentTypes", async () => {
    const req = await makeRequest({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
      options: { allowedContentTypes: ["xml"] },
    });
    // Initially disallowed → raw buffer.
    expect((await req.parseBody()).contentType).toBe("buffer");
    // Re-allow JSON and re-parse from scratch.
    req.setAllowedContentTypes(["json"]);
    const parsed = await req.parseBody(true);
    expect(parsed.contentType).toBe("json");
    expect(req.body).toEqual({ a: 1 });
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

  it("emits aborted then close when the connection aborts before a response", async () => {
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

    controller.abort();
    await Bun.sleep(1);
    expect(order).toEqual(["aborted", "close"]);
    expect(req.aborted).toBe(true);
  });

  it("emits only close (not aborted) once a response has been produced", async () => {
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

    // A response was produced — a later drop is a close, not an abort.
    req.markResponded();
    controller.abort();
    await Bun.sleep(1);
    expect(order).toEqual(["close"]);
    expect(req.aborted).toBe(false);
  });

  it("BunResponse producing a response marks the request as responded", async () => {
    const controller = new AbortController();
    const request = new Request("http://localhost/stream", {
      signal: controller.signal,
    });
    const req = await BunRequest.init(request, testServer, {
      parseBody: false,
      parseCookies: false,
      parseQuery: false,
    });
    const res = new BunResponse(req);

    let aborted = false;
    req.on("aborted", () => {
      aborted = true;
    });

    res.json({ ok: true });
    await res.getNativeResponse(1000);
    controller.abort();
    await Bun.sleep(1);
    // The response certified the request — the drop is not an abort.
    expect(aborted).toBe(false);
    expect(req.aborted).toBe(false);
  });

  it("streams the request body as data then end events", async () => {
    const req = await makeRequest({ method: "POST", body: "hello body" });

    const chunks: string[] = [];
    let ended = false;
    req.on("data", (chunk) => chunks.push(chunk.toString()));
    req.on("end", () => {
      ended = true;
    });

    await Bun.sleep(1);
    expect(chunks.join("")).toBe("hello body");
    expect(ended).toBe(true);
    expect(req.complete).toBe(true);
  });

  it("replays body events to a listener that subscribes late", async () => {
    const req = await makeRequest({ method: "POST", body: "late body" });
    // The body has long finished parsing by now — a fresh subscriber still
    // receives the data/end replay.
    await Bun.sleep(1);

    const chunks: string[] = [];
    let ended = false;
    req.on("data", (chunk) => chunks.push(chunk.toString()));
    req.on("end", () => {
      ended = true;
    });

    await Bun.sleep(1);
    expect(chunks.join("")).toBe("late body");
    expect(ended).toBe(true);
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
