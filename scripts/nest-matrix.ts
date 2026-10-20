#!/usr/bin/env bun
/**
 * The NestJS version matrix: bun-nest's checks against a Nest version other
 * than the one the repo's lockfile pins, without touching the checkout.
 *
 * ```bash
 * bun scripts/nest-matrix.ts --prepare 12.1.3 11.2.7   # copy, pin, install, assert
 * bun scripts/nest-matrix.ts --run 11.2.7              # the checks, in that copy
 * bun scripts/nest-matrix.ts --dry-run --prepare 11.1.20 --run 11.1.20
 * bun scripts/nest-matrix.ts --list                    # the copies prepared so far
 * ```
 *
 * `--prepare` copies this checkout (no `node_modules`, `.git`, `dts`, `dist`)
 * to `<base>/<version>/`, pins every `@nestjs/*` dependency to the version,
 * widens bun-nest's peer range so the version is admitted, runs `bun install`
 * and asserts the copy resolves `@kingsleyweb/*` from itself and exactly one
 * `@nestjs/core`, at the version. It installs, so it is not a heavy run.
 *
 * `--run` runs, in each copy, bun-nest's suite, a bare `bun --check` in
 * bun-nest, `examples/bun-nest`'s `run-all.ts`, bun-jobs-ui's Nest test and
 * consumer-check, printing one line per check with what ran, and exits 1 on
 * any failure. It is a heavy run: through the wrapper, in the background.
 * Separate invocations may run at once (bun-nest's suite binds only port 0);
 * the wrapper decides how many.
 *
 * The base is `$HOME/bun-node-nest-matrix` (`--dir` or `NEST_MATRIX_DIR`
 * override it). It must have **no dot segment**: Express's `send` refuses
 * every file under one, so `~/.cache/...` fails expressCompat's
 * `res.sendFile` and `res.download` probes on both majors (measured, plan
 * `docs/plans/nestjs-12-parity` §2.2). It is not `/tmp`, which a reboot
 * wipes and which has run out of inodes here.
 */
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";

/** The checkout this script belongs to, and the one `--prepare` copies. */
export const REPO_ROOT = resolve(import.meta.dir, "..");

/** The Nest packages the repo installs, all released in lockstep. */
export const NEST_PACKAGES = [
  "@nestjs/common",
  "@nestjs/core",
  "@nestjs/platform-express",
  "@nestjs/websockets",
] as const;

/** The workspace packages a copy must resolve from itself. */
export const OWN_PACKAGES = [
  "@kingsleyweb/bun-common",
  "@kingsleyweb/bun-nest",
  "@kingsleyweb/bun-jobs",
  "@kingsleyweb/bun-jobs-ui",
] as const;

/** Directories (relative to a copy) from which `@nestjs/core` must resolve to one copy. */
export const NEST_CONSUMERS = [
  "packages/bun-nest",
  "examples/bun-nest",
  "packages/bun-jobs-ui",
] as const;

/** Names left out of the copy, at any depth. */
export const COPY_EXCLUDES = ["node_modules", ".git", "dts", "dist"] as const;

/** The marker file `--prepare` writes at the top of a copy. */
export const MARKER = "nest-matrix.json";

/** The directory in a copy that holds each check's full output. */
export const LOG_DIR = "matrix-logs";

/** The checks `--run` performs, in order. */
export const CHECKS = ["suite", "check", "examples", "ui", "consumer"] as const;

/** One of {@link CHECKS}. */
export type CheckName = (typeof CHECKS)[number];

/** What the command line asked for. */
export interface MatrixArgs {
  /** Versions to prepare, in order. */
  prepare: string[];
  /** Versions to run the checks on, in order (after any `prepare`). */
  run: string[];
  /** The base directory from `--dir`, if given (else the environment or the default). */
  dir?: string;
  /** `--dry-run`: print the plan, change nothing. */
  dryRun: boolean;
  /** `--list`: print the copies prepared under the base. */
  list: boolean;
  /** `--fresh`: delete a copy before preparing it again. */
  fresh: boolean;
  /** `--only a,b`: the subset of {@link CHECKS} to run; all by default. */
  only: CheckName[];
  /** `--help`. */
  help: boolean;
}

/** {@link parseArgs}' answer: the arguments, or why they are unusable. */
export type ParsedArgs =
  | { ok: true; args: MatrixArgs }
  | { ok: false; error: string };

/** A version a matrix directory can be named after: exact, no range. */
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

