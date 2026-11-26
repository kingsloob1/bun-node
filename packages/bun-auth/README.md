# @kingsleyweb/bun-auth

[better-auth](https://www.better-auth.com) on bun-node. The app brings its own
`betterAuth({...})` instance; bun-auth mounts it on bun-common (or a plain
`Bun.serve`), puts the session typed from that instance on the request, and
guards routes with it.

It does not do authentication: better-auth does. What bun-auth adds is the
fitting ([plan](../../docs/plans/bun-auth/README.md)):

- **the body as received.** bun-common reads a request's body before the
  first handler, so handing better-auth `req.request` fails with `Body
  already used`. bun-auth hands over `req.webRequest()`, whatever the
  adapter's body options;
- **the client's address bun-common resolved**, through `trustProxy`, in a
  header bun-auth sets, rather than an `X-Forwarded-For` any client can send;
- **a typed session** on the request, and a guard answering `401` and `403`
  as problem+json;
- **warnings** for the settings that hide errors, trust a forgeable address,
  lose the body's bytes or count a sign-in twice.

bun-auth never changes the app's better-auth configuration. It reads it.

## Contents

- [Requirements](#requirements)
- [Entry points](#entry-points)
- [Quick start](#quick-start)
- [The recommended configuration](#the-recommended-configuration)
- [Mounting](#mounting)
- [The session on the request](#the-session-on-the-request)
- [A plain Bun.serve](#a-plain-bunserve)
- [A SQL database](#a-sql-database)
- [Passwords on Bun.password](#passwords-on-bunpassword)
- [Warnings](#warnings)
- [Errors](#errors)
- [Telemetry](#telemetry)
- [Testing](#testing)

## Requirements

Bun 1.4.2 or later; Bun only. `better-auth` `>=1.7.0 <2` and
`@better-auth/core` (the same range) are required peers: the app's own
install. Its one runtime dependency is `@kingsleyweb/bun-common`.
`@kingsleyweb/bun-security` and `@kingsleyweb/bun-sql` are optional peers.

```bash
bun add @kingsleyweb/bun-auth better-auth
```

**better-auth's own types need the DOM lib.** Its declarations name DOM
globals (`HeadersInit`, `JsonWebKey`) that Bun's types do not declare
globally, so an app that type-checks its dependencies (`skipLibCheck: false`)
with `lib: ["ESNext"]` gets 25 errors inside better-auth (1.7.27), with or
without bun-auth. Add `"DOM"` to `lib`:

```jsonc
{ "compilerOptions": { "lib": ["ESNext", "DOM"], "types": ["bun"] } }
```

(or keep `skipLibCheck: true`, `bun init`'s default). The repository's
consumer check runs bun-auth's consumers that way (`consumerLib: ["DOM"]` in
its `consumer-check.json`).

## Entry points

| Entry | What |
|---|---|
| `@kingsleyweb/bun-auth` | `mountAuth`, `authHandler`, `sessionMiddleware`, `requireSession`, `getAuthSession`, `DEFAULT_CLIENT_IP_HEADER`; the types `AuthInstance`, `AuthSession`, `AuthRequest`, `BunAuthOptions`, `RequireSessionOptions` |
| `@kingsleyweb/bun-auth/serve` | `withAuth` for a plain `Bun.serve`; the type `ServeServer` |
| `@kingsleyweb/bun-auth/password` | `bunPassword`, better-auth's password hashing on `Bun.password`, and `isBunPasswordHash`; the types `BunPasswordOptions`, `BunPasswordAlgorithm`, `BunPasswordHooks`, `LegacyHashEvent` |
| `@kingsleyweb/bun-auth/sql` | `bunSqlAdapter`, better-auth's database adapter on bun-sql (an optional peer this entry needs); the types `BunSqlAdapter`, `BunSqlAdapterOptions`, `AuthSchemaChange` |

Each is also under `./lib/` (`@kingsleyweb/bun-auth/lib/serve`). Later
entries (`./security`, `./authorize`, `./client`) are
described in the plan and added as they land.

## Quick start

```ts
import { betterAuth } from "better-auth";
import { BunHttpAdapter } from "@kingsleyweb/bun-common";
import type { AuthRequest } from "@kingsleyweb/bun-auth";
import { DEFAULT_CLIENT_IP_HEADER, mountAuth, requireSession } from "@kingsleyweb/bun-auth";

export const auth = betterAuth({
  database, // the app's own
  emailAndPassword: { enabled: true },
  onAPIError: { throw: true },
  advanced: { ipAddress: { ipAddressHeaders: [DEFAULT_CLIENT_IP_HEADER] } },
});

const app = new BunHttpAdapter(3000, { trustProxy: "loopback" });
mountAuth(app, auth); // app.use("/api/auth", …)
app.get("/me", requireSession(auth), (req: AuthRequest<typeof auth>, res) => {
  res.json({ email: req.user?.email });
});
await app.listen();
```

## The recommended configuration

Two settings of better-auth's, which bun-auth recommends and warns about,
once each at mount, when they are missing:

- **`onAPIError: { throw: true }`.** By default better-auth answers an
  internal error (a database failure) with an empty `500` and prints it to
  the console, bypassing its own `logger` and the app's error handlers. With
  `throw: true` the error reaches bun-common's error handlers like any other.
- **`advanced.ipAddress.ipAddressHeaders: ["x-bun-auth-client-ip"]`**
  (`DEFAULT_CLIENT_IP_HEADER`). By default better-auth reads the client's
  address from `X-Forwarded-For`, which any client can send: a new forged
  address per attempt is never rate-limited. bun-auth removes any copy of
  its header a client sent and sets it to `req.clientAddress`, the client
  bun-common resolved through `trustProxy`. With the header named there,
  better-auth's limiter and the session's `ipAddress` use it. Measured on
  better-auth 1.7.27 (the plan's evidence E15): six wrong sign-ins from one
  client, each with a new `X-Forwarded-For`, were limited after the third
  with the header named, and never without it.

  Name only this header there. With `trustedProxies` also set, a client
  whose own address falls inside one of its ranges is resolved to no address
  at all (E15); bun-auth's header carries one address, so better-auth needs
  no `trustedProxies` to read it. better-auth records an IPv6 client by its
  `/64` (its `ipv6Subnet`).

When bun-security is installed, let it own rate limiting and set
`rateLimit: { enabled: false }` in better-auth (see [Warnings](#warnings)).

## Mounting

`mountAuth(app, auth, options?)` registers `authHandler(auth, options)` with
`app.use(basePath, …)` on a bun-common router or adapter. The handler:

1. takes the request with its body as received (`req.webRequest()`): the
   original when unread (`deferBody`), else rebuilt from the bytes kept
   (the adapter's default), else, with `retainBuffer: false`, rebuilt from
   the parsed value. better-auth reads such a rebuilt JSON or form body
   correctly, but not byte for byte, so bun-auth warns once;
2. sets the client-address header;
3. hands it to `auth.handler`, and sends its answer as it is, every
   `Set-Cookie` kept. better-auth's `4xx` answers are answers, never errors.

Mount it after any CORS middleware (better-auth answers no preflight) and
ahead of the routes that need a session.

| `BunAuthOptions` | Default | What |
|---|---|---|
| `basePath` | the instance's | The path the handler answers under on this router: the path of the instance's `baseURL` when it has one, else its `basePath`, else `/api/auth`. Set it when the router is mounted under a prefix, or when the base URL comes from `BETTER_AUTH_URL`, which bun-auth does not read. |
| `clientIpHeader` | `x-bun-auth-client-ip` | The header bun-auth sets to the client's address. |
| `warn` | `true` | Log the warnings below. Errors are logged either way. |
| `logger` | the router's (`mountAuth`), else bun-common's console logger | Any logger bun-common accepts. Records are named `bun-auth`. |

`authHandler(auth, options?)` is the middleware alone, for registering it
yourself (`app.use("/api/auth", authHandler(auth))`).

## The session on the request

- **`sessionMiddleware(auth)`** looks the session up with
  `auth.api.getSession({ headers })`, in process, and sets `req.session` and
  `req.user`, each `null` without one. It never refuses a request.
- **`requireSession(auth, { roles?, organization? })`** does the same and
  refuses:
  - `401` without a session (`urn:bun-auth:error:UNAUTHORIZED`);
  - `403` when `roles` is given and the user has none of them (the admin
    plugin's `user.role`, which may hold several separated by commas);
  - `403` when `organization` is given (an id, or `true` for any) and the
    session does not have it active (the organization plugin's
    `session.activeOrganizationId`).

  Both refusals are `application/problem+json` (`type`, `title`, `status`,
  `code`, `detail`) with `Cache-Control: no-store`.
- **`getAuthSession<typeof auth>(req)`** reads the session again, without a
  lookup: `{ session, user }` or `null`. It throws a `TypeError` when neither
  middleware ran on the request, because "not looked up" is not "signed
  out". It takes the `BunRequest` or its native `Request`.

The lookup happens once per request however many of these run. A failed
lookup (the database is down) goes to the error handlers.

**Typing.** `AuthSession<typeof auth>` is better-auth's own inference
(`typeof auth.$Infer.Session`), so a plugin's fields are typed: with the
admin plugin, `user.role`. `AuthRequest<typeof auth>` is a `BunRequest` with
`session` and `user` typed from the instance; both are optional, so a route
handler can declare its request as one. Narrowing a handler's request
automatically after `requireSession` needs a change to bun-common's typed
overloads, planned separately (plan Q8).

## A plain Bun.serve

```ts
import { withAuth } from "@kingsleyweb/bun-auth/serve";

Bun.serve({
  port: 3000,
  fetch: withAuth(auth, (request) => new Response("app")),
});
```

`withAuth(auth, fetch, options?)` answers requests under the base path with
better-auth's handler and passes every other request to `fetch`. The
client-address header is the socket peer (`server.requestIP()`), so behind a
proxy every client has the proxy's address; mount on bun-common's adapter
with `trustProxy` there instead. An error better-auth throws rejects, for
`Bun.serve`'s `error` handler.

## A SQL database

`bunSqlAdapter` is better-auth's database adapter on
[bun-sql](../bun-sql/README.md): Postgres, MySQL, MariaDB and SQLite through
Bun's own `SQL` client, with no driver to install
([sub-plan](../../docs/plans/bun-auth/sql-adapter.md)).

```ts
import { betterAuth } from "better-auth";
import { bunSqlAdapter } from "@kingsleyweb/bun-auth/sql";

const database = bunSqlAdapter({ url: process.env.DATABASE_URL, syncSchema: true });
export const auth = betterAuth({ database, emailAndPassword: { enabled: true } });
```

```bash
bun add @kingsleyweb/bun-sql
```

| `BunSqlAdapterOptions` | Default | What |
|---|---|---|
| `sql` | | An existing Bun `SQL` client. Never closed by the adapter. |
| `url` | | `postgres://…`, `mysql://…`, `mariadb://…`, `sqlite://path`, a file path or `:memory:`. MySQL's `allowPublicKeyRetrieval=true` is passed as the option Bun honours. |
| `connection` | | The connection as fields, when there is no `url` (needs `adapter`). |
| `adapter` | from the URL or client | `postgres`, `mysql`, `mariadb` or `sqlite`. A `mysql://` URL to a MariaDB server needs `"mariadb"`. |
| `prefix` | `""` | Put before every table name (`auth_user`). |
| `syncSchema` | `false` | Create and sync the tables before the first query: `true`, or bun-sql's `SchemaSyncOptions`. |
| `usePlural` | `false` | better-auth's plural table names. |
| `transaction` | `true` | Run better-auth's multi-step writes in a transaction. |
| `debugLogs` | off | better-auth's adapter debug logs. |
| `max` | Bun's | Pool size of a client the adapter opens. |

The returned adapter is also:

- **`syncSchema(auth.options, sync?)`**: creates better-auth's missing tables
  (its plugins' too) and syncs existing ones by bun-sql's rules: columns and
  indexes are added (a column added to a table that has rows is nullable),
  the adapter's own stale `ix_` indexes dropped, and a column type change only
  with `alterColumns: true`. It returns every change; `{ dryRun: true }`
  plans. better-auth's CLI `generate` writes the same plan as SQL (the
  adapter's `createSchema`).
- **`close()`**: closes the client it opened from `url` or `connection`.

**Column types.** Identifiers (ids, references, unique, indexed or sortable
strings) are bun-sql's: `TEXT`, or on MySQL and MariaDB `VARCHAR(191)` in a
binary collation, so they compare exactly; dates are `TIMESTAMPTZ(3)`,
`DATETIME(3)`, or ISO 8601 text on SQLite; JSON is `JSONB`, `JSON`, or
`TEXT`. Unique fields get unique indexes. There are no foreign keys:
better-auth deletes a user's sessions and accounts itself.

**Atomic operations.** `consumeOne` (single-use tokens) and `incrementOne`
(guarded counters, two-factor backup codes) are one statement on Postgres and
SQLite, and a `SELECT … FOR UPDATE` and the write in one transaction on MySQL
and MariaDB, which have no `RETURNING`.

## Passwords on Bun.password

`bunPassword()` hashes better-auth's passwords with `Bun.password` (argon2id
by default) instead of better-auth's own scrypt. It is opt-in: better-auth's
default stays better-auth's choice.

```ts
import { bunPassword } from "@kingsleyweb/bun-auth/password";

export const auth = betterAuth({
  emailAndPassword: {
    enabled: true,
    password: bunPassword({
      onLegacyHash: async ({ rehash }) => {
        await rehash(); // move the user to Bun.password at this sign-in
      },
    }),
  },
});
```

- **Verifying** reads the stored hash's format: `$argon2…$` and bcrypt's
  `$2a$`/`$2b$`/`$2y$` go to `Bun.password.verify`; anything else, which for
  an existing user base is better-auth's own `salt:hash` scrypt form, goes to
  better-auth's `verifyPassword`. `Bun.password.verify` throws on the scrypt
  form, so without this fallback every existing user would be locked out.
- **`onLegacyHash(event)`** is called after a password matches a legacy
  hash: once per successful check, never for a wrong password. `event` names
  the user (`userId`, `accountId`) and the hash, and `rehash()` stores the
  password again as a `Bun.password` hash, so a user base moves over one
  sign-in at a time. An error the callback throws is logged through
  better-auth's logger and does not fail the sign-in.
- **`algorithm`** is what `Bun.password.hash` takes: `"argon2id"`,
  `"argon2i"`, `"argon2d"`, `"bcrypt"`, or one of them with its costs.

better-auth hands the hook only the hash and the password, so `onLegacyHash`
finds the account through better-auth's endpoint context
(`@better-auth/core/context`); called outside a better-auth request, the
event has no user and `rehash()` does nothing.

## Warnings

Each is logged at most once per mount, with a `warning` field naming it:

| `warning` | When |
|---|---|
| `error-handling` | `onAPIError.throw` is not `true`. At mount. |
| `client-address` | better-auth reads the client's address from a header other than bun-auth's (its default `x-forwarded-for` included), and IP tracking is on. At mount. |
| `body-bytes` | The adapter reads bodies without keeping their bytes (`retainBuffer: false` without `deferBody`): at mount for `mountAuth` on an adapter, else at the first request whose body arrives rebuilt from its parsed value. |
| `rate-limit` | better-auth's own limiter is on (`rateLimit.enabled`, or production by default) and bun-security, or a bun-common `throttle()` ahead of the mount, also counted the request: a sign-in is counted twice by two rules. At the first such request. |

For the last, bun-auth loads bun-security lazily, only when better-auth's
limiter is on, and only to ask whether it saw the request; an app without
bun-security loads nothing. bun-auth never turns either limiter off.

## Errors

- With `onAPIError: { throw: true }`, an internal error of better-auth's
  reaches the app's error handlers (`next(error)`), and `withAuth`'s promise
  rejects with it.
- Without it, better-auth answers an empty `500` and prints the error to the
  console itself. bun-auth sends that answer and logs an `error` record
  (`status`, `method`, `path`) to its logger, so it is not lost.
- An option that is invalid, or a value that is not a better-auth instance,
  throws bun-common's `ConfigError` when the mount is made.

## Telemetry

better-auth's telemetry (`@better-auth/telemetry`, a hard dependency of
better-auth) is off by default, and even enabled sends nothing until
`BETTER_AUTH_TELEMETRY_ENDPOINT` is set (the plan's evidence E2). bun-auth
changes nothing there.

## Testing

```bash
bun run check          # bun check
bun run lint           # bun lint
bun run format:check   # bun fmt --check
bun run test           # type-check the tests, then run them in parallel
```

`./sql`'s suites run better-auth's own adapter conformance kit
(`@better-auth/test-utils/adapter`) and a real `betterAuth()` on SQLite and on
each server whose URL is set: `BUN_AUTH_TEST_{POSTGRES,MYSQL,MARIADB}_URL`,
falling back to bun-jobs' `BUN_JOBS_TEST_*_URL` (`bun
scripts/setup-databases.ts --print-env`). An unset URL skips visibly; a set
URL whose server cannot be reached fails. Each run's tables have a prefix of
their own and are dropped by name. The kit depends on test order, so a
`--randomize` order check leaves out `__tests__/sql/conformance.*`.

The other tests run a real `betterAuth()` on better-auth's memory adapter, mounted
on bun-common's adapter under its default body options, `deferBody` and
`retainBuffer: false`, and on a plain `Bun.serve`. `bun
scripts/consumer-check.ts packages/bun-auth` from the repository root checks
the packed package as a consumer sees it.

## License

MIT
