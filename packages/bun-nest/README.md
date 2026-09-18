# `@kingsleyweb/bun-nest`

Run NestJS applications on `Bun.serve`. Pass `new BunHttpAdapter()` to
`NestFactory.create` and the rest of the application stays plain NestJS:
modules, controllers, guards, pipes, interceptors, exception filters,
versioning, CORS, static files, file uploads and WebSocket gateways.

Underneath, routing is
[`@kingsleyweb/bun-common`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/README.md)'s
`BunRouter` (Express 5 semantics). Every request is a `BunRequest` /
`BunResponse` pair, which is what `@Req()` and `@Res()` hand you.

| Instead of | Use |
|---|---|
| `@nestjs/platform-express`'s `ExpressAdapter` | [`BunHttpAdapter`](#bunhttpadapter) |
| `@nestjs/platform-express`'s `FileInterceptor`, `FilesInterceptor`, … | [the file upload interceptors](#file-upload-interceptors) exported here |
| `@nestjs/platform-socket.io`'s `IoAdapter` (or `@nestjs/platform-ws`) | [`BunWebSocketAdapter`](#bunwebsocketadapter), over Bun's native WebSockets |

**Requirements**

- **Bun ≥ 1.4.2** (`engines.bun`). The package ships TypeScript source
  (`main`/`types` point at `lib/index.ts`), so there is no build step. Bun runs
  it as is.
- **NestJS 11**: the peers `@nestjs/common` and `@nestjs/core` (`^11.0.0`) and
  `rxjs` (`^7.1.0`) are required; `@nestjs/websockets` (`^11.0.0`) is needed
  only for gateways.
- The usual NestJS compiler options: `experimentalDecorators` and
  `emitDecoratorMetadata`, with `reflect-metadata` loaded.

