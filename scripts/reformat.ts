#!/usr/bin/env bun
/**
 * The one-time `bun fmt` reformat of the bun-lint-fmt plan (PR E,
 * `docs/plans/bun-lint-fmt/README.md` §7), repeatable, and the conflict
 * resolver for rebasing a branch over it.
 *
 * ```bash
 * bun scripts/reformat.ts            # format, then verify; prints what changed
 * bun scripts/reformat.ts --check    # change nothing; exit 1 if a file needs formatting
 * bun scripts/reformat.ts --resolve  # in a rebase onto the reformat commit: settle its conflicts
 * ```
 *
 * **The scope is `bun fmt`'s own from the repository root, on tracked files
 * only**: what `bun fmt --list-files` lists there (the root `bunfig.toml`'s
 * `[fmt]` `ignorePatterns`, so no Markdown (Q3), no `docs/**`, no files a tool
 * writes, and `.gitignore`d `dist/`, `dts/` and `node_modules/`), intersected
 * with `git ls-files`, so an untracked file in a worktree is never touched and
 * two runs on the same commit change the same files. Lockfiles are not in it:
 * `bun fmt` formats no `bun.lock`.
 *
 * After formatting it verifies, and exits 1 on any failure: a second run
 * changes nothing (idempotence), `bun fmt --check` over the scope is clean,
 * and each set of copied files is still identical (the four
 * `scripts/build-declarations.ts` and the four `tsconfig.build.json`, one file
 * in four places, `packages/bun-common/__tests__/buildDeclarations.test.ts`).
 * It also names every Markdown excerpt (`<!-- excerpt: <path> -->`) of a file
 * it changed: Markdown is not formatted, so the quote is updated by hand, in
 * the same commit, or bun-jobs' docs test fails.
 *
 * **`--resolve`** is the rebase recipe's step (CLAUDE.md, "Lint and format").
 * Rebase a branch onto the commit *before* the reformat first, resolving real
 * conflicts by hand; then `git rebase <reformat commit>`, and on each stop run
 * this: for every conflicted file it takes the side of the commit being
 * replayed (`git checkout --theirs`), formats it and stages it. That is right
 * only because the reformat commit changes nothing but formatting, so the
 * script refuses unless the rebase's target is listed in
 * `.git-blame-ignore-revs`: the working tree's, or `origin/develop`'s
 * (`--revs-from <ref>`), since the reformat commit cannot list itself and the
 * tree being rebased is that commit's. A conflicted file outside the scope
 * (Markdown, a deletion on either side) is left for a hand resolution and
 * named.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

/** Files that are one file in several places: each set must stay byte-identical. */
export const COPIED_FILE_SETS: readonly (readonly string[])[] = [
  ["bun-common", "bun-nest", "bun-jobs", "bun-jobs-ui"].map(
    (p) => `packages/${p}/scripts/build-declarations.ts`,
  ),
  ["bun-common", "bun-nest", "bun-jobs", "bun-jobs-ui"].map(
    (p) => `packages/${p}/tsconfig.build.json`,
  ),
];

/** How many paths go to one `bun fmt` call, well under any argument limit. */
const CHUNK = 400;

/** The result of one command. */
interface Run {
  /** Its exit status. */
  code: number;
  /** Its standard output. */
  stdout: string;
  /** Its standard error. */
  stderr: string;
}

/**
 * The environment for `bun fmt`: without `AGENT`, `CLAUDECODE` and `REPL_ID`,
 * which switch Bun's output to the tagged format for AI agents.
 */
function fmtEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.AGENT;
  delete env.CLAUDECODE;
  delete env.REPL_ID;
  return env;
}

