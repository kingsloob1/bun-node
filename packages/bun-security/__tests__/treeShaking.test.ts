/**
 * Tree shaking: `package.json`'s `sideEffects` is `false`, and that is true
 * of every module: none runs anything at load. Bun's runtime ignores the
 * field, so no other suite can see it being wrong: only a bundle can. Two
 * things are checked:
 *
 * - **the field is true**: no `lib/` module has a statement that runs at
 *   load, read from each file's syntax tree;
 * - **one export weighs one export**: `INTERNAL_RANGES` bundles to under
 *   {@link BOUND} without `ACTION_SEVERITY`, an unrelated module; the
 *   negative control, a copy without the field, keeps it.
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
 * 1.4.5-canary.1+862278db7): 186 bytes with the field, 344 without, which
 * keeps every module's top-level `Object.freeze(...)` call.
 */
const BOUND = 2048;

/**
 * Text from `lib/engine/actions.ts` (`ACTION_SEVERITY`), a module the
 * one-export app does not use: present only when the field is missing.
 */
const UNRELATED = "challenge:4";

/** The one-export app. */
const APP = `import { INTERNAL_RANGES } from "${MANIFEST.name}";\nexport const ranges = INTERNAL_RANGES;\n`;

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

/** Bundles `code`, written in `dir`, minified for `target` (Bun by default). */
async function bundle(
  dir: string,
  code: string,
  target: "bun" | "browser" = "bun",
): Promise<string> {
  const entry = join(dir, `app-${apps++}.ts`);
  writeFileSync(entry, code);
  const result = await Bun.build({
    entrypoints: [entry],
    target,
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
  it("lists exactly the modules that run at load: the store kit's cross-process worker", async () => {
    const found: string[] = [];
    for await (const file of new Glob("**/*.ts").scan(join(ROOT, "lib"))) {
      if (runsAtLoad(readFileSync(join(ROOT, "lib", file), "utf8"))) {
        found.push(`./lib/${file}`);
      }
    }
    expect(found).toEqual(["./lib/testing/crossprocess-worker.ts"]);
    expect(MANIFEST.sideEffects).toEqual(found);
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
    expect(code).toContain("100.64.0.0/10");
    expect(code).not.toContain(UNRELATED);
    expect(code.length).toBeLessThanOrEqual(BOUND);
  });

  it("negative control: without sideEffects the unrelated module stays", async () => {
    const code = await bundle(copyPackage(undefined), APP);
    expect(code).toContain(UNRELATED);
  });
});

describe("the management API's browser-safe contract (./control/contract, PR-CP2)", () => {
  /** A browser app using one constant of the contract. */
  const CONTRACT_APP = `import { SECURITY_API_PERMISSIONS } from "${MANIFEST.name}/control/contract";\nexport const permissions = SECURITY_API_PERMISSIONS;\n`;
  /**
   * The most the one-export browser app may weigh, minified. Measured
   * 2026-11-17 (Bun 1.4.5-canary.1+862278db7): 251 bytes; 599 with the
   * roles' arrays not marked pure.
   */
  const CONTRACT_BOUND = 1024;

  it("bundles for a browser with one constant, not the module's others", async () => {
    const code = await bundle(
      copyPackage(MANIFEST.sideEffects),
      CONTRACT_APP,
      "browser",
    );
    expect(code).toContain("policy:publish");
    // The roles and the problem codes live in the same module, unused.
    expect(code).not.toContain("approval_closed");
    expect(code).not.toContain("viewer");
    expect(code.length).toBeLessThanOrEqual(CONTRACT_BOUND);
  });

  it("negative control: without the pure marks, the unused frozen constants stay", async () => {
    const dir = copyPackage(MANIFEST.sideEffects);
    const constants = join(
      dir,
      "node_modules",
      ...MANIFEST.name.split("/"),
      "lib/control/contract/constants.ts",
    );
    writeFileSync(
      constants,
      readFileSync(constants, "utf8").replaceAll("/* @__PURE__ */", ""),
    );
    const code = await bundle(dir, CONTRACT_APP, "browser");
    expect(code).toContain("viewer");
  });
});

describe("the agent (./agent, PR-CP4)", () => {
  /** A service's app connecting its agent. */
  const AGENT_APP = `import { connectAgent } from "${MANIFEST.name}/agent";\nexport const connect = connectAgent;\n`;
  /** Text only the control plane's code carries. */
  const CONTROL_MARKER = "the control plane never runs unaudited";
  /** Text only the engine's code carries. */
  const ENGINE_MARKER = "ban() takes exactly one of ip, user, apiKey";

  it("bundles connectAgent without the control plane or the engine", async () => {
    const code = await bundle(copyPackage(MANIFEST.sideEffects), AGENT_APP);
    expect(code).toContain("bun-security-agent/1");
    expect(code).not.toContain(CONTROL_MARKER);
    expect(code).not.toContain(ENGINE_MARKER);
  });

  it("negative control: the control plane's entry carries its marker", async () => {
    const code = await bundle(
      copyPackage(MANIFEST.sideEffects),
      `import { createSecurityApi } from "${MANIFEST.name}/control";\nexport const api = createSecurityApi;\n`,
    );
    expect(code).toContain(CONTROL_MARKER);
  });
});
