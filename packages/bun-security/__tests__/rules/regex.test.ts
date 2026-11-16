/**
 * The regex validator (layers.md L7, plan D12) and T-L7-1: ReDoS-shaped
 * patterns are refused; every accepted pattern stays within a step budget
 * on adversarial inputs, counted by an instrumented backtracking matcher
 * over the same parse tree (no timing assertion). The negative controls
 * run the refused shapes through the same matcher and watch them blow up.
 */
import { describe, expect, it, setDefaultTimeout } from "bun:test";
import {
  compileSafeRegex,
  parseRegex,
  RegexRefusal,
  regexRefusal,
} from "../../lib/rules/regex";
import type { CharSpec, RegexNode } from "../../lib/rules/regex";
import { seededRandom } from "../helpers";
import { countSteps } from "./backtracker";

// The budget checks below count up to 16.7 million matcher steps a case:
// 0.1–1.1 s of CPU each on an idle machine (the grammar property about 2 s),
// 2–5 s each at a load of 12, and past bun:test's 5 s default on a busier one
// (a negative control took 6.4 s under a loaded `--randomize` run). The
// work is the assertion, so it is given room rather than cut.
setDefaultTimeout(30_000);

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
    [`${"a?".repeat(25)}${"a".repeat(25)}`, "a".repeat(24)],
  ])(
    "negative control: refused %p exceeds the budget on a short input in the same matcher",
    (source, input) => {
      expect(regexRefusal(source)).toBeDefined();
      const run = countSteps(parseRegex(source), input, { limit: BUDGET });
      expect(run.exceeded).toBe(true);
    },
  );

  it("negative control: refused `\\d*\\d*\\d*\\d*x` grows faster than n² (quartic), so it passes the budget on a short input", () => {
    // Polynomial, not exponential: counting it to the budget on a
    // 200-character input took 1.1 s idle and 6.4 s loaded. Its growth is
    // measured on two small inputs instead, where an accepted pattern's is
    // held to at most 4.5 per doubling (the n² bound below).
    const source = "\\d*\\d*\\d*\\d*x";
    expect(regexRefusal(source)).toBeDefined();
    const parsed = parseRegex(source);
    const steps = (n: number): number => {
      const run = countSteps(parsed, `${"1".repeat(n)}\u0001`, {
        limit: BUDGET,
      });
      expect(run.exceeded).toBe(false);
      return run.steps;
    };
    const small = steps(20);
    const double = steps(40);
    // Doubling the input multiplies the work by about 16 (measured 20.8):
    // far past the 4.5 an accepted pattern may take.
    const growth = double / small;
    expect(growth).toBeGreaterThan(12);
    // At that rate, the original 200-character input passes the budget many
    // times over: the quartic from 40 characters, five doublings' worth.
    expect(double * (200 / 40) ** Math.log2(growth)).toBeGreaterThan(
      BUDGET * 10,
    );
  });

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
