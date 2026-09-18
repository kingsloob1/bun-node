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

/** Whether the package typechecks right now. */
async function typechecks(): Promise<boolean> {
  const result = Bun.spawnSync({
    cmd: ["bunx", "tsc", "--noEmit", "-p", `${ROOT}/tsconfig.json`],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  return !/error TS\d+/.test(output);
}

if (!(await typechecks())) {
  console.error("The project does not typecheck as it stands; fix that first.");
  process.exit(1);
}

let dead = 0;
let live = 0;

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
      const stillPasses = await typechecks();

      if (stillPasses) {
        dead++;
        console.log(
          `  DEAD  line ${index + 1}: ${lines[index + 1]?.trim() ?? ""}`,
        );
      } else {
        live++;
      }
    } finally {
      await Bun.write(file, original);
    }
  }
}

console.log(
  dead === 0
    ? `\n${live} controls, every one live.`
    : `\n${dead} of ${live + dead} controls prove nothing.`,
);
process.exit(dead === 0 ? 0 : 1);
