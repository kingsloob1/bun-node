/**
 * A fleet of engines in one process sharing one bun-cache backend, each with
 * its own `Cache` and `cacheStore` over the same driver (bun-cache's memory
 * driver, wrapped in its `faulty()` so a test can take the store down): the
 * processes of topology (b), without the processes.
 */
import { createCache, memoryDriver } from "@kingsleyweb/bun-cache";
import { faulty } from "@kingsleyweb/bun-cache/testing";
import type { FaultyDriver } from "@kingsleyweb/bun-cache/testing";
import { createSecurity } from "../../lib/index";
import type {
  CreateSecurityOptions,
  Security,
  SecurityPolicy,
  SharedStateStore,
} from "../../lib/index";
import { cacheStore } from "../../lib/stores/index";
import type { CacheStoreOptions } from "../../lib/stores/index";

/** One engine of the fleet and its store. */
export interface Member {
  /** The engine. */
  readonly security: Security;
  /** Its shared store. */
  readonly store: SharedStateStore;
}

/** What {@link fleet} builds. */
export interface Fleet {
  /** The shared driver, whose faults a test sets. */
  readonly driver: FaultyDriver;
  /** The engines. */
  readonly members: readonly Member[];
  /** Adds an engine, as a process starting later would. */
  readonly add: (policy?: SecurityPolicy) => Member;
  /** Closes every engine and store. */
  readonly close: () => Promise<void>;
}

/** The secret every engine of a fleet shares (a shared store needs one). */
export const FLEET_SECRET = "the-fleet-secret-of-at-least-32-bytes";

/** A quiet logger. */
export const quiet = (): void => {};

/**
 * `n` engines on `policy` over one shared backend. The background intervals
 * default to an hour, so a test drives propagation with `flush()`, unless
 * it passes its own.
 */
export function fleet(
  n: number,
  policy: SecurityPolicy,
  options: {
    /** cacheStore's options. */
    readonly store?: CacheStoreOptions;
    /** createSecurity's options. */
    readonly security?: Partial<CreateSecurityOptions>;
    /** Give the stores the driver's bus. Default `true`. */
    readonly bus?: boolean;
  } = {},
): Fleet {
  const driver = faulty(memoryDriver());
  const members: Member[] = [];
  const add = (memberPolicy: SecurityPolicy = policy): Member => {
    const cache = createCache({ driver });
    const store = cacheStore(cache, {
      bus: options.bus === false ? false : driver,
      timeout: "2s",
      pollInterval: "1h",
      reconcileInterval: "1h",
      syncInterval: "1m",
      logger: quiet,
      ...options.store,
    });
    const security = createSecurity({
      policy: memberPolicy,
      store,
      secret: FLEET_SECRET,
      logger: quiet,
      ...options.security,
    });
    const member = { security, store };
    members.push(member);
    return member;
  };
  for (let i = 0; i < n; i++) add();
  return {
    driver,
    members,
    add,
    close: async () => {
      for (const member of members) {
        member.security.close();
        await member.security.flush();
        await member.store.close();
      }
    },
  };
}
