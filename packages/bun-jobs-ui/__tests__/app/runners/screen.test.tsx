import type { RunnerInfoDto, RunnerScheduleDto } from "../../../app/api/types";
import { afterEach, describe, expect, it, jest } from "bun:test";
import { REMOTE_RUNNER_NOTE } from "../../../app/screens/runners/runnerFormat";
import { fireEvent, page, setupDom, waitFor, within } from "../dom";
import { permissionsFixture, problem } from "../fixtures";
import {
  advance,
  AWKWARD_RUNNER,
  AWKWARD_RUNNER_ENCODED,
  historyFixture,
  remoteRunnerFixture,
  renderRunner,
  runFixture,
  runnerApiPath,
  runnerFixture,
  runnerMeta,
  runningRunnerFixture,
  settle,
  statsFixture,
} from "./fixtures";

// Ahead of setupDom()'s hooks, which need real timers to settle.
afterEach(() => {
  jest.useRealTimers();
});

setupDom();

/** Waits for the loaded runner and returns its heading's text. */
async function heading(): Promise<string> {
  const title = await page().findByRole("heading", { level: 1 });
  return title.textContent ?? "";
}

/** A summary row's value, by its label. */
function summaryValue(label: string): string | null {
  const summary = document.querySelector(".runner-summary")!;
  const row = Array.from(summary.querySelectorAll(".kv-row")).find(
    (candidate) => candidate.querySelector("dt")?.textContent === label,
  );
  return row ? (row.querySelector("dd")?.textContent ?? "") : null;
}

/** The stat tiles as `{ label: value }`. */
function tiles(): Record<string, string> {
  const grid = page().getByTestId("runner-stats");
  return Object.fromEntries(
    Array.from(grid.querySelectorAll(".stat"), (tile) => [
      tile.querySelector("dt")?.textContent ?? "",
      tile.querySelector("dd")?.textContent ?? "",
    ]),
  );
}

/** Renders the screen of `runner` and waits for its summary. */
async function renderLoaded(
  runner: RunnerInfoDto,
  options: Parameters<typeof renderRunner>[0] = {},
) {
  const result = renderRunner({
    path: `/runners/${encodeURIComponent(runner.id)}`,
    runner,
    ...options,
  });
  await page().findByText("Summary");
  await waitFor(() => {
    if (!document.querySelector(".runner-summary")) {
      throw new Error("no summary yet");
    }
  });
  return result;
}

