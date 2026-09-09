# CLAUDE.md

Project knowledge for Claude Code and contributors. Auto-loaded each session.

## What this repo is

`bun-node` is a Bun-first monorepo (Bun workspaces + lerna + nx) with three
published packages under `packages/`:

- **`@kingsleyweb/bun-common`** — an Express-like HTTP layer for `Bun.serve`:
  `BunRequest`, `BunResponse`, `BunRouter` (extends `@routejs/router`),
  `BunHttpAdapter`, `BunWebSocket`, and a multipart upload system
  (`lib/multipart/`).
- **`@kingsleyweb/bun-nest`** — a NestJS adapter built on bun-common:
  `BunHttpAdapter` (extends NestJS `AbstractHttpAdapter`),
  `BunWebSocketAdapter`, file interceptors, decorators.
- **`@kingsleyweb/bun-jobs`** — background work on top of bun-common's
  primitives: `BunRunner` (run a JS/TS file on a schedule or on demand, in a
  child process, a `Worker` or in-process), `BunQueue`/`BunQueueWorker` (a
  job queue across processes and services) and the per-service `BunJobs`
  context, over pluggable drivers (memory, file, Redis, SQL). Being
  assembled in phases — see its `README.md` for what has landed.

Each package: `lib/` source, `__tests__/` (bun:test), `tsc --noEmit`
typecheck, ESLint via `@antfu/eslint-config`. Source ships as raw `.ts`
(`main`/`types` point at `lib/index.ts`).

Runtime is **Bun ≥ 1.4.2**: `engines.bun` says so in the root and in every
package, `bun-types`/`@types/bun` devDeps are `^1.4.2`, and each package
declares an optional `@types/bun >=1.4.2` peer so a consumer on older types
is warned instead of hitting opaque type errors. The floor matters because
bun-jobs' Redis and SQL drivers use `RedisClient.eval`/`xadd`/… and
`sql.listen`, which 1.4.2 is the first `bun-types` release to declare.

bun-nest's `BunHttpAdapter.use/get/post/...` delegate to `this.instance`,
which is a bun-common `BunRouter` — so routing/middleware behaviour lives in
bun-common.

## Dev workflow (run in each affected package directory)

```bash
bunx tsc --noEmit          # typecheck — must be clean
bunx eslint lib __tests__  # lint — must have 0 errors
bun test                   # tests — must all pass
```

After changing bun-common, also run bun-nest's and bun-jobs' checks (both
depend on bun-common). The `eslint.config.mjs` `TS2742` portability hint is pre-existing
noise — ignore it. There may be a couple of intentional `no-console` ESLint
*warnings* (error logging in catch blocks with no logger in scope); warnings
do not fail lint.

**Test files are not in `tsconfig`'s `include`** (`./lib/**/*` only), so
`bunx tsc --noEmit` doesn't catch type errors in `__tests__/`. The IDE does,
and an explicit pass does too — when you've changed test files, also run:

```bash
bunx tsc --noEmit --skipLibCheck --target ESNext --module ESNext \
  --moduleResolution bundler --strict --allowImportingTsExtensions \
  --types bun-types __tests__/*.ts
```

The single-file flags will surface unrelated errors in `lib/BunResponse.ts`
(stream-type incompatibilities Bun papers over with its global types) —
those are noise; only `__tests__/...` lines are signal.

## Dependency policy

Prefer native/Bun APIs and the in-repo helpers over third-party libraries;
keep the dependency surface small.

- bun-common's small/old deps were replaced with native code in
  **`packages/bun-common/lib/utils/native.ts`** (type guards, `get/set/merge/
  cloneDeep/orderBy/omit/pick/each`, `etag`, cookie parse/serialize/sign,
  `fresh`, `rangeParser`, `appendVary`, `encodeUrl`, `getPort`,
  `createDeferred`, `waitUntil`, `sleep`, `withTimeout`, `computeBackoff`,
  `retry`, `serializeError`/`deserializeError`, `jsonClone`, `Mutex`,
  `Semaphore`) and **`lib/cors.ts`** (native CORS).
  `lib/index.ts` re-exports them via `export * from "./utils/native"`.
