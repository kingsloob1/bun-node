import type {
  MetaDto,
  Permissions,
  RunnerHistoryDto,
  RunnerInfoDto,
  RunnerListDto,
  RunnerStatsDto,
  RunRecordDto,
} from "../../../app/api/types";
import type { MockHandler, MockReply } from "../mockFetch";
import { jest } from "bun:test";
import { act, visit } from "../dom";
import { metaFixture, permissionsFixture } from "../fixtures";
import { renderApp } from "../renderApp";

/**
 * Fixtures of the runner screens, typed against the contract, and a helper
 * that lands the app on a runner URL with every route it reads answered.
 */

/** A fixed "now" the timestamps are relative to. */
export const NOW = 1_789_730_520_000;

/** An id that needs percent-encoding in a path. */
export const AWKWARD_RUNNER = "reports/daily run";

/** {@link AWKWARD_RUNNER} as the API path segment. */
export const AWKWARD_RUNNER_ENCODED = "reports%2Fdaily%20run";

/** One finished run, successful by default. */
export function runFixture(
  overrides: Partial<RunRecordDto> = {},
): RunRecordDto {
  return {
    runId: "run-3",
    runnerId: "nightly",
    attempt: 1,
    source: "schedule",
    mode: "worker",
    host: "box-1",
    pid: 4242,
    startedAt: NOW - 120_000,
    finishedAt: NOW - 90_000,
    durationMs: 30_000,
    status: "success",
    result: { rows: 12 },
    ...overrides,
  };
}

/** A run in flight. */
export function activeRunFixture(
  overrides: Partial<RunRecordDto> = {},
): RunRecordDto {
  const run: RunRecordDto = {
    runId: "run-4",
    runnerId: "nightly",
    attempt: 1,
    source: "manual",
    mode: "worker",
    startedAt: NOW - 5_000,
    status: "running",
    ...overrides,
  };
  return run;
}

/** The lifetime counters. */
export function statsFixture(
  overrides: Partial<RunnerStatsDto> = {},
): RunnerStatsDto {
  return {
    success: 40,
    failed: 3,
    timeout: 1,
    killed: 2,
    skipped: 5,
    queued: 6,
    total: 46,
    ...overrides,
  };
}

/** `GET /runners/nightly`: a local, idle runner on a cron schedule. */
export function runnerFixture(
  overrides: Partial<RunnerInfoDto> = {},
): RunnerInfoDto {
  return {
    id: "nightly",
    namespace: "shop",
    isLocal: true,
    name: "Nightly report",
    schedule: { cron: "0 3 * * *", tz: "Europe/London" },
    nextRunAt: NOW + 3_600_000,
    executionMode: "worker",
    runMode: "single",
    queueRuns: true,
    maxQueuedRuns: 100,
    isPaused: false,
    isRunning: false,
    queuedTriggers: 0,
    stats: statsFixture(),
    lastRun: runFixture(),
    updatedAt: NOW - 60_000,
    local: { status: "idle", activeRuns: [], nextRunAt: NOW + 3_600_000 },
    ...overrides,
  };
}

/** A local runner with one run in flight. */
export function runningRunnerFixture(
  overrides: Partial<RunnerInfoDto> = {},
): RunnerInfoDto {
  const active = activeRunFixture();
  return runnerFixture({
    isRunning: true,
    runningOn: {
      runId: active.runId,
      since: active.startedAt,
      host: "box-1",
      pid: 4242,
    },
    local: { status: "running", activeRuns: [active], nextRunAt: null },
    ...overrides,
  });
}

/** A runner only another process registered: no `local`, and the optional settings absent. */
export function nonLocalRunnerFixture(
  overrides: Partial<RunnerInfoDto> = {},
): RunnerInfoDto {
  return {
    id: "billing",
    namespace: "shop",
    isLocal: false,
    name: "billing",
    schedule: { every: 30_000, anchor: Date.UTC(2026, 8, 18, 10, 0, 0) },
    nextRunAt: NOW + 30_000,
    isPaused: true,
    isRunning: false,
    queuedTriggers: 2,
    stats: statsFixture({ total: 0, success: 0, failed: 0 }),
    ...overrides,
  };
}

/** `GET /runners`: two local runners, then two remote ids (as the API orders them). */
export function runnerListFixture(
  overrides: Partial<RunnerListDto> = {},
): RunnerListDto {
  return {
    items: [
      {
        id: "nightly",
        local: true,
        isLocal: true,
        name: "Nightly report",
        status: "idle",
        isPaused: false,
        isRunning: false,
      },
      {
        id: "sync",
        local: true,
        isLocal: true,
        name: "sync",
        status: "running",
        isPaused: false,
        isRunning: true,
      },
      {
        id: "billing",
        local: false,

        isLocal: false,
        isPaused: true,
        isRunning: false,
      },
      {
        id: AWKWARD_RUNNER,
        local: false,

        isLocal: false,
        isPaused: false,
        isRunning: false,
      },
    ],
    ...overrides,
  };
}

