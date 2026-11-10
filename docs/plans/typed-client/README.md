# Typed client: types from the server for every transport, validation both ways, an SWR data layer, live sync

Implementation plan for a **type-aware client library** and the server-side
pieces it needs in `@kingsleyweb/bun-common` (both HTTP adapters), covering
**HTTP, WebSocket channels, server-sent events, WebRTC signalling and data
channels, and GraphQL**, with typed, validated messages in both directions.
The transports beyond HTTP each have a sub-plan in this folder (§1.4); the
NestJS half is [`nest-typed-routes.md`](nest-typed-routes.md). The user
asked, on 2026-10-10:

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

then, through the coordinator, on the same day:

> "it should come with a builtin zod validator although it should allow for
> bring your own validator to add extra validation outside the inbuilt schema
> validation. I dont know if this makes sense. Also ensure you expose option on
> the client side library to enable or disable or customise functionality. For
> instance enabling request body or request query validation etc."

and on 2026-10-28, widening it:

> "After the bun cache plan, you will work on the typed client plan
> implementation but this time it should include auto typings, validation for
> all kind of request. Http, websocket, webrtc, graphql if any, etc."

The second request is §5 (validation) and §6.2 (configuration); the third is
§3.5 (auto typing per transport), §5.6 (validation per transport) and the
sub-plans.

Written 2026-10-10 against `develop` at `7dac1de4`; **revised 2026-11-02
against `e80ab379`**, after bun-validate, api-docs-generation and the
contract core landed (§2). **No product code was changed.** Every
`file:line` is at `e80ab379` and relative to `packages/` unless it says
otherwise; a measurement carries the date of its evidence. The evidence is in
[`evidence/`](evidence/README.md), and each measurement there can be re-run
with one command.

### Status (2026-11-10)

