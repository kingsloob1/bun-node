/**
 * The regex validator (layers.md L7, plan D12) and T-L7-1: ReDoS-shaped
 * patterns are refused; every accepted pattern stays within a step budget
 * on adversarial inputs, counted by an instrumented backtracking matcher
 * over the same parse tree (no timing assertion). The negative controls
 * run the refused shapes through the same matcher and watch them blow up.
 */
import { describe, expect, it } from "bun:test";
import {
  compileSafeRegex,
  parseRegex,
  RegexRefusal,
  regexRefusal,
} from "../../lib/rules/regex";
import type { CharSpec, RegexNode } from "../../lib/rules/regex";
import { seededRandom } from "../helpers";
import { countSteps } from "./backtracker";

/** The input lengths the budget is checked at; 1,024 is `maxRegexInput`'s default. */
const SIZES = [256, 512, 1024] as const;

/**
 * Steps allowed at 1,024 characters: a constant times n² (each of n start
 * positions may scan the rest once), which is what an accepted pattern can
 * cost on the default input cap.
 */
const BUDGET = 16 * 1024 * 1024;

/** Characters a spec matches (a few), and one it does not, to build inputs from. */
function samples(spec: CharSpec): string[] {
  if (spec.negated) return ["a", "0", " "];
  const out: string[] = [];
  for (const [lo, hi] of spec.ranges.slice(0, 3)) {
    out.push(String.fromCodePoint(lo));
    if (hi !== lo) out.push(String.fromCodePoint(hi));
  }
  return out;
}

/** Every character sample a pattern's atoms give. */
function charsIn(nodes: readonly RegexNode[], into: Set<string>): Set<string> {
  for (const node of nodes) {
    if (node.kind === "char") for (const c of samples(node.spec)) into.add(c);
    if (node.kind === "group")
      for (const alt of node.alternatives) charsIn(alt, into);
    if (node.kind === "repeat") charsIn([node.node], into);
  }
  return into;
}

/**
 * Adversarial inputs of length `n` for a pattern: runs of each character it
 * mentions, a run of all of them in turn, each ending in a character that
 * breaks the match, which is what makes a backtracking engine try every split.
 */
function adversarial(source: string, n: number): string[] {
  const parsed = parseRegex(source);
  const chars = [...charsIn(parsed.alternatives.flat(), new Set())];
  const pumps = [...chars, chars.join("")].filter((pump) => pump.length > 0);
  return pumps.map((pump) => {
    const body = pump.repeat(Math.ceil(n / pump.length)).slice(0, n - 1);
    return `${body}\u0001`;
  });
}

/** The most steps the matcher takes for `source` over the adversarial inputs of length `n`. */
function worstSteps(
  source: string,
  n: number,
  limit = BUDGET * 4,
): { steps: number; exceeded: boolean } {
  const parsed = parseRegex(source);
  let worst = { steps: 0, exceeded: false };
  for (const input of adversarial(source, n)) {
    const run = countSteps(parsed, input, { limit });
    if (run.exceeded) return { steps: run.steps, exceeded: true };
    if (run.steps > worst.steps) worst = run;
  }
  return worst;
}

describe("regexRefusal: what is refused", () => {
  it.each([
    ["(a+)+$", "nested quantifiers"],
    ["(a*b?)*", "nested quantifiers"],
    ["(?:x+y)*", "nested quantifiers"],
    ["(a|aa)*$", "start with the same character"],
    ["(?:(?:a|ab)c){50}", "start with the same character"],
    ["(a|)+", "empty string"],
    ["\\d+\\d*x", "variable repeats"],
    [".*a.*", "variable repeats"],
    ["a?a?a?aaa", "variable repeats"],
    ["(a|ab)(a|ab)", "variable repeats"],
    ["a{0,1000}a{0,1000}b", "variable repeats"],
    ["(\\w)\\1", "backreferences"],
    ["(?<x>a)\\k<x>", "backreferences"],
    ["(?=a)b", "lookarounds"],
    ["(?<!a)b", "lookarounds"],
    ["\\p{L}+", "Unicode property"],
    ["(?i:a)", "inline modifiers"],
    ["a{1001}", "over 1000"],
    ["x".repeat(257), "longer than 256"],
    ["[", "unclosed"],
  ])("refuses %p (%s)", (source, reason) => {
    expect(regexRefusal(source)).toContain(reason);
    expect(() => compileSafeRegex(source)).toThrow(RegexRefusal);
  });

  it.each([
    "^[a-z]+\\d+$",
    "\\w+@\\w+\\.com",
    "^/api/v\\d+/users/\\d+$",
    "sqlmap|nikto|nmap",
    "(?:ab|cd)+",
    "[^/]+\\.php$",
    "(?:\\.\\./)+",
    "\\d{3}-\\d{4}",
    "https?://\\S+",
    "^[\\w.+-]+@[\\w-]+\\.[a-z]{2,}$",
    "union\\s+select",
  ])("accepts %p, and the engine compiles it with the u flag", (source) => {
    expect(regexRefusal(source)).toBeUndefined();
    expect(compileSafeRegex(source).flags).toBe("u");
    expect(compileSafeRegex(source, true).flags).toBe("iu");
  });

  it("widens the overlap checks under ignoreCase", () => {
    expect(regexRefusal("[a-z]+[A-Z]+")).toBeUndefined();
    expect(regexRefusal("[a-z]+[A-Z]+", true)).toContain("variable repeats");
  });
});

