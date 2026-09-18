/**
 * How the runner screens stay current. Today every read polls; M4's
 * WebSocket replaces this one module (an interval of `false` plus event
 * invalidations), and nothing else in the screens changes.
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
