import type { LogFields, Logger } from "../shared/logger";
import { createRedactor, DEFAULT_REDACT_REPLACEMENT } from "../runner/redact";
import { isCredentialKey, URL_USERINFO } from "../shared/credentialKeys";

/**
 * Redaction for what a provider logs (plugins §13.3).
 *
 * A provider's `ctx.logger` passes every message and every field through two
 * passes before the host's logger sees it:
 *
 * 1. **exact values**: each declared secret of the current config (strings of
 *    {@link MIN_SECRET_LENGTH} characters or more; a shorter one would take
 *    ordinary words with it) is replaced wherever it appears: as it is,
 *    URL-encoded (`encodeURIComponent`'s form and a form's, `+` for a
 *    space, each also with lower-case percent-escapes) and escaped for a
 *    regular expression (see {@link encodedForms});
 * 2. **patterns**: the runner's redactor (`createRedactor` with its
 *    defaults: `key=value` pairs under a sensitive key, `Bearer …`, a URL's
 *    password, a JWT), then a bare `Basic <base64>` or base64url credential
 *    (when it decodes to `user:password`), the values of `X-Amz-Signature=`
 *    and `X-Goog-Signature=`, of an Azure SAS `sig=` inside a query, and of
 *    an `x-amz-signature:` header. A field whose *name* is a credential's,
 *    by the rule the status route's fact filter uses (`isCredentialKey`: a
 *    credential word as one of the name's words, or ending it), has its
 *    value replaced whole: `apiKey`, `authToken` and `sessiontoken` are,
 *    `author` is not. Keys are text too, redacted like values.
 *
 * A URL's userinfo is replaced whole, whatever it holds (the status route's
 * rule): `https://ghp_…@github.com` and a Sentry DSN's key included. A value
 * the walk would not otherwise read is converted first — a `URL` to its
 * text, `Headers`, `URLSearchParams` and a `Map` to their entries, a `Set`
 * to its items, an object with a `toJSON` method (a `Date` with its own
 * included) to what it returns (called guarded: a throw is `[Unreadable]`),
 * another class instance to its own fields, a `RegExp` or a `String` object
 * to its text, a `Symbol` to its description — so both rules apply to it.
 * Binary data (a `Buffer`, a typed array, an `ArrayBuffer`, a `DataView`, a
 * `Blob` or `File`) is replaced by `[Binary <n> bytes]` and a function by
 * `[Function]`. An error is copied with its class and, as its own
 * properties, its fields and `name`, `message`, `stack`, `code` and `cause`,
 * plus a `toJSON` returning that redacted view, so neither a host class's
 * brand-checked getters (a `DOMException`'s) nor a `toJSON` on its
 * prototype runs on the copy; one still unreadable becomes a plain `Error`.
 * Anything deeper than the walk goes is replaced, never passed through.
 *
 * It is text-level, so it misses what the runner's redactor misses (a secret
 * in prose, token shapes other than those above); declaring secrets is how a
 * provider closes that gap for its own values.
 */

/** The shortest declared secret redacted by value. */
export const MIN_SECRET_LENGTH = 8;

/** How deep a field value is walked; anything deeper is replaced whole. */
const MAX_DEPTH = 8;

/** The runner's default pattern redactor, compiled once. */
const PATTERNS = createRedactor(true)!;

/** {@link URL_USERINFO}, global, for replacing every occurrence. */
const USERINFO = new RegExp(URL_USERINFO.source, "g");

/**
 * A bare `Basic` credential: the scheme, then a run of base64 or base64url
 * with its padding, ending where the run does (the next character is none
 * of the alphabet's). Replaced only when the run decodes to `user:password`
 * (see {@link isBasicCredential}), so prose ("Basic authentication
 * failed") is left alone.
 */
const BASIC = /\b(basic\s+)([\w+/-]{8,}={0,2})(?![\w+/=-])/gi;

