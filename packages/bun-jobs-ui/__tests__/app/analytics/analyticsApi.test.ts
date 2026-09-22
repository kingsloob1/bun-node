import type { TimeRange } from "../../../app/analytics/range";
import { describe, expect, it } from "bun:test";
import {
  analyticsKeys,
  analyticsQuery,
  analyticsRequest,
  axisBounds,
  derivedInFlight,
  describeResolution,
  getJobsAnalytics,
  getQueueJobsAnalytics,
  getRunnerAnalytics,
  getRunnersAnalytics,
  getWorkerAnalytics,
  getWorkersAnalytics,
  rangeKey,
  requestResolution,
} from "../../../app/api/analytics";
import { createApiClient } from "../../../app/api/client";
import {
  DEFAULT_ANALYTICS_RESOLUTION,
  MAX_ANALYTICS_SERIES,
} from "../../../app/api/contract";
import {
  jobsSeriesFixture,
  metaFixture,
  rangeFixture,
  runnersAnalyticsFixture,
  uiConfig,
  workersAnalyticsFixture,
} from "../fixtures";
import { mockFetch } from "../mockFetch";

/** The clock every resolution in here is measured against. */
const NOW = 1_789_730_400_000;

/** What `/meta` reports about analytics in the fixture: both resolutions served. */
const ANALYTICS = metaFixture().analytics!;

/** A client over a mock answering every analytics route from the fixtures. */
function client() {
  const mock = mockFetch({
    "GET /analytics/jobs": { body: jobsSeriesFixture() },
    "GET /queues/a%2Fb/analytics/jobs": { body: jobsSeriesFixture() },
    "GET /analytics/runners": (call) => ({
      body: runnersAnalyticsFixture(undefined, {
        ids: call.query.getAll("ids"),
      }),
    }),
    "GET /analytics/workers": (call) => ({
      body: workersAnalyticsFixture(undefined, {
        keys: call.query.getAll("keys"),
      }),
    }),
    "GET /runners/nightly/analytics": {
      body: { runs: { ...jobsSeriesFixture(), buckets: [] }, runningNow: 2 },
    },
    "GET /queues/emails/analytics/workers/w%2F1": {
      body: { jobs: { ...jobsSeriesFixture(), buckets: [] } },
    },
  });
  return {
    api: createApiClient(uiConfig(), { fetch: mock.fetch }),
    calls: mock.calls,
  };
}

describe("resolving a range into a request", () => {
  it("asks for the resolution the range wants, whatever the deployment keeps", () => {
    const short: TimeRange = { kind: "preset", seconds: 600 };
    const long: TimeRange = { kind: "preset", seconds: 3600 };
    expect(requestResolution(short, NOW)).toBe(1);
    expect(requestResolution(long, NOW)).toBe(DEFAULT_ANALYTICS_RESOLUTION);
    // Not pre-coarsened to `meta.analytics.resolutions`: a minutes-only
    // backend (the file driver) is still asked for seconds, so that it
    // answers `clamped` with `reason: "driver"` and the caption can say why
    // "the last 60 seconds" came back in minutes. Asked for a minute, it
    // answers unclamped and the section says nothing.
    expect(requestResolution({ kind: "preset", seconds: 60 }, NOW)).toBe(1);
  });

  it("resolves a preset against the clock and a custom range to its instants", () => {
    // A preset starts at the first whole bucket inside its window (NOW is on
    // a minute boundary, so that is one minute in).
    expect(analyticsRequest({ kind: "preset", seconds: 3600 }, NOW)).toEqual({
      from: NOW - 3_600_000 + 60_000,
      to: NOW,
      resolution: 60,
    });
    expect(
      analyticsRequest(
        { kind: "custom", from: NOW - 120_000, to: NOW - 60_000 },
        NOW,
      ),
    ).toEqual({ from: NOW - 120_000, to: NOW - 60_000, resolution: 1 });
  });

  it("starts a preset a whole bucket in, so skew cannot clamp the last 24 hours", () => {
    const day: TimeRange = { kind: "preset", seconds: 86_400 };
    const retention = 86_400_000;
    // The server's bucket rule: clamped for retention when the bucket `from`
    // falls in is older than the bucket `serverNow − retention` falls in.
    const clamped = (from: number, serverNow: number) =>
      Math.floor(from / 60_000) < Math.floor((serverNow - retention) / 60_000);
    // Client clocks a few ms before a minute boundary, the server's past it:
    // the old `now − 24 h` fell on the wrong side of the line.
    for (const clientNow of [NOW - 1, NOW - 20, NOW + 59_999]) {
      const serverNow = clientNow + 30_000;
      expect(clamped(clientNow - retention, serverNow)).toBe(true);
      const request = analyticsRequest(day, clientNow);
      expect(request.from % 60_000).toBe(0);
      expect(request.from).toBeGreaterThan(clientNow - retention);
      expect(request.from - (clientNow - retention)).toBeLessThanOrEqual(
        60_000,
      );
      expect(clamped(request.from, serverNow)).toBe(false);
    }
    // At per-second resolution the slack is one second.
    expect(
      analyticsRequest({ kind: "preset", seconds: 300 }, NOW + 400),
    ).toEqual({
      from: NOW - 300_000 + 1_000,
      to: NOW + 400,
      resolution: 1,
    });
  });

  it("sends from/to/resolution and never the deprecated `minutes`", () => {
    const query = analyticsQuery({ from: 1, to: 2, resolution: 60 });
    expect(query).toEqual({ from: 1, to: 2, resolution: 60 });
    expect("minutes" in query).toBe(false);
  });
});

