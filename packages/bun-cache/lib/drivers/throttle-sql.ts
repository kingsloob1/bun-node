/**
 * The throttle's counters on the SQL drivers (`lib/core/throttle-counters.ts`):
 * one statement on Postgres, one multi-statement query on MySQL and MariaDB,
 * one `BEGIN IMMEDIATE` transaction on SQLite. Each reads the time from the
 * database unless given one. Counters are entry-table rows with `v` null, as
 * `increment` writes them, so the cache's `delete`, `clear` and sweeper reach
 * them; a GCRA bucket's `n` is its theoretical arrival time in µs.
 */
import type { Database } from "bun:sqlite";
import type { SQL } from "bun";
import type {
  GcraStepResult,
  ThrottleCounters,
} from "../core/throttle-counters";
import { counterNumber } from "../core/throttle-counters";
import { withLockRetry } from "./sql-connection";

/** What a SQL driver hands the throttle's counters. */
export interface SqlThrottleTarget {
  /** Awaits the connection and the schema. */
  ready: () => Promise<void>;
  /** The client. */
  sql: SQL;
  /** The entry table's name, quoted as the driver writes it. */
  entries: string;
  /** A name as the driver stores it (hashed past 255 characters). */
  fit: (name: string) => string;
}

/** A GCRA step's answer from the time, the arrival time the write returned (`null` when refused or not written) and the one read. */
function gcraAnswer(
  now: number,
  written: unknown,
  read: unknown,
  step: number,
): GcraStepResult {
  if (written !== null && written !== undefined) {
    return { allowed: true, tat: counterNumber(written), now };
  }
  const stored =
    read === null || read === undefined ? now : counterNumber(read);
  return { allowed: step === 0, tat: Math.max(stored, now), now };
}

/** A number as a SQL literal; refuses anything but a finite number, so nothing else is ever inlined. */
function literal(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(
      `throttle counters: not a finite number: ${String(value)}`,
    );
  }
  return String(value);
}

/* ------------------------------------------------------------------ */
/* Postgres                                                            */
/* ------------------------------------------------------------------ */

/** The time in ms (or µs), `$n` when it is not null, else the server's. */
function pgNow(param: string, scale: 1000 | 1000000): string {
  return `COALESCE(${param}::double precision, floor(extract(epoch FROM clock_timestamp()) * ${scale}))`;
}

