/**
 * The kit's `resolveShell` (`lib/kit/options.ts`, embedding.md §2): what
 * every UI's server function checks its `shell` option with, throwing the
 * UI's own error.
 */
import type { ConfigFail } from "../../../lib/kit/options";
import { describe, expect, it } from "bun:test";
import { resolveShell } from "../../../lib/kit/options";

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

describe("resolveShell", () => {
  it('is "full" when unset, and keeps each valid value', () => {
    expect(resolveShell(undefined, fail)).toBe("full");
    for (const shell of ["full", "tabs", "none"] as const) {
      expect(resolveShell(shell, fail)).toBe(shell);
    }
  });

  it("throws the UI's error, with the value, for anything else", () => {
    for (const value of [null, "", "Tabs", "header", 0, {}]) {
      let thrown: unknown;
      try {
        resolveShell(value, fail);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TestUiError);
      expect((thrown as TestUiError).message).toBe(
        'shell must be "full", "tabs" or "none"',
      );
      expect((thrown as TestUiError).context).toEqual({ value });
    }
  });
});
