import type { ApiError } from "../../api/errors";
import type {
  RunnerInfoDto,
  RunnerListItemDto,
  RunnerScheduleDto,
  RunnerStatusDto,
  RunRecordDto,
} from "../../api/types";
import type { BadgeTone } from "../../components/Badge";
import { isApiError } from "../../api/errors";
import { formatNumber } from "../../format";
import { formatMs } from "../queues/duration";

/** How a runner status is shown. */
export interface RunnerBadge {
  /** The text. */
  label: string;
  /** Its colour. */
  tone: BadgeTone;
  /** What it means, as a tooltip. */
  hint: string;
}

/**
 * Display of each runner status. It is the INSTANCE's lifecycle, not whether
 * a run is in flight: `running` means started (its schedule armed in that
 * process), `idle` registered but not started (bun-jobs runner/BunRunner.ts
 * `start()`/`stop()`). A run in flight is `isRunning`, shown separately.
 */
export const RUNNER_STATUS: Readonly<Record<RunnerStatusDto, RunnerBadge>> = {
  idle: {
    label: "Idle",
    tone: "neutral",
    hint: "Registered but not started in its process: nothing is scheduled there.",
  },
  running: {
    label: "Running",
    tone: "success",
    hint: "Started: its schedule is armed and triggers are accepted.",
  },
  paused: {
    label: "Paused",
    tone: "warning",
    hint: "Paused everywhere: scheduled and manual runs do not start.",
  },
  stopped: {
    label: "Stopped",
    tone: "danger",
    hint: "Stopped in its process: it takes no more triggers.",
  },
};

/** The badge of a run in flight. */
export const RUN_IN_FLIGHT: RunnerBadge = {
  label: "Run in flight",
  tone: "info",
  hint: "A run is executing somewhere right now (the runner's lock or active runs say so).",
};

/** The badge of a remote runner that is not paused. */
export const REMOTE_ACTIVE: RunnerBadge = {
  label: "Active",
  tone: "neutral",
  hint: "Not paused. Its owner's own status shows only on the owner's API.",
};

/** Display label and colour of each run status. */
export const RUN_STATUS: Readonly<
  Record<RunRecordDto["status"], { label: string; tone: BadgeTone }>
