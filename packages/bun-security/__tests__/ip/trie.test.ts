/**
 * The CIDR trie against a brute-force scan (plan §11.3): random prefixes and
 * addresses in both families, IPv4-mapped forms included, with the seed in
 * every test name so a failure is reproducible.
 */
import { describe, expect, it } from "bun:test";
import {
  cidrContains,
  formatAddress,
  maskWords,
  parseAddress,
  parseCidr,
} from "../../lib/ip/address";
import type { ParsedAddress, ParsedCidr } from "../../lib/ip/address";
import { CidrTrie } from "../../lib/ip/trie";
import { randomWord, seededRandom } from "../helpers";

/** A random range of `family`, prefixes biased short so ranges nest and overlap. */
function randomCidr(random: () => number, family: 4 | 6): ParsedCidr {
  const max = family === 4 ? 32 : 128;
  const bits = 1 + Math.floor(random() ** 2 * max);
  const words = Uint32Array.from({ length: family === 4 ? 1 : 4 }, () =>
    randomWord(random),
  );
  const masked = maskWords(words, bits);
  return {
    family,
    words: masked,
    bits,
    text: `${formatAddress(family, masked)}/${bits}`,
  };
}

/** A random address: half the time inside one of `near`, so matches happen. */
function randomAddress(
  random: () => number,
  family: 4 | 6,
  near: readonly ParsedCidr[],
): ParsedAddress {
  const words = Uint32Array.from({ length: family === 4 ? 1 : 4 }, () =>
    randomWord(random),
  );
  const base = near[Math.floor(random() * near.length)];
  if (base && base.family === family && random() < 0.5) {
    for (let i = 0; i < words.length; i++) {
      const start = i * 32;
      const keep = Math.max(0, Math.min(32, base.bits - start));
      if (keep === 0) continue;
      const mask = keep === 32 ? 0xffffffff : (0xffffffff << (32 - keep)) >>> 0;
      words[i] =
        (((base.words[i] ?? 0) & mask) | ((words[i] ?? 0) & ~mask)) >>> 0;
    }
  }
  return { family, words, text: formatAddress(family, words) };
}

describe("CidrTrie against a brute-force scan", () => {
  for (const seed of [1, 2, 3, 0x5eed, 20261115]) {
    it(`agrees on 300 ranges and 3,000 addresses (seed ${seed})`, () => {
      const random = seededRandom(seed);
      const trie = new CidrTrie<number>();
      const ranges: ParsedCidr[] = [];
      for (let i = 0; i < 300; i++) {
        const range = randomCidr(random, random() < 0.5 ? 4 : 6);
        ranges.push(range);
        trie.insert(range, i);
      }
      expect(trie.size).toBe(300);
      expect(trie.nodes).toBeLessThanOrEqual(600);
      for (let i = 0; i < 3000; i++) {
        const address = randomAddress(random, random() < 0.5 ? 4 : 6, ranges);
        const expected = ranges
          .map((range, index) => [range, index] as const)
          .filter(([range]) => cidrContains(range, address))
          .sort(([a, ai], [b, bi]) => a.bits - b.bits || ai - bi)
          .map(([, index]) => index);
        const actual = [...trie.match(address)];
        // Same set; least specific first (equal prefixes in insertion order).
        expect(actual).toEqual(expected);
      }
    });
  }

  it("negative control: a scan with one range removed disagrees", () => {
    const trie = new CidrTrie<string>();
    const wide = parseCidr("203.0.113.0/24");
    const narrow = parseCidr("203.0.113.128/25");
    if (!wide || !narrow) throw new Error("fixture");
    trie.insert(wide, "wide");
    trie.insert(narrow, "narrow");
    const address = parseAddress("203.0.113.200");
    if (!address) throw new Error("fixture");
    expect(trie.match(address)).toEqual(["wide", "narrow"]);
    expect([wide].filter((r) => cidrContains(r, address))).not.toEqual(
      trie.match(address),
    );
  });
});

describe("CidrTrie lookups", () => {
  const trie = new CidrTrie<string>();
  for (const range of [
    "10.0.0.0/8",
    "10.1.0.0/16",
    "203.0.113.5",
    "2001:db8::/32",
    "2001:db8:1:2::/64",
    "::ffff:198.51.100.0/120",
  ]) {
    const parsed = parseCidr(range);
    if (!parsed) throw new Error(range);
    trie.insert(parsed, range);
  }

  /** The ranges matching `address`. */
  const match = (address: string): readonly string[] => {
    const parsed = parseAddress(address);
    if (!parsed) throw new Error(address);
    return trie.match(parsed);
  };

  it("returns every containing range, least specific first", () => {
    expect(match("10.1.2.3")).toEqual(["10.0.0.0/8", "10.1.0.0/16"]);
    expect(match("10.2.0.1")).toEqual(["10.0.0.0/8"]);
    expect(match("11.0.0.1")).toEqual([]);
  });

  it("matches a whole address exactly", () => {
    expect(match("203.0.113.5")).toEqual(["203.0.113.5"]);
    expect(match("203.0.113.6")).toEqual([]);
  });

  it("matches IPv6 by prefix", () => {
    expect(match("2001:db8:1:2:aaaa::1")).toEqual([
      "2001:db8::/32",
      "2001:db8:1:2::/64",
    ]);
    expect(match("2001:db8:1:3::1")).toEqual(["2001:db8::/32"]);
  });

  it("T-L2-2: an IPv4-mapped client matches IPv4 ranges, and a mapped range matches IPv4", () => {
    expect(match("::ffff:10.1.0.9")).toEqual(["10.0.0.0/8", "10.1.0.0/16"]);
    expect(match("198.51.100.77")).toEqual(["::ffff:198.51.100.0/120"]);
  });

  it("never matches across families", () => {
    expect(match("::a01:203")).toEqual([]);
  });

  it("refuses a prefix out of range", () => {
    const bad: ParsedCidr = {
      family: 4,
      words: Uint32Array.of(0),
      bits: 33,
      text: "0.0.0.0/33",
    };
    expect(() => new CidrTrie().insert(bad, 1)).toThrow(RangeError);
  });

  it("grows past its first capacity", () => {
    const big = new CidrTrie<number>();
    for (let i = 0; i < 5000; i++) {
      const cidr = parseCidr(
        `198.${(i >> 8) & 0xff}.${i & 0xff}.${(i * 7) & 0xff}`,
      );
      if (!cidr) throw new Error("fixture");
      big.insert(cidr, i);
    }
    const hit = parseAddress(`198.0.${42}.${(42 * 7) & 0xff}`);
    if (!hit) throw new Error("fixture");
    expect(big.match(hit)).toEqual([42]);
  });
});
