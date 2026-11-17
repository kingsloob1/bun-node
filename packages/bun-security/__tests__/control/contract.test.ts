/**
 * The management API's contract is browser-safe (`./control/contract`):
 * its import graph, walked from the entry, has no runtime import outside
 * itself (no `node:*`, no `bun`, no package), only type imports. The
 * walker's negative control plants one.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "../..");

/** Every runtime import reachable from `entry`: `[from, specifier]`. */
function runtimeImports(
  entry: string,
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
) {
  const found: [string, string][] = [];
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = ts.createSourceFile(
      file,
      read(file),
      ts.ScriptTarget.Latest,
    );
    for (const statement of source.statements) {
      const typeOnly =
        (ts.isImportDeclaration(statement) &&
          statement.importClause?.isTypeOnly === true) ||
        (ts.isExportDeclaration(statement) && statement.isTypeOnly);
      if (!(
        ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
      ))
        continue;
      const specifier = statement.moduleSpecifier;
      if (specifier === undefined || !ts.isStringLiteral(specifier) || typeOnly)
        continue;
      const text = specifier.text;
      if (text.startsWith(".")) {
        walk(join(dirname(file), text.endsWith(".ts") ? text : `${text}.ts`));
      } else {
        found.push([file.slice(ROOT.length + 1), text]);
      }
    }
  };
  walk(entry);
  return { found, files: [...seen].map((file) => file.slice(ROOT.length + 1)) };
}

describe("./control/contract", () => {
  it("imports nothing at run time outside itself", () => {
    const { found, files } = runtimeImports(
      join(ROOT, "lib/control/contract/index.ts"),
    );
    expect(found).toEqual([]);
    expect(
      files.every((file) => file.startsWith("lib/control/contract/")),
    ).toBe(true);
  });

  it("negative control: a planted node:crypto import is found", () => {
    const entry = join(ROOT, "lib/control/contract/index.ts");
    const { found } = runtimeImports(entry, (file) =>
      file === entry
        ? `import "node:crypto";\n${readFileSync(file, "utf8")}`
        : readFileSync(file, "utf8"),
    );
    expect(found).toEqual([["lib/control/contract/index.ts", "node:crypto"]]);
  });
});
