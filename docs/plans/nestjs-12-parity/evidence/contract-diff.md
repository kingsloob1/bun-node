# The HTTP adapter contract, 11.1.27 → 12.1.3

Read **[V]** in the `nestjs/nest` repository at the tags `v11.1.27` and
`v12.1.3` (`git diff v11.1.27 v12.1.3 -- packages/core/adapters/http-adapter.ts
packages/common/interfaces/http/http-server.interface.ts`), and **[S]** in
bun-nest at `73bf4a00`.

## What changed in `AbstractHttpAdapter`

Comments stripped, the code diff is small:

- **The same 24 abstract members** in both (`grep -c abstract`). Nothing new
  is abstract, so no subclass stops compiling.
- **New concrete members** (12.0.0 unless noted):

  | Member | Default in `AbstractHttpAdapter` | Called by the core? |
  |---|---|---|
  | `query(...)` (11.2.0, #17162) | `this.instance.query(...args)` | yes, for `@QueryMethod()` routes, through `RouterMethodFactory` (`REQUEST_METHOD_MAP[RequestMethod.QUERY] = 'query'`); falls back to `use` only when the member is absent, and here it is always present |
  | `beforeClose()` | no-op | yes: `NestApplication.prepareClose()` awaits it before any shutdown hook |
  | `mapException(error)` | returns `error` | yes: the exception layer the core installs through `setErrorHandler` maps every error through it first (#15075, `07603b53f`); 11's core did the `SyntaxError`/`URIError` → `BadRequestException` mapping itself |
  | `registerSecurityHook(hook)` (12.1.0, #17836) | `this.use((req, res, next) => { const e = hook(req, res); e ? next(e) : next(); })` | yes, once, the first time `app.enableCsrfProtection()` or `app.useSecurityHeaders()` is called |
  | `setCookie(res, name, value, options)`, `clearCookie(res, name, options)`, `setCookieSigner(signer)` (12.1.0, #17834) | `this.appendHeader(res, 'Set-Cookie', serializeCookie(...))`; `signed` uses the signer built from the `cookies.secret` application option | not by the core; by users and Nest's own cookie helpers |
- **Changed signature:** `setNotFoundHandler(handler, prefix?, excludedRoutes?: RouteInfo[])`
  (the third parameter is new, passed by the core from 12.1.3, #17923).
- **Imports moved** to `@nestjs/common/internal` (`RouteInfo`,
  `SecurityRequestHook`, `VersionValue`): a 12-only entry point.

## What changed in `HttpServer` (the interface)

Every member gained documentation of when the core calls it; the behavioural
requirements that matter to a third-party adapter, quoted in substance:

- `isRouteOrderSensitive?(): boolean` (new, optional, **not** on
  `AbstractHttpAdapter`): "Defaults to `true` when not implemented. When
  `true` and the `specificity` route resolution strategy is enabled, the core
  sorts routes before registering them. A `false` value is currently also
  taken to mean that the router rejects duplicate `(method, path)`
  registrations itself."
- `listen`: "the `app.listen()` promise only resolves if
  `getHttpServer().address()` returns a non-null value when the callback
  runs"; the callback receives an `Error` when binding failed.
- `getRequestHostname`, `getRequestMethod`, `getRequestUrl`: "treat them as
  required"; `getRequestUrl` must be the original URL (`req.originalUrl`).
- `isHeadersSent`: must return a boolean synchronously.
- `initHttpServer`: the adapter honours `httpsOptions`,
  `forceCloseConnections` and `return503OnClosing`.
- `close`: awaited, after `OnModuleDestroy`/`BeforeApplicationShutdown` and
  the gateways; `beforeClose` before every hook.
- `createMiddlewareFactory`: the core passes `/` for root paths, and for a
  method other than `ALL` already wraps the callback to skip other methods
  (treating `HEAD` as `GET`).
- `normalizePath?`: "should throw when the path is invalid so misconfigured
  routes fail at startup. When not implemented the path is used verbatim."
- SSE: the core writes to `res.raw`/`req.raw` when present, else the objects
  themselves, as Node `ServerResponse`/`IncomingMessage`, and watches
  `request.socket` for disconnects.
- `getType()`: ecosystem packages (`@nestjs/swagger`, `@nestjs/serve-static`)
  branch on it.

## Against bun-nest

| Member | Nest 12 expects | Ours (`packages/bun-nest/lib/BunHttpAdapter.ts`) | Gap |
|---|---|---|---|
| `query` | a `QUERY` route | inherited default calls `instance.query`, which `BunRouter` lacks; `getRequestMethodStr` `:3264-3359` has no `QUERY` | **boot failure** with any `@QueryMethod()` [M] |
| `mapException` | `SyntaxError`/`URIError` → 400 (Express `express-adapter.ts` v12.1.3 `mapException`) | not overridden | invalid JSON body shape; undecodable param **500** [M] |
| `setNotFoundHandler(h, prefix, excludedRoutes)` | Express scopes to prefix, mounts on each excluded path, skips other apps' prefixes | `:1302-1307` ignores both | unknown paths outside the prefix answer Nest's JSON 404, Express's HTML [M] |
| `setErrorHandler(h, prefix)` | Express mounts at the prefix and at the root | `:1295-1300`, global | equivalent in effect |
| `beforeClose` | flip to shutting down; `return503OnClosing` answers 503 | absent | gap |
| `close` | Express 12 drains in-flight requests (`server.close`), destroys sockets only with `forceCloseConnections` | `:1399-1418` always `stop(true)` | in-flight requests are cut |
| `registerSecurityHook` | run before body parsing and Nest middleware, for every request; rejections to the exception layer | inherited `use()` default | see §6 of the plan (ordering, headers on the error response) |
| `setCookie`/`clearCookie` | through `appendHeader` | `appendHeader` `:839-846` | parity [M] (§6) |
| `isRouteOrderSensitive` | Express returns `true` | absent (core assumes `true`) | declare it; `false` would be wrong (it also means "rejects duplicates") |
| `normalizePath` | Express converts legacy syntax and validates with `path-to-regexp` | absent: paths go through verbatim | no legacy conversion, no startup validation [M] (§5) |
| `getRequestHostname` | Express's `req.hostname` (Host's case kept) | `:1334-1336`, `URL.hostname` (lower-cased) | `@HostParam` case [M] |
| `createMiddlewareFactory` | Express 12 strips the `$` the core appends for an exact `*` on the bare prefix (#17942) | `:3361-3378` passes it through | `forRoutes('*')` skips `GET /api` [M] |
| `applyVersionFilter` MEDIA_TYPE | Express 12 reads the version from any `Accept` parameter (`getMediaTypeVersion`, `697ff89e0`) | `:3450-3495`, first parameter only | gap |
| `reply(res, body, status)` | Express 12 applies any `statusCode !== undefined`, destroys a `StreamableFile` source on disconnect (#17973) | `:1198-1239`, `if (statusCode)`; no destroy before the body is consumed | gaps |
| `setOnRequestHook`/`setOnResponseHook` (Express only, instrumentation) | Express implements | absent | gap for `@nestjs/observe` (§6) |
