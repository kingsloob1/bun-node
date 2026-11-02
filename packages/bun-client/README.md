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
([`docs/plans/typed-client/`](../../docs/plans/typed-client/README.md), PR-C1).
The generator that writes the route map from the server's OpenAPI document
(`bun-client generate`), the watcher, validation, the query layer and the
other transports come in later PRs (the plan's §15).

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

There are two ways to get one before the generator ships:

- **Write it by hand**, in the shape above. `query: Record<never, never>`
  declares no query (any key is then an error), and `body: undefined` declares
  no body. A part left out is undeclared, and loosely typed.
- **Infer it** from a `defineRoutes` registry with bun-common's `RoutesOf`:
  `createClient<RoutesOf<typeof users>>()`. Today `RoutesOf` carries the
  validator's parsed shapes, so a defaulted query key reads as required. The
  sender view the plan adds to `RoutesOf` (PR-M1) fixes that, and the client
  reads that view when it is there.

### The manifest

Types do not exist at run time, so two facts need a small object beside the
map: each route's `operationId`, for `api.op`, and its declared statuses, for
`undeclaredStatus`. The generator will write it. A hand-written one is checked
against the map:

```ts
const manifest = {
  "GET /users/:id": { operationId: "getUser", statuses: [200, 404] },
} as const satisfies RouteManifest<Routes>;

const api = createClient<Routes>({ manifest });
```

If a route has no manifest entry, every status it answers is returned as
declared.

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
`response.body`; anything else becomes a `Blob`.

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
package in this repo does. The client has no runtime dependency.
`@kingsleyweb/bun-common` is a dev dependency, used only by the tests: the
query round trip, the shared backoff vector and the `RoutesOf` types.
