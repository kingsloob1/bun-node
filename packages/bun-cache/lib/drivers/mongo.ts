/**
 * The MongoDB driver (plan §7.6), over the `mongodb` package — an **optional
 * peer**, loaded on first connect by a dynamic `import()` of a
 * `string`-typed specifier, and spoken to through the structural `*Like`
 * types below, so a project that never builds this driver needs neither the
 * package nor its types (bun-jobs' pattern, `mongo/mongo-driver.ts`).
 *
 * **Collections** (the default prefix is `bun_cache_`; `collections` names
 * any of them outright):
 *
 * ```
 * <p>entries { _id: { ns, k }, v?: Binary, n?: number, exp: Date | null, tags: [], ca, w }
 *            TTL exp_1 (expireAfterSeconds 0); _id.ns_1_tags_1 (multikey: the tag index)
 * <p>stamps  { _id: { ns, tag }, at, exp: Date }    TTL exp_1
 * <p>locks   { _id: { ns, k }, owner, exp: Date }   TTL exp_1
 * <p>bus     capped (busSize, 16 MiB), { _id, ts: Timestamp, m: BusMessage }
 * ```
 *
 * An entry carries its value in `v`; a counter (§3.8) carries its value in
 * `n` and has no `v`, so `$inc` adds atomically and `get` never mistakes one
 * for the other. `ca` is the write time (an entry's last `set`, a counter's
 * creation), `w` a per-write id the fence's compensation deletes by.
 *
 * - **Expiry.** A TTL index on `exp` reclaims what expired, but MongoDB's TTL
 *   monitor runs once a minute (`ttlMonitorSleepSecs: 60`, measured on the
 *   local server), so an expired document can survive about that long:
 *   **every read filters `exp` itself**. `sweep` also deletes expired entries
 *   (bounded by its `limit`), so the core's sweeper reclaims them sooner, and
 *   enforces `maxEntries`.
 * - **The fence** (§3.6) is check-then-write, as the plan says MongoDB's must
 *   be without a transaction, with a **compensating re-check**: read the
 *   stamps, write the entry with a fresh write id, read the stamps again, and
 *   when a stamp at or after the load's start appeared meanwhile, delete the
 *   entry *if it is still this write's* and answer `"fenced"`. `deleteByTags`
 *   writes its stamps **before** its delete. So every interleaving ends with
 *   no pre-invalidation value stored: a write that lands before the delete is
 *   deleted by it, and one that lands after it re-reads stamps written before
 *   it. What remains is a window of one round trip in which a reader can see
 *   the stale value — hence `fence: "check-then-write"`.
 * - **Counters**: one `findOneAndUpdate` with an update pipeline — add to a
 *   live counter, or start a new one (no document, an entry under the key, or
 *   an expired counter) — upserting, answering the new value.
 * - **Locks**: `findOneAndUpdate({ _id, $or: [lapsed, ours] }, …, { upsert })`;
 *   a duplicate-key error means someone else holds it.
 * - **The bus** (§4.2): a **change stream** on the capped `bus` collection
 *   when the server is a replica set or `mongos`, otherwise a **tailable,
 *   awaitData cursor** on it (a standalone server refuses change streams:
 *   measured, code 40573). Each message is written by an upsert stamping a
 *   server `Timestamp` (`$currentDate`), which positions a tailing cursor
 *   after what was there when it opened. A lost stream or cursor (the
 *   collection dropped, the cursor overrun — `CappedPositionLost`, the
 *   change-stream history lost, a network error past the client's own
 *   resume) is reopened and reported as a gap, unless the tailing cursor can
 *   prove nothing it had not read was overwritten.
 * - **The server** must be MongoDB 4.2 or later (update pipelines, unbounded
 *   index keys); measured on 7.0, standalone and as a replica set.
 * - **Read preference** `primary` on every collection, as in bun-jobs: the
 *   reads that decide writes (the fence, the lock) must not see a lagging
 *   secondary, and a client the application lends keeps its own preference
 *   for everything else.
 */
import type {
  BusMessage,
  CacheDriver,
  CacheDriverCapabilities,
  SchemaChange,
  SchemaSyncOptions,
  StoredEntry,
  TagFence,
} from "../core/types";
import type { ConnectionInput } from "./sql-connection";
import { entryCapExcess } from "./entry-cap";
import { resolveConnectionUrl } from "./sql-connection";

/* ------------------------------------------------------------------ */
/* The `mongodb` surface this driver uses (after bun-jobs'             */
/* mongo/mongo-driver.ts@6dcef564, "the mongodb surface")              */
/* ------------------------------------------------------------------ */

/**
 * Declared here rather than imported from `mongodb`, an *optional* peer: a
 * static `import type` would be `TS2307` for every consumer without it. These
 * are structural, so a real `MongoClient` still satisfies
 * {@link MongoClientLike} (`__tests__/drivers/mongo.type-test.ts` checks it).
 * Only what this driver calls is declared.
 */

/** A query or update document. */
type DocLike = Record<string, unknown>;

/** A cursor over `find()` results (and a tailable one over the bus). */
interface FindCursorLike<TDoc> {
  /** Orders the results. */
  sort: (spec: Record<string, 1 | -1>) => FindCursorLike<TDoc>;
  /** Caps how many come back. */
  limit: (count: number) => FindCursorLike<TDoc>;
  /** Drains the cursor. */
  toArray: () => Promise<TDoc[]>;
  /** The next document, or `null` when the current batch is empty (a tailable cursor waits `maxAwaitTimeMS` first). */
  tryNext: () => Promise<TDoc | null>;
  /** Kills the cursor. */
  close: () => Promise<void>;
  /** Whether the cursor is dead (exhausted, killed, or the server dropped it). */
  readonly closed: boolean;
}

/** A change stream, as `watch()` answers it. */
interface ChangeStreamLike {
  /** The next change, or `null` when none arrived within `maxAwaitTimeMS`. */
  tryNext: () => Promise<DocLike | null>;
  /** Closes the stream. */
  close: () => Promise<void>;
  /** Whether the stream is closed (invalidated, errored past resuming, or closed). */
  readonly closed: boolean;
  /** Where the stream has read up to: the last change's token, or the server's post-batch one. */
  readonly resumeToken: unknown;
}

