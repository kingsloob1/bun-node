import type {
  EventWire,
  RunLogLineDto,
  RunLogPageDto,
} from "../../../app/api/types";
import { describe, expect, it } from "bun:test";
import { ApiError } from "../../../app/api/errors";
import {
  hasRunLogs,
  isLogsNotRetained,
  isRunNotFound,
  mergeRunLogPage,
  RUN_LOG_CATCHUP_MS,
  RUN_LOG_POLL_MS,
  RUN_LOG_TAIL_MAX,
  runLogHint,
  runLogHintNeedsRead,
  runLogKeys,
  runLogPageLimit,
  runLogsPath,
  runLogsRefetchInterval,
} from "../../../app/api/runnerLogs";
import {
  followingNote,
  formatClockTime,
  isRunLogStream,
  levelTone,
  streamOptions,
} from "../../../app/screens/runners/runLogFormat";

/** One line, `stdout` unless told otherwise. */
function line(seq: number, overrides: Partial<RunLogLineDto> = {}) {
  return {
    seq,
    at: 1_789_730_520_000 + seq,
    stream: "stdout",
    message: `line ${seq}`,
    ...overrides,
  } satisfies RunLogLineDto;
}

/** One page: `items`, with `lastSeq` defaulting to the run's own end. */
function pageOf(
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

describe("the run log tail", () => {
  it("takes the run's own dropped, capped, live and lastSeq from the page", () => {
    const tail = mergeRunLogPage(
      undefined,
      pageOf([line(4), line(5)], {
        dropped: 3,
        capped: true,
        live: true,
        lastSeq: 5,
      }),
    );
    expect(tail.lines.map((item) => item.seq)).toEqual([4, 5]);
    expect(tail).toMatchObject({
      dropped: 3,
      capped: true,
      live: true,
      lastSeq: 5,
      cursor: 5,
      trimmed: 0,
    });
  });

  it("appends the next page and never repeats a line it already has", () => {
    const first = mergeRunLogPage(undefined, pageOf([line(1), line(2)]));
    const second = mergeRunLogPage(
      first,
      pageOf([line(2), line(3)], { lastSeq: 3 }),
    );
    expect(second.lines.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(second.cursor).toBe(3);
  });

  it("advances the cursor to the last line received while a page has more, not to lastSeq", () => {
    // The run is at 900 lines; this page stopped at its limit on line 2.
    const tail = mergeRunLogPage(
      undefined,
      pageOf([line(1), line(2)], {
        page: { offset: 0, limit: 2, total: 900, hasMore: true },
        lastSeq: 900,
        live: true,
      }),
    );
    expect(tail.cursor).toBe(2);
    expect(tail.hasMore).toBe(true);
    expect(tail.lastSeq).toBe(900);
  });

  it("advances the cursor to lastSeq on a complete page, so a stream filter cannot re-read what it excluded", () => {
    // Only stderr was asked for: line 7 is the single match, the run is at 40.
    const tail = mergeRunLogPage(
      undefined,
      pageOf([line(7, { stream: "stderr" })], { lastSeq: 40 }),
    );
    expect(tail.cursor).toBe(40);
  });

  it("never moves the cursor backwards", () => {
    const first = mergeRunLogPage(undefined, pageOf([line(9)], { lastSeq: 9 }));
    const second = mergeRunLogPage(first, pageOf([], { lastSeq: 0 }));
    expect(second.cursor).toBe(9);
  });

  it("keeps the newest RUN_LOG_TAIL_MAX lines and counts what it let go", () => {
    const seqs = Array.from({ length: RUN_LOG_TAIL_MAX + 5 }, (_, i) => i + 1);
    const many = seqs.map((seq) => line(seq));
    const tail = mergeRunLogPage(undefined, pageOf(many));
    expect(tail.lines).toHaveLength(RUN_LOG_TAIL_MAX);
    expect(tail.lines[0]!.seq).toBe(6);
    expect(tail.trimmed).toBe(5);
  });
});

describe("the tail's polling", () => {
  it("catches up fast while a page has more, polls a live run, and stops on a finished one", () => {
    const more = mergeRunLogPage(
      undefined,
      pageOf([line(1)], {
        page: { offset: 0, limit: 1, total: 9, hasMore: true },
        live: false,
      }),
    );
    expect(runLogsRefetchInterval(more)).toBe(RUN_LOG_CATCHUP_MS);
    expect(
      runLogsRefetchInterval(
        mergeRunLogPage(undefined, pageOf([line(1)], { live: true })),
      ),
    ).toBe(RUN_LOG_POLL_MS);
    expect(
      runLogsRefetchInterval(
        mergeRunLogPage(undefined, pageOf([line(1)], { live: false })),
      ),
    ).toBe(false);
    expect(runLogsRefetchInterval(undefined)).toBe(false);
  });

  it("polls a live run at the interval it is given, and never relaxes the catch-up", () => {
    const live = mergeRunLogPage(undefined, pageOf([line(1)], { live: true }));
    expect(runLogsRefetchInterval(live, 60_000)).toBe(60_000);
    const more = mergeRunLogPage(
      undefined,
      pageOf([line(1)], {
        page: { offset: 0, limit: 1, total: 9, hasMore: true },
        live: true,
      }),
    );
    expect(runLogsRefetchInterval(more, 60_000)).toBe(RUN_LOG_CATCHUP_MS);
  });

  it("says a live log follows the hint only once live updates have relaxed the poll", () => {
    expect(followingNote(RUN_LOG_POLL_MS, RUN_LOG_POLL_MS)).toContain(
      "re-read every 2 s",
    );
    expect(followingNote(RUN_LOG_POLL_MS, RUN_LOG_POLL_MS)).toContain(
      "this is a poll",
    );
    const hinted = followingNote(60_000, RUN_LOG_POLL_MS);
    expect(hinted).toContain("the live socket says so");
    expect(hinted).toContain("A re-read every 60 s is the fallback");
  });
});

/** A runner event as the socket sends it. */
function runnerEvent(
  type: "logs" | "started",
  target: string,
  payload: Record<string, unknown>,
): EventWire {
  return { v: 1, kind: "runner", at: 1, target, type, payload } as EventWire;
}

describe("the `logs` hint", () => {
  it("reads the lastSeq of a hint about this run, and nothing from any other event", () => {
    expect(
      runLogHint(
        runnerEvent("logs", "nightly", { runId: "r1", lastSeq: 7 }),
        "nightly",
        "r1",
      ),
    ).toBe(7);
    // Another run of the same runner.
    expect(
      runLogHint(
        runnerEvent("logs", "nightly", { runId: "r2", lastSeq: 7 }),
        "nightly",
        "r1",
      ),
    ).toBeUndefined();
    // The same run id on another runner.
    expect(
      runLogHint(
        runnerEvent("logs", "other", { runId: "r1", lastSeq: 7 }),
        "nightly",
        "r1",
      ),
    ).toBeUndefined();
    // Another type about the run.
    expect(
      runLogHint(
        runnerEvent("started", "nightly", { runId: "r1" }),
        "nightly",
        "r1",
      ),
    ).toBeUndefined();
  });

  it("is worth a read before the first page and while the cursor is behind, not once it has caught up", () => {
    expect(runLogHintNeedsRead(undefined, 1)).toBe(true);
    const tail = mergeRunLogPage(
      undefined,
      pageOf([line(1), line(2)], { lastSeq: 2 }),
    );
    expect(runLogHintNeedsRead(tail, 3)).toBe(true);
    expect(runLogHintNeedsRead(tail, 2)).toBe(false);
    expect(runLogHintNeedsRead(tail, 1)).toBe(false);
  });
});

describe("what the run log module offers a screen", () => {
  it("offers a log unless the run's record says it was quiet", () => {
    expect(hasRunLogs({ logLines: 3, status: "success" })).toBe(true);
    // The only record that hides the log: a finished run, counted at zero.
    expect(hasRunLogs({ logLines: 0, status: "success" })).toBe(false);
    // The count lags by up to 250 ms while a run is live.
    expect(hasRunLogs({ logLines: 0, status: "running" })).toBe(true);
    expect(hasRunLogs({ status: "running" })).toBe(true);
    // No count at all says nothing about the run, so the read answers.
    expect(hasRunLogs({ status: "failed" })).toBe(true);
  });

  it("recognises 404 RUN_NOT_FOUND: an unknown run, or one that aged out", () => {
    expect(
      isRunNotFound(
        new ApiError({
          kind: "problem",
          status: 404,
          code: "RUN_NOT_FOUND",
          title: "Run not found",
        }),
      ),
    ).toBe(true);
    expect(isRunNotFound(new Error("nope"))).toBe(false);
  });

  it("recognises 409 LOGS_NOT_RETAINED, and nothing else", () => {
    const retained = new ApiError({
      kind: "problem",
      status: 409,
      code: "LOGS_NOT_RETAINED",
      title: "Run logs are not retained",
    });
    expect(isLogsNotRetained(retained)).toBe(true);
    expect(
      isLogsNotRetained(
        new ApiError({
          kind: "problem",
          status: 404,
          code: "RUN_NOT_FOUND",
          title: "Run not found",
        }),
      ),
    ).toBe(false);
    expect(isLogsNotRetained(new Error("nope"))).toBe(false);
  });

  it("percent-encodes the runner and the run in the path", () => {
    expect(runLogsPath("reports/daily run", "run 1/2")).toBe(
      "/runners/reports%2Fdaily%20run/runs/run%201%2F2/logs",
    );
  });

  it("keys a tail under its runner, per stream filter", () => {
    expect(runLogKeys.logs("nightly", "run-3")).toEqual([
      "runner",
      "nightly",
      "run",
      "run-3",
      "logs",
      { stream: null },
    ]);
    expect(runLogKeys.logs("nightly", "run-3", "stderr").at(-1)).toEqual({
      stream: "stderr",
    });
  });

  it("asks for the API's own default page size, capped by limits.maxLogPage", () => {
    expect(runLogPageLimit(500)).toBe(100);
    expect(runLogPageLimit(30)).toBe(30);
    expect(runLogPageLimit(0)).toBe(1);
  });
});

describe("how a run log line is labelled", () => {
  it("offers every stream the contract names, in its order, after the unfiltered choice", () => {
    expect(streamOptions().map((option) => option.value)).toEqual([
      "",
      "stdout",
      "stderr",
      "log",
    ]);
  });

  it("only accepts a stream the contract names", () => {
    expect(isRunLogStream("stderr")).toBe(true);
    expect(isRunLogStream("stdin")).toBe(false);
    expect(isRunLogStream(null)).toBe(false);
  });

  it("colours a level by its severity, and an unknown one neutrally", () => {
    expect(levelTone("trace")).toBe("neutral");
    expect(levelTone("debug")).toBe("neutral");
    expect(levelTone("info")).toBe("info");
    expect(levelTone("warn")).toBe("warning");
    expect(levelTone("error")).toBe("danger");
    expect(levelTone("fatal")).toBe("danger");
    // A level the contract has not got: neutral, not a crash.
    expect(levelTone("shout" as "info")).toBe("neutral");
  });

  it("shows a line's time of day to the millisecond, and says so for a time it cannot read", () => {
    expect(formatClockTime(Date.now())).toMatch(/^\d\d:\d\d:\d\d\.\d{3}$/);
    expect(formatClockTime(Number.NaN)).toBe("--:--:--.---");
  });
});
