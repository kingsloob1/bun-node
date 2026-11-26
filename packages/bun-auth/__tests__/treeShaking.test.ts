/**
 * Tree shaking: `package.json`'s `sideEffects` is `false`, and that is true
 * of every module: none runs anything at load. Bun's runtime ignores the
 * field, so no other suite can see it being wrong: only a bundle can. Three
 * things are checked:
 *
 * - **the field is true**: no `lib/` module has a statement that runs at
 *   load, read from each file's syntax tree;
 * - **one export weighs one export**: `requireSession` bundles to under
 *   {@link BOUND} without the mount module (`webRequest`, the bun-security
 *   probe), and `./serve`'s `withAuth` without the session module;
 * - **the field is honoured**: the negative control plants a statement that
 *   runs at load in the mount module of a copy; with the field the bundle
 *   leaves it out, and without it the bundle keeps it.
 *
 * bun-common is imported by its `lib/*` modules, not its root, so one export
 * does not carry the whole of bun-common (its root bundled to about 351 KB).
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
 * The most the one-export app may weigh, minified. Measured 2026-11-26 (Bun
 * 1.4.5-canary.1+862278db7): 2,256 bytes, with or without the field (no
 * module has an effect at load to keep).
 */
const BOUND = 4096;

/** The most `./serve`'s one-export app may weigh: measured 12,429 bytes. */
const SERVE_BOUND = 16_384;

/** Text from the mount module (its `webRequest()` hand-over), unrelated to `requireSession`. */
const UNRELATED = "webRequest";

/** Text from the session module, unrelated to `withAuth`. */
const SESSION_TEXT = "urn:bun-auth:error";

/** The marker the negative control plants. */
const PLANTED = "bun-auth-planted-effect";

/** The one-export app. */
const APP = `import { requireSession } from "${MANIFEST.name}";\nexport const guard = requireSession;\n`;

/** The one-export app of `./serve`. */
const SERVE_APP = `import { withAuth } from "${MANIFEST.name}/serve";\nexport const wrap = withAuth;\n`;

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

/**
 * A copy of the package as published, with `sideEffects` replaced and, with
 * `plant`, a statement that runs at load added to the mount module; returns
 * the app directory beside it.
 */
function copyPackage(sideEffects: unknown, plant = false): string {
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
  if (plant) {
    const mount = join(target, "lib", "mount.ts");
    writeFileSync(
      mount,
      `${readFileSync(mount, "utf8")}\n(globalThis as Record<string, unknown>).planted = "${PLANTED}";\n`,
    );
  }
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
    expect(code).toContain(SESSION_TEXT);
    expect(code).not.toContain(UNRELATED);
    expect(code).not.toContain("bun-security");
    expect(code.length).toBeLessThanOrEqual(BOUND);
  });

  it("./serve's withAuth leaves out the session module", async () => {
    const code = await bundle(copyPackage(MANIFEST.sideEffects), SERVE_APP);
    expect(code).toContain("x-bun-auth-client-ip");
    expect(code).not.toContain(SESSION_TEXT);
    expect(code.length).toBeLessThanOrEqual(SERVE_BOUND);
  });

  it("drops a planted effect in an unused module with the field", async () => {
    const code = await bundle(copyPackage(MANIFEST.sideEffects, true), APP);
    expect(code).not.toContain(PLANTED);
  });

  it("negative control: without sideEffects the planted effect stays", async () => {
    const code = await bundle(copyPackage(undefined, true), APP);
    expect(code).toContain(PLANTED);
  });
});
