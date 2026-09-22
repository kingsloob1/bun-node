import type {
  MetaDto,
  Permissions,
  RunLogLineDto,
  RunLogPageDto,
  RunRecordDto,
} from "../../../app/api/types";
import type { RecordedCall } from "../mockFetch";
import { afterEach, describe, expect, it, jest } from "bun:test";
import { CAPTURE_GAP_NOTE } from "../../../app/screens/runners/runLogFormat";
import { fireEvent, page, setupDom, waitFor, within } from "../dom";
import { permissionsFixture, problem } from "../fixtures";
import {
  advance,
  historyFixture,
  renderRunner,
  runFixture,
  runnerApiPath,
  runnerMeta,
  runningRunnerFixture,
  settle,
} from "./fixtures";

// Ahead of setupDom()'s hooks, which need real timers to settle.
afterEach(() => {
  jest.useRealTimers();
});

setupDom();

/** A fixed "now" the line times are built from. */
const AT = 1_789_730_520_000;

/** One captured line, `stdout` unless told otherwise. */
function logLine(
  seq: number,
  overrides: Partial<RunLogLineDto> = {},
): RunLogLineDto {
  return {
    seq,
    at: AT + seq * 10,
    stream: "stdout",
    message: `line ${seq}`,
    ...overrides,
  };
}

/** One page of a run's log. */
function logPage(
  items: RunLogLineDto[],
  overrides: Partial<RunLogPageDto> = {},
): RunLogPageDto {
  return {
    items,
    page: { offset: 0, limit: 100, total: items.length, hasMore: false },
    dropped: 0,
    capped: false,
    live: false,
    lastSeq: items.at(-1)?.seq ?? 0,
    ...overrides,
  };
}

/** The API path of one run's log. */
function logsPath(runId = "run-3", runner = "nightly"): string {
  return `${runnerApiPath(runner)}/runs/${encodeURIComponent(runId)}/logs`;
}

/** A run that logged, as the history reports it. */
function loggedRun(overrides: Partial<RunRecordDto> = {}): RunRecordDto {
  return runFixture({ logLines: 2, logsDropped: 0, ...overrides });
}

/** The visible log lines' text. */
function lines(): string[] {
  return Array.from(document.querySelectorAll(".log-text")).map(
    (line) => line.textContent ?? "",
  );
}

/** The log calls of one run, in order. */
function logCalls(calls: RecordedCall[], runId = "run-3"): RecordedCall[] {
  return calls.filter((call) => call.path === logsPath(runId));
}

/** Renders the runner screen with `history` and the log of `run-3` mocked. */
async function renderWithLogs(
  options: {
    /** The run history the screen reads. */
    history?: RunRecordDto[];
    /** What `GET …/runs/run-3/logs` answers; a function sees each call. */
    logs?:
      | RunLogPageDto
      | ((call: RecordedCall) => { status?: number; body?: unknown });
    /** `/meta` overrides (to switch `features.runnerLogs` off). */
    meta?: MetaDto;
    /** `/meta/permissions` overrides. */
    permissions?: Permissions;
  } = {},
) {
  const items = options.history ?? [loggedRun()];
  const answer = options.logs ?? logPage([logLine(1), logLine(2)]);
  const result = renderRunner({
    meta: options.meta,
    permissions: options.permissions,
    handlers: {
      [`GET ${runnerApiPath("nightly", "/history")}`]: {
        body: historyFixture({ items }),
      },
      [`GET ${logsPath()}`]:
        typeof answer === "function" ? answer : { body: answer },
    },
  });
  await page().findByText("History");
  await waitFor(() => {
    if (!document.querySelector(".history-table")) {
      throw new Error("no history yet");
    }
  });
  return result;
}

/**
 * Advances fake time, then lets the answered request render: `advance`
 * stops as soon as the clock has moved, which can be one microtask before
 * React has drawn the lines that arrived.
 */
async function tailFor(ms: number): Promise<void> {
  await advance(ms);
  await advance(30, 10);
}

/** The history row of `runId`. */
function row(runId = "run-3"): HTMLElement {
  return page().getByTestId(`history-row-${runId}`);
}

