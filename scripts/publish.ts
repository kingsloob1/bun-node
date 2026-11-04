#!/usr/bin/env bun
/**
 * Publishes every workspace package to npm, in dependency order, with one
 * one-time code.
 *
 * ```bash
 * npm login                                  # once; the script never logs in
 * bun scripts/publish.ts --dry-run           # everything but the uploads
 * bun scripts/publish.ts                     # asks once for the one-time code
 * bun scripts/publish.ts --tag latest        # a final version (the default for one)
 * ```
 *
 * What it does, in order, stopping with a reason at the first refusal:
 *
 * 1. **Finds the packages** from the root `package.json`'s
 *    `workspaces.packages`, globs expanded as Bun does (a `!` pattern
 *    excludes), and publishes every member that is not `private: true`. There
 *    is no list to maintain: a ninth package is published once it meets
 *    {@link memberProblems}' requirements (its version is `lerna.json`'s, a
 *    scoped name has `publishConfig.access: "public"`, `files`, a `prepack`
 *    that builds its declarations, a LICENSE, a `consumer-check.json`, and
 *    internal dependencies on `workspace:^`).
 * 2. **Checks the preconditions**: a clean tree (`git status --porcelain`),
 *    a tag (`next` for a prerelease, `latest` otherwise; `--tag` overrides,
 *    but never `latest` for a prerelease), and `npm whoami`.
 * 3. **Orders them** from the dependency graph (`dependencies` and required
 *    peers; optional peers do not order, which is how bun-common and
 *    bun-api-docs-ui name each other), ties by name, and prints the order.
 * 4. **Skips what the registry has** (`npm view <name>@<version> version`),
 *    like lerna's `from-package`, so a re-run after a partial publish carries
 *    on from where it stopped.
 * 5. **Packs everything first**, before asking for a code: `bun pm pack` per
 *    package (its `prepack` builds `dts/` and the UI bundles) into one
 *    directory, then reads each tarball back ({@link guardTarball}): no
 *    `workspace:` or `catalog:` left, its version, and every internal range
 *    `^<version>`. `npm pack` would ship `workspace:^` verbatim; this is why
 *    the script packs with Bun and uploads with npm.
 * 6. **Asks once for the one-time code** (hidden, never printed or logged;
 *    `--otp <code>` or `--no-otp` instead), then runs
 *    `npm publish <tarball> --tag <tag> --access public` for each, in order,
 *    with the code in npm's environment (`npm_config_otp`) rather than its
 *    argv. A rejected or expired code (`EOTP`) asks for a new one and retries
 *    that package; any other failure stops, saying what was published and
 *    what was not.
 * 7. **Verifies** (`npm view <name>@<tag> version` for each).
 * 8. **Tags and releases**, once every package is on the registry (so a
 *    re-run after a partial publish does it once, at the end): a signed,
 *    annotated `v<version>` tag on HEAD (`git tag -s`; the repo signs with
 *    SSH), pushed to origin (retried, since GitHub's SSH can be flaky; the
 *    command to re-run is printed if it still fails), then
 *    `gh release create v<version> --notes-file …` with the version's
 *    `CHANGELOG.md` entry and an npm link per package, `--prerelease` for a
 *    prerelease. Each step is skipped when it is already done. `--no-release`
 *    skips all three.
 *
 * Preconditions for step 8, checked before anything is packed: the
 * version's `CHANGELOG.md` entry (always; `scripts/changelog.ts` writes one),
 * `gh auth status` and push access for the active account, and no `v<version>`
 * tag, locally or on origin, at another commit.
 *
 * `--dry-run` does all of it except the uploads (`npm publish <tarball>
 * --dry-run`), the verification, the tag and the release, which it prints,
 * and asks for no code; with it, `--allow-dirty` and `--skip-whoami` relax
 * those two preconditions, so a branch can rehearse a release before it
 * merges.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { entryBody, githubUrl } from "./changelog";
import { DEPENDENCY_FIELDS, guardTarball } from "./pack-guard";

/** The fields of a workspace member's `package.json` the script reads. */
export interface Manifest {
  /** The package's name. */
  name?: string;
  /** The package's version. */
  version?: string;
  /** True for a package that is never published. */
  private?: boolean;
  /** What the tarball ships. */
  files?: string[];
  /** Lifecycle and task scripts; `prepack` is required. */
  scripts?: Record<string, string>;
  /** npm's publish settings: `access` and `registry`. */
  publishConfig?: { access?: string; registry?: string };
  /** Runtime dependencies (bun-contract's is `null`). */
  dependencies?: Record<string, string> | null;
  /** Peer dependencies. */
  peerDependencies?: Record<string, string> | null;
  /** Which peers are optional. */
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  /** Optional dependencies. */
  optionalDependencies?: Record<string, string> | null;
  /** Development dependencies. */
  devDependencies?: Record<string, string> | null;
  /** The root manifest's workspaces: a list of globs, or `{ packages, catalog }`. */
  workspaces?: string[] | { packages?: string[] };
}

/** A workspace member. */
export interface Member {
  /** Its directory, relative to the root, with `/` separators (`packages/bun-common`). */
  dir: string;
  /** Its `package.json`. */
  manifest: Manifest;
}

