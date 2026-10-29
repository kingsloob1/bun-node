/* eslint-disable no-console -- a benchmark's output is its product */
import type { Backend, Measurement, Scenario } from "./types";
import process from "node:process";

/**
 * How a measured run gets a figure out of a child process; the shape of
 * bun-jobs' `bench/lib/harness.ts`.
 *
 * Every contender runs each scenario in its **own freshly spawned process**.
 * These libraries hold connection pools, reconnect loops and sweep timers, and
 * a memory cache holds whatever the previous scenario left in the heap:
 * measured side by side in one process, whoever ran first taxes whoever runs
 * next.
 */

/** The marker a child prints ahead of its one JSON result line. */
export const RESULT_MARKER = "@@bench-result@@";

/** Prints a child's measurements where the driver can find them. */
export function emit(measurements: Measurement[]): void {
  console.log(RESULT_MARKER + JSON.stringify(measurements));
}

/** Reads the measurements out of a child's stdout, or null when it printed none. */
export function parseResult(stdout: string): Measurement[] | null {
  const line = stdout
    .split("\n")
    .findLast((candidate) => candidate.startsWith(RESULT_MARKER));

  if (!line) return null;

  try {
    return JSON.parse(line.slice(RESULT_MARKER.length)) as Measurement[];
  } catch {
    return null;
  }
}

/** How a child process is invoked. */
export interface ChildRun {
  /** Absolute path of the entry script the child runs. */
  script: string;
  /** Arguments after the script path. */
  args: string[];
  /** Milliseconds before the child is killed and reported as timed out. */
  timeoutMs: number;
  /** Whether the child's own stderr is shown, for debugging a failing contender. */
  verbose: boolean;
}

/**
 * Runs one contender in its own process and returns what it measured.
 *
 * A child that crashes, hangs or prints nothing yields a `failed`
 * measurement rather than an absent row, so a contender can never drop out of
 * the table quietly.
 */
export async function runChild(
  run: ChildRun,
  identity: { contender: string; scenario: Scenario; backend: Backend },
): Promise<Measurement[]> {
  const failure = (failed: string): Measurement[] => [
    { ...identity, count: 0, elapsedMs: 0, failed },
  ];

  const proc = Bun.spawn([process.execPath, run.script, ...run.args], {
    stdout: "pipe",
    stderr: run.verbose ? "inherit" : "pipe",
    cwd: import.meta.dir,
    env: { ...process.env, BUN_CACHE_BENCH_CHILD: "1" },
  });

  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, run.timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      run.verbose ? Promise.resolve("") : new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (timedOut) {
      return failure(`timed out after ${Math.round(run.timeoutMs / 1000)}s`);
    }

    if (exitCode !== 0) {
      const tail = stderr.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
      return failure(`child exited ${exitCode}${tail ? ` — ${tail}` : ""}`);
    }

    return parseResult(stdout) ?? failure("child printed no result");
  } finally {
    clearTimeout(killer);
  }
}

/**
 * Builds a child's argument list from named flags.
 *
 * Written as a record rather than a flat array because a formatter is free to
 * break a flat array between a flag and its value, and the pairing is the only
 * thing that makes the list readable.
 */
export function childArgs(flags: Record<string, string>): string[] {
  return Object.entries(flags).flatMap(([flag, value]) => [`--${flag}`, value]);
}

/** The wall clock in ms, comparable across processes on one host (`performance.now()` is per process). */
export function sharedNow(): number {
  return performance.timeOrigin + performance.now();
}

/** Resolves on the next turn of the event loop, so socket events (a bus message) get their turn. */
export function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
