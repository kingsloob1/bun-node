/**
 * What the SQL drivers (plan §7.4, §7.5) share: options, table names, the
 * lazy schema creation, identifier fitting, the owned-client rule and the row
 * decoding. The statements live in `postgres.ts` and `mysql.ts`.
 *
 * **Tables** (the default prefix is `bun_cache_`; the `tables` option names
 * any of them outright, `sql-tables.ts`):
 *
 * ```
 * <p>entries (ns, k, v bytes, n bigint, exp bigint, ca bigint, tg text)      PK (ns, k)
 * <p>tags    (ns, tag, k)                                                    PK (ns, tag, k), ix (ns, k)
 * <p>stamps  (ns, tag, at, exp)                                       PK (ns, tag)
 * <p>locks   (ns, k, owner, exp)                                             PK (ns, k)
 * <p>bus     (seq auto-increment, at, msg)        MySQL and MariaDB only: Postgres uses LISTEN/NOTIFY
 * ```
 *
 * An entry carries its value in `v`; a counter (§3.8) carries its value in
 * `n` with `v` null, so the backend adds atomically and `get` never mistakes
 * one for the other. `tg` holds the entry's tags as written (JSON), so a read
 * is one row; `<p>tags` is the index `deleteByTags` deletes through. `ca`
 * is the row's write time (an entry's last `set`, a counter's creation) —
 * the same column, meaning the same thing, as the SQLite driver's, so the
 * `maxEntries` sweep (`entry-cap.ts`) orders both alike.
 */
import type { SQL } from "bun";
import type {
  BusMessage,
  CacheDriver,
  CacheDriverCapabilities,
  SchemaChange,
  SchemaSyncOptions,
  StoredEntry,
  TagFence,
} from "../core/types";
import type { ConnectionInput, SqlCacheAdapter } from "./sql-connection";
import { isPublicKeyRetrievalRefusal, openSqlClient } from "./sql-connection";
import type { SqlCacheTable } from "./sql-tables";
import { resolveSqlCacheTables, SQL_CACHE_TABLES } from "./sql-tables";

/** The default table prefix (§7, §21). */
export const DEFAULT_SQL_PREFIX = "bun_cache_";

/** The default bus poll interval on MySQL and MariaDB (§4.2). */
export const DEFAULT_SQL_BUS_POLL_INTERVAL_MS = 250;

/** The default bus-log retention on MySQL and MariaDB: rows older than this are pruned by the sweeper. */
export const DEFAULT_SQL_BUS_RETENTION_MS = 60_000;

/**
 * The longest name (namespace, key, tag, lock owner) stored as written; a
 * longer one is stored as `#` + its SHA-256 (hex). MySQL's and MariaDB's
 * `VARCHAR(255)` columns are the bound (three of them make the tag index's
 * primary key, 3,060 of InnoDB's 3,072 bytes); Postgres's `TEXT` has none,
 * but its B-tree entries do, and one rule for all three keeps a namespace
 * portable. The core hashes keys past `maxKeyLength` (200 bytes) already, so
 * this only fires for a raised `maxKeyLength`, a long namespace or a long tag.
 */
export const MAX_SQL_NAME_LENGTH = 255;

