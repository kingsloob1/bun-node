export {
  ASSET_CACHE_CONTROL,
  DEFAULT_BASE_PATH,
  DEFAULT_TITLE,
  DOCUMENT_SUBPATH,
  docsUi,
} from "./docsUi";
/**
 * `@kingsleyweb/bun-ui/docs`: a self-hosted viewer for one OpenAPI 3.1 or
 * AsyncAPI 3.0 document, served by a `docsUi()` handler. Needs no peer.
 *
 * ```ts
 * const ui = docsUi({ document: "/jobs-api/openapi.json", basePath: "/docs" });
 * app.use(ui.basePath, ui.router);
 * ```
 *
 * The bundle machinery (`lib/docs/assets.ts`, the kit's `lib/kit/assets.ts`
 * bound to `dist/docs/`) is internal: `scripts/build.ts` and the tests import
 * it directly.
 */
export type { DocsUiConfig, DocsUiTheme } from "./browser/config";
export type {
  UiUnauthorized,
  UiUnauthorizedStatus,
} from "../kit/browser/unauthorized";
export {
  DEFAULT_EXTENSION_PREFIXES,
  DOCS_UI_CONFIG_ELEMENT_ID,
} from "./browser/config";
export type {
  DocsUi,
  DocsUiAuthorize,
  DocsUiAuthorizeContext,
  DocsUiAuthorizeResult,
  DocsUiDocumentThunk,
  DocsUiOptions,
  DocsUiUnauthorizedOptions,
} from "./types";
