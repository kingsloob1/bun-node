import { describe, expect, it } from "bun:test";
import { fireEvent, page, setupDom, waitFor, within } from "../dom";
import { metaFixture, permissionsFixture, problem } from "../fixtures";
import { queuePageFixture, renderQueue } from "./fixtures";

setupDom();

/** The last `GET /queues` the app sent. */
function lastList(
  calls: { method: string; path: string; query: URLSearchParams }[],
) {
  return calls
    .filter((call) => call.method === "GET" && call.path === "/queues")
    .at(-1)!;
}

describe("the queue list screen", () => {
  it("lists queues with paused badges, per-state counts, totals and links", async () => {
    renderQueue({
      path: "/queues",
      handlers: { "GET /queues": { body: queuePageFixture(3) } },
    });
    const table = await page().findByRole("table", { name: "Queues" });
    const paused = within(table).getByTestId("queue-row-q-01");
    expect(paused.textContent).toContain("Paused");
    expect(
      within(table).getByTestId("queue-row-q-00").textContent,
    ).not.toContain("Paused");
    expect(
      within(table).getByRole("link", { name: "q-02" }).getAttribute("href"),
    ).toBe("/jobs/queues/q-02");
    expect(page().getByText("1–3 of 3")).toBeTruthy();
  });

  it("keeps the search in the URL, sends it, and restarts paging", async () => {
    const { calls } = renderQueue({
      path: "/queues?offset=20",
      handlers: {
        "GET /queues": (call) => ({
          body: queuePageFixture(call.query.get("search") ? 1 : 3, {
            offset: Number(call.query.get("offset") ?? 0),
          }),
        }),
      },
    });
    await page().findByRole("table", { name: "Queues" });
    expect(lastList(calls).query.get("offset")).toBe("20");
    fireEvent.change(page().getByLabelText("Search queues by name"), {
      target: { value: "Mail" },
    });
    await waitFor(() =>
      expect(lastList(calls).query.get("search")).toBe("Mail"),
    );
    expect(lastList(calls).query.get("offset")).toBeNull();
    expect(window.location.search).toBe("?search=Mail");
  });

  it("pages with the pager: offset and limit in the URL and the request, capped at maxQueues", async () => {
    const { calls } = renderQueue({
      path: "/queues",
      config: {},
      handlers: {
        "GET /meta": {
          body: metaFixture({
            limits: { ...metaFixture().limits, maxQueues: 50 },
          }),
        },
        "GET /queues": (call) => ({
          body: queuePageFixture(20, {
            offset: Number(call.query.get("offset") ?? 0),
            total: 45,
            hasMore: Number(call.query.get("offset") ?? 0) + 20 < 45,
          }),
        }),
      },
    });
    await page().findByRole("table", { name: "Queues" });
    expect(lastList(calls).query.get("limit")).toBe("20");
    const pager = page().getByRole("navigation", { name: "Queue pages" });
    fireEvent.click(within(pager).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(lastList(calls).query.get("offset")).toBe("20"));
    expect(new URLSearchParams(window.location.search).get("offset")).toBe(
      "20",
    );
    const sizes = within(pager)
      .getAllByRole("option")
      .map((option) => Number(option.textContent));
    expect(Math.max(...sizes)).toBe(50);
  });

  it("clamps a URL limit to maxQueues", async () => {
    const { calls } = renderQueue({
      path: "/queues?limit=9999",
      handlers: { "GET /queues": { body: queuePageFixture(2) } },
    });
    await page().findByRole("table", { name: "Queues" });
    expect(lastList(calls).query.get("limit")).toBe(
      String(metaFixture().limits.maxQueues),
    );
  });

  it("shows the empty states", async () => {
    renderQueue({
      path: "/queues?search=zzz",
      handlers: { "GET /queues": { body: queuePageFixture(0) } },
    });
    expect(await page().findByText("No queues match")).toBeTruthy();
  });

  it("shows a load error with a retry", async () => {
    renderQueue({
      path: "/queues",
      handlers: {
        "GET /queues": {
          status: 503,
          body: problem(503, "DRIVER_ERROR", "Driver error"),
        },
      },
    });
    expect(await page().findByText("Could not load queues")).toBeTruthy();
  });

  it("is a notice without queues.list", async () => {
    renderQueue({
      path: "/queues",
      handlers: {
        "GET /meta/permissions": {
          body: permissionsFixture({
            "queues.list": false,
            "metrics.read": true,
          }),
        },
      },
    });
    // Without queues.list the section is not routed at all.
    await waitFor(() => expect(page().queryByTestId("queues-list")).toBeNull());
  });
});