/** A refusal: the reasons the script will not go on, one per line. */
export class PublishRefusal extends Error {
  /** One line per reason. */
  readonly reasons: string[];
  /** @param reasons - One line per reason. */
  constructor(reasons: string[]) {
    super(reasons.join("\n"));
    this.name = "PublishRefusal";
    this.reasons = reasons;
  }
}

/** The root manifest's workspace globs, from either spelling of `workspaces`. */
export function workspacePatterns(root: Manifest): string[] {
  const ws = root.workspaces;
  if (Array.isArray(ws)) return ws;
  return ws?.packages ?? [];
}

/**
 * The workspace's members: every directory with a `package.json` that a
 * pattern matches and no `!` pattern excludes, sorted by directory. Throws
 * when two members share a name.
 */
export function discoverMembers(root: string): Member[] {
  const rootManifest = readJson<Manifest>(join(root, "package.json"));
  const patterns = workspacePatterns(rootManifest);
  const include = patterns.filter((p) => !p.startsWith("!"));
  const exclude = patterns
    .filter((p) => p.startsWith("!"))
    .map((p) => new Bun.Glob(p.slice(1).replace(/\/+$/, "")));
  const dirs = new Set<string>();
  for (const pattern of include) {
    const glob = new Bun.Glob(`${pattern.replace(/\/+$/, "")}/package.json`);
    for (const file of glob.scanSync({ cwd: root, onlyFiles: true })) {
      const dir = file.replaceAll("\\", "/").replace(/\/?package\.json$/, "");
      if (dir.split("/").includes("node_modules")) continue;
      if (exclude.some((g) => g.match(dir))) continue;
      dirs.add(dir);
    }
  }
  const members = [...dirs].sort().map((dir) => ({
    dir,
    manifest: readJson<Manifest>(join(root, dir, "package.json")),
  }));
  const seen = new Map<string, string>();
  for (const m of members) {
    const name = m.manifest.name ?? "";
    const other = seen.get(name);
    if (other !== undefined)
      throw new PublishRefusal([
        `${m.dir} and ${other} are both named "${name}"`,
      ]);
    seen.set(name, m.dir);
  }
  return members;
}

/** The dependencies a member names, by field (null fields read as empty). */
function dependencyEntries(manifest: Manifest): [string, string, string][] {
  const out: [string, string, string][] = [];
  for (const field of DEPENDENCY_FIELDS)
    for (const [name, spec] of Object.entries(manifest[field] ?? {}))
      out.push([field, name, spec]);
  return out;
}

/** True when `name` is a peer of `manifest` that `peerDependenciesMeta` marks optional. */
function optionalPeer(manifest: Manifest, name: string): boolean {
  return manifest.peerDependenciesMeta?.[name]?.optional === true;
}

/**
 * The workspace packages `member` needs published before it: its
 * `dependencies`, `optionalDependencies` and required peers among `names`.
 */
export function internalDependencies(
  member: Member,
  names: Set<string>,
): string[] {
  const m = member.manifest;
  const out = new Set<string>();
  for (const field of ["dependencies", "optionalDependencies"] as const)
    for (const name of Object.keys(m[field] ?? {}))
      if (names.has(name)) out.add(name);
  for (const name of Object.keys(m.peerDependencies ?? {}))
    if (names.has(name) && !optionalPeer(m, name)) out.add(name);
  out.delete(m.name ?? "");
  return [...out].sort();
}

/**
 * The members in publish order: each after every workspace package it
 * depends on ({@link internalDependencies}), ties broken by name, so the
 * order does not depend on the workspace list's. Throws on a cycle, naming
 * the packages in it.
 */
export function publishOrder(members: Member[]): Member[] {
  const byName = new Map(members.map((m) => [m.manifest.name ?? m.dir, m]));
  const names = new Set(byName.keys());
  const waiting = new Map(
    members.map((m) => [
      m.manifest.name ?? m.dir,
      new Set(internalDependencies(m, names)),
    ]),
  );
  const order: Member[] = [];
  while (waiting.size > 0) {
    const ready = [...waiting]
      .filter(([, deps]) => deps.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0)
      throw new PublishRefusal([
        `dependency cycle among ${[...waiting.keys()].sort().join(", ")} (dependencies and required peers)`,
      ]);
    const next = ready[0];
    order.push(byName.get(next)!);
    waiting.delete(next);
    for (const deps of waiting.values()) deps.delete(next);
  }
  return order;
}

