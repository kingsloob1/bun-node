import type { Subprocess } from "bun";
import process from "node:process";
import { textRedactor } from "../redact";

/**
 * The handoff's spawning half: starts a worker script as a real, separate
 * `bun` process, the way a platform starts a unit — with the request's
 * `argv` as its arguments. Internal: the conformance kit's handoff check
 * starts its fixture worker (`worker.ts`) through it, and the package's own
 * summon tests start theirs.
 *
 * The environment is given explicitly, merged over this process's live
 * `process.env`: `Bun.spawn` with no `env` hands a child the environment
 * this process *started* with, whatever has changed since.
 */

/** One started process and its collected output. */
export interface SpawnedUnit {
  /** The subprocess handle. */
  proc: Subprocess<"ignore", "pipe", "pipe">;
  /** Resolves with everything it wrote to stdout. */
  output: Promise<string>;
  /** Resolves with everything it wrote to stderr. */
  errors: Promise<string>;
  /** Resolves with its exit code. */
  exited: Promise<number>;
}

/** Starts `script` under this `bun`, with `env` merged over the current environment and `args` after it. */
export function spawnUnit(
  /** The script to run. */
  script: string,
  /** Extra environment: test control only, never summon identity. */
  env: Readonly<Record<string, string>>,
  /** Its arguments: the request's `argv`, for a platform that passes them. */
  args: readonly string[] = [],
): SpawnedUnit {
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

/** The JSON lines a spawned worker printed. */
export async function unitLines(
  /** The process. */
  unit: SpawnedUnit,
): Promise<Record<string, unknown>[]> {
  return (await unit.output)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

/** Everything a spawner started, and how to wait for or stop it. */
export interface UnitSpawner {
  /** Every process started so far, in order. */
  readonly spawned: SpawnedUnit[];
  /**
   * Starts one process now, or after `delayMs`: `script` with `env` merged
   * over the spawner's and `argv` as its arguments.
   */
  start: (
    unit: {
      /** Its arguments. */
      argv: readonly string[];
      /** Extra environment for this one. */
      env?: Readonly<Record<string, string>>;
    },
    delayMs?: number,
  ) => Promise<SpawnedUnit>;
  /** Resolves once every process started so far (and any still delayed) has exited. */
  settled: () => Promise<void>;
  /** Sends every process `signal` (default `SIGKILL`) and waits for them. */
  kill: (signal?: NodeJS.Signals) => Promise<void>;
}

/** A spawner of `script`, each process given `env` (test control) plus its own. */
export function unitSpawner(
  /** The worker script. */
  script: string,
  /** Environment every process gets. */
  env: Readonly<Record<string, string>> = {},
): UnitSpawner {
  const spawned: SpawnedUnit[] = [];
  const starting: Promise<unknown>[] = [];
  return {
    spawned,
    start: async (unit, delayMs = 0) => {
      const started = (async () => {
        if (delayMs > 0) {
          await Bun.sleep(delayMs);
        }
        const one = spawnUnit(script, { ...env, ...unit.env }, unit.argv);
        spawned.push(one);
        return one;
      })();
      starting.push(started);
      return await started;
    },
    settled: async () => {
      await Promise.all(starting);
      await Promise.all(spawned.map(async (one) => await one.exited));
    },
    kill: async (signal = "SIGKILL") => {
      await Promise.all(starting);
      for (const one of spawned) {
        one.proc.kill(signal);
      }
      await Promise.all(spawned.map(async (one) => await one.exited));
    },
  };
}

/**
 * How long a kit script (the fixture worker, a racer) may run at most, in
 * ms: past the handoff's own budget (30 s to register, 30 s to drain).
 */
export const SCRIPT_CAP_MS = 120_000;

/**
 * An error and its chain of causes, on one line: `DriverError: … (cause:
 * Error: Too many connections)`. At most four deep.
 */
export function describeFailure(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined; depth++) {
    parts.push(String(current));
    current =
      current instanceof Error && "cause" in current
        ? current.cause
        : undefined;
  }
  return parts.join(" (cause: ") + ")".repeat(parts.length - 1);
}

/**
 * Runs a script's `main` and exits 1, with the error on stderr, if it
 * rejects. A timer holds the process open until `main` settles: on Bun
 * 1.4.3, a MySQL or MariaDB query issued after a transaction has committed
 * does not keep the event loop alive, so a script not held open by a
 * top-level `await` exits 0 in the middle of it (the driver's `purge`,
 * `ensureQueue` and the controller's checks all run one). Remove the timer
 * once Bun fixes it: https://github.com/oven-sh/bun/issues/27102 (our
 * reproduction on 1.4.3: #issuecomment-5886217119). A hard cap
 * (`capMs`) ends a `main` that hangs.
 */
export function runScript(
  /** The script's body. It exits the process itself when it is done. */
  main: () => Promise<unknown>,
  /**
   * The longest `main` may run, in ms, before the script exits 1 with a
   * message: a hung script ends here rather than at the kit's `SIGKILL`.
   * Defaults to {@link SCRIPT_CAP_MS}.
   */
  capMs: number = SCRIPT_CAP_MS,
): void {
  const open = setInterval(() => {}, 1 << 30);
  const cap = setTimeout(() => {
    process.stderr.write(
      `the conformance kit's script did not finish within ${capMs}ms; exiting\n`,
    );
    process.exit(1);
  }, capMs);
  // The cap alone never keeps the process alive; the interval above does.
  cap.unref();
  main()
    .catch((error: unknown) => {
      // The cause on the same line: the kit reports a script's last lines,
      // and a driver's "failed during migrate" says nothing without it.
      process.stderr.write(`${textRedactor([])(describeFailure(error))}\n`);
      process.exit(1);
    })
    .finally(() => {
      clearInterval(open);
      clearTimeout(cap);
    });
}
