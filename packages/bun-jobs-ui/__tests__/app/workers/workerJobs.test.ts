import type { JobListFilters } from "../../../app/api/queues";
import { describe, expect, it } from "bun:test";
import { rangeProblem } from "../../../app/analytics/range";
import { serializeQuery } from "../../../app/api/client";
import {
  isSendableFilterValue,
  jobListQuery,
  queueKeys,
} from "../../../app/api/queues";
import {
  DEFAULT_FINISHED_RANGE,
  rangeApplies,
  readFinishedRange,
  readWorkerJobFilters,
  writeFinishedRange,
} from "../../../app/screens/workers/workerJobs";

/**
 * The job-attribution half of the jobs reader, and the worker page's URL
 * state: pure, no DOM.
 */

const LIMITS = { defaultPageSize: 20, maxPageSize: 100 };
const NOW = 1_789_730_520_000;
const DAY = 86_400_000;

/** A jobs page filtered to one key over the last 24 hours. */
function keyFilters(overrides: Partial<JobListFilters> = {}): JobListFilters {
  return {
    ...readWorkerJobFilters(
      new URLSearchParams(""),
      "all",
      "api.emails",
      LIMITS,
    ),
    ...overrides,
  };
}

describe("jobListQuery's attribution filters", () => {
  it("drops all four when the flag is false or absent, whatever the filters hold", () => {
    const filters = keyFilters({
      attribution: {
        workerKeys: ["api.emails"],
        workerIds: ["api.emails.a1"],
        finished: { kind: "between", from: NOW - DAY, to: NOW },
      },
    });
    for (const query of [
      jobListQuery(filters),
      jobListQuery(filters, { attribution: false, now: NOW }),
    ]) {
      const text = serializeQuery(query);
      for (const param of [
        "workerKey",
        "workerId",
        "finishedFrom",
        "finishedTo",
      ]) {
        expect(text).not.toContain(param);
      }
    }
  });

  it("sends a rolling window as finishedFrom alone, resolved at call time", () => {
    const text = serializeQuery(
      jobListQuery(keyFilters(), { attribution: true, now: NOW }),
    );
    expect(text).toBe(
      `?limit=20&order=desc&workerKey=api.emails&finishedFrom=${NOW - DAY}`,
    );
    // Later, the same filters cover a later window.
    expect(
      serializeQuery(
        jobListQuery(keyFilters(), { attribution: true, now: NOW + 1_000 }),
      ),
    ).toContain(`finishedFrom=${NOW - DAY + 1_000}`);
  });

  it("sends a fixed span as both ends, and each key and id as its own value", () => {
    const text = serializeQuery(
      jobListQuery(
        keyFilters({
          attribution: {
            workerKeys: ["a", "b"],
            workerIds: ["a.1"],
            finished: { kind: "between", from: 10, to: 20 },
          },
        }),
        { attribution: true, now: NOW },
      ),
    );
    expect(text).toBe(
      "?limit=20&order=desc&workerKey=a&workerKey=b&workerId=a.1&finishedFrom=10&finishedTo=20",
    );
  });

  it("sends no range and no empty lists when there are none", () => {
    const text = serializeQuery(
      jobListQuery(
        keyFilters({
          state: "active",
          attribution: { workerKeys: [], workerIds: [], finished: null },
        }),
        { attribution: true },
      ),
    );
    expect(text).toBe("?state=active&limit=20&order=desc");
  });

  it("keys the page by the window's identity, not the instants it resolves to", () => {
    const key = queueKeys.jobs("emails", keyFilters());
    expect(key.slice(0, 3)).toEqual(["queue", "emails", "jobs"]);
    expect(JSON.stringify(key)).toContain('"workerKeys":["api.emails"]');
    expect(JSON.stringify(key)).toContain(
      '"finished":{"kind":"last","ms":86400000}',
    );
  });

  it("refuses a value holding a comma, which the API would split", () => {
    expect(isSendableFilterValue("api.emails")).toBe(true);
    expect(isSendableFilterValue("a,b")).toBe(false);
    expect(isSendableFilterValue("")).toBe(false);
  });
});

describe("the worker page's jobs URL state", () => {
  it("defaults to every state, newest first, the last 24 hours, never a total", () => {
    expect(keyFilters()).toEqual({
      state: null,
      offset: 0,
      limit: 20,
      order: "desc",
      names: [],
      search: "",
      total: false,
      attribution: {
        workerKeys: ["api.emails"],
        workerIds: [],
        finished: { kind: "last", ms: DAY },
      },
    });
  });

  it("reads its prefixed parameters, and ignores the queue table's", () => {
    const filters = readWorkerJobFilters(
      new URLSearchParams(
        "jobOffset=40&jobLimit=500&jobOrder=asc&jobName=a,b&jobSearch=x&finished=3600s&total=1&state=failed&offset=9",
      ),
      "completed",
      "k",
      LIMITS,
    );
    expect(filters).toEqual({
      state: "completed",
      offset: 40,
      limit: 100,
      order: "asc",
      names: ["a", "b"],
      search: "x",
      total: false,
      attribution: {
        workerKeys: ["k"],
        workerIds: [],
        finished: { kind: "last", ms: 3_600_000 },
      },
    });
  });

  it("drops the range for a state a job has no finishedOn in", () => {
    for (const state of [
      "waiting",
      "delayed",
      "active",
      "failed",
      "waiting-children",
    ] as const) {
      expect(rangeApplies(state)).toBe(false);
      const filters = readWorkerJobFilters(
        new URLSearchParams("finished=3600s"),
        state,
        "k",
        LIMITS,
      );
      expect(filters.attribution?.finished).toBeNull();
    }
    expect(rangeApplies("all")).toBe(true);
    expect(rangeApplies("completed")).toBe(true);
    expect(rangeApplies("dead")).toBe(true);
  });

  it("round-trips the range, leaving out only its own default", () => {
    expect(writeFinishedRange(DEFAULT_FINISHED_RANGE)).toBeNull();
    // The analytics default is NOT this section's, so it is written.
    expect(writeFinishedRange({ kind: "preset", seconds: 3600 })).toBe("3600s");
    expect(readFinishedRange("3600s")).toEqual({
      kind: "preset",
      seconds: 3600,
    });
    expect(readFinishedRange(null)).toEqual(DEFAULT_FINISHED_RANGE);
    // A custom span longer than analytics keeps is fine: the API bounds none.
    const long = { kind: "custom", from: NOW - 90 * DAY, to: NOW } as const;
    expect(readFinishedRange(writeFinishedRange(long))).toEqual(long);
  });

  it("falls back to the last 24 hours on anything malformed", () => {
    for (const raw of [
      "",
      "7s",
      "abc",
      "20-10",
      "5-5",
      "1-2-3",
      "99999999999999999999-1",
    ]) {
      expect(readFinishedRange(raw)).toEqual(DEFAULT_FINISHED_RANGE);
    }
  });

  it("lets a picker with no longest span take any length", () => {
    expect(rangeProblem(NOW - 90 * DAY, NOW, null)).toBeNull();
    expect(rangeProblem(NOW, NOW - 1, null)).toBe(
      "The end must be after the start.",
    );
  });
});