/** Parses the command line (`process.argv.slice(2)`). */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: MatrixArgs = {
    prepare: [],
    run: [],
    dryRun: false,
    list: false,
    fresh: false,
    only: [...CHECKS],
    help: false,
  };
  let target: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [name, inline] =
      arg.startsWith("--") && arg.includes("=")
        ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
        : [arg, undefined];
    const value = (): string | undefined => inline ?? argv[++i];
    switch (name) {
      case "--prepare":
        target = args.prepare;
        if (inline === undefined) continue;
        if (!VERSION.test(inline))
          return {
            ok: false,
            error: `${inline}: an exact version (12.1.3), not a range or tag`,
          };
        target.push(inline);
        continue;
      case "--run":
        target = args.run;
        if (inline === undefined) continue;
        if (!VERSION.test(inline))
          return {
            ok: false,
            error: `${inline}: an exact version (12.1.3), not a range or tag`,
          };
        target.push(inline);
        continue;
      case "--dir": {
        const dir = value();
        if (!dir || dir.startsWith("--"))
          return { ok: false, error: "--dir needs a directory" };
        args.dir = dir;
        break;
      }
      case "--only": {
        const list = value();
        if (!list) return { ok: false, error: "--only needs a list of checks" };
        const names = list
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const unknown = names.filter(
          (n) => !(CHECKS as readonly string[]).includes(n),
        );
        if (unknown.length > 0 || names.length === 0)
          return {
            ok: false,
            error: `--only takes ${CHECKS.join(", ")}; got ${list}`,
          };
        args.only = names as CheckName[];
        break;
      }
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--list":
        args.list = true;
        break;
      case "--fresh":
        args.fresh = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (arg.startsWith("-"))
          return { ok: false, error: `unknown option ${arg}` };
        if (!target)
          return {
            ok: false,
            error: `${arg}: a version must follow --prepare or --run`,
          };
        if (!VERSION.test(arg))
          return {
            ok: false,
            error: `${arg}: an exact version (12.1.3), not a range or tag`,
          };
        target.push(arg);
        continue;
    }
    // Any option other than --prepare/--run ends a version list.
    target = undefined;
  }
  for (const [flag, list] of [
    ["--prepare", args.prepare],
    ["--run", args.run],
  ] as const) {
    if (argv.includes(flag) && list.length === 0)
      return { ok: false, error: `${flag} needs at least one version` };
  }
  if (!args.help && !args.list && args.prepare.length + args.run.length === 0)
    return {
      ok: false,
      error: "nothing to do: give --prepare, --run or --list",
    };
  return { ok: true, args };
}

/** The usage text `--help` prints. */
export const USAGE = `usage: bun scripts/nest-matrix.ts [--prepare <version…>] [--run <version…>]
                                [--dir <base>] [--only ${CHECKS.join(",")}]
                                [--fresh] [--dry-run] [--list] [--help]

  --prepare <v…>  copy the checkout to <base>/<v>/, pin @nestjs/* to <v>,
                  widen bun-nest's peers, bun install, assert resolution
  --run <v…>      in each copy: bun-nest \`bun run test\`, \`bun --check\` in
                  bun-nest, examples/bun-nest \`run-all.ts\`, bun-jobs-ui's
                  nest.nest.test.ts, consumer-check (--work <base>/cc-<v>)
  --dir <base>    where the copies live (or NEST_MATRIX_DIR); default
                  $HOME/bun-node-nest-matrix. No segment may start with "."
  --only <list>   run a subset of the checks
  --fresh         delete a copy before preparing it
  --dry-run       print what would happen, change nothing
  --list          print the copies prepared under the base

Prepare directly (it installs). Run through the heavy-run wrapper:
  HEAVY_TICKET=<session>-nest-matrix /tmp/claude-1000/bun-node-heavy-run.sh \\
    nice -n 10 timeout 1800 bun scripts/nest-matrix.ts --run 11.2.7 > <log> 2>&1

Several versions in one --run run in turn. Separate invocations may run at
once (bun-nest's suite binds only port 0); the wrapper decides how many.

Exit: 0 every check passed, 1 a check or assertion failed, 2 bad usage.`;

/** The base directory: `--dir`, else `NEST_MATRIX_DIR`, else `$HOME/bun-node-nest-matrix`. */
export function baseDir(
  dir: string | undefined,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return resolve(
    dir ?? env.NEST_MATRIX_DIR ?? join(home, "bun-node-nest-matrix"),
  );
}

/**
 * The segments of an absolute `path` that start with a dot. Express's `send`
 * (`dotfiles: "ignore"`) refuses any file whose path has one, so a copy under
 * one fails `res.sendFile` and `res.download`.
 */
export function dotSegments(path: string): string[] {
  return resolve(path)
    .split(sep)
    .filter((s) => s.startsWith("."));
}

/** The copy for `version` under `base`; throws when the path has a dot segment. */
export function matrixDir(base: string, version: string): string {
  if (!VERSION.test(version))
    throw new Error(`${version}: an exact version, not a range or tag`);
  const dir = resolve(base, version);
  const dots = dotSegments(dir);
  if (dots.length > 0)
    throw new Error(
      `${dir}: has the dot segment(s) ${dots.join(", ")}; Express's send refuses ` +
        `res.sendFile/res.download under one, so two expressCompat probes would fail ` +
        `for the path, not for Nest. Choose another --dir or NEST_MATRIX_DIR.`,
    );
  return dir;
}

/** The parts of a `package.json` the matrix reads and rewrites. */
export interface Manifest {
  /** The package's name. */
  name?: string;
  /** Runtime dependencies. */
  dependencies?: Record<string, string>;
  /** Development dependencies. */
  devDependencies?: Record<string, string>;
  /** Peer dependencies. */
  peerDependencies?: Record<string, string>;
  /** Every other field, kept as is. */
  [key: string]: unknown;
}

/** {@link rewriteManifest}'s answer. */
export interface Rewrite {
  /** The manifest with the changes applied (a new object; the input is untouched). */
  manifest: Manifest;
  /** One line per change, `devDependencies @nestjs/core: ^11.1.27 -> 12.1.3`. */
  changes: string[];
}

