/**
 * Injection tokens and metadata keys of `@kingsleyweb/bun-nest/security`.
 *
 * Kept in their own module, importing nothing, so a provider or a test can
 * name a token without pulling in the module or `@kingsleyweb/bun-security`.
 * The tokens are registered symbols (`Symbol.for`), so two copies of this
 * package loaded side by side still agree on them.
 */

/** Provides the engine (`Security`). Inject it with `@InjectSecurity()`. */
export const BUN_SECURITY: unique symbol = Symbol.for(
  "@kingsleyweb/bun-nest/security",
);

/** Provides the options `SecurityModule` was configured with. */
export const BUN_SECURITY_OPTIONS: unique symbol = Symbol.for(
  "@kingsleyweb/bun-nest/security:options",
);

/** Where `@SecurityProfile()` records a route's profile. */
export const SECURITY_PROFILE_METADATA = "bun-security:profile";

/** Where `@SkipSecurity()` records what a route skips. */
export const SKIP_SECURITY_METADATA = "bun-security:skip";
