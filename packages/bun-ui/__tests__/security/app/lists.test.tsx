/**
 * The Lists screen (PR-U3, ui.md §4.1): the scope's entries from the
 * published head or the draft, filters and the CIDR search, paging in the
 * URL, removing into unsaved changes saved as the draft, account entries as
 * keys only, inherited and locked entries read-only, the CSV import and
 * export, a revision conflict, and what an operator without `policy:draft`
 * does not see. Over the real app and a stateful fake policy API.
 */
import type { MockHandler, MockReply } from "./mockApi";
import { describe, expect, it, spyOn } from "bun:test";
import { expectAbsent, expectNone } from "../../harness/assert";
import { fireEvent, LOADED, page, setupDom, waitFor, within } from "./dom";
import { draftPuts, keyOf, policyApi } from "./listsApi";
import { defaultRoutes, problem } from "./mockApi";
import { renderApp } from "./renderApp";

setupDom();

/** A user's key and an API key's key, as the API returns them. */
const USER_KEY = keyOf("alice");
const API_KEY = keyOf("key_1");

/** The head's entries: one of each kind. */
const HEAD = [
  { ip: "203.0.113.0/24", action: "block", reason: "scanner" },
  { ip: "198.51.100.7", action: "allow", override: true },
  { userHash: USER_KEY, action: "block" },
  { apiKeyHash: API_KEY, action: "challenge" },
  { country: "KP", action: "drop", locked: true },
  { asn: 64500, action: "block", expiresAt: "2001-01-01T00:00:00Z" },
  { ip: "2001:db8::/32", action: "block", expiresAt: "2999-01-01T00:00:00Z" },
];

/** The rows on screen. */
function rows(): HTMLElement[] {
  return page().queryAllByTestId("lists-row");
}

/** The subject value of each row on screen. */
function values(): string[] {
  return rows().map(
    (row) =>
      row.querySelector(".subject-value")?.textContent ??
      row.querySelector(".subject-kind")?.textContent ??
      "",
  );
}

/** Renders `/lists` at `query` over `routes`, and waits for the screen. */
async function openLists(
  query: string,
  routes: Record<string, MockHandler | MockReply>,
): Promise<ReturnType<typeof renderApp>> {
  const rendered = renderApp({ path: `/lists?${query}`, routes });
  await page().findByTestId("lists", {}, LOADED);
  return rendered;
}

