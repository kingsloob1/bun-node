import type { QueryKey } from "@tanstack/react-query";
import type { ApiClient } from "./client";
import type {
  RunnerHistoryDto,
  RunnerInfoDto,
  RunnerListDto,
  RunnerStatsDto,
} from "./types";
import { segment } from "./client";

/**
 * The runner screens' reads and query keys.
 *
 * Everything about one runner sits under {@link runnerKeys.runner}
 * (`["runner", id]`), so one invalidation refreshes the whole runner screen;
 * the runner list sits under {@link runnerKeys.all} (`["runners"]`). The
 * runner actions import these keys to invalidate after a write, so keep them
 * stable.
 */
export const runnerKeys = {
  /** Every `GET /runners` read. */
  all: ["runners"] as const,
  /** `GET /runners`. */
  list: () => ["runners", "list"] as const,
  /** Everything about one runner. */
  runner: (id: string) => ["runner", id] as const,
  /** `GET /runners/:runner`. */
  detail: (id: string) => ["runner", id, "detail"] as const,
  /** Every `GET /runners/:runner/history`, whatever its limit. */
  historyAll: (id: string) => ["runner", id, "history"] as const,
  /** One `GET /runners/:runner/history?limit=`. */
  history: (id: string, limit: number) =>
    ["runner", id, "history", { limit }] as const,
  /** `GET /runners/:runner/stats`. */
  stats: (id: string) => ["runner", id, "stats"] as const,
};

/** What a write to one runner invalidates: the runner, and every runner list (a status shows there). */
export function runnerInvalidations(id: string): QueryKey[] {
  return [runnerKeys.runner(id), runnerKeys.all];
}

/** The app path of one runner (the id percent-encoded as `segment()` does). */
export function runnerPath(id: string): string {
  return `/runners/${segment(id)}`;
}

/** The API path of a runner, plus an optional suffix. */
function base(id: string, suffix = ""): string {
  return `/runners/${segment(id)}${suffix}`;
}

/** `GET /runners`: local runners (with name and status), then remote ids. */
export function listRunners(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<RunnerListDto> {
  return api.request<RunnerListDto>("GET", "/runners", { signal });
}

/** `GET /runners/:runner`. */
export function getRunner(
  api: ApiClient,
  id: string,
  signal?: AbortSignal,
): Promise<RunnerInfoDto> {
  return api.request<RunnerInfoDto>("GET", base(id), { signal });
}

/** `GET /runners/:runner/history?limit=`, newest first. */
export function getRunnerHistory(
  api: ApiClient,
  id: string,
  limit: number,
  signal?: AbortSignal,
): Promise<RunnerHistoryDto> {
  return api.request<RunnerHistoryDto>("GET", base(id, "/history"), {
    query: { limit },
    signal,
  });
}

/** `GET /runners/:runner/stats`. */
export function getRunnerStats(
  api: ApiClient,
  id: string,
  signal?: AbortSignal,
): Promise<RunnerStatsDto> {
  return api.request<RunnerStatsDto>("GET", base(id, "/stats"), { signal });
}
