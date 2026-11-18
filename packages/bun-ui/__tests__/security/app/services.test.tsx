/**
 * The services and groups screens (PR-U4, ui.md §3) over the real app and a
 * fake: the services list with its figures (agents' health and bundles,
 * requests a minute and blocked share over the last hour, the policy's
 * mode), each absent without its permission; a service created, edited
 * (a `409` shown with a reload) and deleted; the groups tree, a group's
 * parent that cannot be itself or one under it, and a group's `409`.
 */
import type { MockCall, MockHandler, MockReply } from "./mockApi";
import { describe, expect, it } from "bun:test";
import { expectAbsent } from "../../harness/assert";
import { fireEvent, LOADED, page, setupDom, waitFor, within } from "./dom";
import { defaultRoutes, problem, T0 } from "./mockApi";
import { renderApp } from "./renderApp";

setupDom();

/** A service. */
function service(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    groups: [],
    environment: "production",
    hosts: [],
    topology: "c",
    labels: {},
    requireStepUp: false,
    revision: 4,
    updatedAt: T0,
    ...extra,
  };
}

/** A group. */
function group(id: string, parent: string | null = null) {
  return { id, name: id, parent, labels: {}, revision: 2, updatedAt: T0 };
}

/** An agent. */
function agent(id: string, svc: string, status: string, bundleVersion: number) {
  return {
    id,
    service: svc,
    status,
    lastSeen: T0,
    revokedAt: null,
    reported: {
      agentVersion: "1",
      bundleVersion,
      bundleKeyId: "sk_1",
      bundleExpired: false,
      banSeq: "0",
      banCount: 0,
      health: "ok",
    },
  };
}

/** The fake: two services, a group tree, agents, last hour's traffic, effective policies. */
function routes(): Record<string, MockHandler | MockReply> {
  return {
    "GET /services": {
      body: {
        items: [
          service("checkout", { groups: ["payments"] }),
          service("ledger"),
        ],
      },
    },
    "GET /services/:id": (call) => ({
      body: service(call.path.split("/")[2], { groups: ["payments"] }),
    }),
    "GET /groups": {
      body: {
        items: [
          group("payments"),
          group("cards", "payments"),
          group("emea", "cards"),
          group("ops"),
        ],
      },
    },
    "GET /agents": {
      body: {
        items: [
          agent("a1", "checkout", "ok", 7),
          agent("a2", "checkout", "late", 6),
          agent("a3", "ledger", "ok", 2),
        ],
      },
    },
    "GET /services/:id/bundle": (call) =>
      call.path.includes("checkout")
        ? { body: { format: "bun-security.bundle/1", version: 7 } }
        : problem(404, "not_found"),
    "GET /analytics/series": (call) => ({
      body: {
        tier: "minute",
        points:
          call.query.get("groupBy") === "service"
            ? [
                {
                  at: T0,
                  service: "checkout",
                  dims: { action: "allow" },
                  value: 1_140,
                },
                {
                  at: T0,
                  service: "checkout",
                  dims: { action: "block" },
                  value: 60,
                },
              ]
            : [],
      },
    }),
    "GET /services/:id/effective": (call) => ({
      body: {
        service: call.path.split("/")[2],
        policyVersions: [],
        policy: call.path.includes("checkout")
          ? {
              limits: [{ id: "a", mode: "dryRun" }],
              countedRules: [{ id: "b", mode: "dryRun" }],
            }
          : { mode: "off" },
        origins: {},
        locked: {},
      },
    }),
  };
}

/** The cells of the services table's rows, by test id. */
function cells(testId: string): string[] {
  return page()
    .getAllByTestId(testId)
    .map((cell) => cell.textContent ?? "");
}

/** Writes made to `path` with `method`. */
function writes(
  calls: readonly MockCall[],
  method: string,
  path: string,
): MockCall[] {
  return calls.filter((call) => call.method === method && call.path === path);
}

