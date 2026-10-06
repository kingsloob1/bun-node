/**
 * The route cache: a FIFO cache whose eviction is O(1), with admission that
 * stops filling it while its hit ratio is low. It keeps exactly the policy it
 * replaced, so it never changes what matches — only what a hit costs. The
 * route lookup on a miss is `routeTree.ts`. See
 * `docs/plans/bun-native-routes.md` §4.6 for the measurements behind it.
 */

/** Lookups per admission window (see {@link FifoCache}). */
export const ADMISSION_WINDOW = 4096;

/**
 * The hit ratio under which a window turns full admission off. A path
 * cache that hits less than this costs more to fill than it saves.
 */
export const ADMISSION_MIN_HIT_RATIO = 0.25;

/** While admission is off, one new key in this many is still stored. */
export const ADMISSION_SAMPLE = 64;

/**
 * A bounded map with first-in-first-out eviction in O(1).
 *
 * `Map` alone evicts its oldest entry with `map.delete(map.keys().next().value)`,
 * which is O(entries deleted so far) in both JavaScriptCore and V8: an
 * insertion-ordered `Map` keeps deleted slots until it rehashes, and
 * `keys().next()` walks past them — ~18 µs per insert at 50,000 entries. This
 * keeps the same policy (exact FIFO, at most `max` entries) but names the
 * oldest key from a ring buffer, so eviction is one `Map.delete`.
 *
 * It has no per-key `delete`: the router never removes a single entry, and
 * one would leave a stale ring slot behind. {@link clear} drops everything.
 *
 * With `admission`, it stops paying for entries nobody reads again: it
 * counts lookups ({@link get}) and hits over windows of
 * {@link ADMISSION_WINDOW}, and while the last window's hit ratio is under
 * {@link ADMISSION_MIN_HIT_RATIO}, {@link set} stores only one new key in
 * {@link ADMISSION_SAMPLE} — enough for a working set that returns to raise
 * the ratio and turn full admission back on. Counters only, no per-key state:
 * a "seen before" set costs a lookup on every miss, which is what admission
 * is there to save. What is cached never changes a result, only its cost.
 */
export class FifoCache<V> {
  /** Whether {@link set} is throttled by the hit ratio (see the class). */
  readonly #admission: boolean;
  /** Lookups in the current window. */
  #lookups = 0;
  /** Hits in the current window. */
  #hits = 0;
  /** Whether new keys are all stored: the last window's ratio was high enough. */
  #admitting = true;
  /** New keys offered while not admitting; every {@link ADMISSION_SAMPLE}th is stored. */
  #offered = 0;
  /** The entries. */
  #map = new Map<string, V>();
  /**
   * Keys in insertion order. It grows to `max` and is then reused as a ring,
   * with the oldest key at {@link #head} — so an unused cache costs nothing.
   */
  #ring: string[] = [];
  /** Once the ring is full, the slot the next insertion takes: the oldest key. */
  #head = 0;

  constructor(
    /** The most entries held; a positive integer. */
    private readonly max: number,
    /** Options; see {@link FifoCacheOptions}. */
    options?: FifoCacheOptions,
  ) {
    this.#admission = options?.admission === true;
  }

  /**
   * Whether new keys are all being stored: always without `admission`; with
   * it, while the last window's hit ratio was at least
   * {@link ADMISSION_MIN_HIT_RATIO}.
   */
  get admitting(): boolean {
    return this.#admitting;
  }

  /** The number of entries held. */
  get size(): number {
    return this.#map.size;
  }

  /** The entry for `key`, or `undefined`. Counted as a lookup for admission. */
  get(key: string): V | undefined {
    const value = this.#map.get(key);
    if (this.#admission) {
      if (value !== undefined) {
        this.#hits++;
      }
      if (++this.#lookups === ADMISSION_WINDOW) {
        this.#admitting =
          this.#hits >= ADMISSION_WINDOW * ADMISSION_MIN_HIT_RATIO;
        this.#lookups = 0;
        this.#hits = 0;
      }
    }
    return value;
  }

  /**
   * Stores an entry, evicting the oldest when full. Replacing an existing key
   * keeps its place in the eviction order, as `Map#set` keeps its position.
   */
  set(key: string, value: V): this {
    const map = this.#map;
    if (map.has(key)) {
      map.set(key, value);
      return this;
    }
    // Admission off: store one new key in ADMISSION_SAMPLE.
    if (!this.#admitting && this.#offered++ % ADMISSION_SAMPLE !== 0) {
      return this;
    }
    const ring = this.#ring;
    if (ring.length < this.max) {
      ring.push(key);
    } else {
      map.delete(ring[this.#head]);
      ring[this.#head] = key;
      this.#head = (this.#head + 1) % this.max;
    }
    map.set(key, value);
    return this;
  }

  /** Removes every entry, and starts admission afresh. */
  clear(): void {
    this.#map.clear();
    this.#ring = [];
    this.#head = 0;
    this.#lookups = 0;
    this.#hits = 0;
    this.#admitting = true;
    this.#offered = 0;
  }
}

/** Options for {@link FifoCache}. */
export interface FifoCacheOptions {
  /**
   * Throttle insertions while the hit ratio is low (see {@link FifoCache}).
   * Default `false`: every key is stored.
   */
  admission?: boolean;
}
