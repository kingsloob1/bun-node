/**
 * The docs viewer's bundle: the kit's asset code (`lib/kit/assets.ts`) bound
 * to `app/docs/main.tsx` and `dist/docs/`, throwing bun-common's
 * `ConfigError`. Every name this module had before the kit keeps its
 * signature; `lib/docs/hosted.ts` (`./docs/hosted`, which bun-common's
 * `"self-hosted"` viewer loads), `scripts/build.ts` and the tests import it.
 */
import type { Logger } from "@kingsleyweb/bun-common";
import type {
  AssetsFail,
  AssetSourceOptions as KitAssetSourceOptions,
  BuildAssetsOptions as KitBuildAssetsOptions,
  UiAssets,
  UiManifest,
} from "../kit/assets";
import { ConfigError } from "@kingsleyweb/bun-common";
import {
  buildAssets as buildKitAssets,
  buildAssetsOnce as buildKitAssetsOnce,
  hasDist as kitHasDist,
  loadDistAssets as loadKitDistAssets,
  resolveAssetSource as resolveKitAssetSource,
  uiDistDir,
  uiEntry,
  writeAssets as writeKitAssets,
} from "../kit/assets";

export {
  ASSETS_DIR,
  contentTypeFor,
  entryStylesheets,
  integrityOf,
  MANIFEST_FILE,
  manifestOf,
  PACKAGE_DIR,
} from "../kit/assets";
export type {
  UiAsset,
  UiAssets,
  UiManifest,
  UiManifestFile,
} from "../kit/assets";

/** This UI's name in the kit: `app/docs/`, `dist/docs/`. */
const UI = "docs";

/** The viewer's errors: bun-common's `ConfigError`, a dependency, not a peer. */
const fail: AssetsFail = (message, context) =>
  new ConfigError(message, context);

/** The React app's entry point, bundled by {@link buildAssets}. */
export const DEFAULT_ENTRY = uiEntry(UI);

/** Where `scripts/build.ts` writes the bundle and where `docsUi()` looks for it. */
export const DEFAULT_DIST_DIR = uiDistDir(UI);

/** Options for {@link buildAssets}: the kit's, with the entry optional and the error fixed. */
export interface BuildAssetsOptions extends Omit<
  KitBuildAssetsOptions,
  "entry" | "fail"
> {
  /** The entry point to bundle. Defaults to {@link DEFAULT_ENTRY}, the React app. */
  entry?: string;
}

/**
 * Bundles the app with `Bun.build`, in memory: browser target, content-hashed
 * names (`[name]-[hash].[ext]`), code splitting, `NODE_ENV=production`.
 * Throws with the bundler's messages when the build fails, and bun-common's
 * `ConfigError` when the entry does not exist.
 */
export async function buildAssets(
  options: BuildAssetsOptions = {},
): Promise<UiAssets> {
  return buildKitAssets({
    ...options,
    entry: options.entry ?? DEFAULT_ENTRY,
    fail,
  });
}

/**
 * Writes a bundle as a dist directory (by default the package's
 * `dist/docs/`). Returns the manifest written.
 */
export async function writeAssets(
  assets: UiAssets,
  dir: string = DEFAULT_DIST_DIR,
): Promise<UiManifest> {
  return writeKitAssets(assets, dir);
}

/** Whether `dir` (by default `dist/docs/`) holds a built bundle. */
export function hasDist(dir: string = DEFAULT_DIST_DIR): boolean {
  return kitHasDist(dir);
}

/**
 * Reads a dist directory (by default `dist/docs/`) into memory,
 * synchronously, verifying every file against its recorded integrity.
 *
 * @throws ConfigError for a corrupt dist, naming the file.
 */
export function loadDistAssets(dir: string = DEFAULT_DIST_DIR): UiAssets {
  return loadKitDistAssets(dir, fail);
}

/** Builds an entry in memory, once per process (the kit's, naming `dist/docs`). */
export function buildAssetsOnce(
  entry: string,
  logger: Logger,
): Promise<UiAssets> {
  return buildKitAssetsOnce(entry, logger, UI);
}

/** Where `docsUi()` gets its bundle from, and how. */
export type AssetSourceOptions = Omit<KitAssetSourceOptions, "ui" | "fail">;

/**
 * Resolves the bundle source when `docsUi()` is called. A dist directory is
 * read synchronously right away, so a missing or corrupt one fails the call,
 * not the first request; an in-memory build is deferred to the first request.
 *
 * @throws ConfigError with `dev: false` and no dist, or a corrupt dist.
 */
export function resolveAssetSource(
  options: AssetSourceOptions,
): () => Promise<UiAssets> {
  return resolveKitAssetSource({ ...options, ui: UI, fail });
}