/** Whether a base64 (or base64url) run decodes to a `user:password` pair, as a Basic credential does. */
function isBasicCredential(run: string): boolean {
  try {
    return atob(run.replaceAll("-", "+").replaceAll("_", "/")).includes(":");
  } catch {
    return false;
  }
}

/** {@link BASIC}'s replacement: the scheme kept, a real credential replaced. */
function basicRewrite(match: string, scheme: string, run: string): string {
  return isBasicCredential(run)
    ? `${scheme}${DEFAULT_REDACT_REPLACEMENT}`
    : match;
}

/**
 * Parameters that carry a signature by themselves, value replaced, case
 * insensitive: an S3 presigned URL's `X-Amz-Signature=` and a Google Cloud
 * Storage signed URL's `X-Goog-Signature=` (as whole keys), and an Azure SAS
 * token's `sig=` only inside a query, after `?` or `&` (so `xsig=`,
 * `signal=` and prose such as "the sig=verified flag" are left alone).
 */
const SIGNATURES =
  /((?<![\w.\-])x-(?:amz|goog)-signature=|[?&]sig=)[^&\s"'#;]+/gi;

/** The `X-Amz-Signature` header, `x-amz-signature: <value>`, value replaced. */
const SIGNATURE_HEADER = /(\bx-amz-signature:[ \t]*)[^\s,;"']+/gi;

/** A text with each percent-escape's hex digits in lower case (`%2F` → `%2f`). */
function lowerPercent(text: string): string {
  return text.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
}

/** A text escaped as the usual `escapeRegExp` helper writes it. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A declared secret's forms, each matched by value:
 *
 * - as it is;
 * - URL-encoded, as `encodeURIComponent` writes it and as a form
 *   (`URLSearchParams`, `+` for a space) writes it, each also with
 *   lower-case percent-escapes;
 * - escaped for a regular expression, as an `escapeRegExp` helper writes it,
 *   as a `RegExp`'s `source` shows that (`/` as `\/`), and as
 *   `RegExp.escape` writes it.
 *
 * An encoding that throws (a lone surrogate, for `encodeURIComponent`) is
 * skipped; the other forms still count.
 */
export function encodedForms(
  /** The declared secret. */
  secret: string,
): string[] {
  const forms = [secret];
  const attempt = (make: () => string): void => {
    try {
      const form = make();
      forms.push(form, lowerPercent(form));
    } catch {
      // That form cannot exist for this secret: nothing to match.
    }
  };
  attempt(() => encodeURIComponent(secret));
  attempt(() => new URLSearchParams({ s: secret }).toString().slice(2));
  attempt(() => escapeRegExp(secret));
  attempt(() => escapeRegExp(secret).replaceAll("/", "\\/"));
  const escape = (RegExp as { escape?: (text: string) => string }).escape;
  if (typeof escape === "function") {
    attempt(() => escape(secret));
  }
  return [...new Set(forms)];
}

/**
 * A text redactor: the declared secrets by value (every form of
 * {@link encodedForms}), then the default patterns, a URL's userinfo, a
 * bare `Basic` credential and a signature parameter or header.
 */
export function textRedactor(
  /** The declared secret values; short or non-string ones are ignored. */
  secrets: readonly unknown[],
): (text: string) => string {
  const values = [
    ...new Set(
      secrets
        .filter(
          (secret): secret is string =>
            typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH,
        )
        .flatMap(encodedForms),
    ),
    // Longest first, so a secret containing another is replaced whole.
  ].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const value of values) {
      out = out.replaceAll(value, DEFAULT_REDACT_REPLACEMENT);
    }
    const patterned = PATTERNS(
      out.replace(USERINFO, `://${DEFAULT_REDACT_REPLACEMENT}@`),
    );
    const basic = patterned.replace(BASIC, basicRewrite);
    return basic
      .replace(SIGNATURES, `$1${DEFAULT_REDACT_REPLACEMENT}`)
      .replace(SIGNATURE_HEADER, `$1${DEFAULT_REDACT_REPLACEMENT}`);
  };
}

