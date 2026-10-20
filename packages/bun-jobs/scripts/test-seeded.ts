#!/usr/bin/env bun
/**
 * The order-leak check for bun-jobs: the test files split into serial shards,
 * run side by side.
 *
 * `bun run test` runs `bun test --parallel`, and `--parallel` implies
 * `--isolate`: every file gets a fresh global object and module registry. That
 * is what makes the parallel run fast and repeatable, and it is also a blind
 * spot — a file that leaks state (a module singleton, a global, a timer, a
 * subscription) into the next one can never be caught by it, because there is
 * no next one in the same global. The check for that is a serial run,
 * `bun test --randomize --seed=N`, where files share one process. For bun-jobs
 * that run is long, so this script deals the files into `--shards` groups
 * (4 by default) and runs each group as one serial
 * `bun test --randomize --seed=N ./file ...` process, all groups at once.
 *
 * A shard still sees only the leaks between files that share it. Which files
 * share a shard is decided by a shuffle seeded with the same `--seed`, so a
 * different seed pairs different files: run it with a few seeds over time and
 * every pair gets its turn. Order matters too: `--randomize` shuffles the
 * files within a shard, and a leak shows only when the leaking file runs
 * before the file it breaks. So with 4 shards one seed catches a given leak
 * between two light files about one time in six (they share a shard 0.32 of
 * the time over 1000 seeds; in that order 1/2), between a heavy and a light
 * file about one in twelve (0.17), where a single serial run catches it one
 * time in two. Measured with a
 * planted leak among 8 files: 4 shards put the pair together for 3 of 12
 * seeds and caught it on 1; the two files alone, serially, failed 4 of 8.
 *
 * The database URLs (`BUN_JOBS_TEST_*_URL`) are removed from every shard's
 * environment unless `--with-databases` is given, so the database suites skip
 * visibly and the run needs no shared server — an ordinary heavy-run slot
 * rather than the whole machine. The serial run with all five URLs is a
 * separate, exclusive check, made once per merge window (`CLAUDE.md`).
 *
 * ```bash
 * bun scripts/test-seeded.ts                   # a fresh seed, printed first
 * bun scripts/test-seeded.ts --seed 7          # reproduce a run
 * bun scripts/test-seeded.ts --shards 1        # the plain serial run
 * bun scripts/test-seeded.ts --with-databases  # keep BUN_JOBS_TEST_*_URL
 * bun scripts/test-seeded.ts --update-timings  # also rewrite bun-timings.seeded.json
 * ```
 *
 * Shards are balanced by per-file durations from `bun-timings.seeded.json`
 * (`--timings` names another file), measured by this script serially and
 * without the database URLs — `bun-timings.json` is measured in parallel with
 * them, and predicts a serial shard poorly. The few heavy files go first,
 * each on a shard the seed picks among those it still fits on, and the rest
 * follow in shuffled order to whichever shard has the least time so far (see
 * {@link partitionFiles}).
 * `--update-timings` rewrites the file from a passing run; refresh it when
 * files are added or slowed. Without a timings file the files are dealt
 * round-robin. Measured with seeds 1–3: round-robin left the shortest shard
 * 3–5 minutes behind the longest (6m11s–6m57s overall); balanced, the
 * shards ended within a minute of each other (5m10s–6m20s overall, on a
 * busier machine).
 *
 * The package is type-checked once first (a bare `bun --check`, under a second),
 * and no shard starts when that fails; the shards themselves run no check.
 *
 * Each shard runs in its own process group, so SIGINT or SIGTERM to this
 * script stops the shards and whatever their tests spawned, and it waits for
 * them before it exits. A SIGKILL to this script cannot be forwarded: the
 * shards, in their own groups, outlive it. So stop it with SIGTERM (a plain
 * `timeout N` does), never `kill -9` or `timeout -k`.
 *
 * Each shard's output goes to its own log file — under
 * `~/.cache/bun-node/test-seeded/` unless `--log-dir` says otherwise, the
 * newest 20 runs kept; the summary gives every
 * shard's counts, wall time and the command that reproduces it serially. The
 * exit status is 1 when any shard failed or crashed.
 */
