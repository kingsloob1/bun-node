/**
 * What differs between the SQL engines.
 *
 * The driver above is written once; everything an engine does its own way —
 * placeholders, JSON columns, how a row is claimed without two workers taking
 * it — is answered here. Keeping the list explicit is what makes it possible
 * to say honestly which engines are supported and how.
 *
 * Since PR-D0b every answer but the claim is bun-sql's
 * (`@kingsleyweb/bun-sql/dialect`, the bun-security plan's storage.md §4):
 * bun-jobs' {@link SqlDialect} is bun-sql's plus the job queue's claim
 * members, under the same name, and each engine here is bun-sql's dialect with
 * those members added. bun-sql's dialects are made through bun-jobs' error
 * seam (`./seam`), so a refusal is still bun-jobs' `ConfigError`.
 */
import type {
  AlterColumn,
  KeysetCursor,
  SqlDialect as SharedSqlDialect,
  SqlAdapter,
} from "@kingsleyweb/bun-sql/dialect";
import {
  isTransientLockError,
  withLockRetry,
} from "@kingsleyweb/bun-sql/connection";
import {
  declaredCollation,
  detectAdapter as detectSharedAdapter,
  dialectFor as sharedDialectFor,
} from "@kingsleyweb/bun-sql/dialect";
import { ConfigError } from "../../shared/errors";
import { JOBS_SQL } from "./seam";

export type { AlterColumn, KeysetCursor, SqlAdapter };
export { declaredCollation, isTransientLockError, withLockRetry };

/**
 * One engine's answers: bun-sql's {@link SharedSqlDialect}, plus the job
 * queue's claim members.
 */
export interface SqlDialect extends SharedSqlDialect {
  /**
   * Whether the claim index names `id` as its last column.
   *
   * Only MySQL. Claim order is `priority, created_at, id`, and InnoDB appends
   * the primary key to every secondary index, so the index already ends in
   * `id` — MariaDB and Postgres (whose index has no such suffix, and plans the
   * tie-break differently) read it in that order. MySQL 8.4 does not use the
   * implicit suffix to satisfy an `ORDER BY`: it reads every row of the queue
   * through the primary key and sorts them, 9.3ms for one job from a queue of
   * 20,000 against 0.29ms with `id` named, and a claim window that skips names
   * is no longer bounded at all. Naming it makes the key 3,068 bytes, inside
   * InnoDB's 3,072.
   */
  readonly claimIndexNamesId: boolean;
  /**
   * Column type for the attribution stamp's text: the claiming worker's id,
   * key and host (`processed_by_id`, `processed_by_key`, `processed_by_host`).
   *
   * Exact, like {@link SqlDialect.idType}, because a key filter must not match
   * `SVC` for `svc`; but unbounded, like {@link SqlDialect.nameType}, because
   * none is indexed and none is short by rule — a host name may be 253
   * characters — and on MySQL and MariaDB a value too wide for a bounded
   * column is an error, which here would fail the claim itself. Its own member
   * rather than `nameType`: the columns are new, so no install ever created
   * them in an older collation, and they follow neither type's history.
   */
  readonly stampType: string;
  /**
   * "After `cursor` in claim order" — `(priority, created_at, id)` — in the
   * form this engine bounds an index range with: the predicate the windowed
   * claim resumes with, shared with the pending-options rewrite's keyset walk.
   */
  claimOrderAfter: (
    bind: ClaimStatementOptions["bind"],
    cursor: ClaimCursor,
  ) => string;
  /**
   * Builds the statement that claims one job.
   *
   * This is the one query the engines genuinely disagree about, so each
   * writes its own rather than sharing a shape that only looks portable. The
   * requirement is the same everywhere: pick at most one due row, take it,
   * and let a concurrent claimer take a different one.
   */
  claim: (options: ClaimStatementOptions) => string;
  /**
   * The rows a claim may take, as a statement of its own.
   *
   * Needed by engines that cannot return the row they updated: they pick the
   * id first, then update exactly that row. See {@link claimById}.
   */
  claimCandidate: (options: ClaimStatementOptions) => string;
  /** Takes one specific job, for the same engines. */
  claimById: (options: ClaimStatementOptions, id: string) => string;
  /**
   * The last row of the window a claim that skips names looks at from
   * `options.after`, as `priority`, `created_at` and `id` — or no row when the
   * window is not full, which means it reached the end of the queue.
   *
   * The claim only reports what it took. Resuming past the rows it passed over
   * needs to know where they ended, and every name counts here, skipped or not.
   */
  claimWindowEnd: (options: ClaimStatementOptions) => string;
  /**
   * Whether the claim statement needs a transaction wrapped around it.
   *
   * Postgres does not: its data-modifying CTE is atomic on its own, and the
   * wrapper measured 0.31ms of a 1.16ms claim — 27% for nothing. SQLite does,
   * because `BEGIN IMMEDIATE` *is* its exclusivity, and MySQL and MariaDB do,
   * because their claim is more than one statement.
   */
  readonly claimNeedsTransaction: boolean;
}

