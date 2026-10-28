/**
 * The Cloudflare D1 driver (plan Status: PR-C11; the spike,
 * `docs/plans/bun-cache/evidence/cloudflare-spike.md`), over HTTP: the REST
 * API with an API token, or the bun-cache Worker
 * (`@kingsleyweb/bun-cache/cloudflare-worker`) with its secret — the README
 * recommends the Worker for production, since the REST API is capped at
 * 1,200 requests per five minutes per token (`../cloudflare/client.ts`).
 *
 * D1 is SQLite in a Durable Object, so the tables and statements are the
 * SQLite driver's (§7.3), with three changes the transport forces:
 *
 * - **Every write is one statement.** D1 refuses `BEGIN`, and the REST API
 *   does not document whether a batch is a transaction, so nothing here
 *   relies on one. **Triggers** keep the tag index (`tags` follows
 *   `entries.tg` on insert, on a change of `tg`, and on delete) and do the
 *   invalidation's deletes (writing a stamp deletes its tag's entries). The
 *   fence (§3.6) is the write's own `WHERE NOT EXISTS (… stamps …)`. D1 runs
 *   one statement at a time, so a fenced write and an invalidation are
 *   ordered whole: measured in the spike, 0 of 60 pre-invalidation writes
 *   survived a concurrent invalidation, against 60 of 60 for a check, then a
 *   write (the race test keeps that as a regression test). A batch is used
 *   only to save round trips (the schema, `setMany`, `clear`, `sweep`).
 * - **Parameters are strings** (the REST API's schema): SQLite's type
 *   affinity stores and compares them as numbers in the integer columns, and
 *   `NULLIF(?, '')` writes a null.
 * - **Values travel as hex**: written with `unhex(?)`, read with `hex(v)`
 *   (a BLOB would come back as a JSON array of numbers). D1 caps a string at
 *   2,000,000 bytes, so an entry holds at most **1,000,000 bytes**
 *   (`maxEntryBytes`); the driver refuses a larger one before sending it.
 *
 * Expiry is filtered on read and reclaimed by the core's sweeper
 * (`ttl: "sweep"`). Counters are the SQLite driver's `RETURNING` upsert,
 * locks its one conditional upsert. There is **no bus** (`bus: "none"`): a
 * polled table over the REST API would spend the token's budget, and D1
 * bills every poll's rows read.
 */
import { Buffer } from "node:buffer";
import { EntryTooLargeError } from "../core/errors";
import type {
  CacheDriver,
  CacheDriverCapabilities,
  SchemaChange,
  SchemaSyncOptions,
  StoredEntry,
  TagFence,
} from "../core/types";
import type { D1Statement } from "../cloudflare/client";
import { CloudflareClient } from "../cloudflare/client";
import type { SqlCacheTable } from "./sql-tables";
import { resolveSqlCacheTables, sqlCacheIndexName } from "./sql-tables";

/** The default table prefix (§21). */
const DEFAULT_PREFIX = "bun_cache_";

/** The tables this driver has: the SQLite driver's, without the bus. */
const D1_TABLES = ["entries", "tags", "stamps", "locks"] as const;

/** A valid SQL identifier prefix: letters, digits and underscores, not starting with a digit. */
const PREFIX_PATTERN = /^[A-Z_]\w*$/i;

/** The largest entry: D1's 2,000,000-byte string limit, halved by the hex encoding. */
export const D1_MAX_ENTRY_BYTES = 1_000_000;

/** How many keys one `getMany` request reads (each value up to 2 MB of hex in the answer). */
const GET_MANY_CHUNK = 10;

/** How many hex characters one `setMany` request carries at most. */
const SET_MANY_HEX_BUDGET = 8_000_000;

/** How many statements one `setMany` request carries at most. */
const SET_MANY_STATEMENTS = 50;

