# Changelog

Every package under `packages/` is released together, at one version.
Newest first. `bun scripts/changelog.ts <version>` writes an entry from the
commits since the previous tag; `docs/releasing.md` is the whole flow.

## Unreleased

<!-- changelog: hand-written; scripts/changelog.ts never replaces it -->

### Breaking changes

- **bun-common and bun-nest read `X-Forwarded-*` only through `trustProxy`.**
  This is Express 5's `trust proxy` setting, and it is off by default. In
  3.0.0-rc.0, `req.ips` and `req.protocol` (and so `req.secure`) always
  believed `X-Forwarded-For` and `X-Forwarded-Proto`, which any client can
  send. Now, with trust off:
  - `req.ips` is `[]`;
  - `req.protocol` is the scheme the request arrived on;
  - `X-Forwarded-Host` is ignored (it never moved `req.host`).

  `req.ip` is still the socket peer.

  Code reading these properties changes with them: bun-jobs' served AsyncAPI
  document picks `ws`/`wss` from `req.secure`, and bun-jobs-ui's CSP picks
  `wss:` from it.
- `req.socket.localAddress` is the socket peer. It was `req.ip`, which is the
  same with trust off.

### What's new

- **`trustProxy`** on both adapters, `BunRouter` and the request options,
  and **`set("trust proxy", value)`** on both adapters (`app.set()` on a
  Nest app). It takes every Express value: `true`, a hop count, addresses,
  CIDR ranges, the presets `loopback`, `linklocal` and `uniquelocal`, or a
  function. Through it:
  - `req.ip` is the first untrusted address, walking from the socket
    through `X-Forwarded-For` from right to left (proxy-addr's algorithm);
  - `req.ips` is the trusted chain;
  - `req.protocol`, `req.host` and `req.hostname` read `X-Forwarded-Proto`
    and `X-Forwarded-Host` from a trusted peer.

  A bun-nest `@Controller({ host })` matches the forwarded host the same
  way, and bun-jobs' management API follows it too: with its own
  `trustProxy` unset, its CSRF and upgrade origin checks and its served
  AsyncAPI server read the scheme and host as the request does. Its `true`
  (believe the headers from any peer) and `false` (never) still override
  the app's, and any other value is now a `ConfigError`.
- **`clientIpHeader`** names a single-value header, such as
  `CF-Connecting-IP`. It is believed only when `trustProxy` trusts the whole
  chain the request came through.
- **Platform helpers:** `behindCloudflare()` (with a dated
  `CLOUDFLARE_IP_RANGES` snapshot, and an opt-in
  `fetchCloudflareIpRanges()`), `behindRailway()` and `trustChain()`.
- **`req.proxyChain`** shows how `req.ip` was resolved. **`ws.data.ip`**
  carries an upgrade's `req.ip`, so a gateway sees the real client.
- **IP helpers** in `native.ts`, as proxy-addr reads addresses:
  `isIpAddress`, `parseIpAddress`, `parseIpRange`, `compileIpMatcher` and
  `IP_RANGE_PRESETS`. The socket shim adds Node's `remoteAddress`,
  `remotePort` and `remoteFamily`.

### Fixed

- **bun-jobs: a removed repeat series could come back.** A worker scheduling
  the series' next occurrence wrote the series back after
  `removeRepeatable()` had removed it, and it ran on, listed again. Writes
  that advance a series now go through a new optional driver method,
  `updateRepeat`, which writes only while the series is stored (every
  built-in driver has it), and the occurrence such a pass added is removed
  too.

### Upgrading

If the app runs behind a proxy and reads `req.ips`, `req.protocol`,
`req.secure` or a forwarded host, say which proxies to trust, as you would on
Express:

```ts
new BunHttpAdapter(0, { trustProxy: "loopback" }); // nginx on the same host
new BunHttpAdapter(0, { trustProxy: 1 }); // one proxy in front, by position
new BunHttpAdapter(0, { ...behindCloudflare() }); // Cloudflare → app
new BunHttpAdapter(0, { ...behindRailway() }); // Railway → app
app.set("trust proxy", 1); // a Nest app, as on platform-express
```

bun-common's README, under
[Client address behind proxies](https://github.com/kingsloob1/bun-node/blob/develop/packages/bun-common/README.md#client-address-behind-proxies-trustproxy),
covers what to trust and the spoofing traps. Don't set `trustProxy: true` on
a server clients can reach directly.

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
