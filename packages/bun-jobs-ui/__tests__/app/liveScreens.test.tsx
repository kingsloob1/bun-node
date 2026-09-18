import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { JobDto } from "../../app/api/types";
import type { RecordedCall } from "./mockFetch";
import { encodeJobId } from "@kingsleyweb/bun-jobs/api/contract";
import { describe, expect, it } from "bun:test";
import { jobKeys } from "../../app/api/jobs";
import { queryKeys } from "../../app/api/queryKeys";
import { queueKeys } from "../../app/api/queues";
import { runnerKeys } from "../../app/api/runners";
import { POLL_INTERVAL_MS } from "../../app/queryClient";
import { COUNT_EVENTS, DETAIL_EVENTS } from "../../app/screens/queues/live";
import { act, page, setupDom, waitFor } from "./dom";
import { permissionsFixture } from "./fixtures";
import {
  AWKWARD_ID,
  jobFixture as fullJobFixture,
  logPage,
} from "./job/fixtures";
import { renderJobScreen, settle } from "./job/render";
import {
  installLiveFake,
  LIVE_SLOWDOWN,
  queueEvent,
  runnerEvent,
} from "./liveFake";
import { renderQueue } from "./queues/fixtures";
import { renderApp } from "./renderApp";
import { renderRunner } from "./runners/fixtures";

setupDom();
const live = installLiveFake({
  state: "live",
  events: "push",
  publishing: true,
});

/** How many `GET <path>` were sent. */
function gets(calls: RecordedCall[], path: string): number {
  return calls.filter((call) => call.method === "GET" && call.path === path)
    .length;
}

/** Emits inside `act`, then lets the refetches land. */
async function emit(event: Parameters<typeof live.emit>[0]): Promise<void> {
  await act(async () => live.emit(event));
  await settle(30);
}

/** The refetch interval the observers of `key` use. */
function intervalOf(queryClient: QueryClient, key: QueryKey): unknown {
  const query = queryClient.getQueryCache().find({ queryKey: key });
  const option = query?.observers[0]?.options.refetchInterval;
  return typeof option === "function" ? option(query!) : option;
}

/** The enabled invalidations, as `{ channels, keys, events }`. */
function invalidations() {
  return live
    .activeInvalidations()
    .map(({ channels, keys, events }) => ({ channels, keys, events }));
}

describe("live Overview", () => {
  it("invalidates the totals and the queue table on `queues`, and relaxes their polling", async () => {
    const { calls, queryClient } = renderApp();
    await page().findByTestId("state-counts");
    await page().findByTestId("queue-row-emails");
    expect(invalidations()).toEqual(
      expect.arrayContaining([
        {
          channels: ["queues"],
          keys: [queryKeys.overview()],
          events: COUNT_EVENTS,
        },
        {
          channels: ["queues"],
          keys: [queryKeys.queues("")],
          events: COUNT_EVENTS,
        },
      ]),
    );
    expect(intervalOf(queryClient, queryKeys.overview())).toBe(
      POLL_INTERVAL_MS * LIVE_SLOWDOWN,
    );
    // The sparklines: no event announces a bucket, so they keep polling.
    expect(
      intervalOf(queryClient, queryKeys.queueThroughput("emails", 60)),
    ).toBe(30_000);

    const before = [gets(calls, "/overview"), gets(calls, "/queues")];
    await emit(queueEvent({ type: "completed", target: "emails", id: "1" }));
    await waitFor(() => expect(gets(calls, "/overview")).toBe(before[0]! + 1));
    expect(gets(calls, "/queues")).toBe(before[1]! + 1);

    // Progress changes no count.
    await emit(queueEvent({ type: "progress", target: "emails", id: "1" }));
    expect(gets(calls, "/overview")).toBe(before[0]! + 1);
  });

  it("polls at the base interval while not live", async () => {
    live.install({ state: "reconnecting", detail: "dropped" });
    const { queryClient } = renderApp();
    await page().findByTestId("state-counts");
    expect(intervalOf(queryClient, queryKeys.overview())).toBe(
      POLL_INTERVAL_MS,
    );
  });
});

describe("live Queues list", () => {
  it("invalidates its pages on `queues`", async () => {
    const { calls, queryClient } = renderQueue({ path: "/queues" });
    await page().findByTestId("queues-list");
    await page().findByTestId("queue-row-emails");
    expect(invalidations()).toEqual([
      { channels: ["queues"], keys: [queueKeys.pages], events: COUNT_EVENTS },
    ]);
    const before = gets(calls, "/queues");
    await emit(queueEvent({ type: "added", target: "reports", id: "9" }));
    await waitFor(() => expect(gets(calls, "/queues")).toBe(before + 1));
    const [pageKey] = queryClient
      .getQueryCache()
      .findAll({ queryKey: queueKeys.pages })
      .map((query) => query.queryKey);
    expect(intervalOf(queryClient, pageKey!)).toBe(
      POLL_INTERVAL_MS * LIVE_SLOWDOWN,
    );
  });

  it("does not subscribe without queues.list", async () => {
    renderQueue({
      path: "/queues",
      handlers: {
        "GET /meta/permissions": {
          body: permissionsFixture({ "queues.list": false }),
        },
      },
    });
    // The section is pruned, so the route is the 404 and nothing subscribes.
    await page().findByTestId("not-found");
    await settle(30);
    expect(live.channels()).toEqual([]);
  });
});