/**
 * `GET /runners/nightly/history`: three runs, newest first, as one whole page.
 *
 * `page` is derived from the items, so a caller overriding them gets a
 * coherent page without restating it — the route's `total` is always present
 * and exact, and the card reads the whole history's size from it. Pass `page`
 * for a window of a longer history; {@link historyPager} is the handler that
 * pages one for real.
 */
export function historyFixture(
  overrides: Partial<RunnerHistoryDto> = {},
): RunnerHistoryDto {
  const items = overrides.items ?? [
    runFixture(),
    runFixture({
      runId: "run-2",
      startedAt: NOW - 86_400_000,
      finishedAt: NOW - 86_390_000,
      durationMs: 10_000,
      status: "failed",
      exitCode: 1,
      signal: null,
      result: undefined,
      error: {
        name: "Error",
        message: "Report query failed",
        cause: { name: "SqlError", message: "connection reset" },
      },
    }),
    runFixture({
      runId: "run-1",
      attempt: 2,
      source: "manual",
      startedAt: NOW - 172_800_000,
      finishedAt: NOW - 172_799_000,
      durationMs: 1_000,
      status: "killed",
      signal: "SIGTERM",
      detached: true,
      result: undefined,
    }),
  ];
  return {
    items,
    page: { offset: 0, limit: 50, total: items.length, hasMore: false },
    ...overrides,
  };
}

/**
 * A `GET /runners/:runner/history` handler that pages `runs` the way the
 * route does: `offset`, `limit` and `order` off the query, and a `page` whose
 * `total` is the whole list, not the window.
 *
 * @param runs Every stored run, newest first.
 */
export function historyPager(runs: readonly RunRecordDto[]): MockHandler {
  return (call) => {
    const offset = Math.max(0, Number(call.query.get("offset") ?? 0));
    const limit = Math.max(1, Number(call.query.get("limit") ?? 50));
    const ordered =
      call.query.get("order") === "asc" ? [...runs].reverse() : [...runs];
    const items = ordered.slice(offset, offset + limit);
    return {
      body: {
        items,
        page: {
          offset,
          limit,
          total: runs.length,
          hasMore: offset + items.length < runs.length,
        },
      } satisfies RunnerHistoryDto,
    };
  };
}

/** The API path of a runner (percent-encoded), plus a suffix. */
export function runnerApiPath(id = "nightly", suffix = ""): string {
  return `/runners/${encodeURIComponent(id)}${suffix}`;
}

/** Every route the screen of runner `runner` reads, answered from `runner`. */
export function runnerHandlers(
  runner: RunnerInfoDto = runnerFixture(),
  history: RunnerHistoryDto = historyFixture(),
): Record<string, MockHandler | MockReply> {
  return {
    "GET /runners": { body: runnerListFixture() },
    [`GET ${runnerApiPath(runner.id)}`]: { body: runner },
    [`GET ${runnerApiPath(runner.id, "/stats")}`]: { body: runner.stats },
    [`GET ${runnerApiPath(runner.id, "/history")}`]: { body: history },
  };
}

/** `/meta` of an API in mode `runner`. */
export function runnerMeta(overrides: Partial<MetaDto> = {}): MetaDto {
  return metaFixture({ mode: "runner", ...overrides });
}

/** Options of {@link renderRunner}. */
export interface RenderRunnerOptions {
  /** The app path (under `/jobs`). Defaults to `/runners/nightly`. */
  path?: string;
  /** `/meta`. Defaults to {@link runnerMeta}. */
  meta?: MetaDto;
  /** `/meta/permissions`. Defaults to every action granted. */
  permissions?: Permissions;
  /** The runner the default handlers answer with. */
  runner?: RunnerInfoDto;
  /** More route handlers, merged over the defaults. */
  handlers?: Record<string, MockHandler | MockReply>;
}

/** Renders the whole app at a runner path with the runner routes mocked. */
export function renderRunner(options: RenderRunnerOptions = {}) {
  visit(`/jobs${options.path ?? "/runners/nightly"}`);
  return renderApp({
    handlers: {
      "GET /meta": { body: options.meta ?? runnerMeta() },
      "GET /meta/permissions": {
        body: options.permissions ?? permissionsFixture(),
      },
      ...runnerHandlers(options.runner),
      ...options.handlers,
    },
  });
}

/** TanStack batches observer notifications on a timer; this lets them land inside `act`. */
export async function settle(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Advances fake time in steps, letting fetches and React settle between them. */
export async function advance(ms: number, step = 250): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await act(async () => {
      jest.advanceTimersByTime(Math.min(step, ms - elapsed));
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
    });
  }
}
