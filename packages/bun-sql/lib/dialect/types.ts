/**
 * What differs between the SQL engines (`@kingsleyweb/bun-sql/dialect`):
 * the types. Moved from bun-jobs' `drivers/sql/dialect.ts` (bun-security
 * plan, storage.md §4.2) without the job queue's claim members, which stay in
 * bun-jobs.
 *
 * A driver is written once; everything an engine does its own way —
 * placeholders, JSON columns, upserts, index DDL, transactions — is answered
 * by its dialect. Keeping the list explicit is what makes it possible to say
 * honestly which engines are supported and how.
 */
import type { SQL } from "bun";

/** The engines bun-sql speaks. */
export type SqlAdapter = "postgres" | "mysql" | "mariadb" | "sqlite";

/** One engine's answers. */
export interface SqlDialect {
  /** Which engine this is. */
  readonly name: SqlAdapter;
  /** Renders the 1-based parameter placeholder for a statement. */
  placeholder: (index: number) => string;
  /**
   * Column type for a JSON document stored and read whole: `JSON` on
   * Postgres (text, no parse on the way in), MySQL and MariaDB, `TEXT` on
   * SQLite.
   */
  readonly jsonType: string;
  /**
   * Column type for a JSON document the engine may look inside (a policy, a
   * record queried by a field): `JSONB` on Postgres, `JSON` on MySQL and
   * MariaDB (which MariaDB reports as `longtext`), `TEXT` on SQLite. New in
   * bun-sql (bun-security plan, storage.md §4.2).
   */
  readonly documentType: string;
  /**
   * Column type for an IP address or CIDR block where the engine has one —
   * `INET` on Postgres — or `null`, where a caller stores the text form
   * itself. New in bun-sql (storage.md §4.2).
   */
  readonly inetType: string | null;
  /**
   * A partial-index predicate, or `""` on an engine without them.
   *
   * An index over a column that is null for most rows still stores an entry
   * for every one of them, and a queue table is mostly rows that have not run:
   * `lock_expires_at` and `expires_at` are null for all of them. Excluding
   * those rows makes the index hold only what it is asked about, and takes the
   * write off the insert path — measured with the other index changes, 179.1ms
   * against 158.0ms for 5,000 rows.
   *
   * Only safe for a predicate every query on the index implies. Both callers
   * qualify: a lapsed lock is read as `lock_expires_at <= $now`, and expiry as
   * `expires_at IS NOT NULL AND expires_at <= $now`, neither of which can match
   * a null.
   */
  partialIndex: (predicate: string) => string;
  /**
   * `CONCURRENTLY `, or `""` where the engine has no such thing.
   *
   * Building an index normally holds a lock that blocks writes for as long as
   * it takes, which on a queue table means the queue stops. Postgres can build
   * one without that lock at the cost of a second pass. Only used by
   * `syncSchema`: the initial `createSchema` runs against a table that is
   * empty or already in use by this process alone, and `CONCURRENTLY` cannot
   * run inside a transaction.
   */
  readonly concurrentIndex: string;
  /**
   * A query listing the columns of every table in `tables` as `tbl` (the
   * table's name), `name`, `type` and `collation`.
   *
   * Takes the table names as its bind parameters, in the order given, and
   * needs at least one. One query for every table rather than one per table,
   * because connecting reads it each time: measured against 11 tables, one
   * `IN` list took 0.8ms on MariaDB 11.8, 0.9ms on MySQL 8.4 and 1.0ms on
   * Postgres, where a query per table took 4.6ms, 2.3ms and 3.4ms (and a
   * `UNION ALL` of them, 3.0ms, 1.5ms and 3.5ms). A table that does not exist
   * contributes no rows.
   *
   * The `type` is whatever the engine calls it, which is rarely what the DDL
   * said — Postgres answers `character varying` for a `VARCHAR(191)` — so a
   * comparison has to go through {@link SqlDialect.normalizeType}.
   *
   * `collation` is the column's collation where the engine reports one and the
   * driver declares one: MySQL and MariaDB. Elsewhere it is `NULL`, and a sync
   * compares only types.
   */
  describeColumns: (tables: readonly string[]) => string;
  /**
   * A query listing a table's indexes as `name`, `definition` and `columns`.
   *
   * `definition` is the engine's own rendering where it has one, and `''`
   * where it does not; a sync reads a predicate and per-column collations out
   * of it. `columns` is the index's column names in order, comma-separated,
   * where the engine does not render a definition — MySQL and MariaDB — and
   * `NULL` elsewhere, so an index whose columns changed is still noticed there.
   */
  describeIndexes: (table: string) => string;
  /** Adds one column to an existing table. */
  addColumn: (table: string, column: string) => string;
  /**
   * Changes one column's type or collation, or `null` where the engine cannot.
   *
   * Rewrites the table under a lock that blocks everything, so this is never
   * run unless it was explicitly asked for.
   *
   * `suffix` is the rest of the column's definition — `NOT NULL`, a default.
   * MySQL's `MODIFY COLUMN` replaces the whole definition, so leaving it out
   * would silently make a `NOT NULL` column nullable; Postgres changes only the
   * type and ignores it.
   */
  alterColumnType: (
    table: string,
    column: string,
    type: string,
    suffix?: string,
  ) => string | null;
  /**
   * Changes several columns of one table in a single statement, or `null`
   * where the engine cannot.
   *
   * What a sync actually runs. Each `ALTER TABLE` that retypes or recollates
   * a column copies the whole table under a lock, so nine columns changed one
   * statement at a time are nine copies; MySQL, MariaDB and Postgres all apply
   * every clause of one `ALTER TABLE` in a single rewrite.
   */
  alterColumnTypes: (
    table: string,
    columns: readonly AlterColumn[],
  ) => string | null;
  /**
   * Whether `CREATE INDEX` takes `IF NOT EXISTS`.
   *
   * MySQL's does not — MariaDB's and every other engine's here do — so on
   * MySQL an index that already exists makes the statement fail, and creating
   * the schema stays repeatable only because that one failure is recognised by
   * {@link SqlDialect.isDuplicateIndex} and ignored.
   */
  readonly indexIfNotExists: boolean;
  /**
   * Whether an error is "an index by that name already exists", which a
   * repeated `CREATE INDEX` without `IF NOT EXISTS` raises.
   */
  isDuplicateIndex: (error: unknown) => boolean;
  /**
   * Whether an error is another connection creating the same object at the
   * same moment, which a repeated `CREATE … IF NOT EXISTS` then finds made.
   * Postgres's `IF NOT EXISTS` is not atomic against itself: two sessions
   * creating one table both pass the check, and the loser fails on the
   * catalog's unique index (`23505` on `pg_type_typname_nsp_index`) or with
   * `42710` (duplicate object). The other engines serialise DDL, so for them
   * this is always `false`.
   */
  isConcurrentCreate: (error: unknown) => boolean;
  /** Drops an index. MySQL needs the table; the others do not. */
  dropIndex: (name: string, table: string) => string;
  /**
   * The engine's name for a type, reduced to something comparable.
   *
   * Conservative on purpose: anything it cannot confidently reduce is left
   * alone, so two spellings of one type read as equal rather than provoking a
   * table rewrite. A missed change costs an optimisation; a wrong one costs an
   * outage.
   */
  normalizeType: (type: string) => string;
  /**
   * Column type for an identifier: an id, a queue, a state, a key, a token.
   *
   * Identifiers are compared exactly — case, accents and trailing spaces
   * included — and ordered by code point, on every engine. Postgres and
   * SQLite's default collations are already exact for equality, so `TEXT` is
   * enough there. MySQL and MariaDB default to case- and accent-insensitive
   * collations (`utf8mb4_uca1400_ai_ci` on MariaDB 11), under which `Report`
   * and `report` are one primary key; their type names a binary, `NO PAD`
   * collation explicitly. `NO PAD` because the plain `utf8mb4_bin` pads, which
   * makes `a` and `a ` equal.
   *
   * Bounded on MySQL and MariaDB, whose index keys are: 191 characters is 764
   * bytes in utf8mb4, and the widest key here, three of them plus two
   * integers, stays under InnoDB's 3,072-byte limit. The collation does not
   * change the width.
   */
  readonly idType: string;
  /**
   * Column type for an identifier with no length bound: a job's name.
   *
   * Compared exactly for the same reason as {@link SqlDialect.idType} — a
   * claim that skips `Report` must not skip `report` — but never indexed, so
   * it need not be bounded.
   */
  readonly nameType: string;
  /**
   * The collation, as written after `COLLATE`, that orders an identifier
   * column by code point where the column's own collation does not; `null`
   * where it already does.
   *
   * Only Postgres: its `TEXT` sorts by the database's locale, which in
   * `en_US.utf8` puts `a` before `B`, and `"C"` is byte order — for UTF-8,
   * code-point order. SQLite's default `BINARY` and the binary collation
   * {@link SqlDialect.idType} gives MySQL and MariaDB already are. An index
   * carrying it is what lets a code-point range use an index at all.
   */
  readonly codePointCollation: string | null;
  /** Column type for an epoch-millisecond timestamp. */
  readonly timeType: string;
  /** Column type for an auto-incrementing primary key. */
  readonly serialType: string;
  /**
   * Column type for free text of any length: a job's log line.
   *
   * `TEXT` everywhere except MySQL and MariaDB, where `TEXT` stops at 64KB and
   * a longer value is an error in strict mode — one stack trace logged whole
   * is enough to hit it. `MEDIUMTEXT` holds 16MB.
   */
  readonly longTextType: string;
  /**
   * An expression that is `column`, a JSON object, with `key` set to the
   * integer bound at `placeholder`.
   *
   * Used to keep a job's `opts.priority` in step with its `priority` column
   * without reading the document back first. The value is cast to an integer
   * in the expression, because the clients bind numbers as doubles on some
   * engines and the document would otherwise say `1.0`.
   */
  jsonSetInteger: (column: string, key: string, placeholder: string) => string;
  /**
   * An integer read out of the JSON object in `column` at `key`, as an
   * expression that compares with `=` against a bound number.
   *
   * A queue-state entry keeps its version inside its document, and the
   * compare-and-set is a `WHERE` on it. The field is extracted rather than the
   * document compared because Postgres' `json` type has no equality operator
   * at all, and cast to an integer because each engine's extraction otherwise
   * yields its own text or JSON type.
   */
  jsonInteger: (column: string, key: string) => string;
  /**
   * Wraps a placeholder bound to JSON text so the engine stores the document
   * it holds, not a JSON string containing it.
   *
   * Only Postgres needs it: bound as untyped text into a `json` or `jsonb`
   * column, the text is stored as a JSON *string*, and extracting a field from
   * a string yields `NULL`. `jsonOut` parses twice, so whole-document reads
   * never notice — {@link SqlDialect.jsonInteger} does. MySQL parses a string
   * assigned to a `JSON` column, and SQLite stores text either way.
   */
  jsonParameter: (placeholder: string) => string;
  /**
   * An expression that is `column`, a JSON object, with each `[key,
   * placeholder]` of `entries` set to the JSON value whose *text* is bound at
   * that placeholder — a number, a boolean or a whole object, which replaces
   * the key's old value entirely (no merge into an old object).
   *
   * Used by the pending-options rewrite to write the options a queue's stored
   * defaults change, in one statement per batch, without re-encoding the rest
   * of the document in JavaScript. Keys are the driver's own option names,
   * inlined; values always travel as parameters. Placeholders appear once
   * each, in `entries` order, so positional (`?`) binding holds. `column` may
   * be an expression, but it can be repeated, so it must carry no positional
   * placeholder of its own.
   *
   * Postgres merges with `||` on `jsonb`, which replaces top-level keys whole
   * (and unwraps a document stored as a JSON string first, as
   * {@link SqlDialect.jsonSetInteger} does); MySQL and MariaDB use one
   * multi-path `JSON_SET` with each value parsed by `JSON_EXTRACT(?, '$')`
   * (MariaDB, whose `JSON` is text, would otherwise store an object as a
   * string); SQLite a multi-path `json_set` over `json(?)`.
   */
  jsonSetValues: (
    column: string,
    entries: readonly (readonly [key: string, placeholder: string])[],
  ) => string;
  /**
   * An expression that is `column`, a JSON object, with the integer at `key`
   * OR-ed with `bit` — when `key` holds a number. A document without that
   * key, or with a non-number there, comes back unchanged.
   *
   * `updateJob` uses it to mark an operator's per-job priority explicit in
   * `opts.explicit` without reading the row first. "Only where a number is
   * already stored" is the rule, not a convenience: a job added before the
   * mask existed has none, and a mask of only this bit would claim every
   * other option of it was defaulted. `column` may be an expression; it is
   * repeated, so it must carry no positional placeholder.
   */
  jsonOrBit: (column: string, key: string, bit: number) => string;
  /**
   * "After `cursor` in a listing's order" — the same predicate for **any**
   * `ORDER BY` of some columns and the id that breaks their ties, in either
   * direction: what a keyset page seeks with (bun-jobs' jobs list).
   *
   * Two shapes, measured on bun-jobs' claim order: a row-value `>=` bound
   * plus a tie-stripping disjunction on Postgres and SQLite, which plan it as
   * an index range, and the nested expansion on MySQL and MariaDB, which do
   * not bound a range scan with a row comparison — with every comparison
   * mirrored for `desc`.
   */
  keysetAfter: (
    bind: (value: unknown) => string,
    cursor: KeysetCursor,
  ) => string;
  /**
   * Text placed after a table name in `FROM` to pin a read to `index`, or
   * `""` where the engine needs no hint.
   *
   * MySQL and MariaDB only. Their choice between `ref` on an index's
   * equality prefix — every row it matches, filtered — and a `range` bounded
   * by {@link SqlDialect.keysetAfter} swings with the
   * statistics, and `ref` makes each keyset page cost the whole walk so far.
   * Measured on 40,000 waiting jobs, a page three quarters in: MariaDB picked
   * `ref` for the covering read and took 21.0ms; `FORCE INDEX` made it a
   * `range`, 1.3ms. MySQL on a 20,000-row table picked `ref` with index
   * condition pushdown for the full read (9.6ms at the halfway page). With
   * the hint every page was a `range` on both.
   */
  indexHint: (index: string) => string;
  /**
   * Whether an error is the engine refusing an {@link SqlDialect.indexHint}
   * because the index it names does not exist (`ER_KEY_DOES_NOT_EXITS`,
   * 1176). Unlike an optimizer-hint comment, `FORCE INDEX` fails the statement
   * then, so a caller retries unhinted rather than failing its work over a
   * missing index. Always `false` where there is no hint.
   */
  isMissingHintedIndex: (error: unknown) => boolean;
  /** Whether `UPDATE … RETURNING` is available. MariaDB's is not. */
  readonly supportsReturning: boolean;
  /** Whether `FOR UPDATE SKIP LOCKED` is available. */
  readonly supportsSkipLocked: boolean;
  /**
   * An insert that silently does nothing when the row exists.
   *
   * `values` are the rendered value expressions, one per column, for a caller
   * that needs more than a bare placeholder in a position (a cast, say).
   * Omitted, each column gets its own placeholder in order.
   */
  insertIgnore: (table: string, columns: string[], values?: string[]) => string;
  /**
   * An insert that reads its rows out of one JSON document.
   *
   * Optional, because only Postgres has the function for it. Where it exists it
   * replaces a multi-row `VALUES`, and the difference is the parameter count:
   * 500 jobs of 24 columns is 12,000 bind parameters as `VALUES` and exactly
   * one this way. Measured, 20,166/s against 29,525/s for the same rows.
   *
   * `columnTypes` describes the record the document is expanded into, one type
   * per column, in `columns` order.
   */
  insertIgnoreFromJson?: (
    table: string,
    columns: readonly string[],
    columnTypes: readonly string[],
  ) => string;
  /**
   * The same insert for several rows at once.
   *
   * One statement per batch instead of one per job: adding 5,000 jobs was
   * 5,000 serially awaited inserts, which is the whole of the gap against
   * libraries that write a batch in one go. Parameters are flattened row by
   * row, so the caller passes `rows * columns` values in that order.
   */
  insertIgnoreMany: (
    table: string,
    columns: readonly string[],
    rows: number,
  ) => string;
  /**
   * The same batch insert with no conflict handling at all.
   *
   * For a caller that has already established every id is free. `ON CONFLICT
   * DO NOTHING` is not a cheap clause — it makes Postgres insert
   * speculatively, taking a token and probing the index before it commits to
   * the tuple, and measured on 5,000 rows that is 134ms against 78ms for the
   * same insert without it. A separate `SELECT` of the taken ids costs far
   * less than the clause does, so asking first and inserting plainly is 49%
   * quicker end to end.
   *
   * The caller must handle a unique violation, because asking first leaves a
   * window: another producer can take one of those ids between the look and
   * the write. That is what {@link SqlDialect.isUniqueViolation} is for.
   */
  insertFromJson?: (
    table: string,
    columns: readonly string[],
    columnTypes: readonly string[],
  ) => string;
  /** {@link SqlDialect.insertFromJson} for engines binding a value per column. */
  insertMany: (
    table: string,
    columns: readonly string[],
    rows: number,
  ) => string;
  /**
   * Whether an error is "that id is already taken".
   *
   * The one error the insert path expects and recovers from, rather than
   * failing the call.
   */
  isUniqueViolation: (error: unknown) => boolean;
  /** An upsert that overwrites the named columns when the row exists. */
  upsert: (
    table: string,
    columns: string[],
    conflict: string[],
    update: string[],
  ) => string;
  /**
   * The alias an upsert may give the row already stored, or `null` where the
   * engine has none.
   *
   * Postgres needs one — unqualified beside `EXCLUDED` its columns are
   * ambiguous — and SQLite accepts the same spelling. MySQL and MariaDB have
   * no alias on `INSERT` at all and read the stored row's columns bare, which
   * is why an analytics merge asks for this rather than assuming either.
   */
  readonly upsertAlias: string | null;
  /** The clause that turns an insert into a merge on the given key columns. */
  upsertOnConflict: (conflict: readonly string[]) => string;
  /**
   * How a merge refers to the value being inserted for `column`.
   *
   * `EXCLUDED.x`, `excluded.x` or `VALUES(x)`. On MySQL and MariaDB the
   * assignments are also evaluated **left to right**, so a merge whose
   * expression reads another column must be written before that column is
   * assigned — see `BUSYNESS_COLUMNS` and `DURATION_STAT_COLUMNS`, whose
   * order exists for exactly that.
   */
  upsertIncoming: (column: string) => string;
  /**
   * The larger of two expressions. `GREATEST` everywhere except SQLite, where
   * the scalar of that meaning is `MAX`.
   */
  greatest: (first: string, second: string) => string;
  /** The smaller of two expressions; {@link SqlDialect.greatest}'s twin. */
  least: (first: string, second: string) => string;
  /**
   * Wraps a subquery selecting ids so it can be used in `IN (…)`. MySQL
   * cannot read the table it is updating without a derived table in between.
   */
  limitedIdSubquery: (select: string) => string;
  /**
   * How many rows a write affected, read off its result.
   *
   * Postgres and SQLite put it in `count`; MySQL and MariaDB in
   * `affectedRows`, counting rows *changed* rather than matched — the same
   * answer `ROW_COUNT()` gives, which is what this used to ask for, in a
   * transaction of its own around every write.
   */
  affectedRows: (result: unknown, connection: SQL) => Promise<number>;
  /**
   * Whether {@link affectedRows} counts rows *changed* rather than matched.
   *
   * MySQL and MariaDB: an `UPDATE` that writes the values a row already holds
   * counts 0, and Bun's client cannot ask for `CLIENT_FOUND_ROWS`. A write that
   * may legitimately change nothing — a lock renewed to the expiry it already
   * has, the same progress twice — then needs a read to tell "matched" from
   * "missed". Postgres and SQLite count matched rows.
   */
  readonly countsChangedRows: boolean;
  /**
   * Whether the engine can push a notification to a waiting connection.
   *
   * Only Postgres, through `LISTEN`/`NOTIFY`. Everywhere else a worker polls to
   * notice a new job, which is why the poll interval sets the tail of the
   * round-trip latency on those engines and not on this one.
   */
  readonly supportsListen: boolean;
  /**
   * Wraps an insert so it also signals `channel` for the rows it writes.
   *
   * The signal rides along with the write rather than following it. A separate
   * `NOTIFY` is a second round trip charged to every `add()` in order to save
   * latency for a consumer that may not even exist; inside the statement it is
   * free. Postgres collapses repeated notifications carrying the same payload
   * within one transaction, so a 500-row insert still delivers exactly one.
   *
   * Returns the statement unchanged on an engine that cannot do it.
   */
  notifyingInsert: (statement: string, channel: string) => string;
  /**
   * Whether a write that selects its rows by a range, rather than by primary
   * key, runs in a {@link transaction} of its own for the isolation level it
   * sets. MySQL and MariaDB: see `transaction` there. A write that names its
   * row by primary key takes a record lock at any level, and runs bare.
   */
  readonly rangedWritesNeedTransaction: boolean;
  /** Runs `fn` inside a transaction. */
  transaction: <T>(sql: SQL, fn: (tx: SQL) => Promise<T>) => Promise<T>;
  /**
   * Refreshes the planner's statistics for a table, or `null` where the engine
   * has no such notion.
   *
   * A queue table is the worst case for a cost-based planner: it goes from
   * empty to thousands of rows in a burst and back again, and autovacuum's
   * defaults are written for tables that change slowly. Measured on Postgres,
   * the claim statement took 25.9ms with stale statistics and 0.668ms with
   * fresh ones — the *same plan* either way, so it is not a plan choice going
   * wrong, and no amount of index work fixes it.
   */
  analyze: (table: string) => string | null;
  /**
   * A query yielding the table's estimated row count as `n`, or `null` where
   * the engine cannot estimate one cheaply.
   *
   * Sizes how often {@link SqlDialect.analyze} is worth running. `ANALYZE` is
   * linear in table size — measured on Postgres, 11.3ms at 5,000 rows and
   * 77.8ms at 50,000 — so a fixed row threshold re-analyses a large table far
   * too often. An *estimate* is the point: this has to be cheap enough to be
   * free, so it reads what the engine already knows rather than counting.
   */
  estimatedRows: (table: string) => string | null;
  /**
   * Decodes a JSON column as the client returned it, exactly once. See
   * "JSON columns" above `parseJson` for the rule every engine follows.
   */
  jsonOut: <T>(value: unknown, fallback: T) => T;
  /**
   * Encodes a value for a JSON column bound as its own parameter: its JSON
   * text, `undefined` as `null`.
   */
  jsonIn: (value: unknown) => string;
  /**
   * Encodes a value for a JSON column that travels *inside* a JSON document —
   * a field of the `json_to_recordset` payload the bulk insert and the batched
   * completion expand — so that it is stored exactly as {@link SqlDialect.jsonIn}
   * would have stored it. See "JSON columns" above `parseJson`.
   */
  jsonEmbed: (value: unknown) => unknown;
  /** Statements run once when the connection opens. */
  readonly pragmas: string[];
}

