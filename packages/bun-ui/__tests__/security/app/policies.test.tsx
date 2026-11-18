/**
 * The policy editor (PR-U4, ui.md §3), over the real app and a stateful
 * fake: a field set here, inherited (with its origin and **Override**), or
 * default; **Reset to inherited**; a keyed item a scope above locked, read
 * only and "locked by …"; **Turn off here**; a save's `422` on its field and
 * its `409`; the draft's changes; a tab as JSON; the crawler conflicts the
 * agents report (in the tab and the publish dialog) and the crawler
 * series; the rules' slot; and what an operator without `policy:draft`
 * does not see.
 */
import type { MockHandler, MockReply } from "./mockApi";
import { describe, expect, it } from "bun:test";
import { expectAbsent } from "../../harness/assert";
import { fireEvent, LOADED, page, setupDom, waitFor, within } from "./dom";
import { draftBodies, editorApi } from "./policiesApi";
import { defaultRoutes, problem, T0 } from "./mockApi";
import { renderApp } from "./renderApp";

setupDom();

/** The service's own published policy. */
const OWN = { mode: "dryRun", trustCheck: { minRequests: 50 } };

/** The service's effective policy: global's and the group's merged over its own. */
const EFFECTIVE = {
  service: "checkout",
  policyVersions: ["pv_1", "pv_2", "pv_3"],
  policy: {
    mode: "dryRun",
    trustCheck: { threshold: 0.7, minRequests: 50 },
    limits: [
      { id: "scanners", limit: 100, window: "1m", locked: true },
      { id: "per-route", limit: 50, window: "1m" },
    ],
    lists: [],
  },
  origins: {
    mode: "service:checkout",
    "trustCheck.threshold": "global",
    "trustCheck.minRequests": "service:checkout",
    "limits[id=scanners]": "group:payments",
    "limits[id=per-route]": "global",
  },
  locked: { "limits[id=scanners]": "group:payments" },
};

/** Opens the editor on `scope` (a tab, else General) over `routes`. */
async function openEditor(
  query: string,
  routes: Record<string, MockHandler | MockReply>,
) {
  const rendered = renderApp({ path: `/policies?${query}`, routes });
  await page().findByTestId("policy-editor", {}, LOADED);
  return rendered;
}

/** The service's editor over the fake, with `extra` routes. */
function serviceFake(extra: Record<string, MockHandler | MockReply> = {}) {
  const fake = editorApi({ rest: OWN, effective: { body: EFFECTIVE } });
  return { ...fake, routes: { ...fake.routes, ...extra } };
}

/** A field's row. */
function field(path: string): HTMLElement {
  return page().getByTestId(`field-${path}`);
}