describe("the runner screen", () => {
  it("shows a local idle runner: name, status, id, every summary row and the actions slot", async () => {
    const { calls } = await renderLoaded(runnerFixture(), {
      // The tiles come from GET /stats, not the detail's copy.
      handlers: {
        [`GET ${runnerApiPath("nightly", "/stats")}`]: {
          body: statsFixture({ success: 41, total: 47 }),
        },
      },
    });
    expect(await heading()).toBe("Nightly report");
    expect(page().getByTestId("runner-status").textContent).toBe("Idle");
    expect(page().getByTestId("runner-id").textContent).toBe("nightly");
    expect(summaryValue("Namespace")).toBe("shop");
    expect(summaryValue("Registered here")).toBe("Yes (local)");
    expect(summaryValue("File")).toBeNull();
    expect(summaryValue("Schedule")).toBe("Cron 0 3 * * * in Europe/London");
    expect(summaryValue("Execution mode")).toBe("worker");
    expect(summaryValue("Run mode")).toBe("single");
    expect(summaryValue("Queues triggers")).toBe("Yes, up to 100");
    expect(summaryValue("Max concurrency")).toBe("unlimited");
    expect(summaryValue("Queued triggers")).toBe("0");
    expect(summaryValue("Running on")).toBe("—");
    expect(summaryValue("Last error")).toBe("—");
    expect(summaryValue("Next run")).not.toBe("Not scheduled");
    expect(page().queryByTestId("remote-note")).toBeNull();

    await waitFor(() => expect(tiles().Success).toBe("41"));
    expect(tiles()).toEqual({
      Success: "41",
      Failed: "3",
      "Timed out": "1",
      Killed: "2",
      Skipped: "5",
      Queued: "6",
      Total: "47",
    });
    expect(page().getByTestId("no-active-runs")).toBeTruthy();
    expect(
      calls.some((call) => call.path === runnerApiPath("nightly", "/stats")),
    ).toBe(true);
  });

  it("shows the file when exposed, a concurrency cap when set, and the last error", async () => {
    await renderLoaded(
      runnerFixture({
        file: "/srv/app/jobs/nightly.ts",
        runMode: "parallel",
        maxConcurrency: 4,
        queueRuns: false,
        lastError: { name: "TypeError", message: "rows is not iterable" },
        nextRunAt: null,
        local: { status: "idle", activeRuns: [], nextRunAt: null },
      }),
    );
    expect(summaryValue("File")).toBe("/srv/app/jobs/nightly.ts");
    expect(summaryValue("Max concurrency")).toBe("4");
    expect(summaryValue("Queues triggers")).toBe("No");
    expect(summaryValue("Last error")).toBe("TypeError: rows is not iterable");
    expect(summaryValue("Next run")).toBe("Not scheduled");
  });

  it("notes this process's own ticker when it differs from the stored next run", async () => {
    await renderLoaded(
      runnerFixture({
        local: { status: "idle", activeRuns: [], nextRunAt: 1_000 },
      }),
    );
    expect(summaryValue("Next run")).toContain("This process's ticker:");
  });

  it("shows a running runner's active run, lock holder and status", async () => {
    await renderLoaded(runningRunnerFixture());
    expect(page().getByTestId("runner-status").textContent).toBe(
      "RunningRun in flight",
    );
    expect(summaryValue("Running on")).toContain("run-4 on box-1 (pid 4242)");
    const active = page().getByRole("list", { name: "Active runs" });
    const run = within(active).getByTestId("run-run-4");
    expect(run.textContent).toContain("Running");
    expect(run.textContent).toContain("Manual");
    expect(
      within(run).getByRole("button", { name: "Copy run id run-4" }),
    ).toBeTruthy();
    expect(page().queryByTestId("no-active-runs")).toBeNull();
  });

  it("shows a paused local runner, and a local runner another process is running", async () => {
    const paused = await renderLoaded(
      runnerFixture({
        isPaused: true,
        local: { status: "paused", activeRuns: [], nextRunAt: null },
      }),
    );
    expect(page().getByTestId("runner-status").textContent).toBe("Paused");
    paused.unmount();

    await renderLoaded(
      runnerFixture({
        isRunning: true,
        local: { status: "idle", activeRuns: [], nextRunAt: null },
      }),
    );
    expect(page().getByTestId("runner-status").textContent).toBe(
      "IdleRun in flight",
    );
  });

  it("shows a remote runner: its shared flags, the sync note, no local runs, absent settings as missing", async () => {
    await renderLoaded(remoteRunnerFixture());
    expect(await heading()).toBe("billing");
    expect(page().getByTestId("runner-status").textContent).toBe(
      "PausedRemote",
    );
    expect(page().queryByTestId("runner-id")).toBeNull();
    expect(page().getByTestId("remote-note").textContent).toBe(
      REMOTE_RUNNER_NOTE,
    );
    expect(summaryValue("Registered here")).toBe("No (remote)");
    expect(summaryValue("Schedule")).toBe(
      "Every 30s, aligned to 2026-09-18 10:00:00 UTC",
    );
    expect(summaryValue("Execution mode")).toBe("—");
    expect(summaryValue("Run mode")).toBe("—");
    expect(summaryValue("Queues triggers")).toBe("—");
    expect(summaryValue("Max concurrency")).toBe("unlimited");
    expect(summaryValue("Queued triggers")).toBe("2");
    expect(page().queryByRole("region", { name: "Active runs" })).toBeNull();
    expect(
      page().getByRole("region", { name: "Last run" }).textContent,
    ).toContain("has not run yet");
  });

  it("words every schedule form in the summary", async () => {
    const forms: [RunnerScheduleDto, string][] = [
      [{ cron: "*/5 * * * *" }, "Cron */5 * * * * in the owner's local time"],
      [{ every: 90_000 }, "Every 1m 30s, from when it started"],
      [
        { at: Date.UTC(2026, 11, 31, 23, 59, 0) },
        "Once, at 2026-12-31 23:59:00 UTC",
      ],
      [null, "None: runs only when triggered"],
    ];
    for (const [schedule, words] of forms) {
      const rendered = await renderLoaded(runnerFixture({ schedule }));
      expect(page().getByTestId("runner-schedule").textContent).toBe(words);
      rendered.unmount();
    }
  });

  it("requests a percent-encoded id and shows the last run in full", async () => {
    const runner = runnerFixture({
      id: AWKWARD_RUNNER,
      name: AWKWARD_RUNNER,
      lastRun: runFixture({
        runnerId: AWKWARD_RUNNER,
        status: "failed",
        exitCode: 2,
        signal: null,
        result: undefined,
        error: {
          name: "Error",
          message: "boom",
          cause: { name: "IoError", message: "disk full" },
        },
      }),
    });
    const { calls } = await renderLoaded(runner);
    expect(
      calls.some((call) => call.path === `/runners/${AWKWARD_RUNNER_ENCODED}`),
    ).toBe(true);
    const last = page().getByRole("region", { name: "Last run" });
    expect(last.textContent).toContain("run-3");
    expect(last.textContent).toContain("Failed");
    expect(last.textContent).toContain("Schedule");
    expect(last.textContent).toContain("box-1, pid 4242");
    expect(last.textContent).toContain("30s");
    const error = within(last).getByRole("group", {
      name: "Error of run run-3",
    });
    expect(error.textContent).toContain("boom");
    expect(error.textContent).toContain("Caused by");
    expect(error.textContent).toContain("disk full");
    const exit = Array.from(last.querySelectorAll(".kv-row")).find(
      (row) => row.querySelector("dt")?.textContent === "Exit code",
    );
    expect(exit?.querySelector("dd")?.textContent).toBe("2");
  });

  it("shows the last run's result as JSON", async () => {
    await renderLoaded(runnerFixture());
    const last = page().getByRole("region", { name: "Last run" });
    expect(last.textContent).toContain("rows");
    expect(last.textContent).toContain("12");
  });
});

