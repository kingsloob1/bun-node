/**
 * The agents screens (PR-U5, ui.md §8): the list's health (state, bundle,
 * what each reported wrong), a control plane without agents, an agent's
 * detail (warnings, feeds, ban reports dropped), rotate (a step-up, the
 * new secret shown once and the old one's expiry), revoke, the actions
 * absent without `agents:write` on the agent's service, and a new agent's
 * key (the scope's service pre-filled, the secret shown once).
 */
import type { MockCall, MockHandler, MockReply } from "./mockApi";
import { describe, expect, it } from "bun:test";
import { expectAbsent } from "../../harness/assert";
import { act, fireEvent, LOADED, page, setupDom, waitFor, within } from "./dom";
import { defaultRoutes, problem } from "./mockApi";
import { renderApp } from "./renderApp";

setupDom();

/** An agent as the API returns it. */
function agent(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    service: "checkout",
    name: id,
    createdAt: 1_000,
    createdBy: "alice",
    rotatedAt: null,
    previousAcceptedUntil: null,
    revokedAt: null,
    status: "ok",
    lastSeen: 2_000,
    reported: {
      agentVersion: "1",
      bundleVersion: 7,
      bundleKeyId: "sk_1",
      bundleExpired: false,
      banSeq: "12",
      banCount: 3,
      health: "ok",
      warnings: [],
      bansDropped: 0,
    },
    revision: 2,
    ...over,
  };
}

/** The agents routes over `items`. */
function agentsRoutes(
  items: ReturnType<typeof agent>[],
  extra: Record<string, MockHandler | MockReply> = {},
): Record<string, MockHandler | MockReply> {
  return {
    "GET /agents": { body: { items } },
    "GET /agents/:id": (call: MockCall) => {
      const found = items.find((item) => call.path.endsWith(`/${item.id}`));
      return found === undefined ? problem(404, "not_found") : { body: found };
    },
    ...extra,
  };
}

describe("the agents list", () => {
  it("shows each agent's state, bundle and what it reported wrong", async () => {
    renderApp({
      path: "/agents",
      routes: agentsRoutes([
        agent("a1"),
        agent("a2", {
          status: "late",
          reported: {
            ...agent("x").reported,
            warnings: [{ kind: "store.down", since: 1 }],
            bansDropped: 4,
          },
        }),
      ]),
    });
    const rows = await page().findAllByTestId("agent-row", {}, LOADED);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("OK");
    expect(rows[0]!.textContent).toContain("v7 (sk_1)");
    expect(rows[1]!.textContent).toContain("Late");
    expect(rows[1]!.textContent).toContain("1 warning, 4 ban reports dropped");
  });

  it("says so when the control plane serves no agents", async () => {
    renderApp({
      path: "/agents",
      routes: { "GET /agents": problem(404, "not_found") },
    });
    expect(
      (await page().findByTestId("agents-off", {}, LOADED)).textContent,
    ).toContain("serves no agents");
  });
});

