/**
 * Tree shaking: a browser app that imports one small export of a
 * browser-safe entry gets that export, not the package.
 *
 * `package.json`'s `sideEffects` is true for the whole package. The audit
 * (2026-11-08, every top-level statement of `lib/`) found one module with a
 * real effect at load: `lib/contract/logger.ts`, which installs bun-common's
 * logger resolution into `@kingsleyweb/bun-contract` (`setLoggerResolver`).
 * Three modules import it for that effect alone (`import "./logger"`) and
 * otherwise only re-export bun-contract: `lib/contract/index.ts` (the
 * `./contract` entry), `guard.ts` and `describe.ts`. All four are listed. A
 * bundler skips a side-effect-free module that only re-exports, and its
 * bare imports with it, so listing `logger.ts` alone keeps nothing (measured:
 * the resolver was dropped from all three entries). Every other top-level
 * statement is module-local: constants, schema builders, a class's own
 * `name`, a static block assigning a module variable.
 *
 * The checks bundle one-export apps with `Bun.build` (browser, minified):
 *
 * - **size**: `documented` from `./contract` and `SseParser` from `./sse`
 *   stay under their bound and free of text from an unrelated module.
 *   Measured 2026-11-08 (Bun 1.4.4-canary.1+11c367163): 6,185 and 1,470
 *   bytes with the field, 10,708 and 26,215 without it. `./contract` only
 *   re-exports bun-contract, so its weight is bun-contract's field at work
 *   (its modules here are all listed): its negative control removes the
 *   field from both packages.
 * - **the listed effect survives**: an app importing from each of the three
 *   modules gets bun-common's resolution (a `Logger`, with `child`, for no
 *   logger), run from the built bundle.
 *
 * Negative controls: the size checks fail on a copy of the package without
 * `sideEffects`, and the effect check on a copy with `sideEffects: false`.
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
import { dirname, join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";

const ROOT = resolve(import.meta.dir, "..");

/** The package's manifest, as published. */
const MANIFEST = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
) as { name: string; files: string[]; sideEffects?: unknown };

/** The modules with an effect at load, as `package.json` must list them. */
const EFFECTFUL = [
  "./lib/contract/describe.ts",
  "./lib/contract/guard.ts",
  "./lib/contract/index.ts",
  "./lib/contract/logger.ts",
];

/** A one-export app, the most it may weigh minified, and text it must not carry. */
interface SizeCase {
  /** What the app imports. */
  name: string;
  /** The app's source; `PKG` stands for the package's name. */
  app: string;
  /** The most its bundle may weigh, in bytes. */
  bound: number;
  /** Text from a module the export does not need. */
  unrelated: string;
  /** Whether the negative control also removes bun-contract's `sideEffects`. */
  viaContract?: boolean;
}

const SIZE_CASES: readonly SizeCase[] = [
  {
    // Measured 6,185 bytes, most of it the logger resolution `./contract`
    // installs (`lib/logging.ts`); 10,708 without `sideEffects`.
    name: "documented from ./contract",
    app: `import { documented } from "PKG/contract";\nexport const schema = documented;\n`,
    bound: 8192,
    unrelated: "defineTransport(",
    viaContract: true,
  },
  {
    // Measured 1,470 bytes; 26,215 without `sideEffects` (the writer, the
    // response and the logger came along).
    name: "SseParser from ./sse",
    app: `import { SseParser } from "PKG/sse";\nexport const Parser = SseParser;\n`,
    bound: 4096,
    unrelated: "SseWriter:",
  },
];

/** The modules whose import installs the resolution, and one export of each. */
const EFFECT_CASES = [
  { from: "PKG/contract", name: "documented" },
  { from: "PKG/lib/contract/guard", name: "createReceiver" },
  { from: "PKG/lib/contract/describe", name: "describeContract" },
] as const;

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

/** bun-contract's directory, as this package resolves it. */
const CONTRACT_ROOT = dirname(
  Bun.resolveSync("@kingsleyweb/bun-contract/package.json", ROOT),
);

/**
 * Copies the package at `root` as it is published (its `files`, without
 * built declarations) into `dir`'s `node_modules`, with `sideEffects`
 * replaced (`undefined` removes it).
 */
function copyInto(dir: string, root: string, sideEffects: unknown): void {
  const manifest = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as { name: string; files: string[]; sideEffects?: unknown };
  const target = join(dir, "node_modules", ...manifest.name.split("/"));
  mkdirSync(target, { recursive: true });
  for (const entry of manifest.files) {
    if (entry === "dts" || entry === "dist") continue;
    if (existsSync(join(root, entry))) {
      cpSync(join(root, entry), join(target, entry), { recursive: true });
    }
  }
  manifest.sideEffects = sideEffects;
  if (sideEffects === undefined) delete manifest.sideEffects;
  writeFileSync(join(target, "package.json"), JSON.stringify(manifest));
}

/**
 * A fresh app directory holding a copy of the package as published, with
 * `sideEffects` replaced (`undefined` removes it); with `withoutContract`,
 * also a copy of bun-contract without its `sideEffects`, which the package's
 * copy then resolves. An app written there imports the copies.
 */