/** What a member that is not `private` lacks to be published, one line each; empty when nothing. */
export function memberProblems(
  root: string,
  member: Member,
  version: string,
  members: Member[],
): string[] {
  const m = member.manifest;
  const at = `${member.dir} (${m.name ?? "no name"})`;
  const problems: string[] = [];
  if (!m.name) problems.push(`${at}: no "name"`);
  if (m.version !== version)
    problems.push(
      `${at}: version ${m.version ?? "missing"}, not lerna.json's ${version}`,
    );
  if (m.name?.startsWith("@") && m.publishConfig?.access !== "public")
    problems.push(
      `${at}: a scoped package needs "publishConfig": { "access": "public" }`,
    );
  if (!Array.isArray(m.files) || m.files.length === 0)
    problems.push(
      `${at}: no "files" (what the tarball ships, e.g. ["dts", "lib"])`,
    );
  if (!/build-declarations|build:types/.test(m.scripts?.prepack ?? ""))
    problems.push(
      `${at}: "scripts.prepack" must build the declarations (bun scripts/build-declarations.ts, ` +
        `copied with tsconfig.build.json from another package; CLAUDE.md "Packaging types")`,
    );
  const dir = join(root, member.dir);
  if (!readdirSync(dir).some((f) => /^licen[cs]e(?:\.\w+)?$/i.test(f)))
    problems.push(`${at}: no LICENSE file (copy the root's)`);
  const checkConfig = join(dir, "consumer-check.json");
  if (!existsSync(checkConfig))
    problems.push(
      `${at}: no consumer-check.json (scripts/consumer-check.ts checks every published package)`,
    );
  else {
    const config = readJson<{ entries?: unknown[] }>(checkConfig);
    if (!Array.isArray(config.entries) || config.entries.length === 0)
      problems.push(`${at}: consumer-check.json has no "entries"`);
  }
  const byName = new Map(members.map((o) => [o.manifest.name, o]));
  for (const [field, name, spec] of dependencyEntries(m)) {
    const target = byName.get(name);
    if (!target) continue;
    if (spec !== "workspace:^")
      problems.push(
        `${at}: ${field}.${name} is ${spec}; a workspace package is named "workspace:^"`,
      );
    const required =
      field === "dependencies" ||
      field === "optionalDependencies" ||
      (field === "peerDependencies" && !optionalPeer(m, name));
    if (required && target.manifest.private === true)
      problems.push(
        `${at}: ${field}.${name} is a private package, which is never published`,
      );
  }
  return problems;
}

/** An exact semver version (`3.0.0`, `3.0.0-rc.0`); not checked with Bun.semver (oven-sh/bun#47908). */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i;

/** The tag a version publishes to by default: `next` for a prerelease, `latest` otherwise. */
export function defaultTag(version: string): string {
  return version.includes("-") ? "next" : "latest";
}

/** What is wrong with publishing `version` under `tag`, one line each. */
export function tagProblems(tag: string, version: string): string[] {
  const problems: string[] = [];
  if (!/^[a-z][\w.-]*$/i.test(tag))
    problems.push(`--tag ${tag}: a tag is a word, such as next or latest`);
  // Read by its shape, not by Bun.semver.satisfies: Bun answers true for any
  // string that is not a range, `next` included (oven-sh/bun#47908,
  // docs/bun-bugs/semver-satisfies-non-range.md).
  else if (/^v?\d/.test(tag))
    problems.push(
      `--tag ${tag}: npm refuses a tag that reads as a version or range`,
    );
  if (tag === "latest" && version.includes("-"))
    problems.push(
      `--tag latest for the prerelease ${version}: publish it to next, and point latest at it ` +
        `afterwards with npm dist-tag add if that is really wanted`,
    );
  return problems;
}

/** The answer of one {@link Registry.publish}. */
export interface PublishResult {
  /** True when npm exited 0. */
  ok: boolean;
  /** True when npm refused the one-time code (missing, wrong or expired: `EOTP`). */
  otpError: boolean;
  /** npm's output, stdout then stderr. */
  output: string;
}

/** The registry operations the script runs; npm's CLI by default ({@link npmRegistry}), a fake in tests. */
export interface Registry {
  /** The logged-in user, or `undefined` when nobody is (`npm whoami`). */
  whoami: () => Promise<string | undefined>;
  /** True when `name@version` is on the registry (`npm view`). Throws when the registry cannot say. */
  isPublished: (name: string, version: string) => Promise<boolean>;
  /** The version `tag` points at, or `undefined` (`npm view <name>@<tag> version`). */
  distTag: (name: string, tag: string) => Promise<string | undefined>;
  /** `npm publish <tarball>`, for real or with `--dry-run`. */
  publish: (
    tarball: string,
    options: {
      /** The dist-tag to publish to. */
      tag: string;
      /** The one-time code, or `undefined` for none. Never logged. */
      otp: string | undefined;
      /** True for `npm publish --dry-run`. */
      dryRun: boolean;
    },
  ) => Promise<PublishResult>;
}

/** A command's exit code and combined output. */
export interface CommandResult {
  /** The exit code. */
  code: number;
  /** stdout, then stderr. */
  out: string;
}

/** Everything {@link runPublish} does outside its own logic, injected so tests reach no registry, prompt, git or GitHub. */
export interface PublishIo {
  /** The registry. */
  registry: Registry;
  /** Packs the member in `dir` (absolute) into `dest`; the tarball's path. */
  pack: (dir: string, dest: string) => string;
  /** Asks for the one-time code without echoing it; `""` when none is given. */
  promptOtp: (question: string) => Promise<string>;
  /** Runs `git <args>` in the root. */
  git: (args: string[]) => Promise<CommandResult>;
  /** Runs `gh <args>` in the root. */
  gh: (args: string[]) => Promise<CommandResult>;
  /** Waits between retries of a network command. */
  sleep: (ms: number) => Promise<void>;
  /** Prints one line. */
  log: (line: string) => void;
}

