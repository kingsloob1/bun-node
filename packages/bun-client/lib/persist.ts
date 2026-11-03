/**
 * `@kingsleyweb/bun-client/persist`: the query cache kept in IndexedDB
 * (typed-client plan §6.4, PR-C8). {@link idbPersister} is a persister for
 * query-core's own `persistQueryClient` (`@tanstack/query-persist-client-core`),
 * written against the platform's IndexedDB API, with no IndexedDB library:
 *
 * ```ts
 * import { persistQueryClient } from "@tanstack/query-persist-client-core";
 * import { idbPersister } from "@kingsleyweb/bun-client/persist";
 * import { typesHash } from "./api.gen";
 *
 * const [stop, restored] = persistQueryClient({
 *   queryClient,
 *   persister: idbPersister(),
 *   buster: typesHash,          // a schema change drops the persisted cache
 *   maxAge: 24 * 60 * 60_000,   // so does age
 * });
 * ```
 *
 * The **buster is the documents' hash**: `bun-client generate` writes it
 * into the route module as `typesHash`, the hash its header records and the
 * dev endpoint's `ETag` (bun-common's `typesHash`). A deployment whose
 * schemas changed regenerates the module, so its hash differs, and
 * `persistQueryClient` drops a cache persisted under the old one instead of
 * hydrating data of the old shape. Persisting is query-core's: what is
 * dehydrated (successful queries, by default), `maxAge`, and the restore.
 * React's `PersistQueryClientProvider` (`@tanstack/react-query-persist-client`)
 * takes the same persister and buster.
 *
 * - **Writes are throttled**: `persistQueryClient` saves on every cache
 *   event, so the latest cache is written at most once per `throttleTime`
 *   (1 s, as TanStack's own storage persisters). The last moments before a
 *   page closes can be lost, as with theirs.
 * - **Nothing rejects**: a failed open, read or write is given to `onError`
 *   and treated as no cache (a restore resolves `undefined`), so a quota or
 *   a value IndexedDB cannot clone never surfaces as an unhandled rejection
 *   from `persistQueryClient`'s subscription. Without IndexedDB (a server
 *   render, a test without one) every method does nothing.
 * - **One store, one key**: the cache is one record (`key`) in one object
 *   store of one database, all three options; another `QueryClient` takes
 *   another `key`. The database is opened on first use and closed when
 *   another tab asks to upgrade or delete it, then opened again on the next
 *   use.
 * - **Per-client state is not kept**: the query layer's ETags and response
 *   tags (`./query`) live beside the `QueryClient`, so a restored query's
 *   first fetch is unconditional and matches its declared `meta.tags` (which
 *   are dehydrated) until its first response brings its header tags.
 *
 * `@tanstack/query-persist-client-core` is an optional peer: this entry
 * imports only its types, and nothing else in the package imports this one.
 */
import type {
  PersistedClient,
  Persister,
} from "@tanstack/query-persist-client-core";

/* ------------------------------------------------------------------ */
/* The IndexedDB this persister uses                                    */
/* ------------------------------------------------------------------ */

// The subset of IndexedDB used here, written structurally: the package's
// own project has Bun's types and no DOM lib, and the browser's
// `IDBFactory` (or another implementation's) must fit it. Event handlers
// take `never` because their events are never read, which every DOM
// handler type accepts.

/** An IndexedDB request: its result once it succeeded. */
interface IdbRequest<T> {
  /** The request's result. */
  readonly result: T;
  /** Why it failed. */
  readonly error: Error | null;
  /** Called when it succeeds. */
  onsuccess: ((event: never) => unknown) | null;
  /** Called when it fails. */
  onerror: ((event: never) => unknown) | null;
}

/** An `indexedDB.open()` request. */
interface IdbOpenRequest extends IdbRequest<IdbDatabase> {
  /** Called when the database is new or its version is raised. */
  onupgradeneeded: ((event: never) => unknown) | null;
}

/** An open database. */
interface IdbDatabase {
  /** Its version. */
  readonly version: number;
  /** The names of its object stores. */
  readonly objectStoreNames: { contains: (name: string) => boolean };
  /** Creates an object store (in an upgrade only). */
  createObjectStore: (name: string) => unknown;
  /** Starts a transaction on one store. */
  transaction: (
    store: string,
    mode: "readonly" | "readwrite",
  ) => IdbTransaction;
  /** Closes the connection. */
  close: () => void;
  /** Called when another connection asks to upgrade or delete the database. */
  onversionchange: ((event: never) => unknown) | null;
  /** Called when the connection closes unexpectedly (storage cleared, say). */
  onclose: ((event: never) => unknown) | null;
}

/** A transaction: done once it completes. */
interface IdbTransaction {
  /** Its object store. */
  objectStore: (name: string) => IdbObjectStore;
  /** Why it failed or aborted. */
  readonly error: Error | null;
  /** Called when it commits. */
  oncomplete: ((event: never) => unknown) | null;
  /** Called when one of its requests fails. */
  onerror: ((event: never) => unknown) | null;
  /** Called when it aborts. */
  onabort: ((event: never) => unknown) | null;
}

/** An object store, with out-of-line keys. */
interface IdbObjectStore {
  /** Reads the record at `key`. */
  get: (key: string) => IdbRequest<unknown>;
  /** Writes `value` at `key` (a structured clone). */
  put: (value: unknown, key: string) => IdbRequest<unknown>;
  /** Deletes the record at `key`. */
  delete: (key: string) => IdbRequest<unknown>;
}

/** What opens databases: the browser's `indexedDB`, or another implementation's factory. */
interface IdbFactory {
  /** Opens (creating or upgrading) database `name`. */
  open: (name: string, version?: number) => IdbOpenRequest;
}

