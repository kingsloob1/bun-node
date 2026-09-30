import type { LogFields, Logger } from "../shared/logger";
import { createRedactor, DEFAULT_REDACT_REPLACEMENT } from "../runner/redact";
import { isCredentialKey } from "../shared/credentialKeys";

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
 * It is text-level, so it misses what the runner's redactor misses (a secret
 * in prose, token shapes other than a JWT); declaring secrets is how a
 * provider closes that gap for its own values.
 */

/** The shortest declared secret redacted by value. */
export const MIN_SECRET_LENGTH = 8;

/** How deep a field value is walked before it is left as it is. */
const MAX_DEPTH = 8;

/** The runner's default pattern redactor, compiled once. */
const PATTERNS = createRedactor(true)!;

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
    return PATTERNS(out);
  };
}

/** Whether a value is a plain object literal (walked), rather than a class instance (left alone). */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * A copy of `value` with every string redacted: strings, arrays, plain
 * objects and errors (message, stack, cause and own fields) are walked;
 * anything else is returned as it is.
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
  if (typeof value !== "object" || value === null || depth > MAX_DEPTH) {
    return value;
  }
  if (seen.has(value)) {
    return seen.get(value);
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) {
      copy.push(redactValue(item, redact, seen, depth + 1));
    }
    return copy;
  }
  if (value instanceof Error) {
    // Same prototype, so the error's class and name survive for the sink.
    const copy = Object.create(Object.getPrototypeOf(value) as object) as Error;
    seen.set(value, copy);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if ("value" in descriptor) {
        descriptor.value = redactValue(
          descriptor.value,
          redact,
          seen,
          depth + 1,
        );
      }
      Object.defineProperty(copy, key, descriptor);
    }
    return copy;
  }
  if (!isPlainObject(value)) {
    return value;
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
  seen.set(fields, copy);
  for (const [key, value] of Object.entries(fields)) {
    copy[key] =
      isCredentialKey(key) && value !== undefined && value !== null
        ? DEFAULT_REDACT_REPLACEMENT
        : redactValue(value, redact, seen, depth + 1);
  }
  return copy;
}

/** A message, redacted: a string's text, or an error's copy. */
function redactMessage(
  message: string | Error,
  redact: (text: string) => string,
): string | Error {
  return typeof message === "string"
    ? redact(message)
    : (redactValue(message, redact, new WeakMap(), 0) as Error);
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
