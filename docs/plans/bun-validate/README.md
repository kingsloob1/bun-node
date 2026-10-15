# BunValidate everywhere: responses, Nest, WebSockets, jobs and cache on one Standard Schema core

An audit of what `BunValidate` does today, and a plan for what is missing.
The user asked for this on 2026-10-15:

> "I need to know if bun validate currently types and validates the response
> from each endpoint and also the helper decorator for the full bun validate
> decorator, interceptor, pipelines etc. I also want the plan to contain how
> bun validate feeds into websocket, bun jobs, bun cache and the typed route.
> If not prepare a plan to implement this."

So this document has two halves: **Part A** answers the questions with
evidence (§2), and **Part B** plans what Part A finds missing (§4 to §9).

Written 2026-10-15 against `develop` at `73bf4a00`. **No product code was
changed.** Every `file:line` is at `73bf4a00` and relative to `packages/`
unless it says otherwise. Measurements ran on the installed Bun,
1.4.4-canary.1 (`7583003d8`); the repo's floor is 1.4.3. The evidence is in
[`evidence/`](evidence/README.md), and each measurement there re-runs with one
command.

### Status (2026-10-15)

| Part | State |
|---|---|
| This plan | written; nothing built |
| Response contracts on the validator, `@Validate` for Nest, `.describe()`, `__schemas`, OpenAPI ([`api-docs-generation/`](../api-docs-generation/README.md), "AD") | plan only. **This plan adopts AD's design for responses and `@Validate`** and records two corrections found by re-running it (§4.2, §4.3) |
| Route model, typed client, typed channels ([`typed-client/`](../typed-client/README.md), "TC"; [`nest-typed-routes.md`](../typed-client/nest-typed-routes.md), "NTR") | plan only; consumes what this plan builds |
| Validate-on-read for caches ([`bun-cache/`](../bun-cache/README.md), "BC" §3.13) | plan only; uses this plan's shared core |
| `StandardSchemaPipe` for job data ([`nest-jobs-decorators/`](../nest-jobs-decorators/README.md), "NJD" §7.4) | plan only; **merged here with NTR's pipe of the same name** (§4.4) |

### Contents

