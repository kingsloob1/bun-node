/**
 * better-auth's tables as bun-sql definitions (`docs/plans/bun-auth/sql-adapter.md`).
 *
 * `getAuthTables(options)` describes every table better-auth and its plugins
 * use as data; {@link buildAuthSchema} turns that into one {@link AuthTable}
 * per table, with each column's type for the engine, and from there into the
 * bun-sql `SchemaDefinition` that `createSchema` renders and `syncSqlSchema`
 * compares. Both read the same description, so the schema the adapter
 * creates and the one its sync expects can never disagree (bun-sql's
 * baseline: a schema the adapter just created reports no change).
 *
 * Column types, per engine (measured in the sub-plan's evidence, E16):
 *
 * | better-auth type | Postgres | MySQL, MariaDB | SQLite |
 * |---|---|---|---|
 * | id, a reference to an id, and any unique, indexed or sortable string | `TEXT` | bun-sql's `idType`: `VARCHAR(191)`, binary `NO PAD` collation | `TEXT` |
 * | any other string | `TEXT` | `MEDIUMTEXT`, the same collation | `TEXT` |
 * | number (`bigint`) | `INTEGER` (`BIGINT`) | `INTEGER` (`BIGINT`) | `INTEGER` |
 * | boolean | `BOOLEAN` | `TINYINT(1)` | `INTEGER` |
 * | date | `TIMESTAMPTZ(3)` | `DATETIME(3)` | `TEXT` (ISO 8601) |
 * | json, `string[]`, `number[]` | `JSONB` | `JSON` | `TEXT` |
 *
 * With `generateId: "serial"` the id is the engine's auto-increment integer
 * and a reference to it a `BIGINT` (`INTEGER` on SQLite).
 *
 * No foreign keys: bun-sql's definitions have none, MySQL ignores an inline
 * `REFERENCES` (measured, E16), and better-auth deletes a user's sessions and
 * accounts itself. Unique indexes are not bun-sql's either (its
 * `IndexDefinition` has no `unique`); they are kept here, beside the
 * definition, and created by `sync.ts`.
 */
import type { SqlAdapter, SqlDialect } from "@kingsleyweb/bun-sql/dialect";
import type {
  ColumnDefinition,
  IndexDefinition,
  SchemaDefinition,
} from "@kingsleyweb/bun-sql/schema";
import type { BetterAuthDBSchema, DBFieldAttribute } from "better-auth/db";
import { declaredCollation } from "@kingsleyweb/bun-sql/dialect";
import { initGetFieldName, initGetModelName } from "better-auth/adapters";
import { indexName, quoteIdentifier } from "./identifiers";

/** One column of a better-auth table, with its type for the engine. */
export interface AuthColumn extends ColumnDefinition {
  /** The field's key in better-auth's schema (`emailVerified`); `id` for the id. */
  readonly field: string;
  /** Whether the column holds a JSON document (`json`, `string[]`, `number[]`), bound as JSON text. */
  readonly json: boolean;
  /** Whether better-auth requires a value (`required` is not `false`); the id always is. */
  readonly required: boolean;
}

/** One index the adapter keeps on a table. */
export interface AuthIndex {
  /** The index's name: `ix_…` for a plain one, `ux_…` for a unique one. */
  readonly name: string;
  /** Its columns, in order, by their names in the database. */
  readonly columns: readonly string[];
}

/** One better-auth table, as the adapter creates it. */
export interface AuthTable {
  /** The table's key in better-auth's schema (`user`, `session`, `twoFactor`). */
  readonly key: string;
  /** The model name better-auth uses for it (its `modelName`, plural with `usePlural`). */
  readonly model: string;
  /** The table's name in the database: the adapter's prefix and {@link AuthTable.model}. */
  readonly name: string;
  /** Its columns, the id first. */
  readonly columns: readonly AuthColumn[];
  /** The columns of its primary key: `id`, or none where SQLite's serial id carries it inline. */
  readonly primaryKey: readonly string[];
  /** Its plain indexes, which bun-sql's sync manages. */
  readonly indexes: readonly AuthIndex[];
  /** Its unique indexes, which the adapter creates and never drops. */
  readonly uniques: readonly AuthIndex[];
}

/** better-auth's whole schema for one engine. */
export interface AuthSchema {
  /** The engine the types are for. */
  readonly engine: SqlAdapter;
  /** Every table, in better-auth's order. */
  readonly tables: readonly AuthTable[];
  /** The tables by {@link AuthTable.model}. */
  readonly byModel: ReadonlyMap<string, AuthTable>;
}

