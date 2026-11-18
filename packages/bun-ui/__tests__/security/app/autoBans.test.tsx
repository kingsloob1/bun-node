/**
 * The automatic bans (`/bans/auto`): the engines' bans as their events
 * report them (`action: "ban"`), filtered by rule and time, grouped by rule
 * (a count per rule on the page, most first), a page at a time; each row's
 * "Make a fleet ban" pre-fills the ban form (only with `bans:write`); the
 * screen needs `analytics:read`.
 */
import type { PermissionTable } from "./mockApi";
import { describe, expect, it } from "bun:test";
import { expectAbsent, expectNone } from "../../harness/assert";
import { fireEvent, LOADED, page, setupDom, waitFor, within } from "./dom";
import {
  API_KEY_KEY,
  eventFixture,
  eventReads,
  pagedEvents,
  USER_KEY,
} from "./eventsFixtures";
import { defaultRoutes } from "./mockApi";
import { renderApp } from "./renderApp";

setupDom();

/** Ban events: two by `login-ladder`, one by `scanner`, one by an API-key rule. */
const BANS = [
  eventFixture({
    id: "b1",
    action: "ban",
    rule: "scanner",
    subjects: { ip: "198.51.100.9" },
  }),
  eventFixture({
    id: "b2",
    action: "ban",
    rule: "login-ladder",
    subjects: { ip: "203.0.113.7" },
  }),
  eventFixture({
    id: "b3",
    action: "ban",
    rule: "login-ladder",
    subjects: { ip: "203.0.113.8", user: USER_KEY },
  }),
  eventFixture({
    id: "b4",
    action: "ban",
    rule: "key-abuse",
    subjects: { apiKey: API_KEY_KEY },
  }),
];

/** The ban events over two pages. */
const PAGES = {
  first: { items: BANS, next: "c1" },
  c1: { items: [eventFixture({ id: "b5", action: "ban", rule: "tor" })] },
};

/** The rule groups on screen: `[rule, count]`, in order. */
function groups(): [string, string][] {
  return [
    ...document.querySelectorAll<HTMLElement>('[data-testid="auto-bans-rule"]'),
  ].map((item) => [
    item.dataset.rule ?? "",
    item.querySelector('[data-testid="auto-bans-rule-count"]')?.textContent ??
      "",
  ]);
}

/** The row of an event. */
function rowOf(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(
    `[data-testid="event-row"][data-event-id="${id}"]`,
  )!;
}

/** A link's app path and its parameters. */
function target(link: HTMLElement): {
  path: string;
  params: [string, string][];
} {
  const url = new URL(link.getAttribute("href")!, "http://localhost");
  return { path: url.pathname, params: [...url.searchParams.entries()] };
}

/** The permissions on `global`: these set, the rest off. */
function only(...names: string[]): PermissionTable {
  return { global: Object.fromEntries(names.map((name) => [name, true])) };
}