describe("the services list", () => {
  it("shows each service's agents and bundles, traffic, blocked share and mode", async () => {
    renderApp({ path: "/services?scope=global", routes: routes() });
    await page().findAllByTestId("service-row", {}, LOADED);
    await waitFor(() =>
      expect(cells("service-mode")).toEqual(["Enforced, 2 in dry run", "Off"]),
    );
    expect(cells("service-agents")).toEqual([
      "1 ok, 1 late bundle v7, v6 of v7, key sk_1",
      "1 ok bundle v2, key sk_1",
    ]);
    expect(cells("service-rate")).toEqual(["20", "0"]);
    expect(cells("service-blocked")).toEqual(["5.0%", "—"]);
  });

  it("without agents:read and analytics:read, those columns are absent", async () => {
    renderApp({
      path: "/services?scope=global",
      routes: {
        ...routes(),
        "GET /meta/permissions": defaultRoutes({
          permissions: {
            global: {
              "services:read": true,
              "policy:read": true,
              "groups:read": true,
            },
          },
        })["GET /meta/permissions"],
      },
    });
    await page().findAllByTestId("service-row", {}, LOADED);
    expectAbsent(page().queryByTestId("service-agents"), "the agents column");
    expectAbsent(page().queryByTestId("service-rate"), "the traffic column");
    expectAbsent(page().queryByTestId("new-service"), "New service");
  });
});

describe("a service", () => {
  it("is created with its fields", async () => {
    const { api } = renderApp({
      path: "/services/new?scope=global",
      routes: {
        ...routes(),
        "POST /services": (call) => ({
          status: 201,
          body: service("web", call.body as Record<string, unknown>),
        }),
      },
    });
    await page().findByTestId("service-form", {}, LOADED);
    fireEvent.change(page().getByTestId("service-id"), {
      target: { value: "web" },
    });
    fireEvent.change(page().getByTestId("service-name"), {
      target: { value: "Web" },
    });
    fireEvent.click(
      within(page().getByTestId("service-groups")).getByLabelText(
        "cards (cards)",
      ),
    );
    fireEvent.change(page().getByTestId("service-hosts"), {
      target: { value: "web.example.com\n\n api.example.com " },
    });
    fireEvent.click(page().getByTestId("service-save"));
    await waitFor(() =>
      expect(writes(api.calls, "POST", "/services")).toHaveLength(1),
    );
    expect(writes(api.calls, "POST", "/services")[0]?.body).toEqual({
      id: "web",
      name: "Web",
      groups: ["cards"],
      environment: "",
      hosts: ["web.example.com", "api.example.com"],
      topology: "a",
      labels: {},
      requireStepUp: false,
    });
  });

  it("is saved at the revision read; a 409 is shown with a reload", async () => {
    const { api } = renderApp({
      path: "/services/checkout?scope=global",
      routes: { ...routes(), "PUT /services/:id": problem(409, "conflict") },
    });
    await page().findByTestId("service-form", {}, LOADED);
    fireEvent.change(page().getByTestId("service-environment"), {
      target: { value: "staging" },
    });
    fireEvent.click(page().getByTestId("service-save"));
    await page().findByTestId("service-conflict", {}, LOADED);
    expect(
      writes(api.calls, "PUT", "/services/checkout")[0]?.body,
    ).toMatchObject({
      environment: "staging",
      revision: 4,
    });
  });

  it("is deleted at the revision read once its id is typed", async () => {
    const { api } = renderApp({
      path: "/services/checkout?scope=global",
      routes: { ...routes(), "DELETE /services/:id": { status: 204 } },
    });
    await page().findByTestId("service-form", {}, LOADED);
    fireEvent.click(page().getByTestId("service-delete"));
    const dialog = await page().findByRole("alertdialog", {}, LOADED);
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "checkout" },
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(writes(api.calls, "DELETE", "/services/checkout")).toHaveLength(1),
    );
    expect(
      writes(api.calls, "DELETE", "/services/checkout")[0]?.query.get(
        "revision",
      ),
    ).toBe("4");
  });
});

