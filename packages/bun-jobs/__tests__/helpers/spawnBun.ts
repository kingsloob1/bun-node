import type { Subprocess } from "bun";
import process from "node:process";

/**
 * Runs a script in a real, separate `bun` process.
 *
 * Cross-process guarantees cannot be tested from one process: two driver
 * instances in the same runtime still share a heap, an event loop and a set
 * of timers. These helpers spawn genuine processes so the only thing the
 * participants share is the backend.
 */

/** A spawned test process and its collected output. */
export interface SpawnedProcess {
  /** The subprocess handle. */
  proc: Subprocess<"ignore", "pipe", "pipe">;
  /** Resolves with everything it wrote to stdout. */
  output: Promise<string>;
  /** Resolves with everything it wrote to stderr. */
  errors: Promise<string>;
  /** Resolves with its exit code. */
  exited: Promise<number>;
}

/** Starts `script` with `env` merged over the current environment. */
export function spawnBun(
  script: string,
  env: Record<string, string>,
  args: string[] = [],
): SpawnedProcess {
  const proc = Bun.spawn([process.execPath, script, ...args], {
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    proc,
    output: new Response(proc.stdout).text(),
    errors: new Response(proc.stderr).text(),
    exited: proc.exited,
  };
}

/**
 * Runs a script to completion and parses the JSON lines it printed.
 *
 * A test process reports through stdout rather than a shared file, so a
 * failure shows what the process actually thought happened.
 */
export async function runBun<T = unknown>(
  script: string,
  env: Record<string, string>,
  args: string[] = [],
): Promise<{ lines: T[]; exitCode: number; stderr: string }> {
  const spawned = spawnBun(script, env, args);
  const [stdout, stderr, exitCode] = await Promise.all([
    spawned.output,
    spawned.errors,
    spawned.exited,
  ]);

  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") || line.startsWith("["))
    .map((line) => JSON.parse(line) as T);

  return { lines, exitCode, stderr };
}