/** What a dialect needs in order to write its claim statement. */
export interface ClaimStatementOptions {
  /** The jobs table. */
  table: string;
  /**
   * Appends a value to the statement's parameters and returns its
   * placeholder. Called in the order the values appear in the statement.
   */
  bind: (value: unknown) => string;
  /** The namespace to claim from. */
  ns: string;
  /** The queue to claim from. */
  queue: string;
  /** The caller's clock. */
  now: number;
  /** The token to stamp on the claimed job. */
  token: string;
  /** The worker doing the claiming. */
  workerId: string;
  /**
   * The claiming worker's key, host and pid, stamped with `workerId` as the
   * attribution stamp (`processed_by_*`). `null` stamps the id alone, clearing
   * whatever key, host and pid an earlier claim stamped, so a stamp is always
   * one claim's whole. Absent names none of the stamp's columns — for a table
   * not yet synced, which does not have them — and leaves the statement
   * byte-identical to one from before they existed.
   *
   * Present, it is bound whether `null` or not, so the claim stays one
   * statement text either way.
   */
  worker?: { key: string; host: string; pid: number } | null;
  /** How long the claim's lock lives. */
  lockMs: number;
  /**
   * How many jobs the statement may take. Defaults to one.
   *
   * A literal, not a bound parameter: it comes from the worker's free slots,
   * never from user input, and every engine here will only plan a `LIMIT` it
   * can see. It is floored at one and rounded down.
   */
  limit?: number;
  /**
   * Job names the claim must pass over. Absent or empty adds nothing to the
   * statement, which is then byte-identical to one without the option — the
   * claim is the hottest statement in the library, and a different text is a
   * different prepared statement.
   */
  excludeNames?: string[];
  /**
   * Where a claim that skips names resumes: only rows after this one in claim
   * order are looked at. Ignored without `excludeNames`; absent or `null`
   * means from the head of the queue.
   */
  after?: ClaimCursor | null;
}

/** A row's place in claim order, which is where a claim can resume from. */
export interface ClaimCursor {
  /** The row's `priority`. */
  priority: number;
  /** The row's `created_at`, in epoch milliseconds. */
  createdAt: number;
  /** The row's id, which orders the rows the two above leave tied. */
  id: string;
}

/**
 * How many waiting rows one pass of a claim that skips names looks at.
 *
 * `name NOT IN (…)` is a filter on the claim index, not a key of it, so on its
 * own the scan walks past every skipped row before reaching one it may take:
 * measured on Postgres with 100,000 of them at the head, 22.1ms against
 * 0.055ms, paid again on every retry while the name stays capped. Bounding the
 * scan caps a pass at this many rows; the driver resumes where the last full
 * window ended, so a job further back is still reached.
 */
export const CLAIM_WINDOW = 1_000;

/** The columns a claim sets, shared by the dialects that write it. */
function claimAssignments(options: ClaimStatementOptions, prefix = ""): string {
  const { bind } = options;

  return [
    `${prefix}state = 'active'`,
    `${prefix}attempts_made = ${prefix}attempts_made + 1`,
    `${prefix}processed_on = ${bind(options.now)}`,
    `${prefix}lock_token = ${bind(options.token)}`,
    `${prefix}lock_expires_at = ${bind(options.now + options.lockMs)}`,
    `${prefix}worker_id = ${bind(options.workerId)}`,
    ...(options.worker === undefined
      ? []
      : [
          `${prefix}processed_by_id = ${bind(options.workerId)}`,
          `${prefix}processed_by_key = ${bind(options.worker?.key ?? null)}`,
          `${prefix}processed_by_host = ${bind(options.worker?.host ?? null)}`,
          `${prefix}processed_by_pid = ${bind(options.worker?.pid ?? null)}`,
        ]),
  ].join(", ");
}

