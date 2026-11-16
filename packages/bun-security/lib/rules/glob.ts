/**
 * Globs for request rules (layers.md L7): `*` (any run of characters but
 * `/`), `**` (any run, `/` included; `**` before a `/` also matches
 * nothing, so the glob `/**\/.env` matches `/.env`) and `?` (one character
 * but `/`); every other
 * character is literal. Compiled to a matcher, never to a regular
 * expression, so its cost is bounded whatever the pattern: at most the
 * input's length times the number of wildcards, one table of the pattern's
 * tokens per call, no backtracking.
 */

/** The longest glob accepted. */
export const MAX_GLOB_LENGTH = 512;

/** One token of a glob. */
type Token =
  | {
      /** A literal run. */
      readonly kind: "text";
      /** Its characters (folded when the glob ignores case). */
      readonly text: string;
    }
  | {
      /** `*`, `**`, `**` before `/` (any run ending in `/`, or nothing) or `?`. */
      readonly kind: "star" | "globstar" | "globstarSlash" | "one";
    };

/** A compiled glob. */
export type GlobMatcher = (input: string) => boolean;

/** Why a glob was refused, or `undefined` when it is accepted. */
export function globRefusal(pattern: string): string | undefined {
  if (pattern.length === 0) return "an empty glob matches nothing";
  if (pattern.length > MAX_GLOB_LENGTH) {
    return `longer than ${MAX_GLOB_LENGTH} characters`;
  }
  if (pattern.includes("***")) return '"***" is not a glob token ("*" or "**")';
  return undefined;
}

/** The tokens of `pattern`. */
function tokenize(pattern: string, ignoreCase: boolean): Token[] {
  const tokens: Token[] = [];
  let text = "";
  const flush = () => {
    if (text !== "") {
      tokens.push({
        kind: "text",
        text: ignoreCase ? text.toLowerCase() : text,
      });
      text = "";
    }
  };
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      flush();
      if (pattern[i + 1] === "*" && pattern[i + 2] === "/") {
        tokens.push({ kind: "globstarSlash" });
        i += 2;
      } else if (pattern[i + 1] === "*") {
        tokens.push({ kind: "globstar" });
        i++;
      } else {
        tokens.push({ kind: "star" });
      }
    } else if (char === "?") {
      flush();
      tokens.push({ kind: "one" });
    } else {
      text += char;
    }
  }
  flush();
  return tokens;
}

/**
 * Compiles a glob (see the module's description); throws a `TypeError` for
 * one {@link globRefusal} refuses. With `ignoreCase` both sides are folded
 * to lower case.
 *
 * The match runs over the input once per token, keeping the set of input
 * positions each prefix of the pattern can reach (a bit per position), so
 * it never backtracks: three globstars against a long path cost the same
 * steps as any other three-wildcard glob.
 */
export function compileGlob(pattern: string, ignoreCase = false): GlobMatcher {
  const refusal = globRefusal(pattern);
  if (refusal !== undefined)
    throw new TypeError(`glob ${JSON.stringify(pattern)}: ${refusal}`);
  const tokens = tokenize(pattern, ignoreCase);
  return (raw) => {
    const input = ignoreCase ? raw.toLowerCase() : raw;
    const length = input.length;
    // reach[i]: the pattern so far can end at input position i.
    let reach = new Uint8Array(length + 1);
    reach[0] = 1;
    for (const token of tokens) {
      const next = new Uint8Array(length + 1);
      let any = false;
      switch (token.kind) {
        case "text": {
          const text = token.text;
          for (let i = 0; i + text.length <= length; i++) {
            if (reach[i] === 1 && input.startsWith(text, i)) {
              next[i + text.length] = 1;
              any = true;
            }
          }
          break;
        }
        case "one":
          for (let i = 0; i < length; i++) {
            if (reach[i] === 1 && input.charCodeAt(i) !== 0x2f /* / */) {
              next[i + 1] = 1;
              any = true;
            }
          }
          break;
        case "globstarSlash": {
          // Nothing, or any run ending in `/`: one pass.
          let open = false;
          for (let i = 0; i <= length; i++) {
            if (reach[i] === 1) {
              next[i] = 1;
              any = true;
              open = true;
            }
            if (open && i < length && input.charCodeAt(i) === 0x2f /* / */) {
              next[i + 1] = 1;
              any = true;
            }
          }
          break;
        }
        case "star":
        case "globstar": {
          // A running "reachable" flag, reset at `/` for `*`: one pass.
          let open = false;
          for (let i = 0; i <= length; i++) {
            if (reach[i] === 1) open = true;
            if (open) {
              next[i] = 1;
              any = true;
            }
            if (
              token.kind === "star" &&
              i < length &&
              input.charCodeAt(i) === 0x2f /* / */
            ) {
              open = false;
            }
          }
          break;
        }
      }
      if (!any) return false;
      reach = next;
    }
    return reach[length] === 1;
  };
}
