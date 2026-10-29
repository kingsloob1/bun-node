/**
 * `@kingsleyweb/bun-cache/keyv`: a Keyv store adapter over a bun-cache
 * (plan §10.4, D12), for apps already on `@nestjs/cache-manager` or
 * cache-manager, whose only storage seam is a Keyv store.
 *
 * ```ts
 * import { CacheModule } from "@nestjs/cache-manager";
 * import { createCache, postgresDriver } from "@kingsleyweb/bun-cache";
 * import { toKeyvStore } from "@kingsleyweb/bun-cache/keyv";
 *
 * CacheModule.register({
 *   stores: [toKeyvStore(createCache({ driver: postgresDriver({ url }) }))],
 *   ttl: 60_000,
 * });
 * ```
 *
 * It is structural: nothing here imports Keyv, and the package has no Keyv
 * dependency. One store serves both Keyv majors:
 *
 * - **Keyv 5** (what cache-manager 7.2.9 depends on, and the pairing the
 *   README pins) sends a relative TTL in ms, prefixes keys with its namespace
 *   (`keyv:k`) and sets `store.namespace` before it calls the store.
 * - **Keyv 6** reads `capabilities`, finds `expires: true` and uses the
 *   store directly (no bridge): it sends an absolute `expires` in epoch ms,
 *   bare keys, and expects `boolean[]` from `deleteMany`. Reading
 *   `capabilities` is what switches the store to Keyv 6's contract; Keyv 5
 *   never reads it.
 *
 * Values are Keyv's own serialised strings (its JSON envelope, already
 * compressed or encrypted when Keyv was told to): they are stored with the
 * `"raw"` codec, opaque, whatever the cache's `codec` says, so nothing is
 * serialised twice. A value Keyv did not serialise (`serialize: undefined`
 * in Keyv 5, `serialization: false` in Keyv 6) is an object; it is stored
 * with the cache's own codec, its first and only encoding.
 */
import type { Cache, CacheSchema, SetOptions } from "../core/types";
import { cacheWithCodec } from "../core/cache";

/** Options for {@link toKeyvStore}. */
export interface ToKeyvStoreOptions {
  /**
   * A namespace under the cache's for everything this store holds
   * (`cache.namespace(namespace)`), so a cache shared with other code keeps
   * its own entries apart from Keyv's: Keyv's `clear()` with no namespace
   * clears this one, never the cache's. Keyv's own namespace nests under it.
   * Defaults to the cache's own namespace.
   */
  namespace?: string;
}

/** One entry of a Keyv bulk write (`setMany`). */
export interface KeyvStoreEntry {
  /** The key, as Keyv sends it (Keyv 5 has prefixed its namespace: `keyv:k`). */
  key: string;
  /** Keyv's stored value: its serialised string, or an object when Keyv's serialisation is off. */
  value: unknown;
  /** Keyv 5: the relative TTL in ms; absent, zero, negative or non-finite means no expiry. */
  ttl?: number;
  /** Keyv 6: the absolute expiry in epoch ms; absent means no expiry, past means the entry is deleted. */
  expires?: number;
}

/**
 * What {@link toKeyvStore} returns: a Keyv storage adapter, structurally the
 * methods and properties both Keyv majors call. It is assignable to Keyv 5's
 * `KeyvStoreAdapter` (the type `@nestjs/cache-manager`'s `stores` option
 * names); Keyv 6 types its `store` option loosely, so it takes it as well.
 *
 * It deliberately has no `hooks` or `stats` property: `@nestjs/cache-manager`
 * takes an object with `opts`, `hooks` and `stats` for a Keyv instance and
 * would not wrap it.
 */