- `qs` → `picoquery` for query parsing (`DEFAULT_PARSE_QUERY_OPTS` uses
  `nestingSyntax: "js"`, `arrayRepeat: true`; strip a leading `?` before
  parsing).
- **Kept deliberately** (parsers where native is insufficient):
  `@routejs/router`, `busboy`, `file-type`, `parse-domain`, `mime`, `accepts`,
  `type-is`.

Before adding any dependency, check whether a Bun API or `native.ts` already
covers it; add new helpers to `native.ts` rather than new deps.

### Packaging types (both packages ship raw `.ts`)

`main`/`types` point at `lib/index.ts`, so a **consumer compiles our source**.
Two rules follow, and must hold for every dependency you add:

- **`@types/*` backing a shipped `lib/**` import must be a runtime
  `dependency`, not a `devDependency`.** In devDependencies it is absent from
  the consumer's tree, so the type collapses to `any`/error for them.
  `@types/accepts`, `@types/busboy`, `@types/type-is` are therefore
  `dependencies`. Exceptions: `@types/bun` stays a devDep (runtime-env types the
  consumer already provides; pinning it risks a version clash) — the minimum
  is expressed instead as an *optional* peer range,
  `peerDependencies["@types/bun"] = ">=1.4.2"`, never a pin — and libs that
  bundle their own types (`file-type`, `mime`, `parse-domain`) need no `@types`.
- **Re-export third-party types that appear in the public type surface.**
  `lib/index.ts` has `export type { BusboyConfig, FieldInfo, FileInfo } from
  "busboy"` because `MultiPartOptions`/`MultiPartFileRecord`/
  `MultiPartFieldRecord`/`getMultiParts` are built from them. Without it a
  consumer can *use* the composed types but cannot *name* the base types, and TS
  declaration emit raises `TS2742` "cannot be named". bun-nest inherits
  bun-common's types transitively, so fixing bun-common usually suffices.

## Logging (`packages/bun-common/lib/logging.ts`)

`Logger` is **structured, not console-shaped**: six levels (`trace` `debug`
`info` `warn` `error` `fatal`), each `(message: string | Error, fields?)`,
plus `log` (alias of `info`), `child(bindings, { name?, level? })` and
`isLevelEnabled(level)`. No variadic `unknown[]` anywhere — that was the old
shape, and it typed nothing.

- `createLogger({ level, name, bindings, sink, enabled, time })` is the only
  implementation; sinks are `consoleSink({ console, format: "pretty"|"json" })`,
  `multiSink`, `collectSink`. `noopLogger` drops everything;
  `createTestLogger()` returns `{ logger, events }` for assertions.
- An `Error` logged as the message, or passed as `fields.error`, is lifted
  onto `LogEvent.error` — a sink has one place to look.
- **Options accept `LoggerLike`, not `Logger`**: a `Logger`, a bare `LogSink`
  function, or a pino / bunyan / winston / consola / log4js / tslog / NestJS /
  console-like logger. `resolveLogger(input?, fallback?)` returns a `Logger`
  as-is and otherwise detects the shape in a fixed order (pino → bunyan →
  winston → consola → log4js → tslog → Nest → console) and wraps it. Name the
  adapter (`fromPino`, `fromWinston`, ...) to skip detection.
- Adapters are **structural** — nothing imports those libraries. Each builds a
  `LogSink` and reuses `createLogger`, so `child()`, level filtering and error
  handling behave identically underneath any of them; bindings are passed in
  the library's structured slot (pino/bunyan's object argument, winston's
  meta), and adapters default to `level: "trace"` so the wrapped library stays
  the authority on its own threshold, delegating via `isLevelEnabled` when it
  has one.
- `BunRouter.logger` resolves once on first access; `setLogger`/`set logger`
  accept any `LoggerLike`. Call sites use `logger.error("message", { error })`,
  never `logger.error("message", err)`.

Compile-time guarantees are asserted in `__tests__/logging.type-test.ts`
(checked by the tests typecheck, not `bun test`); runtime behaviour and every
adapter's call mapping in `__tests__/logging.test.ts`.

## Router — Express 5 semantics

`BunRouter.handle()` (`packages/bun-common/lib/BunRouter.ts`) is a single-pass
Express 5 pipeline walk over `getMatchedLayers()` — every callback of every
matched route.

