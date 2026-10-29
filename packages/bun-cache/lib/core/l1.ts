/**
 * The L1 tier (plan §4.1): a per-process memory tier holding **decoded**
 * entries over the shared driver (L2), so a hit skips the round trip and the
 * decode.
 *
 * - **Only fresh copies.** An entry is held until the first of its
 *   `freshUntil`, its L2 `expiresAt` and `now + ttl`: backfill copies the L2
 *   entry's own expiry, never a fresh TTL (R14), and a stale value is never
 *   served from here — the stale windows (§3.5) are L2's.
 * - **Caps.** `maxEntries` and `maxBytes` (the decoded payload's byte length),
 *   evicting in LRU order: `Map` insertion order, refreshed on each hit.
 * - **Coherence: generations.** Every invalidation (a key, a tag, a namespace,
 *   everything) bumps a generation while a read or write is in flight. A
 *   backfill, or a write's own copy, captured the generation before its L2
 *   operation started ({@link L1Store.begin}); if anything that could cover
 *   its key was invalidated since, the copy is dropped instead of stored.
 *   Without it, a read that fetched the old value from L2 just before another
 *   process's write would store that old value *after* the bus message that
 *   should have removed it, and serve it until `ttl`.
 * - **Armed once the bus listens.** A cache with a bus starts its L1
 *   disarmed — nothing is served or stored — and arms it when the bus's
 *   first subscribe settles: on success through a flush (whatever was in
 *   flight is dropped, since messages before the subscription never
 *   arrived), on failure as is (a copy is then bounded by `ttl`, §4.3).
 */

/** What L1 needs of the entries it holds. */
export interface L1Entry {
  /** The decoded value. */
  value: unknown;
  /** When it stops being fresh, epoch ms; `null` when never. */
  freshUntil: number | null;
  /** The L2 entry's hard expiry, epoch ms; `null` when never. */
  expiresAt: number | null;
  /** The entry's tags as the driver and the bus name them (hashed under `encrypt.hashNames`): what the tag index holds, and what an invalidation names. */
  storedTags: readonly string[];
}

/** The resolved `l1` options. */
export interface L1Options {
  /** At most this many entries. */
  maxEntries: number;
  /** At most this many decoded payload bytes. */
  maxBytes: number;
  /** The longest an entry is held, in ms. */
  ttl: number;
  /** Clone values in and out with `structuredClone`. */
  clone: boolean;
}

/** One held entry. */
interface Slot<E extends L1Entry> {
  /** The entry. */
  entry: E;
  /** Its namespace. */
  ns: string;
  /** Its decoded payload size, in bytes. */
  size: number;
  /** When L1 stops serving it, epoch ms. */
  until: number;
}

/** The counts `stats().l1` reports. */
export interface L1Counts {
  /** Fresh reads served. */
  hits: number;
  /** Reads that went on to L2. */
  misses: number;
  /** Entries copied in from an L2 read. */
  backfills: number;
  /** Entries dropped by an invalidation. */
  invalidations: number;
  /** Entries dropped by the caps. */
  evictions: number;
  /** Whole-tier flushes. */
  flushes: number;
}

/**
 * Past this many recorded generations (keys, tags, namespaces) the maps are
 * replaced by one "everything" bump: every copy in flight is dropped, and the
 * bookkeeping stays bounded under a storm of invalidations.
 */
const MAX_TRACKED_GENERATIONS = 10_000;

/** The composite key of a namespaced key. */
function slotKey(ns: string, key: string): string {
  return `${ns}\n${key}`;
}

/** The L1 store. See the module header. */
export class L1Store<E extends L1Entry> {
  /** The resolved options. */
  readonly options: L1Options;
  /** The counts, zeroed by `stats({ reset: true })`. */
  counts: L1Counts = {
    hits: 0,
    misses: 0,
    backfills: 0,
    invalidations: 0,
    evictions: 0,
    flushes: 0,
  };

  /** The entries, in LRU order. */
  readonly #slots = new Map<string, Slot<E>>();
  /** The tag index: `ns\ntag` → the slot keys carrying it. */
  readonly #tagIndex = new Map<string, Set<string>>();
  /** The decoded bytes held. */
  #bytes = 0;