/** One collection, with the operations this driver performs on it. */
interface CollectionLike<TDoc> {
  /** One matching document, or `null`. */
  findOne: (filter: DocLike, options?: DocLike) => Promise<TDoc | null>;
  /** A cursor over the matching documents. */
  find: (filter: DocLike, options?: DocLike) => FindCursorLike<TDoc>;
  /** Replaces one document wholesale. */
  replaceOne: (
    filter: DocLike,
    replacement: TDoc,
    options?: DocLike,
  ) => Promise<{ matchedCount: number; upsertedCount: number }>;
  /** Updates the first match. */
  updateOne: (
    filter: DocLike,
    update: DocLike | DocLike[],
    options?: DocLike,
  ) => Promise<{ matchedCount: number; upsertedCount: number }>;
  /** Updates one document and answers with it. */
  findOneAndUpdate: (
    filter: DocLike,
    update: DocLike | DocLike[],
    options?: DocLike,
  ) => Promise<TDoc | null>;
  /** Deletes the first match. */
  deleteOne: (filter: DocLike) => Promise<{ deletedCount: number }>;
  /** Deletes every match. */
  deleteMany: (filter: DocLike) => Promise<{ deletedCount: number }>;
  /** How many documents match. */
  countDocuments: (filter: DocLike) => Promise<number>;
  /** Several writes in one round trip. */
  bulkWrite: (operations: DocLike[], options?: DocLike) => Promise<unknown>;
  /** Creates one index, answering with its name. */
  createIndex: (
    key: Record<string, 1 | -1>,
    options?: DocLike,
  ) => Promise<string>;
  /** Every index on the collection. */
  indexes: () => Promise<{ name?: string; key: DocLike }[]>;
  /** Drops one index by name. */
  dropIndex: (name: string) => Promise<unknown>;
  /** Opens a change stream on the collection. */
  watch: (pipeline: DocLike[], options?: DocLike) => ChangeStreamLike;
  /** Drops the collection. */
  drop: () => Promise<unknown>;
}

/** The options this driver passes when it obtains a collection. */
interface CollectionOptionsLike {
  /** Which members of a replica set the collection's reads go to. */
  readPreference?: "primary";
}

/** One database, with the operations this driver performs on it. */
interface DbLike {
  /** A collection by name. */
  collection: <TDoc = DocLike>(
    name: string,
    options?: CollectionOptionsLike,
  ) => CollectionLike<TDoc>;
  /** Creates a collection (the capped bus). */
  createCollection: (name: string, options?: DocLike) => Promise<unknown>;
  /** The collections matching `filter`, described. */
  listCollections: (filter: DocLike) => {
    toArray: () => Promise<{ name: string; options?: DocLike }[]>;
  };
  /** Runs a database command (`ping`, `hello`). */
  command: (command: DocLike) => Promise<DocLike>;
}

/**
 * A client, as the `client` option accepts one: the smallest shape this
 * driver needs, because every member named here is one a real `MongoClient`
 * must match. The database is `unknown` and asserted as {@link DbLike} at the
 * one place it is obtained (bun-jobs measured that typing `db()` fully made a
 * real client unassignable).
 */
export interface MongoClientLike {
  /** Connects, or resolves at once when already connected. */
  connect: () => Promise<unknown>;
  /** A database by name. */
  db: (name?: string) => unknown;
  /** Closes the client. */
  close: () => Promise<void>;
}

/** The `MongoClient` class, as this driver constructs it. */
type MongoClientConstructor = new (
  url: string,
  options?: Record<string, unknown>,
) => MongoClientLike;

/** Every collection read from the primary (see the module header). */
const COLLECTION_OPTIONS: CollectionOptionsLike = { readPreference: "primary" };

/* ------------------------------------------------------------------ */
/* Copied from bun-jobs/lib/shared/connection.ts@6dcef564              */
/* ------------------------------------------------------------------ */

/**
 * The database a connection URL's path names, or `undefined` for none.
 * Copied from bun-jobs' `databaseFromUrl` (its drift test is in
 * `__tests__/drivers/mongodb.test.ts`).
 */
