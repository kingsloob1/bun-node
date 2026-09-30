#!/usr/bin/env bun
/**
 * Checks the plugin the way its users will meet it: packed, installed into a
 * project of their own with nothing but bun-jobs beside it, and type-checked
 * with the declarations it ships.
 *
 * 1. Packs every `file:` directory in `overrides` (inside the bun-node repo,
 *    bun-jobs and bun-common, which are not on a registry there), as a
 *    publish would, declarations built. With no such overrides, bun-jobs
 *    comes from the registry.
 * 2. Copies the plugin out, installs it against those packages, and checks
 *    its own sources with its own `tsconfig.json` (no custom conditions:
 *    bun-jobs' published declarations), then packs it (`prepack` builds).
 * 3. Installs the tarball into a consumer and type-checks {@link PROBE}
 *    under `bundler` and `node16` resolution, `skipLibCheck` off.
 * 4. Fails when a shipped declaration imports anything but
 *    {@link ALLOWED_IMPORTS} (the plugin's peer entries), and when the
 *    package does not import under Bun.
 *
 * ```bash
 * bun scripts/check-types.ts
 * ```
 *
 * The work directory is removed on success and kept on failure.
 */
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import process from "node:process";
import ts from "typescript";

/** What a consumer writes. Edit it for your plugin's exports: every name must stay typed. */
const PROBE = `
import type { SummonPolicy } from "@kingsleyweb/bun-jobs";
import type { ConfiguredProvider } from "@kingsleyweb/bun-jobs/provider";
import { acme, type AcmeConfig } from "bun-jobs-provider-example";

declare const sentinel: unique symbol;
type IsAny<T> = [T] extends [typeof sentinel] ? ([typeof sentinel] extends [T] ? true : false) : false;
type Expect<T extends false> = T;

const config: AcmeConfig = { region: "eu-west", pool: "workers", apiTokenFile: "/run/secrets/acme" };
const configured = acme(config);
export const policy: Pick<SummonPolicy, "summoner"> = { summoner: configured };
export const provider: ConfiguredProvider = configured;
export const passes: "argv" | "none" = configured.summon.capabilities.passes;

export type Checks = [
  Expect<IsAny<typeof acme>>,
  Expect<IsAny<AcmeConfig>>,
  Expect<IsAny<typeof configured.config>>,
];

// @ts-expect-error a config needs a pool
acme({ region: "eu-west", apiToken: "acme-token-0123" });
`;

/** The only packages the shipped declarations may import (plugins §11.2). */
const ALLOWED_IMPORTS = ["@kingsleyweb/bun-jobs/provider"];

/** The compiler options of each consumer shape. */
const COLUMNS: Record<string, Record<string, unknown>> = {
  bundler: {
    lib: ["ESNext"],
    target: "ESNext",
    module: "Preserve",
    moduleResolution: "bundler",
  },
  node16: {
    lib: ["ES2022"],
    target: "ES2022",
    module: "Node16",
    moduleResolution: "Node16",
  },
};

/** The package manifest, as far as this script reads it. */
interface Manifest {
  /** The package name. */
  name: string;
  /** Its dev dependencies: bun-jobs, TypeScript and Bun's types. */
  devDependencies: Record<string, string>;
  /** Where dependencies resolve instead of the registry. */
  overrides?: Record<string, string>;
}

const root = resolve(import.meta.dir, "..");
const manifest = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
) as Manifest;
const work = join(
  tmpdir(),
  `bun-jobs-provider-check-${manifest.name.replace(/\W+/g, "-")}`,
);
const tarballs = join(work, "tarballs");
rmSync(work, { recursive: true, force: true });
mkdirSync(tarballs, { recursive: true });

/** Runs a command; its output, or a thrown error carrying it. */
function run(cmd: string[], cwd: string, allowFail = false): string {
  const result = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== 0 && !allowFail) {
    throw new Error(`${cmd.join(" ")} failed in ${cwd}:\n${output}`);
  }
  return output;
}

/** Packs a package directory with `bun pm pack` (its `prepack` included); the tarball's path. */
function pack(dir: string): string {
  const before = new Set(readdirSync(tarballs));
  run(["bun", "pm", "pack", "--destination", tarballs, "--quiet"], dir);
  const created = readdirSync(tarballs).filter(
    (file) => file.endsWith(".tgz") && !before.has(file),
  );
  if (created.length !== 1) {
    throw new Error(`expected one tarball from ${dir}, got ${created.length}`);
  }
  return join(tarballs, created[0]!);
}

/** Every file under `dir` ending in `suffix`. */
function walk(dir: string, suffix: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((file) => join(dir, file))
    .filter((file) => file.endsWith(suffix) && statSync(file).isFile());
}

/**
 * What a declaration file imports, read by TypeScript's own pre-processor: a
 * regex would also match an import written in a JSDoc example.
 */
