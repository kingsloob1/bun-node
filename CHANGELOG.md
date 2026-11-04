# Changelog

Every package under `packages/` is released together, at one version.
Newest first. `bun scripts/changelog.ts <version>` writes an entry from the
commits since the previous tag; `docs/releasing.md` is the whole flow.

## 3.0.0-rc.0 (2026-11-04)

<!-- changelog: hand-written; scripts/changelog.ts never replaces it -->

The first release candidate of 3.0.0, on npm's `next` tag. Since 2.2.0,
bun-node has grown from two packages, bun-common and bun-nest, to eight
packages released together at one version. The six new ones are
bun-contract, bun-jobs, bun-jobs-ui, bun-api-docs-ui, bun-cache and
bun-client. `npm install @kingsleyweb/bun-common@next` installs the
candidate.

### Breaking changes

- **Bun ≥ 1.4.2.** `engines.bun` was `>=1.3.14` (bun-common) and `>=1.3.0`
  (bun-nest). Every package now declares an optional `@types/bun >=1.4.2`
  peer. The `typescript` peer is optional, `^5.9.3 || ^6.0.0`.
- **`exports` maps.** Each package now has an `exports` map, and `types`
  points at built declarations in `dts/`. Every 2.2.0 import of a file
  under `lib/` still resolves. Imports outside the map, such as files
  outside `lib/` or a directory path with a trailing slash
  (`lib/multipart/storage/`), no longer resolve.
- **Express 5 path syntax** (a port of path-to-regexp 8):
  - A named wildcard is now an array under its name. `/w/*name` on
    `/w/a/b` gives `{ name: ["a", "b"] }`, where it gave `{ "0": "a/b" }`.
  - A named wildcard needs at least one segment: `/w/` no longer matches
    `/w/*name`.
  - `{…}` is an optional group.
  - A malformed path throws `PathSyntaxError` when the route is
    registered. Examples are an unclosed `{`, and old and new syntax mixed
    in one path.
  - Bare `*`, `:id?`, `:id(\d+)` and `:a-:b` keep their meaning in
    bun-common.
  - Nest controller paths go through Nest's own converter. There, `:id?`
    and `:id(\d+)` throw at boot, and `*` becomes `{*path}`.
- **Structured `Logger`.** It was `{ log, error, warn }` with any number of
  arguments. Now it has six levels plus `log`, each taking
  `(message: string | Error, fields?)`, and adds `child()` and
  `isLevelEnabled()`. Calls with several arguments, and custom objects
  typed as `Logger`, need updating. Options take any `LoggerLike`: pino,
  winston, bunyan, consola, log4js, tslog, Nest's logger or a console.
- **bun-nest's Nest packages are peers.**
  - `@nestjs/common`, `@nestjs/core` (`^11.1.20 || ^12.0.0`) and `rxjs`
    (`^7.1.0`) are required peers, so an app installs them itself.
  - `@nestjs/websockets`, `@nestjs/microservices`, bun-jobs and bun-cache
    are optional peers.
  - Before, `@nestjs/common` and `rxjs` were runtime dependencies.
- **`close()` drains.** Both adapters wait for requests in flight, for at
  most `closeDrainTimeout` (10 s by default), before they force the server
  closed. Before, `close()` stopped at once.
- **Express 5 pipeline semantics:**
  - A `next()` called later, from a timer, resumes the pipeline.
  - `HEAD` on a route with only a GET handler runs the GET handler.
  - `next(object)` passes the object unchanged.
  - `res.json()` keeps a `Content-Type` set earlier.
- **bun-nest's router** defaults to `caseSensitive: false`, as Express does.
- **bun-nest WebSockets:**
  - A message with an ack id is acknowledged automatically.
  - A `WsException` arrives as an `"exception"` event.
  - New limits: `maxConcurrentMessages` (1000) and `maxSendBufferSize`
    (128 MB).

No export of bun-common or bun-nest was removed or renamed. bun-common
has 581 exports, up from 169, and bun-nest 92, up from 33. Two exports
changed shape: `Logger`, and bun-nest's `address()`, which now returns
`AddressInfo | string`.

### @kingsleyweb/bun-common

