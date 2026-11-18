/**
 * The audit screens (PR-U5, ui.md §8): the list's filters in the URL and
 * the request (the scope on screen off `global`), the chain's latest
 * checkpoint and its verification on demand (intact, and broken with its
 * problems), an entry's detail (its diff, its before and after), and the
 * export behind a step-up (absent without `audit:export`).
 */
import type { MockCall, MockHandler, MockReply } from "./mockApi";
import { describe, expect, it, spyOn } from "bun:test";
import { expectAbsent, expectNone } from "../../harness/assert";
import { act, fireEvent, LOADED, page, setupDom, waitFor } from "./dom";
import { defaultRoutes, problem } from "./mockApi";
import { renderApp } from "./renderApp";

setupDom();

/** An audit entry as the API returns it. */
function entry(n: number, over: Record<string, unknown> = {}) {
  return {
    n,
    at: 1_700_000_000_000 + n,
    hash: `h${n}`,
    prevHash: `h${n - 1}`,
    actor: "alice",
    action: "service.put",
    scope: "service:checkout",
    phase: "event",
    entry: { actor: "alice" },
    ...over,
  };
}

/** The audit routes: a list of `items`, one checkpoint, a verify answer. */
function auditRoutes(
  items: unknown[],
  extra: Record<string, MockHandler | MockReply> = {},
): Record<string, MockHandler | MockReply> {
  return {
    "GET /audit": (call: MockCall) => ({
      body: {
        items,
        ...(call.query.has("cursor") ? {} : { next: "c-2" }),
      },
    }),
    "GET /audit/checkpoints": {
      body: {
        items: [
          {
            n: 40,
            hash: "h40",
            at: 1_700_000_000_040,
            keyId: "ak_1",
            signature: "s",
          },
        ],
      },
    },
    "GET /audit/verify": {
      body: {
        ok: true,
        checked: 42,
        first: 1,
        last: 42,
        checkpoints: { checked: 3, latest: 40 },
        external: "none-configured",
        problems: [],
        unconfirmed: [],
      },
    },
    ...extra,
  };
}

/** The `GET /audit` calls so far. */
const listCalls = (calls: readonly MockCall[]) =>
  calls.filter((call) => call.method === "GET" && call.path === "/audit");

