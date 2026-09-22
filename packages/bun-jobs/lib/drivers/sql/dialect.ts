import type { SQL } from "bun";
import { Mutex } from "@kingsleyweb/bun-common";
import { ConfigError } from "../../shared/errors";

/**
 * What differs between the SQL engines.
 *
 * The driver above is written once; everything an engine does its own way —
 * placeholders, JSON columns, how a row is claimed without two workers taking
 * it — is answered here. Keeping the list explicit is what makes it possible
 * to say honestly which engines are supported and how.
 */

/** The engines the SQL driver can talk to. */
export type SqlAdapter = "postgres" | "mysql" | "mariadb" | "sqlite";

/** One engine's answers. */
export interface SqlDialect {
  /** Which engine this is. */
  readonly name: SqlAdapter;
  /** Renders the 1-based parameter placeholder for a statement. */
  placeholder: (index: number) => string;
  /** Column type for a JSON document. */
  readonly jsonType: string;
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
   * A query listing a table's columns as `name`, `type` and `collation`.
   *
   * Takes the table name as its one bind parameter. The `type` is whatever the
   * engine calls it, which is rarely what the DDL said — Postgres answers
   * `character varying` for a `VARCHAR(191)` — so a comparison has to go
   * through {@link SqlDialect.normalizeType}.
   *
   * `collation` is the column's collation where the engine reports one and the
   * driver declares one: MySQL and MariaDB. Elsewhere it is `NULL`, and a sync
   * compares only types.
   */
  describeColumns: (table: string) => string;
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
  /**
   * Whether the claim index names `id` as its last column.
   *
   * Only MySQL. Claim order is `priority, created_at, id`, and InnoDB appends
   * the primary key to every secondary index, so the index already ends in
   * `id` — MariaDB and Postgres (whose index has no such suffix, and plans the
   * tie-break differently) read it in that order. MySQL 8.4 does not use the
   * implicit suffix to satisfy an `ORDER BY`: it reads every row of the queue
   * through the primary key and sorts them, 9.3ms for one job from a queue of
   * 20,000 against 0.29ms with `id` named, and a claim window that skips names
   * is no longer bounded at all. Naming it makes the key 3,068 bytes, inside
   * InnoDB's 3,072.
   */
  readonly claimIndexNamesId: boolean;
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
   * Column type for the attribution stamp's text: the claiming worker's id,
   * key and host (`processed_by_id`, `processed_by_key`, `processed_by_host`).
   *
   * Exact, like {@link SqlDialect.idType}, because a key filter must not match
   * `SVC` for `svc`; but unbounded, like {@link SqlDialect.nameType}, because
   * none is indexed and none is short by rule — a host name may be 253
   * characters — and on MySQL and MariaDB a value too wide for a bounded
   * column is an error, which here would fail the claim itself. Its own member
   * rather than `nameType`: the columns are new, so no install ever created
   * them in an older collation, and they follow neither type's history.
   */
  readonly stampType: string;
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
   * "After `cursor` in claim order" — `(priority, created_at, id)` — in the
   * form this engine bounds an index range with: the predicate the windowed
   * claim resumes with, shared with the pending-options rewrite's keyset walk.
   */
  claimOrderAfter: (
    bind: ClaimStatementOptions["bind"],
    cursor: ClaimCursor,
  ) => string;
  /**
   * Text placed after a table name in `FROM` to pin a read to `index`, or
   * `""` where the engine needs no hint.
   *
   * MySQL and MariaDB only. Their choice between `ref` on the claim index's
   * `(ns, queue, state)` prefix — every row of the state, filtered — and a
   * `range` bounded by {@link SqlDialect.claimOrderAfter} swings with the
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
   * per column, in {@link JOB_COLUMNS} order.
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
   * Builds the statement that claims one job.
   *
   * This is the one query the engines genuinely disagree about, so each
   * writes its own rather than sharing a shape that only looks portable. The
   * requirement is the same everywhere: pick at most one due row, take it,
   * and let a concurrent claimer take a different one.
   */
  claim: (options: ClaimStatementOptions) => string;
  /**
   * The rows a claim may take, as a statement of its own.
   *
   * Needed by engines that cannot return the row they updated: they pick the
   * id first, then update exactly that row. See {@link claimById}.
   */
  claimCandidate: (options: ClaimStatementOptions) => string;
  /** Takes one specific job, for the same engines. */
  claimById: (options: ClaimStatementOptions, id: string) => string;
  /**
   * The last row of the window a claim that skips names looks at from
   * `options.after`, as `priority`, `created_at` and `id` — or no row when the
   * window is not full, which means it reached the end of the queue.
   *
   * The claim only reports what it took. Resuming past the rows it passed over
   * needs to know where they ended, and every name counts here, skipped or not.
   */
  claimWindowEnd: (options: ClaimStatementOptions) => string;
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
   * Whether the claim statement needs a transaction wrapped around it.
   *
   * Postgres does not: its data-modifying CTE is atomic on its own, and the
   * wrapper measured 0.31ms of a 1.16ms claim — 27% for nothing. SQLite does,
   * because `BEGIN IMMEDIATE` *is* its exclusivity, and MySQL and MariaDB do,
   * because their claim is more than one statement.
   */
  readonly claimNeedsTransaction: boolean;
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

/** Postgres' clause changing one column's type. */
function postgresAlterClause({ column, type }: AlterColumn): string {
  return `ALTER COLUMN ${column} TYPE ${type} USING ${column}::${type}`;
}

/** MySQL's clause redefining one column, whose definition it replaces whole. */
function mysqlAlterClause({ column, type, suffix }: AlterColumn): string {
  return `MODIFY COLUMN ${column} ${type}${suffix ? ` ${suffix}` : ""}`;
}

/** What a dialect needs in order to write its claim statement. */
export interface ClaimStatementOptions {
  /** The jobs table. */
  table: string;
  /**
   * Appends a value to the statement's parameters and returns its
   * placeholder. Called in the order the values appear in the statement.
   */
  bind: (value: unknown) => string;
  /** The namespace to claim from. */
  ns: string;
  /** The queue to claim from. */
  queue: string;
  /** The caller's clock. */
  now: number;
  /** The token to stamp on the claimed job. */
  token: string;
  /** The worker doing the claiming. */
  workerId: string;
  /**
   * The claiming worker's key, host and pid, stamped with `workerId` as the
   * attribution stamp (`processed_by_*`). `null` stamps the id alone, clearing
   * whatever key, host and pid an earlier claim stamped, so a stamp is always
   * one claim's whole. Absent names none of the stamp's columns — for a table
   * not yet synced, which does not have them — and leaves the statement
   * byte-identical to one from before they existed.
   *
   * Present, it is bound whether `null` or not, so the claim stays one
   * statement text either way.
   */
  worker?: { key: string; host: string; pid: number } | null;
  /** How long the claim's lock lives. */
  lockMs: number;
  /**
   * How many jobs the statement may take. Defaults to one.
   *
   * A literal, not a bound parameter: it comes from the worker's free slots,
   * never from user input, and every engine here will only plan a `LIMIT` it
   * can see. It is floored at one and rounded down.
   */
  limit?: number;
  /**
   * Job names the claim must pass over. Absent or empty adds nothing to the
   * statement, which is then byte-identical to one without the option — the
   * claim is the hottest statement in the library, and a different text is a
   * different prepared statement.
   */
  excludeNames?: string[];
  /**
   * Where a claim that skips names resumes: only rows after this one in claim
   * order are looked at. Ignored without `excludeNames`; absent or `null`
   * means from the head of the queue.
   */
  after?: ClaimCursor | null;
}

/** A row's place in claim order, which is where a claim can resume from. */
export interface ClaimCursor {
  /** The row's `priority`. */
  priority: number;
  /** The row's `created_at`, in epoch milliseconds. */
  createdAt: number;
  /** The row's id, which orders the rows the two above leave tied. */
  id: string;
}

/**
 * How many waiting rows one pass of a claim that skips names looks at.
 *
 * `name NOT IN (…)` is a filter on the claim index, not a key of it, so on its
 * own the scan walks past every skipped row before reaching one it may take:
 * measured on Postgres with 100,000 of them at the head, 22.1ms against
 * 0.055ms, paid again on every retry while the name stays capped. Bounding the
 * scan caps a pass at this many rows; the driver resumes where the last full
 * window ended, so a job further back is still reached.
 */
export const CLAIM_WINDOW = 1_000;

/** `(?, ?, …)` repeated once per row, for the `?`-placeholder engines. */
/** `($1, $2), ($3, $4), …` for engines that number their placeholders. */
function numberedRows(columns: readonly string[], rows: number): string {
  return Array.from(
    { length: rows },
    (_row, rowIndex) =>
      `(${columns
        .map((_column, index) => `$${rowIndex * columns.length + index + 1}`)
        .join(", ")})`,
  ).join(", ");
}

function anonymousRows(columns: readonly string[], rows: number): string {
  const one = `(${columns.map(() => "?").join(", ")})`;
  return Array.from({ length: rows }).fill(one).join(", ");
}

/** The columns a claim sets, shared by the dialects that write it. */
function claimAssignments(options: ClaimStatementOptions, prefix = ""): string {
  const { bind } = options;

  return [
    `${prefix}state = 'active'`,
    `${prefix}attempts_made = ${prefix}attempts_made + 1`,
    `${prefix}processed_on = ${bind(options.now)}`,
    `${prefix}lock_token = ${bind(options.token)}`,
    `${prefix}lock_expires_at = ${bind(options.now + options.lockMs)}`,
    `${prefix}worker_id = ${bind(options.workerId)}`,
    ...(options.worker === undefined
      ? []
      : [
          `${prefix}processed_by_id = ${bind(options.workerId)}`,
          `${prefix}processed_by_key = ${bind(options.worker?.key ?? null)}`,
          `${prefix}processed_by_host = ${bind(options.worker?.host ?? null)}`,
          `${prefix}processed_by_pid = ${bind(options.worker?.pid ?? null)}`,
        ]),
  ].join(", ");
}

/** How one engine locks, and resumes, the rows its claim picks. */
interface ClaimShape {
  /** Appended to the plain candidate query: `FOR UPDATE SKIP LOCKED`, or `""`. */
  locking: string;
  /**
   * Appended to the windowed candidate query, which joins the window back to
   * the table so only the rows it returns are locked. `null` on an engine with
   * no row locks, where the window is filtered as it is.
   */
  windowLocking: string | null;
  /** A predicate: the row comes after `cursor` in claim order. */
  after: (bind: ClaimStatementOptions["bind"], cursor: ClaimCursor) => string;
}

/**
 * "After `cursor` in claim order", in the form Postgres and SQLite plan as an
 * index range.
 *
 * Not the obvious `(priority, created_at, id) > (…)`. Postgres estimates a row
 * comparison from its first column alone, and with every row on one priority
 * it expects no rows and picks a sequential scan: 29.9ms for a window halfway
 * into 100,000 rows. The two-column `>=` is a bound on columns the claim index
 * has, and the disjunction only removes rows tied with the cursor itself:
 * 0.70ms for the same window. SQLite plans the `>=` as an index range too.
 */
function rowValueAfter(
  bind: ClaimStatementOptions["bind"],
  cursor: ClaimCursor,
): string {
  return `(priority, created_at) >= (${bind(cursor.priority)}, ${bind(cursor.createdAt)})
           AND (priority >${bind(cursor.priority)} OR created_at > ${bind(cursor.createdAt)} OR id > ${bind(cursor.id)})`;
}

/**
 * The same predicate written out column by column, for MySQL and MariaDB.
 *
 * MariaDB does not bound a range scan with a row comparison: the form above
 * read 11,001 index rows for a 1,000-row window starting at row 10,000
 * (19.8ms), and this one read 1,000 (3.4ms). On Postgres it is the reverse —
 * this form is a filter there, not a bound.
 */
function expandedAfter(
  bind: ClaimStatementOptions["bind"],
  cursor: ClaimCursor,
): string {
  return `(priority > ${bind(cursor.priority)} OR (priority = ${bind(cursor.priority)}
           AND (created_at > ${bind(cursor.createdAt)} OR (created_at = ${bind(cursor.createdAt)} AND id > ${bind(cursor.id)}))))`;
}

/** The queue's waiting, due rows, from `options.after` when there is one. */
function claimWindowFilter(
  options: ClaimStatementOptions,
  shape: ClaimShape,
): string {
  const { bind } = options;

  return `ns = ${bind(options.ns)} AND queue = ${bind(options.queue)}
           AND state = 'waiting' AND run_at <= ${bind(options.now)}${
             options.after
               ? `
           AND ${shape.after(bind, options.after)}`
               : ""
           }`;
}

/** The rows a claim may take, ordered so the cheapest comes first. */
function claimCandidates(
  options: ClaimStatementOptions,
  shape: ClaimShape,
): string {
  const { bind, table } = options;

  const limit = Math.max(1, Math.floor(options.limit ?? 1));
  const excluded = options.excludeNames ?? [];

  if (excluded.length === 0) {
    return `SELECT id FROM ${table}
       WHERE ns = ${bind(options.ns)} AND queue = ${bind(options.queue)}
         AND state = 'waiting' AND run_at <= ${bind(options.now)}
       ORDER BY priority ASC, created_at ASC, id ASC
       LIMIT ${limit}${shape.locking}`;
  }

  // Skipped names are a filter, not a key of the claim index: a capped name is
  // the exception, so widening the index for it would tax every insert for a
  // clause most claims never carry. Filtering *outside* a bounded window is
  // what keeps the filter from walking an unbounded run of skipped rows; the
  // driver slides the window with `after`.
  //
  // Built before the text that follows it, because it also comes first in the
  // statement: `bind` numbers placeholders in call order.
  const window = `SELECT id, name, priority, created_at FROM ${table}
         WHERE ${claimWindowFilter(options, shape)}
         ORDER BY priority ASC, created_at ASC, id ASC
         LIMIT ${CLAIM_WINDOW}`;

  if (shape.windowLocking === null) {
    return `SELECT id FROM (${window}) AS win
       WHERE name NOT IN (${excluded.map((name) => bind(name)).join(", ")})
       ORDER BY priority ASC, created_at ASC, id ASC
       LIMIT ${limit}`;
  }

  // Locked through a join back to the table, never inside the window: locking
  // there would lock every row the window passes over, up to a thousand skipped
  // jobs a worker skipping other names could have taken. Postgres locks only
  // `job` because it is named, InnoDB because a derived table is read without
  // locks — checked with two open transactions on MariaDB, the second took the
  // next job rather than nothing. The window is read from the statement's
  // snapshot, so `job.state` is what is rechecked once the row is locked.
  return `SELECT job.id FROM (${window}) AS win
       JOIN ${table} job
         ON job.ns = ${bind(options.ns)} AND job.queue = ${bind(options.queue)}
        AND job.id = win.id
       WHERE win.name NOT IN (${excluded.map((name) => bind(name)).join(", ")})
         AND job.state = 'waiting'
       ORDER BY win.priority ASC, win.created_at ASC, win.id ASC
       LIMIT ${limit}${shape.windowLocking}`;
}

/** Picks the id of the row a claim would take. */
function claimCandidateStatement(
  options: ClaimStatementOptions,
  shape: ClaimShape,
): string {
  return claimCandidates(options, shape);
}

/** See {@link SqlDialect.claimWindowEnd}. */
function claimWindowEndStatement(
  options: ClaimStatementOptions,
  shape: ClaimShape,
): string {
  return `SELECT priority, created_at, id FROM ${options.table}
       WHERE ${claimWindowFilter(options, shape)}
       ORDER BY priority ASC, created_at ASC, id ASC
       LIMIT 1 OFFSET ${CLAIM_WINDOW - 1}`;
}

/**
 * `bit` as the literal a JSON bit-OR inlines: a whole number of at least 1, or
 * a `ConfigError`, since it is written into the statement text rather than
 * bound.
 */
function bitLiteral(bit: number): string {
  if (!Number.isSafeInteger(bit) || bit < 1) {
    throw new ConfigError(`A JSON bit must be a positive integer, not ${bit}`, {
      bit,
    });
  }

  return String(bit);
}

/**
 * Postgres: `column` as a `jsonb` object — `{}` for `NULL`, and a document
 * stored as a JSON *string* (a single-row insert binds untyped text, see
 * {@link SqlDialect.jsonSetInteger}) unwrapped to the object it holds.
 */
function postgresObject(column: string): string {
  const document = `COALESCE(${column}::jsonb, '{}'::jsonb)`;
  return `(CASE WHEN jsonb_typeof(${document}) = 'string' THEN (${document} #>> '{}')::jsonb ELSE ${document} END)`;
}

/** Postgres locks named rows and ranges on a two-column row comparison. */
const POSTGRES_CLAIM: ClaimShape = {
  locking: " FOR UPDATE SKIP LOCKED",
  windowLocking: " FOR UPDATE OF job SKIP LOCKED",
  after: rowValueAfter,
};

/** MySQL and MariaDB: no `OF`, and a range only on the spelled-out predicate. */
const MYSQL_CLAIM: ClaimShape = {
  locking: " FOR UPDATE SKIP LOCKED",
  windowLocking: " FOR UPDATE SKIP LOCKED",
  after: expandedAfter,
};

/** SQLite has no row locks to take. */
const SQLITE_CLAIM: ClaimShape = {
  locking: "",
  windowLocking: null,
  after: rowValueAfter,
};

/** Takes one specific job, conditional on it still being claimable. */
function claimByIdStatement(
  options: ClaimStatementOptions,
  id: string,
): string {
  const { bind, table } = options;

  return `UPDATE ${table} SET ${claimAssignments(options)}
     WHERE ns = ${bind(options.ns)} AND queue = ${bind(options.queue)}
       AND id = ${bind(id)} AND state = 'waiting'`;
}

/** Reads an affected-row count off a result, for engines that report one. */
async function countFromResult(result: unknown): Promise<number> {
  const count = (result as { count?: number } | null)?.count;
  return typeof count === "number" ? count : 0;
}

/** How many times a transient lock failure is retried before giving up. */
const LOCK_RETRIES = 12;

/**
 * Server error numbers that mean "the statement was fine, the timing was not".
 *
 * MySQL and MariaDB report them as a numeric `errno`: 1213 is a deadlock, 1205
 * a lock wait timeout, and 1020 is MariaDB's "record has changed since last
 * read" — what `innodb_snapshot_isolation`, on by default since 11.6, raises
 * when a transaction writes a row another committed after its snapshot.
 * Postgres puts its SQLSTATE in `errno` as a string: `40001` serialization
 * failure, `40P01` deadlock.
 */
const TRANSIENT_ERRNOS = new Set<unknown>([1213, 1205, 1020, "40001", "40P01"]);

/**
 * The same conditions as a `code` or `sqlState`: SQLSTATE `40001` is what
 * MySQL sends alongside 1213, and Postgres's `code` carries the SQLSTATE too.
 */
const TRANSIENT_STATES = new Set<unknown>(["40001", "40P01"]);

/**
 * Whether an error is the database saying "someone else had it, try again".
 *
 * Every engine has one, and they all mean the same thing: the statement was
 * fine, the timing was not. InnoDB breaks a lock cycle by aborting one
 * transaction and telling the loser to retry, Postgres does the same, and
 * SQLite reports `SQLITE_BUSY` when another connection holds the file's single
 * write lock for longer than the busy timeout allows. None is a defect in the
 * query.
 *
 * Walks the `cause` chain, and checks codes before wording. The driver wraps
 * what the server said in a `DriverError` whose own message is only "sql
 * driver failed during run", so the engine's code and message are one or more
 * links down. Checking the outermost error alone never matched anything raised
 * inside a transaction — on MySQL and MariaDB that is every counted write, so
 * the retry around them never fired and each deadlock escaped to the worker.
 */
export function isTransientLockError(error: unknown): boolean {
  for (let at = error, depth = 0; at != null && depth < 5; depth++) {
    if (typeof at !== "object") {
      break;
    }

    const { errno, code, sqlState, message } = at as {
      errno?: unknown;
      code?: unknown;
      sqlState?: unknown;
      message?: unknown;
    };

    if (
      TRANSIENT_ERRNOS.has(errno) ||
      TRANSIENT_STATES.has(code) ||
      TRANSIENT_STATES.has(sqlState) ||
      // `SQLITE_BUSY_SNAPSHOT` and the other extended forms mean the same.
      (typeof code === "string" && code.startsWith("SQLITE_BUSY"))
    ) {
      return true;
    }

    if (
      /deadlock|try restarting transaction|lock wait timeout|could not serialize access|database (?:is|table is) locked/i.test(
        String(message ?? ""),
      )
    ) {
      return true;
    }

    at = (at as { cause?: unknown }).cause;
  }

  return false;
}

/**
 * Retries `work` while the database keeps saying it was busy.
 *
 * Everything reached from here is idempotent or conditional, so repeating it
 * is safe; the backoff is jittered so two losers do not collide again.
 */
export async function withLockRetry<T>(work: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= LOCK_RETRIES; attempt++) {
    try {
      return await work();
    } catch (error) {
      lastError = error;

      if (!isTransientLockError(error)) {
        throw error;
      }

      await Bun.sleep(Math.random() * 15 * attempt);
    }
  }

