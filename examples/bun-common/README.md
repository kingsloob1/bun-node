# `@kingsleyweb/bun-common` examples

Runnable examples for [`@kingsleyweb/bun-common`](../../packages/bun-common):
an Express-like HTTP layer for `Bun.serve` — `BunRouter` (Express 5
semantics), `BunHttpAdapter`, `BunRequest`/`BunResponse`, validation with any
Standard Schema, CORS, static files, multipart uploads, WebSockets, structured
logging, and the native helpers that replace a shelf of small npm packages.

Each file is a script. Its opening comment says what it shows and how to run
it; its output narrates what happened.

```bash
cd examples/bun-common
bun 01-quick-start/index.ts        # start here
bun run-all.ts                     # every example; prints ok / skip / FAIL
bun run-all.ts 02 12               # only folders 02-* and 12-*
```

No install step: the examples use the workspace package through the repo's
root `node_modules`. The validation examples use zod, yup, valibot, arktype and
superstruct, which the workspace already has. Servers always listen on port
`0`, and most examples use `router.fetch()` — the production request pipeline
with no socket at all.

## The examples

### 01 — Quick start

| File | Shows |
|---|---|
| [`index.ts`](./01-quick-start/index.ts) | a small API: routes, JSON body, params, error and not-found handlers, served on port 0, exercised, closed |

### 02 — Routing

| File | Shows |
|---|---|
| [`verbs-and-params.ts`](./02-routing/verbs-and-params.ts) | every verb method, `all`/`any`/`add`/`addRoute`, every param form, route ordering and `setRouteSpecificity` |
| [`middleware-and-errors.ts`](./02-routing/middleware-and-errors.ts) | Express 5 pipeline: `use()` prefix matching vs exact routes, `useMethod`, the four ways into error mode, recovering with `next()`, `next('route')`, `next('router')` |
| [`sub-routers.ts`](./02-routing/sub-routers.ts) | mounting routers, typed mount params, a validator at the mount, compile-time mount mismatches, `group`, `domain` |
| [`typed-routes.ts`](./02-routing/typed-routes.ts) | `req.params`/`query`/`body` inferred from the path and a validator; `ExtractRouteParams`, `TypedRouteHandler` |
| [`fetch-testing.ts`](./02-routing/fetch-testing.ts) | every `fetch()` input form, router vs adapter `fetch`, parity with a served request |
| [`route-cache.ts`](./02-routing/route-cache.ts) | the route cache and `routeCacheMax`, named routes, `RouteClass`, `routeModulePath`, `toNativeRequest` |

### 03 — The HTTP adapter

| File | Shows |
|---|---|
| [`listen-and-close.ts`](./03-http-adapter/listen-and-close.ts) | every `listen()` overload, address getters, events, `setListenOptions`, `close()` |
| [`adapter-options.ts`](./03-http-adapter/adapter-options.ts) | every constructor option: `requestTimeout`, `request`, `websocket`, `logger`, `router`, `etag`, `routeCacheMax`, `server` |
| [`handlers.ts`](./03-http-adapter/handlers.ts) | not-found and error handlers, `enableCors`, `useStaticAssets`, body parsers, `setRequestOpts`, `setLogger`, `setTimeout` |

### 04 — The request

| File | Shows |
|---|---|
| [`reading-a-request.ts`](./04-request/reading-a-request.ts) | every request property: url parts, params, query parsing options, headers, ip/host/protocol, freshness, ranges, content negotiation |
| [`body-parsing.ts`](./04-request/body-parsing.ts) | every body-parsing option: JSON, text, urlencoded, raw, XML, custom content-type parsers, size limits, `PayloadTooLargeError`, compressed bodies and decompression bombs, `inflate: false` (415) and `decompressionFastPathLimit` set on the adapter's `parseBody`, raw bodies |
| [`cookies.ts`](./04-request/cookies.ts) | parsing cookies, signed cookies and secrets, JSON cookies |

### 05 — The response

| File | Shows |
|---|---|
| [`sending.ts`](./05-response/sending.ts) | status, every body type for `send`, `json`/`jsonp`, headers (`Set-Cookie` read back as an array, as Node), `location`, `links`, `vary`, ETags, `format()` negotiation, attachments |
| [`files-and-streams.ts`](./05-response/files-and-streams.ts) | `sendFile` with every option and byte ranges, streaming responses, server-sent events, redirects |
| [`cookies-and-caching.ts`](./05-response/cookies-and-caching.ts) | `cookie()`/`clearCookie()` with every option, signed cookies, cache headers, 304s |

### 06 — Validation

| File | Shows |
|---|---|
| [`validate-requests.ts`](./06-validation/validate-requests.ts) | every validation target and failure mode, hooks, chained validators, `ValidationError` and issue paths |
| [`schema-libraries.ts`](./06-validation/schema-libraries.ts) | the same schema in zod, yup, valibot and arktype directly, superstruct through `toStandardSchema` |
| [`typed-handlers.ts`](./06-validation/typed-handlers.ts) | the handler's `req.query`/`req.body` typed by the validator; `InferValidatedShape`, typed mounts |

### 07 — CORS, static files and compression

