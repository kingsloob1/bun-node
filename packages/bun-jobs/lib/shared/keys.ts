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
 * The package's own pseudo-queue: the queue ref, `{ ns, queue: "__bunjobs" }`,
 * that state belonging to no one queue is stored under — a summon group's
 * shared budget, for one (`__win:summon-group:<name>`). Queue state is the
 * only compare-and-set the driver contract has, so namespace-wide state that
 * needs one lives on a queue; this one is never ensured, never holds a job,
 * and `listQueues` never names it.
 *
 * **Reserved:** {@link assertSegment} refuses it, so no queue, worker or
 * runner can be built on it, and nothing a caller names can collide with it.
 */
export const RESERVED_QUEUE = "__bunjobs";

/**
 * Validates one key segment (a queue name, a runner id) and returns it.
 * Throws {@link ConfigError} with the offending value when it is unusable,
 * and for {@link RESERVED_QUEUE}, the package's own pseudo-queue.
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

  if (value === RESERVED_QUEUE) {
    throw new ConfigError(
      `${what} may not be "${RESERVED_QUEUE}": bun-jobs reserves that name for its own state`,
      { value, reserved: RESERVED_QUEUE },
    );
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
