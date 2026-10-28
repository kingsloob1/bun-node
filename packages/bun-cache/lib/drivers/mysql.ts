/**
 * The MySQL and MariaDB drivers (plan §7.5), over Bun's built-in `SQL`: the
 * Postgres driver's shape, with the differences bun-jobs' dialects already
 * handle.
 *
 * - **Keys are binary**: `VARCHAR(255)` in `utf8mb4_0900_bin` (MySQL) or
 *   `utf8mb4_nopad_bin` (MariaDB), so `"a"` and `"A"` stay different keys and
 *   a trailing space is significant. Longer names are hashed (see
 *   `MAX_SQL_NAME_LENGTH` in `sql-base.ts`).
 * - **Writes that touch the tag index run in a `REPEATABLE READ`
 *   transaction**: the entry upsert and the tag-row replacement commit
 *   together, so no reader (and no crash) leaves an entry without the rows
 *   that invalidate it.
 * - **The fence** (§3.6) is a locking read of the tags' stamps
 *   (`LOCK IN SHARE MODE`) at the start of that transaction. Under
 *   `REPEATABLE READ` it locks the stamp rows that exist and the gaps where
 *   missing ones would go, so a concurrent `deleteByTags` — whose first step
 *   upserts those stamps — waits for the write to commit and then deletes
 *   it; and a write that starts while an invalidation is in flight waits for
 *   its stamp and is refused. MariaDB's `innodb_snapshot_isolation` may
 *   answer the second case with error 1020 instead: the transaction is
 *   retried and then sees the stamp.
 * - **Counters**: `INSERT … ON DUPLICATE KEY UPDATE n = LAST_INSERT_ID(…)`,
 *   then `SELECT LAST_INSERT_ID()` on the same reserved connection (§3.8).
 *   `LAST_INSERT_ID` is unsigned, so the value goes through `^ 0` and comes
 *   back through `CAST(… AS SIGNED)`: a counter can go below zero.
 * - **Affected rows** are `affectedRows` on these engines (Postgres: `count`),
 *   and count rows *changed*, so a no-op update reads 0 (§7.5).
 * - **`allowPublicKeyRetrieval`** is taken out of the URL and passed as the
 *   client option Bun honours (`sql-connection.ts`).
 * - **The bus** is a polled `<p>bus` table (§4.2): rows carry an
 *   auto-increment `seq`. A subscriber reads past the last `seq` it saw; a
 *   hole in the sequence that outlives a grace period (an insert still
 *   committing closes within milliseconds) means rows were lost — pruned
 *   while it lagged, or never committed — and is signalled as a gap. The
 *   sweeper prunes rows older than `busRetention`.
 */
import type { ReservedSQL } from "bun";
import type {
  BusMessage,
  CacheDriver,
  CacheDriverCapabilities,
  StoredEntry,
  TagFence,
} from "../core/types";
import type { CounterRow, EntryRow, SqlCacheDriverOptions } from "./sql-base";
import { entryCapExcess, entryCapStatements } from "./entry-cap";
import type { EntryCapStatements } from "./entry-cap";
import {
  DEFAULT_SQL_BUS_POLL_INTERVAL_MS,
  DEFAULT_SQL_BUS_RETENTION_MS,
  SqlCacheDriverBase,
} from "./sql-base";
import { withLockRetry } from "./sql-connection";
import { sqlCacheIndexName } from "./sql-tables";

/** `mysqlDriver()`'s and `mariadbDriver()`'s options. */
export interface MysqlDriverOptions extends SqlCacheDriverOptions {
  /** How often a bus subscriber polls `<p>bus`, in ms. Defaults to 250 (§4.2). */
  busPollInterval?: number;
  /** How long a bus row is kept before the sweeper prunes it, in ms. Defaults to 60,000. A subscriber lagging past it sees a gap. */
  busRetention?: number;
}

/** The headroom kept below `max_allowed_packet` for the rest of a write's statement. */
const PACKET_HEADROOM_BYTES = 64 * 1024;