describe("the runner history", () => {
  it("lists the runs newest first, and expands a row to the run's details", async () => {
    await renderLoaded(runnerFixture(), {
      handlers: {
        // Oldest first on the wire: the table still reads newest first.
        [`GET ${runnerApiPath("nightly", "/history")}`]: {
          body: { items: [...historyFixture().items].reverse() },
        },
      },
    });
    const table = await page().findByRole("table", { name: "Run history" });
    const ids = Array.from(
      table.querySelectorAll<HTMLElement>("tbody tr"),
      (row) => row.dataset.testid?.replace(/^history-row-/, "") ?? "",
    );
    expect(ids).toEqual(["run-3", "run-2", "run-1"]);

    const failed = within(table).getByTestId("history-row-run-2");
    expect(failed.textContent).toContain("Failed");
    fireEvent.click(
      within(failed).getByRole("button", { name: "Show run run-2" }),
    );
    const details = await within(table).findByTestId("run-run-2");
    expect(details.textContent).toContain("Report query failed");
    expect(details.textContent).toContain("connection reset");
    expect(details.textContent).toContain("Exit code1");

    const killed = within(table).getByTestId("history-row-run-1");
    fireEvent.click(
      within(killed).getByRole("button", { name: "Show run run-1" }),
    );
    const run1 = await within(table).findByTestId("run-run-1");
    expect(run1.textContent).toContain("SignalSIGTERM");
    expect(run1.textContent).toContain("Yes: it outlived its owner");
    expect(run1.textContent).toContain("Attempt2");
    expect(
      within(killed).getByRole("button", { name: "Hide run run-1" }),
    ).toBeTruthy();
    fireEvent.click(
      within(killed).getByRole("button", { name: "Hide run run-1" }),
    );
    await waitFor(() =>
      expect(within(table).queryByTestId("run-run-1")).toBeNull(),
    );
  });

  it("asks for min(50, maxHistory) runs and offers sizes only up to maxHistory", async () => {
    const { calls } = await renderLoaded(runnerFixture(), {
      meta: runnerMeta({
        limits: { ...runnerMeta().limits, maxHistory: 30 },
      }),
    });
    await page().findByRole("table", { name: "Run history" });
    const history = () =>
      calls.filter(
        (call) => call.path === runnerApiPath("nightly", "/history"),
      );
    expect(history().at(-1)!.query.get("limit")).toBe("30");
    const select = page().getByLabelText("Runs shown") as HTMLSelectElement;
    expect(Array.from(select.options, (option) => option.value)).toEqual([
      "10",
      "25",
      "30",
    ]);
    expect(select.value).toBe("30");

    fireEvent.change(select, { target: { value: "10" } });
    await waitFor(() =>
      expect(history().at(-1)!.query.get("limit")).toBe("10"),
    );
    expect(window.location.search).toBe("?history=10");
  });

  it("caps a size in the URL at maxHistory", async () => {
    const { calls } = await renderLoaded(runnerFixture(), {
      path: "/runners/nightly?history=500",
    });
    await page().findByRole("table", { name: "Run history" });
    expect(
      calls
        .filter((call) => call.path === runnerApiPath("nightly", "/history"))
        .at(-1)!
        .query.get("limit"),
    ).toBe("200");
  });

  it("says when there are no runs, and shows a history failure inline", async () => {
    const empty = await renderLoaded(runnerFixture(), {
      handlers: {
        [`GET ${runnerApiPath("nightly", "/history")}`]: {
          body: { items: [] },
        },
      },
    });
    expect(await page().findByText("No runs yet")).toBeTruthy();
    empty.unmount();

    await renderLoaded(runnerFixture(), {
      handlers: {
        [`GET ${runnerApiPath("nightly", "/history")}`]: {
          status: 500,
          body: problem(500, "INTERNAL", "Internal error"),
        },
      },
    });
    expect(await page().findByText("Could not load the history")).toBeTruthy();
    // The rest of the screen stays.
    expect(await heading()).toBe("Nightly report");
  });
});

