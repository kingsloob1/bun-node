#!/usr/bin/env bun
/**
 * Consumer check: what a *published* package looks like to the people who
 * install it.
 *
 * Every in-repo check resolves a package through the workspace symlink, so it
 * sees `lib/`, the repo's own `tsconfig.base.json` and every devDependency. A
 * consumer sees none of that — only the tarball, its declared dependencies and
 * their own compiler options. This script reproduces that view:
 *
 * 1. packs the package (and any workspace packages it depends on) with
 *    `bun pm pack`, exactly as a publish would, `prepack` included;
 * 2. installs the tarballs into a throwaway consumer project outside the repo;
 * 3. type-checks one probe file per import spelling, under every
 *    `moduleResolution` × `skipLibCheck` combination, and asserts that the
 *    names the spelling should export are real types rather than a silent
 *    `any`;
 * 4. imports every runtime spelling under Bun, so the `exports` map is proven
 *    to resolve at runtime and not only for the type checker;
 * 5. scans the shipped declarations for imports of packages a consumer is not
 *    guaranteed to have (optional peers, undeclared packages).
 *
 * Every tarball first goes through the pack guard (`scripts/pack-guard.ts`):
 * one whose `package.json` still names `workspace:` or `catalog:` fails the
 * run before anything is installed.
 *
 * ```bash
 * bun scripts/consumer-check.ts packages/bun-common                      # run, print the table
 * bun scripts/consumer-check.ts packages/bun-common --save base.json     # record a baseline
 * bun scripts/consumer-check.ts packages/bun-common --baseline base.json # fail on any problem not in the baseline
 * bun scripts/consumer-check.ts packages/bun-common --tarball x.tgz      # check a pre-packed tarball
 * bun scripts/consumer-check.ts packages/bun-common --typescript 5.9.3   # a different compiler
 * bun scripts/consumer-check.ts --show after.json --baseline base.json   # re-print a saved run
 * bun scripts/consumer-check.ts packages/bun-common --work ~/dir         # a work directory of your own
 * ```
 *
 * Without `--work`, each run packs and installs in a fresh directory of its
 * own under `~/.cache/consumer-check/` ({@link resolveWorkDir}), removed when
 * the run passes and kept, with its path printed, when it fails.
 *
 * The package supplies its own spellings in `<package>/consumer-check.json`
 * (see {@link CheckConfig}), so bun-common, bun-nest, bun-jobs and
 * bun-jobs-ui all run this script unchanged.
 *
 * Optional peers get one consumer per distinct peer set ({@link planConsumers}).
 * Entries without `peers` are checked in a `consumer/` that has none of the
 * package's optional peers installed (a workspace dependency or consumer
 * dependency that is an optional peer is left out of it), so a root that
 * reaches one fails there. An entry with `peers` is checked in a
 * `consumer-peers-<set>/` that has exactly the optional peers it lists and none
 * of the others, so an entry scoped to one peer that silently needs another
 * fails too. Entries listing the same set share one install.
 *
 * A cell is `OK` only with zero diagnostics anywhere, and only `OK` passes:
 * a cell in any other status (`UNRESOLVED`, `ANY`, `PROBE-ERRORS`,
 * `LIB-ERRORS`), a runtime import that fails, a leaked import and a browser
 * environment leak each fail the run (see {@link failures}). `PROBE-ERRORS` in
 * particular means the probe snippet itself does not type-check, which hides
 * whatever it was meant to assert, so it is never ignored. With `--baseline`, a
 * problem the baseline already had in the same status is known and does not
 * fail; a cell that was `OK` and no longer is, or a runtime import that worked
 * and no longer does, is `NEW-BROKEN`; that is the acceptance rule for any
 * packaging change.
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
import { builtinModules } from "node:module";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import process from "node:process";
import ts from "typescript";
import { guardTarball } from "./pack-guard";

/** One import spelling a consumer may write. */
export interface EntryConfig {
  /** The module specifier exactly as a consumer writes it, e.g. `@scope/pkg/lib/utils/native`. */
  spelling: string;
  /** Value exports that must resolve to a non-`any` type (and, at runtime, to something defined). */
  values?: string[];
  /** Type-only exports that must resolve to a non-`any` type. */
  types?: string[];
  /**
   * Extra TypeScript appended to the probe, with the module bound as `m`
   * (values) and `t` (types), and `Expect`/`IsAny`/`Equal` in scope. Use it
   * for deep assertions, e.g. that a route handler's `req.params` is inferred.
   */
  snippet?: string;
  /**
   * Browser-safe entry: also checked with `types: []` and
   * `lib: ["dom", "es2022"]`, and fails if its type graph loads Node or Bun
   * type declarations. Default `false`.
   */
  browser?: boolean;
  /** Import it under Bun as well. Default `true`; turn off for type-only modules. */
  runtime?: boolean;
  /**
   * Optional peers this entry legitimately needs (e.g. bun-nest's `./jobs`
   * needs `@kingsleyweb/bun-jobs`). The entry is checked in a consumer that
   * has exactly these optional peers installed and none of the package's
   * others, which proves it needs no peer it does not list; every entry
   * without `peers` is checked in one that has none of them, which is what
   * proves the root does not reach them. The build's verify step reads the
   * same field.
   */
  peers?: string[];
}

