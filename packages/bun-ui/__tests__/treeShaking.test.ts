/**
 * Tree shaking: a browser app that imports one small export of
 * `./docs/embed` gets that export, not the viewer.
 *
 * `package.json`'s `sideEffects` is true for the whole package. The audit
 * (2026-11-08, every top-level statement of `lib/` and `app/`) found two
 * kinds of effect at load, both listed:
 *
 * - **stylesheets** (`"**\/*.css"`): the screens import their CSS for its
 *   effect (`import "./http.css"`). A bundler that honours `sideEffects` for
 *   bare imports (webpack does) would drop them under `false`.
 * - **the browser entry points** (`"./app/*\/main.tsx"`): each calls
 *   `boot()` at the top level. They are bundled as entry points, which a
 *   bundler always keeps; listed so the field is true for any importer.
 *
 * Everything else at the top level is module-local: React contexts,
 * `Intl` formatters, constant tables, lazy screens, paths computed from
 * `import.meta.dir` in `lib/`.
 *
 * The checks bundle apps with `Bun.build` (browser, minified):
 *
 * - **size**: `isApiError` from `./docs/embed` stays under {@link BOUND} and
 *   carries no React context (`app/docs/context.ts`) and no `Intl` formatter
 *   (`app/kit/components/Tabs.tsx`). Measured 2026-11-08 (Bun
 *   1.4.4-canary.1+11c367163): 645 bytes of JavaScript with the field, 2,135
 *   without it. The negative control removes the field from a copy.
 * - **stylesheets survive**: `HttpReference` and `WsReference` bring their
 *   CSS. Bun keeps a live module's CSS import even under `false` (measured),
 *   so there is no Bun-built negative control for that entry.
 *
 *   Bun also emits every stylesheet the entry reaches, live module or not:
 *   the one-export app carries 10,656 bytes of CSS (the three screens'),
 *   with or without the field (and esbuild 0.27 does the same). Not
 *   asserted either way.
 * - **the entry's effect survives**: an app importing `app/docs/main.tsx`
 *   keeps `boot()`; the negative control lists the stylesheets alone.
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
import { afterAll, describe, expect, it } from "bun:test";

const ROOT = resolve(import.meta.dir, "..");

/** The package's manifest, as published. */
const MANIFEST = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
) as { name: string; files: string[]; sideEffects?: unknown };

/** What `package.json` must list. */
const EFFECTFUL = ["**/*.css", "./app/*/main.tsx"];

/** The most the one-export app's JavaScript may weigh (measured: 645 bytes; 2,135 without `sideEffects`). */
const BOUND = 1024;

/** Text from modules `isApiError` does not need: a React context, an `Intl` formatter. */
const UNRELATED = ["react.context", "compact"];

/** The one-export app. */
const APP = `import { isApiError } from "${MANIFEST.name}/docs/embed";\nexport const isError = (error: unknown) => isApiError(error);\n`;

/** One rule from each screen's stylesheet. */
const CSS = {
  http: ".http-docs-title",
  schema: ".schema-tree",
  ws: ".ws-docs",
};

/** Text only `app/docs/boot.tsx` carries. */
const BOOT = "The page has no #root element.";

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
 * A copy of the package as it is published (its `files`, without the built
 * bundle and declarations) in `node_modules` under a fresh directory, with
 * `sideEffects` replaced (`undefined` removes it). Returns the copy's
 * directory and the app directory: an app written there imports the copy.
 */
function copyPackage(sideEffects: unknown): { app: string; copy: string } {
  const app = appDir(mkdtempSync(join(WORK, "copy-")));
  const copy = join(app, "node_modules", ...MANIFEST.name.split("/"));
  mkdirSync(copy, { recursive: true });
  for (const entry of MANIFEST.files) {
    if (entry === "dts" || entry === "dist") continue;
    if (existsSync(join(ROOT, entry))) {
      cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
    }
  }
  const manifest: Record<string, unknown> = { ...MANIFEST, sideEffects };
  if (sideEffects === undefined) delete manifest.sideEffects;
  writeFileSync(join(copy, "package.json"), JSON.stringify(manifest));
  return { app, copy };
}

