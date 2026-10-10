# Typed client: one route model, types from the server, an SWR data layer, live sync

Implementation plan for a **type-aware client request library** and the
server-side pieces it needs in `@kingsleyweb/bun-common` (both HTTP adapters).
The NestJS half is a separate document,
[`nest-typed-routes.md`](nest-typed-routes.md), sharing this plan's route
model and protocol (§9 says why it is split). The user asked:

> "The bun-views plan combined with api-docs-generation plan can aid or be the
> first implementation of a client aware request library that gets the types
> from the backend with hot reloading capabilities when it changes and can aid
> request, data validation, response handling, response caching, loading,
> websocket etc (basically all swr functionalities but in core typescript but
> with support for reactivity for different frameworks). This should support
> both httpadapter and nest js ecosystem. So if you need a different plan to
> plan how to implement helper decorators, guards, pipelines, etc (Nest
> ecosystem) on how bun validate with route description to build an endpoint
> or probably websocket to communicate types with the client on the fly during
> development."

and then, through the coordinator, on the same day:

> "it should come with a builtin zod validator although it should allow for
> bring your own validator to add extra validation outside the inbuilt schema
> validation. I dont know if this makes sense. Also ensure you expose option on
> the client side library to enable or disable or customise functionality. For
> instance enabling request body or request query validation etc."

That second request is §5 (validation) and §6.2 (configuration).

Written 2026-10-10 against `develop` at `7dac1de4`. **No product code was
changed.** Every `file:line` is at `7dac1de4` and relative to `packages/`
unless it says otherwise. The evidence is in
[`evidence/typed-client/`](evidence/typed-client/README.md), and each
measurement there can be re-run with one command.

### Status (2026-10-10)