/** `<package>/consumer-check.json`. */
export interface CheckConfig {
  /**
   * Other workspace packages (paths relative to the repo root) this package
   * depends on. They are packed too and installed from their tarballs, so
   * the consumer never fetches a published version of a sibling instead.
   */
  workspaceDependencies?: string[];
  /** Extra packages the consumer installs, as `name@range` (e.g. a peer the entries need). */
  consumerDependencies?: string[];
  /** The import spellings to check. */
  entries: EntryConfig[];
}

/** How one cell of the matrix came out. */
export type CellStatus =
  | "OK" // no diagnostics at all
  | "UNRESOLVED" // the spelling does not resolve (TS2307 and friends in the probe)
  | "ANY" // resolves, but a probed name is `any` or missing
  | "PROBE-ERRORS" // other errors in the probe file (e.g. a failed deep assertion)
  | "LIB-ERRORS"; // the probe is clean, but errors surface inside installed packages

/** One (spelling, resolution, skipLibCheck, environment) result. */
export interface CellResult {
  /** Stable key used to compare against a baseline. */
  key: string;
  /** The spelling this cell probes. */
  spelling: string;
  /** Column label, e.g. `bundler/slc` or `node16/strict` or `browser/strict`. */
  column: string;
  /** The classification. */
  status: CellStatus;
  /** Diagnostics inside the probe file. */
  probeErrors: number;
  /** Diagnostics inside installed packages (`node_modules/**`). */
  libErrors: number;
  /** The first few diagnostic lines, for the report. */
  sample: string[];
  /** Node/Bun type files the graph loaded (browser cells only). */
  envLeaks?: string[];
}

/** Everything a run produced; what `--save` writes and `--baseline` reads. */
export interface RunResult {
  /** Package name under test. */
  package: string;
  /** TypeScript version used. */
  typescript: string;
  /** Matrix cells. */
  cells: CellResult[];
  /** Runtime import results under Bun, per spelling: `"ok"` or the error text. */
  runtime: Record<string, string>;
  /** Shipped declarations importing a package the consumer may not have. */
  leaks: string[];
  /** Spellings checked in the consumer with optional peers, and which peers. Absent in older runs. */
  peerScoped?: Record<string, string[]>;
  /** The consumers the run installed, one per optional-peer set, with their install time. Absent in older runs. */
  consumers?: InstalledConsumer[];
}

/** One consumer project a run installs: the optional peers it has and the spellings checked in it. */
export interface ConsumerPlan {
  /** Its directory under the work directory: `consumer`, or `consumer-peers-<set>`. */
  name: string;
  /** The package's optional peers installed in it, sorted; empty for the peerless `consumer`. */
  peers: string[];
  /** The spellings checked in it, in `consumer-check.json` order. */
  spellings: string[];
}

/** A {@link ConsumerPlan} after its install. */
export interface InstalledConsumer extends ConsumerPlan {
  /** Wall time of its `bun install`, in seconds. */
  installSeconds: number;
}

/** Chooses the consumers for a run's entries; {@link planConsumers} unless a test supplies its own. */
export type ConsumerPlanner = (
  entries: EntryConfig[],
  optionalPeers: Set<string>,
) => ConsumerPlan[];

const REPO_ROOT = resolve(import.meta.dir, "..");