function copyPackage(sideEffects: unknown, withoutContract = false): string {
  const dir = appDir(mkdtempSync(join(WORK, "copy-")));
  copyInto(dir, ROOT, sideEffects);
  if (withoutContract) copyInto(dir, CONTRACT_ROOT, undefined);
  return dir;
}

/**
 * Bundles `app` (`PKG` replaced by the package's name), written in `dir`, as
 * a browser app's production build would. Returns the code and where it was
 * written.
 */
async function bundle(
  dir: string,
  app: string,
): Promise<{ code: string; file: string }> {
  const n = apps++;
  const entry = join(dir, `app-${n}.ts`);
  writeFileSync(entry, app.replaceAll("PKG", MANIFEST.name));
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    minify: true,
    throw: false,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) throw new AggregateError(result.logs, "bundle failed");
  const code = (await Promise.all(result.outputs.map((o) => o.text()))).join(
    "\n",
  );
  const file = join(dir, `app-${n}.bundle.js`);
  writeFileSync(file, code);
  return { code, file };
}

/** What is wrong with a size case's bundle; empty when nothing is. */
function problems(c: SizeCase, code: string): string[] {
  const found: string[] = [];
  if (code.length > c.bound)
    found.push(`${code.length} bytes, over ${c.bound}`);
  if (code.includes(c.unrelated)) found.push(`contains ${c.unrelated}`);
  return found;
}

/**
 * Whether a bundle importing `name` from `from` resolves a contract logger
 * with bun-common's resolution: for no logger, bun-common's console
 * `Logger` (which has `child`), where bun-contract's own has only `warn`
 * and `error`. The app takes the resolver from bun-contract itself, so it
 * relies on the effect alone.
 */
async function installsResolution(
  dir: string,
  from: string,
  name: string,
): Promise<boolean> {
  const { file } = await bundle(
    dir,
    `import { ${name} } from "${from}";\n` +
      `import { resolveContractLogger } from "@kingsleyweb/bun-contract/lib/logger";\n` +
      `export const used = ${name};\n` +
      `export const resolveLogger = resolveContractLogger;\n`,
  );
  const mod = (await import(file)) as {
    used: unknown;
    resolveLogger: (input: undefined) => Record<string, unknown>;
  };
  expect(mod.used).toBeFunction();
  return typeof mod.resolveLogger(undefined).child === "function";
}

describe("sideEffects", () => {
  it("lists the modules with an effect at load, and they exist", () => {
    expect(MANIFEST.sideEffects).toEqual(EFFECTFUL);
    for (const file of EFFECTFUL)
      expect(existsSync(join(ROOT, file))).toBe(true);
  });

  it("lists every module imported for its effect, and the modules importing it", async () => {
    // A bare relative import (`import "./x"`) is an import for effect: the
    // imported module and the importer must both be listed (see above).
    const found = new Set<string>();
    for await (const rel of new Bun.Glob("lib/**/*.ts").scan({ cwd: ROOT })) {
      const text = await Bun.file(join(ROOT, rel)).text();
      for (const [, spec] of text.matchAll(
        /^import\s+["'](\.[^"']+)["'];?$/gm,
      )) {
        found.add(`./${rel}`);
        const target = resolve(ROOT, dirname(rel), spec!);
        found.add(
          `./${relative(ROOT, existsSync(`${target}.ts`) ? `${target}.ts` : join(target, "index.ts"))}`,
        );
      }
    }
    expect([...found].sort()).toEqual(EFFECTFUL);
  });
});

describe("one export in a browser bundle", () => {
  for (const c of SIZE_CASES) {
    it(`${c.name} weighs that export, not the package`, async () => {
      const { code } = await bundle(WORK, c.app);
      expect(problems(c, code)).toEqual([]);
    });

    it(`${c.name}: the same from a copy of the package as published`, async () => {
      const { code } = await bundle(copyPackage(MANIFEST.sideEffects), c.app);
      expect(problems(c, code)).toEqual([]);
    });

    it(`${c.name}, negative control: without sideEffects the check fails`, async () => {
      const { code } = await bundle(
        copyPackage(undefined, c.viaContract === true),
        c.app,
      );
      expect(problems(c, code)).toEqual([
        expect.stringMatching(/bytes, over/),
        `contains ${c.unrelated}`,
      ]);
    });
  }
});

describe("the listed effect survives tree shaking", () => {
  for (const { from, name } of EFFECT_CASES) {
    const entry = from.replace("PKG", ".");
    it(`importing ${name} from ${entry} installs bun-common's logger resolution`, async () => {
      expect(await installsResolution(WORK, from, name)).toBe(true);
      expect(
        await installsResolution(copyPackage(MANIFEST.sideEffects), from, name),
      ).toBe(true);
    });

    it(`${entry}, negative control: with sideEffects: false it is dropped`, async () => {
      expect(await installsResolution(copyPackage(false), from, name)).toBe(
        false,
      );
    });
  }
});