- Middleware and error handlers run in **route-registration order**; when
  several **route handlers** match, they run in **specificity** order
  (`routeSpecificityIteratees` — static beats param, fewer params / more
  regexp constraints win), with registration order as the stable tie-break.
- A callback with **4 parameters** is an **error handler**.
- A thrown error, a rejected promise, or `next(err)` switches the pipeline to
  *error mode*: regular layers are skipped, only error handlers run (invoked
  as `(err, req, res, next)`).
- An error handler calling `next()` with no argument clears the error and
  resumes normal processing; `next(err)` keeps propagating.
- `next('route')` skips the rest of the current route's callbacks;
  `next('router')` abandons the router.
- An unhandled error is re-thrown for the adapter's final error handler
  (`setErrorHandler` / `Bun.serve` `error()` callback).
- `use(path, ...)` registers middleware with `group: path` so
  `@routejs/router` compiles a **prefix** regex (Express prefix matching);
  plain `path:` routes are exact-match.

## Typed routes (generated overloads)

`BunRouter` and both `BunHttpAdapter`s carry **generated** verb overloads that
narrow a handler's request:

- `req.params` from the path literal — `get("/home/:name/:id?", h)` gives
  `{ name: string; id?: string }`. `*name` yields both the positional key and
  the name, matching what the matcher emits.
- `req.query` / `req.body` / `req.params` from a `BunValidate` middleware
  registered ahead of the handler in the same call, via a phantom `__shape`
  type it carries.

They live between `/* --- BEGIN generated typed overloads: <verb> --- */`
markers. **Do not edit them by hand** — regenerate:

```bash
cd packages/bun-common
bun scripts/generate-verb-overloads.ts          # rewrite both packages
bun scripts/generate-verb-overloads.ts --check  # CI: fail if stale
```

Three constraints discovered while building this, all verified by spike:

- They must be **generated per verb, inside the class, ahead of the existing
  overloads**. A single variadic overload cannot work (each position's type
  depends on the previous ones, leaving TypeScript no inference site), and
  declaring the set once and merging it via an interface fails because merged
  members are appended *after* the class's own — the wide
  `(path, ...callbacks)` signature then wins and the handler degrades to `any`.
- Exactly **one** position carries a shape: the validator immediately before
  the handler. Letting every position carry one worked in isolation but
  collapsed in the real class — as soon as a shape position received a
  non-validator, the overload was discarded and the call fell through to the
  untyped signature. `BunValidate` takes every target in one call, so this
  costs nothing in practice.
- Preceding positions are typed `RouterHandler`, not a union — a union gives
  TypeScript no single signature to contextually type an inline arrow against,
  and its parameters land on implicit `any`.

### Mounted sub-routers

A sub-router declares the path it will be mounted at, so its routes can see the
mount's params:

```ts
const users = new BunRouter<"/users/:id">();
users.get("/posts/:postId", (req) => req.params); // { id, postId }
adapter.use("/users/:id", users);
```

With a validator at the mount, its `query`/`body` reach the sub-router too, and
the declaration must include them:

```ts
const orgs = new BunRouter<"/orgs/:org", { query: { page: number } }>();
adapter.use("/orgs/:org", validate({ query: PageQuery }), orgs);
```

`use()` requires the declaration and the actual mount to agree — a wrong path,
a wrong shape, or a declared shape mounted without its validator are all
compile errors. Three details make that work, each easy to undo by accident:

- `NoInfer` on the router argument. Without it `TPath` also infers from the
  router, and TypeScript reconciles the two candidates by widening to their
  union — which both then satisfy, so a mismatch passes.
- A phantom `__mount` field (`declare`, so it emits nothing). Without it two
  differently-mounted routers are structurally identical and nothing to
  compare.
- The untyped `use` overloads take `UnmountedRouter`, not `Router`. Otherwise
  they swallow any mismatch the typed overloads reject.

**Mount `params` deliberately do not propagate into the types**, because they
do not propagate at runtime: `use()` middleware is not a route handler, so the
pipeline never binds params for it (a mount validator sees `{}`), and params
are rebound on entering each matched route regardless. Validators also chain —
each replaces `req.query` wholesale, so a sub-route's schema receives the
mount's *output*, not the raw query.