  /** The generation counter: bumped by each invalidation recorded while something is in flight. */
  #gen = 0;
  /** The last "everything" invalidation's generation. */
  #allGen = 0;
  /** `ns\nkey` → its last invalidation's generation. */
  readonly #keyGen = new Map<string, number>();
  /** `ns` → its last `clear`'s generation. */
  readonly #nsGen = new Map<string, number>();
  /** `ns\ntag` → its last invalidation's generation. */
  readonly #tagGen = new Map<string, number>();
  /** Reads and writes between {@link begin} and {@link end}. */
  #inFlight = 0;
  /** Whether L1 serves and stores; see the module header. */
  #armed = true;

  constructor(/** The resolved `l1` options. */ options: L1Options) {
    this.options = options;
  }

  /** How many entries are held. */
  get entries(): number {
    return this.#slots.size;
  }

  /** How many decoded bytes are held. */
  get bytes(): number {
    return this.#bytes;
  }

  /** A fresh copy of `key`, or `undefined`; refreshes its LRU position. A clone of the value when `clone` is set. */
  get(ns: string, key: string, now: number): E | undefined {
    if (!this.#armed) {
      return undefined;
    }
    const id = slotKey(ns, key);
    const slot = this.#slots.get(id);
    if (slot === undefined) {
      return undefined;
    }
    if (slot.until <= now) {
      this.#remove(id, slot);
      return undefined;
    }
    this.#slots.delete(id);
    this.#slots.set(id, slot);
    return this.options.clone
      ? { ...slot.entry, value: structuredClone(slot.entry.value) }
      : slot.entry;
  }

  /** Starts an L2 operation whose result may be copied in; answers its token (the generation now). */
  begin(): number {
    this.#inFlight++;
    return this.#gen;
  }

  /** Ends what {@link begin} started; with nothing in flight, the generations are forgotten. */
  end(): void {
    this.#inFlight--;
    if (this.#inFlight === 0) {
      this.#keyGen.clear();
      this.#nsGen.clear();
      this.#tagGen.clear();
    }
  }

