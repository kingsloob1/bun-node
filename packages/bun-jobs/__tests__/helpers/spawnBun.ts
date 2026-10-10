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
  /**
   * Resolves `true` once its stdout so far contains `text`, or `false` if
   * stdout ends without it. For a test that must not act on the process —
   * signal it, above all — before it has reached a line it prints: how long
   * a `bun` process takes to get there is not a constant (0.4-0.7 s idle,
   * past 1.5 s in a loaded 16-worker run).
   */
  printed: (text: string) => Promise<boolean>;
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

  // Read as it arrives, so `printed` can answer before the process ends.
  let text = "";
  let ended = false;
  const watchers = new Set<{
    wanted: string;
    resolve: (found: boolean) => void;
  }>();
  const settle = (): void => {
    for (const watcher of watchers) {
      if (text.includes(watcher.wanted) || ended) {
        watchers.delete(watcher);
        watcher.resolve(text.includes(watcher.wanted));
      }
    }
  };
  const output = (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of proc.stdout) {
        text += decoder.decode(chunk, { stream: true });
        settle();
      }
      text += decoder.decode();
    } finally {
      ended = true;
      settle();
    }
    return text;
  })();

  const printed = async (wanted: string): Promise<boolean> =>
    await new Promise<boolean>((resolve) => {
      watchers.add({ wanted, resolve });
      settle();
    });

  return {
    proc,
    output,
    printed,
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
