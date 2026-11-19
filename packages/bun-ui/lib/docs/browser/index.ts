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
export type {
  UiAlign,
  UiLayout,
  UiLayoutScope,
} from "../../kit/browser/shared";
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
export type {
  HostColorScheme,
  MountedUi,
  MountElement,
  MountLayout,
  MountLayoutOptions,
  MountOptions,
  MountTheme,
  UiShell,
} from "../../kit/browser/mount";
export {
  DEFAULT_MOUNT_SHELL,
  DEFAULT_MOUNT_LAYOUT,
  DEFAULT_PAGE_SHELL,
  isUiShell,
  resolveMountLayout,
  resolveMountTheme,
  UI_SHELLS,
} from "../../kit/browser/mount";
export type { UiSection } from "../../kit/browser/sections";
export { sectionsFor } from "../../kit/browser/sections";
export type { DocsSection } from "./sections";
export { DOCS_SECTIONS } from "./sections";
