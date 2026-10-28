/**
 * Compile-time checks for `BunCacheInterceptor` and its decorators (plan
 * §10.3): the decorators' arguments, the functions' `ExecutionContext`, and
 * `with()`'s options — `cacheResponse()`'s less the ones the decorators set.
 * Checked by `bun run check` (`bun test`, even with `--check`, never reads a
 * `*.type-test.ts`); each `@ts-expect-error` is a negative control — an
 * unused one is an error.
 */
import type { ExecutionContext, NestInterceptor, Type } from "@nestjs/common";
import type { BunCacheInterceptorOptions } from "../lib/cache/index";
import { Controller, Get, UseInterceptors } from "@nestjs/common";
import {
  BunCacheInterceptor,
  CacheKey,
  CacheTags,
  CacheTTL,
  NoCache,
} from "../lib/cache/index";

/** `true` when `A` and `B` are the same type. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
/** Compiles only for `true`. */
type Expect<T extends true> = T;

export type _with = Expect<
  Equal<ReturnType<typeof BunCacheInterceptor.with>, Type<NestInterceptor>>
>;

@UseInterceptors(BunCacheInterceptor)
@CacheTTL(60_000)
@Controller("typed")
export class TypedController {
  @CacheKey("typed:list")
  @CacheTags("posts", "lists")
  @Get("list")
  list() {
    return [];
  }

  @CacheKey(
    (context) => context.switchToHttp().getRequest<{ url: string }>().url,
  )
  @CacheTTL(async (context: ExecutionContext) =>
    context.getType() === "http" ? 1_000 : 0,
  )
  @CacheTags((context) => [context.getHandler().name])
  @Get("computed")
  computed() {
    return [];
  }

  @NoCache()
  @Get("never")
  never() {
    return [];
  }
}

// with(): cacheResponse()'s options, a cache's name, `revalidate: false`.
UseInterceptors(
  BunCacheInterceptor.with({
    cache: "pages",
    ttl: "headers",
    varyBy: ["accept-language"],
    statuses: [200],
    staleWhileRevalidate: 1_000,
    revalidate: false,
    streams: { buffer: 1024 },
  }),
);

// @ts-expect-error a TTL is a number of ms (or a function), not a string
CacheTTL("60s");
// @ts-expect-error a key function returns a string
CacheKey(() => 7);
// @ts-expect-error tags are strings, or one function
CacheTags(1, 2);
// @ts-expect-error a tags function returns strings
CacheTags(() => [1]);
// @ts-expect-error the key is @CacheKey's, not an option
BunCacheInterceptor.with({ key: () => "k" });
// @ts-expect-error the tags are @CacheTags', not an option
BunCacheInterceptor.with({ tags: ["a"] });
// @ts-expect-error `cache` names a cache; it is not a Cache
BunCacheInterceptor.with({ cache: 1 });

/** Every option is optional. */
export const _empty: BunCacheInterceptorOptions = {};
