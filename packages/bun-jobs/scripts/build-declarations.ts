#!/usr/bin/env bun
/**
 * Builds the published `.d.ts` declarations (and their `.d.ts.map`s) into
 * `dts/`, then proves the result is publishable.
 *
 * ```bash
 * bun run build:types                          # from the package; also runs on `prepack`
 * bun scripts/build-declarations.ts --verify   # check an existing dts/ without rebuilding
 * ```
 *
 * `tsc` alone is not enough, and why is the point of this file. The sources
 * spell relative imports without an extension (`from "./utils/native"`), which
 * `bundler` resolution accepts and the repo checks itself with. `tsc` copies a
 * module specifier into a declaration verbatim, so a `node16` consumer, for
 * whom Node ESM demands an extension and has no directory index, cannot follow
 * it: the declaration is found, and then resolves to nothing. So this emits,
 * rewrites every relative specifier in the *declarations* (never the sources)
 * to the explicit form (`./utils/native.js`, `./multipart/index.js`), and
 * verifies. A declaration names the runtime file, `.js`, and TypeScript
 * substitutes the neighbouring `.d.ts` under both `node16` and `bundler`.
 *
 * An optional peer is the one import a declaration may carry that a consumer
 * need not have, and only behind an entry that exists for it: an entry lists
 * the optional peers it needs as `peers` in `consumer-check.json`, and the
 * verify step fails when a declaration importing a peer is reachable from any
 * entry (the root above all) that does not list it. See `checkPeerScopes`.
 *
 * Imports are found by parsing each declaration with the TypeScript compiler
 * (`moduleSpecifiers`), never by matching text: a doc comment reading `tell
 * "x" from "y"` or a type like `Pick<T, "from" | "to">` is not an import, and a
 * text scan read both as one and failed the build.
 *
 * Nothing here is specific to this package: it reads the output directory from
 * `tsconfig.build.json`, the manifest from `package.json` and the entries'
 * `peers` from `consumer-check.json`, so another package can copy it unchanged.
 */
import { existsSync, readdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import ts from "typescript";

/** The package root; this script lives in `<root>/scripts`. */
const PACKAGE_ROOT = resolve(import.meta.dir, "..");

/** The emit config. */
const BUILD_CONFIG = join(PACKAGE_ROOT, "tsconfig.build.json");

/** One module specifier found in a declaration. */
export interface ModuleSpecifier {
  /** The specifier itself, unquoted: `./utils/native`, `busboy`. */
  text: string;
  /** Offset of the specifier's first character (inside the quotes). */
  start: number;
  /** Offset just past its last character (before the closing quote). */
  end: number;
  /**
   * Where it came from: an `import`/`export … from`/`import x = require()`
   * statement, an `import("x")` type or call, a `require("x")` call, a
   * `declare module "x"` augmentation, or a `/// <reference types="x" />`.
   */
  kind: "statement" | "import-type" | "call" | "augmentation" | "reference";
}

/**
 * Every module specifier `text` really contains, found by parsing it, in
 * source order. Comments and string literal types are never specifiers,
 * however much they read like `from "x"`; every syntactic form of a real one
 * is: `import`/`import type`/`export … from`/`export * from`, a bare
 * `import "x"`, `import x = require("x")`, `import("x").T` in a type, an
 * `import()`/`require()` call, a module augmentation (`declare module "x"` in
 * a module; in a script it declares `x` rather than importing it) and
 * `/// <reference types="x" />`.
 */
export function moduleSpecifiers(
  text: string,
  fileName = "declaration.d.ts",
): ModuleSpecifier[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const found: ModuleSpecifier[] = [];
  const add = (literal: ts.Node, kind: ModuleSpecifier["kind"]) => {
    if (!ts.isStringLiteralLike(literal)) return;
    found.push({
      text: literal.text,
      start: literal.getStart(source) + 1,
      end: literal.end - 1,
      kind,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node.moduleSpecifier, "statement");
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression, "statement");
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument))
        add(node.argument.literal, "import-type");
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const [first] = node.arguments;
      if (
        first &&
        (callee.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(callee) && callee.text === "require"))
      )
        add(first, "call");
    } else if (
      ts.isModuleDeclaration(node) &&
      ts.isStringLiteral(node.name) &&
      ts.isExternalModule(source)
    ) {
      add(node.name, "augmentation");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const ref of source.typeReferenceDirectives) {
    found.push({
      text: ref.fileName,
      start: ref.pos,
      end: ref.end,
      kind: "reference",
    });
  }
  return found.sort((a, b) => a.start - b.start);
}