describe("live Queue screen", () => {
  it("subscribes to queue/<q> for counts, jobs, detail and repeatables", async () => {
    renderQueue();
    await page().findByTestId("queue-screen");
    await waitFor(() => expect(live.channels()).toEqual(["queue/emails"]));
    expect(invalidations()).toEqual(
      expect.arrayContaining([
        {
          channels: ["queue/emails"],
          keys: [queueKeys.counts("emails"), queueKeys.jobsAll("emails")],
          events: COUNT_EVENTS,
        },
        {
          channels: ["queue/emails"],
          keys: [queueKeys.detail("emails")],
          events: DETAIL_EVENTS,
        },
        {
          channels: ["queue/emails"],
          keys: [queueKeys.repeatables("emails")],
          events: ["repeatScheduled"],
        },
      ]),
    );
  });

  it("refetches counts and the jobs page on a state change, never on progress", async () => {
    const { calls } = renderQueue();
    await page().findByRole("table", { name: "Jobs in emails" });
    await waitFor(() => expect(live.channels()).toEqual(["queue/emails"]));
    const jobs = () => gets(calls, "/queues/emails/jobs");
    const counts = () => gets(calls, "/queues/emails/counts");
    const detail = () => gets(calls, "/queues/emails");

    const before = { jobs: jobs(), counts: counts(), detail: detail() };
    await emit(queueEvent({ type: "progress", target: "emails", id: "a" }));
    await emit(queueEvent({ type: "progress", target: "emails", id: "b" }));
    expect(jobs()).toBe(before.jobs);
    expect(counts()).toBe(before.counts);

    await emit(queueEvent({ type: "completed", target: "emails", id: "a" }));
    await waitFor(() => expect(jobs()).toBe(before.jobs + 1));
    expect(counts()).toBe(before.counts + 1);
    expect(detail()).toBe(before.detail);

    // Another queue's event is not this screen's.
    await emit(queueEvent({ type: "completed", target: "reports", id: "a" }));
    expect(jobs()).toBe(before.jobs + 1);
  });

  it("refetches the detail and counts on pause, resume, drain, clean and retry-all", async () => {
    const { calls } = renderQueue();
    await page().findByTestId("queue-screen");
    await waitFor(() => expect(live.channels()).toEqual(["queue/emails"]));
    const detail = () => gets(calls, "/queues/emails");
    const counts = () => gets(calls, "/queues/emails/counts");
    for (const type of DETAIL_EVENTS) {
      const before = { detail: detail(), counts: counts() };
      await emit(
        queueEvent({
          type,
          target: "emails",
          payload:
            type === "drained"
              ? { count: 1 }
              : type === "cleaned"
                ? { ids: ["x"], state: "completed" }
                : type === "retried"
                  ? { ids: ["x"] }
                  : {},
        }),
      );
      await waitFor(() => expect(detail()).toBe(before.detail + 1));
      expect(counts()).toBe(before.counts + 1);
    }
  });

  it("keeps workers and throughput on their own polling", async () => {
    const { queryClient } = renderQueue({
      path: "/queues/emails?panel=workers",
    });
    await page().findByTestId("queue-screen");
    await waitFor(() =>
      expect(
        queryClient
          .getQueryCache()
          .find({ queryKey: queueKeys.workers("emails") }),
      ).toBeTruthy(),
    );
    expect(intervalOf(queryClient, queueKeys.workers("emails"))).toBe(
      POLL_INTERVAL_MS * 2,
    );
    expect(intervalOf(queryClient, queueKeys.counts("emails"))).toBe(
      POLL_INTERVAL_MS * LIVE_SLOWDOWN,
    );
  });

  it("does not subscribe while the queue is unreadable", async () => {
    renderQueue({
      handlers: {
        "GET /meta/permissions": {
          body: permissionsFixture({ "queues.read": false }),
        },
      },
    });
    await page().findByTestId("queue-screen");
    await settle(50);
    expect(live.channels()).toEqual([]);
  });
});

