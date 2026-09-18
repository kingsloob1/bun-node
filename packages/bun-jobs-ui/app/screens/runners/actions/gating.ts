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
  /** `runners.kill`, on a local runner with a run in flight in this process. */
  kill: boolean;
  /** `runners.resetStats`, on a local runner. */
  resetStats: boolean;
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
    kill: canKill && hasLocalRuns(runner),
    resetStats: canReset && runner.isLocal,
    remoteOnly: !runner.isLocal && (canKill || canReset),
  };
}
