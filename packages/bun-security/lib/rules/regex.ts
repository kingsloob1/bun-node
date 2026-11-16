/**
 * Regular expressions in request rules, under restrictions (layers.md L7,
 * plan D12). JavaScriptCore's engine backtracks, JavaScript has no regex
 * timeout and Bun ships no linear-time engine, so a pattern is accepted only
 * when its shape rules out the blow-ups a backtracking engine is open to:
 *
 * - no backreferences, lookarounds, Unicode property escapes or inline
 *   modifiers;
 * - no quantifier inside a quantified group (star height at most 1), so
 *   `(a+)+` and `(a*b?)*` are refused;
 * - no quantified group that can match the empty string, or whose
 *   alternatives can start with the same character, so `(a|aa)*` and
 *   `(a|)+` are refused;
 * - no two choices (a repeat of variable count, `*`, `+`, `?`, `{2,5}`, or
 *   an alternation whose branches start alike) whose characters overlap
 *   with nothing between them that only one can match, so `\d+\d*x`,
 *   `.*a.*`, `a?a?aa` and `(a|ab)(a|ab)` are refused (each such pair
 *   multiplies the ways to split the input);
 * - at most 256 characters, and repetition counts at most 1,000.
 *
 * What is left costs at most a constant times the input's length per start
 * position, and the input a rule reads is capped (`maxRegexInput`), so a
 * match costs a bounded number of steps. The parser here is the one the
 * validator reads; the tests run every accepted shape through an
 * instrumented backtracking matcher over the same tree to count its steps.
 */

/** The longest pattern accepted. */
export const MAX_REGEX_LENGTH = 256;

/** The largest repetition count accepted (`{n}`, `{n,m}`). */
export const MAX_REGEX_REPEAT = 1000;

/** An inclusive range of code points. */
export type CodeRange = readonly [number, number];

/** A set of characters one regex atom matches. */
export interface CharSpec {
  /** The ranges it matches (or, when {@link negated}, does not). */
  readonly ranges: readonly CodeRange[];
  /** Whether it matches every character outside {@link ranges}. */
  readonly negated: boolean;
}

/** A node of a parsed pattern. */
export type RegexNode =
  | {
      /** One character from a set: a literal, an escape, a class or `.`. */
      readonly kind: "char";
      /** The set. */
      readonly spec: CharSpec;
    }
  | {
      /** A zero-width assertion. */
      readonly kind: "assert";
      /** Which: start, end, word boundary, not a word boundary. */
      readonly value: "^" | "$" | "b" | "B";
    }
  | {
      /** A group: its alternatives, each a sequence. */
      readonly kind: "group";
      /** The alternatives. */
      readonly alternatives: readonly (readonly RegexNode[])[];
    }
  | {
      /** A quantified node. */
      readonly kind: "repeat";
      /** What repeats. */
      readonly node: RegexNode;
      /** The least count. */
      readonly min: number;
      /** The greatest count; `Infinity` for unbounded. */
      readonly max: number;
      /** Whether it is lazy (`*?`). */
      readonly lazy: boolean;
    };

/** A parsed pattern: its top-level alternatives. */
export interface ParsedRegex {
  /** The alternatives, each a sequence of nodes. */
  readonly alternatives: readonly (readonly RegexNode[])[];
}

/** Why a pattern was refused. */
export class RegexRefusal extends Error {
  constructor(
    /** What is wrong, for the policy's issue. */
    message: string,
  ) {
    super(message);
    this.name = "RegexRefusal";
  }
}

/** `\d`. */
const DIGITS: readonly CodeRange[] = [[0x30, 0x39]];
/** `\w`. */
const WORD: readonly CodeRange[] = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];
/** `\s`, as JavaScript defines it. */
const SPACE: readonly CodeRange[] = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];
/** The line terminators `.` does not match. */
const LINE_TERMINATORS: readonly CodeRange[] = [
  [0x0a, 0x0a],
  [0x0d, 0x0d],
  [0x2028, 0x2029],
];

