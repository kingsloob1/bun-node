/**
 * Tree shaking: `package.json`'s `sideEffects` lists exactly the modules that
 * run something at load: one process entry, for the cross-process tests. Bun's runtime
 * ignores the field, so no other suite can see it being wrong: only a bundle
 * can. Three things are checked:
 *
 * - **the list is complete**: every `lib/` module with a statement that runs
 *   at load is on it, read from each file's syntax tree;
 * - **one export weighs one export**: `fromSimpleDriver` bundles to under
 *   {@link BOUND}. Measured 2026-11-09 (Bun 1.4.4-canary.1+11c367163): 1,335
 *   bytes with the field, 23,891 without, the negative control;
 * - **an entry's effect survives**: importing the process entry keeps the
 *   module. Under a plain `false` it bundles to nothing, the negative control.
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
) as { name: string; files: string[]; sideEffects?: unknown };

/** The modules that run at load: what `package.json` must list. */
const EFFECTFUL = ["./lib/testing/crossprocess-worker.ts"];

/** The most the one-export app may weigh, minified (measured: 1,335 bytes). */
const BOUND = 4096;

/** The one-export app. */
const APP = `import { fromSimpleDriver } from "${MANIFEST.name}";\nexport const adapt = fromSimpleDriver;\n`;

/** An app that imports the process entry for its effect alone. */
const ENTRY_APP = `import "${MANIFEST.name}/lib/testing/crossprocess-worker.ts";\n`;

/** Text from `lib/testing/crossprocess-worker.ts`. */
const ENTRY_TEXT = "setInterval(";

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
  it("lists exactly the modules that run at load", async () => {
    const found: string[] = [];
    for await (const file of new Glob("**/*.ts").scan(join(ROOT, "lib"))) {
      if (runsAtLoad(readFileSync(join(ROOT, "lib", file), "utf8"))) {
        found.push(`./lib/${file}`);
      }
    }
    expect(found.sort()).toEqual(EFFECTFUL);
    expect(MANIFEST.sideEffects).toEqual(EFFECTFUL);
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
  it("weighs that export, not the package", async () => {
    const code = await bundle(copyPackage(MANIFEST.sideEffects), APP);
    expect(code.length).toBeLessThanOrEqual(BOUND);
  });

  it("negative control: without sideEffects the bound fails", async () => {
    const code = await bundle(copyPackage(undefined), APP);
    expect(code.length).toBeGreaterThan(BOUND);
  });
});

describe("an entry imported for its effect", () => {
  it("survives", async () => {
    const code = await bundle(copyPackage(MANIFEST.sideEffects), ENTRY_APP);
    expect(code).toContain(ENTRY_TEXT);
  });

  it("negative control: a plain false drops it", async () => {
    const code = await bundle(copyPackage(false), ENTRY_APP);
    expect(code).not.toContain(ENTRY_TEXT);
  });
});
