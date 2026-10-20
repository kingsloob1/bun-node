/**
 * Express 5 path syntax for `BunRouter`: path-to-regexp 8's grammar, compiled
 * once, at registration, into the `{ regexp, params }` a `@routejs/router`
 * `Route` carries, plus a kind per capture so the matcher knows which ones
 * are wildcards (split on `/`, each segment decoded).
 *
 * A path is decided once ({@link compileRoutePath}):
 *
 * 1. **path-to-regexp 8 accepts it**: Express mode, compiled here. Plain paths
 *    (`/users/:id`) are in this mode too, and their regex is byte-identical
 *    to the one routejs emits, so the route tree keeps walking them.
 * 2. **It is rejected, and it uses routejs-only syntax** (`?`, `+`, `(…)`, a
 *    bare `*`, `{*}`) and **no Express-only syntax** (`{…}` groups, quoted or
 *    non-ASCII names): routejs mode, compiled by routejs as before. Named
 *    wildcards inside it (`*name`, `{*name}`) are bridged to `string[]`
 *    captures, and positional keys count only bare `*` and bare `(…)`.
 * 3. **Otherwise** it throws a {@link PathSyntaxError} with path-to-regexp's
 *    message, at registration, as Express does.
 *
 * The grammar ({@link parseExpressPath}), the flattening of optional groups
 * and the per-token regex construction ({@link compileExpressPath}) are a
 * port of path-to-regexp 8.4.2, so the two agree by construction; the
 * differential test (`__tests__/expressPath.test.ts`) checks that against
 * the real package. The emission differs in shape only, chosen so the route
 * tree can walk the common routes:
 *
 * - the end is routejs's `\/?$` (`\/?(?=\/|$)` for a `use()` prefix) instead
 *   of `(?:\/$)?$`;
 * - a parameter filling a segment is lazy, `([^\/]+?)`, as routejs emits it;
 * - an optional group that no capture before it can eat into is emitted as
 *   `(?:…)?` instead of an alternation of every combination;
 * - literal text is escaped with routejs's (larger) set.
 *
 * ---
 *
 * Portions of this file are ported from path-to-regexp 8.4.2
 * (https://github.com/pillarjs/path-to-regexp), whose licence follows:
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2014 Blake Embrey (hello@blakeembrey.com)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

/**
 * A route path that cannot be registered: path-to-regexp 8 rejects it, and it
 * is not a routejs path either. Thrown at registration, as Express 5 throws
 * there, with path-to-regexp's message (`Missing parameter name at index 2:
 * /:; visit https://git.new/pathToRegexpError for info`). Named exactly as
 * path-to-regexp's own `PathError`, which Express throws: `constructor.name`
 * is `"PathError"` and `.name` is `"TypeError"` (it is a `TypeError`), so a
 * log or a stack trace reads as Express's does. Catch it with
 * `instanceof PathSyntaxError` or `instanceof TypeError`.
 */
export class PathSyntaxError extends TypeError {
  /** The path as it was written. */
  readonly originalPath: string;
  /** What is wrong, without the path or the link: `Unexpected ( at index 3`. */
  readonly reason: string;

  constructor(
    /** What is wrong, without the path: `Unexpected ( at index 3`. */
    message: string,
    /** The path as it was written. */
    originalPath: string,
  ) {
    super(
      `${message}${originalPath ? `: ${originalPath}` : ""}; visit https://git.new/pathToRegexpError for info`,
    );
    this.originalPath = originalPath;
    this.reason = message;
  }
}
// Named as path-to-regexp's own class, so what prints the class of an error
// (a boot log, a differential against Express) sees what Express throws.
Object.defineProperty(PathSyntaxError, "name", { value: "PathError" });

/**
 * A path-to-regexp 8 token.
 *
 * Not part of the package API: exported for `BunRouter` and the tests,
 * reachable only by a deep import, and may change without notice.
 *
 * @internal
 */
