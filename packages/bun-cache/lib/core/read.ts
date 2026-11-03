/**
 * A read of one key in one round trip, for the built-in drivers that keep a
 * key's entry and its counter in one row (Postgres, MySQL, MariaDB, MongoDB).
 * Internal: nothing here is exported from the package.
 *
 * Through the driver contract a read is `get`, then — when that finds no
 * entry — `getCounter`, since a counter lives outside the entry bytes
 * (§3.8). That is two round trips for every miss. A driver whose row holds
 * either can answer both from one read, so it offers this reader under a
 * symbol the core knows, and the contract stays as it is: a third-party
 * driver keeps `get` and `getCounter`, and the core reads it as before.
 *
 * **A replaced `get` is honoured.** The reader names the `get` and
 * `getCounter` it stands for, and the core uses it only while the driver it
 * holds still answers those very functions. A subclass that overrides
 * either, or a `Proxy` that intercepts one (or hands out bound copies, as the
 * delegating proxies in the tests do), is read through its own methods.
 */
import type { CacheDriver, StoredEntry } from "./types";

/** The symbol a built-in driver offers its {@link EntryOrCounterReader} under. */
export const ENTRY_OR_COUNTER: unique symbol = Symbol(
  "bun-cache:entry-or-counter",
);

/** A counter as `getCounter` answers it. */
export interface StoredCounter {
  /** Its value. */
  value: number;
  /** Its hard expiry, epoch ms; `null` for none. */
  expiresAt: number | null;
  /** When it was created, epoch ms. */
  createdAt: number;
}

/** What one read of a key found: its entry, its counter, or nothing. */
export type EntryOrCounter =
  { entry: StoredEntry } | { counter: StoredCounter } | undefined;

/** A driver's one-round-trip read, and the two methods it stands for. */
export interface EntryOrCounterReader {
  /** The `get` this read answers for: used only while the driver's `get` is this function. */
  readonly get: CacheDriver["get"];
  /** The `getCounter` it answers for, likewise. */
  readonly getCounter: NonNullable<CacheDriver["getCounter"]>;
  /** Reads the key: what `get` would answer, else what `getCounter` would. */
  read: (ns: string, key: string) => Promise<EntryOrCounter>;
}

/** A driver that offers an {@link EntryOrCounterReader}. */
export interface ReadsEntryOrCounter {
  /** The reader. */
  readonly [ENTRY_OR_COUNTER]: EntryOrCounterReader;
}

/**
 * The driver's one-round-trip reader, when it offers one and its `get` and
 * `getCounter` are still the ones the reader stands for; otherwise
 * `undefined`, and the core reads with `get` and `getCounter`.
 */
export function entryOrCounterReader(
  driver: CacheDriver,
): EntryOrCounterReader | undefined {
  const reader = (driver as Partial<ReadsEntryOrCounter>)[ENTRY_OR_COUNTER];
  return reader !== undefined &&
    driver.get === reader.get &&
    driver.getCounter === reader.getCounter
    ? reader
    : undefined;
}
