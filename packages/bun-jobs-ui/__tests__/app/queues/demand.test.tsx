import type { QueueDemandDto } from "../../../app/api/types";
import type { MockReply } from "../mockFetch";
import { describe, expect, it } from "bun:test";
import { demandUrls } from "../../../app/api/demand";
import {
  formatDemandFigure,
  qualify,
} from "../../../app/screens/queues/panels/demand";
import { page, setupDom, visit, waitFor, within } from "../dom";
import {
  demandFixture,
  metaFixture,
  permissionsFixture,
  problem,
  queueListFixture,
} from "../fixtures";
import { renderApp } from "../renderApp";
import { renderQueue } from "./fixtures";

setupDom();

/**
 * A queue's demand (`GET /queues/:queue/demand`, `GET /demand`): the queue
 * screen's Demand panel and the Overview queue table's Demand column.
 *
 * The rule both keep: a figure is written as its answer qualifies it — "≥"
 * when a count reached the cap (every count, since the API does not say
 * which), "≈" for the figures a backend without direct counting approximates
 * (never waiting or active) — so a lower bound or an approximation is never
 * shown as a precise count.
 */

/** Opens the Demand panel of `emails`, answering its read with `reading`. */
async function openPanel(reading: QueueDemandDto | null = demandFixture()) {
  const rendered = renderQueue({
    path: "/queues/emails?panel=demand",
    handlers:
      reading === null
        ? {}
        : { "GET /queues/emails/demand": { body: reading } },
  });
  const panel = await page().findByTestId(
    "queue-demand",
    {},
    { timeout: 5_000 },
  );
  return { ...rendered, panel };
}

/** The text of the panel's figure `name`. */
function figure(panel: HTMLElement, name: string): string {
  return within(panel).getByTestId(`demand-${name}`).textContent ?? "";
}

describe("the Demand panel", () => {
  it("shows every figure of an exact reading plainly, with what each counts", async () => {
    const { panel, calls } = await openPanel();
    expect(figure(panel, "demand")).toBe("1,204");
    expect(figure(panel, "outstanding")).toBe("1,208");
    expect(figure(panel, "waiting")).toBe("1,200");
    expect(figure(panel, "dueNow")).toBe("3");
    expect(figure(panel, "stalled")).toBe("1");
    expect(figure(panel, "active")).toBe("5");
    expect(figure(panel, "workers")).toBe("2");
    expect(
      within(panel).getByTestId("demand-next-due").querySelector("time"),
    ).not.toBeNull();
    // Nothing to qualify, so no note and no marked figure.
    expect(within(panel).queryByTestId("demand-capped")).toBeNull();
    expect(within(panel).queryByTestId("demand-approximate")).toBeNull();
    expect(within(panel).queryByTestId("demand-paused")).toBeNull();
    expect(panel.textContent).not.toMatch(/[≥≈]/);
    // What a scaler points at is named beside the figure.
    expect(panel.textContent).toContain("launch-style scaler");
    expect(panel.textContent).toContain("scale-style scaler");
    // Read as JSON, whatever the Accept header would pick.
    const read = calls.find((call) => call.path === "/queues/emails/demand")!;
    expect(read.query.get("format")).toBe("json");
  });

  it("gives the URLs a scaler reads, JSON and Prometheus, on the API's base", async () => {
    const { panel } = await openPanel();
    const json = within(panel).getByTestId("demand-url-json").textContent!;
    const prometheus = within(panel).getByTestId(
      "demand-url-prometheus",
    ).textContent!;
    expect(new URL(json).pathname).toBe("/jobs-api/queues/emails/demand");
    expect(new URL(prometheus).searchParams.get("format")).toBe("prometheus");
    expect(new URL(prometheus).pathname).toBe(new URL(json).pathname);
  });

  it("marks every count at least (≥) when a count reached the cap, and says so", async () => {
    const { panel } = await openPanel(
      demandFixture({
        waiting: 10_000,
        demand: 10_004,
        outstanding: 10_008,
        capped: true,
      }),
    );
    for (const name of [
      "demand",
      "outstanding",
      "waiting",
      "dueNow",
      "stalled",
      "active",
    ]) {
      expect(figure(panel, name).startsWith("≥")).toBe(true);
      expect(
        within(panel).getByTestId(`demand-${name}`).getAttribute("title"),
      ).toContain("At least");
    }
    // Workers are not a count of jobs: never capped.
    expect(figure(panel, "workers")).toBe("2");
    expect(within(panel).getByTestId("demand-capped").textContent).toContain(
      "lower bound",
    );
  });

  it("marks only the fallback's figures approximate (≈) on a backend that cannot count, and says what they miss", async () => {
    const { panel } = await openPanel(
      demandFixture({ exact: false, dueNow: 1, stalled: 5 }),
    );
    for (const name of ["demand", "outstanding", "dueNow", "stalled"]) {
      expect(figure(panel, name).startsWith("≈")).toBe(true);
    }
    // Still counted directly by the fallback: not marked.
    expect(figure(panel, "waiting")).toBe("1,200");
    expect(figure(panel, "active")).toBe("5");
    const note = within(panel).getByTestId("demand-approximate");
    expect(note.textContent).toContain("only 1 or 0");
    expect(note.textContent).toContain("Right as a trigger");
    // The next due time says it too.
    expect(
      within(panel).getByTestId("demand-next-due").querySelector("time")!.title,
    ).toContain("Approximate");
  });

  it("says a paused queue demands nothing, so its 0 is not read as an empty queue", async () => {
    const { panel } = await openPanel(
      demandFixture({ paused: true, demand: 0, outstanding: 0 }),
    );
    expect(figure(panel, "demand")).toBe("0");
    expect(figure(panel, "waiting")).toBe("1,200");
    expect(within(panel).getByTestId("demand-paused").textContent).toContain(
      "paused",
    );
  });

  it("says when nothing is scheduled ahead", async () => {
    const { panel } = await openPanel(demandFixture({ nextDueAt: null }));
    expect(within(panel).getByTestId("demand-next-due").textContent).toBe(
      "None scheduled",
    );
  });

  it("offers a retry when the read fails", async () => {
    renderQueue({
      path: "/queues/emails?panel=demand",
      handlers: {
        "GET /queues/emails/demand": problem(503, "UNAVAILABLE", "Down"),
      },
    });
    await waitFor(() =>
      expect(page().getByText("Could not load demand")).not.toBeNull(),
    );
  });

  it("is absent without the feature, and without queues.read", async () => {
    const variants: Record<string, MockReply>[] = [
      {
        "GET /meta": {
          body: metaFixture({
            features: { ...metaFixture().features, demand: false },
          }),
        },
      },
      {
        "GET /meta/permissions": {
          body: permissionsFixture({ "queues.read": false }),
        },
      },
    ];
    for (const handlers of variants) {
      const { calls, unmount } = renderQueue({ handlers });
      await page().findByTestId("queue-screen");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(page().queryByRole("tab", { name: "Demand" })).toBeNull();
      expect(calls.some((call) => call.path.endsWith("/demand"))).toBe(false);
      unmount();
    }
  });
});

