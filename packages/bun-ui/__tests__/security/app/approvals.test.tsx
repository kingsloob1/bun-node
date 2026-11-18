/**
 * The approvals screens (PR-U5, ui.md §8): the list; a policy change's
 * detail with its own diff and, with `rules:test`, its impact estimate;
 * another change's summary; approve and reject with a reason (behind a
 * step-up), never offered to the author, nor to an operator who may not
 * make the change on its scope; a stale outcome said so.
 */
import type { MockCall, MockHandler, MockReply } from "./mockApi";
import { describe, expect, it } from "bun:test";
import { expectAbsent } from "../../harness/assert";
import { act, fireEvent, LOADED, page, setupDom, waitFor } from "./dom";
import { defaultRoutes } from "./mockApi";
import { renderApp } from "./renderApp";

setupDom();

/** An approval as the API returns it. */
function approval(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    action: "policy.publish",
    scope: "group:payments",
    status: "pending",
    author: "alice",
    createdAt: 1_000,
    expiresAt: 90_000_000,
    decidedBy: null,
    decidedAt: null,
    reason: null,
    dangerous: ["service checkout: limits[id=x]: from dry run to enforced"],
    summary: { message: "enforce x" },
    revision: 1,
    ...over,
  };
}

/** The approvals routes over `items`. */
function approvalsRoutes(
  items: ReturnType<typeof approval>[],
  extra: Record<string, MockHandler | MockReply> = {},
): Record<string, MockHandler | MockReply> {
  return {
    "GET /approvals": { body: { items } },
    "GET /approvals/:id": (call: MockCall) => ({
      body: items.find((item) => call.path.endsWith(`/${item.id}`)),
    }),
    "GET /approvals/:id/diff": (call: MockCall) => ({
      body: {
        from: "v3",
        to: `approval:${call.path.split("/")[2]}`,
        changes: [
          { path: "limits[id=x].mode", before: "dryRun", after: "enforce" },
        ],
      },
    }),
    "POST /approvals/:id/impact": {
      body: {
        window: { from: 0, to: 1 },
        events: { read: 12, stoppedBy: null },
        services: { replayed: ["checkout"], skipped: [] },
        transitions: [{ from: "allow", to: "refuse", count: 12 }],
        rules: [],
        routes: [],
        subjects: {},
        labels: [],
        tookMs: 3,
      },
    },
    ...extra,
  };
}

describe("the approvals list", () => {
  it("lists each approval with what it would do and where it stands", async () => {
    renderApp({
      path: "/approvals",
      routes: approvalsRoutes([
        approval("ap1"),
        approval("ap2", { action: "bans.lift", status: "approved" }),
      ]),
    });
    const rows = await page().findAllByTestId("approval-row", {}, LOADED);
    expect(rows[0]!.textContent).toContain("Publish a policy");
    expect(rows[0]!.textContent).toContain("Pending");
    expect(rows[1]!.textContent).toContain("Lift matching bans");
    expect(rows[1]!.textContent).toContain("Approved");
  });
});