/** The `<p>locks` namespace of the row `maxEntries` sweeps take turns on: reserved-looking, like the core's own `__bun_cache__` sweep lock. A cache namespace of the same name would only share a lock row with it (its key would have to be `cap-sweep` too). */
const CAP_LOCK_NS = "__bun_cache_cap__";

/** The most bus rows one poll reads. */
const BUS_BATCH = 500;

/** The binary, `NO PAD` collation of each engine (bun-jobs' `idType`). */
const COLLATION = {
  mysql: "utf8mb4_0900_bin",
  mariadb: "utf8mb4_nopad_bin",
} as const;

/** `?, ?, ?` for `count` placeholders. */
function marks(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** The MySQL / MariaDB driver. See the module header. */
export class MysqlCacheDriver extends SqlCacheDriverBase {
  /** Everything atomic, with a polled bus (§7.10). `maxEntryBytes` is read from the server on connect. */
  readonly capabilities: CacheDriverCapabilities = {
    multiProcess: true,
    ttl: "sweep",
    atomicIncrement: true,
    lock: true,
    tags: "index",
    fence: "atomic",
    bus: "poll",
  };

  /** The bus poll interval, ms. */
  readonly #pollInterval: number;
  /** The bus retention, ms. */
  readonly #retention: number;
  /** The server's `auto_increment_increment`: the step between consecutive bus rows. */
  #seqStep = 1;
  /** The `maxEntries` sweep's statements (`entry-cap.ts`). */
  readonly #cap: EntryCapStatements;
  /** Open bus pollers, stopped by `close()`. */
  readonly #pollers = new Set<{ stop: () => void }>();

  constructor(
    /** `"mysql"` or `"mariadb"`. */ adapter: "mysql" | "mariadb",
    /** The options: a URL, connection fields or a client. */ options: MysqlDriverOptions,
  ) {
    super(adapter, options, `${adapter}Driver`);
    this.#pollInterval =
      options.busPollInterval ?? DEFAULT_SQL_BUS_POLL_INTERVAL_MS;
    this.#retention = options.busRetention ?? DEFAULT_SQL_BUS_RETENTION_MS;
    this.#cap = entryCapStatements(this.tables.entries, "?", " FOR UPDATE");
  }

  /** The tables, `IF NOT EXISTS`, with their `ix_…` indexes inline (MySQL has no `CREATE INDEX IF NOT EXISTS`). */
  protected ddl(): string[] {
    const t = this.tables;
    const name = `VARCHAR(255) CHARACTER SET utf8mb4 COLLATE ${COLLATION[this.name as "mysql" | "mariadb"]}`;
    const table = `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=${COLLATION[this.name as "mysql" | "mariadb"]}`;
    return [
      `CREATE TABLE IF NOT EXISTS ${t.entries} (ns ${name} NOT NULL, k ${name} NOT NULL, v LONGBLOB NULL, n BIGINT NULL, exp BIGINT NULL, ca BIGINT NOT NULL, tg LONGTEXT NULL, PRIMARY KEY (ns, k), KEY ${sqlCacheIndexName(t.entries, "exp")} (exp)) ${table}`,
      `CREATE TABLE IF NOT EXISTS ${t.tags} (ns ${name} NOT NULL, tag ${name} NOT NULL, k ${name} NOT NULL, PRIMARY KEY (ns, tag, k), KEY ${sqlCacheIndexName(t.tags, "key")} (ns, k)) ${table}`,
      `CREATE TABLE IF NOT EXISTS ${t.stamps} (ns ${name} NOT NULL, tag ${name} NOT NULL, at BIGINT NOT NULL, exp BIGINT NOT NULL, PRIMARY KEY (ns, tag)) ${table}`,
      `CREATE TABLE IF NOT EXISTS ${t.locks} (ns ${name} NOT NULL, k ${name} NOT NULL, owner ${name} NOT NULL, exp BIGINT NOT NULL, PRIMARY KEY (ns, k)) ${table}`,
      `CREATE TABLE IF NOT EXISTS ${t.bus} (seq BIGINT NOT NULL AUTO_INCREMENT, at BIGINT NOT NULL, msg LONGTEXT NOT NULL, PRIMARY KEY (seq), KEY ${sqlCacheIndexName(t.bus, "at")} (at)) ${table}`,
    ];
  }

  /** Reads the entry limit (`max_allowed_packet`) and the bus's sequence step from the server. */
  protected override async afterMigrate(): Promise<void> {
    const [row] = await this.sql.unsafe<
      { packet: string | number; step: string | number }[]
    >(
      "SELECT @@max_allowed_packet AS packet, @@auto_increment_increment AS step",
    );
    if (row !== undefined) {
      const packet = SqlCacheDriverBase.num(row.packet);
      this.capabilities.maxEntryBytes = Math.max(
        0,
        packet - PACKET_HEADROOM_BYTES,
      );
      this.#seqStep = Math.max(1, SqlCacheDriverBase.num(row.step));
    }
  }

  /** `affectedRows` of a write (§7.5): rows changed, not matched. */
  static #affected(result: unknown): number {
    const affected = (result as { affectedRows?: unknown } | null)
      ?.affectedRows;
    if (typeof affected !== "number" && typeof affected !== "bigint") {
      throw new TypeError(
        "the MySQL client reported no affectedRows for a write; Bun >= 1.4.2 is required",
      );
    }
    return Math.max(0, Number(affected));
  }

  /**
   * Runs `work` in a `REPEATABLE READ` transaction on a reserved connection,
   * retried on a deadlock or a snapshot conflict. The level is set per
   * transaction, not trusted from the server's default: the fence relies on
   * its gap locks. (Bun's `begin(options)` sends `START TRANSACTION
   * <options>`, which both engines reject with an isolation level, so the
   * statements are issued in order, as bun-jobs does.)
   */
  async #transaction<T>(work: (tx: ReservedSQL) => Promise<T>): Promise<T> {
    return await withLockRetry(async () => {
      const tx = await this.sql.reserve();
      try {
        await tx.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        await tx.unsafe("START TRANSACTION");
        try {
          const result = await work(tx);
          await tx.unsafe("COMMIT");
          return result;
        } catch (error) {
          await tx.unsafe("ROLLBACK").catch(() => undefined);
          throw error;
        }
      } finally {
        tx.release();
      }
    });
  }

  async get(ns: string, key: string): Promise<StoredEntry | undefined> {
    await this.ready();
    const rows = await this.sql.unsafe<EntryRow[]>(
      `SELECT k, v, exp, tg FROM ${this.tables.entries} WHERE ns = ? AND k = ? AND v IS NOT NULL AND (exp IS NULL OR exp > ?)`,
      [this.fit(ns), this.fit(key), this.now()],
    );
    const row = rows[0];
    return row === undefined ? undefined : SqlCacheDriverBase.toEntry(key, row);
  }

  async getMany(
    ns: string,
    keys: readonly string[],
  ): Promise<(StoredEntry | undefined)[]> {
    if (keys.length === 0) {
      return [];
    }
    await this.ready();
    const fitted = keys.map((key) => this.fit(key));
    const rows = await this.sql.unsafe<EntryRow[]>(
      `SELECT k, v, exp, tg FROM ${this.tables.entries} WHERE ns = ? AND k IN (${marks(fitted.length)}) AND v IS NOT NULL AND (exp IS NULL OR exp > ?)`,
      [this.fit(ns), ...fitted, this.now()],
    );
    const byKey = new Map(rows.map((row) => [row.k, row] as const));
    return keys.map((key, index) => {
      const row = byKey.get(fitted[index]);
      return row === undefined
        ? undefined
        : SqlCacheDriverBase.toEntry(key, row);
    });
  }

  async set(
    ns: string,
    entry: StoredEntry,
    fence?: TagFence,
  ): Promise<"stored" | "fenced"> {
    await this.ready();
    const t = this.tables;
    const fns = this.fit(ns);
    const fkey = this.fit(entry.key);
    const tags = [...this.fitTags(entry.tags).keys()];
    const fenceTags =
      fence !== undefined && fence.tags.length > 0
        ? [...this.fitTags(fence.tags).keys()].sort()
        : [];
    return await this.#transaction(async (tx) => {
      if (fence !== undefined && fenceTags.length > 0) {
        // The locking read is the fence: see the module header.
        const [hit] = await tx.unsafe<{ c: string | number }[]>(
          `SELECT COUNT(*) AS c FROM ${t.stamps} WHERE ns = ? AND tag IN (${marks(fenceTags.length)}) AND exp > ? AND at >= ? LOCK IN SHARE MODE`,
          [fns, ...fenceTags, this.now(), fence.createdAt],
        );
        if (hit !== undefined && SqlCacheDriverBase.num(hit.c) > 0) {
          return "fenced";
        }
      }
      await tx.unsafe(
        `INSERT INTO ${t.entries} (ns, k, v, n, exp, ca, tg) VALUES (?, ?, ?, NULL, ?, ?, ?)
         ON DUPLICATE KEY UPDATE v = VALUES(v), n = NULL, exp = VALUES(exp), ca = VALUES(ca), tg = VALUES(tg)`,
        [
          fns,
          fkey,
          entry.value,
          entry.expiresAt,
          this.now(),
          SqlCacheDriverBase.tagsColumn(entry.tags),
        ],
      );
      await tx.unsafe(
        tags.length === 0
          ? `DELETE FROM ${t.tags} WHERE ns = ? AND k = ?`
          : `DELETE FROM ${t.tags} WHERE ns = ? AND k = ? AND tag NOT IN (${marks(tags.length)})`,
        [fns, fkey, ...tags],
      );
      if (tags.length > 0) {
        await tx.unsafe(
          `INSERT INTO ${t.tags} (ns, tag, k) VALUES ${tags.map(() => "(?, ?, ?)").join(", ")} ON DUPLICATE KEY UPDATE k = k`,
          tags.flatMap((tag) => [fns, tag, fkey]),
        );
      }
      return "stored";
    });
  }

  async delete(ns: string, keys: readonly string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }
    await this.ready();
    const fns = this.fit(ns);
    const fitted = keys.map((key) => this.fit(key));
    // One transaction: neither a crash nor a concurrent tagged write can
    // leave an entry without its tag rows.
    return await this.#transaction(async (tx) => {
      await tx.unsafe(
        `DELETE FROM ${this.tables.tags} WHERE ns = ? AND k IN (${marks(fitted.length)})`,
        [fns, ...fitted],
      );
      return MysqlCacheDriver.#affected(
        await tx.unsafe(
          `DELETE FROM ${this.tables.entries} WHERE ns = ? AND k IN (${marks(fitted.length)})`,
          [fns, ...fitted],
        ),
      );
    });
  }

  async clear(ns: string): Promise<void> {
    await this.ready();
    const fns = this.fit(ns);
    await this.#transaction(async (tx) => {
      await tx.unsafe(`DELETE FROM ${this.tables.tags} WHERE ns = ?`, [fns]);
      await tx.unsafe(`DELETE FROM ${this.tables.entries} WHERE ns = ?`, [fns]);
    });
  }

  async touch(
    ns: string,
    key: string,
    expiresAt: number | null,
  ): Promise<boolean> {
    await this.ready();
    const params = [this.fit(ns), this.fit(key), this.now()];
    const changed = MysqlCacheDriver.#affected(
      await this.sql.unsafe(
        `UPDATE ${this.tables.entries} SET exp = ? WHERE ns = ? AND k = ? AND (exp IS NULL OR exp > ?)`,
        [expiresAt, ...params],
      ),
    );
    if (changed > 0) {
      return true;
    }
    // Rows changed, not matched: an expiry set to what it already was reads
    // 0, so a 0 asks whether the key is there.
    const rows = await this.sql.unsafe<unknown[]>(
      `SELECT 1 AS present FROM ${this.tables.entries} WHERE ns = ? AND k = ? AND (exp IS NULL OR exp > ?)`,
      params,
    );
    return rows.length > 0;
  }

  async deleteByTags(
    ns: string,
    tags: readonly string[],
    stampUntil: number,
  ): Promise<number> {
    if (tags.length === 0) {
      return 0;
    }
    await this.ready();
    const t = this.tables;
    const fns = this.fit(ns);
    // Sorted, so two invalidations of overlapping tags lock in one order.
    const fitted = [...this.fitTags(tags).keys()].sort();
    const at = this.now();
    return await this.#transaction(async (tx) => {
      // The stamps first: they wait for any fenced write holding the gap or
      // row locks, and refuse any that starts after (module header).
      await tx.unsafe(
        `INSERT INTO ${t.stamps} (ns, tag, at, exp) VALUES ${fitted.map(() => "(?, ?, ?, ?)").join(", ")}
         ON DUPLICATE KEY UPDATE at = VALUES(at), exp = VALUES(exp)`,
        fitted.flatMap((tag) => [fns, tag, at, stampUntil]),
      );
      const deleted = MysqlCacheDriver.#affected(
        await tx.unsafe(
          `DELETE e FROM ${t.entries} AS e JOIN ${t.tags} AS g ON e.ns = g.ns AND e.k = g.k
            WHERE g.ns = ? AND g.tag IN (${marks(fitted.length)}) AND e.v IS NOT NULL`,
          [fns, ...fitted],
        ),
      );
      // Every tag row of a key that no longer holds an entry: the deleted
      // ones' other tags, and a counter's leftovers.
      await tx.unsafe(
        `DELETE g FROM ${t.tags} AS g
           JOIN ${t.tags} AS x ON x.ns = g.ns AND x.k = g.k
           LEFT JOIN ${t.entries} AS e ON e.ns = g.ns AND e.k = g.k AND e.v IS NOT NULL
          WHERE x.ns = ? AND x.tag IN (${marks(fitted.length)}) AND e.k IS NULL`,
        [fns, ...fitted],
      );
      return deleted;
    });
  }

  async getStamps(
    ns: string,
    tags: readonly string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (tags.length === 0) {
      return out;
    }
    await this.ready();
    const fitted = this.fitTags(tags);
    const rows = await this.sql.unsafe<{ tag: string; at: string | number }[]>(
      `SELECT tag, at FROM ${this.tables.stamps} WHERE ns = ? AND tag IN (${marks(fitted.size)}) AND exp > ?`,
      [this.fit(ns), ...fitted.keys(), this.now()],
    );
    for (const row of rows) {
      const original = fitted.get(row.tag);
      if (original !== undefined) {
        out.set(original, SqlCacheDriverBase.num(row.at));
      }
    }
    return out;
  }

  async setStamps(
    ns: string,
    tags: readonly string[],
    at: number,
    until: number,
  ): Promise<void> {
    if (tags.length === 0) {
      return;
    }
    await this.ready();
    const fns = this.fit(ns);
    const fitted = [...this.fitTags(tags).keys()].sort();
    await withLockRetry(async () => {
      await this.sql.unsafe(
        `INSERT INTO ${this.tables.stamps} (ns, tag, at, exp) VALUES ${fitted.map(() => "(?, ?, ?, ?)").join(", ")}
         ON DUPLICATE KEY UPDATE at = VALUES(at), exp = VALUES(exp)`,
        fitted.flatMap((tag) => [fns, tag, at, until]),
      );
    });
  }

  async increment(
    ns: string,
    key: string,
    by: number,
    expiresAt: number | null,
  ): Promise<number> {
    SqlCacheDriverBase.checkStep(by);
    await this.ready();
    const now = this.now();
    // The assignments run left to right and each sees the columns already
    // assigned, so the ones that test the old row (`v`, `exp`) go last.
    // Reset (a new counter) when the key holds an entry or an expired
    // counter; otherwise add.
    const statement = `INSERT INTO ${this.tables.entries} (ns, k, v, n, exp, ca, tg)
      VALUES (?, ?, NULL, CAST(LAST_INSERT_ID(CAST(? AS SIGNED) ^ 0) AS SIGNED), ?, ?, NULL)
      ON DUPLICATE KEY UPDATE
        n = CAST(LAST_INSERT_ID(IF(v IS NOT NULL OR n IS NULL OR (exp IS NOT NULL AND exp <= ?), CAST(? AS SIGNED), n + ?) ^ 0) AS SIGNED),
        ca = IF(v IS NOT NULL OR (exp IS NOT NULL AND exp <= ?), ?, ca),
        exp = IF(v IS NOT NULL OR (exp IS NOT NULL AND exp <= ?), ?, exp),
        v = NULL,
        tg = NULL`;
    const params = [
      this.fit(ns),
      this.fit(key),
      by,
      expiresAt,
      now,
      now,
      by,
      by,
      now,
      now,
      now,
      expiresAt,
    ];
    return await withLockRetry(async () => {
      // `LAST_INSERT_ID()` is per connection: the read must follow the write
      // on the same one.
      const connection = await this.sql.reserve();
      try {
        await connection.unsafe(statement, params);
        const [row] = await connection.unsafe<{ n: string | number }[]>(
          "SELECT CAST(LAST_INSERT_ID() AS SIGNED) AS n",
        );
        return SqlCacheDriverBase.num(row.n);
      } finally {
        connection.release();
      }
    });
  }

  async getCounter(
    ns: string,
    key: string,
  ): Promise<
    { value: number; expiresAt: number | null; createdAt: number } | undefined
  > {
    await this.ready();
    const rows = await this.sql.unsafe<CounterRow[]>(
      `SELECT n, exp, ca FROM ${this.tables.entries} WHERE ns = ? AND k = ? AND v IS NULL AND n IS NOT NULL AND (exp IS NULL OR exp > ?)`,
      [this.fit(ns), this.fit(key), this.now()],
    );
    const row = rows[0];
    return row === undefined
      ? undefined
      : {
          value: SqlCacheDriverBase.num(row.n),
          expiresAt: SqlCacheDriverBase.numOrNull(row.exp),
          createdAt: SqlCacheDriverBase.num(row.ca),
        };
  }

  async acquireLock(
    ns: string,
    key: string,
    owner: string,
    ttlMs: number,
  ): Promise<boolean> {
    await this.ready();
    const now = this.now();
    const fns = this.fit(ns);
    const fkey = this.fit(key);
    const fowner = this.fit(owner);
    // Taken when absent, lapsed, or already ours. `owner` is assigned first,
    // so `exp`'s test sees whether this call now holds it.
    const changed = await withLockRetry(async () =>
      MysqlCacheDriver.#affected(
        await this.sql.unsafe(
          `INSERT INTO ${this.tables.locks} (ns, k, owner, exp) VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             owner = IF(exp <= ? OR owner = VALUES(owner), VALUES(owner), owner),
             exp = IF(owner = VALUES(owner), VALUES(exp), exp)`,
          [fns, fkey, fowner, now + ttlMs, now],
        ),
      ),
    );
    if (changed > 0) {
      return true;
    }
    // Unchanged: someone else holds it — or we re-took our own lock with the
    // same expiry in the same millisecond.
    const [row] = await this.sql.unsafe<{ owner: string }[]>(
      `SELECT owner FROM ${this.tables.locks} WHERE ns = ? AND k = ? AND exp > ?`,
      [fns, fkey, now],
    );
    return row?.owner === fowner;
  }

  async releaseLock(ns: string, key: string, owner: string): Promise<boolean> {
    await this.ready();
    return (
      MysqlCacheDriver.#affected(
        await this.sql.unsafe(
          `DELETE FROM ${this.tables.locks} WHERE ns = ? AND k = ? AND owner = ?`,
          [this.fit(ns), this.fit(key), this.fit(owner)],
        ),
      ) > 0
    );
  }

  async sweep(now: number, limit: number): Promise<number> {
    await this.ready();
    const t = this.tables;
    const expired = await this.sql.unsafe<{ ns: string; k: string }[]>(
      `SELECT ns, k FROM ${t.entries} WHERE exp IS NOT NULL AND exp <= ? ORDER BY exp LIMIT ?`,
      [now, limit],
    );
    let removed = 0;
    if (expired.length > 0) {
      const pairs = expired.map(() => "(?, ?)").join(", ");
      const keys = expired.flatMap((row) => [row.ns, row.k]);
      removed = await this.#transaction(async (tx) => {
        const count = MysqlCacheDriver.#affected(
          await tx.unsafe(
            `DELETE FROM ${t.entries} WHERE exp IS NOT NULL AND exp <= ? AND (ns, k) IN (${pairs})`,
            [now, ...keys],
          ),
        );
        // The swept keys' tag rows, unless the key was written again since.
        await tx.unsafe(
          `DELETE g FROM ${t.tags} AS g LEFT JOIN ${t.entries} AS e ON e.ns = g.ns AND e.k = g.k
            WHERE (g.ns, g.k) IN (${pairs}) AND e.k IS NULL`,
          keys,
        );
        return count;
      });
    }
    await this.sql.unsafe(`DELETE FROM ${t.stamps} WHERE exp <= ? LIMIT ?`, [
      now,
      limit,
    ]);
    await this.sql.unsafe(`DELETE FROM ${t.locks} WHERE exp <= ? LIMIT ?`, [
      now,
      limit,
    ]);
    await this.sql.unsafe(
      `DELETE FROM ${t.bus} WHERE at < ? ORDER BY seq LIMIT ?`,
      [now - this.#retention, limit],
    );
    // Reported only once the transaction committed: a rolled-back sweep
    // evicted nothing.
    this.reportEvictions(await this.#evictToCap(limit));
    return removed;
  }

  /**
   * The `maxEntries` cap (§3.9), in one transaction: evicts the excess, at
   * most `limit`, nearest to expiry first, then the entries with no expiry,
   * oldest write first — each with its tag rows — and answers the victims.
   * The pattern is `entry-cap.ts`'s. Two processes' sweeps take turns on one
   * row of `<p>locks` (an upsert holds its row lock to the commit); the count
   * is the transaction's first read, so its snapshot follows the other
   * sweep's commit and the same excess is never evicted twice.
   */
  async #evictToCap(limit: number): Promise<{ ns: string; k: string }[]> {
    const { maxEntries } = this;
    if (maxEntries === undefined) {
      return [];
    }
    const t = this.tables;
    return await this.#transaction(async (tx) => {
      await tx.unsafe(
        `INSERT INTO ${t.locks} (ns, k, owner, exp) VALUES (?, ?, ?, 0) ON DUPLICATE KEY UPDATE exp = exp`,
        [CAP_LOCK_NS, "cap-sweep", "cap-sweep"],
      );
      const [counted] = await tx.unsafe<{ c: string | number }[]>(
        this.#cap.count,
      );
      let excess = entryCapExcess(Number(counted?.c ?? 0), maxEntries, limit);
      const victims: { ns: string; k: string }[] = [];
      for (const phase of [this.#cap.withExpiry, this.#cap.withoutExpiry]) {
        if (excess === 0) {
          break;
        }
        const rows = await tx.unsafe<{ ns: string; k: string }[]>(phase, [
          excess,
        ]);
        if (rows.length > 0) {
          const pairs = rows.map(() => "(?, ?)").join(", ");
          const keys = rows.flatMap((row) => [row.ns, row.k]);
          await tx.unsafe(
            `DELETE FROM ${t.entries} WHERE (ns, k) IN (${pairs})`,
            keys,
          );
          await tx.unsafe(
            `DELETE FROM ${t.tags} WHERE (ns, k) IN (${pairs})`,
            keys,
          );
          victims.push(...rows.map((row) => ({ ns: row.ns, k: row.k })));
        }
        excess -= rows.length;
      }
      return victims;
    });
  }

  /* ---------------------------------------------------------------- */
  /* the bus: a polled table (§4.2)                                    */
  /* ---------------------------------------------------------------- */

  async publish(message: BusMessage): Promise<void> {
    await this.ready();
    await this.sql.unsafe(
      `INSERT INTO ${this.tables.bus} (at, msg) VALUES (?, ?)`,
      [this.now(), JSON.stringify(message)],
    );
  }

  async subscribe(
    onMessage: (message: BusMessage) => void,
    onGap: () => void,
  ): Promise<() => Promise<void>> {
    await this.ready();
    const bus = this.tables.bus;
    const [head] = await this.sql.unsafe<{ seq: string | number | null }[]>(
      `SELECT MAX(seq) AS seq FROM ${bus}`,
    );
    // `null` until the first row: an empty table says nothing about where the
    // sequence will resume, so the first row seen is accepted as is.
    let last: number | null = SqlCacheDriverBase.numOrNull(head?.seq ?? null);
    /** When the current hole was first seen, epoch ms. */
    let holeSince: number | undefined;
    // An insert still committing leaves a hole for milliseconds; one that
    // outlives this was pruned or rolled back.
    const grace = Math.max(1_000, 4 * this.#pollInterval);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async (): Promise<void> => {
      const rows = await this.sql.unsafe<
        { seq: string | number; msg: string }[]
      >(
        `SELECT seq, msg FROM ${bus} WHERE seq > ? ORDER BY seq LIMIT ${BUS_BATCH}`,
        [last ?? -1],
      );
      for (const row of rows) {
        if (stopped) {
          return;
        }
        const seq = SqlCacheDriverBase.num(row.seq);
        if (last !== null && seq !== last + this.#seqStep) {
          holeSince ??= Date.now();
          if (Date.now() - holeSince < grace) {
            // Hold here: the missing row may still commit.
            return;
          }
          // Lost for good: the subscriber cannot know what it missed.
          onGap();
        }
        holeSince = undefined;
        last = seq;
        try {
          onMessage(JSON.parse(row.msg) as BusMessage);
        } catch {
          // A row that is not a message: nothing to act on.
        }
      }
    };

    const loop = (): void => {
      if (stopped) {
        return;
      }
      timer = setTimeout(() => {
        // Never overlapping: the next poll is scheduled when this one ends.
        // A failed poll (a server restart) is retried; the rows are durable,
        // so nothing is lost unless they are pruned meanwhile — which the
        // hole check then reports.
        void poll()
          .catch(() => undefined)
          .finally(loop);
      }, this.#pollInterval);
      timer.unref?.();
    };
    loop();

    const handle = {
      stop: (): void => {
        stopped = true;
        clearTimeout(timer);
      },
    };
    this.#pollers.add(handle);
    return () => {
      handle.stop();
      this.#pollers.delete(handle);
      return Promise.resolve();
    };
  }

  protected stopBus(): Promise<void> {
    for (const poller of this.#pollers) {
      poller.stop();
    }
    this.#pollers.clear();
    return Promise.resolve();
  }
}

/** A MySQL driver (§7.5) over Bun's `SQL`. See {@link MysqlCacheDriver} and {@link MysqlDriverOptions}. */
export function mysqlDriver(options: MysqlDriverOptions): CacheDriver {
  return new MysqlCacheDriver("mysql", options);
}

/** A MariaDB driver (§7.5) over Bun's `SQL`. See {@link MysqlCacheDriver} and {@link MysqlDriverOptions}. */
export function mariadbDriver(options: MysqlDriverOptions): CacheDriver {
  return new MysqlCacheDriver("mariadb", options);
}
