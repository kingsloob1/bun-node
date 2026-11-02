/**
 * What the drivers' `setMany` share: one write per key, and batches cut to
 * what one statement or one script can carry.
 */
import type { StoredEntry } from "../core/types";

/**
 * The entries with each key written once: the last write of a key is kept,
 * where it stood. A loop of `set` ends with the last write too, so a driver
 * that writes the batch in one statement (where a key twice is an error, on
 * Postgres, or would leave both writes' tag rows) keeps that outcome. The
 * array itself when no key repeats.
 */
export function lastWritePerKey(
  entries: readonly StoredEntry[],
): readonly StoredEntry[] {
  const last = new Map<string, number>();
  entries.forEach((entry, index) => last.set(entry.key, index));
  return last.size === entries.length
    ? entries
    : entries.filter((entry, index) => last.get(entry.key) === index);
}

/** The limits of one chunk of a batch. */
export interface ChunkLimits {
  /** At most this many entries per chunk (a statement's parameters, a script's arguments). */
  rows: number;
  /** At most this many bytes per chunk, by `size`; an entry larger on its own gets a chunk of its own. */
  bytes: number;
  /** An entry's size as the chunk counts it. Defaults to its value's length. */
  size?: (entry: StoredEntry) => number;
}

/** Cuts a batch into consecutive chunks within `limits`, keeping its order. */
export function chunkEntries(
  entries: readonly StoredEntry[],
  limits: ChunkLimits,
): StoredEntry[][] {
  const size = limits.size ?? ((entry: StoredEntry) => entry.value.byteLength);
  const chunks: StoredEntry[][] = [];
  let chunk: StoredEntry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const each = size(entry);
    if (
      chunk.length > 0 &&
      (chunk.length >= limits.rows || bytes + each > limits.bytes)
    ) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(entry);
    bytes += each;
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}
