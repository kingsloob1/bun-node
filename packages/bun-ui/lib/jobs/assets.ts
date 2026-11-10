/**
 * The jobs UI's bundle: the kit's asset code (`lib/kit/assets.ts`) bound to
 * `app/jobs/main.tsx` and `dist/jobs/`. Every name this module had before the
 * kit keeps its signature; `scripts/build.ts` and the tests import it.
 */
import type { Logger } from "@kingsleyweb/bun-common";
import type {
  AssetSourceOptions as KitAssetSourceOptions,
  BuildAssetsOptions as KitBuildAssetsOptions,
  UiAssets,
  UiManifest,
} from "../kit/assets";
import {
  buildAssets as buildKitAssets,
  buildAssetsOnce as buildKitAssetsOnce,
  hasDist as kitHasDist,
  loadDistAssets as loadKitDistAssets,
  plainFail,
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
  plainFail,
} from "../kit/assets";
export type {
  AssetsFail,
  UiAsset,
  UiAssets,
  UiManifest,
  UiManifestFile,
} from "../kit/assets";

/** This UI's name in the kit: `app/jobs/`, `dist/jobs/`. */
const UI = "jobs";

/** The React app's entry point, bundled by {@link buildAssets}. */
export const DEFAULT_ENTRY = uiEntry(UI);

/** Where `scripts/build.ts` writes the bundle and where `jobsUi()` looks for it. */
export const DEFAULT_DIST_DIR = uiDistDir(UI);

/** Options for {@link buildAssets}: the kit's, with the entry optional. */
export interface BuildAssetsOptions extends Omit<
  KitBuildAssetsOptions,
  "entry"
> {
  /** The entry point to bundle. Defaults to {@link DEFAULT_ENTRY}, the React app. */
  entry?: string;
}

/**
 * Bundles the app with `Bun.build`, in memory: browser target, content-hashed
 * names (`[name]-[hash].[ext]`), code splitting, `NODE_ENV=production`.
 * Throws with the bundler's messages when the build fails.
 */
export async function buildAssets(
  options: BuildAssetsOptions = {},
): Promise<UiAssets> {
  return buildKitAssets({ ...options, entry: options.entry ?? DEFAULT_ENTRY });
}

/**
 * Writes a bundle as a dist directory (by default the package's
 * `dist/jobs/`). Returns the manifest written.
 */
export async function writeAssets(
  assets: UiAssets,
  dir: string = DEFAULT_DIST_DIR,
): Promise<UiManifest> {
  return writeKitAssets(assets, dir);
}

/** Whether `dir` (by default `dist/jobs/`) holds a built bundle. */
export function hasDist(dir: string = DEFAULT_DIST_DIR): boolean {
  return kitHasDist(dir);
}

/**
 * Reads a dist directory (by default `dist/jobs/`) into memory,
 * synchronously, verifying every file against its recorded integrity.
 */
export function loadDistAssets(
  dir: string = DEFAULT_DIST_DIR,
  fail = plainFail,
): UiAssets {
  return loadKitDistAssets(dir, fail);
}

/** Builds an entry in memory, once per process (the kit's, naming `dist/jobs`). */
export function buildAssetsOnce(
  entry: string,
  logger: Logger,
): Promise<UiAssets> {
  return buildKitAssetsOnce(entry, logger, UI);
}

/** Where `jobsUi()` gets its bundle from, and how. */
export type AssetSourceOptions = Omit<KitAssetSourceOptions, "ui">;

/**
 * Resolves the bundle source when `jobsUi()` is called. A dist directory is
 * read synchronously right away, so a missing or corrupt one fails the call,
 * not the first request; an in-memory build is deferred to the first request.
 *
 * @throws `options.fail`'s error with `dev: false` and no dist, or a corrupt dist.
 */
export function resolveAssetSource(
  options: AssetSourceOptions,
): () => Promise<UiAssets> {
  return resolveKitAssetSource({ ...options, ui: UI });
}
