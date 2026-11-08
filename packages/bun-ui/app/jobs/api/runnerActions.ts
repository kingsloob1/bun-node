import type { ApiClient } from "./client";
import type {
  ClearRunnerHistoryResultDto,
  KillResultDto,
  KillRunnerBody,
  RunnerConfigBody,
  RunnerConfigDto,
  RunnerPausedDto,
  ScheduleResultDto,
  ScheduleRunnerBody,
  TriggerOutcomeDto,
  TriggerRunnerBody,
} from "./types";
import { segment } from "./client";

/**
 * The runner writes. After any of them, invalidate
 * `runnerInvalidations(id)` from `./runners`.
 *
 * Bodiless POSTs (pause, resume without `triggerNow`, stats reset) still
 * carry `Content-Type: application/json`: the client adds it to every
 * POST/PUT/PATCH, which the API's JSON rule requires.
 */

/** The API path of a runner, plus a suffix. */
function base(id: string, suffix: string): string {
  return `/runners/${segment(id)}${suffix}`;
}

/** `POST /runners/:runner/trigger`: 202 started/queued, 200 skipped (both resolve). Sends no body when `body` is empty. */
export function triggerRunner(
  api: ApiClient,
  id: string,
  body: TriggerRunnerBody = {},
): Promise<TriggerOutcomeDto> {
  const hasBody = body.force !== undefined || body.args !== undefined;
  return api.request<TriggerOutcomeDto>("POST", base(id, "/trigger"), {
    body: hasBody ? body : undefined,
  });
}

/** `POST /runners/:runner/pause` (bodiless). */
export function pauseRunner(
  api: ApiClient,
  id: string,
): Promise<RunnerPausedDto> {
  return api.request<RunnerPausedDto>("POST", base(id, "/pause"));
}

/** `POST /runners/:runner/resume`; bodiless unless `triggerNow`. */
export function resumeRunner(
  api: ApiClient,
  id: string,
  triggerNow = false,
): Promise<RunnerPausedDto> {
  return api.request<RunnerPausedDto>("POST", base(id, "/resume"), {
    body: triggerNow ? { triggerNow: true } : undefined,
  });
}

/** `PUT /runners/:runner/schedule`; `null` unschedules. */
export function rescheduleRunner(
  api: ApiClient,
  id: string,
  schedule: ScheduleRunnerBody["schedule"],
): Promise<ScheduleResultDto> {
  return api.request<ScheduleResultDto>("PUT", base(id, "/schedule"), {
    body: { schedule } satisfies ScheduleRunnerBody,
  });
}

/** `POST /runners/:runner/kill`: 202 at once, or 200 once settled with `wait`. Local runners only. */
export function killRunner(
  api: ApiClient,
  id: string,
  body: KillRunnerBody = {},
): Promise<KillResultDto> {
  return api.request<KillResultDto>("POST", base(id, "/kill"), {
    body: Object.keys(body).length > 0 ? body : undefined,
  });
}

/**
 * `PUT /runners/:runner/config`: a **merge patch** of the runner's executor
 * and overlap settings. A key left out is untouched; `null` clears that
 * override, so the runner goes back to what its own code asked for. Answers
 * the configuration after the write, whose `appliedSeq` may still trail
 * `seq` until an owner adopts it.
 */
export function configureRunner(
  api: ApiClient,
  id: string,
  body: RunnerConfigBody,
): Promise<RunnerConfigDto> {
  return api.request<RunnerConfigDto>("PUT", base(id, "/config"), { body });
}

/** `DELETE /runners/:runner/config`: drops every override at once, back to the runner's code. */
export function resetRunnerConfig(
  api: ApiClient,
  id: string,
): Promise<RunnerConfigDto> {
  return api.request<RunnerConfigDto>("DELETE", base(id, "/config"));
}

/** `POST /runners/:runner/stats/reset` (bodiless, 204). Local runners only. */
export function resetRunnerStats(api: ApiClient, id: string): Promise<void> {
  return api.request<void>("POST", base(id, "/stats/reset"));
}

/**
 * `DELETE /runners/:runner/history`: removes every finished run (record and
 * log) and keeps each run still in progress, naming them in `kept`. Works for
 * a runner registered in another process; the lifetime counters are
 * untouched (that is {@link resetRunnerStats}).
 */
export function clearRunnerHistory(
  api: ApiClient,
  id: string,
): Promise<ClearRunnerHistoryResultDto> {
  return api.request<ClearRunnerHistoryResultDto>(
    "DELETE",
    base(id, "/history"),
  );
}
