/**
 * The SQL schema sync: bun-sql's (`@kingsleyweb/bun-sql/sync`, PR-D0b),
 * re-exported for bun-jobs' SQL driver unchanged, with the drift warning
 * naming "the jobs tables" as it always has.
 *
 * `syncSqlSchema` adds what is missing and reconciles the driver's own `ix_`
 * indexes; a column retype waits for `alterColumns`. `readColumns`,
 * `compareColumn` and `collationDrift` are the comparison it rests on, which
 * the driver's connect-time collation check reuses.
 */
import type { CollationDrift } from "@kingsleyweb/bun-sql/sync";
import { collationDriftWarning as sharedDriftWarning } from "@kingsleyweb/bun-sql/sync";

export {
  collationDrift,
  compareColumn,
  readColumns,
  syncSqlSchema,
} from "@kingsleyweb/bun-sql/sync";
export type {
  CollationDrift,
  ColumnDifference,
  SqlColumnRow,
} from "@kingsleyweb/bun-sql/sync";

/**
 * The one warning connecting logs for {@link CollationDrift}: every drifted
 * column, grouped by table and the collation found, and the fix.
 */
export function collationDriftWarning(
  drift: readonly CollationDrift[],
): ReturnType<typeof sharedDriftWarning> {
  return sharedDriftWarning(drift, "jobs tables");
}
