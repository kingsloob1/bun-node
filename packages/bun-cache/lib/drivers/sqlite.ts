/**
 * The SQLite driver (plan §7.3): one database file over `bun:sqlite`, shared
 * by every process on the host that opens the same file.
 *
 * **Tables** (`<p>` is the prefix, `bun_cache_` by default):
 *
 * ```sql
 * <p>entries (ns, k, v BLOB, n INTEGER, exp INTEGER, tg TEXT, ca INTEGER)  -- PRIMARY KEY (ns, k)
 * <p>tags    (ns, tag, k)                                                  -- the tag index
 * <p>stamps  (ns, tag, at INTEGER, exp INTEGER)                            -- invalidation stamps
 * <p>locks   (ns, k, owner TEXT, exp INTEGER)                              -- lock rows
 * <p>bus     (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, msg TEXT) -- the polled bus
 * ```
 *
 * An entry row holds `v` (the core's opaque bytes) and `n IS NULL`; a counter
 * row holds `n` and no `v` (§3.8). `tg` is the entry's tags as JSON, so a hit
 * is one row; the tag index answers `deleteByTags`.
 *
 * **One connection per file per process** (§7.3): `bun:sqlite` is fully
 * synchronous, so every driver on the same file in this process shares one
 * `Database` through a module-level registry, and nothing in this process
 * ever waits on itself for the write lock. Other processes are the only
 * contention: `busy_timeout` is a small 50 ms, and `SQLITE_BUSY` is retried
 * in JavaScript with jittered backoff. A busy handler sleeps in the calling
 * thread — the event loop — so a long one stalls every request in the
 * process (bun-jobs' measured lesson, `sql/dialect.ts`).
 *
 * **Atomicity.** Every write is one synchronous `BEGIN IMMEDIATE`
 * transaction: the fence check, the entry and its tag rows (`set`); the
 * index delete and the stamps (`deleteByTags`); a counter's `RETURNING`
 * upsert (`increment`). A lock is one conditional upsert whose `WHERE` *is*
 * the staleness judgment, evaluated under the database's write lock — there
 * is no read-then-break step for a herd to race (the file driver's herd bug,
 * plan Status), and no way for a break to overwrite a live lock.
 *
 * **Expiry.** Reads filter `exp > now` and never write; the core's sweeper
 * calls `sweep`, which deletes through the partial `exp` index.
 *
 * **Bus.** The `<p>bus` table, polled every `busPollInterval` and pruned by
 * age. A gap — rows pruned before a subscriber read them, or the table
 * reset — is signalled (§4.2).
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  BusMessage,
  CacheDriver,
  CacheDriverCapabilities,
  SchemaChange,
  SchemaSyncOptions,
  StoredEntry,
  TagFence,
} from "../core/types";

/** The default table prefix (§21). */
const DEFAULT_PREFIX = "bun_cache_";

/** The default bus poll interval (§4.2). */
const DEFAULT_BUS_POLL_INTERVAL_MS = 250;

/** How long bus rows are kept by default, in ms: a subscriber further behind than this sees a gap. */
const DEFAULT_BUS_RETENTION_MS = 60_000;

/** How long an operation keeps retrying `SQLITE_BUSY` before it throws, in ms. */
const BUSY_RETRY_MS = 10_000;

/** The most bus rows one poll delivers; the rest wait for the next tick. */
const BUS_BATCH = 1_000;

/** SQLite's own per-value limit (`SQLITE_MAX_LENGTH`, the compiled default). */
const SQLITE_MAX_LENGTH = 1_000_000_000;

