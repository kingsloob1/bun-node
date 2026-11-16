/**
 * Schema sync: `@kingsleyweb/bun-sql/sync`. A driver's `syncSchema(options)`
 * resolves its options, then runs {@link syncSqlSchema} over its own
 * definition; `dryRun` returns the plan.
 *
 * ```ts
 * const changes = await syncSqlSchema(backend, dialect, definition, resolveSyncOptions({ dryRun: true }));
 * ```
 */
export { createCollationGuard } from "./collation-guard";
export type { CollationGuard } from "./collation-guard";
export {
  collationDrift,
  collationDriftWarning,
  compareColumn,
  readColumns,
  syncSqlSchema,
} from "./sync";
export type { CollationDrift, ColumnDifference, SqlColumnRow } from "./sync";
export { resolveSyncOptions } from "./types";
export type {
  ColumnRow,
  IndexRow,
  ResolvedSyncOptions,
  SchemaChange,
  SchemaSyncOptions,
  SyncBackend,
} from "./types";
