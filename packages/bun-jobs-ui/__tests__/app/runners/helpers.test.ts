import { describe, expect, it } from "bun:test";
import {
  runnerInvalidations,
  runnerKeys,
  runnerPath,
} from "../../../app/api/runners";
import {
  listRefetchInterval,
  RUNNER_REFRESH,
  runnerRefetchInterval,
} from "../../../app/screens/runners/live";
import {
  defaultHistoryLimit,
  describeConcurrency,
  describeQueueing,
  describeSchedule,
  filterRunners,
  historyLimitOptions,
  newestFirst,
  orderRunners,
  runDuration,
  runnerBadges,
} from "../../../app/screens/runners/runnerFormat";
import { setupDom } from "../dom";
import {
  remoteRunnerFixture,
  runFixture,
  runnerFixture,
  runnerListFixture,
  runningRunnerFixture,
} from "./fixtures";

// The fixtures module loads the DOM helpers; clean up after them.
setupDom();

describe("the schedule in words", () => {
  it("names a cron expression with its time zone, or the owner's local time", () => {
    expect(describeSchedule({ cron: "0 3 * * *", tz: "Europe/London" })).toBe(
      "Cron 0 3 * * * in Europe/London",
    );
    expect(describeSchedule({ cron: "*/5 * * * *" })).toBe(
      "Cron */5 * * * * in the owner's local time",
    );
  });

  it("names an interval with its anchor, or says it counts from the start", () => {
    expect(
      describeSchedule({
        every: 30_000,
        anchor: Date.UTC(2026, 8, 18, 10, 0, 0),
      }),
    ).toBe("Every 30s, aligned to 2026-09-18 10:00:00 UTC");
    expect(describeSchedule({ every: 5_400_000 })).toBe(
      "Every 1h 30m, from when it started",
    );
    expect(describeSchedule({ every: 250 })).toBe(
      "Every 250ms, from when it started",
    );
  });

  it("names a one-off time, and no schedule at all", () => {
    expect(describeSchedule({ at: Date.UTC(2026, 11, 31, 23, 59, 0) })).toBe(
      "Once, at 2026-12-31 23:59:00 UTC",
    );
    expect(describeSchedule(null)).toBe("None: runs only when triggered");
  });
});

describe("the runner's settings", () => {
  it("reads an absent maxConcurrency as unlimited", () => {
    expect(describeConcurrency(undefined)).toBe("unlimited");
    expect(describeConcurrency(4)).toBe("4");
  });

  it("describes trigger queueing, and leaves it out when a remote runner does not say", () => {
    expect(describeQueueing(runnerFixture())).toBe("Yes, up to 100");
    expect(describeQueueing(runnerFixture({ queueRuns: false }))).toBe("No");
    expect(describeQueueing(remoteRunnerFixture())).toBeNull();
  });

  it("badges the local status, or the shared flags of a remote runner", () => {
    expect(runnerBadges(runnerFixture()).map((b) => b.label)).toEqual(["Idle"]);
    // `running` is the instance's lifecycle (started); a run in flight is its own badge.
    expect(runnerBadges(runningRunnerFixture()).map((b) => b.label)).toEqual([
      "Running",
      "Run in flight",
    ]);
    expect(
      runnerBadges(
        runnerFixture({
          local: { status: "running", activeRuns: [], nextRunAt: null },
        }),
      ).map((b) => b.label),
    ).toEqual(["Running"]);
    expect(
      runnerBadges(
        runnerFixture({
          isRunning: true,
          local: { status: "idle", activeRuns: [], nextRunAt: null },
        }),
      ).map((b) => b.label),
    ).toEqual(["Idle", "Run in flight"]);
    expect(runnerBadges(remoteRunnerFixture()).map((b) => b.label)).toEqual([
      "Paused",
    ]);
    expect(
      runnerBadges(
        remoteRunnerFixture({ isPaused: true, isRunning: true }),
      ).map((b) => b.label),
    ).toEqual(["Paused", "Run in flight"]);
    expect(
      runnerBadges(remoteRunnerFixture({ isPaused: false })).map(
        (b) => b.label,
      ),
    ).toEqual(["Active"]);
  });

  it("measures a run by durationMs, else its span, and not at all while running", () => {
    expect(runDuration(runFixture())).toBe("30s");
    expect(
      runDuration(
        runFixture({
          durationMs: undefined,
          startedAt: 0,
          finishedAt: 90_000,
        }),
      ),
    ).toBe("1m 30s");
    expect(
      runDuration(runFixture({ durationMs: undefined, finishedAt: undefined })),
    ).toBeNull();
  });
});

