/**
 * The requests the differential harness sends to both adapters, grouped by
 * the application they need. Each is sent unchanged to the Express and the
 * Bun application; the test compares what comes back.
 */
import type { NestApplicationOptions } from "@nestjs/common";
import type { Configure, Side } from "./app";
import { RequestMethod, VersioningType } from "@nestjs/common";
import { ExpressAdapter } from "@nestjs/platform-express";
import {
  CompatModule,
  configureCompat,
  configureFailingMiddleware,
  configureSecurity,
  EXPRESS_REPORTS_FAILED_SOURCE,
  HAS_QUERY_METHOD,
  HAS_SECURITY_HOOK,
  markResponse,
  QueryModule,
  signCookie,
  SmallModule,
  VersionedModule,
  VIEWS,
  ViewsModule,
  WildcardMiddlewareModule,
} from "./app";
import { UPLOAD_GROUPS, UPLOAD_KNOWN } from "./uploads";

/** One request: a name, a path and its `RequestInit`. */
export interface Probe {
  name: string;
  path: string;
  init?: RequestInit;
}

/** An application to boot on both sides, and the requests to send it. */
export interface ProbeGroup {
  name: string;
  /** The application, or one per side when the two need different code (uploads). */
  module: (new () => object) | Record<Side, new () => object>;
  /** Removes what the group's application left behind, after both sides close. */
  cleanup?: () => void;
  configure?: Configure;
  options?: NestApplicationOptions;
  probes: Probe[];
  /** Why the group is skipped (visibly) on the installed Nest, if it is. */
  skip?: string;
}

const html = { headers: { accept: "text/html" } };

/** A cross-origin request's init: `Origin` set, for CORS to answer. */
function withOrigin(method = "GET"): RequestInit {
  return { method, headers: { origin: "https://a.test" } };
}
const json = { headers: { accept: "application/json" } };

/** A browser's cross-site request headers, which CSRF protection refuses. */
const crossSite = {
  origin: "http://evil.test",
  "sec-fetch-site": "cross-site",
};

/** A cross-site `POST` of `body` as JSON. */
function crossSitePost(body: string): RequestInit {
  return {
    method: "POST",
    headers: { ...crossSite, "content-type": "application/json" },
    body,
  };
}

/** `n` bytes of JSON: `{"pad":"xxx…"}`. */
function jsonOfSize(n: number): string {
  return JSON.stringify({ pad: "x".repeat(Math.max(0, n - 10)) });
}