/** What {@link runPublish} was asked. */
export interface PublishOptions {
  /** The repository root (the workspace's). */
  root: string;
  /** True for a rehearsal: `npm publish --dry-run`, no code asked. Default false. */
  dryRun?: boolean;
  /** The dist-tag; default {@link defaultTag} of the version. */
  tag?: string;
  /** The one-time code (`--otp`), `false` for an account without one (`--no-otp`), or `undefined` to ask. */
  otp?: string | false;
  /** Go on with a dirty tree; only with `dryRun`. Default false. */
  allowDirty?: boolean;
  /** Skip `npm whoami`; only with `dryRun`. Default false. */
  skipWhoami?: boolean;
  /** Where the tarballs go; default a new directory under the OS temp dir. */
  work?: string;
  /** How many codes to try per package before stopping. Default 3. */
  otpAttempts?: number;
  /** Skip the tag, its push and the GitHub release (`--no-release`). Default false. */
  noRelease?: boolean;
  /** How many times a network command (push, ls-remote, gh) is tried. Default 3. */
  networkAttempts?: number;
}

/** What {@link runPublish} did. */
export interface PublishReport {
  /** The version published. */
  version: string;
  /** The dist-tag used. */
  tag: string;
  /** Every publishable package, in publish order. */
  order: string[];
  /** Those already on the registry, not packed or published again. */
  skipped: string[];
  /** Those published (or, in a dry run, rehearsed). */
  published: string[];
  /** Those not published because of a failure: the failed one first. */
  notPublished: string[];
  /** Where the tarballs are. */
  work: string;
  /** True when every package is on the registry (or rehearsed) at the end, and the release step (if any) succeeded. */
  ok: boolean;
  /** The release step: done, already done, skipped (`--no-release`), printed (dry run), failed or not reached. */
  release: "created" | "skipped" | "dry-run" | "failed" | "not-reached";
}

/** Reads and parses a JSON file. */
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Replaces every occurrence of the code in `text`, so npm's output can be printed. */
function redact(text: string, otp: string | undefined): string {
  return otp ? text.replaceAll(otp, "<otp>") : text;
}

/**
 * The publish, from discovery to verification (see the file's comment).
 * Throws a {@link PublishRefusal} before anything is packed when a
 * precondition fails; answers a report otherwise.
 */
