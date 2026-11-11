# Changelog

Every package under `packages/` is released together, at one version.
Newest first. `bun scripts/changelog.ts <version>` writes an entry from the
commits since the previous tag; `docs/releasing.md` is the whole flow.

## 3.0.1 (2026-11-11)

<!-- changelog: hand-written; scripts/changelog.ts never replaces it -->

A patch release with two fixes, in bun-jobs and in bun-common's document
types (with bun-nest's). All seven packages move to 3.0.1 together, as they
always do. It was cut from `v3.0.0` on the maintenance branch
`releases/3.0.x`, so it carries none of what `develop` gained after 3.0.0
(#769's `repeatables.update`, #770's named dev documents): those come with
3.1.0.

```bash
bun add @kingsleyweb/bun-jobs@3.0.1 @kingsleyweb/bun-common@3.0.1
```

### Fixes

- **bun-jobs: a re-added repeat series now runs with its new payload**
  ([#767](https://github.com/kingsloob1/bun-node/issues/767)). Calling
  `queue.add(name, data, { repeat: { key, … } })` again for an existing
  series updated its stored definition, as the README says, but every later
  occurrence kept running with the **old** payload. That happened whenever
  the schedule was unchanged; with a changed `every` or `cron` the occurrence
  already pending still ran once with the old data. Now:
  - each next occurrence takes its name and payload from the series' stored
    definition, not from the occurrence that just finished;
  - a re-add replaces the payload of the occurrence already scheduled, while
    it is still waiting or delayed, whether or not the schedule changed
    (through `updateJob`, so an occurrence a worker has claimed keeps the
    data it was claimed with).

  A payload a processor changed with `job.updateData()` on one occurrence no
  longer carries over to the next: that was one run's data, not the
  series'. The workaround, `removeRepeatable(key)` before the re-add, is no
  longer needed. Tested on every backend: memory, file, SQLite, Postgres,
  MySQL, MariaDB, Redis and MongoDB.

- **bun-common: `docsRouter()` takes the jobs API's document without a
  cast** ([#771](https://github.com/kingsloob1/bun-node/issues/771)).
  `docsRouter({ openapi: () => api.openapi() })` was a type error:
  `JobsApi.openapi()` writes OpenAPI `3.1.0`, and `docsRouter`'s `openapi`
  took only bun-common's own `OpenApiDocument`, pinned to the `3.1.2` its
  generator writes. At run time it already served the document. The inputs
  now take any `3.1.x` document, the new `OpenApi31Document` type:
  `docsRouter`'s `openapi`, the function form of `devTypes()`'s `openapi`, and
  bun-nest's `DevTypesModule.forRoot({ openapi })`. `OpenApiDocument`, what
  `generateOpenApi` returns, stays pinned to `"3.1.2"`, so nothing that reads
  a generated document changes. bun-jobs' README shows serving its documents
  through `docsRouter`, and `JobsApi.asyncapi()`, which is `undefined` when
  the API has no socket, checked first.

## 3.0.0 (2026-11-10)

<!-- changelog: hand-written; scripts/changelog.ts never replaces it -->

The first final release of the 3.x line. All seven packages are released together at 3.0.0, on npm's `latest` tag, so a plain install gets them:

```bash
bun add @kingsleyweb/bun-common
bun add @kingsleyweb/bun-nest @nestjs/common @nestjs/core rxjs reflect-metadata
bun add @kingsleyweb/bun-jobs
```

For bun-common and bun-nest this is a **major release after 2.2.0**. bun-contract, bun-client, bun-jobs, bun-cache and bun-ui had only 3.0.0 release candidates before.

| Package | What it is |
|---|---|
| [`@kingsleyweb/bun-common`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-common) | An Express 5 style HTTP framework for `Bun.serve` |
| [`@kingsleyweb/bun-nest`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-nest) | Runs a NestJS 11 or 12 app on Bun, on top of bun-common |
| [`@kingsleyweb/bun-contract`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-contract) | The contract core shared by server and browser |
| [`@kingsleyweb/bun-client`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-client) | A typed client for a bun-common or bun-nest API |
| [`@kingsleyweb/bun-jobs`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-jobs) | Background jobs: queues, workers and scheduled scripts |
| [`@kingsleyweb/bun-cache`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-cache) | One cache API over 12 storage drivers, plus an HTTP response cache |
| [`@kingsleyweb/bun-ui`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-ui) | Every browser UI in one package: `/jobs` and `/docs` |

### Read this first: middleware that guards a path can stop guarding it

**In bun-nest, a `forRoutes` entry that names a method no longer runs on the paths below it**, as on Express. Middleware on `{ path: "admin", method: RequestMethod.GET }` runs on `/admin`, not on `/admin/users`. **An authentication or authorisation middleware that relied on the old match silently stops protecting those paths, and the routes keep answering.** An app moved from Express is safe, because that protection never existed there. Check every app written against bun-nest 2.2.0 or an earlier 3.0.0 candidate.

To keep the match, use `forRoutes("admin")` for every method, or `{ path: "admin{/*rest}", method: RequestMethod.GET }` for one. `{ path: "*", method: RequestMethod.ALL }` is unaffected. Each route of `forRoutes(Controller)` also matches as a route now: before, it could run twice, or on a path with no route.

### Upgrading from 2.2.0

The candidates' entries below have the details; this is the whole list, in the order to check them.

- **Bun 1.4.2 or later** (`engines.bun`), with optional `@types/bun >=1.4.2` and `typescript ^5.9.3 || ^6.0.0` peers.
- **An `exports` map** in each package, with built declarations in `dts/`. Every 2.2.0 import of a file under `lib/` still resolves; a file outside `lib/`, or a directory import with a trailing slash, does not.
- **Express 5 route paths** (path-to-regexp 8): a named wildcard is an array under its name, `{…}` is an optional group, and a malformed path throws `PathSyntaxError` when it is registered.
- **`X-Forwarded-*` is read only through `trustProxy`**, Express 5's `trust proxy`, off by default. With it off, `req.ips` is `[]` and `req.protocol` (and so `req.secure`) is the scheme the request arrived on. In 2.2.0 they believed `X-Forwarded-For` and `X-Forwarded-Proto` from any client. `trustProxy` (or Nest's `app.set("trust proxy", …)`) names the proxies to believe, and then `req.ip` is the forwarded client.
- **A body declared JSON must be an object or an array**, and its charset `utf-*`: anything else answers `400` or `415`. `strictJson: false` (or `useBodyParser("json", { strict: false })`) turns it off.
- **`Logger` is structured**: six levels, each `(message, fields?)`, plus `child()` and `isLevelEnabled()`. Options accept any `LoggerLike` (pino, winston, bunyan, consola, log4js, tslog, Nest's logger, a console).
- **bun-nest's Nest packages are peers**: install `@nestjs/common`, `@nestjs/core` (`^11.1.20 || ^12.0.0`) and `rxjs` in your app.
- **`close()` drains** requests in flight for up to `closeDrainTimeout` (10 s).
- **The middleware pipeline follows Express 5**, and bun-nest matches paths case-insensitively by default, as `@nestjs/platform-express` does.
- **bun-nest `forRoutes` with a method** (above).
- **bun-nest WebSockets**: a message with an ack id is acknowledged automatically, a `WsException` reaches the client as an `"exception"` event, and two new limits apply (`maxConcurrentMessages`, `maxSendBufferSize`).

"Upgrading from 2.2.0" under 3.0.0-rc.0 has the steps, with code.

### Changed since 3.0.0-rc.2

- **bun-nest `./jobs/terminus`, the jobs health indicator:**
  - a worker parked with `BunJobsLifecycle.stop()` or remote control reads as **up** and is listed in `parked`; it read as down;
  - a worker whose `run()` ended while the application did not reads as **down**; it read as up;
  - `queues` left out now reads the queues this application registers or runs a worker on, not every queue the backend knows; `queues: "all"` reads the first 100 by name and says what it left out in `queuesNotRead`;
  - `requireWorkers` on a driver with no worker records reads as up, with `workers: "unknown"`, rather than down for good.

  A probe that watched `stopped` in the details now reads `parked`.
- **`JobForbiddenError` has its own code, `JOB_FORBIDDEN`**, kept in a stored job's `failedReason.code`. Its `name` is unchanged, so bun-jobs still treats the failure as final.
- **`runJob` and `drainJobs`** (`./jobs/testing`) reject with a `ConfigError` on an application with no jobs context. On an application from `NestFactory.create` with its default `abortOnError`, they ended the process instead.

### New since 3.0.0-rc.2

- **bun-common: per-event variants on server-sent events.** `sseVariants({ admin: { when, data }, user: { data } })` declares an event as several whole shapes, chosen per event, as `variants()` does for an HTTP status. `send({ event, variant, data })` is typed per variant, and `when` decides which ones a stream's request may receive. The documents describe each event as an `anyOf` with `x-variants`.
- **bun-common: broadcast SSE channels, `createSseChannel()`** (`@kingsleyweb/bun-common/sse`). It encodes an event once for every subscriber, and adds:
  - initial state for each new subscriber;
  - a replay buffer for `Last-Event-ID`;
  - topics;
  - one heartbeat per channel;
  - a transport between processes;
  - `subscribe()`, `handler()`, `response()` (native routes), `attach()` and `listen()`.

  With `contract`, `send()` and `sendList()` are typed by an SSE contract and checked before encoding, so a bad event is refused to the caller and never broadcast.
- **bun-nest: `channelObservable(channel, options)`**: a broadcast channel behind `@Sse()`, with `Last-Event-ID` replay, topics, `@SseSignal()` and a heartbeat, written the same way on every Nest release.
- **Packaging:** bun-jobs and bun-ui declare `repository`, `homepage` and `bugs`, as the other packages do. Every package's README is now its user documentation only, with links that work on npm.

### Tested with

- Bun 1.4.4-canary.1+11c367163, against the 1.4.2 floor's types.
- NestJS 12.4.2 (the lock), 12.2.0, 11.2.9 and 11.2.7.

### Known and still open

- `oven-sh/bun#48380`: a `Response` or `Request` built from a string keeps a BOM. It does not affect a body received over a socket.
- `oven-sh/bun#44232`: Bun accepts a request with two `Host` headers.

## 3.0.0-rc.2 (2026-11-09)

<!-- changelog: hand-written; scripts/changelog.ts never replaces it -->

The third release candidate of 3.0.0. It fixes a bug where a refused request could run a bun-jobs route, brings bun-jobs into NestJS with decorators and the Nest pipeline, and makes bun-nest pass on every Nest release up to 12.4.1. Install it from npm's `next` tag:

```bash
bun add @kingsleyweb/bun-common@next
bun add @kingsleyweb/bun-nest@next @kingsleyweb/bun-jobs@next
```

### Read this first: middleware that guards a path can stop guarding it

**A `forRoutes` entry that names a method no longer runs on the paths below it**, as on Express. Middleware on `{ path: "admin", method: RequestMethod.GET }` runs on `/admin`, not on `/admin/users`. **An authentication or authorisation middleware relying on the old match silently stops protecting those paths, and the routes keep answering.** An app moved from Express is safe, because that protection never existed there; check any app written against bun-nest.

To keep the match, use `forRoutes("admin")` for every method, or `{ path: "admin{/*rest}", method: RequestMethod.GET }` for one. `{ path: "*", method: RequestMethod.ALL }` is unaffected.

### Fixed: a refused request could run a bun-jobs route

A route with an optional body read a body bun-common had refused as "no body", and ran on its defaults. A `POST` to `/queues/mail/drain` with a bad `Content-Encoding` answered `200` and emptied the queue. The caller had to be authorized for the route already, so this was not a way past `authorize`. The same gap covered `summon`, job `retry`, runner `trigger`, `resume` and `kill`, the worker actions and provider `validate`. Such a request now answers `400` or `415`, and upgrading from rc.1 is recommended for this alone.

### Breaking changes since rc.1

Coming from 2.2.0, read the entries below first.

- **`forRoutes` naming a method** matches as a route (above). So does each route of `forRoutes(Controller)`, which could also run twice, or on a path with no route.
- **A body declared JSON must be an object or an array**, on every bun-common and bun-nest server. A top-level `null`, number, string or boolean answers `400`, and a charset that is not `utf-*` answers `415`. `charset=utf8` is still accepted, a deliberate difference from Express. Turn strictness off with the request option `strictJson: false`, `parseBody.contentTypes.json.opts.strict`, or `useBodyParser("json", { strict: false })`. A body with no `Content-Type` is unchanged.
- **`PUT /queues/:queue/limits` no longer takes `null`.** `DELETE /queues/:queue/limits` removes a queue's limits. The jobs UI uses it.

### bun-jobs in NestJS

`@kingsleyweb/bun-nest/jobs` now has the whole producer and consumer side ([plan](docs/plans/nest-jobs-decorators/README.md)):

- **`BunJobsModule`**, with `@InjectQueue`, `@InjectBunJobs` and typed `@QueueToken` classes.
- **`@Processor` and `@Process`**, one worker per queue, starting at bootstrap and draining on `app.close()`, with request scope and `@DefineJob`.
- **The Nest pipeline around a job**: guards, interceptors, pipes, filters and global enhancers, with parameter decorators such as `@JobData()` and `@CurrentJob()`. A guard's denial or a validation failure ends the job with no retry, unless `onDenied` or `onInvalid` says otherwise.
- **Events and scheduling**: `@OnWorkerEvent` and its siblings, and `@Cron` and `@Every` as repeat jobs, once per occurrence across replicas.
- **`runSummonedApplication`, `createProcessorContext`, `@RemoteHandler`** and `BunRemoteExecutorModule`.
- **`guardsAuthorize`**, so Nest guards decide `authorize` for the management API and the jobs UI. It fails closed.
- **`./jobs/testing`** (`BunJobsTestingModule`, `runJob`, `drainJobs`) and **`./jobs/terminus`** (a health indicator, with `@nestjs/terminus` as an optional peer).

### bun-nest on current Nest

- **Nest 12.3 to 12.4.1 work.** A probe of Nest's internals crashed from 12.3.0, and `GET /<prefix>/` skipped middleware Express runs.
- **Nest 11.2.8 and 11.2.9 pass.** Files an upload stored are removed when a pipe rejects the request, and a WebSocket exception whose `cause` cannot be serialised reaches the client without it.
- **On 12.3 and later,** a returned `Error` at 400 or above answers `{ statusCode, message }`, so its enumerable properties no longer reach the client. Over-limit bodies reach `@Catch(HttpException)`. On earlier releases a returned `Error` still sends its properties, as Express does there.
- **A `StreamableFile` failing mid-body** resets the connection from 11.2.8 and 12.3.0, rather than reading as a complete `200`.
- **On every release,** `HEAD` of a `StreamableFile` keeps its length and closes its source, `Content-Type` is completed as `res.set()` does, and a returned symbol sends its string. A returned function stays an empty answer, a deliberate difference from Express, which sends its source.
- **`@Emits`**: an invalid emit throws to the caller again once a client's asynchronous writes have drained. It was logged instead for the rest of that client's life.

### bun-jobs

- **`runSummoned` gains `beforeExit` and `beforeExitTimeout`**, for what must close last around a worker, under the hard backstop.
- **`RepeatExhaustedError`** (code `REPEAT_EXHAUSTED`) and the code `NO_SUMMON_POLICY`, both still a `ConfigError`, so a caller need not match a message. `ConfigError` takes an optional `code`.
- **A bare `schema`** (not `{ data: schema }`), which validated nothing, now throws.

### Every package

Every package declares `sideEffects`, proved by a bundle test, and `scripts/publish.ts` refuses one without it. One small export bundles to its own size: bun-jobs' error class went from 1,855,737 bytes to 226.

### Known and still open

- The repository's lock is still on Nest 12.2.0. Moving it to 12.4.1 comes next; 12.4.1 is tested as a matrix column.
- bun-nest's health indicator has follow-ups in progress: a worker parked with `BunJobsLifecycle.stop()` reads as down, and `requireWorkers` is always down on a driver with no worker records when there is demand.
- `oven-sh/bun#48380`: a `Response` or `Request` built from a string keeps a BOM. It does not affect a body received over a socket.

## 3.0.0-rc.1 (2026-11-08)

<!-- changelog: hand-written; scripts/changelog.ts never replaces it -->

The second release candidate of 3.0.0. It adds rate limiting to bun-common,
bun-cache and bun-nest, and the real client address behind a proxy. Live
invalidation now reaches every process, and checks each tag a client asks
for. Every browser UI moves into one new package, `@kingsleyweb/bun-ui`.
Install it from npm's `next` tag:

```bash
bun add @kingsleyweb/bun-common@next
bun add @kingsleyweb/bun-ui@next @kingsleyweb/bun-jobs@next   # the jobs UI
```

### The packages

Seven packages, all at 3.0.0-rc.1. The two UI packages of rc.0 are not
released again: `@kingsleyweb/bun-ui` replaces them, and they are deprecated
on npm.

| Package | What it is | |
|---|---|---|
| [`@kingsleyweb/bun-common`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-common) | An Express 5 style HTTP framework for `Bun.serve` | updated |
| [`@kingsleyweb/bun-nest`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-nest) | Runs a NestJS 11 or 12 app on Bun, on top of bun-common | updated |
| [`@kingsleyweb/bun-contract`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-contract) | The contract core shared by server and browser | updated |
| [`@kingsleyweb/bun-client`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-client) | A typed client for your bun-common or bun-nest API | updated |
| [`@kingsleyweb/bun-jobs`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-jobs) | Background jobs: queues, workers and scheduled scripts | updated |
| [`@kingsleyweb/bun-cache`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-cache) | One cache API over 12 storage drivers, plus an HTTP response cache | updated |
| [`@kingsleyweb/bun-ui`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-ui) | Every browser UI in one package: `/jobs` (the bun-jobs UI) and `/docs` (the API docs viewer) | new |
| `@kingsleyweb/bun-jobs-ui` | Replaced by `@kingsleyweb/bun-ui/jobs` | deprecated |
| `@kingsleyweb/bun-api-docs-ui` | Replaced by `@kingsleyweb/bun-ui/docs` | deprecated |

### Breaking changes since rc.0

Coming from 2.2.0, read the 3.0.0-rc.0 entry below first.

- **The UI packages moved into `@kingsleyweb/bun-ui`**
  ([plan](docs/plans/bun-ui/README.md)). `@kingsleyweb/bun-jobs-ui` is now
  `@kingsleyweb/bun-ui/jobs`, and `@kingsleyweb/bun-api-docs-ui` is now
  `@kingsleyweb/bun-ui/docs`. The old packages are deprecated on npm, not
  shimmed. Only the import specifiers change ("Upgrading from rc.0", below,
  has the full table):

  ```ts
  // 3.0.0-rc.0
  import { jobsUi } from "@kingsleyweb/bun-jobs-ui";
  import { docsUi } from "@kingsleyweb/bun-api-docs-ui";
  // 3.0.0-rc.1
  import { jobsUi } from "@kingsleyweb/bun-ui/jobs";
  import { docsUi } from "@kingsleyweb/bun-ui/docs";
  ```

  - `@kingsleyweb/bun-jobs` becomes an **optional** peer that only `/jobs`
    needs. Installing bun-ui without it no longer warns, and importing
    `/jobs` without it fails with "Cannot find module".
  - The bundles moved from `dist/` to `dist/jobs/` and `dist/docs/`.
  - bun-common's optional peer for `docsRouter`'s `"self-hosted"` viewer is
    now `@kingsleyweb/bun-ui` (`SELF_HOSTED_PACKAGE`). The option keeps its
    name.
- **The jobs UI's generic names are now jobs-shaped**, since bun-ui holds
  more than one UI. No aliases:
  - `UiConfig` is `JobsUiConfig`;
  - `UiSections` is `JobsUiSections`;
  - `UI_CONFIG_ELEMENT_ID` is `JOBS_UI_CONFIG_ELEMENT_ID` (its value, the
    page's element id, is unchanged).

  `UiTheme` keeps its name, as the one theme type every UI shares (the root
  and every `/<ui>/browser`). `DocsUiTheme` is now an alias of it.

  ```ts
  // 3.0.0-rc.0
  import type { UiConfig } from "@kingsleyweb/bun-jobs-ui/lib/shared/config";
  // 3.0.0-rc.1
  import type { JobsUiConfig } from "@kingsleyweb/bun-ui/jobs/browser";
  ```

- **bun-common and bun-nest read `X-Forwarded-*` only through `trustProxy`.**
  This is Express 5's `trust proxy` setting, and it is off by default. In
  rc.0, `req.ips` and `req.protocol` (and so `req.secure`) always believed
  `X-Forwarded-For` and `X-Forwarded-Proto`, which any client can send. Now,
  with trust off:
  - `req.ips` is `[]`;
  - `req.protocol` is the scheme the request arrived on;
  - `X-Forwarded-Host` is ignored (it never moved `req.host`).

  `req.ip` is still the socket peer.

  ```ts
  // A request from a client through nginx on the same host, which sent
  // X-Forwarded-For: 203.0.113.9 and X-Forwarded-Proto: https.

  // 3.0.0-rc.0, with no option: the headers were believed, from anyone
  req.ips; // ["203.0.113.9"]
  req.protocol; // "https"

  // 3.0.0-rc.1, with no option: nothing forwarded is believed
  req.ips; // []
  req.protocol; // "http"

  // 3.0.0-rc.1, trusting the proxy: the headers are believed from it alone
  new BunHttpAdapter(0, { trustProxy: "loopback" });
  req.ip; // "203.0.113.9"
  req.protocol; // "https"
  ```

  Code reading these properties changes with them: bun-jobs' served AsyncAPI
  document picks `ws`/`wss` from `req.secure`, and the jobs UI's CSP picks
  `wss:` from it.
- `req.socket.localAddress` is the socket peer. It was `req.ip`, which is the
  same with trust off.
- **bun-jobs' management API follows the app's trust.** With its own
  `trustProxy` unset (the default), its CSRF and WebSocket upgrade origin
  checks, and its served AsyncAPI server, now read the scheme and host as the
  request does: forwarded ones count when the **app** trusts the proxy. In
  rc.0 they never did. The AsyncAPI server's `host` is the trusted
  `X-Forwarded-Host`; it was always the raw `Host`. `true` (believe the
  headers from any peer) and `false` (never) still override the app's. Any
  other value is now a `ConfigError`, where rc.0 read a truthy value such as
  `1` as `true`:

  ```ts
  // 3.0.0-rc.0
  createJobsApi({ jobs, trustProxy: 1 }); // meant true
  // 3.0.0-rc.1: trust the proxy on the app, and leave the API's unset
  const app = new BunHttpAdapter(0, { trustProxy: 1 });
  createJobsApi({ jobs });
  ```

  `ResolvedJobsApiConfig.trustProxy` is `boolean | undefined` (was
  `boolean`).
- **bun-jobs' `ApiErrorCode` is closed.** It was
  `ApiOwnErrorCode | (string & {})`, so any string was a code. It is now
  `ApiOwnErrorCode | ApiInternalErrorCode | ApiForeignErrorCode`: the API's
  own codes, the bun-jobs codes it passes through as a 500
  (`API_INTERNAL_ERROR_CODES`), and the codes of errors that are not the API's
  (`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `PAYLOAD_TOO_LARGE`,
  `RATE_LIMITED`, `` `HTTP_${number}` ``). At run time, a 500 from a library
  error whose code is not listed answers `INTERNAL`. The status, the title,
  the `detail` and the log are unchanged.

  ```ts
  // A provider error (PROVIDER_THROTTLED) reaching the management API.
  // 3.0.0-rc.0
  { status: 500, code: "PROVIDER_THROTTLED" }
  // 3.0.0-rc.1
  { status: 500, code: "INTERNAL" }
  ```

  A comparison with a code outside the union no longer type-checks.
  `ProblemDto` takes the union as a type parameter
  (`ProblemDto<TCode extends string = ApiErrorCode>`), and `API_ERROR_STATUS`
  moved into the browser-safe `@kingsleyweb/bun-jobs/api/contract` (the
  server still exports it).
- **bun-jobs' OpenAPI document lists only the statuses each operation
  answers.** The per-operation `default` response is gone, and every
  operation carries `x-bun-errors`, the problem codes it documents.
  `components.responses.Problem` stays, as the body of any status an
  operation does not list.
- **`res.write()` emits `drain` only after it returned `false`**, as Node
  does. In rc.0 the buffer was unbounded and `drain` followed every write.
  Now `write()` returns `false` once 64 KiB are queued for the client (the
  chunk is still queued), and `drain` comes when the client has read them
  back under that mark:

  ```ts
  // 3.0.0-rc.0: drain after every write
  res.write(chunk);
  await new Promise((resolve) => res.once("drain", resolve));
  // 3.0.0-rc.1: wait only when write() says so (waiting as above would hang)
  if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve));
  ```

  bun-nest's `@Sse()` pipes into `res.write()`, so it now meets backpressure
  too.
- **bun-cache's `invalidate` event fires once per invalidation.**
  `cacheResponse()` ran a second pass of `pages.invalidate()`, or of an
  unsafe method's invalidation, while a write for the path was still being
  tracked, even one that had already landed or that the invalidation refused.
  That pass fired `invalidate` again, and the README's CDN-purge recipe
  purged twice. Now the second pass, and its event, happen only when a write
  stored after the invalidation began. A listener that counted two events
  per invalidation now sees one.
- **bun-client sends no header for `undefined`.** A header set to `undefined`
  at any level (client, route or call) now sends nothing and leaves the level
  below in place. rc.0 sent the text `"undefined"`, overriding it.

### Upgrading from rc.0

1. **The UI packages.** Swap the packages, then the import specifiers:

   ```bash
   bun remove @kingsleyweb/bun-jobs-ui @kingsleyweb/bun-api-docs-ui
   bun add @kingsleyweb/bun-ui@next
   ```

   | 3.0.0-rc.0 | 3.0.0-rc.1 |
   |---|---|
   | `import { jobsUi } from "@kingsleyweb/bun-jobs-ui"` | `import { jobsUi } from "@kingsleyweb/bun-ui/jobs"` |
   | `import type { UiConfig } from "@kingsleyweb/bun-jobs-ui/lib/shared/config"` | `import type { JobsUiConfig } from "@kingsleyweb/bun-ui/jobs/browser"` (renamed) |
   | `bun add @kingsleyweb/bun-jobs-ui @kingsleyweb/bun-jobs` | `bun add @kingsleyweb/bun-ui @kingsleyweb/bun-jobs` |
   | `import { docsUi } from "@kingsleyweb/bun-api-docs-ui"` | `import { docsUi } from "@kingsleyweb/bun-ui/docs"` |
   | `import … from "@kingsleyweb/bun-api-docs-ui/lib/shared/config"` | `import … from "@kingsleyweb/bun-ui/docs/browser"` |
   | `import … from "@kingsleyweb/bun-api-docs-ui/lib/hosted"` | `import … from "@kingsleyweb/bun-ui/docs/hosted"` |
   | `import { HttpReference } from "@kingsleyweb/bun-api-docs-ui/embed"` | `import { HttpReference } from "@kingsleyweb/bun-ui/docs/embed"` |
   | `"@kingsleyweb/bun-api-docs-ui/embed/unauthorized"` (and the other six `./embed/*`) | `"@kingsleyweb/bun-ui/docs/embed/unauthorized"` (and the same six) |
   | `docsRouter({ viewer: { openapi: "self-hosted" } })` with `bun add @kingsleyweb/bun-api-docs-ui` | the same call, with `bun add @kingsleyweb/bun-ui` |

   Then rename `UiConfig`, `UiSections` and `UI_CONFIG_ELEMENT_ID` as above.
2. **Behind a proxy**, if the app reads `req.ips`, `req.protocol`,
   `req.secure` or a forwarded host, say which proxies to trust, as you would
   on Express:

   ```ts
   new BunHttpAdapter(0, { trustProxy: "loopback" }); // nginx on the same host
   new BunHttpAdapter(0, { trustProxy: 1 }); // one proxy in front, by position
   new BunHttpAdapter(0, { ...behindCloudflare() }); // Cloudflare → app
   new BunHttpAdapter(0, { ...behindRailway() }); // Railway → app
   app.set("trust proxy", 1); // a Nest app, as on platform-express
   ```

   bun-common's README, under
   [Client address behind proxies](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/README.md#client-address-behind-proxies-trustproxy),
   covers what to trust and the spoofing traps. Don't set `trustProxy: true`
   on a server clients can reach directly. bun-jobs' management API follows
   the app's setting: drop a `trustProxy` other than `true` or `false` from
   `createJobsApi()`.
3. **bun-jobs error codes.** Compare `code` with the codes in `ApiErrorCode`,
   and treat a 500 with `INTERNAL` as any server failure.
4. **Streaming.** Wait for `drain` only after `res.write()` returned `false`.

### What's new in each package

#### @kingsleyweb/bun-common

- **Rate limiting.** `throttle(options)` counts each client's requests in a
  store and answers `429` past a limit, as express-rate-limit is used: on a
  router, a mount or a route. The adapters' and `BunRouter`'s `throttle`
  option puts one first in the chain, ahead of every route and the not-found
  handler.

  ```ts
  const app = new BunHttpAdapter(0, {
    throttle: { limit: 600, window: "1m", scope: "route" },
  });
  app.post("/login", throttle({ limit: 10, window: "1m" }), login);
  app.get("/health", skipThrottle(), health);
  ```

  - Several named limits, each with its own `key` and `cost`. A route's
    limit of the same name replaces the outer one, and `skipThrottle()`
    turns them off.
  - Three algorithms: `"sliding-window"` (the default), `"fixed-window"` and
    `"gcra"` (the token bucket).
  - The default key is `req.ip`, as `trustProxy` resolves it, with IPv6
    reduced to its `/56`.
  - `limit` may be a function of the request (a premium account gets more).
  - `skipSuccessfulRequests`, `skipFailedRequests` and
    `requestWasSuccessful`, as in express-rate-limit.
  - `RateLimit-Policy`/`RateLimit` (`headers: "ietf"`) or `X-RateLimit-*`
    (`"legacy"`) headers, off by default.
  - `failMode` (`"open"` by default) says what a store failure does.
  - `onLimited` replaces the `429`, and `logLimited` logs each one.
  - The store is `memoryThrottleStore()`, bounded, or any `ThrottleStore`,
    such as bun-cache's `cacheThrottleStore()` to share a limit across
    processes. A store can count a window itself, by its own clock, in one
    round trip (`countWindow`, `deleteWindow`, `consumeGcra`).
- **The real client address behind proxies.** `trustProxy` on both adapters,
  `BunRouter` and the request options, and `set("trust proxy", value)` on
  both adapters (`app.set()` on a Nest app). It takes every Express value:
  `true`, a hop count, addresses, CIDR ranges, the presets `loopback`,
  `linklocal` and `uniquelocal`, or a function. Through it:
  - `req.ip` is the first untrusted address, walking from the socket
    through `X-Forwarded-For` from right to left (proxy-addr's algorithm);
  - `req.ips` is the trusted chain;
  - `req.protocol`, `req.host` and `req.hostname` read `X-Forwarded-Proto`
    and `X-Forwarded-Host` from a trusted peer.

  The rest of it:
  - **`clientIpHeader`** names a single-value header, such as
    `CF-Connecting-IP`. It is believed only when `trustProxy` trusts the
    whole chain the request came through.
  - **Platform helpers:** `behindCloudflare()` (with a dated
    `CLOUDFLARE_IP_RANGES` snapshot, and an opt-in
    `fetchCloudflareIpRanges()`), `behindRailway()` and `trustChain()`.
  - **`req.proxyChain`** shows how `req.ip` was resolved. **`ws.data.ip`**
    carries an upgrade's `req.ip`, so a gateway sees the real client.
  - **IP helpers** in `native.ts`, as proxy-addr reads addresses:
    `isIpAddress`, `parseIpAddress`, `parseIpRange`, `compileIpMatcher` and
    `IP_RANGE_PRESETS`. The socket shim adds Node's `remoteAddress`,
    `remotePort` and `remoteFamily`.
  - A request asks `server.requestIP()` once, and walks the trust chain
    once, however often `req.ip`, `req.ips` or `req.proxyChain` are read.
- **Testing the client address without a socket.** `fetch()` takes a
  `remoteAddress` (`FetchInit`), reported as a served socket's peer, so
  `req.ip`, `trustProxy` and anything keyed by the address can be tested
  socket-free.
- **Backpressure on `res.write()`**: `false` past 64 KiB queued, `drain` once
  read, and Node's `res.writableNeedDrain` and `res.writableLength`.
- **Keys a schema drops.** `validate(schemas, { unknownKeys })` reports the
  `body` and `query` keys a schema silently stripped: `"strip"` (the
  default, as before), `"warn"` (one log line per request) or `"reject"` (an
  `Unrecognized key` issue per key).
- **Live invalidation across processes.** `liveInvalidation(app, { bus })`
  delivers every invalidation to the subscribers of every process on a
  `LiveBus` (bun-cache's `cacheLiveBus()` makes one from its Redis or
  Postgres bus), and `connectLiveBus(bus)` connects a process that publishes
  without serving. A process delivers its own invalidations at once; a lost
  message becomes a `gap` for the clients.
- **Per-tag live authorization.** `liveInvalidation(app, { authorizeTag })`
  decides which tags a connected client may hold. The `hello` answering a
  subscription lists the refused tags in `denied`. An SSE request whose
  every tag is refused is answered `403` (`LIVE_TAGS_DENIED`) and opens no
  stream.
- **`signallingRelay({ identify })`** pins a WebRTC peer's name to its
  authenticated session, so a client cannot join under another's name.
- **`RoutesOf` marks event streams.** A route whose 2xx status is an `sse()`
  body gains `stream: "sse"` and its `events`, so bun-client's `sse()` is
  typed from the server's routes.

#### @kingsleyweb/bun-nest

- **Throttling modelled on `@nestjs/throttler`**: `BunThrottlerModule`
  (`forRoot`, `forRootAsync`), `BunThrottlerGuard`, `BunThrottlerService`,
  `@Throttle()`, `@SkipThrottle()`, `ThrottlerException` and the duration
  helpers `seconds()` to `weeks()`. A `ttl` always carries its unit, and a
  boot check (`guardCheck`) reports a guard that was never installed.

  ```ts
  @Module({
    imports: [BunThrottlerModule.forRoot({ throttlers: [{ limit: 600, ttl: "1m" }] })],
    providers: [{ provide: APP_GUARD, useClass: BunThrottlerGuard }],
  })
  class AppModule {}
  ```

  The adapter's `throttle` option limits everything ahead of Nest, 404s
  included.
- **`trustProxy`** on the adapter and `app.set("trust proxy", value)`, as on
  `@nestjs/platform-express`. `@Ip()` and `@Controller({ host })` follow it.
- **`./cache`** re-exports `cacheThrottleStore` (a limit shared across
  instances) and `cacheLiveBus` (live invalidation across instances) from
  bun-cache.
- `fetch()` takes a `remoteAddress`, as bun-common's does.

#### @kingsleyweb/bun-cache

- **`cacheThrottleStore(cache)`** (`./throttle`): bun-common's
  `ThrottleStore` over a cache, so one limit holds across processes. On
  Redis, Postgres, MySQL, MariaDB and SQLite it counts a window in one round
  trip, on the **backend's clock** (`clock: "store"`, the default), so
  processes need no NTP, and runs GCRA too. It gives back refunds for
  `skipSuccessfulRequests` and `skipFailedRequests`. A driver without an
  atomic increment (Cloudflare KV, `fromSimpleDriver`) is refused.
- **`cacheLiveBus(bus)`** (`./live`) adapts `redisBus` or `pgBus` into
  bun-common's `LiveBus`, sharing the channel with the caches.
- **Redis `setMany` stages large frames** (8 KiB or more) as `set` does, and
  a chunk is written whole or not at all.
- **`setManyFenced`** on `redundant()` and the Cloudflare D1 driver.

#### @kingsleyweb/bun-client

- **`useLive()`** in `./react` keeps the provider's queries fresh over
  bun-common's live invalidation, and **`live()`'s `onDenied`** reports the
  tags the server refused (a `hello`'s `denied`, or the SSE fallback's
  `403`, which ends the stream for good).
- **Typed event streams from `RoutesOf`**, and the generator reads
  `x-sse-data`: a text stream is typed and delivered as text.
- **Typed headers.** A header declared a number or a boolean takes that
  type at the call, and is sent as text.
- **Bring-your-own response schemas type the data** of `./query`
  (`q.query()`, `q.infinite()`, and `q.mutation(key, { validate })`) and of
  the React hooks.
- **`unknownKeys`** in `ValidationConfig`, as bun-common's, for the schemas
  you bring for the query, the body and the response.

#### @kingsleyweb/bun-jobs

- **`x-bun-errors`** on every operation of its OpenAPI document, so
  `bun-client generate` narrows every error status's `code` (and warns about
  nothing).
- A new optional driver method, **`updateRepeat`**, which every built-in
  driver has (see Fixed).

#### @kingsleyweb/bun-ui (new)

Every browser UI of the repo in one package, one subpath each:

- **`/jobs`**: the bun-jobs management UI, `jobsUi()`, as
  `@kingsleyweb/bun-jobs-ui` was. `/jobs/browser` holds its browser-safe
  types.
- **`/docs`**: the self-hosted OpenAPI and AsyncAPI viewer, `docsUi()`, as
  `@kingsleyweb/bun-api-docs-ui` was, with `/docs/browser`, `/docs/hosted`,
  `/docs/embed` and its seven `/docs/embed/*` modules.
- **`unauthorized: { redirectTo, returnParam?, statuses? }`** for both
  `jobsUi()` and `docsUi()` sends a signed-out browser to a sign-in page (a
  `303` for a page navigation that `authorize` denies, and a redirect when
  the app's reads fail with a listed status). Off by default.

#### @kingsleyweb/bun-contract

No change to its entry. A `lib/unknownKeys` module holds the dropped-key walk
bun-common and bun-client share.

### Fixed

- **bun-jobs: a removed repeat series could come back.** A worker scheduling
  the series' next occurrence wrote the series back after
  `removeRepeatable()` had removed it, and it ran on, listed again. Writes
  that advance a series now go through `updateRepeat`, which writes only
  while the series is stored, and the occurrence such a pass added is
  removed too.
- **bun-jobs: the file driver's `count()` could miss a job.** It read one
  state directory after another, so a job moving between two of them
  mid-count (a promotion, a claim, a retry) was in neither, and a queue about
  to run a job could count as empty. The unfinished states are now read
  before and after the finished ones; a moving job may be counted twice for
  that call, never missed.
- **bun-cache: a failed Redis `set()` of a large value could strip the old
  entry's tags.** When the staging write failed, the old entry stayed without
  its tag memberships, so a later `invalidateTags` no longer reached it, and
  the failure was an unhandled rejection meanwhile. The script now checks
  the staged frame before it changes anything, and the staging write's error
  is the one thrown.

Full list of changes: [v3.0.0-rc.0...v3.0.0-rc.1](https://github.com/kingsloob1/bun-node/compare/v3.0.0-rc.0...v3.0.0-rc.1)
(65 pull requests, #647 to #711).

## 3.0.0-rc.0 (2026-11-04)

<!-- changelog: hand-written; scripts/changelog.ts never replaces it -->

The first release candidate of 3.0.0. Since 2.2.0, bun-node has grown from
two packages to eight, all released together at one version. Install the
candidate from npm's `next` tag:

```bash
bun add @kingsleyweb/bun-common@next
```

### The packages

| Package | What it is | |
|---|---|---|
| [`@kingsleyweb/bun-common`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-common) | An Express 5 style HTTP framework for `Bun.serve`: routing, typed and validated routes, OpenAPI and AsyncAPI documents, WebSocket channels, server-sent events | updated |
| [`@kingsleyweb/bun-nest`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-nest) | Runs a NestJS 11 or 12 app on Bun, on top of bun-common | updated |
| [`@kingsleyweb/bun-contract`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-contract) | The contract core shared by server and browser: schemas, guards, channel contracts. No dependencies | new |
| [`@kingsleyweb/bun-client`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-client) | A typed client for your bun-common or bun-nest API: HTTP, SSE, WebSocket channels, GraphQL and WebRTC, with React hooks | new |
| [`@kingsleyweb/bun-jobs`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-jobs) | Background jobs: queues, workers and scheduled scripts, on SQL, MongoDB, Redis, files or memory | new |
| [`@kingsleyweb/bun-jobs-ui`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-jobs-ui) | A ready-made web UI for managing bun-jobs | new |
| [`@kingsleyweb/bun-cache`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-cache) | One cache API over 12 storage drivers, plus an HTTP response cache | new |
| [`@kingsleyweb/bun-api-docs-ui`](https://github.com/kingsloob1/bun-node/tree/develop/packages/bun-api-docs-ui) | A self-hosted viewer for your OpenAPI or AsyncAPI document | new |

### Breaking changes

These affect you only if you use **bun-common or bun-nest 2.2.0**. The six
new packages have no earlier version, so nothing in them can break.
"Upgrading from 2.2.0", below, says what to change.

- **Bun 1.4.2 or later.** `engines.bun` was `>=1.3.14` (bun-common) and
  `>=1.3.0` (bun-nest). Every package also declares an optional
  `@types/bun >=1.4.2` peer, and an optional `typescript` peer,
  `^5.9.3 || ^6.0.0`.
- **Each package has an `exports` map.** `types` now points at built
  declarations in `dts/`. Every 2.2.0 import of a file under `lib/` still
  resolves. Imports outside the map no longer do: a file outside `lib/`, or
  a directory path with a trailing slash such as `lib/multipart/storage/`.
- **Route paths use Express 5 syntax** (a port of path-to-regexp 8):
  - a named wildcard is an array under its name: `/w/*name` on `/w/a/b`
    gives `{ name: ["a", "b"] }`, where it gave `{ "0": "a/b" }`;
  - a named wildcard needs at least one segment, so `/w/` no longer
    matches `/w/*name`;
  - `{…}` is an optional group;
  - a malformed path throws `PathSyntaxError` when the route is registered,
    for example an unclosed `{`, or old and new syntax mixed in one path.

  Bare `*`, `:id?`, `:id(\d+)` and `:a-:b` keep their 2.2.0 meaning in
  bun-common. Nest controller paths go through Nest's own converter
  instead, where `:id?` and `:id(\d+)` throw at boot and `*` becomes
  `{*path}`.
- **`Logger` is structured.** It was `{ log, error, warn }`, each taking any
  number of arguments. It now has six levels (`trace`, `debug`, `info`,
  `warn`, `error`, `fatal`) plus `log`, each taking
  `(message: string | Error, fields?)`, and adds `child()` and
  `isLevelEnabled()`. Options accept any `LoggerLike`: pino, winston,
  bunyan, consola, log4js, tslog, Nest's logger or a console.
- **bun-nest's Nest packages are peers.** `@nestjs/common`, `@nestjs/core`
  (`^11.1.20 || ^12.0.0`) and `rxjs` (`^7.1.0`) are required peers, so your
  app installs them. `@nestjs/websockets`, `@nestjs/microservices`, bun-jobs
  and bun-cache are optional peers. In 2.2.0, `@nestjs/common` and `rxjs`
  were dependencies.
- **`close()` waits for requests in flight.** Both adapters drain for up to
  `closeDrainTimeout` (10 s by default) before closing the server. In 2.2.0,
  `close()` stopped at once.
- **The middleware pipeline follows Express 5:**
  - a `next()` called later, from a timer, resumes the pipeline;
  - `HEAD` on a route with only a GET handler runs the GET handler;
  - `next(object)` passes the object on unchanged;
  - `res.json()` keeps a `Content-Type` set earlier.
- **bun-nest matches paths case-insensitively by default**
  (`caseSensitive: false`), as `@nestjs/platform-express` does.
- **bun-nest WebSockets:**
  - a message sent with an ack id is acknowledged automatically;
  - a `WsException` reaches the client as an `"exception"` event;
  - two new limits: `maxConcurrentMessages` (1000) and `maxSendBufferSize`
    (128 MB).

No export of bun-common or bun-nest was removed or renamed. Two changed
shape: `Logger`, and bun-nest's `address()`, which now returns
`AddressInfo | string`. bun-common grew from 169 exports to 581, bun-nest
from 33 to 92.

### Upgrading from 2.2.0

1. **Bun.** Run `bun upgrade`, and check that `bun --version` is 1.4.2 or
   later.
2. **bun-nest's peers.** Install them in your app:

   ```bash
   bun add @nestjs/common @nestjs/core rxjs
   ```

3. **Deep imports.** Drop a trailing slash from a directory import, and
   import from a documented entry rather than a file outside `lib/`:

   ```ts
   // 2.2.0
   import { DiskStorage } from "@kingsleyweb/bun-common/lib/multipart/storage/";
   // 3.0.0
   import { DiskStorage } from "@kingsleyweb/bun-common/lib/multipart/storage";
   ```

4. **Named wildcards** now give an array:

   ```ts
   // 2.2.0
   app.get("/files/*path", (req, res) => res.send(req.params[0])); // "a/b"
   // 3.0.0
   app.get("/files/*path", (req, res) => res.send(req.params.path.join("/")));
   ```

5. **Logging.** Pass extra values as fields, and an error as the message or
   as `error`:

   ```ts
   // 2.2.0
   logger.error("upload failed", err, req.path);
   // 3.0.0
   logger.error("upload failed", { error: err, path: req.path });
   ```

   A custom object you typed as `Logger` needs the six levels. Or pass your
   pino, winston or other logger directly: it is wrapped for you.
6. **Shutdown.** To close at once, as 2.2.0 did, set `closeDrainTimeout`
   to `0` (the adapter's second argument):

   ```ts
   new BunHttpAdapter(0, { closeDrainTimeout: 0 });
   ```

7. **Exact-case paths in bun-nest.** To keep them:

   ```ts
   new BunHttpAdapter(0, { router: { caseSensitive: true } });
   ```

### What's new in each package

#### @kingsleyweb/bun-common

- **Routing like Express 5**, including the `QUERY` method.
- **Typed routes.** `req.params` is typed from the path you write.
  `validate()` checks the query, body and params with any Standard Schema
  library (zod, valibot, arktype, yup) and types them for the handler.
  Responses can be validated too.
- **API documents.** OpenAPI 3.1 and AsyncAPI 3.0, generated from your
  routes and channels, with sections (`tags` and `tagGroups`). `docsRouter`
  serves them with a viewer, and `devTypes` keeps a client's types in sync
  while you develop.
- **Testing without a socket.** `app.fetch()` runs a request through the
  real pipeline and returns the `Response`.
- **Compression and decoding** of requests and responses, including zstd
  and dictionaries, and `Cache-Control` helpers.
- **Realtime.** Server-sent events with `res.sse()` (`./sse`), validated
  WebSocket channels, live cache invalidation for clients (`./live`) and
  WebRTC signalling (`./webrtc`).

#### @kingsleyweb/bun-nest

- **NestJS 11 (from 11.1.20) and 12**, from one build, behaving like
  `@nestjs/platform-express` 12.
- **Validation.** `@Validate` on a controller method, `StandardSchemaPipe`
  and `StandardValidationPipe`. Gateways validate messages with
  `@ValidateMessage` and declare what they send with `@Emits`.
- **Caching and jobs.** `BunCacheModule` and `BunCacheInterceptor`
  (`./cache`), and `BunJobsApiModule` (`./jobs`).
- **Documents and the typed client.** Works with `@nestjs/swagger`, and
  documents gateways as AsyncAPI. `@Describe` adds docs to a route,
  `DevTypesModule` keeps a bun-client's types in sync, and `@Invalidates`
  refreshes clients' data after a change.
- **WebSockets** behave like `@nestjs/platform-ws` 12.2.0, with flow
  control. `MulterModule` options are supported for uploads.

#### @kingsleyweb/bun-contract (new)

The contract core that bun-common and bun-client share: transports,
Standard Schema contracts, the checks run on each side of a request, and
channel contracts. It has no dependencies and runs in a browser.
bun-common re-exports it unchanged as `./contract`.

#### @kingsleyweb/bun-client (new)

A typed client for an API built with bun-common or bun-nest. It has no
dependencies and runs in a browser.

- **Types from your server.** `bun-client generate` builds the route map
  from the server's OpenAPI document, and `watch` keeps it current.
- **Typed results.** Each response is typed by its status code. Retries,
  timeouts and auth refresh are built in, and validation runs where you
  turn it on.
- **Data fetching.** A TanStack Query layer, React hooks and persistence.
- **Every transport.** Typed clients for server-sent events, WebSocket
  channels, GraphQL and WebRTC data channels.

#### @kingsleyweb/bun-jobs (new)

Background work for Bun.

- **Queues.** `BunQueue` and `BunQueueWorker`: priorities, delays, retries
  with backoff, repeatable jobs, debounce and throttle, rate and
  concurrency limits shared across processes, dead letters and flows.
- **Scheduled scripts.** `BunRunner` runs a JS or TS file on a schedule or
  on demand, in a child process, a `Worker` or the same process.
- **Storage.** Memory, file, SQLite, Postgres, MySQL, MariaDB, MongoDB and
  Redis. `syncSchema` upgrades the tables or collections an older version
  created.
- **A registry** (`BunJobs`) with schedules written in plain words.
- **A management API** (`createJobsApi`) over HTTP and WebSocket, with
  OpenAPI and AsyncAPI documents.
- **Workers on demand.** Summon workers from compute providers, through a
  plugin API you can write your own provider for.

#### @kingsleyweb/bun-jobs-ui (new)

A web UI for bun-jobs' management API, served by `jobsUi()` on bun-common
or bun-nest. It is prebuilt, so there is nothing to bundle. It shows
queues, jobs, workers, runners, summoned workers and providers, has a live
events console, and includes an API docs viewer.

#### @kingsleyweb/bun-cache (new)

One typed cache API:

- time-to-live, tags, and `getOrSet`, which runs a missing value's loader
  once however many callers ask at the same time;
- serving a stale value while it refreshes, or when the loader fails;
- counters;
- an in-memory first tier, kept in step across processes;
- encryption of stored values.

It works over 12 drivers: memory, file, SQLite, Postgres, MySQL, MariaDB,
Redis, MongoDB, S3, Azure Blob Storage, Cloudflare KV and D1. It also
ships an HTTP response cache (`./http`), a Keyv store for cache-manager and
`@nestjs/cache-manager` (`./keyv`), and a test kit for driver authors
(`./testing`).

#### @kingsleyweb/bun-api-docs-ui (new)

A self-hosted viewer for one OpenAPI 3.1 or AsyncAPI 3.0 document, with
nothing loaded from a CDN. `docsUi()` serves it with React bundled in,
under a strict self-only Content Security Policy. bun-common's
`docsRouter` uses it as its `"self-hosted"` viewer.

Full list of changes: [v2.2.0...v3.0.0-rc.0](https://github.com/kingsloob1/bun-node/compare/v2.2.0...v3.0.0-rc.0)
(1,786 commits).
