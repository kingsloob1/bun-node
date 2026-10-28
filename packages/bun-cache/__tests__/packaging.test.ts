/**
 * The published shape: `exports` and the declaration build.
 *
 * The end-to-end proof is the consumer check against a packed tarball
 * (`bun scripts/consumer-check.ts packages/bun-cache` from the repo root),
 * which is too slow for `bun test`. These are the invariants that check
 * depends on, cheap enough to hold on every run.
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
  exports: Record<string, string | Conditions>;
  files: string[];
  main: string;
  types: string;
  dependencies: Record<string, string>;
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

  // A pattern `./lib/*` maps `lib/testing` to `lib/testing.ts`, which does
  // not exist; a directory import works only with its own key.
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
    expect(manifest.files).toEqual(expect.arrayContaining(["dts", "lib"]));
  });

  it("checks the ./testing subpath, the custom-driver entry", () => {
    expect(manifest.exports["./testing"]).toEqual({
      "@kingsleyweb/source": "./lib/testing/index.ts",
      types: "./dts/testing/index.d.ts",
      default: "./lib/testing/index.ts",
    });
    expect(
      checkConfig.entries?.some(
        (entry) => entry.spelling === "@kingsleyweb/bun-cache/testing",
      ),
    ).toBe(true);
  });

  it("checks the ./http subpath, the response cache", () => {
    expect(manifest.exports["./http"]).toEqual({
      "@kingsleyweb/source": "./lib/http/index.ts",
      types: "./dts/http/index.d.ts",
      default: "./lib/http/index.ts",
    });
    expect(
      checkConfig.entries?.some(
        (entry) => entry.spelling === "@kingsleyweb/bun-cache/http",
      ),
    ).toBe(true);
  });

  it("checks the ./cloudflare-worker subpath, the Worker users deploy, as a browser entry", () => {
    expect(manifest.exports["./cloudflare-worker"]).toEqual({
      "@kingsleyweb/source": "./lib/cloudflare/worker.ts",
      types: "./dts/cloudflare/worker.d.ts",
      default: "./lib/cloudflare/worker.ts",
    });
    const entry = checkConfig.entries?.find(
      (each) => each.spelling === "@kingsleyweb/bun-cache/cloudflare-worker",
    );
    // `browser` is consumer-check.ts's field; the build's CheckConfig does not read it.
    expect((entry as { browser?: boolean } | undefined)?.browser).toBe(true);
  });
});

describe("this package's runtime dependencies", () => {
  // ./http's declarations import bun-common's router types; a declaration
  // must never import an undeclared package, so bun-common stays a runtime
  // dependency (plan §14.1), not a peer or a devDependency.
  it("declares bun-common, which ./http's declarations import", () => {
    expect(manifest.dependencies["@kingsleyweb/bun-common"]).toBeDefined();
  });
});

describe("this package's optional peers", () => {
  const optional = new Set(
    Object.entries(manifest.peerDependenciesMeta)
      .filter(([, meta]) => meta.optional)
      .map(([name]) => name),
  );

  it("declares only real optional peers in consumer-check.json", () => {
    for (const entry of checkConfig.entries ?? []) {
      for (const peer of entry.peers ?? [])
        expect(optional.has(peer)).toBe(true);
    }
  });

  // The peers are the environment's types and `mongodb`, which the MongoDB
  // driver loads at run time through a string-typed `import()` and speaks to
  // through structural types: no declaration imports it, so no entry needs
  // any of them (consumer-check proves it with none installed).
  it("needs no peer for any entry", () => {
    expect(optional).toEqual(new Set(["@types/bun", "mongodb", "typescript"]));
    for (const entry of checkConfig.entries ?? [])
      expect(entry.peers ?? []).toEqual([]);
  });
});
