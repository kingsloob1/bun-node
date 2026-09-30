import type { RunLogRedactOptions } from "./types";
import { DEFAULT_REDACT_REPLACEMENT } from "../api/contract/constants";

/**
 * Scrubbing secrets out of captured run-log lines before they are stored.
 *
 * A run's output is a place secrets end up by accident — a config dumped at
 * start-up, a connection string in an error, an `Authorization` header in a
 * debug line — and a stored log outlives the run, is served over the
 * management API and is shown in a browser. So capture redacts every line, on
 * every stream, by default.
 *
 * **What the defaults catch** (see {@link DEFAULT_REDACT_KEYS}):
 *
 * 1. the value of a key whose name *contains* a sensitive word, written
 *    `key=value`, `key: value`, `key="…"`, `key='…'` or JSON-style
 *    `"key": "…"` / `"key": 123` — the key, its quotes and the separator are
 *    kept, the value becomes the replacement. An auth scheme stays readable:
 *    `Authorization: Bearer abc` → `Authorization: Bearer [REDACTED]`;
 * 2. a bare `Bearer <token>` anywhere;
 * 3. the password in a URL's credentials, `scheme://user:pass@host`;
 * 4. a JSON Web Token (`eyJ….….…`) anywhere.
 *
 * **What they do not**: a secret in prose ("the password is hunter2"), token
 * shapes other than a JWT (add them with `patterns`), and in an unquoted
 * `key=value` the words after the first space.
 *
 * Matching the key by substring is deliberately generous — `max_tokens=100`
 * and `author=ada` are scrubbed too. A log that loses a harmless number is a
 * smaller failure than one that keeps a password, and `defaults: false` plus
 * your own `keys` is the way out when it matters.
 *
 * Every step here runs in time linear in the line: a key is only matched
 * from the start of a token, never from each character inside one, and a
 * URL's scheme is found by walking back from its `://` rather than tried from
 * every word boundary (see {@link urlPasswordStep}), so a megabyte-long line
 * of letters and dots is one scan, not a quadratic backtrack.
 */

/**
 * What a scrubbed value becomes, unless `replacement` says otherwise. Defined
 * once, in the browser-safe contract, so a log view names the same marker.
 */
export { DEFAULT_REDACT_REPLACEMENT };

/**
 * The words that make a key sensitive: a key whose name contains one of them,
 * case-insensitively, has its value scrubbed. `key` alone is not one — it
 * would take `cacheKey` and every `key=` in a log with it.
 */
export const DEFAULT_REDACT_KEYS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "api-key",
  "authorization",
  "auth",
  "credential",
  "cookie",
  "session",
  "private_key",
  "privatekey",
  "access_key",
  "accesskey",
] as const;

/**
 * A key and the separator after it. The lookbehind is what keeps this linear:
 * a key can only start where a token starts.
 */
