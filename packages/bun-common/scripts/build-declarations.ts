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
 * Nothing here is specific to this package: it reads the output directory from
 * `tsconfig.build.json` and the manifest from `package.json`, so another
 * package can copy it unchanged.
 */
import { existsSync, readdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";

/** The package root; this script lives in `<root>/scripts`. */
const PACKAGE_ROOT = resolve(import.meta.dir, "..");

/** The emit config. */
const BUILD_CONFIG = join(PACKAGE_ROOT, "tsconfig.build.json");

/**
 * A module specifier in a declaration: `from "x"`, `import("x")`,
 * `require("x")` or a bare `import "x"`. Group 2 is the specifier.
 */
const SPECIFIER =
  /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(["'])([^"']+)\2/gm;

/** `/// <reference types="x" />`; group 2 is the package. */
const REFERENCE_TYPES = /\/\/\/\s*<reference\s+types=(["'])([^"']+)\1/g;

/** The subset of `package.json` this script reads. */
interface Manifest {
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
    const updated = original.replace(
      SPECIFIER,
      (whole, lead: string, quote: string, spec: string) => {
        if (!spec.startsWith(".")) return whole;
        const next = explicit(dirname(file), spec);
        if (next === null) return whole;
        count++;
        return `${lead}${quote}${next}${quote}`;
      },
    );
    if (updated !== original) await writeFile(file, updated);
  }
  return count;
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

  for (const file of listFiles(outDir, ".d.ts")) {
    const where = relative(PACKAGE_ROOT, file);
    const text = await readFile(file, "utf8");
    const specs = [
      ...[...text.matchAll(SPECIFIER)].map((m) => m[3]!),
      ...[...text.matchAll(REFERENCE_TYPES)].map((m) => m[2]!),
    ];
    for (const spec of specs) {
      if (spec.startsWith(".")) {
        // An extensionless one resolves to nothing under node16, silently.
        if (!/\.(?:js|json)$/.test(spec))
          problems.push(`${where}: "${spec}" has no extension`);
        else if (
          !existsSync(resolve(dirname(file), spec.replace(/\.js$/, ".d.ts"))) &&
          !spec.endsWith(".json")
        ) {
          problems.push(`${where}: "${spec}" names no emitted declaration`);
        }
        continue;
      }
      if (environment(spec)) continue;
      // Anything else must be installed for every consumer, or they get TS2307.
      const name = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0]!;
      const typesName = name.startsWith("@")
        ? `@types/${name.slice(1).replace("/", "__")}`
        : `@types/${name}`;
      if (!guaranteed.has(name) && !guaranteed.has(typesName)) {
        const why = manifest.peerDependenciesMeta?.[name]?.optional
          ? "an optional peer"
          : "not a dependency";
        problems.push(`${where}: imports "${spec}", which is ${why}`);
      }
    }
  }

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
    `${outName}/ verified: explicit specifiers, published map sources, existing exports targets, no undeclared imports`,
  );
}