/** Options of {@link rewriteManifest}. */
export interface RewriteOptions {
  /**
   * Widen `@nestjs/*` peer ranges that do not admit the version (bun-nest's
   * manifest). Default false.
   */
  widenPeers?: boolean;
}

/** A peer range widened so it admits `version`, or the range itself when it already does. */
export function widenRange(range: string, version: string): string {
  if (Bun.semver.satisfies(version, range)) return range;
  const major = version.split(".")[0];
  const wider = `${range} || ^${major}.0.0`;
  return Bun.semver.satisfies(version, wider)
    ? wider
    : `${wider} || ${version}`;
}

/**
 * Pins every `@nestjs/*` in `dependencies` and `devDependencies` to exactly
 * `version` and, with `widenPeers`, widens the `@nestjs/*` peer ranges that do
 * not admit it. Pure: answers a new manifest and the list of changes.
 */
export function rewriteManifest(
  manifest: Manifest,
  version: string,
  options: RewriteOptions = {},
): Rewrite {
  const out: Manifest = structuredClone(manifest);
  const changes: string[] = [];
  for (const field of ["dependencies", "devDependencies"] as const) {
    const deps = out[field];
    if (!deps) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (!name.startsWith("@nestjs/") || range === version) continue;
      deps[name] = version;
      changes.push(`${field} ${name}: ${range} -> ${version}`);
    }
  }
  if (options.widenPeers && out.peerDependencies) {
    for (const [name, range] of Object.entries(out.peerDependencies)) {
      if (!name.startsWith("@nestjs/")) continue;
      const wider = widenRange(range, version);
      if (wider === range) continue;
      out.peerDependencies[name] = wider;
      changes.push(`peerDependencies ${name}: ${range} -> ${wider}`);
    }
  }
  return { manifest: out, changes };
}

/** True when a manifest names an `@nestjs/*` package in `dependencies` or `devDependencies`. */
export function hasNestDependency(manifest: Manifest): boolean {
  return [manifest.dependencies, manifest.devDependencies].some(
    (deps) =>
      deps !== undefined &&
      Object.keys(deps).some((n) => n.startsWith("@nestjs/")),
  );
}

/**
 * The `package.json` files under `root` (relative paths) that name a Nest
 * dependency, skipping `node_modules`, dot directories and `docs/` (whose
 * manifests are frozen evidence fixtures, never installed).
 */
