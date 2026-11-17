/**
 * The security app's frame (PR-U1): the Overview landing, the nav of built
 * sections the operator may use, "No access" on a deep link, the scope
 * default and the readable-only scope picker (the user's decisions 1–4).
 */
import { describe, expect, it } from "bun:test";
import { expectAbsent } from "../../harness/assert";
import { fireEvent, LOADED, page, setupDom, waitFor, within } from "./dom";
import { defaultRoutes, problem } from "./mockApi";
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
  it("is the Overview of the default scope, with every card the operator may read", async () => {
    const { api } = renderApp();
    expect(
      (await page().findByTestId("overview", {}, LOADED)).textContent,
    ).toContain("Overview: Global");
    expect(
      (await page().findByTestId("overview-policy", {}, LOADED)).textContent,
    ).toBe("Version 3");
    expect(page().getByTestId("overview-bans").textContent).toBe("2");
    expect(page().getByTestId("overview-agents").textContent).toBe("1 of 2 ok");
    expect(page().getByTestId("overview-audit").textContent).toBe(
      "Verified (12 entries)",
    );
    const bans = api.calls.find((call) => call.path === "/bans");
    expect(bans?.query.get("scope")).toBe("global");
    expect(bans?.query.get("active")).toBe("true");
  });

  it("a card the operator may not read is absent, and its endpoint never called", async () => {
    const { api } = renderApp({
      routes: defaultRoutes({
        permissions: { global: { "policy:read": true } },
      }),
    });
    await page().findByTestId("overview-policy", {}, LOADED);
    expectAbsent(page().queryByTestId("overview-bans"), "the bans card");
    expectAbsent(page().queryByTestId("overview-agents"), "the agents card");
    expectAbsent(page().queryByTestId("overview-audit"), "the audit card");
    const paths = api.calls.map((call) => call.path);
    expect(paths).not.toContain("/bans");
    expect(paths).not.toContain("/agents");
    expect(paths).not.toContain("/audit/verify");
  });
});

describe("each Overview card reads on its own", () => {
  it("a part the deployment does not run (404) leaves its card out", async () => {
    renderApp({ routes: { "GET /agents": problem(404, "not_found") } });
    await page().findByTestId("overview-bans", {}, LOADED);
    await page().findByTestId("overview-audit", {}, LOADED);
    await waitFor(() =>
      expectAbsent(page().queryByText("Agents"), "the agents card"),
    );
  });

  it("a card that fails says so, and the others still show", async () => {
    renderApp({ routes: { "GET /audit/verify": problem(500, "internal") } });
    expect(
      (await page().findByTestId("overview-audit-failed", {}, LOADED))
        .textContent,
    ).toBe("internal");
    expect(page().getByTestId("overview-policy").textContent).toBe("Version 3");
  });
});

describe("the nav", () => {
  it("shows only the built sections, each keeping the scope", async () => {
    renderApp({ path: "/?scope=group:payments" });
    expect(await navLabels()).toEqual(["Overview", "API reference"]);
    const nav = page().getByTestId("nav");
    const hrefs = within(nav)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual([
      "/security?scope=group%3Apayments",
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
          "group:payments": { "policy:read": true },
          "service:checkout": {},
        },
        roles: [{ role: "viewer", scope: "group:payments", source: "binding" }],
      }),
    });
    const panel = await page().findByTestId("no-access", {}, LOADED);
    expect(panel.textContent).toContain("Overview");
    expect(panel.textContent).toContain("Service checkout");
    expect(panel.textContent).toContain("policy:read");
    expectAbsent(page().queryByTestId("overview"), "the Overview");
  });
});

describe("the scope default (the user's decision 4)", () => {
  it("is global when the operator can read it", async () => {
    renderApp();
    expect(
      (await page().findByTestId("overview", {}, LOADED)).textContent,
    ).toContain("Overview: Global");
  });

  it("else their first readable group, ahead of an earlier service", async () => {
    const { api } = renderApp({
      routes: defaultRoutes({
        permissions: {
          global: {},
          "group:payments": { "policy:read": true },
          "service:checkout": { "policy:read": true },
        },
        roles: [
          { role: "viewer", scope: "service:checkout", source: "binding" },
          { role: "viewer", scope: "group:payments", source: "binding" },
        ],
      }),
    });
    expect(
      (await page().findByTestId("overview", {}, LOADED)).textContent,
    ).toContain("Overview: Group payments");
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
        permissions: { global: {}, "service:ledger": { "policy:read": true } },
        roles: [{ role: "viewer", scope: "service:ledger", source: "binding" }],
      }),
    });
    expect(
      (await page().findByTestId("overview", {}, LOADED)).textContent,
    ).toContain("Overview: Service ledger");
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
    await page().findByTestId("overview", {}, LOADED);
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
          "group:payments": { "policy:read": true },
          "service:checkout": { "policy:read": true },
        },
        roles: [
          { role: "viewer", scope: "group:payments", source: "binding" },
          { role: "analyst", scope: "service:checkout", source: "binding" },
          { role: "viewer", scope: "group:payments", source: "binding" },
        ],
      }),
    });
    await page().findByTestId("overview", {}, LOADED);
    expect(scopeOptions()).toEqual(["group:payments", "service:checkout"]);
    const paths = api.calls.map((call) => call.path);
    expect(paths).not.toContain("/groups");
    expect(paths).not.toContain("/services");
  });

  it("moves the screen to the chosen scope, in the URL", async () => {
    const { api } = renderApp();
    await page().findByTestId("overview", {}, LOADED);
    await waitFor(() => expect(scopeOptions()).toContain("service:ledger"));
    fireEvent.change(page().getByTestId("scope-select"), {
      target: { value: "service:ledger" },
    });
    await waitFor(() =>
      expect(page().getByTestId("overview").textContent).toContain(
        "Overview: Service ledger",
      ),
    );
    expect(new URLSearchParams(window.location.search).get("scope")).toBe(
      "service:ledger",
    );
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) =>
            call.path === "/bans" &&
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
    await page().findByTestId("overview", {}, LOADED);
    expect(page().getByText("Polling 15s")).toBeTruthy();
  });
});
