/**
 * The published shape: `exports` and the declaration build.
 *
 * The end-to-end proof is the consumer check against a packed tarball
 * (`bun scripts/consumer-check.ts packages/bun-auth` from the repo
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

  it("gives every area its own subpath", () => {
    for (const area of ["serve", "sql", "password"]) {
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
            ? "@kingsleyweb/bun-auth"
            : `@kingsleyweb/bun-auth${key.slice(1)}`,
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

  it("declares sideEffects false (proved by treeShaking.test.ts)", () => {
    expect(manifest.sideEffects).toBe(false);
  });
});

describe("this package's dependencies", () => {
  // Plan §3: bun-common is the one runtime dependency; better-auth is the
  // app's, a required peer.
  it("declares bun-common as a runtime dependency on workspace:^, and nothing else", () => {
    expect(manifest.dependencies).toEqual({
      "@kingsleyweb/bun-common": "workspace:^",
    });
  });

  it("needs better-auth as a required peer, >=1.7.0 <2 (plan Q1)", () => {
    expect(manifest.peerDependencies["better-auth"]).toBe(">=1.7.0 <2");
    expect(manifest.peerDependenciesMeta["better-auth"]).toBeUndefined();
  });

  it("keeps bun-node's packages optional peers, which nothing imports statically", async () => {
    for (const peer of ["@kingsleyweb/bun-security", "@kingsleyweb/bun-sql"]) {
      expect(manifest.peerDependencies[peer]).toBe("workspace:^");
      expect(manifest.peerDependenciesMeta[peer]?.optional).toBe(true);
    }
    // bun-security is only probed, lazily, by name (lib/limiter.ts).
    for await (const file of new Bun.Glob("**/*.ts").scan(join(ROOT, "lib"))) {
      const source = await Bun.file(join(ROOT, "lib", file)).text();
      expect({
        file,
        imports: /from\s+["']@kingsleyweb\/bun-security/.test(source),
      }).toEqual({ file, imports: false });
    }
  });

  it("checks the root, ./serve and ./password in a consumer with no optional peer", () => {
    for (const entry of checkConfig.entries ?? []) {
      if (
        entry.spelling === "@kingsleyweb/bun-auth" ||
        entry.spelling.startsWith("@kingsleyweb/bun-auth/serve") ||
        entry.spelling.startsWith("@kingsleyweb/bun-auth/lib/serve") ||
        entry.spelling.startsWith("@kingsleyweb/bun-auth/password") ||
        entry.spelling.startsWith("@kingsleyweb/bun-auth/lib/password") ||
        entry.spelling === "@kingsleyweb/bun-auth/lib"
      ) {
        expect(entry.peers ?? []).toEqual([]);
      }
    }
  });
});