  throw lastError;
}

/** Serialises SQLite writers inside one process; the file lock does the rest. */
const sqliteWriteLock = new Mutex();

/**
 * Whether an error says a unique constraint was violated.
 *
 * Each engine says so differently — Postgres in SQLSTATE, MySQL with a driver
 * code, SQLite only in the message — and the error reaches here through Bun's
 * SQL client, which surfaces whichever the server gave it.
 */
function isUniqueViolationError(
  error: unknown,
  codes: (string | number)[],
): boolean {
  // The driver wraps what the server said in a `DriverError`, so the engine's
  // own code and message are one or more `cause` links down. Checking only the
  // outermost error would never match, and the insert path would fail a call
  // it is meant to recover from.
  for (let at = error, depth = 0; at != null && depth < 5; depth++) {
    if (typeof at !== "object") {
      break;
    }

    const { errno, code, message } = at as {
      errno?: unknown;
      code?: unknown;
      message?: unknown;
    };

    if (codes.some((wanted) => errno === wanted || code === wanted)) {
      return true;
    }

    if (/unique constraint|duplicate key/i.test(String(message ?? ""))) {
      return true;
    }

    at = (at as { cause?: unknown }).cause;
  }

  return false;
}

/**
 * The collation a declared column type names, lowercased, or `null` when it
 * names none.
 *
 * Read from the driver's own DDL — `VARCHAR(191) CHARACTER SET utf8mb4 COLLATE
 * utf8mb4_nopad_bin` gives `utf8mb4_nopad_bin` — so a sync compares a column's
 * collation only where the driver actually chose one.
 */