export function databaseFromUrl(url: string): string | undefined {
  try {
    const path = new URL(url).pathname.replace(/^\//, "");
    return path.length > 0 ? decodeURIComponent(path) : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

/** The default collection prefix (§7, §21). */
export const DEFAULT_MONGO_PREFIX = "bun_cache_";

/** The default database when neither the options nor the URL name one. */
export const DEFAULT_MONGO_DATABASE = "bun_cache";

/** The default size of the capped bus collection, in bytes (§7.6). */
export const DEFAULT_MONGO_BUS_SIZE = 16 * 1024 * 1024;

/** The collections the MongoDB cache driver keeps. */
export const MONGO_CACHE_COLLECTIONS = [
  "entries",
  "stamps",
  "locks",
  "bus",
] as const;

/** One of the MongoDB driver's collections, as the `collections` option names it. */
export type MongoCacheCollection = (typeof MONGO_CACHE_COLLECTIONS)[number];

/** A collection name this driver accepts: letters, digits, `_`, `.` and `-`, not starting with `system.`. */
const COLLECTION_NAME = /^[a-z_][\w.-]*$/i;

/** The longest collection name accepted (MongoDB's namespace limit is 255 bytes with the database). */
const MAX_COLLECTION_NAME_LENGTH = 120;

/**
 * Indexes earlier versions of this driver created and this one no longer
 * defines. `syncSchema` drops an index **only** when it is on this list:
 * MongoDB names an index after its key pattern, so an index this driver no
 * longer defines is indistinguishable from one an operator added by hand
 * (CLAUDE.md, "Schema sync"). Empty: the schema has one version.
 */
const RETIRED_INDEXES: readonly {
  /** Which of the driver's collections the index is on. */
  collection: MongoCacheCollection;
  /** The index's name, as MongoDB derived it from the key pattern. */
  name: string;
}[] = [];

/** One index this driver defines. */
interface IndexDefinition {
  /** Which collection. */
  collection: MongoCacheCollection;
  /** The key pattern. */
  key: Record<string, 1 | -1>;
  /** `expireAfterSeconds` for a TTL index. */
  ttl?: number;
}

/** The indexes, as data, so `syncSchema` compares against what connect creates. */
const INDEXES: readonly IndexDefinition[] = [
  // The TTL monitor's: documents whose `exp` passed. `null` never expires.
  { collection: "entries", key: { exp: 1 }, ttl: 0 },
  // The tag index (multikey over `tags`), and `clear`'s namespace prefix.
  { collection: "entries", key: { "_id.ns": 1, tags: 1 } },
  { collection: "stamps", key: { exp: 1 }, ttl: 0 },
  { collection: "locks", key: { exp: 1 }, ttl: 0 },
];

/** MongoDB's own name for a key pattern, which is what `indexes()` reports. */
function indexName(key: Record<string, 1 | -1>): string {
  return Object.entries(key)
    .map(([field, direction]) => `${field}_${direction}`)
    .join("_");
}

/** Server error codes this driver reads. */
const DUPLICATE_KEY = 11000;
const NAMESPACE_EXISTS = 48;
const CAPPED_POSITION_LOST = 136;
/**
 * The change-stream errors no resume can recover from: the history is gone
 * (`ChangeStreamHistoryLost`), the token is unusable (`InvalidResumeToken`),
 * or the stream cannot go on (`ChangeStreamFatalError`).
 */
const CHANGE_STREAM_FATAL = new Set([260, 280, 286]);

/** The error's server `code`, when it has one. */
function codeOf(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

/** How long one bus `getMore` waits for a message before asking again, ms. */
const BUS_AWAIT_MS = 1_000;

/** The largest bus message written as is, in bytes; past it, a `clear` of its namespace is sent instead. */
const MAX_BUS_MESSAGE_BYTES = 64 * 1024;

/** The reserved namespace of the `maxEntries` sweep's lock. */
const CAP_LOCK_NAMESPACE = "\u0000bun-cache:cap";

/** How the bus reads: a change stream, or a tailable cursor on the capped collection. */
type BusMode = "change-stream" | "tailable";

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

/** `mongoDriver()`'s options. */
export interface MongoDriverOptions extends ConnectionInput {
  /**
   * An already-created client (a `MongoClient`), when the application has one
   * to share. The driver calls its `connect()` (idempotent) and **never
   * closes it** (§6.1); `url`/`connection` are then ignored. Typed
   * structurally, so this package never names the optional peer.
   */
  client?: MongoClientLike;
  /** Options for the `MongoClient` the driver creates; ignored with `client`. */
  clientOptions?: Record<string, unknown>;
  /**
   * The database. Defaults to `connection.database`, then the URL's path,
   * then `bun_cache`.
   */
  database?: string;
  /**
   * Prepended to every collection name. Defaults to `bun_cache_`. Letters,
   * digits, `_`, `.` and `-`, starting with a letter or `_`, at most 100
   * characters; anything else throws.
   */
  prefix?: string;
  /**
   * Exact collection names, for an existing database that was not named here
   * (as bun-jobs' MongoDB driver takes them): `{ entries: "app_cache" }`.
   * Given as-is, so a name set this way ignores `prefix`; the collections
   * not named keep `<prefix><collection>`. Each must be letters, digits,
   * `_`, `.` and `-`, starting with a letter or `_`, not `system.…`, at most
   * 120 characters, and no two may share a name; anything else throws.
   */
  collections?: Partial<Record<MongoCacheCollection, string>>;
  /**
   * Run {@link CacheDriver.syncSchema} on connect, after the indexes are
   * created: `true` with the default options, or the options to pass. Off by
   * default. Connecting already creates every missing index, so what this
   * adds is the retirement of indexes earlier versions created — **a no-op
   * until the schema first changes** (there are none to retire today). Its
   * report is not returned by `connect()`; call `syncSchema({ dryRun: true })`
   * to read one.
   */
  syncSchema?: boolean | SchemaSyncOptions;
  /**
   * At most this many entries across every namespace in the collection
   * (§3.9). No cap by default: the database is sized by its operator.
   * Enforced by `sweep` — so between sweeps the collection can briefly exceed
   * it — and at most the sweep's `limit` evictions per pass. The victims are
   * the entries **nearest to expiry first**, then those with no expiry,
   * oldest write first; each is reported as an `evict` event (reason
   * `"cap"`). Counters are never counted or evicted (one would silently reset
   * a rate-limit window, §3.8). Two processes sweeping at once take turns
   * through a lock document. Each pass counts and sorts the collection
   * without an index of its own, so it costs a scan: size the sweep interval
   * accordingly. A positive integer.
   */
  maxEntries?: number;
  /**
   * The size of the capped `bus` collection in bytes, when the driver creates
   * it (an existing one keeps its size). Defaults to 16 MiB. A subscriber
   * that falls this far behind loses its place and reports a gap. At least
   * 4096.
   */
  busSize?: number;
  /** The clock, epoch ms. Internal: for tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Forces the bus's reading mode instead of choosing by the server
   * (`"change-stream"` on a replica set or `mongos`, `"tailable"` otherwise).
   * Internal: for tests, so both modes run against one replica set.
   */
  busMode?: BusMode;
}

/** A stored entry document. */
interface EntryDoc {
  /** The namespace and key. */
  _id: { ns: string; k: string };
  /** The value bytes; absent on a counter. Read back as a `Buffer` (`promoteBuffers`). */
  v?: Uint8Array;
  /** The counter's value; absent on an entry. */
  n?: number;
  /** The hard expiry; `null` never expires. */
  exp: Date | null;
  /** The entry's tags. */
  tags: string[];
  /** The write time, epoch ms. */
  ca: number;
  /** This write's id: the fence's compensation and the cap delete only the version they saw. */
  w?: string;
}

/** A stored tag stamp. */
interface StampDoc {
  /** The namespace and tag. */
  _id: { ns: string; tag: string };
  /** When the tag was invalidated, epoch ms. */
  at: number;
  /** Until when the stamp is kept. */
  exp: Date;
}

/** A held lock. */
interface LockDoc {
  /** The namespace and key. */
  _id: { ns: string; k: string };
  /** Who holds it. */
  owner: string;
  /** When it lapses. */
  exp: Date;
}

/** A bus document. */
interface BusDoc {
  /** A random id, so a publish is an upsert that can stamp a server timestamp. */
  _id: string;
  /** The server's timestamp at the write: orders the tailing cursor. */
  ts?: unknown;
  /** The message; absent on the sentinel that keeps the collection non-empty. */
  m?: BusMessage;
}

/** A live bus subscription. */
interface Subscription {
  /** Set by unsubscribe or close. */
  stopped: boolean;
  /** The stream or cursor currently open. */
  source: { close: () => Promise<void> } | undefined;
  /** The read loop, resolving when it has stopped. */
  loop: Promise<void>;
}

/** The MongoDB driver. See the module header. */
export class MongoCacheDriver implements CacheDriver {
  readonly name = "mongodb";
  /** Every primitive, the fence by check-then-write, a pushed bus (§7.10). */
  readonly capabilities: CacheDriverCapabilities = {
    multiProcess: true,
    ttl: "native",
    atomicIncrement: true,
    lock: true,
    tags: "index",
    fence: "check-then-write",
    bus: "push",
    // 16 MiB documents, less room for the key, tags and fields; replaced on
    // connect by the server's own `maxBsonObjectSize` less the same margin.
    maxEntryBytes: 16 * 1024 * 1024 - 64 * 1024,
  };

  /** The database the collections live in. */
  readonly database: string;
  /** The resolved collection names. */
  readonly collections: Record<MongoCacheCollection, string>;

  /** The connection URL, when the driver builds its own client. */
  readonly #url: string | undefined;
  /** Options for that client. */
  readonly #clientOptions: Record<string, unknown> | undefined;
  /** Whether the client is the driver's own, so `close()` closes it. */
  readonly #ownsClient: boolean;
  /** The client, once built or given. */
  #client: MongoClientLike | undefined;
  /** The connect in flight or done; reset when it fails. */
  #ready: Promise<DbLike> | undefined;
  /** Set once `close()` ran. */
  #closed = false;
  /** The `syncSchema` option. */
  readonly #syncOnConnect: boolean | SchemaSyncOptions;
  /** The `maxEntries` cap. */
  readonly #maxEntries: number | undefined;
  /** The capped bus collection's size when created. */
  readonly #busSize: number;
  /** A forced bus mode (tests). */
  readonly #forcedBusMode: BusMode | undefined;
  /** The bus mode chosen on connect. */
  #busMode: BusMode = "tailable";
  /** The bus collection's creation, once per instance. */
  #busReady: Promise<CollectionLike<BusDoc>> | undefined;
  /** The clock. */
  readonly #now: () => number;
  /** Live subscriptions, so `close()` can stop them. */
  readonly #subscriptions = new Set<Subscription>();
  /** The `onEviction` listeners. */
  readonly #evictListeners: ((
    ns: string,
    key: string,
    reason: string,
  ) => void)[] = [];

  constructor(options: MongoDriverOptions) {
    const what = "mongoDriver";
    const prefix = options.prefix ?? DEFAULT_MONGO_PREFIX;
    if (
      typeof prefix !== "string" ||
      !COLLECTION_NAME.test(prefix) ||
      prefix.length > 100 ||
      prefix.startsWith("system.")
    ) {
      throw new TypeError(
        `${what}: prefix must be letters, digits, _, . and -, starting with a letter or _, at most 100 characters; got ${JSON.stringify(prefix)}`,
      );
    }
    this.collections = resolveMongoCollections(
      what,
      prefix,
      options.collections,
    );
    const { maxEntries, busSize } = options;
    if (
      maxEntries !== undefined &&
      !(Number.isSafeInteger(maxEntries) && maxEntries > 0)
    ) {
      throw new TypeError(
        `${what}: maxEntries must be a positive integer, got ${String(maxEntries)}`,
      );
    }
    if (
      busSize !== undefined &&
      !(Number.isSafeInteger(busSize) && busSize >= 4096)
    ) {
      throw new TypeError(
        `${what}: busSize must be an integer of at least 4096 bytes, got ${String(busSize)}`,
      );
    }
    this.#maxEntries = maxEntries;
    this.#busSize = busSize ?? DEFAULT_MONGO_BUS_SIZE;
    this.#forcedBusMode = options.busMode;
    this.#syncOnConnect = options.syncSchema ?? false;
    this.#now = options.now ?? Date.now;
    this.#ownsClient = options.client === undefined;
    this.#client = options.client;
    this.#clientOptions = options.clientOptions;
    this.#url =
      options.client === undefined
        ? resolveConnectionUrl(
            options,
            {
              scheme: "mongodb",
              tlsScheme: "mongodb+srv",
              host: "127.0.0.1",
              port: 27017,
            },
            "The MongoDB cache driver",
          )
        : undefined;
    const fromConnection = options.connection?.database;
    this.database =
      options.database ??
      (typeof fromConnection === "string" ? fromConnection : undefined) ??
      (this.#url === undefined ? undefined : databaseFromUrl(this.#url)) ??
      DEFAULT_MONGO_DATABASE;
  }

  /* ---------------------------------------------------------------- */
  /* lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  /** Connects and creates the indexes, once per instance; a failure is not remembered. */
  async connect(): Promise<void> {
    await this.#db();
  }

  /** The database, connecting on first use. */
  async #db(): Promise<DbLike> {
    if (this.#closed) {
      throw new Error("the mongodb cache driver is closed");
    }
    this.#ready ??= this.#open();
    try {
      return await this.#ready;
    } catch (error) {
      this.#ready = undefined;
      throw error;
    }
  }

  async #open(): Promise<DbLike> {
    if (this.#client === undefined) {
      let MongoClient: MongoClientConstructor;
      try {
        // A `string`-typed specifier, so the compiler does not resolve it: a
        // literal `import("mongodb")` is a TS2307 site for a consumer
        // without the optional peer, just as a static import is. Both export
        // shapes, since no literal means no CommonJS interop analysis.
        const specifier: string = "mongodb";
        const loaded = (await import(specifier)) as {
          MongoClient?: MongoClientConstructor;
          default?: { MongoClient?: MongoClientConstructor };
        };
        const constructor = loaded.MongoClient ?? loaded.default?.MongoClient;
        if (typeof constructor !== "function") {
          throw new TypeError("mongodb did not export MongoClient");
        }
        MongoClient = constructor;
      } catch (error) {
        throw new Error(
          'The MongoDB cache driver needs the "mongodb" package (an optional peer): install it with `bun add mongodb`',
          { cause: error },
        );
      }
      this.#client = new MongoClient(this.#url!, this.#clientOptions);
    }
    await this.#client.connect();
    // The one place the database is obtained, and so the one place its
    // internal shape is asserted (see MongoClientLike).
    const db = this.#client.db(this.database) as DbLike;
    const hello = await db.command({ hello: 1 });
    if (typeof hello.maxBsonObjectSize === "number") {
      this.capabilities.maxEntryBytes = hello.maxBsonObjectSize - 64 * 1024;
    }
    this.#busMode =
      this.#forcedBusMode ??
      (typeof hello.setName === "string" || hello.msg === "isdbgrid"
        ? "change-stream"
        : "tailable");
    await this.#createIndexes(db);
    if (this.#syncOnConnect !== false) {
      await this.migrateSchema(
        db,
        this.#syncOnConnect === true ? {} : this.#syncOnConnect,
      );
    }
    return db;
  }

  /**
   * Creates every index the driver defines. `createIndex` is idempotent, and
   * two processes creating the same one at once both succeed (the server
   * builds it once). An index of the same name with other options (a plain
   * `exp_1` someone made by hand) fails here, naming it.
   */
  async #createIndexes(db: DbLike): Promise<void> {
    for (const index of INDEXES) {
      const collection = db.collection(
        this.collections[index.collection],
        COLLECTION_OPTIONS,
      );
      try {
        await collection.createIndex(
          index.key,
          index.ttl === undefined ? {} : { expireAfterSeconds: index.ttl },
        );
      } catch (error) {
        throw new Error(
          `The MongoDB cache driver could not create the index ${indexName(index.key)} on ${this.collections[index.collection]}: ${(error as Error).message}. An index of that name with other options (one made by hand) must be dropped first.`,
          { cause: error },
        );
      }
    }
  }

  /** Stops every subscription and closes the client when it is the driver's own. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const subscriptions = [...this.#subscriptions];
    this.#subscriptions.clear();
    await Promise.all(
      subscriptions.map(async (subscription) => {
        await this.#stop(subscription);
      }),
    );
    if (this.#ownsClient && this.#client !== undefined) {
      await this.#client.close();
    }
    this.#client = undefined;
    this.#ready = undefined;
  }

  /** One round trip. */
  async ping(): Promise<void> {
    await (await this.#db()).command({ ping: 1 });
  }

  /** A collection, read from the primary. */
  async #collection<TDoc>(
    which: MongoCacheCollection,
  ): Promise<CollectionLike<TDoc>> {
    return (await this.#db()).collection<TDoc>(
      this.collections[which],
      COLLECTION_OPTIONS,
    );
  }

  /* ---------------------------------------------------------------- */
  /* schema                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Creates every missing index and drops the retired ones — only names on
   * `RETIRED_INDEXES` — and reports each change; `dryRun` reports without
   * applying. MongoDB has no column types, so nothing here rewrites a
   * collection, and every change is non-blocking (index builds are online).
   * `[]` until the schema first changes: connecting already creates the
   * indexes, and none is retired.
   */
  async syncSchema(options: SchemaSyncOptions = {}): Promise<SchemaChange[]> {
    return await this.migrateSchema(await this.#db(), options);
  }

  /**
   * The sync on a database already open (connect runs it, and must not wait
   * on itself). Internal: `protected` so a test can see that connect runs it,
   * as the SQL drivers' `migrateSchema`.
   */
  protected async migrateSchema(
    db: DbLike,
    options: SchemaSyncOptions,
  ): Promise<SchemaChange[]> {
    const existing = new Map<string, Set<string>>();
    for (const which of MONGO_CACHE_COLLECTIONS) {
      const name = this.collections[which];
      existing.set(
        name,
        await db
          .collection(name, COLLECTION_OPTIONS)
          .indexes()
          .then(
            (found) => new Set(found.map((index) => String(index.name))),
            // A collection that does not exist yet has no indexes.
            () => new Set<string>(),
          ),
      );
    }
    const changes: (SchemaChange & { apply: () => Promise<unknown> })[] = [];
    for (const index of INDEXES) {
      const collection = this.collections[index.collection];
      const name = indexName(index.key);
      if (existing.get(collection)?.has(name)) {
        continue;
      }
      changes.push({
        description: `create index ${name} on ${collection}`,
        applied: false,
        blocking: false,
        apply: async () =>
          await db
            .collection(collection, COLLECTION_OPTIONS)
            .createIndex(
              index.key,
              index.ttl === undefined ? {} : { expireAfterSeconds: index.ttl },
            ),
      });
    }
    for (const retired of RETIRED_INDEXES) {
      const collection = this.collections[retired.collection];
      if (!existing.get(collection)?.has(retired.name)) {
        continue;
      }
      changes.push({
        description: `drop retired index ${retired.name} on ${collection}`,
        applied: false,
        blocking: false,
        apply: async () =>
          await db
            .collection(collection, COLLECTION_OPTIONS)
            .dropIndex(retired.name),
      });
    }
    const report: SchemaChange[] = [];
    for (const { apply, ...change } of changes) {
      if (options.dryRun !== true) {
        await apply();
        change.applied = true;
      }
      report.push(change);
    }
    return report;
  }

  /* ---------------------------------------------------------------- */
  /* entries                                                           */
  /* ---------------------------------------------------------------- */

  /** The filter half that keeps only what has not expired. */
  #live(now = this.#now()): DocLike {
    return { $or: [{ exp: null }, { exp: { $gt: new Date(now) } }] };
  }

  /** Decodes an entry document for the caller's key. */
  static #toEntry(key: string, doc: EntryDoc): StoredEntry {
    const v = doc.v ?? new Uint8Array(0);
    return {
      key,
      // A plain Uint8Array over the client's Buffer: the contract's type.
      value: new Uint8Array(v.buffer, v.byteOffset, v.byteLength),
      expiresAt: doc.exp === null ? null : doc.exp.getTime(),
      tags: doc.tags ?? [],
    };
  }

  async get(ns: string, key: string): Promise<StoredEntry | undefined> {
    const entries = await this.#collection<EntryDoc>("entries");
    const doc = await entries.findOne(
      { _id: { ns, k: key }, v: { $exists: true }, ...this.#live() },
      { promoteBuffers: true },
    );
    return doc === null ? undefined : MongoCacheDriver.#toEntry(key, doc);
  }

  async getMany(
    ns: string,
    keys: readonly string[],
  ): Promise<(StoredEntry | undefined)[]> {
    if (keys.length === 0) {
      return [];
    }
    const entries = await this.#collection<EntryDoc>("entries");
    const docs = await entries
      .find(
        {
          _id: { $in: keys.map((k) => ({ ns, k })) },
          v: { $exists: true },
          ...this.#live(),
        },
        { promoteBuffers: true },
      )
      .toArray();
    const byKey = new Map(docs.map((doc) => [doc._id.k, doc] as const));
    return keys.map((key) => {
      const doc = byKey.get(key);
      return doc === undefined
        ? undefined
        : MongoCacheDriver.#toEntry(key, doc);
    });
  }

  /** The document a `set` writes. */
  #entryDoc(ns: string, entry: StoredEntry, w: string): EntryDoc {
    return {
      _id: { ns, k: entry.key },
      v: entry.value,
      exp: entry.expiresAt === null ? null : new Date(entry.expiresAt),
      tags: [...new Set(entry.tags)],
      ca: this.#now(),
      w,
    };
  }

  /** Whether any of `tags` was invalidated at or after `createdAt` (a stamp at the load's own millisecond counts, §3.6). */
  async #stampedSince(ns: string, fence: TagFence): Promise<boolean> {
    const stamps = await this.getStamps(ns, fence.tags);
    for (const at of stamps.values()) {
      if (at >= fence.createdAt) {
        return true;
      }
    }
    return false;
  }

  async set(
    ns: string,
    entry: StoredEntry,
    fence?: TagFence,
  ): Promise<"stored" | "fenced"> {
    const entries = await this.#collection<EntryDoc>("entries");
    const fencing = fence !== undefined && fence.tags.length > 0;
    if (fencing && (await this.#stampedSince(ns, fence))) {
      return "fenced";
    }
    const w = crypto.randomUUID();
    const doc = this.#entryDoc(ns, entry, w);
    await upsertRetrying(
      async () =>
        await entries.replaceOne({ _id: doc._id }, doc, { upsert: true }),
    );
    if (fencing && (await this.#stampedSince(ns, fence))) {
      // An invalidation of one of its tags landed between the check and the
      // write: take this write back — only this one, never a newer write.
      await entries.deleteOne({ _id: doc._id, w });
      return "fenced";
    }
    return "stored";
  }

  /** Writes several entries in one round trip (no fence: bulk writes come from `setMany`, not from loads). */
  async setMany(ns: string, entries: readonly StoredEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const collection = await this.#collection<EntryDoc>("entries");
    await upsertRetrying(
      async () =>
        await collection.bulkWrite(
          entries.map((entry) => {
            const doc = this.#entryDoc(ns, entry, crypto.randomUUID());
            return {
              replaceOne: {
                filter: { _id: doc._id },
                replacement: doc,
                upsert: true,
              },
            };
          }),
          { ordered: true },
        ),
    );
  }

  async delete(ns: string, keys: readonly string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }
    const entries = await this.#collection<EntryDoc>("entries");
    const result = await entries.deleteMany({
      _id: { $in: keys.map((k) => ({ ns, k })) },
    });
    return result.deletedCount;
  }

  async clear(ns: string): Promise<void> {
    const entries = await this.#collection<EntryDoc>("entries");
    await entries.deleteMany({ "_id.ns": ns });
  }

  async touch(
    ns: string,
    key: string,
    expiresAt: number | null,
  ): Promise<boolean> {
    const entries = await this.#collection<EntryDoc>("entries");
    const result = await entries.updateOne(
      { _id: { ns, k: key }, ...this.#live() },
      { $set: { exp: expiresAt === null ? null : new Date(expiresAt) } },
    );
    return result.matchedCount > 0;
  }

  /* ---------------------------------------------------------------- */
  /* tags                                                              */
  /* ---------------------------------------------------------------- */

  async deleteByTags(
    ns: string,
    tags: readonly string[],
    stampUntil: number,
  ): Promise<number> {
    if (tags.length === 0) {
      return 0;
    }
    // The stamps first, the delete second: the fence's re-check relies on
    // that order (see the module header).
    await this.setStamps(ns, tags, this.#now(), stampUntil);
    const entries = await this.#collection<EntryDoc>("entries");
    const result = await entries.deleteMany({
      "_id.ns": ns,
      tags: { $in: [...tags] },
      v: { $exists: true },
    });
    return result.deletedCount;
  }

  async getStamps(
    ns: string,
    tags: readonly string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (tags.length === 0) {
      return out;
    }
    const stamps = await this.#collection<StampDoc>("stamps");
    const docs = await stamps
      .find({
        _id: { $in: [...new Set(tags)].map((tag) => ({ ns, tag })) },
        exp: { $gt: new Date(this.#now()) },
      })
      .toArray();
    for (const doc of docs) {
      out.set(doc._id.tag, doc.at);
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
    const stamps = await this.#collection<StampDoc>("stamps");
    await upsertRetrying(
      async () =>
        await stamps.bulkWrite(
          [...new Set(tags)].map((tag) => ({
            updateOne: {
              filter: { _id: { ns, tag } },
              update: { $set: { at, exp: new Date(until) } },
              upsert: true,
            },
          })),
          { ordered: false },
        ),
    );
  }

  /* ---------------------------------------------------------------- */
  /* counters                                                          */
  /* ---------------------------------------------------------------- */

  async increment(
    ns: string,
    key: string,
    by: number,
    expiresAt: number | null,
  ): Promise<number> {
    if (!Number.isSafeInteger(by)) {
      throw new TypeError(
        `MongoDB cache counters are integers; cannot add ${by}`,
      );
    }
    const entries = await this.#collection<EntryDoc>("entries");
    const now = this.#now();
    // A live counter: `n` is a number and `exp` has not passed. Anything
    // else under the key — nothing, an entry, an expired counter — is
    // replaced by a new counter, whose expiry is set now and never again.
    const live = {
      $and: [
        { $in: [{ $type: "$n" }, ["int", "long", "double", "decimal"]] },
        {
          $or: [
            { $eq: [{ $ifNull: ["$exp", null] }, null] },
            { $gt: ["$exp", new Date(now)] },
          ],
        },
      ],
    };
    const fresh = {
      _id: "$_id",
      n: { $literal: by },
      exp: { $literal: expiresAt === null ? null : new Date(expiresAt) },
      tags: { $literal: [] },
      ca: { $literal: now },
    };
    const doc = await upsertRetrying(
      async () =>
        await entries.findOneAndUpdate(
          { _id: { ns, k: key } },
          [
            {
              $replaceWith: {
                $cond: [
                  live,
                  { $mergeObjects: ["$$ROOT", { n: { $add: ["$n", by] } }] },
                  fresh,
                ],
              },
            },
          ],
          { upsert: true, returnDocument: "after" },
        ),
    );
    return Number(doc!.n);
  }

  async getCounter(
    ns: string,
    key: string,
  ): Promise<
    { value: number; expiresAt: number | null; createdAt: number } | undefined
  > {
    const entries = await this.#collection<EntryDoc>("entries");
    const doc = await entries.findOne({
      _id: { ns, k: key },
      n: { $exists: true },
      v: { $exists: false },
      ...this.#live(),
    });
    return doc === null
      ? undefined
      : {
          value: Number(doc.n),
          expiresAt: doc.exp === null ? null : doc.exp.getTime(),
          createdAt: doc.ca,
        };
  }

  /* ---------------------------------------------------------------- */
  /* locks                                                             */
  /* ---------------------------------------------------------------- */

  async acquireLock(
    ns: string,
    key: string,
    owner: string,
    ttlMs: number,
  ): Promise<boolean> {
    const locks = await this.#collection<LockDoc>("locks");
    const now = this.#now();
    try {
      // Taken when absent, lapsed, or already ours (a re-acquire refreshes
      // it). Held by another, the filter matches nothing and the upsert's
      // insert collides on `_id`.
      await locks.findOneAndUpdate(
        {
          _id: { ns, k: key },
          $or: [{ exp: { $lte: new Date(now) } }, { owner }],
        },
        { $set: { owner, exp: new Date(now + ttlMs) } },
        { upsert: true },
      );
      return true;
    } catch (error) {
      if (codeOf(error) === DUPLICATE_KEY) {
        return false;
      }
      throw error;
    }
  }

  async releaseLock(ns: string, key: string, owner: string): Promise<boolean> {
    const locks = await this.#collection<LockDoc>("locks");
    const result = await locks.deleteOne({ _id: { ns, k: key }, owner });
    return result.deletedCount > 0;
  }

  /* ---------------------------------------------------------------- */
  /* sweep and the cap                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * Deletes up to `limit` expired entries (the TTL index takes the rest, and
   * the stamps and locks, within its minute), then enforces `maxEntries`.
   * Answers how many expired entries went.
   */
  async sweep(now: number, limit: number): Promise<number> {
    const entries = await this.#collection<EntryDoc>("entries");
    const expired = { exp: { $lte: new Date(now) } };
    const ids = await entries
      .find(expired, { projection: { _id: 1 } })
      .limit(limit)
      .toArray();
    let removed = 0;
    if (ids.length > 0) {
      removed = (
        await entries.deleteMany({
          _id: { $in: ids.map((doc) => doc._id) },
          ...expired,
        })
      ).deletedCount;
    }
    const victims = await this.#evictToCap(entries, limit);
    for (const victim of victims) {
      for (const listener of this.#evictListeners) {
        listener(victim.ns, victim.k, "cap");
      }
    }
    return removed;
  }

  /**
   * The `maxEntries` cap (§3.9), with `entry-cap.ts`'s semantics: count the
   * entries (not counters), evict the excess — at most `limit` — nearest to
   * expiry first (`exp`, then `ca`, `ns`, `k`), then the unexpiring ones
   * oldest write first (`ca`, `ns`, `k`). Each victim is deleted only if it
   * is still the write that was chosen (`w`), so a key rewritten meanwhile
   * stays, and only what was deleted is answered. Two processes take turns
   * through a lock document, so the second counts after the first deleted
   * and never evicts the same excess twice.
   */
  async #evictToCap(
    entries: CollectionLike<EntryDoc>,
    limit: number,
  ): Promise<{ ns: string; k: string }[]> {
    const maxEntries = this.#maxEntries;
    if (maxEntries === undefined) {
      return [];
    }
    const owner = crypto.randomUUID();
    const deadline = this.#now() + 10_000;
    while (
      !(await this.acquireLock(CAP_LOCK_NAMESPACE, "cap", owner, 30_000))
    ) {
      if (this.#now() > deadline) {
        // Another process has been sweeping for ten seconds: it enforces the
        // cap; this pass leaves it to it.
        return [];
      }
      await Bun.sleep(10);
    }
    try {
      const isEntry = { v: { $exists: true } };
      let excess = entryCapExcess(
        await entries.countDocuments(isEntry),
        maxEntries,
        limit,
      );
      const victims: { ns: string; k: string }[] = [];
      const phases: [DocLike, Record<string, 1 | -1>][] = [
        [
          { ...isEntry, exp: { $ne: null } },
          { exp: 1, ca: 1, "_id.ns": 1, "_id.k": 1 },
        ],
        [
          { ...isEntry, exp: null },
          { ca: 1, "_id.ns": 1, "_id.k": 1 },
        ],
      ];
      for (const [filter, order] of phases) {
        if (excess === 0) {
          break;
        }
        const chosen = await entries
          .find(filter, { projection: { _id: 1, w: 1 } })
          .sort(order)
          .limit(excess)
          .toArray();
        const deleted = await Promise.all(
          chosen.map(async (doc) =>
            (await entries.deleteOne({ _id: doc._id, w: doc.w ?? null }))
              .deletedCount > 0
              ? { ns: doc._id.ns, k: doc._id.k }
              : undefined,
          ),
        );
        for (const victim of deleted) {
          if (victim !== undefined) {
            victims.push(victim);
          }
        }
        excess -= chosen.length;
      }
      return victims;
    } finally {
      await this.releaseLock(CAP_LOCK_NAMESPACE, "cap", owner);
    }
  }

  /** Registers a listener for `maxEntries` evictions (reason `"cap"`); the core turns them into `evict` events. */
  onEviction(
    listener: (ns: string, key: string, reason: string) => void,
  ): void {
    this.#evictListeners.push(listener);
  }

  /* ---------------------------------------------------------------- */
  /* the bus (§4.2)                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * The capped bus collection, created on first use (a cache without L1
   * never makes one) with one sentinel document — a tailable cursor on an
   * empty capped collection is dead at once (measured). An existing
   * collection of that name must be capped.
   */
  async #bus(): Promise<CollectionLike<BusDoc>> {
    this.#busReady ??= (async () => {
      const db = await this.#db();
      const name = this.collections.bus;
      try {
        await db.createCollection(name, { capped: true, size: this.#busSize });
      } catch (error) {
        if (codeOf(error) !== NAMESPACE_EXISTS) {
          throw error;
        }
        const [info] = await db.listCollections({ name }).toArray();
        if (info?.options?.capped !== true) {
          throw new Error(
            `The MongoDB cache driver's bus collection ${name} exists and is not capped; drop it, or name another with collections.bus`,
            { cause: error },
          );
        }
      }
      const bus = db.collection<BusDoc>(name, COLLECTION_OPTIONS);
      await this.#ensureSentinel(bus);
      return bus;
    })();
    try {
      return await this.#busReady;
    } catch (error) {
      this.#busReady = undefined;
      throw error;
    }
  }

  /** Writes a sentinel into an empty bus collection (two at once is harmless). */
  async #ensureSentinel(bus: CollectionLike<BusDoc>): Promise<void> {
    if ((await bus.findOne({})) === null) {
      await bus.updateOne(
        { _id: `sentinel:${crypto.randomUUID()}` },
        { $currentDate: { ts: { $type: "timestamp" } } },
        { upsert: true },
      );
    }
  }

  async publish(message: BusMessage): Promise<void> {
    const bus = await this.#bus();
    // As it is, every field included (`origin` too), with nothing undefined:
    // what JSON keeps, BSON keeps.
    let json = JSON.stringify(message);
    if (json.length > MAX_BUS_MESSAGE_BYTES) {
      // Too many keys for one message: every subscriber drops the whole
      // namespace instead, which is always a safe reading of "these changed".
      // The origin stays, so the publisher still skips its own message.
      const flush: BusMessage = {
        type: "clear",
        namespace: message.namespace,
        at: message.at,
        ...(message.origin === undefined ? {} : { origin: message.origin }),
      };
      json = JSON.stringify(flush);
    }
    const m = JSON.parse(json) as BusMessage;
    // An upsert rather than an insert, so the server stamps the document with
    // its own increasing timestamp — what a tailing cursor positions by.
    await bus.updateOne(
      { _id: crypto.randomUUID() },
      { $setOnInsert: { m }, $currentDate: { ts: { $type: "timestamp" } } },
      { upsert: true },
    );
  }

  async subscribe(
    onMessage: (message: BusMessage) => void,
    onGap: () => void,
  ): Promise<() => Promise<void>> {
    const bus = await this.#bus();
    const subscription: Subscription = {
      stopped: false,
      source: undefined,
      loop: Promise.resolve(),
    };
    /** Hands a bus document's message to the subscriber, unless it is the sentinel, not a message, or the subscription stopped. */
    const deliver = (doc: BusDoc | null | undefined): void => {
      const m = doc?.m as Partial<BusMessage> | null | undefined;
      if (
        subscription.stopped ||
        typeof m !== "object" ||
        m === null ||
        typeof m.type !== "string" ||
        typeof m.namespace !== "string"
      ) {
        return;
      }
      // Delivered as it was published: publish stored every field and
      // nothing undefined.
      onMessage(m as BusMessage);
    };
    // Positioned here, before subscribe resolves, so a message published
    // after it is never missed.
    const first =
      this.#busMode === "change-stream"
        ? await this.#openStream(bus)
        : await this.#openTail(bus, undefined);
    subscription.source = first.source;
    subscription.loop = this.#readLoop(
      bus,
      subscription,
      first,
      deliver,
      onGap,
    );
    this.#subscriptions.add(subscription);
    return async () => {
      if (this.#subscriptions.delete(subscription)) {
        await this.#stop(subscription);
      }
    };
  }

  /** Stops a subscription and waits for its loop. */
  async #stop(subscription: Subscription): Promise<void> {
    subscription.stopped = true;
    await subscription.source?.close().catch(() => undefined);
    await subscription.loop;
  }

  /**
   * Opens a change stream on the bus collection: from `from` (where a lost
   * stream had got to, its {@link BusSource.resumeFrom}), or else at the
   * server's operation time now — so a message published once `subscribe`
   * has resolved is in it, however long the stream takes to establish. The
   * client itself resumes across the errors it labels resumable.
   */
  async #openStream(
    bus: CollectionLike<BusDoc>,
    from?: DocLike,
  ): Promise<BusSource> {
    let start = from;
    if (start === undefined) {
      const { operationTime } = await (await this.#db()).command({ ping: 1 });
      start =
        operationTime === undefined
          ? {}
          : { startAtOperationTime: operationTime };
    }
    const stream = bus.watch(
      [
        {
          $match: {
            operationType: "insert",
            "fullDocument.m": { $exists: true },
          },
        },
      ],
      { maxAwaitTimeMS: BUS_AWAIT_MS, ...start },
    );
    // Where this stream has got to: the token of the last change or batch it
    // answered, else the point it opened at. A read that fails still reads
    // the token, since one read is the aggregate and a getMore together: when
    // the getMore fails, the aggregate's batch token is already there.
    let token: unknown;
    const opened = Object.keys(start).length === 0 ? undefined : start;
    return {
      source: stream,
      next: async () => {
        try {
          const change = await stream.tryNext();
          return change === null
            ? stream.closed
              ? "closed"
              : null
            : (change.fullDocument as BusDoc);
        } finally {
          token = stream.resumeToken ?? token;
        }
      },
      lastTs: () => undefined,
      resumeFrom: () => (token === undefined ? opened : { resumeAfter: token }),
    };
  }

  /**
   * Opens a tailable, awaitData cursor on the capped bus collection over the
   * documents after `after` (the last timestamp read) or, for a new
   * subscription, after the newest document there now. Positioned by that
   * filter, the cursor misses nothing published once this has answered,
   * however long its first `find` takes.
   */
  async #openTail(
    bus: CollectionLike<BusDoc>,
    after: unknown,
  ): Promise<BusSource> {
    let from = after;
    if (from === undefined) {
      const [newest] = await bus
        .find({}, { projection: { ts: 1 } })
        .sort({ $natural: -1 })
        .limit(1)
        .toArray();
      from = newest?.ts;
    }
    let lastTs = from;
    const cursor = bus.find(from === undefined ? {} : { ts: { $gt: from } }, {
      tailable: true,
      awaitData: true,
      maxAwaitTimeMS: BUS_AWAIT_MS,
    });
    return {
      source: cursor,
      next: async () => {
        const doc = await cursor.tryNext();
        if (doc === null) {
          return cursor.closed ? "closed" : null;
        }
        lastTs = doc.ts ?? lastTs;
        return doc;
      },
      lastTs: () => lastTs,
      resumeFrom: () => undefined,
    };
  }

  /**
   * Reads a subscription's source until it stops; when the source is lost,
   * reopens it and reports a gap — except a tailing cursor that finds every
   * document after its last one still there (a network blip, or the cursor
   * killed with nothing overwritten).
   */
  async #readLoop(
    bus: CollectionLike<BusDoc>,
    subscription: Subscription,
    first: BusSource,
    deliver: (doc: BusDoc | null | undefined) => void,
    onGap: () => void,
  ): Promise<void> {
    let current = first;
    let backoff = 10;
    while (!subscription.stopped) {
      let lost: unknown;
      try {
        for (;;) {
          const doc = await current.next();
          if (subscription.stopped) {
            return;
          }
          if (doc === "closed") {
            break;
          }
          deliver(doc);
        }
      } catch (error) {
        lost = error;
      }
      if (subscription.stopped) {
        return;
      }
      await current.source.close().catch(() => undefined);
      // Reopen, then decide whether anything may have been missed.
      for (;;) {
        if (subscription.stopped) {
          return;
        }
        try {
          if (this.#busMode === "change-stream") {
            // Resumed from where it had read when the loss can be resumed
            // (a killed cursor, a dropped connection): nothing is missed.
            // When it cannot — the history is gone, the token is unusable,
            // the stream was invalidated (its collection dropped) — the
            // stream starts again from now, and the stretch between is a gap.
            // A stream lost before its first read answered resumes from the
            // point it opened at.
            const from = current.resumeFrom();
            const resumable =
              lost !== undefined &&
              from !== undefined &&
              !CHANGE_STREAM_FATAL.has(codeOf(lost) ?? 0);
            current = await this.#openStream(bus, resumable ? from : undefined);
            subscription.source = current.source;
            if (!resumable) {
              onGap();
            }
          } else {
            const after = current.lastTs();
            // A dropped collection is recreated (with its sentinel).
            this.#busReady = undefined;
            const fresh = await this.#bus();
            const missed =
              codeOf(lost) === CAPPED_POSITION_LOST ||
              !(await this.#stillHolds(fresh, after));
            current = await this.#openTail(fresh, after);
            subscription.source = current.source;
            if (missed) {
              onGap();
            }
          }
          backoff = 10;
          break;
        } catch {
          await Bun.sleep(backoff);
          backoff = Math.min(backoff * 2, 1_000);
        }
      }
    }
  }

  /**
   * Whether the capped collection still holds everything after `after`: its
   * oldest document is at or before it. Otherwise documents after it may
   * have been overwritten (or the collection was dropped and recreated).
   */
  async #stillHolds(
    bus: CollectionLike<BusDoc>,
    after: unknown,
  ): Promise<boolean> {
    if (after === undefined) {
      return false;
    }
    const holds = await bus.findOne({ ts: { $lte: after } });
    return holds !== null;
  }
}

