/**
 * `lib/utils/expressPath.ts` against the real path-to-regexp 8 (a
 * devDependency pinned to Express 5.3's version, 8.4.2), with Express 5's
 * options: trailing slashes loosened and tolerated, `decodeParam`, a route
 * (`end`) and a `use()` prefix, case-insensitive and sensitive. The port
 * must give the same captures (wildcards split and decoded per segment) and
 * throw the same errors, message for message.
 *
 * Then the registration rule (`compileRoutePath`): Express mode, routejs mode
 * with named wildcards bridged, or a `PathSyntaxError`; and `route()`'s path
 * builder, which encodes as path-to-regexp's `compile` does.
 */
import { describe, expect, it } from "bun:test";
import { match as referenceMatch } from "path-to-regexp";
import {
  assertExpressPath,
  CAPTURE_PARAM,
  compileExpressPath,
  compileRoutePath,
  PathSyntaxError,
} from "../lib/utils/expressPath";

/** A seeded PRNG (an LCG), so a failure names a reproducible seed. */
function lcg(seed: number) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state / 0x80000000;
  };
}

const NAMES = ["a", "b", "c", "path", "x"];
const LITERALS = ["a", "b", "ab", "x.y", "a-b", "v1", "A", "files", "é", "~u"];
const VALUES = [
  "a",
  "b",
  "x-y",
  "a.b",
  "1",
  "A",
  "%2F",
  "a%2Fb",
  "%E2%9C%93",
  "-",
  ".",
  "%E0%A4%A",
  "x.y",
  "ab",
  "files",
  "%C3%A9",
  "~u",
];
const NOISE = [
  "/",
  "/a",
  "/a/b",
  "/A/B",
  "/files/",
  "/files/x",
  "/x.y",
  "/a-b",
  "//",
  "/a//b",
  "/%2F",
  "/v1/a/b/c",
];

/** Random patterns over path-to-regexp's grammar, some malformed, with paths for each. */
function generate(count: number, seed: number): [string, string[]][] {
  const random = lcg(seed);
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(random() * list.length)];
  const atoms: (() => string)[] = [
    () => `/${pick(LITERALS)}`,
    () => `/:${pick(NAMES)}`,
    () => `/*${pick(NAMES)}`,
    () => `{/:${pick(NAMES)}}`,
    () => `{/*${pick(NAMES)}}`,
    () => `{/${pick(LITERALS)}}`,
    () => `/:${pick(NAMES)}-:${pick(NAMES)}`,
    () => `/:${pick(NAMES)}.:${pick(NAMES)}`,
    () => `/${pick(LITERALS)}-:${pick(NAMES)}`,
    () => `/:${pick(NAMES)}{.:${pick(NAMES)}}`,
    () => `{/:${pick(NAMES)}{/:${pick(NAMES)}}}`,
    () => `/\\(${pick(LITERALS)}\\)`,
    () => `/*${pick(NAMES)}-${pick(LITERALS)}`,
    () => `/*${pick(NAMES)}.${pick(["json", "txt"])}`,
    () => `/:${pick(NAMES)}*${pick(NAMES)}`,
    () => `{-:${pick(NAMES)}}`,
    () => `/:"${pick(["q x", "a-b"])}"`,
    () =>
      pick([
        "/*",
        "?",
        "+",
        "(",
        ")",
        "}",
        "{",
        ":",
        "/:x?",
        "/:x(\\d+)",
        "[",
        "!",
        "\\",
      ]),
    () => "/",
    () => `/{*${pick(NAMES)}}`,
  ];
  const instantiate = (pattern: string): string => {
    let out = "";
    let i = 0;
    const groups: boolean[] = [];
    const keep = () => groups.every(Boolean);
    while (i < pattern.length) {
      const char = pattern[i];
      if (char === "\\") {
        if (keep()) out += pattern[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (char === "{") {
        groups.push(random() < 0.6);
        i++;
        continue;
      }
      if (char === "}") {
        groups.pop();
        i++;
        continue;
      }
      if (char === ":" || char === "*") {
        let j = i + 1;
        if (pattern[j] === '"') {
          j = pattern.indexOf('"', j + 1) + 1 || pattern.length;
        } else {
          while (j < pattern.length && /[\w$]/.test(pattern[j])) j++;
        }
        if (keep()) {
          const segments = 1 + Math.floor(random() * 3);
          const value = () => pick(VALUES);
          out +=
            char === ":"
              ? value()
              : Array.from({ length: segments }, value).join("/");
        }
        i = j;
        continue;
      }
      if (keep()) out += char;
      i++;
    }
    if (!out.startsWith("/")) out = `/${out}`;
    const r = random();
    if (r < 0.1) out += "/";
    else if (r < 0.15) out += "//";
    else if (r < 0.2) out += "/extra";
    else if (r < 0.25) out = out.toUpperCase();
    else if (r < 0.3) out = out.replace(/\/[^/]*$/, "");
    return out;
  };

  const seen = new Set<string>();
  const out: [string, string[]][] = [];
  let attempts = 0;
  while (out.length < count && attempts++ < count * 50) {
    let pattern = "";
    const atomCount = 1 + Math.floor(random() * 4);
    for (let k = 0; k < atomCount; k++) pattern += pick(atoms)();
    if (random() < 0.08) pattern = pattern.replace(/^\//, "");
    if (random() < 0.1) pattern += "/";
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    out.push([
      pattern,
      [
        ...Array.from({ length: 10 }, () => instantiate(pattern)),
        pick(NOISE),
        pick(NOISE),
      ],
    ]);
  }
  return out;
}

/** Express's `loosen`. */
const loosen = (path: string) =>
  path === "/" ? path : path.replace(/\/+$/, "");

/** Express's router `decodeParam`, its error reduced to a comparable string. */
function decodeParam(value: string): string {
  if (value.length === 0) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`DECODE ${value}`);
  }
}

