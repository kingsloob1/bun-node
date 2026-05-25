# CLAUDE.md

Project knowledge for Claude Code and contributors. Auto-loaded each session.

## What this repo is

`bun-node` is a Bun-first monorepo (Bun workspaces + lerna + nx) with two
published packages under `packages/`:

- **`@kingsleyweb/bun-common`** — an Express-like HTTP layer for `Bun.serve`:
  `BunRequest`, `BunResponse`, `BunRouter` (extends `@routejs/router`),
  `BunHttpAdapter`, `BunWebSocket`, and a multipart upload system
  (`lib/multipart/`).
- **`@kingsleyweb/bun-nest`** — a NestJS adapter built on bun-common:
  `BunHttpAdapter` (extends NestJS `AbstractHttpAdapter`),
  `BunWebSocketAdapter`, file interceptors, decorators.

Each package: `lib/` source, `__tests__/` (bun:test), `tsc --noEmit`
typecheck, ESLint via `@antfu/eslint-config`. Runtime is Bun. Source ships as
raw `.ts` (`main`/`types` point at `lib/index.ts`).

bun-nest's `BunHttpAdapter.use/get/post/...` delegate to `this.instance`,
which is a bun-common `BunRouter` — so routing/middleware behaviour lives in
bun-common.

## Dev workflow (run in each affected package directory)

```bash
bunx tsc --noEmit          # typecheck — must be clean
bunx eslint lib __tests__  # lint — must have 0 errors
bun test                   # tests — must all pass
```

After changing bun-common, also run bun-nest's checks (it depends on
bun-common). The `eslint.config.mjs` `TS2742` portability hint is pre-existing
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
  `createDeferred`, `waitUntil`) and **`lib/cors.ts`** (native CORS).
  `lib/index.ts` re-exports them via `export * from "./utils/native"`.
- `qs` → `picoquery` for query parsing (`DEFAULT_PARSE_QUERY_OPTS` uses
  `nestingSyntax: "js"`, `arrayRepeat: true`; strip a leading `?` before
  parsing).
- **Kept deliberately** (parsers where native is insufficient):
  `@routejs/router`, `busboy`, `file-type`, `parse-domain`, `mime`, `accepts`,
  `type-is`.

Before adding any dependency, check whether a Bun API or `native.ts` already
covers it; add new helpers to `native.ts` rather than new deps.

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