export function declaredCollation(type: string): string | null {
  const match = /\bCOLLATE\s+("[^"]+"|[\w.-]+)/i.exec(type);
  return match ? match[1]!.replace(/"/g, "").toLowerCase() : null;
}

/**
 * Reduces a type name to something two spellings of one type share.
 *
 * Deliberately blunt: lowercase, drop any parenthesised length or precision,
 * and any `CHARACTER SET` or `COLLATE` clause (compared separately, through
 * {@link declaredCollation}), collapse whitespace, then map the synonyms
 * engines actually report. Everything else passes through unchanged and
 * therefore compares equal only to itself, which is the safe direction — an
 * unrecognised pair reads as "different" only when the strings really do
 * differ.
 */
/**
 * Whether an error, or one it wraps, carries one of `codes` — the server's own
 * code sits one or more `cause` links below the client's wrapper.
 */
function hasErrorCode(error: unknown, codes: (string | number)[]): boolean {
  for (let at = error, depth = 0; at != null && depth < 5; depth++) {
    if (typeof at !== "object") {
      break;
    }
    const { errno, code } = at as { errno?: unknown; code?: unknown };
    if (codes.some((wanted) => errno === wanted || code === wanted)) {
      return true;
    }
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

function normalizeSqlType(type: string): string {
  const bare = type
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/\b(?:character set|charset)\s+\w+/g, "")
    .replace(/\bcollate\s+(?:"[^"]+"|[\w.-]+)/g, "")
    .trim()
    .replace(/\s+/g, " ");

  const synonyms: Record<string, string> = {
    "character varying": "varchar",
    character: "char",
    int4: "int",
    integer: "int",
    int8: "bigint",
    int2: "smallint",
    bool: "boolean",
    "double precision": "double",
    "timestamp without time zone": "timestamp",
    "timestamp with time zone": "timestamptz",
  };

  return synonyms[bare] ?? bare;
}

/*
 * JSON columns — the one rule.
 *
 * Every JSON column (a job's data, opts, progress, return value, failure and
 * stacktrace, its flow; a queue-state, repeat, kv, event or worker document)
 * is written from `JSON.stringify` of the value and decoded exactly once on
 * the way out. What "exactly once" means depends on what the client hands
 * back, which differs per engine, so the reader is per engine:
 *
 * - **SQLite** stores the text in a `TEXT` column and returns it as text:
 *   `jsonOut` parses it once ({@link parseJson}).
 * - **MySQL and MariaDB**: the engine parses text bound into a `JSON` column,
 *   and Bun's client decodes the column on the way out, so `jsonOut` takes
 *   the value as it comes. Parsing again was a bug — see `mysql.jsonOut`.
 * - **Postgres** is the subtle one. Bun binds a JS string into a `json`
 *   column as a JSON *string*, so the text `{"a":1}` is stored as the JSON
 *   string `"{\"a\":1}"` — an envelope around the value's JSON text — and the
 *   client decodes the column, handing back the text again. `jsonOut` parses
 *   that once. But not every write goes through a bind of its own: the bulk
 *   insert and the batched completion carry the values *inside* one
 *   `json_to_recordset` document, where a value lands as the real JSON it is
 *   — and a real JSON string comes back from the client as the bare string,
 *   indistinguishable from an envelope. Parsing it again threw on `"warm"`
 *   (read back as `null`) and turned `"42"` into `42`.
 *
 *   So on Postgres a JSON column **never holds a bare JSON string**: a string
 *   value is always stored as its envelope. `jsonIn` gets that for free by
 *   binding untyped; a value embedded in a document goes through `jsonEmbed`,
 *   which wraps a string in its envelope and leaves everything else as real
 *   JSON (unambiguous: only a string could be mistaken for text to parse, and
 *   the client decodes an object, number, boolean or null to itself). The
 *   documents written as real JSON on purpose — `jsonParameter`'s queue state
 *   and `jsonSetInteger`'s opts — are always objects, which the rule allows.
 *
 *   The reader, {@link parsePostgresJson}, therefore parses any string once,
 *   and a string that does not parse can only be a bare string an earlier
 *   version's bulk insert or batched completion stored — an envelope is
 *   `JSON.stringify` output and always parses — so it is that value, and is
 *   returned as is. A bare string that *does* parse (`"42"`, `"null"`) is byte
 *   for byte an envelope around a different value, and nothing can tell them
 *   apart; those rows keep reading as the parsed value.
 */

/** Parses a JSON column that arrives as its text: SQLite's reader. */
function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  return value as T;
}

/**
 * Postgres' reader: the client has decoded the column already, and a string is
 * then the envelope around the value's JSON text, parsed once — or, when it is
 * not JSON at all, a bare string an earlier version stored, which *is* the
 * value. See "JSON columns" above.
 */
function parsePostgresJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }

  return value as T;
}

