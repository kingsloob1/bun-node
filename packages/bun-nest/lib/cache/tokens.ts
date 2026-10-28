/**
 * Injection tokens for the cache module.
 *
 * Kept in their own module, importing nothing, so a consumer can name a token
 * in a provider or a test without pulling in the module — or, with it,
 * `@kingsleyweb/bun-cache`.
 *
 * The tokens are registered symbols (`Symbol.for`), so two copies of this
 * package loaded side by side (a package shipping raw `.ts` can be, under some
 * resolutions) still agree on them.
 */

/** Provides the default (unnamed) cache. Inject it with `@InjectCache()`. */
export const BUN_CACHE: unique symbol = Symbol.for(
  "@kingsleyweb/bun-nest/cache",
);

/** Provides the options the default (unnamed) cache was configured with. */
export const BUN_CACHE_OPTIONS: unique symbol = Symbol.for(
  "@kingsleyweb/bun-nest/cache:options",
);

/**
 * The token a cache is provided under: {@link BUN_CACHE} for the default
 * one, a symbol of its own for each `name`.
 *
 * ```ts
 * { provide: ReportsRepo, inject: [getCacheToken("reports")], useFactory: (c) => new ReportsRepo(c) }
 * ```
 */
export function getCacheToken(name?: string): symbol {
  return name === undefined
    ? BUN_CACHE
    : Symbol.for(`@kingsleyweb/bun-nest/cache:named:${name}`);
}
