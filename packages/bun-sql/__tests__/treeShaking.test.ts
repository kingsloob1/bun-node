/**
 * Tree shaking: `package.json`'s `sideEffects` is `false`, and that is true
 * of every module: none runs anything at load. Bun's runtime ignores the
 * field, so no other suite can see it being wrong: only a bundle can. Two
 * things are checked:
 *
 * - **the field is true**: no `lib/` module has a statement that runs at
 *   load, read from each file's syntax tree;
 * - **one export weighs one export**: `encodePageCursor` bundles to under
 *   {@link BOUND} without the dialect module, which it does not use; the
 *   negative control, a copy without the field, keeps that module's
 *   process-wide SQLite write lock (`new Mutex()` at load is a call a
 *   bundler must keep unless the field lets it drop the module).
 *
 * Bytes are a correctness check here, not a benchmark.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Glob } from "bun";
import { afterAll, describe, expect, it } from "bun:test";
import ts from "typescript";

const ROOT = resolve(import.meta.dir, "..");

/** The package's manifest, as published. */
const MANIFEST = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
) as {
  name: string;
  files: string[];
  sideEffects?: unknown;
};

/**
 * The most the one-export app may weigh, minified. Measured 2026-11-16 (Bun
 * 1.4.5-canary.1+862278db7): 181 bytes with the field, 1,206 without, which
 * keeps the dialect module's lock and bun-common's `Mutex` with it.
 */
const BOUND = 1024;

/**
 * Text from bun-common's `Mutex`, which only `lib/dialect/dialect.ts`
 * reaches (its SQLite write lock): present only when the field is missing.
 */
const UNRELATED = "runExclusive";

/** The one-export app. */
const APP = `import { encodePageCursor } from "${MANIFEST.name}";\nexport const encode = encodePageCursor;\n`;

/** Scratch space under `node_modules`, so dependencies resolve from it. */
const WORK = (() => {
  const base = join(ROOT, "node_modules", ".cache");
  mkdirSync(base, { recursive: true });
  return appDir(mkdtempSync(join(base, "tree-shaking-")));
})();

afterAll(() => rmSync(WORK, { recursive: true, force: true }));

let apps = 0;

/** Makes `dir` an app's package scope, so an import never self-references the package; returns it. */
function appDir(dir: string): string {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "tree-shaking-app", private: true }),
  );
  return dir;
}

/** A copy of the package as published, with `sideEffects` replaced; returns the app directory beside it. */
function copyPackage(sideEffects: unknown): string {
  const dir = appDir(mkdtempSync(join(WORK, "copy-")));
  const target = join(dir, "node_modules", ...MANIFEST.name.split("/"));
  mkdirSync(target, { recursive: true });
  for (const entry of MANIFEST.files) {
    if (entry !== "dts" && existsSync(join(ROOT, entry))) {
      cpSync(join(ROOT, entry), join(target, entry), { recursive: true });
    }
  }
  const manifest: Record<string, unknown> = { ...MANIFEST, sideEffects };
  if (sideEffects === undefined) delete manifest.sideEffects;
  writeFileSync(join(target, "package.json"), JSON.stringify(manifest));
  return dir;
}

/** Bundles `code`, written in `dir`, minified for Bun. */
async function bundle(dir: string, code: string): Promise<string> {
  const entry = join(dir, `app-${apps++}.ts`);
  writeFileSync(entry, code);
  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    format: "esm",
    minify: true,
    throw: false,
  });
  if (!result.success) throw new AggregateError(result.logs, "bundle failed");
  return (await Promise.all(result.outputs.map((o) => o.text()))).join("\n");
}

/** Whether `source` has a top-level statement that runs something at load. */
function runsAtLoad(source: string): boolean {
  return ts
    .createSourceFile("m.ts", source, ts.ScriptTarget.Latest)
    .statements.some(
      (statement) =>
        ts.isExpressionStatement(statement) ||
        ts.isIfStatement(statement) ||
        ts.isIterationStatement(statement, false) ||
        ts.isTryStatement(statement),
    );
}

describe("sideEffects", () => {
  it("is false, and no module runs anything at load", async () => {
    const found: string[] = [];
    for await (const file of new Glob("**/*.ts").scan(join(ROOT, "lib"))) {
      if (runsAtLoad(readFileSync(join(ROOT, "lib", file), "utf8"))) {
        found.push(`./lib/${file}`);
      }
    }
    expect(found).toEqual([]);
    expect(MANIFEST.sideEffects).toBe(false);
  });

  it("negative control: the reader sees a statement that runs at load", () => {
    expect(runsAtLoad("start();")).toBe(true);
    expect(runsAtLoad("if (import.meta.main) start();")).toBe(true);
    expect(runsAtLoad("export const a = 1;\nexport function b() {}")).toBe(
      false,
    );
  });
});

describe("one export in a bundle", () => {
  it("weighs that export, not the package, and leaves out an unrelated module", async () => {
    const code = await bundle(copyPackage(MANIFEST.sideEffects), APP);
    expect(code).toContain("base64url");
    expect(code).not.toContain(UNRELATED);
    expect(code.length).toBeLessThanOrEqual(BOUND);
  });

  it("negative control: without sideEffects the unrelated module stays", async () => {
    const code = await bundle(copyPackage(undefined), APP);
    expect(code).toContain(UNRELATED);
  });
});