export interface BunCacheKeyvStore {
  /** Options Keyv reads from a store; only `dialect` is set (`"bun-cache"`). */
  opts: { dialect: "bun-cache" };
  /**
   * Keyv's namespace for this store: Keyv 5 sets it on construction (its
   * default is `"keyv"`) and on every `keyv.namespace = …`; Keyv 6 sets it
   * when it has one, and otherwise reads it. Read on every call, so a change
   * after construction applies to the next one. `undefined` or `""` is no
   * namespace. Defaults to `undefined`.
   */
  namespace: string | undefined;
  /**
   * Keyv 6's storage capabilities, with `expires: true`: Keyv 6 then uses
   * the store directly and sends absolute expiries. Reading it switches the
   * store to Keyv 6's contract (absolute `set` expiries, `boolean[]` from
   * `deleteMany`), so one store serves one Keyv.
   */
  readonly capabilities: {
    /** Always `true`. */
    compatible: true;
    /** Always `"keyvStorage"`: every method of a full storage adapter is here. */
    store: "keyvStorage";
    /** Which storage methods exist; all are `async`, and there is no `iterator`. */
    methods: Record<
      string,
      {
        /** Whether the method exists. */
        exists: boolean;
        /** `"async"`, or `"none"` when it does not exist. */
        methodType: "async" | "none";
      }
    >;
    /** The store takes an absolute `expires` on `set` and `setMany`. */
    expires: true;
  };
  /**
   * Registers a listener; the only event emitted is `"error"`, with the
   * error. A failed operation never throws: it emits `error` and answers a
   * miss, `false` or nothing, as Keyv expects of a store. The cache's own
   * `error` events (a driver failure the default policy turned into a miss)
   * are forwarded too. Answers the store.
   */
  on: (event: string, listener: (error: unknown) => void) => BunCacheKeyvStore;
  /** Reads Keyv's stored value; `undefined` on a miss. */
  get: <Value = unknown>(key: string) => Promise<Value | undefined>;
  /** Reads several keys, in order, `undefined` per miss. */
  getMany: <Value = unknown>(keys: string[]) => Promise<(Value | undefined)[]>;
  /**
   * Stores Keyv's value. The third argument is a relative TTL in ms (Keyv 5)
   * or, once Keyv 6 has read `capabilities`, an absolute expiry in epoch ms;
   * absent means no expiry. Answers whether it was stored.
   */
  set: (key: string, value: unknown, ttlOrExpires?: number) => Promise<boolean>;
  /** Stores several entries; per entry, whether it was stored (all `false` when any of a batch was not). */
  setMany: {
    (entries: KeyvStoreEntry[]): Promise<boolean[]>;
    (entries: KeyvStoreEntry[]): Promise<void>;
  };
  /** Deletes a key; `true` when it was there. */
  delete: (key: string) => Promise<boolean>;
  /** Deletes several keys: Keyv 5 receives whether every key was there, Keyv 6 one boolean per key. The overloads differ only in their answer, so a direct call is typed `boolean` (Keyv 5's adapter type); a store Keyv 6 has read answers the array. */
  deleteMany: {
    (keys: string[]): Promise<boolean>;
    (keys: string[]): Promise<boolean[]>;
  };
  /** Whether a key holds an unexpired value. */
  has: (key: string) => Promise<boolean>;
  /** Whether each key holds an unexpired value. */
  hasMany: (keys: string[]) => Promise<boolean[]>;
  /** Deletes every entry of the current Keyv namespace, and nothing else: never another namespace, never the whole backend. */
  clear: () => Promise<void>;
  /**
   * Stops forwarding the cache's `error` events and closes the cache, as a
   * Keyv store closes its connection (`@nestjs/cache-manager` calls it when
   * its module is destroyed). Give the store a cache nothing else uses.
   */
  disconnect: () => Promise<void>;
}

/** The storage methods Keyv 6 looks for, with whether this store has each. */
const METHODS = [
  "get",
  "getMany",
  "has",
  "hasMany",
  "set",
  "setMany",
  "delete",
  "deleteMany",
  "clear",
  "disconnect",
  "iterator",
] as const;

/** A namespace segment `cache.namespace()` accepts as it is. */
const SEGMENT = /^[\w.-]+$/;

/**
 * The cache's write options for one Keyv write: Keyv's lifetime, and the
 * cache's jitter and stale windows switched off, so the entry lives exactly
 * as long as Keyv said (the cache's default `ttl` never applies either).
 */
function writeOptions(
  lifetime: { ttl: number | null } | { expiresAt: number },
): SetOptions {
  return { ...lifetime, jitter: 0, staleWhileRevalidate: 0, staleIfError: 0 };
}

/**
 * The cache namespace segment for a Keyv namespace: itself when
 * `cache.namespace()` accepts it, else `_:` and its UTF-8 bytes in hex (two
 * segments, so it cannot meet a namespace kept as it is).
 */
