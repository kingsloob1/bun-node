/**
 * The security app's frame (PR-U1; the landing is U2's analytics page): the nav of built
 * sections the operator may use, "No access" on a deep link, the scope
 * default and the readable-only scope picker (the user's decisions 1–4).
 */
import { describe, expect, it } from "bun:test";
import { expectAbsent } from "../../harness/assert";
import { fireEvent, LOADED, page, setupDom, waitFor, within } from "./dom";
import { defaultRoutes } from "./mockApi";
import { renderApp } from "./renderApp";

setupDom();

/** The nav's link texts. */
async function navLabels(): Promise<string[]> {
  const nav = await page().findByTestId("nav", {}, LOADED);
  return within(nav)
    .queryAllByRole("link")
    .map((link) => link.textContent ?? "");
}

/** The scope select's option values. */
function scopeOptions(): string[] {
  const select = page().getByTestId("scope-select") as HTMLSelectElement;
  return [...select.options].map((option) => option.value);
}

describe("the landing screen", () => {
  it("is the analytics page of the default scope (PR-U2, in place of U1's Overview)", async () => {
    const { api } = renderApp();
    expect(
      (await page().findByTestId("analytics", {}, LOADED)).textContent,
    ).toContain("Analytics: Global");
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) =>
            call.path === "/analytics/series" &&
            call.query.get("scope") === "global",
        ),
      ).toBe(true),
    );
  });
});

describe("the nav", () => {
  it("shows only the built sections, each keeping the scope", async () => {
    renderApp({ path: "/?scope=group:payments" });
    expect(await navLabels()).toEqual([
      "Analytics",
      "Lists",
      "Bans",
      "Events",
      "API reference",
    ]);
    const nav = page().getByTestId("nav");
    const hrefs = within(nav)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual([
      "/security?scope=group%3Apayments",
      "/security/lists?scope=group%3Apayments",
      "/security/bans?scope=group%3Apayments",
      "/security/events?scope=group%3Apayments",
      "/security/api?scope=group%3Apayments",
    ]);
  });

  it("leaves out a section the operator may not use on the scope", async () => {
    renderApp({
      path: "/api?scope=service:checkout",
      routes: defaultRoutes({
        permissions: { global: {}, "service:checkout": {} },
        roles: [{ role: "viewer", scope: "group:payments", source: "binding" }],
      }),
    });
    expect(await navLabels()).toEqual(["API reference"]);
  });
});

describe("a deep link the operator may not read", () => {
  it("shows No access, naming the section, the scope and the permission", async () => {
    renderApp({
      path: "/?scope=service:checkout",
      routes: defaultRoutes({
        permissions: {
          global: {},
          "group:payments": { "policy:read": true, "analytics:read": true },
          "service:checkout": {},
        },
        roles: [{ role: "viewer", scope: "group:payments", source: "binding" }],
      }),
    });
    const panel = await page().findByTestId("no-access", {}, LOADED);
    expect(panel.textContent).toContain("Analytics");
    expect(panel.textContent).toContain("Service checkout");
    expect(panel.textContent).toContain("analytics:read");
    expectAbsent(page().queryByTestId("analytics"), "the analytics page");
  });
});

describe("the scope default (the user's decision 4)", () => {
  it("is global when the operator can read it", async () => {
    renderApp();
    expect(
      (await page().findByTestId("analytics", {}, LOADED)).textContent,
    ).toContain("Analytics: Global");
  });

  it("else their first readable group, ahead of an earlier service", async () => {
    const { api } = renderApp({
      routes: defaultRoutes({
        permissions: {
          global: {},
          "group:payments": { "policy:read": true, "analytics:read": true },
          "service:checkout": { "policy:read": true, "analytics:read": true },
        },
        roles: [
          { role: "viewer", scope: "service:checkout", source: "binding" },
          { role: "viewer", scope: "group:payments", source: "binding" },
        ],
      }),
    });
    expect(
      (await page().findByTestId("analytics", {}, LOADED)).textContent,
    ).toContain("Analytics: Group payments");
    expect(
      api.calls.some(
        (call) =>
          call.path === "/meta/permissions" &&
          call.query.get("scope") === "group:payments",
      ),
    ).toBe(true);
  });

  it("else their first service", async () => {
    renderApp({
      routes: defaultRoutes({
        permissions: {
          global: {},
          "service:ledger": { "policy:read": true, "analytics:read": true },
        },
        roles: [{ role: "viewer", scope: "service:ledger", source: "binding" }],
      }),
    });
    expect(
      (await page().findByTestId("analytics", {}, LOADED)).textContent,
    ).toContain("Analytics: Service ledger");
  });

  it("with no readable scope, No access says so", async () => {
    renderApp({
      routes: defaultRoutes({ permissions: { global: {} }, roles: [] }),
    });
    expect(
      (await page().findByTestId("no-access", {}, LOADED)).textContent,
    ).toContain("may not read any scope");
  });
});

describe("the scope picker", () => {
  it("lists global, every group and every service for a global reader", async () => {
    renderApp();
    await page().findByTestId("analytics", {}, LOADED);
    await waitFor(() =>
      expect(scopeOptions()).toEqual([
        "global",
        "group:payments",
        "service:checkout",
        "service:ledger",
      ]),
    );
  });

  it("lists only the bound scopes otherwise, and never reads the global lists", async () => {
    const { api } = renderApp({
      routes: defaultRoutes({
        permissions: {
          global: {},
          "group:payments": { "policy:read": true, "analytics:read": true },
          "service:checkout": { "policy:read": true, "analytics:read": true },
        },
        roles: [
          { role: "viewer", scope: "group:payments", source: "binding" },
          { role: "analyst", scope: "service:checkout", source: "binding" },
          { role: "viewer", scope: "group:payments", source: "binding" },
        ],
      }),
    });
    await page().findByTestId("analytics", {}, LOADED);
    expect(scopeOptions()).toEqual(["group:payments", "service:checkout"]);
    const paths = api.calls.map((call) => call.path);
    expect(paths).not.toContain("/groups");
    expect(paths).not.toContain("/services");
  });

  it("moves the screen to the chosen scope, in the URL", async () => {
    const { api } = renderApp();
    await page().findByTestId("analytics", {}, LOADED);
    await waitFor(() => expect(scopeOptions()).toContain("service:ledger"));
    fireEvent.change(page().getByTestId("scope-select"), {
      target: { value: "service:ledger" },
    });
    await waitFor(() =>
      expect(page().getByTestId("analytics").textContent).toContain(
        "Analytics: Service ledger",
      ),
    );
    expect(new URLSearchParams(window.location.search).get("scope")).toBe(
      "service:ledger",
    );
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) =>
            call.path === "/analytics/series" &&
            call.query.get("scope") === "service:ledger",
        ),
      ).toBe(true),
    );
  });
});

describe("the frame", () => {
  it("an unknown path under the mount is Not found, inside the frame", async () => {
    renderApp({ path: "/nowhere" });
    await page().findByTestId("not-found", {}, LOADED);
    expect(page().getByTestId("app-ready")).toBeTruthy();
  });

  it("the live badge says the screen polls while the stream is off", async () => {
    renderApp();
    await page().findByTestId("analytics", {}, LOADED);
    expect(page().getByText("Polling 15s")).toBeTruthy();
  });
});
