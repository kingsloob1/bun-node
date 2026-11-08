/**
 * Entry isolation: what each entry loads at run time.
 *
 * Every literal `exports` key is walked through its static import graph in
 * `lib/` (`Bun.Transpiler.scanImports`, so type-only imports, which never
 * load, are not followed), and the `@kingsleyweb/*` packages it reaches are
 * held against {@link ALLOWED}. A UI's domain package is an optional peer
 * that only that UI's server entry may reach (plan `docs/plans/bun-ui` §4.3):
 * an app mounting another UI, or importing the root, must load without it.
 * The browser entries must also reach no `node:*` or `bun` module.
 *
 * The consumer check proves the same against the packed tarball, per PR;
 * this holds it on every `bun test`, in milliseconds.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const ROOT = resolve(import.meta.dir, "..");

/** The `@kingsleyweb/*` packages each entry may load at run time. */
const ALLOWED: Record<string, readonly string[]> = {
  ".": ["@kingsleyweb/bun-api-docs-ui"],
  "./lib": ["@kingsleyweb/bun-api-docs-ui"],
  "./jobs": [
    "@kingsleyweb/bun-api-docs-ui",
    "@kingsleyweb/bun-common",
    "@kingsleyweb/bun-jobs",
  ],
  "./lib/jobs": [
    "@kingsleyweb/bun-api-docs-ui",
    "@kingsleyweb/bun-common",
    "@kingsleyweb/bun-jobs",
  ],
  "./jobs/browser": [],
  "./lib/jobs/browser": [],
};

/** Entries a browser bundle may import: no Node or Bun built-in either. */
const BROWSER = new Set([".", "./lib", "./jobs/browser", "./lib/jobs/browser"]);

const manifest = (await Bun.file(join(ROOT, "package.json")).json()) as {
  exports: Record<string, string | { default: string }>;
};

/** Every literal (pattern-free) `exports` key with its run-time target. */
const ENTRIES = Object.entries(manifest.exports).flatMap(([key, value]) =>
  typeof value === "object" && !key.includes("*")
    ? [[key, join(ROOT, value.default)] as const]
    : [],
);

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Resolves a relative specifier as Bun would for a `.ts` source tree. */
function resolveRelative(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base.replace(/\.js$/, "")}.ts`,
    join(base, "index.ts"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(
    `${relative(ROOT, from)}: cannot resolve ${JSON.stringify(specifier)}`,
  );
}

/** The package a bare specifier names (`@scope/name` or `name`), or the built-in itself. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** What an entry file loads at run time: every bare specifier, by package. */
function reach(
  entry: string,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Set<string> {
  const found = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { path } of transpiler.scanImports(read(file))) {
      if (path.startsWith(".")) queue.push(resolveRelative(file, path));
      else found.add(packageOf(path));
    }
  }
  return found;
}

/** The problems with one entry's reach: a domain package or built-in it may not load. */
function problems(key: string, reached: Set<string>): string[] {
  const allowed = new Set(ALLOWED[key] ?? []);
  const out: string[] = [];
  for (const name of [...reached].sort()) {
    if (name.startsWith("@kingsleyweb/") && !allowed.has(name)) {
      out.push(`exports["${key}"] loads ${name}`);
    }
    if (
      BROWSER.has(key) &&
      (name.startsWith("node:") || name === "bun" || name.startsWith("bun:"))
    ) {
      out.push(`exports["${key}"] (browser-safe) loads ${name}`);
    }
  }
  return out;
}

describe("entry isolation", () => {
  it("has a row for every literal exports key", () => {
    expect(ENTRIES.map(([key]) => key).sort()).toEqual(
      Object.keys(ALLOWED).sort(),
    );
  });

  for (const [key, file] of ENTRIES) {
    it(`${key} loads only what it may`, () => {
      expect(problems(key, reach(file))).toEqual([]);
    });
  }

  it("reaches the jobs UI's peer from ./jobs, so the walk follows imports", () => {
    const jobs = ENTRIES.find(([key]) => key === "./jobs")![1];
    expect(reach(jobs).has("@kingsleyweb/bun-jobs")).toBe(true);
  });

  // The negative control: a domain import planted in the shared kit (the
  // mistake plan D7 guards against) is named on every entry that loads it.
  it("names the entries a domain import planted in lib/kit reaches", () => {
    const kit = join(ROOT, "lib", "kit", "browser", "shared.ts");
    const planted = (path: string) =>
      readFileSync(path, "utf8") +
      (path === kit ? `\nimport "@kingsleyweb/bun-jobs";\n` : "");
    const found = ENTRIES.flatMap(([key, file]) =>
      problems(key, reach(file, planted)),
    );
    expect(found).toContain(`exports["."] loads @kingsleyweb/bun-jobs`);
    expect(found).toContain(`exports["./lib"] loads @kingsleyweb/bun-jobs`);
  });

  it("names a Node built-in reached from a browser entry", () => {
    const browser = ENTRIES.find(([key]) => key === "./jobs/browser")![1];
    const planted = (path: string) =>
      readFileSync(path, "utf8") +
      (path === browser ? `\nimport "node:fs";\n` : "");
    expect(problems("./jobs/browser", reach(browser, planted))).toEqual([
      `exports["./jobs/browser"] (browser-safe) loads node:fs`,
    ]);
  });
});