/** Postgres: each step one statement (CTEs), timed by `clock_timestamp()`. */
export function postgresThrottleCounters(
  target: SqlThrottleTarget,
): ThrottleCounters {
  const e = target.entries;
  const live = (alias: string, now: string): string =>
    `${alias}.v IS NULL AND ${alias}.n IS NOT NULL AND (${alias}.exp IS NULL OR ${alias}.exp > ${now})`;
  return {
    window: async (ns, base, step) => {
      await target.ready();
      const read = (index: string): string =>
        `(SELECT r.n FROM ${e} r WHERE r.ns = $1 AND r.k = $2 || ':' || (${index}) AND ${live("r", "w.now")})`;
      const previous = step.previous ? read("w.idx - 1") : "0";
      const reset = `(${e}.v IS NOT NULL OR ${e}.n IS NULL OR (${e}.exp IS NOT NULL AND ${e}.exp <= excluded.ca))`;
      const head = `WITH w AS (SELECT now, floor(now / $4::double precision)::bigint AS idx FROM (SELECT ${pgNow("$3", 1000)} AS now) c)`;
      const statement =
        step.cost > 0
          ? `${head},
             up AS (
               INSERT INTO ${e} (ns, k, v, n, exp, ca, tg)
               SELECT $1, $2 || ':' || w.idx, NULL, $5::bigint, ceil((w.idx + $6::bigint) * $4::double precision + $7::double precision)::bigint, floor(w.now)::bigint, NULL FROM w
               ON CONFLICT (ns, k) DO UPDATE SET
                 n = CASE WHEN ${reset} THEN excluded.n ELSE ${e}.n + excluded.n END,
                 exp = CASE WHEN ${reset} THEN excluded.exp ELSE ${e}.exp END,
                 ca = CASE WHEN ${reset} THEN excluded.ca ELSE ${e}.ca END,
                 v = NULL, tg = NULL
               RETURNING n)
             SELECT w.now, (SELECT n FROM up) AS cur, ${previous} AS prev FROM w`
          : `${head} SELECT w.now, ${read("w.idx")} AS cur, ${previous} AS prev FROM w`;
      const rows = await target.sql.unsafe<
        { now: unknown; cur: unknown; prev: unknown }[]
      >(statement, [
        target.fit(ns),
        base,
        step.now ?? null,
        step.window,
        ...(step.cost > 0
          ? [step.cost, step.previous ? 2 : 1, step.margin]
          : []),
      ]);
      return {
        current: counterNumber(rows[0].cur),
        previous: counterNumber(rows[0].prev),
        now: counterNumber(rows[0].now),
      };
    },
    deleteWindow: async (ns, base, window, now) => {
      await target.ready();
      await target.sql.unsafe(
        `WITH w AS (SELECT floor(now / $4::double precision)::bigint AS idx FROM (SELECT ${pgNow("$3", 1000)} AS now) c)
         DELETE FROM ${e} WHERE ns = $1 AND v IS NULL AND k IN (SELECT $2 || ':' || w.idx FROM w UNION ALL SELECT $2 || ':' || (w.idx - 1) FROM w)`,
        [target.fit(ns), base, now ?? null, window],
      );
    },
    gcra: async (ns, key, step) => {
      await target.ready();
      const head = `WITH c AS (SELECT ${pgNow("$3", 1000000)}::bigint AS now)`;
      const old = `(SELECT o.n FROM ${e} o WHERE o.ns = $1 AND o.k = $2 AND o.v IS NULL AND o.n IS NOT NULL)`;
      // The arrival time after the step: the stored one (never before now)
      // plus the step. `excluded.n` is now + step.
      const tat = `GREATEST(CASE WHEN ${e}.v IS NULL AND ${e}.n IS NOT NULL THEN ${e}.n + $4::bigint ELSE 0 END, excluded.n)`;
      const writes = step.step > 0 && step.step <= step.capacity;
      const statement = writes
        ? `${head},
           up AS (
             INSERT INTO ${e} (ns, k, v, n, exp, ca, tg)
             SELECT $1, $2, NULL, c.now + $4::bigint, ceil((c.now + $4::bigint) / 1000.0)::bigint + $6::bigint, c.now / 1000, NULL FROM c
             ON CONFLICT (ns, k) DO UPDATE SET
               n = ${tat},
               exp = ceil(${tat} / 1000.0)::bigint + $6::bigint,
               ca = excluded.ca, v = NULL, tg = NULL
             WHERE ${tat} - (excluded.n - $4::bigint) <= $5::bigint
             RETURNING n)
           SELECT c.now, (SELECT n FROM up) AS written, ${old} AS read FROM c`
        : `${head} SELECT c.now, NULL AS written, ${old} AS read FROM c`;
      const rows = await target.sql.unsafe<
        { now: unknown; written: unknown; read: unknown }[]
      >(statement, [
        target.fit(ns),
        key,
        step.now === undefined ? null : Math.floor(step.now),
        ...(writes ? [step.step, step.capacity, step.margin] : []),
      ]);
      return gcraAnswer(
        counterNumber(rows[0].now),
        rows[0].written,
        rows[0].read,
        step.step,
      );
    },
  };
}

/* ------------------------------------------------------------------ */
/* MySQL and MariaDB                                                   */
/* ------------------------------------------------------------------ */

/** What MySQL and MariaDB add: the key columns' collation. */
export interface MysqlThrottleTarget extends SqlThrottleTarget {
  /** The collation of the `ns` and `k` columns, so a key built on the server compares with them. */
  collation: string;
}

/**
 * A string as a MySQL literal that cannot break out of itself: its UTF-8
 * bytes in hex, with the `_utf8mb4` introducer (coercible, so the column's
 * collation decides).
 */
