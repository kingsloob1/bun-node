import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

/**
 * Typechecks this directory's project: the tests that import the bun-jobs
 * package itself (the real-API integration test and the bundle-safety test).
 * It is compiled without the DOM lib; see tsconfig.json. Running it from
 * `bun test` means it cannot be skipped by a typecheck script that does not
 * list the project.
 */

const here = dirname(fileURLToPath(import.meta.url));
const configPath = join(here, "tsconfig.json");

/** Compiles the project and returns its diagnostics. */
function compile() {
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
    rootNames: parsed.fileNames,
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
  it("with no errors", () => {
    expect(compile().map((diagnostic) => diagnostic.text)).toEqual([]);
  }, 120_000);
});