const KEY_AND_SEPARATOR = /(?<![\w.\-])(["']?)([\w.\-]+)\1(\s*[:=]\s*)/g;

/**
 * The value after a sensitive key: a quoted string (an unterminated one runs
 * to the end of the line, so a line cut mid-value still hides it), or a bare
 * word, optionally after an auth scheme that stays visible.
 */
const VALUE =
  /"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|((?:bearer|basic|token|digest)\s+)?[^\s,;&"'}\]]+/iy;

/** One scrubbing step: a line in, the line with its matches replaced out. */
type Step = (text: string) => string;

/** A step replacing every match of a global `pattern` with `rewrite`. */
function patternStep(
  /** The expression, global; this step owns it (its `lastIndex` is reset per line). */
  pattern: RegExp,
  /** What a match becomes, as a `String.replace` template. */
  rewrite: string,
): Step {
  return (text) => {
    pattern.lastIndex = 0;
    return text.replace(pattern, rewrite);
  };
}

/** A character a URL scheme may hold after its first (RFC 3986). */
const SCHEME_CHAR = /[a-z\d+.\-]/i;

/** A scheme's first character. */
const SCHEME_START = /[a-z]/i;

/** A character `\b` counts as part of a word. */
const WORD_CHAR = /\w/;

/**
 * After a scheme's `://`: the user name and its `:` (captured), the password,
 * and the `@`. Each run stops at a character it cannot hold, so it never
 * backtracks.
 */
const URL_CREDENTIALS = /:\/\/[^\s:/@]*:[^\s@/]+@/y;

/**
 * The password in a URL's credentials, `scheme://user:pass@host`; the scheme
 * and user name stay. Exactly what
 * `/\b([a-z][a-z\d+.\-]*:\/\/[^\s:/@]*:)[^\s@/]+@/gi` replaces with
 * `$1<replacement>@`, found in linear time: that expression tried a scheme
 * from every word boundary in a run of letters and dots and scanned the run
 * to its end each time, so `"a.".repeat(50_000)` took about two seconds. Here
 * each `://` is found once, and its scheme is the leftmost letter at a word
 * boundary in the run of scheme characters before it — the start the
 * expression's leftmost match settles on.
 *
 * Exported for its differential test against that expression, not from the
 * package's entry points.
 */
export function urlPasswordStep(
  /** What the password becomes, used as it is (not a `replace` template). */
  replacement: string,
): Step {
  return (text) => {
    let out = "";
    let copied = 0;
    let from = text.indexOf("://");
    while (from !== -1) {
      // The run of scheme characters before the `://`. It never reaches back
      // into an earlier match, which ends in `@`, nor past an earlier `://`,
      // so each character is walked at most once.
      let runStart = from;
      while (runStart > 0 && SCHEME_CHAR.test(text[runStart - 1]!)) {
        runStart -= 1;
      }
      let schemeStart = -1;
      for (let at = runStart; at < from; at++) {
        if (
          SCHEME_START.test(text[at]!) &&
          (at === 0 || !WORD_CHAR.test(text[at - 1]!))
        ) {
          schemeStart = at;
          break;
        }
      }
      URL_CREDENTIALS.lastIndex = from;
      const credentials =
        schemeStart === -1 ? null : URL_CREDENTIALS.exec(text);
      if (credentials === null) {
        from = text.indexOf("://", from + 1);
        continue;
      }
      // `user:` ends at the first `:` after `://` (a user name holds none);
      // the `@` ends the match.
      const end = from + credentials[0].length;
      const userEnd = text.indexOf(":", from + 3) + 1;
      out += `${text.slice(copied, userEnd)}${replacement}@`;
      copied = end;
      from = text.indexOf("://", end);
    }
    return copied === 0 ? text : out + text.slice(copied);
  };
}

/** Default steps applied after the key rule, in order, given the replacement. */
const DEFAULT_STEPS: readonly ((
  replacement: string,
  template: string,
) => Step)[] = [
  // A bearer token on its own, outside any `key: value`.
  (_, template) =>
    patternStep(/\b(bearer)\s+[\w\-.~+/]+=*/gi, `$1 ${template}`),
  // The password in a URL's credentials; the user name stays.
  (replacement) => urlPasswordStep(replacement),
  // A JSON Web Token: base64url of `{"` begins every header.
  (_, template) => patternStep(/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, template),
];

/** A compiled redactor: takes a line, returns it with its secrets scrubbed. */
export type RunLogRedactor = (text: string) => string;

/** Replacement text, escaped for use as a `String.replace` template. */
function asTemplate(text: string): string {
  return text.replaceAll("$", "$$$$");
}

/** A user pattern, made global so `replace` scrubs every match, not the first. */
function globalOf(pattern: RegExp): RegExp {
  return pattern.flags.includes("g")
    ? new RegExp(pattern.source, pattern.flags)
    : new RegExp(pattern.source, `${pattern.flags}g`);
}

/**
 * Compiles redaction options into a redactor, or `null` when redaction is off.
 *
 * `true`/`undefined` is the defaults; `false` is off; an object adds `keys`
 * and `patterns` to the defaults, or replaces them with `defaults: false`.
 */
export function createRedactor(
  /** The runner's `captureLogs.redact`. */
  options: boolean | RunLogRedactOptions | undefined,
): RunLogRedactor | null {
  if (options === false) {
    return null;
  }

  const given: RunLogRedactOptions =
    options === true || !options ? {} : options;
  const useDefaults = given.defaults ?? true;
  const replacement = given.replacement ?? DEFAULT_REDACT_REPLACEMENT;
  const template = asTemplate(replacement);

  const keys = [
    ...(useDefaults ? DEFAULT_REDACT_KEYS : []),
    ...(given.keys ?? []),
  ]
    .map((key) => key.toLowerCase())
    .filter((key) => key !== "");

  const steps: Step[] = [
    ...(useDefaults
      ? DEFAULT_STEPS.map((step) => step(replacement, template))
      : []),
    ...(given.patterns ?? []).map((pattern) =>
      patternStep(globalOf(pattern), template),
    ),
  ];

  if (keys.length === 0 && steps.length === 0) {
    return null;
  }

  const isSensitive = (key: string): boolean => {
    const lower = key.toLowerCase();
    return keys.some((word) => lower.includes(word));
  };

  const scrubValues = (text: string): string => {
    if (keys.length === 0) {
      return text;
    }

    const keyed = new RegExp(KEY_AND_SEPARATOR.source, "g");
    const value = new RegExp(VALUE.source, VALUE.flags);
    let out = "";
    let copied = 0;

    for (
      let match = keyed.exec(text);
      match !== null;
      match = keyed.exec(text)
    ) {
      // Only the key and separator were consumed, so a key that is not
      // sensitive leaves its value to be scanned: `Error: password=x` still
      // finds `password`.
      if (!isSensitive(match[2]!)) {
        continue;
      }

      const start = keyed.lastIndex;
      value.lastIndex = start;
      const found = value.exec(text);
      if (!found) {
        continue;
      }

      const raw = found[0];
      const scrubbed = raw.startsWith('"')
        ? `"${replacement}"`
        : raw.startsWith("'")
          ? `'${replacement}'`
          : `${found[1] ?? ""}${replacement}`;

      out += text.slice(copied, start) + scrubbed;
      copied = start + raw.length;
      keyed.lastIndex = copied;
    }

    return copied === 0 ? text : out + text.slice(copied);
  };

  return (text: string): string => {
    let result = scrubValues(text);
    for (const step of steps) {
      result = step(result);
    }
    return result;
  };
}
