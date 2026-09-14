import { ConfigError } from "./errors";

/**
 * Namespace and key-segment validation, plus the key shapes every driver
 * derives from them.
 *
 * A namespace is not decoration: it is what keeps two services sharing one
 * Redis (or one database, or one directory) from colliding when they happen
 * to use the same runner id or queue name. It is therefore **required**
 * everywhere and validated up front, so an unusable value fails at
 * construction rather than corrupting a key at runtime.
 */

/**
 * Characters allowed in a namespace, runner id or queue name. Deliberately
 * narrow: safe in a Redis key, a file path, a SQL value and a URL, with no
 * escaping anywhere.
 *
 * **Key layouts depend on it.** Every backend joins segments with separators
 * this pattern excludes — `:` in Redis, MongoDB and SQL keys, `/` in paths —
 * so a key like `q:<queue>:state:<name>` can only be read one way. Allow a
 * separator here and `x:state:z` becomes indistinguishable from another
 * queue's state. `__tests__/keys.test.ts` pins this.
 */
const SEGMENT_PATTERN = /^[\w.-]+$/;

/** Longest a single segment may be. */
const MAX_SEGMENT_LENGTH = 200;

/**
 * Validates one key segment (a queue name, a runner id) and returns it.
 * Throws {@link ConfigError} with the offending value when it is unusable.
 */
export function assertSegment(value: string, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`${what} is required`, { value });
  }

  if (value.length > MAX_SEGMENT_LENGTH) {
    throw new ConfigError(
      `${what} is longer than ${MAX_SEGMENT_LENGTH} characters`,
      { value },
    );
  }

  if (!SEGMENT_PATTERN.test(value)) {
    throw new ConfigError(
      `${what} may only contain letters, digits, "_", "." and "-"`,
      { value },
    );
  }

  if (value === "." || value === "..") {
    throw new ConfigError(`${what} may not be "." or ".."`, { value });
  }

  return value;
}

/**
 * Validates a namespace and returns it. Every runner, queue and worker takes
 * one; there is no default, because a shared default is exactly the collision
 * the namespace exists to prevent.
 */
export function assertNamespace(namespace: string): string {
  return assertSegment(namespace, "namespace");
}

/** Key identifying a runner's state within a namespace: `r:<id>`. */
export function runnerKey(id: string): string {
  return `r:${id}`;
}

/** Key identifying a queue within a namespace: `q:<name>`. */
export function queueKey(name: string): string {
  return `q:${name}`;
}