  /** Whether something covering this key or one of its tags was invalidated after `token`. */
  #invalidatedSince(
    token: number,
    ns: string,
    key: string,
    tags: readonly string[],
  ): boolean {
    if (this.#allGen > token) {
      return true;
    }
    if ((this.#nsGen.get(ns) ?? 0) > token) {
      return true;
    }
    if ((this.#keyGen.get(slotKey(ns, key)) ?? 0) > token) {
      return true;
    }
    for (const tag of tags) {
      if ((this.#tagGen.get(slotKey(ns, tag)) ?? 0) > token) {
        return true;
      }
    }
    return false;
  }

  /** Records an invalidation in `map` — only while something is in flight, the only time it can matter. */
  #record(map: Map<string, number>, id: string): void {
    if (this.#inFlight === 0) {
      return;
    }
    this.#gen++;
    if (
      this.#keyGen.size + this.#nsGen.size + this.#tagGen.size >=
      MAX_TRACKED_GENERATIONS
    ) {
      this.#allGen = this.#gen;
      this.#keyGen.clear();
      this.#nsGen.clear();
      this.#tagGen.clear();
      return;
    }
    map.set(id, this.#gen);
  }

  /**
   * Copies in an entry an L2 read found fresh, unless something that covers
   * it was invalidated since `token` (then it is not stored). Answers whether
   * it was stored.
   */
  fill(
    ns: string,
    key: string,
    entry: E,
    size: number,
    token: number,
    now: number,
  ): boolean {
    if (
      !this.#armed ||
      this.#invalidatedSince(token, ns, key, entry.storedTags)
    ) {
      return false;
    }
    if (this.#put(ns, key, entry, size, now)) {
      this.counts.backfills++;
      return true;
    }
    return false;
  }

  /**
   * After this process wrote `key` to L2: the write invalidates every other
   * copy in flight for the key, and its own value (when given) is stored,
   * unless something covering it was invalidated while the write ran — then
   * which write L2 kept last is unknowable here, and L1 holds neither.
   */
  afterWrite(
    ns: string,
    key: string,
    entry: E | undefined,
    size: number,
    token: number,
    now: number,
  ): void {
    const raced =
      entry === undefined ||
      !this.#armed ||
      this.#invalidatedSince(token, ns, key, entry.storedTags);
    this.#record(this.#keyGen, slotKey(ns, key));
    if (raced) {
      this.#drop(slotKey(ns, key), false);
      return;
    }
    this.#put(ns, key, entry, size, now);
  }

  /** Stores an entry, evicting to the caps; answers whether it was stored (a copy that is already due, or alone over `maxBytes`, is not). */
  #put(ns: string, key: string, entry: E, size: number, now: number): boolean {
    const id = slotKey(ns, key);
    this.#drop(id, false);
    const until = Math.min(
      entry.freshUntil ?? Number.POSITIVE_INFINITY,
      entry.expiresAt ?? Number.POSITIVE_INFINITY,
      now + this.options.ttl,
    );
    if (until <= now || size > this.options.maxBytes) {
      return false;
    }
    const held = this.options.clone
      ? { ...entry, value: structuredClone(entry.value) }
      : entry;
    this.#slots.set(id, { entry: held, ns, size, until });
    this.#bytes += size;
    for (const tag of entry.storedTags) {
      const tagId = slotKey(ns, tag);
      let keys = this.#tagIndex.get(tagId);
      if (keys === undefined) {
        keys = new Set();
        this.#tagIndex.set(tagId, keys);
      }
      keys.add(id);
    }
    while (
      this.#slots.size > this.options.maxEntries ||
      this.#bytes > this.options.maxBytes
    ) {
      const oldest = this.#slots.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.#remove(oldest.value, this.#slots.get(oldest.value)!);
      this.counts.evictions++;
    }
    return true;
  }

  /** Drops keys (a write or delete, here or on the bus). */
  invalidateKeys(ns: string, keys: readonly string[]): void {
    for (const key of keys) {
      const id = slotKey(ns, key);
      this.#record(this.#keyGen, id);
      this.#drop(id, true);
    }
  }

  /** Drops every entry carrying one of `tags` in `ns`. */
  invalidateTags(ns: string, tags: readonly string[]): void {
    for (const tag of tags) {
      const tagId = slotKey(ns, tag);
      this.#record(this.#tagGen, tagId);
      const keys = this.#tagIndex.get(tagId);
      if (keys !== undefined) {
        for (const id of [...keys]) {
          this.#drop(id, true);
        }
      }
    }
  }

  /** Drops every entry of `ns` (exactly that namespace, as the driver's `clear` is). */
  invalidateNamespace(ns: string): void {
    this.#record(this.#nsGen, ns);
    for (const [id, slot] of [...this.#slots]) {
      if (slot.ns === ns) {
        this.#remove(id, slot);
        this.counts.invalidations++;
      }
    }
  }

  /** Stops serving and storing until {@link arm} or {@link flush}: a cache whose bus is not listening yet. */
  disarm(): void {
    this.#armed = false;
  }

  /** Starts serving and storing (the bus's first subscribe failed: copies are bounded by `ttl`). */
  arm(): void {
    this.#armed = true;
  }

  /** Drops everything (a bus gap, a (re)subscription) and arms L1: what was missed is unknowable. */
  flush(): void {
    this.#armed = true;
    if (this.#inFlight > 0) {
      this.#gen++;
      this.#allGen = this.#gen;
      this.#keyGen.clear();
      this.#nsGen.clear();
      this.#tagGen.clear();
    }
    this.#slots.clear();
    this.#tagIndex.clear();
    this.#bytes = 0;
    this.counts.flushes++;
  }

  /** Drops one slot if held; counts it as an invalidation when asked. */
  #drop(id: string, counted: boolean): void {
    const slot = this.#slots.get(id);
    if (slot !== undefined) {
      this.#remove(id, slot);
      if (counted) {
        this.counts.invalidations++;
      }
    }
  }

  /** Removes a slot and its tag-index rows. */
  #remove(id: string, slot: Slot<E>): void {
    this.#slots.delete(id);
    this.#bytes -= slot.size;
    for (const tag of slot.entry.storedTags) {
      const tagId = slotKey(slot.ns, tag);
      const keys = this.#tagIndex.get(tagId);
      if (keys !== undefined) {
        keys.delete(id);
        if (keys.size === 0) {
          this.#tagIndex.delete(tagId);
        }
      }
    }
  }

  /** Drops everything and the bookkeeping (the cache's `close()`). */
  clear(): void {
    this.#slots.clear();
    this.#tagIndex.clear();
    this.#bytes = 0;
  }
}