describe("the Overview queue table's Demand column", () => {
  /** The Overview's queue table once its demand arrived. */
  async function queueTable() {
    const table = await page().findByRole("table", { name: "Queues" });
    await within(table).findByTestId("queue-demand-emails");
    return table;
  }

  it("reads the page's queues in one GET /demand, as repeated keys, and links each figure to the panel", async () => {
    visit("/jobs");
    const { calls } = renderApp();
    const table = await queueTable();
    const reads = calls.filter((call) => call.path === "/demand");
    expect(reads.length).toBeGreaterThanOrEqual(1);
    expect(reads[0]!.query.getAll("queues")).toEqual(
      queueListFixture().items.map((queue) => queue.name),
    );
    expect(reads[0]!.query.get("format")).toBe("json");
    // No per-queue read for the table.
    expect(calls.some((call) => call.path === "/queues/emails/demand")).toBe(
      false,
    );
    const cell = within(table).getByTestId("queue-demand-emails");
    expect(cell.textContent).toBe("1,204");
    expect(cell.querySelector("a")!.getAttribute("href")).toBe(
      "/jobs/queues/emails?panel=demand",
    );
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toContain("Demand");
  });

  it("writes a capped reading ≥ and an approximate one ≈, and a queue the answer left out as —", async () => {
    visit("/jobs");
    renderApp({
      handlers: {
        "GET /demand": {
          body: {
            queues: [
              demandFixture({ queue: "emails", capped: true }),
              // `reports` left out, as for a queue the caller cannot read.
            ],
            truncated: false,
          },
        },
      },
    });
    const table = await queueTable();
    expect(within(table).getByTestId("queue-demand-emails").textContent).toBe(
      "≥1,204",
    );
    const reports = within(table).getByTestId("queue-row-reports");
    expect(reports.querySelector("td.demand")!.textContent).toBe("—");
  });

  it("has no column, and reads nothing, without the feature", async () => {
    visit("/jobs");
    const { calls } = renderApp({
      handlers: {
        "GET /meta": {
          body: metaFixture({
            features: { ...metaFixture().features, demand: false },
          }),
        },
      },
    });
    const table = await page().findByRole("table", { name: "Queues" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).not.toContain("Demand");
    expect(calls.some((call) => call.path === "/demand")).toBe(false);
  });
});

describe("how a demand figure is written", () => {
  it("prefers ≥ over ≈ when a reading is both capped and approximate", () => {
    const reading = demandFixture({ capped: true, exact: false });
    expect(formatDemandFigure(reading, "demand")).toBe("≥1,204");
    expect(qualify(reading, "demand")).toEqual({
      atLeast: true,
      approximate: true,
    });
  });

  it("never marks waiting or active approximate", () => {
    const reading = demandFixture({ exact: false });
    expect(qualify(reading, "waiting").approximate).toBe(false);
    expect(qualify(reading, "active").approximate).toBe(false);
  });

  it("builds absolute scaler URLs from a path base or an absolute one", () => {
    expect(demandUrls("/jobs-api", "a b", "http://host:4000")).toEqual({
      json: "http://host:4000/jobs-api/queues/a%20b/demand",
      prometheus:
        "http://host:4000/jobs-api/queues/a%20b/demand?format=prometheus",
    });
    expect(
      demandUrls("https://api.example.com/v1/", "emails", "http://ui").json,
    ).toBe("https://api.example.com/v1/queues/emails/demand");
  });
});