function mysqlText(value: string): string {
  return `_utf8mb4 X'${new TextEncoder().encode(value).toHex()}'`;
}

/**
 * The statements that set `@bct_now`: the given time, else the server's, in
 * ms (or µs), from `UTC_TIMESTAMP(6)` so the session's time zone plays no
 * part. Each `SET` its own statement: MySQL evaluates every right-hand side
 * of one `SET` before assigning any.
 */
function mysqlNow(now: number | undefined, scale: 1000 | 1000000): string {
  const server = `CAST(TIMESTAMPDIFF(MICROSECOND, '1970-01-01 00:00:00', UTC_TIMESTAMP(6))${scale === 1000 ? " DIV 1000" : ""} AS SIGNED)`;
  return `SET @bct_now = ${now === undefined ? server : literal(now)};`;
}

/**
 * MySQL and MariaDB: each step one multi-statement query (Bun's client sends
 * an unparameterised query as text, so several statements are one round
 * trip; every value is inlined as a checked number or a hex literal). The
 * count comes back through `LAST_INSERT_ID(expr)`, which is per connection,
 * as `increment` reads it.
 */
export function mysqlThrottleCounters(
  target: MysqlThrottleTarget,
): ThrottleCounters {
  const e = target.entries;
  const keyed = (expr: string): string =>
    `CONVERT(${expr} USING utf8mb4) COLLATE ${target.collation}`;
  /** The last result set of a multi-statement query. */
  const last = <T>(answer: unknown): T => {
    const sets = answer as unknown[];
    const rows = (
      Array.isArray(sets[sets.length - 1]) ? sets[sets.length - 1] : sets
    ) as T[];
    return rows[0];
  };
  return {
    window: async (ns, base, step) => {
      await target.ready();
      const n = mysqlText(target.fit(ns));
      const b = mysqlText(base);
      const w = literal(step.window);
      const cost = literal(step.cost);
      const exp = `CEIL((@bct_i + ${step.previous ? 2 : 1}) * ${w} + ${literal(step.margin)})`;
      const lapsed = "(exp IS NOT NULL AND exp <= @bct_now)";
      const read = (key: string): string =>
        `(SELECT n FROM ${e} WHERE ns = ${n} AND k = ${key} AND v IS NULL AND n IS NOT NULL AND (exp IS NULL OR exp > @bct_now))`;
      const statements = [
        mysqlNow(step.now, 1000),
        `SET @bct_i = CAST(FLOOR(@bct_now / ${w}) AS SIGNED);`,
        `SET @bct_k = ${keyed(`CONCAT(${b}, ':', @bct_i)`)};`,
        `SET @bct_p = ${keyed(`CONCAT(${b}, ':', CAST(@bct_i - 1 AS SIGNED))`)};`,
      ];
      if (step.cost > 0) {
        statements.push(
          `INSERT INTO ${e} (ns, k, v, n, exp, ca, tg) VALUES (${n}, @bct_k, NULL, CAST(LAST_INSERT_ID(${cost}) AS SIGNED), ${exp}, @bct_now, NULL)
           ON DUPLICATE KEY UPDATE
             n = CAST(LAST_INSERT_ID(IF(v IS NOT NULL OR n IS NULL OR ${lapsed}, ${cost}, n + ${cost})) AS SIGNED),
             ca = IF(v IS NOT NULL OR ${lapsed}, @bct_now, ca),
             exp = IF(v IS NOT NULL OR ${lapsed}, ${exp}, exp),
             v = NULL, tg = NULL;`,
          `SELECT @bct_now AS now, CAST(LAST_INSERT_ID() AS SIGNED) AS cur, ${step.previous ? read("@bct_p") : "0"} AS prev;`,
        );
      } else {
        statements.push(
          `SELECT @bct_now AS now, ${read("@bct_k")} AS cur, ${step.previous ? read("@bct_p") : "0"} AS prev;`,
        );
      }
      const row = await withLockRetry(async () =>
        last<{ now: unknown; cur: unknown; prev: unknown }>(
          await target.sql.unsafe(statements.join("\n")),
        ),
      );
      return {
        current: counterNumber(row.cur),
        previous: counterNumber(row.prev),
        now: counterNumber(row.now),
      };
    },
    deleteWindow: async (ns, base, window, now) => {
      await target.ready();
      const b = mysqlText(base);
      const w = literal(window);
      await withLockRetry(async () =>
        target.sql.unsafe(
          [
            mysqlNow(now, 1000),
            `SET @bct_i = CAST(FLOOR(@bct_now / ${w}) AS SIGNED);`,
            `DELETE FROM ${e} WHERE ns = ${mysqlText(target.fit(ns))} AND v IS NULL AND k IN (${keyed(`CONCAT(${b}, ':', @bct_i)`)}, ${keyed(`CONCAT(${b}, ':', CAST(@bct_i - 1 AS SIGNED))`)});`,
          ].join("\n"),
        ),
      );
    },
    gcra: async (ns, key, step) => {
      await target.ready();
      const n = mysqlText(target.fit(ns));
      const k = mysqlText(key);
      const by = literal(step.step);
      const margin = literal(step.margin);
      const read = `(SELECT n FROM ${e} WHERE ns = ${n} AND k = ${k} AND v IS NULL AND n IS NOT NULL)`;
      const writes = step.step > 0 && step.step <= step.capacity;
      const statements = [
        mysqlNow(
          step.now === undefined ? undefined : Math.floor(step.now),
          1000000,
        ),
      ];
      if (writes) {
        // The arrival time after the step, and whether it fits, both from
        // the old row: `exp` and `ca` are assigned before `n` changes. A
        // refused step leaves `n` and resets LAST_INSERT_ID to 0 (the
        // VALUES clause set it, the duplicate path must undo that). Only a
        // counter can refuse (an entry's row reads as an empty bucket, and
        // the step fits one), so clearing `v` and `tg` is always right.
        const tat = `(GREATEST(IF(v IS NULL AND n IS NOT NULL, n, 0), @bct_now) + ${by})`;
        const fits = `(${tat} - @bct_now <= ${literal(step.capacity)})`;
        statements.push(
          `INSERT INTO ${e} (ns, k, v, n, exp, ca, tg) VALUES (${n}, ${k}, NULL, CAST(LAST_INSERT_ID(@bct_now + ${by}) AS SIGNED), CEIL((@bct_now + ${by}) / 1000) + ${margin}, @bct_now DIV 1000, NULL)
           ON DUPLICATE KEY UPDATE
             exp = IF(${fits}, CEIL(${tat} / 1000) + ${margin}, exp),
             ca = IF(${fits}, @bct_now DIV 1000, ca),
             n = IF(${fits}, CAST(LAST_INSERT_ID(${tat}) AS SIGNED), n + LAST_INSERT_ID(0)),
             v = NULL, tg = NULL;`,
          `SELECT @bct_now AS now, CAST(LAST_INSERT_ID() AS SIGNED) AS written, ${read} AS \`read\`;`,
        );
      } else {
        statements.push(
          `SELECT @bct_now AS now, NULL AS written, ${read} AS \`read\`;`,
        );
      }
      const row = await withLockRetry(async () =>
        last<{ now: unknown; written: unknown; read: unknown }>(
          await target.sql.unsafe(statements.join("\n")),
        ),
      );
      const written = counterNumber(row.written);
      return gcraAnswer(
        counterNumber(row.now),
        written > 0 ? written : null,
        row.read,
        step.step,
      );
    },
  };
}

