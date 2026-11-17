/**
 * The engine's own local state is bounded (layers.md L9.6, control-plane.md
 * §9): every table holds at most `maxKeys` entries and, past that, drops the
 * oldest. A client rotating keys (addresses in a /64, invented user ids)
 * cannot grow it, but can push other subjects out early; each such eviction
 * is counted, and evictions raise a `state.evictions` warning (a key-rotation
 * attack, or `maxKeys` set too small), once, until a quiet minute clears it.
 */
import type { SecurityWarning } from "./trust";

/** The default bound on each table of local state (layers.md L9.6). */
export const DEFAULT_MAX_KEYS = 100_000;

/** The evictions of one minute, and the warning in force. */
export class EvictionMonitor {
  /** Evictions since the engine started. */
  #total = 0;
  /** The current minute's start. */
  #minute = Number.NEGATIVE_INFINITY;
  /** New entries this minute. */
  #inserts = 0;
  /** Evictions this minute. */
  #evictions = 0;
  /** The last minute with an eviction. */
  #lastEvicting = Number.NEGATIVE_INFINITY;
  /** The first minute of the current run of evicting minutes. */
  #since = 0;
  /** The warning in force. */
  #warning: SecurityWarning | undefined;

  constructor(
    /** Called with the warning when it is raised. */
    private readonly warn: (warning: SecurityWarning) => void,
    /** The service's id, for the warning. */
    private readonly service: () => string | undefined,
  ) {}

  /** Evictions since the engine started. */
  get total(): number {
    return this.#total;
  }

  /** Moves to `now`'s minute; a minute passed with no eviction clears the warning. */
  #roll(now: number): void {
    const minute = now - (now % 60_000);
    if (minute === this.#minute) return;
    this.#minute = minute;
    this.#inserts = 0;
    this.#evictions = 0;
    if (minute - this.#lastEvicting > 60_000) this.#warning = undefined;
  }

  /** A new entry was added (the share's denominator). */
  inserted(now: number): void {
    this.#roll(now);
    this.#inserts++;
  }

  /** An entry of `table` was evicted to make room. */
  evicted(table: string, now: number): void {
    this.#roll(now);
    this.#total++;
    this.#evictions++;
    const minute = this.#minute;
    if (minute - this.#lastEvicting > 60_000) this.#since = minute;
    this.#lastEvicting = minute;
    if (this.#warning !== undefined) return;
    const minutes = Math.round((minute - this.#since) / 60_000) + 1;
    this.#warning = Object.freeze({
      kind: "state.evictions",
      message: `bun-security: the ${table} table is full and evicting its oldest keys: a key-rotation attack, or maxKeys set too small`,
      service: this.service(),
      minutes,
      // At most 1: the default throttle store reports its drops but not its
      // inserts, so a minute can count more evictions than new entries.
      share: Math.min(1, this.#evictions / Math.max(1, this.#inserts)),
      since: this.#since,
    });
    this.warn(this.#warning);
  }

  /** The warning in force at `now`, if any. */
  warning(now: number): SecurityWarning | undefined {
    this.#roll(now);
    return this.#warning;
  }
}

/**
 * A map of at most `maxKeys` entries in insertion order: setting a new key
 * on a full table drops the oldest (an eviction, counted by the monitor).
 */
export class BoundedTable<V> {
  /** The entries, oldest first. */
  readonly #entries = new Map<string, V>();

  constructor(
    /** The table's name, for the warning. */
    readonly name: string,
    /** The most entries held. */
    readonly maxKeys: number,
    /** Counts insertions and evictions. */
    private readonly monitor: EvictionMonitor,
  ) {}

  /** Entries held. */
  get size(): number {
    return this.#entries.size;
  }

  /** The value at `key`. */
  get(key: string): V | undefined {
    return this.#entries.get(key);
  }

  /** Sets `key`, moving it to the newest place; evicts the oldest when a new key would pass the bound. */
  set(key: string, value: V, now: number): void {
    if (this.#entries.delete(key)) {
      this.#entries.set(key, value);
      return;
    }
    this.monitor.inserted(now);
    while (this.#entries.size >= this.maxKeys) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
      this.monitor.evicted(this.name, now);
    }
    this.#entries.set(key, value);
  }

  /** Forgets `key`. */
  delete(key: string): void {
    this.#entries.delete(key);
  }

  /** The entries, oldest first. */
  entries(): IterableIterator<[string, V]> {
    return this.#entries.entries();
  }

  /** Forgets everything. */
  clear(): void {
    this.#entries.clear();
  }
}
