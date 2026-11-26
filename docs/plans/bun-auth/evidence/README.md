# bun-auth evidence

The measurements behind [the bun-auth plan](../README.md), taken on
2026-11-20 on linux-x64 with Bun 1.4.5-canary.1+862278db7, against
`develop` at `52082313`. Each better-auth version was installed on its own
with `bun add better-auth@<version>` into an empty directory outside the
repository. The spikes are single files run with `bun`. They were kept in the
session's scratch directory, as the plan's brief asks, and are described here
closely enough to write them again.

Everything here is **measured** unless it says **assumed**.

## Versions

`npm view better-auth dist-tags` on 2026-11-20: `latest` 1.7.27,
`release-1.6` 1.6.35, `beta` 1.8.0-beta.10. These three were installed and
run.

## E1. Install size and dependency tree (survey item 3)

| Version | Packages installed | On disk (`du -sb`) | Runtime dependencies of `better-auth` |
|---|---|---|---|
| 1.6.35 | 22 (the 21 below plus `@opentelemetry/semantic-conventions`) | 23.6 MB | 17 |
| 1.7.27 | 21 | 14.1 MB | 17 |
| 1.8.0-beta.10 | 21 | 14.2 MB | 17 |

1.7.27's 21 packages:
- the `@better-auth/*` family: `core`, `utils`, `telemetry`, and five
  adapters (`drizzle-adapter`, `kysely-adapter`, `memory-adapter`,
  `mongo-adapter`, `prisma-adapter`);
- `better-auth`, `better-call`;
- `@better-fetch/fetch`, `@noble/ciphers`, `@noble/hashes`,
  `@standard-schema/spec`;
- `defu`, `jose`, `kysely`, `nanostores`, `rou3`, `set-cookie-parser` and
  `zod`.

The largest are `zod` (5.7 MB), `kysely` (3.5 MB), `better-auth` (3.2 MB) and
the `@better-auth/*` family (3.0 MB). Everything else (React, Svelte, Next,
Prisma, Drizzle, `pg`, `mysql2`, `mongodb`, vitest, …) is an optional peer,
installed only when the app uses it. `@better-auth/telemetry` is a hard
dependency in all three versions.

## E2. Telemetry (survey item 2)

Read from `@better-auth/telemetry/dist/index.mjs` in all three versions, and
run (spike `telemetry`, with `fetch` replaced by a recorder and
`NODE_ENV=production`):

- **Off by default.** It is enabled only by `telemetry: { enabled: true }`
  or `BETTER_AUTH_TELEMETRY=1`, and never under a test runner
  (`isTest()`).
- **Even enabled, it sends nothing without an endpoint.** The endpoint is
  `BETTER_AUTH_TELEMETRY_ENDPOINT`, whose default is `""`; with no endpoint
  and no `customTrack`, `createTelemetry` returns a no-op.

  | Setting | Off-host requests at init and on a request |
  |---|---|
  | default | none |
  | `telemetry.enabled: true` | none |
  | enabled, endpoint set | one `POST` to the endpoint |

  The same in 1.6.35 and 1.8.0-beta.10.
- **What it would send**, once enabled with an endpoint:
  - an `init` event with the config as booleans and counts (which features
    are on: email and password, social providers, plugins, rate limit, …);
  - the runtime and its version, the database adapter's name, and the
    framework;
  - the environment (`production`, `ci`, `test`, `development`) and the
    package manager;
  - a deployment vendor guessed from environment variables (Vercel, AWS,
    Railway, …);
  - an `anonymousId`, a hash of `baseURL`, or a random id;
  - after that, events published by the library.

  The `node.mjs` build adds host details (platform, CPU, memory, Docker,
  WSL); the default build sends them as `null`. This was not run with a real
  endpoint, so the exact payload over the wire is **assumed** from the source.

## E3. The handler on `Bun.serve` (survey item 1; spike `serve`, all three versions alike)

`Bun.serve({ fetch: (req) => auth.handler(req) })` with the memory adapter
and email and password:

| Step | Answer |
|---|---|
| sign-up | `200`, one `better-auth.session_token` cookie |
| sign-in | `200`; the cookie has `Max-Age`, `Path`, `HttpOnly`, `SameSite`, and no `Secure` over plain HTTP |
| `GET /get-session` with the cookie | `200` `{ session, user }` |
| `auth.api.getSession({ headers })` | `{ session, user }`, with no HTTP round trip |
| a `POST` with the cookie from an untrusted `Origin` | `403` `{ code: "INVALID_ORIGIN" }`: its CSRF check |
| an `OPTIONS` preflight from a trusted origin | `404`: **the handler does no CORS**; the host answers preflights |
| a `before` database hook that throws | `422` `{ code: "FAILED_TO_CREATE_USER" }`: the error is swallowed, and `onAPIError.onError` is **not** called for it |

`basePath` defaults to `/api/auth`. The handler answers any path under it and
404s the rest.

## E4. Internal errors (survey item 1; spike `errors`, all three versions alike)

An adapter whose reads throw `Error("db connection lost")` during
`POST /sign-in/email`:

| `onAPIError` | Answer | `onError` called | Logged |
|---|---|---|---|
| default | `500`, empty body | yes, with the error | printed to the console as `# SERVER_ERROR:` with the stack, **bypassing the configured `logger`** |
| `throw: true` | `auth.handler()` rejects with the original error | no | not by better-auth |

So the third-party report is right in part: by default an internal error
becomes an anonymous `500`, and the host's error handler never sees it.
`onAPIError: { throw: true }` hands it to the host.

## E5. Mounting on bun-common (survey item 1; spike `common`, 1.7.27)

bun-common's adapter reads and parses the body before the first handler
(`parseBody: true`). Passing the native `req.request` on to better-auth then
fails:

| Mount | sign-up | session afterwards | sign-out | form sign-in |
|---|---|---|---|---|
| A: default adapter, `app.use("/api/auth", …)`; the `Request` rebuilt from `req.body` | 200 | yes | 200, 3 cookies | 200 (lossy: a form body re-sent as JSON) |
| B: `request: { deferBody: true }`, `app.use` passes `req.request` | 200 | yes | 200, 3 cookies | 200 |
| C: `deferBody: true`, a route handler (`app.all`) passes `req.request` | 500 `Body is disturbed or locked` | no | 500 | 500 |
| D: default adapter, `requestParsing({ parseBody: false })` on the prefix | 500 `Body already used` | no | 500 | 500 |

Only B passes the request through intact. It works because `deferBody` leaves
the body unread until a route handler, and a `use` middleware is not one.
Every multi-cookie answer kept all its `Set-Cookie` headers through
`res.send(response)`.

## E6. Mounting under bun-nest (spike `nest`, 1.7.27)

bun-nest's `BunHttpAdapter` with `request: { deferBody: true }`, better-auth
mounted with `app.use("/api/auth", …)` before `init()`, and a controller
behind a guard that calls `auth.api.getSession`: sign-up `200`; the guarded
route `200` with the user; without a session `403`.

## E7. Its rate limiter (survey item 5; spike `ratelimit`, 1.7.27)

- **Off in development, on in production.** With no `rateLimit` option, 8
  wrong sign-ins from one address were all `401` with `NODE_ENV` unset, and
  `401, 401, 401, 429, …` under `NODE_ENV=production`. The default sign-in
  rule is 3 per window per address.
- **The memory store is shared process-wide.** It is a module-level `Map`
  (`api/rate-limiter/index.mjs`), so a second `betterAuth()` instance in the
  same process started with the first one's counts (every one of its
  requests `429`).
- **The client address comes from `X-Forwarded-For` by default, unverified.**
  - With no header, every client shares one bucket: `401` ×3, then `429`.
  - A new `X-Forwarded-For` per attempt was never limited.
  - 1.7 has `advanced.ipAddress.trustedProxies` and `ipAddressHeaders`
    (types read). Their effect was **not** run.
