import type { MockHandler, MockReply } from "../mockFetch";
import { describe, expect, it } from "bun:test";
import { MAX_ANALYTICS_SERIES } from "../../../app/api/contract";
import { fireEvent, page, setupDom, waitFor, within } from "../dom";
import {
  ANALYTICS_NOW,
  clampedRangeFixture,
  metaFixture,
  permissionsFixture,
  problem,
  runnersAnalyticsFixture,
  workersAnalyticsFixture,
} from "../fixtures";
import { renderApp } from "../renderApp";

setupDom();

/** The Overview once its counts have rendered. */
async function overview() {
  const screen = await page().findByTestId("overview");
  await within(screen).findByTestId("state-counts");
  return screen;
}

/** A namespace with `count` worker keys, all reported in one roll-up read. */
function workerKeys(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `worker-${i + 1}`);
}

/** Renders the Overview with the given analytics handlers merged in. */
function renderOverview(
  handlers: Record<string, MockHandler | MockReply> = {},
) {
  return renderApp({ handlers });
}

describe("the Overview's Workers section", () => {
  it("costs two requests for a namespace with 214 workers, not 214", async () => {
    const keys = workerKeys(214);
    const { calls } = renderOverview({
      "GET /analytics/workers": (call) => ({
        body: workersAnalyticsFixture(keys.slice(0, 100), {
          keys: call.query.getAll("keys"),
          // The API caps its rows at MAX_ANALYTICS_ROWS and says so.
          truncated: true,
        }),
      }),
    });
    await overview();
    await page().findByTestId("worker-analytics-row-worker-1");

    const reads = calls.filter((call) => call.path === "/analytics/workers");
    // One roll-up (no `keys`) and one batch for the visible page. That is the
    // whole cost: a series per worker would be 214 requests.
    expect(reads).toHaveLength(2);
    expect(reads[0]!.query.has("keys")).toBe(false);
    const batch = reads[1]!.query.getAll("keys");
    expect(batch).toHaveLength(MAX_ANALYTICS_SERIES);
    expect(batch).toEqual(keys.slice(0, MAX_ANALYTICS_SERIES));
    // And the page is bounded: only the batch's rows are on screen.
    const table = page().getByRole("table", { name: "Workers" });
    // Minus the header row.
    expect(within(table).getAllByRole("row").length - 1).toBe(
      MAX_ANALYTICS_SERIES,
    );
    expect(
      page().queryByTestId(
        `worker-analytics-row-worker-${MAX_ANALYTICS_SERIES + 1}`,
      ),
    ).toBeNull();
  });

  it("links a row's worker key to its worker page and its queue to the queue", async () => {
    renderOverview();
    await overview();
    const row = await page().findByTestId("worker-analytics-row-emails-1");
    const [key, queue] = within(row).getAllByRole("link");
    // The key's page is addressed by queue and key: a key is unique only
    // within its queue.
    expect(key!.getAttribute("href")).toContain("/workers/emails/emails-1");
    expect(key!.textContent).toBe("emails-1");
    expect(queue!.getAttribute("href")).toContain("/queues/emails");
    expect(queue!.textContent).toBe("emails");
  });

  it("leaves the key as text where the worker pages are not routed", async () => {
    // No `workers.list`: the Workers nav entry is absent, so the app never
    // registers `/workers/:queue/:key` and a link would lead nowhere.
    renderOverview({
      "GET /meta/permissions": {
        body: permissionsFixture({ "workers.list": false }),
      },
    });
    await overview();
    const row = await page().findByTestId("worker-analytics-row-emails-1");
    expect(row.textContent).toContain("emails-1");
    const links = within(row).getAllByRole("link");
    // Only the queue is still linked.
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toContain("/queues/emails");
  });

  it("leaves the queue as text without `queues.list`", async () => {
    renderOverview({
      "GET /meta/permissions": {
        body: permissionsFixture({ "queues.list": false }),
      },
    });
    await overview();
    const row = await page().findByTestId("worker-analytics-row-emails-1");
    expect(row.textContent).toContain("emails");
    expect(
      within(row)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).not.toContain("/jobs/queues/emails");
  });

  it("shows no pager when every row fits one page", async () => {
    // The default fixture holds two worker keys against a page of
    // MAX_ANALYTICS_SERIES, so there is nothing to page. Every other table in
    // the app hides its pager there; these two used to show one.
    renderOverview();
    await overview();
    await page().findByTestId("worker-analytics-row-emails-1");
    expect(
      page().queryByRole("navigation", { name: "Worker pages" }),
    ).toBeNull();
    expect(
      page().queryByRole("navigation", { name: "Runner pages" }),
    ).toBeNull();
  });

  it("names how many rows the range holds when `truncated`", async () => {
    renderOverview({
      "GET /analytics/workers": (call) => ({
        body: workersAnalyticsFixture(workerKeys(100), {
          keys: call.query.getAll("keys"),
          truncated: true,
          // The API caps its rows at 100 but knows there are 214.
          totalRows: 214,
        }),
      }),
    });
    await overview();
    const note = await page().findByTestId("workers-truncated");
    expect(note.textContent).toContain("100 busiest worker keys of 214");
    // The headline counts every key, not the page or the capped rows.
    const totals = document.querySelector('[aria-label="Worker totals"]');
    expect(totals?.textContent).toContain("Worker keys214");
    expect(note.textContent).toContain("214");
  });

  it("fetches one more batch — and no more roll-ups — when a page is turned", async () => {
    const keys = workerKeys(100);
    const { calls } = renderOverview({
      "GET /analytics/workers": (call) => ({
        body: workersAnalyticsFixture(keys, {
          keys: call.query.getAll("keys"),
        }),
      }),
    });
    await overview();
    await page().findByTestId("worker-analytics-row-worker-1");
    const before = calls.filter(
      (call) => call.path === "/analytics/workers",
    ).length;
    fireEvent.click(
      within(
        page().getByRole("navigation", { name: "Worker pages" }),
      ).getByRole("button", { name: "Next" }),
    );
    await page().findByTestId(
      `worker-analytics-row-worker-${MAX_ANALYTICS_SERIES + 1}`,
    );
    const reads = calls.filter((call) => call.path === "/analytics/workers");
    expect(reads).toHaveLength(before + 1);
    expect(reads.at(-1)!.query.getAll("keys")).toEqual(
      keys.slice(MAX_ANALYTICS_SERIES, MAX_ANALYTICS_SERIES * 2),
    );
  });

  it("draws each row's sparkline from the batch, labelled with the resolution served", async () => {
    renderOverview();
    await overview();
    const spark = await page().findByRole("img", {
      name: /^emails-1: 12 completed, 1 failed, 1-minute buckets/,
    });
    expect(spark.tagName.toLowerCase()).toBe("svg");
  });

  it("captions the section from the response's own clamped range", async () => {
    renderOverview({
      "GET /analytics/workers": {
        body: {
          ...workersAnalyticsFixture(),
          series: {
            ...workersAnalyticsFixture().series,
            range: clampedRangeFixture("maxBuckets"),
          },
        },
      },
    });
    await overview();
    const note = await page().findByTestId("workers-range-caption");
    expect(note.getAttribute("data-clamp-reason")).toBe("maxBuckets");
    expect(note.textContent).toContain("1-minute buckets");
  });

  it("shows an empty state when nothing happened in the range", async () => {
    renderOverview({
      "GET /analytics/workers": {
        body: workersAnalyticsFixture([]),
      },
    });
    await overview();
    await page().findByText("No workers to show");
    expect(page().queryByRole("table", { name: "Workers" })).toBeNull();
  });

  it("shows an error with a retry when the roll-up fails", async () => {
    let fail = true;
    renderOverview({
      "GET /analytics/workers": (call) =>
        fail
          ? {
              status: 503,
              body: problem(503, "DRIVER_ERROR", "Backend unavailable"),
            }
          : {
              body: workersAnalyticsFixture(undefined, {
                keys: call.query.getAll("keys"),
              }),
            },
    });
    await overview();
    const alert = await within(
      page().getByTestId("workers-analytics"),
    ).findByRole("alert");
    expect(alert.textContent).toContain("Could not load worker analytics");
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await page().findByTestId("worker-analytics-row-emails-1");
  });

  it("explains RANGE_NOT_RETAINED rather than calling it a failure", async () => {
    const retainedFrom = ANALYTICS_NOW - 86_400_000;
    const notRetained = {
      status: 400,
      body: problem(
        400,
        "RANGE_NOT_RETAINED",
        "Range is older than the backend keeps",
        {
          detail: "The whole range is older than the backend keeps",
          context: { retainedFrom, resolution: 60 },
        },
      ),
    };
    renderOverview({
      "GET /analytics/workers": notRetained,
      "GET /analytics/runners": notRetained,
      "GET /analytics/jobs": notRetained,
    });
    await overview();
    for (const id of ["workers", "runners", "jobs"]) {
      const note = await page().findByTestId(`${id}-range-not-retained`);
      expect(note.getAttribute("role")).toBe("note");
      expect(note.textContent).toContain("No numbers are kept for this range");
      expect(note.textContent).toContain(
        new Date(retainedFrom).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }),
      );
      // Not an alarm, and no Retry: the same range fails the same way.
      expect(within(note).queryByRole("button")).toBeNull();
    }
    expect(
      within(page().getByTestId("workers-analytics")).queryByRole("alert"),
    ).toBeNull();
  });

  it("keeps the rows when only the sparkline batch fails", async () => {
    renderOverview({
      "GET /analytics/workers": (call) =>
        call.query.has("keys")
          ? {
              status: 503,
              body: problem(503, "DRIVER_ERROR", "Backend unavailable"),
            }
          : { body: workersAnalyticsFixture() },
    });
    await overview();
    const row = await page().findByTestId("worker-analytics-row-emails-1");
    await waitFor(() => expect(row.textContent).toContain("unavailable"));
    expect(row.textContent).toContain("emails-1");
  });
});

