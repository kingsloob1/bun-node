import type { Cache, CreateCacheOptions } from "@kingsleyweb/bun-cache";
import type {
  DynamicModule,
  InjectionToken,
  ModuleMetadata,
  OnApplicationShutdown,
  OnModuleInit,
  OptionalFactoryDependency,
  Provider,
} from "@nestjs/common";
import { createCache } from "@kingsleyweb/bun-cache";
import { Inject, Module } from "@nestjs/common";
import { BunCacheRegistry, BunCacheRegistryModule } from "./registry";
import { BUN_CACHE_OPTIONS, getCacheToken } from "./tokens";

/**
 * A `@kingsleyweb/bun-cache` cache as a NestJS module (plan §10.1).
 *
 * It is deliberately **not** exported from `@kingsleyweb/bun-nest`'s barrel:
 * this package ships raw `.ts`, so a re-export would make every Nest app
 * compile `@kingsleyweb/bun-cache` whether or not it has one. Import it from
 * `@kingsleyweb/bun-nest/cache`, which is where the dependency starts.
 *
 * Each `forRoot`/`forRootAsync` provides one cache under
 * `getCacheToken(name)` (`BUN_CACHE` for the default, unnamed one) and its
 * options under `BUN_CACHE_OPTIONS` (the default cache's), and exports both.
 *
 * - **`onModuleInit`** registers the cache with the application's registry,
 *   where `@Cacheable`, `@CachePut` and `@CacheEvict` find it by name.
 * - **`onApplicationShutdown`** closes a cache the module created — never
 *   one passed in as `cache`, which belongs to whoever made it. Not
 *   `onModuleDestroy`: `NestApplication.close()` runs
 *   `callDestroyHook() → callBeforeShutdownHook() → dispose() → callShutdownHook()`,
 *   and `dispose()` is where the HTTP server drains its in-flight requests,
 *   which may still read and write the cache.
 */

/** Where a module's cache comes from: options to create one (the module then owns and closes it), or a cache made elsewhere (never closed by the module). */
type CacheSource = CreateCacheOptions | { cache: Cache };

/** What {@link BunCacheModule.forRoot} accepts. */
export type BunCacheModuleOptions = CacheSource & {
  /**
   * The cache's name, for several caches in one application: it is provided
   * under `getCacheToken(name)`, injected with `@InjectCache(name)`, and
   * chosen by a decorator's `cache: name`. Omitted, it is the default cache
   * (`BUN_CACHE`). One cache per name per application.
   */
  name?: string;
  /** Make the module global, so every module can inject the cache without importing it. Defaults to `false`. */
  isGlobal?: boolean;
};

/** What {@link BunCacheModule.forRootAsync} accepts. */
export interface BunCacheModuleAsyncOptions extends Pick<
  ModuleMetadata,
  "imports"
> {
  /** The cache's name (see {@link BunCacheModuleOptions.name}); known up front, since it names the token. Omitted, the default cache. */
  name?: string;
  /** Make the module global. Defaults to `false`. */
  isGlobal?: boolean;
  /** Providers injected into {@link useFactory}. */
  inject?: (InjectionToken | OptionalFactoryDependency)[];
  /** Builds the cache's options — or returns `{ cache }`, a cache made elsewhere — with whatever {@link inject} resolved. */
  useFactory: (...args: any[]) => CacheSource | Promise<CacheSource>;
}

/** Injects a cache: the default one, or the one registered under `name`. */
export const InjectCache = (name?: string): ReturnType<typeof Inject> =>
  Inject(getCacheToken(name));

/** What each module instance holds about its cache (internal). */
interface ModuleEntry {
  /** The cache's name; `undefined` for the default cache. */
  name: string | undefined;
  /** The cache. */
  cache: Cache;
  /** Whether the module created it, and so closes it. */
  owned: boolean;
}

/**
 * The token of a module's {@link ModuleEntry}. The same in every
 * `BunCacheModule`, never exported: each dynamic module resolves its own.
 */
const MODULE_ENTRY = Symbol("bun-nest.cache.moduleEntry");

/**
 * The token a cache's module options are provided under:
 * {@link BUN_CACHE_OPTIONS} for the default cache, a registered symbol of its
 * own for each `name`. Not exported: named caches' options are rarely
 * injected, and this keeps the token surface to the plan's names.
 */
function getCacheOptionsToken(name: string | undefined): symbol {
  return name === undefined
    ? BUN_CACHE_OPTIONS
    : Symbol.for(`@kingsleyweb/bun-nest/cache:options:${name}`);
}

