import type { JobsDriver, RunRecord } from "../drivers/index";
import { ConfigError, NotSupportedError } from "../shared/errors";

/**
 * How long a run whose record still says `running` counts as in progress when
 * nothing else vouches for it, in milliseconds: one day.
 *
 * A process that dies mid-run never settles its record, so without a bound a
 * crashed run would be "in progress" — and kept by every clear — for ever.
 * See {@link planHistoryClear} for what else keeps a run.
 */
export const DEFAULT_STALE_RUN_AFTER = 86_400_000;

/** Options for `BunRunner.clearHistory` and `RunnerController.clearHistory`. */
export interface ClearHistoryOptions {
  /**
   * How long a `running` record with nothing else vouching for it is still
   * treated as in progress, in milliseconds. Older than this, it is taken to
   * be a run whose process died, and is cleared with the finished ones.
   * Defaults to {@link DEFAULT_STALE_RUN_AFTER} (one day). A run this process
   * is executing is kept however old it is, and so is the run the runner's
   * live lock holder is executing.
   */
  staleAfter?: number;
}

/** What a history clear did. */
export interface ClearHistoryResult {
  /** How many finished (or abandoned) runs were removed, record and log. */
  removed: number;
  /**
   * The runs left in place because they are still in progress, newest first,
   * each with its record and its log whole. Empty when nothing was running.
   */
  kept: string[];
}

/** What {@link planHistoryClear} decides from. */
export interface HistoryClearInput {
  /** The runner's whole history, as `listHistory` answers it. */
  records: readonly RunRecord[];
  /**
   * Run ids executing in this process, when the runner is registered here —
   * `BunRunner.activeRuns`. Authoritative: each is kept whatever its record
   * says or however old it is.
   */
  local?: ReadonlySet<string> | ReadonlyMap<string, unknown>;
  /**
   * The run a live lock holder is executing: the runner's stored `lastRunId`
   * when its lock is held, otherwise `undefined`. A holder renews the lock
   * while its run lasts, so a held lock is evidence the run is alive.
   */
  lockedRunId?: string;
  /** Now, in epoch milliseconds. */
  now: number;
  /** See {@link ClearHistoryOptions.staleAfter}. */
  staleAfter: number;
}

/** Which runs a history clear removes, and which it keeps. */
export interface HistoryClearPlan {
  /** Runs to remove: finished, or `running` with nothing vouching for them. */
  remove: string[];
  /** Runs to keep because they are still in progress, newest first. */
  keep: string[];
}

/**
 * Decides which runs a history clear keeps: the ones still in progress.
 *
 * A run is **in progress**, and kept with its record and its log whole, when
 * any of these holds:
 *
 * 1. this process is executing it (`local`) — the only certain signal, and
 *    only available where the runner is registered;
 * 2. its record says `running` and the runner's lock is held with
 *    `lastRunId` naming it — a single-mode holder renews the lock while the
 *    run lasts, however long that is;
 * 3. its record says `running` and it started less than `staleAfter` ago.
 *
 * Everything else is removed: every settled run, and a `running` record none
 * of those vouch for — **a run whose process crashed**. Its record never
 * settles, so it keeps its `running` status for good; it stops being vouched
 * for once its lock expires (`lockTtl` after the crash) and once it is older
 * than `staleAfter`, and the next clear removes it. A parallel run holds no
 * lock, so for a run another process is executing the stored status and its
 * age are all there is: a live parallel run in another process older than
 * `staleAfter` is cleared, and its eventual settle then finds no record to
 * update. Raise `staleAfter` for runners whose runs legitimately last longer.
 *
 * A run a record does not name yet — one that started after the history was
 * read — is in neither list, so it is never removed: removal is by name.
 */
export function planHistoryClear(input: HistoryClearInput): HistoryClearPlan {
  const remove: string[] = [];
  const keep: string[] = [];

  for (const record of input.records) {
    const inProgress =
      input.local?.has(record.runId) === true ||
      (record.status === "running" &&
        (record.runId === input.lockedRunId ||
          input.now - record.startedAt < input.staleAfter));

    (inProgress ? keep : remove).push(record.runId);
  }

  return { remove, keep };
}

/**
 * Clears one runner's finished runs, record and log, keeping those still in
 * progress (see {@link planHistoryClear}). What `BunRunner.clearHistory` and
 * `RunnerController.clearHistory` both run; `local` is the executing process's
 * active runs when there is one.
 *
 * Throws `NotSupportedError` on a driver without `removeRuns`, rather than
 * falling back to `clearHistory`, which would drop the runs still going.
 */
export async function clearRunnerHistory(
  driver: JobsDriver,
  ns: string,
  key: string,
  options: ClearHistoryOptions & {
    /** Run ids executing in this process, when the runner is registered here. */
    local?: ReadonlyMap<string, unknown>;
  } = {},
): Promise<ClearHistoryResult> {
  if (typeof driver.removeRuns !== "function") {
    throw new NotSupportedError(driver.name, "removeRuns", {
      needs: "clearHistory()",
    });
  }

  const staleAfter = options.staleAfter ?? DEFAULT_STALE_RUN_AFTER;
  if (!Number.isFinite(staleAfter) || staleAfter < 0) {
    throw new ConfigError(
      `staleAfter must be a non-negative number of milliseconds, got ${staleAfter}`,
      { staleAfter },
    );
  }

  const now = Date.now();
  const [records, lock, state] = await Promise.all([
    driver.listHistory(ns, key),
    driver.getLock(ns, key, now),
    driver.getState(ns, key),
  ]);

  const plan = planHistoryClear({
    records,
    ...(options.local ? { local: options.local } : {}),
    ...(lock && state.lastRunId ? { lockedRunId: state.lastRunId } : {}),
    now,
    staleAfter,
  });

  const removed =
    plan.remove.length > 0 ? await driver.removeRuns(ns, key, plan.remove) : 0;

  return { removed, kept: plan.keep };
}