/** Reads `--flag value`. */
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Runs a command, returning combined output; throws on failure unless `allowFail`. */
function run(
  cmd: string[],
  cwd: string,
  allowFail = false,
): { code: number; out: string } {
  const r = Bun.spawnSync({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  const out = `${r.stdout.toString()}${r.stderr.toString()}`;
  if (r.exitCode !== 0 && !allowFail) {
    throw new Error(`${cmd.join(" ")} (in ${cwd}) failed:\n${out}`);
  }
  return { code: r.exitCode ?? 1, out };
}

/** Packs a workspace package with `bun pm pack` into `dest`; returns the tarball path. */
function pack(packageDir: string, dest: string): string {
  const before = new Set(readdirSync(dest));
  run(["bun", "pm", "pack", "--destination", dest, "--quiet"], packageDir);
  const created = readdirSync(dest).filter(
    (f) => f.endsWith(".tgz") && !before.has(f),
  );
  if (created.length !== 1)
    throw new Error(
      `expected one tarball from ${packageDir}, got ${created.join(", ")}`,
    );
  return join(dest, created[0]);
}

/** A file-safe id for a spelling. */
function idOf(spelling: string): string {
  return spelling.replace(/^@/, "").replace(/[^\w.-]+/g, "_");
}

/** The compiler options for each column, before `skipLibCheck` is applied. */
const COLUMNS: Record<string, Record<string, unknown>> = {
  // The least a Bun consumer sets: bundler resolution, `strict`, Bun's types.
  bundler: {
    lib: ["ESNext"],
    target: "ESNext",
    module: "Preserve",
    moduleResolution: "bundler",
    noEmit: true,
    strict: true,
    types: ["bun"],
  },
  // What `bun init` writes: bundler resolution plus `noUncheckedIndexedAccess`
  // and `noImplicitOverride`, which raw `.ts` in a package cannot escape.
  "bun-init": {
    lib: ["ESNext"],
    target: "ESNext",
    module: "Preserve",
    moduleDetection: "force",
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: true,
    noEmit: true,
    strict: true,
    noFallthroughCasesInSwitch: true,
    noUncheckedIndexedAccess: true,
    noImplicitOverride: true,
    types: ["bun"],
  },
  // A Node-ESM-shaped consumer (what `tsc --init` users and libraries pick).
  node16: {
    lib: ["ES2022"],
    target: "ES2022",
    module: "Node16",
    moduleResolution: "Node16",
    noEmit: true,
    strict: true,
    types: ["bun"],
  },
  // A browser bundle importing a browser-safe entry: no ambient Node/Bun.
  browser: {
    lib: ["DOM", "ES2022"],
    target: "ES2022",
    module: "Preserve",
    moduleResolution: "bundler",
    noEmit: true,
    strict: true,
    types: [],
  },
};

/** Writes the probe file for one entry. */
function probeSource(entry: EntryConfig): string {
  const lines = [
    `import * as m from ${JSON.stringify(entry.spelling)};`,
    `import type * as t from ${JSON.stringify(entry.spelling)};`,
    // Not the usual `0 extends 1 & T`: a name imported from a module that did
    // not resolve inside a skipLibCheck'd declaration is TypeScript's error
    // type, for which that conditional evaluates to `any`, and `any`
    // satisfies `Expect`. Measured: that version passed a tarball whose
    // `@types/busboy` was missing. Mutual assignability with a unique symbol
    // holds for `any` and the error type alike, and for nothing else.
    `declare const sentinel: unique symbol;`,
    `type IsAny<T> = [T] extends [typeof sentinel] ? ([typeof sentinel] extends [T] ? true : false) : false;`,
    `type Expect<T extends false> = T;`,
    `type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends (<X>() => X extends B ? 1 : 2) ? true : false;`,
    // A namespace that is itself `any` makes every member `any`: assert that first.
    `export type _ns = Expect<IsAny<typeof m>>;`,
  ];
  for (const [i, name] of (entry.values ?? []).entries()) {
    lines.push(`export type _v${i} = Expect<IsAny<typeof m.${name}>>;`);
  }
  for (const [i, name] of (entry.types ?? []).entries()) {
    lines.push(`export type _t${i} = Expect<IsAny<t.${name}>>;`);
  }
  if (entry.snippet) lines.push(entry.snippet);
  return `${lines.join("\n")}\n`;
}

/** Codes meaning "this module specifier did not resolve". */
const UNRESOLVED = new Set(["TS2307", "TS2792", "TS1479", "TS2834", "TS2835"]);

/** Classifies one tsc run. */
function classify(
  output: string,
  probeFile: string,
): Omit<CellResult, "key" | "spelling" | "column"> {
  const errors = output.split("\n").filter((l) => /error TS\d+/.test(l));
  const inProbe = errors.filter((l) => l.startsWith(probeFile));
  const inLib = errors.filter((l) => !l.startsWith(probeFile));
  const codes = new Set(inProbe.map((l) => /error (TS\d+)/.exec(l)?.[1]));
  let status: CellStatus = "OK";
  if ([...codes].some((c) => c && UNRESOLVED.has(c))) status = "UNRESOLVED";
  else if (
    inProbe.length > 0 &&
    [...codes].every(
      (c) =>
        c === "TS2344" ||
        c === "TS2339" ||
        c === "TS2694" ||
        c === "TS2305" ||
        c === "TS2724",
    )
  )
    status = "ANY";
  else if (inProbe.length > 0) status = "PROBE-ERRORS";
  else if (inLib.length > 0) status = "LIB-ERRORS";
  return {
    status,
    probeErrors: inProbe.length,
    libErrors: inLib.length,
    sample: errors.slice(0, 4),
  };
}

/**
 * The bare specifiers a declaration file really imports: `import`/`export …
 * from`, `import x = require()`, `import("x")` type queries, side-effect
 * imports, and `/// <reference types>` directives (which TypeScript honours
 * only at the top of a file, so neither does this).
 *
 * TypeScript's own pre-processor reads them rather than a regex, because tsc
 * copies JSDoc into the declarations it emits and a regex cannot tell code
 * from prose: bun-jobs' `jobCursor.ts` has a doc comment reading
 * `from "ordered by something creation cannot see"`, which a `\bfrom\s*"…"`
 * pattern reported as an import of a package by that name. `preProcessFile`
 * skips comments and the contents of string and template literals. Fixing the
 * scanner rather than the sentence is deliberate: a leak guard that fires on
 * prose gets routed around by rewording comments, and one people route around
 * has stopped guarding.
 *
 * Relative specifiers are left out; they stay inside the package.
 */
export function bareSpecifiers(text: string): string[] {
  const info = ts.preProcessFile(text, true, true);
  const found = new Set<string>();
  for (const f of info.importedFiles)
    if (!f.fileName.startsWith(".")) found.add(f.fileName);
  for (const f of info.typeReferenceDirectives) found.add(f.fileName);
  return [...found];
}

/** The package name a specifier refers to (`@a/b/c` → `@a/b`, `x/y` → `x`). */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * The `package.json` of a consumer: the packed package and its packed
 * workspace siblings as `file:` dependencies, each also an override.
 *
 * The package itself is overridden too, not only depended on: a sibling that
 * depends on it (bun-api-docs-ui on bun-common) would otherwise resolve it
 * from the registry, so the consumer checked a second, published copy. With
 * the ranges at an unpublished version the install fails instead; at a
 * published one (`^2.2.0`, until 3.0.0-rc.0) it passed with that copy.
 */
export function consumerManifest(options: {
  /** The package under test's name. */
  name: string;
  /** The packed package under test, an absolute path. */
  tarball: string;
  /** Workspace siblings to install, name → `file:` spec of their tarball. */
  workspace: Record<string, string>;
  /** Registry dependencies from `consumerDependencies`, name → range. */
  extra: Record<string, string>;
  /** The TypeScript range to install; `--typescript`, else `^6.0.3`. */
  typescript?: string;
}): Record<string, unknown> {
  const own = { [options.name]: `file:${options.tarball}` };
  return {
    name: "consumer-check",
    private: true,
    type: "module",
    dependencies: {
      ...own,
      ...options.workspace,
      "@types/bun": "^1.4.2",
      typescript: options.typescript ?? "^6.0.3",
      ...options.extra,
    },
    overrides: { ...own, ...options.workspace },
  };
}

/** Recursively lists files under `dir` ending in `suffix`. */
function walk(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") out.push(...walk(full, suffix));
    } else if (e.name.endsWith(suffix)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Flags shipped declarations that import something the consumer is not
 * guaranteed to have: an optional peer, or a package the manifest does not
 * declare at all. Node built-ins and Bun's modules are allowed — they are the
 * runtime environment, provided by `@types/bun` (itself an optional peer, so
 * a consumer without it is warned by the package manager).
 */
export function scanLeaks(installed: string, scoped: Set<string>): string[] {
  const pkg = JSON.parse(
    readFileSync(join(installed, "package.json"), "utf8"),
  ) as {
    name: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  const guaranteed = new Set([
    pkg.name,
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}).filter(
      (p) => !pkg.peerDependenciesMeta?.[p]?.optional,
    ),
  ]);
  const env = (s: string) =>
    s.startsWith("node:") ||
    s === "bun" ||
    s.startsWith("bun:") ||
    s === "bun-types" ||
    builtinModules.includes(s);
  const leaks: string[] = [];
  for (const file of walk(installed, ".d.ts")) {
    for (const spec of bareSpecifiers(readFileSync(file, "utf8"))) {
      if (env(spec)) continue;
      const name = packageOf(spec);
      // `@types/x` in dependencies covers an import of `x`.
      const typesName = name.startsWith("@")
        ? `@types/${name.slice(1).replace("/", "__")}`
        : `@types/${name}`;
      if (guaranteed.has(name) || guaranteed.has(typesName)) continue;
      // An optional peer an entry declares is allowed here; the peerless
      // consumer's cells are what prove no other entry reaches it.
      if (pkg.peerDependenciesMeta?.[name]?.optional && scoped.has(name))
        continue;
      const why = pkg.peerDependenciesMeta?.[name]?.optional
        ? "optional peer"
        : "not declared";
      leaks.push(`${relative(installed, file)} imports "${spec}" (${why})`);
    }
  }
  return leaks;
}

/** Runs `tasks` with at most `limit` in flight. */
async function pool<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = Array.from({ length: tasks.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    }),
  );
  return results;
}

