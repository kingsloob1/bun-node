/**
 * What differs between the SQL engines (`@kingsleyweb/bun-sql/dialect`):
 * the four dialects. Moved from bun-jobs' `drivers/sql/dialect.ts`
 * (bun-security plan, storage.md §4.2) without the job queue's claim
 * statements, which stay in bun-jobs; every statement here renders the same
 * text it did there (`__tests__/parity/` compares them).
 */
import type { SqlConfigError, SqlErrorOptions } from "../errors";
import type {
  AlterColumn,
  KeysetCursor,
  SqlAdapter,
  SqlDialect,
} from "./types";
import { Mutex } from "@kingsleyweb/bun-common/lib/utils/native";
import { withLockRetry } from "../connection/connection";
import { failWith } from "../errors";

/** Postgres' clause changing one column's type. */
function postgresAlterClause({ column, type }: AlterColumn): string {
  return `ALTER COLUMN ${column} TYPE ${type} USING ${column}::${type}`;
}

/** MySQL's clause redefining one column, whose definition it replaces whole. */
function mysqlAlterClause({ column, type, suffix }: AlterColumn): string {
  return `MODIFY COLUMN ${column} ${type}${suffix ? ` ${suffix}` : ""}`;
}

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

/**
 * "After `cursor`" in any listing order, for Postgres and SQLite: a row-value bound on the order's own columns, then a disjunction
 * that removes only the rows tied with the cursor on every one of them.
 *
 * The bound is `>=`, never `>`, and that is the measured part rather than a
 * detail. Postgres estimates a row comparison from its first column alone, so
 * `(priority, created_at) > (…)` on a queue whose rows share one priority
 * looks like no rows at all and it picks a sequential scan; `>=` includes
 * every row of that priority, which is a selectivity it plans as an index
 * range. The disjunction is then a filter that strips the cursor's own ties,
 * and the id — which is not a key of any of these indexes — only ever appears
 * inside it.
 *
 * Correct for any number of columns: the bound already implies that a row
 * failing every strict term is equal on all of them, so the last disjunct
 * decides it on the id.
 */
function rowValueKeysetAfter(
  bind: (value: unknown) => string,
  cursor: KeysetCursor,
): string {
  const strict = cursor.direction === "desc" ? "<" : ">";
  const orEqual = `${strict}=`;
  const { columns, values } = cursor;

  // A one-column order needs no row constructor: Postgres reads `(x)` as the
  // scalar anyway, and the plain form is what a reader expects to see.
  const bound =
    columns.length === 1
      ? `${columns[0]} ${orEqual} ${bind(values[0])}`
      : `(${columns.join(", ")}) ${orEqual} (${values.map((value) => bind(value)).join(", ")})`;

  const ties = [
    ...columns.map((column, at) => `${column} ${strict} ${bind(values[at])}`),
    `${cursor.idColumn} ${strict} ${bind(cursor.id)}`,
  ];

  return `${bound}
           AND (${ties.join(" OR ")})`;
}

/**
 * The same predicate written out column by column, for MySQL and MariaDB,
 * which do not bound a range scan with a row comparison — measured on
 * bun-jobs' claim key, 11,001 index rows read against 1,000 for the same
 * window (on Postgres it is the reverse: this form is a filter there).
 */
function expandedKeysetAfter(
  bind: (value: unknown) => string,
  cursor: KeysetCursor,
): string {
  const strict = cursor.direction === "desc" ? "<" : ">";

  // Nested from the left, so each column is compared only where every column
  // ahead of it tied. Built recursively because the depth is the order's, and
  // left to right because `bind` numbers placeholders in call order.
  const nest = (at: number): string => {
    const column = cursor.columns[at];

    if (column === undefined) {
      return `${cursor.idColumn} ${strict} ${bind(cursor.id)}`;
    }

    return `${column} ${strict} ${bind(cursor.values[at])} OR (${column} = ${bind(cursor.values[at])}
           AND (${nest(at + 1)}))`;
  };

  return `(${nest(0)})`;
}

/**
 * `bit` as the literal a JSON bit-OR inlines: a whole number of at least 1, or
 * a `ConfigError`, since it is written into the statement text rather than
 * bound.
 */