export async function runPublish(
  options: PublishOptions,
  io: PublishIo,
): Promise<PublishReport> {
  const root = resolve(options.root);
  const dryRun = options.dryRun === true;
  const log = io.log;

  // 1. Discovery and each package's requirements.
  const lerna = readJson<{ version?: string }>(join(root, "lerna.json"));
  const version = lerna.version;
  if (!version || !EXACT_VERSION.test(version))
    throw new PublishRefusal([`lerna.json: no exact "version" (${version})`]);
  const members = discoverMembers(root);
  const publishable = members.filter((m) => m.manifest.private !== true);
  if (publishable.length === 0)
    throw new PublishRefusal(["no workspace package is publishable"]);

  // 2. Preconditions.
  const reasons = publishable.flatMap((m) =>
    memberProblems(root, m, version, members),
  );
  const tag = options.tag ?? defaultTag(version);
  reasons.push(...tagProblems(tag, version));
  if (options.allowDirty && !dryRun)
    reasons.push("--allow-dirty is only for --dry-run");
  if (options.skipWhoami && !dryRun)
    reasons.push("--skip-whoami is only for --dry-run");
  const dirty = (await io.git(["status", "--porcelain"])).out.trimEnd();
  if (dirty && !(dryRun && options.allowDirty))
    reasons.push(
      `the tree is not clean (git status --porcelain):\n${dirty
        .split("\n")
        .slice(0, 10)
        .map((l) => `    ${l}`)
        .join("\n")}`,
    );
  const changelogPath = join(root, "CHANGELOG.md");
  const notes = existsSync(changelogPath)
    ? entryBody(readFileSync(changelogPath, "utf8"), version)
    : undefined;
  if (notes === undefined)
    reasons.push(
      `CHANGELOG.md has no entry for ${version}: bun scripts/changelog.ts ${version} writes one (commit it first)`,
    );
  if (reasons.length > 0) throw new PublishRefusal(reasons);
  if (dirty) log(`dirty tree allowed (--dry-run --allow-dirty)`);
  const release = options.noRelease
    ? undefined
    : await releasePreconditions(version, io, options.networkAttempts ?? 3);
  if (options.skipWhoami) log("npm whoami: skipped (--dry-run --skip-whoami)");
  else {
    const user = await io.registry.whoami();
    if (!user)
      throw new PublishRefusal([
        "npm whoami: not logged in. Run npm login first (the script never logs in).",
      ]);
    log(`npm whoami: ${user}`);
  }
  log(
    `version ${version} (lerna.json), tag ${tag}${options.tag ? "" : " (default)"}${dryRun ? ", DRY RUN" : ""}`,
  );

  // 3. Order.
  const order = publishOrder(publishable);
  const names = new Set(order.map((m) => m.manifest.name!));
  log("publish order (dependencies and required peers first):");
  order.forEach((m, i) => {
    const deps = internalDependencies(m, names);
    log(
      `  ${i + 1}. ${m.manifest.name}${deps.length ? `  after ${deps.join(", ")}` : ""}`,
    );
  });

  // 4. What the registry already has.
  const known = await Promise.all(
    order.map((m) => io.registry.isPublished(m.manifest.name!, version)),
  );
  const skipped = order.filter((_, i) => known[i]).map((m) => m.manifest.name!);
  const todo = order.filter((_, i) => !known[i]);
  for (const name of skipped)
    log(`  skip ${name}@${version}: already on the registry`);
  const report: PublishReport = {
    version,
    tag,
    order: order.map((m) => m.manifest.name!),
    skipped,
    published: [],
    notPublished: [],
    work: "",
    ok: false,
    release: "not-reached",
  };
  // A work directory the run made itself (not `options.work`) is removed once
  // a real run has published everything: its tarballs are on the registry.
  // A failed run keeps it, to inspect the tarballs; a dry run keeps it, for
  // its release notes.
  const madeWork = options.work === undefined;
  const finish = async (work: string): Promise<PublishReport> => {
    const done = await finishRun(work);
    if (madeWork && !dryRun && done.ok) {
      rmSync(work, { recursive: true, force: true });
      log(`removed the work directory ${work}`);
      done.work = "";
    } else if (madeWork) {
      log(`kept the work directory ${work} (remove it when done)`);
    }
    return done;
  };
  const finishRun = async (work: string): Promise<PublishReport> => {
    await verify(report, dryRun, io);
    if (!release) {
      report.release = "skipped";
      log("tag and GitHub release: skipped (--no-release)");
      return report;
    }
    report.release = await releaseStep(
      {
        ...release,
        version,
        notes: notes!,
        packages: report.order,
        work,
        dryRun,
      },
      io,
      options.networkAttempts ?? 3,
    );
    report.ok = report.release !== "failed";
    return report;
  };
  if (todo.length === 0) {
    log(`nothing to publish: every package is on the registry at ${version}`);
    report.ok = true;
    const work = resolve(
      options.work ?? mkdtempSync(join(tmpdir(), `publish-${version}-`)),
    );
    mkdirSync(work, { recursive: true });
    report.work = work;
    return finish(work);
  }

  // 5. Pack and guard everything before asking for a code.
  const work = resolve(
    options.work ?? mkdtempSync(join(tmpdir(), `publish-${version}-`)),
  );
  mkdirSync(work, { recursive: true });
  report.work = work;
  log(`packing ${todo.length} package(s) into ${work}`);
  const tarballs = new Map<string, string>();
  const packProblems: string[] = [];
  for (const m of todo) {
    const tarball = io.pack(join(root, m.dir), work);
    tarballs.set(m.manifest.name!, tarball);
    const problems = guardTarball(tarball, {
      name: m.manifest.name,
      version,
      internal: names,
    });
    log(
      `  ${problems.length === 0 ? "ok  " : "FAIL"} ${m.manifest.name} -> ${tarball}`,
    );
    packProblems.push(...problems.map((p) => `${m.manifest.name}: ${p}`));
  }
  if (packProblems.length > 0) throw new PublishRefusal(packProblems);

  // 6. One code, then the uploads in order.
  let otp: string | undefined;
  if (!dryRun && options.otp !== false) {
    otp =
      options.otp || (await io.promptOtp("npm one-time code: ")) || undefined;
    if (!otp)
      throw new PublishRefusal([
        "no one-time code given (--no-otp for an account without two-factor authentication)",
      ]);
  }
  const attempts = options.otpAttempts ?? 3;
  for (const [i, m] of todo.entries()) {
    const name = m.manifest.name!;
    const tarball = tarballs.get(name)!;
    for (let attempt = 1; ; attempt++) {
      const result = await io.registry.publish(tarball, { tag, otp, dryRun });
      if (result.ok) {
        report.published.push(name);
        log(
          `  ${dryRun ? "rehearsed" : "published"} ${name}@${version} (${tag})`,
        );
        break;
      }
      if (result.otpError && !dryRun && attempt < attempts) {
        log(`  ${name}: npm refused the one-time code (EOTP); enter a new one`);
        otp = (await io.promptOtp("npm one-time code: ")) || undefined;
        if (otp) continue;
        log("  no code given");
      }
      log(`  FAILED ${name}@${version}:`);
      for (const line of redact(result.output, otp)
        .trim()
        .split("\n")
        .slice(-20))
        log(`    ${line}`);
      report.notPublished = todo.slice(i).map((t) => t.manifest.name!);
      log(
        `published: ${report.published.join(", ") || "none"}${skipped.length ? ` (already there: ${skipped.join(", ")})` : ""}`,
      );
      log(`not published: ${report.notPublished.join(", ")}`);
      log(
        "fix the cause and run the script again: it skips what is already published",
      );
      return report;
    }
  }
  report.ok = true;

  // 7 and 8. Verification, then the tag and the GitHub release.
  return finish(work);
}

