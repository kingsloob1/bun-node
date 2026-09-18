import { useCallback } from "react";
import { runnerKeys } from "../../api/runners";
import { liveChannels, useLiveInvalidation, usePollInterval } from "../../live";

/**
 * How the runner screens stay current: runner events invalidate the reads
 * they change ({@link useRunnerListLive}, {@link useRunnerLive}), and every
 * read also polls — at the base intervals below while live updates are off,
 * much slower while they are live (`usePollInterval`).
 */
export const RUNNER_REFRESH = {
  /** The runner list: statuses change rarely. */
  list: 10_000,
  /** One runner's detail and stats while a run is in flight. */
  busy: 5_000,
  /** One runner's detail and stats while nothing runs. */
  idle: 15_000,
  /** The run history. */
  history: 15_000,
} as const satisfies Record<string, number | false>;

/** What decides how often a runner's detail and stats are re-read. */
export interface RunnerActivity {
  /** `RunnerInfoDto.isRunning`: a run is in flight anywhere. */
  isRunning?: boolean;
  /** `RunnerInfoDto.local`, when the runner is registered in the API's process. */
  local?: {
    /** Runs in flight in that process. */
    activeRuns: readonly unknown[];
  };
}

/**
 * Whether a runner has a run in flight: `isRunning`, or an active run in this
 * process. Not `local.status === "running"`, which only means started.
 */
export function isBusy(runner: RunnerActivity | undefined): boolean {
  if (!runner) {
    return false;
  }
  return (
    runner.isRunning === true || (runner.local?.activeRuns.length ?? 0) > 0
  );
}

/** The refetch interval of a runner's detail and stats: {@link RUNNER_REFRESH.busy} while running, else {@link RUNNER_REFRESH.idle}. */
export function runnerRefetchInterval(
  runner: RunnerActivity | undefined,
): number | false {
  return isBusy(runner) ? RUNNER_REFRESH.busy : RUNNER_REFRESH.idle;
}

/** The refetch interval of the runner list. */
export function listRefetchInterval(): number | false {
  return RUNNER_REFRESH.list;
}

/** The refetch interval of a runner's history. */
export function historyRefetchInterval(): number | false {
  return RUNNER_REFRESH.history;
}

/** {@link runnerRefetchInterval}, relaxed while live updates are on. */
export function useRunnerRefetchInterval(): (
  runner: RunnerActivity | undefined,
) => number | false {
  const busy = usePollInterval(RUNNER_REFRESH.busy);
  const idle = usePollInterval(RUNNER_REFRESH.idle);
  return useCallback((runner) => (isBusy(runner) ? busy : idle), [busy, idle]);
}

/** {@link listRefetchInterval}, relaxed while live updates are on. */
export function useListRefetchInterval(): number | false {
  return usePollInterval(listRefetchInterval());
}

/** {@link historyRefetchInterval}, relaxed while live updates are on. */
export function useHistoryRefetchInterval(): number | false {
  return usePollInterval(historyRefetchInterval());
}

/** The Runners list's live updates: any event on `runners` refreshes every runner list. */
export function useRunnerListLive(enabled: boolean): void {
  useLiveInvalidation([liveChannels.runners], [runnerKeys.all], { enabled });
}

/**
 * One runner's live updates, on `runner/<id>`: any of its events (a run
 * started or ended, a control) refreshes its detail, stats and history,
 * which all sit under its key.
 */
export function useRunnerLive(id: string, enabled: boolean): void {
  useLiveInvalidation([liveChannels.runner(id)], [runnerKeys.runner(id)], {
    enabled,
  });
}
