/**
 * Which sets of tables this process has already been warned about.
 *
 * The SQL driver warns on connect when a MySQL or MariaDB identifier column
 * compares in another collation (`SqlDriverOptions.logger`). That is advice
 * about a database, not about a driver, so saying it once per process is
 * enough: a service that builds several drivers over the same tables, or
 * reconnects, would otherwise repeat it on every connect.
 *
 * A **guard key** names "the same tables": the engine, the server's host and
 * port, the database, and every resolved table name (which is the table
 * prefix, plus any `tables` overrides) —
 * `mysql://127.0.0.1:3307/jobs#bun_jobs_jobs,bun_jobs_kv,…`. Never the user,
 * the password or the URL's parameters, since the key crosses into a child
 * process with its run. A different database or prefix is a different key and
 * warns once of its own. Hosts are compared as written, so `localhost` and
 * `127.0.0.1` are two keys, each warned once.
 *
 * The set lives on `globalThis` under a registered symbol rather than in this
 * module, so two copies of the package loaded into one process share it. A
 * `Worker` has its own `globalThis`, and a spawned child its own process, so
 * neither sees the parent's set: a runner hands its runs the keys it has
 * checked, and the run's runtime records them here with
 * {@link noteCollationChecked} before the handler builds a driver.
 *
 * The guard is bun-sql's (`createCollationGuard`, PR-D0b), made here under
 * the same registered name as before, so a copy of an older bun-jobs in the
 * same process still shares the set. It is imported from bun-sql's guard
 * module alone, which has no imports: the child runtime loads this before
 * anything else, and keeps its startup cost to what it uses.
 */
import { createCollationGuard } from "@kingsleyweb/bun-sql/lib/sync/collation-guard";

/** The process's guard, on `globalThis` under bun-jobs' registered name. */
const GUARD = createCollationGuard(
  "@kingsleyweb/bun-jobs/collation-drift-checked",
);

/**
 * Claims the warning for `key`: `true` the first time in this process (so the
 * caller warns), `false` after.
 */
export function claimCollationWarning(key: string): boolean {
  return GUARD.claim(key);
}

/** Records `keys` as checked, as a run's runtime does with the keys its runner handed it. */
export function noteCollationChecked(keys: Iterable<string>): void {
  GUARD.note(keys);
}

/** Forgets every checked key (tests). */
export function resetCollationWarnings(): void {
  GUARD.reset();
}
