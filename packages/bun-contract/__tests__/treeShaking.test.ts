/**
 * Tree shaking: a browser app that imports one small export of the package
 * gets that export, not the package. `package.json` declares
 * `"sideEffects": false` (no module here runs anything at load: the audit
 * found only constant `defineTransport(...)` calls, which validate their own
 * literal spec and touch nothing outside the module), so a bundler may drop
 * every module none of whose exports is used.
 *
 * The check bundles a one-export app with `Bun.build` (browser, minified)
 * and holds the bytes under {@link BOUND} and the code free of
 * {@link UNRELATED}, text only the transports' module contains. Measured
 * 2026-11-08 (Bun 1.4.4-canary.1+11c367163): 521 bytes with the field,
 * 5,022 without it, which is the negative control: the same check on a copy
 * of the package without `sideEffects` must fail. Bytes are a correctness
 * check here, not a benchmark.
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
import { afterAll, describe, expect, it } from "bun:test";

const ROOT = resolve(import.meta.dir, "..");

/** The package's manifest, as published. */
const MANIFEST = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
) as { name: string; files: string[]; sideEffects?: unknown };

/** The most the one-export app may weigh, minified (measured: 521 bytes). */
const BOUND = 1024;

/** Text from `lib/transport.ts`, which `documented` does not need. */
const UNRELATED = "defineTransport(";

/** The one-export app. */
const APP = `import { documented } from "${MANIFEST.name}";\nexport const schema = documented;\n`;

/**
 * Scratch space under the package's `node_modules`, so the package and its
 * dependencies resolve from it. Each app directory gets a `package.json` of
 * its own: without one, the package's own manifest would be the app's
 * package scope, and the import would self-reference the package in place,
 * never the copy.
 */
const WORK = (() => {
  const base = join(ROOT, "node_modules", ".cache");
  mkdirSync(base, { recursive: true });
  return appDir(mkdtempSync(join(base, "tree-shaking-")));
})();

afterAll(() => rmSync(WORK, { recursive: true, force: true }));

let apps = 0;

/** Makes `dir` an app's package scope; returns it. */
function appDir(dir: string): string {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "tree-shaking-app", private: true }),
  );
  return dir;
}

/**
 * A copy of the package as it is published (its `files`, without built
 * declarations) in `node_modules` under a fresh directory, with
 * `sideEffects` replaced (`undefined` removes it). Returns the directory: an
 * app written there imports the copy.
 */
function copyPackage(sideEffects: unknown): string {
  const dir = appDir(mkdtempSync(join(WORK, "copy-")));
  const target = join(dir, "node_modules", ...MANIFEST.name.split("/"));
  mkdirSync(target, { recursive: true });
  for (const entry of MANIFEST.files) {
    if (entry === "dts" || entry === "dist") continue;
    if (existsSync(join(ROOT, entry))) {
      cpSync(join(ROOT, entry), join(target, entry), { recursive: true });
    }
  }
  const manifest: Record<string, unknown> = { ...MANIFEST, sideEffects };
  if (sideEffects === undefined) delete manifest.sideEffects;
  writeFileSync(join(target, "package.json"), JSON.stringify(manifest));
  return dir;
}

/** Bundles `code`, written in `dir`, as a browser app's production build would. */
async function bundle(dir: string, code: string): Promise<string> {
  const entry = join(dir, `app-${apps++}.ts`);
  writeFileSync(entry, code);
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    minify: true,
    throw: false,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) throw new AggregateError(result.logs, "bundle failed");
  return (await Promise.all(result.outputs.map((o) => o.text()))).join("\n");
}

/** What is wrong with the one-export app's bundle; empty when nothing is. */
function problems(code: string): string[] {
  const found: string[] = [];
  if (code.length > BOUND) found.push(`${code.length} bytes, over ${BOUND}`);
  if (code.includes(UNRELATED)) found.push(`contains ${UNRELATED}`);
  return found;
}

describe("one export in a browser bundle", () => {
  it("declares sideEffects: false", () => {
    expect(MANIFEST.sideEffects).toBe(false);
  });

  it("weighs that export, not the package", async () => {
    const code = await bundle(WORK, APP);
    expect(problems(code)).toEqual([]);
    // The export itself is there.
    expect(code).toContain("documented():");
  });

  it("is the same from a copy of the package as published", async () => {
    const code = await bundle(copyPackage(MANIFEST.sideEffects), APP);
    expect(problems(code)).toEqual([]);
  });

  it("negative control: without sideEffects the check fails", async () => {
    const code = await bundle(copyPackage(undefined), APP);
    expect(problems(code)).toEqual([
      expect.stringMatching(/bytes, over/),
      `contains ${UNRELATED}`,
    ]);
  });
});