function segmentFor(namespace: string): string {
  if (SEGMENT.test(namespace)) {
    return namespace;
  }
  let hex = "";
  for (const byte of new TextEncoder().encode(namespace)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `_:${hex}`;
}

/** Whether Keyv handed over its own serialised form (stored raw) rather than an object. */
function isSerialised(value: unknown): value is string | Uint8Array {
  return typeof value === "string" || value instanceof Uint8Array;
}

/**
 * A Keyv store over `cache` (plan §10.4): give it to `@nestjs/cache-manager`'s
 * `stores`, to `new Keyv({ store })`, or to cache-manager through a Keyv.
 *
 * - **Where entries live.** Under `cache.namespace(options.namespace)` (or
 *   the cache's own namespace), and under Keyv's namespace inside that:
 *   Keyv's namespace `"keyv"` stores in `<ns>:keyv`; a Keyv namespace
 *   `cache.namespace()` would refuse (a space, a colon) in `<ns>:_:<hex>`.
 *   Keys are stored as Keyv sends them, so Keyv 5's `keyv:` prefix stays.
 * - **TTL.** Keyv decides it: a write with none never expires, whatever the
 *   cache's `ttl` default, and the cache's `jitter` and stale windows are
 *   not applied. A relative TTL of 0 or less is none, as Keyv treats it; an
 *   absolute expiry already past deletes the key.
 * - **Lost through Keyv**: tags, stale-while-revalidate and stale-if-error,
 *   cross-process locks, and the cache's codec (Keyv's JSON envelope wins,
 *   so a `Date` comes back a string).
 */
export function toKeyvStore<
  Schema extends CacheSchema = CacheSchema,
  Tag extends string = string,
>(
  cache: Cache<Schema, Tag>,
  options: ToKeyvStoreOptions = {},
): BunCacheKeyvStore {
  // Any cache, a typed or a `codec: "json"` one included: the store reads
  // and writes the keys Keyv sends, which no schema of the cache describes.
  const untyped = cache as unknown as Cache;
  const root =
    options.namespace === undefined
      ? untyped
      : untyped.namespace(options.namespace);
  const rawRoot = cacheWithCodec(root, "raw") ?? root;
  /** Per Keyv namespace (`""` for none): the view reading and writing objects, and the raw one writing Keyv's strings. */
  const views = new Map<string, { plain: Cache; raw: Cache }>();
  const listeners = new Set<(error: unknown) => void>();
  /** Errors already emitted: a strict cache emits an `error` event and then throws the same error. */
  const emitted = new WeakSet<object>();
  let unsubscribe: (() => void) | undefined;
  let keyvNamespace: string | undefined;
  /** Set once Keyv 6 reads `capabilities`: absolute expiries, `boolean[]` deletes. */
  let absolute = false;

  const emitError = (error: unknown): void => {
    if (typeof error === "object" && error !== null) {
      if (emitted.has(error)) {
        return;
      }
      emitted.add(error);
    }
    for (const listener of listeners) {
      listener(error);
    }
  };

  const viewsFor = (): { plain: Cache; raw: Cache } => {
    const id = keyvNamespace ?? "";
    let found = views.get(id);
    if (found === undefined) {
      const segment = id === "" ? undefined : segmentFor(id);
      found =
        segment === undefined
          ? { plain: root, raw: rawRoot }
          : { plain: root.namespace(segment), raw: rawRoot.namespace(segment) };
      views.set(id, found);
    }
    return found;
  };

  /** The write options for a Keyv 5 relative TTL. */
  const relative = (ttl: number | undefined): SetOptions =>
    writeOptions({
      ttl:
        typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0 ? ttl : null,
    });

  /** The write options for a Keyv 6 absolute expiry; `undefined` when it has passed. */
  const fromExpires = (expires: number | undefined): SetOptions | undefined => {
    if (typeof expires !== "number" || !Number.isFinite(expires)) {
      return writeOptions({ ttl: null });
    }
    // Keyv computes `expires` from `Date.now()`, so the wall clock judges it,
    // not the cache's `now` (a test's `fakeClock()` does not move this).
    if (expires <= Date.now()) {
      return undefined;
    }
    return writeOptions({ expiresAt: expires });
  };

  /** Runs one operation; a throw is emitted, never thrown, and answers `fallback`. */
  const guard = async <T>(fallback: T, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      emitError(error);
      return fallback;
    }
  };

  async function setMany(entries: KeyvStoreEntry[]): Promise<boolean[]>;
  async function setMany(entries: KeyvStoreEntry[]): Promise<void>;
  async function setMany(entries: KeyvStoreEntry[]): Promise<boolean[] | void> {
    return guard(
      entries.map(() => false),
      async () => {
        const { plain, raw } = viewsFor();
        const results = entries.map(() => true);
        const expired: string[] = [];
        const batches = {
          raw: [] as [string, unknown, SetOptions][],
          plain: [] as [string, unknown, SetOptions][],
        };
        const indexes = { raw: [] as number[], plain: [] as number[] };
        for (const [index, entry] of entries.entries()) {
          const write =
            entry.expires === undefined
              ? relative(entry.ttl)
              : fromExpires(entry.expires);
          if (write === undefined) {
            expired.push(entry.key);
            continue;
          }
          const lane = isSerialised(entry.value) ? "raw" : "plain";
          batches[lane].push([entry.key, entry.value, write]);
          indexes[lane].push(index);
        }
        if (expired.length > 0) {
          await plain.deleteMany(expired);
        }
        for (const lane of ["raw", "plain"] as const) {
          if (batches[lane].length === 0) {
            continue;
          }
          const stored = await (lane === "raw" ? raw : plain).setMany(
            batches[lane],
          );
          if (stored !== batches[lane].length) {
            for (const index of indexes[lane]) {
              results[index] = false;
            }
          }
        }
        return results;
      },
    );
  }

  async function deleteMany(keys: string[]): Promise<boolean>;
  async function deleteMany(keys: string[]): Promise<boolean[]>;
  async function deleteMany(keys: string[]): Promise<boolean | boolean[]> {
    if (absolute) {
      return guard(
        keys.map(() => false),
        async () => {
          const { plain } = viewsFor();
          return Promise.all(keys.map(async (key) => plain.delete(key)));
        },
      );
    }
    return guard(false, async () => {
      const deleted = await viewsFor().plain.deleteMany(keys);
      return deleted === new Set(keys).size;
    });
  }

  const store: BunCacheKeyvStore = {
    opts: { dialect: "bun-cache" },
    get namespace() {
      return keyvNamespace;
    },
    set namespace(value: string | undefined) {
      keyvNamespace = value === "" ? undefined : value;
    },
    get capabilities(): BunCacheKeyvStore["capabilities"] {
      absolute = true;
      const methods: BunCacheKeyvStore["capabilities"]["methods"] = {};
      for (const name of METHODS) {
        methods[name] =
          name === "iterator"
            ? { exists: false, methodType: "none" }
            : { exists: true, methodType: "async" };
      }
      return {
        compatible: true,
        store: "keyvStorage",
        methods,
        expires: true,
      };
    },
    on(event, listener) {
      if (event === "error") {
        listeners.add(listener);
        unsubscribe ??= cache.on("error", (payload) => {
          emitError(payload.error);
        });
      }
      return store;
    },
    async get<Value = unknown>(key: string) {
      return guard(
        undefined,
        async () => (await viewsFor().plain.get(key)) as Value | undefined,
      );
    },
    async getMany<Value = unknown>(keys: string[]) {
      return guard(
        keys.map(() => undefined),
        async () =>
          (await viewsFor().plain.getMany(keys)) as (Value | undefined)[],
      );
    },
    async set(key, value, ttlOrExpires) {
      return guard(false, async () => {
        const { plain, raw } = viewsFor();
        const write = absolute
          ? fromExpires(ttlOrExpires)
          : relative(ttlOrExpires);
        if (write === undefined) {
          await plain.delete(key);
          return true;
        }
        return (isSerialised(value) ? raw : plain).set(key, value, write);
      });
    },
    setMany,
    async delete(key) {
      return guard(false, async () => viewsFor().plain.delete(key));
    },
    deleteMany,
    async has(key) {
      return guard(false, async () => viewsFor().plain.has(key));
    },
    async hasMany(keys) {
      return guard(
        keys.map(() => false),
        async () =>
          (await viewsFor().plain.getMany(keys)).map(
            (value) => value !== undefined,
          ),
      );
    },
    async clear() {
      await guard(undefined, async () => viewsFor().plain.clear());
    },
    async disconnect() {
      unsubscribe?.();
      unsubscribe = undefined;
      await guard(undefined, async () => cache.close());
    },
  };
  return store;
}