/** One open bus source: a change stream or a tailing cursor. */
interface BusSource {
  /** What to close to stop it. */
  source: { close: () => Promise<void> };
  /** The next document, `null` for an empty wait, `"closed"` once the source is dead. */
  next: () => Promise<BusDoc | null | "closed">;
  /** The tailing cursor's last timestamp read (`undefined` for a change stream). */
  lastTs: () => unknown;
  /**
   * Where a change stream resumes from: `{ resumeAfter }` with the token of
   * the last change or batch it answered, else the `startAtOperationTime` it
   * opened at. `undefined` for a tailing cursor, or a stream opened with
   * neither.
   */
  resumeFrom: () => DocLike | undefined;
}

/**
 * Runs an upsert, retrying a duplicate-key error a few times: two upserts of
 * one new `_id` can both miss and both insert, and the loser fails with
 * E11000 (the server retries most of these itself; this covers the rest).
 */
async function upsertRetrying<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= 5 || codeOf(error) !== DUPLICATE_KEY) {
        throw error;
      }
    }
  }
}

/**
 * Resolves the collection names: `collections[name]` when given, else
 * `<prefix><name>`. Throws a `TypeError` (naming `what`) for an unknown key,
 * a name that is not a plain collection name or is longer than 120
 * characters, a `system.` name, or two collections sharing a name.
 */