/** What {@link buildAuthSchema} needs besides better-auth's tables. */
export interface BuildAuthSchemaOptions {
  /** The engine to type the columns for. */
  readonly engine: SqlAdapter;
  /** That engine's bun-sql dialect. */
  readonly dialect: SqlDialect;
  /** Put before every table name. */
  readonly prefix: string;
  /** better-auth's `usePlural`: table names end in `s`. */
  readonly usePlural: boolean;
  /** Whether ids are the engine's auto-increment integers (`generateId: "serial"`). */
  readonly numericIds: boolean;
}

/** The role a column plays, which decides its type. */
type Role =
  | "id"
  | "ref"
  | "ident"
  | "text"
  | "number"
  | "bigint"
  | "boolean"
  | "date"
  | "json";

/** A column's type, its definition's suffix and whether a sync may retype it. */
interface Typed {
  /** The type, as the DDL spells it. */
  readonly type: string;
  /** What follows the type, besides `NOT NULL`. */
  readonly suffix?: string;
  /** False where the engine reports another type than the one declared. */
  readonly retype?: false;
}

/** The type of a column playing `role` on `engine`. */
function typeFor(
  engine: SqlAdapter,
  dialect: SqlDialect,
  role: Role,
  numericIds: boolean,
): Typed {
  const mysqlFamily = engine === "mysql" || engine === "mariadb";
  switch (role) {
    case "id":
      if (!numericIds) {
        return { type: dialect.idType };
      }
      // Each engine reports these as their plain integer type, so a sync must
      // not compare them (bun-sql's `retype: false`).
      if (engine === "postgres") {
        return { type: "BIGSERIAL", retype: false };
      }
      if (mysqlFamily) {
        return { type: "BIGINT AUTO_INCREMENT", retype: false };
      }
      return {
        type: "INTEGER",
        suffix: "PRIMARY KEY AUTOINCREMENT",
        retype: false,
      };
    case "ref":
      return numericIds
        ? { type: engine === "sqlite" ? "INTEGER" : "BIGINT" }
        : { type: dialect.idType };
    case "ident":
      return { type: dialect.idType };
    case "text":
      // Compared exactly on MySQL and MariaDB too, in the collation bun-sql
      // gives identifiers: their default collations are case-insensitive.
      return mysqlFamily
        ? {
            type: `${dialect.longTextType} CHARACTER SET utf8mb4 COLLATE ${declaredCollation(dialect.idType)}`,
          }
        : { type: "TEXT" };
    case "number":
      return { type: "INTEGER" };
    case "bigint":
      return { type: engine === "sqlite" ? "INTEGER" : "BIGINT" };
    case "boolean":
      return {
        type:
          engine === "postgres"
            ? "BOOLEAN"
            : engine === "sqlite"
              ? "INTEGER"
              : "TINYINT(1)",
      };
    case "date":
      return {
        type:
          engine === "postgres"
            ? "TIMESTAMPTZ(3)"
            : engine === "sqlite"
              ? "TEXT"
              : "DATETIME(3)",
      };
    case "json":
      return { type: dialect.documentType };
  }
}

/** Whether a better-auth field type is stored as a JSON document. */
export function isJsonType(type: DBFieldAttribute["type"]): boolean {
  return type === "json" || type === "string[]" || type === "number[]";
}

/** The role of a field, given whether it is an index's column. */
function roleOf(field: DBFieldAttribute, indexed: boolean): Role {
  if (field.references?.field === "id") {
    return "ref";
  }
  const type = field.type;
  if (Array.isArray(type) || type === "string") {
    return field.unique || field.index || field.sortable || indexed
      ? "ident"
      : "text";
  }
  if (type === "number") {
    return field.bigint ? "bigint" : "number";
  }
  if (type === "boolean") {
    return "boolean";
  }
  if (type === "date") {
    return "date";
  }
  return "json";
}

/** The suffix that makes a column required, or optional, on `engine`. */
function nullability(
  engine: SqlAdapter,
  required: boolean,
): string | undefined {
  if (required) {
    return "NOT NULL";
  }
  // MySQL and MariaDB write `NULL` for a nullable column; the others leave it bare.
  return engine === "mysql" || engine === "mariadb" ? "NULL" : undefined;
}

