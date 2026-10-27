#!/usr/bin/env bun
/**
 * Type-checks every project in the repo, with Bun's built-in checker.
 *
 * They are listed in `PROJECTS` below: the packages, their nested benchmark,
 * playground and app projects, the standalone `benchmarks/` package, the
 * example projects, the starter templates and these root scripts themselves. Each has its own
 * `tsconfig.json`, and all of them extend `tsconfig.base.json`, so a file is
 * checked the same way wherever it is checked from.
 *
 * This exists because the per-package `include` used to be `./lib/**\/*` alone.
 * The IDE checks whatever file you open, `tsc --noEmit` checked only `lib`, and
 * the gap between the two was large enough to hide real errors in `__tests__/`
 * and `benchmarks/` while every documented command reported success.
 *
 * Each project runs through Bun's type checker (Bun ≥ 1.4.3; the repo's
 * development floor is 1.4.4, for `bun lint` and `bun fmt`), which reports
 * the same errors as `tsc --noEmit` on every core: measured on all 17
 * projects, the same verdict as the tsc version of this script in 7–10 s
 * against 109–112 s (the user's decision, 2026-10-10). The projects run one
 * after another rather than at once: each check already uses every core, and
 * 17 of them together saved about 2 s while putting 17 × 16 threads on a
 * shared machine.
 *
 * It runs `bun --check` in the project's directory, not `bun check -p`:
 * `bun check` runs the nearest `package.json`'s `check` script when there is
 * one, and the root's `check` script is this file, so `bun check -p` from
 * anywhere in the repo would run the whole repo again instead of the project.
 * A bare `bun --check` is always the type checker (Bun's docs say so).
 *
 * ```bash
 * bun scripts/typecheck.ts                    # every project
 * bun scripts/typecheck.ts --list             # just name them
 * bun scripts/typecheck.ts scripts/tsconfig.json   # only the projects named
 * ```
 */
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import process from "node:process";

/** Every tsconfig in the repo, as a path relative to the root. */
export const PROJECTS = [
  "packages/bun-common/tsconfig.json",
  "packages/bun-common/bench/tsconfig.json",
  "packages/bun-common/playground/tsconfig.json",
  "packages/bun-nest/tsconfig.json",
  "packages/bun-jobs/tsconfig.json",
  "packages/bun-jobs/bench/tsconfig.json",
  "packages/bun-jobs-ui/tsconfig.json",
  "packages/bun-jobs-ui/app/tsconfig.json",
  "packages/bun-api-docs-ui/tsconfig.json",
  "benchmarks/tsconfig.json",
  "playground/tsconfig.json",
  "examples/bun-jobs/tsconfig.json",
  "examples/bun-common/tsconfig.json",
  "examples/bun-nest/tsconfig.json",
  "examples/bun-jobs-ui/tsconfig.json",
  "packages/bun-jobs-ui/__tests__/app/pkg/tsconfig.json",
  // The repo's view of `templates/compute-provider/`, whose own config is a
  // plugin author's (no source condition). Needs `bun install` there first.
  "templates/tsconfig.json",
  "scripts/tsconfig.json",
  // The VS Code extension (docs/plans/bun-lint-fmt/ §5). Needs
  // `bun install --frozen-lockfile` there first, for `@types/vscode`.
  "tools/vscode-bun-lint/tsconfig.json",
] as const;

/**
 * The repo's development floor: `bun check` arrived in 1.4.3, and `bun lint`
 * and `bun fmt` in 1.4.4, which until it is stable means the canary (every
 * 1.4.4 canary reports `Bun.version` "1.4.4"; docs/plans/bun-lint-fmt/ §6).
 */
export const MIN_BUN = "1.4.4";

/**
 * Errors that are known noise rather than a problem with the code.
 *
 * `TS2742` and `TS2883` are the same complaint under two codes: the ESLint
 * flat config's inferred default export cannot be named without a path into a
 * pnpm-style store. Pre-existing, unrelated to anything the repo controls, and
 * about a config file rather than shipped code. Neither tsc 6.0 nor
 * `bun check` reported them on any project on 2026-10-10; the filter stays
 * because an ESLint config upgrade has brought them back before.
 */
export const IGNORED = /TS2742|TS2883/;

/** What one project's check found. */
export interface ProjectResult {
  /** The project, as given. */
  project: string;
  /** Error lines that count, one per error, in `bun check --no-pretty` form. */
  problems: string[];
  /** Whether the project failed: errors that count, or a check that could not run. */
  failed: boolean;
  /** Wall time of the check, in milliseconds. */
  ms: number;
}

