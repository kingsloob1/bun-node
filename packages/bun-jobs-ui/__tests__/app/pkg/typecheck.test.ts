import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

/**
 * Typechecks this directory's project (the tests that import the bun-jobs
 * package, and `drift.ts`, which asserts the app's mirrored DTOs are identical
 * to the package's). It is compiled without the DOM lib; see tsconfig.json.
 * Running it from `bun test` means the drift check cannot be skipped by a
 * typecheck script that does not list the project.
 */

const here = dirname(fileURLToPath(import.meta.url));
const configPath = join(here, "tsconfig.json");
const negativePath = join(here, "negative", "drift-negative.ts");

/** Compiles the project, plus `extra` root files, and returns diagnostics per file. */
function compile(extra: string[] = []) {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
      },
    },
  );
  if (!parsed) {
    throw new Error(`could not read ${configPath}`);
  }
  const program = ts.createProgram({
    rootNames: [...parsed.fileNames, ...extra],
    options: parsed.options,
  });
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const file = diagnostic.file?.fileName ?? "(global)";
    const line =
      diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line +
          1
        : 0;
    return {
      file,
      line,
      code: diagnostic.code,
      text: `${file}:${line} TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
    };
  });
}

describe("the package-importing app tests typecheck", () => {
  it("with no errors, drift assertions included; and a wrong mirror fails", () => {
    const diagnostics = compile([negativePath]);
    const outside = diagnostics.filter(
      (diagnostic) => diagnostic.file !== negativePath,
    );
    expect(outside.map((diagnostic) => diagnostic.text)).toEqual([]);

    const expectedLines = readFileSync(negativePath, "utf8")
      .split("\n")
      .flatMap((text, index) =>
        text.includes("// @expect-error-line") ? [index + 1] : [],
      );
    const failedLines = [
      ...new Set(
        diagnostics
          .filter((diagnostic) => diagnostic.file === negativePath)
          .map((diagnostic) => diagnostic.line),
      ),
    ].sort((a, b) => a - b);
    expect(expectedLines.length).toBe(3);
    expect(failedLines).toEqual(expectedLines);
  }, 120_000);
});