/** The subset of `package.json` this script reads. */
export interface Manifest {
  /** Package name. */
  name: string;
  /** Published paths. */
  files?: string[];
  /** Runtime dependencies: always installed alongside the package. */
  dependencies?: Record<string, string>;
  /** Peer dependencies: installed by the consumer, unless optional. */
  peerDependencies?: Record<string, string>;
  /** Which peers are optional. */
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  /** Conditional exports; every `types` target must exist after a build. */
  exports?: Record<string, string | Record<string, string>>;
  /** Top-level `types`; must exist after a build. */
  types?: string;
}

/** Recursively lists files under `dir` ending in `suffix`. */
function listFiles(dir: string, suffix: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(full, suffix));
    else if (entry.name.endsWith(suffix)) found.push(full);
  }
  return found;
}

/** Reads `compilerOptions.outDir` from the build config (JSONC). */
async function outDirOf(): Promise<string> {
  const text = await readFile(BUILD_CONFIG, "utf8");
  // `Bun.JSONC` would do; a regex keeps this runnable on older Bun too.
  const match = /"outDir"\s*:\s*"([^"]+)"/.exec(text);
  if (!match)
    throw new Error(`${BUILD_CONFIG} must set compilerOptions.outDir`);
  return resolve(PACKAGE_ROOT, match[1]!);
}

/**
 * The explicit form of one relative specifier, found by looking at what the
 * emitted tree contains; `null` when it is already explicit or names nothing.
 */
function explicit(fromDir: string, specifier: string): string | null {
  if (/\.(?:js|mjs|cjs|json)$/.test(specifier)) return null;
  const target = resolve(fromDir, specifier);
  if (existsSync(`${target}.d.ts`)) return `${specifier}.js`;
  if (existsSync(join(target, "index.d.ts")))
    return `${specifier.replace(/\/$/, "")}/index.js`;
  return null;
}

/** Rewrites relative specifiers in every emitted declaration; returns how many changed. */
export async function rewrite(outDir: string): Promise<number> {
  let count = 0;
  for (const file of listFiles(outDir, ".d.ts")) {
    const original = await readFile(file, "utf8");
    let updated = original;
    // Back to front, so an edit never moves the offsets of one still to come.
    for (const spec of moduleSpecifiers(original, file).reverse()) {
      if (spec.kind === "reference" || !spec.text.startsWith(".")) continue;
      const next = explicit(dirname(file), spec.text);
      if (next === null) continue;
      count++;
      updated = updated.slice(0, spec.start) + next + updated.slice(spec.end);
    }
    if (updated !== original) await writeFile(file, updated);
  }
  return count;
}

/** The subset of `consumer-check.json` this script reads. */
export interface CheckConfig {
  /** The public import spellings. */
  entries?: {
    /** The specifier a consumer writes, e.g. `@scope/pkg/jobs`. */
    spelling: string;
    /** Optional peers this entry legitimately needs, and documents as needed. */
    peers?: string[];
  }[];
}

/**
 * The absolute `types` target a subpath (`.`, `./jobs`, `./lib/x.js`) resolves
 * to through `exports`, with Node's pattern precedence (the longest prefix
 * before the `*`, then the longest key); `null` when nothing matches.
 */