/* ------------------------------------------------------------------ */
/* SQLite                                                              */
/* ------------------------------------------------------------------ */

/** What the SQLite driver hands the throttle's counters. */
export interface SqliteThrottleTarget {
  /** Runs `work` in one `BEGIN IMMEDIATE` transaction. */
  write: <T>(work: (db: Database) => T) => Promise<T>;
  /** The entry table's name, quoted. */
  entries: string;
}

/**
 * SQLite: each step one `BEGIN IMMEDIATE` transaction, so it is atomic
 * against every other process on the file; the time is SQLite's
 * `julianday('now')`, the host's clock, never the driver's `now` option.
 */
export function sqliteThrottleCounters(
  target: SqliteThrottleTarget,
): ThrottleCounters {
  const e = target.entries;
  const nowMs = `SELECT CAST((julianday('now') - 2440587.5) * 86400000.0 AS INTEGER) AS now`;
  const read = `SELECT n FROM ${e} WHERE ns = ?1 AND k = ?2 AND v IS NULL AND n IS NOT NULL AND (exp IS NULL OR exp > ?3)`;
  const live = `${e}.v IS NULL AND ${e}.n IS NOT NULL AND (${e}.exp IS NULL OR ${e}.exp > ?5)`;
  const upsert = `INSERT INTO ${e} (ns, k, v, n, exp, tg, ca) VALUES (?1, ?2, NULL, ?3, ?4, NULL, ?5) ON CONFLICT (ns, k) DO UPDATE SET n = CASE WHEN ${live} THEN ${e}.n + excluded.n ELSE excluded.n END, exp = CASE WHEN ${live} THEN ${e}.exp ELSE excluded.exp END, ca = CASE WHEN ${live} THEN ${e}.ca ELSE excluded.ca END, v = NULL, tg = NULL RETURNING n`;
  const clock = (db: Database, given: number | undefined): number =>
    given ?? db.query<{ now: number }, []>(nowMs).get()!.now;
  const valueAt = (db: Database, ns: string, key: string, at: number): number =>
    counterNumber(
      db.query<{ n: number }, [string, string, number]>(read).get(ns, key, at)
        ?.n,
    );
  return {
    window: async (ns, base, step) =>
      await target.write((db) => {
        const now = clock(db, step.now);
        const index = Math.floor(now / step.window);
        const key = `${base}:${index}`;
        const current =
          step.cost > 0
            ? db
                .query<{ n: number }, [string, string, number, number, number]>(
                  upsert,
                )
                .get(
                  ns,
                  key,
                  step.cost,
                  Math.ceil(
                    (index + (step.previous ? 2 : 1)) * step.window +
                      step.margin,
                  ),
                  now,
                )!.n
            : valueAt(db, ns, key, now);
        return {
          current,
          previous: step.previous
            ? valueAt(db, ns, `${base}:${index - 1}`, now)
            : 0,
          now,
        };
      }),
    deleteWindow: async (ns, base, window, now) => {
      await target.write((db) => {
        const index = Math.floor(clock(db, now) / window);
        db.query(
          `DELETE FROM ${e} WHERE ns = ?1 AND v IS NULL AND k IN (?2, ?3)`,
        ).run(ns, `${base}:${index}`, `${base}:${index - 1}`);
      });
    },
    gcra: async (ns, key, step) =>
      await target.write((db) => {
        const now =
          step.now === undefined
            ? clock(db, undefined) * 1000
            : Math.floor(step.now);
        const row = db
          .query<{ n: number }, [string, string]>(
            `SELECT n FROM ${e} WHERE ns = ?1 AND k = ?2 AND v IS NULL AND n IS NOT NULL`,
          )
          .get(ns, key);
        const tat = Math.max(row === null ? now : counterNumber(row.n), now);
        const next = tat + step.step;
        if (next - now > step.capacity) return { allowed: false, tat, now };
        if (step.step > 0) {
          db.query(
            `INSERT INTO ${e} (ns, k, v, n, exp, tg, ca) VALUES (?1, ?2, NULL, ?3, ?4, NULL, ?5) ON CONFLICT (ns, k) DO UPDATE SET n = excluded.n, exp = excluded.exp, ca = excluded.ca, v = NULL, tg = NULL`,
          ).run(
            ns,
            key,
            next,
            Math.ceil(next / 1000) + step.margin,
            Math.floor(now / 1000),
          );
          return { allowed: true, tat: next, now };
        }
        return { allowed: true, tat, now };
      }),
  };
}
