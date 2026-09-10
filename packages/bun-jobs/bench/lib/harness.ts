/* eslint-disable no-console -- a benchmark's output is its product */
import type { Measurement } from "./types";
import process from "node:process";

/**
 * The machinery both benchmark entry points share: how a measured run is
 * timed, and how the driver process gets a figure out of a child.
 *
 * Every contender is measured in its **own freshly spawned process**. That is
 * not caution about JIT shapes, it is about the libraries themselves: each one
 * holds connection pools, polling timers and background reconnect loops, and
 * several of them keep those running after `close()`. Measured side by side in
 * one process, whoever ran first taxes whoever runs next.
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

/** How a child process is invoked and what to do with what it prints. */
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
 * A child that crashes, hangs or prints nothing yields a `failed` measurement
 * rather than an absent row, so a contender can never drop out of the table
 * quietly.
 */
export async function runChild(
  run: ChildRun,
  identity: {
    contender: string;
    scenario: string;
    backend: Measurement["backend"];
  },
): Promise<Measurement[]> {
  const failure = (failed: string): Measurement[] => [
    { ...identity, count: 0, elapsedMs: 0, failed },
  ];

  const proc = Bun.spawn([process.execPath, run.script, ...run.args], {
    stdout: "pipe",
    stderr: run.verbose ? "inherit" : "pipe",
    cwd: import.meta.dir,
    env: { ...process.env, BUN_JOBS_BENCH_CHILD: "1" },
  });

  const killer = setTimeout(() => {
    proc.kill("SIGKILL");
  }, run.timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      run.verbose ? Promise.resolve("") : new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      const tail = stderr.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
      return failure(`child exited ${exitCode}${tail ? ` — ${tail}` : ""}`);
    }

    return parseResult(stdout) ?? failure("child printed no result");
  } finally {
    clearTimeout(killer);
  }
}

/** Resolves once `predicate` holds, or rejects when the budget runs out. */
export async function waitFor(
  predicate: () => boolean,
  options: { timeoutMs: number; message: string; intervalMs?: number },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  const interval = options.intervalMs ?? 2;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`${options.message} (waited ${options.timeoutMs}ms)`);
    }
    await Bun.sleep(interval);
  }
}

/** A promise with its settle functions exposed, for bridging callback APIs. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Filler of an exact byte length, for the payload-size scenario. */
export function padding(bytes: number): string | undefined {
  return bytes > 0 ? "x".repeat(bytes) : undefined;
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