- Its storage can be `memory`, `database`, `secondary-storage`, or a
  `customStorage` (types read).

## E8. The password hook (survey item 6; spikes `serve` and `hash`, 1.7.27)

- `emailAndPassword.password: { hash, verify }` with `Bun.password`
  (argon2id) worked: one `hash` call at sign-up, a stored `$argon2id$…` hash,
  and sign-in verified through `verify`.
- **better-auth's own hash** is `salt:hash` (scrypt, from `@noble/hashes`).
  `Bun.password.verify` on it **throws** `UnsupportedAlgorithm`. A `verify`
  hook for an existing user base has to fall back to better-auth's
  `verifyPassword`, which `better-auth/crypto` exports.
- One `Bun.password` argon2id hash took 119 ms; one default sign-up took
  93 ms in total. These are single runs, not benchmarks.

## E9. Its database adapter API (survey item 4; types read)

`createAdapterFactory` is the API in 1.6.35, 1.7.27 and 1.8.0-beta.10
(`better-auth/adapters`, from `@better-auth/core/db/adapter`); `createAdapter`
is still exported, marked deprecated. A custom adapter implements:
- `create`, `update`, `updateMany`, `findOne` (with `join`), `findMany`
  (`where`, `limit`, `offset`, `sortBy`, `select`, `join`), `delete`,
  `deleteMany` and `count`;
- optionally `consumeOne`, `incrementOne` and `createSchema`.

Adapter tests ship as `@better-auth/test-utils` (`./adapter`), whose peers
are `vitest ^4 || ^5`. Whether its cases run under `bun test` is **assumed
unknown**: not run.

The community adapter is `@ilbertt/better-auth-bun-sql` 0.4.1 (Unlicense,
modified 2026-10-13, peer `better-auth >=1.6.0`). It ships TypeScript source
for Bun and supports **Postgres and SQLite only**. Its `dialect.d.ts` says
MySQL and MariaDB are left out because they lack the `RETURNING` it relies
on. Nothing named `better-auth-bun-sql` exists on npm.

## E10. Plugins (survey item 5; exports read, open-api spike)

- **In `better-auth/plugins` (1.7.27):** `two-factor` (TOTP, OTP, backup
  codes), `admin`, `organization`, `jwt`, `bearer`, `username`,
  `magic-link`, `email-otp`, `phone-number`, `anonymous`, `multi-session`,
  `one-time-token`, `custom-session`, `access`, `captcha`,
  `haveibeenpwned`, `open-api`, `device-authorization`, `generic-oauth` and
  others.
- **Separate packages at 1.7.27:**
  - `@better-auth/passkey`;
  - `@better-auth/api-key`;
  - `@better-auth/oauth-provider` (the OIDC provider; `./plugins/oidc-provider`
    left `better-auth` in 1.7, see E12);
  - `@better-auth/sso`;
  - `@better-auth/stripe`.
- **The `open-api` plugin** with two-factor, admin, organization, jwt and
  bearer served an OpenAPI **3.1.1** document: 77 paths, 79 operations, 70
  of them with a `200` response schema, 9 component schemas.
