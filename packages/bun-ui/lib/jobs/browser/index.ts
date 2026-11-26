/**
 * `@kingsleyweb/bun-ui/jobs/browser`: the jobs UI's browser-safe contract,
 * what `jobsUi()` inlines into the page and the app reads before its first
 * request. No runtime import beyond constants and no domain package, so a
 * browser bundle (or a host reading the injected config) may import it.
 */
export type { JobsUiConfig, JobsUiSections, UiTheme } from "./config";
export { JOBS_UI_CONFIG_ELEMENT_ID } from "./config";
export type {
  UiAlign,
  UiLayout,
  UiLayoutScope,
} from "../../kit/browser/shared";
export type { UiUnauthorized, UiUnauthorizedStatus } from "./unauthorized";
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
export type {
  JobsSection,
  JobsSectionId,
  JobsSectionPermission,
  JobsSectionsMeta,
} from "./sections";
export { JOBS_SECTIONS, jobsSectionsFor } from "./sections";
