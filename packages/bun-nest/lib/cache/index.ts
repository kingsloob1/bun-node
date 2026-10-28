/**
 * `@kingsleyweb/bun-nest/cache` — `@kingsleyweb/bun-cache` in NestJS: the
 * module, the injection decorator, and caching decorators for service
 * methods (plan `docs/plans/bun-cache/` §10.1, §10.2).
 *
 * This subpath, and only this subpath, depends on `@kingsleyweb/bun-cache`
 * (an optional peer). The package barrel never reaches it, so a Nest app
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
export { BUN_CACHE, BUN_CACHE_OPTIONS, getCacheToken } from "./tokens";

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