/** `/meta/permissions` without `runners.read` at all, as when its route is pruned. */
function withoutRunnersRead() {
  const permissions = permissionsFixture();
  delete permissions.actions["runners.read"];
  return permissions;
}

/** A 401/403 problem on `GET` of the runner, as a per-runner `authorize` answers it. */
function denied(status: 401 | 403, detail: string) {
  return {
    status,
    body: problem(
      status,
      status === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
      status === 401 ? "Unauthorized" : "Forbidden",
      { detail, context: { runner: "nightly" } },
    ),
  };
}

/** Every request about the runner `nightly`. */
function runnerReads(calls: { path: string }[]): number {
  return calls.filter((call) => call.path.startsWith(runnerApiPath("nightly")))
    .length;
}

describe("the runner screen's access gate", () => {
  it("hides the runner, and never requests it, without runners.read", async () => {
    const { calls } = renderRunner({ permissions: withoutRunnersRead() });
    const panel = await page().findByTestId("runner-hidden");
    expect(panel.textContent).toContain("Runner hidden");
    expect(
      within(panel)
        .getByRole("link", { name: "Back to runners" })
        .getAttribute("href"),
    ).toBe("/jobs/runners");
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.path === "/meta/permissions" &&
            call.query.get("runner") === "nightly",
        ),
      ).toBe(true),
    );
    await settle(50);
    expect(runnerReads(calls)).toBe(0);
    expect(page().queryByTestId("runner-screen")).toBeNull();
  });

  /** Renders the screen with the runner's own permissions answered on demand. */
  function renderWithPendingScope(scopedReadable: boolean) {
    let answerScoped: (() => void) | undefined;
    const scopedArrived = new Promise<void>((resolve) => {
      answerScoped = resolve;
    });
    const { calls } = renderRunner({
      handlers: {
        // Untargeted: granted. Scoped to `nightly`: answered on demand.
        "GET /meta/permissions": async (call) => {
          if (call.query.get("runner") !== "nightly") {
            return { body: permissionsFixture() };
          }
          await scopedArrived;
          return {
            body: permissionsFixture(
              scopedReadable ? {} : { "runners.read": false },
            ),
          };
        },
      },
    });
    return {
      reads: () => runnerReads(calls),
      release: () => answerScoped?.(),
    };
  }

  it("reads nothing while the runner's own permissions are pending, and never once they deny runners.read", async () => {
    jest.useFakeTimers();
    const { reads, release } = renderWithPendingScope(false);
    await advance(5_000);
    // The untargeted map grants runners.read, but the runner's is pending.
    expect(reads()).toBe(0);
    expect(page().queryByTestId("runner-hidden")).toBeNull();

    release();
    await advance(100, 10);
    expect(page().getByTestId("runner-hidden").textContent).toContain(
      "Runner hidden",
    );
    expect(page().queryByTestId("runner-screen")).toBeNull();
    await advance(20_000);
    expect(reads()).toBe(0);
  });

  it("starts reading once the runner's own permissions grant runners.read", async () => {
    jest.useFakeTimers();
    const { reads, release } = renderWithPendingScope(true);
    await advance(5_000);
    expect(reads()).toBe(0);
    release();
    await advance(500, 10);
    expect(reads()).toBeGreaterThanOrEqual(1);
    expect(page().getByTestId("runner-screen")).toBeTruthy();
  });

  it("shows the hidden panel with the API's detail on a 403, and stops asking", async () => {
    const { calls } = renderRunner({
      handlers: {
        [`GET ${runnerApiPath()}`]: denied(403, "Not your team's runner"),
      },
    });
    const panel = await page().findByTestId("runner-hidden");
    expect(panel.textContent).toContain("Not your team's runner");
    expect(page().queryByText("Could not load the runner")).toBeNull();
    await settle(50);
    expect(calls.filter((call) => call.path === runnerApiPath())).toHaveLength(
      1,
    );
    // Neither stats nor history were asked for.
    expect(runnerReads(calls)).toBe(1);
  });

  it("treats a 401 the same way", async () => {
    renderRunner({
      handlers: { [`GET ${runnerApiPath()}`]: denied(401, "Sign in again") },
    });
    const panel = await page().findByTestId("runner-hidden");
    expect(panel.textContent).toContain("Sign in again");
  });

  it("shows the not-found panel for RUNNER_NOT_FOUND", async () => {
    const { calls } = renderRunner({
      path: "/runners/ghost",
      handlers: {
        [`GET ${runnerApiPath("ghost")}`]: {
          status: 404,
          body: problem(404, "RUNNER_NOT_FOUND", "Runner not found", {
            detail: 'Runner "ghost" not found',
          }),
        },
      },
    });
    const panel = await page().findByTestId("runner-not-found");
    expect(panel.textContent).toContain("Runner not found");
    expect(panel.textContent).toContain("ghost");
    expect(page().queryByTestId("runner-hidden")).toBeNull();
    await settle(50);
    expect(
      calls.filter((call) => call.path === runnerApiPath("ghost")),
    ).toHaveLength(1);
  });

  it("shows other load failures with a retry", async () => {
    let fail = true;
    renderRunner({
      handlers: {
        [`GET ${runnerApiPath()}`]: () =>
          fail
            ? { status: 500, body: problem(500, "INTERNAL", "Internal error") }
            : { body: runnerFixture() },
      },
    });
    expect(await page().findByText("Could not load the runner")).toBeTruthy();
    fail = false;
    fireEvent.click(page().getByRole("button", { name: "Retry" }));
    expect(await heading()).toBe("Nightly report");
  });
});

