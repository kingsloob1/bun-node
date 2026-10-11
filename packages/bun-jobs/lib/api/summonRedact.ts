import type { SummonStatus } from "../summon/types";
import { overlapsByQueueOf } from "../summon/controller";

/**
 * Per-member redaction of a shared summon unit (`group.unit: "shared"`) for
 * a caller who may read only some of its queues (the user's Q4,
 * 2026-10-11): nothing names a queue the caller may not read. Used by the
 * summon routes (`queues.read`) and by the socket (`events.subscribe`).
 *
 * Internal: nothing here is exported from the package.
 */

/** The prefix of a partial unit's detail: `partial:<queue>,<queue>`. */
const PARTIAL = "partial:";

/**
 * A `partial:<queues>` detail rebuilt from the queues `readable` keeps, in
 * order: bare `partial` when it keeps none. Any other detail, or none, is
 * returned as it is.
 */
export function redactPartialDetail(
  /** The detail as the controller wrote it. */
  detail: string | undefined,
  /** Whether the caller may see a queue. */
  readable: (queue: string) => boolean,
): string | undefined {
  if (detail === undefined || !detail.startsWith(PARTIAL)) {
    return detail;
  }
  const kept = detail.slice(PARTIAL.length).split(",").filter(readable);
  return kept.length === 0 ? "partial" : `${PARTIAL}${kept.join(",")}`;
}

/**
 * A `summon` event's payload with nothing about a queue `readable` refuses:
 * `queues` and `missing` filtered (order kept; `missing` dropped when none
 * is left) and a `partial:` detail rebuilt. A payload naming no `queues` (a
 * controller of one queue) is returned as it is.
 */
export function redactSummonPayload<T extends Record<string, unknown>>(
  /** The event's payload. */
  payload: T,
  /** Whether the caller may see a queue. */
  readable: (queue: string) => boolean,
): T {
  if (!Array.isArray(payload.queues)) {
    return payload;
  }
  const out: Record<string, unknown> = {
    ...payload,
    queues: (payload.queues as unknown[]).filter(
      (queue) => typeof queue === "string" && readable(queue),
    ),
  };
  if (Array.isArray(payload.missing)) {
    const missing = (payload.missing as unknown[]).filter(
      (queue) => typeof queue === "string" && readable(queue),
    );
    if (missing.length === 0) {
      delete out.missing;
    } else {
      out.missing = missing;
    }
  }
  if (typeof payload.detail === "string") {
    out.detail = redactPartialDetail(payload.detail, readable);
  }
  return out as T;
}

/**
 * A summon status with nothing about a queue outside `readable`: for a
 * shared unit, `queues` filtered (order kept), `queue` the first left, each
 * pending attempt's `coverage` keeping only readable queues, and the last
 * outcome's `missing` filtered (dropped when none is left) and its
 * `partial:` detail rebuilt; for any controller,
 * `overlaps` keeps only the groups seen on readable queues. The caller must
 * keep at least one of its queues readable. A status naming no `queues`
 * keeps them as they are.
 * Its `group` is redacted apart (the routes' `redactGroup`).
 */
export function redactUnitStatus(
  /** The unit's status. */
  status: SummonStatus,
  /** The queues the caller may read. */
  readable: ReadonlySet<string>,
): SummonStatus {
  const filtered = withReadableOverlaps(status, readable);
  const queues = filtered.queues;
  return queues === undefined
    ? filtered
    : redactQueues({ ...filtered, queues }, readable);
}

/**
 * `status` with `overlaps` keeping only the groups seen on a queue in
 * `readable` (absent when none is left): a group summoning for a queue the
 * caller may not read is not the caller's to learn of. A status whose
 * overlaps cannot be traced to their queues keeps none (fails closed).
 */
function withReadableOverlaps(
  status: SummonStatus,
  readable: ReadonlySet<string>,
): SummonStatus {
  if (status.overlaps === undefined) {
    return status;
  }
  const kept = new Set<string>();
  for (const [queue, groups] of overlapsByQueueOf(status)) {
    if (readable.has(queue)) {
      for (const group of groups) {
        kept.add(group);
      }
    }
  }
  const { overlaps: _all, ...rest } = status;
  return kept.size === 0 ? rest : { ...rest, overlaps: [...kept].sort() };
}

/**
 * {@link redactUnitStatus}'s `queues`, `queue`, coverage, `missing` and
 * detail, for a status that has `queues`.
 */
function redactQueues(
  status: SummonStatus & { queues: readonly string[] },
  readable: ReadonlySet<string>,
): SummonStatus {
  const queues = status.queues.filter((queue) => readable.has(queue));
  const has = (queue: string): boolean => readable.has(queue);
  return {
    ...status,
    queue: queues[0] ?? status.queue,
    queues,
    pending: status.pending.map((attempt) => {
      if (attempt.coverage === undefined) {
        return attempt;
      }
      // Null-prototype, own keys only: `__proto__` is a valid queue name.
      const coverage = Object.create(null) as Record<
        string,
        "registered" | "pending" | "missing"
      >;
      for (const [queue, state] of Object.entries(attempt.coverage)) {
        if (has(queue)) {
          Object.defineProperty(coverage, queue, {
            value: state,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
      return { ...attempt, coverage };
    }),
    ...(status.last === undefined
      ? {}
      : { last: redactLast(status.last, has) }),
  };
}

/** A last outcome with its `missing` filtered (dropped when empty) and its `partial:` detail rebuilt. */
function redactLast(
  last: NonNullable<SummonStatus["last"]>,
  readable: (queue: string) => boolean,
): NonNullable<SummonStatus["last"]> {
  const { missing: all, ...rest } = last;
  const detail = redactPartialDetail(last.detail, readable);
  const missing = all?.filter(readable);
  return {
    ...rest,
    ...(detail === undefined ? {} : { detail }),
    ...(missing === undefined || missing.length === 0 ? {} : { missing }),
  };
}
