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
 *    ordinary words with it) is replaced wherever it appears;
 * 2. **patterns**: the runner's redactor (`createRedactor` with its
 *    defaults: `key=value` pairs under a sensitive key, `Bearer …`, a URL's
 *    password, a JWT). A field whose *name* is a credential's, by the rule
 *    the status route's fact filter uses (`isCredentialKey`: a credential
 *    word as one of the name's words, or ending it), has its value replaced
 *    whole: `apiKey`, `authToken` and `sessiontoken` are, `author` is not.
 *
 * A URL's userinfo is replaced whole, whatever it holds (the status route's
 * rule): `https://ghp_…@github.com` and a Sentry DSN's key included. A value
 * the walk would not otherwise read is converted first — a `URL` to its
 * text, `Headers`, `URLSearchParams` and a `Map` to their entries, a `Set`
 * to its items, another class instance to its own fields — so both rules
 * apply to it; an error's own fields follow the name rule too; and anything
 * deeper than the walk goes is replaced, never passed through.
 *
 * It is text-level, so it misses what the runner's redactor misses (a secret
 * in prose, token shapes other than a JWT); declaring secrets is how a
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

/** A text redactor: the declared secrets by value, then the default patterns. */
export function textRedactor(
  /** The declared secret values; short or non-string ones are ignored. */
  secrets: readonly unknown[],
): (text: string) => string {
  const values = [
    ...new Set(
      secrets.filter(
        (secret): secret is string =>
          typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH,
      ),
    ),
    // Longest first, so a secret containing another is replaced whole.
  ].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const value of values) {
      out = out.replaceAll(value, DEFAULT_REDACT_REPLACEMENT);
    }
    return PATTERNS(out.replace(USERINFO, `://${DEFAULT_REDACT_REPLACEMENT}@`));
  };
}

/** Whether a value is a plain object literal, walked as it is. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Values whose contents cannot hold a readable secret field, passed as they are. */
function isOpaque(value: object): boolean {
  return (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  );
}

/** What a value that cannot be read (a throwing getter, a revoked proxy) is logged as. */
const UNREADABLE = "[Unreadable]";

/** What a reference back to an object already being walked is logged as. */
const CIRCULAR = "[Circular]";

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
  if (isOpaque(value)) {
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
    // Same prototype, so the error's class and name survive for the sink.
    const copy = Object.create(Object.getPrototypeOf(value) as object) as Error;
    seen.set(value, CIRCULAR);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      // A getter is read and replaced by its (redacted) value, so the sink
      // never calls it and gets the raw text.
      Object.defineProperty(copy, key, {
        value: redactField(value, key, redact, seen, depth + 1),
        enumerable: descriptor.enumerable,
        writable: true,
        configurable: true,
      });
    }
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
    copy[key] = redactField(fields, key, redact, seen, depth + 1);
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