/** `sqliteDriver()`'s options. Give `path` or `database`. */
export interface SqliteDriverOptions {
  /**
   * The database file; created, with its directory, on first use. Every
   * driver in this process on the same file (after `path.resolve`) shares
   * one connection. `":memory:"` gives a private in-process database, never
   * shared — and then `multiProcess` is `false`.
   */
  path?: string;
  /**
   * An existing `bun:sqlite` `Database` to use instead of opening `path`.
   * It is never closed by the driver, and the driver sets no pragma on it:
   * for several processes on one file, give it `journal_mode=WAL` yourself.
   */
  database?: Database;
  /** The table-name prefix, an SQL identifier. Defaults to `"bun_cache_"`. Two prefixes on one file are two separate stores. */
  prefix?: string;
  /** The bus table's poll interval, in ms. Defaults to 250 (§4.2). */
  busPollInterval?: number;
  /**
   * How long bus rows are kept, in ms; older ones are pruned on publish and
   * on sweep. A subscriber that falls further behind sees a gap (and its
   * cache flushes its L1). Defaults to 60,000.
   */
  busRetention?: number;
  /** The clock, epoch ms. Internal: for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** One connection in the registry. */
interface SharedConnection {
  /** The open database. */
  db: Database;
  /** How many open drivers use it; closed at zero. */
  refs: number;
}

/**
 * The module-level registry (§7.3): one connection per resolved file path
 * per process, shared by every driver on that file.
 */
const connections = new Map<string, SharedConnection>();

/** The prefixes whose tables were created on each connection, so DDL runs once per connection. */
const preparedSchemas = new WeakMap<Database, Set<string>>();

/** A valid SQL identifier prefix: letters, digits and underscores, not starting with a digit. */
const PREFIX_PATTERN = /^[A-Z_]\w*$/i;

/** Whether `error` is SQLite saying another connection holds the lock (`SQLITE_BUSY`, `SQLITE_LOCKED` and their extended codes). */
function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === "string" &&
    (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
  );
}

/** Opens a database file with the driver's pragmas (§7.3). */
function openDatabase(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  try {
    // The busy timeout goes first, so the journal-mode switch below waits out
    // another process's write instead of failing on it. Deliberately small:
    // see the module header.
    db.run("PRAGMA busy_timeout=50");
    db.run("PRAGMA journal_mode=WAL");
    // A cache does not need FULL, which is 9× slower to write [M §7.3].
    db.run("PRAGMA synchronous=NORMAL");
  } catch (error) {
    // A busy switch is retried by the caller with a fresh open: this one
    // must not leak.
    db.close();
    throw error;
  }
  return db;
}

/** The row `get` reads. */
interface EntryRow {
  /** The core's bytes. */
  v: Uint8Array | null;
  /** The hard expiry, epoch ms, or `null`. */
  exp: number | null;
  /** The tags, as a JSON array, or `null` when there are none. */
  tg: string | null;
}

/** The row `getCounter` reads. */
interface CounterRow {
  /** The counter's value. */
  n: number;
  /** The hard expiry, epoch ms, or `null`. */
  exp: number | null;
  /** When the counter was created, epoch ms. */
  ca: number;
}

/** The SQL statements, built once per driver for its prefix. */
interface Statements {
  /** The DDL, run once per connection and prefix. */
  schema: string[];
  /** Reads a live entry. */
  get: string;
  /** Upserts an entry, replacing a counter at the key. */
  upsertEntry: string;
  /** Deletes an entry or counter, answering its tags. */
  deleteEntry: string;
  /** Deletes a key's tag-index rows. */
  deleteTagRows: string;
  /** Adds a key's tag-index rows from a JSON array of tags. */
  insertTagRows: string;
  /** The fence: any live stamp of the tags at or after the load's start. */
  fenceHit: string;
  /** Deletes the namespace's entries carrying any of the tags. */
  deleteTagged: string;
  /** Deletes the tag-index rows of those entries. */
  deleteTaggedRows: string;
  /** Upserts stamps; never moves one backwards. */
  upsertStamps: string;
  /** Reads live stamps. */
  getStamps: string;
  /** Extends a live entry's or counter's expiry. */
  touch: string;
  /** Adds to a counter, creating it (with its expiry) when absent, expired or an entry. */
  increment: string;
  /** Reads a live counter. */
  getCounter: string;
  /** Takes a lock that is free, lapsed, or already this owner's. */
  acquireLock: string;
  /** Releases a lock held by the owner. */
  releaseLock: string;
  /** Deletes up to N expired entries and counters, answering their keys and tags. */
  sweepEntries: string;
  /** Deletes expired stamps. */
  sweepStamps: string;
  /** Deletes lapsed locks. */
  sweepLocks: string;
  /** Prunes bus rows older than the retention. */
  pruneBus: string;
  /** Appends a bus message. */
  publish: string;
  /** The highest bus `seq` ever assigned. */
  busHead: string;
  /** Bus rows after a `seq`, in order. */
  busRows: string;
  /** The namespace-scoped deletes `clear` runs. */
  clear: string[];
}