describe("the Overview's Runners section", () => {
  it("links a row's runner to its runner page", async () => {
    renderOverview();
    await overview();
    const row = await page().findByTestId("runner-analytics-row-nightly");
    const link = within(row).getByRole("link");
    expect(link.getAttribute("href")).toContain("/runners/nightly");
    expect(link.textContent).toBe("nightly");
  });

  it("leaves the runner as text where the runner pages are not routed", async () => {
    // No `runners.list`: the Runners nav entry is absent, so `/runners/:id`
    // was never registered and a link would lead nowhere.
    renderOverview({
      "GET /meta/permissions": {
        body: permissionsFixture({ "runners.list": false }),
      },
    });
    await overview();
    const row = await page().findByTestId("runner-analytics-row-nightly");
    expect(row.textContent).toContain("nightly");
    expect(within(row).queryAllByRole("link")).toHaveLength(0);
  });

  it("reads the roll-up and one batch, and labels the derived in-flight line", async () => {
    const { calls } = renderOverview();
    await overview();
    await page().findByTestId("runner-analytics-row-nightly");
    const reads = calls.filter((call) => call.path === "/analytics/runners");
    expect(reads).toHaveLength(2);
    expect(reads[1]!.query.getAll("ids")).toEqual(["nightly", "hourly"]);
    // "Running now" is a scalar from the locks, not a bucket.
    const totals = page().getByLabelText("Runner totals").textContent ?? "";
    expect(totals).toContain("Running now");
    expect(totals).toContain("not a figure about the range");
    // A derived series must say so.
    const derived = page().getByRole("img", { name: /derived/ });
    expect(derived.getAttribute("aria-label")).toContain("in flight");
    expect(page().getByTestId("runners-analytics").textContent).toContain(
      "derived",
    );
  });

  it("shows an empty state when nothing ran in the range", async () => {
    renderOverview({
      "GET /analytics/runners": { body: runnersAnalyticsFixture([]) },
    });
    await overview();
    await page().findByText("No runners");
  });
});

