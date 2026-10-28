/**
 * The per-application cache registry the method decorators resolve through
 * (plan §10.2, "Finding the cache").
 *
 * Decorators run at class definition, before any container exists, so a
 * decorated method finds its cache on the call: from the instance it is
 * called on (`this`) to the application that created it, then by name. Each
 * application gets one registry — a provider of the internal
 * {@link BunCacheRegistryModule}, which every `BunCacheModule` imports, and
 * which Nest instantiates once per application — and every `BunCacheModule`
 * registers its cache there in `onModuleInit`.
 *
 * Which application created an instance is answered by Nest's own
 * `DiscoveryService`, scanned once after initialisation began (every static
 * instance exists before the first lifecycle hook runs) and again on a miss
 * (a lazily loaded module adds instances later):
 *
 * - **a static instance** (a singleton provider or controller) is matched by
 *   identity, so two applications in one process — two test apps, an HTTP
 *   app beside a microservice — never share a cache by accident;
 * - **a request-scoped or transient instance** is created per request, after
 *   the scan, so it is matched by its class, among the classes the
 *   application registered with a non-static scope. Two live applications
 *   registering the same such class are ambiguous, and the call says so.
 *
 * It imports nothing from `@kingsleyweb/bun-cache` at run time.
 */
import type { Cache } from "@kingsleyweb/bun-cache";
import type { OnApplicationShutdown, OnModuleInit, Type } from "@nestjs/common";
import { Inject, Injectable, Module } from "@nestjs/common";
import { DiscoveryModule, DiscoveryService } from "@nestjs/core";
import { CacheNotReadyError } from "./errors";

/**
 * The part of Nest's `InstanceWrapper` the scan reads, structurally: its
 * shape is the same on Nest 11 and 12, and naming it avoids a deep import.
 */
interface ScannedWrapper {
  /** The provider's instance; for a non-static provider, the prototype Nest keeps for it. */
  readonly instance: unknown;
  /** The provider's class, or its factory, or `null` for a value provider. */
  readonly metatype: unknown;
  /** Whether one instance serves the whole application (no request or transient scope in its tree). */
  isDependencyTreeStatic: () => boolean;
}

/** The registries of every application that has not closed, in this process. */
const live = new Set<BunCacheRegistry>();

/** The registry each instance resolved to, once found. */
const bound = new WeakMap<object, BunCacheRegistry>();

/** How a cache name reads in a message. */
function cacheLabel(name: string | undefined): string {
  return name === undefined ? "default" : `"${name}"`;
}

/**
 * One application's caches, by name. Internal: the decorators reach it
 * through {@link resolveCache}, and `BunCacheModule` through injection.
 */
export class BunCacheRegistry implements OnModuleInit, OnApplicationShutdown {
  /** The caches registered so far, by name; the default cache under `undefined`. */
  readonly #caches = new Map<string | undefined, Cache>();
  /** The static instances this application created, from the last scan. */
  #instances = new WeakSet<object>();
  /** The classes this application registered with a request or transient scope, from the last scan. */
  #scopedClasses = new Set<unknown>();
  /** Whether a scan has run since initialisation began. */
  #scanned = false;
  /** Whether initialisation has begun: a lifecycle hook ran, so every static instance exists. */
  #initialising = false;
  /** Whether the application has closed. */
  #closed = false;

  constructor(
    /** Nest's discovery service, for the scan. */
    private readonly discovery: DiscoveryService,
  ) {
    live.add(this);
  }

  /** Initialisation has begun: the scan may run from here on. */
  onModuleInit(): void {
    this.#initialising = true;
  }

  /** The application closed: its caches can no longer be resolved. */
  onApplicationShutdown(): void {
    this.#closed = true;
    live.delete(this);
  }

  /**
   * Registers a cache under its name. Throws on a second cache with the same
   * name: decorators resolve by name across the whole application, so a
   * name means one cache.
   */
  register(name: string | undefined, cache: Cache): void {
    this.#initialising = true;
    const existing = this.#caches.get(name);
    if (existing !== undefined && existing !== cache) {
      throw new Error(
        `BunCacheModule: two modules register the ${cacheLabel(name)} cache in one application; give each its own \`name\``,
      );
    }
    this.#caches.set(name, cache);
  }

  /** The cache registered under `name`, if any. */
  get(name: string | undefined): Cache | undefined {
    return this.#caches.get(name);
  }

  /** Whether the application has closed. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * How this application relates to `instance`: `"instance"` when it created
   * it, `"class"` when it registered its class with a non-static scope,
   * `undefined` otherwise. Scans on first use and again on a miss.
   */
  claim(instance: object): "instance" | "class" | undefined {
    if (!this.#initialising) {
      return undefined;
    }
    if (!this.#scanned) {
      this.#scan();
    }
    let found = this.#match(instance);
    if (found === undefined) {
      this.#scan();
      found = this.#match(instance);
    }
    return found;
  }

