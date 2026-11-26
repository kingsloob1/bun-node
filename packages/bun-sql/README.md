# @kingsleyweb/bun-sql

The SQL layer bun-jobs, bun-cache and bun-security share: what differs
between Postgres, MySQL, MariaDB and SQLite, table and index definitions
rendered to DDL, a schema sync that changes only what cannot stall a running
service unless asked, connection helpers, opaque keyset page cursors, and a
MongoDB index sync.

It is not an ORM. A driver keeps its own tables and statements; bun-sql
answers the questions every driver otherwise answers again, slightly
differently each time: which placeholder, which JSON type, how to upsert,
whether `CREATE INDEX` takes `IF NOT EXISTS`, which index a sync may drop.

The code comes from bun-jobs' SQL driver and bun-cache's connection helpers
([bun-security plan, storage.md §4](../../docs/plans/bun-security/storage.md)).
bun-jobs and bun-cache run on it. bun-jobs' dialect is bun-sql's plus the job
queue's claim members, and bun-cache uses its connection helpers and its
schema sync; each throws its own error class through the `configError` seam.

## Contents

- [Requirements](#requirements)
- [Entry points](#entry-points)
- [Dialects](#dialects)
- [Schemas](#schemas)
- [Schema sync](#schema-sync)
- [Keyset cursors](#keyset-cursors)
- [Connections](#connections)
- [MongoDB indexes](#mongodb-indexes)
- [Errors](#errors)
- [Testing](#testing)

## Requirements

Bun 1.4.2 or later; Bun only, since the connection helpers open `bun`'s
`SQL` client. Its one runtime dependency is `@kingsleyweb/bun-common` (for
`ConfigError` and `Mutex`). `mongodb` is an optional peer, needed only by
`loadMongoClient`.

```bash
bun add @kingsleyweb/bun-sql
```

## Entry points

Every area is a subpath of its own, and the root re-exports them all. The
package declares `sideEffects: false` (proved by
`__tests__/treeShaking.test.ts`), so a bundle keeps only what it imports.

| Import | What it holds |
|---|---|
| `@kingsleyweb/bun-sql` | everything below |
| `@kingsleyweb/bun-sql/dialect` | `dialectFor`, `detectAdapter`, `declaredCollation`; `SqlDialect`, `SqlAdapter` |
| `@kingsleyweb/bun-sql/schema` | `createSchema`, `renderColumn`, `renderIndex`, `renderIndexColumn`; `SchemaDefinition` and its parts |
| `@kingsleyweb/bun-sql/sync` | `syncSqlSchema`, `resolveSyncOptions`, `readColumns`, `compareColumn`, `collationDrift`, `collationDriftWarning`, `createCollationGuard`; `SchemaChange`, `SchemaSyncOptions` |
| `@kingsleyweb/bun-sql/cursor` | `encodePageCursor`, `decodePageCursor`, `keysetAfter` |
| `@kingsleyweb/bun-sql/connection` | `openSqlClient`, `sqlClientOptions`, `resolveConnectionUrl`, `toConnectionUrl`, `takeBooleanParam`, `databaseFromUrl`, `isTransientLockError`, `isPublicKeyRetrievalRefusal`, `withLockRetry` |
| `@kingsleyweb/bun-sql/mongo` | `syncMongoIndexes`, `loadMongoClient` |

## Dialects

`dialectFor(adapter)` answers one engine's way of doing everything engines
disagree about. `detectAdapter(url)` reads the engine from a URL
(`postgres:`, `postgresql:`, `mysql:`, `mariadb:`, `sqlite:`, `file:`, a
path or `:memory:`).

```ts
import { detectAdapter, dialectFor } from "@kingsleyweb/bun-sql/dialect";

const dialect = dialectFor(detectAdapter(url));
await sql.unsafe(dialect.upsert("settings", ["k", "v"], ["k"], ["v"]), ["theme", "dark"]);
```

Among its members:

- **Types**: `idType` (an identifier compared exactly, code-point ordered on
  every engine), `nameType` (the same, unbounded), `timeType`, `serialType`,
  `longTextType`, `jsonType` (a document stored and read whole),
  `documentType` (one the engine may look inside: `JSONB` on Postgres) and
  `inetType` (`INET` on Postgres, `null` elsewhere).
- **Statements**: `insertIgnore`, `insertIgnoreMany`, `insertMany`,
  `insertFromJson` (Postgres: a whole batch as one parameter), `upsert` and
  the parts of a merge (`upsertAlias`, `upsertOnConflict`, `upsertIncoming`),
  `greatest`, `least`, `limitedIdSubquery`, `notifyingInsert`.
- **JSON**: `jsonIn` and `jsonOut` (each value encoded once and decoded
  exactly once, whatever the client hands back), `jsonParameter`,
  `jsonSetInteger`, `jsonInteger`, `jsonSetValues`, `jsonOrBit`.
- **DDL**: `addColumn`, `alterColumnType(s)`, `dropIndex`, `partialIndex`,
  `concurrentIndex`, `describeColumns`, `describeIndexes`, `normalizeType`.
- **Behaviour**: `transaction` (READ COMMITTED with lock retries on MySQL and
  MariaDB; `BEGIN IMMEDIATE` behind a process-wide lock on SQLite),
  `affectedRows`, `isUniqueViolation`, `isDuplicateIndex`, `analyze`,
  `estimatedRows`, `keysetAfter`.

Each member's description in `lib/dialect/types.ts` gives the measurement
behind it.

## Schemas

A driver describes its tables as data; `createSchema` renders them, and the
sync compares the same description with the database, so the two cannot
disagree.

```ts
import { createSchema, type SchemaDefinition } from "@kingsleyweb/bun-sql/schema";

const definition: SchemaDefinition = {
  tables: [
    {
      name: "audit",
      primaryKey: [],
      columns: [
        { name: "seq", type: dialect.serialType, retype: false },
        { name: "tenant", type: dialect.idType, suffix: "NOT NULL" },
        { name: "at", type: dialect.timeType, suffix: "NOT NULL" },
        { name: "body", type: dialect.documentType },
      ],
    },
  ],
  indexes: [{ name: "ix_audit_tenant", table: "audit", columns: ["tenant", "at"] }],
};

for (const statement of createSchema(definition, dialect)) {
  try {
    await sql.unsafe(statement);
  } catch (error) {
    if (!dialect.isDuplicateIndex(error)) throw error; // MySQL: no IF NOT EXISTS
  }
}
```

- Every statement is repeatable: `CREATE TABLE IF NOT EXISTS`, and
  `CREATE INDEX IF NOT EXISTS` where the engine has it.
- `{ existing }` names tables that were already there, whose indexes are
  left to the sync (a plain `CREATE INDEX` on a large, busy table blocks its
  writes).
- `retype: false` exempts a column whose declared type is not what the engine
  reports back (`BIGSERIAL PRIMARY KEY` comes back as `bigint`).
- An index name or table missing, or an index on a table the definition does
  not define, throws `ConfigError`.

## Schema sync

`createSchema` cannot change a table that exists, so a schema improvement
reaches new installs only. `syncSqlSchema` is how an existing database gets
it.

```ts
import { resolveSyncOptions, syncSqlSchema } from "@kingsleyweb/bun-sql/sync";

const backend = {
  all: async <T>(text: string, params: unknown[]) => (await sql.unsafe(text, params)) as T[],
  run: (text: string) => sql.unsafe(text),
};
const plan = await syncSqlSchema(backend, dialect, definition, resolveSyncOptions({ dryRun: true }));
```

**Safe by default.** Adding a column, creating an index and dropping one
cannot stall a running service on Postgres (`CONCURRENTLY`), MySQL or MariaDB
(an online build), so a sync makes them. SQLite's index build locks out
writers, so its `create-index` changes say `blocking: true`. Changing a
column's type or collation rewrites the table under a lock that blocks every
reader and writer, so it is reported `blocking: true` and applied only with
`alterColumns: true`.

| Option | Default | |
|---|---|---|
| `add` | `true` | add missing columns and indexes |
| `indexes` | `true` | drop the driver's retired indexes, rebuild a changed one |
| `alterColumns` | `false` | retype or recollate columns (blocking) |
| `dryRun` | `false` | report every change, apply none |

Every change comes back as a `SchemaChange` (`kind`, `table`, `target`,
`statement`, `reason`, `blocking`, `applied`, and `collation` for an
identifier in the wrong collation), so a dry run is a plan.

**It only drops indexes it named**: names starting `ix_`, the convention a
driver names its own indexes by. An index added by hand is never touched.
Every table the definition lists is read, so a table whose last `ix_` index
left the definition still has it dropped.

On MySQL and MariaDB an identifier column in a case-insensitive collation is
a correctness problem, not a storage one. `collationDrift` lists such columns
from `readColumns`' result, `collationDriftWarning` words the warning, and
`createCollationGuard(name)` makes sure a process says it once per set of
tables.

## Keyset cursors

A cursor says where a walk stopped, as a value, so the next page seeks past
it instead of counting rows. It is opaque and minted by the server, bound to
its walk (a cursor from another listing, filter or order is refused), and a
bad one throws `ConfigError`, never a quiet page one.

```ts
import { decodePageCursor, encodePageCursor, keysetAfter } from "@kingsleyweb/bun-sql/cursor";

const next = encodePageCursor("au1.", "audit", [tenant], [last.at, last.id]);
const [at, id] = decodePageCursor(cursor, "au1.", "audit", [tenant], ["number", "string"]);

const params: unknown[] = [tenant];
const bind = (value: unknown) => (params.push(value), dialect.placeholder(params.length));
const rows = await sql.unsafe(
  `SELECT * FROM audit WHERE tenant = ${dialect.placeholder(1)}
     AND ${keysetAfter(dialect, bind, { columns: ["at"], values: [at], idColumn: "id", id, direction: "asc" })}
   ORDER BY at, id LIMIT 50`,
  params,
);
```

`keysetAfter` writes the seek each engine plans as an index range: a
row-value bound on Postgres and SQLite, the nested expansion on MySQL and
MariaDB.

## Connections

```ts
import { openSqlClient, withLockRetry } from "@kingsleyweb/bun-sql/connection";

const sql = openSqlClient("mysql", { url: process.env.DATABASE_URL }, "The audit store", { max: 10 });
await withLockRetry(() => sql.unsafe("UPDATE …"));
```

- A connection is a URL or fields (`{ connection: { host, port, user,
  password, database, tls, params, hosts } }`); a URL wins when both are given.
- **MySQL's `allowPublicKeyRetrieval`**: Bun ignores it in a URL and honours
  it only as a client option, so `sqlClientOptions` takes the URL parameter
  out and passes it as the option. Nothing authenticates the key the server
  sends: prefer TLS in production.
- `withLockRetry` retries what every engine reports as "the timing was
  wrong" (a deadlock, a lock wait timeout, a serialization failure,
  `SQLITE_BUSY`), with jitter, for up to 12 attempts; anything else is rethrown at
  once.

## MongoDB indexes

```ts
import { syncMongoIndexes } from "@kingsleyweb/bun-sql/mongo";

const changes = await syncMongoIndexes(db, {
  indexes: [
    { collection: "audit", key: { tenant: 1, at: -1 } },
    { collection: "audit", key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ],
  retired: [{ collection: "audit", name: "at_1" }],
});
```

MongoDB names an index after its key pattern, so one a driver no longer
defines looks exactly like one an operator added by hand. **An index is
dropped only when the `retired` list names it.** The same options as the SQL
sync apply (`alterColumns` has nothing to mean here). The database is passed
in, typed structurally; `loadMongoClient(what)` loads the optional
`mongodb` peer on first call for a caller that opens its own client.

## Errors

An unusable argument throws bun-common's `ConfigError` (`details` carries the
offending values). Every refusing function takes a `configError` option, so a
package built on bun-sql throws its own class with the same messages:

```ts
const dialect = dialectFor("mysql", {
  configError: (message, details) => new MyConfigError(message, details),
});
```

## Testing

```bash
bun run test            # the suite, in parallel
bun test --randomize    # serially, in a random order
```

SQLite always runs. The server suites read `BUN_SQL_TEST_POSTGRES_URL`,
`BUN_SQL_TEST_MYSQL_URL`, `BUN_SQL_TEST_MARIADB_URL` and
`BUN_SQL_TEST_MONGODB_URL`, falling back to bun-jobs' `BUN_JOBS_TEST_*_URL`
(`bun scripts/setup-databases.ts --print-env` from the repository root). An
unset URL skips its engine visibly; a set but unreachable one fails, named.
Every table or collection a run makes is prefixed `bun_sql_test_<pid>_` and
dropped by its exact name.

## License

MIT
