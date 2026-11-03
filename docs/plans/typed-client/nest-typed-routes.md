# Nest typed routes: decorators, the route model, a dev types module, typed gateways

The NestJS half of [`typed-client/README.md`](README.md) (**TC**). TC designs
one route model, a client that consumes it, and a dev-time channel that
pushes changes; this document is how a **NestJS app on bun-nest** produces
that same model and serves that same channel. The user's words, from TC's
request:

> "This should support both httpadapter and nest js ecosystem. So if you need
> a different plan to plan how to implement helper decorators, guards,
> pipelines, etc (Nest ecosystem) on how bun validate with route description
> to build an endpoint or probably websocket to communicate types with the
> client on the fly during development."

TC §9 says why this is a separate document: its surface is a design of its
own, it has a different owner (the bun-nest agent), and the contract between
the two (TC §3.0's `RouteModel`, §3.3's protocol, §6.5's live frames) is
small and fixed. **The client is identical for both**: a Nest app's
frontend uses `createClient<Routes>()` over the map generated from the
model this document produces.

Written 2026-10-10 against `develop` at `7dac1de4`. **No product code was
changed.** Every `file:line` is at `7dac1de4` and relative to `packages/`
unless it says otherwise. Evidence: [`evidence/nest/`](evidence/nest/README.md),
run from that directory because Bun reads decorator settings from the
working directory's `tsconfig.json` (oven-sh/bun#28605, recorded in
[`nest-jobs-decorators/README.md`](../nest-jobs-decorators/README.md) R3).

### Status (2026-11-02): most of this is built, or no longer needed

