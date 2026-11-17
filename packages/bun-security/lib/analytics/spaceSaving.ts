/**
 * The space-saving algorithm (Metwally, Agrawal and El Abbadi, 2005): the
 * heaviest keys of a stream in bounded memory (README §8.1's top-K). It
 * holds at most `capacity` keys; a new key past that takes the place of
 * the lightest, inheriting its count as its error. Every key whose true
 * count exceeds the stream's total over `capacity` is held, and a held
 * key's count overestimates its true count by at most its `error`.
 */

/** One held key. */
export interface SpaceSavingEntry {
  /** The key. */
  readonly key: string;
  /** Its estimated count: at least its true count. */
  readonly count: number;
  /** How much of `count` it may not have earned (the count it inherited). */
  readonly error: number;
}

/** A space-saving summary of one stream. */
export class SpaceSaving {
  /** The most keys held. */
  readonly capacity: number;
  /** The held keys. */
  readonly #entries = new Map<string, { count: number; error: number }>();
  /** The stream's total weight. */
  #total = 0;

  constructor(
    /** The most keys held, at least 1. */
    capacity: number,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError(
        "SpaceSaving: capacity must be a positive whole number",
      );
    }
    this.capacity = capacity;
  }

  /** The stream's total weight so far. */
  get total(): number {
    return this.#total;
  }

  /** How many keys are held. */
  get size(): number {
    return this.#entries.size;
  }

  /** Counts `key` `weight` times. */
  offer(key: string, weight = 1): void {
    this.#total += weight;
    const held = this.#entries.get(key);
    if (held !== undefined) {
      held.count += weight;
      return;
    }
    if (this.#entries.size < this.capacity) {
      this.#entries.set(key, { count: weight, error: 0 });
      return;
    }
    let lightest: string | undefined;
    let least = Number.POSITIVE_INFINITY;
    for (const [candidate, entry] of this.#entries) {
      if (entry.count < least) {
        least = entry.count;
        lightest = candidate;
      }
    }
    this.#entries.delete(lightest!);
    this.#entries.set(key, { count: least + weight, error: least });
  }

  /** The held keys, the heaviest first (ties by key). */
  top(): SpaceSavingEntry[] {
    return [...this.#entries]
      .map(([key, entry]) => ({ key, count: entry.count, error: entry.error }))
      .sort(
        (a, b) =>
          b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      );
  }
}
