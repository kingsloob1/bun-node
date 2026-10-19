// The 11-directory test (docs/plans/bun-lint-fmt/ §5 and §7, PR D): in each
// directory the gate lints, one real file is opened the way the editor sends
// it, through the extension's own `lintText`, against the real `bun lint` and
// the repository's config.
//
// - clean: the file as it is on disk reports nothing, and the gate (`bun lint
//   -f json` over the whole directory, run from it, as `bun run lint` does)
//   reports nothing for it either;
// - planted: the same file with lines appended reports exactly the planted
//   findings, with the right rule, line and severity, and the same problems as
//   the raw CLI run from the gate's directory (so choosing the file's own
//   directory as the working directory changes nothing).
//
// The plants also prove that each directory gets its own config: the regexp
// plugin runs everywhere but the template (whose bunfig.toml leaves it out),
// `no-console` is off in scripts/, playground/ and examples/, the React rules
// run only in bun-jobs-ui, and `no-floating-promises` shows the type-aware
// rules run (`typeAware = true`).
//
// No file is written: the planted text exists only on standard input.
import type { Problem } from "../src/core/report";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { beforeAll, describe, expect, test } from "bun:test";
import { lintArgs, runBun } from "../src/core/bun";
import { parseLintReport, resultFor, toProblems } from "../src/core/report";
import { lintText } from "../src/core/service";

const REPO = join(import.meta.dir, "../../..");
const bunPath = process.execPath;

/** One directory of the gate, and the file opened in it (clean in the gate on 2026-10-20). */
interface Case {
  /** The directory, relative to the repo: `.vscode/settings.json`'s list, with the template's own directory. */
  dir: string;
  /** A file in it the gate reports nothing for. */
  file: string;
  /** Whether `no-console` reports there. */
  console: boolean;
  /** Whether the root config's regexp plugin applies (not in the template). */
  regexp: boolean;
  /** Whether the React rules apply (a `.tsx` file in bun-jobs-ui). */
  react: boolean;
}

const CASES: Case[] = [
  {
    dir: "packages/bun-common",
    file: "lib/cors.ts",
    console: true,
    regexp: true,
    react: false,
  },
  {
    dir: "packages/bun-nest",
    file: "lib/decorators.ts",
    console: true,
    regexp: true,
    react: false,
  },
  {
    dir: "packages/bun-jobs",
    file: "lib/api/body.ts",
    console: true,
    regexp: true,
    react: false,
  },
  {
    dir: "packages/bun-jobs-ui",
    file: "app/App.tsx",
    console: true,
    regexp: true,
    react: true,
  },
  {
    dir: "scripts",
    file: "typecheck.ts",
    console: false,
    regexp: true,
    react: false,
  },
  {
    dir: "playground",
    file: "backend.ts",
    console: false,
    regexp: true,
    react: false,
  },
  {
    dir: "templates/compute-provider",
    file: "src/config.ts",
    console: true,
    regexp: false,
    react: false,
  },
  {
    dir: "examples/bun-common",
    file: "01-quick-start/index.ts",
    console: false,
    regexp: true,
    react: false,
  },
  {
    dir: "examples/bun-nest",
    file: "01-quick-start/index.ts",
    console: false,
    regexp: true,
    react: false,
  },
  {
    dir: "examples/bun-jobs",
    file: "01-quick-start/index.ts",
    console: false,
    regexp: true,
    react: false,
  },
  {
    dir: "examples/bun-jobs-ui",
    file: "06-browser/helpers/page.ts",
    console: false,
    regexp: true,
    react: false,
  },
];

/** A line that is clean only when the file's own tsconfig (with the DOM lib) types it. */
const DOM_LINE = "export const __probeTitle = document.title.toUpperCase();";

/** A finding reduced to what the test compares. */
type Finding = [
  rule: string | undefined,
  line: number,
  severity: Problem["severity"],
];

/**
 * @param problems Problems.
 * @returns Them as `[rule, 1-based line, severity]`, sorted.
 */
function findings(problems: Problem[]): Finding[] {
  return problems
    .map((p): Finding => [p.rule, p.start.line + 1, p.severity])
    .sort((a, b) => a[1] - b[1] || String(a[0]).localeCompare(String(b[0])));
}

