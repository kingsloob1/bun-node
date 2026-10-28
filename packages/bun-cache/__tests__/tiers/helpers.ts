/**
 * Helpers for the multi-tier tests (plan §4): an in-process {@link CacheBus}
 * hub whose deliveries, gaps and failures the test drives, and a driver
 * wrapper that holds an operation at a gate, for the races the L1's
 * generations exist to catch.
 */
import type { BusMessage, CacheBus, CacheDriver } from "../../lib/index";

/** One subscriber of the hub. */
interface HubSubscriber {
  /** The message callback. */
  onMessage: (message: BusMessage) => void;
  /** The gap callback. */
  onGap: () => void;
}

/** An in-process bus hub: every bus it makes delivers to every subscriber of every other, synchronously. */
export interface BusHub {
  /** A new bus on the hub. */
  bus: (name?: string) => CacheBus & {
    /** Whether `close()` ran on it. */
    readonly closed: boolean;
  };
  /** Every message published, in order. */
  readonly published: BusMessage[];
  /** Signals a gap to every subscriber. */
  gap: () => void;
  /** Makes the next `count` publishes reject. */
  failPublishes: (count: number) => void;
  /** Makes the next `count` subscribes reject. */
  failSubscribes: (count: number) => void;
  /** Holds the next subscribe at `at` until it opens. */
  holdSubscribes: (at: Gate) => void;
  /** How many subscriptions are live. */
  readonly subscribers: number;
}

/** Creates a {@link BusHub}. */
export function busHub(): BusHub {
  const subscribers = new Set<HubSubscriber>();
  const published: BusMessage[] = [];
  let publishFailures = 0;
  let subscribeFailures = 0;
  let subscribeGate: Gate | undefined;
  return {
    bus: (name = "hub") => {
      let closed = false;
      return {
        name,
        get closed() {
          return closed;
        },
        publish: (message) => {
          if (publishFailures > 0) {
            publishFailures--;
            return Promise.reject(new Error("injected publish failure"));
          }
          // Through JSON, as every real bus carries it.
          published.push(JSON.parse(JSON.stringify(message)) as BusMessage);
          for (const subscriber of [...subscribers]) {
            subscriber.onMessage(
              JSON.parse(JSON.stringify(message)) as BusMessage,
            );
          }
          return Promise.resolve();
        },
        subscribe: async (onMessage, onGap) => {
          if (subscribeFailures > 0) {
            subscribeFailures--;
            throw new Error("injected subscribe failure");
          }
          const at = subscribeGate;
          subscribeGate = undefined;
          await at?.wait();
          const subscriber = { onMessage, onGap };
          subscribers.add(subscriber);
          return () => {
            subscribers.delete(subscriber);
            return Promise.resolve();
          };
        },
        close: () => {
          closed = true;
          return Promise.resolve();
        },
      };
    },
    published,
    gap: () => {
      for (const subscriber of [...subscribers]) {
        subscriber.onGap();
      }
    },
    failPublishes: (count) => {
      publishFailures = count;
    },
    failSubscribes: (count) => {
      subscribeFailures = count;
    },
    holdSubscribes: (at) => {
      subscribeGate = at;
    },
    get subscribers() {
      return subscribers.size;
    },
  };
}

/** A gate: `wait()` parks until `open()`. */
export interface Gate {
  /** Parks the caller until the gate opens. */
  wait: () => Promise<void>;
  /** Opens it (and re-arms it for the next `wait`). */
  open: () => void;
  /** Resolves once something is parked at it. */
  reached: () => Promise<void>;
}

/** A one-shot gate, re-armed on each `open()`. */
export function gate(): Gate {
  let release: (() => void) | undefined;
  let arrived: (() => void) | undefined;
  let arrival = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  return {
    wait: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
        arrived?.();
      });
    },
    open: () => {
      const run = release;
      release = undefined;
      arrival = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      run?.();
    },
    reached: async () => {
      await arrival;
    },
  };
}

/**
 * A driver that forwards every call to `inner` (bound to it, so a class
 * driver's private fields still resolve), except the `overrides`.
 */
function forwarding<T extends object>(
  inner: CacheDriver,
  overrides: Partial<CacheDriver> & T,
): CacheDriver & T {
  return new Proxy(inner, {
    get: (target, property, receiver) => {
      if (property in overrides) {
        return (overrides as Record<string | symbol, unknown>)[property];
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as CacheDriver & T;
}

/**
 * Wraps a driver so the next `get` / `set` that `hold` names finishes its
 * real work and then parks at the gate before answering — so the test can
 * land an invalidation between the L2 operation and its L1 copy.
 */
export function gatedDriver(inner: CacheDriver): CacheDriver & {
  /** Holds the next call of `op` at `at`. */
  hold: (op: "get" | "set", at: Gate) => void;
} {
  const held = new Map<"get" | "set", Gate>();
  const take = (op: "get" | "set"): Gate | undefined => {
    const at = held.get(op);
    held.delete(op);
    return at;
  };
  return forwarding(inner, {
    get: async (ns: string, key: string) => {
      const at = take("get");
      const result = await inner.get(ns, key);
      await at?.wait();
      return result;
    },
    set: async (
      ns: string,
      entry: Parameters<CacheDriver["set"]>[1],
      fence?: Parameters<CacheDriver["set"]>[2],
    ) => {
      const at = take("set");
      const result = await inner.set(ns, entry, fence);
      await at?.wait();
      return result;
    },
    hold: (op: "get" | "set", at: Gate) => {
      held.set(op, at);
    },
  });
}

/** Counts a driver's `get`/`getMany` calls (the L2 reads an L1 hit must not make). */
export function countingDriver(inner: CacheDriver): CacheDriver & {
  /** L2 reads so far: one per `get`, one per key of a `getMany`. */
  readonly reads: () => number;
} {
  let reads = 0;
  return forwarding(inner, {
    get: async (ns: string, key: string) => {
      reads++;
      return await inner.get(ns, key);
    },
    getMany: async (ns: string, keys: readonly string[]) => {
      reads += keys.length;
      return await inner.getMany(ns, keys);
    },
    reads: () => reads,
  });
}

/** Waits until `condition` holds, checking every 5 ms; throws after `timeoutMs`. */
export async function waitFor(
  what: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${what}`);
    }
    await Bun.sleep(5);
  }
}
