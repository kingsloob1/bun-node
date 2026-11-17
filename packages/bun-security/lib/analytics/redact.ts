/**
 * The one redaction module (README §8.1, the user's rules of 2026-11-17):
 * what of a request an event may keep. It never keeps a credential.
 *
 * - **Keys.** A header, query or body field whose name contains a
 *   sensitive word (case-insensitive, `_` and `-` ignored: `password`,
 *   `pass`, `pwd`, `secret`, `token`, `key`, `auth`, `session`, `cookie`,
 *   `credential`, `signature`, `otp`, `code`, `pin`, `card`, `account`,
 *   `iban`, `ssn`, `bvn`, `nin`, `cvv`, national identifiers…) has its
 *   value replaced by `[redacted]`.
 * - **Values.** A value that looks like a credential is replaced whatever
 *   its key: a JWT, `Bearer …`, a Luhn-valid card number, or a run of 24 or
 *   more base64 or hex characters with letters and digits in it.
 * - **Bodies.** JSON and form-urlencoded bodies are kept as fields, with the
 *   rules above, depth at most 5, 4 KB in all; on the sensitive profiles
 *   (`login`, `mfa`, `otp`, `reset`, `signup`) only the field names are
 *   kept. Any other content type keeps its type and length, never a byte.
 * - **Paths.** The route's template where it is known; otherwise each
 *   segment that looks like a credential becomes `:redacted`. The query
 *   follows the key and value rules, 1 KB in all.
 * - **Answers.** The status and the headers (with `set-cookie` redacted);
 *   a body only when the engine answered itself, never the app's.
 * - **Caps.** 60 headers, 512 characters a value.
 */

/** What replaces a redacted value. */
export const REDACTED = "[redacted]";

/** What replaces a value cut by a budget. */
export const TRUNCATED = "[truncated]";

/** What replaces a credential-looking path segment. */
export const REDACTED_SEGMENT = ":redacted";

/** The words a sensitive key contains, normalised (lower case, no `_` or `-`). */
export const SENSITIVE_KEY_WORDS: readonly string[] = Object.freeze([
  "password",
  "passwd",
  "pass",
  "pwd",
  "secret",
  "token",
  "signature",
  "otp",
  "code",
  "pin",
  "card",
  "account",
  "iban",
  "ssn",
  "bvn",
  "nin",
  "cvv",
  "key",
  "auth",
  "session",
  "cookie",
  "credential",
  "passport",
  "nationalid",
  "taxid",
]);

/** The headers always redacted, whatever their names contain. */
export const CREDENTIAL_HEADERS: readonly string[] = Object.freeze([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-service-token",
  "x-csrf-token",
  "x-xsrf-token",
]);

/** The route profiles whose bodies keep field names only. */
export const SENSITIVE_PROFILES: readonly string[] = Object.freeze([
  "login",
  "mfa",
  "otp",
  "reset",
  "signup",
]);

/** The caps (README §8.1). */
export const REDACTION_LIMITS = Object.freeze({
  /** Headers kept. */
  headers: 60,
  /** Characters a header or field value keeps. */
  value: 512,
  /** Bytes of JSON a body keeps. */
  body: 4_096,
  /** Bytes of JSON a query keeps. */
  query: 1_024,
  /** Bytes an engine's own answer body keeps. */
  answer: 1_024,
  /** A body's nesting depth. */
  depth: 5,
});

/** Options of the redaction. */
export interface RedactionOptions {
  /** More sensitive words for keys (the policy's list), added to {@link SENSITIVE_KEY_WORDS}. */
  readonly keys?: readonly string[];
  /** More headers always redacted (the policy's service-identity header, a custom auth header). */
  readonly headers?: readonly string[];
}

/** A request to sample. */
export interface SampleInput {
  /** The method. */
  readonly method: string;
  /** The path, without the query. */
  readonly path: string;
  /** The query, without its `?`. */
  readonly query?: string;
  /** The route's template (`/users/:id`), when the route is known. */
  readonly routeTemplate?: string;
  /** The route profile (`login`), when the route has one. */
  readonly profile?: string;
  /** The headers, any case. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The body, when it was read. */
  readonly body?: {
    /** Its `Content-Type`. */
    readonly type?: string;
    /** Its length in bytes. */
    readonly length?: number;
    /** Its text, for JSON and form bodies; never kept as text. */
    readonly text?: string;
    /** Its parsed value, when the app parsed it (JSON, or a form as an object). */
    readonly parsed?: unknown;
  };
  /** How it was answered. */
  readonly answer?: {
    /** The status. */
    readonly status: number;
    /** The headers. */
    readonly headers?: Readonly<Record<string, string>>;
    /** The body's text. Kept only when `byEngine`. */
    readonly body?: string;
    /** Whether the engine answered (a refusal, a challenge), not the app. */
    readonly byEngine: boolean;
  };
}