/* eslint-disable no-console -- a CLI entry point: what it prints is its product. */
import type { Subprocess } from "bun";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

/** The package root, whichever directory this was run from. */
const ROOT = resolve(import.meta.dir, "..");

/** The largest seed `bun test --seed` accepts (an unsigned 32-bit integer). */
export const MAX_SEED = 0xffffffff;

/**
 * The per-file durations the shards are balanced by, when `--timings` is not
 * given: measured by this script (`--update-timings`), serially and without
 * the database URLs, unlike `bun-timings.json`, which `bun run test` measures
 * in parallel with them.
 */
export const DEFAULT_TIMINGS = "bun-timings.seeded.json";

/**
 * A file is heavy, and placed before the shuffled rest, when its weight is at
 * least this share of one shard's fair share of the total. Measured on
 * bun-jobs' serial timings over 200 seeds, the longest shard: dealt
 * round-robin, median 485 s (p90 613); every file shuffled into the
 * lightest shard, 368 s (p90 451); heavy files first at this share, 331 s
 * (p90 348), against a fair share of 319 s.
 */
export const HEAVY_SHARE = 0.25;

/** Mixed into the seed for the heavy files' shard choice, so it is not the shuffle's own stream. */
const HEAVY_STREAM = 0x9e3779b9;

/** How many shards run when `--shards` is not given. */
export const DEFAULT_SHARDS = 4;

/**
 * The file names `bun test` treats as test files: `.test`, `_test`, `.spec` or
 * `_spec` before a JavaScript or TypeScript extension.
 */
export const TEST_FILE_PATTERN =
  /(?:\.test|_test|\.spec|_spec)\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;

/** The environment variables that point the suites at a database server. */
export const DATABASE_URL_PATTERN = /^BUN_JOBS_TEST_\w+_URL$/;

/**
 * The five database URLs the suites read today, named in a reproduce command
 * whether or not they were set here: the shell it is pasted into may set them.
 */
const DATABASE_URL_NAMES = [
  "REDIS",
  "POSTGRES",
  "MARIADB",
  "MYSQL",
  "MONGODB",
].map((name) => `BUN_JOBS_TEST_${name}_URL`);

/**
 * Every test file under `root`, as `bun test` with no arguments finds them:
 * matching {@link TEST_FILE_PATTERN}, skipping `node_modules` and hidden
 * directories. Paths are relative to `root`, with `/` separators, sorted.
 */
export function discoverTestFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (relative: string): void => {
    const entries = readdirSync(join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith("."))
          continue;
        walk(path);
      } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
        found.push(path);
      }
    }
  };
  walk("");
  return found.sort();
}

/**
 * mulberry32: a small deterministic PRNG. Returns a function yielding numbers
 * in `[0, 1)`; the same seed always yields the same sequence.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A Fisher–Yates shuffle of a copy of `items`, driven by `seed`. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Splits `files` into shards: sorted (so the input order does not matter),
 * then shuffled with `seed`. Every file lands in exactly one shard, and the
 * same files, seed and weights always give the same shards.
 *
 * Without `weights` the shuffled files are dealt round-robin. With them, the
 * heavy files — each at least a quarter of a shard's fair share
 * ({@link HEAVY_SHARE}) — are placed first, in shuffled order: each on a
 * shard the seed picks among those it still fits on without passing the fair
 * share, or on the lightest shard when it fits on none. So two heavy files
 * can share a shard (about one seed in four for a pair in bun-jobs) without
 * three of them piling up. The rest follow in shuffled order, each to the
 * shard with the least weight so far (fewest files, then lowest index, on a
 * tie), so which files share a shard follows the seed. A file with no weight
 * counts as the median of the known ones, so a new file is not treated as
 * free; every weight counts as at least 1.
 *
 * Returns `min(shards, files.length)` shards, none empty: an empty shard
 * would be a `bun test` with no paths, which runs every file.
 *
 * @throws RangeError when `shards` is not a positive integer.
 */