type Matcher = (path: string) => string;

/** path-to-regexp 8.4.2 as Express 5's router calls it. */
function reference(pattern: string, end: boolean, sensitive: boolean): Matcher {
  let fn: ReturnType<typeof referenceMatch>;
  try {
    fn = referenceMatch(loosen(pattern), {
      end,
      sensitive,
      trailing: true,
      decode: decodeParam,
    });
  } catch (error) {
    const message = `THROW ${(error as Error).message}`;
    return () => message;
  }
  return (path) => {
    try {
      const result = fn(path);
      return result ? JSON.stringify(Object.entries(result.params)) : "NO";
    } catch (error) {
      return `ERR ${(error as Error).message}`;
    }
  };
}

/** The port, its captures published as `BunRouter.matchRoute` publishes them. */
function ported(pattern: string, end: boolean, sensitive: boolean): Matcher {
  let compiled: ReturnType<typeof compileExpressPath>;
  try {
    compiled = compileExpressPath(pattern, { end, sensitive });
  } catch (error) {
    const message =
      error instanceof PathSyntaxError
        ? `THROW ${error.message}`
        : `NOT A PathSyntaxError ${String(error)}`;
    return () => message;
  }
  const { regexp, names, kinds } = compiled;
  return (path) => {
    const result = regexp.exec(path);
    if (!result) return "NO";
    const params: Record<string, string | string[]> = Object.create(null);
    try {
      for (let i = 1; i < result.length; i++) {
        const value = result[i];
        if (value === undefined) continue;
        params[names[i - 1]] =
          (kinds?.[i - 1] ?? CAPTURE_PARAM) === CAPTURE_PARAM
            ? decodeParam(value)
            : value.split("/").map(decodeParam);
      }
    } catch (error) {
      return `ERR ${(error as Error).message}`;
    }
    return JSON.stringify(Object.entries(params));
  };
}