/** `cloudflareD1Driver()`'s options: where the database is, and the driver's own. */
export interface CloudflareD1DriverOptions {
  /** The account's id, for the REST API; `CLOUDFLARE_ACCOUNT_ID` when absent. Ignored with an `endpoint`. */
  accountId?: string;
  /**
   * The bearer token: an API token with *D1: Edit* for the REST API
   * (`CLOUDFLARE_API_TOKEN` when absent), or, with an `endpoint`, the
   * Worker's `BUN_CACHE_PROXY_TOKEN` secret — then required here: the
   * environment's API token is never sent to a Worker.
   */
  apiToken?: string;
  /**
   * The database: its id (a UUID) for the REST API, or its **binding name**
   * in the Worker's `wrangler.toml` with an `endpoint` (e.g. `"CACHE_DB"`).
   */
  databaseId: string;
  /**
   * The bun-cache Worker's URL (`https://bun-cache.<you>.workers.dev`); the
   * REST API when absent. `https:`, or `http:` to a loopback host. The
   * README recommends the Worker for production: the REST API is capped at
   * 1,200 requests per five minutes per token.
   */
  endpoint?: string;
  /** The table-name prefix, an SQL identifier. Defaults to `"bun_cache_"`. Two prefixes in one database are two separate stores. */
  prefix?: string;
  /**
   * Exact table names, as the SQL drivers take them: `{ entries: "app_cache" }`.
   * Given as-is, ignoring `prefix`; the tables not named keep
   * `<prefix><table>`. `entries`, `tags`, `stamps` and `locks` only (there is
   * no bus table). Each an SQL identifier of at most 63 characters, no two
   * alike. Index and trigger names derive from the table names.
   */
  tables?: Partial<Record<SqlCacheTable, string>>;
  /**
   * Run {@link CacheDriver.syncSchema} once the tables are created (first use,
   * or `connect()`): `true` with the default options, or the options to pass.
   * Off by default. A no-op until the schema first changes, as on the SQL
   * drivers.
   */
  syncSchema?: boolean | SchemaSyncOptions;
  /**
   * At most this many entries in this prefix's tables (every namespace
   * together); no cap by default. Enforced by `sweep`, as on the SQL drivers:
   * the entries nearest to expiry go first, then those with no expiry, oldest
   * write first; each is reported as an `evict` event (reason `"cap"`).
   * Counters are never counted or evicted. A positive integer.
   */
  maxEntries?: number;
  /** The clock, epoch ms. Internal: for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** The SQL, built once per driver for its table set. */
interface Statements {
  /** The tables, indexes and triggers, each `IF NOT EXISTS`. */
  schema: string[];
  /** A live entry, its bytes as hex. */
  get: string;
  /** Live entries among a JSON array of keys. */
  getMany: string;
  /** Upserts an entry (replacing a counter at the key); its tag rows follow by trigger. */
  upsert: string;
  /** The same upsert, refused when a live stamp of the fence's tags is at or after the load's start. */
  upsertFenced: string;
  /** Deletes a JSON array of keys, answering each deleted key. */
  delete: string;
  /** Counts the namespace's entries carrying any of a JSON array of tags. */
  countTagged: string;
  /** Upserts stamps (never backwards); their trigger deletes the tagged entries. */
  upsertStamps: string;
  /** Live stamps among a JSON array of tags. */
  getStamps: string;
  /** Extends a live entry's or counter's expiry. */
  touch: string;
  /** Adds to a counter, creating it when absent, expired or an entry. */
  increment: string;
  /** A live counter. */
  getCounter: string;
  /** Takes a lock that is free, lapsed, or already this owner's. */
  acquireLock: string;
  /** Releases a lock held by the owner. */
  releaseLock: string;
  /** Deletes up to N expired entries and counters. */
  sweepEntries: string;
  /** Deletes expired stamps (no trigger: a delete is not an invalidation). */
  sweepStamps: string;
  /** Deletes lapsed locks. */
  sweepLocks: string;
  /** Evicts the excess over `maxEntries`, at most the sweep's limit, in one statement. */
  evictToCap: string;
  /** The namespace-scoped deletes `clear` runs (entries first: their tag rows follow). */
  clear: string[];
}

/** A trigger's name for `table`: as an index's, with `tr_` for `ix_`. */
function triggerName(table: string, suffix: string): string {
  return sqlCacheIndexName(table, suffix).replace(/^ix_/, "tr_");
}

/** Builds a table set's statements. The names are validated before this runs. */
function buildStatements(names: Record<SqlCacheTable, string>): Statements {
  const entries = `"${names.entries}"`;
  const tags = `"${names.tags}"`;
  const stamps = `"${names.stamps}"`;
  const locks = `"${names.locks}"`;
  const insertTags = (row: string): string =>
    `INSERT OR IGNORE INTO ${tags} (ns, tag, k) SELECT ${row}.ns, value, ${row}.k FROM json_each(${row}.tg)`;
  const deleteTagged = `DELETE FROM ${entries} WHERE ns = NEW.ns AND k IN (SELECT k FROM ${tags} WHERE ns = NEW.ns AND tag = NEW.tag)`;
  const upsertTail = `ON CONFLICT (ns, k) DO UPDATE SET v = excluded.v, n = NULL, exp = excluded.exp, tg = excluded.tg, ca = excluded.ca`;
  const live = `${entries}.n IS NOT NULL AND (${entries}.exp IS NULL OR ${entries}.exp > ?5)`;
  return {
    schema: [
      `CREATE TABLE IF NOT EXISTS ${entries} (ns TEXT NOT NULL, k TEXT NOT NULL, v BLOB, n INTEGER, exp INTEGER, tg TEXT, ca INTEGER, PRIMARY KEY (ns, k)) WITHOUT ROWID`,
      `CREATE INDEX IF NOT EXISTS "${sqlCacheIndexName(names.entries, "exp")}" ON ${entries} (exp) WHERE exp IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS ${tags} (ns TEXT NOT NULL, tag TEXT NOT NULL, k TEXT NOT NULL, PRIMARY KEY (ns, tag, k)) WITHOUT ROWID`,
      `CREATE INDEX IF NOT EXISTS "${sqlCacheIndexName(names.tags, "key")}" ON ${tags} (ns, k)`,
      `CREATE TABLE IF NOT EXISTS ${stamps} (ns TEXT NOT NULL, tag TEXT NOT NULL, at INTEGER NOT NULL, exp INTEGER NOT NULL, PRIMARY KEY (ns, tag)) WITHOUT ROWID`,
      `CREATE TABLE IF NOT EXISTS ${locks} (ns TEXT NOT NULL, k TEXT NOT NULL, owner TEXT NOT NULL, exp INTEGER NOT NULL, PRIMARY KEY (ns, k)) WITHOUT ROWID`,
      // The tag index follows entries.tg, so every write of an entry is one
      // statement (a statement and its triggers are atomic in SQLite).
      `CREATE TRIGGER IF NOT EXISTS "${triggerName(names.entries, "tags_ai")}" AFTER INSERT ON ${entries} WHEN NEW.tg IS NOT NULL BEGIN ${insertTags("NEW")}; END`,
      `CREATE TRIGGER IF NOT EXISTS "${triggerName(names.entries, "tags_au")}" AFTER UPDATE OF tg ON ${entries} BEGIN DELETE FROM ${tags} WHERE ns = OLD.ns AND k = OLD.k; ${insertTags("NEW")}; END`,
      `CREATE TRIGGER IF NOT EXISTS "${triggerName(names.entries, "tags_ad")}" AFTER DELETE ON ${entries} WHEN OLD.tg IS NOT NULL BEGIN DELETE FROM ${tags} WHERE ns = OLD.ns AND k = OLD.k; END`,
      // A stamp is an invalidation: writing one deletes its tag's entries in
      // the same statement (and their tag rows, by the trigger above).
      `CREATE TRIGGER IF NOT EXISTS "${triggerName(names.stamps, "inv_ai")}" AFTER INSERT ON ${stamps} BEGIN ${deleteTagged}; END`,
      `CREATE TRIGGER IF NOT EXISTS "${triggerName(names.stamps, "inv_au")}" AFTER UPDATE ON ${stamps} BEGIN ${deleteTagged}; END`,
    ],
    get: `SELECT hex(v) AS v, exp, tg FROM ${entries} WHERE ns = ?1 AND k = ?2 AND n IS NULL AND (exp IS NULL OR exp > ?3)`,
    getMany: `SELECT k, hex(v) AS v, exp, tg FROM ${entries} WHERE ns = ?1 AND k IN (SELECT value FROM json_each(?2)) AND n IS NULL AND (exp IS NULL OR exp > ?3)`,
    upsert: `INSERT INTO ${entries} (ns, k, v, n, exp, tg, ca) VALUES (?1, ?2, unhex(?3), NULL, NULLIF(?4, ''), NULLIF(?5, ''), ?6) ${upsertTail}`,
    // The fence (§3.6) in the write's own WHERE: one statement, so no
    // invalidation can land between the check and the write.
    upsertFenced: `INSERT INTO ${entries} (ns, k, v, n, exp, tg, ca) SELECT ?1, ?2, unhex(?3), NULL, NULLIF(?4, ''), NULLIF(?5, ''), ?6 WHERE NOT EXISTS (SELECT 1 FROM ${stamps} WHERE ns = ?1 AND tag IN (SELECT value FROM json_each(?7)) AND exp > ?6 AND at >= ?8) ${upsertTail} RETURNING 1 AS stored`,
    delete: `DELETE FROM ${entries} WHERE ns = ?1 AND k IN (SELECT value FROM json_each(?2)) RETURNING k`,
    countTagged: `SELECT count(*) AS c FROM ${entries} WHERE ns = ?1 AND k IN (SELECT k FROM ${tags} WHERE ns = ?1 AND tag IN (SELECT value FROM json_each(?2)))`,
    // `WHERE true` disambiguates the upsert after a SELECT (SQLite's parser rule).
    upsertStamps: `INSERT INTO ${stamps} (ns, tag, at, exp) SELECT ?1, value, ?2, ?3 FROM json_each(?4) WHERE true ON CONFLICT (ns, tag) DO UPDATE SET at = MAX(at, excluded.at), exp = MAX(exp, excluded.exp)`,
    getStamps: `SELECT tag, at FROM ${stamps} WHERE ns = ?1 AND tag IN (SELECT value FROM json_each(?2)) AND exp > ?3`,
    touch: `UPDATE ${entries} SET exp = NULLIF(?3, '') WHERE ns = ?1 AND k = ?2 AND (exp IS NULL OR exp > ?4) RETURNING 1 AS touched`,
    // §3.8, the SQLite driver's: `live` is judged once from the old row.
    increment: `INSERT INTO ${entries} (ns, k, v, n, exp, tg, ca) VALUES (?1, ?2, NULL, ?3, NULLIF(?4, ''), NULL, ?5) ON CONFLICT (ns, k) DO UPDATE SET n = CASE WHEN ${live} THEN ${entries}.n + excluded.n ELSE excluded.n END, exp = CASE WHEN ${live} THEN ${entries}.exp ELSE excluded.exp END, ca = CASE WHEN ${live} THEN ${entries}.ca ELSE excluded.ca END, v = NULL, tg = NULL RETURNING n`,
    getCounter: `SELECT n, exp, ca FROM ${entries} WHERE ns = ?1 AND k = ?2 AND n IS NOT NULL AND (exp IS NULL OR exp > ?3)`,
    acquireLock: `INSERT INTO ${locks} (ns, k, owner, exp) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (ns, k) DO UPDATE SET owner = excluded.owner, exp = excluded.exp WHERE ${locks}.exp <= ?5 OR ${locks}.owner = excluded.owner RETURNING owner`,
    releaseLock: `DELETE FROM ${locks} WHERE ns = ?1 AND k = ?2 AND owner = ?3 RETURNING 1 AS released`,
    sweepEntries: `DELETE FROM ${entries} WHERE (ns, k) IN (SELECT ns, k FROM ${entries} WHERE exp IS NOT NULL AND exp <= ?1 LIMIT ?2) RETURNING ns, k`,
    sweepStamps: `DELETE FROM ${stamps} WHERE exp <= ?1`,
    sweepLocks: `DELETE FROM ${locks} WHERE exp <= ?1`,
    // `entry-cap.ts`'s order (nearest to expiry first, then no expiry, oldest
    // write first; ties on the key) and count (entries, not counters), as one
    // statement: its select-then-delete needs a transaction D1's REST API
    // does not promise, and SQLite takes a subquery in LIMIT (measured). The
    // CASTs matter: a parameter is a string, and `min()` ranks any number
    // below any string, so `min(2, '1')` is 2 (measured: the cap evicted one
    // more than the limit without them).
    evictToCap: `DELETE FROM ${entries} WHERE (ns, k) IN (SELECT ns, k FROM ${entries} WHERE n IS NULL ORDER BY exp IS NULL, exp, ca, ns, k LIMIT max(0, min((SELECT count(*) FROM ${entries} WHERE n IS NULL) - CAST(?1 AS INTEGER), CAST(?2 AS INTEGER)))) RETURNING ns, k`,
    clear: [entries, tags, stamps, locks].map(
      (table) => `DELETE FROM ${table} WHERE ns = ?1`,
    ),
  };
}

/** A number or null as a D1 parameter (`''` is `NULLIF`'s null). */
function param(value: number | null): string {
  return value === null ? "" : String(value);
}

/** Hex for `unhex(?)`. */
function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "hex",
  );
}