export type ExpressPathToken =
  | {
      /** Literal text. */
      type: "text";
      /** The text, unescaped. */
      value: string;
    }
  | {
      /** `:name`: one segment's worth (no `/`). */
      type: "param";
      /** The parameter's name. */
      name: string;
    }
  | {
      /** `*name`: one or more characters, `/` included. */
      type: "wildcard";
      /** The wildcard's name. */
      name: string;
    }
  | {
      /** `{…}`: an optional part. */
      type: "group";
      /** The tokens inside the braces. */
      tokens: ExpressPathToken[];
    };

/** A token outside a group. */
type FlatToken = Exclude<ExpressPathToken, { type: "group" }>;

const ID_START = /^[$_\p{ID_Start}]$/u;
const ID_CONTINUE = /^[$\u200C\u200D\p{ID_Continue}]$/u;

/**
 * Parses a path with path-to-regexp 8's grammar (8.4.2 `parse`, ported): the
 * same tokens, and the same errors at the same indices.
 *
 * @throws PathSyntaxError for a path path-to-regexp rejects.
 *
 * Not part of the package API: exported for `BunRouter` and the tests,
 * reachable only by a deep import, and may change without notice.
 *
 * @internal
 */
export function parseExpressPath(str: string): ExpressPathToken[] {
  const chars = [...str];
  let index = 0;

  function consumeUntil(end: string): ExpressPathToken[] {
    const output: ExpressPathToken[] = [];
    let path = "";
    const writePath = () => {
      if (!path) {
        return;
      }
      output.push({ type: "text", value: path });
      path = "";
    };

    while (index < chars.length) {
      const value = chars[index++];
      if (value === end) {
        writePath();
        return output;
      }
      if (value === "\\") {
        if (index === chars.length) {
          throw new PathSyntaxError(
            `Unexpected end after \\ at index ${index}`,
            str,
          );
        }
        path += chars[index++];
        continue;
      }
      if (value === ":" || value === "*") {
        const type = value === ":" ? "param" : "wildcard";
        let name = "";
        if (ID_START.test(chars[index] ?? "")) {
          do {
            name += chars[index++];
          } while (ID_CONTINUE.test(chars[index] ?? ""));
        } else if (chars[index] === '"') {
          let quoteStart = index;
          while (index < chars.length) {
            if (chars[++index] === '"') {
              index++;
              quoteStart = 0;
              break;
            }
            // Step over an escape character.
            if (chars[index] === "\\") {
              index++;
            }
            name += chars[index];
          }
          if (quoteStart) {
            throw new PathSyntaxError(
              `Unterminated quote at index ${quoteStart}`,
              str,
            );
          }
        }
        if (!name) {
          throw new PathSyntaxError(
            `Missing parameter name at index ${index}`,
            str,
          );
        }
        writePath();
        output.push({ type, name });
        continue;
      }
      if (value === "{") {
        writePath();
        output.push({ type: "group", tokens: consumeUntil("}") });
        continue;
      }
      if (
        value === "}" ||
        value === "(" ||
        value === ")" ||
        value === "[" ||
        value === "]" ||
        value === "+" ||
        value === "?" ||
        value === "!"
      ) {
        throw new PathSyntaxError(
          `Unexpected ${value} at index ${index - 1}`,
          str,
        );
      }
      path += value;
    }

    if (end) {
      throw new PathSyntaxError(
        `Unexpected end at index ${index}, expected ${end}`,
        str,
      );
    }
    writePath();
    return output;
  }

  return consumeUntil("");
}

/** path-to-regexp's limit on the combinations a path's groups expand to. */
const MAX_COMBINATIONS = 256;

/**
 * Every flat sequence `tokens` expands to, each group present before absent,
 * in path-to-regexp's order (8.4.2 `flatten`, ported).
 */
function flatten(
  tokens: readonly ExpressPathToken[],
  index: number,
  result: FlatToken[],
  callback: (sequence: FlatToken[]) => void,
): void {
  while (index < tokens.length) {
    const token = tokens[index++];
    if (token.type === "group") {
      const length = result.length;
      const rest = (sequence: FlatToken[]) =>
        flatten(tokens, index, sequence, callback);
      flatten(token.tokens, 0, result, rest);
      result.length = length;
      continue;
    }
    result.push(token);
  }
  callback(result);
}