/**
 * The redactor's credential patterns alone, with no declared secrets:
 * `Bearer …`, a `word:value` or `word=value` under a sensitive word, a URL's
 * password or userinfo, a JWT, a bare `Basic` credential, a signature. A
 * value they would change holds a credential shape.
 */
const CREDENTIAL_SHAPES = textRedactor([]);

/** Why a `describe()` fact is not served, by {@link factProblem}. */
export type FactProblem =
  | "credential-key"
  | "url-userinfo"
  | "credential-shape";

/**
 * Internal: the one rule for a `describe()` fact, shared by the status
 * route's filter (`isServableFact`, which adds its `host` rule) and the
 * conformance kit's `summon.describe.facts`, so the kit warns about exactly
 * what the route drops: a key naming a credential (`isCredentialKey`), a
 * value holding a URL with userinfo, or a value the pattern redactor would
 * change (`session-workers:prod`, `max_tokens=4096` and a `Bearer …` among
 * them). `undefined` when none applies. Fails safe, by design.
 */
export function factProblem(
  /** The fact's key. */
  key: string,
  /** The fact's value. */
  value: string,
): FactProblem | undefined {
  if (isCredentialKey(key)) {
    return "credential-key";
  }
  if (URL_USERINFO.test(value)) {
    return "url-userinfo";
  }
  return CREDENTIAL_SHAPES(value) === value ? undefined : "credential-shape";
}

/**
 * The longest detail stored or served — a marker's `last.detail`, a `summon`
 * event's, a preflight's: a longer one (a provider passing a response body
 * as its `platformCode`) is cut to this, ending in `…`.
 */
export const DETAIL_MAX = 128;

/** A detail from a provider, redacted by {@link textRedactor} and cut to {@link DETAIL_MAX}. */
export function redactDetail(
  /** The detail. */
  detail: string,
  /** The provider's declared secret values. */
  secrets: readonly unknown[],
): string {
  const redacted = textRedactor(secrets)(detail);
  return redacted.length > DETAIL_MAX
    ? `${redacted.slice(0, DETAIL_MAX - 1)}…`
    : redacted;
}

/** Whether a value is a plain object literal, walked as it is. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Binary data (a `Buffer`, any typed array, an `ArrayBuffer`, a
 * `DataView`, a `Blob` or `File`), as its placeholder: `[Binary <n> bytes]`, never the bytes,
 * which a sink could decode to text. `undefined` for anything else.
 */
function binaryPlaceholder(value: object): string | undefined {
  if (
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof SharedArrayBuffer
  ) {
    return `[Binary ${value.byteLength} bytes]`;
  }
  if (value instanceof Blob) {
    return `[Binary ${value.size} bytes]`;
  }
  return undefined;
}

/** What a value that cannot be read (a throwing getter, a revoked proxy) is logged as. */
const UNREADABLE = "[Unreadable]";

/** What a reference back to an object already being walked is logged as. */
const CIRCULAR = "[Circular]";

/** What a function is logged as: never passed through, since a sink could call it (or its `toJSON`). */
const FUNCTION = "[Function]";

/** What {@link viaToJSON} answers for an object without a `toJSON` method. */
const NO_TO_JSON: unique symbol = Symbol("no toJSON");

/** One property of `value`, read without letting a throwing getter escape. */
function read(value: object, key: PropertyKey): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return UNREADABLE;
  }
}

/**
 * A value the walk would not read, in a shape it does: a `URL` as its text,
 * `Headers`, `URLSearchParams` and a `Map` as their entries (keys as text), a
 * `Set` as its items, any other class instance as its own enumerable fields
 * (each read on its own, so one throwing getter costs only that field).
 */
