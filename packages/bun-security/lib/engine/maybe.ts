/**
 * Values that may or may not be promises (plan §4.3: no `await` on the hot
 * path while every rule in play is local). A synchronous store keeps a
 * request synchronous end to end; an asynchronous one makes it a promise.
 */

/** A value, or a promise of it. */
export type MaybePromise<T> = T | Promise<T>;

/** Whether `value` is a promise (or any thenable). */
export function isThenable<T>(
  value: T | PromiseLike<T>,
): value is PromiseLike<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** `fn(value)`, now or once `value` settles. */
export function then<T, R>(
  value: MaybePromise<T>,
  fn: (resolved: T) => MaybePromise<R>,
): MaybePromise<R> {
  return isThenable(value) ? Promise.resolve(value).then(fn) : fn(value);
}

/** Every value, now when none is a promise. */
export function all<T>(values: readonly MaybePromise<T>[]): MaybePromise<T[]> {
  for (const value of values) {
    if (isThenable(value)) return Promise.all(values);
  }
  return values as T[];
}
