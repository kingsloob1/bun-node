import type {
  ColumnRow,
  IndexRow,
  ResolvedSyncOptions,
  SchemaChange,
  SyncBackend,
} from "../schemaSync";
import type { SqlDialect } from "./dialect";
import type { IndexDefinition, TableDefinition } from "./schema";
import { renderColumn, renderIndex } from "./schema";

/**
 * Bringing an existing database in line with the schema the driver expects.
 *
 * `createSchema` is all `IF NOT EXISTS`, which is right for a first run and
 * useless afterwards: a table that already exists keeps whatever shape it was
 * created with, so a deployment upgrading the package gets none of the schema
 * improvements that come with it. Every measurement behind those improvements
 * only ever reached new installs.
 *
 * What makes this awkward is that the useful changes are not equally safe. A
 * column type change rewrites the table under a lock that blocks every reader
 * and writer for its duration — seconds on a small table, minutes on a large
 * one, and the queue is stopped throughout. Adding a column or dropping an
 * index is effectively instant, and Postgres can even build an index without
 * blocking writes at all.
 *
 * So they are separated. A sync does the changes that cannot stall a queue by
 * default, and the one that can has to be asked for by name.
 */

/**
 * Whether an index the database reports carries a predicate.
 *
 * Read from the engine's own rendering, which is why only the presence of one
 * is checked rather than its text: Postgres normalises a predicate when it
 * stores it (`lock_expires_at IS NOT NULL` comes back as
 * `(lock_expires_at IS NOT NULL)`), so comparing strings would rebuild the
 * index on every sync forever. Presence is the only property of ours that has
 * ever changed, and an engine that reports no definition at all — MySQL —
 * simply never disagrees.
 */
function hasPredicate(definition: string): boolean {
  return /\bWHERE\b/i.test(definition);
}

/**
 * Works out what would have to change, and applies whichever of it is allowed.
 *
 * Returns every change it found, including the ones it declined to make, each
 * marked with whether it was applied. A caller that passed `dryRun` gets the
 * same list with nothing applied, which is what makes this usable as a plan.
 */
export async function syncSqlSchema(
  backend: SyncBackend,
  dialect: SqlDialect,
  definition: { tables: TableDefinition[]; indexes: IndexDefinition[] },
  options: ResolvedSyncOptions,
): Promise<SchemaChange[]> {
  const changes: SchemaChange[] = [];

  for (const table of definition.tables) {
    const existing = await backend.all<ColumnRow>(
      dialect.describeColumns(table.name),
      [table.name],
    );

    // A table that does not exist yet is `createSchema`'s business, not this
    // one's: it runs first and creates it in full.
    if (existing.length === 0) {
      continue;
    }

    const byName = new Map(existing.map((row) => [String(row.name), row]));

    for (const column of table.columns) {
      const found = byName.get(column.name);

      if (!found) {
        changes.push({
          kind: "add-column",
          table: table.name,
          target: column.name,
          statement: dialect.addColumn(table.name, renderColumn(column)),
          reason: "the driver defines it and the table does not have it",
          blocking: false,
          applied: false,
        });
        continue;
      }

      if (column.retype === false) {
        continue;
      }

      const want = dialect.normalizeType(column.type);
      const have = dialect.normalizeType(String(found.type));

      if (want === have) {
        continue;
      }

      const statement = dialect.alterColumnType(
        table.name,
        column.name,
        column.type,
      );

      if (statement) {
        changes.push({
          kind: "alter-column",
          table: table.name,
          target: column.name,
          statement,
          reason: `stored as ${have}, the driver would create it as ${want}`,
          blocking: true,
          applied: false,
        });
      }
    }
  }

  // Indexes, grouped by the table they are on so each table is read once.
  const tablesWithIndexes = [
    ...new Set(definition.indexes.map((i) => i.table)),
  ];

  for (const table of tablesWithIndexes) {
    const wanted = definition.indexes.filter((index) => index.table === table);
    const existing = await backend.all<IndexRow>(
      dialect.describeIndexes(table),
      [table],
    );
    const byName = new Map(existing.map((row) => [String(row.name), row]));

    for (const index of wanted) {
      const found = byName.get(index.name);

      if (!found) {
        changes.push({
          kind: "create-index",
          table,
          target: index.name,
          statement: renderIndex(index, dialect, true),
          reason: "the driver defines it and the table does not have it",
          blocking: false,
          applied: false,
        });
        continue;
      }

      // Predicate drift. Only meaningful where the engine both supports
      // partial indexes and tells us about them.
      const wantsPredicate =
        index.predicate !== undefined &&
        dialect.partialIndex(index.predicate) !== "";

      if (
        found.definition !== "" &&
        wantsPredicate !== hasPredicate(String(found.definition))
      ) {
        changes.push({
          kind: "drop-index",
          table,
          target: index.name,
          statement: dialect.dropIndex(index.name, table),
          reason: wantsPredicate
            ? "indexes every row where the driver would index only the relevant ones"
            : "is partial where the driver would index every row",
          blocking: false,
          applied: false,
        });
        changes.push({
          kind: "create-index",
          table,
          target: index.name,
          statement: renderIndex(index, dialect, true),
          reason: "rebuilt with the predicate the driver defines",
          blocking: false,
          applied: false,
        });
      }
    }

    // Indexes the driver used to define and no longer does. Matched by the
    // driver's own naming, so nothing added by hand is ever dropped.
    const ours = /^ix_/;
    const names = new Set(wanted.map((index) => index.name));

    for (const row of existing) {
      const name = String(row.name);

      if (ours.test(name) && !names.has(name)) {
        changes.push({
          kind: "drop-index",
          table,
          target: name,
          statement: dialect.dropIndex(name, table),
          reason:
            "the driver no longer defines it, and it costs a write per row",
          blocking: false,
          applied: false,
        });
      }
    }
  }

  if (options.dryRun) {
    return changes;
  }

  for (const change of changes) {
    const allowed =
      change.kind === "alter-column"
        ? options.alterColumns
        : change.kind === "add-column"
          ? options.add
          : change.kind === "create-index"
            ? options.add || options.indexes
            : options.indexes;

    if (!allowed) {
      continue;
    }

    await backend.run(change.statement);
    change.applied = true;
  }

  return changes;
}