/** How one engine locks, and resumes, the rows its claim picks. */
interface ClaimShape {
  /** Appended to the plain candidate query: `FOR UPDATE SKIP LOCKED`, or `""`. */
  locking: string;
  /**
   * Appended to the windowed candidate query, which joins the window back to
   * the table so only the rows it returns are locked. `null` on an engine with
   * no row locks, where the window is filtered as it is.
   */
  windowLocking: string | null;
  /** A predicate: the row comes after `cursor` in claim order. */
  after: (bind: ClaimStatementOptions["bind"], cursor: ClaimCursor) => string;
}

/**
 * "After `cursor` in claim order", in the form Postgres and SQLite plan as an
 * index range.
 *
 * Not the obvious `(priority, created_at, id) > (…)`. Postgres estimates a row
 * comparison from its first column alone, and with every row on one priority
 * it expects no rows and picks a sequential scan: 29.9ms for a window halfway
 * into 100,000 rows. The two-column `>=` is a bound on columns the claim index
 * has, and the disjunction only removes rows tied with the cursor itself:
 * 0.70ms for the same window. SQLite plans the `>=` as an index range too.
 */
function rowValueAfter(
  bind: ClaimStatementOptions["bind"],
  cursor: ClaimCursor,
): string {
  return `(priority, created_at) >= (${bind(cursor.priority)}, ${bind(cursor.createdAt)})
           AND (priority >${bind(cursor.priority)} OR created_at > ${bind(cursor.createdAt)} OR id > ${bind(cursor.id)})`;
}

/**
 * The same predicate written out column by column, for MySQL and MariaDB.
 *
 * MariaDB does not bound a range scan with a row comparison: the form above
 * read 11,001 index rows for a 1,000-row window starting at row 10,000
 * (19.8ms), and this one read 1,000 (3.4ms). On Postgres it is the reverse —
 * this form is a filter there, not a bound.
 */
function expandedAfter(
  bind: ClaimStatementOptions["bind"],
  cursor: ClaimCursor,
): string {
  return `(priority > ${bind(cursor.priority)} OR (priority = ${bind(cursor.priority)}
           AND (created_at > ${bind(cursor.createdAt)} OR (created_at = ${bind(cursor.createdAt)} AND id > ${bind(cursor.id)}))))`;
}

/** The queue's waiting, due rows, from `options.after` when there is one. */
function claimWindowFilter(
  options: ClaimStatementOptions,
  shape: ClaimShape,
): string {
  const { bind } = options;

  return `ns = ${bind(options.ns)} AND queue = ${bind(options.queue)}
           AND state = 'waiting' AND run_at <= ${bind(options.now)}${
             options.after
               ? `
           AND ${shape.after(bind, options.after)}`
               : ""
           }`;
}

/** The rows a claim may take, ordered so the cheapest comes first. */
function claimCandidates(
  options: ClaimStatementOptions,
  shape: ClaimShape,
): string {
  const { bind, table } = options;

  const limit = Math.max(1, Math.floor(options.limit ?? 1));
  const excluded = options.excludeNames ?? [];

  if (excluded.length === 0) {
    return `SELECT id FROM ${table}
       WHERE ns = ${bind(options.ns)} AND queue = ${bind(options.queue)}
         AND state = 'waiting' AND run_at <= ${bind(options.now)}
       ORDER BY priority ASC, created_at ASC, id ASC
       LIMIT ${limit}${shape.locking}`;
  }

  // Skipped names are a filter, not a key of the claim index: a capped name is
  // the exception, so widening the index for it would tax every insert for a
  // clause most claims never carry. Filtering *outside* a bounded window is
  // what keeps the filter from walking an unbounded run of skipped rows; the
  // driver slides the window with `after`.
  //
  // Built before the text that follows it, because it also comes first in the
  // statement: `bind` numbers placeholders in call order.
  const window = `SELECT id, name, priority, created_at FROM ${table}
         WHERE ${claimWindowFilter(options, shape)}
         ORDER BY priority ASC, created_at ASC, id ASC
         LIMIT ${CLAIM_WINDOW}`;

  if (shape.windowLocking === null) {
    return `SELECT id FROM (${window}) AS win
       WHERE name NOT IN (${excluded.map((name) => bind(name)).join(", ")})
       ORDER BY priority ASC, created_at ASC, id ASC
       LIMIT ${limit}`;
  }

  // Locked through a join back to the table, never inside the window: locking
  // there would lock every row the window passes over, up to a thousand skipped
  // jobs a worker skipping other names could have taken. Postgres locks only
  // `job` because it is named, InnoDB because a derived table is read without
  // locks — checked with two open transactions on MariaDB, the second took the
  // next job rather than nothing. The window is read from the statement's
  // snapshot, so `job.state` is what is rechecked once the row is locked.
  return `SELECT job.id FROM (${window}) AS win
       JOIN ${table} job
         ON job.ns = ${bind(options.ns)} AND job.queue = ${bind(options.queue)}
        AND job.id = win.id
       WHERE win.name NOT IN (${excluded.map((name) => bind(name)).join(", ")})
         AND job.state = 'waiting'
       ORDER BY win.priority ASC, win.created_at ASC, win.id ASC
       LIMIT ${limit}${shape.windowLocking}`;
}

