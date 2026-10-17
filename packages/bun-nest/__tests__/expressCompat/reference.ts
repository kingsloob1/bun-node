/**
 * The reference side of the differential tests: `@nestjs/platform-express`'s
 * `ExpressAdapter`, with one upstream fix carried back where the installed
 * copy predates it.
 *
 * **The Nest bug.** On Nest 12 Express scopes a prefixed application's
 * not-found and error handlers to its global prefix (nestjs/nest #16372). In
 * `@nestjs/platform-express` 12.0.0 and 12.0.1, `setNotFoundHandler` and
 * `setErrorHandler` mount that router at the prefix exactly as
 * `setGlobalPrefix` received it, `use("api", router)`, and Express 5 never
 * matches a mount path without a leading slash (measured: `use("api")` falls
 * through to Express's own `Cannot GET` HTML page, `use("/api")` reaches the
 * handler). So on those two releases a miss under the prefix answers
 * Express's finalhandler page instead of Nest's JSON 404. 12.0.2 fixed it by
 * normalising the prefix first (`normalizePrefix`: a leading slash, no
 * trailing one).
 *
 * bun-nest scopes to the prefix correctly on every 12.x, so against the
 * unfixed reference the prefix not-found rows of `expressCompat.nest.test.ts`
 * and `notFoundMultiApp.nest.test.ts` (19 of them) failed on 12.0.0 with our
 * answers right. Rather than skip those rows there, the reference gets
 * 12.0.2's fix: the same two methods, handed the prefix 12.0.2 would compute.
 * That is exactly 12.0.2's behaviour (its only change to the adapter), so
 * the rows keep asserting our answers against Express 12's.
 *
 * The gate reads the capability, never a version (plan §8.3, rule 4): the fix
 * is applied only where the reference scopes by prefix (Nest 12, detected by
 * `mapException`) and has no `normalizePrefix` of its own. Nest 11 ignores
 * the prefix, and 12.0.2 onwards normalise it themselves; both get the plain
 * `ExpressAdapter`.
 */
import { AbstractHttpAdapter } from "@nestjs/core/adapters/http-adapter.js";
import { ExpressAdapter } from "@nestjs/platform-express";

/** Nest 12 or later, by the capability the adapter reads (`mapException`). */
const NEST_12 =
  typeof (AbstractHttpAdapter.prototype as { mapException?: unknown })
    .mapException === "function";

/**
 * Whether the installed `ExpressAdapter` normalises a global prefix itself
 * (12.0.2+). The method is private where it exists, so it is read by name.
 */
export const EXPRESS_NORMALIZES_PREFIX =
  typeof Reflect.get(ExpressAdapter.prototype, "normalizePrefix") ===
  "function";

/** Whether the reference needs 12.0.2's prefix fix carried back (12.0.0, 12.0.1). */
export const BACKPORT_PREFIX_FIX = NEST_12 && !EXPRESS_NORMALIZES_PREFIX;

/**
 * 12.0.2's `normalizePrefix`: `stripEndSlash(addLeadingSlash(prefix))`, with
 * Nest's helpers: anything but a non-empty string (an array prefix included)
 * becomes `""`, no prefix; a `{/` start counts as slashed; `"/"` becomes `""`.
 * Written out because `@nestjs/common/internal` exists only on 12.
 */
function normalizePrefix(prefix: unknown): string {
  if (typeof prefix !== "string" || !prefix) return "";
  const leading =
    prefix.startsWith("/") || prefix.startsWith("{/") ? prefix : `/${prefix}`;
  return leading.endsWith("/") ? leading.slice(0, -1) : leading;
}

/** `ExpressAdapter` with 12.0.2's prefix normalisation in its two scoped handlers. */
class PrefixFixedExpressAdapter extends ExpressAdapter {
  setErrorHandler(...args: Parameters<ExpressAdapter["setErrorHandler"]>) {
    args[1] = normalizePrefix(args[1]);
    return super.setErrorHandler(...args);
  }

  setNotFoundHandler(
    ...args: Parameters<ExpressAdapter["setNotFoundHandler"]>
  ) {
    args[1] = normalizePrefix(args[1]);
    return super.setNotFoundHandler(...args);
  }
}

/** A new reference adapter: `ExpressAdapter`, with the backport where it is needed. */
export function expressReference(): ExpressAdapter {
  return BACKPORT_PREFIX_FIX
    ? new PrefixFixedExpressAdapter()
    : new ExpressAdapter();
}

/** The installed `ExpressAdapter` as shipped, for the test that guards the backport. */
export function unfixedExpressAdapter(): ExpressAdapter {
  return new ExpressAdapter();
}
