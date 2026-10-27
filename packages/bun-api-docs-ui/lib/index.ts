export {
  ASSET_CACHE_CONTROL,
  DEFAULT_BASE_PATH,
  DEFAULT_TITLE,
  DOCUMENT_SUBPATH,
  docsUi,
} from "./docsUi";
/**
 * `@kingsleyweb/bun-api-docs-ui`: a self-hosted viewer for one OpenAPI 3.1 or
 * AsyncAPI 3.0 document, served by a `docsUi()` handler.
 *
 * ```ts
 * const ui = docsUi({ document: "/jobs-api/openapi.json", basePath: "/docs" });
 * app.use(ui.basePath, ui.router);
 * ```
 *
 * The bundle machinery (`lib/assets.ts`: building, writing and loading
 * `dist/`) is internal: `scripts/build.ts` and the tests import it directly.
 */
export type { DocsUiConfig, DocsUiTheme } from "./shared/config";
export {
  DEFAULT_EXTENSION_PREFIXES,
  DOCS_UI_CONFIG_ELEMENT_ID,
} from "./shared/config";
export type {
  DocsUi,
  DocsUiAuthorize,
  DocsUiAuthorizeContext,
  DocsUiAuthorizeResult,
  DocsUiDocumentThunk,
  DocsUiOptions,
} from "./types";