describe("groups", () => {
  it("nest as a tree, with their member services", async () => {
    renderApp({ path: "/groups?scope=global", routes: routes() });
    const payments = await page().findByTestId("group-payments", {}, LOADED);
    within(within(payments).getByTestId("group-cards")).getByTestId(
      "group-emea",
    );
    expect(payments.querySelector(".groups-node")?.textContent).toContain(
      "Checkout",
    );
    expectAbsent(
      page().getByTestId("group-ops").closest('[data-testid="group-payments"]'),
      "ops under payments",
    );
  });

  it("a group's parent cannot be itself or one under it", async () => {
    renderApp({ path: "/groups?scope=global", routes: routes() });
    await page().findByTestId("group-cards", {}, LOADED);
    fireEvent.click(page().getByTestId("group-edit-cards"));
    const dialog = await page().findByRole("dialog", {}, LOADED);
    const options = [
      ...within(dialog).getByTestId<HTMLSelectElement>("group-parent").options,
    ].map((option) => option.value);
    expect(options).toEqual(["", "payments", "ops"]);
  });

  it("a save someone's change went before is a 409, shown in the dialog", async () => {
    const { api } = renderApp({
      path: "/groups?scope=global",
      routes: { ...routes(), "PUT /groups/:id": problem(409, "conflict") },
    });
    await page().findByTestId("group-ops", {}, LOADED);
    fireEvent.click(page().getByTestId("group-edit-ops"));
    const dialog = await page().findByRole("dialog", {}, LOADED);
    fireEvent.change(within(dialog).getByTestId("group-parent"), {
      target: { value: "payments" },
    });
    fireEvent.click(within(dialog).getByTestId("group-save"));
    await within(dialog).findByTestId("group-conflict", {}, LOADED);
    expect(writes(api.calls, "PUT", "/groups/ops")[0]?.body).toEqual({
      name: "ops",
      parent: "payments",
      labels: {},
      revision: 2,
    });
  });
});

describe("write rights on an item's own scope", () => {
  /** The permissions an operator bound on group `payments` gets (the API answers its groups and services under it too). */
  const groupBound = defaultRoutes({
    permissions: {
      global: {
        "services:read": true,
        "groups:read": true,
        "policy:read": true,
      },
      "group:payments": { "groups:write": true, "services:write": true },
      "group:cards": { "groups:write": true, "services:write": true },
      "group:emea": { "groups:write": true, "services:write": true },
      "service:checkout": { "services:write": true },
    },
  })["GET /meta/permissions"];
  /** No write anywhere. */
  const readOnly = defaultRoutes({
    permissions: {
      global: {
        "services:read": true,
        "groups:read": true,
        "policy:read": true,
      },
    },
  })["GET /meta/permissions"];

  it("a binding on a group shows Edit on it and the groups under it, not on a sibling, and no New group", async () => {
    renderApp({
      path: "/groups?scope=global",
      routes: { ...routes(), "GET /meta/permissions": groupBound },
    });
    await page().findByTestId("group-edit-payments", {}, LOADED);
    page().getByTestId("group-edit-cards");
    page().getByTestId("group-delete-emea");
    expectAbsent(
      page().queryByTestId("group-edit-ops"),
      "Edit on a sibling group",
    );
    expectAbsent(page().queryByTestId("new-group"), "New group without global");
  });

  it("…and Save on a service in that group", async () => {
    renderApp({
      path: "/services/checkout?scope=global",
      routes: { ...routes(), "GET /meta/permissions": groupBound },
    });
    await page().findByTestId("service-save", {}, LOADED);
  });

  it("…and not on a service outside it", async () => {
    renderApp({
      path: "/services/ledger?scope=global",
      routes: { ...routes(), "GET /meta/permissions": groupBound },
    });
    await page().findByTestId("service-form", {}, LOADED);
    // Its rights are read before the buttons show: give them a moment.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expectAbsent(
      page().queryByTestId("service-save"),
      "Save outside the group",
    );
    expectAbsent(
      page().queryByTestId("service-delete"),
      "Delete outside the group",
    );
  });

  it("global write shows every Edit and New group", async () => {
    renderApp({ path: "/groups?scope=global", routes: routes() });
    await page().findByTestId("new-group", {}, LOADED);
    for (const id of ["payments", "cards", "emea", "ops"])
      page().getByTestId(`group-edit-${id}`);
  });

  it("without write anywhere, no Edit, Delete, Save or New", async () => {
    renderApp({
      path: "/groups?scope=global",
      routes: { ...routes(), "GET /meta/permissions": readOnly },
    });
    await page().findByTestId("group-payments", {}, LOADED);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expectAbsent(page().queryByTestId("group-edit-payments"), "Edit");
    expectAbsent(page().queryByTestId("group-delete-ops"), "Delete");
    expectAbsent(page().queryByTestId("new-group"), "New group");
  });
});