/** A redacted request: an event's `sample`. */
export interface RequestSample {
  /** The method. */
  readonly method: string;
  /** The route template, or the path with credential-looking segments redacted. */
  readonly path: string;
  /** The query's fields, redacted. */
  readonly query?: Readonly<Record<string, unknown>>;
  /** The headers, lower-cased and redacted. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body: its type and length, and its fields for JSON and forms. */
  readonly body?: {
    /** Its content type, without parameters. */
    readonly type: string;
    /** Its length in bytes, when known. */
    readonly length?: number;
    /** Its fields, redacted (names only on a sensitive profile). */
    readonly fields?: unknown;
    /** Whether a budget cut it. */
    readonly truncated?: boolean;
  };
  /** How it was answered. */
  readonly answer?: {
    /** The status. */
    readonly status: number;
    /** The headers, redacted. */
    readonly headers?: Readonly<Record<string, string>>;
    /** The engine's own body, capped; never the app's. */
    readonly body?: string;
  };
}

/** Measures a body's text in bytes. */
const encoder = new TextEncoder();

/** A JWT: three base64url parts, the first a JSON object's (`eyJ`). */
const JWT = /\beyJ[\w-]{2,}\.[\w-]{2,}\.[\w-]*/;
/** A bearer credential anywhere in the value. */
const BEARER = /\bbearer\s+\S/i;
/** A run of base64 or base64url characters long enough to be a key. */
const LONG_RUN = /[\w+/=-]{24,}/g;
/** A run of hex digits long enough to be a key. */
const HEX_RUN = /\b[\da-f]{24,}\b/i;
/** A card number: 13 to 19 digits, spaced or dashed. */
const CARD = /(?:\d[ -]?){12,18}\d/g;

/** Whether a digit string passes the Luhn check. */
function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Whether a value looks like a credential, whatever its key. */
export function looksLikeCredential(value: string): boolean {
  if (JWT.test(value) || BEARER.test(value) || HEX_RUN.test(value)) return true;
  for (const run of value.match(LONG_RUN) ?? []) {
    if (/\d/.test(run) && /[a-z]/i.test(run)) return true;
  }
  for (const candidate of value.match(CARD) ?? []) {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
  }
  return false;
}

/** A redactor: the key and value rules with a policy's additions. */
export interface Redactor {
  /** Whether a key (a header, query or body field name) is sensitive. */
  readonly sensitiveKey: (key: string) => boolean;
  /** A request's sample. */
  readonly sample: (input: SampleInput) => RequestSample;
}

/** A value cut to the value cap. */
function capValue(value: string): string {
  return value.length <= REDACTION_LIMITS.value
    ? value
    : `${value.slice(0, REDACTION_LIMITS.value - 1)}…`;
}