/** Picks the id of the row a claim would take. */
function claimCandidateStatement(
  options: ClaimStatementOptions,
  shape: ClaimShape,
): string {
  return claimCandidates(options, shape);
}

/** See {@link SqlDialect.claimWindowEnd}. */
function claimWindowEndStatement(
  options: ClaimStatementOptions,
  shape: ClaimShape,
): string {
  return `SELECT priority, created_at, id FROM ${options.table}
       WHERE ${claimWindowFilter(options, shape)}
       ORDER BY priority ASC, created_at ASC, id ASC
       LIMIT 1 OFFSET ${CLAIM_WINDOW - 1}`;
}

/** Postgres locks named rows and ranges on a two-column row comparison. */
const POSTGRES_CLAIM: ClaimShape = {
  locking: " FOR UPDATE SKIP LOCKED",
  windowLocking: " FOR UPDATE OF job SKIP LOCKED",
  after: rowValueAfter,
};

/** MySQL and MariaDB: no `OF`, and a range only on the spelled-out predicate. */
const MYSQL_CLAIM: ClaimShape = {
  locking: " FOR UPDATE SKIP LOCKED",
  windowLocking: " FOR UPDATE SKIP LOCKED",
  after: expandedAfter,
};

/** SQLite has no row locks to take. */
const SQLITE_CLAIM: ClaimShape = {
  locking: "",
  windowLocking: null,
  after: rowValueAfter,
};

/** Takes one specific job, conditional on it still being claimable. */
function claimByIdStatement(
  options: ClaimStatementOptions,
  id: string,
): string {
  const { bind, table } = options;

  return `UPDATE ${table} SET ${claimAssignments(options)}
     WHERE ns = ${bind(options.ns)} AND queue = ${bind(options.queue)}
       AND id = ${bind(id)} AND state = 'waiting'`;
}

/** The members bun-jobs adds to bun-sql's dialect: the claim, and its stamp's type. */
type ClaimMembers = Omit<SqlDialect, keyof SharedSqlDialect>;

/** Postgres: `SKIP LOCKED` for claiming, in a data-modifying CTE. */
const POSTGRES_CLAIMS: ClaimMembers = {
  claimIndexNamesId: false,
  stampType: "TEXT",
  claimOrderAfter: rowValueAfter,
  /**
   * A CTE, not `IN (SELECT ... LIMIT 1 FOR UPDATE SKIP LOCKED)`.
   *
   * That subquery form looks right and is not: Postgres may re-evaluate the
   * sub-plan, and because `SKIP LOCKED` yields a *different* row each time it
   * is evaluated, the `LIMIT 1` fails to bound the update. Measured, it
   * claimed two jobs and returned one, silently leaving the other `active`
   * with a token nobody held. A data-modifying statement's CTE is evaluated
   * exactly once, so the bound holds.
   */
  claim: (options) => {
    const { bind, table } = options;

    // Built inline, in statement order: `bind` numbers parameters as it is
    // called, so a fragment computed early would be numbered early too.
    return `WITH picked AS (${claimCandidates(options, POSTGRES_CLAIM)})
      UPDATE ${table} SET ${claimAssignments(options)}
        FROM picked
       WHERE ${table}.ns = ${bind(options.ns)}
         AND ${table}.queue = ${bind(options.queue)}
         AND ${table}.id = picked.id
         AND ${table}.state = 'waiting'
      RETURNING ${table}.*`;
  },
  claimCandidate: (options) => claimCandidateStatement(options, POSTGRES_CLAIM),
  claimById: claimByIdStatement,
  claimWindowEnd: (options) => claimWindowEndStatement(options, POSTGRES_CLAIM),
  claimNeedsTransaction: false,
};