describe("the run log on a history row", () => {
  it("offers the log of a run that logged, reads it from the start and shows each line with its seq, stream and level", async () => {
    const { calls } = await renderWithLogs({
      logs: logPage([
        logLine(1),
        logLine(2, { stream: "stderr", message: "boom" }),
        logLine(3, { stream: "log", level: "warn", message: "careful" }),
      ]),
    });
    fireEvent.click(within(row()).getByRole("button", { name: "Log" }));
    await page().findByTestId("run-logs-run-3");
    await waitFor(() => expect(lines()).toHaveLength(3));

    expect(logCalls(calls)).toHaveLength(1);
    expect(Object.fromEntries(logCalls(calls)[0]!.query.entries())).toEqual({
      limit: "100",
      order: "asc",
    });
    expect(lines()).toEqual(["line 1", "boom", "careful"]);
    const numbers = Array.from(
      document.querySelectorAll(".log-number"),
      (node) => node.textContent,
    );
    expect(numbers).toEqual(["1", "2", "3"]);
    const streams = Array.from(
      document.querySelectorAll(".run-log-stream"),
      (node) => node.textContent,
    );
    expect(streams).toEqual(["stdout", "stderr", "logger"]);
    expect(document.querySelector(".run-log-level")?.textContent).toBe("warn");
    expect(document.querySelector(".run-log-level")?.className).toContain(
      "badge-warning",
    );
  });

  it("keeps the open log in the URL, and closing it takes it out", async () => {
    await renderWithLogs();
    fireEvent.click(within(row()).getByRole("button", { name: "Log" }));
    await page().findByTestId("run-logs-run-3");
    expect(new URLSearchParams(window.location.search).get("logs")).toBe(
      "run-3",
    );
    fireEvent.click(within(row()).getByRole("button", { name: "Hide log" }));
    await waitFor(() =>
      expect(page().queryByTestId("run-logs-run-3")).toBeNull(),
    );
    expect(new URLSearchParams(window.location.search).get("logs")).toBeNull();
  });

  it("offers no log for a finished run counted at zero lines, and says it logged nothing", async () => {
    await renderWithLogs({
      history: [loggedRun({ runId: "run-quiet", logLines: 0 })],
    });
    expect(
      within(row("run-quiet")).queryByRole("button", { name: "Log" }),
    ).toBeNull();
    fireEvent.click(
      within(row("run-quiet")).getByRole("button", {
        name: "Show run run-quiet",
      }),
    );
    expect(page().getByTestId("run-no-logs-run-quiet").textContent).toBe(
      "This run logged nothing.",
    );
  });

  it("still offers the log of a run whose record carries no line count", async () => {
    // `logLines` is optional on the wire, and an API that does not send it
    // says nothing about the run — so the read answers, not the record.
    await renderWithLogs({
      history: [loggedRun({ logLines: undefined, logsDropped: undefined })],
      logs: logPage([logLine(1, { message: "from the run" })]),
    });
    fireEvent.click(within(row()).getByRole("button", { name: "Log" }));
    await page().findByTestId("run-logs-run-3");
    await waitFor(() => expect(lines()).toEqual(["from the run"]));
    await settle();
  });

  it("offers the log of a run still going, whatever its (lagging) count says", async () => {
    await renderWithLogs({
      history: [loggedRun({ status: "running", logLines: 0 })],
      logs: logPage([logLine(1)], { live: true }),
    });
    expect(within(row()).getByRole("button", { name: "Log" })).toBeDefined();
  });

  it("badges a row whose lines the cap dropped", async () => {
    await renderWithLogs({
      history: [loggedRun({ logsDropped: 12 })],
    });
    expect(row().textContent).toContain("12 lines dropped");
  });

  it("has no Log column at all without the feature or the permission", async () => {
    const { unmount } = await renderWithLogs({
      meta: runnerMeta({
        features: { ...runnerMeta().features, runnerLogs: false },
      }),
    });
    expect(page().queryByRole("columnheader", { name: "Log" })).toBeNull();
    expect(within(row()).queryByRole("button", { name: "Log" })).toBeNull();
    unmount();

    await renderWithLogs({
      permissions: permissionsFixture({ "runners.logs": false }),
    });
    expect(page().queryByRole("columnheader", { name: "Log" })).toBeNull();
  });
});

