/**
 * The browser-safe subpath (plan §4.1.8, Q-C7): `@kingsleyweb/bun-common/contract`
 * bundles for a browser with no Bun or Node API in it. The entry is built
 * with `Bun.build({ target: "browser" })`, unminified so identifiers survive,
 * and the bundle and its module graph are searched for server code; a
 * negative control proves the search catches a module that has some.
 *
 * The core itself lives in `@kingsleyweb/bun-contract` since the typed-client
 * plan's PR-K, and the entry re-exports it: the graph is that package's
 * modules, this entry and bun-common's dependency-free logger, which the
 * entry installs as the core's logger resolution.
 */
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const LIB = resolve(import.meta.dir, "../../lib");

/** bun-contract's `lib/`, where the core now lives. */
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

describe("the contract subpath in a browser bundle", () => {
  it("has the core and nothing of the server", async () => {
    const { result, code, modules } = await bundle(
      join(LIB, "contract/index.ts"),
    );
    expect(result.success).toBe(true);
    // The core's own functions came through.
    for (const name of [
      "defineTransport",
      "createReceiver",
      "validateStandard",
      "describeContract",
      "mergeContracts",
    ]) {
      expect(code).toContain(`function ${name}`);
    }
    expect(serverMarkersIn(code)).toEqual([]);
    // Its module graph: the core (bun-contract's), this entry, and
    // bun-common's dependency-free logger with the module installing it.
    expect(modules).toEqual([
      "bun-contract:channel.ts",
      "bun-contract:describe.ts",
      "bun-contract:guard.ts",
      "bun-contract:index.ts",
      "bun-contract:issues.ts",
      "bun-contract:logger.ts",
      "bun-contract:media.ts",
      "bun-contract:model.ts",
      "bun-contract:protoKeys.ts",
      "bun-contract:schemas.ts",
      "bun-contract:transport.ts",
      "contract/index.ts",
      "contract/logger.ts",
      "logging.ts",
    ]);
  }, 30_000);

  it("negative control: a module using Node APIs is caught", async () => {
    const { result, code } = await bundle(join(LIB, "utils/native.ts"));
    // Either the browser build refuses the server modules, or the markers flag them.
    if (!result.success) {
      expect(result.logs.length).toBeGreaterThan(0);
      return;
    }
    expect(serverMarkersIn(code).length).toBeGreaterThan(0);
  }, 30_000);
});
