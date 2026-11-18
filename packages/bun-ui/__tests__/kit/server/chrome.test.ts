/**
 * The kit's `resolveChrome` (`lib/kit/options.ts`, embedding.md §2): what
 * every UI's server function checks its `chrome` option with, throwing the
 * UI's own error.
 */
import type { ConfigFail } from "../../../lib/kit/options";
import { describe, expect, it } from "bun:test";
import { resolveChrome } from "../../../lib/kit/options";

/** A UI's own error class, as a third UI would pass it. */
class TestUiError extends Error {
  constructor(
    message: string,
    readonly context: Record<string, unknown>,
  ) {
    super(message);
  }
}

const fail: ConfigFail = (message, context) =>
  new TestUiError(message, context);

describe("resolveChrome", () => {
  it('is "full" when unset, and keeps each valid value', () => {
    expect(resolveChrome(undefined, fail)).toBe("full");
    for (const chrome of ["full", "tabs", "none"] as const) {
      expect(resolveChrome(chrome, fail)).toBe(chrome);
    }
  });

  it("throws the UI's error, with the value, for anything else", () => {
    for (const value of [null, "", "Tabs", "header", 0, {}]) {
      let thrown: unknown;
      try {
        resolveChrome(value, fail);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TestUiError);
      expect((thrown as TestUiError).message).toBe(
        'chrome must be "full", "tabs" or "none"',
      );
      expect((thrown as TestUiError).context).toEqual({ value });
    }
  });
});