describe("the runner screen's polling", () => {
  /** Counts the requests to one runner path. */
  function counter(calls: { path: string }[]) {
    return (suffix = "") =>
      calls.filter((call) => call.path === runnerApiPath("nightly", suffix))
        .length;
  }

  it("re-reads an idle runner's detail, stats and history every 15 s", async () => {
    jest.useFakeTimers();
    const { calls } = renderRunner();
    await advance(500, 10);
    const reads = counter(calls);
    expect([reads(), reads("/stats"), reads("/history")]).toEqual([1, 1, 1]);
    await advance(10_000);
    expect([reads(), reads("/stats"), reads("/history")]).toEqual([1, 1, 1]);
    await advance(5_500);
    expect([reads(), reads("/stats"), reads("/history")]).toEqual([2, 2, 2]);
  });

  it("re-reads a running runner's detail and stats every 5 s, its history every 15 s", async () => {
    jest.useFakeTimers();
    const { calls } = renderRunner({ runner: runningRunnerFixture() });
    await advance(500, 10);
    const reads = counter(calls);
    expect([reads(), reads("/stats"), reads("/history")]).toEqual([1, 1, 1]);
    await advance(5_000);
    expect([reads(), reads("/stats")]).toEqual([2, 2]);
    await advance(5_000);
    expect([reads(), reads("/stats")]).toEqual([3, 3]);
    expect(reads("/history")).toBe(1);
    await advance(5_500);
    expect(reads("/history")).toBe(2);
  });

  it("slows down once the run has finished", async () => {
    jest.useFakeTimers();
    let runner = runningRunnerFixture();
    const { calls } = renderRunner({
      runner,
      handlers: { [`GET ${runnerApiPath()}`]: () => ({ body: runner }) },
    });
    await advance(500, 10);
    const reads = counter(calls);
    expect(reads()).toBe(1);
    runner = runnerFixture();
    await advance(5_000);
    expect(reads()).toBe(2);
    expect(page().getByTestId("runner-status").textContent).toBe("Idle");
    await advance(10_000);
    expect(reads()).toBe(2);
    await advance(5_500);
    expect(reads()).toBe(3);
  });
});