function bitLiteral(bit: number, fail: SqlConfigError): string {
  if (!Number.isSafeInteger(bit) || bit < 1) {
    throw fail(`A JSON bit must be a positive integer, not ${bit}`, {
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

/** Reads an affected-row count off a result, for engines that report one. */
async function countFromResult(result: unknown): Promise<number> {
  const count = (result as { count?: number } | null)?.count;
  return typeof count === "number" ? count : 0;
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
  return match ? match[1].replace(/"/g, "").toLowerCase() : null;
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

/**
 * The four dialects, their option errors made by `fail` (only `jsonOrBit`
 * refuses an argument).
 */
function makeDialects(fail: SqlConfigError): Record<SqlAdapter, SqlDialect> {
  /** Postgres: `$n` placeholders, `JSON`/`JSONB`, `SKIP LOCKED`, `LISTEN`. */
  const postgres: SqlDialect = {
    ...base,
    name: "postgres",
    placeholder: (index) => `$${index}`,
    documentType: "JSONB",
    inetType: "INET",
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
    describeColumns: (tables) =>
      `SELECT table_name AS tbl, column_name AS name, data_type AS type,
            NULL AS collation
       FROM information_schema.columns
      WHERE table_name IN (${tables.map((_, i) => `$${i + 1}`).join(", ")})
        AND table_schema = ANY (current_schemas(false))`,
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
    isConcurrentCreate: (error) =>
      hasErrorCode(error, ["23505", 23505, "42710", 42710]),
    dropIndex: (name) => `DROP INDEX CONCURRENTLY IF EXISTS ${name}`,
    normalizeType: normalizeSqlType,
    idType: "TEXT",
    nameType: "TEXT",
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
            .map(
              ([key, placeholder]) => `'${key}', ${placeholder}::text::jsonb`,
            )
            .join(", ")}))`,
    // Named once through a scalar subquery, so the unwrapping is not repeated
    // for every mention of the object.
    jsonOrBit: (column, key, bit) =>
      `(SELECT CASE WHEN jsonb_typeof(o.v -> '${key}') = 'number'
                  THEN o.v || jsonb_build_object('${key}', (o.v ->> '${key}')::bigint | ${bitLiteral(bit, fail)})
                  ELSE o.v END
        FROM (SELECT ${postgresObject(column)} AS v) AS o)`,
    keysetAfter: rowValueKeysetAfter,
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
            .map(
              (_column, index) => `$${rowIndex * columns.length + index + 1}`,
            )
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
    isUniqueViolation: (error) =>
      isUniqueViolationError(error, ["23505", 23505]),
    upsert: (table, columns, conflict, update) =>
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
        .map((_column, index) => `$${index + 1}`)
        .join(
          ", ",
        )}) ON CONFLICT (${conflict.join(", ")}) DO UPDATE SET ${update
        .map((column) => `${column} = EXCLUDED.${column}`)
        .join(", ")}`,
    upsertAlias: "stored",
    upsertOnConflict: (conflict) =>
      `ON CONFLICT (${conflict.join(", ")}) DO UPDATE SET`,
    upsertIncoming: (column) => `EXCLUDED.${column}`,
    greatest: (first, second) => `GREATEST(${first}, ${second})`,
    least: (first, second) => `LEAST(${first}, ${second})`,
    transaction: async (sql, fn) => (await sql.begin(fn as never)) as never,
    affectedRows: countFromResult,
    analyze: (table) => `ANALYZE ${table}`,
    // `reltuples` is maintained by `ANALYZE` itself, so this is a catalog
    // lookup rather than a scan. It reads -1 on a table that has never been
    // analysed, which the caller treats as having no estimate yet.
    estimatedRows: (table) =>
      `SELECT reltuples::bigint AS n FROM pg_class WHERE oid = '${table}'::regclass`,
    supportsListen: true,
    // The payload is a constant empty string, so Postgres collapses the whole
    // insert's notifications into one: a 500-row `addBulk` chunk delivers a
    // single `NOTIFY`, not 500. **Measured, on 2026-09-22, that costs nothing**,
    // so leave it constant rather than making it unique per row.
    //
    // Why it is enough: `LISTEN` delivers to every listening session, and
    // `Arrivals.#listen` fires *every* waiter on the channel, so one notification
    // wakes every idle worker everywhere. Each then claims, and
    // `BunQueueWorker.#iterate` returns as soon as `claimed > 0` and claims again
    // at once — only an empty claim reaches `#idle`. One wake therefore drains a
    // whole backlog, and `mark`/`take` covers a notification landing between an
    // empty claim and the wait registration.
    //
    // The numbers, PostgreSQL 16.15, load average ~4-5, four rounds interleaved
    // with a unique-payload variant (`pg_notify(channel, id::text)`), W idle
    // workers × concurrency C, one `addBulk` of N, medians in ms of add -> first
    // claim and add -> last completion:
    //
    //   W1  C1 N50   const 12.2 / 59.4    unique 12.6 / 62.1   (1 vs 50 notifies)
    //   W1  C1 N500  const 23.5 / 547.6   unique 23.7 / 564.0
    //   W4  C8 N500  const 23.8 /  73.6   unique 23.5 /  74.0
    //   W16 C1 N500  const 23.4 / 129.6   unique 28.3 / 119.2
    //   W16 C8 N500  const 24.0 /  61.1   unique 28.8 /  62.6
    //
    // Every one of the 12 pairs was a tie inside the noise, in both directions.
    // The case built to expose a lost wake — four workers about to wait, three
    // overlapping `addBulk`s per round with jitter, `pollInterval` and `maxBlock`
    // at 10s so a missed wake would show as a ten-second tail — ran 1,200 jobs
    // over 240 adds at p50 4.7ms, p99 14.7ms, max 23.9ms, nothing over a second,
    // and the unique variant matched it. (The collapse is per transaction, so
    // those 240 adds were 240 notifications either way.)
    //
    // Nothing reads the payload: `Arrivals.#listen` registers a zero-argument
    // callback that only counts. MySQL, MariaDB and SQLite have no `NOTIFY` at
    // all — their `notifyingInsert` is the identity — so none of this reaches
    // them.
    notifyingInsert: (statement, channel) =>
      `WITH written AS (${statement} RETURNING id)
     SELECT id, pg_notify('${channel}', '') FROM written`,
    rangedWritesNeedTransaction: false,
    countsChangedRows: false,
  };

  /** MySQL: `?` placeholders, `INSERT IGNORE`, and a derived table for updates. */
  const mysql: SqlDialect = {
    ...base,
    name: "mysql",
    placeholder: () => "?",
    documentType: "JSON",
    inetType: null,
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
    describeColumns: (tables) =>
      `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, DATA_TYPE AS type,
            COLLATION_NAME AS collation
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN (${tables.map(() => "?").join(", ")})`,
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
    isConcurrentCreate: () => false,
    dropIndex: (name, table) => `DROP INDEX ${name} ON ${table}`,
    normalizeType: normalizeSqlType,
    // Binary and `NO PAD`: see `idType` on the interface. `utf8mb4_0900_bin` is
    // MySQL 8's; MariaDB has its own, below.
    idType: "VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
    nameType: "TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
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
           THEN JSON_SET(${column}, '$.${key}', CAST(CAST(JSON_EXTRACT(${column}, '$.${key}') AS SIGNED) | ${bitLiteral(bit, fail)} AS SIGNED))
           ELSE ${column} END)`,
    keysetAfter: expandedKeysetAfter,
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
    analyze: (table) => `ANALYZE TABLE ${table}`,
    estimatedRows: () => null,
    supportsListen: false,
    notifyingInsert: (statement) => statement,
    rangedWritesNeedTransaction: true,
    countsChangedRows: true,
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
    // `utf8mb4_nopad_bin` has been MariaDB's exact collation since 10.2. It
    // compares by code point, which for UTF-8 is byte order.
    idType: "VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin",
    nameType: "TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin",
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
    documentType: "TEXT",
    inetType: null,
    jsonType: "TEXT",
    partialIndex: (predicate) => ` WHERE ${predicate}`,
    concurrentIndex: "",
    // `pragma_table_info` joined to the table list, since the pragma itself
    // describes one table per call.
    describeColumns: (tables) =>
      `SELECT m.name AS tbl, p.name AS name, p.type AS type, NULL AS collation
       FROM sqlite_master AS m, pragma_table_info(m.name) AS p
      WHERE m.type = 'table'
        AND m.name IN (${tables.map(() => "?").join(", ")})`,
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
    isConcurrentCreate: () => false,
    dropIndex: (name) => `DROP INDEX IF EXISTS ${name}`,
    normalizeType: normalizeSqlType,
    idType: "TEXT",
    nameType: "TEXT",
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
           THEN json_set(${column}, '$.${key}', CAST(json_extract(${column}, '$.${key}') AS INTEGER) | ${bitLiteral(bit, fail)})
           ELSE ${column} END)`,
    keysetAfter: rowValueKeysetAfter,
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
      isUniqueViolationError(error, [
        "SQLITE_CONSTRAINT_PRIMARYKEY",
        1555,
        2067,
      ]),
    upsert: (table, columns, conflict, update) =>
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
        .map(() => "?")
        .join(
          ", ",
        )}) ON CONFLICT (${conflict.join(", ")}) DO UPDATE SET ${update
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
    affectedRows: countFromResult,
    analyze: (table) => `ANALYZE ${table}`,
    estimatedRows: () => null,
    supportsListen: false,
    notifyingInsert: (statement) => statement,
    rangedWritesNeedTransaction: false,
    countsChangedRows: false,
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

  return { postgres, mysql, mariadb, sqlite };
}

/** The dialects per error maker, built on first use. */
const DIALECTS = new WeakMap<SqlConfigError, Record<SqlAdapter, SqlDialect>>();

/**
 * The dialect for an adapter name. Throws the `ConfigError` (see
 * `errors.ts`) for an adapter bun-sql does not speak; `options.configError`
 * also makes the error the dialect's own members throw.
 */
export function dialectFor(
  adapter: SqlAdapter,
  options?: SqlErrorOptions,
): SqlDialect {
  const fail = failWith(options);
  let dialects = DIALECTS.get(fail);
  if (dialects === undefined) {
    dialects = makeDialects(fail);
    DIALECTS.set(fail, dialects);
  }
  const dialect = dialects[adapter];
  if (!dialect) {
    throw fail(`Unsupported SQL adapter "${adapter}"`, { adapter });
  }
  return dialect;
}

/**
 * Works out which engine a URL points at, so a caller need not repeat what
 * the connection string already says.
 */
export function detectAdapter(
  url: string | undefined,
  options?: SqlErrorOptions,
): SqlAdapter {
  const fail = failWith(options);
  if (!url) {
    throw fail(
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
      throw fail(`Cannot tell which SQL engine "${url}" is`, {
        url,
      });
  }
}