/** The redactor for `options`; see the module's description. */
export function createRedactor(options: RedactionOptions = {}): Redactor {
  const words = [...SENSITIVE_KEY_WORDS, ...(options.keys ?? [])].map((word) =>
    word.toLowerCase().replace(/[_-]/g, ""),
  );
  const headers = new Set(
    [...CREDENTIAL_HEADERS, ...(options.headers ?? [])].map((name) =>
      name.toLowerCase(),
    ),
  );

  const sensitiveKey = (key: string): boolean => {
    const normal = key.toLowerCase().replace(/[_-]/g, "");
    return words.some((word) => word !== "" && normal.includes(word));
  };

  /** One string under the value rule. */
  const scalar = (value: string): string =>
    looksLikeCredential(value) ? REDACTED : capValue(value);

  /**
   * A JSON value redacted within a byte budget: sensitive keys and
   * credential-looking values replaced, `namesOnly` replacing every leaf.
   */
  const fields = (
    value: unknown,
    budget: number,
    namesOnly: boolean,
  ): { value: unknown; truncated: boolean } => {
    let left = budget;
    let truncated = false;
    const spend = (out: unknown): unknown => {
      const size = JSON.stringify(out)?.length ?? 4;
      if (size > left) {
        truncated = true;
        return TRUNCATED;
      }
      left -= size;
      return out;
    };
    const walk = (node: unknown, depth: number): unknown => {
      if (
        node === null ||
        typeof node === "boolean" ||
        typeof node === "number"
      ) {
        return spend(namesOnly ? REDACTED : node);
      }
      if (typeof node === "string")
        return spend(namesOnly ? REDACTED : scalar(node));
      if (depth >= REDACTION_LIMITS.depth) {
        truncated = true;
        return TRUNCATED;
      }
      if (Array.isArray(node)) {
        const out: unknown[] = [];
        for (const item of node) {
          if (left <= 0) {
            truncated = true;
            break;
          }
          out.push(walk(item, depth + 1));
        }
        return out;
      }
      if (typeof node === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(node)) {
          if (left <= 0) {
            truncated = true;
            break;
          }
          const name = capValue(key);
          left -= name.length + 3;
          out[name] = sensitiveKey(key)
            ? spend(REDACTED)
            : walk(item, depth + 1);
        }
        return out;
      }
      return spend(REDACTED);
    };
    return { value: walk(value, 0), truncated };
  };

  /** A form or query string as an object of its fields (a repeated name as a list). */
  const formFields = (text: string): Record<string, string | string[]> => {
    const out: Record<string, string | string[]> = {};
    for (const [key, value] of new URLSearchParams(text)) {
      const before = out[key];
      out[key] = before === undefined ? value : [...[before].flat(), value];
    }
    return out;
  };

  /** Headers lower-cased and redacted, at most 60. */
  const headerFields = (
    input: Readonly<Record<string, string>> | undefined,
  ): Record<string, string> => {
    const out: Record<string, string> = {};
    let count = 0;
    for (const [rawName, value] of Object.entries(input ?? {})) {
      if (count >= REDACTION_LIMITS.headers) break;
      const name = rawName.toLowerCase();
      out[name] =
        headers.has(name) || sensitiveKey(name)
          ? REDACTED
          : scalar(String(value));
      count += 1;
    }
    return out;
  };

  /** The path: the template, or each credential-looking segment redacted. */
  const pathOf = (input: SampleInput): string => {
    if (input.routeTemplate !== undefined) return capValue(input.routeTemplate);
    return capValue(
      input.path
        .split("/")
        .map((segment) => {
          let decoded = segment;
          try {
            decoded = decodeURIComponent(segment);
          } catch {
            // A malformed escape is judged as written.
          }
          return looksLikeCredential(decoded) ? REDACTED_SEGMENT : segment;
        })
        .join("/"),
    );
  };

  /** A body's sample: fields for JSON and forms, the type and length for anything else. */
  const bodyOf = (input: SampleInput): RequestSample["body"] => {
    const body = input.body;
    if (body === undefined) return undefined;
    const type = (body.type ?? "").split(";")[0].trim().toLowerCase();
    const length =
      body.length ??
      (body.text === undefined ? undefined : encoder.encode(body.text).length);
    const base = { type, ...(length === undefined ? {} : { length }) };
    const json = type === "application/json" || type.endsWith("+json");
    const form = type === "application/x-www-form-urlencoded";
    if (!json && !form) return base;
    let value: unknown = body.parsed;
    if (value === undefined && body.text !== undefined) {
      if (form) value = formFields(body.text);
      else {
        try {
          value = JSON.parse(body.text) as unknown;
        } catch {
          return { ...base, truncated: true };
        }
      }
    }
    if (value === undefined) return base;
    const namesOnly =
      input.profile !== undefined && SENSITIVE_PROFILES.includes(input.profile);
    const out = fields(value, REDACTION_LIMITS.body, namesOnly);
    return {
      ...base,
      fields: out.value,
      ...(out.truncated ? { truncated: true } : {}),
    };
  };

  const sample = (input: SampleInput): RequestSample => {
    const query =
      input.query === undefined || input.query === ""
        ? undefined
        : (fields(
            formFields(input.query.replace(/^\?/, "")),
            REDACTION_LIMITS.query,
            false,
          ).value as Record<string, unknown>);
    const body = bodyOf(input);
    const answer = input.answer;
    return Object.freeze({
      method: capValue(input.method.toUpperCase()),
      path: pathOf(input),
      ...(query === undefined ? {} : { query }),
      headers: headerFields(input.headers),
      ...(body === undefined ? {} : { body }),
      ...(answer === undefined
        ? {}
        : {
            answer: {
              status: answer.status,
              ...(answer.headers === undefined
                ? {}
                : { headers: headerFields(answer.headers) }),
              ...(answer.byEngine && answer.body !== undefined
                ? {
                    body:
                      answer.body.length <= REDACTION_LIMITS.answer
                        ? answer.body
                        : `${answer.body.slice(0, REDACTION_LIMITS.answer - 1)}…`,
                  }
                : {}),
            },
          }),
    });
  };

  return Object.freeze({ sensitiveKey, sample });
}