  /** Matches an instance against the last scan. */
  #match(instance: object): "instance" | "class" | undefined {
    if (this.#instances.has(instance)) {
      return "instance";
    }
    return this.#scopedClasses.has(instance.constructor) ? "class" : undefined;
  }

  /** Records the application's static instances and its scoped classes. */
  #scan(): void {
    const instances = new WeakSet<object>();
    const scoped = new Set<unknown>();
    const wrappers = [
      ...this.discovery.getProviders(),
      ...this.discovery.getControllers(),
    ] as unknown as ScannedWrapper[];
    for (const wrapper of wrappers) {
      if (wrapper.isDependencyTreeStatic()) {
        const instance = wrapper.instance;
        if (typeof instance === "object" && instance !== null) {
          instances.add(instance);
        }
      } else if (typeof wrapper.metatype === "function") {
        scoped.add(wrapper.metatype);
      }
    }
    this.#instances = instances;
    this.#scopedClasses = scoped;
    this.#scanned = true;
  }
}

// `@Injectable()` and `@Inject(DiscoveryService)` on the constructor's
// parameter, by call: Bun reads the decorator options from the working
// directory's tsconfig (oven-sh/bun#28605), and the call behaves the same
// under either decorator semantics (validation.ts has the same pattern).
Injectable()(BunCacheRegistry);
Inject(DiscoveryService)(BunCacheRegistry, undefined, 0);

/**
 * Provides the one {@link BunCacheRegistry} of an application. A static
 * module, so however many `BunCacheModule`s import it, Nest builds it once
 * per application.
 */
export class BunCacheRegistryModule {}
Module({
  imports: [DiscoveryModule],
  providers: [BunCacheRegistry],
  exports: [BunCacheRegistry],
})(BunCacheRegistryModule);

/**
 * Finds the cache a decorated method asks for, from the instance it was
 * called on. Throws {@link CacheNotReadyError} saying why when it cannot.
 */
export function resolveCache(
  instance: unknown,
  name: string | undefined,
  method: string,
): Cache {
  if (typeof instance !== "object" || instance === null) {
    throw new CacheNotReadyError(
      name,
      method,
      "it was called without its instance (`this`); call it on the instance, or bind it",
    );
  }
  let registry = bound.get(instance);
  if (registry === undefined || registry.closed) {
    registry = findRegistry(instance, name, method);
    bound.set(instance, registry);
  }
  const cache = registry.get(name);
  if (cache === undefined) {
    throw new CacheNotReadyError(
      name,
      method,
      name === undefined
        ? "its application registers no default cache; import `BunCacheModule.forRoot()` without a `name`"
        : `its application registers no cache named "${name}"; import \`BunCacheModule.forRoot({ name: "${name}", … })\``,
    );
  }
  return cache;
}

/** The live registry whose application created `instance`. */
function findRegistry(
  instance: object,
  name: string | undefined,
  method: string,
): BunCacheRegistry {
  const byInstance: BunCacheRegistry[] = [];
  const byClass: BunCacheRegistry[] = [];
  for (const registry of live) {
    const claim = registry.claim(instance);
    if (claim === "instance") {
      byInstance.push(registry);
    } else if (claim === "class") {
      byClass.push(registry);
    }
  }
  const className = (instance.constructor as Type | undefined)?.name ?? "it";
  if (byInstance.length === 1) {
    return byInstance[0];
  }
  if (byInstance.length > 1) {
    // One object provided (`useValue`) to several applications.
    throw new CacheNotReadyError(
      name,
      method,
      `${byInstance.length} live applications provide this same ${className} instance, so its cache is ambiguous; give each application its own instance`,
    );
  }
  if (byClass.length === 1) {
    return byClass[0];
  }
  if (byClass.length > 1) {
    throw new CacheNotReadyError(
      name,
      method,
      `${byClass.length} live applications register ${className} with a request or transient scope, so its cache is ambiguous; close the other applications, or make the provider a singleton`,
    );
  }
  // One message for every case: which one it is (called too early, on a
  // `new`ed instance, after close) cannot be told apart reliably — an
  // application whose bootstrap failed leaves its registry uninitialised
  // for good, so "some registry is still initialising" is no evidence.
  throw new CacheNotReadyError(
    name,
    method,
    "no initialised application created this instance: call it on a provider or controller a Nest application built (with `BunCacheModule` imported), after `app.init()` (or `listen()`) — not from a constructor or a provider factory, nor on an instance made with `new` or one whose application has closed",
  );
}