/** Where a run packs, installs and checks: the directory and whether this run made it. */
export interface WorkDir {
  /** Absolute path of the work directory. */
  dir: string;
  /** True for a fresh per-run directory (removed after a passing run); false for an explicit `--work`. */
  ephemeral: boolean;
}

/**
 * Chooses the run's work directory. An explicit `--work` is used as given
 * (resolved, never removed at the end). Without one, each run gets a fresh
 * directory of its own under `<cache>/consumer-check/` (`$XDG_CACHE_HOME`, or
 * `~/.cache`; never `/tmp`), so two runs, from two sessions or two packages,
 * cannot collide on one shared default.
 *
 * @param packageDir The package being checked; its name prefixes the directory.
 * @param explicit The `--work` value, when given.
 * @param cacheHome The cache root. Defaults to `$XDG_CACHE_HOME` or `~/.cache`.
 */
export function resolveWorkDir(
  packageDir: string,
  explicit?: string,
  cacheHome: string = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
): WorkDir {
  if (explicit) return { dir: resolve(explicit), ephemeral: false };
  const parent = join(cacheHome, "consumer-check");
  mkdirSync(parent, { recursive: true });
  return {
    dir: mkdtempSync(join(parent, `${basename(packageDir)}-`)),
    ephemeral: true,
  };
}

