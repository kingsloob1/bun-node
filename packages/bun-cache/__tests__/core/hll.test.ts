/**
 * The distinct-count sketch (`lib/core/hll.ts`): accuracy against exact
 * counts, the encodings (sparse, dense, the switch between them) round-trip
 * every register, a union counts what the merged sets hold, re-adding changes
 * nothing, the hash is fixed across processes, and bytes that are not a
 * sketch are refused.
 */
import { describe, expect, it } from "bun:test";
import {
  decodeSketch,
  encodeSketch,
  HLL_MAX_BYTES,
  HLL_REGISTERS,
  murmur3,
  place,
  SketchFormatError,
  sketchAdd,
  sketchCount,
  SPARSE_MAX,
} from "../../lib/core/hll";

/** `n` distinct elements, `prefix` keeping sets apart. */
const elements = (n: number, prefix = "e"): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}:${i}`);

/** A sketch of `items`. */
const sketchOf = (items: readonly string[]): Uint8Array =>
  sketchAdd(undefined, items).sketch;

describe("accuracy", () => {
  it("is within 1 of exact up to 100, and within 3% up to 200,000", () => {
    for (const n of [0, 1, 2, 10, 50, 100]) {
      expect(
        Math.abs(sketchCount([sketchOf(elements(n))]) - n),
      ).toBeLessThanOrEqual(1);
    }
    for (const n of [1_000, 5_000, 20_000, 50_000, 200_000]) {
      const count = sketchCount([sketchOf(elements(n))]);
      expect({ n, ok: Math.abs(count - n) / n <= 0.03 }).toEqual({
        n,
        ok: true,
      });
    }
  });

  it("counts repeats once", () => {
    const once = sketchOf(elements(5_000));
    const twice = sketchAdd(once, elements(5_000)).sketch;
    expect(sketchCount([twice])).toBe(sketchCount([once]));
  });
});

describe("pfAdd's answer", () => {
  it("is true when a sketch is created (even empty) or a register rises, false for elements already in", () => {
    expect(sketchAdd(undefined, []).changed).toBe(true);
    const first = sketchAdd(undefined, ["a", "b"]);
    expect(first.changed).toBe(true);
    const again = sketchAdd(first.sketch, ["a", "b"]);
    expect(again.changed).toBe(false);
    expect(again.sketch).toBe(first.sketch);
    expect(sketchAdd(first.sketch, ["c"]).changed).toBe(true);
  });
});

describe("union", () => {
  it("counts what the merged sets hold, overlaps once", () => {
    const a = sketchOf(elements(3_000, "x"));
    const b = sketchOf([...elements(1_000, "x"), ...elements(2_000, "y")]);
    const union = sketchCount([a, b, undefined]);
    expect(Math.abs(union - 5_000) / 5_000).toBeLessThanOrEqual(0.03);
    // The same as one sketch of everything: registers merge by max.
    expect(union).toBe(
      sketchCount([
        sketchOf([...elements(3_000, "x"), ...elements(2_000, "y")]),
      ]),
    );
    expect(sketchCount([])).toBe(0);
    expect(sketchCount([undefined, new Uint8Array(0)])).toBe(0);
  });
});

describe("encodings", () => {
  it("stays sparse up to SPARSE_MAX registers, then goes dense, both round-tripping every register", () => {
    const small = sketchOf(elements(100));
    expect(small[2]).toBe(1);
    expect(small.length).toBeLessThan(400);
    const big = sketchOf(elements(10_000));
    expect(big[2]).toBe(2);
    expect(big.length).toBe(HLL_MAX_BYTES);
    expect(HLL_MAX_BYTES).toBe(12_291);
    for (const sketch of [small, big]) {
      expect(encodeSketch(decodeSketch(sketch))).toEqual(sketch);
    }
  });

  it("round-trips random registers of every rank, on both sides of the switch", () => {
    let seed = 7;
    const random = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    for (const used of [1, SPARSE_MAX, SPARSE_MAX + 1, HLL_REGISTERS]) {
      const registers = new Uint8Array(HLL_REGISTERS);
      for (let i = 0; i < used; i++) {
        registers[
          used === HLL_REGISTERS ? i : Math.floor(random() * HLL_REGISTERS)
        ] = 1 + Math.floor(random() * 63);
      }
      expect(decodeSketch(encodeSketch(registers))).toEqual(registers);
    }
  });

  it("refuses bytes that are not a sketch", () => {
    for (const bytes of [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([0x42, 0x48, 9]),
      new Uint8Array([0x42, 0x48, 1, 0, 0]),
      new Uint8Array([0x42, 0x48, 1, 0, 0, 0]), // rank 0
      new Uint8Array([0x42, 0x48, 2, 0]),
    ]) {
      expect(() => decodeSketch(bytes)).toThrow(SketchFormatError);
    }
  });
});

describe("the hash", () => {
  it("is MurmurHash3 x86_32, by its published test vectors", () => {
    const utf8 = (text: string) => new TextEncoder().encode(text);
    expect(murmur3(utf8(""), 0)).toBe(0);
    expect(murmur3(utf8(""), 1)).toBe(0x514e28b7);
    expect(murmur3(utf8(""), 0xffffffff)).toBe(0x81f16f39);
    expect(murmur3(utf8("hello"), 0)).toBe(0x248bfa47);
    expect(murmur3(utf8("Hello, world!"), 0x9747b28c)).toBe(0x24884cba);
    expect(
      murmur3(utf8("The quick brown fox jumps over the lazy dog"), 0x9747b28c),
    ).toBe(0x2fa826cd);
  });

  it("is fixed: the same element lands in the same register in every process", () => {
    // Pinned values: a change here would break merging with sketches already stored.
    expect(place("a")).toEqual(place("a"));
    expect([place(""), place("a"), place("203.0.113.5"), place("é")]).toEqual([
      { index: 15_085, rank: 1 },
      { index: 8_168, rank: 3 },
      { index: 11_445, rank: 5 },
      { index: 14_510, rank: 1 },
    ]);
    const ranks = elements(20_000).map((element) => place(element).rank);
    expect(Math.max(...ranks)).toBeLessThanOrEqual(51);
    expect(Math.min(...ranks)).toBeGreaterThanOrEqual(1);
  });
});
