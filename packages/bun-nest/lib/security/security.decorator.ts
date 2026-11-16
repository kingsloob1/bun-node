/**
 * The decorators of `@kingsleyweb/bun-nest/security` (plan §3.5): a route's
 * profile, what a route skips, and the engine's injection. The rate-limit
 * decorators are the throttle foundation's (`@Throttle()`,
 * `@SkipThrottle()`).
 */
import type { SecurityProfileOptions } from "@kingsleyweb/bun-security/http";
import type { SecurityProfileMetadata } from "./security.interface";
import { securityProfile } from "@kingsleyweb/bun-security/http";
import { Inject, SetMetadata } from "@nestjs/common";
import {
  BUN_SECURITY,
  SECURITY_PROFILE_METADATA,
  SKIP_SECURITY_METADATA,
} from "./security.constants";

/**
 * Names a route's profile (`login`, `webhook`) and carries its per-route
 * options, on a handler or a controller (the handler's wins), as
 * bun-security's `securityProfile()` marker does for bun-common routes:
 * `requestSecurity(req).profile` reads it, PR-S7's profiles key their
 * counters on it, and `crossSite: true` lets the CSRF check pass cross-site
 * requests (a webhook, an OAuth callback). Throws a `TypeError` for a name
 * outside the grammar (a letter, then letters, digits, `_`, `.`, `-`).
 *
 * @example
 * ```ts
 * @Post("login") @SecurityProfile("login") login() {}
 * @Post("hooks/stripe") @SecurityProfile("webhook", { crossSite: true }) hook() {}
 * ```
 */
export function SecurityProfile(
  name: string,
  options: SecurityProfileOptions = {},
): ClassDecorator & MethodDecorator {
  // The marker's own check of the name, so both integrations accept the same names.
  securityProfile(name, options);
  const metadata: SecurityProfileMetadata = Object.freeze({
    name,
    crossSite: options.crossSite === true,
  });
  return SetMetadata(SECURITY_PROFILE_METADATA, metadata);
}

/**
 * Skips the route stage on a handler or a controller: with no argument,
 * the whole of it (the caller's and the route's limits and counted rules,
 * the user and API-key list entries, the CSRF check); with rule ids
 * (`"limit:per-user"`, `"csrf"`), only refusals by those rules, which still
 * count. The early stage, which runs before routing, cannot be skipped by
 * a route: an allow list entry is the way to exempt a client there.
 *
 * @example
 * ```ts
 * @Get("health") @SkipSecurity() health() {}
 * @Post("import") @SkipSecurity("limit:per-user") bulkImport() {}
 * ```
 */
export function SkipSecurity(
  ...rules: string[]
): ClassDecorator & MethodDecorator {
  for (const rule of rules) {
    if (typeof rule !== "string" || rule === "") {
      throw new TypeError(
        `@SkipSecurity(): a rule id is a non-empty string (got ${JSON.stringify(rule)})`,
      );
    }
  }
  return SetMetadata(SKIP_SECURITY_METADATA, Object.freeze([...rules]));
}

/** Injects the engine (`Security`) `SecurityModule` provides. */
export function InjectSecurity(): PropertyDecorator & ParameterDecorator {
  return Inject(BUN_SECURITY);
}
