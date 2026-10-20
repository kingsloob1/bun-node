import { Buffer } from "node:buffer";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it } from "bun:test";
import {
  divergentCopies,
  fmtScope,
  parseIgnoreRevs,
  quotes,
  reformat,
  resolveConflicts,
} from "../reformat";

const scratch = mkdtempSync(join(tmpdir(), "reformat-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Unformatted TypeScript: every line changes under `bun fmt`. */
const UNFORMATTED = `export const a = {one: 1,
  two: 2}
export function f( x:number ){return x+1}
`;

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(
    [
      "git",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      ...args,
    ],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_EDITOR: "true" },
    },
  );
  if (p.exitCode !== 0 && !args.includes("rebase"))
    throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

function write(root: string, file: string, text: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

/** A repository with a `[fmt]` config that ignores Markdown, and one commit. */
function repo(name: string, files: Record<string, string>): string {
  const root = join(scratch, name);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "develop");
  write(root, "bunfig.toml", `[fmt]\nignorePatterns = ["**/*.md"]\n`);
  for (const [f, t] of Object.entries(files)) write(root, f, t);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

/** What `bun fmt` makes of `text` as `file`. */
function formatted(text: string, file = "a.ts"): string {
  const p = Bun.spawnSync(
    [process.execPath, "fmt", `--stdin-filepath=${file}`],
    { stdin: Buffer.from(text), stdout: "pipe" },
  );
  return p.stdout.toString();
}

describe("reformat", () => {
  it("formats tracked files in [fmt]'s scope only, and verifies the result", () => {
    const root = repo("scope", {
      "a.ts": UNFORMATTED,
      "b.md": "#  Title\n*  item\n",
    });
    write(root, "untracked.ts", UNFORMATTED);
    expect(fmtScope(root)).toEqual(["a.ts", "bunfig.toml"]);

    const r = reformat(root);
    expect(r.changed).toEqual(["a.ts"]);
    expect(r.added).toBeGreaterThan(0);
    expect(r.notIdempotent).toEqual([]);
    expect(r.checkClean).toBe(true);
    expect(r.divergent).toEqual([]);
    expect(r.staleExcerpts).toEqual([]);
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe(
      formatted(UNFORMATTED),
    );
    // Markdown (Q3) and untracked files are never touched.
    expect(readFileSync(join(root, "b.md"), "utf8")).toBe(
      "#  Title\n*  item\n",
    );
    expect(readFileSync(join(root, "untracked.ts"), "utf8")).toBe(UNFORMATTED);
    // A second run is a no-op.
    expect(reformat(root).changed).toEqual([]);
  });

  it("reports a copied-file set whose copies differ", () => {
    const same = `{ "compilerOptions": {} }\n`;
    const root = repo("copies", {
      "packages/bun-common/tsconfig.build.json": same,
      "packages/bun-nest/tsconfig.build.json": same,
    });
    expect(divergentCopies(root)).toEqual([]);
    write(
      root,
      "packages/bun-nest/tsconfig.build.json",
      `{ "compilerOptions": { "strict": true } }\n`,
    );
    expect(divergentCopies(root)).toEqual([
      [
        "packages/bun-common/tsconfig.build.json",
        "packages/bun-nest/tsconfig.build.json",
      ],
    ]);
  });

  it("reads full hashes from .git-blame-ignore-revs, skipping comments", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(
      parseIgnoreRevs(
        `# the reformat\n${sha} # PR E\n<placeholder>\n0123abc\n`,
      ),
    ).toEqual([sha]);
  });

  it("finds a quote's lines in order, ignoring indentation", () => {
    const src = "class A {\n  m() {\n    return 1;\n  }\n}\n";
    expect(quotes(src, ["m() {", "  return 1;", "}"])).toBe(true);
    expect(quotes(src, ["return 1;", "m() {"])).toBe(false);
  });

  it("names the Markdown excerpts the reformat broke, not the ones it left alone", () => {
    const root = repo("excerpts", {
      "a.ts": UNFORMATTED,
      "c.ts": `export const keep = 1;\n${UNFORMATTED}`,
      "guide.md": [
        "<!-- excerpt: a.ts -->",
        "",
        "```ts",
        "export const a = {one: 1,",
        "```",
        "",
        "<!-- excerpt: c.ts -->",
        "",
        "```ts",
        "export const keep = 1;",
        "```",
        "",
      ].join("\n"),
    });
    expect(reformat(root).staleExcerpts).toEqual(["guide.md:1 → a.ts"]);
  });
});

describe("the rebase recipe", () => {
  /**
   * develop: base → reformat (R) → the ignore-revs commit; feature: base → an
   * edit on a line R reformatted. Rebasing feature onto R conflicts; the
   * resolver takes feature's side, formats it and stages it.
   */
  function setup(name: string): { root: string; reformatSha: string } {
    const root = repo(name, { "a.ts": UNFORMATTED, "notes.md": "base\n" });
    git(root, "checkout", "-q", "-b", "feature");
    write(root, "a.ts", UNFORMATTED.replace("x+1", "x+2"));
    git(root, "commit", "-q", "-am", "feature: f adds 2");
    git(root, "checkout", "-q", "develop");
    reformat(root);
    git(root, "commit", "-q", "-am", "style: the one-time bun fmt reformat");
    const reformatSha = git(root, "rev-parse", "HEAD").trim();
    write(root, ".git-blame-ignore-revs", `# the reformat\n${reformatSha}\n`);
    git(root, "add", ".git-blame-ignore-revs");
    git(root, "commit", "-q", "-m", "chore: ignore the reformat in blame");
    git(root, "checkout", "-q", "feature");
    return { root, reformatSha };
  }

  it("resolves a formatting conflict to the branch's change, formatted", () => {
    const { root, reformatSha } = setup("rebase");
    // Step 1: onto the commit before the reformat (here: the base, a no-op).
    git(root, "rebase", `${reformatSha}^`);
    // Step 2: onto the reformat commit: a conflict in a.ts.
    git(root, "rebase", reformatSha);
    expect(git(root, "diff", "--name-only", "--diff-filter=U").trim()).toBe(
      "a.ts",
    );

    expect(resolveConflicts(root, "develop")).toEqual({
      resolved: ["a.ts"],
      left: [],
    });
    git(root, "rebase", "--continue");
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe(
      formatted(UNFORMATTED.replace("x+1", "x+2")),
    );
    expect(git(root, "status", "--porcelain").trim()).toBe("");

    // Step 3: onto develop's tip, cleanly.
    git(root, "rebase", "develop");
    expect(git(root, "log", "--format=%s", "-3").trim().split("\n")).toEqual([
      "feature: f adds 2",
      "chore: ignore the reformat in blame",
      "style: the one-time bun fmt reformat",
    ]);
    expect(
      git(root, "show", "--format=", "HEAD").includes("+  return x + 2;"),
    ).toBe(true);
  });

  it("refuses a rebase whose target is not listed in .git-blame-ignore-revs", () => {
    const { root } = setup("refuse");
    git(root, "checkout", "-q", "-b", "other", "develop~2");
    write(root, "a.ts", UNFORMATTED.replace("x+1", "x+3"));
    git(root, "commit", "-q", "-am", "other");
    git(root, "checkout", "-q", "feature");
    git(root, "rebase", "other");
    expect(() => resolveConflicts(root, "develop")).toThrow(/does not list/);
    git(root, "rebase", "--abort");
  });
});