/** The URL's search parameters now. */
function params(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

describe("listing", () => {
  it("shows the published head's entries when there is no draft, each subject as the API reports it", async () => {
    const { routes } = policyApi({ head: HEAD });
    const { api } = await openLists("scope=global", routes);
    expect(values()).toEqual([
      "203.0.113.0/24",
      "198.51.100.7",
      USER_KEY,
      API_KEY,
      "KP",
      "AS64500",
      "2001:db8::/32",
    ]);
    expect(page().getByTestId("lists-source").textContent).toContain(
      "Showing published version 3",
    );
    expectAbsent(page().queryByTestId("lists-draft-badge"), "the draft badge");
    // The head's content came from its version.
    expect(api.calls.map((call) => call.path)).toContain(
      "/policies/global/versions/pv_3",
    );
    const kinds = rows().map((row) =>
      row.querySelector(".subject")?.getAttribute("data-kind"),
    );
    expect(kinds).toEqual([
      "cidr",
      "ip",
      "user",
      "apiKey",
      "country",
      "asn",
      "cidr",
    ]);
  });

  it("shows the draft's entries, marked as a draft, with its diff against the head", async () => {
    const { routes } = policyApi({
      head: HEAD.slice(0, 2),
      draft: [HEAD[0], { ip: "192.0.2.1", action: "block" }],
    });
    await openLists("scope=global", routes);
    expect(values()).toEqual(["203.0.113.0/24", "192.0.2.1"]);
    expect(page().getByTestId("lists-draft-badge").textContent).toBe("Draft");
    expect(page().getByTestId("lists-diff").textContent).toBe(
      "Against the published version: 1 entry added, 1 removed, 0 changed.",
    );
  });

  it("an account entry is its key: an id never stored keyed is never shown", async () => {
    const { routes } = policyApi({
      head: [
        { userHash: USER_KEY, action: "block" },
        { user: "bob-raw-id", action: "block" },
      ],
    });
    await openLists("scope=global", routes);
    expect(rows().length).toBe(2);
    expect(page().getByTestId("lists").textContent).toContain(USER_KEY);
    // Negative control: the raw id is in the API's answer, not on screen.
    expect(page().getByTestId("lists").textContent).not.toContain("bob-raw-id");
    expect(rows()[1].textContent).toContain("User id");
  });

  it("nothing published and no draft: says so", async () => {
    const { routes } = policyApi({ head: null });
    await openLists("scope=global", routes);
    expect(page().getByTestId("lists-source").textContent).toBe(
      "Nothing published yet, and no draft.",
    );
    expect(page().getByText("No entries").textContent).toBe("No entries");
  });
});

describe("filters, search and paging", () => {
  it("filters by kind, action and expiry from the URL, and a filter sets the URL", async () => {
    const { routes } = policyApi({ head: HEAD });
    await openLists("scope=global&kind=ip", routes);
    expect(values()).toEqual([
      "203.0.113.0/24",
      "198.51.100.7",
      "2001:db8::/32",
    ]);
    fireEvent.change(page().getByTestId("lists-filter-action"), {
      target: { value: "allow" },
    });
    expect(params().get("action")).toBe("allow");
    expect(params().get("kind")).toBe("ip");
    await waitFor(() => expect(values()).toEqual(["198.51.100.7"]));
    fireEvent.change(page().getByTestId("lists-filter-action"), {
      target: { value: "" },
    });
    fireEvent.change(page().getByTestId("lists-filter-kind"), {
      target: { value: "" },
    });
    fireEvent.change(page().getByTestId("lists-filter-expiry"), {
      target: { value: "expired" },
    });
    await waitFor(() => expect(values()).toEqual(["AS64500"]));
    fireEvent.change(page().getByTestId("lists-filter-expiry"), {
      target: { value: "expiring" },
    });
    await waitFor(() => expect(values()).toEqual(["2001:db8::/32"]));
    fireEvent.change(page().getByTestId("lists-filter-expiry"), {
      target: { value: "permanent" },
    });
    await waitFor(() => expect(rows().length).toBe(5));
    fireEvent.change(page().getByTestId("lists-filter-kind"), {
      target: { value: "user" },
    });
    await waitFor(() => expect(values()).toEqual([USER_KEY]));
  });

  it("an address finds the ranges containing it, and only those", async () => {
    const { routes } = policyApi({
      head: [
        { ip: "203.0.113.0/24", action: "block" },
        { ip: "203.0.0.0/16", action: "block" },
        { ip: "203.0.113.8", action: "block" },
        { ip: "198.51.100.0/24", action: "block" },
        { ip: "2001:db8::/32", action: "block" },
        { country: "KP", action: "block" },
      ],
    });
    await openLists("scope=global&q=203.0.113.7", routes);
    expect(values()).toEqual(["203.0.113.0/24", "203.0.0.0/16"]);
    // Negative control: another address finds its own range.
    fireEvent.change(page().getByTestId("lists-search"), {
      target: { value: "198.51.100.200" },
    });
    await waitFor(() => expect(values()).toEqual(["198.51.100.0/24"]));
    expect(params().get("q")).toBe("198.51.100.200");
    fireEvent.change(page().getByTestId("lists-search"), {
      target: { value: "2001:db8:1::5" },
    });
    await waitFor(() => expect(values()).toEqual(["2001:db8::/32"]));
    // Text that is not an address searches the values.
    fireEvent.change(page().getByTestId("lists-search"), {
      target: { value: "kp" },
    });
    await waitFor(() => expect(values()).toEqual(["KP"]));
  });

  it("pages through the URL, keeping the page size there", async () => {
    const many = Array.from({ length: 25 }, (_, n) => ({
      ip: `192.0.2.${n + 1}`,
      action: "block",
    }));
    const { routes } = policyApi({ head: many });
    await openLists("scope=global&limit=10&page=2", routes);
    expect(values()[0]).toBe("192.0.2.11");
    expect(rows().length).toBe(10);
    fireEvent.click(page().getByRole("button", { name: "Next" }));
    await waitFor(() => expect(values()[0]).toBe("192.0.2.21"));
    expect(params().get("page")).toBe("3");
    expect(params().get("limit")).toBe("10");
    expect(rows().length).toBe(5);
    // A filter starts the list again.
    fireEvent.change(page().getByTestId("lists-search"), {
      target: { value: "192.0.2" },
    });
    await waitFor(() => expect(values()[0]).toBe("192.0.2.1"));
    expect(params().has("page")).toBe(false);
    expect(params().get("limit")).toBe("10");
  });
});

describe("changing the draft", () => {
  it("a removal is an unsaved change until saved; the draft PUT carries the rest of the policy, at no revision, with the CSRF header", async () => {
    const { routes } = policyApi({
      head: HEAD.slice(0, 3),
      rest: { mode: "enforce", limits: [{ id: "per-ip", limit: 300 }] },
    });
    const { api } = await openLists("scope=global", routes);
    fireEvent.click(within(rows()[1]).getByTestId("lists-remove"));
    expect(page().getByTestId("lists-unsaved").textContent).toBe(
      "Unsaved changes: 0 entries to add, 1 to remove.",
    );
    expect(rows()[1].getAttribute("data-state")).toBe("removing");
    expectNone(draftPuts(api.calls), "draft writes before Save");
    fireEvent.click(page().getByTestId("lists-save"));
    await page().findByTestId("lists-draft-badge", {}, LOADED);
    const [put] = draftPuts(api.calls);
    expect(put?.body).toEqual({
      policy: {
        mode: "enforce",
        limits: [{ id: "per-ip", limit: 300 }],
        lists: [HEAD[0], HEAD[2]],
      },
      revision: null,
    });
    expect(put?.headers.get("x-bun-security-csrf")).toBe("1");
    await waitFor(() => expect(values()).toEqual(["203.0.113.0/24", USER_KEY]));
    expect(page().getByTestId("lists-diff").textContent).toBe(
      "Against the published version: 0 entries added, 1 removed, 0 changed.",
    );
  });

  it("Undo and Discard changes write nothing", async () => {
    const { routes } = policyApi({ head: HEAD.slice(0, 2) });
    const { api } = await openLists("scope=global", routes);
    fireEvent.click(within(rows()[0]).getByTestId("lists-remove"));
    fireEvent.click(within(rows()[0]).getByRole("button", { name: "Undo" }));
    expectAbsent(page().queryByTestId("lists-unsaved"), "the unsaved bar");
    fireEvent.click(within(rows()[1]).getByTestId("lists-remove"));
    fireEvent.click(page().getByTestId("lists-discard-changes"));
    expectAbsent(page().queryByTestId("lists-unsaved"), "the unsaved bar");
    expectNone(draftPuts(api.calls), "draft writes");
  });

  it("a save the draft changed under is a 409: shown with a reload, which drops the unsaved changes", async () => {
    const { routes, state } = policyApi({
      head: HEAD.slice(0, 2),
      draft: HEAD.slice(0, 2),
    });
    await openLists("scope=global", routes);
    // Another operator saves first.
    state.draft = {
      policy: { mode: "enforce", lists: [HEAD[1]] },
      revision: 3,
      updatedBy: "other",
    };
    fireEvent.click(within(rows()[0]).getByTestId("lists-remove"));
    fireEvent.click(page().getByTestId("lists-save"));
    await page().findByTestId("lists-conflict", {}, LOADED);
    fireEvent.click(page().getByTestId("lists-reload"));
    await waitFor(() => expect(values()).toEqual(["198.51.100.7"]));
    expectAbsent(page().queryByTestId("lists-conflict"), "the conflict");
    expectAbsent(page().queryByTestId("lists-unsaved"), "the unsaved bar");
    expect(page().getByTestId("lists-source").textContent).toContain(
      "revision 3, by other",
    );
  });

  it("Discard draft deletes the draft at its revision, and the head shows again", async () => {
    const { routes, state } = policyApi({
      head: HEAD.slice(0, 1),
      draft: HEAD.slice(0, 2),
    });
    const { api } = await openLists("scope=global", routes);
    fireEvent.click(page().getByTestId("lists-discard-draft"));
    const dialog = await page().findByRole("alertdialog", {}, LOADED);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Discard draft" }),
    );
    await waitFor(() =>
      expect(
        api.calls.filter(
          (call) =>
            call.method === "DELETE" && call.path === "/policies/global/draft",
        ).length,
      ).toBe(1),
    );
    const deleted = api.calls.find((call) => call.method === "DELETE")!;
    expect(deleted.query.get("revision")).toBe("2");
    expect(deleted.headers.get("x-bun-security-csrf")).toBe("1");
    // Nothing was written over the draft: it was deleted.
    expectNone(draftPuts(api.calls), "draft writes");
    expect(state.draft).toBe(null);
    await waitFor(() =>
      expectAbsent(
        page().queryByTestId("lists-discard-draft"),
        "Discard draft",
      ),
    );
    expectAbsent(page().queryByTestId("lists-publish"), "Publish");
  });
});