/* ------------------------------------------------------------------ */
/* Options                                                              */
/* ------------------------------------------------------------------ */

/** The options of {@link idbPersister}. */
export interface IdbPersisterOptions {
  /** The IndexedDB database. Default: `"bun-client"`. */
  database?: string;
  /**
   * The object store in it, created when missing (by raising the
   * database's version, so stores of other persisters stay). Default:
   * `"queries"`.
   */
  store?: string;
  /**
   * The record the cache is kept under: one per `QueryClient` sharing the
   * store. Default: `"client"`.
   */
  key?: string;
  /**
   * Writes at most once per this many ms, the latest cache winning
   * (`persistQueryClient` saves on every cache event). Default: `1_000`,
   * TanStack's storage persisters' `throttleTime`.
   */
  throttleTime?: number;
  /**
   * The IndexedDB to use. Default: `globalThis.indexedDB`, read on first
   * use; none makes every method a no-op (a server render).
   */
  indexedDB?: IdbFactory;
  /**
   * Called with the error of a failed open, read or write, which is
   * otherwise swallowed (a restore then resolves `undefined`). Default:
   * none.
   */
  onError?: (error: unknown) => void;
}

/* ------------------------------------------------------------------ */
/* The persister                                                        */
/* ------------------------------------------------------------------ */

/** Resolves once `transaction` commits; rejects with its error if it fails or aborts. */
function committed(transaction: IdbTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (): void =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.oncomplete = () => resolve();
    transaction.onerror = fail;
    transaction.onabort = fail;
  });
}

/**
 * A persister keeping a `QueryClient`'s dehydrated cache in IndexedDB, for
 * query-core's `persistQueryClient` (or React's `PersistQueryClientProvider`):
 * give it the generated module's `typesHash` as the `buster`, so a schema
 * change drops what was persisted (see the module's doc).
 *
 * The record is the `PersistedClient` itself, stored as a structured clone
 * (no JSON round trip). A value IndexedDB cannot clone (a function, a
 * promise of a pending query dehydrated on purpose) fails the write, given
 * to `onError`.
 */
export function idbPersister(options: IdbPersisterOptions = {}): Persister {
  const database = options.database ?? "bun-client";
  const store = options.store ?? "queries";
  const key = options.key ?? "client";
  const throttleTime = options.throttleTime ?? 1_000;

  /** The open connection, once opening started; `undefined` when there is none to use. */
  let connection: Promise<IdbDatabase | undefined> | undefined;
  /** The cache waiting for the throttled write. */
  let latest: PersistedClient | undefined;
  /** The throttled write's timer. */
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Opens the database (at `version`, the current one when omitted), creating the store if it is missing. */
  function open(factory: IdbFactory, version?: number): Promise<IdbDatabase> {
    return new Promise((resolve, reject) => {
      const request = factory.open(database, version);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(store))
          request.result.createObjectStore(store);
      };
      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB open failed"));
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(store)) {
          // Another persister made the database with its own store.
          db.close();
          open(factory, db.version + 1).then(resolve, reject);
          return;
        }
        const forget = (): void => {
          db.close();
          connection = undefined;
        };
        db.onversionchange = forget;
        db.onclose = forget;
        resolve(db);
      };
    });
  }

  /** The connection, opened on first use; `undefined` without IndexedDB. */
  function db(): Promise<IdbDatabase | undefined> {
    if (connection) return connection;
    const factory =
      options.indexedDB ?? (globalThis as { indexedDB?: IdbFactory }).indexedDB;
    connection = factory ? open(factory) : Promise.resolve(undefined);
    // A failed open is tried again on the next use.
    connection.catch(() => {
      connection = undefined;
    });
    return connection;
  }

  /**
   * Runs `operation` in a transaction of its own; `fallback` without
   * IndexedDB or on failure (given to `onError`). Operations need no queue
   * of ours: each awaits the same connection, so their transactions are
   * created in call order, and IndexedDB runs transactions on one store in
   * the order they were created (a read sees every write before it).
   */
  async function transact<T>(
    operation: (objectStore: IdbObjectStore, done: Promise<void>) => Promise<T>,
    mode: "readonly" | "readwrite",
    fallback: T,
  ): Promise<T> {
    try {
      const connected = await db();
      if (!connected) return fallback;
      const transaction = connected.transaction(store, mode);
      const done = committed(transaction);
      // Read by the operation once its request is made; a request that
      // throws (a value IndexedDB cannot clone) leaves it unread.
      done.catch(() => {});
      return await operation(transaction.objectStore(store), done);
    } catch (error) {
      options.onError?.(error);
      return fallback;
    }
  }

  /** Writes the latest cache, if one is waiting. */
  function flush(): void {
    timer = undefined;
    const client = latest;
    latest = undefined;
    if (client === undefined) return;
    void transact(
      async (objectStore, done) => {
        objectStore.put(client, key);
        await done;
      },
      "readwrite",
      undefined,
    );
  }

  return {
    persistClient(client) {
      latest = client;
      timer ??= setTimeout(flush, throttleTime);
    },
    restoreClient() {
      return transact(
        async (objectStore, done) => {
          const request = objectStore.get(key);
          await done;
          const value = request.result;
          return typeof value === "object" && value !== null
            ? (value as PersistedClient)
            : undefined;
        },
        "readonly",
        undefined,
      );
    },
    removeClient() {
      // A write still waiting would bring back what is being removed.
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      latest = undefined;
      return transact(
        async (objectStore, done) => {
          objectStore.delete(key);
          await done;
        },
        "readwrite",
        undefined,
      );
    },
  };
}
