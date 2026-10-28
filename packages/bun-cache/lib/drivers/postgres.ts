/**
 * The Postgres driver (plan §7.4), over Bun's built-in `SQL`.
 *
 * - **Writes** are one statement each: `set` upserts the entry and replaces
 *   its tag rows in one data-modifying CTE, so no reader sees an entry
 *   without the tag rows that invalidate it.
 * - **The fence** (§3.6) is the same statement, guarded by
 *   `NOT EXISTS (SELECT 1 FROM <p>stamps …)`, inside a transaction holding a
 *   **shared** advisory lock on the namespace; `deleteByTags` takes the same
 *   lock **exclusively** around its stamp write and its delete. So a fenced
 *   write either commits before the invalidation starts (and the delete,
 *   whose snapshot is taken after the lock, removes it) or starts after it
 *   commits (and its statement, whose snapshot is taken after the lock, sees
 *   the stamp). Without the lock, both statements' snapshots can predate the
 *   other's commit, and a loader that began before an invalidation writes
 *   its stale value back — the race the fence exists to stop.
 * - **Counters**: `INSERT … ON CONFLICT DO UPDATE … RETURNING n` (§3.8),
 *   measured exact under 200 concurrent callers.
 * - **Expiry**: lazy on read (an expired row is filtered out), plus the
 *   sweeper deleting `exp <= now` through the partial index, `ctid`-limited.
 * - **The bus**: `LISTEN`/`NOTIFY` on `bun_cache_<hash(prefix)>` (§4.2). A
 *   payload is capped below Postgres's 8,000 bytes: past it, the message
 *   becomes a `clear` of its namespace, which every subscriber can act on
 *   conservatively. Bun's listener reconnects on its own and re-runs
 *   `onlisten`; each re-run is reported as a gap, since notifications sent
 *   while it was down are lost.
 * - **`unlogged: true`** creates `UNLOGGED` tables: faster writes, emptied
 *   after a crash, and **not replicated to standbys**, so a failover starts
 *   cold. It applies when the tables are created; existing tables keep what
 *   they were created as.
 */
import { Buffer } from "node:buffer";
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
import { SqlCacheDriverBase } from "./sql-base";
import type { SqlCacheTable } from "./sql-tables";
import { sqlCacheIndexName, sqlCacheStoreKey } from "./sql-tables";
import { withLockRetry } from "./sql-connection";

/**
 * The largest `NOTIFY` payload sent as is, in bytes. Postgres refuses 8,000
 * and above ("payload string too long", measured for the plan); a message
 * past this becomes a `clear` of its namespace.
 */
const MAX_NOTIFY_PAYLOAD_BYTES = 7_900;

/** `postgresDriver()`'s options. */
export interface PostgresDriverOptions extends SqlCacheDriverOptions {
  /**
   * Exact table names (see {@link SqlCacheDriverOptions.tables}), without
   * `bus`: Postgres's bus is `LISTEN`/`NOTIFY`, so a `bus` name is refused.
   */
  tables?: Partial<Record<Exclude<SqlCacheTable, "bus">, string>>;
  /**
   * Create the tables `UNLOGGED`: faster writes, emptied after a crash, and
   * not replicated to standbys (a failover starts cold). Defaults to `false`.
   * Applies only when the tables are created.
   */
  unlogged?: boolean;
}

/** The Postgres driver. See the module header. */
export class PostgresCacheDriver extends SqlCacheDriverBase {
  /** Everything atomic, with a pushed bus (§7.10). */
  readonly capabilities: CacheDriverCapabilities = {
    multiProcess: true,
    ttl: "sweep",
    atomicIncrement: true,
    lock: true,
    tags: "index",
    fence: "atomic",
    bus: "push",
  };

  /** Whether the tables are created `UNLOGGED`. */
  readonly #unlogged: boolean;
  /**
   * The bus channel: `bun_cache_` + a hash of the store's table names
   * (`sqlCacheStoreKey`), so two drivers on the same tables share it and two
   * on different tables never do. Internal; read by the tests.
   */
  readonly channel: string;
  /** The `maxEntries` sweep's statements (`entry-cap.ts`). */
  readonly #cap: EntryCapStatements;
  /** Live `LISTEN` registrations, removed by `close()`. */
  readonly #subscriptions = new Set<{ unlisten: () => Promise<void> }>();