/** The options every SQL driver takes. */
export interface SqlCacheDriverOptions extends ConnectionInput {
  /**
   * An already-open `Bun.SQL` to use instead of building one. The driver
   * never closes a client it was given (§6.1); `url`/`connection` are then
   * ignored.
   */
  sql?: SQL;
  /**
   * Prepended to every table name. Defaults to `bun_cache_`. Letters, digits
   * and `_`, at most 48 characters (so `ix_<prefix>entries_exp` stays within
   * Postgres's 63-byte identifiers); anything else throws.
   */
  prefix?: string;
  /**
   * Exact table names, for an existing schema that was not named here (as
   * bun-jobs' SQL driver takes them): `{ entries: "app_cache" }`. Given
   * as-is, so a name set this way ignores `prefix`; the tables not named keep
   * `<prefix><table>`. Each must be an SQL identifier of at most 63
   * characters, and no two tables may share a name; anything else throws.
   * `bus` exists on MySQL and MariaDB only — Postgres's bus is
   * `LISTEN`/`NOTIFY`, and `postgresDriver` refuses a `bus` name. Index names
   * are derived from the table names (`ix_<table>_…`, shortened with a hash
   * past 63 characters).
   */
  tables?: Partial<Record<SqlCacheTable, string>>;
  /**
   * Run {@link CacheDriver.syncSchema} on connect, after the tables are
   * created: `true` with the default options, or the options to pass. Off by
   * default. **A no-op until the schema first changes**: there is one schema
   * version today, so a sync finds nothing to do — set it now so later
   * migrations run on connect. As in bun-jobs, its report is not returned by
   * `connect()`; call `syncSchema({ dryRun: true })` to read one.
   */
  syncSchema?: boolean | SchemaSyncOptions;
  /** The most connections the pool of a client the driver builds holds. Bun's default (10) when absent. */
  max?: number;
  /**
   * At most this many entries across every namespace in the tables (§3.9).
   * No cap by default: the database is sized by its operator. Enforced by
   * `sweep`, in one transaction after the expired delete — so between sweeps
   * the table can briefly exceed it — and at most the sweep's `limit`
   * evictions per pass. The victims are the entries **nearest to expiry
   * first**, then those with no expiry, oldest write first; each goes with
   * its tag rows and is reported as an `evict` event (reason `"cap"`).
   * Counters are not entries and are never evicted (one would silently reset
   * a rate-limit window, §3.8). Two processes sweeping at once take turns, so
   * the cap is never overshot. A positive integer.
   */
  maxEntries?: number;
  /** The clock, epoch ms. Internal: for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Whether `error` says a table or type was created concurrently by another connection (Postgres's `CREATE … IF NOT EXISTS` race). */
function isConcurrentCreate(error: unknown): boolean {
  for (let at = error, depth = 0; at != null && depth < 5; depth++) {
    if (typeof at !== "object") {
      break;
    }
    const { code, errno } = at as { code?: unknown; errno?: unknown };
    // 23505: pg_type's unique index; 42P07: duplicate table; 42710: duplicate object.
    if (
      ["23505", "42P07", "42710"].includes(String(code)) ||
      ["23505", "42P07", "42710"].includes(String(errno))
    ) {
      return true;
    }
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

/** Hashes a name for its fitted form. */
function sha256(name: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(name);
  return hasher.digest("hex");
}

/** A row read back from `<p>entries`. */
export interface EntryRow {
  /** The stored (fitted) key. */
  k: string;
  /** The value bytes; `null` on a counter row. */
  v: Uint8Array | null;
  /** The hard expiry, epoch ms; `null` never expires. Bun reads a `BIGINT` back as a string or a number. */
  exp: string | number | null;
  /** The tags as written, JSON; `null` for none. */
  tg: string | null;
}

/** A row read back as a counter. */
export interface CounterRow {
  /** The counter's value. */
  n: string | number;
  /** The hard expiry, epoch ms; `null` never expires. */
  exp: string | number | null;
  /** When the counter was created, epoch ms (`ca`). */
  ca: string | number;
}

/**
 * The SQL drivers' shared half. Subclasses supply the dialect's DDL and
 * statements; this class owns the client, the lazy migration and the rules
 * every dialect keeps the same.
 */
export abstract class SqlCacheDriverBase implements CacheDriver {
  /** The backend's name: `"postgres"`, `"mysql"` or `"mariadb"`. */
  readonly name: SqlCacheAdapter;
  /** What the backend can do atomically; the dialect fills it in. */
  abstract readonly capabilities: CacheDriverCapabilities;

  /** The client every statement runs on. */
  protected readonly sql: SQL;
  /** The resolved table names. */
  protected readonly tables: Record<SqlCacheTable, string>;
  /** The table prefix, as resolved. */
  protected readonly prefix: string;
  /** The clock. */
  protected readonly now: () => number;

  /** The `maxEntries` cap, when there is one. */
  protected readonly maxEntries: number | undefined;

  /** The `onEviction` listeners, told of each `maxEntries` eviction after its sweep commits. */
  readonly #evictListeners: ((
    ns: string,
    key: string,
    reason: string,
  ) => void)[] = [];

  /** Whether the client is the driver's own, so `close()` closes it. */
  readonly #ownsClient: boolean;
  /** The migration in flight or done; reset when it fails. */
  #ready: Promise<void> | undefined;
  /** Set once `close()` ran. */
  #closed = false;
  /** The `syncSchema` option: what to sync on connect, or `false`. */
  readonly #syncOnConnect: boolean | SchemaSyncOptions;

  constructor(
    /** The engine. */ adapter: SqlCacheAdapter,
    /** The driver's options. */ options: SqlCacheDriverOptions,
    /** The factory's name, for error messages. */ what: string,
    /** The tables this dialect has (Postgres: no `bus`). */ allowedTables: readonly SqlCacheTable[] = SQL_CACHE_TABLES,
  ) {
    this.name = adapter;
    const prefix = options.prefix ?? DEFAULT_SQL_PREFIX;
    if (!/^[a-z_]\w{0,47}$/i.test(prefix)) {
      throw new TypeError(
        `${what}: prefix must be letters, digits and _, starting with a letter or _, at most 48 characters; got ${JSON.stringify(prefix)}`,
      );
    }
    this.prefix = prefix;
    const { maxEntries } = options;
    if (
      maxEntries !== undefined &&
      !(Number.isSafeInteger(maxEntries) && maxEntries > 0)
    ) {
      throw new TypeError(
        `${what}: maxEntries must be a positive integer, got ${String(maxEntries)}`,
      );
    }
    this.maxEntries = maxEntries;
    this.tables = resolveSqlCacheTables(
      what,
      prefix,
      options.tables,
      allowedTables,
    );
    this.#syncOnConnect = options.syncSchema ?? false;
    this.now = options.now ?? Date.now;
    this.#ownsClient = options.sql === undefined;
    this.sql =
      options.sql ?? openSqlClient(adapter, options, what, options.max);
  }

  /** The dialect's `CREATE … IF NOT EXISTS` statements, in order. */
  protected abstract ddl(): string[];

  /** Runs after the tables exist: reads server limits, for instance. */
  protected async afterMigrate(): Promise<void> {}

  /** Stops the dialect's bus (pollers, listeners). */
  protected abstract stopBus(): Promise<void>;

  /** Creates the tables, once per instance; a failure is not remembered. */
  async connect(): Promise<void> {
    this.#ready ??= this.#migrate();
    try {
      await this.#ready;
    } catch (error) {
      this.#ready = undefined;
      throw error;
    }
  }

  /** Awaits the schema before a statement: drivers connect lazily on first use. */
  protected async ready(): Promise<void> {
    if (this.#closed) {
      throw new Error(`the ${this.name} cache driver is closed`);
    }
    await this.connect();
  }

  async #migrate(): Promise<void> {
    try {
      for (const statement of this.ddl()) {
        // Two processes creating the same table at once can collide on
        // Postgres's catalog (`CREATE TABLE IF NOT EXISTS` is not atomic
        // there); the loser retries, and then finds the table.
        for (let attempt = 1; ; attempt++) {
          try {
            await this.sql.unsafe(statement);
            break;
          } catch (error) {
            if (attempt >= 3 || !isConcurrentCreate(error)) {
              throw error;
            }
            await Bun.sleep(20 * attempt);
          }
        }
      }
      await this.afterMigrate();
      // After the tables exist, not instead of creating them: a sync
      // compares against what is there (bun-jobs' order).
      if (this.#syncOnConnect !== false) {
        await this.migrateSchema(
          this.#syncOnConnect === true ? {} : this.#syncOnConnect,
        );
      }
    } catch (error) {
      // The client's own wording names a client option the caller never sees
      // and says nothing of the URL, so the driver says what to change (as
      // bun-jobs' SQL driver does).
      if (isPublicKeyRetrievalRefusal(error)) {
        throw new Error(
          `${this.name === "mariadb" ? "MariaDB" : "MySQL"} asked for its RSA public key to authenticate over a connection without TLS, which is refused by default. Either connect over TLS (add ?ssl=true to the URL, or tls: true to the connection), or allow the key to be fetched: add ?allowPublicKeyRetrieval=true to the URL, or allowPublicKeyRetrieval: true to the connection. Only do the latter on a trusted network, since the key is not authenticated.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  /** Closes the client when it is the driver's own, after stopping the bus. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.stopBus();
    if (this.#ownsClient) {
      await this.sql.close();
    }
  }

  /** One round trip. */
  async ping(): Promise<void> {
    await this.sql.unsafe("SELECT 1");
  }

  /** Creates the tables if they are missing, then syncs them: `[]` until the schema first changes (§7.4, §8.3). */
  async syncSchema(options: SchemaSyncOptions = {}): Promise<SchemaChange[]> {
    await this.ready();
    return await this.migrateSchema(options);
  }

  /**
   * The sync itself, without connecting first (connect runs it, under the
   * `syncSchema` option, and must not wait on itself). Internal. There is
   * one schema version, so there is nothing to change: `[]`.
   */
  protected migrateSchema(
    _options: SchemaSyncOptions,
  ): Promise<SchemaChange[]> {
    return Promise.resolve([]);
  }

  /** Registers a listener for `maxEntries` evictions (reason `"cap"`); the core turns them into `evict` events. */
  onEviction(
    listener: (ns: string, key: string, reason: string) => void,
  ): void {
    this.#evictListeners.push(listener);
  }

  /** Tells the listeners of a committed cap sweep's victims (their stored names). */
  protected reportEvictions(
    victims: readonly { ns: string; k: string }[],
  ): void {
    for (const victim of victims) {
      for (const listener of this.#evictListeners) {
        listener(victim.ns, victim.k, "cap");
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* shared helpers                                                    */
  /* ---------------------------------------------------------------- */

  /** A name as stored: as written up to {@link MAX_SQL_NAME_LENGTH}, `#` + SHA-256 beyond. */
  protected fit(name: string): string {
    return name.length > MAX_SQL_NAME_LENGTH ? `#${sha256(name)}` : name;
  }

  /** The distinct fitted tags, with the original each came from. */
  protected fitTags(tags: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const tag of tags) {
      out.set(this.fit(tag), tag);
    }
    return out;
  }

  /** A `BIGINT` as Bun reads it back (a string or a number), as a number. */
  protected static num(value: string | number | bigint): number {
    return typeof value === "number" ? value : Number(value);
  }

  /** A nullable `BIGINT`. */
  protected static numOrNull(
    value: string | number | bigint | null,
  ): number | null {
    return value === null ? null : SqlCacheDriverBase.num(value);
  }

  /** Decodes an entry row for the caller's key. */
  protected static toEntry(key: string, row: EntryRow): StoredEntry {
    const v = row.v ?? new Uint8Array(0);
    return {
      key,
      // A fresh Uint8Array over the client's Buffer: the contract's type, and
      // no Buffer methods leaking to a caller comparing bytes.
      value: new Uint8Array(v.buffer, v.byteOffset, v.byteLength),
      expiresAt: SqlCacheDriverBase.numOrNull(row.exp),
      tags: row.tg === null ? [] : (JSON.parse(row.tg) as string[]),
    };
  }

  /** Throws for a counter step the `BIGINT` column cannot add. */
  protected static checkStep(by: number): void {
    if (!Number.isSafeInteger(by)) {
      throw new TypeError(
        `SQL cache counters are integers (a BIGINT column); cannot add ${by}`,
      );
    }
  }

  /** The tags as `tg` stores them: JSON, or `null` for none. */
  protected static tagsColumn(tags: readonly string[]): string | null {
    return tags.length === 0 ? null : JSON.stringify(tags);
  }

  abstract get(ns: string, key: string): Promise<StoredEntry | undefined>;
  abstract getMany(
    ns: string,
    keys: readonly string[],
  ): Promise<(StoredEntry | undefined)[]>;
  abstract set(
    ns: string,
    entry: StoredEntry,
    fence?: TagFence,
  ): Promise<"stored" | "fenced">;
  /** Writes several entries, one after another (no fence: bulk writes come from `setMany`, not from loads). */
  async setMany(ns: string, entries: readonly StoredEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.set(ns, entry);
    }
  }
  abstract delete(ns: string, keys: readonly string[]): Promise<number>;
  abstract clear(ns: string): Promise<void>;
  abstract touch(
    ns: string,
    key: string,
    expiresAt: number | null,
  ): Promise<boolean>;
  abstract deleteByTags(
    ns: string,
    tags: readonly string[],
    stampUntil: number,
  ): Promise<number>;
  abstract getStamps(
    ns: string,
    tags: readonly string[],
  ): Promise<Map<string, number>>;
  abstract setStamps(
    ns: string,
    tags: readonly string[],
    at: number,
    until: number,
  ): Promise<void>;
  abstract increment(
    ns: string,
    key: string,
    by: number,
    expiresAt: number | null,
  ): Promise<number>;
  abstract getCounter(
    ns: string,
    key: string,
  ): Promise<
    { value: number; expiresAt: number | null; createdAt: number } | undefined
  >;
  abstract acquireLock(
    ns: string,
    key: string,
    owner: string,
    ttlMs: number,
  ): Promise<boolean>;
  abstract releaseLock(
    ns: string,
    key: string,
    owner: string,
  ): Promise<boolean>;
  abstract sweep(now: number, limit: number): Promise<number>;
  abstract publish(message: BusMessage): Promise<void>;
  abstract subscribe(
    onMessage: (message: BusMessage) => void,
    onGap: () => void,
  ): Promise<() => Promise<void>>;
}