> = {
  running: { label: "Running", tone: "info" },
  success: { label: "Success", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  timeout: { label: "Timed out", tone: "warning" },
  killed: { label: "Killed", tone: "danger" },
};

/** Display labels of what started a run. */
export const RUN_SOURCE: Readonly<Record<RunRecordDto["source"], string>> = {
  schedule: "Schedule",
  manual: "Manual",
  queued: "Queued trigger",
  resume: "Resume",
};

/** An instant as a stable, readable UTC string: `2026-09-18 03:00:00 UTC`. */
export function formatInstant(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/**
 * A schedule in words:
 * - `null` → "None: runs only when triggered"
 * - `{ cron, tz? }` → "Cron 0 3 * * * in Europe/London" (or "in the owner's local time")
 * - `{ every, anchor? }` → "Every 30s, aligned to …" (or "from when it started")
 * - `{ at }` → "Once, at …"
 */
export function describeSchedule(schedule: RunnerScheduleDto): string {
  if (schedule === null) {
    return "None: runs only when triggered";
  }
  if ("cron" in schedule) {
    return `Cron ${schedule.cron} in ${schedule.tz ?? "the owner's local time"}`;
  }
  if ("every" in schedule) {
    const anchor =
      schedule.anchor === undefined
        ? "from when it started"
        : `aligned to ${formatInstant(schedule.anchor)}`;
    return `Every ${formatMs(schedule.every)}, ${anchor}`;
  }
  return `Once, at ${formatInstant(schedule.at)}`;
}

/** A runner's concurrency cap: absent means unlimited (JSON cannot carry `Infinity`). */
export function describeConcurrency(
  maxConcurrency: number | undefined,
): string {
  return maxConcurrency === undefined
    ? "unlimited"
    : formatNumber(maxConcurrency);
}

/** Whether triggers queue while busy, and how many may: "Yes, up to 100" / "No". */
export function describeQueueing(runner: RunnerInfoDto): string | null {
  if (runner.queueRuns === undefined) {
    return runner.maxQueuedRuns === undefined
      ? null
      : `up to ${formatNumber(runner.maxQueuedRuns)}`;
  }
  if (!runner.queueRuns) {
    return "No";
  }
  return runner.maxQueuedRuns === undefined
    ? "Yes"
    : `Yes, up to ${formatNumber(runner.maxQueuedRuns)}`;
}

/**
 * The header's badges: the local instance's status (or, for a remote runner,
 * paused or active from the shared flag), plus "Run in flight" while a run
 * executes anywhere.
 */
export function runnerBadges(runner: RunnerInfoDto): RunnerBadge[] {
  const badges: RunnerBadge[] = [
    runner.local
      ? RUNNER_STATUS[runner.local.status]
      : runner.isPaused
        ? RUNNER_STATUS.paused
        : REMOTE_ACTIVE,
  ];
  if (runner.isRunning || (runner.local?.activeRuns.length ?? 0) > 0) {
    badges.push(RUN_IN_FLIGHT);
  }
  return badges;
}

/** Page sizes offered for history; those above `maxHistory` are dropped. */
export const HISTORY_LIMITS: readonly number[] = [10, 25, 50, 100, 200];

/** The API's default history size: `min(50, maxHistory)`. */
export function defaultHistoryLimit(maxHistory: number): number {
  return Math.max(1, Math.min(50, maxHistory));
}

/** The history sizes to offer: {@link HISTORY_LIMITS} up to `maxHistory`, plus the default and the cap itself. */
export function historyLimitOptions(maxHistory: number): number[] {
  const max = Math.max(1, maxHistory);
  return [
    ...new Set([
      ...HISTORY_LIMITS.filter((limit) => limit <= max),
      defaultHistoryLimit(max),
      max,
    ]),
  ].sort((a, b) => a - b);
}

/** Whether an error means the runner does not exist. */
export function isRunnerNotFound(error: unknown): boolean {
  return isApiError(error) && error.code === "RUNNER_NOT_FOUND";
}

/** Whether an error means the caller may not read this runner (401/403). */
export function isRunnerDenied(error: unknown): error is ApiError {
  return isApiError(error) && error.isAuth;
}

/** A run's duration: its own `durationMs`, else the span it recorded. */
export function runDuration(run: RunRecordDto): string | null {
  const ms =
    run.durationMs ??
    (run.finishedAt === undefined ? undefined : run.finishedAt - run.startedAt);
  return ms === undefined ? null : formatMs(Math.max(0, ms));
}

/** The sentence a remote runner's screen carries. */
export const REMOTE_RUNNER_NOTE =
  "This runner is registered by another process; changes are adopted at its owner's next sync.";

/**
 * Orders the list: local runners first, then remote ones, each group in the
 * order the API gave (local by registration, remote sorted by id).
 */
export function orderRunners(
  items: readonly RunnerListItemDto[],
): RunnerListItemDto[] {
  return [
    ...items.filter((item) => item.isLocal),
    ...items.filter((item) => !item.isLocal),
  ];
}

/** The runners whose id or name contains `filter` (case-insensitive). */
export function filterRunners(
  items: readonly RunnerListItemDto[],
  filter: string,
): RunnerListItemDto[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) {
    return [...items];
  }
  return items.filter(
    (item) =>
      item.id.toLowerCase().includes(needle) ||
      (item.name?.toLowerCase().includes(needle) ?? false),
  );
}

/** The runs newest first (the API's order already; a stable sort keeps ties as given). */
export function newestFirst(runs: readonly RunRecordDto[]): RunRecordDto[] {
  return [...runs].sort((a, b) => b.startedAt - a.startedAt);
}
