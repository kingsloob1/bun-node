/**
 * The events list (`/events`, ui.md §7 and §5): its columns, the cursor
 * trail in the URL (back/forward land on the same page), the filters in the
 * URL and the API's query, the account-key filters only with `events:read`,
 * and a row opening the drawer with the list's query kept.
 */
import { describe, expect, it } from "bun:test";
import { expectAbsent, expectNone } from "../../harness/assert";
import { act, fireEvent, LOADED, page, setupDom, waitFor, within } from "./dom";
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

/** Three events over two pages. */
const EV1 = eventFixture();
const EV2 = eventFixture({
  id: "ev2",
  at: EV1.at - 60_000,
  action: "challenge",
  rule: "geo-ng",
  subjects: { ip: "198.51.100.2", apiKey: API_KEY_KEY },
  dryRun: true,
  country: "GH",
  asn: 64501,
  status: 429,
  latencyMs: 5,
});
const EV3 = eventFixture({ id: "ev3", at: EV1.at - 120_000, rule: "tor" });

/** The pages: `first` → `c1`. */
const PAGES = {
  first: { items: [EV1, EV2], next: "c1" },
  c1: { items: [EV3] },
};

/** The row of an event. */
function rowOf(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-testid="event-row"][data-event-id="${id}"]`,
  );
}

/** The ids of the rows on screen, in order. */
function rowIds(): string[] {
  return [
    ...document.querySelectorAll<HTMLElement>('[data-testid="event-row"]'),
  ].map((row) => row.dataset.eventId ?? "");
}

/** The URL's query now. */
function urlQuery(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

/** Moves through history and lets the router follow. */
async function go(step: "back" | "forward") {
  await act(async () => {
    if (step === "back") window.history.back();
    else window.history.forward();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

describe("the events list", () => {
  it("reads the newest first for the scope and shows each column", async () => {
    const { api } = renderApp({
      path: "/events?scope=global",
      routes: { "GET /analytics/events": pagedEvents(PAGES) },
    });
    await page().findByTestId("events", {}, LOADED);
    await waitFor(() => expect(rowIds()).toEqual(["ev1", "ev2"]), LOADED);
    const read = eventReads(api.calls)[0];
    expect(read.query.get("scope")).toBe("global");
    expect(read.query.get("direction")).toBe("desc");
    expect(read.query.get("limit")).toBe("50");
    expect(read.query.has("cursor")).toBe(false);
    const row = within(rowOf("ev2")!);
    const cells = [...rowOf("ev2")!.querySelectorAll("td")].map(
      (cell) => cell.textContent,
    );
    // time, service, route, action, rule, subjects, country/ASN, status, latency, dry run
    expect(cells[0]).toBe(new Date(EV2.at).toLocaleString());
    expect(cells.slice(1, 5)).toEqual([
      "checkout",
      "POST /login",
      "challenge",
      "geo-ng",
    ]);
    expect(cells.slice(6)).toEqual(["GH / AS64501", "429", "5 ms", "Yes"]);
    // Subjects through `Subject`: the address, and an account as its key.
    const subjects = [
      ...rowOf("ev2")!.querySelectorAll<HTMLElement>(".subject"),
    ].map((subject) => [
      subject.dataset.kind,
      subject.querySelector(".subject-value")?.textContent,
    ]);
    expect(subjects).toEqual([
      ["ip", "198.51.100.2"],
      ["apiKey", API_KEY_KEY],
    ]);
    expect(row.getByText("API key key")).toBeTruthy();
    expect(
      within(rowOf("ev1")!)
        .getAllByText(/./, { selector: ".subject-value" })
        .map((value) => value.textContent),
    ).toEqual(["203.0.113.7", USER_KEY]);
  });

  it("pages through the URL; back and forward land on the same page", async () => {
    const { api } = renderApp({
      path: "/events?scope=global",
      routes: { "GET /analytics/events": pagedEvents(PAGES) },
    });
    await waitFor(() => expect(rowIds()).toEqual(["ev1", "ev2"]), LOADED);
    fireEvent.click(page().getByRole("button", { name: "Next" }));
    await waitFor(() => expect(rowIds()).toEqual(["ev3"]), LOADED);
    expect(JSON.parse(urlQuery().get("page") ?? "null")).toEqual(["c1"]);
    expect(urlQuery().get("scope")).toBe("global");
    expect(eventReads(api.calls).at(-1)!.query.get("cursor")).toBe("c1");
    await go("back");
    await waitFor(() => expect(rowIds()).toEqual(["ev1", "ev2"]), LOADED);
    expect(urlQuery().has("page")).toBe(false);
    await go("forward");
    await waitFor(() => expect(rowIds()).toEqual(["ev3"]), LOADED);
    // A shared link lands on the same page.
    const shared = window.location.pathname + window.location.search;
    expect(shared).toContain("/security/events?");
    expect(trailOfUrl()).toEqual(["c1"]);
  });

  it("applies the filters into the URL and the API's query, back on the first page", async () => {
    const { api } = renderApp({
      path: `/events?scope=global&page=${encodeURIComponent(JSON.stringify(["c1"]))}`,
      routes: { "GET /analytics/events": pagedEvents(PAGES) },
    });
    await waitFor(() => expect(rowIds()).toEqual(["ev3"]), LOADED);
    const before = eventReads(api.calls).length;
    // Typing alone reads nothing: the filters apply together.
    fireEvent.change(page().getByLabelText("Rule"), {
      target: { value: " login-ladder " },
    });
    fireEvent.change(page().getByLabelText("Action"), {
      target: { value: "block" },
    });
    fireEvent.change(page().getByLabelText("Route"), {
      target: { value: "POST /login" },
    });
    fireEvent.change(page().getByLabelText("Address"), {
      target: { value: "203.0.113.7" },
    });
    fireEvent.change(page().getByLabelText("Country"), {
      target: { value: "ng" },
    });
    fireEvent.change(page().getByLabelText("ASN"), {
      target: { value: "64500" },
    });
    fireEvent.change(page().getByLabelText("Dry run"), {
      target: { value: "false" },
    });
    fireEvent.change(page().getByLabelText("From"), {
      target: { value: "2026-11-17T09:00" },
    });
    fireEvent.change(page().getByLabelText("To"), {
      target: { value: "2026-11-17T11:00" },
    });
    expect(eventReads(api.calls).length).toBe(before);
    fireEvent.click(page().getByRole("button", { name: "Apply" }));
    const from = String(new Date(2026, 10, 17, 9, 0).getTime());
    const to = String(new Date(2026, 10, 17, 11, 0).getTime());
    const expected = {
      action: "block",
      rule: "login-ladder",
      route: "POST /login",
      ip: "203.0.113.7",
      country: "NG",
      asn: "64500",
      dryRun: "false",
      from,
      to,
    };
    await waitFor(
      () => expect(eventReads(api.calls).length).toBeGreaterThan(before),
      LOADED,
    );
    const read = eventReads(api.calls).at(-1)!;
    for (const [name, value] of Object.entries(expected)) {
      expect([name, urlQuery().get(name)]).toEqual([name, value]);
      expect([name, read.query.get(name)]).toEqual([name, value]);
    }
    // Back on the first page: the trail is gone from the URL and the read.
    expect(urlQuery().has("page")).toBe(false);
    expect(read.query.has("cursor")).toBe(false);
    expect(urlQuery().get("scope")).toBe("global");
  });

  it("a link with filters reads them, and Clear drops them (the scope stays)", async () => {
    const { api } = renderApp({
      path: "/events?scope=global&action=ban&rule=tor&dryRun=true&asn=7",
      routes: { "GET /analytics/events": pagedEvents(PAGES) },
    });
    await waitFor(() => expect(rowIds().length).toBeGreaterThan(0), LOADED);
    const read = eventReads(api.calls)[0];
    expect(read.query.get("action")).toBe("ban");
    expect(read.query.get("rule")).toBe("tor");
    expect(read.query.get("dryRun")).toBe("true");
    expect(read.query.get("asn")).toBe("7");
    expect(page().getByLabelText<HTMLInputElement>("Rule").value).toBe("tor");
    expect(page().getByLabelText<HTMLSelectElement>("Action").value).toBe(
      "ban",
    );
    fireEvent.click(page().getByTestId("filters-clear"));
    await waitFor(
      () => expect(eventReads(api.calls).at(-1)!.query.has("rule")).toBe(false),
      LOADED,
    );
    expect(window.location.search).toBe("?scope=global");
    expect(page().getByLabelText<HTMLInputElement>("Rule").value).toBe("");
    // Nothing filtered: no Clear link.
    expectAbsent(page().queryByTestId("filters-clear"));
  });

  it("offers the account-key filters only with events:read", async () => {
    renderApp({
      path: "/events?scope=global",
      routes: {
        ...defaultRoutes({
          permissions: {
            global: { "policy:read": true, "analytics:read": true },
          },
        }),
        "GET /analytics/events": pagedEvents(PAGES),
      },
    });
    await page().findByTestId("events-filters", {}, LOADED);
    // The other filters are there (the form rendered)...
    expect(page().getByLabelText("Address")).toBeTruthy();
    // ...but no account filter.
    expectAbsent(page().queryByLabelText("User key"));
    expectAbsent(page().queryByLabelText("API key key"));
    expectAbsent(page().queryByLabelText("Username key"));
    expectNone(
      document.querySelectorAll(
        '[data-testid="filter-user"], [data-testid="filter-apiKey"], [data-testid="filter-username"]',
      ),
      "account-key filters",
    );
  });

  it("with events:read, an account key is a filter (the negative control)", async () => {
    const { api } = renderApp({
      path: "/events?scope=global",
      routes: {
        ...defaultRoutes({
          permissions: {
            global: {
              "policy:read": true,
              "analytics:read": true,
              "events:read": true,
            },
          },
        }),
        "GET /analytics/events": pagedEvents(PAGES),
      },
    });
    const user = await page().findByLabelText<HTMLInputElement>(
      "User key",
      {},
      LOADED,
    );
    expect(page().getByLabelText("API key key")).toBeTruthy();
    expect(page().getByLabelText("Username key")).toBeTruthy();
    fireEvent.change(user, { target: { value: USER_KEY } });
    fireEvent.change(page().getByLabelText("API key key"), {
      target: { value: API_KEY_KEY },
    });
    fireEvent.click(page().getByRole("button", { name: "Apply" }));
    await waitFor(
      () =>
        expect(eventReads(api.calls).at(-1)!.query.get("user")).toBe(USER_KEY),
      LOADED,
    );
    expect(eventReads(api.calls).at(-1)!.query.get("apiKey")).toBe(API_KEY_KEY);
    expect(urlQuery().get("user")).toBe(USER_KEY);
  });

  it("a row opens the drawer at /events/:id, keeping the list's query", async () => {
    const { api } = renderApp({
      path: "/events?scope=global&action=block",
      routes: {
        "GET /analytics/events": pagedEvents(PAGES),
        "GET /analytics/events/:id": { body: EV1 },
      },
    });
    await waitFor(() => expect(rowIds()).toEqual(["ev1", "ev2"]), LOADED);
    fireEvent.click(within(rowOf("ev1")!).getByTestId("event-open"));
    expect(window.location.pathname).toBe("/security/events/ev1");
    expect(window.location.search).toBe("?scope=global&action=block");
    const dialog = await page().findByRole("dialog", { name: "Event" }, LOADED);
    await within(dialog).findByTestId("event-detail", {}, LOADED);
    expect(
      api.calls.some((call) => call.path === "/analytics/events/ev1"),
    ).toBe(true);
    // The list is still behind it.
    expect(rowIds()).toEqual(["ev1", "ev2"]);
    fireEvent.click(within(dialog).getByTestId("event-close"));
    expect(window.location.pathname).toBe("/security/events");
    expect(window.location.search).toBe("?scope=global&action=block");
    await waitFor(
      () => expectAbsent(page().queryByRole("dialog"), "the drawer"),
      LOADED,
    );
  });
});

/** The cursor trail in the URL now. */
function trailOfUrl(): unknown {
  return JSON.parse(urlQuery().get("page") ?? "[]") as unknown;
}
