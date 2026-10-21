/**
 * The published shape: `exports` and the declaration build.
 *
 * The end-to-end proof is the consumer check against a packed tarball
 * (`bun scripts/consumer-check.ts packages/bun-common` from the repo root),
 * which is too slow for `bun test`. These are the invariants that check
 * depends on, cheap enough to hold on every run.
 */

import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";
import { rewrite } from "../scripts/build-declarations";

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
};

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

  it("publishes the contract core at the browser-safe ./contract subpath", () => {
    const conditions = {
      "@kingsleyweb/source": "./lib/contract/index.ts",
      types: "./dts/contract/index.d.ts",
      default: "./lib/contract/index.ts",
    };
    expect(manifest.exports["./contract"]).toEqual(conditions);
    expect(manifest.exports["./lib/contract"]).toEqual(conditions);
  });

  it("keeps main on the source and types on the declarations, both published", () => {
    expect(manifest.main).toBe("lib/index.ts");
    expect(manifest.types).toBe("dts/index.d.ts");
    expect(manifest.files).toEqual(expect.arrayContaining(["dts", "lib"]));
  });
});

describe("the declaration build", () => {
  // `tsconfig.build.json` decides what reaches `dts/`; a module it missed
  // would leave `./contract`'s `types` target pointing at nothing.
  it("covers every module of lib/contract", () => {
    const configPath = join(ROOT, "tsconfig.build.json");
    const read = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
    expect(read.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT);
    const built = new Set(parsed.fileNames.map((f) => resolve(f)));
    const contract = readdirSync(join(ROOT, "lib/contract")).filter((f) =>
      f.endsWith(".ts"),
    );
    expect(contract).toContain("index.ts");
    for (const file of contract) {
      expect(built.has(join(ROOT, "lib/contract", file))).toBe(true);
    }
  });
});

describe("build-declarations rewrite", () => {
  it("makes relative specifiers explicit and leaves bare ones alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bun-common-dts-"));
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