/** The characters that must be escaped to be literal outside a class. */
const SYNTAX = new Set([..."^$\\.*+?()[]{}|/"]);

/** A recursive-descent parser over the pattern's code points. */
class Parser {
  /** The pattern's code points. */
  readonly #chars: readonly string[];
  /** Where it is. */
  #at = 0;

  constructor(
    /** The pattern. */
    source: string,
  ) {
    this.#chars = [...source];
  }

  /** Parses the whole pattern. */
  parse(): ParsedRegex {
    const alternatives = this.#disjunction();
    if (this.#at < this.#chars.length) {
      throw new RegexRefusal(
        `unexpected ${JSON.stringify(this.#chars[this.#at])} at ${this.#at}`,
      );
    }
    return { alternatives };
  }

  /** The next character, unread. */
  #peek(offset = 0): string | undefined {
    return this.#chars[this.#at + offset];
  }

  /** Reads one character. */
  #next(): string {
    const char = this.#chars[this.#at];
    if (char === undefined)
      throw new RegexRefusal("unexpected end of the pattern");
    this.#at++;
    return char;
  }

  /** `a|b|c`. */
  #disjunction(): RegexNode[][] {
    const alternatives: RegexNode[][] = [this.#alternative()];
    while (this.#peek() === "|") {
      this.#at++;
      alternatives.push(this.#alternative());
    }
    return alternatives;
  }

  /** A sequence of terms, up to `|`, `)` or the end. */
  #alternative(): RegexNode[] {
    const terms: RegexNode[] = [];
    for (;;) {
      const char = this.#peek();
      if (char === undefined || char === "|" || char === ")") return terms;
      const atom = this.#atom();
      terms.push(this.#quantified(atom));
    }
  }

  /** One atom or assertion. */
  #atom(): RegexNode {
    const char = this.#next();
    switch (char) {
      case "^":
        return { kind: "assert", value: "^" };
      case "$":
        return { kind: "assert", value: "$" };
      case ".":
        return {
          kind: "char",
          spec: { ranges: LINE_TERMINATORS, negated: true },
        };
      case "(":
        return this.#group();
      case "[":
        return { kind: "char", spec: this.#class() };
      case "\\":
        return this.#escape();
      case "*":
      case "+":
      case "?":
        throw new RegexRefusal(
          `nothing to repeat before ${JSON.stringify(char)}`,
        );
      case "{":
        throw new RegexRefusal('a lone "{" must be escaped ("\\{")');
      case "}":
      case "]":
        throw new RegexRefusal(
          `a lone ${JSON.stringify(char)} must be escaped`,
        );
      default: {
        const code = char.codePointAt(0) ?? 0;
        return {
          kind: "char",
          spec: { ranges: [[code, code]], negated: false },
        };
      }
    }
  }

  /** A group, after `(`. */
  #group(): RegexNode {
    if (this.#peek() === "?") {
      const kind = this.#peek(1);
      if (kind === ":") {
        this.#at += 2;
      } else if (
        kind === "<" &&
        this.#peek(2) !== "=" &&
        this.#peek(2) !== "!"
      ) {
        this.#at += 2;
        let name = "";
        while (this.#peek() !== ">") {
          const next = this.#next();
          if (!/[\w$]/.test(next))
            throw new RegexRefusal("a group name is letters, digits and _");
          name += next;
        }
        this.#at++;
        if (name === "") throw new RegexRefusal("a named group needs a name");
      } else if (kind === "=" || kind === "!" || kind === "<") {
        throw new RegexRefusal(
          "lookarounds ((?=, (?!, (?<=, (?<!) are not allowed",
        );
      } else {
        throw new RegexRefusal(
          "inline modifiers ((?i:…) and the like) are not allowed",
        );
      }
    }
    const alternatives = this.#disjunction();
    if (this.#peek() !== ")") throw new RegexRefusal('an unclosed "("');
    this.#at++;
    return { kind: "group", alternatives };
  }

  /** An escape outside a class, after `\`. */
  #escape(): RegexNode {
    const char = this.#next();
    if (char === "b" || char === "B") return { kind: "assert", value: char };
    if (/[1-9]/.test(char) || char === "k") {
      throw new RegexRefusal("backreferences are not allowed");
    }
    return { kind: "char", spec: this.#escapeSpec(char) };
  }

  /** The set of a character escape (`d`, `w`, `n`, `x41`, an escaped syntax character). */
  #escapeSpec(char: string): CharSpec {
    switch (char) {
      case "d":
        return { ranges: DIGITS, negated: false };
      case "D":
        return { ranges: DIGITS, negated: true };
      case "w":
        return { ranges: WORD, negated: false };
      case "W":
        return { ranges: WORD, negated: true };
      case "s":
        return { ranges: SPACE, negated: false };
      case "S":
        return { ranges: SPACE, negated: true };
      case "t":
        return single(0x09);
      case "n":
        return single(0x0a);
      case "r":
        return single(0x0d);
      case "f":
        return single(0x0c);
      case "v":
        return single(0x0b);
      case "0":
        if (/\d/.test(this.#peek() ?? "")) {
          throw new RegexRefusal("octal escapes are not allowed");
        }
        return single(0);
      case "x":
        return single(this.#hex(2));
      case "u": {
        if (this.#peek() === "{") {
          this.#at++;
          let digits = "";
          while (this.#peek() !== "}") digits += this.#next();
          this.#at++;
          if (
            !/^[\da-f]{1,6}$/i.test(digits) ||
            Number.parseInt(digits, 16) > 0x10ffff
          ) {
            throw new RegexRefusal("a bad \\u{…} escape");
          }
          return single(Number.parseInt(digits, 16));
        }
        return single(this.#hex(4));
      }
      case "p":
      case "P":
        throw new RegexRefusal(
          "Unicode property escapes (\\p{…}) are not allowed",
        );
      case "c":
        throw new RegexRefusal("control escapes (\\c) are not allowed");
      default:
        if (SYNTAX.has(char) || char === "-") {
          const code = char.codePointAt(0) ?? 0;
          return single(code);
        }
        throw new RegexRefusal(`the escape \\${char} is not allowed`);
    }
  }

  /** `count` hex digits, as a code point. */
  #hex(count: number): number {
    let digits = "";
    for (let i = 0; i < count; i++) digits += this.#next();
    if (!/^[\da-f]+$/i.test(digits)) throw new RegexRefusal("a bad hex escape");
    return Number.parseInt(digits, 16);
  }

  /** A class, after `[`. */
  #class(): CharSpec {
    let negated = false;
    if (this.#peek() === "^") {
      negated = true;
      this.#at++;
    }
    const ranges: CodeRange[] = [];
    let first = true;
    while (this.#peek() !== "]") {
      if (this.#peek() === undefined) throw new RegexRefusal('an unclosed "["');
      const lo = this.#classAtom(first);
      first = false;
      if (
        this.#peek() === "-" &&
        this.#peek(1) !== "]" &&
        this.#peek(1) !== undefined
      ) {
        this.#at++;
        const hi = this.#classAtom(false);
        if (lo.length !== 1 || hi.length !== 1) {
          throw new RegexRefusal(
            "a class range's ends must be single characters",
          );
        }
        const from = lo[0]?.[0] ?? 0;
        const to = hi[0]?.[0] ?? 0;
        if (from > to) throw new RegexRefusal("a class range out of order");
        ranges.push([from, to]);
      } else {
        ranges.push(...lo);
      }
    }
    this.#at++;
    return { ranges, negated };
  }

  /** One item of a class: a character or an escape (a set like `\d` gives several ranges). */
  #classAtom(_first: boolean): CodeRange[] {
    const char = this.#next();
    if (char === "\\") {
      const escaped = this.#next();
      if (escaped === "b") return [[0x08, 0x08]];
      if (/[1-9]/.test(escaped) || escaped === "k") {
        throw new RegexRefusal("backreferences are not allowed");
      }
      const spec = this.#escapeSpec(escaped);
      if (spec.negated) {
        throw new RegexRefusal(
          "a negated escape (\\D, \\W, \\S) inside a class is not allowed",
        );
      }
      return [...spec.ranges];
    }
    if (char === "[")
      throw new RegexRefusal('a "[" inside a class must be escaped');
    const code = char.codePointAt(0) ?? 0;
    return [[code, code]];
  }

  /** A quantifier after `atom`, if one follows. */
  #quantified(atom: RegexNode): RegexNode {
    const char = this.#peek();
    let min: number;
    let max: number;
    if (char === "*") {
      min = 0;
      max = Infinity;
      this.#at++;
    } else if (char === "+") {
      min = 1;
      max = Infinity;
      this.#at++;
    } else if (char === "?") {
      min = 0;
      max = 1;
      this.#at++;
    } else if (char === "{") {
      const counts = this.#counts();
      if (counts === undefined) return atom;
      [min, max] = counts;
    } else {
      return atom;
    }
    if (atom.kind === "assert") {
      throw new RegexRefusal("an assertion cannot be repeated");
    }
    let lazy = false;
    if (this.#peek() === "?") {
      lazy = true;
      this.#at++;
    }
    if (this.#peek() === "*" || this.#peek() === "+" || this.#peek() === "{") {
      throw new RegexRefusal("a quantifier cannot follow a quantifier");
    }
    return { kind: "repeat", node: atom, min, max, lazy };
  }

  /** `{n}`, `{n,}`, `{n,m}` after `{`. */
  #counts(): [number, number] | undefined {
    const rest = this.#chars.slice(this.#at).join("");
    const match = /^\{(\d{1,4})(?:(,)(\d{1,4})?)?\}/.exec(rest);
    if (!match) throw new RegexRefusal('a lone "{" must be escaped ("\\{")');
    this.#at += [...match[0]].length;
    const min = Number(match[1]);
    const max =
      match[2] === undefined
        ? min
        : match[3] === undefined
          ? Infinity
          : Number(match[3]);
    if (
      min > MAX_REGEX_REPEAT ||
      (Number.isFinite(max) && max > MAX_REGEX_REPEAT)
    ) {
      throw new RegexRefusal(`a repetition count over ${MAX_REGEX_REPEAT}`);
    }
    if (max < min) throw new RegexRefusal("a repetition range out of order");
    return [min, max];
  }
}

