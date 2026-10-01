/**
 * The executor's in-memory store (`worker-runtimes.md` §5.8): idempotency
 * records and fences, bounded, expiring.
 *
 * Browser-safe: imports only the package's error types.
 */

import type {
  RemoteExecutorRecord,
  RemoteExecutorStore,
  RemoteExecutorStoreOptions,
} from "./types";
import { ConfigError } from "../../shared/errors";

/** The built-in store's default size. */
const DEFAULT_MAX = 10_000;

/** One stored record and when it may be forgotten. */
interface Held {
  /** The record. */
  record: RemoteExecutorRecord;
  /** Epoch ms after which it is gone. */
  expiresAt: number;
}

/**
 * A bounded in-memory {@link RemoteExecutorStore}. `update` is atomic: it runs
 * synchronously, so no other call interleaves. Records are held in write
 * order; each write moves its key to the back, and expired records are
 * dropped from the front as new ones arrive, so the work per call is
 * constant, never a sweep.
 */
export function createRemoteExecutorStore(
  options?: RemoteExecutorStoreOptions,
): RemoteExecutorStore {
  const max = options?.max ?? DEFAULT_MAX;
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new ConfigError(
      "A remote executor store's max must be a positive integer",
      { max },
    );
  }
  /** Every record held, oldest write first. */
  const held = new Map<string, Held>();

  /** The live record under `key`, dropping it when expired. */
  const read = (key: string, now: number): RemoteExecutorRecord | undefined => {
    const found = held.get(key);
    if (found === undefined) {
      return undefined;
    }
    if (found.expiresAt <= now) {
      held.delete(key);
      return undefined;
    }
    return found.record;
  };

  /** Writes at the back, then trims expired and excess records from the front. */
  const write = (
    key: string,
    record: RemoteExecutorRecord,
    expiresAt: number,
    now: number,
  ): void => {
    held.delete(key);
    held.set(key, { record, expiresAt });
    for (const [oldest, { expiresAt: until }] of held) {
      if (until > now && held.size <= max) {
        break;
      }
      held.delete(oldest);
    }
  };

  return {
    get: read,
    set: write,
    update(key, change, now) {
      const before = read(key, now);
      const next = change(before);
      if (next !== null) {
        write(key, next.record, next.expiresAt, now);
      }
      return before;
    },
  };
}