/**
 * The planted lines for a case, appended to the file.
 * @param c The case.
 * @param firstLine The 1-based line the first one lands on.
 * @returns The text to append, and the findings it must produce.
 */
function plant(
  c: Case,
  firstLine: number,
): { text: string; expected: Finding[] } {
  const lines = [
    "debugger;",
    "export async function __probeFloating(): Promise<void> { Promise.resolve(1); await Promise.resolve(); }",
    'console.info("probe");',
    "export const __probeRegexp = /[aa]/;",
  ];
  const expected: Finding[] = [
    ["no-debugger", firstLine, "error"],
    ["@typescript-eslint/no-floating-promises", firstLine + 1, "error"],
  ];
  if (c.console) expected.push(["no-console", firstLine + 2, "warning"]);
  if (c.regexp)
    expected.push([
      "regexp/no-dupe-characters-character-class",
      firstLine + 3,
      "error",
    ]);
  if (c.react) {
    lines.push(
      "export const __probeList = [1].map((n) => <i>{n}</i>);",
      // Typed by app/tsconfig.json's DOM lib: clean. Under a DOM-free
      // project it is three no-unsafe-* findings (the control below).
      DOM_LINE,
    );
    expected.push(["react/jsx-key", firstLine + 4, "error"]);
    // A component file that exports something other than components: the
    // React Refresh rule, on each planted export.
    for (const offset of [1, 3, 4, 5])
      expected.push([
        "react/only-export-components",
        firstLine + offset,
        "error",
      ]);
  }
  return { text: `${lines.join("\n")}\n`, expected };
}

/** The gate's report per directory: `bun lint -f json` over all of it, from it. */
const gate = new Map<string, Problem[]>();

beforeAll(async () => {
  for (const c of CASES) {
    const cwd = join(REPO, c.dir);
    const run = await runBun(bunPath, ["lint", "-f", "json", "--no-color"], {
      cwd,
      timeoutMs: 120_000,
    });
    const path = join(cwd, c.file);
    const result = resultFor(parseLintReport(run.stdout, run.stderr), path);
    if (!result) throw new Error(`the gate in ${c.dir} did not lint ${c.file}`);
    gate.set(c.dir, toProblems(result));
  }
}, 300_000);

describe.each(CASES)("$dir", (c) => {
  const path = join(REPO, c.dir, c.file);
  const disk = readFileSync(path, "utf8");

  test(`clean: ${c.file} reports nothing, as in the gate`, async () => {
    expect(findings(gate.get(c.dir)!)).toEqual([]);
    expect(findings(await lintText(path, disk, { bunPath }))).toEqual([]);
  });

  test(`planted: ${c.file} reports the planted findings, as the CLI does from ${c.dir}`, async () => {
    const base = disk.endsWith("\n") ? disk : `${disk}\n`;
    const firstLine = base.split("\n").length;
    const { text, expected } = plant(c, firstLine);
    const buffer = base + text;
    const ours = await lintText(path, buffer, { bunPath });
    expect(findings(ours)).toEqual(
      expected.sort(
        (a, b) => a[1] - b[1] || String(a[0]).localeCompare(String(b[0])),
      ),
    );
    const raw = await runBun(bunPath, lintArgs(path), {
      cwd: join(REPO, c.dir),
      input: buffer,
    });
    expect(ours).toEqual(
      toProblems(resultFor(parseLintReport(raw.stdout, raw.stderr), path)),
    );
  });
});

test("control: the DOM line is not clean in a DOM-free project, so the bun-jobs-ui plant can fail", async () => {
  const path = join(REPO, "packages/bun-jobs-ui/lib/__probe__.ts");
  const rules = (await lintText(path, `${DOM_LINE}\n`, { bunPath }))
    .map((p) => p.rule)
    .sort();
  expect(rules).toEqual([
    "@typescript-eslint/no-unsafe-assignment",
    "@typescript-eslint/no-unsafe-call",
    "@typescript-eslint/no-unsafe-member-access",
  ]);
});