/** Bytes from `hex(v)`; empty for a null. */
function fromHex(hex: unknown): Uint8Array {
  return typeof hex === "string" && hex !== ""
    ? new Uint8Array(Buffer.from(hex, "hex"))
    : new Uint8Array(0);
}

/** A number column (D1 answers integers as JSON numbers); `null` stays `null`. */
function num(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** The tags column (a JSON array, or null). */
function parseTags(value: unknown): string[] {
  return typeof value === "string" ? (JSON.parse(value) as string[]) : [];
}

/** The Cloudflare D1 driver. See the module header and {@link CloudflareD1DriverOptions}. */
export class CloudflareD1CacheDriver implements CacheDriver {
  /** `"cloudflare-d1"`. */
  readonly name = "cloudflare-d1";

  /** SQLite's atomicity, one statement at a time: a tag index with an atomic fence, counters and locks; no bus (plan Status, PR-C11). */
  readonly capabilities: CacheDriverCapabilities = {
    multiProcess: true,
    ttl: "sweep",
    atomicIncrement: true,
    lock: true,
    tags: "index",
    fence: "atomic",
    bus: "none",
    maxEntryBytes: D1_MAX_ENTRY_BYTES,
  };

  /** The resolved table names. Internal; read by the tests. */
  readonly tables: Record<SqlCacheTable, string>;

  /** The HTTP client (REST API or Worker). Internal; read by the tests. */
  readonly client: CloudflareClient;

  /** The database id, or the Worker's binding name. */
  readonly #databaseId: string;

  /** The statements. */
  readonly #sql: Statements;

  /** The `syncSchema` option. */
  readonly #sync: boolean | SchemaSyncOptions;

  /** The `maxEntries` cap; `undefined` for none. */
  readonly #maxEntries: number | undefined;

  /** The clock. */
  readonly #now: () => number;

  /** The schema creation, shared; cleared when it fails. */
  #ready: Promise<void> | undefined;

  /** The `onEviction` listeners, told of each `maxEntries` eviction. */
  readonly #evictListeners: ((
    ns: string,
    key: string,
    reason: string,
  ) => void)[] = [];

  /** Set once `close()` ran. */
  #closed = false;

  constructor(
    /** Where the database is, and the driver's own options. */ options: CloudflareD1DriverOptions,
  ) {
    if (typeof options.databaseId !== "string" || options.databaseId === "") {
      throw new TypeError(
        "cloudflareD1Driver needs databaseId: the database's id (REST API) or its binding name (Worker)",
      );
    }
    const prefix = options.prefix ?? DEFAULT_PREFIX;
    if (!PREFIX_PATTERN.test(prefix) || prefix.length > 48) {
      throw new TypeError(
        `cloudflareD1Driver: prefix ${JSON.stringify(prefix)} must be an SQL identifier (letters, digits, underscores; at most 48 characters)`,
      );
    }
    const { maxEntries } = options;
    if (
      maxEntries !== undefined &&
      !(Number.isSafeInteger(maxEntries) && maxEntries > 0)
    ) {
      throw new TypeError(
        `cloudflareD1Driver: maxEntries must be a positive integer, got ${String(maxEntries)}`,
      );
    }
    this.tables = resolveSqlCacheTables(
      "cloudflareD1Driver",
      prefix,
      options.tables,
      D1_TABLES,
    );
    this.#sql = buildStatements(this.tables);
    this.#databaseId = options.databaseId;
    this.#sync = options.syncSchema ?? false;
    this.#maxEntries = maxEntries;
    this.#now = options.now ?? Date.now;
    this.client = new CloudflareClient({
      accountId: options.accountId,
      apiToken: options.apiToken,
      endpoint: options.endpoint,
      caller: "cloudflareD1Driver",
    });
  }

  /* ---------------------------------------------------------------- */
  /* lifecycle and the wire                                            */
  /* ---------------------------------------------------------------- */

  /** Creates the tables, indexes and triggers if missing (one batch, each `IF NOT EXISTS`), then the optional sync. Idempotent. */
  async connect(): Promise<void> {
    this.#assertOpen();
    this.#ready ??= (async () => {
      await this.client.d1Query(
        this.#databaseId,
        this.#sql.schema.map((sql) => ({ sql })),
      );
      if (this.#sync !== false) {
        await this.syncSchema(this.#sync === true ? {} : this.#sync);
      }
    })().catch((error: unknown) => {
      this.#ready = undefined;
      throw error;
    });
    await this.#ready;
  }

  /** Nothing to close: `fetch` holds no connection the driver owns. Further operations throw. */
  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }

  /** A trivial query. */
  async ping(): Promise<void> {
    await this.client.d1Query(this.#databaseId, [{ sql: "SELECT 1" }]);
  }

  /** Throws once the driver is closed. */
  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("the cloudflare-d1 cache driver is closed");
    }
  }

  /** Runs statements (one request), once the schema exists; answers each statement's rows. */
  async #query(
    statements: readonly D1Statement[],
  ): Promise<Record<string, unknown>[][]> {
    await this.connect();
    const results = await this.client.d1Query(this.#databaseId, statements);
    return results.map((result) => result.results ?? []);
  }

  /** One statement's rows. */
  async #one(
    sql: string,
    ...params: string[]
  ): Promise<Record<string, unknown>[]> {
    return (await this.#query([{ sql, params }]))[0] ?? [];
  }

  /* ---------------------------------------------------------------- */
  /* entries                                                           */
  /* ---------------------------------------------------------------- */

  async get(ns: string, key: string): Promise<StoredEntry | undefined> {
    const [row] = await this.#one(this.#sql.get, ns, key, String(this.#now()));
    return row === undefined
      ? undefined
      : {
          key,
          value: fromHex(row.v),
          expiresAt: num(row.exp),
          tags: parseTags(row.tg),
        };
  }

  /** One `IN` query per ten keys, the answers put back in the keys' order. */
  async getMany(
    ns: string,
    keys: readonly string[],
  ): Promise<(StoredEntry | undefined)[]> {
    const found = new Map<string, StoredEntry>();
    const now = String(this.#now());
    const unique = [...new Set(keys)];
    for (let start = 0; start < unique.length; start += GET_MANY_CHUNK) {
      const rows = await this.#one(
        this.#sql.getMany,
        ns,
        JSON.stringify(unique.slice(start, start + GET_MANY_CHUNK)),
        now,
      );
      for (const row of rows) {
        const key = String(row.k);
        found.set(key, {
          key,
          value: fromHex(row.v),
          expiresAt: num(row.exp),
          tags: parseTags(row.tg),
        });
      }
    }
    return keys.map((key) => found.get(key));
  }

  /** The upsert's parameters for an entry (`?1`–`?6`). */
  #upsertParams(ns: string, entry: StoredEntry, now: number): string[] {
    if (entry.value.length > D1_MAX_ENTRY_BYTES) {
      throw new EntryTooLargeError(
        entry.key,
        entry.value.length,
        D1_MAX_ENTRY_BYTES,
      );
    }
    return [
      ns,
      entry.key,
      toHex(entry.value),
      param(entry.expiresAt),
      entry.tags.length === 0 ? "" : JSON.stringify(entry.tags),
      String(now),
    ];
  }

  async set(
    ns: string,
    entry: StoredEntry,
    fence?: TagFence,
  ): Promise<"stored" | "fenced"> {
    const now = this.#now();
    const params = this.#upsertParams(ns, entry, now);
    if (fence === undefined || fence.tags.length === 0) {
      await this.#one(this.#sql.upsert, ...params);
      return "stored";
    }
    const rows = await this.#one(
      this.#sql.upsertFenced,
      ...params,
      JSON.stringify(fence.tags),
      String(fence.createdAt),
    );
    return rows.length === 1 ? "stored" : "fenced";
  }

  /** Batches of upserts, each one statement (up to 50 a request, ~8 MB of hex). */
  async setMany(ns: string, entries: readonly StoredEntry[]): Promise<void> {
    const now = this.#now();
    let batch: D1Statement[] = [];
    let hex = 0;
    for (const entry of entries) {
      const params = this.#upsertParams(ns, entry, now);
      if (
        batch.length >= SET_MANY_STATEMENTS ||
        (batch.length > 0 && hex + params[2].length > SET_MANY_HEX_BUDGET)
      ) {
        await this.#query(batch);
        batch = [];
        hex = 0;
      }
      batch.push({ sql: this.#sql.upsert, params });
      hex += params[2].length;
    }
    if (batch.length > 0) {
      await this.#query(batch);
    }
  }

  /** One statement; the tag rows go by trigger. Counts entries and counters alike, as on SQLite. */
  async delete(ns: string, keys: readonly string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }
    const rows = await this.#one(
      this.#sql.delete,
      ns,
      JSON.stringify([...new Set(keys)]),
    );
    return rows.length;
  }

  /** Empties the namespace's tables in one request (entries first, so their tag rows follow by trigger). Not atomic over the REST API. */
  async clear(ns: string): Promise<void> {
    await this.#query(this.#sql.clear.map((sql) => ({ sql, params: [ns] })));
  }

  async touch(
    ns: string,
    key: string,
    expiresAt: number | null,
  ): Promise<boolean> {
    const rows = await this.#one(
      this.#sql.touch,
      ns,
      key,
      param(expiresAt),
      String(this.#now()),
    );
    return rows.length > 0;
  }

  /* ---------------------------------------------------------------- */
  /* tags (index mode, §3.6)                                           */
  /* ---------------------------------------------------------------- */

  /**
   * The invalidation is the stamps upsert, whose trigger deletes the tagged
   * entries in the same statement. The count is read just before it, in the
   * same request: exact through the Worker (a batch is one transaction),
   * possibly short by a concurrent write over the REST API (it only feeds the
   * `invalidate` event's figure).
   */
  async deleteByTags(
    ns: string,
    tags: readonly string[],
    stampUntil: number,
  ): Promise<number> {
    if (tags.length === 0) {
      return 0;
    }
    const list = JSON.stringify([...new Set(tags)]);
    const [counted] = await this.#query([
      { sql: this.#sql.countTagged, params: [ns, list] },
      {
        sql: this.#sql.upsertStamps,
        params: [ns, String(this.#now()), String(stampUntil), list],
      },
    ]);
    return Number(counted?.[0]?.c ?? 0);
  }

  async getStamps(
    ns: string,
    tags: readonly string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (tags.length === 0) {
      return out;
    }
    const rows = await this.#one(
      this.#sql.getStamps,
      ns,
      JSON.stringify(tags),
      String(this.#now()),
    );
    for (const row of rows) {
      out.set(String(row.tag), Number(row.at));
    }
    return out;
  }

  /**
   * Writes stamps (never moving one backwards). On this driver a stamp is an
   * invalidation: its trigger deletes the tag's entries too. The core writes
   * stamps through {@link deleteByTags} here; this is the contract's direct
   * form.
   */
  async setStamps(
    ns: string,
    tags: readonly string[],
    at: number,
    until: number,
  ): Promise<void> {
    if (tags.length === 0) {
      return;
    }
    await this.#one(
      this.#sql.upsertStamps,
      ns,
      String(at),
      String(until),
      JSON.stringify([...new Set(tags)]),
    );
  }

  /* ---------------------------------------------------------------- */
  /* counters (§3.8) and locks                                         */
  /* ---------------------------------------------------------------- */

  /** One `RETURNING` upsert; an entry's tag rows at the key go by trigger (its `tg` becomes null). */
  async increment(
    ns: string,
    key: string,
    by: number,
    expiresAt: number | null,
  ): Promise<number> {
    const [row] = await this.#one(
      this.#sql.increment,
      ns,
      key,
      String(by),
      param(expiresAt),
      String(this.#now()),
    );
    return Number(row?.n);
  }

  async getCounter(
    ns: string,
    key: string,
  ): Promise<
    { value: number; expiresAt: number | null; createdAt: number } | undefined
  > {
    const [row] = await this.#one(
      this.#sql.getCounter,
      ns,
      key,
      String(this.#now()),
    );
    return row === undefined
      ? undefined
      : {
          value: Number(row.n),
          expiresAt: num(row.exp),
          createdAt: Number(row.ca),
        };
  }

  /** One conditional upsert: the staleness judgment and the take are one statement. */
  async acquireLock(
    ns: string,
    key: string,
    owner: string,
    ttlMs: number,
  ): Promise<boolean> {
    const now = this.#now();
    const rows = await this.#one(
      this.#sql.acquireLock,
      ns,
      key,
      owner,
      String(now + ttlMs),
      String(now),
    );
    return rows.length > 0;
  }

  async releaseLock(ns: string, key: string, owner: string): Promise<boolean> {
    return (await this.#one(this.#sql.releaseLock, ns, key, owner)).length > 0;
  }

  /* ---------------------------------------------------------------- */
  /* the sweeper                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Deletes up to `limit` expired entries and counters, the expired stamps
   * and the lapsed locks (one request), then evicts the excess over
   * `maxEntries` (one statement) and reports each victim.
   */
  async sweep(now: number, limit: number): Promise<number> {
    const [expired] = await this.#query([
      { sql: this.#sql.sweepEntries, params: [String(now), String(limit)] },
      { sql: this.#sql.sweepStamps, params: [String(now)] },
      { sql: this.#sql.sweepLocks, params: [String(now)] },
    ]);
    if (this.#maxEntries !== undefined) {
      const evicted = await this.#one(
        this.#sql.evictToCap,
        String(this.#maxEntries),
        String(limit),
      );
      for (const row of evicted) {
        for (const listener of this.#evictListeners) {
          listener(String(row.ns), String(row.k), "cap");
        }
      }
    }
    return expired?.length ?? 0;
  }

  /** Registers a listener for `maxEntries` evictions (reason `"cap"`); the core turns them into `evict` events. */
  onEviction(
    listener: (ns: string, key: string, reason: string) => void,
  ): void {
    this.#evictListeners.push(listener);
  }

  /** There is one schema version: nothing to sync (§7.4). Creates the tables first when they are missing. */
  async syncSchema(_options: SchemaSyncOptions = {}): Promise<SchemaChange[]> {
    if (this.#ready === undefined) {
      await this.client.d1Query(
        this.#databaseId,
        this.#sql.schema.map((sql) => ({ sql })),
      );
    }
    return [];
  }
}

/** A Cloudflare D1 driver (plan Status, PR-C11): the SQLite driver's tables over HTTP, every write one statement. See {@link CloudflareD1DriverOptions}. */
export function cloudflareD1Driver(
  options: CloudflareD1DriverOptions,
): CacheDriver {
  return new CloudflareD1CacheDriver(options);
}
