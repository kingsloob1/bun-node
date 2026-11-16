/**
 * Route profiles (plan §3.3): a marker among a route's own callbacks that
 * names what kind of endpoint it is and carries its per-route options. The
 * route stage reads it from the matched route before the route runs, as
 * bun-common's `skipThrottle()` is read, so it works wherever the marker
 * sits among the route's callbacks. PR-S7 gives the built-in names
 * (`login`, `otp`, `reset`, `signup`) their counters; here a profile names
 * the route and carries its options.
 */
import type { RouterMiddlewareHandler } from "@kingsleyweb/bun-common";

/** Per-route options a profile carries. */
export interface SecurityProfileOptions {
  /**
   * The route takes cross-site requests on purpose (a webhook, an OAuth
   * callback): the CSRF check does not refuse them. Default `false`.
   */
  readonly crossSite?: boolean;
}

/** A profile as the route stage reads it. */
export interface SecurityProfileMark {
  /** The profile's name. */
  readonly name: string;
  /** Whether the route takes cross-site requests on purpose. */
  readonly crossSite: boolean;
}

/** Where a marker carries its profile. */
const PROFILE: unique symbol = Symbol("bun-security.profile");

/** A marker callback. */
type Marker = RouterMiddlewareHandler & {
  readonly [PROFILE]?: SecurityProfileMark;
};

/** A profile name: a letter, then letters, digits, `_`, `.` and `-`, at most 64. */
const NAME_RE = /^[a-z][\w.-]{0,63}$/i;

/**
 * A route profile: put it among a route's callbacks to name the endpoint
 * and give it per-route options. It only calls `next()`; the route stage
 * reads it from the matched route before any of the route's callbacks run.
 * Throws a `TypeError` for a name outside the grammar.
 *
 * @example
 * ```ts
 * app.post("/login", securityProfile("login"), login);
 * app.post("/hooks/stripe", securityProfile("webhook", { crossSite: true }), hook);
 * ```
 */
export function securityProfile(
  name: string,
  options: SecurityProfileOptions = {},
): RouterMiddlewareHandler {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new TypeError(
      `bun-security: securityProfile(): ${JSON.stringify(name)} is not a profile name (a letter, then letters, digits, "_", "." and "-", at most 64)`,
    );
  }
  const mark: SecurityProfileMark = Object.freeze({
    name,
    crossSite: options.crossSite === true,
  });
  const marker: RouterMiddlewareHandler = (_req, _res, next) => next();
  Object.defineProperty(marker, PROFILE, { value: mark });
  return marker;
}

/** The first profile among a route's callbacks, if any. */
export function profileOf(
  callbacks: readonly unknown[],
): SecurityProfileMark | undefined {
  for (const callback of callbacks) {
    if (typeof callback === "function") {
      const mark = (callback as Marker)[PROFILE];
      if (mark !== undefined) return mark;
    }
  }
  return undefined;
}
