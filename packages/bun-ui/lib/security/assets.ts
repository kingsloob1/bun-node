/**
 * The security UI's bundle: `dist/security/` when built, else
 * `app/security/main.tsx` built in memory (the kit's pipeline, bound to
 * this UI's name; `scripts/build.ts` builds it on `prepack`).
 */
import type {
  AssetSourceOptions as KitAssetSourceOptions,
  UiAssets,
} from "../kit/assets";
import {
  resolveAssetSource as resolveKitAssetSource,
  uiDistDir,
  uiEntry,
} from "../kit/assets";

/** The UI's name in the kit's layout (`dist/security/`, `app/security/`). */
const UI = "security";

/** The app's entry. */
export const DEFAULT_ENTRY = uiEntry(UI);

/** Where the prebuilt bundle lives. */
export const DEFAULT_DIST_DIR = uiDistDir(UI);

/** Where the bundle comes from (see the kit's `resolveAssetSource`). */
export function resolveAssetSource(
  options: Omit<KitAssetSourceOptions, "ui">,
): () => Promise<UiAssets> {
  return resolveKitAssetSource({ ...options, ui: UI });
}
