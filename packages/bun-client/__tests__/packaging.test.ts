/**
 * The published shape: `exports`, the declaration build's inputs and the
 * dependency rules (plan §10, CLAUDE.md "Packaging types").
 *
 * The end-to-end proof is the consumer check against a packed tarball
 * (`bun scripts/consumer-check.ts packages/bun-client` from the repo root),
 * too slow for `bun test`. These are the invariants it depends on.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
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

const manifest = (await Bun.file(join(ROOT, "package.json")).json()) as {
  exports: Record<string, string | Conditions>;
  files: string[];
  main: string;
  types: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const checkConfig = (await Bun.file(
  join(ROOT, "consumer-check.json"),
).json()) as {
  entries: { spelling: string; browser?: boolean; peers?: string[] }[];
  workspaceDependencies?: string[];
};

describe("package.json exports", () => {
  const conditional = Object.entries(manifest.exports).filter(
    (entry): entry is [string, Conditions] => typeof entry[1] === "object",
  );

  it("lists the source condition first, then types, then default, in every entry", () => {
    expect(conditional.length).toBeGreaterThan(0);
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

  it("has no lib/ subdirectory without its own key (there are none yet)", () => {
    const dirs = readdirSync(join(ROOT, "lib"), { withFileTypes: true }).filter(
      (entry) => entry.isDirectory(),
    );
    for (const dir of dirs)
      expect(manifest.exports[`./lib/${dir.name}`]).toBeDefined();
  });

  it("keeps the deep-import patterns and package.json", () => {
    for (const key of [
      ".",
      "./lib",
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
    expect(manifest.files).toEqual(["dts", "lib"]);
  });
});

describe("dependencies (plan D17, §10.1)", () => {
  it("has no runtime dependency at all", () => {
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it("keeps bun-common a devDependency, for the tests only, never a peer", () => {
    expect(manifest.devDependencies?.["@kingsleyweb/bun-common"]).toBeDefined();
    expect(
      manifest.peerDependencies?.["@kingsleyweb/bun-common"],
    ).toBeUndefined();
  });

  it("declares only optional peers, and none any entry needs", () => {
    for (const [name] of Object.entries(manifest.peerDependencies ?? {})) {
      expect({
        name,
        optional: manifest.peerDependenciesMeta?.[name]?.optional,
      }).toEqual({ name, optional: true });
    }
    for (const entry of checkConfig.entries)
      expect(entry.peers ?? []).toEqual([]);
    expect(checkConfig.workspaceDependencies ?? []).toEqual([]);
  });

  it("imports nothing but its own modules in lib/", async () => {
    for (const file of readdirSync(join(ROOT, "lib")).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".d.ts"),
    )) {
      const source = await Bun.file(join(ROOT, "lib", file)).text();
      const specifiers = [
        ...source.matchAll(/^(?:import|export)[^"]*from "([^"]+)"/gm),
      ].map((match) => match[1]);
      for (const specifier of specifiers)
        expect({ file, specifier }).toEqual({
          file,
          specifier: expect.stringMatching(/^\.\//),
        });
    }
  });
});

describe("the consumer check", () => {
  it("checks the root entry, as a browser entry", () => {
    const root = checkConfig.entries.find(
      (entry) => entry.spelling === "@kingsleyweb/bun-client",
    );
    expect(root?.browser).toBe(true);
  });

  it("checks every entry as a browser entry", () => {
    for (const entry of checkConfig.entries)
      expect({ spelling: entry.spelling, browser: entry.browser }).toEqual({
        spelling: entry.spelling,
        browser: true,
      });
  });
});
