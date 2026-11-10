/**
 * The kit's option checks (`lib/kit/options.ts`): every refusal is the
 * caller's error, so `jobsUi()` keeps throwing bun-jobs' `ConfigError` and
 * `docsUi()` bun-common's, and a third UI its own. The messages are the ones
 * the UIs threw before the kit (their own tests pin them through
 * `jobsUi()`/`docsUi()`).
 */
import type { ConfigFail } from "../../../lib/kit/options";
import { describe, expect, it } from "bun:test";
import {
  freezeConfig,
  normalizeMountPath,
  requireOptionsObject,
  resolveCommonOptions,
  resolveCsrfHeader,
  resolveTheme,
} from "../../../lib/kit/options";

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

describe("the kit's option checks", () => {
  it("throw the caller's error, with its message and context", () => {
    const error = thrown(() => normalizeMountPath("/", "basePath", "UI", fail));
    expect(error).toBeInstanceOf(TestUiError);
    expect((error as TestUiError).message).toBe(
      `basePath may not be "/": the UI's catch-all would answer for every GET route of the host`,
    );
    expect((error as TestUiError).context).toEqual({ value: "/" });
    // The owner names whose catch-all it would be.
    expect(
      (
        thrown(() =>
          normalizeMountPath("/", "basePath", "viewer", fail),
        ) as Error
      ).message,
    ).toContain("the viewer's catch-all");
  });

  it("normalise a mount path, or refuse it", () => {
    expect(normalizeMountPath("/admin/ui//", "basePath", "UI", fail)).toBe(
      "/admin/ui",
    );
    for (const bad of ["admin", "/a/../b", "/a b", 7]) {
      expect(
        thrown(() => normalizeMountPath(bad, "basePath", "UI", fail)),
      ).toBeInstanceOf(TestUiError);
    }
  });

  it("check title, middleware, authorize and dev in that order", () => {
    const first = (options: Record<string, unknown>) =>
      (thrown(() => resolveCommonOptions(options, "Default", fail)) as Error)
        .message;
    expect(first({ title: "", middleware: 1, authorize: 1, dev: 1 })).toBe(
      "title must be a non-empty string",
    );
    expect(first({ middleware: [1], authorize: 1, dev: 1 })).toBe(
      "middleware must be an array of functions",
    );
    expect(first({ authorize: 1, dev: 1 })).toBe(
      "authorize must be a function",
    );
    expect(first({ dev: "yes" })).toBe("dev must be a boolean");
    const handler = () => {};
    expect(
      resolveCommonOptions({ middleware: [handler] }, "Default", fail),
    ).toEqual({ title: "Default", middleware: [handler] });
  });

  it("refuse anything but an options object, naming the function", () => {
    expect(
      (thrown(() => requireOptionsObject(null, "testUi()", fail)) as Error)
        .message,
    ).toBe("testUi() needs an options object");
    expect(thrown(() => requireOptionsObject({}, "testUi()", fail))).toBe(
      undefined,
    );
  });

  it("resolve the theme", () => {
    expect(resolveTheme(undefined, fail)).toBe("system");
    expect(resolveTheme("dark", fail)).toBe("dark");
    expect(thrown(() => resolveTheme("blue", fail))).toBeInstanceOf(
      TestUiError,
    );
  });

  it("ask the CSRF fallback only when the option is unset", () => {
    let asked = 0;
    const fallback = () => {
      asked++;
      return "x-from-api";
    };
    expect(resolveCsrfHeader(undefined, fallback, fail)).toBe("x-from-api");
    expect(resolveCsrfHeader(false, fallback, fail)).toBe(null);
    expect(resolveCsrfHeader("x-csrf", fallback, fail)).toBe("x-csrf");
    expect(asked).toBe(1);
    expect(
      (thrown(() => resolveCsrfHeader("bad header", fallback, fail)) as Error)
        .message,
    ).toBe("csrfHeader must be a header name or false");
  });

  it("freeze a config and its nested objects", () => {
    const config = freezeConfig({ title: "T", nested: { a: 1 } });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.nested)).toBe(true);
  });
});