/** Builds a prefix's statements. The prefix is validated before this runs. */
function buildStatements(prefix: string): Statements {
  const entries = `"${prefix}entries"`;
  const tags = `"${prefix}tags"`;
  const stamps = `"${prefix}stamps"`;
  const locks = `"${prefix}locks"`;
  const bus = `"${prefix}bus"`;
  const tagged = `SELECT k FROM ${tags} WHERE ns = ?1 AND tag IN (SELECT value FROM json_each(?2))`;
  return {
    schema: [
      `CREATE TABLE IF NOT EXISTS ${entries} (ns TEXT NOT NULL, k TEXT NOT NULL, v BLOB, n INTEGER, exp INTEGER, tg TEXT, ca INTEGER, PRIMARY KEY (ns, k)) WITHOUT ROWID`,
      `CREATE INDEX IF NOT EXISTS "ix_${prefix}entries_exp" ON ${entries} (exp) WHERE exp IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS ${tags} (ns TEXT NOT NULL, tag TEXT NOT NULL, k TEXT NOT NULL, PRIMARY KEY (ns, tag, k)) WITHOUT ROWID`,
      `CREATE INDEX IF NOT EXISTS "ix_${prefix}tags_key" ON ${tags} (ns, k)`,
      `CREATE TABLE IF NOT EXISTS ${stamps} (ns TEXT NOT NULL, tag TEXT NOT NULL, at INTEGER NOT NULL, exp INTEGER NOT NULL, PRIMARY KEY (ns, tag)) WITHOUT ROWID`,
      `CREATE TABLE IF NOT EXISTS ${locks} (ns TEXT NOT NULL, k TEXT NOT NULL, owner TEXT NOT NULL, exp INTEGER NOT NULL, PRIMARY KEY (ns, k)) WITHOUT ROWID`,
      `CREATE TABLE IF NOT EXISTS ${bus} (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, msg TEXT NOT NULL)`,
    ],
    get: `SELECT v, exp, tg FROM ${entries} WHERE ns = ?1 AND k = ?2 AND n IS NULL AND (exp IS NULL OR exp > ?3)`,
    upsertEntry: `INSERT INTO ${entries} (ns, k, v, n, exp, tg, ca) VALUES (?1, ?2, ?3, NULL, ?4, ?5, NULL) ON CONFLICT (ns, k) DO UPDATE SET v = excluded.v, n = NULL, exp = excluded.exp, tg = excluded.tg, ca = NULL`,
    deleteEntry: `DELETE FROM ${entries} WHERE ns = ?1 AND k = ?2 RETURNING tg`,
    deleteTagRows: `DELETE FROM ${tags} WHERE ns = ?1 AND k = ?2`,
    insertTagRows: `INSERT OR IGNORE INTO ${tags} (ns, tag, k) SELECT ?1, value, ?2 FROM json_each(?3)`,
    fenceHit: `SELECT 1 AS hit FROM ${stamps} WHERE ns = ?1 AND tag IN (SELECT value FROM json_each(?2)) AND exp > ?3 AND at >= ?4 LIMIT 1`,
    deleteTagged: `DELETE FROM ${entries} WHERE ns = ?1 AND k IN (${tagged})`,
    // A non-correlated IN subquery is materialised before the delete runs,
    // so reading the table being deleted from is safe (measured in the test).
    deleteTaggedRows: `DELETE FROM ${tags} WHERE ns = ?1 AND k IN (${tagged})`,
    // `WHERE true` disambiguates the upsert after a SELECT (SQLite's parser rule).
    upsertStamps: `INSERT INTO ${stamps} (ns, tag, at, exp) SELECT ?1, value, ?2, ?3 FROM json_each(?4) WHERE true ON CONFLICT (ns, tag) DO UPDATE SET at = MAX(at, excluded.at), exp = MAX(exp, excluded.exp)`,
    getStamps: `SELECT tag, at FROM ${stamps} WHERE ns = ?1 AND tag IN (SELECT value FROM json_each(?2)) AND exp > ?3`,
    touch: `UPDATE ${entries} SET exp = ?3 WHERE ns = ?1 AND k = ?2 AND (exp IS NULL OR exp > ?4)`,
    // §3.8: one RETURNING upsert. Every SET expression reads the old row, so
    // `live` is judged once: a live counter adds and keeps its expiry and
    // creation time; anything else (absent, expired, an entry) restarts.
    increment: (() => {
      const live = `${entries}.n IS NOT NULL AND (${entries}.exp IS NULL OR ${entries}.exp > ?5)`;
      return `INSERT INTO ${entries} (ns, k, v, n, exp, tg, ca) VALUES (?1, ?2, NULL, ?3, ?4, NULL, ?5) ON CONFLICT (ns, k) DO UPDATE SET n = CASE WHEN ${live} THEN ${entries}.n + excluded.n ELSE excluded.n END, exp = CASE WHEN ${live} THEN ${entries}.exp ELSE excluded.exp END, ca = CASE WHEN ${live} THEN ${entries}.ca ELSE excluded.ca END, v = NULL, tg = NULL RETURNING n`;
    })(),
    getCounter: `SELECT n, exp, ca FROM ${entries} WHERE ns = ?1 AND k = ?2 AND n IS NOT NULL AND (exp IS NULL OR exp > ?3)`,
    // The judgment and the take in one statement, under the write lock: the
    // existing row is replaced only when it has lapsed (or is this owner's
    // own), and RETURNING answers a row only when this call holds the lock.
    acquireLock: `INSERT INTO ${locks} (ns, k, owner, exp) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (ns, k) DO UPDATE SET owner = excluded.owner, exp = excluded.exp WHERE ${locks}.exp <= ?5 OR ${locks}.owner = excluded.owner RETURNING owner`,
    releaseLock: `DELETE FROM ${locks} WHERE ns = ?1 AND k = ?2 AND owner = ?3`,
    sweepEntries: `DELETE FROM ${entries} WHERE (ns, k) IN (SELECT ns, k FROM ${entries} WHERE exp IS NOT NULL AND exp <= ?1 LIMIT ?2) RETURNING ns, k, tg`,
    sweepStamps: `DELETE FROM ${stamps} WHERE exp <= ?1`,
    sweepLocks: `DELETE FROM ${locks} WHERE exp <= ?1`,
    pruneBus: `DELETE FROM ${bus} WHERE at < ?1`,
    publish: `INSERT INTO ${bus} (at, msg) VALUES (?1, ?2)`,
    busHead: `SELECT seq FROM sqlite_sequence WHERE name = ?1`,
    busRows: `SELECT seq, msg FROM ${bus} WHERE seq > ?1 ORDER BY seq LIMIT ?2`,
    clear: [entries, tags, stamps, locks].map(
      (table) => `DELETE FROM ${table} WHERE ns = ?1`,
    ),
  };
}

