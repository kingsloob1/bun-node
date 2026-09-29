# Survey: Bun's native `routes`, Elysia, Hono

Backs `../../bun-native-routes.md`. Read from primary sources at pinned
commits, September 2026. Each claim is marked **source** (read from code at
the pinned commit), **docs** (read from published documentation),
**measured** (a probe on the local Bun; the probes that the plan relies on are
re-run in `spikes/` with their output in `results/`), or **inferred**.

- Local Bun: `1.4.3-canary.1+5f554969b` = commit
  `5f554969bc8ab2159583cdf5ff26f5277ca35e91` (2026-09-09).
  **B** = `https://github.com/oven-sh/bun/blob/5f554969bc8ab2159583cdf5ff26f5277ca35e91/`
- Bun's server is Rust now (`src/runtime/server/*.rs`); the old
  `src/bun.js/api/server/*.zig` paths no longer exist. Routing itself is the
  uWebSockets C++ router (`packages/bun-uws/src/HttpRouter.h`).
- Docs: https://bun.com/docs/runtime/http/routing and
  https://bun.com/docs/runtime/http/server (docs tree at Bun HEAD `a4f1429`,
  2026-09-26; no routing change between the pinned commit and HEAD).
- Elysia: v1.4.30, commit `e037eca` (2026-08-26).
  **E** = `https://github.com/elysiajs/elysia/blob/e037eca710e7ad193be09cc6615ab0dbe54af914/`

## Contents