/** One column an `ALTER TABLE` changes. */
export interface AlterColumn {
  /** The column's name. */
  column: string;
  /** The type it should have, collation included where the driver sets one. */
  type: string;
  /**
   * The rest of its definition — `NOT NULL`, a default. MySQL's `MODIFY
   * COLUMN` replaces the whole definition and needs it; Postgres ignores it.
   */
  suffix?: string;
}

/**
 * Where a listing's page stopped, in the form {@link SqlDialect.keysetAfter}
 * needs it: the order's own columns and the cursor's value for each, then the
 * id that breaks their ties.
 *
 * A **value, not a position**: the predicate compares it, so the row it names
 * need not still be there — the ordinary case on a table that drains, and the
 * whole point of paging by cursor.
 */
export interface KeysetCursor {
  /**
   * The columns the order rests on, in `ORDER BY` order, ahead of the id.
   * At least one, and they must be exactly the `ORDER BY`'s leading terms —
   * a seek derived from anywhere else can drift from the sort it pages.
   */
  columns: readonly string[];
  /** The cursor's value for each of {@link KeysetCursor.columns}, in that order. */
  values: readonly number[];
  /**
   * The expression the order breaks its ties on. Bare `id` for a listing whose
   * `ORDER BY` names it bare, and the collated or cast form (`id COLLATE "C"`,
   * `CAST(id AS BINARY)`) for one that does not: the seek has to compare
   * whatever the sort compares, or the two disagree on a tie.
   */
  idColumn: string;
  /** The id the cursor names, compared against {@link KeysetCursor.idColumn}. */
  id: string;
  /**
   * The direction being walked. `desc` mirrors every comparison, tie-break
   * included, so the seek is the exact reverse of the ascending one.
   */
  direction: "asc" | "desc";
}