/** path-to-regexp's regex escape, for character classes and lookaheads. */
function escapeRegex(str: string): string {
  return str.replace(/[.+*?^${}()[\]|/\\]/g, "\\$&");
}

/**
 * routejs's escape for literal text: path-to-regexp's set plus `=`, `!` and
 * `:` (identity escapes, harmless without the `u` flag), so a plain path's
 * source is byte-identical to the one routejs compiles.
 */
function escapeText(str: string): string {
  return str.replace(/[.+*?=^!:${}()[\]|/\\]/g, "\\$&");
}

/** Blocks backtracking into the text before a capture (8.4.2 `negate`). */
function negate(a: string, b: string): string {
  if (b.length > a.length) {
    return negate(b, a);
  }
  if (a === b) {
    b = "";
  }
  if (b.length > 1) {
    return `(?:(?!${escapeRegex(a)}|${escapeRegex(b)})[^])`;
  }
  if (a.length > 1) {
    return `(?:(?!${escapeRegex(a)})[^${escapeRegex(b)}])`;
  }
  return `[^${escapeRegex(a + b)}]`;
}

/** The regex of a whole-segment parameter, greedy, as path-to-regexp emits it. */
const GREEDY_SEGMENT = "([^\\/]+)";
/** The same, lazy, as routejs emits it. */
const LAZY_SEGMENT = "([^\\/]+?)";

/**
 * The regex of each token of one flat sequence (8.4.2 `toRegExpSource`,
 * ported piecewise: one entry per token, so the emissions of different
 * combinations can be compared token by token).
 */
function toRegExpPieces(tokens: readonly FlatToken[], path: string): string[] {
  const delimiter = "/";
  const pieces: string[] = [];
  let backtrack = "";
  let wildcardBacktrack = "";
  let prevCaptureType = 0;
  let hasSegmentCapture = 0;
  let index = 0;

  const hasInSegment = (from: number, type: string): boolean => {
    while (from < tokens.length) {
      const token = tokens[from++];
      if (token.type === type) {
        return true;
      }
      if (token.type === "text" && token.value.includes(delimiter)) {
        break;
      }
    }
    return false;
  };
  const peekText = (from: number): string => {
    let result = "";
    while (from < tokens.length) {
      const token = tokens[from++];
      if (token.type !== "text") {
        break;
      }
      result += token.value;
    }
    return result;
  };

  while (index < tokens.length) {
    const token = tokens[index++];
    if (token.type === "text") {
      pieces.push(escapeText(token.value));
      backtrack += token.value;
      if (prevCaptureType === 2) {
        wildcardBacktrack += token.value;
      }
      if (token.value.includes(delimiter)) {
        hasSegmentCapture = 0;
      }
      continue;
    }
    if (prevCaptureType && !backtrack) {
      throw new PathSyntaxError(
        `Missing text before "${token.name}" ${token.type}`,
        path,
      );
    }
    if (token.type === "param") {
      let piece =
        hasSegmentCapture & 2 // A wildcard earlier in the segment.
          ? `(${negate(delimiter, backtrack)}+)`
          : hasInSegment(index, "wildcard") // A wildcard later in the segment.
            ? `(${negate(delimiter, peekText(index))}+)`
            : hasSegmentCapture & 1 // A parameter earlier in the segment.
              ? `(${negate(delimiter, backtrack)}+|${escapeRegex(backtrack)})`
              : `(${negate(delimiter, "")}+)`;
      // Lazy is equivalent where nothing after it can take a `[^/]`: the end,
      // or text that starts with `/`.
      if (piece === GREEDY_SEGMENT) {
        const next = tokens[index];
        if (
          next === undefined ||
          (next.type === "text" && next.value.startsWith(delimiter))
        ) {
          piece = LAZY_SEGMENT;
        }
      }
      pieces.push(piece);
      hasSegmentCapture |= prevCaptureType = 1;
    } else {
      pieces.push(
        hasSegmentCapture & 2 // A wildcard earlier in the segment.
          ? `(${negate(backtrack, "")}+)`
          : wildcardBacktrack // A wildcard earlier in the path.
            ? `(${negate(wildcardBacktrack, "")}+|${negate(delimiter, "")}+)`
            : `([^]+)`,
      );
      wildcardBacktrack = "";
      hasSegmentCapture |= prevCaptureType = 2;
    }
    backtrack = "";
  }
  return pieces;
}