/** Runs a command in `cwd` and captures it. */
function run(cmd: string[], cwd: string): Run {
  const p = Bun.spawnSync(cmd, {
    cwd,
    env: fmtEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: p.exitCode,
    stdout: p.stdout.toString(),
    stderr: p.stderr.toString(),
  };
}

/** Runs `git` in `root`, failing loudly. */
function git(root: string, ...args: string[]): string {
  const r = run(["git", ...args], root);
  if (r.code !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

/** Runs `bun fmt` with `args` in `root`. `--no-script`: never a package's `fmt` script. */
function bunFmt(root: string, args: string[]): Run {
  return run([process.execPath, "fmt", "--no-script", ...args], root);
}

/** The tracked files `bun fmt` formats from `root`, sorted. */
export function fmtScope(root: string): string[] {
  const listed = bunFmt(root, ["--list-files"]);
  if (listed.code !== 0)
    throw new Error(`bun fmt --list-files failed: ${listed.stderr.trim()}`);
  const tracked = new Set(
    git(root, "ls-files", "-z").split("\0").filter(Boolean),
  );
  return listed.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && tracked.has(l))
    .sort();
}

/** A content hash per file, `""` for a file that does not exist. */
function hashes(root: string, files: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    const p = join(root, f);
    out.set(
      f,
      existsSync(p)
        ? createHash("sha256").update(readFileSync(p)).digest("hex")
        : "",
    );
  }
  return out;
}

/** `bun fmt` over `files` in chunks; returns the failed calls' output. */
function formatFiles(
  root: string,
  files: readonly string[],
  check = false,
): string[] {
  const failures: string[] = [];
  for (let i = 0; i < files.length; i += CHUNK) {
    const r = bunFmt(root, [
      ...(check ? ["--list-different"] : []),
      ...files.slice(i, i + CHUNK),
    ]);
    if (r.code !== 0) failures.push((r.stdout + r.stderr).trim());
  }
  return failures;
}

/** The sets in {@link COPIED_FILE_SETS} whose files present in `root` differ. */
export function divergentCopies(root: string): string[][] {
  const out: string[][] = [];
  for (const set of COPIED_FILE_SETS) {
    const present = set.filter((f) => existsSync(join(root, f)));
    if (new Set(hashes(root, present).values()).size > 1) out.push(present);
  }
  return out;
}

/** What one reformat did. */
export interface ReformatResult {
  /** The files in scope. */
  scope: number;
  /** The files the first run changed, sorted. */
  changed: string[];
  /** Lines added in `changed`, against the index. */
  added: number;
  /** Lines removed in `changed`, against the index. */
  removed: number;
  /** Files the second run changed: must be empty. */
  notIdempotent: string[];
  /** Whether `bun fmt --list-different` over the scope was clean afterwards. */
  checkClean: boolean;
  /** Copied-file sets that differ afterwards: must be empty. */
  divergent: string[][];
  /**
   * Markdown excerpts of a changed file (`<!-- excerpt: <path> -->`, which
   * bun-jobs' `docsCheck.ts` holds verbatim), as `doc:line → path`: Markdown is
   * not formatted (Q3), so each must be updated by hand in the same commit.
   */
  staleExcerpts: string[];
}

/**
 * Whether `excerpt`'s lines appear in `source` consecutively, each compared
 * without its indentation (a looser test than bun-jobs' `isExcerptOf`, which
 * is enough to tell a quote the reformat broke from one it left alone).
 */
export function quotes(source: string, excerpt: readonly string[]): boolean {
  const want = excerpt.map((l) => l.trim());
  const have = source.split("\n").map((l) => l.trim());
  for (let i = 0; i + want.length <= have.length; i++) {
    if (want.every((l, j) => have[i + j] === l)) return true;
  }
  return want.length === 0;
}

/**
 * The `<!-- excerpt: <path> -->` markers in tracked Markdown that name one of
 * `files` and whose fenced block no longer appears in that file.
 */
export function excerptsOf(root: string, files: readonly string[]): string[] {
  const wanted = new Set(files);
  const out: string[] = [];
  for (const doc of git(root, "ls-files", "-z", "*.md")
    .split("\0")
    .filter(Boolean)) {
    const lines = readFileSync(join(root, doc), "utf8").split("\n");
    lines.forEach((line, i) => {
      const m = /^<!--\s*excerpt:\s*(\S+)\s*-->$/.exec(line.trim());
      const file = m?.[1];
      if (!file || !wanted.has(file)) return;
      const open = lines.findIndex((l, j) => j > i && /^\s*```/.test(l));
      const close = lines.findIndex((l, j) => j > open && /^\s*```/.test(l));
      if (open < 0 || close < 0) return;
      const source = readFileSync(join(root, file), "utf8");
      if (!quotes(source, lines.slice(open + 1, close)))
        out.push(`${doc}:${i + 1} → ${file}`);
    });
  }
  return out;
}

/** Formats the scope in `root` and verifies the result. */
export function reformat(root: string): ReformatResult {
  const scope = fmtScope(root);
  const before = hashes(root, scope);
  const failed = formatFiles(root, scope);
  if (failed.length > 0)
    throw new Error(`bun fmt failed:\n${failed.join("\n")}`);
  const after = hashes(root, scope);
  const changed = scope.filter((f) => before.get(f) !== after.get(f));

  let added = 0;
  let removed = 0;
  if (changed.length > 0) {
    for (const line of git(root, "diff", "--numstat", "--", ...changed).split(
      "\n",
    )) {
      const [a, r] = line.split("\t");
      if (a && r && a !== "-") {
        added += Number(a);
        removed += Number(r);
      }
    }
  }

  formatFiles(root, scope);
  const again = hashes(root, scope);
  const notIdempotent = scope.filter((f) => after.get(f) !== again.get(f));
  const checkClean = formatFiles(root, scope, true).length === 0;
  return {
    scope: scope.length,
    changed,
    added,
    removed,
    notIdempotent,
    checkClean,
    divergent: divergentCopies(root),
    staleExcerpts: excerptsOf(root, changed),
  };
}

/** The full commit hashes a `.git-blame-ignore-revs` text lists. */
export function parseIgnoreRevs(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter((l) => /^[0-9a-f]{40}$/.test(l));
}

/** The commits `.git-blame-ignore-revs` lists in `root`'s working tree and at `ref`. */
export function ignoredRevs(root: string, ref: string): string[] {
  const p = join(root, ".git-blame-ignore-revs");
  const out = existsSync(p) ? parseIgnoreRevs(readFileSync(p, "utf8")) : [];
  const atRef = run(["git", "show", `${ref}:.git-blame-ignore-revs`], root);
  if (atRef.code === 0) out.push(...parseIgnoreRevs(atRef.stdout));
  return out;
}

/** What `--resolve` did with each conflicted file. */
export interface ResolveResult {
  /** Formatted from the replayed commit's side and staged. */
  resolved: string[];
  /** Left for a hand resolution: outside the scope, or deleted on a side. */
  left: string[];
}

/** Settles the conflicts of a rebase stopped on its way onto the reformat commit. */
export function resolveConflicts(
  root: string,
  revsFrom = "origin/develop",
): ResolveResult {
  const ontoPath = resolve(
    root,
    git(root, "rev-parse", "--git-path", "rebase-merge/onto").trim(),
  );
  if (!existsSync(ontoPath))
    throw new Error(
      "not in a rebase (no rebase-merge/onto): see the recipe in CLAUDE.md",
    );
  const onto = readFileSync(ontoPath, "utf8").trim();
  if (!ignoredRevs(root, revsFrom).includes(onto)) {
    throw new Error(
      `the rebase is onto ${onto.slice(0, 12)}, which .git-blame-ignore-revs (here or at ${revsFrom}) does not list: ` +
        "--resolve is only for the rebase onto the reformat commit itself",
    );
  }
  const scope = new Set(fmtScope(root));
  const unmerged = git(root, "diff", "--name-only", "--diff-filter=U", "-z")
    .split("\0")
    .filter(Boolean);
  // Each conflicted path's stages: 2 is the reformat commit's side, 3 the replayed commit's.
  const stages = new Map<string, Set<string>>();
  for (const line of git(root, "ls-files", "-u", "-z")
    .split("\0")
    .filter(Boolean)) {
    const [meta = "", path = ""] = line.split("\t");
    const stage = meta.split(" ")[2] ?? "";
    if (!stages.has(path)) stages.set(path, new Set());
    stages.get(path)?.add(stage);
  }
  const resolved: string[] = [];
  const left: string[] = [];
  for (const f of unmerged) {
    const s = stages.get(f);
    if (!scope.has(f) || !s?.has("2") || !s.has("3")) {
      left.push(f);
      continue;
    }
    git(root, "checkout", "--theirs", "--", f);
    const failed = formatFiles(root, [f]);
    if (failed.length > 0) {
      left.push(f);
      continue;
    }
    git(root, "add", "--", f);
    resolved.push(f);
  }
  return { resolved, left };
}

/** The command line. */
export function main(argv: readonly string[]): number {
  const option = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const rootArg = option("--root");
  const cwd = rootArg ? resolve(rootArg) : process.cwd();
  const root = git(cwd, "rev-parse", "--show-toplevel").trim();

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "usage: bun scripts/reformat.ts [--check | --resolve [--revs-from <ref>]] [--root <dir>]",
    );
    return 0;
  }

  if (argv.includes("--resolve")) {
    const r = resolveConflicts(root, option("--revs-from"));
    for (const f of r.resolved) console.log(`resolved  ${f}`);
    for (const f of r.left) console.log(`BY HAND   ${f}`);
    console.log(
      r.left.length > 0
        ? `${r.left.length} file(s) to resolve by hand, then git add them and git rebase --continue`
        : "all conflicts resolved: git rebase --continue",
    );
    return r.left.length > 0 ? 1 : 0;
  }

  if (argv.includes("--check")) {
    const scope = fmtScope(root);
    const failed = formatFiles(root, scope, true);
    for (const f of failed) console.log(f);
    console.log(
      failed.length > 0
        ? "needs formatting"
        : `all ${scope.length} files in scope are formatted`,
    );
    return failed.length > 0 ? 1 : 0;
  }

  const r = reformat(root);
  for (const f of r.changed) console.log(`formatted ${f}`);
  console.log(
    `${r.changed.length} of ${r.scope} files changed, +${r.added} -${r.removed} lines`,
  );
  let ok = true;
  if (r.notIdempotent.length > 0) {
    ok = false;
    console.log(
      `NOT IDEMPOTENT: a second run changed ${r.notIdempotent.join(", ")}`,
    );
  }
  if (!r.checkClean) {
    ok = false;
    console.log("bun fmt --check is not clean after formatting");
  }
  for (const set of r.divergent) {
    ok = false;
    console.log(`COPIES DIFFER: ${set.join(", ")}`);
  }
  for (const e of r.staleExcerpts) {
    ok = false;
    console.log(`UPDATE EXCERPT: ${e} (quote the formatted lines)`);
  }
  if (ok)
    console.log(
      "second run changed nothing; bun fmt --check clean; copied files identical",
    );
  return ok ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