/** Bundles `code`, written in `dir`, as a browser app's production build would: its JavaScript and its CSS. */
async function bundle(
  dir: string,
  code: string,
): Promise<{ js: string; css: string }> {
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
  let js = "";
  let css = "";
  for (const output of result.outputs) {
    if (output.path.endsWith(".css")) css += await output.text();
    else js += await output.text();
  }
  return { js, css };
}

/** What is wrong with the one-export app's JavaScript; empty when nothing is. */
function problems(js: string): string[] {
  const found: string[] = [];
  if (js.length > BOUND) found.push(`${js.length} bytes, over ${BOUND}`);
  for (const text of UNRELATED) {
    if (js.includes(text)) found.push(`contains ${text}`);
  }
  return found;
}

describe("sideEffects", () => {
  it("lists the stylesheets and the entry points", () => {
    expect(MANIFEST.sideEffects).toEqual(EFFECTFUL);
  });

  it("covers every module with an effect at load", async () => {
    // An import for effect must be a stylesheet, and a module making a call
    // at the top level (a line starting with one, as the formatter leaves
    // it) must be an entry point the list names.
    const listed = EFFECTFUL.map((p) => new Bun.Glob(p.replace(/^\.\//, "")));
    const unlisted: string[] = [];
    for (const dir of ["app", "lib"]) {
      for await (const rel of new Bun.Glob(`${dir}/**/*.{ts,tsx}`).scan({
        cwd: ROOT,
      })) {
        const text = await Bun.file(join(ROOT, rel)).text();
        const bare = [...text.matchAll(/^import\s+["']([^"']+)["'];?$/gm)];
        const effect =
          bare.some(([, spec]) => !spec!.endsWith(".css")) ||
          /^[a-z_$][\w$.]*\(/im.test(text);
        if (effect && !listed.some((glob) => glob.match(rel))) {
          unlisted.push(rel);
        }
      }
    }
    expect(unlisted).toEqual([]);
  });
});

describe("one export of ./docs/embed in a browser bundle", () => {
  it("weighs that export, not the viewer", async () => {
    const { js } = await bundle(WORK, APP);
    expect(problems(js)).toEqual([]);
    expect(js).toContain('"ApiError"');
  });

  it("is the same from a copy of the package as published", async () => {
    const { js } = await bundle(copyPackage(MANIFEST.sideEffects).app, APP);
    expect(problems(js)).toEqual([]);
  });

  it("negative control: without sideEffects the check fails", async () => {
    const { js } = await bundle(copyPackage(undefined).app, APP);
    expect(problems(js)).toEqual([
      expect.stringMatching(/bytes, over/),
      ...UNRELATED.map((text) => `contains ${text}`),
    ]);
  });
});

describe("the listed effects survive tree shaking", () => {
  it("a screen brings its stylesheets", async () => {
    const http = await bundle(
      WORK,
      `import { HttpReference } from "${MANIFEST.name}/docs/embed";\nexport const Screen = HttpReference;\n`,
    );
    expect(http.css).toContain(CSS.http);
    expect(http.css).toContain(CSS.schema);
    const ws = await bundle(
      WORK,
      `import { WsReference } from "${MANIFEST.name}/docs/embed";\nexport const Screen = WsReference;\n`,
    );
    expect(ws.css).toContain(CSS.ws);
  });

  it("an app importing the browser entry point boots the viewer", async () => {
    const real = await bundle(
      WORK,
      `import ${JSON.stringify(join(ROOT, "app", "docs", "main.tsx"))};\n`,
    );
    expect(real.js).toContain(BOOT);
    const { app, copy } = copyPackage(MANIFEST.sideEffects);
    const copied = await bundle(
      app,
      `import ${JSON.stringify(join(copy, "app", "docs", "main.tsx"))};\n`,
    );
    expect(copied.js).toContain(BOOT);
  });

  it("negative control: with the stylesheets alone listed, boot() is dropped", async () => {
    const { app, copy } = copyPackage(["**/*.css"]);
    const { js } = await bundle(
      app,
      `import ${JSON.stringify(join(copy, "app", "docs", "main.tsx"))};\n`,
    );
    expect(js).not.toContain(BOOT);
  });
});
