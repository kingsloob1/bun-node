import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

/**
 * Typechecks this directory's project: the tests that import the bun-jobs
 * package itself (the real-API integration test and the bundle-safety test).
 * It is compiled without the DOM lib; see tsconfig.json. Running it from
 * `bun test` means it cannot be skipped by a typecheck script that does not
 * list the project.
 *
 * It runs Bun's type checker, a bare `bun --check` in this directory, which
 * checks the nearest tsconfig.json: this project's. Not `bun check -p`: that
 * would run the package's `check` script, which checks every project of the
 * package. The variables that switch the checker to its tagged format for AI
 * agents are dropped, so a failure reads as one line per error, as tsc's did.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Checks the project; its exit code and the error lines. */
function check() {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.AGENT;
  delete env.CLAUDECODE;
  delete env.REPL_ID;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--check"],
    cwd: here,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  return {
    exitCode: result.exitCode,
    errors: output.split("\n").filter((line) => /error TS\d+/.test(line)),
    output,
  };
}

describe("the package-importing app tests typecheck", () => {
  it("with no errors", () => {
    const { exitCode, errors, output } = check();
    expect(errors).toEqual([]);
    // A check that never ran (no tsconfig, a crash) prints no error lines.
    expect({ exitCode, output: exitCode === 0 ? "" : output }).toEqual({
      exitCode: 0,
      output: "",
    });
  }, 120_000);
});
