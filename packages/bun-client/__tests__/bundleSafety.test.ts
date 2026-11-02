/**
 * The browser bundle carries nothing of a server (plan D17, §10.3).
 *
 * Builds the package entry with `Bun.build({ target: "browser" })`,
 * unminified so identifiers survive, and looks for anything only server code
 * contains: a `node:` or `bun:` import, a `Bun.` API, an import of bun-common
 * or any other package (the client has no runtime dependency at all). A
 * negative control builds an entry that does import bun-common, and the
 * check must catch it. Copied from bun-jobs-ui's
 * `__tests__/app/pkg/bundle-safety.test.ts`.
 */
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

const ENTRY = join(import.meta.dir, "..", "lib", "index.ts");

/** Text that only server code contains. */
const SERVER_MARKERS: readonly RegExp[] = [
  /["'`](?:node|bun):[\w/]+["'`]/,
  /\bimport\.meta\.require\b/,
  /\bBun\.\w+/,
  /\bprocess\.(?:env|versions|platform)\b/,
  /@kingsleyweb\/bun-common/,
  /\bBunRouter\b/,
  /\brequire\(/,
];

/** The server markers found in `code`, as their sources. */
function serverMarkersIn(code: string): string[] {
  return SERVER_MARKERS.filter((marker) => marker.test(code)).map(
    (marker) => marker.source,
  );
}

/** Builds `entry` for a browser, unminified: its code, or the build's logs. */
async function build(
  entry: string,
): Promise<{ code?: string; logs: string[] }> {
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    minify: false,
    throw: false,
  });
  if (!result.success) return { logs: result.logs.map(String) };
  const code = (
    await Promise.all(result.outputs.map((output) => output.text()))
  ).join("\n");
  return { code, logs: [] };
}

describe("the browser bundle of @kingsleyweb/bun-client", () => {
  it("builds, keeps the client, and holds nothing of a server", async () => {
    const { code, logs } = await build(ENTRY);
    expect(logs).toEqual([]);
    expect(code!.includes("createClient")).toBe(true);
    expect(code!.includes("UnexpectedStatusError")).toBe(true);
    expect(serverMarkersIn(code!)).toEqual([]);
  });

  it("imports no package at all: the bundle has no import statement left", async () => {
    const { code } = await build(ENTRY);
    expect(code!.match(/^\s*import\s/m)).toBeNull();
  });

  it("negative control: an entry importing bun-common is caught", async () => {
    const { code, logs } = await build(
      join(import.meta.dir, "fixtures", "server-import.ts"),
    );
    // Either the browser build refuses the server modules outright, or the
    // bundle it produces carries markers. Both prove the check has teeth.
    if (code === undefined) {
      expect(logs.length).toBeGreaterThan(0);
      return;
    }
    expect(serverMarkersIn(code).length).toBeGreaterThan(0);
  });
});
