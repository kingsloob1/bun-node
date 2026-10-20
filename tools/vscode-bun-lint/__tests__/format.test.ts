// `bun fmt` through the extension's own `formatText`, against the real
// binary and the repository's `[fmt]` config. The file names are virtual:
// the buffer goes on standard input, as the editor sends it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, test } from "bun:test";
import { CancelledError, FormatError, formatText } from "../src/core/service";

const REPO = join(import.meta.dir, "../../..");
const bunPath = process.execPath;

/**
 * @param text The buffer.
 * @param edit The edit, or none.
 * @returns The buffer with it applied.
 */
function apply(
  text: string,
  edit: Awaited<ReturnType<typeof formatText>>,
): string {
  return edit
    ? text.slice(0, edit.start) + edit.text + text.slice(edit.end)
    : text;
}

describe("formatText", () => {
  const file = join(REPO, "packages/bun-common/lib/__probe_format__.ts");

  test("Format Document: the buffer becomes bun fmt's output, in one edit", async () => {
    const text = "const a = {b:1,   c:2}\nfunction  f( x ){return x}\n";
    const edit = await formatText(file, text, { bunPath });
    expect(apply(text, edit)).toBe(
      "const a = { b: 1, c: 2 };\nfunction f(x) {\n  return x;\n}\n",
    );
  });

  test("an already formatted buffer needs no edit", async () => {
    // A real file, formatted once: the second pass has nothing to do.
    const real = join(REPO, "templates/compute-provider/src/errors.ts");
    const once = apply(
      readFileSync(real, "utf8"),
      await formatText(real, readFileSync(real, "utf8"), { bunPath }),
    );
    expect(await formatText(real, once, { bunPath })).toBeUndefined();
  });

  test("Format Selection formats only the statements the range touches, by UTF-16 offset", async () => {
    // "é😀" is 3 UTF-16 units and 6 bytes: a byte offset would land in the second statement.
    const text =
      'const s  =  "é😀"; const b = {x:1}\nconst a = {b:1,   c:2}\nconst c = {b:1,   c:2}\n';
    const start = text.indexOf("const c");
    const edit = await formatText(file, text, {
      bunPath,
      range: { start, end: start + 1 },
    });
    expect(apply(text, edit)).toBe(
      'const s  =  "é😀"; const b = {x:1}\nconst a = {b:1,   c:2}\nconst c = { b: 1, c: 2 };\n',
    );
  });

  test("the repository's [fmt] config applies (singleAttributePerLine)", async () => {
    const tsx = join(REPO, "packages/bun-jobs-ui/app/__probe_format__.tsx");
    const text = 'export const X = () => <a href="/" title="t">x</a>;\n';
    const out = apply(text, await formatText(tsx, text, { bunPath }));
    expect(out).toBe(
      'export const X = () => (\n  <a\n    href="/"\n    title="t"\n  >\n    x\n  </a>\n);\n',
    );
  });

  test("Markdown is not formatted (Q3: ignorePatterns)", async () => {
    const md = join(REPO, "packages/bun-common/__probe__.md");
    expect(await formatText(md, "#  a\n\n*  b\n", { bunPath })).toBeUndefined();
  });

  test("a syntax error is a FormatError with bun fmt's message", async () => {
    const error = await formatText(file, "const a = {\n", { bunPath }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FormatError);
    expect((error as FormatError).message).toContain("'}' expected");
  });

  test("an aborted run is a CancelledError", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await formatText(file, "const a = 1;\n", {
      bunPath,
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CancelledError);
  });
});
