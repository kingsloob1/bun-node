/**
 * The published shape: `exports`, the declaration build's inputs and the
 * dependency rules (plan §10, CLAUDE.md "Packaging types").
 *
 * The end-to-end proof is the consumer check against a packed tarball
 * (`bun scripts/consumer-check.ts packages/bun-client` from the repo root),
 * too slow for `bun test`. These are the invariants it depends on.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
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

/** The fields of a `package.json` these tests read. */
interface Manifest {
  /** The `exports` map. */
  exports: Record<string, string | Conditions>;
  /** What is published. */
  files: string[];
  /** The runtime entry. */
  main: string;
  /** The `bun-client` bin. */
  bin?: Record<string, string>;
  /** The declarations' entry. */
  types: string;
  /** Runtime dependencies. */
  dependencies?: Record<string, string>;
  /** Development dependencies. */
  devDependencies?: Record<string, string>;
  /** Peers. */
  peerDependencies?: Record<string, string>;
  /** Which peers are optional. */
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

const manifest = (await Bun.file(
  join(ROOT, "package.json"),
).json()) as Manifest;

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

  it("has no lib/ subdirectory without its own key", () => {
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

  it("publishes the generator as ./codegen and ./lib/codegen, and its CLI as the bun-client bin (plan §10.1, §16)", async () => {
    for (const key of ["./codegen", "./lib/codegen"])
      expect(manifest.exports[key]).toEqual({
        "@kingsleyweb/source": "./lib/codegen/index.ts",
        types: "./dts/codegen/index.d.ts",
        default: "./lib/codegen/index.ts",
      });
    expect(manifest.bin).toEqual({ "bun-client": "./lib/codegen/cli.ts" });
    const cli = Bun.file(join(ROOT, "lib/codegen/cli.ts"));
    expect((await cli.text()).startsWith("#!/usr/bin/env bun\n")).toBe(true);
    // Executable, for a bin linked straight to it.
    expect(statSync(join(ROOT, "lib/codegen/cli.ts")).mode & 0o111).not.toBe(0);
  });

  it("publishes the zod glue as ./zod (plan §10.1, §16)", () => {
    expect(manifest.exports["./zod"]).toEqual({
      "@kingsleyweb/source": "./lib/zod.ts",
      types: "./dts/zod.d.ts",
      default: "./lib/zod.ts",
    });
  });

  it("publishes the query layer as ./query (plan §10.1, §16)", () => {
    expect(manifest.exports["./query"]).toEqual({
      "@kingsleyweb/source": "./lib/query.ts",
      types: "./dts/query.d.ts",
      default: "./lib/query.ts",
    });
  });

  it("publishes the React binding as ./react (plan §7.1, §10.1, §16)", () => {
    expect(manifest.exports["./react"]).toEqual({
      "@kingsleyweb/source": "./lib/react.ts",
      types: "./dts/react.d.ts",
      default: "./lib/react.ts",
    });
  });

  it("keeps main on the source and types on the declarations, both published", () => {
    expect(manifest.main).toBe("lib/index.ts");
    expect(manifest.types).toBe("dts/index.d.ts");
    expect(manifest.files).toEqual(["dts", "lib"]);
  });
});

describe("dependencies (plan D17, §10.1)", () => {
  it("has one runtime dependency, bun-contract (Q18), which itself has none", async () => {
    expect(manifest.dependencies ?? {}).toEqual({
      "@kingsleyweb/bun-contract": expect.any(String) as string,
    });
    const contract = (await Bun.file(
      join(ROOT, "..", "bun-contract", "package.json"),
    ).json()) as Manifest;
    expect(contract.dependencies ?? {}).toEqual({});
  });

  it("keeps bun-common a devDependency, and an optional peer only for the CLI's --module (plan §10.1)", () => {
    expect(manifest.devDependencies?.["@kingsleyweb/bun-common"]).toBeDefined();
    expect(
      manifest.peerDependencies?.["@kingsleyweb/bun-common"],
    ).toBeDefined();
    expect(
      manifest.peerDependenciesMeta?.["@kingsleyweb/bun-common"]?.optional,
    ).toBe(true);
  });

  it("declares only optional peers; zod (^4) is needed by the ./zod entries alone, query-core (^5.90) by the ./query ones, react (^19) and react-query (^5.90) by the ./react ones beside query-core", () => {
    for (const [name] of Object.entries(manifest.peerDependencies ?? {})) {
      expect({
        name,
        optional: manifest.peerDependenciesMeta?.[name]?.optional,
      }).toEqual({ name, optional: true });
    }
    expect(manifest.peerDependencies?.zod).toBe("^4");
    expect(manifest.peerDependencies?.["@tanstack/query-core"]).toBe("^5.90.0");
    expect(manifest.peerDependencies?.["@tanstack/react-query"]).toBe(
      "^5.90.0",
    );
    expect(manifest.peerDependencies?.react).toBe("^19.0.0");
    for (const entry of checkConfig.entries)
      expect({ spelling: entry.spelling, peers: entry.peers ?? [] }).toEqual({
        spelling: entry.spelling,
        peers: /\/(?:lib\/)?zod(?:\.[jt]s)?$/.test(entry.spelling)
          ? ["zod"]
          : /\/(?:lib\/)?query(?:\.[jt]s)?$/.test(entry.spelling)
            ? ["@tanstack/query-core"]
            : /\/(?:lib\/)?react(?:\.[jt]s)?$/.test(entry.spelling)
              ? ["@tanstack/query-core", "@tanstack/react-query", "react"]
              : [],
      });
    expect(checkConfig.workspaceDependencies ?? []).toEqual([
      "packages/bun-contract",
    ]);
  });

  it("imports nothing but node: builtins and its own modules in lib/codegen/, bun-common only by a dynamic import", async () => {
    const dir = join(ROOT, "lib", "codegen");
    for (const file of readdirSync(dir).filter((name) =>
      name.endsWith(".ts"),
    )) {
      const source = await Bun.file(join(dir, file)).text();
      const specifiers = [
        ...source.matchAll(/^(?:import|export)[^"]*from "([^"]+)"/gm),
      ].map((match) => match[1]);
      for (const specifier of specifiers)
        expect({ file, specifier }).toEqual({
          file,
          specifier: expect.stringMatching(/^(?:\.{1,2}\/|node:)/),
        });
    }
  });

  it("imports in lib/ only its own modules, types from bun-contract and zod, bun-contract's guards in one place, query-core in ./query alone, and react-query in ./react alone (plan §12.1)", async () => {
    for (const file of readdirSync(join(ROOT, "lib")).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".d.ts"),
    )) {
      const source = await Bun.file(join(ROOT, "lib", file)).text();
      const imports = [
        ...source.matchAll(/^(?:import|export)([^"]*)from "([^"]+)"/gm),
      ].map((match) => ({
        file,
        type: /^\s*type\b/.test(match[1]),
        specifier: match[2],
      }));
      for (const found of imports) {
        if (found.specifier.startsWith("./")) continue;
        // Values from bun-contract: only the lazily loaded checks module.
        if (found.specifier.startsWith("@kingsleyweb/bun-contract")) {
          expect(found.type || file === "validation.ts").toBe(true);
          continue;
        }
        // query-core: the ./query entry alone (its optional peer).
        if (found.specifier === "@tanstack/query-core") {
          expect(found.file).toBe("query.ts");
          continue;
        }
        // react-query: the ./react entry alone (its optional peer).
        if (found.specifier === "@tanstack/react-query") {
          expect(found.file).toBe("react.ts");
          continue;
        }
        // zod: types only, in the ./zod entry alone.
        expect(found).toEqual({
          file: "zod.ts",
          type: true,
          specifier: "zod/v4/core",
        });
      }
    }
  });

  it("keeps the query layer out of the core: no lib/ module imports ./query, but ./react its types (plan §10.1)", async () => {
    for (const file of readdirSync(join(ROOT, "lib")).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".d.ts"),
    )) {
      const source = await Bun.file(join(ROOT, "lib", file)).text();
      expect({
        file,
        values:
          /^import(?! type)[^"]*from "\.\/query"|import\("\.\/query"\)/m.test(
            source,
          ),
        types: /^import type[^"]*from "\.\/query"/m.test(source),
      }).toEqual({
        file,
        values: false,
        types: file === "react.ts",
      });
    }
  });

  it("keeps the React binding out of every other entry: no lib/ module imports ./react (plan §10.1)", async () => {
    for (const file of readdirSync(join(ROOT, "lib")).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".d.ts"),
    )) {
      const source = await Bun.file(join(ROOT, "lib", file)).text();
      expect({
        file,
        imports: /from "\.\/react"|import\("\.\/react"\)/.test(source),
      }).toEqual({ file, imports: false });
    }
  });

  it("loads the checks module only by a dynamic import, from the client alone", async () => {
    for (const file of readdirSync(join(ROOT, "lib")).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".d.ts"),
    )) {
      const source = await Bun.file(join(ROOT, "lib", file)).text();
      expect({
        file,
        value: /^import(?! type)[^"]*from "\.\/validation"/m.test(source),
        dynamic: source.includes('import("./validation")'),
      }).toEqual({ file, value: false, dynamic: file === "client.ts" });
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

  it("checks every entry as a browser entry, but the Bun-only generator", () => {
    for (const entry of checkConfig.entries)
      expect({ spelling: entry.spelling, browser: entry.browser }).toEqual({
        spelling: entry.spelling,
        browser: entry.spelling.includes("codegen") ? undefined : true,
      });
    expect(
      checkConfig.entries.filter((entry) => entry.spelling.includes("codegen"))
        .length,
    ).toBeGreaterThan(0);
  });
});
