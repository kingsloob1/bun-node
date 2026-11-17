/**
 * `@kingsleyweb/bun-ui/security` (ui.md §1, PR-U1): `securityUi()`, the
 * management UI of `@kingsleyweb/bun-security` (an optional peer this entry
 * needs), on bun-ui's kit.
 */
export {
  createSecurityUi,
  DEFAULT_BASE_PATH,
  DEFAULT_TITLE,
  securityUi,
} from "./securityUi";
export type { SecurityUiInternals } from "./securityUi";
export type {
  SecurityUi,
  SecurityUiApiOptions,
  SecurityUiAuthorize,
  SecurityUiAuthorizeContext,
  SecurityUiBaseOptions,
  SecurityUiOptions,
  SecurityUiUrlOptions,
} from "./types";
export type { SecurityUiConfig } from "./browser/config";
export { SECURITY_UI_CONFIG_ELEMENT_ID } from "./browser/config";
export type {
  UiAlign,
  UiColorToken,
  UiLayout,
  UiLayoutOptions,
  UiLayoutScope,
  UiThemeColors,
  UiThemeInput,
  UiThemeOptions,
} from "../kit/browser/shared";
export type {
  UiUnauthorized,
  UiUnauthorizedStatus,
} from "../kit/browser/unauthorized";
