#!/usr/bin/env bun
/**
 * Runs every example, one at a time, and reports which passed.
 *
 * ```bash
 * bun run-all.ts                        # every example, on the memory driver
 * bun run-all.ts 02 07                  # only folders starting 02 or 07
 * EXAMPLE_DRIVER=sqlite bun run-all.ts  # every example on SQLite
 * ```
 *
 * An example passes when it exits 0. Examples that need a server skip
 * themselves (and still exit 0) when their URL is unset, and are reported as
 * skipped. Output is shown only for failures, so a green run is one screen.
 */
import { relative } from "node:path";
import process from "node:process";

/** Folders to run, from the command line; every numbered folder when empty. */
const only = process.argv.slice(2);

const root = import.meta.dir;
const files = [...new Bun.Glob("[0-9][0-9]-*/**/*.ts").scanSync({ cwd: root })]
  // Handlers and helpers are run *by* examples, not on their own; so are the
  // processes a folder's `main.ts` starts.
  .filter((file) => !/\/(?:handlers|helpers|processors)\//.test(file))
  .filter((file) => !/\/cross-process\/(?!main\.ts$)/.test(file))
  .filter(
    (file) =>
      only.length === 0 || only.some((prefix) => file.startsWith(prefix)),
  )
  .sort();

let failed = 0;
let skipped = 0;

for (const file of files) {
  const started = performance.now();
  const result = Bun.spawnSync({
    cmd: [process.execPath, file],
    cwd: root,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    // Generous: the option tours in 10-options run hundreds of checks, and
    // a slow database server stretches them well past a minute.
    timeout: 600_000,
  });

  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  const elapsed = `${((performance.now() - started) / 1000).toFixed(1)}s`;
  const name = relative(root, `${root}/${file}`).padEnd(52);

  if (result.exitCode === 0 && output.startsWith("skipped:")) {
    skipped++;
    console.log(`  skip  ${name} ${output.split("\n")[0]}`);
  } else if (result.exitCode === 0) {
    console.log(`  ok    ${name} ${elapsed.padStart(6)}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name} ${elapsed.padStart(6)}`);
    console.log(
      output
        .trimEnd()
        .split("\n")
        .map((line) => `        ${line}`)
        .join("\n"),
    );
  }
}

console.log(
  `\n${files.length} examples: ${files.length - failed - skipped} passed, ${skipped} skipped, ${failed} failed` +
    ` (EXAMPLE_DRIVER=${process.env.EXAMPLE_DRIVER ?? "memory"})`,
);
process.exit(failed === 0 ? 0 : 1);
