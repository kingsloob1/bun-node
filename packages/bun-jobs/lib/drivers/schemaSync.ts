/**
 * What a schema sync is, independent of which database it runs against.
 *
 * The SQL and MongoDB drivers both reconcile an existing database with the
 * schema the current version expects, and both report what they found in the
 * same shape — so a caller can handle either without knowing which it has.
 * What they can *do* differs: MongoDB has no column types, so nothing there
 * can rewrite a collection and `alterColumns` has nothing to mean.
 *
 * The shapes and the defaults are bun-sql's (`@kingsleyweb/bun-sql/sync`,
 * PR-D0b), re-exported here unchanged: `SchemaSyncOptions`, `SchemaChange`,
 * the rows a backend reads, and `resolveSyncOptions` ("everything that cannot
 * block").
 */
export { resolveSyncOptions } from "@kingsleyweb/bun-sql/sync";
export type {
  ColumnRow,
  IndexRow,
  ResolvedSyncOptions,
  SchemaChange,
  SchemaSyncOptions,
  SyncBackend,
} from "@kingsleyweb/bun-sql/sync";