const SEEDS = [1, 2, 3];
/**
 * About 1-2 s alone; a worker of a 16-way `--parallel` run measured 8.3 s,
 * past bun:test's 5 s default.
 */
const FUZZ_TIMEOUT_MS = 30_000;
const PATTERNS = 2000;

describe("expressPath: differential against path-to-regexp 8.4.2", () => {
  it(
    `agrees on ${SEEDS.length} seeds × ${PATTERNS} patterns (captures and errors)`,
    () => {
      const misses: string[] = [];
      let comparisons = 0;
      let matched = 0;
      let rejected = 0;
      for (const seed of SEEDS) {
        for (const [pattern, paths] of generate(PATTERNS, seed)) {
          for (const end of [true, false]) {
            for (const sensitive of [false, true]) {
              const expected = reference(pattern, end, sensitive);
              const actual = ported(pattern, end, sensitive);
              for (const path of paths) {
                const want = expected(path);
                const got = actual(path);
                comparisons++;
                if (want.startsWith("THROW")) rejected++;
                else if (want !== "NO") matched++;
                if (want !== got && misses.length < 10) {
                  misses.push(
                    `seed ${seed} ${JSON.stringify(pattern)} ${JSON.stringify(path)} end=${end} sensitive=${sensitive}: expected ${want}, got ${got}`,
                  );
                }
              }
            }
          }
        }
      }
      expect(misses).toEqual([]);
      // Each of the three outcomes is exercised, not only misses.
      expect(comparisons).toBe(SEEDS.length * PATTERNS * 12 * 4);
      expect(matched).toBeGreaterThan(comparisons / 4);
      expect(rejected).toBeGreaterThan(comparisons / 10);
    },
    FUZZ_TIMEOUT_MS,
  );

  it(
    "gives a use() prefix the baseUrl Express gives it",
    () => {
      // What a prefix matched becomes `req.baseUrl`, one trailing slash
      // stripped (Express's router; `matchBaseUrl` in BunRouter.ts). The raw
      // texts differ where a run of slashes follows the prefix: routejs's
      // `\/?(?=\/|$)` end takes one slash path-to-regexp's `(?:\/$)?` leaves
      // (`/api//x`: `/api/` against `/api`), which the strip makes equal again,
      // except before three or more slashes.
      const baseUrl = (matched: string) =>
        matched.endsWith("/") ? matched.slice(0, -1) : matched;
      const misses: string[] = [];
      let compared = 0;
      let rawDiffer = 0;
      for (const seed of SEEDS) {
        for (const [pattern, paths] of generate(PATTERNS, seed)) {
          let expected: ReturnType<typeof referenceMatch>;
          let actual: RegExp;
          try {
            expected = referenceMatch(loosen(pattern), {
              end: false,
              trailing: true,
              decode: false,
            });
            actual = compileExpressPath(pattern, { end: false }).regexp;
          } catch {
            continue;
          }
          for (const path of paths) {
            const want = expected(path);
            const got = actual.exec(path);
            if (!want || !got) {
              continue;
            }
            compared++;
            if (want.path !== got[0]) {
              rawDiffer++;
            }
            if (
              baseUrl(want.path) !== baseUrl(got[0]) &&
              !path.includes("///") &&
              misses.length < 10
            ) {
              misses.push(
                `seed ${seed} ${JSON.stringify(pattern)} ${JSON.stringify(path)}: path-to-regexp ${JSON.stringify(want.path)}, ours ${JSON.stringify(got[0])}`,
              );
            }
          }
        }
      }
      expect(misses).toEqual([]);
      expect(compared).toBeGreaterThan(10_000);
      // The comparison sees the shapes where the raw texts differ.
      expect(rawDiffer).toBeGreaterThan(100);
    },
    FUZZ_TIMEOUT_MS,
  );

  it("negative control: an emission that differs from path-to-regexp is caught", () => {
    // `(.*)` for a named wildcard (routejs's bare `*`): an empty tail matches,
    // where path-to-regexp needs one character.
    const wrong = new RegExp(
      compileExpressPath("/files/*path").regexp.source.replace(
        "([^]+)",
        "(.*)",
      ),
      "i",
    );
    expect(reference("/files/*path", true, false)("/files/")).toBe("NO");
    expect(wrong.exec("/files/")).not.toBeNull();
  });
});

