/**
 * The errors `@kingsleyweb/bun-cache` throws.
 *
 * The default failure policy never throws for a driver problem: a failing
 * read is a miss, a failing write resolves `false` (plan §3.14). These errors
 * surface under `strict: true`, for misuse (`UnsupportedOperationError`), and
 * for the loader timeouts that are the caller's to handle
 * (`LoaderTimeoutError`).
 */

/** A driver operation failed or timed out. */
export class CacheDriverError extends Error {
  /** The driver's `name` (`"memory"`, `"s3"`, …). */
  readonly driver: string;
  /** The operation that failed (`"get"`, `"set"`, `"increment"`, …). */
  readonly op: string;

  constructor(init: {
    /** The driver's `name`. */
    driver: string;
    /** The operation that failed. */
    op: string;
    /** What the driver threw or rejected with. */
    cause: unknown;
  }) {
    super(
      `cache driver "${init.driver}" failed on ${init.op}: ${
        init.cause instanceof Error ? init.cause.message : String(init.cause)
      }`,
      { cause: init.cause },
    );
    this.name = "CacheDriverError";
    this.driver = init.driver;
    this.op = init.op;
  }
}

/**
 * The driver's circuit is open (too many consecutive failures) and the
 * operation was bypassed. Thrown only under `strict: true`; otherwise a read
 * degrades to a miss and a write resolves `false`.
 */
export class CircuitOpenError extends Error {
  /** The driver's `name`. */
  readonly driver: string;
  /** When the circuit allows the next probe, epoch ms. */
  readonly retryAt: number;

  constructor(
    /** The driver's `name`. */
    driver: string,
    /** When the circuit allows the next probe, epoch ms. */
    retryAt: number,
  ) {
    super(
      `cache driver "${driver}" is bypassed until ${new Date(retryAt).toISOString()} (circuit open)`,
    );
    this.name = "CircuitOpenError";
    this.driver = driver;
    this.retryAt = retryAt;
  }
}

/**
 * Waiting on a loader took longer than `hardTimeout`, or waiting on a
 * cross-process lock longer than its `wait.timeout` with
 * `onLockTimeout: "throw"` (plan §3.4, §3.5).
 */
export class LoaderTimeoutError extends Error {
  /** The cache key being loaded. */
  readonly key: string;
  /** The timeout that elapsed, in ms. */
  readonly timeoutMs: number;

  constructor(
    /** The cache key being loaded. */
    key: string,
    /** The timeout that elapsed, in ms. */
    timeoutMs: number,
    /** What was being waited on. */
    what = "the loader",
  ) {
    super(`Timed out after ${timeoutMs} ms waiting for ${what} on "${key}"`);
    this.name = "LoaderTimeoutError";
    this.key = key;
    this.timeoutMs = timeoutMs;
  }
}

/** The driver cannot do what was asked (an `increment` on S3, a lock on a driver without one forced per call). */
export class UnsupportedOperationError extends Error {
  /** The driver's `name`. */
  readonly driver: string;
  /** The operation that was refused. */
  readonly op: string;

  constructor(
    /** The driver's `name`. */
    driver: string,
    /** The operation that was refused. */
    op: string,
    /** Why it is unsupported. */
    reason: string,
  ) {
    super(`cache driver "${driver}" does not support ${op}: ${reason}`);
    this.name = "UnsupportedOperationError";
    this.driver = driver;
    this.op = op;
  }
}

/**
 * An entry encoded above `maxEntryBytes`, as stored or before compression
 * (a read decompresses no further). Not thrown by default — an
 * oversized `set` resolves `false` and emits `oversize` (plan §3.9); thrown
 * only under `strict: true`.
 */
export class EntryTooLargeError extends Error {
  /** The cache key. */
  readonly key: string;
  /** The encoded size, in bytes: the stored entry's, or its payload's before compression when that is larger. */
  readonly bytes: number;
  /** The limit that was exceeded, in bytes. */
  readonly limit: number;

  constructor(
    /** The cache key. */
    key: string,
    /** The encoded size, in bytes: the stored entry's, or its payload's before compression when that is larger. */
    bytes: number,
    /** The limit that was exceeded, in bytes. */
    limit: number,
  ) {
    super(
      `Cache entry "${key}" encodes to ${bytes} bytes, over the ${limit}-byte limit`,
    );
    this.name = "EntryTooLargeError";
    this.key = key;
    this.bytes = bytes;
    this.limit = limit;
  }
}