/** Checks each package's tag on the registry after a real publish; prints the commands after a dry run. */
async function verify(
  report: PublishReport,
  dryRun: boolean,
  io: PublishIo,
): Promise<void> {
  if (!dryRun) {
    io.log(`verification (npm view <name>@${report.tag} version):`);
    for (const name of report.order) {
      const at = await io.registry.distTag(name, report.tag);
      io.log(
        `  ${at === report.version ? "ok      " : "MISMATCH"} ${name}@${report.tag} = ${at ?? "none"}${at === report.version ? "" : " (the registry can lag a minute; re-check before acting)"}`,
      );
    }
  } else {
    io.log(`after the real publish, verify with:`);
    for (const name of report.order)
      io.log(`  npm view ${name}@${report.tag} version`);
  }
}

/** What {@link releasePreconditions} found, for {@link releaseStep}. */
export interface ReleaseState {
  /** HEAD's commit. */
  head: string;
  /** True when `v<version>` exists locally (at HEAD). */
  localTag: boolean;
  /** True when origin has `v<version>` (at HEAD). */
  remoteTag: boolean;
  /** The repository on GitHub (`owner/repo`), from origin's URL. */
  repo: string;
}

/** Runs a network command up to `attempts` times, waiting longer each time; the last result. */
async function retry(
  attempts: number,
  io: PublishIo,
  run: () => Promise<CommandResult>,
): Promise<CommandResult> {
  let result: CommandResult = { code: 1, out: "" };
  for (let i = 1; i <= attempts; i++) {
    result = await run();
    if (result.code === 0) return result;
    if (i < attempts) await io.sleep(5000 * i);
  }
  return result;
}

/** The commit a tag's ls-remote lines name: the peeled `^{}` line's when there is one. */
export function remoteTagCommit(
  lsRemote: string,
  tag: string,
): string | undefined {
  let plain: string | undefined;
  for (const line of lsRemote.split("\n")) {
    const [hash, ref] = line.trim().split(/\s+/);
    if (ref === `refs/tags/${tag}^{}`) return hash;
    if (ref === `refs/tags/${tag}`) plain = hash;
  }
  return plain;
}

/**
 * The release step's preconditions, before anything is packed: gh logged in
 * with push access to origin's repository, and no `v<version>` tag at another
 * commit, locally or on origin. Throws a {@link PublishRefusal}.
 */
export async function releasePreconditions(
  version: string,
  io: PublishIo,
  attempts: number,
): Promise<ReleaseState> {
  const tag = `v${version}`;
  const head = (await io.git(["rev-parse", "HEAD"])).out.trim();
  const origin = await io.git(["remote", "get-url", "origin"]);
  const url = origin.code === 0 ? githubUrl(origin.out) : undefined;
  if (!url)
    throw new PublishRefusal([
      `origin is not a GitHub remote (${origin.out.trim() || "none"}); --no-release skips the tag and release`,
    ]);
  const repo = url.replace("https://github.com/", "");
  const auth = await io.gh(["auth", "status"]);
  if (auth.code !== 0)
    throw new PublishRefusal([
      `gh is not logged in (gh auth status): ${auth.out.trim().split("\n")[0] ?? ""}. ` +
        `Log in, or pass a token (GH_TOKEN=$(gh auth token --user <you>)), or --no-release`,
    ]);
  const login = (
    await retry(attempts, io, () => io.gh(["api", "user", "--jq", ".login"]))
  ).out.trim();
  const push = await retry(attempts, io, () =>
    io.gh(["api", `repos/${repo}`, "--jq", ".permissions.push"]),
  );
  if (push.code !== 0 || push.out.trim() !== "true")
    throw new PublishRefusal([
      `the active gh account (${login || "unknown"}) cannot push to ${repo}${push.code === 0 ? "" : ` (gh api failed: ${push.out.trim().split("\n")[0]})`}: ` +
        `switch with GH_TOKEN=$(gh auth token --user <owner>) for this command, or --no-release`,
    ]);
  const local = await io.git([
    "rev-parse",
    "-q",
    "--verify",
    `refs/tags/${tag}^{commit}`,
  ]);
  const localCommit = local.code === 0 ? local.out.trim() : undefined;
  if (localCommit && localCommit !== head)
    throw new PublishRefusal([
      `the tag ${tag} exists locally at ${localCommit}, not HEAD (${head})`,
    ]);
  const remote = await retry(attempts, io, () =>
    io.git([
      "ls-remote",
      "--tags",
      "origin",
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
    ]),
  );
  if (remote.code !== 0)
    throw new PublishRefusal([
      `could not read origin's tags after ${attempts} attempts (git ls-remote --tags origin): ${remote.out.trim().split("\n")[0] ?? ""}. ` +
        `Nothing is published yet: run again, or --no-release`,
    ]);
  const remoteCommit = remoteTagCommit(remote.out, tag);
  if (remoteCommit && remoteCommit !== head)
    throw new PublishRefusal([
      `origin's tag ${tag} is at ${remoteCommit}, not HEAD (${head})`,
    ]);
  const signing =
    (await io.git(["config", "gpg.format"])).out.trim() || "openpgp";
  io.log(
    `release: gh as ${login}, ${repo}; tag ${tag} ${localCommit ? "exists locally" : "to create"} (signed, gpg.format ${signing}), ${remoteCommit ? "on origin" : "to push"}`,
  );
  return {
    head,
    localTag: localCommit !== undefined,
    remoteTag: remoteCommit !== undefined,
    repo,
  };
}

