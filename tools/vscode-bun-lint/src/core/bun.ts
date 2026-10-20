/**
 * Running `bun lint` and `bun fmt`: the arguments, the environment, the
 * version floor and the child process. Nothing here imports `vscode`, so the
 * tests drive it directly; the extension host runs it under Node, so it uses
 * `node:child_process`, not `Bun.spawn`.
 */
import { spawn } from "node:child_process";
import process from "node:process";

/**
 * The first Bun with `bun lint` and `bun fmt` (the repo's development floor,
 * `MIN_BUN` in `scripts/typecheck.ts`). Every 1.4.4 canary reports "1.4.4".
 */
export const MIN_BUN = "1.4.4";

/**
 * Variables that switch Bun's output to a tagged format meant for AI agents.
 * A bare `bun lint` ignores `--no-pretty`-style flags under them, so they are
 * removed from the child's environment rather than countered with a flag.
 */
export const AGENT_ENV_KEYS = ["AGENT", "CLAUDECODE", "REPL_ID"] as const;

/** An environment, as `process.env` holds it. */
export type Env = Record<string, string | undefined>;

/**
 * The environment for a `bun` child: the extension host's, without
 * `AGENT_ENV_KEYS`.
 * @param env The environment to start from (default: this process's).
 * @returns A copy without the agent variables.
 */
export function childEnv(env: Env = process.env): Env {
  const out: Env = { ...env };
  for (const key of AGENT_ENV_KEYS) delete out[key];
  return out;
}

/**
 * Arguments for linting a buffer sent on standard input.
 *
 * `filePath` must be absolute: in a directory whose `package.json` has a
 * `lint` script, `bun lint` runs that script (Bun's "your script wins"), from
 * the `package.json`'s directory, so a relative name would be resolved from
 * there rather than from the working directory we chose (measured: `zz.ts`
 * sent from `lib/` came back as `packages/bun-common/zz.ts`).
 * @param filePath The file the buffer belongs to, absolute.
 * @returns The arguments after `bun`.
 */
export function lintArgs(filePath: string): string[] {
  return [
    "lint",
    "--stdin",
    "--stdin-filename",
    filePath,
    "-f",
    "json",
    // An ignored file reports nothing, rather than a "File ignored" warning.
    "--no-warn-ignored",
    "--no-color",
  ];
}

/** A range of a buffer, as UTF-16 offsets (what `bun fmt --range-*` takes, measured). */
export interface OffsetRange {
  /** Offset of the first character. */
  start: number;
  /** Offset just past the last character. */
  end: number;
}

/**
 * Arguments for formatting a buffer sent on standard input.
 * @param filePath The file the buffer belongs to, absolute (it picks the language and the config).
 * @param range Only the statements this range touches, for Format Selection.
 * @returns The arguments after `bun`.
 */
export function formatArgs(filePath: string, range?: OffsetRange): string[] {
  const args = ["fmt", "--stdin-filepath", filePath];
  if (range)
    args.push(
      "--range-start",
      String(range.start),
      "--range-end",
      String(range.end),
    );
  return args;
}

/**
 * Arguments for a rule's documentation page.
 * @param rule The rule id, as a report names it.
 * @returns The arguments after `bun`.
 */
export function explainArgs(rule: string): string[] {
  return ["lint", `--explain=${rule}`, "--no-color"];
}

/** What a finished `bun` child left behind. */
export interface RunResult {
  /** The exit code, or `null` when a signal ended it. */
  code: number | null;
  /** Everything it wrote to standard output. */
  stdout: string;
  /** Everything it wrote to standard error. */
  stderr: string;
  /** Whether it was stopped: aborted by the caller or past its timeout. */
  killed: boolean;
}

/** How to run one `bun` child. */
export interface RunOptions {
  /** The working directory. */
  cwd: string;
  /** Text for standard input; omitted, standard input is closed at once. */
  input?: string;
  /** The child's environment (default: `childEnv()`). */
  env?: Env;
  /** Kill the child after this many milliseconds (default 30 000). */
  timeoutMs?: number;
  /** Kill the child when this aborts: a newer run replaced it. */
  signal?: AbortSignal;
}

/** The binary could not be started at all (not found, not executable). */
export class BunNotFoundError extends Error {
  /**
   * @param bunPath The binary that was asked for.
   * @param cause The spawn error.
   */
  constructor(
    /** The binary that was asked for. */
    readonly bunPath: string,
    cause: unknown,
  ) {
    super(
      `Could not run "${bunPath}": ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "BunNotFoundError";
  }
}

/**
 * Runs `bun` once and collects its output. Never rejects for a non-zero exit
 * (`bun lint` exits 1 whenever it finds an error); rejects only when the
 * binary cannot be started.
 * @param bunPath The binary.
 * @param args The arguments after it.
 * @param options Where and how.
 * @returns The exit code and both streams.
 */
export function runBun(
  bunPath: string,
  args: string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bunPath, args, {
      cwd: options.cwd,
      env: options.env ?? childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const stop = () => {
      killed = true;
      child.kill("SIGTERM");
    };
    const timer = setTimeout(stop, options.timeoutMs ?? 30_000);
    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new BunNotFoundError(bunPath, error));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      resolve({ code, stdout, stderr, killed });
    });
    // A child that exits before reading its input closes the pipe; that is
    // its answer (an error on stderr), not ours.
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
}

/**
 * The first `x.y.z` in a `bun --version` line.
 * @param text The output.
 * @returns The version, or `undefined` when there is none.
 */
export function parseVersion(text: string): string | undefined {
  return /\d+\.\d+\.\d+/.exec(text)?.[0];
}

/**
 * Compares two `x.y.z` versions numerically.
 * @param a One version.
 * @param b The other.
 * @returns Negative when `a` is older, 0 when equal, positive when newer.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The outcome of checking the binary against the floor. */
export type BunCheck =
  | {
      /** The binary is usable. */
      ok: true;
      /** Its version. */
      version: string;
    }
  | {
      /** The binary is not usable. */
      ok: false;
      /** Why, in a sentence for a notification. */
      reason: string;
    };

/**
 * Checks that `bunPath` runs and is at least `MIN_BUN`. It matters before the
 * first `bun lint`: on 1.4.3, `bun lint` in a directory whose `lint` script is
 * `bun lint` runs that script again, forever, and elsewhere it fails with
 * `Script not found "lint"`.
 * @param bunPath The binary.
 * @param cwd Where to run it.
 * @returns Whether it is usable, and its version or the reason.
 */
export async function checkBun(
  bunPath: string,
  cwd: string,
): Promise<BunCheck> {
  let result: RunResult;
  try {
    result = await runBun(bunPath, ["--version"], { cwd, timeoutMs: 10_000 });
  } catch (error) {
    return {
      ok: false,
      reason: `${error instanceof Error ? error.message : String(error)}. Set "bunLint.bunPath" to Bun ${MIN_BUN} or later.`,
    };
  }
  const version = parseVersion(result.stdout);
  if (result.code !== 0 || version === undefined)
    return {
      ok: false,
      reason: `"${bunPath} --version" did not print a version (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`,
    };
  if (compareVersions(version, MIN_BUN) < 0)
    return {
      ok: false,
      reason: `Bun ${version} has no "bun lint" or "bun fmt"; they need Bun ${MIN_BUN} or later. Run "bun upgrade --canary" (until 1.4.4 is stable), or set "bunLint.bunPath".`,
    };
  return { ok: true, version };
}
