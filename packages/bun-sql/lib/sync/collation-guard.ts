/**
 * Which sets of tables this process has already been warned about.
 *
 * bun-jobs' SQL driver warns on connect when a MySQL or MariaDB identifier column
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
 * Moved from bun-jobs' `drivers/sql/collation-guard.ts` (bun-security plan,
 * storage.md §4.2) as a factory: each package keeps its own set under its own
 * registered symbol, so bun-jobs, moving onto bun-sql, keeps the one its
 * older copies share (`@kingsleyweb/bun-jobs/collation-drift-checked`).
 *
 * Deliberately free of imports: a child runtime loads it before anything
 * else, and keeps its startup cost to what it uses.
 */

/** A process-wide set of guard keys, and the three things done with it. */
export interface CollationGuard {
  /**
   * Whether the drift found under `key` is this process's to report: `true`
   * the first time it is asked for a key, and `false` from then on — and for
   * a key a parent already checked ({@link CollationGuard.note}).
   */
  readonly claim: (key: string) => boolean;
  /**
   * Records keys whose collation another process already checked — the
   * runner that started this run — so a driver built here for the same
   * tables does not repeat what that process said, or found nothing to say
   * about.
   */
  readonly note: (keys: Iterable<string>) => void;
  /**
   * Forgets every key, so the next drift found warns again. For tests: the
   * set is process-wide, and `bun test` runs every file in one process.
   */
  readonly reset: () => void;
}

/** `globalThis`, with the slots guards keep their sets in. */
type GuardHost = typeof globalThis & Record<symbol, Set<string> | undefined>;

/**
 * A collation guard whose set lives on `globalThis` under
 * `Symbol.for(name)`, created on first use, so every copy of a package that
 * names it shares it.
 */
export function createCollationGuard(name: string): CollationGuard {
  const slot = Symbol.for(name);
  const checked = (): Set<string> => {
    const host = globalThis as GuardHost;
    const found = host[slot] ?? new Set<string>();
    host[slot] = found;
    return found;
  };
  return Object.freeze({
    claim: (key: string): boolean => {
      const keys = checked();
      if (keys.has(key)) {
        return false;
      }
      keys.add(key);
      return true;
    },
    note: (keys: Iterable<string>): void => {
      const set = checked();
      for (const key of keys) {
        set.add(key);
      }
    },
    reset: (): void => {
      checked().clear();
    },
  });
}
