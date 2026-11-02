/**
 * The published shape: `exports`, the declaration build, and no dependency.
 *
 * The end-to-end proof is the consumer check against a packed tarball
 * (`bun scripts/consumer-check.ts packages/bun-contract` from the repo root),
 * which is too slow for `bun test`. These are the invariants that check
 * depends on, cheap enough to hold on every run, and the one property the
 * package exists for (typed-client plan §10.1, D20): a frontend installing it
 * installs nothing else.
 */

import type { CheckConfig } from "../scripts/build-declarations";
import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const ROOT = resolve(import.meta.dir, "..");

/** One conditional `exports` entry. */
interface Conditions {
  /** In-repo source, selected by the repo's `customConditions`. */
  "@kingsleyweb/source": string;
  /** The built declaration. */
  types: string;
  /** What Bun runs. */
  default: string;
}

/** The fields of `package.json` read here. */
interface Manifest {
  /** The `exports` map. */
  exports: Record<string, string | Conditions>;
  /** What is published. */
  files: string[];
  /** The runtime entry. */
  main: string;
  /** The declaration entry. */
  types: string;
  /** The Bun floor. */
  engines?: Record<string, string>;
  /** Runtime dependencies: none. */
  dependencies?: Record<string, string>;
  /** Bundled dependencies: none. */
  bundleDependencies?: string[] | boolean;
  /** Bundled dependencies, the other spelling: none. */
  bundledDependencies?: string[] | boolean;
  /** Optional dependencies: none. */
  optionalDependencies?: Record<string, string>;
  /** Peers: optional ones only. */
  peerDependencies?: Record<string, string>;
  /** Which peers are optional. */
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

const manifest = (await Bun.file(
  join(ROOT, "package.json"),
).json()) as Manifest;

const checkConfig = (await Bun.file(
  join(ROOT, "consumer-check.json"),
).json()) as CheckConfig;

/**
 * Everything a consumer's install would add because of `pkg`: its runtime,
 * optional and bundled dependencies, and its peers that are not optional.
 */
function installedWith(pkg: Manifest): string[] {
  const bundled = pkg.bundleDependencies ?? pkg.bundledDependencies;
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...(Array.isArray(bundled) ? bundled : bundled === true ? ["*"] : []),
    ...Object.keys(pkg.peerDependencies ?? {}).filter(
      (name) => pkg.peerDependenciesMeta?.[name]?.optional !== true,
    ),
  ].sort();
}

/** Directories under `lib/` that have an `index.ts`, as `./lib/...` subpaths. */
function directoryEntries(dir = join(ROOT, "lib")): string[] {
  const found: string[] = [];
  if (existsSync(join(dir, "index.ts"))) {
    found.push(`./${relative(ROOT, dir)}`);
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory())
      found.push(...directoryEntries(join(dir, entry.name)));
  }
  return found;
}

describe("no dependency", () => {
  it("makes a consumer install nothing else", () => {
    expect(installedWith(manifest)).toEqual([]);
  });

  it("negative control: a dependency, a required peer or a bundled one is caught", () => {
    expect(
      installedWith({ ...manifest, dependencies: { "left-pad": "1" } }),
    ).toEqual(["left-pad"]);
    expect(
      installedWith({
        ...manifest,
        peerDependencies: { ...manifest.peerDependencies, zod: "^4" },
      }),
    ).toEqual(["zod"]);
    expect(
      installedWith({
        ...manifest,
        optionalDependencies: { fsevents: "2" },
        bundleDependencies: ["x"],
      }),
    ).toEqual(["fsevents", "x"]);
  });

  it("keeps only the environment's types and TypeScript as (optional) peers", () => {
    expect(Object.keys(manifest.peerDependencies ?? {}).sort()).toEqual([
      "@types/bun",
      "typescript",
    ]);
  });

  // The source, not just the manifest: an import of a package the manifest
  // does not declare would still resolve in the workspace and pass the tests.
  it("imports nothing from lib/ but its own modules", async () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const found: string[] = [];
    for (const file of readdirSync(join(ROOT, "lib"))) {
      const source = await Bun.file(join(ROOT, "lib", file)).text();
      // Type-only imports are erased by the scan; the declarations' imports
      // are checked by the build's own verify step.
      for (const { path } of transpiler.scanImports(source)) {
        if (!path.startsWith("./")) found.push(`${file}: ${path}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("declares Bun's floor", () => {
    expect(manifest.engines?.bun).toBe(">=1.4.2");
  });
});

describe("package.json exports", () => {
  const conditional = Object.entries(manifest.exports).filter(
    (entry): entry is [string, Conditions] => typeof entry[1] === "object",
  );

  it("lists the source condition first, then types, then default, in every entry", () => {
    for (const [, conditions] of conditional) {
      expect(Object.keys(conditions)).toEqual([
        "@kingsleyweb/source",
        "types",
        "default",
      ]);
      expect(conditions["@kingsleyweb/source"]).toBe(conditions.default);
    }
  });

  it("maps every types target to the dts/ mirror of its lib/ source", () => {
    for (const [, { types, default: source }] of conditional) {
      expect(types).toBe(
        source.replace(/^\.\/lib\//, "./dts/").replace(/\.ts$/, ".d.ts"),
      );
    }
  });

  it("points every literal runtime target at a file that exists", () => {
    for (const [key, { default: source }] of conditional) {
      if (key.includes("*")) continue;
      expect(existsSync(join(ROOT, source))).toBe(true);
    }
  });

  it("gives every directory with an index its own key", () => {
    for (const dir of directoryEntries()) {
      expect(manifest.exports[dir]).toBeDefined();
    }
    expect(manifest.exports["."]).toEqual(manifest.exports["./lib"]);
  });

  it("keeps the deep-import patterns and package.json", () => {
    for (const key of [
      "./lib/*.ts",
      "./lib/*.js",
      "./lib/*",
      "./package.json",
    ]) {
      expect(manifest.exports[key]).toBeDefined();
    }
  });

  it("keeps main on the source and types on the declarations, both published", () => {
    expect(manifest.main).toBe("lib/index.ts");
    expect(manifest.types).toBe("dts/index.d.ts");
    expect(manifest.files).toEqual(expect.arrayContaining(["dts", "lib"]));
  });
});

describe("the consumer check", () => {
  // The whole package is browser-safe, so every spelling is checked as a
  // browser entry too (no Node or Bun types in its graph).
  it("checks every spelling as a browser entry, with no peer", () => {
    const entries = (checkConfig.entries ?? []) as (NonNullable<
      CheckConfig["entries"]
    >[number] & { browser?: boolean })[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect({ spelling: entry.spelling, browser: entry.browser }).toEqual({
        spelling: entry.spelling,
        browser: true,
      });
      expect(entry.peers ?? []).toEqual([]);
    }
    expect(entries.map((e) => e.spelling)).toEqual(
      expect.arrayContaining([
        "@kingsleyweb/bun-contract",
        "@kingsleyweb/bun-contract/lib/guard",
        "@kingsleyweb/bun-contract/lib/standardSchema",
      ]),
    );
  });
});
