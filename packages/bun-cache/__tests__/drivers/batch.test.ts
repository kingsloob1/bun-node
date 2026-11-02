/**
 * The drivers' `setMany` helpers (`lib/drivers/batch.ts`): one write per
 * key, the last kept where it stood, and chunks within a row and byte limit.
 */
import { describe, expect, test } from "bun:test";
import type { StoredEntry } from "../../lib/index";
import { chunkEntries, lastWritePerKey } from "../../lib/drivers/batch";

/** An entry of `size` bytes under `key`. */
function entry(key: string, size = 1): StoredEntry {
  return { key, value: new Uint8Array(size), expiresAt: null, tags: [] };
}

describe("lastWritePerKey", () => {
  test("keeps each key's last write, in place, and the batch itself when no key repeats", () => {
    const distinct = [entry("a"), entry("b")];
    expect(lastWritePerKey(distinct)).toBe(distinct);
    const repeated = [entry("a", 1), entry("b"), entry("a", 3), entry("c")];
    expect(
      lastWritePerKey(repeated).map((each) => [
        each.key,
        each.value.byteLength,
      ]),
    ).toEqual([
      ["b", 1],
      ["a", 3],
      ["c", 1],
    ]);
    expect(lastWritePerKey([])).toEqual([]);
  });
});

describe("chunkEntries", () => {
  test("cuts at the row limit, keeping order", () => {
    const entries = Array.from({ length: 5 }, (_, index) => entry(`k${index}`));
    expect(
      chunkEntries(entries, { rows: 2, bytes: 1_000 }).map((chunk) =>
        chunk.map((each) => each.key),
      ),
    ).toEqual([["k0", "k1"], ["k2", "k3"], ["k4"]]);
  });

  test("cuts at the byte limit; an entry past it alone gets a chunk of its own", () => {
    const entries = [
      entry("a", 4),
      entry("b", 4),
      entry("big", 50),
      entry("c", 4),
    ];
    expect(
      chunkEntries(entries, { rows: 100, bytes: 10 }).map((chunk) =>
        chunk.map((each) => each.key),
      ),
    ).toEqual([["a", "b"], ["big"], ["c"]]);
    // A custom size counts what the caller says.
    expect(
      chunkEntries(entries, { rows: 100, bytes: 10, size: () => 5 }).map(
        (chunk) => chunk.length,
      ),
    ).toEqual([2, 2]);
    expect(chunkEntries([], { rows: 1, bytes: 1 })).toEqual([]);
  });
});
