/**
 * `faultyStore(store, options)` (storage.md §9): a security store that
 * fails on demand — chosen operations reject, or answer late — for testing
 * what an engine does when its store degrades. Everything else is the
 * wrapped store's.
 */
import type { SecurityStoreDriver } from "../store/types";

/** The operations a faulty store can fail. */
export type StoreOperation =
  | "connect"
  | "get"
  | "list"
  | "put"
  | "delete"
  | "appendVersion"
  | "getVersion"
  | "listVersions"
  | "putBundle"
  | "getBundle"
  | "appendAudit"
  | "getAuditHead"
  | "listAudit"
  | "appendCheckpoint"
  | "listCheckpoints"
  | "deleteAuditBefore"
  | "incrementCounter"
  | "getCounter"
  | "resetCounter"
  | "claimKey"
  | "changesSince"
  | "appendEvents"
  | "addCounters"
  | "listEvents"
  | "series"
  | "topK"
  | "rollup"
  | "deleteBefore";

/** Options for {@link faultyStore}. */
export interface FaultyStoreOptions {
  /**
   * Whether an operation fails now: answer an `Error` to reject it with,
   * or `undefined` to let it through. Asked on every call, so a test can
   * turn failures on and off.
   */
  readonly fail?: (operation: StoreOperation) => Error | undefined;
  /** Milliseconds every operation waits before it runs. Default 0. */
  readonly delayMs?: number;
}

/** The wrapped store, failing as `options` say; see the module's description. */
export function faultyStore(
  store: SecurityStoreDriver,
  options: FaultyStoreOptions,
): SecurityStoreDriver {
  /** Wraps one operation. */
  const wrap =
    <TArgs extends unknown[], TResult>(
      operation: StoreOperation,
      run: (...args: TArgs) => Promise<TResult>,
    ) =>
    async (...args: TArgs): Promise<TResult> => {
      if (options.delayMs !== undefined && options.delayMs > 0) {
        await Bun.sleep(options.delayMs);
      }
      const error = options.fail?.(operation);
      if (error !== undefined) throw error;
      return await run(...args);
    };
  return Object.freeze({
    ...store,
    name: `faulty(${store.name})`,
    connect: wrap("connect", store.connect),
    get: wrap("get", store.get),
    list: wrap("list", store.list),
    put: wrap("put", store.put),
    delete: wrap("delete", store.delete),
    appendVersion: wrap("appendVersion", store.appendVersion),
    getVersion: wrap("getVersion", store.getVersion),
    listVersions: wrap("listVersions", store.listVersions),
    putBundle: wrap("putBundle", store.putBundle),
    getBundle: wrap("getBundle", store.getBundle),
    appendAudit: wrap("appendAudit", store.appendAudit),
    getAuditHead: wrap("getAuditHead", store.getAuditHead),
    listAudit: wrap("listAudit", store.listAudit),
    appendCheckpoint: wrap("appendCheckpoint", store.appendCheckpoint),
    listCheckpoints: wrap("listCheckpoints", store.listCheckpoints),
    deleteAuditBefore: wrap("deleteAuditBefore", store.deleteAuditBefore),
    incrementCounter: wrap("incrementCounter", store.incrementCounter),
    getCounter: wrap("getCounter", store.getCounter),
    resetCounter: wrap("resetCounter", store.resetCounter),
    claimKey: wrap("claimKey", store.claimKey),
    changesSince: wrap("changesSince", store.changesSince),
    // The analytics operations, where the store has them.
    ...(store.appendEvents === undefined
      ? {}
      : { appendEvents: wrap("appendEvents", store.appendEvents) }),
    ...(store.addCounters === undefined
      ? {}
      : { addCounters: wrap("addCounters", store.addCounters) }),
    ...(store.listEvents === undefined
      ? {}
      : { listEvents: wrap("listEvents", store.listEvents) }),
    ...(store.series === undefined
      ? {}
      : { series: wrap("series", store.series) }),
    ...(store.topK === undefined ? {} : { topK: wrap("topK", store.topK) }),
    ...(store.rollup === undefined
      ? {}
      : { rollup: wrap("rollup", store.rollup) }),
    ...(store.deleteBefore === undefined
      ? {}
      : { deleteBefore: wrap("deleteBefore", store.deleteBefore) }),
  });
}
