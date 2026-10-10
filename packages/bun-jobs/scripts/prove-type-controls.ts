#!/usr/bin/env bun
/**
 * Proves every `@ts-expect-error` in a type test is a live negative control.
 *
 * A directive that guards a line which would compile anyway proves nothing —
 * and TypeScript only complains about *unused* directives, which is easy to
 * read past in a file that has thirty of them. So each one is removed in turn
 * and the project re-checked: the typecheck must fail while it is missing. One
 * that does not is reported, and the script exits non-zero.
 *
 * ```bash
 * bun scripts/prove-type-controls.ts                     # every type test
 * bun scripts/prove-type-controls.ts __tests__/x.type-test.ts
 * ```
 */
import process from "node:process";
import { Glob } from "bun";

/** The package root, whichever directory this was run from. */
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** Type-test files to check, from the command line or by convention. */
const targets =
  process.argv.slice(2).length > 0
    ? process.argv
        .slice(2)
        .map((path) => `${ROOT}/${path.replace(/^\.\//, "")}`)
    : (
        await Array.fromAsync(
          new Glob("__tests__/**/*.type-test.ts").scan({ cwd: ROOT }),
        )
      )
        .sort()
        .map((path) => `${ROOT}/${path}`);

/**
 * The environment for the checker: this process's, without the variables that
 * switch `bun --check` to its tagged, multi-line format for AI agents, so its
 * output is the one-line `path(line,col): error TS…` form read below.
 */
const CHECK_ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !["AGENT", "CLAUDECODE", "REPL_ID"].includes(name),
  ),
);

/**
 * Runs Bun's type checker (Bun ≥ 1.4.3) over the package: a bare `bun --check`
 * in the package checks its tsconfig.json. Not `bun check`, which would run the
 * package's `check` script. About 0.5 s a check against tsc's 13 s.
 */
function check(): { exitCode: number; output: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--check"],
    cwd: ROOT,
    env: CHECK_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

/** Escapes `text` for use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a check failed **because of a type error in `relative`**: exit 1 and
 * an error line located in that file. A non-zero exit alone is not enough —
 * `bun --check` also exits 1 on a broken or empty config (TS18003 "No inputs
 * were found", which carries no file location), a crash or a resolution
 * failure, and counting one of those as a live control is the false
 * assurance this script exists to prevent.
 */
function failsIn(
  result: { exitCode: number; output: string },
  relative: string,
): boolean {
  return (
    result.exitCode === 1 &&
    new RegExp(
      `^${escapeRegExp(relative)}\\(\\d+,\\d+\\): error TS\\d+`,
      "m",
    ).test(result.output)
  );
}

const baseline = check();
if (baseline.exitCode !== 0 || !baseline.output.includes("No type errors")) {
  console.error("The project does not typecheck as it stands; fix that first.");
  console.error(baseline.output.trim());
  process.exit(1);
}

let dead = 0;
let live = 0;
/** Controls whose check failed for some reason other than a type error in their file. */
let unproven = 0;

for (const file of targets) {
  const original = await Bun.file(file).text();
  const lines = original.split("\n");
  const directives = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trim().startsWith("// @ts-expect-error"));

  const relative = file.slice(ROOT.length + 1);
  console.log(`${relative}: ${directives.length} controls`);

  for (const { index } of directives) {
    // Replaced rather than deleted, so every other line keeps its number and
    // the error a live control produces is reported where it really is.
    const without = [...lines];
    without[index] = "";

    try {
      await Bun.write(file, without.join("\n"));
      const result = check();

      if (result.exitCode === 0) {
        dead++;
        console.log(
          `  DEAD  line ${index + 1}: ${lines[index + 1]?.trim() ?? ""}`,
        );
      } else if (failsIn(result, relative)) {
        live++;
      } else {
        unproven++;
        console.log(
          `  UNPROVEN  line ${index + 1}: the check failed, but not with a type error in ${relative}:`,
        );
        console.log(`    ${result.output.trim().split("\n").join("\n    ")}`);
      }
    } finally {
      await Bun.write(file, original);
    }
  }
}

const total = live + dead + unproven;
console.log(
  dead === 0 && unproven === 0
    ? `\n${live} controls, every one live.`
    : `\n${dead} of ${total} controls prove nothing; ${unproven} failed for a reason other than a type error in their file.`,
);
process.exit(dead === 0 && unproven === 0 ? 0 : 1);
