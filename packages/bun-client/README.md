# @kingsleyweb/bun-client

A typed HTTP client for the bun-node servers, with no dependencies. Each verb
takes the server's own path literal (`api.get("/users/:id", …)`), so a search
finds both ends. The params, query and body are typed from a route map, and a
call returns a result discriminated by status. It also has named operations
(`api.op.getUser(…)`), retries with backoff and `Retry-After`, timeouts,
middleware, and an auth refresh that runs once for any number of concurrent
401s. It runs in browsers: the entry imports nothing, and a browser bundle of
it is 4.2 KiB gzipped.

This is the core of the typed-client plan
([`docs/plans/typed-client/`](../../docs/plans/typed-client/README.md), PR-C1)
and its generator (PR-C2): `bun-client generate` writes the route map from
the server's OpenAPI document ([below](#generating-the-map-bun-client-generate)).
The watcher, validation, the query layer and the other transports come in
later PRs (the plan's §15).

Requires Bun ≥ 1.4.2 on a server; any browser with `fetch` and
`AbortSignal.any`.

## Usage

```ts
import { createClient } from "@kingsleyweb/bun-client";
import type { Routes } from "./api"; // the route map: below

const api = createClient<Routes>({ baseUrl: "/api" });

const r = await api.get("/users/:id", {
  params: { id: "42" },
  query: { expand: ["org"] },
});
if (r.ok) r.data.name;                     // the 2xx members
else if (r.status === 404) r.error.code;   // "NOT_FOUND"

await api.post("/users", { body: { name, email } });
await api.request("PATCH /users/:id", { params, body });   // the key form, for a method chosen at run time
api.url("/users/:id", { params: { id: "42" } });           // "/api/users/42": sends nothing
await api.op.getUser({ params: { id: "42" } });            // by operationId (needs the manifest)
```

## The route map

The map is flat, with one entry per route, keyed `"VERB /path"` the way the
server writes the route. Each entry is the **wire** side: what is sent (each
field's input, so a coerced query value may be a string) and what comes back.
Response bodies are read through `Jsonify`, so a `Date` field arrives typed as
`string`.

```ts
export interface Routes {
  "GET /users/:id": {
    operationId: "getUser";
    params: { id: string };
    query: { expand?: string[] };
    body: undefined;
    responses: { 200: User; 404: Problem<"NOT_FOUND"> };
  };
}
```

There are three ways to get one:

- **Generate it** from the server's OpenAPI document with `bun-client
  generate` (the default, plan §3.4): [below](#generating-the-map-bun-client-generate).
- **Infer it** from a `defineRoutes` registry with bun-common's `RoutesOf`:
  `createClient<RoutesOf<typeof users>>()`. The client reads its `send` and
  `receive` views (PR-M1), the same wire side the generator writes; a test
  holds the two equal for a fixture app.
- **Write it by hand**, in the shape above. `query: Record<never, never>`
  declares no query (any key is then an error), and `body: undefined` declares
  no body. A part left out is undeclared, and loosely typed.

### The manifest

Types do not exist at run time, so two facts need a small object beside the
map: each route's `operationId`, for `api.op`, and its declared statuses, for
`undeclaredStatus`. The generator writes it beside the map. A hand-written
one is checked against the map:

```ts
const manifest = {
  "GET /users/:id": { operationId: "getUser", statuses: [200, 404] },
} as const satisfies RouteManifest<Routes>;

const api = createClient<Routes>({ manifest });
```

If a route has no manifest entry, every status it answers is returned as
declared.

## Generating the map: `bun-client generate`

The generator reads an OpenAPI 3.1 document (3.0's `nullable` is read too)
and writes a TypeScript module: the `Routes` map, every component schema as a
named type, and the `manifest`. Commit the file, and check it in CI (plan
§3.4, Q9).

```bash
# from a running server: a URL serving the document, or the dev endpoint's { hash, openapi, asyncapi }
bunx bun-client generate --url http://127.0.0.1:3000/__bun/types --out src/api.gen.ts
# from files: JSON, or YAML by extension; the AsyncAPI document joins the hash
bunx bun-client generate --openapi ./openapi.json [--asyncapi ./asyncapi.json] --out src/api.gen.ts
# in process, no server running: a router (documented with bun-common's generateOpenApi), a document, or a function returning one
bunx bun-client generate --module ./server/app.ts [--export app] --out src/api.gen.ts
# CI: write nothing, exit 1 when the file is stale
bunx bun-client generate --module ./server/app.ts --export app --out src/api.gen.ts --check
```

```ts
import { createClient } from "@kingsleyweb/bun-client";
import { manifest, type Routes } from "./api.gen";

const api = createClient<Routes>({ baseUrl: "/api", manifest });
```

| Flag | What it does |
| --- | --- |
| `--url <url>` | fetches the document (JSON or YAML), or `{ hash, openapi, asyncapi }` |
| `--openapi <file>`, `--asyncapi <file>` | reads the documents from files; the AsyncAPI one only joins the hash until the channel map exists (PR-W2) |
| `--module <path>`, `--export <name>` | imports the module and reads the export (default `default`): a router or adapter, an OpenAPI document, a `generateOpenApi` result, `{ openapi, asyncapi }`, an object with a `router`, or a function returning one. A router is documented as `{ title: "API", version: "1" }`, with bun-common resolved from the module's own directory (an optional peer) |
| `--out <file>` | where to write; without it, the module goes to stdout. A file whose content would not change is not rewritten, and a write is atomic |
| `--check` | writes nothing; exits `1` when `--out` is missing or differs from what would be written |

Exit status: `0` written (or fresh), `1` stale under `--check`, `2` a usage
error or a source that could not be read. `watch` (PR-C3) and `--zod` (PR-C4)
are not built yet and say so.

### What it writes

```ts
/**
 * Generated by `bun-client generate` … typesHash: 3dcc0f6a50e0371c
 *
 * Warnings:
 * - GET /api/health: no response is declared; typed `{ 200: unknown }`
 */
import type { RouteManifest } from "@kingsleyweb/bun-client";

export interface User {
  id: string;
  /** The display name. */
  name: string;
  role: Role;
}

export type Role = "admin" | "member";

export interface Routes {
  /** Read one user */
  "GET /api/users/:id": {
    operationId: "getUser";
    params: {
      id: string;
    };
    query: {
      page?: number;
    };
    headers: {
      "x-tenant": string;
    };
    body: undefined;
    responses: {
      200: User;
      404: Omit<Problem, "code"> & {
        code: "NOT_FOUND" | "GONE";
      };
    };
    cache: {
      tags: ["user:{id}"];
    };
  };
}

export const manifest = {
  "GET /api/users/:id": { operationId: "getUser", statuses: [200, 404] },
} as const satisfies RouteManifest<Routes>;
```

- **Keys** are the operation's `x-bun-route-key` (bun-common writes the
  route's own Express path, `"GET /users/:id"`), else the OpenAPI path with
  `{id}` as `:id`. An optional param that bun-common documents as two paths is
  one entry, the param optional. `params` comes from the key's own params,
  typed by the documented path parameters; a wildcard is a `string[]`.
- **The wire side** (plan §4.1): the documents' schemas are already what
  crosses, so `query` has a defaulted key optional and a coerced one at its
  output type, and a response is what the handler sent.
- **`x-bun-errors`** narrows the `code` of every declared error body that has
  one: `Omit<Problem, "code"> & { code: "NOT_FOUND" | "GONE" }`, or the inline
  object's own `code`, member by member for a `oneOf`.
- **`x-bun-cache`** becomes `cache: { tags; invalidates }`, as literal tuples,
  for the query layer (PR-C5).
- **Server-sent events**: a 2xx served as `text/event-stream` or carrying
  `x-sse-events` reads no body through the HTTP call (`undefined`); the entry
  is marked `stream: "sse"` and its `events` are typed by name, for `sse()`
  (PR-S1).
- **Bodies by media type**: JSON as its schema; `multipart/form-data` as
  `FormData` and `application/x-www-form-urlencoded` as `URLSearchParams`
  (typed fields come with PR-C9); anything else as
  `Blob | ArrayBuffer | ReadableStream<Uint8Array>`. Responses: JSON as its
  schema, `text/*` as `string`, anything else as `Blob`.
- **Deterministic and formatted**: routes sorted by path then method,
  components by name, statuses numerically, events by name; properties keep
  the document's order. The output is laid out as Prettier lays it out, so
  `bun fmt` and Prettier leave it unchanged.
- **The header** records the documents' hash (bun-common's `typesHash`), and
  every warning.

### JSON Schema to TypeScript

| JSON Schema | TypeScript |
| --- | --- |
| `$ref: "#/components/schemas/User"` | `User`, a named type; a recursive schema recurses through its name |
| another local `$ref` (`#/components/schemas/A/properties/b`) | the target, inlined; one that leads back into itself is `unknown`, with a warning |
| a component | `export interface` for an object, `export type` otherwise; a name that is not an identifier is PascalCased (`user-profile` → `UserProfile`), a reserved one gains `Schema` (`Record` → `RecordSchema`) |
| `type: string`, `integer`/`number`, `boolean`, `null` | `string`, `number`, `boolean`, `null` |
| `type: [a, b]`, or `nullable: true` (3.0) | `A \| B`, `T \| null` |
| `enum`, `const` | a union of literals, a literal |
| `properties` with `required` | an object, optional keys with `?`; a `required` key with no schema is `unknown` |
| `additionalProperties`/`patternProperties` | `Record<string, T>`; beside properties, an index signature admitting theirs too |
| `additionalProperties: false`, alone | `Record<string, never>` |
| `type: object`, alone | `Record<string, unknown>` |
| `items` | `T[]`; none is `unknown[]` |
| `prefixItems` (or 3.0's array `items`) | a tuple, `[A, B]`, with `...T[]` for further `items` |
| `oneOf`, `anyOf` | a union |
| `allOf` | an intersection |
| `{}`, `true` | `unknown` |
| `false`, `not: {}` | `never` |
| `not`, `if`/`then`/`else`, `dependentSchemas`, `unevaluatedProperties`, `unevaluatedItems`, `$dynamicRef` | `unknown`, **with a warning**: never a type that is silently wrong |
| a `$ref` outside the document, or that does not resolve | `unknown`, with a warning |
| lengths, ranges, `pattern`, `format`, `multipleOf`, `uniqueItems`, `contains`, `dependentRequired`, `propertyNames` | nothing: they validate, they do not type |
| `description`, `deprecated` | JSDoc |

A `default` response and a status range (`2XX`) are not typed, with a
warning; a status the route does not declare goes to `undeclaredStatus`. A
route that declares no response at all is `{ 200: unknown }`, with a warning.
A `z.date()` has no JSON Schema, so bun-common documents it as `{}` and it
arrives `unknown` (plan §5.3): declare a wire type such as `z.iso.datetime()`.

### From code

`@kingsleyweb/bun-client/codegen` exports the same steps (Bun only, never in
a browser bundle):

```ts
import { generateRoutes, loadDocuments } from "@kingsleyweb/bun-client/codegen";

const { openapi, asyncapi, warnings } = await loadDocuments({ module: "./server/app.ts" });
const { code, hash } = generateRoutes(openapi, { asyncapi, documentWarnings: warnings });
```

`runCli(argv)` is the command itself, and `documentsHash` the header's hash.

## Results and errors

| What happened | Default | With `throwOnError: true` |
| --- | --- | --- |
| A declared 2xx | `{ ok: true, status, data, response }` | `data` |
| A declared error status | `{ ok: false, status, error, response }` | throws `HttpError` (`status`, `error`, `response`) |
| A status the manifest does not list | throws `UnexpectedStatusError` (body unread); with `undeclaredStatus: "result"`, `{ ok: false, status: number, error: unknown }` | throws `UnexpectedStatusError` |
| `fetch` failed | throws `NetworkError` (after the retries) | the same |
| `timeout` ran out | throws `TimeoutError` | the same |
| The caller's `signal` aborted | rejects with the signal's reason (the platform's `AbortError` by default) | the same |

Every error the client raises extends `ClientError`, which carries the route
`key`. Bodies are read by content type: JSON is parsed; text is read as a
string; no body gives `undefined`; `text/event-stream` is left unread on
`response.body`; anything else becomes a `Blob`. A body typed `Blob` stays a
`Blob` in the result's type; everything else is read through `Jsonify`.

`throwOnError` and `undeclaredStatus` change a call's return type, so when the
client sets them, its second type argument says so too. The configuration and
the type are checked against each other:

```ts
const strict = createClient<Routes, { throwOnError: true }>({ throwOnError: true });
const user = await strict.get("/users/:id", { params: { id: "1" } });  // the User itself
```

A call can also set either option for itself (`{ throwOnError: true }`), and
its type follows.

## Configuration

Settings come from three levels: the client, `routes[key]` and the call. A
later level wins.

| Option | Default | Levels | How the levels combine |
| --- | --- | --- | --- |
| `baseUrl` | `""` | client | |
| `fetch` | `globalThis.fetch` | client | Pass `(r) => router.fetch(r)` to run in process. Outside a browser, a relative URL needs a custom fetch (it resolves against `http://localhost`) or an absolute `baseUrl`. |
| `headers` | none | all three | merged by name, last wins; a function is called per request with the request context |
| `credentials` | `"same-origin"` | client | |
| `timeout` | `30_000` ms; `false` for none | all three | last wins; covers retries and their waits |
| `retry` | below; `false` for none | all three | merged per key; `false` turns it off, and an object at a later level turns it back on over the defaults |
| `throwOnError` | `false` | client, call | last wins |
| `undeclaredStatus` | `"throw"` | client, call | last wins |
| `middleware` | none | all three | concatenated: client outermost, then route, then call |
| `auth` | none | client | |
| `logger` | `console` | client | retry notes go to `debug` |
| `manifest` | none | client | |

### Retries

| `retry` key | Default |
| --- | --- |
| `attempts` | `2` (after the first) |
| `methods` | `GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE` |
| `on` | `408`, `429`, `500`, `502`, `503`, `504`, `"network"` |
| `baseMs`, `maxMs`, `jitter` | `300`, `10_000`, `0.5`: the delay doubles from `baseMs`, is capped at `maxMs`, then moves by ±`jitter` of itself (bun-common's `computeBackoff`, `"exponential"`) |
| `respectRetryAfter` | `true`: a `Retry-After` (seconds or a date) sets the wait, capped at `maxMs` |

A streamed request body is sent once and never retried.

### Middleware

```ts
const tracing: ClientMiddleware = async (ctx, next) => {
  ctx.request.headers.set("traceparent", newTraceparent());
  const response = await next();
  log(ctx.key, response.status);
  return response;
};
```

A middleware runs once per attempt. It sees `key`, `method`, `path`,
`options`, `attempt` and the `request`, which it may change or replace. It may
also return a `Response` without calling `next()`, to mock a route or answer
from a cache.

### Auth

```ts
createClient<Routes>({
  auth: {
    token: () => store.accessToken,          // read per request; sent as Authorization: Bearer …
    refresh: async () => (await renew()).accessToken,
    on: [401],                               // the default
  },
});
```

When a request fails with a status in `on`, the client runs `refresh()` once,
however many requests are failing at the same moment. Each failed request is
then sent once more with the new token. A second failure is returned as the
result.

What `refresh()` returns decides the next step:

- **a string**: it becomes the token;
- **`undefined`**: `token` is read again;
- **`null`**: there is no new token, and the failure is returned as it is.

If `refresh()` throws, every waiting call rejects with its error. An
`Authorization` header that a call sets itself is never replaced.

## The query string

The query is written so that bun-common's parser reads it back unchanged
(picoquery with `nestingSyntax: "js"` and `arrayRepeat: true`):

- **Objects** nest with dots: `a.b=1`.
- **Arrays of two or more scalars** repeat the key: `t=x&t=y`.
- **Any other array** is indexed (`t[0]=x`), so a one-element array, or an
  array of objects, still arrives as an array.
- **`null` and `undefined`** are skipped.
- **Keys** are percent-encoded, `.` included.

Every value reaches the server as a string, and the server's schema coerces
it. One shape cannot travel: a key containing `[` or `]` arrives nested,
because bun-common decodes encoded brackets before it parses.

## Packaging

`lib/` ships as TypeScript source with built declarations in `dts/`, as every
package in this repo does. The client has no runtime dependency. The
generator is `./codegen` (Bun only) and the `bun-client` bin.
`@kingsleyweb/bun-common` is an optional peer, needed only by `generate
--module` on a router, and a dev dependency for the tests: the query round
trip, the shared backoff vector, the `RoutesOf` types and the generator's
parity with them.