/**
 * One consumer per distinct optional-peer set. The peerless `consumer` comes
 * first and always exists (the leak scan and the compiler are read from it);
 * then one `consumer-peers-<set>` per distinct sorted set an entry lists, in
 * the order the sets first appear. A listed peer that is not one of the
 * package's optional peers is ignored for the keying, since no consumer
 * differs in it, so an entry listing only such peers shares `consumer`. Two
 * sets whose names would coincide (`a+b` and `a_b` both read `a_b`) get a
 * numbered suffix, so no two consumers share a directory.
 *
 * @param entries The entries of `consumer-check.json`.
 * @param optionalPeers The package's optional peers (`peerDependenciesMeta`).
 */
export function planConsumers(
  entries: EntryConfig[],
  optionalPeers: Set<string>,
): ConsumerPlan[] {
  const plans = new Map<string, ConsumerPlan>([
    ["", { name: "consumer", peers: [], spellings: [] }],
  ]);
  for (const entry of entries) {
    const peers = [
      ...new Set((entry.peers ?? []).filter((p) => optionalPeers.has(p))),
    ].sort();
    const key = peers.join("\n");
    let plan = plans.get(key);
    if (!plan) {
      const base = `consumer-peers-${idOf(peers.join("+"))}`;
      const taken = new Set([...plans.values()].map((p) => p.name));
      let name = base;
      for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
      plan = { name, peers, spellings: [] };
      plans.set(key, plan);
    }
    plan.spellings.push(entry.spelling);
  }
  return [...plans.values()];
}

/**
 * Drops the optional peers a consumer must not have from a set of
 * dependencies: every optional peer of the package except `keep`.
 */
export function withoutOtherPeers(
  deps: Record<string, string>,
  optionalPeers: Set<string>,
  keep: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(deps).filter(
      ([name]) => !optionalPeers.has(name) || keep.includes(name),
    ),
  );
}

/** A tarball still naming `workspace:` or `catalog:`; what {@link runCheck} throws before installing. */
export class PackGuardError extends Error {
  /** One line per problem, prefixed with the tarball's file name. */
  readonly problems: string[];

  /** @param problems One line per problem, prefixed with the tarball's file name. */
  constructor(problems: string[]) {
    super(`pack guard: ${problems.length} problem(s)`);
    this.name = "PackGuardError";
    this.problems = problems;
  }
}

/** What {@link runCheck} needs. */
export interface CheckOptions {
  /** The package to check, an absolute path; it holds `consumer-check.json`. */
  packageDir: string;
  /** The work directory, an absolute path; created if missing, never removed here. */
  work: string;
  /** A pre-packed tarball of the package (`--tarball`), instead of packing it. */
  tarball?: string;
  /** The TypeScript range the consumers install (`--typescript`); default `^6.0.3`. */
  typescript?: string;
  /** Chooses the consumers; default {@link planConsumers}. The tests pass the former two-consumer rule as a negative control. */
  plan?: ConsumerPlanner;
  /** Only these column labels (e.g. `bundler/strict`); default every column. The tests use one, to keep their compiler runs few. */
  columns?: string[];
}

/**
 * Packs, installs and checks one package: steps 1 to 5 of the header, with
 * nothing printed but each consumer's install time and nothing decided. The
 * verdict is {@link failures}'s.
 *
 * @throws {PackGuardError} when a tarball still names `workspace:` or `catalog:`.
 */
