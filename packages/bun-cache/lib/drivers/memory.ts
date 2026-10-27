/**
 * The memory driver (plan §7.1): per-process `Map`s, storing the encoded
 * bytes like every other driver — no aliasing, exact size accounting, the
 * same conformance results.
 *
 * - **Caps**: `maxEntries` and `maxBytes` (an entry's size is its encoded
 *   byte length), enforced on write, evicting in LRU order (Map insertion
 *   order, refreshed on each hit) — §3.9.
 * - **Expiry**: lazy on read, plus the core's sweeper calling `sweep`.
 * - **Atomicity**: every operation is synchronous, so atomic.
 * - **Isolation**: `multiProcess: false`; two `memoryDriver()` instances
 *   share nothing.
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

/** `memoryDriver()`'s options. */
export interface MemoryDriverOptions {
  /** At most this many entries per driver; the least-recently-used go first. Uncapped by default. */
  maxEntries?: number;
  /** At most this many encoded bytes per driver. Uncapped by default. */
  maxBytes?: number;
  /**
   * The clock, epoch ms. Internal: for tests — pass the same fake clock the
   * cache runs on (`createCache`'s `now`), so the driver's lazy expiry and
   * fence agree with the core's checks. Defaults to `Date.now`.
   */
  now?: () => number;
}

/** One stored entry. */
interface Slot {
  /** The encoded bytes (copied on write). */
  value: Uint8Array;
  /** The hard expiry, epoch ms; `null` never expires. */
  expiresAt: number | null;
  /** The entry's tags. */
  tags: readonly string[];
}

/** One counter. */
interface Counter {
  /** The current value. */
  value: number;
  /** The hard expiry, epoch ms, set at creation only; `null` never expires. */
  expiresAt: number | null;
  /** When the counter was created, epoch ms. */
  createdAt: number;
}

/** One held lock. */
interface Lock {
  /** Who holds it. */
  owner: string;
  /** When it lapses, epoch ms. */
  expiresAt: number;
}

/** One tag invalidation stamp. */
interface Stamp {
  /** When the tag was invalidated, epoch ms. */
  at: number;
  /** When the stamp itself expires, epoch ms. */
  until: number;
}

/** One namespace's slice of the store. */
interface NamespaceStore {
  /** Entries in LRU order (insertion order, refreshed on hit). */
  entries: Map<string, Slot>;
  /** The tag index: tag → the keys carrying it. */
  tagIndex: Map<string, Set<string>>;
  /** The tag invalidation stamps. */
  stamps: Map<string, Stamp>;
  /** The counters. */
  counters: Map<string, Counter>;
  /** The locks. */
  locks: Map<string, Lock>;
}

/** The memory driver. See the module header. */
export class MemoryDriver implements CacheDriver {
  /** `"memory"`. */
  readonly name = "memory";

  /** What an in-process `Map` can do atomically: everything but a cross-process bus. */
  readonly capabilities: CacheDriverCapabilities = {
    multiProcess: false,
    ttl: "sweep",
    atomicIncrement: true,
    lock: true,
    tags: "index",
    fence: "atomic",
    bus: "push",
  };

