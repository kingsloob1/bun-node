import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import {
  classify,
  collectCommits,
  entryBody,
  EntryExists,
  findEntry,
  GENERATED_MARK,
  githubUrl,
  HAND_MARK,
  HEADER,
  insertEntry,
  previousTag,
  renderEntry,
} from "../changelog";

const scratch = mkdtempSync(join(tmpdir(), "changelog-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A repository of its own: no global config (no signing, no hooks), fixed identity.
const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** Runs git in `cwd`; its stdout. */
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    env: ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

let n = 0;
/** One commit touching its own file. */
function commit(cwd: string, message: string): void {
  writeFileSync(join(cwd, `f${++n}.txt`), message);
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", message);
}

/**
 * A history: v1.0.0, then commits on main, and a feature branch merged as
 * PR #12 (its commits carry no number themselves), and a squash with (#15).
 */
function history(): string {
  const repo = mkdtempSync(join(scratch, "repo-"));
  git(repo, "init", "-q", "-b", "main");
  commit(repo, "chore: initial");
  git(repo, "tag", "v1.0.0");
  commit(repo, "fix(bun-common): HEAD answers with the GET handler");
  git(repo, "checkout", "-q", "-b", "feature");
  commit(repo, "feat(bun-client): typed WebSocket client");
  commit(repo, "feat(bun-client)!: createClient takes a route map");
  git(repo, "checkout", "-q", "main");
  git(
    repo,
    "merge",
    "-q",
    "--no-ff",
    "feature",
    "-m",
    "Merge pull request #12 from owner/feature",
  );
  commit(repo, "perf(bun-cache): one round trip per getMany (#15)");
  commit(
    repo,
    "refactor(bun-jobs): the driver contract\n\nBREAKING CHANGE: drivers implement claimBatch",
  );
  commit(repo, "docs: the release flow");
  commit(repo, "Update README");
  commit(repo, "feat(bun-common): fetch() without a socket");
  return repo;
}

describe("collectCommits and renderEntry", () => {
  const repo = history();

  it("starts from the previous tag", () => {
    expect(previousTag(repo)).toBe("v1.0.0");
  });

  it("skips merges, and links a merged branch's commits to its PR", () => {
    const commits = collectCommits(repo, "v1.0.0");
    expect(commits.map((c) => c.subject)).not.toContain(
      "Merge pull request #12 from owner/feature",
    );
    expect(commits).toHaveLength(8);
    const byText = Object.fromEntries(commits.map((c) => [c.subject, c.pr]));
    expect(byText["feat(bun-client): typed WebSocket client"]).toBe(12);
    expect(byText["perf(bun-cache): one round trip per getMany (#15)"]).toBe(
      15,
    );
    expect(byText["docs: the release flow"]).toBeUndefined();
  });

  it("groups by type, then by scope, oldest first, with PR links", () => {
    const entry = renderEntry({
      version: "1.1.0",
      date: "2026-11-04",
      from: "v1.0.0",
      commits: collectCommits(repo, "v1.0.0"),
      repo: "https://github.com/owner/repo",
    });
    const pr = (k: number) =>
      `([#${k}](https://github.com/owner/repo/pull/${k}))`;
    expect(entry).toBe(
      [
        "## 1.1.0 (2026-11-04)",
        "",
        GENERATED_MARK,
        "",
        "Changes since v1.0.0 ([compare](https://github.com/owner/repo/compare/v1.0.0...v1.1.0)).",
        "",
        "### Breaking changes",
        "",
        "- **bun-client**",
        `  - createClient takes a route map ${pr(12)}`,
        "- **bun-jobs**",
        "  - the driver contract — drivers implement claimBatch",
        "",
        "### Features",
        "",
        "- **bun-client**",
        `  - typed WebSocket client ${pr(12)}`,
        "- **bun-common**",
        "  - fetch() without a socket",
        "",
        "### Fixes",
        "",
        "- **bun-common**",
        "  - HEAD answers with the GET handler",
        "",
        "### Performance",
        "",
        "- **bun-cache**",
        `  - one round trip per getMany ${pr(15)}`,
        "",
        "### Docs",
        "",
        "- the release flow",
        "",
        "### Other",
        "",
        "- Update README",
        "",
      ].join("\n"),
    );
  });

  it("falls back to the highest v* tag when none is reachable", () => {
    const repo2 = mkdtempSync(join(scratch, "repo-"));
    git(repo2, "init", "-q", "-b", "main");
    commit(repo2, "chore: a");
    git(repo2, "checkout", "-q", "--orphan", "other");
    commit(repo2, "chore: b");
    git(repo2, "tag", "v2.0.0-rc.1");
    git(repo2, "tag", "v1.9.0");
    git(repo2, "checkout", "-q", "main");
    expect(previousTag(repo2)).toBe("v2.0.0-rc.1");
  });
});

describe("classify", () => {
  it("reads types, scopes and both breaking forms; anything else is Other", () => {
    const at = (subject: string, body = "") =>
      classify({ hash: "h", subject, body });
    expect(at("feat(bun-nest)!: drop Nest 10")).toMatchObject({
      group: "Breaking changes",
      scope: "bun-nest",
      text: "drop Nest 10",
    });
    expect(at("fix: x", "BREAKING-CHANGE: y")).toMatchObject({
      group: "Breaking changes",
      text: "x — y",
    });
    expect(at("build(deps): bump")).toMatchObject({
      group: "Other",
      scope: "deps",
    });
    expect(at("Merge branch develop")).toMatchObject({
      group: "Other",
      scope: "",
    });
    expect(at("perf: faster (#9)")).toMatchObject({
      group: "Performance",
      text: "faster",
      pr: 9,
    });
  });

  it("reads a GitHub URL from either remote form", () => {
    expect(githubUrl("git@github.com:owner/repo.git")).toBe(
      "https://github.com/owner/repo",
    );
    expect(githubUrl("https://github.com/owner/repo")).toBe(
      "https://github.com/owner/repo",
    );
    expect(githubUrl("git@gitlab.com:owner/repo.git")).toBeUndefined();
  });
});

describe("the CHANGELOG.md file", () => {
  const generated = (v: string) =>
    `## ${v} (2026-11-04)\n\n${GENERATED_MARK}\n\n- ${v} change\n`;
  const hand = `## 3.0.0-rc.0 (2026-11-04)\n\n${HAND_MARK}\n\nThe candidate.\n`;

  it("adds an entry newest first, under the header", () => {
    const one = insertEntry(undefined, "1.0.0", generated("1.0.0"));
    expect(one.startsWith(HEADER)).toBe(true);
    const two = insertEntry(one, "1.1.0", generated("1.1.0"));
    expect(two.indexOf("## 1.1.0")).toBeLessThan(two.indexOf("## 1.0.0"));
    expect(two.startsWith(HEADER)).toBe(true);
  });

  it("refuses an existing entry; --force replaces a generated one only", () => {
    const file = insertEntry(
      insertEntry(undefined, "1.0.0", generated("1.0.0")),
      "1.1.0",
      generated("1.1.0"),
    );
    expect(() => insertEntry(file, "1.0.0", generated("1.0.0"))).toThrow(
      EntryExists,
    );
    const forced = insertEntry(
      file,
      "1.0.0",
      generated("1.0.0").replace("- 1.0.0 change", "- 1.0.0 regenerated"),
      true,
    );
    expect(forced).toContain("- 1.0.0 regenerated");
    expect(forced).not.toContain("- 1.0.0 change");
    expect(forced).toContain("- 1.1.0 change");
    expect(findEntry(forced, "1.1.0")!.text).toContain("1.1.0 change");
  });

  it("never replaces a hand-written entry, nor one with no mark, even with --force", () => {
    const file = insertEntry(undefined, "3.0.0-rc.0", hand);
    expect(() =>
      insertEntry(file, "3.0.0-rc.0", generated("3.0.0-rc.0"), true),
    ).toThrow("hand-written entry for 3.0.0-rc.0");
    const unmarked = `${HEADER}\n## 2.0.0\n\nWritten long ago.\n`;
    expect(() =>
      insertEntry(unmarked, "2.0.0", generated("2.0.0"), true),
    ).toThrow(EntryExists);
  });

  it("finds a version's entry, not a prerelease of it, and gives its body for the release notes", () => {
    const file = insertEntry(
      insertEntry(undefined, "3.0.0-rc.0", hand),
      "3.0.0",
      generated("3.0.0"),
    );
    expect(entryBody(file, "3.0.0-rc.0")).toBe("The candidate.");
    expect(entryBody(file, "3.0.0")).toBe("- 3.0.0 change");
    expect(findEntry(file, "3.0.0")!.text).not.toContain("candidate");
    expect(entryBody(file, "3.0.1")).toBeUndefined();
    expect(entryBody("## [v4.0.0] - 2027\n\nBracketed.\n", "4.0.0")).toBe(
      "Bracketed.",
    );
  });
});
