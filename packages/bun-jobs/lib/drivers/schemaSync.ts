/**
 * What a schema sync is, independent of which database it runs against.
 *
 * The SQL and MongoDB drivers both reconcile an existing database with the
 * schema the current version expects, and both report what they found in the
 * same shape — so a caller can handle either without knowing which it has.
 * What they can *do* differs: MongoDB has no column types, so nothing there
 * can rewrite a collection and `alterColumns` has nothing to mean.
 */

/** What a sync is allowed to change. */
export interface SchemaSyncOptions {
  /**
   * Add columns and indexes the driver defines and the database lacks.
   * Defaults to true — neither can block a running queue.
   */
  add?: boolean;
  /**
   * Drop indexes on the driver's own tables that it no longer defines, and
   * rebuild any whose predicate has changed. Defaults to true.
   *
   * Only ever touches indexes whose names the driver generates, so an index
   * added by hand is left alone.
   */
  indexes?: boolean;
  /**
   * Change column types that differ from what the driver would create.
   * Defaults to **false**.
   *
   * This is the one that rewrites the table. Turn it on for a deliberate
   * migration during a maintenance window, not for every process start.
   */
  alterColumns?: boolean;
  /**
   * Work out every change and report it without applying any.
   * Defaults to false.
   */
  dryRun?: boolean;
}

/** One difference between what the driver expects and what the database has. */
export interface SchemaChange {
  /** What sort of change it is. */
  kind: "add-column" | "alter-column" | "create-index" | "drop-index";
  /** The table it applies to. */
  table: string;
  /** The column or index it applies to. */
  target: string;
  /** The statement that makes it. */
  statement: string;
  /** Why it is needed, in a phrase. */
  reason: string;
  /** Whether it can stall a running queue while it runs. */
  blocking: boolean;
  /** Whether it was actually run, or only reported. */
  applied: boolean;
}

/** A table's columns as the database reports them. */
export interface ColumnRow {
  /** The column's name. */
  name: string;
  /** Its type, in the engine's own spelling. */
  type: string;
}

/** A table's indexes as the database reports them. */
export interface IndexRow {
  /** The index's name. */
  name: string;
  /** The engine's rendering of it, or `''` where it has none. */
  definition: string;
}

/** How a sync reads and writes; supplied by the driver. */
export interface SyncBackend {
  /** Runs a query and returns its rows. */
  all: <T>(text: string, params: unknown[]) => Promise<T[]>;
  /** Runs a statement for its effect. */
  run: (text: string) => Promise<unknown>;
}

/** The options a sync runs with once the defaults are filled in. */
export interface ResolvedSyncOptions {
  /** Add what is missing. */
  add: boolean;
  /** Reconcile the driver's own indexes. */
  indexes: boolean;
  /** Retype columns that differ. */
  alterColumns: boolean;
  /** Report without applying. */
  dryRun: boolean;
}

/** Fills in the defaults, which are "everything that cannot block". */
export function resolveSyncOptions(
  options: SchemaSyncOptions | boolean | undefined,
): ResolvedSyncOptions {
  const given = typeof options === "object" ? options : {};

  return {
    add: given.add ?? true,
    indexes: given.indexes ?? true,
    alterColumns: given.alterColumns ?? false,
    dryRun: given.dryRun ?? false,
  };
}
