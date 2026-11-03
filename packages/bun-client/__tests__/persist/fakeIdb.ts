/**
 * A small IndexedDB for the persister's tests (`persist.test.ts`): neither
 * Bun nor happy-dom has one. It implements the part `idbPersister` uses,
 * with the platform's rules that a persister can get wrong:
 *
 * - every request and every event is asynchronous (a task later);
 * - a transaction is active only in the task that made it and in its
 *   requests' callbacks: a request made later (after an `await`) throws
 *   `TransactionInactiveError`, and a transaction with nothing left to do
 *   commits on its own (`oncomplete`);
 * - values are stored and read as structured clones, so a function or a
 *   promise fails `put` synchronously with `DataCloneError`, and a value read
 *   back is never the object written;
 * - a store exists only once an upgrade (`onupgradeneeded`, a higher
 *   version) created it; `transaction()` on a missing one throws
 *   `NotFoundError`, and `createObjectStore` outside an upgrade
 *   `InvalidStateError`;
 * - requests are answered in the order they were made, across
 *   transactions, as IndexedDB runs transactions on one store in creation
 *   order;
 * - `close()` makes the connection refuse new transactions, and an upgrade
 *   tells every other open connection first (`onversionchange`).
 *
 * The browser's own IndexedDB is exercised by `persist.e2e.test.ts`, in
 * Chrome. Faults are injected with {@link FakeIndexedDb.failNext}; another
 * tab's upgrade with {@link FakeIndexedDb.versionChange}.
 */
import type { IdbPersisterOptions } from "../../lib/persist";

/** The factory type `idbPersister` takes. */
type Factory = NonNullable<IdbPersisterOptions["indexedDB"]>;

/** A database's contents. */
interface Database {
  /** Its version. */
  version: number;
  /** Its stores: name → key → value (a structured clone). */
  stores: Map<string, Map<string, unknown>>;
}

/** An event handler slot, as the persister assigns it. */
type Handler = ((event: never) => unknown) | null;

/** Runs `fn` a task later, as IndexedDB delivers its events. */
const later = (fn: () => void): void => {
  setTimeout(fn, 0);
};

/** Calls an event handler, if one is set. */
const fire = (handler: Handler): void => {
  (handler as ((event?: unknown) => unknown) | null)?.();
};

/** A request: `result` once it succeeded, `error` once it failed. */
class FakeRequest<T> {
  result = undefined as T;
  error: Error | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
}

/** An open request, which may upgrade. */
class FakeOpenRequest extends FakeRequest<FakeConnection> {
  onupgradeneeded: Handler = null;
}

/** The kinds of operation a fault can be injected into. */
type Operation = "open" | "get" | "put" | "delete";

/** A connection to one database. */
class FakeConnection {
  onversionchange: Handler = null;
  onclose: Handler = null;
  /** Whether `close()` was called. */
  closed = false;
  /** Whether the connection is in its upgrade (stores may be created). */
  upgrading = false;

  constructor(
    readonly owner: FakeIndexedDb,
    readonly name: string,
    readonly db: Database,
  ) {}

  get version(): number {
    return this.db.version;
  }

  get objectStoreNames(): { contains: (name: string) => boolean } {
    return { contains: (name) => this.db.stores.has(name) };
  }

  createObjectStore(name: string): unknown {
    if (!this.upgrading)
      throw new DOMException("not in an upgrade", "InvalidStateError");
    this.db.stores.set(name, new Map());
    return {};
  }

  transaction(store: string, mode: "readonly" | "readwrite"): FakeTransaction {
    if (this.closed)
      throw new DOMException("the connection is closed", "InvalidStateError");
    const records = this.db.stores.get(store);
    if (!records) throw new DOMException(`no store ${store}`, "NotFoundError");
    return new FakeTransaction(this.owner, store, records, mode);
  }

  close(): void {
    this.closed = true;
    this.owner.connections.delete(this);
  }
}

/** A transaction on one store. */
class FakeTransaction {
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  error: Error | null = null;
  /** Whether requests may still be made. */
  private active = true;
  /** Requests made and not yet answered. */
  private pending = 0;
  /** Whether it committed or aborted. */
  private finished = false;

  constructor(
    private readonly owner: FakeIndexedDb,
    readonly storeName: string,
    private readonly records: Map<string, unknown>,
    private readonly mode: "readonly" | "readwrite",
  ) {
    // Inactive once the task that made it ends; done if nothing was asked.
    later(() => {
      this.active = false;
      this.settle();
    });
  }