describe("the automatic bans", () => {
  it("reads the ban events and groups them by rule, most first", async () => {
    const { api } = renderApp({
      path: "/bans/auto?scope=global",
      routes: { "GET /analytics/events": pagedEvents(PAGES) },
    });
    await page().findByTestId("auto-bans-rules", {}, LOADED);
    const read = eventReads(api.calls)[0];
    expect(read.query.get("action")).toBe("ban");
    expect(read.query.get("scope")).toBe("global");
    expect(read.query.get("direction")).toBe("desc");
    expect(groups()).toEqual([
      ["login-ladder", "2"],
      ["key-abuse", "1"],
      ["scanner", "1"],
    ]);
    // And the list of the ban events itself.
    expect(
      [
        ...document.querySelectorAll<HTMLElement>('[data-testid="event-row"]'),
      ].map((row) => row.dataset.eventId),
    ).toEqual(["b1", "b2", "b3", "b4"]);
  });

  it("filters by rule (from a group, or the form) and time, into the URL, and pages", async () => {
    const { api } = renderApp({
      path: "/bans/auto?scope=global",
      routes: { "GET /analytics/events": pagedEvents(PAGES) },
    });
    await page().findByTestId("auto-bans-rules", {}, LOADED);
    // The form offers only the rule and the time range.
    expectAbsent(page().queryByLabelText("Action"));
    expectAbsent(page().queryByLabelText("Address"));
    fireEvent.click(
      within(page().getByTestId("auto-bans-rules")).getByRole("link", {
        name: "login-ladder",
      }),
    );
    await waitFor(
      () =>
        expect(eventReads(api.calls).at(-1)!.query.get("rule")).toBe(
          "login-ladder",
        ),
      LOADED,
    );
    expect(new URLSearchParams(window.location.search).get("rule")).toBe(
      "login-ladder",
    );
    expect(eventReads(api.calls).at(-1)!.query.get("action")).toBe("ban");
    fireEvent.change(page().getByLabelText("From"), {
      target: { value: "2026-11-17T09:00" },
    });
    fireEvent.click(page().getByRole("button", { name: "Apply" }));
    const from = String(new Date(2026, 10, 17, 9, 0).getTime());
    await waitFor(
      () => expect(eventReads(api.calls).at(-1)!.query.get("from")).toBe(from),
      LOADED,
    );
    expect(eventReads(api.calls).at(-1)!.query.get("rule")).toBe(
      "login-ladder",
    );
    // An action in the URL is never this screen's: it reads bans only.
    expect(new URLSearchParams(window.location.search).has("action")).toBe(
      false,
    );
    fireEvent.click(page().getByRole("button", { name: "Next" }));
    await waitFor(
      () =>
        expect(eventReads(api.calls).at(-1)!.query.get("cursor")).toBe("c1"),
      LOADED,
    );
  });

  it("each row's Make a fleet ban pre-fills the ban form with its subject", async () => {
    renderApp({
      path: "/bans/auto?scope=service:checkout",
      routes: { "GET /analytics/events": pagedEvents(PAGES) },
    });
    await page().findByTestId("auto-bans-rules", {}, LOADED);
    const scope: [string, string] = ["scope", "service:checkout"];
    // An address alone.
    const address = within(rowOf("b1")).getByRole("link", {
      name: "Make a fleet ban",
    });
    expect(target(address)).toEqual({
      path: "/security/bans/new",
      params: [scope, ["ip", "198.51.100.9"]],
    });
    // An account alone: its key as userHash / apiKeyHash.
    expect(
      target(
        within(rowOf("b4")).getByRole("link", { name: "Make a fleet ban" }),
      ),
    ).toEqual({
      path: "/security/bans/new",
      params: [scope, ["apiKeyHash", API_KEY_KEY]],
    });
    // Both: one link each, named by the subject.
    expect(
      target(
        within(rowOf("b3")).getByRole("link", {
          name: "Make a fleet ban (address)",
        }),
      ),
    ).toEqual({
      path: "/security/bans/new",
      params: [scope, ["ip", "203.0.113.8"]],
    });
    expect(
      target(
        within(rowOf("b3")).getByRole("link", {
          name: "Make a fleet ban (user key)",
        }),
      ),
    ).toEqual({
      path: "/security/bans/new",
      params: [scope, ["userHash", USER_KEY]],
    });
  });

  it("without bans:write there is no fleet-ban link", async () => {
    renderApp({
      path: "/bans/auto?scope=global",
      routes: {
        ...defaultRoutes({
          permissions: only("bans:read", "analytics:read", "policy:read"),
        }),
        "GET /analytics/events": pagedEvents(PAGES),
      },
    });
    await page().findByTestId("auto-bans-rules", {}, LOADED);
    // The rows are there...
    expect(rowOf("b1")).toBeTruthy();
    // ...without the link or its column.
    expectNone(
      page().queryAllByRole("link", { name: /^Make a fleet ban/ }),
      "fleet-ban links",
    );
    expectAbsent(page().queryByRole("columnheader", { name: "Fleet ban" }));
  });

  it("with bans:write the link is there (the negative control)", async () => {
    renderApp({
      path: "/bans/auto?scope=global",
      routes: {
        ...defaultRoutes({
          permissions: only(
            "bans:read",
            "bans:write",
            "analytics:read",
            "policy:read",
          ),
        }),
        "GET /analytics/events": pagedEvents(PAGES),
      },
    });
    await page().findByTestId("auto-bans-rules", {}, LOADED);
    expect(
      page().queryAllByRole("link", { name: /^Make a fleet ban/ }).length,
    ).toBe(5);
  });

  it("without analytics:read it shows No access and reads no event", async () => {
    const { api } = renderApp({
      path: "/bans/auto?scope=global",
      routes: {
        ...defaultRoutes({ permissions: only("bans:read", "policy:read") }),
        "GET /analytics/events": pagedEvents(PAGES),
      },
    });
    const denied = await page().findByTestId("no-access", {}, LOADED);
    expect(denied.textContent).toContain("Automatic bans");
    expect(denied.textContent).toContain("analytics:read");
    expectAbsent(page().queryByTestId("auto-bans"));
    expectNone(eventReads(api.calls), "event reads");
  });

  it("with analytics:read the same operator sees the list (the negative control)", async () => {
    renderApp({
      path: "/bans/auto?scope=global",
      routes: {
        ...defaultRoutes({
          permissions: only("bans:read", "policy:read", "analytics:read"),
        }),
        "GET /analytics/events": pagedEvents(PAGES),
      },
    });
    await page().findByTestId("auto-bans", {}, LOADED);
    expectAbsent(page().queryByTestId("no-access"));
  });
});