function readable(value: object): unknown {
  if (value instanceof URL) {
    return value.href;
  }
  if (
    value instanceof Headers ||
    value instanceof URLSearchParams ||
    value instanceof Map
  ) {
    const entries: [unknown, unknown][] = [];
    (value as Map<unknown, unknown>).forEach((item, key) => {
      entries.push([key, item]);
    });
    return Object.fromEntries(
      entries.map(([key, item]) => [String(key), item]),
    );
  }
  if (value instanceof Set) {
    return [...value];
  }
  return Object.fromEntries(
    Object.keys(value).map((key) => [key, read(value, key)]),
  );
}

/**
 * A field of `owner`: replaced whole under a credential name (without
 * reading it), else read — a throwing getter reads as {@link UNREADABLE} —
 * and walked.
 */
function redactField(
  owner: object,
  key: string | symbol,
  redact: (text: string) => string,
  seen: WeakMap<object, unknown>,
  depth: number,
): unknown {
  if (typeof key === "string" && isCredentialKey(key)) {
    const value = read(owner, key);
    return value === undefined || value === null
      ? value
      : DEFAULT_REDACT_REPLACEMENT;
  }
  return redactValue(read(owner, key), redact, seen, depth);
}

/**
 * A copy of `value` with every string redacted: strings, arrays, plain
 * objects and errors (message, stack, cause and own fields) are walked,
 * other containers converted first (see {@link readable}), anything deeper
 * than {@link MAX_DEPTH} replaced whole, and a cycle cut at
 * {@link CIRCULAR}. It never throws: what cannot be read is
 * {@link UNREADABLE}.
 */
function redactValue(
  value: unknown,
  redact: (text: string) => string,
  seen: WeakMap<object, unknown>,
  depth: number,
): unknown {
  if (typeof value === "string") {
    return redact(value);
  }
  if (typeof value === "function") {
    return FUNCTION;
  }
  if (typeof value === "symbol") {
    return redact(value.description ?? "");
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  try {
    return redactObject(value, redact, seen, depth);
  } catch {
    // A revoked proxy, an exotic object whose traps throw: nothing of it
    // is logged, and the log call still succeeds.
    return UNREADABLE;
  }
}

/** {@link redactValue} for an object; may throw on an exotic one. */
function redactObject(
  value: object,
  redact: (text: string) => string,
  seen: WeakMap<object, unknown>,
  depth: number,
): unknown {
  const binary = binaryPlaceholder(value);
  if (binary !== undefined) {
    return binary;
  }
  if (value instanceof RegExp) {
    return redact(String(value));
  }
  const boxed = stringObjectText(value);
  if (boxed !== undefined) {
    return redact(boxed);
  }
  if (isPristineDate(value)) {
    // Its text is a time, and a sink serialises it to one.
    return value;
  }
  if (depth > MAX_DEPTH) {
    // Fails closed: what the walk cannot read is not passed through.
    return DEFAULT_REDACT_REPLACEMENT;
  }
  if (seen.has(value)) {
    return seen.get(value);
  }
  // While an object is being walked, a reference back to it is a cycle, cut
  // at CIRCULAR, so the copy stays serialisable; once walked, a later
  // (acyclic) reference shares its copy.
  if (!(value instanceof Error) && !(value instanceof URL)) {
    // A Date that is not pristine (a subclass's own toJSON) goes here too.
    const serialised = viaToJSON(value, redact, seen, depth);
    if (serialised !== NO_TO_JSON) {
      return serialised;
    }
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, CIRCULAR);
    for (let index = 0; index < value.length; index++) {
      copy.push(redactValue(read(value, index), redact, seen, depth + 1));
    }
    seen.set(value, copy);
    return copy;
  }
  if (value instanceof Error) {
    seen.set(value, CIRCULAR);
    const copy = redactError(value, redact, seen, depth);
    seen.set(value, copy);
    return copy;
  }
  if (!isPlainObject(value)) {
    // Registered before converting: a reference back to it, however many
    // there are, is cut once rather than walked again to the depth limit.
    seen.set(value, CIRCULAR);
    const copy = redactValue(readable(value), redact, seen, depth);
    seen.set(value, copy);
    return copy;
  }
  return redactFields(value as LogFields, redact, seen, depth);
}