describe("inheritance", () => {
  it("shows a field set here, one inherited with its origin, and one at its default", async () => {
    const { routes } = serviceFake();
    await openEditor("scope=service:checkout&tab=identity", routes);
    const threshold = field("trustCheck.threshold");
    expect(threshold.getAttribute("data-state")).toBe("inherited");
    expect(
      page().getByTestId("origin-trustCheck.threshold").textContent,
    ).toContain("Inherited from Global");
    expect(
      page().getByTestId<HTMLInputElement>("control-trustCheck.threshold")
        .disabled,
    ).toBe(true);
    expect(field("trustCheck.minRequests").getAttribute("data-state")).toBe(
      "own",
    );
    expect(field("trustCheck.window").getAttribute("data-state")).toBe(
      "default",
    );
  });

  it("Override copies the inherited value here; Reset to inherited drops it; the save carries exactly that", async () => {
    const { routes } = serviceFake();
    const { api } = await openEditor(
      "scope=service:checkout&tab=identity",
      routes,
    );
    fireEvent.click(page().getByTestId("override-trustCheck.threshold"));
    expect(field("trustCheck.threshold").getAttribute("data-state")).toBe(
      "own",
    );
    fireEvent.click(page().getByTestId("reset-trustCheck.minRequests"));
    expect(page().getByTestId("policy-unsaved").textContent).toBe(
      "Unsaved changes",
    );
    fireEvent.click(page().getByTestId("policy-save"));
    await waitFor(() => expect(draftBodies(api.calls)).toHaveLength(1));
    expect(draftBodies(api.calls)[0]).toEqual({
      mode: "dryRun",
      trustCheck: { threshold: 0.7 },
      lists: [],
    });
  });

  it("a keyed item a scope above locked is read only, 'locked by' it, with no override; an unlocked one turns off here", async () => {
    const { routes } = serviceFake();
    const { api } = await openEditor(
      "scope=service:checkout&tab=limits",
      routes,
    );
    const locked = page().getByTestId("item-row-scanners");
    expect(locked.getAttribute("data-state")).toBe("locked");
    expect(page().getByTestId("item-origin-scanners").textContent).toBe(
      "Locked by Group payments",
    );
    expectAbsent(
      page().queryByTestId("item-override-scanners"),
      "Override on a locked item",
    );
    expectAbsent(
      page().queryByTestId("item-off-scanners"),
      "Turn off on a locked item",
    );
    expect(page().getByTestId("item-origin-per-route").textContent).toBe(
      "Inherited from Global",
    );
    fireEvent.click(page().getByTestId("item-off-per-route"));
    expect(
      page().getByTestId("item-row-per-route").getAttribute("data-state"),
    ).toBe("override");
    fireEvent.click(page().getByTestId("policy-save"));
    await waitFor(() => expect(draftBodies(api.calls)).toHaveLength(1));
    expect((draftBodies(api.calls)[0] as { limits: unknown }).limits).toEqual([
      { id: "per-route", mode: "off" },
    ]);
  });

  it("negative control: a lock set on this scope itself does not lock it here", async () => {
    const fake = editorApi({
      rest: OWN,
      effective: {
        body: {
          ...EFFECTIVE,
          origins: { ...EFFECTIVE.origins, "limits[id=scanners]": "global" },
          locked: { "limits[id=scanners]": "service:checkout" },
        },
      },
    });
    await openEditor("scope=service:checkout&tab=limits", fake.routes);
    expect(
      page().getByTestId("item-row-scanners").getAttribute("data-state"),
    ).toBe("inherited");
    page().getByTestId("item-override-scanners");
  });

  it("without policy:draft: no Override, Reset, Turn off or Save, and the controls are read only", async () => {
    const permissions = defaultRoutes({
      permissions: {
        global: {
          "policy:read": true,
          "services:read": true,
          "groups:read": true,
        },
        "service:checkout": { "policy:read": true },
      },
    })["GET /meta/permissions"];
    await openEditor("scope=service:checkout&tab=identity", {
      ...serviceFake().routes,
      "GET /meta/permissions": permissions,
    });
    expectAbsent(
      page().queryByTestId("override-trustCheck.threshold"),
      "Override",
    );
    expectAbsent(page().queryByTestId("reset-trustCheck.minRequests"), "Reset");
    expect(
      page().getByTestId<HTMLInputElement>("control-trustCheck.minRequests")
        .disabled,
    ).toBe(true);
    fireEvent.click(page().getByRole("tab", { name: "Rate limits (L9)" }));
    await page().findByTestId("tab-limits", {}, LOADED);
    expectAbsent(page().queryByTestId("item-off-per-route"), "Turn off");
    expectAbsent(page().queryByTestId("policy-save"), "Save draft");
  });
});

describe("saving", () => {
  it("a 422's issues are shown on their fields and listed", async () => {
    const { routes } = serviceFake({
      "PUT /policies/:scope/draft": problem(422, "invalid_policy", {
        issues: [
          {
            path: ["trustCheck", "minRequests"],
            message: "must be a positive whole number",
          },
        ],
      }),
    });
    await openEditor("scope=service:checkout&tab=identity", routes);
    fireEvent.change(page().getByTestId("control-trustCheck.minRequests"), {
      target: { value: "0" },
    });
    fireEvent.click(page().getByTestId("policy-save"));
    await page().findByTestId("policy-issues", {}, LOADED);
    expect(field("trustCheck.minRequests").textContent).toContain(
      "must be a positive whole number",
    );
    // The unsaved changes stay.
    page().getByTestId("policy-unsaved");
  });

  it("a 409 is shown with a reload, which drops the unsaved changes", async () => {
    const { routes, state } = serviceFake();
    await openEditor("scope=service:checkout&tab=general", routes);
    state.draft = {
      policy: { mode: "off", lists: [] },
      revision: 5,
      updatedBy: "other",
    };
    fireEvent.change(page().getByTestId("control-environment"), {
      target: { value: "staging" },
    });
    fireEvent.click(page().getByTestId("policy-save"));
    await page().findByTestId("policy-conflict", {}, LOADED);
    fireEvent.click(
      within(page().getByTestId("policy-conflict")).getByRole("button", {
        name: "Reload",
      }),
    );
    await waitFor(() =>
      expect(page().getByTestId("policy-source").textContent).toContain(
        "revision 5",
      ),
    );
    expectAbsent(page().queryByTestId("policy-unsaved"), "the unsaved badge");
  });

  it("lists the draft's changes against the published version", async () => {
    const fake = editorApi({
      rest: OWN,
      draft: [],
      effective: { body: EFFECTIVE },
      diff: [{ path: "mode", before: "enforce", after: "dryRun" }],
    });
    await openEditor("scope=service:checkout", fake.routes);
    const changes = await page().findByTestId("draft-changes", {}, LOADED);
    expect(changes.textContent).toBe('mode: "enforce" → "dryRun"');
  });

  it("a tab as JSON edits its keys only, and the save carries them", async () => {
    const { routes } = serviceFake();
    const { api } = await openEditor(
      "scope=service:checkout&tab=shape",
      routes,
    );
    fireEvent.click(page().getByTestId("tab-json-toggle"));
    const editor = within(page().getByTestId("tab-json")).getByRole("textbox");
    fireEvent.change(editor, { target: { value: '{ "mode": "off" }' } });
    expect(page().getByTestId("tab-json-problem").textContent).toBe(
      "this tab edits shape; not mode",
    );
    fireEvent.change(editor, {
      target: { value: '{ "shape": { "maxHeaders": 64 } }' },
    });
    fireEvent.click(page().getByTestId("policy-save"));
    await waitFor(() => expect(draftBodies(api.calls)).toHaveLength(1));
    expect(draftBodies(api.calls)[0]).toEqual({
      ...OWN,
      lists: [],
      shape: { maxHeaders: 64 },
    });
  });
});

