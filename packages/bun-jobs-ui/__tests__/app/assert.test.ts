import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "bun:test";
import { expectAbsent, expectNone, expectUndefined } from "./assert";

/**
 * The absence helpers (`./assert`), and the guard that keeps the app tests on
 * them: under `bun:test`, `expect(el).toBeNull()` can pass on a real element
 * that Bun cannot print (see `./assert`), so an absence check written with
 * the matcher may never fail.
 */

/** A value shaped like a DOM element, as the helpers read one. */
const element = {
  tagName: "BUTTON",
  getAttribute: (name: string) => (name === "data-testid" ? "save" : null),
  textContent: "Save changes",
};

/** The message an assertion threw, or `null` when it passed. */
function failure(assertion: () => void): string | null {
  try {
    assertion();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

describe("the absence helpers", () => {
  it("expectAbsent passes on null and fails on anything else, saying what it found", () => {
    expect(failure(() => expectAbsent(null))).toBe(null);
    expect(failure(() => expectAbsent(element, "the Save button"))).toBe(
      'Expected the Save button to be null, found <button data-testid="save"> "Save changes"',
    );
    expect(failure(() => expectAbsent(undefined))).toContain("found undefined");
    expect(failure(() => expectAbsent({}))).toContain("found an object");
    expect(failure(() => expectAbsent(0))).toContain("found 0");
  });

  it("expectUndefined passes on undefined and fails on anything else", () => {
    expect(failure(() => expectUndefined(undefined))).toBe(null);
    expect(failure(() => expectUndefined(null))).toContain("found null");
    expect(failure(() => expectUndefined(element))).toContain("<button");
  });

  it("expectNone passes on an empty list and names the first item otherwise", () => {
    expect(failure(() => expectNone([]))).toBe(null);
    expect(failure(() => expectNone([element, element], "the rows"))).toBe(
      'Expected the rows to be empty, found 2, the first <button data-testid="save"> "Save changes"',
    );
  });
});

describe("the app tests", () => {
  /** Every test source under `__tests__/app`, but this file and the helpers. */
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        return sources(path);
      }
      return /\.tsx?$/.test(name) && !/[/\\]assert(?:\.test)?\.ts$/.test(path)
        ? [path]
        : [];
    });
  }

  it("assert absence with the helpers, never a matcher that may not fail", () => {
    const root = import.meta.dir;
    const offenders: string[] = [];
    for (const file of sources(root)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        // Prose about the matcher is not a use of it.
        if (/^\s*(?:\*|\/\/)/.test(line)) {
          return;
        }
        // `.not.toBeNull()` and friends fail on null, which prints: safe.
        if (
          /(?<!\.not)\.(?:toBeNull|toBeUndefined)\(\)|(?<!\.not)\.toHaveLength\(0\)/.test(
            line,
          )
        ) {
          offenders.push(`${relative(root, file)}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