export function partitionFiles(
  files: readonly string[],
  seed: number,
  shards: number,
  weights?: Readonly<Record<string, number>>,
): string[][] {
  if (!Number.isInteger(shards) || shards < 1)
    throw new RangeError(`shards must be a positive integer, got ${shards}`);
  const shuffled = seededShuffle([...files].sort(), seed);
  const count = Math.min(shards, shuffled.length);
  const out: string[][] = Array.from({ length: count }, () => []);
  if (!weights) {
    shuffled.forEach((file, index) => out[index % count].push(file));
    return out;
  }

  const timed = (file: string): number | undefined => {
    const weight = weights[file];
    return typeof weight === "number" && Number.isFinite(weight)
      ? weight
      : undefined;
  };
  const known = shuffled
    .map(timed)
    .filter((weight): weight is number => weight !== undefined)
    .sort((a, b) => a - b);
  const fallback = known.length > 0 ? known[known.length >> 1] : 1;
  const weightOf = new Map(
    shuffled.map((file) => [file, Math.max(1, timed(file) ?? fallback)]),
  );
  const total = [...weightOf.values()].reduce((sum, weight) => sum + weight, 0);
  const fairShare = total / count;
  const heavyFrom = fairShare * HEAVY_SHARE;
  const heavy = shuffled.filter((file) => weightOf.get(file)! >= heavyFrom);
  const rest = shuffled.filter((file) => weightOf.get(file)! < heavyFrom);

  const load = Array.from<number>({ length: count }).fill(0);
  const pick = mulberry32((seed ^ HEAVY_STREAM) >>> 0);
  for (const file of heavy) {
    const weight = weightOf.get(file)!;
    const fits = load
      .map((used, index) => ({ used, index }))
      .filter(({ used }) => used + weight <= fairShare)
      .map(({ index }) => index);
    const target =
      fits.length > 0
        ? fits[Math.floor(pick() * fits.length)]
        : load.indexOf(Math.min(...load));
    out[target].push(file);
    load[target] += weight;
  }
  for (const file of rest) {
    let target = 0;
    for (let index = 1; index < count; index++) {
      if (
        load[index] < load[target] ||
        (load[index] === load[target] && out[index].length < out[target].length)
      ) {
        target = index;
      }
    }
    out[target].push(file);
    load[target] += weightOf.get(file)!;
  }
  return out;
}

/**
 * The per-file durations (ms) in a `bun test --timings` file
 * (`{ "version": 1, "files": { "<path>": ms } }`), or `undefined` when the
 * file is missing or not that shape.
 */
export function readTimings(path: string): Record<string, number> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  const files = (parsed as { files?: unknown } | null)?.files;
  if (typeof files !== "object" || files === null) return undefined;
  const out: Record<string, number> = {};
  for (const [file, ms] of Object.entries(files)) {
    if (typeof ms === "number" && Number.isFinite(ms)) out[file] = ms;
  }
  return out;
}

/** The `bun test` arguments that run one shard serially, after `bun`. */
export function shardArgs(files: readonly string[], seed: number): string[] {
  // `./` makes each argument a path rather than a name filter: a bare
  // `keys.test.ts` also matches `runner-config-error-keys.test.ts`.
  return [
    "test",
    "--randomize",
    `--seed=${seed}`,
    ...files.map((file) => `./${file}`),
  ];
}

/** A copy of `env` without the database URLs ({@link DATABASE_URL_PATTERN}). */
export function withoutDatabaseUrls(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !DATABASE_URL_PATTERN.test(key))
      out[key] = value;
  }
  return out;
}

/** The counts a `bun test` run prints at its end. */
export interface TestCounts {
  /** Tests that passed. */
  pass: number;
  /** Tests that failed. */
  fail: number;
  /** Tests skipped (`test.skip`, `skipIf`, a suite with no database URL). */
  skip: number;
  /** Tests marked `test.todo`. */
  todo: number;
  /** Files the run reports having run (`Ran N tests across M files`), or `undefined` when it printed no summary. */
  files: number | undefined;
}

