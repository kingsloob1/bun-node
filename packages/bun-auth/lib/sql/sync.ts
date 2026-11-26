/**
 * Creating and syncing better-auth's tables on bun-sql.
 *
 * The comparison is bun-sql's (`syncSqlSchema`, run as a dry run over the
 * definition with the names as stored): which columns are missing, which have
 * another type or collation, which `ix_…` indexes are missing, have drifted or
 * are no longer defined. The statements are this module's, rendered with
 * quoted identifiers (see `identifiers.ts`). On top of bun-sql it creates the
 * tables that are missing and the unique indexes, which bun-sql's definitions
 * cannot express.
 * kingsloob1/bun-node#889 proposes both (quoted identifiers through the sync,
 * unique indexes in a definition); once bun-sql has them, this module shrinks
 * to building the definition.
 *
 * The rules are bun-sql's (CLAUDE.md, "Schema sync"): adding a column, adding
 * or rebuilding an index and dropping one of the adapter's own `ix_` indexes
 * happen by default; a column type change rewrites the table under a lock and
 * runs only with `alterColumns`; `dryRun` reports everything and changes
 * nothing. A column added to an existing table is added **nullable**, even
 * where better-auth requires it: rows already there have no value for it, and
 * MySQL would otherwise fill them with an implicit default silently.
 */
import type { SQL } from "bun";
import type { SqlDialect } from "@kingsleyweb/bun-sql/dialect";
import type {
  ResolvedSyncOptions,
  SchemaChange,
  SchemaSyncOptions,
  SyncBackend,
} from "@kingsleyweb/bun-sql/sync";
import type { AuthSchema, AuthTable } from "./schema";
import {
  createSchema,
  renderColumn,
  renderIndex,
} from "@kingsleyweb/bun-sql/schema";
import {
  readColumns,
  resolveSyncOptions,
  syncSqlSchema,
} from "@kingsleyweb/bun-sql/sync";
import { quoteIdentifier } from "./identifiers";
import { toDefinition } from "./schema";

/**
 * One difference between the tables better-auth needs and the database:
 * bun-sql's `SchemaChange`, plus `create-table` for a table that is not
 * there at all.
 */
export interface AuthSchemaChange extends Omit<SchemaChange, "kind"> {
  /** What sort of change it is: bun-sql's four kinds, or `create-table`. */
  kind: SchemaChange["kind"] | "create-table";
}

/** Runs statements for a sync: a client, serialised where the engine needs it. */
export interface SchemaRunner {
  /** The client the statements run on. */
  readonly sql: SQL;
  /** Runs `work` exclusively where the engine needs it (SQLite), directly elsewhere. */
  readonly exclusive: <T>(work: () => Promise<T>) => Promise<T>;
}

