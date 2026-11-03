# @kingsleyweb/bun-client

A typed HTTP client for the bun-node servers. Each verb
takes the server's own path literal (`api.get("/users/:id", …)`), so a search
finds both ends. The params, query and body are typed from a route map, and a
call returns a result discriminated by status. It also has named operations
(`api.op.getUser(…)`), retries with backoff and `Retry-After`, timeouts,
middleware, an auth refresh that runs once for any number of concurrent
401s, and validation of what it sends and receives
([below](#validation)), on in development and off in production. Bodies
beyond JSON are typed too: multipart uploads with their files, forms,
downloads and NDJSON or raw streams ([below](#bodies-beyond-json)). It runs
in browsers: a browser bundle of the entry is 4.9 KiB gzipped, and the
checks (bun-contract's guards, its one dependency) and the code for those
bodies load only when a call needs them.

This is the core of the typed-client plan
([`docs/plans/typed-client/`](../../docs/plans/typed-client/README.md), PR-C1)
its generator (PR-C2), its watcher (PR-C3), validation (PR-C4), the query
layer (PR-C5), the React binding (PR-C6), persistence (PR-C8) and bodies
(PR-C9): `bun-client generate` writes the route map from the server's
OpenAPI document ([below](#generating-the-map-bun-client-generate)), with its
zod schemas beside it on request, `bun-client watch` keeps both in step with
a running dev server ([below](#keeping-it-in-step-bun-client-watch)), and
`./query` puts the routes on TanStack's `@tanstack/query-core`, with cache
tags, `ETag` revalidation and optimistic updates
([below](#the-query-layer-query)), and `./react` gives React components
typed hooks over it ([below](#react-react)), and `./persist` keeps the
query cache in IndexedDB across page loads, dropped when the server's
schemas change ([below](#persistence-persist)). The other framework bindings
and transports come in later PRs (the plan's §15).

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

Types do not exist at run time, so a few facts need a small object beside
the map: each route's `operationId`, for `api.op`, its declared statuses, for
`undeclaredStatus`, its cache tags, for the query layer
([below](#the-query-layer-query)), and how its bodies travel (`bodyType`
and `chunks`, [below](#bodies-beyond-json)). The generator writes it beside the map. A
hand-written one is checked against the map:

```ts
const manifest = {
  "GET /users/:id": {
    operationId: "getUser",
    statuses: [200, 404],
    cache: { tags: ["user:{id}"] },
  },
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
# the runtime zod schemas beside the map, for validation (zod/mini; --zod-flavour classic for zod)
bunx bun-client generate --module ./server/app.ts --out src/api.gen.ts --zod src/api.zod.gen.ts
```

```ts
import { createClient } from "@kingsleyweb/bun-client";
import { manifest, type Routes } from "./api.gen";

const api = createClient<Routes>({ baseUrl: "/api", manifest });
```

| Flag | What it does |
| --- | --- |
| `--url <url>` | fetches the document (JSON or YAML), or `{ hash, openapi, asyncapi }`. A dev endpoint gets the bearer token of the [token file](#the-token-file) naming it |
| `--token-file <path>` | with `--url`: the token file, or a directory of them, to read instead of the nearest `node_modules/.cache/bun-types` |
| `--openapi <file>`, `--asyncapi <file>` | reads the documents from files; the AsyncAPI one only joins the hash until the channel map exists (PR-W2) |
| `--module <path>`, `--export <name>` | imports the module and reads the export (default `default`): a router or adapter, an OpenAPI document, a `generateOpenApi` result, `{ openapi, asyncapi }`, an object with a `router`, or a function returning one. A router is documented as `{ title: "API", version: "1" }`, with bun-common resolved from the module's own directory (an optional peer) |
| `--out <file>` | where to write; without it, the module goes to stdout. A file whose content would not change is not rewritten, and a write is atomic |
| `--check` | writes nothing; exits `1` when `--out` (or `--zod`'s file) is missing or differs from what would be written |
| `--zod <file>` | also writes the [zod module](#the-generated-zod-module-zod) there (needs `--out`, which it imports `Routes` from) |
| `--zod-flavour <f>` | `mini` (`zod/mini`, the default) or `classic` (`zod`) |

Exit status: `0` written (or fresh), `1` stale under `--check`, `2` a usage
error or a source that could not be read.

### Keeping it in step: `bun-client watch`

In development, run the server with bun-common's `devTypes()` mounted (plan
§3.3) and leave the watcher running beside it:

```ts
// server: the documents at /__bun/types, a change channel at /__bun/types/ws, and a token file
import { devTypes } from "@kingsleyweb/bun-common/lib/docs";

app.use(devTypes(app, { enabled: process.env.NODE_ENV !== "production" }));
```

```bash
bunx bun-client watch --out src/api.gen.ts                                 # the only dev server running
bunx bun-client watch --out src/api.gen.ts --url http://localhost:3000     # one of several
```

```
bun-client watch: wrote src/api.gen.ts (typesHash 662cf4320039a0b5, 16 ms)
bun-client watch: following http://127.0.0.1:3000/__bun/types (token file …/node_modules/.cache/bun-types/3000.json)
bun-client watch: wrote src/api.gen.ts (typesHash 5fe8467b9825878f, 2 ms)
```

- **It finds the server through its token file**, read again on every
  (re)connection, so a restarted server's new token and port are picked up.
  With one server running it follows that one; with several it exits `2`
  naming them, and `--url` (the endpoint, or just the origin) picks one.
  Before any server is up it waits, and says so.
- **It regenerates through the same step as `generate`**: on start, and
  whenever the channel announces a hash (`hello` on connect, `changed` on a
  change) other than the one in the file's header. A route added at run time
  counts, as does a `--hot` re-evaluation or a `--watch` restart. The write is
  atomic (a temporary file renamed over the old one) and happens only when
  the content changed, so an unchanged file keeps its modification time. One
  line per regeneration gives the hash and the time it took.
- **It survives restarts**: when the channel closes it reconnects after
  50 ms, doubling to 2 s (the backoff restarts once a channel opens).
- **A refused token is logged**, once per token file, and retried: a stale
  file left by a killed server, or a server that is not a `devTypes()`
  endpoint. A token file whose `pid` is no longer running is skipped.
- **Ctrl-C (SIGINT) or SIGTERM stops it**, exit `0`. `runCli` takes a
  `signal` instead when it runs in process.

From saving a route's file to the generated file holding the change,
measured with this watcher and `devTypes()` (median / p90,
[`evidence/watch/`](../../docs/plans/typed-client/evidence/watch/README.md)):
**170 / 178 ms under `bun --watch`**, **139 / 146 ms under `bun --hot`**; the
watcher's own fetch and write take 1–14 ms. A `BunHttpAdapter` app runs under
`bun --watch` until the adapter survives a `bun --hot` re-evaluation (a
follow-up).

| Flag | What it does |
| --- | --- |
| `--out <file>` | the file to keep generated (required) |
| `--url <url>` | the server to follow, when several run: its endpoint or origin |
| `--token-file <path>` | a token file, or a directory of them, instead of the nearest `node_modules/.cache/bun-types` (a server run from another directory, or a custom `devTypes({ tokenFile })`) |
| `--zod <file>`, `--zod-flavour <f>` | keeps the zod module in step too, as `generate` writes it |

#### The token file

`devTypes()` writes `{ url, ws, token, pid }`, mode `0600`, to
`node_modules/.cache/bun-types/<port>.json` under the server's working
directory once it listens, and removes it on close and at exit. Both
commands read the nearest such directory from their own working directory
up, so a command run in a subdirectory of the server's project finds it. The
token goes only to that server's endpoint (`--url`'s scheme, port and host,
the loopback names counting as one, and a path at or under the endpoint's),
never to the app's other routes, and `generate --url` with any other URL
sends none. A refused token makes `generate` exit `2` naming the file.

### What it writes

```ts
/**
 * Generated by `bun-client generate` … typesHash: 3dcc0f6a50e0371c
 *
 * Warnings:
 * - GET /api/health: no response is declared; typed `{ 200: unknown }`
 */
import type { RouteManifest } from "@kingsleyweb/bun-client";

/**
 * The documents' hash, as the header records it: the `buster` of a
 * persisted query cache (`@kingsleyweb/bun-client/persist`).
 */
export const typesHash = "3dcc0f6a50e0371c";

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
- **Response headers** (`responses.<status>.headers`) become
  `responseHeaders: { 200: { "x-total-count": string } }`, by lower-case
  name, optional unless `required`; a header whose schema is not a string's
  is typed `string`, since that is what arrives. `Content-Type` and
  `Set-Cookie` are left out. Read them from `r.response.headers`; the
  client checks them (below).
- **`x-bun-cache`** becomes `cache: { tags; invalidates }`, as literal tuples,
  in the entry and in the manifest, for the query layer
  ([below](#the-query-layer-query)).
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
  every warning. The module exports the same hash as `typesHash`, the
  `buster` of a persisted cache ([below](#persistence-persist)).

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
From `--module` the header says where ([below](#the-generated-zod-module-zod)).

### From code

`@kingsleyweb/bun-client/codegen` exports the same steps (Bun only, never in
a browser bundle):

```ts
import { generateRoutes, loadDocuments } from "@kingsleyweb/bun-client/codegen";

const { openapi, asyncapi, warnings } = await loadDocuments({ module: "./server/app.ts" });
const { code, hash } = generateRoutes(openapi, { asyncapi, documentWarnings: warnings });
```

`runCli(argv, io)` is the command itself (`io.signal` stops `watch`), and
`documentsHash` the header's hash.

## Results and errors

| What happened | Default | With `throwOnError: true` |
| --- | --- | --- |
| A declared 2xx | `{ ok: true, status, data, response }` | `data` |
| A declared error status | `{ ok: false, status, error, response }` | throws `HttpError` (`status`, `error`, `response`) |
| A status the manifest does not list | throws `UnexpectedStatusError` (body unread); with `undeclaredStatus: "result"`, `{ ok: false, status: number, error: unknown }` | throws `UnexpectedStatusError` |
| `fetch` failed | throws `NetworkError` (after the retries) | the same |
| `timeout` ran out | throws `TimeoutError` | the same |
| A request part fails validation | throws `ValidationError` before sending ([below](#validation)) | the same |
| A response fails validation | logs a warning and returns the body as it arrived; under `onFailure: "throw"`, throws `ValidationError` | the same |
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
| `logger` | `console` | client | retry notes go to `debug`, validation warnings to `warn` |
| `manifest` | none | client | |
| `mode` | `"production"` when `process.env.NODE_ENV` is, else `"development"` | client | chooses validation's defaults |
| `schemas` | none | client | the built-in schemas, loaded on first use ([below](#where-the-schemas-come-from)) |
| `validate` | on in development, off in production | all three | merged per key; `false` turns it all off, BYO schemas included, until a later level turns it back on ([below](#configuring-it)) |

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

## Validation

The client checks what it sends before it sends it, and what it receives when
it arrives (plan §5), through the very guards the server runs
(`createSender` and `createReceiver` from `@kingsleyweb/bun-contract`). Issue
paths, value-free messages and prototype-key stripping therefore agree on
both sides.

| | Default | A failure |
| --- | --- | --- |
| The request: `params`, `query`, `body` (before they are serialised), `headers` (as sent, on the first attempt) | **on in development, off in production** | **throws** `ValidationError`; nothing is sent |
| The response, by status: its body, and the headers it declares | **on in development, off in production** | **warns** through `logger` and returns the body as it arrived |

Development is `process.env.NODE_ENV !== "production"`, written out so a
bundler's define replaces it (in a browser with no define, development);
`mode` overrides it. The checks live in their own module, loaded with
`import()` only when a call has something to check: a production client that
configures nothing loads neither them nor the schemas, and a splitting
bundler puts them in a chunk of their own (6.3 KiB gzipped,
`__tests__/budget.test.ts`).

### Where the schemas come from

`schemas` is the built-in source: a module exporting `schemas`, one entry per
route key, given as a function so it loads on first use.

```ts
import { createClient } from "@kingsleyweb/bun-client";
import { manifest, type Routes } from "./api.gen";

const api = createClient<Routes>({
  manifest,
  schemas: () => import("./api.zod.gen"),   // generated: bun-client generate --zod
});
```

| Layout | The schemas | When |
| --- | --- | --- |
| Separate repos, or schemas that are not browser-safe | the generated zod module ([below](#the-generated-zod-module-zod)) | always: it is made from the OpenAPI document |
| A monorepo whose schemas live in a browser-safe module | **the server's own schemas**: a module exporting `schemas` built from them, `satisfies SchemaSource<Routes>["schemas"]` (any Standard Schema: zod, valibot, arktype, …) | the module imports no server code (no `node:*`, no drivers, no bun-common runtime) |

The second row loses nothing to JSON Schema: a `.refine()` the generated
module cannot carry (below) runs on the client too. A schema declared inline
in a route file drags the route file, and the server, into the browser, so
keep them in their own module and check it in the app's tests:

```ts
const result = await Bun.build({ entrypoints: ["./shared/schemas.ts"], target: "browser" });
const code = (await Promise.all(result.outputs.map((o) => o.text()))).join("");
expect(result.success).toBe(true);
expect(code).not.toMatch(/["'](?:node|bun):|\bBun\.\w+|BunRouter/);
```

Remember the wire: a response schema with `z.date()` refuses the string a
`Date` becomes in JSON, so declare wire types (`z.iso.datetime()`).

An entry may also give `responseHeaders`, one schema per status for the
headers it declares: an object of them as they arrived, by lower-case name,
each a string (a repeated header joined with `", "`). They are checked under
the status's switch and failure mode, in the same `ValidationError` as its
body (the headers' issues first, `target: "headers"`), and alone when the
body is left unread (a stream, a download `as: "stream"`). In a browser, a
cross-origin response shows a page only the headers its
`Access-Control-Expose-Headers` names, and never `Set-Cookie`: a required
header it hides reads as missing.

### Configuring it

`validate` takes the same shape at every level (`createClient`,
`routes[key]`, the call), merged per key, a later level winning:

```ts
createClient<Routes>({
  schemas: () => import("./api.zod.gen"),
  validate: { onFailure: { response: "throw" } },          // every route
  routes: {
    "POST /payments": { validate: { response: true } },     // checked in production too
    "GET /feed": { validate: { response: false } },         // a hot list: never
  },
});
await api.get("/feed", { validate: false });                // this call: nothing at all
```

| Key | What it does |
| --- | --- |
| `request` | every request part at once: `true` runs their built-in schemas, `false` turns them off (BYO included) |
| `params`, `query`, `body`, `headers` | one part: `true`, `false`, or `{ enabled, custom, replace }` |
| `response` | `true`/`false` for every status, or `{ [status]: true \| false \| { enabled, custom, replace } }`; covers the status's body and its declared headers |
| `onFailure` | `"throw"`, `"warn"`, or a hook `(error) => void` (it may throw), for both directions or `{ request, response }`; default `{ request: "throw", response: "warn" }` |

A `false` anywhere turns off everything under it, BYO schemas included, until
a later level turns it back on.

### Bring your own

Any Standard Schema (zod, valibot, arktype, yup, or an object with a
`~standard.validate` of your own) runs **after** the built-in one, per part
and per status:

```ts
createClient<Routes>({
  schemas: () => import("./api.zod.gen"),
  routes: {
    "POST /users": {
      validate: {
        body: { custom: SignupRules },                                // after the built-in body schema
        response: { 201: { custom: UserWithDates, replace: true } },  // instead of the built-in 201 schema
      },
    },
  },
});
```

- It receives the built-in schema's output when that passed, and the value
  as it was when it failed, so both run and **every issue is reported at
  once**, the built-in ones first.
- `replace: true` runs it alone for that part. On a response it replaces
  the built-in body schema; the status's declared headers are still checked.
  A response's BYO schema checks the body only.
- What it returns is what is sent (a request part) or delivered (a
  response): a transform applies. Headers are checked, never transformed.
- **Set on the call, it types the result** (plan §5.4): a status whose
  `custom` the call's `validate.response` sets has its `data` (or `error`)
  typed as the schema's output; a streamed status yields the outputs. Set on
  the client or a route, it still runs, but the type stays the route map's
  (`createClient<Routes>()` names its types, so it cannot infer them from the
  configuration):

  ```ts
  const r = await api.get("/events/:id", {
    params: { id },
    validate: { response: { 200: { custom: EventWithDate } } },
  });
  if (r.ok) r.data.at.getTime();      // a Date, as EventWithDate's output
  ```

  The type holds when the check passes. Under `"warn"` (the response
  default), or a hook that returns, a failed check delivers the body as it
  arrived, so a call whose BYO schema transforms is safest with
  `onFailure: { response: "throw" }`.
- A part's `custom` runs whatever the mode (it was asked for), unless a
  `false` turns the part off; a call's replaces the route's.

### `ValidationError`

```ts
try {
  await api.post("/users", { body });
} catch (error) {
  if (error instanceof ValidationError) {
    error.direction;  // "request" | "response"
    error.status;     // the response's status; undefined for a request
    error.issues;     // [{ target: "body", path: "email", message: "Invalid email address", source: "builtin" }]
  }
}
```

It extends `ClientError` (its `key` is the route key). Each issue is
bun-contract's `{ target, message, path }` (with `key`, the status, on a
response), plus `source`: `"builtin"` or `"custom"`. `target` is `params`,
`query`, `body`, `headers`, `files` or `response` (a response's body; its
declared headers are `headers`, with `direction: "response"`). No issue quotes the value it is
about: a vendor message that does is replaced by `Invalid value`, as the
server does.

### The generated zod module (`/zod`)

`bun-client generate --zod <file>` writes, beside the map, a module of
runtime zod schemas from the same document: `zod/mini` by default (a third of
classic zod's size, and no `new Function`, so it runs under a CSP without
`'unsafe-eval'`), classic `zod` with `--zod-flavour classic`. `zod` (`^4`) is
an optional peer: only that module and the `@kingsleyweb/bun-client/zod`
entry (`schemasFromZod`, which keys the schemas by the route map and checks
they are zod's) import it, and only as the app loads the module.

```ts
// src/api.zod.gen.ts (generated)
import { schemasFromZod } from "@kingsleyweb/bun-client/zod";
import { z } from "zod/mini";
import type { Routes } from "./api.gen";

export const User: z.ZodMiniType = z.looseObject({
  id: z.string(),
  email: z.email(),
  createdAt: z.iso.datetime({ offset: true }),
});

export const schemas = schemasFromZod<Routes>({
  "GET /users/:id": {
    params: z.looseObject({
      id: z.string(),
    }),
    responses: {
      200: User,
      404: Problem,
    },
  },
});
```

- **Objects are loose** (`z.looseObject`), requests included: a newer
  server's extra field never fails a check, and the server is the authority
  on unknown keys.
- **Checked**: types, `enum` and `const`, required keys, arrays and tuples,
  `oneOf`/`anyOf`/`allOf`, nullable; string lengths and `pattern`; the formats
  `email`, `uuid` (zod's lenient `guid`), `date-time` (offsets allowed),
  `date` and `uri`; number ranges and `multipleOf`; array lengths. Per route:
  `params`, `query` and `headers` from the documented parameters, a JSON body,
  each status's JSON body (`z.string()` for text, `null` for none), and
  `responseHeaders`, each status's declared headers (`Content-Type` and
  `Set-Cookie` left out).
- **Headers cross as strings**, request and response alike: a header whose
  schema describes strings is checked by it, and any other (a server's
  `z.coerce.number()` documents `integer`) as `z.string()`. The route map
  types a response header the same way.
- **Not checked**: a multipart or binary body, an event stream, a `default`
  status; other keywords (the check is looser than the document, never
  stricter). A keyword TypeScript cannot express either (`not`, `if`, …)
  leaves its schema `z.unknown()`, listed under "Not checked" in the header.
- **What JSON Schema loses** (plan §5.3): a `.refine()` or `.superRefine()`
  on the server is dropped from the document, so the generated check is
  weaker than the server's; a `.transform()`'s output, `z.custom()` and
  `z.date()` are `z.unknown()`. The document says nothing of either, so
  only the zod objects show it: `generate --module`, which reads the router
  itself, lists each one in the route map's header ("Warnings", and on
  stderr), once per schema, at the first route part it is met in:

  ```text
  - POST /api/users body: at the value itself: a refinement (`.refine()`, `.superRefine()`) is not in the document, so a schema generated from it (`--zod`) does not run it
  - GET /api/users/:id response 200: at `joined`: `z.date()` has no JSON Schema, so it is typed `unknown` and not checked (declare the wire type, `z.iso.datetime()`)
  ```

  A document read from a URL or a file carries no such warning. The server
  still validates: the client's check exists to fail early and to catch
  drift. Put a cross-field rule you want checked before sending in a BYO
  schema, or use the server's own schemas (which run their refinements on
  the client too).
- `zod/mini` reports `Invalid input` for every issue until a locale is
  loaded (`z.config(z.locales.en())`); the paths are there either way.
- Components are exported, each after those it uses; a schema refers to
  itself through `z.lazy`, a cycle through a small hoisted accessor. The file
  is laid out as Prettier lays it out, so `bun fmt` leaves it unchanged.

## The query layer (`/query`)

`@kingsleyweb/bun-client/query` puts the client's routes on
[`@tanstack/query-core`](https://tanstack.com/query) (an optional peer,
`^5.90.0`; install it beside the client), and adds what query-core does not
know: keys from the route, cache tags, `ETag` revalidation, optimistic
writes and typed pages. Dedupe, stale-while-revalidate, focus and online
refetches, intervals, gc and retries are query-core's, set on the
`QueryClient` as usual. The entry is 2.4 KiB gzipped over query-core, and
the client's own entry does not grow by a byte.

```ts
import { MutationObserver, QueryClient } from "@tanstack/query-core";
import { createClient } from "@kingsleyweb/bun-client";
import { observe, queries } from "@kingsleyweb/bun-client/query";
import { manifest, type Routes } from "./api.gen";

const api = createClient<Routes>({ baseUrl: "/api", manifest });
const q = queries(api, { manifest });
const queryClient = new QueryClient();

const user = q.query("/users/:id", { params: { id: "7" } });
await queryClient.prefetchQuery(user); // any query-core method takes it
const cached = queryClient.getQueryData(user.queryKey); // typed by the key

const rename = q.mutation("PATCH /users/:id", {
  optimistic: {
    "GET /users/:id": (old, vars) => ({ ...old, name: vars.body.name }),
  },
});
await new MutationObserver(queryClient, rename).mutate({
  params: { id: "7" },
  body: { name: "Ada" },
});
```

`q.query(path, options)` takes a GET path and the call's options (`params`,
`query`, `headers`, `body`, and the route settings `timeout`, `retry`,
`middleware`, `validate`) and returns `{ queryKey, queryFn, meta }`. Spread
anything of query-core's over it (`{ ...q.query(…), staleTime: 60_000 }`).
The query function always resolves the success body and rejects with the
client's error (`HttpError`, `UnexpectedStatusError`, `NetworkError`, …),
whatever the client's `throwOnError`, because that is how query-core tells
success from failure. Both retry layers apply, the client's per request and
query-core's per query: turn one off.

`queries(api, { manifest })` takes the manifest the client was given; it
holds the routes' declared tags. Without it only the tags the responses send
apply.

### Keys

`[routeKey, { params, query }]`: `["GET /users/:id", { params: { id: "7" },
query: {} }]`. Params are written as strings, as the URL holds them, so
`{ id: 7 }` and `{ id: "7" }` are one query. query-core hashes a key with its
object keys sorted, so the order of the query's fields does not matter.
`q.key(routeKey, parts?)` builds one for a filter: `q.key("GET /users/:id")`
matches every user, `q.key("GET /users/:id", { params: { id: 7 } })` that
user under any query.

```ts
queryClient.invalidateQueries({ queryKey: q.key("GET /users/:id") });
```

An infinite query's key ends in `"infinite"` and leaves its page field out
of `query`, so it never shares a key with the plain query of the same route.

### Tags

A route's `cache.tags` in the manifest (bun-common's `.describe({ cache: {
tags: ["user:{id}"] } })`, which the generator carries over from
`x-bun-cache`) are filled from the call's params into the query's
`meta.tags`: `["user:7"]`. A template naming a param the call does not have
is left out. A route's responses can add tags it could not declare: the
`Cache-Tag` (comma-separated) and `Surrogate-Key` (space-separated) headers,
which bun-cache's `cacheResponse({ surrogateKeys })` writes from the route's
`tags` and `addCacheTags()`:

```ts
// server
const orgs = cacheResponse(cache, { surrogateKeys: "Surrogate-Key" });
app.get("/orgs/:id", orgs, async (req, res) => {
  const org = await loadOrg(req.params.id);
  addCacheTags(res, `team:${org.team}`); // known only from the data
  res.json(org);
});

// client
await invalidateTags(queryClient, ["team:blue"]); // refetches that team's orgs
```

`invalidateTags(queryClient, tags, filters?, options?)` (also
`q.invalidateTags`) invalidates every query carrying one of the tags,
declared or from its last response, and resolves when the refetches it
started settle. Matching is exact. `tagsOfQuery(queryClient, query)` lists a
query's tags. A CDN in front usually strips these headers; then only the
declared tags apply.

A mutation's `cache.invalidates` (`"PATCH /users/:id"` with `invalidates:
["user:{id}", "users"]`) is filled from its variables' params and
invalidated when it succeeds; the mutation settles after those refetches. A
failed mutation invalidates nothing.

### `ETag` and `304`

When a response carries an `ETag` (bun-common's `res.setEtag()`, or
bun-cache's `cacheResponse`), the query's next fetch sends it as
`If-None-Match`, and a `304` keeps the cached data: the same object, so
nothing downstream sees a change, with `dataUpdatedAt` moved as for a fresh
answer. An ETag is kept only for the data it came with: writing the query by
hand (`setQueryData`, an optimistic write) drops it, an optimistic rollback
puts it back, and a `Cache-Control: no-store` answer keeps none. In a
browser, the Fetch standard bypasses the HTTP cache for a request that
carries its own `If-None-Match`, so the page sees the `304` (from the
standard; the tests here run on Bun's `fetch`, in process and over a socket).

### Optimistic updates

`q.mutation(key, { optimistic })` says, per GET route, how a cached query's
data changes. Before the request those queries are cancelled and written;
if it fails, each is put back exactly as it was (the same object, its `ETag`
included); when it settles, they are invalidated. A writer applies to each
cached query of its route whose params agree with the mutation's on every
name both have: `"GET /users/:id"` for `PATCH /users/:id` with `id: 7`
writes user 7 only, `"GET /users"` (no params) every list. Returning
`undefined` leaves a query as it is. Infinite queries are not written.

`q.mutation()` returns `{ mutationKey, mutationFn, onMutate, onError,
onSuccess, onSettled, meta }` for a `MutationObserver` (or a binding's
`useMutation`). Spreading your own `onSuccess` over it replaces the
invalidation; pass per-call callbacks to `mutate(vars, { onSuccess })`
instead, which run as well.

### Infinite queries

```ts
const list = q.infinite(
  "/users",
  { query: { q: "a" } },
  { pageParam: "page", next: (last) => last.next ?? undefined },
);
const pages = observe(queryClient, list);
await pages.fetchNextPage();
```

`pageParam` names the query field the page goes in, typed from the route's
query (that field may be left out of the options); `next` (and `previous`,
for paging back) returns that field's next value, `undefined` or `null` for
none. The first page is `initialPageParam`, else the field's value in the
call's query, else none (the server's first page). A query holds the tags of
every page it fetched.

### `observe()`

`observe(queryClient, options)` is a framework-free store over query-core's
`QueryObserver` (an `InfiniteQueryObserver` for `q.infinite()`'s options):

```ts
const user = observe(queryClient, q.query("/users/:id", { params: { id: "7" } }));
const stop = user.subscribe(() => render(user.getSnapshot()));
```

The snapshot has `status`, `data`, `error`, `isFetching`, `isStale` and
`dataUpdatedAt` (and `hasNextPage`, `hasPreviousPage`, `isFetchingNextPage`
and `isFetchingPreviousPage` for an infinite query), and stays the same
object until one of them changes, so `useSyncExternalStore` can read it
directly. The first subscriber starts the observer (and its fetch, if the
data is missing or stale); the last one to leave stops it, and the query
goes inactive. `refetch()`, `setOptions()` and, for an infinite query,
`fetchNextPage()`/`fetchPreviousPage()` resolve the snapshot after. React
apps use `./react` instead ([below](#react-react)); live invalidation
(`live()`) comes in a later PR.

## React (`/react`)

`@kingsleyweb/bun-client/react` gives React components the query layer's
routes as hooks. They are thin wrappers over
[`@tanstack/react-query`](https://tanstack.com/query/latest/docs/framework/react/overview)'s
(the plan's §7.1), so the reactivity, dedupe, Suspense, StrictMode, focus and
interval refetches are react-query's, and everything under them (keys, tags,
`ETag` revalidation, `invalidates`, optimistic writes and their rollback) is
`./query`'s. `react` (`^19`) and `@tanstack/react-query` (`^5.90.0`) are
optional peers: install them beside the client and `@tanstack/query-core`.
The entry is 390 bytes gzipped over react-query.

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createClient } from "@kingsleyweb/bun-client";
import { queries } from "@kingsleyweb/bun-client/query";
import { createApiHooks } from "@kingsleyweb/bun-client/react";
import { manifest, type Routes } from "./routes.gen";

const api = createClient<Routes>({ baseUrl: "/api", manifest });
export const q = queries(api, { manifest });
export const { useApi, useApiSuspense, useApiInfinite, useApiMutation } =
  createApiHooks(q);

function User({ id }: { id: string }) {
  const user = useApi("/users/:id", { params: { id } });
  const rename = useApiMutation("PATCH /users/:id", {
    optimistic: {
      "GET /users/:id": (old, vars) => ({ ...old, name: vars.body.name }),
    },
  });
  if (user.isPending) return <p>Loading</p>;
  if (user.isError) return <p>{user.error.message}</p>;
  return (
    <button
      onClick={() => rename.mutate({ params: { id }, body: { name: "Ada" } })}
    >
      {user.data.name}
    </button>
  );
}

const queryClient = new QueryClient();
root.render(
  <QueryClientProvider client={queryClient}>
    <User id="7" />
  </QueryClientProvider>,
);
```

`createApiHooks(q)` is called once per client, at module level; the hooks
read the `QueryClient` from react-query's `QueryClientProvider` (there is no
provider of ours), and `q` serves prefetching, `getQueryData` and
`invalidateTags` outside components.

| Hook | Is | Returns |
|---|---|---|
| `useApi(path, options?, query?)` | `useQuery(q.query(path, options))` | `UseQueryResult`: `data` the route's success body, `error` its `HttpError` or another `ClientError` |
| `useApiSuspense(path, options?, query?)` | `useSuspenseQuery(…)`, for `<Suspense>` | `data` always defined; the first fetch's error goes to the error boundary |
| `useApiInfinite(path, options, page, query?)` | `useInfiniteQuery(q.infinite(…))` | `data.pages`, `fetchNextPage()`, `hasNextPage`, … |
| `useApiMutation(key, config?, options?)` | `useMutation(q.mutation(key, config))` | `mutate(vars)`, `status`, `data`, `error`, `context` (the optimistic snapshot) |

- **`options`** are the call's, as `q.query()` takes them: `params`, `query`,
  `headers`, `body`, and `timeout`, `retry`, `middleware`, `validate`;
  required when the route has a required part. The path must be a GET
  route of the map; a wrong param, query field or route is a type error.
- **`query`** is any of react-query's options but the key and the query
  function (`staleTime`, `enabled`, `select`, `refetchInterval`,
  `placeholderData`, …); `select` types `data`. A `meta` is merged under
  the route's `tags`.
- **`useApiSuspense`** keeps react-query's `staleTime` floor of 1 s for
  suspense queries, so the subscription made after the suspended render
  does not fetch again what was just fetched.
- **`useApiMutation`'s `options`** are `useMutation`'s but the key, the
  function and `onMutate` (the route and its `optimistic` writers own
  them). Its `onSuccess`, `onError` and `onSettled` run **after** the query
  layer's own, so `onSuccess` sees the cache refetched after the route's
  `invalidates`. (Spreading `q.mutation()` into react-query's `useMutation`
  with your own `onSuccess` replaces the invalidation; this hook does not.)
- **Unmounting** releases each hook's observer (and with it any
  `refetchInterval`), so an invalidation no longer refetches a query no
  component reads; react-query's `gcTime` then collects it.

**Not yet:** `useLive(tags)` comes with live invalidation (`live(api)`, the
plan's PR-W4), and `<ApiHydrate state>` with bun-views' hydration (BVW
PR-5, §6.6). Until then, server-rendered data reaches the client through
react-query's own `HydrationBoundary`: the queries' keys and data are plain
JSON, so `dehydrate(queryClient)` of them serialises as it is.

## Persistence (`/persist`)

`@kingsleyweb/bun-client/persist` keeps a `QueryClient`'s cache in
IndexedDB, so a page loaded again starts from what it last had.
`idbPersister()` is a persister for TanStack's own `persistQueryClient`
(`@tanstack/query-persist-client-core`, an optional peer, `^5.90.0`),
written against the browser's IndexedDB API with no IndexedDB library: 724
bytes gzipped.

```ts
import { QueryClient } from "@tanstack/query-core";
import { persistQueryClient } from "@tanstack/query-persist-client-core";
import { idbPersister } from "@kingsleyweb/bun-client/persist";
import { typesHash } from "./routes.gen";

const DAY = 24 * 60 * 60_000;
const queryClient = new QueryClient({
  // A query collected from memory is not persisted: keep them as long.
  defaultOptions: { queries: { gcTime: DAY } },
});
const [stop, restored] = persistQueryClient({
  queryClient,
  persister: idbPersister(),
  buster: typesHash,
  maxAge: DAY,
});
await restored;
```

React's `PersistQueryClientProvider` (`@tanstack/react-query-persist-client`)
takes the same `persister` and `buster` in its `persistOptions`.

- **The buster is the documents' hash.** The generated module exports
  `typesHash`, bun-common's hash of the documents it was generated from (the
  one its header records). When the server's schemas change, the module is
  regenerated (`--check` fails in CI until it is), its hash changes, and a
  cache persisted under the old hash is dropped, and deleted, instead of
  restoring data of the old shape. `maxAge` drops one that is too old.
- **What is kept** is query-core's choice: by default the successful
  queries, with their data and `meta` (so a route's declared tags still
  match `invalidateTags`). The query layer's ETags and response tags belong
  to the live client and are not persisted: a restored query's first fetch
  is unconditional.
- **Writes are throttled**: `persistQueryClient` saves on every cache event,
  and the latest cache is written at most once per `throttleTime`. The last
  changes before a page closes can be lost, as with TanStack's own
  persisters.
- **Nothing rejects.** A failed open, read or write (a quota, a value
  IndexedDB cannot clone) goes to `onError` and counts as no cache. Without
  IndexedDB (a server render) every method does nothing.
- **The connection** opens on first use and closes when another tab upgrades
  or deletes the database, opening again on the next use.

| Option | Default | |
|---|---|---|
| `database` | `"bun-client"` | the IndexedDB database |
| `store` | `"queries"` | the object store, created when missing (beside other persisters' stores) |
| `key` | `"client"` | the record; one per `QueryClient` sharing the store |
| `throttleTime` | `1_000` | ms between writes, the latest cache winning (TanStack's default) |
| `indexedDB` | `globalThis.indexedDB` | another IndexedDB (`fake-indexeddb` in a test, say) |
| `onError` | none | called with a failure's error |

## Bodies beyond JSON

A route map entry says what kind of body each side carries, and the client
builds or reads it (the plan's `other-transports.md` §3–§4):

```ts
interface Routes {
  "POST /users/:id/avatar": {
    params: { id: string };
    body: { caption?: string } | FormData; // the form's fields
    files: { avatar: Blob; extras?: Blob[] }; // one file, or a list
    responses: { 201: { ok: boolean } };
  };
  "POST /sessions": { body: { user: string }; responses: { 200: Session } };
  "GET /users/:id/report": { params: { id: string }; responses: { 200: Blob; 404: Problem } };
  "GET /exports/users": { responses: { 200: AsyncIterable<User> } }; // NDJSON
  "GET /users/:id/avatar": { params: { id: string }; responses: { 200: AsyncIterable<Uint8Array> } };
}

const manifest = {
  "POST /users/:id/avatar": { bodyType: "multipart" },
  "POST /sessions": { bodyType: "urlencoded" },
  "GET /exports/users": { chunks: { 200: "ndjson" } },
  "GET /users/:id/avatar": { chunks: { 200: "raw" } },
} as const satisfies RouteManifest<Routes>;
```

The generator writes both from the OpenAPI document. bun-common documents
an upload's files with `.describe({ request: { files } })` (each a
`format: binary` property beside the validator's fields), a form with
`requestMediaTypes`, and a stream with `x-bun-chunks` from its `chunks()`
declaration; any server's `format: binary` or `contentMediaType` property, a
part's `encoding.contentType`, and an NDJSON media type work the same.

- **Uploads.** `files` is a call option beside `body`: given, the body goes
  out as `multipart/form-data`, its fields as bun-common's parser reads them
  back (the [query string](#the-query-string)'s rules, objects nested with
  dots), then each file under its field, a list repeated. A route whose
  `bodyType` is `"multipart"` sends a plain-object body as `FormData` even
  without files. A `Blob` that is not a named `File` goes out named
  `"blob"`, as the spec says: Bun writes `filename=""`, and busboy then reads
  a typed one as a text field (oven-sh/bun#35439). A pre-built `FormData`
  passes through as it is, unchecked.
- **Forms.** A route whose `bodyType` is `"urlencoded"` sends a plain-object
  body as `application/x-www-form-urlencoded`, written as a query string is;
  a `URLSearchParams` passes through.
- **Downloads.** A body whose media type is neither JSON nor text arrives as
  a `Blob` (a `File` named from `Content-Disposition` when the header gives a
  name, `filename*` first) and the result carries that `filename`. The
  call's `as` asks for it another way: `as: "stream"` hands over the unread
  `ReadableStream`, `as: "arrayBuffer"` an `ArrayBuffer`. A JSON or text
  body (an error's problem+json) is read as it always is.
- **Streams.** A status the manifest's `chunks` names (or one served as
  `application/x-ndjson`, `application/jsonl`, …) is an `AsyncIterable`,
  read as it is iterated: one JSON value per NDJSON line (split across
  chunks, a trailing `\r` dropped, blank lines skipped, the last line read
  without its newline), or the raw `Uint8Array`s. Stopping early cancels the
  body. A line that is not JSON ends the iteration with a `ClientError`.
  The call's `timeout` covers the request, not the iteration; its `signal`
  can end both.
- **Streamed request bodies.** A `ReadableStream` body is sent with
  `duplex: "half"` and is never retried (it cannot be read twice).

**Validation** applies per kind. A form's fields are checked as a body,
before the `FormData` is built; the files are their own part, `files`
(`ValidationConfig.files`, `RouteSchemas.files`, issue target `"files"`),
each a `File`: the generated module checks presence, count, size and exact
media types with zod's `z.file()`. An NDJSON status's schema checks each
line under the response's failure mode: `"warn"` logs a bad line and
delivers it, `"throw"` makes the iteration throw a `ValidationError` there,
after the lines before it. A server's own `chunks()` declaration, given as
the status's schema, is read as its chunk schema. A download and a raw
stream are not checked (as on the server, their content is not read); a
pre-built `FormData` or `URLSearchParams` neither.

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
package in this repo does. The client has one runtime dependency,
`@kingsleyweb/bun-contract` (no dependencies of its own), imported only by
the lazily loaded checks. `./zod` is the zod glue, with `zod` an optional
peer; `./query` is the query layer, with `@tanstack/query-core` an optional
peer (`^5.90.0`: its query and mutation callbacks read the `QueryClient`
from their context, which 5.90 has); `./react` is the React binding, with
`react` (`^19`) and `@tanstack/react-query` (`^5.90.0`) optional peers
beside query-core; `./persist` is the IndexedDB persister, with
`@tanstack/query-persist-client-core` (`^5.90.0`) an optional peer whose
types alone it imports. The generator is `./codegen` (Bun only)
and the `bun-client` bin.
`@kingsleyweb/bun-common` is an optional peer, needed only by `generate
--module` on a router, and a dev dependency for the tests: the query round
trip, the shared backoff vector, the `RoutesOf` types and the generator's
parity with them. bun-cache is a dev dependency too, for the query layer's
`Surrogate-Key` tests. React, react-dom, react-query and happy-dom are dev
dependencies for the React binding's DOM tests, and
query-persist-client-core for the persister's (pinned to the lock's
query-core, which it depends on exactly).
