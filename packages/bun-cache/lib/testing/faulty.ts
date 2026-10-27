/**
 * `faulty` (plan §13.1): a fault-injection wrapper around a driver, for
 * testing the failure policy, the circuit and timeouts —
 * `faulty(inner, { down: true })` makes every operation throw,
 * `failOn: ["set"]` fails writes only, `hangMs` holds an operation open, and
 * `lagMs` slows it.
 */
import type {
  BusMessage,
  CacheDriver,
  SchemaChange,
  SchemaSyncOptions,
} from "../core/types";

/** What {@link faulty} injects. */
export interface FaultOptions {
  /** The probability any one operation fails, 0–1. Defaults to 0. */
  failRate?: number;
  /** Operation names that always fail (`"get"`, `"set"`, `"increment"`, …). Defaults to none. */
  failOn?: readonly string[];
  /** Operations take this long before delegating, in ms. Pairs with the cache's `timeout` to test timeouts. Defaults to 0. */
  hangMs?: number;
  /** Operations are delayed by this long, in ms, but then run normally. Defaults to 0. */
  lagMs?: number;
  /** Every operation fails. Defaults to `false`. */
  down?: boolean;
}

/** The driver {@link faulty} returns: the inner driver's contract, plus a way to change the faults mid-test. */
export interface FaultyDriver extends CacheDriver {
  /** Replaces the fault options (a test flips `down` to watch the circuit open and close). */
  setFaults: (options: FaultOptions) => void;
}

/** The error an injected failure throws. */
export class InjectedFaultError extends Error {
  /** The operation that was failed. */
  readonly op: string;

  constructor(/** The operation that was failed. */ op: string) {
    super(`faulty driver: injected failure on ${op}`);
    this.name = "InjectedFaultError";
    this.op = op;
  }
}

/** See the module header. */
export function faulty(
  inner: CacheDriver,
  options: FaultOptions = {},
): FaultyDriver {
  let faults = { ...options };

  /** Runs `op`, or fails/delays/hangs it as the faults say. */
  async function run<T>(op: string, call: () => Promise<T>): Promise<T> {
    if (faults.down === true || faults.failOn?.includes(op) === true) {
      throw new InjectedFaultError(op);
    }
    if (faults.failRate !== undefined && Math.random() < faults.failRate) {
      throw new InjectedFaultError(op);
    }
    if (faults.hangMs !== undefined && faults.hangMs > 0) {
      await Bun.sleep(faults.hangMs);
    }
    if (faults.lagMs !== undefined && faults.lagMs > 0) {
      await Bun.sleep(faults.lagMs);
    }
    return await call();
  }

  const driver: FaultyDriver = {
    name: `faulty(${inner.name})`,
    get capabilities() {
      return inner.capabilities;
    },
    setFaults(next: FaultOptions) {
      faults = { ...next };
    },
    async connect() {
      await run("connect", async () => await inner.connect?.());
    },
    async close() {
      await inner.close();
    },
    get: (ns, key) => run("get", async () => await inner.get(ns, key)),
    getMany: (ns, keys) =>
      run("getMany", async () => await inner.getMany(ns, keys)),
    set: (ns, entry, fence) =>
      run("set", async () => await inner.set(ns, entry, fence)),
    setMany: (ns, entries) =>
      run("setMany", async () => await inner.setMany(ns, entries)),
    delete: (ns, keys) =>
      run("delete", async () => await inner.delete(ns, keys)),
    clear: (ns) => run("clear", async () => await inner.clear(ns)),
    getStamps: (ns, tags) =>
      run("getStamps", async () => await inner.getStamps(ns, tags)),
    setStamps: (ns, tags, at, until) =>
      run("setStamps", async () => await inner.setStamps(ns, tags, at, until)),
  };

  if (inner.ping !== undefined) {
    driver.ping = () => run("ping", async () => await inner.ping!());
  }
  if (inner.touch !== undefined) {
    driver.touch = (ns: string, key: string, expiresAt: number | null) =>
      run("touch", async () => await inner.touch!(ns, key, expiresAt));
  }
  if (inner.deleteByTags !== undefined) {
    driver.deleteByTags = (
      ns: string,
      tags: readonly string[],
      stampUntil: number,
    ) =>
      run(
        "deleteByTags",
        async () => await inner.deleteByTags!(ns, tags, stampUntil),
      );
  }
  if (inner.increment !== undefined) {
    driver.increment = (
      ns: string,
      key: string,
      by: number,
      expiresAt: number | null,
    ) =>
      run(
        "increment",
        async () => await inner.increment!(ns, key, by, expiresAt),
      );
  }
  if (inner.getCounter !== undefined) {
    driver.getCounter = (ns: string, key: string) =>
      run("getCounter", async () => await inner.getCounter!(ns, key));
  }
  if (inner.acquireLock !== undefined) {
    driver.acquireLock = (
      ns: string,
      key: string,
      owner: string,
      ttlMs: number,
    ) =>
      run(
        "acquireLock",
        async () => await inner.acquireLock!(ns, key, owner, ttlMs),
      );
  }
  if (inner.releaseLock !== undefined) {
    driver.releaseLock = (ns: string, key: string, owner: string) =>
      run("releaseLock", async () => await inner.releaseLock!(ns, key, owner));
  }
  if (inner.sweep !== undefined) {
    driver.sweep = (now: number, limit: number) =>
      run("sweep", async () => await inner.sweep!(now, limit));
  }
  if (inner.publish !== undefined) {
    driver.publish = (message: BusMessage) =>
      run("publish", async () => await inner.publish!(message));
  }
  if (inner.subscribe !== undefined) {
    driver.subscribe = (onMessage, onGap) =>
      run("subscribe", async () => await inner.subscribe!(onMessage, onGap));
  }
  if (inner.syncSchema !== undefined) {
    driver.syncSchema = (
      syncOptions?: SchemaSyncOptions,
    ): Promise<SchemaChange[]> =>
      run("syncSchema", async () => await inner.syncSchema!(syncOptions));
  }
  if (inner.onEviction !== undefined) {
    driver.onEviction = (listener) => inner.onEviction!(listener);
  }
  return driver;
}