export function typesTarget(
  manifest: Manifest,
  subpath: string,
): string | null {
  const exportsMap = manifest.exports ?? {};
  const typesOf = (entry: string | Record<string, string>) =>
    typeof entry === "string" ? entry : (entry.types ?? entry.default);
  let target: string | undefined;
  const exact = exportsMap[subpath];
  if (exact !== undefined) {
    target = typesOf(exact);
  } else {
    const patterns = Object.keys(exportsMap)
      .filter((key) => key.includes("*"))
      .sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length);
    for (const key of patterns) {
      const [prefix = "", suffix = ""] = key.split("*");
      if (
        subpath.length >= key.length - 1 &&
        subpath.startsWith(prefix) &&
        subpath.endsWith(suffix)
      ) {
        const match = subpath.slice(
          prefix.length,
          subpath.length - suffix.length,
        );
        target = typesOf(exportsMap[key]!)?.replaceAll("*", match);
        break;
      }
    }
  }
  if (subpath === "." && target === undefined) target = manifest.types;
  return target ? resolve(PACKAGE_ROOT, target) : null;
}

/**
 * An optional peer may appear in a declaration only when every entry that can
 * reach that declaration says, in `consumer-check.json` `peers`, that it needs
 * the peer. A subpath like bun-nest's `./jobs` exists *for* its peer; the root
 * entry must never reach it, or a consumer without the peer gets `TS2307` for
 * importing nothing but the package.
 *
 * Roots are every literal `exports` key plus every spelling in
 * `consumer-check.json`; a root's allowance is the union of the `peers` of the
 * spellings that resolve to the same declaration. A declaration no root
 * reaches (only a deep `./lib/*` import can) may import a peer some entry
 * declares. Nothing here names a package, so any package can use it as is.
 */
