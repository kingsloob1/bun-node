import { Buffer } from "node:buffer";
import { describe, expect, it } from "bun:test";
import { ConfigError } from "../lib/index";
import { assertNamespace, assertSegment } from "../lib/shared/keys";
import { compareCodePoints } from "../lib/shared/strings";

/**
 * The rules key layouts depend on.
 *
 * Every backend builds keys by joining a namespace, a queue name and a
 * suffix with separators — `:` in Redis, MongoDB and SQL keys, `/` in file
 * paths. Those keys are unambiguous only because a segment can never contain
 * a separator. Nothing else enforces that, so it is pinned here: loosening
 * the pattern would let `x:state:z` read as another queue's state, silently.
 *
 * Every non-ASCII character below is written as an escape, so the file says
 * exactly which code points it tests whatever an editor shows.
 */

/** U+00E9, LATIN SMALL LETTER E WITH ACUTE. */
const E_ACUTE = "é";
/** U+D7FF, the last code point before the surrogates. */
const BEFORE_SURROGATES = "퟿";
/** U+E000, the first private-use code point after the surrogates. */
const PRIVATE_USE = "";
/** U+FFFF, the last code point in the Basic Multilingual Plane. */
const LAST_BMP = "￿";
/** U+10000, the first code point that needs a surrogate pair. */
const FIRST_ASTRAL = "\u{10000}";
/** U+1F600, an emoji. */
const EMOJI = "\u{1F600}";
/** U+10FFFF, the last code point. */
const LAST_CODE_POINT = "\u{10FFFF}";

describe("key segments", () => {
  it("accept the characters every backend can hold unescaped", () => {
    for (const name of ["mail", "Mail-2", "report_v1.5", "a", "A.b-c_d"]) {
      expect(assertSegment(name, "queue name")).toBe(name);
      expect(assertNamespace(name)).toBe(name);
    }
  });

  it("reject every separator a key layout uses, and anything like one", () => {
    for (const name of [
      "x:state:z",
      "a/b",
      "a\\b",
      "a b",
      "a\tb",
      "a\nb",
      "a*b",
      "a%b",
      "a?b",
      "a#b",
      "a{b}",
      `r${E_ACUTE}sum${E_ACUTE}`,
      `a${EMOJI}`,
      "",
    ]) {
      expect(() => assertSegment(name, "queue name")).toThrow(ConfigError);
      expect(() => assertNamespace(name)).toThrow(ConfigError);
    }
  });

  it("reject a segment too long to be a key part", () => {
    expect(() => assertSegment("a".repeat(201), "queue name")).toThrow(
      ConfigError,
    );
    expect(assertSegment("a".repeat(200), "queue name")).toHaveLength(200);
  });
});

describe("compareCodePoints", () => {
  /** Byte order of the UTF-8 encodings, the order backends compare in. */
  const byBytes = (left: string, right: string) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right));

  it("orders by code point, which is UTF-8 byte order", () => {
    const names = [EMOJI, LAST_BMP, "z", E_ACUTE, PRIVATE_USE, "A", "a", ""];

    const sorted = [...names].sort(compareCodePoints);

    expect(sorted).toEqual([
      "",
      "A",
      "a",
      "z",
      E_ACUTE,
      PRIVATE_USE,
      LAST_BMP,
      EMOJI,
    ]);
    expect(sorted).toEqual([...names].sort(byBytes));
  });

  it("differs from JavaScript's default sort exactly where UTF-16 does", () => {
    // UTF-16 code units put the emoji's leading surrogate (U+D83D) first.
    expect([PRIVATE_USE, EMOJI].sort()).toEqual([EMOJI, PRIVATE_USE]);
    expect([PRIVATE_USE, EMOJI].sort(compareCodePoints)).toEqual([
      PRIVATE_USE,
      EMOJI,
    ]);
  });

  it("compares within surrogate pairs and by length", () => {
    expect(compareCodePoints(EMOJI, "\u{1F601}")).toBeLessThan(0);
    expect(compareCodePoints(FIRST_ASTRAL, EMOJI)).toBeLessThan(0);
    expect(compareCodePoints(LAST_BMP, FIRST_ASTRAL)).toBeLessThan(0);
    expect(compareCodePoints("ab", "abc")).toBeLessThan(0);
    expect(compareCodePoints("abc", "abc")).toBe(0);
    expect(compareCodePoints("b", "abc")).toBeGreaterThan(0);
  });

  it("agrees with byte order over many random strings", () => {
    const alphabet = [
      "a",
      "Z",
      E_ACUTE,
      BEFORE_SURROGATES,
      PRIVATE_USE,
      LAST_BMP,
      FIRST_ASTRAL,
      EMOJI,
      LAST_CODE_POINT,
    ];
    const random = () =>
      Array.from(
        { length: 1 + Math.floor(Math.random() * 4) },
        () => alphabet[Math.floor(Math.random() * alphabet.length)],
      ).join("");

    for (let round = 0; round < 2_000; round++) {
      const left = random();
      const right = random();
      expect(Math.sign(compareCodePoints(left, right))).toBe(
        Math.sign(byBytes(left, right)),
      );
    }
  });
});
