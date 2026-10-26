# `@kingsleyweb/bun-nest` examples

Runnable examples for [`@kingsleyweb/bun-nest`](../../packages/bun-nest):
NestJS on Bun. `BunHttpAdapter` runs a Nest application on `Bun.serve` through
[`@kingsleyweb/bun-common`](../bun-common)'s router; the file interceptors
bring multer-style uploads; `BunWebSocketAdapter` runs `@WebSocketGateway`s on
Bun's native WebSockets.

Each file is a script that builds a Nest application, exercises it and closes
it. Its opening comment says what it shows and how to run it.

```bash
cd examples/bun-nest
bun 01-quick-start/index.ts        # start here
bun run-all.ts                     # every example; prints ok / skip / FAIL
bun run-all.ts 04 10               # only folders 04-* and 10-*
```

No install step: `@nestjs/core`, `@nestjs/common`, `@nestjs/websockets`,
`reflect-metadata`, `rxjs`, `zod`, `yup`, `@nestjs/microservices` (for `07-validation`),
`@nestjs/swagger` (for `08-openapi`) and — for the `@kingsleyweb/bun-nest/jobs`
examples — `@kingsleyweb/bun-jobs` and `@kingsleyweb/bun-jobs-ui` resolve from the repo's root `node_modules`
(`@nestjs/platform-express` resolves from there too; only
`03-file-uploads/module-options.ts` imports it, to show its `MulterModule`
feeding bun-nest's interceptors). The legacy
decorator options Nest relies on come from the repo's `tsconfig.base.json`.
Applications listen on port `0`.

## The examples

### 01 — Quick start

| File | Shows |
|---|---|
| [`index.ts`](./01-quick-start/index.ts) | `NestFactory.create(AppModule, new BunHttpAdapter())`, a controller with params, query and body, `listen(0)`, `close()` |

### 02 — The HTTP adapter

| File | Shows |
|---|---|
| [`controllers-and-routing.ts`](./02-http-adapter/controllers-and-routing.ts) | every HTTP method decorator (`@QueryMethod()` is in `query-method.ts`), parameter decorators, Express 5 paths (an optional `{/:month}` group, a four-digit validation pipe where a `\d{4}` regexp used to be, a named wildcard as an array, a legacy `:year(\d{4})/:month?` path failing `app.init()` with a `PathSyntaxError`), `@HttpCode`, `@Header`, `@Redirect` and its Express body, `StreamableFile`, `@Render` through a registered engine, raw response access, `@Sse()` served and through `adapter.fetch()`, a client hanging up, an `@Sse()` route failing before its first event (a 500), and a quiet `@Sse()` stream outliving `idleTimeout` |
| [`query-method.ts`](./02-http-adapter/query-method.ts) | HTTP `QUERY` (RFC 10008), asserted: `adapter.query(path, handler)` on every Nest, its body parsed as a `POST`'s, `GET`/`HEAD`/`POST` on it a 404; from Nest 11.2.0, `@QueryMethod(path?)` answering `QUERY` only, with `@Param`/`@Query`/`@Body`, a guard, an interceptor, pipes and an exception filter, `forRoutes({ path, method: RequestMethod.QUERY })` middleware, and `@All()`. Below Nest 11.2.0 those checks sit out on a `skipped:` line naming the version. See the package README's [Adapter methods](../../packages/bun-nest/README.md#adapter-methods-and-properties) |
| [`middleware-and-versioning.ts`](./02-http-adapter/middleware-and-versioning.ts) | Nest middleware, a global prefix, every versioning type; asserted for `MEDIA_TYPE`: a version in the first parameter on every Nest, in any parameter of any media range on Nest 12 (`text/html, application/json;charset=utf-8;v=2`), and a quoted `v="2"` unquoted from Nest 12.2.0, each gated on a core capability, with a `skipped:` line and the older answer checked where it sits out. See the package README's [Versioning](../../packages/bun-nest/README.md#versioning) |
| [`middleware-matching.ts`](./02-http-adapter/middleware-matching.ts) | which requests a middleware runs for, asserted: `getRouteMatchingOptions()` (case-insensitive by default, a trailing slash ignored); `exclude("users/login")` also skipping `/users/LOGIN` and `/users/login/` and `exclude("invoices/{*path}")` skipping `/invoices/7`; from Nest 12.2.0, which reads the adapter's report, `/invoices/` running the middleware, `router: { caseSensitive: true }` running it on `/users/LOGIN`, and an adapter reporting exact matching for contrast; `forRoutes("*")` under a global prefix running once for `/api`, `/api/` and below on every Nest; the core's `/api$` entry alone serving `/api/` only on 12.2.0. Gated on the core's behaviour, never a version string, with `skipped:` lines naming the version |
| [`route-options.ts`](./02-http-adapter/route-options.ts) | Nest 12's `routeResolutionStrategy` and `routeConflictPolicy`, asserted: `"declaration"` (`/users/:id` declared first takes `/users/me`, `*path` takes `/files/readme`) against `"specificity"` (literal, then parameter, then wildcard; a tie such as `@All()` before `@Get()` keeping declaration order), bun-common's `router: { routeSpecificity: true }` ranking differently; `duplicate` and `shadow` at `"off"`, `"warn"` (one warning each, the first route winning) and `"error"` (`app.init()` rejecting with one `RouteConflictException` listing every conflict), and a shadow the sort resolves not reported. On Nest 11, which ignores both options, it checks that they change nothing and prints a `skipped:` line. See the package README's [NestJS 12](../../packages/bun-nest/README.md#nestjs-12) |
| [`security.ts`](./02-http-adapter/security.ts) | asserted: from Nest 12.1, `useSecurityHeaders()` and `enableCsrfProtection()`'s `403` carrying the security headers, CORS and an earlier middleware's header, answered before the body is read (a malformed or oversized body gets the `403`, not `400`/`413`), served and through `adapter.fetch()`, and `request: { deferBody: false }` reading the body first again (below 12.1 those checks sit out on a `skipped:` line); on every Nest, a middleware's `next(err)` and a body the body parser refused answered on the response CORS and the middleware marked, and a `StreamableFile` whose source fails before its first byte answered by Nest's `errorHandler` (`400`) or a `setErrorHandler()`. See the package README's [Security headers and CSRF protection](../../packages/bun-nest/README.md#security-headers-and-csrf-protection) |
| [`shutdown.ts`](./02-http-adapter/shutdown.ts) | asserted: `app.close()` draining a slow request while a new one gets `return503OnClosing`'s `503`, `Connection: close` (Nest 12, which calls `beforeClose()`; on Nest 11 a `skipped:` line and its `200` checked), the hooks' requests answered without the option, `forceCloseConnections: true` cutting the request in flight, `adapter.beforeClose()` by hand and `listen()` again clearing it, `listen()` rejecting a port out of range with a `RangeError`, and a unix socket path (`http+unix://` URL, `address()` the path or an `AddressInfo`, the socket file removed). See the package README's [`listen()` and `close()`](../../packages/bun-nest/README.md#listen-and-close) |
| [`responses.ts`](./02-http-adapter/responses.ts) | asserted, served: an `HttpException` with status `0` or `NaN` (Nest 12 applies it and answers `500`; Nest 11 skips it, gated on a core capability), a `StreamableFile`'s source destroyed when the client leaves mid-download or before the handler returned it, and a handler that `write()`s then throws ending its stream with what was written. See the package README's [Responses](../../packages/bun-nest/README.md#responses-redirect-streamablefile-render) |
| [`hooks.ts`](./02-http-adapter/hooks.ts) | asserted: `setOnRequestHook` running before middleware and routes, `done(error)` reaching Nest's exception layer; `setOnResponseHook` seeing a route's, Nest's 404, a middleware error's and a refused body's status; `addBeforeWriteHook`'s `phase`, `status` and `body.kind`, a throw refusing a redirect with Nest's `500` that keeps CORS but not `Location`, phase `"error"`, and its remover. See the package README's [Instrumentation hooks and response checks](../../packages/bun-nest/README.md#instrumentation-hooks-and-response-checks) |
| [`pipeline.ts`](./02-http-adapter/pipeline.ts) | guards, pipes (built-in ones, a global one, and bun-nest's `StandardSchemaPipe` over a `toStandardSchema` function, its 400 answered by the app's `HttpException` filter), exception filters and interceptors on Bun; error and not-found handlers. Validation in full is in [`07-validation`](#07--validation) |
| [`adapter-options.ts`](./02-http-adapter/adapter-options.ts) | adapter options, `enableCors`, static assets, body parsing and raw bodies, the logger, `fetch()` without a socket (asserted: `adapter.fetch(new Request(url, { signal }))` rejected with the abort's reason while a controller is still working), `close()` |
| [`express-parity.ts`](./02-http-adapter/express-parity.ts) | Express 5 parity from a Nest app: `@Get()` answering `HEAD`, `MiddlewareConsumer` middleware calling `next()` from a timer or I/O callback, the request timeout (a middleware that never calls `next()`, an `async` controller method that never settles), and `server.routes` native routes ahead of Nest; async Nest middleware and controllers, an `@Sse()` stream's first event arriving early, `rawBody` unset on a GET and exact on a POST (a served-shaped JSON POST included), and without `rawBody` the body still parsed with no bytes kept; redirect bodies by `Accept` (plain, HTML, empty) with `Vary: Accept`, `Content-Length` and a percent-encoded `Location`, `res.redirect(301, url)` beside `res.redirect(url, 301)`, `@Controller({ host })` with a port, the bare static prefix's 301, `clearCookie()` expiring at the epoch, invalid JSON's 400 body; and four deliberate differences from Express (no default `ETag`, `text/plain` strings, a nested `req.query`, a `.tsx` view with no engine), each tied to the package README's [Known differences](../../packages/bun-nest/README.md#known-differences-from-nestjsplatform-express) |
| [`views.ts`](./02-http-adapter/views.ts) | `@Render()` and `res.render()` with a view engine: `setBaseViewsDir`, `setViewEngine`, `engine(ext, fn)`, `setLocal`, `set("views" \| "view engine")`; `<name>.<ext>` and `<name>/index.<ext>` lookups; locals merged app → `res.locals` → handler; a `status` local not setting the code; `HEAD`; a missing view, no engine, and an extension nothing renders, each Nest's 500. See the package README's [Views](../../packages/bun-nest/README.md#views-render-and-resrender) |
| [`undecodable-bodies.ts`](./02-http-adapter/undecodable-bodies.ts) | a JSON body that does not parse: refused before any guard with Nest's 400 by default; with the adapter's `router: { acceptUndecodableBody: true }` the guard runs first (403) and the controller reads `req.bodyDecodingError` through `@Req()` to answer its own 400, served and through `adapter.fetch()`; a bun-common `BunRouter` built with the option and mounted with `adapter.use()` authorizing first while a controller beside it is still refused; an over-cap body still a 413 before the guard. See the package README's [Error handling](../../packages/bun-nest/README.md#error-handling) |
| [`per-route-parsing.ts`](./02-http-adapter/per-route-parsing.ts) | `consumer.apply(requestParsing({ ... })).forRoutes(...)` for query, cookie and body parsing per route; raising one route's body cap with the adapter's `deferBody` and `bodyParser: false`, and what happens without either; invalid JSON answered 400 by Nest's default body parser, with `deferBody`, and served. See the package README's [Per-route parsing with `requestParsing()`](../../packages/bun-nest/README.md#per-route-parsing-with-requestparsing) |

### 03 — File uploads

| File | Shows |
|---|---|
| [`interceptors.ts`](./03-file-uploads/interceptors.ts) | `FileInterceptor`, `FilesInterceptor`, `FileFieldsInterceptor`, `AnyFilesInterceptor`, `NoFilesInterceptor`, `@UploadedFile(s)`, memory and disk storage, multer-style options with no `storageType` (`{ dest }` is disk, `{ limits }` memory, its `fileSize` a 413 once the interceptor parses), upload errors, a disk file `ParseFilePipe` refuses removed from Nest 12.2.0 (kept before it, and kept on every Nest when the handler throws), `detectFileType: false` in the adapter's multipart opts leaving `validatedMimeType` unset |
| [`module-options.ts`](./03-file-uploads/module-options.ts) | `MulterModule.register()` and `registerAsync()` (`useFactory` with `inject`, `useClass`, `useExisting`) from `@kingsleyweb/bun-nest`, and platform-express's own `MulterModule` providing the same `MULTER_MODULE_OPTIONS` token, asserted by where each upload lands: the module's `{ dest }` with no `storageType`, the route's options winning, a module `storageType: "custom"` storage, a route's `dest` replacing it from Nest 12.2.0 (the module's storage winning before), and a storage without `storageType` failing the bootstrap. See the package README's [Module-level options](../../packages/bun-nest/README.md#module-level-options-multermodule) |
| [`removal-errors.ts`](./03-file-uploads/removal-errors.ts) | a `"custom"` storage whose `removeFile` rejects, behind `FileInterceptor`, asserted: the handler's status and body arrive before the removal settles; the failure logged through `app.useLogger()` as `error("Removing an upload's stored files failed", <stack>)` with the context `BunFileInterceptor`; no `unhandledRejection`, and later requests still served, over the socket and through `adapter.fetch()`. See the package README's [File upload interceptors](../../packages/bun-nest/README.md#file-upload-interceptors) |

### 04 — WebSockets

| File | Shows |
|---|---|
| [`gateway-basics.ts`](./04-websockets/gateway-basics.ts) | lifecycle hooks, `@MessageBody`, `@ConnectedSocket`, `WsResponse` vs a plain return, Promise and Observable replies, `@Ack` |
| [`message-formats.ts`](./04-websockets/message-formats.ts) | every packet type on the wire, binary frames, malformed and unroutable frames, exceptions |
| [`adapter-options.ts`](./04-websockets/adapter-options.ts) | the `websocket` option and `onUpgrade`, auth on upgrade, headers and data on the 101, client data, namespaces, gateway ports, broadcasting, a standalone adapter |
| [`custom-adapter.ts`](./04-websockets/custom-adapter.ts) | subclassing the adapter and wiring it with `app.useWebSocketAdapter` |
| [`validated-gateway.ts`](./04-websockets/validated-gateway.ts) | `@ValidateMessage` (payload + ack), `@Emits` (checked, typed emits), `TypedSocket`, the `VALIDATION` exception frame |

### 05 — The jobs API module

| File | Shows |
|---|---|
| [`module.ts`](./05-jobs-api/module.ts) | `BunJobsApiModule.forRoot` from `@kingsleyweb/bun-nest/jobs`, `@InjectJobsApi()`, authorized requests against the mounted routes, and what `app.close()` closes |

### 06 — The jobs UI

| File | Shows |
|---|---|
| [`mount.ts`](./06-jobs-ui/mount.ts) | `jobsUi()` from `@kingsleyweb/bun-jobs-ui` over the API `BunJobsApiModule` built (`app.get(BUN_JOBS_API)`), mounted with `adapter.use()` (no cast) and served with and without a socket, a page `authorize` sharing the API's session, and what a global prefix does not touch. More in [`../bun-jobs-ui`](../bun-jobs-ui) |

### 07 — OpenAPI

| File | Shows |
|---|---|
| [`swagger-module.ts`](./08-openapi/swagger-module.ts) | `@nestjs/swagger` on `BunHttpAdapter`, asserted: a DTO-class `@Body()` and `@ApiResponse()` scanned into the document, `SwaggerModule.setup("api", …)` answering the JSON document, the UI page with and without the trailing slash and the UI's own bundled assets over a real socket, a mutating route beside the docs, and the controls (an adapter-registered route served but undocumented, a changed `DocumentBuilder` title visible). Skips with a `skipped:` line where `@nestjs/swagger` is not installed. See the package README's [OpenAPI with `@nestjs/swagger`](../../packages/bun-nest/README.md#openapi-with-nestjsswagger) |

### 09 — AsyncAPI

| File | Shows |
|---|---|
| [`gateway-docs.ts`](./09-asyncapi/gateway-docs.ts) | `gatewayAsyncApi(app)` end to end: a booted app's gateways discovered from their Nest metadata (path + namespace → the channel, a `@WebSocketGateway(port)` → its server), every documented payload the socket.io `EVENT` envelope with the `@ValidateMessage` schema at `data[1]` (an undecorated handler documenting `{}` — the control), the declared `ack` as the `reply`'s ACK packet, the `@Emits` map and the fixed CONNECT/DISCONNECT/ERROR/exception frames as the send operations, and the document served through bun-common's `docsRouter` with the AsyncAPI viewer page. Skips with a `skipped:` line where `@nestjs/websockets` or zod is not installed |

### 07 — Validation

| File | Shows |
|---|---|
| [`standard-validation.ts`](./07-validation/standard-validation.ts) | BunValidate's Nest pipes and filter, asserted: `StandardValidationModule` registering the global `StandardValidationPipe` and `ValidationExceptionFilter`; a `SchemaDto` body reaching the handler as the schema's output (`z.coerce.number()` a `number`, `z.coerce.date()` a `Date`, not a class instance); `StandardSchemaPipe` on `@Query("page")` and `@Param("id")` (issues `{ target, message, path }` naming the part and prefixed with the key); the filter's `{ error, issues }` over HTTP, invalid JSON keeping Nest's 400; prototype-pollution keys stripped before a yup schema runs (`stripProtoKeys`: by default Nest 12's rule, `__proto__` and `prototype` gone, and `"minimal"` keeping the `prototype` field), where yup would otherwise answer 500; in a gateway, `@UseFilters(ValidationExceptionFilter)`'s `exception` event `{ status, code: "VALIDATION", issues }` and Nest's `Internal server error` without it, `@UsePipes(...StandardValidationModule.gatewayPipes())` for a `SchemaDto` message (`[]` on Nest 12, where global pipes reach gateways, the pipe's class on Nest 11), checking it once on both, so a type-changing schema hands the handler a `Date`, and a plain `@UsePipes(StandardValidationPipe)` as the pitfall (on Nest 12 the schema runs twice and refuses every such message); with no filter, Nest's own 400 body and an app filter reading `.issues`; `forRoot({ messages: "generic" })` wording the global pipe's issues and a gateway's under `gatewayPipes()` on both majors, not a `StandardSchemaPipe`'s, and a bad option a `TypeError`; in a TCP microservice (port 0, no broker), a refused `SchemaDto` payload failing the client's `send()` with `{ status: "error", statusCode: 400, code: "VALIDATION", message, issues }`; on Nest 12, its own `@Body({ schema })` and `StandardSchemaValidationPipe` beside ours (a `skipped:` line on Nest 11). See the package README's [Validation](../../packages/bun-nest/README.md#validation) |

### 10 — Option tours

The examples above *show* behaviour. A tour **asserts** it: each exercises
every option of one part of the API and checks what happens with
[`shared/check.ts`](./shared/check.ts). A failed check fails the script, so
`bun run-all.ts 10` is a test of every option.

| File | Covers |
|---|---|
| [`http-adapter-options.ts`](./10-options/http-adapter-options.ts) | every `BunHttpAdapter` method and option inside a Nest application, including the view methods (`setBaseViewsDir`, `setViewEngine`, `engine`, `setLocal`, `set`/`enable`/`disable`, `render` with a `status` local), `redirect()`'s body, `parseQuery`/`parseCookies` options, `router.caseSensitive` (`false` by default, as on platform-express; `true` opting in to exact case), `server.routes`, and `etag: "weak"` overruled per route from a controller (`@Res({ passthrough: true }) res.setEtag(false)`, `res.etag = "strong"`), a JSON body and a 413 answered alike served and through `fetch()`, a bad `parseBody` coding failing at construction, `closeDrainTimeout` (a bad value a `RangeError` at construction, the 10 s default waiting for a request in flight, `0` cutting it, a 1.5 s cap cutting one that never ends), `setRequestOpts()` and `requestParsing()` before Nest starts, and `router: { acceptUndecodableBody: true }` routing bad JSON (left unset, a 400 before routing) |
| [`interceptor-options.ts`](./10-options/interceptor-options.ts) | every file interceptor and its options; `MulterModule.register({ limits: { files: 1, fileSize: 1000 } })` under a route's `fileSize: 8` (the route's 413, the module's `files` kept on Nest 12 and replaced on 11), and `mergeUploadOptions()` itself |
| [`websocket-adapter-options.ts`](./10-options/websocket-adapter-options.ts) | every WebSocket adapter method, option and message type; flow control as platform-ws 12.2.0: `maxConcurrentMessages` (the rest wait in order, the client unread meanwhile), `maxSendBufferSize` (a client reading none of a flood terminated) and the `backpressureLimit` it sets; a throwing exception filter's `ERROR` packet; on Nest 12.2.0, an exception resent without an unserialisable `cause` |
| [`jobs-api-module-options.ts`](./10-options/jobs-api-module-options.ts) | every `BunJobsApiModule` option, a malformed JSON body (the API asks `authorize`, then answers its own 400 `INVALID_JSON` or 403; a controller beside it keeps Nest's 400), and the rules for sharing a server between its live-events socket and a gateway |

## Checking the examples

```bash
bun scripts/typecheck.ts        # from the repo root — includes examples/bun-nest
cd examples/bun-nest
bun run lint                    # the package's lint rules, minus no-console
bun run format:check            # bun fmt --check
bun run-all.ts                  # run them all
```