/** Shared behaviour, overridden per engine below. */
const base = {
  jsonOut: parseJson,
  jsonIn: (value: unknown) => JSON.stringify(value ?? null),
  // Only Postgres expands a document into rows; see "JSON columns" above.
  jsonEmbed: (value: unknown) => value ?? null,
  limitedIdSubquery: (select: string) => select,
  pragmas: [] as string[],
} satisfies Partial<SqlDialect>;

/** Postgres: `$n` placeholders, JSONB, and `SKIP LOCKED` for claiming. */
const postgres: SqlDialect = {
  ...base,
  name: "postgres",
  placeholder: (index) => `$${index}`,
  // `json` stores the text; `jsonb` parses it into a binary tree on the way
  // in. Nothing here indexes into `data` or `opts` or uses a `jsonb` operator
  // on them — they are opaque payloads, written once and read whole — so that
  // parse buys nothing and costs, over alternating runs, 12% of the insert.
  // `jsonOut` reads either, so a table created before this still works.
  jsonType: "JSON",
  // See "JSON columns" above: a string is stored in its envelope on every
  // path, and read back by parsing exactly once.
  jsonOut: parsePostgresJson,
  jsonEmbed: (value: unknown) =>
    typeof value === "string" ? JSON.stringify(value) : (value ?? null),
  partialIndex: (predicate) => ` WHERE ${predicate}`,
  concurrentIndex: "CONCURRENTLY ",
  // No collation: every identifier is declared in the default one, and
  // ordering by code point is `codePointCollation`'s job, not the column's.
  describeColumns: () =>
    `SELECT column_name AS name, data_type AS type, NULL AS collation
       FROM information_schema.columns
      WHERE table_name = $1 AND table_schema = ANY (current_schemas(false))`,
  describeIndexes: () =>
    `SELECT indexname AS name, indexdef AS definition, NULL AS columns
       FROM pg_indexes
      WHERE tablename = $1 AND schemaname = ANY (current_schemas(false))`,
  addColumn: (table, column) =>
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column}`,
  alterColumnType: (table, column, type) =>
    `ALTER TABLE ${table} ${postgresAlterClause({ column, type })}`,
  alterColumnTypes: (table, columns) =>
    `ALTER TABLE ${table} ${columns.map(postgresAlterClause).join(", ")}`,
  indexIfNotExists: true,
  isDuplicateIndex: (error) => hasErrorCode(error, ["42P07"]),
  claimIndexNamesId: false,
  dropIndex: (name) => `DROP INDEX CONCURRENTLY IF EXISTS ${name}`,
  normalizeType: normalizeSqlType,
  idType: "TEXT",
  nameType: "TEXT",
  stampType: "TEXT",
  codePointCollation: '"C"',
  timeType: "BIGINT",
  serialType: "BIGSERIAL PRIMARY KEY",
  longTextType: "TEXT",
  // Through `jsonb`, which has the setter, and back: the result is assigned to
  // a `json` column or, on a table created before that became the type, a
  // `jsonb` one, and Postgres converts either way on assignment.
  //
  // A single-row insert binds the document as untyped text, which Postgres
  // stores as a JSON *string* holding the object — `jsonOut` parses it twice,
  // so reads never notice. The setter cannot reach into a string, so one is
  // unwrapped first; what is written back is the object itself.
  jsonSetInteger: (column, key, placeholder) =>
    `jsonb_set(${postgresObject(column)}, '{${key}}', to_jsonb(${placeholder}::integer))`,
  // `||` replaces a top-level key whole, which is what writing an option means:
  // a new `backoff` object does not keep an old one's `factor`. `column` is
  // unwrapped once; every value is bound as text and read as `jsonb`.
  jsonSetValues: (column, entries) =>
    entries.length === 0
      ? column
      : `(${postgresObject(column)} || jsonb_build_object(${entries
          .map(([key, placeholder]) => `'${key}', ${placeholder}::text::jsonb`)
          .join(", ")}))`,
  // Named once through a scalar subquery, so the unwrapping is not repeated
  // for every mention of the object.
  jsonOrBit: (column, key, bit) =>
    `(SELECT CASE WHEN jsonb_typeof(o.v -> '${key}') = 'number'
                  THEN o.v || jsonb_build_object('${key}', (o.v ->> '${key}')::bigint | ${bitLiteral(bit)})
                  ELSE o.v END
        FROM (SELECT ${postgresObject(column)} AS v) AS o)`,
  claimOrderAfter: rowValueAfter,
  indexHint: () => "",
  isMissingHintedIndex: () => false,
  // `->>` works on `json` and on a `jsonb` column left by an older version.
  jsonInteger: (column, key) => `(${column}->>'${key}')::bigint`,
  // `::text` first, so the client's untyped string is read as the document.
  jsonParameter: (placeholder) => `${placeholder}::text::json`,
  supportsReturning: true,
  supportsSkipLocked: true,
  insertIgnore: (table, columns, values) =>
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${(
      values ?? columns.map((_column, index) => `$${index + 1}`)
    ).join(", ")}) ON CONFLICT DO NOTHING`,
  insertIgnoreMany: (table, columns, rows) =>
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${Array.from(
      { length: rows },
      (_row, rowIndex) =>
        `(${columns
          .map((_column, index) => `$${rowIndex * columns.length + index + 1}`)
          .join(", ")})`,
    ).join(", ")} ON CONFLICT DO NOTHING`,
  insertIgnoreFromJson: (table, columns, columnTypes) =>
    // `$1::text::json`, not `$1::json`: the client sends the document as an
    // untyped string, and without the intermediate cast Postgres reads it as a
    // JSON *string* rather than the array it contains.
    `INSERT INTO ${table} (${columns.join(", ")})
     SELECT ${columns.join(", ")}
       FROM json_to_recordset($1::text::json) AS document (${columns
         .map((column, index) => `${column} ${columnTypes[index]}`)
         .join(", ")})
     ON CONFLICT DO NOTHING`,
  insertFromJson: (table, columns, columnTypes) =>
    `INSERT INTO ${table} (${columns.join(", ")})
     SELECT ${columns.join(", ")}
       FROM json_to_recordset($1::text::json) AS document (${columns
         .map((column, index) => `${column} ${columnTypes[index]}`)
         .join(", ")})`,
  insertMany: (table, columns, rows) =>
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${numberedRows(
      columns,
      rows,
    )}`,
  isUniqueViolation: (error) => isUniqueViolationError(error, ["23505", 23505]),
  upsert: (table, columns, conflict, update) =>
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
      .map((_column, index) => `$${index + 1}`)
      .join(", ")}) ON CONFLICT (${conflict.join(", ")}) DO UPDATE SET ${update
      .map((column) => `${column} = EXCLUDED.${column}`)
      .join(", ")}`,
  upsertAlias: "stored",
  upsertOnConflict: (conflict) =>
    `ON CONFLICT (${conflict.join(", ")}) DO UPDATE SET`,
  upsertIncoming: (column) => `EXCLUDED.${column}`,
  greatest: (first, second) => `GREATEST(${first}, ${second})`,
  least: (first, second) => `LEAST(${first}, ${second})`,
  transaction: async (sql, fn) => (await sql.begin(fn as never)) as never,
  /**
   * A CTE, not `IN (SELECT ... LIMIT 1 FOR UPDATE SKIP LOCKED)`.
   *
   * That subquery form looks right and is not: Postgres may re-evaluate the
   * sub-plan, and because `SKIP LOCKED` yields a *different* row each time it
   * is evaluated, the `LIMIT 1` fails to bound the update. Measured, it
   * claimed two jobs and returned one, silently leaving the other `active`
   * with a token nobody held. A data-modifying statement's CTE is evaluated
   * exactly once, so the bound holds.
   */
  claim: (options) => {
    const { bind, table } = options;

    // Built inline, in statement order: `bind` numbers parameters as it is
    // called, so a fragment computed early would be numbered early too.
    return `WITH picked AS (${claimCandidates(options, POSTGRES_CLAIM)})
      UPDATE ${table} SET ${claimAssignments(options)}
        FROM picked
       WHERE ${table}.ns = ${bind(options.ns)}
         AND ${table}.queue = ${bind(options.queue)}
         AND ${table}.id = picked.id
         AND ${table}.state = 'waiting'
      RETURNING ${table}.*`;
  },
  claimCandidate: (options) => claimCandidateStatement(options, POSTGRES_CLAIM),
  claimById: claimByIdStatement,
  claimWindowEnd: (options) => claimWindowEndStatement(options, POSTGRES_CLAIM),
  affectedRows: countFromResult,
  claimNeedsTransaction: false,
  analyze: (table) => `ANALYZE ${table}`,
  // `reltuples` is maintained by `ANALYZE` itself, so this is a catalog
  // lookup rather than a scan. It reads -1 on a table that has never been
  // analysed, which the caller treats as having no estimate yet.
  estimatedRows: (table) =>
    `SELECT reltuples::bigint AS n FROM pg_class WHERE oid = '${table}'::regclass`,
  supportsListen: true,
  notifyingInsert: (statement, channel) =>
    `WITH written AS (${statement} RETURNING id)
     SELECT id, pg_notify('${channel}', '') FROM written`,
  rangedWritesNeedTransaction: false,
};

/** MySQL: `?` placeholders, `INSERT IGNORE`, and a derived table for updates. */
const mysql: SqlDialect = {
  ...base,
  name: "mysql",
  placeholder: () => "?",
  jsonType: "JSON",
  // MySQL and MariaDB have no partial indexes.
  partialIndex: () => "",
  // No keyword needed: InnoDB builds a secondary index online by default, on
  // MySQL and MariaDB alike. Measured on MySQL 8.4 and MariaDB, building one
  // on a 2M-row table let concurrent inserts through in about 3 ms each. It
  // still takes a brief metadata lock at the start and at the end, and that
  // lock waits for any transaction still open on the table (and, while it
  // waits, holds up the statements queued behind it). MySQL has no
  // `IF NOT EXISTS` on `ADD COLUMN` (MariaDB has, but shares this dialect),
  // so the sync checks before it writes rather than relying on the statement.
  concurrentIndex: "",
  describeColumns: () =>
    `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, COLLATION_NAME AS collation
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
  // No partial indexes, so there is no definition worth reading back: an index
  // either exists under its name or it does not.
  describeIndexes: () =>
    `SELECT INDEX_NAME AS name, '' AS definition,
            GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS columns
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      GROUP BY INDEX_NAME`,
  addColumn: (table, column) => `ALTER TABLE ${table} ADD COLUMN ${column}`,
  alterColumnType: (table, column, type, suffix) =>
    `ALTER TABLE ${table} ${mysqlAlterClause({ column, type, suffix })}`,
  alterColumnTypes: (table, columns) =>
    `ALTER TABLE ${table} ${columns.map(mysqlAlterClause).join(", ")}`,
  // MySQL 8 has no `CREATE INDEX IF NOT EXISTS`; see the interface.
  indexIfNotExists: false,
  // ER_DUP_KEYNAME: "Duplicate key name".
  isDuplicateIndex: (error) =>
    hasErrorCode(error, [1061, "1061", "ER_DUP_KEYNAME"]),
  claimIndexNamesId: true,
  dropIndex: (name, table) => `DROP INDEX ${name} ON ${table}`,
  normalizeType: normalizeSqlType,
  // Binary and `NO PAD`: see `idType` on the interface. `utf8mb4_0900_bin` is
  // MySQL 8's; MariaDB has its own, below.
  idType: "VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
  nameType: "TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
  stampType: "TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
  codePointCollation: null,
  timeType: "BIGINT",
  serialType: "BIGINT AUTO_INCREMENT PRIMARY KEY",
  longTextType: "MEDIUMTEXT",
  /**
   * Reads a JSON column as the client already decoded it.
   *
   * Bun's MySQL client decodes a `JSON` column itself — MariaDB's too, whose
   * `JSON` is `LONGTEXT` with a validity check — so a stored `"done"` arrives
   * as the string `done`, an object as an object. Parsing that again, as the
   * shared reader does for engines that hand back text, threw on every plain
   * string and fell back to `null`, and turned a string that happens to be
   * valid JSON, such as `"42"`, into a different type. A job's data, progress
   * and return value were all lost that way whenever they were a string.
   */
  jsonOut: <T>(value: unknown, fallback: T): T =>
    value === null || value === undefined ? fallback : (value as T),
  jsonSetInteger: (column, key, placeholder) =>
    `JSON_SET(COALESCE(${column}, JSON_OBJECT()), '$.${key}', CAST(${placeholder} AS SIGNED))`,
  jsonSetValues: (column, entries) =>
    entries.length === 0
      ? column
      : `JSON_SET(COALESCE(${column}, JSON_OBJECT()), ${entries
          .map(
            ([key, placeholder]) =>
              `'$.${key}', JSON_EXTRACT(${placeholder}, '$')`,
          )
          .join(", ")})`,
  // `JSON_TYPE` answers `INTEGER` or `DOUBLE` for a number on both engines,
  // SQL `NULL` for a missing key and `NULL` (the text) for a JSON null.
  jsonOrBit: (column, key, bit) =>
    `(CASE WHEN JSON_TYPE(JSON_EXTRACT(${column}, '$.${key}')) IN ('INTEGER', 'UNSIGNED INTEGER', 'DOUBLE', 'DECIMAL')
           THEN JSON_SET(${column}, '$.${key}', CAST(CAST(JSON_EXTRACT(${column}, '$.${key}') AS SIGNED) | ${bitLiteral(bit)} AS SIGNED))
           ELSE ${column} END)`,
  claimOrderAfter: expandedAfter,
  indexHint: (index) => ` FORCE INDEX (${index})`,
  isMissingHintedIndex: (error) =>
    hasErrorCode(error, [1176, "1176", "ER_KEY_DOES_NOT_EXITS"]),
  // MySQL's `JSON_EXTRACT` yields a JSON number and MariaDB's (whose `JSON` is
  // `LONGTEXT`) yields text; `CAST … AS SIGNED` reads both.
  jsonInteger: (column, key) =>
    `CAST(JSON_EXTRACT(${column}, '$.${key}') AS SIGNED)`,
  jsonParameter: (placeholder) => placeholder,
  supportsReturning: false,
  supportsSkipLocked: true,
  insertIgnore: (table, columns, values) =>
    `INSERT IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${(
      values ?? columns.map(() => "?")
    ).join(", ")})`,
  insertIgnoreMany: (table, columns, rows) =>
    `INSERT IGNORE INTO ${table} (${columns.join(", ")}) VALUES ${anonymousRows(
      columns,
      rows,
    )}`,
  insertMany: (table, columns, rows) =>
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${anonymousRows(
      columns,
      rows,
    )}`,
  isUniqueViolation: (error) =>
    isUniqueViolationError(error, [1062, "1062", "ER_DUP_ENTRY"]),
  upsert: (table, columns, _conflict, update) =>
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
      .map(() => "?")
      .join(", ")}) ON DUPLICATE KEY UPDATE ${update
      .map((column) => `${column} = VALUES(${column})`)
      .join(", ")}`,
  // No alias: `INSERT INTO t AS x` does not parse here, and the stored row's
  // columns are read bare.
  upsertAlias: null,
  upsertOnConflict: () => "ON DUPLICATE KEY UPDATE",
  upsertIncoming: (column) => `VALUES(${column})`,
  greatest: (first, second) => `GREATEST(${first}, ${second})`,
  least: (first, second) => `LEAST(${first}, ${second})`,
  // "You can't specify target table for update in FROM clause" without this.
  limitedIdSubquery: (select) => `SELECT id FROM (${select}) AS picked`,
  /**
   * Runs `fn` in a READ COMMITTED transaction, retried on a transient lock
   * error.
   *
   * InnoDB's default, REPEATABLE READ, takes gap and next-key locks on every
   * locking read and range update. Several workers claiming, completing,
   * retrying and promoting on one queue then deadlock on each other's gaps
   * faster than a retry clears them. Measured with 4 workers on 600 jobs,
   * a quarter failing once and a fifth delayed: MariaDB collapsed in 2 of 6
   * runs (4 and 403 of 600 jobs done in 90s, over 10,000 deadlocks), where READ
   * COMMITTED finished 8 of 8 at about 1,200 jobs/s. MySQL is as fast or faster
   * under it everywhere. The cost is a single consumer draining a backlog on
   * MariaDB, about 20% slower, and that cost is READ COMMITTED itself: setting
   * it once per connection measured within 4% of this.
   *
   * It is set per transaction, not per session, because a session setting is
   * lost silently whenever the pool replaces a connection. Nothing here relies
   * on a snapshot: every write is conditional on the state and lock token it
   * expects, and its affected-row count reports whether it landed.
   *
   * Bun's `begin(options)` sends `START TRANSACTION <options>`, which both
   * engines reject with an isolation level, so the connection is reserved and
   * the statements are issued in order.
   */
  transaction: async (sql, fn) =>
    await withLockRetry(async () => {
      const connection = await sql.reserve();
      try {
        await connection.unsafe(
          "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
        );
        await connection.unsafe("START TRANSACTION");
        try {
          const result = await fn(connection);
          await connection.unsafe("COMMIT");
          return result;
        } catch (error) {
          await connection.unsafe("ROLLBACK").catch(() => {});
          throw error;
        }
      } finally {
        connection.release();
      }
    }),
  /**
   * A join against a derived table. MySQL materialises it, so the `LIMIT 1`
   * bounds the update, and it also sidesteps the refusal to read the table
   * being updated from a `WHERE` subquery.
   */
  claim: (options) => {
    const { bind, table } = options;

    // Built inline, in statement order, for the same reason as the others.
    return `UPDATE ${table}
        JOIN (${claimCandidates(options, MYSQL_CLAIM)}) AS picked
          ON ${table}.id = picked.id
         SET ${claimAssignments(options, `${table}.`)}
       WHERE ${table}.ns = ${bind(options.ns)}
         AND ${table}.queue = ${bind(options.queue)}
         AND ${table}.state = 'waiting'`;
  },
  claimCandidate: (options) => claimCandidateStatement(options, MYSQL_CLAIM),
  claimById: claimByIdStatement,
  claimWindowEnd: (options) => claimWindowEndStatement(options, MYSQL_CLAIM),
  affectedRows: async (result) => {
    // Bun's client reports it on every result (measured on 1.4.3: INSERT 2,
    // matched-but-unchanged UPDATE 0, INSERT IGNORE of a duplicate 0, an
    // upsert that updates 2 — `ROW_COUNT()` exactly). Absent, the count is
    // unknown, and a silent 0 would make every conditional write report
    // failure, so it is refused instead.
    const affected = (result as { affectedRows?: unknown } | null)
      ?.affectedRows;
    if (typeof affected !== "number" && typeof affected !== "bigint") {
      throw new TypeError(
        "the MySQL client reported no affectedRows for a write; Bun >= 1.4.2 is required",
      );
    }
    return Math.max(0, Number(affected));
  },
  claimNeedsTransaction: true,
  analyze: (table) => `ANALYZE TABLE ${table}`,
  estimatedRows: () => null,
  supportsListen: false,
  notifyingInsert: (statement) => statement,
  rangedWritesNeedTransaction: true,
};

