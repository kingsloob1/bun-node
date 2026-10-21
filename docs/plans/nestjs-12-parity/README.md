# NestJS 12 parity for bun-nest and bun-common

Plan for making `@kingsleyweb/bun-nest` (and the parts of
`@kingsleyweb/bun-common` it stands on) a full peer of
`@nestjs/platform-express` on NestJS 12, routing included. The user asked for
this on 2026-10-15:

> "A plan to ensure bun-nest and bun-common has compatibility for nestjs 12
> including the routing strategy etc. So carefully go through all the change
> log and ensure we have full nest js 12 parity across all packages with
> proper testing."

Written 2026-10-15 against `develop` at `73bf4a00`. **No product code was
changed.** Every `file:line` is at `73bf4a00`, relative to the repo root.
Every measurement ran in a copy of the repo with Nest 12 installed into it
([`evidence/nest-mirror.sh`](evidence/nest-mirror.sh)); the evidence is in
[`evidence/`](evidence/README.md), and each measurement there can be re-run
with one command.

### Status (2026-10-20)

**Approved in full.** On 2026-10-17 the user answered Q1–Q8 with each
recommendation (§12) and asked for the whole plan, PR-0 to PR-11, as their
first priority.

**Who does what** (roles, as in [`docs/agentic-setup.md`](../../agentic-setup.md)):

- The **bun-nest agent** leads the plan, keeps this Status current, and builds
  every PR except PR-3b and PR-10.
- The **bun-common agent** reviews the PRs that land in bun-common: PR-1, the
  router parts of PR-5, the multipart and request parts of PR-7, and PR-2's
  `finalErrorResponse` message.
- The **bun-jobs agent** reviews PR-1, PR-5 and PR-7 for effects on bun-jobs
  (none are expected).
- The **bun-jobs-ui agent** builds PR-3b.
- The **examples agent** builds PR-10 and stacks the example fixes on each PR
  that changes an example check.

