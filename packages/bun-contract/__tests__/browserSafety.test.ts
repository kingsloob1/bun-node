/**
 * The package is browser-safe (typed-client plan §10.3): its entry bundles
 * with `Bun.build({ target: "browser" })` with no Bun or Node API in it, and
 * its module graph is the package's own `lib/` and nothing else, no other
 * package at all. Unminified, so identifiers survive for the search; the
 * negative control proves the search catches a module that has server code.
 */
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const ROOT = resolve(import.meta.dir, "..");
const LIB = join(ROOT, "lib");

/** Text only server code contains (bun-common's and bun-client's markers). */
const SERVER_MARKERS: readonly RegExp[] = [
  /["'`](?:node|bun):[\w/]+["'`]/,
  /\bimport\.meta\.(?:require|dir|path)\b/,
  /\bBun\.\w+/,
  /\bprocess\.(?:env|platform|versions|cwd|nextTick)\b/,
  /\brequire\(/,
  /\bBuffer\.(?:from|alloc|concat|isBuffer)\b/,
  /@kingsleyweb\/bun-common/,
];

/** The server markers found in `code`, as their sources. */
function serverMarkersIn(code: string): string[] {
  return SERVER_MARKERS.filter((marker) => marker.test(code)).map(
    (m) => m.source,
  );
}

/** Bundles `entry` for a browser; its code and every module it loaded, relative to the package. */
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
          build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async (args) => {
            modules.push(relative(ROOT, args.path));
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

describe("the package in a browser bundle", () => {
  it("has the core and nothing of a server", async () => {
    const { result, code, modules } = await bundle(join(LIB, "index.ts"));
    expect(result.success).toBe(true);
    for (const name of [
      "defineTransport",
      "createReceiver",
      "createSender",
      "validateStandard",
      "describeContract",
      "mergeContracts",
      "channelContract",
    ]) {
      expect(code).toContain(`function ${name}`);
    }
    expect(serverMarkersIn(code)).toEqual([]);
    // Only the package's own modules: no other package, not even bun-common's
    // logger, which the core loaded before it moved out.
    expect(modules).toEqual([
      "lib/channel.ts",
      "lib/describe.ts",
      "lib/guard.ts",
      "lib/index.ts",
      "lib/issues.ts",
      "lib/logger.ts",
      "lib/media.ts",
      "lib/model.ts",
      "lib/protoKeys.ts",
      "lib/schemas.ts",
      "lib/transport.ts",
    ]);
  }, 30_000);

  it("negative control: an entry reaching a Node API is caught", async () => {
    const { result, code, modules } = await bundle(
      join(import.meta.dir, "fixtures/serverEntry.ts"),
    );
    // The core came along, so the graph check alone would not have caught it.
    expect(modules).toContain("lib/guard.ts");
    // Either the browser build refuses the server module, or the markers flag it.
    if (!result.success) {
      expect(result.logs.length).toBeGreaterThan(0);
      return;
    }
    expect(serverMarkersIn(code).length).toBeGreaterThan(0);
  }, 30_000);
});
