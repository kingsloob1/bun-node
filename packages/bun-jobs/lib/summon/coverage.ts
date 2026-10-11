import type { JobsDriver, WorkerInfo } from "../drivers/index";
import type { Logger } from "../shared/logger";
import type { SummonClaim } from "./claim";
import type { PendingSummon } from "./types";
import { listWorkerRecords } from "../drivers/index";
import {
  liveWithId,
  readSummonClaims,
  START_TIME_SLACK,
  tallySummonClaim,
} from "./claim";
import { setOwn } from "./group";

/**
 * A shared unit's per-queue coverage of each attempt in flight
 * (`PendingSummon.coverage`, plan summon-multi-queue B4): how far the
 * attempt has got on each queue the unit serves, by the same evidence the
 * controller's check reads — each queue's claim of the attempt and its live
 * worker records.
 *
 * Worked out each time a status is read, by the reading process's clock,
 * and never written: the controller's own decision, on its own clock, is
 * what lands in the marker's `last`. The local status (`controller.status()`)
 * and a status read from storage (`local: false`) use the same function.
 *
 * Internal: nothing here is exported from the package.
 */

/** One queue's state for one attempt. */
export type QueueCoverage = "registered" | "pending" | "missing";

/**
 * One attempt's coverage on each of `members`, as of `now`:
 *
 * - `"registered"`: a holder of the attempt's claim on that queue ran (live,
 *   or gone with a clean exit mark), or — with no claim there — a live record
 *   on that queue carries the attempt's id. The controller's own test.
 * - `"missing"`: not registered, no holder still inside its grace, and `now`
 *   is at or past the attempt's `until` plus the clock allowance
 *   ({@link START_TIME_SLACK}) the controller grants every comparison
 *   between processes, so a skew under it never shows a queue as missing
 *   that the controller still counts as on its way.
 * - `"pending"`: otherwise — including a holder that claimed and has no
 *   record yet, and one that died before `until`.
 *
 * A null-prototype record with every queue an own key: `__proto__` is a
 * valid queue name.
 */
export function coverageOf(
  /** The attempt. */
  attempt: Pick<PendingSummon, "id" | "until">,
  /** The unit's queues, in its policy's order. */
  members: readonly string[],
  /** Each queue's claim of the attempt, by queue; absent is none. */
  claims: ReadonlyMap<string, SummonClaim | undefined>,
  /** Each queue's live worker records, by queue; absent is none. */
  workers: ReadonlyMap<string, readonly WorkerInfo[]>,
  /** Now, epoch ms, by the reading process's clock. */
  now: number,
): Readonly<Record<string, QueueCoverage>> {
  const coverage = Object.create(null) as Record<string, QueueCoverage>;
  for (const queue of members) {
    const records = workers.get(queue) ?? [];
    const claim = claims.get(queue);
    const tally = tallySummonClaim(
      claim,
      new Set(records.map((worker) => worker.id)),
      now,
      START_TIME_SLACK,
      attempt.until,
    );
    const registered =
      claim === undefined
        ? liveWithId(records, attempt.id) > 0
        : tally.succeeded > 0;
    setOwn(
      coverage,
      queue,
      registered
        ? "registered"
        : tally.starting === 0 && now >= attempt.until + START_TIME_SLACK
          ? "missing"
          : "pending",
    );
  }
  return coverage;
}

/**
 * Each attempt of `pending` with its `coverage` on `members`, as copies (the
 * marker's own entries are never changed): one claim read per attempt per
 * queue and one listing of live records per queue, all in parallel, and no
 * read at all when nothing is pending. A shared unit refuses a platform that
 * passes no identity, so its claims are always read.
 *
 * **Best effort.** Coverage is a display value: when any of those reads
 * fails, the attempts are answered as they are, with no `coverage`, and
 * `onError` hears why — a status read never fails for it.
 */
export async function withCoverage(
  driver: JobsDriver,
  /** The unit's namespace. */
  namespace: string,
  /** The unit's queues, in its policy's order. */
  members: readonly string[],
  /** The attempts in flight. */
  pending: readonly PendingSummon[],
  /** Now, epoch ms, by the reading process's clock. */
  now: number,
  /** Told of a failed read, after which coverage is left out. */
  onError?: (error: unknown) => void,
): Promise<PendingSummon[]> {
  if (pending.length === 0) {
    return [];
  }
  const ids = pending.map((attempt) => attempt.id);
  let perQueue: {
    queue: string;
    claims: Map<string, SummonClaim | undefined>;
    workers: WorkerInfo[];
  }[];
  try {
    perQueue = await Promise.all(
      members.map(async (queue) => {
        const ref = { ns: namespace, queue };
        const [claims, workers] = await Promise.all([
          readSummonClaims(driver, ref, ids),
          listWorkerRecords(driver, ref, now),
        ]);
        return { queue, claims, workers };
      }),
    );
  } catch (error) {
    onError?.(error);
    return [...pending];
  }
  const workers = new Map(perQueue.map((one) => [one.queue, one.workers]));
  return pending.map((attempt) => ({
    ...attempt,
    coverage: coverageOf(
      attempt,
      members,
      new Map(perQueue.map((one) => [one.queue, one.claims.get(attempt.id)])),
      workers,
      now,
    ),
  }));
}

/** How often a failed coverage read is logged, at most, per logger: once a minute. */
export const COVERAGE_WARN_EVERY_MS = 60_000;

/** When each logger last warned of a failed coverage read. */
const WARNED_AT = new WeakMap<Logger, number>();

/**
 * An `onError` for {@link withCoverage} that warns on `logger` at most once
 * per {@link COVERAGE_WARN_EVERY_MS}: a status polled every few seconds
 * against a failing backend logs once a minute, not once a poll.
 */
export function coverageWarner(
  logger: Logger,
  /** Fields added to the warning (a queue, a group). */
  fields: Record<string, unknown> = {},
): (error: unknown) => void {
  return (error) => {
    const now = Date.now();
    const last = WARNED_AT.get(logger);
    if (last !== undefined && now - last < COVERAGE_WARN_EVERY_MS) {
      return;
    }
    WARNED_AT.set(logger, now);
    logger.warn(
      "could not read a shared summon unit's claims or worker records; its status is shown without coverage",
      { ...fields, error },
    );
  };
}
