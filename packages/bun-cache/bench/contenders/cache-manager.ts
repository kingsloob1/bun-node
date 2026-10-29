import type {
  Backend,
  CacheContender,
  CacheHandle,
  Scenario,
} from "../lib/types";
import { createCache } from "cache-manager";
import { KEYV_BACKENDS, keyvFor } from "./keyv-stores";

/**
 * cache-manager 7.2.9 over Keyv 5.6.0 and the matching Keyv store — the
 * stack `@nestjs/cache-manager` builds (plan §10.4). Its `wrap()` is
 * single-flight inside one process only.
 */

/** What cache-manager answers: get/set, its `mget`/`mset`, and `wrap` for the stampede. */
const SCENARIOS: readonly Scenario[] = [
  "get-hit-100b",
  "get-hit-10kb",
  "get-hit-1mb",
  "get-miss",
  "set-100b",
  "set-10kb",
  "set-1mb",
  "get-many-100",
  "set-many-100",
  "stampede",
];

/** The display name of each backend's Keyv store. */
const STORE_LABEL: Partial<Record<Backend, string>> = {
  memory: "Keyv Map",
  redis: "@keyv/redis",
  postgres: "@keyv/postgres",
  mysql: "@keyv/mysql",
  mariadb: "@keyv/mysql",
  mongodb: "@keyv/mongo",
};

/** The default TTL every contender stores with, in ms. */
const TTL = 600_000;

/** Builds the cache-manager contender for one backend. */
function contender(backend: Backend): CacheContender {
  return {
    id: `cache-manager-${backend}`,
    label: `cache-manager + ${STORE_LABEL[backend]}`,
    backend,
    scenarios: SCENARIOS,
    note:
      backend === "memory"
        ? "cache-manager over Keyv's default Map store, which keeps values as Keyv's JSON envelope (so a hit is a JSON.parse)."
        : undefined,
    setup: (ctx): CacheHandle => {
      const { keyv, close } = keyvFor(backend, ctx, "cm");
      const cache = createCache({ stores: [keyv], ttl: TTL });
      return {
        get: (key) => cache.get(key),
        set: async (key, value) => {
          await cache.set(key, value, TTL);
        },
        getMany: (keys) => cache.mget([...keys]),
        setMany: async (entries) => {
          await cache.mset(
            entries.map(([key, value]) => ({ key, value, ttl: TTL })),
          );
        },
        getOrSet: (key, loader) => cache.wrap(key, loader, TTL),
        close,
      };
    },
  };
}

/** Every cache-manager contender, one per backend with a Keyv store. */
export function cacheManagerContenders(): CacheContender[] {
  return [...KEYV_BACKENDS].map((backend) => contender(backend));
}
