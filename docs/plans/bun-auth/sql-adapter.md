# bun-auth's SQL adapter: better-auth on bun-sql — sub-plan

Part of [the bun-auth plan](README.md) (PR-A6). Status: **plan only**.
**Measured** and **assumed** are used as in the main plan; the measurements
are in [`evidence/`](evidence/README.md), E9.

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
  - dates are stored as epoch milliseconds or the engine's timestamp type, to
    be decided by measurement: better-auth's `supportsDates`.
- **Atomic forms:** `consumeOne` (verification tokens used once) and
  `incrementOne` (counters) as single statements on each engine. They are an
  update with a guard, then `RETURNING` or a re-read inside a transaction on
  MySQL and MariaDB.
- **Transactions** use better-auth's `transaction` option (the adapter
  config's `transaction`) over Bun SQL's `begin`. bun-sql's SQLite dialect
  keeps its one-writer lock.

## Tests

- **better-auth's own adapter cases**, `@better-auth/test-utils/adapter`,
  1.7.27. Its peer is `vitest ^4 || ^5`. Whether it runs under `bun test` is
  **assumed unknown**:
  - if it runs, the suite runs it on each engine whose URL is set;
  - if not, its cases are ported to `bun:test` with a note naming the
    version they came from, and the version matrix re-reads them when
    better-auth moves.
- **A round trip on each engine.** The four servers come from
  `bun scripts/setup-databases.ts`, under `BUN_AUTH_TEST_*_URL`, falling back
  to bun-jobs'. Each suite skips visibly when its URL is unset and fails when
  it is set but unreachable.
  - Sign up, sign in, get the session, sign out.
  - Two factors' backup codes consumed once under concurrency (the negative
    control: a non-atomic `consumeOne` lets two through).
  - An organisation's members listed with `join`.
- **A schema created by the adapter syncs to no change**, on every engine:
  bun-sql's baseline test.

## Estimate

About 5 days:
- the adapter, 2 d;
- the schema and the sync, 1 d;
- the conformance, run or ported, 1.5 d;
- MySQL and MariaDB's `RETURNING`-less paths and collations, 0.5 d.