describe("a policy change", () => {
  it("shows its own diff and why, estimates its impact on demand, and approves with a reason", async () => {
    const { api } = renderApp({
      path: "/approvals/ap1",
      routes: approvalsRoutes([approval("ap1")], {
        "POST /approvals/:id/approve": {
          body: {
            approval: approval("ap1", { status: "approved", decidedBy: "op" }),
          },
        },
      }),
    });
    expect(
      (await page().findByTestId("approval-diff", {}, LOADED)).textContent,
    ).toContain("limits[id=x].mode");
    expect(page().getByTestId("approval-dangerous").textContent).toContain(
      "from dry run to enforced",
    );
    // Only on demand.
    expect(api.calls.some((c) => c.path.endsWith("/impact"))).toBe(false);
    fireEvent.click(page().getByTestId("approval-impact"));
    expect(
      (await page().findByTestId("approval-impact-summary", {}, LOADED))
        .textContent,
    ).toContain("12: allow → refuse");
    fireEvent.change(page().getByTestId("approval-reason"), {
      target: { value: "looks right" },
    });
    fireEvent.click(page().getByTestId("approval-approve"));
    expect(
      (await page().findByTestId("approval-outcome", {}, LOADED)).textContent,
    ).toBe("Approved: the change is carried out.");
    expect(
      api.calls.find((c) => c.path === "/approvals/ap1/approve")!.body,
    ).toEqual({
      revision: 1,
      reason: "looks right",
    });
  });

  it("says when the approved change was stale", async () => {
    renderApp({
      path: "/approvals/ap1",
      routes: approvalsRoutes([approval("ap1")], {
        "POST /approvals/:id/approve": {
          body: { approval: approval("ap1", { status: "stale" }) },
        },
      }),
    });
    fireEvent.click(await page().findByTestId("approval-approve", {}, LOADED));
    expect(
      (await page().findByTestId("approval-outcome", {}, LOADED)).textContent,
    ).toContain("Stale");
  });

  it("rejects", async () => {
    const { api } = renderApp({
      path: "/approvals/ap1",
      routes: approvalsRoutes([approval("ap1")], {
        "POST /approvals/:id/reject": {
          body: { approval: approval("ap1", { status: "rejected" }) },
        },
      }),
    });
    fireEvent.click(await page().findByTestId("approval-reject", {}, LOADED));
    expect(
      (await page().findByTestId("approval-outcome", {}, LOADED)).textContent,
    ).toBe("Rejected.");
    expect(api.calls.some((c) => c.path === "/approvals/ap1/reject")).toBe(
      true,
    );
  });
});

describe("another change", () => {
  it("shows its summary, and reads no diff", async () => {
    const { api } = renderApp({
      path: "/approvals/ap2",
      routes: approvalsRoutes([
        approval("ap2", {
          action: "bans.lift",
          dangerous: [],
          summary: { matched: 1204 },
        }),
      ]),
    });
    await page().findByTestId("approval-detail", {}, LOADED);
    expect(page().getByText(/1204/)).toBeTruthy();
    expect(api.calls.some((c) => c.path.endsWith("/diff"))).toBe(false);
    expectAbsent(page().queryByTestId("approval-impact"), "the estimate");
  });
});

describe("who may decide", () => {
  /** Waits until the approval scope's permissions have answered and rendered. */
  async function settled(api: { calls: MockCall[] }) {
    await waitFor(() =>
      expect(
        api.calls.some(
          (c) =>
            c.path === "/meta/permissions" &&
            c.query.get("scope") === "group:payments",
        ),
      ).toBe(true),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  it("never the author", async () => {
    const { api } = renderApp({
      path: "/approvals/ap1",
      routes: approvalsRoutes([approval("ap1", { author: "op" })]),
    });
    await page().findByTestId("approval-diff", {}, LOADED);
    await settled(api);
    expect(page().getByTestId("approval-facts").textContent).toContain(
      "you: another operator decides",
    );
    expectAbsent(page().queryByTestId("approval-approve"), "approve");
    expectAbsent(page().queryByTestId("approval-reject"), "reject");
  });

  it("not without the change's permission on its scope (and no estimate without rules:test); the control: with them", async () => {
    for (const allowed of [false, true]) {
      const { view, api } = renderApp({
        path: "/approvals/ap1",
        routes: {
          ...defaultRoutes({
            permissions: {
              global: { "approvals:read": true, "policy:read": true },
              "group:payments": {
                "approvals:read": true,
                "policy:read": true,
                "policy:publish": allowed,
                "rules:test": allowed,
              },
            },
          }),
          ...approvalsRoutes([approval("ap1")]),
        },
      });
      await page().findByTestId("approval-diff", {}, LOADED);
      await settled(api);
      if (allowed) {
        expect(page().getByTestId("approval-approve")).toBeTruthy();
        expect(page().getByTestId("approval-impact")).toBeTruthy();
      } else {
        expectAbsent(page().queryByTestId("approval-approve"), "approve");
        expectAbsent(page().queryByTestId("approval-impact"), "the estimate");
      }
      view.unmount();
    }
  });
});
