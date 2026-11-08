import type { RunnerEventName } from "../../api/types";
import { useCallback } from "react";
import { RUNNER_EVENT_TYPES } from "../../api/contract";
import { runLogHint } from "../../api/runnerLogs";
import { runnerKeys } from "../../api/runners";
import {
  liveChannels,
  useLiveInvalidation,
  useLiveSubscription,
  usePollInterval,
} from "../../live";

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

/**
 * The runner events that change what the runner screens read: every one the
 * contract declares except `logs`.
 *
 * `logs` is left out on purpose. It says one run's stored log grew — at most
 * every half second per run while a chatty run is going — and changes no
 * runner detail, stat or history row, so letting it invalidate
 * {@link runnerKeys.runner} would re-read all three that often, and every
 * open run log with them, whichever run the hint was for. The log view
 * follows it itself ({@link useRunLogHints}), for its own run only.
 */
export const RUNNER_STATE_EVENTS: readonly RunnerEventName[] =
  RUNNER_EVENT_TYPES.filter((type) => type !== "logs");

/** The Runners list's live updates: any event on `runners` but a log hint refreshes every runner list. */
export function useRunnerListLive(enabled: boolean): void {
  useLiveInvalidation([liveChannels.runners], [runnerKeys.all], {
    events: RUNNER_STATE_EVENTS,
    enabled,
  });
}

/**
 * One runner's live updates, on `runner/<id>`: any of its events but a log
 * hint (a run started or ended, a control) refreshes its detail, stats and
 * history, which all sit under its key.
 */
export function useRunnerLive(id: string, enabled: boolean): void {
  useLiveInvalidation([liveChannels.runner(id)], [runnerKeys.runner(id)], {
    events: RUNNER_STATE_EVENTS,
    enabled,
  });
}

/** What {@link useRunLogHints} calls. */
export interface RunLogHintHandlers {
  /** A hint about the run arrived, announcing the `seq` of the last line its log now holds. */
  onHint: (lastSeq: number) => void;
  /** The server reported a gap on the runner's channel: hints may have been lost, so read anyway. */
  onGap: () => void;
}

/**
 * Follows one run's `logs` hints on `runner/<runner>`: calls `onHint` with
 * the announced `lastSeq` for each hint about `runId`, and ignores every
 * other run's. Only `logs` is asked for, so a busy runner's other traffic
 * never reaches it.
 */
export function useRunLogHints(
  runner: string,
  runId: string,
  enabled: boolean,
  handlers: RunLogHintHandlers,
): void {
  useLiveSubscription({
    channels: [liveChannels.runner(runner)],
    events: ["logs"],
    enabled,
    onEvent: (event) => {
      const lastSeq = runLogHint(event, runner, runId);
      if (lastSeq !== undefined) {
        handlers.onHint(lastSeq);
      }
    },
    onGap: () => handlers.onGap(),
  });
}
