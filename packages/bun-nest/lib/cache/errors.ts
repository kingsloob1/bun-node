/**
 * The error a cache-decorated method throws when it cannot reach its cache.
 *
 * It imports nothing, so naming it never loads `@kingsleyweb/bun-cache`.
 */

/** How a cache name reads in a message: the default cache has none. */
function describeCache(name: string | undefined): string {
  return name === undefined ? "the default cache" : `the cache "${name}"`;
}

/**
 * A method decorated with `@Cacheable`, `@CachePut` or `@CacheEvict` was
 * called where its cache cannot be found (plan §10.2): before the
 * application initialised (`app.init()`, or `listen()`, which calls it), on
 * an instance no initialised application created, after the application
 * closed, or naming a cache no `BunCacheModule` registered. The message says
 * which.
 */
export class CacheNotReadyError extends Error {
  /** The cache the method asked for; `undefined` for the default (unnamed) cache. */
  readonly cacheName: string | undefined;
  /** The decorated method, as `ClassName.method`. */
  readonly method: string;

  constructor(
    /** The cache the method asked for; `undefined` for the default cache. */
    cacheName: string | undefined,
    /** The decorated method, as `ClassName.method`. */
    method: string,
    /** Why the cache could not be found, completing "…: <reason>". */
    reason: string,
  ) {
    super(`${method} needs ${describeCache(cacheName)}, but ${reason}`);
    this.name = "CacheNotReadyError";
    this.cacheName = cacheName;
    this.method = method;
  }
}