export const GROUPS: ProbeGroup[] = [
  {
    name: "compat",
    module: CompatModule,
    configure: configureCompat,
    probes: [
      // Views.
      { name: "@Render with locals", path: "/render" },
      { name: "@Render returning undefined", path: "/render-undefined" },
      { name: "@Render missing view", path: "/render-missing" },
      { name: "@Render template throws", path: "/render-broken" },
      { name: "@Render returns {status}", path: "/render-status" },
      { name: "@Render + @HttpCode(203)", path: "/render-code" },
      { name: "@Render with extension", path: "/render-ext" },
      { name: "@Render directory index", path: "/render-dir" },
      { name: "HEAD @Render", path: "/render", init: { method: "HEAD" } },
      { name: "res.render + res.locals", path: "/res-render" },
      { name: "res.render callback", path: "/res-render-cb" },
      // Redirects.
      { name: "@Redirect default", path: "/redir" },
      { name: "@Redirect default, Accept html", path: "/redir", init: html },
      { name: "@Redirect default, Accept json", path: "/redir", init: json },
      { name: "@Redirect HEAD", path: "/redir", init: { method: "HEAD" } },
      { name: "@Redirect 301", path: "/redir-301" },
      { name: "@Redirect dynamic {url,statusCode}", path: "/redir-dynamic" },
      { name: "@Redirect dynamic {url}", path: "/redir-dynamic-url" },
      { name: "@Redirect relative", path: "/redir-relative" },
      { name: "@Redirect back", path: "/redir-back" },
      {
        name: "@Redirect back with Referer",
        path: "/redir-back",
        init: { headers: { referer: "http://x.test/from" } },
      },
      { name: "@Redirect url encoding", path: "/redir-encode" },
      { name: "@Redirect + passthrough", path: "/redir-passthrough" },
      { name: "res.redirect(url)", path: "/res-redirect" },
      { name: "res.redirect(301, url)", path: "/res-redirect-301" },
      // Status, headers, @Res, @Next.
      { name: "@HttpCode + @Header", path: "/code" },
      { name: "HEAD @Get", path: "/code", init: { method: "HEAD" } },
      { name: "OPTIONS @Get", path: "/code", init: { method: "OPTIONS" } },
      { name: "POST on a GET route", path: "/code", init: { method: "POST" } },
      { name: "unknown route 404", path: "/nope" },
      { name: "@Res() no passthrough", path: "/res-raw" },
      { name: "@Res passthrough + return", path: "/res-pass" },
      { name: "@Next() to the next handler", path: "/next" },
      { name: "return number", path: "/num" },
      { name: "return boolean", path: "/bool" },
      { name: "return null", path: "/null" },
      { name: "return undefined", path: "/undef" },
      { name: "return string", path: "/str" },
      { name: "return array", path: "/arr" },
      { name: "return Buffer", path: "/buf" },
      { name: "error-shaped body, text/plain", path: "/err-body" },
      { name: "error-shaped body, +json", path: "/err-body-json" },
      {
        name: "custom HttpException body, text/plain",
        path: "/err-exc-text",
      },
      // StreamableFile and SSE.
      { name: "StreamableFile with options", path: "/file" },
      { name: "StreamableFile from a Readable", path: "/file-plain" },
      { name: "StreamableFile from bytes", path: "/file-bytes" },
      { name: "StreamableFile, source fails first", path: "/file-fails" },
      {
        name: "StreamableFile, source fails, custom handler",
        path: "/file-fails-custom",
      },
      // Express answers it only from platform-express 12.2.0 (it hangs before).
      ...(EXPRESS_REPORTS_FAILED_SOURCE
        ? [
            {
              name: "StreamableFile, source failed before reply",
              path: "/file-failed",
            },
          ]
        : []),
      { name: "@Sse", path: "/sse" },
      // Exceptions.
      { name: "HttpException", path: "/http-exc" },
      { name: "HttpException with object", path: "/http-exc-obj" },
      { name: "plain Error", path: "/plain-error" },
      { name: "exception filter", path: "/filtered" },
      // Bodies.
      {
        name: "JSON body",
        path: "/echo",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"a":[1,2],"b":{"c":true}}',
        },
      },
      {
        name: "urlencoded body (extended)",
        path: "/echo",
        init: {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "a[b]=1&c=1&c=2&d[]=x&e=%20y",
        },
      },
      {
        name: "text/plain body (no parser)",
        path: "/echo",
        init: {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "hi",
        },
      },
      { name: "POST without a body", path: "/echo", init: { method: "POST" } },
      {
        name: "invalid JSON",
        path: "/echo",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"a":',
        },
      },
      {
        name: "JSON over the 100kb default",
        path: "/echo",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: jsonOfSize(110 * 1024),
        },
      },
      // Request properties.
      {
        name: "request properties",
        path: "/req-props?a=1&a=2&b[c]=3&d=&e[]=x",
        init: {
          headers: {
            "x-forwarded-for": "1.2.3.4, 5.6.7.8",
            "x-forwarded-proto": "https",
            "x-requested-with": "XMLHttpRequest",
            cookie: `a=1; j=j:{"x":1}; s=${signCookie("val")}; bad=${signCookie("val", "other")}`,
          },
        },
      },
      {
        name: "request properties, Host with subdomains",
        path: "/req-props",
        init: { headers: { host: "a.b.example.com:8080" } },
      },
      // Response helpers.
      { name: "res.cookie / clearCookie", path: "/res-cookie" },
      { name: "res.type(html)", path: "/res-type" },
      { name: "res.type(json).send(string)", path: "/res-type-json" },
      {
        name: "res.type(problem+json).json(object)",
        path: "/res-type-problem-json",
      },
      { name: "res.send(object)", path: "/res-send-obj" },
      { name: "res.status().send(string)", path: "/res-send-num" },
      { name: "res.sendFile(abs)", path: "/res-sendfile" },
      { name: "res.sendFile(rel, {root})", path: "/res-sendfile-root" },
      { name: "res.download", path: "/res-download" },
      { name: "res.attachment", path: "/res-attachment" },
      { name: "res.format default Accept", path: "/res-format" },
      { name: "res.format json", path: "/res-format", init: json },
      {
        name: "res.format 406",
        path: "/res-format",
        init: { headers: { accept: "image/png" } },
      },
      { name: "res.append", path: "/res-append" },
      { name: "res.vary", path: "/res-vary" },
      { name: "res.location + end", path: "/res-location" },
      { name: "res.sendStatus(418)", path: "/res-send-status" },
      { name: "res.json(null)", path: "/res-json-null" },
      // Static assets.
      { name: "static file", path: "/static/a.txt" },
      { name: "static index", path: "/static/" },
      { name: "static prefix without slash", path: "/static" },
      { name: "static dir without slash", path: "/static/dir" },
      { name: "static dir index", path: "/static/dir/" },
      { name: "static dotfile (default ignore)", path: "/static/.secret" },
      { name: "static missing", path: "/static/missing.txt" },
      {
        name: "static range",
        path: "/static/a.txt",
        init: { headers: { range: "bytes=0-4" } },
      },
      {
        name: "static unsatisfiable range",
        path: "/static/a.txt",
        init: { headers: { range: "bytes=500-600" } },
      },
      { name: "static HEAD", path: "/static/a.txt", init: { method: "HEAD" } },
      {
        name: "static POST",
        path: "/static/a.txt",
        init: { method: "POST" },
      },
      { name: "static2 dotfile allow", path: "/static2/.secret" },
      { name: "static2 no index", path: "/static2/" },
      { name: "static2 file (no etag, 1d, immutable)", path: "/static2/a.txt" },
      // Middleware ordering.
      { name: "middleware GET mw/one", path: "/mw/one" },
      {
        name: "middleware POST mw/one",
        path: "/mw/one",
        init: { method: "POST" },
      },
      { name: "middleware excluded mw/skip", path: "/mw/skip" },
      // Host routing.
      {
        name: "@Controller({host}) match",
        path: "/host",
        init: { headers: { host: "acme.example.com" } },
      },
      {
        name: "@Controller({host}) match with port",
        path: "/host",
        init: { headers: { host: "acme.example.com:8080" } },
      },
      { name: "@Controller({host}) no match", path: "/host" },
    ],
  },
  {
    name: "views-no-engine",
    module: ViewsModule,
    configure: (app) => {
      app.setBaseViewsDir?.(VIEWS);
    },
    probes: [
      { name: "@Render without an engine or extension", path: "/render" },
      {
        name: "@Render with extension, engine loaded by name",
        path: "/render-ext",
      },
      { name: "res.render without an engine", path: "/res-render" },
    ],
  },
  {
    name: "views-engine-fn",
    module: ViewsModule,
    configure: (app) => {
      app.setBaseViewsDir?.([`${VIEWS}/sub`, VIEWS]);
      app.engine?.("ejs", (path, options, callback) => {
        callback(
          null,
          `custom:${path.split("/").slice(-2).join("/")}:${Object.keys(options).sort().join(",")}`,
        );
      });
      app.setViewEngine?.("ejs");
    },
    probes: [
      { name: "app.engine() + several views dirs", path: "/render" },
      { name: "app.engine() directory index", path: "/render-ext" },
    ],
  },
  {
    name: "cors-default",
    module: SmallModule,
    configure: (app) => {
      app.enableCors();
    },
    probes: [
      {
        name: "simple GET with Origin",
        path: "/hello",
        init: { headers: { origin: "https://a.test" } },
      },
      {
        name: "preflight",
        path: "/hello",
        init: {
          method: "OPTIONS",
          headers: {
            origin: "https://a.test",
            "access-control-request-method": "PUT",
            "access-control-request-headers": "x-one, content-type",
          },
        },
      },
      {
        name: "preflight on unknown path",
        path: "/nowhere",
        init: {
          method: "OPTIONS",
          headers: {
            origin: "https://a.test",
            "access-control-request-method": "GET",
          },
        },
      },
    ],
  },
  {
    name: "cors-options",
    module: SmallModule,
    configure: (app) => {
      app.enableCors({
        origin: ["https://a.test", /\.b\.test$/],
        credentials: true,
        exposedHeaders: ["x-e"],
        maxAge: 600,
        methods: ["GET", "POST"],
      });
    },
    probes: [
      {
        name: "allowed origin",
        path: "/hello",
        init: { headers: { origin: "https://a.test" } },
      },
      {
        name: "regexp origin",
        path: "/hello",
        init: { headers: { origin: "https://x.b.test" } },
      },
      {
        name: "refused origin",
        path: "/hello",
        init: { headers: { origin: "https://evil.test" } },
      },
      {
        name: "preflight allowed",
        path: "/hello",
        init: {
          method: "OPTIONS",
          headers: {
            origin: "https://a.test",
            "access-control-request-method": "POST",
          },
        },
      },
    ],
  },
  {
    name: "cors-delegate",
    module: SmallModule,
    configure: (app) => {
      app.enableCors(
        (
          req: { headers: Record<string, string | undefined> },
          cb: (err: Error | null, options?: object) => void,
        ) => {
          cb(null, { origin: req.headers.origin === "https://ok.test" });
        },
      );
    },
    probes: [
      {
        name: "delegate allows",
        path: "/hello",
        init: { headers: { origin: "https://ok.test" } },
      },
      {
        name: "delegate refuses",
        path: "/hello",
        init: { headers: { origin: "https://no.test" } },
      },
    ],
  },
  {
    name: "cors-option-true",
    module: SmallModule,
    options: { cors: true },
    probes: [
      {
        name: "{cors: true} GET",
        path: "/hello",
        init: { headers: { origin: "https://a.test" } },
      },
    ],
  },
  // A miss outside the global prefix: Nest's JSON 404 on 11, Express's
  // finalhandler page from 12 (nestjs/nest #16372, #17648, #17923), which
  // scopes the not-found handler to the prefix and the excluded routes.
  {
    name: "prefix",
    module: SmallModule,
    configure: (app) => {
      app.setGlobalPrefix("api", {
        exclude: [{ path: "health", method: RequestMethod.GET }],
      });
    },
    probes: [
      { name: "prefixed route", path: "/api/hello" },
      { name: "unprefixed route", path: "/hello" },
      { name: "excluded route", path: "/health" },
      { name: "excluded route under prefix", path: "/api/health" },
      { name: "outside, with a query", path: "/hello?x=1" },
      { name: "outside, sharing the prefix's letters", path: "/apiary" },
      { name: "outside, characters to escape", path: "/it's&x" },
      { name: "outside, percent-encoded", path: "/caf%C3%A9" },
      { name: "outside, POST", path: "/nope", init: { method: "POST" } },
      { name: "outside, HEAD", path: "/hello", init: { method: "HEAD" } },
      { name: "the bare prefix", path: "/api" },
      { name: "the prefix with a slash", path: "/api/" },
      { name: "a miss under the prefix", path: "/api/nope" },
      { name: "a miss under the prefix, in capitals", path: "/API/nope" },
      {
        name: "excluded route, another method",
        path: "/health",
        init: { method: "POST" },
      },
      { name: "below an excluded route", path: "/health/x" },
    ],
  },
  // A parameterised prefix: Express mounts it as `use("/:tenant")`, which
  // takes any first segment, so every miss is under it (Nest's JSON 404).
  {
    name: "prefix-param",
    module: SmallModule,
    configure: (app) => {
      app.setGlobalPrefix(":tenant", {
        exclude: [{ path: "health", method: RequestMethod.GET }],
      });
    },
    probes: [
      { name: "a route under the prefix", path: "/t1/hello" },
      { name: "a miss under the prefix", path: "/t1/missing" },
      { name: "one segment, a miss", path: "/other" },
      { name: "the root", path: "/" },
      { name: "excluded route", path: "/health" },
      {
        name: "excluded route, another method",
        path: "/health",
        init: { method: "POST" },
      },
      {
        name: "excluded route, HEAD",
        path: "/health",
        init: { method: "HEAD" },
      },
    ],
  },
  // finalhandler keeps the headers middleware already set (CORS, a custom
  // one) on its page, less Content-Encoding/-Language/-Range.
  {
    name: "prefix-headers",
    module: SmallModule,
    configure: (app) => {
      app.enableCors();
      app.use(markResponse);
      app.setGlobalPrefix("api");
    },
    probes: [
      { name: "outside, GET", path: "/other", init: withOrigin() },
      { name: "outside, HEAD", path: "/other", init: withOrigin("HEAD") },
      {
        name: "under the prefix, a miss",
        path: "/api/nope",
        init: withOrigin(),
      },
    ],
  },
  // An array prefix: in v12.1.0's release notes but in no release (#17845
  // reverted it), so Nest hands the array to the adapter as it is, and
  // Express's `normalizePrefix` reads a non-string as no prefix at all.
  {
    name: "prefix-array",
    module: SmallModule,
    configure: (app) => {
      app.setGlobalPrefix(["api", "v1"] as unknown as string);
    },
    probes: [
      { name: "a route, unprefixed", path: "/hello" },
      { name: "under the first prefix", path: "/api/hello" },
      { name: "under the second prefix", path: "/v1/hello" },
      { name: "a miss", path: "/nope" },
    ],
  },
  // Two trailing slashes: Express strips only the last.
  {
    name: "prefix-two-trailing-slashes",
    module: SmallModule,
    configure: (app) => {
      app.setGlobalPrefix("api//");
    },
    probes: [
      { name: "a miss under it", path: "/api/nope" },
      { name: "outside", path: "/hello" },
    ],
  },
  {
    name: "prefix-trailing-slash",
    module: SmallModule,
    configure: (app) => {
      app.setGlobalPrefix("/api/");
    },
    probes: [
      { name: "prefixed route", path: "/api/hello" },
      { name: "a miss under the prefix", path: "/api/nope" },
      { name: "outside", path: "/hello" },
    ],
  },
  {
    name: "prefix-versioned-exclusion",
    module: VersionedModule,
    configure: (app) => {
      app.setGlobalPrefix("api", {
        exclude: [{ path: "ver", method: RequestMethod.GET }],
      });
      app.enableVersioning({ type: VersioningType.URI });
    },
    probes: [
      { name: "excluded, v1", path: "/v1/ver" },
      { name: "excluded, neutral", path: "/ver" },
      {
        name: "excluded, v1, another method",
        path: "/v1/ver",
        init: { method: "POST" },
      },
      { name: "an unknown version, outside", path: "/v9/ver" },
      { name: "under the prefix", path: "/api/v1/ver" },
    ],
  },
  // The core registers `/api$` beside `/api/{*path}` for `forRoutes("*")`
  // (the `$` meaning "exactly"): Express honours it from 12.1.3 (#17942).
  {
    name: "prefix-wildcard-middleware",
    module: WildcardMiddlewareModule,
    configure: (app) => {
      app.setGlobalPrefix("api");
    },
    probes: [
      { name: "the bare prefix", path: "/api" },
      { name: "the prefix with a slash", path: "/api/" },
      { name: "a route under the prefix", path: "/api/hello" },
      { name: "a miss under the prefix", path: "/api/nope" },
      { name: "outside the prefix", path: "/hello" },
    ],
  },
  {
    name: "version-uri",
    module: VersionedModule,
    configure: (app) => {
      app.enableVersioning({ type: VersioningType.URI });
    },
    probes: [
      { name: "URI v1", path: "/v1/ver" },
      { name: "URI v3", path: "/v3/ver" },
      { name: "URI neutral", path: "/ver" },
      { name: "URI v9", path: "/v9/ver" },
    ],
  },
  {
    name: "version-header",
    module: VersionedModule,
    configure: (app) => {
      app.enableVersioning({
        type: VersioningType.HEADER,
        header: "X-API-Version",
      });
    },
    probes: [
      {
        name: "header v1",
        path: "/ver",
        init: { headers: { "x-api-version": "1" } },
      },
      {
        name: "header v2",
        path: "/ver",
        init: { headers: { "x-api-version": "2" } },
      },
      { name: "header none", path: "/ver" },
      {
        name: "header v9",
        path: "/ver",
        init: { headers: { "x-api-version": "9" } },
      },
    ],
  },
  {
    name: "version-media",
    module: VersionedModule,
    configure: (app) => {
      app.enableVersioning({ type: VersioningType.MEDIA_TYPE, key: "v=" });
    },
    probes: [
      {
        name: "media v1",
        path: "/ver",
        init: { headers: { accept: "application/json;v=1" } },
      },
      {
        name: "media v3",
        path: "/ver",
        init: { headers: { accept: "application/json;v=3" } },
      },
      { name: "media none", path: "/ver", init: json },
    ],
  },
  {
    name: "raw-body",
    module: SmallModule,
    options: { rawBody: true },
    probes: [
      {
        name: "rawBody JSON",
        path: "/echo",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"r":1}',
        },
      },
      {
        name: "rawBody urlencoded",
        path: "/echo",
        init: {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "r=1",
        },
      },
    ],
  },
  {
    name: "body-limit",
    module: SmallModule,
    configure: (app) => {
      app.useBodyParser?.("json", { limit: "20b" });
    },
    probes: [
      {
        name: "under the limit",
        path: "/echo",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"a":1}',
        },
      },
      {
        name: "over the limit → 413",
        path: "/echo",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: jsonOfSize(100),
        },
      },
    ],
  },
  // HTTP QUERY (RFC 10008): `@QueryMethod()`, Nest 11.2.0+ only.
  {
    name: "query-method",
    module: QueryModule,
    skip: HAS_QUERY_METHOD ? undefined : "Nest below 11.2 has no @QueryMethod",
    probes: [
      {
        name: "QUERY with a JSON body",
        path: "/q",
        init: {
          method: "QUERY",
          headers: { "content-type": "application/json" },
          body: '{"name":"nestjs"}',
        },
      },
      { name: "GET on a QUERY route", path: "/q" },
      { name: "HEAD on a QUERY route", path: "/q", init: { method: "HEAD" } },
      {
        name: "QUERY on @All()",
        path: "/q/any",
        init: { method: "QUERY" },
      },
      { name: "QUERY, a miss", path: "/nope", init: { method: "QUERY" } },
    ],
  },
  {
    name: "errors",
    module: SmallModule,
    configure: configureFailingMiddleware,
    probes: [
      { name: "next(HttpException)", path: "/mw-http-exception" },
      { name: "next(plain Error)", path: "/mw-error" },
      { name: "next({statusCode, message})", path: "/mw-plain-object" },
      {
        name: "throw {statusCode, message}",
        path: "/mw-throws-plain-object",
      },
      { name: "a route after the middleware", path: "/hello" },
    ],
  },
  {
    name: "security",
    module: SmallModule,
    configure: configureSecurity,
    skip: HAS_SECURITY_HOOK
      ? undefined
      : "Nest below 12.1 has no useSecurityHeaders()/enableCsrfProtection()",
    probes: [
      { name: "GET, the headers", path: "/hello" },
      {
        name: "cross-site POST, 403",
        path: "/echo",
        init: crossSitePost('{"a":1}'),
      },
      {
        name: "cross-site POST, malformed JSON: 403, body unread",
        path: "/echo",
        init: crossSitePost("{not json"),
      },
      {
        name: "cross-site POST to no route",
        path: "/nope",
        init: { method: "POST", headers: crossSite },
      },
      {
        name: "cross-site POST to an excluded route",
        path: "/health",
        init: { method: "POST", headers: crossSite },
      },
      {
        name: "same-origin POST, parsed",
        path: "/echo",
        init: {
          method: "POST",
          headers: {
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
          },
          body: '{"a":1}',
        },
      },
      {
        name: "POST without browser headers, malformed JSON",
        path: "/echo",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        },
      },
    ],
  },
  ...UPLOAD_GROUPS,
];