/**
 * MariaDB: MySQL, minus `UPDATE … RETURNING`, with its own binary collation
 * and its own spelling of `JSON`.
 */
const mariadb: SqlDialect = {
  ...mysql,
  name: "mariadb",
  supportsReturning: false,
  // MariaDB, unlike MySQL, has `CREATE INDEX IF NOT EXISTS`.
  indexIfNotExists: true,
  // And reads the claim index's implicit `id` suffix in order, so it need not
  // be named: see the interface.
  claimIndexNamesId: false,
  // `utf8mb4_nopad_bin` has been MariaDB's exact collation since 10.2. It
  // compares by code point, which for UTF-8 is byte order.
  idType: "VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin",
  nameType: "TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin",
  stampType: "TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin",
  // MariaDB's `JSON` is an alias for `LONGTEXT` with a validity check, and
  // `information_schema` reports `longtext`. Without this, a schema the driver
  // has just created reports every JSON column as drift, forever.
  normalizeType: (type) => {
    const normalized = normalizeSqlType(type);
    return normalized === "json" ? "longtext" : normalized;
  },
};

/**
 * SQLite: one writer at a time.
 *
 * There is no `SKIP LOCKED` because there is no row locking to skip — the
 * whole database takes one write lock. `BEGIN IMMEDIATE` takes it up front,
 * a process-local mutex keeps this process from queueing against itself, and
 * WAL plus a busy timeout handles other processes.
 */
