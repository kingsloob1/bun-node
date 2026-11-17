/**
 * The security app's browser bundle carries nothing of the server: it
 * reaches bun-security only through `./control/contract` (types and
 * constants), never the API, the store or `node:*`. Built for real,
 * unminified; a negative control proves the markers catch a value import of
 * the server side.
 */
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { buildAssets } from "../../../lib/kit/assets";
import { DEFAULT_ENTRY } from "../../../lib/security/assets";

/** Text only server code contains. */
const SERVER_MARKERS: readonly RegExp[] = [
  /["'`](?:node|bun):[\w/]+["'`]/,
  /\bimport\.meta\.require\b/,
  /\bBun\.(?:serve|spawn|file|write|sql|redis|password)\b/,
  /\bBunRouter\b/,
  /\bConfigError\b/,
  /\bcreateSecurityApi\b/,
  /\bmemoryStore\b/,
];

/** The markers found in `code`. */
function serverMarkersIn(code: string): string[] {
  return SERVER_MARKERS.filter((marker) => marker.test(code)).map(
    (marker) => marker.source,
  );
}

describe("the security app's bundle", () => {
  it("has the config element's id and nothing of the server", async () => {
    const assets = await buildAssets({
      entry: DEFAULT_ENTRY,
      minify: false,
      sourcemap: "none",
    });
    const code = [...assets.files.values()]
      .filter((file) => file.name.endsWith(".js"))
      .map((file) => new TextDecoder().decode(file.body))
      .join("\n");
    expect(code.length).toBeGreaterThan(0);
    expect(code.includes("bun-security-ui-config")).toBe(true);
    expect(serverMarkersIn(code)).toEqual([]);
  }, 60_000);

  it("negative control: a value import of the security API is caught", async () => {
    const result = await Bun.build({
      entrypoints: [
        join(import.meta.dir, "fixtures", "pkg", "server-import.ts"),
      ],
      target: "browser",
      throw: false,
    });
    if (!result.success) {
      expect(result.logs.length).toBeGreaterThan(0);
      return;
    }
    const code = (
      await Promise.all(result.outputs.map((output) => output.text()))
    ).join("\n");
    expect(serverMarkersIn(code).length).toBeGreaterThan(0);
  }, 60_000);
});
