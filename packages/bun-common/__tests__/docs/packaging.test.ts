/**
 * Plan risk 1f for the docs module: nothing in `lib/docs/` may import a
 * vendor schema package (zod, valibot, arktype, yup, `@valibot/to-json-schema`,
 * …) — the converters are structural, so `dts/docs/` will name only structural
 * interfaces and `checkPeerScopes` stays quiet. Asserted directly on the
 * import graph, not left to review: `lib/docs/index.ts` is bundled and every
 * module it pulled in is checked. A negative control proves the check catches
 * a vendor import.
 *
 * AD (c) widened the graph further: `docsRouter` constructs a `BunRouter`, so
 * the graph now includes the whole router stack and bun-common's declared
 * runtime dependencies (`@routejs/router`, `accepts`, …). The rule is
 * therefore: the `lib/docs/` modules are exactly the expected set, no schema
 * vendor appears, and every `node_modules` module belongs to the dependency
 * closure of bun-common's declared `dependencies` — nothing a consumer would
 * not already install. The browser-safe half is the `./lib/docs/types` entry
 * (`./browserSafety.test.ts`, plan risk 10).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const LIB = resolve(import.meta.dir, "../../lib");
const ROOT = resolve(LIB, "..");
const REPO_ROOT = resolve(ROOT, "../..");

/** Bundles `entry`, returning every module it pulled in, relative to the package root. */
async function moduleGraph(entry: string): Promise<string[]> {
  const modules: string[] = [];
  await Bun.build({
    entrypoints: [entry],
    target: "bun",
    minify: false,
    throw: true,
    plugins: [
      {
        name: "record-modules",
        setup(build) {
          build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
            modules.push(relative(ROOT, args.path));
            return {
              contents: await Bun.file(args.path).text(),
              loader: "ts",
            };
          });
        },
      },
    ],
  });
  return modules.sort();
}

/** The package name a graphed node_modules module belongs to. */
function packageName(module: string): string {
  const parts = module.split("node_modules/").pop()!.split("/");
  return parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** The dependency closure of bun-common's declared `dependencies`. */
function dependencyClosure(): Set<string> {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  const closure = new Set<string>();
  const queue = Object.keys(manifest.dependencies);
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (closure.has(name)) continue;
    closure.add(name);
    for (const base of [
      join(ROOT, "node_modules"),
      join(REPO_ROOT, "node_modules"),
    ]) {
      const file = join(base, name, "package.json");
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8")) as {
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      };
      queue.push(
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.optionalDependencies ?? {}),
        // An optional peer a consumer may have installed anyway is used when
        // present (debug's `supports-color` is the measured case). npm strips
        // an empty `peerDependencies` on publish, so the meta alone decides.
        ...Object.entries(pkg.peerDependenciesMeta ?? {})
          .filter(([, meta]) => meta.optional === true)
          .map(([peer]) => peer),
      );
      break;
    }
  }
  return closure;
}

describe("the lib/docs import graph (plan risk 1f)", () => {
  it("pulls in exactly the docs modules, no schema vendor, and only declared-dependency packages", async () => {
    const modules = await moduleGraph(join(LIB, "docs/index.ts"));
    // The docs module's own files — no more, no fewer. (`lib/docs/types.ts`
    // is type-only: the runtime graph never loads it, which is the point of
    // the browser-safe entry.)
    expect(modules.filter((module) => module.startsWith("lib/docs/"))).toEqual([
      "lib/docs/convert.ts",
      "lib/docs/converters.ts",
      "lib/docs/index.ts",
      "lib/docs/lift.ts",
      "lib/docs/openapi.ts",
      "lib/docs/refs.ts",
      "lib/docs/routeDoc.ts",
      "lib/docs/router.ts",
      "lib/docs/security.ts",
      "lib/docs/viewer.ts",
    ]);

    // Risk 1f: no vendor schema package, ever.
    const vendors = [
      "zod",
      "valibot",
      "@valibot/to-json-schema",
      "arktype",
      "yup",
      "superstruct",
      "class-validator",
      "class-transformer",
      "class-validator-jsonschema",
      "reflect-metadata",
    ];
    for (const vendor of vendors) {
      expect(
        modules.some((module) => module.includes(`node_modules/${vendor}/`)),
        vendor,
      ).toBe(false);
    }

    // Every dependency module is one a consumer already installs: bun-common's
    // declared dependencies and their transitive closure, nothing else.
    const closure = dependencyClosure();
    const foreign = [
      ...new Set(
        modules
          .filter((module) => module.includes("node_modules"))
          .map(packageName),
      ),
    ].filter((name) => !closure.has(name));
    expect(foreign).toEqual([]);
  });

  it("negative control: a module importing a vendor is caught", async () => {
    const modules = await moduleGraph(
      join(import.meta.dir, "fixtures/vendor-import.fixture.ts"),
    );
    expect(modules.some((module) => module.includes("node_modules/zod"))).toBe(
      true,
    );
  });

  it("AD (b2): lib/classDto.ts pulls in neither class-validator, class-transformer nor reflect-metadata", async () => {
    const modules = await moduleGraph(join(LIB, "classDto.ts"));
    expect(modules).toContain("lib/classDto.ts");
    // The adapter is injected: the module must not even transitively import
    // the libraries it adapts (risk 1f — they are devDependencies, so an
    // accidental import would bundle fine here and break a consumer).
    const vendors = [
      "class-validator",
      "class-transformer",
      "class-validator-jsonschema",
      "reflect-metadata",
    ];
    for (const vendor of vendors) {
      expect(
        modules.some((module) => module.includes(`node_modules/${vendor}/`)),
        vendor,
      ).toBe(false);
    }
    // Same dependency-closure rule as the docs graph.
    const closure = dependencyClosure();
    const foreign = [
      ...new Set(
        modules
          .filter((module) => module.includes("node_modules"))
          .map(packageName),
      ),
    ].filter((name) => !closure.has(name));
    expect(foreign).toEqual([]);
  });
});