/** Strips trailing slashes, as Express's `loosen` does for non-strict routing. */
function loosen(path: string): string {
  return path === "/" ? path : path.replace(/\/+$/, "");
}

/**
 * A plain parameter capture: decoded, published as a `string`.
 *
 * Not part of the package API: exported for `BunRouter` and the tests,
 * reachable only by a deep import, and may change without notice.
 *
 * @internal
 */
export const CAPTURE_PARAM = 0;
/**
 * A wildcard: split on `/`, each segment decoded, published as `string[]`.
 *
 * Not part of the package API: exported for `BunRouter` and the tests,
 * reachable only by a deep import, and may change without notice.
 *
 * @internal
 */
export const CAPTURE_WILDCARD = 1;
/**
 * A bridged `{*name}` in a routejs path: as {@link CAPTURE_WILDCARD}, but an
 * empty capture leaves the key out.
 *
 * Not part of the package API: exported for `BunRouter` and the tests,
 * reachable only by a deep import, and may change without notice.
 *
 * @internal
 */
export const CAPTURE_OPTIONAL_WILDCARD = 2;

/**
 * What {@link CAPTURE_PARAM} and friends are.
 *
 * Not part of the package API: exported for `BunRouter` and the tests,
 * reachable only by a deep import, and may change without notice.
 *
 * @internal
 */
export type CaptureKind =
  | typeof CAPTURE_PARAM
  | typeof CAPTURE_WILDCARD
  | typeof CAPTURE_OPTIONAL_WILDCARD;

/**
 * A path compiled to a regex, with what each capture is.
 *
 * Not part of the package API: exported for `BunRouter` and the tests,
 * reachable only by a deep import, and may change without notice.
 *
 * @internal
 */
export interface CompiledExpressPath {
  /** The regex, `i` unless case-sensitive. */
  regexp: RegExp;
  /** The key of each capture, in order; a name repeats across alternatives. */
  names: string[];
  /** The kind of each capture, or `undefined` when every one is a plain parameter. */
  kinds: CaptureKind[] | undefined;
}

/** Options for {@link compileExpressPath}. */
export interface CompileExpressPathOptions {
  /** `true` for a whole path (a route), `false` for a `use()` prefix. Default `true`. */
  end?: boolean;
  /** Match case-sensitively (no `i` flag). Default `false`. */
  sensitive?: boolean;
}

/**
 * The nested emission of a multi-combination path, or `undefined` when an
 * alternation is needed: every token must compile identically in every
 * combination containing it, and no capture before a group may be able to
 * consume the group's first character (a `(?:…)?` decides group by group,
 * after the captures before it settled; an alternation tries whole
 * combinations in order).
 */
