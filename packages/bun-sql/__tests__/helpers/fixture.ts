/**
 * The schema the engine suites create and sync: one of every column type a
 * dialect names (the new `documentType` and `inetType` included), a serial
 * that the engine reports back as another type (`retype: false`), a plain, a
 * partial and a collated index, and a table with no primary key of its own.
 */
import type { SQL } from "bun";
import type {
  IndexDefinition,
  SchemaDefinition,
  SqlDialect,
  SyncBackend,
} from "../../lib/index";

/** The fixture's table names under `prefix`. */
export function fixtureTables(prefix: string): {
  /** The items table. */
  items: string;
  /** The log table, keyed by a serial. */
  log: string;
} {
  return { items: `${prefix}items`, log: `${prefix}log` };
}

/** The fixture's index definitions. */
export function fixtureIndexes(
  prefix: string,
  dialect: SqlDialect,
): IndexDefinition[] {
  const { items, log } = fixtureTables(prefix);
  return [
    { name: `ix_${prefix}items_at`, table: items, columns: ["at", "id"] },
    {
      name: `ix_${prefix}items_due`,
      table: items,
      columns: ["due"],
      predicate: "due IS NOT NULL",
    },
    {
      name: `ix_${prefix}items_order`,
      table: items,
      columns: [
        "n",
        dialect.codePointCollation === null
          ? "id"
          : { name: "id", collation: dialect.codePointCollation },
      ],
    },
    { name: `ix_${prefix}log_items`, table: log, columns: ["item"] },
  ];
}

/** The fixture schema under `prefix`, in `dialect`'s types. */
export function fixtureDefinition(
  prefix: string,
  dialect: SqlDialect,
): SchemaDefinition {
  const { items, log } = fixtureTables(prefix);
  return {
    tables: [
      {
        name: items,
        primaryKey: ["id"],
        columns: [
          { name: "id", type: dialect.idType, suffix: "NOT NULL" },
          { name: "name", type: dialect.nameType },
          { name: "n", type: "INTEGER", suffix: "NOT NULL DEFAULT 0" },
          { name: "at", type: dialect.timeType, suffix: "NOT NULL" },
          { name: "due", type: dialect.timeType },
          { name: "data", type: dialect.jsonType },
          { name: "body", type: dialect.documentType },
          { name: "note", type: dialect.longTextType },
          { name: "ip", type: dialect.inetType ?? dialect.idType },
        ],
      },
      {
        name: log,
        primaryKey: [],
        columns: [
          { name: "seq", type: dialect.serialType, retype: false },
          { name: "item", type: dialect.idType, suffix: "NOT NULL" },
          { name: "line", type: dialect.longTextType },
        ],
      },
    ],
    indexes: fixtureIndexes(prefix, dialect),
  };
}

/** A sync backend over a client. */
export function backendOf(sql: SQL): SyncBackend {
  return {
    all: async <T>(text: string, params: unknown[]) =>
      (await sql.unsafe(text, params)) as T[],
    run: async (text: string) => await sql.unsafe(text),
  };
}

/**
 * Runs `createSchema`'s statements, as a driver does: a repeated index on an
 * engine without `IF NOT EXISTS` (MySQL) is recognised and ignored.
 */
export async function runStatements(
  sql: SQL,
  dialect: Pick<SqlDialect, "isDuplicateIndex">,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    try {
      await sql.unsafe(statement);
    } catch (error) {
      if (!dialect.isDuplicateIndex(error)) {
        throw error;
      }
    }
  }
}
