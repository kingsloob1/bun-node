/**
 * The published shape: `exports` and the declaration build.
 *
 * The end-to-end proof is the consumer check against a packed tarball
 * (`bun scripts/consumer-check.ts packages/bun-security` from the repo
 * root), which is too slow for `bun test`. These are the invariants that
 * check depends on, cheap enough to hold on every run.
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

const manifest = (await Bun.file(join(ROOT, "package.json")).json()) as {
  version: string;
  exports: Record<string, string | Conditions>;
  files: string[];
  main: string;
  types: string;
  sideEffects: unknown;
  publishConfig: { access: string };
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
};

const checkConfig = (await Bun.file(
  join(ROOT, "consumer-check.json"),
).json()) as CheckConfig;

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
    expect(manifest.files).toEqual(["dts", "lib"]);
  });

  it("checks the ./serve subpath, the plain Bun.serve integration", () => {
    for (const key of ["./serve", "./lib/serve"]) {
      expect(manifest.exports[key]).toEqual({
        "@kingsleyweb/source": "./lib/serve/index.ts",
        types: "./dts/serve/index.d.ts",
        default: "./lib/serve/index.ts",
      });
    }
    expect(
      checkConfig.entries?.some(
        (entry) => entry.spelling === "@kingsleyweb/bun-security/serve",
      ),
    ).toBe(true);
  });

  it("checks the ./http subpath, the bun-common adapter integration", () => {
    for (const key of ["./http", "./lib/http"]) {
      expect(manifest.exports[key]).toEqual({
        "@kingsleyweb/source": "./lib/http/index.ts",
        types: "./dts/http/index.d.ts",
        default: "./lib/http/index.ts",
      });
    }
  });

  it("checks the ./stores subpath, the shared store over bun-cache", () => {
    for (const key of ["./stores", "./lib/stores"]) {
      expect(manifest.exports[key]).toEqual({
        "@kingsleyweb/source": "./lib/stores/index.ts",
        types: "./dts/stores/index.d.ts",
        default: "./lib/stores/index.ts",
      });
    }
  });

  it("gives the challenges their own subpath, ./challenge (PR-S9)", () => {
    for (const key of ["./challenge", "./lib/challenge"]) {
      expect(manifest.exports[key]).toEqual({
        "@kingsleyweb/source": "./lib/challenge/index.ts",
        types: "./dts/challenge/index.d.ts",
        default: "./lib/challenge/index.ts",
      });
    }
  });

  it("gives IP intelligence its own subpath, ./intel (PR-S10)", () => {
    for (const key of ["./intel", "./lib/intel"]) {
      expect(manifest.exports[key]).toEqual({
        "@kingsleyweb/source": "./lib/intel/index.ts",
        types: "./dts/intel/index.d.ts",
        default: "./lib/intel/index.ts",
      });
    }
  });

  it("gives the security store ./store, and the testing kits ./testing (PR-D1, PR-T2)", () => {
    for (const area of ["store", "testing"]) {
      for (const key of [`./${area}`, `./lib/${area}`]) {
        expect(manifest.exports[key]).toEqual({
          "@kingsleyweb/source": `./lib/${area}/index.ts`,
          types: `./dts/${area}/index.d.ts`,
          default: `./lib/${area}/index.ts`,
        });
      }
    }
  });

  it("gives the control plane ./control, its browser-safe contract ./control/contract, and bundles ./bundle (PR-CP2)", () => {
    for (const area of ["control", "control/contract", "bundle"]) {
      for (const key of [`./${area}`, `./lib/${area}`]) {
        expect(manifest.exports[key]).toEqual({
          "@kingsleyweb/source": `./lib/${area}/index.ts`,
          types: `./dts/${area}/index.d.ts`,
          default: `./lib/${area}/index.ts`,
        });
      }
    }
  });

  it("checks every literal subpath in the consumer check", () => {
    const spellings = new Set(
      checkConfig.entries?.map((entry) => entry.spelling),
    );
    for (const key of Object.keys(manifest.exports)) {
      if (key.includes("*") || key === "./package.json") continue;
      expect(
        spellings.has(
          key === "."
            ? "@kingsleyweb/bun-security"
            : `@kingsleyweb/bun-security${key.slice(1)}`,
        ),
      ).toBe(true);
    }
  });
});

describe("what scripts/publish.ts requires of a new package (docs/releasing.md)", () => {
  it("has the lerna version, public access, a prepack and a LICENSE", async () => {
    const lerna = (await Bun.file(join(ROOT, "../../lerna.json")).json()) as {
      version: string;
    };
    expect(manifest.version).toBe(lerna.version);
    expect(manifest.publishConfig.access).toBe("public");
    expect(manifest.scripts.prepack).toBe("bun scripts/build-declarations.ts");
    expect(existsSync(join(ROOT, "LICENSE"))).toBe(true);
  });

  it("declares sideEffects as the one module that runs at load (proved by treeShaking.test.ts)", () => {
    expect(manifest.sideEffects).toEqual([
      "./lib/testing/crossprocess-worker.ts",
    ]);
  });
});

describe("this package's dependencies", () => {
  // Every module's declarations import bun-common (trust-proxy types, the
  // duration type, ConfigError), and the store's import bun-sql (its sync
  // types, sqliteStore's dialect); a declaration must never import an
  // undeclared package, so both are runtime dependencies.
  it("declares bun-common and bun-sql as runtime dependencies on workspace:^, and nothing else", () => {
    expect(manifest.dependencies).toEqual({
      "@kingsleyweb/bun-common": "workspace:^",
      "@kingsleyweb/bun-sql": "workspace:^",
    });
  });

  it("needs one optional peer, bun-cache, for ./stores alone", () => {
    const optional = new Set(
      Object.entries(manifest.peerDependenciesMeta)
        .filter(([, meta]) => meta.optional)
        .map(([name]) => name),
    );
    expect(optional).toEqual(
      new Set(["@kingsleyweb/bun-cache", "@types/bun", "typescript"]),
    );
    expect(manifest.peerDependencies["@kingsleyweb/bun-cache"]).toBe(
      "workspace:^",
    );
    for (const entry of checkConfig.entries ?? []) {
      expect(entry.peers ?? []).toEqual(
        entry.spelling.includes("/stores") ? ["@kingsleyweb/bun-cache"] : [],
      );
    }
  });
});
