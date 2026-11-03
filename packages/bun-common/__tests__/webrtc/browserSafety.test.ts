/**
 * The browser-safe half of `@kingsleyweb/bun-common/webrtc`:
 * `lib/webrtc/signalling.ts` (`@kingsleyweb/bun-common/lib/webrtc/signalling`),
 * bundled with `Bun.build({ target: "browser" })`, unminified so identifiers
 * survive, holds no server code and pulls in only the contract core. The
 * negative control is the `./webrtc` entry itself, which also holds the
 * relay (bun-common's channel binding and the router's validator): a browser
 * bundle of it fails or carries server markers.
 */
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const LIB = resolve(import.meta.dir, "../../lib");

/** bun-contract's `lib/`, which the contract core comes from. */
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

/** Bundles `entry` for a browser; returns its code and every bun-common module it pulled in. */
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
            if (!args.path.startsWith(CONTRACT_LIB)) {
              modules.push(relative(LIB, args.path));
            }
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

describe("lib/webrtc/signalling in a browser bundle", () => {
  it("has the contract and nothing of the server", async () => {
    const { result, code, modules } = await bundle(
      join(LIB, "webrtc/signalling.ts"),
    );
    expect(result.success).toBe(true);
    expect(code).toMatch(/function signallingContract\b/);
    expect(code).toMatch(/function channelContract\b/);
    expect(
      SERVER_MARKERS.filter((m) => m.test(code)).map((m) => m.source),
    ).toEqual([]);
    expect(modules).toEqual([
      "contract/channel.ts",
      "contract/schemas.ts",
      "webrtc/signalling.ts",
    ]);
  }, 30_000);

  it("negative control: the ./webrtc entry, which holds the relay, is caught", async () => {
    const { result, code } = await bundle(join(LIB, "webrtc/index.ts"));
    if (!result.success) {
      expect(result.logs.length).toBeGreaterThan(0);
      return;
    }
    expect(SERVER_MARKERS.some((m) => m.test(code))).toBe(true);
  }, 60_000);
});
