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

/**
 * The fewest records a store holds: `createRemoteExecutorStore()`'s default,
 * and the floor of the size an executor gives its own.
 */
export const MIN_STORE_RECORDS = 10_000;
/** The most records an executor writes per attempt: the attempt, its `status` alias, and the job's fence. */
export const RECORDS_PER_ATTEMPT = 3;
/** The turnover the default size is built for: one attempt per slot per second. */
export const ATTEMPTS_PER_SLOT_PER_SECOND = 1;
/** Evictions within this long of a report are summed into the next one, in ms. */
export const EVICTION_REPORT_INTERVAL_MS = 60_000;

/**
 * The size of the store an executor builds for itself: every record its
 * attempts write within one `idempotencyTtl`, when each of its
 * `maxConcurrency` slots finishes one attempt a second —
 * `3 × maxConcurrency × ⌈ttl / 1 s⌉`, and never under 10,000. The defaults
 * (64 slots, 600 s) give 115,200 records.
 *
 * One attempt per slot per second is the rate a remote executor sees when an
 * attempt costs at least a network round trip plus real work; faster turnover
 * outruns it, and the store says so (`onEvict`) rather than silently
 * forgetting. A record is a few hundred bytes plus the outcome it keeps, so
 * the default is tens of megabytes at most.
 */
export function remoteExecutorStoreCapacity(
  maxConcurrency: number,
  idempotencyTtl: number,
): number {
  return Math.max(
    MIN_STORE_RECORDS,
    RECORDS_PER_ATTEMPT *
      maxConcurrency *
      ATTEMPTS_PER_SLOT_PER_SECOND *
      Math.ceil(idempotencyTtl / 1_000),
  );
}

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
 *
 * Past `max`, the oldest record is forgotten even though it has not expired:
 * its attempt can then run twice, and its job's fence is lost. That is
 * reported through `onEvict`, at once and then at most once a minute with the
 * count since.
 */
export function createRemoteExecutorStore(
  options?: RemoteExecutorStoreOptions,
): RemoteExecutorStore {
  const max = options?.max ?? MIN_STORE_RECORDS;
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new ConfigError(
      "A remote executor store's max must be a positive integer",
      { max },
    );
  }
  const onEvict = options?.onEvict;
  if (onEvict !== undefined && typeof onEvict !== "function") {
    throw new ConfigError(
      "A remote executor store's onEvict must be a function",
    );
  }
  /** Every record held, oldest write first. */
  const held = new Map<string, Held>();
  /** Unexpired records evicted since the last report. */
  let evicted = 0;
  /** When the last report was made, on the store's clock; `undefined` before the first. */
  let reportedAt: number | undefined;

  /** Counts one unexpired eviction, reporting the burst when it is due. */
  const evict = (now: number): void => {
    evicted++;
    if (
      onEvict !== undefined &&
      (reportedAt === undefined ||
        now - reportedAt >= EVICTION_REPORT_INTERVAL_MS)
    ) {
      const count = evicted;
      evicted = 0;
      reportedAt = now;
      try {
        onEvict(count);
      } catch {
        // A failing report must not fail the write.
      }
    }
  };

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
      if (until <= now) {
        held.delete(oldest);
      } else if (held.size > max) {
        held.delete(oldest);
        evict(now);
      } else {
        break;
      }
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