/** Checks a name: a non-empty string or nothing. */
function checkName(name: unknown): string | undefined {
  if (name === undefined) {
    return undefined;
  }
  if (typeof name !== "string" || name === "") {
    throw new TypeError(
      `BunCacheModule: \`name\` must be a non-empty string, or omitted for the default cache (got ${JSON.stringify(name)})`,
    );
  }
  return name;
}

/** The cache a source describes, and whether the module owns it. */
function fromSource(
  source: CacheSource,
  name: string | undefined,
): ModuleEntry {
  if (typeof source !== "object" || source === null) {
    throw new TypeError(
      "BunCacheModule: the options must be createCache's options or `{ cache }`",
    );
  }
  if ("cache" in source) {
    if ("driver" in source) {
      throw new TypeError(
        "BunCacheModule: pass either `cache` (a cache made elsewhere) or createCache's options with a `driver`, not both",
      );
    }
    return { name, cache: source.cache, owned: false };
  }
  if (!("driver" in source) || source.driver === undefined) {
    throw new TypeError(
      "BunCacheModule: createCache's options need a `driver` (memoryDriver(), sqliteDriver(), …), or pass `{ cache }`",
    );
  }
  // `name` and `isGlobal` are the module's, not createCache's.
  const {
    name: _name,
    isGlobal: _isGlobal,
    ...cacheOptions
  } = source as CreateCacheOptions & { name?: unknown; isGlobal?: unknown };
  return { name, cache: createCache(cacheOptions), owned: true };
}

/** The providers every module has, after the options provider. */
function cacheProviders(name: string | undefined): Provider[] {
  const optionsToken = getCacheOptionsToken(name);
  return [
    {
      provide: MODULE_ENTRY,
      useFactory: (source: CacheSource): ModuleEntry =>
        fromSource(source, name),
      inject: [optionsToken],
    },
    {
      provide: getCacheToken(name),
      useFactory: (entry: ModuleEntry): Cache => entry.cache,
      inject: [MODULE_ENTRY],
    },
  ];
}

export class BunCacheModule implements OnModuleInit, OnApplicationShutdown {
  constructor(
    /** This module's cache, its name and whether it owns it. */
    private readonly entry: ModuleEntry,
    /** The application's registry, where the decorators find the cache. */
    private readonly registry: BunCacheRegistry,
  ) {}

  /**
   * Registers a cache with options known at module definition time:
   * `createCache`'s options (the module creates the cache and closes it on
   * shutdown), or `{ cache }`, a cache made elsewhere.
   *
   * ```ts
   * BunCacheModule.forRoot({ driver: memoryDriver(), ttl: 60_000, isGlobal: true })
   * ```
   */
  static forRoot(options: BunCacheModuleOptions): DynamicModule {
    const name = checkName(options.name);
    const optionsToken = getCacheOptionsToken(name);
    return {
      module: BunCacheModule,
      global: options.isGlobal === true,
      imports: [BunCacheRegistryModule],
      providers: [
        { provide: optionsToken, useValue: options },
        ...cacheProviders(name),
      ],
      exports: [getCacheToken(name), optionsToken],
    };
  }

  /**
   * Registers a cache with options built by a factory, with injection.
   *
   * ```ts
   * BunCacheModule.forRootAsync({
   *   name: "reports",
   *   imports: [ConfigModule],
   *   inject: [ConfigService],
   *   useFactory: (config: ConfigService) => ({ driver: sqliteDriver({ path: config.get("CACHE_DB") }) }),
   * })
   * ```
   */
  static forRootAsync(options: BunCacheModuleAsyncOptions): DynamicModule {
    const name = checkName(options.name);
    const optionsToken = getCacheOptionsToken(name);
    return {
      module: BunCacheModule,
      global: options.isGlobal === true,
      imports: [BunCacheRegistryModule, ...(options.imports ?? [])],
      providers: [
        {
          provide: optionsToken,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        ...cacheProviders(name),
      ],
      exports: [getCacheToken(name), optionsToken],
    };
  }

  /** Registers the cache, by name, where the method decorators look. */
  onModuleInit(): void {
    this.registry.register(this.entry.name, this.entry.cache);
  }

  /** Closes the cache if this module created it, once the HTTP server has drained. */
  async onApplicationShutdown(): Promise<void> {
    if (this.entry.owned) {
      await this.entry.cache.close();
    }
  }
}

// `@Module()` and `@Inject(...)` on the constructor's parameters, by call:
// Bun reads the decorator options from the working directory's tsconfig
// (oven-sh/bun#28605), and the call behaves the same under either decorator
// semantics (validation.ts has the same pattern).
Inject(MODULE_ENTRY)(BunCacheModule, undefined, 0);
Inject(BunCacheRegistry)(BunCacheModule, undefined, 1);
Module({})(BunCacheModule);
