import type {
  IndexRow as BaseIndexRow,
  ColumnRow,
  ResolvedSyncOptions,
  SchemaChange,
  SyncBackend,
} from "../schemaSync";
import type { AlterColumn, SqlDialect } from "./dialect";
import type {
  ColumnDefinition,
  IndexDefinition,
  TableDefinition,
} from "./schema";
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

/**
 * A column as the SQL dialects describe it: {@link ColumnRow} plus its table
 * and collation.
 */
export interface SqlColumnRow extends ColumnRow {
  /** The table it belongs to, as the engine reports the name. */
  tbl: string;
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

  const columnsByTable = await readColumns(
    backend,
    dialect,
    definition.tables.map((table) => table.name),
  );

  for (const table of definition.tables) {
    const existing = columnsByTable.get(table.name) ?? [];

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

      // A collation change rewrites the table exactly as a type change does —
      // every index on the column is rebuilt in the new order — so it is the
      // same blocking change, made by the same statement.
      const difference = compareColumn(dialect, column, found);

      if (!difference) {
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
          reason: difference.type
            ? `stored as ${difference.type.have}, the driver would create it as ${difference.type.want}`
            : `compares in ${difference.collation!.found}, the driver would compare in ${difference.collation!.expected}`,
          blocking: true,
          applied: false,
          ...(difference.collation ? { collation: difference.collation } : {}),
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

/**
 * The columns of `tables` as the database reports them, in one catalog query
 * ({@link SqlDialect.describeColumns}).
 *
 * Keyed by the table name as given. A table with no entry does not exist.
 * Matched back case-insensitively, since an engine may report a name in a
 * case other than the one it was asked for (MySQL with
 * `lower_case_table_names`); the driver's own names never differ from one
 * another by case alone.
 *
 * What connecting reads — to see which tables to create, and whether an
 * existing one's identifiers have drifted (see {@link collationDrift}) — and
 * what a sync compares against, so the two can never disagree about a table.
 */
export async function readColumns(
  backend: Pick<SyncBackend, "all">,
  dialect: SqlDialect,
  tables: readonly string[],
): Promise<Map<string, SqlColumnRow[]>> {
  const columns = new Map<string, SqlColumnRow[]>();

  if (tables.length === 0) {
    return columns;
  }

  const byFolded = new Map(tables.map((name) => [name.toLowerCase(), name]));
  const rows = await backend.all<SqlColumnRow>(
    dialect.describeColumns(tables),
    [...tables],
  );

  for (const row of rows) {
    const table = byFolded.get(String(row.tbl).toLowerCase());
    if (table === undefined) {
      continue;
    }
    const list = columns.get(table) ?? [];
    list.push(row);
    columns.set(table, list);
  }

  return columns;
}

/** How an existing column differs from the driver's definition of it. */
export interface ColumnDifference {
  /**
   * The type as stored and as the driver would create it, both normalised
   * ({@link SqlDialect.normalizeType}), when they differ; `null` when not.
   */
  type: { have: string; want: string } | null;
  /**
   * The collation found and the one the driver declares, both lowercased,
   * when they differ; `null` when not, or when the driver declares none or
   * the engine reports none.
   */
  collation: { found: string; expected: string } | null;
}

/**
 * Compares one existing column against the driver's definition of it:
 * `null` when they agree, or when the column is exempt (`retype: false`, see
 * {@link ColumnDefinition.retype}).
 *
 * The one comparison both a sync and connect's drift check make, so the
 * warning names exactly the columns an `alterColumns` sync would change.
 */
export function compareColumn(
  dialect: SqlDialect,
  column: ColumnDefinition,
  found: Pick<SqlColumnRow, "type" | "collation">,
): ColumnDifference | null {
  if (column.retype === false) {
    return null;
  }

  const want = dialect.normalizeType(column.type);
  const have = dialect.normalizeType(String(found.type));

  // Collation, where the driver declares one and the engine reports one.
  const wantCollation = declaredCollation(column.type);
  const haveCollation = found.collation
    ? String(found.collation).toLowerCase()
    : null;
  const collation =
    wantCollation !== null &&
    haveCollation !== null &&
    wantCollation !== haveCollation
      ? { found: haveCollation, expected: wantCollation }
      : null;

  if (want === have && collation === null) {
    return null;
  }

  return { type: want === have ? null : { have, want }, collation };
}

/** An identifier column whose collation is not the one the driver declares. */
export interface CollationDrift {
  /** The table. */
  table: string;
  /** The column. */
  column: string;
  /** The collation it has, lowercased. */
  found: string;
  /** The collation the driver declares for it, lowercased. */
  expected: string;
}

/**
 * The columns of `tables` whose collation differs from the driver's, read
 * from columns already fetched by {@link readColumns}.
 *
 * Collation drift only, never type drift: a column the driver declares a
 * collation for is an identifier (see {@link SqlDialect.idType}), and one
 * that compares case- or accent-insensitively returns wrong answers, where a
 * type that differs (`jsonb` for `json`, say) costs only speed or space. Empty
 * on Postgres and SQLite, whose column listing reports no collation, because
 * the driver has never declared one there: see {@link SqlDialect.idType}.
 */
export function collationDrift(
  dialect: SqlDialect,
  tables: readonly TableDefinition[],
  columns: ReadonlyMap<string, readonly SqlColumnRow[]>,
): CollationDrift[] {
  const drift: CollationDrift[] = [];

  for (const table of tables) {
    const byName = new Map(
      (columns.get(table.name) ?? []).map((row) => [String(row.name), row]),
    );

    for (const column of table.columns) {
      const found = byName.get(column.name);
      const difference = found && compareColumn(dialect, column, found);

      if (difference && difference.collation) {
        drift.push({
          table: table.name,
          column: column.name,
          ...difference.collation,
        });
      }
    }
  }

  return drift;
}

/**
 * The one warning connecting logs for {@link CollationDrift}: every drifted
 * column, grouped by table and the collation found, and the fix.
 */
export function collationDriftWarning(drift: readonly CollationDrift[]): {
  /** The warning's text. */
  message: string;
  /** The same, structured, for a sink that reads fields. */
  fields: {
    /** Every drifted column. */
    columns: CollationDrift[];
    /** The call that repairs them. */
    fix: string;
  };
} {
  // One phrase per table and collation pair, so a table created entirely by
  // an older version reads as one entry rather than nine.
  const groups = new Map<string, CollationDrift & { columns: string[] }>();

  for (const entry of drift) {
    const key = [entry.table, entry.found, entry.expected].join(" ");
    const group = groups.get(key) ?? { ...entry, columns: [] };
    group.columns.push(entry.column);
    groups.set(key, group);
  }

  const listed = [...groups.values()]
    .map(
      (group) =>
        `${group.table}: ${group.columns.join(", ")} (${group.found}, expected ${group.expected})`,
    )
    .join("; ");
  const fix = "syncSchema({ alterColumns: true })";

  return {
    message: `${drift.length} identifier column${drift.length === 1 ? "" : "s"} of the jobs tables compare${drift.length === 1 ? "s" : ""} in a collation other than the one this driver declares, so keys differing only in case or accents are treated as one and prefix listings can come back empty or out of order: ${listed}. Repair with driver.${fix}, or the syncSchema option of the same shape; it rewrites each affected table under a lock that blocks every reader and writer until it finishes, so run it in a maintenance window. driver.syncSchema({ dryRun: true }) lists the statements.`,
    fields: { columns: [...drift], fix },
  };
}
