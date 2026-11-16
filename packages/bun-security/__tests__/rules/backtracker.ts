/**
 * An instrumented backtracking matcher over the regex validator's parse
 * tree (T-L7-1): the strategy JavaScriptCore's engine uses (try each start
 * position, alternatives in order, greedy repeats longest first, backtrack
 * on failure), counting every step, so a pattern's cost on an input is a
 * number rather than a timing. Stops at `limit` steps.
 */
import type { CharSpec, ParsedRegex, RegexNode } from "../../lib/rules/regex";

/** What a run found. */
export interface StepCount {
  /** Whether the pattern matched somewhere. */
  readonly matched: boolean;
  /** The steps it took (at most `limit`). */
  readonly steps: number;
  /** Whether it stopped at the limit. */
  readonly exceeded: boolean;
}

/** Thrown to stop a run at its limit. */
class Exceeded extends Error {}

/** Whether `code` is in `spec`. */
function inSpec(spec: CharSpec, code: number, ignoreCase: boolean): boolean {
  const has = (c: number) => spec.ranges.some(([lo, hi]) => c >= lo && c <= hi);
  let found = has(code);
  if (!found && ignoreCase) {
    if (code >= 0x41 && code <= 0x5a) found = has(code + 0x20);
    else if (code >= 0x61 && code <= 0x7a) found = has(code - 0x20);
  }
  return spec.negated ? !found : found;
}

/** Whether the character at `i` is a word character. */
function isWord(input: string, i: number): boolean {
  if (i < 0 || i >= input.length) return false;
  const c = input.charCodeAt(i);
  return (
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    c === 0x5f
  );
}

/** Runs `parsed` over `input` the way a backtracking engine's `test()` does. */
export function countSteps(
  parsed: ParsedRegex,
  input: string,
  options: { ignoreCase?: boolean; limit?: number } = {},
): StepCount {
  const ignoreCase = options.ignoreCase ?? false;
  const limit = options.limit ?? 50_000_000;
  let steps = 0;
  const step = () => {
    if (++steps > limit) throw new Exceeded();
  };
  type K = (pos: number) => boolean;
  // Declared first: a sequence and a repeat both run nodes.
  let node: (n: RegexNode, pos: number, k: K) => boolean = () => false;

  const sequence = (
    seq: readonly RegexNode[],
    i: number,
    pos: number,
    k: K,
  ): boolean => {
    if (i === seq.length) return k(pos);
    return node(seq[i]!, pos, (next) => sequence(seq, i + 1, next, k));
  };

  const repeat = (
    n: Extract<RegexNode, { kind: "repeat" }>,
    count: number,
    pos: number,
    k: K,
  ): boolean => {
    step();
    const more = () =>
      count < n.max &&
      node(n.node, pos, (next) =>
        // An iteration that consumed nothing ends the loop, as the engine does.
        next === pos ? false : repeat(n, count + 1, next, k),
      );
    const stop = () => count >= n.min && k(pos);
    return n.lazy ? stop() || more() : more() || stop();
  };

  node = (n: RegexNode, pos: number, k: K): boolean => {
    step();
    switch (n.kind) {
      case "char":
        return (
          pos < input.length &&
          inSpec(n.spec, input.charCodeAt(pos), ignoreCase) &&
          k(pos + 1)
        );
      case "assert":
        switch (n.value) {
          case "^":
            return pos === 0 && k(pos);
          case "$":
            return pos === input.length && k(pos);
          case "b":
            return isWord(input, pos - 1) !== isWord(input, pos) && k(pos);
          case "B":
            return isWord(input, pos - 1) === isWord(input, pos) && k(pos);
        }
        return false;
      case "group":
        return n.alternatives.some((alt) => sequence(alt, 0, pos, k));
      case "repeat":
        return repeat(n, 0, pos, k);
    }
  };

  try {
    for (let start = 0; start <= input.length; start++) {
      if (
        parsed.alternatives.some((alt) => sequence(alt, 0, start, () => true))
      ) {
        return { matched: true, steps, exceeded: false };
      }
    }
    return { matched: false, steps, exceeded: false };
  } catch (error) {
    if (error instanceof Exceeded)
      return { matched: false, steps: limit, exceeded: true };
    throw error;
  }
}
