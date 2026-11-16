/**
 * Table and index definitions, rendered to DDL
 * (`@kingsleyweb/bun-sql/schema`). Moved from bun-jobs'
 * `drivers/sql/schema.ts` (bun-security plan, storage.md §4.2) without
 * bun-jobs' own tables, which stay there: a driver describes its tables as
 * data, `createSchema` renders them, and `syncSqlSchema`
 * (`@kingsleyweb/bun-sql/sync`) compares the same description with what a
 * database has, so the two can never disagree about what the schema is.
 */
import type { SqlDialect } from "../dialect/types";
import type { SqlConfigError, SqlErrorOptions } from "../errors";
import { failWith } from "../errors";

/** One column of a table a driver owns. */
export interface ColumnDefinition {
  /** The column's name. */
  name: string;
  /** Its type, in this dialect's spelling. */
  type: string;
  /** Everything after the type — `NOT NULL`, a default, a serial's keywords. */
  suffix?: string;
  /**
   * Whether a sync may propose changing this column's type. Defaults to true.
   *
   * False for a column whose declared type is not what the engine reports
   * back. A serial is the case: Postgres takes `BIGSERIAL PRIMARY KEY` and
   * reports `bigint`, because `bigserial` is shorthand for a column plus a
   * sequence plus a default rather than a type. Comparing the two strings says
   * "different" every time, forever, and the statement it would generate is
   * nonsense.
   */
  retype?: boolean;
}

/** A column of an index that is ordered in a collation other than its own. */
export interface CollatedIndexColumn {
  /** The column's name. */
  name: string;
  /** The collation, exactly as written after `COLLATE`: `"C"`, quotes included. */
  collation: string;
}

/** One index a driver maintains. */
export interface IndexDefinition {
  /** The index's name, unique within the schema. */
  name: string;
  /** The table it is on. */
  table: string;
  /**
   * The columns it covers, in order: a name, or a name with the collation the
   * index orders it in when that is not the column's own.
   */
  columns: (string | CollatedIndexColumn)[];
  /** A partial-index predicate, where the engine has them. */
  predicate?: string;
}

/** One table a driver owns, as data rather than as a DDL string. */
export interface TableDefinition {
  /** The table's name, already prefixed. */
  name: string;
  /** Its columns, in declaration order. */
  columns: ColumnDefinition[];
  /** The columns of its primary key, or none for a table without one. */
  primaryKey: string[];
}

/** Every table and index a driver owns. */
export interface SchemaDefinition {
  /** The tables, in creation order. */
  tables: TableDefinition[];
  /** The indexes, each on one of {@link SchemaDefinition.tables}. */
  indexes: IndexDefinition[];
}

/** Options for {@link createSchema}. */
export interface CreateSchemaOptions extends SqlErrorOptions {
  /**
   * Tables that already exist, whose indexes are left out (see
   * {@link createSchema}). Empty by default: everything is created.
   */
  readonly existing?: ReadonlySet<string>;
}

/** One column, as it appears inside a `CREATE TABLE`. */
export function renderColumn(column: ColumnDefinition): string {
  return `${column.name} ${column.type}${column.suffix ? ` ${column.suffix}` : ""}`;
}

/** One index column as it appears in a `CREATE INDEX`. */
export function renderIndexColumn(
  column: string | CollatedIndexColumn,
): string {
  return typeof column === "string"
    ? column
    : `${column.name} COLLATE ${column.collation}`;
}

/** The `CREATE INDEX` for one index definition. */
export function renderIndex(
  index: IndexDefinition,
  dialect: SqlDialect,
  concurrently = false,
): string {
  const where = index.predicate ? dialect.partialIndex(index.predicate) : "";
  const how = concurrently ? dialect.concurrentIndex : "";

  const ifNotExists = dialect.indexIfNotExists ? "IF NOT EXISTS " : "";

  return `CREATE INDEX ${how}${ifNotExists}${index.name} ON ${index.table} (${index.columns.map(renderIndexColumn).join(", ")})${where}`;
}

/**
 * Statements creating everything a definition describes, each safe to run
 * repeatedly: `CREATE TABLE IF NOT EXISTS` for every table, in order, then
 * `CREATE INDEX` for every index (`IF NOT EXISTS` where the engine has it;
 * on MySQL a repeated one fails, and `SqlDialect.isDuplicateIndex`
 * recognises it). Throws the `ConfigError` (see `errors.ts`) for a table or
 * index with no name, or an index on a table the definition does not define.
 *
 * `options.existing` names tables that were already there, whose indexes are left
 * out. An index the driver defines on a table it did not just create is a new
 * index on a table that may be large and busy, and a plain `CREATE INDEX`
 * blocks every write to it for the whole build — on the first process of an
 * upgrade to connect, before anyone asked for it. That belongs to
 * `syncSchema`, which reports it as a `create-index` change and builds it
 * `CONCURRENTLY` on Postgres. Empty by default: everything is created.
 */
export function createSchema(
  definition: SchemaDefinition,
  dialect: SqlDialect,
  options: CreateSchemaOptions = {},
): string[] {
  assertDefinition(definition, failWith(options));
  const existing = options.existing ?? new Set<string>();

  return [
    ...definition.tables.map((table) => {
      const body = [
        ...table.columns.map(renderColumn),
        ...(table.primaryKey.length > 0
          ? [`PRIMARY KEY (${table.primaryKey.join(", ")})`]
          : []),
      ].join(",\n      ");

      return `CREATE TABLE IF NOT EXISTS ${table.name} (\n      ${body}\n    )`;
    }),
    ...definition.indexes
      .filter((index) => !existing.has(index.table))
      .map((index) => renderIndex(index, dialect)),
  ];
}

/**
 * Refuses a definition that names a table it does not define.
 *
 * The net under a schema definition: an index added on a table the
 * definition forgot, or a name built from something that was never set,
 * would otherwise become DDL around `undefined`.
 */
function assertDefinition(
  definition: SchemaDefinition,
  fail: SqlConfigError,
): void {
  const defined = new Set<string>();
  for (const table of definition.tables) {
    if (typeof table.name !== "string" || table.name.length === 0) {
      throw fail("The SQL schema defines a table with no name", {
        columns: table.columns.map((column) => column.name),
      });
    }
    defined.add(table.name);
  }

  for (const index of definition.indexes) {
    if (typeof index.name !== "string" || index.name.length === 0) {
      throw fail("The SQL schema defines an index with no name", {
        table: index.table,
      });
    }
    if (typeof index.table !== "string" || !defined.has(index.table)) {
      throw fail(
        `The SQL schema's index "${index.name}" is on a table it does not define`,
        { index: index.name, table: index.table },
      );
    }
  }
}
