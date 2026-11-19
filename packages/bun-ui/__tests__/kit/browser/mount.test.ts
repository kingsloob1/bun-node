/**
 * The kit's mount contract (`lib/kit/browser/mount.ts`, embedding.md §2, §6):
 * the `shell` values and defaults, `theme: "inherit"` and `themeSource`,
 * and a mounted `layout`'s defaults and checks. No DOM: these are the pure
 * halves the mount functions build on.
 */
import { describe, expect, it } from "bun:test";
import {
  DEFAULT_MOUNT_SHELL,
  DEFAULT_MOUNT_LAYOUT,
  DEFAULT_PAGE_SHELL,
  isUiShell,
  resolveMountLayout,
  resolveMountTheme,
  UI_SHELLS,
} from "../../../lib/kit/browser/mount";

describe("shell", () => {
  it("is full, tabs or none; the shell draws full, a mount none", () => {
    expect(UI_SHELLS).toEqual(["full", "tabs", "none"]);
    expect(DEFAULT_PAGE_SHELL).toBe("full");
    expect(DEFAULT_MOUNT_SHELL).toBe("none");
    for (const shell of UI_SHELLS) expect(isUiShell(shell)).toBe(true);
    for (const value of ["Full", "", null, undefined, 1, "header"]) {
      expect(isUiShell(value)).toBe(false);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(UI_SHELLS)).toBe(true);
  });
});

describe("resolveMountTheme", () => {
  it("keeps a named theme, whatever the host reports", () => {
    expect(resolveMountTheme("dark", () => "light")).toBe("dark");
    expect(resolveMountTheme("light")).toBe("light");
    expect(resolveMountTheme("system", () => "dark")).toBe("system");
  });

  it('takes "inherit" from themeSource, and follows the OS without one', () => {
    expect(resolveMountTheme("inherit", () => "dark")).toBe("dark");
    expect(resolveMountTheme("inherit", () => "light")).toBe("light");
    expect(resolveMountTheme("inherit")).toBe("system");
    expect(resolveMountTheme("inherit", () => undefined)).toBe("system");
  });

  it("negative control: a host reporting something else follows the OS", () => {
    expect(resolveMountTheme("inherit", () => "Dark")).toBe("system");
    expect(resolveMountTheme("inherit", () => "system")).toBe("system");
  });
});

describe("resolveMountLayout", () => {
  it("defaults to the host's width: left, content, no cap", () => {
    expect(DEFAULT_MOUNT_LAYOUT).toEqual({
      align: "left",
      scope: "content",
      maxWidth: "none",
    });
    expect(Object.isFrozen(DEFAULT_MOUNT_LAYOUT)).toBe(true);
    expect(resolveMountLayout()).toEqual({ ...DEFAULT_MOUNT_LAYOUT });
    expect(resolveMountLayout()).not.toBe(DEFAULT_MOUNT_LAYOUT);
  });

  it("fills each missing field from the default", () => {
    expect(resolveMountLayout({ align: "center" })).toEqual({
      align: "center",
      scope: "content",
      maxWidth: "none",
    });
    expect(resolveMountLayout({ maxWidth: 960, scope: "page" })).toEqual({
      align: "left",
      scope: "page",
      maxWidth: 960,
    });
  });

  it("refuses what the shell's layout option refuses, naming the field", () => {
    const bad: [unknown, string][] = [
      [{ align: "middle" }, "layout.align"],
      [{ scope: "screen" }, "layout.scope"],
      [{ maxWidth: 100 }, "layout.maxWidth"],
      [{ maxWidth: 960.5 }, "layout.maxWidth"],
      [{ maxWidth: "auto" }, "layout.maxWidth"],
      [null, "layout must be an object"],
      ["wide", "layout must be an object"],
    ];
    for (const [value, message] of bad) {
      expect(() =>
        resolveMountLayout(value as Parameters<typeof resolveMountLayout>[0]),
      ).toThrow(message);
    }
  });
});
