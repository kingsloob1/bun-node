/**
 * `@kingsleyweb/bun-ui/security/browser`: the security UI's browser-safe
 * configuration contract, for a host that renders its own shell or reads
 * the config.
 */
export type { SecurityUiConfig, UiTheme } from "./config";
export { SECURITY_UI_CONFIG_ELEMENT_ID } from "./config";
export type {
  UiAlign,
  UiLayout,
  UiLayoutScope,
} from "../../kit/browser/shared";
export type {
  UiUnauthorized,
  UiUnauthorizedStatus,
} from "../../kit/browser/unauthorized";
