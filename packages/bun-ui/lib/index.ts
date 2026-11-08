/**
 * `@kingsleyweb/bun-ui`: every bun-node browser UI, one subpath each.
 *
 * - `@kingsleyweb/bun-ui/jobs`: `jobsUi()`, the bun-jobs management UI
 *   (needs the optional peer `@kingsleyweb/bun-jobs`);
 *   `@kingsleyweb/bun-ui/jobs/browser`: its browser-safe config contract.
 *
 * This root entry holds only what every UI shares and a browser may import:
 * the theme type, the `unauthorized` option's types and defaults, and the
 * assets' `Cache-Control`. It never imports a UI or a domain package, so
 * importing it needs no peer.
 */
export { ASSET_CACHE_CONTROL } from "./kit/browser/shared";
export type { UiTheme } from "./kit/browser/shared";
export {
  DEFAULT_RETURN_PARAM,
  DEFAULT_UNAUTHORIZED_STATUSES,
} from "@kingsleyweb/bun-api-docs-ui/lib/shared/unauthorized";
export type {
  UiUnauthorized,
  UiUnauthorizedStatus,
  UnauthorizedOptions,
} from "@kingsleyweb/bun-api-docs-ui/lib/shared/unauthorized";
