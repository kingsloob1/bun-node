#!/usr/bin/env bun
/**
 * Runs every security UI example, one at a time, in folder order, and
 * prints ok or FAIL for each with its time; exits 1 when any fails. A
 * folder prefix narrows the run (`bun run-all.ts 01`).
 *
 * ```bash
 * cd examples/bun-ui/security
 * bun run-all.ts
 * ```
 */
import { relative } from "node:path";
import process from "node:process";

const root = import.meta.dir;
const only = process.argv.slice(2);
const files = [...new Bun.Glob("[0-9][0-9]-*/**/*.ts").scanSync({ cwd: root })]
  .filter((file) => !/\/(?:helpers|fixtures)\//.test(file))
  .filter(
    (file) =>
      only.length === 0 || only.some((prefix) => file.startsWith(prefix)),
  )
  .sort();

let failed = 0;
for (const file of files) {
  const started = performance.now();
  const child = Bun.spawn(["bun", file], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const took = `${((performance.now() - started) / 1000).toFixed(1)}s`;
  if (code === 0) {
    console.log(`  ok    ${file.padEnd(52)} ${took}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${file.padEnd(52)} ${took}`);
    console.log(`${out}${err}`.trimEnd().replaceAll(/^/gm, "        "));
  }
}
console.log(
  `\n${files.length} examples: ${files.length - failed} passed, 0 skipped, ${failed} failed`,
);
console.log(`(from ${relative(process.cwd(), root) || "."})`);
process.exit(failed === 0 ? 0 : 1);