/** A `String` object's text (brand-checked, so a look-alike is not one), or `undefined`. */
function stringObjectText(value: object): string | undefined {
  try {
    return String.prototype.valueOf.call(value);
  } catch {
    return undefined;
  }
}

/** Whether a value is a `Date` serialised the built-in way, so passed as it is. */
function isPristineDate(value: object): boolean {
  if (!(value instanceof Date)) {
    return false;
  }
  try {
    return (
      (value as { toJSON?: unknown }).toJSON === Date.prototype.toJSON &&
      (value as { toISOString?: unknown }).toISOString ===
        Date.prototype.toISOString
    );
  } catch {
    return false;
  }
}

/** The fields every error copy carries as its own, whatever its prototype says. */
const ERROR_FIELDS = ["name", "message", "stack", "code", "cause"] as const;

/**
 * A redacted copy of an error. It keeps the error's prototype, so its class
 * survives for the sink, and carries as **own** properties its own fields
 * (read, so a getter never runs again; string keys redacted too) and
 * `name`, `message`, `stack`, `code` and `cause`, each from a guarded read
 * of the original: those shadow the prototype's getters, which for a host
 * class (a `DOMException`) are brand-checked and throw on a copy. An own
 * `toJSON` returns the redacted plain view, so a `toJSON` on the prototype
 * never runs. If the copy still cannot be read (`String(copy)`, its name or
 * message, `JSON.stringify`), it is rebuilt as a plain `Error` with the
 * same fields.
 */