| Part | State |
|---|---|
| This plan, its sub-plans and `nest-typed-routes.md` | revised 2026-11-02 and **approved by the user on 2026-11-02**: every recommendation in §14 and every name in §16. **Complete** (checked 2026-11-10 against `develop` at `ae01cfe9`): every PR of §15's three groups, NTR's, the pilot's and the examples' has merged, #592 to #651, with the follow-ups #679 to #689 (the next rows). What is left is §15's "later, on demand" (`./vue`, `./svelte`, `./solid`, `./preact`, upload progress, a `"bun-jobs"` codec) and SSR's `<ApiHydrate>`, which waits for bun-views' PR-5 |
| **PR-K** (`@kingsleyweb/bun-contract`, §10.1, §12.1, R14) | **merged** 2026-11-02, #592 (branch `feat/bun-contract-package`): `lib/contract/` and the Standard Schema types moved to `packages/bun-contract`, which has no dependency and bundles browser-safe; bun-common depends on it and re-exports it unchanged (`./contract`, the root, every `lib/contract/<module>` path); the logger is a minimal `ContractLogger`/`ContractLogSink`, bun-common installing its `resolveLogger` as the resolution; consumer check OK for both packages |
| **PR-C1** client core (`packages/bun-client`) | **PR-C1 merged** (2026-11-02, #593, branch `feat/bun-client-core`): `createClient`, the verbs, `request`, `url`, `api.op`; params, query (round-trips through `router.fetch()`), body, headers; abort, timeout, retries with `Retry-After`, middleware, single-flight auth refresh; `Result` and the five error classes; §6.2's merging. Types from a hand-written map or `RoutesOf` (its parsed view until PR-M1). The names beyond §16 (`manifest` with `RouteManifest`, `Client`, `ClientFlags`, `RequestContext`), `throwOnError`/`undeclaredStatus` at the client and call levels only, a later level re-enabling retries, and a playground page after PR-C2 were **approved by the user on 2026-11-02** |
| **PR-C2** generator and CLI (§3.2, §4, §10.1) | **merged** 2026-11-02, #597: `./codegen` (`generateRoutes`, `loadDocuments`, `runCli`, `documentsHash`) and the `bun-client` bin (`generate` with `--url`, `--openapi`/`--asyncapi`, `--module`/`--export`, `--out`, `--check`). OpenAPI 3.1 (and 3.0's `nullable`) → `Routes`, components as named types (recursion through their names), `manifest`; keys from `x-bun-route-key`, `x-bun-errors` narrowing error `code`s, `x-bun-cache` as `cache`, `x-sse-events` as `stream: "sse"` and `events`; inexpressible keywords `unknown` with a warning; deterministic, laid out as Prettier lays it out; `typesHash` in the header. Parity with `RoutesOf`'s `send`/`receive` over a fixture app, with §5.3's `z.date()` and the narrower codes pinned. `watch` (PR-C3) and `--zod` (PR-C4) exit saying so. The names beyond §16 (now in §16), `generate --url` waiting for PR-C3's token file (no `--header`), `--module`'s fixed `{ title: "API", version: "1" }`, untyped `default`/range responses with a warning, and a component named like a global keeping its name were **approved by the user on 2026-11-02**, as was a follow-up PR for `api.url`'s query becoming `never` on a path two methods share; §3.1's HTTP check-time rows are measured (`evidence/transports/http-typing/`) |
| **PR-C3** watcher (§3.3, §12.1) | **merged** 2026-11-02, #599: `bun-client watch --out <file> [--url <url>] [--token-file <path>]` finds the dev server through `devTypes()`'s token file (the only one running, the one at `--url`, or the one followed last; several at the start exit `2` naming them; a dead `pid` skipped; the nearest `node_modules/.cache/bun-types` from the working directory up), fetches with the bearer token (`If-None-Match` after the first fetch), regenerates through `generate`'s own step, writes atomically and only on a content change, follows `bun-types.v1` with a `token.<t>` subprotocol, reconnects 50 ms → 2 s re-reading the token file, logs a refused token once per file, one line per regeneration (hash, ms), stops on SIGINT/SIGTERM with `0`. `generate --url` sends a matching token file's token to the dev endpoint only (the user's 2026-11-02 decision, no `--header`). Measured with the shipped server and bin (`evidence/watch/`): **`--watch` 170 / 178 ms** (the spike's 160), **`--hot` 139 / 146 ms** (the spike's 49), the `--hot` gap being `devTypes()`'s 100 ms poll after a re-evaluation, not the watcher (1 ms). New names awaiting approval: `--token-file`, `CliIo.signal` |
| **PR-C4** validation and `/zod` (§5, §6.2, §10.1, §12.1) | **merged** 2026-11-02, #600: the request's `params`, `query` and `body` checked before the URL is built and its `headers` as sent (first attempt), a failure throwing `ValidationError` and sending nothing; a declared status's body checked on arrival, a failure warning through `logger` and delivering the body as it arrived; on in development and off in production (`mode`, else `process.env.NODE_ENV` written out for a bundler's define); `validate` at the client, route and call levels, merged per key, `false` turning everything under it off, BYO included, until a later level turns it back on; `onFailure` `"throw"`/`"warn"`/a hook per direction. The built-in schemas run through bun-contract's `createSender`/`createReceiver` (the server's HTTP transport), BYO ones through `validateStandard`, after the built-in on its output (or the raw value on failure), issues merged built-in first, `replace: true`, a BYO transform applied. bun-contract is bun-client's one dependency, imported only by `lib/validation.ts`, loaded with `import()` when a call may check something: the eager entry 4.6 KiB gzipped (C1's 5 KB budget kept), the checks chunk 6.3 KiB, and a splitting build's entry carries none of bun-contract (proved with a negative control). `./zod` (`schemasFromZod`; zod `^4` an optional peer, types only) and `generate --zod <file> [--zod-flavour classic]` (also `watch --zod`, through `generate`'s step): loose objects, formats, lengths, ranges, patterns, tuples, unions, `$ref` components topologically ordered (self-recursion by `z.lazy`, a cycle by a hoisted accessor), formatted as Prettier does (both flavours' goldens and a sweep pass `bun fmt --check`); the server's own schemas from a browser-safe module through the same `schemas` option. New names awaiting approval: `RouteSchemas`, `ValidationErrorIssue`, `ValidationError`'s `direction`/`status`/`issues`, `GenerateRoutesOptions.zod`/`GenerateRoutesResult.zod` |
| **PR-C4 follow-ups** (§5.3, §5.4, §5.6; queued by the user 2026-11-02) | **merged** 2026-11-03, #626 (branch `feat/bun-client-validation-followups`), bun-client only. **BYO output types**: a call's `validate.response[status].custom` types that status's `data`/`error` as the schema's output (`throwOnError`, a string status key, a streamed status's values; `as: "stream"`, `false` and a widened config keep the wire type), through a last type parameter `V` capturing only `validate.response` (capturing all of `validate` broke an `onFailure` hook's contextual type); not at the route level (`createClient<Routes>()` names its type arguments), nor in `./query`/`./react`. **Response headers**: the generator writes `responseHeaders` per status (lower-case names, `required`, `$ref` headers and responses followed, `Content-Type` and `Set-Cookie` left out) into the map and the zod module; a header crosses as a string, so a string schema is checked as declared and any other as `z.string()` (typed `string`), which also fixed C4's request headers (a documented `integer` header was `z.number()` and refused the `"42"` sent); checked on arrival through the same receiver as the body, one `ValidationError` (headers first, `target: "headers"`), under the status's switch and failure mode; `replace` replaces the body's built-in schema only; an unread body has its headers checked alone (cancelled on a throw). bun-common already documented response headers (validator and `.describe()`). **Dropped by JSON Schema**: `generate --module` lists each zod refinement, `z.date()`, `z.custom()` and transform on the documented side, once per schema, in the route map's header and on stderr (`lib/codegen/zodDrops.ts`, structural over `_zod.def`, run over `listRoutes`); not in bun-common, whose `strict: "strict"` would escalate a new warning to a `ConfigError`. Bundle: eager 12,029 / 5,052 B gzipped (5 KB kept), checks chunk 19,149 / 6,850 B. **Approved by the user on 2026-11-03**, names and behaviours as built: `responseHeaders` (route entry, `RouteEntry`, `RouteSchemas`, `schemasFromZod`), the type parameter `V`, BYO typing under `"warn"` documented, no route-level typing, `replace` keeping headers, non-string headers as strings, the drop warnings in the route map's header and in the loader. Follow-ups noted: non-string request header *types*, BYO typing in `./query`/`./react`, the drop warnings from bun-common (a strict-safe channel) |
| **PR-C5** query layer (§6.3, §6.4, §7.2, §10.1, §10.3, §12.1) | **merged** 2026-11-02, #608 (branch `feat/bun-client-query`): `@kingsleyweb/bun-client/query` on `@tanstack/query-core` (an optional peer, `^5.90.0` rather than `^5`: the query and mutation callbacks read the `QueryClient` from their context). `queries(api, { manifest })` → `key`, `query`, `infinite`, `mutation`, `invalidateTags`; `observe(queryClient, options)`; `invalidateTags(queryClient, tags)`; `tagsOfQuery` (the hook PR-W4's `live()` subscribes through). Keys `[routeKey, { params, query }]` (params as strings; an infinite key ends in `"infinite"` without its page field); the manifest's `cache.tags` templates filled from the params into `meta.tags`, and the `Cache-Tag`/`Surrogate-Key` headers of each response kept per query (proved with bun-cache's `cacheResponse({ surrogateKeys })` and a data-driven `addCacheTags`); a mutation's `cache.invalidates` invalidated on success, the mutation settling after the refetches; `If-None-Match` from the last `ETag`, a `304` keeping the cached object (`dataUpdatedAt` moved), the ETag dropped on a manual write and on `no-store`; optimistic writes per GET route to the cached queries whose params agree, rolled back to the same object and its ETag; infinite pages in a typed query field (`pageParam`, `next`, `previous`, `initialPageParam`); `observe()` a `subscribe`/`getSnapshot` store keeping its snapshot's identity, the last unsubscribe detaching the observer. The generator now writes `cache` into the `manifest` too (`RouteManifest.cache`), since the runtime needs the templates; the query-string serialiser moved to `lib/querystring.ts` so `./query` is `lib/query.ts`. The `.` entry is byte-identical to PR-C4's (11,106 B minified, 4,690 B gzipped); `./query` 5.8 KiB minified, 2.4 KiB gzipped over query-core (budget 3 KB, §10.3), 17.8 / 6.2 KiB with what it takes of query-core inlined. New names awaiting approval: `tagsOfQuery`, `QueriesOptions`, `Queries`, `QueryCallOptions`, `InfiniteCallOptions`, `InfiniteConfig` (`pageParam`, `initialPageParam`, `next`, `previous`), `MutationConfig` (`optimistic`), `OptimisticSnapshot`, `ApiQueryOptions`, `ApiInfiniteOptions`, `ApiMutationOptions`, `QuerySnapshot`, `InfiniteQuerySnapshot`, `ObservedQuery`, `ObservedInfiniteQuery`, the factories' `key`, and `RouteManifest.cache` |
| **PR-C6** React (§7.1, §10.1, §10.3, §12.1) | **merged** 2026-11-03, #611 (branch `feat/bun-client-react`): `@kingsleyweb/bun-client/react`, **thin wrappers over `@tanstack/react-query`** as §7.1's table says (not our own `useSyncExternalStore` binding over `observe()`, which stays the vanilla/Lit store), `react ^19` and `@tanstack/react-query ^5.90.0` optional peers. `createApiHooks(q)` over `queries(api, { manifest })` returns `useApi(path, options?, query?)` (`useQuery`), `useApiSuspense` (`useSuspenseQuery`, react-query's 1 s `staleTime` floor kept), `useApiInfinite(path, options, page, query?)` (`useInfiniteQuery`) and `useApiMutation(key, config?, options?)` (`useMutation`), typed from the route map: `data` the success body (or `select`'s), `error` the route's `HttpError` or a `ClientError`, the call's options required when the route has a required part; react-query's options pass through but the key, the query function and (for a mutation) `onMutate`, a given `meta` merged under the route's tags, and a mutation's own `onSuccess`/`onError`/`onSettled` run after the layer's (so its `invalidates` and rollback are never replaced). No provider of ours (react-query's `QueryClientProvider`). DOM tests (happy-dom per file, react-dom loaded dynamically, every `act` awaited) through a bun-common router's `fetch()`: pending → success, a declared 404 as `HttpError`, one fetch for two components, refetch on a tag's invalidation, a mutation's `invalidates`, an optimistic write rendered and its rollback rendered before the refetch, Suspense fetching once against the spike's double fetch, infinite pages, StrictMode's double mount, and unmount releasing observers and `refetchInterval` timers (a timer ledger, a planted leak as its control). `./react` 855 B minified, 390 B gzipped over its peers (budget 0.95 / 0.5 KiB); the `.` and `./query` bundles unchanged. `useLive` waits for PR-W4 and `<ApiHydrate>` for BVW PR-5 (react-query's `HydrationBoundary` meanwhile). New names awaiting approval: `createApiHooks`, `useApiInfinite`, `ApiHooks`, `UseApiOptions`, `UseApiSuspenseOptions`, `UseApiInfiniteOptions`, `UseApiMutationOptions` |
| **PR-C8** persistence (§6.4, §10.1, §12.1) | **merged** 2026-11-03, #612 (branch `feat/bun-client-persist`): `@kingsleyweb/bun-client/persist`, `idbPersister(options?)` returning a `Persister` for query-core's own `persistQueryClient` (or React's `PersistQueryClientProvider`), on the platform's IndexedDB API with no library; `@tanstack/query-persist-client-core` an optional peer (`^5.90.0`, types only; the devDependency pinned to 5.103.1, the lock's query-core, which it depends on exactly). One record (`key`, default `"client"`) in one store (`"queries"`) of one database (`"bun-client"`), the `PersistedClient` stored as a structured clone; writes throttled to one per `throttleTime` (1 s, TanStack's), every operation on one ordered chain (a removal cancels a waiting write and follows a started one); nothing rejects (`onError`, a failed restore is no cache); without IndexedDB every method does nothing; a missing store created by raising the version; the connection closed on another tab's `versionchange`. **The buster**: the plan's "buster = the documents' hash" had no runtime value to read (the hash was only the generated header's comment), so the generator now exports it, `export const typesHash = "<hash>"` in the route module (and `typesHash` is reserved from component names); the goldens and the playground's generated file gain the line. Tested on an in-test IndexedDB (async events, the inactive-transaction rule, structured clones, injected faults) and on Chrome's real one through `Bun.WebView` (a cache restored after a navigation; another buster restores nothing and deletes the record; `maxAge`): the generated `typesHash` is bun-common's `typesHash` of the documents, a cache persisted under it restores with its data and declared tags and no request, and a schema change gives a new hash that drops it. Not persisted: the query layer's ETags and header tags (a restored query's first fetch is unconditional). `./persist` 1,472 B minified, 724 B gzipped (budget 1.6 / 0.8 KiB); the other entries unchanged. New names awaiting approval: `IdbPersisterOptions` (`database`, `store`, `key`, `throttleTime`, `indexedDB`, `onError`) and the generated `typesHash` export |
| **PR-C9** bodies (`other-transports.md` §3, §4, §6; §5.6, §12.1) | **merged** 2026-11-03, #613 and #614 (branch `feat/bun-client-bodies`), in two patches. **bun-common**: `RouteDoc.request.files` (`RouteFileDoc`: `description`, `required` default `false`, `maxCount` default 1 as the upload handlers' (above 1 or `Infinity` a list), `maxBytes`, `mediaTypes`) documented as `{ type: "string", format: "binary" }` properties of the multipart body beside the validator's (or `request.body`'s) fields, an inline object merged and anything else under `allOf`, `encoding.<field>.contentType` from `mediaTypes`, `x-bun-max-bytes` from `maxBytes`; files default the media type to `multipart/form-data` and are left out (warned) beside media types with none; `requestMediaTypes` now also re-homes a validator's body (it was ignored without `request.body`), so a form documents as urlencoded; a `chunks()` body's schema carries `x-bun-chunks` (`"ndjson"`/`"raw"`); `RoutesOf`'s `receive` types an NDJSON `chunks()` as `AsyncIterable<Jsonify<WireInput<chunk>>>`, a raw one `AsyncIterable<Uint8Array>`, a byte media type (`opaque()` included) `Blob`, opaque text `string` (was `unknown` for all). **bun-client**: a declared `files` part (`Blob` or `Blob[]` per field, any record of them for an undeclared one) sent as `multipart/form-data` with the fields as bun-common's parser reads them back, a `Blob` renamed `"blob"` (oven-sh/bun#35439, commented; `docs/bun-bugs/formdata-blob-empty-filename.md`); the manifest's `bodyType` (`"multipart"`/`"urlencoded"`) sends a plain-object body as `FormData` or a form; a pre-built `FormData`/`URLSearchParams` passes through unchecked; downloads by kind (`Blob`, a `File` named from `Content-Disposition` with the result's `filename`, `as: "stream"`, `as: "arrayBuffer"`), NDJSON (manifest `chunks`, or an NDJSON media type) and raw chunk iteration, each NDJSON line checked under the response's failure mode (a bad line delivered under `"warn"`, refused under `"throw"`), a server's `chunks()` declaration read as its chunk schema; streamed request bodies with `duplex: "half"`, never retried; a `files` validation part (`ValidationConfig.files`, `RouteSchemas.files`, issue target `"files"`). The generator types a multipart body's fields (`| FormData`) and its `files` (`format: binary` or `contentMediaType`, through `$ref` and `allOf`), an urlencoded body's fields (`| URLSearchParams`), `AsyncIterable` streams, and writes `bodyType` and `chunks`; `--zod` writes form `body`, `files` (`z.file()` with `z.maxSize`, exact `z.mime`, list `maxLength`) and NDJSON line schemas. Parity holds with three new pins (a form's pre-built body, `files` generated-only, streams compared through `Result`). The forms, downloads and streams load lazily (`lib/bodies.ts`, 2,258 B minified, 1,165 B gzipped); the eager entry 11,922 / 5,019 B (the 5 KB gzip budget kept; the minified tripwire raised 11 → 12.5 KiB). Not done: upload progress (later, on demand), a media-type check of a download. New names awaiting approval: `RouteFileDoc` (and its `maxCount`, `required`, `description`), `x-bun-chunks`, `x-bun-max-bytes`, `RouteEntry.files`, the `files` call option, `as` and `DownloadAs`, `Result`'s `filename`, `RouteManifest.bodyType` and `.chunks`, `ValidationConfig.files`, `RouteSchemas.files` |
| **PR-W1** channel server pieces (bun-common, [`websocket.md`](websocket.md) §10.1–10.4) | **merged** 2026-11-03, #627 (branch `feat/bun-common-channel-server`): a replied type's handler returns the reply, sent as the reply type carrying the request's id (under `envelope.idField`), checked under `out` — the AsyncAPI document's "echoed by it" is now true; the handler's third argument is the frame's `{ type, id }` and `send(ws, type, data, { id })` answers later; `defineChannel(contract)` takes a `channelContract()` result (used as is: the same channel, types and AsyncAPI as the inline form); a handler's `ws` is `ChannelSocket<S, TCustom>` (`ws.data.params` from the path literal, `ws.data.valid` with the `request` schemas' outputs — `req.valid` at the upgrade, which `BunWebSocket` now carries on every `ws()` route as `ws.data.valid` — `handler<TCustom>()` for `ws.data.custom`); `send`/`publish` return `Promise<number>` (Bun's status once the queued write ran, never rejecting), and `publish(server, topic, type, data)` publishes on a server (`req.server`, the adapter's `server`). The names beyond §16 and the decisions taken in it were **approved by the user on 2026-11-03**, as built: `ChannelSocket`, `ws.data.valid`, `handler<TCustom>()`, the handler's third argument (`{ type, id }`, its type unexported), `publish(server, …)` as the server-level publish, `null` sending a data-less reply, and a reply failing its contract logged and dropped. §10.5 (bun-jobs' outbound policy) is not in it |
| **PR-S1** SSE client ([`sse.md`](sse.md) §3, §5; §5.6, §10.1, §10.3) | **merged** 2026-11-03, #628 (branch `feat/bun-client-sse`): `@kingsleyweb/bun-client/sse`, `sse(api, key, options)` → `EventStream` (async iterable, `on(name, listener)` returning its remover, `lastEventId`, `close()`, `closed`) and `StreamClosedError`. Each connection is the client's own call (`api.request`, so headers, auth and refresh, middleware and request checks apply; `Accept: text/event-stream`), nothing sent until the first read; a fresh browser-safe parser (`lib/sseParser.ts`, the HTML standard's rules: CR/LF/CRLF across chunks, one BOM, comments, `id:` without NUL, `retry:` digits only), run with bun-common's `SseFramer` over one corpus (24 cases, each in three chunkings; control: a `\n\n` framer fails the CR cases); one deliberate departure from `EventSource`, an `event:`-only block dispatched with `undefined` data, as `SseFramer` frames bun-common's `null` events. `Last-Event-ID` on every reconnection (and the `lastEventId` option); reconnection after `retry:`, else 3 s, doubling to 30 s, half-jittered, reset after 60 s open, `Retry-After` on a failed status winning; `heartbeatMs` (2× + 5 s with no byte); stops on `204`, `close()`, the signal (its reason), or `fatalStatuses` (4xx but 408/429): a declared status as the client's `HttpError`, any other (or a non-event-stream success) as `StreamClosedError`; `reconnect: false` ends cleanly with the stream, `NetworkError` on a drop. `gap` delivered and `$gap` fired. Validation on HTTP's policy and levels (client, route, call `validate`; the stream status's `response` switch): the server's rules per event (undeclared name, data on a `null` event, not JSON, the event's schema), a BYO schema on the whole event; warn and deliver, `"drop"` with `$invalid`, `"throw"`; checks lazy (`./validation`'s `event`). Pull-based iterator, eager listeners. Types: event narrowing, listeners by name, `$gap` only with a declared `gap`, `api.get`/`request`/`op` refusing a `stream: "sse"` entry (`HttpKeyOf`). Generator: `--zod` writes the route's `events` schemas (`RouteSchemas.events`; a bun-common `sse()` declaration as the status's response read the same way). `./sse` 8.0 KiB minified, 3.3 KiB gzipped (the 2 KB of §10.3 was an estimate), its event checks a lazy chunk of their own (`lib/sseChecks.ts`, 0.6 KiB gzipped) so the core client's checks chunk carries none of them; the `.` entry +36 bytes gzipped (the configuration under a registered symbol for `./sse`, an event stream marked unread). **Approved by the user 2026-11-03, as built**: the names beyond §16 (`$invalid`, `closed`, the options `lastEventId`, `reconnect` with `initialMs`/`maxMs`, `data` `"json" | "text"`, `RouteSchemas.events`, `StreamClosedError.status`/`.response`), an event's `ValidationError` with `direction: "response"`, the `./sse` size and the root's configuration hook. Queued as later PRs: `x-sse-data` from bun-common's OpenAPI generator, `RoutesOf` marking SSE routes, the transport options at the client and route levels |
| **PR-W2** channel client ([`websocket.md`](websocket.md) §3–§8, §12, §13.1; §5.6, §10.1, §10.3) | **merged** 2026-11-03, #630 (branch `feat/bun-client-channel`), bun-client only: `@kingsleyweb/bun-client/channel`, `channel(api, contract | descriptor, options)` → `ChannelClient` (`send`, `request`, `sendWhenReady`, `on`, `messages()`, `close`, `state`, `bufferedAmount`; `$state`, `$error`, `$invalid`), typed from a shared `channelContract()` (inferred: `WireInput` sent, `Jsonify` received, `ChannelEntryOf`) or from a generated descriptor (`channels["/rooms/:room"]`, typed by the generated `Channels` entry, `Equal` to the contract inferred). One socket per URL, refcounted; requests stamped with a counter per socket under the envelope's `idField` and resolved by the echoed id (a push of the reply's type without it is a push), `ChannelError` for an error frame with the id, `RequestTimeoutError` (the client's `timeout`), `DisconnectedError` on a drop (`retry: true` resends); validation both ways on the HTTP policy (the client's `validate.request`/`.response`, the channel's `validate: { send, receive, onFailure }` per message type, a send's own `validate`), bun-contract's sender and receiver guards loaded lazily (`lib/channelChecks.ts`, through `./validation`, the guards' one import site), a send before they loaded checked in order afterwards and its failure on `$error`, the error frame's fixed shape always checked; reconnect 500 ms → 30 s half-jittered, reset after 60 s open, `fatalCloseCodes` (1007, 1008, 4400–4499, ranges as `[from, to]`), the heartbeat watchdog (close 4000 and reconnect), `ping`, `resubscribe` before the offline buffer (100) flushes, `offline: "fail"`; `sendWhenReady` polling `bufferedAmount` per animation frame (16 ms outside a browser); codecs `"bun-common"` and a custom `{ encode, decode }`. The generator writes `Channels`, `channels` (`ChannelDescriptors<Channels>`) and, with `--zod`, `channelSchemas` from the AsyncAPI document (`--asyncapi`, a URL's, or a router's under `--module`; `lib/codegen/asyncapi.ts`). `ValidationError.direction` gains `"send"`/`"receive"`. Bundle: `./channel` 11,831 B minified, 4,523 gzipped (the plan's 4 KB was an estimate), its checks chunk 17,447 / 6,406; the `.` entry 12,074 / 5,085, no channel code. Not done: `"bun-nest"` (PR-W3), headers on the upgrade (a browser cannot), a client-side check of the upgrade's params and query. The names beyond §16 and the decisions taken in it were **approved by the user on 2026-11-03**, as built: `ChannelEntry`, `ChannelEntryOf`, `ChannelDescriptor`, `ChannelDescriptors`, `ChannelCodec`, `ChannelValidationConfig` (`send`, `receive`, `onFailure.send`/`.receive`), `ChannelSchemas`, the generated `channels`/`channelSchemas`, `GenerateRoutesResult.channels`, the per-call `validate`; the channel errors exported from `./channel` only (not `.`, whose 5 KB budget they would break); the generated form `channel(api, channels["/rooms/:room"], …)` (a typed descriptor, not a path string); `ValidationError.direction` widened with `"send" | "receive"`; a data-less message sent as `send(type, undefined, options)`; a reply dropped under `"drop"` rejecting its request; a push refused under `"throw"` dropped to `$error`; `$error` also taking a deferred send's failure and a fatal close; messages sent during an async `resubscribe` going out before the buffered ones; `fatalCloseCodes` ranges. Two bun-common AsyncAPI findings (a type on both sides keeping only the outbound schema; the error frame documented as an enveloped `data` under the `idField`) are a separate PR |
| **PR-W3** Nest codec ([`websocket.md`](websocket.md) §11, §12, §13.1; NTR §7) | **merged** 2026-11-03, #634 (branch `feat/bun-client-nest-codec`), bun-client plus bun-nest tests and docs (no bun-nest runtime change): `codec: "bun-nest"` in `./channel` speaks the adapter's packets: a send is an `EVENT` `[type, data]` (`[type]` with no data, namespace `"/"`), a request the same with a numeric id, resolved by the gateway's `ACK` of that id (`BINARY_ACK` too; several arguments as their array; an ack no request waits for ignored), so `request()` resolves with the ack typed by `@ValidateMessage`'s `ack` schema and checked under the receive policy; a server `EVENT` is always a push (an id on it, `emitWithAck`, is dropped: not supported); bytes (`ArrayBuffer`, typed arrays) are a `BINARY_EVENT`, base64, and binary arguments arrive as `Uint8Array`s; `ValidationExceptionFilter`'s `exception` (`{ status, code: "VALIDATION", issues }`) is a `ChannelError` on `$error`, any other `exception` a push, an `ERROR` packet an `"error"` push, `CONNECT`/`DISCONNECT` ignored. A gateway sends no ack for a handler that threw and no event names the request, so such a request ends with `RequestTimeoutError`. The generator reads `gatewayAsyncApi()` documents (`lib/codegen/asyncapi.ts` `nestPacket()`): an `EVENT`'s type from `data[0]`, its data `data[1]`, the `ACK` reply a sent type named as the document names it (`"say ack"`) with `replies` mapping the event to it, `ERROR` as `"error": string`, lifecycle frames left out, and the descriptor writes `codec: "bun-nest"` (`ChannelDescriptor.codec`, used when the options name none). NTR §7's shared maps: one browser-safe module whose schemas the decorators take and whose `channelContract()` the client opens (`bun-nest/__tests__/fixtures/nest-channel/chat.shared.ts`; bun-client's README, "bun-nest gateways"). Tested against a real gateway on port 0 (`bun-nest/__tests__/channelClient.nest.test.ts`, the golden generated from the gateway's documents by `--module`, a live ack `Equal` to the generated type), and on the wire against a scripted packet server (`bun-client/__tests__/channelNest.test.ts`, `codegen/channelsNest.test.ts`); Nest 11.2.7 column of the matrix. Bundle: `./channel` 13,123 B minified, 5,019 gzipped (+1,292 / +496), 189 and 101 bytes under its limits. bun-nest gains a devDependency on `@kingsleyweb/bun-client` (workspace). **Approved by the user on 2026-11-03**, as built: the ack's generated name `"<event> ack"` (`"say ack"`) and `ChannelDescriptor.codec`. Queued, not in it: a bun-nest follow-up putting the event's ack id in `ValidationExceptionFilter`'s `exception` frame (so the codec can reject that request at once, instead of its timeout), and raising `./channel`'s budget in PR-W4 |
| **PR-W4** live invalidation ([`websocket.md`](websocket.md) §9, §13.1; D15, §6.4, §8.1) | **merged** 2026-11-03, #637 (branch `feat/live-invalidation`). **bun-common `./live`** (new entry; not in the root): `liveContract` (browser-safe, also alone at `./lib/live/contract`; `/__live`, receives `subscribe`/`unsubscribe` `{ tags }` and `resume` `{ epoch, seq }`, sends `invalidate` `{ tags, seq, epoch }`, `gap` and `hello` `{ epoch, seq }`, `subscribe`/`resume` answered with `hello`, `fallback: "/__live/sse"`; hand-written checking schemas with their JSON Schema; tags 1–512 characters, at most 256 a frame), `liveInvalidation(app, { authorize, source })` returning a router to mount first (the SSE fallback and the route source; the channel registered on `app`, as `devTypes` does, since a socket route lives on the socket's router; `authorize` required, a `ConfigError` otherwise) and `publishTags(tags)`. One Bun topic per tag, refcounted (published only where held; one frame per tag, the invalidation's `seq` on each); a per-process ring of 1024 `{ seq, tags }` with a random epoch; `resume` replays a socket's missed invalidations before its `hello` (and once more for the tags of the `subscribe` after it), a `gap` for another epoch, a cursor ahead, or one off the ring. Sources: `publishTags`, a route's `cache.invalidates` filled from the params on a 2xx (`res.whenResponded`, the matched route's doc), and a bun-cache cache through its **existing** `invalidate` event (`CacheEventMap`, emitted by `invalidateTags` in both modes; §9's "no tag-invalidation event today" was stale), so bun-cache is unchanged. The SSE fallback `GET /__live/sse?tag=…` on PR-sse2's writer (`res.sse({ contract, resume })`: an `sse()` declaration of the channel's own `invalidate`/`gap`/`hello` schemas, so each event is checked; its heartbeat, `idleTimeout` exemption, backpressure and bound): `Last-Event-ID` `<epoch>:<seq>` as the cursor, `resume` answering the replay or a `gap` (also for an id it cannot read), then `hello`, events with ids; hidden from OpenAPI, the channel and its fallback in AsyncAPI. **bun-client `./query`**: `live(api, queryClient, { transport })` → a stop function; the observed queries' tags (`tagsOfQuery`) refcounted and batched per task, an invalidation applied once per `seq` per query, the cursor kept and sent as `resume` before `subscribe` on every reopen, `gap` or a new epoch invalidating everything, SSE when asked, without `WebSocket`, or when the channel has not opened 3 s after the start; the implementation (`lib/live.ts`) and `./channel`/`./sse` under it loaded with `import()`. Bundle: `./query` 6,211 / 2,626 B (5,974 / 2,486 before), the live chunk 3,547 / 1,643, `.` unchanged; `./channel`'s budget raised to 14.5 KiB minified, 5.5 KiB gzipped (13,434 / 5,116 measured, 4 bytes under the former gzip limit; the user's decision). **Approved by the user on 2026-11-03, as built**: `liveInvalidation(app, { authorize, source })` with `authorize` required (fail closed); `live(api, queryClient, { transport })` in `./query` returning a stop function; every new name (`LiveInvalidationOptions`, `LiveOptions`, `./lib/live`, `/__live/sse?tag=`, the `<epoch>:<seq>` ids, the frame shapes); subscribe before resume, the 3 s fallback deadline and the internal constants (ring 1024, 256 tags a frame, 512 characters, 10,000 tags a socket, the 15 s heartbeat, the topic prefix); the mount order. Queued by the user as later PRs: cross-process fan-out, `useLive` in `./react`, per-tag authorization (the first and the last built 2026-11-08: the next row) |
| **PR-W4 follow-ups**: cross-process fan-out and per-tag authorization ([`websocket.md`](websocket.md) §9; queued by the user 2026-11-03) | **merged** 2026-11-08, #679, #680 and #681 (branch `feat/followups-live`), bun-common `./live`, bun-cache `./live`, a re-export in bun-nest `./cache`. **Fan-out**: a structural `LiveBus` (`publish`, `subscribe(onMessage, onGap)`) and `LiveBusMessage { origin, n, tags, truncated? }` in bun-common; `connectLiveBus(bus, { logger })` → `{ ready, close() }` and `liveInvalidation(app, { bus })`; bun-cache's `cacheLiveBus(bus, { namespace })` over any `CacheBus` (`redisBus`, `pgBus`; an `invalidate-tags` message in namespace `"bun-common/live"`, origin `<process>:<n>`; Postgres's oversized `clear` read as truncated), re-exported from bun-nest `./cache`. Local delivery first; every process numbers what the bus brings in its own epoch (wire and resume unchanged); per-origin consecutive `n` for dedup and order, one publish in flight, batched, ≤ 256 tags a message; a `gap` (a `seq` of its own, sent to every socket and stream, and answering older cursors) on every (re)subscription, a reconnect, a hole in `n` and a truncated message, so `gap` may now arrive unasked; a bus that is down never stops local delivery; one bus per process. Proved by two and three processes on Redis and Postgres (a third process on another channel never hears it). **Per-tag authorization**: `authorizeTag(tag, req)` (`AuthorizeTag`), only `true` allows (a throw or rejection refuses); a refused tag is never held, live or by resume; the `subscribe`'s `hello` lists it in `denied` (`LiveHello`, optional field), and the socket stays open; an async check holds the socket's next frames and replays what was published meanwhile; on SSE the stream holds the allowed tags with `hello.denied`, and a request whose every tag is refused gets `403` `application/problem+json` (`LIVE_TAGS_DENIED`, the tags in `denied`). An example (`examples/bun-cache/10-live/two-processes.ts`) and a playground toggle (`PLAYGROUND_LIVE_BUS`). **Approved by the user on 2026-11-08**, as built, with the SSE `403` for an all-refused request |
| **2026-11-08 follow-ups** (bun-client typing, `useLive`, relay identity; queued by the user 2026-11-03 and 2026-11-08) | **built and merged** 2026-11-08, approved by the user as built: the generator reads `x-sse-data` and `RoutesOf` marks event streams (`stream: "sse"`, `events`; manifest field `sseData`) (#686); a header declared a number or boolean takes that type and `undefined` sends nothing (#685); bring-your-own response schemas type `./query` and `./react` data, with `MutationConfig.validate` (#687); `createApiHooks(q).useLive(options?)` and `LiveOptions.onDenied` (#688), which also takes the SSE fallback's 403 `LIVE_TAGS_DENIED` as a final denial (#689; `./react` and live-chunk budgets raised, approved); the codegen watch test waits on conditions (#684); and the WebRTC relay's `signallingRelay({ identify })` pins a peer name to its session (#668). |
| **PR-G1** GraphQL ([`graphql.md`](graphql.md) §3.1, §4; §5.6, §6.4, §10.1, §10.3) | **merged** 2026-11-03, #638 (branch `feat/bun-client-graphql`), bun-client only: `@kingsleyweb/bun-client/graphql`, `createGraphQLClient({ client, url, print?, method?, throwOnGraphQLErrors? })` → `{ query, mutate }`, each call the client's own (`api.request("POST <url>")`: base URL, headers, auth refresh, middleware, timeout, logger; its `routes` under that key). Documents typed structurally through the `__apiType` phantom (`TypedDocumentNode<R, V>`, `TypedString<R, V>`, codegen's `TypedDocumentString`; a plain string untyped), no `graphql` or `@graphql-typed-document-node/core` import and no new dependency; a parsed document sent as `loc.source.body`, else through the app's `print` (**§3.1's "gql.tada documents carry their source" [I] is false**: gql.tada 1.11.4's operation documents have no `loc`, only its fragment documents do, measured; so a gql.tada app passes `@0no-co/graphql.web`'s `print`). GraphQL over HTTP: `POST` JSON with `Accept: application/graphql-response+json, application/json;q=0.9`, `GET` for queries opt-in; a query retried as idempotent under the client's settings, a mutation never; `query()` refuses a mutation document and `mutate()` a query (the operation read from the AST, or from the text by a top-level scan). Results: a 2xx GraphQL response `{ ok: true, data, errors?, extensions? }` (`errors` absent ⇒ complete `data`), any other status `{ ok: false, status, error, errors? }`; `throwOnGraphQLErrors` (default `false`) → `GraphQLResponseError`, the HTTP client's `throwOnError` → `HttpError`, both typed. BYO `validate: { result, onFailure }` through the client's checks (on `data`, path under `data`, output typing it). `./query`'s `q.graphql(gh, doc, variables?, { tags, … })`: key `[url, operationName (an anonymous operation's text), variables]`, resolving `data`, rejecting with `GraphQLResponseError`/`HttpError`, `tags` as `meta.tags`, `Cache-Tag`/`Surrogate-Key` kept. Bundle: `./graphql` 4,698 / 2,298 B (the 0.5 KB in §10.3 was an estimate), `./query` 6,859 / 2,855 (its minified limit raised to 7 KiB; the 3 KB gzip holds), `.` unchanged. **Awaiting the user**: the names beyond §16 (`query`, `mutate`, `url`, `client`, `print`, `method`, `validate.result`, `tags`, `GraphQLClient`, `GraphQLClientOptions`, `GraphQLCallOptions`, `GraphQLResult`, `GraphQLError`, `GraphQLDocument`, `TypedDocumentNode`, `TypedString`, `ResultOf`, `VariablesOf`, `q.graphql`, `GraphQLQueryOptions`, `GraphQLQueryCallOptions`) |
| **PR-P1a**, the pilot's bun-jobs half (§11, §4.3, §15.5) | **merged** 2026-11-07, #648 (branch `feat/pilot-bun-jobs-errors`): every operation of bun-jobs' own OpenAPI document carries `x-bun-errors` (all its problem codes, sorted: its statuses' `x-bun-jobs-codes` flattened, the route's own `errors` among them) and lists only the statuses it answers (no `default`; `components.responses.Problem` describes any other), so `bun-client generate` over it writes 0 warnings (69 before) and narrows every error body's `code`. `ApiErrorCode` is closed: `ApiOwnErrorCode \| ApiInternalErrorCode \| ApiForeignErrorCode`, in the browser contract with `API_ERROR_STATUS` (moved there) and `API_INTERNAL_ERROR_CODES`; `ProblemDto<TCode = ApiErrorCode>`; a 500 from a library error with an unlisted code answers `INTERNAL`. bun-jobs-ui's `ApiError.code` is `UiErrorCode`, so its 25 code comparisons and 19 `case` labels are checked (all valid). **Awaiting the user**: the `INTERNAL` fallback, dropping `default`, and the names `ApiInternalErrorCode`, `ApiForeignErrorCode`, `API_INTERNAL_ERROR_CODES`, `ProblemDto`'s `TCode` |
| **PR-P1b**, the pilot's bun-jobs-ui half (§11, §15.5) | **merged** 2026-11-07, #649, on PR-P1a (branch `feat/pilot-bun-jobs-errors`): `app/api/routes.gen.ts` generated by `bun run gen:client` from the document a real `createJobsApi()` serves (`scripts/routes-openapi.ts`: both modes, every action, the default CSRF options), 85 routes, 0 warnings, committed; `bun run check:client` and `__tests__/server/routesGen.test.ts` fail while it is stale (proved: a summon schema change made it exit 1). The summon domain calls `createClient<Routes>` through `app/api/typed.ts` (the app's own `fetch`, headers and `ApiError`; no client retries or timeout) with keys from `./query`'s `q.key`; the hooks stay. **Measured**: the 5 caller-asserted `request<unknown>` calls and 5 `assertShape<T>` casts are gone, and "no summoner here" is a typed code check; the run-time shape checks stay (`checkShape`, no cast), because the client checks no response without schemas and 3 tests pin the guard; `summon.ts` 204 → 213 lines, plus 211 of shared `typed.ts`; the real-API integration tests unchanged; bundle: entry +0.3 KiB (+0.1 gzipped), the summon chunk 9.0 → 36.2 KiB (3.3 → 12.0 gzipped; the 85-route manifest 8.0 / 1.1 of it), and two lazy chunks bun-client splits off and the app never loads (`validation` 20.7 / 7.4, `bodies` 2.3 / 1.2); within the budget. **Awaiting the user**: the summon status leaving the `["queue", q]` prefix (job mutations no longer refetch it; it polls every 5 s) |
| **PR-R1** signalling ([`webrtc.md`](webrtc.md)) | **merged** 2026-11-03, #639: bun-common `./webrtc` (`signallingContract`, `signallingRelay`), bun-client `connectPeer` |
| **PR-R2** data channels ([`webrtc.md`](webrtc.md)) | **merged** 2026-11-03, #640: `typedDataChannel` |
| NTR's PRs ([`nest-typed-routes.md`](nest-typed-routes.md)) | **merged** 2026-11-03: `Describe` #641, `DevTypesModule` #642, `@Invalidates` #643 |
| Examples (§15) | **merged** 2026-11-07, #651: `examples/bun-common/14-typed-client/` and `examples/bun-nest/12-typed-client/` |
| **PR-M1**, the documents as the model (§8.2, §8.5) | **merged** 2026-11-02, #594: `x-bun-route-key` on every operation, `RouteDoc.errors`/`cache` → `x-bun-errors`/`x-bun-cache`, `typesHash` in `./lib/docs`, and `RoutesOf`'s `send`/`receive` views (a `__schemas` phantom intersected with `ValidatorMiddleware`, which stays unchanged; the departure from §8.5 approved 2026-11-02, with `send`/`receive` and a hash covering prose). No runtime change to routing. AsyncAPI gains nothing but the hash's coverage (§8.2 assigns channels nothing). **Follow-up built** 2026-11-02 (merged as #602; approved by the user 2026-11-02): a chainable `RouteDef.describe(doc)` on `defineRoutes` definitions, the same `RouteDoc` as `BunRouter.describe()`, so a registry route declares `summary`, `errors` and `cache` without a doc on its terminal callback; merge order the terminal callback's doc, then the property name as `operationId`, then each `describe()` (an explicit one wins); `RoutesOf` unchanged |
| **PR-M2**, the dev sync (§3.3, §8.3) | **merged** 2026-11-02, #596: `devTypes(app, options)` in `./lib/docs` serves `{ hash, openapi, asyncapi }` (and each document alone) at `/__bun/types` with the hash as `ETag` and `304`, plus the `bun-types.v1` channel at `<path>/ws` (a `defineChannel`: `hello`, `changed`, `ping`), both hidden from the documents; fails closed (production throws when enabled and refuses per request, disabled registers nothing, loopback only unless `allowRemote`, bearer token or `token.<t>` subprotocol, every refusal the app's own not-found answer); lazy and cached by `routesVersion` (new counters on `BunRouter` and `BunWebSocket`, polled every 100 ms only while a watcher is connected); the token file `0600`, atomic, removed on close and at exit; a hub on `globalThis` keeps the token and watchers across a re-evaluation. bun-nest's adapter serves the channel (R12 verified by a probe). The `EADDRINUSE` this PR reported for a `BunHttpAdapter` app under `bun --hot` did not reproduce in the follow-up (2026-11-02, the same Bun build): Bun reloads a server whose address-derived `id` is taken, so the re-evaluated `listen()` reloads the running server; the follow-up pins that with child-process tests (bun-common and bun-nest) and corrects the docs. The names beyond the first §16 list (`tokenFile`, `DevTypesOptions`, `DevTypesRouter` with `token`/`tokenFile`/`listening()`/`close()`, `routesVersion`) and the protocol details (`hello.version` is the protocol version, `ping` answered with `hello`, a refusal falls through to the app's not-found, no peer address counts as loopback with the token still required, the `bun-types.v1` offer required, tokens of 16+ `[A-Za-z0-9._~-]`) were **approved by the user on 2026-11-02**, now in §16; so was a separate follow-up PR making `BunHttpAdapter.listen()` survive `bun --hot` |
| **What it builds on, now built** (§2): the contract core and its browser-safe `/contract` entry (bun-validate V1, #470), request and response checks (V2–V3c), `listRoutes`/`effectiveContract` (V12, #528), channels (`defineChannel`, V8 #525), Nest `@Validate` and gateways (V7a/b, V9), the JSON Schema converter (AD (b), #529), `generateOpenApi` (AD (a), #531), `docsRouter` (AD (c), #532), `defineRoutes`/`RoutesOf` (AD (a2), #534), class DTOs (AD (b2), #535), `generateAsyncApi` and `gatewayAsyncApi` (AD (e), #539) | **merged 2026-10-21 to 2026-10-27**. The old critical path (AD (a), (b), (b1)) is done; §2.6 says what of it changed this plan |
| bun-cache (`cacheResponse({ tags })`, `addCacheTags`, surrogate keys, Nest `@CacheTags`) | merged (#544–#588); §6.4's tags use its names |
| The SSE writer (`res.sse()`, [`bun-native-routes/README.md`](../bun-native-routes/README.md) §16 PR-sse2) | **merged** 2026-11-03, #633 (S10, `res.write()` backpressure, #663); [`sse.md`](sse.md) asks it for ids, resume and `retry:` |
| [`bun-views/`](../bun-views/README.md): hydration (its PR-5) | **not started**; §6.6's SSR waits for it |

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
14. [Answered by the user, 2026-11-02](#14-answered-by-the-user-2026-11-02)
15. [PR slicing and effort](#15-pr-slicing-and-effort)
16. [Names (approved 2026-11-02)](#16-names-approved-2026-11-02)

Sub-plans: [`websocket.md`](websocket.md), [`sse.md`](sse.md),
[`webrtc.md`](webrtc.md), [`graphql.md`](graphql.md),
[`other-transports.md`](other-transports.md) (RPC, uploads, downloads,
streams, gRPC), [`nest-typed-routes.md`](nest-typed-routes.md).

### How to read the markings

The same marks the other plans use:

| Mark | Meaning |
|---|---|
| **[S]** | Read in this repo's source at `e80ab379` (at `7dac1de4` where a 2026-10-10 claim kept its old mark). The `file:line` is given |
| **[M]** | Measured here by a spike that can be re-run. The evidence file is named |
| **[V]** | Read in a third party's docs or source at a pinned version, linked. "V-prior" when carried from another plan |
| **[I]** | Inference. A claim to test, never a finding |
| **[U]** | Unverified. Nothing may rest on it |
| **[D]** | A design decision this plan proposes |

**AD** is [`api-docs-generation/README.md`](../api-docs-generation/README.md), **BV** is
[`bun-validate/README.md`](../bun-validate/README.md), **BVW** is
[`bun-views/README.md`](../bun-views/README.md), **BC** is
[`bun-cache/README.md`](../bun-cache/README.md), **BNR** is
[`bun-native-routes/README.md`](../bun-native-routes/README.md), **NTR** is
[`nest-typed-routes.md`](nest-typed-routes.md). "The evidence" is
`docs/plans/typed-client/evidence/`; the 2026-11-02 spikes are in its
`transports/` project.

---

## 1. Executive summary

### 1.1 The one-paragraph answer

**The contract every route and channel already carries is the single source
of types and checks, for every transport.** bun-validate made it real:
`validate(schemas, { responses })` on a route, `defineChannel()` on a
WebSocket, `sse({ … })` on a stream, `@Validate`/`@ValidateMessage` in Nest,
each carrying a contract the server enforces in both directions and that
`generateOpenApi()` and `generateAsyncApi()` already publish as OpenAPI 3.1
and AsyncAPI 3.0. The client reads **those documents** (plus three `x-bun-*`
extensions for route keys, error codes and cache tags) to generate a typed map
per transport, or, in a monorepo, **infers** the same types from the shared
contract modules (`RoutesOf` for routes, `channelContract()` for channels);
a dev-only endpoint pushes a changed document's hash so the generated file
follows the server **49 ms** after a save under `bun --hot` [M, `sync/`].
On the client, a dependency-free core (`@kingsleyweb/bun-client`) gives each
transport a call keyed by a literal (a path, a message `type`, an event name):
`api.get("/users/:id")`, `channel(api, chat).request("say", …)`,
`sse(api, "GET /jobs/:id/events")`, `typedDataChannel(rtc, chat)`,
`gql.query(UserQuery)`; **it validates what it sends and what it receives with
the same guards the server runs** (the contract core, extracted to a
zero-dependency package and loaded only when validation is on), plus any
Standard Schema the app brings. The data layer is `@tanstack/query-core`;
live invalidation is one typed channel. WebRTC is typed where it has data
(signalling and data channels; media cannot be); GraphQL, which bun-node does
not serve, gets a 0.3 KB typed call over the HTTP core, typed by the app's
gql.tada or graphql-codegen.

### 1.2 The decisions

Changed or new on 2026-11-02 are marked **(rev)** and **(new)**.

| # | Decision | Why |
|---|---|---|
| D1 **(rev)** | **The type source is the contract, published as OpenAPI 3.1 and AsyncAPI 3.0**, with `x-bun-route-key`, `x-bun-errors` and `x-bun-cache`. The old bespoke `RouteModel` is dropped; the hash is over the two canonical documents. | Both generators are built and read the same contracts the server enforces (BV V-D14; `docs/openapi.ts:756`, `docs/asyncapi.ts:279`) [S]; Nest controllers reach them through reflect metadata (#538) and gateways through `gatewayAsyncApi` [S]; and the generator then types any third-party OpenAPI or AsyncAPI service too. §3.0 |
| D2 | **The route author's shape is AD's**, now built: `validate(schemas, { responses })` before the handler, `.describe({ … })` after. This plan adds two `.describe()` fields (`errors`, `cache`), written as the extensions. | Nothing new to learn; `RouteDoc.extensions` already carries `x-*` (`docs/routeDoc.ts:137`) [S]. §8.1 |
| D3 | **Generation plus live sync is the default for every layout**; **inference is opt-in** through `defineRoutes()` (built, #534) and shared channel contracts. | Unchanged reasons [M, 2026-10-10]; measured again for channels: generated 1.25 s against inferred 6.61 s of tsc at 200 channels, both under 0.33 s with `bun --check` [M, `transports/ws-typing/`]. §3.4 |
| D4 | **The live sync is a dev-only endpoint serving the documents with an `ETag`, plus a WebSocket announcing their hash**; fail closed (production refuses, `enabled: true`, token, loopback, 404). | 49 ms edit-to-file under `--hot` [M]. §3.3 |
| D5 **(rev)** | **The client sends each field's wire input and receives the wire side after JSON**: `WireInput<S>` for params, query, headers and bodies; `Jsonify<WireInput<S>>` for responses and received messages, the output only under `responseOutput: "parsed"`. | BV's rule, approved 2026-10-17 (BV §4.12 M1, M2) and built (`contract/model.ts:443`; `docs/openapi.ts:1107-1108`) [S]. The old D5 typed responses from the output. §4.1 |
| D6 | **Responses come from declared schemas.** Undeclared → `{ 200: unknown }` and a warning; an undeclared status **throws** `UnexpectedStatusError`. | Unchanged. §4.2 |
| D7 | **A call returns a result discriminated by status**; errors are problem+json with a generated `code` union from `x-bun-errors`. | bun-jobs-ui still compares error codes as strings: 25 comparisons and 19 `case` labels (survey, §2.5) [S]. §4.3 |
| D8 | **Built-in runtime schemas**: the server's own, through the shared contract module, in a monorepo; **generated `zod/mini`** from the documents' JSON Schema otherwise, in `/zod`, zod an optional peer. | §5.1, §5.2 [M]. |
| D9 | **Bring your own validator: any Standard Schema, run after the built-in one**, issues merged into one `ValidationError`; `replace: true` drops the built-in. | §5.4. |
| D10 | **Every behaviour is configurable at three levels, global → per route (or channel) → per call, later wins.** | The user's request. §6.2 |
| D11 **(rev)** | **Validation defaults on every transport: on in development, off in production; what the client sends fails by throwing, what it receives fails by warning and delivering.** | One rule for HTTP, channels, SSE, data channels (§5.6). Costs as measured [M]. §5.5 |
| D12 | **The data layer is `@tanstack/query-core`** (optional peer, `^5`). | §7.2 [M]. |
| D13 **(rev)** | **Cache tags are declared on routes** (`.describe({ cache: { tags, invalidates } })`) with bun-cache's vocabulary; a response's `Cache-Tag`/`Surrogate-Key` header (bun-cache's `surrogateKeys`) adds runtime tags. | bun-cache shipped `cacheResponse({ tags })`, `addCacheTags` and surrogate-key headers (`bun-cache/lib/http/cacheResponse.ts:278-293`) [S]. §6.4 |
| D14 | **Revalidation is conditional** (`If-None-Match`, keep data on 304). | Unchanged. §6.4 |
| D15 **(rev)** | **Live queries push invalidations over one typed channel** (`liveContract`, a `defineChannel`), with SSE as the fallback; a gap invalidates every active query. | It gets validation, AsyncAPI and the client from [`websocket.md`](websocket.md) instead of a bespoke protocol. websocket.md §9 |
| D16 | **SSR uses bun-views' props channel** and in-process `router.fetch()`. | Unchanged; **waits for BVW PR-5**, not started. §6.6 |
| D17 **(rev)** | **No runtime code reaches a browser bundle from bun-common or the server**: the client's only runtime import of ours is the zero-dependency contract package (D20), guarded by a bundle-safety test. | §10.3. |
| D18 **(rev)** | **The Nest half shrinks**: controllers already reach `listRoutes`/`generateOpenApi`, gateways `gatewayAsyncApi`; NTR keeps a dev-types module, `@Invalidates` and the gateway codec. | #538, #539 [S]. §9, NTR |
| D19 | **bun-jobs and bun-jobs-ui are the first consumer, as a pilot of one domain.** | Its 84 routes now carry contracts (`define.ts:696`) and it serves its own OpenAPI [S]. §11 |
| D20 **(new)** | **One validation core on both ends**: the client's guards are the contract core's (`createSender`, `createReceiver`), from **`@kingsleyweb/bun-contract`**, a zero-dependency package extracted from bun-common's `lib/contract/` and re-exported unchanged at `@kingsleyweb/bun-common/contract`. | The core imports only bun-common's logger and the vendored Standard Schema types (§2.1) [S]; it bundles for a browser at **6.8 KB gzip** with no server marker [M, `transports/contract-reuse/`], loaded lazily so a production bundle with validation off carries none. A copy would drift; depending on bun-common would install 11 server dependencies in every frontend. §10.1 |
| D21 **(new)** | **Every transport gets the same three things**: a type source from the contract (inferred or generated), a call keyed by a literal, and validation of both directions under D11's policy. | The user's "auto typings, validation for all kind of request". §3.5, §5.6 |
| D22 **(new)** | **WebSocket**: one client per channel with `send`, `request` (correlation id, from the contract's `replies`), `on`/`messages`; codecs for bun-common frames and bun-nest packets; reconnect, resubscribe, offline buffer, `sendWhenReady`. | [`websocket.md`](websocket.md) |
| D23 **(new)** | **SSE**: a `fetch`-based client with `Last-Event-ID` resume, typed by the route's `sse()` declaration. | Bun has no `EventSource` (oven-sh/bun#8474) and `EventSource` sends no headers [M, V]. [`sse.md`](sse.md) |
| D24 **(new)** | **WebRTC**: a typed signalling contract and relay, and a typed data-channel wrapper; **no media, no WebRTC dependency**. | Bun has no `RTCPeerConnection`; node-datachannel and werift work as Bun peers [M, `transports/webrtc/`]. [`webrtc.md`](webrtc.md) |
| D25 **(new)** | **GraphQL**: bun-node serves none; a typed GraphQL call over the HTTP core, typed by `TypedDocumentNode`, built on demand. No GraphQL server, no codegen of ours. | 0.3 KB gz of ours [M]. [`graphql.md`](graphql.md) |
| D26 **(new)** | **"etc."**: named operations, typed uploads, downloads and streamed bodies are in; gRPC, Connect and JSON-RPC are out. | [`other-transports.md`](other-transports.md) |

### 1.3 What it costs

| Part | Effort | Depends on |
|---|---|---|
| Prerequisites in bun-common: the contract package, the documents as the model, the dev sync (PR-K, PR-M1, PR-M2) | ~6.5 d | — |
| **HTTP**: client core with named operations, generator, watcher, validation and `/zod`, query layer, React, persistence, bodies (PR-C1 to C6, C8, C9; the old C7 moved to PR-W4) | ~25.5 d | PR-K for C4 on; PR-M1 for C2 on |
| **WebSocket and SSE**: server pieces, channel client, Nest codec, live invalidation, SSE client (PR-W1 to W4, PR-S1) | ~16.5 d, plus ~1 d asked of BNR PR-sse2 | the HTTP core |
| **WebRTC**: signalling, data channels (PR-R1, R2) | ~4 d | PR-W2 |
| **GraphQL**, on demand (PR-G1) | ~2 d | PR-C5 |
| Nest (NTR, revised) | ~4 d (was ~13) | PR-M2, PR-W2 |
| Pilot in bun-jobs-ui (one domain) | ~3.5 d | PR-C2, PR-C5 |
| Examples, per PR | ~5 d | each PR |
| **Total, React first** | **~67 d**, of which GraphQL 2 d on demand; plus ~6 d of other bindings on demand | |

The old plan's ~47.5 d covered HTTP and live invalidation only, and needed
AD's 15–20 d first; AD is built, so the HTTP part is now ~32 d of the total.
§15 has the order, what each PR proves, and the gates.

### 1.4 The transports at a glance

| Transport | Type source (monorepo / separate repo) | Client call | Both directions checked | Reconnect, resume, backpressure | Plan |
|---|---|---|---|---|---|
| HTTP | `RoutesOf<typeof api>` / OpenAPI → `Routes` | `api.get("/users/:id", …)`, `api.op.getUser(…)` | request parts before sending; response by status | retries, timeouts, auth refresh; ETag revalidation | §3–§7 |
| Multipart, downloads, streamed bodies | the body's media map / OpenAPI | the same calls; `Blob`, `ReadableStream`, `AsyncIterable` | fields; per NDJSON chunk | — | [`other-transports.md`](other-transports.md) |
| WebSocket channel | `channelContract()` module / AsyncAPI → `Channels` | `channel(api, chat).send/request/on` | every sent and received frame | backoff, heartbeat, resubscribe, offline buffer, `sendWhenReady` | [`websocket.md`](websocket.md) |
| Nest gateway | shared `as const` maps / `gatewayAsyncApi` | the same, with the `"bun-nest"` codec | payloads and acks | the same | [`websocket.md`](websocket.md) §11 |
| SSE | the route's `sse()` declaration / OpenAPI `x-sse-events` | `sse(api, "GET /…")`, async iteration | every event | `Last-Event-ID`, `retry:`, backoff | [`sse.md`](sse.md) |
| WebRTC signalling | `signallingContract` (shipped) | a channel | every frame | the channel's | [`webrtc.md`](webrtc.md) |
| WebRTC data channel | a shared `channelContract()` | `typedDataChannel(rtc, contract)` | every JSON message; binary kind and size | `bufferedamountlow` | [`webrtc.md`](webrtc.md) |
| Live invalidation | `liveContract` (shipped) | `live(api)` in `/query` | every frame | resume by `{ epoch, seq }`, gap → invalidate all | [`websocket.md`](websocket.md) §9 |
| GraphQL (external) | the app's gql.tada or graphql-codegen | `gql.query(Doc, vars)` | BYO result schema only | the HTTP core's | [`graphql.md`](graphql.md) |
| Media tracks, gRPC, Connect | — | — | — | — | out |

---

## 2. What exists today

### 2.1 The contract core (bun-validate, built 2026-10-21 to 10-27)

All [S]:

- **`@kingsleyweb/bun-common/contract`** is a browser-safe entry
  (`package.json` `exports["./contract"]`; `lib/contract/index.ts:1-71`):
  `defineTransport`, `attachContract`/`getContract`/`forwardContract`
  (`contract/transport.ts:184-293`), `describeContract`/`mergeContracts`
  (`contract/describe.ts:271`, `:419`), the guards `createReceiver` and
  `createSender` (`contract/guard.ts:430`, `:463`), `validateStandard`,
  `documented`/`recordOf`, and the channel half (`channelContract`,
  `wsTransport`, the error frame; `contract/channel.ts`).
  `__tests__/contract/browserSafety.test.ts` bundles it for a browser. The
  whole of `lib/contract/` imports only `../logging` and
  `../types/standardSchema` from the rest of bun-common (grep of its imports),
  which is what makes D20's extraction a move, not a rewrite.
- **The client's type rules are in it**: `WireInput<S>` (each field's input,
  or its output where the input is `unknown`, deep; `contract/model.ts:443`),
  `Sent`/`Received` per side (`:528-531`), `ContractWire` (`"json"` or
  `"identity"`, `:103`) and each row's `ContractEncoding` (`path-string`,
  `querystring`, `header-string`, cookies, `body`; `:79-87`). BV §4.12
  folded the 2026-10-17 review of this plan into it (M1–M7, m1–m12).
- **Body kinds**: `chunks()`, `sse()`, `opaque()` declare streamed, event and
  unread bodies (`responseBodies.ts:166`, `:204`, `:264`), and rows say which
  (`ContractKind`, `contract/model.ts:95`).

### 2.2 Routes: listing, documents, registry

- **`listRoutes(router)`** (`routeModel.ts:293`) gives every endpoint's key
  (`"GET /users/:id"`), path, params and **effective contract**
  (`effectiveContract`, `:127`: the contracts of every layer that runs,
  merged outermost first, `commonResponses` included), described
  (`ListedRoute`, `:174-216`). Rows carry the live schema objects, not JSON.
- **`generateOpenApi(router, options)`** (`docs/openapi.ts:756`, AD (a),
  #531) builds OpenAPI 3.1 from that listing and `.describe()` docs, with
  responses converted from the **wire side** (input) unless
  `responseOutput: "parsed"` (`:1107-1108`), stream events under
  `x-sse-events` (`:1819-1835`), variants under `x-variants`, and warnings for
  what OpenAPI cannot express. `RouteDoc` takes `summary`, `description`,
  `tags`, `operationId`, `deprecated`, `hidden`, `request`, `responses`,
  `security` and **`extensions` (`x-*`)** (`docs/routeDoc.ts:42-137`).
- **`generateAsyncApi(router, options)`** (`docs/asyncapi.ts:279`, AD (e),
  #539) documents `defineChannel` channels (upgrade side, envelope and its id
  field, replies as `operation.reply`, subprotocol, binary, topics, SSE
  fallback; `:608-800`) and SSE endpoints (`:846`).
- **`docsRouter()`** serves both documents and viewers (`docs/router.ts:190`,
  AD (c), #532); `@kingsleyweb/bun-api-docs-ui` is the self-hosted viewer
  (AD (f), #541/#542).
- **`defineRoutes(mount, build)` and `RoutesOf<T>`** (`defineRoutes.ts:143`,
  `:242`, AD (a2), #534): this plan's §8.5 registry, built with its approved
  names. **One gap for a client**: `RoutesOf`'s entries are the validator's
  **parsed** shape (`:255-261`, from `InferValidatedShape`, `BunValidate.ts:187`),
  i.e. the receiver's view; a client must send the **wire input** (D5), so a
  defaulted query key reads as required and a transform's output stands in
  for its input. PR-M1 adds the sender view (§8.5).
- **Not built**: a serialised route model with a hash, the dev endpoint
  (`devTypes`), any type generator, any client. Measured by grep for
  `RouteModel`, `devTypes`, `__bun/types`: nothing [S].

### 2.3 Channels and streams

- **`defineChannel(spec)`** (`channel.ts:196`, BV V8, #525): upgrade checks,
  every received frame checked (error frames for invalid, unknown and
  unsupported data), typed and checked `send`/`publish`. Gaps for a client
  (`websocket.md` §2): replies do not echo the request id, although the
  AsyncAPI document says they do (`docs/asyncapi.ts:617` documents an echoed
  id that the handler dispatch, `channel.ts:296-308`, never sends; **PR-W1
  fixes it**); `send` drops Bun's backpressure status; socket params are
  untyped.
- **`router.ws()`** takes a middleware chain (#536, `BunRouter.ts:1918-1975`).
- **SSE**: the `sse()` declaration and its per-event checks exist; the
  writer is BNR PR-sse2 (merged 2026-11-03, #633; `sse.md` Status).

### 2.4 bun-nest

`@Validate` with responses and `reply()` (BV V7a/b; `bun-nest/lib/validate.ts:1255`),
`StandardSchemaPipe` and `StandardValidationPipe` (V6; `validation.ts:312`,
`:451`), gateway validation `@ValidateMessage`/`@Emits`/`TypedSocket` (V9;
`wsValidation.ts:94-390`), `gatewayAsyncApi()` (AD (e);
`gateway-docs.ts:195`). **A controller's `@Validate` contract reaches
`listRoutes(adapter.instance)` and `generateOpenApi()`** through reflect
metadata Nest copies onto the handler (#538;
`bun-nest/__tests__/validateContractDocs.nest.test.ts:42-58`) [S], which
removes the need for NTR's explorer (§9).

### 2.5 bun-jobs and bun-jobs-ui: what a typed client would remove

Re-surveyed at `e80ab379` (counts by grep; commands in the progress notes of
this revision) [S]:

- **The server**: 84 `defineRoute(` call sites (87 routes, one factory used
  four times; `bun-jobs/lib/api/routes/define.ts:219`), each now carrying a
  bun-common contract on its terminal layer (`forwardContract`, `:696`), so
  `listRoutes` sees them (BV M5). It still generates **its own** OpenAPI and
  AsyncAPI (`spec/openapi.ts:259`, `spec/asyncapi.ts:330`), not bun-common's.
  Its WS frames are checked inbound (`ws/session.ts:461`) but **not
  outbound** (`:1551`). Its error codes are an open union server-side
  (`ApiErrorCode = ApiOwnErrorCode | (string & {})`, `lib/api/errors.ts:110`)
  and `ProblemDto.code` is `string` in the browser contract
  (`contract/types.ts:76-77`).
- **The browser contract** (`api/contract`): 184 types, 88 exports in
  `constants.ts`, 23 WS frame types; still **no route table and no error-code
  union**.
- **The UI** (`bun-jobs-ui/app/api/`): 19 files, 3,374 lines; 73 lines with
  `request<` (64 `api.request<T>` calls with a caller-asserted `T`, plus 7
  untyped); 18 path helpers (`jobPath` still in both `queues.ts:192` and
  `jobs.ts:96`); **11 query-key factories**; **15 `assertShape<` sites**
  (`api/shape.ts:28`); **25 string comparisons of error codes plus 19
  `case "CODE":` labels**; the WS frame still cast unchecked
  (`app/live/client.ts:983`). It imports nothing from bun-common in `app/`.
  (The 2026-10-10 survey's "78 calls" and "20 assertShape sites" were counted
  with looser patterns; the same patterns at `7dac1de4` give 72 and 21 lines.)
- **Its live client** is the tuned reconnect reference
  (`app/live/client.ts:366-384`, `:618-664`, `:1018-1041`; `live.ts:219-263`).

### 2.6 What of the old critical path is done

| Old prerequisite (2026-10-10) | Now |
|---|---|
| AD (a) `.describe()` and discovery | **built** (#531): `listRoutes` + `routeDocFor` |
| AD (b) `__schemas` and the converter | **built**, differently: the contract on each layer (`getContract`, BV V-D14) replaces `__schemas`; the converter is #529 |
| AD (b1) responses on the validator | **built** as BV V3a (#482) |
| AD (b0) spec types | **built** (#527) |
| AD (e) AsyncAPI / `WsChannelDoc` | **built** (#539) |
| AD (a2) registry | **built** as `defineRoutes`/`RoutesOf` (#534) |
| AD (g) Nest `@Validate` | **built** as BV V7a/b (#522, #523) |
| Old PR-M4 typed channels (`defineChannel`, model `channels`) | **server built** (V8, #525); the client is `websocket.md` |
| Old PR-M1 route model | **mostly built**: `listRoutes` is the discovery and the generators are the serialisation; what is left is three extensions, a hash and the sender view (§8.2) |
| BC tags (`cacheResponse`, `invalidateTags`) | **built** (bun-cache) |
| BNR PR-sse2 (`res.sse()`) | **merged** 2026-11-03, #633 (branch `feat/bun-common-sse-writer`), with `sse.md` §4's four additions |
| BVW PR-5 (hydration) | not started |

### 2.7 Prior art

The 2026-10-10 survey stands (typed clients, data layers, streaming), read
at the versions it names [V]:

| Library | How types travel | Responses and errors | Scale notes | Dev regeneration | Client runtime |
|---|---|---|---|---|---|
| Elysia Eden Treaty 1.4.9 | inference: each verb returns a new `Elysia<…, Routes & CreateEden<…>>` [V] | per status, `data`/`error` [V] | "use Eden Fetch over 500 routes" ([eden/fetch](https://elysiajs.com/eden/fetch)) [V] | none (tsserver) | 3.3 KB gz [V] |
| Hono RPC 4.13.13 | inference; routes must be **chained** ([guide](https://hono.dev/docs/guides/rpc)) [V] | `c.json(body, 404)`, `InferResponseType<T, 200>` [V] | "compile the client type with tsc" [V] | none | 2.1 KB [V] |
| tRPC 11.19 | inference from `typeof appRouter` [V] | RPC codes, no per-status union [V] | lazy evaluation halved check time ([blog](https://trpc.io/blog/typescript-performance-lessons)) [V] | none | 9.2 KB [V] |
| oRPC 1.15.5 | router-first inference, or a contract [V] | `errors({ NOT_FOUND })` [V] | TS7056 on one big exported router ([docs](https://orpc.dev/docs/advanced/exceeds-the-maximum-length-problem)) [V] | none | 8.1 KB [V] |
| ts-rest 3.52.1 | a shared contract object [V] | `{ status, body }` union [V] | — | not needed | 1.9 KB [V] |
| openapi-typescript 7.13 + openapi-fetch 0.17 | codegen from OpenAPI to a `paths` type [V] | `{ data, error }` [V] | plain interfaces [I] | **no watch** [V] | 2.7 KB gz [M] |
| orval 8.41 / Kubb 5.5.6 / hey-api 0.99 | codegen to hooks + zod [V] | per status [V] | — | orval watches files; **Kubb polls every 2 s; hey-api every 1 s with `If-None-Match`** [V] | per generator |
| nestia 14.0.3 | a TS transform (ttsc) reading controllers [V] | `propagate` unions [V] | — | — | under Bun only through a preload [V] |
| socket.io | two interface maps for events [V] | acks typed by callback [V] | — | — | validates nothing [V] |
| gql.tada 1.11.4, graphql-codegen client preset | GraphQL: inference from an introspection `.d.ts` (gql.tada), or codegen per operation; both emit `TypedDocumentNode` [V] | `{ data, errors }` | `graphql.md` §2.1 [M] | GraphQLSP in the editor | 3.4 KB gz with its parser [M] |

**Nobody pushes types from a running server**, still [V, 2026-10-10]; and
socket.io, the common typed WebSocket layer, validates nothing [V]. Whether
any surveyed client validates both directions on more than HTTP was not
re-surveyed on 2026-11-02 [U]; nothing in this plan rests on it. Data layers
and streaming notes: §7.2 and the 2026-10-10 tables in
[`evidence/bundle-size/results.txt`](evidence/bundle-size/README.md).

---

## 3. How types get from the backend to the client

### 3.0 The model is the documents [D]

The old plan designed a `RouteModel` JSON of its own. Since then the server
grew two generators that walk exactly what that model would have walked (BV
V-D14: "docs and the typed client read one thing"), and serialise it to
standards. So **the model a client reads is the pair**:

| Document | Produced by | Covers |
|---|---|---|
| OpenAPI 3.1 | `generateOpenApi(router)` (bun-common), bun-jobs' own generator, `@nestjs/swagger` for a Nest app without `@Validate` | every HTTP route: parameters, request bodies by media type, responses by status with headers and media types, SSE event maps (`x-sse-events`), variants |
| AsyncAPI 3.0 | `generateAsyncApi(router)`, `gatewayAsyncApi(app)` (bun-nest), bun-jobs' own | channels (both directions, replies, envelope, upgrade side), Nest gateways (events, acks), SSE endpoints |

plus three extensions this plan adds to bun-common's OpenAPI output [D]:

| Extension | On | Value | Why a client needs it |
|---|---|---|---|
| `x-bun-route-key` | each operation | `"GET /users/:id"`: the Express-syntax key | the client's map is keyed by the server's own path string, so a search finds both (§6.1); OpenAPI's `{id}` loses Express forms such as `*name` |
| `x-bun-errors` | each operation | `["NOT_FOUND", "CONFLICT"]`, from `.describe({ errors })` | the `code` union (D7) |
| `x-bun-cache` | each operation | `{ tags: ["user:{id}"], invalidates: ["users"] }`, from `.describe({ cache })` | tags and invalidation (D13) |

- **The hash** (the change detector of the live sync, §3.3) is sha-256 over
  the canonical JSON of both documents (keys sorted), 16 hex characters, as
  before.
- **A document from elsewhere works**: any OpenAPI 3.1 or AsyncAPI 3.0 with
  no `x-bun-*` gets keys derived from its paths (`{id}` → `:id`), no code
  unions and no tags. So the same generator types a third-party API, which
  the old bespoke model could not.
- **What a document cannot express**, the generator reports, as the
  generators already do: a path OpenAPI cannot template (regex-constrained,
  host-scoped) is listed with a warning and left out (`ListedRoute.partial`,
  `routeModel.ts:209-216`; AD's `undocumentable`) [S]; such a route is still
  callable untyped (`api.request("GET /x", …)` with a cast).
- **The TypeScript side is unchanged**: one flat map per transport, keyed like
  the server (`Routes` keyed `"GET /users/:id"`, `Channels` keyed by channel
  path), which generation and inference both produce:

```ts
export interface Routes {
  "GET /users/:id": {
    operationId: "getUser";
    params: { id: string };
    query: Record<never, never>;
    body: undefined;
    responses: { 200: User; 404: Problem<"NOT_FOUND"> };
    cache: { tags: ["user:{id}"] };
  };
}
```

A flat map is the cheapest shape for a checker (§3.2) [M].
`Record<never, never>`, not `Record<string, never>`, for "no keys" [M,
2026-10-10].

### 3.1 (a) Inference: the server's types, no generation

Measured on 2026-10-10 against the real `BunRouter` (TypeScript 6.0.3,
median of three, through the heavy-run wrapper) [M, `inference/results.txt`]:

| Routes | v0 check / memory | v1 (router accumulates) | v2 (registry) | client against emitted `.d.ts`: v1 / v2 |
|---|---|---|---|---|
| 50 | 2.03 s / 306 MB | 2.92 s / 394 MB | 2.49 s / 300 MB | 3.03 s / 2.18 s |
| 200 | 3.15 s / 423 MB | 3.89 s / 500 MB | 2.96 s / 385 MB | 3.42 s / 2.22 s |
| 1000 | 6.92 s / 843 MB | **10.30 s / 973 MB (+49%)** | **7.07 s / 928 MB (+2%)** | 4.72 s / 1.77 s |

The v2 registry was built as `defineRoutes()` (#534), with no change to the
verb overloads, as this plan decided. Statements cannot accumulate a returned
type (assertion signatures narrow a variable but break chaining and stop at
function boundaries) [M, `inference/probes/`]. **Channels** infer from the
shared `channelContract()` module; measured on 2026-11-02 at 10/50/200
channels [M, `transports/ws-typing/`]:

| Channels × 16 messages | declare only | inferred client | generated map |
|---|---|---|---|
| tsc 6.0.3, check s / MB | 0.67 / 123; 1.03 / 218; 3.92 / 456 | 0.87 / 177; 2.13 / 327; **6.61 / 1,022** | 0.42 / 90; 0.62 / 151; **1.25 / 230** |
| `bun --check`, wall ms | 80; 68; 121 | 88; 134; **324** | 39; 49; **60** |

**Under `bun --check`, the repo's checker, both forms check in a third of a
second at 200 channels**; the tsc row is what a consumer on TypeScript 6
pays. The HTTP rows above were measured with tsc only, against the
2026-10-10 spike's client. PR-C2 measured the real client (`Client<…>`,
bun-client) over the real generator's output, on 2026-11-02, median of three,
through the heavy-run wrapper [M, `transports/http-typing/results.txt`]:

| Routes | registries alone (tsc s / MB; `bun --check` ms) | client over `RoutesOf` | client over the generated map |
|---|---|---|---|
| 50 | 2.26 / 340; 132 | 3.14 / 419; 186 | **0.51 / 130; 38** |
| 200 | 3.62 / 456; 156 | 5.70 / 616; 406 | **1.25 / 154; 56** |
| 1000 | 7.79 / 1,032; 280 | 17.52 / 1,360; 1,817 | **7.16 / 327; 208** |

The generated map's program holds no server code, so it is checked in a
fraction of the inferred one's time and memory at every size. **Under
`bun --check` the inferred client stays under a second to 200 routes and
takes 1.8 s at 1000; the generated one stays under a quarter of a second**.
The tsc figure for the generated map at 1000 routes (7.16 s), against the
2026-10-10 spike's 0.75 s, is likely the real client's per-call types over a
1000-key map rather than the map itself [I: not measured apart]; its memory
is a quarter of inference's. Generating 1000 routes took 297 ms (607 KB).

### 3.2 (b) Generation: the documents to a `.d.ts`

The 2026-10-10 spike generated a correct `Routes` from statement-style
routes on the unpatched router, `Equal` to inference for representable
schemas, with a `z.date()` the documented difference [M, `codegen/`]; at
1000 routes, emitting took 22 ms, the file was 527 KB, and **a client file
checked against it in 0.75 s and 150 MB**, against 1.8 s (registry) and
4.7 s (accumulating router) through emitted declarations [M,
`codegen/scale-results.txt`]. Its emitter read the spike's model; PR-C2's
reads OpenAPI and AsyncAPI, whose schemas are the same JSON Schema the spike
emitted from, with `$ref`s into `components.schemas` that become **named
types** (`User`, not an inlined object) [D].

```bash
bunx bun-client generate --url http://127.0.0.1:3000/__bun/types --out src/api.gen.ts [--zod src/api.zod.gen.ts]
bunx bun-client generate --openapi ./openapi.json [--asyncapi ./asyncapi.json] --out …   # any documents, any server
bunx bun-client generate --module ./server/app.ts --export app --out …                   # in process, no server running
bunx bun-client generate … --check                                                        # CI: exit 1 if stale
```

`--module` imports the app and calls `generateOpenApi`/`generateAsyncApi`
on it, so CI needs no running server. The file's header records the hash.

### 3.3 (c) Live sync in development

Measured on 2026-10-10 end to end [M, `sync/`]:

| Server run as | Save → client file changed, median / p90 |
|---|---|
| `bun --hot` | **49 ms / 68 ms** |
| `bun --watch` | 160 ms / 163 ms |
| polling every 1 s (hey-api, Kubb) | 560 ms / 1,043 ms |

**The protocol [D]**, now over the documents:

| Piece | Shape |
|---|---|
| Documents endpoint | `GET <path>` (default `/__bun/types`): `200` with `{ hash, openapi, asyncapi }`, `ETag: "<hash>"`, `Cache-Control: no-store`; `304` on a matching `If-None-Match`. `<path>/openapi.json` and `<path>/asyncapi.json` serve each alone, for third-party tools (hey-api's and Kubb's watchers poll such a URL [V]) |
| Channel | WebSocket at `<path>/ws`, subprotocol `bun-types.v1`, declared with `defineChannel` like any channel (so it is itself typed and checked): server → client `hello { version, hash }` and `changed { hash, at }`; client → server `ping`. It carries hashes, never documents |
| Change detection | the hash; recomputed on a `--hot` re-evaluation (the hub on `globalThis`), a `--watch` restart (the greeting), and a route or channel registered at runtime (a `routesVersion` counter, polled every 100 ms only while a watcher is connected) |
| Cost when unused | built lazily, only on a `GET` or while a watcher is connected (1000 routes took ~0.3 s in the spike [M]) |
| Watcher | `bun-client watch`: compares hashes, fetches with `If-None-Match`, emits, writes atomically and only when the content changed; reconnects with backoff (50 ms → 2 s) |

PR-C3 measured the shipped server and watcher on 2026-11-02
([`evidence/watch/`](evidence/watch/README.md)): `bun --watch` 170 ms /
178 ms; `bun --hot` 139 ms / 146 ms, of which up to 100 ms is `devTypes()`
waiting for its next route poll after a re-evaluation (the spike announced at
once); the watcher's own fetch and write take 1–14 ms.

**Auth and exposure: fail closed [D]**, unchanged: `enabled` must be `true`;
`NODE_ENV=production` throws a `ConfigError` even when enabled; a bearer
token (random per process unless given) written `0600` to
`node_modules/.cache/bun-types/<port>.json` for the watcher, and accepted as
a second subprotocol (`bun-types.v1, token.<t>`) from a browser tool;
loopback peers only unless `allowRemote: true`; **404** for anything refused;
hidden routes stay hidden. The spike measured no token → 404, token → 200,
ETag → 304, production refuses to start [M]. `docsRouter`'s public
documents (AD (c)) are a separate, production feature with the app's own
`authorize`; the dev endpoint never replaces them.

### 3.4 Recommendation per layout [D]

| Layout | Types | Runtime schemas | In development | In CI |
|---|---|---|---|---|
| **Separate repos**, or a third-party API | generated `Routes` and `Channels` | generated `zod/mini` (§5.2) | `bun-client watch` | `bun-client generate --url <staging> --check`, or the server repo publishes the documents |
| **Monorepo, default** | generated, committed | the shared contract modules' own schemas when browser-safe, else generated | `bun-client watch` | `bun-client generate --module … --check` |
| **Monorepo, opt-in** | inferred: `RoutesOf<typeof api>` (with the sender view, §8.5) and `channelContract()` modules | the shared modules' own | the language server | `bun scripts/typecheck.ts` |

Generation stays the default in a monorepo for the reasons measured on
2026-10-10 (statement-style routes need no registry; the client checks an
order of magnitude faster under tsc). Approved 2026-11-02 (Q1).

### 3.5 Auto typing, transport by transport [D]

"Auto typing" means the app writes **no client-side type**: every type comes
from a declaration the server already enforces.

| Transport | What the server author writes (already, unless marked) | Inferred from (monorepo) | Generated from | What stays manual |
|---|---|---|---|---|
| HTTP | `validate({ params, query, body, headers }, { responses })`, `.describe()` | `RoutesOf` | OpenAPI | nothing; an undeclared response is `unknown` with a warning |
| Uploads, downloads, streams | a body media map; `opaque()`, `chunks()`; **new**: `.describe({ request: { files } })` | the same | OpenAPI (`format: binary`, kinds) | file content |
| SSE | `sse({ event: schema })` as a response | `RoutesOf` | OpenAPI `x-sse-events` / AsyncAPI | — |
| WebSocket | `defineChannel` / **new**: `channelContract()` in a shared module | the shared module | AsyncAPI | the app's subscribe/resume messages (declared like any message) |
| Nest HTTP | `@Validate` | — (decorators are invisible to the type system) | OpenAPI from `generateOpenApi(adapter.instance)` | — |
| Nest gateways | `@ValidateMessage`, `@Emits` with shared `as const` maps | the shared maps | `gatewayAsyncApi` | — |
| WebRTC | **new**: `signallingContract`, a `channelContract()` per data channel | the shared module | AsyncAPI (signalling only; data channels have no server) | media |
| GraphQL (external) | — (someone else's server) | gql.tada inference from the introspection | graphql-codegen | the app's choice of tool |

---

## 4. Requests, responses and errors, as types

### 4.1 Input or output: which side of a schema the client sees [D] [M]

**Revised 2026-11-02 to BV's rule** (BV §4.1.4, §4.12 M1/M2, approved
2026-10-17 and built as `WireInput`, `contract/model.ts:443`) [S]. The old
table typed responses from the schema's output; BV's review showed the wire
carries what the handler sent, which the **input** describes (P2 there).

| Part | Type the client uses | Why |
|---|---|---|
| params, query, headers | **`WireInput<S>`**: each field's input, or its output where the input is `unknown` (a coercion), with the input's optionality, deep | They cross as strings and are coerced. `z.coerce.number()` has input `unknown` in zod 4: typed from the input, `{ page: "x" }` compiled, and the negative control caught it [M, `inference/`]. A key with a default is optional for the sender [M, `codegen/`] |
| body | `WireInput<S>` | JSON crosses as it is; transforms run on the server |
| cookies | not a browser call option; documented only (BV m4) | the browser sends them |
| responses, received messages and events | **`Jsonify<WireInput<S>>`**, or `Jsonify<output>` for a route under `responseOutput: "parsed"` (BV V13) | what the handler sent, after `JSON.parse`: a `Date` becomes `string`, a function or `undefined` field disappears. The OpenAPI generator already converts responses from the input side unless `"parsed"` (`docs/openapi.ts:1107-1108`) [S] |

The generator needs nothing extra for this: the documents' JSON Schemas are
already the wire side (`required` from the input).

### 4.2 Response types come from declarations [D]

Handler return values cannot be inferred: a bun-common handler returns `res`
or nothing, and AD measured that typing the return rejects the repo's own
style (AD §3.7) [V-prior]. So:

- A route with `validate(…, { responses })` has its responses typed, and
  enforced on the server at compile time (AD (b1)).
- A route without them is `{ 200: unknown }` in the documents, with a warning
  copied into the generated file. `strict` generation fails instead (AD's
  `strict` option).
- **Common responses**: statuses every route can produce because of
  middleware (a 400 validation problem, 401, 403, 429, 500) are declared once
  as the router's `commonResponses` (built, BV M3; merged by
  `effectiveContract`, `routeModel.ts:127`) [S], and every route's
  documented responses include them unless the route declares that status
  itself. Hono's `ApplyGlobalResponse` is the same idea [V].
- `res.send()`, `res.jsonp()` and a helper typed `BunResponse` escape the
  server-side check (AD §3.7's measured boundary) [V-prior]. Runtime response
  validation (§5.5) is the backstop.

### 4.3 Errors [D]

- **problem+json** (RFC 9457) is the declared shape of an error status, as
  bun-jobs does (`contract/types.ts:57-86`) [S]. `ValidationProblem` extends
  it with `issues: { target, message, path }[]`, BunValidate's issue shape.
- **Error codes become a union.** `.describe({ errors: ["NOT_FOUND", …] })`
  (or bun-jobs' `errors` field) puts the codes in `x-bun-errors`; the generator
  writes `code: "NOT_FOUND" | "CONFLICT"` into that route's problem type.
  bun-jobs-ui's 25 string comparisons and 19 `case` labels become checked
  [S, §2.5].
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
| Separate repos, or the server's schemas are not browser safe | **generated Zod**, from the documents' JSON Schema, beside the generated types, by the same `generate`/`watch` | always: the documents are JSON |
| Monorepo, schemas in a browser-safe module | **the server's own schema objects**, passed as `schemas: () => import("../shared/schemas")` | the module imports no server code: no `node:*`, no drivers, no bun-common runtime. A bundle-safety test (§10.3) proves it. Any Standard Schema library works, and nothing is lost to JSON Schema (§5.3) |

The second row is the monorepo case the coordinator asked about. It needs the
schemas to live in their own module that both sides import; a schema
declared inline in a route file drags the route file, and with it the
server, into the browser bundle. The bundle-safety test catches that.

**Who runs the schemas (2026-11-02, D20).** Whichever row supplies them,
the client runs them through the **same guards the server runs**
(`createSender` for what it sends, `createReceiver` for what it receives,
`contract/guard.ts:430-472`) [S], from `@kingsleyweb/bun-contract`, loaded
lazily with the schemas. So a check on the client and on the server agree on
issue paths, value-free messages and prototype-key stripping, by
construction. The guards and `channelContract` bundle at 6.8 KB gzip for a
browser, with no server marker [M, `transports/contract-reuse/`].

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
zod; it is not in the first PR [D]. **Built 2026-11-03** (the PR-C4
follow-ups, approved): `generate --module` reads the router's zod schemas
(over `listRoutes`) and lists each refinement, `z.date()`, `z.custom()` and
transform on the documented side in the route map's header, once per schema;
a URL or file document carries none, and `schemasFromZod` needs none (it runs
the zod schemas themselves).

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
  schema's output [D]. **Built 2026-11-03** at the call level (`validate:
  { response: { 200: { custom } } }`), approved; a route-level schema still
  runs but cannot type (`createClient<Routes>()` names its type arguments),
  and under `"warn"` a failed check delivers the raw body, so the type holds
  when the check passes.

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

### 5.6 The same policy on every transport [D]

D11 holds for every transport, so one switch means one thing everywhere:

| Transport | What the client sends (checked before writing; failure **throws**) | What it receives (checked on arrival; failure **warns and delivers**) | Plan |
|---|---|---|---|
| HTTP | params, query, headers, body (multipart fields included) | the response by status: body, and headers the route declares; NDJSON per line | §5.1–5.5, [`other-transports.md`](other-transports.md) |
| WebSocket channel | every `send` and `request` | every push and reply; the error frame always | [`websocket.md`](websocket.md) §5 |
| SSE | — (the request is HTTP) | every event's `data`, by event name | [`sse.md`](sse.md) §3.3 |
| WebRTC | signalling frames; data-channel messages | the same | [`webrtc.md`](webrtc.md) |
| GraphQL | — (variables are typed, not checked) | BYO result schema only | [`graphql.md`](graphql.md) |

HTTP's "headers the route declares" are **built** (2026-11-03, the PR-C4
follow-ups): `responseHeaders` per status in the generated map and zod
module, checked on arrival with the body under the same switch and failure
mode, as strings (a non-string header schema is checked as `z.string()`).

`onFailure.receive` takes `"warn"` (the default), `"drop"` (for streams and
channels: discard the message and emit `$invalid`) or `"throw"`; the
per-transport options sit at the same three levels as HTTP's (§6.2): global
(`createClient`), per route or channel, per call.

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
  (`api.op.getUser(opts)`, from `operationId`) is the same call by name,
  in PR-C1 ([`other-transports.md`](other-transports.md) §2).
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
  `opentelemetry/README.md`), CSRF headers (bun-jobs-ui sends one on mutations,
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

`AuthConfig`, `ClientMiddleware`, `Persister` and
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
  keys. The names are bun-cache's, now built (`cacheResponse({ tags })`,
  `addCacheTags`, `invalidateTags`), so one vocabulary covers the server
  cache, the client cache and the live channel. **Runtime tags** [D13]: when
  a route sets tags per response (`addCacheTags`) and `cacheResponse`'s
  `surrogateKeys` writes them as `Cache-Tag` or `Surrogate-Key`
  (`bun-cache/lib/http/cacheResponse.ts:278-293`) [S], the query function
  adds them to the query's `meta.tags`, so a tag the route could not declare
  statically (`"org:7"` from the data) still invalidates it.
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
  `buster` = the documents' hash, so a schema change drops a persisted cache) [V].
- **Normalised caching is out of scope** [D]: REST payloads carry no type tag
  to key entities by, and normy-style normalisation needs app-wide unique ids
  and array hints [V]. Tags and invalidation cover the common need.

### 6.5 WebSocket, SSE, WebRTC, GraphQL: the sub-plans [D]

The 2026-10-10 version of this section planned live invalidation (PR-M3,
PR-C7) and, "later", typed channels (PR-M4). The typed channels' server half
has since been built (`defineChannel`, BV V8), so both now live in
[`websocket.md`](websocket.md): the channel client (§3–§8 there) and live
invalidation as one typed channel (§9 there). Server-sent events are
[`sse.md`](sse.md), WebRTC [`webrtc.md`](webrtc.md), GraphQL
[`graphql.md`](graphql.md), and uploads, downloads, streamed bodies and
named operations [`other-transports.md`](other-transports.md). Each follows
this plan's rules: types from the contract (§3.5), validation of both
directions under §5.5's defaults (§5.6), errors extending `ClientError`
(§4.3), and configuration at three levels (§6.2).

### 6.6 SSR and hydration through bun-views [D]

**Waits for bun-views' hydration (BVW PR-5, not started).** The design
below stands; PR-C6 ships React without it and adds `<ApiHydrate>` after.

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
fallback only; the user chose query-core on 2026-11-02 (Q3).

---
## 8. Server side: bun-common, both adapters

bun-common's `BunHttpAdapter` *is* a `BunRouter`, and bun-nest's adapter
delegates its verbs to one [S, 2026-10-10]; a Nest controller's `@Validate`
contract reaches the same listing through reflect metadata (#538) [S]. So
everything here works for routes on either adapter and for Nest controllers.

### 8.1 What a route author writes [D]

AD's shape, built, plus two `.describe()` fields that become extensions:

```ts
app.get(
  "/users/:id",
  validate({ params: IdParams }, { responses: { 200: User, 404: Problem } }),   // built (BV V2, V3a)
  (req, res) => res.status(200).json(users.get(req.params.id)),
).describe({
  summary: "Read one user",
  operationId: "getUser",
  errors: ["NOT_FOUND"],                       // new → x-bun-errors (§4.3)
  cache: { tags: ["user:{id}"] },              // new → x-bun-cache (§6.4)
});

app.patch("/users/:id", validate({ params: IdParams, body: UserPatch }, { responses: { 200: User } }), handler)
  .describe({ cache: { invalidates: ["user:{id}", "users"] } });
```

One declaration drives five things: the request check (BunValidate), the
response check (V3a), the OpenAPI document (AD), the client's types, schemas,
keys and invalidations (this plan), and live invalidation on success
(`websocket.md` §9). **Nothing is declared twice.**

- `errors` and `cache` are documentation fields: they reach the documents,
  never the handler's types. `cache` templates may name only the route's own
  params; the generator warns otherwise. Today the same can be written by
  hand as `.describe({ extensions: { "x-bun-errors": [...] } })`
  (`docs/routeDoc.ts:137`) [S]; the typed fields make it checked.
- A route with no validator is in the documents typed `unknown`, with a
  warning (§4.2). `hidden: true` hides it from the client as from the docs.

### 8.2 The documents as the model (PR-M1) [D]

What is left of the old PR-M1, now small:

1. `RouteDoc.errors` and `RouteDoc.cache`, emitted as `x-bun-errors` and
   `x-bun-cache`; `x-bun-route-key` on every operation (the listing's `key`).
2. `typesHash({ openapi, asyncapi })`: the canonical-JSON hash (§3.0).
3. **The sender view for inference** (§8.5).
4. A test that a route's `x-bun-*` survive mounting and `defineRoutes`, and
   that `generateOpenApi`'s and `listRoutes`' keys agree for every route.

### 8.3 The dev sync (PR-M2) [D]

```ts
import { devTypes } from "@kingsleyweb/bun-common/lib/docs";
app.use(devTypes(app, { enabled: process.env.NODE_ENV !== "production", openapi: { title: "API", version: "1" } }));
```

`devTypes()` returns a sub-router: the documents endpoint and the channel
(a `defineChannel`), which both adapters serve [I for bun-nest's adapter:
PR-M2 verifies, risk R12]. Disabled, it registers nothing. §3.3 is the
protocol; `sync/dev-types.ts` the measured version.

### 8.4 How it composes with typed overloads and sub-routers [S]

Unchanged and now built: `.describe()` is a separate method, the validator
stays the one shape-carrying position, the generated verb overloads did not
change (`generate-verb-overloads.ts --check` green through #534), and a
mounted router's routes list with their full path.

### 8.5 The inference registry and the sender view [D]

`defineRoutes()` and `RoutesOf` are built (#534). For a client, `RoutesOf`
needs the **wire input** of each part (D5), and today it carries only the
validator's parsed shape (§2.2). PR-M1 adds, with no runtime change:

- a phantom `__schemas?: S` on `ValidatorMiddleware` beside `__shape`
  (`BunValidate.ts:1047-1050`), so `RouteDef` can carry the schemas' types;
- `RoutesOf`'s entries gain a `send` view (`WireInput` of params, query,
  headers, body) and a `receive` view (`Jsonify<WireInput>` of each
  response, or the output under `responseOutput: "parsed"`), keeping today's
  fields for compatibility; bun-client's `createClient<RoutesOf<typeof
  api>>()` reads the views.
- A type test pins the old 2026-10-10 negative control: `{ page: "x" }`
  against `z.coerce.number()` must fail, and a defaulted query key must be
  optional for the sender.

### 8.6 Channels, streams and the live channel

The WebSocket pieces (echoed replies, `defineChannel(contract)`, typed socket
params, send status, server-level publish) are [`websocket.md`](websocket.md)
§10; the live channel (`liveContract`, `liveInvalidation`, `publishTags`,
bun-common `./live`) is §9 there; what the SSE writer needs is
[`sse.md`](sse.md) §4 (BNR's PR); the signalling contract and relay are
[`webrtc.md`](webrtc.md) §3.

---

## 9. NestJS: a separate document

[`nest-typed-routes.md`](nest-typed-routes.md) stays a separate document, but
most of it has been built or made unnecessary since 2026-10-10:

| NTR piece | Now |
|---|---|
| `@Validate` (AD (g)) as the typed-route decorator | **built** as BV V7a/b |
| `StandardSchemaPipe` | **built** as BV V6 |
| `TypedRoutesExplorer` over `DiscoveryService` | **not needed**: `@Validate` contracts reach `listRoutes(adapter.instance)` and `generateOpenApi()` through reflect metadata (#538) [S] |
| typed gateways (`@ValidateMessage`, `@Emits`, `TypedSocket`) and their documents | **built** as BV V9 and `gatewayAsyncApi` (AD (e)) |
| `DevTypesModule` | still to build, smaller: it mounts bun-common's `devTypes()` with `generateOpenApi(adapter.instance)` and `gatewayAsyncApi(app)` as its sources |
| `@Invalidates` | still to build, publishing to `websocket.md` §9's live channel |
| the gateway client | the `"bun-nest"` codec, `websocket.md` §11 |

NTR's revised status and PRs (~4 d, was ~13 d) are in its own Status section.

---

## 10. Packaging

### 10.1 `@kingsleyweb/bun-client`, a new package, and `@kingsleyweb/bun-contract` [D]

| Package / entry | Contents | Runtime peers | Browser safe |
|---|---|---|---|
| **`@kingsleyweb/bun-contract`** (new, extracted) | bun-common's `lib/contract/` moved as it is, with a minimal logger interface instead of bun-common's logger; bun-common depends on it and re-exports it at `./contract` unchanged | none | yes |
| bun-client `.` | `createClient`, the named-operation proxy, `Result`, errors, middleware, auth, retry, `Jsonify`, `RoutesOf`'s client view; the guards loaded lazily from bun-contract only when validation is on | `@kingsleyweb/bun-contract` (dependency) | yes |
| `./channel` | `channel(api, contract, options)`: [`websocket.md`](websocket.md) | none | yes |
| `./sse` | `sse(api, key, options)`: [`sse.md`](sse.md) | none | yes |
| `./webrtc` | `connectPeer`, `typedDataChannel`: [`webrtc.md`](webrtc.md) | none (the app passes its `RTCPeerConnection`) | yes |
| `./graphql` | `createGraphQLClient`: [`graphql.md`](graphql.md) | none | yes |
| `./query` | `queries()`, `observe()`, `invalidateTags`, the ETag query function, `live(api)` (the live channel's client) | `@tanstack/query-core ^5` (optional) | yes |
| `./react`, `./vue`, `./svelte`, `./solid`, `./preact` | §7.1's bindings | the framework and its TanStack adapter (optional) | yes |
| `./zod` | the glue that runs generated schemas (`schemasFromZod`) | `zod ^4` (optional) | yes |
| `./persist` | the IndexedDB persister | `@tanstack/query-persist-client-core` (optional) | yes |
| `./codegen` | documents → `Routes`, `Channels` and Zod emitters; fetcher; watcher | none | **no** (Bun only) |
| bin `bun-client` | `generate`, `watch`, `--check` | `@kingsleyweb/bun-common` optional, for `--module` | — |

- **Transports are functions in subpaths, not methods on `api`**
  (`channel(api, chat)`, not `api.channel(chat)`), so an HTTP-only app's
  bundle carries no WebSocket, SSE or WebRTC code; the `.` budget stays
  5 KB [D].
- **Why a separate contract package (D20)**: a browser client needs the
  guards; bun-common's own dependencies (`@routejs/router`, `busboy`,
  `file-type`, `mime` and seven more) have no place in a frontend's install,
  and a copy would drift from the server's checks. The extraction is a move:
  `lib/contract/` imports nothing else of bun-common but the logger and the
  Standard Schema types (§2.1) [S]. Alternatives considered (Q18, approved 2026-11-02): depend on bun-common
  (11 server packages in every frontend install; none bundled), or copy.
- **Every framework, query-core and zod are optional peers**; each subpath
  that needs one lists it in `consumer-check.json`'s `peers` [S, the recipe].
- **The packaging recipe** is the repo's: `dts/`, the four copied files, the
  `exports` shape with the source condition, browser entries checked as
  `browser` cells in the consumer check.

### 10.2 bun-common [D]

No new runtime dependency. `./lib/docs` gains `devTypes` and `typesHash`;
`RouteDoc` gains `errors` and `cache`; a new `./live` entry holds
`liveContract`, `liveInvalidation` and `publishTags`; a new `./webrtc` entry
holds `signallingContract` and `signallingRelay` (browser-safe contract half
and server half split as `defineChannel` is). `./contract` re-exports
`@kingsleyweb/bun-contract`.

### 10.3 Browser safety [D]

- `__tests__/bundle-safety.test.ts` in bun-client builds **every** browser
  entry with `Bun.build({ target: "browser" })` and fails on a server marker
  (`node:`, `bun:`, `Bun.`, an `@kingsleyweb/bun-common` import), with a
  negative-control entry that must fail. Copied from bun-jobs-ui's
  (`bun-jobs-ui/__tests__/app/pkg/bundle-safety.test.ts`) [S].
- A **budget** test caps each entry's gzip size: `.` 5 KB without the guards;
  the guards 7 KB (measured 6.8 KB [M]); `./channel` 4 KB, `./sse` 2 KB,
  `./webrtc` 2 KB, `./graphql` 0.5 KB, `./query` 3 KB over query-core
  [I: the targets; measured once each PR exists].
- A shared contract module an app passes (§5.1, `websocket.md` §3.1) gets
  the same test in the app's repo; the README gives the five lines.

---

## 11. Using it ourselves: bun-jobs and bun-jobs-ui

**A pilot of one domain, not a rewrite** (unchanged in spirit; Q14):

- **bun-jobs' side (~0.5 d, was ~1.5 d)**: its routes already carry
  contracts (BV M5) and it serves its own OpenAPI, so no `toRouteModel` is
  needed; it adds `x-bun-errors` from each `defineRoute`'s `errors` list to
  its own generator (`spec/openapi.ts:259`), and closes its server-side
  `ApiErrorCode` (`lib/api/errors.ts:110`) so the union is real.
- **bun-jobs-ui's side (~3 d)**: generate `app/api/routes.gen.ts` from
  bun-jobs' OpenAPI with `bun-client generate --module`, and move **summon**
  onto `createClient<Routes>` and `/query`: it holds 5 of the 15
  `assertShape` sites and its own key factory [S]. The TanStack hooks stay.
- **What the pilot measures**: lines, assertions and key factories removed;
  the 27 real-API integration tests unchanged and green; the bundle delta;
  whether `--check` would have caught a drift the integration tests caught.
- **Not in the pilot**: the 184 contract types (bun-jobs' public API); the
  live client (a `"bun-jobs"` codec for `./channel` is a later, separate
  step, `websocket.md` §13).

---

## 12. Tests and evidence

### 12.1 What each PR's tests prove [D]

| PR | Proves |
|---|---|
| PR-K contract package | bun-common's whole contract suite passes unchanged through the re-export; `@kingsleyweb/bun-contract` has no dependency (`package.json` asserted) and bundles browser-safe; the consumer check for both packages |
| PR-M1 documents as the model | `x-bun-route-key`/`-errors`/`-cache` on every operation, through mounts and `defineRoutes`; keys agree with `listRoutes`; the hash stable across runs and changed by a schema change; the sender view's type controls (§8.5) |
| PR-M2 dev sync | the `sync/` e2e loop as a test; fail closed (production throws, disabled registers nothing, no token → 404, non-loopback → 404, ETag → 304); nothing built while nobody listens |
| PR-C1 core | type tests with negative controls (wrong params, wrong query type, unknown route, undeclared status narrowing, named operations); the query serialiser round-trips through `router.fetch()` for every shape; retries, `Retry-After`, timeout vs abort, middleware order, single-flight auth refresh under 10 concurrent 401s; the backoff vector shared with bun-common; bundle safety and budget; the consumer check |
| PR-C2 generator | OpenAPI/AsyncAPI → TypeScript over a corpus (objects, unions, nullable, `$ref` components, recursion, `x-sse-events`); **parity**: for a fixture app, generated `Routes` `Equal` to `RoutesOf`'s client view, with §5.3's differences pinned as controls; a third-party OpenAPI document (no `x-bun-*`) generates; `--check` exits 1 when stale |
| PR-C3 watch | reconnect after a restart; atomic write; no write when unchanged |
| PR-C4 validation | built-in and BYO order; `replace`; failure modes; defaults by mode; the guards are bun-contract's (one import site); generated Zod accepts and rejects what the server's schema does over a corpus, except the documented refinements |
| PR-C5 query | keys and prefix invalidation; tag templates and `Cache-Tag` headers; `invalidates`; ETag 304 keeps identity; optimistic rollback; infinite |
| PR-C6 React | the repo's DOM rules; pending → success; one fetch for two components; Suspense's `staleTime` floor (the spike's double fetch as the control); SSR once BVW PR-5 exists |
| PR-C8 persist | the buster is the document hash |
| PR-C9 bodies | multipart and urlencoded built from typed fields; downloads by kind; NDJSON checked per line (control: a bad line delivered under `"warn"`, refused under `"throw"`) |
| PR-W*, PR-S1, PR-R*, PR-G1 | the sub-plans' Tests sections |
| every PR | `bun test --randomize` with two seeds beside the parallel run |

### 12.2 Evidence

| Spike | Run | Result |
|---|---|---|
| `inference/` (2026-10-10) | `bun patch-router.ts && bun gen.ts && bun measure.ts` (heavy) | +49% (router) or +2% (registry) check time at 1000 routes |
| `codegen/` (2026-10-10) | `bun generate.ts`, `bun scale.ts` | `Routes` from statement-style routes; 0.75 s client check at 1000 routes |
| `codegen/zod/` (2026-10-10) | `bun measure.ts`, `bun jitless.ts`, `bun roundtrip.ts` | generated Zod sizes and costs; what survives JSON Schema |
| `sync/` (2026-10-10) | `bun e2e.ts` | 49 ms (`--hot`), 160 ms (`--watch`), 560 ms (1 s poll); fail closed |
| **`watch/`** (2026-11-02, PR-C3) | `bun e2e.ts` (wrapper, exclusive) | the shipped `devTypes()` and `bun-client watch`: 170 ms (`--watch`), 139 ms (`--hot`, the 100 ms poll's share named) |
| `swr-core/` (2026-10-10) | `bun test swr-core` | a 465-line core and React binding, 27 tests |
| `bundle-size/` (2026-10-10) | `bun bundle-size/measure.ts` | the data-layer and validator sizes |
| `nest/` (2026-10-10) | `cd nest && bun explore.ts` | NTR's explorer (now superseded, §9) |
| **`transports/ws-typing/`** (2026-11-02) | `bun ws-typing/gen.ts && bun ws-typing/measure.ts` (wrapper) | §3.1's channel table; a negative control |
| **`transports/webrtc/`** (2026-11-02) | `bun webrtc/spike.ts` | Bun has no WebRTC; node-datachannel and werift peers; typed signalling and data channels; `webrtc.md` §2 |
| **`transports/graphql/`** (2026-11-02) | `bun graphql/size.ts`, `bun graphql/tada.ts` (wrapper) | runtime sizes; gql.tada check cost; `graphql.md` §2.1 |
| **`transports/contract-reuse/`** (2026-11-02) | `bun contract-reuse/size.ts` | the contract core in a browser: 6.8 KB gz, no server marker |

---

## 13. Risks

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | **query-core's next major** changes the factories' target [V] | likely within a year / medium | factories return `queryOptions`-shaped objects; peer `^5` |
| R2 | ~~AD not built~~ **resolved**: AD and BV built (§2.6) | — | — |
| R3 | **Generated schemas are weaker than the server's** (refinements dropped silently) [M] | certain / low | documented; the server stays the authority; BYO for client rules; in a monorepo the shared module's own schemas avoid it |
| R4 | **The dev endpoint leaks in production** | low / high | fail closed by construction and by test |
| R5 | **Inference cost at scale** (tsc) [M] | — | generation is the default; under `bun --check` both forms are sub-second at 200 channels [M] |
| R6 | **Document build cost on large apps** (~0.3 s per 1000 routes [M]) | medium / low | built lazily |
| R7 | **Query serialisation drifts from the server's parser** | medium / medium | a round-trip test through `router.fetch()` |
| R8 | **Preact 11**: TanStack's adapter declares `preact ^10` [V] | certain / low | Preact on demand |
| R9 | **zod classic under a strict CSP** runs jitless [M] | medium / low | `zod/mini` by default |
| R10 | **Generated-file churn** | medium / low | sorted, stable output; `--check` in CI; Q9 |
| R11 | **The pilot finds the documents insufficient** for bun-jobs (alternate content types, `bodyOptional`, `maxBodyBytes`) | medium / medium | one domain first; bun-jobs' own generator can add what it needs as `x-bun-*` |
| R12 | **bun-nest's adapter does not serve a `BunRouter` `ws()` route** as bun-common's does [I] | unknown / medium | PR-M2 verifies; NTR's module serves the channel through bun-nest's own path otherwise |
| R13 **(new)** | **OpenAPI cannot express some paths** (regex-constrained, host-scoped) [S] | low / low | `x-bun-route-key` keeps the Express key; unexpressible routes are listed with a warning and callable untyped |
| R14 **(new)** | **Extracting the contract package churns bun-common's imports and its consumer check** | certain / low | a move with a re-export; bun-common's suite unchanged is the gate (PR-K) |
| R15 **(new)** | **AsyncAPI documents describe behaviour the runtime lacks** (a reply echoing the id, `docs/asyncapi.ts:617`) [S] | certain today / medium | PR-W1 makes the runtime match before the client relies on it |
| R16 **(new)** | **Bun gains `EventSource` or WebRTC later**, changing what "works under Bun" means [V: oven-sh/bun#8474 open] | unknown / low | the SSE client never used `EventSource`; the WebRTC wrapper is structural, so a native `RTCDataChannel` fits |
| R17 **(new)** | **bun-nest's packet format drifts** from socket.io's or changes in a Nest major | low / medium | the codec is tested in the Nest matrix (11 and 12) |
| R18 **(new)** | **Native WebRTC test dependency** (node-datachannel's prebuilt binary) missing on a platform | low / low | a devDependency of bun-client only; the tests skip visibly without it; werift as the pure-TS fallback |

---

## 14. Answered by the user, 2026-11-02

The user approved every recommendation on 2026-11-02 (through the lead
session, b8). The 2026-10-10 Q2 ("leave `BunRouter`'s verb return types
alone") was already settled by #534, and the old Q11 was replaced by Q20.

**Carried over from 2026-10-10**

| # | Question | Answer |
|---|---|---|
| 1 | Generation plus live sync as the default, inference as the opt-in registry | **Yes** (§3.4) |
| 3 | The data layer on `@tanstack/query-core`, an optional peer | **Yes** (§7.2) |
| 4 | Path literal per verb as the primary call; the named proxy `api.op.*` beside it from PR-C1 | **Yes** (§6.1) |
| 5 | An undeclared status throws by default (`undeclaredStatus: "result"` to opt out) | **Yes** (§4.3) |
| 6 | Built-in validation from generated `zod/mini` in `/zod`, zod an optional peer; the server's own schemas when a shared module is browser-safe | **Yes** (§5.1–5.2) |
| 7 | On every transport: validation on in development, off in production; sends throw on failure, receives warn and deliver | **Yes** (§5.5–5.6) |
| 8 | BYO validators after the built-in, issues merged, `replace: true` | **Yes** (§5.4) |
| 9 | Commit the generated files, `--check` in CI | **Yes** |
| 10 | Dev endpoint `/__bun/types`, token file `node_modules/.cache/bun-types/<port>.json`, both configurable | **Yes** (§3.3) |
| 12 | Cache tags in `.describe({ cache })` with bun-cache's vocabulary, plus `Cache-Tag`/`Surrogate-Key` headers | **Yes** (§6.4) |
| 13 | Package name `@kingsleyweb/bun-client` | **Yes** |
| 14 | Pilot one bun-jobs-ui domain (summon) first | **Yes** (§11) |
| 15 | SSR prefetch in process through `router.fetch()`, once bun-views' hydration exists | **Yes** (§6.6) |
| 16 | React first, other bindings on demand | **Yes** (§7.1) |

**New on 2026-11-02**

| # | Question | Answer |
|---|---|---|
| 17 | The documents are the model (OpenAPI 3.1, AsyncAPI 3.0, `x-bun-*`); the bespoke `RouteModel` is dropped | **Yes** (D1, §3.0) |
| 18 | Extract `lib/contract/` into zero-dependency `@kingsleyweb/bun-contract`, re-exported by bun-common, used by the client | **Yes** (D20, §10.1) |
| 19 | The WebSocket client as `websocket.md` designs it, with its bun-common changes (echoed reply ids, `defineChannel(contract)`, typed socket params, `send` returning Bun's status) | **Yes** |
| 20 | Live invalidation as one typed channel (`liveContract`, bun-common `./live`), SSE as the fallback | **Yes** (D15) |
| 21 | Nest: no explorer; a small `DevTypesModule`, `Describe` and `@Invalidates` from bun-nest's root; gateways through `gatewayAsyncApi` and shared `as const` maps | **Yes** (§9, NTR) |
| 22 | SSE over `fetch` with our own parser, `Last-Event-ID` by default; ask BNR's PR-sse2 for ids, a `resume` hook, `retry:` and heartbeats | **Yes** (`sse.md`) |
| 23 | WebRTC: signalling contract and relay, typed data channels; no media, no WebRTC runtime dependency | **Yes** (`webrtc.md`) |
| 24 | `node-datachannel` as a devDependency of bun-client only, for the data-channel tests | **Yes** |
| 25 | GraphQL: no server, no codegen of ours; a typed `TypedDocumentNode` call over the HTTP core, on demand | **Yes** (`graphql.md`) |
| 26 | Named operations, uploads, downloads, streamed bodies in; gRPC, Connect, JSON-RPC out | **Yes** (`other-transports.md`) |
| 27 | Transports as subpath functions (`channel(api, …)`, `sse(api, …)`) | **Yes** (§10.1) |

---

## 15. PR slicing and effort

Focused days for someone who knows the code. Each PR passes the full gate
alone (`bun scripts/typecheck.ts`; `bun run lint` and `bun run format:check`
in each touched directory; `bun run test` plus `bun test --randomize` with two
seeds; the consumer check for packaging changes; the affected `examples/`),
and every user-facing PR sends the examples a change report before merging.
**After a bun-common change, bun-nest's suite and bun-jobs' `test:seeded`
run too** (CLAUDE.md).

### 15.1 Group 0: prerequisites (bun-common)

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| **PR-K** contract package | `@kingsleyweb/bun-contract` from `lib/contract/`; bun-common depends on it and re-exports it at `./contract`; packaging recipe; consumer check | — | ~2 d |
| **PR-M1** documents as the model | `x-bun-route-key`, `RouteDoc.errors`/`cache` → `x-bun-errors`/`x-bun-cache`, `typesHash`, the sender view on `RoutesOf` (§8.5) | — | ~2 d |
| **PR-M2** dev sync | `devTypes()`: documents endpoint, channel, token file, loopback, fail closed, lazy build, `routesVersion` | PR-M1 | ~2.5 d |

### 15.2 Group 1: HTTP (bun-client)

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| **PR-C1** package and core | skeleton and recipe; `createClient`, verbs, `request`, `url`, **named operations**; params, query, body, headers; abort, timeout, retries, middleware, auth refresh; `Result` and errors; §6.2's config | — | ~5.5 d |
| **PR-C2** generator and CLI | `./codegen`: OpenAPI → `Routes` (`$ref` components as named types, recursion, `x-sse-events`), from a URL, files or `--module`, `--check` | PR-M1, PR-C1 | ~4 d |
| **PR-C3** watcher | `bun-client watch` | PR-M2, PR-C2 | ~1.5 d |
| **PR-C4** validation and `/zod` | built-in and BYO validation on bun-contract's guards, `ValidationError`, failure modes, defaults; the Zod emitter (mini, classic) | PR-K, PR-C2 | ~4 d |
| **PR-C5** query layer | `./query`: keys, tags (declared and from headers), `invalidates`, ETag 304, optimistic, infinite, `observe()` | PR-C1 | ~4 d |
| **PR-C6** React | `./react`; SSR's `<ApiHydrate>` later, after BVW PR-5 (+1 d then) | PR-C5 | ~2 d |
| **PR-C8** persistence | `./persist`, buster = the document hash | PR-C5 | ~1.5 d |
| **PR-C9** bodies | typed multipart/urlencoded and files, downloads by kind, NDJSON and raw chunk iteration, streaming request bodies; bun-common's `RouteDoc.request.files` (other-transports.md §6) | PR-C1, PR-C4 | ~3 d |
| | **Group 1 total** | | **~25.5 d** |

### 15.3 Group 2: WebSocket and SSE

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| **PR-W1** channel server pieces (bun-common) | echoed replies, `defineChannel(contract)`, typed socket params, send status, server-level publish | — | ~3 d |
| **PR-W2** channel client | `./channel`; AsyncAPI → `Channels` in the generator | PR-C1, PR-C2, PR-K, PR-W1 | ~5 d |
| **PR-W3** Nest codec | `"bun-nest"` codec and acks; the Nest matrix | PR-W2 | ~1.5 d |
| **PR-W4** live invalidation | bun-common `./live` (`liveContract`, `liveInvalidation`, `publishTags`, bun-cache source); `live(api)` in `./query` | PR-W1, PR-W2, PR-C5 | ~4 d |
| **PR-S1** SSE client | `./sse`, its parser and shared corpus, resume, validation; the live channel's SSE fallback | PR-C1, PR-C2 | ~3 d |
| *(BNR PR-sse2)* | the writer, plus ids, `resume`, `retry:`, heartbeats asked by sse.md §4 | BNR | +~1 d on BNR's estimate |
| | **Group 2 total** | | **~16.5 d** (+1 d in BNR) |

### 15.4 Group 3: WebRTC; Group 4: GraphQL

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| **PR-R1** signalling | bun-common `./webrtc` (`signallingContract`, `signallingRelay`); bun-client `connectPeer` | PR-W1, PR-W2 | ~2 d |
| **PR-R2** data channels | `typedDataChannel`: envelope, guards, request/response, `sendWhenReady`, binary kind/size | PR-W2 | ~2 d |
| *PR-G1* GraphQL (on demand) | `./graphql` | PR-C1, PR-C5 | ~2 d |

### 15.5 Elsewhere

| PR | Owner | Effort |
|---|---|---|
| NTR's revised PRs (`DevTypesModule`, `@Invalidates`, the shared-maps convention) | bun-nest | ~4 d (NTR §9.4) |
| Pilot: bun-jobs `x-bun-errors` and a closed `ApiErrorCode` | bun-jobs | ~0.5 d |
| Pilot: bun-jobs-ui summon domain | bun-jobs-ui | ~3 d |
| Examples: `examples/bun-common/14-typed-client/` (HTTP, a channel, SSE, a data channel), one per binding | examples | ~5 d |
| *Later, on demand*: `./vue` ~1.5 d, `./svelte` ~2 d, `./solid` ~1.5 d, `./preact` ~1 d; upload progress ~1 d; a `"bun-jobs"` codec ~1 d | | ~8 d |

**Order.** PR-K, PR-M1 and PR-C1 can start at once (none depends on
another). Then PR-M2 ∥ PR-C2; PR-C3, PR-C4; PR-C5 → PR-C6, PR-C8; PR-C9.
**HTTP first (group 1), then WebSocket and SSE (group 2: PR-W1 can start
beside group 1), then WebRTC (group 3), then GraphQL on demand.** The pilot
follows PR-C2 and PR-C5.

---

## 16. Names (approved 2026-11-02)

**Approved by the user, 2026-11-02, as listed, withdrawals included.**

Every new public name. Names approved and built since 2026-10-10
(`defineRoutes`, `RoutesOf`, `RouteDef`, `defineChannel`, `channelContract`,
`listRoutes`, `generateOpenApi`, `generateAsyncApi`, `docsRouter`) are not
repeated; the old `RouteModel`, `ModelRoute`, `ModelChannel`,
`buildRouteModel`, `toRouteModel` and `commonResponses` (as a builder
option) are **withdrawn** with D1.

| Name | Kind | Where | Why this name |
|---|---|---|---|
| `@kingsleyweb/bun-client` | package | new | the client of the bun-* server packages |
| **`@kingsleyweb/bun-contract`** | package | new, extracted | bun-common's `./contract`, standalone |
| `./query`, `./react`, `./vue`, `./svelte`, `./solid`, `./preact`, `./zod`, `./persist`, `./codegen`, **`./channel`, `./sse`, `./webrtc`, `./graphql`** | subpaths | bun-client | one per optional peer or transport |
| `bun-client` (`generate`, `watch`, `--check`, `--module`, `--export`, `--url`, **`--openapi`, `--asyncapi`**, `--out`, `--zod`, `--zod-flavour`) | bin and flags | bun-client | |
| `generateRoutes` (`GenerateRoutesOptions`: `asyncapi`, `documentWarnings`, `clientModule`; `GenerateRoutesResult`), `loadDocuments` (`DocumentSource`, its `headers`; `LoadedDocuments`), `runCli` (`CliIo`), `documentsHash`, `CodegenWarning` | functions, types | `./codegen` | PR-C2; **approved 2026-11-02** with the PR |
| `events`, `cache` (beside `stream: "sse"`) | fields of a generated `Routes` entry | generated files | PR-C2; **approved 2026-11-02** |
| `pathParams`, `PathParamInfo` | function, type | bun-client `./lib/path` | PR-C2 (the generator reads keys with the client's tokenizer); **approved 2026-11-02** |
| `createClient`, `ClientConfig`, `RouteConfig`, `CallConfig`, `RetryConfig`, `ValidationConfig`, `PartValidation`, `FailureMode`, `QueryDefaults`, `AuthConfig`, `ClientMiddleware`, `SchemaSource` | function, types | `.` | §6.2 |
| option names of `ClientConfig` (§6.2's list; `live` moves to `./query`'s `live()`) | options | `.` | query-core's words where it has them |
| `op` (the named-operation proxy) | property | the client | short; `api.op.getUser()` |
| `Result`, `Jsonify`, `RouteMap`, `RouteEntry` | types | `.` | |
| `ClientError`, `HttpError`, `UnexpectedStatusError`, `NetworkError`, `TimeoutError`, `ValidationError` | classes | `.` | |
| `queries`, `observe`, `invalidateTags`, `live` | functions | `./query` | `invalidateTags` is bun-cache's verb |
| `useApi`, `useApiSuspense`, `useApiMutation`, `useLive`, `ApiHydrate`; `createApi` (Svelte, Solid) | hooks, component | framework subpaths | |
| `schemasFromZod`, `idbPersister` | functions | `./zod`, `./persist` | |
| `responseHeaders` (a generated `Routes` entry's field, `RouteEntry`, `RouteSchemas`, `schemasFromZod`'s part); the last type parameter `V` of `Result`, `SuccessData`, `CallOptions`, `CallArgs`, `CallReturn` | field, type parameter | `.`, `./zod`, generated files | the PR-C4 follow-ups; **approved by the user 2026-11-03**, as built |
| `channel`, `ChannelClient`, `ChannelOptions` and its members and options, `ChannelError`, `RequestTimeoutError`, `DisconnectedError`, `ChannelClosedError`, codecs `"bun-common"`/`"bun-nest"` | function, types, classes | `./channel` | [`websocket.md`](websocket.md) §13.3 |
| `sse`, `EventStream`, `StreamClosedError`, `$gap`, `heartbeatMs`, `fatalStatuses` | function, types | `./sse` | [`sse.md`](sse.md) |
| `connectPeer`, `typedDataChannel` | functions | `./webrtc` | [`webrtc.md`](webrtc.md) |
| `createGraphQLClient`, `GraphQLResponseError`, `throwOnGraphQLErrors` | function, class, option | `./graphql` | [`graphql.md`](graphql.md) |
| `x-bun-route-key`, `x-bun-errors`, `x-bun-cache` | OpenAPI extensions | bun-common's generator | §3.0 |
| `RouteDoc.errors`, `RouteDoc.cache` (`tags`, `invalidates`), `RouteDoc.request.files` | fields | bun-common `RouteDoc` | §8.1 |
| **`RouteDef.describe(doc)`** | method | bun-common `defineRoutes` | PR-M1's follow-up: `BunRouter.describe()` for a registry's definition, chainable; **approved by the user 2026-11-02** |
| `devTypes` (`enabled`, `path`, `token`, `allowRemote`, `openapi`, `asyncapi`), `typesHash` | functions, options | bun-common `./lib/docs` | |
| **`tokenFile`** (`string \| false`, `<port>` substituted), **`DevTypesOptions`**, **`DevTypesRouter`** (`token`, `tokenFile`, `listening(server)`, `close()`) | option, types, members | bun-common `./lib/docs` | PR-M2; **approved by the user 2026-11-02**, as built |
| **`routesVersion`** | read-only counter | `BunRouter`, `BunWebSocket` | PR-M2's change detector (§3.3); **approved by the user 2026-11-02** |
| `/__bun/types`, `bun-types.v1`, `node_modules/.cache/bun-types/<port>.json` | defaults | dev sync | §3.3 |
| `liveContract`, `liveInvalidation`, `publishTags` | constant, functions | bun-common `./live` (new entry) | websocket.md §9 |
| `connectLiveBus`, `LiveBus`, `LiveBusMessage`, `LiveBusConnection`, `ConnectLiveBusOptions`, `LiveInvalidationOptions.bus`; `authorizeTag`, `AuthorizeTag`, `LiveHello` (`hello.denied`), the `LIVE_TAGS_DENIED` problem | functions, types, options, field, error code | bun-common `./live` | the PR-W4 follow-ups, websocket.md §9; **approved by the user 2026-11-08** |
| `cacheLiveBus`, `CacheLiveBusOptions`, `DEFAULT_LIVE_NAMESPACE` (`"bun-common/live"`) | function, type, constant | bun-cache `./live` (new entry), re-exported by bun-nest `./cache` | the PR-W4 follow-ups; **approved by the user 2026-11-08** |
| `signallingContract`, `signallingRelay` | functions | bun-common `./webrtc` (new entry) | webrtc.md §3 |
| `defineChannel(contract)`; `send(…, { id })`; `send`/`publish` → `Promise<number>`; server-level `publish` | overload, signature changes | bun-common `Channel` | websocket.md §10 |

---

## Appendix: evidence

`docs/plans/typed-client/evidence/` ([index](evidence/README.md)):

- 2026-10-10: `inference/`, `codegen/` (with `zod/`), `sync/`,
  `swr-core/`, `bundle-size/`, `nest/` (files listed in each README)
- 2026-11-02: `transports/` (its own `package.json` and `bun.lock`):
  `ws-typing/` (`client-types.ts`, `gen.ts`, `measure.ts`, `results.txt`),
  `webrtc/` (`spike.ts`, `results.txt`), `graphql/` (`entries/`, `size.ts`,
  `size-results.txt`, `tada.ts`, `tada-results.txt`), `contract-reuse/`
  (`guards.ts`, `whole.ts`, `size.ts`, `results.txt`)

Third-party packages are pinned in each project's `package.json` and
installed there only.