describe("an agent", () => {
  it("shows its warnings, feeds and dropped ban reports", async () => {
    renderApp({
      path: "/agents/a1",
      routes: agentsRoutes([
        agent("a1", {
          reported: {
            ...agent("x").reported,
            warnings: [{ kind: "trust.misconfigured", since: 5, share: 0.25 }],
            intel: {
              feeds: [
                {
                  id: "tor",
                  size: 1200,
                  refreshedAt: 10,
                  attemptedAt: 20,
                  error: "timeout",
                },
              ],
            },
            bansDropped: 3,
          },
        }),
      ]),
    });
    await page().findByTestId("agent-detail", {}, LOADED);
    expect(page().getByTestId("agent-warnings").textContent).toContain(
      "trust.misconfigured",
    );
    expect(page().getByTestId("agent-warnings").textContent).toContain(
      "25% of requests",
    );
    expect(page().getByTestId("agent-feeds").textContent).toContain("timeout");
    expect(page().getByTestId("agent-bans-dropped").textContent).toContain(
      "3 since its previous heartbeat",
    );
  });

  it("rotates through a step-up and shows the new secret once, with the old one's expiry", async () => {
    let rotated = 0;
    const { api } = renderApp({
      path: "/agents/a1",
      routes: agentsRoutes([agent("a1")], {
        "POST /agents/:id/rotate": () => {
          rotated++;
          return {
            body: {
              agent: agent("a1", {
                rotatedAt: 3_000,
                previousAcceptedUntil: 90_000_000,
              }),
              secret: "s3cr3t-value",
            },
          };
        },
      }),
    });
    await page().findByTestId("agent-detail", {}, LOADED);
    fireEvent.click(await page().findByTestId("agent-rotate", {}, LOADED));
    expect(
      (await page().findByTestId("secret-value", {}, LOADED)).textContent,
    ).toBe("s3cr3t-value");
    expect(page().getByTestId("secret-once").textContent).toContain(
      "old secret is accepted until",
    );
    const call = api.calls.find((c) => c.path === "/agents/a1/rotate")!;
    expect(call.body).toEqual({ revision: 2 });
    expect(rotated).toBe(1);
    fireEvent.click(page().getByTestId("secret-done"));
    await waitFor(() =>
      expectAbsent(page().queryByTestId("secret-value"), "the secret"),
    );
  });

  it("revokes after a confirmation", async () => {
    const { api } = renderApp({
      path: "/agents/a1",
      routes: agentsRoutes([agent("a1")], {
        "POST /agents/:id/revoke": {
          body: agent("a1", { revokedAt: 4_000, status: "revoked" }),
        },
      }),
    });
    fireEvent.click(await page().findByTestId("agent-revoke", {}, LOADED));
    const dialog = await page().findByRole("alertdialog", {}, LOADED);
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(api.calls.some((c) => c.path === "/agents/a1/revoke")).toBe(true),
    );
  });

  it("without agents:write on its service, no rotate or revoke; with it, both", async () => {
    for (const write of [false, true]) {
      const { view, api } = renderApp({
        path: "/agents/a1",
        routes: {
          ...defaultRoutes({
            permissions: {
              global: { "agents:read": true, "policy:read": true },
              "service:checkout": { "agents:write": write },
            },
          }),
          ...agentsRoutes([agent("a1")]),
        },
      });
      await page().findByTestId("agent-facts", {}, LOADED);
      if (write) {
        expect(
          await page().findByTestId("agent-rotate", {}, LOADED),
        ).toBeTruthy();
        expect(page().getByTestId("agent-revoke")).toBeTruthy();
      } else {
        // The service's permissions answered, then rendered: only then
        // does an absence mean anything.
        await waitFor(() =>
          expect(
            api.calls.some(
              (c) =>
                c.path === "/meta/permissions" &&
                c.query.get("scope") === "service:checkout",
            ),
          ).toBe(true),
        );
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        expectAbsent(page().queryByTestId("agent-rotate"), "rotate");
        expectAbsent(page().queryByTestId("agent-revoke"), "revoke");
      }
      view.unmount();
    }
  });
});

describe("a new agent", () => {
  it("pre-fills the scope's service and shows the secret once", async () => {
    const { api } = renderApp({
      path: "/agents/new?scope=service%3Acheckout",
      routes: agentsRoutes([], {
        "POST /agents": {
          status: 201,
          body: { agent: agent("checkout-2"), secret: "fresh-secret" },
        },
      }),
    });
    const service = (await page().findByTestId(
      "agent-service",
      {},
      LOADED,
    )) as HTMLInputElement;
    expect(service.value).toBe("checkout");
    fireEvent.change(page().getByTestId("agent-id"), {
      target: { value: "checkout-2" },
    });
    fireEvent.click(page().getByTestId("agent-create"));
    expect(
      (await page().findByTestId("secret-value", {}, LOADED)).textContent,
    ).toBe("fresh-secret");
    expect(
      api.calls.find((c) => c.path === "/agents" && c.method === "POST")!.body,
    ).toEqual({
      service: "checkout",
      id: "checkout-2",
    });
  });

  it("refuses a malformed id before asking the API", async () => {
    const { api } = renderApp({
      path: "/agents/new?scope=service%3Acheckout",
      routes: agentsRoutes([]),
    });
    fireEvent.change(await page().findByTestId("agent-id", {}, LOADED), {
      target: { value: "no spaces" },
    });
    fireEvent.click(page().getByTestId("agent-create"));
    expect((await page().findByRole("alert")).textContent).toContain(
      "An id is 1 to 64",
    );
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });
});