describe("gating the analytics sections", () => {
  it("hides both when the backend records no analytics", async () => {
    const { calls } = renderOverview({
      "GET /meta": { body: metaFixture({ analytics: null }) },
    });
    await overview();
    expect(page().queryByTestId("runners-analytics")).toBeNull();
    expect(page().queryByTestId("workers-analytics")).toBeNull();
    expect(calls.some((call) => call.path.startsWith("/analytics/"))).toBe(
      false,
    );
  });

  it("hides only the kind the backend does not record", async () => {
    const meta = metaFixture();
    const { calls } = renderOverview({
      "GET /meta": {
        body: metaFixture({
          analytics: {
            ...meta.analytics!,
            recording: { ...meta.analytics!.recording, runners: false },
          },
        }),
      },
    });
    await overview();
    await page().findByTestId("workers-analytics");
    expect(page().queryByTestId("runners-analytics")).toBeNull();
    expect(calls.some((call) => call.path === "/analytics/runners")).toBe(
      false,
    );
    expect(calls.some((call) => call.path === "/analytics/workers")).toBe(true);
  });

  it("follows `features.runnerMetrics`, which already accounts for the mode", async () => {
    // `/meta.features` follows the API mode: in mode `jobs` the server reports
    // `runnerMetrics: false`, because `/analytics/runners` is not mounted. So
    // the flag alone decides — the fixture here is what that server answers.
    const meta = metaFixture({ mode: "jobs" });
    meta.features = { ...meta.features, runnerMetrics: false };
    const { calls } = renderOverview({ "GET /meta": { body: meta } });
    await page().findByTestId("workers-analytics");
    expect(page().queryByTestId("runners-analytics")).toBeNull();
    expect(calls.some((call) => call.path === "/analytics/runners")).toBe(
      false,
    );
  });

  it("trusts the flag, not the mode: no guard of its own", async () => {
    // The UI no longer second-guesses the server by mode. Were a server to
    // report the flag on, the section would render — the flag is the
    // contract, and it is the server's job to keep it true.
    const meta = metaFixture({ mode: "jobs" });
    meta.features = { ...meta.features, runnerMetrics: true };
    renderOverview({ "GET /meta": { body: meta } });
    expect(await page().findByTestId("runners-analytics")).toBeTruthy();
  });

  it("hides both without metrics.read — and invents no new action for them", async () => {
    const permissions = permissionsFixture();
    delete permissions.actions["metrics.read"];
    const { calls } = renderOverview({
      "GET /meta/permissions": { body: permissions },
    });
    await page().findByTestId("overview");
    await page().findByTestId("queue-row-emails");
    expect(page().queryByTestId("runners-analytics")).toBeNull();
    expect(page().queryByTestId("workers-analytics")).toBeNull();
    expect(calls.some((call) => call.path.startsWith("/analytics/"))).toBe(
      false,
    );
    // The only action involved is `metrics.read`; nothing reads a
    // `metrics.runners`-style string that does not exist.
    expect(
      Object.keys(permissionsFixture().actions).filter((action) =>
        action.startsWith("metrics."),
      ),
    ).toEqual(["metrics.read"]);
  });
});
