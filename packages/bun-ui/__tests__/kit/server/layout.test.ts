/**
 * The `layout` option's check (`resolveLayout`, #785) and the shape check the
 * apps run on the config they read back (`isUiLayout`). Every refusal is the
 * caller's error, as for the kit's other options.
 */
import type { ConfigFail } from "../../../lib/kit/options";
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_UI_LAYOUT,
  isUiLayout,
  MIN_UI_MAX_WIDTH,
} from "../../../lib/kit/browser/shared";
import { resolveLayout } from "../../../lib/kit/options";

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

/** What `run` threw, or `undefined`. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("resolveLayout", () => {
  it("defaults to centred content at 1400px, unset or empty", () => {
    expect(DEFAULT_UI_LAYOUT).toEqual({
      align: "center",
      scope: "content",
      maxWidth: 1400,
    });
    expect(resolveLayout(undefined, fail)).toEqual(DEFAULT_UI_LAYOUT);
    expect(resolveLayout({}, fail)).toEqual(DEFAULT_UI_LAYOUT);
    // A copy: the frozen default is never handed out to be frozen again.
    expect(resolveLayout(undefined, fail)).not.toBe(DEFAULT_UI_LAYOUT);
    expect(Object.isFrozen(DEFAULT_UI_LAYOUT)).toBe(true);
  });

  it("takes each field and defaults the rest", () => {
    expect(resolveLayout({ align: "left" }, fail)).toEqual({
      align: "left",
      scope: "content",
      maxWidth: 1400,
    });
    expect(resolveLayout({ align: "right", scope: "page" }, fail)).toEqual({
      align: "right",
      scope: "page",
      maxWidth: 1400,
    });
    expect(resolveLayout({ maxWidth: 1200 }, fail)).toEqual({
      align: "center",
      scope: "content",
      maxWidth: 1200,
    });
    expect(resolveLayout({ maxWidth: MIN_UI_MAX_WIDTH }, fail).maxWidth).toBe(
      320,
    );
  });

  it("refuses a value that is not an object, with the caller's error", () => {
    for (const value of [null, "center", 1400, ["center"], true]) {
      const error = thrown(() => resolveLayout(value, fail));
      expect(error).toBeInstanceOf(TestUiError);
      expect((error as Error).message).toBe(
        "layout must be an object of { align?, scope?, maxWidth? }",
      );
    }
  });

  it("names unknown keys and the known ones", () => {
    expect(() => resolveLayout({ width: 1200 }, fail)).toThrow(
      'layout: unknown key "width" (known: align, scope, maxWidth)',
    );
    expect(() => resolveLayout({ a: 1, b: 2 }, fail)).toThrow(
      'layout: unknown keys "a", "b" (known: align, scope, maxWidth)',
    );
  });

  it("refuses an align or scope outside their values", () => {
    for (const align of ["middle", "start", "CENTER", 1, null]) {
      const error = thrown(() => resolveLayout({ align }, fail));
      expect(error).toBeInstanceOf(TestUiError);
      expect((error as Error).message).toBe(
        'layout.align must be "left", "center" or "right"',
      );
      expect((error as TestUiError).context).toEqual({ value: align });
    }
    for (const scope of ["all", "nav", 0, null]) {
      expect(() => resolveLayout({ scope }, fail)).toThrow(
        'layout.scope must be "content" or "page"',
      );
    }
  });

  it("refuses a maxWidth that is not a whole number of at least 320", () => {
    for (const maxWidth of [
      319,
      0,
      -1400,
      1400.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
      "1400",
      "1400px",
      null,
    ]) {
      const error = thrown(() => resolveLayout({ maxWidth }, fail));
      expect(error).toBeInstanceOf(TestUiError);
      expect((error as Error).message).toBe(
        "layout.maxWidth must be a whole number of CSS pixels, at least 320",
      );
    }
  });

  it("names the option as the caller does", () => {
    expect(() =>
      resolveLayout({ align: "middle" }, fail, "viewer.layout"),
    ).toThrow('viewer.layout.align must be "left", "center" or "right"');
  });
});

describe("isUiLayout", () => {
  it("accepts every resolved layout", () => {
    for (const align of ["left", "center", "right"] as const) {
      for (const scope of ["content", "page"] as const) {
        expect(
          isUiLayout(resolveLayout({ align, scope, maxWidth: 900 }, fail)),
        ).toBe(true);
      }
    }
  });

  it("refuses a partial or wrong shape (a hand-edited or stale shell)", () => {
    for (const value of [
      undefined,
      null,
      "center",
      {},
      { align: "center", scope: "content" },
      { align: "middle", scope: "content", maxWidth: 1400 },
      { align: "center", scope: "nav", maxWidth: 1400 },
      { align: "center", scope: "content", maxWidth: 100 },
      { align: "center", scope: "content", maxWidth: "1400" },
      { align: "center", scope: "content", maxWidth: 1400.5 },
    ]) {
      expect(isUiLayout(value)).toBe(false);
    }
  });
});