function redactError(
  value: Error,
  redact: (text: string) => string,
  seen: WeakMap<object, unknown>,
  depth: number,
): Error {
  const fields = new Map<
    string | symbol,
    { value: unknown; enumerable: boolean }
  >();
  for (const key of Reflect.ownKeys(value)) {
    if (key === "toJSON") {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    fields.set(typeof key === "string" ? redact(key) : key, {
      value: redactField(value, key, redact, seen, depth + 1),
      enumerable: descriptor.enumerable ?? false,
    });
  }
  for (const key of ERROR_FIELDS) {
    if (fields.has(key)) {
      continue;
    }
    let raw: unknown;
    try {
      raw = Reflect.get(value, key);
    } catch {
      raw =
        key === "name" ? "Error" : key === "message" ? UNREADABLE : undefined;
    }
    if (raw === undefined && key !== "name" && key !== "message") {
      continue;
    }
    fields.set(key, {
      value:
        key === "name" && typeof raw !== "string"
          ? "Error"
          : key === "message" && raw === undefined
            ? ""
            : redactField({ [key]: raw }, key, redact, seen, depth + 1),
      enumerable: false,
    });
  }
  const view = (): Record<string, unknown> => {
    const plain: Record<string, unknown> = {};
    for (const key of ["name", "message", "code", "cause"] as const) {
      if (fields.has(key)) {
        plain[key] = fields.get(key)!.value;
      }
    }
    for (const [key, field] of fields) {
      if (typeof key === "string" && field.enumerable) {
        plain[key] = field.value;
      }
    }
    return plain;
  };
  const build = (prototype: object): Error => {
    const copy = Object.create(prototype) as Error;
    for (const [key, field] of fields) {
      Object.defineProperty(copy, key, {
        value: field.value,
        enumerable: field.enumerable,
        writable: true,
        configurable: true,
      });
    }
    Object.defineProperty(copy, "toJSON", {
      value: view,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    return copy;
  };
  const copy = build(Object.getPrototypeOf(value) as object);
  try {
    // A host class may reach a brand-checked getter some other way.
    void `${String(copy)}${copy.name}${copy.message}${JSON.stringify(copy)}`;
    return copy;
  } catch {
    return build(Error.prototype);
  }
}

/**
 * An object with a `toJSON` method (a `Date` and a `URL` excepted, handled
 * on their own), as what it returns, redacted — what `JSON.stringify` would
 * write, so a sink serialising the copy cannot call it and bring a secret
 * back. Reading `toJSON` and calling it is provider code, so guarded like a
 * getter: a throw is {@link UNREADABLE}. The result is walked one level
 * deeper, with the object marked as being walked, so a `toJSON` returning
 * its own object is cut at {@link CIRCULAR} and a chain of them ends at the
 * depth limit. {@link NO_TO_JSON} when there is no such method.
 */
function viaToJSON(
  value: object,
  redact: (text: string) => string,
  seen: WeakMap<object, unknown>,
  depth: number,
): unknown {
  let result: unknown;
  try {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON !== "function") {
      return NO_TO_JSON;
    }
    result = (toJSON as (key: string) => unknown).call(value, "");
  } catch {
    return UNREADABLE;
  }
  seen.set(value, CIRCULAR);
  const copy = redactValue(result, redact, seen, depth + 1);
  seen.set(value, copy);
  return copy;
}

/** A copy of a field record with every value redacted, and credential names' values replaced whole. */
function redactFields(
  fields: LogFields,
  redact: (text: string) => string,
  seen: WeakMap<object, unknown> = new WeakMap(),
  depth = 0,
): LogFields {
  const copy: LogFields = {};
  seen.set(fields, CIRCULAR);
  let keys: string[];
  try {
    keys = Object.keys(fields);
  } catch {
    return { value: UNREADABLE };
  }
  for (const key of keys) {
    // A key is text too: a secret used as one is redacted like a value.
    copy[redact(key)] = redactField(fields, key, redact, seen, depth + 1);
  }
  seen.set(fields, copy);
  return copy;
}

/** A message, redacted: a string's text, or an error's copy. */
function redactMessage(
  message: string | Error,
  redact: (text: string) => string,
): string | Error {
  if (typeof message === "string") {
    return redact(message);
  }
  const copy = redactValue(message, redact, new WeakMap(), 0);
  return copy instanceof Error ? copy : UNREADABLE;
}

/**
 * Internal: a thrown value with `secrets` redacted from it, for rethrowing
 * where a provider's own code threw (`provider(config)`'s synchronous
 * validation and facet build). An error becomes a copy of the same class
 * with its message, stack, cause and own fields redacted; a string is
 * redacted; anything else is walked like a log field. The original is
 * untouched.
 */
export function redactThrown(
  /** What was thrown. */
  thrown: unknown,
  /** The declared secret values to redact by value. */
  secrets: readonly unknown[],
): unknown {
  return redactValue(thrown, textRedactor(secrets), new WeakMap(), 0);
}

/** The levels a `Logger` logs at, `log` included. */
const LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "log",
] as const;

/**
 * `inner`, with every message, field and child binding redacted by
 * {@link textRedactor}. Level checks and the threshold are `inner`'s own.
 */
export function redactingLogger(
  /** The logger to write to. */
  inner: Logger,
  /** The declared secret values to redact by value. */
  secrets: readonly unknown[],
): Logger {
  return wrap(inner, textRedactor(secrets));
}

/** The wrapper itself, reusing one compiled redactor across children. */
function wrap(inner: Logger, redact: (text: string) => string): Logger {
  const logger = {
    get level() {
      return inner.level;
    },
    get name() {
      return inner.name;
    },
    get bindings() {
      return inner.bindings;
    },
    isLevelEnabled: (level) => inner.isLevelEnabled(level),
    child: (bindings, options) =>
      wrap(inner.child(redactFields(bindings, redact), options), redact),
  } as Logger;
  for (const level of LEVELS) {
    (logger as { [K in (typeof LEVELS)[number]]: Logger[K] })[level] = (
      message,
      fields,
    ) => {
      inner[level](
        redactMessage(message, redact),
        fields === undefined ? undefined : redactFields(fields, redact),
      );
    };
  }
  return logger;
}
