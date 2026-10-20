import { describe, expect, test } from "bun:test";
import {
  applyFixes,
  fixEdits,
  mergeFixes,
  minimalEdit,
} from "../src/core/edits";

/**
 * @param before The text.
 * @param edit The edit, or none.
 * @returns The text with the edit applied.
 */
function apply(before: string, edit: ReturnType<typeof minimalEdit>): string {
  return edit
    ? before.slice(0, edit.start) + edit.text + before.slice(edit.end)
    : before;
}

describe("minimalEdit", () => {
  test("equal texts need no edit", () => {
    expect(minimalEdit("a\n", "a\n")).toBeUndefined();
  });

  test("only the changed middle is replaced", () => {
    const before = "const a = {b:1}\nconst c = 1;\n";
    const after = "const a = { b: 1 };\nconst c = 1;\n";
    const edit = minimalEdit(before, after)!;
    expect(edit).toEqual({ start: 11, end: 15, text: " b: 1 };" });
    expect(apply(before, edit)).toBe(after);
  });

  test("insertions, deletions, whole replacements and empty sides", () => {
    for (const [before, after] of [
      ["ab", "aXb"],
      ["aXb", "ab"],
      ["abc", "xyz"],
      ["", "x\n"],
      ["x\n", ""],
      ["aaaa", "aa"],
    ] as const)
      expect(apply(before, minimalEdit(before, after))).toBe(after);
  });

  test("never splits a surrogate pair", () => {
    const before = 's = "😀"';
    const after = 's = "😁"';
    const edit = minimalEdit(before, after)!;
    expect(edit.text).toBe("😁");
    expect(apply(before, edit)).toBe(after);
  });
});

describe("mergeFixes (ESLint's one-pass rule)", () => {
  test("sorted by start", () => {
    expect(
      mergeFixes([
        { range: [5, 6], text: "b" },
        { range: [0, 1], text: "a" },
      ]).map((f) => f.text),
    ).toEqual(["a", "b"]);
  });

  test("an overlapping or touching fix waits for the next run", () => {
    const fixes = mergeFixes([
      { range: [0, 4], text: "A" },
      { range: [2, 6], text: "overlaps" },
      { range: [4, 5], text: "touches" },
      { range: [6, 7], text: "B" },
    ]);
    expect(fixes.map((f) => f.text)).toEqual(["A", "B"]);
  });

  test("a backwards range is skipped", () => {
    expect(mergeFixes([{ range: [3, 1], text: "x" }])).toEqual([]);
  });

  test("two inserts at one offset: the first only", () => {
    expect(
      mergeFixes([
        { range: [2, 2], text: "x" },
        { range: [2, 2], text: "y" },
      ]).map((f) => f.text),
    ).toEqual(["x"]);
  });
});

describe("applyFixes / fixEdits", () => {
  test("applies the fixes of a real report", () => {
    // `var b = 2;` (no-var) and `a as number` (no-unnecessary-type-assertion).
    const text =
      "const a = 1;\nvar b = 2;\nexport async function f() { Promise.resolve(1); return a + b; }\nconsole.log(a as number);\n";
    const fixes = [
      { range: [13, 16] as [number, number], text: "let" },
      { range: [101, 111] as [number, number], text: "" },
    ];
    expect(applyFixes(text, fixes)).toBe(
      "const a = 1;\nlet b = 2;\nexport async function f() { Promise.resolve(1); return a + b; }\nconsole.log(a);\n",
    );
    expect(fixEdits(fixes)).toEqual([
      { start: 13, end: 16, text: "let" },
      { start: 101, end: 111, text: "" },
    ]);
  });
});