export function findNestManifests(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith("."))
          continue;
        if (dir === root && (entry.name === "docs" || entry.name === LOG_DIR))
          continue;
        walk(path);
      } else if (entry.name === "package.json") {
        const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
        if (hasNestDependency(manifest)) found.push(relative(root, path));
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Adds `consumerDependencies` pinning Nest to `version` to a
 * `consumer-check.json`. Without it the consumer takes the highest version
 * bun-nest's peer range admits, not the column's.
 */
export function pinConsumerCheck(
  config: Record<string, unknown>,
  version: string,
): Record<string, unknown> {
  const existing = Array.isArray(config.consumerDependencies)
    ? (config.consumerDependencies as string[]).filter(
        (d) => !d.startsWith("@nestjs/"),
      )
    : [];
  return {
    ...config,
    consumerDependencies: [
      ...existing,
      ...["@nestjs/common", "@nestjs/core", "@nestjs/websockets"].map(
        (n) => `${n}@${version}`,
      ),
    ],
  };
}

// ---------------------------------------------------------------- output parsing

/** Removes ANSI colour codes. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;]*m/g, "");
}

/** The summary `bun test` prints. */
export interface BunTestSummary {
  /** Tests that passed. */
  pass: number;
  /** Tests that failed. */
  fail: number;
  /** Tests skipped (0 when the line is absent). */
  skip: number;
  /** Tests marked todo (0 when the line is absent). */
  todo: number;
  /** "Ran N tests". */
  tests: number;
  /** "across M files". */
  files: number;
  /** The names of the failing tests, from its `(fail)` lines, without duplicates. */
  failures: string[];
}

/** Reads `bun test`'s summary from its output; null when there is none. */
export function parseBunTest(output: string): BunTestSummary | null {
  const text = stripAnsi(output);
  const ran = /Ran (\d+) tests? across (\d+) files?/.exec(text);
  if (!ran) return null;
  const count = (word: string): number => {
    const m = new RegExp(`^\\s*(\\d+) ${word}$`, "m").exec(text);
    return m ? Number(m[1]) : 0;
  };
  const failures = [
    ...new Set(
      text
        .split("\n")
        .map((l) => /^\s*\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(l)?.[1])
        .filter((x): x is string => x !== undefined),
    ),
  ];
  return {
    pass: count("pass"),
    fail: count("fail"),
    skip: count("skip"),
    todo: count("todo"),
    tests: Number(ran[1]),
    files: Number(ran[2]),
    failures,
  };
}

/** The summary an `examples/*` `run-all.ts` prints. */
export interface RunAllSummary {
  /** Examples run. */
  total: number;
  /** Examples that passed. */
  passed: number;
  /** Examples skipped. */
  skipped: number;
  /** Examples that failed. */
  failed: number;
  /** The failing examples' names. */
  failures: string[];
}

/** Reads `run-all.ts`'s summary (`20 examples: 15 passed, 0 skipped, 5 failed`); null when absent. */
export function parseRunAll(output: string): RunAllSummary | null {
  const text = stripAnsi(output);
  const m = /(\d+) examples?: (\d+) passed, (\d+) skipped, (\d+) failed/.exec(
    text,
  );
  if (!m) return null;
  const failures = [
    ...new Set(
      text
        .split("\n")
        .map((l) => /^\s{0,4}FAIL\s+(\S+)/.exec(l)?.[1])
        .filter((x): x is string => x !== undefined),
    ),
  ];
  return {
    total: Number(m[1]),
    passed: Number(m[2]),
    skipped: Number(m[3]),
    failed: Number(m[4]),
    failures,
  };
}

/** What a bare `bun --check` reported. */
export interface CheckSummary {
  /** Lines with `error TS…`. */
  errors: number;
  /** "No type errors in N files", when it said so. */
  files?: number;
  /** The first error lines, for the report. */
  sample: string[];
}

/** Reads a bare `bun --check`'s output (one-line format, agent variables removed). */
export function parseCheck(output: string): CheckSummary {
  const text = stripAnsi(output);
  const lines = text.split("\n").filter((l) => /error TS\d+/.test(l));
  const files = /No type errors in (\d+) files?/.exec(text);
  return {
    errors: lines.length,
    ...(files ? { files: Number(files[1]) } : {}),
    sample: lines.slice(0, 5),
  };
}

/** The parts of consumer-check's `--save` file the matrix reads. */
export interface ConsumerResult {
  /** The TypeScript version the consumer used. */
  typescript: string;
  /** One cell per spelling × column. */
  cells: { key: string; status: string }[];
  /** Spelling → "ok" or the failure. */
  runtime: Record<string, string>;
  /** Declarations importing what the consumer may not have. */
  leaks: string[];
}

/** consumer-check's counts. */
export interface ConsumerSummary {
  /** Cells that are OK. */
  ok: number;
  /** All cells. */
  cells: number;
  /** Runtime imports that worked. */
  runtimeOk: number;
  /** Runtime imports attempted. */
  runtime: number;
  /** Leaked imports. */
  leaks: number;
  /** The keys of the cells that are not OK, and the runtime failures. */
  failures: string[];
}

/** Counts a consumer-check result. */
export function summariseConsumer(result: ConsumerResult): ConsumerSummary {
  const bad = result.cells.filter((c) => c.status !== "OK");
  const runtime = Object.entries(result.runtime);
  return {
    ok: result.cells.length - bad.length,
    cells: result.cells.length,
    runtimeOk: runtime.filter(([, r]) => r === "ok").length,
    runtime: runtime.length,
    leaks: result.leaks.length,
    failures: [
      ...bad.map((c) => `${c.key}: ${c.status}`),
      ...runtime
        .filter(([, r]) => r !== "ok")
        .map(([s, r]) => `${s} runtime: ${r}`),
      ...result.leaks.map((l) => `leak: ${l}`),
    ],
  };
}

// ---------------------------------------------------------------- verdicts and output

/** One check's outcome. */
export interface CheckResult {
  /** The Nest version of the copy. */
  version: string;
  /** The check's label, `bun-nest suite`. */
  label: string;
  /** Whether it passed. */
  ok: boolean;
  /** What ran, with counts: `427 pass, 0 fail, 0 skip; 427 tests in 30 files`. */
  detail: string;
  /** Failing test or example names, or other problems, printed under the line. */
  problems: string[];
  /** Wall time in milliseconds, when it ran. */
  ms?: number;
  /** The file holding the check's full output. */
  log?: string;
}

/** How a check judges a finished command: exit code plus output. */
export type Judge = (
  exitCode: number,
  output: string,
) => Pick<CheckResult, "ok" | "detail" | "problems">;

/** Judges a `bun test` run: exit 0, a summary, at least one test, none failing. */
export const judgeBunTest: Judge = (exitCode, output) => {
  const s = parseBunTest(output);
  if (!s)
    return {
      ok: false,
      detail: `no bun test summary (exit ${exitCode})`,
      problems: tail(output),
    };
  const detail = `${s.pass} pass, ${s.fail} fail, ${s.skip} skip${s.todo ? `, ${s.todo} todo` : ""}; ${s.tests} tests in ${s.files} files`;
  const problems = [...s.failures];
  if (s.tests === 0) problems.push("ran no tests");
  if (exitCode !== 0 && s.fail === 0)
    problems.push(`exit ${exitCode} with no failing test`, ...tail(output));
  return {
    ok: exitCode === 0 && s.fail === 0 && s.tests > 0,
    detail,
    problems,
  };
};

/** Judges a bare `bun --check`: exit 0 and no `error TS` line. */
export const judgeCheck: Judge = (exitCode, output) => {
  const s = parseCheck(output);
  const detail = `${s.errors} type errors${s.files === undefined ? "" : ` in ${s.files} files`}`;
  const problems = s.errors > 0 ? s.sample : exitCode !== 0 ? tail(output) : [];
  return { ok: exitCode === 0 && s.errors === 0, detail, problems };
};

/** Judges a `run-all.ts`: exit 0, a summary, at least one example, none failing. */
export const judgeRunAll: Judge = (exitCode, output) => {
  const s = parseRunAll(output);
  if (!s)
    return {
      ok: false,
      detail: `no run-all summary (exit ${exitCode})`,
      problems: tail(output),
    };
  const detail = `${s.passed} passed, ${s.skipped} skipped, ${s.failed} failed of ${s.total} examples`;
  const problems = [...s.failures];
  if (s.total === 0) problems.push("ran no examples");
  return {
    ok: exitCode === 0 && s.failed === 0 && s.total > 0,
    detail,
    problems,
  };
};

/** The last lines of an output, for a failure with no better explanation. */
function tail(output: string, n = 5): string[] {
  return stripAnsi(output).trim().split("\n").slice(-n);
}

/** Formats a duration: `850ms`, `12.3s`, `6m10s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** The line printed for one check, then its problems, indented. */
export function formatCheck(r: CheckResult, maxProblems = 12): string {
  const time = r.ms === undefined ? "" : `  (${formatDuration(r.ms)})`;
  const lines = [
    `  ${r.ok ? "ok  " : "FAIL"}  ${r.version.padEnd(8)} ${r.label.padEnd(24)} ${r.detail}${time}`,
  ];
  for (const p of r.problems.slice(0, maxProblems))
    lines.push(`          ${p}`);
  if (r.problems.length > maxProblems)
    lines.push(`          … and ${r.problems.length - maxProblems} more`);
  if (!r.ok && r.log) lines.push(`          full output: ${r.log}`);
  return lines.join("\n");
}

/** The closing summary: one line per version, then the total. */
export function formatSummary(results: readonly CheckResult[]): string {
  const versions = [...new Set(results.map((r) => r.version))];
  const lines = ["", "nest-matrix summary"];
  for (const v of versions) {
    const mine = results.filter((r) => r.version === v);
    const failed = mine.filter((r) => !r.ok);
    lines.push(
      `  ${v.padEnd(8)} ${mine.length - failed.length} of ${mine.length} checks passed${
        failed.length ? `; FAIL: ${failed.map((r) => r.label).join(", ")}` : ""
      }`,
    );
  }
  const failed = results.filter((r) => !r.ok).length;
  lines.push(
    `${versions.length} version(s), ${results.length - failed} of ${results.length} checks passed` +
      ` -> exit ${exitStatus(results)}`,
  );
  return lines.join("\n");
}

/** 0 when every check passed, 1 otherwise (and for none at all: a run that ran nothing proves nothing). */
export function exitStatus(results: readonly CheckResult[]): 0 | 1 {
  return results.length > 0 && results.every((r) => r.ok) ? 0 : 1;
}

// ---------------------------------------------------------------- side effects

/** What `--prepare` records at the top of a copy. */
export interface MarkerData {
  /** The Nest version the copy is pinned to. */
  version: string;
  /** "preparing" until every assertion passed, then "prepared". */
  state: "preparing" | "prepared";
  /** The checkout it was copied from. */
  source: string;
  /** That checkout's HEAD, with `-dirty` when it had uncommitted changes. */
  commit: string;
  /** When the copy was (last) prepared, ISO 8601. */
  at: string;
  /** The Bun that installed it. */
  bun: string;
}

/** Reads a copy's marker; null when there is none. */
export function readMarker(dir: string): MarkerData | null {
  const path = join(dir, MARKER);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as MarkerData;
}

/** The environment for a bare `bun --check`: without the variables that switch it to the agents' format. */
export function checkerEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const out = { ...env };
  delete out.AGENT;
  delete out.CLAUDECODE;
  delete out.REPL_ID;
  return out;
}