| Part | State |
|---|---|
| This plan and `nest-typed-routes.md` | written; nothing built |
| **What it builds on, from [`api-docs-generation.md`](api-docs-generation.md)**: `.describe()`, `__schemas` on the validator, `validate(…, { responses })`, the JSON Schema converter registry, `generateOpenApi()` | **plan only, not started** (`grep __schemas packages/bun-common/lib` finds nothing). Its phases (a), (b0), (b), (b1) are this plan's critical path (§15) |
| [`bun-views.md`](bun-views.md) (merged #325): adapters, props on the wire, nonce, hydration | plan only; its PR-5 (hydration) is what SSR here uses (§6.6) |
| `bun-cache.md` (PR #319, branch `docs/plan-bun-cache`, not merged): tags, `cacheResponse()`, ETag/304 | plan only; §6.4 ties into its tags |
| SSE helpers ([`bun-native-routes.md`](bun-native-routes.md) §16, PR-sse1 to sse5) | not started; §6.5 uses them as the WebSocket fallback |

### Contents

1. [Executive summary](#1-executive-summary)
2. [What exists today](#2-what-exists-today)
3. [How types get from the backend to the client](#3-how-types-get-from-the-backend-to-the-client)
4. [Requests, responses and errors, as types](#4-requests-responses-and-errors-as-types)
5. [Validation on the client: built in, and bring your own](#5-validation-on-the-client-built-in-and-bring-your-own)
6. [The client core](#6-the-client-core)
7. [Reactivity bindings, and query-core or our own](#7-reactivity-bindings-and-query-core-or-our-own)
8. [Server side: bun-common, both adapters](#8-server-side-bun-common-both-adapters)
9. [NestJS: a separate document](#9-nestjs-a-separate-document)
10. [Packaging](#10-packaging)
11. [Using it ourselves: bun-jobs and bun-jobs-ui](#11-using-it-ourselves-bun-jobs-and-bun-jobs-ui)
12. [Tests and evidence](#12-tests-and-evidence)
13. [Risks](#13-risks)
14. [Open questions for the user](#14-open-questions-for-the-user)
15. [PR slicing and effort](#15-pr-slicing-and-effort)
16. [Names needing approval](#16-names-needing-approval)

### How to read the markings

The same marks the other plans use:

| Mark | Meaning |
|---|---|
| **[S]** | Read in this repo's source at `7dac1de4`. The `file:line` is given |
| **[M]** | Measured here by a spike that can be re-run. The evidence file is named |
| **[V]** | Read in a third party's docs or source at a pinned version, linked. "V-prior" when carried from another plan |
| **[I]** | Inference. A claim to test, never a finding |
| **[U]** | Unverified. Nothing may rest on it |
| **[D]** | A design decision this plan proposes |

**AD** is [`api-docs-generation.md`](api-docs-generation.md), **BV** is
[`bun-views.md`](bun-views.md), **BC** is `bun-cache.md` (PR #319), **NTR**
is [`nest-typed-routes.md`](nest-typed-routes.md). "The evidence" is
`docs/plans/evidence/typed-client/`.

---

## 1. Executive summary

### 1.1 The one-paragraph answer

**One route model, built at runtime from the routes an app already
registers, drives everything:** the OpenAPI document (AD), a generated
TypeScript map of every route (`Routes`), optional generated runtime schemas
(Zod by default), and a dev-only channel that pushes changes to a watcher,
which rewrites the client's types file **49 ms** after the server file is
saved under `bun --hot` [M, `sync/`]. The model comes from the
`validate(schemas, { responses })` and `.describe()` that AD already plans,
so a route author writes nothing new, and **today's statement-style routes
work unchanged**: the spike generated a correct `.d.ts` from six ordinary
`app.get(...)` statements on the unpatched router, with a mounted sub-router
[M, `codegen/`]. A monorepo may skip generation and **infer** the same map
from a `defineRoutes()` registry, which costs +2% type-check time at 1000
routes, where making `BunRouter`'s own verbs accumulate the map costs +49%
and needs chaining [M, `inference/`]. On the client, a dependency-free core
(`@kingsleyweb/bun-client`) builds typed requests (params, query, body,
headers, abort, timeouts, retries, middleware, auth refresh), validates
requests and responses with the built-in generated schemas plus any Standard
Schema the app brings, and returns a result discriminated by status. **The
data layer is `@tanstack/query-core`**, an optional peer with no dependencies
of its own, whose official adapters already cover React, Vue, Svelte 5,
Solid and Preact; we add typed query options, cache tags, ETag revalidation,
live invalidation over WebSocket or SSE, and SSR through bun-views. Writing
our own core was spiked too: 465 lines and 3.0 KB gzipped against
query-core's 10.5 KB, but without observer reconciliation, pending-promise
hydration, paused mutations or a binding per framework [M, `swr-core/`,
`bundle-size/`]. Nest controllers produce the same model through
`DiscoveryService` (NTR).

### 1.2 The decisions

| # | Decision | Why |
|---|---|---|
| D1 | **One route model**: a JSON document listing every route (`"GET /users/:id"`, `operationId`, params, request JSON Schemas, responses by status, cache tags, warnings) with a hash of its canonical form. Docs, codegen, live sync and Nest all produce or read it. | One description, four outputs, as the user asked. The hash is the change detector (§3.3). §3.0 |
| D2 | **The route author's shape is AD's**: `validate(schemas, { responses })` before the handler, `.describe({ … })` after. This plan adds two `.describe()` fields (`cache`, `channel`) and an app-level `commonResponses`. | Responses must sit before the handler to be enforced (AD Decision 4, spiked there). Nothing new to learn. §8.1 |
| D3 | **Generation plus live sync is the default for every layout**, monorepo included. **Inference is opt-in**, through a `defineRoutes()` registry (AD's (a2) registrar). `BunRouter`'s verb overloads keep returning `this`. | Generation works with statement-style routes; inference needs chaining or a registry. A client over a generated map of 1000 routes checks in 0.75 s against 7 to 10 s for inference [M]. The accumulating router costs +49% [M]. §3.4 |
| D4 | **The live sync is a dev-only HTTP endpoint plus a WebSocket that announces the model's hash**; a CLI watcher rewrites the generated files atomically. It refuses `NODE_ENV=production`, needs `enabled: true`, a bearer token, loopback, and answers 404 otherwise. | 49 ms edit-to-file under `--hot`, 160 ms under `--watch`, against 560 ms for the 1 s polling the existing tools use [M]. No surveyed tool pushes types from a running server [V]. §3.3 |
| D5 | **Params and query are typed from the schema's output values with the input's optionality; bodies from the input; responses from the output, after a JSON round trip (`Jsonify`).** | `z.coerce.number()` has input `unknown`; typed from the input, the client accepted `{ page: "x" }` [M]. A defaulted key is required in the output, optional in the input [M]. A `Date` arrives as a string. §4.1 |
| D6 | **Responses come from declared schemas, not handler inference.** Undeclared routes get `{ 200: unknown }` and a warning. A status the route does not declare **throws** `UnexpectedStatusError` by default. | Handlers return `res`, not the body (AD §3.7). A catch-all `number` member would ruin narrowing by status. §4.2 |
| D7 | **A call returns a result discriminated by status** (`{ ok, status, data }` or `{ ok, status, error }`); `throwOnError: true` turns failures into a typed `HttpError`. Errors are problem+json with a generated `code` union. | bun-jobs-ui compares 32 error codes as strings because its contract exports no union [S, survey]. §4.3 |
| D8 | **Built-in runtime validation is generated Zod**, in `@kingsleyweb/bun-client/zod` with zod an optional peer; `zod/mini` by default. A monorepo may pass the server's own schemas when their module is browser safe. | A client in another repo cannot import the server's schema objects. `zod/mini` is 8.9 KB gz for 50 routes and eval-free; classic zod is 26.2 KB and contains `new Function` [M]. §5.1 |
| D9 | **Bring your own validator: any Standard Schema, run after the built-in one, issues merged into one `ValidationError`** of `{ target, message, path }`; `replace: true` drops the built-in one for that part. | BunValidate's rule and BunValidate's issue shape. §5.4 |
| D10 | **Every behaviour is configurable at three levels, global → per route → per call, later wins**; defaults make zero-config work. | The user's request. §6.2 |
| D11 | **Validation defaults: on in development, off in production**, for requests and responses; a request failure throws, a response failure warns. | Response validation costs 22 µs on a 20-user list with generated classic Zod (35 µs jitless, 37 µs `zod/mini`), against 11 µs for `JSON.parse` [M]. A server already validates the request. §5.5 |
| D12 | **The data layer is `@tanstack/query-core` (optional peer, `^5`)**: `/query` exports typed `queryOptions`/`mutationOptions`/`infiniteOptions` factories; framework subpaths are thin wrappers over the official adapters. | All five frameworks are covered officially [V]; query-core has no dependencies; 10.5 KB gz [M]. Our own core would cost ~15–20 days more for parity and leave five bindings to maintain. §7 |
| D13 | **Cache tags are declared on routes** (`.describe({ cache: { tags, invalidates } })`, templated by params); a mutation invalidates by tag; the server can push the same tags live. | query-core has prefix and predicate invalidation, no tags [V]; `meta.tags` plus a predicate covers it. Shares BC's tag names. §6.4 |
| D14 | **Revalidation is conditional**: the query function sends `If-None-Match` with the last ETag and keeps the cached data on a 304. | bun-common already answers 304 from `res.send` (`bun-common/lib/BunResponse.ts:1537-1548`) [S]; query-core hands the query function the client (`query-core/src/types.ts:174-183`) [V]. The spike's core proved the semantics [M]. §6.4 |
| D15 | **Live queries push invalidations, not data**, over WebSocket with SSE as the fallback; after a reconnect gap the client invalidates every active query. | TkDodo's guidance and tRPC's `tracked()` resume [V]; bun-jobs-ui already does this by hand (`bun-jobs-ui/app/live/live.ts:223-267`) [S]. §6.5 |
| D16 | **SSR uses bun-views' props channel**: the server prefetches through `router.fetch()` in process, dehydrates into the view's props, and the client entry hydrates query-core before hydrating the view. | No socket, the production pipeline (CLAUDE.md "Testing without a socket"); the props are JSON already; BV's `jsonForScript` and nonce apply (BV §4.6.4) [V-prior]. §6.6 |
| D17 | **No runtime code reaches a browser bundle from bun-common or the server.** The client depends on nothing of ours at runtime; a bundle-safety test with a negative control guards every browser subpath. | The bun-jobs `api/contract` lesson (`bun-jobs-ui/__tests__/app/pkg/bundle-safety.test.ts`) [S]. §10 |
| D18 | **The Nest half is its own document** (NTR), on the same model and protocol: `@Validate` (AD (g)) is the typed-route decorator, an explorer builds the model through `DiscoveryService` (measured: 6 routes in 8.7 ms, every key matching the adapter's registered routes), and a `DevTypesModule` serves it. | The Nest surface (decorators, pipes, guards, interceptors, discovery, gateways) is a design of its own, and has a different owner. §9 |
| D19 | **bun-jobs' management API and bun-jobs-ui are the first consumer, as a pilot of one domain**, not a rewrite. | It has 84 routes declared with schemas, and the UI hand-writes 78 `request<T>()` calls, 11 key factories and 20 shape assertions [S, survey]. §11 |

### 1.3 What it costs

| Part | Effort | Owner | Depends on |
|---|---|---|---|
| AD (a), (b0), (b), (b1): `.describe()`, `__schemas`, responses on the validator | 15–20 d **(AD's own estimate, not this plan's)** | bun-common agent | — |
| Server: route model, dev sync, live channel (PR-M1 to M3) | ~10 d | bun-common agent / features | AD (a), (b), (b1) |
| Client: core, codegen, watcher, validation and `/zod`, query layer, React, live, persistence (PR-C1 to C8) | ~26.5 d | features agent | PR-M1 for C2 on |
| Inference registry (`defineRoutes`, = AD (a2)) | ~2.5 d | bun-common agent | AD (b1) |
| Later, on demand: Vue, Svelte, Solid, Preact bindings; typed WS channels | ~6 d + ~5 d | features agent | PR-C5 |
| Nest (NTR) | ~13 d | bun-nest agent / features | PR-M1, AD (g) |
| Pilot in bun-jobs-ui (one domain) | ~4.5 d | bun-jobs and bun-jobs-ui agents | PR-C2, PR-C5 |
| Examples, per PR | ~4 d | examples agent | each PR |
| **Total for this plan, React first** (server, client, registry, pilot, examples) | **~47.5 d**, plus NTR's ~13 d, AD's own phases and ~6 d of bindings on demand | | |

§15 has the order, what each PR proves, and the gates.

---

## 2. What exists today

### 2.1 bun-common: typed routes, a validator, a route list

- **The verb overloads type the handler, and return `this`.** 25 generated
  blocks (checkout … view, plus `all`), 10 overloads each, 250 in all: a
  handler alone, then a validator and a handler behind 0 to 8 plain handlers
  (`bun-common/lib/BunRouter.ts:1669-1756` for `get`;
  `scripts/generate-verb-overloads.ts:29`, `MAX_PRECEDING = 8`) [S]. **Every
  one returns `this`**; no route type accumulates anywhere [S]. The class is
  `BunRouter<TMountPath, TMountShape, THost>` (`BunRouter.ts:803-833`) with a
  phantom `__mount` (`:835`) [S].
- **`validate()` advertises the parsed shape as a phantom type only**:
  `ValidatorMiddleware<TShape> extends RouterHandler { readonly __shape?:
  TShape }` (`bun-common/lib/BunValidate.ts:553-556`), with
  `InferValidatedShape` built from **output** types (`:94-108`) [S]. The
  schemas themselves are not reachable at runtime (AD Decision 2) [V-prior].
- **`routes()`** (inherited from `@routejs/router`) lists every route, with
  `method`, `path`, `params`, `group`, `name` and `callbacks`
  (`node_modules/@routejs/router/index.d.ts:10-27`) [S]. Measured: a mounted
  sub-router's routes come back with the **full** path and `group` set to the
  mount; a `use()` layer has no `path`; an `all()` route has no `method`
  [M, `codegen/`].
- **`router.ws(path, handler)` takes a plain `string`** (`BunRouter.ts:1251-1300`)
  and `BunWebSocket` types nothing but `ws.data.custom`; messages are
  `string | Buffer`, and there is no topic or pub/sub abstraction
  (`BunWebSocket.ts:42-75`, `:393-415`) [S].
- **ETag and 304 are per response**: `res.etag`/`setEtag()`
  (`BunResponse.ts:1070-1117`), and Express's `send` tail answers 304 when
  `req.fresh` (`:1537-1548`); the adapter has an `etag` option
  (`BunHttpAdapter.ts:309-314`) [S]. No HTTP cache middleware exists yet; BC
  plans `cacheResponse()`.
- **No SSE helper exists** (`BunResponse.ts:1940-1950` says to set
  `text/event-stream` yourself) [S].

### 2.2 What AD already plans, and this plan reuses

AD is a plan only (status line in AD; nothing in `lib/` yet [S]). This plan
takes these pieces as given and does not restate their design:

| AD piece | What it gives this plan |
|---|---|
| `.describe(doc)` chained after a verb, stored in a `WeakMap` keyed by the terminal callback, which survives mounting (AD Decision 1, measured there) | prose, `operationId`, `tags`, and the two fields this plan adds (§8.1) |
| `__schemas` on the validator middleware (AD Decision 2) | the request schemas at runtime, for the model |
| `validate(schemas, { responses })`, narrowing `res.status().json()` at compile time and optionally checking at runtime (AD Decision 4, §3.5, §3.7) | the response types, enforced on the server |
| `~standard.jsonSchema` first, a structural vendor registry second (AD Decision 3, §4.3) | JSON Schema for the model, with no vendor import |
| `DiscoveredRoute` and `generateOpenApi()` (AD §3.3) | the model is the discovered routes, serialised; OpenAPI is generated from it |
| `WsChannelDoc` and AsyncAPI 3.0 (AD §5) | the channel half of the model (§6.5, later) |
| `@Validate` for Nest (AD §3.8, phase (g)) | NTR's typed-route decorator |

### 2.3 bun-jobs and bun-jobs-ui: what a typed client would have removed

The surveyed numbers, all [S] at `7dac1de4`:

- **The server has a single source of truth.** 84 routes declared with
  `defineRoute` (`bun-jobs/lib/api/routes/define.ts:191-200`): method, path,
  `operationId`, summary, tags, `params`/`query`/`body` schemas,
  `responses` by status, `errors` codes. Its `s.*` schemas are Standard
  Schemas with JSON Schema attached (`schema/builder.ts:31-47`), and feed
  OpenAPI 3.1 (`spec/openapi.ts:302-407`) and AsyncAPI 3.0
  (`spec/asyncapi.ts:330`).
- **The browser contract has no route table.** `api/contract` exports 179
  hand-restated types (124 `…Dto`), 86 constants and 23 WS frame types, but
  no method/path map, no `operationId`s and no error-code union
  (`contract/types.ts:72-73`: `ProblemDto.code` is `string`). Keeping the
  restated types honest takes a 2,338-line type test with ~733 `Equal` lines
  (`__tests__/api/api-contract.type-test.ts`).
- **The UI restates everything again.** `app/api/` is 19 files and 3,338
  lines: **78 `request<T>("METHOD", "/path")` calls** with a caller-asserted
  `T` (`app/api/client.ts:84-88`), 11 path helpers (`jobPath` duplicated in
  `jobs.ts:96` and `queues.ts:192`), **11 query-key factories**, **20
  `assertShape` sites** (`app/api/shape.ts:28-45`), **32 string comparisons
  of error codes**, an unchecked WS frame cast
  (`app/live/client.ts:987`), and 386 `"GET /path"` literals in test mocks.
  27 real-API integration test files exist largely to keep it in step.
- **Its live client already does live invalidation by hand**: subscribe to
  channels, resume with `{ epoch, afterSeq }`, turn a failed resume into a
  gap, and invalidate the given query keys within 250 ms of an event
  (`app/live/live.ts:223-267`, `app/live/client.ts:324-343`).

### 2.4 What bun-views gives the SSR story

BV (merged as a plan in #325) carries a view's props to the browser as
`self.__BV_PROPS = <jsonForScript(props)>` in a nonce'd inline script, which
every adapter hydrated from in Chrome with hostile strings in the props
(BV §4.6.4) [V-prior]; it builds a client entry per view with `Bun.build`,
SRI and a per-request nonce (BV §4.6.3, §4.6.5); and it warns when props do
not survive JSON (BV §4.6.4). Its adapters are React, Vue, Svelte, Preact
and Solid, "core first, frameworks on demand" (BV D10). §6.6 and §7 mirror
both.

### 2.5 Prior art

Read from docs and source at pinned versions on 2026-10-10 (two survey agents;
tarballs kept in the session's scratch). Sizes are **our measurement**
(`bundle-size/`) where a row says [M], the survey's own `bun build` where
[V].

**Typed clients:**

| Library | How types travel | Responses and errors | Scale notes | Dev regeneration | Client runtime |
|---|---|---|---|---|---|
| Elysia Eden Treaty 1.4.9 | inference: each verb returns a new `Elysia<…, Routes & CreateEden<…>>` [V] | per status, `data`/`error` [V] | "use Eden Fetch over 500 routes" ([eden/fetch](https://elysiajs.com/eden/fetch)) [V] | none (tsserver) | 3.3 KB gz [V] |
| Hono RPC 4.13.13 | inference; routes must be **chained** for the type to accumulate ([guide](https://hono.dev/docs/guides/rpc)) [V] | `c.json(body, 404)`, `InferResponseType<T, 200>` [V] | "compile the client type with tsc" (`hcWithType`) [V] | none | 2.1 KB [V] |
| tRPC 11.19 | inference from `typeof appRouter` [V] | RPC codes, `errorFormatter`, no per-status union [V] | v10 halved check time by making evaluation lazy ([blog](https://trpc.io/blog/typescript-performance-lessons)) [V] | none | 9.2 KB [V] |
| oRPC 1.15.5 | router-first inference, or a contract; a router minified to JSON for other repos [V] | `errors({ NOT_FOUND })`, typed `safe()` [V] | a page on **TS7056** for one big exported router ([docs](https://orpc.dev/docs/advanced/exceeds-the-maximum-length-problem)) [V] | none | 8.1 KB [V]; opt-in request/response validation plugins [V] |
| ts-rest 3.52.1 | a shared contract object [V] | `{ status, body }` union [V] | — | not needed | 1.9 KB [V]; quiet since 2025-06 [V] |
| openapi-typescript 7.13 + openapi-fetch 0.17 | codegen from OpenAPI to a `paths` type [V] | `{ data, error }` [V] | plain interfaces [I] | **no watch**, `--check` only [V] | 2.7 KB gz [M] |
| orval 8.41 / Kubb 5.5.6 / hey-api 0.99 | codegen to hooks + zod for react/vue/svelte/solid [V] | per status [V] | — | orval watches local files; **Kubb polls a URL every 2 s; hey-api polls every 1 s with `If-None-Match`** [V] | per generator |
| nestia 14.0.3 | a Go TS transform under TS 7 (ttsc) reading controllers [V] | `propagate` unions [V] | — | — | Bun only through `@ttsc/unplugin` preload, restart on change [V] |

**Nobody pushes types from a running server.** Inference relies on the
language server re-reading shared source; generators watch a file or poll a
URL [V]. §3.3's channel is new; its HTTP half (an ETag'd model) is also
exactly what hey-api's and Kubb's watchers consume [I].

**Data layers** (sizes [M], `bundle-size/results.txt`, framework external):

| Library | Framework support | min / gzip | Notes |
|---|---|---|---|
| `@tanstack/query-core` 5.104.1 | core, no dependencies [V] | 37.3 / **10.5 KB** | observers, structural sharing, gc, retryer, focus/online managers, hydration of pending promises (5.40+) [V] |
| + `react-query` / `vue-query` / `svelte-query` 6.3.1 / `solid-query` / **`preact-query`** | all official [V]; Svelte's v6 is runes (`svelte ^5.25`); Preact's peer is `preact ^10` while Preact 11 is out [V] | 11.6 / 11.5 / 10.9 / 11.3 / 10.7 KB gz | ~1 KB per adapter over the core |
| swr 2.5.1 | React only (`useSyncExternalStore`) [V] | 17.0 / 7.5 KB | no gc; Map-like cache provider [V] |
| `@nanostores/query` 0.3.4 + nanostores | bindings for react/preact/vue/svelte/solid at 0.2–0.7 KB [V] | 7.4 / 3.4 KB | no SSR hydration, no infinite queries, no structural sharing [V/I] |
| our spike core (`swr-core/core.ts`) | React binding spiked | 7.4 / **3.0 KB** (+React 3.2) | §7.2 says what it leaves out |
| Apollo 4.3.3, urql core 6.0.3 | normalised by `__typename:id` [V] | 43.7, 11.0 KB gz [V] | normalisation needs a type tag REST payloads lack [I]; normy offers it for REST with id-uniqueness rules [V] |

**Streaming:** tRPC's `tracked(id, data)` re-sends every subscription with its
`lastEventId` on reconnect, and recommends SSE first [V]. TkDodo's guidance
for WebSockets with query-core: push invalidations, not data
([post](https://tkdodo.eu/blog/using-web-sockets-with-react-query)) [V].
`EventSource` sends no custom headers and is capped at six connections per
origin on HTTP/1.1 ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/EventSource))
[V]; `@microsoft/fetch-event-source` is unmaintained since 2021 [V];
`eventsource-parser` 4.1.1 is a maintained parser with no transport [V].
socket.io types events as two interface maps, and validates nothing [V].

---

## 3. How types get from the backend to the client

### 3.0 The route model [D]

Everything in this plan reads one structure. The spike's version is
`codegen/describe.ts`; the package's is PR-M1's.

```ts
/** The routes an app serves, as data. Produced by bun-common's walk, by bun-jobs, or by the Nest explorer. */
export interface RouteModel {
  /** Format version. */
  version: 1;
  /** sha-256 (16 hex) of the canonical JSON of `routes` and `channels`: the change detector. */
  hash: string;
  /** Every endpoint, sorted by `key`. */
  routes: ModelRoute[];
  /** WebSocket channels (§6.5, later PR). */
  channels?: ModelChannel[];
}

/** One endpoint. */
export interface ModelRoute {
  /** `"GET /users/:id"`: method, a space, the Express-syntax path with mounts joined. The client map's key. */
  key: string;
  method: string;
  path: string;
  /** Path parameter names, in order. */
  params: string[];
  /** From `.describe({ operationId })`, else `camelCase(method + path)` as AD derives it. Unique. */
  operationId: string;
  /** JSON Schemas (draft 2020-12): params and query as §4.1 says; body from the input. */
  request: { params?: JsonSchema; query?: JsonSchema; body?: JsonSchema; headers?: JsonSchema };
  /** status → JSON Schema of the output, `null` for a status without a body. Common responses merged in. */
  responses: Record<string, JsonSchema | null>;
  /** From `.describe({ cache })`: templates such as `"user:{id}"`. */
  cache?: { tags?: string[]; invalidates?: string[] };
  /** `.describe()` prose the client exposes in hovers: summary, deprecated. */
  doc?: { summary?: string; deprecated?: boolean };
  /** What could not be described, and why. Copied into the generated file as comments. */
  warnings: string[];
}
```

The TypeScript side is a **flat map keyed like the model**, which both
generation and inference produce, so one client type serves both:

```ts
export interface Routes {
  "GET /users/:id": {
    operationId: "getUser";
    params: { id: string };
    query: Record<never, never>;
    body: undefined;
    responses: { 200: User; 404: Problem };
  };
  // …
}
```

A flat map keyed by method and path is the cheapest shape the survey found
for a type checker (openapi-fetch's `paths`, Eden Fetch for large apps) [V],
and it measured so here (§3.2). `Record<never, never>`, not
`Record<string, never>`: the spike's first emitter wrote the latter, whose
`keyof` is `string`, and every call then demanded a `params` it did not have
[M].

### 3.1 (a) Inference: the server's type, no generation

**Question:** can `BunRouter`'s generated per-verb overloads accumulate a route
map, or does it need a builder? Spiked three ways against the **real** class
[M, `inference/`]:

- **v1, the router itself.** `patch-router.ts` copies `bun-common/lib` and
  changes only types: a fourth class parameter `TRoutes = {}`; each of the
  250 typed verb overloads returns `BunRouter<…, TRoutes & RouteEntry<VERB,
  \`${TMountPath}${TPath}\`, TShape>>` instead of `this`; the two typed
  `use(path, subRouter)` overloads infer the sub-router's routes and
  intersect them. **The patched library typechecks clean**, handlers stay
  narrowed (a `@ts-expect-error` in every module proves `req.query.page` is
  still `number | undefined`), and mounting works because a sub-router's keys
  already carry its mount path. It works only for **chained** calls.
- **v2, a registry.** No router change: `defineRoutes(mount, r => ({ getItem:
  r.get(path, validator, handler), … }))` returns an object whose type is the
  map; it is mounted on a router at runtime. This is AD's optional (a2)
  `routes([...])` registrar under another name.
- **v0, today**: statements on the real router, as the baseline.

Each route has its own zod schemas (params, query, body on POST/PUT) and two
declared responses; modules of 50. Median of three `tsc --extendedDiagnostics`
runs, TypeScript 6.0.3, through the heavy-run wrapper [M, `inference/results.txt`]:

| Routes | v0 check / memory | v1 (router accumulates) | v2 (registry) | client against emitted `.d.ts`: v1 / v2 |
|---|---|---|---|---|
| 50 | 2.03 s / 306 MB | 2.92 s / 394 MB | 2.49 s / 300 MB | 3.03 s / 2.18 s |
| 200 | 3.15 s / 423 MB | 3.89 s / 500 MB | 2.96 s / 385 MB | 3.42 s / 2.22 s |
| 1000 | 6.92 s / 843 MB | **10.30 s / 973 MB (+49%)** | **7.07 s / 928 MB (+2%)** | 4.72 s / 1.77 s |

- Declaration emit raised **no TS7056, TS2742 or TS4023** at any size, with
  `app.d.ts` at 1.1 MB (v1) and 1.45 MB (v2) for 1000 routes [M]. oRPC hits
  TS7056 with one big exported router [V]; per-module exports stayed under it.
- v1's cost is the intersection being re-examined at every chained call
  (+1.47 M instantiations at 1000) [M].

**Statements cannot accumulate a returned type.** An assertion signature
(`asserts this is BunRouter<…>`) does narrow the variable statement by
statement, and a `typeof` query at the end of the module sees the narrowed
type, so it can even be exported [M, `inference/probes/`]. It is still not an
option for `BunRouter`: the variable needs an explicit annotation (TS2775);
an assertion method returns `void`, which would break every chain,
`.describe()` and `.setName()`; and narrowing stops at a function boundary,
so routes registered in `registerUsers(app)` never reach the caller [M].

**Decision [D]:** do **not** change the verb overloads' return type. Offer
inference through the registry, which costs 2%, is additive, gives every
route a name (an `operationId` for free), and is AD's (a2) anyway. Its type
is turned into the flat map by `RoutesOf<typeof api>`.

### 3.2 (b) Generation: the model to a `.d.ts`

The spike walks `router.routes()` of six **statement-style** routes on the
**unpatched** router (one mounted at `/orgs/:org`, one with no validator),
finds the schemas and declared responses on the validator middleware (the
`__schemas` property AD Decision 2 adds; the spike attaches it in a `dv()`
wrapper), converts them with `~standard.jsonSchema`, and emits `Routes` with
a ~90-line JSON Schema → TypeScript emitter [M, `codegen/`]:

- `tsc` is clean over a client file with positive calls and
  `@ts-expect-error` negative controls (a missing body field, a string page,
  an unknown route) [M].
- **Parity:** for a representable schema, the generated response type is
  `Equal` to `Jsonify<z.output<schema>>`, the type inference would give [M].
- **Where they differ:** a `z.date()` cannot be represented in JSON Schema;
  zod throws, the model falls back to `{}` with a warning, and the generated
  type is `unknown` where inference gives `string`. The negative control in
  `client-check.ts` pins that difference [M]. §5.3 lists the rest.

**At scale** [M, `codegen/scale-results.txt`]: building the model for 1000
routes takes ~0.2–0.3 s (almost all of it `~standard.jsonSchema`), emitting
22 ms, and the generated file is 527 KB. **A client file checks against it
in 0.75 s and 150 MB**, against 1.8 s (registry) and 4.7 s (accumulating
router) through emitted declarations, and 7 to 10 s against the server's
source [M]. A client in another package pays only for the map.

**How it is run [D]:**

```bash
bunx bun-client generate --url http://127.0.0.1:3000 --out src/api.gen.ts [--zod src/api.zod.gen.ts]
bunx bun-client generate --module ./server/app.ts --export app --out …   # in process, no server running
bunx bun-client generate … --check                                       # CI: exit 1 if the files are stale
```

`--module` imports the app module and calls bun-common's model builder, so
CI needs no running server; `--url` reads the dev endpoint (§3.3) or any
server serving a model. A file's header records the hash it was generated
from, which is how `--check` and the watcher decide.

### 3.3 (c) Live sync in development

The user asked for types that follow the server while developing, without a
manual step. Measured end to end [M, `sync/`]:

| Server run as | Save → client file changed, median / p90 | What happens |
|---|---|---|
| `bun --hot` | **49 ms / 68 ms** | the module re-evaluates; the hub on `globalThis` sees a new hash and announces it on the open socket (0 reconnects in 10 edits); the watcher fetches, emits and renames |
| `bun --watch` | 160 ms / 163 ms | the process restarts; the watcher reconnects and reads the hash in the greeting |
| polling every 1 s (hey-api, Kubb) | 560 ms / 1,043 ms | the interval dominates |

Building the model took ~1.3 ms for that app, fetch and emit ~1 ms: nearly
all of the 49 ms is Bun noticing the save and re-evaluating [M].

**The protocol [D]:**

| Piece | Shape |
|---|---|
| Model endpoint | `GET <path>` (default `/__bun/types`): `200` with the `RouteModel`, `ETag: "<hash>"`, `Cache-Control: no-store`; `304` on a matching `If-None-Match` |
| Channel | WebSocket at `<path>/ws`, subprotocol `bun-types.v1`. Server → client: `{ type: "hello", version: 1, hash }` on open, `{ type: "model", hash, at }` on every change. Client → server: `{ type: "ping" }`. Nothing else: the channel carries hashes, never the model, so one slow watcher costs nothing |
| Change detection | the model's hash is the truth. Three triggers recompute it: a re-evaluation under `--hot` (the hub lives on `globalThis`, measured to survive), a restart under `--watch` (the greeting), and a route registered at runtime (a `routesVersion` counter bumped in `setRoute`, polled every 100 ms **only while a watcher is connected**) |
| Cost when unused | the model is built lazily, on a `GET` or while a watcher is connected. 1000 routes cost ~0.3 s to build [M], so building it on every reload of a large app with nobody listening would be waste |
| Watcher | `bun-client watch --url … --out … [--zod …]`: compares the announced hash with the file header's, fetches with `If-None-Match`, emits, writes to a temp file and renames, and only when the content changed (an unchanged file must not wake tsserver). On disconnect it keeps the last file and reconnects with backoff (50 ms doubling to 2 s). A Vite plugin and a Bun build plugin are the same loop in another host, built on demand [D] |

**Auth and exposure: fail closed [D].** Measured in the spike: no token →
404, token → 200, matching ETag → 304, and `NODE_ENV=production` refuses to
start [M]. The package version:

- `enabled` must be `true`; there is no implicit on, and no environment
  variable turns it on.
- Under `NODE_ENV=production` it throws a `ConfigError` even when enabled, so
  a dev flag copied into a production config fails the boot rather than
  exposing the routes.
- A bearer token, random per process unless given; written with mode `0600`
  to `node_modules/.cache/bun-types/<port>.json` (with the URL), where the
  watcher finds it on the same machine, and logged once at `info`. Browsers
  cannot set headers on a WebSocket, so a browser tool would offer it as a
  second subprotocol (`bun-types.v1, token.<t>`) [D].
- Loopback peers only (`server.requestIP()`), unless `allowRemote: true` (a
  dev server in a container), which still needs the token.
- **404, never 401 or 403**, for anything refused, so its existence is not
  confirmed. (The Nest spike's guard answered 403, Nest's default for a
  guard; NTR's guard throws `NotFoundException` instead [M, `nest/`].)
- The endpoint hides itself and anything marked `hidden` from the model.

**Who needs it:** the separate-repo client always; a monorepo using
generation (the default, D3). A monorepo using the registry does not: the
language server re-reads the server's source.

### 3.4 Recommendation: the combination [D]

| Layout | Types | Runtime schemas | In development | In CI |
|---|---|---|---|---|
| **Separate repos** | generated `Routes` | generated Zod (§5) | `bun-client watch` against the dev server | `bun-client generate --url <staging> --check`, or the server repo publishes the model as an artifact |
| **Monorepo, default** | generated `Routes`, committed | generated, or the server's own schemas when browser safe (§5.1) | `bun-client watch` | `bun-client generate --module … --check` |
| **Monorepo, opt-in** | inferred: `RoutesOf<typeof api>` from `defineRoutes()` | the server's own schemas when browser safe | the language server | `bun scripts/typecheck.ts` |

**This differs from the expected "(a) for monorepos, (b)+(c) for separate
repos"** in one place: generation is the default in a monorepo too. The
reasons are measured: generation works with the statement-style routes this
repo and its users write, without moving them into a registry or a chain;
its client checks in 0.75 s at 1000 routes, an order of magnitude under
inference; and a monorepo that wants inference loses nothing by waiting for
the registry PR. Q1 asks.

---

## 4. Requests, responses and errors, as types

### 4.1 Input or output: which side of a schema the client sees [D] [M]

| Part | Type the client uses | Why |
|---|---|---|
| params, query | the schema's **output** value types, with the **input's** optionality | They cross as strings and are coerced. `z.coerce.number()` has input `unknown` in zod 4: typed from the input, `{ page: "x" }` compiled, and the negative control caught it [M, `inference/`]. A key with a default is required in the output and optional in the input: the client may omit it [M, `codegen/`] |
| body | the **input** | JSON crosses as it is; transforms run on the server |
| headers | the output's values, the input's optionality | as query |
| responses | the **output, after a JSON round trip**: `Jsonify<T>` | what `JSON.parse` returns. A `Date` becomes `string`; a function or `undefined` field disappears |

The generator applies the same rule to JSON Schema: `required` from the
input's schema, `properties` from the output's (`keysInValuesOut` in
`codegen/describe.ts`) [M].

### 4.2 Response types come from declarations [D]

Handler return values cannot be inferred: a bun-common handler returns `res`
or nothing, and AD measured that typing the return rejects the repo's own
style (AD §3.7) [V-prior]. So:

- A route with `validate(…, { responses })` has its responses typed, and
  enforced on the server at compile time (AD (b1)).
- A route without them is `{ 200: unknown }` in the model, with a warning
  copied into the generated file. `strict` generation fails instead (AD's
  `strict` option).
- **Common responses**: statuses every route can produce because of
  middleware (a 400 validation problem, 401, 403, 429, 500) are declared once,
  `buildRouteModel(router, { commonResponses: { 400: ValidationProblem, … } })`,
  and merged into every route unless the route declares that status itself.
  Hono's `ApplyGlobalResponse` is the same idea [V].
- `res.send()`, `res.jsonp()` and a helper typed `BunResponse` escape the
  server-side check (AD §3.7's measured boundary) [V-prior]. Runtime response
  validation (§5.5) is the backstop.

### 4.3 Errors [D]

- **problem+json** (RFC 9457) is the declared shape of an error status, as
  bun-jobs does (`contract/types.ts:57-86`) [S]. `ValidationProblem` extends
  it with `issues: { target, message, path }[]`, BunValidate's issue shape.
- **Error codes become a union.** `.describe({ errors: ["NOT_FOUND", …] })`
  (or bun-jobs' `errors` field) puts the codes in the model; the generator
  writes `code: "NOT_FOUND" | "CONFLICT"` into that route's problem type.
  bun-jobs-ui's 32 string comparisons become checked [S, survey].
- **A status the route does not declare throws** `UnexpectedStatusError`
  (with the `Response`) by default, as ts-rest's `throwOnUnknownStatus`
  does [V]. A result type with a catch-all `{ status: number; error: unknown
  }` member would make `if (r.status === 404)` narrow to `Problem | unknown`,
  which is `unknown`. `undeclaredStatus: "result"` opts into the catch-all.
- Network failures, timeouts and aborts throw `NetworkError`,
  `TimeoutError` and the platform's `AbortError` respectively; a validation
  failure throws `ValidationError` (§5.4). All extend `ClientError`.

### 4.4 The result [D]

```ts
type Result<E extends RouteEntry> =
  | { [S in SuccessStatus<E>]: { ok: true; status: S; data: Jsonify<E["responses"][S]>; response: Response } }[SuccessStatus<E>]
  | { [S in ErrorStatus<E>]: { ok: false; status: S; error: Jsonify<E["responses"][S]>; response: Response } }[ErrorStatus<E>];

const r = await api.get("/users/:id", { params: { id } });
if (r.ok) r.data.name;                          // 2xx members only
else if (r.status === 404) r.error.code;        // "NOT_FOUND"
```

`throwOnError: true` (any level, §6.2) makes a call return `data` and throw
`HttpError<E>` (with the typed `status` and `error`) for a declared error
status. The query layer always uses the throwing form, because query-core
treats a rejection as the error state [V].

---
## 5. Validation on the client: built in, and bring your own

The user's addition: a built-in Zod validator, room to bring one's own for
extra checks, and switches for each part. It makes sense, with one honest
limit (§5.3). This section is the design; §6.2 has the switches.

### 5.1 Where a client's runtime schemas come from [D]

The **server stays Standard Schema**: any library BunValidate accepts (zod,
valibot, arktype, yup, `toStandardSchema` for anything else). What reaches the
client differs by layout:

| Layout | Runtime schemas on the client | Possible when |
|---|---|---|
| Separate repos, or the server's schemas are not browser safe | **generated Zod**, from the model, beside the generated types, by the same `generate`/`watch` | always: the model is JSON |
| Monorepo, schemas in a browser-safe module | **the server's own schema objects**, passed as `schemas: () => import("../shared/schemas")` | the module imports no server code: no `node:*`, no drivers, no bun-common runtime. A bundle-safety test (§10.3) proves it. Any Standard Schema library works, and nothing is lost to JSON Schema (§5.3) |

The second row is the monorepo case the coordinator asked about. It needs the
schemas to live in their own module that both sides import; a schema
declared inline in a route file drags the route file, and with it the
server, into the browser bundle. The bundle-safety test catches that.

### 5.2 The built-in validator: generated Zod, `/zod`, zod an optional peer [D] [M]

- **`@kingsleyweb/bun-client/zod`** is a subpath, with `zod` an optional peer
  (`^4`). An app that turns validation off imports nothing from it, and the
  generated schema module is loaded lazily (`schemas: () => import(…)`), so a
  production bundle with validation off carries neither zod nor the schemas.
- **`zod/mini` by default, classic on request** (`--zod-flavour classic`).
  Measured on Bun 1.4.3 with zod 4.6.5, browser build, minified [M,
  `codegen/zod/results.txt`]:

| Generated set | min | gzip | `new Function` inside |
|---|---|---|---|
| `zod/mini`, 1 route | 22.6 KB | 7.4 KB | no |
| `zod/mini`, 50 routes | 37.3 KB | **8.9 KB** | no |
| classic `zod`, 1 route | 89.1 KB | 25.2 KB | **yes** (its JIT) |
| classic `zod`, 50 routes | 103.2 KB | 26.2 KB | yes |

  The marginal cost per route was 21–30 B gzipped, a floor: the synthetic
  routes repeat one shape and gzip folds them [I for real schemas]. The
  runtime is the cost, and `zod/mini` is a third of classic. For reference
  [M, `bundle-size/`]: valibot 2.0 KB gz, `@cfworker/json-schema` 6.2 KB, ajv
  38.2 KB (and `new Function`), ajv standalone precompiled 1.8 KB.
- **Objects are generated loose** (`z.looseObject`): a client checking a
  response must not reject a field a newer server added. Request schemas are
  generated loose as well; the server is the authority on unknown keys.
- **The emitter** (`codegen/zod/emit-zod.ts`, ~100 lines) covers objects,
  arrays, scalars with formats, lengths, ranges and patterns, enums, const,
  unions, nullable; PR-C4 adds `$defs`/`$ref`, recursion (`$ref: "#"`, which
  zod emits for a recursive schema [M], needs `z.lazy`) and
  `prefixItems`.

### 5.3 What does not survive JSON Schema [M]

`codegen/zod/roundtrip.ts`, zod 4.6.5:

| Server schema | JSON Schema | Generated client schema |
|---|---|---|
| `.refine()`, `.superRefine()` (cross-field) | **dropped silently** | weaker than the server's, **with no warning possible**: nothing in the JSON says a refinement existed |
| `.transform()` | input kept; output **throws** | the output is `unknown`, with a warning |
| `z.custom()` | throws | `unknown`, with a warning |
| `.brand()` | a plain `string` | the brand is lost (types and runtime) |
| `z.date()` | throws | `unknown`, with a warning (§3.2); declare wire types as `z.iso.datetime()` |
| `.pipe()`, `.default()`, length, range, regex, discriminated unions | kept | faithful |
| recursive schemas | `$ref: "#"` | faithful once the emitter handles it (PR-C4) |

So: **types only, plus a warning in the generated file**, for anything that
throws; **a silently weaker check** for refinements. The second is acceptable
because the server still validates, and the client's check exists to fail
early and to catch drift, not to be the authority. The README says it in
those words; the BYO validator (§5.4) is where a client puts a cross-field
rule it wants enforced before sending. A vendor-specific detector (zod's
`_zod.def.checks` holding a `custom` check) could add the missing warning for
zod; it is not in the first PR [D].

### 5.4 Bring your own validator [D]

- **Any Standard Schema**: zod, valibot, arktype, yup, or a function wrapped
  with `toStandardSchema` (the same rule as BunValidate; the client ships its
  own copy of that ~20-line wrapper rather than importing bun-common, D17).
- **Where it is declared**: per route in the client config, per call, or
  both (§6.2), per part: `params`, `query`, `body`, `headers`, and `response`
  by status.
- **Order**: built-in first, then BYO. BYO receives the built-in schema's
  **output** when it passed, and the raw value when it failed, so both run
  and every issue is reported at once (no second round trip to discover the
  second problem). With `replace: true` for a part, only the BYO schema runs
  for that part.
- **One error.** `ValidationError` carries the route key, the direction
  (`"request"` or `"response"`), the response status when there is one, and
  `issues: { target, message, path, source }[]`, where `target` is
  `"params" | "query" | "body" | "headers" | "response"`, `path` is the
  dot-joined path BunValidate produces, and `source` is `"builtin"` or
  `"custom"`. Built-in issues come first. Measured: a generated schema's
  failure maps to `{ target: "response", message: "Invalid email address",
  path: "items.3.email" }` [M, `codegen/zod/`].
- A BYO **transform** is applied: what BYO returns is what is sent (request)
  or returned (response). That lets a client parse a wire string into a
  `Date` on the way in, if it wants; the type of `data` then follows the BYO
  schema's output [D].

```ts
const api = createClient<Routes>({
  schemas: () => import("./api.zod.gen"),             // built-in (generated)
  routes: {
    "POST /users": {
      validate: {
        body: { custom: SignupRules },               // runs after the built-in body schema
        response: { 201: { custom: UserWithDates, replace: true } }, // instead of the built-in 201 schema
      },
    },
  },
});
```

### 5.5 Defaults, and what validation costs [D] [M]

| | Default | Failure does | Why |
|---|---|---|---|
| Request (each part) | **on in development, off in production** | **throws** `ValidationError` before sending | the server validates anyway; in development it catches a wrong call before the network does |
| Response | **on in development, off in production** | **warns** (through the client's `logger`, or `console.warn`) and returns the data unchanged | bun-jobs' `responseMismatch` semantics (`bun-jobs/lib/api/routes/define.ts:295-322`) [S]: a drifted schema is reported, the screen still renders |

"Development" is `process.env.NODE_ENV !== "production"` as the bundler
replaces it; `mode: "development" | "production"` in the config overrides
it. What a 20-user list (~1.7 KB of JSON) costs to check, per response [M,
`codegen/zod/results.txt`]:

| Check | µs per response |
|---|---|
| `JSON.parse` of the body, for scale | 10.7 |
| the server's own zod schema | 14.8 |
| generated classic zod | 22.0 |
| generated classic zod, jitless (a CSP without `'unsafe-eval'`) | 34.5 |
| generated `zod/mini` | 37.5 |
| `@cfworker/json-schema` on the JSON Schema | 195.1 |

So response validation roughly doubles to quadruples the client's parse
cost: invisible for a screen's handful of requests, measurable for a list
polled every second. That is why production defaults to off, and why it can
be turned on per route (a payment confirmation) rather than globally.

---

## 6. The client core

### 6.1 The request builder [D]

```ts
import { createClient } from "@kingsleyweb/bun-client";
import type { Routes } from "./api.gen";

const api = createClient<Routes>({ baseUrl: "/api" });

const r = await api.get("/users/:id", { params: { id: "42" }, query: { expand: ["org"] }, signal, timeout: 5_000 });
await api.post("/users", { body: { name, email } });
await api.request("PATCH /users/:id", { params, body });  // the key form, for a method chosen at runtime
api.url("/users/:id", { params: { id: "42" }, query });    // "/api/users/42?…", no request
```

- **One method per verb, the path as a literal**: the shape openapi-fetch and
  Eden Fetch use, the cheapest for the type checker [V] [M], and the same
  string as the server's route, so a search finds both. A named form
  (`api.op.getUser(opts)`, from `operationId`) is a later, optional proxy.
- **Params** are substituted and `encodeURIComponent`-ed; a missing one is a
  type error, and a runtime `ClientError` for an untyped caller.
- **Query** is serialised as the inverse of bun-common's parser
  (`picoquery`, `nestingSyntax: "js"`, `arrayRepeat: true`, CLAUDE.md
  "Dependency policy") [S]: arrays as repeated keys, `null`/`undefined`
  skipped. A round-trip test runs every shape through `router.fetch()` and
  compares `req.query` (§12).
- **Body**: JSON by default; `FormData`, `URLSearchParams`, `Blob` and
  streams pass through unchanged; the content type follows.
- **Headers**: static, or a function (sync or async) per request, merged
  global → route → call.
- **Abort and timeouts**: the caller's `signal` and the timeout combined with
  `AbortSignal.any([signal, AbortSignal.timeout(ms)])`; a timeout surfaces as
  `TimeoutError`, a caller's abort as the platform's `AbortError`.
- **Retries with backoff**: idempotent methods only by default (GET, HEAD,
  OPTIONS, PUT, DELETE), on network errors and 408/429/500/502/503/504,
  honouring `Retry-After`. The backoff is bun-common's `computeBackoff`
  semantics (exponential, capped, jittered), copied, not imported (D17); a
  shared test vector keeps the two equal [D].
- **Middleware** is an onion of `(ctx, next) => Promise<Response>`, where
  `ctx` holds the route key, the typed options and a mutable `Request`. It is
  how logging, tracing headers (an OpenTelemetry `traceparent`, cf.
  `opentelemetry.md`), CSRF headers (bun-jobs-ui sends one on mutations,
  `app/api/client.ts:228-234` [S]) and mocking plug in.
- **Auth refresh**: `auth: { token, refresh, on: [401] }`. A 401 runs
  `refresh()` once, **single-flight** (concurrent 401s wait on the same
  refresh), then retries the request once with the new token; a second 401
  is returned as the result.

### 6.2 Configuration: three levels, later wins [D]

The coordinator asked for every behaviour to be switchable globally, per
route and per call. The config type, with defaults; every option is
documented, per the repo's rule:

```ts
/** Options for {@link createClient}. Every field is optional: `createClient<Routes>()` works. */
export interface ClientConfig<R extends RouteMap> {
  /** Prefix for every request URL. Default: `""` (same origin). */
  baseUrl?: string;
  /**
   * The fetch to call. Default: `globalThis.fetch`. On a server, pass
   * `(req) => router.fetch(req)` to run requests in process (§6.6).
   */
  fetch?: (request: Request) => Promise<Response>;
  /** Headers for every request; a function is called per request. Default: none. */
  headers?: HeadersInit | ((ctx: RequestContext) => HeadersInit | Promise<HeadersInit>);
  /** `fetch`'s credentials mode. Default: `"same-origin"`. */
  credentials?: RequestCredentials;
  /** Milliseconds before a request is aborted with `TimeoutError`; `false` for none. Default: `30_000`. */
  timeout?: number | false;
  /** Retries; `false` turns them off. Default: see {@link RetryConfig}. */
  retry?: RetryConfig | false;
  /**
   * `true`: a call returns the success data and throws `HttpError` for a
   * declared error status. `false`: a call returns a {@link Result}.
   * Default: `false`.
   */
  throwOnError?: boolean;
  /**
   * A status the route does not declare: `"throw"` an `UnexpectedStatusError`,
   * or return it as `{ ok: false, status: number, error: unknown }`.
   * Default: `"throw"` (§4.3).
   */
  undeclaredStatus?: "throw" | "result";
  /**
   * Which defaults apply: `"development"` turns validation on. Default:
   * `"production"` when `process.env.NODE_ENV === "production"`, else
   * `"development"`.
   */
  mode?: "development" | "production";
  /**
   * Built-in runtime schemas: a generated module (§5.2) or the server's own
   * browser-safe schemas (§5.1), loaded on first use. Default: none, so only
   * BYO schemas validate.
   */
  schemas?: SchemaSource<R> | (() => Promise<SchemaSource<R>>);
  /** Validation switches and BYO schemas. Default: see {@link ValidationConfig}. */
  validate?: ValidationConfig;
  /** Middleware, outermost first. Default: none. */
  middleware?: readonly ClientMiddleware[];
  /** Token and refresh. Default: none. */
  auth?: AuthConfig;
  /** Where warnings go (response validation in `"warn"` mode, retries). Default: `console`. */
  logger?: Pick<Console, "warn" | "error" | "debug">;
  /** Defaults for the data layer (`/query`, §6.4). Default: see {@link QueryDefaults}. */
  query?: QueryDefaults;
  /** Live invalidation (`/live`, §6.5). Default: off until `live.url` is set. */
  live?: LiveConfig;
  /** Per-route overrides, keyed like the map. Each takes the per-route subset of this config. */
  routes?: { [K in keyof R]?: RouteConfig };
}

/** Retries. */
export interface RetryConfig {
  /** Attempts after the first. Default: `2`. */
  attempts?: number;
  /** Methods retried. Default: `["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]` (idempotent). */
  methods?: readonly string[];
  /** Statuses retried, plus `"network"` for a failed fetch. Default: `[408, 429, 500, 502, 503, 504, "network"]`. */
  on?: readonly (number | "network")[];
  /** First delay, ms. Default: `300`. */
  baseMs?: number;
  /** Largest delay, ms. Default: `10_000`. */
  maxMs?: number;
  /** Jitter fraction, 0 to 1. Default: `0.5`. */
  jitter?: number;
  /** Wait as long as a `Retry-After` header asks, capped at `maxMs`. Default: `true`. */
  respectRetryAfter?: boolean;
}

/** What a part's validation does: off, on, or on with a BYO schema. */
export type PartValidation =
  | boolean
  | {
      /** Run the built-in schema. Default: the level's `request`/`response` switch. */
      enabled?: boolean;
      /** A Standard Schema run after the built-in one (§5.4). Default: none. */
      custom?: StandardSchemaV1;
      /** Run `custom` instead of the built-in schema. Default: `false`. */
      replace?: boolean;
    };

/** Validation switches. */
export interface ValidationConfig {
  /** All request parts at once; a part's own entry wins. Default: `true` in development, `false` in production. */
  request?: boolean;
  /** Path parameters. Default: `request`. */
  params?: PartValidation;
  /** The query string. Default: `request`. */
  query?: PartValidation;
  /** The body. Default: `request`. */
  body?: PartValidation;
  /** Request headers the route declares. Default: `request`. */
  headers?: PartValidation;
  /**
   * Responses: one switch, or one per status. Default: `true` in development,
   * `false` in production.
   */
  response?: boolean | { [status: number]: PartValidation };
  /**
   * What a failure does. `"throw"` a {@link ValidationError}; `"warn"` through
   * `logger` and carry on; or a hook, called with the error, which may throw.
   * Default: `{ request: "throw", response: "warn" }`.
   */
  onFailure?: FailureMode | { request?: FailureMode; response?: FailureMode };
}
export type FailureMode = "throw" | "warn" | ((error: ValidationError) => void);

/** Data-layer defaults (§6.4), passed to query-core's `defaultOptions` and used by our factories. */
export interface QueryDefaults {
  /** Use the data layer's cache for this route; `false` makes every `useQuery` fetch. Default: `true`. */
  cache?: boolean;
  /** How long data stays fresh, ms. Default: `0` (query-core's), `1_000` minimum under Suspense (§7.1). */
  staleTime?: number;
  /** How long unobserved data is kept, ms. Default: `300_000` (query-core's). */
  gcTime?: number;
  /** Refetch stale observed queries on window focus. Default: `true`. */
  refetchOnFocus?: boolean;
  /** Refetch on reconnect (browser `online`, and the live channel's reconnect). Default: `true`. */
  refetchOnReconnect?: boolean;
  /** Poll interval, ms; `false` for none. Default: `false`. */
  refetchInterval?: number | false;
  /** Data-layer retries (separate from {@link RetryConfig}, which retries one request). Default: `0`, because the request already retried. */
  retry?: number;
  /** Send `If-None-Match` with the last ETag and keep the data on a 304. Default: `true`. */
  conditional?: boolean;
  /** Persist the cache (§6.4); a persister from `/persist`. Default: none. */
  persist?: Persister | false;
}

/** Per-route overrides: the subset of the config that makes sense for one route. */
export type RouteConfig = Pick<ClientConfig<RouteMap>,
  "headers" | "timeout" | "retry" | "throwOnError" | "undeclaredStatus" | "validate" | "middleware" | "query">;

/** Per-call options, beside the typed params/query/body: the same subset again, plus a signal. */
export type CallConfig = RouteConfig & {
  /** Aborts this call. */
  signal?: AbortSignal;
};
```

`LiveConfig`, `AuthConfig`, `ClientMiddleware`, `Persister` and
`SchemaSource` are in §6.4 to §6.5 and §16. **Precedence:**

| Option kind | Built-in default | `createClient(config)` | `config.routes[key]` | the call's options | How levels combine |
|---|---|---|---|---|---|
| scalars (`timeout`, `throwOnError`, `undeclaredStatus`, `staleTime`, …) | the defaults above | overrides | overrides | overrides | **last wins** |
| `retry`, `validate`, `query` (objects) | defaults | merged | merged | merged | **deep merge, last wins per key**; `false` at any level switches the whole object off below it |
| `validate.<part>.custom` | none | — | sets | sets | last wins; a call's `custom` replaces the route's |
| `headers` | none | merged | merged | merged | **merged by name, last wins** |
| `middleware` | none | outermost | inside global | innermost | **concatenated**, global outermost |
| `mode` | from `NODE_ENV` | sets | — | — | global only: it chooses the defaults themselves |

Zero configuration works: `createClient<Routes>()` sends same-origin
requests, retries idempotent ones twice, times out at 30 s, returns results,
validates in development when a schema source is given, and caches through
query-core's defaults.

### 6.3 Loading, error and status states [D]

Outside a framework, `@kingsleyweb/bun-client/query` exposes
`observe(queryClient, options)`: a `subscribe(fn)` / `getSnapshot()` store
over query-core's `QueryObserver` (status, `data`, `error`, `isFetching`,
`isStale`, `dataUpdatedAt`). It is what each binding subscribes to, and what
a vanilla or Lit app uses directly; the spike's core showed the snapshot must
keep its identity until something changes, or `useSyncExternalStore` loops
[M, `swr-core/`]. A plain `api.get()` has no state: it is a promise.

### 6.4 The data layer, on query-core [D]

What `/query` adds over query-core, and nothing more:

```ts
import { QueryClient } from "@tanstack/query-core";
import { queries } from "@kingsleyweb/bun-client/query";

const q = queries(api);                                  // typed factories over the client
const user = q.query("/users/:id", { params: { id } });  // { queryKey, queryFn, meta: { tags } }
const list = q.infinite("/users", { query: { q } }, { pageParam: "page", next: (last) => last.next });
const create = q.mutation("POST /users", { optimistic: … });

queryClient.prefetchQuery(user);
q.invalidateTags(queryClient, ["users"]);
```

- **Keys** are `[routeKey, { params, query }]`, so `invalidateQueries({
  queryKey: ["GET /users/:id"] })` invalidates every user by prefix, which
  query-core supports natively [V]. They replace bun-jobs-ui's 11
  hand-written key factories (§11).
- **Tags** [D13]: a route's `cache.tags` templates (`"user:{id}"`) are
  resolved with the call's params into `meta.tags`; `invalidateTags` is a
  predicate over `meta.tags`. A mutation's `invalidates` templates run on
  success, so `POST /users` invalidates `users` without the caller listing
  keys. The names are BC's (`cacheResponse({ tags })`, `invalidateTags`), so
  one vocabulary covers the server cache, the client cache and the live
  channel.
- **Conditional revalidation** [D14]: the query function keeps the last
  `ETag` per key, sends `If-None-Match`, and on a 304 returns
  `ctx.client.getQueryData(ctx.queryKey)`, which structural sharing then
  keeps identical, so nothing re-renders. The spike's core proved the
  semantics, including the identity and the moved `updatedAt` [M,
  `swr-core/`]; query-core passes `client` in the function context [V]. It
  needs a server that sets ETags (bun-common's `etag` option, or BC's
  `cacheResponse`), and is off for a response with `Cache-Control: no-store`
  (bun-jobs sets that on every response, `define.ts:289` [S]).
- **Optimistic updates** use query-core's `onMutate` → rollback context
  pattern [V]; `q.mutation(key, { optimistic: { "GET /users/:id": (old,
  vars) => ({ ...old, ...vars.body }) } })` writes the named queries and rolls
  them back on error. The spike's core and its React test show the flow
  [M, `swr-core/react.test.tsx`].
- **Infinite queries**: query-core's `InfiniteQueryObserver` with typed
  page params read from the route's query schema [V].
- **Dedupe**, **stale-while-revalidate**, **focus/online revalidation**,
  **intervals**, **gc** and **retries of the query** are query-core's, set
  from `QueryDefaults` [V].
- **Persistence** (`/persist`): a persister on IndexedDB written against the
  raw API (`idb-keyval` is 0.75 KB gz [V], but this is ~60 lines and needs no
  dependency), plugged into query-core's `persistQueryClient` (`maxAge`,
  `buster` = the model hash, so a schema change drops a persisted cache) [V].
- **Normalised caching is out of scope** [D]: REST payloads carry no type tag
  to key entities by, and normy-style normalisation needs app-wide unique ids
  and array hints [V]. Tags and invalidation cover the common need.

### 6.5 WebSocket and SSE: typed channels and live queries [D]

Two separate things, built in this order:

**1. Live invalidation (PR-M3, PR-C7).** The server publishes tags; clients
invalidate.

- **Server:** `liveInvalidation({ path: "/__live", authorize })` mounts a
  WebSocket channel (BunWebSocket) and an SSE route (PR-sse2's `res.sse()`)
  on a router. `publishTags(tags)` sends `{ seq, epoch, tags }` to every
  subscriber of a matching tag; it is wired to BC's `invalidateTags` bus when
  bun-cache is present, and to a `.describe({ cache: { invalidates } })`
  route's success automatically. It is an application feature, not a dev
  tool, so it is **authenticated by the app's own `authorize`** (the bun-jobs
  shape, `config.ts:135-154` [S]).
- **Client:** `live({ url, transport: "ws" | "sse" | "auto" })` subscribes to
  the tags of the queries currently observed (refcounted, as SWR's
  subscription hook is [V]), and on a message invalidates by tag.
  **Reconnect** with half-jittered backoff from 500 ms to 30 s and a 25 s
  heartbeat watchdog (bun-jobs-ui's tuned values,
  `app/live/client.ts:124-133` [S]); **resubscribe** on reconnect; **resume**
  with `{ epoch, afterSeq }`, and when the server cannot resume (a gap),
  **invalidate every active query**, because events were missed. tRPC's
  `tracked()` + `lastEventId` is the same model [V].
- **SSE is the fallback** for networks that break WebSockets. `EventSource`
  cannot send an `Authorization` header [V], so the client reads SSE over
  `fetch` with its own parser: bun-common's planned `./sse` entry is
  dependency-free and browser safe (bun-native-routes §16.3) [V-prior], and
  `@microsoft/fetch-event-source` is unmaintained [V].

**2. Typed channels (later, PR-M4).** Typed messages over `router.ws()`:

```ts
const chat = defineChannel({
  path: "/rooms/:room",
  receives: { say: z.object({ text: z.string() }) },                  // client → server
  sends: { said: z.object({ by: z.string(), text: z.string() }) },    // server → client
});
router.ws(chat.path, chat.handler({ say(ws, msg) { chat.publish(ws.params.room, "said", { by: ws.data.user, text: msg.text }); } }));

const room = api.channel("/rooms/:room", { params: { room: "1" } });
room.on("said", (m) => m.text);           // typed
room.send("say", { text: "hi" });         // typed, validated in development
```

The declaration is AD's `WsChannelDoc` (`receives`, `sends`) made
enforcing, as `validate(…, { responses })` made `.describe()`'s responses
enforcing; it lands in the model's `channels` and in AsyncAPI (AD (e)).
`router.ws()` gains a typed overload taking a path literal so `ws.params` is
typed. This is the larger design and waits for AD (e); the live
invalidation above does not.

### 6.6 SSR and hydration through bun-views [D]

```ts
// server: a route rendering a hydrated view
app.get("/users/:id", async (req, res) => {
  const qc = new QueryClient();
  const server = createClient<Routes>({ fetch: (r) => app.fetch(r), headers: { cookie: req.get("cookie") ?? "" } });
  await qc.prefetchQuery(queries(server).query("/users/:id", { params: { id: req.params.id } }));
  res.render("UserPage", { id: req.params.id, [QUERIES]: dehydrate(qc) });
});
// client entry (the React adapter's, BV §4.6.1): hydrate(qc, props[QUERIES]) before hydrateRoot
```

- **In process**: `router.fetch()` runs the production pipeline with no
  socket (CLAUDE.md "Testing without a socket"), so SSR adds no network hop
  and no port. bun-nest's adapter has the same `fetch()`.
- **The props are JSON already**: dehydrated data came from HTTP responses,
  so it is `Jsonify`'d by construction, and BV's warning about non-JSON props
  (BV §4.6.4) cannot fire for it.
- **Escaping, nonce, SRI** are BV's: the dehydrated state travels inside
  `__BV_PROPS` through `jsonForScript`, which BV measured against
  `</script>`, U+2028 and `<!--` in every adapter [V-prior].
- **Streaming** (React's Suspense): query-core can dehydrate pending queries
  with their promises (5.40+) [V]; with BV's "stream" mode that resumes a
  fetch instead of refetching it [I]. First PR: buffered mode only, BV's
  default.
- The binding for each framework is the official adapter's hydration
  component (`HydrationBoundary` in React) [V]; for Vue, Svelte, Solid and
  Preact the same `hydrate()` call runs in BV's entry before mount [I].

---

## 7. Reactivity bindings, and query-core or our own

### 7.1 The bindings [D]

Mirroring BV's adapter set and its rule, **core first, frameworks on
demand**: React with the first release; Vue, Svelte, Solid and Preact each
built when there is a real use (BV D10, §15.2).

| Subpath | Wraps | Adds | Optional peers |
|---|---|---|---|
| `/react` | `@tanstack/react-query` (`useSyncExternalStore` inside [V]) | `useApi(route, opts)` = `useQuery(q.query(…))`; `useApiSuspense`; `useApiMutation` with tag invalidation and optimistic options; `useLive(tags)`; `<ApiHydrate state>` | `react`, `@tanstack/react-query` |
| `/vue` | `@tanstack/vue-query` (refs, `onScopeDispose` [V]) | the same names as composables | `vue`, `@tanstack/vue-query` |
| `/svelte` | `@tanstack/svelte-query` 6 (runes, `svelte ^5.25` [V]) | `createApi(() => opts)` thunk form, as v6 requires [V] | `svelte`, `@tanstack/svelte-query` |
| `/solid` | `@tanstack/solid-query` (`createStore` + `reconcile`, `createResource` for Suspense [V]) | `createApi` | `solid-js`, `@tanstack/solid-query` |
| `/preact` | `@tanstack/preact-query` 5.104.1 (official [V]) | as React | `preact`, `@tanstack/preact-query`. Its peer is `preact ^10` and Preact 11 is out [V]: built on demand, against whichever it supports then (risk R8) |

Each binding is a few hundred lines at most, because the reactivity is the
official adapter's. **Suspense needs a `staleTime` floor**: the spike's React
binding fetched twice under Suspense, since the subscription after the
thrown promise saw fresh-but-`staleTime: 0` data as stale; TanStack forces at
least 1 s for suspense queries for the same reason, and so does `useApiSuspense`
[M, `swr-core/`; V].

### 7.2 query-core, or our own core? [D] [M]

The dependency policy prefers native code and small dependencies, so this
was spiked rather than assumed. `swr-core/core.ts` is a dependency-free core
with dedupe, stale-while-revalidate, focus/online/interval revalidation,
retries with backoff, abort, tags, optimistic rollback, gc, dehydrate and
hydrate, ETag/304, structural sharing and a minimal infinite query, plus a
`useSyncExternalStore` binding; 27 tests pass, also under `--randomize` with
three seeds, and removing any of six guards fails exactly one test [M].

| | Our spike core | `@tanstack/query-core` 5.104.1 |
|---|---|---|
| Size, min / gzip (framework external) | 7.4 / **3.0 KB**; +React 7.8 / 3.2 KB | 37.3 / **10.5 KB**; +React 39.6 / 11.6 KB |
| Lines | 465 (+74 React) | ~9,300 TypeScript [V] |
| Runtime dependencies | none | none [V] |
| Framework bindings | React only; four to write and maintain | React, Vue, Svelte 5, Solid, Preact official [V] |
| Missing in ours [M, `swr-core/README.md`] | — | observer reconciliation when options change, `select` memo, `enabled`, placeholder data, paused mutations and an offline queue, a mutation cache, pending-promise hydration for streaming SSR, two-way infinite queries with `maxPages`, notification batching into each framework's scheduler, years of race fixes [V] |
| What it lacks that we need | — | tags (emulated with `meta` + predicate), typed transport, live invalidation, ETag revalidation: **all built on top either way** |

**Decision [D12]: build on query-core**, as an optional peer of `/query`
and the bindings only; the core request client (`.`) stays
dependency-free. The 7.5 KB gzip saved by our own core does not pay for
~15–20 more days to reach parity [I, from the missing list] and five
bindings to keep current with five frameworks. Its peer range is `^5`;
query-core 5.104 already deprecates `fetchQuery` in favour of
`queryClient.query()` for the next major [V], so the factories return
`queryOptions`-shaped objects that both forms accept, and the next major is
a planned upgrade (risk R1). The spike core stays in the evidence as the
fallback if the user prefers no peer at all (Q3).

---
## 8. Server side: bun-common, both adapters

bun-common's `BunHttpAdapter` *is* a `BunRouter` (`bun-common/lib/BunHttpAdapter.ts:219-222`),
and bun-nest's adapter delegates its verbs to one (`bun-nest/lib/BunHttpAdapter.ts:1580-1604`)
[S, via BC §9 and the survey]. So everything in this section works for routes
registered on either adapter. Routes declared as Nest **controllers** go
through Nest's explorer instead; that is NTR.

### 8.1 What a route author writes [D]

AD's shape, plus two `.describe()` fields:

```ts
const app = new BunHttpAdapter();

app.get(
  "/users/:id",
  validate({ params: IdParams }, { responses: { 200: User, 404: Problem } }),   // AD (b), (b1)
  (req, res) => res.status(200).json(users.get(req.params.id)),
).describe({
  summary: "Read one user",
  operationId: "getUser",
  errors: ["NOT_FOUND"],                       // new: the codes this route's problems carry (§4.3)
  cache: { tags: ["user:{id}"] },              // new: client cache tags, templated by params (§6.4)
});

app.patch(
  "/users/:id",
  validate({ params: IdParams, body: UserPatch }, { responses: { 200: User } }),
  handler,
).describe({ cache: { invalidates: ["user:{id}", "users"] } });   // new: what a success invalidates
```

One description drives four things: the request is validated (BunValidate),
the response is checked at compile time and optionally at runtime (AD
(b1)), the OpenAPI document is generated (AD), and the client's types,
schemas, keys and invalidations are generated (this plan). **Nothing is
declared twice.**

- `errors` and `cache` are **documentation-only fields** in AD's sense
  (§3.4 there): they reach the model, never the handler's types. `cache`
  templates may name only the route's own params; the model builder checks
  that and warns otherwise.
- A route with no validator still appears in the model, typed `unknown`, with
  a warning (§4.2).
- `hidden: true` (AD) also hides a route from the client model.

### 8.2 The model builder (PR-M1) [D]

```ts
import { buildRouteModel } from "@kingsleyweb/bun-common/lib/docs";

const model = buildRouteModel(app, {
  commonResponses: { 400: ValidationProblem, 401: Problem, 500: Problem },
  // AD's filter, operationId, converters and strict options, unchanged
});
```

It is AD's route discovery (`routes()` plus the pipeline replay, AD §3.3)
serialised into §3.0's `RouteModel`, and AD's `generateOpenApi()` becomes a
second consumer of the same discovery, so the two cannot drift. The spike's
walk (`codegen/describe.ts`) is the measured part: 6 routes in 9 to 18 ms,
1000 in 0.2 to 0.3 s [M].

### 8.3 The dev sync (PR-M2) [D]

```ts
import { devTypes } from "@kingsleyweb/bun-common/lib/docs";

app.use(devTypes(app, { enabled: process.env.NODE_ENV !== "production" }));
```

`devTypes()` returns a sub-router: the model endpoint, and the channel as a
`router.ws()` route, which both adapters serve [I for bun-nest's adapter:
PR-M2 verifies it]. Disabled, it returns an empty router and registers
nothing. §3.3 is the protocol and the fail-closed rules; the spike
(`sync/dev-types.ts`) is the measured version.

### 8.4 How it composes with typed overloads and sub-routers [S] [M]

- **The generated verb overloads do not change.** `.describe()` is a separate
  method (AD §3.4), the validator stays the one shape-carrying position, and
  the responses ride in the shape it already carries (AD Decision 4).
  `generate-verb-overloads.ts --check` stays green [V-prior].
- **Sub-routers**: the walk sees a mounted router's routes with their full
  path [M]; `.describe()` metadata survives mounting because it is keyed by
  the terminal callback (AD Decision 1, measured there) [V-prior]. A
  `BunRouter<"/users/:id">` declared for typing mounts unchanged.
- **The registry** (§8.5) is mounted like any sub-router.

### 8.5 The inference registry: `defineRoutes()` [D]

AD's optional (a2) `routes([...])` registrar and this plan's v2 are one
thing; build it once, as `defineRoutes`:

```ts
export const users = defineRoutes("/users", (r) => ({
  get: r.get("/:id", validate({ params: IdParams }, { responses: { 200: User, 404: Problem } }), handler),
  create: r.post("/", validate({ body: NewUser }, { responses: { 201: User } }), handler),
}));
app.use(users.mount, users.router);           // runtime: an ordinary sub-router
export type Api = RoutesOf<typeof users>;     // the same flat map as generation
```

The property names become `operationId`s (`users.get`), handlers are typed
through the same `MountedHandler` the verbs use, and the cost is +2% check
time at 1000 routes [M]. It exists for monorepos that prefer no generated
files (§3.4).

---

## 9. NestJS: a separate document

**Split into [`nest-typed-routes.md`](nest-typed-routes.md).** The reasons:

- **Its surface is its own design**: decorators (AD's `@Validate` as the
  typed-route decorator, `@Describe`), a Standard Schema pipe, guards and an
  interceptor for the dev endpoint, a `DevTypesModule`, an explorer over
  `DiscoveryService`, a comparison with nestia's transformer and the
  `@nestjs/swagger` plugin, and typed gateways over `BunWebSocketAdapter`.
  That is a dozen pieces this plan's readers do not need.
- **It has a different owner** (the bun-nest agent) and a different gate
  (`examples/bun-nest`).
- **The contract between them is small and fixed**: §3.0's `RouteModel`,
  §3.3's protocol, §6.5's live frames. NTR produces the model; this plan
  consumes it. The client is the same for both: a Nest app's client is
  `createClient<Routes>()` over the map generated from Nest's model.

Measured there [M, `nest/`]: a `TypedRoutesExplorer` over `DiscoveryService`,
`MetadataScanner` and `ApplicationConfig.getGlobalPrefix()` built the model
for 6 routes (one documented only by `swagger/apiResponse` metadata) in
8.7 ms, every key matching a route bun-nest's adapter had registered; the
same emitter generated `Routes`, and the same client type-checked against it.

---

## 10. Packaging

### 10.1 `@kingsleyweb/bun-client`, a new package [D]

| Entry | Contents | Runtime peers | Browser safe |
|---|---|---|---|
| `.` | `createClient`, `Result`, `ClientError`/`HttpError`/`UnexpectedStatusError`/`NetworkError`/`TimeoutError`/`ValidationError`, middleware, auth, retry, `toStandardSchema` copy, `Jsonify`, `RoutesOf` | none | yes |
| `./query` | `queries()`, `observe()`, `invalidateTags`, the ETag query function | `@tanstack/query-core ^5` (optional) | yes |
| `./react`, `./vue`, `./svelte`, `./solid`, `./preact` | §7.1's bindings | the framework and its TanStack adapter (optional) | yes |
| `./zod` | the glue that runs generated schemas (`schemasFromZod`), and the flavour detection | `zod ^4` (optional) | yes |
| `./live` | §6.5's live client: WebSocket, SSE over fetch, resume | none | yes |
| `./persist` | the IndexedDB persister | `@tanstack/query-persist-client-core` (optional) | yes |
| `./codegen` | the model → TypeScript and → Zod emitters, the model fetcher, the watcher loop | none | **no** (Bun only) |
| bin `bun-client` | `generate`, `watch`, `--check` | `@kingsleyweb/bun-common` optional, for `--module` only | — |

- **Every framework, query-core and zod are optional peers**, so a Vue user
  installs no React (BV D10's rule) and an app that turns validation off
  installs no zod. Each subpath that needs a peer says so in
  `consumer-check.json`'s `peers`, which the build's `checkPeerScopes` and the
  consumer check already enforce (CLAUDE.md "Packaging types") [S].
- **The packaging recipe** is the repo's: `dts/`, the four files, the
  `exports` shape with the source condition, and browser entries checked as
  `browser` cells in the consumer check, as bun-jobs' `api/contract` is [S].
- **Zero runtime dependencies** in every entry; `./codegen` uses only Bun.

### 10.2 bun-common [D]

No new package. AD's `./lib/docs` entry (server only) gains
`buildRouteModel` and `devTypes`; a new `./live` entry holds
`liveInvalidation` and `publishTags`. The `.describe()` fields are type
additions to AD's `RouteDoc`. bun-common gains **no dependency**.

**The wire format is defined on both sides** [D]: bun-common declares the
`RouteModel` and live frame types it produces; bun-client declares the ones
it consumes, because a browser client in another repo must not need
bun-common installed even for types. A type test in bun-client
(`Equal<Produced, Consumed>`) binds them, and `version: 1` guards at runtime.
That is two small types, not bun-jobs' 179.

### 10.3 Browser safety [D]

The bun-jobs lesson: one value import from the wrong entry pulls drivers and
`node:*` into a bundle (CLAUDE.md "bun-jobs-ui … Browser safety") [S]. So:

- `__tests__/bundle-safety.test.ts` builds every browser entry of bun-client
  with `Bun.build({ target: "browser" })` and fails on a server marker
  (`node:`, `bun:`, `Bun.`, an `@kingsleyweb/bun-common` import), with a
  negative control entry that imports bun-common and must fail. Copied from
  bun-jobs-ui's (`__tests__/app/pkg/bundle-safety.test.ts`) [S].
- A **budget** test caps each entry's gzip size (bun-jobs-ui's
  `budget.test.ts` pattern): `.` at 5 KB, `./query` at 3 KB over query-core,
  `./live` at 3 KB [I: the targets; measured once PR-C1 exists].
- The **schemas module** a monorepo passes (§5.1) gets the same test in the
  app's own repo: the README gives the five lines.

---

## 11. Using it ourselves: bun-jobs and bun-jobs-ui

**Recommended as a pilot of one domain, not a rewrite.** It is the best
validation available: a real API with 84 routes, schemas, responses, error
codes, a live channel, and a UI already on TanStack Query.

- **bun-jobs' side (~1.5 d, bun-jobs agent):** `defineRoute` already carries
  everything the model needs (`define.ts:97-178`: method, path,
  `operationId`, schemas with JSON Schema, responses, `errors`) [S], so a
  `toRouteModel(routes)` beside `spec/openapi.ts` produces §3.0's model
  without bun-common's walk. Its `errors` lists become the code unions
  bun-jobs-ui lacks.
- **bun-jobs-ui's side (~3 d, bun-jobs-ui agent):** generate
  `app/api/routes.gen.ts` with `bun-client generate --module` (the
  monorepo default) and move **one domain** onto `createClient<Routes>` and
  `/query`: **summon** is the candidate, with 5 of the 20 `assertShape`
  sites, its own key factory and the error-code comparisons in
  `app/api/summon.ts:31,47-52` [S]. Keep its TanStack Query hooks; only the
  query options change.
- **What the pilot measures:** lines removed, assertions and key factories
  removed, whether the 27 integration tests stay green unchanged, the bundle
  delta, and whether generated `--check` would have caught a drift the
  integration tests caught. **The decision to go further is taken after**,
  with those numbers (Q14).
- **Not in the pilot:** the 179 contract types stay (they are bun-jobs'
  public API for other consumers); the live client stays (typed channels are
  PR-M4).

---

## 12. Tests and evidence

### 12.1 What each PR's tests prove [D]

| PR | Proves |
|---|---|
| PR-M1 model | a fixture app (statements, a mounted sub-router, `all()`, middleware, a route with no validator, common responses) gives a golden model; the hash is stable across runs and changes when a schema changes; `.describe()` survives mounting; §4.1's input/output rule per part; warnings for unrepresentable schemas; OpenAPI from the same discovery still passes AD's meta-schema test |
| PR-M2 dev sync | the e2e loop from `sync/` as a test (an edit under a real `bun --hot` child, the file updated, the hash in its header); fail closed: production throws, `enabled` missing registers nothing, no token → 404, a non-loopback peer → 404, matching ETag → 304; the model is not built while nobody listens |
| PR-M3 live | publish → only matching subscribers; resume after a reconnect; a gap reported when the epoch changed; `authorize` refusal; SSE and WebSocket give the same frames |
| PR-C1 core | type tests with negative controls (wrong params, wrong query type, unknown route, undeclared status narrowing); the query serialiser round-trips through `router.fetch()` for every shape; retries only on the listed methods and statuses, `Retry-After`; timeout vs abort errors; middleware order; single-flight auth refresh under 10 concurrent 401s; the backoff test vector shared with bun-common; bundle safety and budget; the consumer check |
| PR-C2 codegen | the emitter's output for a corpus of JSON Schemas (objects, unions, nullable, recursion, `$defs`); **parity**: for a fixture app, the generated `Routes` equals `RoutesOf<typeof registry>` for the same routes (an `Equal` test), with the known differences (§5.3) pinned as negative controls; `--check` exits 1 on a stale file |
| PR-C3 watch | reconnect after a server restart; atomic write (a reader never sees a partial file); no write when unchanged |
| PR-C4 validation | built-in and BYO order and merging; `replace`; each failure mode; defaults by mode; generated Zod accepts and rejects the same payloads as the server's schema across a corpus, **except** the documented refinements; `zod/mini` and classic agree |
| PR-C5 query | keys and prefix invalidation; tag templates; mutation `invalidates`; ETag 304 keeps data identity; optimistic rollback; infinite page params |
| PR-C6 React | the repo's DOM rules (bun-jobs-ui's `setupDom()`, react-dom loaded dynamically) [S]; pending → success with bounded renders; one fetch for two components; Suspense with the `staleTime` floor (the spike's double-fetch as the negative control); SSR: a view rendered through bun-views with dehydrated state hydrates with no refetch, in Chrome through `Bun.WebView` as bun-jobs-ui's e2e tests do |
| PR-C7 live client | a dropped socket reconnects, resubscribes, resumes, and on a gap invalidates every active query; SSE fallback |
| every PR | `bun test --randomize` with two seeds besides the parallel run (CLAUDE.md "Tests run in parallel") |

### 12.2 Evidence

| Spike | Run | Result |
|---|---|---|
| `inference/` | `bun patch-router.ts && bun gen.ts && bun measure.ts` (heavy) | the route map accumulates on the real router; +49% (router) or +2% (registry) check time at 1000 routes; no declaration-emit errors; statement style cannot accumulate a returned type |
| `codegen/` | `bun generate.ts && tsc -p .`, `bun scale.ts` | a correct `Routes` from statement-style routes; parity with inference except unrepresentable schemas; 0.75 s client check at 1000 routes |
| `codegen/zod/` | `bun measure.ts`, `bun jitless.ts`, `bun roundtrip.ts` | generated Zod sizes and costs; what survives JSON Schema |
| `sync/` | `bun e2e.ts` | 49 ms (`--hot`), 160 ms (`--watch`), 560 ms (1 s poll); fail closed |
| `swr-core/` | `bun test swr-core` | a 465-line core and React binding, 27 tests; the Suspense double fetch |
| `bundle-size/` | `bun bundle-size/measure.ts` | the size tables of §2.5, §5.2 and §7.2 |
| `nest/` | `cd nest && bun explore.ts` | NTR's measurements |

---

## 13. Risks

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | **query-core's next major** changes the factories' target (`fetchQuery` is already deprecated for `queryClient.query()`) [V] | likely within a year / medium | factories return `queryOptions`-shaped objects both accept; peer range `^5`; an upgrade PR when v6 ships |
| R2 | **AD is not built**, and is this plan's critical path (`__schemas`, responses on the validator, `.describe()`) | certain today / high | PR-M1 starts after AD (a), (b), (b1); nothing client-side before PR-C2 needs it; AD's "suggested first commit" (`__schemas`) unblocks the model's request half |
| R3 | **Generated schemas are weaker than the server's** (refinements dropped silently) [M] | certain / low | documented; the server stays the authority; BYO for client-side rules; a zod-specific detector later |
| R4 | **The dev endpoint leaks in production** | low / high | fail closed by construction (§3.3) and by test: production throws, no implicit on, token, loopback, 404 |
| R5 | **tsc cost**: inference at scale [M] | — | generation is the default; the registry costs 2% |
| R6 | **Model build cost on large apps** (~0.3 s per 1000 routes) [M] | medium / low | built lazily, only with a watcher or on a `GET` |
| R7 | **Query serialisation drifts from the server's parser** | medium / medium | a round-trip test through `router.fetch()` for every shape; one module owns both directions' options |
| R8 | **Preact 11**: TanStack's Preact adapter declares `preact ^10` [V] | certain / low | Preact is built on demand; check then |
| R9 | **zod classic under a strict CSP** runs jitless, ~1.6× slower [M] | medium / low | `zod/mini` is the default flavour |
| R10 | **Generated-file churn** in reviews and merges | medium / low | one file per side, sorted keys, stable output; `--check` in CI; Q9 |
| R11 | **The pilot finds the model insufficient** for bun-jobs (alternate content types, `bodyOptional`, `maxBodyBytes`) | medium / medium | it is a pilot of one domain; the model has room (`version`) |
| R12 | **bun-nest's adapter does not serve a BunRouter `ws()` route** the way bun-common's does [I] | unknown / medium | PR-M2 verifies; NTR's `DevTypesModule` can serve the channel through bun-nest's own WebSocket path otherwise |

---

## 14. Open questions for the user

Each has a recommended answer.

1. **Generation plus live sync as the default everywhere, inference as an
   opt-in registry?** **Recommended: yes** (§3.4). It differs from "(a) for
   monorepos" because generation works with today's statement-style routes
   and checks an order of magnitude faster on the client [M].
2. **Leave `BunRouter`'s verb return types alone (no accumulating router)?**
   **Yes.** +49% check time at 1000 routes, and it only works chained [M].
3. **Build the data layer on `@tanstack/query-core` rather than our own
   core?** **Yes**, as an optional peer (§7.2). Our core is 7.5 KB gzip
   smaller but ~15–20 days short of parity, with five bindings to maintain.
4. **The call style: path literal per verb (`api.get("/users/:id", …)`) as the
   primary form, a named proxy (`api.op.getUser`) later?** **Yes.**
5. **A status the route does not declare throws by default?** **Yes** (§4.3),
   with `undeclaredStatus: "result"` to opt out.
6. **Built-in validation is generated Zod, `zod/mini` by default, in a `/zod`
   subpath with zod an optional peer?** **Yes** (§5.2). Classic is a flag
   away; valibot as a second generated target is possible later.
7. **Validation defaults: requests and responses on in development, off in
   production; a request failure throws, a response failure warns?** **Yes**
   (§5.5).
8. **BYO validators run after the built-in ones, on its output when it
   passed, issues merged into one `ValidationError`, `replace: true` to drop
   the built-in?** **Yes** (§5.4).
9. **Commit the generated files?** **Yes**, in both layouts, with `--check`
   in CI: reviewable diffs, and a frontend builds without a server running.
10. **The dev endpoint's path and token file: `/__bun/types` and
    `node_modules/.cache/bun-types/<port>.json`?** **Yes**; both configurable.
11. **Live invalidation as a production feature (opt-in, the app's own
    `authorize`), before typed channels?** **Yes** (§6.5): it is what the UI
    needs most, and typed channels wait for AD (e).
12. **Cache tags declared in `.describe({ cache: { tags, invalidates } })`,
    templated by params, with bun-cache's names?** **Yes** (§6.4, §8.1).
13. **Package name `@kingsleyweb/bun-client`?** **Yes**, unless the user
    prefers `bun-fetch` or `bun-query`; §16.
14. **Pilot one bun-jobs-ui domain (summon) before deciding on more?**
    **Yes** (§11).
15. **SSR prefetch in process through `router.fetch()`?** **Yes** (§6.6).
16. **React first, the other four bindings on demand, as bun-views does?**
    **Yes** (§7.1).

---

## 15. PR slicing and effort

Focused days for someone who knows the code, as in the other plans. Each PR
passes the full gate alone (`bun scripts/typecheck.ts`, `CI=1 bunx eslint .`
in each touched package, `bun run test` and `--randomize`, the consumer check
for packaging changes, and `run-all.ts` in the affected `examples/`). **Each
user-facing PR is reported to the examples agent before merging.**

### 15.1 Prerequisites (AD's phases, estimated there)

AD (a) `.describe()` and discovery, (b0) spec types, (b) `__schemas` and
converters, (b1) responses on the validator: **15–20 d** by AD's own figures.
PR-M1 needs (a), (b) and (b1); PR-C1 needs none of them.

### 15.2 Server (bun-common)

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| **PR-M1** route model | `buildRouteModel`, `RouteModel` types, §4.1's rule, `commonResponses`, `.describe({ errors, cache })`, the hash; AD's `generateOpenApi` on the same discovery | AD (a), (b), (b1) | ~3 d |
| **PR-M2** dev sync | `devTypes()`: endpoint, channel, token file, loopback, fail closed, lazy build, `routesVersion` | PR-M1 | ~3 d |
| **PR-M3** live invalidation | `./live`: `liveInvalidation`, `publishTags`, WebSocket and SSE, resume, BC bus hook | PR-M1; PR-sse2 for SSE | ~4 d |
| *PR-R* registry | `defineRoutes`, `RoutesOf` (AD (a2)) | AD (b1) | ~2.5 d |
| *PR-M4* typed channels | `defineChannel`, typed `router.ws()` path overload, model `channels` | AD (e) | ~5 d (later) |

### 15.3 Client (`@kingsleyweb/bun-client`)

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| **PR-C1** package and core | package skeleton and packaging recipe; `createClient`, verbs, `request`, `url`; params, query, body, headers; abort, timeout, retries, middleware, auth refresh; `Result` and errors; `ClientConfig` with §6.2's precedence; bundle safety, budget, consumer check | — | ~5 d |
| **PR-C2** codegen and CLI | `./codegen`: model → `Routes` emitter (with `$defs`, recursion), fetch from URL or `--module`, `--check`; the wire-format `Equal` test | PR-M1, PR-C1 | ~4 d |
| **PR-C3** watcher | `bun-client watch` | PR-M2, PR-C2 | ~1.5 d |
| **PR-C4** validation and `/zod` | built-in and BYO validation, `ValidationError`, failure modes, defaults by mode; the Zod emitter (mini and classic) and `./zod` | PR-C2 | ~4 d |
| **PR-C5** query layer | `./query`: `queries()`, keys, tags, `invalidates`, ETag 304, optimistic, infinite, `observe()` | PR-C1 | ~4 d |
| **PR-C6** React and SSR | `./react`; `<ApiHydrate>`; SSR through bun-views' props | PR-C5; BV PR-5 for hydration | ~3 d |
| **PR-C7** live client | `./live`: WebSocket, SSE over fetch, refcounted tag subscriptions, reconnect, resume, gap invalidation | PR-M3, PR-C5 | ~3.5 d |
| **PR-C8** persistence | `./persist` on IndexedDB, buster = model hash | PR-C5 | ~1.5 d |
| | **Total, server and client, React first** | | **~36.5 d** (PR-M1 to M3, C1 to C8) **+ 2.5 d registry** |
| *Later, on demand* | `./vue` ~1.5 d, `./svelte` ~2 d, `./solid` ~1.5 d, `./preact` ~1 d | PR-C5 | ~6 d |

### 15.4 Elsewhere

| PR | Owner | Effort |
|---|---|---|
| NTR's PRs (N1 to N5) | bun-nest agent / features | ~13 d (NTR §9) |
| Pilot: bun-jobs `toRouteModel` | bun-jobs agent | ~1.5 d |
| Pilot: bun-jobs-ui summon domain | bun-jobs-ui agent | ~3 d |
| Examples (each user-facing PR; `examples/bun-common/14-typed-client/` and a client example per binding) | examples agent | ~4 d |

**Order:** PR-C1 can start now (it needs nothing). AD (a) → (b) → (b1) →
PR-M1 → (PR-M2 ∥ PR-C2) → PR-C3, PR-C4; PR-C5 after PR-C1; PR-C6 after
PR-C5 and BV PR-5; PR-M3 → PR-C7. The pilot follows PR-C2 and PR-C5.

---

## 16. Names needing approval

Every new public name.

| Name | Kind | Where | Why this name |
|---|---|---|---|
| `@kingsleyweb/bun-client` | package | new | the client of the bun-* server packages |
| `./query`, `./react`, `./vue`, `./svelte`, `./solid`, `./preact`, `./zod`, `./live`, `./persist`, `./codegen` | subpaths | bun-client | one per optional peer or concern, as BV does |
| `bun-client` (`generate`, `watch`, `--check`, `--module`, `--url`, `--out`, `--zod`, `--zod-flavour`) | bin and flags | bun-client | the package name |
| `createClient`, `ClientConfig`, `RouteConfig`, `CallConfig`, `RetryConfig`, `ValidationConfig`, `PartValidation`, `FailureMode`, `QueryDefaults`, `LiveConfig`, `AuthConfig`, `ClientMiddleware`, `SchemaSource` | function, types | `.` | §6.2 |
| option names: `baseUrl`, `fetch`, `headers`, `credentials`, `timeout`, `retry`, `throwOnError`, `undeclaredStatus`, `mode`, `schemas`, `validate` (`request`, `params`, `query`, `body`, `headers`, `response`, `onFailure`, `enabled`, `custom`, `replace`), `middleware`, `auth`, `logger`, `query` (`cache`, `staleTime`, `gcTime`, `refetchOnFocus`, `refetchOnReconnect`, `refetchInterval`, `retry`, `conditional`, `persist`), `live`, `routes` | options | `ClientConfig` | §6.2; query-core's words where it has them |
| `Result`, `Jsonify`, `RoutesOf`, `RouteMap`, `RouteEntry` | types | `.` | §4.4, §3.1 |
| `ClientError`, `HttpError`, `UnexpectedStatusError`, `NetworkError`, `TimeoutError`, **`ValidationError`** | classes | `.` | `ValidationError` mirrors BunValidate's, with `direction`, `status` and `source` per issue (§5.4) |
| `queries`, `observe`, `invalidateTags` | functions | `./query` | `invalidateTags` is bun-cache's verb |
| `useApi`, `useApiSuspense`, `useApiMutation`, `useLive`, `ApiHydrate`; `createApi` (Svelte, Solid) | hooks, component | framework subpaths | one prefix per binding |
| `schemasFromZod` | function | `./zod` | |
| `live` | function | `./live` | |
| `idbPersister` | function | `./persist` | |
| `RouteModel`, `ModelRoute`, `ModelChannel` | types | bun-common `./lib/docs`, mirrored in bun-client | §3.0 |
| `buildRouteModel`, `commonResponses` | function, option | bun-common `./lib/docs` | beside AD's `generateOpenApi` |
| `devTypes` (`enabled`, `path`, `token`, `allowRemote`) | function, options | bun-common `./lib/docs` | |
| `/__bun/types`, `bun-types.v1`, `node_modules/.cache/bun-types/<port>.json` | defaults | dev sync | §3.3 |
| `RouteDoc.errors`, `RouteDoc.cache` (`tags`, `invalidates`) | fields | AD's `RouteDoc` | §8.1 |
| `liveInvalidation`, `publishTags` | functions | bun-common `./live` (new entry) | |
| `defineRoutes` | function | bun-common root | replaces AD's working name `routes([...])` for (a2) |
| `defineChannel` | function | bun-common (later, PR-M4) | AD's `WsChannelDoc` made enforcing |
| `toRouteModel` | function | bun-jobs `./lib/api` | pilot |

---

## Appendix: evidence

`docs/plans/evidence/typed-client/` ([index](evidence/typed-client/README.md)):

- `inference/`: `patch-router.ts`, `gen.ts`, `spike-types.ts`,
  `measure.ts`, `results.txt`, `probes/`
- `codegen/`: `describe.ts`, `app.ts`, `emit-dts.ts`, `generate.ts`,
  `routes.gen.ts`, `model.json`, `client-types.ts`, `client-check.ts`,
  `scale.ts`, `scale-results.txt`, `results.txt`; `zod/`: `emit-zod.ts`,
  `synthetic.ts`, `measure.ts`, `jitless.ts`, `roundtrip.ts`,
  `app.zod-classic.gen.ts`, `app.zod-mini.gen.ts`, `results.txt`,
  `roundtrip.txt`
- `sync/`: `dev-types.ts`, `watch.ts`, `e2e.ts`, `results.txt`
- `swr-core/`: `core.ts`, `react.ts`, `core.test.ts`, `react.test.tsx`,
  `results.txt`
- `bundle-size/`: `measure.ts`, `entries/`, `results.txt`
- `nest/`: `explore.ts`, `explore-types.ts`, `client-check.ts`,
  `nest-routes.gen.ts`, `results.txt`

Third-party packages are pinned in `evidence/typed-client/package.json` and
installed there only.