/** What a known difference covers: the fields that differ, and why. */
export interface KnownDifference {
  /** `"status"`, `"body"` or a response header name, lower-case. */
  fields: string[];
  /** Why it differs; the README's "Known differences" says the same. */
  reason: string;
}

/**
 * Whether the installed `@nestjs/platform-express` strips the core's `$`
 * exact-match marker into an exact route (12.1.3, nestjs/nest #17942). No
 * capability exposes it, so its `createMiddlewareFactory` is read (as Bun
 * prints it: the quotes are its own). This
 * adapter honours the marker on every version; where Express does not, the
 * one probe it shows in is a known difference.
 */
const EXPRESS_HONOURS_EXACT_MARKER = /endsWith\(["']\$["']\)/.test(
  ExpressAdapter.prototype.createMiddlewareFactory.toString(),
);

/**
 * Whether the installed `@nestjs/platform-express` judges a reply's
 * Content-Type JSON by `isJsonContentType` (12: a `+json` type counts), not
 * by `startsWith("application/json")` (11). No capability exposes it, so its
 * `reply` is read. bun-nest follows 12; on 11 one probe differs.
 */
const EXPRESS_REPLY_KEEPS_PLUS_JSON = /isJsonContentType\(/.test(
  ExpressAdapter.prototype.reply.toString(),
);

/**
 * Whether the installed `@nestjs/platform-express` also treats an object
 * body replied with a status of 400 or more as an error body, `statusCode`
 * of its own or not (12.2.0: `isObject(body) && !isNil(statusCode)`), as
 * bun-nest does on every version. Read from its `reply`, as above.
 */
const EXPRESS_REPLY_CHECKS_REPLY_STATUS =
  /isObject\(body\)\s*&&\s*!isNil\(statusCode\)/.test(
    ExpressAdapter.prototype.reply.toString(),
  );

export const TEXT_DEFAULT =
  "a string body defaults to text/plain here, text/html on Express";
export const TEXT_CHARSET =
  "Express appends `; charset=utf-8` to a type set before a string body";
export const BODY_CHANGES = ["body", "content-length", "etag"];
export const STATIC_VARY = "the static handler adds `Vary: Accept-Encoding`";
const CORS_VARY =
  "CORS adds `Vary: Origin` where the cors package leaves it out (origin `*`, or skipped)";
const CORS_LENGTH = "a preflight 204 carries no `Content-Length: 0`";
export const SERVE_STATIC_REDIRECT =
  "the directory redirect's HTML body links the target (serve-static 1.x) and carries an ETag";

/**
 * Differences that are deliberate, or deferred, keyed `"<group>/<probe>"`.
 * Every other field of every probe must be identical on both adapters.
 */
export const KNOWN: Record<string, KnownDifference> = {
  "compat/res.render callback": {
    fields: ["content-type"],
    reason: TEXT_DEFAULT,
  },
  "compat/@Next() to the next handler": {
    fields: ["content-type"],
    reason: TEXT_DEFAULT,
  },
  "compat/return number": { fields: ["content-type"], reason: TEXT_DEFAULT },
  "compat/return boolean": { fields: ["content-type"], reason: TEXT_DEFAULT },
  "compat/return string": { fields: ["content-type"], reason: TEXT_DEFAULT },
  "compat/res.status().send(string)": {
    fields: ["content-type"],
    reason: TEXT_DEFAULT,
  },
  "compat/res.format 406": { fields: ["content-type"], reason: TEXT_DEFAULT },
  "compat/res.append": { fields: ["content-type"], reason: TEXT_DEFAULT },
  "compat/res.vary": { fields: ["content-type"], reason: TEXT_DEFAULT },
  "compat/res.cookie / clearCookie": {
    fields: ["content-type", "set-cookie"],
    reason: `${TEXT_DEFAULT}; cookies default to SameSite=Lax and order their attributes differently`,
  },
  "compat/res.type(html)": { fields: ["content-type"], reason: TEXT_CHARSET },
  "compat/res.type(json).send(string)": {
    fields: ["content-type"],
    reason: TEXT_CHARSET,
  },
  "compat/res.attachment": { fields: ["content-type"], reason: TEXT_CHARSET },
  "compat/res.format default Accept": {
    fields: ["content-type"],
    reason: TEXT_CHARSET,
  },
  "compat/res.sendStatus(418)": {
    fields: ["content-type"],
    reason: TEXT_CHARSET,
  },
  "compat/return Buffer": {
    fields: ["content-type", ...BODY_CHANGES],
    reason:
      "a returned Buffer is sent as bytes; Nest on Express sends it as JSON",
  },
  "compat/StreamableFile from a Readable": {
    fields: ["content-length"],
    reason: "a stream of known length is sent with Content-Length, not chunked",
  },
  "compat/urlencoded body (extended)": {
    fields: BODY_CHANGES,
    reason: '`d[]=x` parses to "x", not qs\'s ["x"]',
  },
  "compat/text/plain body (no parser)": {
    fields: BODY_CHANGES,
    reason:
      "Nest's default parsing parses every body type, not only JSON and urlencoded",
  },
  "compat/JSON over the 100kb default": {
    fields: ["status", ...BODY_CHANGES],
    reason: "no default body limit; body-parser's is 100kb",
  },
  "compat/request properties": {
    fields: BODY_CHANGES,
    reason:
      "X-Forwarded-* is always trusted (no `trust proxy`), and the query parser nests (Express 5's `simple` does not)",
  },
  "compat/request properties, Host with subdomains": {
    fields: ["body"],
    reason: "`req.subdomains` comes from the public-suffix list, left to right",
  },
  "compat/static file": { fields: ["vary"], reason: STATIC_VARY },
  "compat/static index": { fields: ["vary"], reason: STATIC_VARY },
  "compat/static dir index": { fields: ["vary"], reason: STATIC_VARY },
  "compat/static HEAD": { fields: ["vary"], reason: STATIC_VARY },
  "compat/static2 file (no etag, 1d, immutable)": {
    fields: ["vary"],
    reason: STATIC_VARY,
  },
  "compat/static prefix without slash": {
    fields: BODY_CHANGES,
    reason: SERVE_STATIC_REDIRECT,
  },
  "compat/static dir without slash": {
    fields: BODY_CHANGES,
    reason: SERVE_STATIC_REDIRECT,
  },
  "compat/static range": {
    fields: ["vary", "accept-ranges"],
    reason: `${STATIC_VARY}; Bun's 206 repeats Accept-Ranges`,
  },
  "compat/static unsatisfiable range": {
    fields: ["vary", "accept-ranges", "content-type", "content-length", "body"],
    reason:
      "a 416 is answered directly with an empty body, not passed to the exception filter",
  },
  "compat/static2 dotfile allow": {
    fields: ["content-disposition"],
    reason: "Bun's file response names a dotfile in Content-Disposition",
  },
  "cors-default/simple GET with Origin": {
    fields: ["vary"],
    reason: CORS_VARY,
  },
  "cors-default/preflight": {
    fields: ["vary", "content-length"],
    reason: `${CORS_VARY}; ${CORS_LENGTH}`,
  },
  "cors-default/preflight on unknown path": {
    fields: ["vary", "content-length"],
    reason: `${CORS_VARY}; ${CORS_LENGTH}`,
  },
  "cors-options/preflight allowed": {
    fields: ["content-length"],
    reason: CORS_LENGTH,
  },
  "cors-delegate/delegate refuses": { fields: ["vary"], reason: CORS_VARY },
  "cors-option-true/{cors: true} GET": { fields: ["vary"], reason: CORS_VARY },
  "prefix/excluded route": { fields: ["content-type"], reason: TEXT_DEFAULT },
  "prefix-headers/outside, GET": { fields: ["vary"], reason: CORS_VARY },
  "prefix-headers/outside, HEAD": { fields: ["vary"], reason: CORS_VARY },
  "prefix-headers/under the prefix, a miss": {
    fields: ["vary"],
    reason: CORS_VARY,
  },
  "prefix-param/excluded route": {
    fields: ["content-type"],
    reason: TEXT_DEFAULT,
  },
  "prefix-param/excluded route, HEAD": {
    fields: ["content-type"],
    reason: TEXT_DEFAULT,
  },
  "prefix-versioned-exclusion/excluded, v1": {
    fields: ["content-type"],
    reason: TEXT_DEFAULT,
  },
  "prefix-versioned-exclusion/excluded, neutral": {
    fields: ["content-type"],
    reason: TEXT_DEFAULT,
  },
  ...(EXPRESS_REPLY_CHECKS_REPLY_STATUS
    ? {}
    : {
        "compat/custom HttpException body, text/plain": {
          fields: ["content-type"],
          reason:
            "an object body replied with a status of 400 or more is sent as JSON, as Nest 12.2's reply does; before 12.2 only a body with its own `statusCode` is",
        },
      }),
  ...(EXPRESS_REPLY_KEEPS_PLUS_JSON
    ? {}
    : {
        "compat/error-shaped body, +json": {
          fields: ["content-type"],
          reason:
            "an error-shaped body keeps a `+json` type, as Nest 12's reply does; Nest 11's forces `application/json`",
        },
      }),
  ...(EXPRESS_HONOURS_EXACT_MARKER
    ? {}
    : {
        "prefix-wildcard-middleware/the bare prefix": {
          fields: ["x-mw"],
          reason:
            "the core's `$` exact-match marker is honoured, as Express does only from 12.1.3",
        },
      }),
  "version-uri/URI v1": { fields: ["content-type"], reason: TEXT_DEFAULT },
  "version-uri/URI v3": { fields: ["content-type"], reason: TEXT_DEFAULT },
  "version-uri/URI neutral": { fields: ["content-type"], reason: TEXT_DEFAULT },
  "version-header/header v1": {
    fields: ["content-type"],
    reason: TEXT_DEFAULT,
  },
  "version-header/header v2": {
    fields: ["content-type"],
    reason: TEXT_DEFAULT,
  },
  "version-header/header none": {
    fields: ["content-type"],
    reason: TEXT_DEFAULT,
  },
  "version-header/header v9": {
    fields: ["content-type"],
    reason: TEXT_DEFAULT,
  },
  "version-media/media v1": { fields: ["content-type"], reason: TEXT_DEFAULT },
  "version-media/media v3": { fields: ["content-type"], reason: TEXT_DEFAULT },
  "version-media/media none": {
    fields: ["content-type"],
    reason: TEXT_DEFAULT,
  },
  "compat/StreamableFile, source fails first": {
    fields: ["content-type"],
    reason: TEXT_CHARSET,
  },
  "compat/StreamableFile, source fails, custom handler": {
    fields: ["content-type"],
    reason: TEXT_CHARSET,
  },
  "body-limit/over the limit → 413": {
    fields: BODY_CHANGES,
    reason: "the 413's message names the limit and the size received",
  },
  ...UPLOAD_KNOWN,
};