/** Runs a command to completion, its output captured to `log`; answers the exit code and the output. */
function runLogged(
  cmd: string[],
  cwd: string,
  log: string,
  env: Record<string, string | undefined> = process.env,
): { exitCode: number; output: string; ms: number } {
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "w");
  const started = performance.now();
  try {
    const result = Bun.spawnSync({
      cmd,
      cwd,
      env,
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    });
    return {
      exitCode: result.exitCode ?? 1,
      output: readFileSync(log, "utf8"),
      ms: performance.now() - started,
    };
  } finally {
    closeSync(fd);
  }
}

/** Runs a command whose output only matters on failure; throws with its tail. */
function runOrThrow(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync({
    cmd,
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${r.stdout.toString()}${r.stderr.toString()}`;
  if (r.exitCode !== 0)
    throw new Error(
      `${cmd.join(" ")} (in ${cwd}) exited ${r.exitCode}:\n${tail(output, 20).join("\n")}`,
    );
  return output;
}

/** The version and real path of the copy of `name` that `from` resolves. */
export function resolvePackage(
  name: string,
  from: string,
): { version: string; path: string } | null {
  let entry: string;
  try {
    entry = Bun.resolveSync(name, from);
  } catch {
    return null;
  }
  // 12's `exports` has no `./package.json`, so walk up from the entry.
  for (
    let dir = dirname(realpathSync(entry));
    dir !== dirname(dir);
    dir = dirname(dir)
  ) {
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    const m = JSON.parse(readFileSync(manifest, "utf8")) as {
      name?: string;
      version?: string;
    };
    if (m.name === name) return { version: m.version ?? "?", path: dir };
  }
  return null;
}

/** Every installed copy of `name` under `root` (any `node_modules`, at any depth), as `path@version`. */
export function findInstalledCopies(root: string, name: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, inNodeModules: boolean): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (!inNodeModules && e.name === ".git") continue;
      const path = join(dir, e.name);
      if (e.name === "node_modules") {
        const manifest = join(path, name, "package.json");
        if (
          existsSync(manifest) &&
          !lstatSync(join(path, name)).isSymbolicLink()
        ) {
          const v = (
            JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }
          ).version;
          found.push(`${relative(root, join(path, name))}@${v}`);
        }
        walk(path, true);
      } else {
        walk(path, inNodeModules);
      }
    }
  };
  walk(root, false);
  return found.sort();
}

/** The checkout's HEAD, `-dirty` when it has uncommitted changes, or "unknown". */
function sourceCommit(): string {
  const head = Bun.spawnSync({
    cmd: ["git", "rev-parse", "--short=12", "HEAD"],
    cwd: REPO_ROOT,
  });
  if (head.exitCode !== 0) return "unknown";
  const dirty = Bun.spawnSync({
    cmd: ["git", "status", "--porcelain"],
    cwd: REPO_ROOT,
  });
  return `${head.stdout.toString().trim()}${dirty.stdout.toString().trim() ? "-dirty" : ""}`;
}

/** The rsync command that makes or refreshes a copy. */
export function rsyncCommand(source: string, dest: string): string[] {
  return [
    "rsync",
    "-a",
    "--delete",
    ...COPY_EXCLUDES.map((e) => `--exclude=${e}`),
    `--exclude=/${MARKER}`,
    `${source}/`,
    `${dest}/`,
  ];
}

/** Prepares one copy; answers its assertion results. Throws on a setup failure. */
function prepare(version: string, base: string, fresh: boolean): CheckResult[] {
  const dir = matrixDir(base, version);
  if (dir === REPO_ROOT || dir.startsWith(`${REPO_ROOT}${sep}`))
    throw new Error(`${dir}: inside the checkout it copies`);
  if (existsSync(dir) && readdirSync(dir).length > 0 && !readMarker(dir))
    throw new Error(
      `${dir}: exists, is not empty and has no ${MARKER}; not a matrix copy, refusing to rsync --delete into it`,
    );
  if (fresh && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const marker: MarkerData = {
    version,
    state: "preparing",
    source: REPO_ROOT,
    commit: sourceCommit(),
    at: new Date().toISOString(),
    bun: Bun.version,
  };
  writeFileSync(join(dir, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
  console.log(`prepare ${version}: ${REPO_ROOT} (${marker.commit}) -> ${dir}`);
  runOrThrow(rsyncCommand(REPO_ROOT, dir), REPO_ROOT);

  for (const rel of findNestManifests(dir)) {
    const path = join(dir, rel);
    const { manifest, changes } = rewriteManifest(
      JSON.parse(readFileSync(path, "utf8")) as Manifest,
      version,
      { widenPeers: rel === join("packages", "bun-nest", "package.json") },
    );
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    for (const c of changes) console.log(`  ${rel}: ${c}`);
  }
  const ccPath = join(dir, "packages", "bun-nest", "consumer-check.json");
  writeFileSync(
    ccPath,
    `${JSON.stringify(pinConsumerCheck(JSON.parse(readFileSync(ccPath, "utf8")) as Record<string, unknown>, version), null, 2)}\n`,
  );
  console.log(
    `  packages/bun-nest/consumer-check.json: consumerDependencies @nestjs/{common,core,websockets}@${version}`,
  );

  const install = runLogged(
    [process.execPath, "install"],
    dir,
    join(dir, LOG_DIR, "install.log"),
  );
  if (install.exitCode !== 0)
    throw new Error(
      `bun install in ${dir} exited ${install.exitCode}:\n${tail(install.output, 20).join("\n")}`,
    );
  console.log(
    `  bun install: ok (${formatDuration(install.ms)}), log ${join(dir, LOG_DIR, "install.log")}`,
  );

  const results = assertResolution(version, dir);
  if (results.every((r) => r.ok)) {
    writeFileSync(
      join(dir, MARKER),
      `${JSON.stringify({ ...marker, state: "prepared" }, null, 2)}\n`,
    );
  }
  return results;
}

/** The resolution assertions on a prepared copy, as check results. */
export function assertResolution(version: string, dir: string): CheckResult[] {
  const results: CheckResult[] = [];

  const own = OWN_PACKAGES.map((name) => ({
    name,
    r: resolvePackage(name, dir),
  }));
  const outside = own.filter(
    ({ r }) => !r || !r.path.startsWith(`${dir}${sep}`),
  );
  results.push({
    version,
    label: "@kingsleyweb/* resolve",
    ok: outside.length === 0,
    detail: `${own.length - outside.length} of ${own.length} resolve inside the copy`,
    problems: outside.map(
      ({ name, r }) => `${name} -> ${r?.path ?? "unresolved"}`,
    ),
  });

  const problems: string[] = [];
  const corePaths = new Set<string>();
  let resolved = 0;
  let wanted = 0;
  for (const from of NEST_CONSUMERS) {
    for (const name of from === "packages/bun-nest"
      ? NEST_PACKAGES
      : (["@nestjs/common", "@nestjs/core"] as const)) {
      wanted++;
      const r = resolvePackage(name, join(dir, from));
      if (!r) {
        problems.push(`${name} unresolved from ${from}`);
        continue;
      }
      if (name === "@nestjs/core") corePaths.add(r.path);
      if (r.version !== version)
        problems.push(`${name} from ${from} is ${r.version}, not ${version}`);
      else if (!r.path.startsWith(`${dir}${sep}`))
        problems.push(
          `${name} from ${from} resolves outside the copy: ${r.path}`,
        );
      else resolved++;
    }
  }
  if (corePaths.size > 1)
    problems.push(
      `@nestjs/core resolves to ${corePaths.size} copies: ${[...corePaths].map((p) => relative(dir, p)).join(", ")}`,
    );
  const copies = findInstalledCopies(dir, "@nestjs/core");
  if (copies.length !== 1)
    problems.push(
      `installed @nestjs/core copies: ${copies.join(", ") || "none"}`,
    );
  results.push({
    version,
    label: "@nestjs/* resolve",
    ok: problems.length === 0,
    detail: `${resolved} of ${wanted} resolutions at ${version} from ${NEST_CONSUMERS.join(", ")}; ${copies.length} @nestjs/core installed`,
    problems,
  });
  return results;
}

/** What `--run` executes for each check: label, command, directory, environment and judge. */
export interface CheckPlan {
  /** Which check. */
  name: CheckName;
  /** The label printed for it. */
  label: string;
  /** The command, `bun` first. */
  cmd: string[];
  /** Its working directory, relative to the copy. */
  cwd: string;
  /** Whether to drop `AGENT`, `CLAUDECODE` and `REPL_ID` from its environment. */
  checkerEnv: boolean;
}

/**
 * consumer-check's work directory for the copy at `dir`: `<base>/cc-<version>`,
 * beside the copy, never inside it. Inside, the consumer's TypeScript would
 * walk up into the copy's `node_modules/@types` and resolve what a real
 * consumer does not have; consumer-check's default (`$TMPDIR`) is shared by
 * every session.
 */
export function consumerWorkDir(dir: string): string {
  return join(dirname(dir), `cc-${basename(dir)}`);
}

/** The checks for the copy at `dir`, in {@link CHECKS} order, filtered by `only`. */
export function checkPlans(
  dir: string,
  only: readonly CheckName[] = CHECKS,
  bun = process.execPath,
): CheckPlan[] {
  const all: CheckPlan[] = [
    {
      name: "suite",
      label: "bun-nest suite",
      cmd: [bun, "run", "test"],
      cwd: "packages/bun-nest",
      checkerEnv: false,
    },
    {
      name: "check",
      label: "bun-nest bun --check",
      cmd: [bun, "--check"],
      cwd: "packages/bun-nest",
      checkerEnv: true,
    },
    {
      name: "examples",
      label: "examples/bun-nest",
      cmd: [bun, "run-all.ts"],
      cwd: "examples/bun-nest",
      checkerEnv: false,
    },
    {
      name: "ui",
      label: "bun-jobs-ui nest test",
      cmd: [bun, "test", "--check", "./__tests__/server/nest.nest.test.ts"],
      cwd: "packages/bun-jobs-ui",
      checkerEnv: false,
    },
    {
      name: "consumer",
      label: "consumer-check bun-nest",
      cmd: [
        bun,
        "scripts/consumer-check.ts",
        "packages/bun-nest",
        "--work",
        consumerWorkDir(dir),
        "--save",
        join(dir, LOG_DIR, "consumer-check.json"),
      ],
      cwd: ".",
      checkerEnv: false,
    },
  ];
  return all.filter((p) => only.includes(p.name));
}

/** Runs the checks in one prepared copy, printing each line as it finishes. */
function runChecks(
  version: string,
  base: string,
  only: readonly CheckName[],
): CheckResult[] {
  const dir = matrixDir(base, version);
  const marker = readMarker(dir);
  if (!marker || marker.state !== "prepared" || marker.version !== version) {
    const why = !marker
      ? "not prepared"
      : marker.version !== version
        ? `prepared for ${marker.version}`
        : "its prepare did not finish";
    return [
      {
        version,
        label: "copy",
        ok: false,
        detail: `${dir}: ${why}; run --prepare ${version} first`,
        problems: [],
      },
    ];
  }
  console.log(
    `run ${version}: ${dir} (prepared ${marker.at} from ${marker.commit}, Bun ${Bun.version})`,
  );
  const results: CheckResult[] = assertResolution(version, dir);
  for (const r of results) console.log(formatCheck(r));

  for (const plan of checkPlans(dir, only)) {
    const log = join(dir, LOG_DIR, `${plan.name}.log`);
    const run = runLogged(
      plan.cmd,
      join(dir, plan.cwd),
      log,
      plan.checkerEnv ? checkerEnv() : process.env,
    );
    let verdict: Pick<CheckResult, "ok" | "detail" | "problems">;
    if (plan.name === "suite" || plan.name === "ui")
      verdict = judgeBunTest(run.exitCode, run.output);
    else if (plan.name === "check")
      verdict = judgeCheck(run.exitCode, run.output);
    else if (plan.name === "examples")
      verdict = judgeRunAll(run.exitCode, run.output);
    else verdict = judgeConsumer(run.exitCode, run.output, dir, version);
    const result: CheckResult = {
      version,
      label: plan.label,
      ...verdict,
      ms: run.ms,
      log,
    };
    console.log(formatCheck(result));
    results.push(result);
  }
  return results;
}

/** Judges consumer-check from its saved result and the Nest its consumer installed. */
function judgeConsumer(
  exitCode: number,
  output: string,
  dir: string,
  version: string,
): Pick<CheckResult, "ok" | "detail" | "problems"> {
  const saved = join(dir, LOG_DIR, "consumer-check.json");
  if (!existsSync(saved))
    return {
      ok: false,
      detail: `no result saved (exit ${exitCode})`,
      problems: tail(output),
    };
  const result = JSON.parse(readFileSync(saved, "utf8")) as ConsumerResult;
  const s = summariseConsumer(result);
  const nest = ["consumer", "consumer-peers"]
    .map((c) =>
      join(
        consumerWorkDir(dir),
        c,
        "node_modules",
        "@nestjs",
        "core",
        "package.json",
      ),
    )
    .filter((p) => existsSync(p))
    .map(
      (p) =>
        (JSON.parse(readFileSync(p, "utf8")) as { version: string }).version,
    );
  const problems = [...s.failures];
  if (nest.length === 0)
    problems.push("the consumer has no @nestjs/core installed");
  for (const v of nest)
    if (v !== version)
      problems.push(`the consumer installed @nestjs/core ${v}, not ${version}`);
  if (exitCode !== 0) problems.push(`exit ${exitCode}`, ...tail(output));
  return {
    ok: exitCode === 0 && problems.length === 0 && s.cells > 0,
    detail:
      `${s.ok}/${s.cells} cells OK, ${s.runtimeOk}/${s.runtime} runtime imports ok, ${s.leaks} leaks; ` +
      `TypeScript ${result.typescript}, consumer on @nestjs/core ${[...new Set(nest)].join("/") || "none"}`,
    problems,
  };
}

/** Prints what `--prepare` and `--run` would do. */
function dryRun(args: MatrixArgs, base: string): void {
  for (const version of args.prepare) {
    const dir = matrixDir(base, version);
    console.log(`prepare ${version}:`);
    console.log(
      `  ${args.fresh ? `delete ${dir}, then ` : ""}${rsyncCommand(REPO_ROOT, dir).join(" ")}`,
    );
    for (const rel of findNestManifests(REPO_ROOT)) {
      const { changes } = rewriteManifest(
        JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8")) as Manifest,
        version,
        { widenPeers: rel === join("packages", "bun-nest", "package.json") },
      );
      for (const c of changes) console.log(`  ${rel}: ${c}`);
    }
    console.log(
      `  packages/bun-nest/consumer-check.json: consumerDependencies @nestjs/{common,core,websockets}@${version}`,
    );
    console.log(`  (cd ${dir} && bun install)`);
    console.log(`  assert: ${OWN_PACKAGES.join(", ")} resolve inside ${dir}`);
    console.log(
      `  assert: @nestjs/* at ${version} from ${NEST_CONSUMERS.join(", ")}; one @nestjs/core installed`,
    );
  }
  for (const version of args.run) {
    const dir = matrixDir(base, version);
    console.log(`run ${version}:`);
    for (const p of checkPlans(dir, args.only)) {
      const env = p.checkerEnv ? "env -u AGENT -u CLAUDECODE -u REPL_ID " : "";
      console.log(
        `  (cd ${join(dir, p.cwd)} && ${env}${p.cmd.map((c) => (c === process.execPath ? "bun" : c)).join(" ")})`,
      );
    }
  }
}

/** Prints the copies under the base. */
function list(base: string): void {
  if (!existsSync(base)) {
    console.log(`${base}: no copies`);
    return;
  }
  const rows = readdirSync(base)
    .map((v) => ({ v, m: readMarker(join(base, v)) }))
    .filter((x): x is { v: string; m: MarkerData } => x.m !== null);
  if (rows.length === 0) console.log(`${base}: no copies`);
  for (const { v, m } of rows)
    console.log(
      `${v.padEnd(10)} ${m.state.padEnd(10)} ${m.commit.padEnd(20)} ${m.at}  ${join(base, v)}`,
    );
}

/** The command line; answers the exit status. */
export function main(argv: readonly string[]): number {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    console.error(`nest-matrix: ${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const { args } = parsed;
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const base = baseDir(args.dir);
  try {
    for (const v of [...args.prepare, ...args.run]) matrixDir(base, v);
  } catch (error) {
    console.error(`nest-matrix: ${(error as Error).message}`);
    return 2;
  }
  if (args.list) list(base);
  if (args.dryRun) {
    dryRun(args, base);
    return 0;
  }

  const results: CheckResult[] = [];
  for (const version of args.prepare) {
    try {
      const asserted = prepare(version, base, args.fresh);
      for (const r of asserted) console.log(formatCheck(r));
      results.push(...asserted);
    } catch (error) {
      const r: CheckResult = {
        version,
        label: "prepare",
        ok: false,
        detail: (error as Error).message,
        problems: [],
      };
      console.log(formatCheck(r));
      results.push(r);
    }
  }
  for (const version of args.run)
    results.push(...runChecks(version, base, args.only));
  if (results.length === 0) return 0; // --list alone
  console.log(formatSummary(results));
  return exitStatus(results);
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
