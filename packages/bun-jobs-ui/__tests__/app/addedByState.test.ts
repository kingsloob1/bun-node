import { describe, expect, it } from "bun:test";
import {
  ADDED_BY_STATE_POLL_MS,
  addedByStateKey,
  addedByStateRequest,
} from "../../app/api/added";
import { serializeQuery } from "../../app/api/client";
import { MAX_ADDED_BY_STATE_SPAN_MS } from "../../app/api/contract";
import { jobListQuery, sortsByCreation } from "../../app/api/queues";
import { readJobFilters } from "../../app/screens/queues/jobFilters";

/** The pure helpers behind `features.addedByState`: the range guard, the key, the poll, the sort. */

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const LIMITS = { defaultPageSize: 20, maxPageSize: 100 };

describe("the added-by-state request", () => {
  it("resolves a preset against the clock", () => {
    expect(addedByStateRequest({ kind: "preset", seconds: 3600 }, NOW)).toEqual(
      { from: NOW - HOUR, to: NOW, clamped: false },
    );
  });

  it("never sends a span longer than the contract allows", () => {
    const week = {
      kind: "custom",
      from: NOW - 7 * 24 * HOUR,
      to: NOW,
    } as const;
    const request = addedByStateRequest(week, NOW);
    expect(request.to - request.from).toBe(MAX_ADDED_BY_STATE_SPAN_MS);
    // Its last day: the end is kept.
    expect(request.to).toBe(NOW);
    expect(request.clamped).toBe(true);
    // Exactly a day is allowed as is.
    const day = { kind: "custom", from: NOW - 24 * HOUR, to: NOW } as const;
    expect(addedByStateRequest(day, NOW).clamped).toBe(false);
  });

  it("keys a preset by its length and a custom range by its instants", () => {
    expect(addedByStateKey({ kind: "preset", seconds: 600 })).toEqual([
      "addedByState",
      { seconds: 600 },
    ]);
    expect(addedByStateKey({ kind: "custom", from: 1, to: 2 })).toEqual([
      "addedByState",
      { from: 1, to: 2 },
    ]);
    // Not under the Overview's prefix, which live events invalidate.
    expect(addedByStateKey({ kind: "preset", seconds: 600 })[0]).not.toBe(
      "overview",
    );
  });

  it("polls every 15–30 s, not at the Overview's 5 s", () => {
    expect(ADDED_BY_STATE_POLL_MS).toBeGreaterThanOrEqual(15_000);
    expect(ADDED_BY_STATE_POLL_MS).toBeLessThanOrEqual(30_000);
  });
});

describe("sort=createdAt on the job list", () => {
  const filters = (search: string, tab: Parameters<typeof readJobFilters>[1]) =>
    readJobFilters(new URLSearchParams(search), tab, LIMITS);

  it("is never sent without the flag, on any tab, counted or not", () => {
    for (const tab of ["all", "completed", "delayed"] as const) {
      for (const search of ["", "total=1", "order=asc"]) {
        const query = filters(search, tab);
        expect(serializeQuery(jobListQuery(query))).not.toContain("sort");
        expect(
          serializeQuery(jobListQuery(query, { createdOrder: false })),
        ).not.toContain("sort");
      }
    }
  });

  it("is sent with the flag, beside the order, on every tab", () => {
    expect(
      serializeQuery(
        jobListQuery(filters("", "completed"), { createdOrder: true }),
      ),
    ).toBe("?state=completed&limit=20&order=desc&sort=createdAt");
    expect(
      serializeQuery(
        jobListQuery(filters("order=asc", "all"), { createdOrder: true }),
      ),
    ).toBe("?limit=20&sort=createdAt");
  });

  it("is never combined with total=true: a counted page keeps its natural order", () => {
    const counted = filters("total=1", "dead");
    expect(sortsByCreation(counted, true)).toBe(false);
    expect(serializeQuery(jobListQuery(counted, { createdOrder: true }))).toBe(
      "?state=dead&limit=20&order=desc&total=true",
    );
  });
});
