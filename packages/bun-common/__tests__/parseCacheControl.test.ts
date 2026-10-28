/**
 * `parseCacheControl()` (bun-cache plan §9.7, PR-H0; the user's decision of
 * 2026-10-28): RFC 9111 §5.2's request and response directives, RFC 5861's
 * stale windows and RFC 8246's `immutable`. Case-insensitive names, token
 * and quoted-string arguments, the 2^31 cap (§1.2.2), first occurrence wins
 * and malformed arguments read most restrictively (§4.2.1), unknown
 * directives kept (§5.2.3), and never a throw. Round trips through
 * `formatCacheControl()`, and real-world headers.
 */
import type { CacheControlDirectives, ParsedCacheControl } from "../lib/index";
import { describe, expect, it } from "bun:test";
import { formatCacheControl, parseCacheControl } from "../lib/index";

/** Every key a parse result may carry. */
const RESULT_KEYS = new Set([
  "public",
  "private",
  "noCache",
  "noStore",
  "maxAge",
  "sMaxAge",
  "staleWhileRevalidate",
  "staleIfError",
  "mustRevalidate",
  "proxyRevalidate",
  "mustUnderstand",
  "noTransform",
  "immutable",
  "maxStale",
  "minFresh",
  "onlyIfCached",
  "extensions",
  "invalid",
  "duplicates",
]);

