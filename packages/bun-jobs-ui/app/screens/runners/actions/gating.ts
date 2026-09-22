import type { JobsApiAction } from "../../../api/contract";
import type { RunnerInfoDto } from "../../../api/types";

/** Which runner actions are offered. */
export interface RunnerActionGates {
  /** `runners.trigger`. */
  trigger: boolean;
  /** `runners.pause`, on a running (not paused) runner. */
  pause: boolean;
  /** `runners.resume`, on a paused runner. */
  resume: boolean;
  /** `runners.reschedule`. */
  reschedule: boolean;
  /**
   * `runners.configure`, on a runner that reports a `config`. The action is
   * opt-in (a host must name it in `actions`), so its absence from the
   * permissions map is the normal case, not a fault; a runner without
   * `config` comes from a deployment that predates remote configuration.
   */
  configure: boolean;
  /** `runners.kill`, on a local runner with a run in flight in this process. */
  kill: boolean;
  /** `runners.resetStats`, on a local runner. */
  resetStats: boolean;
  /**
   * `runners.clearHistory`, on any runner: it works on what the backend
   * stores, so a runner registered in another process qualifies too.
   */
  clearHistory: boolean;
  /** The caller could kill or reset stats, but the runner is registered only in another process. */
  remoteOnly: boolean;
}

/**
 * Whether a local runner has a run in flight in this process. Only
 * `local.activeRuns` says so: `local.status` is the instance's lifecycle
 * (`"running"` means started and not paused, even with nothing in flight).
 */
export function hasLocalRuns(runner: RunnerInfoDto): boolean {
  return runner.isLocal && (runner.local?.activeRuns.length ?? 0) > 0;
}

/**
 * The actions to offer for `runner`, given a predicate that is true only
 * for a permitted action on a writable API (`useCanMutate`). Kill and stats
 * reset need the runner registered in the API's process (anything else is
 * 409 `RUNNER_NOT_LOCAL`), so they are not offered for a remote one.
 * Configuring needs the runner to report a `config`; without one the API
 * answers 409 `RUNNER_NOT_CONFIGURABLE`. Clearing the history needs neither.
 */
export function runnerActionGates(
  runner: RunnerInfoDto,
  canMutate: (action: JobsApiAction) => boolean,
): RunnerActionGates {
  const canKill = canMutate("runners.kill");
  const canReset = canMutate("runners.resetStats");
  return {
    trigger: canMutate("runners.trigger"),
    pause: !runner.isPaused && canMutate("runners.pause"),
    resume: runner.isPaused && canMutate("runners.resume"),
    reschedule: canMutate("runners.reschedule"),
    configure: runner.config !== undefined && canMutate("runners.configure"),
    kill: canKill && hasLocalRuns(runner),
    resetStats: canReset && runner.isLocal,
    clearHistory: canMutate("runners.clearHistory"),
    remoteOnly: !runner.isLocal && (canKill || canReset),
  };
}

/**
 * Whether clearing the history could remove a run that is still going: on a
 * runner registered in another process, a parallel run holds no lock, so the
 * API keeps a `running` record only while it is under a day old. A local
 * runner's runs are vouched for by this process, and a single-mode runner's
 * by its lock. An unknown run mode counts as parallel.
 */
export function clearHistoryMayDropLiveRuns(runner: RunnerInfoDto): boolean {
  if (runner.isLocal) {
    return false;
  }
  const runMode = runner.config?.effective.runMode ?? runner.runMode;
  return runMode !== "single";
}
