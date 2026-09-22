import type {
  IndexRow as BaseIndexRow,
  ColumnRow,
  ResolvedSyncOptions,
  SchemaChange,
  SyncBackend,
} from "../schemaSync";
import type { AlterColumn, SqlDialect } from "./dialect";
import type { IndexDefinition, TableDefinition } from "./schema";
import { declaredCollation } from "./dialect";
import { renderColumn, renderIndex, renderIndexColumn } from "./schema";

/** An index as the SQL dialects describe it: the shared row plus its columns. */
interface IndexRow extends BaseIndexRow {
  /**
   * The index's column names in order, comma-separated, where the engine
   * renders no definition (MySQL, MariaDB); `null` elsewhere.
   */
  columns: string | null;
}

/** A column as the SQL dialects describe it: {@link ColumnRow} plus collation. */
interface SqlColumnRow extends ColumnRow {
  /** The column's collation, or `null` where the engine does not report one. */
  collation: string | null;
}

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
 * index is effectively instant. Building an index depends on the engine: see
 * {@link indexBuildBlocks}.
 *
 * So they are separated. A sync does the changes that cannot stall a queue by
 * default, and the one that can has to be asked for by name.
 */

/**
 * Whether building an index on `dialect` blocks writes to its table for the
 * build, which is what a `create-index` change reports as `blocking`.
 *
 * Measured by timing an insert from a second connection while a
 * 2,000,000-row table built a two-column index: Postgres (`CONCURRENTLY`),
 * MySQL 8.4 and MariaDB (InnoDB's online build, `LOCK=NONE` by default) took
 * the insert in 2-3ms during a 1.9-2.9s build; SQLite (rollback journal and
 * WAL alike) made it wait 1.7s of a 1.9s build, since one writer holds the
 * database file until the `CREATE INDEX` commits. So only SQLite reports it.
 * An online build still takes a brief exclusive metadata lock at its start
 * and end, so on MySQL and MariaDB it waits for a transaction still open on
 * the table, and statements arriving meanwhile queue behind it: a stall only
 * a long transaction can cause, not one the build's length does.
 */
function indexBuildBlocks(dialect: SqlDialect): boolean {
  return dialect.name === "sqlite";
}

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
 * The collated columns of an index, as `column COLLATE collation` phrases.
 *
 * Postgres renders a column's collation in `indexdef` only when the index's
 * differs from the column's own, and the driver declares every column in the
 * default one — so the phrases a definition carries are exactly the ones the
 * driver asked for. Quotes are dropped and case folded, which is how the two
 * sides are spelled alike.
 */
function collatedPhrases(definition: string): string[] {
  return [...definition.matchAll(/(\w+)\s+COLLATE\s+("[^"]+"|[\w.-]+)/gi)]
    .map((match) => `${match[1]} collate ${match[2]!.replace(/"/g, "")}`)
    .map((phrase) => phrase.toLowerCase())
    .sort();
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
  // Which column each `alter-column` change redefines, so the ones on one
  // table can be applied together. Kept beside the changes rather than on
  // them: a change's `statement` stays the one-column form, which is what a
  // dry run reports and what a caller can run by hand.
  const alterations = new Map<SchemaChange, AlterColumn>();

  for (const table of definition.tables) {
    const existing = await backend.all<SqlColumnRow>(
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

      // Collation, where the driver declares one and the engine reports one.
      // A collation change rewrites the table exactly as a type change does —
      // every index on the column is rebuilt in the new order — so it is the
      // same blocking change, made by the same statement.
      const wantCollation = declaredCollation(column.type);
      const haveCollation = found.collation
        ? String(found.collation).toLowerCase()
        : null;
      const recollate =
        wantCollation !== null &&
        haveCollation !== null &&
        wantCollation !== haveCollation;

      if (want === have && !recollate) {
        continue;
      }

      const statement = dialect.alterColumnType(
        table.name,
        column.name,
        column.type,
        column.suffix,
      );

      if (statement) {
        const change: SchemaChange = {
          kind: "alter-column",
          table: table.name,
          target: column.name,
          statement,
          reason:
            want !== have
              ? `stored as ${have}, the driver would create it as ${want}`
              : `compares in ${haveCollation}, the driver would compare in ${wantCollation}`,
          blocking: true,
          applied: false,
        };
        changes.push(change);
        alterations.set(change, {
          column: column.name,
          type: column.type,
          suffix: column.suffix,
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
          blocking: indexBuildBlocks(dialect),
          applied: false,
        });
        continue;
      }

      // Predicate and collation drift. Only meaningful where the engine
      // tells us how an index is defined; MySQL does not, and has neither.
      const definitionText = String(found.definition);
      const wantsPredicate =
        index.predicate !== undefined &&
        dialect.partialIndex(index.predicate) !== "";
      const predicateDrift =
        definitionText !== "" &&
        wantsPredicate !== hasPredicate(definitionText);
      // Column drift, where the engine lists columns rather than rendering a
      // definition. Names only: collations and predicates do not exist there.
      const wantedColumns = index.columns
        .map((column) => (typeof column === "string" ? column : column.name))
        .join(",")
        .toLowerCase();
      const columnDrift =
        found.columns != null &&
        String(found.columns).toLowerCase() !== wantedColumns;
      const collationDrift =
        definitionText !== "" &&
        collatedPhrases(definitionText).join(",") !==
          collatedPhrases(index.columns.map(renderIndexColumn).join(", ")).join(
            ",",
          );

      if (predicateDrift || collationDrift || columnDrift) {
        changes.push({
          kind: "drop-index",
          table,
          target: index.name,
          statement: dialect.dropIndex(index.name, table),
          reason: predicateDrift
            ? wantsPredicate
              ? "indexes every row where the driver would index only the relevant ones"
              : "is partial where the driver would index every row"
            : columnDrift
              ? `covers (${String(found.columns)}) where the driver defines (${wantedColumns})`
              : "orders its columns in a collation the driver does not define",
          blocking: false,
          applied: false,
        });
        changes.push({
          kind: "create-index",
          table,
          target: index.name,
          statement: renderIndex(index, dialect, true),
          reason: predicateDrift
            ? "rebuilt with the predicate the driver defines"
            : columnDrift
              ? "rebuilt with the columns the driver defines"
              : "rebuilt with the collation the driver defines",
          blocking: indexBuildBlocks(dialect),
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

    if (!allowed || change.applied) {
      continue;
    }

    // Every column change on a table, in one statement and so one rewrite of
    // it, at the position of the first. `applied` is set only once that
    // statement has succeeded, and a failure throws before any is set — the
    // engine applies an `ALTER TABLE` whole or not at all.
    if (change.kind === "alter-column") {
      const group = changes.filter(
        (other) =>
          other.kind === "alter-column" && other.table === change.table,
      );
      const statement =
        group.length > 1
          ? dialect.alterColumnTypes(
              change.table,
              group.map((other) => alterations.get(other)!),
            )
          : change.statement;

      await backend.run(statement ?? change.statement);
      for (const other of group) {
        other.applied = true;
      }
      continue;
    }

    await backend.run(change.statement);
    change.applied = true;
  }

  return changes;
}
