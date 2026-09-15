/**
 * Reading a request — every property and getter a handler can look at.
 *
 * ```bash
 * bun 04-request/reading-a-request.ts
 * ```
 *
 * Requests go through `router.fetch()`, so no port is bound: the handler runs
 * in the real pipeline and answers with what it saw.
 *
 * Things that differ from Express, and are worth knowing first:
 *
 * - `req.url` is the path and query, as in Express, with `req.originalUrl`
 *   alongside; the absolute URL is `req.request.url`. `req.baseUrl` is `""`:
 *   the router matches a mount by prefix without rewriting the URL.
 * - `req.fresh` compares against the response bound to the request; a
 *   `BunResponse` binds itself when constructed, so `fresh` is readable in
 *   any handler (`send()` itself answers 304 for a fresh request).
 * - `req.protocol` trusts `X-Forwarded-Proto` unconditionally — there is no
 *   `trust proxy` setting — and `req.ips` reads `X-Forwarded-For` the same way.
 * - Without a socket there is no peer: `req.ip` is `""` and
 *   `req.socketAddress` is `null` under `fetch()`.
 */
import { BunRouter } from "@kingsleyweb/bun-common";
import { show, step, title } from "../shared/console";

title("Reading a request");

const router = new BunRouter();

/* ------------------------------------------------------------------ */
step("method, url, path, search, hash, originalUrl, parsedUrl");

router.get("/articles/:slug", (req, res) => {
  res.json({
    method: req.method,
    url: req.url,
    path: req.path,
    search: req.search,
    querystring: req.querystring,
    hash: req.hash,
    originalUrl: req.originalUrl,
    parsedUrlPathname: req.parsedUrl.pathname,
    params: req.params,
  });
});

show(
  "GET /articles/bun-routing?draft=1",
  await (await router.fetch("/articles/bun-routing?draft=1")).json(),
);

/* ------------------------------------------------------------------ */
step("params: from the path literal, optional ones are simply absent");

router.get("/files/:folder/:name?", (req, res) => {
  // `req.params` is typed from the path: { folder: string; name?: string }.
  res.json({ folder: req.params.folder, name: req.params.name ?? null });
});

show(
  "/files/docs/readme.md",
  await (await router.fetch("/files/docs/readme.md")).json(),
);
show("/files/docs", await (await router.fetch("/files/docs")).json());

/* ------------------------------------------------------------------ */
step("query: nested, dotted, indexed and repeated keys");

router.get("/search", (req, res) => {
  res.json({ query: req.query });
});

// The default parser (`DEFAULT_PARSE_QUERY_OPTS`) reads `a.b` and `a[b]`
// alike, turns `x[0]`/`x[1]` into an array, and collects a repeated key.
show(
  "?user.name=ada&filter[tag]=bun&ids[0]=1&ids[1]=2&sort=a&sort=b",
  await (
    await router.fetch(
      "/search?user.name=ada&filter[tag]=bun&ids[0]=1&ids[1]=2&sort=a&sort=b",
    )
  ).json(),
);
// A client that percent-encodes the brackets still gets an array.
show(
  "?ids%5B0%5D=1&ids%5B1%5D=2",
  await (await router.fetch("/search?ids%5B0%5D=1&ids%5B1%5D=2")).json(),
);

/* ------------------------------------------------------------------ */
step("headers: get(), getHeader(), headers, headersDistinct, rawHeaders");

router.get("/headers", (req, res) => {
  res.json({
    getUserAgent: req.get("User-Agent"),
    getWithDefault: req.get("X-Missing", "fallback"),
    // An array, as Node's `req.headers["set-cookie"]`; any other repeated
    // header is one comma-joined string.
    getSetCookie: req.get("set-cookie"),
    getHeader: req.getHeader("x-request-id"),
    hasHeader: req.hasHeader("X-Request-Id"),
    getHeaderNames: req.getHeaderNames(),
    getRawHeaderNames: req.getRawHeaderNames(),
    headers: req.headers,
    headersDistinct: req.headersDistinct["x-request-id"],
    rawHeaders: req.rawHeaders.slice(0, 4),
    httpVersion: [req.httpVersion, req.httpVersionMajor, req.httpVersionMinor],
  });
});

show(
  "GET /headers",
  await (
    await router.fetch("/headers", {
      headers: [
        ["User-Agent", "example/1.0"],
        ["X-Request-Id", "req-42"],
        ["Set-Cookie", "a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT"],
        ["Set-Cookie", "b=2"],
      ],
    })
  ).json(),
);

/* ------------------------------------------------------------------ */
step("host, hostname, subdomains, protocol, secure, ip, ips, xhr");

router.get("/where", (req, res) => {
  res.json({
    host: req.host,
    hostname: req.hostname,
    subdomains: req.subdomains,
    protocol: req.protocol,
    secure: req.secure,
    ip: req.ip,
    socketAddress: req.socketAddress,
    ips: req.ips,
    xhr: req.xhr,
  });
});

