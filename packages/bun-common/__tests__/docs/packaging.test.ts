/**
 * Plan risk 1f for the converter module: nothing in `lib/docs/` may import a
 * vendor package (zod, valibot, arktype, yup, `@valibot/to-json-schema`, …)
 * or anything outside bun-common's own `lib/` — the converters are
 * structural, so `dts/docs/` will name only structural interfaces and
 * `checkPeerScopes` stays quiet. Asserted directly on the import graph, not
 * left to review: `lib/docs/index.ts` is bundled and every module it pulled
 * in is checked. A negative control proves the check catches a vendor import.
 */
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const LIB = resolve(import.meta.dir, "../../lib");
const ROOT = resolve(LIB, "..");

/** Bundles `entry`, returning every module it pulled in, relative to the package root. */
async function moduleGraph(entry: string): Promise<string[]> {
  const modules: string[] = [];
  await Bun.build({
    entrypoints: [entry],
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

describe("the lib/docs import graph (plan risk 1f)", () => {
  it("pulls in only bun-common's own lib/ — no vendor, no node_modules", async () => {
    const modules = await moduleGraph(join(LIB, "docs/index.ts"));
    // The converter reached its own files and the contract core it reads
    // `jsonSchemaOf` from — and nothing else.
    expect(modules).toEqual([
      "lib/contract/media.ts",
      "lib/contract/model.ts",
      "lib/contract/schemas.ts",
      "lib/contract/transport.ts",
      "lib/docs/convert.ts",
      "lib/docs/converters.ts",
      "lib/docs/index.ts",
      "lib/docs/lift.ts",
    ]);
    for (const module of modules) {
      expect(module.startsWith("lib/"), module).toBe(true);
      expect(module.includes("node_modules"), module).toBe(false);
    }
  });

  it("negative control: a module importing a vendor is caught", async () => {
    const modules = await moduleGraph(
      join(import.meta.dir, "fixtures/vendor-import.fixture.ts"),
    );
    expect(modules.some((module) => module.includes("node_modules/zod"))).toBe(
      true,
    );
  });
});
