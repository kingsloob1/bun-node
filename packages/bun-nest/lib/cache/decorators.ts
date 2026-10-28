/**
 * `@Cacheable`, `@CacheEvict` and `@CachePut`: caching for service methods
 * (plan §10.2), with Spring's names and semantics where they carry over.
 *
 * Each replaces the method with a wrapper that, on every call, finds its
 * cache through the application that created the instance (`registry.ts`),
 * builds the key from the call's arguments, and calls the original with the
 * same `this` and arguments. They are method decorators in the legacy
 * (`experimentalDecorators`) form Nest itself uses.
 *
 * - **Only methods returning a `Promise`** type-check: a cached value can
 *   only come back asynchronously, so the wrapper always returns one. (A
 *   method that is not `async` still runs, untyped; its callers get a
 *   `Promise`.)
 * - **Instance methods only**: a static method has no application to find
 *   its cache through, and decorating one throws at class definition.
 * - **Metadata survives**: everything `reflect-metadata` holds on the
 *   original function is copied to the wrapper, so Nest decorators applied
 *   before this one (below it) are not lost.
 */
import type {
  Cache,
  GetOrSetOptions,
  SetOptions,
} from "@kingsleyweb/bun-cache";
import type { KeyTemplate } from "./keys";
import { compileKeyTemplate, defaultKey } from "./keys";
import { resolveCache } from "./registry";

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

/**
 * What every cache decorator accepts. `A` is the method's parameters,
 * inferred from an annotated `key` function first: every other function
 * option takes `NonNullable<A>` (`A & {}`), which TypeScript infers from only
 * when `key` gave nothing — so an `unless: (result: R) => …` or a
 * `condition` reading fewer parameters than `key` does not shrink `A` to its
 * own shorter list. A decorated method whose parameters do not start with
 * `A`, or which does not return a `Promise`, is a compile error.
 */
interface CacheDecoratorOptions<A extends unknown[]> {
  /**
   * The cache key: a function of the method's arguments (its parameter
   * types are checked against the method's), or a positional template,
   * `"orgs:{0}:page:{1.page}"` — `{0}` is the first argument, `{1.page}` the
   * second's `page`; `{{` and `}}` write a brace. A template is checked when
   * the class is defined; a placeholder that is out of range, `undefined`,
   * or an object throws on the call. Defaults to `ClassName.method:` plus a
   * stable hash of the arguments (plain objects' keys sorted; a `Map` or
   * `Set` in insertion order, so pass `key` when arguments are such objects).
   */
  key?: string | ((...args: A) => string);
  /** The cache to use, by the `name` given to `BunCacheModule.forRoot`; the default (unnamed) cache when omitted. */
  cache?: string;
  /**
   * Decides, from the arguments and before the method runs, whether to use
   * the cache at all; `false` calls the method alone. Spring's `condition`.
   */
  condition?: (...args: NonNullable<A>) => boolean;
}

/** What `@Cacheable` accepts: the key, the cache, and `getOrSet`'s options. */
export interface CacheableOptions<
  A extends unknown[] = never[],
  R = unknown,
  Tag extends string = string,
>
  extends
    CacheDecoratorOptions<A>,
    Omit<GetOrSetOptions<Tag>, "tags" | "signal"> {
  /** The stored entry's tags, or a function of the arguments returning them. */
  tags?: readonly Tag[] | ((...args: NonNullable<A>) => readonly Tag[]);
  /**
   * Decides, after the method ran, whether **not** to store its result:
   * `true` returns the result to every caller sharing the run and stores
   * nothing. Spring's `unless`.
   */
  unless?: (result: R, ...args: NonNullable<A>) => boolean;
}

/** What `@CachePut` accepts: the key, the cache, and `set`'s options. */
export interface CachePutOptions<
  A extends unknown[] = never[],
  R = unknown,
  Tag extends string = string,
>
  extends CacheDecoratorOptions<A>, Omit<SetOptions<Tag>, "tags"> {
  /** The stored entry's tags, or a function of the arguments returning them. */
  tags?: readonly Tag[] | ((...args: NonNullable<A>) => readonly Tag[]);
  /** Decides, after the method ran, whether **not** to store its result; the entry already there is then left as it is. */
  unless?: (result: R, ...args: NonNullable<A>) => boolean;
}

/**
 * What `@CacheEvict` accepts. At least one of `key`, `tags` and `all` is
 * required: without them the decorator throws when the class is defined.
 */
export interface CacheEvictOptions<
  A extends unknown[] = never[],
  Tag extends string = string,