export function resolveMongoCollections(
  what: string,
  prefix: string,
  collections: Partial<Record<string, string>> | undefined,
): Record<MongoCacheCollection, string> {
  for (const key of Object.keys(collections ?? {})) {
    if (!(MONGO_CACHE_COLLECTIONS as readonly string[]).includes(key)) {
      throw new TypeError(
        `${what}: collections.${key} is not a collection name (${MONGO_CACHE_COLLECTIONS.join(", ")})`,
      );
    }
  }
  const resolved = {} as Record<MongoCacheCollection, string>;
  const seen = new Map<string, MongoCacheCollection>();
  for (const which of MONGO_CACHE_COLLECTIONS) {
    const given = collections?.[which];
    const name = given ?? `${prefix}${which}`;
    if (
      given !== undefined &&
      (typeof given !== "string" ||
        !COLLECTION_NAME.test(given) ||
        given.length > MAX_COLLECTION_NAME_LENGTH ||
        given.startsWith("system."))
    ) {
      throw new TypeError(
        `${what}: collections.${which} must be letters, digits, _, . and -, starting with a letter or _, not system.…, at most ${MAX_COLLECTION_NAME_LENGTH} characters; got ${JSON.stringify(given)}`,
      );
    }
    const clash = seen.get(name);
    if (clash !== undefined) {
      throw new TypeError(
        `${what}: collections ${clash} and ${which} would both be ${JSON.stringify(name)}`,
      );
    }
    seen.set(name, which);
    resolved[which] = name;
  }
  return resolved;
}

/** A MongoDB driver (§7.6). See {@link MongoCacheDriver} and {@link MongoDriverOptions}. */
export function mongoDriver(options: MongoDriverOptions): CacheDriver {
  return new MongoCacheDriver(options);
}
