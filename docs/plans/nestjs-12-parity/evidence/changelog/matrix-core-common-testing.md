# NestJS 11.1.27 → 12.1.3: `core`, `common`, `testing` against bun-node

Every change to `packages/core`, `packages/common` and `packages/testing` between v11.1.27 and v12.1.3 (plus the 11.2.x maintenance branch), classified against our code. platform-express, websockets, platform-ws, platform-socket.io, platform-fastify and microservices belong to the other agent and are listed only in the appendix.

- **Nest source:** ../nest-src (a blobless clone with all tags). Hashes are the 9-character short hashes from `git log`; PR numbers come from the commit subject `(#N)` or, for commits inside a merged branch, from the innermost `Merge pull request #N` that brought them in (`commit-pr-inner.txt`). Commits pushed straight to master have none: 37 of the 211, of which 21 are classified rows (shown as "— (direct)") and 16 are release or readme commits.
- **First released:** `git tag --contains <hash> --sort=v:refname | grep -E '^v1[12]' | head -1`. A commit first released as v11.1.28, v11.1.29, v11.2.0 or v11.2.1 is **also in the 11.x line**. Our lockfile has core/common 11.1.27, so those changes reach us on a plain `^11` refresh, before any move to 12.
- **Our code:** worktree /home/kingsloob1/Desktop/projects/mine/bun-node-nest12-ae-1015 at 73bf4a00. Every `file:line` is relative to its root; "BunHttpAdapter.ts" is packages/bun-nest/lib/BunHttpAdapter.ts, and "BunRequest.ts", "BunResponse.ts" and "BunRouter.ts" are under packages/bun-common/lib/.
- **Classes:**
  - **AFFECTS:** something in our code must change, or behaviour that runs through our code must be tested. The qualifier says which: (code), (test), (doc), (code, optional), or (verified OK) when a probe showed it already works.
  - **NO:** with the concrete reason.
  - **UNKNOWN:** with the probe that would decide it.

## How the commit set was built (why there are more rows than first-parent commits)

`../commits-pkgs.tsv` lists the 579 **first-parent** commits, 124 of which touch core/common/testing. Many of those are merges, though. The biggest is `09dba60ce` ("Merge pull request #16391 from nestjs/v12.0.0"), with 219 side commits, 85 of them in these packages; there are also `d047fbd31` (108 side commits) and `5530b9c46` (132). Classifying the merge as a single row would hide ESM, `exports`, QUERY, route conflicts and the error-mapping rework. So each row here is a **non-merge** commit in `v11.1.27..v12.1.3` that touches the three packages:

```
git log --no-merges --full-history v11.1.27..v12.1.3 -- packages/core packages/common packages/testing   # 211 commits
```

16 of the 211 are release or readme commits, which go to appendix group R. The other 195 are the rows of batches A–D. The 4 core/common commits of the 11.2.x branch are in batch E, so there are 199 classified rows in all. The 12 merges that carry their own conflict-resolution hunks in these packages (`git diff-tree --cc`) are appendix group M. The appendix also buckets the 455 first-parent commits that do not touch the three packages at all.

The only feature/revert pair in the range is **#17713 / #17845** (array global prefixes, bfb084384 / 40d07dc62). Both landed before v12.1.0 was tagged, so no released 12.x has the feature, even though the v12.1.0 notes list it. The other "Revert" subjects in the range (574d697e7, 8376781be, 51292e832) are tooling.

## Summary

| class | rows | core | common | testing |
|---|---|---|---|---|
| AFFECTS | 53 | 46 | 20 | 5 |
| — (code) incl. code+test, code optional | 9 | | | |
| — (test) incl. "test, low", test+doc | 39 | | | |
| — (doc) | 2 | | | |
| — (verified OK) | 3 | | | |
| NO | 144 | 81 | 79 | 8 |
| NO — reverted before release | 2 | 2 | 2 | 0 |
| UNKNOWN | 0 (was 1: fa6d45da7, since measured) | 0 | 0 | 0 |
| **total classified** | **199** | | | |
| out of scope here (11.2 branch, other packages) | 7 | | | |

A row counts once in the "rows" column and once for each package it touches, so the package columns add up to more than the row count. Bulk groups, all NO, with counts in the appendix: R 16 · S 143 · I 9 · D 137 · T 13 · E 7 · M 12. Groups P (23) and O (123) are the other agent's.

## Top 15 AFFECTS, by impact on us