describe("compileExpressPath: the emitted shapes", () => {
  it("compiles a plain path byte-identically to routejs", () => {
    for (const [path, source] of [
      ["/users", "^\\/users\\/?$"],
      ["/users/:id", "^\\/users\\/([^\\/]+?)\\/?$"],
      ["/x.json", "^\\/x\\.json\\/?$"],
      ["/a\\:b", "^\\/a\\:b\\/?$"],
    ] as const) {
      expect(compileExpressPath(path).regexp.source).toBe(source);
    }
  });

  it("emits an optional group as (?:…)? where that is equivalent", () => {
    expect(compileExpressPath("/files{/*path}").regexp.source).toBe(
      "^\\/files(?:\\/([^]+))?\\/?$",
    );
    expect(compileExpressPath("/x/{*path}").regexp.source).toBe(
      "^\\/x\\/(?:([^]+))?\\/?$",
    );
    // A wildcard before the group could eat into it: an alternation.
    expect(compileExpressPath("/*a{/b}").regexp.source).toContain("|");
  });

  it("is case-insensitive unless sensitive", () => {
    expect(compileExpressPath("/a").regexp.flags).toBe("i");
    expect(compileExpressPath("/a", { sensitive: true }).regexp.flags).toBe("");
  });

  it("reports which captures are wildcards", () => {
    expect(compileExpressPath("/u/:id").kinds).toBeUndefined();
    const { names, kinds } = compileExpressPath("/u/:id/*rest");
    expect(names).toEqual(["id", "rest"]);
    expect(kinds).toEqual([0, 1]);
  });
});

describe("assertExpressPath", () => {
  it("accepts what Express registers and throws what it rejects", () => {
    expect(() => assertExpressPath("/a/:b{/*c}")).not.toThrow();
    expect(() => assertExpressPath("/a/:b?")).toThrow(PathSyntaxError);
    expect(() => assertExpressPath("/a/:b?")).toThrow(
      "Unexpected ? at index 5: /a/:b?; visit https://git.new/pathToRegexpError for info",
    );
  });

  it("names the path as written, not loosened", () => {
    expect(() => assertExpressPath("/:a:b/")).toThrow(
      'Missing text before "b" param: /:a:b/;',
    );
  });

  it("is a TypeError, as path-to-regexp's PathError is", () => {
    let caught: unknown;
    try {
      assertExpressPath("*");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as PathSyntaxError).originalPath).toBe("*");
    expect((caught as PathSyntaxError).reason).toBe(
      "Missing parameter name at index 1",
    );
  });
});

