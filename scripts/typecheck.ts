#!/usr/bin/env bun
/**
 * Type-checks every project in the repo.
 *
 * There are nine: the three packages, their nested benchmark and playground
 * projects, the standalone `benchmarks/` package, and the root. Each has its
 * own `tsconfig.json`, and all of them extend `tsconfig.base.json`, so a file
 * is checked the same way wherever it is checked from.
 *
 * This exists because the per-package `include` used to be `./lib/**\/*` alone.
 * The IDE checks whatever file you open, `tsc --noEmit` checked only `lib`, and
 * the gap between the two was large enough to hide real errors in `__tests__/`
 * and `benchmarks/` while every documented command reported success.
 *
 * ```bash
 * bun scripts/typecheck.ts          # every project
 * bun scripts/typecheck.ts --list   # just name them
 * ```
 */
import process from "node:process";

/** Every tsconfig in the repo, as a path relative to the root. */
const PROJECTS = [
  "packages/bun-common/tsconfig.json",
  "packages/bun-common/bench/tsconfig.json",
  "packages/bun-common/playground/tsconfig.json",
  "packages/bun-nest/tsconfig.json",
  "packages/bun-jobs/tsconfig.json",
  "packages/bun-jobs/bench/tsconfig.json",
  "benchmarks/tsconfig.json",
  "examples/bun-jobs/tsconfig.json",
] as const;

/**
 * Errors that are known noise rather than a problem with the code.
 *
 * `TS2742` and `TS2883` are the same complaint under two codes: the ESLint
 * flat config's inferred default export cannot be named without a path into a
 * pnpm-style store. Pre-existing, unrelated to anything the repo controls, and
 * about a config file rather than shipped code.
 */
const IGNORED = /TS2742|TS2883/;

if (process.argv.includes("--list")) {
  for (const project of PROJECTS) console.log(project);
  process.exit(0);
}

let failed = 0;

for (const project of PROJECTS) {
  const started = performance.now();
  const result = Bun.spawnSync({
    cmd: ["bunx", "tsc", "--noEmit", "-p", project],
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  const problems = output
    .split("\n")
    .filter((line) => /error TS\d+/.test(line) && !IGNORED.test(line));
  const elapsed = `${(performance.now() - started).toFixed(0)}ms`.padStart(7);

  if (problems.length === 0) {
    console.log(`  ok    ${project.padEnd(48)} ${elapsed}`);
    continue;
  }

  failed++;
  console.log(`  FAIL  ${project.padEnd(48)} ${elapsed}`);
  for (const problem of problems) console.log(`          ${problem}`);
}

console.log(
  failed === 0
    ? `\n${PROJECTS.length} projects, no type errors.`
    : `\n${failed} of ${PROJECTS.length} projects have type errors.`,
);
process.exit(failed === 0 ? 0 : 1);