/** An agent of `service` reporting `conflicts`. */
function agentReporting(service: string, conflicts: unknown[]) {
  return {
    id: `a-${service}`,
    service,
    status: "ok",
    lastSeen: T0,
    revokedAt: null,
    reported: {
      agentVersion: "1",
      bundleVersion: 3,
      bundleKeyId: "sk",
      bundleExpired: false,
      banSeq: "0",
      banCount: 0,
      health: "ok",
      crawlers: { conflicts, total: conflicts.length },
    },
  };
}

describe("crawlers", () => {
  const conflict = {
    crawler: "google",
    entry: "country:US",
    range: "66.249.64.0/19",
  };

  it("lists the agents' conflicts with the post-publish note, in the tab and the publish dialog", async () => {
    const fake = editorApi({ rest: {}, draft: [] });
    await openEditor("scope=global&tab=crawlers", {
      ...fake.routes,
      "GET /agents": {
        body: { items: [agentReporting("checkout", [conflict])] },
      },
    });
    const listed = await page().findByTestId("crawler-conflicts", {}, LOADED);
    expect(
      within(listed).getByTestId("crawler-conflict").textContent,
    ).toContain(
      "google: list entry country:US covers its range 66.249.64.0/19",
    );
    expect(page().getByTestId("crawler-conflicts-note").textContent).toContain(
      "a draft's new conflicts appear only after it is published",
    );
    fireEvent.click(page().getByTestId("policy-publish"));
    const dialog = await page().findByRole("dialog", {}, LOADED);
    within(dialog).getByTestId("publish-conflicts");
  });

  it("negative control: with no conflict reported, the dialog has no conflict notice", async () => {
    const fake = editorApi({ rest: {}, draft: [] });
    await openEditor("scope=global&tab=crawlers", {
      ...fake.routes,
      "GET /agents": { body: { items: [agentReporting("checkout", [])] } },
    });
    await page().findByTestId("crawler-conflicts-none", {}, LOADED);
    fireEvent.click(page().getByTestId("policy-publish"));
    const dialog = await page().findByRole("dialog", {}, LOADED);
    expectAbsent(
      within(dialog).queryByTestId("publish-conflicts"),
      "the conflict notice",
    );
  });

  it("a service's tab counts only its own agents' conflicts", async () => {
    const { routes } = serviceFake({
      "GET /agents": {
        body: {
          items: [
            agentReporting("checkout", []),
            agentReporting("ledger", [conflict]),
          ],
        },
      },
    });
    await openEditor("scope=service:checkout&tab=crawlers", routes);
    await page().findByTestId("crawler-conflicts-none", {}, LOADED);
  });

  it("shows each verified crawler's requests, 404s, 429s and lifts, and the spoofed claimants", async () => {
    const fake = editorApi({ rest: {} });
    await openEditor("scope=global&tab=crawlers", {
      ...fake.routes,
      "GET /analytics/series": (call) => {
        const metric = call.query.get("metric");
        // The range is read in parts (closed hours, this hour): T0's is the one.
        const from = Number(call.query.get("from"));
        const to = Number(call.query.get("to"));
        if (T0 < from || T0 >= to)
          return {
            body: { tier: call.query.get("tier") ?? "hour", points: [] },
          };
        const point = (dims: Record<string, string>, value: number) => ({
          at: T0,
          dims,
          value,
        });
        return {
          body: {
            tier: call.query.get("tier") ?? "hour",
            points:
              metric === "crawlers"
                ? [
                    point({ crawler: "google", outcome: "request" }, 900),
                    point({ crawler: "google", outcome: "not-found" }, 12),
                    point({ crawler: "google", outcome: "limited" }, 3),
                    point({ crawler: "bing", outcome: "request" }, 40),
                    point({ crawler: "bing", outcome: "honeypot" }, 1),
                  ]
                : metric === "rules" &&
                    call.query.get("rule") === "crawler.spoofed"
                  ? [
                      point(
                        {
                          rule: "crawler.spoofed",
                          action: "block",
                          dryRun: "false",
                        },
                        7,
                      ),
                    ]
                  : [],
          },
        };
      },
    });
    const google = await page().findByTestId(
      "crawler-series-google",
      {},
      LOADED,
    );
    expect(
      [...google.querySelectorAll("td")].map((cell) => cell.textContent),
    ).toEqual(["900", "12", "3", "0", "0"]);
    expect(
      [...page().getByTestId("crawler-series-bing").querySelectorAll("td")].map(
        (cell) => cell.textContent,
      ),
    ).toEqual(["40", "0", "0", "0", "1"]);
    expect(page().getByTestId("crawler-spoofed").textContent).toContain(": 7");
  });

  it("the allowance's switches show the default set when none is chosen; ticking one writes that set and it", async () => {
    const fake = editorApi({ rest: {} });
    const { api } = await openEditor("scope=global&tab=crawlers", fake.routes);
    const allow = await page().findByTestId(
      "control-crawlers.allow",
      {},
      LOADED,
    );
    const checked = () =>
      within(allow)
        .getAllByRole("checkbox")
        .filter((box) => (box as HTMLInputElement).checked)
        .map((box) => (box as HTMLInputElement).labels?.[0]?.textContent);
    expect(checked()).toEqual(["google", "bing", "apple", "duckduckgo"]);
    fireEvent.click(within(allow).getByLabelText("yandex"));
    fireEvent.click(page().getByTestId("policy-save"));
    await waitFor(() => expect(draftBodies(api.calls)).toHaveLength(1));
    expect(draftBodies(api.calls)[0]).toEqual({
      lists: [],
      // The default set as shown, and the crawler ticked.
      crawlers: { allow: ["google", "bing", "apple", "duckduckgo", "yandex"] },
    });
  });
});