/** A small deterministic PRNG (mulberry32), so a failing case reproduces. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("parseCacheControl: empty input", () => {
  it.each([null, undefined, "", "   ", ",", " , ,, "])("%p → {}", (value) => {
    expect(parseCacheControl(value)).toEqual({});
  });
});

describe("parseCacheControl: every directive", () => {
  it.each([
    ["public", { public: true }],
    ["private", { private: true }],
    ["no-cache", { noCache: true }],
    ["no-store", { noStore: true }],
    ["max-age=60", { maxAge: 60 }],
    ["s-maxage=300", { sMaxAge: 300 }],
    ["stale-while-revalidate=30", { staleWhileRevalidate: 30 }],
    ["stale-if-error=600", { staleIfError: 600 }],
    ["must-revalidate", { mustRevalidate: true }],
    ["proxy-revalidate", { proxyRevalidate: true }],
    ["must-understand", { mustUnderstand: true }],
    ["no-transform", { noTransform: true }],
    ["immutable", { immutable: true }],
    ["max-stale", { maxStale: true }],
    ["max-stale=120", { maxStale: 120 }],
    ["min-fresh=10", { minFresh: 10 }],
    ["only-if-cached", { onlyIfCached: true }],
  ] as [string, ParsedCacheControl][])("%s", (header, parsed) => {
    expect(parseCacheControl(header)).toEqual(parsed);
  });
});

describe("parseCacheControl: syntax (RFC 9111 §5.2)", () => {
  it("matches names case-insensitively", () => {
    expect(
      parseCacheControl("Public, MAX-AGE=60, S-MaxAge=5, No-Store"),
    ).toEqual({ public: true, maxAge: 60, sMaxAge: 5, noStore: true });
  });

  it("reads a quoted-string argument as its token would read", () => {
    expect(parseCacheControl('max-age="60", min-fresh="5"')).toEqual({
      maxAge: 60,
      minFresh: 5,
    });
  });

  it("reads the token form of a qualified directive", () => {
    expect(parseCacheControl("private=Set-Cookie")).toEqual({
      private: ["Set-Cookie"],
    });
  });

  it("keeps commas inside a quoted field list, and the names as written", () => {
    expect(
      parseCacheControl(
        'private="Set-Cookie, X-Session", no-cache="Set-Cookie2", max-age=5',
      ),
    ).toEqual({
      private: ["Set-Cookie", "X-Session"],
      noCache: ["Set-Cookie2"],
      maxAge: 5,
    });
  });

  it("unescapes a quoted-pair", () => {
    expect(parseCacheControl('x-note="a \\"b\\" c"')).toEqual({
      extensions: { "x-note": 'a "b" c' },
    });
  });

  it("allows optional whitespace around elements and the equals sign", () => {
    expect(
      parseCacheControl(" \tmax-age = 60 ,\t, no-cache\t,public "),
    ).toEqual({ maxAge: 60, noCache: true, public: true });
  });

  it("ignores an element that is not a directive", () => {
    expect(parseCacheControl('"quoted", =x, @, immutable')).toEqual({
      immutable: true,
    });
  });
});

describe("parseCacheControl: delta-seconds (RFC 9111 §1.2.2)", () => {
  it("caps an overflowing value at 2147483648", () => {
    expect(parseCacheControl("max-age=2147483648")).toEqual({
      maxAge: 2_147_483_648,
    });
    expect(parseCacheControl("max-age=2147483649")).toEqual({
      maxAge: 2_147_483_648,
    });
    expect(
      parseCacheControl(`s-maxage=${"9".repeat(400)}, min-fresh=99999999999`),
    ).toEqual({ sMaxAge: 2_147_483_648, minFresh: 2_147_483_648 });
  });

  it("reads leading zeros", () => {
    expect(parseCacheControl("max-age=0060")).toEqual({ maxAge: 60 });
  });

  it.each(["-1", "1.5", "+5", "60s", "soon", "0x10", ""])(
    "max-age=%s is malformed: read as 0 (stale) and reported",
    (value) => {
      expect(parseCacheControl(`max-age=${value}`)).toEqual({
        maxAge: 0,
        invalid: ["max-age"],
      });
    },
  );

  it("a lifetime with no argument is malformed", () => {
    expect(parseCacheControl("max-age, stale-while-revalidate")).toEqual({
      maxAge: 0,
      staleWhileRevalidate: 0,
      invalid: ["max-age", "stale-while-revalidate"],
    });
  });

  it("text after the argument makes it malformed", () => {
    expect(parseCacheControl("max-age=60 junk, s-maxage=10")).toEqual({
      maxAge: 0,
      sMaxAge: 10,
      invalid: ["max-age"],
    });
  });

  it("max-stale with a malformed value reads 0, not any age", () => {
    expect(parseCacheControl("max-stale=-1")).toEqual({
      maxStale: 0,
      invalid: ["max-stale"],
    });
  });
});

describe("parseCacheControl: duplicates, invalid and unknown (§4.2.1, §5.2.3)", () => {
  it("keeps the first occurrence of a duplicate, and lists it once", () => {
    expect(
      parseCacheControl("max-age=60, max-age=10, Max-Age=5, public, public"),
    ).toEqual({ maxAge: 60, public: true, duplicates: ["max-age", "public"] });
  });

  it("the first occurrence wins even when it is the malformed one", () => {
    expect(parseCacheControl("max-age=soon, max-age=60")).toEqual({
      maxAge: 0,
      invalid: ["max-age"],
      duplicates: ["max-age"],
    });
  });

  it("an empty or malformed field list reads as the unqualified form", () => {
    expect(parseCacheControl('no-cache="", private="Set Cookie"')).toEqual({
      noCache: true,
      private: true,
      invalid: ["no-cache", "private"],
    });
  });

  it("an unterminated quote is malformed, and ends the header", () => {
    expect(parseCacheControl('public, private="Set-Cookie, max-age=5')).toEqual(
      { public: true, private: true, invalid: ["private"] },
    );
  });

  it("a flag given an argument is set, and reported", () => {
    expect(parseCacheControl("no-store=1, public")).toEqual({
      noStore: true,
      public: true,
      invalid: ["no-store"],
    });
  });

  it("keeps unknown directives in extensions, the first occurrence each", () => {
    // RFC 9111 §5.2.3's own example.
    expect(parseCacheControl('max-age=600, community="UCI"')).toEqual({
      maxAge: 600,
      extensions: { community: "UCI" },
    });
    expect(parseCacheControl("X-Edge=1, x-edge=2, x-flag, max-age=1")).toEqual({
      maxAge: 1,
      extensions: { "x-edge": "1", "x-flag": true },
    });
  });

  it("extensions has no prototype, so __proto__ is only a key", () => {
    const parsed = parseCacheControl("__proto__=evil, constructor");
    const extensions = parsed.extensions ?? {};
    expect(Object.getPrototypeOf(extensions)).toBeNull();
    expect(Object.keys(extensions)).toEqual(["__proto__", "constructor"]);
    expect(
      Object.getOwnPropertyDescriptor(extensions, "__proto__")?.value,
    ).toBe("evil");
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
  });

  it("keeps contradictions as they arrived", () => {
    expect(parseCacheControl("public, private, no-store, max-age=60")).toEqual({
      public: true,
      private: true,
      noStore: true,
      maxAge: 60,
    });
  });
});

describe("parseCacheControl: real-world headers", () => {
  it.each([
    // Responses: CDNs, frameworks, APIs.
    [
      "public, max-age=31536000, immutable",
      { public: true, maxAge: 31_536_000, immutable: true },
    ],
    [
      "no-store, no-cache, must-revalidate, proxy-revalidate",
      {
        noStore: true,
        noCache: true,
        mustRevalidate: true,
        proxyRevalidate: true,
      },
    ],
    [
      "private, no-cache, no-store, must-revalidate, max-age=0",
      {
        private: true,
        noCache: true,
        noStore: true,
        mustRevalidate: true,
        maxAge: 0,
      },
    ],
    [
      "max-age=0, private, must-revalidate",
      { maxAge: 0, private: true, mustRevalidate: true },
    ],
    [
      "public, max-age=0, must-revalidate",
      { public: true, maxAge: 0, mustRevalidate: true },
    ],
    [
      "public, s-maxage=600, stale-while-revalidate=60, stale-if-error=86400",
      {
        public: true,
        sMaxAge: 600,
        staleWhileRevalidate: 60,
        staleIfError: 86_400,
      },
    ],
    // A stale-while-revalidate with no value, as some frameworks send it.
    [
      "s-maxage=31536000, stale-while-revalidate",
      {
        sMaxAge: 31_536_000,
        staleWhileRevalidate: 0,
        invalid: ["stale-while-revalidate"],
      },
    ],
    [
      "private, max-age=60, s-maxage=60",
      { private: true, maxAge: 60, sMaxAge: 60 },
    ],
    [
      "no-cache, no-store, max-age=0, must-revalidate",
      {
        noCache: true,
        noStore: true,
        maxAge: 0,
        mustRevalidate: true,
      },
    ],
    ["no-store, must-understand", { noStore: true, mustUnderstand: true }],
    ["no-transform, max-age=86400", { noTransform: true, maxAge: 86_400 }],
    [
      'no-cache="Set-Cookie, Set-Cookie2"',
      {
        noCache: ["Set-Cookie", "Set-Cookie2"],
      },
    ],
    ["Public,Max-Age=3600", { public: true, maxAge: 3600 }],
    // Requests: browsers' reloads, clients, proxies.
    ["no-cache", { noCache: true }],
    ["max-age=0", { maxAge: 0 }],
    ["no-cache, no-store", { noCache: true, noStore: true }],
    ["only-if-cached, max-stale", { onlyIfCached: true, maxStale: true }],
    ["max-stale=300, min-fresh=60", { maxStale: 300, minFresh: 60 }],
    ["max-age=60, stale-if-error=600", { maxAge: 60, staleIfError: 600 }],
  ] as [string, ParsedCacheControl][])("%s", (header, parsed) => {
    expect(parseCacheControl(header)).toEqual(parsed);
  });
});

describe("parseCacheControl: round trips through formatCacheControl", () => {
  it.each([
    [{ public: true, maxAge: 31_536_000, immutable: true }],
    [{ sMaxAge: 60, staleWhileRevalidate: 30, staleIfError: 600 }],
    [{ private: true, noStore: true }],
    [{ noStore: true, mustUnderstand: true }],
    [{ private: ["Set-Cookie"], maxAge: 0, mustRevalidate: true }],
    [{ noCache: ["Set-Cookie", "X-Session"], public: true, sMaxAge: 1 }],
    [
      {
        public: true,
        noCache: true,
        maxAge: 1,
        sMaxAge: 2,
        staleWhileRevalidate: 3,
        staleIfError: 4,
        mustRevalidate: true,
        proxyRevalidate: true,
        mustUnderstand: true,
        noTransform: true,
        immutable: true,
      },
    ],
    [{ maxAge: 2_147_483_648 }],
  ] as [CacheControlDirectives][])("%o", (directives) => {
    expect(parseCacheControl(formatCacheControl(directives))).toEqual(
      directives as ParsedCacheControl,
    );
  });

  it("every directive combination the types allow, 1000 drawn at random (seeded)", () => {
    const random = prng(20_261_028);
    const pick = (chance: number) => random() < chance;
    const seconds = () =>
      pick(0.1) ? 0 : Math.floor(random() * 2_147_483_648);
    const fields = () =>
      ["Set-Cookie", "X-Session", "Authorization"].filter(() => pick(0.6));
    for (let round = 0; round < 1000; round += 1) {
      const directives: Record<string, unknown> = {};
      const visibility = random();
      if (visibility < 0.3) {
        directives.public = true;
      } else if (visibility < 0.6) {
        const list = fields();
        directives.private = list.length > 0 && pick(0.5) ? list : true;
      }
      if (pick(0.3)) {
        const list = fields();
        directives.noCache = list.length > 0 && pick(0.5) ? list : true;
      }
      if (pick(0.25)) {
        directives.noStore = true;
      } else {
        for (const key of [
          "maxAge",
          "sMaxAge",
          "staleWhileRevalidate",
          "staleIfError",
        ]) {
          if (pick(0.4)) {
            directives[key] = seconds();
          }
        }
        if (pick(0.2)) {
          directives.immutable = true;
        }
      }
      for (const key of [
        "mustRevalidate",
        "proxyRevalidate",
        "mustUnderstand",
        "noTransform",
      ]) {
        if (pick(0.2)) {
          directives[key] = true;
        }
      }
      const header = formatCacheControl(directives);
      // A header in another letter case reads the same.
      for (const text of [header, header.toUpperCase()]) {
        const parsed = parseCacheControl(text);
        if (text === header) {
          expect(parsed).toEqual(directives as ParsedCacheControl);
        } else {
          // Upper-casing changes the field names, not which are listed.
          expect(Object.keys(parsed).sort()).toEqual(
            Object.keys(directives).sort(),
          );
        }
      }
    }
  });
});

describe("parseCacheControl: never throws", () => {
  it("on 5000 random strings over the header's alphabet (seeded)", () => {
    const random = prng(5861);
    const alphabet = 'abc-=,", \t\\09max-agepublicno-store=1"x';
    for (let round = 0; round < 5000; round += 1) {
      let text = "";
      const length = Math.floor(random() * 40);
      for (let i = 0; i < length; i += 1) {
        text += alphabet[Math.floor(random() * alphabet.length)];
      }
      const parsed = parseCacheControl(text);
      for (const key of Object.keys(parsed)) {
        expect(RESULT_KEYS.has(key)).toBe(true);
      }
      for (const value of Object.values(parsed)) {
        if (typeof value === "number") {
          expect(Number.isInteger(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(2_147_483_648);
        }
      }
    }
  });

  it("on a value that is not a string, from untyped code", () => {
    for (const value of [42, {}, [], true, Symbol("x")]) {
      expect(parseCacheControl(value as unknown as string)).toEqual({});
    }
  });
});