function nestedEmission(
  tokens: readonly ExpressPathToken[],
  path: string,
): { source: string; names: string[]; kinds: CaptureKind[] } | undefined {
  type Tagged =
    | (FlatToken & { id: number })
    | { type: "group"; tokens: Tagged[] };
  let nextId = 0;
  const tag = (list: readonly ExpressPathToken[]): Tagged[] =>
    list.map((token) =>
      token.type === "group"
        ? { type: "group", tokens: tag(token.tokens) }
        : { ...token, id: nextId++ },
    );
  const tagged = tag(tokens);

  const byId = new Map<number, string>();
  let consistent = true;
  flatten(tagged as ExpressPathToken[], 0, [], (sequence) => {
    if (!consistent) {
      return;
    }
    const pieces = toRegExpPieces(sequence, path);
    for (let i = 0; i < sequence.length; i++) {
      const id = (sequence[i] as FlatToken & { id: number }).id;
      const known = byId.get(id);
      if (known === undefined) {
        byId.set(id, pieces[i]);
      } else if (known !== pieces[i]) {
        consistent = false;
        return;
      }
    }
  });
  if (!consistent) {
    return undefined;
  }

  // "none": only literals so far, so what precedes a group has one way to
  // match and the two emissions try the same things in the same order.
  let captureSeen: "none" | "param" | "wildcard" = "none";
  const safe = (list: readonly Tagged[]): boolean => {
    for (const token of list) {
      if (token.type === "group") {
        const first = token.tokens[0];
        if (first === undefined) {
          return false;
        }
        if (captureSeen === "wildcard") {
          return false;
        }
        if (captureSeen === "param") {
          if (first.type !== "text" || !first.value.startsWith("/")) {
            return false;
          }
        }
        if (!safe(token.tokens)) {
          return false;
        }
      } else if (token.type === "wildcard") {
        captureSeen = "wildcard";
      } else if (token.type === "param" && captureSeen !== "wildcard") {
        captureSeen = "param";
      }
    }
    return true;
  };
  if (!safe(tagged)) {
    return undefined;
  }

  const names: string[] = [];
  const kinds: CaptureKind[] = [];
  const emit = (list: readonly Tagged[]): string => {
    let source = "";
    for (const token of list) {
      if (token.type === "group") {
        source += `(?:${emit(token.tokens)})?`;
        continue;
      }
      if (token.type !== "text") {
        names.push(token.name);
        kinds.push(
          token.type === "wildcard" ? CAPTURE_WILDCARD : CAPTURE_PARAM,
        );
      }
      source += byId.get(token.id);
    }
    return source;
  };
  return { source: emit(tagged), names, kinds };
}

/** routejs's end of a whole path. */
const ROUTE_END = "\\/?$";
/** routejs's end of a `use()` prefix. */
const PREFIX_END = "\\/?(?=\\/|$)";

/**
 * Compiles a path path-to-regexp 8 accepts, with Express 5's options
 * (trailing slashes loosened and tolerated, case-insensitive unless
 * `sensitive`), into a regex whose captures match path-to-regexp's
 * `match()` exactly (see the module comment for how the shape differs).
 *
 * @throws PathSyntaxError for a path path-to-regexp rejects.
 *
 * Not part of the package API: exported for `BunRouter` and the tests,
 * reachable only by a deep import, and may change without notice.
 *
 * @internal
 */
export function compileExpressPath(
  path: string,
  options: CompileExpressPathOptions = {},
): CompiledExpressPath {
  return compileTokens(loosen(path), options);
}

/** {@link compileExpressPath} on `path` as given (not loosened). */
function compileTokens(
  path: string,
  options: CompileExpressPathOptions,
): CompiledExpressPath {
  const { end = true, sensitive = false } = options;
  const tokens = parseExpressPath(path);
  // Every combination compiled in turn, as path-to-regexp does, so the same
  // error comes first.
  const compiled: { pieces: string[]; sequence: FlatToken[] }[] = [];
  flatten(tokens, 0, [], (sequence) => {
    if (compiled.length >= MAX_COMBINATIONS) {
      throw new PathSyntaxError("Too many path combinations", path);
    }
    compiled.push({
      pieces: toRegExpPieces(sequence, path),
      sequence: [...sequence],
    });
  });

  let body: string;
  let names: string[];
  let kinds: CaptureKind[];
  const nested = compiled.length > 1 ? nestedEmission(tokens, path) : undefined;
  if (nested !== undefined) {
    ({ source: body, names, kinds } = nested);
  } else {
    names = [];
    kinds = [];
    const alternatives: string[] = [];
    for (const { pieces, sequence } of compiled) {
      alternatives.push(pieces.join(""));
      for (const token of sequence) {
        if (token.type !== "text") {
          names.push(token.name);
          kinds.push(
            token.type === "wildcard" ? CAPTURE_WILDCARD : CAPTURE_PARAM,
          );
        }
      }
    }
    body =
      alternatives.length === 1
        ? alternatives[0]
        : `(?:${alternatives.join("|")})`;
  }

  return {
    regexp: new RegExp(
      `^${body}${end ? ROUTE_END : PREFIX_END}`,
      sensitive ? "" : "i",
    ),
    names,
    kinds: kinds.includes(CAPTURE_WILDCARD) ? kinds : undefined,
  };
}