| File | Shows |
|---|---|
| [`cors.ts`](./07-cors-and-static/cors.ts) | every `CorsOptions` field, preflight vs simple requests, a `CorsOptionsDelegate` |
| [`serve-static.ts`](./07-cors-and-static/serve-static.ts) | `createServeStaticHandler` with every option against a fixture folder, precompressed `.br`/`.gz` siblings and on-the-fly compression, byte ranges over a real socket |
| [`compression.ts`](./07-cors-and-static/compression.ts) | `compression()`: `Accept-Encoding` negotiation with q-values and `*`, what is left alone, options, server-sent events flushed through the compressor, precompressed static files, `dcb`/`dcz` dictionaries |

### 08 — Multipart uploads

| File | Shows |
|---|---|
| [`single-and-multiple.ts`](./08-multipart/single-and-multiple.ts) | the single, multiple, fields, any and no-files handlers; `uploadFieldsToMap`; nested and repeated fields |
| [`storage.ts`](./08-multipart/storage.ts) | memory storage, disk storage with every option, a custom `Storage`, `removeStorageFiles` |
| [`limits-and-filters.ts`](./08-multipart/limits-and-filters.ts) | `DEFAULT_UPLOAD_OPTIONS`, `transformUploadOptions`, `getBusBoyConfig`, filters, size and count limits, 413s, `UploadError` codes |

### 09 — WebSockets

| File | Shows |
|---|---|
| [`echo-and-events.ts`](./09-websocket/echo-and-events.ts) | upgrading through the adapter, every event handler, client data, text and binary, ping/pong, backpressure, close codes |
| [`rooms-and-broadcast.ts`](./09-websocket/rooms-and-broadcast.ts) | auth on upgrade, rooms as pub/sub topics, `ws.publish` vs `server.publish`, broadcasting, server stats |
| [`options.ts`](./09-websocket/options.ts) | every WebSocket option, `customDataToWsClientFn`, a standalone server, an extra port |

### 10 — Logging

| File | Shows |
|---|---|
| [`structured-logger.ts`](./10-logging/structured-logger.ts) | `createLogger` with every option, the six levels, `child`, `isLevelEnabled`, errors lifted onto the record |
| [`sinks.ts`](./10-logging/sinks.ts) | `consoleSink` pretty and JSON, `multiSink`, `collectSink`, a custom sink, `noopLogger`, `createTestLogger` |
| [`adapters.ts`](./10-logging/adapters.ts) | pino, bunyan, winston, consola, log4js, tslog, NestJS and console loggers adapted; `resolveLogger` detection |

### 11 — Utilities

| File | Shows |
|---|---|
| [`objects-and-collections.ts`](./11-utilities/objects-and-collections.ts) | the type guards, `get`/`set`/`merge`/`pick`/`omit`/`orderBy`/…, `cloneDeep` vs `jsonClone` |
| [`http-helpers.ts`](./11-utilities/http-helpers.ts) | `etag`, `fresh`, ranges, `vary`, `encodeUrl`, dates and byte sizes, every cookie helper, `accepts`, `typeIs`, `mime` |
| [`async-control.ts`](./11-utilities/async-control.ts) | `sleep`, `withTimeout`, `waitUntil`, `createDeferred`, `retry` and `computeBackoff`, `Mutex`, `Semaphore`, `getPort` |
| [`errors-xml-files.ts`](./11-utilities/errors-xml-files.ts) | serializing errors, parsing XML, random bytes, unique filenames, streams to buffers |

### 12 — Option tours

The examples above *show* behaviour. A tour **asserts** it: each sets every
option of one part of the API and checks what happens with
[`shared/check.ts`](./shared/check.ts). A failed check prints what was expected
and what happened and fails the script, so `bun run-all.ts 12` is a test of
every option.

| File | Covers |
|---|---|
| [`router-options.ts`](./12-options/router-options.ts) | every `BunRouter` option and public method |
| [`http-adapter-options.ts`](./12-options/http-adapter-options.ts) | every `BunHttpAdapter` option and public method |
| [`request-options.ts`](./12-options/request-options.ts) | every request property, body-parsing and query option |
| [`response-options.ts`](./12-options/response-options.ts) | every response method and option |
| [`validate-options.ts`](./12-options/validate-options.ts) | every validation option, execution order, `ValidationError`, `toStandardSchema` |
| [`cors-options.ts`](./12-options/cors-options.ts) | every CORS field and value form, delegates, `enableCors` |
| [`static-options.ts`](./12-options/static-options.ts) | every static-file option, caching, 304s, traversal, ranges, `precompressed` and `compression` |
| [`compression-options.ts`](./12-options/compression-options.ts) | every `compression()` option, negotiation with q-values and wildcards, `dcb`/`dcz` dictionaries, `res.flush()` |
| [`multipart-options.ts`](./12-options/multipart-options.ts) | every upload option, handler errors as `UploadError` codes and statuses, filters, storage options, busboy limits |
| [`websocket-options.ts`](./12-options/websocket-options.ts) | every WebSocket option, event and emitter method |
| [`logging-options.ts`](./12-options/logging-options.ts) | every logger option, sink and adapter mapping |
| [`native-utilities.ts`](./12-options/native-utilities.ts) | every exported helper, with its options and edge cases |

## Checking the examples

```bash
bun scripts/typecheck.ts        # from the repo root — includes examples/bun-common
cd examples/bun-common
bunx eslint .                   # the package's lint rules, minus no-console
bun run-all.ts                  # run them all
```