/** The set of one code point. */
function single(code: number): CharSpec {
  return { ranges: [[code, code]], negated: false };
}

/** Parses `source` as a pattern of the accepted syntax; throws a {@link RegexRefusal}. */
export function parseRegex(source: string): ParsedRegex {
  if (source.length > MAX_REGEX_LENGTH) {
    throw new RegexRefusal(`longer than ${MAX_REGEX_LENGTH} characters`);
  }
  return new Parser(source).parse();
}

/** A conservative view of the characters a node can start with: `any` or a set of ranges. */
interface FirstSet {
  /** Whether it may start with any character (a negated set, or too wide to tell). */
  readonly any: boolean;
  /** The ranges it may start with. */
  readonly ranges: readonly CodeRange[];
}

/** The ranges a set covers, folded for case when `ignoreCase`. */
function folded(
  ranges: readonly CodeRange[],
  ignoreCase: boolean,
): CodeRange[] {
  if (!ignoreCase) return [...ranges];
  const out: CodeRange[] = [...ranges];
  for (const [lo, hi] of ranges) {
    const upperLo = Math.max(lo, 0x61);
    const upperHi = Math.min(hi, 0x7a);
    if (upperLo <= upperHi) out.push([upperLo - 0x20, upperHi - 0x20]);
    const lowerLo = Math.max(lo, 0x41);
    const lowerHi = Math.min(hi, 0x5a);
    if (lowerLo <= lowerHi) out.push([lowerLo + 0x20, lowerHi + 0x20]);
  }
  return out;
}

