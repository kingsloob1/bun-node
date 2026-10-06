import { describe, expect, it } from "bun:test";
import { signCookie } from "../lib";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRequest } from "../lib/BunRequest";
import { BunResponse } from "../lib/BunResponse";
import { BunRouter, RequestPipelineOptions } from "../lib/BunRouter";
import { testServer } from "./helpers";

/**
 * Building a request does no work its result does not need: no query
 * string means no query parse or object, no `Cookie` header no cookie parse
 * or objects, no body a shared empty buffer, and the caller's options are
 * never copied for leaving `parseQuery`/`parseCookies` unset. None of it may
 * be observable — these pin what each lazily-built value looks like.
 */

const build = (
  url: string,
  options: ConstructorParameters<typeof BunRequest>[2] = {
    parseBody: true,
    parseCookies: true,
  },
  headers?: Record<string, string>,
) =>
  BunRequest.init(
    new Request(url, { headers }),
    testServer,
    options,
  ) as BunRequest;

describe("BunRequest construction: values built on first read", () => {
  it("an absent query reads as the parser's empty result", () => {
    const empty = build("http://h/p");
    const parsed = build("http://h/p?a=1");
    expect(empty.query).toEqual({});
    // Same prototype as a parsed query (picoquery's), not Object.prototype.
    expect(Object.getPrototypeOf(empty.query)).toBe(
      Object.getPrototypeOf(parsed.query),
    );
    expect(empty.query).toBe(empty.query);
    // A bare `?` parses to the same.
    expect(build("http://h/p?").query).toEqual({});
  });

  it("with query parsing off, req.query is a plain empty object", () => {
    const req = build("http://h/p?a=1", {
      parseBody: false,
      parseQuery: false,
    });
    expect(req.query).toEqual({});
    expect(Object.getPrototypeOf(req.query)).toBe(Object.prototype);
  });

  it("still calls a custom decode for an empty query string, as before", () => {
    // Values taken from the previous implementation: the decode runs once
    // even for an empty query, and receives the raw text around `=`.
    let calls = 0;
    const empty = build("http://h/p", {
      parseBody: false,
      parseQuery: {
        decode: (value: string) => {
          calls++;
          return value;
        },
      },
    });
    expect(calls).toBe(1);
    expect(empty.query).toEqual({});
    const req = build("http://h/p?x=%41", {
      parseBody: false,
      parseQuery: { decode: (value: string) => `<${value}>` },
    });
    expect(req.query).toEqual({ "<x": "A>" });
  });

  it("no Cookie header: empty cookies, and the configured secret is still req.secret", () => {
    const req = build("http://h/", {
      parseBody: false,
      parseCookies: { secret: ["s1", "s2"] },
    });
    expect(req.cookies).toEqual({});
    expect(req.signedCookies).toEqual({});
    expect(req.secret).toBe("s1");
    const withCookie = build(
      "http://h/",
      { parseBody: false },
      { cookie: "a=1" },
    );
    expect(withCookie.cookies).toEqual({ a: "1" });
  });

  it("an unset parseQuery/parseCookies parses, and never writes the caller's options", () => {
    const options = Object.freeze({ parseBody: true });
    const req = build("http://h/p?a=1", options, { cookie: "c=2" });
    expect(req.query).toEqual({ a: "1" });
    expect(req.cookies).toEqual({ c: "2" });
    expect(options).toEqual({ parseBody: true });
  });

  it("a bodiless request's buffer is empty, and ready() reports as before", async () => {
    const req = build("http://h/p", { parseBody: true, parseCookies: true });
    expect(req.buffer?.length).toBe(0);
    expect(req.body).toBeUndefined();
    const settled = await req.ready();
    expect(settled.map((entry) => entry.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    const [query, body, cookies] = settled as PromiseFulfilledResult<unknown>[];
    expect(query.value).toBe(req.query);
    expect(body.value).toBeUndefined();
    expect(cookies.value).toEqual({ cookies: {}, signedCookies: {} });
  });

  it("ready() lists only what was scheduled, and reads a deferred body", async () => {
    expect(
      await build("http://h/", {
        parseBody: false,
        parseQuery: false,
        parseCookies: false,
      }).ready(),
    ).toEqual([]);
    const deferred = new BunRequest(
      new Request("http://h/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"a":1}',
      }),
      testServer,
      {
        parseBody: true,
        parseQuery: false,
        parseCookies: false,
        deferBody: true,
      },
    );
    expect(deferred.body).toBeUndefined();
    const settled = await deferred.ready();
    expect(settled.map((entry) => entry.status)).toEqual(["fulfilled"]);
    expect(deferred.body).toEqual({ a: 1 });
  });

  it("method is upper-cased and stable; originalUrl keeps query and fragment", () => {
    const req = BunRequest.init(
      new Request("http://h/a/b?x=1#frag", { method: "patch" }),
      testServer,
      { parseBody: false },
    ) as BunRequest;
    expect(req.method).toBe("PATCH");
    expect(req.method).toBe(req.method);
    expect(req.originalUrl).toBe("/a/b?x=1#frag");
    expect(build("http://h/a/b").originalUrl).toBe("/a/b");
    expect(build("http://h/a/b?q").originalUrl).toBe("/a/b?q");
  });
});

describe("requestPath: the router matches the path it is given", () => {
  it("is what the adapters pass, and matches as requestUrl does", async () => {
    const router = new BunRouter();
    router.get("/a/:id", (req, res) => res.send(String(req.params.id)));
    const request = build("http://h/a/7?q=1");
    const viaPath = router.getMatchedLayers({
      requestHost: "h",
      requestMethod: "GET",
      requestUrl: "/ignored-when-path-given",
      requestPath: "/a/7",
    });
    const viaUrl = router.getMatchedLayers({
      requestHost: "h",
      requestMethod: "GET",
      requestUrl: "/a/7?q=1",
    });
    expect(viaPath.length).toBe(1);
    expect(viaPath.map((l) => l.matched.params)).toEqual(
      viaUrl.map((l) => l.matched.params),
    );
    expect(request.path).toBe("/a/7");

    const app = new BunHttpAdapter(0);
    app.get("/a/:id", (req, res) => res.send(String(req.params.id)));
    expect(await (await app.fetch("/a/9?x=1#f")).text()).toBe("9");
  });
});

describe("the request URL split (host, path, search, hash)", () => {
  // [url, host, path, search, hash, originalUrl] — pinned from the previous
  // per-character implementation, which the indexOf-based one must match,
  // raw (unnormalised) URLs included.
  const CASES: [string, string, string, string, string, string][] = [
    ["http://h/", "h", "/", "", "", "/"],
    ["http://h", "h", "/", "", "", "/"],
    ["http://h?x=/y", "h", "/", "?x=/y", "", "/?x=/y"],
    ["http://h#f/g?z", "h", "/", "", "#f/g?z", "/#f/g?z"],
    ["http://h/a?b#c", "h", "/a", "?b", "#c", "/a?b#c"],
    ["http://h/a#b?c", "h", "/a", "", "#b?c", "/a#b?c"],
    ["http://u:p@h:8/x", "h:8", "/x", "", "", "/x"],
    ["http://h/a/b?", "h", "/a/b", "?", "", "/a/b?"],
    ["http://h/?#", "h", "/", "?", "#", "/?#"],
    [
      "http://h:3000/%2F/x?q=%3F#%23",
      "h:3000",
      "/%2F/x",
      "?q=%3F",
      "#%23",
      "/%2F/x?q=%3F#%23",
    ],
    ["https://[::1]:8443/p?a=1", "[::1]:8443", "/p", "?a=1", "", "/p?a=1"],
    ["http://h/a//b", "h", "/a//b", "", "", "/a//b"],
  ];
  for (const [url, host, path, search, hash, originalUrl] of CASES) {
    it(url, () => {
      const req = new BunRequest(
        {
          url,
          headers: new Headers(),
          body: null,
          method: "GET",
        } as unknown as Request,
        testServer,
        { parseBody: false, parseQuery: false, parseCookies: false },
      );
      expect([
        req.host,
        req.path,
        req.search,
        req.hash,
        req.originalUrl,
      ]).toEqual([host, path, search, hash, originalUrl]);
    });
  }
});

describe("cookies are parsed on first touch, as if while the request was built", () => {
  const SIGNED = `sid=s:${signCookie("abc", "k1")}; theme=dark`;

  /** A request whose `Cookie` header reads are counted. */
  function counted(cookie: string | null) {
    const reads: string[] = [];
    const headers = new Headers(cookie === null ? {} : { cookie });
    const spy = new Proxy(headers, {
      get(target, key) {
        if (key === "get") {
          return (name: string) => {
            reads.push(name.toLowerCase());
            return target.get(name);
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const request = {
      url: "http://h/",
      method: "GET",
      body: null,
      bodyUsed: false,
      headers: spy,
      signal: new AbortController().signal,
    } as unknown as Request;
    const req = new BunRequest(request, testServer, {
      parseBody: false,
      parseCookies: { secret: ["k1", "k2"] },
    });
    return { req, reads };
  }

  it("never reads the Cookie header for a request that does not touch cookies", () => {
    const { req, reads } = counted(SIGNED);
    expect(req.secret).toBe("k1");
    expect(reads).not.toContain("cookie");
    expect(req.signedCookies).toEqual({ sid: "abc" });
    expect(req.cookies).toEqual({ theme: "dark" });
    expect(reads.filter((name) => name === "cookie")).toEqual(["cookie"]);
  });

  it("an assignment replaces the scheduled parse's result, not the reverse", () => {
    const { req } = counted(SIGNED);
    req.signedCookies = { replaced: true };
    expect(req.signedCookies).toEqual({ replaced: true });
    // The other half still holds the scheduled parse.
    expect(req.cookies).toEqual({ theme: "dark" });
  });

  it("an explicit parseCookies() without force leaves the scheduled result on the request", () => {
    const { req } = counted(SIGNED);
    const other = req.parseCookies({ secret: "wrong" });
    // Its own answer uses its secret: the signed cookie does not verify.
    expect(other.signedCookies).toEqual({ sid: false });
    // The request keeps what the options' secrets gave.
    expect(req.signedCookies).toEqual({ sid: "abc" });
  });

  it("is reported by ready() as parsed", async () => {
    const { req } = counted(SIGNED);
    const settled = (await req.ready()) as PromiseFulfilledResult<unknown>[];
    expect(settled.at(-1)?.value).toEqual({
      cookies: { theme: "dark" },
      signedCookies: { sid: "abc" },
    });
  });

  it("no header: empty, with nothing parsed", () => {
    const { req, reads } = counted(null);
    expect(req.cookies).toEqual({});
    expect(req.signedCookies).toEqual({});
    expect(reads.filter((name) => name === "cookie")).toEqual(["cookie"]);
  });
});

describe("a request's Headers are built on first read", () => {
  /** A native request whose `headers` reads are counted. */
  function counted(url: string, init?: RequestInit) {
    let reads = 0;
    class Counted extends Request {
      override get headers(): Headers {
        reads++;
        return super.headers;
      }
    }
    return { request: new Counted(url, init), reads: () => reads };
  }

  it("a GET answered without reading a header never builds them", async () => {
    /** Opens the entry point `Bun.serve` calls. */
    class Served extends BunHttpAdapter {
      serve(request: Request) {
        return this.handleNativeRequest(request, testServer as never);
      }
    }
    const app = new Served(0);
    app.get("/u/:id", (req, res) => {
      res.json({ id: req.params.id, q: req.query, path: req.path });
    });
    const { request, reads } = counted("http://h/u/7?x=1");
    // The served entry point: fetch() would copy the request, headers and all.
    const response = (await app.serve(request))!;
    expect(await response.json()).toEqual({
      id: "7",
      q: { x: "1" },
      path: "/u/7",
    });
    expect(reads()).toBe(0);
    // Reading the body reads them: only they tell no body from an empty one.
    const second = counted("http://h/");
    const req = BunRequest.init(second.request, testServer, {
      parseBody: true,
    }) as BunRequest;
    expect(req.body).toBeUndefined();
    expect(second.reads()).toBe(1);
  });

  it("a body's framing headers are read once each while the request is built", async () => {
    // Counted by wrapping the native method (a spy does not see these calls).
    const names: string[] = [];
    const proto = Headers.prototype as { get: (name: string) => string | null };
    const original = proto.get;
    proto.get = function (this: Headers, name: string) {
      names.push(name.toLowerCase());
      return original.call(this, name);
    };
    let req: BunRequest;
    try {
      req = await BunRequest.init(
        new Request("http://h/", {
          method: "POST",
          body: '{"n":7}',
          headers: {
            "content-type": "application/json",
            "content-length": "7",
          },
        }),
        testServer,
        { parseBody: { contentTypes: { json: true } }, retainBuffer: false },
      );
    } finally {
      proto.get = original;
    }
    expect(req.body).toEqual({ n: 7 });
    // Before: Content-Length three times and Transfer-Encoding twice.
    expect(names.sort()).toEqual([
      "content-encoding",
      "content-length",
      "content-type",
      "transfer-encoding",
    ]);
    // Read fresh after the build: a handler may change them.
    req.headersObj.set("content-length", "99");
    expect(req.get("content-length")).toBe("99");
  });

  it("are built once, on the first header read", () => {
    const { request, reads } = counted("http://h/", {
      headers: { "x-a": "1" },
    });
    const req = BunRequest.init(request, testServer, {
      parseBody: true,
    }) as BunRequest;
    expect(reads()).toBe(0);
    expect(req.get("x-a")).toBe("1");
    expect(req.headersObj.get("x-a")).toBe("1");
    expect(reads()).toBe(1);
  });

  /** A GET with `headers` and no body stream, as Bun serves `Content-Length: 0`. */
  const bodilessGet = (headers: Record<string, string>) =>
    new BunRequest(
      {
        url: "http://h/",
        method: "GET",
        body: null,
        bodyUsed: false,
        headers: new Headers({ "content-length": "0", ...headers }),
        signal: new AbortController().signal,
      } as unknown as Request,
      testServer,
      { parseBody: true },
    );

  it("a GET's declared empty body still parses as one, on first read", () => {
    // A GET is built without reading its headers; a `Content-Length: 0`
    // makes its absent stream a declared empty body when the body is read.
    expect(bodilessGet({ "content-type": "application/json" }).body).toEqual(
      {},
    );
    expect(
      bodilessGet({ "content-type": "application/x-www-form-urlencoded" }).body,
    ).toEqual({});
    expect(bodilessGet({ "content-type": "text/plain" }).body).toBe("");
    const raw = bodilessGet({ "content-type": "application/octet-stream" });
    expect(raw.isBodyParsed).toBe(true);
    expect(bodilessGet({}).body).toBeUndefined();
    expect(bodilessGet({ "content-type": "application/json" }).complete).toBe(
      true,
    );
  });

  it("a GET's declared empty body with a bad Content-Encoding is routed, refused when read", async () => {
    // The one change the lazy headers make, for a GET or HEAD only: before,
    // this was answered 415 before routing; now the handler runs, and
    // reading the body records the refusal (and a parser rejects with it).
    const app = new BunHttpAdapter(0);
    app.get("/e", async (req, res) => {
      const before = req.bodyDecodingError;
      const body = req.body;
      const error = req.bodyDecodingError;
      let rejected: unknown;
      await req.parseBody().catch((caught: unknown) => {
        rejected = caught;
      });
      res.json({
        before: before ?? null,
        body: body ?? null,
        status: error?.statusCode,
        complete: req.complete,
        rejected: (rejected as { statusCode?: number })?.statusCode,
      });
    });
    const response = await app.fetch("/e", {
      headers: {
        "content-type": "application/json",
        "content-encoding": "nope",
        "content-length": "0",
      },
    });
    expect(await response.json()).toEqual({
      before: null,
      body: null,
      status: 415,
      complete: false,
      rejected: 415,
    });
  });

  it("any other method checks its headers first, as before: refused before routing", async () => {
    const app = new BunHttpAdapter(0);
    let routed = false;
    app.post("/e", (_req, res) => {
      routed = true;
      res.send("routed");
    });
    const response = await app.fetch("/e", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "nope",
        "content-length": "0",
      },
    });
    expect(response.status).toBe(415);
    expect(routed).toBe(false);
    const empty = await app.fetch("/e", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "0" },
    });
    expect(empty.status).toBe(200);
  });

  it("a POST with a body is read without touching request.body", async () => {
    // Reading `request.body` builds a ReadableStream, and the body is then
    // read through it rather than Bun's direct path.
    let bodyReads = 0;
    /** A request whose `body` reads are counted. */
    const counted = (url: string, init: RequestInit) => {
      const request = new Request(url, init);
      const body = Object.getOwnPropertyDescriptor(Request.prototype, "body")!;
      Object.defineProperty(request, "body", {
        get() {
          bodyReads++;
          return body.get!.call(request);
        },
      });
      return request;
    };
    /** Opens the entry point `Bun.serve` calls. */
    class Served extends BunHttpAdapter {
      serve(request: Request) {
        return this.handleNativeRequest(request, testServer as never);
      }
    }
    const app = new Served(0);
    app.post("/j", (req, res) => {
      res.json(req.body);
    });
    const response = (await app.serve(
      counted("http://h/j", {
        method: "POST",
        // As a served POST carries it.
        headers: { "content-type": "application/json", "content-length": "7" },
        body: '{"n":7}',
      }),
    ))!;
    expect(await response.json()).toEqual({ n: 7 });
    expect(bodyReads).toBe(0);
  });

  it("a body assigned before the first read is kept", () => {
    const req = bodilessGet({ "content-type": "application/json" });
    req.body = { set: true };
    expect(req.body).toEqual({ set: true });
  });
});

describe("RequestPipelineOptions: the host and target read on demand", () => {
  it("reads as the request's host and originalUrl, and takes assignments", () => {
    const req = build("http://u:p@h:8/a?b#c");
    let hostReads = 0;
    const host = Object.getOwnPropertyDescriptor(BunRequest.prototype, "host")!;
    Object.defineProperty(req, "host", {
      get() {
        hostReads++;
        return host.get!.call(req);
      },
    });
    const options = new RequestPipelineOptions(
      req,
      new BunResponse(req),
      "GET",
      req.path,
      0,
    );
    expect(hostReads).toBe(0);
    expect([
      options.requestHost,
      options.requestUrl,
      options.requestPath,
    ]).toEqual(["h:8", "/a?b#c", "/a"]);
    expect(hostReads).toBe(1);
    options.requestHost = "other";
    options.requestUrl = "/x";
    expect([options.requestHost, options.requestUrl]).toEqual(["other", "/x"]);
  });

  it("host-scoped routes still match through the adapters", async () => {
    const app = new BunHttpAdapter(0);
    app.get("/h", (req, res) => res.send(`any ${req.hostname}`));
    const scoped = new BunRouter({ host: ":sub.example.com" });
    scoped.get("/s", (req, res) => {
      res.send(`sub ${String((req.params as Record<string, string>).sub)}`);
    });
    app.use(scoped);
    expect(await (await app.fetch("http://api.example.com/s")).text()).toBe(
      "sub api",
    );
    expect(await (await app.fetch("http://h/h")).text()).toBe("any h");
  });
});

describe("per-value caches behind the body and cookie options", () => {
  it("decides each Content-Type's kind as before, whatever its case or boundary", async () => {
    const parse = async (type: string, body: string) =>
      (
        await BunRequest.init(
          new Request("http://h/", {
            method: "POST",
            body,
            headers: { "content-type": type },
          }),
          testServer,
          { parseBody: true },
        )
      ).body;
    // The same values twice: the second answer comes from the cache.
    for (let round = 0; round < 2; round++) {
      expect(await parse("application/json", '{"a":1}')).toEqual({ a: 1 });
      expect(await parse("Application/JSON; charset=utf-8", "[2]")).toEqual([
        2,
      ]);
      expect(await parse("application/vnd.api+json", '{"b":2}')).toEqual({
        b: 2,
      });
      expect(await parse("text/plain", "hi")).toBe("hi");
      expect(await parse("application/x-www-form-urlencoded", "a=1")).toEqual({
        a: "1",
      });
      expect(Buffer.isBuffer(await parse("image/png", "x"))).toBe(true);
    }
    // A fresh boundary per form: each parsed as multipart all the same.
    for (const boundary of ["b1", "b2", "b3"]) {
      const body = `--${boundary}\r\nContent-Disposition: form-data; name="f"\r\n\r\nv\r\n--${boundary}--\r\n`;
      const req = await BunRequest.init(
        new Request("http://h/", {
          method: "POST",
          body,
          headers: {
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
        }),
        testServer,
        { parseBody: true },
      );
      expect((await req.getMultiParts({})).fields).toEqual({ f: "v" });
    }
  });

  it("sees a secret rotated into the same configured array", () => {
    const secrets = ["one"];
    const options = { parseBody: false, parseCookies: { secret: secrets } };
    const first = BunRequest.init(
      new Request("http://h/"),
      testServer,
      options,
    ) as BunRequest;
    expect(first.secret).toBe("one");
    secrets.unshift("two");
    const second = BunRequest.init(
      new Request("http://h/"),
      testServer,
      options,
    ) as BunRequest;
    expect(second.secret).toBe("two");
  });
});
