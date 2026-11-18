/**
 * The event detail drawer (`/events/:id`, the URL other screens link to):
 * a dialog over the list with the whole event and its redacted request; a
 * 403 says "No access", a 404 "Not found"; Escape and the close link go
 * back to the list with its query; the ban and list-entry links carry the
 * contract's pre-fill parameters, each only with its permission.
 */
import type { MockHandler, MockReply, PermissionTable } from "./mockApi";
import { describe, expect, it } from "bun:test";
import { expectAbsent, expectNone } from "../../harness/assert";
import { fireEvent, LOADED, page, setupDom, waitFor, within } from "./dom";
import {
  API_KEY_KEY,
  eventFixture,
  pagedEvents,
  USER_KEY,
} from "./eventsFixtures";
import { defaultRoutes, problem } from "./mockApi";
import { renderApp } from "./renderApp";

setupDom();

/** A blocked login, whole, with its redacted request. */
const EVENT = eventFixture({
  id: "ev-77",
  subjects: { ip: "203.0.113.7", user: USER_KEY, apiKey: API_KEY_KEY },
  rules: ["login-ladder", "geo-ng"],
  sample: {
    method: "POST",
    path: "/login",
    query: { next: "/home", token: "[redacted]" },
    headers: { "user-agent": "curl/8", authorization: "[redacted]" },
    body: {
      type: "application/json",
      length: 42,
      fields: { email: "[redacted]", remember: true },
    },
    answer: {
      status: 403,
      headers: { "content-type": "application/problem+json" },
      body: '{"title":"Forbidden"}',
    },
  },
});

/** The list behind the drawer. */
const LIST = pagedEvents({ first: { items: [EVENT] } });

/** Renders the drawer for `id`, with `detail` answering its read. */
function openDrawer(
  options: {
    id?: string;
    search?: string;
    detail?: MockHandler | MockReply;
    permissions?: PermissionTable;
  } = {},
) {
  return renderApp({
    path: `/events/${options.id ?? EVENT.id}${options.search ?? "?scope=global"}`,
    routes: {
      ...(options.permissions === undefined
        ? {}
        : defaultRoutes({ permissions: options.permissions })),
      "GET /analytics/events": LIST,
      "GET /analytics/events/:id": options.detail ?? { body: EVENT },
    },
  });
}

/** The drawer. */
async function drawer(): Promise<HTMLElement> {
  return await page().findByRole("dialog", { name: "Event" }, LOADED);
}

/** A link's app path and its parameters. */
function target(link: HTMLElement): {
  path: string;
  params: [string, string][];
} {
  const url = new URL(link.getAttribute("href")!, "http://localhost");
  return { path: url.pathname, params: [...url.searchParams.entries()] };
}

/** Every permission except those named, on the global scope. */
function allBut(...without: string[]): PermissionTable {
  const names = [
    "policy:read",
    "policy:draft",
    "bans:read",
    "bans:write",
    "analytics:read",
    "events:read",
  ];
  return {
    global: Object.fromEntries(
      names.map((name) => [name, !without.includes(name)]),
    ),
  };
}

