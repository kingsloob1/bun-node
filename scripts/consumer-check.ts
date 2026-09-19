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
 * ```bash
 * bun scripts/consumer-check.ts packages/bun-common                      # run, print the table
 * bun scripts/consumer-check.ts packages/bun-common --save base.json     # record a baseline
 * bun scripts/consumer-check.ts packages/bun-common --baseline base.json # fail on NEW-BROKEN
 * bun scripts/consumer-check.ts packages/bun-common --tarball x.tgz      # check a pre-packed tarball
 * bun scripts/consumer-check.ts packages/bun-common --typescript 5.9.3   # a different compiler
 * bun scripts/consumer-check.ts --show after.json --baseline base.json   # re-print a saved run
 * ```
 *
 * The package supplies its own spellings in `<package>/consumer-check.json`
 * (see {@link CheckConfig}), so bun-common, bun-nest, bun-jobs and
 * bun-jobs-ui all run this script unchanged.
 *
 * Optional peers get two consumers. Entries without `peers` are checked in a
 * `consumer/` that has none of the package's optional peers installed (a
 * workspace dependency or consumer dependency that is an optional peer is
 * left out of it), so a root that reaches one fails there. Entries with
 * `peers` are checked in `consumer-peers/`, which has everything.
 *
 * A cell is `OK` only with zero diagnostics anywhere. With `--baseline`, a cell
 * that was `OK` and no longer is, or a runtime import that worked and no
 * longer does, is `NEW-BROKEN` and fails the run; that is the acceptance rule
 * for any packaging change.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { basename, join, relative, resolve } from "node:path";
import process from "node:process";

/** One import spelling a consumer may write. */
interface EntryConfig {
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
   * has them installed; every entry without `peers` is checked in one that
   * has none of the package's optional peers, which is what proves the root
   * does not reach them. The build's verify step reads the same field.
   */
  peers?: string[];
}

/** `<package>/consumer-check.json`. */
interface CheckConfig {
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
type CellStatus =
  | "OK" // no diagnostics at all
  | "UNRESOLVED" // the spelling does not resolve (TS2307 and friends in the probe)
  | "ANY" // resolves, but a probed name is `any` or missing
  | "PROBE-ERRORS" // other errors in the probe file (e.g. a failed deep assertion)
  | "LIB-ERRORS"; // the probe is clean, but errors surface inside installed packages

/** One (spelling, resolution, skipLibCheck, environment) result. */
interface CellResult {
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
interface RunResult {
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
}

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
  return join(dest, created[0]!);
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

/** Bare specifiers (and `/// <reference types>`) in a declaration file. */
function bareSpecifiers(text: string): string[] {
  const found = new Set<string>();
  const re =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(["'])([^"'.][^"']*)\1/gm;
  for (const m of text.matchAll(re)) found.add(m[2]!);
  for (const m of text.matchAll(
    /\/\/\/\s*<reference\s+types=(["'])([^"']+)\1/g,
  ))
    found.add(m[2]!);
  return [...found];
}

/** The package name a specifier refers to (`@a/b/c` → `@a/b`, `x/y` → `x`). */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
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
function scanLeaks(installed: string, scoped: Set<string>): string[] {
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
        results[i] = await tasks[i]!();
      }
    }),
  );
  return results;
}

async function main(): Promise<void> {
  const show = flag("--show");
  if (show) {
    // Re-print a saved result (optionally against a baseline) without re-running.
    const saved = JSON.parse(readFileSync(resolve(show), "utf8")) as RunResult;
    report(saved);
    const against = flag("--baseline");
    process.exit(
      against &&
        compare(
          JSON.parse(readFileSync(resolve(against), "utf8")) as RunResult,
          saved,
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
  const tsVersion = flag("--typescript");

  const work = resolve(
    flag("--work") ??
      join(
        process.env.TMPDIR ?? "/tmp",
        `consumer-check-${basename(packageDir)}`,
      ),
  );
  rmSync(work, { recursive: true, force: true });
  const tarballs = join(work, "tarballs");
  mkdirSync(tarballs, { recursive: true });

  // 1. Pack.
  const main = flag("--tarball")
    ? resolve(flag("--tarball")!)
    : pack(packageDir, tarballs);
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

  // 2. Install into a consumer that lives outside the repo, so nothing
  // resolves through the workspace's node_modules. Entries that need an
  // optional peer get a second consumer; the first never has one.
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
  const withoutPeers = (deps: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(deps).filter(([name]) => !optionalPeers.has(name)),
    );
  const install = (dir: string, peers: boolean): string => {
    mkdirSync(dir, { recursive: true });
    const workspace = peers ? siblings : withoutPeers(siblings);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "consumer-check",
          private: true,
          type: "module",
          dependencies: {
            [manifest.name]: `file:${main}`,
            ...workspace,
            "@types/bun": "^1.4.2",
            typescript: tsVersion ?? "^6.0.3",
            ...(peers ? extra : withoutPeers(extra)),
          },
          overrides: workspace,
        },
        null,
        2,
      ),
    );
    run(["bun", "install", "--no-save"], dir);
    return dir;
  };
  const consumer = install(join(work, "consumer"), false);
  const scoped = new Set(config.entries.flatMap((e) => e.peers ?? []));
  const consumerWithPeers =
    scoped.size > 0 ? install(join(work, "consumer-peers"), true) : consumer;
  /** The consumer an entry is checked in. */
  const consumerOf = (entry: EntryConfig) =>
    entry.peers?.length ? consumerWithPeers : consumer;
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

  const result: RunResult = {
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
  };
  report(result);

  const save = flag("--save");
  if (save)
    writeFileSync(resolve(save), `${JSON.stringify(result, null, 2)}\n`);

  let failed = false;
  const baselinePath = flag("--baseline");
  if (baselinePath)
    failed = compare(
      JSON.parse(readFileSync(resolve(baselinePath), "utf8")) as RunResult,
      result,
    );
  if (leaks.length > 0) failed = true;
  if (cells.some((c) => c.envLeaks)) failed = true;
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

/** Compares against a baseline; returns true when anything that worked broke. */
function compare(baseline: RunResult, now: RunResult): boolean {
  const before = new Map(baseline.cells.map((c) => [c.key, c]));
  const newBroken: string[] = [];
  const fixed: string[] = [];
  for (const c of now.cells) {
    const b = before.get(c.key);
    if (!b) continue;
    if (b.status === "OK" && c.status !== "OK")
      newBroken.push(`${c.key}: OK -> ${c.status}`);
    if (b.status !== "OK" && c.status === "OK")
      fixed.push(`${c.key}: ${b.status} -> OK`);
  }
  for (const [s, r] of Object.entries(baseline.runtime)) {
    if (r === "ok" && now.runtime[s] !== "ok")
      newBroken.push(`${s} runtime: ok -> ${now.runtime[s] ?? "not run"}`);
  }
  // A spelling the baseline covered must still be covered.
  for (const key of before.keys()) {
    if (!now.cells.some((c) => c.key === key))
      newBroken.push(`${key}: no longer checked`);
  }
  console.log(
    `\nvs baseline: ${fixed.length} fixed, ${newBroken.length} NEW-BROKEN`,
  );
  for (const f of fixed) console.log(`  fixed       ${f}`);
  for (const n of newBroken) console.log(`  NEW-BROKEN  ${n}`);
  return newBroken.length > 0;
}

await main();