describe("where a run's log is hosted", () => {
  it("shows the run in flight's log once, on its history row, not again in the Active runs card", async () => {
    // The screen shows a running run three times over — Active runs, Last
    // run and the history, which includes the run in flight — so only the
    // history row hosts the log.
    const running = runningRunnerFixture();
    const active = running.local!.activeRuns[0]!;
    const inFlight = runFixture({
      runId: active.runId,
      status: "running",
      finishedAt: undefined,
      durationMs: undefined,
      result: undefined,
      logLines: 1,
    });
    renderRunner({
      runner: running,
      handlers: {
        [`GET ${runnerApiPath("nightly", "/history")}`]: {
          body: historyFixture({ items: [inFlight] }),
        },
        [`GET ${logsPath(active.runId)}`]: {
          body: logPage([logLine(1, { message: "working" })], { live: true }),
        },
      },
    });
    await page().findByText("History");
    await waitFor(() => {
      if (!document.querySelector(".history-table")) {
        throw new Error("no history yet");
      }
    });
    // The Active runs card shows the run's details, with no log of its own.
    expect(page().getAllByTestId(`run-${active.runId}`)).toHaveLength(1);
    fireEvent.click(
      within(row(active.runId)).getByRole("button", { name: "Log" }),
    );
    await page().findByTestId(`run-logs-${active.runId}`);
    // Now the same run's details are on screen twice, and its log once.
    expect(page().getAllByTestId(`run-${active.runId}`)).toHaveLength(2);
    expect(page().getAllByTestId(`run-logs-${active.runId}`)).toHaveLength(1);
    await waitFor(() => expect(lines()).toEqual(["working"]));
    await settle();
  });
});

describe("what the run log view says", () => {
  it("tells the run's dropped lines, the cap that is trimming it, and what capture never sees", async () => {
    await renderWithLogs({
      logs: logPage([logLine(9), logLine(10)], {
        dropped: 8,
        capped: true,
        lastSeq: 10,
      }),
    });
    fireEvent.click(within(row()).getByRole("button", { name: "Log" }));
    const notes = await page().findByTestId("run-log-notes");
    expect(notes.textContent).toContain("8 earlier lines dropped");
    expect(notes.textContent).toContain("A cap is trimming this log now");
    expect(page().getByTestId("run-logs-run-3").textContent).toContain(
      CAPTURE_GAP_NOTE,
    );
  });

  it("marks a line capture cut at its byte cap", async () => {
    await renderWithLogs({
      logs: logPage([logLine(1, { message: "xxxx", truncated: true })]),
    });
    fireEvent.click(within(row()).getByRole("button", { name: "Log" }));
    await page().findByTestId("run-logs-run-3");
    await waitFor(() =>
      expect(document.querySelector(".run-log-cut")).not.toBeNull(),
    );
    expect(document.querySelector(".run-log-cut")?.textContent).toBe(
      "cut at 8 KiB",
    );
  });

  it("tells a run that logged nothing from a log that is not retained", async () => {
    const { unmount } = await renderWithLogs({ logs: logPage([]) });
    fireEvent.click(within(row()).getByRole("button", { name: "Log" }));
    expect((await page().findByTestId("run-logs-empty")).textContent).toContain(
      "This run logged nothing",
    );
    unmount();

    await renderWithLogs({
      logs: () => ({
        status: 409,
        body: problem(409, "LOGS_NOT_RETAINED", "Run logs are not retained", {
          detail: "This run's log has been dropped.",
        }),
      }),
    });
    fireEvent.click(within(row()).getByRole("button", { name: "Log" }));
    await page().findByText("Run logs are not retained");
    expect(page().getByTestId("run-logs-run-3").textContent).toContain(
      "This run's log has been dropped.",
    );
  });

  it("tells a run it has no record of from a log that is not retained", async () => {
    // 404 covers an unknown run and one that aged out; the API cannot yet
    // tell them apart, so neither does the copy.
    await renderWithLogs({
      logs: () => ({
        status: 404,
        body: problem(404, "RUN_NOT_FOUND", "Run not found", {
          detail: 'Run "run-3" was not found',
        }),
      }),
    });
    fireEvent.click(within(row()).getByRole("button", { name: "Log" }));
    await page().findByText("No log for this run");
    expect(page().getByTestId("run-logs-run-3").textContent).toContain(
      "aged out of the runs this runner keeps",
    );
  });
});