/** The first set of a character spec. */
function specSet(spec: CharSpec, ignoreCase: boolean): FirstSet {
  return spec.negated
    ? { any: true, ranges: [] }
    : { any: false, ranges: folded(spec.ranges, ignoreCase) };
}

/** Whether two first sets share a character. */
function overlaps(a: FirstSet, b: FirstSet): boolean {
  if (a.any || b.any) return true;
  for (const [aLo, aHi] of a.ranges) {
    for (const [bLo, bHi] of b.ranges) {
      if (aLo <= bHi && bLo <= aHi) return true;
    }
  }
  return false;
}

/** The union of first sets. */
function union(sets: readonly FirstSet[]): FirstSet {
  if (sets.some((set) => set.any)) return { any: true, ranges: [] };
  return { any: false, ranges: sets.flatMap((set) => set.ranges) };
}

/** Whether `node` can match the empty string. */
function nullable(node: RegexNode): boolean {
  switch (node.kind) {
    case "char":
      return false;
    case "assert":
      return true;
    case "group":
      return node.alternatives.some((alt) => alt.every(nullable));
    case "repeat":
      return node.min === 0 || nullable(node.node);
  }
}

/** The characters a sequence can start with. */
function firstOfSequence(
  sequence: readonly RegexNode[],
  ignoreCase: boolean,
): FirstSet {
  const sets: FirstSet[] = [];
  for (const node of sequence) {
    sets.push(firstOf(node, ignoreCase));
    if (!nullable(node)) break;
  }
  return union(sets);
}