describe("the list helpers", () => {
  it("puts local runners first, keeping each group's order", () => {
    const shuffled = [
      { id: "b-remote", local: false, isPaused: false, isRunning: false },
      {
        id: "z-local",
        local: true,
        name: "z",
        status: "idle" as const,
        isPaused: false,
        isRunning: false,
      },
      { id: "a-remote", local: false, isPaused: false, isRunning: false },
      {
        id: "a-local",
        local: true,
        name: "a",
        status: "paused" as const,
        isPaused: true,
        isRunning: false,
      },
    ];
    expect(orderRunners(shuffled).map((item) => item.id)).toEqual([
      "z-local",
      "a-local",
      "b-remote",
      "a-remote",
    ]);
  });

  it("filters by id or name, case-insensitively, ignoring surrounding spaces", () => {
    const items = runnerListFixture().items;
    expect(filterRunners(items, "  REPORT ").map((item) => item.id)).toEqual([
      "nightly",
      "reports/daily run",
    ]);
    expect(filterRunners(items, "").length).toBe(items.length);
    expect(filterRunners(items, "nothing")).toEqual([]);
  });

  it("orders the history newest first, keeping ties as the API sent them", () => {
    const runs = [
      runFixture({ runId: "old", startedAt: 1 }),
      runFixture({ runId: "tie-a", startedAt: 5 }),
      runFixture({ runId: "tie-b", startedAt: 5 }),
    ];
    expect(newestFirst(runs).map((run) => run.runId)).toEqual([
      "tie-a",
      "tie-b",
      "old",
    ]);
  });
});

describe("history sizes", () => {
  it("defaults to min(50, maxHistory) and never offers more than maxHistory", () => {
    expect(defaultHistoryLimit(200)).toBe(50);
    expect(defaultHistoryLimit(30)).toBe(30);
    expect(historyLimitOptions(200)).toEqual([10, 25, 50, 100, 200]);
    expect(historyLimitOptions(30)).toEqual([10, 25, 30]);
    expect(historyLimitOptions(75)).toEqual([10, 25, 50, 75]);
    expect(historyLimitOptions(5)).toEqual([5]);
  });
});

describe("polling intervals", () => {
  it("re-reads a busy runner every 5 s, an idle one every 15 s, the list every 10 s", () => {
    expect(runnerRefetchInterval(runningRunnerFixture())).toBe(5_000);
    expect(
      runnerRefetchInterval(remoteRunnerFixture({ isRunning: true })),
    ).toBe(5_000);
    expect(runnerRefetchInterval(runnerFixture())).toBe(15_000);
    // Started (status `running`) with nothing in flight is not busy.
    expect(
      runnerRefetchInterval(
        runnerFixture({
          local: { status: "running", activeRuns: [], nextRunAt: null },
        }),
      ),
    ).toBe(15_000);
    expect(runnerRefetchInterval(undefined)).toBe(15_000);
    expect(listRefetchInterval()).toBe(10_000);
    expect(RUNNER_REFRESH.history).toBe(15_000);
  });
});

describe("the query keys the actions invalidate", () => {
  it("nests every read of one runner under [runner, id], and the list under [runners]", () => {
    expect(runnerKeys.runner("a")).toEqual(["runner", "a"]);
    for (const key of [
      runnerKeys.detail("a"),
      runnerKeys.stats("a"),
      runnerKeys.historyAll("a"),
      runnerKeys.history("a", 50),
    ]) {
      expect(key.slice(0, 2)).toEqual(["runner", "a"]);
    }
    expect(runnerKeys.list().slice(0, 1)).toEqual([...runnerKeys.all]);
    expect(runnerInvalidations("a")).toEqual([["runner", "a"], ["runners"]]);
    expect(runnerPath("a/b c")).toBe("/runners/a%2Fb%20c");
  });
});
