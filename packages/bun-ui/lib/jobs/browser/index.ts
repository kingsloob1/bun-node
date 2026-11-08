/**
 * `@kingsleyweb/bun-ui/jobs/browser`: the jobs UI's browser-safe contract,
 * what `jobsUi()` inlines into the page and the app reads before its first
 * request. No runtime import beyond constants and no domain package, so a
 * browser bundle (or a host reading the injected config) may import it.
 */
export type { UiConfig, UiSections, UiTheme } from "./config";
export { UI_CONFIG_ELEMENT_ID } from "./config";
export type { UiUnauthorized, UiUnauthorizedStatus } from "./unauthorized";
