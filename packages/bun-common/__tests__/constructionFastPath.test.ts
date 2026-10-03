import { describe, expect, it } from "bun:test";
import { signCookie } from "../lib";
import { BunHttpAdapter } from "../lib/BunHttpAdapter";
import { BunRequest } from "../lib/BunRequest";
import { BunRouter } from "../lib/BunRouter";
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