show(
  "https://api.staging.example.com:8443/where (direct)",
  await (
    await router.fetch(
      new Request("https://api.staging.example.com:8443/where", {
        headers: { "X-Requested-With": "XMLHttpRequest" },
      }),
    )
  ).json(),
);
show(
  "http://shop.example.com/where behind a TLS-terminating proxy",
  await (
    await router.fetch(
      new Request("http://shop.example.com/where", {
        headers: {
          "X-Forwarded-Proto": "https, http",
          "X-Forwarded-For": "203.0.113.7, 10.0.0.2",
        },
      }),
    )
  ).json(),
);

/* ------------------------------------------------------------------ */
step("is(): what the body claims to be");

router.post("/upload", (req, res) => {
  res.json({
    isJson: req.is("json"),
    isAnyApplication: req.is("application/*"),
    firstOf: req.is(["html", "json"]),
    isHtml: req.is("html"),
  });
});

const payload = JSON.stringify({ title: "hello" });
show(
  "POST application/json",
  await (
    await router.fetch("/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // type-is only answers for a request that declares a body.
        "Content-Length": String(payload.length),
      },
      body: payload,
    })
  ).json(),
);

/* ------------------------------------------------------------------ */
step("accepts*: content negotiation on Accept, -Encoding, -Charset, -Language");

router.get("/negotiate", (req, res) => {
  res.json({
    accepts: req.accepts(),
    acceptsJsonOrHtml: req.accepts("json", "html"),
    acceptsXml: req.accepts(["xml"]),
    acceptsTypes: req.acceptsTypes("json"),
    acceptsEncodings: req.acceptsEncodings(),
    prefersEncoding: req.acceptsEncodings("br", "gzip"),
    acceptsCharsets: req.acceptsCharsets(),
    prefersCharset: req.acceptsCharsets("iso-8859-1", "utf-8"),
    acceptsLanguages: req.acceptsLanguages(),
    prefersLanguage: req.acceptsLanguages("fr", "en-GB"),
  });
});

show(
  "GET /negotiate",
  await (
    await router.fetch("/negotiate", {
      headers: {
        Accept: "text/html, application/json;q=0.9",
        "Accept-Encoding": "gzip, br;q=0.5",
        "Accept-Charset": "utf-8, iso-8859-1;q=0.5",
        "Accept-Language": "en-GB, fr;q=0.8",
      },
    })
  ).json(),
);

/* ------------------------------------------------------------------ */
step("range(): parse a Range header against a resource size");

router.get("/video", (req, res) => {
  const size = 1_000;
  res.json({
    single: req.range(size, undefined),
    combined: req.range(size, { combine: true }),
  });
});

show(
  "Range: bytes=0-99,100-199,-50",
  await (
    await router.fetch("/video", {
      headers: { Range: "bytes=0-99,100-199,-50" },
    })
  ).json(),
);

/* ------------------------------------------------------------------ */
step("fresh and stale: conditional GETs");

router.get("/profile", (req, res) => {
  res.set("ETag", '"v7"');
  // Bind the response so `fresh` has headers to compare against.
  req.setResponse(res);
  const seen = { fresh: req.fresh, stale: req.stale };
  // `send()` answers 304 with no body when the request is fresh.
  res.set("X-Seen", JSON.stringify(seen)).send("profile body");
});

const unconditional = await router.fetch("/profile");
show("no If-None-Match", {
  status: unconditional.status,
  seen: unconditional.headers.get("X-Seen"),
});
const revalidated = await router.fetch("/profile", {
  headers: { "If-None-Match": '"v7"' },
});
show('If-None-Match: "v7"', {
  status: revalidated.status,
  seen: revalidated.headers.get("X-Seen"),
  body: await revalidated.text(),
});

/* ------------------------------------------------------------------ */
step("cookies: parsed, JSON cookies expanded");

router.get("/cookies", (req, res) => {
  res.json({ cookies: req.cookies, signedCookies: req.signedCookies });
});

show(
  "Cookie: theme=dark; prefs=j:{…}",
  await (
    await router.fetch("/cookies", {
      headers: {
        Cookie: `theme=dark; prefs=${encodeURIComponent('j:{"lang":"en"}')}`,
      },
    })
  ).json(),
);
show("(signed cookies and secrets: see 04-request/cookies.ts)");

/* ------------------------------------------------------------------ */
step("The rest: route, socket shim, body state, events");

router.get("/misc", (req, res) => {
  res.json({
    route: req.route ?? null,
    socket: {
      localAddress: req.socket.localAddress,
      localPort: req.socket.localPort ?? null,
    },
    maxHeadersCount: req.maxHeadersCount,
    reusedSocket: req.reusedSocket,
    isBodyParsed: req.isBodyParsed,
    complete: req.complete,
    aborted: req.aborted,
    isKeepAlive: req.isKeepAlive,
  });
});

show("GET /misc", await (await router.fetch("/misc")).json());