/** Options for {@link assertExpressPath}. */
export interface AssertExpressPathOptions {
  /**
   * Strip trailing slashes first, as Express's router does when it compiles a
   * route or a `use()` prefix (`app.use(path)` throws at registration with
   * that path in the message). Default `false`: the path as written, as
   * `@nestjs/platform-express`'s `normalizePath` checks it.
   */
  loosen?: boolean;
}

/**
 * Throws what Express 5 throws at startup for a path it cannot register:
 * path-to-regexp 8's parse and compile of `path`, as `@nestjs/platform-express`'s
 * `normalizePath` runs them. Returns nothing for a valid path.
 *
 * @throws PathSyntaxError for a path path-to-regexp rejects.
 */
export function assertExpressPath(
  path: string,
  options: AssertExpressPathOptions = {},
): void {
  // Not loosened by default: `normalizePath` hands path-to-regexp the path as
  // written, so its error names that path.
  compileTokens(options.loosen ? loosen(path) : path, {});
}

/** `value` as the string a path segment carries, or `undefined` for a non-scalar. */
function segmentString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return undefined;
}

/**
 * Builds a path from `params`, as path-to-regexp 8's `compile` does with its
 * defaults: each value `encodeURIComponent`-ed, a wildcard's array joined
 * with `/` after encoding each element, an optional group left out when a
 * parameter in it is missing. One leniency, kept from routejs's `route()`: a
 * number, bigint or boolean is taken as its string (path-to-regexp throws
 * `Expected "id" to be a string`), so `route("user", { id: 7 })` still works.
 */
function compileToPath(
  tokens: readonly ExpressPathToken[],
): (params?: object) => string {
  type Builder = (data: Record<string, unknown>, missing: string[]) => string;
  const build = (list: readonly ExpressPathToken[]): Builder => {
    const builders: Builder[] = list.map((token): Builder => {
      if (token.type === "text") {
        return () => token.value;
      }
      if (token.type === "group") {
        const inner = build(token.tokens);
        return (data, missing) => {
          const length = missing.length;
          const value = inner(data, missing);
          if (missing.length === length) {
            return value;
          }
          // An optional group whose parameters are not all given is left out.
          missing.length = length;
          return "";
        };
      }
      if (token.type === "wildcard") {
        return (data, missing) => {
          const value = data[token.name];
          if (value == null) {
            missing.push(token.name);
            return "";
          }
          if (!Array.isArray(value) || value.length === 0) {
            throw new TypeError(
              `Expected "${token.name}" to be a non-empty array`,
            );
          }
          let result = "";
          for (let i = 0; i < value.length; i++) {
            const element = segmentString(value[i]);
            if (element === undefined) {
              throw new TypeError(
                `Expected "${token.name}/${i}" to be a string`,
              );
            }
            if (i > 0) {
              result += "/";
            }
            result += encodeURIComponent(element);
          }
          return result;
        };
      }
      return (data, missing) => {
        const value = data[token.name];
        if (value == null) {
          missing.push(token.name);
          return "";
        }
        const text = segmentString(value);
        if (text === undefined) {
          throw new TypeError(`Expected "${token.name}" to be a string`);
        }
        return encodeURIComponent(text);
      };
    });
    return (data, missing) => {
      let result = "";
      for (const builder of builders) {
        result += builder(data, missing);
      }
      return result;
    };
  };
  const builder = build(tokens);
  return (params = {}) => {
    const missing: string[] = [];
    const result = builder(params as Record<string, unknown>, missing);
    if (missing.length > 0) {
      throw new TypeError(`Missing parameters: ${missing.join(", ")}`);
    }
    return result;
  };
}

/** A routejs path whose named wildcards were bridged (see {@link compileRoutePath}). */
interface LegacyScan {
  /** routejs syntax seen: `?`, `+`, `(`, `)`, a bare `*`, `{*}`. */
  legacy: boolean;
  /** Express-only syntax seen: `{…}` groups, quoted or non-ASCII names, a stray `}`. */
  expressOnly: boolean;
  /** The path for routejs, each named wildcard replaced by a regex group. */
  rewritten: string;
  /**
   * What each of routejs's numbered keys (bare `*`, bare `(…)`, and the
   * groups the named wildcards became) stands for, in routejs's order.
   */
  numbered: ({ name: string; kind: CaptureKind } | null)[];
  /** A named wildcard directly after a `:param`, which routejs would merge into it. */
  wildcardAfterParam: string | undefined;
}