/** The characters a node can start with. */
function firstOf(node: RegexNode, ignoreCase: boolean): FirstSet {
  switch (node.kind) {
    case "char":
      return specSet(node.spec, ignoreCase);
    case "assert":
      return { any: false, ranges: [] };
    case "group":
      return union(
        node.alternatives.map((alt) => firstOfSequence(alt, ignoreCase)),
      );
    case "repeat":
      return firstOf(node.node, ignoreCase);
  }
}

/** Every character a node can match anywhere inside it. */
function charsOf(node: RegexNode, ignoreCase: boolean): FirstSet {
  switch (node.kind) {
    case "char":
      return specSet(node.spec, ignoreCase);
    case "assert":
      return { any: false, ranges: [] };
    case "group":
      return union(
        node.alternatives.flatMap((alt) =>
          alt.map((n) => charsOf(n, ignoreCase)),
        ),
      );
    case "repeat":
      return charsOf(node.node, ignoreCase);
  }
}

/** Whether `node` contains a quantifier anywhere. */
function hasRepeat(node: RegexNode): boolean {
  switch (node.kind) {
    case "repeat":
      return true;
    case "group":
      return node.alternatives.some((alt) => alt.some(hasRepeat));
    default:
      return false;
  }
}

/** Whether a group's alternatives leave a choice: two can start alike, or one can match nothing. */
function ambiguous(
  group: Extract<RegexNode, { kind: "group" }>,
  ignoreCase: boolean,
): boolean {
  const alternatives = group.alternatives;
  if (alternatives.length < 2) return false;
  if (alternatives.some((alt) => alt.every(nullable))) return true;
  const firsts = alternatives.map((alt) => firstOfSequence(alt, ignoreCase));
  for (let i = 0; i < firsts.length; i++) {
    for (let j = i + 1; j < firsts.length; j++) {
      if (overlaps(firsts[i]!, firsts[j]!)) return true;
    }
  }
  return false;
}

/**
 * Whether `node` holds a choice a backtracking engine may revisit: a repeat
 * of variable count (`*`, `+`, `?`, `{2,5}`), or a group whose alternatives
 * can start alike.
 */
function variable(node: RegexNode, ignoreCase: boolean): boolean {
  switch (node.kind) {
    case "repeat":
      return node.max > node.min || variable(node.node, ignoreCase);
    case "group":
      return (
        ambiguous(node, ignoreCase) ||
        node.alternatives.some((alt) =>
          alt.some((n) => variable(n, ignoreCase)),
        )
      );
    default:
      return false;
  }
}