const sqlite: SqlDialect = {
  ...base,
  name: "sqlite",
  placeholder: () => "?",
  jsonType: "TEXT",
  partialIndex: (predicate) => ` WHERE ${predicate}`,
  concurrentIndex: "",
  describeColumns: () =>
    `SELECT name, type, NULL AS collation FROM pragma_table_info(?)`,
  describeIndexes: () =>
    `SELECT name, COALESCE(sql, '') AS definition, NULL AS columns
       FROM sqlite_master
      WHERE type = 'index' AND tbl_name = ?`,
  addColumn: (table, column) => `ALTER TABLE ${table} ADD COLUMN ${column}`,
  // SQLite can rename and add, but not retype: changing a column means
  // rebuilding the table and copying every row, which is not something to do
  // behind a connect.
  alterColumnType: () => null,
  alterColumnTypes: () => null,
  indexIfNotExists: true,
  isDuplicateIndex: (error) =>
    /index .* already exists/i.test(String((error as Error | null)?.message)),
  claimIndexNamesId: false,
  dropIndex: (name) => `DROP INDEX IF EXISTS ${name}`,
  normalizeType: normalizeSqlType,
  idType: "TEXT",
  nameType: "TEXT",
  stampType: "TEXT",
  codePointCollation: null,
  timeType: "INTEGER",
  serialType: "INTEGER PRIMARY KEY AUTOINCREMENT",
  longTextType: "TEXT",
  jsonSetInteger: (column, key, placeholder) =>
    `json_set(COALESCE(${column}, '{}'), '$.${key}', CAST(${placeholder} AS INTEGER))`,
  // `json(?)` marks the value as JSON, so an object is stored as one rather
  // than as a string holding it.
  jsonSetValues: (column, entries) =>
    entries.length === 0
      ? column
      : `json_set(COALESCE(${column}, '{}'), ${entries
          .map(([key, placeholder]) => `'$.${key}', json(${placeholder})`)
          .join(", ")})`,
  jsonOrBit: (column, key, bit) =>
    `(CASE WHEN json_type(${column}, '$.${key}') IN ('integer', 'real')
           THEN json_set(${column}, '$.${key}', CAST(json_extract(${column}, '$.${key}') AS INTEGER) | ${bitLiteral(bit)})
           ELSE ${column} END)`,
  claimOrderAfter: rowValueAfter,
  indexHint: () => "",
  isMissingHintedIndex: () => false,
  jsonInteger: (column, key) =>
    `CAST(json_extract(${column}, '$.${key}') AS INTEGER)`,
  jsonParameter: (placeholder) => placeholder,
  supportsReturning: true,
  supportsSkipLocked: false,
  insertIgnore: (table, columns, values) =>
    `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${(
      values ?? columns.map(() => "?")
    ).join(", ")})`,
  insertIgnoreMany: (table, columns, rows) =>
    `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES ${anonymousRows(
      columns,
      rows,
    )}`,
  insertMany: (table, columns, rows) =>
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${anonymousRows(
      columns,
      rows,
    )}`,
  // SQLite reports the constraint only in the message.
  isUniqueViolation: (error) =>
    isUniqueViolationError(error, ["SQLITE_CONSTRAINT_PRIMARYKEY", 1555, 2067]),
  upsert: (table, columns, conflict, update) =>
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
      .map(() => "?")
      .join(", ")}) ON CONFLICT (${conflict.join(", ")}) DO UPDATE SET ${update
      .map((column) => `${column} = excluded.${column}`)
      .join(", ")}`,
  upsertAlias: "stored",
  upsertOnConflict: (conflict) =>
    `ON CONFLICT (${conflict.join(", ")}) DO UPDATE SET`,
  upsertIncoming: (column) => `excluded.${column}`,
  // SQLite has no `GREATEST`: its two-argument `MAX`/`MIN` are the scalars,
  // and the aggregates of the same name are the one-argument forms.
  greatest: (first, second) => `MAX(${first}, ${second})`,
  least: (first, second) => `MIN(${first}, ${second})`,
  /**
   * A scalar subquery under the database's write lock. There is no
   * `SKIP LOCKED` because there is nothing to skip: `BEGIN IMMEDIATE` makes
   * this connection the only writer, so the row it picks is its own.
   */
  claim: (options) => {
    const { bind, table } = options;

    // Every fragment is built inline, at the position it occupies in the
    // statement: `bind` numbers parameters in call order, so anything
    // computed ahead of time would be numbered ahead of where it appears.
    return `UPDATE ${table} SET ${claimAssignments(options)}
       WHERE ns = ${bind(options.ns)} AND queue = ${bind(options.queue)}
         AND state = 'waiting'
         AND id = (${claimCandidates(options, SQLITE_CLAIM)})
      RETURNING *`;
  },
  claimCandidate: (options) => claimCandidateStatement(options, SQLITE_CLAIM),
  claimById: claimByIdStatement,
  claimWindowEnd: (options) => claimWindowEndStatement(options, SQLITE_CLAIM),
  affectedRows: countFromResult,
  claimNeedsTransaction: true,
  analyze: (table) => `ANALYZE ${table}`,
  estimatedRows: () => null,
  supportsListen: false,
  notifyingInsert: (statement) => statement,
  rangedWritesNeedTransaction: false,
  transaction: async (sql, fn) =>
    // The mutex serialises writers inside this process; the retry handles the
    // ones in other processes, which contend for the file's single write lock.
    await sqliteWriteLock.runExclusive(async () =>
      withLockRetry(async () => {
        await sql.unsafe("BEGIN IMMEDIATE");
        try {
          const result = await fn(sql);
          await sql.unsafe("COMMIT");
          return result;
        } catch (error) {
          await sql.unsafe("ROLLBACK").catch(() => {});
          throw error;
        }
      }),
    ),
  pragmas: [
    // WAL lets a reader work while a writer holds the lock.
    "PRAGMA journal_mode=WAL",
    // Deliberately small, and smaller is better here. SQLite's busy handler
    // sleeps in the calling thread, so a connection waiting on a lock blocks
    // the very event loop that has to run the holder's COMMIT. Two connections
    // in one process therefore deadlock for the whole timeout: measured, a
    // 5000ms timeout turned a 300ms wait into a 3015ms one, where 50ms plus
    // the retry below finished in 349ms. The waiting is done in JavaScript by
    // `withLockRetry`, which yields between attempts; this value only covers
    // the microseconds a genuinely concurrent writer needs.
    "PRAGMA busy_timeout=50",
    "PRAGMA synchronous=NORMAL",
  ],
};

