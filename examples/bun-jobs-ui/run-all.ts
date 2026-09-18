#!/usr/bin/env bun
/**
 * Runs every example, one at a time, and reports which passed.
 *
 * ```bash
 * bun run-all.ts          # every example
 * bun run-all.ts 02 10    # only folders starting 02 or 10
 * ```
 *
 * An example passes when it exits 0. An example that needs something this
 * machine lacks skips itself (printing a line starting `skipped:`) and still
 * exits 0. Output is shown only for failures, so a green run is one screen.
 */
import { relative } from "node:path";
import process from "node:process";

/** Folders to run, from the command line; every numbered folder when empty. */
const only = process.argv.slice(2);

const root = import.meta.dir;
const files = [...new Bun.Glob("[0-9][0-9]-*/**/*.ts").scanSync({ cwd: root })]
  // Files run *by* examples — helpers, fixtures — not on their own.
  .filter((file) => !/\/(?:handlers|helpers|fixtures|modules)\//.test(file))
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
    timeout: 300_000,
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
  `\n${files.length} examples: ${files.length - failed - skipped} passed, ${skipped} skipped, ${failed} failed`,
);
process.exit(failed === 0 ? 0 : 1);