/** The SQLite driver. See the module header. */
class SqliteDriver implements CacheDriver {
  /** `"sqlite"`. */
  readonly name = "sqlite";

  /** What SQLite can do atomically: everything in one transaction, with a tag index; the bus is polled. */
  readonly capabilities: CacheDriverCapabilities;

  /** The options, with defaults applied. */
  readonly #options: Required<
    Pick<SqliteDriverOptions, "busPollInterval" | "busRetention">
  > &
    SqliteDriverOptions;

  /** The table prefix. */
  readonly #prefix: string;

  /** The prefix's statements. */
  readonly #sql: Statements;

  /** The clock (the `now` option, or `Date.now`). */
  readonly #now: () => number;

  /** The registry key of a shared connection (a resolved file path); `undefined` for a given `database` or `:memory:`. */
  readonly #registryKey: string | undefined;

  /** The open database, once connected; cleared by `close()`. */
  #db: Database | undefined;

  /** Open bus pollers, stopped by `close()`. */
  readonly #pollers = new Set<ReturnType<typeof setInterval>>();

  /** When this driver last pruned the bus, epoch ms (pruning runs at most once a second per driver). */
  #lastPrune = 0;

  constructor(
    /** The options; `path` or `database` is required. */
    options: SqliteDriverOptions,
  ) {
    const { path, database } = options;
    if (database === undefined && (typeof path !== "string" || path === "")) {
      throw new TypeError(
        "sqliteDriver: a database file `path` (or an open `database`) is required",
      );
    }
    const prefix = options.prefix ?? DEFAULT_PREFIX;
    if (!PREFIX_PATTERN.test(prefix) || prefix.length > 48) {
      throw new TypeError(
        `sqliteDriver: prefix ${JSON.stringify(prefix)} must be an SQL identifier (letters, digits, underscores; at most 48 characters)`,
      );
    }
    this.#options = {
      busPollInterval: DEFAULT_BUS_POLL_INTERVAL_MS,
      busRetention: DEFAULT_BUS_RETENTION_MS,
      ...options,
    };
    this.#prefix = prefix;
    this.#sql = buildStatements(prefix);
    this.#now = options.now ?? Date.now;
    const file = database === undefined ? path! : database.filename;
    const inMemory = file === ":memory:" || file === "";
    this.#registryKey =
      database === undefined && !inMemory ? resolve(path!) : undefined;
    this.capabilities = {
      multiProcess: !inMemory,
      ttl: "sweep",
      atomicIncrement: true,
      lock: true,
      tags: "index",
      fence: "atomic",
      bus: "poll",
      maxEntryBytes: SQLITE_MAX_LENGTH,
    };
  }

  /* ---------------------------------------------------------------- */
  /* the connection                                                    */
  /* ---------------------------------------------------------------- */

  /** The database, opened (or taken from the registry) on first use, with this prefix's tables created. */
  #connection(): Database {
    let db = this.#db;
    if (db === undefined) {
      if (this.#options.database !== undefined) {
        db = this.#options.database;
      } else if (this.#registryKey === undefined) {
        db = openDatabase(":memory:");
      } else {
        let shared = connections.get(this.#registryKey);
        if (shared === undefined) {
          shared = { db: openDatabase(this.#registryKey), refs: 0 };
          connections.set(this.#registryKey, shared);
        }
        shared.refs++;
        db = shared.db;
      }
      this.#db = db;
    }
    let prepared = preparedSchemas.get(db);
    if (prepared === undefined) {
      prepared = new Set();
      preparedSchemas.set(db, prepared);
    }
    if (!prepared.has(this.#prefix)) {
      db.transaction(() => {
        for (const statement of this.#sql.schema) {
          db.run(statement);
        }
      }).immediate();
      prepared.add(this.#prefix);
    }
    return db;
  }

  /**
   * Runs one synchronous unit of work on the connection, retrying while
   * another process holds the write lock (`SQLITE_BUSY`), with jittered
   * backoff, for up to 10 s. The waiting is here, in JavaScript, not in
   * SQLite's busy handler, which would stall the event loop (§7.3).
   */
  async #run<T>(work: (db: Database) => T): Promise<T> {
    const deadline = Date.now() + BUSY_RETRY_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        return work(this.#connection());
      } catch (error) {
        if (!isBusy(error) || Date.now() >= deadline) {
          throw error;
        }
      }
      await Bun.sleep(Math.min(2 * 1.5 ** attempt, 50) * (0.5 + Math.random()));
    }
  }

  /** `#run` inside one `BEGIN IMMEDIATE` transaction: the write lock is taken up front, so nothing read inside can change before the commit. */
  async #write<T>(work: (db: Database) => T): Promise<T> {
    return await this.#run((db) => db.transaction(() => work(db)).immediate());
  }

  /** Opens the database and creates the tables; idempotent. */
  async connect(): Promise<void> {
    await this.#run(() => undefined);
  }

  /** Stops the bus pollers and lets go of the connection: the registry closes it when its last driver does; a given `database` is never closed. */
  close(): Promise<void> {
    for (const poller of this.#pollers) {
      clearInterval(poller);
    }
    this.#pollers.clear();
    const db = this.#db;
    this.#db = undefined;
    if (db === undefined || this.#options.database !== undefined) {
      return Promise.resolve();
    }
    if (this.#registryKey === undefined) {
      db.close();
      return Promise.resolve();
    }
    const shared = connections.get(this.#registryKey);
    if (shared !== undefined && shared.db === db && --shared.refs <= 0) {
      connections.delete(this.#registryKey);
      db.close();
    }
    return Promise.resolve();
  }

  /** A trivial query answers whether the file is usable. */
  async ping(): Promise<void> {
    await this.#run((db) => db.query("SELECT 1").get());
  }

  /* ---------------------------------------------------------------- */
  /* entries                                                           */
  /* ---------------------------------------------------------------- */

  /** Reads one entry with the connection in hand (shared by `get` and `getMany`). */
  #readEntry(
    db: Database,
    ns: string,
    key: string,
    now: number,
  ): StoredEntry | undefined {
    const row = db
      .query<EntryRow, [string, string, number]>(this.#sql.get)
      .get(ns, key, now);
    if (row === null) {
      return undefined;
    }
    return {
      key,
      value: row.v ?? new Uint8Array(0),
      expiresAt: row.exp,
      tags: row.tg === null ? [] : (JSON.parse(row.tg) as string[]),
    };
  }

  async get(ns: string, key: string): Promise<StoredEntry | undefined> {
    const now = this.#now();
    return await this.#run((db) => this.#readEntry(db, ns, key, now));
  }

  async getMany(
    ns: string,
    keys: readonly string[],
  ): Promise<(StoredEntry | undefined)[]> {
    const now = this.#now();
    return await this.#run((db) =>
      keys.map((key) => this.#readEntry(db, ns, key, now)),
    );
  }

  /** Writes one entry and its tag rows; the caller holds the transaction. */
  #writeEntry(db: Database, ns: string, entry: StoredEntry): void {
    db.query(this.#sql.upsertEntry).run(
      ns,
      entry.key,
      entry.value,
      entry.expiresAt,
      entry.tags.length === 0 ? null : JSON.stringify(entry.tags),
    );
    // Replacing: the old tags go, the new ones come.
    db.query(this.#sql.deleteTagRows).run(ns, entry.key);
    if (entry.tags.length > 0) {
      db.query(this.#sql.insertTagRows).run(
        ns,
        entry.key,
        JSON.stringify(entry.tags),
      );
    }
  }

  async set(
    ns: string,
    entry: StoredEntry,
    fence?: TagFence,
  ): Promise<"stored" | "fenced"> {
    const now = this.#now();
    return await this.#write((db) => {
      // The fence (§3.6), in the same transaction as the write: an
      // invalidation cannot land between the check and the upsert.
      if (fence !== undefined && fence.tags.length > 0) {
        const hit = db
          .query(this.#sql.fenceHit)
          .get(ns, JSON.stringify(fence.tags), now, fence.createdAt);
        if (hit !== null) {
          return "fenced" as const;
        }
      }
      this.#writeEntry(db, ns, entry);
      return "stored" as const;
    });
  }

  async setMany(ns: string, entries: readonly StoredEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    // One transaction for the batch: ~14× the single-statement rate [M §7.3].
    await this.#write((db) => {
      for (const entry of entries) {
        this.#writeEntry(db, ns, entry);
      }
    });
  }

  async delete(ns: string, keys: readonly string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }
    return await this.#write((db) => {
      let count = 0;
      for (const key of keys) {
        const removed = db
          .query<{ tg: string | null }, [string, string]>(this.#sql.deleteEntry)
          .get(ns, key);
        if (removed !== null) {
          count++;
          if (removed.tg !== null) {
            db.query(this.#sql.deleteTagRows).run(ns, key);
          }
        }
      }
      return count;
    });
  }

  async clear(ns: string): Promise<void> {
    await this.#write((db) => {
      for (const statement of this.#sql.clear) {
        db.query(statement).run(ns);
      }
    });
  }

  async touch(
    ns: string,
    key: string,
    expiresAt: number | null,
  ): Promise<boolean> {
    const now = this.#now();
    return await this.#write(
      (db) =>
        db.query(this.#sql.touch).run(ns, key, expiresAt, now).changes > 0,
    );
  }

  /* ---------------------------------------------------------------- */
  /* tags (index mode, §3.6)                                           */
  /* ---------------------------------------------------------------- */

  async deleteByTags(
    ns: string,
    tags: readonly string[],
    stampUntil: number,
  ): Promise<number> {
    if (tags.length === 0) {
      return 0;
    }
    const now = this.#now();
    const list = JSON.stringify(tags);
    return await this.#write((db) => {
      const { changes } = db.query(this.#sql.deleteTagged).run(ns, list);
      db.query(this.#sql.deleteTaggedRows).run(ns, list);
      // The stamps are the point even when nothing was deleted: a later write
      // whose load predates this invalidation must be fenced.
      db.query(this.#sql.upsertStamps).run(ns, now, stampUntil, list);
      return changes;
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
    const now = this.#now();
    const rows = await this.#run((db) =>
      db
        .query<{ tag: string; at: number }, [string, string, number]>(
          this.#sql.getStamps,
        )
        .all(ns, JSON.stringify(tags), now),
    );
    for (const row of rows) {
      out.set(row.tag, row.at);
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
    await this.#write((db) => {
      db.query(this.#sql.upsertStamps).run(ns, at, until, JSON.stringify(tags));
    });
  }

  /* ---------------------------------------------------------------- */
  /* counters (§3.8)                                                   */
  /* ---------------------------------------------------------------- */

  async increment(
    ns: string,
    key: string,
    by: number,
    expiresAt: number | null,
  ): Promise<number> {
    const now = this.#now();
    return await this.#write((db) => {
      // A counter and an entry never share a key: an entry's tag rows go
      // with it (a counter carries no tags, §3.8).
      db.query(this.#sql.deleteTagRows).run(ns, key);
      const row = db
        .query<{ n: number }, [string, string, number, number | null, number]>(
          this.#sql.increment,
        )
        .get(ns, key, by, expiresAt, now);
      return row!.n;
    });
  }

  async getCounter(
    ns: string,
    key: string,
  ): Promise<
    { value: number; expiresAt: number | null; createdAt: number } | undefined
  > {
    const now = this.#now();
    const row = await this.#run((db) =>
      db
        .query<CounterRow, [string, string, number]>(this.#sql.getCounter)
        .get(ns, key, now),
    );
    return row === null
      ? undefined
      : { value: row.n, expiresAt: row.exp, createdAt: row.ca };
  }

  /* ---------------------------------------------------------------- */
  /* locks (one conditional upsert)                                    */
  /* ---------------------------------------------------------------- */

  async acquireLock(
    ns: string,
    key: string,
    owner: string,
    ttlMs: number,
  ): Promise<boolean> {
    const now = this.#now();
    return await this.#write(
      (db) =>
        db
          .query(this.#sql.acquireLock)
          .get(ns, key, owner, now + ttlMs, now) !== null,
    );
  }

  async releaseLock(ns: string, key: string, owner: string): Promise<boolean> {
    return await this.#write(
      (db) => db.query(this.#sql.releaseLock).run(ns, key, owner).changes > 0,
    );
  }

  /* ---------------------------------------------------------------- */
  /* the sweeper                                                       */
  /* ---------------------------------------------------------------- */

  async sweep(now: number, limit: number): Promise<number> {
    return await this.#write((db) => {
      const removed = db
        .query<{ ns: string; k: string; tg: string | null }, [number, number]>(
          this.#sql.sweepEntries,
        )
        .all(now, limit);
      for (const row of removed) {
        if (row.tg !== null) {
          db.query(this.#sql.deleteTagRows).run(row.ns, row.k);
        }
      }
      db.query(this.#sql.sweepStamps).run(now);
      db.query(this.#sql.sweepLocks).run(now);
      db.query(this.#sql.pruneBus).run(now - this.#options.busRetention);
      return removed.length;
    });
  }

  /* ---------------------------------------------------------------- */
  /* the bus (a polled table, §4.2)                                    */
  /* ---------------------------------------------------------------- */

  async publish(message: BusMessage): Promise<void> {
    const now = this.#now();
    const prune = now - this.#lastPrune >= 1_000;
    if (prune) {
      this.#lastPrune = now;
    }
    await this.#write((db) => {
      db.query(this.#sql.publish).run(now, JSON.stringify(message));
      if (prune) {
        db.query(this.#sql.pruneBus).run(now - this.#options.busRetention);
      }
    });
  }

  async subscribe(
    onMessage: (message: BusMessage) => void,
    onGap: () => void,
  ): Promise<() => Promise<void>> {
    const busTable = `${this.#prefix}bus`;
    /** The highest `seq` ever assigned (`sqlite_sequence`), 0 before the first publish. */
    const head = (db: Database): number =>
      db.query<{ seq: number }, [string]>(this.#sql.busHead).get(busTable)
        ?.seq ?? 0;
    // Everything published from now on is new.
    let last = await this.#run(head);
    let polling = false;
    const poll = async (): Promise<void> => {
      // One snapshot: the head and the rows agree.
      const read = await this.#run((db) =>
        db.transaction(() => {
          const top = head(db);
          const rows =
            top > last
              ? db
                  .query<{ seq: number; msg: string }, [number, number]>(
                    this.#sql.busRows,
                  )
                  .all(last, BUS_BATCH)
              : [];
          return { top, rows };
        })(),
      );
      if (read.top === last) {
        return;
      }
      if (
        read.top < last ||
        read.rows.length === 0 ||
        read.rows[0].seq !== last + 1
      ) {
        // Rows were pruned before this subscriber read them, or the table
        // was reset: what was missed is unknowable. That is a gap (§4.2) —
        // signal it and resume from the head.
        last = read.top;
        onGap();
        return;
      }
      for (const row of read.rows) {
        last = row.seq;
        try {
          onMessage(JSON.parse(row.msg) as BusMessage);
        } catch {
          // A listener's throw, or a row another writer mangled: skip it.
        }
      }
    };
    const poller = setInterval(() => {
      if (polling) {
        return;
      }
      polling = true;
      void poll()
        .catch(() => undefined)
        .finally(() => {
          polling = false;
        });
    }, this.#options.busPollInterval);
    poller.unref?.();
    this.#pollers.add(poller);
    return () => {
      clearInterval(poller);
      this.#pollers.delete(poller);
      return Promise.resolve();
    };
  }

  /** The schema is new; there is nothing to sync (§7.4). The tables are created on first use. */
  syncSchema(_options?: SchemaSyncOptions): Promise<SchemaChange[]> {
    return Promise.resolve([]);
  }
}

/**
 * An SQLite driver (§7.3) over `bun:sqlite`: one connection per file per
 * process, WAL, a tag index with an atomic fence, lock rows and a polled bus
 * table. See {@link SqliteDriverOptions}.
 *
 * ```ts
 * const cache = createCache({ driver: sqliteDriver({ path: "./cache.db" }) });
 * ```
 */
export function sqliteDriver(options: SqliteDriverOptions): CacheDriver {
  return new SqliteDriver(options);
}
