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
`reflect-metadata`, `rxjs` and — for the `@kingsleyweb/bun-nest/jobs`
examples — `@kingsleyweb/bun-jobs` and `@kingsleyweb/bun-jobs-ui` resolve from the repo's root `node_modules`
(`@nestjs/platform-express` is not needed, and not installed). The legacy
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
| [`controllers-and-routing.ts`](./02-http-adapter/controllers-and-routing.ts) | every HTTP method decorator, parameter decorators, `@HttpCode`, `@Header`, `@Redirect`, `StreamableFile`, raw response access |
| [`middleware-and-versioning.ts`](./02-http-adapter/middleware-and-versioning.ts) | Nest middleware, a global prefix, every versioning type |
| [`pipeline.ts`](./02-http-adapter/pipeline.ts) | guards, pipes, exception filters and interceptors on Bun; error and not-found handlers |
| [`adapter-options.ts`](./02-http-adapter/adapter-options.ts) | adapter options, `enableCors`, static assets, body parsing and raw bodies, the logger, `fetch()` without a socket, `close()` |

### 03 — File uploads

| File | Shows |
|---|---|
| [`interceptors.ts`](./03-file-uploads/interceptors.ts) | `FileInterceptor`, `FilesInterceptor`, `FileFieldsInterceptor`, `AnyFilesInterceptor`, `NoFilesInterceptor`, `@UploadedFile(s)`, memory and disk storage, upload errors |

### 04 — WebSockets

| File | Shows |
|---|---|
| [`gateway-basics.ts`](./04-websockets/gateway-basics.ts) | lifecycle hooks, `@MessageBody`, `@ConnectedSocket`, `WsResponse` vs a plain return, Promise and Observable replies, `@Ack` |
| [`message-formats.ts`](./04-websockets/message-formats.ts) | every packet type on the wire, binary frames, malformed and unroutable frames, exceptions |
| [`adapter-options.ts`](./04-websockets/adapter-options.ts) | the `websocket` option and `onUpgrade`, auth on upgrade, headers and data on the 101, client data, namespaces, gateway ports, broadcasting, a standalone adapter |
| [`custom-adapter.ts`](./04-websockets/custom-adapter.ts) | subclassing the adapter and wiring it with `app.useWebSocketAdapter` |

### 05 — The jobs API module

| File | Shows |
|---|---|
| [`module.ts`](./05-jobs-api/module.ts) | `BunJobsApiModule.forRoot` from `@kingsleyweb/bun-nest/jobs`, `@InjectJobsApi()`, authorized requests against the mounted routes, and what `app.close()` closes |

### 06 — The jobs UI

| File | Shows |
|---|---|
| [`mount.ts`](./06-jobs-ui/mount.ts) | `jobsUi()` from `@kingsleyweb/bun-jobs-ui` over the API `BunJobsApiModule` built (`app.get(BUN_JOBS_API)`), mounted with `adapter.use()` or `adapter.getInstance().use()`, a page `authorize` sharing the API's session, and what a global prefix does not touch. More in [`../bun-jobs-ui`](../bun-jobs-ui) |

### 10 — Option tours

The examples above *show* behaviour. A tour **asserts** it: each exercises
every option of one part of the API and checks what happens with
[`shared/check.ts`](./shared/check.ts). A failed check fails the script, so
`bun run-all.ts 10` is a test of every option.

| File | Covers |
|---|---|
| [`http-adapter-options.ts`](./10-options/http-adapter-options.ts) | every `BunHttpAdapter` method and option inside a Nest application |
| [`interceptor-options.ts`](./10-options/interceptor-options.ts) | every file interceptor and its options |
| [`websocket-adapter-options.ts`](./10-options/websocket-adapter-options.ts) | every WebSocket adapter method, option and message type |
| [`jobs-api-module-options.ts`](./10-options/jobs-api-module-options.ts) | every `BunJobsApiModule` option, and the rules for sharing a server between its live-events socket and a gateway |

## Checking the examples

```bash
bun scripts/typecheck.ts        # from the repo root — includes examples/bun-nest
cd examples/bun-nest
bunx eslint .                   # the package's lint rules, minus no-console
bun run-all.ts                  # run them all
```