  objectStore(name: string): {
    get: (key: string) => FakeRequest<unknown>;
    put: (value: unknown, key: string) => FakeRequest<unknown>;
    delete: (key: string) => FakeRequest<unknown>;
  } {
    if (name !== this.storeName)
      throw new DOMException(`not in scope: ${name}`, "NotFoundError");
    return {
      get: (key) =>
        this.request("get", () => structuredClone(this.records.get(key))),
      put: (value, key) => {
        this.writable();
        // Cloned now, as IndexedDB does: an uncloneable value throws here.
        const clone = structuredClone(value);
        return this.request("put", () => {
          this.records.set(key, clone);
          this.owner.puts.push({ store: this.storeName, key, value: clone });
          return key;
        });
      },
      delete: (key) => {
        this.writable();
        return this.request("delete", () => {
          this.records.delete(key);
          this.owner.deletes.push({ store: this.storeName, key });
          return undefined;
        });
      },
    };
  }

  /** Throws unless the transaction may write. */
  private writable(): void {
    if (this.mode !== "readwrite")
      throw new DOMException("a readonly transaction", "ReadOnlyError");
  }

  /** Makes a request answered a task later by `run`, or by an injected fault. */
  private request<T>(operation: Operation, run: () => T): FakeRequest<T> {
    if (!this.active || this.finished)
      throw new DOMException(
        "the transaction is not active",
        "TransactionInactiveError",
      );
    const request = new FakeRequest<T>();
    this.pending++;
    later(() => {
      this.pending--;
      const fault = this.owner.takeFault(operation);
      if (fault) {
        request.error = fault;
        fire(request.onerror);
        this.error = fault;
        this.finished = true;
        fire(this.onerror);
        fire(this.onabort);
        return;
      }
      request.result = run();
      // Active again inside the callback, as IndexedDB makes it.
      this.active = true;
      fire(request.onsuccess);
      this.active = false;
      this.settle();
    });
    return request;
  }

  /** Commits once inactive with nothing pending. */
  private settle(): void {
    if (this.finished || this.active || this.pending > 0) return;
    this.finished = true;
    later(() => fire(this.oncomplete));
  }
}

/** An in-memory IndexedDB factory, with a record of what it was asked. */
export class FakeIndexedDb {
  /** The databases, by name. */
  readonly databases = new Map<string, Database>();
  /** The open connections. */
  readonly connections = new Set<FakeConnection>();
  /** Every committed write, in order. */
  readonly puts: { store: string; key: string; value: unknown }[] = [];
  /** Every committed delete, in order. */
  readonly deletes: { store: string; key: string }[] = [];
  /** How many times `open` was called. */
  opens = 0;
  /** Faults to inject, in order, by operation. */
  private readonly faults: { operation: Operation; error: Error }[] = [];

  /** This fake, typed as the persister's `indexedDB` option. */
  get factory(): Factory {
    return this;
  }

  /** Makes the next `operation` fail with `error`. */
  failNext(operation: Operation, error: Error): void {
    this.faults.push({ operation, error });
  }

  /** The next injected fault for `operation`, removed. */
  takeFault(operation: Operation): Error | undefined {
    const index = this.faults.findIndex(
      (fault) => fault.operation === operation,
    );
    if (index < 0) return undefined;
    return this.faults.splice(index, 1)[0].error;
  }

  /** The value at `key` of `store` in database `name`, as stored. */
  peek(name: string, store: string, key: string): unknown {
    return this.databases.get(name)?.stores.get(store)?.get(key);
  }

  /** Another tab asks to upgrade database `name`: every open connection is told. */
  versionChange(name: string): void {
    for (const connection of [...this.connections]) {
      if (connection.name === name) fire(connection.onversionchange);
    }
  }

  open(name: string, version?: number): FakeOpenRequest {
    this.opens++;
    const request = new FakeOpenRequest();
    later(() => {
      const fault = this.takeFault("open");
      if (fault) {
        request.error = fault;
        fire(request.onerror);
        return;
      }
      let db = this.databases.get(name);
      const current = db?.version ?? 0;
      const target = version ?? Math.max(current, 1);
      if (target < current) {
        request.error = new DOMException("lower version", "VersionError");
        fire(request.onerror);
        return;
      }
      if (!db) {
        db = { version: 0, stores: new Map() };
        this.databases.set(name, db);
      }
      const connection = new FakeConnection(this, name, db);
      request.result = connection;
      if (target > current) {
        // The other connections are told first, as IndexedDB does (this
        // fake upgrades whether or not they close).
        this.versionChange(name);
        db.version = target;
        connection.upgrading = true;
        fire(request.onupgradeneeded);
        connection.upgrading = false;
      }
      this.connections.add(connection);
      fire(request.onsuccess);
    });
    return request;
  }
}