/** Reads the summary `bun test` prints at the end of its output. */
export function parseCounts(output: string): TestCounts {
  const count = (label: string) =>
    Number(new RegExp(`^\\s*(\\d+) ${label}$`, "m").exec(output)?.[1] ?? 0);
  const ran = /^Ran \d+ tests? across (\d+) files?\./m.exec(output);
  return {
    pass: count("pass"),
    fail: count("fail"),
    skip: count("skip"),
    todo: count("todo"),
    files: ran ? Number(ran[1]) : undefined,
  };
}

/**
 * The tests a `bun test` run reports as failed, each as `file > name`: the
 * `(fail)` lines, under the file heading bun prints before a file's failures.
 */
export function failedTests(output: string): string[] {
  const failed: string[] = [];
  let file = "";
  for (const line of output.split("\n")) {
    const heading = /^(\S.*):$/.exec(line);
    if (heading && TEST_FILE_PATTERN.test(heading[1])) file = heading[1]!;
    const fail = /^\(fail\) (.*?)(?: \[[\d.]+m?s\])?$/.exec(line);
    if (fail) failed.push(file ? `${file} > ${fail[1]}` : fail[1]);
  }
  return failed;
}

/** One shard's outcome. */
interface ShardResult {
  /** The shard's number, from 1. */
  index: number;
  /** The files it ran, relative to the package root. */
  files: string[];
  /** Where its output went. */
  log: string;
  /** Where it wrote its per-file durations, under `--update-timings`. */
  timings: string;
  /** The process's exit code, or `null` when a signal ended it. */
  exitCode: number | null;
  /** The signal that ended it, if one did. */
  signal: string | null;
  /** Its wall time, in milliseconds. */
  ms: number;
  /** What its summary said. */
  counts: TestCounts;
  /** Why it counts as failed, or `undefined` when it passed. */
  problem: string | undefined;
}

/** `1m05s` style, for wall times. */
function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0
    ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
    : `${seconds}s`;
}

/** `1 shard`, `4 shards`. */
function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

/** What the command line asked for. */
interface CliOptions {
  /** The seed for both the partition and every shard's `--randomize`. */
  seed: number;
  /** Whether the seed was given, rather than picked. */
  seedGiven: boolean;
  /** How many shards to deal the files into. */
  shards: number;
  /** Keep the `BUN_JOBS_TEST_*_URL` variables. */
  withDatabases: boolean;
  /** Where the shard logs go. */
  logDir: string;
  /** The timings file the shards are balanced by (and `--update-timings` writes). */
  timings: string;
  /** Rewrite `timings` from this run's measured per-file durations. */
  updateTimings: boolean;
}

/** How many runs' logs the default log directory keeps; older ones are removed. */
const KEPT_RUNS = 20;

/**
 * A fresh directory for this run's logs under the user's cache
 * (`$XDG_CACHE_HOME`, else `~/.cache`), `bun-node/test-seeded/<seed>-<time>`.
 * Not the OS temp directory: nothing removes these, and /tmp has run out of
 * inodes on this machine before. The oldest runs past {@link KEPT_RUNS} go.
 */
