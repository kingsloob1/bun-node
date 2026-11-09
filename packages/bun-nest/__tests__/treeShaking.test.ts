/**
 * Tree shaking: `package.json` declares `"sideEffects": false`. Bun's runtime
 * ignores the field, so no other suite can see it being wrong: only a bundle
 * can. What runs at load here touches nothing outside its own module: the
 * decorators applied by call (oven-sh/bun#28605) write metadata on the class
 * beside them, and one probe sets a variable of its own. So a module nothing
 * uses can go, and a module something uses keeps its decorators.
 *
 * - **nothing reaches outside its module**: every top-level statement that
 *   runs is a decorator on a class declared in that file, or {@link PROBE},
 *   read from each file's syntax tree;
 * - **one export weighs one export**: `seconds` bundles to under {@link BOUND},
 *   with Nest left external. Measured 2026-11-09 (Bun
 *   1.4.4-canary.1+11c367163): 66 bytes with the field, 977,662 without, the
 *   negative control;
 * - **a decorator survives**: `BunThrottlerGuard`, from the bundle, still
 *   carries `Injectable()`'s metadata.
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

/** The one call at load that is not a decorator; it sets a variable in `lib/BunHttpAdapter.ts`. */
const PROBE = "askCoreRunsMiddlewareOnce";

/** The most the one-export app may weigh, minified (measured: 66 bytes). */
const BOUND = 1024;

/** The metadata key `Injectable()` writes, in Nest 11 and 12. */
const INJECTABLE_WATERMARK = "__injectable__";

/** Scratch space under `node_modules`, so Nest and the dependencies resolve from it. */
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

/** Bundles `code`, written in `dir`, minified for Bun with Nest external; returns the output's path and text. */
async function bundle(
  dir: string,
  code: string,
): Promise<{ path: string; text: string }> {
  const id = apps++;
  const entry = join(dir, `app-${id}.ts`);
  writeFileSync(entry, code);
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: join(dir, `out-${id}`),
    target: "bun",
    format: "esm",
    minify: true,
    throw: false,
    external: ["@nestjs/*", "reflect-metadata", "rxjs"],
  });
  if (!result.success) throw new AggregateError(result.logs, "bundle failed");
  const output = result.outputs[0]!;
  return { path: output.path, text: await output.text() };
}

/** What `source` runs at load that could reach outside its module. */
function reachesOutside(source: string): string[] {
  const file = ts.createSourceFile("m.ts", source, ts.ScriptTarget.Latest);
  const classes = new Set(
    file.statements.flatMap((statement) =>
      ts.isClassDeclaration(statement) && statement.name
        ? [statement.name.text]
        : [],
    ),
  );
  const found: string[] = [];
  for (const statement of file.statements) {
    if (
      ts.isIfStatement(statement) ||
      ts.isIterationStatement(statement, false) ||
      ts.isTryStatement(statement)
    ) {
      found.push(statement.getText(file).slice(0, 60));
      continue;
    }
    if (!ts.isExpressionStatement(statement)) continue;
    const text = statement.getText(file);
    if (text.startsWith(`${PROBE}()`)) continue;
    const call = statement.expression;
    const target =
      ts.isCallExpression(call) && ts.isCallExpression(call.expression)
        ? call.arguments[0]
        : undefined;
    const decorates =
      target !== undefined &&
      ts.isIdentifier(target) &&
      classes.has(target.text);
    if (!decorates) found.push(text.slice(0, 60));
  }
  return found;
}

describe("sideEffects", () => {
  it("declares false, and nothing at load reaches outside its module", async () => {
    expect(MANIFEST.sideEffects).toBe(false);
    const found: string[] = [];
    for await (const file of new Glob("**/*.ts").scan(join(ROOT, "lib"))) {
      const source = readFileSync(join(ROOT, "lib", file), "utf8");
      for (const text of reachesOutside(source)) found.push(`${file}: ${text}`);
    }
    expect(found).toEqual([]);
  });

  it("negative control: the reader sees what reaches outside", () => {
    expect(reachesOutside("start();")).toEqual(["start();"]);
    expect(reachesOutside("Injectable()(Elsewhere);")).toEqual([
      "Injectable()(Elsewhere);",
    ]);
    expect(reachesOutside("if (a) b();")).toEqual(["if (a) b();"]);
    expect(reachesOutside("class A {}\nInjectable()(A);")).toEqual([]);
  });
});

describe("in a bundle", () => {
  const app = `import { seconds } from "${MANIFEST.name}";\nexport const duration = seconds;\n`;

  it("one export weighs that export, not the package", async () => {
    const { text } = await bundle(copyPackage(MANIFEST.sideEffects), app);
    expect(text.length).toBeLessThanOrEqual(BOUND);
  });

  it("negative control: without sideEffects the bound fails", async () => {
    const { text } = await bundle(copyPackage(undefined), app);
    expect(text.length).toBeGreaterThan(BOUND);
  });

  it("a decorator applied by call survives", async () => {
    const { path } = await bundle(
      copyPackage(MANIFEST.sideEffects),
      `import { BunThrottlerGuard } from "${MANIFEST.name}";\nexport const guard = BunThrottlerGuard;\n`,
    );
    const { guard } = (await import(path)) as { guard: object };
    expect(Reflect.getMetadata(INJECTABLE_WATERMARK, guard)).toBe(true);
    // Negative control: the key is what marks a decorated class.
    expect(
      Reflect.getMetadata(INJECTABLE_WATERMARK, class Plain {}),
    ).toBeUndefined();
  });
});