  constructor(
    /** The options: a URL, connection fields or a client. */ options: PostgresDriverOptions,
  ) {
    super("postgres", options, "postgresDriver", [
      "entries",
      "tags",
      "stamps",
      "locks",
    ]);
    this.#unlogged = options.unlogged ?? false;
    this.channel = `bun_cache_${Bun.hash(sqlCacheStoreKey(this.tables)).toString(36)}`;
    this.#cap = entryCapStatements(this.tables.entries, "$1", " FOR UPDATE");
  }

  /** The tables and indexes, `IF NOT EXISTS`, indexes named `ix_…`. */
  protected ddl(): string[] {
    const t = this.tables;
    const kind = this.#unlogged ? "UNLOGGED TABLE" : "TABLE";
    return [
      `CREATE ${kind} IF NOT EXISTS ${t.entries} (ns TEXT NOT NULL, k TEXT NOT NULL, v BYTEA, n BIGINT, exp BIGINT, ca BIGINT NOT NULL, tg TEXT, PRIMARY KEY (ns, k))`,
      `CREATE INDEX IF NOT EXISTS ${sqlCacheIndexName(t.entries, "exp")} ON ${t.entries} (exp) WHERE exp IS NOT NULL`,
      `CREATE ${kind} IF NOT EXISTS ${t.tags} (ns TEXT NOT NULL, tag TEXT NOT NULL, k TEXT NOT NULL, PRIMARY KEY (ns, tag, k))`,
      `CREATE INDEX IF NOT EXISTS ${sqlCacheIndexName(t.tags, "key")} ON ${t.tags} (ns, k)`,
      `CREATE ${kind} IF NOT EXISTS ${t.stamps} (ns TEXT NOT NULL, tag TEXT NOT NULL, at BIGINT NOT NULL, exp BIGINT NOT NULL, PRIMARY KEY (ns, tag))`,
      `CREATE ${kind} IF NOT EXISTS ${t.locks} (ns TEXT NOT NULL, k TEXT NOT NULL, owner TEXT NOT NULL, exp BIGINT NOT NULL, PRIMARY KEY (ns, k))`,
    ];
  }