/** A param name routejs accepts in full. */
const ROUTEJS_NAME = /^\w+$/;
/** A routejs param-name character. */
const ROUTEJS_NAME_CHAR = /^\w$/;
/** A non-empty capture of anything, for a bridged `*name`. */
const BRIDGED_WILDCARD = "([^]+)";
/** A possibly-empty capture of anything, for a bridged `{*name}`. */
const BRIDGED_OPTIONAL_WILDCARD = "([^]*)";

/**
 * Scans `path` with routejs's tokenizer, noting which syntax it uses and
 * rewriting its named wildcards into groups routejs understands.
 */
function scanLegacy(path: string): LegacyScan {
  const chars = [...path];
  const scan: LegacyScan = {
    legacy: false,
    expressOnly: false,
    rewritten: "",
    numbered: [],
    wildcardAfterParam: undefined,
  };
  /** routejs merges a `(…)` straight after a `:param` into that param. */
  let afterParam = false;
  const readName = (from: number): string => {
    let name = "";
    if (ID_START.test(chars[from] ?? "")) {
      do {
        name += chars[from++];
      } while (ID_CONTINUE.test(chars[from] ?? ""));
    }
    return name;
  };

  let i = 0;
  while (i < chars.length) {
    const char = chars[i];
    if (char === "\\") {
      scan.rewritten += `\\${chars[i + 1] ?? ""}`;
      i += 2;
      afterParam = false;
      continue;
    }
    if (char === ":") {
      if (chars[i + 1] === '"') {
        scan.expressOnly = true;
      }
      const express = readName(i + 1);
      if (express && !ROUTEJS_NAME.test(express)) {
        scan.expressOnly = true;
      }
      let j = i + 1;
      while (j < chars.length && ROUTEJS_NAME_CHAR.test(chars[j])) {
        j++;
      }
      scan.rewritten += chars.slice(i, j).join("");
      afterParam = j > i + 1;
      i = j;
      continue;
    }
    if (char === "(") {
      scan.legacy = true;
      // routejs's group scan: escapes skipped, nested groups counted.
      let j = i + 1;
      let depth = 1;
      while (j < chars.length) {
        if (chars[j] === "\\") {
          j += 2;
          continue;
        }
        if (chars[j] === ")") {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        } else if (chars[j] === "(") {
          depth++;
        }
        j++;
      }
      scan.rewritten += chars.slice(i, j).join("");
      if (!afterParam) {
        scan.numbered.push(null);
      }
      afterParam = false;
      i = j;
      continue;
    }
    if (char === "*") {
      const name = readName(i + 1);
      if (name) {
        if (afterParam) {
          scan.wildcardAfterParam ??= name;
        }
        scan.rewritten += BRIDGED_WILDCARD;
        scan.numbered.push({ name, kind: CAPTURE_WILDCARD });
        i += 1 + [...name].length;
      } else {
        scan.legacy = true;
        scan.rewritten += "*";
        scan.numbered.push(null);
        i += 1;
      }
      afterParam = false;
      continue;
    }
    if (char === "{") {
      if (chars[i + 1] === "*" && chars[i + 2] === "}") {
        scan.legacy = true;
        scan.rewritten += "*";
        scan.numbered.push(null);
        i += 3;
        afterParam = false;
        continue;
      }
      if (chars[i + 1] === "*") {
        const name = readName(i + 2);
        const close = i + 2 + [...name].length;
        if (name && chars[close] === "}") {
          if (afterParam) {
            scan.wildcardAfterParam ??= name;
          }
          scan.rewritten += BRIDGED_OPTIONAL_WILDCARD;
          scan.numbered.push({ name, kind: CAPTURE_OPTIONAL_WILDCARD });
          i = close + 1;
          afterParam = false;
          continue;
        }
      }
      scan.expressOnly = true;
      scan.rewritten += char;
      i += 1;
      afterParam = false;
      continue;
    }
    if (char === "}") {
      scan.expressOnly = true;
    } else if (char === "?" || char === "+" || char === ")") {
      scan.legacy = true;
    }
    scan.rewritten += char;
    i += 1;
    afterParam = false;
  }
  return scan;
}