1. **07603b53f (#15075) — error mapping moved to `httpAdapter.mapException()`.** We don't override it, so body-parser `SyntaxError` and `URIError` no longer become `BadRequestException`. Invalid JSON now gets a different 400 body, and a bad `%`-escape gets a 500. This is the failing `compat > POST /echo — invalid JSON` test. Fix: add `mapException` to BunHttpAdapter, mirroring platform-express (express-adapter.js:442-452).
2. **d7772cd10 (#17162, in 11.2.0 already) — HTTP `QUERY`.** A `@QueryMethod()` route calls the inherited `AbstractHttpAdapter.query()` → `this.instance.query`, and neither BunRouter nor `@routejs/router` has one, so bootstrap fails with a TypeError. `getRequestMethodStr` throws for `RequestMethod.QUERY` (BunHttpAdapter.ts:3264-3359). Bun.serve accepts QUERY (measured).
3. **3c25112b5 — peer ranges.** core@12 peers `common ^12`. bun-nest peers `^11.0.0` (packages/bun-nest/package.json:95-97), so installing beside Nest 12 is a peer conflict.
4. **788e886ae + 1c43374d9/ccf416d15/591251a42/0eb2340e6 — stricter `isHttpError`.** An `Error` carrying `statusCode` is a 500 unless it has the http-errors signature. bun-common's errors carry it (BunRequest.ts:378-384, 845-851, 3906-3911; serveStatic.ts:200-221; multipart/errors.ts:81-99). Every one needs a test through Nest's filter.
5. **529152191 + b33a98890 — `setNotFoundHandler(handler, prefix, excludedRoutes)`.** Ours ignores both prefix and exclusions (BunHttpAdapter.ts:1302-1307). Express 12 now scopes its 404 to the prefix (failing `prefix > GET /hello — unprefixed route` test). Decide whether to match.
6. **fcb3d7d3d (+ea5a3cd77, 3e1c5a53a, c5225080f, ed8d86798) — `routeConflictPolicy` / `routeResolutionStrategy` and `isRouteOrderSensitive()`.** We inherit "order sensitive". Returning `false` would also claim BunRouter rejects duplicates, which it does not. Document how this combines with BunRouter's `routeSpecificity` (BunRouter.ts:1061-1122), and test both options.
7. **555c2ce23 — `enableCsrfProtection()` / `useSecurityHeaders()` through the inherited `use()`-based `registerSecurityHook`.** Untested on our adapter: 403 through the filters, and headers on 404s and on routes outside the prefix.
8. **4bf2b404a — `useSecurityHeaders()` calls `adapter.disable('x-powered-by')`.** Our `set()` warns that the setting has no effect (BunHttpAdapter.ts:3236-3258). Accept it silently.
9. **c4fd4da99 / 473810cc8 / fa6d45da7 — ESM-only packages and the `exports` map.** Our deep imports all still resolve (verified). The "no `exports` map" comments at BunHttpAdapter.ts:31-33 and interceptors.ts:18-20 are now false. Our shipped `dts/` checks for consumers on 12: consumer-check 66/66 on TS 6.0.3 and 5.9.3 (measured by the lead after this matrix was written).
10. **58e13ed7a — built-in `@Cookies()` / `@SignedCookies()` / `setCookie()`.** These interact with bun-common's own cookie parsing (`req.cookies` as `JsonValue`, its own `parseCookies.secret`, BunRequest.ts:2972-3013). Test both, and document which secret to use.
11. **26953bab7 / decb89bf0 / 319437ac3 — `beforeClose()` and `return503OnClosing`.** These are adapter-implemented. Ours ignores `initHttpServer` options (BunHttpAdapter.ts:1574-1579). Implement, or document as unsupported.
12. **SSE group** (d10b7c08f, f0806c5bf, f4b5ff48b, 52687474b, 5e6054d29, 762754607, 6498f11a9, a326599e8, c5b71643e). Late status and headers, empty streams, unserialisable events, early disconnect, `Expires`, and `@SseSignal()` all run through `BunResponse.writeHead/flushHeaders/write/end` and the socket shim. Extend `__tests__/sse.nest.test.ts`.
13. **6b282d3e1 — every Observable response with interceptors now watches `req.socket`.** That allocates our socket shim and an abort listener per such request (BunRequest.ts:3105-3203). Test the disconnect teardown, and watch the bench.
14. **5adcd7a05 / f94e9eb15 / 1dcbc259a (and 11.2.2 backports) — `instrument.instanceDecorator` wraps `app.use()` handlers.** A wrapper that changes `fn.length` flips BunRouter's 4-argument error-handler detection.
15. **2ea28d0db / 0af8c0fba / 4b596a573 — shutdown hooks now settle and log rejections, and run after a failed init.** `BunJobsApiModule` (jobs/BunJobsApiModule.ts:114-191) relies on hook order, which is unchanged. It needs tests for a failing `api.close()` and for close-after-failed-init.

Runners-up: d232dda2a (TestingModule proxy now calls adapter methods on the adapter, which fixes `#private` access), 2dbaae86b/5dafe4586 (structured log params via bun-common's `fromNestLogger`, logging.ts:896-925), 21648746d (middleware after a transient one now registers), c9ee47a1a (`HttpAdapterHost.listening` reset on close), 2e4dea33b (a GET exclusion now covers HEAD; bun-common keeps `req.method === "HEAD"`, BunRouter.ts:4878-4884).

## Structural changes (not single commits)

1. **ESM-only packages with an `exports` map** (fa6d45da7, then 6846cd712, then c4fd4da99). All three packages are `"type": "module"`, with `"exports": { ".": "./index.js", "./internal": "./internal.js", "./*.js": "./*.js", "./*": "./*.js" }` (repo12 core/package.json). The named directory entries that 6846cd712 had added (`./interfaces`, `./adapters`, …) were removed again before 12.0.0. A **directory** specifier therefore no longer resolves (`@nestjs/common/interfaces` maps to a missing `interfaces.js`), and a file specifier resolves with or without `.js`. I checked every `@nestjs/` import in packages/bun-nest/lib, packages/bun-jobs/lib (none), packages/bun-jobs-ui/lib (none), the bun-nest tests, examples and playground (probe/extract.ts → probe/names.tsv, 110 named imports):
   - `@nestjs/core/adapters/http-adapter.js` (BunHttpAdapter.ts:84): repo12 core/adapters/http-adapter.js and .d.ts exist.
   - `@nestjs/common/interfaces/external/cors-options.interface.js` (BunHttpAdapter.ts:34-37): exists.
   - `@nestjs/common/interfaces/index.js` (interceptors.ts:21): exists.
   - `@nestjs/core/adapters/http-adapter`, extensionless (__tests__/nestAdapters.type-test.ts:14): resolved through `"./*" → "./*.js"`.
   - All 110 names type-check against 12.1.3 under `nodenext` (probe/probe12.ts). The negative control (a bogus name, plus `HttpArgumentsHost` from the root) fails with TS2305/TS2724 as expected.
   - Measured with `bun --check` in the repo12 mirror: examples/bun-nest (243 files), packages/bun-jobs-ui (240), playground (234) and packages/bun-jobs (712) are all clean on 12.1.3. The bun-nest typecheck itself (255 files) was measured by the lead (../tc-bun-nest-nest12.log).
   - consumer-check of our packed `dts/` against Nest 12: 66/66 OK (row fa6d45da7, measured by the lead).
   - To reword: the comments at BunHttpAdapter.ts:31-33 and interceptors.ts:18-20 that say "`@nestjs/*` has no `exports` map". The reasoning (keep the `.js` extension for `node16` consumers) still holds; the premise does not.
2. **Types gathered in `@nestjs/common/internal`** (473810cc8, c9d59f24d for core). The root's named export list did not lose them: the 20 type names of common/internal.d.ts were already absent from the 11.1.27 root (probe/internal-root.ts fails identically on repo11 and repo12). What changed is the way in: `internal` (marked `@internal`), or a file path. Our shipped code should keep the file paths and never import `internal`.
3. **`RequestMethod.QUERY = 16`**, appended (the existing values are unchanged), plus `@QueryMethod()`, `HttpServer.query?()` and a concrete `AbstractHttpAdapter.query()` that delegates to `instance.query`. That last one is the trap: the core's "fall back to `use()`" for unimplemented verbs never applies, because the inherited method always exists. It came with 11.2.0.
4. **New adapter contract members.** `diff-adapter-contract.diff` has the full diff; these are the core call sites, compared by grepping repo11 and repo12 core for `adapter.<method>(`:
   - Methods the core now calls that 11 did not: `beforeClose`, `disable` (security headers), `isRouteOrderSensitive`, `registerSecurityHook`, `setCookieSigner`, plus `mapException` through `getHttpAdapterRef()`.
   - `setNotFoundHandler` gains `excludedRoutes`.
   - No new abstract members, which is why bun-nest still type-checks.
   - Concrete defaults we inherit: `query()` (broken for us), `mapException()` (identity, wrong for us), `beforeClose()` (no-op), `registerSecurityHook()` (`use()`-based, plausibly fine), `setCookie`/`clearCookie` (on our `appendHeader`), `normalizePath()` (identity: legacy `*` route syntax is passed to BunRouter unconverted, the routing agent's topic).
5. **`isRouteOrderSensitive?()`** (fcb3d7d3d). It defaults to `true`. Its `false` value means two things: "the router picks the most specific route" and "the router rejects duplicate `(method, path)` registrations".
6. **Unchanged, checked:**
   - `reflect-metadata` peer `^0.1.12 || ^0.2.0` and `rxjs` peer `^7.1.0`, the same in 11.1.27 and 12.1.3 (repo11/repo12 package.json). `@nestjs/common` still does `import 'reflect-metadata'` (repo12 common/index.d.ts:1).
   - `engines.node >= 20` on core, as before.
   - The only new common dependency is `@standard-schema/spec`; `file-type` went 21.3.4 → 22.1.1 and works under Bun (probe/filetype.ts).
   - The core never reads `getType()`, so our `"express"` (BunHttpAdapter.ts:1420-1422) only matters to ecosystem packages.
7. **Close sequence.** Nest 12 runs `prepareClose`/`beforeClose` → `onModuleDestroy` → `beforeApplicationShutdown` → `dispose` (gateways, microservices, `httpAdapter.close()`, then `listening = false`) → `onApplicationShutdown` (repo12 nest-application-context.js:152-164, nest-application.js:61-73). Apart from the new first step this is the order `BunJobsApiModule` documents (jobs/BunJobsApiModule.ts:26-43). Hooks within one module now run by dependency depth (d1c9ec5b3), and rejections are logged rather than aborting (0af8c0fba, 2ea28d0db).

## What could not be classified

Everything was classified. The one UNKNOWN this agent left, fa6d45da7 (consumer-check against Nest 12), was then measured by the lead: AFFECTS (verified OK). Two NO rows rest on code reading, not on a run:
- 6d4ca6eb6 and e9300535d: the adapter-agnostic path computations. The routing agent's differential harness is the measurement.
- 19ad8bf45 and 04689f128: the HTTP/2 SSE gates. Our `httpVersionMajor` is the string `"1"` (BunRequest.ts:5257-5267).

## Matrix

### Batch A — first-parent, first released in v12.1.3 (table rows 1-35)

| hash | PR | first released | pkg | title | class | where / why |
|---|---|---|---|---|---|---|
| 77613d6a3 | #18111 | v12.1.3 | core,microservices | flush buffered logs when initialization fails | NO | `nest-application(-context).ts` flushes `bufferLogs` on a failed `init()`. Logger plumbing only; our adapter logs through its own `Logger` (BunHttpAdapter.ts:294,302) and never sets `bufferLogs`. |
| 2962bc224 | #18104 | v12.1.3 | core | fail at startup for request-scoped class global enhancers | NO | `scanner.ts` + a new exception: DI validation of `APP_GUARD`/`APP_PIPE`… with `Scope.REQUEST`. Not adapter-facing; bun-nest registers no global enhancers (lib/index.ts:1-58 exports none). |
| 1da34ad89 | #18066 | v12.1.3 | core | stop silently dropping request-scoped global enhancers | NO | Same area as #18104 (scanner). DI only. |
| c5b718711 | #18090 | v12.1.3 | common | keep custom decorator data that has schema or pipes keys | NO | `createParamDecorator` option parsing (`parameter-decorator-options.util.ts`). Our `decorators.ts:1` only re-exports `UploadedFile/UploadedFiles`. |
| b33a98890 | #18072 | v12.1.3 | core | resolve uri versioned exclusions for the not-found handler | AFFECTS (test) | `routes-resolver.ts` now passes `excludedRoutes` resolved to their served (`/v1/hello`) paths as `setNotFoundHandler`'s 3rd argument. Our `setNotFoundHandler(handler, _prefix)` (BunHttpAdapter.ts:1302-1307) ignores both prefix and exclusions and runs the handler for every unmatched request (BunHttpAdapter.ts:517-526). Behaviour for excluded routes is therefore already "Nest 404 for a method miss", but Express 12 now scopes its not-found handler to the prefix (other paths get finalhandler's HTML 404) — see the failing `prefix > GET /hello — unprefixed route` compat test (test-bun-nest-nest12-run1.log). Decide whether to scope by prefix + `excludedRoutes`; add tests for prefix+exclude+URI versioning 404s. |
| 406c40267 | #18073 | v12.1.3 | common | reject arrays nested in ParseArrayPipe items | NO | Pipe validation; adapter-independent. |
| f1a4d3017 | #18075 | v12.1.3 | core | normalize slashes when mapping controllers for middleware | AFFECTS (test) | `routes-mapper.ts`: `forRoutes(Controller)` with a module path / trailing slash no longer yields `//` in the path handed to `createMiddlewareFactory` (BunHttpAdapter.ts:3361-3378 → `BunRouter.useMethod`). Previously a doubled slash may have failed to match on our router; add a `RouterModule` + `forRoutes(Controller)` middleware test. |
| 336a555bd | #18086 | v12.1.3 | core | do not mutate the message when assigning an sse event id | NO | `sse-stream.ts` formatting only; the formatted text reaches our `BunResponse.write()` unchanged. |
| f4b5ff48b | #18025 | v12.1.3 | core | end sse streams whose event data cannot be serialized | AFFECTS (test) | `router-response-controller.ts`: an unserialisable event now errors the pipeline and ends the response (`response.end()` on our `BunResponse`, BunResponse.ts:2334). Add a BigInt/circular-event case to `__tests__/sse.nest.test.ts` (it has error cases at :232-241). |
| 529152191 | #17923 | v12.1.3 | common,core,express | answer method miss on an excluded route | AFFECTS (code+test) | Adds `excludedRoutes?: RouteInfo[]` to `HttpServer.setNotFoundHandler` / `AbstractHttpAdapter.setNotFoundHandler` (abstract). Our override (BunHttpAdapter.ts:1302-1307) keeps the 2-arg signature: still type-compatible (fewer params), but should accept and document the 3rd arg if we scope by prefix (see b33a98890). |
| d10b7c08f | #18011 | v12.1.3 | core | send status and headers set by handlers on sse responses | AFFECTS (test) | SSE now reads `res.getHeaders()` and `res.statusCode` lazily at first write (`router-execution-context.ts`, `sse-stream.ts`). Our `BunResponse` has both (BunResponse.ts:1402-1419 `statusCode`, :2708 `getHeaders`) and `writeHead` (:1894). Add a test: `@Sse()` + interceptor/`@Header()` setting a header and status after piping → sent. |
| ea340b134 | #17999 | v12.1.3 | common | collect configurable module alias dependencies | NO | `ConfigurableModuleBuilder` DI; `BunJobsApiModule` builds its dynamic module by hand (jobs/BunJobsApiModule.ts:136-162). |
| d89c725ee | #18021 | v12.1.3 | core | honor a shutdown signal received while close() is in flight | NO | `enableShutdownHooks` signal bookkeeping. Close order unchanged (prepareClose → destroy → beforeShutdown → dispose → shutdown), which is what jobs/BunJobsApiModule.ts:26-43,184-191 relies on. |
| 1162fdc1b | #18026 | v12.1.3 | common | test: cover serializer context group overrides | NO | Spec only. |
| 037b0527b | #17993 | v12.1.3 | core,microservices | run transient global enhancers on controllers | NO | Injector/router-explorer enhancer resolution; adapter not involved. |
| 2e78adf8e | #17979 | v12.1.3 | core,websockets | resolve global scoped enhancers per connection | NO (core part) | Core change is in `injector.ts` (instance resolution per context id). The gateway side is for the websockets agent; our `BunWebSocketAdapter` hands Nest a client object, which is what the context id is attached to. |
| 52687474b | #17987 | v12.1.3 | core | settle SSE lifecycle on early disconnect | AFFECTS (test) | Now checks `(request.socket ?? response).destroyed` before subscribing. Our socket shim exposes `destroyed` (BunRequest.ts:1074, getter :3187) — add a test where the client disconnects during a guard, before the `@Sse()` handler runs. |
| f0806c5bf | #17986 | v12.1.3 | core | commit SSE headers for empty streams | AFFECTS (test) | An empty observable now calls `stream.commitHeaders()` → `writeHead`+`flushHeaders` on our `BunResponse` (BunResponse.ts:1894, :2034) before `end()`. Add `EMPTY` case to `sse.nest.test.ts` (expects 200 + `text/event-stream`). |
| 5eb62e21a | #17983 | v12.1.3 | common | isolate file type regexp state | NO | `FileTypeValidator` regexp `lastIndex` bug. Our file records carry `mimetype`/`buffer` (bun-common multipart/index.ts:20,36) and the validator works on them under Bun (probe/filetype.ts, measured). |
| c318730ac | #17982 | v12.1.3 | common | preserve parent validation constraints | NO | `ValidationPipe` (class-validator) metadata. |
| 863c88fc7 | #17978 | v12.1.3 | core | preserve explicit null values in reflectable decorators | NO | `Reflector` service. |
| 4b596a573 | #17966 | v12.1.3 | core | run the shutdown sequence after a failed init | AFFECTS (test) | `close()` after a failed `init()` now runs every hook and `dispose()` → our `close()` (BunHttpAdapter.ts:1399-1418). Our close is guarded (`_serverInstance && isServerListening`) so it is safe; `BunJobsApiModule.beforeApplicationShutdown` (jobs/BunJobsApiModule.ts:184-186) may now run for an API whose `onModuleInit` never ran — `api.close()` must tolerate that; add a test. |
| 5e6054d29 | #17963 | v12.1.3 | core | send the expires header on sse responses | AFFECTS (test) | SSE header typo `Expire` → `Expires`. If `sse.nest.test.ts` (":180 streams every event with Nest's SSE headers") asserts the header set, update it. |
| a0ac87df9 | #17952 | v12.1.3 | core,testing | take the scope of the class in `useClass()` overrides | NO | `Test.overrideProvider().useClass()` scope; DI/testing only. |
| 6d4ca6eb6 | #17953 | v12.1.3 | core | honor global prefix exclusions for overlapping versions | NO | `route-path-factory.ts` path computation (`/v1` vs `/v10`); adapter-agnostic — the corrected path reaches every adapter. Covered by agent-routing's differential harness. |
| 2e4dea33b | #17950 | v12.1.3 | core | let a `GET` middleware exclusion cover `HEAD` requests | AFFECTS (test) | `isMiddlewareRouteExcluded` reads `getRequestMethod()` (BunHttpAdapter.ts:1338-1340, returns `request.method`). bun-common matches a GET route for HEAD without rewriting `req.method` (BunRouter.ts:4878-4884), so the core now sees `"HEAD"` and applies the GET exclusion, as on Express; add a HEAD-vs-`exclude({ path, method: GET })` middleware test. |
| a468f796c | #17949 | v12.1.3 | common | let a redeclared `@Inject()` property replace the parent's | NO | DI metadata. |
| c9ee47a1a | #17951 | v12.1.3 | core | reset the listening state when the application closes | AFFECTS (test) | `dispose()` now sets `httpAdapterHost.listening = false` after our `close()`. Our adapter keeps its own `isListening` (BunHttpAdapter.ts:786-792, reset at :1414). Test `HttpAdapterHost.listening` and `app.listen()` again after `close()`. |
| 9e49fe4da | #17945 | v12.1.3 | core | hash `Map`, `Set` and `RegExp` options in deep-hash tokens | NO | Module opaque-key hashing. |
| e9300535d | #17947 | v12.1.3 | core | treat `VERSION_NEUTRAL` in middleware routes as no version | NO | `route-info-path-extractor.ts` builds the exclusion/registration paths; fewer duplicate registrations reach `createMiddlewareFactory` (BunHttpAdapter.ts:3361), no syntax change. Routing harness covers it. |
| 97c6e4fcd | #17944 | v12.1.3 | common | keep inherited `@Optional()` properties optional | NO | DI metadata. |
| 4bf2b404a | #17941 | v12.1.3 | core | turn off express `x-powered-by` in `useSecurityHeaders()` | AFFECTS (code) | `app.useSecurityHeaders()` now calls `httpAdapter.disable?.('x-powered-by')`. Our `disable()` (BunHttpAdapter.ts:3257) → `set()` (:3236-3249) logs `app.set("x-powered-by") has no effect…` once. Bun never sends `X-Powered-By`, so `x-powered-by` should be accepted silently. |
| 3ba6ccfcb | #17939 | v12.1.3 | core | name dynamic host modules in import error messages | NO | Error message text. |
| 5c2031e54 | #17940 | v12.1.3 | core | isolate nested transient providers injected into properties | NO | Injector. |

### Batch B — first-parent, first released in v12.0.1–v12.1.2 (table rows 36-100; release/readme commits are in the bulk appendix)

| hash | PR | first released | pkg | title | class | where / why |
|---|---|---|---|---|---|---|
| 50fb72246 | #17917 | v12.1.2 | common,core | docs: fix resolve() @returns tags | NO | JSDoc only. |
| 4ea29ccfd | #17920 | v12.1.2 | common | export UUIDVersion; 'all' and numeric versions in ParseUUIDPipe | NO | Pipe feature; adapter-independent. |
| dee19bb6d | #17930 | v12.1.2 | core | resolve durable global filters with the strategy's context id | NO | Durable-provider context ids in exception-filter resolution. |
| a054312a5 | #17925 | v12.1.2 | common | keep `StreamableFile` from mutating the caller options | NO | Our `reply()` reads `body.getHeaders()` (BunHttpAdapter.ts:1214-1235), which returns the same values; only the caller's options object is no longer mutated. |
| 41a3a547a | #17904 | v12.1.2 | common | support uuid v1, v2, v6 and v8 in `ParseUUIDPipe` | NO | Pipe. |
| daf68839d | #17893 | v12.1.1 | common,core,microservices,testing | logger bugs in json output, level changes, fatal and buffered logs | NO | `ConsoleLogger`/`Logger` internals. Our adapter calls `Logger#warn/#error(message, stack)` (BunHttpAdapter.ts:1181-1183, 1035-1038, 500-503); the `(message, stack)` call form is unchanged. bun-common's own `resolveLogger` NestJS detection is structural (CLAUDE.md "Logging"), unaffected. |
| 34c996588 | #17884 | v12.1.1 | common | preserve string enum values matching numeric member names | NO | `ParseEnumPipe`. |
| b1014b686 | #17871 | v12.1.1 | core | detect circular dependencies across more than two providers | NO | Injector. |
| 1fbe1c533 | #17876 | v12.1.1 | common | reject non-numeric items in ParseArrayPipe | NO | Pipe. |
| b5f327395 | #17860 | v12.1.1 | core,testing | honor class and factory overrides of value providers | NO | Testing overrides / DI. |
| 5100837bc | #17859 | v12.1.1 | core | recommend {*path} in the legacy wildcard warning | NO | Warning text in `LegacyRouteConverter`. That converter is called by platform-express's `normalizePath`; we implement no `normalizePath` (grep: none in packages/bun-nest/lib), so neither the conversion nor the warning reaches our adapter. Routing agent owns the `*`-syntax question. |
| 21648746d | #17846 | v12.1.0 | core | do not skip subsequent middleware after a transient one | AFFECTS (test) | Bug fix in `MiddlewareModule`: with a transient middleware first, the later ones were never registered via `createMiddlewareFactory` (BunHttpAdapter.ts:3361-3378). Behaviour now matches what users expect; add a two-middleware (first `Scope.TRANSIENT`) test. |
| 40d07dc62 | #17845 | v12.1.0 | common,core | Revert "feat(core): add support for array of global prefixes (#17713)" | NO — reverted before release | Reverts bfb084384; both landed before v12.1.0 was tagged, so no released 12.x has array prefixes (the v12.1.0 notes list #17713 anyway). `setGlobalPrefix` still takes a string, which our `setNotFoundHandler/_prefix` handling assumes. |
| bfb084384 | #17713 | v12.1.0 (reverted in same release) | common,core | add support for array of global prefixes | NO — reverted before release | See 40d07dc62. Would have passed arrays to `setNotFoundHandler/setErrorHandler`'s `prefix`; watch for it returning. |
| 6b429baaf | #17840 | v12.1.0 | core | preserve route handler names | NO | Sets `handler.name = "Controller.method"` on the function handed to our verb methods (BunHttpAdapter.ts:1586-1630 → BunRouter). Name only; `length` (arity, which BunRouter uses to detect error handlers) is not changed by `defineProperty('name')`. |
| ad1889073 | #17838 | v12.1.0 | core | inherit optional ctor params when the ctor is not redeclared | NO | Injector. |
| fb8e0d652 | #17819 | v12.1.0 | core | name the module when metadata entries are invalid | NO | Error messages. |
| 6b282d3e1 | #17826 | v12.1.0 | core | stop the Observable producer when the client disconnects | AFFECTS (test) | For an Observable result (non-SSE), the core now watches `(req.raw ?? req).socket` for `close`/`destroyed` (`fromClientDisconnect`, router-execution-context.js:246-262 in 12.1.3). On our adapter that reads `BunRequest.socket` (BunRequest.ts:3105-3203), allocating the shim and an `abort` listener on `request.signal` per Observable response; `destroyed` is `request.signal.aborted` (:3187-3189). Test: Observable handler + interceptor, client aborts → producer torn down; normal request and socket-free `fetch()` unaffected. Watch the per-request cost in the bench. |
| b2b218687 | #17827 | v12.1.0 | common | apply the ParseDatePipe default to every missing value | NO | Pipe. |
| 58e13ed7a | #17834 | v12.1.0 | common,core | add built-in, adapter-agnostic cookies | AFFECTS (test+doc) | New `@Cookies()`/`@SignedCookies()`, `cookies: { secret }` app option and `AbstractHttpAdapter.setCookie/clearCookie` built on `appendHeader()` (ours: BunHttpAdapter.ts:839-842). `@Cookies()` uses `req.cookies` when it is an object — bun-common parses cookies by default (`parseCookies: true`, BunHttpAdapter.ts:216-225; `BunRequest.cookies` :2972) into `Record<string, JsonValue>`, so JSON (`j:`) cookies may come back parsed where Nest's own parser returns strings; signed cookies are verified against `req.headers.cookie` (BunRequest.ts:5154). Add tests for both decorators, `setCookie` with several cookies, signed with Nest's secret vs bun-common's `parseCookies.secret`; document which to use. |
| 555c2ce23 | #17836 | v12.1.0 | common,core,fastify | built-in CSRF protection and security headers | AFFECTS (test) | `app.enableCsrfProtection()` / `app.useSecurityHeaders()` call `httpAdapter.registerSecurityHook`; we inherit `AbstractHttpAdapter`'s `use()`-based default, which goes through our `use()` override (BunHttpAdapter.ts:1630-1680). The hook calls `response.setHeader/removeHeader` (BunResponse has both, :2754) and `getRequestMethod/getRequestUrl` (BunHttpAdapter.ts:1338-1344); a rejected request is `next(error)` → BunRouter error mode → Nest's exception layer. Needs tests: cross-origin POST refused 403 through the filters, headers on a 404 and on a route outside the prefix, `x-powered-by` warning (see 4bf2b404a). |
| d232dda2a | #17835 | v12.1.0 | fastify,testing | feat(fastify): file upload interceptors backed by @fastify/multipart (touches `testing-module.ts`) | AFFECTS (test) | The testing part: `TestingModule.createNestApplication()`'s proxy now calls adapter-only methods (`app.set()`, `app.engine()`, `app.setLocal()`…) **on the adapter** and returns the app proxy when the method returned the adapter. Before, they ran with the proxy as `this`, which cannot reach our `#private` fields (`set()` reads `this.#ignoredSettings`, BunHttpAdapter.ts:3236-3262; `requestOpts` uses `this.#requestOpts`, :646-660) — so in 12 these work in a testing app. Nothing in the repo uses `@nestjs/testing` (no package.json or source names it), so this only reaches users' tests; add a `Test.createTestingModule(...).createNestApplication(new BunHttpAdapter())` test (needs `@nestjs/testing` as a devDependency) calling `app.set('views', …)`/`app.engine(...)` chained. The fastify interceptors themselves are the other agent's. |
| b19d9eb74 | #17821 | v12.0.4 | core | hang on sparse factory inject array | NO | Injector. |
| 10d745669 | #17793 | v12.0.4 | common | deps: file-type 22.1.1 | NO | `FileTypeValidator` dependency; measured working under Bun on our upload records (probe/filetype.ts). |
| 2ddb8bd9a | #17780 | v12.0.4 | common | mark parse date pipe options as optional | NO | Types of a pipe. |
| bc0fb5606 | #17738 | v12.0.3 | common | validate uuid version and variant when no version is set | NO | Pipe. |
| 03a7c983d | #17754 | v12.0.3 | common | test: parse uuid pipe v7 specs | NO | Spec only. |
| 3c2eaa5a6 | #17753 | v12.0.3 | common | deps: file-type 22.1.0 | NO | As 10d745669. |
| d00202ac3 | #17761 | v12.0.3 | common | invoke proto-key stripping hook via this in transform | NO | `ValidationPipe`. |
| 31a1e5030 | #17715 | v12.0.2 | common,core | docs: document the HTTP adapter contract for custom adapters | NO (doc; read it) | JSDoc only, but it is the authoritative contract our adapter implements (lifecycle, which members are awaited, `isHeadersSent` must be sync, `listen` callback `(err?)`, SSE needs Node-shaped req/res). Use it as the checklist for the plan; already summarised in ../diff-adapter-contract.diff. |
| 88a6886cf | #17712 | v12.0.2 | common | test: cover core and http decorators | NO | Spec only. |
| 290ab07be | #17690 | v12.0.2 | common | support object path segments in issue messages | NO | Standard-schema `ValidationPipe` messages. bun-common's `BunValidate` has its own issue normalisation (CLAUDE.md "Validation libraries"). |
| 02ee6d444 | #17668 | v12.0.2 | common | support numeric string values in ParseEnumPipe | NO | Pipe. |
| 1c4d9c42d | #17710 | v12.0.2 | common | collapse duplicate internal slashes in `normalizePath` | NO | `normalizePath` util in common (not the adapter method): route paths reaching our verb methods lose interior `//`. Adapter-agnostic; routing harness covers. |
| 1d1dbf7bd | #17667 | v12.0.2 | core | discover factory providers with discovery decorators | NO | DiscoveryService. |
| a0b14b583 | #17655 | v12.0.2 | common | validate UUID v3 variant | NO | Pipe. |
| 2f78be248 | #17702 | v12.0.2 | common | treat empty string as array input in ParseArrayPipe | NO | Pipe. |
| d098bf980 | #17653 | v12.0.2 | common | refactor: shared strip-proto-keys util | NO | Refactor. |
| 788e886ae | #17709 | v12.0.2 | core | avoid treating error instances with `statusCode` as http errors | AFFECTS (test) | `BaseExceptionFilter.isHttpError` now accepts an `Error` only with the http-errors signature (`expose` boolean, `status === statusCode`) or a FastifyError; a plain `Error` with `statusCode` becomes a 500. bun-common's errors carry the full signature: `PayloadTooLargeError` (BunRequest.ts:378-384), `httpError()` (:845-851), JSON `SyntaxError` (:3906-3911), `ServeStaticError` (serveStatic.ts:200-221), `UploadError` (multipart/errors.ts:81-99). Add a test per error class reaching Nest's filter, and audit any other `statusCode`-only error we throw. |
| ddbb45522 | #17625 | v12.0.2 | core | clean up repeated shutdown signal listeners | NO | `enableShutdownHooks` bookkeeping (adds the single-flight `shutdown()`); close order unchanged. |
| 783d53989 | — (direct) | v12.0.2 | core | refactor: debug-mode helper | NO | Refactor. |
| a3a31b964 | — (direct) | v12.0.2 | common,core,microservices | refactor: use Object.hasOwn | NO | Refactor. |
| a9bf20b69 | — (direct) | v12.0.2 | core | serialize errorCode for plain HttpException responses | NO | Exception body gains `errorCode` when set (new `HttpExceptionOptions.errorCode`, fc405cb55). Same body on every adapter; only a test comparing exact bodies with `errorCode` would see it. |
| 52b5e10a9 | — (direct) | v12.0.2 | core | restore logger after silent lazy module load | NO | LazyModuleLoader. |
| 9b71cad97 | — (direct) | v12.0.2 | core | discover value providers in discovery service | NO | DiscoveryService. |
| abce26ecc | — (direct) | v12.0.2 | common | serialize errorCode in built-in exception responses | NO | As a9bf20b69. |
| 24db9f733 | — (direct) | v12.0.2 | core | fix type error in dependencies cast | NO | Types. |
| 86a7f1638 | — (direct) | v12.0.2 | core | throw `UndefinedDependencyException` for nil inject entries | NO | Injector. |
| 19ad8bf45 | — (direct) | v12.0.2 | core | do not tune the shared socket for http2 sse responses | NO | Gated on `req.httpVersionMajor > 1`. `BunRequest.httpVersionMajor` is the string `"1"` (BunRequest.ts:5257-5267, `httpVersion` fixed at `"1.1"`), and `"1" > 1` is false → the HTTP/1 path, as before. |
| 04689f128 | — (direct) | v12.0.2 | core | omit connection header on http2 sse responses | NO | As 19ad8bf45. |
| fff48189f | — (direct) | v12.0.2 | core | load deferred forward-ref providers from their host module | NO | Injector. |
| f2164110f | — (direct) | v12.0.2 | common | reject null file input in parse-file pipe | AFFECTS (test, low) | `ParseFilePipe(null)` → `BadRequestException("File is required")` (measured, probe/filetype.ts). Our interceptors leave `req.file` undefined when no file is sent; examples/bun-nest/10-options/interceptor-options.ts:998 ("refuses a missing file (fileIsRequired)") should still pass — re-run it on 12. |
| 7f79233c7 | — (direct) | v12.0.2 | core | use `isNil` in provider classifiers | NO | DI. |
| 3c25112b5 | — (direct) | v12.0.1 | core,testing,… | chore: update peer deps | AFFECTS (code) | `@nestjs/core@12` peers `@nestjs/common ^12`, `@nestjs/testing@12` peers core/common ^12. Our peers are `^11.0.0` for common/core/websockets (packages/bun-nest/package.json:95-97) and devDeps `^11.1.27` (:122-125; bun-jobs-ui's devDeps packages/bun-jobs-ui/package.json:78-79): installing bun-nest beside Nest 12 is a peer conflict until widened to `^11.0.0 \|\| ^12.0.0`. |
| c9d59f24d | — (direct) | v12.0.0 | core | expose missing internals | NO | `@nestjs/core/internal` entry (see structural notes). We import nothing from `internal` (probe/names.tsv). |
| 45485b542 | — (direct; issue #17562) | v12.0.0 (also 11.2.3 as e12b47b90) | core | circular durable providers | NO | Injector. |
| f94e9eb15 | — (direct) | v12.0.0 (11.2.2 as 4593b0ad3) | core,microservices | preserve middleware arity and harden instance decorator | AFFECTS (test, low) | With `instrument.instanceDecorator`, `app.use(fn)` handlers are wrapped before reaching our `use()` (BunHttpAdapter.ts:1630-1680). BunRouter classifies a 4-parameter callback as an error handler (CLAUDE.md "Router"), so a decorator that changes `fn.length` changes routing. Test `instrument` with a 3- and 4-arg `app.use()`. |
| 1dcbc259a | — (direct; issue #17554) | v12.0.0 (11.2.2 as 35a29ccfe) | core | instrument middleware issue | AFFECTS (test, low) | Same path as f94e9eb15 (falls back to the undecorated function when the decorator returns a non-function). |

### Batch C — side-branch commits merged into master before v12.0.0 (released in 11.1.28–11.2.x and carried into 12), and v12-branch commits (table rows 101-160)

Rows released as 11.1.28 / 11.1.29 / 11.2.0 / 11.2.1 are **also in the 11.x line**: our lockfile pins `@nestjs/core`/`common` 11.1.27 (repo11 mirror), so these reach us on a plain 11.x minor upgrade too, not only with 12.

| hash | PR | first released | pkg | title | class | where / why |
|---|---|---|---|---|---|---|
| f5bf4ddea | #17509 | v12.0.0 | core | docs: Mercure SSE header comment path | NO | Comment. |
| e306724c7 | #16653 | v12.0.0 | common | deps: file-type v22 | NO | `FileTypeValidator` dep (ESM-only file-type 22); measured working under Bun on our upload records (probe/filetype.ts). |
| a326599e8 | — (direct) | v11.2.1 | core | fix sse early-return | AFFECTS (test) | On early return (headers already sent / response ended) the SSE path now aborts the `@SseSignal()` controller and logs a rejected handler result. Rides on `isHeadersSent` semantics of our `BunResponse`; covered by an `@SseSignal()` test (see 762754607). |
| e25575536 | #16391 (v12 branch) | v12.0.0 | common,core,microservices,express,testing,websockets | chore: resolve conflicts, minor fixes | NO | Conflict resolution while porting master into the ESM branch (ValidationPipe, serializer, logger, route-params). The behaviours are classified at their originating commits. |
| 6498f11a9 | #17469 | v11.2.0 | common,core | feat: signal should finalize in every case | AFFECTS (test) | `@SseSignal()` abort now fires on every SSE finalisation (complete, error, disconnect). Disconnect is detected via `request.socket ?? response` `close` — our socket shim bridges `request.signal` abort to `close` (BunRequest.ts:3116-3131). |
| 762754607 | #17469 | v11.2.0 | common,core | feat(core): sse signal | AFFECTS (test) | New `@SseSignal()` param decorator; the core attaches an `AbortController` to the request object (`attachSseAbortSignal`). `BunRequest` is an extensible class instance, so attaching works; add a test that the signal aborts when the client disconnects from an `@Sse()` route (extend `__tests__/sse.nest.test.ts:201`). |
| 4fbd6e620 | #17086 | v11.2.0 | common | potential fix for PR finding (ParseEnumPipe) | NO | Pipe. |
| 73f28b230 | #17464 | v11.2.0 | core | scan pre-registered dynamic imports of lazy modules | NO | LazyModuleLoader. |
| ca97a3f42 | #17435 | v11.2.0 | common | match string file types containing regex metacharacters | NO | `FileTypeValidator` (e.g. `image/svg+xml`); our records' `mimetype` is the client's/detected type string (bun-common multipart/index.ts:20). |
| 07410071d | #17430 | v11.2.0 | common,core | style: format union types | NO | Formatting. |
| 0e3ec5157 | #17430 | v11.2.0 | common,core,microservices | refactor: non-null assertions → defaults | NO | Refactor. |
| dea170250 | #17430 | v11.2.0 | core | scan providers when overriding a lazy-loaded module | NO | DI. |
| 7637d934b | #17430 | v11.2.0 | core | share existing singleton providers with lazily loaded modules | NO | DI. |
| b147e64e0 | — (direct) | v11.1.29 | core | chore: narrow type to a tuple (middleware decorator) | AFFECTS (test, low) | Same `instrument.instanceDecorator` path as 5adcd7a05/f94e9eb15. |
| 5adcd7a05 | — (direct) | v11.1.29 | core | apply function decorator to middleware functions | AFFECTS (test, low) | `app.use(fn)` handlers are now passed through `instrument.instanceDecorator` before our `use()` (BunHttpAdapter.ts:1630-1680). A wrapper that changes `fn.length` flips BunRouter's 4-arg error-handler detection. Only with the `instrument` option (`@nestjs/observe`); test it. |
| dd19ff1a9 | #17416 | v11.2.0 | core | convert adjacent wildcard segments in legacy route converter | NO | `LegacyRouteConverter` is used by platform-express/fastify `normalizePath`; we implement no `normalizePath`, so it never runs for our routes. (Whether we should convert legacy `*` syntax is the routing agent's question.) |
| 58dc55905 | #17401 | v11.1.29 | core | test: module-ref unit tests | NO | Spec only. |
| 8539f8747 | #17400 | v11.1.29 | core,microservices | refactor: remove async promise executor anti-patterns | NO | `module-ref.ts`, `nest-application-context.ts` internals. |
| 1e11696f4 | #17399 | v11.1.29 | common | test for #17398 | NO | Spec only. |
| 363aacb6a | #17393 | v11.1.29 | core | resolve barrier immediately when target count is zero | NO | Injector barrier. |
| 34e4dc166 | #17399 | v11.1.29 | common | exclude pipe options from validator options | NO | `ValidationPipe`. |
| 803fc2c47 | #17360 | v11.1.29 | core | serialize SSE retry field when value is zero | NO | SSE formatting, written through `BunResponse.write()` unchanged. |
| 15f30d304 | #17337 | v11.1.29 | common | @publicApi on ParseDatePipe, rename ParseArrayOptions | NO | Pipes (type rename; we use neither). |
| 5f2618ac6 | #17194 | v12.0.0 | common | reject hex and non-numeric strings in ParseFloatPipe | NO | Pipe. |
| 54f6db2f9 | #17337 | v11.1.29 | common | correct JSDoc in two http exceptions | NO | Docs. |
| 6b0c9b219 | #17335 | v11.1.29 | core | drop the g flag from middleware overlap regexes | NO | `MiddlewareBuilder` exclusion regex state bug; core-side matching before `createMiddlewareFactory`. |
| 6e5b5a784 | #17333 | v11.1.29 | common | test: override mimetype coverage | NO | Spec only. |
| a8a3b55fc | #17333 | v11.1.29 | common | add override mimetype option to file type validator | NO | `FileTypeValidator` option; works on our records (they have `buffer`, multipart/index.ts:36). |
| 9612c861c | #17327 | v11.1.29 | common,core | support sse comments | NO | `MessageEvent.comment` formatting; through `BunResponse.write()`. |
| cf5e825d2 | #17086 | v11.2.0 | common | exclude reverse-mapped keys in ParseEnumPipe | NO | Pipe. |
| a5e86d8e4 | #17257 | v11.1.28 | common | add missing exception classes to HttpErrorByCode | NO | `HttpErrorByCode` map (used by pipes' `errorHttpStatusCode`). |
| 8e7a2ee7b | #17241 | v11.1.28 | core | include auto-converted route in legacy route path warning | NO | `LegacyRouteConverter` warning; not on our path (see dd19ff1a9). |
| c5b71643e | #17239 | v11.1.28 | core | trigger sse observable teardown on disconnect | AFFECTS (test) | `InterceptorsConsumer` now tears down an interceptor-wrapped Observable when unsubscribed (client gone). Disconnect reaches it through our socket shim's `close` (BunRequest.ts:3116-3131); `__tests__/sse.nest.test.ts:201` covers the no-interceptor case — add one with an interceptor. |
| d7772cd10 | #17162 | v11.2.0 | common,core,fastify | add QUERY http method support | AFFECTS (code) | `RequestMethod.QUERY`, `@QueryMethod()`, `HttpServer.query?()`, and `AbstractHttpAdapter.query()` = `this.instance.query(...)`. (1) A `@QueryMethod()` route on our adapter calls `BunRouter.query`, which does not exist (neither BunRouter nor its base `@routejs/router` defines one: node_modules/@routejs/router/src/router.mjs:19-119 lists the verbs) → TypeError at bootstrap (RouterMethodFactory picks the inherited `query`, not the `use` fallback). (2) `forRoutes({ path, method: RequestMethod.QUERY })` → `getRequestMethodStr` throws `InternalServerErrorException` (BunHttpAdapter.ts:3264-3359 has no QUERY case). (3) bun-common: add `query()` to `BunRouter` (and the generated verb overloads, CLAUDE.md "Typed routes") and an override in BunHttpAdapter beside `search()` (:3090-3092). Bun.serve accepts the method (probe/query-method.ts, measured). Also in 11.2.0, so it bites a plain 11.x upgrade. |
| 016b45f04 | #17162 | v11.2.0 | core | test: all non-post methods return 200 | NO | Spec only. |
| eccf5b254 | #17141 | v11.1.29 | core | stop import lookup after first direct export match | NO | Injector lookup. |
| fb4d3e70a | #17107 | v12.0.0 | common | include field paths in standard schema validation errors | NO | `StandardSchemaValidationPipe` messages. |
| eb49dd188 | #17084 | v12.0.0 | testing | test: unit tests for @nestjs/testing | NO | Spec only. |
| 2ea28d0db | #17040 | v12.0.0 | core | continue shutdown when module class instance hook rejects | AFFECTS (test, low) | `BunJobsApiModule`'s shutdown hooks are on the **module class** (jobs/BunJobsApiModule.ts:114-120, 184-191). A rejected `api.close()` is now logged and shutdown continues instead of `app.close()` rejecting. Add a test of a failing `close()`; document. |
| 0af8c0fba | #17040 | v12.0.0 | core | promise.allSettled in shutdown hooks | AFFECTS (test, low) | As 2ea28d0db for providers: a rejecting `onModuleDestroy/beforeApplicationShutdown/onApplicationShutdown` no longer aborts `close()`, so our `close()` (BunHttpAdapter.ts:1399-1418) now always runs and the port is freed. |
| 4063cdb5d | #17028 | v12.0.0 | common,microservices | expose transport server getter | NO | Microservices. |
| 3a09880e0 | #17041 | v12.0.0 | common | test: spec files for HTTP exceptions | NO | Spec only. |
| d91b72cc9 | #16391 (v12 branch) | v12.0.0 | core | chore: fix merge regression | NO | Injector one-liner. |
| 78e21ab03 | #16954 | v12.0.0 | core | reset lastIndex before test() on stateful host regexps | NO | Route-conflict detector internals. |
| ea5a3cd77 | #16954 | v12.0.0 | core | detect conflicts on sorted order when specificity is on | AFFECTS (test) | Part of route-conflict diagnostics; see fcb3d7d3d. |
| c5225080f | #16954 | v12.0.0 | core | update chai style tests (also touches router-explorer, routes-resolver) | AFFECTS (test) | Part of fcb3d7d3d. |
| 3e1c5a53a | #16954 | v12.0.0 | core | route conflict overlap, identity, and fastify boot | AFFECTS (test) | Part of fcb3d7d3d; fixes conflict detection for overlapping patterns. |
| ed8d86798 | #16954 | v12.0.0 | common,core | rename router related variables | AFFECTS (doc) | Options renamed to `routeConflictPolicy` / `routeResolutionStrategy` (the names in the migration guide). Any doc/example we write must use these names. |
| fcb3d7d3d | #16954 | v12.0.0 | common,core,express,fastify | add route conflict diagnostics and specificity ordering | AFFECTS (code+test) | `NestApplication.registerRouter` reads `httpAdapter.isRouteOrderSensitive?.() ?? true`. We do not implement it → treated as order-sensitive: with `routeResolutionStrategy: 'specificity'` the core sorts routes before calling our verb methods; `routeConflictPolicy.shadow` is honoured. `false` would also tell the core the router rejects duplicate `(method, path)` registrations itself, which BunRouter does not — so do **not** return `false` merely because BunRouter's own `routeSpecificity` option is on (BunRouter.ts:1061-1122). Decide: implement `isRouteOrderSensitive() { return true }` explicitly and document how Nest's `'specificity'` and BunRouter's `routeSpecificity` combine; test both options on our adapter. |
| 415e4d337 | #16391 (v12 branch) | v12.0.0 | testing | use tryLoadPackage instead (dummy load) | NO | `TestingModule` pre-loads platform-express/microservices best-effort; with our adapter passed explicitly, nothing changes. |
| ea960f382 | #16391 (v12 branch) | v12.0.0 | core | chore: fix scripts and linter | NO | `module-ref.ts` lint. |
| 011bff660 | #16391 (v12 branch) | v12.0.0 | common,core | don't inherit the optional decorator metadata | NO | `@Optional()` not inherited (migration guide). Our injectables: `BunJobsApiModule`'s constructor declares its own params (jobs/BunJobsApiModule.ts:121-133), no `@Optional()`. |

### Batch D — v12 branch (PR #16391 and the PRs merged into it), first released in v12.0.0 (table rows 161-211)

| hash | PR | first released | pkg | title | class | where / why |
|---|---|---|---|---|---|---|
| c4fd4da99 | #16391 (v12 branch) | v12.0.0 | common,core,testing,… | remove redundant named subpath exports | AFFECTS (verified OK) | `exports` becomes `{".", "./internal", "./*.js", "./*"→"./*.js"}`. Directory specifiers (`@nestjs/common/interfaces`, `@nestjs/core/adapters`) no longer resolve (they map to a missing `interfaces.js`). Ours all name a file: `@nestjs/core/adapters/http-adapter.js` (BunHttpAdapter.ts:84), `@nestjs/common/interfaces/external/cors-options.interface.js` (:34-37), `@nestjs/common/interfaces/index.js` (interceptors.ts:21), and the test's extensionless `@nestjs/core/adapters/http-adapter` (__tests__/nestAdapters.type-test.ts:14, resolved through `"./*"`). Every target exists in repo12 and all 110 named imports type-check (probe/probe12.ts, negative control fails). The comments at BunHttpAdapter.ts:31-33 and interceptors.ts:18-20 ("`@nestjs/*` has no `exports` map") are now wrong and must be reworded. Also adds `tryLoadPackage` (no behaviour for us). |
| 5dafe4586 | #16464 | v12.0.0 | common | improve structured logging params handling | AFFECTS (test, low) | `ConsoleLogger` now treats plain-object optional params as structured params of the same entry. bun-common's `fromNestLogger` passes a `fields` object as a Nest optional param (bun-common logging.ts:896-925), so with a Nest `ConsoleLogger` behind `resolveLogger`, fields now print as part of the entry (JSON: under `params`) instead of a separate record. Improvement; check `__tests__/logging.test.ts` expectations that go through a real `ConsoleLogger`, and say so in the Logging docs. |
| 4ab3ce86d | #16464 | v12.0.0 | common | opt-out for structured params (`structuredParams: false`) | AFFECTS (doc) | As 5dafe4586. |
| 2dbaae86b | #16464 | v12.0.0 | common | add structured logging params support | AFFECTS (test, low) | As 5dafe4586. Our adapter's own calls pass strings/Errors only (BunHttpAdapter.ts:1181-1183, 1407-1410), unaffected. Note (pre-existing, not from 12): `this.logger.warn(message, stack)` at :1181 makes the stack Nest's *context* argument. |
| e15f18886 | #16429 | v12.0.0 | common | apply suggestion (microservice interface) | NO | Microservices. |
| e240e2fad | #16429 | v12.0.0 | common,core,microservices | rename prerequest hook method | NO | Microservices pre-request hooks. |
| ead0d87b0 | #16429 | v12.0.0 | common | rename prerequest hook method | NO | Microservices. |
| ec7fc4f34 | #16017 | v12.0.0 | common | fix test for v12 branch | NO | Spec/`ConflictException` test fix. |
| 329cb3742 | #16429 | v12.0.0 | common,microservices | fix esm import paths | NO | Microservice interfaces' import paths. |
| 140f0c3ae | #16429 | v12.0.0 | core,microservices | test: convert spec files to vitest | NO | Spec only. |
| 6f3e56f17 | #16429 | v12.0.0 | core | test: pre-request hooks storage | NO | Spec only. |
| 099fff724 | #16429 | v12.0.0 | common,core,microservices | global pre-request hooks before guards (microservices) | NO | `NestMicroservice` only (`application-config.ts` storage). |
| cb1faffd0 | #16017 | v12.0.0 | common | preserve default description for all HTTP exceptions with options | NO | Exception bodies; same on every adapter. |
| 4aef43808 | #14753 | v12.0.0 | core | fix: update tests | NO | Spec only. |
| 0eb2340e6 | #14753 | v12.0.0 | core | handle FastifyError as before | AFFECTS (test) | `isHttpError` evolution, final form in 788e886ae (batch B). |
| 1c43374d9 | #14753 | v12.0.0 | core | make `isHttpError` check stricter | AFFECTS (test) | First step of the http-errors-signature check (`expose` boolean, `status === statusCode`, `instanceof Error`). See 788e886ae for what bun-common's errors carry. |
| 9b88230da | #14832 | v12.0.0 | core | test(common): fix isEmpty in context creators | NO | Internal util rename. |
| 3aa97fc6d | #14832 | v12.0.0 | common | test: shared utils | NO | Util tests. |
| 7b1a9d182 | #14832 | v12.0.0 | common | restore isEmpty with coverage | NO | Util. |
| 202995829 | #14832 | v12.0.0 | common | fix isEmptyArray behaviour | NO | Util. |
| dc49342ee | #14832 | v12.0.0 | common,core,microservices,websockets | isEmptyArray in context creators | NO | Internal util swap in filter/guard/pipe context creators; no change in which enhancers apply. |
| 4fe18eb73 | #14832 | v12.0.0 | common | test: shared utils coverage | NO | Util. |
| a5c981c18 | #15190 | v12.0.0 | core | test: fix flaky test | NO | Spec only. |
| ec95499d4 | #15413 | v12.0.0 | common | apply suggestion (PipeTransform) | NO | Types. |
| 5a47244b7 | #15413 | v12.0.0 | common | apply suggestion (PipeTransform) | NO | Types. |
| 953569a0a | #14900 | v12.0.0 | core | move hierarchy set after comp host resolution | NO | Part of the hook-ordering feature (d1c9ec5b3). |
| cbdc24e91 | #16329 | v12.0.0 | common | error format option for ValidationPipe | NO | Pipe option. |
| 65297f651 | #16147 | v12.0.0 | common | pipe `transform` signatures for type safety | NO (verified) | Custom pipes in examples/bun-nest/02-http-adapter/pipeline.ts implement `PipeTransform`/`ArgumentMetadata`; examples/bun-nest type-checks clean on 12.1.3 (243 files, measured in repo12). |
| 07603b53f | #15075 | v12.0.0 | core,express,fastify | HTTP adapter error mapping | **AFFECTS (code)** | Core's `RoutesResolver.mapExternalException` (SyntaxError/URIError → `BadRequestException`, FastifyError → `HttpException`) is gone; the exception layer now calls `httpAdapter.mapException(err)`, whose `AbstractHttpAdapter` default is identity. We do not override it, so an invalid-JSON body (bun-common throws a `SyntaxError` with `status/statusCode/expose`, BunRequest.ts:3900-3911) is answered by `BaseExceptionFilter.isHttpError` as `{statusCode:400,message}` instead of Express's `BadRequestException` body `{message,error:"Bad Request",statusCode:400}`, and a bad `%`-escape `URIError` without that shape becomes a 500. This is the failing `bun-nest vs platform-express: compat > POST /echo — invalid JSON` test (test-bun-nest-nest12-run1.log). Fix: add `mapException(error)` to BunHttpAdapter mirroring platform-express 12 (express-adapter.js:442-452). Also the comment at BunRequest.ts:3906-3907 names the removed `mapExternalException`. |
| d37c2664b | #14900 | v12.0.0 | core | test: remove useless test file | NO | Spec only. |
| d617106f5 | #14900 | v12.0.0 | core | chore: resolve merge conflicts | NO | Hooks utils conflict resolution. |
| decb89bf0 | #16156 | v12.0.0 | common,express | rename graceful shutdown option → `return503OnClosing` | AFFECTS (code, optional) | `NestApplicationOptions.return503OnClosing`. Implementing it is the adapter's job (contract: `initHttpServer` honours it, `beforeClose` flips the state). Our `initHttpServer(_options)` ignores options (BunHttpAdapter.ts:1574-1579). Decide: support it (503 in `serveNativeRequest` once closing) or document it as unsupported. |
| 26953bab7 | #16156 | v12.0.0 | common,core,express | activate shutdown flag before hooks (`beforeClose`) | AFFECTS (code, optional) | New `HttpServer.beforeClose?()`, awaited before every shutdown hook (`prepareClose`). Inherited no-op on our adapter; needed for return503OnClosing. Close order otherwise unchanged (BunJobsApiModule relies on it, jobs/BunJobsApiModule.ts:26-43). |
| 319437ac3 | #16156 | v12.0.0 | common,express | add graceful shutdown option | AFFECTS (code, optional) | As decb89bf0 (option introduced, later renamed). |
| fb3ae67e2 | #16373 | v12.0.0 | common,core,microservices,testing,websockets | address lint errors, fix CI | NO | Lint (`route-params.decorator.ts`). |
| 543142d5c | #16373 | v12.0.0 | common | don't export plain literal object interface | NO | Serializer typing. |
| 09c81568f | #16373 | v12.0.0 | common,core,… | introduce standard schema serializer | NO | `StandardSchemaSerializerInterceptor`, `@SerializeOptions({ schema })`, `StandardSchemaValidationPipe`; adapter-agnostic (works on the handler result before `reply()`). Doc opportunity next to bun-common's `BunValidate`, which already speaks Standard Schema. |
| 473810cc8 | #16373 | v12.0.0 | common,core,… | introduce the internal export path | AFFECTS (verified OK) | Types sibling packages need are gathered in `@nestjs/common/internal` (repo12 common/internal.d.ts). The root's named list did **not** shrink: 19 of internal's 20 type names (`HttpArgumentsHost`, `CorsOptions`, `RequestHandler`, `RouteInfo`, `VersionValue`, …) are missing from the root in 11.1.27 too (measured: probe/internal-root.ts fails identically against repo11 and repo12; the 20th, `SecurityRequestHook`, is new). What changed is the way in: 11's directory entries (`@nestjs/common/interfaces`) are gone (c4fd4da99), `internal` and file paths remain. We import those through file paths, not the root (BunHttpAdapter.ts:34-37; interceptors.ts:21), so nothing breaks (probe/probe12.ts). Rule for new code: never import a type from `@nestjs/common/internal` in shipped `lib/` (Nest marks it `@internal`); keep the file-path imports. |
| 50f0f7286 | #16373 | v12.0.0 | common | introduce param decorator options | NO | `@Body({ schema, pipes })` etc. Read from the request properties we already provide (`body`, `query`, `params`). |
| 6586c0d98 | #16372 | v12.0.0 | common,core,microservices | refactor: minor codebase tweaks | NO | Optional chaining in `dispose()`/`useStaticAssets`/`setViewEngine`; `httpCode ?? default` — `@HttpCode(0)` would now send status 0 (edge only). |
| 288453fab | #16370 | v12.0.0 | common,core,… | test: fix coverage, add more tests | NO | Tests + `initializationPromise` refactor (no ordering change). |
| 6846cd712 | #16370 | v12.0.0 | common,core,testing,… | test: migrate to vitest | NO (structural) | Adds the `"./*.js"`/`"./*"` patterns and named subpaths to `exports` (later trimmed by c4fd4da99). Test-infra otherwise. |
| 33f37d627 | #16369 | v12.0.0 | common,core,express,ws,testing | refactor: minor tweaks | AFFECTS (test, low) | Optional packages (`@nestjs/websockets/socket-module`, `@nestjs/microservices`) are now pre-loaded asynchronously during `NestFactory.create()`/`compile()` so `createNestApplication` stays synchronous. Our gateway tests depend on `SocketModule` being found (`@nestjs/websockets` installed); the suite passes on 12 except the listed failures, so it is found. |
| fa6d45da7 | #16369 | v12.0.0 | common,core,testing,… | build: migrate from cjs to esm | AFFECTS (verified OK) | `"type": "module"`, an `exports` map, `.js`-suffixed internal imports, `engines.node >= 20`. Runtime is fine: Bun loads them (bun-nest suite runs on 12: 420 pass / 7 fail, ../test-bun-nest-nest12-run1.log) and our packages are ESM already (packages/bun-nest/package.json:3). Not yet known: what a consumer's tsc sees through our shipped `dts/` (which import `@nestjs/core/adapters/http-adapter.js` etc.) once Nest's `exports` map applies, under `bundler`/`bun-init`/`node16` × `skipLibCheck`. **Resolved by the lead's measurement (2026-10-15):** in a scratch copy with the peers widened to `^11.0.0 \|\| ^12.0.0`, `bun scripts/consumer-check.ts packages/bun-nest --typescript 6.0.3` and `--typescript 5.9.3` both gave 11 spellings × 6 cells OK and the Bun runtime import OK, with the consumer verifiably on `@nestjs/core`/`common` 12.1.3; the `dts/` built against Nest 11 and 12 are byte-identical (`diff -r`). See the plan's §9.4. |
| fc405cb55 | #15525 | v12.0.0 | common | allow passing errorCode in HttpExceptionOptions | NO | New option; body gains `errorCode` only when set. |
| ef0984f43 | #15413 | v12.0.0 | common | generic for ArgumentMetadata | NO (verified) | Types; examples type-check clean on 12. |
| e0a9dfe37 | #15190 | v12.0.0 | common,microservices | nats v3 migration (touches file-type validator's `loadEsm`) | NO | Microservices; the validator change is an import form (still works under Bun, probe/filetype.ts). |
| d1c9ec5b3 | #14900 | v12.0.0 | core | call hooks by components hierarchy level | NO | Within one module, hooks now run by dependency depth instead of controllers→providers→…; the **kinds** still run in the same order, and `BunJobsApiModule`'s hooks are on its module class, which runs after its providers either way (jobs/BunJobsApiModule.ts:114-191). |
| 5be47a0a7 | #14753 | v12.0.0 | core | drop debugging leftover | NO | `base-exception-filter.ts` cleanup within the isHttpError series. |
| 591251a42 | #14753 | v12.0.0 | core | handle FastifyError as before | AFFECTS (test) | isHttpError series; see 788e886ae. |
| ccf416d15 | #14753 | v12.0.0 | core | make `isHttpError` check stricter | AFFECTS (test) | isHttpError series; see 788e886ae. |

### Batch E — the 11.x maintenance branch (v11.2.1..v11.2.7, `../commits-11.2-branch.tsv`)

The branch forked at v11.2.1. Of its 17 commits, only four touch core/common/testing, and three of those are backports of master commits above (matched by subject and diff, not by `git patch-id`: e12b47b90's code hunks equal 45485b542's, but 1dcbc259a also bumps `lerna.json`/lockfile and the 11.x specs use sinon where 12 uses vitest, so the patch-ids differ). Our lockfile has core/common 11.1.27 and platform-express 11.2.7 (repo11 mirror), so the 11.2.2/11.2.3 core fixes below are what a `^11` refresh would pull in today.

| hash | PR | first released | pkg | title | class | where / why |
|---|---|---|---|---|---|---|
| 35a29ccfe | — (direct) | v11.2.2 | core | instrument middleware fallback issue | AFFECTS (test, low) | Backport of 1dcbc259a (#17554). See the `instrument` rows (5adcd7a05, f94e9eb15): decorated `app.use()` handlers reach our `use()` (BunHttpAdapter.ts:1630-1680). |
| 4593b0ad3 | — (direct) | v11.2.2 | common,core,microservices | preserve middleware arity #17554 | AFFECTS (test, low) | Backport of f94e9eb15; on 11.x it also touches `common` (the `instrument` option interface). Arity matters to BunRouter's 4-arg error-handler detection. |
| 7ebaa889d | — (direct) | v11.2.2 | common,core,microservices | drop skip instrumentation — duplicated api | NO | Removes `instrument.skipInstrumentation` (11.2.x-only API) and passes `instanceDecorator` directly. We do not use `instrument`. |
| e12b47b90 | — (direct; issue #17562) | v11.2.3 | core | circular durable providers | NO | Backport of 45485b542; injector. |
| 8bd644e91 | — | v11.2.7 | socket.io,ws | keep the message stream alive when a handler throws | out of scope | websockets agent. |
| 2618406e7 | — | v11.2.7 | socket.io,ws | stop unserializable replies from crashing the process | out of scope | websockets agent. |
| fb8ecdbef | — | v11.2.6 | express | multer 2.4.0 [security] | out of scope | platform-express agent. |
| 58c3634b2 | — | v11.2.6 | express | map multer errors by code instead of message | out of scope | platform-express agent (bears on our `transformUploadException` parity, interceptors.ts:95). |
| dee4ed4db | — | v11.2.5 | microservices | harden the tcp transport | out of scope | microservices. |
| e9dcd4c7a | — | v11.2.4 | microservices | unserializable patterns | out of scope | microservices. |
| 5226fe084 | — | v11.2.4 | fastify | absolute-form request target middleware bypass | out of scope | fastify agent. (Worth asking the same question of BunRouter: is `GET http://host/path` matched on its path? Not a core change.) |
| c666d7f72, c07cfb0be, e91618cee, d5046225d, 2b36ee5fe, 7e65752ba | — | v11.2.7 … v11.2.2 | all | release commits | NO | Version bumps. |

## Appendix — bulk groups (full hash lists)

Counts are over the 579 first-parent commits v11.1.27..v12.1.3 (`../commits-pkgs.tsv`), except group R, which lists the release/readme commits among the 211 non-merge commits that touch core/common/testing. A first-parent commit touching `packages/core|common|testing` is never bulked: it is either a row above or (for a merge) expanded into its side commits, each a row above.

### R. Release and readme commits that touch core/common/testing (16) — NO
Version bumps in `package.json` (and `lerna.json`/lockfile) or the packages' `Readme.md`; no code. Note the two v12.1.2 release commits (8ab60aa1b, ab3fb3d5c) and that **v12.0.1** (4c751c503) and **v12.1.2** have no release notes in ../releases/.

| hash | tag | subject |
|---|---|---|
| 451462327 | v12.1.3 | chore(release): publish v12.1.3 release |
| 8ab60aa1b | v12.1.2 | chore(release): publish v12.1.2 release |
| ab3fb3d5c | v12.1.2 | chore(release): publish v12.1.2 release |
| 9feedffde | v12.1.1 | chore(release): publish v12.1.1 release |
| 6739656fa | v12.1.0 | chore(release): publish v12.1.0 release |
| 2dfba6805 | v12.1.0 | chore: update readme |
| 899dbe3a0 | v12.0.4 | chore(release): publish v12.0.4 release |
| 14151790e | v12.0.3 | chore(release): publish v12.0.3 release |
| ee168a569 | v12.0.2 | chore(release): publish v12.0.2 release |
| 4c751c503 | v12.0.1 | chore(release): publish v12.0.1 release |
| 6494a6c27 | v12.0.0 | chore(release): publish v12.0.0 release |
| 4535f43b4 | v11.2.1 | chore(release): publish v11.2.1 release |
| f2a7e4b1f | v11.2.0 | chore(release): publish v11.2.0 release |
| 03587a112 | v11.1.29 | chore(release): publish v11.1.29 release |
| 92bc05d95 | v11.1.29 | chore: update readme |
| dfaa37617 | v11.1.28 | chore(release): publish v11.1.28 release |

### S. `sample/` only (plus root package.json/lock when bumping a sample) (143)
NO — Nest's sample apps; nothing ships.

| hash | date | subject | paths |
|---|---|---|---|
| 812f72e52 | 2026-10-12 | chore(deps): update dependency prettier to v3.9.10 (#18107) | sample |
| 3972f76dd | 2026-10-12 | chore(deps): update dependency @nestjs/schematics to v12.0.7 (#18106) | sample |
| 957ec9aae | 2026-10-12 | chore(deps): update dependency @types/node to v24.19.2 (#18102) | sample |
| cb08d9ba6 | 2026-10-12 | fix(deps): update dependency @fastify/static to v10.1.6 (#18067) | package-lock.json,package.json,sample |
| 0c09c1af5 | 2026-10-12 | docs(samples): remove broken travis badges (#18099) | sample |
| 9bac121cb | 2026-10-12 | fix(deps): update dependency mercurius to v16.11.0 (#18062) | sample |
| f3628ba2e | 2026-10-12 | fix(deps): update dependency dotenv to v18.0.7 (#18068) | sample |
| 843ec0393 | 2026-10-12 | chore(sample): add file storage sample (#18092) | sample |
| b302d0d3e | 2026-10-12 | chore(deps): update dependency @types/node to v24.19.2 (#18070) | sample |
| d8e83a581 | 2026-10-12 | fix(deps): update dependency drizzle-orm to v0.45.4 (#18061) | sample |
| 48d3bda8c | 2026-10-09 | fix(deps): update dependency @grpc/grpc-js to v1.14.6 (#18057) | package-lock.json,package.json,sample |
| 88da667de | 2026-10-09 | fix(deps): update dependency @nestjs/webhooks to v0.0.2 (#18058) | sample |
| eefb569f6 | 2026-10-09 | fix(deps): update dependency @fastify/view to v12.0.1 (#18055) | package-lock.json,package.json,sample |
| a009d674e | 2026-10-08 | fix(deps): update dependency handlebars to v4.7.10 (#18037) | sample |
| 4fd3a5794 | 2026-10-08 | fix(deps): update dependency @nestjs/cache-manager to v12.0.1 (#18040) | sample |
| fac62647f | 2026-10-08 | fix(deps): update dependency @nestjs/outbox to v0.1.1 (#18042) | sample |
| 761dc2082 | 2026-10-08 | fix(deps): update dependency typeorm to v1.1.2 (#18038) | package-lock.json,package.json,sample |
| aa45aaa8c | 2026-10-08 | chore(deps): update dependency oxlint to v1.87.0 (#18017) | package-lock.json,package.json,sample |
| 7f2313b24 | 2026-10-08 | fix(deps): update dependency dotenv to v18.0.6 (#18036) | sample |
| 627d4fc8b | 2026-10-08 | chore(deps): update dependency supertest to v7.3.1 (#17992) | package-lock.json,package.json,sample |
| 756541030 | 2026-10-08 | chore(deps): update dependency @types/node to v24.19.1 (#17976) | sample |
| b5c18a1c1 | 2026-10-08 | fix(deps): update dependency mongoose to v9.11.1 (#18004) | package-lock.json,package.json,sample |
| 18e7b716c | 2026-10-08 | chore(sample): add webhooks sample (#18012) | sample |
| 1f6eba112 | 2026-10-08 | chore(sample): meaningful package name and description for every sample (#18009) | sample |
| 35142c3ec | 2026-10-02 | chore(deps): update vitest monorepo to v5.0.3 (#17899) | package-lock.json,package.json,sample |
| 085342778 | 2026-10-02 | fix(deps): update graphql-tools monorepo (#17967) | sample |
| 727c31d69 | 2026-10-01 | chore(deps): update mongo docker tag to v9 (#17968) | sample |
| 1de9f63fc | 2026-10-01 | chore(sample): use the outbox's first-party store in the outbox sample (#17969) | sample |
| 3b29e6481 | 2026-10-01 | fix(deps): update dependency pg to v8.23.1 (#17965) | sample |
| 96982b436 | 2026-10-01 | chore(deps): update dependency redis to v6.3.0 (#17948) | package-lock.json,package.json,sample |
| a14248d7e | 2026-10-01 | fix(deps): update dependency dotenv to v18.0.5 (#17964) | sample |
| 9996f7e2e | 2026-09-30 | fix(deps): update dependency mongoose to v9.10.3 (#17928) | package-lock.json,package.json,sample |
| e1e0512bd | 2026-09-30 | fix(deps): update dependency mysql2 to v3.24.5 (#17929) | package-lock.json,package.json,sample |
| 86a3426da | 2026-09-29 | fix(deps): update dependency mongodb to v7.7.0 (#17914) | sample |
| d23ae81d0 | 2026-09-29 | fix(deps): update nest-graphql monorepo to v14.0.3 (#17909) | package-lock.json,package.json,sample |
| fc0d238d0 | 2026-09-29 | fix(deps): update dependency @nestjs/typeorm to v12.0.2 (#17900) | package-lock.json,package.json,sample |
| 250dcd77d | 2026-09-29 | chore(deps): update dependency oxlint to v1.86.0 (#17912) | package-lock.json,package.json,sample |
| ccaeccc11 | 2026-09-29 | chore(deps): update dependency @types/multer to v2.3.0 (#17910) | sample |
| 27115d1ec | 2026-09-28 | chore(deps): update vitest monorepo to v5.0.2 (#17880) | package-lock.json,package.json,sample |
| 0288e4d7e | 2026-09-28 | chore(deps): update dependency @types/node to v24.19.0 (#17886) | sample |
| 3d12829e2 | 2026-09-28 | fix(deps): update dependency mercurius to v16.10.1 (#17894) | sample |
| 1c74231c9 | 2026-09-28 | fix(deps): update dependency dotenv to v18.0.4 (#17882) | sample |
| 4d8088e21 | 2026-09-28 | fix(deps): update dependency @fastify/static to v10.1.5 (#17889) | package-lock.json,package.json,sample |
| 6cef34e23 | 2026-09-28 | chore(sample): add transactional outbox sample (#17890) | sample |
| 0b3fdf033 | 2026-09-24 | chore(deps): update dependency prettier to v3.9.9 (#17852) | sample |
| f4798d303 | 2026-09-24 | fix(deps): update nest-graphql monorepo to v14.0.2 (#17855) | package-lock.json,package.json,sample |
| 1c7771947 | 2026-09-24 | chore(deps): update dependency @nestjs/cli to v12.0.6 (#17864) | sample |
| ff91f1c75 | 2026-09-23 | fix(deps): update dependency @nestjs/swagger to v12.0.2 (#17853) | sample |
| 7043a3af7 | 2026-09-23 | chore(deps): update dependency @nestjs/schematics to v12.0.5 (#17850) | sample |
| 039ec9bd2 | 2026-09-23 | sample: rewrite the dynamic modules sample around an id generator | sample |
| 7f5ced1b1 | 2026-09-23 | chore(deps): update dependency @nestjs/cli to v12.0.5 (#17842) | sample |
| 56a00a20b | 2026-09-23 | fix(deps): update dependency dotenv to v18.0.3 (#17843) | sample |
| 7948d5b6a | 2026-09-23 | fix(deps): update dependency mongoose to v9.10.2 (#17844) | package-lock.json,package.json,sample |
| f9ec5955f | 2026-09-22 | chore(deps): update dependency supertest to v7.3.0 (#17837) | package-lock.json,package.json,sample |
| 8c4510837 | 2026-09-22 | fix(deps): update dependency dotenv to v18.0.2 (#17831) | sample |
| 920089a9a | 2026-09-22 | chore(deps): update dependency oxlint to v1.85.0 (#17832) | package-lock.json,package.json,sample |
| 3385cf0cb | 2026-09-20 | chore(deps): update dependency @types/node to v24.13.6 (#17814) | sample |
| d6e41dadd | 2026-09-20 | chore(deps): update dependency webpack to v5.111.1 (#17811) | sample |
| de316c631 | 2026-09-20 | fix(deps): update dependency dotenv to v18.0.1 (#17817) | sample |
| 1d7c62813 | 2026-09-18 | fix(deps): update dependency dotenv to v18 (#17807) | sample |
| f9dd0b010 | 2026-09-18 | chore(deps): update dependency prettier to v3.9.8 (#17805) | sample |
| c27ceff68 | 2026-09-18 | fix(deps): update dependency @grpc/grpc-js to v1.14.5 (#17806) | package-lock.json,package.json,sample |
| afab2c7b7 | 2026-09-17 | fix(deps): update nest-graphql monorepo to v14.0.1 (#17795) | package-lock.json,package.json,sample |
| ab2e9e812 | 2026-09-17 | fix(deps): update dependency @fastify/static to v10.1.4 (#17792) | package-lock.json,package.json,sample |
| 5c0dc8b34 | 2026-09-17 | chore(deps): update dependency prettier to v3.9.7 (#17789) | sample |
| a2493216d | 2026-09-17 | chore(deps): update nest monorepo to v12.0.3 (#17790) | sample |
| bcfec8312 | 2026-09-16 | fix(deps): update dependency zod to v4.6.5 (#17776) | sample |
| 348ef94c3 | 2026-09-16 | chore(deps): update dependency @types/node to v24.13.5 (#17777) | sample |
| 37355b2f1 | 2026-09-16 | chore(deps): update dependency vitest to v5 (#17778) | sample |
| c939a381e | 2026-09-15 | fix(deps): update dependency valibot to v1.5.0 (#17763) | sample |
| 6a7ae51de | 2026-09-15 | fix(deps): update dependency mongoose to v9.10.1 (#17756) | package.json,sample |
| 83170c559 | 2026-09-15 | fix(deps): update dependency @apollo/subgraph to v2.15.1 (#17750) | sample |
| 4c5fac01d | 2026-09-15 | chore(deps): update dependency webpack to v5.111.0 (#17748) | sample |
| 2ed228c73 | 2026-09-14 | chore(deps): update nest monorepo (#17735) | sample |
| 488222359 | 2026-09-14 | fix(deps): update graphql-tools monorepo (#17736) | sample |
| e310c8440 | 2026-09-14 | fix(deps): update dependency hbs to v4.3.1 (#17733) | sample |
| b433e0249 | 2026-09-14 | chore(deps): update dependency oxlint to v1.83.0 (#17730) | package.json,sample |
| 23b6356d3 | 2026-09-14 | fix(deps): update dependency @nestjs/jwt to v12.0.2 (#17732) | sample |
| 714d62c3d | 2026-09-14 | fix(deps): update dependency @nestjs/schedule to v12.0.2 (#17727) | sample |
| c8396a95c | 2026-09-14 | fix(deps): update dependency @nestjs/event-emitter to v12.0.1 (#17726) | sample |
| 319d3ecc3 | 2026-09-14 | chore(deps): update dependency @nestjs/schematics to v12.0.1 (#17724) | sample |
| d841b078c | 2026-09-14 | fix(deps): update dependency typeorm to v1.1.1 (#17659) | package.json,sample |
| 63000cbd8 | 2026-09-14 | fix(deps): update dependency mysql2 to v3.24.4 (#17658) | package.json,sample |
| db889fec0 | 2026-09-14 | chore(deps): update dependency oxlint to v1.82.0 (#17662) | package.json,sample |
| f5d69016c | 2026-09-14 | chore(deps): update dependency @types/node to v24.13.4 (#17704) | sample |
| e0bf38722 | 2026-09-03 | chore(deps): update dependency webpack to v5.110.3 | sample |
| 0ff9d8609 | 2026-08-29 | fix(deps): update dependency zod to v4.5.4 | sample |
| 626270193 | 2026-08-30 | chore(deps): update dependency webpack to v5.110.2 | sample |
| e879be1e1 | 2026-08-28 | fix(deps): update dependency @apollo/subgraph to v2.15.0 | sample |
| c1b0254b7 | 2026-08-29 | fix(deps): update dependency zod to v4.5.2 | sample |
| 7f40a4c2f | 2026-08-28 | chore(deps): update dependency webpack-cli to v7.2.3 | sample |
| 235b47bd9 | 2026-08-28 | fix(deps): update dependency @nestjs/swagger to v12.0.1 | sample |
| 6312d6af9 | 2026-08-28 | fix(deps): update dependency @nestjs/typeorm to v12.0.1 | package.json,sample |
| 10751605e | 2026-08-28 | chore(deps): update dependency webpack to v5.110.1 | sample |
| a333a9dae | 2026-08-27 | sample: upgrade to v12 | sample |
| a00d50134 | 2026-08-26 | fix(deps): update dependency zod to v4 | sample |
| bb381aedc | 2026-08-25 | Merge remote-tracking branch 'refs/remotes/origin/master' | package.json,sample |
| 55425779a | 2026-08-21 | chore(deps): update dependency oxlint to v1.79.0 | package.json,sample |
| f130f9127 | 2026-08-21 | chore(deps): update dependency sqlite3 to v6 | sample |
| 576cea255 | 2026-08-21 | fix(deps): update nest-graphql monorepo to v13.4.5 | package.json,sample |
| f7d70f74b | 2026-08-21 | fix(deps): update dependency mysql2 to v3.23.4 | package.json,sample |
| 7af7142ba | 2026-08-20 | fix(deps): update dependency mongoose to v9.9.3 | package.json,sample |
| 2fe907a90 | 2026-08-19 | fix(deps): update apollo graphql packages to v2.14.4 | sample |
| 8de46480d | 2026-08-19 | chore(deps): update vitest monorepo to v4.1.11 | package.json,sample |
| 0384f2269 | 2026-08-17 | Merge pull request #17517 from nestjs/renovate/supertest-7.x | sample |
| 003b4a56a | 2026-08-17 | Merge pull request #17516 from nestjs/renovate/sqlite3-5.x | sample |
| 841df8792 | 2026-08-17 | Merge pull request #17515 from nestjs/renovate/mongoose-9.x | package.json,sample |
| 31ad389d6 | 2026-08-17 | Merge pull request #17514 from nestjs/renovate/nestjs-swagger-11.x | sample |
| 8f2d169be | 2026-08-17 | chore: resolve conflicts | package-lock.json,package.json,sample |
| 445432fb5 | 2026-08-17 | Merge pull request #17510 from nestjs/renovate/webpack-5.x | sample |
| 16b38a7f4 | 2026-08-17 | Merge pull request #17511 from nestjs/renovate/class-validator-0.x | sample |
| 6049db1cd | 2026-08-17 | Merge pull request #17495 from nestjs/renovate/node-24.x | sample |
| 58028b48e | 2026-08-17 | Merge pull request #17497 from nestjs/renovate/prettier-3.x | sample |
| 4634d93a2 | 2026-08-17 | Merge pull request #17498 from nestjs/renovate/ts-loader-9.x | sample |
| 3fbba0735 | 2026-08-16 | Merge pull request #17490 from nestjs/renovate/rimraf-6.x | sample |
| 581b56cff | 2026-08-16 | Merge pull request #17488 from nestjs/renovate/typescript-6.x | sample |
| 49b2d93fd | 2026-08-16 | Merge pull request #17491 from nestjs/renovate/zod-3.x | sample |
| 605deb9ec | 2026-08-16 | Merge pull request #17489 from nestjs/renovate/vitest-monorepo | package.json,sample |
| edab7422e | 2026-08-14 | Merge pull request #17482 from nestjs/renovate/npm-nestjs-core-vulnerability | sample |
| c209748f3 | 2026-08-14 | Merge pull request #17483 from nestjs/renovate/npm-valibot-vulnerability | sample |
| a112f3fbd | 2026-08-14 | Merge pull request #17472 from nestjs/renovate/graphql-tools-monorepo | sample |
| 67ce40ecf | 2026-08-14 | Merge pull request #17461 from nestjs/renovate/redis-6.x | package.json,sample |
| deec03c6d | 2026-08-14 | Merge pull request #17445 from nestjs/renovate/fastify-static-10.x | sample |
| d5e06caa8 | 2026-08-11 | Merge pull request #17457 from nestjs/renovate/nest-graphql-monorepo | package.json,sample |
| 0197f6937 | 2026-08-11 | Merge pull request #17420 from nestjs/renovate/mysql2-3.x | package.json,sample |
| 2bf91152f | 2026-08-11 | Merge pull request #17383 from nestjs/renovate/globals-17.x | sample |
| 626330429 | 2026-08-11 | Merge pull request #17446 from nestjs/renovate/nestjs-bull-11.x | sample |
| 3cf5358d1 | 2026-08-10 | Merge pull request #17376 from nestjs/renovate/graphql-query-complexity-2.x | sample |
| e270ef54e | 2026-07-15 | chore: update samples deps | sample |
| 85ad65e18 | 2026-07-15 | Merge pull request #17325 from nestjs/renovate/mercurius-16.x | sample |
| 0a368c136 | 2026-07-14 | Merge pull request #17316 from nestjs/renovate/typeorm-0.x | package.json,sample |
| eaf73ca40 | 2026-07-13 | Merge pull request #17300 from nestjs/renovate/nest-monorepo | sample |
| cf071b2b9 | 2026-07-13 | Merge pull request #17298 from nestjs/renovate/graphql-tools-monorepo | sample |
| 926e3a4dc | 2026-07-10 | Merge pull request #17296 from nestjs/renovate/fastify-static-9.x | sample |
| b047c2441 | 2026-07-10 | Merge pull request #17297 from nestjs/renovate/mongodb-7.x | sample |
| 33acba350 | 2026-07-10 | Merge pull request #17290 from nestjs/renovate/prettier-3.x | sample |
| 8a9a31988 | 2026-07-10 | Merge pull request #17278 from nestjs/renovate/mysql2-3.x | sample |
| f9bc3dbfc | 2026-07-10 | Merge pull request #17276 from nestjs/renovate/node-24.x | sample |
| b84f1bf61 | 2026-07-08 | Merge pull request #17258 from nestjs/renovate/webpack-5.x | sample |
| 816ef76dd | 2026-07-08 | chore: push unsaved files with git conflicts | sample |
| 09908e3e0 | 2026-06-22 | Merge remote-tracking branch 'origin/renovate/nestjs-typeorm-11.x' | package.json,sample |
| 092750e3b | 2026-06-22 | Merge pull request #17153 from nestjs/renovate/ts-loader-9.x | sample |
| ad909b977 | 2026-06-22 | Merge pull request #17157 from nestjs/dependabot/npm_and_yarn/sample/16-gateways-ws/ws-8.21.0 | sample |

### I. `integration/` only (9)
NO — Nest's own e2e tests; nothing ships.

| hash | date | subject | paths |
|---|---|---|---|
| 7036f3dc0 | 2026-10-12 | test(microservices): cover a mid-pattern rmq '#' with a real broker (#18105) | integration |
| 2731c1805 | 2026-10-09 | test: listen on 127.0.0.1 before supertest sends requests (#18064) | integration |
| c845dd065 | 2026-09-29 | test(microservices): cover tcp reconnect with a real server (#17892) | integration |
| 10f8eb1e3 | 2026-09-17 | test(testing): add e2e tests for http query method lifecycle (#17798) | integration |
| d57fba017 | 2026-09-17 | chore(deps): update confluentinc/cp-kafka docker tag to v8.3.2 (#17787) | integration |
| 85af8f8b4 | 2026-09-17 | chore(deps): update confluentinc/cp-zookeeper docker tag to v7.9.10 (#17788) | integration |
| 96e1f1a67 | 2026-08-14 | Merge pull request #17310 from brayanjeshua/feat/query-method-e2e | integration |
| 5df8d9d41 | 2026-08-10 | Merge pull request #17443 from nestjs/renovate/confluentinc-cp-zookeeper-7.x | integration |
| 2cf1b9ec2 | 2026-08-10 | Merge pull request #17442 from nestjs/renovate/confluentinc-cp-kafka-8.x | integration |

### D. Dependency bumps of the repo root / tools / samples (dependabot, renovate, `chore(deps)`), no package code (137)
NO — devDependencies of the Nest monorepo; not in any published package's dependencies.

| hash | date | subject | paths |
|---|---|---|---|
| 828d5a990 | 2026-10-12 | chore(deps): update dependency prettier to v3.9.10 (#18103) | package-lock.json |
| 8574e3348 | 2026-10-12 | chore(deps): update dependency @fastify/multipart to v10.1.3 (#18045) | package-lock.json,package.json |
| 681a77505 | 2026-10-12 | chore(deps): update dependency @types/node to v26.6.5 (#18097) | package-lock.json,package.json |
| 0f3977563 | 2026-10-12 | chore(deps): update dependency fastify-plugin to v6.0.1 (#18098) | package-lock.json,package.json |
| 1e91fe9ff | 2026-10-09 | chore(deps): update dependency vite to v8.3.4 (#18041) | package-lock.json,package.json |
| 49a2436c1 | 2026-10-09 | chore(deps): update github/codeql-action action to v4.38.3 (#18047) | .github |
| 14c427fc1 | 2026-10-08 | chore(deps): update dependency typescript-eslint to v8.71.1 (#18018) | package-lock.json,package.json |
| bc357305f | 2026-10-08 | chore(deps): update dependency vite to v8.3.3 (#18035) | package-lock.json,package.json |
| f4d6388ee | 2026-10-08 | chore(deps): update dependency @types/node to v26.6.4 (#17977) | package-lock.json,package.json |
| 730f4ab0f | 2026-10-08 | chore(deps-dev): bump socket.io-client from 4.8.3 to 4.8.4 (#18014) | package-lock.json,package.json |
| 25d5254a6 | 2026-10-08 | chore(deps-dev): bump @types/ws from 8.18.1 to 8.18.2 (#18022) | package-lock.json,package.json |
| 63632033c | 2026-10-08 | chore(deps): bump @fastify/busboy from 3.2.0 to 3.2.2 (#18031) | package-lock.json |
| 1b1a7ec17 | 2026-10-08 | chore(deps-dev): bump nx from 23.1.1 to 23.3.0 (#18033) | package-lock.json |
| fd9269567 | 2026-10-08 | chore(deps): bump fast-uri (#17933) | package-lock.json |
| 1d831405b | 2026-10-08 | chore(deps): bump proxy-addr from 2.0.7 to 2.0.8 in /tools/benchmarks (#18028) | tools |
| b0d87b0fc | 2026-10-08 | chore(deps): bump proxy-addr from 2.0.7 to 2.0.8 (#18030) | package-lock.json |
| 83de2de2f | 2026-10-08 | chore(deps-dev): bump postcss-selector-parser from 7.1.5 to 7.1.6 (#18032) | package-lock.json |
| bf7732e02 | 2026-10-08 | chore(deps-dev): bump source-map-js from 1.2.1 to 1.2.2 (#18034) | package-lock.json |
| 7fb52e7f4 | 2026-10-01 | chore(deps): update dependency vite to v8.3.2 (#17970) | package-lock.json,package.json |
| e20f53eef | 2026-09-30 | chore(deps-dev): bump undici from 6.28.0 to 6.29.0 (#17935) | package-lock.json |
| 4a38810b2 | 2026-09-30 | chore(deps): bump engine.io from 6.6.9 to 6.6.11 (#17934) | package-lock.json |
| a24bb137b | 2026-09-30 | fix(deps): update nest monorepo to v12.1.2 (#17936) | sample,tools |
| 24099fbab | 2026-09-30 | chore(deps): bump ip-address from 10.7.0 to 10.7.2 (#17932) | package-lock.json |
| 97f308c4e | 2026-09-30 | chore(deps): bump fast-uri from 3.1.7 to 3.1.8 in /tools/benchmarks (#17931) | tools |
| 8843023c7 | 2026-09-29 | chore(deps): update dependency typescript-eslint to v8.71.0 (#17913) | package-lock.json,package.json |
| c4df6dc2a | 2026-09-29 | chore(deps): update dependency amqplib to v2.2.0 (#17911) | package-lock.json,package.json |
| 30207acc9 | 2026-09-29 | fix(deps): update nest monorepo (#17879) | sample,tools |
| e17ee5a1a | 2026-09-28 | chore(deps): update dependency @types/node to v26.6.3 (#17885) | package-lock.json,package.json |
| 4654802ce | 2026-09-28 | chore(deps): update dependency lint-staged to v17.6.0 (#17897) | package-lock.json,package.json |
| fc15b0bf9 | 2026-09-28 | chore(deps): update dependency amqplib to v2.1.0 (#17896) | package-lock.json,package.json |
| 89532ff39 | 2026-09-25 | chore(deps): update dependency vite to v8.3.1 (#17877) | package-lock.json,package.json |
| 9f8063486 | 2026-09-24 | chore(deps): update github/codeql-action action to v4.38.2 (#17868) | .github |
| 490244efa | 2026-09-23 | fix(deps): update nest monorepo to v12.1.0 (#17856) | sample,tools |
| d72d568cb | 2026-09-23 | chore(deps): update dependency prettier to v3.9.9 (#17851) | package-lock.json |
| f4e02f61b | 2026-09-23 | chore(deps): update dependency @fastify/multipart to v10.1.2 (#17841) | package-lock.json,package.json |
| 0845d912f | 2026-09-22 | fix(deps): update nest monorepo to v12.0.4 (#17825) | sample,tools |
| 7252e1505 | 2026-09-22 | chore(deps): update dependency eventsource to v5.1.2 (#17829) | package-lock.json,package.json |
| 3f9ea5e94 | 2026-09-22 | chore(deps): update dependency typescript-eslint to v8.70.1 (#17830) | package-lock.json,package.json |
| 6037ad9e6 | 2026-09-20 | chore(deps): update dependency @types/node to v26.6.2 (#17815) | package-lock.json,package.json |
| bac56aed0 | 2026-09-20 | chore(deps): update github/codeql-action action to v4.38.1 (#17812) | .github |
| a359b7b8b | 2026-09-20 | chore(deps): update commitlint monorepo to v21.2.3 (#17820) | package-lock.json,package.json |
| e548e63f9 | 2026-09-20 | chore(deps): update dependency tsx to v4.23.15 (#17823) | package-lock.json,package.json |
| 907e0effc | 2026-09-18 | chore(deps): update dependency prettier to v3.9.8 (#17804) | package-lock.json |
| f3fb64a59 | 2026-09-17 | chore(deps): update dependency mqtt to v5.16.0 (#17796) | package-lock.json,package.json |
| fc5c237f7 | 2026-09-17 | chore(deps): update dependency fastify to v5.12.5 (#17782) | tools |
| ebcc68575 | 2026-09-17 | chore(deps): update dependency prettier to v3.9.7 (#17783) | package-lock.json |
| d59ad3a1d | 2026-09-16 | chore(deps): update dependency @types/node to v26.6.1 (#17775) | package-lock.json,package.json |
| 774941ebe | 2026-09-15 | chore(deps): update vitest monorepo to v5.0.1 (#17767) | package-lock.json,package.json |
| 8f1d62b8e | 2026-09-15 | fix(deps): update nest monorepo to v12.0.3 (#17768) | sample,tools |
| f76e96f9b | 2026-09-15 | chore(deps): sync package-lock.json with package.json (#17764) | package-lock.json |
| 2e353fa2a | 2026-09-15 | chore: let renovate resolve the lockfile with legacy peer deps (#17765) | renovate.json |
| dcd63dc63 | 2026-09-15 | chore(deps): update dependency vite to v8.3.0 (#17747) | package.json |
| 76d079a66 | 2026-09-15 | fix(deps): update dependency ansis to v4.4.0 (#17752) | package.json |
| 90c270261 | 2026-09-15 | chore(deps): bump ip-address from 10.1.0 to 10.7.0 (#17742) | package-lock.json |
| e95ee3ab4 | 2026-09-15 | chore(deps): update github/codeql-action action to v4.38.0 (#17751) | .github |
| 61158ebe5 | 2026-09-14 | fix(deps): update nest monorepo to v12.0.2 (#17740) | sample,tools |
| ca6b251b4 | 2026-09-14 | chore(deps): update dependency lint-staged to v17.5.1 (#17741) | package.json |
| 26e62a9bc | 2026-09-14 | chore(deps-dev): bump vitest coverage providers to 5.0.0 | package-lock.json,package.json |
| 9184c835a | 2026-09-14 | chore(deps): update dependency @types/node to v26.5.1 (#17660) | package.json |
| 849ec2cf4 | 2026-09-14 | chore(deps): update dependency typescript-eslint to v8.70.0 (#17663) | package.json |
| 8afaa099f | 2026-09-14 | chore(deps-dev): bump vitest from 4.1.11 to 5.0.0 (#17719) | package-lock.json,package.json |
| 4099e76e6 | 2026-09-14 | chore(deps): update dependency fastify to v5.12.4 (#17725) | tools |
| 8640de1d7 | 2026-09-14 | chore(deps-dev): bump @types/node from 26.4.0 to 26.4.1 (#17721) | package-lock.json,package.json |
| f4f6d5985 | 2026-09-14 | chore(deps-dev): bump @fastify/middie from 9.3.3 to 9.3.4 (#17718) | package-lock.json,package.json |
| fb70f1807 | 2026-09-14 | chore(deps-dev): bump mysql2 from 3.24.2 to 3.24.3 (#17717) | package-lock.json,package.json |
| e2ca9d5f2 | 2026-09-14 | chore(deps-dev): bump oxlint from 1.80.0 to 1.81.0 (#17716) | package-lock.json,package.json |
| 08ffaba7d | 2026-09-14 | chore(deps): bump fast-uri (#17652) | package-lock.json |
| d29c56d88 | 2026-09-14 | chore(deps-dev): bump browserslist from 4.28.2 to 4.28.8 (#17646) | package-lock.json |
| 70fed6e24 | 2026-09-14 | chore(deps): bump engine.io from 6.6.6 to 6.6.9 (#17643) | package-lock.json |
| 3ed32fefa | 2026-09-14 | chore(deps): bump qs from 6.15.2 to 6.16.0 in /tools/benchmarks (#17654) | tools |
| 0d8b66950 | 2026-09-14 | chore(deps): bump fast-uri in /tools/benchmarks (#17651) | tools |
| 03a81a4a5 | 2026-09-07 | chore(deps-dev): bump @nats-io/transport-node from 3.3.1 to 3.4.0 | package-lock.json |
| 85d1aade8 | 2026-09-07 | chore(deps-dev): bump @nestjs/mongoose from 11.0.4 to 12.0.0 | package-lock.json |
| 4cf4ffa9a | 2026-08-30 | chore(deps): update dependency tsx to v4.23.13 | package.json |
| 55b283292 | 2026-08-28 | chore(deps): update dependency @nestjs/mongoose to v12 | package.json |
| 16b21b5d3 | 2026-08-28 | chore(deps): update nest-graphql monorepo to v14 | package.json |
| cd5ee1291 | 2026-08-27 | chore(deps): update dependency lint-staged to v17.4.1 | package.json |
| 7516c5b53 | 2026-08-28 | fix(deps): update nest monorepo to v12 | tools |
| 5c78b3c6c | 2026-08-27 | chore(deps): update dependency @types/node to v26.4.0 | package.json |
| 9adc655e5 | 2026-08-25 | chore(deps): update dependency typescript-eslint to v8.68.0 | package.json |
| 1dac5715f | 2026-08-25 | fix(deps): update nest monorepo to v11.2.2 | sample,tools |
| 4c38a5ab1 | 2026-08-21 | chore(deps): update github/codeql-action action to v4.37.8 | .github |
| dd75d7bd8 | 2026-08-21 | fix(deps): update dependency uuid to v14.0.2 | package.json |
| a07c3d02b | 2026-08-21 | chore(deps): update dependency vite to v8.2.2 | package.json |
| 25ccf8f3c | 2026-08-19 | chore(deps): update dependency lerna to v10.0.1 | package.json |
| 122fde3d6 | 2026-08-19 | chore(deps): update dependency fastify to v5.12.1 | tools |
| 35a79dad3 | 2026-08-17 | chore: upgrade vitest | package-lock.json,package.json,vitest.config.coverage.mts,vitest.config.integration.mts,vitest.config.mts |
| 8b677b386 | 2026-08-17 | Merge pull request #17504 from nestjs/dependabot/npm_and_yarn/oxlint-1.77.0 | package-lock.json,package.json |
| d46850892 | 2026-08-16 | Merge pull request #17487 from nestjs/renovate/fastify-multipart-10.x | package.json |
| 41c1429e2 | 2026-08-16 | Merge pull request #17475 from nestjs/renovate/typescript-eslint-monorepo | package.json |
| 1ff305176 | 2026-08-16 | Merge pull request #17494 from nestjs/renovate/nest-monorepo | sample,tools |
| 61b035108 | 2026-08-15 | Merge pull request #17484 from nestjs/dependabot/npm_and_yarn/multi-1964815626 | package-lock.json,package.json |
| 328391fc5 | 2026-08-15 | Merge pull request #17480 from nestjs/dependabot/npm_and_yarn/vite-8.2.1 | package-lock.json |
| 1aa730df9 | 2026-08-14 | Merge pull request #17373 from nestjs/dependabot/npm_and_yarn/prettier-3.9.6 | package-lock.json |
| d56f8bc2b | 2026-08-14 | Merge pull request #17479 from nestjs/dependabot/npm_and_yarn/fast-uri-3.1.5 | package-lock.json |
| 1883f8e85 | 2026-08-14 | Merge pull request #17481 from nestjs/renovate/npm-vite-vulnerability | package.json |
| 56333a42d | 2026-08-14 | Merge pull request #17473 from nestjs/renovate/fastify-5.x-lockfile | tools |
| 42f0cfdef | 2026-08-14 | Merge pull request #17471 from nestjs/renovate/github-codeql-action-4.x | .github |
| 25b1a2f76 | 2026-08-14 | Merge pull request #17388 from nestjs/renovate/node-26.x | package.json |
| eb85032ed | 2026-08-14 | Merge pull request #17468 from nestjs/renovate/conventional-changelog-8.x | package.json |
| 11ecc4415 | 2026-08-14 | Merge pull request #17467 from nestjs/renovate/commitlint-monorepo | package.json |
| 451ca3783 | 2026-08-14 | Merge pull request #17466 from nestjs/dependabot/npm_and_yarn/fastify/static-10.1.3 | package-lock.json,package.json |
| 61bb847f5 | 2026-08-11 | Merge pull request #17456 from nestjs/renovate/nest-monorepo | sample,tools |
| 9a064ccaf | 2026-08-11 | Merge pull request #17453 from nestjs/renovate/conventional-changelog-8.x | package.json |
| da28539b2 | 2026-08-11 | Merge pull request #17417 from nestjs/dependabot/npm_and_yarn/tools/benchmarks/fast-uri-3.1.5 | tools |
| bc7096a52 | 2026-08-11 | Merge pull request #17426 from nestjs/renovate/eventsource-4.x | package.json |
| 07641b44b | 2026-08-11 | Merge pull request #17448 from nestjs/dependabot/npm_and_yarn/ioredis-6.0.0 | package-lock.json,package.json |
| 52ff75fd5 | 2026-08-10 | Merge pull request #17444 from nestjs/renovate/fastify-5.x-lockfile | tools |
| 3747ff69a | 2026-08-10 | Merge pull request #17433 from nestjs/renovate/conventional-changelog-8.x | package.json |
| f57b38d8f | 2026-08-10 | Merge pull request #17413 from nestjs/dependabot/npm_and_yarn/ip-address-10.4.0 | package-lock.json |
| bac7b27d2 | 2026-08-10 | Merge pull request #17437 from nestjs/dependabot/npm_and_yarn/lint-staged-17.3.0 | package-lock.json,package.json |
| d58010d3e | 2026-08-10 | Merge pull request #17438 from nestjs/dependabot/npm_and_yarn/globals-17.9.0 | package-lock.json,package.json |
| 19cabcd3e | 2026-08-10 | Merge pull request #17440 from nestjs/dependabot/npm_and_yarn/redis-6.2.0 | package-lock.json,package.json |
| f06cc31fe | 2026-08-10 | Merge pull request #17441 from nestjs/dependabot/npm_and_yarn/mongoose-9.9.1 | package-lock.json,package.json |
| c3bc75c97 | 2026-08-07 | Merge pull request #17427 from nestjs/renovate/fastify-5.x-lockfile | tools |
| 4e3b42d92 | 2026-08-06 | Merge pull request #17414 from nestjs/dependabot/npm_and_yarn/mysql2-3.23.2 | package-lock.json,package.json |
| bd07ee335 | 2026-08-06 | Merge pull request #17423 from nestjs/renovate/github-codeql-action-4.x | .github |
| 484116412 | 2026-08-06 | Merge pull request #17425 from nestjs/dependabot/npm_and_yarn/lerna-10.0.0 | package-lock.json,package.json |
| 38cd2caa9 | 2026-08-06 | Merge pull request #17424 from nestjs/dependabot/npm_and_yarn/types/node-26.1.2 | package-lock.json,package.json |
| 6bedfc76d | 2026-07-15 | Merge pull request #17323 from nestjs/dependabot/npm_and_yarn/types/supertest-7.2.1 | package-lock.json,package.json |
| 08c0ce672 | 2026-07-15 | Merge pull request #17321 from nestjs/dependabot/npm_and_yarn/mysql2-3.23.0 | package-lock.json,package.json |
| 32b27d20a | 2026-07-13 | Merge pull request #17280 from nestjs/renovate/fastify-multipart-10.x | package.json |
| a855a4f02 | 2026-07-10 | Merge pull request #17291 from nestjs/dependabot/npm_and_yarn/conventional-changelog-8.1.0 | package-lock.json,package.json |
| 177148a6a | 2026-07-10 | Merge pull request #17283 from nestjs/dependabot/npm_and_yarn/types/node-26.1.1 | package-lock.json,package.json |
| 034ea53fe | 2026-07-10 | Merge pull request #17286 from nestjs/dependabot/npm_and_yarn/fastify/static-9.3.0 | package-lock.json,package.json |
| 8bfdabda7 | 2026-07-10 | Merge pull request #17284 from nestjs/dependabot/npm_and_yarn/commitlint/cli-21.2.1 | package-lock.json,package.json |
| bf585ad6c | 2026-07-10 | Merge pull request #17293 from nestjs/dependabot/npm_and_yarn/fast-json-stringify-7.0.1 | package-lock.json,package.json |
| 0be127a44 | 2026-07-09 | Merge pull request #17279 from nestjs/renovate/nest-monorepo | sample,tools |
| d2585cf04 | 2026-07-08 | Merge pull request #17266 from nestjs/dependabot/npm_and_yarn/mqtt-5.15.2 | package-lock.json |
| 4ee70aa88 | 2026-07-08 | Merge pull request #17272 from nestjs/renovate/mqtt-5.x | package.json |
| 023b04474 | 2026-06-22 | Merge pull request #17149 from nestjs/renovate/body-parser-2.x | package.json |
| 548621736 | 2026-06-22 | Merge pull request #17158 from nestjs/dependabot/npm_and_yarn/mongoose-9.7.1 | package-lock.json,package.json |
| 5b0f2346c | 2026-06-22 | Merge pull request #17156 from nestjs/dependabot/npm_and_yarn/tools/benchmarks/form-data-4.0.6 | tools |
| f23f93374 | 2026-06-22 | Merge pull request #17166 from nestjs/dependabot/npm_and_yarn/types/node-26.0.0 | package-lock.json,package.json |
| 6246635da | 2026-06-22 | Merge pull request #17142 from nestjs/dependabot/npm_and_yarn/tmp-0.2.7 | package-lock.json |
| 255c77534 | 2026-06-15 | Merge pull request #17140 from nestjs/renovate/nest-monorepo | sample,tools |
| 8f1cfd314 | 2026-06-15 | Merge pull request #17139 from nestjs/renovate/nest-monorepo | sample,tools |

### T. CI, tooling and repo docs only (`.github`, `scripts`, vitest configs, `Readme.md`, `CONTRIBUTING.md`, merges of origin/master touching only those) (13)
NO — repository tooling.

| hash | date | subject | paths |
|---|---|---|---|
| 3f56db32f | 2026-09-25 | test: re-enable typeorm, mongoose and graphql schema-first suites (#17875) | vitest.config.integration.mts |
| 8e03a7dee | 2026-09-16 | docs: add an observability section to the readme | Readme.md |
| 8f0d7bbf6 | 2026-09-14 | chore: add workflow to flag malicious pull request content (#17714) | .github |
| 75958d7ab | 2026-08-29 | fix(scripts): stop hiding build failures in the setup scripts | CONTRIBUTING.md,scripts |
| 42681b156 | 2026-08-27 | Merge remote-tracking branch 'refs/remotes/origin/master' | .github |
| 66e89ffc3 | 2026-08-26 | Merge remote-tracking branch 'refs/remotes/origin/master' | integration,package.json,sample,tools |
| 2721c3eeb | 2026-08-15 | Merge pull request #17486 from yzxcj797/fix/dead-dev-doc-link | CONTRIBUTING.md |
| aecd4431f | 2026-07-14 | Merge pull request #17311 from hjc0930/master | Readme.md |
| f2938487c | 2026-07-13 | Update readme_zh.md | readme_zh.md |
| 4a7623181 | 2026-07-13 | Update Readme.md | Readme.md |
| 9af4c3c65 | 2026-06-21 | Update Readme.md | Readme.md |
| 6859216d5 | 2026-06-19 | Update Readme.md | Readme.md |
| 5843d5135 | 2026-06-17 | Update Readme.md | Readme.md |

### E. Merges whose combined diff is empty against the first parent (already contained) (7)
NO — no content of their own.

| hash | date | subject | paths |
|---|---|---|---|
| 8f1bc821f | 2026-10-08 | chore(deps): bump smol-toml and nx (#18029) |  |
| e14548426 | 2026-08-17 | Merge pull request #17507 from nestjs/dependabot/npm_and_yarn/vitest/coverage-istanbul-4.1.10 |  |
| d6536e980 | 2026-08-17 | Merge pull request #17503 from nestjs/dependabot/npm_and_yarn/vitest/coverage-v8-4.1.10 |  |
| efa145f67 | 2026-08-17 | Merge pull request #17501 from nestjs/dependabot/npm_and_yarn/vitest-4.1.10 |  |
| 16a99fd74 | 2026-08-14 | Merge pull request #17477 from nestjs/dependabot/npm_and_yarn/sample/36-valibot-serializer/valibot-1.4.2 |  |
| 928fef51c | 2026-08-14 | Merge pull request #17476 from nestjs/dependabot/npm_and_yarn/sample/34-hmr-esm/nestjs/core-11.1.18 |  |
| 1d7291c5b | 2026-07-10 | Merge pull request #17275 from nestjs/renovate/commitlint-monorepo |  |

### P. Dependency bumps that touch other packages only (platform-*, microservices, websockets) — other agent's packages (23)
Out of scope here (other agent).

| hash | date | subject | paths |
|---|---|---|---|
| 720178a54 | 2026-10-09 | fix(deps): update dependency @fastify/formbody to v9.0.1 (#18050) | package-lock.json,package.json,platform-fastify |
| e07144b32 | 2026-10-09 | fix(deps): update dependency @fastify/middie to v9.3.5 (#18051) | package-lock.json,package.json,platform-fastify |
| 7e6755ef8 | 2026-10-08 | fix(deps): update dependency @fastify/cors to v11.3.1 (#18039) | package-lock.json,package.json,platform-fastify |
| 2ce2060ee | 2026-10-08 | chore(deps): bump socket.io from 4.8.3 to 4.8.4 (#18015) | package-lock.json,package.json,platform-socket.io |
| f3ae24187 | 2026-09-28 | chore(deps): update dependency ws to v8.22.0 (#17898) | package-lock.json,package.json,platform-ws |
| 6ae6b012c | 2026-09-17 | fix(deps): update dependency fastify to v5.12.5 (#17791) | package-lock.json,package.json,platform-fastify |
| 873e8d9e2 | 2026-09-15 | fix(deps): update dependency multer to v2.4.0 (#17762) | package.json,platform-express |
| 7c4fd192c | 2026-09-14 | fix(deps): update dependency fastify to v5.12.4 (#17729) | package.json,platform-fastify |
| 9847b5443 | 2026-08-30 | fix(ws): remove the upgrade listener on dispose | platform-ws |
| 1eeccd30a | 2026-08-29 | fix(deps): update dependency multer to v2.3.0 | package.json,platform-express |
| 41402b0a3 | 2026-08-22 | fix(deps): update dependency find-my-way to v9.9.0 | package.json,platform-fastify |
| e5ea7dd96 | 2026-08-20 | fix(deps): update dependency fastify to v5.12.1 | package.json,platform-fastify |
| 31ecde05e | 2026-08-17 | Merge pull request #17512 from nestjs/renovate/fastify-5.x | package.json,platform-fastify |
| 983216c77 | 2026-08-17 | Merge pull request #17513 from nestjs/renovate/find-my-way-9.x | package.json,platform-fastify |
| 241f2f12b | 2026-08-17 | Merge pull request #17508 from nestjs/dependabot/npm_and_yarn/ws-8.21.3 | package-lock.json,package.json,platform-ws |
| 1f9292f3c | 2026-08-17 | Merge pull request #17502 from nestjs/dependabot/npm_and_yarn/fastify/formbody-9.0.0 | package-lock.json,package.json,platform-fastify |
| 674ac31d4 | 2026-08-11 | Merge pull request #17455 from nestjs/renovate/fastify-5.x | package.json,platform-fastify |
| f95edc557 | 2026-08-11 | Merge pull request #17447 from nestjs/dependabot/npm_and_yarn/ws-8.21.2 | package-lock.json,package.json,platform-ws |
| 42c3c220a | 2026-08-11 | Merge pull request #17450 from nestjs/dependabot/npm_and_yarn/fastify-5.11.2 | package-lock.json,package.json,platform-fastify |
| 62f73e609 | 2026-08-07 | Merge pull request #17432 from nestjs/dependabot/npm_and_yarn/fastify-5.11.0 | package-lock.json,package.json,platform-fastify |
| b24bd298b | 2026-07-15 | Merge pull request #17322 from nestjs/dependabot/npm_and_yarn/ws-8.21.1 | package-lock.json,package.json,platform-ws |
| d4ff19977 | 2026-07-10 | Merge pull request #17282 from nestjs/dependabot/npm_and_yarn/fastify/cors-11.3.0 | package-lock.json,package.json,platform-fastify |
| 94c26611e | 2026-06-22 | Merge pull request #17164 from nestjs/renovate/npm-multer-vulnerability | package.json,platform-express |

### O. Code commits touching other packages only (platform-express, platform-fastify, websockets, platform-ws, platform-socket.io, microservices) — classified by the other agent, listed for completeness (123)
Out of scope here (other agent).

| hash | date | subject | paths |
|---|---|---|---|
| c9c251ca1 | 2026-10-12 | fix(express): handle async request and response hook errors (#18110) | integration,platform-express |
| ee3300c4c | 2026-10-12 | fix(microservices): keep nats status updates alive when a listener throws (#18108) | microservices |
| 834597425 | 2026-10-12 | fix(fastify): answer the shutdown hooks 503 with fastify's json body (#18109) | integration,platform-fastify |
| 4fa1e4e1f | 2026-10-12 | fix(fastify): honor return503OnClosing during the shutdown hooks (#18101) | integration,platform-fastify |
| 6f7048d30 | 2026-10-12 | fix(microservices): default server options like the client factory does (#18100) | microservices |
| eef86fc0d | 2026-10-12 | fix(microservices): match rmq '#' wildcards in any position (#18083) | microservices |
| dc72036d2 | 2026-10-12 | fix(fastify): build multipart field objects from present items only | platform-fastify |
| 3a2a240eb | 2026-10-12 | fix(websockets,microservices): fall back to 'Error' for minified names (#18084) | microservices,websockets |
| cf5204639 | 2026-10-12 | feat(express,fastify): add field nesting and array index upload limits (#18074) | integration,platform-express,platform-fastify |
| 4edddcd02 | 2026-10-12 | fix(websockets): copy the options object in the base ws exception filter (#18088) | websockets |
| ea86b9273 | 2026-10-12 | fix(microservices): fail mqtt requests whose publish fails (#18095) | microservices |
| 15f1ac1e6 | 2026-10-12 | fix(microservices): preserve null payloads in kafka tombstone records (#18085) | microservices |
| e787a24f7 | 2026-10-12 | fix(microservices): close the connection when the channel close fails (#18081) | microservices |
| 3f0ffbe83 | 2026-10-12 | fix(microservices): return the rmq reply publish so failures are handled (#18071) | microservices |
| 1c026243b | 2026-10-12 | fix(websockets): log scoped gateway resolution errors without a hook (#18089) | websockets |
| 0498c13a6 | 2026-10-09 | fix(microservices): fail redis listen on rejected subscriptions (#18060) | microservices |
| f8e719757 | 2026-10-09 | fix(fastify): reject listen() on an invalid port (#18059) | integration,platform-fastify |
| 8d6c9f4d0 | 2026-10-09 | fix(microservices): clone the kafka record before serializing (#18056) | microservices |
| d2e7bae62 | 2026-10-09 | fix(microservices): do not crash when the redis connection drops (#18054) | microservices |
| b647b5762 | 2026-10-09 | fix(fastify): listen on a socket path (#18053) | integration,platform-fastify |
| b6295c799 | 2026-10-08 | fix(websockets): pass gateway lifecycle hook errors to exception filters (#18048) | integration,websockets |
| ec92cb8f5 | 2026-10-08 | fix(websockets): pass the pattern when a scoped handler fails to resolve (#18046) | websockets |
| 3965882fe | 2026-10-08 | fix(microservices): fail pending kafka request on deserializer error (#18043) | microservices |
| 9029e4dcf | 2026-10-08 | fix(websockets): use the hook name as pattern for request-scoped hooks (#18044) | integration,websockets |
| a5f954458 | 2026-10-08 | fix(fastify): treat an empty route parameter as a route miss | integration,platform-fastify |
| 8857ab6a7 | 2026-10-08 | fix(fastify): settle async lifecycle hooks once (#17997) | platform-fastify |
| 12e3ffd16 | 2026-10-08 | fix(microservices): wait for the TCP TLS handshake (#18002) | microservices |
| d6d080df6 | 2026-10-08 | fix(microservices): survive custom deserializer errors in clients (#17995) | microservices |
| 3b0973f06 | 2026-10-08 | fix(microservices): close both kafka client connections when one fails (#18027) | microservices |
| b38cf79e6 | 2026-10-08 | fix(microservices): unwrap records returned by message handlers (#18008) | microservices |
| c221e003f | 2026-10-08 | fix(ws): default omitted adapter creation options (#18003) | platform-ws |
| 852403123 | 2026-10-08 | fix(microservices): wait for both Redis clients to be ready (#18001) | microservices |
| 10521ab72 | 2026-10-08 | fix(microservices): ignore stale NATS status events (#18000) | microservices |
| e1000fec3 | 2026-10-08 | fix(fastify): preserve custom router constraints (#17998) | platform-fastify |
| 39b50ec0a | 2026-10-08 | fix(microservices): preserve MQTT payload options (#17996) | microservices |
| b64b3a054 | 2026-10-02 | fix(express): destroy the `StreamableFile` source on client disconnect (#17973) | platform-express |
| 0d95f2b8f | 2026-10-02 | fix(microservices): suspend incomplete packet timers during backpressure (#17989) | microservices |
| e57948995 | 2026-10-02 | fix(microservices): cancel pending TCP retries on close (#17988) | microservices |
| 83ffa062e | 2026-10-02 | fix(microservices): keep grpc response errors out of the request stream (#17972) | integration,microservices |
| 6b52727c0 | 2026-10-02 | fix(websockets): retain shared contexts during disconnect hooks (#17985) | integration,websockets |
| 16c443dc3 | 2026-10-01 | fix(microservices): fail rmq connect and listen on channel setup errors (#17957) | microservices |
| 125144c03 | 2026-10-01 | fix(microservices): keep sibling event handlers running on empty (#17961) | microservices |
| e3a9d0512 | 2026-10-01 | fix(microservices): fail nats requests on undecodable replies (#17959) | microservices |
| 528f5f101 | 2026-09-30 | fix(microservices): stop rmq client opening two channels on connect (#17955) | microservices |
| 49f109595 | 2026-09-30 | fix(microservices): answer client-streaming calls that return nothing (#17946) | integration,microservices |
| c70e76df7 | 2026-09-30 | fix(microservices): answer grpc calls that error or complete empty | integration,microservices |
| 4caa03bb8 | 2026-09-30 | fix(microservices): resolve grpc stream calls that complete empty (#17943) | microservices |
| 82a77eb53 | 2026-09-30 | fix(express): run wildcard middleware on the bare global prefix path (#17942) | integration,platform-express |
| 54dfa24a7 | 2026-09-30 | fix(fastify): keep the default body parsers after `useBodyParser()` (#17938) | platform-fastify |
| b59196c98 | 2026-09-30 | fix(fastify): count headers flushed on `reply.raw` in `isHeadersSent` (#17937) | platform-fastify |
| 1685a435b | 2026-09-30 | fix(express,fastify): keep +json content types on error replies (#17916) | platform-express,platform-fastify |
| 697ff89e0 | 2026-09-30 | fix(express,fastify): read media type version from any accept param | integration,platform-express,platform-fastify |
| 83359533a | 2026-09-30 | fix(websockets): await async request-scoped connection hooks (#17926) | integration,websockets |
| bc2a56dba | 2026-09-30 | fix(microservices): release the nats reply inbox when publish throws (#17919) | microservices |
| 1ae307096 | 2026-09-30 | fix(microservices): settle the tcp listen callback on any listen error (#17922) | microservices |
| af6cfe630 | 2026-09-30 | fix(microservices): resolve kafka events whose stream completes empty (#17924) | microservices |
| 5903e4b71 | 2026-09-30 | fix(microservices): error grpc client-streaming calls on upstream error (#17927) | microservices |
| 7e961f8b5 | 2026-09-30 | fix(websockets): stop unserializable replies from crashing the process | platform-socket.io,platform-ws |
| 1104c1cb0 | 2026-09-29 | fix(microservices): keep rmq event listeners across reconnects (#17907) | microservices |
| 60ee6deab | 2026-09-29 | test(microservices): dedupe the socket helpers in the tcp client spec (#17906) | microservices |
| 4d24af635 | 2026-09-29 | fix(microservices): keep mqtt event listeners across reconnects (#17902) | microservices |
| 82f45ff9f | 2026-09-29 | fix(microservices): fail pending nats requests when the client gives up (#17908) | microservices |
| f80e0b6b4 | 2026-09-28 | fix(microservices): let the mqtt client retry after a failed connect (#17891) | microservices |
| 21be49668 | 2026-09-28 | fix(microservices): keep tcp event listeners across reconnects (#17888) | microservices |
| 0fd5465d7 | 2026-09-28 | fix(microservices): ignore events from a replaced tcp client socket (#17887) | microservices |
| b58554ea5 | 2026-09-25 | fix(microservices): keep a newer nats connection when a stale one fails (#17878) | microservices |
| 2b9277f90 | 2026-09-24 | fix(microservices): keep a newer kafka connection when a stale one fails (#17869) | microservices |
| 3338c8bd4 | 2026-09-24 | fix(microservices): let the rmq client retry after a failed connect (#17865) | microservices |
| 26ada7f60 | 2026-09-24 | fix(microservices): reply on the request channel when redis wildcards are enabled (#17866) | microservices |
| 3e903a0ec | 2026-09-24 | fix(fastify): treat a JSON content type with parameters as JSON in reply() (#17867) | platform-fastify |
| cc834844e | 2026-09-24 | fix(microservices): recover the nats client after it gives up reconnecting (#17861) | microservices |
| 7d76c5fd1 | 2026-09-24 | feat(microservices): export deserializers from the package root (#17863) | microservices |
| 8ff59f305 | 2026-09-23 | fix(express): map multer array index and invalid field name codes to 400 (#17857) | platform-express |
| 233a88e25 | 2026-09-23 | fix(fastify): register static assets and view engine before listen (#17854) | integration,platform-fastify |
| e715176c6 | 2026-09-22 | fix(microservices): let the redis client retry after a failed connect (#17828) | microservices |
| a1080277c | 2026-09-22 | fix(microservices): fail every pending request when a callback throws (#17810) | microservices |
| ea0d2ccc3 | 2026-09-22 | fix(fastify): honor Nest forceCloseConnections in initHttpServer (#17824) | integration,platform-fastify |
| 54f875539 | 2026-09-22 | fix(microservices): undo a request whose publish threw (#17822) | microservices |
| fb5e6990e | 2026-09-22 | fix: three typos (subcription x2, propery) (#17833) | microservices,platform-express |
| 31d8c93f4 | 2026-09-21 | Fix: merge multer `limits` key-by-key instead of overriding it wholesale (#17818) | platform-express |
| 5b1418ccd | 2026-09-21 | fix(microservices): let the kafka client retry after a failed connect (#17816) | microservices |
| 14b74ae70 | 2026-09-18 | feat: ability for tcp and redis transporters to attach meta | integration,microservices |
| f1def7602 | 2026-09-18 | fix(microservices): fail pending rmq requests on client close (#17786) | microservices |
| b41391a32 | 2026-09-18 | fix(microservices): fail pending nats requests on client close (#17802) | microservices |
| 7fc74eee8 | 2026-09-18 | fix(microservices): handle missing grpc package namespace gracefully (#17803) | microservices |
| 8ad792aaa | 2026-09-17 | fix(microservices): run the grpc stream end hook on cancel and error (#17779) | microservices |
| 6968e282b | 2026-09-17 | fix(microservices): share the processing hook envelope across transports (#17799) | microservices |
| 7f98a6a76 | 2026-09-17 | fix(microservices): close the kafka request-response span exactly once (#17797) | microservices |
| c468b2315 | 2026-09-17 | fix(microservices): close the request-response span exactly once (#17794) | microservices |
| 849f3d57d | 2026-09-17 | fix(microservices): run the end hook when an event handler rejects (#17781) | microservices |
| 10ee9b3a9 | 2026-09-17 | fix(microservices): route message handler rejections to handleError (#17785) | microservices |
| 28c5620ac | 2026-09-16 | fix(express): map multer errors by code instead of message (#17769) | platform-express |
| 8981a9da7 | 2026-09-15 | fix(microservices): always run the kafka processing end hook (#17766) | microservices |
| 7b3572cc7 | 2026-09-15 | fix(microservices): fail pending requests on client close (#17757) | microservices |
| 6ca2dd894 | 2026-09-14 | fix(microservices): bound memory held for a tcp peer (#17746) | integration,microservices |
| 781843ac9 | 2026-09-14 | fix(microservices): destroy open tcp sockets on shutdown (#17745) | integration,microservices |
| e93c8e12b | 2026-09-14 | fix: absolute-form middleware bypass (fastify) and unserializable pattern crash (microservices) (#17737) | integration,microservices,package-lock.json,package.json,platform-fastify |
| 4247f6e5d | 2026-09-14 | fix(socket.io): keep the message stream alive when a handler throws (#17666) | platform-socket.io,platform-ws |
| 3824f48b2 | 2026-09-14 | feat(microservices): add maxConnectionAttempts to ServerMqtt (#17734) | microservices |
| b413c2fd0 | 2026-09-14 | fix(microservices): detach signal listeners of connected microservices (#17728) | integration,microservices |
| 02318f0ae | 2026-09-14 | fix(microservices): report rpc exceptions thrown from event handlers (#17634) | microservices |
| ab64da77f | 2026-09-14 | fix(express): normalize error and not-found prefixes (#17648) | integration,platform-express |
| 85789c34d | 2026-09-14 | fix(microservices): reset client state when reconnecting after close (#17691) | microservices |
| f5642a67c | 2026-09-14 | fix(microservices): fail requests whose reply subscription is rejected (#17671) | microservices |
| 917aec5b8 | 2026-09-14 | fix(microservices): call RMQ listen callback once (#17675) | microservices |
| b2b555aba | 2026-09-14 | fix(microservices): do not treat foreign JSON as an RPC envelope (#17670) | microservices |
| eb65d75ec | 2026-09-14 | fix(microservices): don't flatten plain handler results with pre-request hooks (#17644) | microservices |
| 779652040 | 2026-09-14 | fix(fastify): derive neutral version when accept header is absent (#17705) | integration,platform-fastify |
| 1181f7457 | 2026-09-14 | fix(microservices): run the mqtt listen callback once (#17641) | microservices |
| 3e149fa4e | 2026-09-14 | fix(fastify): send responses for exceptions thrown from middleware (#17699) | integration,platform-fastify |
| 39fbddae5 | 2026-08-30 | fix(ws): stop discarding parser and handler lookup failures silently | platform-ws |
| b763af173 | 2026-08-30 | refactor(ws): extract the default message parser to a module constant | platform-ws |
| 1637abbe9 | 2026-08-30 | test(ws): cover the message handler binding failure paths | platform-ws |
| 536eba5ef | 2026-08-29 | refactor(websockets): drop the redundant pattern append in the ws context creator | websockets |
| 3f8a0ce18 | 2026-08-21 | fix(microservices): handle non-json mqtt response packets gracefully | microservices |
| c921a60ea | 2026-08-25 | fix(fastify): append headers instead of overwriting | platform-fastify |
| e03cf5c86 | 2026-08-16 | fix(express,fastify): apply falsy status codes in reply() | platform-express,platform-fastify |
| 82cab543f | 2026-08-17 | Merge pull request #16962 from orgads/platform-socket-types | platform-socket.io |
| 5303b819a | 2026-08-11 | Merge pull request #17350 from GiHoon1123/master | integration,platform-fastify |
| 1def88d0a | 2026-08-11 | Merge pull request #17377 from Arun445/fix/fastify-middleware-global-prefix-exclude | integration,platform-fastify |
| 1a8c27368 | 2026-08-09 | fix(microservices): call on processing end hook | microservices |
| 0edc0ba3e | 2026-08-05 | Merge remote-tracking branch 'refs/remotes/origin/master' | integration,platform-express |
| fd5818c25 | 2026-06-21 | Merge pull request #17165 from Se3do/chore/remove-debug-console-logs | microservices,websockets |

### M. Merge commits with their own (conflict-resolution) changes in core/common/testing (12) — NO
Found with `git diff-tree --cc` over every merge in the range. They re-apply master's changes onto the ESM branch (import paths, `package.json` versions) or resolve spec conflicts; each behaviour is classified at its originating commit above (e.g. 5d1b19bca carries `@SseSignal()`/`MisdirectedException` from #17469/#17337).

- edb003497 — Merge branch 'master' into v12.0.0
- 5d1b19bca — Merge branch 'master' into v12.0.0
- b2e7fb5e7 — Merge pull request #17469 from nestjs/feat/sse-signal
- eac10cd2d — Merge pull request #17162 from gacardinal/feat/query-http-method
- 68dfc23d4 — Merge branch 'master' into v12.0.0
- c470ddf88 — Merge branch 'master' into v12.0.0
- f0c95c8d8 — chore: merge master
- 4ec944577 — Merge branch 'fix/stricter-is-http-error-check' of https://github.com/glebbash/nest into fix/stricter-is-http-error-check
- 7ae88edf3 — Merge pull request #15413 from y-nk/julien/argument-metadata-generic
- 84f92eb08 — Merge pull request #16329 from at7211/feat/validation-pipe-error-format
- 65615baaf — chore: resolve merge conflicts
- 1ab6f0314 — Merge branch 'v12.0.0' into feat/add-error-code

## Sources

- Commit lists: ../commits-pkgs.tsv, ../commits-11.2-branch.tsv; derived here: all-ccT.txt (211 hashes), table.tsv (hash, date, PR, first tag, first-parent?, -, packages, other paths, stat, subject), files.tsv (non-spec files per commit), commit-pr-inner.txt, groups.json, classes.tsv.
- Diffs read with show.sh (non-spec files of core/common/testing) for every row marked AFFECTS and every adapter/routing/middleware/SSE/exception/shutdown/packaging row; release notes ../releases/*.md; migration guide ../docs-src/content/migration.md; installed 12.1.3 and 11.x sources in ../repo12 and ../repo11 node_modules.
- Probes (probe/): extract.ts + names.tsv (all named @nestjs imports), probe12.ts (type-check vs 12.1.3, with negative control), internal-root.ts + p11/ (root vs internal exports, 11 and 12), query-method.ts (Bun.serve accepts QUERY), filetype.ts (FileTypeValidator/ParseFilePipe under Bun).
