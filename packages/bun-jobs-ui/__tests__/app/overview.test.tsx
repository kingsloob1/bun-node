import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { formatNumber } from "../../app/format";
import { fireEvent, page, setupDom, visit, waitFor, within } from "./dom";
import {
  clampedRangeFixture,
  jobsSeriesFixture,
  metaFixture,
  overviewFixture,
  permissionsFixture,
  problem,
  queueListFixture,
} from "./fixtures";
import { renderApp } from "./renderApp";

setupDom();

/** An IntersectionObserver that reports every observed element visible at once. */
class VisibleObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }

  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

/** An IntersectionObserver that never reports anything (rows off-screen). */
class HiddenObserver extends VisibleObserver {
  override observe(): void {}
}

let savedObserver: typeof IntersectionObserver | undefined;

beforeEach(() => {
  savedObserver = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver =
    VisibleObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  if (savedObserver) {
    globalThis.IntersectionObserver = savedObserver;
  }
});

/** The Overview after it loaded. */
async function overview() {
  const screen = await page().findByTestId("overview");
  await within(screen).findByTestId("state-counts");
  return screen;
}

describe("the Overview's range control", () => {
  it("reads over the chosen preset, and keeps it in the URL", async () => {
    const { calls } = renderApp();
    await overview();
    /** The span the last `/analytics/jobs` read asked for, in seconds. */
    const lastSpan = () => {
      const read = calls
        .filter((call) => call.path === "/analytics/jobs")
        .at(-1);
      if (!read) {
        return null;
      }
      // Never the deprecated `minutes`.
      expect(read.query.get("minutes")).toBeNull();
      return (
        (Number(read.query.get("to")) - Number(read.query.get("from"))) / 1_000
      );
    };
    /**
     * A preset starts at the first whole bucket inside its window, so the
     * span asked for is its length less under one bucket.
     */
    const spanOf = (length: number, bucket: number) => {
      const span = lastSpan();
      return span !== null && span > length - bucket && span <= length
        ? length
        : span;
    };
    // The default is the hour the Overview always showed, at minute buckets.
    await waitFor(() => expect(spanOf(3600, 60)).toBe(3600));
    expect(
      calls
        .filter((call) => call.path === "/analytics/jobs")
        .at(-1)!
        .query.get("resolution"),
    ).toBe("60");
    fireEvent.change(
      within(
        page().getByRole("group", { name: "Range for every section" }),
      ).getByRole("combobox"),
      { target: { value: "600" } },
    );
    // Ten minutes wants per-second buckets; the response says what it served.
    await waitFor(() => expect(spanOf(600, 1)).toBe(600));
    expect(
      calls
        .filter((call) => call.path === "/analytics/jobs")
        .at(-1)!
        .query.get("resolution"),
    ).toBe("1");
    expect(window.location.search).toContain("range=600s");
  });

  it("captions the section from the range the RESPONSE reports, not the one asked for", async () => {
    visit("/jobs/?range=600s");
    renderApp({
      handlers: {
        // The ten-minute preset asks for per-second buckets and comes back at
        // minute ones, because the backend keeps only five minutes of them.
        "GET /analytics/jobs": {
          body: jobsSeriesFixture({ range: clampedRangeFixture("retention") }),
        },
      },
    });
    await overview();
    const note = await page().findByTestId("jobs-range-caption");
    expect(note.getAttribute("data-clamp-reason")).toBe("retention");
    expect(note.textContent).toContain("not exactly the range asked for");
    expect(note.textContent).toContain("1-minute buckets");
  });

  it("captions nothing when the response covers exactly what was asked for", async () => {
    renderApp();
    await overview();
    await page().findByTestId("jobs-series");
    expect(page().queryByTestId("jobs-range-caption")).toBeNull();
  });

  it("switches between one control for the page and one per section", async () => {
    renderApp();
    await overview();
    // On by default: one control, no per-section ones.
    expect(page().queryByRole("group", { name: "Jobs range" })).toBeNull();
    fireEvent.click(page().getByLabelText("Apply date filter to page"));
    await waitFor(() =>
      expect(page().getByRole("group", { name: "Jobs range" })).toBeTruthy(),
    );
    expect(page().getByRole("group", { name: "Queues range" })).toBeTruthy();
    expect(
      page().queryByRole("group", { name: "Range for every section" }),
    ).toBeNull();
    expect(window.location.search).toContain("rangeScope=section");
  });
});

