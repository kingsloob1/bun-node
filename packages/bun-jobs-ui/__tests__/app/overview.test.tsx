import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { formatNumber } from "../../app/format";
import { fireEvent, page, setupDom, visit, waitFor, within } from "./dom";
import {
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
      ["Failed", 12],
      ["Dead", 2],
      ["Waiting children", 0],
    ] as const) {
      expect(text).toContain(`${label}${formatNumber(value)}`);
    }
    // Colour-coded by class, which the state tokens style.
    expect(counts.querySelectorAll(".stat-state.state-completed")).toHaveLength(
      1,
    );
    const summary = page().getByLabelText("Totals").textContent ?? "";
    expect(summary).toContain(`Total jobs${formatNumber(99459)}`);
    expect(summary).toContain("Queues2");
    expect(summary).toContain("1 paused");
    expect(summary).toContain("Workers4");
    expect(summary).toContain(`Last 60 minutes${formatNumber(5120)} completed`);
    expect(summary).toContain("9 failed");
    expect(formatNumber(98231)).toBe("98,231");
  });

  it("omits workers and throughput when the backend reports neither", async () => {
    const { workers: _w, throughput: _t, ...rest } = overviewFixture();
    renderApp({ handlers: { "GET /overview": { body: rest } } });
    await overview();
    const summary = page().getByLabelText("Totals").textContent ?? "";
    expect(summary).not.toContain("Workers");
    expect(summary).not.toContain("Last");
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
    expect(page().queryByRole("table")).toBeNull();
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
      name: "emails: 42 completed, 1 failed in the last 60 minutes",
    });
    expect(spark.tagName.toLowerCase()).toBe("svg");
    const throughputCalls = calls.filter((call) =>
      call.path.endsWith("/throughput"),
    );
    expect(throughputCalls.map((call) => call.path).sort()).toEqual([
      "/queues/emails/throughput",
      "/queues/reports/throughput",
    ]);
    expect(throughputCalls[0]!.query.get("minutes")).toBe("60");
  });

  it("fetches no throughput for rows that never scroll into view", async () => {
    globalThis.IntersectionObserver =
      HiddenObserver as unknown as typeof IntersectionObserver;
    const { calls } = renderApp();
    await overview();
    await page().findByRole("columnheader", { name: "Throughput" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls.filter((call) => call.path.endsWith("/throughput"))).toEqual(
      [],
    );
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
    expect(page().queryAllByRole("img")).toHaveLength(0);
    expect(calls.some((call) => call.path.endsWith("/throughput"))).toBe(false);
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
    expect(page().queryByRole("table")).toBeNull();
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
