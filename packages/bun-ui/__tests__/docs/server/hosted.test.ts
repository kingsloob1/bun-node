/**
 * `lib/hosted.ts`: the one module a host router (bun-common's `"self-hosted"`
 * docs viewer) imports for the bundle and the shell.
 */
import { describe, expect, it } from "bun:test";
import { createTestLogger } from "@kingsleyweb/bun-common";
import {
  ASSET_CACHE_CONTROL,
  createNonce,
  createShellRenderer,
  cspHeader,
  DEFAULT_DIST_DIR,
  DEFAULT_ENTRY,
  resolveHostedAssets,
  resolveAssetSource,
} from "../../lib/hosted";

describe("lib/hosted", () => {
  it("re-exports the bundle and shell machinery", () => {
    expect(typeof resolveAssetSource).toBe("function");
    expect(typeof createShellRenderer).toBe("function");
    expect(typeof cspHeader).toBe("function");
    expect(typeof createNonce).toBe("function");
    expect(DEFAULT_DIST_DIR).toContain("dist");
    expect(DEFAULT_ENTRY).toContain("main.tsx");
    expect(ASSET_CACHE_CONTROL).toBe("public, max-age=31536000, immutable");
  });

  it("resolves the viewer's bundle (dist when present, else an in-memory build)", async () => {
    const { logger } = createTestLogger();
    const assets = await resolveHostedAssets(logger)();
    expect(assets.entry.js).toMatch(/^main-[\w-]+\.js$/);
    expect(assets.files.get(assets.entry.js)?.integrity).toMatch(/^sha384-/);
  }, 60_000);
});