> extends CacheDecoratorOptions<A> {
  /** Tags to invalidate (`invalidateTags`), or a function of the arguments returning them. */
  tags?: readonly Tag[] | ((...args: NonNullable<A>) => readonly Tag[]);
  /** Clear the cache's whole namespace (`clear()`); `key` is then ignored. Defaults to `false`. */
  all?: boolean;
  /**
   * Evict before the method runs, so a method that throws still evicts.
   * Defaults to `false`: evict after it succeeded, and not at all when it
   * throws.
   */
  beforeInvocation?: boolean;
}

/**
 * A method decorator for methods whose parameters start with `A` and which
 * resolve an `R`. The method's own type is inferred from what it decorates.
 */
type CacheMethodDecorator<A extends unknown[], R> = <
  T extends (...args: [...A, ...never[]]) => Promise<R>,
>(
  target: object,
  propertyKey: string | symbol,
  descriptor: TypedPropertyDescriptor<T>,
) => void;

/* ------------------------------------------------------------------ *
 * The decorators
 * ------------------------------------------------------------------ */

/**
 * Caches the method's result (plan §10.2). The call goes through the cache's
 * `getOrSet`, so concurrent calls with the same key share one run
 * (single-flight), and the cross-process `lock`, stale-while-revalidate,
 * stale-if-error and the timeouts apply as they do there.
 *
 * - A hit returns the cached value without calling the method.
 * - A method that throws rejects every caller sharing the run with that
 *   error, and nothing is cached; inside `staleIfError`, the stale value is
 *   served instead.
 * - A result of `undefined` is not cached (`get` answers `undefined` for a
 *   miss, so it would read as one), unless `cacheUndefined`; `null` is.
 * - The run is shared by **key**, across instances: a second instance
 *   calling with the same key joins the first's run.
 *
 * ```ts
 * @Cacheable({ key: (id: number) => `user:${id}`, ttl: 60_000, tags: (id) => [`user:${id}`] })
 * async findUser(id: number): Promise<User> { … }
 * ```
 */
export function Cacheable<
  A extends unknown[] = never[],
  R = unknown,
  Tag extends string = string,
>(options: CacheableOptions<A, R, Tag> = {}): CacheMethodDecorator<A, R> {
  const {
    key,
    cache: cacheName,
    condition,
    tags,
    unless,
    ...getOrSetOptions
  } = options;
  return wrapMethod(
    "Cacheable",
    key,
    (original, method, keyOf) =>
      async function cacheable(this: unknown, ...args: unknown[]) {
        const typed = args as A;
        if (condition !== undefined && !condition(...typed)) {
          return await original.apply(this, args);
        }
        const cache = resolveCache(this, cacheName, method);
        const cacheKey = keyOf(args, method);
        const entryTags = typeof tags === "function" ? tags(...typed) : tags;
        return await cache.getOrSet(
          cacheKey,
          async (context) => {
            const result = (await original.apply(this, args)) as R;
            if (unless?.(result, ...typed) === true) {
              context.noStore();
            }
            return result;
          },
          entryTags === undefined
            ? getOrSetOptions
            : { ...getOrSetOptions, tags: entryTags },
        );
      },
  );
}

/**
 * Always runs the method, then stores its result under the key (plan
 * §10.2). Spring's `@CachePut`.
 *
 * - The key and tags are computed **after** the method ran, so a key read
 *   from an argument the method fills in (an assigned id) sees it.
 * - A result of `undefined` deletes the key, so a later read answers what
 *   the method returned; `unless` leaves the existing entry untouched.
 * - A method that throws stores nothing and rethrows.
 */
export function CachePut<
  A extends unknown[] = never[],
  R = unknown,
  Tag extends string = string,
>(options: CachePutOptions<A, R, Tag> = {}): CacheMethodDecorator<A, R> {
  const {
    key,
    cache: cacheName,
    condition,
    tags,
    unless,
    ...setOptions
  } = options;
  return wrapMethod(
    "CachePut",
    key,
    (original, method, keyOf) =>
      async function cachePut(this: unknown, ...args: unknown[]) {
        const typed = args as A;
        if (condition !== undefined && !condition(...typed)) {
          return await original.apply(this, args);
        }
        // Resolved first, so a cache that cannot be found fails the call
        // before the method's side effects, not after.
        const cache = resolveCache(this, cacheName, method);
        const result = (await original.apply(this, args)) as R;
        if (unless?.(result, ...typed) === true) {
          return result;
        }
        const cacheKey = keyOf(args, method);
        if (result === undefined) {
          await cache.delete(cacheKey);
          return result;
        }
        const entryTags = typeof tags === "function" ? tags(...typed) : tags;
        await cache.set(
          cacheKey,
          result,
          entryTags === undefined
            ? setOptions
            : { ...setOptions, tags: entryTags },
        );
        return result;
      },
  );
}