- `bun-client generate` (this repository's) took that document and wrote a
  typed route map: 3,468 lines, with `"POST /sign-in/email"` typed by its
  body, and 18 `unknown`s where the document declares no schema.

## E11. Admin UI (open question Q9)

No admin UI is in `better-auth` or its first-party packages. The UI packages
on npm are:
- `better-auth-ui` and `@daveyplate/better-auth-ui`: "plug & play shadcn/ui
  components", end-user screens;
- `@better-auth/infra` 0.4.31, "Dashboard and analytics plugin". That it
  reports to a hosted dashboard rather than serving one is **assumed**; its
  README on npm is empty.

## E12. Version drift (survey item 7)

| | 1.6.35 → 1.7.27 | 1.7.27 → 1.8.0-beta.10 |
|---|---|---|
| `exports` removed | `./plugins/oidc-provider`, `./plugins/mcp/client`, `./plugins/mcp/client/adapters` | none |
| `exports` added | `./plugins/open-api`, `./plugins/captcha`, `./plugins/one-tap`, `./cookies/utils` | `./oauth2/dpop-client` |
| `better-call` | 1.4.0 → 1.4.6 | 1.4.6 → 1.4.5 (the beta branch is behind) |
| runtime dependencies | the same 17 names | the same 17 names |
| spikes E2, E3, E4 | the same answers | the same answers |

E5 to E10 were run on 1.7.27 only.

## E13. A wrong password and a missing account (spike `uniform`, 1.7.27)

The limiter was off; there were ten tries of each, alternating:

| Attempt | Status | Body | Median time |
|---|---|---|---|
| a wrong password for an account that exists | `401` | `{"message":"Invalid email or password","code":"INVALID_EMAIL_OR_PASSWORD"}` | 64.4 ms |
| an account that does not exist | `401` | the same | 64.4 ms |

## E14. `req.webRequest()` and `requestParsing({ retainBuffer })` (PR-A0)

Taken on 2026-11-26 with Bun 1.4.5-canary.1+862278db7 on linux-x64, against
`develop` at `beff674d` with PR-A0's `req.webRequest()`, which reports where
the body of the `Request` it answers came from (`webRequestSource()`:
`"original"`, `"retained"`, `"decoded"`, `"parsed"` or `"none"`). No
better-auth: the handler was bun-common's adapter answering a handler that
reads `req.webRequest().text()`. Served on port 0 (a real socket, so bodies
were framed as in production), three bodies — JSON with irregular spacing,
a form with its keys out of order and a `+`, and plain text — sent to
`/api/auth/x`, with and without `app.use("/api/auth", requestParsing({
retainBuffer: true }))` in front. "Exact" means the bytes the handler read
were the bytes sent.

| Adapter `request` options | `requestParsing({ retainBuffer: true })` on the prefix | Source | JSON | form | text |
|---|---|---|---|---|---|
| default (`retainBuffer` unset, which keeps the bytes) | no | `retained` | exact | exact | exact |
| default | yes | `retained` | exact | exact | exact |
| `retainBuffer: false` | no | `parsed` | not exact | not exact | exact |
| `retainBuffer: false` | **yes** | **`parsed`** | **not exact** | **not exact** | exact |
| `deferBody: true` | no | `original` (a `use` handler, before the read) | exact | exact | exact |
| `deferBody: true` | yes | `retained` | exact | exact | exact |
| `deferBody: true, retainBuffer: false` | no | `original` | exact | exact | exact |
| `deferBody: true, retainBuffer: false` | yes | `retained` | exact | exact | exact |

So the plan's assumption (§4.1) holds only in part. `requestParsing({
retainBuffer: true })` keeps the bytes on its prefix only for a body still
unread when it runs, which means an adapter with `deferBody`. An adapter with
`retainBuffer: false` and no `deferBody` has already read a JSON, form, text
or XML body without its bytes (`request.json()`, `request.text()`) while the
request was built, so the middleware is too late, and `webRequest()` answers
a `"parsed"` request rebuilt from the value. The text body survives that only
because its value is its text. With the adapter's default, every body keeps
its bytes anyway, so the middleware changes nothing.

The same rows are asserted in bun-common's `__tests__/webRequest.test.ts`
(socket-free, with served-shaped requests), beside the parse-mode matrix:
JSON, urlencoded, multipart, text, XML, raw and no content type, each with
`deferBody` on and off, `retainBuffer` kept and dropped, mounted by `use` and
by a route. Multipart and raw always keep their bytes. A body that came with
a `Content-Encoding` is `"decoded"`: the decoded bytes, the header dropped.
A Fetch API handler reading JSON and forms through `webRequest()` passed on
every adapter configuration and mount, and through bun-nest's adapter with
Nest's body parser on. Passing `req.request` instead failed with `500` as E5
measured: by `use` and by route on the default adapter, by route under
`deferBody`, and in every bun-nest configuration.