/** Joins two definition suffixes. */
function joinSuffix(
  first: string | undefined,
  second: string | undefined,
): string | undefined {
  const parts = [first, second].filter((part) => part !== undefined);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * better-auth's tables (`getAuthTables(options)`, or the `tables` its CLI
 * hands `createSchema`) as the adapter creates them on one engine. A table
 * with `disableMigrations` is left out: its owner creates it.
 */
export function buildAuthSchema(
  tables: BetterAuthDBSchema,
  options: BuildAuthSchemaOptions,
): AuthSchema {
  const { engine, dialect, prefix, usePlural, numericIds } = options;
  const getModelName = initGetModelName({ schema: tables, usePlural });
  const getFieldName = initGetFieldName({ schema: tables, usePlural });
  const built: AuthTable[] = [];

  for (const [key, table] of Object.entries(tables)) {
    if (table.disableMigrations) {
      continue;
    }
    const model = getModelName(key);
    const name = `${prefix}${model}`;
    const column = (field: string) => getFieldName({ model: key, field });

    // Fields an index covers are identifiers whatever else they are: MySQL
    // cannot index a `MEDIUMTEXT` whole.
    const indexedFields = new Set(
      (table.indexes ?? []).flatMap((index) => index.fields),
    );

    const id = typeFor(engine, dialect, "id", numericIds);
    const columns: AuthColumn[] = [
      {
        name: "id",
        field: "id",
        json: false,
        required: true,
        type: id.type,
        ...(id.retype === false ? { retype: false } : {}),
        ...(id.suffix === undefined
          ? { suffix: "NOT NULL" }
          : { suffix: id.suffix }),
      },
    ];
    const indexes = new Map<string, AuthIndex>();
    const uniques = new Map<string, AuthIndex>();
    const keep = (unique: boolean, columnNames: readonly string[]) => {
      const index = {
        name: indexName(unique ? "ux" : "ix", name, columnNames),
        columns: columnNames,
      };
      (unique ? uniques : indexes).set(index.name, index);
    };

    for (const [fieldKey, field] of Object.entries(table.fields)) {
      const columnName = column(fieldKey);
      if (columnName === "id") {
        continue;
      }
      const required = field.required !== false;
      const typed = typeFor(
        engine,
        dialect,
        roleOf(field, indexedFields.has(fieldKey)),
        numericIds,
      );
      const suffix = joinSuffix(nullability(engine, required), typed.suffix);
      columns.push({
        name: columnName,
        field: fieldKey,
        json: isJsonType(field.type),
        required,
        type: typed.type,
        ...(suffix === undefined ? {} : { suffix }),
      });
      if (field.unique) {
        keep(true, [columnName]);
      } else if (field.index) {
        keep(false, [columnName]);
      }
    }

    for (const index of table.indexes ?? []) {
      keep(index.unique === true, index.fields.map(column));
    }

    built.push({
      key,
      model,
      name,
      columns,
      primaryKey: numericIds && engine === "sqlite" ? [] : ["id"],
      indexes: [...indexes.values()],
      uniques: [...uniques.values()],
    });
  }

  return {
    engine,
    tables: built,
    byModel: new Map(built.map((table) => [table.model, table])),
  };
}

/**
 * The bun-sql definition of `tables`, with names as the database stores them
 * (`quoted: false`, what `syncSqlSchema` compares, since it binds them as
 * catalog parameters) or quoted for `engine` (`quoted: true`, what
 * `createSchema` renders into DDL). The plain indexes only: unique ones are
 * the adapter's own (see the module comment).
 */
export function toDefinition(
  engine: SqlAdapter,
  tables: readonly AuthTable[],
  quoted: boolean,
): SchemaDefinition {
  const q = (name: string) => (quoted ? quoteIdentifier(engine, name) : name);
  return {
    tables: tables.map((table) => ({
      name: q(table.name),
      columns: table.columns.map((column) => ({
        name: q(column.name),
        type: column.type,
        ...(column.suffix === undefined ? {} : { suffix: column.suffix }),
        ...(column.retype === false ? { retype: false } : {}),
      })),
      primaryKey: table.primaryKey.map(q),
    })),
    indexes: tables.flatMap((table) =>
      table.indexes.map((index): IndexDefinition => ({
        name: index.name,
        table: q(table.name),
        columns: index.columns.map(q),
      })),
    ),
  };
}