**Approved by the user on 2026-11-02** (TC §14 Q21, and §9.5's names);
of what remained, PR-N3 (`Describe`) is built (2026-11-03; see its row). The next PRs are TC's PR-K, PR-M1 and
PR-C1; this document's PR-N2 follows TC's PR-M2. Re-surveyed against
`develop` at `e80ab379` (`file:line` there, relative to `packages/`) [S]. The body below is the 2026-10-10 design, kept for its
reasons; this table is what holds now, and §9.3/§9.4 are revised to match.

| Piece (section) | Now |
|---|---|
| `@Validate` as the typed-route decorator (§3.1, N-D1, AD (g)) | **built** as bun-validate V7a/V7b (#522, #523): `Validate` (`bun-nest/lib/validate.ts:1255`), `reply()` (`:1118`), `ResponseValidationInterceptor` (`:1158`), `responseOutput` (V13) |
| `StandardSchemaPipe` (§4.1, N-D7) | **built** as V6 (#501): `bun-nest/lib/validation.ts:312`, with `StandardValidationPipe` (`:451`), `ValidationExceptionFilter` (`:680`), `StandardValidationModule` (`:850`) |
| The explorer (§5, N-D3, N-D4, PR-N1) | **not needed for HTTP**: a `@Validate` contract is written as reflect metadata Nest copies onto the handler (`bun-common/lib/contract/transport.ts:228-248`, #538), so `listRoutes(adapter.instance)` and `generateOpenApi(adapter.instance)` see controller routes with their final paths (`bun-nest/__tests__/validateContractDocs.nest.test.ts:42-58`). The typed client reads that OpenAPI (TC D1). Routes documented only by `@nestjs/swagger` keep using swagger's own document, which the generator also reads (TC §3.2) |
| Typed gateways (§7, N-D9, PR-N5) | **built** as V9 (#526): `@ValidateMessage(schema, { ack })`, `@Emits`, `TypedSocket` (`bun-nest/lib/wsValidation.ts:94-390`), exported from bun-nest's root, not `./typed`; documented by `gatewayAsyncApi()` (`bun-nest/lib/gateway-docs.ts:195`, AD (e) #539), which emits acks as replies (`:478-517`). The client side is TC [`websocket.md`](websocket.md) §11 (the `"bun-nest"` codec) |
| `@Describe` (§3.2, N-D2, PR-N3) | **built** (2026-11-03, branch `feat/bun-nest-typed-client`): `Describe` (`bun-nest/lib/describe.ts`) writes a `RouteDoc` as `"bun:describe"` reflect metadata on the method, which Nest copies onto the handler; bun-common's `routeDocFor` (`bun-common/lib/docs/routeDoc.ts`) reads it beside `.describe()`'s store, so `generateOpenApi`, `generateAsyncApi` and `liveInvalidation()`'s route source see it. A controller-level one merges under each route method the class declares (tags combined); a controller's document equals a router app's (`bun-nest/__tests__/describe.nest.test.ts`) |
| `DevTypesModule` (§6, N-D6) | **open**, smaller: it mounts bun-common's `devTypes()` with `generateOpenApi(adapter.instance)` and `gatewayAsyncApi(app)` as its sources |
| `@Invalidates`, `LiveModule` (§4.3, N-D8) | **open**: they publish to TC's live channel (`websocket.md` §9); bun-cache's Nest `CacheTags`/`BunCacheInterceptor` (#570) already carry tags for the HTTP cache, and `@Invalidates` reuses their vocabulary |
| `ProblemDetailsFilter` | **dropped**: V6's `ValidationExceptionFilter` answers validation failures; other problems are the app's |
| `validateTarget` in bun-common (§8) | **superseded** by `validateStandard` in the contract core (`bun-common/lib/contract/index.ts:27`) |
| `@kingsleyweb/bun-nest/typed` (§8, N-D10) | **withdrawn** (TC §14 Q21, approved 2026-11-02): `Describe`, `DevTypesModule` and `Invalidates` ship from bun-nest's root |

Markings as in TC: **[S]** source, **[M]** measured, **[V]** third party at a
pinned version, **[I]** inference, **[U]** unverified, **[D]** decision.
**AD** is [`api-docs-generation/README.md`](../api-docs-generation/README.md), **NJD** is
[`nest-jobs-decorators/README.md`](../nest-jobs-decorators/README.md).

### Contents

1. [Executive summary](#1-executive-summary)
2. [What exists today](#2-what-exists-today)
3. [What a controller author writes](#3-what-a-controller-author-writes)
4. [Pipes, guards and interceptors](#4-pipes-guards-and-interceptors)
5. [From controllers to the route model](#5-from-controllers-to-the-route-model)
6. [`DevTypesModule`: the dev sync in Nest](#6-devtypesmodule-the-dev-sync-in-nest)
7. [Typed WebSocket gateways](#7-typed-websocket-gateways-d)
8. [Packaging](#8-packaging)
9. [Tests, risks, questions, PRs and names](#9-tests-risks-questions-prs-and-names)

---

## 1. Executive summary

**A Nest controller becomes the same route model as a `BunRouter` app at
runtime, with Nest's public discovery API and no TypeScript transformer.**
The spike built a Nest app on bun-nest's `BunHttpAdapter` with a global
prefix, a typed-route decorator, a controller documented only by
`@nestjs/swagger`-shaped metadata, and an untyped route; a
`TypedRoutesExplorer` over `DiscoveryService`, `MetadataScanner` and
`ApplicationConfig` produced the model for **6 routes in 8.7 ms**, every key
matching a route the adapter had actually registered, and TC's emitter and
client type-checked against it [M, `nest/results.txt`].

| # | Decision | Why |
|---|---|---|
| N-D1 | **AD's `@Validate({ params, query, body, responses })` is the typed-route decorator.** No second one. This plan is the reason to build AD (g), which AD gated on whether `@nestjs/swagger` alone suffices (AD risk 1h). | It already validates the request with BunValidate's semantics, constrains the method's return type to the declared responses (measured in AD §3.8.3, and again here with a negative control [M, `nest/explore-types.ts`]), and holds the schemas the model needs. Swagger alone gives no response *schemas* for a Standard Schema, and no request schemas at all for one. §3.1 |
| N-D2 | **`@Describe({ summary, operationId, errors, cache, hidden })`** carries the prose, as `.describe()` does on a router. | The same `RouteDoc` (AD §3.2) plus TC's two fields (TC §8.1). §3.2 |
| N-D3 | **The model comes from runtime discovery** (`DiscoveryService.getControllers()`, `MetadataScanner`, `Reflector`), not from nestia's transform or the swagger CLI plugin. | Both are TypeScript transformers. Bun runs `.ts` without them; nestia now needs TS 7 through `ttsc`, and runs under Bun only through a preload that must restart on every change [V]. Discovery measured 8.7 ms [M]. §5.2 |
| N-D4 | **The adapter's registered routes are the authority for the final path**; the explorer's computed path is checked against them, and a mismatch is a warning naming the method. | Measured: all 6 matched with a global prefix [M]. Versioning and `RouterModule` prefixes are where a computed path could drift [I]; checking against what was registered catches it. §5.3 |
| N-D5 | **`@nestjs/swagger` metadata is read when present**, for a route with no `@Validate`: `swagger/apiResponse` and friends, by their string keys, without importing swagger. | An existing Nest app documented with swagger gets a typed client without re-annotating; measured reading `swagger/apiResponse` [M]. §5.4 |
| N-D6 | **`DevTypesModule.forRoot({ enabled })` mounts bun-common's `devTypes()` on the adapter**, with the explorer as its model source; it refuses `NODE_ENV=production`. | One implementation of TC §3.3's protocol and its fail-closed rules, as `BunJobsApiModule` mounts the jobs API (`bun-nest/lib/jobs/BunJobsApiModule.ts:165-167`) [S]. The spike's Nest-native controller and guard also worked, and answered **403**, which confirms the endpoint exists [M]; the adapter mount answers 404. §6 |
| N-D7 | **A Standard Schema pipe is offered, secondary to `@Validate`**: `new StandardSchemaPipe(schema)` per parameter, its schema discovered from route-argument metadata. | The coordinator asked for pipes; AD explains why the interceptor is the primary tool (a pipe cannot replace `req.query` in place or see the response, AD §3.8). The pipe covers the per-parameter style Nest users know. §4.1 |
| N-D8 | **`@Invalidates(...tags)` is an interceptor publishing cache tags to TC's live channel after a successful handler**, defaulting to the route's `@Describe({ cache: { invalidates } })`. | TC D15: live queries push invalidations. §4.3 |
| N-D9 | **Typed gateways**: `@ValidateMessage(schema, { ack })` on a `@SubscribeMessage` handler and `@Emits({ event: schema })` on the gateway class; the explorer reads `MESSAGE_METADATA` and `GATEWAY_OPTIONS` into the model's `channels`. | bun-nest's `BunWebSocketAdapter` dispatches by event name and already types emits with `WsEventMap` (`bun-nest/lib/BunWebSocketAdapter.ts:54-65`) [S]; nothing validates or describes the payloads. Later, with TC PR-M4 and AD (e). §7 |
| N-D10 | **Everything ships on one new subpath, `@kingsleyweb/bun-nest/typed`**, except `@Validate`, which AD puts in bun-nest's root decorators. | No new optional peer is introduced (bun-common is already a dependency; swagger is read structurally), so one subpath suffices. §8 |

**Cost: ~13 d** (§9.4), after AD (g) and TC PR-M1.

---

## 2. What exists today

- **bun-nest has no discovery code.** No `DiscoveryService`, `Reflector`,
  `MetadataScanner` or `ModulesContainer` anywhere in `bun-nest/lib` [S,
  survey]. `decorators.ts` is one line re-exporting `UploadedFile(s)`;
  `interceptors.ts` (351 lines) holds the multipart mixins, with
  `getMultipartRequest(ctx)` reaching the bun-common request (`:45`) [S].
- **The adapter owns a `BunRouter`**: `instance: BunRouter`
  (`bun-nest/lib/BunHttpAdapter.ts:156`, created at `:285`), its verbs
  delegate to it (`:1580-1604`), and it has the socket-free `fetch()`
  (`:602`) [S]. So a model can also be built from the adapter's own routes,
  for routes registered on it directly, with TC's walk.
- **`BunWebSocketAdapter`** speaks a socket.io-like packet model
  (connect, disconnect, event, ack, error, binary variants, each with a
  `namespace`, `:134-283`), dispatches on the event name (`:925-938`),
  routes namespaces as path suffixes (`:557`), and offers `WsEventMap` for
  typed emits (`:54-65`) [S].
- **The `./jobs` subpath** is the precedent for a module that mounts a
  bun-common router on the adapter (`BunJobsApiModule`, `onModuleInit`
  calling `adapter.use(api.basePath, api.router)`) [S].
- **AD plans** `@Validate` (AD §3.8, phase (g)), a swagger bridge that writes
  `@ApiBody`/`@ApiResponse` from Standard Schemas, and verifying
  `@nestjs/swagger` on bun-nest (phase (d)). Nothing is built.
- **NJD** measured Nest's pipeline around a non-HTTP handler through
  `ExternalContextCreator`, discovery with `DiscoveryService` and
  `MetadataScanner.getAllMethodNames`, and the decorator-config Bun bug
  [V-prior]. This document needs no ECC: controllers already run through
  Nest's own router.
- **Prior art** [V, TC §2.5]: nestia generates an SDK from controllers with a
  Go transform under TypeScript 7 (`ttsc`); under Bun only through
  `@ttsc/unplugin/bun-register` as a preload, restarting on every change.
  `@nestjs/swagger`'s CLI plugin infers DTO properties and response types
  with a TypeScript transformer run by the Nest CLI; it does not run when Bun
  executes `.ts` directly [I: no Bun mention in its docs], and its escape
  hatch is a generated `metadata.ts` loaded with
  `SwaggerModule.loadPluginMetadata` [V]. ts-rest's Nest integration
  (`@TsRestHandler`) binds handlers to a shared contract [V].

---

## 3. What a controller author writes

### 3.1 `@Validate`: AD (g), unchanged [D]

```ts
@Controller("users")
export class UsersController {
  @Get(":id")
  @Validate({ params: IdParams, responses: { 200: User, 404: Problem } })
  @Describe({ operationId: "getUser", errors: ["NOT_FOUND"], cache: { tags: ["user:{id}"] } })
  one(@Param("id") id: string): Promise<Infer<typeof User> | Infer<typeof Problem>> { … }

  @Patch(":id")
  @Validate({ params: IdParams, body: UserPatch, responses: { 200: User } })
  @Describe({ cache: { invalidates: ["user:{id}", "users"] } })
  update(@Param("id") id: string, @Body() body: Infer<typeof UserPatch>) { … }
}
```

- **What `@Validate` gives** (AD §3.8, not restated): request validation as
  an interceptor with BunValidate's semantics, optional runtime response
  checking, the return type constrained to the declared responses, a DTO
  class or any Standard Schema per target. Measured again here: a method
  returning a body matching no declared response fails to compile; `async`
  methods are accepted [M, `nest/explore-types.ts`].
- **What it cannot give**: parameter-type inference. A parameter decorator
  has no type link to its parameter, so `@Body() body: Infer<typeof S>` is
  written once per parameter (AD §3.8.3, measured there) [V-prior].
- **Status codes**: Nest's success status is `@HttpCode(n)` (default 200, or
  201 for `@Post`); the explorer reads `HTTP_CODE_METADATA` and warns when it
  names a status `responses` does not declare.
- **Its metadata** is stored under one key (`bun:validate`) holding the
  options object, which is what the explorer reads (§5.1). The spike's
  stand-in, `@TypedRoute`, stored its options the same way with `SetMetadata`
  [M].

### 3.2 `@Describe` [D]

A method (or class) decorator storing AD's `RouteDoc` plus TC's `errors` and
`cache` under `bun:describe`. Prose only, exactly like `.describe()`: it
never reaches the type system. A class-level `@Describe({ tags })` merges
under each method's.

### 3.3 Responses and errors [D]

- A Nest handler **returns** its body, so the client's response type is the
  declared schema's output after a JSON round trip (`Jsonify`, TC §4.1), the
  same as for a router.
- Error statuses are declared in `responses` like any other, as
  problem+json; a `ProblemDetailsFilter` (optional, in `./typed`) maps
  `HttpException`s to that shape with the route's `code`, so what the server
  throws matches what the client's union says. It is opt-in because an app
  usually owns its exception filters.
- **Common responses** (TC §4.2) come from `DevTypesModule.forRoot({
  commonResponses })` or the explorer's options, merged into every route.

---

## 4. Pipes, guards and interceptors

### 4.1 `StandardSchemaPipe`: secondary, for per-parameter style [D]

```ts
@Get()
list(@Query(new StandardSchemaPipe(PageQuery)) query: Infer<typeof PageQuery>) { … }
```

- It validates the **parameter's value** with BunValidate's core (a
  `validateTarget(schema, value, target)` function extracted from
  `BunValidate` so the router middleware, `@Validate` and the pipe share one
  implementation and one issue shape, `{ target, message, path }`), and
  throws a `BadRequestException` carrying the issues.
- **Its schema reaches the model**: Nest stores a parameter's pipes in
  `ROUTE_ARGS_METADATA` (`"__routeArguments__"`, NJD §7.1) with the
  parameter type (`BODY`, `QUERY`, `PARAM`); the explorer finds a
  `StandardSchemaPipe` there and reads its schema [I: the metadata layout is
  read in NJD; the pipe walk is to be measured in PR-N3].
- **Its limits, stated in the README** (AD §3.8): it cannot replace
  `req.query` in place (a second reader sees the raw value), it cannot see
  the response, and `@Query("page")` on one key describes one key, not the
  query object. `@Validate` is the recommended tool; the pipe is for teams
  already writing per-parameter pipes.

### 4.2 Guards: the dev endpoint's [D]

With N-D6 the dev endpoint is mounted below Nest's pipeline, as bun-common
middleware, and does its own auth (token, loopback, 404; TC §3.3). **No Nest
guard is needed, and none applies**: `BunHttpAdapter.use`'s own JSDoc says
guards and interceptors do not run there (AD §3.8) [V-prior]. That is the
right property for a dev tool: an app's global `AuthGuard` must not decide
whether its own type channel is reachable, and an app's guard that throws
`ForbiddenException` must not confirm it exists.

For an app that wants the endpoint inside Nest anyway (to log it through its
interceptors, say), `./typed` exports `DevTypesGuard`, which throws
`NotFoundException` on a missing or wrong token or a non-loopback peer. The
spike's guard returned `false`, which Nest turns into a **403** [M]; that is
why the shipped guard throws instead.

### 4.3 Interceptors: `@Invalidates` [D]

```ts
@Patch(":id")
@Validate({ … })
@Invalidates("user:{id}", "users")   // or from @Describe({ cache: { invalidates } })
update(…) { … }
```

After the handler's observable completes without error, the interceptor
resolves the templates against the route's params and calls bun-common's
`publishTags()` (TC §6.5, `./live`). It runs inside Nest's pipeline, so a
filter that turns an error into a success response does not publish
(publishing follows the handler, not the status) [D]. It is the Nest form of
TC's automatic invalidation for a router route with `cache.invalidates`.
`LiveModule.forRoot({ path, authorize })` mounts `liveInvalidation()` on the
adapter, as `DevTypesModule` mounts `devTypes()`, with `authorize`
optionally built from guards by NJD's `guardsAuthorize` (NJD D12) [V-prior].

---

## 5. From controllers to the route model

### 5.1 The explorer [D] [M]

`TypedRoutesExplorer` (internal, not exported), run at
`onApplicationBootstrap`, after every route is registered:

1. `DiscoveryService.getControllers()`; for each, `MetadataScanner
   .getAllMethodNames(prototype)` (NJD: `scanFromPrototype` is deprecated)
   [V-prior].
2. Per method: `PATH_METADATA` on the class and the method,
   `METHOD_METADATA` (Nest's `RequestMethod`), `HTTP_CODE_METADATA`, and the
   global prefix from `ApplicationConfig.getGlobalPrefix()` [M].
3. Schemas: `bun:validate` (§3.1), else `StandardSchemaPipe`s in
   `ROUTE_ARGS_METADATA` (§4.1), else swagger metadata (§5.4), else untyped
   with a warning [M for the first, third and fourth].
4. Prose from `bun:describe`.
5. Each schema through the same converter as bun-common's model builder
   (AD's registry, TC §8.2), with TC's input/output rule (TC §4.1), into
   TC's `ModelRoute`; the hash over the canonical JSON.

The constants come from `@nestjs/common/constants`, a deep path that Nest
12's `exports` map keeps (NJD §7.1); their values are stable strings, so the
code can define them itself if the path closes [V-prior].

Measured on Bun 1.4.3 and Nest 11.1.27 [M, `nest/results.txt`]:

```
explored 6 routes in 8.72 ms, hash 1b1503131d867aa0
  GET /api/__bun/types               devtypes.model     no @TypedRoute or swagger metadata: untyped
  GET /api/health                    health.ok          from @nestjs/swagger metadata: responses only
  GET /api/users                     users.list
  GET /api/users/:id                 users.one
  GET /api/users/untyped/legacy      users.legacy       no @TypedRoute or swagger metadata: untyped
  POST /api/users                    users.create
registered on the adapter: 6; explored keys missing from it: none
```

The dev endpoint lists itself there; the shipped explorer hides it (and
anything `@Describe({ hidden: true })`).

### 5.2 Why not a transformer [D]

| Approach | Works under Bun running `.ts` | Change detection in dev | Fidelity |
|---|---|---|---|
| **Runtime discovery (chosen)** | yes [M] | the model is rebuilt from the running app: TC §3.3's channel, unchanged | exactly what the schemas say; nothing from bare TS types |
| nestia (`@nestia/sdk` 14.0.3) | only through `@ttsc/unplugin/bun-register` as a preload, and the process must restart after a source change [V] | its own SDK regeneration | reads TS types themselves, so it also covers DTOs with no decorator [V] |
| `@nestjs/swagger` CLI plugin | no: a TS transformer run by the Nest CLI [V]; usable through its generated `metadata.ts` [V] | a build step | infers DTO properties and return types from TS [V] |
| Reading `SwaggerModule.createDocument()`'s OpenAPI | yes [I] | rebuild the document | OpenAPI 3.0-shaped, DTO classes only, lossy for Standard Schemas (AD §3.8.2) |

nestia's fidelity on undecorated TypeScript types is real, and the one thing
discovery cannot match. It is the wrong trade here: it ties the app to a
compiler pipeline Bun does not run, which is the reason to use bun-nest at
all. An app that already builds with the Nest CLI and swagger's plugin gets
that fidelity through §5.4 for free.

### 5.3 Paths: the adapter is the authority [D] [M] [I]

The explorer computes `/{globalPrefix}/{controllerPath}/{methodPath}` and
checks the set against `adapter.getInstance().routes()`; all 6 matched in the
spike [M]. **Not covered by the spike**: URI versioning
(`enableVersioning`, `@Version`), `RouterModule` prefixes and host-scoped
controllers. PR-N1 computes those with Nest's own route-path logic (the
`RoutePathFactory` Nest's router explorer uses) [I], and keeps the
cross-check, so any route whose computed path the adapter did not register
is reported by name rather than silently wrong in the client.

### 5.4 Reading swagger metadata [D] [M]

For a method with no `@Validate`, the explorer reads `@nestjs/swagger`'s
metadata by key, never importing the package. The keys, from
`@nestjs/swagger` 12.0.2's `dist/constants.js` [V]: `swagger/apiResponse`,
`swagger/apiOperation`, `swagger/apiParameters`, `swagger/apiProduces`,
`swagger/apiConsumes`, `swagger/apiUseTags`, `swagger/apiExcludeEndpoint`,
and `swagger/apiModelProperties` on DTO classes. The spike read a hand-set
`swagger/apiResponse` with an inline schema into the model's responses [M];
a real `@ApiResponse({ type: UserDto })` names a class, whose properties come
from `swagger/apiModelProperties`, which the plugin or `@ApiProperty` writes.
Converting those to JSON Schema is the swagger bridge in reverse; PR-N1
covers inline schemas and `@ApiProperty`-described classes, and reports the
rest as untyped [D]. Installing `@nestjs/swagger` beside the root's Nest in
the evidence would have duplicated `@nestjs/core`, which is why the spike set
the metadata by hand [M].

---

## 6. `DevTypesModule`: the dev sync in Nest

```ts
@Module({
  imports: [DevTypesModule.forRoot({ enabled: process.env.NODE_ENV !== "production", commonResponses: { 400: ValidationProblem } })],
})
export class AppModule {}
```

- `forRoot` **throws under `NODE_ENV=production`** when enabled, and with
  `enabled: false` returns an empty module that registers nothing [M, the
  spike's `forRoot`].
- In `onApplicationBootstrap` it runs the explorer and mounts bun-common's
  `devTypes()` (TC PR-M2) on the adapter, with the explorer as the model
  source: the same endpoint, channel, token file, loopback rule and 404s as a
  router app [D]. The model is rebuilt when the app is (a `--watch`
  restart), and on demand.
- **Under `bun --hot`**, Nest re-bootstraps only if the app's entry does so
  on reload; most Nest apps run `--watch`, which TC measured at 160 ms from
  save to the client's file [M, TC §3.3].
- Spike [M]: with a Nest-native controller and guard instead, the endpoint
  returned the model with an `ETag` and answered 304 to `If-None-Match`; no
  token gave 403 (§4.2 says why the shipped form answers 404).

---

## 7. Typed WebSocket gateways [D]

Later, with TC PR-M4 (typed channels) and AD (e) (AsyncAPI). The shape:

```ts
@WebSocketGateway({ path: "/chat", namespace: "/rooms" })
@Emits({ said: Said, joined: Joined })                         // server → client
export class ChatGateway {
  @SubscribeMessage("say")
  @ValidateMessage(Say, { ack: SayAck })                       // client → server, and its ack
  say(@MessageBody() msg: Infer<typeof Say>, @ConnectedSocket() socket: TypedSocket<typeof ChatGateway>) {
    socket.to(room).emit("said", { by: user, text: msg.text });  // checked against @Emits
    return { ok: true };                                       // checked against the ack
  }
}
```

- `@ValidateMessage` is an interceptor (gateways run interceptors and pipes)
  validating the payload with BunValidate's core, and constraining the
  handler's return to the ack schema, as `@Validate` constrains a
  controller's.
- `@Emits` feeds bun-nest's existing `WsEventMap` typing (`TypedSocket`
  derives the event map from it), so `emit` is checked without a cast [S for
  `WsEventMap`; D for the derivation].
- The explorer reads `GATEWAY_OPTIONS` (`"websockets:gateway_options"`) for
  `path` and `namespace`, `MESSAGE_METADATA` (`"message"`) for each handler,
  and `@Emits`, into TC's `ModelChannel` with `envelope: "bun-nest"`, so the
  client's `channel()` speaks bun-nest's packet format (connect, event,
  ack) rather than bun-common's raw frames [S for the constants,
  `node_modules/@nestjs/websockets/constants.d.ts`; D for the rest].
- **The shared maps** (the convention TC's `websocket.md` §11 relies on;
  built and tested by PR-W3, 2026-11-03): a gateway's schemas live in a
  shared, browser-safe module (zod and the contract core only, never the
  gateway), which the decorators take (`@ValidateMessage(Say, { ack:
  SayAck })`, `@Emits(chatEmits)`, `TypedSocket<typeof chatEmits>`) and
  which also exports the client's `channelContract({ path, receives,
  sends: { ...chatEmits, "say ack": SayAck }, replies: { say: "say ack" }
  })`. The client opens it with `channel(api, chat, { codec: "bun-nest" })`,
  so a monorepo needs no generation; a separate repo generates the same
  types from `gatewayAsyncApi()` (the ack is named `"<event> ack"` there
  too). Shown in `bun-nest/__tests__/fixtures/nest-channel/chat.shared.ts`
  and bun-client's README ("bun-nest gateways").
- Live invalidation does not need a gateway: it is §4.3's interceptor and
  TC's channel.

---

## 8. Packaging

- **`@kingsleyweb/bun-nest/typed`** (new subpath): `Describe`,
  `StandardSchemaPipe`, `DevTypesModule`, `DevTypesGuard`, `Invalidates`,
  `LiveModule`, `ProblemDetailsFilter`, and later `ValidateMessage`, `Emits`,
  `TypedSocket`. Its `consumer-check.json` entry lists no `peers`: it needs
  only bun-common (a dependency) and Nest (already a peer).
- **`@Validate`** and `Infer` stay where AD (g) puts them: bun-nest's root
  decorators module (`lib/decorators.ts`, growing from one line).
- **`validateTarget`**, the shared validation core, is a bun-common export
  (`lib/BunValidate.ts`), so the router middleware, `@Validate`,
  `StandardSchemaPipe` and `@ValidateMessage` cannot disagree.
- No `@nestjs/swagger` import anywhere: metadata is read by key (§5.4), as
  AD's bridge injects swagger's decorators rather than importing them.

---

## 9. Tests, risks, questions, PRs and names

### 9.1 Tests [D]

- **Explorer**: a fixture app with a global prefix, URI versioning, a
  `RouterModule` prefix, `@HttpCode`, a class-level `@Describe`, a
  `StandardSchemaPipe`, a swagger-only route and an untyped route gives a
  golden model; the cross-check against the adapter's routes passes, and a
  deliberately mismatched path (a negative control) produces the warning.
- **Parity with a router app**: the same routes declared on a `BunRouter`
  and on controllers give the same `ModelRoute`s, apart from `operationId`.
- **`DevTypesModule`**: production throws; disabled registers nothing; the
  endpoint's 404s, 200, 304 and channel, through `adapter.fetch()` and over
  a socket.
- **`@Invalidates`**: publishes after success only; the templates resolve;
  an exception filter returning a body does not publish.
- **Type tests**: `@Validate`'s return constraint and `@ValidateMessage`'s
  ack constraint, each with a negative control; `TypedSocket.emit` rejects an
  undeclared event.
- Each test file runs from a directory whose `tsconfig.json` sets the
  decorator flags (oven-sh/bun#28605); bun-nest's test setup already does.

### 9.2 Risks

| # | Risk | Mitigation |
|---|---|---|
| NR1 | **AD (g) is dropped** after AD (d) (AD risk 1h), leaving no typed-route decorator | this plan is the argument for (g); if it is dropped anyway, PR-N1 ships the spike's minimal `@TypedRoute` (metadata plus the return constraint, ~40 lines) [M] |
| NR2 | **Versioned and `RouterModule` paths** computed wrong [I] | the adapter cross-check (§5.3) reports each mismatch by name |
| NR3 | **Deep imports** of `@nestjs/common/constants` close in a later Nest | the values are stable strings; define them locally (NJD §7.1) |
| NR4 | **Decorator flags read from the cwd's tsconfig** (oven-sh/bun#28605): metadata silently absent | the explorer warns when a controller has `PATH_METADATA` but no method has `design:paramtypes`, naming the cause (NJD R3's bootstrap check) |
| NR5 | **Swagger class DTOs** convert poorly | inline schemas and `@ApiProperty` classes only; the rest reported untyped (§5.4) |

### 9.3 Answered by the user, 2026-11-02

The 2026-10-10 questions 1, 4 and 6 were settled by what was built
(`@Validate` V7a, `StandardSchemaPipe` V6, typed gateways V9); question 2 is
moot, since no explorer is needed. What was left was TC §14 **Q21**,
approved on 2026-11-02 with these answers:

1. **The dev endpoint is mounted below Nest's pipeline with bun-common's
   `devTypes()`**, not as a Nest controller. **Yes.**
2. **The generator reads `@nestjs/swagger`'s document** for routes without
   `@Validate`. **Yes.**
3. **`Describe`, `DevTypesModule` and `Invalidates` ship from bun-nest's
   root**, with no `./typed` subpath. **Yes.**

### 9.4 PR slicing and effort

Revised 2026-11-02 (was ~13 d):

| PR | What it ships | Depends on | Effort |
|---|---|---|---|
| ~~PR-N1 explorer~~ | not needed (Status) | — | — |
| **PR-N2** `DevTypesModule` | `forRoot`, the production refusal, mounting bun-common's `devTypes()` with `generateOpenApi(adapter.instance)` and `gatewayAsyncApi(app)` as sources; a test that its documents equal a router app's for the same routes | TC PR-M2 | ~1.5 d |
| **PR-N3** `Describe` | the prose decorator (TC's `errors`, `cache`), read by `generateOpenApi` through the same reflect-metadata path as `@Validate`'s contract | TC PR-M1 | ~1 d |
| **PR-N4** `@Invalidates` | publishing a route's `invalidates` to TC's live channel after success, with `@CacheTags`' vocabulary | TC PR-W4 | ~1.5 d |
| ~~PR-N5 typed gateways~~ | **built** (V9); the client codec is TC PR-W3 | — | — |
| | **Total** | | **~4 d** |

Examples: `examples/bun-nest/09-typed-client/` (a controller app, its
generated client, the dev sync, a gateway through the `"bun-nest"` codec),
reported to the examples with each PR.

### 9.5 Names (approved 2026-11-02)

**Approved by the user, 2026-11-02**, withdrawals included. Built names (`Validate`, `StandardSchemaPipe`,
`ValidateMessage`, `Emits`, `TypedSocket`, `gatewayAsyncApi`) are not
repeated, and `validateTarget`, `DevTypesGuard`, `LiveModule`,
`ProblemDetailsFilter` and the `./typed` subpath are withdrawn.

| Name | Kind | Where |
|---|---|---|
| `Describe` | decorator | bun-nest root |
| `DevTypesModule` (`forRoot`: `enabled`, `path`, `token`, `allowRemote`, `openapi`, `asyncapi`) | module | bun-nest root |
| `Invalidates` | decorator (interceptor) | bun-nest root |
| `bun:describe` | metadata key | internal, but visible to `Reflect` |
