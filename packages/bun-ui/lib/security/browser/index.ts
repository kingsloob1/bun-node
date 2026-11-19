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
export type {
  HostColorScheme,
  MountedUi,
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
export type { SecuritySection, SecuritySectionPermission } from "./sections";
export { SECURITY_SECTIONS } from "./sections";
