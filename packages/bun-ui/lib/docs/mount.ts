/**
 * `@kingsleyweb/bun-ui/docs/mount`'s types (embedding.md §2, §3): what a
 * host page mounting the docs viewer in its own layout imports. The
 * function is the prebuilt browser module `dist/docs/mount/index.js`
 * (React bundled in), which `exports["./docs/mount"]` points at; this file
 * only declares it. `./docs/embed` stays the source-level alternative for a
 * host rendering the screens in its own React tree.
 */
import type {
  MountedUi,
  MountElement,
  MountOptions,
} from "../kit/browser/mount";
import type { UiUnauthorized } from "../kit/browser/unauthorized";
import type { DocsUiConfig } from "./browser/config";

/**
 * What {@link mountDocsUi} takes: the document, where the viewer lives, and
 * the kit's {@link MountOptions}. A host serving the viewer with `docsUi()`
 * may pass its `ui.config` as it is.
 */
export interface DocsMountOptions
  extends MountOptions, Partial<Pick<DocsUiConfig, "version" | "assetsPath">> {
  /** The OpenAPI 3.1 or AsyncAPI 3.0 document's URL: same-origin, or one its server lets this page fetch. */
  documentUrl: string;
  /** Where the host routes the viewer's paths (`"/admin/api-docs"`). */
  basePath: string;
  /** A header the try-it panel adds on every mutation, or `null` for none. Default: none. */
  csrfHeader?: string | null;
  /** The specification-extension prefixes the viewer reads. Default: `["x-bun-common", "x-bun-jobs"]`. */
  extensions?: readonly string[];
  /** The viewer's title. Default: `"API docs"`. */
  title?: string;
  /** Where an authorization failure on the document sends the browser when `onUnauthorized` is not given. Default: none. */
  unauthorized?: UiUnauthorized | null;
}

/**
 * Mounts the docs viewer inside `element`, in a `<div data-bun-ui="docs">`
 * it creates there, and returns the handle the host drives it with. Link
 * `@kingsleyweb/bun-ui/docs/mount.css` (or the router's `/mount.css`) too.
 *
 * @throws A `TypeError` for an element that is not one, or a missing `documentUrl` or `basePath`.
 */
export declare function mountDocsUi(
  element: MountElement,
  options: DocsMountOptions,
): MountedUi;

export type {
  MountedUi,
  MountElement,
  MountOptions,
} from "../kit/browser/mount";
