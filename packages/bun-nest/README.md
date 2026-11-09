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
| `@nestjs/cache-manager`'s `CacheModule` and `CACHE_MANAGER` | [`BunCacheModule`](#the-cache-module) and `@InjectCache()`, over `@kingsleyweb/bun-cache`, with `@Cacheable`, `@CachePut` and `@CacheEvict` for service methods |
| `@nestjs/cache-manager`'s `CacheInterceptor`, `@CacheKey()`, `@CacheTTL()` | [`BunCacheInterceptor`](#the-cache-interceptor), with `@CacheKey`, `@CacheTTL`, `@CacheTags` and `@NoCache` (it reads cache-manager's `@CacheKey()`/`@CacheTTL()` too) |

**Requirements**

- **Bun ≥ 1.4.2** (`engines.bun`). Bun runs the shipped TypeScript source
  (`main` is `lib/index.ts`), so there is no build step on your side; your
  type checker reads the built declarations in `dts/` (`types`), so your
  compiler options never apply to this package's source.
- **NestJS 11.1.20 or later, or NestJS 12**: the peers `@nestjs/common` and
  `@nestjs/core` (`^11.1.20 || ^12.0.0`) and `rxjs` (`^7.1.0`) are required;
  `@nestjs/websockets` (the same range) is needed only for gateways. One
  build serves both majors, and both are tested: the repo runs on Nest 12
  (12.2.0), and its suites, examples and consumer type checks also run on
  the latest 11 and 12 and on the floors, 11.1.20 and 12.0.0 (see
  [Compatibility](#compatibility-nest-11-and-12)). The floor is 11.1.20 because
  older 11 releases miss what this package is built on: `@Ack()` (`Ack`,
  `isAckHandledManually`) arrived in 11.1.7, the CORS delegate types this
  adapter implements in 11.1.14, and before 11.1.20 an `@Sse()` observable
  that errors before its first event answers `200` instead of `500`.
- The usual NestJS compiler options: `experimentalDecorators` and
  `emitDecoratorMetadata`, with `reflect-metadata` loaded.

## Table of contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [NestJS 12](#nestjs-12)
  - [Upgrading from Nest 11](#upgrading-from-nest-11)
  - [Compatibility: Nest 11 and 12](#compatibility-nest-11-and-12)
- [`BunHttpAdapter`](#bunhttpadapter)
  - [Adapter options](#adapter-options)
  - [Adapter methods and properties](#adapter-methods-and-properties)
  - [Routing and typed routes](#routing-and-typed-routes)
    - [Mounting a bun-common router](#mounting-a-bun-common-router)
  - [Nest middleware](#nest-middleware)
  - [Responses: `@Redirect`, `StreamableFile`, `@Render`](#responses-redirect-streamablefile-render)
  - [Versioning](#versioning)
  - [CORS](#cors)
  - [Security headers and CSRF protection](#security-headers-and-csrf-protection)
  - [Static assets](#static-assets)
  - [Body parsing and raw bodies](#body-parsing-and-raw-bodies)
  - [Per-route parsing with `requestParsing()`](#per-route-parsing-with-requestparsing)
  - [Response compression](#response-compression)
  - [Error handling](#error-handling)
  - [Instrumentation hooks and response checks](#instrumentation-hooks-and-response-checks)
  - [Client IP behind proxies](#client-ip-behind-proxies-trust-proxy)
  - [Testing with `fetch()`](#testing-with-fetch)
  - [`listen()` and `close()`](#listen-and-close)
  - [Known differences from `@nestjs/platform-express`](#known-differences-from-nestjsplatform-express)
- [File upload interceptors](#file-upload-interceptors)
  - [Interceptors](#interceptors)
  - [Upload options and storages](#upload-options-and-storages)
  - [Module-level options (`MulterModule`)](#module-level-options-multermodule)
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
  - [Validated gateways](#validated-gateways-validatemessage-emits-typedsocket)
  - [Flow control](#flow-control)
  - [The `websocket` option](#the-websocket-option)
    - [Headers and data on the 101](#headers-and-data-on-the-101)
  - [Authentication on upgrade](#authentication-on-upgrade)
  - [Standalone and custom adapters](#standalone-and-custom-adapters)
  - [Closing](#closing)
- [Validation](#validation)
  - [`@Validate`](#validate)
  - [`StandardSchemaPipe`](#standardschemapipe)
  - [`SchemaDto` and `StandardValidationPipe`](#schemadto-and-standardvalidationpipe)
  - [`ValidationExceptionFilter`](#validationexceptionfilter)
  - [`StandardValidationModule`](#standardvalidationmodule)
  - [Issues carry no received value](#issues-carry-no-received-value)
- [OpenAPI with `@nestjs/swagger`](#openapi-with-nestjsswagger)
- [Typed clients: documents from controllers](#typed-clients-documents-from-controllers)
  - [`@Describe`](#describe)
  - [`DevTypesModule`: the dev type sync](#devtypesmodule-the-dev-type-sync)
  - [`@Invalidates`: live invalidation](#invalidates-live-invalidation)
- [Jobs: `BunJobsModule`](#jobs-bunjobsmodule)
  - [The context: `forRoot` and `forRootAsync`](#the-context-forroot-and-forrootasync)
  - [Queues: `registerQueue` and `@InjectQueue`](#queues-registerqueue-and-injectqueue)
  - [Typed queues: `@QueueToken`](#typed-queues-queuetoken)
  - [Several contexts in one application](#several-contexts-in-one-application)
  - [Workers: `@Processor` and `@Process`](#workers-processor-and-process)
  - [The Nest pipeline around a job](#the-nest-pipeline-around-a-job)
  - [Parameter decorators](#parameter-decorators)
  - [Validating job data](#validating-job-data)
  - [How a job ends: guards, filters and pipes](#how-a-job-ends-guards-filters-and-pipes)
  - [Typed handlers](#typed-handlers)
  - [Request-scoped processors](#request-scoped-processors)
  - [Files and other threads: `registerWorker`](#files-and-other-threads-registerworker)
  - [The registry: `@DefineJob`](#the-registry-definejob)
  - [Events](#events)
  - [Scheduling: `@Cron` and `@Every`](#scheduling-cron-and-every)
  - [Runners: `registerRunner`](#runners-registerrunner)
  - [Starting and draining](#starting-and-draining)
  - [The checks at boot](#the-checks-at-boot)
- [The jobs API module](#the-jobs-api-module)
  - [Mounting, injection and shutdown](#mounting-injection-and-shutdown)
  - [Sharing the server with gateways](#sharing-the-server-with-gateways)
  - [Installing bun-jobs is what makes the subpath compile](#installing-bun-jobs-is-what-makes-the-subpath-compile)
- [The cache module](#the-cache-module)
  - [Modules, names and shutdown](#modules-names-and-shutdown)
  - [`@Cacheable`, `@CachePut`, `@CacheEvict`](#cacheable-cacheput-cacheevict)
  - [The cache interceptor](#the-cache-interceptor)
  - [Installing bun-cache is what makes the subpath compile](#installing-bun-cache-is-what-makes-the-subpath-compile)
- [Throttling](#throttling)
  - [Module options](#module-options)
  - [`@Throttle()` and `@SkipThrottle()`](#throttle-and-skipthrottle)
  - [The guard](#the-guard)
  - [A shared store](#a-shared-store)
  - [Migrating from `@nestjs/throttler`](#migrating-from-nestjsthrottler)
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
[`BunJobsModule`](#jobs-bunjobsmodule) and
[the jobs API module](#the-jobs-api-module) import it, and installing it is
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
await app.close(); // lets in-flight requests finish (at most 10 s), then stops the server
```

`app.listen(0)` asks the OS for a free port; `app.getUrl()` reports it. See
[`01-quick-start/index.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/01-quick-start/index.ts).

## NestJS 12

One build runs on Nest 11 (from 11.1.20) and Nest 12. Your code never names
the major. Where a Nest release changed what an adapter must do, the adapter
checks the installed `@nestjs/core` or `@nestjs/common` for the method, export
or enum member that release added, never a version string, and answers as
`@nestjs/platform-express` does on that release.

### Upgrading from Nest 11

What changes for an application on this adapter when it moves to Nest 12:

- **Unknown paths outside the global prefix get Express's HTML 404.** With
  `app.setGlobalPrefix("api")`, Nest 12's not-found handler answers only at
  or under `/api`, and on the paths of the routes excluded from the prefix.
  `GET /nope` gets the bare `Cannot GET /nope` page (`text/html`), not Nest's
  JSON 404, because platform-express 12 answers so. Without a global prefix,
  nothing changes. See [Error handling](#error-handling).
- **The adapter maps errors raised outside a route.** Nest 12 moved this
  mapping from its core into each adapter, as `mapException`. An unparsable
  JSON body (`SyntaxError`) and an undecodable path parameter (`URIError`)
  stay a `400` with Nest's JSON body, as on 11. Any other error passes
  through unchanged.
- **WebSocket exceptions keep this adapter's packet format.** Nest 12's
  exception filter writes platform-ws's `{ event, data }` frame to a native
  socket. For this adapter's own clients, the frame goes through the
  client's `emit` instead, so a thrown `WsException` still arrives as
  `EVENT ["exception", …]`. See [Exceptions](#exceptions).
- **`handleDisconnect(client, reason)` receives the close code**, as on
  platform-ws (`4001` after `socket.close(4001, "bye")`), although Nest types
  it `string`. Nest 11 calls `handleDisconnect(client)`. See
  [Standalone and custom adapters](#standalone-and-custom-adapters).
- **`routeResolutionStrategy` and `routeConflictPolicy` work as on Express.**
  They are the core's options, given to `NestFactory.create()`; the adapter
  only reports `isRouteOrderSensitive()` as `true`, as platform-express does.
  So under `"specificity"`, Nest sorts the routes and the router keeps that
  order, and conflicts give the same warnings and `RouteConflictException`.
  Use Nest's option rather than `router: { routeSpecificity: true }`, which
  ranks differently
  ([known differences](#known-differences-from-nestjsplatform-express)).
- **A falsy status is applied.** On Nest 12, `0` or `NaN` reaches Express 5's
  `res.status` check and Nest answers `500`; Nest 11 skips it. See
  [Responses](#responses-redirect-streamablefile-render).
- **`MEDIA_TYPE` versioning finds the version in any parameter of any media
  range**, and from 12.2.0 unquotes a quoted version. See
  [Versioning](#versioning).
- **`MulterModule`'s `limits` merge key by key** with an interceptor's, where
  Nest 11 replaces them whole. See
  [Module-level options](#module-level-options-multermodule).
- **New on Nest 12:** `return503OnClosing` (see
  [`listen()` and `close()`](#listen-and-close)) and, from 12.1,
  `app.useSecurityHeaders()` and `app.enableCsrfProtection()` (see
  [Security headers and CSRF protection](#security-headers-and-csrf-protection)).
- **From Nest 12.2.0**, a route's `dest` replaces the module's storage
  ([Module-level options](#module-level-options-multermodule)), and, **as from
  11.2.8 on Nest 11**, `exclude()` follows the router's trailing-slash and case
  settings ([Nest middleware](#nest-middleware)), files are removed when a pipe
  rejects the request ([Interceptors](#interceptors)), and a WebSocket
  exception whose `cause` cannot be serialised is sent again without it
  ([Exceptions](#exceptions)).

Two features arrived in **11.2.0**, not 12, and work on 11.2 and 12 alike:

- **`QUERY`**: `@QueryMethod()` and
  `forRoutes({ method: RequestMethod.QUERY })` (see
  [`query`](#adapter-methods-and-properties)).
- **`@SseSignal()`**: an `@Sse()` handler's `AbortSignal` aborts when the
  client goes, during async setup or mid-stream, served or through
  `adapter.fetch()`, as on Express.

Routing follows Express 5 on both majors, so the
[path rules](#routing-and-typed-routes) hold on 11 too: a path Express
rejects (`:id?`, `:id(\d+)`) fails `app.init()`, named wildcards are
`string[]`, routing is case-insensitive by default, and `@HostParam()` keeps
the `Host` header's case.

### Compatibility: Nest 11 and 12

The peers are `^11.1.20 || ^12.0.0`. `scripts/nest-matrix.ts` runs each
column below in a copy of the repo pinned to that Nest: bun-nest's suite
(the Express, routing and platform-ws differentials included), `bun --check`,
the `examples/bun-nest` programs, bun-ui's jobs Nest test and the consumer
type check.

| Nest | Express | Tested |
|---|---|---|
| 12.2.0 (the repo's lock) | 5.3.0 | every gate |
| 12.4.1 (12-latest) | 5.3.0 | every PR touching bun-nest or bun-common |
| 11.2.7 | 5.2.1 | every PR touching bun-nest or bun-common |
| 11.2.9 (11-latest) | 5.2.1 | every PR touching bun-nest or bun-common |
| 11.1.20 (the floor) | 5.2.1 | once per merge window |
| 12.0.0 (12's floor) | 5.2.1 | once per merge window |
| 12.1.3 (the lock before 12.2.0), 12.3.0, 12.3.3, 12.4.0 | 5.2.1 (12.1.3), 5.3.0 | an extra column |

11.2.8 backported behaviours of 12.2 and 12.3 to Nest 11: the cells of the 11.2
column below say which.

The floor is 11.1.20: older 11 releases lack `@Ack()` (11.1.7) and the CORS
delegate types (11.1.14), and before 11.1.20 an `@Sse()` observable that
errors before its first event answers `200`, not `500`.

What differs by release, and what the adapter reads to tell:

| Behaviour | 11.1 | 11.2 | 12.0–12.1 | 12.2–12.4 | Read from |
|---|---|---|---|---|---|
| `QUERY`, `@QueryMethod()` | no | yes | yes | yes | `RequestMethod.QUERY` |
| `@SseSignal()` | no | yes | yes | yes | — |
| 404 outside the prefix | Nest's JSON | Nest's JSON | HTML | HTML | `mapException` (1) |
| Errors outside a route mapped by | the core | the core | the adapter | the adapter | — |
| A falsy status | skipped | skipped | applied | applied | `mapException` (1) |
| `MEDIA_TYPE` version | 1st parameter | 1st parameter | any parameter | any, unquoted | (1), `isRejectedByPipes` (2) |
| `MulterModule` `limits` | replaced | replaced | merged | merged | `mapException` (1) |
| A route's `dest` | module wins | module wins | module wins | route wins | `isRejectedByPipes` (2) |
| Files removed on a pipe's rejection | no | yes from 11.2.8 | no | yes | `isRejectedByPipes` (5) |
| `exclude()` matching | Nest's | Nest's, the router's from 11.2.8 | Nest's | the router's | — |
| A middleware two of one entry's paths match runs | twice | twice, once from 11.2.8 | twice | once | the core's `registerHandler` (3) |
| A middleware on a route of two versions, on one path, runs | per version | per version | per version | per version, once from 12.3.0 | — |
| A returned `Error`, status 400 or more | its properties | its properties | its properties | its properties, the status alone from 12.3.0 | (1), `getHttpErrorMessage` (4) |
| `http-errors` client errors (an over-limit body) reach `@Catch(HttpException)` | no | no | no | from 12.3.0 | (1), `getHttpErrorMessage` (4) |
| A WS exception whose `cause` cannot be serialised | dropped | sent without it from 11.2.8 | an `ERROR` packet | sent without it | `emitErrorPayload` on Nest's filter |
| A `StreamableFile` failing mid-body | ends the body | ends it, resets from 11.2.8 | ends the body | ends it, resets from 12.3.0 | what the file's own `errorHandler` did |
| A returned web `Response`, `ReadableStream`, generator or `Readable` | streamed by the adapter | streamed by the adapter | streamed by the adapter | by the adapter, by the core from 12.4.0 | — |
| WS exception frame | ours | ours | ours | ours | `emitMessage` on Nest's filter |
| `handleDisconnect` 2nd argument | none | none | close code | close code | — |
| Express's redirect page, filenames | 5.2.1's | 5.2.1's | 5.2.1's | 5.3.0's | — |

1. `AbstractHttpAdapter.prototype.mapException` in `@nestjs/core`, added in
   12.0.0.
2. `isRejectedByPipes` in `@nestjs/core/internal`, added in 12.2.0.
3. Asked of the core's own `MiddlewareModule.prototype.registerHandler` when
   the adapter loads, with stand-ins: one middleware at two paths, one
   request through both. A core it cannot ask reads as running it once, since
   every core before that guard answers. In an app, `forRoutes("*")` under a
   global prefix runs once on `/api/` on every release measured (11.2.7,
   11.2.9, 12.1.3, 12.2.0, 12.3.0, 12.4.1), on both adapters: before 12.2.0
   (and 11.2.8) the core's exact `/api$` entry skips `/api/`, leaving it to
   the wildcard entry; from then on it serves `/api/` too and the core runs
   the middleware once.
4. `BaseExceptionFilter.prototype.getHttpErrorMessage` in `@nestjs/core`, added
   in 12.3.0 and 11.2.8. These two behaviours live in platform-express, which
   this adapter replaces, so the read is of what the core shipped beside them;
   11.2.8 backported the method without either behaviour, so (1) must hold too.
5. `isRejectedByPipes` in `@nestjs/core/internal`, or on 11, which has no such
   file, in the module that holds it (`@nestjs/core/router/rejected-by-pipes.js`),
   added in 12.2.0 and 11.2.8.

A dash means the adapter reads nothing: the core calls what it needs
(`getRouteMatchingOptions()` for `exclude()`), and an older core never calls
it. "Nest's" exclusion matching is the core's own (path-to-regexp's
defaults: case-insensitive, an optional trailing slash), on both adapters
alike. The last row is bun-common's answer on
every release, which Express matches from 5.3.0 (Nest 12.2.0); the
difference is listed under
[known differences](#known-differences-from-nestjsplatform-express), with
the rows that are known on some releases only.

## `BunHttpAdapter`

`BunHttpAdapter` extends NestJS's `AbstractHttpAdapter`. Its `instance` is a
bun-common `BunRouter`, and `listen()` binds `Bun.serve`. `getInstance()`
returns that router typed as `BunRouter` (NestJS's own signature defaults to
`any`). The adapter goes to `NestFactory.create()`, and its `webSocketAdapter`
to `app.useWebSocketAdapter()`, with no cast. `BunNestHttpAdapter` is the same
class under a second name. Its constructor is
`new BunHttpAdapter(requestTimeout?, options?)`.

### Adapter options

| Option | Type | Default | Description |
|---|---|---|---|
| `requestTimeout` (1st argument) | `number` | `0` | Milliseconds allowed to finalise a response once routing is done. `0` means no timeout. Also settable with `setTimeout()`. |
| `request` | `Partial<BunRequestOptions>` | `{ parseBody: true, parseCookies: true }` | Request parsing forwarded to every `BunRequest`: body, cookie and query parsing, size caps (`parseBody.maxContentLength`, `parseBody.contentTypes`, …) and the cookie secret (`parseCookies: { secret }`). Merged over the default object (`mergeBunRequestOptions`, nested `parseBody`, `parseQuery` and `parseCookies` objects included), so `{ parseCookies: { secret } }` alone keeps body parsing on; set a default explicitly to turn it off (`{ parseBody: false }`). |
| `router` | `BunRouterOptions` | `{ caseSensitive: false, debug: false }` | Options for the `BunRouter`, merged over the default. Paths match case-insensitively, as on `@nestjs/platform-express`; `{ caseSensitive: true }` opts in to exact case. |
| `routeCacheMax` | `number` | `50_000` (`DEFAULT_ROUTE_CACHE_MAX`) | Upper bound on the router's matched-pipeline cache before FIFO eviction. `0` disables it. The cache is keyed by resolved path, so size it above the number of distinct paths in flight, or use `0`. |
| `etag` | `boolean \| "weak" \| "strong" \| (body) => string \| undefined` | `false` | How every response is tagged with an `ETag`, so a matching `If-None-Match` is answered `304`: `true`/`"strong"`, `"weak"`, or a function returning the tag. A controller overrules it for its own response with `@Res({ passthrough: true }) res` and `res.setEtag(false)` (or `res.etag = "weak"`); see bun-common's `setEtag`. |
| `logger` | NestJS `Logger` | `new Logger()` | Logger for adapter diagnostics: bind failures and unhandled errors. |
| `closeDrainTimeout` | `number` (ms) | `10_000` | The longest `close()` (and `app.close()`) waits for in-flight requests before cutting them. `0` waits for nothing; `forceCloseConnections: true` skips the wait whatever it says. A negative or non-finite value throws a `RangeError` at construction. See [`listen()` and `close()`](#listen-and-close). |
| `server` | `BunServeNormalOptions` | `{}` | Base `Bun.serve` options (TLS, `idleTimeout`, `maxRequestBodySize`, …). `port`, `hostname`, `fetch`, `websocket`, `error` and `development` are set by the adapter and override these. `routes` serves constants (a health check, `robots.txt`) natively, ahead of Nest: every method, no middleware, guards or interceptors; see bun-common's [Native static routes](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/README.md#native-static-routes-serverroutes). |
| `websocket` | `Partial<WebsocketOptions>` | bound to this adapter | Overrides for the built-in WebSocket adapter. See [the `websocket` option](#the-websocket-option). |
| `trustProxy` | `boolean \| number \| string \| string[] \| (addr, i) => boolean` | `false` | Which proxies to believe about the client, as Express's `trust proxy`; `app.set("trust proxy", value)` sets it too. See [Client IP behind proxies](#client-ip-behind-proxies-trust-proxy). |
| `clientIpHeader` | `string` | none | A header carrying the client address as one value (`"cf-connecting-ip"`), believed only when `trustProxy` trusts the whole chain. bun-common's `behindCloudflare()` sets both. |
| `throttle` | `ThrottleOptions \| ThrottleHandler` | none | bun-common's `throttle()`, run first: ahead of every route, Nest middleware, guard and the not-found handler, so 404s count. Refused with bun-common's `429` before Nest sees the request; `@Throttle()`/`@SkipThrottle()` do not affect it. See [Throttling](#throttling). |

```ts
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { Logger } from "@nestjs/common";

export const adapter = new BunHttpAdapter(10_000, {
  request: { parseBody: { maxContentLength: "16kb" }, parseCookies: true },
  router: { caseSensitive: true }, // opt in to exact-case paths
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
| `close()` | Drains in-flight requests (at most `closeDrainTimeout`, 10 s; none with `forceCloseConnections`), stops the server and emits `close`. Routes and handlers stay registered. See [`listen()` and `close()`](#listen-and-close). |
| `fetch(input, init?)` | Runs a request through the adapter without a socket. See [Testing with `fetch()`](#testing-with-fetch). |
| `use`, `get`, `post`, `put`, `patch`, `delete`, `head`, `options`, `all`, `search`, `query`, `propfind`, `proppatch`, `mkcol`, `copy`, `move`, `lock`, `unlock` | Register raw router middleware and routes beside Nest's controllers. `use` also mounts a `BunRouter`: see [Mounting a bun-common router](#mounting-a-bun-common-router). |
| `enableCors(options, prefix?)` | See [CORS](#cors). |
| `useStaticAssets(path, options)` | See [Static assets](#static-assets). |
| `useBodyParser(type, rawBody, options)`, `registerParserMiddleware(prefix?, rawBody?)` | See [Body parsing and raw bodies](#body-parsing-and-raw-bodies). |
| `setErrorHandler(handler)`, `setNotFoundHandler(handler)` | See [Error handling](#error-handling). |
| `setOnRequestHook(hook)`, `setOnResponseHook(hook)`, `addBeforeWriteHook(hook)` | See [Instrumentation hooks and response checks](#instrumentation-hooks-and-response-checks). |
| `setLogger(logger)`, `logger` | Replace or read the NestJS logger. |
| `setRequestOpts(opts)`, `requestOpts` | Replace or read the `request` option. Setting it merges over the defaults, not over the options set before. |
| `setTimeout(ms, callback)` | Sets `requestTimeout`, then calls `callback` with the server once one is listening. |
| `getBunServer()`, `server` | The `Bun.serve` server, or `undefined` before `listen()`. |
| `getHttpServer()` | What Nest holds as its HTTP server: a proxy that answers Nest's Node-style calls (`address`, `once`, …) from the adapter and the Bun server. |
| `url`, `listeningHost`, `listeningPort`, `isListening`, `address()`, `getListenAddress()` | Server introspection. `getListenAddress()` resolves the URL once bound. |
| `eventEmitter` | A Node `EventEmitter`: `listening` (with the server), `close`, and `error` (a bind failure, when a listener is attached). |
| `webSocketAdapter` | The built-in `BunNestWebsocketAdapter`. Setting it also makes it the router's active WebSocket adapter. |
| `getType()` | `"express"`, for libraries that branch on the platform. |

`query` registers an HTTP `QUERY` route (RFC 10008), whose body is parsed as
any other method's. Nest's `@QueryMethod()` and
`forRoutes({ method: RequestMethod.QUERY })`, which arrived in Nest 11.2.0, go
through it on 11.2 and 12; Nest 11.1 has neither, though `adapter.query()`
itself works there too.

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

Route paths have Express 5's syntax and semantics (path-to-regexp 8), as on
`@nestjs/platform-express`: `*name` is a `string[]` (`@Param("path")` on
`files/*path` is `["a", "b"]` for `/files/a/b`), `{…}` is optional
(`archive/:year{/:month}`), and a path Express cannot register fails the
boot. Every controller and middleware path goes through `normalizePath`,
which converts a legacy path with Nest's `LegacyRouteConverter` (`users/*`
becomes `users/{*path}`, with Nest's warning) and throws a `PathSyntaxError`
(a `TypeError` carrying path-to-regexp's message, as Express's adapter
throws) for one it cannot convert. **That makes the adapter stricter than a
bare bun-common `BunRouter`**, which still accepts routejs-only forms: a
route such as `archive/:year(\d{4})/:month?` fails `app.init()` here. Write
it `archive/:year{/:month}` and validate the year with a pipe.
`getRequestHostname` (what `@Controller({ host })` matches) is the `Host`
header as sent, without its port.

Matching and validation otherwise behave exactly as in bun-common. See its
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
[jobs UI](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-ui/guides/jobs.md)
mounts on a Nest app:

```ts
import { BunRouter, validate } from "@kingsleyweb/bun-common";

const admin = new BunRouter();
admin.get("/status", (_req, res) => res.json({ ok: true }));
adapter.use("/admin", admin); // GET /admin/status
adapter.use(ui.basePath, ui.router); // jobsUi() from @kingsleyweb/bun-ui/jobs

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

From Nest 11.2.8 and 12.2.0, the core asks the adapter how its router matches paths
(`getRouteMatchingOptions()`) and matches `exclude()` routes the same way.
The adapter answers as `@nestjs/platform-express` does there:
case-insensitive unless the `router` option sets `caseSensitive: true`, and
a trailing slash ignored. Earlier cores use path-to-regexp's defaults
(case-insensitive, an optional trailing slash) on both adapters alike, so
`exclude("users/login")` skips the middleware on `/users/LOGIN` and
`/users/login/` on every release. What those releases change, on both adapters:

- `exclude("invoices/{*path}")` runs the middleware on `/invoices/`, which
  the `invoices` route serves; earlier cores skip it.
- With `router: { caseSensitive: true }` (Express: `case sensitive routing`),
  `exclude("users/login")` runs it on `/users/LOGIN`; earlier cores skip it.

Measured in whole apps on Nest 11.2.7, 12.1.3 and 12.2.0
([evidence](https://github.com/kingsloob1/bun-node/blob/develop/docs/plans/nestjs-12-parity/evidence/middleware-1220/README.md)).

See
[`middleware-and-versioning.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/middleware-and-versioning.ts).

### Responses: `@Redirect`, `StreamableFile`, `@Render`

| Nest feature | Behaviour on `BunHttpAdapter` |
|---|---|
| Returned value | Sent through `BunResponse.send`: text, JSON, binary, `Bun.file()`, `Blob`, `ReadableStream`, Node `Readable` and async iterables (streams are sent as they are). What is not an object is sent as its string, as on Express, a symbol among them. A function is not: see the known differences. |
| `@Res()` | You send the response. With `{ passthrough: true }` you may set headers or cookies and still return a value. |
| `@HttpCode`, `@Header` | As on Express. A `Content-Type` is completed as `res.set()` completes it: `html` is `text/html`, and a type with a default charset (`text/*`, `application/json`) gets it. |
| `@Redirect(url, status)` | As on Express (`res.redirect(status, url)`): `Location` is URL-encoded, the status defaults to `302`, and the body is Express's short "Found. Redirecting to …" — `text/plain`, `text/html` or empty, chosen by `Accept`, with `Vary: Accept`. A handler returning `{ url, statusCode }` overrides either. |
| `StreamableFile` | Streamed. Its `type`, `disposition` and `length` fill in `Content-Type`, `Content-Disposition` and `Content-Length` when the handler has not set them. A source error goes to the file's `errorHandler` (`setErrorHandler()`), as on Express: the response waits for the first chunk, so a source that fails before it (or had already failed) is answered by the handler, by default `400` with the error's message. A source that fails after that goes to the handler too: on Nest 11.2.8 and later, and 12.3.0 and later, its default destroys the response, so the client sees the connection reset rather than a truncated file that looks whole; before them it ends the response, as on Express. A `HEAD` answers with the headers, a `Content-Length` the file declares included, and destroys the source after its first chunk. If the client leaves before the file is read to the end, even before the handler returned it, its source is destroyed, as on platform-express 12, so an abandoned download holds no file descriptor. |
| A returned `Error` | On Nest 12.3.0 and later, with a status of 400 or more, the body is `{ statusCode, message }` with the status text, as on Express: an `Error`'s enumerable properties, such as an HTTP client's `config.headers.authorization`, never reach the client. Before 12.3.0 they are serialised, on Express as here. Under a status below 400 they are serialised on every release. |
| A status | On Nest 12, any status Nest passes is applied, `0` included, and checked as Express 5's `res.status` checks it: a non-integer or a code outside 100–999 fails, and Nest answers `500`. On Nest 11 a falsy status (`0`, `NaN`) is skipped, as its platform-express skips it. |
| `@Render(view)` | As on Express (`res.render(view, result)`): renders `view` with the view engine (see [Views](#views-render-and-resrender)), the handler's return value being the locals. The status is the route's (`@HttpCode()`). A missing view or a throwing template answers Nest's `500`. |

```ts
import { createReadStream } from "node:fs";
import { Controller, Get, HttpCode, HttpStatus, Redirect, Render, StreamableFile } from "@nestjs/common";

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
  @HttpCode(503)
  @Render("maintenance")
  maintenance() {
    return { until: "noon" };
  }
}
```

See
[`controllers-and-routing.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/controllers-and-routing.ts),
and
[`express-parity.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/express-parity.ts)
for redirect bodies by `Accept`.

#### Views: `@Render()` and `res.render()`

Express's view system, as `@nestjs/platform-express` exposes it. Any engine
with an Express `__express` export works (ejs, pug, hbs, …); install it in
your app.

```ts
const app = await NestFactory.create(AppModule, new BunHttpAdapter());
app.setBaseViewsDir(join(import.meta.dir, "views")); // Express's `views`
app.setViewEngine("ejs");                            // `view engine`
app.setLocal("siteName", "Acme");                    // `app.locals.siteName`
```

| Call | Express equivalent |
|---|---|
| `setBaseViewsDir(dir \| dirs)` | `app.set("views", …)`; defaults to `./views` |
| `setViewEngine(ext)` | `app.set("view engine", ext)`; its module is loaded on first render and its `__express` used |
| `engine(ext, fn)` | `app.engine(ext, fn)` |
| `setLocal(key, value)` | `app.locals[key] = value` |
| `set(setting, value)`, `enable()`, `disable()` | `app.set()`; only `views`, `view engine`, `view cache` and `view options` apply, any other is ignored with a warning |

The locals are `app.locals`, then `res.locals`, then the handler's return
value (or `res.render(view, locals)`'s). A name without an extension takes
the view engine's; with no view engine it throws `No default engine was
specified and no extension was provided.` (Nest's `500`). A view is looked up
as `<name>.<ext>`, then `<name>/index.<ext>`, in each views directory; none
found is Express's `Failed to lookup view …` error. `@Res() res` can call
`res.render(view, locals?, callback?)` the same way.

A plain HTML file is not a view without an engine for `.html`: send it with
`res.sendFile()`, `StreamableFile` or `useStaticAssets()`.

See
[`views.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/views.ts).

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
| `VersioningType.MEDIA_TYPE` | From the `Accept` header, as the installed Nest's platform-express reads it. On Nest 12: the first parameter, in any media range, that starts with `key` (`Accept: text/html, application/json;charset=utf-8;v=2` with `key: "v="` is version `2`). On Nest 11: the first parameter only, split on `key`. A quoted value (`v="2"`) is unquoted from Nest 12.2.0, as its platform-express does (separators inside quotes ignored); before 12.2.0 it is taken as written, quotes included. |
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

### Security headers and CSRF protection

Nest 12.1's `app.useSecurityHeaders()` and `app.enableCsrfProtection()` work
as on `@nestjs/platform-express` (call them before `app.init()`/`listen()`).
Their hook runs as a middleware at the point it is enabled, before Nest's body
parsers, guards and routes, for every request, matched or not.

- A refused request's `403` goes through Nest's exception filters, on the
  request's response, so it carries the security headers and any header an
  earlier middleware set.
- With either feature on, request bodies are read when first needed (the
  `deferBody` request option turns on), so a refused request is answered
  before its body is read: a malformed or oversized body gets the `403`, not
  a `400` or `413`. An allowed body is read by the body parser as before. Set
  `request: { deferBody: false }` to keep reading bodies up front. Without
  either feature, nothing changes.
- `X-Powered-By` is never sent, so `useSecurityHeaders()`'s
  `disable("x-powered-by")` changes nothing and logs nothing.

### Static assets

`adapter.useStaticAssets(directory, options)` serves a directory under
`options.prefix`. It registers `GET <prefix>/*`, and `GET <prefix>`, which
answers `301` to `<prefix>/` as Express's `serve-static` does. It shares
bun-common's static file implementation. That implementation provides directory indexes, extension
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
| `reviver` | none | `JSON.parse`'s reviver, for a JSON body. |
| anything else | | Other parser-specific options are accepted and not read, `strict` and `extended` included (see [known differences](#known-differences-from-nestjsplatform-express)). |

- **A request with no body is passed on at once.** No `Content-Length`, no
  `Transfer-Encoding` and no body stream (`req.hasBody` is `false`): the
  parser calls `next()` synchronously, before looking at the type, encoding or
  size, as body-parser's `read()` does. It never sets `rawBody` for one. This
  is most of a GET's cost in a Nest app: skipping it made bun-nest's GET
  scenarios 8–23% faster.
- **The adapter's `parseBody: false` wins.** With it, these parsers parse
  nothing, whatever Nest's `bodyParser` option says; `requestParsing({
  parseBody })` turns parsing on for the routes it is applied to (see
  bun-common's README).
- **Each kind is registered once.** A second `useBodyParser` call for the same
  kind (and prefix) does nothing; different kinds stack, each with its own
  options.
- **`rawBody`.** With `NestFactory.create(AppModule, adapter, { rawBody: true })`
  a parser that read the body keeps the bytes on `req.rawBody` (type the request
  as `RawBodyRequest<BunRequest>`). A request that parser skipped keeps what an
  earlier parser set. Bodies keep their bytes by default
  (`retainBuffer`), so `rawBody` just works. An app that sets the adapter's
  `retainBuffer: false` reads a plain JSON body with `request.json()`, which
  keeps none: `req.rawBody` is then unset for such a body.

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

### Per-route parsing with `requestParsing()`

bun-common's `requestParsing()` (re-exported here) is functional middleware,
so `consumer.apply()` takes it. It sets how a route's requests are parsed
(query, cookies, body) for those requests only, and parses them that way
before calling `next()`. The options and their semantics are bun-common's;
see its
[Per-route parsing](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/README.md#per-route-parsing-requestparsing).

To let a route **raise** its body cap above the adapter's, two settings are
needed:

- the adapter's `deferBody` request option, so the body is read on first
  need instead of while the request is built;
- `bodyParser: false` in `NestFactory.create`. Otherwise Nest's own body
  parser, registered for every route at init, reads (and caps) the body
  before any route's middleware runs.

Lowering a cap, or changing query or cookie parsing, works without either.

```ts
import type { MiddlewareConsumer } from "@nestjs/common";
import { BunHttpAdapter, requestParsing } from "@kingsleyweb/bun-nest";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

@Module({ controllers: [UploadController, WebhooksController] })
class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(requestParsing({ parseBody: { maxContentLength: "20mb" } }))
      .forRoutes("upload");
    consumer
      .apply(requestParsing({ parseQuery: false, parseCookies: false }))
      .forRoutes("webhooks");
  }
}

const adapter = new BunHttpAdapter(0, {
  request: { parseBody: { maxContentLength: "100kb" }, deferBody: true },
});
const app = await NestFactory.create(AppModule, adapter, { bodyParser: false });
await app.listen(3000);
```

A body over a route's cap reaches Nest's exception layer as a `413`
`PayloadTooLargeError`, as a body-parser limit does.

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
   `@nestjs/platform-express`. (On a GET or HEAD, a declared empty body with
   no stream — Bun serves `Content-Length: 0` that way — is checked when the
   body is first read, by the body parser, rather than before routing; its
   `415` reaches the same handlers.) A body declared JSON that does not
   parse is refused here too (`400`), unless its route opted in with the
   router option `acceptUndecodableBody`:
   `new BunHttpAdapter(0, { router: { acceptUndecodableBody: true } })` for
   every controller, or a bun-common router built with it and mounted with
   `adapter.use()`. Such a request is routed with the refusal on
   `req.bodyDecodingError`, so a guard runs before anything is said about the
   body. The option is unset by default, which refuses. bun-common's
   per-route `acceptUndecodableBody()` marker does not apply to Nest
   controllers, whose handlers Nest registers itself: opt in with the
   adapter's router option, or through a mounted bun-common router. A body over its cap stays a `413` before routing; bun-common's
   README says which route decides. Error handlers run as Express error
   middleware: `(err, req, res, next)` in registration order, where
   `next(err)` passes the error to the next handler, `next()` ends error
   handling with a `404`, and a return value is ignored. As on Express, `res`
   is the response the request was answering, so headers set before the
   error (CORS, security headers, a middleware's own) stay on the answer; an
   error raised before routing gets a fresh one.
3. **Nothing handled it.** With no error handler, when the error carries no
   request (thrown before one was built, or while finalising the response),
   or when a handler itself throws, the adapter answers as Express's
   `finalhandler` would. The status comes from `err.status` or `err.statusCode`
   when that is 400–599, otherwise `500`. As finalhandler, the page keeps the
   headers already set on the request's response, less `Content-Encoding`,
   `Content-Language` and `Content-Range`. The error is logged through the
   Nest logger, except under `NODE_ENV=test`.

A request no route matched runs the `setNotFoundHandler` handlers in
registration order, until one returns nothing. Nest adds its own at init
(`Cannot GET /x`), and one added earlier runs first. From Nest 12, as on
`@nestjs/platform-express` 12, a handler registered with a global prefix
answers only at or under that prefix (matched as Express's `use(prefix)`
matches it, case-insensitively, a `:tenant` segment taking any segment) and
on the paths of the routes excluded from it; anything else gets Express's own
HTML `404` (`Cannot GET /x`), not Nest's JSON one, with the headers middleware
had set (CORS, security headers, cookies). On Nest 11 the handlers answer
every path. An oversized body
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
[`pipeline.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/pipeline.ts),
[`undecodable-bodies.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/undecodable-bodies.ts).

### Instrumentation hooks and response checks

Three hooks on the adapter, each costing one field read per request while
none is set.

| Hook | When | Can change the response |
|---|---|---|
| `setOnRequestHook((req, res, done) => …)` | First for every request, before middleware, body parsing and routes (as platform-express) | Yes: it can answer the request itself, or `done(error)` |
| `setOnResponseHook((req, res) => …)` | After the response is sent (for a `write()` stream, after it ends), as platform-express's `res.on("finish")` | No |
| `addBeforeWriteHook((context) => …)` | After the response is produced, before anything of it is written | Yes: it can refuse it |

`setOnRequestHook` and `setOnResponseHook` are platform-express's, with the
same rules: the request continues on `done()`, not when a returned promise
resolves; only the first completion counts, and a later error is logged; a
throw or rejection before `done()` is `done(error)`, which goes to Nest's
exception layer. A response hook's errors are only logged. Each replaces the
hook set before, and runs with the adapter as `this`. The response hook sees
every response the request ends with, those of the adapter's error handling
(an error from middleware or body parsing, a refused response) included,
except a page `finalhandler` answers when no Nest error handler is
registered.

`addBeforeWriteHook` is bun-nest's own, made for response validation: it sees
what an interceptor's `map()` cannot, such as a redirect, a `StreamableFile`, a
plain `@Res()` response, a not-found answer and the headers the adapter adds.
The hook gets a context with:

- `phase`: `"response"`, or `"error"` for a response the error handling
  produced;
- `status` and `headers`: the native `Response`'s, exactly what will be
  written. The headers are live; changing them is unsupported;
- `body`: the body by kind (`empty`, `json`, `text`, `binary`, `blob`,
  `form`, `response`, `streamable-file` or `stream`), with the value of a
  buffered body. A stream is never read;
- `request`, and `response`, the Nest-facing `BunResponse`. In phase
  `"error"` it is `undefined`: the context's type is a union on `phase`
  (`BunBeforeWriteResponseContext | BunBeforeWriteErrorContext`), so a check
  on `phase === "response"` narrows it to the response.

Return to let the response go. Throw, or reject, to refuse it: the response is
discarded (a `StreamableFile`'s source destroyed) and the error goes to Nest's
exception layer, so the client gets a `500`, or the status of an
`HttpException`. None of the refused response's own headers (`Location`,
`Set-Cookie`, `Content-*`, `ETag`, `Last-Modified`) reach that answer; its
request-wide ones (CORS, `Vary`, a security hook's) do. A returned promise holds
the response, unwritten, until it settles; past the adapter's
`requestTimeout`, when one is set, the hold fails as a stuck handler does. A
throw in phase `"error"` is logged and the response sent, so a check cannot
loop. A `write()` stream is checked as it opens, before its first byte; its
chunks are not. `HEAD` is checked as the GET it reuses. Hooks run in
registration order, and the first refusal wins. `addBeforeWriteHook` returns a
function that removes the hook.

```ts
const adapter = new BunHttpAdapter();

adapter.setOnRequestHook((req, _res, done) => {
  metrics.started(req.method, req.path);
  done();
});
adapter.setOnResponseHook((_req, res) => metrics.finished(res.statusCode));

// Returns a function that removes the hook.
adapter.addBeforeWriteHook(({ phase, status, headers }) => {
  if (phase === "response" && status === 302 && !headers.get("location")?.startsWith("/app")) {
    throw new Error("redirect outside /app");
  }
});

const app = await NestFactory.create(AppModule, adapter);
await app.listen(3000);
```

### Client IP behind proxies (`trust proxy`)

Behind a proxy, the socket peer is the proxy. Tell the adapter which proxies
to believe, the way you do on `@nestjs/platform-express`:

```ts
import { behindCloudflare } from "@kingsleyweb/bun-common";
import { BunHttpAdapter } from "@kingsleyweb/bun-nest";
import { NestFactory } from "@nestjs/core";

const app = await NestFactory.create(AppModule, new BunHttpAdapter());
app.set("trust proxy", "loopback"); // as on Express: nginx on the same host

// or as an adapter option, with a platform preset:
new BunHttpAdapter(0, { trustProxy: 1 });
new BunHttpAdapter(0, { ...behindCloudflare() }); // reads CF-Connecting-IP
```

Every value Express accepts works, with Express's meaning: `false` (the
default), `true`, a hop count, addresses, CIDR ranges and the presets
`loopback`, `linklocal` and `uniquelocal`, or a function. It decides
`req.ip` (and so `@Ip()`), `req.ips`, `req.protocol` and `req.secure`, and
`req.hostname`. That includes matching a `@Controller({ host })` against
`X-Forwarded-Host`, which is read only from a trusted peer. A gateway
client's real address is `client.data.ip`, where `client.remoteAddress` is
always the proxy. `adapter.trustProxy` reads and sets it.

The `trust-proxy-*` groups of the Express differential
(`__tests__/expressCompat.nest.test.ts`) check `ip`, `ips`, `protocol`,
`secure`, `host` and `hostname` against `@nestjs/platform-express` over real
sockets, for eight `trust proxy` values.

bun-common's README covers the walk, the client address header, the
Cloudflare and Railway helpers, a worked Cloudflare → Railway example and the
spoofing traps:
[Client address behind proxies](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/README.md#client-address-behind-proxies-trustproxy).

Example:
[`13-trust-proxy/client-ip.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/13-trust-proxy/client-ip.ts).

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
- To test `@Ip()`, `trust proxy` or a throttle keyed by the client address,
  name the socket peer: `adapter.fetch("/who", { headers, remoteAddress:
  "10.0.0.4" })` reports it as a served socket's would, listening or not
  (bun-common's README, "Testing without a socket").

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
- **Port.** It must be an integer from `0` to `65535`; `0` picks a free port.
  Any other number is a `RangeError`, reported as a bind failure is (below),
  so `app.listen(70000)` rejects with it.
- **Socket path.** A string that is not a port number is a unix socket path,
  as with `node:http`: `app.listen("/run/app.sock")` listens there (a
  hostname is ignored), `adapter.address()` returns the path and
  `app.getUrl()` gives `http+unix://%2Frun%2Fapp.sock`. Bun removes the
  socket file when the server stops; a file already at the path is
  `EADDRINUSE`, as on Node.
- **Already listening.** On the same address (or port `0`), `listen` resolves
  the running server. On a different address, it stops that server and binds
  the new one.
- **Busy port.** A bind failure (`EADDRINUSE`, an unresolvable hostname, a
  privileged port, a socket path in a missing directory) is logged. The
  adapter never binds somewhere else.
  - If no `error` listener is attached to the HTTP server, `listen` rejects.
  - If one is attached, as `app.listen()` attaches one, the listener receives
    the error, the callback is not called, and `listen` resolves `undefined`.
    So **`app.listen()` rejects with the bind error**, as with
    `@nestjs/platform-express`.
- **Emits** `listening` with the server on `adapter.eventEmitter`.
- **`bun --hot`.** The app runs under `bun --hot` as it is. A re-evaluated
  module's new app calls `app.listen()` on the same port or socket path, and
  that reloads the running server with the new app's handlers instead of
  failing with `EADDRINUSE`. Bun finds the server by an `id` derived from
  its address. Two adapters on one address in one process share a server
  under `--hot`, port `0` included; give each a `server: { id }` adapter
  option to keep them apart. The rest is in bun-common's
  [`bun --hot`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/README.md#bun---hot) section.

`close()` drains, as `@nestjs/platform-express` 12 does: it stops accepting
connections (idle keep-alive connections close at once), lets the requests in
flight finish, then stops the server and emits `close`.

- **A cap, 10 s by default.** Express waits for in-flight requests
  indefinitely, so an open `@Sse()` stream holds its `app.close()` forever;
  here whatever is still open after the adapter's `closeDrainTimeout` option
  (milliseconds, default `10_000`) is cut (a stream, a hung handler), and
  `close()` resolves. `new BunHttpAdapter(0, { closeDrainTimeout: 0 })` waits
  for nothing.
- **`forceCloseConnections: true`** (a `NestFactory.create` option) skips the
  wait: in-flight requests are cut at once.
- **WebSockets** are not waited for; they are closed when the server stops.
- **Nothing of the closed server outlives `close()`**: it always ends by
  force-closing what is left, so a server bound on the same port next is never
  answered by the old one.

**`return503OnClosing: true`** (a `NestFactory.create` option, Nest 12) answers
every request `503 Service Unavailable` with `Connection: close` once
`app.close()` has begun, while the shutdown hooks run and during the drain,
as Express does. Nest 12 calls the adapter's `beforeClose()` first, which
sets this state; Nest 11 has neither the option nor the call. Without the
option no shutdown check runs on any request.

Routes and error and not-found handlers stay registered, so a closed adapter
can listen again (no longer answering `503`) or be driven through `fetch()`.

See
[`http-adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/10-options/http-adapter-options.ts).

### Known differences from `@nestjs/platform-express`

Measured by two differentials, `__tests__/expressCompat.nest.test.ts` and
the routing one, `__tests__/routingCompat.nest.test.ts`. Each boots one Nest
application on both adapters and compares every response, on every Nest
version [tested](#compatibility-nest-11-and-12). Everything not listed here
answers the same status, headers and body.

- A string, number or boolean response body defaults to `text/plain` (Express:
  `text/html`), and a type set before a string body gets no `; charset=utf-8`
  beyond what `@Header()` adds (`text/*`, JSON; see
  [Responses](#responses-redirect-streamablefile-render)), where Express's
  `res.send` adds it to any type. `Content-Type` parameters are written without the space
  (`application/json;charset=utf-8`).
- A returned `Buffer` is sent as its bytes (`application/octet-stream`); Nest
  on Express sends it as JSON (`{"type":"Buffer","data":[…]}`).
- Nest's default body parsing parses every body type; on Express only JSON and
  urlencoded bodies are parsed, so a `text/plain` body is `undefined` there.
- A JSON body may be any JSON value, where body-parser's `strict` default
  answers `400` for one that is not an object or array (`null`, `1`, `"s"`);
  and any `charset` is read as UTF-8, where body-parser answers `415` for one
  that is not `utf-*`. Both sit in bun-common's body parsing.
- There is no default body size limit (body-parser's is `100kb`); set one with
  `app.useBodyParser(type, { limit })` or the adapter's `request.parseBody`
  options. The `413` message names the limit and the size received.
- An extended urlencoded body parses `d[]=x` as `"x"` (qs: `["x"]`).
- `req.query` nests (`a[b]=1` → `{ a: { b: "1" } }`); Express 5's default
  `simple` parser does not.
- `req.subdomains` comes from the public-suffix list, left to right
  (`a.b.example.com` → `["a", "b"]`; Express: `["b", "a"]`).
- `res.end("text")` and `res.writeHead(…)` followed by it carry
  `text/plain;charset=utf-8`, where Node's `res.end` sets no type.
- `res.cookie()` adds `SameSite=Lax` unless given, and orders the attributes
  differently.
- ETags are off unless the adapter's `etag` option turns them on (Express's
  `etag` setting is on, weak, by default); the hash differs.
- A view with a script extension (`.tsx`, `.jsx`, `.ts`, `.js`, …) and no
  engine registered for it throws `No view engine registered for ".tsx"…`,
  where Express would `require` the module named after the extension (for
  `.tsx`, the `tsx` TypeScript runner). Register the engine with
  `app.engine("tsx", fn)`.
- Static files: `Vary: Accept-Encoding` is added; a directory redirect's HTML
  links its target; an unsatisfiable range is a `416` with an empty body (on
  Express it reaches Nest's exception filter as JSON). Bun's `206` repeats
  `Accept-Ranges`, and a dotfile served with `dotfiles: "allow"` is named in
  `Content-Disposition`.
- A `StreamableFile` over a stream of known length is sent with
  `Content-Length`, not chunked. So is any streamed body, on any release, that
  ended before Bun's first flush: the framing depends on when the body ended,
  and the client reads the same bytes. A `HEAD` of a streamed body of unknown
  length carries `Transfer-Encoding: chunked`, as its `GET` would, where Express
  sends neither.
- Before Nest 12.4.0, a returned web `Response`, `ReadableStream`, async
  generator or Node `Readable` is sent as that (see
  [Responses](#responses-redirect-streamablefile-render)); on Express it is
  serialised as JSON, `{}` for the first three. From 12.4.0 Express streams them
  too. On those releases a generator of objects resets the connection, where
  12.4.0's core sends NDJSON, and a `Response` already read is the HTML `500`,
  where 12.4.0's core throws into the exception filters. Any release: a
  returned function sends an empty answer where Express sends its source,
  deliberately, since source code reaching a client helps no one; a returned
  `async function*` is streamed; and a
  `Bun.file()` that does not exist is the HTML `500`, past the exception
  filters.
- A `BadRequestException` from unparsable JSON or a path that cannot be decoded
  has the error as its `cause` on every Nest 12 release; on Express only from
  12.4.1. No read tells 12.4.0 from 12.4.1, and only a filter that reads `cause`
  can see it.
- Before Nest 11.2.8 and 12.3.0, a `StreamableFile` with a declared `length`
  whose source fails mid-body ends here with what was read; on Express the
  connection stays open waiting for the rest, until the client gives up.
- CORS adds `Vary: Origin` even for origin `*`, and a preflight `204` has no
  `Content-Length: 0`.
- `getType()` returns `"express"`.
- Multipart field names are limited on every Nest version
  (`fieldNestingDepth: 32`, `fieldArrayIndexLimit: 1000`, Nest 12.2's
  defaults). platform-express 11 sets none, and multer's are `Infinity`, so
  on Nest 11 bun-nest refuses a name nested deeper than 32 or indexed past
  1000 that Express accepts. Pass `Infinity` in `limits` to accept it.
  platform-express 11.1.20 runs multer 2.1.1, which has no field-name
  limits at all, so there Express also accepts what an explicit
  `fieldNestingDepth` or `fieldArrayIndexLimit` makes bun-nest refuse.
- An error-shaped body (`statusCode` 400 or more) returned under a
  `Content-Type` that is not JSON is sent as JSON with Nest's warning, by Nest
  12's rule: a `+json` type counts as JSON. Nest 11 on Express also forces a
  `+json` type (`application/vnd.api+json`) to `application/json`.
- A status from 600 to 999 is accepted by Express; Bun's `Response` takes 200
  to 599, so Nest's `500` answers it here.
- A handler that writes and then throws in the same tick: the stream ends
  before its first flush, so it carries a `Content-Length` rather than being
  chunked.
- On Nest 11 before 11.2.8, a `StreamableFile`'s source is destroyed when the
  client leaves, where platform-express leaves it open. On every Nest 11, the
  request and response hooks follow platform-express 12.1.3's rules (a
  rejection before `done()` is `done(error)`, `done` counts once, a response
  hook's error is logged), where platform-express 11 leaves those rejections
  and errors unhandled.
- bun-common copies **Express 5.3.0**'s `res.redirect` body and
  `Content-Disposition`: an HTML redirect is a small `<!DOCTYPE html>`
  document, and a download's filename is bare when it is a token
  (`filename=report.csv`). On Express 5.2.1, which Nest 11 and Nest 12.0–12.1.3
  install, Express answers `<p>Found. Redirecting to …</p>` and always quotes
  the filename; Nest 12.2.0's Express 5.3.0 answers as bun-common does.
- On Nest 11 before 11.2.8, and on 12 before 12.1.3, `forRoutes("*")` with a
  global prefix also runs on the bare prefix (`GET /api`), where Express does
  not. Nest marks that route exact (`/api$`), which this adapter honours on
  every version and platform-express only from 11.2.8 and 12.1.3 (nestjs/nest
  #17942). On
  `GET /api/` both run it once, on every version.
- `router: { routeSpecificity: true }` is bun-common's ranking, not Nest
  12's `routeResolutionStrategy: "specificity"`: it also ranks a route's own
  method above `@All()`, and re-ranks the routes by path itself, where
  Nest's sorter ranks path segments only. Under Nest 12, use Nest's option.
- On Nest 12.0.0 and 12.0.1, platform-express mounts its not-found handler
  at `api`, without the leading slash, so a miss under the prefix gets the
  HTML page there. This adapter answers Nest's JSON 404 under the prefix, as
  12.0.2 and later do.
- Nest middleware gets no route params: `req.params` is `{}` in a
  `forRoutes("files/*path")` middleware (Express: `{ path: [...] }`), as
  bun-common binds params only for route handlers.
- Several Nest applications on one adapter: a not-found handler runs only
  once no route matched, so one application's handler never shadows the
  routes of an application initialised after it. On Express it does where it
  covers the path: on Nest 11, where every handler is global, and on Nest 12
  with a parameterised global prefix (`setGlobalPrefix(":tenant")`), which
  covers every first segment.
- Two Nest 12 behaviours read Nest's own code, in the copy bun-nest resolves:
  the not-found scoping is turned on by `@nestjs/core`'s
  `AbstractHttpAdapter.prototype.mapException`, and WebSocket exceptions keep
  this adapter's packet format through a patch to `@nestjs/websockets`'
  `BaseWsExceptionFilter.prototype.emitMessage`. With a second copy of either
  package installed, the application's copy is not the one read: its
  WebSocket exceptions then reach clients as platform-ws's `{ event, data }`
  frame.

Against `@nestjs/platform-ws`, measured by `__tests__/wsCompat.nest.test.ts`
(the same gateways on both adapters, compared on what happened, not on the
frames, whose formats differ by design):

- A plain (non-`WsResponse`) return value is sent only as the ack of a packet
  that asked for one, as on `@nestjs/platform-socket.io`; platform-ws sends it
  as a frame of its own.
- A handler's result stream that errors (under Nest, an exception filter that
  threw) is answered with an `ERROR` packet carrying its message; platform-ws
  logs it and sends nothing.
- Not ported yet (a follow-up): platform-ws 12.2.0 answers a plain HTTP
  request to a gateway's dedicated port with `426 Upgrade Required`.

See the last section of
[`express-parity.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/express-parity.ts),
which checks four of these against this list.

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
  `removeAfter: true`. The removal is not awaited, so it never holds the
  response; if it fails (a custom storage's `removeFile` rejects), the error
  is logged through a Nest `Logger` named `BunFileInterceptor` rather than
  left as an unhandled rejection, which would end a Bun process.
- On Nest 11.2.8 and later, and 12.2.0 and later, when a pipe rejects the request (a
  `ParseFilePipe`, any pipe on the route), the stored files are removed with
  `force` once the response has been sent, disk files included, as
  platform-express does there. A handler that throws leaves them where they
  are, as on Express. Earlier Nest versions keep them in both cases, as
  platform-express does there.

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

The options are bun-common's `UploadOptions`, a union keyed by `storageType`.
`storageType` may be left out, as in multer: `{ dest }` alone is disk storage
at `dest` (exactly `"disk"`), and anything else (`{ limits }`) is memory. A
multer storage engine (`storage` without `storageType`) throws a `TypeError`;
wrap your own `Storage` with `storageType: "custom"`.

| `storageType` | Extra options | Description |
|---|---|---|
| `"memory"` (the default) | `removeAfter` (default `true`) | Files held in a `Buffer`. |
| `"disk"` | `dest` (default: the OS temp directory), `filename` (default: 32 random hex characters plus the original extension), `removeAfter` (default `false`) | Files written to disk. `dest` and `filename` are strings or `(file, req) => string \| Promise<string>`. The directory is created when missing. A fixed `filename` makes each upload overwrite the last. |
| `"custom"` | `storage` (required) | Any `Storage`: `handleFile(file, req)` and `removeFile(file, force?)`. A `DiskStorage` or `MemoryStorage` instance works too. Name `storageType: "custom"` explicitly: a `storage` without it throws at bootstrap. |

Options every storage type accepts:

| Option | Default | Description |
|---|---|---|
| `filter` | none | `(req, file) => boolean \| string` (or a Promise). `true` keeps the file, `false` silently drops it (and removes it from storage), a string rejects the upload with that message (`FILTER_REJECTED`). A thrown error is passed on unchanged. |
| `limits` | busboy's, plus `fieldNestingDepth: 32`, `fieldArrayIndexLimit: 1000` | busboy limits: `fileSize`, `files`, `fields`, `parts`, `fieldNameSize`, `fieldSize`, `headerPairs`; and multer 2.4's field-name limits, `fieldNestingDepth` (`a[b][c]` is 2) and `fieldArrayIndexLimit` (the largest `[n]`), defaulting to Nest 12.2's values on every Nest version. Over either is a `400` (`LIMIT_FIELD_NESTING`, `LIMIT_FIELD_ARRAY_INDEX`); `Infinity` turns a check off. |
| `inflate` | `true` | Replace a field value that parses as JSON (or urlencoded) with the parsed value; `false` keeps raw strings. |
| `fieldInflator`, `fileInflator` | none | Custom inflation of a field value or a file's bytes. |
| `detectFileType` | `true` | Sniff each file's bytes for `validatedMimeType`; `false` skips it (`undefined`). The body is parsed while the request is built, so set it in the adapter's `parseBody.contentTypes.multipart.opts` too, or the interceptor parses it again (see bun-common's README). |
| `isPartAFile` | ignored | Deprecated: busboy 1.x never read it. A part is a file when it has a `filename` or is `application/octet-stream`. |
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

### Module-level options (`MulterModule`)

`MulterModule.register(options)` (or `registerAsync({ useFactory, inject })`,
`{ useClass }`, `{ useExisting }`) gives every upload interceptor of the
importing module default options, as platform-express's `MulterModule` does.
It provides the same `MULTER_MODULE_OPTIONS` token, so platform-express's own
`MulterModule` works with these interceptors too.

```ts
import { FilesInterceptor, MulterModule, UploadedFiles } from "@kingsleyweb/bun-nest";
import { Controller, Module, Post, UseInterceptors } from "@nestjs/common";

@Controller("uploads")
export class UploadsController {
  @Post()
  // `files: 1` from the module, `fileSize` from the route.
  @UseInterceptors(FilesInterceptor("f", 5, { limits: { fileSize: 1000 } }))
  upload(@UploadedFiles() files: unknown[]) {
    return { count: files.length };
  }
}

@Module({
  imports: [MulterModule.register({ limits: { files: 1 } })],
  controllers: [UploadsController],
})
export class UploadsModule {}
```

Each interceptor merges the module's options under its own
(`mergeUploadOptions`, platform-express's `mergeMulterOptions`):

- The interceptor's keys win.
- On Nest 12, `limits` is merged key by key, so a route's `fileSize` keeps the
  module's `files`. On Nest 11 the route's `limits` replaces the module's
  whole, as platform-express 11 does. (platform-express merges key by key from
  12.0.4, this package from 12.0.0.)
- On Nest 12.2.0 and later, a route's `dest` given without a `storage` or
  `storageType` replaces the module's storage, so the route's files go to disk
  at that `dest`. Before 12.2.0 the module's storage wins, as multer prefers
  `storage` to `dest`.
- With no `storageType` on either side it is `"disk"` when there is a `dest`
  and `"memory"` otherwise, so multer-style options such as `{ limits }` or
  `{ dest }` work as they are. A `storage` needs an explicit
  `storageType: "custom"`: a multer storage engine (`multer.diskStorage()`)
  cannot run here, so options that leave a `storage` without a `storageType`
  throw a `TypeError` when the interceptor is built, at bootstrap.

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
| `UploadError` `LIMIT_PART_COUNT`, `LIMIT_FILE_COUNT`, `LIMIT_FIELD_KEY`, `LIMIT_FIELD_VALUE`, `LIMIT_FIELD_COUNT`, `LIMIT_FIELD_NESTING`, `LIMIT_FIELD_ARRAY_INDEX`, `INVALID_FIELD_NAME`, `LIMIT_UNEXPECTED_FILE`, `MISSING_FIELD_NAME` | `BadRequestException` | `400` |
| `UploadError` with a code not listed here | returned unchanged, as platform-express leaves a code it does not list | `500` |
| `UploadError` `FILTER_REJECTED` (a `filter` returned a string) | `BadRequestException` | `400` |
| any other error with `statusCode` `413` (bun-common's `PayloadTooLargeError`) | `PayloadTooLargeException` | `413` |
| busboy's `Multipart: Boundary not found` | `BadRequestException`, message as it is | `400` |
| busboy's `Malformed part header`, `Unexpected end of form`, `Unexpected end of file` | `BadRequestException`, message prefixed `Multipart: ` | `400` |
| anything else: an error a `filter` or storage throws, a `TypeError` | returned unchanged, so Nest answers it | `500` |

- Inside Nest, only a file over `limits.fileSize` is `413`. Every count limit
  is `400`. That is platform-express's mapping. bun-common's standalone
  `UploadError.status` uses `413` for every size and count limit.
- `LIMIT_FIELD_NESTING`, `LIMIT_FIELD_ARRAY_INDEX` and `INVALID_FIELD_NAME`
  are multer 2.4's field-name codes. They are `400` on every Nest version, as
  on platform-express 12. platform-express 11.2.7 answers the last two `500`.
- For an `UploadError`, the response body is an `UploadExceptionBody`:
  `{ statusCode, message, code, field }`. multer's own message for the code
  gets ` - <field>` appended on a `400` (`"Unexpected file field - avatar"`), as
  platform-express words it. Every unexpected file — a foreign field, one
  file over a field's `maxCount`, any file on `NoFilesInterceptor` — is
  `LIMIT_UNEXPECTED_FILE` with that message and the field multer names, so
  it answers `"Unexpected file field - <field>"` as on Express.
  `LIMIT_FILE_SIZE` keeps the bare message, and a message that is not the
  code's default (a `filter`'s string, `FILTER_REJECTED`) is kept as it is.
  The original error is the exception's `cause`.

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
  stream is sent as an `ERROR` packet. (Under Nest that is an exception
  filter that threw; `@nestjs/platform-ws` logs it instead, see
  [Known differences](#known-differences-from-nestjsplatform-express).)

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
socket.io, on Nest 11 and 12. (Nest 12's handler would send platform-ws's
`{ event, data }` frame to a native socket; the adapter routes it through the
client's `emit` instead, for its own clients only.) An exception filter can
replace that.

A reply that cannot be serialised (a cycle, a `BigInt`, a payload nested too
deep for `JSON.stringify`) is logged through Nest's `Logger` and not sent, as
on `@nestjs/platform-ws`; the connection stays open. An exception whose
`cause` cannot be serialised (it echoes the client's message) is sent again
without it on Nest 11.2.8 and later and 12.2 and later, as on platform-ws.

### Validated gateways: `@ValidateMessage`, `@Emits`, `TypedSocket`

One declaration gives a gateway checked payloads, checked acks and checked,
typed emits, on bun-common's contract core:

```ts
import { Emits, TypedSocket, ValidateMessage, ValidationExceptionFilter } from "@kingsleyweb/bun-nest";
import { z } from "zod";

const Say = z.object({ text: z.string().min(1), at: z.coerce.date() });
const chatEmits = { said: z.object({ from: z.string(), text: z.string() }), typing: null } as const;

@WebSocketGateway()
@UseFilters(ValidationExceptionFilter)
@Emits(chatEmits)                                  // server → client, declared
class ChatGateway {
  @SubscribeMessage("say")
  @ValidateMessage(Say, { ack: SayAck })           // client → server, and its ack
  say(
    @MessageBody() msg: z.infer<typeof Say>,       // the parsed payload (a Date, not a string)
    @ConnectedSocket() socket: TypedSocket<typeof chatEmits>,
  ) {
    socket.emit("said", { from: "ada", text: msg.text }); // typed, and checked before the write
    return { saved: true, at: msg.at.toISOString() };     // checked against SayAck
  }
}
```

- **`@ValidateMessage(schema, { ack? })`** stacks an interceptor on the
  `@SubscribeMessage` handler. A payload failing `schema` throws a
  `StandardValidationException` (400, value-free issues), which
  `ValidationExceptionFilter` emits as an `exception` event `{ status, code:
  "VALIDATION", issues }` — the same frame shape bun-common's channels answer
  with. The parsed value is written back, so `@MessageBody()` sees the
  schema's output. With `ack` declared, each non-nullish value the handler
  returns (a Promise's or Observable's included) is checked against it — a
  `{ event, data }` (`WsResponse`) is an event, not an ack, and passes
  through — and the handler's return type is constrained to the ack's wire
  input at compile time. Synchronous when the vendor is. **Do not combine it
  with a payload pipe** on the same handler (`@MessageBody(new
  StandardSchemaPipe(S))`, or Nest 12's `@MessageBody({ schema })`): the
  interceptor checks first and writes the parsed value back, so the pipe
  would run the schema a second time on the output — the pipe is the
  alternative, not a complement.
- **`@Emits(map)`** declares the server → client events (`{ event: schema }`,
  a `null` entry carrying no payload — a payload on one throws). Each
  client's `emit` checks a declared event's payload under `"error"` before
  the write: a synchronous vendor's mismatch throws to the caller and nothing
  is sent (an asynchronous vendor's is logged instead, the caller having
  returned; its writes keep their order). An undeclared event passes
  unchecked. The map is recorded as metadata (`"bun:validate:emits"`) for
  documents, and composes with the gateway's own `handleConnection`.
- **`TypedSocket<typeof map>`** types `@ConnectedSocket()` from the same
  `as const` map: `emit` rejects an undeclared event or a wrongly typed
  payload at compile time. (Deriving the map from the class —
  `TypedSocket<typeof ChatGateway>` — is not expressible in TypeScript: a
  class decorator's argument is invisible to the type system.)
- **A typed browser client**: bun-client's `channel()` with `codec:
  "bun-nest"` speaks the adapter's packets, and its `request()` resolves with
  the handler's ack, typed by the `ack` schema. Its types come from the
  `gatewayAsyncApi(app)` document (`bun-client generate`), or, in a
  monorepo, from the same maps: put `Say`, `SayAck` and `chatEmits` in a
  shared, browser-safe module that both the gateway and a `channelContract()`
  for the client import (bun-client's README, "bun-nest gateways").

Example:
[`validated-gateway.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/04-websockets/validated-gateway.ts).

### Flow control

As `@nestjs/platform-ws` 12.2.0 (nestjs/nest 0bd0810ed, db4e586c5), on every
Nest version, per connection:

- **At most `maxConcurrentMessages` messages are handled at once** (default
  `1000`, per gateway the client is bound to). Later ones wait, in order, for
  a slot. A message holds its slot until every result of its handlers has
  completed or errored, so a handler returning an Observable that never
  completes holds one for as long as the client stays. `Infinity` lifts the
  limit.
- **Reading from a client pauses** while its messages wait for a slot or
  while more than 1 MB is queued for it, and resumes once it has caught up.
  So a client that sends faster than it reads its replies is read more
  slowly as well. Pausing stops the next read only: the messages of a read
  already made are still handled, up to the bound, as on platform-ws. (This needs `ServerWebSocket.pause()`/`resume()`, in the
  Bun 1.4.4 runtime; without them the other two rules still hold.)
- **A client with more than `maxSendBufferSize` bytes queued for it is
  disconnected** (`terminate()`, with a warning; default 128 MB, `0` lifts
  it). What can still queue up while a client is paused is what is already on
  its way: an Observable's values, what exception filters send. The adapter
  raises Bun's own `backpressureLimit` (16 MB by default, past which Bun drops
  what is sent) to `maxSendBufferSize`, so replies are queued up to the cap,
  never dropped. A `wsOptions.backpressureLimit` you set wins; a reply Bun
  then drops disconnects the client the same way, so none is lost silently.
- When a client disconnects, its waiting messages are dropped and the results
  still running (an Observable) are unsubscribed from. What it sent after the
  server began closing it is not handled.

```ts
export const adapter = new BunHttpAdapter(0, {
  websocket: { maxConcurrentMessages: 100, maxSendBufferSize: 16 * 1024 * 1024 },
});
// or: new BunWebSocketAdapter({ httpAdapter, maxConcurrentMessages: 100 })
```

### The `websocket` option

`BunHttpAdapter`'s `websocket` option is merged field by field over defaults
that bind the built-in adapter to the HTTP adapter:
`{ httpAdapter: this, newInstance: false, router: httpAdapter.instance, getServer: () => httpAdapter.getBunServer() }`.

| Field | Description |
|---|---|
| `wsOptions` | Bun `WebSocketHandler` settings: `idleTimeout` (default `30` seconds), `maxPayloadLength` (default 1 MB), `perMessageDeflate` (default on), `backpressureLimit` (default `maxSendBufferSize`), `closeOnBackpressureLimit`, `sendPings`, `publishToSelf`. The lifecycle callbacks are supplied by the adapter. |
| `maxConcurrentMessages` | Messages of one client handled at once, per gateway; later ones wait. Default `1000`; `Infinity` lifts it. See [Flow control](#flow-control). |
| `maxSendBufferSize` | Bytes queued for a client before it is disconnected. Default 128 MB; `0` lifts it. See [Flow control](#flow-control). |
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
- `bindClientDisconnect(client, cb)` runs `cb(code, reason)` once when that
  client goes (see below).
- `close(server)` closes it, and `dispose()` is the shutdown hook.

`bindClientDisconnect` callbacks receive `(code, reason)`: the close code and
reason, the arguments `@nestjs/platform-ws` passes on from `ws`'s `close`
event. Direct callers used to get `(client, code, reason)`; they hold the
client already. Like platform-ws, Nest 12 hands the first of them, the
numeric close code, to the gateway as `handleDisconnect(client, reason)`'s
second argument, although Nest types that argument `string`. Nest 11 calls
`handleDisconnect(client)` alone.

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

- Gateways bound to that server stop receiving connections, and their routes
  are unregistered: an upgrade request to a gateway's path is no longer
  upgraded (it goes on to whatever else matches, or a `404`). A path a
  gateway on another open server still uses stays, and so does any other
  handler on the same path.
- `dispose()`, which `app.close()` calls after `close()`, unregisters every
  gateway route left, as `@nestjs/platform-ws` 12 removes its `upgrade`
  listener. So a server that outlives the application (one the adapter does
  not own, or the HTTP adapter listening again) never upgrades to a gateway
  that is gone. A new application on the same server registers its gateways
  again.
- A server the adapter owns (a gateway port's, or its own under
  `newInstance: true`) is stopped, force-closing its connections.
- The HTTP adapter's shared server is **not** stopped; that is `app.close()`'s
  job. Instead the adapter closes the WebSocket connections it holds, with
  code `1001`.

## Validation

BunValidate's Nest pipes and filter: any [Standard Schema](https://standardschema.dev)
(zod, valibot, arktype, yup, or a function wrapped with bun-common's
`toStandardSchema`), the same runner and issue shape as bun-common's
`validate()`, on Nest 11 and 12 alike. They are platform-neutral: the filter
answers through the application's adapter, and the same app answers the same
on bun-nest and `@nestjs/platform-express` (the differential test compares
them probe by probe).

| You want | Use | Works on |
|---|---|---|
| One parameter, one schema | `new StandardSchemaPipe(schema)` | Nest 11 and 12 |
| Parameters typed from a schema, one global pipe | `class Dto extends SchemaDto(schema) {}` + `StandardValidationPipe` | Nest 11 and 12 |
| A route's whole request — body, query, params, headers, cookies | `@Validate({ … })` + `@Validated(part)` | Nest 11 and 12 |
| A route's responses, per status (body, headers, media type) | `@Validate({ responses })` + `reply()` | Nest 11 and 12 |
| `{ error, issues }` answers | `ValidationExceptionFilter` (opt-in) | Nest 11 and 12 |
| Both registered globally | `StandardValidationModule` | Nest 11 and 12 |
| Nest's own per-parameter schema | `@Body({ schema })` + Nest's `StandardSchemaValidationPipe` | Nest 12 only |

On Nest 12, its own `StandardSchemaValidationPipe` and `@Body({ schema })`
already validate a per-parameter schema; ours is the path on Nest 11, and the
`SchemaDto` path on both. The two are independent: ours never reads
`metadata.schema`, and Nest's never reads a `SchemaDto`.

Every row of this table runs, with each answer asserted, in
[`07-validation/standard-validation.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/07-validation/standard-validation.ts):
all of them on Nest 12, and all but the last on Nest 11. `@Validate` runs in
[`07-validation/validate-decorator.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/07-validation/validate-decorator.ts).

### `@Validate`

```ts
import { Validate, Validated, ValidBody, ValidQuery } from "@kingsleyweb/bun-nest";

@Controller("users")
@Validate({ headers: ApiHeaders })                     // class level: every route
class UsersController {
  @Validate({ params: IdParams, query: Page, cookies: Session, body: CreateUser })
  @Post(":id")
  create(
    @ValidBody() body: CreateUserDto,                  // or Infer<typeof CreateUser>
    @ValidQuery() query: { page: number },             // coerced
    @Validated("params") params: { id: number },
  ) {}
}
```

`@Validate(schemas)` checks a route's request parts — `params`, `query`,
`headers`, `cookies`, `signedCookies`, `body` — with Standard Schemas, in an
interceptor, before the handler and before Nest's pipes:

- Every parsed part is **written back in place** (`req.query`, `req.body`, …)
  and recorded on the request's **`valid`** view, which `@Validated(part)`
  and its aliases (`@ValidBody()`, `@ValidQuery()`, `@ValidParams()`,
  `@ValidHeaders()`, `@ValidCookies()`, `@ValidSignedCookies()`) read: a
  coerced value arrives coerced. `@Validated(part)` is `undefined` where
  nothing validated the part.
- **Headers are never written back** — `req.headers` stays raw, so `accepts`,
  `type-is` and the body parsers keep working; their typed view is
  `req.valid.headers` (and `@ValidHeaders()`).
- A failure throws a `StandardValidationException` (400) carrying every
  part's issues, value-free: with `ValidationExceptionFilter` the answer is
  `{ error: "Validation failed", issues }`; without it, Nest's own 400 body.
- Method and class level merge **per part**: a part both declare is the
  method's; the class's other parts still apply.
- Every schema is recorded on the route's contract (`getContract` on the
  handler, or on the class for a class-level `@Validate`), so documentation
  tooling reads them.

**Composing with Nest 12** (`@Body({ schema })`, and `@Query` / `@Param`
alike): `@Validate` skips a part only when a **whole-part** parameter
decorator for it carries a schema **and** Nest's own
`StandardSchemaValidationPipe` applies to that parameter (from the
parameter's, the method's or the class's `@UsePipes`, or the global pipes) —
one parse per part, by whichever runs. A keyed decorator
(`@Body("field", { schema })`) covers one property, never the part; headers
and cookies can never be skipped (Nest runs no pipes on them); on Nest 11
`@Validate` checks everything itself. The check is read from the installed
Nest's capabilities, never a version. Skipped or not, every schema still
reaches the route's contract.

`@Validate` works on any adapter: the request is read and written through
plain properties (Express 5's getter-only `req.query` is defined over). It
checks HTTP requests only; gateway messages are the gateway pipes' ground.

#### Responses

```ts
const responses = {
  201: { headers: z.object({ location: z.string() }), content: { "application/json": User } },
  409: Problem,                       // shorthand: { content: { "application/json": Problem } }
  204: null,                          // no body
} as const;

@Validate({ responses, responseValidation: "error" })
@Post()
create() {
  return reply<typeof responses>(201, user);   // status and body typed from the table
}
```

`responses` is the same `ResponseSchemas` table as bun-common's `validate()`
— per status, `headers`, `cookies` and a `content` map from media type to
body schema (`null` for no body; `chunks()`, `sse()` and `opaque()` for the
other body kinds, and `variants()` for several whole responses of one
status) — and is checked with the same engine (`createResponseChecker` in
bun-common). `responseValidation` is `"off"` (the default, which only
applies a named variant's adjust), `"warn"` or `"error"`. With
`responseOutput: "parsed"` (V13), a passing buffered JSON body is sent as
the schema's **output** (unknown keys the vendor strips, defaults and
transforms applied) — except on a plain `@Res()` route, whose response the
before-write hook can only pass or refuse, so it is checked as sent.

- A returned body is checked in the interceptor against the final status
  (Nest's own: POST's 201, `@HttpCode`) and the `@Header()` headers, with
  the status, headers, media type and body all checked. A thrown
  non-2xx (`HttpException`) is checked against its declared status.
- `reply(status, body, { headers, variant })` answers per status: the status
  and body are typed from the route's table (the body is the schema's wire
  input), the status and headers are applied, and the body is checked — a
  named variant's literals are filled and its undeclared body fields
  stripped, as `res.variant()` does on bun-common.
- What the interceptor cannot see goes through bun-nest's **before-write
  hook**: a plain `@Res()` route, a `StreamableFile`, a redirect (status and
  `location` checked, the generated body exempt). On another platform those
  are checked only as far as the interceptor reaches.
- `@Sse()` events are checked one by one, in order, against their `sse()`
  event map: a bad first event is a 500 before anything is written; a later
  one is refused and reaches the client as Nest's `event: error` (the
  message is value-free either way).
- A refusal throws a `ResponseValidationError` (500, with `issues`), which
  `ValidationExceptionFilter` answers with
  `{ error: "Response validation failed", issues }`; without the filter the
  answer is Nest's generic 500.
- `ResponseValidationInterceptor` checks every route declaring `responses`
  with its own policy (default `"error"`):
  `app.useGlobalInterceptors(new ResponseValidationInterceptor())` — one
  line turns checks on in development.
- A hand-written stream through `@Res()` is never buffered (a whole-body
  schema is skipped with one warning); a `chunks()`/`sse()` declaration on
  one cannot be checked per chunk. A variant's adjust cannot be applied
  through the hook, so on a plain `@Res()` route set the variant's fields on
  the response itself.

### `StandardSchemaPipe`

```ts
import type { StandardSchemaV1 } from "@kingsleyweb/bun-common";
import { StandardSchemaPipe } from "@kingsleyweb/bun-nest";
import { z } from "zod";

const CreateUser = z.object({ name: z.string().min(1), age: z.coerce.number().int() });

@Controller("users")
class UsersController {
  @Post()
  create(@Body(new StandardSchemaPipe(CreateUser)) body: StandardSchemaV1.InferOutput<typeof CreateUser>) {}

  @Get(":id")
  find(@Param("id", new StandardSchemaPipe(z.coerce.number().int())) id: number) {}
}

@WebSocketGateway()
class ChatGateway {
  @SubscribeMessage("chat")
  chat(@MessageBody(new StandardSchemaPipe(Chat)) msg: StandardSchemaV1.InferOutput<typeof Chat>) {}
}
```

- The handler receives the schema's **output** (coerced, transformed).
- A failure throws a `StandardValidationException`, a `BadRequestException`
  carrying the issues as `issues`: without the filter Nest answers 400 with
  its own body, `{ statusCode: 400, message: ["age: Invalid input…"], error:
  "Bad Request" }`, the shape of Nest's own validation pipes. An app's own
  filter can `@Catch(StandardValidationException)` and read `issues`.
- Each issue is `{ target, message, path }`: `target` is `"body"` (a
  gateway's `@MessageBody()` too), `"query"`, `"params"` or `"custom"` (a
  custom decorator, `@RawBody()`, Nest 12's `@Cookies()`); `path` is prefixed
  with the parameter's key (`@Query("page", pipe)` reports `page`), so it
  reads as `validate()`'s would.
- It is synchronous when the vendor is (zod, valibot, arktype) and answers
  with a Promise only for an async one (yup).
- A pipe cannot type its parameter, so annotate it
  (`StandardSchemaV1.InferOutput<typeof S>`), or use a `SchemaDto`.
- **Nest runs no pipe on `@Headers()`**, `@Req()` or `@Res()` (both majors).
  For headers, a custom decorator is pipeable:

  ```ts
  const ReqHeaders = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().headers);
  version(@ReqHeaders(new StandardSchemaPipe(ApiHeaders)) headers: ApiHeaders) {}
  ```

- Anything Nest runs through its pipes takes it, a handler built with Nest's
  `ExternalContextCreator` included (the way a jobs or microservice
  integration runs handlers).

### `SchemaDto` and `StandardValidationPipe`

```ts
import { SchemaDto, StandardValidationPipe } from "@kingsleyweb/bun-nest";

class CreateUserDto extends SchemaDto(CreateUser) {}

@Post()
create(@Body() body: CreateUserDto) {
  body.age; // number: the schema's output, nothing restated
}

app.useGlobalPipes(new StandardValidationPipe());
```

`SchemaDto(schema)` is a class whose instance type is the schema's output,
carrying the schema as `schema`. The global `StandardValidationPipe` validates
every parameter whose declared type is such a class and passes the rest
through, the way Nest's `ValidationPipe` finds class-validator DTOs; so both
can be global, each taking its own DTOs.

- It finds the class through Nest's `design:paramtypes`: the app compiles
  with `emitDecoratorMetadata` (Bun reads it from the **working directory's**
  `tsconfig.json`, oven-sh/bun#28605: start the app from the directory whose
  config enables it).
- The handler receives the schema's output, a plain value, not an instance of
  the class.
- Like `ValidationPipe`, it skips a custom decorator's parameter; give that
  one a `StandardSchemaPipe`.
- A schema whose output is a union cannot be a class's instance type
  (TypeScript's TS2509 at `extends`): use `StandardSchemaPipe` and
  `StandardSchemaV1.InferOutput<typeof S>` there.
- In a gateway, **Nest 12** applies global pipes too, so a
  `@MessageBody() msg: ChatDto` is checked; **Nest 11** applies no global pipe
  to gateways (`useGlobalPipes` and `APP_PIPE` alike). A plain
  `@UsePipes(StandardValidationPipe)` is therefore right on Nest 11 only: on
  Nest 12 it runs the schema a second time, on the first run's output, so a transforming schema (`z.string().transform((s) => new
  Date(s))`) refuses every valid message. Give the gateway
  `StandardValidationModule.gatewayPipes()` instead, which is exactly what
  the installed Nest needs: no pipe on Nest 12, and on Nest 11 the pipe's
  class, which Nest builds with the module's `forRoot()` options:

  ```ts
  @WebSocketGateway()
  @UsePipes(...StandardValidationModule.gatewayPipes())
  @UseFilters(ValidationExceptionFilter)
  class ChatGateway {
    @SubscribeMessage("chat")
    chat(@MessageBody() msg: ChatDto) {}
  }
  ```

  It decides once, from a capability of `@nestjs/websockets`
  (`SocketModule.getContextCreator`'s parameters), never from a version, and
  it assumes the global pipe is `StandardValidationModule`'s: with
  `app.useGlobalPipes(new StandardValidationPipe(options))` instead, a Nest 11
  gateway's pipe has none of those options. On Nest 12 it relies on a global
  `StandardValidationPipe` being registered (the module, or your own
  `useGlobalPipes`): with neither, it still returns no pipe, and a gateway's
  `SchemaDto` message goes **unchecked**. Without `@nestjs/websockets`
  installed it returns the pipe's class, which is harmless (there is no
  gateway to run it).

### `ValidationExceptionFilter`

```ts
import { HttpAdapterHost } from "@nestjs/core";
import { ValidationExceptionFilter } from "@kingsleyweb/bun-nest";

app.useGlobalFilters(new ValidationExceptionFilter(app.get(HttpAdapterHost)));
// or @UseFilters(ValidationExceptionFilter) on a controller or gateway
```

Opt-in and `@Catch`-scoped to BunValidate's errors; every other error goes on
to the app's other filters and Nest's own (an invalid JSON body is still
Nest's 400). It answers `{ error, issues }` with the error's status:

| Error | Status | `error` |
|---|---|---|
| the pipes' `StandardValidationException` | 400 | `"Validation failed"` |
| `ValidationError` (a `validate()` middleware applied with `consumer.apply()`, `onFailure: "next"`) | its `status` (400, or what `status` set) | `"Validation failed"` |
| `ResponseValidationError` (a `validate()` middleware's `responses` under `responseValidation: "error"`) | 500, and logged once (no value from the response) | `"Response validation failed"` |

Without the filter, the last two are Nest's `500 Internal server error`.
Built with no adapter (`new ValidationExceptionFilter()`) it writes an
Express-style response (`status().json()`), which bun-nest's and Express's
are. In a gateway (`@UseFilters`, since Nest applies no global filter there)
it emits an `exception` event with `{ status, code: "VALIDATION", issues }`
(`status` the error's, as over HTTP; `code` in place of `error`), exactly as
Nest emits a `WsException` built with that object; without it, the pipe's
error is Nest's `Internal server error` frame, as for Nest's `ValidationPipe`.

In a microservice (`rpc`; Nest applies global filters there, so
`StandardValidationModule` reaches a `@MessagePattern` as `@UseFilters` does)
it answers as Nest's `BaseRpcExceptionFilter` answers, with an Observable that
errors, so the client's `send()` fails with:

```ts
{ status: "error", statusCode: 400, code: "VALIDATION", message: "Validation failed", issues: [...] }
```

(`status: "error"` as Nest answers every rpc error; `statusCode` the error's,
a `ValidationError`'s own included; `code` and `issues` as in the gateway's
frame). A `ResponseValidationError`, a server fault, gets Nest's own answer,
`{ status: "error", message: "Internal server error" }`, logged by Nest, the
same as without the filter. `@nestjs/microservices` is an optional peer, loaded
only there. In any other context (a job handler) it rethrows the error.

### `StandardValidationModule`

```ts
@Module({ imports: [StandardValidationModule] })
// or StandardValidationModule.forRoot({ messages: "generic", redactPaths: true })
class AppModule {}
```

Registers `StandardValidationPipe` (`APP_PIPE`) and `ValidationExceptionFilter`
(`APP_FILTER`, with the adapter host injected). Nest applies `APP_FILTER` to
controllers and microservices (`@MessagePattern`), never to gateways, and
`APP_PIPE` to controllers and microservices and, on Nest 12 only, gateways
(`gatewayPipes()` covers the difference, see
[above](#schemadto-and-standardvalidationpipe)). The module is global and
exports `forRoot()`'s options, so a `StandardValidationPipe` Nest builds
from its class anywhere in the app (`@UsePipes(StandardValidationPipe)`) is
given them.

### Issues carry no received value

Every issue comes from bun-common's runner, which never puts what the client
sent into an issue, an error or a log line: a vendor message that quotes it
(yup, valibot, zod's unknown keys) is replaced by a generic one. The pipes
and the module take `validate()`'s two wording options, with the same names
and meaning (the type `StandardValidationPipeOptions`); a wrong value throws
a `TypeError` when the pipe is built:

| Option | Effect |
|---|---|
| `messages: "generic"` | every message becomes `Invalid value` (plus the vendor's issue code) |
| `redactPaths: true` | every `path` is `""` (the parameter's key is not prefixed either) |
| `stripProtoKeys: "minimal"` | only `__proto__` keys, and `constructor` keys holding a `prototype`, are stripped (default `"nest"`) |

Before the schema runs, the value's prototype-pollution keys are stripped in
place, recursively. By default (`stripProtoKeys: "nest"`) that is Nest 12's
own pipes' rule, own `__proto__` and `prototype` keys and `constructor`
keys, so a legitimate `prototype` or `constructor` field is deleted too: a
body of `{"name":"a","__proto__":{…}}` reaches yup as `{ name: "a" }` (201,
as with Nest's `StandardSchemaValidationPipe`) instead of crashing it.
`"minimal"` (on either pipe, or `forRoot()`) keeps `prototype` fields and a
`constructor` without a `prototype`; yup crashes on a kept `constructor`
key, as it does on `toString` under either rule.

### Differences from Nest 12's `StandardSchemaValidationPipe`

Compared with Nest 12.2.0's own pipe (`@Body({ schema })` and the global
`StandardSchemaValidationPipe`), measured on the same app:

- **Options.** Ours take only `messages`, `redactPaths` and
  `stripProtoKeys` (Nest strips by its rule, our default, with no option).
  Nest's
  `transform: false` (hand on the original value), `errorHttpStatusCode`
  (Nest's default 400), `exceptionFactory`, `validateCustomDecorators`
  (Nest skips a custom decorator's parameter unless it is set) and
  `validateOptions` (passed to the vendor's `validate`) have no
  counterpart: ours always hand on the schema's output, always throw
  `StandardValidationException` (400), call the vendor with the value alone,
  and `StandardSchemaPipe` validates a custom decorator's parameter (the
  global `StandardValidationPipe` skips it, as Nest's does by default).
- **Keyed parameters.** Ours prefix the issue's path with the parameter's
  key; Nest's do not. For `@Query("page")` and `z.coerce.number().min(1)`,
  `?page=0` answers Nest's `message: ["Too small: expected number to be
  >=1"]` and ours `message: ["page: Too small: expected number to be >=1"]`
  (the filter's issue: `{ target: "query", path: "page", … }`). For the
  whole query (`@Query()` and `z.object({ page })`) both give `page: Too
  small: …`.
- **Messages are scrubbed.** Nest hands on the vendor's message as it is;
  ours withhold one that quotes the received value. A `z.strictObject` given
  an unknown key `PLANTED_x` answers Nest's `Unrecognized key: "PLANTED_x"`
  and ours `Invalid value (unrecognized_keys)`.
- **A sync vendor stays sync.** Nest's `transform` is `async`, so it answers
  with a Promise for every vendor; ours answer zod, valibot and arktype
  synchronously, and with a Promise only for an async vendor (yup).

## OpenAPI with `@nestjs/swagger`

`@nestjs/swagger` works on `BunHttpAdapter` as-is — verified end-to-end
(api-docs-generation phase (d), `__tests__/swagger.nest.test.ts`): the same
module booted on this adapter and on `@nestjs/platform-express` scans a
**byte-identical** document and answers every probe alike, on the checkout's
Nest 12.2.0 with `@nestjs/swagger` 12.0.4 and in the nest-matrix columns
11.2.7 (swagger 11.4.6) and 12.0.0. Nothing in this package imports it, so it
stays your dependency, matched to your Nest major:

```bash
bun add @nestjs/swagger    # 12.0.x for Nest 12, 11.4.x for Nest 11
```

```ts
import { ApiProperty, ApiResponse, DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

class CreateUserDto {
  @ApiProperty() name!: string;
  @ApiProperty() age!: number;
}

const app = await NestFactory.create(AppModule, new BunHttpAdapter());
const document = SwaggerModule.createDocument(
  app,
  new DocumentBuilder().setTitle("Users API").setVersion("1.0").build(),
);
SwaggerModule.setup("api", app, document);
await app.listen(0);
```

That serves the document at `/api-json` (and `/api-yaml`), the Swagger UI
page at `/api`, `/api/` and `/api/index.html`, and the UI's assets —
`swagger-ui-bundle.js` included — below `/api`, all beside your routes.
Everything `setup()` needs from the adapter is the express-shaped surface
this adapter already has: `getType()` answers `"express"`, so the express
branch runs (`useStaticAssets(path, { prefix })`, verb registrations,
`getRequestUrl()`); the fastify branch, and `set`/`enable`/`engine`/`render`,
are never touched.

### What the scanner sees, and what it does not

`@nestjs/swagger` reads **Nest metadata only**. Measured:

- A route registered directly on the adapter (`adapter.get("/direct", …)`),
  a mounted bun-common router and the jobs API module's mounted routes are
  all **served but never documented**. The docs routes above are registered
  the same way, so they are not in the document either.
- The scanner's document is built from controllers only; an app also
  mounting `BunJobsApiModule` and a `@WebSocketGateway` scans exactly the
  same — the container is Nest's own, untouched by the adapter.
- bun-common's `listRoutes`/`generateOpenApi` look at the other side of the
  same wall: the router's whole table, controllers included, but with no DTO
  metadata (each such route warns it has no declared responses). One sharp
  edge, measured: run `generateOpenApi` over a router that also serves
  `SwaggerModule.setup`'s routes and it throws a `ConfigError` — the docs
  mount's `GET /api`, `GET /api/` and static `GET /api` share the default
  operation id `getApi`. Filter the docs mount out
  (`filter: (route) => !route.path.startsWith("/api")`) or generate from a
  router that does not hold it. A mixed app that needs both documents serves
  both; merging them is your code, not ours.

### `setGlobalPrefix`

With `app.setGlobalPrefix("v1")`, measured on both adapters:

- the **document's** paths carry the prefix (`/v1/users/{id}`) — the scanner
  applies it;
- the **docs routes** do not: `/api-json` and `/api` stay where they were
  unless you pass `SwaggerModule.setup("api", app, document, {
  useGlobalPrefix: true })`, which moves them to `/v1/api-json` and
  `/v1/api` (the bundle included);
- `listRoutes`/`generateOpenApi` see the prefixed controller paths either
  way (`GET /v1/users/:id`): Nest bakes the prefix into the routes it
  registers.

### `@Render`, beside the docs

Unrelated to swagger but next to it in any app that serves pages: `render`
goes through the [view-engine subsystem](#views-render-and-resrender)
(`setBaseViewsDir`/`setViewEngine`/`engine`). With no engine registered and
no extension on the view, `@Render("index")` answers Nest's 500
(`{"statusCode":500,"message":"Internal server error"}`) — measured the same
on `@nestjs/platform-express`.

### Two bundles, two origins

The UI above is `@nestjs/swagger`'s **own bundled** `swagger-ui-dist` copy,
served from `node_modules` through `useStaticAssets`. bun-common's
`docsRouter()` is a different thing: it serves its **own pinned** viewer
assets from a CDN, for a document `generateOpenApi` built. The two never
share a route or an origin; an app can mount both and each renders the
document it was given.

## Typed clients: documents from controllers

bun-common's generators document a Nest app as they document a router app:
`generateOpenApi(adapter.instance)` lists every controller route with its
final path (global prefix included), and a `@Validate` route with its
schemas — the contract is reflect metadata, which Nest copies onto the
handler it registers. The typed client (`@kingsleyweb/bun-client`) is
generated from that document, so a Nest backend and a router backend give a
frontend the same client.

### `@Describe`

The prose a router route gets from `.describe()`: bun-common's `RouteDoc`,
on a controller method or a controller.

```ts
import { Body, Controller, Get, Param, Patch } from "@nestjs/common";
import { Describe, Validate } from "@kingsleyweb/bun-nest";

@Controller("users")
@Describe({ tags: ["users"] })
export class UsersController {
  @Get(":id")
  @Validate({ params: IdParams, responses: { 200: User, 404: Problem } })
  @Describe({
    summary: "Read one user",
    operationId: "getUser",
    errors: ["NOT_FOUND"],               // x-bun-errors: the client's error codes
    cache: { tags: ["user:{id}"] },      // x-bun-cache: what the client files the result under
  })
  one(@Param("id") id: string) { … }

  @Patch(":id")
  @Validate({ params: IdParams, body: UserPatch, responses: { 200: User } })
  @Describe({ cache: { invalidates: ["user:{id}", "users"] } })
  update(@Param("id") id: string, @Body() body: UserPatch) { … }
}
```

- **The same document as a router.** A controller's
  `generateOpenApi(adapter.instance)` document equals a bun-common router
  app's with the same routes, `validate()` and `.describe()`
  (`__tests__/describe.nest.test.ts`).
- **On a controller**, the doc is merged under each route method the class
  declares: the method's keys win, and `tags` are the controller's followed
  by the method's. `@Describe({ hidden: true })` on a controller hides all
  its routes. A route method inherited from a base controller is left alone
  (its function is the base's): describe it on the base, or override it.
- **Two on one method** merge, the upper one winning per key, as two
  `.describe()` calls do.
- **Documentation only**: it never reaches the handler's types (declare a
  checked response on `@Validate({ responses })`), and nothing checks it at
  run time. With bun-common's `liveInvalidation()` mounted, a route's
  `cache.invalidates` is published on a 2xx, filled from the request's
  params, as on a router.
- It is stored as reflect metadata under `"bun:describe"`, which
  `Reflector` can read too.

### `DevTypesModule`: the dev type sync

bun-common's `devTypes()` (the endpoint `bun-client watch` follows) as a
Nest module, with the app's own documents:

```ts
import { DevTypesModule } from "@kingsleyweb/bun-nest";

@Module({
  imports: [
    DevTypesModule.forRoot({ enabled: process.env.NODE_ENV !== "production" }),
  ],
  controllers: [UsersController],
})
export class AppModule {}
```

```bash
bun --watch src/main.ts                 # the app, on BunHttpAdapter
bunx bun-client watch --out src/api.gen.ts   # beside it: regenerates on every change
```

- **What it serves**: at `path` (default `/__bun/types`) the documents
  `{ hash, openapi, asyncapi }` with the hash as `ETag` (`304` on
  `If-None-Match`), each alone at `/openapi.json` and `/asyncapi.json`, and
  the change channel at `/ws`. The OpenAPI document is
  `generateOpenApi(adapter.instance)` — every controller route with its
  `@Validate` schemas and `@Describe` prose, and the routes registered on the
  adapter itself; the AsyncAPI document is `gatewayAsyncApi`'s, the app's
  gateways. For the same routes, the OpenAPI document equals a bun-common
  router app's `devTypes()` (`__tests__/devTypesModule.nest.test.ts`).
- **Fail closed**, as `devTypes()`: `enabled` must be exactly `true`
  (anything else is an empty module that registers nothing); `forRoot`
  throws a `ConfigError` when enabled under `NODE_ENV=production`; every
  request needs the bearer token (random per process unless `token` is given)
  and a loopback peer (unless `allowRemote`), or gets the app's own 404.
- **Below Nest's pipeline**: it is mounted on the adapter at bootstrap, so no
  guard, interceptor or filter runs for it — an app's global `AuthGuard`
  does not decide whether the dev channel is reachable. A catch-all
  controller route (`@Get("*")`) registered before it answers first.
- **The token file** (`node_modules/.cache/bun-types/<port>.json`, where
  `bun-client watch` finds the server) is written when `app.listen()` binds
  and removed by `app.close()`; `tokenFile` moves it, or `false` writes none.
- Options: `enabled`, `path`, `token`, `allowRemote`, `tokenFile`, and
  `openapi` / `asyncapi` — the generators' options (`title`, `version`, …;
  default `"API"` and `"dev"`), or a function returning the document.

### `@Invalidates`: live invalidation

When a mutation succeeds, the tags it invalidates are published to the live
channel, and every client observing a query filed under one of them
refetches it (bun-client's `live()`). Mount bun-common's
`liveInvalidation()` on the adapter first, then mark the routes:

```ts
import { liveInvalidation } from "@kingsleyweb/bun-common/live";
import { BunHttpAdapter, Describe, Invalidates, Validate } from "@kingsleyweb/bun-nest";

const adapter = new BunHttpAdapter();
const app = await NestFactory.create(AppModule, adapter);
app.use(liveInvalidation(adapter.getInstance(), { authorize })); // before app.listen()
await app.listen(3000);

@Controller("users")
export class UsersController {
  @Get(":id")
  @Describe({ cache: { tags: ["user:{id}"] } })        // what the client files the result under
  one(@Param("id") id: string) { … }

  @Patch(":id")
  @Validate({ params: IdParams, body: UserPatch, responses: { 200: User } })
  @Invalidates("user:{id}", "users")                    // published when the handler succeeds
  update(@Param("id") id: string, @Body() body: UserPatch) { … }
}
```

- **The tags**, in `@CacheTags`' vocabulary: templates, each `{name}` filled
  from the request's params (`"user:{id}"` → `"user:42"`; a template naming
  a param the request lacks is skipped), or one function of the
  `ExecutionContext` (`@Invalidates((ctx) => […])`), computed after the
  handler. `@Invalidates()` with none takes the route's `@Describe({ cache:
  { invalidates } })`.
- **Documented**: templates are the route's `cache.invalidates`
  (`x-bun-cache`), so the typed client also invalidates its own queries on
  the call; they win over a `@Describe({ cache: { invalidates } })` on the
  same method in either order. The function form documents nothing.
- **It follows the handler, not the status**: published once, when the
  handler's observable completes without an error, before the response is
  written. A handler that throws publishes nothing, even when an exception
  filter answers `200`; a function that throws is logged and publishes
  nothing.
- **Without `@Invalidates`**, a route's `@Describe({ cache: { invalidates }
  })` is published by `liveInvalidation()` itself on any `2xx`, as on a
  router — the status rule. A route with `@Invalidates` is left to its
  interceptor, so each success publishes once.
- No module is needed: `liveInvalidation()` serves the channel (`/__live`,
  and its SSE fallback) from the adapter, and `publishTags()` from
  `@kingsleyweb/bun-common/live` publishes by hand.

## Jobs: `BunJobsModule`

[`@kingsleyweb/bun-jobs`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-jobs/README.md)
as a Nest module, on the **`@kingsleyweb/bun-nest/jobs`** entry (bun-jobs is an
optional peer, and the package's root never reaches it). One `BunJobs` context
for the application, and injectable queues:

```ts
import { BunQueue } from "@kingsleyweb/bun-jobs";
import { BunJobsModule, InjectQueue } from "@kingsleyweb/bun-nest/jobs";

@Module({
  imports: [
    BunJobsModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        namespace: "shop",
        driver: { type: "redis", url: config.getOrThrow("REDIS_URL") },
      }),
    }),
    EmailsModule,
  ],
})
export class AppModule {}

@Injectable()
export class SignupService {
  constructor(@InjectQueue("emails") private readonly emails: BunQueue<Email>) {}

  async signedUp(user: User) {
    await this.emails.add("welcome", { to: user.email }, { attempts: 3 });
  }
}

@Module({
  imports: [BunJobsModule.registerQueue({ name: "emails" })],
  providers: [SignupService],
})
export class EmailsModule {}
```

Every method on `BunJobs` and `BunQueue` (the builder, drafts, `addFlow`,
`setLimits`, `pause`, `walk`, …) works on what is injected, with no decorator for
it. A decorator exists where it attaches behaviour to a method or a class.

### The context: `forRoot` and `forRootAsync`

`forRoot(options)` takes every `BunJobs` option (`namespace`, `driver`,
`defaultJobOptions`, `publishEvents`, `service`, `metrics`, `summon`, …), passed
through untouched, and these of its own:

| Option     | Default | What it does |
|------------|---------|--------------|
| `isGlobal` | `true`  | Registers the module globally, so `registerQueue` in a feature module needs nothing but itself. With `false`, import this same module where the context is injected; a queue reaches it through `registerQueueAsync({ imports: [thatModule], … })`. |
| `jobs`     | none    | An existing `BunJobs` to borrow instead of building one (and then no `BunJobs` option beside it). |
| `name`     | none    | The context's name; see [several contexts](#several-contexts-in-one-application). |
| `token`    | none    | A named class extending `BunJobs<Jobs>`, provided as well, so a typed registry keeps its checks where it is injected. |
| `logger`   | `new Logger("BunJobs")` | bun-jobs' `logger`. The default is Nest's, so its records reach `app.useLogger()`; `false` drops them; anything `resolveLogger` accepts takes them instead. |
| `autoStart` | `true` | Whether workers start at bootstrap. See [starting and draining](#starting-and-draining). |
| `shutdown` | `{ timeout: 30_000 }` | `{ timeout?, force? }`, given to each `worker.close()` on `app.close()`. |
| `registryWorker` | none | What `jobs.start()` is given for `@DefineJob`: the registry worker's options. |
| `enhancers` | `true` | Whether handlers run through the Nest pipeline. A class's own `enhancers` wins. |
| `scheduleQueue` | `"nest-schedule"` | The queue `@Cron` and `@Every` use unless they name one. |
| `pruneSchedules` | `false` | Whether undeclared schedule series are removed at boot rather than warned about. |

`forRootAsync` takes the same options from a factory (`useFactory` with `inject`
and `imports`), a class with a `createBunJobsOptions()` method (`useClass`) or a
provider of one (`useExisting`). `isGlobal`, `name` and `token` stay on the call,
since Nest needs them before any factory runs. None of the three is a
`ConfigError`.

The context is injected as the class, `constructor(jobs: BunJobs)`, or with
`@InjectBunJobs(context?)`; `getBunJobsToken(context?)` is its token.

**Who closes what.** A context the module built closes in
`onApplicationShutdown`, after the HTTP server has stopped, and takes its driver
with it. A borrowed one is the application's: the module never closes it. So a
provider's own `onModuleDestroy` can still enqueue a job, and an enqueue after
the close fails loudly with `JobsClosedError`. As with any Nest shutdown hook,
none of this runs on `SIGTERM` unless the app calls `app.enableShutdownHooks()`.

### Queues: `registerQueue` and `@InjectQueue`

```ts
BunJobsModule.registerQueue(
  { name: "emails", options: { defaultJobOptions: { attempts: 5 } } },
  { name: "invoices", context: "billing" },
  ReportsQueue, // a typed token, below
);
BunJobsModule.registerQueueAsync({
  name: "images",
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    options: { defaultJobOptions: { attempts: config.get("ATTEMPTS") } },
  }),
});
```

`options` are what `jobs.queue(name, options)` takes, `schema` and
`dataValidation` included, and an entry may leave them out. **`schema` is
`{ data, result }`, each optional, never a bare schema**: `options: { schema: { data:
Email } }`. The types refuse a bare one, and so does the boot, which is what stops one
typed `any`. The same goes for `schema` on `@Processor`, `@DefineJob`
and `registerWorker`. A call makes the
queues injectable in the module that imports it: `@InjectQueue(name, context?)`,
or `getQueueToken(name, context?)` in a provider or a test
(`"bun-jobs:queue:emails"`, `"bun-jobs:billing:queue:emails"`). One queue
registered from several feature modules is one queue, created with the options
the application registered for it, whichever module Nest builds first.

A queue nobody registered is still `jobs.queue(name)` or the builder's
`toQueue(name)`: registering makes one injectable, and owns its options.

### Typed queues: `@QueueToken`

A parameter decorator cannot see its parameter's type, so
`@InjectQueue("emails") queue: BunQueue<Wrong>` compiles. A class token closes
that: it is the injection token and the type at once.

```ts
@QueueToken("emails") // or @QueueToken("emails", "billing") for a named context
export abstract class EmailsQueue extends BunQueue<Email, string, "welcome" | "digest"> {}

BunJobsModule.registerQueue(EmailsQueue); // or { name: EmailsQueue, options }

constructor(private readonly emails: EmailsQueue) {} // or @InjectQueue(EmailsQueue)

await this.emails.add("welcome", { count: 1 }); // a compile error: the wrong payload
await this.emails.add("nope", { to });           // a compile error: an undeclared name
```

Nothing is ever an instance of the class: the provider hands back the real
`BunQueue`, and `@InjectQueue("emails")` reaches the same object. It must be a
**named** class: a function returning an anonymous class fails declaration emit
under `declaration: true` (`TS4094`, once per private member of `BunQueue`). A
token's types can come from the schemas the queue is registered with, through
`JobMapFromSchemas`, so the compile-time check and the run-time one are one
object.

### Several contexts in one application

A context is one namespace on one backend. To talk to two, import the module
twice, and name the second:

```ts
BunJobsModule.forRoot({ namespace: "shop", driver }),
BunJobsModule.forRoot({ name: "billing", namespace: "billing", driver: billingDriver }),
```

Everything then takes the name last: `@InjectBunJobs("billing")`,
`@InjectQueue("emails", "billing")`, `registerQueue({ name: "emails", context:
"billing" })`, `getQueueToken("emails", "billing")`. Only the unnamed context is
provided under the class `BunJobs`.

### Workers: `@Processor` and `@Process`

Put `@Processor` on a provider, and `@Process` on the methods that handle a job
name. A method with no parameter decorator is called as `(job, ctx)`, with
bun-jobs' `Job` and `ProcessorContext`; one with them gets what they say, below. The
class is an ordinary service: its other methods stay
ordinary methods, and everything it needs is injected as usual.

```ts
import { Job, ProcessorContext } from "@kingsleyweb/bun-jobs";
import { Process, Processor } from "@kingsleyweb/bun-nest/jobs";

@Processor("emails", { concurrency: 5 })
export class EmailService {
  constructor(private readonly mailer: Mailer) {}

  async sendNow(to: string) { … }                    // an ordinary method

  @Process("welcome", { concurrency: 2 })            // limits on this job name
  async welcome(job: Job<Email, string>, ctx: ProcessorContext) {
    await job.updateProgress(10);
    return this.mailer.send(job.data.to, ctx.signal);
  }

  @Process()                                         // any other name on this queue
  async other(job: Job) {
    throw new UnrecoverableJobError(`unknown job ${job.name}`);
  }
}
```

**One worker per queue, not per method.** A bun-jobs worker claims any job on its
queue, whatever its name, so a worker per method would claim the other methods'
jobs and fail them. Classes on one queue (in one context) share one worker, with
their handlers merged. Two handlers for one name, two catch-alls, or two classes
setting different worker options are a `ConfigError` at boot.

**A job nobody handles goes to `dead` at once**, as `UnrecoverableJobError`,
because a `@Processor` queue belongs to this service and no retry here would find
a handler. (`@DefineJob`'s registry keeps bun-jobs' retryable rule, below.)

`@Processor(queue, options)` takes a name or a [`@QueueToken`](#typed-queues-queuetoken)
class, and every option a bun-jobs worker takes, passed through: `concurrency`,
`lockDuration`, `deadLetterQueue`, `control`, `metrics`, `schema`, `id`, `key`, ….
One worker serves the queue, so its `schema` covers every name on it. Beside them
are `scope` (the Nest scope, which needs no `@Injectable()` beside it) and
`context` (the [named context](#several-contexts-in-one-application)).

`@Process(name?, { concurrency?, rate? })` sets limits on one job name, on top of
the queue's. **They are stored on the queue, so they apply to every process
consuming it**, and a name at its limit is skipped rather than waited behind. They
are merged into what is stored at bootstrap: the queue's own limits and every other
name stay as they were, and nothing is written when nothing would change.

**Only providers.** `@Processor` on a controller is a `ConfigError`. A provider
made by `useFactory` or `useValue` is found like any other.

`@InjectWorker(ProcessorClass)`, or `@InjectWorker("emails", context?)`, injects a
`WorkerRef`, whose `worker` getter is the `BunQueueWorker` serving the queue, for
`pause()`, `concurrency` and the rest. The worker is built at bootstrap, after
injection, so the getter throws a `ConfigError` before then. `registerQueue()`
provides the handle as it does the queue, so import it where this is injected. A
class must already be defined at that point: for one declared later, or across an
import cycle, give the queue's name.

**`JobsHost`** is the base-class form, for an app coming from `@nestjs/bullmq`'s
`WorkerHost`: `process(job, ctx)` is the queue's catch-all, `this.worker` is the
worker, and its `onModuleDestroy` is the drain, out in the open.

```ts
@Processor("emails")
export class EmailProcessor extends JobsHost<Email, string> {
  async process(job: Job<Email, string>, ctx: ProcessorContext) { … }
}
```

A subclass overriding `onModuleDestroy` calls `super.onModuleDestroy()` first, or
its worker drains last, after what its jobs use may have gone.

### The Nest pipeline around a job

A handler runs behind the same guards, interceptors, pipes and filters as a
controller, in the same order: `@UseGuards` and the rest work on a `@Processor` class
and on a `@Process` or `@DefineJob` method, a `createParamDecorator` of your own
works, and so do `APP_GUARD` and `app.useGlobalInterceptors()`.

```ts
@Processor("reports")
@UseGuards(FeatureFlagGuard)
@UseInterceptors(JobLoggingInterceptor)
@UseFilters(UnrecoverableOn(ReportRejected))
export class ReportProcessor {
  @Process("monthly")
  async monthly(@JobData({ schema: Monthly }) data: Monthly, @JobSignal() signal: AbortSignal) { … }
}
```

Around a job `getType()` answers `"bun-jobs"`, and `BunJobsExecutionContext.create(context)`
gives the job, as `GqlExecutionContext` gives a resolver: `getJob()`,
`getProcessorContext()`, `getQueueName()`, `getHandlerName()` (the `@Process` name, or
`"*"`).

**Global enhancers apply to jobs**, as Nest applies them to microservices and GraphQL,
and nothing public can exclude them. So a global guard written for HTTP that reads
`switchToHttp().getRequest().headers` would see a `Job`, and deny or throw. Have it
pass a job through:

```ts
canActivate(context: ExecutionContext) {
  if (context.getType<BunJobsContextType>() !== "http") return true; // jobs, ws, rpc: not this guard's business
  …
}
```

bun-nest's own global enhancers already do: `BunThrottlerGuard`, `BunCacheInterceptor`,
`@Invalidates`, `@Validate`'s interceptors, and `ValidationExceptionFilter`. The module
names the global guards a job will meet in one `debug` line at bootstrap.
`enhancers: false`, on the module or a class, turns the whole pipeline off and calls
each method as `(job, ctx)`.

A request-scoped `APP_GUARD` is asked around a singleton processor too, as around a
controller, which makes that processor per job, with the cost of one.

**An enhancer class needs a plain class provider.** Nest finds a class given to
`@UseGuards` and its kind by scanning `providers: [Class]`. On a provider made by
`useFactory` or `useValue` it scans nothing, and left alone the job would run
**without the guard**, on Nest 11 and 12 (a `useClass` provider likewise before
11.2.8 and 12.2). So
that is a `ConfigError` at boot. Register the class plainly, or give the decorator an
instance, which works everywhere.

**Interceptors that should not exist for a job.** An `rxjs` `retry()` retries inside one
attempt, under one lock, invisibly to `attemptsMade`, backoff, dead letters and the UI:
use the job's `attempts`. An `rxjs` `timeout()` abandons the work without aborting it:
use the job's `timeout`, which aborts `ctx.signal`. `JobLoggingInterceptor` logs one line
per attempt through the job's logger, with its name, attempt, duration and outcome, and
passes anything but a job through. Tracing is a job for spans inside bun-jobs, not an
interceptor.

A guard suits what a job claims: a feature flag or a kill switch, or a `data.tenantId`
the processor's tenant may not touch. It is not authentication, since a job has no
caller: authorization at enqueue stays the producer's.

### Parameter decorators

| Decorator | Value | Pipes |
|---|---|---|
| `@JobData(property?, ...pipes)`, `@JobData(pipe)`, `@JobData({ property?, schema?, pipes? })` | `job.data`, or one field of it | yes; told `"body"` |
| `@JobId(...pipes)` | `job.id` | yes |
| `@JobName(...pipes)` | `job.name` | yes |
| `@CurrentJob()` | the `Job`: `log`, `updateProgress`, `getChildrenValues()`, `extendLock`, `fail` | no |
| `@JobContext()` | the `ProcessorContext` | no |
| `@JobSignal()` | `ctx.signal`: aborted on a timeout, a worker's close and a lost lock | no |
| `@JobProgress()` | a `JobProgressFn` | no |
| `@JobLogger()` | `ctx.logger`, bound to the job's ids | no |
| `@JobAttempt()` | `ctx.attempt`, from 1 | no |

**Once one parameter is decorated, every one must be**: Nest fills only decorated
positions, and the rest would arrive as `null`, so that is a `ConfigError` at boot. A
progress value written after the attempt was given up is dropped, silently, as bun-jobs
does.

### Validating job data

Two layers, and which to use:

| Layer | Where | Checks | On failure |
|---|---|---|---|
| **bun-jobs' job schemas** | `registerQueue({ options: { schema } })` at enqueue, `@Processor(queue, { schema })` before the handler, `@DefineJob(name, { schema })` | every job on the queue, in every process that adds or runs it, Nest or not | enqueue: `JobDataValidationError`, nothing written. Processing: the attempt fails as `UnrecoverableJobError` |
| **[Validation pipes](#validation)** on a parameter | `@JobData(new StandardSchemaPipe(S))`, `@JobData({ schema: S })`, or a `SchemaDto` type under a global `StandardValidationPipe` | one method's input, after the guards | `StandardValidationException`, and the job ends with no retry |

Use a schema for data that crosses a deployment boundary, since the producer checks it
too, and a pipe for a per-name check on a queue carrying several names, or for a
transform a handler wants (`z.coerce.number()`).

**`@JobData()` is recorded as Nest's BODY type**, as microservices' `@Payload()` is, so
pipes are told `"body"` and an issue's `target` reads `"body"`. That is what lets an app's
global `ValidationPipe` or `StandardValidationPipe` validate job data with no change:
both skip a `"custom"` parameter. It also means **every global pipe sees job data**, so
one with `whitelist`, or one assuming an HTTP body, runs on jobs too.

`@JobData({ schema })` is `StandardSchemaPipe(schema)` on the parameter, on Nest 11 and
12. It is not also recorded for Nest 12's `StandardSchemaValidationPipe`, which Nest 11
lacks, so it never validates twice.

A pipe cannot type its parameter, so annotate it with
`StandardSchemaV1.InferOutput<typeof Schema>`, or make it a `SchemaDto` class.
`ValidationExceptionFilter` answers for `http`, `ws` and `rpc` and rethrows anything else,
so applied globally it leaves a job's failure alone.

### How a job ends: guards, filters and pipes

| What happens | What the job does |
|---|---|
| A guard returns `false` | `dead` at once, as `JobForbiddenError`, with no retry, since a retry asks the same guard the same question. `onDenied: "retry"` on the class retries it like any error |
| A guard throws its own exception | fails with it, and is retried: it is the guard's decision |
| A pipe throws `StandardValidationException` | `dead` at once, as `UnrecoverableJobError`, with the original as `cause` and its `issues` kept, since a retry sees the same data. `onInvalid: "retry"` on the class retries it |
| Nest's `ValidationPipe`, or your own `BadRequestException` | fails with it, and is retried: `@UseFilters(UnrecoverableOn(BadRequestException))` ends it |
| **A filter returns a value** | **completes with that value**. That is Nest's semantics, and what a filter recovering from an error wants. To fail the job, throw |
| A filter rethrows | fails with what it threw |
| `UnrecoverableJobError` or `job.fail()` | `dead`, as without Nest |

`JobForbiddenError`'s `name` is `UnrecoverableJobError`'s, which is what bun-jobs keys on.
Nest's own denial is told apart by its message, `"Forbidden resource"`, so a guard's own
`ForbiddenException` with that same message is treated alike.

`UnrecoverableOn(...types)` is a filter that rethrows those errors as
`UnrecoverableJobError`, with the original as `cause`, and leaves a route's error alone.
`BaseJobExceptionFilter` is a base whose `catch` rethrows: a subclass decides, and
`super.catch` says "still a failure".

**Nest logs every unfiltered job error**, at `error` with its stack, once per attempt, as
it does for microservices. For less noise, put a catch-all `@Catch()` filter on the class
that rethrows: a filter that matches means that logging never runs.

### Typed handlers

The typed form of `@Process` takes the `@QueueToken` class first, and checks the handler
against it at compile time. The types come from the `BunQueue` the token extends, with
nothing else to declare:

```ts
@Processor(EmailsQueue)
export class EmailProcessor {
  // Checked: the payload, the result and the name.
  @Process(EmailsQueue, "welcome")
  async welcome(job: Job<Email, string>, ctx: ProcessorContext) { return `sent:${job.data.to}`; }

  // Pipes and parameter decorators: the payload type is your word.
  @Process("digest")
  async digest(@JobData(new StandardSchemaPipe(DigestSchema)) data: Digest) { … }
}
```

A parameter decorator cannot see its parameter's type, so the typed form **refuses** a
handler written with them, and the two styles are exclusive per method. The decorated form
gets its safety at run time, from the pipe or the queue's schema, which also covers a
producer and a consumer in different deployments. `QueueJobData`, `QueueJobResult` and
`QueueJobName` read the same types out of a token.

**Don't put `@Cacheable` or `@CachePut` on a handler.** It would cache across jobs, so a
later job would complete with an earlier one's result without running: a `ConfigError` at
boot. Cache inside the method. `@Throttle` does nothing for a job: use `rate` and the
per-name limits.

### Request-scoped processors

With `scope: Scope.REQUEST`, or a dependency on a request-scoped provider, each job
gets a fresh instance through Nest's public `ModuleRef.resolve`, at a cost of tens
of microseconds per job. **`REQUEST` is the job**:

```ts
@Processor("emails", { scope: Scope.REQUEST })
export class TenantEmails {
  constructor(@Inject(REQUEST) private readonly job: Job<{ tenant: string }>) {}
  …
}
```

- **A `ContextIdStrategy` is global, and receives the job here** where it receives
  an HTTP request elsewhere, so one that reads `request.headers` must handle a job.
  A durable tree per tenant is the obvious use, and `isBunJob(value)` tells the two
  apart:

  ```ts
  attach(contextId, request) {
    const tenant = isBunJob(request) ? request.data.tenant : request.headers["x-tenant"];
    …
  }
  ```

- **Nothing is written on the job.** So a provider calling
  `ContextIdFactory.getByRequest(this.request)` itself inside a job's tree gets a
  fresh context, not the job's.
- **Nest runs no lifecycle hook on a scoped instance**, so its worker has no drain
  of its own: it drains last, [below](#starting-and-draining).

### Files and other threads: `registerWorker`

A `@Process` method runs in-process, and any other `target` on a `@Processor` is a
`ConfigError`, since a function cannot be sent to another thread or process.
Off-thread work is a processor **file**, as a worker the module owns, so it starts
and drains with the others:

```ts
BunJobsModule.registerWorker({
  queue: "images",
  processor: new URL("./processors/resize.ts", import.meta.url),
  options: { target: { kind: "child-process", spawn: { passEnv: ["S3_BUCKET"] } }, concurrency: 4 },
});
```

A file has no Nest pipeline and no DI of its own. A queue takes a file or
`@Processor` classes, never both, since either would claim the other's jobs.

### The registry: `@DefineJob`

bun-jobs' registry gives every job of a name its defaults (attempts, backoff,
timeout, per-name concurrency) wherever it is added from. Its Nest form is a method
decorator on any provider:

```ts
@Injectable()
export class ReportJobs {
  @DefineJob("send-report", { attempts: 5, backoff: { type: "exponential", delay: 1000 }, concurrency: 2 })
  async sendReport(job: Job<{ month: string }>) { … }
}

await jobs.now("send-report", { month: "may" }); // the name checked, the defaults applied
```

At bootstrap the module calls `jobs.define()` for each, and `jobs.start()` once. The
difference from `@Process` is bun-jobs': a defined job lives on the registry queue
(`registryQueue`, by default `"jobs"`), and a name nobody defines stays a retryable
`ConfigError`, for a deployment that does define it. `{ context }` picks a named
context, and `forRoot({ token: AppJobs })` keeps a typed registry's compile-time
checks where it is injected.

### Events

bun-jobs has four event sources, and a decorator for each, attached at bootstrap before
any worker starts:

| Decorator | Hears | Where it may sit |
|---|---|---|
| `@OnWorkerEvent(event)` | this process's worker for the class's queue, which classes on one queue share | a `@Processor` class |
| `@OnQueueEvent(queue, event, { context? })` | that queue's emitter: local events, plus other processes' published ones if the queue was registered with `subscribe: true` | any singleton provider |
| `@OnJobsEvent({ kind?, type?, target?, context? })` | **every process's** published events in the namespace: queues, runners, workers and summoning | any singleton provider |
| `@OnRunnerEvent(id, event, { context? })` | a runner's emitter. The runner must exist by bootstrap | any singleton provider |

```ts
@Processor("emails")
export class EmailProcessor {
  @Process("welcome")
  welcome(job: Job) { … }

  @OnWorkerEvent("failed")
  failed(job: Job, error: Error) { … }

  @OnWorkerEvent("completed:welcome")   // only jobs named `welcome`
  welcomed(job: Job, result: unknown) { … }

  @OnWorkerEvent(EmailsQueue, "completed") // the payload typed from the queue's token
  sent(job: Job<Email, string>, result: string) { … }
}

@Injectable()
export class Audit {
  @OnJobsEvent({ kind: "queue", type: "completed", target: "emails" })
  completed(event: JobsEventOf<"queue", "completed">) { … }
}
```

**The method's parameters are checked against the event at compile time**, and a scoped
form exists only for the job events that have one. A method can carry several.

- **An error in a listener is logged, never rethrown**, with the class and method, thrown
  or rejected, and affects no job. bun-jobs swallows a synchronous throw in silence, and an
  `async` listener's rejection would otherwise be unhandled.
- **Listeners do not run through the Nest pipeline.** A listener observes, so a guard or a
  pipe has nothing to decide.
- **A listener needs a singleton.** On a request-scoped class, or a transient one, it is a
  `ConfigError` at boot, as is `@OnWorkerEvent` on a class with no `@Processor`.
- **Nothing is heard that was never published.** A cross-process event needs
  `publishEvents: true` (or `publish` per object) in the process producing it. The module
  logs one `warn` at bootstrap when an `@OnJobsEvent` exists and this process's context,
  when the module built it, does not publish. It cannot know about other processes, so read
  it as a reminder.
- **The notifier is opt-in.** The module opens one only if an `@OnJobsEvent` exists,
  following the union of what they name, or `"all"` when one leaves `target` out. Worker
  events cost a second subscription per queue, so a decorator with no `kind` follows queues
  and runners, and `kind: "worker"` asks for workers. It closes on `app.close()`.

`@InjectJobsNotifier(context?)` injects a `JobsNotifier` of its own, for a provider that
wants the stream (`notifier.on("event", …)`, or `for await`). It is opened only when a class
asks for it, and to hear workers call `notifier.hold("worker", queue)`.

### Scheduling: `@Cron` and `@Every`

```ts
@Injectable()
export class Maintenance {
  @Cron("0 3 * * *", { tz: "Europe/London", name: "nightly-cleanup" })
  async nightly(@JobSignal() signal: AbortSignal) { … }

  @Every("5 minutes", { immediately: true })
  async refreshRates() { … }
}
```

Each is **a bun-jobs repeat series**, added at bootstrap on `scheduleQueue`, or on
`{ queue }`. A worker there runs each occurrence through the pipeline, so guards,
parameter decorators and `attempts` all apply. **It runs once per occurrence across every
replica**, since an occurrence's id comes from the series and its due time.

|  | `@nestjs/schedule` | `@Cron` here |
|---|---|---|
| Runs | in every replica, on a local timer | once per occurrence, cluster-wide, as a job |
| Survives a restart mid-run | no | yes: retries, `attempts`, the stalled sweep |
| In the management API and the UI | no | yes: repeatables, runs, logs, analytics |
| Needs a backend | no | yes: a driver with queue state, which every built-in one has |
| `@Interval(ms)` / `@Timeout(ms)` | yes | `@Every(ms)`; a one-shot is `@Every(ms, { limit: 1 })` |

They are different tools, and the integration does not import `@nestjs/schedule`: a
per-replica timer, refreshing a local cache say, belongs there. The names clash only on
import, so alias one side.

- **The series key is `name`, else `<Class>.<method>`**, and it is the job's name too, so a
  restart updates the series rather than adding one. Renaming the class or method leaves
  the old series behind unless `name` is given.
- **The options** are bun-jobs' `tz`, `limit`, `startAt`, `endAt`, `immediately` and
  `catchUp`, and the job options `attempts`, `backoff`, `timeout` and `deadLetter`, beside
  `context`, `enhancers`, `onDenied` and `onInvalid`.
- **`@Every` takes** what `every` reads: milliseconds, a duration (`"1h 30m"`), a cron
  expression, or words (`"every monday"`). Its occurrences fall on one grid every replica
  agrees on, multiples of the interval from the epoch unless you give `startAt`, so the
  first comes within one interval of the boot rather than exactly one after it.
- **`immediately`** runs when the series is created, not at every restart. Two replicas
  creating it in the same moment can each run it once.
- **Checked at boot.** A cron expression, a zone or an interval it cannot read is a
  `ConfigError` naming the class and method, before anything is written. So are two series
  with one key, and a schedule beside `@Process` on one method. A series that has finished,
  a `limit` reached or an `endAt` passed, is not a failure.
- **An operator's off survives a deploy.** After `queue.disableRepeatable(key)`, or the UI's,
  adding the series again at the next boot does not re-enable it. `@Cron(expr, { disabled:
  true })` declares a series without adding it, and does not stop one already stored.
- **A removed decorator leaves its series behind**, and its next occurrence fails here with
  "No @Process, @Cron or @Every handler". Deleting it automatically is unsafe during a rolling
  deploy, where the old version still declares it, so the module logs one `warn` naming every
  stored series that nothing in this process declares. `pruneSchedules: true` removes them
  instead, for an app that deploys one version at a time. It looks only at a queue this process
  schedules on, or its own `scheduleQueue` with `pruneSchedules`, so a service that schedules
  nothing leaves another's series alone; so removing the *last* `@Cron` warns about nothing.
  It counts only a series whose job name is its key, as these decorators add them.

### Runners: `registerRunner`

A `BunRunner` runs a **file** on a schedule or on demand, so a DI method cannot be its handler.
Runners get registration rather than a decorator:

```ts
BunJobsModule.registerRunner({
  id: "cleanup",
  file: new URL("./runners/cleanup.ts", import.meta.url),
  schedule: "0 */10 * * * *",
  executionMode: "child-process",
  args: { days: 30 },
});
```

It takes `jobs.runner()`'s options and `context`. The runner starts at bootstrap, unless
`autoStart: false`, and stops when workers drain. `@InjectRunner(id, context?)` injects it where
this module is imported, for `trigger()`, `pause()`, `kill()` and `updateSchedule()`, and
`@OnRunnerEvent("cleanup", "failed")` listens to it.

Use `@Cron` for a method that should run once cluster-wide on a schedule, and a runner for a
script with its own process, a single-run lock, kill escalation and run logs.

### Starting and draining

**Workers start at `onApplicationBootstrap`**, so whatever another module opens in
its `onModuleInit` is ready, and global enhancers added between
`NestFactory.create()` and `init()` are in place. A job added earlier waits there;
it is queued state, so nothing is lost. With `autoStart: false`, discovery still runs
but nothing claims a job until `BunJobsLifecycle.start()`, for tests and summoned
processes; `stop()` parks the workers (jobs in flight finish, and `start()` resumes
them). Both act on every context, or the one named.

**Each worker drains in its processors' own `onModuleDestroy`.** Nest destroys a
processor before the modules it imports and before global modules, so a job in flight
finishes before what it uses goes. The module installs that hook on each singleton
instance, chained to the class's own, which still runs, once, afterwards. Classes on
one queue share the worker, and the first destroyed closes it.

| Where a job's service lives | Nest 11 | Nest 12 |
|---|---|---|
| a module the processor's module imports | finishes | finishes |
| a `@Global` module | finishes | finishes |
| **the processor's own module** | **destroyed under the job** | finishes |

On **Nest 11**, a module's providers are destroyed at the same time, so a resource in
a processor's own module closes while its jobs drain: give the resources their own
module. Nest 12 orders them by dependency, so the processor goes first.

What has no instance to hook drains last, in the jobs module's own
`onModuleDestroy`: a request-scoped processor, a `registerWorker` file and a runner. A
request-scoped processor's services may already be gone by then, so give it resources
that outlive the close, or a job it can stop on its signal.

Queues stay open until `onApplicationShutdown`, so a provider's `onModuleDestroy` can
still enqueue, and then a context the module built closes.

`shutdown.timeout` (30 s) is each worker's budget: a job still running at the timeout
has its signal aborted and its lock left to lapse for the stalled sweep. Set it below
your platform's grace period. Nest runs none of this on `SIGTERM` unless the app calls
`app.enableShutdownHooks()`.

### The checks at boot

The module checks the application before any job can run, in `onModuleInit` for
registrations and in `onApplicationBootstrap` for processors (the rules are under
[workers](#workers-processor-and-process)), and fails the boot with one bun-common
`ConfigError` that lists every problem:

- **Two registrations of one queue with different options**, naming the modules
  that imported them. A queue's options apply only when it is created, and bun-jobs
  would warn and ignore the later set; a declarative registration can say so up
  front. Data compares by value and `schema`, `logger`, `dateParser` and
  `publishGate` by identity, so register one schema object rather than two that
  read alike. A registration with no options asks for nothing and never conflicts.
  A `registerQueueAsync` that finds the queue already created by a bare
  registration counts as different too, rather than losing its options.
- **Two `forRoot()`s for one context.** Give the others a `name`.
- **Decorator metadata that is off.** Bun reads `experimentalDecorators` and
  `emitDecoratorMetadata` from the `tsconfig.json` of the **working directory**,
  not the file's ([oven-sh/bun#28605](https://github.com/oven-sh/bun/issues/28605)),
  and with them off it drops parameter decorators without a word, so Nest injects
  `undefined`. The check names the classes that would get it, and the directory:
  run from the application's root, or set both options in that `tsconfig.json`.
  bun-nest's own classes apply their decorators by call, so they work either way,
  and an application whose classes do have their metadata (built ahead of time,
  say) boots without one.

The two `ConfigError` classes are different ones: these checks throw bun-common's,
as bun-nest's other modules do, and what bun-jobs throws (a bad `namespace`, a
closed context) is bun-jobs' own and passes through as it is.

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

`@kingsleyweb/bun-jobs` is an *optional* peer, and only the `./jobs` subpath's
declarations import it. Measured on a consumer project with the packed package
installed and bun-jobs absent:

| Import | `skipLibCheck: false` | `skipLibCheck: true` |
|---|---|---|
| `@kingsleyweb/bun-nest` (the barrel) | **0 errors** | **0 errors** |
| `@kingsleyweb/bun-nest/jobs` | **2 × `TS2307`**, "Cannot find module `@kingsleyweb/bun-jobs`", in `dts/jobs/*.d.ts` | no error, but `JobsApi`, `JobsApiConfig` and the options' `jobs` are silently `any` |

At runtime the subpath fails with "Cannot find module
`@kingsleyweb/bun-jobs`", and the barrel loads. Installing
`@kingsleyweb/bun-jobs` makes the subpath type-check and load. The import
path resolves either way — `@kingsleyweb/bun-nest/jobs` and
`@kingsleyweb/bun-nest/lib/jobs` are both exports of this package — so the
failure is the missing peer, not a bad specifier. The barrel's 0 is the point
of the split, and the declaration build enforces it: it fails if any entry
other than the jobs subpath can reach a declaration that imports bun-jobs.

## The cache module

[`@kingsleyweb/bun-cache`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-cache/README.md)'s
caches, provided to a Nest application by a module, with caching decorators
for service methods and an interceptor caching routes' responses. It lives on
its own entry point,
**`@kingsleyweb/bun-nest/cache`**, never in the barrel, and needs
`@kingsleyweb/bun-cache` installed (an optional peer):

```ts
import { memoryDriver, sqliteDriver } from "@kingsleyweb/bun-cache";
import { BunCacheModule, Cacheable, CacheEvict, InjectCache } from "@kingsleyweb/bun-nest/cache";
import type { Cache } from "@kingsleyweb/bun-nest/cache";

@Module({
  imports: [
    BunCacheModule.forRoot({ driver: memoryDriver(), ttl: 60_000, isGlobal: true }),
    BunCacheModule.forRootAsync({
      name: "reports",
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ driver: sqliteDriver({ path: config.get("CACHE_DB") }) }),
    }),
  ],
})
export class AppModule {}

@Injectable()
export class UsersService {
  constructor(@InjectCache() private readonly cache: Cache) {}

  @Cacheable({ key: (id: number) => `user:${id}`, ttl: 60_000, tags: (id) => [`user:${id}`] })
  async findUser(id: number): Promise<User> { … }

  @CacheEvict({ tags: (id: number) => [`user:${id}`] })
  async updateUser(id: number, patch: Partial<User>): Promise<User> { … }
}
```

**Staying on `@nestjs/cache-manager` for now?** bun-cache's
`toKeyvStore(cache)` (`@kingsleyweb/bun-cache/keyv`) is a Keyv store, so
`CacheModule.register({ stores: [toKeyvStore(cache)] })` puts any bun-cache
driver under `CACHE_MANAGER` without this module — with `keyv` pinned to
5.6.0, and without tags, the stale windows or cross-process locks. See bun-cache's
[Keyv and `@nestjs/cache-manager`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-cache/README.md#keyv-and-nestjscache-manager).

### Modules, names and shutdown

- **`forRoot(options)`** takes `createCache`'s options (the module creates the
  cache) or `{ cache }`, a cache made elsewhere, plus `name` and `isGlobal`.
  **`forRootAsync({ name?, isGlobal?, imports?, inject?, useFactory })`**
  builds the same from a factory, sync or async.
- **The default cache** (no `name`) is provided under `BUN_CACHE` and injected
  with `@InjectCache()`; its options under `BUN_CACHE_OPTIONS`. **A named
  cache** is provided under `getCacheToken(name)` and injected with
  `@InjectCache(name)`. Both tokens are exported from the module; `isGlobal`
  makes them injectable everywhere without importing it.
- **One cache per name per application.** The decorators find caches by name
  across the whole application, so a second module registering the same name
  fails the bootstrap.
- **The module closes only what it created**, at `onApplicationShutdown`; a
  cache passed in as `{ cache }` is yours to close. It closes there, not at
  `onModuleDestroy`, because `app.close()` runs
  `onModuleDestroy → beforeApplicationShutdown → dispose() → onApplicationShutdown`,
  and `dispose()` is where the HTTP server drains the requests still in
  flight, which may still use the cache.

### `@Cacheable`, `@CachePut`, `@CacheEvict`

Spring's names and semantics, on service methods:

| Decorator | What it does |
|---|---|
| `@Cacheable(options?)` | returns the cached value for the key, or runs the method through the cache's `getOrSet` and stores its result. Concurrent calls with one key share one run (single-flight), and `getOrSet`'s options apply: `ttl`, `staleWhileRevalidate`, `staleIfError`, `lock`, `softTimeout`, `hardTimeout`, `refreshAhead`, `cacheUndefined`, … |
| `@CachePut(options?)` | always runs the method, then stores its result (`set`'s options: `ttl`, `tags`, …) |
| `@CacheEvict(options)` | after the method succeeded, deletes `key`, invalidates `tags`, or with `all: true` clears the cache's namespace; `beforeInvocation: true` evicts before it runs, so a method that throws still evicts. It needs at least one of `key`, `tags` and `all` |

Every decorator takes `key`, `cache` (a cache's `name`; the default cache
otherwise) and `condition(...args)`, which decides before the method runs
whether to use the cache at all. `@Cacheable` and `@CachePut` also take
`unless(result, ...args)`, which decides after it ran whether **not** to store
the result. `tags` is an array or a function of the arguments.

**Keys.**

- **A function** of the method's arguments. Its parameter types are checked
  against the method's: `key: (id: string) => …` on a method taking a
  `number` is a compile error. The other function options (`tags`,
  `condition`, `unless`) are typed from the same parameters, so annotate
  `key` and leave them bare.
- **A template**, positional: `"orgs:{0}:page:{1.page}"` reads the first
  argument and the second's `page`; `{{` and `}}` write a brace. Parameter
  names are not available at run time, so `{id}` is refused when the class is
  defined. A placeholder that is out of range, `undefined`, or an object
  throws on the call, rather than letting calls share a key.
- **The default**, with no `key`: `ClassName.method:` plus a SHA-256 of the
  arguments, serialised with plain objects' keys sorted. A `Map` or a `Set` is
  serialised in insertion order, which is not stable: pass `key` when the
  arguments are such objects.

**What gets cached.**

| The method… | `@Cacheable` | `@CachePut` |
|---|---|---|
| resolves a value | stored, returned | stored, returned |
| resolves `null` | stored (`null` is a value) | stored |
| resolves `undefined` | not stored (a miss reads as `undefined`), unless `cacheUndefined` | the key is **deleted**, so a later read answers what the method returned |
| resolves, and `unless` says `true` | not stored; the result still reaches every caller sharing the run | not stored; the entry already there is left |
| throws | every caller sharing the run gets the error, nothing is stored, and the next call runs again; inside `staleIfError`, the stale value is served instead | nothing is stored; the error is rethrown |

`@CachePut` computes its key and tags **after** the method ran, so a key read
from an argument the method fills in (an assigned id) sees it.

**Typing.** Only methods returning a `Promise` type-check: a cached value can
only come back asynchronously, and the wrapper always returns one.

**How a method finds its cache.** Decorators run when the class is defined,
before any container exists, so the wrapper looks its cache up on each call:
from the instance (`this`) to the application that created it, then by name.
Two applications in one process (two test apps, an HTTP app beside a
microservice) never share a cache through one class. A request-scoped or
transient provider is matched by its class. Where the cache cannot be found
the call throws **`CacheNotReadyError`** (with `cacheName` and `method`),
saying why: called before `app.init()` (from a constructor or a provider
factory), on an instance made with `new`, after the application closed,
without its `this`, or naming a cache no module registered.

**Not supported:**

- static methods: decorating one throws when the class is defined;
- controller handlers: a handler's return value is not the response, and
  [the cache interceptor](#the-cache-interceptor) is the tool for routes;
- standard (TC39) decorators: like Nest's own, these are
  `experimentalDecorators` decorators.

The wrapper keeps the method's name, length and `reflect-metadata` entries,
so Nest decorators applied before it (below it in the source) still read
their metadata.

### The cache interceptor

`BunCacheInterceptor` caches a route's **responses**. It runs
[`@kingsleyweb/bun-cache/http`](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-cache/README.md)'s
`cacheResponse()` inside Nest's pipeline, on the route's own `BunRequest` and
`BunResponse`, so it is the same response cache as on a router — keys,
`Vary` variants, the refuse-to-store rules, `ETag` and `304`, `Age`,
`X-Cache`, coalescing, hit-for-miss, stale-while-revalidate, stale-if-error,
`HEAD` and the invalidation of unsafe methods — with one difference that is
the reason it exists: it runs **after Nest's guards**. Router middleware runs
before them, so a route behind a guard is cached here.

```ts
import { BunCacheInterceptor, CacheKey, CacheTags, CacheTTL, NoCache } from "@kingsleyweb/bun-nest/cache";

@UseGuards(AuthGuard)
@UseInterceptors(BunCacheInterceptor)
@CacheTTL(30_000)
@Controller("posts")
export class PostsController {
  @CacheTags("posts")
  @Get()
  list(@Query("page") page = "1") { … }       // one entry per query string

  @CacheKey((ctx) => `post:${ctx.switchToHttp().getRequest().params.id}`)
  @CacheTTL(async (ctx) => (await isHot(ctx)) ? 5_000 : 60_000)
  @Get(":id")
  one(@Param("id") id: string) { … }

  @NoCache()
  @Get("drafts")
  drafts() { … }

  @Post()
  create(@Body() body: NewPost) { … }          // a 2xx drops the cached GET /posts
}
```

| Decorator | What it sets (on a handler, or a controller; the handler's wins) |
|---|---|
| `@CacheKey(key)` | the key, a string or a function of the `ExecutionContext`, in place of the path, the query and `varyBy` (the response's own `Vary` still applies). A key also lets a request carrying `Authorization` be stored: it is taken to cover the requester's identity, so put the user in the key on a per-user route |
| `@CacheTTL(ms)` | how long an answer stays fresh, in **ms**: a number, or a function of the `ExecutionContext`, sync or async. It overrides the freshness headers and the cache's TTL, not the refusals (`no-store`, `private`). `0` stores nothing |
| `@CacheTags(...tags)` | tags for the stored answers, strings or one function of the `ExecutionContext`, beside the path's own tag; `addCacheTags(res, …)` from `@kingsleyweb/bun-cache/http` adds more from the handler. `cache.invalidateTags([tag])` drops them |
| `@NoCache()` | leaves the route out: no read, no store, no invalidation |

**Options.** `BunCacheInterceptor.with(options)` makes an interceptor class
with `cacheResponse()`'s options (`ttl`, `varyBy`, `query`, `host`, `bypass`,
`statusHeader`, `honorRequest`, `allowSetCookie`, `statuses`, `omitHeaders`,
`invalidateOnUnsafe`, `coalesce`, `uncacheableTtl`, `etag`,
`staleWhileRevalidate`, `staleIfError`, `hardTimeout`, `streams`, `revalidate`)
plus `cache`, a cache's `name` (the default cache otherwise). They are checked
when the class is made. Three defaults differ from `cacheResponse()`'s:

- **`ttl`** is `"headers-or-cache"` (below);
- **`statuses`** is `[200, 203, 204]`, so no exception's answer is stored (a
  `NotFoundException`'s 404 included);
- **`revalidate`** is the application's HTTP adapter, whose socket-free
  `fetch()` replays a stale-while-revalidate refresh through Nest's whole
  pipeline. `false` turns the replay off: a stale entry is answered once and
  the next request refreshes it.

`ttl` defaults to `"headers-or-cache"`: without `@CacheTTL` (or
`with({ ttl })`), an answer's own `Cache-Control`/`Expires` lifetime is
used — `@Header("Cache-Control", "max-age=60")` or bun-common's
`cacheControl()` — and when it has none, the cache's own TTL
(`BunCacheModule.forRoot({ ttl })`, `createCache`'s; with none set, no
expiry), as `@nestjs/cache-manager`'s interceptor falls back to its store's.
The refusals apply either way: `no-store`, `private`, a cookie, `statuses`.
`with({ ttl: "headers" })` stores only what the headers give a lifetime.

```ts
@UseInterceptors(BunCacheInterceptor.with({ cache: "pages", varyBy: ["accept-language"], staleWhileRevalidate: 60_000 }))
```

**How it fits Nest's pipeline.**

- **A hit** answers from the cache before the handler: the pipes, the handler
  and every interceptor **inside** this one do not run. Interceptors outside
  it see the value `undefined` (the response is already sent, and Nest's
  `reply()` leaves it), so a serialising or wrapping interceptor outside it
  must tolerate `undefined`. Guards run first, always.
- **What is stored is the response** — status, headers, bytes — captured
  where the answer is committed, whatever produced it: Nest's `reply()`, an
  exception filter, or a **`@Res()` handler's** own `res.json()`, which is
  therefore cached too.
- **Exceptions** are answered by Nest's filters on the same response, and are
  not stored (`statuses`). With a stale entry inside `staleIfError`, a 5xx a
  filter answers is replaced by the stale answer, `X-Cache: STALE`.
- **`@Validate`.** Written **above** `@UseInterceptors(BunCacheInterceptor)`,
  `@Validate`'s interceptor runs inside the cache's: a hit skips the request
  checks, and an invalid request can still be answered from an entry another
  request stored under the same key (a `@CacheKey` that ignores the query, say).
  Written **below** it, `@Validate` runs first: request checks on every
  request, and its response check skips a response already sent (the hit).
  Either way, an answer `@Validate` refuses is a 500 and never stored.
- **A before-write hook** (bun-nest's `addBeforeWriteHook`, which `@Validate`
  uses on `@Res()`, `StreamableFile` and redirect routes) runs after the
  answer is captured; when one refuses it, the interceptor drops the path's
  stored entries, and drops them again once the write in flight lands
  (`cacheResponse`'s `invalidate()` does so), so the refused answer is never
  served from the cache — a sent file's, read back after the refusal, too.
- **Never cached**: `@Sse()` routes (passed through untouched), a
  `StreamableFile` or any streamed answer unless `streams: { buffer }` says
  so, and anything the response's `Cache-Control` refuses. A request with
  `Authorization` is stored only under a `@CacheKey` or an answer that allows
  it (`public`, `s-maxage`), per RFC 9111 §3.5.
- **Only `GET`** is cached (and `HEAD`, from `GET`'s entry), also under a
  `@CacheKey` — `@nestjs/cache-manager` caches any method under one. A
  `POST`, `PUT`, `PATCH` or `DELETE` the interceptor sees that answers 2xx or
  3xx drops its path's entries. Only HTTP: in a microservice or a gateway the
  interceptor passes through.
- **A stale-while-revalidate replay** carries only the headers the key reads,
  and goes through the guards: behind a guard that needs credentials it is
  refused, and the entry is refreshed by the first request after the window
  instead.
- **It needs this package's `BunHttpAdapter`**: on another platform's response
  it throws.

**From `@nestjs/cache-manager`.** Its `@CacheKey()` and `@CacheTTL()` write
metadata this interceptor reads (`cache_module:cache_key`,
`cache_module:cache_ttl`) when ours are absent, so a controller moving from
its `CacheInterceptor` keeps them; `@CacheTTL()` is in ms in both.

### Installing bun-cache is what makes the subpath compile

`@kingsleyweb/bun-cache` is an *optional* peer, and only the `./cache`
subpath's declarations import it. The barrel never reaches it: the consumer
check type-checks and imports `@kingsleyweb/bun-nest` in a project without
bun-cache installed, and the declaration build fails if any entry other than
`./cache` (and `./lib/cache`) can reach a declaration that imports it. At
runtime the subpath fails with "Cannot find module `@kingsleyweb/bun-cache`",
while `@kingsleyweb/bun-nest/lib/cache/tokens` and `…/lib/cache/errors`,
which import nothing, load without it.

## Throttling

Two layers, which can be used together:

- **The adapter's `throttle` option** is bun-common's `throttle()`
  middleware, run ahead of everything: every route, Nest middleware, every
  guard and the not-found handler, so a burst of 404s counts too. One budget
  per client across the application, refused with bun-common's `429`
  problem document before Nest sees the request. Nest's decorators do not
  reach it. See bun-common's
  [Throttling](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/README.md#throttling).
- **`BunThrottlerModule` and `BunThrottlerGuard`** are
  [`@nestjs/throttler`](https://github.com/nestjs/throttler) 6's API over
  the same `throttle()`: named throttlers counted **per route per client**,
  `@Throttle()` and `@SkipThrottle()` on controllers and routes, a
  `ThrottlerException` (`429`) through Nest's exception layer, and any
  bun-common `ThrottleStore` (memory by default, Redis or SQL through
  bun-cache).

```ts
import {
  BunHttpAdapter,
  BunThrottlerGuard,
  BunThrottlerModule,
  minutes,
  SkipThrottle,
  Throttle,
} from "@kingsleyweb/bun-nest";
import { Controller, Get, Module, Post } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";

@Controller("auth")
class AuthController {
  // Two limits on one route, each keyed its own way.
  @Throttle({
    account: { limit: 10, ttl: "1m", getTracker: (req) => `${req.ip}|${req.body?.email}` },
    address: { limit: 30, ttl: minutes(1) },
  })
  @Post("sign-in")
  signIn() {}

  @SkipThrottle()
  @Get("health")
  health() {}
}

@Module({
  imports: [BunThrottlerModule.forRoot({ throttlers: [{ limit: 600, ttl: "1m" }] })],
  controllers: [AuthController],
  providers: [{ provide: APP_GUARD, useClass: BunThrottlerGuard }],
})
class AppModule {}

const app = await NestFactory.create(
  AppModule,
  // Optional: a coarse limit on everything, 404s included, ahead of Nest.
  new BunHttpAdapter(0, { throttle: { limit: 3000, window: "1m" } }),
);
```

### Module options

`BunThrottlerModule.forRoot(options)` takes `{ throttlers, ...options }` or
a bare array of throttlers; `forRootAsync({ imports, useFactory, inject })`,
`({ useClass })` or `({ useExisting })` (a `BunThrottlerOptionsFactory`)
builds them while the application boots. The module is global. Options are
checked at boot: a bad one fails it with a `ConfigError`.

| Option | Default | Description |
|---|---|---|
| `throttlers` | (required) | The named throttlers: `{ name?, limit, ttl, allowSubSecond?, skipIf?, ignoreUserAgents?, getTracker?, generateKey?, algorithm?, headers?, skipSuccessfulRequests?, skipFailedRequests? }`. `name` defaults to `"default"`; `limit` and `ttl` may be functions of the `ExecutionContext`. |
| `ttl` (per throttler) | (required) | A duration: `"1m"`, `"30s"`, `{ minutes: 1 }`, `seconds(60)`. **Never a bare number** (a type error and a boot error), and under a second only with `allowSubSecond: true`. |
| `skipIf` | none | `(context) => boolean \| Promise<boolean>`: requests it answers `true` for are not counted. On a throttler it applies to that throttler only; on the module, to every throttler without its own. |
| `ignoreUserAgents` | none | `RegExp[]`: matching `User-Agent`s are not counted (a throttler's list wins over the module's). |
| `getTracker` | the address | `(req, context) => string`: who a request counts against. Default `req.ip`, an IPv6 address reduced to `ipv6SubnetPrefix`, `"unknown"` without one. Per throttler, per module, per `@Throttle()`, or by overriding the guard's `getTracker()`. |
| `generateKey` | per route, hashed | `(context, tracker, name) => string`: the counter key. Default SHA-256 of controller, handler, throttler and tracker, as `@nestjs/throttler`: one count per route per client, and no address or account in the store's keys. |
| `ipv6SubnetPrefix` | `56` | The IPv6 prefix the default tracker keeps; `false` keeps the whole address. |
| `store` | one memory store | Any bun-common `ThrottleStore`. Every guard of the module shares it. `cacheThrottleStore(cache)` from `@kingsleyweb/bun-nest/cache` holds a limit across processes and instances. |
| `algorithm` | `"sliding-window"` | `"sliding-window"`, `"fixed-window"` or `"gcra"` (bun-common's), per module or per throttler. |
| `skipSuccessfulRequests`, `skipFailedRequests` | `false` | express-rate-limit's (bun-common's `throttle()` options): once the response is sent, a successful (or a failed) request is given back, so only failures (or only successes) count: `@Throttle({ default: { skipSuccessfulRequests: true } })` on a login route counts failed logins alone. Per module, per throttler and per `@Throttle()`. A refusal is a `429`, so `skipFailedRequests` gives it back too. `@nestjs/throttler` has neither. |
| `requestWasSuccessful` | `res.statusCode < 400` | `(req, res) => boolean`: what the two options above call success, read once Nest has answered (an exception counts by the status it was answered with). |
| `headers` | `false` | `"legacy"` sends `@nestjs/throttler`'s `X-RateLimit-Limit`/`-Remaining`/`-Reset` (suffixed `-<name>` for a throttler not named `default`, with `Retry-After-<name>` on a refusal); `"ietf"` or `true` the IETF draft's `RateLimit-Policy`/`RateLimit`; `"both"`. A `429` always carries `Retry-After`: the longest wait among the throttlers that refused. |
| `failMode` | `"open"` | When the store fails: `"open"` lets requests through (with a warning at most every 10 s), `"closed"` answers `503` (`ServiceUnavailableException`), a `ThrottleStore` counts in that store instead. |
| `errorMessage` | `"ThrottlerException: Too Many Requests"` | The exception's message, or `(context, detail) => string`; `detail` is a `BunThrottlerLimitDetail` (`name`, `limit`, `ttl`, `tracker`, `totalHits`, `timeToBlockExpire`, …). |
| `logLimited` | `false` | `true` (or a Nest log level) logs one line per refusal naming the controller, handler, throttler and limit, never the tracker. |
| `prefix` | `"throttler"` | The namespace of the store keys. |
| `guardCheck` | `"error"` | The boot check below: `"error"` logs, `"throw"` fails the boot, `false` skips it. |
| `globalGuard` | `false` | Installs `BunThrottlerGuard` as an `APP_GUARD` from the module itself. Off by default, as global guards run in the order modules provide them. For `forRootAsync`, give it beside `useFactory`. |

### `@Throttle()` and `@SkipThrottle()`

- `@Throttle({ name: { limit?, ttl?, getTracker?, generateKey? } })` on a
  controller or a route overrides the named module throttler's fields there,
  each field separately; the route's win over its controller's.
- A name the module does **not** define declares a throttler for those routes
  only, which then needs both `limit` and `ttl` (on the route, its
  controller, or between the two); the boot fails otherwise, naming the
  route. Two such names give a route two limits with their own trackers, as
  the sign-in route above.
- `@SkipThrottle()` skips the throttler named `default` only, not every
  throttler; `@SkipThrottle({ burst: true })` skips `burst`;
  `@SkipThrottle({ default: false })` on a route re-enables what its
  controller skipped.
- To **replace** the default throttler on a route rather than add to it,
  skip it and declare another:
  `@SkipThrottle() @Throttle({ strict: { limit: 5, ttl: "1m" } })`.

Each throttler not skipped counts the request, in parallel, and a request
is refused when any of them refuses; a refused request counts against all of
them (bun-common's count-then-check).

### The guard

`BunThrottlerGuard` counts only HTTP requests (`context.getType() ===
"http"`); a gateway or microservice context passes. Install it as an
`APP_GUARD`, with `@UseGuards(BunThrottlerGuard)` on a controller or route,
with `app.useGlobalGuards(new BunThrottlerGuard(app.get(BunThrottlerService)))`,
or with `forRoot({ globalGuard: true })`.

Subclass it to change a step, as with `ThrottlerGuard`: `getTracker(req,
context)`, `generateKey(context, tracker, name)`, `shouldSkip(context)`,
`getErrorMessage(context, detail)` and `throwThrottlingException(context,
detail)` are `protected`. Its one constructor dependency is declared
explicitly (`@Inject(BunThrottlerService)`, applied by call), never read from
emitted `design:paramtypes`, so a subclass without a constructor of its own
resolves under any compiler settings. A subclass that declares a constructor
declares its parameter the same way:

```ts
@Injectable()
class ByUserGuard extends BunThrottlerGuard {
  constructor(@Inject(BunThrottlerService) service: BunThrottlerService) {
    super(service);
  }

  protected override getTracker(req: BunRequest) {
    return Promise.resolve(String(req.headers["x-user-id"] ?? req.ip));
  }
}
```

**The boot check.** Importing the module throttles nothing by itself. Once
the application has booted, the module looks for a `BunThrottlerGuard` (or a
subclass) among the global guards (`APP_GUARD` and `useGlobalGuards()`, read
from Nest's application config, the same on Nest 11 and 12) and in every
controller's and route's `@UseGuards()`, and logs an error when there is
none (`guardCheck: "throw"` fails the boot instead). It also works out every
route's throttlers then, so a misconfigured `@Throttle()` fails the boot
rather than its first request. Applications without an HTTP adapter are not
checked.

**At run time**, `BunThrottlerService` (injectable anywhere) changes a
module throttler for every guard from the next request:
`service.update("default", { limit: 1200 })`. Counts carry over a limit
change; a `ttl` change starts fresh counts.

### A shared store

```ts
import { createCache, redisDriver } from "@kingsleyweb/bun-cache";
import { cacheThrottleStore } from "@kingsleyweb/bun-nest/cache";

const cache = createCache({ driver: redisDriver({ url: Bun.env.REDIS_URL }) });
BunThrottlerModule.forRoot({ throttlers: [{ limit: 600, ttl: "1m" }], store: cacheThrottleStore(cache) });
```

`cacheThrottleStore` is re-exported from the `./cache` subpath, where
bun-nest's optional dependency on bun-cache starts; `BunThrottlerModule`
itself is in the package root and never reaches bun-cache.

### Migrating from `@nestjs/throttler`

| `@nestjs/throttler` 6 | bun-nest |
|---|---|
| `ThrottlerModule.forRoot({ throttlers })`, `forRootAsync(...)` | `BunThrottlerModule.forRoot(...)`, `forRootAsync(...)`: same shapes (object or array, `useFactory`/`useClass`/`useExisting`) |
| `ThrottlerGuard` as `APP_GUARD` | `BunThrottlerGuard`, same overridable methods |
| `@Throttle({ default: { limit, ttl } })`, `@SkipThrottle()`, `@SkipThrottle({ name: false })` | the same, same precedence (route over controller, field by field) |
| `seconds()`, `minutes()`, `hours()`, `days()`, `weeks()` | the same names; they return a duration object (`{ seconds: 60 }`), not milliseconds, so `ttl: seconds(60)` migrates unchanged |
| `ttl: 60000` (milliseconds) | **refused**: write `"1m"` or `seconds(60)`. A bare number is ambiguous; `ttl: 60` meant 60 ms there, which turns throttling off |
| `ThrottlerException`, its message and `errorMessage` | the same (`429`, `"ThrottlerException: Too Many Requests"`); `errorMessage`'s detail is `BunThrottlerLimitDetail` |
| `getTracker`, `generateKey`, `skipIf`, `ignoreUserAgents` | the same, module-wide or per throttler; `getTracker` also per `@Throttle()` |
| `X-RateLimit-*` headers on by default (`setHeaders`) | **off by default**: `headers: "legacy"` sends the same headers and suffixes; `setHeaders` is refused with that hint |
| `storage` (a `ThrottlerStorage`) | `store`: a bun-common `ThrottleStore` (`memoryThrottleStore()`, `cacheThrottleStore(cache)` for Redis/SQL); `storage` is refused with that hint |
| fixed windows | **sliding window** by default (no double burst across a window edge); `algorithm: "fixed-window"` counts as `@nestjs/throttler` does |
| `blockDuration` | **not supported** yet: a refused client is refused only until its count falls back under the limit; refused at boot |
| throttlers checked in `ttl` order, stopping at the first that blocks | every throttler counts the request, and a **refused request counts** against all of them |
| `ipv6SubnetPrefix` default `64` | default `56` (bun-common's, express-rate-limit 8's) |
| `@Throttle()` with an unknown name: ignored | declares a throttler for those routes (needs `limit` and `ttl`) |
| a forgotten guard throttles nothing, silently | the boot check logs an error (`guardCheck`) |
| `InjectThrottlerOptions()`, `InjectThrottlerStorage()` | `@Inject(BUN_THROTTLER_OPTIONS)`, and `BunThrottlerService` (its `store`, `throttlers`, `update()`) |

## Exported API

Everything below is exported from the package root; see
[`lib/index.ts`](./lib/index.ts). The two exceptions are
[`BunJobsModule`](#jobs-bunjobsmodule) and
[the jobs API module](#the-jobs-api-module), which are exported **only** from
`@kingsleyweb/bun-nest/jobs` (equivalently `@kingsleyweb/bun-nest/lib/jobs`),
and [the cache module](#the-cache-module), exported **only** from
`@kingsleyweb/bun-nest/cache` (equivalently `@kingsleyweb/bun-nest/lib/cache`).

| Group | Exports |
|---|---|
| Cache module (subpath only) | `BunCacheModule`, `InjectCache`, `getCacheToken`, `BUN_CACHE`, `BUN_CACHE_OPTIONS`, `Cacheable`, `CachePut`, `CacheEvict`, `CacheNotReadyError`, `BunCacheInterceptor`, `CacheKey`, `CacheTTL`, `CacheTags`, `NoCache`; types `BunCacheInterceptorOptions`, `BunCacheModuleOptions`, `BunCacheModuleAsyncOptions`, `CacheableOptions`, `CachePutOptions`, `CacheEvictOptions`, and bun-cache's `Cache`, `CreateCacheOptions`, `GetOrSetOptions`, `SetOptions` re-exported; `cacheThrottleStore` (types `CacheThrottleStore`, `CacheThrottleStoreOptions`), bun-cache's throttle store, for [Throttling](#throttling) |
| Jobs module (subpath only) | `BunJobsModule`, `InjectQueue`, `InjectBunJobs`, `InjectWorker`, `QueueToken`, `Processor`, `Process`, `DefineJob`, `Cron`, `Every`, `InjectRunner`, `getRunnerToken`, `OnWorkerEvent`, `OnQueueEvent`, `OnJobsEvent`, `OnRunnerEvent`, `InjectJobsNotifier`, `getJobsNotifierToken`, `JobsHost`, `WorkerRef`, `BunJobsLifecycle`, `isBunJob`, `BunJobsExecutionContext`, `isBunJobsContext`, `JobData`, `JobId`, `JobName`, `CurrentJob`, `JobContext`, `JobSignal`, `JobProgress`, `JobLogger`, `JobAttempt`, `JobForbiddenError`, `UnrecoverableOn`, `BaseJobExceptionFilter`, `JobLoggingInterceptor`, `getBunJobsToken`, `getQueueToken`, `getWorkerToken`; types `CronOptions`, `EveryOptions`, `ScheduleOptions`, `RegisterRunnerOptions`, `JobsEventKind`, `JobsEventOf`, `OnEventOptions`, `OnJobsEventOptions`, `TypedListenerDecorator`, `BunJobsContextType`, `JobDataOptions`, `JobPipe`, `JobProgressFn`, `OnDenied`, `OnInvalid`, `QueueJobData`, `QueueJobName`, `QueueJobResult`, `TypedProcessDecorator`, `BunJobsModuleOptions`, `BunJobsModuleAsyncOptions`, `BunJobsModuleContextOptions`, `BunJobsContextOptions`, `BunJobsBuildOptions`, `BunJobsBorrowOptions`, `BunJobsRunOptions`, `BunJobsShutdownOptions`, `BunJobsOptionsFactory`, `BunJobsQueueOptions`, `BunJobsWorkerOptions`, `RegisterQueueOptions`, `RegisterQueueAsyncOptions`, `RegisterWorkerOptions`, `ProcessorOptions`, `ProcessOptions`, `DefineJobOptions`, `QueueTokenClass`, and bun-jobs's `BunJobsOptions`, `BunQueueOptions`, `BunQueueWorker`, `Job`, `JobDefinitionOptions`, `NameLimits`, `ProcessorContext`, `BunQueueEvents`, `BunQueueWorkerEvents`, `BunRunnerEvents`, `DriverEvent`, `JobsNotifier`, `JobsNotifierOptions`, `BunRunner`, `BunRunnerOptions` |
| Jobs API module (subpath only) | `BunJobsApiModule`, `InjectJobsApi`, `BUN_JOBS_API`, `BUN_JOBS_API_OPTIONS`; types `BunJobsApiModuleOptions`, `BunJobsApiModuleAsyncOptions`, and bun-jobs's `JobsApi`, `JobsApiAction`, `JobsApiAuthorize`, `JobsApiConfig` re-exported so they can be named without importing bun-jobs directly |
| HTTP adapter | `BunHttpAdapter`, `BunNestHttpAdapter`; types `ListenCallback`, `MiddlewareFactoryRespType`, `RenderOptions`, `VersionedRoute`, `WebsocketOptions`, `BunRequestHook`, `BunResponseHook`, `BunBeforeWriteHook`, `BunBeforeWriteContext`, `BunBeforeWriteResponseContext`, `BunBeforeWriteErrorContext`, `BunBeforeWriteBody` |
| WebSocket adapter | `BunWebSocketAdapter`, `BunNestWebsocketAdapter`, `MessageEventTypes`; types `BunWebSocketAdapterOptions`, `BunWebSocketAdapterOptionsFromHttpAdapter`, `BunWebSocketAdapterNormalOptions`, `BunWebSocketGatewayOptions`, `BunWebsocketHttpAdapter`, `BunNestWebSocketClient`, `WsResponse`, `WsResponseTransform`, `WsAckFunction`, `WsEmitFunction`, `WsEventMap`, `WsEncodedArg`, `WsEncodedArgs` |
| Packets | types `MessageFormat`, `MessagePacket`, `MessagePacketMap`, `MessageConnectType`, `MessageDisConnectType`, `MessageEventType`, `MessageAckType`, `MessageErrorType`, `MessageBinaryEventType`, `MessageBinaryAckType` |
| Re-exported from bun-common | `requestParsing` (type `RequestParsingOptions`); types `BunWebSocketOptions`, `BunWebSocketServerType`, `BunWebsocketHandlerFor`, `WebSocketClient`, `WebSocketClientData` |
| Uploads | `FileInterceptor`, `FilesInterceptor`, `FileFieldsInterceptor`, `AnyFilesInterceptor`, `NoFilesInterceptor`, `getMultipartRequest`, `transformUploadException`; type `UploadExceptionBody` |
| Decorators | `UploadedFile`, `UploadedFiles` (Nest's own) |
| [Typed clients](#typed-clients-documents-from-controllers) | `Describe`, `DevTypesModule`, `Invalidates`; type `DevTypesModuleOptions` |
| [Throttling](#throttling) | `BunThrottlerModule`, `BunThrottlerGuard`, `BunThrottlerService`, `BUN_THROTTLER_OPTIONS`, `Throttle`, `SkipThrottle`, `ThrottlerException`, `throttlerMessage`, `seconds`, `minutes`, `hours`, `days`, `weeks`; types `BunThrottlerModuleOptions`, `BunThrottlerModuleConfig`, `BunThrottlerModuleAsyncOptions`, `BunThrottlerOptions`, `BunThrottlerOptionsFactory`, `BunThrottlerLimitDetail`, `BunThrottlerGetTracker`, `BunThrottlerGenerateKey`, `ThrottleDecoratorOptions`, `Resolvable` |
| [Validation](#validation) | `StandardSchemaPipe`, `SchemaDto`, `StandardValidationPipe`, `ValidationExceptionFilter`, `StandardValidationModule`, `StandardValidationException`; type `StandardValidationPipeOptions` |

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
| `02-http-adapter` | [`pipeline.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/pipeline.ts) | guards, pipes (`StandardSchemaPipe` among them), exception filters and interceptors; not-found and error handlers |
| `02-http-adapter` | [`adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/adapter-options.ts) | adapter options, `enableCors`, static assets, body parsing and raw bodies, the logger, server introspection, `fetch()`, `close()` |
| `02-http-adapter` | [`views.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/views.ts) | `@Render()` and `res.render()` with a view engine: `setBaseViewsDir`, `setViewEngine`, `engine(ext, fn)`, `setLocal`, both view lookups, how locals merge, and the errors when a view or engine is missing |
| `02-http-adapter` | [`express-parity.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/express-parity.ts) | what `@nestjs/platform-express` users rely on: `HEAD` on `@Get()`, late `next()`, the request timeout, redirect bodies, host matching, the static-prefix redirect, `clearCookie`, invalid JSON, and the [known differences](#known-differences-from-nestjsplatform-express) checked as deliberate |
| `02-http-adapter` | [`undecodable-bodies.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/undecodable-bodies.ts) | a body that does not parse, refused before any guard by default; routed to the controllers with `router: { acceptUndecodableBody: true }` (guard first, `req.bodyDecodingError` through `@Req()`), or to a mounted bun-common router built with it |
| `02-http-adapter` | [`per-route-parsing.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/per-route-parsing.ts) | `requestParsing()` applied per route with `consumer.apply()`, and raising one route's body limit |
| `02-http-adapter` | [`query-method.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/query-method.ts) | HTTP `QUERY`: `@QueryMethod()` and `RequestMethod.QUERY` from Nest 11.2.0, the adapter's own `query()` on every version |
| `02-http-adapter` | [`security.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/security.ts) | `useSecurityHeaders()` and `enableCsrfProtection()` (Nest 12.1): the `403` and its headers, the body read only once allowed, errors raised outside a route |
| `02-http-adapter` | [`shutdown.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/shutdown.ts) | `app.close()` draining requests in flight (`closeDrainTimeout`), `return503OnClosing`, `forceCloseConnections`, `beforeClose`, `listen()` on a unix socket and a bad port |
| `02-http-adapter` | [`responses.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/responses.ts) | a status Express refuses (`0`, `NaN`) on Nest 12, a `StreamableFile` whose client leaves, a handler that writes and then throws |
| `02-http-adapter` | [`hooks.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/hooks.ts) | `setOnRequestHook`, `setOnResponseHook` and `addBeforeWriteHook`: refusing or holding a response before it is written |
| `02-http-adapter` | [`route-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/route-options.ts) | Nest 12's `routeResolutionStrategy` and `routeConflictPolicy` (`NestFactory.create()` options), with duplicate and shadowed routes |
| `02-http-adapter` | [`middleware-matching.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/02-http-adapter/middleware-matching.ts) | which requests a middleware runs for: `exclude()` matched as the router matches (`getRouteMatchingOptions()`, Nest 12.2.0), `forRoutes("*")` under a global prefix |
| `03-file-uploads` | [`interceptors.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/03-file-uploads/interceptors.ts) | every upload interceptor, `@UploadedFile(s)`, memory, disk and custom storage, upload errors, interceptor-side parsing |
| `03-file-uploads` | [`module-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/03-file-uploads/module-options.ts) | `MulterModule.register()` / `registerAsync()`, platform-express's own `MulterModule`, route options over the module's |
| `03-file-uploads` | [`removal-errors.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/03-file-uploads/removal-errors.ts) | a custom storage whose `removeFile` rejects: the reply still sent, the failure logged through Nest's logger |
| `04-websockets` | [`gateway-basics.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/04-websockets/gateway-basics.ts) | lifecycle hooks, `@MessageBody`, `@ConnectedSocket`, `WsResponse` vs a plain return, Promise and Observable replies, `@Ack` |
| `04-websockets` | [`message-formats.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/04-websockets/message-formats.ts) | every packet type on the wire, binary frames, malformed and unroutable frames, exceptions |
| `04-websockets` | [`adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/04-websockets/adapter-options.ts) | the `websocket` option, auth on upgrade, client data, namespaces, gateway ports, broadcasting, a standalone adapter |
| `04-websockets` | [`custom-adapter.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/04-websockets/custom-adapter.ts) | subclassing the adapter and wiring it with `app.useWebSocketAdapter` |
| `05-jobs-api` | [`module.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/05-jobs-api/module.ts) | `BunJobsApiModule.forRoot`, `@InjectJobsApi()`, authorized requests against the mounted API, and what `app.close()` closes |
| `06-jobs-ui` | [`mount.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/06-jobs-ui/mount.ts) | the bun-jobs management UI, `jobsUi()`, mounted beside `BunJobsApiModule` with `adapter.use()` and served with and without a socket |
| `08-openapi` | [`swagger-module.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/08-openapi/swagger-module.ts) | [OpenAPI with `@nestjs/swagger`](#openapi-with-nestjsswagger): `createDocument` + `SwaggerModule.setup` on `BunHttpAdapter`, the JSON document, the UI page and its bundled assets, a mutating route beside the docs |
| `07-validation` | [`standard-validation.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/07-validation/standard-validation.ts) | [Validation](#validation): `StandardValidationModule` with a `SchemaDto` body, `StandardSchemaPipe` on a query and a param, `ValidationExceptionFilter` over HTTP, WebSocket and a microservice, a gateway's `@UsePipes(...StandardValidationModule.gatewayPipes())` (and the double run a plain `@UsePipes` gives on Nest 12), `stripProtoKeys`, Nest 12's `@Body({ schema })` beside them, `forRoot({ messages })` |
| `14-throttle` | [`throttling.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/14-throttle/throttling.ts) | [Throttling](#throttling): `BunThrottlerModule` with a global per-route limit, `@Throttle()` with two per-route trackers, a route that replaces the default, `@SkipThrottle()`, a service exemption by `skipIf`, `headers: "legacy"`, the adapter's `throttle` option counting 404s, a store shared by two applications, and the boot check |
| `14-throttle` | [`refunds.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/14-throttle/refunds.ts) | `skipSuccessfulRequests` and `skipFailedRequests` per module and per `@Throttle()`, `requestWasSuccessful`, a per-plan `limit` |

**Option tours** exercise every option of one part of the API and assert the
result, so a failed check fails the script:

| File | Covers |
|---|---|
| [`10-options/http-adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/10-options/http-adapter-options.ts) | every `BunHttpAdapter` constructor option and public method, inside and outside a Nest application |
| [`10-options/interceptor-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/10-options/interceptor-options.ts) | every upload interceptor, its arguments, every `UploadOptions` field and `getMultipartRequest` |
| [`10-options/websocket-adapter-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/10-options/websocket-adapter-options.ts) | every WebSocket adapter constructor shape, method, option and packet type |
| [`10-options/jobs-api-module-options.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/10-options/jobs-api-module-options.ts) | every `BunJobsApiModule` option, the `bunJobsApi` marker, registration order and attaching across an adapter swap |
| [`13-trust-proxy/client-ip.ts`](https://github.com/kingsloob1/bun-node/blob/develop/examples/bun-nest/13-trust-proxy/client-ip.ts) | `app.set("trust proxy")`, `@Ip()` and a host-scoped controller behind a trusted proxy, `behindCloudflare()`, a gateway client's `client.data.ip` |

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
bun run lint                 # lint
bun run format:check         # check the formatting
bun test                     # tests
```

A change to bun-common also needs bun-nest's checks. The typed verb overloads
on `BunHttpAdapter` are generated; regenerate them from `packages/bun-common`
with `bun scripts/generate-verb-overloads.ts` rather than editing them.

## License

[MIT](https://choosealicense.com/licenses/mit/)
