/**
 * Plan risk 10 for the docs module (AD (c)): a browser viewer bundles the
 * *document types*, never the generator or the router. The
 * `./lib/docs/types` entry is type-only and imports nothing, so its browser
 * bundle is empty and its module graph is itself alone; the full
 * `./lib/docs` entry — which a type-only import from `lib/docs/index.ts`
 * could drag in under a bundler that does not erase types — is the negative
 * control, and must show server code.
 *
 * Modelled on `__tests__/contract/browserSafety.test.ts`.
 */
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import type { JsonSchemaLike, OpenApiDocument } from "../../lib/docs/types";

const LIB = resolve(import.meta.dir, "../../lib");

/** Text only server code contains. */
const SERVER_MARKERS: readonly RegExp[] = [
  /["'`](?:node|bun):[\w/]+["'`]/,
  /\bimport\.meta\.(?:require|dir|path)\b/,
  /\bBun\.\w+/,
  /\bprocess\.(?:env|platform|versions|cwd|nextTick)\b/,
  /\brequire\(/,
  /\bBuffer\.(?:from|alloc|concat|isBuffer)\b/,
];

/** The server markers found in `code`, as their sources. */
function serverMarkersIn(code: string): string[] {
  return SERVER_MARKERS.filter((marker) => marker.test(code)).map(
    (m) => m.source,
  );
}

/** Bundles `entry` for a browser; returns its code and every module it pulled in. */
async function bundle(entry: string) {
  const modules: string[] = [];
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    minify: false,
    throw: false,
    plugins: [
      {
        name: "record-modules",
        setup(build) {
          build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
            modules.push(relative(LIB, args.path));
            return { contents: await Bun.file(args.path).text(), loader: "ts" };
          });
        },
      },
    ],
  });
  const code = result.success
    ? (await Promise.all(result.outputs.map((o) => o.text()))).join("\n")
    : "";
  return { result, code, modules: modules.sort() };
}

describe("the docs/types entry in a browser bundle (plan risk 10)", () => {
  it("carries the two document types and nothing else", async () => {
    // The types exist and are the document shapes (compile-time).
    const document: OpenApiDocument = { openapi: "3.1.2", paths: {} };
    const schema: JsonSchemaLike = { type: "object" };
    expect([document.openapi, schema.type]).toEqual(["3.1.2", "object"]);

    const { result, code, modules } = await bundle(join(LIB, "docs/types.ts"));
    expect(result.success).toBe(true);
    // Type-only: the bundle is empty, and the graph is the entry alone —
    // neither the generator nor the converters nor the router came along.
    expect(code.trim()).toBe("");
    expect(modules).toEqual(["docs/types.ts"]);
    expect(serverMarkersIn(code)).toEqual([]);
  }, 30_000);

  it("negative control: the full lib/docs entry is not browser-safe", async () => {
    const { result, code } = await bundle(join(LIB, "docs/index.ts"));
    // Either the browser build refuses the server modules, or the markers
    // flag them (docsRouter pulls in BunRouter and its Bun/Node surface).
    if (!result.success) {
      expect(result.logs.length).toBeGreaterThan(0);
      return;
    }
    expect(serverMarkersIn(code).length).toBeGreaterThan(0);
  }, 30_000);
});