| PR | State |
|---|---|
| PR-0 matrix tooling | merged, #400 (2026-10-17) |
| PR-1 `BunRouter.query()` | merged, #402 |
| PR-2 the Nest 12 blockers | merged, #404 |
| PR-3 versions (and PR-3b) | merged, #414 (PR-3b, bun-jobs-ui's devDeps, landed with it) |
| PR-4 routing differential | merged, #410 |
| PR-5 routing parity | merged, #431 (with #442, the adapter router case-insensitive by default, and #444) |
| PR-6a errors and security | merged, #445 |
| PR-6b lifecycle | merged, #447 |
| PR-6c responses and hooks | merged, #455 |
| PR-7 bun-common request and multipart | merged, #456 (with #451, `next(object)` and `json()`'s Content-Type) |
| PR-8 bun-nest uploads | merged, #449 |
| PR-9 WS differential | merged, #458 (with #448 and #454, gateway routes unregistered on close); the floor columns fixed by #461 |
| PR-10 examples | done: the example fixes stacked on each PR (#418, #437, #441, #443, #450, #453, #457, #459, #460), and the new examples #469 (WebSocket flow control, `removeRouteHandler`), #471 (uploads, `routeResolutionStrategy`/`routeConflictPolicy`, middleware matching) and this PR (`enableCsrfProtection`/`useSecurityHeaders`, `return503OnClosing` and the drain, the response and hook changes); examples/bun-nest passes on 12.2.0 and 11.2.7 |
| PR-11 docs | in progress: the bun-nest README's NestJS 12 section and compatibility table (branch `docs/nest12-readme-v2`) |
| `@SseSignal` parity (addition, 2026-10-17) | merged, #413 (tests only; no difference from Express on 11.2.7 and 12.1.3) |
| Router benchmark guard (addition, the user's rule 2026-10-17: routing speed must not regress) | merged, #415, #422, #429 |
| Nest 12.2.0 lock move (addition, the user's decision 2026-10-20), with `getRouteMatchingOptions()` pulled forward from PR-6c | merged, #446: develop's lock 12.1.3 → 12.2.0 (Express 5.3.0), and the core's exact `/api$` middleware entry serving `/api/` on a 12.2.0 core (a whole app's `forRoutes('*')` runs once on `/api/` on 11.2.7, 12.1.3 and 12.2.0 alike; 12.2.0's `exclude()` changes are `/invoices/` under `invoices/{*path}` and `/users/LOGIN` on a case-sensitive router: [`evidence/middleware-1220/`](evidence/middleware-1220/README.md)); bun-common's copy of Express 5.3.0 (redirect body, `Content-Disposition`) merged as #452 |

Where the plan below names the "features agent", "5a", "4c" or "d6", read the
owners listed here: those names date from before bun-nest and bun-common had
agents of their own.

### Contents

1. [Summary](#1-summary)
2. [Where Nest 12 is, and where we are](#2-where-nest-12-is-and-where-we-are)
3. [Every change from 11.1.27 to 12.1.3](#3-every-change-from-11127-to-1213)
4. [The adapter contract, member by member](#4-the-adapter-contract-member-by-member)
5. [Routing in depth](#5-routing-in-depth)
6. [Everything else that goes through the adapters](#6-everything-else-that-goes-through-the-adapters)
7. [Changes per package](#7-changes-per-package)
8. [Nest 11 and 12 together](#8-nest-11-and-12-together)
9. [Testing strategy](#9-testing-strategy)
10. [PR slicing](#10-pr-slicing)
11. [Risks](#11-risks)
12. [Questions for the user, answered](#12-questions-for-the-user-answered)
13. [Evidence index](#13-evidence-index)

### How to read the markings

The marks the other plans use:

| Mark | Meaning |
|---|---|
| **[S]** | Read in this repo's source at `73bf4a00`; the `file:line` is given |
| **[M]** | Measured here by something that can be re-run; the evidence file is named |
| **[V]** | Read in a primary source: the npm registry, the `nestjs/nest` repository at a tag (commit or PR given), or the `nestjs/docs.nestjs.com` repository at `2ad58ec` |
| **[I]** | Inference: a claim to test, never a finding |
| **[D]** | A decision this plan proposes |

"Express" below means `@nestjs/platform-express`'s `ExpressAdapter` unless it
says Express itself. "Ours" or "the adapter" means bun-nest's
`BunHttpAdapter` (`packages/bun-nest/lib/BunHttpAdapter.ts`). **G1–G20**
are the gaps of [`evidence/features/report.md`](evidence/features/report.md),
**D1–D8** the routing differences of [`evidence/routing/`](evidence/routing/README.md).

---

## 1. Summary

### 1.1 The answer

**NestJS 12 is released and stable.** 12.0.0 shipped on 2026-08-27; the
`latest` tag is **12.1.3** (2026-10-12), and 11 is maintained beside it as
`legacy` **11.2.7** [V] ([`evidence/npm-registry.md`](evidence/npm-registry.md)).
This plan is against 12.1.3, not a prerelease.

**bun-nest already mostly runs on it.** With Nest 12.1.3 installed and no code
changed [M]:

- `bun --check` on bun-nest: clean (255 files); `scripts/typecheck.ts`: no
  project fails on 12 that passes on 11.
- `scripts/consumer-check.ts packages/bun-nest`: 11 spellings × 6 cells all
  OK on TypeScript 6.0.3 and 5.9.3, Bun runtime import OK, with the consumer
  verifiably on 12.1.3; the shipped `dts/` built against 11 and 12 are
  byte-identical.
- bun-nest's suite: **420 of 427 pass**. Five failures are Nest 12; two are
  an artefact of where the copy lived (§2.2).
- `examples/bun-nest`: **15 of 20 pass**; the five failures are the same
  three causes.
- The routing differential (175 requests, 21 apps, Express against ours on
  both majors): **3 regressions on 12**, 5 where Nest 12 changed Express's
  answer and not ours (4) or both differently (1), and 29 long-standing
  differences (§5).

**What breaks, in order of impact:**

1. **`@QueryMethod()` (HTTP `QUERY`, added in 11.2.0) stops the whole app
   from starting** on our adapter: `this.instance.query is not a function`
   [M]. One route kills every route. This is already true for anyone on
   `@nestjs/core` 11.2.x, which today's `^11.0.0` peers admit; develop's lock
   (11.1.27) predates it, so no test saw it.
2. **Nest 12 moved error mapping into the adapter** (#15075): an unparsable
   JSON body and an undecodable path parameter now reach the exception
   filters raw. The body answers a different 400 shape; the parameter a
   **500** instead of 400 [M].
3. **A thrown `WsException` no longer reaches our clients** (#16366): Nest 12
   writes platform-ws's `{event, data}` frame straight to any socket with a
   `send`, bypassing our wire format [M].
4. **Express 12 scopes the not-found handler to the global prefix and its
   exclusions** (#16372, #17923, and `*` middleware on the bare prefix,
   #17942); ours stays global [M].
5. **`handleDisconnect(client, reason)` gets the client as `reason`**, and an
   unserialisable WebSocket reply **exits Bun** [M] (§6.9).
6. Nest 12's adapter features we do not honour yet [M] (§6):
   `beforeClose`/`return503OnClosing`, the security hook (our 403 loses its
   security headers; we parse the body before the hook), `StreamableFile`
   cleanup on an early disconnect, multer 2.4's field-name limits (one form
   field builds a sparse array 4,294,967,295 long), request/response hooks for
   instrumentation, and a spurious warning from `useSecurityHeaders()`.
   SSE (nine changes), cookies, CSRF decisions, Standard Schema, request-scoped
   gateways and the route options all already match.

Then there is **parity debt that both majors share** and the user's "full
parity" covers: path-to-regexp 8 syntax our router does not speak (wildcard
params as arrays, `{/:x}` optional groups, an empty `*path` tail, legacy-path
conversion through `normalizePath`), case-insensitive routing, the Host's
case in `@HostParam`, and an untrue peer floor: **`^11.0.0` is already
false** — the suite needs 11.1.20 [M] (§8.1).

### 1.2 The decisions

| | Decision [D] |
|---|---|
| Versions | Support **Nest 11 and 12 together**, peer range `^11.1.20 \|\| ^12.0.0`; develop's devDeps move to 12, and 11 runs as a second column (§8) |
| Contract | Implement every member Nest 12 added that Express implements: `mapException`, `beforeClose`, `isRouteOrderSensitive`, `query`, prefix-scoped `setNotFoundHandler` with `excludedRoutes`; feature-detect 12, never import a 12-only type into a shipped declaration (§4, §8.3) |
| Routing | Bring `BunRouter` to path-to-regexp 8 semantics behind the adapter's `normalizePath`, keep registration order, let Nest's own `routeResolutionStrategy` sort (§5) |
| Tests | Turn the routing differential into a permanent test beside `expressCompat`, and run both against **both majors** through a version-matrix script (§9) |

### 1.3 What it costs, and the order

About **19 working days** across fifteen PRs (§10), most of it the
bun-nest agent's (the bun-common parts under the bun-common agent's review),
1.75 days the examples agent's and a quarter day the bun-jobs-ui agent's.
In order: the version-matrix tooling (1.5 days); `BunRouter.query()` (0.5);
the Nest 12 blockers in one bun-nest PR (2); the peer range, devDeps and
floor (0.75); the routing differential as a permanent test (1.5); routing
parity (4.5, the only PR with a breaking change, to named wildcard params);
then errors and security, lifecycle, responses and hooks, request and
multipart, uploads, the WebSocket differential, examples and docs, which can
run side by side. **PR-0 to PR-3, about 4.75 days, make bun-nest correct on
Nest 12** with both majors tested; the rest is the parity the user asked
for.

---

## 2. Where Nest 12 is, and where we are

### 2.1 Nest 12 [V]

- **Released:** `@nestjs/*` 12.0.0 on 2026-08-27; 12.0.1–12.0.4, 12.1.0–12.1.3
  since. The 11 line keeps shipping (11.2.4–11.2.7 after 12.0.0, the last two
  security backports).
- **ESM only:** every 12.x manifest has `"type": "module"` and an `exports`
  map `{ ".", "./*", "./*.js", "./internal" }`; 11.x had neither. The three
  deep imports bun-nest uses all carry `.js` and resolve through `./*.js`
  [M] ([`evidence/npm-registry.md`](evidence/npm-registry.md)).
- **Unchanged:** `engines.node >= 20` (the migration guide's 20.19 / 22.12
  floor is about `require(esm)` from CommonJS, which Bun does not need),
  `rxjs ^7.1.0`, `reflect-metadata ^0.1.12 || ^0.2.0`, legacy decorators
  (`experimentalDecorators` + `emitDecoratorMetadata`, the migration guide's
  ESM tsconfig), **`path-to-regexp` 8.4.2** and **express 5.2.1**.
- **New dependencies:** `@standard-schema/spec` in common; `file-type` 22;
  multer 2.4.0.
- **One feature in the release notes is not in any release:** v12.1.0's notes
  list "array of global prefixes" (#17713, `bfb084384`), but #17845
  (`40d07dc62`) reverted it and both are in v12.1.0 [V]. On 12.1.3
  `setGlobalPrefix(['api','v1'])` boots silently and serves every route
  **unprefixed**, on both adapters and on 11 [M]
  ([`evidence/routing/`](evidence/routing/README.md)). docs.nestjs.com's
  `faq/global-prefix.md` still documents it. We do nothing for it.

The full sources read are listed in [`evidence/README.md`](evidence/README.md#sources).

### 2.2 bun-nest on Nest 12, unchanged [M]

Measured in a copy with `@nestjs/{common,core,platform-express,websockets}`
12.1.3 and every other dependency as develop's `bun.lock` pins it
([`evidence/failures/`](evidence/failures/README.md)):

| Check | Nest 11 (develop's lock) | Nest 12.1.3 |
|---|---|---|
| `bun --check` in `packages/bun-nest` | clean | clean, 255 files |
| `bun scripts/typecheck.ts` (17 projects) | clean | clean |
| consumer-check, TS 6.0.3 and 5.9.3 | 66/66 | 66/66 each, Bun import OK |
| bun-nest `bun test --parallel` | 427 / 0 | **420 / 7** (Bun 1.4.2, 1.4.3, 1.4.4-canary.1 alike) |
| `examples/bun-nest` `bun run-all.ts` | 20 passed | **15 passed, 5 failed** |
| bun-jobs-ui `__tests__/server/nest.nest.test.ts` | 2 / 0 | 2 / 0 |

The seven failures:

| # | Test | Cause | Nest change | Kind |
|---|---|---|---|---|
| 1, 2 | `undecodableBodyOptIn.nest.test.ts:174` (served, `fetch()`) | invalid JSON body answers `{statusCode, message}` | #15075 `07603b53f`: mapping moved into `adapter.mapException` | Nest 12 |
| 3 | expressCompat "POST /echo — invalid JSON" | same | same | Nest 12 |
| 4, 5 | expressCompat `res.sendFile`, `res.download` | Express's `send` refuses any path with a dot segment; the copy lived under `~/.cache` | none: they fail on 11 there too | artefact |
| 6 | expressCompat "prefix > GET /hello" | Express 12 answers its own HTML 404 outside the prefix | #16372 `33f37d627` and follow-ups | Nest 12 |
| 7 | `websocketGatewayBinding.nest.test.ts:132-154` | `WsException` written as `{event, data}`, not through our `emit` | #16366 `efe435191` | Nest 12 |

Prototype fixes for 1–3, 6 and 7, in a scratch copy, bring the suite to
427/427 and the examples to 20/20 **on both majors** [M]; the patches are in
[`evidence/failures/`](evidence/failures/README.md).

### 2.3 Our Nest surface today [S]

Only bun-nest imports `@nestjs/*` at runtime (`grep` over every package's
`lib/`). bun-jobs has no Nest code; bun-jobs-ui uses Nest in one test;
`playground/` none.

| Piece | Where | What Nest reaches |
|---|---|---|
| `BunHttpAdapter` | `packages/bun-nest/lib/BunHttpAdapter.ts:146` (`BunNestHttpAdapter` alias at `:3534`) | extends `AbstractHttpAdapter` from `@nestjs/core/adapters/http-adapter.js` (`:84`); `instance` is a bun-common `BunRouter` built with `caseSensitive: true` (`:278-290`) |
| verb registration | `registerVerb` `:1586-1618`, typed overrides `:1688-3195` | the 16 verbs of 11's `RequestMethod`; no `query` |
| method strings | `getRequestMethodStr` `:3264-3359` | no `QUERY` case: throws `InternalServerErrorException` |
| middleware | `createMiddlewareFactory` `:3361-3378` | `instance.useMethod(method, path, cb)` |
| versioning | `applyVersionFilter` `:3380-3531` | URI, HEADER, MEDIA_TYPE, CUSTOM |
| errors | `setErrorHandler` `:1295-1300`, `setNotFoundHandler` `:1302-1307` (prefix ignored), `handleRequestError` `:1085-1165` | no `mapException` |
| replies | `reply` `:1198-1239` (`StreamableFile` `:1213-1235`), `status`, `end`, `render`, `redirect`, `isHeadersSent` `:1280-1287`, `setHeader`, `getHeader` `:835`, `appendHeader` `:839` | |
| lifecycle | `listen` `:965-1083`, `close` `:1399-1418` (`stop(true)`: no draining), `init` `:1566`, `initHttpServer` `:1576` | no `beforeClose` |
| request info | `getRequestHostname` `:1334-1336`, `getRequestMethod` `:1338`, `getRequestUrl` `:1342` | |
| parsers, CORS, static, views | `registerParserMiddleware` `:1346`, `useBodyParser` `:916`, `enableCors` `:1354-1397`, `useStaticAssets` `:1318-1328`, `setViewEngine` `:3197`, `setBaseViewsDir` `:3207` | |
| `getType()` | `:1420-1422` | returns `"express"` |
| `BunNestWebsocketAdapter` | `packages/bun-nest/lib/BunWebSocketAdapter.ts` | implements `WebSocketAdapter` from `@nestjs/common` (`:10`) |
| upload interceptors | `packages/bun-nest/lib/interceptors.ts` | multer-style, over `packages/bun-common/lib/multipart/**`; imports `HttpArgumentsHost` from `@nestjs/common/interfaces/index.js` (`:21`) |
| `./jobs` | `packages/bun-nest/lib/jobs/BunJobsApiModule.ts` | `Module`, `Inject`, `HttpAdapterHost`; lifecycle hooks `:165-195` |
| bun-common pieces Nest reaches | `BunRouter` (`packages/bun-common/lib/BunRouter.ts`), `BunRequest`, `BunResponse`, `cors`, `serveStatic`, `views`, multipart, `logging.ts`'s `fromNestLogger` | through the adapter |
| peers | `packages/bun-nest/package.json:95-97` | `@nestjs/common`, `core`, `websockets` `^11.0.0`; devDeps `^11.1.27` (`:122-125`) |
| bun-jobs-ui | `packages/bun-jobs-ui/package.json:78-79` | devDeps `@nestjs/common`, `core` `^11.1.27` for `__tests__/server/nest.nest.test.ts` |
| examples | `examples/bun-nest/**` (20 examples), `examples/bun-common/12-options/http-adapter-options.ts` | resolve Nest through the root `node_modules` |

### 2.4 The tests that prove parity today [S]

| Exists | What it proves |
|---|---|
| `packages/bun-nest/__tests__/expressCompat.nest.test.ts` + `expressCompat/{app,probes}.ts` | a **differential**: one Nest app per group booted on Express and ours, 130 probes compared on status, every header and body, with a `KNOWN` list (each still checked to differ). Response-level: replies, `@Render`, `@Redirect`, `StreamableFile`, exceptions, bodies, `res.*`, static, CORS, one prefix group |
| `expressParity.nest.test.ts` | HEAD on `@Get`, late `next()` from middleware, the request timeout |
| `express-use.test.ts`, `httpAdapter.test.ts` (1161 lines), `httpAdapterBodyParser.nest.test.ts`, `requestParsing.nest.test.ts`, `bodyParseErrors.nest.test.ts`, `undecodableBodyOptIn.nest.test.ts`, `etagOption.nest.test.ts` | the adapter's own behaviour, many against Express's documented semantics |
| `sse.nest.test.ts` | `@Sse()` failures, silence, idle timeout |
| `interceptors.test.ts` | the upload interceptors |
| `websocket*.nest.test.ts` (8 files), `wsOnUpgrade*.ts`, `upgradeHeaders.test.ts` | gateways, binding, acks, ports, custom adapters |
| `jobsApiModule.nest.test.ts`, `jobsApiGatewayCoexistence.nest.test.ts`, `jobsApiBarrelIsolation.nest.test.ts` | the `./jobs` module |
| `packaging.test.ts`, `*.type-test.ts` | exports shape; typed verbs, mounts, WS adapter use |

| Missing | Why it matters |
|---|---|
| A **routing** differential: route syntax, prefix and exclusions, versioning, middleware `forRoutes`/`exclude`, not-found | every routing finding in §5 came from a harness that does not exist in the repo |
| **Any run on a second Nest version** | the suite has only ever run on the lock's 11.1.27; the floor `^11.0.0` was never tested and is false (§8.1) |
| Nest 12 features: `QUERY`, `routeResolutionStrategy`, `routeConflictPolicy`, security hook, cookies, `beforeClose` | new in 12 |
| A WS differential against `@nestjs/platform-ws` | the WS adapter is tested on its own wire format only, which is how #16366 slipped by every test but one |

---

## 3. Every change from 11.1.27 to 12.1.3

The user asked for every entry, so the classification works from git, not
from the release notes' selection: every commit in the range that touches a
Nest package was read (the diff, for anything near the adapter) and
classified against our code. The one packaging UNKNOWN left in the core
matrix was then settled by measurement (consumer-check, §9.4). The matrices
are in [`evidence/changelog/`](evidence/changelog/):

| Matrix | Scope | Rows | AFFECTS | NO | UNKNOWN |
|---|---|---|---|---|---|
| [`matrix-core-common-testing.md`](evidence/changelog/matrix-core-common-testing.md) | every **non-merge** commit in `v11.1.27..v12.1.3` touching `packages/{core,common,testing}` (211, of which 16 release/readme commits are bulked), plus the 11.2.x branch | **199** (+7 out of scope) | **53** (9 code, 39 test, 2 doc, 3 verified OK) | **146** (2 of them "reverted before release") | **0** |
| [`matrix-platforms-ws.md`](evidence/changelog/matrix-platforms-ws.md) | every first-parent commit touching `platform-express`, `websockets`, `platform-ws`, `platform-socket.io`, `platform-fastify`, `microservices` (165), the 11.2.x branch (11), and the 59 commits inside the four merges that bundle work (the v12.0.0 merge #16391 above all) | **235** | **42** | **190** | **3** |

A commit touching both scopes appears in both. The two appendices also bucket,
with full hash lists, everything that touches none of these packages:
release commits (16), `sample/` only (143), integration tests only (9),
dependency bumps of other packages (137), tooling and CI (13), docs (7) and
conflict-resolution merges (12). A coverage check
([`addendum-coverage.md`](evidence/changelog/addendum-coverage.md)) found
22 non-merge commits inside side branches that touch a Nest package and that
neither matrix named (`ws`, Fastify and multer dependency bumps, 11.2.x
release commits, two Fastify-only fixes, socket.io types); all 22 are NO.
So **every non-merge commit in `v11.1.27..v12.1.3` and the 11.2.x branch
that touches one of the nine Nest packages is classified**: 434 matrix rows
plus those 22; the other 363 commits in the range touch no package.

**By package (platforms matrix; a row counts under each package it touches):**
platform-express 27 AFFECTS / 15 NO; websockets 14 / 19; platform-ws 7 / 17
/ 1 UNKNOWN; platform-socket.io 7 / 10; platform-fastify 11 / 46 / 2;
microservices 6 / 125, and **no microservices-only commit affects us** (its
six are multi-package rows: the v12 merge, the ESM migration, peer ranges).

The three remaining UNKNOWNs each name the probe that decides them; they are
small and are folded into the PRs that touch the code (§10):
`9847b5443` (does a gateway's `router.ws` route stay live on a server we do
not own after `app.close()`?), `b59196c98` (does our `isHeadersSent` report
`true` after `res.write()`, without finalising anything?) and `555c2ce23`
(CSRF and security headers through the inherited hook; since measured by the
features probes, §6.2: works, with two gaps).

**The AFFECTS items, ranked by impact** (merged from both matrices; each with
its fix in §10):

| # | Change (Nest) | First in | Impact on us |
|---|---|---|---|
| 1 | `@QueryMethod()` / `RequestMethod.QUERY`; `AbstractHttpAdapter.query()` delegates to `instance.query` (#17162, `d7772cd10`/`eac10cd2d`) | **11.2.0** | boot failure with any QUERY route [M] |
| 2 | error mapping moved into `adapter.mapException` (#15075, `07603b53f`) | 12.0.0 | bad JSON body: different 400; bad `%` param: **500** [M] |
| 3 | `BaseWsExceptionFilter.emitMessage` writes `{event,data}` to native sockets (#16366, `efe435191`, `bc6b0880f`) | 12.0.0 | `WsException`s never reach our clients' `exception` event [M] |
| 4 | not-found scoped to the prefix, exclusions mounted (#16372 `33f37d627`, `e25575536`, #17648, #17923 `529152191`, #18072) | 12.0.0–12.1.3 | Express answers its own HTML 404 outside the prefix; we answer Nest's JSON [M] |
| 5 | peer ranges `^12` across platform packages (`3c25112b5`) | 12.0.1 | our `^11.0.0` peers conflict with a Nest 12 install |
| 6 | stricter `isHttpError` (#14753 `1c43374d9`; #17709 `788e886ae`) | 12.0.0, 12.0.2 | bun-common's errors carry the http-errors signature and still pass (read; to test through the filter) |
| 7 | `handleDisconnect(client, reason)`: the disconnect callback now takes `(reason)` (#16374, `ad5b731cd`) | 12.0.0 | we pass the **client** as the reason (`BunWebSocketAdapter.ts:761`) [M] |
| 8 | unserialisable WS replies no longer crash platform-ws (`7e961f8b5`, also 11.2.7 `2618406e7`) | 11.2.7, 12.1.2 | ours `JSON.stringify`s inside an rxjs subscriber: a deep payload **exits Bun** (`BunWebSocketAdapter.ts:836-838`, `:641`, `:856`, `:1013`) [M] |
| 9 | `beforeClose`, `return503OnClosing`, Express graceful drain (#16156 `319437ac3`, `26953bab7`, `decb89bf0`) | 12.0.0 | not implemented; `close()` cuts in-flight requests [M] |
| 10 | `*` middleware on the bare global prefix: Express strips the core's `$` (#17942, `82a77eb53`) | 12.1.3 | `forRoutes('*')` skips `GET /api` on ours [M] |
| 11 | multipart field-name limits `fieldNestingDepth`, `fieldArrayIndexLimit` and three codes (#18074 `cf5204639`, #17857, multer 2.2–2.4) | 12.0.x–12.1.3 | none in bun-common: `a[4294967294]` builds a 4294967295-long array [M] |
| 12 | `StreamableFile` source destroyed on early disconnect (#17973 `b64b3a054`) | 12.1.3 | ours leaks the fd when the client leaves before `reply` [M] |
| 13 | CSRF protection and security headers via `registerSecurityHook` (#17836 `555c2ce23`); `useSecurityHeaders` calls `adapter.disable('x-powered-by')` (#17941) | 12.1.0, 12.1.3 | works through the inherited `use()` default, with two gaps and a spurious warning [M] (§6.2) |
| 14 | built-in cookies (#17834 `58e13ed7a`) | 12.1.0 | parity on setting; three reading differences [M] (§6.1) |
| 15 | `routeConflictPolicy`, `routeResolutionStrategy`, `isRouteOrderSensitive` (#16954 `fcb3d7d3d` and follow-ups) | 12.0.0 | work on ours; Nest sorts for us [M] (§5.3) |
| 16 | MEDIA_TYPE versioning reads any `Accept` parameter (`697ff89e0`) | 12.1.2 | ours reads only the first (`BunHttpAdapter.ts:3450-3495`) |
| 17 | SSE fixes (#18011, #17963, #17986, #17987, #18025, #18086, #17327, #17360, `@SseSignal` #17469) | 11.1.29–12.1.3 | **parity on 12**, all nine [M] (§6.4) |
| 18 | `instrument` option and its function decorator on middleware (`5adcd7a05`, 11.1.29), `setOnRouteTriggered`, Express's `setOnRequestHook`/`setOnResponseHook` (async errors guarded in `c9c251ca1`, 12.1.3) | 11.1.29–12.1.3 | instance decorator and route hook work; request/response hooks are no-ops on ours [M] |
| 19 | lifecycle hooks by hierarchy level (`d1c9ec5b3`); shutdown hooks settle and log rejections (`2ea28d0db`, `0af8c0fba`) | 12.0.0 | `BunJobsApiModule`'s order is unchanged and its tests pass on 12 [M]; add tests for a failing `api.close()` |
| 20 | ESM-only packages, `exports` map, types gathered under `@nestjs/common/internal` (`fa6d45da7`, `c4fd4da99`, `473810cc8`) | 12.0.0 | our three deep `.js` imports resolve; consumer-check 66/66; two comments now false (`BunHttpAdapter.ts:31-33`, `interceptors.ts:18-20`) [M] |
| 21 | `reply()` applies any non-nil status (`e03cf5c86`) | 12.0.0 | ours drops `0`/`NaN` (`if (statusCode)`, `BunHttpAdapter.ts:1210`) |
| 22 | `listen()` on a socket path, invalid port rejected (#18053, #18059 on Fastify; contract docs) | 12.1.3 | ours: invalid port and socket path **hang** `app.listen()` with an unhandled rejection [M] |

The rest of the AFFECTS rows are "(test)": behaviour Nest changed in the
core that runs through our adapter and needs a test, not code (request-scoped
gateways, transient middleware, GET exclusions covering HEAD, `VERSION_NEUTRAL`
in middleware, hook errors to exception filters, Standard Schema decorators).
They are listed with their test in §9.

**Not in any release**, despite the v12.1.0 notes: array global prefixes
(§2.1).

---

## 4. The adapter contract, member by member

12.1.3's `HttpServer` interface (`packages/common/interfaces/http/http-server.interface.ts`)
is now documented member by member: when the core calls it, with what, and
what it expects. `AbstractHttpAdapter` declares the **same 24 abstract
members** as in 11.1.27; everything new is concrete or optional [V]
([`evidence/contract-diff.md`](evidence/contract-diff.md)). So nothing fails
to compile, and every gap below is behaviour.

| Member | New in | Nest 12 expects | Ours today [S] | Plan [D] |
|---|---|---|---|---|
| `query()` | 11.2.0 | a `QUERY` route on the framework | inherited default calls `instance.query`; `BunRouter` has none; `getRequestMethodStr` `:3264-3359` throws on `QUERY` | `BunRouter.query()` (PR-1) and the `QUERY` case (PR-2) |
| `mapException()` | 12.0.0 | `SyntaxError`/`URIError` → `BadRequestException`, as Express | not overridden | override, no `override` keyword (PR-2) |
| `setNotFoundHandler(h, prefix, excludedRoutes)` | `excludedRoutes` 12.1.3; prefix scoping in Express 12.0.0 | Express scopes to the prefix, mounts the handler on each excluded path, skips other apps' prefixes | `:1302-1307`, global | scope it on Nest 12 only (§8.2), PR-2 |
| `beforeClose()` | 12.0.0 | flips to "shutting down"; `return503OnClosing` answers 503 | absent | PR-6b |
| `close()` | changed in Express 12.0.0 | Express drains in-flight requests; destroys sockets only with `forceCloseConnections` | `:1399-1418`, always `stop(true)` | drain with a cap, then `stop(true)` (PR-6b; keeps CLAUDE.md's port-release rule) |
| `registerSecurityHook()` | 12.1.0 | run before body parsing and Nest middleware for every request; rejections to the exception layer | inherited `use()` default: works, two gaps (§6.2) | PR-6a |
| `setCookie()`/`clearCookie()`/`setCookieSigner()` | 12.1.0 | built on `appendHeader` | our `appendHeader` `:839-846` | parity [M]; reading gaps in bun-common (PR-7) |
| `isRouteOrderSensitive?()` | 12.0.0 | Express returns `true` | absent; the core assumes `true` | declare `true` (PR-2) |
| `normalizePath?()` | (11) | Express: legacy-syntax conversion plus `path-to-regexp` validation, throwing at startup | absent: verbatim | add, with path-to-regexp 8 semantics behind it (PR-5) |
| `createMiddlewareFactory()` | changed in Express 12.1.3 | strips the core's `$` for `*` on the bare prefix | `:3361-3378` passes it through | PR-2 |
| `applyVersionFilter()` MEDIA_TYPE | Express 12.1.2 | any `Accept` parameter | first parameter only, `:3450-3495` | PR-6c |
| `reply()` | Express 12.0.0, 12.1.3 | any non-nil status; source destroyed on early disconnect; `errorHandler` on stream error | `:1198-1239`: `if (statusCode)`; no destroy; `errorLogger` only | PR-6a (errors), PR-6c (status, destroy) |
| `listen()` | contract docs 12.x | callback with an `Error` on bind failure; `address()` non-null when the callback runs | `:965-1083`: invalid port throws before the callback; a socket path hangs | PR-6b |
| `getRequestHostname()` | (11) | `req.hostname`, Host's case kept | `:1334-1336`, `URL.hostname` lower-cases | PR-5 |
| `setOnRequestHook`/`setOnResponseHook` (Express-only) | 11.x, hardened 12.1.3 | instrumentation hooks | absent | PR-6c |
| WS `bindClientDisconnect(client, cb)` | 12.0.0 | `cb(reason)` | `cb(client, code, reason)`, `BunWebSocketAdapter.ts:761` | PR-2 |
| WS exception frames | 12.0.0 | `emitMessage` → `client.send(JSON.stringify({event,data}))` for native sockets | our `emit` bypassed | PR-2, after Q4 |

---

## 5. Routing in depth

### 5.1 How Nest 12 hands routes to an adapter [V]

Read at `v12.1.3` (`packages/core/nest-application.ts`, `router/*`,
`middleware/*`):

1. **Routes.** `RoutesResolver` walks the controllers; `RouterExplorer`, for
   each method and each of its paths (global prefix, module path, controller
   path, version, method path, already joined), calls
   `router.normalizePath?.(path)` and then the verb method that
   `RouterMethodFactory` picks: `REQUEST_METHOD_MAP[method]` on the adapter,
   or `use()` when the adapter has no such member. URI versioning lives in
   the path; HEADER, MEDIA_TYPE and CUSTOM wrap the handler with the
   adapter's `applyVersionFilter`; `@Controller({ host })` wraps it with a
   check on `getRequestHostname()`. Registration order is declaration order.
2. **New in 12, opt-in:** with `routeResolutionStrategy: 'specificity'` and an
   order-sensitive adapter (`isRouteOrderSensitive?.() ?? true`), the core
   collects every route first, sorts them with `RouteSpecificitySorter`
   (literal segment before param before wildcard, segment by segment, ties
   in declaration order), then registers them; with a `routeConflictPolicy`
   it runs `RouteConflictDetector` on the normalised paths before any
   registration (`NestApplication.registerRouter`).
3. **Middleware.** `MiddlewareModule` turns each `forRoutes()` entry into
   route paths (`RouteInfoPathExtractor`: prefix, versions, and for a `*` on
   a prefixed app both `<prefix>/{*path}` and an exact `<prefix>$`), then
   calls `createMiddlewareFactory(method)(path, callback)` once per path.
   For a method other than `ALL` the core already wraps the callback to skip
   other methods (HEAD counts as GET). `exclude()` is evaluated by the core
   with `getRequestMethod` and `getRequestUrl`.
4. **After every route and the `OnModuleInit` hooks:**
   `setNotFoundHandler(handler, prefix, excludedRoutes)` and
   `setErrorHandler(handler, prefix)`; the error handler maps every error
   through `adapter.mapException` first.

The router itself — what `/files/*path` matches, what `req.params.path` is,
whether `/Case` reaches `case` — is the adapter's. That is where parity is
won or lost.

### 5.2 How our router matches [S]

- `BunHttpAdapter`'s `instance` is bun-common's `BunRouter`, built with
  `caseSensitive: true` (`packages/bun-nest/lib/BunHttpAdapter.ts:278-290`;
  `BunRouter`'s own default is `false`, `packages/bun-common/lib/BunRouter.ts:1239-1240`).
- `BunRouter` compiles paths with `@routejs/router` 3.0.3, whose syntax is
  path-to-regexp-1-like: `*` is `(.*)`, `:x?` optional, `:x(\d+)`
  constraints, `{`/`}` literal (`node_modules/@routejs/router/src/path-regex.mjs:15-27`).
  The only Express 5 translation is `normalizeCatchAllPath`, which collapses
  `*name` and `{*name}` to `*` (`BunRouter.ts:215-232`, applied in
  `setRoute`, `:1216-1227`).
- A wildcard is published as one decoded string under its position and its
  name, `{ "0": "a/b", path: "a/b" }` (`BunRouter.ts:4918-4948`); bun-common's
  typed routes promise exactly that (`packages/bun-common/lib/types/routeParams.ts:7-12`).
- Handlers run in **registration order** (Express 5); `routeSpecificity` is an
  opt-in re-ranking (`BunRouter.ts:1092`, `:4965-5005`). A route without its
  own HEAD handler answers HEAD with its GET (`:4870-4884`). `use(path)` is a
  prefix match. Nest middleware goes through `useMethod`, which keeps
  registration order (`BunHttpAdapter.ts:3361-3378`).
- An undecodable param raises Express 5's `URIError` with `status: 400`
  (`BunRouter.ts:144-148`).

### 5.3 Measured: the routing differential [M]

[`evidence/routing/`](evidence/routing/README.md): 21 Nest applications, 175
requests, each sent to Express and to ours on Nest 12.1.3, and 143 of them
(15 apps) on Nest 11. Compared: status, parsed body, `content-type`, `allow`,
`location`, a custom header, **which handler ran** and **which middleware
ran, in order**, plus every startup warning and boot error. Ours is asked
through `adapter.fetch()` and over its socket, which agreed on every request.
Three runs gave identical rows. The reference is Express on Bun's
`node:http`, not on Node (a limit, §11).

| Verdict | Requests |
|---|---|
| same | 130 |
| ours differs from Express on both majors | 18 |
| ours differs, in a Nest-12-only group | 11 |
| **regression on 12** (ours changed, Express did not) | **3** |
| Nest 12 changed Express, ours kept 11's answer | 4 |
| both changed, differently | 1 |
| Nest 12 changed both alike | 3 |
| ours matches only on 12 (Nest 12 fixed it) | 5 |

Every difference, with its cause:

| | Difference | Where | Cause [S] | On |
|---|---|---|---|---|
| **D1** | any `@QueryMethod()` route fails the **whole app** at startup | 4 rows | §4: no `instance.query`, no `QUERY` in `getRequestMethodStr` | 12 (and 11.2.x) |
| **D2** | `/users/%E0%A4%A` answers **500**, not 400 | 1 row | no `mapException`; core stopped mapping `URIError` (#15075) | 12 |
| **D3a** | wildcard params are a string, not `string[]`: `@Param('path')` gets `"a/b/c"`, Express `["a","b","c"]` | 8 rows | `BunRouter.ts:4918-4948` | both |
| **D3b** | `*path` matches an empty tail: `GET /files/` 200, Express 404 | 2 rows | `*name` and `{*name}` both collapse to `*` | both |
| **D3c** | `opt{/:x}` never matches, and nothing fails at startup | 3 rows | `{` is a literal to routejs | both |
| **D3d** | legacy `/legacy/*`, `/old/(.*)` are not converted, no warning; positional params | 5 rows | no `normalizePath` (Express's runs `LegacyRouteConverter` and validates with `pathToRegexp`) | both |
| **D4** | `/case`, `/CASE` 404 for `@Get('Case')` | 2 rows | `caseSensitive: true` default, `BunHttpAdapter.ts:280` (documented in bun-nest's README:148) | both |
| **D5** | `@HostParam` lower-cased (`A` → `a`) | 1 row | `getRequestHostname` returns `URL.hostname` (`BunHttpAdapter.ts:1334-1336`, `BunRequest.ts:5138-5140`) | both |
| **D6** | `forRoutes('*')` with a prefix skips `GET /api` | 1 row | the core's `<prefix>$` is registered literally (`BunHttpAdapter.ts:3361-3378`); Express 12.1.3 strips it (#17942) | 12 |
| **D7** | unknown paths outside the prefix: Express 12 answers its own HTML 404, ours Nest's JSON 404 | 3 rows | `setNotFoundHandler` ignores the prefix and `excludedRoutes` (`:1302-1307`) | 12 |
| **D8** | with bun-common's opt-in `routeSpecificity`, `@All` declared before `@Get` loses to it | 4 rows, opt-in | our ranking prefers an exact method over `all` (`BunRouter.ts:4968-5005`); Nest's sorter ranks segments only | opt-in |

What Nest 12 changed **on both** adapters, which ours follows because the
logic is in the core: a GET exclusion now also excludes HEAD (#17950);
middleware for a controller path with slashes now runs (#18075); a middleware
after a transient one now runs (#17846); `VERSION_NEUTRAL` in a middleware
route now works (#17947: on 11 Express failed to boot and ours silently never
ran it). **Unchanged and identical:** all four versioning types,
`defaultVersion`, arrays and `VERSION_NEUTRAL` on routes; the global prefix
with its three exclusion forms; HEAD falling back to GET; `@Head`, `@Options`,
`@Search`, `@All`; `@Redirect`, `@HttpCode`, `@Header`; host routing (case
aside); duplicate slashes; trailing slashes; encoded params (`%20`, `%2F`,
UTF-8).

### 5.4 Nest 12's route options on our adapter [M]

- **`routeResolutionStrategy: 'specificity'` works, and Nest does the
  sorting.** We do not define `isRouteOrderSensitive`, so the core treats us
  as order-sensitive, sorts, and registers in sorted order; `BunRouter` keeps
  registration order, so every `n12-specificity` request answered as on
  Express (D3a aside). [D] Declare `isRouteOrderSensitive(): true`
  explicitly, as Express does (#16954), rather than rely on the default.
  Never return `false`: the core reads it as "the router picks the most
  specific route **and rejects duplicates**", and drops shadowed duplicates
  itself; neither is true of `BunRouter`.
- **`routeConflictPolicy`:** identical warnings and the identical
  `RouteConflictException` on both adapters; with `duplicate: 'warn'` the
  first duplicate wins on both.
- **bun-common's `routeSpecificity` on top** re-ranks by method as well (D8).
  [D] Document `routeResolutionStrategy` as the supported way under Nest 12,
  and that `router: { routeSpecificity: true }` is a different ranking.
- **The conflict detector reads what `normalizePath` returns.** [D] So our
  `normalizePath` must return path-to-regexp 8 syntax (as Express's does) and
  any translation into routejs form happens later, inside `BunRouter`.

### 5.5 The fix: path-to-regexp 8 semantics behind `normalizePath` [D]

One change covers D3a–D3d, and it is mostly in bun-common:

1. **`BunHttpAdapter.normalizePath(path)`** does what Express's does:
   `LegacyRouteConverter.tryConvert` (logging Nest's own warning), then
   validation, throwing at startup on an invalid path. `LegacyRouteConverter`
   is `@nestjs/core/router/legacy-route-converter.js` on both majors (also
   re-exported from `@nestjs/core/internal` on 12); import the file path,
   which exists in 11.1.21, 11.1.27 and 12.1.3 [M] (`ls` in the copies).
2. **`BunRouter` matches path-to-regexp 8 syntax**: `{…}` optional groups,
   `*name` needing at least one segment, `{*name}` optional, wildcard params
   as `string[]` split on `/` and decoded per segment, and the startup
   errors path-to-regexp 8 throws for the old forms. Two ways:
   - **(a)** compile route paths with `path-to-regexp` 8 itself (a small,
     dependency-free parser; Express 5 and Nest already depend on it), and
     keep routejs only for what it does beyond matching; or
   - **(b)** extend the translation layer `normalizeCatchAllPath` into a full
     path-to-regexp-8-to-routejs translator, and prove it with a
     differential fuzz against `path-to-regexp` 8 as a devDependency.
   Recommendation: **(b)**, because CLAUDE.md's dependency policy keeps
   dependencies to "parsers where native is insufficient" and the route
   matcher's speed was the subject of the `bun-native-routes` plan
   (`../bun-native-routes/README.md`), whose route index
   (`packages/bun-common/lib/utils/routeIndex.ts`, `routeTree.ts`) assumes
   routejs regexps. If the fuzz cannot be made to agree, fall back to (a).
   **Decided (Q2, 2026-10-17): (b)**, with (a) only as that fallback.
3. **The breaking part:** wildcard params become `string[]`, for Nest routes
   and for direct `BunRouter` users, and `routeParams.ts` types change with
   them. The packages are unpublished (no users to migrate), but the repo's
   own examples and tests that read `params[0]` or `params.path` as a string
   change; the examples agent gets a CHANGE REPORT. Keeping the old syntax
   (`:x?`, `:x(\d+)`) for direct `BunRouter` users while Nest paths go
   through `normalizePath`'s validation is possible. **Decided (Q2):** named
   wildcards (`*name`, `{*name}`) are `string[]` everywhere, direct
   `BunRouter` users included; bare `*` and the routejs-only forms are
   unchanged.
4. **D4 and D5** are small but behavioural: default `caseSensitive: false` in
   the adapter (Express's default; today's default is documented, so this is
   a visible change; **decided, Q3: yes**, with `router: { caseSensitive:
   true }` as the opt-in), and `getRequestHostname` from the `Host` header
   with its case kept.
5. **D6 and D7** are part of the Nest 12 blockers (PR-2): strip the core's
   `$` into an exact route, and scope not-found to the prefix and exclusions
   on Nest 12 (§8.2). D7 has a cost — users lose Nest's JSON 404 and their
   exception filters for paths outside the prefix — and matching Express is
   still the recommendation, because "same answers as platform-express" is
   bun-nest's contract (`packages/bun-nest/README.md:15`). **Decided (Q5):
   match Express**, and document it.

### 5.6 The parity test: a routing differential [D]

The harness in [`evidence/routing/harness/`](evidence/routing/harness/) is
the prototype. It becomes `packages/bun-nest/__tests__/routingCompat.nest.test.ts`
in the shape of `expressCompat.nest.test.ts`:

- **Same app, two adapters.** Each group is a Nest module plus a `configure`
  (prefix, versioning, middleware consumer, Nest 12 options); `bootBoth()`
  boots it on `ExpressAdapter` and `BunHttpAdapter`; each probe is a request.
- **Observed, not asserted:** status, parsed body, `content-type`, `allow`,
  `location`, the handler that ran (each handler sets `x-h`), the middleware
  trail (each middleware appends to `x-trail`), and the startup log lines
  (a capturing `LoggerService`) and boot errors. Express's answer is the
  expectation.
- **A `KNOWN` list, each entry still checked to differ**, exactly like
  `expressCompat/probes.ts:546`: the D-rows not yet fixed land as KNOWN with
  their reason, and each fixing PR removes its rows. So the test lands
  **before** the routing fixes (it is PR-4; they are PR-5), green, and
  records the debt.
- **Nest-12-only groups** (`QUERY`, `routeResolutionStrategy`,
  `routeConflictPolicy`) skip themselves on 11 by feature detection
  (`"QUERY" in RequestMethod`, `typeof AbstractHttpAdapter.prototype.mapException`).
- **Paths starting with `//` go over a raw socket**: Bun's `fetch` client
  rewrites `//a//b` to `/a//b` (a Bun bug, reproduced on 1.4.2, 1.4.3 and
  1.4.4-canary; filed as
  [oven-sh/bun#45330](https://github.com/oven-sh/bun/issues/45330), repro in
  [`evidence/bun-bug-fetch-double-slash/`](evidence/bun-bug-fetch-double-slash/README.md)).
- **Groups to port from the harness:** `routes`, `syntax-*`, `prefix`,
  `ver-*`, `mw-basic`, `mw-prefix`, `mw-version`, `query-method`, `host`,
  `n12-*`; to add: `:x?` and `:x(\d+)` (rejected by Express 5, accepted by
  routejs), several apps on one adapter (#16372's `registeredPrefixes`), a
  trailing-slash prefix, versioned exclusions (#18072), `RouterModule`
  paths (#17710), and a differential fuzz of generated paths for (b) above.
- It runs in seconds; it is part of bun-nest's suite (direct, not heavy) and
  runs on both majors through the version matrix (§9.3).

---

## 6. Everything else that goes through the adapters

Twelve areas, each probed on Express and ours on Nest 12.1.3, and on Nest 11
where the feature exists, with platform-ws 12.1.3 for the WebSocket side
[M] ([`evidence/features/`](evidence/features/README.md); the gap numbers
**G1–G20** are its [`report.md`](evidence/features/report.md)). The plan's
author re-ran the security and shutdown probes and got the same verdicts.

### 6.1 Built-in cookies (12.1.0, #17834)

**Parity** on `setCookie`, `clearCookie` and signed cookies: byte-identical
`Set-Cookie` headers, because Nest serialises them and calls our
`appendHeader` (`BunHttpAdapter.ts:839-846`). Three reading differences, all
in bun-common's request cookies, which Nest's `@Cookies()` prefers over its
own header parse when `req.cookies` is an object:

- **G17** with `request: { parseCookies: false }`, `@Cookies()` returns `{}`
  (our getter allocates an object, `packages/bun-common/lib/BunRequest.ts:2972-2977`);
  it should be left undefined so Nest parses the header.
- **G18** a quoted value keeps its quotes (`Bun.CookieMap`;
  `packages/bun-common/lib/utils/native.ts:1268-1271`); cookie-parser and
  Nest unquote.
- `@SignedCookies()` without any secret answers 200 `{}` on ours, 500 on
  Express. [D] Document one secret: `NestFactory.create(..., { cookies: { secret } })`
  signs and verifies through Nest; bun-common's `parseCookies: { secret }`
  stays for non-Nest use.

### 6.2 CSRF protection and security headers (12.1.0, #17836; #17941)

`app.enableCsrfProtection()` and `app.useSecurityHeaders()` **work** through
the inherited, `use()`-based `registerSecurityHook`: every allow/deny
decision matches Express, through `fetch()` and served, with exclusions,
trusted origins, unmatched and unprefixed paths. Three gaps:

- **G5** our 403 carries **none** of the 12 security headers (Express's
  carries all, as `core/security/http-security-hook` says it must): the
  error path answers on a fresh `BunResponse` (`BunHttpAdapter.ts:1093-1096`),
  which also drops CORS headers on errors today.
- **G6** we parse the body **before** the hook, so a cross-site POST with
  malformed JSON gets 400 instead of 403. Measured: `request: { deferBody: true }`
  restores Express's order and still parses valid bodies.
- **G19** `useSecurityHeaders()` calls `adapter.disable('x-powered-by')`, and
  our `set()` logs a spurious warning (`BunHttpAdapter.ts:3236-3249`); we
  never send the header, so it should be a known no-op.

### 6.3 Exceptions (#15075, #17709, `errorCode`)

- **G1** (= failures 1–3, routing D2): no `mapException`. Fix in §4.
- `errorCode` serialisation and #17709's stricter `isHttpError` match.
  bun-common's status-carrying errors keep the http-errors signature
  (`expose`, `status === statusCode`) and still pass it (failures README).
- **G20** `next(plainObject)` from `app.use()` middleware: Express 409 (Nest
  12 accepts plain `{statusCode, message}`), ours 500, because bun-common
  wraps any non-`Error` (`packages/bun-common/lib/BunRouter.ts:5902-5904`).
  On 11 as well.

### 6.4 Server-sent events (11.1.29–12.1.3)

**Parity, all nine changes**: handler status and headers (#18011), `Expires`
(#17963), empty streams (#17986), early disconnect (#17987), unserialisable
data (#18025), event id (#18086), comments (#17327), `retry: 0` (#17360) and
`@SseSignal()` (#17469). The only difference is a cosmetic `Content-Length`
on a stream that completes before its first flush. Nest writes SSE to the
Node-style response our `BunResponse` exposes; it holds. The SSE helpers the
`bun-native-routes` plan proposes (§16, PR-sse2 to sse5) must keep these
probes green.

### 6.5 `StreamableFile`

Headers and a mid-stream disconnect: parity. **G10** a source returned after
the client already left is never destroyed (Express 12 destroys it, #17973):
an fd leak per abandoned download (`BunHttpAdapter.ts:1214-1236`). **G11**
(pre-existing) a source that errors before the first byte resets the
connection; `StreamableFile.errorHandler` and `setErrorHandler` never run
(Express: 400, or the custom handler's answer). Also from the changelog:
`reply()` should apply a status of `0` (`e03cf5c86`; ours `if (statusCode)`
at `:1210`).

### 6.6 Shutdown and `listen`

- **G7** `return503OnClosing` is ignored and there is no `beforeClose()`:
  during the shutdown hooks Express answers 503 with `Connection: close`,
  ours 200.
- **G9** (pre-existing) no draining: an in-flight request is **reset**
  (`ECONNRESET`) where Express finishes it (200). Ours always closes in about
  300 ms; Express without `forceCloseConnections` waits for open SSE streams
  forever. [D] Drain with a cap: `stop(false)`, wait for
  `server.pendingRequests` to reach 0 or a timeout, then `stop(true)`, which
  keeps CLAUDE.md's port-release rule (a stale keep-alive server must never
  linger under `SO_REUSEPORT`); `forceCloseConnections: true` skips the wait.
  [I] Bun's `pendingRequests` and `stop(false)` semantics need a spike first.
- **G8** (pre-existing) `app.listen(70000)` and `app.listen('/x.sock')` never
  settle and leave an unhandled rejection (`BunHttpAdapter.ts:984-989`, a
  throw inside the un-awaited async `listen`); Express rejects the first and
  listens on the socket path. Report the error through the callback, and
  support `Bun.serve({ unix })`.
- **Parity:** the listening state resets on close (#17951), a concurrent
  `close()` runs the hooks once (#18021), a busy port rejects.
- Lifecycle hooks now run by hierarchy level (`d1c9ec5b3`) and shutdown hooks
  settle with `allSettled`: `BunJobsApiModule`'s documented order
  (`packages/bun-nest/lib/jobs/BunJobsApiModule.ts:26-43`) is unchanged and its
  tests pass on 12.

### 6.7 Body parsing and Standard Schema

**Parity:** `rawBody` for JSON, text and urlencoded; `@Body/@Query/@Param({ schema })`
with `StandardSchemaValidationPipe`; `StandardSchemaSerializerInterceptor`
(zod 4.6.1). A Nest-side quirk, the same on both adapters: `@RawBody({ schema })`
is never validated, because `RAW_BODY` maps to a `custom` param type the pipe
skips; nothing for us to do. The long-standing body differences (every type
parsed by default, `Buffer` sent as bytes, nested `req.query`, the `413`
text) are already in bun-nest's "Known differences" (README:735-781).

### 6.8 Uploads

**Parity:** `FileTypeValidator` with `overrideMimeType` and `svg+xml`
(file-type 22 works under Bun), `file.buffer`, status codes. Gaps:

- **G14** multer 2.4's `limits.fieldNestingDepth` and `fieldArrayIndexLimit`
  are ignored, and `arr[4294967294]` builds a 4294967295-long sparse array:
  a memory hazard from one form field. bun-common's multipart needs both
  limits and the codes `LIMIT_FIELD_NESTING`, `LIMIT_FIELD_ARRAY_INDEX`,
  `INVALID_FIELD_NAME` (`packages/bun-common/lib/multipart/errors.ts:29-49`,
  `handlers.ts`), mapped in `packages/bun-nest/lib/interceptors.ts:120-171`.
- **G13** no module-level upload options (`MulterModule.register()`'s
  `MULTER_MODULE_OPTIONS`) and no key-by-key `limits` merge (#17818).
- **G15** multer-style options without `storageType` throw at bootstrap
  (`packages/bun-common/lib/multipart/index.ts:227`): default to memory.
- **G16** message drift: multer 2.4 says "Unexpected file field - other";
  ours "Only Field file accept one file" (`handlers.ts:208`, `:242`).

### 6.9 WebSockets

**Parity:** request-scoped gateways (`REQUEST` is the client, one instance
per connection), lifecycle-hook errors reaching exception filters (#18048),
`@MessageBody({ schema })`, the pattern in the error cause. Gaps:

- **G4** (= failure 7) `WsException` frames bypass our wire format (#16366).
- **G3** `handleDisconnect(client, reason)` gets the **client** as `reason`
  (`BunWebSocketAdapter.ts:741-765`; Nest 12's callback is `(reason)`;
  platform-ws passes the close code). Pass the close reason or code.
- From the changelog: an unserialisable reply **exits Bun** (an unguarded
  `JSON.stringify` inside an rxjs subscriber, `BunWebSocketAdapter.ts:836-838`,
  `:641`, `:856`, `:1013`): guard and log, as platform-ws 12.1.2 / 11.2.7 do.

### 6.10 `QUERY` (11.2.0)

**G2** (= routing D1): any `@QueryMethod()` route, or `forRoutes({ method:
RequestMethod.QUERY })`, fails startup. A probe-local patch
(`router.query = addRoute('query')` plus the method mapping) made both work,
through `fetch()` and served; `Bun.serve` accepts the method.

### 6.11 Logging (#17893, structured params)

No call in our adapters passes a plain object after the message, so Nest
12's structured params leave our output unchanged in text mode; in JSON mode
an `Error` is now carried under `error`, which is better. bun-common's
`fromNestLogger` (`packages/bun-common/lib/logging.ts:896-925`) passes
`fields` as Nest's optional param: on Nest 12 they become structured params,
which is what they are; a test pins it.

### 6.12 Instrumentation (`instrument`, `@nestjs/observe`)

**Parity:** `instrument.instanceDecorator` (providers, controllers, `app.use`
functions) and `setOnRouteTriggered`. **G12** `setOnRequestHook` /
`setOnResponseHook` are inherited no-ops on ours; Express implements them
(`express-adapter.ts` v12.1.3, constructor and `runRequestHook`) and
instrumentation tooling uses them. Implement both: a first middleware with a
once-guarded `done`, and a response hook after the response is produced. A
wrapper that changes a middleware's `fn.length` would flip `BunRouter`'s
four-argument error-handler detection (core matrix, `5adcd7a05`): the test
must cover an instrumented error middleware.

---

## 7. Changes per package

| Package | Changes | Owner |
|---|---|---|
| **bun-nest** (`packages/bun-nest/**`) | the Nest 12 blockers (§4: `mapException`, `QUERY`, prefix-scoped not-found, the `$` marker, `isRouteOrderSensitive`, WS exception frames, disconnect reason, WS serialisation guard); `normalizePath` and `getRequestHostname` (§5); `beforeClose`/503/drain/listen errors, `StreamableFile`, `reply` status, MEDIA_TYPE, request/response hooks, security-hook gaps (§6); `MULTER_MODULE_OPTIONS` and the new upload codes; peers `^11.1.20 \|\| ^12.0.0`, devDeps 12.1.3; the routing differential test; the README's requirements, a Nest 12 section and its known differences; the two stale "no `exports` map" comments (`BunHttpAdapter.ts:31-33`, `interceptors.ts:18-20`) | bun-nest agent |
| **bun-common** (`packages/bun-common/**`) | `BunRouter.query()` and its generated overloads (`scripts/generate-verb-overloads.ts`), and the same verb on bun-common's own `BunHttpAdapter`; path-to-regexp 8 semantics for `*name`, `{*name}` and `{…}` groups, with `routeParams.ts` typing `*name` as `string[]` (bare `*`, `:x?` and `:x(\d+)` stay, for direct users such as `packages/bun-jobs-ui/lib/jobsUi.ts:668` and bun-jobs' `"/*"` WS namespaces); `next(plainObject)` kept as an object; request cookies left undefined when parsing is off, quotes stripped; multipart `fieldNestingDepth`/`fieldArrayIndexLimit` and three codes, a memory default for `storageType`, the multer 2.4 messages; `finalErrorResponse` taking a message | built by the bun-nest agent, reviewed by the bun-common agent |
| **bun-jobs** | **none**: it imports nothing from `@nestjs/*`. It depends on bun-common, so every bun-common PR runs bun-jobs' checks (CLAUDE.md), and the bun-jobs agent reviews the `BunRouter` params change, which its management API router sits on | the bun-jobs agent reviews PR-1, PR-5 and PR-7 |
| **bun-jobs-ui** | devDeps `@nestjs/common`/`core` to `^12.1.3` (`packages/bun-jobs-ui/package.json:78-79`) for `__tests__/server/nest.nest.test.ts` (2/2 on 12 already [M]); `jobsUi.ts:668`'s `"/*"` keeps working (bare `*` is unchanged) | bun-jobs-ui agent (its own file) |
| **playground** | none: no Nest code (`grep`) | — |
| **examples** | `examples/bun-nest/**` on both majors; new examples for `@QueryMethod`, `routeResolutionStrategy`/`routeConflictPolicy`, `enableCsrfProtection`/`useSecurityHeaders`, cookies, `return503OnClosing`; the checks that change: `02-http-adapter/controllers-and-routing.ts:241` (`files/*path` params become an array), `02-http-adapter/views.ts:191`, `04-websockets/message-formats.ts` and `10-options/websocket-adapter-options.ts` (exception frames, after Q4), `02-http-adapter/undecodable-bodies.ts`, `express-parity.ts`, `10-options/jobs-api-module-options.ts` (they pass again once `mapException` lands); bun-common's `02-routing/typed-routes.ts:103-118`, `02-routing/verbs-and-params.ts:182-186`, `12-options/router-options.ts:547-548`, `06-validation/typed-handlers.ts:59` (named wildcards become arrays) | examples agent |
| **packaging** | `consumer-check` runs bun-nest against both majors (§9.4); `packages/bun-nest/__tests__/packaging.test.ts` unchanged (the `exports` shape does not move); no 12-only type (`@nestjs/common/internal`'s `RouteInfo`, `SecurityRequestHook`) in a shipped declaration (§8.3) | bun-nest agent |
| **repo tooling** | `scripts/nest-matrix.ts` (§9.3) with tests under `scripts/__tests__/`; CLAUDE.md: the matrix, the Nest floor, the routing semantics | bun-nest agent; CLAUDE.md is shared: tell every agent, and the router section is the bun-common agent's to review |

**CHANGE REPORTs** (docs/agentic-setup.md, "Talking to each other"): to the
examples agent for PR-1, PR-2, PR-3, PR-5, PR-6a/b/c, PR-7 and PR-8,
each naming the example checks it changes; to the bun-jobs agent for
PR-1, PR-5 and PR-7 (bun-common changes under bun-jobs); to the bun-jobs-ui
agent for PR-3 (its devDeps) and PR-5 (`jobsUi.ts`'s router).

---

## 8. Nest 11 and 12 together

### 8.1 The floor we claim today is false [M]

bun-nest's peers say `^11.0.0` (`packages/bun-nest/package.json:95-97`), but
the suite has only run on the lock's 11.1.27. Run on older 11.x, unchanged:

| Nest | `bun --check` (bun-nest) | `sse.nest.test.ts` | full suite |
|---|---|---|---|
| 11.0.0 | 7 errors: `Ack`/`isAckHandledManually` (from 11.1.7, `4d9c18801`), the CORS delegate overloads at `BunHttpAdapter.ts:1369`, `:1376` | 5 / 2 | 410 / 6 of 416 (a test file fails to load: `Ack` missing) |
| 11.1.7 | 2 errors (`:1369`, `:1376`) | 5 / 2 | 423 / 4 (two are the dot-path artefact) |
| 11.1.10–11.1.13 | 2 errors | 5 / 2 | — |
| 11.1.14–11.1.19 | clean | 5 / 2 | — |
| **11.1.20** onwards | clean | **7 / 0** | — |

The two SSE failures are "an observable that errors before its first event
is a 500, not a hang". So the honest floor is **11.1.20** [D], and that is
what the peer range should say, whatever is decided about 12.

### 8.2 Recommendation: one release for both, `^11.1.20 || ^12.0.0` [D]

Support both majors from one build. Why it is cheap:

- **The contract only grew.** No abstract member was added; everything new
  is optional or concrete (§4). A class with the new members compiles and
  runs against 11's base class as long as no new member carries the
  `override` keyword (`noImplicitOverride` is off in `tsconfig.base.json`,
  and a TS4113 would fail the 11 column otherwise).
- **The declarations are identical.** `dts/` built against 11 and against
  12 are byte-identical today [M], and consumer-check is 66/66 on both.
- **Nest 11 is maintained** (`legacy` 11.2.7, two security releases after
  12.0.0) and is still what most applications run. The packages are not on
  npm yet (no installed base to keep), which makes 12-only tempting, but a
  NestJS adapter that cannot run on 11 would shut out the majority for no
  technical reason.
- **Where behaviour must differ, it is detectable.** Only one change needs a
  gate: Express scopes not-found to the prefix on 12, not on 11 (D7), so ours
  does it only on 12. Detect 12 with
  `typeof AbstractHttpAdapter.prototype.mapException === "function"` (added
  in 12.0.0 with that scoping; `excludedRoutes` arrives only from 12.1.3, so
  it cannot be the signal), once, at construction. `QUERY` is detected by
  `"QUERY" in RequestMethod` (11.2.0+). Everything else is the same code on
  both: Nest 11 never calls `mapException`, `beforeClose` or
  `registerSecurityHook`, never passes `excludedRoutes`, and has no
  `emitMessage` for the WS fix to meet.

**Cost:** the version matrix (§9.3, ~1.5 days once) and a second column in
every bun-nest gate (seconds). **What must be tested on both:** bun-nest's
whole suite (including both differentials), `bun --check` in bun-nest,
`examples/bun-nest`, consumer-check, and bun-jobs-ui's `nest.nest.test.ts`.
**On 12 only:** the Nest-12-only groups (`QUERY` on 11.1.x, specificity,
conflicts, cookies, security, `beforeClose`).

**The alternative**, 12 only (`^12.0.0`): no gate, one column, a simpler
README. It saves about 2 days over the plan and drops 11. **Decided (Q1,
2026-10-17): both majors**, `^11.1.20 || ^12.0.0`, every PR tested on both.

**Which major is the repo's default:** 12. develop's devDeps move to 12.1.3
and the lockfile with them; 11 is the second column. The floor (11.1.20) and
11-latest (11.2.7) both run in the matrix, the floor once per merge window.

### 8.3 Rules for code that must run on both [D]

1. No `override` keyword on a member 11's base class lacks (`query`,
   `mapException`, `beforeClose`, `registerSecurityHook`, `setCookie`…).
2. No type from `@nestjs/common/internal` or any other 12-only path in a
   shipped declaration: `RouteInfo` comes from `@nestjs/common` (present in
   both), and `SecurityRequestHook` is written structurally. consumer-check's
   11 column catches a slip (`TS2307` with `skipLibCheck` off).
3. Deep imports keep their `.js` extension and name a file that exists in
   both majors (the three today do [M]); never a directory.
4. A behaviour gate reads a capability, never a version string. 12's
   `exports` map has no `./package.json` key (`./*` maps it to a
   non-existent `package.json.js`): Bun resolves
   `require("@nestjs/core/package.json")` anyway, Node 24 does not
   (`MODULE_NOT_FOUND`) [M]; nothing should rest on that leniency.

---

## 9. Testing strategy

### 9.1 Unit tests, per change

Every PR adds tests in the files that already own the behaviour, each with a
negative control (shown failing on its base; docs/agentic-setup.md, Gates):

| Change | Extend | New |
|---|---|---|
| `mapException` | `bodyParseErrors.nest.test.ts`, `undecodableBodyOptIn.nest.test.ts` (back to green), a direct unit test in `httpAdapter.test.ts` | — |
| `QUERY` | bun-common's router tests (a `query()` route, HEAD unaffected, typed overloads via `verbTyping.type-test.ts`) | `packages/bun-nest/__tests__/queryMethod.nest.test.ts`: `@QueryMethod()` route, `forRoutes({ method: QUERY })`, skip on Nest < 11.2 |
| not-found scoping, `$` marker | `expressCompat/probes.ts` group "prefix" (back to green); the routing differential | several apps on one adapter, trailing-slash prefix, versioned exclusions, HEAD |
| WS exception frames, disconnect reason, serialisation guard | `websocketGatewayBinding.nest.test.ts`, `websocketGatewayFeatures.nest.test.ts`, `websocketAdapter.test.ts` | a deep-payload echo that must not exit the process |
| `beforeClose`, 503, drain, `listen` errors | `httpAdapter.test.ts` (listen/close sections) | `shutdown.nest.test.ts`: 503 during the hooks, an in-flight request finishing, `forceCloseConnections`, invalid port, socket path |
| security hook | — | `security.nest.test.ts`: headers on the 403, 403 before body parsing, the `x-powered-by` call silent |
| cookies | `requestParsing.nest.test.ts` | `cookies.nest.test.ts`: `@Cookies()`/`@SignedCookies()` with `parseCookies` on and off, quoted values |
| `StreamableFile`, `reply` status | expressCompat `compat` group (an early-disconnect probe, a `0` status) | — |
| request/response hooks, `instrument` | — | `instrumentation.nest.test.ts`, including an instrumented 4-argument error middleware |
| uploads | `interceptors.test.ts`; bun-common's multipart tests | module-level options merge, the two new limits and three codes |
| `BunRouter` path syntax | bun-common's router tests, `routeParams` type tests | a differential fuzz against `path-to-regexp` 8 (devDependency of bun-common only) |
| lifecycle | `jobsApiModule.nest.test.ts` | a failing `api.close()`, close after a failed init |

Port the shapes of Nest's own e2e specs, not their code (they run on
Express/Fastify with supertest): `integration/query-method/e2e/query-method.spec.ts`,
`integration/route-conflict/e2e/{conflict-policy,resolution-strategy}.spec.ts`,
`integration/hello-world/e2e/{express-not-found,exclude-middleware,middleware-with-versioning,router-module,middleware-controller-path,middleware-execute-order}.spec.ts`,
`integration/nest-application/{global-prefix,listen,get-url,raw-body,sse,request-hooks}/e2e/express.spec.ts`
(and `sse/e2e/late-headers.spec.ts`), `integration/versioning/e2e/*-versioning.spec.ts`,
`integration/graceful-shutdown/e2e/express.spec.ts`, `integration/cookies/e2e/cookies.spec.ts`,
`integration/security/e2e/{csrf-protection,security-headers}.spec.ts`,
`integration/file-upload/e2e/parity.spec.ts`, `integration/send-files/e2e/express.spec.ts`,
and `integration/websockets/e2e/{gateway,ws-gateway,error-gateway,ws-error-gateway,request-scope-gateway,scoped-disconnect-context,connection-hook-error}.spec.ts`
(all at `v12.1.3`). Where a spec asserts Express's answer, the differential
is the better port: it asserts whatever Express answers on the installed
Nest, so it moves with Nest.

### 9.2 Differential tests against the reference adapters

1. **`expressCompat.nest.test.ts`** (exists, 130 probes): add probes for the
   new response behaviours (early-disconnect `StreamableFile`, status `0`,
   the 403 of the security hook, cookies, a refused `sendFile`), and keep
   its `KNOWN` list honest.
2. **`routingCompat.nest.test.ts`** (new, §5.6): the routing differential,
   landed first with the D-rows as `KNOWN`.
3. **`wsCompat.nest.test.ts`** (new): the same gateway module on
   `@nestjs/platform-ws`'s `WsAdapter` and on ours, compared on semantics,
   not frames (the wire formats differ by design): which handler ran, the
   reply, the ack, whether an exception is delivered and with what payload,
   the disconnect reason, request-scoped instances, hook errors. It needs
   `@nestjs/platform-ws` (and `ws`) as bun-nest devDependencies (Q8). It is
   the test that would have caught #16366 and #16374 on the day 12.0.0
   shipped.

All three are seconds long and part of bun-nest's suite (direct, not heavy).

### 9.3 The version matrix

`scripts/nest-matrix.ts` (new; root `scripts/` rules: its own lint, tests in
`scripts/__tests__/`, `if (import.meta.main)`), generalising
[`evidence/nest-mirror.sh`](evidence/nest-mirror.sh):

- `--prepare <version…>`: copies the checkout (no `node_modules`, `.git`,
  `dts`, `dist`) to `$TMPDIR/bun-node-nest-matrix/<version>/` — a path with
  **no dot segment**, or Express's `send` refuses `res.sendFile` there [M] —
  pins the four `@nestjs/*` devDependencies, widens bun-nest's peers, runs
  `bun install` and asserts `@kingsleyweb/*` resolve inside the copy.
- `--run <version…>`: in each copy, bun-nest's `bun run test`, `bun --check`
  in bun-nest, `examples/bun-nest`'s `bun run-all.ts`, bun-jobs-ui's
  `nest.nest.test.ts`, and `bun scripts/consumer-check.ts packages/bun-nest
  --work <copy>/cc` (never the default `/tmp/consumer-check-bun-nest`, which
  every session shares); prints one line per check, "what ran", and exits
  non-zero on any failure.
- Prepare is not wrapped (it installs); the run goes through the wrapper,
  because several versions in a row is a loop
  (`HEAVY_TICKET=<session>-nest-matrix /tmp/claude-1000/bun-node-heavy-run.sh
  nice -n 10 timeout 1800 bun scripts/nest-matrix.ts --run 11.2.7`, in the
  background, never polled).

| Column | When |
|---|---|
| **12-latest** (develop's lock) | every gate, as today: it is the repo itself |
| **11-latest** (11.2.7) | every PR touching bun-nest or bun-common |
| **11.1.20** (the floor) and **12.0.0** (12's floor: `excludedRoutes` only from 12.1.3) | once per merge window |
| a new Nest release | when it ships, before the lock moves (§11, R5) |

### 9.4 Packaging

consumer-check on both majors, from the matrix: today 66/66 on 12.1.3 under
TS 6.0.3 and 5.9.3 [M] and 66/66 on 11 (develop). The 11 column is what
catches a 12-only type in `dts/` (§8.3). `packaging.test.ts` needs no change.

### 9.5 Examples

`examples/bun-nest` runs in every bun-nest gate (direct) and in each matrix
column; today 20/20 on 11 and 15/20 on 12 [M], 20/20 on both with the
prototype fixes [M]. New examples per §7. bun-common's examples run after
PR-5 (named wildcards) and PR-7.

---

## 10. PR slicing

Ordered; efforts are working days of the owner, tests and docs included.
Every step (commit, PR, merge) is the user's popup decision
(docs/agentic-setup.md); examples fixes are stacked on the PR that changes
their checks.

| PR | Scope | Tests | Days | Owner | Reports to |
|---|---|---|---|---|---|
| **PR-0** matrix tooling | `scripts/nest-matrix.ts` (§9.3), its tests; CLAUDE.md "Nest versions" section; no package code | `scripts/__tests__/nest-matrix.test.ts`; a run on 11.2.7 and 12.1.3 quoted in the PR | 1.5 | bun-nest | all agents (CLAUDE.md is shared) |
| **PR-1** `BunRouter.query()` | bun-common: the verb, the generator, bun-common's `BunHttpAdapter` | router tests, type tests, bun-nest and bun-jobs checks | 0.5 | bun-nest | examples, bun-jobs |
| **PR-2** the Nest 12 blockers | bun-nest: `mapException`, `QUERY` mapping and verb, prefix-scoped not-found on 12 (bun-common's `finalErrorResponse` message), the `$` marker, `isRouteOrderSensitive(): true`, WS exception frames (after Q4), disconnect reason, WS serialisation guard, the `x-powered-by` warning, the two stale comments | §9.1 rows 1–4; the 7 failures green on 12, still green on 11 (matrix) | 2 | bun-nest | examples (5 examples go green on 12; `message-formats` per Q4) |
| **PR-3** versions | bun-nest peers `^11.1.20 \|\| ^12.0.0`, devDeps 12.1.3, lockfile; README requirements; (**PR-3b**, the bun-jobs-ui agent) bun-jobs-ui devDeps | full gates on 12; matrix 11.2.7 and 11.1.20; consumer-check both | 0.5 + 0.25 | bun-nest; bun-jobs-ui (PR-3b) | examples, bun-jobs-ui |
| **PR-4** routing differential | `routingCompat.nest.test.ts` from the harness, every D-row as `KNOWN`; the `//` paths over a raw socket | itself; green on both majors | 1.5 | bun-nest | examples |
| **PR-5** routing parity | bun-common: path-to-regexp 8 semantics for `*name`, `{*name}`, `{…}` (Q2), named wildcards as `string[]` with `routeParams.ts`, the differential fuzz; bun-nest: `normalizePath` with Nest's `LegacyRouteConverter`, `getRequestHostname` from `Host`, `caseSensitive` default (Q3); removes D3–D5 from `KNOWN` | §9.1 router rows; bun-common bench guard (no regression); bun-jobs and bun-jobs-ui checks | 4.5 | bun-nest | examples (bun-common and bun-nest examples with named wildcards), bun-jobs, bun-jobs-ui |
| **PR-6a** errors and security | carry the response through the error path (G5), defer the body when a security hook is registered (G6, Q7), `next(plainObject)` (G20), `StreamableFile.errorHandler` (G11) | `security.nest.test.ts`; expressCompat probes | 1.25 | bun-nest | examples |
| **PR-6b** lifecycle | `beforeClose`, `return503OnClosing` (G7), drain with a cap (G9, after a spike on `stop(false)`/`pendingRequests`, Q6), `listen` errors and socket paths (G8), the `9847b5443` probe | `shutdown.nest.test.ts`; port-release tests stay green | 1.25 | bun-nest | examples |
| **PR-6c** responses and hooks | early-disconnect `StreamableFile` (G10), status `0`, MEDIA_TYPE any parameter, `setOnRequestHook`/`setOnResponseHook` (G12), the `b59196c98` probe | expressCompat probes; `instrumentation.nest.test.ts` | 1 | bun-nest | examples |
| **PR-7** bun-common request and multipart | `fieldNestingDepth`, `fieldArrayIndexLimit`, three codes (G14), `storageType` default (G15), multer 2.4 messages (G16), cookies undefined when off and unquoted (G17, G18) | multipart and request tests; bun-jobs checks | 1.25 | bun-nest | examples, bun-jobs |
| **PR-8** bun-nest uploads | module-level upload options and `limits` merge (G13), the new codes mapped | `interceptors.test.ts`; upload probes in `expressCompat` (module limits, the new codes) | 0.75 | bun-nest | examples |
| **PR-9** WS differential | `wsCompat.nest.test.ts` against `@nestjs/platform-ws` (Q8) | itself, both majors | 1 | bun-nest | — |
| **PR-10** examples | Nest 12 examples (§7), every changed check, run-all on both majors | the examples themselves, with negative controls | 1.75 | examples | — |
| **PR-11** docs | bun-nest README: Nest 12 section, compatibility table (11 and 12), known differences updated; CLAUDE.md routing semantics | lint (`prettier` on long cells) | 0.5 | bun-nest | examples (README tables it owns) |

**Total: about 19 working days**: 17 for the bun-nest agent, 1.75 for the
examples agent and 0.25 for the bun-jobs-ui agent, some of it in
parallel. **PR-0 to PR-3 (≈4.75 days) make
bun-nest correct on Nest 12** with both majors tested; PR-4 to PR-11 are the
full parity the user asked for. PR-6a/6b/6c, PR-7, PR-8 and PR-9 are
independent of one another once PR-3 is in, and can be reviewed in any
order; PR-5 waits for PR-4 so it can remove `KNOWN` rows rather than add
untested behaviour.

The three UNKNOWN changelog rows are settled inside the PRs that own their
code: `9847b5443` (PR-6b), `b59196c98` (PR-6c), `555c2ce23` (measured, §6.2).

---

## 11. Risks

| # | Risk | Likelihood / impact | Mitigation [D] |
|---|---|---|---|
| R1 | PR-5's path-syntax work slows the router (the route index in `packages/bun-common/lib/utils/routeIndex.ts` and `routeTree.ts` assumes routejs regexps) | medium / high | translate at registration only, never per request; the bun-common bench and its `--compare` guard in the PR; the differential fuzz before any optimisation |
| R2 | Named wildcards becoming `string[]` breaks code that reads a string, in this repo's examples and in anyone's direct `BunRouter` use | certain / medium | packages unpublished; bare `*` and `:x?`/`:x(\d+)` unchanged; CHANGE REPORT to the examples agent with every affected example (§7); the type change makes the compiler find the call sites |
| R3 | The WS exception fix (Q4 option a) patches `BaseWsExceptionFilter.prototype` globally; a second `@nestjs/websockets` copy, or a Nest refactor of `emitMessage`, silently undoes it | medium / medium | scope by a marker symbol, cover it in `wsCompat` on every matrix column, so a Nest change fails a test the day it ships; or choose option b |
| R4 | The differentials' reference is Express **on Bun's `node:http`**, so a Bun quirk can hide on both sides (the `//` fetch bug was one) | medium / medium | raw sockets where the client matters; once per merge window, run the Express side of the routing differential on Node 24 [I: Nest 12 needs Node 20.19+/22.12+, which this machine's Node 24.2.0 meets] |
| R5 | Nest 12 moves fast (the v12.1.3 release notes list 79 bug fixes) and 11.2.x backports land; a release can change Express's answers | high / medium | the differentials assert whatever Express answers, so they move with Nest; the matrix runs 11-latest on every PR and a new release before the lock moves |
| R6 | The 12 gate (`AbstractHttpAdapter.prototype.mapException`) misfires if 11.2.x backports `mapException` | low / medium | the 11-latest column fails immediately if it does; the gate is one function, documented where it lives |
| R7 | Draining on `close()` reintroduces the stale-server hazard CLAUDE.md warns about (`SO_REUSEPORT`, keep-alive) | medium / high | drain then `stop(true)`, with a cap; the existing port-release tests stay; a spike first (PR-6b) |
| R8 | Deferring the body for the security hook changes when bodies are read, against the sync fast path the `bun-native-routes` work measured | medium / medium | only when a security hook is registered (Q7), measured with the bench |
| R9 | Scoping not-found to the prefix on 12 takes Nest's JSON 404 (and users' exception filters) away from paths outside the prefix | certain / low | it is what Express 12 does; documented in bun-nest's README; Q5 |
| R10 | A Nest 12 regression we cannot fix in our code (e.g. `@RawBody({ schema })` never validated) gets attributed to bun-nest | low / low | the differential shows the same answer on Express; note it in the README's Nest 12 section |

---

## 12. Questions for the user, answered

The user answered all eight on 2026-10-17, each with the recommendation. The
**Answer** column is what the PRs build to.

| # | Question | Recommendation | Answer (2026-10-17) | Shapes |
|---|---|---|---|---|
| **Q1** | Support Nest 11 and 12 together (`^11.1.20 \|\| ^12.0.0`), or 12 only (`^12.0.0`)? | **Both.** The contract only grew, the declarations are identical, one capability gate covers the only behavioural fork, and 11 is still maintained and widely run. 12-only saves about 2 days. Either way, the 11 floor must become 11.1.20 if 11 stays (§8.1) | **Both majors.** Peers `^11.1.20 \|\| ^12.0.0`; every PR tested on both (the 12 column and 11-latest, §9.3) | PR-0, PR-3, every PR's gate |
| **Q2** | Path-to-regexp 8 semantics in `BunRouter`: (a) adopt `path-to-regexp` 8 as a bun-common dependency, or (b) translate to routejs and prove it with a differential fuzz (devDependency only)? And do named wildcards become `string[]` for direct `BunRouter` users too? | **(b)**, falling back to (a) if the fuzz cannot be made to agree; **yes**, arrays for `*name`/`{*name}` everywhere (Express 5's semantics, which bun-common claims), with bare `*` and the routejs-only forms unchanged | **(b)**: translate in `BunRouter`, proven by a differential fuzz with `path-to-regexp` as a devDependency only; adopt it as a runtime dependency (a) only if the fuzz cannot be made to agree. **Named wildcards (`*name`, `{*name}`) become `string[]` everywhere**, direct `BunRouter` users included; bare `*` is unchanged | PR-5 |
| **Q3** | Default the adapter's router to `caseSensitive: false`, as Express, instead of today's documented `true`? | **Yes**: it is the last routing difference a default app would hit; keep `router: { caseSensitive: true }` as the opt-in | **Yes**: the adapter's router defaults to `caseSensitive: false`; `router: { caseSensitive: true }` is the opt-in | PR-5 |
| **Q4** | WS exception frames on 12: (a) patch `BaseWsExceptionFilter.prototype.emitMessage`, scoped by a marker, to keep our wire format; (b) accept Nest 12's `{event, data}` frame as a documented change on 12; (c) ship an opt-in filter | **(a)**, as prototyped (green on both majors), guarded by `wsCompat` on every matrix column; (b) if a global patch is unacceptable | **(a)**: the marker-scoped patch of `BaseWsExceptionFilter.prototype.emitMessage`, guarded by the `wsCompat` check on every matrix column | PR-2, PR-9 |
| **Q5** | On 12, answer unknown paths outside the global prefix with the adapter's bare HTML 404 (as Express 12), losing Nest's JSON 404 there? | **Yes**: bun-nest's contract is platform-express's answers; documented | **Yes, match Express**: on 12, unknown paths outside the global prefix get the bare HTML 404; documented in bun-nest's README | PR-2, PR-11 |
| **Q6** | `close()` drains in-flight requests (as Express 12) with a cap, instead of always force-closing; what cap? | **Yes**, capped at 10 s by default, skipped with `forceCloseConnections: true`; spike first | **Yes**: drain with a **10 s** cap, skipped with `forceCloseConnections: true`. **Spike first**, proving the `SO_REUSEPORT` stale-server hazard (CLAUDE.md, "Port-release pitfall") does not come back | PR-6b |
| **Q7** | Defer body reading only when `enableCsrfProtection()`/`useSecurityHeaders()` is on (G6), rather than by default? | **Only then**: Express's order where it matters, today's fast path everywhere else | **Only then**: defer the body only when `enableCsrfProtection()` or `useSecurityHeaders()` is on | PR-6a |
| **Q8** | Add `@nestjs/platform-ws` (and `ws`) as bun-nest **devDependencies** for the WS differential? | **Yes**: dev only, no runtime or consumer effect | **Yes**, as devDependencies of bun-nest | PR-9 |

Not a question for the user: the Bun bug found on the way (`fetch()` drops
the first `/` of a `//…` request target) is filed as
[oven-sh/bun#45330](https://github.com/oven-sh/bun/issues/45330), with its
reproduction and issue search in
[`evidence/bun-bug-fetch-double-slash/`](evidence/bun-bug-fetch-double-slash/README.md).

---

## 13. Evidence index

[`evidence/README.md`](evidence/README.md) indexes it all, with how to re-run
each piece and the sources read. In short:

| Evidence | Backs |
|---|---|
| [`evidence/npm-registry.md`](evidence/npm-registry.md) | §1.1, §2.1 |
| [`evidence/changelog/`](evidence/changelog/) (two matrices, their probes) | §3 |
| [`evidence/contract-diff.md`](evidence/contract-diff.md) | §4 |
| [`evidence/routing/`](evidence/routing/README.md) (harness, raw results, causes) | §5 |
| [`evidence/features/`](evidence/features/README.md) (12 probes, results, report) | §6 |
| [`evidence/failures/`](evidence/failures/README.md) (the 7 failures, prototype patches) | §2.2, §4, §10 |
| [`evidence/runs/`](evidence/runs/) (suite, check, examples, consumer-check logs; the floor bisect) | §2.2, §8.1, §9 |
| [`evidence/nest-mirror.sh`](evidence/nest-mirror.sh) | every [M] |
| [`evidence/bun-bug-fetch-double-slash/`](evidence/bun-bug-fetch-double-slash/README.md) | §5.6, §11 R4 |
