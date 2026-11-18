/**
 * The alerts screens (PR-U5, ui.md §8): the open alerts (read-only), the
 * rules (listed with what they watch; made through the form, a stale one
 * said so), the channels (a webhook's secret shown once, the URL
 * write-only, test, rotate behind a step-up), the delivery log and the
 * dead letters (replay), and the control plane's own tabs absent without
 * `alerts:read` on `global`.
 */
import type { MockCall, MockHandler, MockReply } from "./mockApi";
import { describe, expect, it } from "bun:test";
import { expectAbsent } from "../../harness/assert";
import { act, fireEvent, LOADED, page, setupDom, waitFor } from "./dom";
import { defaultRoutes, problem } from "./mockApi";
import { renderApp } from "./renderApp";

setupDom();

/** A rule as the API answers it. */
function rule(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title: `Rule ${id}`,
    scope: "global",
    severity: "warning",
    condition: { type: "banStorm", windowMs: 600_000, value: 50 },
    channels: ["ops"],
    enabled: true,
    revision: 3,
    ...over,
  };
}

/** A channel as the API answers it. */
function channel(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `Channel ${id}`,
    type: "webhook",
    url: "https://hooks.example.com",
    revision: 1,
    ...over,
  };
}

/** The alerts routes. */
function alertsRoutes(
  extra: Record<string, MockHandler | MockReply> = {},
): Record<string, MockHandler | MockReply> {
  return {
    "GET /alerts/open": {
      body: { items: [{ rule: "storm", scope: "global", since: 5_000 }] },
    },
    "GET /alerts/rules": { body: { items: [rule("storm")] } },
    "GET /alerts/rules/:id": { body: rule("storm") },
    "GET /alerts/channels": { body: { items: [channel("ops")] } },
    "GET /alerts/channels/:id": { body: channel("ops") },
    "GET /alerts/deliveries": {
      body: {
        items: [
          {
            id: "d1",
            channelId: "ops",
            kind: "agent.banReportsDropped",
            severity: "warning",
            outcome: "failed",
            attempts: 2,
            at: 6_000,
            reason: "HTTP 502",
          },
        ],
      },
    },
    "GET /alerts/dead-letters": {
      body: {
        items: [
          {
            id: "d9",
            channelId: "ops",
            kind: "digest",
            severity: null,
            attempts: 8,
            reason: "HTTP 500",
            queuedAt: 1_000,
            diedAt: 9_000,
          },
        ],
      },
    },
    ...extra,
  };
}

describe("the open alerts", () => {
  it("lists them, read-only, each linking to its rule", async () => {
    renderApp({ path: "/alerts", routes: alertsRoutes() });
    const row = (
      await page().findAllByTestId("alert-open-row", {}, LOADED)
    )[0]!;
    expect(row.textContent).toContain("storm");
    expectAbsent(
      page().queryByRole("button", { name: /close|acknowledge/i }),
      "a close button",
    );
  });
});

describe("the rules", () => {
  it("lists each rule with what it watches", async () => {
    renderApp({ path: "/alerts/rules", routes: alertsRoutes() });
    const row = (
      await page().findAllByTestId("alert-rule-row", {}, LOADED)
    )[0]!;
    expect(row.textContent).toContain("≥ 50 bans in 10 min");
    expect(row.textContent).toContain("ops");
  });

  it("makes a rule from the form: the condition's fields, the channels, revision null", async () => {
    const { api } = renderApp({
      path: "/alerts/rules/new",
      routes: alertsRoutes({
        "PUT /alerts/rules/:id": { body: rule("spike") },
      }),
    });
    fireEvent.change(await page().findByTestId("rule-id", {}, LOADED), {
      target: { value: "spike" },
    });
    fireEvent.change(page().getByTestId("rule-title"), {
      target: { value: "Block spike" },
    });
    fireEvent.change(page().getByTestId("condition-type"), {
      target: { value: "rate" },
    });
    fireEvent.change(page().getByTestId("condition-dims"), {
      target: { value: "action=block" },
    });
    fireEvent.change(page().getByTestId("condition-value"), {
      target: { value: "120" },
    });
    fireEvent.click(await page().findByTestId("rule-channel-ops", {}, LOADED));
    fireEvent.click(page().getByTestId("rule-save"));
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === "PUT")).toBe(true),
    );
    const put = api.calls.find((c) => c.method === "PUT")!;
    expect(put.path).toBe("/alerts/rules/spike");
    expect(put.body).toEqual({
      title: "Block spike",
      scope: "global",
      severity: "warning",
      condition: {
        type: "rate",
        metric: "requests",
        dims: { action: "block" },
        windowMs: 300_000,
        value: 120,
      },
      channels: ["ops"],
      enabled: true,
      revision: null,
    });
  });

  it("refuses a form it cannot send, and says when the rule changed meanwhile", async () => {
    const { api } = renderApp({
      path: "/alerts/rules/storm",
      routes: alertsRoutes({
        "PUT /alerts/rules/:id": problem(409, "conflict"),
      }),
    });
    const value = await page().findByTestId("condition-value", {}, LOADED);
    expect((value as HTMLInputElement).value).toBe("50");
    fireEvent.change(value, { target: { value: "0" } });
    fireEvent.click(page().getByTestId("rule-save"));
    expect((await page().findByRole("alert")).textContent).toBe(
      "The number of bans must be a whole number above 0",
    );
    expect(api.calls.some((c) => c.method === "PUT")).toBe(false);
    fireEvent.change(value, { target: { value: "60" } });
    fireEvent.click(page().getByTestId("rule-save"));
    await waitFor(() =>
      expect(page().getByRole("alert").textContent).toContain(
        "changed meanwhile",
      ),
    );
    expect(api.calls.find((c) => c.method === "PUT")!.body).toMatchObject({
      revision: 3,
    });
  });
});