describe("the event drawer", () => {
  it("loads directly at /events/:id: the whole event and its redacted request", async () => {
    const { api } = openDrawer();
    const dialog = await drawer();
    const detail = await within(dialog).findByTestId(
      "event-detail",
      {},
      LOADED,
    );
    expect(
      api.calls.some((call) => call.path === "/analytics/events/ev-77"),
    ).toBe(true);
    const text = detail.textContent ?? "";
    for (const part of [
      "checkout",
      "POST /login",
      "login-ladder, geo-ng",
      "AS64500",
      "403",
      "2 ms",
      "ev-77",
    ]) {
      expect([part, text.includes(part)]).toEqual([part, true]);
    }
    // Every subject through `Subject`, accounts as their keys.
    const values = [
      ...detail.querySelectorAll<HTMLElement>(".subject .subject-value"),
    ].map((value) => value.textContent);
    expect(values).toEqual(["203.0.113.7", USER_KEY, API_KEY_KEY]);
    // The redacted request: method and path, headers, query, body, answer.
    expect(
      within(detail).getByTestId("event-sample-request").textContent,
    ).toContain("POST /login");
    expect(
      within(detail).getByRole("list", { name: "Request headers" }).textContent,
    ).toContain("curl/8");
    expect(
      within(detail).getByRole("list", { name: "Request query" }).textContent,
    ).toContain("/home");
    const body = within(detail).getByTestId("event-sample-body");
    expect(body.textContent).toContain("application/json");
    expect(body.textContent).toContain("42 bytes");
    expect(
      within(body).getByRole("list", { name: "Request body" }).textContent,
    ).toContain("remember");
    const answer = within(detail).getByTestId("event-sample-answer");
    expect(
      within(answer).getByRole("list", { name: "Answer headers" }).textContent,
    ).toContain("application/problem+json");
    expect(within(answer).getByTestId("event-answer-body").textContent).toBe(
      '{"title":"Forbidden"}',
    );
    // The list is behind it.
    expect(page().getByTestId("events")).toBeTruthy();
  });

  it("an event without a sample says so", async () => {
    openDrawer({ detail: { body: { ...EVENT, sample: undefined } } });
    const dialog = await drawer();
    await within(dialog).findByTestId("event-no-sample", {}, LOADED);
    expectAbsent(within(dialog).queryByTestId("event-sample"));
  });

  it("a 403 shows No access in the drawer", async () => {
    openDrawer({ detail: problem(403, "forbidden") });
    const dialog = await drawer();
    const denied = await within(dialog).findByTestId(
      "event-no-access",
      {},
      LOADED,
    );
    expect(denied.textContent).toContain("No access");
    expect(denied.textContent).toContain("events:read");
    expectAbsent(within(dialog).queryByTestId("event-detail"));
    expectAbsent(within(dialog).queryByTestId("event-not-found"));
  });

  it("a 404 shows Not found in the drawer", async () => {
    openDrawer({ id: "gone", detail: problem(404, "not_found") });
    const dialog = await drawer();
    const missing = await within(dialog).findByTestId(
      "event-not-found",
      {},
      LOADED,
    );
    expect(missing.textContent).toContain("Not found");
    expectAbsent(within(dialog).queryByTestId("event-no-access"));
  });

  it("Escape goes back to the list with its query", async () => {
    openDrawer({ search: "?scope=global&rule=login-ladder" });
    const dialog = await drawer();
    await within(dialog).findByTestId("event-detail", {}, LOADED);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(window.location.pathname).toBe("/security/events");
    expect(window.location.search).toBe("?scope=global&rule=login-ladder");
    await waitFor(
      () => expectAbsent(page().queryByRole("dialog"), "the drawer"),
      LOADED,
    );
  });

  it("the close link goes back to the list with its query", async () => {
    openDrawer({ search: "?scope=global&action=block" });
    const dialog = await drawer();
    const close = within(dialog).getByRole("link", {
      name: "Back to the events",
    });
    expect(target(close)).toEqual({
      path: "/security/events",
      params: [
        ["scope", "global"],
        ["action", "block"],
      ],
    });
    fireEvent.click(close);
    expect(window.location.pathname).toBe("/security/events");
    await waitFor(
      () => expectAbsent(page().queryByRole("dialog"), "the drawer"),
      LOADED,
    );
  });

  it("links to the ban and list-entry forms with the contract's pre-fill", async () => {
    openDrawer({ search: "?scope=group:payments" });
    const dialog = await drawer();
    await within(dialog).findByTestId("event-detail", {}, LOADED);
    const scope: [string, string] = ["scope", "group:payments"];
    expect(
      target(within(dialog).getByRole("link", { name: "Ban this address" })),
    ).toEqual({
      path: "/security/bans/new",
      params: [scope, ["ip", "203.0.113.7"]],
    });
    expect(
      target(within(dialog).getByRole("link", { name: "Ban this user key" })),
    ).toEqual({
      path: "/security/bans/new",
      params: [scope, ["userHash", USER_KEY]],
    });
    expect(
      target(
        within(dialog).getByRole("link", { name: "Ban this API key key" }),
      ),
    ).toEqual({
      path: "/security/bans/new",
      params: [scope, ["apiKeyHash", API_KEY_KEY]],
    });
    expect(
      target(
        within(dialog).getByRole("link", { name: "Allow / deny in lists" }),
      ),
    ).toEqual({
      path: "/security/lists/new",
      params: [scope, ["ip", "203.0.113.7"]],
    });
  });

  it("without bans:write no ban link; without policy:draft no list link", async () => {
    openDrawer({ permissions: allBut("bans:write", "policy:draft") });
    const dialog = await drawer();
    await within(dialog).findByTestId("event-detail", {}, LOADED);
    expectNone(
      within(dialog).queryAllByRole("link", { name: /^Ban this/ }),
      "ban links",
    );
    expectAbsent(
      within(dialog).queryByRole("link", { name: "Allow / deny in lists" }),
    );
  });

  it("each link is there with its own permission alone (the negative control)", async () => {
    openDrawer({ permissions: allBut("policy:draft") });
    const dialog = await drawer();
    await within(dialog).findByTestId("event-detail", {}, LOADED);
    expect(
      within(dialog).queryAllByRole("link", { name: /^Ban this/ }).length,
    ).toBe(3);
    expectAbsent(
      within(dialog).queryByRole("link", { name: "Allow / deny in lists" }),
    );
  });

  it("with policy:draft but not bans:write: only the list link", async () => {
    openDrawer({ permissions: allBut("bans:write") });
    const dialog = await drawer();
    await within(dialog).findByTestId("event-detail", {}, LOADED);
    expectNone(
      within(dialog).queryAllByRole("link", { name: /^Ban this/ }),
      "ban links",
    );
    expect(
      within(dialog).getByRole("link", { name: "Allow / deny in lists" }),
    ).toBeTruthy();
  });
});