describe("inherited and locked entries", () => {
  it("on a service, entries from the scopes above are read-only and say where they come from", async () => {
    const { routes } = policyApi({
      head: [{ ip: "192.0.2.50", action: "block" }],
      effective: {
        body: {
          service: "checkout",
          policyVersions: ["pv_g", "pv_3"],
          policy: {
            lists: [
              { country: "KP", action: "drop", locked: true, scope: "global" },
              { asn: 64501, action: "block", scope: "group" },
              { ip: "192.0.2.50", action: "block", scope: "service" },
            ],
          },
          origins: {
            "lists[id=country:KP]": "global",
            "lists[id=asn:64501]": "group:payments",
            "lists[id=ip:192.0.2.50]": "service:checkout",
          },
        },
      },
    });
    await openLists("scope=service:checkout", routes);
    await waitFor(() => expect(rows().length).toBe(3));
    const origins = rows().map((row) => [
      row.getAttribute("data-origin"),
      within(row).getByTestId("lists-row-origin").textContent,
    ]);
    expect(origins).toEqual([
      ["own", "This scope"],
      ["inherited", "Global (locked, read-only)"],
      ["inherited", "Group payments (read-only)"],
    ]);
    // Only the scope's own entry can be removed.
    expect(
      rows().map((row) => within(row).queryAllByTestId("lists-remove").length),
    ).toEqual([1, 0, 0]);
    fireEvent.change(page().getByTestId("lists-filter-origin"), {
      target: { value: "inherited" },
    });
    await waitFor(() => expect(values()).toEqual(["KP", "AS64501"]));
  });

  it("on a group, entries from global are read-only, read from the group's effective policy", async () => {
    const { routes } = policyApi({
      head: [{ ip: "192.0.2.60", action: "block" }],
      effective: {
        body: {
          group: "payments",
          policyVersions: ["pv_g", "pv_3"],
          policy: {
            lists: [
              { country: "KP", action: "drop", locked: true, scope: "global" },
              { ip: "192.0.2.60", action: "block", scope: "group" },
            ],
          },
          origins: {
            "lists[id=country:KP]": "global",
            "lists[id=ip:192.0.2.60]": "group:payments",
          },
        },
      },
    });
    const { api } = await openLists("scope=group:payments", routes);
    await waitFor(() => expect(rows().length).toBe(2));
    expect(
      api.calls.some((call) => call.path === "/groups/payments/effective"),
    ).toBe(true);
    expect(rows().map((row) => row.getAttribute("data-origin"))).toEqual([
      "own",
      "inherited",
    ]);
  });

  it("negative control: global has no scope above it, so no effective read and nothing inherited", async () => {
    const { routes } = policyApi({
      head: [{ ip: "192.0.2.61", action: "block" }],
    });
    const { api } = await openLists("scope=global", routes);
    await waitFor(() => expect(rows().length).toBe(1));
    expect(api.calls.some((call) => call.path.endsWith("/effective"))).toBe(
      false,
    );
  });

  it("a service whose effective policy cannot be read still shows its own entries", async () => {
    const { routes } = policyApi({
      head: [{ ip: "192.0.2.50", action: "block" }],
      effective: problem(422, "locked"),
    });
    await openLists("scope=service:checkout", routes);
    expect(values()).toEqual(["192.0.2.50"]);
    expect(page().getByRole("alert").textContent).toContain(
      "Could not read the inherited entries",
    );
  });
});