describe("the rules' slot", () => {
  it("lists the rules with their origins and links to testing a request (rules:test)", async () => {
    const fake = editorApi({
      rest: {
        requestRules: {
          rules: [
            {
              id: "no-admin",
              when: { path: { prefix: "/admin" } },
              action: "block",
            },
          ],
        },
      },
    });
    await openEditor("scope=global&tab=rules", fake.routes);
    expect(page().getByTestId("request-rule").textContent).toContain(
      "no-admin",
    );
    expect(
      page().getByTestId("test-request-link").getAttribute("href"),
    ).toContain("/rules/test?scope=global");
  });

  it("edits a rule in PR-U5's editor, saved with the rest of the draft", async () => {
    const fake = editorApi({
      rest: {
        requestRules: {
          rules: [
            {
              id: "no-admin",
              when: { path: { prefix: "/admin" } },
              action: "block",
            },
          ],
        },
      },
    });
    const { api } = await openEditor("scope=global&tab=rules", fake.routes);
    fireEvent.click(page().getByTestId("request-rule-edit-no-admin"));
    fireEvent.change(page().getByTestId("rule-mode"), {
      target: { value: "dryRun" },
    });
    fireEvent.click(page().getByTestId("request-rule-apply"));
    expect(page().getByTestId("policy-unsaved").textContent).toBe(
      "Unsaved changes",
    );
    fireEvent.click(page().getByTestId("policy-save"));
    await waitFor(() => expect(draftBodies(api.calls)).toHaveLength(1));
    expect(
      (draftBodies(api.calls)[0] as { requestRules: unknown }).requestRules,
    ).toEqual({
      rules: [
        {
          id: "no-admin",
          when: { path: { prefix: "/admin" } },
          action: "block",
          mode: "dryRun",
        },
      ],
    });
  });
});