/** Whether `error`, or one it wraps, carries one of `codes`. */
function hasCode(error: unknown, codes: readonly (string | number)[]): boolean {
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

/**
 * Whether `error` means another process made the same object first: an index
 * or column by that name already exists, or two `CREATE TABLE IF NOT EXISTS`
 * raced on Postgres. Two instances starting together both sync, and the
 * loser's statement is then already done.
 */
function isAlreadyDone(dialect: SqlDialect, error: unknown): boolean {
  return (
    dialect.isDuplicateIndex(error) ||
    dialect.isConcurrentCreate(error) ||
    // MySQL and MariaDB's ER_DUP_FIELDNAME, SQLite's "duplicate column name".
    hasCode(error, [1060, "1060", "ER_DUP_FIELDNAME"]) ||
    /duplicate column name/i.test(String((error as Error | null)?.message))
  );
}

/** Runs one statement, treating "someone else already did it" as done. */
async function runStatement(
  runner: SchemaRunner,
  dialect: SqlDialect,
  statement: string,
): Promise<void> {
  try {
    await runner.exclusive(
      async () => (await runner.sql.unsafe(statement)) as unknown,
    );
  } catch (error) {
    if (!isAlreadyDone(dialect, error)) {
      throw error;
    }
  }
}

/** Whether building an index blocks writes to its table: SQLite only (bun-sql's measurement). */
function indexBuildBlocks(dialect: SqlDialect): boolean {
  return dialect.name === "sqlite";
}

/** The `CREATE UNIQUE INDEX` for one of a table's unique indexes. */
function renderUniqueIndex(
  dialect: SqlDialect,
  table: AuthTable,
  index: AuthTable["uniques"][number],
  concurrently: boolean,
): string {
  const q = (name: string) => quoteIdentifier(dialect.name, name);
  const how = concurrently ? dialect.concurrentIndex : "";
  const ifNotExists = dialect.indexIfNotExists ? "IF NOT EXISTS " : "";
  return `CREATE UNIQUE INDEX ${how}${ifNotExists}${index.name} ON ${q(table.name)} (${index.columns.map(q).join(", ")})`;
}

/**
 * Works out every change better-auth's tables need on this database, and
 * applies whichever of them `options` allows, in order: missing tables (with
 * their indexes), then bun-sql's changes to existing ones, then their missing
 * unique indexes. Returns every change found, each marked `applied` or not;
 * with `dryRun`, a plan.
 */
export async function syncAuthSchema(
  runner: SchemaRunner,
  dialect: SqlDialect,
  schema: AuthSchema,
  options?: SchemaSyncOptions | boolean,
): Promise<AuthSchemaChange[]> {
  const resolved: ResolvedSyncOptions = resolveSyncOptions(options);
  const engine = dialect.name;
  const q = (name: string) => quoteIdentifier(engine, name);
  const backend: SyncBackend = {
    all: async <T>(text: string, params: unknown[]): Promise<T[]> => {
      const rows = await runner.exclusive(
        async () => (await runner.sql.unsafe(text, params)) as unknown,
      );
      return rows as T[];
    },
    run: async (text: string) =>
      runner.exclusive(async () => (await runner.sql.unsafe(text)) as unknown),
  };

  const stored = await readColumns(
    backend,
    dialect,
    schema.tables.map((table) => table.name),
  );
  const missing = schema.tables.filter(
    (table) => (stored.get(table.name)?.length ?? 0) === 0,
  );
  const existing = schema.tables.filter((table) => !missing.includes(table));
  const changes: AuthSchemaChange[] = [];

  // Missing tables, created whole: the table, then its indexes.
  for (const table of missing) {
    const [create, ...indexStatements] = createSchema(
      toDefinition(engine, [table], true),
      dialect,
    );
    changes.push({
      kind: "create-table",
      table: table.name,
      target: table.name,
      statement: create,
      reason: "better-auth needs it and the database does not have it",
      blocking: false,
      applied: false,
    });
    table.indexes.forEach((index, at) => {
      changes.push({
        kind: "create-index",
        table: table.name,
        target: index.name,
        statement: indexStatements[at],
        reason: "better-auth's index on a table being created",
        blocking: false,
        applied: false,
      });
    });
    for (const index of table.uniques) {
      changes.push({
        kind: "create-index",
        table: table.name,
        target: index.name,
        statement: renderUniqueIndex(dialect, table, index, false),
        reason: "better-auth's unique field on a table being created",
        blocking: false,
        applied: false,
      });
    }
  }

  // Existing tables: bun-sql's comparison, our quoted statements.
  if (existing.length > 0) {
    const found = await syncSqlSchema(
      backend,
      dialect,
      toDefinition(engine, existing, false),
      { ...resolved, dryRun: true },
    );
    for (const change of found) {
      const table = existing.find((t) => t.name === change.table)!;
      changes.push({ ...change, statement: quotedStatement(change, table) });
    }

    for (const table of existing) {
      // bun-sql reads the indexes only of a table with a plain index still
      // defined, so on one with none left (better-auth's `user`) a stale
      // `ix_` index is never dropped: kingsloob1/bun-node#888. Read them here
      // for those tables; remove once that is fixed.
      const unread = table.indexes.length === 0;
      if (table.uniques.length === 0 && !unread) {
        continue;
      }
      const rows = await backend.all<{ name: string }>(
        dialect.describeIndexes(table.name),
        [table.name],
      );
      const have = new Set(rows.map((row) => String(row.name)));
      if (unread) {
        for (const name of have) {
          if (name.startsWith("ix_")) {
            changes.push({
              kind: "drop-index",
              table: table.name,
              target: name,
              statement: dialect.dropIndex(name, q(table.name)),
              reason:
                "the driver no longer defines it, and it costs a write per row",
              blocking: false,
              applied: false,
            });
          }
        }
      }
      for (const index of table.uniques) {
        if (!have.has(index.name)) {
          changes.push({
            kind: "create-index",
            table: table.name,
            target: index.name,
            statement: renderUniqueIndex(dialect, table, index, true),
            reason:
              "better-auth's unique field, which the table has no index for",
            blocking: indexBuildBlocks(dialect),
            applied: false,
          });
        }
      }
    }
  }

  if (resolved.dryRun) {
    return changes;
  }

  for (const change of changes) {
    if (change.applied || !allowed(change, resolved)) {
      continue;
    }
    if (change.kind === "alter-column") {
      // Every column change on a table in one statement, so one rewrite of it.
      const group = changes.filter(
        (other) =>
          other.kind === "alter-column" && other.table === change.table,
      );
      const table = existing.find((t) => t.name === change.table)!;
      const statement =
        group.length > 1
          ? dialect.alterColumnTypes(
              q(table.name),
              group.map((other) => {
                const column = table.columns.find(
                  (c) => c.name === other.target,
                )!;
                return {
                  column: q(column.name),
                  type: column.type,
                  ...(column.suffix === undefined
                    ? {}
                    : { suffix: column.suffix }),
                };
              }),
            )
          : change.statement;
      await runStatement(runner, dialect, statement ?? change.statement);
      for (const other of group) {
        other.applied = true;
      }
      continue;
    }
    await runStatement(runner, dialect, change.statement);
    change.applied = true;
  }

  return changes;

  /** A bun-sql change's statement, rendered again with quoted identifiers. */
  function quotedStatement(change: SchemaChange, table: AuthTable): string {
    switch (change.kind) {
      case "add-column": {
        const column = table.columns.find((c) => c.name === change.target)!;
        // Nullable, whatever better-auth requires: see the module comment.
        const suffix = column.suffix
          ?.replace(
            /\bNOT NULL\b/,
            engine === "mysql" || engine === "mariadb" ? "NULL" : "",
          )
          .trim();
        return dialect.addColumn(
          q(table.name),
          renderColumn({
            name: q(column.name),
            type: column.type,
            ...(suffix ? { suffix } : {}),
          }),
        );
      }
      case "alter-column": {
        const column = table.columns.find((c) => c.name === change.target)!;
        return (
          dialect.alterColumnType(
            q(table.name),
            q(column.name),
            column.type,
            column.suffix,
          ) ?? change.statement
        );
      }
      case "create-index": {
        const index = table.indexes.find((i) => i.name === change.target)!;
        return renderIndex(
          {
            name: index.name,
            table: q(table.name),
            columns: index.columns.map(q),
          },
          dialect,
          true,
        );
      }
      case "drop-index":
        return dialect.dropIndex(change.target, q(table.name));
    }
  }
}

/** Whether `options` allow a change to be applied (bun-sql's rules, plus `create-table` with `add`). */
function allowed(
  change: AuthSchemaChange,
  options: ResolvedSyncOptions,
): boolean {
  switch (change.kind) {
    case "create-table":
    case "add-column":
      return options.add;
    case "alter-column":
      return options.alterColumns;
    case "create-index":
      return options.add || options.indexes;
    case "drop-index":
      return options.indexes;
  }
}

/**
 * The SQL a sync would run, as one script: what better-auth's CLI writes for
 * `generate` (the adapter's `createSchema`). Changes a default sync would
 * leave alone (a column retype, which rewrites the table) are written as
 * comments, with the reason, so the script never does more than
 * `syncSchema()` would.
 */
export function renderScript(changes: readonly AuthSchemaChange[]): string {
  const defaults = resolveSyncOptions(undefined);
  const lines = changes.map((change) =>
    allowed(change, defaults)
      ? `${change.statement};`
      : `-- Not applied by default (${change.reason}; needs alterColumns):\n-- ${change.statement.replaceAll("\n", "\n-- ")};`,
  );
  return lines.length === 0
    ? "-- better-auth's tables are up to date.\n"
    : `${lines.join("\n\n")}\n`;
}