describe("T-L7-1: accepted patterns stay within budget; refused ones blow up", () => {
  it.each([
    ["(a+)+$", `${"a".repeat(30)}\u0001`],
    ["(a|aa)*$", `${"a".repeat(40)}\u0001`],
    ["^(a|a?)+$", `${"a".repeat(30)}\u0001`],
    ["\\d*\\d*\\d*\\d*x", `${"1".repeat(200)}\u0001`],
    [`${"a?".repeat(25)}${"a".repeat(25)}`, "a".repeat(24)],
  ])(
    "negative control: refused %p exceeds the budget on a short input in the same matcher",
    (source, input) => {
      expect(regexRefusal(source)).toBeDefined();
      const run = countSteps(parseRegex(source), input, { limit: BUDGET });
      expect(run.exceeded).toBe(true);
    },
  );

  it.each([
    "^[a-z]+\\d+$",
    "\\w+@\\w+\\.com",
    "(?:ab|cd)+x",
    "[^/]+\\.php$",
    "https?://\\S+z",
    "^[\\w.+-]+@[\\w-]+\\.[a-z]{2,}$",
    "a+b",
  ])(
    "%p stays under the budget, growing no faster than n² from 256 to 1,024 characters",
    (source) => {
      const steps = SIZES.map((n) => worstSteps(source, n));
      for (const run of steps) expect(run.exceeded).toBe(false);
      expect(steps[2]!.steps).toBeLessThanOrEqual(BUDGET);
      // Doubling the input at most quadruples the work (plus slack).
      expect(steps[2]!.steps).toBeLessThanOrEqual(steps[1]!.steps * 4.5 + 1000);
      expect(steps[1]!.steps).toBeLessThanOrEqual(steps[0]!.steps * 4.5 + 1000);
    },
  );

  it("property: random patterns from a grammar; every accepted one stays under the budget at 1,024 characters", () => {
    const seed = Number(
      process.env.REGEX_PROPERTY_SEED ?? Date.now() % 1_000_000,
    );
    const random = seededRandom(seed);
    const pick = <T>(items: readonly T[]): T =>
      items[Math.floor(random() * items.length)]!;
    const atoms = [
      "a",
      "b",
      "1",
      "/",
      "\\.",
      "[a-z]",
      "[0-9]",
      "\\d",
      "\\w",
      "\\s",
      ".",
      "[^/]",
      "x",
    ];
    const quantifiers = [
      "",
      "",
      "",
      "*",
      "+",
      "?",
      "{2}",
      "{1,3}",
      "{2,}",
      "*?",
    ];
    // Declared first: an atom may hold a group of sequences.
    let sequence: (depth: number) => string = () => "";
    const atom = (depth: number): string => {
      if (depth < 2 && random() < 0.2) {
        const branches = Array.from(
          { length: 1 + Math.floor(random() * 3) },
          () => sequence(depth + 1),
        );
        return `(?:${branches.join("|")})`;
      }
      return pick(atoms);
    };
    sequence = (depth: number): string =>
      Array.from(
        { length: 1 + Math.floor(random() * 3) },
        () => atom(depth) + pick(quantifiers),
      ).join("");
    let accepted = 0;
    let refused = 0;
    const failures: string[] = [];
    for (let i = 0; i < 300; i++) {
      const source =
        (random() < 0.3 ? "^" : "") + sequence(0) + (random() < 0.3 ? "$" : "");
      if (regexRefusal(source) !== undefined) {
        refused++;
        continue;
      }
      accepted++;
      const run = worstSteps(source, 1024);
      if (run.exceeded || run.steps > BUDGET)
        failures.push(`${source}: ${run.steps} steps`);
    }
    // Printed so a failing run can be reproduced (REGEX_PROPERTY_SEED).
    console.log(
      `regex property seed ${seed}: ${accepted} accepted, ${refused} refused`,
    );
    expect(failures).toEqual([]);
    expect(accepted).toBeGreaterThan(30);
    expect(refused).toBeGreaterThan(30);
  }, 120_000);

  it("the instrumented matcher agrees with the engine on what matches", () => {
    const random = seededRandom(7);
    const sources = [
      "^[a-z]+\\d+$",
      "(?:ab|cd)+x",
      "a+b",
      "https?://\\S+z",
      "\\bfoo\\b",
      "[^/]+\\.php$",
    ];
    const alphabet = "abcdx01/.:fo hpt";
    for (const source of sources) {
      const parsed = parseRegex(source);
      const regex = compileSafeRegex(source);
      for (let i = 0; i < 200; i++) {
        const input = Array.from(
          { length: Math.floor(random() * 12) },
          () => alphabet[Math.floor(random() * alphabet.length)],
        ).join("");
        expect([source, input, countSteps(parsed, input).matched]).toEqual([
          source,
          input,
          regex.test(input),
        ]);
      }
    }
  });
});
