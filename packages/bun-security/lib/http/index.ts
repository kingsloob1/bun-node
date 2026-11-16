/**
 * `./http`: the engine on a bun-common `BunHttpAdapter` (plan §3.3).
 *
 * ```ts
 * const app = new BunHttpAdapter();
 * await installSecurity(app, security);   // early hook, route stage, response stage, self-test
 * app.post("/login", securityProfile("login"), login);
 * ```
 *
 * - {@link installSecurity}: the whole integration, with its boot self-test;
 * - {@link securityMiddleware}: the route stage alone, for a router the
 *   install does not cover;
 * - {@link securityProfile}: a route's profile and per-route options;
 * - {@link securityHeaders}, {@link csrf}: layer L13, also usable alone;
 * - {@link requestSecurity}: what was decided about a request, for handlers.
 */
export { csrf } from "./csrf";
export type {
  CsrfGuard,
  CsrfOptions,
  CsrfRefusal,
  CsrfTokenOptions,
} from "./csrf";
export { securityHeaders } from "./headers";
export type { HstsOptions, SecurityHeadersOptions } from "./headers";
export { installSecurity, SELF_TEST_PATH } from "./install";
export type {
  InstallSecurityOptions,
  SecurityInstallation,
  SecuritySelfTest,
} from "./install";
export { MAX_DELAY_MS, securityMiddleware } from "./middleware";
export type { RefusalOptions, SecurityMiddlewareOptions } from "./middleware";
export { securityProfile } from "./profile";
export type { SecurityProfileOptions } from "./profile";
export type { ScrubMode } from "./scrub";
export { requestSecurity } from "./state";
export type { RequestSecurity } from "./state";