export async function runCheck(options: CheckOptions): Promise<RunResult> {
  const { packageDir, work } = options;
  const config = JSON.parse(
    readFileSync(join(packageDir, "consumer-check.json"), "utf8"),
  ) as CheckConfig;
  const manifest = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8"),
  ) as {
    name: string;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  const tarballs = join(work, "tarballs");
  mkdirSync(tarballs, { recursive: true });

  // 1. Pack.
  const main = options.tarball ?? pack(packageDir, tarballs);
  const siblings: Record<string, string> = {};
  for (const dep of config.workspaceDependencies ?? []) {
    const dir = resolve(REPO_ROOT, dep);
    const name = (
      JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name: string;
      }
    ).name;
    siblings[name] = `file:${pack(dir, tarballs)}`;
  }
  // A tarball still naming `workspace:` or `catalog:` (an `npm pack` from the
  // package directory, or a Bun that stopped rewriting them) installs
  // nowhere but here: refuse it before the consumer hides that.
  const unresolved = [
    main,
    ...Object.values(siblings).map((s) => s.slice(5)),
  ].flatMap((tarball) =>
    guardTarball(tarball).map((p) => `${basename(tarball)}: ${p}`),
  );
  if (unresolved.length > 0) throw new PackGuardError(unresolved);

  // 2. Install into consumers that live outside the repo, so nothing
  // resolves through the workspace's node_modules: one per distinct set of
  // optional peers the entries list, each holding exactly that set.
  const extra = Object.fromEntries(
    (config.consumerDependencies ?? []).map((d) => {
      const at = d.lastIndexOf("@");
      return at > 0 ? [d.slice(0, at), d.slice(at + 1)] : [d, "latest"];
    }),
  );
  const optionalPeers = new Set(
    Object.keys(manifest.peerDependencies ?? {}).filter(
      (p) => manifest.peerDependenciesMeta?.[p]?.optional,
    ),
  );
  const consumers: InstalledConsumer[] = [];
  const consumerDirs = new Map<string, string>();
  for (const plan of (options.plan ?? planConsumers)(
    config.entries,
    optionalPeers,
  )) {
    const dir = join(work, plan.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        consumerManifest({
          name: manifest.name,
          tarball: main,
          workspace: withoutOtherPeers(siblings, optionalPeers, plan.peers),
          extra: withoutOtherPeers(extra, optionalPeers, plan.peers),
          typescript: options.typescript,
        }),
        null,
        2,
      ),
    );
    const started = performance.now();
    run(["bun", "install", "--no-save"], dir);
    const installSeconds = Math.round((performance.now() - started) / 10) / 100;
    consumers.push({ ...plan, installSeconds });
    for (const s of plan.spellings) consumerDirs.set(s, dir);
    console.log(
      `installed ${plan.name}/ (${plan.peers.length > 0 ? plan.peers.join(", ") : "no optional peer"}) in ${installSeconds}s`,
    );
  }
  const consumer = join(work, consumers[0].name);
  /** The consumer an entry is checked in. */
  const consumerOf = (entry: EntryConfig): string => {
    const dir = consumerDirs.get(entry.spelling);
    if (!dir) throw new Error(`no consumer planned for ${entry.spelling}`);
    return dir;
  };
  const scoped = new Set(config.entries.flatMap((e) => e.peers ?? []));
  const tsc = join(consumer, "node_modules/typescript/bin/tsc");
  const typescript = (
    JSON.parse(
      readFileSync(
        join(consumer, "node_modules/typescript/package.json"),
        "utf8",
      ),
    ) as { version: string }
  ).version;

  // 3. Type-check every spelling in every column.
  const tasks: (() => Promise<CellResult>)[] = [];
  for (const entry of config.entries) {
    const dir = consumerOf(entry);
    mkdirSync(join(dir, "probes"), { recursive: true });
    const id = idOf(entry.spelling);
    const probe = `probes/${id}.ts`;
    writeFileSync(join(dir, probe), probeSource(entry));
    const columns = entry.browser
      ? ["bundler", "bun-init", "node16", "browser"]
      : ["bundler", "bun-init", "node16"];
    for (const column of columns) {
      for (const skipLibCheck of [true, false]) {
        const label = `${column}/${skipLibCheck ? "slc" : "strict"}`;
        if (options.columns && !options.columns.includes(label)) continue;
        const tsconfig = `tsconfig.${id}.${column}.${skipLibCheck ? "slc" : "strict"}.json`;
        writeFileSync(
          join(dir, tsconfig),
          JSON.stringify(
            {
              compilerOptions: { ...COLUMNS[column], skipLibCheck },
              files: [probe],
            },
            null,
            2,
          ),
        );
        tasks.push(async () => {
          const args = ["bun", tsc, "-p", tsconfig, "--pretty", "false"];
          if (column === "browser") args.push("--listFiles");
          const proc = Bun.spawn({
            cmd: args,
            cwd: dir,
            stdout: "pipe",
            stderr: "pipe",
          });
          const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`;
          await proc.exited;
          const cell: CellResult = {
            key: `${entry.spelling}|${label}`,
            spelling: entry.spelling,
            column: label,
            ...classify(out, probe),
          };
          if (column === "browser") {
            // A browser entry must not drag in the runtime's ambient types.
            const leaks = out
              .split("\n")
              .filter(
                (l) =>
                  /node_modules\/(?:@types\/(?:bun|node)|bun-types)\//.test(
                    l,
                  ) && !/error TS/.test(l),
              )
              .map((l) => relative(dir, l.trim()));
            if (leaks.length > 0) {
              cell.envLeaks = leaks;
              if (cell.status === "OK") cell.status = "LIB-ERRORS";
              cell.sample.unshift(
                `loads runtime types: ${leaks[0]}${leaks.length > 1 ? ` (+${leaks.length - 1})` : ""}`,
              );
            }
          }
          return cell;
        });
      }
    }
  }
  const cells = await pool(
    tasks,
    Math.max(2, navigator.hardwareConcurrency - 1),
  );

  // 4. Runtime: import each spelling under Bun and touch every value export.
  const runtime: Record<string, string> = {};
  for (const entry of config.entries) {
    if (entry.runtime === false) continue;
    const dir = consumerOf(entry);
    const script = join(dir, `runtime.${idOf(entry.spelling)}.ts`);
    writeFileSync(
      script,
      `const m = await import(${JSON.stringify(entry.spelling)});\n` +
        `const missing = ${JSON.stringify(entry.values ?? [])}.filter((n) => m[n] === undefined);\n` +
        `if (missing.length) { console.error("undefined exports: " + missing.join(", ")); process.exit(1); }\n`,
    );
    const r = run(["bun", script], dir, true);
    runtime[entry.spelling] =
      r.code === 0 ? "ok" : r.out.trim().split("\n").slice(-3).join(" | ");
  }

  // 5. Declarations importing what the consumer may not have.
  const installed = join(consumer, "node_modules", manifest.name);
  const leaks = scanLeaks(installed, scoped);

  return {
    package: manifest.name,
    typescript,
    cells,
    runtime,
    leaks,
    peerScoped: Object.fromEntries(
      config.entries
        .filter((e) => e.peers?.length)
        .map((e) => [e.spelling, e.peers!]),
    ),
    consumers,
  };
}

async function main(): Promise<void> {
  const show = flag("--show");
  if (show) {
    // Re-print a saved result (optionally against a baseline) without re-running.
    const saved = JSON.parse(readFileSync(resolve(show), "utf8")) as RunResult;
    report(saved);
    const against = flag("--baseline");
    process.exit(
      reportFailures(
        saved,
        against
          ? (JSON.parse(readFileSync(resolve(against), "utf8")) as RunResult)
          : undefined,
      )
        ? 1
        : 0,
    );
  }
  const target = process.argv[2];
  if (!target || target.startsWith("--")) {
    console.error(
      "usage: bun scripts/consumer-check.ts <package-dir> [--save f] [--baseline f] [--tarball f] [--typescript v] [--work dir]",
    );
    process.exit(2);
  }
  const packageDir = resolve(REPO_ROOT, target);

  const { dir: work, ephemeral } = resolveWorkDir(packageDir, flag("--work"));
  if (!ephemeral) rmSync(work, { recursive: true, force: true });

  let result: RunResult;
  try {
    const tarball = flag("--tarball");
    result = await runCheck({
      packageDir,
      work,
      tarball: tarball ? resolve(tarball) : undefined,
      typescript: flag("--typescript"),
    });
  } catch (error) {
    if (!(error instanceof PackGuardError)) throw error;
    console.error(error.message);
    for (const p of error.problems) console.error(`  ${p}`);
    process.exit(1);
  }
  report(result);

  const save = flag("--save");
  if (save)
    writeFileSync(resolve(save), `${JSON.stringify(result, null, 2)}\n`);

  const baselinePath = flag("--baseline");
  const failed = reportFailures(
    result,
    baselinePath
      ? (JSON.parse(readFileSync(resolve(baselinePath), "utf8")) as RunResult)
      : undefined,
  );
  if (ephemeral) {
    // A fresh per-run directory is ours to remove, but only after a pass: a
    // failing run keeps it, so the installed consumer can be inspected.
    if (failed) console.error(`work directory kept: ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

/** Prints the diagnostics, then the matrix (last, so it survives a `tail`). */
function report(result: RunResult): void {
  const bad = result.cells.filter((c) => c.status !== "OK");
  if (bad.length > 0) {
    console.log(`first diagnostics per failing cell:`);
    for (const c of bad)
      console.log(
        `  ${c.spelling} [${c.column}]\n    ${c.sample.join("\n    ")}`,
      );
  }
  if (result.leaks.length > 0) {
    console.log(`\ndeclarations import packages a consumer may not have:`);
    for (const l of result.leaks) console.log(`  ${l}`);
  }
  const consumers = result.consumers ?? [];
  if (consumers.length > 0) {
    // One install per optional-peer set; each set beyond the peerless one is
    // what scoping an entry to its own peers costs.
    console.log(`\nconsumers (one per optional-peer set):`);
    for (const c of consumers)
      console.log(
        `  ${`${c.name}/`.padEnd(44)}${String(c.spellings.length).padStart(3)} spelling(s)  install ${`${c.installSeconds}s`.padEnd(7)} ${c.peers.length > 0 ? c.peers.join(", ") : "no optional peer"}`,
      );
    const total = consumers.reduce((s, c) => s + c.installSeconds, 0);
    console.log(
      `  ${consumers.length} install(s), ${Math.round(total * 100) / 100}s in all`,
    );
  }
  console.log(
    `\n${result.package} — TypeScript ${result.typescript}   (cell = status(total diagnostics); slc = skipLibCheck)\n`,
  );
  const columns = [...new Set(result.cells.map((c) => c.column))];
  const spellings = [...new Set(result.cells.map((c) => c.spelling))];
  const width = Math.max(...spellings.map((s) => s.length)) + 2;
  console.log(
    `${"spelling".padEnd(width)}${columns.map((c) => c.padEnd(20)).join("")}bun runtime`,
  );
  for (const s of spellings) {
    const row = columns.map((col) => {
      const c = result.cells.find((x) => x.spelling === s && x.column === col);
      if (!c) return "-".padEnd(20);
      const n = c.probeErrors + c.libErrors;
      return (c.status === "OK" ? "OK" : `${c.status}(${n})`).padEnd(20);
    });
    const r = result.runtime[s];
    console.log(
      `${s.padEnd(width)}${row.join("")}${r === undefined ? "-" : r === "ok" ? "ok" : "FAIL"}`,
    );
  }
  for (const [s, r] of Object.entries(result.runtime)) {
    if (r !== "ok") console.log(`runtime FAIL ${s}: ${r}`);
  }
  for (const [s, peers] of Object.entries(result.peerScoped ?? {}))
    console.log(`checked with optional peer(s) ${peers.join(", ")}: ${s}`);
  if (Object.keys(result.peerScoped ?? {}).length > 0)
    console.log(
      `every other spelling: checked with no optional peer installed`,
    );
}

/** What {@link failures} found: the lines that fail the run, and what a baseline fixed. */
export interface Verdict {
  /** One line per problem that fails the run. Empty means the run passes. */
  failed: string[];
  /** Cells the baseline had broken that are `OK` now (informational). */
  fixed: string[];
}

/**
 * Decides whether a run fails. Only `OK` passes; every other state fails
 * unless a baseline already had the same problem in the same state ("known").
 *
 * | State | Without a baseline | With a baseline |
 * |---|---|---|
 * | cell `OK` | pass | pass (`fixed` if it was not `OK`) |
 * | cell `UNRESOLVED`, `ANY`, `PROBE-ERRORS`, `LIB-ERRORS` | fail | pass only if the baseline had that same status; `NEW-BROKEN` if it was `OK`, otherwise a new or changed status fails |
 * | cell not in the baseline, not `OK` | fail | fail |
 * | baseline cell no longer checked | n/a | fail |
 * | runtime import `ok` | pass | pass |
 * | runtime import failing | fail | pass only if the baseline's failed too; `NEW-BROKEN` if it was `ok` |
 * | leaked import in a declaration | fail | fail |
 * | Node/Bun types in a browser cell | fail | fail |
 */
export function failures(now: RunResult, baseline?: RunResult): Verdict {
  const before = new Map((baseline?.cells ?? []).map((c) => [c.key, c]));
  const failed: string[] = [];
  const fixed: string[] = [];
  for (const c of now.cells) {
    const b = before.get(c.key);
    if (b && b.status !== "OK" && c.status === "OK")
      fixed.push(`${c.key}: ${b.status} -> OK`);
    if (c.status === "OK") continue;
    if (b?.status === c.status) continue; // known to the baseline
    const detail = `${c.status}(${c.probeErrors + c.libErrors}) ${c.sample.join(" | ")}`;
    failed.push(
      b?.status === "OK"
        ? `NEW-BROKEN  ${c.key}: OK -> ${c.status}`
        : `${c.status}  ${now.package} ${c.spelling} [${c.column}]: ${detail}`,
    );
  }
  for (const [s, r] of Object.entries(now.runtime)) {
    if (r === "ok") continue;
    const b = baseline?.runtime[s];
    if (b !== undefined && b !== "ok") continue;
    failed.push(
      b === "ok"
        ? `NEW-BROKEN  ${s} runtime: ok -> ${r}`
        : `RUNTIME-FAIL  ${now.package} ${s}: ${r}`,
    );
  }
  for (const [s, r] of Object.entries(baseline?.runtime ?? {})) {
    if (r === "ok" && now.runtime[s] === undefined)
      failed.push(`NEW-BROKEN  ${s} runtime: ok -> not run`);
  }
  // A spelling the baseline covered must still be covered.
  for (const key of before.keys()) {
    if (!now.cells.some((c) => c.key === key))
      failed.push(`NEW-BROKEN  ${key}: no longer checked`);
  }
  for (const l of now.leaks) failed.push(`LEAK  ${now.package}: ${l}`);
  for (const c of now.cells)
    if (c.envLeaks)
      failed.push(
        `ENV-LEAK  ${now.package} ${c.spelling} [${c.column}]: ${c.envLeaks.join(", ")}`,
      );
  return { failed, fixed };
}

/** Prints the verdict of {@link failures}; returns true when the run fails. */
function reportFailures(now: RunResult, baseline?: RunResult): boolean {
  const { failed, fixed } = failures(now, baseline);
  if (baseline)
    console.log(
      `\nvs baseline: ${fixed.length} fixed, ${failed.filter((f) => f.startsWith("NEW-BROKEN")).length} NEW-BROKEN`,
    );
  for (const f of fixed) console.log(`  fixed       ${f}`);
  if (failed.length > 0) {
    console.log(`\nFAILED: ${failed.length} problem(s)`);
    for (const f of failed) console.log(`  ${f}`);
  }
  return failed.length > 0;
}

// Run only as a command: the tests import the scanner without running a check.
if (import.meta.main) await main();