describe("tailing a live run's log", () => {
  it("re-reads with since=lastSeq while the run is live, and stops once it is not", async () => {
    jest.useFakeTimers();
    let reads = 0;
    const { calls } = await renderWithLogs({
      history: [loggedRun({ status: "running", logLines: 1 })],
      logs: () => {
        reads += 1;
        if (reads === 1) {
          return { body: logPage([logLine(1)], { live: true, lastSeq: 1 }) };
        }
        if (reads === 2) {
          return {
            body: logPage([logLine(2)], {
              live: true,
              lastSeq: 2,
              page: { offset: 0, limit: 100, total: 1, hasMore: false },
            }),
          };
        }
        // The run has finished; nothing new.
        return {
          body: logPage([], { live: false, lastSeq: 2 }),
        };
      },
    });
    fireEvent.click(within(row()).getByRole("button", { name: "Log" }));
    await advance(100, 10);
    expect(lines()).toEqual(["line 1"]);
    expect(logCalls(calls)[0]!.query.get("since")).toBeNull();

    await tailFor(2_000);
    expect(logCalls(calls)[1]!.query.get("since")).toBe("1");
    expect(lines()).toEqual(["line 1", "line 2"]);

    await tailFor(2_000);
    expect(logCalls(calls)[2]!.query.get("since")).toBe("2");
    const settled = logCalls(calls).length;

    // The last page said the run had finished: no more polling.
    await tailFor(10_000);
    expect(logCalls(calls)).toHaveLength(settled);
    expect(lines()).toEqual(["line 1", "line 2"]);
  });

  it("catches up at once while a page reports more, resuming from the last line it got", async () => {
    jest.useFakeTimers();
    let reads = 0;
    const { calls } = await renderWithLogs({
      logs: () => {
        reads += 1;
        return reads === 1
          ? {
              body: logPage([logLine(1)], {
                page: { offset: 0, limit: 1, total: 2, hasMore: true },
                lastSeq: 2,
              }),
            }
          : { body: logPage([logLine(2)], { lastSeq: 2 }) };
      },
    });
    fireEvent.click(within(row()).getByRole("button", { name: "Log" }));
    await advance(500, 25);
    expect(logCalls(calls)).toHaveLength(2);
    // Not `since=2`: the first page stopped at its limit, so line 2 was
    // still to come.
    expect(logCalls(calls)[1]!.query.get("since")).toBe("1");
    expect(lines()).toEqual(["line 1", "line 2"]);
  });
});

describe("the stream filter", () => {
  it("sends the chosen stream, keeps it in the URL and reads that stream from the start", async () => {
    const { calls } = await renderWithLogs({
      logs: (call) =>
        call.query.get("stream") === "stderr"
          ? {
              body: logPage([logLine(2, { stream: "stderr" })], { lastSeq: 2 }),
            }
          : { body: logPage([logLine(1), logLine(2, { stream: "stderr" })]) },
    });
    fireEvent.click(within(row()).getByRole("button", { name: "Log" }));
    await page().findByTestId("run-logs-run-3");
    await waitFor(() => expect(lines()).toHaveLength(2));

    fireEvent.change(page().getByLabelText("Stream"), {
      target: { value: "stderr" },
    });
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(new URLSearchParams(window.location.search).get("logStream")).toBe(
      "stderr",
    );
    const last = logCalls(calls).at(-1)!;
    expect(last.query.get("stream")).toBe("stderr");
    // A filter reads from the start of what is kept: `since` is a raw seq.
    expect(last.query.get("since")).toBeNull();
    await settle();
  });
});
