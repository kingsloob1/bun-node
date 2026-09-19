import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "bun:test";

/**
 * Every test file that loads the DOM also unloads it, and none loads react-dom
 * before the DOM exists.
 *
 * `register-dom.ts` registers happy-dom as a side effect of being imported,
 * and `bun test` shares globals across files. A file that imports it —
 * directly or through a fixture — without calling `setupDom()` leaves
 * happy-dom's `fetch`/`Request`/`Response` installed for whichever file runs
 * next. In the default order the next file happened to be another DOM file,
 * so nothing showed; under `bun test --randomize` a server or e2e suite ran
 * next and its requests went through happy-dom's `fetch`.
 */

/** The test tree. */
const ROOT = join(import.meta.dir, "..");

/** The module whose import registers the DOM. */
const REGISTER_DOM = join(import.meta.dir, "register-dom.ts");

/**
 * A top-level `setupDom()` call (or the job harness's `installDom()`, which
 * is `setupDom`) on a line of its own — a mention in a comment does not count.
 */
const CALLS_SETUP_DOM = /^(?:[\w.]+\.)?(?:setupDom|installDom)\(\);?\s*$/m;

const transpiler = new Bun.Transpiler({ loader: "tsx" });

/** Resolves a relative source import to a file, or `null` for anything else. */
function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".") || /\.(?:css|json|svg)$/.test(specifier)) {
    return null;
  }
  const base = resolve(dirname(from), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

/**
 * Whether `file` statically imports — itself or through any relative import
 * — a module `target` accepts (given the bare specifier, or the resolved
 * path of a relative one). Dynamic `import()`s are not followed: they run
 * when the importer chooses, which is how `dom.ts` loads react-dom late.
 */
function staticallyReaches(
  file: string,
  target: (module: string) => boolean,
  seen = new Set<string>(),
): boolean {
  if (seen.has(file)) {
    return false;
  }
  seen.add(file);
  // `scanImports` rejects a shebang, which a script a test imports may carry
  // (`scripts/build-declarations.ts`, via the packaging test).
  const source = readFileSync(file, "utf8").replace(/^#!.*/, "");
  return transpiler
    .scanImports(source)
    .filter((entry) => entry.kind === "import-statement")
    .some((entry) => {
      if (target(entry.path)) {
        return true;
      }
      const resolved = resolveImport(file, entry.path);
      return (
        resolved !== null &&
        (target(resolved) || staticallyReaches(resolved, target, seen))
      );
    });
}

/** Whether `file` statically imports `register-dom.ts`, however indirectly. */
function loadsDom(file: string): boolean {
  return staticallyReaches(file, (module) => module === REGISTER_DOM);
}

/** Whether `file` statically imports react-dom, however indirectly. */
function loadsReactDom(file: string): boolean {
  return staticallyReaches(file, (module) => /^react-dom(?:\/|$)/.test(module));
}

/** Every test file, absolute. */
function testFiles(): string[] {
  return [
    ...new Bun.Glob("**/*.test.{ts,tsx}").scanSync({
      cwd: ROOT,
      absolute: true,
    }),
  ];
}

describe("DOM isolation between test files", () => {
  it("every test file that imports the DOM calls setupDom()", () => {
    const files = testFiles();
    expect(files.length).toBeGreaterThan(0);
    const leaking = files
      .filter((file) => loadsDom(file))
      .filter((file) => !CALLS_SETUP_DOM.test(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file));
    expect(leaking).toEqual([]);
  });

  /**
   * react-dom decides at module evaluation whether it runs in a DOM. A test
   * file importing it statically (say through `app/boot`) evaluates it ahead
   * of `./dom`'s registration when that file happens to be the run's first
   * DOM file, and from then on no `onChange` fires in any file. `dom.ts`
   * therefore loads Testing Library dynamically, and so must everyone else.
   */
  it("no test file imports react-dom statically", () => {
    const eager = testFiles()
      .filter((file) => loadsReactDom(file))
      .map((file) => relative(ROOT, file));
    expect(eager).toEqual([]);
  });

  it("negative control: the scan sees a DOM import through a fixture, and only then", () => {
    expect(loadsDom(join(import.meta.dir, "queues", "helpers.test.ts"))).toBe(
      true,
    );
    expect(loadsDom(join(ROOT, "server", "options.test.ts"))).toBe(false);
    // app/boot imports react-dom/client; dom.ts only imports it dynamically.
    expect(loadsReactDom(join(ROOT, "..", "app", "boot.tsx"))).toBe(true);
    expect(loadsReactDom(join(import.meta.dir, "dom.ts"))).toBe(false);
  });
});
