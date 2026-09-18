import type { JobsApiAction } from "../../app/api/contract";
import type { NavInputs } from "../../app/layout/nav";
import { describe, expect, it } from "bun:test";
import { buildNav } from "../../app/layout/nav";
import { page, setupDom, visit, waitFor } from "./dom";
import { metaFixture, permissionsFixture } from "./fixtures";
import { renderApp } from "./renderApp";

setupDom();

/** Nav ids for the given inputs. */
function ids(overrides: Partial<NavInputs> = {}, denied: JobsApiAction[] = []) {
  const permissions = permissionsFixture();
  for (const action of denied) {
    delete permissions.actions[action];
  }
  return buildNav({
    meta: metaFixture(),
    sections: { manage: true, docs: true },
    can: (action) => permissions.actions[action] === true,
    ...overrides,
  }).map((item) => item.id);
}

describe("buildNav", () => {
  it("shows every section in mode both with every permission", () => {
    expect(ids()).toEqual(["overview", "queues", "runners", "events", "docs"]);
  });

  it("drops the runner side in mode jobs, and the jobs side in mode runner", () => {
    expect(ids({ meta: metaFixture({ mode: "jobs" }) })).toEqual([
      "overview",
      "queues",
      "events",
      "docs",
    ]);
    expect(ids({ meta: metaFixture({ mode: "runner" }) })).toEqual([
      "runners",
      "events",
      "docs",
    ]);
  });

  it("drops an entry whose action is absent or false", () => {
    expect(ids({}, ["queues.list"])).toEqual([
      "overview",
      "runners",
      "events",
      "docs",
    ]);
    expect(ids({}, ["queues.list", "metrics.read"])).toEqual([
      "runners",
      "events",
      "docs",
    ]);
    expect(ids({}, ["runners.list", "events.connect", "docs.read"])).toEqual([
      "overview",
      "queues",
    ]);
    // Present but false behaves like absent.
    expect(
      buildNav({
        meta: metaFixture(),
        sections: { manage: true, docs: true },
        can: (action) =>
          ({ ...permissionsFixture().actions, "docs.read": false })[action] ===
          true,
      }).map((item) => item.id),
    ).not.toContain("docs");
  });

  it("keeps Overview with metrics.read alone", () => {
    expect(ids({}, ["queues.list"])).toContain("overview");
  });

  it("drops Events without a socket and docs when meta.docs is null", () => {
    expect(ids({ meta: metaFixture({ websocket: null, docs: null }) })).toEqual(
      ["overview", "queues", "runners"],
    );
  });

  it("honours the mount's sections", () => {
    expect(ids({ sections: { manage: false, docs: true } })).toEqual(["docs"]);
    expect(ids({ sections: { manage: true, docs: false } })).toEqual([
      "overview",
      "queues",
      "runners",
      "events",
    ]);
  });
});

/** The sidebar link names. */
function sidebarLinks(): string[] {
  const nav = page().getByRole("navigation", { name: "Sections" });
  return [...nav.querySelectorAll("a")].map((a) => a.textContent ?? "");
}

describe("the rendered layout", () => {
  it("renders the gated sidebar, chips and live status", async () => {
    renderApp({
      handlers: {
        "GET /meta": { body: metaFixture({ mode: "jobs" }) },
      },
    });
    await page().findByTestId("app-ready");
    expect(sidebarLinks()).toEqual([
      "Overview",
      "Queues",
      "Events",
      "API docs",
    ]);
    const header = page().getByRole("banner");
    expect(header.textContent).toContain("Shop jobs");
    expect(header.textContent).toContain("namespaceshop");
    expect(header.textContent).toContain("drivermemory");
    expect(header.textContent).toContain("modejobs");
    expect(page().getByTestId("live-status").textContent).toBe(
      "Polling 5s · events: local · publishing: unknown",
    );
  });

  it("routes a pruned section to the 404, and a gated one to its placeholder", async () => {
    visit("/jobs/runners");
    const first = renderApp({
      handlers: { "GET /meta": { body: metaFixture({ mode: "jobs" }) } },
    });
    await page().findByTestId("not-found");
    first.unmount();

    visit("/jobs/events");
    renderApp();
    const placeholder = await page().findByTestId("placeholder");
    expect(placeholder.textContent).toContain("Events");
    expect(placeholder.textContent).toContain("milestone 4");
  });

  it("redirects the start page to the first section when Overview is not available", async () => {
    renderApp({
      handlers: { "GET /meta": { body: metaFixture({ mode: "runner" }) } },
    });
    await page().findByTestId("app-ready");
    await waitFor(() => expect(window.location.pathname).toBe("/jobs/runners"));
  });

  it("explains an app with no sections at all", async () => {
    renderApp({
      config: { sections: { manage: false, docs: false } },
    });
    await page().findByTestId("app-ready");
    expect(page().getByText("Nothing to show")).toBeTruthy();
    expect(sidebarLinks()).toEqual([]);
  });

  it("shows the read-only chip", async () => {
    renderApp({
      handlers: { "GET /meta": { body: metaFixture({ readOnly: true }) } },
    });
    await page().findByTestId("app-ready");
    expect(page().getByRole("banner").textContent).toContain("read-only");
  });
});