describe("analytics query keys", () => {
  it("keeps two ranges apart, and a prefix an invalidation can target", () => {
    const hour = rangeKey({ kind: "preset", seconds: 3600 }, 60);
    const tenMinutes = rangeKey({ kind: "preset", seconds: 600 }, 1);
    const custom = rangeKey({ kind: "custom", from: 1, to: 2 }, 1);
    expect(analyticsKeys.jobs(hour)).not.toEqual(
      analyticsKeys.jobs(tenMinutes),
    );
    expect(analyticsKeys.jobs(custom)).not.toEqual(
      analyticsKeys.jobs(rangeKey({ kind: "custom", from: 1, to: 3 }, 1)),
    );
    // Same range, different resolution asked for: different entries.
    expect(
      analyticsKeys.jobs(rangeKey({ kind: "preset", seconds: 600 }, 60)),
    ).not.toEqual(analyticsKeys.jobs(tenMinutes));
    // The prefix an invalidation targets, the way `overviewAll` does.
    for (const key of [
      analyticsKeys.jobs(hour),
      analyticsKeys.queueJobs("emails", hour),
      analyticsKeys.runners(hour),
      analyticsKeys.runnerSeries(["a"], hour),
      analyticsKeys.workers(hour),
      analyticsKeys.workerSeries(["a"], hour),
    ]) {
      expect(key.slice(0, 1)).toEqual([...analyticsKeys.all]);
    }
    expect(analyticsKeys.jobs(hour).slice(0, 2)).toEqual([
      ...analyticsKeys.jobsAll,
    ]);
    expect(analyticsKeys.runners(hour).slice(0, 2)).toEqual([
      ...analyticsKeys.runnersAll,
    ]);
    expect(analyticsKeys.workers(hour).slice(0, 2)).toEqual([
      ...analyticsKeys.workersAll,
    ]);
    expect(analyticsKeys.queueJobs("emails", hour).slice(0, 4)).toEqual([
      ...analyticsKeys.queueJobsAll("emails"),
    ]);
  });

  it("does not put a rolling preset's instants in the key", () => {
    // The same preset read a minute apart is one cache entry that refetches,
    // not two; only a custom range carries instants.
    const a = rangeKey({ kind: "preset", seconds: 3600 }, 60);
    const b = rangeKey({ kind: "preset", seconds: 3600 }, 60);
    expect(analyticsKeys.jobs(a)).toEqual(analyticsKeys.jobs(b));
    expect(JSON.stringify(a)).not.toContain(String(NOW));
  });

  it("keys a batch by the names it asks for, so one page is not another's entry", () => {
    const hour = rangeKey({ kind: "preset", seconds: 3600 }, 60);
    expect(analyticsKeys.workerSeries(["a", "b"], hour)).not.toEqual(
      analyticsKeys.workerSeries(["c", "d"], hour),
    );
  });
});