- Express 5 routing, with the `QUERY` verb.
- Typed routes:
  - `req.params` is inferred from the path literal.
  - `validate()` (`BunValidate`) accepts any Standard Schema: zod,
    valibot, arktype or yup.
  - Responses can be checked too.
- Contracts and API docs:
  - OpenAPI 3.1 and AsyncAPI 3.0 generators.
  - `defineRoutes`, `docsRouter` and `devTypes`.
- `fetch()` runs a request through the real pipeline without a socket.
- Compression and body decoding, including zstd and dictionaries.
  Cache-Control.
- Server-sent events (`./sse`), validated WebSocket channels, live
  invalidation (`./live`) and WebRTC signalling (`./webrtc`).

### @kingsleyweb/bun-nest

- NestJS 11 (≥ 11.1.20) and 12 from one build, at parity with
  platform-express 12.
- Validation: `@Validate`, `StandardSchemaPipe` and
  `StandardValidationPipe`. Gateways are validated with
  `@ValidateMessage` and `@Emits`.
- `BunCacheModule` and `BunCacheInterceptor` (`./cache`), and
  `BunJobsApiModule` (`./jobs`).
- Verified with `@nestjs/swagger`. AsyncAPI for gateways, `@Describe`,
  `DevTypesModule` and `@Invalidates`.
- The WebSocket adapter is at parity with platform-ws 12.2.0 and has flow
  control. `MulterModule` options.

### @kingsleyweb/bun-contract (new)

bun-common's contract core, with no dependencies and safe to use in a
browser. It provides transports, Standard Schema contracts,
sender/receiver guards and channel contracts. bun-common re-exports it
unchanged as `./contract`.

### @kingsleyweb/bun-jobs (new)

Background work for Bun.

- `BunQueue` and `BunQueueWorker`:
  - priorities, delays, retries with backoff and repeatable jobs;
  - debounce and throttle, and rate and concurrency limits across the
    cluster;
  - dead letters and flows.
- `BunRunner` runs a JS or TS file on a schedule or on demand, in a child
  process, a `Worker` or in-process.
- Drivers:
  - memory and file;
  - SQL: SQLite, Postgres, MySQL and MariaDB;
  - MongoDB and Redis.
  - `syncSchema` updates an older SQL or MongoDB schema.
- The `BunJobs` registry, with schedules written in words.
- `createJobsApi`: a management HTTP and WebSocket API, with OpenAPI and
  AsyncAPI documents.
- Summoned workers, with a plugin API for compute providers.

### @kingsleyweb/bun-jobs-ui (new)

A React UI for bun-jobs' management API, with an API docs viewer. It is
prebuilt into `dist/` and served by `jobsUi()` on bun-common or bun-nest.
It shows queues, jobs, workers, runners, summon and providers, and has a
live events console.

### @kingsleyweb/bun-api-docs-ui (new)

A self-hosted viewer for one OpenAPI 3.1 or AsyncAPI 3.0 document.
`docsUi()` serves it with React bundled in, SRI and a strict self-only
CSP. bun-common's `docsRouter` uses it for its `"self-hosted"` viewer.

### @kingsleyweb/bun-cache (new)

One typed cache API:

- TTLs, tags and single-flight `getOrSet`;
- stale-while-revalidate and stale-if-error;
- counters;
- an L1 tier kept coherent by a bus;
- encryption at rest.

It runs over 12 drivers: memory, file, SQLite, Postgres, MySQL, MariaDB,
Redis, MongoDB, S3, Azure Blob, Cloudflare KV and D1. It also ships an
HTTP response cache (`./http`), a Keyv store for cache-manager and
`@nestjs/cache-manager` (`./keyv`), and a conformance kit (`./testing`).

### @kingsleyweb/bun-client (new)

A typed HTTP client over a `"VERB /path"` route map, with no dependencies
and safe to use in a browser.

- `bun-client generate` and `watch` build the route map from the server's
  OpenAPI document.
- Each result is typed by its status. Retries, timeouts and auth refresh.
- A TanStack query layer, React hooks and persistence.
- Typed clients for SSE, WebSocket channels, GraphQL and WebRTC.

Full list: [v2.2.0...v3.0.0-rc.0](https://github.com/kingsloob1/bun-node/compare/v2.2.0...v3.0.0-rc.0)
(1,786 commits).
