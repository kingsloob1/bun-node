/**
 * The three things the extension asks of Bun, each as one call: lint a
 * buffer, format a buffer (or a range of it), explain a rule. The 11-directory
 * test drives these against the real `bun`, so it exercises what the editor
 * runs, not a copy of it.
 */
import type { OffsetRange } from "./bun";
import type { OffsetEdit } from "./edits";
import type { Problem } from "./report";
import { explainArgs, formatArgs, lintArgs, runBun } from "./bun";
import { workingDirectory } from "./config";
import { minimalEdit } from "./edits";
import { parseLintReport, resultFor, toProblems } from "./report";

/** A run was replaced by a newer one, or timed out; its result is dropped. */
export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

/** `bun fmt` refused the buffer (a syntax error, an unsupported language). */
export class FormatError extends Error {
  /**
   * @param message `bun fmt`'s standard error.
   * @param code Its exit code.
   */
  constructor(
    message: string,
    /** `bun fmt`'s exit code. */
    readonly code: number | null,
  ) {
    super(message);
    this.name = "FormatError";
  }
}

/** Common options of every call. */
export interface CallOptions {
  /** The `bun` binary. */
  bunPath: string;
  /** Aborts the child: a newer run replaced this one. */
  signal?: AbortSignal;
  /** Kill the child after this many milliseconds. */
  timeoutMs?: number;
}

/**
 * Lints a buffer as the file it belongs to, from the file's directory.
 * @param filePath The file, absolute.
 * @param text The buffer, which may differ from the file on disk.
 * @param options The binary and the cancellation.
 * @returns The problems, in report order.
 */
export async function lintText(
  filePath: string,
  text: string,
  options: CallOptions,
): Promise<Problem[]> {
  // In a package whose `package.json` has a `lint` script, `bun lint` runs
  // that script with these arguments appended, from the package directory:
  // this relies on the script being exactly `bun lint` (all eleven are). A
  // composite one surfaces as a ReportError naming it (SCRIPT_HINT).
  const result = await runBun(options.bunPath, lintArgs(filePath), {
    cwd: workingDirectory(filePath),
    input: text,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  if (result.killed) throw new CancelledError();
  return toProblems(
    resultFor(parseLintReport(result.stdout, result.stderr), filePath),
  );
}

/**
 * Formats a buffer as the file it belongs to.
 * @param filePath The file, absolute.
 * @param text The buffer.
 * @param options The binary, the cancellation and, for Format Selection, the range.
 * @returns The one edit to apply, or `undefined` when it is already formatted.
 */
export async function formatText(
  filePath: string,
  text: string,
  options: CallOptions & {
    /** Only the statements this range touches. */
    range?: OffsetRange;
  },
): Promise<OffsetEdit | undefined> {
  const result = await runBun(
    options.bunPath,
    formatArgs(filePath, options.range),
    {
      cwd: workingDirectory(filePath),
      input: text,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    },
  );
  if (result.killed) throw new CancelledError();
  if (result.code !== 0)
    throw new FormatError(
      result.stderr.trim() || `bun fmt exited ${result.code}`,
      result.code,
    );
  return minimalEdit(text, result.stdout);
}

/**
 * A rule's documentation, as `bun lint --explain` prints it.
 * @param rule The rule id.
 * @param cwd Where to run (any directory; the page does not depend on the config).
 * @param options The binary.
 * @returns The page, or Bun's error when it knows no such rule.
 */
export async function explainRule(
  rule: string,
  cwd: string,
  options: CallOptions,
): Promise<string> {
  const result = await runBun(options.bunPath, explainArgs(rule), {
    cwd,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  return result.code === 0
    ? result.stdout
    : result.stderr.trim() || result.stdout;
}
