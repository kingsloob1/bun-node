# bun-auth: better-auth on bun-node — plan

Status: **approved by the user (2026-11-20)**: the names in §15 and the recommendations of all fourteen questions in §16. PR-A0 (`req.webRequest()`) is built; nothing else yet. Written 2026-11-20 against `develop` at
`52082313`, Bun 1.4.5-canary.1+862278db7 on linux-x64, with better-auth
1.7.27 (`latest`), 1.6.35 (`release-1.6`) and 1.8.0-beta.10 (`beta`).

The direction is the user's (2026-11-20): **don't reinvent authentication;
wrap better-auth.** The working name is `@kingsleyweb/bun-auth`, with
`better-auth` as a peer dependency. The app brings its own `betterAuth({...})`
instance. bun-auth never forks better-auth's configuration and never
re-exports it.

Everything below marked **measured** was run on this machine for this plan.
The spikes and their numbers are in [`evidence/`](evidence/README.md) (E1 to
E14). Everything marked **assumed** was not run. A sub-plan,
[`sql-adapter.md`](sql-adapter.md), covers the bun-sql database adapter.

## Contents

- [1. Summary](#1-summary)
- [2. What better-auth is, on Bun](#2-what-better-auth-is-on-bun)
- [3. The package](#3-the-package)
- [4. Mounting](#4-mounting)
- [5. The session on the request](#5-the-session-on-the-request)
- [6. bun-nest](#6-bun-nest)
- [7. A typed client](#7-a-typed-client)
- [8. bun-security](#8-bun-security)
- [9. `authorize` for the jobs and security APIs and UIs](#9-authorize-for-the-jobs-and-security-apis-and-uis)
- [10. An admin UI](#10-an-admin-ui)
- [11. Tree-shaking and browser safety](#11-tree-shaking-and-browser-safety)
- [12. The better-auth version matrix](#12-the-better-auth-version-matrix)
- [13. Examples and the playground](#13-examples-and-the-playground)
- [14. PRs in order](#14-prs-in-order)
- [15. Names](#15-names)
- [16. Open questions](#16-open-questions)

## 1. Summary

better-auth already does on Bun what bun-node would otherwise build:
- sessions in cookies;
- email and password, social sign-in, two factors, passkeys,
  organisations, admin roles, API keys and JWTs;
- an OpenAPI document of its own routes.

**Measured:** its handler takes a `Request` and answers a `Response` on a
plain `Bun.serve`, under bun-common's adapter and under bun-nest, in 1.6, 1.7
and the 1.8 beta. Its telemetry is off by default and sends nothing even
enabled until an endpoint is set (E2).

What bun-auth adds is the fitting, not authentication:
1. **Mounting** it on `Bun.serve`, bun-common and bun-nest.
   - This means handing over the request body bun-common has already read:
     the one real friction point, E5.
   - It also means handing over the client address that bun-common resolved,
     which better-auth's limiter otherwise takes from an unverified
     `X-Forwarded-For` (E7).
2. **A typed session** on the request: `req.session` and `req.user` typed from
   the app's own `auth` instance.
3. **bun-nest guards and decorators**, in bun-nest's `./auth` beside
   `./security` and `./jobs`.
4. **A typed bun-client** for better-auth's routes, generated from its own
   OpenAPI document. **Measured:** `bun-client generate` already takes that
   document (E10).
5. **bun-security working with it:**
   - `createSecurityApi`'s `authenticate` and `stepUp` read better-auth
     sessions;
   - the sign-in defences run on better-auth's sign-in routes;
   - one owner per concern for rate limiting.
6. **`authorize` for the jobs and security APIs and UIs**, from better-auth
   roles and organisations.
7. **A bun-sql database adapter** across Postgres, MySQL, MariaDB and SQLite.
   The community one has only two of those engines (E9).
8. An opt-in **`Bun.password`** hash that can still verify better-auth's own
   hashes (E8).

Estimate: about **25 days** across 10 PRs ([§14](#14-prs-in-order)). An admin
UI would be a plan of its own ([§10](#10-an-admin-ui), Q9).

## 2. What better-auth is, on Bun

### 2.1 The handler (measured, E3, E4)

- `auth.handler(request)` answers everything under `basePath` (default
  `/api/auth`). `auth.api.*` calls the same endpoints in-process:
  `auth.api.getSession({ headers })` returns `{ session, user }` with no
  HTTP round trip.
- **Cookies:**
  - one `better-auth.session_token` cookie, `HttpOnly`, `SameSite`,
    `Max-Age`, `Path`;
  - `Secure` only over HTTPS;
  - sign-out answers three `Set-Cookie`s, which all survive bun-common's
    `res.send(response)`.
- **CSRF and origins:** a cookie-bearing `POST` from an origin outside
  `trustedOrigins` is refused with `403 INVALID_ORIGIN`.
- **CORS:** none. A preflight is `404`. The host answers CORS (bun-common's
  `cors()`, or bun-nest's), before the handler.
- **Internal errors:**
  - By default an exception inside an endpoint (a database failure) becomes
    `500` with an empty body. The stack is printed to the console as
    `# SERVER_ERROR:`, bypassing the configured `logger`, and
    `onAPIError.onError` is called.
  - With `onAPIError: { throw: true }`, `auth.handler()` rejects with the
    original error instead, so the host's error pipeline sees it.
  - A database hook that throws is swallowed into `422
    FAILED_TO_CREATE_USER`, without `onError`.

  The third-party report that it "swallows errors as 500s" is right for the
  default.

### 2.2 Telemetry (measured, E2)

`@better-auth/telemetry` is a hard dependency, but sends nothing by default.
- It is enabled only by `telemetry: { enabled: true }` or
  `BETTER_AUTH_TELEMETRY=1`, and never under a test runner.
- Even enabled, it posts nowhere unless `BETTER_AUTH_TELEMETRY_ENDPOINT` is
  set; its default is empty.
- With an endpoint, it posts an `init` event: the configuration as booleans
  and counts, the runtime, the adapter's name, the framework, the
  environment, the package manager, and an id hashed from `baseURL`. The
  payload over the wire is **assumed** from the source; it was not sent to a
  real endpoint.

bun-auth changes nothing here. Its README says what the setting does (Q10).

### 2.3 Dependencies (measured, E1)

`better-auth` 1.7.27 installs 21 packages, 14.1 MB. Its runtime dependencies
include `zod`, `kysely`, `jose`, `nanostores` and `@noble/*`; React, Next,
Prisma, `pg` and `mongodb` are optional peers. That is far outside what
CLAUDE.md's dependency policy lets a bun-node package take on. As a **peer**,
though, it is the app's choice and the app's install, as `mongodb` is for
bun-jobs and bun-cache.

bun-auth itself takes **no** runtime dependency beyond bun-common. It imports
only better-auth's types, plus `better-auth/crypto` and
`better-auth/adapters` in the entries that need them.

### 2.4 Database adapters (measured, E9; sub-plan [`sql-adapter.md`](sql-adapter.md))

- `createAdapterFactory` is the API in 1.6, 1.7 and the 1.8 beta;
  `createAdapter` is a deprecated alias.
- A custom adapter implements eight operations (`create`, `update`,
  `updateMany`, `findOne`, `findMany`, `delete`, `deleteMany`, `count`), plus
  three optional ones (`consumeOne`, `incrementOne`, `createSchema`).
- First-party adapters cover Kysely, Drizzle, Prisma, MongoDB and memory.
- The community `@ilbertt/better-auth-bun-sql` 0.4.1 covers Postgres and
  SQLite only. It leaves out MySQL and MariaDB because they lack
  `RETURNING`; bun-sql's dialects already work around that.

**Recommendation:** write `@kingsleyweb/bun-auth/sql` on bun-sql, all four
engines (Q7).

### 2.5 Plugins (measured, E10)

| Plugin | Where | Wired by bun-auth? |
|---|---|---|
| two-factor (TOTP, OTP, backup codes) | `better-auth/plugins` | **yes**: step-up freshness ([§8.2](#82-step-up)) |
| passkey | `@better-auth/passkey` | **yes**: the same |
| organization | `better-auth/plugins` | **yes**: `authorize` by organisation and member role ([§9](#9-authorize-for-the-jobs-and-security-apis-and-uis)) |
| admin (roles, bans, impersonation) | `better-auth/plugins` | **yes**: `authorize` by user role; its bans stay its own ([§8.4](#84-rate-limits-and-bans-one-owner-each)) |
| api-key | `@better-auth/api-key` | read only: an API-key session is a session like any other; bun-security's own API keys stay separate (Q14) |
| jwt, bearer | `better-auth/plugins` | read only: the session middleware accepts a bearer session as better-auth resolves it |
| open-api | `better-auth/plugins` | **yes**: the typed client's source ([§7](#7-a-typed-client)) |
| OIDC provider | `@better-auth/oauth-provider` (left `better-auth` in 1.7, E12) | no, v1 |
| SSO, Stripe, magic link, email OTP, … | various | no: they work through the handler untouched |

**Its own rate limiter (measured, E7):**
- It is **off in development and on in production**: 3 sign-ins a window
  per address.
- Its memory store is **one `Map` for the whole process**, shared by every
  `betterAuth()` instance.
- By default it keys the client on an **unverified `X-Forwarded-For`**:
  - with no header, every client shares one bucket;
  - with a new forged address per attempt, it never limits.

### 2.6 The password hook (measured, E8)

`emailAndPassword.password: { hash, verify }` takes `Bun.password`: argon2id
hashes are stored and verified. But better-auth's default hash is scrypt in a
`salt:hash` form, which `Bun.password.verify` refuses (it throws). So
`bunPassword()` (opt-in, Q6):
- hashes with `Bun.password`;
- verifies a `$argon2…`/`$2…` hash with `Bun.password`, and anything else with
  better-auth's own `verifyPassword` (`better-auth/crypto`);
- reports, through an `onLegacyHash` callback, each user whose hash is still
  the old kind, for re-hashing at the next sign-in.

### 2.7 Version drift (measured, E12)

| | 1.6.35 → 1.7.27 | 1.7.27 → 1.8.0-beta.10 |
|---|---|---|
| `exports` | OIDC provider and the MCP client left; `open-api`, `captcha`, `one-tap` and `cookies/utils` arrived | `oauth2/dpop-client` added |
| runtime dependencies | the same 17 | the same 17 |
| the handler, error and telemetry spikes | the same answers | the same answers |

**Recommendation:** a peer range of `>=1.7.0 <2`, tested at 1.7.0, `latest`
and the current beta ([§12](#12-the-better-auth-version-matrix), Q11). 1.6
lacks the `open-api` plugin the typed client rests on.

## 3. The package

`@kingsleyweb/bun-auth`, published from this repository with the recipe in
CLAUDE.md ("Packaging types"). It has:
- `better-auth` as a **required peer**, `>=1.7.0 <2`;
- `@kingsleyweb/bun-common` as its one runtime dependency;
- bun-security, bun-sql, bun-jobs and bun-ui as **optional peers**, each
  scoped to the entry that needs it (bun-ui's per-entry peers pattern,
  `consumer-check.json` `peers`).

| Entry | What | Needs |
|---|---|---|
| `.` | `authHandler`, `mountAuth`, `sessionMiddleware`, `requireSession`, `getAuthSession`, types (`AuthSession`, `AuthRequest`, `BunAuthOptions`) | better-auth types, bun-common |
| `./serve` | `withAuth(auth, fetch, options)` for a plain `Bun.serve` | better-auth types |
| `./security` | `authOperator`, `sessionStepUp`, `authSignInProfiles`, `authRateLimitStorage` ([§8](#8-bun-security)) | bun-security (optional peer) |
| `./authorize` | `authorizeJobsApi`, `authorizeUi`, `authorizeSecurityApi`, `roleRules` ([§9](#9-authorize-for-the-jobs-and-security-apis-and-uis)) | bun-jobs, bun-security, bun-ui types only |
| `./sql` | `bunSqlAdapter` ([`sql-adapter.md`](sql-adapter.md)) | bun-sql (optional peer), `better-auth/adapters` |
| `./password` | `bunPassword({ onLegacyHash })` | `better-auth/crypto` |
| `./client` | `authRoutes` (a generated route map type) and `createAuthClient` over bun-client: **browser-safe** ([§7](#7-a-typed-client), [§11](#11-tree-shaking-and-browser-safety)) | bun-client (optional peer) |

bun-nest gains `./auth`, with bun-auth as an optional peer, as it has
`./security` and `./jobs` ([§6](#6-bun-nest), Q12).

## 4. Mounting

### 4.1 The body (measured, E5)

bun-common's adapter reads and parses a request's body before the first
handler. better-auth then reads it again and fails (`Body already used`).
Only one way works today:
- an adapter with `request: { deferBody: true }`;
- better-auth mounted as middleware (`app.use`), which runs before the
  deferred read;
- `req.request` passed straight on.

Rebuilding the request from `req.body` also passed, but lossily: a form body
was sent on as JSON.

`mountAuth(app, auth)` must therefore not depend on how the app configured
its adapter. The plan (Q2) is a small bun-common addition, `req.webRequest()`
(PR-A0). It answers a `Request` carrying the body as received:
- the original one when the body is unread;
- else one rebuilt from the retained bytes (`retainBuffer`);
- else, for a body read without its bytes (JSON through `request.json()`),
  one rebuilt from the parsed value with its content type, and marked so a
  caller that needs the exact bytes can refuse it.

bun-auth uses it, and bun-security's route stage can then read a sign-in
body without stealing it ([§8.3](#83-sign-in-protection-on-better-auths-routes)).
Measured: a `use` middleware under `deferBody` runs before the read.

**Built in PR-A0 (measured, E14).** `req.webRequest()` answers:
- an unread body (`deferBody`, `parseBody: false`) as a `clone()` of
  `req.request`, so the original stays readable for `req.body`;
- a body read with its bytes as a request rebuilt from them (`req.buffer`);
  a `Content-Encoding` body as its decoded bytes, the header dropped;
- a body read without them as a request rebuilt from the value parsed then,
  in its content type;
- no body (`GET`, `HEAD`, none sent) as the original itself, or a copy
  without one.

The marker is `webRequestSource(request)`: `"original"`, `"retained"`,
`"decoded"`, `"parsed"` or `"none"`, kept in a `WeakMap`, so the `Request`
is not changed, and a copy of it reads `undefined`. Each call answers a new
unread `Request` and reads nothing. It throws a `TypeError` when the body was
consumed with nothing kept (through `req.request` directly, or while a read
is still in progress).

**The prefix assumption held only in part (E14).** `requestParsing({
retainBuffer: true })` keeps the bytes for its prefix only when the body is
still unread when it runs, which needs `deferBody`. An adapter with
`retainBuffer: false` and no `deferBody` has read a JSON, form, text or XML
body without its bytes before any middleware, so the middleware is too late
and `webRequest()` answers `"parsed"`. The adapter's default keeps every
body's bytes, so `"retained"` is the usual answer. Proposed for PR-A1 (not
yet decided):
- `mountAuth` still installs `requestParsing({ retainBuffer: true })` on its
  prefix: it makes the bytes exact under `deferBody`, and costs nothing
  otherwise;
- better-auth reads a `"parsed"` JSON or form body correctly (E14: the
  stand-in handler passed), so `mountAuth` accepts it, and warns once at start
  when the adapter has `retainBuffer: false` without `deferBody`;
- a caller that needs the exact bytes (a signature over the body) refuses
  `"parsed"` itself.

### 4.2 The client address

better-auth's limiter takes the client from `X-Forwarded-For`, unverified
(E7). bun-common has already resolved the real client (`req.clientAddress`,
with `trustProxy`). So `mountAuth`:
- strips any incoming `x-bun-auth-client-ip`;
- sets it to `req.clientAddress` on the request it hands over;
- asks the app to configure `advanced.ipAddress.ipAddressHeaders:
  ["x-bun-auth-client-ip"]`.

It warns once at start when the auth instance's options read another header
(Q4). That the option takes effect is **assumed**: E7 read its types but did
not run it.

### 4.3 Errors

`mountAuth` cannot change the app's configuration. Its README recommends
`onAPIError: { throw: true }`, under which a failure reaches bun-common's
error handlers as an ordinary error (E4). It warns once when the option is
unset. Either way it never turns better-auth's own `4xx` answers into
errors: they are answers.

### 4.4 Where it mounts

```ts
import { betterAuth } from "better-auth";
import { mountAuth, requireSession } from "@kingsleyweb/bun-auth";

export const auth = betterAuth({ /* the app's own */ onAPIError: { throw: true } });
mountAuth(app, auth);                       // app.use(auth.options.basePath ?? "/api/auth", …)
app.get("/me", requireSession(auth), (req, res) => res.json(req.user));
```

- `withAuth(auth, fetch)` does the same for a plain `Bun.serve`: it answers
  requests under `basePath` with `auth.handler` and passes the rest on.
- In Nest, `AuthModule.forRoot({ auth })` mounts it on the adapter before
  Nest's routes. Measured as E6: a guarded route answered `200` with a
  session and `403` without.

## 5. The session on the request

- `sessionMiddleware(auth)` calls `auth.api.getSession({ headers })` once per
  request. It sets `req.session` and `req.user` (or `null`), and keeps them in
  a `WeakMap` keyed by the request, so `getAuthSession(req)` reads them again
  for free.
- `requireSession(auth, { roles?, organization? })` answers `401` without a
  session (problem+json, bun-common's shape).
- **Typing.** The session's type is the app's: better-auth infers it from the
  plugins in use (`typeof auth.$Infer.Session`).
  - bun-auth exports `AuthRequest<typeof auth>`, a `BunRequest` with
    `session` and `user` typed from that instance, and
    `getAuthSession<typeof auth>(req)`.
  - Narrowing the handler's `req` automatically after `requireSession` would
    need bun-common's typed overloads to carry a phantom "session" position,
    as `BunValidate` carries its shape. That is a change to bun-common's
    generated overloads, proposed for later, not v1 (Q8).
- A request answered by a verified bun-security service identity
  ([§8.5](#85-service-identity)) is not given a session.

## 6. bun-nest

bun-nest gains `./auth` (Q12):
- `AuthModule.forRoot({ auth, global? })` mounts the handler and provides
  `AUTH`;
- `AuthGuard`, `@Session()`, `@CurrentUser()`, `@AllowAnonymous()` and
  `@RequireRoles(...)`;
- `@InjectAuth()`.

The guard is typed with bun-common's `BunRequest`, following the
`nestjs-conventions` skill (`getRequest<BunRequest>()`). The WebSocket
adapter's handshake reads the session the same way (`getAuthSession` on the
upgrade request).

Tested on the Nest matrix's columns, as `./security` is.

## 7. A typed client

better-auth's own client (`better-auth/client`, on nanostores) is typed from
the server instance in the same project. bun-node's typed-client plan gives
any project a client from an OpenAPI document. **Measured (E10):** the
`open-api` plugin serves a 3.1.1 document, 77 paths with two-factor, admin
and organisation, and `bun-client generate` turned it into a route map,
`"POST /sign-in/email"` typed by its body.

`./client` is that generated map plus `createAuthClient({ baseUrl })`,
`createClient` over it with cookies included. Generated from the app's own
plugin set by `bun-client generate --module` pointing at a module that builds
the document from the app's `auth`, as bun-ui's jobs client is. The repository
checks it with `check:client`.

Whether to ship one pre-generated map for the default plugin set as well is
Q13.

## 8. bun-security

### 8.1 `authenticate`

`authOperator(auth, { name? })` is `createSecurityApi`'s `authenticate`:
- the session's user becomes the `Operator` (`id` = the user id,
  `sessionId` = the session id, never the token);
- a request without a session is `null`.

`securityUi` and `jobsUi` use the same session through their `authorize`
([§9](#9-authorize-for-the-jobs-and-security-apis-and-uis)).

### 8.2 Step-up

`sessionStepUp(auth, { maxAge: "10m", challenge: (req) => url })` is
`createSecurityApi`'s `StepUpHook`. `verify` holds when the session was
created within `maxAge` of now. A sign-in that needed two factors or a
passkey creates a new session (assumed from the plugins' flow), so a fresh
session is a recent proof.

With `factors: ["two-factor", "passkey"]` it also requires that the session
came from one of them. That needs a field the plugins' hooks write. Whether
1.7 records it without a custom `databaseHooks.session.create` is
**assumed unknown**; PR-A4 measures it. `challenge` names the app's
re-authentication page.

### 8.3 Sign-in protection on better-auth's routes

`authSignInProfiles(auth)` marks better-auth's sign-in routes with bun-security's
`securityProfile("login")`:
- `/sign-in/email`, `/sign-in/username`, the two-factor verify routes as
  `mfa`, and the email-OTP send as `otp`;
- `identify()` reads `username` from the body, through `req.webRequest()`
  ([§4.1](#41-the-body-measured-e5)), so better-auth still gets the body.

**Measured (E13):** better-auth answers a wrong password and a missing
account alike: `401` with the same body (`INVALID_EMAIL_OR_PASSWORD`) and
the same median time over ten tries each (64.4 ms). bun-security counts a
`401` as a failure, so its outcome inference works with nothing more, and
uniform answers are better-auth's own. bun-security's
`uniformAuthResponse` is not needed on these routes.

### 8.4 Rate limits and bans: one owner each

When bun-security is installed:
- **Rate limits:** bun-security owns them. better-auth's limiter keys on an
  unverified header and keeps per-process memory (E7), so with both on, the
  same sign-in is counted twice by two rules.
- **What bun-auth does:**
  - warns once when both are on;
  - recommends `rateLimit: { enabled: false }` in the README;
  - never changes the setting itself (Q3).
- **Without bun-security:** better-auth's limiter stays.
  `authRateLimitStorage(cache)` gives it a `customStorage` on bun-cache, so
  its counts are shared across processes and instances instead of one
  process's `Map`. Its client address is the one `mountAuth` sets
  ([§4.2](#42-the-client-address)).
- **Bans:** bun-security's are network bans (address, subject). better-auth
  admin's are account bans (`banned` on the user). They do different jobs and
  both stay. A bun-security ban answers before better-auth sees the request.

### 8.5 Service identity

bun-security's service identity (a token header, verified by its SHA-256)
stays the way a sibling service calls. Such a call never gets a better-auth
session, and bun-auth never treats a service token as one. A service that
acts for a user forwards the user's address (`forwardsClientIp`). If it must
act **as** the user, it calls `auth.api` in-process with the user's own
headers, or uses better-auth's `api-key` plugin. That choice is the app's
(Q14).

## 9. `authorize` for the jobs and security APIs and UIs

`./authorize` builds the `authorize` callbacks from the session.
- **Rules:** a list of permissions, each granted to a better-auth role (the
  `admin` plugin's `user.role`) or to an organisation's member role
  (`organization` plugin).
- **`authorizeJobsApi(auth, rules)`** is a `JobsApiAuthorize`. It answers
  `{ allow: false, status: 401 }` without a session and `403` without the
  permission. Its context's `action` (`queues:read`, `jobs:retry`, …) is
  matched against the rules.
- **`authorizeUi(auth, rules)`** is bun-ui's `UiAuthorize`, for `jobsUi` and
  `securityUi`.
- **`authorizeSecurityApi(auth, rules)`** is `createSecurityApi`'s
  `authorize`: operator, permission, scope. It maps an organisation to a
  bun-security group or service scope when the app gives that map.

These are typed against those packages' exported types and import nothing
from them at run time (type-only imports), so `./authorize` needs only the
types of the package it targets.

## 10. An admin UI

- **better-auth has none in its open-source packages** (E11). The admin
  plugin is an API.
- `better-auth-ui` is end-user sign-in screens (shadcn).
- `@better-auth/infra` is a "dashboard and analytics plugin", **assumed** to
  report to a hosted dashboard.

A bun-ui `/auth` UI would cover:
- users: list, search, ban, roles, impersonation;
- sessions: list and revoke;
- organisations, members and invitations;
- API keys.

It would be mountable like `/jobs` and `/security` (the kit, the page frame,
mounting in a host page) and talk to better-auth's admin and organisation
endpoints through the typed client of [§7](#7-a-typed-client). That is about
8 to 10 days: as large as the security UI's first two PRs. **Recommendation
(Q9):** a plan of its own once bun-auth's core has landed, not part of v1.

## 11. Tree-shaking and browser safety

Under the user's rule for browser-facing code, `./client` is the only
browser entry:
- ESM, named exports, no module-level side effects, `sideEffects: false`;
- no `node:*`, `bun`, or better-auth server modules in its import graph;
- proved by an `entryIsolation`-style walk and a `treeShaking.test.ts`: a
  one-export app bundled with `Bun.build`, its bytes under a measured bound,
  and a negative control that plants a side effect.

The server entries are Bun-only and need none of this.

## 12. The better-auth version matrix

`scripts/better-auth-matrix.ts`, shaped like `scripts/nest-matrix.ts`:
- `--prepare <version>` copies the repository to
  `../_scratch/bun-node/better-auth-matrix/<version>/`, pins `better-auth`
  and its first-party plugin packages, and installs;
- `--run` runs bun-auth's suite, bun-nest's `./auth` tests and bun-auth's
  consumer-check.

| Column | When |
|---|---|
| the lock (`latest`, 1.7.x) | every gate |
| 1.7.0 (the floor) | every PR touching bun-auth |
| the current `beta` (1.8.0-beta.10 today) | once per merge window; advisory until it is `latest` |
| a new minor | when it ships, before the lock moves |

## 13. Examples and the playground

- **`examples/bun-auth/`:**
  1. `01-serve` (`withAuth` on `Bun.serve`);
  2. `02-common` (`mountAuth`, `requireSession`, CORS);
  3. `03-nest` (`AuthModule`, the guard and decorators);
  4. `04-security` (a session operator, step-up, the sign-in profiles under
     `./testing`'s credential-stuffing simulator, one limiter);
  5. `05-authorize` (the jobs API and UI by role and organisation);
  6. `06-sql` (the adapter on each engine whose URL is set, skipping visibly
     otherwise);
  7. `07-client` (the typed client);
  8. `08-password` (`bunPassword` with a legacy hash re-hashed).

  Each asserts what it shows, and has a negative control.
- **The playground** signs its operators in with better-auth: email and
  password, plus TOTP for step-up. They are the operators of the security
  demo and the jobs UI. The playground mounts `/api/auth`, so the jobs and
  security UIs authorize through it (the user's rule: every finished feature
  reaches the playground).

## 14. PRs in order

| PR | What | Depends on | Estimate |
|---|---|---|---|
| **PR-A0** | bun-common `req.webRequest()`: the request with its body as received ([§4.1](#41-the-body-measured-e5)), with tests over every parse mode and `deferBody` | — | ~1 d |
| **PR-A1** | the package: `.` and `./serve`, `mountAuth`, `withAuth`, the client-address header, the error and limiter warnings, `sessionMiddleware`, `requireSession`, `getAuthSession` and their types; the packaging recipe, consumer-check, tree-shaking test | A0 | ~3.5 d |
| **PR-A2** | bun-nest `./auth`: the module, guard and decorators, the WebSocket handshake | A1 | ~2.5 d |
| **PR-A3** | `./password`: `bunPassword` with the legacy fallback and `onLegacyHash` | A1 | ~0.5 d |
| **PR-A4** | `./security`: `authOperator`, `sessionStepUp` (and the freshness measurement), `authSignInProfiles`, `authRateLimitStorage` | A1 | ~3 d |
| **PR-A5** | `./authorize`: the jobs API, the UIs and the security API, by role and organisation | A1 | ~1.5 d |
| **PR-A6** | `./sql`: the bun-sql adapter on four engines ([`sql-adapter.md`](sql-adapter.md)) | A1 | ~5 d |
| **PR-A7** | `./client`: the generated route map, `createAuthClient`, `check:client`, browser-safety and tree-shaking tests | A1 | ~2 d |
| **PR-A8** | `scripts/better-auth-matrix.ts` and its columns in CLAUDE.md | A1 | ~1.5 d |
| **PR-A9** | `examples/bun-auth/` and the playground's sign-in | A2 to A7 | ~3.5 d |
| | **Total** | | **~24 d** |

A2 to A8 can run side by side once A1 lands.

## 15. Names

**Approved by the user, 2026-11-20.**

| Names | Where |
|---|---|
| the package `@kingsleyweb/bun-auth`; entries `.`, `./serve`, `./security`, `./authorize`, `./sql`, `./password`, `./client` (each also under `./lib/`) | new package |
| `mountAuth(app, auth, options)`, `authHandler(auth, options)`, `sessionMiddleware(auth)`, `requireSession(auth, { roles?, organization? })`, `getAuthSession(req)`; types `AuthSession<A>`, `AuthRequest<A>`, `BunAuthOptions`, `RequireSessionOptions` | `.` |
| `BunAuthOptions`: `basePath` (default the instance's), `clientIpHeader` (default `x-bun-auth-client-ip`), `warn` (default `true`) | `.` |
| `withAuth(auth, fetch, options)` | `./serve` |
| `authOperator(auth, options)`, `sessionStepUp(auth, { maxAge, factors?, challenge })`, `authSignInProfiles(auth, options)`, `authRateLimitStorage(cache, options)` | `./security` |
| `authorizeJobsApi(auth, rules)`, `authorizeUi(auth, rules)`, `authorizeSecurityApi(auth, rules, { scopes? })`, `roleRules(...)`; type `AuthRule` | `./authorize` |
| `bunSqlAdapter({ sql \| url, adapter?, prefix? })` | `./sql` |
| `bunPassword({ algorithm?, onLegacyHash? })` | `./password` |
| `createAuthClient({ baseUrl, fetch? })`; type `AuthRoutes` | `./client` |
| `req.webRequest()` | bun-common `BunRequest` |
| `webRequestSource(request)`; type `WebRequestSource` (`"original" \| "retained" \| "decoded" \| "parsed" \| "none"`): added in PR-A0, approved by the user (2026-11-26) | bun-common `.` |
| `AuthModule.forRoot({ auth, global? })`, `AuthGuard`, `@Session()`, `@CurrentUser()`, `@AllowAnonymous()`, `@RequireRoles(...)`, `@InjectAuth()`, the `AUTH` token | bun-nest `./auth` |
| `scripts/better-auth-matrix.ts` (`--prepare`, `--run`, `--list`, `--dir`) | repository |
| `examples/bun-auth/` | repository |

## 16. Open questions

Each has a recommendation; **the user accepted all fourteen recommendations (2026-11-20)**, so each is decided as recommended.

1. **The name and the peer range.** `@kingsleyweb/bun-auth`, peer
   `better-auth >=1.7.0 <2`? *Recommended:* yes. 1.7 is `latest` and brings
   the `open-api` plugin; a 2.0 is reviewed when it ships.
2. **The body hand-over.** Add `req.webRequest()` to bun-common (PR-A0),
   rather than require `deferBody` or rebuild the request inside bun-auth?
   *Recommended:* yes. It is the only way that is both exact and independent
   of the adapter's options, and bun-security's sign-in profile needs it too.
3. **Rate limiting with bun-security.** bun-security owns limits when it is
   installed; bun-auth warns when better-auth's limiter is also on and never
   switches it off itself? *Recommended:* yes. Without bun-security, offer
   `authRateLimitStorage` on bun-cache.
4. **The client address.** bun-auth sets `x-bun-auth-client-ip` from
   `req.clientAddress`, strips any incoming copy, and asks the app to name it
   in `ipAddressHeaders`, warning when it does not? *Recommended:* yes.
   better-auth's default reads an unverified `X-Forwarded-For` (E7).
5. **Errors.** Recommend `onAPIError: { throw: true }` and warn without it,
   rather than require it? *Recommended:* recommend and warn. bun-auth never
   changes the app's configuration.
6. **`Bun.password`.** Ship `bunPassword()` as opt-in, never the default?
   *Recommended:* opt-in. Existing users' scrypt hashes need the fallback
   (E8), and the default is better-auth's to choose.
7. **The SQL adapter.** Our own on bun-sql, all four engines, rather than the
   community one (Postgres and SQLite only, Unlicense, 0.4.1) or Kysely?
   *Recommended:* our own, conformance-tested against better-auth's
   `@better-auth/test-utils/adapter` cases (or a port of them if they will
   not run under `bun test`; see [`sql-adapter.md`](sql-adapter.md)).
8. **Typed `req.user`.** `AuthRequest<typeof auth>` and `getAuthSession` now,
   and bun-common typed overloads narrowing `req` after `requireSession`
   later? *Recommended:* yes. The overload change is bun-common's generated
   code and its own PR.
9. **An admin UI.** A bun-ui `/auth` (users, sessions, organisations, roles,
   API keys), as its own plan once the core lands? *Recommended:* yes, as its
   own plan. better-auth has none (E11).
10. **Telemetry.** Document it and change nothing? *Recommended:* yes. It is
    off by default and needs an endpoint even when enabled (E2).
11. **The version matrix.** 1.7.0 floor, the lock, and the beta as an
    advisory column? *Recommended:* yes.
12. **bun-nest's `./auth`.** In bun-nest with bun-auth as an optional peer,
    as `./security` and `./jobs` are? *Recommended:* yes.
13. **A pre-generated client map.** Ship one for the default plugin set, as
    well as generating per app? *Recommended:* no. The routes depend on the
    app's plugins; a stale map types routes the app does not serve.
14. **Service calls as a user.** Leave acting-as-a-user to the app (in-process
    `auth.api` with the user's headers, or better-auth's `api-key` plugin),
    and keep bun-security's service identity for service-to-service calls?
    *Recommended:* yes. bun-auth never treats a service token as a session.