describe("the channels", () => {
  it("makes a webhook through a step-up and shows its signing secret once", async () => {
    let stepped = false;
    const original = Object.getOwnPropertyDescriptor(window, "open");
    window.open = (() => ({ closed: false })) as unknown as typeof window.open;
    try {
      const { api } = renderApp({
        path: "/alerts/channels/new",
        routes: alertsRoutes({
          "POST /alerts/channels": () =>
            stepped
              ? {
                  status: 201,
                  body: { channel: channel("pager"), secret: "whsec_1" },
                }
              : problem(401, "step_up_required", {
                  stepUpUrl: "/auth/step-up",
                }),
        }),
      });
      fireEvent.change(await page().findByTestId("channel-id", {}, LOADED), {
        target: { value: "pager" },
      });
      fireEvent.change(page().getByTestId("channel-name"), {
        target: { value: "Pager" },
      });
      fireEvent.change(page().getByTestId("channel-url"), {
        target: { value: "https://hooks.example.com/abc" },
      });
      fireEvent.change(page().getByTestId("channel-kinds"), {
        target: { value: "breakGlass.login, *" },
      });
      fireEvent.click(page().getByTestId("channel-save"));
      await waitFor(() =>
        expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(1),
      );
      stepped = true;
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: "http://localhost",
            data: { type: "bun-security:step-up", ok: true },
          }),
        );
      });
      expect(
        (await page().findByTestId("secret-value", {}, LOADED)).textContent,
      ).toBe("whsec_1");
      expect(api.calls.filter((c) => c.method === "POST")[1]!.body).toEqual({
        id: "pager",
        name: "Pager",
        type: "webhook",
        url: "https://hooks.example.com/abc",
        receives: { kinds: ["breakGlass.login", "*"] },
      });
    } finally {
      if (original === undefined) Reflect.deleteProperty(window, "open");
      else Object.defineProperty(window, "open", original);
    }
  });

  it("saves a channel without its URL unless one is typed; sends a test", async () => {
    const { api } = renderApp({
      path: "/alerts/channels/ops",
      routes: alertsRoutes({
        "PUT /alerts/channels/:id": { body: channel("ops", { revision: 2 }) },
        "POST /alerts/channels/:id/test": { status: 202 },
      }),
    });
    fireEvent.change(await page().findByTestId("channel-name", {}, LOADED), {
      target: { value: "Ops room" },
    });
    expect((page().getByTestId("channel-url") as HTMLInputElement).value).toBe(
      "",
    );
    fireEvent.click(page().getByTestId("channel-save"));
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === "PUT")).toBe(true),
    );
    expect(api.calls.find((c) => c.method === "PUT")!.body).toEqual({
      name: "Ops room",
      receives: null,
      revision: 1,
    });
    fireEvent.click(page().getByTestId("channel-test"));
    expect(
      (await page().findByTestId("channel-status", {}, LOADED)).textContent,
    ).toContain("test message is queued");
  });
});

describe("the delivery log and dead letters", () => {
  it("lists tries by channel, never their message", async () => {
    const { api } = renderApp({
      path: "/alerts/deliveries?channel=ops",
      routes: alertsRoutes(),
    });
    const row = (await page().findAllByTestId("delivery-row", {}, LOADED))[0]!;
    expect(row.textContent).toContain("Failed, retried");
    expect(row.textContent).toContain("HTTP 502");
    const call = api.calls.find((c) => c.path === "/alerts/deliveries")!;
    expect(call.query.get("channel")).toBe("ops");
  });

  it("replays a dead letter", async () => {
    const replayed: MockCall[] = [];
    renderApp({
      path: "/alerts/dead-letters",
      routes: alertsRoutes({
        "POST /alerts/dead-letters/:id/replay": (call: MockCall) => {
          replayed.push(call);
          return { status: 202 };
        },
      }),
    });
    fireEvent.click(
      await page().findByTestId("dead-letter-replay", {}, LOADED),
    );
    expect(
      (await page().findByTestId("replay-outcome", {}, LOADED)).textContent,
    ).toBe("Dead letter d9 queued again.");
    expect(replayed[0]!.path).toBe("/alerts/dead-letters/d9/replay");
  });
});

describe("permissions", () => {
  it("without alerts:read on global, only the open alerts and the rules; without alerts:write, no replay or new rule", async () => {
    renderApp({
      path: "/alerts?scope=service%3Acheckout",
      routes: {
        ...defaultRoutes({
          permissions: {
            global: { "policy:read": true },
            "service:checkout": { "alerts:read": true, "policy:read": true },
          },
        }),
        ...alertsRoutes(),
      },
    });
    await page().findAllByTestId("alert-open-row", {}, LOADED);
    const tabs = page()
      .getAllByRole("tab")
      .map((tab) => tab.textContent);
    expect(tabs).toEqual(["Open", "Rules"]);
    fireEvent.click(page().getByRole("tab", { name: "Rules" }));
    await page().findAllByTestId("alert-rule-row", {}, LOADED);
    expectAbsent(page().queryByTestId("new-alert-rule"), "the new rule link");
  });

  it("the control: with them, every tab and the new rule link", async () => {
    renderApp({ path: "/alerts/rules", routes: alertsRoutes() });
    await page().findAllByTestId("alert-rule-row", {}, LOADED);
    expect(page().getAllByRole("tab")).toHaveLength(5);
    expect(page().getByTestId("new-alert-rule")).toBeTruthy();
  });
});