1. [Route syntax](#1-route-syntax)
2. [Route values](#2-route-values)
3. [Precedence, trailing slash, case, decoding](#3-precedence-trailing-slash-case-decoding)
4. [HEAD, OPTIONS, method mismatch](#4-head-options-method-mismatch)
5. [fetch, error, websocket](#5-fetch-error-websocket)
6. [server.reload()](#6-serverreload)
7. [Scaling](#7-scaling)
8. [Bun issues and PRs](#8-bun-issues-and-prs)
9. [Elysia](#9-elysia)
10. [Hono](#10-hono)
11. [Published benchmarks](#11-published-benchmarks)

## 1. Route syntax

- Static paths, `:param` and `*` (rest of URL). Precedence exact → param →
  wildcard → `/*`. **docs** (routing, "Route precedence").
- The router is one segment tree **per HTTP method**; each node holds a
  `std::vector` of children **scanned linearly**. A segment starting `:` is a
  param, one starting `*` a wildcard. **source** B`packages/bun-uws/src/HttpRouter.h#L56-L64`, `#L166-L205`.
- **Param names take no part in matching**: registration truncates `:name` to
  `:` (`HttpRouter.h#L291-L294`), so `/p/:a` and `/p/:b` are one route and the
  later replaces the earlier (`add()` calls `remove()` first, `#L280-L282`).
  **source**, **measured**.
- No optional, regex or named-wildcard params — they register literally:
  `/opt/:id?` gives `params {"id?": …}`, `/rx/:id(\d+)` gives
  `{"id(\\d+)": …}`, `/files/*rest` is a plain wildcard with `params {}`.
  **measured** (`results/semantics.txt`, `results/syntax.txt`). Open issues
  #17491 (optional), #23999 (`params['*']`), #26824, #23231, #41363.
- Param names may not start with a digit; a duplicate name in one route throws
  a "not yet implemented" TODO error; a key must start with `/` and be ASCII.
  **source** B`src/runtime/server/ServerConfig.rs#L521-L553`, `#L792`;
  **measured** (`results/syntax.txt`).
- Bun's param-name extractor treats any `:` as a name start, even
  mid-segment, while uWS only treats a segment *starting* with `:` as a param
  (B`src/jsc/bindings/ServerRouteList.cpp#L120-L150`): `/mid/:a-:b` matches
  `/mid/1-2` as one param reported as `{b: "1-2"}`. **source**, **measured**.
- Limits: `MAX_URL_SEGMENTS = 100` (`HttpRouter.h#L42`); 28-bit handler ids
  (`#L45`). **source**.
- Accepted values: function, method object, `Response`, `Bun.file`, HTML
  import, `{ dir }`, or `false` — a "negative route" that falls through to
  `fetch` (PR #34625, merged 2026-07-19). **source** ServerConfig.rs
  `#L797-L803`, B`src/runtime/server/mod.rs#L2404-L2423`.
- The legacy `static` key is read **only when `routes` is absent**
  (ServerConfig.rs `#L555-L566`). **source**, **measured**.

## 2. Route values

- Method-object keys honoured: CONNECT, DELETE, GET, HEAD, OPTIONS, PATCH,
  POST, PUT, TRACE (ServerConfig.rs `#L819-L829`). **source**.
- **A bare function or bare `Response` answers every method**
  (`RouteMethod::Any`), expanded internally into all 36 methods uWS knows
  (B`packages/bun-uws/src/HttpContext.h#L53-L90`, `#L1175-L1224`). `POST` to
  a static `Response` route returns the static body. **source**, **measured**.
- Static `Response`: body must be fully buffered; bytes held for the server's
  lifetime; an ETag is generated when absent and `If-None-Match` answers 304
  (B`src/runtime/server/StaticRoute.rs#L203`, `#L231-L260`). Docs: "at least
  15% performance improvement". **source**, **docs**, **measured**.
- `Bun.file` → `FileRoute`: read per request, 404 on missing file,
  Last-Modified / If-Modified-Since, Range, sendfile
  (B`src/runtime/server/FileRoute.rs#L132-L175`, `#L366-L393`). **source**.

## 3. Precedence, trailing slash, case, decoding

- Siblings sorted static, then `:`, then `*` (`lexicalOrder`,
  `HttpRouter.h#L66-L96`); matching is depth-first **with backtracking**.
  **source**, **measured** (`results/semantics.txt`: `/users/new` beats
  `/users/:id` registered before it; `/users/42/posts` falls to `/users/*`).
- Within a node, a specific method beats any-method only for equivalent
  patterns; tree structure wins over method specificity. **source**, **measured**.
- **`/a` and `/a/` are distinct**; `:param` never matches an empty segment
  (`HttpRouter.h#L190`); `/api/*` matches `/api/` but not `/api`. Open issue
  #17363; open PR #36280 (`ignoreTrailingSlash`). **source**, **measured**.
- **Case-sensitive.** **docs**, **measured**.
- **The router matches the raw request-target** (query stripped;
  `HttpParser.h#L500-L529`); literal segments are not percent-decoded (`/%61`
  does not match `/a`; issue #37603, PR #37615). **source**, **measured**.
- **Dot segments are not normalised by the router, but `req.url` is.** Raw
  `/users/../a` reaches the handler for `/users/:id/:x` with params
  `{id: "..", x: "a"}` while `req.url`'s path is `/a`; `%2e%2e` behaves the
  same; a raw `#frag` ends up inside the last param. **measured**
  (`results/dot-segments.txt`).
- Params are decoded with `decodeURIComponentSIMD`
  (B`src/jsc/bindings/decodeURIComponentSIMD.cpp#L40-L110`): **malformed
  escapes become U+FFFD and never throw** (`%zz` → `"�"`), `%2F` decodes to
  `/` inside the param, `+` stays `+`. **source**, **measured**.
- The params object has a null prototype and a per-route cached Structure
  (`ServerRouteList.cpp#L173-L236`). **source**.

## 4. HEAD, OPTIONS, method mismatch

- HEAD: function (any-method) routes receive HEAD and the body is dropped; a
  method object with GET and no HEAD derives HEAD from GET (PR #32822, merged
  2026-06-28, first in 1.4.0 by date — **inferred**). **source**, **measured**.
- OPTIONS: no automatic handling — falls to `fetch`. **measured**.
- **Method mismatch: no 405**, it falls to `fetch` (uncovered methods are
  registered to `fetch` as `/*`, mod.rs `#L2621-L2668`). **source**, **measured**.

## 5. fetch, error, websocket

- `fetch` is the fallback. **A route handler cannot decline**: returning
  `undefined` without an upgrade logs "Expected a Response object" and sends
  Bun's placeholder page. The only fall-through is a `false` route.
  **source**, **measured**.
- Throws and rejections go to `error()`. **source**, **measured**.
- `server.upgrade(req)` inside a route works when `websocket` is configured
  (mod.rs `#L2355-L2400`). **source**, **measured**.

## 6. server.reload()

- **Rebuilds the router from scratch every time**: `clear_routes()` replaces
  the uWS `HttpRouter`, `set_routes()` re-registers everything, a new
  `ServerRouteList` is created (B`src/runtime/server/server_body.rs#L2071-L2178`,
  B`packages/bun-uws/src/HttpContextData.h#L105-L112`). `fetch`/`error` are
  replaced only if given. **source**.
- **Atomic in practice**: clear and rebuild run synchronously on the JS
  thread uWS dispatches on, so no request sees a half-built table (**inferred**
  from source). A request in flight keeps its old handler, an open WebSocket
  survives, and 599 reloads during 9,600 requests produced zero misses.
  **measured** (`results/reload.txt`).
- **Known bug:** `reload()` *without* a `routes` key keeps function routes but
  drops static `Response`, `Bun.file`, HTML and `false` routes (`#L2155`).
  Open fix PR #41577 (2026-09-06). **source**, **measured** by the survey probe.
- Cost equals the initial registration (§7). **measured**.

## 7. Scaling

- Lookup is O(depth × siblings per level), linear `vector` scan, no radix
  compression. **source**. Measured on this machine with `oha`: 5,000 flat
  siblings, first-registered 120k req/s, last-registered 7.7k req/s; a miss
  that reaches `fetch` pays the full scan (`results/scaling.txt`,
  `results/scaling-order.txt`). The slow end is the one **registered last**,
  not the one that sorts last.
- **Registration is quadratic in siblings per node** (`getNode` scans
  siblings per insert, `HttpRouter.h#L80-L97`), and an any-method route pays
  it 36 times. Measured `Bun.serve` start, flat `/rN`:

  | Routes | 1,000 | 4,000 | 10,000 |
  |---|---:|---:|---:|
  | bare function (any method) | 79 ms | 1,321 ms | 15,389 ms |
  | `{ GET: fn }` (+ derived HEAD) | 6.8 ms | 72 ms | — |
  | `{ POST: fn }` | 4.0 ms | 37 ms | — |
  | bare function nested under 100 groups | 15 ms | 67 ms | — |

  (survey probe; `results/build-cost.txt` reproduces the bare-function rows.)
  No Bun issue about this was found.

## 8. Bun issues and PRs

- **Open:** #17363 (trailing slash), #17491 (optional params), #23999
  (wildcard params), #26824 (wildcard behaviour), #37603 (literal segments not
  decoded), #23231, #41363 (mixed segments), #17392, #40892, #40893, #42910,
  #23564, #20182, #43815 (reload ignores `tls`).
- **Open PRs:** #41577 (keep static routes on reload), #37615 (decode literal
  segments), #36280 (`ignoreTrailingSlash`).
- **Closed:** #19082, #29181, #16431, #17625, #17959, #17871, #18314, #17849,
  #20965, #17362, #26394.
- **Merged:** #32822 (HEAD from GET), #34625 (`false` routes).
- History: `static` in v1.1.27; `routes` in **v1.2.3**
  (https://bun.com/blog/bun-v1.2.3); per-method static `Response` by 1.2.14
  (**inferred** from Elysia's gate).

## 9. Elysia

- **Sucrose** (E`src/sucrose.ts#L653-L763`) reads each hook's and handler's
  `fn.toString()` and pattern-matches which of `query, headers, body, cookie,
  set, server, route, url, path` it uses; a context passed to another function
  means "assume everything". **source**; https://elysiajs.com/blog/elysia-10.
- **`composeHandler`** (E`src/compose.ts#L476-L610` ff.) builds a string and
  `Function(...)`s it: body parsed only for non-GET/HEAD *and* when used or
  validated; query/headers/cookie code only when used; async only when
  needed. Hooks become indexed call sites (`e.beforeHandle[i](c)`), each
  awaited only if async; a returning `beforeHandle` short-circuits.
  `aot` defaults to **true** in source (E`src/index.ts#L386-L388`; the
  configuration docs say `false`). **source**.
- **Native routes since 1.3.0** (`systemRouter`, default true;
  E`src/types.ts#L225-L232`; blog: "dynamic routes perform 2-5% faster",
  https://elysiajs.com/blog/elysia-13). `mapRoutes`
  (E`src/adapter/bun/index.ts#L84-L160`) maps every compiled route — **hooks
  included**, since the compiled handler contains them — into
  `routes[path][METHOD]`; skips WS routes, paths ending `*`, and exotic
  methods; expands optional params into each concrete variant; strips a
  trailing `/` from keys. `fetch` stays `app.fetch` for the rest. **source**.
- A single `server.reload()` runs right after `listen()`
  (`#L410-L433`); **routes added after that are not pushed to native
  routes** — they are served by `fetch`. **source**, **inferred** timing.
- Constant handlers with no hooks become native static `Response` routes
  (`createNativeStaticHandler`, E`src/adapter/bun/handler-native.ts`),
  disabled if the app has a global `onRequest`, `trace` or higher-order
  functions (`index.ts#L256-L263`). **source**.
- `fetch` side: a generated `switch(path)` over static routes, then
  **memoirist** (a radix tree, fork of Medley) for dynamic ones
  (E`src/compose.ts#L2349-L2470`). **source**.

## 10. Hono

No native routes: `hono/bun` / `@hono/bun` exports only `serveStatic`, SSG,
WebSocket helpers and `getConnInfo`
(https://github.com/honojs/hono/blob/18331a905e2415f7f73038357f2eec354123f7a6/src/adapter/bun/index.ts).
Hono apps run through `fetch`. **source**.

## 11. Published benchmarks

SaltyAom/bun-http-framework-benchmark (HEAD `383edddc3`, 2026-08-12): i7-13700K,
Bun 1.4.0-canary, bombardier at 500 connections. **docs**.

| Framework | Ping | Query | Body |
|---|---:|---:|---:|
| elysia | 405,261 | 221,856 | 210,579 |
| bun (raw) | 213,346 | 234,123 | 203,493 |
| hono | 261,351 | 194,434 | 185,414 |
| express (bun) | 84,899 | 78,103 | 61,255 |

Caveat (**inferred** from §1 plus a probe): the raw-Bun entry passes `static`
*and* `routes`, so its `static` Ping route is ignored and Ping hits `fetch` —
likely why raw Bun "loses" Ping to Elysia's native static `Response`.
