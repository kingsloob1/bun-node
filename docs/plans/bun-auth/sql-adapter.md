# bun-auth's SQL adapter: better-auth on bun-sql — sub-plan

Part of [the bun-auth plan](README.md) (PR-A6). Status: **built in PR-A6
(2026-11-26), awaiting review**; what the build decided is in
[Decided in the build](#decided-in-the-build-pr-a6).
**Measured** and **assumed** are used as in the main plan; the measurements
are in [`evidence/`](evidence/README.md), E9 and E16.

## What better-auth asks of an adapter (measured, E9)

`createAdapterFactory({ config, adapter })` (`better-auth/adapters`) is the
API in 1.6, 1.7 and the 1.8 beta.

- **Operations:** `create`, `update`, `updateMany`, `findOne` (with `join`),
  `findMany` (`where`, `limit`, `offset`, `sortBy`, `select`, `join`),
  `delete`, `deleteMany` and `count`; and, optionally, `consumeOne`,
  `incrementOne` (atomic forms the library falls back from when absent) and
  `createSchema` (the CLI's migration).
- **`where`:** a list of `{ field, operator, value, connector }` clauses.
- **The factory** maps model and field names (`modelName`, `fields`, plural
  table names), converts ids, dates, booleans and JSON per the config's
  `supportsDates`, `supportsBooleans`, `supportsJSON` and
  `supportsNumericIds`, and runs the hooks.

## Why our own (Q7)

The community `@ilbertt/better-auth-bun-sql` 0.4.1 speaks Postgres and
SQLite only. It leaves out MySQL and MariaDB because they lack `RETURNING`
(its `dialect.d.ts`). bun-sql already answers that:
- `SqlDialect.supportsReturning`, and its claim-free `insert`/`upsert` forms;
- a `SELECT` after a write where the engine has no `RETURNING`;
- placeholders, JSON columns, upserts, index DDL, the schema sync and the
  connection helpers for all four engines.

It is also what bun-jobs, bun-cache and bun-security already run on.
Building on it is one more consumer of tested code, not a fifth SQL layer.

## Shape

```ts
import { betterAuth } from "better-auth";
import { bunSqlAdapter } from "@kingsleyweb/bun-auth/sql";

export const auth = betterAuth({
  database: bunSqlAdapter({ url: process.env.DATABASE_URL }), // or { sql } with an existing Bun SQL client
});
```

- **The connection:** `url` or `connection` (bun-sql's
  `resolveConnectionUrl`, MySQL's `allowPublicKeyRetrieval` passed as the
  option Bun honours), or an existing `sql` client the adapter never closes.
- **`adapter`** is detected from the URL (`detectAdapter`).
- **Table names** follow better-auth's model names (`user`, `session`,
  `account`, `verification`, and each plugin's own), with an optional
  `prefix`.
- **The schema:**
  - `createSchema` renders better-auth's schema (`getAuthTables`) as bun-sql
    `TableDefinition`s and uses `createSchema` and `syncSqlSchema`, so
    `npx @better-auth/cli migrate` and our own `syncSchema` agree;
  - identifier columns get bun-sql's exact collation on MySQL and MariaDB, as
    bun-jobs' do;
  - dates are stored as the engine's timestamp type, `TIMESTAMPTZ(3)` and
    `DATETIME(3)`, and as ISO 8601 text on SQLite, which cannot bind a `Date`
    (measured, E16).
- **Atomic forms:** `consumeOne` (verification tokens used once) and
  `incrementOne` (counters) as single statements on each engine. They are an
  update with a guard, then `RETURNING` or a re-read inside a transaction on
  MySQL and MariaDB.
- **Transactions** use better-auth's `transaction` option (the adapter
  config's `transaction`) over Bun SQL's `begin`. bun-sql's SQLite dialect
  keeps its one-writer lock.

## Tests

- **better-auth's own adapter cases**, `@better-auth/test-utils/adapter`,
  1.7.27. Its peer is `vitest ^4 || ^5`. It **runs under `bun test`
  unchanged** (measured, E16: Bun resolves `vitest` to `bun:test`), so the
  suite runs all seven of its suites on each engine whose URL is set, and
  nothing is ported.
- **A round trip on each engine.** The four servers come from
  `bun scripts/setup-databases.ts`, under `BUN_AUTH_TEST_*_URL`, falling back
  to bun-jobs'. Each suite skips visibly when its URL is unset and fails when
  it is set but unreachable.
  - Sign up, sign in, get the session, sign out.
  - Two factors' backup codes consumed once under concurrency (the negative
    control: a non-atomic `consumeOne` lets two through). Built: better-auth
    1.7.27 redeems a backup code with `incrementOne` (a compare-and-set on
    `backupCodes`), so the control is a non-atomic `incrementOne`.
  - An organisation's members listed with `join`.
- **A schema created by the adapter syncs to no change**, on every engine:
  bun-sql's baseline test.

## Decided in the build (PR-A6)

- **Column types** are in `lib/sql/schema.ts`'s table. On MySQL and MariaDB
  every string compares exactly: identifiers (an id, a reference, a unique,
  indexed or sortable string) are bun-sql's `idType`, other text
  `MEDIUMTEXT` in the same binary collation.
- **Unique indexes** (`ux_…`) are the adapter's own, created and never
  dropped: bun-sql's `IndexDefinition` has no `unique`. Plain indexes (`ix_…`)
  are bun-sql's to sync.
- **No foreign keys**: bun-sql's definitions have none, MySQL ignores an
  inline `REFERENCES` (E16), and better-auth deletes a user's dependants
  itself. A follow-up could add both to bun-sql's definitions.
- **Quoted identifiers**: better-auth's camelCase columns and `user` table
  need quoting, which bun-sql's sync cannot take (it binds names as catalog
  parameters). bun-sql compares, as a dry run over the names as stored; the
  adapter renders every statement with quoted names.
- **A column a sync adds to an existing table is nullable**, even where
  better-auth requires it: the rows already there have no value, and MySQL
  would fill them with an implicit default silently.
- **`createSchema`** (the CLI's `generate`) writes the sync's own plan as SQL:
  what `syncSchema()` would apply, and a retype only as a comment.
- **`update`** changes every matching row and returns the first, as
  better-auth's Kysely and memory adapters do.
- **Joins** (`advanced.database.joins`) are one query per joined model for
  all the rows, by `IN` on the joining column, grouped back with the
  per-parent limit.
- **Paging**: better-auth's adapter API pages by `limit` and `offset`, not by
  cursor, so bun-sql's keyset cursors have nowhere to go. The adapter orders by
  the sort field and then the id, so offset pages are stable.
- **MySQL and MariaDB's `updateMany`** counts the matching rows under
  `FOR UPDATE` in the update's transaction: their affected-row count is rows
  *changed*, and Bun's client cannot ask for rows matched.
- **SQLite is one connection**: every statement runs under one lock per
  client, a transaction holds it throughout, and a statement from inside the
  transaction's async context runs on.
- **Two bun-sql bugs**, worked around in the adapter: kingsloob1/bun-node#886
  (a bare SQLite path opens a Postgres client) and kingsloob1/bun-node#888
  (a stale `ix_` index survives on a table with no index left).

## Estimate

About 5 days:
- the adapter, 2 d;
- the schema and the sync, 1 d;
- the conformance, run or ported, 1.5 d;
- MySQL and MariaDB's `RETURNING`-less paths and collations, 0.5 d.
