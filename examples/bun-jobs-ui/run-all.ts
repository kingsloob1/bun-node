#!/usr/bin/env bun
/**
 * Runs every example — a couple at a time — and reports which passed.
 *
 * ```bash
 * bun run-all.ts          # every example, 2 at a time
 * bun run-all.ts 02 10    # only folders starting 02 or 10
 * bun run-all.ts --jobs 4 # 4 at a time (EXAMPLE_JOBS=4 is the same)
 * bun run-all.ts --serial # one at a time (EXAMPLE_JOBS=1 is the same)
 * ```
 *
 * An example passes when it exits 0. An example that needs something this
 * machine lacks skips itself (printing a line starting `skipped:`) and still
 * exits 0. Output is shown only for failures, so a green run is one screen:
 * each example's output is buffered and printed whole when it finishes, so a
 * pool never interleaves two examples' lines.
 *
 * A run of fewer than `MIN_POOLED_FILES` examples goes one at a time instead:
 * that little has nothing to overlap, and folder order reads better. Naming
 * `--jobs`/`EXAMPLE_JOBS` overrides it.
 */
import { relative } from "node:path";
import process from "node:process";

/**
 * How many examples run at once when neither `--jobs` nor `EXAMPLE_JOBS` says
 * otherwise. Two, not the four the other example packages use: most of these
 * examples drive a headless Chrome of their own, and a browser is heavy enough
 * — a process tree and a few hundred MB each — that four at a time leave them
 * fighting over the machine while they wait on page loads.
 */
const DEFAULT_JOBS = 2;

/**
 * Examples that get the machine to themselves, run one after another once the
 * pool has drained.
 *
 * Some examples measure timing — poll cadences, lock expiry, process startup —
 * rather than only behaviour, so a starved one reads as broken. None here has
 * needed that yet; an example that flakes under the pool and passes alone
 * belongs on this list. Keep it short and each entry earned — it is not a
 * place to park a flake whose real cause is a bug.
 */
const RUN_ALONE: string[] = [];

/**
 * Pooled examples known to take a while, started first so the pool is not left
 * waiting on one straggler at the end. Everything else follows in folder
 * order. Rough figures only: a stale entry costs a few seconds, never a
 * failure.
 */
const SLOW_FIRST = [
  "06-browser/runner-and-job-tools.ts",
  "06-browser/workers.ts",
  "06-browser/api-docs.ts",
  "06-browser/live-events.ts",
];

const args = process.argv.slice(2);

/** Folders to run, from the command line; every numbered folder when empty. */
const only: string[] = [];

/** How many examples to run at once; 1 is the old one-at-a-time behaviour. */
let jobs = Number(process.env.EXAMPLE_JOBS ?? DEFAULT_JOBS);

/**
 * Whether the width above was asked for rather than defaulted. An explicit
 * `--jobs`/`EXAMPLE_JOBS` wins over the small-run fallback below: someone who
 * names a width means it.
 */
let widthWasAsked = process.env.EXAMPLE_JOBS !== undefined;

for (let index = 0; index < args.length; index++) {
  const arg = args[index]!;
  if (arg === "--serial") {
    jobs = 1;
    widthWasAsked = true;
  } else if (arg === "--jobs" || arg === "-j") {
    jobs = Number(args[++index]);
    widthWasAsked = true;
  } else if (arg.startsWith("--jobs=")) {
    jobs = Number(arg.slice("--jobs=".length));
    widthWasAsked = true;
  } else {
    only.push(arg);
  }
}

if (!Number.isInteger(jobs) || jobs < 1) {
  console.error(`run-all: --jobs takes a positive integer, not ${jobs}`);
  process.exit(2);
}

const root = import.meta.dir;
const everything = [
  ...new Bun.Glob("[0-9][0-9]-*/**/*.ts").scanSync({ cwd: root }),
]
  // Files run *by* examples — helpers, fixtures — not on their own.
  .filter((file) => !/\/(?:handlers|helpers|fixtures|modules)\//.test(file))
  .sort();

// A renamed example would drop out of the lists above unnoticed, and start
// racing the pool again. Say so instead.
const stale = [...RUN_ALONE, ...SLOW_FIRST].filter(
  (file) => !everything.includes(file),
);
if (stale.length > 0) {
  console.error(`run-all: no such example: ${stale.join(", ")}`);
  process.exit(2);
}

const files = everything.filter(
  (file) => only.length === 0 || only.some((prefix) => file.startsWith(prefix)),
);

/** Where the slowest known example sorts; everything unlisted sorts after it. */
const rank = (file: string): number =>
  SLOW_FIRST.includes(file) ? SLOW_FIRST.indexOf(file) : SLOW_FIRST.length;

/**
 * Below this many examples a pool cannot pay for itself: at four wide there is
 * barely anything to overlap, and the run is a few seconds either way, so the
 * plain folder-ordered walk is the more useful output. A prefix run like
 * `bun run-all.ts 01` is the usual case. Naming a width overrides it.
 *
 * It is deliberately only a *count*: "this package has no slow examples" is not
 * a reason to go serial. Measured on bun-nest, 16 sub-second examples, all three
 * back to back under one machine load: the old one-at-a-time runner 6.5 s, this
 * runner serial 6.8 s, this runner at four wide 2.8 s.
 */
const MIN_POOLED_FILES = 8;

// `--serial` is exactly the old behaviour: every example, in folder order,
// with nothing else running — so nothing is held back and nothing is reordered.
// A run too small to be worth a pool takes the same path, unless a width was
// asked for explicitly.
const serial =
  jobs === 1 || (!widthWasAsked && files.length < MIN_POOLED_FILES);
const alone = serial ? [] : files.filter((file) => RUN_ALONE.includes(file));
const pooled = serial
  ? files
  : files
      .filter((file) => !alone.includes(file))
      .sort((a, b) => rank(a) - rank(b));

let failed = 0;
let skipped = 0;

/** What running one example produced: its exit code, its output and its time. */
interface Outcome {
  /** The example's path, relative to this folder. */
  file: string;
  /** The process's exit code; 0 is a pass. */
  exitCode: number;
  /** Everything it wrote to stdout, followed by everything it wrote to stderr. */
  output: string;
  /** Wall-clock seconds it took, formatted for the report line. */
  elapsed: string;
}

/**
 * Runs one example to completion, capturing its output instead of letting it
 * share ours — with a pool, interleaved output would be unreadable.
 */
async function runExample(file: string): Promise<Outcome> {
  const started = performance.now();
  const child = Bun.spawn({
    cmd: [process.execPath, file],
    cwd: root,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 300_000,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return {
    file,
    exitCode,
    output: `${stdout}${stderr}`,
    elapsed: `${((performance.now() - started) / 1000).toFixed(1)}s`,
  };
}

/** Prints one example's verdict line, and its output only when it failed. */
function report({ file, exitCode, output, elapsed }: Outcome): void {
  const name = relative(root, `${root}/${file}`).padEnd(52);

  if (exitCode === 0 && output.startsWith("skipped:")) {
    skipped++;
    console.log(`  skip  ${name} ${output.split("\n")[0]}`);
  } else if (exitCode === 0) {
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

/** Runs a list `limit` at a time, reporting each example as it finishes. */
async function runAll(list: string[], limit: number): Promise<void> {
  const queue = [...list];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        report(await runExample(file));
      }
    }),
  );
}

await runAll(pooled, serial ? 1 : jobs);
await runAll(alone, 1);

console.log(
  `\n${files.length} examples: ${files.length - failed - skipped} passed, ${skipped} skipped, ${failed} failed`,
);
process.exit(failed === 0 ? 0 : 1);