/** Whether `node` holds an ambiguous group anywhere. */
function holdsAmbiguous(node: RegexNode, ignoreCase: boolean): boolean {
  switch (node.kind) {
    case "repeat":
      return holdsAmbiguous(node.node, ignoreCase);
    case "group":
      return (
        ambiguous(node, ignoreCase) ||
        node.alternatives.some((alt) =>
          alt.some((n) => holdsAmbiguous(n, ignoreCase)),
        )
      );
    default:
      return false;
  }
}

/** Checks a quantified node's body; throws on a refused shape. */
function checkRepeat(
  node: Extract<RegexNode, { kind: "repeat" }>,
  ignoreCase: boolean,
): void {
  const body = node.node;
  if (hasRepeat(body)) {
    throw new RegexRefusal(
      "a quantifier inside a quantified group (nested quantifiers, as in (a+)+) is not allowed",
    );
  }
  if (node.max > 1 && nullable(body)) {
    throw new RegexRefusal(
      "a repeated group that can match the empty string is not allowed",
    );
  }
  if (node.max > 1 && holdsAmbiguous(body, ignoreCase)) {
    throw new RegexRefusal(
      "a repeated group whose alternatives can start with the same character (as in (a|aa)*) is not allowed",
    );
  }
}

/**
 * Checks one sequence and everything below it; throws on a refused shape.
 * The choices in it (see {@link variable}) must not be able to trade
 * characters with one another: two whose characters overlap, with only
 * optional items (or items both could eat) between them, give a
 * backtracking engine a number of ways to split the input that grows with
 * every one added (`a?a?a?aaa`, `\d+\d*`, `(a|ab)(a|ab)`).
 */
function checkSequence(
  sequence: readonly RegexNode[],
  ignoreCase: boolean,
): void {
  // The choices since the last term that ends them, with their characters.
  let open: FirstSet[] = [];
  for (const node of sequence) {
    if (node.kind === "repeat") checkRepeat(node, ignoreCase);
    if (node.kind === "group") {
      for (const alt of node.alternatives) checkSequence(alt, ignoreCase);
    }
    if (node.kind === "repeat" && node.node.kind === "group") {
      for (const alt of node.node.alternatives) checkSequence(alt, ignoreCase);
    }
    if (variable(node, ignoreCase)) {
      const chars = charsOf(node, ignoreCase);
      if (open.some((previous) => overlaps(previous, chars))) {
        throw new RegexRefusal(
          "two variable repeats or alternations whose characters overlap, with nothing between them that only one can match (as in \\d+\\d* or a?a?aa), are not allowed",
        );
      }
      open.push(chars);
    } else if (!nullable(node)) {
      // A term that must match ends the choices before it that cannot eat
      // its characters; one that can (`.*` before `a`) stays open.
      const chars = charsOf(node, ignoreCase);
      open = open.filter((previous) => overlaps(previous, chars));
    }
  }
}

/**
 * Validates `source` as a rule's regex, returning the reason it is refused,
 * or `undefined` when it is accepted. `ignoreCase` widens the character sets
 * the overlap checks compare.
 */
export function regexRefusal(
  source: string,
  ignoreCase = false,
): string | undefined {
  try {
    const parsed = parseRegex(source);
    // Top-level alternatives are tried one after another: each on its own.
    for (const alt of parsed.alternatives) checkSequence(alt, ignoreCase);
    // The engine must accept it too (with the `u` flag's stricter syntax).
    const compiled = new RegExp(source, ignoreCase ? "iu" : "u");
    return compiled.unicode ? undefined : "the engine refused the u flag";
  } catch (error) {
    return error instanceof RegexRefusal
      ? error.message
      : `not a valid pattern: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Compiles an accepted pattern; throws a {@link RegexRefusal} for a refused
 * one. The `u` flag always (its syntax is the stricter); `i` with
 * `ignoreCase`.
 */
export function compileSafeRegex(source: string, ignoreCase = false): RegExp {
  const refusal = regexRefusal(source, ignoreCase);
  if (refusal !== undefined) throw new RegexRefusal(refusal);
  return new RegExp(source, ignoreCase ? "iu" : "u");
}
