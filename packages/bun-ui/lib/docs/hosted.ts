/**
 * The bundle + shell surface a host router needs to serve the viewer itself
 * (bun-common's `docsRouter` `"self-hosted"` viewer): the package's `dist/`
 * resolution and the shell/CSP builders, re-exported from one module so the
 * host imports one specifier. Everything here is server-side.
 */
import type { Logger } from "@kingsleyweb/bun-common";
import type { UiAssets } from "./assets";
import { DEFAULT_DIST_DIR, DEFAULT_ENTRY, resolveAssetSource } from "./assets";

export { DEFAULT_DIST_DIR, DEFAULT_ENTRY, resolveAssetSource } from "./assets";
export type { UiAsset, UiAssets, UiManifest, UiManifestFile } from "./assets";
export { ASSET_CACHE_CONTROL } from "./docsUi";
export { createNonce, createShellRenderer, cspHeader } from "./shell";
export type { CspOptions, ShellRenderer } from "./shell";

/**
 * Resolves the viewer's bundle for a host: the prebuilt `dist/` when present
 * (verified against its manifest, SRI computed over the local bytes), else an
 * in-memory `Bun.build` on the first request, once per process. This is the
 * `dev: undefined` rule of `docsUi()` — a host serving the viewer gets the
 * same assets the package would serve.
 */
export function resolveHostedAssets(logger: Logger): () => Promise<UiAssets> {
  return resolveAssetSource({
    dev: undefined,
    distDir: DEFAULT_DIST_DIR,
    entry: DEFAULT_ENTRY,
    logger,
  });
}