0. [Why this is a main plan](#0-why-this-is-a-main-plan)
1. [Executive summary](#1-executive-summary)
2. [Part A: the audit](#2-part-a-the-audit)
3. [What other plans already decide](#3-what-other-plans-already-decide)
4. [Part B: the design](#4-part-b-the-design)
5. [Tests](#5-tests)
6. [PR slicing, effort and owners](#6-pr-slicing-effort-and-owners)
7. [Risks](#7-risks)
8. [Open questions for the user](#8-open-questions-for-the-user)
9. [Names needing approval](#9-names-needing-approval)
10. [Evidence](#10-evidence)

### How to read the markings

- **[M]** measured here, by a file in [`evidence/`](evidence/README.md),
  named in the bracket.
- **[S]** read from source at `73bf4a00`.
- **[P]** decided in another plan, cited; not restated.
- **[D]** designed here.
- **[I]** inferred and not run; a PR must prove it.

---

## 0. Why this is a main plan

The folder rule puts a follow-up inside the plan it extends. This is not a
follow-up of one plan:

- **Five plans each own a slice of validation and none owns validation.** AD
  puts responses on the validator to document them; TC reads them to type a
  client; NTR and NJD each plan a `StandardSchemaPipe` (the same name, two
  designs) and each asks bun-common for a shared helper under a different
  name (`validateTarget`, NTR §4.1; `validateStandard`, NJD §7.4); BC plans a
  `validate` option on caches. Someone has to say which of these is the one.
- **Two of the user's four areas are planned nowhere**: schema-backed job
  data in bun-jobs itself, and runtime validation of WebSocket messages on
  bun-common's `BunWebSocket` (AD (e) only documents them; TC PR-M4 types
  them but leaves the validation semantics open).
- **The audit found three defects and two gaps in what exists** (§2.3), which
  belong to BunValidate, not to any consumer plan.

So this is the hub: it **adopts** AD's response and `@Validate` designs by
reference (§3), corrects them where a re-run disagreed (§4.2, §4.3), designs
what nobody planned (§4.4 to §4.7), and gives one PR order across all of it
(§6). A PR that already belongs to another plan (AD (b1), AD (g), TC PR-M4,
NTR PR-N5) keeps its home and its estimate; this plan lists it so the order
is in one place.

---

## 1. Executive summary

### 1.1 The answer

**No, BunValidate neither types nor validates responses**, on any endpoint,
on either adapter. **The request side is solid**: any Standard Schema
vendor, four targets, typed handlers through the generated overloads, three
failure modes. **bun-nest has no validation piece at all**: no decorator,
pipe, interceptor or filter; users hand-write a pipe today. **Nothing feeds
WebSockets, job data or caches.** The one place in the repo that already
validates responses is bun-jobs' management API, which logs a mismatch and
nothing more.

| # | Question | Answer | Key evidence |
|---|---|---|---|
| A1 | Response validated at runtime? | **No** | a body breaking a declared schema goes out `200` [M `R1`]; no response target (`bun-common/lib/BunValidate.ts:9`); bun-jobs' API alone checks, and only logs (`bun-jobs/lib/api/routes/define.ts:289-297`) |
| A2 | Response typed? | **No** | `res` is a bare `BunResponse` in every typed handler (`bun-common/lib/types/general.ts:447-458`); `res.status(418).json({ anything })` compiles after a validator; a `responses` option is TS2353 [M `T2`–`T4`, `T9`] |
| A3 | Request side | **Yes, with 3 defects** | targets `params`/`query`/`body`/`headers`; output-typed `req.*`; but an explicit `status: undefined` answers a failed request **200** [M `R2h`], a `cookies` schema is silently ignored [M `R5`, `T7`], headers are validated but never typed [M `T6`] |
| A4 | bun-nest decorator, pipe, interceptor, filter | **No** | `bun-nest/lib/decorators.ts` is one re-export line; `interceptors.ts` is multipart only (`:182-321`); the examples hand-roll a `SchemaPipe` (`examples/bun-nest/02-http-adapter/pipeline.ts:137-160`) |
| A5 | WebSocket messages | **No** | messages are `string \| Buffer` (`bun-common/lib/BunWebSocket.ts:393-411`) [M `T10`]; bun-nest casts parsed JSON (`bun-nest/lib/BunWebSocketAdapter.ts:962-964`) |
| A6 | bun-jobs data and results | **No** | typed by type arguments only; `{ to: 42 }` reached a `BunQueue<{ to: string }>` worker [M `R8`]; `define()` has no schema option [M `T11`]. `s` **is** a Standard Schema [M `R7`] |
| A7 | bun cache | **No code**; BC plans `validate` on read | BC §3.13 |
| A8 | Typed routes, client, OpenAPI | **Request shapes yes; responses no; OpenAPI no** | the phantom `__shape` carries request shapes only (`bun-common/lib/types/routeTyping.ts:88-95`); a validator's schemas are unreachable at runtime [M `R9`] |

### 1.2 The decisions

| # | Decision | Why |
|---|---|---|
| V-D1 | **Standard Schema V1 is the one contract** across HTTP, Nest, WebSockets, jobs and caches; its JSON Schema companion (`StandardJSONSchemaV1`, AD (b0)) is the one route to documents. No vendor dependency anywhere. | It already is the contract in bun-common, bun-jobs' providers and bun-jobs' `s` [S, §2.6]. |
| V-D2 | **One shared runner in bun-common, `validateStandard(schema, value)`**: answers synchronously when the vendor does, flattens issues to `{ target, message, path }`. NTR's `validateTarget` and NJD's `validateStandard` are this one function. | The flattening exists three times already (`BunValidate.ts:368-379`, `bun-jobs/lib/api/routes/define.ts:313-342`, `bun-jobs/lib/remote/schemas.ts:551-574`) plus the examples' pipe [S]. Sync matters: §4.2. |
| V-D3 | **Responses are AD (b1)**: `validate(schemas, { responses })` by status, typed through the same single shape the overloads already carry. **Corrected here**: the server is held to the schema's *input* type, falling back to its *output* when the input is `unknown`. | Re-measured on today's router: the overloads are untouched and the bun-common and bun-nest type tests still pass [M `response-typing/`]. With input alone, three of AD's negative controls silently passed (§4.3). |
| V-D4 | **Runtime response checks: `"off" \| "warn" \| "error"`**, default `"off"`, settable on the router or adapter and per validator. `"error"` decides **before** the `Response` is produced, holding it while an async vendor settles. | The response is built synchronously inside `json()` (`bun-common/lib/BunResponse.ts:1463-1495`) and its transforms are synchronous (`:235-252`); a prototype made a 500 out of both a sync (zod) and a Promise (yup) mismatch through the real pipeline [M `response-check-proto.ts`]. |
| V-D5 | **bun-nest: AD's `@Validate` interceptor, one `StandardSchemaPipe`, and a `SchemaDto(schema)` class plus a global `StandardValidationPipe`** as the `ValidationPipe` equivalent. | `SchemaDto` gives parameter types from the schema with no restating, which a parameter decorator cannot (AD §3.8.3); measured on bun-nest with Nest's real pipeline [M `nest-schema-dto.ts`]. |
| V-D6 | **WebSockets: declared `receives`/`sends` schemas per channel, keyed by a discriminator; an invalid frame gets an error frame and the socket stays open.** | bun-jobs' API socket already does exactly this (`bun-jobs/lib/api/ws/session.ts:136`, `:168-200`, `:461-464`, `:1590-1603`) [S]. |
| V-D7 | **bun-jobs: a definition may carry `schema: { data, result }`**; data is checked on enqueue and again before the handler; a failure at processing is unrecoverable; the schema also types the registry. | R8: nothing checks a payload today, and the producer may be another deployment or the management API, whose `data` is `s.unknown` (`bun-jobs/lib/api/schemas/jobs.ts:513`) [M, S]. |
| V-D8 | **bun-cache uses the shared runner for BC's validate-on-read** and nothing more; a cached HTTP response is checked when it is produced, never on replay. | BC §3.13 already designs the semantics; only the runner and the order with `cacheResponse()` (BC §9.6) are this plan's. |

### 1.3 What it costs

| Work | Effort | Owner |
|---|---|---|
| New in this plan: V0 fixes, V1 shared core, V4 `s` and API alignment, V5 job schemas, V6 Nest pipes and `SchemaDto`, deltas on AD (b1) and TC PR-M4, V10 cache hook | **~13.5 d** | features (bun-common, bun-nest), 4c (bun-jobs) |
| Adopted, estimated in their own plans: AD (b0) 0.5–1, AD (b1) 4–5, AD (g) 5–7, TC PR-M4 ~5, NTR PR-N5 ~4.5 | **~19–22.5 d** | as there |
| Examples, per PR | **~3.5 d** | 5a |

§6 has the order.

---

## 2. Part A: the audit

### 2.1 A1 — Is the response validated at runtime? **No**

- **There is no response target.** `ValidationTarget` is
  `"params" | "query" | "body" | "headers"` (`bun-common/lib/BunValidate.ts:9`);
  the middleware validates those and calls `next()`
  (`BunValidate.ts:469-508`). Nothing in it, or in the router pipeline, sees
  the response again [S].
- **Measured**: passing `{ responses: { 200: User }, validateResponses:
  "throw" }` through a cast, a handler sending `{ totally: "wrong" }` was
  answered `200 application/json {"totally":"wrong"}` [M `R1`].
- **`BunResponse.json` checks nothing**: it records the value
  (`#sentBody`) and builds the `Response` at once
  (`bun-common/lib/BunResponse.ts:1463-1470`, `Response.json` at `:1495`)
  [S].
- **The hook that exists cannot host it.** `addResponseTransform`
  (`BunResponse.ts:1336`) runs **synchronously** as the `Response` is
  produced and sees the serialised text, not the value
  (`BunResponseTransform`, `:235-252`) [S]. An async vendor cannot answer
  there (yup returns a Promise [M `results-vendors.txt`]).
- **Prior art in the repo: bun-jobs' management API.** Each route declares
  `responses` by status (`bun-jobs/lib/api/routes/define.ts:51`, typed
  handler results `:54-56`), and with `validateResponses: true` the result is
  checked against the schema for its status and a mismatch is **logged at
  `error`; the response is sent unchanged** (`define.ts:289-297`,
  `responseMismatch` `:313-342`). Default `false`, "on in tests"
  (`bun-jobs/lib/api/config.ts:641`, `:1519`) [S]. It is internal to
  `defineRoute` and not available to any other router.

### 2.2 A2 — Is the response typed? **No**

- `TypedRouteHandler` types `req` from the path and the validator, and gives
  `res: BunResponse` with nothing narrowed
  (`bun-common/lib/types/general.ts:447-458`) [S].
- The shape a validator advertises, `ValidationShape`, has `params`, `query`
  and `body` only (`bun-common/lib/types/routeTyping.ts:88-95`), and
  `MountedHandler`, which every generated overload uses
  (`bun-common/lib/BunRouter.ts:1824-1911` for `get`;
  `bun-nest/lib/BunHttpAdapter.ts:1686-1773`), passes no response type
  (`routeTyping.ts:192-202`) [S].
- The only response typing is per call: `res.json<User>(x)`
  (`BunResponse.ts:1452-1463`), restated by hand at every call [S].
- **Measured** [`audit-types.ts`, `results-types.txt`; 7 negative controls,
  all fire]: after a validator, `res.status(418).json({ anything: 1 })`
  compiles (`T2`, and `T9` on bun-nest's adapter); `validate(s, { responses })`
  is TS2353 (`T3`); a handler returning a non-matching value compiles (`T4`);
  `res.json<User>({ id: 1 })` is refused (`T5`, the per-call check works).

### 2.3 A3 — The request side today: **yes, with three defects and two gaps**

What works [S, M `results-runtime.txt`]:

- **Targets**: `params`, `query`, `body`, `headers` (`BunValidate.ts:9-21`).
  Order fixed `headers → params → query → body` (`:433-434`).
- **Any Standard Schema**: zod 4, yup 1.7, valibot 1, arktype 2 natively,
  superstruct through `toStandardSchema` (`BunValidate.ts:345-365`; covered by
  `__tests__/bunValidate.libraries.test.ts` and `.type-test.ts`). bun-jobs'
  `s` too [M `R7a`/`R7b`].
- **Coercion is the schema's**, not BunValidate's: `page=2` passes
  `z.coerce.number()` and fails `z.number()` [M `R2a`, `R3`]; a `normalize`
  hook reshapes raw input first (`:174-190`). `params` coercion is written
  back [M `R6a`].
- **Errors**: `ValidationError` with `issues: { target, message, path }[]`,
  `targets` and `status` (`:126-162`). `onFailure`: `"next"` (default: the
  Express error pipeline), `"throw"`, `"respond"` (`{ error: "Validation
  failed", issues }`, or `formatError`) (`:117-123`, `:510-528`). Issues from
  every target by default; `abortEarly` stops at the first [M `R6b`].
- **Typing**: `req.params`/`query`/`body` become the schema's **output**, or a
  `transform` hook's return (`:94-114`); `replace: false` leaves the request
  types alone (`:110-114`) [S; `__tests__/validate.type-test.ts`] [M `T1`].

Defects and gaps found:

| # | Finding | Evidence | Planned fix |
|---|---|---|---|
| G1 | **Headers are validated but neither written back nor typed.** `x-n: "5"` passes `z.coerce.number()` and the handler still reads the string `"5"`; `req.headers` keeps its raw type. `InferValidatedShape` does carry a `headers` key (`:79-80`), but `ValidationShape` has none, so it never reaches `req`. | [M `R4a`, `T6`]; write-back skipped on purpose (`:291-295`) | document; Q9 |
| G2 | **`cookies` is not a target, and a `cookies` schema next to a known one compiles and is ignored at runtime**: a failing cookie reached the handler. Alone it is TS2353. | [M `R5`, `T7`] | V0: unknown target is a `ConfigError`; Q10 |
| G3 | **An explicit `undefined` option overrides its default.** The constructor spreads `options` over the defaults (`:425-431`), so `{ onFailure: "respond", status: undefined }` answered a **failed** request `200` with the issues body. It compiles. | [M `R2h`, `T8`] | V0 |
| G4 | **The default failure mode gives a client nothing to act on** unless the app adds an error handler: on `BunHttpAdapter` a failed query is an HTML `400 Bad Request` page; `BunRouter.fetch()` rejects with the `ValidationError`. With an app error handler, the issues are all there. | [M `R2b`, `R2f`, `R2g`] | V-D2's issue shape reused by every adapter-level filter (§4.4); Q11 |
| G5 | **The schemas are unreachable at runtime.** `validate()` returns a bare function (own keys `length`, `name`), so no route list, document or client can read them. | [M `R9`]; AD Decision 2 | AD (b)'s `__schemas`, landed early in V1 |

### 2.4 A4 — bun-nest: decorator, interceptor, pipe, filter? **None exist**

- `bun-nest/lib/decorators.ts` is one line re-exporting Nest's
  `UploadedFile(s)`; `lib/interceptors.ts` holds the multipart mixins
  (`:182-321`); there is no pipe, guard, filter or discovery code in
  `bun-nest/lib` [S].
- **The typed overloads reach the adapter's own verbs, not controllers.**
  `adapter.get("/x", validate({ query }), handler)` is typed exactly as on a
  router [M `T9`], but a controller method is registered by Nest's router
  proxy, so no `__shape` reaches it (NTR §2) [S, P].
- **Users write the pipe themselves today**: the bun-nest pipeline example
  defines a 20-line `SchemaPipe` over `~standard.validate`
  (`examples/bun-nest/02-http-adapter/pipeline.ts:137-160`) [S].

Against the "full set" asked for:

| Piece | Exists | Planned where | This plan |
|---|---|---|---|
| Method decorator applying request **and** response schemas | no | AD §3.8 (`@Validate`, an interceptor), phase (g) | adopted; corrected input/output rule (§4.3) |
| Parameter decorators typed from the schema | no; **impossible as decorators** (AD §3.8.3 measured; parameter decorators have no type link) | AD: annotate with `Infer<typeof S>` | **`SchemaDto(S)` classes** give the type with no restating [M] (§4.4) |
| `ValidationPipe` equivalent on Standard Schema | no | NTR §4.1 and NJD §7.4 (two `StandardSchemaPipe`s) | one `StandardSchemaPipe` + a global `StandardValidationPipe` reading `SchemaDto` metatypes (§4.4) |
| Response-validation interceptor | no | inside AD's `@Validate` | also standalone, globally, reading `@Validate` metadata (§4.4) |
| Exception filter for the validation shape | no | NTR's `ProblemDetailsFilter` (problem+json) | `ValidationExceptionFilter` for BunValidate's `ValidationError` and the pipes (§4.4) |
| Coexistence with Nest's `ValidationPipe` / class-validator | — | AD §3.6 (class DTOs, phase (b2)), §3.8 | §4.4.6 |

### 2.5 A5 — WebSockets: are messages validated or typed? **No**

- **bun-common**: a route handler's `message` is `string | Buffer`
  (`bun-common/lib/BunWebSocket.ts:393-411`; `router.ws` at
  `bun-common/lib/BunRouter.ts:1406-1428`) [S, M `T10`]. No message, event,
  topic or schema concept exists (AD §2.3's table still holds).
- **bun-nest**: the adapter `JSON.parse`s a frame and **casts** it to its
  packet type (`bun-nest/lib/BunWebSocketAdapter.ts:962-964`), then hands
  `data[1]` to the `@SubscribeMessage` handler. Outgoing `emit`s can be typed
  by a hand-written `WsEventMap` (`:54-65`), not by a schema [S]. Nest's own
  pipes run on gateway handlers, so `@MessageBody(new SomePipe())` would
  validate a payload today [I].
- **Prior art inside the repo**: bun-jobs' management API socket validates
  every client frame against a schema chosen by its `op`
  (`bun-jobs/lib/api/ws/session.ts:136`, `:168-200`), answers an invalid one
  with `{ type: "error", id?, code, status, detail }` and keeps the socket
  open (`:461-464`, `:1590-1603`), and runs messages in order through one
  promise chain (`:468`) [S]. The remote-worker protocol validates its frames
  synchronously with `s` (`bun-jobs/lib/remote/schemas.ts:551-574`) [S].

### 2.6 A6 — bun-jobs: data, results, `s` and `validateResponses`

- **Job data is typed, never validated.** `BunQueue<TData, TResult>` and the
  registry's `JobMap` are type-level only
  (`bun-jobs/lib/queue/BunQueue.ts:356-364`, `lib/queue/types.ts:266`);
  `BunJobs.define(name, handler, options)` has no schema option
  (`lib/BunJobs.ts:936-956`) [S, M `T11`]. **Measured**: a job added with
  `{ to: 42 }` to a `BunQueue<{ to: string }>` reached the worker and
  completed (`"sent number"`) [M `R8`]. The management API's
  `POST /queues/:queue/jobs` takes `data: s.unknown(...)`
  (`lib/api/schemas/jobs.ts:513`) [S].
- **`s` is the management API's own schema builder, and it is a Standard
  Schema**: each schema is `{ json, coerce, "~standard": { vendor:
  "bun-jobs", validate } }` (`lib/api/schema/builder.ts:31-47`, `:206-232`),
  validating synchronously against its own JSON Schema; bun-common's
  `validate()` already takes it (`define.ts:515`) [S, M `R7`]. It carries its
  JSON Schema as `.json`, **not** as `~standard.jsonSchema` [M `R7c`], and is
  exported from `@kingsleyweb/bun-jobs/lib/api` only, not the package root
  (`lib/api/index.ts:161-178`) [S].
- **`lib/api/schema/coerce.ts`** turns query and path strings into numbers,
  booleans and arrays **inside validation** for a schema wrapped in
  `s.query(...)` (`coerce.ts:1-12`, `:70-90`), so the inferred `number` is the
  truth about what a handler receives [S].
- **Could BunValidate and `s` share one abstraction?** They already share
  the contract (Standard Schema). What they do not share is the runner (the
  three copies of issue flattening above) and the route to JSON Schema (`s`
  has `.json`; zod and arktype have `~standard.jsonSchema`; valibot, yup and
  `toStandardSchema` have neither [M `results-vendors.txt`]). §4.1 closes both.
  `s` stays bun-jobs' small internal DSL; it is not a candidate for
  bun-common, which takes any vendor.
- **Provider configs already use Standard Schema with the sync/async rule
  this plan generalises**: a sync schema throws a `ConfigError` from
  `provider(config)`, an async one settles `ready` later
  (`lib/provider/define.ts:214-222`, `lib/provider/configure.ts:382`, `:471`)
  [S].

### 2.7 A7 — bun cache: **no code; validation is planned**

- No cache package or value cache exists (BC §2.1, re-checked: no
  `packages/bun-cache`) [S].
- BC §3.13 types a cache by a key-pattern map (`createCache<Schema>`) and
  offers `validate: { "user:*": UserSchema }`, any Standard Schema, checked
  on read; a failing value is a miss with an `error` event [P].
- BC §9.6 already settled where `cacheResponse()` may sit relative to
  `validate()` in the typed overloads [P].

### 2.8 A8 — Typed routes, the typed client and OpenAPI

- **Request shapes flow; responses do not.** `ValidatorMiddleware<TShape>`
  carries a phantom `__shape` (`BunValidate.ts:553-556`); the generated
  overloads take it in exactly one position and type the following handler
  through `MountedHandler` (`routeTyping.ts:192-202`) [S].
- **The typed client** (TC) builds its route model from AD's `__schemas` and
  `responses` (TC D2, D6); nothing of it is built [P].
- **OpenAPI from BunValidate schemas: not today.** The schemas are not
  reachable at runtime [M `R9`]; AD (b) plans `__schemas` and a converter
  reading `~standard.jsonSchema` first. Today zod 4 and arktype 2 carry
  it; valibot, yup, `s` and `toStandardSchema` do not
  [M `results-vendors.txt`], which matches AD's Decision 3 table.

---

## 3. What other plans already decide

Adopted by reference. This plan does not restate them; it builds on them and
changes only what §4 says.

| Piece | Where | Status | This plan's delta |
|---|---|---|---|
| `__schemas` on the validator middleware | AD Decision 2, phase (b) | plan | lands early, in V1 (§4.1), because NTR, NJD, TC and V5 all need it |
| Spec types 1.1.0 (`StandardJSONSchemaV1`) | AD phase (b0) | plan | unchanged |
| `validate(schemas, { responses })`, `BunResponse<_, TResponses>`, `status()` narrows, `json()` constrains | AD §3.7, phase (b1) | plan, spiked on an older router | **re-measured on `73bf4a00`**; body type rule corrected (§4.3) |
| Runtime response checking at finalisation, modes `"off" \| "log" \| "throw"` | AD §3.5, phase (b1) | plan | **hook point moved before the `Response` is built**, async vendors held, modes renamed (§4.2) |
| `@Validate` interceptor, class + method, return-type constraint, swagger bridge | AD §3.8, phase (g) | plan | input/output rule; standalone response interceptor (§4.4) |
| `StandardSchemaPipe` | NTR §4.1; NJD §7.4 | plan, twice | **one pipe, bun-nest root**, on the shared core (§4.4) |
| `ProblemDetailsFilter` | NTR §3.3 | plan | `ValidationExceptionFilter` beside it (§4.4) |
| `defineChannel({ receives, sends })` | TC §6.5, PR-M4 | plan, validation semantics open | the semantics (§4.5) |
| `@ValidateMessage`, `@Emits` | NTR §7, PR-N5 | plan | error frame and filter (§4.5) |
| `validate` on read for caches | BC §3.13 | plan | runner and order only (§4.7) |
| Client-side validation, `Jsonify` responses | TC §4.1, §5 | plan | unchanged; the server side here feeds it (§4.8) |

---

## 4. Part B: the design

### 4.1 The shared core (bun-common) [D]

```ts
/** A validation outcome, flattened: the typed value, or every issue found. */
export type StandardOutcome<T, TTarget extends string = ValidationTarget> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue<TTarget>[] };

/**
 * Runs one Standard Schema and flattens its issues. Answers synchronously
 * when the vendor does (zod, valibot, arktype, `s`, `toStandardSchema`), and
 * with a promise only when it returns one (yup). Callers that must decide
 * before something else happens (a response, an enqueue) rely on that.
 */
export function validateStandard<S extends StandardSchemaV1, TTarget extends string = ValidationTarget>(
  schema: S,
  value: unknown,
  options?: { target?: TTarget },
): StandardOutcome<StandardSchemaV1.InferOutput<S>, TTarget>
 | Promise<StandardOutcome<StandardSchemaV1.InferOutput<S>, TTarget>>;

/** `issue.path` as a dotted string, `""` for the value itself. */
export function formatIssuePath(issue: StandardSchemaV1.Issue): string;
```

- `ValidationIssue` gains a type parameter for its `target`, defaulting to
  today's four, so `"response"`, `"message"`, `"data"`, `"result"` and
  `"cache"` issues share one shape without widening existing code.
- **`__schemas`** (AD Decision 2): the middleware carries its schemas, and
  now its `responses`, as a non-enumerable property. Three lines; the
  prerequisite for OpenAPI, the route model, `@Validate`'s reuse of the
  middleware and §4.2.
- **bun-jobs adopts it where it copies it** (`define.ts:313-342`,
  `remote/schemas.ts:551-574`, `api/ws/session.ts:168-200`), as its owner
  decides; nothing forces it.
- **`s` gains `~standard.jsonSchema`** (`{ input, output }` returning its
  `.json`), so AD's converter reads it on the primary path with no
  `bun-jobs` vendor entry (V4).
- **V0 fixes ride first**: defaults survive an explicit `undefined` (G3); a
  key outside the known targets is a `ConfigError` at construction (G2),
  because a type cannot catch it on an inferred generic.

### 4.2 Response validation at runtime [D, M]

**Shape** (AD §3.5, renamed):

```ts
validate(
  { params: IdParams },
  {
    responses: { 200: User, 404: Problem, 204: null },  // null: no body
    responseValidation: "warn",                         // per validator; else the router's
    undeclaredStatus: "report",                         // or "allow"
  },
);
new BunHttpAdapter({ responseValidation: process.env.NODE_ENV === "production" ? "off" : "error" });
```

| Mode | What happens on a mismatch | Holds the response? |
|---|---|---|
| `"off"` (default) | nothing; no check runs | no |
| `"warn"` | the router's logger at `warn` with `{ method, path, status, mismatch }`, bun-jobs' wording; the response is sent unchanged | **never** — the check runs after the `Response` is produced |
| `"error"` | a `ResponseValidationError` (status 500, `issues` with target `"response"`) enters the error pipeline **instead of** the response, so the app's error handler renders it; with none, the adapter's 500 | only while an async vendor settles |

**Where it hooks: before the `Response` is built, not at finalisation.**
AD put the check at finalisation, reading `#sentBody`. But `json()` builds
the native `Response` at once (`BunResponse.ts:1463-1495`) and the
transforms run synchronously as it is produced (`:235-252`, `:1336`), so by
finalisation a 500 can no longer replace it. So in `"error"` mode:

- `json()`, `jsonp()` and `send(value)` run `validateStandard` on the raw
  value first. **A sync result decides in place**: valid, produce the
  response as today; invalid, hand the error to the pipeline and produce
  nothing.
- **A Promise result holds the response**: the call records the pending
  check and returns; the response is produced (or the error raised) when it
  settles. The pipeline already waits for a layer's response, so nothing
  else changes. **Measured** with a prototype that wraps `res.json` per
  request: a yup (Promise) mismatch became a `500` problem body and a valid
  yup body a `200`, through `router.fetch()` [M `results-proto.txt`, `P1c`,
  `P1d`]; a zod mismatch a `500` [`P1a`]; an undeclared `418` a `500`
  [`P1e`]; `"warn"` sent the bad body `200` and logged once [`P1b`].
- `"warn"` never holds: the response goes out and the check runs after it,
  async or not.

**Exclusions** (unchanged from AD §3.5): streams (`write`/`end` chunks, a
`ReadableStream`, `sendFile`, a `Blob`), redirects, `HEAD`, a 304 produced
by freshness, and a response already sent. `send(string)` is checked only
against a string schema. A stream is skipped with one `warn` per route.

**Cost** [M `results-vendors.txt`, a 20-item list, per check]: arktype 1.5
µs, valibot 5.2 µs, zod 5.9 µs, `s` 11.2 µs, yup **803 µs** (it always
answers with a Promise), against `JSON.stringify` 2.0 µs for the same body.
Through the pipeline [M `results-proto.txt`; the machine was at load 35 to
41, so the spread is wide and the minimum is the fairer figure]: baseline
5.6 µs/request; the check middleware with mode `off` +0.2 µs; zod `warn`
+3.0 µs, zod `error` +3.6 µs; yup `error` +228 µs. Hence the default `"off"`
and the advice: `"error"` in development and tests, `"off"` or `"warn"` in
production.

**Error statuses a route does not own** (the validator's own 400, an auth
401) are declared once on the router: `commonResponses` (TC §4.2) merges
under every route's `responses`, and `undeclaredStatus: "allow"` opts a route
out.

**bun-jobs' `validateResponses`** keeps its boolean and accepts the modes
too (`true` = `"warn"`), so the two speak one vocabulary (V4).

### 4.3 Response typing through the generated overloads [D, M]

**The design is AD §3.7's**: `ValidationShape` gains `responses`; `validate()`
infers them with `const`; `MountedHandler` and `ResolvedHandler` hand the
handler `BunResponse<unknown, ResolveResponses<Shape>>`; `BunResponse` gains a
defaulted `TResponses`; `status(C)` narrows to the declared statuses;
`json()` takes the declared bodies; one `protected setStatusRaw` covers the
class's own six status writes; `TypedRouteHandler` gains `TRes` as its
**last** parameter so existing uses compile.

**Re-measured on `73bf4a00`** [M `response-typing/`: the patch, the probe,
`run.sh`, `results.txt`]: applied to a copy of bun-common, 78 added lines
over four files, and checked with `bun --check`:

- the patched library **and bun-common's own `__tests__`** (92 files) check
  clean; bun-nest's lib and tests (252 files) check clean against it;
- all **9 negative controls** fire (wrong body for a status, undeclared
  status, `json()` held to the union, an inline validator, preceding plain
  handlers, a mount-declared shape, a zod `Date` field, …); the same probe
  against **unpatched** bun-common fails with 21 errors;
- `generate-verb-overloads.ts --check`: "up to date (25 verbs)" and
  "(16 verbs)" — **the overloads are byte-identical**.

**How it survives the three overload constraints** (CLAUDE.md, "Typed
routes"):

1. *Generated per verb, inside the class, ahead of the existing overloads* —
   untouched: no overload is added or reordered; only `MountedHandler`'s
   body changes, which every generated overload already names.
2. *Exactly one position carries a shape* — responses ride **inside** the
   shape that one validator position already carries; there is no second
   shape position.
3. *Preceding positions are `RouterHandler`* — untouched; the spike's case 7
   puts two plain handlers before the validator and the constraint still
   binds.

**Correction to AD: which side of the schema binds the server.** The first
run of the spike typed `json()` from each schema's **input**, the value the
runtime check receives. Three of AD's controls then passed silently: a
`toStandardSchema<User>` has input `unknown` (`BunValidate.ts:345-348`), so
`json()` accepted anything. The rule that held every control: **the input
type, unless it is `unknown`, then the output type.** For zod the input binds
(a `z.date()` field must be a `Date` on the server, case 14); for a wrapper or
a coercing schema, the output does. The client still sees
`Jsonify<output>` (TC D5).

**Boundaries, unchanged from AD and re-confirmed** (they must compile): `send()`
and `jsonp()` are unconstrained, a helper taking a bare `BunResponse`
escapes, a returned body is ignored by the router, separate
`res.status(200); res.json(b)` is held only to the union, a declared status
never sent is not an error.

### 4.4 bun-nest: decorators, pipes, interceptor, filters [D, M]

#### 4.4.1 `@Validate` (AD §3.8, phase (g))

Adopted as designed: an **interceptor** (it runs before the handler and
wraps its result, so one construct validates the request and the response),
method and class forms with per-target merge, `responses` constraining the
method's **return type** (AD measured; NTR re-measured), schemas or DTO
classes per target, the swagger bridge. Changes here:

- the return type follows §4.3's input/output rule;
- request validation calls `validateStandard`, and replaces `req.query`/
  `req.body` in place, as the router middleware does;
- response checking follows §4.2's modes; in an interceptor it is naturally
  async (an `rxjs` `mergeMap`), so `"error"` throws
  `InternalServerErrorException` carrying the issues and Nest's filters render
  it.

#### 4.4.2 One `StandardSchemaPipe`

`new StandardSchemaPipe(schema, { target? })`, exported from bun-nest's
**root** (NJD's placement; NTR wanted `./typed`): it serves controllers
(`@Query(new StandardSchemaPipe(Page))`), gateways
(`@MessageBody(...)`) and job handlers (`@JobData(...)`, NJD) alike. It
throws `BadRequestException` with `{ error: "Validation failed", issues }`,
BunValidate's shape. One implementation replaces NTR PR-N3's pipe half and
NJD's pipe.

#### 4.4.3 `SchemaDto(schema)` and a global `StandardValidationPipe`: the `ValidationPipe` equivalent, and typed parameters

A parameter decorator cannot type its parameter (AD §3.8.3). A **class** can,
because the parameter's type is the class:

```ts
const CreateUser = z.object({ name: z.string().min(1), age: z.coerce.number().int() });
class CreateUserDto extends SchemaDto(CreateUser) {}      // instance type = the schema's output

@Post()
create(@Body() body: CreateUserDto) { body.age; }          // number — nothing restated

app.useGlobalPipes(new StandardValidationPipe());           // validates every SchemaDto parameter
```

`SchemaDto(S)` returns an abstract class whose instance type is
`InferOutput<S>` and which carries `S` as a static `schema`. With
`emitDecoratorMetadata`, Nest hands that class to every pipe as
`metadata.metatype`, so **one global pipe** validates every parameter typed
with a `SchemaDto` and passes the rest through — exactly how Nest's own
`ValidationPipe` finds class-validator DTOs.

**Measured on bun-nest's `BunHttpAdapter`** with Nest's real pipeline
through `adapter.fetch()` [M `nest-schema-dto.ts`, `results-nest.txt`]: a
valid body is coerced (`age: "41"` → `41`) and answered 201; an invalid body
and an invalid query are 400 with `issues` naming `body.name`, `body.age` and
`query.page`. **Negative controls**: the same app without the pipe accepts
the invalid body (201) and hands the handler strings typed as numbers; a
wrong-typed literal against the DTO type is TS2322; a schema whose output is
a **union** cannot be a class instance type (TS2509), so such a schema uses
`StandardSchemaPipe` and an `Infer<typeof S>` annotation instead.

This is the nestjs-zod `createZodDto` pattern, made vendor-neutral. It is
also the cheapest migration path from class-validator (§4.4.6): the
parameter keeps a DTO class name.

#### 4.4.4 Response-validation interceptor

`@Validate({ responses })` checks its own route. For a whole app,
`app.useGlobalInterceptors(new ResponseValidationInterceptor({ mode }))`
reads each route's `bun:validate` metadata (NTR §3.1's key) and checks every
declared route, so one line turns on checks in development without touching
controllers.

#### 4.4.5 Exception filters

- **`ValidationExceptionFilter`** catches BunValidate's `ValidationError`
  (thrown by a `validate()` middleware in `"throw"` mode under Nest, or by the
  pipes) and `ResponseValidationError`, and answers `{ error, issues }` with
  the error's status. Opt-in, `@Catch`-scoped, so it never shadows an app's
  own filters.
- **`ProblemDetailsFilter`** (NTR §3.3) stays the problem+json option.
- A `validate()` middleware mounted with `adapter.use()` runs **below**
  Nest's pipeline (AD §3.8's table): its errors reach the adapter's error
  handler, never a Nest filter. The README says so; `@Validate` is the Nest
  route.

#### 4.4.6 Composing with BunHttpAdapter, with plain Nest, and with class-validator

| Situation | What works |
|---|---|
| bun-nest `BunHttpAdapter` | everything above; the interceptor reaches the real `BunRequest` as `getMultipartRequest` does (`bun-nest/lib/interceptors.ts:45`) |
| `@nestjs/platform-express` or `-fastify` | the pipes, `SchemaDto` and the filters are platform-neutral; `@Validate`'s in-place replacement must use `Object.defineProperty` for Express 5's getter `req.query` [I: to measure in PR-V7] |
| Existing class-validator DTOs | keep `ValidationPipe` for them; `StandardValidationPipe` passes non-`SchemaDto` parameters through, so both can be global. AD (b2) makes a DTO class acceptable to `@Validate` and `validate()` |
| Migrating a DTO | replace `class CreateUserDto { @IsString() name }` with `class CreateUserDto extends SchemaDto(CreateUser) {}`: the parameter, its name and every import stay |
| Both pipes owning one parameter | do not: the interceptor runs before pipes, so `ValidationPipe({ transform: true })` would re-coerce parsed output (AD §3.8) |

### 4.5 WebSockets [D]

#### 4.5.1 bun-common: validation semantics for TC's `defineChannel`

```ts
const chat = defineChannel({
  path: "/rooms/:room",
  discriminator: "type",                                  // default; frames are JSON { type, data, id? }
  receives: { say: Say, typing: null },                   // client → server; null: no payload
  sends: { said: Said, error: ChannelError },             // server → client
  messageValidation: { in: "error", out: "warn" },        // as responseValidation
});
router.ws(chat.path, chat.handler({
  say(ws, msg, { reply }) { chat.publish(ws.data.params.room, "said", { by: ws.data.custom.user, text: msg.text }); },
}));
```

- **Incoming**: parse JSON, pick the schema by the discriminator, run
  `validateStandard`; **an invalid frame gets an error frame and the socket
  stays open**: `{ type: "error", id?, code: "VALIDATION", status: 400,
  issues }`, the bun-jobs socket's shape plus `issues`. `closeOnInvalid: true`
  closes with 1007 (invalid payload) instead. An unknown `type` is the same
  error with `code: "UNKNOWN_MESSAGE"`.
- **Order is kept**: a socket's messages are validated and handled through
  one promise chain, so an async vendor never reorders frames (bun-jobs'
  `#work` chain, `api/ws/session.ts:468`).
- **Outgoing**: `chat.send(ws, "said", data)` and `chat.publish(topic, …)`
  are typed by `sends`; in `"warn"`/`"error"` they are checked before the
  frame is written (`"error"` throws to the caller rather than sending).
- **Typed handlers**: each handler's `msg` is the schema's output; `ws.data.params`
  from the path literal (TC's typed `router.ws()` overload).
- **Binary frames** are not validated (a schema sees a `Buffer` only if the
  channel declares `binary: true`).
- **Documents**: the same declaration is AD (e)'s `WsChannelDoc`
  (`receives`/`sends`), so AsyncAPI reads it unchanged.

#### 4.5.2 bun-nest

- `@ValidateMessage(schema, { ack })` and `@Emits({ event: schema })` (NTR §7,
  PR-N5) on the shared core; a `@MessageBody(new StandardSchemaPipe(S))`
  works without them.
- **Error frames**: `WsValidationFilter` maps a `ValidationError` or the
  pipe's `BadRequestException` to a `WsException`, which bun-nest already
  sends as `["exception", { status, message, cause }]` (AD §5.2), with the
  issues as `cause`.

### 4.6 bun-jobs: schema-backed job data and results [D]

```ts
const jobs = new BunJobs({ namespace: "shop", driver })
  .define("sendEmail", async (job) => send(job.data.to), {
    schema: { data: z.object({ to: z.email() }), result: z.object({ id: z.string() }) },
    attempts: 5,
  });
```

- **Types**: `define()` with a schema infers the handler's `job.data` and
  return from it. A schema map types a whole registry:
  `type Jobs = JobMapFromSchemas<typeof schemas>`, then `new BunJobs<Jobs>()`
  as today (`lib/queue/types.ts:266` stays the mechanism).
- **Where it runs**:

  | Point | Default | On failure |
  |---|---|---|
  | **Enqueue** (`add`, `now`, `run().start()`, `addBulk`, flows) on a context that defines the name | on | the add rejects with `JobDataValidationError` (issues, target `"data"`); nothing is written |
  | **Before the handler**, in the worker | on | the job fails as `UnrecoverableJobError` with the issues as `cause`: no retry, straight to `dead` (NJD measured the same rule for a Nest pipe: `attemptsMade=1` of 3) |
  | **The result** | `"off"`; `"warn"`/`"error"` as §4.2 | `"warn"` logs; `"error"` fails the attempt |

- **Why both ends**: the enqueue check fails fast for the caller; the
  processing check is the only net for a producer in another deployment, the
  management API, or a job written before the schema changed — R8's case.
  `dataValidation: "enqueue" | "process" | "both" | "off"` per definition
  (default `"both"`).
- **The handler gets the parsed value** (defaults applied, coercion done),
  as a `replace: true` validator does; the stored job keeps what the
  producer sent.
- **Sync vendors decide synchronously** inside the add, as provider configs
  do (`lib/provider/configure.ts:382`); an async vendor makes the add wait for
  it. Cost is microseconds against a driver round trip.
- **A bare `BunQueue`** knows no registry (README "A standalone
  `new BunQueue(...)`"), so it takes `schema` in its own options for the
  enqueue check; its worker takes the same.
- **The management API**: `POST /queues/:queue/jobs` validates `data`
  against the definition's schema and answers 400 `VALIDATION` with the
  issues (today `data` is `s.unknown`); `GET /definitions` publishes each
  definition's data and result JSON Schema (through AD's converter, `{}` and
  a warning when a vendor has none), so bun-jobs-ui can render an add-job
  form. This is a contract change for bun-jobs-ui (§6).
- **`s` is unchanged in role**: the API's own DSL. Job schemas are the
  user's, any vendor.
- **Nest**: NJD's `@Process(Queue, name)` reads the definition's schema; its
  `@JobData(new StandardSchemaPipe(S))` stays for the decorated style.

### 4.7 bun cache [D]

- BC §3.13's `validate: { "user:*": UserSchema }` runs through
  `validateStandard` (a read is already async, so an async vendor costs
  nothing extra in shape); a failing value is a miss plus an `error` event
  carrying issues with target `"cache"`.
- **Types from validators**: `createCache({ validate: { "user:*": User } })`
  may infer its key map from the validators, so a schema written once types
  and checks the cache (`CacheSchemaFrom<typeof validate>`).
- **`validateOnWrite`** (development) checks a `set` and a loader's value
  before storing, so a bad value never reaches a shared L2.
- **`cacheResponse()` and response checks**: the check runs when the handler
  produces the response, on a miss; a replayed hit is not re-checked (it
  was checked when stored). `cacheResponse()` sits **before** `validate()`
  (BC §9.6), so the order is cache → validate → handler and a hit skips both.

### 4.8 Typed routes, the typed client and OpenAPI [D]

- **Responses join the route shape** (§4.3), so the route model (TC PR-M1)
  reads `__schemas.responses`, the client types each status as
  `Jsonify<output>` (TC D5, D6), and OpenAPI lists them (AD (a), (b), (b1)).
- **One declaration feeds five things**: request validation, request types,
  response types, runtime response checks, the document. bun-jobs'
  `defineRoute` has proven that shape on 84 routes (TC §2.3).
- **Headers (G1)** reach the model and the client as request headers to send,
  even though the server does not write them back.
- **Job and channel schemas** reach documents the same way: `/definitions`
  (§4.6) and AsyncAPI channels (§4.5).

---

## 5. Tests

Every new check ships with a negative control: shown to fail on the base, or
by a mutation that removes the thing it checks (`docs/agentic-setup.md`,
"Negative controls").

| PR | Runtime tests | Type tests | Examples (5a) |
|---|---|---|---|
| V0 | `__tests__/bunValidate.test.ts`: explicit `undefined` keeps 400 (fails on base: 200, R2h); an unknown target throws `ConfigError` (base: silently passes, R5) | `__tests__/validate.type-test.ts`: unchanged | `examples/bun-common/12-options/validate-options.ts` gains both |
| V1 | `bunValidate.test.ts`: `validateStandard` sync for zod/valibot/arktype, Promise for yup; issue paths; `__schemas` survives mounting | `validate.type-test.ts`: `StandardOutcome` narrowing; `ValidationIssue<"response">` | `06-validation/schema-libraries.ts` |
| V3 (AD b1) | new `__tests__/bunValidate.responses.test.ts`: each mode × sync/async vendor × `json`/`send`/`jsonp`; exclusions (stream, redirect, HEAD, 304); `undeclaredStatus`; router-level default; the error pipeline sees `ResponseValidationError` | new `__tests__/responses.type-test.ts` from `evidence/response-typing/responses.spike.ts` (9 controls, 7 boundaries); `verbTyping.type-test.ts` and `mountTyping.type-test.ts` gain response cases; `bun-nest/__tests__/nestVerbTyping.type-test.ts` too; `generate-verb-overloads.ts --check` | `06-validation/responses.ts` (new) |
| V4 | bun-jobs `__tests__/api/*`: `validateResponses: "error"`; `s` `~standard.jsonSchema` equals `.json` | — | `examples/bun-jobs/10-options/jobs-api-options.ts` (its `validateResponses` step) |
| V5 | bun-jobs: enqueue rejects, nothing written; processing fails to `dead` with `attemptsMade=1`; parsed value reaches the handler; result modes; on memory plus one SQL and Redis; the API's 400 and `/definitions` schemas | `define` infers `job.data`; `JobMapFromSchemas`; negative controls | `examples/bun-jobs/` new `job-schemas.ts`; playground addition (d6 reviews) |
| V6 | bun-nest: the pipe, the global pipe (with and without, as `results-nest.txt`), the filter, through `adapter.fetch()` | `SchemaDto` instance type; TS2509 for unions | `examples/bun-nest/02-http-adapter/pipeline.ts` drops its hand-written pipe |
| V7 (AD g) | as AD §9.5 and NTR §9.1, plus the response interceptor | return-type constraint with input/output rule | `examples/bun-nest/08-validate/` (AD) |
| V8 (TC M4) | frames: valid, invalid → error frame, unknown type, order kept with an async vendor, `closeOnInvalid`, outgoing modes | handler `msg` types; `send` rejects an undeclared type | `examples/bun-common/` WebSocket channel example |
| V9 (NTR N5) | as NTR §9.1, plus `WsValidationFilter` | as NTR | `examples/bun-nest/04-websockets/` |
| V10 (in BC) | as BC §13, plus issues target `"cache"` | `CacheSchemaFrom` | BC's |

---

## 6. PR slicing, effort and owners

Owners as of the 2026-10-10 roster (`docs/agentic-setup.md`): the **features
agent** (bun-node-ae) builds bun-common and bun-nest until their own agents
exist; **4c** owns bun-jobs; **d6** owns bun-jobs-ui and the playground;
**5a** owns examples. Each PR passes the full gate for what it touches, and
every user-facing PR sends 5a a CHANGE REPORT before merging.

| # | PR | Scope | Depends on | Effort | Owner |
|---|---|---|---|---|---|
| 1 | **V0** BunValidate fixes | G3 (defaults survive `undefined`), G2 (unknown target → `ConfigError`) | — | 0.5 d | features |
| 2 | **V1** shared core | `validateStandard`, `StandardOutcome`, `formatIssuePath`, `ValidationIssue<T>`, `__schemas` (AD (b)'s first commit) | V0 | 1 d | features |
| 3 | **AD (b0)** spec types 1.1.0 | as AD | — | 0.5–1 d (AD) | features |
| 4 | **V3 = AD (b1)** response contracts | AD's four files (the spike's patch) with §4.3's rule; §4.2's modes, hold for async vendors, router/adapter default, `ResponseValidationError`, `commonResponses`; consumer check for the `BunResponse` surface | V1, (b0) | 4–5 d (AD) **+1 d** | features; bun-nest owner reviews |
| 5 | **V4** bun-jobs alignment | `s` gains `~standard.jsonSchema`; `validateResponses` accepts modes; optional adoption of `validateStandard` in its three copies | V1, (b0) | 1.5 d | 4c |
| 6 | **V5a** job schemas, runtime | `define({ schema })`, `BunQueue`/worker `schema`, enqueue and process checks, result modes, `JobMapFromSchemas` | V1 | 3 d | 4c |
| 7 | **V6** Nest pipes | `StandardSchemaPipe` (root), `SchemaDto`, `StandardValidationPipe`, `ValidationExceptionFilter`; replaces NTR PR-N3's pipe half and NJD's pipe | V1 | 2.5 d | features |
| 8 | **AD (a), (b)** route metadata and converters | as AD | V1 | 10–14 d (AD) | features |
| 9 | **V5b** job schemas in the API | add-route validation, `/definitions` JSON Schema; **contract change** | V5a, AD (b) | 1.5 d | 4c; d6 reviews the contract |
| 10 | **V7 = AD (g)** `@Validate` | as AD, §4.4.1's changes, `ResponseValidationInterceptor` | V3, V6, AD (d) | 5–7 d (AD) **+0.5 d** | features |
| 11 | **V8 = TC PR-M4** typed channels | `defineChannel` with §4.5.1's semantics | V1, AD (e) for documents | ~5 d (TC) **+1 d** | features |
| 12 | **V9 = NTR PR-N5** typed gateways | `@ValidateMessage`, `@Emits`, `WsValidationFilter` | V6 | ~4.5 d (NTR) **+0.5 d** | features |
| 13 | **V10** cache hook | inside BC's core PR: `validateStandard`, target `"cache"`, `validateOnWrite`, `CacheSchemaFrom` | V1, BC core | 0.5 d inside BC | BC's owner |

**New in this plan**: V0 0.5 + V1 1 + V3 delta 1 + V4 1.5 + V5a 3 + V5b 1.5 +
V6 2.5 + V7 delta 0.5 + V8 delta 1 + V9 delta 0.5 + V10 0.5 = **~13.5 d**.
**Adopted** (estimated in AD, TC, NTR, and not counted again): (b0), (b1),
(g), PR-M4, PR-N5 ≈ 19–22.5 d; AD (a)/(b) are AD's own critical path.

**Order**: V0 → V1 → (b0) → V3. V4, V5a and V6 can run beside V3 once V1
merges. V5b waits for AD (b)'s converter; V7 for V3, V6 and AD (d); V8 and V9
come last, after AD (e) and TC PR-M1.

**Change reports**:

| PR | To | What |
|---|---|---|
| V0 | 5a | behaviour change: explicit `undefined` keeps the default; unknown targets throw; affects `examples/bun-common/06-validation/*` and `12-options/validate-options.ts` if they rely on either |
| V1, V3 | 5a; 4c; d6 | new exports and options; the `BunResponse` type parameter (bun-jobs' `define.ts` and bun-jobs-ui's server use `BunResponse` and must still check); consumer-check re-run |
| V4, V5a, V5b | 5a (from 4c); **d6** | new definition option and errors; V5b changes `api/contract` (`DefinitionDto` gains data/result schemas; the add route a `VALIDATION` problem with issues), so bun-jobs-ui's fixtures and typecheck move with it; playground addition reviewed by d6 |
| V6, V7, V9 | 5a | new bun-nest exports; `examples/bun-nest/02-http-adapter/pipeline.ts` can drop its `SchemaPipe` |
| V8 | 5a | new channel API |
| V10 | BC's owner | the runner it calls |

---

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **The `BunResponse` type parameter** ripples into consumers who name `BunResponse<T>` | it is defaulted and last; the spike checked bun-common's and bun-nest's tests clean; V3 re-runs `scripts/consumer-check.ts` for all four packages |
| R2 | **Holding a response for an async vendor** changes timing for a route that writes after `json()` | only in `"error"` mode and only for a vendor returning a Promise; documented; yup is the one measured vendor that does |
| R3 | **`"error"` in production** turns a stale schema into outages | default `"off"`; the README recommends `"error"` for development and tests only, as bun-jobs does ("on in tests") |
| R4 | **A forgotten global pipe makes `SchemaDto` types a lie** (the control: strings typed as numbers) | `StandardValidationModule` registering the pipe as `APP_PIPE`; a dev-time warning when a route has a `SchemaDto` parameter and no pipe ran [D] |
| R5 | **Decorator metadata** depends on the cwd's tsconfig (oven-sh/bun#28605) | `SchemaDto` needs `design:paramtypes`; the same bootstrap check NTR NR4 plans |
| R6 | **Job schema drift across deployments** fails jobs at processing | that is the point of the second check; failures are unrecoverable and visible in `dead`, with the issues |
| R7 | **Duplicate work** with AD/NTR/NJD if their PRs proceed independently | §3 and §6 are the single order; NTR PR-N3 and NJD's pipe are replaced by V6 |

---

## 8. Open questions for the user

1. **Is this the right home** — a main plan that adopts AD's response and
   `@Validate` designs and owns the order — rather than a sub-plan of AD?
   **Recommended: yes** (§0).
2. **Default for runtime response checks?** **Recommended: `"off"`**,
   with the README recommending `"error"` in development and tests. (TC D11
   turns client-side checks on in development; the server stays explicit, as
   bun-jobs' `validateResponses` does.)
3. **Mode names: `"off" | "warn" | "error"` (here) or AD's
   `"off" | "log" | "throw"`?** **Recommended: here's.** `"throw"` reads as
   if the handler throws; what happens is a 500 through the error pipeline.
4. **The server is held to the schema's input, falling back to its output
   when the input is `unknown`.** **Recommended: yes** (§4.3, measured).
5. **A `"parse"` mode that sends the schema's output** (stripping unknown
   keys, as Fastify's serialiser does, to stop leaking fields)? **Recommended:
   later, opt-in.** Check-only never changes a response.
6. **One shared runner named `validateStandard`** (NJD's name) instead of
   NTR's `validateTarget`? **Recommended: yes.**
7. **One `StandardSchemaPipe` in bun-nest's root**, replacing NTR's and NJD's
   two? **Recommended: yes.**
8. **`SchemaDto` + `StandardValidationPipe` as the `ValidationPipe`
   equivalent?** **Recommended: yes**; union-output schemas use the pipe and
   `Infer<>`.
9. **Headers (G1)**: keep validate-only (documented), or write the parsed
   headers somewhere typed? **Recommended: keep and document**; a new request
   member is new API for little gain.
10. **Cookies (G2)**: reject unknown targets now (V0), and add `cookies` as a
    validate-only target later on demand? **Recommended: yes.**
11. **The default `onFailure: "next"` answers an HTML 400 on the adapter
    (G4).** Keep it (Express-style: the app decides), or default the
    adapters to a JSON `{ error, issues }`? **Recommended: keep**, and show
    the error handler in the README's first example.
12. **Job data checked at both enqueue and processing by default**, a
    processing failure unrecoverable, the handler given the parsed value?
    **Recommended: yes to all three.**
13. **An invalid WebSocket frame: an error frame with the socket left open**
    (bun-jobs' behaviour), `closeOnInvalid` opt-in? **Recommended: yes.**

---

## 9. Names needing approval

| Name | Kind | Where |
|---|---|---|
| `validateStandard`, `StandardOutcome`, `formatIssuePath` | functions, type | bun-common root |
| `responses`, `responseValidation` (`"off" \| "warn" \| "error"`), `undeclaredStatus` | `validate()` options; `responseValidation` also a router and adapter option | bun-common |
| `ResponseValidationError` | error class | bun-common |
| `commonResponses` | router and adapter option (TC's name) | bun-common |
| `StandardSchemaPipe`, `SchemaDto`, `StandardValidationPipe`, `StandardValidationModule`, `ValidationExceptionFilter`, `ResponseValidationInterceptor`, `WsValidationFilter` | pipes, class factory, module, filters, interceptor | bun-nest root |
| `schema: { data, result }`, `dataValidation`, `resultValidation`, `JobDataValidationError`, `JobMapFromSchemas` | definition and queue options, error, type | bun-jobs |
| `discriminator`, `messageValidation`, `closeOnInvalid` | `defineChannel` options (TC's function) | bun-common |
| `validateOnWrite`, `CacheSchemaFrom` | option, type | bun-cache |

---

## 10. Evidence

Everything is in [`evidence/`](evidence/README.md); its README says how to
re-run each file and what passing means.

| File | What it measures |
|---|---|
| `audit-runtime.ts` → `results-runtime.txt` | R1–R9: responses unchecked; failure modes and shapes; the `status: undefined` defect; coercion; headers; cookies ignored; params write-back; `s` through `validate()`; job data unchecked; schemas unreachable |
| `audit-types.ts` → `results-types.txt` | T1–T11 on develop, 7 negative controls shown to fire |
| `vendors-sync.ts` → `results-vendors.txt` | which vendors answer synchronously, which carry `~standard.jsonSchema`, and the cost of one check |
| `response-check-proto.ts` → `results-proto.txt` | a 500 from a sync and an async mismatch; `"warn"`; per-request cost (heavy-run wrapper, load 35–41) |
| `response-typing/` (`response-typing.patch`, `responses.spike.ts`, `run.sh`, `results.txt`) | AD §3.7 re-applied to `73bf4a00`: library, bun-common tests and bun-nest clean; 9 controls fire; unpatched base fails; overloads unchanged |
| `nest-schema-dto.ts` → `results-nest.txt` | `SchemaDto` + a global pipe on bun-nest through Nest's real pipeline; no-pipe control; type controls |