export function checkPeerScopes(
  manifest: Manifest,
  config: CheckConfig,
  edges: Map<string, Set<string>>,
  peerImports: Map<string, Set<string>>,
  exists: (path: string) => boolean = existsSync,
): string[] {
  if (peerImports.size === 0) return [];

  /** Declaration -> the labels of the roots resolving to it, and their peers. */
  const roots = new Map<string, { labels: Set<string>; peers: Set<string> }>();
  const addRoot = (subpath: string, label: string, peers: string[] = []) => {
    const target = typesTarget(manifest, subpath);
    if (!target || !exists(target)) return;
    const root = roots.get(target) ?? { labels: new Set(), peers: new Set() };
    roots.set(target, root);
    root.labels.add(label);
    for (const peer of peers) root.peers.add(peer);
  };
  for (const key of Object.keys(manifest.exports ?? {})) {
    if (!key.includes("*")) addRoot(key, `exports["${key}"]`);
  }
  if (manifest.types) addRoot(".", `"types"`);
  const declared = new Set<string>();
  for (const entry of config.entries ?? []) {
    const subpath =
      entry.spelling === manifest.name
        ? "."
        : `.${entry.spelling.slice(manifest.name.length)}`;
    addRoot(subpath, `"${entry.spelling}"`, entry.peers);
    for (const peer of entry.peers ?? []) declared.add(peer);
  }

  const problems = new Set<string>();
  const reached = new Set<string>();
  for (const [start, { labels, peers }] of roots) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      for (const next of edges.get(queue.pop()!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    for (const file of seen) {
      reached.add(file);
      for (const peer of peerImports.get(file) ?? []) {
        if (!peers.has(peer))
          problems.add(
            `${relative(PACKAGE_ROOT, file)}: imports "${peer}", an optional peer, ` +
              `and is reachable from ${[...labels].join(", ")}, which does not ` +
              `declare it in consumer-check.json "peers"`,
          );
      }
    }
  }
  for (const [file, peers] of peerImports) {
    if (reached.has(file)) continue;
    for (const peer of peers) {
      if (!declared.has(peer))
        problems.add(
          `${relative(PACKAGE_ROOT, file)}: imports "${peer}", an optional peer no consumer-check.json entry declares`,
        );
    }
  }
  return [...problems];
}

/** What `checkImports` found. */
export interface ImportCheck {
  /** One line per import a consumer could not follow. */
  problems: string[];
  /** Declaration -> the declarations it imports (relative, or by the package's own name). */
  edges: Map<string, Set<string>>;
  /** Declaration -> the optional peers it imports; judged by `checkPeerScopes`. */
  peerImports: Map<string, Set<string>>;
}

/**
 * Checks every import in `declarations` (absolute path -> text): a relative
 * one must be explicit and name an emitted declaration, a bare one must be the
 * environment's, the package's own, or something every consumer has (a
 * dependency, a required peer, or its `@types`). Optional peers are collected
 * rather than judged here, since whether one is allowed depends on which
 * entries reach the file.
 */
export function checkImports(
  manifest: Manifest,
  declarations: Map<string, string>,
  exists: (path: string) => boolean = existsSync,
): ImportCheck {
  const problems: string[] = [];
  // A consumer is guaranteed only its dependencies and required peers.
  const guaranteed = new Set([
    manifest.name,
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}).filter(
      (p) => !manifest.peerDependenciesMeta?.[p]?.optional,
    ),
  ]);
  const environment = (s: string) =>
    s.startsWith("node:") ||
    s === "bun" ||
    s.startsWith("bun:") ||
    s === "bun-types" ||
    builtinModules.includes(s);

  /** Declaration -> the declarations it imports. */
  const edges = new Map<string, Set<string>>();
  /** Declaration -> the optional peers it imports. */
  const peerImports = new Map<string, Set<string>>();
  for (const [file, text] of declarations) {
    const where = relative(PACKAGE_ROOT, file);
    const specs = moduleSpecifiers(text, file).map((s) => s.text);
    const imported = new Set<string>();
    edges.set(file, imported);
    for (const spec of specs) {
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec.replace(/\.js$/, ".d.ts"));
        // An extensionless one resolves to nothing under node16, silently.
        if (!/\.(?:js|json)$/.test(spec))
          problems.push(`${where}: "${spec}" has no extension`);
        else if (!exists(target) && !spec.endsWith(".json"))
          problems.push(`${where}: "${spec}" names no emitted declaration`);
        else imported.add(target);
        continue;
      }
      if (environment(spec)) continue;
      // Anything else must be installed for every consumer, or they get TS2307.
      const name = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0]!;
      if (name === manifest.name) {
        // A self-reference: follow it, so a root cannot reach a peer through one.
        const target = typesTarget(manifest, `.${spec.slice(name.length)}`);
        if (target) imported.add(target);
        continue;
      }
      const typesName = name.startsWith("@")
        ? `@types/${name.slice(1).replace("/", "__")}`
        : `@types/${name}`;
      if (guaranteed.has(name) || guaranteed.has(typesName)) continue;
      if (manifest.peerDependenciesMeta?.[name]?.optional) {
        // Judged by which entries can reach this file; see `checkPeerScopes`.
        if (!peerImports.has(file)) peerImports.set(file, new Set());
        peerImports.get(file)!.add(name);
      } else {
        problems.push(`${where}: imports "${spec}", which is not a dependency`);
      }
    }
  }
  return { problems, edges, peerImports };
}

/**
 * Every way a built tree can be unpublishable without anything failing
 * loudly; one line per problem, empty when it is fine.
 */