/** MySQL 8: `SKIP LOCKED` through a join, and the claim index naming `id`. */
const MYSQL_CLAIMS: ClaimMembers = {
  claimIndexNamesId: true,
  // Binary and `NO PAD`: see `idType` on bun-sql's dialect. `utf8mb4_0900_bin`
  // is MySQL 8's; MariaDB has its own, below.
  stampType: "TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin",
  claimOrderAfter: expandedAfter,
  /**
   * A join against a derived table. MySQL materialises it, so the `LIMIT 1`
   * bounds the update, and it also sidesteps the refusal to read the table
   * being updated from a `WHERE` subquery.
   */
  claim: (options) => {
    const { bind, table } = options;

    // Built inline, in statement order, for the same reason as the others.
    return `UPDATE ${table}
        JOIN (${claimCandidates(options, MYSQL_CLAIM)}) AS picked
          ON ${table}.id = picked.id
         SET ${claimAssignments(options, `${table}.`)}
       WHERE ${table}.ns = ${bind(options.ns)}
         AND ${table}.queue = ${bind(options.queue)}
         AND ${table}.state = 'waiting'`;
  },
  claimCandidate: (options) => claimCandidateStatement(options, MYSQL_CLAIM),
  claimById: claimByIdStatement,
  claimWindowEnd: (options) => claimWindowEndStatement(options, MYSQL_CLAIM),
  claimNeedsTransaction: true,
};

/** MariaDB: MySQL's claim, with its own exact collation. */
const MARIADB_CLAIMS: ClaimMembers = {
  ...MYSQL_CLAIMS,
  // MariaDB reads the claim index's implicit `id` suffix in order, so it need
  // not be named: see the interface.
  claimIndexNamesId: false,
  // `utf8mb4_nopad_bin` has been MariaDB's exact collation since 10.2. It
  // compares by code point, which for UTF-8 is byte order.
  stampType: "TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin",
};

/** SQLite: one writer at a time, so nothing to skip. */
const SQLITE_CLAIMS: ClaimMembers = {
  claimIndexNamesId: false,
  stampType: "TEXT",
  claimOrderAfter: rowValueAfter,
  /**
   * A scalar subquery under the database's write lock. There is no
   * `SKIP LOCKED` because there is nothing to skip: `BEGIN IMMEDIATE` makes
   * this connection the only writer, so the row it picks is its own.
   */
  claim: (options) => {
    const { bind, table } = options;

    // Every fragment is built inline, at the position it occupies in the
    // statement: `bind` numbers parameters in call order, so anything
    // computed ahead of time would be numbered ahead of where it appears.
    return `UPDATE ${table} SET ${claimAssignments(options)}
       WHERE ns = ${bind(options.ns)} AND queue = ${bind(options.queue)}
         AND state = 'waiting'
         AND id = (${claimCandidates(options, SQLITE_CLAIM)})
      RETURNING *`;
  },
  claimCandidate: (options) => claimCandidateStatement(options, SQLITE_CLAIM),
  claimById: claimByIdStatement,
  claimWindowEnd: (options) => claimWindowEndStatement(options, SQLITE_CLAIM),
  claimNeedsTransaction: true,
};

/** bun-sql's dialect for `adapter`, through bun-jobs' seam, with `claims` added. */
function withClaims(adapter: SqlAdapter, claims: ClaimMembers): SqlDialect {
  return { ...sharedDialectFor(adapter, JOBS_SQL), ...claims };
}

/** Every dialect, by name. */
const DIALECTS: Record<SqlAdapter, SqlDialect> = {
  postgres: withClaims("postgres", POSTGRES_CLAIMS),
  mysql: withClaims("mysql", MYSQL_CLAIMS),
  mariadb: withClaims("mariadb", MARIADB_CLAIMS),
  sqlite: withClaims("sqlite", SQLITE_CLAIMS),
};

/** The dialect for an adapter name. */
export function dialectFor(adapter: SqlAdapter): SqlDialect {
  const dialect = DIALECTS[adapter];
  if (!dialect) {
    throw new ConfigError(`Unsupported SQL adapter "${adapter}"`, { adapter });
  }
  return dialect;
}

/**
 * Works out which engine a URL points at, so a caller need not repeat what
 * the connection string already says.
 */
export function detectAdapter(url: string | undefined): SqlAdapter {
  return detectSharedAdapter(url, JOBS_SQL);
}