## Table of contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [`BunHttpAdapter`](#bunhttpadapter)
  - [Adapter options](#adapter-options)
  - [Adapter methods and properties](#adapter-methods-and-properties)
  - [Routing and typed routes](#routing-and-typed-routes)
    - [Mounting a bun-common router](#mounting-a-bun-common-router)
  - [Nest middleware](#nest-middleware)
  - [Responses: `@Redirect`, `StreamableFile`, `@Render`](#responses-redirect-streamablefile-render)
  - [Versioning](#versioning)
  - [CORS](#cors)
  - [Static assets](#static-assets)
  - [Body parsing and raw bodies](#body-parsing-and-raw-bodies)
  - [Response compression](#response-compression)
  - [Error handling](#error-handling)
  - [Testing with `fetch()`](#testing-with-fetch)
  - [`listen()` and `close()`](#listen-and-close)
  - [Known differences from `@nestjs/platform-express`](#known-differences-from-nestjsplatform-express)
- [File upload interceptors](#file-upload-interceptors)
  - [Interceptors](#interceptors)
  - [Upload options and storages](#upload-options-and-storages)
  - [Limits and where multipart is parsed](#limits-and-where-multipart-is-parsed)
  - [Upload errors](#upload-errors)
- [`BunWebSocketAdapter`](#bunwebsocketadapter)
  - [Gateways](#gateways)
  - [Namespaces and paths](#namespaces-and-paths)
  - [Gateway ports](#gateway-ports)
  - [Wire format](#wire-format)
  - [Replies: `WsResponse`, Promises and Observables](#replies-wsresponse-promises-and-observables)
  - [Acknowledgements](#acknowledgements)
  - [Exceptions](#exceptions)
  - [The `websocket` option](#the-websocket-option)
    - [Headers and data on the 101](#headers-and-data-on-the-101)
  - [Authentication on upgrade](#authentication-on-upgrade)
  - [Standalone and custom adapters](#standalone-and-custom-adapters)
  - [Closing](#closing)
- [The jobs API module](#the-jobs-api-module)
  - [Mounting, injection and shutdown](#mounting-injection-and-shutdown)
  - [Sharing the server with gateways](#sharing-the-server-with-gateways)
  - [Installing bun-jobs is what makes the subpath compile](#installing-bun-jobs-is-what-makes-the-subpath-compile)
- [Exported API](#exported-api)
- [Examples](#examples)
- [Related packages](#related-packages)
- [Development](#development)
- [License](#license)

## Installation

```bash
bun add @kingsleyweb/bun-nest @nestjs/common @nestjs/core rxjs reflect-metadata
bun add @nestjs/websockets   # only for WebSocket gateways
bun add @kingsleyweb/bun-jobs # only for @kingsleyweb/bun-nest/jobs
bun add -d @types/bun        # optional peer, >= 1.4.2
```

`@kingsleyweb/bun-common` is a dependency and is installed with it.
`@nestjs/platform-express` is not needed.

`@kingsleyweb/bun-jobs` is an **optional** peer: only
[the jobs API module](#the-jobs-api-module) imports it, and installing it is
what makes that subpath compile. See
[the note there](#installing-bun-jobs-is-what-makes-the-subpath-compile) for
what `tsc` reports without it.

## Quick start

```ts
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { Body, Controller, Get, Module, Param, ParseIntPipe, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import "reflect-metadata";

@Controller("todos")
class TodosController {
  @Get(":id")
  one(@Param("id", ParseIntPipe) id: number) {
    return { id };
  }

  @Post()
  create(@Body() body: { title: string }) {
    return { created: body.title };
  }
}

@Module({ controllers: [TodosController] })
class AppModule {}

const app = await NestFactory.create(AppModule, new BunHttpAdapter());
await app.listen(3000); // binds 127.0.0.1 unless a hostname is given

// ...later
await app.close(); // force-closes the Bun server, keep-alive connections included
```

`app.listen(0)` asks the OS for a free port; `app.getUrl()` reports it. See
[`01-quick-start/index.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/01-quick-start/index.ts).

## `BunHttpAdapter`

`BunHttpAdapter` extends NestJS's `AbstractHttpAdapter`. Its `instance` is a
bun-common `BunRouter`, and `listen()` binds `Bun.serve`. `BunNestHttpAdapter`
is the same class under a second name. Its constructor is
`new BunHttpAdapter(requestTimeout?, options?)`.

### Adapter options

| Option | Type | Default | Description |
|---|---|---|---|
| `requestTimeout` (1st argument) | `number` | `0` | Milliseconds allowed to finalise a response once routing is done. `0` means no timeout. Also settable with `setTimeout()`. |
| `request` | `Partial<BunRequestOptions>` | `{ parseBody: true, parseCookies: true }` | Request parsing forwarded to every `BunRequest`: body, cookie and query parsing, size caps (`parseBody.maxContentLength`, `parseBody.contentTypes`, …) and `cookieSecret`. Merged over the default object (`mergeBunRequestOptions`, nested `parseBody` included), so `{ cookieSecret }` alone keeps body parsing on; set a default explicitly to turn it off (`{ parseBody: false }`). |
| `router` | `BunRouterOptions` | `{ caseSensitive: true, debug: false }` | Options for the `BunRouter`, merged over the default. |
| `routeCacheMax` | `number` | `50_000` (`DEFAULT_ROUTE_CACHE_MAX`) | Upper bound on the router's matched-pipeline cache before FIFO eviction. `0` disables it. The cache is keyed by resolved path, so size it above the number of distinct paths in flight, or use `0`. |
| `etag` | `boolean` | `false` | Compute an `ETag` for every response, so a matching `If-None-Match` is answered `304`. |
| `logger` | NestJS `Logger` | `new Logger()` | Logger for adapter diagnostics: bind failures and unhandled errors. |
| `server` | `BunServeNormalOptions` | `{}` | Base `Bun.serve` options (TLS, `idleTimeout`, `maxRequestBodySize`, …). `port`, `hostname`, `fetch`, `websocket`, `error` and `development` are set by the adapter and override these. |
| `websocket` | `Partial<WebsocketOptions>` | bound to this adapter | Overrides for the built-in WebSocket adapter. See [the `websocket` option](#the-websocket-option). |

```ts
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { Logger } from "@nestjs/common";

export const adapter = new BunHttpAdapter(10_000, {
  request: { parseBody: { maxContentLength: "16kb" }, parseCookies: true },
  router: { caseSensitive: false },
  routeCacheMax: 10_000,
  etag: true,
  logger: new Logger("Http"),
  server: { idleTimeout: 30, maxRequestBodySize: 1024 * 1024 },
});
```

`development` is set to `Bun.env.NODE_ENV !== "production"`. Bodies are
parsed by `BunRequest` while the request is built, following `request`. A body
over `parseBody.maxContentLength` is answered `413` before any middleware or
route runs.

### Adapter methods and properties

NestJS calls most of these for you. The ones you are likely to call directly:

| Member | Description |
|---|---|
| `listen(port, hostname?, callback?)` | Binds `Bun.serve`. See [`listen()` and `close()`](#listen-and-close). |
| `close()` | Stops the server with `stop(true)` and emits `close`. Routes and handlers stay registered. |
| `fetch(input, init?)` | Runs a request through the adapter without a socket. See [Testing with `fetch()`](#testing-with-fetch). |
| `use`, `get`, `post`, `put`, `patch`, `delete`, `head`, `options`, `all`, `search`, `propfind`, `proppatch`, `mkcol`, `copy`, `move`, `lock`, `unlock` | Register raw router middleware and routes beside Nest's controllers. `use` also mounts a `BunRouter`: see [Mounting a bun-common router](#mounting-a-bun-common-router). |
| `enableCors(options, prefix?)` | See [CORS](#cors). |
| `useStaticAssets(path, options)` | See [Static assets](#static-assets). |
| `useBodyParser(type, rawBody, options)`, `registerParserMiddleware(prefix?, rawBody?)` | See [Body parsing and raw bodies](#body-parsing-and-raw-bodies). |
| `setErrorHandler(handler)`, `setNotFoundHandler(handler)` | See [Error handling](#error-handling). |
| `setLogger(logger)`, `logger` | Replace or read the NestJS logger. |
| `setRequestOpts(opts)`, `requestOpts` | Replace or read the `request` option. Setting it merges over the defaults, not over the options set before. |
| `setTimeout(ms, callback)` | Sets `requestTimeout`, then calls `callback` with the server once one is listening. |
| `getBunServer()`, `server` | The `Bun.serve` server, or `undefined` before `listen()`. |
| `getHttpServer()` | What Nest holds as its HTTP server: a proxy that answers Nest's Node-style calls (`address`, `once`, …) from the adapter and the Bun server. |
| `url`, `listeningHost`, `listeningPort`, `isListening`, `address()`, `getListenAddress()` | Server introspection. `getListenAddress()` resolves the URL once bound. |
| `eventEmitter` | A Node `EventEmitter`: `listening` (with the server), `close`, and `error` (a bind failure, when a listener is attached). |
| `webSocketAdapter` | The built-in `BunNestWebsocketAdapter`. Setting it also makes it the router's active WebSocket adapter. |
| `getType()` | `"express"`, for libraries that branch on the platform. |

`useStaticAssets` is not on Nest's `INestApplication` type, so call it on the
adapter. `enableCors` is on both.

### Routing and typed routes

Nest's controllers are registered on the adapter's `BunRouter`. Raw routes can
sit beside them, and they are typed: `req.params` is inferred from the path
literal, and `req.query` / `req.body` / `req.params` from a
[Standard Schema](https://standardschema.dev) validator placed immediately
before the handler.

```ts
import { validate } from "@kingsleyweb/bun-common";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { z } from "zod";

const adapter = new BunHttpAdapter();

adapter.get("/raw/:id/:tab?", (req, res) => {
  // req.params: { id: string; tab?: string }
  return res.json(req.params);
});

adapter.get("/search", validate({ query: z.object({ page: z.coerce.number() }) }), (req, res) => {
  // req.query: { page: number }
  return res.json({ page: req.query.page });
});
```

Routing, matching and validation behave exactly as in bun-common. See its
[README](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/README.md)
for route patterns, `routeSpecificity`, sub-routers and validators.
Demonstrated in
[`controllers-and-routing.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/controllers-and-routing.ts)
and
[`adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/adapter-options.ts).

#### Mounting a bun-common router

`use()` mounts a bun-common `BunRouter` (or any `@routejs/router` `Router`) as
it takes middleware, with or without a path prefix, and with no cast. That is
how `BunJobsApiModule` mounts the jobs API, and how the
[jobs UI](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-jobs-ui/README.md)
mounts on a Nest app:

```ts
import { BunRouter, validate } from "@kingsleyweb/bun-common";

const admin = new BunRouter();
admin.get("/status", (_req, res) => res.json({ ok: true }));
adapter.use("/admin", admin); // GET /admin/status
adapter.use(ui.basePath, ui.router); // jobsUi() from @kingsleyweb/bun-jobs-ui

// A router that declares its mount sees the mount's params and validated
// query, and must be mounted exactly there: a different path, a different
// validated shape, or a missing validator is a compile error.
const orgs = new BunRouter<"/orgs/:org", { query: { page: number } }>();
orgs.get("/members", (req, res) => res.json({ org: req.params.org, page: req.query.page }));
adapter.use("/orgs/:org", validate({ query: PageQuery }), orgs);
```

The mounting rules are bun-common's; see its
[typed routes](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/README.md#typed-routes).
Like other raw routes, a mounted router runs below Nest's pipeline: guards,
interceptors and `setGlobalPrefix` do not apply to it. Mount before
`app.listen()` or `app.init()`. Demonstrated in
[`06-jobs-ui/mount.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/06-jobs-ui/mount.ts).

### Nest middleware

`consumer.apply(...).forRoutes(...)` works as usual. Nest hands each entry to
`createMiddlewareFactory(method)`, which registers it with
`BunRouter.useMethod`. Each entry is method-scoped and runs in registration
order ahead of the route handler. Its path is prefix-matched, like Express's
`use(path)`. Middleware receives a `BunRequest` and a `BunResponse`. A global
prefix (`app.setGlobalPrefix`) applies as usual.

See
[`middleware-and-versioning.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/middleware-and-versioning.ts).

### Responses: `@Redirect`, `StreamableFile`, `@Render`

| Nest feature | Behaviour on `BunHttpAdapter` |
|---|---|
| Returned value | Sent through `BunResponse.send`: text, JSON, binary, `Bun.file()`, `Blob`, `ReadableStream`, Node `Readable` and async iterables (streams are sent as they are). |
| `@Res()` | You send the response. With `{ passthrough: true }` you may set headers or cookies and still return a value. |
| `@HttpCode`, `@Header` | As on Express. |
| `@Redirect(url, status)` | Sets `Location` and the status (`302` when the status is `0`), then sends an **empty** body. Like Express's `res.redirect`, it finishes the response, but it sends no "Redirecting to" body. |
| `StreamableFile` | Streamed. Its `type`, `disposition` and `length` fill in `Content-Type`, `Content-Disposition` and `Content-Length` when the handler has not set them. A stream error goes to the file's `errorLogger`. |
| `@Render(path)` | Sends the **file at `path`** with its content type. There is no template engine, and `setViewEngine()` does nothing. The handler's return value is the `RenderOptions`: a positive integer `status` on it sets the status, otherwise `200`. |

```ts
import type { RenderOptions } from "@kingsleyweb/bun-nest";
import { createReadStream } from "node:fs";
import { Controller, Get, HttpStatus, Redirect, Render, StreamableFile } from "@nestjs/common";

@Controller()
export class PagesController {
  @Get("old")
  @Redirect("/new", HttpStatus.MOVED_PERMANENTLY)
  old() {}

  @Get("report.csv")
  report() {
    return new StreamableFile(createReadStream("report.csv"), {
      type: "text/csv",
      disposition: "attachment; filename=\"report.csv\"",
    });
  }

  @Get("maintenance")
  @Render("public/maintenance.html")
  maintenance(): RenderOptions {
    return { status: 503 };
  }
}
```

See
[`controllers-and-routing.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/controllers-and-routing.ts).

### Versioning

`app.enableVersioning()` supports every `VersioningType`. All types except
`URI` are enforced by the adapter's `applyVersionFilter`, which wraps each
versioned handler. A request whose version does not match calls `next()`, so
the next candidate route gets it. A request no route accepts ends as Nest's
404.

| Type | How the version is read |
|---|---|
| `VersioningType.URI` | From the path (`/v2/...`); Nest builds the routes, no filter is applied. |
| `VersioningType.HEADER` | From the `header` option's request header. |
| `VersioningType.MEDIA_TYPE` | From the `Accept` header's parameter after `;`, split on `key` (`Accept: application/json;v=2` with `key: "v="`). |
| `VersioningType.CUSTOM` | From `extractor(req)`, a string or an array of strings. |

A handler whose version is `VERSION_NEUTRAL` always matches. For `HEADER` and
`MEDIA_TYPE`, a request that sends no version matches a handler whose version
list includes `VERSION_NEUTRAL`.

`CUSTOM` has a limitation: the filter runs per handler, so when an extractor
returns several versions and they are served by different handlers, the
highest matching version is not selected. The first handler that matches any
of them wins.

```ts
import { VersioningType } from "@nestjs/common";

app.enableVersioning({ type: VersioningType.HEADER, header: "X-API-Version" });
```

See
[`middleware-and-versioning.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/middleware-and-versioning.ts).

### CORS

`app.enableCors(options)` (or `adapter.enableCors(options, prefix?)`) uses
bun-common's native `cors`, which takes the same options as the `cors`
package: `origin` (a string, a `RegExp`, an array of either, or a function),
`methods`, `allowedHeaders`, `exposedHeaders`, `credentials`, `maxAge`,
`preflightContinue`, `optionsSuccessStatus`.

- It registers the CORS middleware and an `OPTIONS *` route for preflights,
  under `prefix` when one is given.
- A `CorsOptionsDelegate` `(req, callback)` is called per request. If it passes
  an error to the callback, the request is answered `400` with the error
  message.

```ts
app.enableCors({
  origin: ["https://shop.example.com", /\.example\.dev$/],
  credentials: true,
  methods: ["GET", "POST"],
  maxAge: 600,
});
```

See
[`adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/adapter-options.ts).

### Static assets

`adapter.useStaticAssets(directory, options)` serves a directory under
`options.prefix`. It registers `GET <prefix>/*` and shares bun-common's static
file implementation. That implementation provides directory indexes, extension
fallbacks, dotfile policy, `ETag` / `Last-Modified` validators (conditional
requests answer `304`), `Cache-Control`, byte ranges (`206`) and a `404` for a
path that resolves to nothing.

| Option | Default | Description |
|---|---|---|
| `prefix` | none | URL prefix the directory is served under. |
| `dotfiles` | `"ignore"` | `"allow"`, `"deny"` (403) or `"ignore"` (treated as missing). |
| `etag` | `true` | Send an `ETag`. |
| `lastModified` | `true` | Send `Last-Modified`. |
| `maxAge` | `0` | `Cache-Control` max-age, in milliseconds or an `ms`-style string (`"1d"`). |
| `immutable` | `false` | Add `immutable` to `Cache-Control` (use with `maxAge`). |
| `extensions` | `false` | Fallback extensions tried for a missing file, e.g. `["html"]`. |
| `index` | `"index.html"` | Directory index file(s); `false` disables. |
| `redirect` | `true` | Redirect a directory to its trailing-slash URL (301). |
| `fallthrough` | `false` | Let client errors fall through as unhandled requests. |
| `setHeaders` | none | `(res, path, stat) => void`, called synchronously for each file. |
| `metadataCacheTtl` | `1000` | Milliseconds a file's metadata (size, mtime, type, ETag) is memoised. `0` stats every request. |
| `metadataCacheMax` | `1024` | Maximum paths held in the metadata cache. |
| `precompressed` | `false` | Serve a precompressed sibling (`app.js.br`, `app.js.zst`, `app.js.gz`) when the client accepts its coding. `true` uses the defaults below. |
| `compression` | `true` | Compress on the fly, with `compression()`'s rules, when no sibling is served. An object customises it, and `false` sends files as they are on disk. Range requests are never compressed. |

`precompressed` as an object:

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Whether siblings are looked for. |
| `extensions` | `br: [".br"]`, `zstd: [".zst"]`, `gzip: [".gz"]` | Sibling extensions per coding, merged over the defaults. An empty list turns a coding off. |
| `encodings` | `"*"` | The server's preference between codings, breaking ties between equal q-values. |
| `fallback` | `"compress"` | When no sibling applies: `"compress"` on the fly (unless `compression: false`) or `"identity"`. |

A sibling is served only when the original file exists. It carries the
original's `Content-Type`, `Content-Encoding`, `Vary: Accept-Encoding` and its
own validators.

```ts
import { join } from "node:path";

adapter.useStaticAssets(join(import.meta.dir, "public"), {
  prefix: "/static",
  maxAge: "1d",
  immutable: true,
  extensions: ["html"],
  dotfiles: "deny",
  precompressed: true,
});
```

See
[`adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/adapter-options.ts)
and
[`http-adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/10-options/http-adapter-options.ts).

### Body parsing and raw bodies

Bodies are parsed while the request is built (the adapter's `request` option).
On top of that, NestJS's body-parser hooks map to two adapter methods:

- **`app.useBodyParser(type, options)`** calls
  `adapter.useBodyParser(type, rawBody, options)`, where `rawBody` is the
  application's `rawBody` option. `type` is `"json"`, `"urlencoded"`, `"text"`
  or `"raw"`.
- **`registerParserMiddleware(prefix?, rawBody?)`** is what Nest calls at init.
  It registers one parser for every media type, with `inflate: true`.

| `useBodyParser` option | Default | Description |
|---|---|---|
| `type` | the kind's default: `json` → `application/json`, `urlencoded` → `application/x-www-form-urlencoded`, `text` → `text/plain`, `raw` → `application/octet-stream` | A media type, a list, or a predicate. A request that does not match is left to other parsers. |
| `limit` | `"100kb"` | Bytes or a size string. A body over it rejects with a `413` `PayloadTooLargeError`, which Nest's exception layer answers `413`. |
| `inflate` | `true` | `false` refuses a compressed body (any `Content-Encoding` but `identity`) with `415`. |
| `encodings` | `"*"` | Allowed content codings (`gzip`, `deflate`, `br`, `zstd`, `dcb`/`dcz` with dictionaries); others are `415`. |
| `maxContentCodings` | `5` | Most codings one `Content-Encoding` may stack; more is `415`. |
| `decompressionFastPathLimit` | 32 MiB | Worst-case memory one layer may use on Bun's faster decoders before falling back to `node:zlib`. |
| `compressionDictionaries` | none | Dictionaries (or a resolver) for `dcb`/`dcz` bodies. |
| anything else | | Parser-specific options (`strict`, `reviver`, `extended`, …). |

- **Each kind is registered once.** A second `useBodyParser` call for the same
  kind (and prefix) does nothing; different kinds stack, each with its own
  options.
- **`rawBody`.** With `NestFactory.create(AppModule, adapter, { rawBody: true })`
  a parser that read the body keeps the bytes on `req.rawBody` (type the request
  as `RawBodyRequest<BunRequest>`). A request that parser skipped keeps what an
  earlier parser set.

```ts
import type { BunRequest } from "@kingsleyweb/bun-common";
import type { RawBodyRequest } from "@nestjs/common";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { Controller, Post, Req } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

@Controller("webhooks")
export class WebhooksController {
  @Post("payments")
  payment(@Req() req: RawBodyRequest<BunRequest>) {
    return { bytes: req.rawBody?.length }; // verify a signature over req.rawBody
  }
}

const app = await NestFactory.create(AppModule, new BunHttpAdapter(), { rawBody: true });
app.useBodyParser("json", { limit: "1mb" });
app.useBodyParser("text", { limit: "1kb" });
```

See
[`adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/adapter-options.ts)
and
[`http-adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/10-options/http-adapter-options.ts).

### Response compression

bun-common's `compression()` is ordinary router middleware, so `app.use`
accepts it. It compresses Nest controllers' responses with gzip, deflate, br
or zstd, and appends `Accept-Encoding` to `Vary` (after `Origin` when CORS set
one).

```ts
import { compression } from "@kingsleyweb/bun-common";

app.use(compression({ threshold: 0 }));
```

Its options (`threshold`, `filter`, `encodings`, dictionaries, …) are
documented in the
[bun-common README](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/README.md).
See
[`http-adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/10-options/http-adapter-options.ts).

### Error handling

Errors reach one of three layers, depending on where they are raised.

1. **Inside a controller's pipeline.** Between a matched route and its handler
   everything is plain NestJS: middleware → guards → interceptors → pipes →
   handler → interceptors → exception filters. An `HttpException` or a filter
   works exactly as on Express.
2. **Before routing, or outside Nest's reach.** A body refused for its
   `Content-Encoding` (`415`), a corrupt stream (`400`), or an error thrown by
   raw router middleware goes to the handlers added with
   `adapter.setErrorHandler`. Nest registers its own exception layer there at
   init, so these errors reach your exception filters as they would on
   `@nestjs/platform-express`. Error handlers run as Express error
   middleware: `(err, req, res, next)` in registration order, where
   `next(err)` passes the error to the next handler, `next()` ends error
   handling with a `404`, and a return value is ignored.
3. **Nothing handled it.** With no error handler, when the error carries no
   request (thrown before one was built, or while finalising the response),
   or when a handler itself throws, the adapter answers as Express's
   `finalhandler` would. The status comes from `err.status` or `err.statusCode`
   when that is 400–599, otherwise `500`. The error is logged through the
   Nest logger, except under `NODE_ENV=test`.

A request no route matched runs the `setNotFoundHandler` handlers in
registration order, until one returns nothing. Nest adds its own at init
(`Cannot GET /x`), and one added earlier runs first. An oversized body
(`request.parseBody.maxContentLength`) is answered `413` before any of this.

For errors from raw middleware, an Express-style 4-argument error middleware
added with `app.use()` after `app.init()` also works:

```ts
import type { RouterErrorMiddlewareHandler } from "@kingsleyweb/bun-common";

adapter.setErrorHandler(((err, _req, res, _next) => {
  return res.status(500).json({ message: String(err) });
}) satisfies RouterErrorMiddlewareHandler);
```

See
[`pipeline.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/pipeline.ts).

### Testing with `fetch()`

After `app.init()`, `adapter.fetch()` runs a request through the whole adapter
pipeline with no port bound. That covers the payload guard, the router, Nest's
not-found and exception handling, error handlers and response finalisation. It
calls the same method `Bun.serve`'s `fetch` calls, and routes errors through
the same method `Bun.serve`'s `error` callback calls.

```ts
const adapter = new BunHttpAdapter();
const app = await NestFactory.create(AppModule, adapter, { logger: false });
await app.init();

await adapter.fetch("/todos/1"); // a string implies GET
await adapter.fetch("/todos", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "Write docs" }),
});
await adapter.fetch(new Request("http://localhost/todos/1")); // full control

await app.close();
```

- It **never rejects** for an error in the pipeline. An unhandled error
  resolves the finalhandler-style response a served request gets.
- With no live server there is no peer: `requestIP()` is `null` and a
  WebSocket upgrade is refused. When the adapter is listening, the live server
  is used instead.

See
[`middleware-and-versioning.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/middleware-and-versioning.ts)
(one app per versioning type, none of them listening).

### `listen()` and `close()`

`listen(port, callback?)` and `listen(port, hostname, callback?)` bind
`Bun.serve`. The callback is called with the server, and the method resolves
it.

- **Hostname.** Without one, the adapter binds **`127.0.0.1`**, so
  `app.listen(3000)` is reachable from the local machine only. Pass
  `app.listen(3000, "0.0.0.0")` to listen on every interface. Any hostname
  `Bun.serve` accepts is bound as given.
- **Port.** It must be an integer from `0` to `65535`, otherwise `listen`
  throws a `RangeError`. `0` picks a free port.
- **Already listening.** On the same address (or port `0`), `listen` resolves
  the running server. On a different address, it stops that server and binds
  the new one.
- **Busy port.** A bind failure (`EADDRINUSE`, an unresolvable hostname, a
  privileged port) is logged. The adapter never binds somewhere else.
  - If no `error` listener is attached to the HTTP server, `listen` rejects.
  - If one is attached, as `app.listen()` attaches one, the listener receives
    the error, the callback is not called, and `listen` resolves `undefined`.
    So **`app.listen()` rejects with the bind error**, as with
    `@nestjs/platform-express`.
- **Emits** `listening` with the server on `adapter.eventEmitter`.

`close()` stops the server with `stop(true)`, force-closing keep-alive
connections so the port is released at once, and emits `close`. Routes and
error and not-found handlers stay registered, so a closed adapter can listen
again or be driven through `fetch()`.

See
[`http-adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/10-options/http-adapter-options.ts).

### Known differences from `@nestjs/platform-express`

- `@Render()` sends a file; there is no view engine, and `setViewEngine()` is
  a no-op.
- `@Redirect()` sends an empty body rather than a "Redirecting to" body.
- `getType()` returns `"express"`.

## File upload interceptors

The `@nestjs/platform-express` upload API, implemented with bun-common's
multipart handling (busboy). Import the interceptors from
`@kingsleyweb/bun-nest`. `UploadedFile` and `UploadedFiles` are Nest's own
decorators, re-exported for convenience.

```ts
import type { MemoryStorageFile } from "@kingsleyweb/bun-common";
import { FileInterceptor, UploadedFile } from "@kingsleyweb/bun-nest";
import { Controller, Post, UseInterceptors } from "@nestjs/common";

@Controller("avatars")
export class AvatarsController {
  @Post()
  @UseInterceptors(FileInterceptor("avatar", { storageType: "memory", limits: { fileSize: 1024 * 1024 } }))
  upload(@UploadedFile() file: MemoryStorageFile | undefined) {
    return { name: file?.originalFilename, size: file?.size, type: file?.validatedMimeType?.mime };
  }
}
```

### Interceptors

| Interceptor | multer equivalent | Accepts | Handler reads |
|---|---|---|---|
| `FileInterceptor(fieldname, options?)` | `single()` | at most one file, on `fieldname` | `@UploadedFile()` (`undefined` when no file was sent) |
| `FilesInterceptor(fieldname, maxCount = 1, options?)` | `array()` | up to `maxCount` files, all on `fieldname` | `@UploadedFiles()`, an array |
| `FileFieldsInterceptor(fields, options?)` | `fields()` | files on the listed fields, each up to its `maxCount` (default `1`); `fields` is `{ name, maxCount? }[]` | `@UploadedFiles()`, a record of arrays by field |
| `AnyFilesInterceptor(options?)` | `any()` | any files on any field | `@UploadedFiles()`, an array |
| `NoFilesInterceptor(options?)` | `none()` | fields only; any file is rejected | `@Body()` |

- Every interceptor puts the text fields on `req.body`.
- A request that is not `multipart/form-data` is rejected with
  `BadRequestException("Not a multipart request")`. `getMultipartRequest(ctx)`
  performs that check and is exported for custom interceptors.
- After the handler's result is emitted, the storage's `removeAll()` runs. For
  memory storage (`removeAfter` defaults to `true`) that releases the file
  buffers, so read a buffer inside the handler. Disk files are kept unless
  `removeAfter: true`.

An uploaded file is a bun-common `StorageFile`:

| Field | Description |
|---|---|
| `fieldname` | The form field. |
| `originalFilename` | The client's file name. |
| `mimetype` | The type the client claimed. |
| `validatedMimeType` | What the bytes are (`file-type`'s `{ ext, mime }`), or `undefined`. |
| `encoding`, `size` | Transfer encoding and size in bytes. |
| `buffer` | Memory storage (`type: "memory"`). |
| `path`, `dest`, `filename` | Disk storage (`type: "disk"`). |

### Upload options and storages

The options are bun-common's `UploadOptions`, a union keyed by `storageType`:

| `storageType` | Extra options | Description |
|---|---|---|
| `"memory"` (the default) | `removeAfter` (default `true`) | Files held in a `Buffer`. |
| `"disk"` | `dest` (default: the OS temp directory), `filename` (default: 32 random hex characters plus the original extension), `removeAfter` (default `false`) | Files written to disk. `dest` and `filename` are strings or `(file, req) => string \| Promise<string>`. The directory is created when missing. A fixed `filename` makes each upload overwrite the last. |
| `"custom"` | `storage` (required) | Any `Storage`: `handleFile(file, req)` and `removeFile(file, force?)`. A `DiskStorage` or `MemoryStorage` instance works too. |

Options every storage type accepts:

| Option | Default | Description |
|---|---|---|
| `filter` | none | `(req, file) => boolean \| string` (or a Promise). `true` keeps the file, `false` silently drops it (and removes it from storage), a string rejects the upload with that message (`FILTER_REJECTED`). A thrown error is passed on unchanged. |
| `limits` | busboy's | busboy limits: `fileSize`, `files`, `fields`, `parts`, `fieldNameSize`, `fieldSize`, `headerPairs`. |
| `inflate` | `true` | Replace a field value that parses as JSON (or urlencoded) with the parsed value; `false` keeps raw strings. |
| `fieldInflator`, `fileInflator` | none | Custom inflation of a field value or a file's bytes. |
| `isPartAFile` | busboy's rule | `(fieldName, contentType, fileName) => boolean`. |
| other busboy options | | `preservePath`, `highWaterMark`, `fileHwm`, `defParamCharset`, … |

```ts
import { DiskStorage } from "@kingsleyweb/bun-common";
import { FileFieldsInterceptor, FilesInterceptor } from "@kingsleyweb/bun-nest";

export const photos = FilesInterceptor("photos", 5, {
  storageType: "disk",
  dest: "./uploads",
  filter: (_req, file) => file.validatedMimeType?.mime.startsWith("image/") || "Images only",
});

export const documents = FileFieldsInterceptor([{ name: "cover", maxCount: 1 }, { name: "pages", maxCount: 20 }], {
  storageType: "custom",
  storage: new DiskStorage({ dest: "./docs", filename: (file) => file.filename, removeAfter: false }),
});
```

### Limits and where multipart is parsed

By default the adapter parses a multipart body while it builds the request,
before any interceptor runs. Busboy options given to an interceptor
(`limits`, `inflate`, …) are then **not applied**. To have the interceptor
parse the body with its own options, leave `multipart` out of the adapter's
`request.parseBody.contentTypes`:

```ts
export const adapter = new BunHttpAdapter(0, {
  request: {
    parseBody: { contentTypes: { json: true, urlencoded: true, text: true } },
  },
});
```

See the last section of
[`interceptors.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/03-file-uploads/interceptors.ts)
and
[`interceptor-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/10-options/interceptor-options.ts).

### Upload errors

Errors raised while reading an upload pass through `transformUploadException`,
which reproduces `@nestjs/platform-express`'s `transformException`. No
exception filter is needed:

| Error | Becomes | Status |
|---|---|---|
| an `HttpException` (e.g. from a custom storage) | kept as it is | its own |
| `UploadError` `LIMIT_FILE_SIZE` | `PayloadTooLargeException`, bare message | `413` |
| `UploadError` `LIMIT_PART_COUNT`, `LIMIT_FILE_COUNT`, `LIMIT_FIELD_KEY`, `LIMIT_FIELD_VALUE`, `LIMIT_FIELD_COUNT`, `LIMIT_UNEXPECTED_FILE`, `MISSING_FIELD_NAME` | `BadRequestException` | `400` |
| `UploadError` `FILTER_REJECTED` (a `filter` returned a string) | `BadRequestException` | `400` |
| any other error with `statusCode` `413` (bun-common's `PayloadTooLargeError`) | `PayloadTooLargeException` | `413` |
| busboy's `Multipart: Boundary not found` | `BadRequestException`, message as it is | `400` |
| busboy's `Malformed part header`, `Unexpected end of form`, `Unexpected end of file` | `BadRequestException`, message prefixed `Multipart: ` | `400` |
| anything else: an error a `filter` or storage throws, a `TypeError` | returned unchanged, so Nest answers it | `500` |

- Inside Nest, only a file over `limits.fileSize` is `413`. Every count limit
  is `400`. That is platform-express's mapping. bun-common's standalone
  `UploadError.status` uses `413` for every size and count limit.
- For an `UploadError`, the response body is an `UploadExceptionBody`:
  `{ statusCode, message, code, field }`. multer's own message for the code
  gets ` - <field>` appended on a `400` (`"Unexpected field - avatar"`), as
  platform-express words it. `LIMIT_FILE_SIZE` keeps the bare message, and a
  more specific message (`"Field photos accepts max 5 files"`) is kept as it
  is. The original error is the exception's `cause`.

## `BunWebSocketAdapter`

A NestJS `WebSocketAdapter` over Bun's native WebSockets. It speaks a
socket.io-shaped **JSON packet protocol** (`MessageEventTypes`) over plain
WebSocket frames, and follows `@nestjs/platform-socket.io`'s semantics for
replies, acknowledgements and exceptions. It does not implement the
Engine.IO transport, so clients send the JSON packets below with a standard
`WebSocket` rather than `socket.io-client`.

`BunNestWebsocketAdapter` is the same class under a second name. It is what
`BunHttpAdapter` builds as `httpAdapter.webSocketAdapter`.

### Gateways

Install the HTTP adapter's own WebSocket adapter **before** `app.listen()`,
which is when NestJS connects gateways:

```ts
import type { BunNestWebSocketClient, WsAckFunction } from "@kingsleyweb/bun-nest";
import type { OnGatewayConnection, WsResponse } from "@nestjs/websockets";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Ack, MessageBody, SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";

@WebSocketGateway()
class ChatGateway implements OnGatewayConnection {
  handleConnection(client: BunNestWebSocketClient) {
    client.emit("welcome", client.data.path);
  }

  @SubscribeMessage("echo")
  echo(@MessageBody() text: string): WsResponse<string> {
    return { event: "echo", data: text };
  }

  @SubscribeMessage("save")
  save(@MessageBody() note: string, @Ack() ack: WsAckFunction<[length: number]>) {
    ack(note.length);
  }
}

@Module({ providers: [ChatGateway] })
class AppModule {}

const httpAdapter = new BunHttpAdapter();
const app = await NestFactory.create(AppModule, httpAdapter);
app.useWebSocketAdapter(httpAdapter.webSocketAdapter);
await app.listen(3000);
```

- The client a gateway receives is a Bun `ServerWebSocket` with `data` (see
  below) plus an `emit(event, ...args)`. `BunNestWebSocketClient<Custom, Events>`
  types it; declare a `WsEventMap` to have `emit` check event names and
  arguments.
- `handleConnection(client, server)` always receives the live server.
  `@WebSocketServer()` and `afterInit(server)` receive what `create()` returned
  when NestJS connected the gateway. For a gateway on a port of its own, that
  is its server. For one sharing the HTTP server it is `undefined`, because
  gateways are connected before the HTTP server starts listening.

`client.data` (`WebSocketClientData`) holds:

| Field | Description |
|---|---|
| `host` | Authority of the upgrade request. |
| `path`, `search`, `hash`, `originalUrl` | The upgrade URL split as on `BunRequest` (`hash` is always `""`). |
| `headers` | Headers of the upgrade request. |
| `user` | `req.user` at upgrade time, when middleware set one. |
| `custom` | The `onUpgrade` hook's `custom`, else `webSocketUpgradeData.custom`, else `undefined`. |
| `route`, `params` | The matched upgrade route pattern and its params. |
| `port` | The real port of the server that accepted the upgrade. |

See
[`gateway-basics.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/04-websockets/gateway-basics.ts).

### Namespaces and paths

A gateway's `path` and `namespace` are **URL paths**. It serves connections
whose URL path is `path` followed by `namespace`:

| `@WebSocketGateway(...)` | Serves |
|---|---|
| `{}` | `/` |
| `{ path: "/ws" }` | `/ws` |
| `{ namespace: "/chat" }` | `/chat` |
| `{ path: "/ws", namespace: "chat" }` | `/ws/chat` |
| `{ namespace: "*" }` or a path ending in `/*` | every path below |

- A connection to a path no gateway serves has its upgrade refused with a
  `404`.
- Each gateway hears only its own connections. The `namespace` field inside a
  packet is echoed back but does not route.
- One caveat: when one port serves several `path`s, a gateway that declares the
  same `path` as an earlier one and no `namespace` cannot be told apart. It is
  bound to `/` if that is among them. Give it a `namespace`.

### Gateway ports

A port is a boundary.

- `@WebSocketGateway(port)` binds a dedicated server on that port. The gateway
  handles only clients that server accepted (`client.data.port === port`).
- A gateway on port `0`, or with no port, handles only clients of the server
  it rides on, the HTTP adapter's.
- Two gateways on the same path but different ports never see each other's
  clients. A mismatched client runs none of a gateway's connection, message or
  disconnect hooks.

See
[`adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/04-websockets/adapter-options.ts).

### Wire format

Every frame is JSON text; a binary frame holding the same JSON also works.

| `type` | Name | Client sends | Adapter does |
|---|---|---|---|
| `0` | `CONNECT` | `{ type, namespace }` | calls `@SubscribeMessage("connect")` |
| `1` | `DISCONNECT` | `{ type, namespace }` | calls `@SubscribeMessage("disconnect")`; the socket stays open |
| `2` | `EVENT` | `{ type, namespace, data: [event, ...args], id? }` | calls `@SubscribeMessage(event)`; an `id` enables acknowledgements |
| `3` | `ACK` | `{ type, namespace, id, data }` | echoes the packet back unchanged |
| `4` | `ERROR` | `{ type, namespace, data: message }` | calls `@SubscribeMessage("error")` with the message |
| `5` | `BINARY_EVENT` | `{ type, namespace, data: [event, ...args], binary?, id? }` | decodes the base64 arguments into `Buffer`s, then as `EVENT` |
| `6` | `BINARY_ACK` | `{ type, namespace, id, data, binary? }` | echoes the packet back unchanged |

- **Payload mapping** follows socket.io's adapter. `@MessageBody()` is the one
  argument, an array when there are several, and `undefined` when there are
  none.
- **The `binary` marker** lists the positions of base64 arguments after the
  event name (`0` is the first argument). The adapter always sends it. A
  packet received without it is read as carrying only binary arguments, so
  every string argument is decoded.
- **Unparseable frames.** A frame that cannot be parsed calls
  `@SubscribeMessage("error")` with the error and is answered with an `ERROR`
  packet.
- **Unroutable frames.** An unparseable frame, an unknown `type`, or an `EVENT`
  whose `data` is not an array goes, as raw data, to handlers subscribed to
  `"events"`.
- **Handler errors.** An error the adapter catches from a handler's result
  stream is sent as an `ERROR` packet.

`MessageEventTypes` and the packet types (`MessagePacket<T>`,
`MessageEventType`, `MessageBinaryEventType`, …) are exported for typed
clients.

See
[`message-formats.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/04-websockets/message-formats.ts).

### Replies: `WsResponse`, Promises and Observables

What a handler returns:

- **A `WsResponse` (`{ event, data }`, with a truthy `event`)** is sent to the
  caller as `EVENT` `[event, data]`. It is sent as `BINARY_EVENT` (base64) when
  `data` is a `Buffer`, typed array, `DataView` or `ArrayBuffer`.
- **A `Promise` or `Observable`** has every emission handled the same way, in
  order.
- **`undefined` or `null`** sends nothing.
- **Any other value** is not a reply. It becomes the acknowledgement when the
  packet carried an `id` and the handler does not take `@Ack()`, as described
  next. Otherwise it is ignored.

### Acknowledgements

Acknowledgements follow `@nestjs/platform-socket.io`:

- **With `@Ack()`**, when the packet carried an `id`, the handler receives a
  `WsAckFunction`. Calling it sends `ACK` (or `BINARY_ACK` when any argument is
  binary) with the same `id` and the arguments as `data`. The handler owns the
  ack (`isAckHandledManually`): its return value is never sent as one, and
  never calling it sends none.
- **Without `@Ack()`**, a non-nullish, non-`WsResponse` return (each emission
  of a Promise or Observable) is sent automatically as `ACK [value]`.
- Either way, **at most one ack is sent per packet**. A second call, or an
  automatic ack after a manual one, is ignored.
- The ack type follows the ack's payload, not the type of the event it answers.

### Exceptions

Every client a gateway receives has an `emit`, which NestJS's default
WebSocket exception handler calls. A thrown `WsException("nope")` therefore
reaches the client as
`EVENT ["exception", { status: "error", message: "nope", cause }]`, as with
socket.io. An exception filter can replace that.

### The `websocket` option

`BunHttpAdapter`'s `websocket` option is merged field by field over defaults
that bind the built-in adapter to the HTTP adapter:
`{ httpAdapter: this, newInstance: false, router: httpAdapter.instance, getServer: () => httpAdapter.getBunServer() }`.

| Field | Description |
|---|---|
| `wsOptions` | Bun `WebSocketHandler` settings: `idleTimeout` (default `30` seconds), `maxPayloadLength` (default 1 MB), `perMessageDeflate` (default on), `backpressureLimit`, `closeOnBackpressureLimit`, `sendPings`, `publishToSelf`. The lifecycle callbacks are supplied by the adapter. |
| `onUpgrade` | `(req, res) => WebSocketUpgradeResult \| void`, may be async, run on every gateway upgrade. Its `custom` becomes `client.data.custom`, its `headers` go out on the `101`, and its `data` replaces `client.data` (`route`, `params` and `port` filled in from the match where left out). The adapter's first generic types `custom`: `new BunHttpAdapter<Session>()`. |
| `customDataToWsClientFn` | **Deprecated.** `(req, res) => Custom \| Promise<Custom>`, treated as `onUpgrade` returning `{ custom }`. Beside `onUpgrade` it is ignored, with one warning. |
| `router` | The `BunRouter` upgrade routes are registered on. Defaults to the HTTP adapter's. |
| `getServer` | The server to ride on. Defaults to the HTTP adapter's. |
| `httpAdapter` | Take the router and server from another HTTP adapter. |
| `newInstance: true` with `listen: { port, host? }` | Bind a dedicated server at construction instead of riding the HTTP server (`listen.port` is required; `0` picks a free one). `serverOptions`, `bunRequestOpts`, `request` and `response` apply to that server. |

`{ httpAdapter, localOptions }` is accepted as well.

```ts
import type { BunRequest } from "@kingsleyweb/bun-common";

interface Session {
  room: string;
}

export const httpAdapter = new BunHttpAdapter<Session>(0, {
  websocket: {
    wsOptions: { idleTimeout: 120, maxPayloadLength: 64 * 1024 },
    onUpgrade: (req: BunRequest) => ({
      custom: { room: new URLSearchParams(req.search).get("room") ?? "lobby" },
      headers: { "Sec-WebSocket-Protocol": "chat.v1" },
    }),
  },
});
```

The same `onUpgrade` option is accepted by `new BunWebSocketAdapter(...)`, in
`localOptions` or in the normal shape.

#### Headers and data on the 101

Every upgrade layers three sources, each overriding the one before:

1. **Router-wide**, on the HTTP adapter: `webSocketUpgradeHeaders` and
   `webSocketUpgradeData` (getters and setters), or the chainable
   `setWebSocketUpgradeHeaders()` / `setWebSocketUpgradeData()`. They delegate
   to the app's router, `httpAdapter.instance`.
2. **Per request**, on the response: `res.webSocketUpgradeHeaders` and
   `res.webSocketUpgradeData`, set by middleware that runs before the upgrade.
3. **The upgrade itself**: the `onUpgrade` result for a gateway, or
   `res.upgradeToWebsocket(data, { headers })` from an ordinary route.

```ts
httpAdapter.setWebSocketUpgradeHeaders({ "X-Trace": "on" });
app.use((req: BunRequest, res: BunResponse, next: () => void) => {
  res.webSocketUpgradeData = { custom: { room: "vip" } };
  next();
});
```

Headers merge by name, a later layer replacing every value of a name it gives.
Data merges shallowly, later winning per key, with `onUpgrade`'s `custom` on
top; a gateway's `route`, `params` and `port` always come from its match. Data
passed outright — `res.upgradeToWebsocket(data)` or `onUpgrade`'s `data` — is
used as is, with no router or response data merged in; headers are inherited
all the same, and an explicit header wins per name (`inherit: false` sends only
the call's own). With nothing set, the `101` is exactly Bun's default. The full
rules are in bun-common's
[Headers on the 101](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/README.md#headers-on-the-101).

### Authentication on upgrade

Upgrades go through the application's router, so middleware runs before the
upgrade route and can refuse it. `req.user`, when set, becomes
`client.data.user`.

```ts
import type { RouterMiddlewareHandler } from "@kingsleyweb/bun-common";

declare function findUserByToken(token: string | null): { id: string } | undefined;

const authenticateUpgrade: RouterMiddlewareHandler = (req, res, next) => {
  if (req.headersObj.get("upgrade")?.toLowerCase() !== "websocket") {
    return next();
  }

  const user = findUserByToken(new URLSearchParams(req.search).get("token"));
  if (!user) {
    return res.status(401).send("unknown token");
  }

  Object.assign(req, { user });
  return next();
};

app.use(authenticateUpgrade);
app.useWebSocketAdapter(httpAdapter.webSocketAdapter);
await app.listen(3000);
```

See
[`adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/04-websockets/adapter-options.ts).

### Standalone and custom adapters

`new BunWebSocketAdapter(options)` accepts three shapes. A shape that names no
server throws.

| Shape | Server |
|---|---|
| `{ httpAdapter, localOptions? }` | rides the HTTP adapter's server, using its router |
| `{ newInstance: false, getServer, router?, httpAdapter? }` | rides the server `getServer()` returns |
| `{ newInstance: true, listen: { port, host? }, router? \| httpAdapter? }` | binds its own `Bun.serve` at construction; without a `router` it uses `httpAdapter.instance`, or a private router |

It can be driven without NestJS as well. Each method is the one NestJS calls:

- `create(port, options)` registers the upgrade route and returns the server.
- `bindClientConnect(server, cb)` runs a callback per matching connection.
- `bindMessageHandlers(client, handlers, transform?)` routes one client's packets.
- `bindClientDisconnect(client, cb)` runs once when that client goes.
- `close(server)` closes it, and `dispose()` is the shutdown hook.

For a **custom adapter**, subclass `BunNestWebsocketAdapter` (or
`BunWebSocketAdapter`) and override those methods. Keep the router's active
adapter and the one Nest drives the same instance:

```ts
import { BunNestWebsocketAdapter } from "@kingsleyweb/bun-nest";

class AuditedAdapter extends BunNestWebsocketAdapter {
  override bindMessageHandlers(...args: Parameters<BunNestWebsocketAdapter["bindMessageHandlers"]>) {
    // log, time or authorise every message here
    super.bindMessageHandlers(...args);
  }
}

httpAdapter.webSocketAdapter = new AuditedAdapter({ httpAdapter }); // active on the router
app.useWebSocketAdapter(httpAdapter.webSocketAdapter); // the same instance
await app.listen(3000);
```

The HTTP server delegates every WebSocket event to whichever adapter is active
on its router at call time. Install the adapter before `app.listen()`; NestJS
ignores one installed later.

See
[`custom-adapter.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/04-websockets/custom-adapter.ts)
and
[`websocket-adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/10-options/websocket-adapter-options.ts).

### Closing

`close(server)` mirrors `@nestjs/platform-ws`:

- Gateways bound to that server stop receiving connections.
- A server the adapter owns (a gateway port's, or its own under
  `newInstance: true`) is stopped, force-closing its connections.
- The HTTP adapter's shared server is **not** stopped; that is `app.close()`'s
  job. Instead the adapter closes the WebSocket connections it holds, with
  code `1001`.

## The jobs API module

[`@kingsleyweb/bun-jobs`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-jobs/README.md)'s
management API — queues, jobs, runners, the OpenAPI and AsyncAPI documents and
a live-events socket — mounts on a Nest application as a module. It lives on
its own entry point, **`@kingsleyweb/bun-nest/jobs`**, never in the barrel:

```ts
import { BunJobs } from "@kingsleyweb/bun-jobs";
import { BunJobsApiModule } from "@kingsleyweb/bun-nest/jobs";

@Module({
  imports: [
    BunJobsApiModule.forRootAsync({
      inject: [BunJobs, AuthService],
      useFactory: (jobs: BunJobs, auth: AuthService) => ({
        jobs,
        basePath: "/admin/jobs",
        authorize: (req, context) => auth.can(req, context),
      }),
    }),
  ],
})
export class AppModule {}
```

`forRoot(options)` takes the same options inline. Both accept every
`JobsApiConfig` field plus `attachWebSocket` (default `true`), and export
`BUN_JOBS_API` and `BUN_JOBS_API_OPTIONS`. `@InjectJobsApi()` injects the
built `JobsApi`, so a service can read `api.routes`, `api.openapi()` or
`api.websocket?.sessions`.

### Mounting, injection and shutdown

The module does the three things you would otherwise do by hand, each in the
lifecycle hook where it is safe:

| Hook | What it does | Why there |
|---|---|---|
| `onModuleInit` | mounts the router at `basePath` | controllers are registered before init hooks and Nest's not-found and error handling after them, so the prefix lands ahead of the catch-alls |
| `onApplicationBootstrap` | attaches the live-events socket | runs after `useWebSocketAdapter()`, so the socket is never bound to an adapter about to be replaced |
| `beforeApplicationShutdown` | closes the API | `dispose()` stops the HTTP server between the two shutdown hooks, so closing here is what lets clients see a `1001` "going away" instead of a `1006` abnormal close |

`close()` releases what the API opened — its sessions, its event notifier and
a dedicated socket server — and never the `BunJobs`, queues, runners or driver
you passed in. The application must have this package's `BunHttpAdapter`; with
any other the module throws a `TypeError` naming what it expected and what it
got.

### Sharing the server with gateways

The socket rides on the HTTP server by default, next to any
`@WebSocketGateway`. A gateway whose namespace is `"/*"` matches **every** path
below it, the socket's included, so the two overlap:

- **Connections this API upgrades are marked**, as
  `ws.data.custom.bunJobsApi === true`. The API ignores every connection
  without that mark — for messages *and* for close and drain bookkeeping — so a
  gateway's clients can neither drive a session nor move the API's counters or
  connection-cap slots.
- **A catch-all gateway still sees the API's connections**, and they arrive
  carrying the mark. That is the overlap's remaining half: filter on
  `client.data.custom?.bunJobsApi` in the gateway if it should ignore them.
- **`attach()` throws `ConfigError`** when a WebSocket route already covers the
  socket's path. Both are middleware on one router and whichever upgrades first
  ends the request, so a catch-all bound first would leave the socket
  permanently unreachable; the module reports it at bootstrap instead.
- **Order against `useWebSocketAdapter()` does not matter.** The serving
  `BunWebSocket` is resolved when a client upgrades, not when it is attached,
  so an adapter installed later is still the one that dispatches `open`,
  `message` and `close`.
- **Or avoid the overlap entirely** with `websocket: { port }`, which serves
  the socket on a server of its own.

### Installing bun-jobs is what makes the subpath compile

`@kingsleyweb/bun-jobs` is an *optional* peer, and this package ships raw `.ts`
(`main`/`types` point at `lib/index.ts`), so **a consumer compiles our source**
— which `skipLibCheck` cannot suppress, since these are our files, not
declaration files. Measured on a consumer project with the package installed
and bun-jobs absent:

| Import | `tsc --noEmit` |
|---|---|
| `@kingsleyweb/bun-nest` (the barrel) | **0 errors** |
| `@kingsleyweb/bun-nest/jobs` | **3 × `TS2307`**, "Cannot find module `@kingsleyweb/bun-jobs`" |
| `@kingsleyweb/bun-nest/lib/jobs` | the same 3 |

Installing `@kingsleyweb/bun-jobs` takes all three to 0. The import path itself
resolves either way — both `@kingsleyweb/bun-nest/jobs` and
`@kingsleyweb/bun-nest/lib/jobs` are exports of this package and resolve to
`lib/jobs/index.ts` — so the failure is the missing peer, not a bad specifier.
The barrel's 0 is the point of the split: an application that has no jobs
never compiles a line of this module, and nothing about the peer is really
required of it.

## Exported API

Everything below is exported from the package root; see
[`lib/index.ts`](./lib/index.ts). The one exception is
[the jobs API module](#the-jobs-api-module), which is exported **only** from
`@kingsleyweb/bun-nest/jobs` (equivalently `@kingsleyweb/bun-nest/lib/jobs`).

| Group | Exports |
|---|---|
| Jobs API module (subpath only) | `BunJobsApiModule`, `InjectJobsApi`, `BUN_JOBS_API`, `BUN_JOBS_API_OPTIONS`; types `BunJobsApiModuleOptions`, `BunJobsApiModuleAsyncOptions`, and bun-jobs's `JobsApi`, `JobsApiAction`, `JobsApiAuthorize`, `JobsApiConfig` re-exported so they can be named without importing bun-jobs directly |
| HTTP adapter | `BunHttpAdapter`, `BunNestHttpAdapter`; types `ListenCallback`, `MiddlewareFactoryRespType`, `RenderOptions`, `VersionedRoute`, `WebsocketOptions` |
| WebSocket adapter | `BunWebSocketAdapter`, `BunNestWebsocketAdapter`, `MessageEventTypes`; types `BunWebSocketAdapterOptions`, `BunWebSocketAdapterOptionsFromHttpAdapter`, `BunWebSocketAdapterNormalOptions`, `BunWebSocketGatewayOptions`, `BunWebsocketHttpAdapter`, `BunNestWebSocketClient`, `WsResponse`, `WsResponseTransform`, `WsAckFunction`, `WsEmitFunction`, `WsEventMap`, `WsEncodedArg`, `WsEncodedArgs` |
| Packets | types `MessageFormat`, `MessagePacket`, `MessagePacketMap`, `MessageConnectType`, `MessageDisConnectType`, `MessageEventType`, `MessageAckType`, `MessageErrorType`, `MessageBinaryEventType`, `MessageBinaryAckType` |
| Re-exported from bun-common | types `BunWebSocketOptions`, `BunWebSocketServerType`, `BunWebsocketHandlerFor`, `WebSocketClient`, `WebSocketClientData` |
| Uploads | `FileInterceptor`, `FilesInterceptor`, `FileFieldsInterceptor`, `AnyFilesInterceptor`, `NoFilesInterceptor`, `getMultipartRequest`, `transformUploadException`; type `UploadExceptionBody` |
| Decorators | `UploadedFile`, `UploadedFiles` (Nest's own) |

`BunRequest`, `BunResponse`, `UploadOptions`, `StorageFile`, `DiskStorage`,
`MemoryStorage`, `compression`, `validate` and the rest of the HTTP layer are
imported from `@kingsleyweb/bun-common`.

## Examples

The repository has one runnable example project per package:

| Project | What it covers |
|---|---|
| [`examples/bun-common`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-common) | The HTTP layer on its own: routing, the adapter, requests and responses, validation, CORS, static files, compression, multipart, WebSockets, logging, utilities, plus option tours |
| [`examples/bun-nest`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-nest) | NestJS on Bun: this package's HTTP adapter, upload interceptors and WebSocket adapter, plus option tours |
| [`examples/bun-jobs`](https://github.com/kingsloob1/bun-node/tree/develop/examples/bun-jobs) | Background work: queues, workers, scheduling, flow control, failures, the runner, every driver, integrations, plus option tours |

[`examples/README.md`](https://github.com/kingsloob1/bun-node/blob/develop/examples/README.md)
describes the conventions they share.

### bun-nest examples

| Folder | File | Shows |
|---|---|---|
| `01-quick-start` | [`index.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/01-quick-start/index.ts) | `NestFactory.create(AppModule, new BunHttpAdapter())`, a controller with params, query and body, `listen(0)`, `close()` |
| `02-http-adapter` | [`controllers-and-routing.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/controllers-and-routing.ts) | every HTTP method decorator, parameter decorators, `@HttpCode`, `@Header`, `@Redirect`, `StreamableFile`, `@Render`, raw response access |
| `02-http-adapter` | [`middleware-and-versioning.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/middleware-and-versioning.ts) | Nest middleware, a global prefix, every versioning type, `fetch()` without a socket |
| `02-http-adapter` | [`pipeline.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/pipeline.ts) | guards, pipes, exception filters and interceptors; not-found and error handlers |
| `02-http-adapter` | [`adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/adapter-options.ts) | adapter options, `enableCors`, static assets, body parsing and raw bodies, the logger, server introspection, `fetch()`, `close()` |
| `03-file-uploads` | [`interceptors.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/03-file-uploads/interceptors.ts) | every upload interceptor, `@UploadedFile(s)`, memory, disk and custom storage, upload errors, interceptor-side parsing |
| `04-websockets` | [`gateway-basics.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/04-websockets/gateway-basics.ts) | lifecycle hooks, `@MessageBody`, `@ConnectedSocket`, `WsResponse` vs a plain return, Promise and Observable replies, `@Ack` |
| `04-websockets` | [`message-formats.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/04-websockets/message-formats.ts) | every packet type on the wire, binary frames, malformed and unroutable frames, exceptions |
| `04-websockets` | [`adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/04-websockets/adapter-options.ts) | the `websocket` option, auth on upgrade, client data, namespaces, gateway ports, broadcasting, a standalone adapter |
| `04-websockets` | [`custom-adapter.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/04-websockets/custom-adapter.ts) | subclassing the adapter and wiring it with `app.useWebSocketAdapter` |
| `05-jobs-api` | [`module.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/05-jobs-api/module.ts) | `BunJobsApiModule.forRoot`, `@InjectJobsApi()`, authorized requests against the mounted API, and what `app.close()` closes |

**Option tours** exercise every option of one part of the API and assert the
result, so a failed check fails the script:

| File | Covers |
|---|---|
| [`10-options/http-adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/10-options/http-adapter-options.ts) | every `BunHttpAdapter` constructor option and public method, inside and outside a Nest application |
| [`10-options/interceptor-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/10-options/interceptor-options.ts) | every upload interceptor, its arguments, every `UploadOptions` field and `getMultipartRequest` |
| [`10-options/websocket-adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/10-options/websocket-adapter-options.ts) | every WebSocket adapter constructor shape, method, option and packet type |
| [`10-options/jobs-api-module-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/10-options/jobs-api-module-options.ts) | every `BunJobsApiModule` option, the `bunJobsApi` marker, registration order and attaching across an adapter swap |

To run them from a clone of the repository:

```bash
bun install                        # at the repo root
cd examples/bun-nest
bun 01-quick-start/index.ts        # one example
bun run-all.ts                     # every example; prints ok / skip / FAIL
bun run-all.ts 04 10               # only folders 04-* and 10-*
```

The applications listen on port `0`. See the
[bun-nest examples README](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/README.md).

## Related packages

- [`@kingsleyweb/bun-common`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/README.md):
  the Express-like HTTP layer this adapter is built on (`BunRouter`,
  `BunRequest`, `BunResponse`, validation, CORS, static files, compression,
  multipart, WebSockets, logging).
- [`@kingsleyweb/bun-jobs`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-jobs/README.md):
  background jobs, queues and scheduled runners for Bun.

## Development

This package lives in the
[bun-node monorepo](https://github.com/kingsloob1/bun-node). From a clone:

```bash
bun install                  # at the repo root
bun scripts/typecheck.ts     # every project in the repo
cd packages/bun-nest
bunx eslint .                # lint
bun test                     # tests
```

A change to bun-common also needs bun-nest's checks. The typed verb overloads
on `BunHttpAdapter` are generated; regenerate them from `packages/bun-common`
with `bun scripts/generate-verb-overloads.ts` rather than editing them.

## License

[MIT](https://choosealicense.com/licenses/mit/)
