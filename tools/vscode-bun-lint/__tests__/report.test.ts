import { describe, expect, test } from "bun:test";
import {
  parseLintReport,
  ReportError,
  resultFor,
  toProblems,
} from "../src/core/report";

// Real `bun lint --stdin -f json` output (1.4.4-canary.1+5f5799ed1), from
// packages/bun-common with the root bunfig.toml, for:
//   const a = 1;
//   var b = 2;
//   export async function f() { Promise.resolve(1); return a + b; }
//   console.log(a as number);
const FILE = "/repo/packages/bun-common/lib/zz.ts";
const REPORT = JSON.stringify([
  {
    filePath: FILE,
    messages: [
      {
        ruleId: "no-var",
        severity: 2,
        message: "Unexpected var, use let or const instead.",
        line: 2,
        column: 1,
        messageId: "unexpectedVar",
        endLine: 2,
        endColumn: 11,
        fix: { range: [13, 16], text: "let" },
      },
      {
        ruleId: "@typescript-eslint/require-await",
        severity: 1,
        message: "Async function 'f' has no 'await' expression.",
        line: 3,
        column: 8,
        messageId: "missingAwait",
        endLine: 3,
        endColumn: 24,
        suggestions: [
          {
            messageId: "removeAsync",
            fix: { range: [31, 37], text: "" },
            desc: "Remove 'async'.",
          },
        ],
      },
      {
        ruleId: "@typescript-eslint/no-floating-promises",
        severity: 2,
        message:
          "Promises must be awaited, end with a call to .catch, end with a call to .then with a rejection handler or be explicitly marked as ignored with the `void` operator.",
        line: 3,
        column: 29,
        messageId: "floatingVoid",
        endLine: 3,
        endColumn: 48,
        suggestions: [
          {
            messageId: "floatingFixVoid",
            fix: { range: [52, 52], text: "void " },
            desc: "Add void operator to ignore.",
          },
          {
            messageId: "floatingFixAwait",
            fix: { range: [52, 52], text: "await " },
            desc: "Add await operator.",
          },
        ],
      },
      {
        ruleId: "no-console",
        severity: 1,
        message: "Unexpected console statement.",
        line: 4,
        column: 1,
        messageId: "unexpected",
        endLine: 4,
        endColumn: 12,
        suggestions: [
          {
            messageId: "removeConsole",
            data: { propertyName: "log" },
            fix: { range: [88, 113], text: "" },
            desc: "Remove the console.log().",
          },
        ],
      },
      {
        ruleId: "@typescript-eslint/no-unnecessary-type-assertion",
        severity: 1,
        message:
          "This assertion is unnecessary since the receiver accepts the original type of the expression.",
        line: 4,
        column: 13,
        messageId: "contextuallyUnnecessary",
        endLine: 4,
        endColumn: 24,
        fix: { range: [101, 111], text: "" },
      },
    ],
    suppressedMessages: [],
    errorCount: 2,
    fatalErrorCount: 0,
    warningCount: 3,
    fixableErrorCount: 1,
    fixableWarningCount: 1,
    usedDeprecatedRules: [],
  },
]);

describe("parseLintReport", () => {
  test("reads the JSON report and ignores the script echo on stderr", () => {
    const results = parseLintReport(
      REPORT,
      '$ bun lint --stdin …\nerror: script "lint" exited with code 1\n',
    );
    expect(results).toHaveLength(1);
    expect(results[0].messages).toHaveLength(5);
  });

  test("an ignored file is an empty array, not an error", () => {
    expect(parseLintReport("[]\n")).toEqual([]);
  });

  test("no report fails, naming a missing bun lint", () => {
    expect(() => parseLintReport("", 'error: Script not found "lint"')).toThrow(
      /needs 1\.4\.4/,
    );
    expect(() => parseLintReport("", "")).toThrow(ReportError);
  });

  test("text that is not JSON fails with the text", () => {
    expect(() => parseLintReport("<agent>…</agent>")).toThrow(
      /other than a JSON report/,
    );
    expect(() => parseLintReport('{"a":1}')).toThrow(/not an array/);
  });
});

describe("resultFor", () => {
  test("matches by path only", () => {
    const results = parseLintReport(REPORT);
    expect(resultFor(results, FILE)).toBe(results[0]);
    expect(
      resultFor(results, "/repo/packages/bun-common/lib/../lib/zz.ts"),
    ).toBe(results[0]);
    expect(resultFor(results, "/repo/other.ts")).toBeUndefined();
  });
});

describe("toProblems", () => {
  const problems = toProblems(resultFor(parseLintReport(REPORT), FILE));

  test("zero-based positions from 1-based lines and columns", () => {
    expect(
      problems.map((p) => [
        p.rule,
        p.start.line,
        p.start.character,
        p.end.line,
        p.end.character,
      ]),
    ).toEqual([
      ["no-var", 1, 0, 1, 10],
      ["@typescript-eslint/require-await", 2, 7, 2, 23],
      ["@typescript-eslint/no-floating-promises", 2, 28, 2, 47],
      ["no-console", 3, 0, 3, 11],
      ["@typescript-eslint/no-unnecessary-type-assertion", 3, 12, 3, 23],
    ]);
  });

  test("severity 2 is an error, 1 a warning", () => {
    expect(problems.map((p) => p.severity)).toEqual([
      "error",
      "warning",
      "error",
      "warning",
      "warning",
    ]);
  });

  test("fixes and suggestions carried as offset edits", () => {
    expect(problems[0].fix).toEqual({ range: [13, 16], text: "let" });
    expect(problems[0].suggestions).toEqual([]);
    expect(problems[2].fix).toBeUndefined();
    expect(problems[2].suggestions.map((s) => [s.desc, s.fix.text])).toEqual([
      ["Add void operator to ignore.", "void "],
      ["Add await operator.", "await "],
    ]);
  });

  test("a parse error: no rule, an error, column 0 clamped", () => {
    const [p] = toProblems({
      filePath: FILE,
      messages: [
        {
          ruleId: null,
          fatal: true,
          severity: 2,
          message: "Parsing error: '}' expected.",
          line: 2,
          column: 0,
        },
      ],
    });
    expect(p).toEqual({
      start: { line: 1, character: 0 },
      end: { line: 1, character: 0 },
      severity: "error",
      message: "Parsing error: '}' expected.",
      rule: undefined,
      fix: undefined,
      suggestions: [],
    });
  });

  test("an end before the start collapses to the start", () => {
    const [p] = toProblems({
      filePath: FILE,
      messages: [
        {
          ruleId: "x",
          severity: 1,
          message: "m",
          line: 3,
          column: 5,
          endLine: 3,
          endColumn: 2,
        },
      ],
    });
    expect(p.end).toEqual(p.start);
  });

  test("no result, no problems", () => {
    expect(toProblems(undefined)).toEqual([]);
  });
});
