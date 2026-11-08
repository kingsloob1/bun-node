import type { QueryKey } from "@tanstack/react-query";
import type { ApiClient } from "./client";
import type {
  RunnerHistoryDto,
  RunnerInfoDto,
  RunnerListDto,
  RunnerStatsDto,
} from "./types";
import { segment } from "./client";
import { assertShape, hasStrings } from "./shape";

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
  /** Every `GET /runners/:runner/history`, whatever window it asked for. */
  historyAll: (id: string) => ["runner", id, "history"] as const,
  /**
   * One `GET /runners/:runner/history` window.
   *
   * The **offset is part of the key**: the route pages on the server, so two
   * windows of one runner are two different answers, and a key holding only
   * the limit would serve page 2 the cached page 1. Every invalidation goes
   * through {@link runnerKeys.historyAll} (or {@link runnerKeys.runner}
   * above it), which is the prefix of all of them, so no window is missed.
   */
  history: (id: string, window: HistoryWindow) =>
    ["runner", id, "history", { ...window }] as const,
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

/**
 * `GET /runners`: local runners (with name and status), then the ids of those
 * registered in other processes.
 */
export function listRunners(
  api: ApiClient,
  signal?: AbortSignal,
): Promise<RunnerListDto> {
  return api.request<RunnerListDto>("GET", "/runners", { signal });
}

/**
 * `GET /runners/:runner`. A body without a string `id` and `name` rejects
 * with an `UNEXPECTED_RESPONSE` `ApiError`, so the screen shows its error
 * state rather than an empty runner.
 */
export async function getRunner(
  api: ApiClient,
  id: string,
  signal?: AbortSignal,
): Promise<RunnerInfoDto> {
  const path = base(id);
  const body = await api.request<unknown>("GET", path, { signal });
  return assertShape<RunnerInfoDto>(
    body,
    (fields) => hasStrings(fields, "id", "name"),
    "a runner",
    path,
  );
}

/**
 * One window of `GET /runners/:runner/history`.
 *
 * `limit` bounds a **page**, not how far back `offset` may read: the route
 * caps `limit` at `limits.maxHistory` (more is 400 `VALIDATION`) and leaves
 * `offset` uncapped, so every stored run is reachable.
 */
export interface HistoryWindow {
  /** Runs skipped before the page. `0` is the first page. */
  offset: number;
  /** Runs on the page, `1` to `limits.maxHistory`. */
  limit: number;
  /** Which end to read from, by start time. `"desc"` is newest first. */
  order: "asc" | "desc";
}

/** `GET /runners/:runner/history`: one window of the runner's stored runs. */
export function getRunnerHistory(
  api: ApiClient,
  id: string,
  window: HistoryWindow,
  signal?: AbortSignal,
): Promise<RunnerHistoryDto> {
  return api.request<RunnerHistoryDto>("GET", base(id, "/history"), {
    query: { offset: window.offset, limit: window.limit, order: window.order },
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
