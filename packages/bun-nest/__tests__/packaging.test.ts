/**
 * The published shape: `exports` and the declaration build.
 *
 * The end-to-end proof is the consumer check against a packed tarball
 * (`bun scripts/consumer-check.ts packages/bun-nest` from the repo root),
 * which is too slow for `bun test`. These are the invariants that check
 * depends on, cheap enough to hold on every run.
 */

import type { CheckConfig, Manifest } from "../scripts/build-declarations";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  checkPeerScopes,
  rewrite,
  typesTarget,
} from "../scripts/build-declarations";

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

  // A pattern `./lib/*` maps `lib/multipart` to `lib/multipart.ts`, which does
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
});

describe("build-declarations rewrite", () => {
  it("makes relative specifiers explicit and leaves bare ones alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bun-nest-dts-"));
    try {
      await mkdir(join(dir, "sub"));
      await writeFile(join(dir, "b.d.ts"), "export type B = 1;\n");
      await writeFile(join(dir, "sub/index.d.ts"), "export type S = 1;\n");
      await writeFile(join(dir, "sub/c.d.ts"), `export * from "..";\n`);
      await writeFile(
        join(dir, "index.d.ts"),
        [
          `export * from "./b";`,
          `export type { S } from "./sub";`,
          `export type T = import("./sub").S;`,
          `export type U = import("./b.js").B;`,
          `import type { FileInfo } from "busboy";`,
          `export type { FileInfo };`,
          ``,
        ].join("\n"),
      );

      expect(await rewrite(dir)).toBe(4);
      expect(await readFile(join(dir, "index.d.ts"), "utf8")).toBe(
        [
          `export * from "./b.js";`,
          `export type { S } from "./sub/index.js";`,
          `export type T = import("./sub/index.js").S;`,
          `export type U = import("./b.js").B;`,
          `import type { FileInfo } from "busboy";`,
          `export type { FileInfo };`,
          ``,
        ].join("\n"),
      );
      expect(await readFile(join(dir, "sub/c.d.ts"), "utf8")).toBe(
        `export * from "../index.js";\n`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("optional peers behind their own entry", () => {
  /** A package with a root and a `./jobs` subpath that needs an optional peer. */
  const pkg: Manifest = {
    name: "@scope/pkg",
    exports: {
      ".": { types: "./dts/index.d.ts", default: "./lib/index.ts" },
      "./jobs": {
        types: "./dts/jobs/index.d.ts",
        default: "./lib/jobs/index.ts",
      },
      "./lib/*": { types: "./dts/*.d.ts", default: "./lib/*.ts" },
    },
    peerDependencies: { peer: "^1" },
    peerDependenciesMeta: { peer: { optional: true } },
  };
  const at = (path: string) => resolve(ROOT, path);
  const jobsEntry = at("dts/jobs/index.d.ts");
  const jobsModule = at("dts/jobs/module.d.ts");
  const peerImports = new Map([[jobsModule, new Set(["peer"])]]);
  const declared: CheckConfig = {
    entries: [{ spelling: "@scope/pkg/jobs", peers: ["peer"] }],
  };
  const check = (config: CheckConfig, edges: [string, string[]][]): string[] =>
    checkPeerScopes(
      pkg,
      config,
      new Map(edges.map(([from, to]) => [at(from), new Set(to.map(at))])),
      peerImports,
      () => true,
    );

  it("resolves subpaths through exports, patterns included", () => {
    expect(typesTarget(pkg, ".")).toBe(at("dts/index.d.ts"));
    expect(typesTarget(pkg, "./jobs")).toBe(jobsEntry);
    expect(typesTarget(pkg, "./lib/jobs/module")).toBe(jobsModule);
    expect(typesTarget(pkg, "./nope")).toBeNull();
  });

  it("allows the peer behind the entry that declares it", () => {
    expect(
      check(declared, [["dts/jobs/index.d.ts", ["dts/jobs/module.d.ts"]]]),
    ).toEqual([]);
  });

  it("fails when the entry does not declare the peer", () => {
    const problems = check({ entries: [] }, [
      ["dts/jobs/index.d.ts", ["dts/jobs/module.d.ts"]],
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`exports["./jobs"]`);
  });

  it("fails when the root reaches the peer, even if another entry declares it", () => {
    const problems = check(declared, [
      ["dts/index.d.ts", ["dts/jobs/index.d.ts"]],
      ["dts/jobs/index.d.ts", ["dts/jobs/module.d.ts"]],
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`exports["."]`);
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

  it("scopes @kingsleyweb/bun-jobs to the jobs subpath, never the root", () => {
    const peersOf = (spelling: string) =>
      checkConfig.entries?.find((e) => e.spelling === spelling)?.peers ?? [];
    expect(peersOf("@kingsleyweb/bun-nest/jobs")).toContain(
      "@kingsleyweb/bun-jobs",
    );
    expect(peersOf("@kingsleyweb/bun-nest")).toEqual([]);
  });
});
