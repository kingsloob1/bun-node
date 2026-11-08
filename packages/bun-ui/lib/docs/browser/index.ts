/**
 * `@kingsleyweb/bun-ui/docs/browser`: the docs viewer's browser-safe
 * contract, what `docsUi()` inlines into the page and the viewer reads before
 * its first request, and the `unauthorized` option's browser-safe helpers
 * (the redirect URL, the shape check, the defaults). No runtime import beyond
 * constants and pure functions, and no domain package.
 */
export type { DocsUiConfig, DocsUiTheme, UiTheme } from "./config";
export {
  DEFAULT_EXTENSION_PREFIXES,
  DOCS_UI_CONFIG_ELEMENT_ID,
} from "./config";
export {
  DEFAULT_RETURN_PARAM,
  DEFAULT_UNAUTHORIZED_STATUSES,
  isUiUnauthorized,
  relativeReturnPath,
  unauthorizedRedirectUrl,
} from "../../kit/browser/unauthorized";
export type {
  UiUnauthorized,
  UiUnauthorizedStatus,
  UnauthorizedOptions,
} from "../../kit/browser/unauthorized";
