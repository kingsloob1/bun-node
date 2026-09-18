/**
 * The browser bundle carries nothing of the server.
 *
 * The app imports the API's constants and types from
 * `@kingsleyweb/bun-jobs/api/contract`, the package's browser-safe entry. A
 * value import from the package root instead would pull in its drivers,
 * bun-common and `node:*` modules. This builds the real app (unminified, so
 * identifiers survive) and looks for any of that, and a negative control
 * proves the check catches such an import.
 */
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { buildAssets, DEFAULT_ENTRY } from "../../../lib/assets";

/** Text that only server code contains. */
const SERVER_MARKERS: readonly RegExp[] = [
  /["'`](?:node|bun):[\w/]+["'`]/,
  /\bimport\.meta\.require\b/,
  /\bBun\.(?:serve|spawn|file|write|sql|redis)\b/,
  /\b(?:MemoryDriver|RedisDriver|SqlDriver|MongoDriver|FileDriver)\b/,
  /\bcreateJobsApi\b/,
  /\bBunRouter\b/,
];

/** The server markers found in `code`, as their sources. */
function serverMarkersIn(code: string): string[] {
  return SERVER_MARKERS.filter((marker) => marker.test(code)).map(
    (marker) => marker.source,
  );
}

describe("the browser bundle", () => {
  it("has the contract's constants and nothing of the server", async () => {
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
    // The constants the app uses came through the contract entry (unused
    // ones, like the socket subprotocol for now, are tree-shaken away).
    expect(code.includes('"waiting-children"')).toBe(true);
    expect(code.includes('"queues.pause"')).toBe(true);
    expect(serverMarkersIn(code)).toEqual([]);
  }, 60_000);

  it("negative control: a value import from the package root is caught", async () => {
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "fixtures", "server-import.ts")],
      target: "browser",
      throw: false,
    });
    // Either the browser build refuses the server modules outright, or it
    // produces a bundle the markers flag. Both prove the check has teeth.
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
