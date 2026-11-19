/**
 * The tags a host page includes to mount a UI its router serves
 * (embedding.md §3, the non-bundling host): the mount stylesheets and the
 * mount module, by their hashed URLs under `<basePath>/assets/`, each with
 * its Subresource Integrity digest. Each UI's `xxxUiMountTags(ui)` binds it
 * to that UI's bundle.
 */
import type { UiAssets } from "./assets";
import { ASSETS_SUBPATH } from "./serve";
import { escapeHtml } from "./shell";

/** One file a page links, by URL, with its SRI digest. */
export interface UiMountTag {
  /** The file's URL under the UI's `basePath`: `"/admin/jobs/assets/mount-1a2b.js"`. */
  href: string;
  /** Its Subresource Integrity digest, `"sha384-…"`. */
  integrity: string;
}

/** What `xxxUiMountTags()` gives a host page. */
export interface UiMountTags {
  /** The mount stylesheets, in the order to link them. */
  stylesheets: UiMountTag[];
  /** The mount module: what the page's own script imports `mountXxxUi` from. */
  module: UiMountTag;
  /**
   * The `<link>`s for the page's `<head>`: each stylesheet, and a
   * `modulepreload` of the module, each with its `integrity` and
   * `crossorigin`. The page then imports the module's `href` itself.
   */
  html: string;
}

/** Options of a UI's `xxxUiMountTags()`. */
export interface UiMountTagsOptions {
  /** A nonce to put on each tag, for a page whose CSP asks one of them. Default: none. */
  nonce?: string;
}

/**
 * The tags for `assets`' mount stylesheets and module under `basePath`.
 *
 * @throws When the bundle has no mount module (built without a mount entry).
 */
export function mountTagsOf(
  assets: UiAssets,
  basePath: string,
  options: UiMountTagsOptions = {},
): UiMountTags {
  const mount = assets.mount;
  if (mount?.js === undefined) {
    throw new Error("bun-ui: this UI's bundle has no mount module");
  }
  const tag = (name: string): UiMountTag => ({
    href: `${basePath}${ASSETS_SUBPATH}/${encodeURIComponent(name)}`,
    integrity: assets.files.get(name)!.integrity,
  });
  const stylesheets = mount.css.map(tag);
  const module = tag(mount.js);
  const nonce =
    options.nonce === undefined ? "" : ` nonce="${escapeHtml(options.nonce)}"`;
  const link = (rel: string, file: UiMountTag) =>
    `<link rel="${rel}" href="${escapeHtml(file.href)}" integrity="${file.integrity}" crossorigin="anonymous"${nonce}>`;
  return {
    stylesheets,
    module,
    html: [
      ...stylesheets.map((file) => link("stylesheet", file)),
      link("modulepreload", module),
    ].join("\n"),
  };
}