export async function verify(outDir: string): Promise<string[]> {
  const problems: string[] = [];
  const manifest = (await Bun.file(
    join(PACKAGE_ROOT, "package.json"),
  ).json()) as Manifest;
  const published = manifest.files ?? [];
  const isPublished = (path: string) =>
    published.some(
      (f) => path === f || path.startsWith(`${f.replace(/\/$/, "")}/`),
    );

  const declarations = new Map<string, string>();
  for (const file of listFiles(outDir, ".d.ts"))
    declarations.set(file, await readFile(file, "utf8"));
  const { edges, peerImports, ...imports } = checkImports(
    manifest,
    declarations,
  );
  problems.push(...imports.problems);
  const checkConfig = join(PACKAGE_ROOT, "consumer-check.json");
  problems.push(
    ...checkPeerScopes(
      manifest,
      existsSync(checkConfig)
        ? ((await Bun.file(checkConfig).json()) as CheckConfig)
        : {},
      edges,
      peerImports,
    ),
  );

  // Go-to-definition opens a map's sources: they must exist and be published.
  for (const map of listFiles(outDir, ".d.ts.map")) {
    const { sources } = (await Bun.file(map).json()) as { sources: string[] };
    for (const source of sources) {
      const inPackage = relative(PACKAGE_ROOT, resolve(dirname(map), source));
      if (!existsSync(join(PACKAGE_ROOT, inPackage)))
        problems.push(
          `${relative(PACKAGE_ROOT, map)}: source ${source} is missing`,
        );
      else if (!isPublished(inPackage))
        problems.push(
          `${relative(PACKAGE_ROOT, map)}: source ${inPackage} is not in "files"`,
        );
    }
  }

  // Every literal target in the manifest must exist and be published.
  const targets: [string, string][] = manifest.types
    ? [["types", manifest.types]]
    : [];
  for (const [key, entry] of Object.entries(manifest.exports ?? {})) {
    if (key.includes("*")) continue;
    for (const target of typeof entry === "string"
      ? [entry]
      : Object.values(entry))
      targets.push([`exports["${key}"]`, target]);
  }
  for (const [label, target] of targets) {
    const path = relative(PACKAGE_ROOT, resolve(PACKAGE_ROOT, target));
    if (!existsSync(join(PACKAGE_ROOT, path)))
      problems.push(`${label} -> ${target} does not exist`);
    else if (path !== "package.json" && !isPublished(path))
      problems.push(`${label} -> ${target} is not in "files"`);
  }

  // Every source module has a declaration, so the `./lib/*` pattern never
  // hands a consumer a `types` target that is not there.
  const outName = relative(PACKAGE_ROOT, outDir);
  for (const source of listFiles(join(PACKAGE_ROOT, "lib"), ".ts")) {
    if (source.endsWith(".d.ts")) continue;
    const declaration = join(
      outDir,
      relative(join(PACKAGE_ROOT, "lib"), source),
    ).replace(/\.ts$/, ".d.ts");
    if (!existsSync(declaration))
      problems.push(
        `${relative(PACKAGE_ROOT, source)} has no declaration in ${outName}/`,
      );
  }
  if (!isPublished(outName)) problems.push(`"files" must include "${outName}"`);
  if (!isPublished("lib"))
    problems.push(
      `"files" must include "lib" (the runtime entry, and the declaration maps' sources)`,
    );
  return problems;
}

/** Emits into the configured `outDir` and rewrites specifiers; returns the rewrite count. */
export async function build(outDir: string): Promise<number> {
  await rm(outDir, { recursive: true, force: true });
  const tsc = createRequire(join(PACKAGE_ROOT, "package.json")).resolve(
    "typescript/bin/tsc",
  );
  const result = Bun.spawnSync({
    cmd: [process.execPath, tsc, "-p", BUILD_CONFIG, "--pretty", "false"],
    cwd: PACKAGE_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `tsc -p tsconfig.build.json failed:\n${result.stdout.toString()}${result.stderr.toString()}`,
    );
  }
  return rewrite(outDir);
}

if (import.meta.main) {
  const outDir = await outDirOf();
  const outName = relative(PACKAGE_ROOT, outDir);
  if (!process.argv.includes("--verify")) {
    const rewritten = await build(outDir);
    console.log(
      `emitted ${listFiles(outDir, ".d.ts").length} declarations into ${outName}/ ` +
        `(${rewritten} relative specifiers made explicit)`,
    );
  } else if (!existsSync(outDir)) {
    console.error(`${outName}/ does not exist; run \`bun run build:types\``);
    process.exit(1);
  }
  const problems = await verify(outDir);
  if (problems.length > 0) {
    console.error(`${outName}/ is not publishable:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(
    `${outName}/ verified: explicit specifiers, published map sources, existing exports targets, no undeclared imports, optional peers only behind entries that declare them`,
  );
}