function importsOf(file: string): string[] {
  const { importedFiles } = ts.preProcessFile(
    readFileSync(file, "utf8"),
    true,
    true,
  );
  return importedFiles.map((imported) => imported.fileName);
}

/** Type errors in `tsc`'s output. */
function typeErrors(output: string): string[] {
  return output.split("\n").filter((line) => /error TS\d+/.test(line));
}

const results: {
  /** What was checked. */
  check: string;
  /** What failed, one line each: empty when it passed. */
  problems: string[];
}[] = [];

// 1. The packages the overrides point at, packed as a publish would.
const overrides: Record<string, string> = {};
for (const [name, spec] of Object.entries(manifest.overrides ?? {})) {
  const dir = spec.startsWith("file:") ? resolve(root, spec.slice(5)) : "";
  overrides[name] =
    dir !== "" && statSync(dir, { throwIfNoEntry: false })?.isDirectory()
      ? `file:${pack(dir)}`
      : spec;
}

// 2. The plugin, copied out, installed against them, checked and packed.
const plugin = join(work, "plugin");
cpSync(root, plugin, {
  recursive: true,
  filter: (source) =>
    !/(?:^|\/)(?:node_modules|dist|\.git)(?:\/|$)|\.tgz$|(?:^|\/)bun\.lockb?$/.test(
      relative(root, source),
    ),
});
writeFileSync(
  join(plugin, "package.json"),
  JSON.stringify({ ...manifest, overrides }, null, 2),
);
run(["bun", "install", "--no-save"], plugin);
results.push({
  check: "the plugin's sources, with its tsconfig.json",
  problems: typeErrors(
    run(
      ["bun", "x", "tsc", "-p", "tsconfig.json", "--pretty", "false"],
      plugin,
      true,
    ),
  ),
});
const tarball = pack(plugin);

// 3. A consumer with the plugin, bun-jobs and TypeScript, and nothing else.
const consumer = join(work, "consumer");
mkdirSync(consumer);
writeFileSync(
  join(consumer, "package.json"),
  JSON.stringify(
    {
      name: "consumer",
      private: true,
      type: "module",
      dependencies: {
        [manifest.name]: `file:${tarball}`,
        "@kingsleyweb/bun-jobs":
          manifest.devDependencies["@kingsleyweb/bun-jobs"],
        "@types/bun": manifest.devDependencies["@types/bun"],
        typescript: manifest.devDependencies.typescript,
      },
      overrides,
    },
    null,
    2,
  ),
);
run(["bun", "install", "--no-save"], consumer);
writeFileSync(join(consumer, "probe.ts"), PROBE);
for (const [column, options] of Object.entries(COLUMNS)) {
  writeFileSync(
    join(consumer, `tsconfig.${column}.json`),
    JSON.stringify({
      compilerOptions: {
        ...options,
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["bun"],
      },
      files: ["probe.ts"],
    }),
  );
  results.push({
    check: `a consumer, ${column} resolution`,
    problems: typeErrors(
      run(
        [
          "bun",
          "x",
          "tsc",
          "-p",
          `tsconfig.${column}.json`,
          "--pretty",
          "false",
        ],
        consumer,
        true,
      ),
    ),
  });
}

// 4. What the declarations import, and whether the package loads.
const installed = join(consumer, "node_modules", manifest.name);
const declarations = walk(installed, ".d.ts");
results.push({
  check: `declarations import only ${ALLOWED_IMPORTS.join(", ")}`,
  problems:
    declarations.length === 0
      ? ["the package ships no declarations"]
      : declarations.flatMap((file) =>
          importsOf(file)
            .filter(
              (name) =>
                !name.startsWith(".") && !ALLOWED_IMPORTS.includes(name),
            )
            .map((name) => `${relative(installed, file)} imports "${name}"`),
        ),
});
writeFileSync(
  join(consumer, "load.ts"),
  `const loaded = await import(${JSON.stringify(manifest.name)});\n` +
    `if (typeof loaded.acme !== "function" || loaded.acme.definition.name !== ${JSON.stringify(manifest.name)}) {\n` +
    `  throw new Error("the package loaded, but acme is not its provider");\n}\n`,
);
const loaded = Bun.spawnSync({
  cmd: ["bun", "load.ts"],
  cwd: consumer,
  stdout: "pipe",
  stderr: "pipe",
});
results.push({
  check: "imports under Bun",
  problems: loaded.exitCode === 0 ? [] : [loaded.stderr.toString().trim()],
});

let failed = false;
for (const { check, problems } of results) {
  console.log(`  ${problems.length === 0 ? "ok  " : "FAIL"}  ${check}`);
  for (const problem of problems) console.log(`          ${problem}`);
  failed ||= problems.length > 0;
}
if (failed) {
  console.log(`\nKept ${work} to look at.`);
  process.exit(1);
}
rmSync(work, { recursive: true, force: true });
console.log(
  `\n${basename(tarball)}: the declarations resolve with only bun-jobs installed.`,
);
