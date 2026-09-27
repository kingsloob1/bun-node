/**
 * Absence assertions that cannot pass by accident.
 *
 * Under `bun:test` (seen on 1.4.3-canary.1), a matcher that must fail on a
 * value Bun cannot print does not fail. In a full-app render,
 * `expect(button).toBeNull()` and `expect(button).toBe(null)` both passed on a
 * real, rendered `HTMLButtonElement`, whose graph reaches the whole app:
 * `Bun.inspect(button)` threw `RangeError: Out of memory` building the
 * failure message, and the failure was lost with it. `expect(button ===
 * null).toBe(true)` failed as it should on the same element.
 *
 * So an assertion that something is **not** there, which is the one that
 * must fail on an element, compares first and throws an error of its own,
 * describing what it found in a line that never needs the element printed.
 * Assertions that something **is** there (`.not.toBeNull()`) are unaffected:
 * when they fail, the value is `null`, which prints.
 *
 * This is Bun's bug, https://github.com/oven-sh/bun/issues/37310: past the
 * longest string the engine allows, the failure message for a value in a
 * large DOM tree cannot be built, and the assertion returns without
 * throwing. The fix is https://github.com/oven-sh/bun/pull/37311. Once a Bun
 * with it is the floor, these helpers can become plain matchers again, and
 * the guard in `assert.test.ts` can go with them.
 */

/** A short, safe description of a value an absence check found. */
function describe(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const element = value as {
      tagName?: unknown;
      getAttribute?: (name: string) => string | null;
      textContent?: unknown;
      length?: unknown;
    };
    if (typeof element.tagName === "string") {
      const testId = element.getAttribute?.("data-testid");
      const text =
        typeof element.textContent === "string"
          ? element.textContent.trim().slice(0, 80)
          : "";
      return `<${element.tagName.toLowerCase()}${
        testId ? ` data-testid="${testId}"` : ""
      }> "${text}"`;
    }
    if (typeof element.length === "number") {
      return `a collection of ${element.length}`;
    }
    return `an object (${Object.prototype.toString.call(value)})`;
  }
  return typeof value === "string"
    ? JSON.stringify(value.slice(0, 80))
    : String(value);
}

/**
 * Asserts `value` is `null`: an element, a row or anything else a query
 * returns when nothing matches. Use it in place of `expect(value).toBeNull()`.
 *
 * @param value What the query returned.
 * @param what What should be absent, for the failure message.
 */
export function expectAbsent(value: unknown, what = "the value"): void {
  if (value !== null) {
    throw new Error(`Expected ${what} to be null, found ${describe(value)}`);
  }
}

/**
 * Asserts `value` is `undefined`: a `find()` that matched nothing, a field
 * left out. Use it in place of `expect(value).toBeUndefined()`.
 *
 * @param value What was read.
 * @param what What should be undefined, for the failure message.
 */
export function expectUndefined(value: unknown, what = "the value"): void {
  if (value !== undefined) {
    throw new Error(
      `Expected ${what} to be undefined, found ${describe(value)}`,
    );
  }
}

/**
 * Asserts `list` is empty: a query for all matches that should match none.
 * Use it in place of `expect(list).toHaveLength(0)`.
 *
 * @param list What the query returned.
 * @param what What should be empty, for the failure message.
 */
export function expectNone(list: ArrayLike<unknown>, what = "the list"): void {
  if (list.length !== 0) {
    const first = list[0];
    throw new Error(
      `Expected ${what} to be empty, found ${list.length}, the first ${describe(first)}`,
    );
  }
}