/**
 * Deletes a key, invalidates tags, or clears the namespace (plan §10.2),
 * after the method succeeded — or before it runs, with `beforeInvocation`.
 * Spring's `@CacheEvict`.
 *
 * ```ts
 * @CacheEvict({ tags: (id: number) => [`user:${id}`] })
 * async updateUser(id: number, patch: Partial<User>): Promise<User> { … }
 * ```
 */
export function CacheEvict<
  A extends unknown[] = never[],
  Tag extends string = string,
>(options: CacheEvictOptions<A, Tag>): CacheMethodDecorator<A, unknown> {
  const {
    key,
    cache: cacheName,
    condition,
    tags,
    all = false,
    beforeInvocation = false,
  } = options;
  if (key === undefined && tags === undefined && !all) {
    throw new TypeError(
      "@CacheEvict needs `key`, `tags` or `all: true`: the default key names the evicting method itself, so it would never match an entry another method cached",
    );
  }
  return wrapMethod("CacheEvict", key, (original, method, keyOf) => {
    /** Evicts what the options name, for one call's arguments. */
    const evict = async (cache: Cache, args: unknown[]): Promise<void> => {
      const typed = args as A;
      if (all) {
        await cache.clear();
      } else if (key !== undefined) {
        await cache.delete(keyOf(args, method));
      }
      const evictTags = typeof tags === "function" ? tags(...typed) : tags;
      if (evictTags !== undefined && evictTags.length > 0) {
        await cache.invalidateTags(evictTags);
      }
    };
    return async function cacheEvict(this: unknown, ...args: unknown[]) {
      if (condition !== undefined && !condition(...(args as A))) {
        return await original.apply(this, args);
      }
      const cache = resolveCache(this, cacheName, method);
      if (beforeInvocation) {
        await evict(cache, args);
        return await original.apply(this, args);
      }
      const result: unknown = await original.apply(this, args);
      await evict(cache, args);
      return result;
    };
  });
}

/* ------------------------------------------------------------------ *
 * The wrapping
 * ------------------------------------------------------------------ */

/** Any method, as the wrapper calls it. */
type AnyMethod = (this: unknown, ...args: unknown[]) => unknown;

/** The `reflect-metadata` calls the copy uses, read structurally: they exist once Nest is loaded. */
interface MetadataReflect {
  getOwnMetadataKeys?: (target: object) => unknown[];
  getOwnMetadata?: (key: unknown, target: object) => unknown;
  defineMetadata?: (key: unknown, value: unknown, target: object) => void;
}

/** Copies every `reflect-metadata` entry of `from` onto `to`. */
function copyMetadata(from: object, to: object): void {
  const reflect = Reflect as unknown as MetadataReflect;
  if (
    reflect.getOwnMetadataKeys === undefined ||
    reflect.getOwnMetadata === undefined ||
    reflect.defineMetadata === undefined
  ) {
    return;
  }
  for (const metadataKey of reflect.getOwnMetadataKeys(from)) {
    reflect.defineMetadata(
      metadataKey,
      reflect.getOwnMetadata(metadataKey, from),
      to,
    );
  }
}

/**
 * The decorator every cache decorator returns: checks what it decorates,
 * compiles the key once, and replaces the method with `build`'s wrapper.
 */
function wrapMethod<A extends unknown[], R>(
  decorator: string,
  key: string | ((...args: A) => string) | undefined,
  build: (original: AnyMethod, method: string, keyOf: KeyTemplate) => AnyMethod,
): CacheMethodDecorator<A, R> {
  return (target, propertyKey, descriptor) => {
    const owner =
      typeof target === "function"
        ? target.name
        : (target.constructor as { name?: string } | undefined)?.name;
    const method = `${owner ?? "<anonymous>"}.${String(propertyKey)}`;
    if (typeof target === "function") {
      throw new TypeError(
        `@${decorator} on ${method}: only instance methods can be cached; a static method has no application to find its cache through`,
      );
    }
    const original = descriptor.value as AnyMethod | undefined;
    if (typeof original !== "function") {
      throw new TypeError(
        `@${decorator} on ${method}: only methods can be cached, not accessors or fields`,
      );
    }
    let keyOf: KeyTemplate;
    if (typeof key === "string") {
      keyOf = compileKeyTemplate(key, `@${decorator} on ${method}`);
    } else if (typeof key === "function") {
      keyOf = (args) => key(...(args as A));
    } else {
      keyOf = (args) => defaultKey(method, args);
    }
    const wrapped = build(original, method, keyOf);
    Object.defineProperty(wrapped, "name", {
      value: original.name,
      configurable: true,
    });
    Object.defineProperty(wrapped, "length", {
      value: original.length,
      configurable: true,
    });
    copyMetadata(original, wrapped);
    descriptor.value = wrapped as unknown as typeof descriptor.value;
  };
}
