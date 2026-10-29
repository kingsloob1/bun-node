/* eslint-disable @typescript-eslint/require-await -- Keyv 6 tells a storage adapter by its methods being `async` functions */
import type { Cache as CacheManager } from "cache-manager";
import { createCache as createCacheManager } from "cache-manager";
import { Keyv as Keyv5 } from "keyv";
import { Keyv as Keyv6 } from "keyv-6";

/**
 * The Keyv compatibility harness (plan §13.1's Keyv row, §10.4): a Keyv store
 * adapter driven through the **real** cache-manager 7.2.9, over Keyv 5.6.0 —
 * the version cache-manager depends on — and over Keyv 6.1.0, which breaks
 * it. It lives in the bench package so cache-manager and both Keyv majors
 * stay out of bun-cache's devDependencies.
 *
 * PR-K1 runs `toKeyvStore` through {@link describeKeyvCompat}; this PR proves
 * the harness on {@link referenceBacking}, and pins what the plan measured
 * (`docs/plans/bun-cache/evidence/keyv-compat/`) so a Keyv or cache-manager
 * release that changes it is noticed.
 */

/** A Keyv major this harness drives. */
export type KeyvMajor = 5 | 6;

/** The exact versions behind each major, as `package.json` pins them. */
export const KEYV_VERSION: Record<KeyvMajor, string> = {
  5: "5.6.0",
  6: "6.1.0",
};

/** One call a store received, for asserting on what Keyv sends it. */
export interface StoreCall {
  /** The method called. */
  method: string;
  /** Its arguments, as received. */
  args: unknown[];
  /** The store's `namespace` property at the time of the call. */
  namespace: string | undefined;
}

/**
 * A Keyv store adapter, structurally: the methods both majors call, and the
 * properties Keyv reads and writes. Nothing here imports a Keyv type, as
 * `toKeyvStore` will not.
 */
export interface KeyvStoreLike {
  /** Reads a raw value Keyv stored. */
  get: (key: string) => Promise<unknown>;
  /** Stores Keyv's raw value; `ttl` is relative ms (Keyv 5, and Keyv 6's bridge). */
  set: (key: string, value: unknown, ttl?: number) => Promise<unknown>;
  /** Deletes a key; `true` when it was there. */
  delete: (key: string) => Promise<boolean>;
  /** Deletes every key of the store's current `namespace`. */
  clear: () => Promise<void>;
  /** Keyv 5 sets this to its own namespace before every call; Keyv 6 leaves it unset by default. */
  namespace?: string;
  /** Options Keyv reads (`dialect`, `url`); present on every Keyv store. */
  opts?: Record<string, unknown>;
}

/** Wraps a store so every method call is recorded, with the namespace it saw. */
export function recording<S extends KeyvStoreLike>(
  store: S,
): { store: S; calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  const proxy = new Proxy(store, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || property === "on") return value;
      return (...args: unknown[]) => {
        calls.push({
          method: String(property),
          args,
          namespace: target.namespace,
        });
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store: proxy, calls };
}

/**
 * The reference store's other methods: the rest of Keyv 6's full storage
 * adapter (`has`, `hasMany`, `getMany`, `setMany`, `deleteMany`), and the
 * hooks Keyv reads. With all of them and a `namespace` property, Keyv 6
 * leaves the namespace to the store (its `_storeHandlesNamespace`); without
 * them, its namespaced `clear()` throws, as the plan measured (§10.4). It
 * declares no `capabilities.expires`, so Keyv 6 bridges it and it keeps
 * receiving a relative TTL, as Keyv 5 sends.
 */
export interface ReferenceStore extends KeyvStoreLike {
  /** Whether a key is stored and unexpired. */
  has: (key: string) => Promise<boolean>;
  /** Whether each key is stored and unexpired. */
  hasMany: (keys: string[]) => Promise<boolean[]>;
  /** Reads several keys. */
  getMany: (keys: string[]) => Promise<unknown[]>;
  /** Writes several entries: each with a relative `ttl` or an absolute `expires`. */
  setMany: (
    entries: { key: string; value: unknown; ttl?: number; expires?: number }[],
  ) => Promise<boolean[]>;
  /** Deletes several keys; per key, whether it was there (Keyv 6's shape). */
  deleteMany: (keys: string[]) => Promise<boolean[]>;
  /** Keyv's event hook; nothing is emitted. */
  on: () => unknown;
  /** Closes nothing. */
  disconnect: () => Promise<void>;
}