describe("live Job screen", () => {
  const channel = `queue/emails/job/${encodeJobId(AWKWARD_ID)}`;

  it("subscribes to the job's channel and refetches it, its logs and children on a state change", async () => {
    const job = fullJobFixture("active");
    const { calls } = await renderJobScreen(job, {
      handlers: {
        [`GET /queues/emails/jobs/${encodeURIComponent(AWKWARD_ID)}/logs`]: {
          body: logPage(0, 100, "asc", 3),
        },
      },
    });
    await waitFor(() => expect(live.channels()).toEqual([channel]));
    expect(invalidations()).toEqual([
      {
        channels: [channel],
        keys: [jobKeys.job("emails", AWKWARD_ID)],
        events: expect.not.arrayContaining(["progress"]),
      },
    ]);
    expect(
      live.activeSubscriptions().map(({ channels, events }) => ({
        channels,
        events,
      })),
    ).toEqual([{ channels: [channel], events: ["progress"] }]);

    const path = `/queues/emails/jobs/${encodeURIComponent(AWKWARD_ID)}`;
    await waitFor(() => expect(gets(calls, `${path}/logs`)).toBeGreaterThan(0));
    const before = {
      job: gets(calls, path),
      logs: gets(calls, `${path}/logs`),
    };
    await emit(
      queueEvent({ type: "completed", target: "emails", id: AWKWARD_ID }),
    );
    await waitFor(() => expect(gets(calls, path)).toBe(before.job + 1));
    expect(gets(calls, `${path}/logs`)).toBe(before.logs + 1);
  });

  it("writes progress into the cached job without a refetch", async () => {
    const job = fullJobFixture("active", { progress: 10 });
    const { calls, queryClient } = await renderJobScreen(job);
    await waitFor(() => expect(live.channels()).toEqual([channel]));
    const path = `/queues/emails/jobs/${encodeURIComponent(AWKWARD_ID)}`;
    const before = gets(calls, path);
    await emit(
      queueEvent({
        type: "progress",
        target: "emails",
        id: AWKWARD_ID,
        payload: { id: AWKWARD_ID, progress: 64 },
      }),
    );
    expect(
      queryClient.getQueryData<JobDto>(jobKeys.job("emails", AWKWARD_ID))
        ?.progress,
    ).toBe(64);
    expect(gets(calls, path)).toBe(before);
  });

  it("relaxes an unfinished job's polling while live", async () => {
    const { queryClient } = await renderJobScreen(fullJobFixture("active"));
    await waitFor(() =>
      expect(intervalOf(queryClient, jobKeys.job("emails", AWKWARD_ID))).toBe(
        POLL_INTERVAL_MS * LIVE_SLOWDOWN,
      ),
    );
  });

  it("does not subscribe without jobs.read", async () => {
    await renderJobScreen(fullJobFixture(), {
      permissions: permissionsFixture({ "jobs.read": false }),
    });
    await settle(50);
    expect(live.channels()).toEqual([]);
  });
});

describe("live Runners", () => {
  it("the list invalidates every runner list on `runners`", async () => {
    const { calls } = renderRunner({ path: "/runners" });
    await page().findByTestId("runners-list");
    await waitFor(() => expect(live.channels()).toEqual(["runners"]));
    expect(invalidations()).toEqual([
      { channels: ["runners"], keys: [runnerKeys.all], events: undefined },
    ]);
    const before = gets(calls, "/runners");
    await emit(runnerEvent({ type: "started", target: "nightly", id: "r1" }));
    await waitFor(() => expect(gets(calls, "/runners")).toBe(before + 1));
  });

  it("a runner's screen invalidates its detail, stats and history on runner/<id>", async () => {
    const { calls, queryClient } = renderRunner();
    await page().findByTestId("runner-screen");
    await waitFor(() => expect(live.channels()).toEqual(["runner/nightly"]));
    expect(invalidations()).toEqual([
      {
        channels: ["runner/nightly"],
        keys: [runnerKeys.runner("nightly")],
        events: undefined,
      },
    ]);
    await waitFor(() =>
      expect(gets(calls, "/runners/nightly/history")).toBeGreaterThan(0),
    );
    const before = {
      detail: gets(calls, "/runners/nightly"),
      stats: gets(calls, "/runners/nightly/stats"),
      history: gets(calls, "/runners/nightly/history"),
    };
    await emit(
      runnerEvent({
        type: "succeeded",
        target: "nightly",
        id: "r1",
        payload: { runId: "r1", durationMs: 5 },
      }),
    );
    await waitFor(() =>
      expect(gets(calls, "/runners/nightly")).toBe(before.detail + 1),
    );
    expect(gets(calls, "/runners/nightly/stats")).toBe(before.stats + 1);
    expect(gets(calls, "/runners/nightly/history")).toBe(before.history + 1);
    expect(intervalOf(queryClient, runnerKeys.detail("nightly"))).toBe(
      15_000 * LIVE_SLOWDOWN,
    );

    // Another runner's event is not this screen's.
    await emit(runnerEvent({ type: "started", target: "other", id: "r2" }));
    expect(gets(calls, "/runners/nightly")).toBe(before.detail + 1);
  });

  it("does not subscribe to a runner without runners.read", async () => {
    renderRunner({
      permissions: permissionsFixture({ "runners.read": false }),
    });
    await settle(80);
    expect(live.channels()).toEqual([]);
  });

  it("re-fetches on a gap", async () => {
    const { calls } = renderRunner();
    await page().findByTestId("runner-screen");
    await waitFor(() => expect(live.channels()).toEqual(["runner/nightly"]));
    const before = gets(calls, "/runners/nightly");
    await act(async () =>
      live.gap({
        type: "gap",
        epoch: "e",
        fromSeq: 1,
        toSeq: 4,
        reason: "slow-consumer",
      }),
    );
    await waitFor(() =>
      expect(gets(calls, "/runners/nightly")).toBe(before + 1),
    );
  });
});