/**
 * How {@link compileRoutePath} decided to register a path.
 *
 * Not part of the package API: exported for `BunRouter` and the tests,
 * reachable only by a deep import, and may change without notice.
 *
 * @internal
 */
export type RoutePathPlan =
  | {
      /** Compiled here, with path-to-regexp 8's semantics. */
      mode: "express";
      /** The compiled regex and capture keys. */
      compiled: CompiledExpressPath;
      /** Builds a path from params, as path-to-regexp's `compile` (for `route()`). */
      toPath: (params?: object) => string;
    }
  | {
      /** Compiled by routejs, from {@link path}. */
      mode: "routejs";
      /** The path routejs compiles: named wildcards replaced by groups. */
      path: string;
      /**
       * Maps routejs's capture keys to the published ones: routejs numbers
       * bare `*`, bare `(…)` and the bridged wildcards from one counter;
       * published, the bridged ones get their names and the rest are
       * renumbered among themselves. `undefined` when the path has no named
       * wildcard (routejs's keys are then the published ones).
       */
      remap:
        | ((routejsKeys: readonly (string | number)[]) => {
            names: (string | number)[];
            kinds: CaptureKind[];
          })
        | undefined;
      /** Thrown in place of routejs's own error, should routejs reject the path. */
      error: PathSyntaxError;
    };

/**
 * Decides how a route path is registered — Express mode, routejs mode, or a
 * {@link PathSyntaxError} — as the module comment describes.
 *
 * @param path The path as written.
 * @param options `end` (a route, or a `use()` prefix) and `sensitive`.
 * @throws PathSyntaxError for a path neither syntax accepts.
 *
 * Not part of the package API: exported for `BunRouter` and the tests,
 * reachable only by a deep import, and may change without notice.
 *
 * @internal
 */
export function compileRoutePath(
  path: string,
  options: CompileExpressPathOptions = {},
): RoutePathPlan {
  let error: PathSyntaxError;
  try {
    const compiled = compileExpressPath(path, options);
    let toPath: ((params?: object) => string) | undefined;
    return {
      mode: "express",
      compiled,
      // Built on first use: most routes are never named.
      toPath: (params) =>
        (toPath ??= compileToPath(parseExpressPath(path)))(params),
    };
  } catch (caught) {
    if (!(caught instanceof PathSyntaxError)) {
      throw caught;
    }
    error = caught;
  }

  const scan = scanLegacy(path);
  if (scan.expressOnly && scan.legacy) {
    throw new PathSyntaxError(
      `${error.reason}; the path mixes path-to-regexp 8 syntax ({…}, :"…") with routejs syntax (?, +, (…), a bare *)`,
      path,
    );
  }
  if (scan.expressOnly || !scan.legacy) {
    throw error;
  }
  if (scan.wildcardAfterParam !== undefined) {
    throw new PathSyntaxError(
      `Missing text before "${scan.wildcardAfterParam}" wildcard`,
      path,
    );
  }

  const { numbered } = scan;
  const bridged = numbered.some((entry) => entry !== null);
  return {
    mode: "routejs",
    path: scan.rewritten,
    error,
    remap: bridged
      ? (routejsKeys) => {
          const names: (string | number)[] = [];
          const kinds: CaptureKind[] = [];
          let bare = 0;
          for (const key of routejsKeys) {
            if (typeof key !== "number") {
              names.push(key);
              kinds.push(CAPTURE_PARAM);
              continue;
            }
            const entry = numbered[key];
            if (entry === null || entry === undefined) {
              names.push(bare++);
              kinds.push(CAPTURE_PARAM);
            } else {
              names.push(entry.name);
              kinds.push(entry.kind);
            }
          }
          return { names, kinds };
        }
      : undefined,
  };
}
