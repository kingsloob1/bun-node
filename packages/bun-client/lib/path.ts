/**
 * Builds a URL path from a route's path literal and its params: the inverse
 * of the server's matcher (path-to-regexp 8, Express 5's syntax, which
 * bun-common compiles; `bun-common/lib/utils/expressPath.ts`).
 *
 * - `:name`, `:"any name"`: the value, `encodeURIComponent`-ed;
 * - `*name`: an array of segments, each encoded, joined by `/`;
 * - `{…}`: an optional group, written only when every param inside it is
 *   given (path-to-regexp's `compile`);
 * - `\x`: the character itself;
 * - routejs's `:name?` (the param and the `/` before it are dropped when
 *   absent) and `:name(regex)` (the constraint is skipped).
 *
 * Compiled once per path and cached, so a call costs a walk of the tokens.
 */
import { ClientError } from "./errors";

/** One piece of a compiled path. */
type Token =
  | { kind: "text"; value: string }
  | { kind: "param"; name: string; optional: boolean }
  | { kind: "wildcard"; name: string }
  | { kind: "group"; tokens: Token[] };

/** A param's value as the URL builder accepts it. */
export type PathParamValue =
  | string
  | number
  | boolean
  | bigint
  | readonly (string | number | boolean | bigint)[];

const ID_START = /^[$_\p{ID_Start}]$/u;
const ID_CONTINUE = /^[$\u200C\u200D\p{ID_Continue}]$/u;

/** Compiled paths, by literal. Paths are few and fixed (a route map's keys). */
const compiled = new Map<string, Token[]>();

/** Reads a param name at `from` (after `:` or `*`): `[name, next index]`. */
function readName(path: string, from: number): [string, number] {
  if (path[from] === '"') {
    let name = "";
    let at = from + 1;
    while (at < path.length && path[at] !== '"') {
      if (path[at] === "\\") at++;
      name += path[at] ?? "";
      at++;
    }
    return [name, at + 1];
  }
  let at = from;
  if (ID_START.test(path[at] ?? "")) {
    do at++;
    while (ID_CONTINUE.test(path[at] ?? ""));
  }
  return [path.slice(from, at), at];
}

/** Skips a routejs `(…)` constraint at `from`, nested parens and escapes included. */
function skipConstraint(path: string, from: number): number {
  let depth = 0;
  let at = from;
  do {
    if (path[at] === "\\") at++;
    else if (path[at] === "(") depth++;
    else if (path[at] === ")") depth--;
    at++;
  } while (depth > 0 && at < path.length);
  return at;
}

/** Tokenises `path` from `at` until a closing `}` or the end: `[tokens, next index]`. */
function tokenize(path: string, at = 0): [Token[], number] {
  const tokens: Token[] = [];
  let text = "";
  const flush = () => {
    if (text) tokens.push({ kind: "text", value: text });
    text = "";
  };
  while (at < path.length) {
    const char = path[at];
    if (char === "\\") {
      text += path[at + 1] ?? "";
      at += 2;
    } else if (char === "}") {
      flush();
      return [tokens, at + 1];
    } else if (char === "{") {
      flush();
      const [inner, next] = tokenize(path, at + 1);
      tokens.push({ kind: "group", tokens: inner });
      at = next;
    } else if (char === ":" || char === "*") {
      const [name, next] = readName(path, at + 1);
      if (!name) {
        text += char;
        at++;
        continue;
      }
      flush();
      at = next;
      if (char === "*") {
        tokens.push({ kind: "wildcard", name });
        continue;
      }
      if (path[at] === "(") at = skipConstraint(path, at);
      const optional = path[at] === "?";
      if (optional) {
        at++;
        // routejs: the `/` before an optional param belongs to it.
        const previous = tokens.at(-1);
        if (previous?.kind === "text" && previous.value.endsWith("/")) {
          previous.value = previous.value.slice(0, -1);
          if (!previous.value) tokens.pop();
          tokens.push({
            kind: "group",
            tokens: [
              { kind: "text", value: "/" },
              { kind: "param", name, optional: false },
            ],
          });
          continue;
        }
      }
      tokens.push({ kind: "param", name, optional });
    } else {
      text += char;
      at++;
    }
  }
  flush();
  return [tokens, at];
}

/** Writes one param value into the path. */
function encodeSegment(value: unknown): string {
  return encodeURIComponent(String(value));
}

/**
 * Writes `tokens` with `params`: `[text, missing]`, where `missing` names the
 * params a token needed and did not get.
 */
function write(
  tokens: readonly Token[],
  params: Readonly<Record<string, unknown>>,
): [string, string[]] {
  let out = "";
  const missing: string[] = [];
  for (const token of tokens) {
    if (token.kind === "text") {
      out += token.value;
    } else if (token.kind === "group") {
      const [inner, innerMissing] = write(token.tokens, params);
      if (!innerMissing.length) out += inner;
    } else {
      const value = Object.hasOwn(params, token.name)
        ? params[token.name]
        : undefined;
      if (value === undefined || value === null) {
        if (!(token.kind === "param" && token.optional))
          missing.push(token.name);
        continue;
      }
      if (token.kind === "wildcard") {
        const segments: readonly unknown[] = Array.isArray(value)
          ? value
          : [value];
        if (!segments.length) {
          missing.push(token.name);
          continue;
        }
        out += segments.map(encodeSegment).join("/");
      } else {
        out += encodeSegment(value);
      }
    }
  }
  return [out, missing];
}

/**
 * The path `pattern` with `params` written into it.
 *
 * @throws ClientError when a required param is missing (a type error for a
 *   typed caller; this is the untyped caller's error).
 */
export function buildPath(
  pattern: string,
  params: Readonly<Record<string, unknown>> = {},
  key?: string,
): string {
  let tokens = compiled.get(pattern);
  if (!tokens) {
    tokens = tokenize(pattern)[0];
    compiled.set(pattern, tokens);
  }
  const [path, missing] = write(tokens, params);
  if (missing.length) {
    throw new ClientError(
      `Missing path param${missing.length > 1 ? "s" : ""} ${missing.map((name) => `"${name}"`).join(", ")} for ${pattern}`,
      { key },
    );
  }
  return path;
}