describe("the analytics reads", () => {
  const request = { from: NOW - 3_600_000, to: NOW, resolution: 60 } as const;

  it("reads the namespace and one queue's jobs series", async () => {
    const { api, calls } = client();
    await getJobsAnalytics(api, request);
    await getQueueJobsAnalytics(api, "a/b", request);
    expect(calls.map((call) => call.path)).toEqual([
      "/analytics/jobs",
      // The queue is percent-encoded into the path segment.
      "/queues/a%2Fb/analytics/jobs",
    ]);
    for (const call of calls) {
      expect(call.query.get("from")).toBe(String(request.from));
      expect(call.query.get("to")).toBe(String(request.to));
      expect(call.query.get("resolution")).toBe("60");
      expect(call.query.get("minutes")).toBeNull();
    }
  });

  it("reads the runners roll-up without `ids`, and the batch with one `ids` per name", async () => {
    const { api, calls } = client();
    const rollup = await getRunnersAnalytics(api, request);
    expect(rollup.seriesByRunner).toBeUndefined();
    expect(calls[0]!.query.getAll("ids")).toEqual([]);
    const batch = await getRunnersAnalytics(api, request, [
      "nightly",
      "hourly",
    ]);
    expect(calls[1]!.query.getAll("ids")).toEqual(["nightly", "hourly"]);
    expect(batch.seriesByRunner?.map((entry) => entry.runner)).toEqual([
      "nightly",
      "hourly",
    ]);
    // An empty list is the same as none: no `ids=` at all.
    await getRunnersAnalytics(api, request, []);
    expect(calls[2]!.query.has("ids")).toBe(false);
  });

  it("reads the workers roll-up and its batch, keyed by the stable key", async () => {
    const { api, calls } = client();
    await getWorkersAnalytics(api, request);
    const batch = await getWorkersAnalytics(api, request, [
      "emails-1",
      "reports-1",
    ]);
    expect(calls[1]!.query.getAll("keys")).toEqual(["emails-1", "reports-1"]);
    expect(batch.seriesByKey?.map((entry) => entry.key)).toEqual([
      "emails-1",
      "reports-1",
    ]);
  });

  it("reads one runner and one worker, percent-encoding both segments", async () => {
    const { api, calls } = client();
    const runner = await getRunnerAnalytics(api, "nightly", request);
    expect(runner.runningNow).toBe(2);
    await getWorkerAnalytics(api, "emails", "w/1", request);
    expect(calls.map((call) => call.path)).toEqual([
      "/runners/nightly/analytics",
      "/queues/emails/analytics/workers/w%2F1",
    ]);
  });

  it("never asks for more series than the contract's batch cap", () => {
    // The page size the sections use IS the cap, so one page is one request.
    expect(ANALYTICS.maxSeries).toBe(MAX_ANALYTICS_SERIES);
  });
});

describe("reading a response's range", () => {
  it("names the resolution served, not the one asked for", () => {
    expect(describeResolution(rangeFixture({ resolution: 1 }))).toBe(
      "1-second buckets",
    );
    expect(describeResolution(rangeFixture({ resolution: 60 }))).toBe(
      "1-minute buckets",
    );
  });

  it("puts the axis at from…end, with the last bucket at `to`", () => {
    const range = rangeFixture({ resolution: 60 }, 3);
    expect(axisBounds(range)).toEqual({
      start: range.from,
      end: range.to + range.interval,
      lastBucket: range.to,
    });
    // `end` is NOT `to`: getting that wrong shifts every chart by a bucket.
    expect(range.end).toBe(range.to + range.interval);
  });
});

describe("the derived in-flight series", () => {
  it("accumulates started minus finished, and never goes below zero", () => {
    const bucket = (started: number, succeeded: number, failed = 0) => ({
      at: 0,
      started,
      succeeded,
      failed,
      timeout: 0,
      killed: 0,
      skipped: 0,
    });
    expect(
      derivedInFlight([bucket(3, 0), bucket(1, 2), bucket(0, 2), bucket(0, 5)]),
    ).toEqual([3, 2, 0, 0]);
  });
});