describe("CSV", () => {
  /** Opens the import dialog and checks `csv`. */
  async function importText(csv: string): Promise<HTMLElement> {
    fireEvent.click(page().getByTestId("lists-import"));
    const dialog = await page().findByRole("dialog", {}, LOADED);
    fireEvent.change(within(dialog).getByTestId("lists-import-text"), {
      target: { value: csv },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Check" }));
    return dialog;
  }

  it("a valid file joins the unsaved changes; saved, raw ids are echoed once with their keys", async () => {
    const { routes } = policyApi({ head: HEAD.slice(0, 1) });
    const { api } = await openLists("scope=global", routes);
    const dialog = await importText(
      [
        "kind,value,action,paths,reason",
        "ip,192.0.2.0/24,block,/login;/api,from feed",
        "user,carol,challenge,,",
      ].join("\n"),
    );
    expect(within(dialog).getByTestId("lists-import-ok").textContent).toBe(
      "2 entries are ready to add.",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Add 2 to the draft" }),
    );
    expect(page().getByTestId("lists-unsaved").textContent).toBe(
      "Unsaved changes: 2 entries to add, 0 to remove.",
    );
    // An unsaved raw id is not shown either.
    expect(page().getByTestId("lists").textContent).not.toContain("carol");
    fireEvent.click(page().getByTestId("lists-save"));
    const echo = await page().findByTestId("lists-entered", {}, LOADED);
    expect(within(echo).getByTestId("lists-entered-item").textContent).toBe(
      `User id carol → key ${keyOf("carol")}`,
    );
    expect(draftPuts(api.calls)[0].body).toEqual({
      policy: {
        mode: "enforce",
        lists: [
          HEAD[0],
          {
            ip: "192.0.2.0/24",
            action: "block",
            paths: ["/login", "/api"],
            reason: "from feed",
          },
          { user: "carol", action: "challenge" },
        ],
      },
      revision: null,
    });
  });

  it("an invalid file is refused whole, every problem by line, and nothing is written", async () => {
    const { routes } = policyApi({ head: HEAD.slice(0, 1) });
    const { api } = await openLists("scope=global", routes);
    const dialog = await importText(
      [
        "kind,value,action",
        "ip,192.0.2.0/24,block",
        "ip,not-an-address,block",
        "country,FR,allow",
        "ip,203.0.113.0/24,block",
      ].join("\n"),
    );
    const problems = within(dialog)
      .getAllByTestId("lists-import-problem")
      .map((item) => item.textContent);
    expect(problems).toEqual([
      "Line 3: value: Not an IP address or CIDR range",
      "Line 4: action: A whole country cannot be allowed (the policy refuses it): allow its addresses or ASNs instead",
      "Line 5: Already listed in this scope",
    ]);
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Add to the draft",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expectAbsent(page().queryByTestId("lists-unsaved"), "unsaved changes");
    expectNone(draftPuts(api.calls), "draft writes");
  });

  it("a file read from disk is checked the same way", async () => {
    const { routes } = policyApi({ head: [] });
    await openLists("scope=global", routes);
    fireEvent.click(page().getByTestId("lists-import"));
    const dialog = await page().findByRole("dialog", {}, LOADED);
    const input = within(dialog).getByTestId("lists-import-file");
    const file = new File(["kind,value,action\nasn,AS13335,block\n"], "a.csv", {
      type: "text/csv",
    });
    Object.defineProperty(input, "files", { value: [file] });
    fireEvent.change(input);
    expect(
      (await within(dialog).findByTestId("lists-import-ok", {}, LOADED))
        .textContent,
    ).toBe("1 entry is ready to add.");
  });

  it("exports the scope's own entries as shown, accounts as keys", async () => {
    const { routes } = policyApi({
      head: [
        HEAD[0],
        { userHash: USER_KEY, action: "block", reason: "=HYPERLINK(1)" },
        { user: "raw-id", action: "block" },
      ],
    });
    await openLists("scope=global", routes);
    const created: Blob[] = [];
    const spies = [
      spyOn(URL, "createObjectURL").mockImplementation((blob) => {
        created.push(blob as Blob);
        return "blob:lists";
      }),
      spyOn(URL, "revokeObjectURL").mockImplementation(() => {}),
      spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {}),
    ];
    try {
      fireEvent.click(page().getByTestId("lists-export"));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(created.length).toBe(1);
    expect(await created[0].text()).toBe(
      [
        "kind,value,action,override,locked,paths,expiresAt,reason,mode",
        "ip,203.0.113.0/24,block,,,,,scanner,",
        `userHash,${USER_KEY},block,,,,,'=HYPERLINK(1),`,
        "",
      ].join("\n"),
    );
    expect(
      (await page().findByText(/not exported/, {}, LOADED)).textContent,
    ).toBe("1 entry not exported: an account id not yet keyed");
  });
});

describe("permissions", () => {
  it("without policy:draft there is no add, remove or import; export stays", async () => {
    const { routes } = policyApi({ head: HEAD.slice(0, 2) });
    await openLists("scope=global", {
      ...routes,
      ...defaultRoutes({
        permissions: { global: { "policy:read": true } },
      }),
      "GET /policies/:scope": routes["GET /policies/:scope"],
    });
    expect(rows().length).toBe(2);
    expectAbsent(page().queryByTestId("lists-add"), "Add entry");
    expectAbsent(page().queryByTestId("lists-import"), "Import CSV");
    expectNone(page().queryAllByTestId("lists-remove"), "Remove buttons");
    expect(page().getByTestId("lists-export").textContent).toBe("Export CSV");
  });

  it("with policy:draft they are there (the control)", async () => {
    const { routes } = policyApi({
      head: HEAD.slice(0, 2),
      draft: HEAD.slice(0, 1),
    });
    await openLists("scope=global", {
      ...routes,
      ...defaultRoutes({
        permissions: { global: { "policy:read": true, "policy:draft": true } },
      }),
      "GET /policies/:scope": routes["GET /policies/:scope"],
    });
    expect(page().getByTestId("lists-add").getAttribute("href")).toBe(
      "/security/lists/new?scope=global",
    );
    expect(page().getByTestId("lists-import").textContent).toBe("Import CSV");
    expect(page().queryAllByTestId("lists-remove").length).toBe(1);
    expect(page().getByTestId("lists-discard-draft").textContent).toBe(
      "Discard draft",
    );
    // No policy:publish: no Publish on a draft that changes something.
    expectAbsent(page().queryByTestId("lists-publish"), "Publish");
  });
});
