import type { JobsApiAction } from "../../app/api/contract";
import type { NavInputs } from "../../app/layout/nav";
import { afterEach, describe, expect, it } from "bun:test";
import { buildNav } from "../../app/layout/nav";
import { page, setupDom, visit, waitFor } from "./dom";
import { metaFixture, permissionsFixture } from "./fixtures";
import { liveFake } from "./liveFake";
import { renderApp } from "./renderApp";

setupDom();
afterEach(() => liveFake.uninstall());

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
    expect(ids()).toEqual([
      "overview",
      "queues",
      "workers",
      "runners",
      "events",
      "docs",
    ]);
  });

  it("drops the runner side in mode jobs, and the jobs side in mode runner", () => {
    expect(ids({ meta: metaFixture({ mode: "jobs" }) })).toEqual([
      "overview",
      "queues",
      "workers",
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
      "workers",
      "runners",
      "events",
      "docs",
    ]);
    expect(ids({}, ["queues.list", "metrics.read"])).toEqual([
      "workers",
      "runners",
      "events",
      "docs",
    ]);
    expect(ids({}, ["runners.list", "events.connect", "docs.read"])).toEqual([
      "overview",
      "queues",
      "workers",
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

  it("shows Workers only with a worker registry and workers.list, in jobs mode", () => {
    expect(ids({}, ["workers.list"])).not.toContain("workers");
    const noRegistry = metaFixture();
    noRegistry.features = { ...noRegistry.features, workers: false };
    expect(ids({ meta: noRegistry })).not.toContain("workers");
    expect(ids({ meta: metaFixture({ mode: "runner" }) })).not.toContain(
      "workers",
    );
  });

  it("keeps Overview with metrics.read alone", () => {
    expect(ids({}, ["queues.list"])).toContain("overview");
  });

  it("drops Events without a socket and docs when meta.docs is null", () => {
    expect(ids({ meta: metaFixture({ websocket: null, docs: null }) })).toEqual(
      ["overview", "queues", "workers", "runners"],
    );
  });

  it("nests HTTP API under API docs, and WebSocket API only with a socket", () => {
    /** The docs entry's children, as ids and paths. */
    const children = (meta = metaFixture()) => {
      const docs = buildNav({
        meta,
        sections: { manage: true, docs: true },
        can: () => true,
      }).find((item) => item.id === "docs");
      return docs?.children?.map((child) => [child.id, child.to]);
    };
    expect(children()).toEqual([
      ["docs-http", "/docs/http"],
      ["docs-ws", "/docs/ws"],
    ]);
    expect(
      children(metaFixture({ docs: { openapi: "/jobs-api/openapi.json" } })),
    ).toEqual([["docs-http", "/docs/http"]]);
  });

  it("honours the mount's sections", () => {
    expect(ids({ sections: { manage: false, docs: true } })).toEqual(["docs"]);
    expect(ids({ sections: { manage: true, docs: false } })).toEqual([
      "overview",
      "queues",
      "workers",
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
    // The live client's status (its own tests cover how it is derived).
    liveFake.install({
      state: "off",
      detail: "No socket",
      events: "local",
      publishing: null,
    });
    renderApp({
      handlers: {
        "GET /meta": { body: metaFixture({ mode: "jobs" }) },
      },
    });
    await page().findByTestId("app-ready");
    expect(sidebarLinks()).toEqual([
      "Overview",
      "Queues",
      "Workers",
      "Events",
      "API docs",
      "HTTP API",
      "WebSocket API",
    ]);
    const header = page().getByRole("banner");
    expect(header.textContent).toContain("Shop jobs");
    expect(header.textContent).toContain("namespaceshop");
    expect(header.textContent).toContain("drivermemory");
    expect(header.textContent).toContain("modejobs");
    expect(page().getByTestId("live-status").textContent).toBe(
      "Polling 5s · events: local",
    );
  });

  it("routes a pruned section to the 404, and a gated one to its screen", async () => {
    visit("/jobs/runners");
    const first = renderApp({
      handlers: { "GET /meta": { body: metaFixture({ mode: "jobs" }) } },
    });
    await page().findByTestId("not-found");
    first.unmount();

    visit("/jobs/docs");
    renderApp();
    expect(await page().findByTestId("docs-home")).toBeTruthy();
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

  it("marks exactly one docs link current: the parent on /docs, a child below it", async () => {
    /** The names of the sidebar links marked current. */
    const current = () =>
      [
        ...page()
          .getByRole("navigation", { name: "Sections" })
          .querySelectorAll('a[aria-current="page"]'),
      ].map((a) => a.textContent);

    visit("/jobs/docs");
    const home = renderApp();
    await page().findByTestId("docs-home");
    expect(current()).toEqual(["API docs"]);
    home.unmount();

    visit("/jobs/docs/ws");
    renderApp();
    await page().findByTestId("app-ready");
    await waitFor(() => expect(current()).toEqual(["WebSocket API"]));
  });

  it("drops the WebSocket API link when the API documents no socket", async () => {
    renderApp({
      handlers: {
        "GET /meta": {
          body: metaFixture({
            websocket: null,
            docs: { openapi: "/jobs-api/openapi.json" },
          }),
        },
      },
    });
    await page().findByTestId("app-ready");
    expect(sidebarLinks()).toEqual([
      "Overview",
      "Queues",
      "Workers",
      "Runners",
      "API docs",
      "HTTP API",
    ]);
  });

  it("shows the read-only chip", async () => {
    renderApp({
      handlers: { "GET /meta": { body: metaFixture({ readOnly: true }) } },
    });
    await page().findByTestId("app-ready");
    expect(page().getByRole("banner").textContent).toContain("read-only");
  });
});
