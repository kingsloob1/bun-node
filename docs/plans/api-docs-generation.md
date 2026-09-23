# Auto-generated API documentation — implementation plan

OpenAPI 3.1 for the HTTP adapter, AsyncAPI 3.0 for the WebSocket adapter,
across `bun-common`, `bun-nest` and the existing `bun-jobs` prior art.

Status: **plan only**. Nothing here has been implemented. Every claim about
existing code cites a file; every claim marked **measured** was produced by
running code against this checkout (Bun 1.4.3-canary.1, 2026-09-22). Claims
marked **assumed** were not executed.

---

## 1. Executive summary

`bun-jobs` already ships a complete OpenAPI 3.1 + AsyncAPI 3.0 generator
(`packages/bun-jobs/lib/api/spec/`, ~1,800 lines) validated against both
official meta-schemas. It works because bun-jobs **declares** its routes
through `defineRoute()` — a closed set of 60-odd definitions carrying
`operationId`, `summary`, `tags`, `responses`, `errors` and schemas built with
its own `s.*` DSL. None of that exists for an arbitrary `BunRouter`.

The whole plan turns on three decisions.

### Decision 1 — the metadata carrier is a chained `.describe()`, keyed on the handler function

Route documentation must attach *after* registration, not as a new argument
position. CLAUDE.md records three hard constraints on the generated verb
overloads; a new positional argument would break the third ("preceding
positions are typed `RouterHandler`, not a union") and very likely the second.
`BunRouter` already has the exact mechanism needed: `#lastRoute`, used by
`setName()` (`BunRouter.ts:4110`). `.describe(meta)` mirrors it one-for-one.

The metadata store must be keyed on **the route's terminal callback function**,
not on the `Route` object. **Measured**: mounting a sub-router creates a *new*
`Route` and a *new* `callbacks` array (`mergeRoute` →
`getFormattedSetRouteOption`, `BunRouter.ts:759-800`), but the callback
function identities survive:

```
Route object identity preserved: false
callbacks array identity preserved: false
terminal callback identity preserved: true
```

A `WeakMap<Function, RouteDoc>` therefore survives `use(subRouter)` with no
change to `mergeRoute`. Zero cost when unused: an empty `WeakMap` and one
branch in `setRoute`.

### Decision 2 — request schemas come from `BunValidate`, but only after the middleware carries them at runtime

`validate({ query, body })` returns a bare closure (`BunValidate.ts:middleware()`).
The schemas live in the `BunValidate` instance's private `#options`; the
returned function advertises them **only as the phantom `__shape` type**
(`ValidatorMiddleware<TShape>`, `BunValidate.ts`). At runtime they are gone.

The fix is three lines: attach the schemas to the returned handler as a
non-enumerable property. **Measured** — the property survives registration with
function identity intact:

```
callback[0] carries __schemas: true   same fn identity: true
```

This is the single highest-leverage change in the plan. Every zod/valibot/
arktype/yup schema a user already wrote for validation becomes documentation.

### Decision 3 — read `~standard.jsonSchema` first; vendor converters are a **structural** fallback

The premise most of this plan was drafted under is out of date. **Standard
Schema gained an official JSON Schema companion interface**: `@standard-schema/spec`
**1.1.0** (published 2025-12-15) added `StandardJSONSchemaV1`, a sibling of
`StandardSchemaV1` sharing the `~standard` property:

```ts
readonly jsonSchema: {
  readonly input:  (options: { target: Target; libraryOptions?: … }) => Record<string, unknown>;
  readonly output: (options: { target: Target; libraryOptions?: … }) => Record<string, unknown>;
};
// Target = "draft-2020-12" | "draft-07" | "openapi-3.0" | (string & {})
```

It is a *sibling*, not an extension, so detection is a runtime feature check,
not a version check: `typeof s["~standard"].jsonSchema?.output === "function"`.

**Measured on this checkout:**

| Vendor | Version | `~standard.jsonSchema`? | Fallback needed |
|---|---|---|---|
| zod | 4.6.5 | **yes** — `{input, output}` | no |
| arktype | 2.2.3 | **yes** — `{input, output}` | no |
| valibot | 1.5.0 (core) | **no** | `@valibot/to-json-schema`'s `toStandardJsonSchema`, which *adds* one |
| yup | 1.7.1 | **no** (`~standard` present, `vendor: "yup"`, no `jsonSchema`) | our own `describe()` mapper |
| superstruct | 2.0.2 | no `~standard` at all | none possible — explicit JSON Schema only |

So the design is two layers, and the first one is vendor-agnostic:

1. **`~standard.jsonSchema`** when present — no vendor knowledge, no imports,
   works for every library that adopts the companion spec (per
   standardschema.dev/json-schema: zod ≥4.2, arktype ≥2.1.28, valibot ≥1.2 via
   the companion package, VineJS, Sury, stnl, GraphQL Standard Schema).
2. **A vendor registry keyed on `~standard.vendor`** for everything else. Its
   converters are **structural**, exactly like the logging adapters
   (CLAUDE.md: *"Adapters are structural — nothing imports those libraries."*)
   — **measured**, zod's `.toJSONSchema()` and arktype's `.toJsonSchema()` are
   *instance methods* and yup's `.describe()` is too, so the fallbacks for
   older versions need no imports either.

Either way bun-common gains **no dependency, no optional peer, and no
declaration that imports an undeclared package**.

### Decision 4 — responses ride on the **validator**, not on `.describe()`

This was forced by a spike, and it resolves what would otherwise be two
competing places to declare a response.

`.describe()` is chained *after* the verb call, so the handler has already been
checked by the time it runs. **Spiked** (`spike/chained.ts`): even given the
most generous possible builder — `get()` returning a `Builder<H>` that carries
the handler's type — a subsequent `.describe({ responses })` produces **no
error** for a handler that returns the wrong shape. Enforcement is impossible
by construction. The same spike shows the converse: once responses are
declared **before** the handler, a wrong body is caught.

So the two mechanisms divide cleanly, and the split is a rule, not a
preference:

| Mechanism | Owns | Reaches the type system? |
|---|---|---|
| `.describe({ … })` | prose: `summary`, `description`, `tags`, `operationId`, `deprecated`, `hidden`, `security`, `extensions` | no — and never needs to |
| `validate(schemas, { responses })` | anything that must be **enforced**: request schemas (already) and now response status + shape | **yes** — it is the one shape-carrying position |

A route that wants *documented* responses with no runtime or compile-time
checking uses `.describe({ responses })`, which stays in the API for exactly
that case (a route with no validator, a legacy handler, a hand-written
fragment). When both are present the validator wins and `.describe()`'s
`responses` is merged in for documentation only, with a warning if they
disagree. §3.4 states the rule.

Three results, all **spiked against the real `BunRouter`** (a full copy of
`packages/bun-common` with the changes applied — CLAUDE.md records that the
per-position-shape idea worked in isolation and collapsed in the real class,
so isolation was not an option):

- Narrowing `res` through the validator **works**, including for mounted
  sub-routers, and the error messages are clean (§3.7).
- The patched library typechecks with **zero** changes outside four files —
  the whole cost is one `protected setStatusRaw` and one cast (§3.7).
- It does **not** disturb the generated verb overloads: no argument position
  changes, and `MountedHandler` reads the responses out of the `TShape` it
  already receives, so `generate-verb-overloads.ts` emits identical text.

### What this does *not* solve

Response bodies are still invisible to *inference* — nothing derives a schema
from `res.json(x)`. Responses are declared, by hand, once. What changed is
that the declaration is now enforced at compile time and optionally at
runtime, instead of being documentation that silently rots.

Enforcement is **partial, with a known boundary**: `res.status(c).json(b)` is
caught, `res.send()` and `res.jsonp()` are not, and passing `res` to a helper
typed as a plain `BunResponse` escapes it entirely. §3.7 has the measured
table. Partial with stated limits is the claim; parity with a framework that
owns its response type is not.

---

## 2. What metadata exists today vs what must be added

### 2.1 `bun-common` — `BunRouter` (`packages/bun-common/lib/BunRouter.ts`)

`routes()` returns `@routejs/router` `Route` objects
(`node_modules/@routejs/router/src/route.mjs`) tagged by `setRoute`
(`BunRouter.ts:678-751`). **Measured** on a router with a mount, a wildcard and
a regex-constrained param:

```
0 {"params":[],"isEndpoint":false,"routerGroupId":0,"cbs":1}                                  // use(mw)
1 {"method":"GET","path":"/users","isEndpoint":true,"cbs":2}                                  // validate + handler
2 {"method":"GET","path":"/files/*","params":[0],"wildcardNames":["name"],"isEndpoint":true}
3 {"method":"GET","path":"/re/:id(\\d+)","params":["id"],"isEndpoint":true}
4 {"method":"GET","path":"/users/:id/posts/:postId","group":"/users/:id","routerGroupId":1}
5 {"method":"POST","path":"/users/:id/posts","group":"/users/:id","routerGroupId":1,"cbs":2}
```

| Metadata | Exists? | Where |
|---|---|---|
| HTTP method | **yes** | `Route.method` (`string \| string[] \| null`) |
| Path literal | **yes**, verbatim | `Route.path` — including `(\d+)` constraints |
| Mount prefix | **yes** | `Route.group`; `Route.path` is already the **joined absolute path** |
| Param names | **yes** | `Route.params` — `"id"` for `:id`, **`0` for `*` and bare `(regex)`** |
| Express-5 wildcard names | **yes** | `RouteWithGroup.wildcardNames` (`BunRouter.ts:283`) — `*name` is normalised to `*` and the name kept here |
| Handler vs middleware | **yes** | `RouteWithGroup.isEndpoint` (`BunRouter.ts:277`), the sole source of truth (`getMatchedLayers` comment, `BunRouter.ts:4455-4462`) |
| Which mount a route came from | **yes** | `RouteWithGroup.routerGroupId` |
| A concrete example path | **yes** | `Route.compilePathRegexpToPath(params)` — **undeclared in `@routejs/router`'s `index.d.ts`**, a cast is required. **Measured**: `/files/*`+`{0:"x/y"}` → `/files/x/y`, `/re/:id(\d+)`+`{id:"1"}` → `/re/1`, all self-matching |
| Route name | **yes** | `Route.name`, set by `setName()`. Preserved across mount flattening (**measured**) — but names are unique-checked, so double-mounting a *named* route throws. Not usable as a doc key |
| **Summary / description / tags / operationId / deprecation** | **no** | must be added |
| **Response schemas and statuses** | **no** | must be added |
| **Request schemas** | **at runtime, no** | present as types only (`ValidatorMiddleware.__shape`); must be added |
| **Security applied by middleware** | **no** | undiscoverable — see §10 |
| Per-route metadata slot | **no** | must be added |

### 2.2 `bun-common` — `BunValidate` (`packages/bun-common/lib/BunValidate.ts`)

| Metadata | Exists? | Where |
|---|---|---|
| The four targets (`params`/`query`/`body`/`headers`) | **yes** | `ValidationSchemas` |
| The schema objects, on the instance | **yes** | `BunValidate.schemas` getter |
| The schema objects, on the **middleware** | **no** | `middleware()` returns a bare closure; `__shape` is a phantom |
| `replace: false` (validated values not written back) | **yes**, on the instance | matters: a `replace: false` validator documents the *request*, not the handler's view |
| `hooks.normalize` / `hooks.transform` | **yes**, on the instance | opaque functions — a `transform`'s output type is invisible at runtime (see §10) |

### 2.3 `bun-common` — `BunWebSocket` (`packages/bun-common/lib/BunWebSocket.ts`)

| Metadata | Exists? | Where |
|---|---|---|
| Registered route paths | **yes, but private** | `#_routeHandlers: Map<path, handlers[]>` (`BunWebSocket.ts:458`) — **no public accessor**; must be added |
| Path params of a WS route | **yes**, at match time | `ws.data.route` / `ws.data.params` (`WebSocketClientData`, `BunWebSocket.ts:67`) |
| Bound port | **yes** | `get port()` (`:853`), `getServer()` (`:861`) |
| Transport settings | **yes** | `idleTimeout`, `maxPayloadLength`, `perMessageDeflate` (`:480-482`) |
| Lifecycle events | fixed, not user-declared | `open`/`message`/`close`/`ping`/`pong`/`drain` |
| **Named events / message types** | **no** | `message` is `(ws, message: string \| Buffer)`. Nothing above bytes |
| **Topics / rooms / publish / subscribe** | **no** | a grep for `publish\|subscribe\|topic\|room` in `BunWebSocket.ts` returns **zero hits**. Bun's native `ServerWebSocket.publish/subscribe` leak through `WebSocketClient`, but this class neither declares, tracks nor documents them |
| Direction (send vs receive) | **no** | — |
| Subprotocol | only if an `onUpgrade` hook sets the header | — |

### 2.4 `bun-nest`

| Metadata | Exists? | Where |
|---|---|---|
| Controller routes in the router table | **yes** | `registerVerb` (`BunHttpAdapter.ts:1432`) delegates to `this.instance[verb](path, ...callbacks)`, so Nest routes land in the same `BunRouter.routes()` table. **Assumed** end-to-end (not executed): whether the path already carries `setGlobalPrefix` |
| `@Get`/`@Body`/`@Param`/`@Query` + DTO classes | **yes**, in Nest's own `Reflect` metadata | not reachable from the router callback (Nest wraps handlers in a `RouterProxy` closure) |
| Nest middleware | **yes** | `createMiddlewareFactory` (`:3138`) uses `useMethod`, so `isEndpoint` stays false and it is never mistaken for a handler |
| `@SubscribeMessage` event names | **yes**, in `@nestjs/websockets` metadata | `MESSAGE_METADATA = 'message'` on the method descriptor; read by `gateway-metadata-explorer.js`, **never by bun-nest** (a grep for `Reflect.getMetadata` in `packages/bun-nest/lib/` returns zero hits) |
| WS channel path | **yes**, derived | `resolveRoute` (`BunWebSocketAdapter.ts:557`) concatenates `GATEWAY_OPTIONS.path` + `.namespace` into a URL path |
| WS wire format | **yes**, fixed | socket.io-shaped `MessageEventTypes` enum (`BunWebSocketAdapter.ts:134`), frames `{type, namespace, id?, data:[event, ...args]}` |
| Ack contract per handler | **yes** | `isAckHandledManually` from `hasAckDecorator` (`gateway-metadata-explorer.js:36`) |
| **Outbound event names** | **no** | runtime strings passed to `client.emit()` or returned as `WsResponse.event` |
| **Payload schemas** | only what a DTO class carries | needs `@nestjs/swagger`'s `@ApiProperty` or a Standard Schema pipe |

### 2.5 Gap summary

| Package | Biggest gap | Cost to close |
|---|---|---|
| bun-common HTTP | no per-route doc slot; validator schemas invisible at runtime | small: a `WeakMap` + `.describe()` + a non-enumerable property (~250 lines) |
| bun-common **responses** | nothing declares a status or a body shape, anywhere | medium, and **spiked**: `responses` on the validator, `TResponses` on `BunResponse`, `TRes` threaded through `TypedRouteHandler`. Four files, one `protected setStatusRaw`, one cast — §3.7 |
| bun-common **class DTOs** | `toStandardSchema` exists but nothing accepts a class | small: one wrapper plus an injected adapter — §3.6. Blocked for consumers on stage-3 decorators (risk 1e) |
| bun-common WS | no public route list; no message concept at all | small for channels (one accessor), **large** for messages — needs a new declaration API |
| bun-nest HTTP | nothing; `@nestjs/swagger` already covers it | see §8.6 — verify + document + example |
| bun-nest **validation** | `lib/decorators.ts` is one re-export line; no decorator infrastructure at all | medium: an interceptor on `interceptors.ts`'s pattern, plus the swagger bridge — §3.8. Gated on (d) |
| bun-nest WS | metadata exists but nothing reads it | medium: a metadata explorer + an AsyncAPI mapper |

---

## 3. Public API design

New module: `packages/bun-common/lib/docs/`. Nothing in `lib/index.ts` changes
behaviour; the whole feature is inert until `.describe()` or `generateOpenApi()`
is called.

### 3.1 Zero cost when unused

Three mechanisms, all measured-cheap:

1. `.describe()` writes to a module-level `WeakMap`. Never called → an empty
   `WeakMap` allocated once at module load. No per-route allocation, no branch
   in `handle()`, no change to the matched-pipeline cache.
2. The validator's `__schemas` property is a single non-enumerable
   `Object.defineProperty` in `middleware()`. It adds one property write per
   *validator constructed* (not per request) and is invisible to
   `Object.keys`, `JSON.stringify` and spread.
3. `generateOpenApi()` lives in `lib/docs/`, reachable only through
   `@kingsleyweb/bun-common/lib/docs`. `lib/index.ts` re-exports **types only**
   (`export type { RouteDoc, OpenApiOptions }`), so a consumer who never
   imports the subpath never loads the generator, the converters or the
   `$ref` walker.

### 3.2 Declaring documentation

```ts
/** What a route contributes to the generated document. Every field optional. */
export interface RouteDoc {
  /**
   * One-line summary, rendered as the operation's title.
   * Default: none — the operation gets no `summary`.
   */
  summary?: string;
  /**
   * Longer CommonMark description. Default: none.
   */
  description?: string;
  /**
   * Tags the operation is grouped under. Default: `[]`, which means the
   * operation is untagged and viewers list it under "default".
   */
  tags?: readonly string[];
  /**
   * The operation id. Must be unique across the document.
   * Default: derived from method + path (see {@link OpenApiOptions.operationId}).
   */
  operationId?: string;
  /**
   * Marks the operation deprecated. Default: `false`.
   */
  deprecated?: boolean;
  /**
   * Leaves this route out of every generated document, including the
   * `paths` entry. Default: `false`. Use for health checks, the docs routes
   * themselves, and anything whose path OpenAPI cannot express.
   */
  hidden?: boolean;
  /**
   * Request schemas, when the route has no `validate()` middleware or when
   * the validator's schemas describe less than the route accepts. A target
   * given here **replaces** whatever was discovered for that target.
   * Default: discovered from the pipeline's validators.
   */
  request?: {
    /** Path parameters. Keys must be names the path declares. */
    params?: StandardSchemaV1 | JsonSchemaLike;
    /** Query string. */
    query?: StandardSchemaV1 | JsonSchemaLike;
    /** Request body, for the media types in {@link RouteDoc.requestMediaTypes}. */
    body?: StandardSchemaV1 | JsonSchemaLike;
    /** Request headers. Emitted as `in: "header"` parameters. */
    headers?: StandardSchemaV1 | JsonSchemaLike;
  };
  /**
   * Media types the body is accepted as. Default: `["application/json"]`
   * when a body schema exists, otherwise no `requestBody` is emitted.
   */
  requestMediaTypes?: readonly string[];
  /**
   * Whether a body must be sent. Default: `true` when a body schema exists.
   */
  requestRequired?: boolean;
  /**
   * Declared responses by status, **for documentation only**. `null` means
   * "no body" (204). A bare schema is shorthand for
   * `{ schema, description: <reason phrase> }`.
   *
   * This never reaches the type system and is never checked at runtime — it
   * cannot be, because `.describe()` runs after the handler was already
   * type-checked (§3.4, spiked). To *enforce* responses, declare them on the
   * validator instead: `validate(schemas, { responses })` (§3.5). Use this
   * form for a route with no validator, or for a status the handler never
   * produces itself (a 401 added by middleware).
   *
   * Default: `{}` — the generator then emits a single
   * `default: { description: "Unspecified" }`, which is valid but useless,
   * and `strict` mode (see {@link OpenApiOptions.strict}) rejects it.
   */
  responses?: Readonly<Record<number | "default", RouteResponseDoc | null>>;
  /**
   * Security requirements for this operation, overriding the document-wide
   * one. `[]` means "explicitly public". Default: inherit the document's.
   */
  security?: readonly Record<string, readonly string[]>[];
  /**
   * Vendor extensions merged into the operation object verbatim. Keys must
   * start with `x-`. Default: none.
   */
  extensions?: Readonly<Record<`x-${string}`, unknown>>;
}

/** One declared response. */
export interface RouteResponseDoc {
  /** Required by OpenAPI. Default: the status's reason phrase. */
  description?: string;
  /** The body schema, any Standard Schema or a raw JSON Schema. */
  schema?: StandardSchemaV1 | JsonSchemaLike;
  /** Media type. Default: `"application/json"`. */
  mediaType?: string;
  /** Response headers, by name. Default: none. */
  headers?: Readonly<Record<string, { description?: string; schema?: JsonSchemaLike }>>;
  /** Examples, by name, merged into the media-type object. Default: none. */
  examples?: Readonly<Record<string, { summary?: string; value: unknown }>>;
}
```

`BunRouter` gains exactly one method — the shape of `setName`:

```ts
/**
 * Documents the route registered by the immediately preceding verb call.
 *
 * Mirrors {@link setName}: it reads the same `#lastRoute`, so it must follow
 * a verb/`all` registration directly. Documentation is stored against the
 * route's **terminal callback**, which survives `use(subRouter)` flattening,
 * so a sub-router's routes keep their docs when mounted.
 *
 * Calling it twice for one route merges, last write winning per key.
 *
 * @throws TypeError when the previous registration was not a route handler
 *   (`use`, `group`, `domain`, a mount) — middleware cannot be documented.
 */
describe(doc: RouteDoc): this;
```

**Usage — before:**

```ts
const router = new BunRouter();
router.get("/users/:id", validate({ params: IdParams }), (req, res) =>
  res.json(getUser(req.params.id)),
);
```

**after** (the validator is unchanged and still does the validating):

```ts
router
  .get("/users/:id", validate({ params: IdParams }), (req, res) =>
    res.json(getUser(req.params.id)),
  )
  .describe({
    summary: "Read one user",
    tags: ["Users"],
    responses: { 200: { schema: UserSchema }, 404: { schema: ProblemSchema } },
  });
```

`IdParams` is not restated: it is discovered from the validator.

**A route with no validator** — declare the request inline:

```ts
router.get("/search", handler).describe({
  summary: "Search",
  request: { query: SearchQuery },          // documents only; nothing validates it
  responses: { 200: { schema: ResultsSchema } },
});
```

The asymmetry is deliberate and must be stated in the README: a `request`
schema given in `.describe()` **documents without enforcing**. bun-jobs has
the same idea under a different name (`s.documented`, `schema/builder.ts`) and
the same justification.

**Excluding a route:**

```ts
router.get("/healthz", handler).describe({ hidden: true });
```

or globally, `OpenApiOptions.filter`.

### 3.3 Document-level options

```ts
/** Options for {@link generateOpenApi}. */
export interface OpenApiOptions {
  /** `info.title`. Required — OpenAPI has no sensible default. */
  title: string;
  /** `info.version`. Required. */
  version: string;
  /** `info.description`, CommonMark. Default: none. */
  description?: string;
  /** The rest of `info` (`contact`, `license`, `termsOfService`, `summary`). */
  info?: Omit<OpenApiInfo, "title" | "version" | "description">;
  /**
   * `servers`. Default: `[{ url: "/" }]`, so paths are relative to wherever
   * the document is served from.
   */
  servers?: readonly { url: string; description?: string; variables?: unknown }[];
  /** `components.securitySchemes`. Default: none declared. */
  securitySchemes?: Readonly<Record<string, OpenApiSecurityScheme>>;
  /**
   * The document-wide `security` requirement. Default: with schemes declared,
   * "any one of them"; with none, absent.
   */
  security?: readonly Record<string, readonly string[]>[];
  /**
   * Tag descriptions, by tag name. A tag a route uses but this does not name
   * still appears, without a description. Default: `{}`.
   */
  tags?: Readonly<Record<string, { description?: string; externalDocs?: unknown }>>;
  /**
   * Decides which routes are documented, on top of `hidden`. Return `false`
   * to drop one. Default: every non-hidden endpoint route.
   */
  filter?: (route: DiscoveredRoute) => boolean;
  /**
   * Names an operation that declared no `operationId`. Default:
   * `camelCase(method + path)` with params as `By<Name>` —
   * `GET /users/:id/posts` → `getUsersByIdPosts`. Collisions are a
   * `ConfigError`, never a silent rename.
   */
  operationId?: (route: DiscoveredRoute) => string;
  /**
   * How hard to be about incomplete documentation.
   * - `"lenient"` (default) — emit what is known, collect the rest in
   *   {@link OpenApiResult.warnings}.
   * - `"strict"` — throw `ConfigError` on an undocumentable path, a route
   *   with no declared responses, or a schema no converter handled.
   */
  strict?: "lenient" | "strict";
  /**
   * Standard Schema → JSON Schema converters, tried before the built-in
   * registry and keyed by `~standard.vendor`. Default: `{}`.
   */
  converters?: Readonly<Record<string, JsonSchemaConverter>>;
  /**
   * Names a schema so it is emitted once under `components.schemas` and
   * referenced with `$ref` everywhere. Return `undefined` to inline.
   * Default: a schema's own `$id`/`title`, else inline (see §4.4).
   */
  componentName?: (schema: StandardSchemaV1 | JsonSchemaLike) => string | undefined;
}

/** A route as the generator sees it, before it becomes an operation. */
export interface DiscoveredRoute {
  /** The HTTP method, upper-case. `"ALL"` for an `all()` route. */
  method: string;
  /** The Express-syntax path, absolute (mounts already joined). */
  path: string;
  /** The OpenAPI path template, e.g. `/users/{id}`. `undefined` when the path cannot be expressed. */
  template?: string;
  /** Path parameter names, in order. */
  params: readonly string[];
  /** Why `template` is `undefined`, when it is. */
  undocumentable?: string;
  /** The documentation attached with `.describe()`, if any. */
  doc: RouteDoc;
  /** Request schemas discovered from validators in this route's pipeline. */
  discovered: Partial<Record<ValidationTarget, StandardSchemaV1>>;
  /** The `Route` this came from, for a caller that needs more. */
  route: Route;
}

/** What {@link generateOpenApi} returns. */
export interface OpenApiResult {
  /** The document. Fresh objects; the caller owns it. */
  document: OpenApiDocument;
  /** Everything `lenient` mode swallowed: undocumentable paths, missing responses, unconverted schemas. */
  warnings: readonly DocWarning[];
}

/**
 * Builds the OpenAPI 3.1 document for a router's routes.
 *
 * Reads `router.routes()`, replays `router.getMatchedLayers()` on a path
 * synthesised from each route, and merges what it finds with `.describe()`.
 */
export function generateOpenApi(
  router: BunRouter,
  options: OpenApiOptions,
): OpenApiResult;
```

### 3.4 Does `.describe()` violate the typed-overload constraints?

**No, and this is the reason for its shape.** CLAUDE.md's three constraints
are about the *argument positions* of a verb call:

| Constraint | Affected by `.describe()`? |
|---|---|
| Generated per verb, inside the class, ahead of the existing overloads | No — `.describe()` is a separate method with one overload, like `setName`. The generated block is untouched, and `generate-verb-overloads.ts --check` stays green |
| Exactly one position carries a shape — the validator immediately before the handler | No — no position changes. The validator remains the one shape carrier |
| Preceding positions typed `RouterHandler`, not a union | No — nothing is added to any position |

The alternative designs all *do* violate them, and are rejected:

- **A trailing options object** (`router.get(path, handler, { summary })`) —
  adds a position whose type is not `RouterHandler`. Per CLAUDE.md's measured
  note, as soon as a shape position receives a non-validator the overload is
  discarded and the call falls through to `(path, ...callbacks)`, degrading the
  handler to `any`. Fatal.
- **A leading options object** (`router.get({ path, summary }, handler)`) —
  `TPath` no longer infers from a string literal, so `req.params` collapses.
  Fatal.
- **A `defineRoute`-style registrar** (bun-jobs' approach) — perfectly sound
  and *additive*: a `routes(defs)` helper that builds the pipeline and calls
  `.describe()` itself. Worth shipping as an ergonomic layer in phase (a2),
  but it cannot be the only mechanism, because it does not document the
  routers people have already written.

`.describe()` returns `this`, so it chains, and it throws for middleware for
the same reason `setName` does.

**One rule about `responses`, since it can now be declared in two places.**
`RouteDoc.responses` (§3.2) is *documentation only* — it never reaches the
type system, for the reason Decision 4 spiked. `validate(schemas, { responses })`
(§3.5) is the *enforced* declaration. When a route has both, the generator
takes the validator's as the source of truth, merges `.describe()`'s
`description`/`headers`/`examples` onto it, and emits a warning if the two
declare different statuses. A route should normally use one or the other:

| Situation | Use |
|---|---|
| Route has a validator, or you want any checking at all | `validate(..., { responses })` |
| Route has no validator and you only want the document right | `.describe({ responses })` |
| Documented status the handler never produces (e.g. a 401 added by middleware) | `.describe({ responses })` — the validator's map types `res`, so putting an unreachable status there would let a handler send it |

That last row is the reason `.describe({ responses })` is not deleted.

### 3.5 Runtime response validation

Prior art, reused rather than reinvented: bun-jobs' `responseMismatch`
(`packages/bun-jobs/lib/api/routes/define.ts`) validates a handler's result
against the declared schema for its status, and on a mismatch **logs** —
`logger.error("jobs api response did not match its schema", { operationId,
status, mismatch })` — rather than failing the request. That is the right
default and the right semantics, and the message shape should match.

```ts
/** Options for {@link BunValidateOptions.responses} checking. */
export type ResponseValidationMode =
  /** Never check. The default. */
  | "off"
  /** Check and log at `error` level; the response is sent unchanged. */
  | "log"
  /** Check and throw, entering the error pipeline. For tests and CI. */
  | "throw";

/** Response schemas by status. `null` declares a status that carries no body. */
export type ResponseSchemas = Readonly<Record<number, StandardSchemaV1 | null>>;

interface BunValidateOptions</* … existing params … */> {
  /**
   * Response schemas by status — what the route is allowed to answer with.
   *
   * They type the following handler's `res` (see §3.7) and, when
   * {@link validateResponses} is on, are checked at runtime. A status of
   * `null` declares a body-less response (204, 304).
   *
   * Declaring these does not make the route send them; it constrains what it
   * *may* send. A declared status the handler never produces is not an error
   * — exhaustiveness is not checkable (measured).
   */
  responses?: ResponseSchemas;
  /**
   * Whether to check a response against {@link responses} at runtime.
   * Defaults to `"off"`. A sensible production setting is
   * `process.env.NODE_ENV === "production" ? "off" : "log"`.
   */
  validateResponses?: ResponseValidationMode;
  /**
   * What to do when the status sent is not among {@link responses} at all.
   * Defaults to `"report"`, which treats it as a mismatch (`status <n> is not
   * declared`, bun-jobs' wording). `"allow"` passes it through unchecked —
   * for a route whose error statuses come from middleware it does not own.
   */
  undeclaredStatus?: "report" | "allow";
}
```

**Where it hooks.** Not in `json()` — that would miss `send()` and fire before
the status is final. The check belongs at **response finalisation**, the one
place every path converges, and it reads `BunResponse`'s existing
`#sentBody`/`getSentBody` rather than intercepting a setter. Coverage by path:

| Path | Checked? | Why |
|---|---|---|
| `json()` / `jsonp()` | **yes** | `#sentBody` holds the pre-serialisation value — the object, not the string |
| `send(object)` | **yes** | same slot |
| `send(string)` where the schema is a string schema | **yes** | the schema is run against the string |
| `send(string)` where the schema is an object schema | **reported as a mismatch** | correct: the route declared JSON and sent text |
| `end()` with no body | checked against `null`/absent | a body-less status declared `null` passes; one declaring a schema mismatches |
| 204 / 304 | **yes**, expects no body | falls out of the above |
| `redirect()` | **skipped** | the status is a redirect and the body is generated; never a declared response |
| `sendFile()` / a stream / `StreamableFile` | **skipped**, with one warning per route on the first occurrence | the body is never materialised; validating it would mean buffering it, which is the one thing a stream exists to avoid |
| `res.headersSent` already true | skipped | nothing to check |

**Cost.** Zero when `"off"` — one property read on a branch that is already
taken at finalisation. When on, it is one Standard Schema `validate()` per
response, i.e. the same order as validating a request body, plus a `WeakMap`
lookup for the route's map. That is why the default is off and the
recommendation is dev-only; it is not free and the plan should not pretend it
is.

**On a mismatch**, `"log"` emits through the router's resolved `Logger` at
`error` with `{ path, method, status, mismatch }`, where `mismatch` is
bun-jobs' flattened `"<path>: <message>; …"` string. It never alters the
response — a response already being written cannot be retracted, and turning a
working 200 into a 500 because a schema is stale is a worse failure than the
drift it is reporting.

---

### 3.6 Class DTOs (class-validator / class-transformer)

`toStandardSchema` (`BunValidate.ts:345`) already exists for exactly this. A
DTO class becomes a Standard Schema in one wrapper, so **every target that
accepts a schema accepts a class constructor**, with no change to
`ValidationSchemas`' four keys beyond widening their type.

```ts
/** A DTO class: a constructor `plainToInstance` can build. */
export type DtoClass<T = object> = new (...args: never[]) => T;

/**
 * The class-validator / class-transformer surface, injected rather than
 * imported — the structural rule the logging adapters and the §4 converters
 * follow. Neither library, nor `reflect-metadata`, becomes a bun-common
 * dependency or appears in a shipped declaration.
 */
export interface ClassValidatorAdapter {
  /** `class-transformer`'s `plainToInstance`. */
  plainToInstance: (cls: DtoClass, plain: unknown, options?: object) => object;
  /** `class-validator`'s `validate`. Async; issues are mapped to Standard Schema issues. */
  validate: (instance: object, options?: object) => Promise<readonly ClassValidationError[]>;
  /**
   * `class-validator`'s `getMetadataStorage`, when the OpenAPI bridge is
   * wanted. Optional: without it a DTO validates but documents as `{}`.
   */
  getMetadataStorage?: () => unknown;
}

/** Options for {@link useClassDtos}. */
export interface ClassDtoOptions {
  /**
   * Passed to `plainToInstance`. Defaults to
   * `{ enableImplicitConversion: true }`, which is what makes a DTO usable on
   * `query` and `params`, where every value arrives as a string
   * (**measured**: `"42"` → `42` for an `@IsInt()` property).
   */
  transform?: Record<string, unknown>;
  /**
   * Passed to class-validator's `validate`. Defaults to
   * `{ whitelist: true, forbidNonWhitelisted: false }`.
   *
   * Note `whitelist` governs *errors*, not the instance:
   * `plainToInstance` keeps undeclared properties regardless (**measured** —
   * an `extra` key survived `whitelist: true`). To strip them, use
   * `transform: { excludeExtraneousValues: true }` with `@Expose()`.
   */
  validate?: Record<string, unknown>;
  /**
   * Converts a DTO class to JSON Schema for the generated document — e.g.
   * `class-validator-jsonschema`'s `targetConstructorToSchema`. Without it a
   * DTO validates correctly and documents as `{}` plus a warning.
   */
  toJsonSchema?: (cls: DtoClass) => JsonSchemaLike;
}

/**
 * Teaches bun-common to accept DTO classes wherever a schema is accepted.
 * Call once at startup.
 *
 * @example
 * ```ts
 * import { plainToInstance } from "class-transformer";
 * import { getMetadataStorage, validate } from "class-validator";
 * import { targetConstructorToSchema } from "class-validator-jsonschema";
 *
 * useClassDtos(
 *   { plainToInstance, validate, getMetadataStorage },
 *   { toJsonSchema: (cls) => targetConstructorToSchema(cls) },
 * );
 * ```
 */
export function useClassDtos(
  adapter: ClassValidatorAdapter,
  options?: ClassDtoOptions,
): void;

/**
 * Wraps one DTO class as a Standard Schema, for a caller who wants it
 * explicitly rather than through the global registration. The result's
 * `~standard.vendor` is `"class-validator"`.
 */
export function fromDto<T>(cls: DtoClass<T>, options?: ClassDtoOptions): StandardSchemaV1<unknown, T>;
```

`ValidationSchemas`' four keys widen from `StandardSchemaV1` to
`StandardSchemaV1 | DtoClass`, and so do `RouteDoc.request.*` and
`RouteResponseDoc.schema`. Discrimination is trivial and unambiguous: a
Standard Schema has `~standard`, a DTO is a function.

**Feasibility — two risks, both spiked, and the answers are not the ones
feared.**

**Bun *does* honour `emitDecoratorMetadata`.** This was the risk flagged as
potentially fatal. It is not. **Measured** under Bun 1.4.3-canary with
`experimentalDecorators` + `emitDecoratorMetadata`:

```
name  -> String    age    -> Number   flag   -> Boolean
when  -> Date      nested -> Inner     list  -> Array     maybe -> String
metadata keys on prototype.name: ["design:type"]
```

and the full stack works end to end — `class-validator@0.15.1` +
`class-transformer@0.5.1`, `plainToInstance` coercing `"42"` → `42`,
instantiating a nested `@Type(() => Address)` as a real `Address`, and
`validate()` returning per-property constraints (`name:isString`, `age:min`,
`tags:isString`). `getMetadataStorage().getTargetValidationMetadatas(...)`
returned 6 readable entries — the JSON Schema source.

The two standing `design:type` limits are class-validator's own, not Bun's:
`string[]` erases to `Array` (hence `@IsString({ each: true })`) and `maybe?:
string` erases to `String` (hence `@IsOptional()`). Neither is new.

**Stage-3 decorators are a hard break, not a degradation.** **Measured**: with
`experimentalDecorators` *off* (TypeScript 5+ standard decorators), importing
the same DTO throws at class-definition time —

```
TypeError: undefined is not an object (evaluating 'object.constructor')
  at class-validator/cjs/decorator/common/ValidateBy.js:16
```

because a stage-3 field decorator is called `(value, context)`, so
class-validator's `object` is `undefined`. The repo sets
`experimentalDecorators: true` globally (`tsconfig.base.json:24-26`) so
bun-common and bun-nest are fine; a **consumer** on standard decorators cannot
use class DTOs at all and must set `experimentalDecorators: true` (and keep
`reflect-metadata` imported first). This must be stated in the README as a
requirement of the DTO path, not a footnote — and it is an argument for
keeping the Standard Schema path primary.

### 3.7 Compile-time enforcement — spiked, and partial

**Mechanism chosen: thread a narrowed `res` into the handler**, not type the
handler's return. The return route was spiked and fails for the documented
reason: `TypedRouteHandler`'s `R = unknown` carries an explicit comment in
`types/general.ts` (*"a handler may return `res.send(...)`, a promise, or
nothing"*), and **measured**, a handler written `(req, res) => res.json(x)`
returns `BunResponse`, which is not the body type — so return-typing rejects
the repo's own dominant style.

**What it takes.** Four files, spiked as a full copy of `packages/bun-common`:

| File | Change |
|---|---|
| `lib/types/general.ts` | `TypedRouteHandler` gains `TRes = BunResponse` **as its last parameter**, so existing `TypedRouteHandler<P, Q, B, R>` uses keep compiling |
| `lib/types/routeTyping.ts` | `ValidationShape` gains `responses?: Record<number, unknown>`; new `ResolveResponses<S>`; `MountedHandler` passes `BunResponse<unknown, ResolveResponses<MergeShape<TMountShape, TShape>>>` |
| `lib/BunResponse.ts` | a second defaulted parameter `TResponses = undefined`; `status()` narrows; `json()` constrains; **one `protected setStatusRaw(code: number)`** for the class's own ~8 internal `this.status(n)` calls, which cannot satisfy `AllowedStatus<TResponses>` while `TResponses` is unresolved; one `as BunResponseSentBody` cast |
| `lib/BunValidate.ts` | `responses` option; `ValidatedShapeFor` gains a `TRes` parameter; `validate()` infers it with `const` |

```ts
/** A declared response map: status code to that status's body type. */
export type ResponseMap = Record<number, unknown>;
/** Statuses `status()` accepts: any number until responses are declared. */
export type AllowedStatus<M> = M extends ResponseMap ? keyof M & number : number;
/** The map left after `status(C)` narrowed it. */
export type NarrowResponses<M, C extends number> = M extends ResponseMap ? Pick<M, C & keyof M> : undefined;
/** What `json()` accepts: the declared bodies, or anything JSON until declared. */
export type JsonBodyFor<M> = M extends ResponseMap ? M[keyof M] : BunResponseBody;

public status<const C extends AllowedStatus<TResponses>>(
  code: C,
): BunResponse<customWebsocketDataType, NarrowResponses<TResponses, C>>;
public json<T extends JsonBodyFor<TResponses>>(body: T): BunResponse;
```

**Result: the patched library typechecks clean** (`tsc -p` exit 0) with no
other change anywhere in bun-common. The ~18 files naming `BunResponse` are
unaffected because both new parameters default.

**Verb overloads are untouched.** `MountedHandler` derives the response map
from the `TShape` it is already handed, so `generate-verb-overloads.ts` emits
byte-identical text and `--check` stays green. No argument position changes,
so all three CLAUDE.md constraints hold — verified by the spike compiling
against the real class, including inline arrow handlers.

**What is caught** (every case below compiled or failed as stated):

```ts
const v = validate({ params: IdParams }, { responses: { 200: UserS, 404: ProblemS } });

r.get("/u/:id",   v, (req, res) => res.status(200).json({ id: req.params.id, name: "a" })); // OK
r.get("/bad1/:id", v, (req, res) => res.status(200).json({ code: "NOPE" }));
//   TS2353: Object literal may only specify known properties, and 'code' does not exist in type 'User'.
r.get("/bad2/:id", v, (req, res) => res.status(418).json({ id: "x", name: "y" }));
//   TS2345: Argument of type '418' is not assignable to parameter of type '404 | 200'.
r.get("/bad3/:id", v, (req, res) => res.json({ nope: true }));
//   TS2353: ... 'nope' does not exist in type 'User | Problem'.
```

Those are the **actual** messages, and they are the reason this is worth
shipping: a plain `TS2353`/`TS2345` naming the offending property, not a wall
of overload-resolution noise. A mounted sub-router declaring
`BunRouter<"/users/:uid", { responses: { 200: User } }>` produces the same
clean message, and `async` handlers behave identically. Request narrowing is
unaffected — `req.params.id` stays `string`.

**What is not caught — the boundary, measured:**

| Case | Caught? | Note |
|---|---|---|
| `res.status(c).json(b)`, wrong body | **yes** | |
| Undeclared status | **yes** | |
| `res.status(200); res.json(b)` as separate statements | **yes**, but only against the *union* of all declared bodies | the narrowing returned by `status()` is discarded; `res` still carries the full map |
| `async` handler, awaited | **yes** | |
| `res.send(anything)` | **no** | `send` takes the wide body union; constraining it would reject every legitimate string/Buffer/stream response |
| `res.jsonp(anything)` | **no** | same; could be fixed with `json`'s treatment if wanted |
| `helper(res)` where `helper(res: BunResponse)` | **no** | `TResponses` appears only in method parameter positions, so a narrowed `res` is assignable to a bare one. **The escape hatch**, and structural — not closable without variance annotations that would break far more |
| Returning a bare object, Nest-style | **no** | the router ignores handler return values by design |
| A declared status never sent | **no** | exhaustiveness is not checkable |

Nothing here is a surprise in retrospect, but all of it is measured rather
than reasoned, and the README must state the `send()` and helper-function
limits plainly.

**Negative controls** (the repo convention) are in the spike and must ship
with the feature: a validator with no `responses` leaves `res` completely
unconstrained (`res.status(599).json({ anything: 1 })` compiles), as does a
route with no validator — so the feature is opt-in and the "zero cost when
unused" claim of §3.1 survives at the type level too.

### 3.8 `@Validate` — BunValidate as a NestJS route decorator

Nest registers routes through its own explorer, so there is no
`router.get(path, validate(...), handler)` chain for a validator to sit in.
The equivalent must be a Nest construct.

**Where it runs: an interceptor, following `interceptors.ts`.**
`packages/bun-nest/lib/decorators.ts` is one line
(`export { UploadedFile, UploadedFiles } from "@nestjs/common"`), so there is
no decorator infrastructure to extend; `packages/bun-nest/lib/interceptors.ts`
(351 lines) is the precedent — mixin classes from a factory, with
`getMultipartRequest(ctx)` reaching the underlying bun-common request and
`transformUploadException` mapping failures to Nest exceptions. Reuse both.

Why an interceptor rather than a pipe or a guard:

| Candidate | Verdict |
|---|---|
| **Interceptor** | **Chosen.** Runs before the handler *and* wraps its result, so one construct does request validation **and** response validation (§3.5). It can reach the real `BunRequest` via the same `ctx.switchToHttp().getRequest()` route `getMultipartRequest` already uses, and mutate `req.query`/`req.body` in place — which is the whole point of `BunValidate`, and what makes `@Query()`/`@Body()` see the **parsed output**. Chaining semantics are preserved for free: each validator replaces the target wholesale, exactly as in the router |
| Pipe | Per-parameter and cannot see the response. A pipe also cannot replace `req.query` in place — it transforms the value Nest hands the parameter, so a second reader of `req.query` still sees the raw one. Wrong semantics |
| Guard | Runs too early (before pipes) and may only return a boolean; a validation failure would surface as 403 |
| bun-common middleware via `adapter.use()` | Runs **below** Nest's pipeline — `BunHttpAdapter.use`'s own JSDoc says so: *"guards, interceptors and `setGlobalPrefix` do not apply"*. Usable, but invisible to Nest's exception filters and to `@nestjs/swagger` |

With a Nest `ValidationPipe` also present: the interceptor runs **first**
(interceptors precede pipes on the request path), so the pipe receives the
already-parsed value. For a class DTO that is harmless and idempotent; for a
zod-parsed `query` whose output is no longer a string map, a `ValidationPipe`
with `transform: true` may re-coerce. Recommendation: document that the two
should not both own a target, and have `@Validate` set
`req[BUN_VALIDATED]` so a future `BunValidationPipe` could no-op. Not worth
building the pipe now.

```ts
/** What `@Validate` accepts — `validate()`'s surface, in decorator form. */
export interface ValidateOptions<
  S extends ValidationSchemas = ValidationSchemas,
  TRes extends ResponseSchemas | undefined = undefined,
> {
  /** Validates path parameters. A Standard Schema or a DTO class. */
  params?: S["params"];
  /** Validates the query string. */
  query?: S["query"];
  /** Validates the request body. */
  body?: S["body"];
  /** Validates the request headers. */
  headers?: S["headers"];
  /** Response schemas by status; see §3.5. Also constrains the method's return type. */
  responses?: TRes;
  /** Runtime response checking. Defaults to `"off"`. */
  validateResponses?: ResponseValidationMode;
  /** Per-target `normalize`/`transform` hooks, as `BunValidateOptions.hooks`. */
  hooks?: ValidationHooks<S>;
  /**
   * What to do on failure. Defaults to `"throw"` here rather than `"next"`:
   * in Nest a thrown `BadRequestException` is what exception filters expect.
   */
  onFailure?: "throw" | "respond";
  /** Status for a failure. Defaults to 400. */
  status?: number;
  /**
   * Also emit `@nestjs/swagger` metadata derived from these schemas, so one
   * declaration feeds validation and the OpenAPI document. Defaults to `true`
   * when `@nestjs/swagger` is present and `useSwaggerBridge()` was called,
   * `false` otherwise. See §3.8.2.
   */
  document?: boolean;
}

/**
 * Validates a controller route's request, and optionally its response.
 *
 * On a **method**, it applies to that route. On a **class**, it applies to
 * every route in the controller; a method-level `@Validate` then **merges**
 * over it per target — a target the method declares replaces the class's, a
 * target only the class declares still applies. (Merge, not replace, so a
 * controller-wide `headers` schema is not silently lost by a method that
 * declares only `body`.) `responses` merge by status, method winning.
 *
 * When `responses` is given, the decorator additionally **constrains the
 * method's return type** to the union of the declared bodies — see §3.8.3.
 */
export function Validate<
  S extends ValidationSchemas,
  const TRes extends ResponseSchemas | undefined = undefined,
>(options: ValidateOptions<S, TRes>): ValidateDecorator<TRes>;
```

#### 3.8.1 Before / after

```ts
// before — class-validator DTO, no response contract, swagger restated
@Controller("users")
export class UsersController {
  @Post()
  @ApiBody({ type: CreateUserDto })
  @ApiResponse({ status: 201, type: UserDto })
  @UsePipes(new ValidationPipe({ transform: true }))
  create(@Body() body: CreateUserDto): Promise<UserDto> { … }
}

// after — one declaration; works with a DTO class or any Standard Schema
@Controller("users")
export class UsersController {
  @Post()
  @Validate({ body: CreateUserDto, responses: { 201: UserDto, 409: ProblemDto } })
  create(@Body() body: CreateUserDto): Promise<UserDto> { … }
  //                                   ^ return type is checked against 201|409

  @Get()
  @Validate({ query: PageQuery, responses: { 200: UserListSchema } })  // zod, no DTO
  list(@Query() query: InferQuery<typeof PageQuery>): Promise<UserList> { … }
}
```

#### 3.8.2 The OpenAPI bridge — why this belongs in *this* plan

§8.5 recommends `@nestjs/swagger` rather than duplicating it. But
`@nestjs/swagger` discovers DTO **classes**; it knows nothing about a Standard
Schema. So `@Validate({ body: zodSchema })` would validate correctly and
document as nothing. That is the gap this closes:

```ts
/**
 * Lets `@Validate` emit `@nestjs/swagger` metadata from its schemas, so one
 * declaration produces both the validation and the document.
 *
 * The decorators are injected, not imported — `@nestjs/swagger` must not
 * become a bun-nest dependency or appear in a shipped declaration (§8.5).
 */
export function useSwaggerBridge(api: {
  /** `@nestjs/swagger`'s `ApiBody`. */
  ApiBody: (options: object) => MethodDecorator;
  /** `ApiQuery`. */
  ApiQuery: (options: object) => MethodDecorator;
  /** `ApiParam`. */
  ApiParam: (options: object) => MethodDecorator;
  /** `ApiHeader`. */
  ApiHeader: (options: object) => MethodDecorator;
  /** `ApiResponse`. */
  ApiResponse: (options: object) => MethodDecorator;
  /** `@nestjs/swagger`'s `SwaggerModule` document, for registering named components. */
  registerComponent?: (name: string, schema: JsonSchemaLike) => void;
}): void;
```

With it, `@Validate` applies the corresponding `Api*` decorator for every
target it was given, with `schema:` produced by **the §4 converter registry** —
`~standard.jsonSchema` first, then the vendor registry, then `class-validator`
metadata for a DTO. One declaration, two outputs.

Where it cannot reach, stated plainly:

- **A DTO keeps its native path.** When a target is a DTO class, the bridge
  emits `{ type: TheClass }`, not a converted schema — that is strictly better,
  because swagger's own `@ApiProperty` reflection produces a named component
  and a `$ref`, and it already works.
- **An anonymous Standard Schema has no component name.** It is emitted inline
  as `schema: { … }`. Inline schemas are legal and render, but they are
  repeated per operation and produce no `$ref`. Mitigation: `.meta({ id })` on
  a zod schema, or `OpenApiOptions.componentName`, supplies a name that
  `registerComponent` can hoist — **unverified**, since it depends on
  `SwaggerModule`'s component registration API, which I did not execute.
- **Swagger's schema model is OpenAPI 3.0-shaped.** `@nestjs/swagger` emits
  3.0 documents, so a converted schema should be requested at
  `target: "openapi-3.0"`, not `draft-2020-12`: `nullable: true` instead of
  `type: ["x","null"]`, no `prefixItems`, boolean `exclusiveMinimum`. This is
  the one place in the plan where 3.0 is the right target, and it is why §4's
  `ConvertContext.dialect` must not be hard-coded to 2020-12 after all — widen
  it to `"draft-2020-12" | "openapi-3.0"`.
- **`SwaggerModule` was not executed against this.** Everything above is
  design against a read of `@nestjs/swagger@11.4.6`'s `dist/`. Phase (d) must
  prove it.

#### 3.8.3 What the decorator can and cannot type — spiked

**A method decorator *can* constrain the method's return type.** **Measured**
(legacy decorators, the repo's setting): typing `@Validate`'s returned
decorator as

```ts
<T extends (...args: never[]) => ReturnUnion<R> | Promise<ReturnUnion<R>>>(
  target: object, key: string | symbol, descriptor: TypedPropertyDescriptor<T>,
) => void
```

rejects a method whose return type matches no declared response, and accepts
`async` methods. With no `responses` declared it imposes nothing (control
compiled). **This is the inversion worth calling out**: in the router,
return-typing is the *weak* option and narrowed-`res` is the strong one; in
Nest, a handler returns a value and never touches `res`, so return-typing is
the *only* option — and it happens to be the natural one.

The error is correct but noisier than the router's:

```
TS1241: Unable to resolve signature of method decorator when called as an expression.
  Argument of type 'TypedPropertyDescriptor<() => { totally: "wrong"; }>' is not
  assignable to parameter of type 'TypedPropertyDescriptor<(...args: any[]) =>
  UserDto | Problem | Promise<UserDto | Problem>>'.
    … 4 more levels …
          Type '{ totally: "wrong"; }' is not assignable to type 'UserDto | Problem | …'.
```

Six lines where the router gives one, with the useful line last. Usable, but
the README should show it so nobody files it as a bug.

**A decorator *cannot* retype a parameter. Confirmed, no workaround found.**
A method decorator's signature is `(target, key, descriptor)` and a parameter
decorator's is `(target, key, index)` — neither has a type link to a
parameter. **Measured**: with `@ValidatedBody(CreateUserSchema) body: string`,
`body` stays `string` and compiles. I tried the param-decorator route
specifically and it does not recover inference.

What works instead is an exported helper type the developer writes once:

```ts
/** The output type a schema or DTO produces — for annotating a `@Body()` parameter. */
export type Infer<S> = S extends StandardSchemaV1
  ? StandardSchemaV1.InferOutput<S>
  : S extends DtoClass<infer T> ? T : never;

@Validate({ body: CreateUserSchema })
create(@Body() body: Infer<typeof CreateUserSchema>) { … }   // inferred, not restated
```

**Verified** to infer correctly. One `typeof` per parameter is the honest cost.

**So what the decorator buys, stated without overselling:** runtime request
validation with `BunValidate`'s exact semantics including in-place
replacement; runtime **response** validation, which Nest has no equivalent of;
compile-time **return-type** checking against declared responses; one
declaration site instead of DTO + `@ApiBody` + `@ApiResponse` + `@UsePipes`;
and OpenAPI metadata for schemas swagger cannot otherwise see. It does **not**
give parameter-type inference — the developer still annotates, with `Infer<>`
making that a mechanical one-liner. For a user already happy with DTO classes
and `ValidationPipe`, the honest pitch is the response half, not the request
half.

## 4. Standard Schema → JSON Schema

### 4.1 There is now an official companion spec — use it, but do not trust it alone

`packages/bun-common/lib/types/standardSchema.ts` declares
`~standard: { version, vendor, validate, types }` — spec **1.0.0**. Spec
**1.1.0** (2025-12-15, PR standard-schema#134 by Colin Hacks) added two things
this plan depends on:

- `StandardTypedV1`, factored out as the base of both interfaces;
- `StandardJSONSchemaV1`, whose `~standard.jsonSchema.{input,output}(options)`
  is **synchronous**, returns `Record<string, unknown>`, and **may throw** for
  an unsupported `target` or an unrepresentable type.

`StandardSchemaV1.Options { libraryOptions? }` was also added, so `validate`
now takes an optional second argument. **Action item for phase (b):** update
`lib/types/standardSchema.ts` to 1.1.0's shape. It is a vendored copy of the
spec's types, and it is currently a version behind. This is a small, isolated
change that should land before the converter work.

Two caveats, and the second is why the vendor registry still exists:

1. **The interface is standardised; the output is not.** standard-schema#147
   (opened 2025-12-28 by logaretm, still open, no maintainer reply) makes the
   case: vendors differ on defaults and on whether `required` is emitted, and
   neither `draft-07` nor `draft-2020-12` pins a common feature subset. A
   consumer still needs a compatibility matrix — §4.2 is ours.
2. **zod does not throw on an unsupported target.** Measured: asking for
   `target: "nonsense-dialect"` returned a schema (with `$schema` omitted)
   rather than throwing, though the spec says a library *should* throw. So the
   generator must pass only `"draft-2020-12"` and must not treat a successful
   return as proof the dialect was honoured.

### 4.2 Per-vendor status — all figures measured against this checkout

All five libraries are already devDependencies of `bun-common`
(`packages/bun-common/package.json`), for exactly this kind of verification.

| Vendor string | Version tested | Primary path | Fallback path | Needs an import? | Fidelity / gaps |
|---|---|---|---|---|---|
| `"zod"` | 4.6.5 | **`~standard.jsonSchema.{input,output}`** (measured present; zod ≥4.2) | instance `.toJSONSchema(opts)` (added 4.2, zod#5477) or `z.toJSONSchema` | **no** | Best of the four. `.meta({ id })` puts the schema in `$defs` under that id; `z.globalRegistry` supplies title/description/examples. Throws on transforms (`"Transforms cannot be represented in JSON Schema"`) and `z.date()` unless `unrepresentable: "any"`, which emits `{}`. Unrepresentable list also covers `bigint`, `symbol`, `undefined`, `void`, `map`, `set`, `nan`, `custom`. Emits `$ref: "#"` for self-recursion (hazard, §4.4); `reused: "ref"` names shared schemas `__schema0`. **Open upstream regression to pin against: zod#6613** — format/length/integer-bound constraints dropped in some large multi-schema conversions, 4.5.4→4.6.5 |
| `"arktype"` | 2.2.3 | **`~standard.jsonSchema.{input,output}`** (measured present; arktype ≥2.1.28) | instance `.toJsonSchema(opts)` | **no** | Good fidelity (`"number > 0"` → `exclusiveMinimum: 0`, measured through both paths). Throws on a morph; `{ fallback: { morph: (ctx) => ctx.base } }` recovers the input side (measured: `string.integer.parse` → `{type:"string",pattern:"^(?:(?!^-0$)-?(?:(?:0\|[1-9]\\d*)))$"}`). Failure codes: `arrayObject`, `arrayPostfix`, `defaultValue`, `domain`, `morph`, `patternIntersection`, `predicate`, `proto`, `symbolKey`, `unit`, `date` |
| `"valibot"` | 1.5.0 core | **none in core** (measured: `~standard` has only `version,vendor,validate`) | `@valibot/to-json-schema` — either `toStandardJsonSchema(schema)`, which *wraps* a schema so it gains `~standard.jsonSchema` (added 1.5.0), or `toJsonSchema(schema, config)` directly | **yes** — one injected function | Measured against **1.8.0**, resolved via Bun auto-install: **not a declared dependency of this repo**. Default target is draft-07 (`$schema: "http://json-schema.org/draft-07/schema#"`); draft-2020-12 and openapi-3.0 targets were added in 1.5.0. Throws `The "transform" action cannot be converted to JSON Schema.`; `errorMode: "ignore"` degrades to the input side. Cannot convert: non-JSON literal/enum values, `record` with non-string key schemas, RegExp *flags*, `variant`'s discriminator. `length` counts UTF-16 units where JSON Schema counts code points — diverges on emoji |
| `"yup"` | 1.7.1 | **none** (measured: `~standard` present since yup 1.7.0, `vendor: "yup"`, no `jsonSchema`) | instance `.describe()` → **we write the mapper** | **no** | No official export (`yup.toJSONSchema` is `undefined`; a grep of the published `index.js` for `jsonSchema` finds nothing). `describe()` returns `{type, optional, nullable, oneOf, tests:[{name, params}], fields}` — enough for `min`/`max`/`integer`/`matches`/`length`/`email`/`url`, and `oneOf` → `enum`. **Gotcha, measured**: `matches`'s `params.regex` is a `RegExp`, which `JSON.stringify`s to `{}` — read `.source`. The only third-party option, `@sodaru/yup-to-json-schema`, was last published 2023-04-25 and is unmaintained |
| `"custom"` (superstruct via `toStandardSchema`) | superstruct 2.0.2 | none | none | — | No `~standard` at all (measured: `"NONE"`); last published 2024-07-06. `toStandardSchema`'s `validate` is an opaque closure, so nothing can be introspected — a wrapper can supply `validate`, never `jsonSchema`. **Falls back to `{}` plus a warning**; the user attaches JSON Schema explicitly |
| `"bun-jobs"` | — | none | `schema.json` (its own field) | no | bun-jobs' `s.*` builder already *is* JSON Schema (`schema/builder.ts`). A ~15-line built-in reading `.json` makes every bun-jobs schema usable from bun-common's generator for free |
| `"class-validator"` (§3.6) | class-validator 0.15.1 | none | `ClassDtoOptions.toJsonSchema` — e.g. `class-validator-jsonschema`'s `targetConstructorToSchema` | **yes**, injected | A DTO class **has no `~standard` at all**, so it never reaches vendor dispatch by itself. `fromDto()` wraps it in a Standard Schema stamped `vendor: "class-validator"`, and keeps a `WeakMap<StandardSchemaV1, DtoClass>` back to the original constructor so the converter can reach the class the JSON-Schema producer needs. **Measured**: `getMetadataStorage().getTargetValidationMetadatas(cls, "", false, false)` returns readable per-property entries, so the conversion is real rather than hypothetical. Without `toJsonSchema` a DTO validates and documents as `{}` plus a warning. In **bun-nest**, a DTO keeps its native `@nestjs/swagger` path instead (§3.8.2) — strictly better, since that produces a named component |

Deliberately **not** depended on, but worth knowing: `@standard-community/standard-json`
(0.3.6) is a maintained generic converter doing exactly this vendor dispatch,
with `loadVendor(vendor, fn)` for unsupported libraries; `xsschema` (0.5.0)
covers arktype, Effect, Sury, valibot and zod. Either could replace our
registry — but both are runtime dependencies for what is, after the companion
spec, four small adapters. **Recommend not taking one**, per CLAUDE.md's
dependency policy, and saying so explicitly in the README so the choice reads
as deliberate rather than ignorant. `@standard-schema/json-schema` does not
exist on npm; do not reference it.

Two measured facts that matter more than they look:

**Direction is not cosmetic.** For
`z.object({ a: z.string(), b: z.number().default(2) })`, measured through
`~standard.jsonSchema`:

| Call | `required` | `additionalProperties` |
|---|---|---|
| `input({target})` | `["a"]` — `b` has a default, so a client need not send it | *absent* |
| `output({target})` | `["a", "b"]` — after defaults are applied, `b` is always there | `false` |

(An earlier measurement suggested `input()` dropped `required` entirely; it did
not — that fixture simply had no required property. The real asymmetry is
`additionalProperties`, and the treatment of defaults, which is exactly right.)
So requests convert with `input` and responses with `output`. Getting it
backwards produces a document demanding a field the API fills in itself.

**Coercion is invisible.** `z.coerce.number().int().min(1)` converts to
`{type:"integer", minimum:1, maximum:9007199254740991}` — nothing says the wire
value is a string. For a **query parameter** that is fine and correct (OpenAPI
serialises a query parameter's schema type, it does not require `type:"string"`).
For a **body** it would be wrong, and the user must not use `z.coerce` there.
Document it; `strict` mode cannot detect it.

### 4.3 The converter registry

```ts
/** Which side of a schema a conversion describes. */
export type SchemaDirection = "input" | "output";

/** Context a converter is given. */
export interface ConvertContext {
  /** `"input"` for requests, `"output"` for responses. */
  direction: SchemaDirection;
  /**
   * The dialect the caller wants: `"draft-2020-12"` for an OpenAPI 3.1
   * document (the default and the common case), `"openapi-3.0"` when the
   * output feeds `@nestjs/swagger`, which emits 3.0 (§3.8.2) — `nullable:
   * true` instead of `type: ["x","null"]`, no `prefixItems`, boolean
   * `exclusiveMinimum`. Passed straight through to
   * `~standard.jsonSchema`'s `target`.
   */
  dialect: "draft-2020-12" | "openapi-3.0";
  /** Converts a nested schema, for a converter that recurses. */
  convert: (schema: StandardSchemaV1, direction?: SchemaDirection) => JsonSchemaLike | undefined;
}

/**
 * Turns one vendor's schema into JSON Schema.
 *
 * Return `undefined` when this converter cannot describe the schema at all;
 * the generator then records a warning and emits `{}` (or throws, in
 * `strict` mode). Never throw for an unrepresentable *part* — degrade.
 */
export type JsonSchemaConverter = (
  schema: StandardSchemaV1,
  context: ConvertContext,
) => JsonSchemaLike | undefined;

/**
 * Registers a converter for a `~standard.vendor`, replacing any built-in one.
 * Process-wide; prefer `OpenApiOptions.converters` for a per-document override.
 */
export function registerJsonSchemaConverter(
  vendor: string,
  converter: JsonSchemaConverter,
): void;

/** The built-in converters, exported so they can be wrapped or re-registered. */
export const zodConverter: JsonSchemaConverter;
export const arktypeConverter: JsonSchemaConverter;
export const yupConverter: JsonSchemaConverter;
export const bunJobsConverter: JsonSchemaConverter;

/**
 * Builds the valibot converter around `@valibot/to-json-schema`'s
 * `toJsonSchema`. valibot core carries no `~standard.jsonSchema`, so the
 * function is injected rather than imported — the same structural rule the
 * logging adapters follow.
 *
 * Not needed if the schema was wrapped with that package's
 * `toStandardJsonSchema`, which adds `~standard.jsonSchema` and so takes the
 * primary path with no registration at all.
 *
 * @example
 * ```ts
 * import { toJsonSchema } from "@valibot/to-json-schema";
 * registerJsonSchemaConverter("valibot", valibotConverter(toJsonSchema));
 * ```
 */
export function valibotConverter(
  toJsonSchema: (schema: unknown, config?: { errorMode?: "throw" | "warn" | "ignore" }) => unknown,
): JsonSchemaConverter;
```

Resolution order, per schema:

1. **`withJsonSchema()`** — an explicit JSON Schema the author attached.
2. **`~standard.jsonSchema[direction]({ target: "draft-2020-12" })`**, when the
   property is a function. Wrapped in `try`/`catch`: the spec says it *may*
   throw, and zod and arktype both do for unrepresentable types. A throw falls
   to step 3 rather than aborting the document, and records a warning naming
   the vendor and the thrown message.
3. `options.converters[vendor]` → the process registry → the built-ins.
4. `{}` plus a warning (or `ConfigError` in `strict`).

Step 2 being first among the automatic paths is the whole point: a library that
adopts the companion spec tomorrow works with no change here.

**The escape hatch** is a raw JSON Schema (or OpenAPI fragment) anywhere a
schema is accepted — `RouteDoc.request.*` and `RouteResponseDoc.schema` both
take `StandardSchemaV1 | JsonSchemaLike`, discriminated on the presence of
`~standard`. There is a second form for a schema you still want to *validate*
with:

```ts
/**
 * Attaches an explicit JSON Schema to a Standard Schema, so the generator
 * emits this instead of converting. The schema still validates as before.
 */
export function withJsonSchema<S extends StandardSchemaV1>(
  schema: S,
  json: JsonSchemaLike,
): S;
```

Implemented as a `WeakMap<StandardSchemaV1, JsonSchemaLike>` checked before
vendor dispatch — so it works for superstruct, joi, a hand-written
`toStandardSchema`, and any vendor that ships tomorrow.

### 4.4 `$ref` and component dedup

Three problems, one of them measured and nasty.

1. **Vendors emit `$defs`, OpenAPI wants `components.schemas`.** zod emits
   `{$ref: "#/$defs/PageQuery", $defs: {...}}` when `.meta({id})` is set, and
   `#/$defs/__schema0` for `reused: "ref"`. Every converter's output is
   post-processed: `$defs` lifted into `components.schemas`, every
   `#/$defs/X` rewritten to `#/components/schemas/X`, `$schema` stripped
   (OpenAPI 3.1 forbids a per-schema `$schema` differing from
   `jsonSchemaDialect`), anonymous `__schemaN` names replaced by
   `componentName()` or inlined.

2. **Self-recursion becomes a dangling ref.** Measured: a self-referential zod
   object converts to `{properties:{self:{$ref:"#"}}}`. Inlined into a
   document, `#` points at the OpenAPI **document root**, which is not a
   schema. The lift step must rewrite `"#"` and any `"#/..."` relative to the
   schema's new home. A test asserts `danglingRefs(document)` is empty and
   that a recursive schema round-trips through ajv.

3. **Dedup by identity, not by structure.** The generator keeps a
   `Map<StandardSchemaV1 | JsonSchemaLike, string>` and a
   `Map<string, unknown>` name→body. Two references to the *same schema
   object* share one component; two structurally identical but distinct
   objects do not (comparing JSON would be O(n²) and would merge schemas the
   author meant to keep apart). Two *different* schemas claiming one name
   throw `ConfigError` — bun-jobs' `toJsonSchema` does exactly this
   (`schema/builder.ts`: *"Two different schemas are both named"*) and the
   rule is worth copying verbatim.

Unreferenced components are dropped by `pruneSchemaComponents`, lifted from
`packages/bun-jobs/lib/api/spec/refs.ts` (§6).

---

## 5. AsyncAPI 3.0 mapping

AsyncAPI 3.0 split channels from operations: a channel carries `address`,
`messages` and `parameters`; a top-level `operations` map carries
`action: "send" | "receive"` plus `channel: {$ref}`. 2.x's
`publish`/`subscribe` under a channel are gone. That split is what makes a
direction-less transport hard to describe — and bun-common's is direction-less.

### 5.1 bun-common `BunWebSocket`

| bun-common concept | AsyncAPI 3.0 element | Notes |
|---|---|---|
| `setRouteHandler(path, …)` / `router.ws(path, …)` key | `channels.<id>.address` | the only channel source; needs a **new public accessor** on `BunWebSocket` |
| `:param` in that path | `channels.<id>.parameters.<name>` | AsyncAPI 3.0 parameters have **no `schema` keyword** — bun-jobs carries it as `x-bun-jobs-schema` (`spec/asyncapi.ts`), and we would carry `x-bun-common-schema` |
| bound port + host | `servers.<id>.host` + `pathname` | from `get port()` / `getServer()`; `protocol: "ws" \| "wss"` from the request or an option |
| `Sec-WebSocket-Protocol` from `onUpgrade` | `servers.<id>.bindings.ws` + an extension | only present if the hook sets it |
| `idleTimeout`, `maxPayloadLength`, `perMessageDeflate` | vendor extension on the channel | no AsyncAPI keyword for them |
| `open` / `close` | **nothing** | AsyncAPI has no lifecycle concept; document in prose |
| `message` (`string \| Buffer`) | one `receive` operation with an empty payload | honest but useless |
| **an event name** | `components.messages.<id>.name` | **does not exist** |
| **a payload schema** | `components.messages.<id>.payload` | **does not exist** |
| **direction** | `operations.<id>.action` | **does not exist** |
| **rooms / topics** | a channel each | **does not exist** (zero grep hits) |
| ack / reply | `operations.<id>.reply` | **does not exist** |

So from bun-common alone the honest output is: `servers`, `channels` with
addresses and parameters, and one `receive`+one `send` operation per channel
with `payload: {}`. That is a stub, not documentation.

The gap is closed by a **declaration API**, mirroring `.describe()`:

```ts
/** Documents a WebSocket route's messages. */
export interface WsChannelDoc {
  /** Channel title. Default: the path. */
  title?: string;
  /** CommonMark description. Default: none. */
  description?: string;
  /** Messages a client sends to the server (AsyncAPI `receive` from the app's view). */
  receives?: Readonly<Record<string, WsMessageDoc>>;
  /** Messages the server sends to a client (AsyncAPI `send`). */
  sends?: Readonly<Record<string, WsMessageDoc>>;
  /** The subprotocol clients must request. Default: none declared. */
  subprotocol?: string;
}

/** One message on a channel. */
export interface WsMessageDoc {
  /** One-line summary. Default: none. */
  summary?: string;
  /** Payload schema — any Standard Schema or raw JSON Schema. Default: unconstrained. */
  payload?: StandardSchemaV1 | JsonSchemaLike;
  /** Media type. Default: `"application/json"`. */
  contentType?: string;
  /** Named examples, validated against `payload` in tests. Default: none. */
  examples?: Readonly<Record<string, unknown>>;
  /** The message id sent in reply, for a request/response pair. Default: none. */
  reply?: string;
}

/** Attaches channel documentation to a registered WebSocket route. */
BunWebSocket.prototype.describeChannel(path: string, doc: WsChannelDoc): this;
```

### 5.2 bun-nest `BunWebSocketAdapter`

Much better, because the wire format is fixed and the event names are in Nest's
metadata.

| bun-nest concept | AsyncAPI 3.0 element | Source |
|---|---|---|
| `GATEWAY_OPTIONS.path` + `.namespace`, concatenated by `resolveRoute` (`BunWebSocketAdapter.ts:557`) | `channels.<id>.address` | gateway class metadata |
| `PORT_METADATA` | `servers.<id>` (one per distinct port) | gateway class metadata |
| `@SubscribeMessage("name")` → `MESSAGE_METADATA` | a `receive` operation + `components.messages.<name>` | `gateway-metadata-explorer.js:22-32` |
| The frame envelope `{type:2, namespace, id?, data:[event, ...args]}` (`MessageEventTypes`, `:134`) | the **message payload** is the whole envelope; the handler's DTO is `data[1]` | fixed by the adapter — a generator emits the envelope wrapper itself, exactly as bun-jobs wraps events in `eventEnvelope` |
| `@MessageBody()` DTO class | `payload` for `data[1]` | needs `@ApiProperty`/`@nestjs/swagger` or an attached Standard Schema |
| `@Ack()` / `isAckHandledManually` (`gateway-metadata-explorer.js:36`) | `operations.<id>.reply` → an `ACK` (type 3) message | metadata |
| `WsException` → `["exception", {status,message,cause}]` (`:454-458`) | a `send` message, always present | fixed |
| `CONNECT`(0)/`DISCONNECT`(1)/`ERROR`(4) frames | three fixed messages on every channel | fixed |
| Wildcard route `"/*"` (`connectionMatchesRoute`, `:563`) | **unmappable** | an AsyncAPI address is a template, not a glob |
| **Outbound event names** (`client.emit(name, …)`, `WsResponse.event`) | `send` operations | **runtime strings — invisible.** Must be declared |
| `namespace` field on the wire | **nothing** — it is echoed, not routed (`:147,154,169,193`) | note it in prose so nobody reads it as a channel |

**Verdict:** bun-nest can auto-derive every *inbound* operation and its
envelope, and must be told about outbound ones. That is a genuinely useful
document and a defensible split.

---

## 6. Reuse vs rewrite: `packages/bun-jobs/lib/api/spec/`

### 6.1 Module-by-module

| Module | Lines | Generic? | Verdict |
|---|---|---|---|
| `spec/refs.ts` | 101 | **fully** — `collectRefs`, `resolveRef`, `danglingRefs`, `pruneSchemaComponents`, `SCHEMA_REF_PREFIX`. No bun-jobs import at all | **Move to `bun-common/lib/docs/refs.ts`, verbatim.** bun-jobs re-exports from there |
| `spec/security.ts` | 144 | **nearly** — `openApiSecurity`, `toAsyncApiSecurityScheme`, `OpenApiSecurityScheme`. Only dependency is `ResolvedJobsApiDocsOptions`, and only for `Pick<…, "securitySchemes" \| "security">` | **Move**, widening the parameter to a structural `{ securitySchemes?, security? }`. Keep the `browserNote` strings — they are correct for any browser WebSocket |
| `spec/openapi.ts` | 383 | **mixed.** Generic: the path→template conversion and its guards, parameter emission from a properties map, `style/explode` for arrays, the `components` + prune + `Problem`-response assembly, the duplicate-operationId and duplicate-`method+path` guards. Specific: `TAG_DESCRIPTIONS`, `routeErrorCodes` + `API_ERROR_STATUS`, the CSRF header/`requireJson` parameters, `x-bun-jobs-action/-mutation/-requires/-csrf`, `packageVersion()`, `AnyRouteDef` | **Rewrite in bun-common against a neutral `DiscoveredRoute`.** Port `toOpenApiPath` verbatim (it is 25 lines and its guards are exactly right); port the parameter/response assembly as a shape, not as code |
| `spec/asyncapi.ts` | 691 | **no.** Needs `CHANNELS` (`ws/channels.ts`), `QUEUE_EVENTS`/`RUNNER_EVENTS`/`WORKER_EVENTS` (`ws/events.ts`), the nine control-frame schemas (`ws/protocol.ts`), `RATE_BREACH_WINDOW_MS` (`ws/session.ts`), the resolved `websocket` limits, and the contract constants | **Leave.** Write a new, much smaller generator in bun-common from `WsChannelDoc` |
| `spec/asyncapi-examples.ts` | 506 | **no** — one hand-written example per bun-jobs message | **Leave** |
| `schema/builder.ts` | 615 | It is bun-jobs' own DSL, whose entire point is "one definition feeds the validator, the TypeScript type and the specs". bun-common's story is Standard Schema from any vendor | **Leave.** Add a 15-line `bunJobsConverter` in bun-common that reads `schema.json` (see §4.2), so the two meet without either moving |
| `schema/validate.ts`, `schema/coerce.ts` | 617 | bun-jobs' JSON Schema interpreter — a validator, not a generator | **Leave** |
| `docs/html.ts`, `docs/cdn.ts` | 420 | **fully generic** apart from the title default and the CSRF interceptor line. CSP, nonce, `jsonForScript`, SRI `assetTags`, the pinned versions and hash validation are all reusable | **Move to `bun-common/lib/docs/viewer.ts`**, parameterised on `{ title, documentUrl, requestHeaders }`. bun-jobs keeps its route wrappers |

**So: ~665 of 1,825 lines in `spec/` + `docs/` move; the rest stays.** The
generators are not the reusable part — `refs`, `security` and the viewer shell
are.

### 6.2 What extraction would break, and how bun-jobs keeps working

bun-jobs' specs are heavily tested and must not regress:
`__tests__/api/api-spec.test.ts` (1,032 lines) validates every one of a
12-case `mode × readOnly × security` matrix against the vendored OpenAPI 3.1
meta-schema (`__tests__/fixtures/schemas/oas-3.1.json`, from
`spec.openapis.org/oas/3.1/schema/2022-10-07`) and the official AsyncAPI
3.0.0 schema from `@asyncapi/specs@^6.11.1`; `api-docs.test.ts` (437) checks
the CDN pins, SRI and CSP, and even fetches each pinned URL to verify its
sha384.

Risks and mitigations:

| Risk | Mitigation |
|---|---|
| `refs.ts` moving changes an import path | bun-jobs' `lib/api/index.ts` already re-exports the `spec/refs` utilities. Keep that barrel, change only what it re-exports from. `api-spec.test.ts` imports from `"../../lib/api/spec/refs"` — keep `spec/refs.ts` as a two-line re-export so no test moves |
| `security.ts` widening its parameter type | `openApiSecurity` is called with `config.docs` (`ResolvedJobsApiDocsOptions \| false`), which structurally satisfies `{securitySchemes?, security?} \| false`. No call site changes |
| bun-common gaining the CSP/CDN viewer changes the pinned versions | Move the module, keep bun-jobs' `DOCS_CDN` constant in bun-jobs. The pins are a bun-jobs decision recorded in its own tests |
| A circular dependency | None: bun-jobs already depends on bun-common, and nothing in bun-common would import bun-jobs |
| bun-jobs' `ConfigError` vs bun-common's | The moved modules throw `ConfigError`. bun-common has no `ConfigError` today (bun-jobs' lives in `lib/shared/errors`). **Add one to bun-common** and have bun-jobs' extend or alias it — this is the one non-trivial ripple, and it needs its own check that `instanceof ConfigError` still holds in bun-jobs' tests |

**Verdict: partial extraction, not a parallel implementation and not a
wholesale lift.** A parallel implementation would duplicate `pruneSchemaComponents`
and the security mapping — 245 lines of subtle, already-tested code — for no
benefit. A wholesale lift would drag bun-jobs' schema DSL into bun-common and
make bun-common's Standard Schema story a second-class citizen in its own
package.

---

## 7. Serving and viewing

### 7.1 Router shape

```ts
/** Options for {@link docsRouter}. */
export interface DocsRouterOptions {
  /** The OpenAPI document, or a function returning a fresh one. Required unless `asyncapi` is given. */
  openapi?: OpenApiDocument | (() => OpenApiDocument);
  /** The AsyncAPI document, or a function returning one. Default: none, and the route is absent. */
  asyncapi?: AsyncApiDocument | (() => AsyncApiDocument);
  /** Where the OpenAPI JSON is served, under the mount. Default: `"/openapi.json"`. */
  openapiPath?: string;
  /** Where the AsyncAPI JSON is served. Default: `"/asyncapi.json"`. */
  asyncapiPath?: string;
  /**
   * Serve the HTML viewer pages. **Default: `false`** — they load third-party
   * script into an origin that may hold session cookies, and "try it out" is
   * a mutation console. The JSON costs nothing and is always served.
   */
  ui?: boolean;
  /** Where the OpenAPI viewer page is served. Default: `"/"`. */
  uiPath?: string;
  /** Where the AsyncAPI viewer page is served. Default: `"/asyncapi"`. */
  asyncapiUiPath?: string;
  /** Page title. Default: the document's `info.title`. */
  title?: string;
  /** CDN pins and mirror base URL. Default: the built-in pins. */
  cdn?: DocsCdnOptions;
  /** Runs before every docs route — put authorization here. Default: none. */
  authorize?: RouterHandler;
}

/** Mountable router serving the documents and, optionally, the viewer pages. */
export function docsRouter(options: DocsRouterOptions): BunRouter;
```

Mounted like anything else: `app.use("/docs", docsRouter({ openapi }))`.

### 7.2 The UI choice

Three candidates, and the repo has already built two of them.

| Option | Bundle cost | Offline | Verdict |
|---|---|---|---|
| **CDN viewer pages** — copy bun-jobs' `docs/html.ts` + `docs/cdn.ts` (pinned `swagger-ui-dist@5.32.15` and `@asyncapi/react-component@3.1.8` on jsDelivr, sha384 SRI, `default-src 'none'` CSP with a per-request nonce) | zero in the package; ~1 MB fetched by the browser | **no**, unless `cdn.baseUrl` points at a mirror | **Ship this in phase (c).** 420 lines, already written, already tested against the live CDN hashes. Off by default |
| **Reuse `jobsUi()`** | — | — | **No.** `jobsUi()` is `@kingsleyweb/bun-jobs-ui`, whose `UiConfig` (`lib/shared/config.ts`) is jobs-shaped (`websocket`, `sections: {manage, docs}`, `apiBase`) and whose app has a whole management UI beside the docs. Mounting it to read an arbitrary OpenAPI document would mean carrying the jobs screens |
| **A generic self-hosted viewer** — generalise `packages/bun-jobs-ui/app/screens/docs/**` (6,806 lines; largest lazy chunk measured at 66.7 KiB / 21.2 KiB gzipped on 2026-09-21, `__tests__/server/budget.test.ts`) into a new `@kingsleyweb/bun-api-docs-ui` | ~67 KiB lazy, self-hosted with its own sha384 SRI and `default-src 'self'` CSP | **yes** | **The right long-term answer, and the wrong thing to build first.** `schema/` (resolve + SchemaTree + Prose, ~1,000 lines) is already written as dialect-agnostic 2020-12 rendering and would lift cleanly; `http/model.ts` (465) is plain OpenAPI 3.1 and would generalise; `ws/model.ts` (1,152) is bound to `x-bun-jobs-*` and would not. Defer to a phase (f) |

**Constraint that decides it:** the two existing CSPs are incompatible. The CDN
pages need `default-src 'none'; script-src 'nonce-…' <cdn>; style-src <cdn>
'unsafe-inline'` (`bun-jobs/lib/api/docs/html.ts`); bun-jobs-ui gets
`default-src 'self'; script-src 'self' 'nonce-…'; style-src 'self'` with no
inline styles at all (`bun-jobs-ui/lib/shell.ts:73-88`). A single shared viewer
must pick one. Phase (c) picks the CDN one because it is 420 lines and already
green; phase (f) replaces it with the stricter self-hosted one and keeps the
CDN pages as an option.

### 7.3 Relationship to bun-jobs-ui

None, initially, and deliberately. The one thing worth doing now is *not
diverging*: if a generic viewer is built later, it should be extracted from
`bun-jobs-ui/app/screens/docs/schema/` and `http/`, and bun-jobs-ui should
consume it rather than keeping a fork. Phase (f) would carry that migration,
and bun-jobs-ui's three golden AsyncAPI fixtures
(`__tests__/app/docs/ws/fixtures/*.json`, kept fresh by
`__tests__/app/pkg/docs-ws.integration.test.ts` with `UPDATE_WS_FIXTURES=1`)
are the regression net for it.

---

## 8. Packaging

### 8.1 New entry point, not a new package

`@kingsleyweb/bun-common/lib/docs`. Reasons:

- It has **no runtime dependency of its own** (§4.3): converters are
  structural, the viewer shell is string building, `refs` is a JSON walker.
  A separate package would exist only to be a second `node_modules` entry.
- It needs deep access to `BunRouter`'s internals (`#lastRoute`,
  `RouteWithGroup.isEndpoint`/`wildcardNames`, `getMatchedLayers`). Across a
  package boundary those become public API, which is worse.
- CLAUDE.md's `exports` rule wants **one explicit key per directory with an
  `index.ts`** — `./lib/*` would map `lib/docs` to a nonexistent `lib/docs.ts`.
  So the addition is exactly one key.

### 8.2 `package.json` delta for `packages/bun-common`

```jsonc
{
  "exports": {
    ".": { "@kingsleyweb/source": "./lib/index.ts", "types": "./dts/index.d.ts", "default": "./lib/index.ts" },
    "./lib": { "...": "unchanged" },
    // NEW — a directory with an index.ts needs its own key
    "./lib/docs": {
      "@kingsleyweb/source": "./lib/docs/index.ts",
      "types": "./dts/docs/index.d.ts",
      "default": "./lib/docs/index.ts"
    },
    "./lib/multipart": { "...": "unchanged" },
    "./lib/multipart/storage": { "...": "unchanged" },
    "./lib/*.ts": { "...": "unchanged" },
    "./lib/*.js": { "...": "unchanged" },
    "./lib/*":    { "...": "unchanged" },
    "./package.json": "./package.json"
  },
  "dependencies":     { /* UNCHANGED — no new runtime dependency */ },
  "peerDependencies": { /* UNCHANGED — no new peer, optional or otherwise */ }
}
```

**Nothing else changes.** That is the payoff of the structural-converter
decision, and it should be stated in the PR description, because the obvious
design (optional peers on `zod`/`valibot`/`arktype` + lazy `import()`) would
have cost:

| The rejected design | What it costs |
|---|---|
| `peerDependencies: { zod, valibot, arktype, yup }` + `peerDependenciesMeta` optional | four optional peers on the repo's most-depended-on package |
| `await import("zod")` in a converter | the shipped `dts/docs/converters/zod.d.ts` would import `zod` — which `checkPeerScopes` (`scripts/build-declarations.ts:273`) fails on, because the root `exports["."]` reaches it and declares no `peers` |
| a `./lib/docs/converters/zod` entry with `"peers": ["zod"]` in `consumer-check.json` | four more entries, four more consumer installs, and `zod` pulled into any bundle that touches `lib/docs` |

With structural converters, the shipped declarations import nothing but
bun-common's own modules and `StandardSchemaV1`, so `checkPeerScopes` has
nothing to complain about.

### 8.3 `consumer-check.json` additions

```jsonc
{
  "spelling": "@kingsleyweb/bun-common/lib/docs",
  "values": ["generateOpenApi", "generateAsyncApi", "docsRouter",
             "registerJsonSchemaConverter", "valibotConverter", "withJsonSchema"],
  "types":  ["RouteDoc", "OpenApiOptions", "OpenApiResult", "DiscoveredRoute",
             "JsonSchemaConverter", "WsChannelDoc"]
},
{
  // the browser half: a viewer bundles the *types*, never the generator
  "spelling": "@kingsleyweb/bun-common/lib/docs/types",
  "types": ["OpenApiDocument", "AsyncApiDocument", "JsonSchemaLike"],
  "browser": true
}
```

No `"peers"` on either, which is the assertion that matters: both must load in
a consumer with **no** optional peer installed. The existing root entry's
snippet gains one line asserting `RouteDoc` is not `any`.

### 8.4 `dts/` and in-repo resolution

`tsconfig.build.json` needs no change (`rootDir: lib` already covers
`lib/docs/**`). `build-declarations.ts`'s verify step will require a
declaration for every new `lib/docs/*.ts`, which is automatic. The
`customConditions: ["@kingsleyweb/source"]` in `tsconfig.base.json` means
in-repo type-checking hits `lib/docs/index.ts`, never a stale `dts/`.

### 8.5 bun-nest

**No packaging change, and probably no code.** `@nestjs/swagger` should be a
documented recommendation, not a dependency: it is not a peer bun-nest needs,
and adding it would put a Swagger-shaped API in a package whose job is the
adapter. If a helper does prove necessary it belongs at `./lib/swagger` with
`"peers": ["@nestjs/swagger"]` in `consumer-check.json`, exactly the shape
`./jobs` already uses for `@kingsleyweb/bun-jobs`.

### 8.6 The `@nestjs/swagger` verification — the bun-nest half is mostly "verify + document"

`@nestjs/swagger` is **not installed in this repo** (`node_modules/@nestjs/`
holds only `common`, `core`, `websockets`; `bun.lock` has no `swagger`).
It was read from the global Bun cache at **11.4.6**
(`~/.bun/install/cache/@nestjs/swagger@11.4.6@@@1/dist/`).

An exhaustive grep of that `dist/` for `httpAdapter.` / `getHttpAdapter()` /
`useStaticAssets` gives the **complete** adapter surface `SwaggerModule.setup()`
needs — four members:

| Swagger call | Site | bun-nest |
|---|---|---|
| `httpAdapter.getType()` | `swagger-module.js:104`, `swagger-scanner.js:25` | **`BunHttpAdapter.ts:1266` returns `"express"`** — so every fastify branch is skipped and the express path is taken throughout |
| `app.useStaticAssets(path, { prefix })` | `swagger-module.js:112` (express branch) | **`BunHttpAdapter.ts:1172`**, `(path: string, options: ServeStaticOptions)`, reading `options.prefix` — exactly that signature |
| `httpAdapter.get(path, handler)` | `:146, :160, :197, :198, :199, :203, :210, :221` | **`:1622`** → `registerVerb("get", …)` → `BunRouter.get` |
| `httpAdapter.getRequestUrl(req)` | `:190` | **`:1188`**, returns `request.originalUrl` (path + search) |

Plus two members on the raw response, because Swagger's handlers bypass Nest's
pipeline: `res.type(mime)` (`BunResponse.ts:839`) and `res.send(string)`
(`:1122`). Both exist.

It never calls `set()`, `enable()`, `engine()`, `setViewEngine()`, `render()`,
`reply()`, `status()`, `setHeader()`, `isHeadersSent()`, `use()` or
`getInstance()` — which matters, because `set`/`enable`/`disable`/`engine` do
**not exist** on `BunHttpAdapter` and `setViewEngine` (`:3036`) is a no-op stub.

Two residual risks were flagged and both are now **measured green**:

```
/api      -> 200 "PAGE"    text/html     // httpAdapter.get(finalPath, html)
/api/     -> 200 "PAGE"    text/html     // the `${finalPath}/` registration (swagger-module.js:203)
/api/x.js -> 200 "STATIC"  text/plain    // falls through to `${prefix}/*`
```

so (1) `BunRouter`'s path regex ends `/?$`, making `/api/` equivalent to `/api`
rather than falling through to the static handler, and (2) a handler that calls
`res.send()` without `next()` terminates the pipeline — the second route did not
also run.

Remaining gaps to close in phase (d), none of them blocking:

1. `swagger-ui-dist` is not in the repo; the example needs it as a devDependency.
2. End-to-end `SwaggerModule.setup()` has **not** been executed. Phase (d)'s
   first task is an example that does, under `examples/bun-nest/`.
3. `@nestjs/swagger` reads Nest metadata only, so a route registered directly
   on the adapter (`adapter.get(...)`) is invisible to it — and a route in a
   Nest controller is invisible to bun-common's `generateOpenApi` unless the
   path survives `setGlobalPrefix` (**assumed**, unverified). A mixed app needs
   both documents, or one merged by hand. Say so in the README rather than
   building a merger.
4. `@Render()` on a bun-nest app sends a raw file (`render`, `:1105`, is
   `Bun.file`, not a template engine) — unrelated to Swagger but worth a note
   beside it.

---

## 9. Testing strategy

The pattern is already established by bun-jobs and should be copied, not
reinvented.

### 9.1 Meta-schema validation (the non-negotiable one)

| Document | Schema source | Validator |
|---|---|---|
| OpenAPI 3.1 | **vendor** the meta-schema into `packages/bun-common/__tests__/fixtures/schemas/oas-3.1.json`, as bun-jobs does (its copy is from `spec.openapis.org/oas/3.1/schema/2022-10-07`, fetched 2026-09-15). Record the source URL and date in the file's `$id` and in a comment | `ajv@^8` `ajv/dist/2020` + `ajv-formats`, both **devDependencies** |
| AsyncAPI 3.0 | `@asyncapi/specs@^6.11.1` devDependency, `schemas/3.0.0.json` — a draft-07 bundle, so compile with ajv's **draft-07** build and delete the embedded `http://json-schema.org/draft-07/schema` definition first |  same |

**Which spec version to emit.** Reported by research, to be re-checked against
the sources before vendoring:

- The latest OpenAPI **3.1.x** patch is **3.1.2** (2025-09-19), not 3.1.0. The
  patches are editorial — OAS says tooling "should make no distinction"
  between 3.1.0/3.1.1/3.1.2 and the schema dialect is unchanged — so
  `openapi: "3.1.2"` is right and the `2022-10-07` meta-schema still validates
  it. Note the line has moved on: **3.2.0** (2025-09-19) and **3.2.1**
  (2026-09-10) exist and are feature releases (nested tags, the `query`
  method, `$self`, streaming media types). Out of scope; say so.
- The latest AsyncAPI is **3.1.0** (2026-01-31), a minor with no breaking
  changes — `asyncapi: '3.0.0'` → `'3.1.0'` verbatim, its one headline
  addition being ROS 2 bindings. bun-jobs emits `3.0.0`; phase (e) should
  decide deliberately whether to match it or move to 3.1.0, and the two
  packages should agree.

Copy bun-jobs' two workarounds verbatim, with its comments:

- ajv does not honour the OAS schema's `$dynamicAnchor: "meta"`, so the test
  rewrites `"$dynamicRef": "#meta"` → `"$ref": "#/$defs/schema"` **in memory**
  and asserts the fixture still contains the original.
- The OAS schema names a `media-range` format ajv-formats lacks;
  `ajv.addFormat("media-range", true)`.

And copy the `describe.skipIf(!ajv)` + `BUN_*_TEST_AJV_DIR` escape hatch, so the
suite skips **visibly** where the devDependency is absent rather than failing.

Every generated document must validate across a matrix, as bun-jobs does over
`mode × readOnly × security`. Ours: `{ no schemas, zod, valibot, arktype, yup,
mixed } × { no security, bearer, apiKey } × { strict, lenient }`.

### 9.2 Round-tripping and invariants

- `danglingRefs(document)` is empty for every matrix cell — the direct test for
  the `$ref: "#"` recursion hazard (§4.4).
- Every `components.schemas` entry **compiles standalone** under ajv (bun-jobs
  does this; it is what catches a lifted `$defs` whose refs were not rewritten).
- Every path template's parameters exactly equal the route's `params`, and each
  is `required: true`.
- **Route/document parity**: for every documented operation, `router.fetch()`
  the synthesised path and assert the real status is one the document declares.
  This is bun-jobs' `api-ui-gaps.test.ts` idea ("real responses match the
  generated OpenAPI document") and it is the only test that catches a
  hand-written `responses` going stale.
- `generateOpenApi` is deterministic: two calls on one router deep-equal.

### 9.3 Converter tests

One file per vendor, each asserting the converted JSON Schema **accepts and
rejects the same values the schema does** — ajv-compile the output, then run a
shared value table through both the Standard Schema's `validate` and the
compiled JSON Schema, and require agreement. That is stronger than a snapshot
and survives a vendor's minor release changing its emit. Known divergences
(zod's `z.coerce` on a query, valibot's `errorMode: "ignore"` dropping a
transform) get an explicit allow-list with a comment naming the measurement.

Negative controls, per CLAUDE.md's habit: flip one expectation and the test
must fail.

### 9.4 Snapshots

**One golden document**, for a small fixture router exercising every feature
(mount, wildcard, regex param, validator, `.describe()`, `hidden`, all four
targets), regenerated with `UPDATE_DOCS_FIXTURE=1` — the shape bun-jobs-ui uses
for its WS fixtures. Not per-vendor snapshots: they would break on every
dependency bump for no signal.

### 9.5 Type tests

`__tests__/docs.type-test.ts`, checked by the tests typecheck, not `bun test`
(the repo's convention — `logging.type-test.ts`, `verbTyping.type-test.ts`):

- `.describe()` returns `this` and chains.
- `RouteDoc.responses` accepts a bare schema, a `RouteResponseDoc` and `null`.
- `RouteDoc.request.query` accepts a zod, valibot, arktype and yup schema and a
  raw JSON Schema object.
- **The critical one:** a file that registers routes with `.describe()` and
  asserts the handler's `req.params`/`req.query` types are *unchanged* —
  `Equal<Params["id"], string>`, `IsAny<Query>` false. This is the regression
  guard for "did adding `.describe()` disturb the overloads", alongside
  `bun scripts/generate-verb-overloads.ts --check`.

`__tests__/responses.type-test.ts` (phase b1) carries the spike verbatim —
it already exists as working code:

- positive: `res.status(200).json(declared)` compiles; request narrowing
  survives; `async` handlers work; a mounted sub-router declaring
  `BunRouter<"/users/:uid", { responses: … }>` is constrained;
- four `@ts-expect-error` negative controls: wrong body for a status,
  undeclared status, bare `json()` outside the union, and the sub-router case;
- **boundary assertions that must *compile*** — `res.send(anything)`,
  `helper(res)` with `helper(res: BunResponse)`, a bare returned object, and a
  validator with no `responses` leaving `res` fully unconstrained. These are
  not aspirational: they pin §3.7's documented limits so a later "improvement"
  that closes one is a deliberate decision, not a silent behaviour change.

`packages/bun-nest/__tests__/validate.type-test.ts` (phase g) carries spike D:
a method whose return type matches no declared response is
`@ts-expect-error`'d; one that matches compiles; `@Validate` with no
`responses` imposes nothing (control); and `@ValidatedBody(S) body: string`
compiles, pinning the "a decorator cannot retype a parameter" limit.

Runtime tests for (b1)/(b2): a response that violates its schema logs exactly
once under `"log"` and throws under `"throw"`; a stream response is skipped
with one warning; an undeclared status is reported under `"report"` and passed
under `"allow"`; `redirect()` and 204 behave as §3.5's table says; and a DTO
target validates, coerces (`"42"` → `42`) and **replaces `req.query` in
place** so a later reader sees the parsed value.

### 9.6 The `examples/` obligation

CLAUDE.md's examples protocol applies: a user-facing change means a CHANGE
REPORT to the examples peer, and `examples/bun-common/run-all.ts` must pass
before merge. New folders:

- `examples/bun-common/13-api-docs/` — `annotating-routes.ts`,
  `from-validators.ts`, `serving-and-viewing.ts`, and `10-options/`'s
  `openapi-options.ts` (the repo's convention is one `10-options/` file per
  options interface).
- `examples/bun-common/13-api-docs/response-contracts.ts` (phase b1) and
  `class-dtos.ts` (b2). The DTO example must skip visibly
  (`skipped: class-validator is not installed`) rather than fail, since
  neither library is a dependency — and its own `tsconfig` must set
  `experimentalDecorators`, which is a useful demonstration in itself.
- `examples/bun-nest/08-validate/` (phase g) — `route-decorator.ts`,
  `controller-scope.ts`, `swagger-bridge.ts`, plus `10-options/validate-options.ts`
  per the repo's one-file-per-options-interface convention.
- `examples/bun-nest/07-openapi/swagger-module.ts` — the end-to-end
  `SwaggerModule.setup()` proof from §8.6, skipping visibly
  (`skipped: …`) when `@nestjs/swagger` or `swagger-ui-dist` is absent.

Each example's assertions go through `shared/check.ts`, and the AsyncAPI one
must skip cleanly where no port can be bound.

### 9.7 Per-phase gate

`bun scripts/typecheck.ts`; `CI=1 bunx eslint .` in each touched package;
`bun test` and `bun test --randomize` (a couple of seeds) in bun-common,
bun-nest **and bun-jobs** — bun-jobs is downstream of every bun-common change
and its spec tests are the extraction's regression net;
`bun run-all.ts` in `examples/bun-common` and `examples/bun-nest`.

---

## 10. Bottlenecks, risks and open questions

Ordered by how much they can hurt.

1. **Response types are not inferable — they are declared, and now enforced.**
   Nothing derives a schema from `res.json(x)`. §3.5 and §3.7 close the *drift*
   half of this (runtime checking, compile-time checking, the route/document
   parity test of §9.2), but the declaration itself is hand-written and
   always will be. The earlier open question about a `res.jsonAs(Schema, value)`
   helper is now **closed as unnecessary**: `validate(..., { responses })`
   gives the same guarantee without a second way to write a response.

1b. **Compile-time enforcement is partial, and two of its holes are
   structural.** §3.7's table is the boundary. The two that cannot be closed
   without disproportionate cost: `res.send()` (constraining it would reject
   every legitimate string/Buffer/stream response) and a helper function taking
   a plain `BunResponse` (`TResponses` appears only in method parameter
   positions, so a narrowed `res` is assignable to a bare one — closing it
   needs variance annotations that would break far more than they fix). The
   README must state both. **Open question:** should `jsonp()` be constrained
   like `json()`? It is trivially possible and nobody uses `jsonp`.

1c. **`BunResponse` gains a second type parameter, and that is a public type
   change.** Both parameters default, and **measured**, the patched library
   plus its ~18 `BunResponse`-naming files typecheck clean — but `dts/`
   changes, so it is a minor-version surface change and
   `consumer-check.json`'s `BunResponse` spellings must be re-run. The one
   ergonomic cost inside the class is real: `TResponses` is unresolved there,
   so all ~8 internal `this.status(n)` calls must go through a
   `protected setStatusRaw`. A future contributor writing `this.status(500)`
   in `BunResponse.ts` will get a confusing error; the method needs a comment
   saying why, and the spike's wording is a good start.

1d. **Runtime response validation is not free, and streams are exempt.**
   One Standard Schema `validate()` per response when enabled — the same order
   as validating a request body. Default `"off"`, recommended dev-only, and
   `sendFile`/stream/`StreamableFile` responses are skipped outright because
   checking them would mean buffering the thing that exists not to be
   buffered. A route whose success path is a stream therefore gets **no**
   response checking, silently, apart from one warning per route.

1e. **Class DTOs require `experimentalDecorators`, and stage-3 is a hard
   break.** **Measured**: with standard decorators, importing a class-validator
   DTO throws `TypeError: undefined is not an object (evaluating
   'object.constructor')` at class-definition time — not a degradation, a
   crash. The repo is fine (`tsconfig.base.json:24-26`), but a consumer on
   TS 5+ standard decorators cannot use the DTO path at all. It must be a
   stated requirement, and it is the strongest argument for keeping Standard
   Schema the primary path. Secondary, smaller: `design:type` erases
   `string[]` to `Array` and optionality entirely (both **measured**), so
   `@IsString({ each: true })` and `@IsOptional()` remain mandatory; and
   `whitelist: true` does not strip undeclared properties from the instance
   (**measured**) — that needs `excludeExtraneousValues` + `@Expose()`.

1f. **Neither class-validator, class-transformer, `reflect-metadata` nor
   `@nestjs/swagger` may become a dependency or a declaration import.** All
   four are injected structurally (`useClassDtos`, `useSwaggerBridge`), which
   is what keeps `checkPeerScopes` (`scripts/build-declarations.ts:273`)
   quiet — the shipped `dts/` names only structural interfaces. The risk is
   drift: somebody later "simplifies" one into a real import and the
   declaration starts importing an undeclared package. The packaging test
   should assert the import graph of `lib/docs/**` and
   `bun-nest/lib/decorators.ts` directly, not rely on review.

1g. **`@Validate`'s error message is six lines where the router's is one.**
   **Measured**: a method whose return type matches no declared response fails
   with `TS1241: Unable to resolve signature of method decorator when called as
   an expression`, then four levels of `TypedPropertyDescriptor` nesting, with
   the useful line last. Correct, usable, ugly. Show it in the README.

1h. **A decorator cannot type a parameter, and no workaround exists.**
   **Measured**: `@ValidatedBody(CreateUserSchema) body: string` compiles with
   `body` still `string`. A parameter decorator's signature
   (`target, key, index`) has no type link to the parameter. The `Infer<typeof
   Schema>` helper is the answer and it is a genuine ergonomic cost — one
   `typeof` per parameter — that the README must show rather than gloss.
   **Open question:** is the decorator worth building for a team already happy
   with DTO classes and `ValidationPipe`? The honest pitch is the *response*
   half and the swagger bridge, not the request half. If phase (d) finds
   `@nestjs/swagger` + `ValidationPipe` already satisfying, phase (g) should be
   dropped rather than shipped for symmetry.

1i. **`@Validate` and a Nest `ValidationPipe` can both own a target.** The
   interceptor runs first, so the pipe sees the parsed value; for a DTO that
   is idempotent, but a `ValidationPipe({ transform: true })` over a
   zod-parsed `query` may re-coerce what is no longer a string map. The plan
   sets a `BUN_VALIDATED` marker so a future `BunValidationPipe` can no-op,
   but **does not build that pipe** — the documented rule is that the two
   should not both own a target. **Unverified**: the precise interceptor/pipe
   ordering claim comes from Nest's documented request lifecycle, not from a
   run.

2. **`@routejs/router` paths with no OpenAPI equivalent.** `toOpenApiPath`
   (`bun-jobs/lib/api/spec/openapi.ts`) already throws for `*`, `(` and `)` and
   for an optional `:name?`, and it is right to. In bun-common these must be
   **warnings, not throws**, because an arbitrary router will have them:

   | Path | Verdict |
   |---|---|
   | `/files/*name` | no OpenAPI form. Emit a warning; `strict` throws. A `{name}` template would be a lie — `*` matches `/` and a path parameter does not |
   | `/re/:id(\d+)` | **documentable**: `{id}` plus `schema: { type: "string", pattern: "^\\d+$" }` lifted from the path literal. A small win nobody else does |
   | `/opt/:a?` | OpenAPI path parameters are always `required: true`. Two options, both bad: emit two paths (`/opt` and `/opt/{a}`), or warn. **Recommend two paths**, since it is mechanical, with a flag to fall back to a warning |
   | `/slug/:a-:b` | **documentable** as `/slug/{a}-{b}` — legal OpenAPI, poorly supported by viewers. Warn |
   | `use()` middleware and `useMethod()` | never an operation; `isEndpoint` is false, so they are already excluded |

3. **Middleware-applied auth is undiscoverable.** A `use("/admin", requireAuth)`
   is a plain function; nothing says it authenticates, or how. The generator
   cannot infer `security` and must not guess. Mitigation: a
   `markSecurity(handler, requirement)` tagger — the same non-enumerable-property
   trick as `__schemas` — so `use("/admin", markSecurity(requireAuth, [{bearer:[]}]))`
   contributes to every operation under that prefix. The pipeline replay (§3, and
   below) already tells us *which* operations those are. **Open question:** is
   that worth the API surface, or is per-route `RouteDoc.security` enough?
   Leaning per-route for phase (a), tagger in phase (b) if asked for.

4. **The pipeline replay is a heuristic in one respect.** Discovering a route's
   validators by calling `getMatchedLayers()` on a synthesised concrete path is
   exactly right — it reuses the production matcher, so what the document says
   is what the pipeline does — and it is **measured** to work:

   ```
   POST /users/__id__/posts  →  [route 0 cb 0 (use mw), route 5 cb 0, route 5 cb 1]
   ```

   The heuristic is the **synthesised value**. `compilePathRegexpToPath` needs a
   value per param; `"1"` satisfies `[^/]+?` and most `(\d+)` constraints, but a
   path like `/:slug([a-z]+)` would not match its own synthesis. Mitigation:
   after synthesising, assert `route.pathRegexp.test(compiled)`; on failure, try
   a small ladder of candidates (`"1"`, `"a"`, `"00000000-0000-4000-8000-000000000000"`,
   a `%`-free UUID, `"x/y"` for wildcards) and warn if none match. **Measured**:
   `"1"`/`"x/y"` covered every path in the probe set, including
   `/re/:id(\d+)`, `/opt/:a?`, `/slug/:a-:b`, `/files/*` and `/{*rest}`.
   Secondary cost: `getMatchedLayers` populates the route cache
   (`DEFAULT_ROUTE_CACHE_MAX = 50_000`) with synthetic keys. Generate into a
   throwaway clone, or clear the cache after.

5. **Ordering and specificity decide which route "owns" a path.** With
   `routeSpecificity: false` (the default, Express behaviour) two matching
   handlers both run in registration order and the first to respond wins —
   which one that is depends on the handlers, not the table. OpenAPI has no
   notion of two operations on one `method + path`. Rule: **the first
   registered wins the `paths` entry; a later duplicate is a
   `ConfigError` in `strict` and a warning in `lenient`**, naming both. That
   matches bun-jobs (*"Two routes are registered for {method} {path}"*) and is
   the least surprising behaviour. Note that `routeSpecificity: true` changes
   *runtime* order without changing the document — a documented, accepted
   divergence.

6. **A `transform` hook silently changes what the handler sees.** `hooks.transform`
   replaces a target's value after validation, and its return type is the
   handler's type (`TargetResult`, `BunValidate.ts`). At runtime it is an
   opaque function. The document describes the **request** — which is correct
   for `query`/`body`/`params`, since transforms run server-side — so this is a
   documentation nuance, not a bug. Worth one sentence in the README. Similarly
   `replace: false` means the handler never sees the validated shape, but the
   request is still what the schema describes.

7. **Chained validators.** CLAUDE.md: *"each replaces `req.query` wholesale, so
   a sub-route's schema receives the mount's output"*. The generator sees both
   validators in the replayed pipeline. Rule: **the last validator for a target
   wins the document**, because it is what the handler actually receives.
   Warn when two validators write the same target, because the second's input
   type is the first's output and describing only the second may understate
   what the client may send.

8. **Mount params deliberately do not propagate into types.** They *do* appear
   in the flattened path (`/users/:id/posts`), so the document is right where
   the types are silent. A mount **validator**, though, is `use()` middleware
   and sees `{}` at runtime — so its `params` schema is meaningless and the
   generator must ignore `params` on a non-endpoint validator while still
   honouring its `query`/`body`. Easy to get wrong.

9. **Double-mounting a sub-router duplicates the documentation.** **Measured**:
   `root.use("/a", sub); root.use("/b", sub)` produces `/a/posts/:postId` and
   `/b/posts/:postId`, and the `WeakMap` is keyed on the shared handler, so both
   get the same `RouteDoc` — including the same `operationId`, which then
   collides. Mitigation: `operationId` must be **derived per path** by default
   and an explicit one must be suffixed or rejected on collision. Related
   existing hazard, worth reporting separately: a `setName`d route in a
   double-mounted sub-router throws `Route with name "x" already exists`.

10. **Bundle size if a converter reaches the browser.** The converters are the
    reason to keep the generator out of `lib/index.ts`. A browser viewer needs
    only the *document* and the *types*; the day one imports
    `@kingsleyweb/bun-common/lib/docs` for a type, a bundler that does not
    erase type-only imports pulls the generator, `refs`, and every converter.
    Mitigation: a `lib/docs/types.ts` with **no runtime exports**, its own
    `exports` key and a `"browser": true` consumer-check entry (§8.3), plus a
    bundle-safety test in the shape of bun-jobs-ui's
    `__tests__/app/pkg/bundle-safety.test.ts`: build a fixture importing only
    `lib/docs/types` and assert no server marker and no converter symbol lands
    in the output, with a negative control.

11. **Spec drift from hand-written docs.** README tables describing routes are
    exactly what bun-jobs' `readme-tables.test.ts` guards. If bun-common's
    README grows an options table for `RouteDoc`, it should be parsed and
    asserted the same way. Also note the existing obligation: bun-jobs-ui's
    README `### What each element needs` table is parsed by
    `examples/bun-jobs-ui/04-screens/permissions.ts` — a precedent, and a
    warning about how these tables acquire readers.

12. **`ConfigError` does not exist in bun-common.** bun-jobs throws its own
    (`lib/shared/errors`). The extraction needs one in bun-common, and bun-jobs'
    must stay `instanceof`-compatible or its tests break. Small, but it is a
    cross-package change and should be its own commit.

13. **`compilePathRegexpToPath` is undeclared in `@routejs/router`'s types.**
    It exists at runtime (`src/route.mjs`) but `index.d.ts` does not declare it,
    so using it needs a cast — and it could disappear in a `@routejs/router`
    minor. Mitigation: a tiny fallback that substitutes `:name` in the path
    literal ourselves, and a test that fails loudly if the method vanishes.

14. **`@valibot/to-json-schema` is not a declared dependency of this repo.** My
    measurements used **1.8.0** resolved through Bun's auto-install from the
    global cache (`~/.bun/install/cache/@valibot/to-json-schema@1.8.0@@@1`);
    `Bun.resolveSync` from `packages/bun-common` fails. For the converter test
    it must become a devDependency of bun-common, pinned, or the valibot test
    must skip visibly.

15. **`lib/types/standardSchema.ts` is a spec version behind.** It is a
    vendored copy of `@standard-schema/spec` 1.0.0; 1.1.0 added
    `StandardTypedV1`, `StandardJSONSchemaV1` and
    `StandardSchemaV1.Options { libraryOptions? }` (so `validate` takes a
    second argument). Updating it is a prerequisite for §4 and touches a type
    every validator in the repo is checked against — it should be its own
    commit, landed before the converter work, with the existing
    `bunValidate.libraries.type-test.ts` as the net.

16. **The companion spec standardises the interface, not the output.**
    standard-schema#147 is open and unanswered: vendors disagree on defaults
    and on whether `required` is emitted, and the `draft-07`/`draft-2020-12`
    targets pin no common feature subset. So §4.2's matrix does not go away
    just because step 2 of the resolution order usually succeeds — the
    agreement tests of §9.3 are what keep it honest. Related: zod **does not
    throw** on an unsupported target (measured), though the spec says it
    should, so a successful return is not proof the dialect was honoured.

17. **Unverified.** Stated plainly: (a) `SwaggerModule.setup()` has not been
    executed against `BunHttpAdapter` — the four-method surface is verified by
    reading `@nestjs/swagger@11.4.6`'s `dist/`, the behaviour is inferred;
    (b) whether Nest controller paths in `BunRouter.routes()` already carry
    `setGlobalPrefix`; (c) whether `@nestjs/swagger`'s scanner needs anything
    from `app.container` that bun-nest's adapter influences; (d) the OpenAPI
    3.1.2 / AsyncAPI 3.1.0 version facts in §9.1 are from research, not from a
    fetch I performed — re-check them against `spec.openapis.org` and
    `@asyncapi/specs` before vendoring; (e) TypeBox is widely claimed to ship
    `~standard` and reportedly does not (no `~standard` in either `typebox` or
    `@sinclair/typebox` published files) — it needs no converter anyway, since
    a `TSchema` *is* a JSON Schema, but the vendor string is unknown.

---

## 11. Phased delivery

Each phase is independently shippable and independently valuable. Estimates are
engineer-days for someone who wrote this code.

| Phase | Scope | Ships | Est. |
|---|---|---|---|
| **(a) Route metadata + manual annotation → OpenAPI** | `ConfigError` in bun-common; move `spec/refs.ts` and `spec/security.ts` from bun-jobs (re-export shims left behind); `lib/docs/` with `RouteDoc`, `.describe()`, the `WeakMap` keyed on the terminal callback, `DiscoveredRoute` discovery (`routes()` + pipeline replay), path→template with the wildcard/optional/regex rules of §10.2, the generator, `strict`/`lenient` + warnings; OAS 3.1 meta-schema test; golden fixture; type tests; `examples/bun-common/13-api-docs/annotating-routes.ts` | A working OpenAPI 3.1 document from any `BunRouter`, hand-annotated. **bun-jobs unaffected except for two import moves** | **6–8** |
| **(a2) `defineRoute`-style registrar** *(optional, same phase)* | A `routes([...])` helper over `.describe()` for people who prefer bun-jobs' shape | Ergonomics, no new capability | 1–2 |
| **(b0) Update the vendored spec types** | `lib/types/standardSchema.ts` → `@standard-schema/spec` 1.1.0: `StandardTypedV1`, `StandardJSONSchemaV1`, `StandardSchemaV1.Options`. Its own commit, before (b) | The type surface every validator is checked against, current | **0.5–1** |
| **(b) Standard Schema auto-derivation** | `__schemas` on the validator middleware; the `~standard.jsonSchema` primary path; the vendor registry; zod/arktype/yup/bun-jobs fallbacks; `valibotConverter(toJsonSchema)`; `withJsonSchema`; the `$defs`→`components` lift with recursion rewriting; the agreement tests of §9.3; `from-validators.ts` example | **The headline feature.** Existing validated routes document themselves | **4–6** |
| **(b1) Response contracts** | `responses` on `BunValidateOptions`; `BunResponse` gains `TResponses`, `status()` narrows, `json()` constrains, `protected setStatusRaw` (§3.7); `TypedRouteHandler`/`MountedHandler` thread `TRes`; runtime checking at response finalisation with bun-jobs' `responseMismatch` semantics (§3.5); `responses.type-test.ts` carrying the spike's four negative controls plus the `send()`/helper-escape boundary cases; `generate-verb-overloads.ts --check` must stay green; `consumer-check` re-run for the `BunResponse` surface change | Declared responses **enforced** at compile time and optionally at runtime. Feeds (a)'s document for free | **4–5** |
| **(b2) Class DTOs** | `useClassDtos` / `fromDto` (§3.6); widen the four `ValidationSchemas` keys and `RouteDoc.request.*` to `StandardSchemaV1 \| DtoClass`; a `"class-validator"` converter reading the injected `toJsonSchema`; class-validator + class-transformer as **devDependencies** of bun-common for the tests; an `experimentalDecorators`-off negative test proving the documented failure | DTO users reach both validation and the document | **2–3** |
| **(c) Serving and viewing** | `docsRouter()`; move `docs/html.ts` + `docs/cdn.ts` into `lib/docs/viewer.ts` parameterised; CSP/nonce/SRI tests copied from `api-docs.test.ts`; `serving-and-viewing.ts` example. bun-jobs keeps its own pins and routes | Documents served and browsable, off by default | **3–4** |
| **(d) bun-nest — verify `@nestjs/swagger`** | Execute `SwaggerModule.setup()` against `BunHttpAdapter` end-to-end; close the §8.6 gaps; `examples/bun-nest/07-openapi/swagger-module.ts`; README section covering the mixed-app caveat and the `@Render` note. Only if execution finds a hole: a `./lib/swagger` helper with `"peers"` | A documented, proven path. **Cheapest phase per unit of value** — and the phase that decides whether (g) is worth building | **2–3** |
| **(g) bun-nest `@Validate` decorator** | The interceptor (§3.8), following `interceptors.ts`'s mixin shape and reusing `transformUploadException`'s error mapping; method **and** class forms with per-target merge; return-type constraint via `TypedPropertyDescriptor`; `useSwaggerBridge` emitting `ApiBody`/`ApiQuery`/`ApiParam`/`ApiHeader`/`ApiResponse` from the §4 registry at `target: "openapi-3.0"`; the `Infer<>` helper; `decorators.ts` grows from one line to a real module; `consumer-check.json` entry; `examples/bun-nest/08-validate/` | One declaration for validation + response contract + document. **Gate on (d)** — see risk 1h | **5–7** |
| **(e) AsyncAPI 3.0** | Public WS route accessor on `BunWebSocket`; `WsChannelDoc` + `describeChannel()`; the bun-common generator (servers/channels/parameters/messages/operations); bun-nest's metadata explorer reading `MESSAGE_METADATA`/`GATEWAY_OPTIONS`/`PORT_METADATA` and the `MessageEventTypes` envelope; AsyncAPI 3.0 meta-schema test via `@asyncapi/specs`; examples | AsyncAPI for both adapters | **7–9** |
| **(f) Generic self-hosted viewer** *(deferred, separate decision)* | Extract `bun-jobs-ui/app/screens/docs/{schema,http}` into `@kingsleyweb/bun-api-docs-ui`; migrate bun-jobs-ui onto it; keep its golden WS fixtures as the net | An offline, CSP-strict viewer and one fewer fork | **10–14** |

**Why this order** (it differs from the suggested one in one place):

- (a) before (b) because (b) is worthless without a place to put the schemas,
  and because (a) alone already ships a document.
- (c) before (d) because a document nobody can look at gets no bug reports, and
  the viewer is copied code with existing tests.
- **(d) before (e)**, against the suggested ordering. (d) is two to three days
  and, on the evidence in §8.6, is mostly verification; (e) is the largest
  phase and needs a new declaration API. Doing the cheap, high-confidence one
  first means bun-nest users are served before the WS design is finished.
- (e) last because it is the only phase whose *design* is still open: whether
  outbound events are declared per-channel or per-emit, and whether bun-nest's
  socket.io envelope is described as the payload or peeled off, are both
  genuinely undecided.
- (f) is deliberately outside the sequence. It is a UI project with a package
  boundary and a bun-jobs-ui migration, and none of (a)–(e) needs it.
- **(b1) sits where it does because it is the enforcement half of (a)'s
  declaration half**, and because it is the one change touching a public type
  (`BunResponse`). Doing it immediately after (b), while the response design is
  fresh and before anything is built on the current `dts/`, is much cheaper
  than retrofitting it after (c)–(e) ship.
- **(b2) after (b1), not before**, because `responses` must accept a DTO on the
  day DTOs land, and widening `ValidationSchemas` once is cheaper than twice.
- **(g) is gated on (d)**, deliberately. (d) will show whether `@nestjs/swagger`
  plus a `ValidationPipe` already covers what a bun-nest user wants. If it
  does, (g) should be dropped, not shipped for symmetry — risk 1h. If (g) is
  built, it must come after (b1)/(b2)/(d) because it is a thin shell over all
  three: the interceptor is `BunValidate` plus Nest wiring, and the swagger
  bridge is §4's registry plus a dialect argument.

**Revised total** for the enforcement work the maintainer asked for — (b1) +
(b2) + (g) — is **11–15 days**, of which (g) is the half most likely to be cut.
(b1) is the one I would ship regardless: it is the only item here that is both
fully spiked and independently valuable without any of the others.

**Suggested first commit**, if only one thing is done: the `__schemas` property
on `BunValidate`'s middleware. Three lines, no API surface, no behaviour change,
and it is the prerequisite for the only part of this plan that is genuinely
automatic.

---

## Appendix: evidence

The feasibility claims in §3.6–§3.8 were spiked, not reasoned about. The spikes
are in [`evidence/api-docs/`](evidence/api-docs/), with a README explaining
which run standalone and which need a copy of `bun-common` carrying the §3.7
changes.

They settle four things that could not be settled by reading: a chained
`.describe()` **cannot** constrain a handler already passed to `.get()`; Bun
**does** honour `emitDecoratorMetadata`; the full class-validator plus
class-transformer stack works under Bun; and a Nest method decorator can
constrain a return type but **cannot** retype a parameter.

The pass condition for the patched-library set is `tsc -p` exiting **0**, which
proves both halves at once — an unsatisfied `@ts-expect-error` is itself an
error, so a clean run means the library compiles *and* every negative control
fires. If you edit these, keep the controls; a green run without them proves
nothing.
