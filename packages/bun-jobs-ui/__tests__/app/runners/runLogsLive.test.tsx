import type {
  RunLogLineDto,
  RunLogPageDto,
  RunRecordDto,
} from "../../../app/api/types";
import type { RecordedCall } from "../mockFetch";
import { afterEach, describe, expect, it, jest } from "bun:test";
import { RUN_LOG_POLL_MS } from "../../../app/api/runnerLogs";
import { REDACTION_NOTE } from "../../../app/screens/runners/runLogFormat";
import { act, fireEvent, page, setupDom, waitFor, within } from "../dom";
import { installLiveFake, LIVE_SLOWDOWN, runnerEvent } from "../liveFake";
import {
  advance,
  historyFixture,
  renderRunner,
  runFixture,
  runnerApiPath,
  settle,
} from "./fixtures";

/**
 * A live run's log follows the runner's `logs` hint: a hint for the run on
 * screen reads once from the cursor, a hint for any other run reads nothing,
 * and the poll underneath still tails when live updates are off.
 */

// Ahead of setupDom()'s hooks, which need real timers to settle.
afterEach(() => {
  jest.useRealTimers();
});

setupDom();
const live = installLiveFake({
  state: "live",
  events: "push",
  publishing: true,
});

/** A fixed "now" the line times are built from. */
const AT = 1_789_730_520_000;

/** One captured line. */
function logLine(seq: number): RunLogLineDto {
  return { seq, at: AT + seq * 10, stream: "stdout", message: `line ${seq}` };
}

/** One page of a live run's log. */
function livePage(items: RunLogLineDto[], lastSeq: number): RunLogPageDto {
  return {
    items,
    page: { offset: 0, limit: 100, total: items.length, hasMore: false },
    dropped: 0,
    capped: false,
    live: true,
    lastSeq,
  };
}

/** The API path of one run's log. */
function logsPath(runId = "run-3"): string {
  return `${runnerApiPath("nightly")}/runs/${encodeURIComponent(runId)}/logs`;
}

/** The log reads of `run-3`, in order. */
function logCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.path === logsPath());
}

/** The visible log lines' text. */
function lines(): string[] {
  return Array.from(document.querySelectorAll(".log-text")).map(
    (line) => line.textContent ?? "",
  );
}

/** A running run, as the history reports it. */
function runningRun(): RunRecordDto {
  return runFixture({
    status: "running",
    finishedAt: undefined,
    durationMs: undefined,
    result: undefined,
    logLines: 1,
    logsDropped: 0,
  });
}

/**
 * Renders the runner screen with `run-3` running, opens its log, and waits
 * for the first page. Each read answers every line up to the number of lines
 * `available()` says the run has written so far.
 */
async function openLiveLog(available: () => number) {
  const result = renderRunner({
    handlers: {
      [`GET ${runnerApiPath("nightly", "/history")}`]: {
        body: historyFixture({ items: [runningRun()] }),
      },
      [`GET ${logsPath()}`]: (call: RecordedCall) => {
        const since = Number(call.query.get("since") ?? 0);
        const upTo = available();
        const items: RunLogLineDto[] = [];
        for (let seq = since + 1; seq <= upTo; seq++) {
          items.push(logLine(seq));
        }
        return { body: livePage(items, upTo) };
      },
    },
  });
  await page().findByText("History");
  await waitFor(() => {
    if (!document.querySelector(".history-table")) {
      throw new Error("no history yet");
    }
  });
  fireEvent.click(
    within(page().getByTestId("history-row-run-3")).getByRole("button", {
      name: "Log",
    }),
  );
  await page().findByTestId("run-logs-run-3");
  return result;
}

/** Emits a `logs` hint inside `act`, then lets any read land. */
async function hint(runId: string, lastSeq: number): Promise<void> {
  await act(async () =>
    live.emit(
      runnerEvent({
        type: "logs",
        target: "nightly",
        id: runId,
        payload: { runId, lastSeq },
      }),
    ),
  );
  await settle(40);
}

describe("following a live run's log by its hint", () => {
  it("reads once, from the cursor, when a hint arrives for the run on screen", async () => {
    let written = 1;
    const { calls } = await openLiveLog(() => written);
    await waitFor(() => expect(lines()).toEqual(["line 1"]));
    await settle(40);
    expect(logCalls(calls)).toHaveLength(1);
    // The runner's channel is held for `logs` alone, besides the screen's
    // own invalidation.
    expect(
      live
        .activeSubscriptions()
        .some(
          (entry) =>
            entry.channels.includes("runner/nightly") &&
            entry.events?.join() === "logs",
        ),
    ).toBe(true);

    written = 3;
    await hint("run-3", 3);
    await waitFor(() =>
      expect(lines()).toEqual(["line 1", "line 2", "line 3"]),
    );
    expect(logCalls(calls)).toHaveLength(2);
    expect(logCalls(calls)[1]!.query.get("since")).toBe("1");
  });

  it("reads nothing for a hint about another run, or one it has already caught up with", async () => {
    const { calls } = await openLiveLog(() => 2);
    await waitFor(() => expect(lines()).toEqual(["line 1", "line 2"]));
    await settle(40);
    const before = logCalls(calls).length;

    await hint("run-9", 50);
    expect(logCalls(calls)).toHaveLength(before);

    // The settle hint of a run the view has already read to its end.
    await hint("run-3", 2);
    expect(logCalls(calls)).toHaveLength(before);
    expect(lines()).toEqual(["line 1", "line 2"]);
  });

  it("relaxes the poll while live, keeps it as a fallback, and says so", async () => {
    const { queryClient } = await openLiveLog(() => 1);
    await waitFor(() => expect(lines()).toEqual(["line 1"]));
    const query = queryClient
      .getQueryCache()
      .findAll({ queryKey: ["runner", "nightly", "run", "run-3"] })[0]!;
    const option = query.observers[0]!.options.refetchInterval;
    const interval =
      typeof option === "function" ? option(query as never) : option;
    expect(interval).toBe(RUN_LOG_POLL_MS * LIVE_SLOWDOWN);
    const notes = page().getByTestId("run-log-notes").textContent ?? "";
    expect(notes).toContain("the live socket says so");
    expect(notes).toContain(
      `A re-read every ${(RUN_LOG_POLL_MS * LIVE_SLOWDOWN) / 1000} s is the fallback`,
    );
    expect(page().getByTestId("run-logs-run-3").textContent).toContain(
      REDACTION_NOTE,
    );
  });
});

describe("with live updates off", () => {
  it("still tails the run by polling", async () => {
    live.setStatus({ state: "off" });
    jest.useFakeTimers();
    let written = 1;
    const { calls } = await openLiveLog(() => written);
    await advance(100, 10);
    expect(lines()).toEqual(["line 1"]);

    written = 2;
    await advance(RUN_LOG_POLL_MS);
    await advance(30, 10);
    expect(logCalls(calls)[1]!.query.get("since")).toBe("1");
    expect(lines()).toEqual(["line 1", "line 2"]);
    expect(page().getByTestId("run-log-notes").textContent).toContain(
      `re-read every ${RUN_LOG_POLL_MS / 1000} s`,
    );
  });
});