/** Every dialect, by name. */
const DIALECTS: Record<SqlAdapter, SqlDialect> = {
  postgres,
  mysql,
  mariadb,
  sqlite,
};

/** The dialect for an adapter name. */
export function dialectFor(adapter: SqlAdapter): SqlDialect {
  const dialect = DIALECTS[adapter];
  if (!dialect) {
    throw new ConfigError(`Unsupported SQL adapter "${adapter}"`, { adapter });
  }
  return dialect;
}

/**
 * Works out which engine a URL points at, so a caller need not repeat what
 * the connection string already says.
 */
export function detectAdapter(url: string | undefined): SqlAdapter {
  if (!url) {
    throw new ConfigError(
      "A SQL driver needs a url, or an explicit adapter with connection options",
    );
  }

  const scheme = url.slice(0, url.indexOf(":")).toLowerCase();

  switch (scheme) {
    case "postgres":
    case "postgresql":
      return "postgres";
    case "mysql":
      return "mysql";
    case "mariadb":
      return "mariadb";
    case "sqlite":
    case "file":
      return "sqlite";
    default:
      // A bare path or ":memory:" is SQLite; anything else is unrecognised.
      if (url === ":memory:" || url.startsWith("/") || url.startsWith("./")) {
        return "sqlite";
      }
      throw new ConfigError(`Cannot tell which SQL engine "${url}" is`, {
        url,
      });
  }
}