/** The GitHub release's notes: the CHANGELOG entry, then an npm link per package. */
export function releaseNotes(
  notes: string,
  packages: string[],
  version: string,
): string {
  const links = packages.map(
    (name) =>
      `- [${name}@${version}](https://www.npmjs.com/package/${name}/v/${version})`,
  );
  return `${notes.trim()}\n\n### npm\n\n${links.join("\n")}\n`;
}

/**
 * The tag, its push and the GitHub release, each skipped when already done;
 * printed, not run, in a dry run. Answers how it went; on a failure it has
 * printed the commands that finish the job.
 */
export async function releaseStep(
  input: ReleaseState & {
    /** The version released. */
    version: string;
    /** The CHANGELOG entry's body. */
    notes: string;
    /** Every package at the version, in publish order. */
    packages: string[];
    /** Where the notes file is written. */
    work: string;
    /** True to print the commands instead. */
    dryRun: boolean;
  },
  io: PublishIo,
  attempts: number,
): Promise<"created" | "dry-run" | "failed"> {
  const tag = `v${input.version}`;
  const prerelease = input.version.includes("-");
  const notesFile = join(input.work, `release-notes-${tag}.md`);
  const tagArgs = ["tag", "-s", "-a", tag, "-m", tag, input.head];
  const pushArgs = ["push", "origin", `refs/tags/${tag}`];
  const releaseArgs = [
    "release",
    "create",
    tag,
    "--title",
    tag,
    "--notes-file",
    notesFile,
    "--verify-tag",
    ...(prerelease ? ["--prerelease"] : []),
  ];
  const show = (cmd: string, args: string[]) => `${cmd} ${args.join(" ")}`;
  writeFileSync(
    notesFile,
    releaseNotes(input.notes, input.packages, input.version),
  );
  if (input.dryRun) {
    io.log(`release notes: ${notesFile}`);
    io.log("release (dry run; would run):");
    if (!input.localTag) io.log(`  ${show("git", tagArgs)}`);
    if (!input.remoteTag) io.log(`  ${show("git", pushArgs)}`);
    io.log(`  ${show("gh", releaseArgs)}  (unless the release exists)`);
    return "dry-run";
  }
  const left = [
    ...(input.localTag ? [] : [show("git", tagArgs)]),
    ...(input.remoteTag ? [] : [show("git", pushArgs)]),
    `gh ${releaseArgs.join(" ")}`,
  ];
  const fail = (what: string, out: string) => {
    io.log(`release: ${what} failed:`);
    for (const line of out.trim().split("\n").slice(-10)) io.log(`    ${line}`);
    io.log("every package is published; finish the release with:");
    for (const cmd of left) io.log(`  ${cmd}`);
    io.log(
      "(or run this script again: it skips what is published and what is done)",
    );
    return "failed" as const;
  };
  if (!input.localTag) {
    const r = await io.git(tagArgs);
    if (r.code !== 0) return fail(`git tag -s ${tag}`, r.out);
    io.log(`release: tagged ${tag} (signed)`);
    left.shift();
  }
  if (!input.remoteTag) {
    const r = await retry(attempts, io, () => io.git(pushArgs));
    if (r.code !== 0)
      return fail(`git push origin ${tag} (${attempts} attempts)`, r.out);
    io.log(`release: pushed ${tag} to origin`);
    left.shift();
  }
  const exists = await retry(attempts, io, () =>
    io.gh(["release", "view", tag, "--json", "tagName"]),
  );
  if (exists.code === 0) {
    io.log(`release: the GitHub release ${tag} exists already`);
    return "created";
  }
  const r = await retry(attempts, io, () => io.gh(releaseArgs));
  if (r.code !== 0)
    return fail(`gh release create ${tag} (${attempts} attempts)`, r.out);
  io.log(
    `release: GitHub release ${tag}${prerelease ? " (prerelease)" : ""}: ${r.out.trim().split("\n").at(-1) ?? ""}`,
  );
  return "created";
}