describe("the audit log", () => {
  it("lists the entries; filters go into the URL and the request; off global, the scope too", async () => {
    const { api } = renderApp({
      path: "/audit?scope=service%3Acheckout",
      routes: auditRoutes([
        entry(2),
        entry(1, { phase: "intent", status: "not-applied" }),
      ]),
    });
    const rows = await page().findAllByTestId("audit-row", {}, LOADED);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.textContent).toContain("Intent, not applied");
    expect(listCalls(api.calls)[0]!.query.get("scope")).toBe(
      "service:checkout",
    );
    expect(listCalls(api.calls)[0]!.query.get("direction")).toBe("desc");
    const actor = page().getByTestId("filter-actor");
    fireEvent.change(actor, { target: { value: "bob" } });
    fireEvent.keyDown(actor, { key: "Enter" });
    await waitFor(() =>
      expect(listCalls(api.calls).at(-1)!.query.get("actor")).toBe("bob"),
    );
    expect(new URLSearchParams(window.location.search).get("actor")).toBe(
      "bob",
    );
    fireEvent.change(page().getByTestId("filter-direction"), {
      target: { value: "asc" },
    });
    await waitFor(() =>
      expect(listCalls(api.calls).at(-1)!.query.get("direction")).toBe("asc"),
    );
  });

  it("the control: on global, no scope filter is sent", async () => {
    const { api } = renderApp({
      path: "/audit",
      routes: auditRoutes([entry(1)]),
    });
    await page().findAllByTestId("audit-row", {}, LOADED);
    expect(listCalls(api.calls)[0]!.query.has("scope")).toBe(false);
  });

  it("shows the latest checkpoint, and verifies the chain only when asked", async () => {
    const { api } = renderApp({
      path: "/audit",
      routes: auditRoutes([entry(1)]),
    });
    expect(
      (await page().findByText(/Latest checkpoint: entry 40/, {}, LOADED))
        .textContent,
    ).toContain("ak_1");
    const verifies = () =>
      api.calls.filter((call) => call.path === "/audit/verify");
    expectNone(verifies(), "verifications before asking");
    fireEvent.click(page().getByTestId("audit-verify"));
    const verdict = await page().findByTestId("audit-verdict", {}, LOADED);
    expect(verdict.textContent).toContain("Intact");
    expect(verdict.textContent).toContain("42 entries checked");
    expect(verifies()).toHaveLength(1);
  });

  it("a broken chain names its problems and the unconfirmed intents", async () => {
    renderApp({
      path: "/audit",
      routes: auditRoutes([entry(1)], {
        "GET /audit/verify": {
          body: {
            ok: false,
            checked: 10,
            first: 1,
            last: 10,
            checkpoints: { checked: 1, latest: 5 },
            external: "checked",
            problems: [
              { n: 7, reason: "hash-mismatch", detail: "entry 7 was edited" },
            ],
            unconfirmed: [
              {
                n: 9,
                action: "policy.publish",
                scope: "global",
                status: "completed-unconfirmed",
              },
            ],
          },
        },
      }),
    });
    await page().findAllByTestId("audit-row", {}, LOADED);
    fireEvent.click(page().getByTestId("audit-verify"));
    const verdict = await page().findByTestId("audit-verdict", {}, LOADED);
    expect(verdict.textContent).toContain("Broken");
    expect(page().getByTestId("audit-problems").textContent).toContain(
      "Entry 7: hash-mismatch, entry 7 was edited",
    );
    expect(page().getByTestId("audit-unconfirmed").textContent).toContain(
      "the change is there",
    );
  });

  it("an entry shows its diff, its before and after, and its hash chain", async () => {
    renderApp({
      path: "/audit/12",
      routes: auditRoutes([], {
        "GET /audit/:n": {
          body: entry(12, {
            action: "policy.publish",
            phase: "intent",
            status: "done",
            entry: {
              actor: "alice",
              diff: [{ path: "limits[id=x].limit", before: 10, after: 20 }],
              before: { limit: 10 },
              after: { limit: 20 },
            },
          }),
        },
      }),
    });
    const detail = await page().findByTestId("audit-entry", {}, LOADED);
    expect(detail.textContent).toContain("Entry 12: policy.publish");
    expect(page().getByTestId("audit-entry-facts").textContent).toContain(
      "h11",
    );
    expect(page().getByTestId("audit-entry-diff").textContent).toContain(
      "limits[id=x].limit",
    );
    expect(page().getByTestId("audit-entry-before-after")).toBeTruthy();
  });

  it("exports through a step-up, retried once; the file is saved", async () => {
    let exports = 0;
    let stepped = false;
    const original = Object.getOwnPropertyDescriptor(window, "open");
    window.open = (() => ({ closed: false })) as unknown as typeof window.open;
    const saved: Blob[] = [];
    const created = spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      saved.push(blob as Blob);
      return "blob:audit";
    });
    const revoked = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    // A download's click would navigate happy-dom's window away.
    const clicked = spyOn(
      HTMLAnchorElement.prototype,
      "click",
    ).mockImplementation(() => {});
    try {
      renderApp({
        path: "/audit?since=1000",
        routes: auditRoutes([entry(1)], {
          "GET /audit/export": (call: MockCall) => {
            exports++;
            expect(call.query.get("since")).toBe("1000");
            return stepped
              ? new Response('{"n":1}\n{"n":2}\n', {
                  headers: { "content-type": "application/x-ndjson" },
                })
              : problem(401, "step_up_required", {
                  stepUpUrl: "/auth/step-up",
                });
          },
        }),
      });
      await page().findAllByTestId("audit-row", {}, LOADED);
      fireEvent.click(page().getByTestId("audit-export"));
      await waitFor(() => expect(exports).toBe(1));
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
        (await page().findByTestId("audit-export-outcome", {}, LOADED))
          .textContent,
      ).toContain("Exported 2 entries");
      expect(exports).toBe(2);
      expect(await saved[0]!.text()).toBe('{"n":1}\n{"n":2}\n');
    } finally {
      created.mockRestore();
      revoked.mockRestore();
      clicked.mockRestore();
      if (original === undefined) Reflect.deleteProperty(window, "open");
      else Object.defineProperty(window, "open", original);
    }
  });

  it("without audit:export, there is no export", async () => {
    renderApp({
      path: "/audit",
      routes: {
        ...defaultRoutes({
          permissions: { global: { "audit:read": true, "policy:read": true } },
        }),
        ...auditRoutes([entry(1)]),
      },
    });
    await page().findAllByTestId("audit-row", {}, LOADED);
    expectAbsent(page().queryByTestId("audit-export"), "the export button");
    // Nor the sections it may not read.
    expectAbsent(
      page().queryByRole("link", { name: "Agents" }),
      "the agents section",
    );
    expect(page().getByRole("link", { name: "Audit" })).toBeTruthy();
  });
});