function defaultLogDir(seed: number): string {
  const parent = join(
    process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    "bun-node",
    "test-seeded",
  );
  mkdirSync(parent, { recursive: true });
  // Stat each run once, dropping any that vanished meanwhile: a run started
  // beside this one may prune the same directories.
  const runs = readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const path = join(parent, entry.name);
      try {
        return [{ path, mtimeMs: statSync(path).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const old of runs.slice(0, Math.max(0, runs.length - (KEPT_RUNS - 1))))
    rmSync(old.path, { recursive: true, force: true });
  const time = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return mkdtempSync(join(parent, `${seed}-${time}-`));
}

/** Parses `argv`, or prints why not and exits 2. */
function parseCli(argv: string[]): CliOptions {
  const usage =
    "usage: bun scripts/test-seeded.ts [--seed N] [--shards K] [--with-databases] [--log-dir DIR] [--timings FILE] [--update-timings]";
  const fail = (message: string): never => {
    console.error(`test-seeded: ${message}\n${usage}`);
    process.exit(2);
  };
  let values: {
    seed?: string;
    shards?: string;
    "with-databases"?: boolean;
    "log-dir"?: string;
    timings?: string;
    "update-timings"?: boolean;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        seed: { type: "string" },
        shards: { type: "string" },
        "with-databases": { type: "boolean" },
        "log-dir": { type: "string" },
        timings: { type: "string" },
        "update-timings": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return fail((error as Error).message);
  }
  if (values.help) {
    console.log(usage);
    process.exit(0);
  }

  const shards =
    values.shards === undefined ? DEFAULT_SHARDS : Number(values.shards);
  if (!Number.isInteger(shards) || shards < 1)
    fail(
      `--shards must be a whole number of at least 1, got ${JSON.stringify(values.shards)}`,
    );

  const seedGiven = values.seed !== undefined;
  const seed = seedGiven
    ? Number(values.seed)
    : crypto.getRandomValues(new Uint32Array(1))[0];
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED)
    fail(
      `--seed must be a whole number from 0 to ${MAX_SEED}, got ${JSON.stringify(values.seed)}`,
    );

  const logDir =
    values["log-dir"] === undefined
      ? defaultLogDir(seed)
      : resolve(values["log-dir"]);
  mkdirSync(logDir, { recursive: true });

  return {
    seed,
    seedGiven,
    shards,
    withDatabases: values["with-databases"] === true,
    logDir,
    timings: resolve(ROOT, values.timings ?? DEFAULT_TIMINGS),
    updateTimings: values["update-timings"] === true,
  };
}

/** Runs one shard to completion, its output into `log`. */
async function runShard(
  index: number,
  files: string[],
  options: CliOptions,
  env: Record<string, string>,
  children: Set<Subprocess>,
): Promise<ShardResult> {
  const log = join(options.logDir, `shard-${index}.log`);
  const timings = join(options.logDir, `shard-${index}.timings.json`);
  const extra: string[] = [];
  if (options.updateTimings) {
    // Started empty: bun reads a timings file before it writes one back.
    writeFileSync(timings, `${JSON.stringify({ version: 1, files: {} })}\n`);
    extra.push(`--timings=${timings}`, "--update-timings");
  }
  const fd = openSync(log, "w");
  const started = performance.now();
  const child = Bun.spawn({
    cmd: [process.execPath, ...shardArgs(files, options.seed), ...extra],
    cwd: ROOT,
    // Explicit: without `env`, Bun.spawn passes the environment the process
    // started with, so deleting from `process.env` would not reach the shard.
    env,
    stdin: "ignore",
    // Its own process group, so a signal reaches what the tests spawned too
    // (a shard killed alone leaves its children running, orphaned).
    detached: true,
    stdout: fd,
    stderr: fd,
  });
  children.add(child);
  const exitCode = await child.exited;
  children.delete(child);
  closeSync(fd);
  const ms = performance.now() - started;

  const counts = parseCounts(readFileSync(log, "utf8"));
  let problem: string | undefined;
  if (child.signalCode) problem = `killed by ${child.signalCode}`;
  else if (counts.files === undefined)
    problem = `crashed (exit ${exitCode}, no summary)`;
  else if (counts.fail > 0) problem = `${counts.fail} failed`;
  else if (exitCode !== 0) problem = `exit ${exitCode}`;
  else if (counts.files !== files.length)
    problem = `ran ${counts.files} files, expected ${files.length}`;

  return {
    index,
    files,
    log,
    timings,
    exitCode,
    signal: child.signalCode ?? null,
    ms,
    counts,
    problem,
  };
}

/**
 * A copy of the live `process.env`, for a child's explicit `env`: without one,
 * Bun.spawn passes the environment the process started with.
 */
function liveEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Sends `signal` to a shard's whole process group — it was spawned detached,
 * so it leads one — and to the shard alone if that fails.
 */
function signalGroup(child: Subprocess, signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/**
 * Whether any process is left in a shard's group. The leader can exit while a
 * test's child that handles or ignores the signal (a worker's graceful close
 * on SIGTERM) lives on in the group, so the leader alone is not the answer.
 */
function groupAlive(child: Subprocess): boolean {
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The CLI: type-check, partition, run every shard at once, summarise. */
async function main(): Promise<number> {
  const options = parseCli(process.argv.slice(2));
  console.log(
    `test-seeded: seed ${options.seed}${options.seedGiven ? "" : " (picked; pass --seed to reproduce)"}`,
  );

  // Type-check once, before any shard starts, rather than per shard: a type
  // error would fail every shard the same way, after minutes instead of a
  // second (about 0.6 s on this package). A bare `bun --check` in the
  // package, never `bun check`, which runs the package's `check` script; and
  // without the variables that switch it to its tagged format for agents.
  const checkStarted = performance.now();
  const check = Bun.spawnSync({
    cmd: [process.execPath, "--check"],
    cwd: ROOT,
    env: Object.fromEntries(
      Object.entries(liveEnvironment()).filter(
        ([name]) => !["AGENT", "CLAUDECODE", "REPL_ID"].includes(name),
      ),
    ),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (check.exitCode !== 0) {
    process.stdout.write(check.stdout);
    process.stderr.write(check.stderr);
    console.error(
      `test-seeded: \`bun --check\` failed (exit ${check.exitCode}); no shard was started`,
    );
    return 1;
  }
  console.log(
    `test-seeded: types checked in ${Math.round(performance.now() - checkStarted)}ms (bun --check)`,
  );

  const files = discoverTestFiles(ROOT);
  if (files.length === 0) {
    console.error(`test-seeded: no test files under ${ROOT}`);
    return 1;
  }
  const weights = readTimings(options.timings);
  const shards = partitionFiles(files, options.seed, options.shards, weights);

  const liveEnv = liveEnvironment();
  const env = options.withDatabases ? liveEnv : withoutDatabaseUrls(liveEnv);
  const stripped = Object.keys(liveEnv).filter((key) =>
    DATABASE_URL_PATTERN.test(key),
  );
  console.log(
    options.withDatabases
      ? `test-seeded: database URLs kept (${stripped.length ? stripped.join(", ") : "none set"})`
      : `test-seeded: database URLs removed (${stripped.length ? stripped.join(", ") : "none were set"}); the database suites skip`,
  );
  console.log(
    `test-seeded: ${files.length} files in ${shards.length} serial ${plural(shards.length, "shard")}; logs in ${options.logDir}`,
  );
  const timed = weights ? files.filter((file) => file in weights).length : 0;
  console.log(
    weights
      ? `test-seeded: balanced by ${relative(ROOT, options.timings) || options.timings} (${timed} of ${files.length} files timed)`
      : `test-seeded: no usable timings in ${options.timings}; dealt round-robin`,
  );

  const children = new Set<Subprocess>();
  // Set by a signal: the shards it kills then end as failures, which the
  // handler reports and exits on, not the summary.
  let interrupted = false;
  /** Stops every shard's group on `signal`, then exits with its status. */
  const stopOn = async (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
    if (interrupted) return;
    interrupted = true;
    const stopping = [...children];
    for (const child of stopping) signalGroup(child, signal);
    // Wait up to 5 s for every GROUP to empty, not just its leader, then
    // SIGKILL whatever is left in it.
    const deadline = performance.now() + 5_000;
    while (stopping.some(groupAlive) && performance.now() < deadline)
      await Bun.sleep(100);
    for (const child of stopping)
      if (groupAlive(child)) signalGroup(child, "SIGKILL");
    await Promise.all(stopping.map((child) => child.exited));
    console.error(
      `test-seeded: ${signal}; stopped ${stopping.length} shard(s). Logs in ${options.logDir}`,
    );
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    // An emitter ignores what a listener returns; `void` says so.
    process.on(signal, () => void stopOn(signal));
  }

  const started = performance.now();
  const running = new Set(shards.map((_, index) => index + 1));
  const heartbeat = setInterval(() => {
    console.log(
      `test-seeded: ${duration(performance.now() - started)}, still running: shard ${[...running].join(", ")}`,
    );
  }, 60_000);
  const results = await Promise.all(
    shards.map(async (shardFiles, index) => {
      const result = await runShard(
        index + 1,
        shardFiles,
        options,
        env,
        children,
      );
      running.delete(result.index);
      if (interrupted) return result;
      const { pass, fail, skip } = result.counts;
      console.log(
        `test-seeded: shard ${result.index}/${shards.length} ${result.problem ? "FAILED" : "passed"} in ${duration(result.ms)}: ${pass} pass, ${fail} fail, ${skip} skip${result.problem ? ` (${result.problem})` : ""}`,
      );
      return result;
    }),
  );
  clearInterval(heartbeat);
  // The signal handler exits once the shards are gone.
  if (interrupted) await new Promise<never>(() => {});

  const failed = results.filter((result) => result.problem !== undefined);
  const total = results.reduce(
    (sum, { counts }) => ({
      pass: sum.pass + counts.pass,
      fail: sum.fail + counts.fail,
      skip: sum.skip + counts.skip,
    }),
    { pass: 0, fail: 0, skip: 0 },
  );
  console.log(
    `\nseed ${options.seed}, ${shards.length} ${plural(shards.length, "shard")}, ${duration(performance.now() - started)} wall`,
  );
  console.log("shard  files  pass  fail  skip  wall     result");
  for (const result of results) {
    const { pass, fail, skip } = result.counts;
    console.log(
      `${String(result.index).padStart(5)}  ${String(result.files.length).padStart(5)}  ${String(pass).padStart(4)}  ${String(fail).padStart(4)}  ${String(skip).padStart(4)}  ${duration(result.ms).padEnd(7)}  ${result.problem ?? "ok"}`,
    );
  }
  console.log(
    `total  ${String(files.length).padStart(5)}  ${String(total.pass).padStart(4)}  ${String(total.fail).padStart(4)}  ${String(total.skip).padStart(4)}`,
  );

  const unset = [...new Set([...DATABASE_URL_NAMES, ...stripped])];
  const envPrefix = options.withDatabases
    ? ""
    : `env ${unset.map((key) => `-u ${key}`).join(" ")} `;
  for (const result of results) {
    console.log(
      `\nshard ${result.index} (${result.log}), serially, from packages/bun-jobs:`,
    );
    console.log(
      `  ${envPrefix}bun ${shardArgs(result.files, options.seed).join(" ")}`,
    );
  }

  if (options.updateTimings) {
    if (failed.length > 0) {
      console.log(
        `\ntest-seeded: ${options.timings} not updated: a shard failed`,
      );
    } else {
      const merged: Record<string, number> = {};
      for (const result of results)
        Object.assign(merged, readTimings(result.timings));
      const sorted = Object.fromEntries(
        Object.entries(merged).sort(([, a], [, b]) => b - a),
      );
      writeFileSync(
        options.timings,
        `${JSON.stringify({ version: 1, files: sorted }, null, 2)}\n`,
      );
      console.log(
        `\ntest-seeded: wrote ${Object.keys(sorted).length} files' durations to ${options.timings}`,
      );
    }
  }

  if (failed.length > 0) {
    for (const result of failed) {
      const tests = failedTests(readFileSync(result.log, "utf8"));
      console.log(`\nshard ${result.index}: ${result.problem}`);
      for (const name of tests.slice(0, 20)) console.log(`  (fail) ${name}`);
      if (tests.length > 20) console.log(`  … and ${tests.length - 20} more`);
    }
    console.log(
      `\ntest-seeded: ${failed.length} of ${shards.length} ${plural(shards.length, "shard")} failed (seed ${options.seed}); the logs and commands are above`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exit(await main());
