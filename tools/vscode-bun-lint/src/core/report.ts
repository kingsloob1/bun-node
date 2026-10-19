/**
 * Reading `bun lint -f json` (ESLint's JSON formatter, which Bun reproduces)
 * into editor-neutral problems: zero-based positions, a severity, the rule,
 * and the fix and suggestions as offset edits. The extension turns these into
 * `vscode.Diagnostic`s and code actions; the tests compare them directly.
 */
import { resolve } from "node:path";

/** One replacement in the linted text, by UTF-16 offsets (measured: Bun's ranges count UTF-16 units, as ESLint's do). */
export interface Fix {
  /** `[start, end)` of the text to replace. */
  range: [number, number];
  /** The replacement. */
  text: string;
}

/** One suggestion: an optional fix the user picks by name. */
export interface Suggestion {
  /** What the suggestion does, in a sentence. */
  desc: string;
  /** Its edit. */
  fix: Fix;
}

/** One finding, as the JSON report has it. */
export interface LintMessage {
  /** The rule, or `null` for a parse error. */
  ruleId: string | null;
  /** 1 warning, 2 error. */
  severity: number;
  /** The finding. */
  message: string;
  /** Whether the file could not be parsed. */
  fatal?: boolean;
  /** 1-based line of the start (absent on some fatal messages). */
  line?: number;
  /** 1-based column of the start; Bun gives 0 on a parse error. */
  column?: number;
  /** 1-based line of the end, when the finding spans text. */
  endLine?: number;
  /** 1-based column just past the end. */
  endColumn?: number;
  /** The automatic fix, when the rule has one. */
  fix?: Fix;
  /** Optional fixes, each its own quick fix. */
  suggestions?: Suggestion[];
}

/** One file's report. */
export interface LintFileResult {
  /** The file, absolute. */
  filePath: string;
  /** Its findings. */
  messages: LintMessage[];
}

/**
 * What usually breaks the report: `bun lint` runs the nearest `package.json`'s
 * `lint` script when there is one, with our flags appended, so the extension
 * relies on that script being exactly `bun lint`. A composite script
 * (`bun lint && tsc`, `eslint .`) prints something else, or nothing.
 */
export const SCRIPT_HINT =
  'Is the nearest package.json\'s "lint" script exactly "bun lint"? The extension relies on it.';

/** The report was not the JSON array `-f json` prints. */
export class ReportError extends Error {
  /**
   * @param message What went wrong.
   * @param stderr What `bun` wrote to standard error, for the output channel.
   */
  constructor(
    message: string,
    /** What `bun` wrote to standard error. */
    readonly stderr: string,
  ) {
    super(message);
    this.name = "ReportError";
  }
}

/**
 * Parses `bun lint -f json` output. When `bun lint` runs a package's `lint`
 * script, standard error also carries the `$ bun lint …` echo and an
 * `error: script "lint" exited with code 1` line; only standard output counts.
 * @param stdout The child's standard output.
 * @param stderr Its standard error, kept for the error message.
 * @returns One result per file.
 */
export function parseLintReport(stdout: string, stderr = ""): LintFileResult[] {
  const text = stdout.trim();
  if (text === "") {
    const hint = /Script not found "lint"/.test(stderr)
      ? " This Bun has no `bun lint` (it needs 1.4.4 or later)."
      : ` ${SCRIPT_HINT}`;
    throw new ReportError(`bun lint printed no report.${hint}`, stderr);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReportError(
      `bun lint printed something other than a JSON report. ${SCRIPT_HINT} It printed: ${text.slice(0, 200)}`,
      stderr,
    );
  }
  if (!Array.isArray(parsed))
    throw new ReportError("bun lint's JSON report is not an array.", stderr);
  return parsed as LintFileResult[];
}

/**
 * The result for one file. A stdin run reports one file at most (none when the
 * file is ignored), named as given; it is matched by path, so a report for
 * another file is never shown on this one.
 * @param results The parsed report.
 * @param filePath The file asked about.
 * @returns Its result, or `undefined` (nothing to show).
 */
export function resultFor(
  results: LintFileResult[],
  filePath: string,
): LintFileResult | undefined {
  const want = resolve(filePath);
  return results.find((r) => resolve(r.filePath) === want);
}

/** A zero-based position: line, and UTF-16 character within it. */
export interface Position {
  /** Zero-based line. */
  line: number;
  /** Zero-based UTF-16 column. */
  character: number;
}

/** One problem to show, independent of the editor. */
export interface Problem {
  /** Where it starts. */
  start: Position;
  /** Where it ends; equal to `start` when the report gives no end. */
  end: Position;
  /** How bad. */
  severity: "error" | "warning";
  /** The finding. */
  message: string;
  /** The rule, or `undefined` for a parse error. */
  rule: string | undefined;
  /** The automatic fix, when there is one. */
  fix: Fix | undefined;
  /** Optional fixes. */
  suggestions: Suggestion[];
}

/**
 * Converts 1-based report coordinates to a zero-based position, clamping the
 * 0 column Bun gives a parse error.
 * @param line 1-based line.
 * @param column 1-based column.
 * @returns The position.
 */
function position(
  line: number | undefined,
  column: number | undefined,
): Position {
  return {
    line: Math.max(0, (line ?? 1) - 1),
    character: Math.max(0, (column ?? 1) - 1),
  };
}

/**
 * Maps one file's report to problems.
 * @param result The file's result, or `undefined` for none.
 * @returns The problems, in report order.
 */
export function toProblems(result: LintFileResult | undefined): Problem[] {
  if (!result) return [];
  return result.messages
    .filter((m) => m.severity === 1 || m.severity === 2 || m.fatal === true)
    .map((m) => {
      const start = position(m.line, m.column);
      let end =
        m.endLine === undefined ? start : position(m.endLine, m.endColumn);
      if (
        end.line < start.line ||
        (end.line === start.line && end.character < start.character)
      )
        end = start;
      return {
        start,
        end,
        severity: m.severity === 2 || m.fatal === true ? "error" : "warning",
        message: m.message,
        rule: m.ruleId ?? undefined,
        fix: m.fix,
        suggestions: m.suggestions ?? [],
      };
    });
}