/**
 * Reads one `bun check --no-pretty` run into a verdict.
 *
 * A check that exits non-zero without a single `error TS` line did not get as
 * far as checking (a missing tsconfig, a crash): that fails too, with its
 * output as the problem, so a broken run never reads as a clean one. A run
 * whose only errors are `IGNORED` passes, whatever its exit code.
 */
export function classify(
  output: string,
  exitCode: number,
): Pick<ProjectResult, "problems" | "failed"> {
  const errors = output.split("\n").filter((line) => /error TS\d+/.test(line));
  const problems = errors.filter((line) => !IGNORED.test(line));
  if (problems.length > 0) return { problems, failed: true };
  if (exitCode !== 0 && errors.length === 0) {
    const text = output.trim();
    return {
      problems: [text === "" ? `bun check exited ${exitCode}` : text],
      failed: true,
    };
  }
  return { problems: [], failed: false };
}

/**
 * The environment for a check: ours, without the variables that switch
 * `bun check` to its tagged, multi-line format for AI agents. The one-line
 * `tsc --pretty false` format is what `classify` reads, and a bare
 * `bun --check` does not take `--no-pretty`.
 */
function checkEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.AGENT;
  delete env.CLAUDECODE;
  delete env.REPL_ID;
  return env;
}

/**
 * Rewrites the paths of `bun --check`'s error lines, which are relative to the
 * project's directory, to be relative to `base`, so every line names the file
 * the way the project names do. A path with a scheme (`bundled:///libs/…`)
 * is left alone.
 */
export function rebase(output: string, from: string, base: string): string {
  return output.replace(
    /^(\S[^(\n]*)(\(\d+,\d+\): error TS\d+)/gm,
    (_line, path: string, rest: string) =>
      path.includes(":")
        ? `${path}${rest}`
        : `${relative(base, resolve(from, path))}${rest}`,
  );
}

/** Checks one project (a `tsconfig.json`, or its directory), from `cwd`. */
export function checkProject(
  project: string,
  cwd = process.cwd(),
): ProjectResult {
  const started = performance.now();
  const config = resolve(cwd, project);
  const dir = config.endsWith(".json") ? dirname(config) : config;
  const finish = (output: string, exitCode: number): ProjectResult => ({
    project,
    ...classify(rebase(output, dir, cwd), exitCode),
    ms: performance.now() - started,
  });

  // A bare `bun --check` checks the nearest tsconfig.json, which is the
  // project's only when the project is that file.
  if (basename(config) !== "tsconfig.json" && config !== dir) {
    return finish(
      `${project}: a project must be a tsconfig.json or its directory`,
      1,
    );
  }
  if (!existsSync(join(dir, "tsconfig.json"))) {
    return finish(`${project}: no such project`, 1);
  }

  const result = Bun.spawnSync({
    cmd: [process.execPath, "--check"],
    cwd: dir,
    env: checkEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return finish(
    `${result.stdout.toString()}${result.stderr.toString()}`,
    result.exitCode ?? 1,
  );
}

/** Checks `projects` in turn, prints a line each and a summary; answers the exit code. */
export function run(projects: readonly string[], cwd?: string): number {
  let failed = 0;

  for (const project of projects) {
    const result = checkProject(project, cwd);
    const elapsed = `${result.ms.toFixed(0)}ms`.padStart(7);

    if (!result.failed) {
      console.log(`  ok    ${project.padEnd(48)} ${elapsed}`);
      continue;
    }

    failed++;
    console.log(`  FAIL  ${project.padEnd(48)} ${elapsed}`);
    for (const problem of result.problems) console.log(`          ${problem}`);
  }

  console.log(
    failed === 0
      ? `\n${projects.length} projects, no type errors.`
      : `\n${failed} of ${projects.length} projects have type errors.`,
  );
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--list")) {
    for (const project of PROJECTS) console.log(project);
    process.exit(0);
  }

  if (Bun.semver.order(Bun.version, MIN_BUN) < 0) {
    console.error(
      `Developing this repo needs Bun >= ${MIN_BUN} (this is ${Bun.version}), for \`bun check\`, \`bun lint\` and \`bun fmt\`; ` +
        `using its packages needs only 1.4.2. Run \`bun upgrade --canary\` until 1.4.4 is stable, then \`bun upgrade\`.`,
    );
    process.exit(1);
  }

  const named = args.filter((arg) => !arg.startsWith("-"));
  process.exit(run(named.length > 0 ? named : PROJECTS));
}
