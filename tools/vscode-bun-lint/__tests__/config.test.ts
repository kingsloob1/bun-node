import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  hasSection,
  isConfigured,
  nearestBunfig,
  workingDirectory,
} from "../src/core/config";

const REPO = join(import.meta.dir, "../../..");

describe("workingDirectory", () => {
  test("is the file's own directory (plan §5)", () => {
    expect(workingDirectory("/r/packages/bun-common/lib/BunRouter.ts")).toBe(
      "/r/packages/bun-common/lib",
    );
  });
});

describe("hasSection", () => {
  test("a table, a sub-table or an array of tables of the section", () => {
    expect(hasSection("[lint]\na = 1", "lint")).toBe(true);
    expect(hasSection("[lint.rules]\n", "lint")).toBe(true);
    expect(hasSection("[[lint.overrides]]\n", "lint")).toBe(true);
    expect(hasSection("  [fmt]\n", "fmt")).toBe(true);
  });

  test("not another section, a comment or a key", () => {
    expect(hasSection("[install]\npeer = false\n", "lint")).toBe(false);
    expect(hasSection("# [lint]\n", "lint")).toBe(false);
    expect(hasSection("[linter]\n", "lint")).toBe(false);
    expect(hasSection("lint = 1\n", "lint")).toBe(false);
  });
});

describe("nearestBunfig / isConfigured", () => {
  const files = new Map([
    ["/r/bunfig.toml", "[lint]\n[fmt]\n"],
    ["/r/t/c/bunfig.toml", "[install]\n"],
  ]);
  const read = (p: string) => files.get(p);

  test("walks up to the nearest one", () => {
    expect(nearestBunfig("/r/a/b", read)?.path).toBe("/r/bunfig.toml");
    expect(nearestBunfig("/r/t/c/src", read)?.path).toBe("/r/t/c/bunfig.toml");
    expect(nearestBunfig("/elsewhere", read)).toBeUndefined();
  });

  test("the nearest one decides, as it does for Bun", () => {
    expect(isConfigured("/r/a/b.ts", "lint", read)).toBe(true);
    expect(isConfigured("/r/t/c/src/x.ts", "lint", read)).toBe(false);
    expect(isConfigured("/elsewhere/x.ts", "fmt", read)).toBe(false);
  });

  test("in this repository: the root's and the template's own", () => {
    expect(nearestBunfig(join(REPO, "packages/bun-common/lib"))?.path).toBe(
      join(REPO, "bunfig.toml"),
    );
    expect(
      nearestBunfig(join(REPO, "templates/compute-provider/src"))?.path,
    ).toBe(join(REPO, "templates/compute-provider/bunfig.toml"));
    for (const file of [
      "packages/bun-jobs-ui/app/App.tsx",
      "templates/compute-provider/src/config.ts",
      "scripts/typecheck.ts",
    ]) {
      expect(isConfigured(join(REPO, file), "lint")).toBe(true);
      expect(isConfigured(join(REPO, file), "fmt")).toBe(true);
    }
  });
});