/**
 * The reference backing: one `Map`, and a factory of store adapters over it.
 * Each adapter keys under its own `namespace`, honours a relative TTL and scopes
 * `clear()` to its own namespace, with Keyv 6's optional bulk methods. Two
 * adapters over one backing are what two caches over one shared backend look
 * like (as two `toKeyvStore(cache)` calls on one bun-cache are). It is what
 * the harness is proven on, and the behaviour an adapter must match.
 */
export function referenceBacking(): { store: () => ReferenceStore } {
  const map = new Map<string, { value: unknown; expires: number | null }>();
  const live = (key: string) => {
    const hit = map.get(key);
    if (hit && hit.expires !== null && hit.expires <= Date.now()) {
      map.delete(key);
      return undefined;
    }
    return hit;
  };
  return {
    store: () => {
      // The store keys under its own namespace: Keyv 5 prefixes keys itself
      // as well (`keyv:k` arrives), while Keyv 6 hands the namespace to a
      // full adapter and sends the bare key.
      const state: { namespace: string | undefined } = { namespace: undefined };
      const own = (key: string) => `${state.namespace ?? ""}\u0000${key}`;
      const store: ReferenceStore = {
        opts: { dialect: "map" },
        get namespace() {
          return state.namespace;
        },
        set namespace(value: string | undefined) {
          state.namespace = value;
        },
        on: () => store,
        get: async (key) => live(own(key))?.value,
        set: async (key, value, ttl) => {
          map.set(own(key), {
            value,
            expires:
              typeof ttl === "number" && ttl > 0 ? Date.now() + ttl : null,
          });
          return true;
        },
        delete: async (key) => map.delete(own(key)),
        clear: async () => {
          const prefix =
            state.namespace === undefined ? "" : `${state.namespace}\u0000`;
          for (const key of [...map.keys()]) {
            if (key.startsWith(prefix)) map.delete(key);
          }
        },
        has: async (key) => live(own(key)) !== undefined,
        hasMany: async (keys) =>
          keys.map((key) => live(own(key)) !== undefined),
        getMany: async (keys) => keys.map((key) => live(own(key))?.value),
        setMany: async (entries) =>
          entries.map(({ key, value, ttl, expires }) => {
            map.set(own(key), {
              value,
              expires:
                expires ??
                (typeof ttl === "number" && ttl > 0 ? Date.now() + ttl : null),
            });
            return true;
          }),
        deleteMany: async (keys) => keys.map((key) => map.delete(own(key))),
        disconnect: async () => {},
      };
      return store;
    },
  };
}

/**
 * A Keyv of `major` over `store`, as `@nestjs/cache-manager` builds one from
 * a bare adapter (`new Keyv({ store, ttl, namespace })`).
 */
export function keyvOver(
  major: KeyvMajor,
  store: KeyvStoreLike,
  options: { namespace?: string; ttl?: number } = {},
): Keyv5 {
  if (major === 5) {
    return new Keyv5({ store, ...options });
  }
  // cache-manager's types name Keyv 5's class; a Keyv 6 instance is passed
  // to it exactly as an app on Keyv 6 would, which is the point of the column.
  return new Keyv6({ store, ...options }) as unknown as Keyv5;
}

/** cache-manager 7.2.9 over a Keyv of `major` over `store`. */
export function cacheManagerOver(
  major: KeyvMajor,
  store: KeyvStoreLike,
  options: { namespace?: string; ttl?: number } = {},
): { cache: CacheManager; keyv: Keyv5 } {
  const keyv = keyvOver(major, store, options);
  return {
    keyv,
    cache: createCacheManager({ stores: [keyv], ttl: options.ttl ?? 60_000 }),
  };
}