describe("compileRoutePath: the registration rule", () => {
  /** How a path registers: `express`, `routejs`, or `throws: <reason>`. */
  function modeOf(path: string): string {
    try {
      return compileRoutePath(path).mode;
    } catch (error) {
      expect(error).toBeInstanceOf(PathSyntaxError);
      return `throws: ${(error as PathSyntaxError).reason}`;
    }
  }

  it("compiles what path-to-regexp accepts in Express mode", () => {
    for (const path of [
      "/users/:id",
      "/files/*path",
      "/files{/*path}",
      "/opt{/:x}",
      '/:"q x"',
      "/:été",
      "/:$x",
      "/u/:a-:b",
      "*splat",
    ]) {
      expect(`${path} ${modeOf(path)}`).toBe(`${path} express`);
    }
  });

  it("keeps routejs paths (and bridges their named wildcards)", () => {
    for (const path of [
      "/legacy/*",
      "*",
      "{*}",
      "/:x?",
      "/:x(\\d+)",
      "/reports(/archived)?",
      "/files/:bucket/:version?/*key",
      "/n/(\\d+)/*rest",
    ]) {
      expect(`${path} ${modeOf(path)}`).toBe(`${path} routejs`);
    }
  });

  it("throws path-to-regexp's error for garbage", () => {
    expect(modeOf("/a{/b")).toBe(
      "throws: Unexpected end at index 5, expected }",
    );
    expect(modeOf("/a/}")).toBe("throws: Unexpected } at index 3");
    expect(modeOf("/a/[b]")).toBe("throws: Unexpected [ at index 3");
    expect(modeOf("/a!")).toBe("throws: Unexpected ! at index 2");
    expect(modeOf("/a\\")).toBe("throws: Unexpected end after \\ at index 3");
    expect(modeOf("/:x:y")).toBe('throws: Missing text before "y" param');
    expect(modeOf("/*n*m")).toBe('throws: Missing text before "m" wildcard');
    expect(modeOf("/:")).toBe("throws: Missing parameter name at index 2");
  });

  it("names both syntaxes when a path mixes them", () => {
    expect(modeOf("/a{/:b}/:c?")).toBe(
      'throws: Unexpected ? at index 10; the path mixes path-to-regexp 8 syntax ({…}, :"…") with routejs syntax (?, +, (…), a bare *)',
    );
  });

  it("rejects a named wildcard straight after a param in a routejs path", () => {
    expect(modeOf("/u/:id*rest?")).toBe(
      'throws: Missing text before "rest" wildcard',
    );
  });

  it("maps routejs's numbered keys to the bridged names and the bare ones", () => {
    const plan = compileRoutePath("/n/(\\d+)/*rest/*");
    if (plan.mode !== "routejs" || plan.remap === undefined) {
      throw new Error(`expected a bridged routejs plan, got ${plan.mode}`);
    }
    // routejs numbers the group, the bridged wildcard and the bare `*` 0, 1, 2.
    expect(plan.path).toBe("/n/(\\d+)/([^]+)/*");
    expect(plan.remap([0, 1, 2])).toEqual({
      names: [0, "rest", 1],
      kinds: [0, 1, 0],
    });
  });
});

describe("route(): path-to-regexp's compile for an Express-mode path", () => {
  /** The path builder of an Express-mode path. */
  function builder(path: string) {
    const plan = compileRoutePath(path);
    if (plan.mode !== "express") {
      throw new Error(`${path} is not an Express-mode path`);
    }
    return plan.toPath;
  }

  it("encodes each wildcard segment and joins them with /", () => {
    const toPath = builder("/files/*path");
    expect(toPath({ path: ["a/b", "c d", "%", ""] })).toBe(
      "/files/a%2Fb/c%20d/%25/",
    );
  });

  it("encodes a param", () => {
    expect(builder("/u/:id")({ id: "a b/c" })).toBe("/u/a%20b%2Fc");
  });

  it("drops an optional group whose params are missing", () => {
    const toPath = builder("/opt{/:x}");
    expect(toPath({})).toBe("/opt");
    expect(toPath({ x: "1" })).toBe("/opt/1");
  });

  it("takes a number as its string, as routejs's route() did", () => {
    expect(builder("/acct/:acct/inv/:no")({ acct: "acme", no: 7 })).toBe(
      "/acct/acme/inv/7",
    );
    expect(builder("/f/*p")({ p: ["a", 1] })).toBe("/f/a/1");
    expect(() => builder("/u/:id")({ id: { x: 1 } })).toThrow(
      'Expected "id" to be a string',
    );
  });

  it("throws on a missing required param or a non-array wildcard", () => {
    expect(() => builder("/u/:id")({})).toThrow("Missing parameters: id");
    expect(() => builder("/f/*p")({ p: "a/b" })).toThrow(
      'Expected "p" to be a non-empty array',
    );
  });
});