Compile-time assertions live in `__tests__/verbTyping.type-test.ts`,
`__tests__/mountTyping.type-test.ts` and
`packages/bun-nest/__tests__/nestVerbTyping.type-test.ts`; they are checked by
the tests typecheck, not `bun test`. Runtime coverage for mounting is in
`__tests__/bunValidate.test.ts`.

## Testing without a socket: `fetch()`

`BunRouter.fetch()` and both adapters' `fetch()` run a request through the real
pipeline and resolve the `Response`, with no port bound:

```ts
await router.fetch("/users/42");                        // string implies GET
await router.fetch("/posts", { method: "POST", body });  // path + RequestInit
await router.fetch({ url: "/posts", method: "POST", body });
await router.fetch(new Request("http://localhost/x"));   // full control
```

Named `fetch` because it is the same contract as `Bun.serve`'s `fetch` — a
`Request` in, a `Response` out. The adapters override it to delegate to
`handleNativeRequest`, *the very method* their `Bun.serve` handler calls, so a
socket-free test exercises the production path (not-found handlers, error
handlers, the payload guard, response finalisation) rather than an
approximation. `fetch.test.ts` asserts that parity directly by comparing
against a served request.

Prefer it over standing up a server: no port to release, so none of the
`SO_REUSEPORT` hazards below apply. Use a real server only when testing the
socket itself (WebSockets, streaming, keep-alive).

Without a socket there is no peer, so `requestIP()` is `null` and an upgrade
cannot succeed — a stub server reports both honestly rather than pretending.

## Testing conventions & gotchas

- Reuse the test helpers: `packages/bun-common/__tests__/helpers.ts`
  (`testServer`, `makeRequest`, `makeResponse`) and
  `packages/bun-nest/__tests__/helpers.ts` (`makeMultipartRequest`,
  `makeExecutionContext`, `makeCallHandler`). Don't stand up servers by hand.
- Always listen on port `0` (OS-assigned). A bare `Bun.serve({ fetch })` with
  no port defaults to 3000 and will collide with anything already on 3000.
- **Port-release pitfall:** `BunHttpAdapter.close()` must use
  `server.stop(true)` (force-close), never `stop(false)`. A graceful stop
  leaves keep-alive connections alive — and with `SO_REUSEPORT` a freshly
  bound server on the same port receives requests served by the *stale*
  server, producing baffling wrong/empty responses. `getPort` in `native.ts`
  also locks recently-handed-out ports for ~1s for the same reason.
- Writing tests has repeatedly surfaced real bugs here — keep test coverage
  thorough, and keep every existing test green.
- **Inline 4-arg error handlers need a hint.** TypeScript overload
  resolution cannot dispatch by arrow arity, so an untyped
  `(err, req, res, next) => …` inside `router.use/get/all/useMethod(...)`
  resolves through the wider overload and all four params infer as `any`
  (the IDE flags this even when CLI `tsc` doesn't, since CLI tsc doesn't
  cover tests). Use `satisfies RouterErrorMiddlewareHandler` to give the
  arrow a contextual type:

  ```ts
  router.use(((err, _req, res, _next) => {
    res.status(500).json({ error: String(err) });
  }) satisfies RouterErrorMiddlewareHandler);
  ```

  `RouterErrorMiddlewareHandler` is exported from
  `packages/bun-common/lib/types/general.ts`.

## Working preferences

- Match the real framework's semantics exactly when emulating one (e.g.
  Express 5 `use`) — look up the spec, don't approximate.
- Fix all ESLint errors with proper TypeScript types — no lazy `any`.
- The ESLint config restores antfu's `^_` ignore pattern for
  `unused-imports/no-unused-vars`: a leading underscore marks a deliberately
  unused binding (e.g. the mandatory 4th `next` param of an error handler).
- Add tests for every change.
- **Always document properties with a JSDoc description** — when creating a
  new class field, constructor parameter, or options/interface property, AND
  when editing an existing one that lacks a description. This includes
  positional constructor params and every field of inline or named options
  objects. Match the existing concise `/** … */` style (what the property is,
  its default, and any gotcha). Don't leave a public property undescribed.
