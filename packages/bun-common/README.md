# `@kingsleyweb/bun-common`

An Express-style HTTP layer for [`Bun.serve`](https://bun.com/docs/api/http).
`BunRouter` runs the Express 5 middleware pipeline, and `BunHttpAdapter` puts
it on a real server. `BunRequest` and `BunResponse` carry the familiar `req`
and `res` API. Around them sit validation with any Standard Schema, CORS,
static files, response compression, multipart uploads, WebSockets, structured
logging and a set of dependency-free helpers. Route handlers are typed from
the path literal and from the validator in front of them. `fetch()` sends a
request through the production pipeline without opening a socket, so tests
need no port.

The package ships its TypeScript source, which Bun runs directly (`main` points
at `lib/index.ts`), together with built declarations in `dts/` (`types` points at
`dts/index.d.ts`), so a consumer's type checker never compiles our source.
`@kingsleyweb/bun-nest` and `@kingsleyweb/bun-jobs` build on it.

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Feature guide](#feature-guide)
  - [BunRouter](#bunrouter)
    - [Pipeline semantics](#pipeline-semantics)
    - [Route ordering and specificity](#route-ordering-and-specificity)
    - [Router options](#router-options)
    - [Sub-routers, groups and domains](#sub-routers-groups-and-domains)
    - [Named routes and the route cache](#named-routes-and-the-route-cache)
  - [Typed routes](#typed-routes)
  - [BunHttpAdapter](#bunhttpadapter)
    - [Adapter options](#adapter-options)
    - [Listening and closing](#listening-and-closing)
    - [Not-found and error handlers](#not-found-and-error-handlers)
    - [Testing without a socket](#testing-without-a-socket)
    - [Adapter helpers](#adapter-helpers)
  - [BunRequest](#bunrequest)
    - [Request properties](#request-properties)
    - [Request options](#request-options)
    - [Query parsing](#query-parsing)
    - [Body parsing](#body-parsing)
    - [Content negotiation](#content-negotiation)
    - [Request cookies](#request-cookies)
  - [Body decoding](#body-decoding)
  - [BunResponse](#bunresponse)
    - [Sending a body](#sending-a-body)
    - [Headers and response cookies](#headers-and-response-cookies)
    - [Files and byte ranges](#files-and-byte-ranges)
    - [Redirects and format](#redirects-and-format)
    - [Streaming and server-sent events](#streaming-and-server-sent-events)
  - [Validation](#validation)
  - [CORS](#cors)
  - [Static files](#static-files)
  - [Response compression](#response-compression)
  - [Multipart uploads](#multipart-uploads)
  - [WebSockets](#websockets)
    - [Headers on the 101](#headers-on-the-101)
  - [Structured logging](#structured-logging)
  - [Native utilities](#native-utilities)
- [Examples](#examples)
  - [Example projects](#example-projects)
  - [bun-common examples](#bun-common-examples)
  - [Running the examples](#running-the-examples)
- [Related packages](#related-packages)
- [Development](#development)
- [License](#license)

## Requirements

- **Bun 1.4.2 or later** (`engines.bun: ">=1.4.2"`).
- **`@types/bun` 1.4.2 or later**: an *optional* peer dependency. With older
  types you get a peer warning instead of confusing type errors.
- **TypeScript** 5.9 or 6: an optional peer. Bun runs the `.ts` source as it
  is; only type-checking needs TypeScript.

The runtime dependencies are small parsers that a native API does not replace:
`@routejs/router`, `busboy`, `file-type`, `mime`, `parse-domain`, `accepts`,
`type-is` and `picoquery`.

## Installation

```bash
bun add @kingsleyweb/bun-common
bun add -d @types/bun typescript
```

## Quick start

```ts
import type { RouterErrorMiddlewareHandler } from "@kingsleyweb/bun-common";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";

const app = new BunHttpAdapter();
const todos = new Map<number, { id: number; title: string }>();

app.get("/todos/:id", (req, res, next) => {
  const todo = todos.get(Number(req.params.id));
  if (todo) {
    res.json(todo);
  } else {
    next(); // nothing else matches, so the not-found handler answers
  }
});

app.post("/todos", (req, res) => {
  const { title } = (req.body ?? {}) as { title?: unknown };
  if (typeof title !== "string" || title === "") {
    throw Object.assign(new Error("title is required"), { status: 400 });
  }
  const todo = { id: todos.size + 1, title };
  todos.set(todo.id, todo);
  res.status(201).json(todo);
});

// A 4-parameter callback is an error handler. It runs in registration order,
// so register it after the routes it covers.
app.use(((error, _req, res, _next) => {
  const status = (error as { status?: number }).status ?? 500;
  res.status(status).json({ error: (error as Error).message });
}) satisfies RouterErrorMiddlewareHandler);

app.setNotFoundHandler((req, res) => {
  res.status(404).json({ error: `nothing at ${req.method} ${req.path}` });
});

await app.listen(0); // port 0 asks the OS for a free port
console.log("listening at", app.url);

const created = await fetch(`${app.url}/todos`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "write the docs" }),
});
console.log(created.status, await created.json());

await app.close(); // force-closes the server and its keep-alive connections
```

Runnable version:
[`examples/bun-common/01-quick-start/index.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/01-quick-start/index.ts).

## Feature guide

### BunRouter

`BunRouter` extends `@routejs/router` and gives it Express 5 semantics.
`BunHttpAdapter` *is* a `BunRouter`, and bun-nest's adapter delegates to one,
so everything here applies to both.

Verb methods cover every `@routejs/router` verb (`get`, `post`, `put`,
`patch`, `delete`, `head`, `options`, and the WebDAV set). The rest of the
registration API:

| Method | Registers |
|---|---|
| `get(path, ...handlers)` and the other verbs | route handlers, matched exactly |
| `all(path, ...handlers)` | a route handler for every method |
| `any(methods, path, ...handlers)` | a route handler for a list of methods |
| `add(method, path, ...handlers)` / `addRoute(...)` | a route handler for one method given as a string |
| `use([path], ...handlersOrRouters)` | middleware or a mounted router, matched as a **prefix** |
| `useMethod(method, [path], ...handlers)` | middleware that runs for one method only (prefix match) |
| `group(path, routerOrCallbackOrHandlers)` | routes under a path prefix |
| `domain(host, routerOrCallbackOrHandlers)` | routes for a host pattern |
| `ws(path, handler, customDataFn?)` | a WebSocket upgrade route (see [WebSockets](#websockets)) |

Express 5 catch-all syntax works: `*name`, `{*name}` and `{*}`. A named
wildcard is exposed as both the positional key and the name.

#### Pipeline semantics

`handle()` walks every callback of every matched route in a single pass:

- Middleware and route handlers run in **registration order**.
- A callback declaring **four parameters** is an **error handler**.
- A thrown error, a rejected promise or `next(err)` switches the pipeline to
  **error mode**. Regular callbacks are skipped and only error handlers run,
  as `(err, req, res, next)`.
- An error handler calling `next()` with no argument clears the error and
  resumes normal processing. `next(err)` keeps propagating it.
- `next("route")` skips the rest of the current route's callbacks.
- `next("router")` leaves the current mounted sub-router. From the router's
  own routes it abandons the pipeline.
- `next()` is the only way forward. A callback that neither responds nor calls
  `next()` leaves the request **hanging** until a timeout fires, and its return
  value is ignored.
- An error nothing handled is re-thrown to the adapter's final error handling
  ([below](#not-found-and-error-handlers)).
- A path parameter that is not valid percent-encoding becomes a `URIError`
  with `status: 400`, as in Express 5.

`use("/api", mw)` compiles a prefix match (`/api`, `/api/users`, ...). A verb
route such as `get("/api", h)` matches only `/api`.

```ts
import type { RouterErrorMiddlewareHandler } from "@kingsleyweb/bun-common";
import { BunRouter } from "@kingsleyweb/bun-common";

const router = new BunRouter();

router.use("/admin", (req, res, next) => {
  if (req.get("authorization")) {
    next();
  } else {
    next(Object.assign(new Error("unauthorised"), { status: 401 }));
  }
});

router.get(
  "/admin/report",
  (req, _res, next) => (req.query.cached ? next("route") : next()),
  (_req, res) => res.send("fresh report"),
);
router.get("/admin/report", (_req, res) => res.send("cached report"));

router.use(((error, _req, res, _next) => {
  res.status((error as { status?: number }).status ?? 500).send(String(error));
}) satisfies RouterErrorMiddlewareHandler);
```

> An inline four-parameter error handler needs `satisfies
> RouterErrorMiddlewareHandler`. TypeScript cannot choose an overload by
> arrow arity, so without it every parameter is inferred as `any`.

Examples:
[`middleware-and-errors.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/02-routing/middleware-and-errors.ts),
[`verbs-and-params.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/02-routing/verbs-and-params.ts).

#### Route ordering and specificity

When several **route handlers** match a request, they run in registration
order by default, as in Express. Middleware registered with `use` always keeps
registration order.

`routeSpecificity: true` (or `setRouteSpecificity(true)`) ranks them instead:
static segments beat parameters, and fewer parameters or more regexp
constraints win. A comparator `(a, b) => number` over `{ route, matched }`
entries sets your own rule. Registration order breaks ties in both cases.
`setRouteSpecificity` also clears the route cache.

```ts
import { BunRouter } from "@kingsleyweb/bun-common";

const router = new BunRouter({ routeSpecificity: true });
router.get("/users/:id", (_req, res) => res.send("by id"));
router.get("/users/me", (_req, res) => res.send("me")); // wins for /users/me
```

#### Router options

`new BunRouter(options?)`:

| Option | Type | Default | Meaning |
|---|---|---|---|
| `caseSensitive` | `boolean` | `false` | Case-sensitive path and host matching. A mounting router's setting wins over a sub-router's. |
| `host` | `string` | none | Default host pattern for every route (`"api.example.com"`, `":tenant.example.com"`, `"*.example.com"`). A literal host is also the origin `fetch()` resolves bare paths against. |
| `routeSpecificity` | `boolean \| (a, b) => number` | `false` | How competing route handlers are ordered (see above). |
| `routeCacheMax` | `number` | `50_000` (`DEFAULT_ROUTE_CACHE_MAX`) | Maximum entries in the matched-pipeline cache before FIFO eviction. `0` disables the cache. |
| `debug` | `boolean` | `false` | Logs one `debug` record per pipeline layer run. The logger's level must also admit `debug`. |
| `logger` | `LoggerLike` | console logger | See [Structured logging](#structured-logging). Also settable with `setLogger()` or `router.logger = ...`. |
| `bunWebsocket` | `BunWebSocket` | none | The WebSocket instance `ws()` registers on. `setBunWebSocket()` takes precedence. |

Example tour:
[`router-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/router-options.ts).

#### Sub-routers, groups and domains

- `use(router)` / `use(path, router)` flattens a router's routes into the
  parent, prefixed with `path`. Its middleware becomes prefix middleware at
  the mount. `req.baseUrl` is the part of the path the mount matched.
- `group(path, ...)` accepts a router, a `(router) => { ... }` callback, or
  prefix middleware. A **single** function declaring at most one parameter is
  treated as the callback form. Register a one-parameter `(req) => ...`
  handler with `use(path, handler)` instead.
- `domain(host, ...)` has the same three forms, scoped to a host pattern.
  Captures such as `:tenant` are merged into `req.params`; a path parameter
  of the same name wins.

```ts
import { BunRouter } from "@kingsleyweb/bun-common";

const app = new BunRouter();

app.group("/v1", (v1) => {
  v1.get("/status", (_req, res) => res.send("ok"));
});

app.domain(":tenant.example.com", (tenant) => {
  tenant.get("/users/:id", (req, res) => res.json(req.params)); // { tenant, id }
});
```

Example:
[`sub-routers.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/02-routing/sub-routers.ts).

#### Named routes and the route cache

`router.get("/users/:id", h).setName("user")` names the route just
registered, and `getRouteByName("user")` looks it up. Calling `setName` after
`use`, `group`, `domain` or a mount throws, because middleware cannot be
named. A duplicate name also throws.

Matched pipelines are cached per host, path and method. The cache key is the
**resolved** path, so a route carrying an id needs one entry per distinct id.
Set `routeCacheMax` above the number of distinct live paths, or set it to `0`.
A value between the two means every request misses *and* pays for eviction.
`clearRouteCache()` empties the cache.

`RouteClass`, `routeModulePath` and `toNativeRequest` are also exported, for
advanced integration.

Example:
[`route-cache.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/02-routing/route-cache.ts).

### Typed routes

The verb methods of `BunRouter` and `BunHttpAdapter` carry generated
overloads that narrow the handler's request:

- **`req.params` from the path literal.** `get("/home/:name/:id?", h)` gives
  `{ name: string; id?: string }`. `ExtractRouteParams<"/a/:b">` exposes the
  same computation.
- **`req.query` / `req.body` / `req.params` from a validator** placed
  **immediately before** the handler in the same call. One
  `validate({ params, query, body })` covers every target.

```ts
import { BunRouter, validate } from "@kingsleyweb/bun-common";
import { z } from "zod";

const router = new BunRouter();

router.get(
  "/posts/:id",
  validate({ query: z.object({ page: z.coerce.number().default(1) }) }),
  (req, res) => {
    // req.params: { id: string }   req.query: { page: number }
    res.json({ id: req.params.id, page: req.query.page });
  },
);
```

A handler declared ahead of time (typed `ResolvedHandler` or
`TypedRouteHandler`) cannot follow an *inline* `validate(...)` call. Store the
validator in a variable first, or spell out the verb's type arguments:
`router.get<"/posts/:id", { query: { page: number } }>(...)`.

**Mounted sub-routers** declare the path, and optionally the validated shape,
they will be mounted at. Their routes can then see the mount's params:

```ts
import { BunHttpAdapter, BunRouter, validate } from "@kingsleyweb/bun-common";
import { z } from "zod";

const PageQuery = z.object({ page: z.coerce.number() });
const adapter = new BunHttpAdapter();

const users = new BunRouter<"/users/:id">();
users.get("/posts/:postId", (req, res) => res.json(req.params)); // { id, postId }
adapter.use("/users/:id", users);

const orgs = new BunRouter<"/orgs/:org", { query: { page: number } }>();
orgs.get("/", (req, res) => res.json({ page: req.query.page }));
adapter.use("/orgs/:org", validate({ query: PageQuery }), orgs);
```

`use()` checks that the declaration and the actual mount agree. A wrong path,
a wrong shape, or a declared shape mounted without its validator is a compile
error. Mount *params* are deliberately left out of the propagated types,
because the pipeline rebinds `req.params` on entering each route.

**A verb chosen at runtime.** `RouterVerb` is the union of verb method names.
`RouterVerbMethod<TRouter>` is the untyped `(path, ...handlers)` signature
every verb shares. Call it with `.call(router, ...)`:

```ts
import type { RouterVerbMethod } from "@kingsleyweb/bun-common";
import { BunRouter } from "@kingsleyweb/bun-common";

const router = new BunRouter();
for (const verb of ["get", "post"] as const) {
  const register: RouterVerbMethod<typeof router> = router[verb];
  register.call(router, "/doc", (req, res) => res.send(req.method));
}
```

Other exported typing helpers: `TypedRouteHandler`, `ResolvedHandler`,
`MountedHandler`, `ResolveParams`, `ResolveQuery`, `ResolveBody`,
`MergeShape`, `ValidationShape`, `EmptyShape` and `UnmountedRouter`.

Examples:
[`typed-routes.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/02-routing/typed-routes.ts),
[`typed-handlers.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/06-validation/typed-handlers.ts).

### BunHttpAdapter

`new BunHttpAdapter<WsData>(requestTimeout?, options?)` is a `BunRouter` that
owns a `Bun.serve` server. Each request goes through one method,
`handleNativeRequest`, which does the following in order:

1. builds the `BunRequest`;
2. applies the payload guard (413) and the body-decoding check (415 or 400);
3. runs the router;
4. runs the not-found handlers;
5. performs any WebSocket upgrade;
6. finalises the response.

#### Adapter options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `requestTimeout` (1st argument) | `number` | `0` | Milliseconds to wait for a response once the pipeline has run. `0` means no timeout. Also settable with `setTimeout(ms, cb)`. |
| `request` | `Partial<BunRequestOptions>` | `{ parseBody: true, parseCookies: true }` | Parsing options for every request; see [Request options](#request-options). Merged over the default object (`mergeBunRequestOptions`), so `{ cookieSecret }` alone keeps body parsing on; set a default explicitly to turn it off. Change it later with `setRequestOpts()`. |
| `router` | `BunRouterOptions` | `{ caseSensitive: true, debug: false }` | [Router options](#router-options), merged over those defaults. **The adapter is case-sensitive by default**, unlike a bare `BunRouter`. |
| `routeCacheMax` | `number` | `50_000` | Forwarded to the router. `0` disables the cache. |
| `etag` | `boolean` | `false` | Adds an `ETag` to every response (opt-in: hashing every body has a cost). |
| `logger` | `LoggerLike` | console logger | Shared by the adapter and its router. |
| `websocket` | `Partial<WebsocketOptions>` | none | Overrides for the built-in `BunWebSocket`, such as `wsOptions` or `onUpgrade`. |
| `server` | `Bun.serve` options | `{}` | Base server options (TLS, `maxRequestBodySize`, ...). `port`, `hostname`, `fetch`, `websocket` and `error` are managed by the adapter. `development` is set from `NODE_ENV !== "production"`. |

Example tours:
[`adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/03-http-adapter/adapter-options.ts),
[`http-adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/http-adapter-options.ts).

#### Listening and closing

- `listen(port, [hostname], [callback])` starts `Bun.serve`. `hostname`
  defaults to `127.0.0.1`, and port `0` is OS-assigned. It resolves with the
  server, emits `listening` on `adapter.eventEmitter`, then awaits
  `callback(server)`.
  - A port that cannot be bound rejects with Bun's error; the adapter never
    moves to another port.
  - A second call for the same address (or port `0`) resolves with the
    running server.
  - A call for a different address stops the old server and binds the new one.
- `setListenOptions({ port, hostname, ...serveOptions })` merges server options,
  then listens.
- `close()` force-stops the server with `server.stop(true)` and emits `close`.
  A graceful stop would leave keep-alive connections answering from the old
  server, which `SO_REUSEPORT` can route to a new server on the same port.
  Routes and handlers survive, so you can `listen()` again.
- Getters: `url`, `server`, `isListening` / `listening`, `listeningHost`,
  `listeningPort`, `address()`, `timeout`. `nodeHttpServer()` returns a
  Node-style server shim whose event methods delegate to `eventEmitter`.

Example:
[`listen-and-close.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/03-http-adapter/listen-and-close.ts).

#### Not-found and error handlers

- `setNotFoundHandler((req, res, next) => ...)` runs when no route answered.
  Without one, the response is an empty `404`.
- `setErrorHandler((err, req, res, next) => ...)` handles an error the
  router's own error handlers left unhandled. It runs for served requests and
  for `fetch()` alike.

Both kinds of handler run in registration order and are kept across
`close()`. Error handlers follow Express's error middleware, against a fresh
response, and ignore return values:

- `next(err)` passes `err` to the next error handler. When none is left, the
  error gets the final response described below.
- `next()`, `next("route")` or `next("router")` ends error mode, and with
  nothing after it the answer is Express's 404.
- A handler that responds ends the chain.
- A handler may call `next` later, from a callback, and that call is honoured.

Not-found handlers keep their own rule: the loop moves to the next handler
only while a handler returns a truthy value, and stops on `next(err)`.

When no error handler is registered, when the error carries no request, or
when a handler itself throws, the adapter answers the way Express's
`finalhandler` does. The standalone `finalErrorResponse(error, { method, path, log })`
builds that response:

- The status is `err.status` or `err.statusCode` when it is 4xx or 5xx, else
  `500`. `errorStatusCode(error)` computes it.
- The body is an HTML page containing only the status message, never the
  error's message or stack, so nothing leaks.
- `Content-Security-Policy: default-src 'none'` and
  `X-Content-Type-Options: nosniff` are set, plus any `err.headers`.
- A `HEAD` request gets no body.
- The adapter logs the error at `error` level, except under `NODE_ENV=test`.

#### Testing without a socket

`router.fetch()` and `adapter.fetch()` run a request through the real pipeline
and resolve the `Response` without binding a port:

```ts
import { BunHttpAdapter } from "@kingsleyweb/bun-common";

const app = new BunHttpAdapter();
app.get("/users/:id", (req, res) => res.json({ id: req.params.id }));

await app.fetch("/users/42"); // a string means GET
await app.fetch("/users", { method: "POST", body: "{}" }); // path + RequestInit
await app.fetch({ url: "/users", method: "POST", body: "{}" }); // RequestInit with url
await app.fetch(new Request("http://localhost/users/42")); // full control
```

The adapter's `fetch()` calls `handleNativeRequest`, the same method its
`Bun.serve` handler calls. Not-found handlers, error handlers, the payload
guard and response finalisation all behave as in production. It never
rejects for a pipeline error: it resolves the final error response instead.
Without a socket there is no peer, so `requestIP()` is `null` and a WebSocket
upgrade cannot succeed. A bare `BunRouter.fetch()` always parses with
`parseBody: true`; use the adapter to test request options.

Example:
[`fetch-testing.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/02-routing/fetch-testing.ts).

#### Adapter helpers

| Method | Does |
|---|---|
| `useBodyParser(kind, rawBody, options)` | Registers one body parser (`"json"`, `"urlencoded"`, `"text"` or `"raw"`), once per kind. `options` follows body-parser: `type`, `limit` (over it: 413), `inflate` (`false`: 415), plus the [body-decoding](#body-decoding) options. `rawBody: true` keeps the bytes on `req.rawBody`. |
| `registerParserMiddleware(prefix?, rawBody?)` | Registers a parser for every body type, optionally under a prefix. |
| `enableCors(options \| delegate, prefix?)` | Registers the [CORS](#cors) middleware plus an `OPTIONS *` preflight route. |
| `useStaticAssets(root, options)` | Serves a directory on `${options.prefix}/*`; see [Static files](#static-files). |
| `setRequestOpts(options)` | Replaces the request options, merged over the defaults (not over the options set before). The `requestOpts` setter does the same. |
| `setTimeout(ms, callback)` | Sets `requestTimeout` and calls back with the server once it is listening. |
| `setInstance(router)` | Routes requests through another `BunRouter`. Register routes on the new instance afterwards. |
| `setLogger(logger)` | Replaces the logger. |

Example:
[`handlers.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/03-http-adapter/handlers.ts).

### BunRequest

`BunRequest<TParams, TQuery, TBody>` wraps the native `Request` (`req.request`)
with the Express and Node `IncomingMessage` surface. Fields are computed
lazily, so a request that only routes pays for nothing else.

#### Request properties

| Group | Members |
|---|---|
| URL | `url`, `originalUrl`, `path`, `search` / `querystring`, `hash`, `baseUrl`, `parsedUrl` |
| Routing | `method`, `params`, `query`, `route` (the matched route while a route handler runs) |
| Connection | `host`, `hostname`, `protocol`, `secure`, `ip`, `ips`, `subdomains`, `xhr`, `httpVersion`, `socket`, `server` |
| Headers | `headers`, `headersDistinct`, `rawHeaders`, `get(name, default?)`, `getHeader`, `getHeaders`, `getHeaderNames`, `hasHeader` |
| Body | `body`, `buffer` (the exact bytes received), `rawBody` (set by a parser registered with `rawBody: true`), `files` / `file` (uploads), `isBodyParsed`, `isPayloadTooLarge`, `bodyDecodingError` |
| Caching | `fresh`, `stale`, `range(size, { combine })` (`-1` unsatisfiable, `-2` malformed) |
| Cookies | `cookies`, `signedCookies`, `secret` |

`req.get("set-cookie")` returns an **array**, as Node does, because a cookie's
`Expires` date contains a comma. Every other repeated header comes back
comma-joined. `BunRequest` also emits Node's request events (`data`, `end`,
`error`, `aborted`, `close`).

Examples:
[`reading-a-request.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/04-request/reading-a-request.ts),
[`request-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/request-options.ts).

#### Request options

Given as the adapter's `request` option, merged over
`DEFAULT_ADAPTER_REQUEST_OPTIONS` by `mergeBunRequestOptions(options, base?)`.
A key left `undefined` keeps the default. `parseBody` objects merge too, and
so do their `contentTypes` maps; a boolean on either side replaces the other.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `parseBody` | `boolean \| ParseBodyConfig` | `true` | `true` parses every body with **no size cap**, and `false` parses none. An object enables caps and a per-type allowlist. |
| `parseCookies` | `boolean` | `true` | Parses `Cookie` into `req.cookies`. |
| `parseQuery` | `boolean` | `true` | Parses the query string into `req.query`. |
| `parseQueryOpts` | `QueryParserOpts` | `DEFAULT_PARSE_QUERY_OPTS` | picoquery options, merged over the defaults. |
| `cookieParseOptions` | `CookieParseOptions` | none | Cookie parser options. |
| `cookieSecret` | `string \| string[]` | none | Secret(s) for signed cookies, as `cookieParser(secret)`. `req.secret` is the first entry, and every entry verifies (rotation). See [Request cookies](#request-cookies). |
| `parseMultiPartFormDataOpts`, `parseXmlOpts`, `allowedContentTypes` | | | Deprecated: use `parseBody.contentTypes` instead. |

#### Query parsing

The query string is parsed with `picoquery`.
The defaults are `DEFAULT_PARSE_QUERY_OPTS`: `nesting: true`,
`nestingSyntax: "js"` (both `a.b` and `a[b]`), `arrayRepeat: true` and
`arrayRepeatSyntax: "repeat"`. Options you pass are merged over them; to opt
out of one, set it explicitly (`{ arrayRepeat: false }`). Beyond picoquery's
own options there are two more:

- `decodeURIComponent: true` decodes the whole string before parsing.
  Rarely needed, because it double-decodes content.
- `decode: (query) => string` replaces the pre-parse decoding step entirely.

`req.parseQuery(opts)` and `req.setQueryParserOptions(opts)` re-parse at run time.

#### Body parsing

With the object form of `parseBody`, the body is capped and parsed while the
request is built. A body over its cap is refused with **413** before any
middleware runs.

```ts
import { BunHttpAdapter } from "@kingsleyweb/bun-common";

const app = new BunHttpAdapter(0, {
  request: {
    parseBody: {
      maxContentLength: "1mb",
      contentTypes: {
        json: { opts: { reviver: (_key, value) => value } },
        urlencoded: true,
        multipart: { maxContentLength: "20mb" },
      },
      encodings: ["gzip", "br"],
    },
  },
});

app.post("/echo", (req, res) => res.json({ body: req.body }));
```

| `ParseBodyConfig` field | Default | Meaning |
|---|---|---|
| `maxContentLength` | 100kb (`DEFAULT_MAX_CONTENT_LENGTH`); 10mb for `multipart` and `raw` (`DEFAULT_MAX_CONTENT_LENGTH_BY_KIND`) | Overall cap, in bytes or as a string such as `"5mb"`. It applies to the **decoded** size, so a decompression bomb is a 413 too. |
| `contentTypes` | `"all"` | An allowlist keyed by kind: `json`, `urlencoded`, `xml`, `multipart`, `text` or `raw`. Each is `true` or `{ opts, maxContentLength }`. A kind left out is not parsed: `req.body` is the raw `Buffer`. |
| `inflate`, `decompressionFastPathLimit`, `encodings`, `maxContentCodings`, `compressionDictionaries` | see [Body decoding](#body-decoding) | How a `Content-Encoding` body is decoded. |

- `PayloadTooLargeError` (`status` and `statusCode` 413, `limit`, `length`)
  is thrown by `parseBody()` and by a parser middleware's `limit`.
- `req.setParseBodyOptions()` and `req.parseBodyWithOptions()` change the
  options from middleware; they only affect a body not yet read.
- A media type no parser knows is kept as a `Buffer` with its `Content-Type`
  rewritten to `application/octet-stream`. For a custom format, run with
  `parseBody: false` and read `req.request` yourself.
- Multipart bodies are read with `req.getMultiParts(options)`, or through the
  [upload handlers](#multipart-uploads).

Example:
[`body-parsing.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/04-request/body-parsing.ts).

#### Content negotiation

Negotiation is backed by `accepts` and `type-is`:

- `req.accepts("json", "html")` returns the best match or `false`; with no
  argument it returns the whole list.
- `acceptsEncodings`, `acceptsCharsets` and `acceptsLanguages` work the same
  way, and each has a singular alias.
- `req.is("json")` returns the matched type, `false` when the body does not
  match, or `null` when there is no body.

The standalone `accepts(requestLike)` and `typeIs(requestLike, types)` take
any object with `headers`.

#### Request cookies

`req.cookies` holds unsigned cookies; a `j:`-prefixed value is JSON-decoded,
as cookie-parser does. Signed (`s:`) cookies move to `req.signedCookies` once
a secret verifies them, and a tampered one becomes `false`.

The `cookieSecret` request option does what `cookieParser(secret)` does, on
every request. It sets `req.secret` to its first entry while the request is
built, and verifies signed cookies against every entry. `res.cookie(name,
value, { signed: true })` then signs with that same first entry:

```ts
import { BunHttpAdapter } from "@kingsleyweb/bun-common";

// Newest first: "s3cret" signs, and cookies signed with "0ld" still verify.
const app = new BunHttpAdapter(0, { request: { cookieSecret: ["s3cret", "0ld"] } });
app.get("/me", (req, res) => {
  res.cookie("seen", "yes", { signed: true });
  res.json(req.signedCookies);
});
```

Without `cookieSecret`, verify in middleware instead:

```ts
import { BunHttpAdapter } from "@kingsleyweb/bun-common";

const app = new BunHttpAdapter();
app.use((req, _res, next) => {
  req.parseCookies({ secret: "s3cret", forceUpdateRequest: true });
  next();
});
```

Example:
[`cookies.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/04-request/cookies.ts).

### Body decoding

A request body with `Content-Encoding` is decoded before it is parsed. Beyond
body-parser, which accepts exactly one of `gzip`, `deflate` or `br`, the
decoder handles:

- `gzip` (and `x-gzip`), `deflate`, `br` and `zstd`;
- **stacked codings** such as `gzip, br`, decoded last to first (RFC 9110 §8.4);
- **dictionary-compressed** `dcb` and `dcz` bodies (RFC 9842), when you
  provide the dictionaries.

These options go in the object form of `parseBody` (applied while the request
is built) or in `useBodyParser` options (applied only to a body not yet read):

| Option | Type | Default | Meaning |
|---|---|---|---|
| `inflate` | `boolean` | `true` | `false` refuses any coding other than `identity` with 415 (the same as `encodings: []`). A request with no body is never refused. |
| `encodings` | `"*" \| string[]` | `"*"` | Allowlist. `"*"` admits every coding the library decodes. A list admits only its members (`"gzip"` also admits `x-gzip`). `identity` is always admitted. An unknown entry is a `RangeError`. |
| `maxContentCodings` | `number` | `5` (`DEFAULT_MAX_CONTENT_CODINGS`) | The most codings one header may stack. More is a 415, refused before anything is decoded. |
| `decompressionFastPathLimit` | `number` | 32 MiB (`DEFAULT_DECOMPRESS_FAST_PATH_LIMIT`) | Worst-case memory one layer may use in Bun's faster, uncapped decoder. A layer above it goes through `node:zlib`, which stops at the body limit; `br`, `dcb` and `dcz` always do. `0` disables the fast path and `Infinity` always uses it. |
| `compressionDictionaries` | `Uint8Array[] \| (hash, encoding) => Uint8Array \| undefined` | none | Dictionaries for `dcb` and `dcz`, indexed by SHA-256, or a resolver. Without it those codings are refused with 415. |

How a failure is answered:

| Status | When |
|---|---|
| **415** | a coding that is unsupported or not allowed, in any layer; `inflate: false`; too many stacked codings; `dcb`/`dcz` without `compressionDictionaries`; a `*` sent in `Content-Encoding` |
| **400** | data a layer cannot decode; a dictionary the header names but that was not provided |
| **413** | a layer decoding past the body limit |

`decompressBody(bytes, contentEncoding, options)` exposes the same decoder
directly.

Example:
[`body-parsing.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/04-request/body-parsing.ts).

### BunResponse

`BunResponse` builds a native `Response` with the Express `res` API and Node's
`ServerResponse` streaming methods. Most methods chain.

#### Sending a body

| Method | Behaviour |
|---|---|
| `status(code)`, `statusText(text)`, `sendStatus(code)` | Set the status; `sendStatus` also sends the reason phrase as text. |
| `send(body)` | Accepts a string (`text/plain` unless a type is set), a plain object or array (JSON), a `Buffer` / typed array / `ArrayBuffer` (`application/octet-stream`), a `Blob` or `BunFile`, `FormData`, `URLSearchParams`, a `ReadableStream`, a Node `Readable`, an async iterable or `async function*`, or a `Response` / `BunResponse` (passed through). A number or boolean is sent as a string, where Express 5 sends JSON. |
| `json(body)` | `application/json`. Use `json<Dto>(body)` to check the body's shape. |
| `jsonp(body)` | Wraps the body in `?callback=` as `text/javascript`, with Express's sanitising and `nosniff`. |
| `type(t)` / `contentType(t)`, `attachment(filename?)`, `location(url)`, `links(map)`, `vary(fields)` | Header helpers with Express semantics. |
| `setEtag(enabled?)` | Enables `ETag` for this response. A matching conditional request becomes a 304. |
| `getBody()`, `headersSent` | Inspection. |

Freshness follows Express: a fresh conditional request becomes 304, and a 204
or 304 loses its body headers.

Example:
[`sending.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/05-response/sending.ts).

#### Headers and response cookies

- `set(name, value, replace = true)` / `setHeader` accept a string or an array.
- `append` / `appendHeader` add to a header instead of replacing it.
- `get` / `getHeader`, `hasHeader`, `removeHeader`, `getHeaderNames`.
- `getHeaders()` returns lower-cased names. `set-cookie` is an **array** of
  lines in `getHeaders()` and in `get("Set-Cookie")`, as in Node.

`res.cookie(name, value, options)` appends a `Set-Cookie`. An object value is
written as a `j:` JSON cookie. `clearCookie(name, options)` expires one.

| Cookie option | Meaning |
|---|---|
| `maxAge` | Milliseconds from now, a number or numeric string. Written as `Max-Age` in seconds plus a matching `Expires`. |
| `signed`, `secret` | Sign the value (`s:`) with `secret`, or with `req.secret` (its first entry) when that is unset; `req.secret` comes from the `cookieSecret` request option or middleware. Throws when there is no secret. |
| `path` | Defaults to `/`. |
| `domain`, `expires`, `httpOnly`, `secure`, `partitioned`, `priority` | Standard attributes. |
| `sameSite` | `true` means `Strict` and `false` omits the attribute. Left unset, Bun emits `SameSite=Lax`. |

Example:
[`cookies-and-caching.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/05-response/cookies-and-caching.ts).

#### Files and byte ranges

`await res.sendFile(path, options)` follows Express 5 `res.sendFile` (the
`send` package). `path` must be absolute unless `root` is given, and with
`root` even an absolute path resolves under it.

| Option | Default | Meaning |
|---|---|---|
| `root` | none | Directory a path is resolved under. A `..` segment answers 403 and a NUL byte 400. |
| `dotfiles` | `"ignore"` | `"ignore"` answers 404, `"deny"` 403, `"allow"` serves the file. |
| `acceptRanges` | `true` | `Accept-Ranges: bytes`. One satisfiable range gets a 206, an unsatisfiable one a 416. `If-Range` is honoured, and several ranges send the whole file. |
| `cacheControl` | `true` | `public, max-age=<seconds>` when no `Cache-Control` is set. |
| `maxAge` | `0` | Milliseconds or an `ms` string (`"1d"`), capped at one year. |
| `immutable` | `false` | Adds `immutable` to `Cache-Control`. |
| `lastModified` | `true` | `Last-Modified` from the file's mtime. |
| `headers` | none | Extra headers, applied first, so they win over the defaults. |
| `download`, `filename` | `false`, the basename | Adds `Content-Disposition: attachment`. |

Conditional requests are honoured: a failed precondition answers 412 and a
fresh one 304. A missing file or a directory is answered with its status and
an empty body. `res.download(path, filename?, options?, cb?)` is `sendFile`
with `download: true`.

#### Redirects and format

- `res.redirect(url, status = 302)` builds a fresh `Response.redirect`, so
  headers set earlier on `res` are **not** carried over.
- `res.format({ json: h, html: h, default: h })` runs the handler matching
  `Accept`. With no match and no `default` it passes a 406 error to `next`,
  or answers 406 directly outside a pipeline.

#### Streaming and server-sent events

`write(chunk)` opens a long-lived streamed response, and `end(chunk?)`
finishes it.

The semantics are Node's:

- The first `write()` (or `flushHeaders()`) sends the headers set so far and
  adds none. A Content-Type you set is kept. For server-sent events, set
  `Content-Type: text/event-stream` yourself before writing, as NestJS's
  `@Sse()` does. `compression()` flushes each chunk only for that type.
- A write after the response has ended returns `false` and emits
  `ERR_STREAM_WRITE_AFTER_END`.
- A chunk that is not text or bytes throws `ERR_INVALID_ARG_TYPE`.
- `writeHead(status, [message], [headers])` and `flushHeaders()` are
  supported.
- The response emits `finish`, `close`, `error`, `drain`, `pipe` and `unpipe`.

Start the producer without awaiting it, so the handler returns and the client
reads chunks as they arrive:

```ts
import type { BunResponse } from "@kingsleyweb/bun-common";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";

async function tick(res: BunResponse) {
  for (let n = 1; n <= 3; n++) {
    res.write(`data: tick ${n}\n\n`);
    await Bun.sleep(100);
  }
  await res.end();
}

const app = new BunHttpAdapter();
app.get("/events", (_req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  tick(res).catch(() => res.end());
});
```

For a body that is a stream from the start, pass a `ReadableStream`, Node
`Readable` or async generator to `send()`. `res.flush()` pushes out data
buffered by a response transform such as [compression](#response-compression).

Example:
[`files-and-streams.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/05-response/files-and-streams.ts),
tour
[`response-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/response-options.ts).

### Validation

`validate(schemas, options?)`, `new BunValidate({ schemas, ...options }).middleware()`
and `BunValidate.middleware(options)` all build ordinary router middleware from
[Standard Schema](https://standardschema.dev) schemas. The package imports no
validation library. Every library below is tested against:

| Library | Standard Schema support |
|---|---|
| zod 4, yup 1.7, valibot 1, arktype 2 | native: pass the schema directly |
| superstruct 2, joi, a hand-written check | wrap with `toStandardSchema(validateFn, { vendor })` |

Targets are `headers`, `params`, `query` and `body`, validated in that order.
On success the parsed output **replaces** `req.params`, `req.query` and
`req.body`, so `z.coerce.number()` gives the handler a `number`. Headers are
checked but never replaced.

| Option | Default | Meaning |
|---|---|---|
| `onFailure` | `"next"` | `"next"` passes a `ValidationError` to the error pipeline, `"throw"` throws it, and `"respond"` answers at once. |
| `status` | `400` | The status `"respond"` uses, also reported on the error. |
| `abortEarly` | `false` | Stop at the first failing target instead of collecting every issue. |
| `replace` | `true` | Write parsed values back. With `false` the handler keeps the request's own types. |
| `hooks` | none | Per-target `{ normalize, transform }`. `normalize(raw, req)` runs before validation; `transform(parsed, req)` runs after it, and its return type becomes the handler's type. Only targets that have a schema accept hooks. |
| `formatError` | `{ error: "Validation failed", issues }` | The JSON body `"respond"` sends. |

`ValidationError` carries `issues` (each `{ target, message, path }`, with
`path` dot-joined), `targets` and `status`.

```ts
import { toStandardSchema, validate } from "@kingsleyweb/bun-common";
import { z } from "zod";

export const createPost = validate(
  { body: z.object({ title: z.string().min(3) }) },
  {
    onFailure: "respond",
    status: 422,
    hooks: {
      body: {
        transform: (post) => ({ ...post, slug: post.title.toLowerCase() }),
      },
    },
  },
);

export const Page = toStandardSchema<{ page: number }>((input) => {
  const page = Number((input as { page?: unknown } | undefined)?.page ?? 1);
  return Number.isInteger(page) && page > 0
    ? { value: { page } }
    : { issues: [{ message: "page must be a positive integer", path: ["page"] }] };
});
```

Validators chain: each one replaces `req.query` wholesale, so a later schema
receives the earlier one's output. arktype does not accept a bound after a
morph: `"string.integer.parse >= 1"` is a parse error, so express the range
inside the definition.

Examples:
[`validate-requests.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/06-validation/validate-requests.ts),
[`schema-libraries.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/06-validation/schema-libraries.ts),
tour
[`validate-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/validate-options.ts).

### CORS

`cors(options)` is a native port of the `cors` package, with the same options
and defaults. It is available as `router.use(cors(...))` or
`adapter.enableCors(options, prefix?)`.

| Option | Default | Meaning |
|---|---|---|
| `origin` | `"*"` | `true` reflects the request's origin, and `false` sends no `Allow-Origin`. A string is sent as it is. A RegExp or an array (of strings, RegExps and booleans) reflects the origin when an entry matches. A function `(origin, cb)` decides per request. |
| `methods` | `"GET,HEAD,PUT,PATCH,POST,DELETE"` | `Access-Control-Allow-Methods` on a preflight. |
| `allowedHeaders` | reflects `Access-Control-Request-Headers` | `Access-Control-Allow-Headers` on a preflight. |
| `exposedHeaders` | none | `Access-Control-Expose-Headers`. |
| `credentials` | `false` | Sends `Access-Control-Allow-Credentials: true`. |
| `maxAge` | none | `Access-Control-Max-Age` in seconds. |
| `preflightContinue` | `false` | Pass the preflight on to the next handler. |
| `optionsSuccessStatus` | `204` | Status that ends a preflight. |

`cors((req, cb) => cb(null, options))` chooses options per request. An error
reported by the delegate, or by an `origin` function, goes to `next(err)`.
`Vary: Origin` is always added.

Examples:
[`cors.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/07-cors-and-static/cors.ts),
tour
[`cors-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/cors-options.ts).

### Static files

`adapter.useStaticAssets(root, options)` serves a directory on
`${prefix}/*`. `createServeStaticHandler(root, options)` returns
`{ prefix, handler }`, for registering the handler on any router yourself. The
contract is `serve-static`'s, plus precompressed siblings and on-the-fly
compression.

| Option | Default | Meaning |
|---|---|---|
| `prefix` | `""` | Virtual path prefix. |
| `index` | `"index.html"` | Directory index file(s). `false` disables them. |
| `extensions` | `[]` (none) | Fallback extensions for a path that is not a file or directory, tried in order (`["html", "htm"]`: `/about` tries `/about.html`, then `/about.htm`). A leading dot is optional. |
| `dotfiles` | `"ignore"` | `"ignore"` treats a dotfile as a 404 miss, `"deny"` as a 403 error, and `"allow"` serves it. |
| `fallthrough` | `true` | As `serve-static`. With `true`, a client error (a 404 miss, a 403 denied dotfile or traversal, a 400 malformed path) and any method other than `GET`/`HEAD` call `next()`. With `false`, a client error calls `next(err)` with a `ServeStaticError` (`status`, `statusCode`, `expose: true`), and another method gets `405` with `Allow: GET, HEAD`. |
| `redirect` | `true` | A directory requested without its trailing slash is a 301 to the slashed path, keeping the query string. |
| `etag` | `true` | Weak `ETag` from size and mtime. |
| `lastModified` | `true` | `Last-Modified` header. |
| `maxAge` | `0` | `Cache-Control` max-age, in milliseconds or a string such as `"1d"`. |
| `immutable` | `false` | Adds `immutable` (use with `maxAge`). |
| `setHeaders` | none | `(res, path, stat)`, called synchronously. |
| `metadataCacheTtl` | `1000` | Milliseconds a resolved path's metadata (never its contents) stays cached. `0` stats every request. Misses are cached too. |
| `metadataCacheMax` | `1024` | Maximum cached paths. |
| `precompressed` | `false` | Serve a `.br`, `.zst` or `.gz` sibling when the client accepts that coding, like nginx's `gzip_static`. `true` uses the defaults below. |
| `compression` | `true` | Compress other files on the fly with `compression()`'s rules. An object customises them, and `false` sends files as they are. A range request is never compressed. |

`precompressed` as an object:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether siblings are looked for. |
| `extensions` | `{ br: [".br"], zstd: [".zst"], gzip: [".gz"] }` | Per-coding sibling extensions, merged over the defaults. An empty list turns a coding off. |
| `encodings` | `"*"` | Server preference, used to break ties between equal q-values. |
| `fallback` | `"compress"` | When no sibling fits: `"compress"` compresses on the fly, `"identity"` sends the original. |

A sibling is sent with the original file's `Content-Type`, with
`Vary: Accept-Encoding`, and with its own length and validators. It is only
served when the original file exists. Byte ranges are handled by `Bun.serve`.

```ts
import { BunHttpAdapter } from "@kingsleyweb/bun-common";

const app = new BunHttpAdapter();
app.useStaticAssets(`${import.meta.dir}/public`, {
  prefix: "/static",
  maxAge: "1d",
  immutable: true,
  precompressed: true,
});
```

Examples:
[`serve-static.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/07-cors-and-static/serve-static.ts),
tour
[`static-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/static-options.ts).

### Response compression

`compression(options)` ports the `compression` package (1.8), adding `zstd`
and Compression Dictionary Transport (`dcb`/`dcz`, RFC 9842). Register it
ahead of the routes it covers. It works on anything a route produces: `send`,
`json`, `sendFile`, a static file or a stream.

A response is compressed only when all of these hold:

1. `filter(req, res)` passes. The default, `shouldCompress`, requires a
   compressible `Content-Type`.
2. `Cache-Control` does not contain `no-transform`.
3. `Vary: Accept-Encoding` is added at this point, whether or not the body
   ends up compressed.
4. A body of known size reaches `threshold`. A stream's size is unknown, so a
   stream is always compressed.
5. There is no existing `Content-Encoding`, and the request is not `HEAD`.
6. `Accept-Encoding` negotiation picks a coding. q-values and `*` are
   honoured, the server's order breaks ties, and `identity` can win.

Responses with status 204, 304 or 206, and any request carrying `Range`, are
never compressed. A compressed response loses `Content-Length`.

| Option | Default | Meaning |
|---|---|---|
| `threshold` | `1024` (`"1kb"`) | Smallest body compressed, as bytes or a size string. |
| `filter` | `shouldCompress` | `(req, res) => boolean`. |
| `encodings` | `["br", "zstd", "gzip", "deflate"]` | Offered codings in preference order. A `"*"` entry stands for every supported coding not listed (`["zstd", "*"]`). An unknown or unavailable coding throws. |
| `enforceEncoding` | `"identity"` | Coding used when the request has no `Accept-Encoding`. |
| `level`, `chunkSize`, `memLevel`, `strategy`, `windowBits` | zlib defaults (`-1`, `16384`, `8`, default strategy, `15`) | zlib options for `gzip` and `deflate`. |
| `brotli` | quality 4 | `BrotliOptions`; `params` are merged over the default. |
| `zstd` | level 3 | `ZstdOptions`. |
| `asyncThreshold` | 64 KiB (`DEFAULT_COMPRESSION_ASYNC_THRESHOLD`) | Buffered bodies at least this large are compressed on the thread pool. `0` always uses the pool and `Infinity` never does. |
| `dictionaries` | none | Dictionaries (or a resolver) for `dcb`/`dcz`, matched by the request's `Available-Dictionary`. Advertise one with a `Use-As-Dictionary` header built by `formatUseAsDictionary({ match, matchDest?, id?, type? })`. |
| `dictionaryEncodings` | `["dcz", "dcb"]` | Dictionary codings, ranked ahead of `encodings` on equal q-values. |

A `text/event-stream` response is flushed after every chunk, and `res.flush()`
flushes on demand.

Dictionary transport is verified against a real Chrome (153) in
[`compression.chrome.e2e.test.ts`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/__tests__/compression.chrome.e2e.test.ts):
Chrome stores a response sent with `Use-As-Dictionary`, offers it back with
`Available-Dictionary`, and decodes `dcb` and `dcz` from `compression()` and
from static files compressed on the fly (pass `dictionaries` in the static
handler's `compression` option). Chrome treats `http://localhost` as a secure
context, so no TLS is needed to try it locally; elsewhere it requires HTTPS.
A precompressed sibling (`.br`, `.zst`, `.gz`) is served as it is and never
dictionary-compressed.

```ts
import { BunHttpAdapter, compression } from "@kingsleyweb/bun-common";

const app = new BunHttpAdapter();
app.use(compression({ threshold: "2kb", encodings: ["zstd", "*"] }));
app.get("/report", (_req, res) => res.json({ rows: [] }));
```

Also exported: `isCompressible`, `rankEncodings`, `resolveEncodingOrder`,
`dictionaryCompressionSupported`, `SUPPORTED_COMPRESSION_ENCODINGS`, and
`addResponseTransform` on `BunResponse` for writing transforms of your own.

Examples:
[`compression.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/07-cors-and-static/compression.ts),
tour
[`compression-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/compression-options.ts).

### Multipart uploads

Multer-style upload handling on top of `busboy`. Build the options once with
`transformUploadOptions`, then call a handler inside a route. Each handler
resolves `{ body, file | files, removeFile, removeAll }`. A rejected upload
throws, and whatever was already stored is removed.

| Handler | Accepts (multer equivalent) |
|---|---|
| `handleMultipartSingleFile(req, field, opts)` | at most one file, on `field` (`single`) |
| `handleMultipartMultipleFiles(req, field, maxCount, opts)` | up to `maxCount` files on `field` (`array`) |
| `handleMultipartFileFields(req, uploadFieldsToMap([{ name, maxCount }]), opts)` | files only on the listed fields, where `maxCount` defaults to 1 (`fields`) |
| `handleMultipartAnyFiles(req, opts)` | any file on any field (`any`) |
| `handleNoFiles(req, opts)` | fields only (`none`) |

Text fields land in `body`: bracketed names are nested (`address[city]`) and
repeated names become arrays.

| Upload option | Default | Meaning |
|---|---|---|
| `storageType` | `"memory"` | `"memory"` (`MemoryStorage`), `"disk"` (`DiskStorage`), or `"custom"` with a `storage` implementing `Storage` (`handleFile`, `removeFile`). |
| `dest` (disk) | OS temp directory | A directory, or a `(file, req) => string` function. Created when missing. |
| `filename` (disk) | 32 random hex characters plus the original extension | A string or function. A fixed string overwrites on every upload. |
| `removeAfter` | disk `false`, memory `true` | Whether `removeFile(file)` / `removeAll()` removes files without `force`. |
| `filter` | none | `(req, file)`: `true` keeps the file, `false` drops it, a string rejects the upload with `FILTER_REJECTED`. |
| `limits`, `preservePath`, `defCharset`, ... | busboy defaults | busboy options. `getBusBoyConfig(opts)` extracts them. |
| `inflate` | `true` | Parse field values as JSON or urlencoded. `false` keeps the raw strings. |
| `fieldInflator`, `fileInflator`, `isPartAFile` | none | Custom inflation, and custom file-versus-field detection. |

Every stored file carries `fieldname`, `originalFilename`, `mimetype`,
`encoding`, `size` and `validatedMimeType` (sniffed from the bytes by
`file-type`). A disk file adds `path`, `dest` and `filename`; a memory file
adds `buffer`.

```ts
import {
  BunHttpAdapter,
  handleMultipartSingleFile,
  transformUploadOptions,
  UploadError,
} from "@kingsleyweb/bun-common";

const app = new BunHttpAdapter();
const avatars = transformUploadOptions({
  storageType: "disk",
  dest: "/tmp/avatars",
  limits: { fileSize: 2 * 1024 * 1024 },
  filter: (_req, file) => file.mimetype.startsWith("image/") || "images only",
});

app.post("/avatar", async (req, res) => {
  try {
    const { body, file } = await handleMultipartSingleFile(req, "avatar", avatars);
    res.json({ body, path: file?.path });
  } catch (error) {
    if (error instanceof UploadError) {
      res.status(error.status).json({ code: error.code, field: error.field });
    } else {
      throw error;
    }
  }
});
```

`UploadError` has `code`, `field`, `status` / `statusCode` and
`expose: true`. The codes:

| Code | Status | Cause |
|---|---|---|
| `LIMIT_PART_COUNT` | 413 | busboy `limits.parts` exceeded |
| `LIMIT_FILE_SIZE` | 413 | a file exceeded `limits.fileSize` |
| `LIMIT_FILE_COUNT` | 413 | `limits.files` exceeded |
| `LIMIT_FIELD_KEY` | 413 | a field name exceeded `limits.fieldNameSize` |
| `LIMIT_FIELD_VALUE` | 413 | a field value exceeded `limits.fieldSize` |
| `LIMIT_FIELD_COUNT` | 413 | `limits.fields` exceeded |
| `LIMIT_UNEXPECTED_FILE` | 400 | a file on a field the handler does not accept, or more files than `maxCount` |
| `MISSING_FIELD_NAME` | 400 | a part without a field name |
| `FILTER_REJECTED` | 400 | the `filter` answered a string |

`UPLOAD_ERROR_MESSAGES`, `DEFAULT_UPLOAD_OPTIONS`, `removeStorageFiles` and
`filterUpload` are exported too.

Examples:
[`single-and-multiple.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/08-multipart/single-and-multiple.ts),
[`storage.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/08-multipart/storage.ts),
[`limits-and-filters.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/08-multipart/limits-and-filters.ts),
tour
[`multipart-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/multipart-options.ts).

### WebSockets

`adapter.ws(path, handler, options?)` registers an upgrade route on the
adapter's built-in `BunWebSocket`. `handler` is Bun's `WebSocketHandler`
(`open`, `message`, `close`, `drain`, `ping`, `pong`). The upgrade route is an
ordinary route, so middleware registered ahead of it runs first;
authentication belongs there.

`options` is a `WebSocketRouteOptions`; its one field today is `onUpgrade`.
`onUpgrade(req, res)` (a `WebSocketUpgradeHook`) runs once per upgrade and may
be async. It returns a `WebSocketUpgradeResult`, or nothing:

| Field | Effect |
|---|---|
| `custom` | becomes `ws.data.custom` |
| `headers` | any `HeadersInit`, sent on the `101 Switching Protocols` |
| `data` | replaces `ws.data` entirely; `route`, `params` and `port` it leaves `undefined` are filled in from the match, since dispatch needs them |

A route's hook replaces the instance-wide `onUpgrade` option for that route.
The adapter's type argument types `custom`, `new BunHttpAdapter<MyData>()`,
and on a bare router it is inferred from the hook's `custom`.

```ts
import { BunHttpAdapter } from "@kingsleyweb/bun-common";

const app = new BunHttpAdapter<{ room: string }>();

app.ws(
  "/chat/:room",
  {
    open(ws) {
      ws.subscribe(ws.data.custom.room);
    },
    message(ws, message) {
      app.server?.publish(ws.data.custom.room, String(message)); // every subscriber
    },
  },
  {
    onUpgrade: (req) => ({
      custom: { room: String(req.params.room ?? "lobby") },
    }),
  },
);

app.webSocketAdapter.on("close", (ws, code) => {
  console.log("left", ws.data.path, code);
});

await app.listen(0);
```

`ws.publish(topic, data)` reaches every subscriber *except* `ws` (unless
`wsOptions.publishToSelf` is set), while `server.publish` reaches all of them.

`ws.data` (`WebSocketClientData`):

| Field | Meaning |
|---|---|
| `host`, `path`, `search`, `hash`, `originalUrl`, `headers` | the upgrade request |
| `user` | `req.user` at upgrade time, when middleware set one |
| `custom` | the hook's `custom`, else `webSocketUpgradeData.custom` (see below), else `undefined` |
| `route`, `params` | the matched route pattern and a copy of its params |
| `port` | the real bound port of the server that accepted the upgrade (never `0`). Absent only without a socket. |

`BunWebSocket` options:

| Option | Default | Meaning |
|---|---|---|
| `wsOptions` | `perMessageDeflate: true`, `idleTimeout: 30`, `maxPayloadLength: 1 MB` | Bun `WebSocketHandler` settings, merged over these defaults. They are **not** Bun's defaults: Bun uses `false`, `120` and 16 MB. |
| `newInstance` | `false` on the adapter | `false` rides on the server from `getServer()`. `true` binds a dedicated `Bun.serve` on `listen: { host?, port }` that serves the router's HTTP routes as well. |
| `router` | a private empty router | The router upgrade routes register on. |
| `onUpgrade` | none | Instance-wide `WebSocketUpgradeHook`, for routes registered without one. |
| `customDataToWsClientFn` | none | **Deprecated.** Treated as `onUpgrade: async (req, res) => ({ custom: await fn(req, res) })`. Given beside `onUpgrade`, it is ignored and a warning is logged once. |
| `responseTimeout`, `serverOptions`, `bunRequestOpts` | `0`, none, none | Dedicated server only: HTTP response timeout, base `Bun.serve` options, request parsing. |

The instance emits `connect`, `open`, `message`, `disconnect`, `close`,
`ping`, `pong` and `drain`. `port`, `getServer()` and `setRouteHandler()` are
also available. A bare `BunRouter.ws()` needs a `BunWebSocket` attached
through the `bunWebsocket` option or `setBunWebSocket()`.

Lifecycle dispatch is resolved per event, not frozen at `listen()`. Attaching
another `BunWebSocket` to the same router — `setBunWebSocket()`, or simply
constructing one with `router:`, which calls it — takes over `open`, `message`,
`close` and the rest even on a server that is already listening, and the
instance it replaced stops receiving them: last one wins. That is what lets
bun-nest's `useWebSocketAdapter()` install an adapter after the server has
started. The `wsOptions` settings are *not* late-bound — Bun reads
`idleTimeout`, `maxPayloadLength` and `perMessageDeflate` once, when the server
binds — so a swap changes dispatch, not the socket settings.

#### Headers on the 101

Any route can upgrade by itself with `res.upgradeToWebsocket(data?, options?)`:
`data` becomes `ws.data` (built from the request when omitted), and the
socket's events go to the instance's emitter. `options.headers`
(`UpgradeToWebsocketOptions`, any `HeadersInit`) are sent on the
`101 Switching Protocols` response. That is how a server chooses a subprotocol:
Bun otherwise echoes the *first* protocol the client offered, so a client
offering `["other", "chat.v1"]` would negotiate `"other"`.

```ts
app.get("/live", (req, res) => {
  const offered = (req.get("sec-websocket-protocol") ?? "").split(/\s*,\s*/);
  if (!offered.includes("chat.v1")) {
    return res.status(426).send("chat.v1 required");
  }
  return res.upgradeToWebsocket(undefined, {
    headers: { "Sec-WebSocket-Protocol": "chat.v1" },
  });
});
// client: new WebSocket(url, ["other", "chat.v1"]).protocol === "chat.v1"
```

A `ws()` route does the same from its hook:

```ts
app.ws("/live", handler, {
  onUpgrade: () => ({ headers: { "Sec-WebSocket-Protocol": "chat.v1" } }),
});
```

Headers and data can also be set further out, and every upgrade layers them:

| Layer | Headers | Data |
|---|---|---|
| router-wide: `router.webSocketUpgradeHeaders` / `webSocketUpgradeData` (or `setWebSocketUpgradeHeaders()` / `setWebSocketUpgradeData()`, chainable) | lowest | merged over the data built from the request |
| per request: `res.webSocketUpgradeHeaders` / `res.webSocketUpgradeData`, set by middleware before the upgrading route | over the router's | over the router's |
| the route's `onUpgrade` result, or `upgradeToWebsocket`'s arguments | highest | see below |

```ts
app.setWebSocketUpgradeHeaders({ "X-Trace": "on" });
app.use("/live", (req, res, next) => {
  res.webSocketUpgradeData = { custom: { tenant: req.get("x-tenant") } };
  next();
});
```

- **Headers merge by name.** A later layer replaces every value of a name it
  gives and keeps the names it does not mention. The setters take any
  `HeadersInit` and the getters return a `Headers` (or `undefined`).
- **Data merges shallowly**, later winning per key. On a `ws()` route the
  hook's `custom` then wins over both layers, and `route`, `params` and `port`
  always come from the match. A hook's `data` replaces the lot, filled in as
  described above.
- **Explicit `data` is used as is.** `res.upgradeToWebsocket(data)` gets
  exactly `data` — no router or response data is merged into it, at any depth.
  The layers apply only to data that is *built*: `upgradeToWebsocket()` with
  no data, and a `ws()` route.
- **Headers are inherited either way.** `upgradeToWebsocket(data, { headers })`
  still carries the router's and the response's headers, and a header it
  passes wins per name. Pass `inherit: false` to send only the call's own
  arguments, as before these layers existed.
- **Whose router.** A `ws()` route takes the defaults of the router `ws()` was
  called on. That route is registered on the attached `BunWebSocket`'s router,
  at the path `ws()` was given, and not under a `use()` mount — so on a
  sub-router it is still the sub-router's defaults that apply. A bare
  `upgradeToWebsocket()` takes those of the router running the request (the
  outermost one; `res.webSocketUpgradeDefaults` names it). Mounting flattens a
  sub-router into its parent, so a route mounted from a sub-router runs under
  the parent's defaults. On an adapter whose `setInstance()` replaced its
  router, the adapter's getters and setters reach that router.
- Headers set on `res` with `setHeader`/`set`/`cookie` never reach the 101. With
  no layer set and no `options.headers`, an upgrade sends exactly what Bun
  sends by default.
- Supply a protocol the client offered: a browser fails the connection when the
  server answers with one it did not. That includes a router-wide
  `Sec-WebSocket-Protocol`, which also reaches clients that offered none.
- Each call recomputes the headers, so an earlier call's `options.headers`
  never carry over, and an empty set counts as none. `res.upgradeToWsHeaders`
  shows what will be sent.
- Every server that performs an upgrade passes them on: `BunHttpAdapter`,
  a dedicated `BunWebSocket` server (`newInstance: true`), and bun-nest's
  adapter.

A **function** as the third argument of `ws()` or `setRouteHandler()` is the
deprecated `customDataToWsClientFn` mapping, and nothing else: whatever it
returns becomes `ws.data.custom`, whatever its shape — even
`{ data: "x", custom: 1 }` is stored as `custom` as is. It still works, and
`TCustom` is still inferred from its return value; move to
`{ onUpgrade: (req) => ({ custom: … }) }`.

Examples:
[`echo-and-events.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/09-websocket/echo-and-events.ts),
[`rooms-and-broadcast.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/09-websocket/rooms-and-broadcast.ts),
[`options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/09-websocket/options.ts),
tour
[`websocket-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/websocket-options.ts).

### Structured logging

`Logger` is structured, not console-shaped:

- six levels, `trace`, `debug`, `info`, `warn`, `error` and `fatal` (`LOG_LEVELS`),
  each called as `(message: string | Error, fields?)`;
- `log`, an alias of `info`;
- `child(bindings, { name?, level? })` and `isLevelEnabled(level)`.

An `Error` passed as the message, or as `fields.error`, is lifted onto
`LogEvent.error`. Call sites use `logger.error("message", { error })`.

`createLogger(options)`:

| Option | Default | Meaning |
|---|---|---|
| `level` | `"info"` | Threshold; `"silent"` drops everything. |
| `name` | none | Shown by sinks and inherited by children. |
| `bindings` | `{}` | Fields included on every record. |
| `sink` | `consoleSink()` | Where records go. |
| `enabled` | none | Extra `(level) => boolean` predicate. |
| `time` | `Date.now` | Clock. |

Sinks:

- `consoleSink({ console?, format: "pretty" | "json" })`, where `pretty` is
  the default;
- `multiSink(...sinks)`;
- `collectSink(events)`;
- any `(event) => void` function.

`noopLogger` drops everything. `createTestLogger()` returns
`{ logger, events }` for assertions.

**Bring your own logger.** Every `logger` option accepts a `LoggerLike`: a
`Logger`, a bare sink function, or a pino, bunyan, winston, consola, log4js,
tslog, NestJS or console-like logger. `resolveLogger(input, fallback?)`
detects the shape in that order and wraps it. Name the adapter to skip
detection: `fromPino`, `fromBunyan`, `fromWinston`, `fromConsola`,
`fromLog4js`, `fromTslog`, `fromNestLogger` or `fromConsole`. Each takes
`{ level, name, bindings }`. The adapters are structural, so nothing imports
those libraries. They default to `level: "trace"`, which leaves the wrapped
library in charge of its own threshold.

```ts
import { BunHttpAdapter, createLogger } from "@kingsleyweb/bun-common";
import pino from "pino";

const logger = createLogger({ level: "debug", name: "api" });
logger.child({ requestId: "r-1" }).info("handled", { status: 200 });

const app = new BunHttpAdapter(0, { logger: pino() }); // adapted automatically
await app.listen(0);
```

Examples:
[`structured-logger.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/10-logging/structured-logger.ts),
[`sinks.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/10-logging/sinks.ts),
[`adapters.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/10-logging/adapters.ts),
tour
[`logging-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/logging-options.ts).

### Native utilities

Dependency-free helpers from `lib/utils/native.ts`. They replace lodash-es,
`cookie`, `etag`, `fresh`, `range-parser`, `get-port` and similar packages,
and are all exported from the package root.

| Group | Helpers |
|---|---|
| Type guards | `isArray`, `isString`, `isNumber`, `isNumeric`, `isBoolean`, `isFunction`, `isObject`, `isError`, `isNull`, `isUndefined`, `isMap`, `isBuffer`, `isArrayBufferView`, `isAnyArrayBuffer`, `isBinaryBody`, `isAsyncIterable`, `isAsyncGeneratorFunction` |
| Objects and collections | `get`, `set`, `unset`, `merge`, `cloneDeep`, `pick`, `omit`, `orderBy`, `each`, `keys`, `values`, `first`, `flattenDeep`, `lastIndexOf` (typed paths: `PropertyPath`, `PathValue`) |
| Strings, numbers, dates | `encodeUrl`, `ucwords`, `parseByteSize`, `isDateValid`, `toHttpDate` |
| HTTP | `etag`, `fresh`, `rangeParser`, `combineRanges`, `appendVary`, `decompressBody` |
| Cookies | `parseCookie`, `serializeCookie`, `signCookie`, `unsignCookie`, `jsonCookies`, `extractSignedCookies` |
| Async control | `sleep`, `withTimeout` / `TimeoutError`, `waitUntil`, `createDeferred`, `retry`, `computeBackoff`, `Mutex`, `Semaphore`, `isAbortError`, `getPort` |
| Errors and JSON | `serializeError`, `deserializeError`, `jsonClone`, `JsonValue` / `Jsonify` types |
| XML | `parseXmlToObject`, `decodeXmlEntities`, `coerceXmlPrimitive`, `isXmlWhitespace` |
| Files and streams | `randomBytes`, `getUniqueFilename`, `pathExists`, `streamToBuffer`, `pump`, `isMime`, `getMimeFromStr` |
| Compatibility objects | `cookie` (`parse`, `serialize`), `cookieSignature` (`sign`, `unsign`), `cookieParser` (`JSONCookies`, `signedCookies`), `vary`, `eTag`, `accepts`, `typeIs`, `mime` |

`getPort()` locks each port it hands out for about a second, so two callers
cannot receive the same one.

Examples:
[`objects-and-collections.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/11-utilities/objects-and-collections.ts),
[`http-helpers.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/11-utilities/http-helpers.ts),
[`async-control.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/11-utilities/async-control.ts),
[`errors-xml-files.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/11-utilities/errors-xml-files.ts),
tour
[`native-utilities.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/native-utilities.ts).

The full export list is in [`lib/index.ts`](lib/index.ts).

## Examples

### Example projects

| Project | What it covers |
|---|---|
| [`examples/bun-common`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-common) | 47 examples of this package: routing, the HTTP adapter, requests and responses, validation, CORS, static files, compression, multipart uploads, WebSockets, logging and utilities, including 12 option tours |
| [`examples/bun-nest`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-nest) | NestJS on Bun: the HTTP adapter, file upload interceptors and the WebSocket adapter, plus option tours |
| [`examples/bun-jobs`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs) | Background work: queues, workers, the job registry, scheduling, flow control, failures, the runner, every driver and integrations, plus option tours |

### bun-common examples

Each file is a standalone script whose opening comment says what it shows.

| Folder | File | Shows |
|---|---|---|
| `01-quick-start` | [`index.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/01-quick-start/index.ts) | A small JSON API with routes, a JSON body, params, error and not-found handlers, served on port 0 |
| `02-routing` | [`verbs-and-params.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/02-routing/verbs-and-params.ts) | Every verb method, `all`/`any`/`add`/`addRoute`, param forms, route ordering and `setRouteSpecificity` |
| `02-routing` | [`middleware-and-errors.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/02-routing/middleware-and-errors.ts) | The Express 5 pipeline: prefix `use()`, `useMethod`, error mode, recovery, `next('route')`, `next('router')` |
| `02-routing` | [`sub-routers.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/02-routing/sub-routers.ts) | Mounting routers, typed mount params, a validator at the mount, `group`, `domain` |
| `02-routing` | [`typed-routes.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/02-routing/typed-routes.ts) | `req.params`/`query`/`body` inferred from the path and a validator |
| `02-routing` | [`fetch-testing.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/02-routing/fetch-testing.ts) | Every `fetch()` input form, router versus adapter `fetch`, parity with a served request |
| `02-routing` | [`route-cache.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/02-routing/route-cache.ts) | The route cache and `routeCacheMax`, named routes, `RouteClass`, `toNativeRequest` |
| `03-http-adapter` | [`listen-and-close.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/03-http-adapter/listen-and-close.ts) | Every `listen()` overload, address getters, events, `setListenOptions`, `close()` |
| `03-http-adapter` | [`adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/03-http-adapter/adapter-options.ts) | Every constructor option |
| `03-http-adapter` | [`handlers.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/03-http-adapter/handlers.ts) | Not-found and error handlers, `enableCors`, `useStaticAssets`, body parsers, `setTimeout` |
| `04-request` | [`reading-a-request.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/04-request/reading-a-request.ts) | Every request property, query options, freshness, ranges, content negotiation |
| `04-request` | [`body-parsing.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/04-request/body-parsing.ts) | Every body-parsing option, size limits, compressed and stacked bodies, raw bodies |
| `04-request` | [`cookies.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/04-request/cookies.ts) | Parsing cookies, signed cookies and secrets, JSON cookies |
| `05-response` | [`sending.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/05-response/sending.ts) | Status, every `send` body type, `json`/`jsonp`, headers, ETags, `format()`, attachments |
| `05-response` | [`files-and-streams.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/05-response/files-and-streams.ts) | `sendFile` with every option and byte ranges, streaming, server-sent events, redirects |
| `05-response` | [`cookies-and-caching.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/05-response/cookies-and-caching.ts) | `cookie()`/`clearCookie()` with every option, signed cookies, cache headers, 304s |
| `06-validation` | [`validate-requests.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/06-validation/validate-requests.ts) | Every target and failure mode, hooks, chained validators, `ValidationError` |
| `06-validation` | [`schema-libraries.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/06-validation/schema-libraries.ts) | The same schema in zod, yup, valibot and arktype, and superstruct through `toStandardSchema` |
| `06-validation` | [`typed-handlers.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/06-validation/typed-handlers.ts) | Handler types from the validator, `InferValidatedShape`, typed mounts |
| `07-cors-and-static` | [`cors.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/07-cors-and-static/cors.ts) | Every `CorsOptions` field, preflight versus simple requests, a delegate |
| `07-cors-and-static` | [`serve-static.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/07-cors-and-static/serve-static.ts) | `createServeStaticHandler` with every option, precompressed siblings, on-the-fly compression, ranges |
| `07-cors-and-static` | [`compression.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/07-cors-and-static/compression.ts) | `compression()` negotiation, options, SSE through the compressor, `dcb`/`dcz` dictionaries |
| `08-multipart` | [`single-and-multiple.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/08-multipart/single-and-multiple.ts) | The single, multiple, fields, any and no-files handlers; nested and repeated fields |
| `08-multipart` | [`storage.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/08-multipart/storage.ts) | Memory storage, disk storage with every option, a custom `Storage` |
| `08-multipart` | [`limits-and-filters.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/08-multipart/limits-and-filters.ts) | Upload defaults, filters, size and count limits, 413s, `UploadError` codes |
| `09-websocket` | [`echo-and-events.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/09-websocket/echo-and-events.ts) | Upgrading through the adapter, every event, client data, ping/pong, backpressure, close codes |
| `09-websocket` | [`rooms-and-broadcast.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/09-websocket/rooms-and-broadcast.ts) | Auth on upgrade, rooms as pub/sub topics, `ws.publish` versus `server.publish` |
| `09-websocket` | [`options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/09-websocket/options.ts) | Every WebSocket option, a standalone server, an extra port |
| `10-logging` | [`structured-logger.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/10-logging/structured-logger.ts) | `createLogger` options, the six levels, `child`, errors lifted onto the record |
| `10-logging` | [`sinks.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/10-logging/sinks.ts) | `consoleSink` pretty and JSON, `multiSink`, `collectSink`, custom sinks, test loggers |
| `10-logging` | [`adapters.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/10-logging/adapters.ts) | pino, bunyan, winston, consola, log4js, tslog, NestJS and console adapters; `resolveLogger` |
| `11-utilities` | [`objects-and-collections.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/11-utilities/objects-and-collections.ts) | Type guards, `get`/`set`/`merge`/`pick`/`omit`/`orderBy`, `cloneDeep` versus `jsonClone` |
| `11-utilities` | [`http-helpers.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/11-utilities/http-helpers.ts) | `etag`, `fresh`, ranges, `vary`, dates and byte sizes, cookie helpers, `accepts`, `typeIs`, `mime` |
| `11-utilities` | [`async-control.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/11-utilities/async-control.ts) | `sleep`, `withTimeout`, `waitUntil`, `retry`, `computeBackoff`, `Mutex`, `Semaphore`, `getPort` |
| `11-utilities` | [`errors-xml-files.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/11-utilities/errors-xml-files.ts) | Serialising errors, parsing XML, random bytes, unique filenames, streams to buffers |
| `12-options` | [`router-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/router-options.ts) | Tour: every `BunRouter` option and public method |
| `12-options` | [`http-adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/http-adapter-options.ts) | Tour: every `BunHttpAdapter` option and public method |
| `12-options` | [`request-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/request-options.ts) | Tour: every request property, body-parsing and query option |
| `12-options` | [`response-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/response-options.ts) | Tour: every response method and option |
| `12-options` | [`validate-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/validate-options.ts) | Tour: every validation option, execution order, `toStandardSchema` |
| `12-options` | [`cors-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/cors-options.ts) | Tour: every CORS field and value form, delegates, `enableCors` |
| `12-options` | [`static-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/static-options.ts) | Tour: every static-file option, caching, traversal, ranges, compression |
| `12-options` | [`compression-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/compression-options.ts) | Tour: every `compression()` option, wildcards, dictionaries, `res.flush()` |
| `12-options` | [`multipart-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/multipart-options.ts) | Tour: every upload option, `UploadError` codes and statuses, storage options |
| `12-options` | [`websocket-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/websocket-options.ts) | Tour: every WebSocket option, event and emitter method |
| `12-options` | [`logging-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/logging-options.ts) | Tour: every logger option, sink and adapter mapping |
| `12-options` | [`native-utilities.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/12-options/native-utilities.ts) | Tour: every exported helper, with options and edge cases |

The option tours in `12-options` do not just *show* behaviour, they
**assert** it through
[`shared/check.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/shared/check.ts),
so `bun run-all.ts 12` tests every option.

### Running the examples

From a clone of the repository:

```bash
bun install
cd examples/bun-common
bun 01-quick-start/index.ts   # one example
bun run-all.ts                # every example; prints ok / skip / FAIL
bun run-all.ts 02 12          # only folders 02-* and 12-*
```

The examples import the workspace package by name, and servers always listen
on port `0`. See the
[examples README](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-common/README.md)
for details.

## Related packages

- [`@kingsleyweb/bun-nest`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-nest/README.md):
  a NestJS HTTP adapter, WebSocket adapter and file interceptors built on this
  package.
- [`@kingsleyweb/bun-jobs`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-jobs/README.md):
  background jobs, queues and scheduled runners for Bun, over memory, file,
  Redis and SQL drivers.

## Development

The package lives in the [`bun-node`](https://github.com/kingsloob1/bun-node)
monorepo.

```bash
bun scripts/typecheck.ts        # from the repo root: every project
cd packages/bun-common
bunx eslint .                   # lint the whole package
bun test                        # tests
```

One suite drives a real browser and is opt-in, so the default `bun test`
stays fast and machine-independent: it skips (visibly) unless
`BUN_COMMON_E2E_CHROME=1` is set and Chrome is found. It speaks the Chrome
DevTools Protocol over Bun's own WebSocket, so it needs no extra dependency.
Set `BUN_COMMON_E2E_CHROME_BIN` when the browser is not on `PATH` as
`google-chrome`, `google-chrome-stable`, `chromium` or `chromium-browser`.

```bash
BUN_COMMON_E2E_CHROME=1 bun test __tests__/compression.chrome.e2e.test.ts
```

The typed verb overloads in `BunRouter.ts` and both adapters sit between
`BEGIN generated typed overloads` markers. They are generated, so don't edit
them by hand; regenerate them with
[`scripts/generate-verb-overloads.ts`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/scripts/generate-verb-overloads.ts):

```bash
bun scripts/generate-verb-overloads.ts          # rewrite both packages
bun scripts/generate-verb-overloads.ts --check  # fail when stale (CI)
```

After changing this package, also run the checks for bun-nest and bun-jobs,
which depend on it.

## License

MIT