  readonly #options: MemoryDriverOptions;
  /** The clock (the `now` option, or `Date.now`). */
  readonly #now: () => number;
  readonly #stores = new Map<string, NamespaceStore>();
  readonly #evictListeners: ((
    ns: string,
    key: string,
    reason: string,
  ) => void)[] = [];
  readonly #busListeners = new Set<(message: BusMessage) => void>();
  #bytes = 0;
  #entries = 0;

  constructor(
    /** The caps and the clock. */ options: MemoryDriverOptions = {},
  ) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** A no-op: there is nothing to connect. */
  connect(): Promise<void> {
    return Promise.resolve();
  }

  /** Drops every namespace. */
  close(): Promise<void> {
    this.#stores.clear();
    this.#busListeners.clear();
    this.#bytes = 0;
    this.#entries = 0;
    return Promise.resolve();
  }

  /** A no-op: an in-process map is always up. */
  ping(): Promise<void> {
    return Promise.resolve();
  }

  /** The namespace's store, created on first use. */
  #store(ns: string): NamespaceStore {
    let store = this.#stores.get(ns);
    if (store === undefined) {
      store = {
        entries: new Map(),
        tagIndex: new Map(),
        stamps: new Map(),
        counters: new Map(),
        locks: new Map(),
      };
      this.#stores.set(ns, store);
    }
    return store;
  }

  /** Deletes the slot for `key` and its tag-index rows; answers whether there was one. */
  #deleteEntry(store: NamespaceStore, key: string): boolean {
    const slot = store.entries.get(key);
    if (slot === undefined) {
      return false;
    }
    store.entries.delete(key);
    this.#entries--;
    this.#bytes -= slot.value.byteLength;
    for (const tag of slot.tags) {
      const keys = store.tagIndex.get(tag);
      if (keys !== undefined) {
        keys.delete(key);
        if (keys.size === 0) {
          store.tagIndex.delete(tag);
        }
      }
    }
    return true;
  }

  /** Evicts least-recently-used entries until both caps hold. */
  #evictToCaps(ns: string, store: NamespaceStore): void {
    const { maxEntries, maxBytes } = this.#options;
    for (;;) {
      const over =
        (maxEntries !== undefined && this.#entries > maxEntries) ||
        (maxBytes !== undefined && this.#bytes > maxBytes);
      if (!over) {
        return;
      }
      // The least-recently-used entry: each store's map is in LRU order, so
      // the head of a namespace is its oldest. The caps are per driver, and
      // the excess is one entry at a time, so evicting the first non-empty
      // namespace's head is enough — the caps are a safety valve, not a
      // precise global LRU.
      let oldestNs: string | undefined;
      let oldestKey: string | undefined;
      for (const [otherNs, other] of this.#stores) {
        const head = other.entries.keys().next();
        if (head.done) {
          continue;
        }
        oldestNs = otherNs;
        oldestKey = head.value;
        break;
      }
      if (oldestKey === undefined || oldestNs === undefined) {
        return;
      }
      const target = oldestNs === ns ? store : this.#store(oldestNs);
      this.#deleteEntry(target, oldestKey);
      for (const listener of this.#evictListeners) {
        listener(oldestNs, oldestKey, "cap");
      }
    }
  }

  get(ns: string, key: string): Promise<StoredEntry | undefined> {
    const store = this.#stores.get(ns);
    const slot = store?.entries.get(key);
    if (store === undefined || slot === undefined) {
      return Promise.resolve(undefined);
    }
    if (slot.expiresAt !== null && slot.expiresAt <= this.#now()) {
      this.#deleteEntry(store, key);
      return Promise.resolve(undefined);
    }
    // LRU: a hit moves the entry to the back.
    store.entries.delete(key);
    store.entries.set(key, slot);
    return Promise.resolve({
      key,
      value: slot.value,
      expiresAt: slot.expiresAt,
      tags: slot.tags,
    });
  }

  getMany(
    ns: string,
    keys: readonly string[],
  ): Promise<(StoredEntry | undefined)[]> {
    return Promise.all(keys.map((key) => this.get(ns, key)));
  }

  set(
    ns: string,
    entry: StoredEntry,
    fence?: TagFence,
  ): Promise<"stored" | "fenced"> {
    const store = this.#store(ns);
    if (fence !== undefined && fence.tags.length > 0) {
      const now = this.#now();
      for (const tag of fence.tags) {
        const stamp = store.stamps.get(tag);
        if (
          stamp !== undefined &&
          stamp.until > now &&
          stamp.at >= fence.createdAt
        ) {
          return Promise.resolve("fenced");
        }
      }
    }
    // Replacing: drop the old tag-index rows first.
    this.#deleteEntry(store, entry.key);
    store.counters.delete(entry.key);
    store.entries.set(entry.key, {
      value: entry.value.slice(),
      expiresAt: entry.expiresAt,
      tags: entry.tags,
    });
    this.#entries++;
    this.#bytes += entry.value.byteLength;
    for (const tag of entry.tags) {
      let keys = store.tagIndex.get(tag);
      if (keys === undefined) {
        keys = new Set();
        store.tagIndex.set(tag, keys);
      }
      keys.add(entry.key);
    }
    this.#evictToCaps(ns, store);
    return Promise.resolve("stored");
  }

  setMany(ns: string, entries: readonly StoredEntry[]): Promise<void> {
    for (const entry of entries) {
      void this.set(ns, entry);
    }
    return Promise.resolve();
  }

  delete(ns: string, keys: readonly string[]): Promise<number> {
    const store = this.#stores.get(ns);
    if (store === undefined) {
      return Promise.resolve(0);
    }
    let count = 0;
    for (const key of keys) {
      if (this.#deleteEntry(store, key)) {
        count++;
      }
      if (store.counters.delete(key)) {
        count++;
      }
    }
    return Promise.resolve(count);
  }

  clear(ns: string): Promise<void> {
    const store = this.#stores.get(ns);
    if (store !== undefined) {
      this.#entries -= store.entries.size;
      for (const slot of store.entries.values()) {
        this.#bytes -= slot.value.byteLength;
      }
    }
    this.#stores.delete(ns);
    return Promise.resolve();
  }

  touch(ns: string, key: string, expiresAt: number | null): Promise<boolean> {
    const store = this.#stores.get(ns);
    if (store === undefined) {
      return Promise.resolve(false);
    }
    const slot = store.entries.get(key);
    if (slot !== undefined) {
      slot.expiresAt = expiresAt;
      return Promise.resolve(true);
    }
    const counter = store.counters.get(key);
    if (counter !== undefined) {
      counter.expiresAt = expiresAt;
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  deleteByTags(
    ns: string,
    tags: readonly string[],
    stampUntil: number,
  ): Promise<number> {
    if (tags.length === 0) {
      return Promise.resolve(0);
    }
    // The namespace's store is created even with no entries: the stamps are
    // the point — a later write whose load predates this invalidation must be
    // fenced (§3.6).
    const store = this.#store(ns);
    const now = this.#now();
    let count = 0;
    for (const tag of tags) {
      const keys = store.tagIndex.get(tag);
      if (keys !== undefined) {
        for (const key of [...keys]) {
          if (this.#deleteEntry(store, key)) {
            count++;
          }
        }
      }
      store.stamps.set(tag, { at: now, until: stampUntil });
    }
    return Promise.resolve(count);
  }

  getStamps(ns: string, tags: readonly string[]): Promise<Map<string, number>> {
    const store = this.#stores.get(ns);
    const out = new Map<string, number>();
    if (store === undefined) {
      return Promise.resolve(out);
    }
    const now = this.#now();
    for (const tag of tags) {
      const stamp = store.stamps.get(tag);
      if (stamp !== undefined) {
        if (stamp.until > now) {
          out.set(tag, stamp.at);
        } else {
          store.stamps.delete(tag);
        }
      }
    }
    return Promise.resolve(out);
  }

  setStamps(
    ns: string,
    tags: readonly string[],
    at: number,
    until: number,
  ): Promise<void> {
    const store = this.#store(ns);
    for (const tag of tags) {
      store.stamps.set(tag, { at, until });
    }
    return Promise.resolve();
  }

  increment(
    ns: string,
    key: string,
    by: number,
    expiresAt: number | null,
  ): Promise<number> {
    const store = this.#store(ns);
    let counter = store.counters.get(key);
    if (counter !== undefined) {
      if (counter.expiresAt !== null && counter.expiresAt <= this.#now()) {
        store.counters.delete(key);
        counter = undefined;
      }
    }
    if (counter === undefined) {
      // A counter and an entry never share a key: the last writer wins.
      this.#deleteEntry(store, key);
      counter = { value: 0, expiresAt, createdAt: this.#now() };
      store.counters.set(key, counter);
    }
    counter.value += by;
    return Promise.resolve(counter.value);
  }

  getCounter(
    ns: string,
    key: string,
  ): Promise<
    { value: number; expiresAt: number | null; createdAt: number } | undefined
  > {
    const store = this.#stores.get(ns);
    const counter = store?.counters.get(key);
    if (store === undefined || counter === undefined) {
      return Promise.resolve(undefined);
    }
    if (counter.expiresAt !== null && counter.expiresAt <= this.#now()) {
      store.counters.delete(key);
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      value: counter.value,
      expiresAt: counter.expiresAt,
      createdAt: counter.createdAt,
    });
  }

  acquireLock(
    ns: string,
    key: string,
    owner: string,
    ttlMs: number,
  ): Promise<boolean> {
    const store = this.#store(ns);
    const now = this.#now();
    const held = store.locks.get(key);
    if (held !== undefined && held.expiresAt > now && held.owner !== owner) {
      return Promise.resolve(false);
    }
    store.locks.set(key, { owner, expiresAt: now + ttlMs });
    return Promise.resolve(true);
  }

  releaseLock(ns: string, key: string, owner: string): Promise<boolean> {
    const store = this.#stores.get(ns);
    const held = store?.locks.get(key);
    if (store === undefined || held === undefined || held.owner !== owner) {
      return Promise.resolve(false);
    }
    store.locks.delete(key);
    return Promise.resolve(true);
  }

  sweep(now: number, limit: number): Promise<number> {
    let removed = 0;
    for (const store of this.#stores.values()) {
      for (const [key, slot] of [...store.entries]) {
        if (removed >= limit) {
          return Promise.resolve(removed);
        }
        if (slot.expiresAt !== null && slot.expiresAt <= now) {
          this.#deleteEntry(store, key);
          removed++;
        }
      }
      for (const [key, counter] of [...store.counters]) {
        if (removed >= limit) {
          return Promise.resolve(removed);
        }
        if (counter.expiresAt !== null && counter.expiresAt <= now) {
          store.counters.delete(key);
          removed++;
        }
      }
      for (const [tag, stamp] of [...store.stamps]) {
        if (stamp.until <= now) {
          store.stamps.delete(tag);
        }
      }
      for (const [key, lock] of [...store.locks]) {
        if (lock.expiresAt <= now) {
          store.locks.delete(key);
        }
      }
    }
    return Promise.resolve(removed);
  }

  publish(message: BusMessage): Promise<void> {
    for (const listener of this.#busListeners) {
      listener(message);
    }
    return Promise.resolve();
  }

  subscribe(
    onMessage: (message: BusMessage) => void,
    _onGap: () => void,
  ): Promise<() => Promise<void>> {
    this.#busListeners.add(onMessage);
    return Promise.resolve(async () => {
      this.#busListeners.delete(onMessage);
    });
  }

  onEviction(
    listener: (ns: string, key: string, reason: string) => void,
  ): void {
    this.#evictListeners.push(listener);
  }

  /** The schema is new; there is nothing to sync (§7.4). */
  syncSchema(_options?: SchemaSyncOptions): Promise<SchemaChange[]> {
    return Promise.resolve([]);
  }
}

/** A memory driver (§7.1): per-process, synchronous, LRU-capped. See {@link MemoryDriver}. */
export function memoryDriver(options: MemoryDriverOptions = {}): CacheDriver {
  return new MemoryDriver(options);
}