/** Runs npm with `args` in a directory outside any workspace; exit code and output. */
async function npm(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; output: string }> {
  // From the repo, npm reads the root's `workspaces` and refuses some
  // commands (`ENOWORKSPACES`), so it runs from the temp dir.
  const proc = Bun.spawn(["npm", ...args], {
    cwd: tmpdir(),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, output: `${stdout}${stderr}` };
}

/** npm's EOTP: a one-time code is needed, or the one given was wrong or expired. */
export function isOtpError(output: string): boolean {
  return /\bEOTP\b|one-time pass(?:word|code)?/i.test(output);
}

/** The {@link Registry} on npm's CLI, against `registry` (the packages' `publishConfig.registry`). */
export function npmRegistry(registry?: string): Registry {
  const at = registry ? ["--registry", registry] : [];
  return {
    async whoami() {
      const r = await npm(["whoami", ...at]);
      return r.code === 0 ? r.stdout.trim() || undefined : undefined;
    },
    async isPublished(name, version) {
      const r = await npm(["view", `${name}@${version}`, "version", ...at]);
      if (r.code === 0) return r.stdout.trim() === version;
      if (/\bE404\b|404 Not Found/.test(r.output)) return false;
      throw new Error(`npm view ${name}@${version} failed:\n${r.output}`);
    },
    async distTag(name, tag) {
      const r = await npm(["view", `${name}@${tag}`, "version", ...at]);
      return r.code === 0 ? r.stdout.trim() || undefined : undefined;
    },
    async publish(tarball, { tag, otp, dryRun }) {
      const r = await npm(
        [
          "publish",
          tarball,
          "--tag",
          tag,
          "--access",
          "public",
          ...at,
          ...(dryRun ? ["--dry-run"] : []),
        ],
        // The code goes in npm's environment, not its argv, which `ps` shows.
        otp ? { npm_config_otp: otp } : {},
      );
      return {
        ok: r.code === 0,
        otpError: isOtpError(r.output),
        output: r.output,
      };
    },
  };
}

/**
 * `bun pm pack` of `dir` into `dest`; the tarball's path. Build outputs the
 * `prepack` created (a `files` entry absent before, such as `dts/` or
 * `dist/`) are removed afterwards, since a stale `dist/` is what `jobsUi()`
 * serves in the repo.
 */
export function bunPack(dir: string, dest: string): string {
  const manifest = readJson<Manifest>(join(dir, "package.json"));
  const created = (manifest.files ?? []).filter(
    (f) => !existsSync(join(dir, f)),
  );
  const before = new Set(readdirSync(dest));
  const r = Bun.spawnSync({
    cmd: [process.execPath, "pm", "pack", "--destination", dest, "--quiet"],
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const f of created)
    rmSync(join(dir, f), { recursive: true, force: true });
  if (r.exitCode !== 0)
    throw new Error(
      `bun pm pack in ${dir} failed:\n${r.stdout.toString()}${r.stderr.toString()}`,
    );
  const tgz = readdirSync(dest).filter(
    (f) => f.endsWith(".tgz") && !before.has(f),
  );
  if (tgz.length !== 1)
    throw new Error(
      `expected one tarball from ${dir}, got ${tgz.join(", ") || "none"}`,
    );
  return join(dest, tgz[0]);
}

/** Runs a command in `cwd`; its exit code and combined output. */
async function command(cmd: string[], cwd: string): Promise<CommandResult> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: `${stdout}${stderr}` };
}

/** Reads a line from the terminal without echoing it; `""` on Enter alone. Refuses without a terminal. */
export async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY)
    throw new PublishRefusal([
      "no terminal to ask for the one-time code on: pass --otp <code> (or --no-otp)",
    ]);
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolveCode, reject) => {
    let value = "";
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          finish();
          resolveCode(value.trim());
          return;
        }
        if (ch === "\u0003") {
          finish();
          reject(new PublishRefusal(["interrupted"]));
          return;
        }
        if (ch === "\u007F" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    function finish(): void {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    }
    stdin.on("data", onData);
  });
}

/** Parses the command line into {@link PublishOptions}; throws a {@link PublishRefusal} on a bad one. */
export function parseArgs(argv: string[], root: string): PublishOptions {
  const options: PublishOptions = { root };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--"))
        throw new PublishRefusal([`${arg} needs a value`]);
      return v;
    };
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--tag") options.tag = value();
    else if (arg === "--otp") options.otp = value();
    else if (arg === "--no-otp") options.otp = false;
    else if (arg === "--allow-dirty") options.allowDirty = true;
    else if (arg === "--skip-whoami") options.skipWhoami = true;
    else if (arg === "--work") options.work = resolve(value());
    else if (arg === "--no-release") options.noRelease = true;
    else throw new PublishRefusal([`unknown argument ${arg} (see --help)`]);
  }
  return options;
}

const USAGE = `usage: bun scripts/publish.ts [--dry-run] [--tag <tag>] [--otp <code> | --no-otp]
                              [--allow-dirty] [--skip-whoami] [--no-release] [--work <dir>]

  --dry-run      pack, guard and npm publish --dry-run; no code asked, nothing uploaded
  --tag <tag>    the dist-tag (default: next for a prerelease, latest otherwise)
  --otp <code>   the one-time code, instead of the prompt (prefer the prompt: argv shows in ps and history)
  --no-otp       the account has no two-factor authentication
  --allow-dirty  with --dry-run: go on with uncommitted changes
  --skip-whoami  with --dry-run: do not require npm login
  --no-release   do not tag v<version>, push the tag or create the GitHub release
  --work <dir>   where the tarballs go (default: a new temp directory)`;

if (import.meta.main) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  const root = resolve(import.meta.dir, "..");
  try {
    const options = parseArgs(process.argv.slice(2), root);
    const first = discoverMembers(root).find(
      (m) => m.manifest.private !== true,
    );
    const report = await runPublish(options, {
      registry: npmRegistry(first?.manifest.publishConfig?.registry),
      pack: bunPack,
      promptOtp: promptHidden,
      git: (args) => command(["git", ...args], root),
      gh: (args) => command(["gh", ...args], root),
      sleep: (ms) => Bun.sleep(ms),
      log: (line) => console.log(line),
    });
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    if (!(error instanceof PublishRefusal)) throw error;
    console.error("publish refused:");
    for (const reason of error.reasons) console.error(`  - ${reason}`);
    process.exit(1);
  }
}