describe("the Overview screen", () => {
  it("renders counts per state, totals, paused queues, workers and throughput", async () => {
    renderApp();
    await overview();
    const counts = page().getByTestId("state-counts");
    const text = counts.textContent ?? "";
    for (const [label, value] of [
      ["Waiting", 1204],
      ["Delayed", 3],
      ["Active", 7],
      ["Completed", 98231],
      ["Retrying", 12],
      ["Dead", 2],
      ["Waiting children", 0],
    ] as const) {
      expect(text).toContain(`${label}${formatNumber(value)}`);
    }
    // Colour-coded by class, which the state tokens style.
    expect(counts.querySelectorAll(".stat-state.state-completed")).toHaveLength(
      1,
    );
    // The `failed` count reads "Retrying", with the badge's tooltip.
    const retrying = counts.querySelector(
      ".stat-state.state-failed .state-badge",
    );
    expect(retrying?.textContent).toBe("Retrying");
    expect(retrying?.getAttribute("title")).toContain(
      "Jobs that gave up are under Dead",
    );
    const summary = page().getByLabelText("Totals").textContent ?? "";
    expect(summary).toContain(`Total jobs${formatNumber(99459)}`);
    expect(summary).toContain("Queues2");
    expect(summary).toContain("1 paused");
    expect(summary).toContain("Workers4");
    // The range-dependent figure now comes from `/analytics/jobs`, labelled
    // with the resolution the response reports.
    // A compact breakdown: each figure a small label beside its number, not
    // one "42 completed" headline in the large stat font.
    const tile = await page().findByTestId("range-stat");
    await waitFor(() =>
      expect(tile.textContent ?? "").toContain(`Completed${formatNumber(42)}`),
    );
    // Attempts, not jobs: a retried job that later completed still counts.
    expect(tile.textContent).toContain("Failed attempts1");
    expect(tile.textContent).toContain("in 1-minute buckets");
    // No figure is set in the headline font, which is what made it too big.
    expect(tile.querySelector(".stat-value")).toBeNull();
    expect(formatNumber(98231)).toBe("98,231");
  });

  it("omits workers and throughput when the backend reports neither", async () => {
    const { workers: _w, throughput: _t, ...rest } = overviewFixture();
    renderApp({
      handlers: {
        "GET /overview": { body: rest },
        "GET /analytics/jobs": {
          status: 404,
          body: problem(404, "ROUTE_NOT_FOUND", "no"),
        },
      },
    });
    await overview();
    const summary = page().getByLabelText("Totals").textContent ?? "";
    expect(summary).not.toContain("Workers");
    expect(summary).not.toContain("Last");
    expect(summary).not.toContain("Over the range");
  });

  it("shows no throughput figure at all when the backend records no analytics", async () => {
    const { calls } = renderApp({
      handlers: {
        "GET /meta": { body: metaFixture({ analytics: null }) },
      },
    });
    await overview();
    const summary = page().getByLabelText("Totals").textContent ?? "";
    // Throughput belongs to the range on screen, so without analytics the
    // figure is absent rather than a fixed window contradicting the picker.
    expect(summary).not.toContain("Over the range");
    expect(summary).not.toContain("Last");
    expect(summary).not.toContain(formatNumber(5120));
    expect(summary).toContain("Total jobs");
    // Every analytics route is pruned, so nothing asks for one.
    expect(calls.some((call) => call.path.includes("/analytics/"))).toBe(false);
    expect(page().queryByTestId("runners-analytics")).toBeNull();
    expect(page().queryByTestId("workers-analytics")).toBeNull();
    expect(
      page().queryByRole("columnheader", { name: "Throughput" }),
    ).toBeNull();
  });

  it("renders the queue table with paused badges, per-state counts and totals", async () => {
    renderApp();
    await overview();
    const table = await page().findByRole("table", { name: "Queues" });
    const emails = within(table).getByTestId("queue-row-emails");
    const reports = within(table).getByTestId("queue-row-reports");
    expect(emails.textContent).toContain("emails");
    expect(emails.textContent).not.toContain("Paused");
    expect(reports.textContent).toContain("Paused");
    expect(emails.textContent).toContain(formatNumber(91220));
    expect(
      within(emails).getByRole("link", { name: "emails" }).getAttribute("href"),
    ).toBe("/jobs/queues/emails");
    // Zero counts are dimmed.
    expect(reports.querySelectorAll("td.zero").length).toBeGreaterThan(0);
  });

  it("shows the truncated notices", async () => {
    renderApp({
      handlers: {
        "GET /overview": { body: overviewFixture({ truncated: true }) },
        "GET /queues": { body: queueListFixture({ truncated: true }) },
      },
    });
    await overview();
    await page().findByTestId("queues-truncated");
    expect(page().getByTestId("queues-truncated").textContent).toContain(
      "Showing the first 2 queues",
    );
    expect(
      page().getByTestId("state-counts").parentElement!.textContent,
    ).toContain("These totals cover only the first 2 queues");
  });

  it("shows an empty state when there are no queues", async () => {
    renderApp({
      handlers: {
        "GET /queues": { body: { items: [], truncated: false } },
      },
    });
    await overview();
    await page().findByText("No queues yet");
    expect(page().queryByRole("table", { name: "Queues" })).toBeNull();
  });

  it("filters by name through the search box, kept in the URL", async () => {
    const { calls } = renderApp({
      handlers: {
        "GET /queues": (call) => {
          const search = call.query.get("search");
          return {
            body: search
              ? {
                  items: queueListFixture().items.filter((queue) =>
                    queue.name.includes(search),
                  ),
                  truncated: false,
                }
              : queueListFixture(),
          };
        },
      },
    });
    await overview();
    await page().findByTestId("queue-row-reports");
    fireEvent.change(page().getByLabelText("Filter queues by name"), {
      target: { value: "mail" },
    });
    await waitFor(() => {
      if (page().queryByTestId("queue-row-reports") !== null) {
        throw new Error("reports is still listed");
      }
    });
    expect(page().getByTestId("queue-row-emails")).toBeTruthy();
    expect(window.location.search).toBe("?q=mail");
    expect(
      calls.some(
        (call) =>
          call.path === "/queues" && call.query.get("search") === "mail",
      ),
    ).toBe(true);

    fireEvent.change(page().getByLabelText("Filter queues by name"), {
      target: { value: "zzz" },
    });
    await waitFor(() =>
      expect(page().getByText("No queues match")).toBeTruthy(),
    );
  });

  it("starts from the search in the URL", async () => {
    visit("/jobs?q=rep");
    const { calls } = renderApp();
    await overview();
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.path === "/queues" && call.query.get("search") === "rep",
        ),
      ).toBe(true),
    );
  });

  it("draws a throughput sparkline per visible row", async () => {
    const { calls } = renderApp();
    await overview();
    const spark = await page().findByRole("img", {
      name: "emails: 42 completed, 1 failed, in 1-minute buckets",
    });
    expect(spark.tagName.toLowerCase()).toBe("svg");
    const reads = calls.filter(
      (call) =>
        call.path.endsWith("/analytics/jobs") &&
        call.path.startsWith("/queues/"),
    );
    expect(reads.map((call) => call.path).sort()).toEqual([
      "/queues/emails/analytics/jobs",
      "/queues/reports/analytics/jobs",
    ]);
    // `from`/`to`/`resolution`, never the deprecated `minutes`.
    expect(reads[0]!.query.get("resolution")).toBe("60");
    expect(reads[0]!.query.get("minutes")).toBeNull();
    expect(Number(reads[0]!.query.get("to"))).toBeGreaterThan(
      Number(reads[0]!.query.get("from")),
    );
  });

  it("fetches no throughput for rows that never scroll into view", async () => {
    globalThis.IntersectionObserver =
      HiddenObserver as unknown as typeof IntersectionObserver;
    const { calls } = renderApp();
    await overview();
    await page().findByRole("columnheader", { name: "Throughput" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      calls.filter(
        (call) =>
          call.path.startsWith("/queues/") &&
          call.path.endsWith("/analytics/jobs"),
      ),
    ).toEqual([]);
  });

  it("hides sparklines without the throughput feature", async () => {
    const { calls } = renderApp({
      handlers: {
        "GET /meta": {
          body: metaFixture({
            features: { ...metaFixture().features, throughput: false },
          }),
        },
      },
    });
    await overview();
    await page().findByTestId("queue-row-emails");
    expect(
      page().queryByRole("columnheader", { name: "Throughput" }),
    ).toBeNull();
    expect(
      within(page().getByRole("table", { name: "Queues" })).queryAllByRole(
        "img",
      ),
    ).toHaveLength(0);
    expect(
      calls.some(
        (call) =>
          call.path.startsWith("/queues/") &&
          call.path.endsWith("/analytics/jobs"),
      ),
    ).toBe(false);
  });

  it("hides the totals and sparklines without metrics.read", async () => {
    const permissions = permissionsFixture();
    delete permissions.actions["metrics.read"];
    const { calls } = renderApp({
      handlers: { "GET /meta/permissions": { body: permissions } },
    });
    await page().findByTestId("overview");
    await page().findByTestId("queue-row-emails");
    expect(page().queryByTestId("state-counts")).toBeNull();
    expect(
      page().queryByRole("columnheader", { name: "Throughput" }),
    ).toBeNull();
    expect(calls.some((call) => call.path === "/overview")).toBe(false);
  });

  it("hides the queue table without queues.list", async () => {
    renderApp({
      handlers: {
        "GET /meta/permissions": {
          body: permissionsFixture({ "queues.list": false }),
        },
      },
    });
    await overview();
    expect(page().queryByRole("table", { name: "Queues" })).toBeNull();
  });

  it("shows an error with a retry when the overview fails", async () => {
    let fail = true;
    renderApp({
      handlers: {
        "GET /overview": () =>
          fail
            ? {
                status: 503,
                body: problem(503, "DRIVER_ERROR", "Backend unavailable", {
                  detail: "Backend unavailable",
                }),
              }
            : { body: overviewFixture() },
      },
    });
    const alert = await page().findByRole("alert");
    expect(alert.textContent).toContain("Could not load the overview");
    expect(alert.textContent).toContain("DRIVER_ERROR");
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await page().findByTestId("state-counts");
  });

  it("polls: the overview is fetched again", async () => {
    const { calls, queryClient } = renderApp();
    await overview();
    const before = calls.filter((call) => call.path === "/overview").length;
    // Polling is a refetchInterval; trigger what the interval would.
    await queryClient.refetchQueries({ queryKey: ["overview"] });
    expect(calls.filter((call) => call.path === "/overview").length).toBe(
      before + 1,
    );
    const query = queryClient
      .getQueryCache()
      .find({ queryKey: ["overview", { minutes: null }] });
    expect(query?.observers[0]?.options.refetchInterval).toBe(5_000);
  });
});