  /** The advisory-lock key that serialises `maxEntries` sweeps over these tables. */
  #capLockKey(): string {
    return BigInt.asIntN(
      64,
      BigInt(Bun.hash(`${sqlCacheStoreKey(this.tables)}\u0000cap-sweep`)),
    ).toString();
  }

  /** The advisory-lock key of a namespace's tag fence: a signed 64-bit hash of the prefix and the namespace. */
  #fenceLockKey(ns: string): string {
    return BigInt.asIntN(
      64,
      BigInt(Bun.hash(`${sqlCacheStoreKey(this.tables)}\n${ns}`)),
    ).toString();
  }

  async get(ns: string, key: string): Promise<StoredEntry | undefined> {
    await this.ready();
    const rows = await this.sql.unsafe<EntryRow[]>(
      `SELECT k, v, exp, tg FROM ${this.tables.entries} WHERE ns = $1 AND k = $2 AND v IS NOT NULL AND (exp IS NULL OR exp > $3)`,
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
      `SELECT k, v, exp, tg FROM ${this.tables.entries} WHERE ns = $1 AND k = ANY($2::text[]) AND v IS NOT NULL AND (exp IS NULL OR exp > $3)`,
      [this.fit(ns), fitted, this.now()],
    );
    const byKey = new Map(rows.map((row) => [row.k, row] as const));
    return keys.map((key, index) => {
      const row = byKey.get(fitted[index]);
      return row === undefined
        ? undefined
        : SqlCacheDriverBase.toEntry(key, row);
    });
  }

  /**
   * The upsert-and-retag statement: guarded by the fence's `NOT EXISTS`, it
   * upserts the entry, drops the key's tag rows not in the new set and adds
   * the new ones, and answers `stored = 1`, or `0` when fenced.
   */
  #setStatement(): string {
    const t = this.tables;
    return `WITH ok AS (
        SELECT NOT EXISTS (
          SELECT 1 FROM ${t.stamps} WHERE ns = $1 AND tag = ANY($6::text[]) AND exp > $7::bigint AND at >= $8::bigint
        ) AS ok
      ), up AS (
        INSERT INTO ${t.entries} (ns, k, v, n, exp, ca, tg)
        SELECT $1::text, $2::text, $3::bytea, NULL::bigint, $4::bigint, $7::bigint, $5::text FROM ok WHERE ok.ok
        ON CONFLICT (ns, k) DO UPDATE SET v = excluded.v, n = NULL, exp = excluded.exp, ca = excluded.ca, tg = excluded.tg
        RETURNING 1
      ), dropped AS (
        DELETE FROM ${t.tags} WHERE ns = $1 AND k = $2 AND NOT (tag = ANY($9::text[])) AND EXISTS (SELECT 1 FROM up)
      ), added AS (
        INSERT INTO ${t.tags} (ns, tag, k)
        SELECT $1::text, tag, $2::text FROM unnest($9::text[]) AS tag WHERE EXISTS (SELECT 1 FROM up)
        ON CONFLICT DO NOTHING
      )
      SELECT (SELECT count(*) FROM up)::int AS stored`;
  }

  async set(
    ns: string,
    entry: StoredEntry,
    fence?: TagFence,
  ): Promise<"stored" | "fenced"> {
    await this.ready();
    const fencing = fence !== undefined && fence.tags.length > 0;
    const params = [
      this.fit(ns),
      this.fit(entry.key),
      entry.value,
      entry.expiresAt,
      SqlCacheDriverBase.tagsColumn(entry.tags),
      fencing ? [...this.fitTags(fence.tags).keys()] : [],
      this.now(),
      fencing ? fence.createdAt : 0,
      [...this.fitTags(entry.tags).keys()],
    ];
    const statement = this.#setStatement();
    const rows = await withLockRetry<{ stored: number }[]>(async () =>
      fencing
        ? await this.sql.begin(async (tx) => {
            await tx.unsafe("SELECT pg_advisory_xact_lock_shared($1::bigint)", [
              this.#fenceLockKey(ns),
            ]);
            return await tx.unsafe(statement, params);
          })
        : await this.sql.unsafe(statement, params),
    );
    return rows[0]?.stored === 1 ? "stored" : "fenced";
  }

  async delete(ns: string, keys: readonly string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }
    await this.ready();
    const t = this.tables;
    const rows = await this.sql.unsafe<{ n: number }[]>(
      `WITH gone AS (
          DELETE FROM ${t.entries} WHERE ns = $1 AND k = ANY($2::text[]) RETURNING k
        ), untagged AS (
          DELETE FROM ${t.tags} WHERE ns = $1 AND k = ANY($2::text[])
        )
        SELECT count(*)::int AS n FROM gone`,
      [this.fit(ns), keys.map((key) => this.fit(key))],
    );
    return rows[0]?.n ?? 0;
  }

  async clear(ns: string): Promise<void> {
    await this.ready();
    const t = this.tables;
    await this.sql.unsafe(
      `WITH e AS (DELETE FROM ${t.entries} WHERE ns = $1), x AS (DELETE FROM ${t.tags} WHERE ns = $1) SELECT 1`,
      [this.fit(ns)],
    );
  }

  async touch(
    ns: string,
    key: string,
    expiresAt: number | null,
  ): Promise<boolean> {
    await this.ready();
    const result = await this.sql.unsafe<{ count: number }>(
      `UPDATE ${this.tables.entries} SET exp = $3 WHERE ns = $1 AND k = $2 AND (exp IS NULL OR exp > $4)`,
      [this.fit(ns), this.fit(key), expiresAt, this.now()],
    );
    return result.count > 0;
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
    const fitted = [...this.fitTags(tags).keys()];
    const at = this.now();
    const rows = await withLockRetry<{ n: number }[]>(
      async () =>
        await this.sql.begin(async (tx) => {
          // Exclusive against every fenced write in the namespace (see the
          // module header): the stamp and the delete below are taken after
          // every write that checked the fence before us has committed.
          await tx.unsafe("SELECT pg_advisory_xact_lock($1::bigint)", [
            this.#fenceLockKey(ns),
          ]);
          await tx.unsafe(
            `INSERT INTO ${t.stamps} (ns, tag, at, exp)
             SELECT $1::text, tag, $3::bigint, $4::bigint FROM unnest($2::text[]) AS tag
             ON CONFLICT (ns, tag) DO UPDATE SET at = excluded.at, exp = excluded.exp`,
            [this.fit(ns), fitted, at, stampUntil],
          );
          return await tx.unsafe(
            `WITH gone AS (
                DELETE FROM ${t.entries} AS e USING ${t.tags} AS g
                 WHERE g.ns = $1 AND g.tag = ANY($2::text[]) AND e.ns = g.ns AND e.k = g.k AND e.v IS NOT NULL
                RETURNING e.k
              ), untagged AS (
                DELETE FROM ${t.tags} WHERE ns = $1 AND (tag = ANY($2::text[]) OR k IN (SELECT k FROM gone))
              )
              SELECT count(*)::int AS n FROM gone`,
            [this.fit(ns), fitted],
          );
        }),
    );
    return rows[0]?.n ?? 0;
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
      `SELECT tag, at FROM ${this.tables.stamps} WHERE ns = $1 AND tag = ANY($2::text[]) AND exp > $3`,
      [this.fit(ns), [...fitted.keys()], this.now()],
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
    await this.sql.unsafe(
      `INSERT INTO ${this.tables.stamps} (ns, tag, at, exp)
       SELECT $1::text, tag, $3::bigint, $4::bigint FROM unnest($2::text[]) AS tag
       ON CONFLICT (ns, tag) DO UPDATE SET at = excluded.at, exp = excluded.exp`,
      [this.fit(ns), [...this.fitTags(tags).keys()], at, until],
    );
  }

  async increment(
    ns: string,
    key: string,
    by: number,
    expiresAt: number | null,
  ): Promise<number> {
    SqlCacheDriverBase.checkStep(by);
    await this.ready();
    const e = this.tables.entries;
    // A new counter when there is none, when the key holds an entry (a
    // counter and an entry never share a key: the last writer wins), or when
    // the old counter expired; otherwise add. Every SET reads the old row, so
    // the reset test is the same in each.
    const reset = `(${e}.v IS NOT NULL OR ${e}.n IS NULL OR (${e}.exp IS NOT NULL AND ${e}.exp <= $5))`;
    const rows = await this.sql.unsafe<{ n: string | number }[]>(
      `INSERT INTO ${e} (ns, k, v, n, exp, ca, tg) VALUES ($1, $2, NULL, $3, $4, $5, NULL)
       ON CONFLICT (ns, k) DO UPDATE SET
         n = CASE WHEN ${reset} THEN excluded.n ELSE ${e}.n + excluded.n END,
         exp = CASE WHEN ${reset} THEN excluded.exp ELSE ${e}.exp END,
         ca = CASE WHEN ${reset} THEN excluded.ca ELSE ${e}.ca END,
         v = NULL, tg = NULL
       RETURNING n`,
      [this.fit(ns), this.fit(key), by, expiresAt, this.now()],
    );
    return SqlCacheDriverBase.num(rows[0].n);
  }

  async getCounter(
    ns: string,
    key: string,
  ): Promise<
    { value: number; expiresAt: number | null; createdAt: number } | undefined
  > {
    await this.ready();
    const rows = await this.sql.unsafe<CounterRow[]>(
      `SELECT n, exp, ca FROM ${this.tables.entries} WHERE ns = $1 AND k = $2 AND n IS NOT NULL AND v IS NULL AND (exp IS NULL OR exp > $3)`,
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
    const l = this.tables.locks;
    // Taken when absent, lapsed, or already ours (a re-acquire refreshes it).
    const rows = await this.sql.unsafe<{ owner: string }[]>(
      `INSERT INTO ${l} (ns, k, owner, exp) VALUES ($1, $2, $3, $4)
       ON CONFLICT (ns, k) DO UPDATE SET owner = excluded.owner, exp = excluded.exp
         WHERE ${l}.exp <= $5 OR ${l}.owner = excluded.owner
       RETURNING owner`,
      [this.fit(ns), this.fit(key), this.fit(owner), now + ttlMs, now],
    );
    return rows.length > 0;
  }

  async releaseLock(ns: string, key: string, owner: string): Promise<boolean> {
    await this.ready();
    const result = await this.sql.unsafe<{ count: number }>(
      `DELETE FROM ${this.tables.locks} WHERE ns = $1 AND k = $2 AND owner = $3`,
      [this.fit(ns), this.fit(key), this.fit(owner)],
    );
    return result.count > 0;
  }

  async sweep(now: number, limit: number): Promise<number> {
    await this.ready();
    const t = this.tables;
    const rows = await this.sql.unsafe<{ n: number }[]>(
      `WITH gone AS (
          DELETE FROM ${t.entries} WHERE ctid IN (
            SELECT ctid FROM ${t.entries} WHERE exp IS NOT NULL AND exp <= $1 LIMIT $2
          ) RETURNING ns, k
        ), untagged AS (
          DELETE FROM ${t.tags} AS g USING gone WHERE g.ns = gone.ns AND g.k = gone.k
        )
        SELECT count(*)::int AS n FROM gone`,
      [now, limit],
    );
    await this.sql.unsafe(
      `DELETE FROM ${t.stamps} WHERE ctid IN (SELECT ctid FROM ${t.stamps} WHERE exp <= $1 LIMIT $2)`,
      [now, limit],
    );
    await this.sql.unsafe(
      `DELETE FROM ${t.locks} WHERE ctid IN (SELECT ctid FROM ${t.locks} WHERE exp <= $1 LIMIT $2)`,
      [now, limit],
    );
    // Reported only once the transaction committed: a rolled-back sweep
    // evicted nothing.
    this.reportEvictions(await this.#evictToCap(limit));
    return rows[0]?.n ?? 0;
  }

  /**
   * The `maxEntries` cap (§3.9), in one transaction: evicts the excess, at
   * most `limit`, nearest to expiry first, then the entries with no expiry,
   * oldest write first — each with its tag rows — and answers the victims.
   * The pattern is `entry-cap.ts`'s; an exclusive advisory lock makes two
   * processes' sweeps take turns, so the second counts after the first
   * committed and never evicts the same excess twice.
   */
  async #evictToCap(limit: number): Promise<{ ns: string; k: string }[]> {
    const { maxEntries } = this;
    if (maxEntries === undefined) {
      return [];
    }
    const t = this.tables;
    return await withLockRetry(
      async () =>
        await this.sql.begin(async (tx) => {
          await tx.unsafe("SELECT pg_advisory_xact_lock($1::bigint)", [
            this.#capLockKey(),
          ]);
          const [counted] = await tx.unsafe<{ c: string | number }[]>(
            this.#cap.count,
          );
          let excess = entryCapExcess(
            Number(counted?.c ?? 0),
            maxEntries,
            limit,
          );
          const victims: { ns: string; k: string }[] = [];
          for (const phase of [this.#cap.withExpiry, this.#cap.withoutExpiry]) {
            if (excess === 0) {
              break;
            }
            const rows = await tx.unsafe<{ ns: string; k: string }[]>(phase, [
              excess,
            ]);
            if (rows.length > 0) {
              const keys = [
                rows.map((row) => row.ns),
                rows.map((row) => row.k),
              ];
              await tx.unsafe(
                `DELETE FROM ${t.entries} WHERE (ns, k) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
                keys,
              );
              await tx.unsafe(
                `DELETE FROM ${t.tags} WHERE (ns, k) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
                keys,
              );
              victims.push(...rows.map((row) => ({ ns: row.ns, k: row.k })));
            }
            excess -= rows.length;
          }
          return victims;
        }),
    );
  }

  /* ---------------------------------------------------------------- */
  /* the bus: LISTEN/NOTIFY (§4.2)                                     */
  /* ---------------------------------------------------------------- */

  async publish(message: BusMessage): Promise<void> {
    let payload = JSON.stringify(message);
    if (Buffer.byteLength(payload) > MAX_NOTIFY_PAYLOAD_BYTES) {
      // Too many keys for one notification: every subscriber drops the whole
      // namespace instead, which is always a safe reading of "these changed".
      const flush: BusMessage = {
        type: "clear",
        namespace: message.namespace,
        at: message.at,
      };
      payload = JSON.stringify(flush);
    }
    await this.sql.notify(this.channel, payload);
  }

  async subscribe(
    onMessage: (message: BusMessage) => void,
    onGap: () => void,
  ): Promise<() => Promise<void>> {
    let listening = false;
    const subscription = await this.sql.listen(
      this.channel,
      (payload) => {
        let message: BusMessage;
        try {
          message = JSON.parse(payload) as BusMessage;
        } catch {
          // Not ours (another client NOTIFYing the channel): nothing to act on.
          return;
        }
        onMessage(message);
      },
      () => {
        // Runs once the LISTEN is acknowledged, and again after every
        // reconnect: anything notified while it was down is lost — a gap.
        if (listening) {
          onGap();
        }
        listening = true;
      },
    );
    this.#subscriptions.add(subscription);
    return async () => {
      if (this.#subscriptions.delete(subscription)) {
        await subscription.unlisten();
      }
    };
  }

  protected async stopBus(): Promise<void> {
    const subscriptions = [...this.#subscriptions];
    this.#subscriptions.clear();
    for (const subscription of subscriptions) {
      await subscription.unlisten().catch(() => undefined);
    }
  }
}

/** A Postgres driver (§7.4) over Bun's `SQL`. See {@link PostgresCacheDriver} and {@link PostgresDriverOptions}. */
export function postgresDriver(options: PostgresDriverOptions): CacheDriver {
  return new PostgresCacheDriver(options);
}
