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
| [`verbs-and-params.ts`](./02-routing/verbs-and-params.ts) | every verb method, `query()` for HTTP `QUERY` (a JSON or text body beside `req.query`, a typed `:index`, the method matched in any case, no `GET`/`HEAD` fallback either way), `all`/`any`/`add`/`addRoute`, every param form (a named wildcard a `string[]` under its name only while a bare `*` keeps `0`, an optional wildcard that matched nothing leaving its key absent, `{…}` groups, `:from-:to` split greedy-first, the routejs forms still registering), a malformed path throwing `PathSyntaxError` at registration, route ordering and `setRouteSpecificity`, `HEAD` answered by the GET handler (served and through `fetch()`, a HEAD handler registered first winning), `toFetchResponse` and `markSocketFree` (no HEAD body, the wire's implicit text `Content-Type`) |
| [`middleware-and-errors.ts`](./02-routing/middleware-and-errors.ts) | Express 5 pipeline: `use()` prefix matching vs exact routes, `useMethod`, the four ways into error mode, `next(object)` reaching the error handler as that same object while `next("text")` is wrapped in an `Error`, recovering with `next()`, `next('route')`, `next('router')`, `next()` called later from a timer or I/O callback, the request timeout (an async handler that never settles included), errors after the response started (`headersSent`, ending the stream from an error handler, an unhandled one cutting it off once what was written has gone out), `res.write()` then `next()`/a later `next(err)` moving on, an async handler that responds and keeps awaiting (its late rejection logged) |
| [`sub-routers.ts`](./02-routing/sub-routers.ts) | mounting routers, typed mount params, a validator at the mount, compile-time mount mismatches, `group`, `domain` |
| [`typed-routes.ts`](./02-routing/typed-routes.ts) | `req.params`/`query`/`body` inferred from the path and a validator (a named wildcard typed `string[]`, with no `params[0]`); `ExtractRouteParams`, `TypedRouteHandler` |
| [`fetch-testing.ts`](./02-routing/fetch-testing.ts) | every `fetch()` input form, router vs adapter `fetch`, parity with a served request, a `//x/y` path served and socket-free |
| [`fetch-aborts.ts`](./02-routing/fetch-aborts.ts) | the caller leaving, asserted served and through `router.fetch()`: a slow stream whose client cancels the body or aborts its fetch, the handler seeing `req.signal` abort with Bun's "The connection was closed." and `res` and `req.socket` emit `close`; `req.request.signal` the caller's own (a cancelled body does not abort it) where served the two are one; a `RequestInit` signal aborted already rejecting with its reason before any handler runs; an abort while a handler waits rejecting the call, through a `RequestInit` and a `Request`'s own signal. See the package README's [Testing without a socket](../../packages/bun-common/README.md#testing-without-a-socket) |
| [`serving-async.ts`](./02-routing/serving-async.ts) | an asynchronous pipeline served and through `adapter.fetch()`: async middleware chains, a response sent before its handler finishes, `res.send(); next(err)` in one tick, a late rejection logged, a stream returned as it opens, the request timeout (`setTimeout()`), an overridden `handle()`, `res.locals` per request; `router.serveRequest()` with custom `ServeHooks` |
| [`route-cache.ts`](./02-routing/route-cache.ts) | the route cache and `routeCacheMax`, named routes, `RouteClass`, `routeModulePath`, `toNativeRequest` (and `//` paths), a 1,000-route table with high-cardinality ids and a tiny or no cache, `routeIndex`, GET and POST on one cached path, `getMatchedLayers({ requestPath })` |
| [`define-routes.ts`](./02-routing/define-routes.ts) | `defineRoutes()`: a route group declared as data, mounted as an ordinary sub-router; property names landing as `operationId`s in the generated document (a statement route's derived name, for contrast); `RoutesOf` reading the flat route map at compile time |
| [`synchronous-dispatch.ts`](./02-routing/synchronous-dispatch.ts) | `BunRequest.init()` returning the request itself without a body, `dispatch()` returning synchronously until a layer is async, `handle()` always a promise, the pipeline `timeout` and `isRequestTimeoutError`, and why code driving `handle()` itself must end every layer with `next()` or a finished response (a stream only once it ends) |

### 03 — The HTTP adapter

| File | Shows |
|---|---|
| [`listen-and-close.ts`](./03-http-adapter/listen-and-close.ts) | every `listen()` overload, address getters, events, `setListenOptions`, `close()` |
| [`shutdown.ts`](./03-http-adapter/shutdown.ts) | `close()` draining: a slow request finishing during `close()`, answered in full; `closeDrainTimeout: 0` cutting it at once; an endless SSE stream holding `close()` for a 300 ms cap, then cut; a stream ended during `close()` delivered whole; an open WebSocket not waited for; `drainAndStop()` and `validateCloseDrainTimeout()` draining a plain `Bun.serve`; a bad `closeDrainTimeout` a `RangeError` at construction |
| [`adapter-options.ts`](./03-http-adapter/adapter-options.ts) | every constructor option: `requestTimeout`, `request`, `websocket`, `logger`, `router`, `etag`, `routeCacheMax`, `closeDrainTimeout`, `server`, and `server.routes` — native static routes over a real socket, with their caveats |
| [`handlers.ts`](./03-http-adapter/handlers.ts) | not-found and error handlers, `enableCors`, `useStaticAssets` (the bare prefix redirected to it with a slash), body parsers, `setRequestOpts`, `setLogger`, `setTimeout` |

### 04 — The request

| File | Shows |
|---|---|
| [`reading-a-request.ts`](./04-request/reading-a-request.ts) | every request property: url parts, params, query parsing options, headers, ip/host/protocol, freshness, ranges, content negotiation |
| [`body-parsing.ts`](./04-request/body-parsing.ts) | every body-parsing option: JSON, text, urlencoded, raw, XML, custom content-type parsers, size limits, `PayloadTooLargeError`, compressed bodies and decompression bombs, `inflate: false` (415) and `decompressionFastPathLimit` set on the adapter's `parseBody`, raw bodies, per-request option setters that leave the adapter's options alone, body-parser middleware passing a request without a body (`req.hasBody`) straight on, a declared empty body (`Content-Length: 0`, no stream) parsed as `{}`, and with a refused encoding a POST refused before routing while a GET is routed and answered by `next(err)` only when read, bytes kept by default and dropped with `retainBuffer: false` — a JSON body read with `request.json()` (no `req.buffer` or `req.rawBody`, `end` only, no `err.body`), text, urlencoded and xml with `request.text()`, raw always kept; globally, through `requestParsing({ retainBuffer })`, or per kind with `contentTypes.<kind>.retainBuffer`; a capped body without bytes served but with them through `adapter.fetch()`, the one-read body path checked served against `adapter.fetch()` (JSON, `+json`, urlencoded, latin1 text, gzip, corrupt gzip 400, invalid JSON 400, a declared or chunked over-cap body 413, an understated `Content-Length` 413, `data`/`end` events), 4xx logged at `warn` and 5xx at `error` with `err.req` non-enumerable, invalid JSON as body-parser's 400 (a `SyntaxError`, `entity.parse.failed`, `err.body`, `req.bodyDecodingError`) reaching `setErrorHandler` before routing, answered with the adapter's HTML error page without one, or `next(err)` with `deferBody` + `requestParsing()`, while a bare router's `fetch()` routes it with `req.body` unset and the refusal on `req.bodyDecodingError`; on the adapter, served and through `adapter.fetch()`, a router built with `acceptUndecodableBody: true` and a route with the `acceptUndecodableBody()` marker routed bad JSON (400), a corrupt gzip stream (400) and an unsupported `Content-Encoding` (415) the same way, while a route beside them keeps the early refusal and an over-cap body is still a 413 before routing; an invalid size or decoding option failing where it is configured (constructor, `setRequestOpts()` keeping its old options, `requestParsing()`) and `validateParseBodyOption()` |
| [`undecodable-bodies.ts`](./04-request/undecodable-bodies.ts) | which route decides whether the adapter routes a body it could not decode (`acceptUndecodableBody`): middleware ahead of an opted-in route authorizing first (403, or the route's own 400) while the same router without the option is refused before `authorize` runs; nested mounts, where the innermost router that sets it wins (an opted-in router inside one left unset or `false`, an unset one inheriting, `false` refusing inside an opted-in one); the `acceptUndecodableBody()` marker winning over its router's `false`; the first matching route handler deciding; and with no route handler, the most deeply mounted middleware, or the adapter's own setting. See the package README's [Testing without a socket](../../packages/bun-common/README.md#testing-without-a-socket) |
| [`per-route-parsing.ts`](./04-request/per-route-parsing.ts) | `requestParsing()` per route — `parseQuery` (picoquery options), `parseCookies` (`{ secret, decode }`) and `parseBody`, errors through `next(err)`, `TypeError` on bad options; the adapter's `deferBody` letting a route raise its body cap; `hasDeferredBody`, `readDeferredBody()`, `applyParseBodyOptions()`, `setCookieOptions()`, `configuredCookieSecrets`. See the package README's [Per-route parsing](../../packages/bun-common/README.md#per-route-parsing-requestparsing) |
| [`cookies.ts`](./04-request/cookies.ts) | parsing cookies, signed cookies and secrets (`request: { parseCookies: { secret } }`), JSON cookies; parsing on first touch (a route that never reads them never decodes), assigning one half, `parseCookies({ secret })` leaving the request's own |

### 05 — The response

| File | Shows |
|---|---|
| [`sending.ts`](./05-response/sending.ts) | status, every body type for `send`, `json`/`jsonp`, headers (`Set-Cookie` read back as an array, as Node), `location`, `links`, `vary`, ETags, `format()` negotiation, attachments |
| [`files-and-streams.ts`](./05-response/files-and-streams.ts) | `sendFile` with every option and byte ranges, streaming responses, server-sent events, Express 5's `redirect([status,] url)` (a body chosen by `Accept`, `Vary`, `Content-Length`, an encoded `Location`, earlier headers kept, HEAD without a body) beside Bun's `ResponseInit` form, a stream's first chunk sent before its async handler resolves, a stream outliving the request timeout, which quiet streams `idleTimeout` cuts (`req.socket.setTimeout(0)` and `write()` exempt one), an error before the first event answered 500 despite `setKeepAlive(true)`, `isStreamOpen`/`writableEnded`/`onceStreamEnded()`, `awaitPipelineOrStream()` |
| [`cookies-and-caching.ts`](./05-response/cookies-and-caching.ts) | `cookie()`/`clearCookie()` with every option (`clearCookie()` expiring at the epoch and dropping a `maxAge`, as Express 5), signed cookies, cache headers, 304s; every `etag` mode (`true`, `"weak"`, `"strong"`, a function, `false`) on the adapter, overruled per response with `res.setEtag()`/`res.etag`, a hand-set `ETag` winning, `sendFile()`'s weak tag, weak/strong `If-None-Match` 304 round-trips, the `TypeError` for an invalid option |
| [`cache-control.ts`](./05-response/cache-control.ts) | `cacheControl()`, `formatCacheControl()` and `parseCacheControl()`: the three common policies (lifetimes in seconds), the quoted `private="…"`/`no-cache="…"` forms, the two contradictions (`public` with `private`, `noStore` with a lifetime) as `@ts-expect-error` lines and run-time throws, `RangeError` for a bad lifetime, `surrogateControl`, a handler overriding the middleware's header, `noTransform` keeping `compression()` off a body; `res.addResponseTransform(t, { first: true })` seeing the text before `compression()` where a later one sees gzip; parsing a response and a request header, the 2^31 cap, duplicates, malformed arguments and extensions |
| [`views.ts`](./05-response/views.ts) | `res.render()` on a `BunHttpAdapter` given `views`: a registered engine, `<name>.<ext>` and `<name>/index.<ext>` lookup, a default engine, locals merged `views.locals` → `res.locals` → the render's own, the callback form (HTML or error, nothing sent), HEAD with the rendered length, a missing view to `next(err)`, no default engine, `.nope` and a module without `__express` (Express's lookup), a script extension refused; what a plain router's default views give; one `BunViews` shared, view cache on, by a served request, `adapter.fetch()`, `setErrorHandler` and `router.fetch()`, the template read once and found from the cache after it is removed; `views.render()` with no response |

### 06 — Validation

| File | Shows |
|---|---|
| [`validate-requests.ts`](./06-validation/validate-requests.ts) | every validation target and failure mode, hooks, chained validators, `ValidationError` and issue paths |
| [`schema-libraries.ts`](./06-validation/schema-libraries.ts) | the same schema in zod, yup, valibot and arktype directly, superstruct through `toStandardSchema` |
| [`typed-handlers.ts`](./06-validation/typed-handlers.ts) | the handler's `req.query`/`req.body` typed by the validator; `InferValidatedShape`, typed mounts |
| [`contract-sharing.ts`](./06-validation/contract-sharing.ts) | one contract shared by a server and a client: `getContract()` on a `validate()` middleware (its HTTP contract, the very schemas, under `CONTRACT`), a client in [`modules/posts-client.ts`](./06-validation/modules/posts-client.ts) importing only `@kingsleyweb/bun-common/contract` and bundled for a browser with no server module in it (the root entry as the control), `createSender` refusing a bad request before it is sent and `createReceiver` parsing each reply by status (a `Date` back from its string, a reply outside the contract caught, an undeclared status), `documented()`, `describeContract` rows, `mergeContracts` (outermost inbound wins and logs the refinement, innermost outbound wins, a checking schema beats a documented one, `origin` on every row), `forwardContract` through a wrapping middleware. See the package README's [Contracts](../../packages/bun-common/README.md#contracts) |
| [`custom-transport.ts`](./06-validation/custom-transport.ts) | a transport of your own with `defineTransport`: chat over UDP on port 0, one JSON datagram per message keyed by `type`; the server's receiver parsing and its sender checking replies, the client's sender and receiver, error frames for a bad payload, an undeclared type and a non-JSON datagram, `checksKey`, `onIssues` per failing message, `attachContract`/`getContract`, declaration `TypeError`s, the `"warn"` and `"off"` policies. See [Writing a transport](../../packages/bun-common/README.md#writing-a-transport) |
| [`message-scrub.ts`](./06-validation/message-scrub.ts) | issues never carry the received value: yup's, valibot's, arktype's and zod's quoting messages answered as `Invalid value (<code>)` by `validate()` (each library's own message shown quoting it first), a message quoting nothing kept; a message compared with the value at its path (another field holding a quoted word, or a key beside it named one, does not withhold it; yup's `noUnknown()` message, at the root or nested, compared with the keys of the value it reports on, is withheld; a refine naming a key withheld unless it reports at that key's `path`); `messages: "generic"` and `redactPaths` on `validateStandard` and a guard (and `validate()`'s 400 taking the same); a `ContractError`'s message |
| [`message-options.ts`](./06-validation/message-options.ts) | `validate()`'s `messages: "generic"` and `redactPaths: true`: a `z.record(z.email(), …)` 400 as is (the path the sender's address), redacted, generic and both; `formatError` given the worded issues and `error.message`, `"next"` and `"throw"` too; yup's harmless message replaced (`Invalid value`, no code); the same validator's `responses` refusing with a worded `ResponseValidationError` and a worded `"warn"` line (`createTestLogger`); a mount's and a route's `redactPaths`, the stricter holding either way round; `"Generic"` or `"yes"` a `TypeError` at build. See the package README's [Validation](../../packages/bun-common/README.md#validation) |
| [`synchronous-validation.ts`](./06-validation/synchronous-validation.ts) | `validate()` answering synchronously when every schema does (zod, valibot, arktype): `next()` already called, or `next(err)`, when the middleware returns; a yup schema making it a Promise; `validateStandard` and the guards following the same rule |
| [`cookies-and-headers.ts`](./06-validation/cookies-and-headers.ts) | the `cookies` and `signedCookies` targets (written back coerced; a correctly signed cookie passed, a forged, wrong-secret or tampered one refused while a `cookies` schema lets a forgery through; `{}` with `parseCookies: false`), a coerced header typed on `req.valid.headers` with `req.headers` left raw, `req.valid` holding every part, the six targets' order |
| [`response-checks.ts`](./06-validation/response-checks.ts) | `responses` checked at runtime: `responseValidation` `"off"` sending a bad body, `"warn"` sending it and logging one line with no value from it (`createTestLogger`), `"error"` refusing it with a `ResponseValidationError` (500) to the error handler, `router.fetch()` rejecting and the adapter answering 500 without one; an undeclared status; a wrong JSON body's issues by path; a header and a `Set-Cookie` checked as a `SetCookieView` (`maxAge` in seconds); wildcard media keys (`text/plain` over `text/*` over `*/*`, parameters ignored, tied keys a `TypeError`); `commonResponses` merged with a route's per status and part; precedence validator → router → adapter; a refusal dropping its own `Location`, `Set-Cookie`, `ETag` and `Content-*` while CORS and `Vary` stay; a freshness 304 allowed undeclared, HEAD checked as GET; an error handler's own response only reported. See the package README's [Responses](../../packages/bun-common/README.md#responses) |
| [`typed-responses.ts`](./06-validation/typed-responses.ts) | a typed `res`: `res.status(201).json(user)` compiles and is sent, while a wrong body for a declared status and an undeclared status are `@ts-expect-error` lines the examples' type check holds (and the runtime check refuses too) |
| [`streaming-responses.ts`](./06-validation/streaming-responses.ts) | streamed responses checked as they stream, through `router.fetch()` and over a socket: `chunks(Row, { framing: "ndjson" })` checking each line (one split across writes), a bad later line cutting the stream off (the client reads the good lines, then an error: a `ResponseValidationError` from `router.fetch()`, a dropped connection over a socket) and logged once at error (`createTestLogger`); `sse({ tick, done: null })` passing declared events, an undeclared name (and an unnamed `message`) a mismatch, bad data located at `body.tick.data.n`, the stream stopping at the bad event, `data: "text"` against `"json"`; a `write()` stream's bad first chunk a clean 500; a piped stream's bad first chunk resetting the socket with no response (an erroring body through `router.fetch()`); `"warn"` logging once per stream; a whole-body schema against a stream skipped with one warning per route (Q-H4); `sendFile()` bytes read under a whole-body schema (good file, bad file, a 206 range; unread under `opaque()`); `opaque()` and `opaque("image/png")` answering alike, leaving a Blob unread, with the same `describeContract` rows; a media type mapped to `null`. See the package README's [Streamed bodies](../../packages/bun-common/README.md#streamed-bodies-chunks-sse-and-opaque) |
| [`response-variants.ts`](./06-validation/response-variants.ts) | one status, several whole responses with `variants()`: an admin and a user variant of a 200 chosen by an auth `when` reading `req.user` (set by a middleware), no fallback when neither applies, a body no variant takes answered with a summary and each variant's issues (`variant` on each); the leak, a loose `z.object()` user view accepting the admin body (sent, `salary` and all) and a `z.strictObject()` refusing it with `The response matches variant "admin", which does not apply to this request`; `res.variant()` filling an `x-view` discriminant and a literal header and stripping `salary` (the handler's object untouched, the changes logged at debug as paths and counts), its `when` still enforced; an async `when` awaited at the commit; an undeclared discriminant value, an undeclared variant name and a discriminant disagreeing with `res.variant()`, each refused and each a `@ts-expect-error` line; `refine` on a variant, on `variants()` and on a plain status (a value-quoting message withheld); `res.variant()` adjusting under `"off"`; a streamed variant checked per chunk against the survivors and cut off when none is left; `describeContract`'s variant rows and `sides.outbound.variants`; `createSender`/`createReceiver` refusing a variants status with a `TypeError`. See the package README's [Response variants](../../packages/bun-common/README.md#response-variants-variants-and-resvariant) |

### 07 — CORS, static files and compression

| File | Shows |
|---|---|
| [`cors.ts`](./07-cors-and-static/cors.ts) | every `CorsOptions` field, preflight vs simple requests, `QUERY` left out of the default `methods`, a `CorsOptionsDelegate` |
| [`serve-static.ts`](./07-cors-and-static/serve-static.ts) | `createServeStaticHandler` with every option against a fixture folder, precompressed `.br`/`.gz` siblings and on-the-fly compression, byte ranges over a real socket |
| [`compression.ts`](./07-cors-and-static/compression.ts) | `compression()`: `Accept-Encoding` negotiation with q-values and `*`, what is left alone, options, server-sent events flushed through the compressor, precompressed static files, `dcb`/`dcz` dictionaries |

### 08 — Multipart uploads

| File | Shows |
|---|---|
| [`single-and-multiple.ts`](./08-multipart/single-and-multiple.ts) | the single, multiple, fields, any and no-files handlers; `uploadFieldsToMap`; nested and repeated fields |
| [`storage.ts`](./08-multipart/storage.ts) | memory storage, disk storage with every option, a file part sent with no filename, a custom `Storage`, `removeStorageFiles` |
| [`limits-and-filters.ts`](./08-multipart/limits-and-filters.ts) | `DEFAULT_UPLOAD_OPTIONS`, `transformUploadOptions`, `getBusBoyConfig`, filters, size and count limits, 413s, `UploadError` codes |

### 09 — WebSockets

| File | Shows |
|---|---|
| [`echo-and-events.ts`](./09-websocket/echo-and-events.ts) | upgrading through the adapter, every event handler, client data, text and binary, ping/pong, backpressure, close codes |
| [`rooms-and-broadcast.ts`](./09-websocket/rooms-and-broadcast.ts) | auth on upgrade, rooms as pub/sub topics, `ws.publish` vs `server.publish`, broadcasting, server stats |
| [`options.ts`](./09-websocket/options.ts) | every WebSocket option, `onUpgrade`, a standalone server, an extra port |

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
| [`router-options.ts`](./12-options/router-options.ts) | every `BunRouter` option and public method, including the `views` option and property, a bare router's own default views and a mounted sub-router rendering with the views of the router serving it; `acceptUndecodableBody` (unset by default, `false`, `true` and the `acceptUndecodableBody()` marker) as `routesUndecodableBody(req)` answers it, and `fetch()` routing the body whatever the option says |
| [`http-adapter-options.ts`](./12-options/http-adapter-options.ts) | every `BunHttpAdapter` option and public method, including each `etag` mode and `normalizeEtagOption`; the `views` option and the view helpers (`setBaseViewsDir`, `setViewEngine`, `engine`, `setLocal`, `set`, `enable`, `disable`); the Nest-shaped helpers as platform-express's: `redirect` with Express's body, `render` through `views` with a `status` local that sets nothing, `getRequestHostname` without the port; `useStaticAssets` redirecting the bare prefix; `closeDrainTimeout`'s `RangeError`s, its default wait and `0`; `router: { acceptUndecodableBody: true }` routing bad JSON to the adapter's routes, served and through `fetch()`, and a path nothing matches answered 404 rather than 400 |
| [`request-options.ts`](./12-options/request-options.ts) | every request property, body-parsing, query and cookie option: `parseQuery` and `parseCookies` as `boolean` or options (`{ secret, decode }`), and the deprecated `parseQueryOpts`/`cookieParseOptions`/`cookieSecret` still honoured, with the object form winning |
| [`response-options.ts`](./12-options/response-options.ts) | every response method and option, among them `redirect()` in Express 5's forms and bodies, `clearCookie()` dropping `maxAge` and `render()` through the `views` option or a default `BunViews`; `res.etag`/`setEtag(option)` in every form; the default `text/plain;charset=utf-8` and `application/json;charset=utf-8` types, a type set before `json()` kept with its charset made `utf-8` (`application/problem+json; charset=utf-8`, and `format()`'s `application/json; charset=utf-8`), and text/JSON sent with no header built without a Headers object yet carrying the type served, on HEAD and through `adapter.fetch()` (Bun behaviour: [docs/bun-bugs](../../docs/bun-bugs/README.md)) |
| [`validate-options.ts`](./12-options/validate-options.ts) | every validation option (an option set to `undefined` keeps its default), the six targets' execution order, an unknown target throwing a `TypeError` that lists them, `messages` and `redactPaths` on a `ValidationError`'s issues, the implicit status a `"respond"` validator puts on its contract, `ValidationError`, `toStandardSchema` |
| [`cors-options.ts`](./12-options/cors-options.ts) | every CORS field and value form, delegates, `enableCors` |
| [`static-options.ts`](./12-options/static-options.ts) | every static-file option, caching, 304s, traversal, ranges, `precompressed` and `compression`; the bare prefix (`/static`) redirected to `/static/` when the handler is mounted with `use()`, unmatched by a `${prefix}/*` route alone (`useStaticAssets` adds a route on the prefix itself) |
| [`compression-options.ts`](./12-options/compression-options.ts) | every `compression()` option, negotiation with q-values and wildcards, `dcb`/`dcz` dictionaries, `res.flush()` |
| [`multipart-options.ts`](./12-options/multipart-options.ts) | every upload option, handler errors as `UploadError` codes and statuses, filters, storage options, busboy limits, `detectFileType` on and off in the adapter's multipart opts, served and through `fetch()` |
| [`websocket-options.ts`](./12-options/websocket-options.ts) | every WebSocket option, event and emitter method; `onUpgrade` and the router- and response-level upgrade values; `removeRouteHandler`: a removed route's upgrade going on to the next route or a 404, one of two handlers removed, open sockets left open |
| [`logging-options.ts`](./12-options/logging-options.ts) | every logger option, sink and adapter mapping |
| [`native-utilities.ts`](./12-options/native-utilities.ts) | every exported helper, with its options and edge cases |

### 13 — API docs

A validated router documents itself: `listRoutes()` lists each endpoint's
effective contract and `toJsonSchema()` converts every row's schema;
`.describe()` adds the prose and `generateOpenApi()` builds the document.

| File | Covers |
|---|---|
| [`from-validators.ts`](./13-api-docs/from-validators.ts) | `listRoutes()` + `toJsonSchema()` end to end: request rows converted with `input` (a defaulted field not `required`), a response under `responseOutput: "parsed"` converted with `output`, `documented()` and `withJsonSchema` escape hatches, `liftComponents()` lifting `$defs` into components. See the package README's [Converting a schema to JSON Schema](../../packages/bun-common/README.md#converting-a-schema-to-json-schema-tojsonschema) |
| [`annotating-routes.ts`](./13-api-docs/annotating-routes.ts) | `.describe()` + `generateOpenApi()` end to end: prose on a validated route, an inline `request` (documents without enforcing) on an unvalidated one, a raw-JSON-Schema body, `hidden`, an optional `:a?` param as two paths, strict vs lenient, and the document served from a route |
| [`serving-and-viewing.ts`](./13-api-docs/serving-and-viewing.ts) | `docsRouter()` end to end: the OpenAPI and AsyncAPI JSON served (a thunk re-read per request, so a late-registered route appears), the viewer pages opted into with `viewer` (`{ name: "swagger-ui", docExpansion }` pass-through shown; `"scalar"` is the OpenAPI default, `"asyncapi"` the AsyncAPI one), the lockdown CSP with its per-request nonce, the document URL resolved under the mount, every docs route `hidden` from a later `generateOpenApi`, and the no-`viewer` control |
| [`class-dtos.ts`](./13-api-docs/class-dtos.ts) | `useClassDtos()` + a class-validator DTO on `query`: `"42"` → `42` by implicit conversion, the failing request's 400 issues, and the DTO's schema in the generated document through the injected `toJsonSchema`. Skips visibly when the libraries are absent; the `experimentalDecorators` requirement is printed. See the package README's [Class DTOs](../../packages/bun-common/README.md#class-dtos-useclassdtos) |
| [`asyncapi-channels.ts`](./13-api-docs/asyncapi-channels.ts) | `defineChannel()` + `generateAsyncApi()` end to end: a channel documenting itself (the upgrade's params as `x-bun-common-schema`, the messages in their `{ type, id?, data }` envelope, the `reply` link, the implicit error frame, the meta as the `x-bun-common-*` extensions), its SSE fallback a channel of its own, a bare `ws()` route's honest stub enriched by `describeChannel()`, and the document served through `docsRouter`'s `asyncapi` with the official viewer page |

## Checking the examples

```bash
bun scripts/typecheck.ts        # from the repo root — includes examples/bun-common
cd examples/bun-common
bun run lint                    # the package's lint rules, minus no-console
bun run format:check            # bun fmt --check
bun run-all.ts                  # run them all
```
