/**
 * `@kingsleyweb/bun-nest/cache` — `@kingsleyweb/bun-cache` in NestJS: the
 * module, the injection decorator, caching decorators for service methods,
 * and an interceptor caching routes' responses (plan `docs/plans/bun-cache/`
 * §10.1–§10.3).
 *
 * This subpath, and only this subpath, depends on `@kingsleyweb/bun-cache`
 * (an optional peer), and so do `cacheThrottleStore`, the shared store
 * for `BunThrottlerModule`, and `cacheLiveBus`, the bus that carries live
 * invalidations (`@Invalidates`) between instances. The package barrel never reaches it, so a Nest app
 * without bun-cache neither compiles nor loads a line of it.
 *
 * ```ts
 * import { memoryDriver } from "@kingsleyweb/bun-cache";
 * import { BunCacheModule, Cacheable, CacheEvict, InjectCache } from "@kingsleyweb/bun-nest/cache";
 *
 * @Module({ imports: [BunCacheModule.forRoot({ driver: memoryDriver(), ttl: 60_000, isGlobal: true })] })
 * export class AppModule {}
 *
 * @Injectable()
 * export class UsersService {
 *   @Cacheable({ key: (id: number) => `user:${id}`, tags: (id) => [`user:${id}`] })
 *   async findUser(id: number): Promise<User> { … }
 *
 *   @CacheEvict({ tags: (id: number) => [`user:${id}`] })
 *   async updateUser(id: number, patch: Partial<User>): Promise<User> { … }
 * }
 * ```
 */

export {
  BunCacheModule,
  type BunCacheModuleAsyncOptions,
  type BunCacheModuleOptions,
  InjectCache,
} from "./BunCacheModule";
export {
  Cacheable,
  type CacheableOptions,
  CacheEvict,
  type CacheEvictOptions,
  CachePut,
  type CachePutOptions,
} from "./decorators";
export { CacheNotReadyError } from "./errors";
export {
  BunCacheInterceptor,
  type BunCacheInterceptorOptions,
  CacheKey,
  CacheTags,
  CacheTTL,
  NoCache,
} from "./interceptor";
export { BUN_CACHE, BUN_CACHE_OPTIONS, getCacheToken } from "./tokens";

/**
 * A bun-cache cache as `BunThrottlerModule`'s (or bun-common's
 * `throttle()`'s) store, so a limit holds across processes and instances
 * (`@kingsleyweb/bun-cache/throttle`, re-exported here because this subpath
 * is where bun-nest's dependency on bun-cache starts; the package root,
 * where `BunThrottlerModule` lives, never reaches it).
 *
 * ```ts
 * BunThrottlerModule.forRoot({ throttlers: [...], store: cacheThrottleStore(cache) })
 * ```
 */
export {
  cacheThrottleStore,
  type CacheThrottleStore,
  type CacheThrottleStoreOptions,
} from "@kingsleyweb/bun-cache/throttle";

/**
 * A bun-cache bus (`redisBus`, `pgBus`) as bun-common's live bus, so a
 * `@Invalidates` (or any `publishTags()`) in one instance reaches the live
 * subscribers of every instance (`@kingsleyweb/bun-cache/live`, re-exported
 * here for the same reason as `cacheThrottleStore`).
 *
 * ```ts
 * adapter.use(liveInvalidation(adapter, { authorize, bus: cacheLiveBus(redisBus(url)) }));
 * ```
 */
export {
  cacheLiveBus,
  type CacheLiveBusOptions,
  DEFAULT_LIVE_NAMESPACE,
} from "@kingsleyweb/bun-cache/live";

/**
 * The bun-cache types this module's surface is written in, re-exported so a
 * consumer can name them without reaching for `@kingsleyweb/bun-cache` itself
 * — and so TypeScript's declaration emit never raises TS2742 for a type it
 * cannot name.
 */
export type {
  Cache,
  CreateCacheOptions,
  GetOrSetOptions,
  SetOptions,
} from "@kingsleyweb/bun-cache";
