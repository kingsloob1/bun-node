/**
 * The browser-safe subpath `@kingsleyweb/bun-common/sse` (bun-native-routes
 * plan §16.7): bundled with `Bun.build({ target: "browser" })`, unminified
 * so identifiers survive, its bundle and module graph hold no server code.
 * The negative control is `__tests__/contract/browserSafety.test.ts`'s (the
 * same markers catch `lib/utils/native.ts`), plus one here: the package
 * root, which holds the server, is caught.
 */
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const LIB = resolve(import.meta.dir, "../../lib");

/** bun-contract's `lib/`, which the writer's contract checks come from. */
const CONTRACT_LIB = dirname(
  Bun.resolveSync("@kingsleyweb/bun-contract", import.meta.dir),
);

/** Text only server code contains. */
const SERVER_MARKERS: readonly RegExp[] = [
  /["'`](?:node|bun):[\w/]+["'`]/,
  /\bimport\.meta\.(?:require|dir|path)\b/,
  /\bBun\.\w+/,
  /\bprocess\.(?:env|platform|versions|cwd|nextTick)\b/,
  /\brequire\(/,
  /\bBuffer\.(?:from|alloc|concat|isBuffer)\b/,
];

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
            modules.push(
              args.path.startsWith(CONTRACT_LIB)
                ? `bun-contract:${relative(CONTRACT_LIB, args.path)}`
                : relative(LIB, args.path),
            );
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

describe("the sse subpath in a browser bundle", () => {
  it("has the writer, the format and the parser, and nothing of the server", async () => {
    const { result, code, modules } = await bundle(join(LIB, "sse/index.ts"));
    expect(result.success).toBe(true);
    for (const name of [
      "formatSseEvent",
      "encodeSseEvent",
      "readSse",
      "sseResponse",
    ]) {
      expect(code).toMatch(new RegExp(`function\\*? ${name}\\b`));
    }
    for (const name of ["SseWriter", "SseParser"]) {
      expect(code).toContain(`class ${name}`);
    }
    expect(
      SERVER_MARKERS.filter((m) => m.test(code)).map((m) => m.source),
    ).toEqual([]);
    // Its own modules, the contract core's (for `contract`), and
    // bun-common's dependency-free logger.
    expect(modules.filter((m) => !m.startsWith("bun-contract:"))).toEqual([
      "contract/guard.ts",
      "contract/logger.ts",
      "contract/model.ts",
      "contract/schemas.ts",
      "contract/sse.ts",
      "contract/transport.ts",
      "logging.ts",
      "sse/declaration.ts",
      "sse/format.ts",
      "sse/index.ts",
      "sse/parser.ts",
      "sse/response.ts",
      "sse/writer.ts",
    ]);
  }, 30_000);

  it("negative control: the package root, which holds the server, is caught", async () => {
    const { result, code } = await bundle(join(LIB, "index.ts"));
    if (!result.success) {
      expect(result.logs.length).toBeGreaterThan(0);
      return;
    }
    expect(SERVER_MARKERS.some((m) => m.test(code))).toBe(true);
  }, 60_000);
});
