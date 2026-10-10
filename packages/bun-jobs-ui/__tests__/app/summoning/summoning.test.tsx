import type {
  SummonListDto,
  SummonListItemDto,
  SummonOutcomeKind,
} from "../../../app/api/types";
import type { MockHandler, MockReply } from "../mockFetch";
import { describe, expect, it } from "bun:test";
import { summonInert } from "../../../app/screens/queues/panels/summonText";
import { summonTabPath } from "../../../app/screens/summoning/paths";
import { expectAbsent } from "../assert";
import { fireEvent, page, setupDom, visit, waitFor, within } from "../dom";
import { metaFixture, permissionsFixture, problem } from "../fixtures";
import { renderApp } from "../renderApp";

setupDom();

/**
 * The Summoning screen (`/summon`): every summon controller in the API's
 * process (`GET /summon`), one row each — the queue linked to its Summon tab,
 * the summoner's kind and readiness, the last outcome and when, and the
 * budget left with when each window resets.
 *
 * The rules it keeps: the screen and its nav entry need the list served
 * (`features.summonList`) and `queues.list` (the route's action; the API
 * filters each row by `queues.read` on its queue);
 * an empty list is an explained empty state, not an error; a failed read is
 * an error view.
 */

const NOW = Date.now();

/** One controller as `GET /summon` lists it: ready, budget on, last attempt started. */
function controller(
  overrides: Partial<SummonListItemDto> = {},
): SummonListItemDto {
  return {
    namespace: "shop",
    queue: "emails",
    local: true,
    kind: "ecs",
    readiness: "ready",
    inert: false,
    last: { id: "s-1", outcome: "started", at: NOW - 60_000 },
    budget: {
      hour: 2,
      perHour: 30,
      day: 10,
      perDay: 300,
      hourResetsAt: NOW + 23 * 60_000,
      dayResetsAt: NOW + 9 * 3_600_000,
    },
    ...overrides,
  };
}

/** `GET /summon` answering these controllers. */
function list(controllers: SummonListItemDto[]): MockReply {
  const body: SummonListDto = { controllers };
  return { body };
}

/** Meta with `summonList` set to `value`. */
function served(value: boolean) {
  return {
    body: metaFixture({
      features: { ...metaFixture().features, summonList: value },
    }),
  };
}

/** The sidebar link names. */
function sidebarLinks(): string[] {
  const nav = page().getByRole("navigation", { name: "Sections" });
  return [...nav.querySelectorAll("a")].map((a) => a.textContent ?? "");
}

/** Opens `/summon` with these handlers, and resolves the screen. */
async function openScreen(
  handlers: Record<string, MockHandler | MockReply> = {},
) {
  visit("/jobs/summon");
  const rendered = renderApp({
    handlers: { "GET /summon": list([controller()]), ...handlers },
  });
  const screen = await page().findByTestId(
    "summoning-screen",
    {},
    { timeout: 5_000 },
  );
  return { ...rendered, screen };
}

describe("the Summoning nav entry and route", () => {
  it("is offered after Workers where the list is served, and routes to the screen", async () => {
    const { screen } = await openScreen();
    const links = sidebarLinks();
    expect(links.indexOf("Summoning")).toBe(links.indexOf("Workers") + 1);
    const link = within(
      page().getByRole("navigation", { name: "Sections" }),
    ).getByRole("link", { name: "Summoning" });
    expect(link.getAttribute("href")).toBe("/jobs/summon");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(within(screen).getByRole("heading", { level: 1 }).textContent).toBe(
      "Summoning",
    );
  });

  it("is absent, and /summon is not found, where the list is not served", async () => {
    visit("/jobs/summon");
    const { calls } = renderApp({
      handlers: {
        "GET /meta": served(false),
        "GET /summon": list([controller()]),
      },
    });
    await page().findByTestId("not-found");
    expect(sidebarLinks()).not.toContain("Summoning");
    expect(calls.some((call) => call.path === "/summon")).toBe(false);
  });

  it("is absent, and nothing is read, without queues.list", async () => {
    visit("/jobs/summon");
    const { calls } = renderApp({
      handlers: {
        "GET /meta/permissions": {
          body: permissionsFixture({ "queues.list": false }),
        },
        "GET /summon": list([controller()]),
      },
    });
    await page().findByTestId("not-found");
    expect(sidebarLinks()).not.toContain("Summoning");
    expect(sidebarLinks()).toContain("Workers");
    expect(calls.some((call) => call.path === "/summon")).toBe(false);
  });
});

describe("the Summoning screen", () => {
  it("shows a row per controller: queue, summoner, readiness, last outcome and budget left", async () => {
    const { screen } = await openScreen({
      "GET /summon": list([
        controller(),
        controller({
          queue: "a/b",
          kind: "k8s",
          readiness: "pending",
          last: undefined,
          budget: {
            hour: 4,
            day: 9,
            off: true,
            hourResetsAt: NOW + 23 * 60_000,
            dayResetsAt: NOW + 9 * 3_600_000,
          },
        }),
      ]),
    });
    const emails = await within(screen).findByTestId("summoning-row-emails");
    expect(within(emails).getByRole("rowheader").textContent).toBe("emails");
    expect(emails.textContent).toContain("ecs");
    const readiness = within(emails).getByTestId("summoning-readiness");
    expect(readiness.textContent).toBe("Ready");
    expect(readiness.className).toContain("badge-success");
    const last = within(emails).getByTestId("summoning-last");
    expect(last.textContent).toMatch(/^Started 1m ago$/);
    expect(
      within(emails).getByTestId("summoning-budget-emails-hour").textContent,
    ).toMatch(
      /^28 of 30 left this hour, resets at (\d\d:\d\d|midnight) UTC \(in 23m\)$/,
    );
    expect(
      within(emails).getByTestId("summoning-budget-emails-day").textContent,
    ).toMatch(/^290 of 300 left today, resets at .+ UTC \(in 9h\)$/);
    expect(
      within(emails)
        .getByTestId("summoning-budget-emails-hour")
        .querySelector("meter")
        ?.getAttribute("value"),
    ).toBe("28");

    const other = within(screen).getByTestId("summoning-row-a/b");
    expect(within(other).getByTestId("summoning-readiness").textContent).toBe(
      "Pending",
    );
    expect(within(other).getByTestId("summoning-last").textContent).toBe(
      "None yet",
    );
    expect(within(other).getByTestId("summoning-budget-a/b").textContent).toBe(
      "Off: 4 this hour, 9 today (UTC), no limit",
    );
  });

  it("links each queue to its Summon tab, and the link lands there", async () => {
    const { screen } = await openScreen({
      "GET /summon": list([controller({ queue: "a/b" })]),
    });
    const row = await within(screen).findByTestId("summoning-row-a/b");
    const link = within(row).getByRole("link", { name: "a/b" });
    expect(summonTabPath("a/b")).toBe("/queues/a%2Fb?panel=summon");
    expect(link.getAttribute("href")).toBe("/jobs/queues/a%2Fb?panel=summon");
    fireEvent.click(link);
    await waitFor(() =>
      expect(window.location.pathname).toBe("/jobs/queues/a%2Fb"),
    );
    expect(new URLSearchParams(window.location.search).get("panel")).toBe(
      "summon",
    );
  });

  it("marks an inert controller, with why in its title, and only that one", async () => {
    const { screen } = await openScreen({
      "GET /summon": list([
        controller(),
        controller({
          queue: "reports",
          inert: true,
          inertReason: "summoned-process",
        }),
      ]),
    });
    const inert = await within(screen).findByTestId("summoning-row-reports");
    const badge = within(inert).getByTestId("summoning-inert");
    expect(badge.textContent).toBe("Inert");
    expect(badge.title).toBe(summonInert("summoned-process"));
    // Still ready: an inert controller's provider can be.
    expect(within(inert).getByTestId("summoning-readiness").textContent).toBe(
      "Ready",
    );
    const working = within(screen).getByTestId("summoning-row-emails");
    expectAbsent(within(working).queryByTestId("summoning-inert"));
  });

  it("shows Elsewhere, not a readiness, for a queue whose controller runs in another process", async () => {
    const { screen } = await openScreen({
      "GET /summon": list([
        controller(),
        controller({
          queue: "reports",
          local: false,
          readiness: undefined,
          inert: undefined,
        }),
      ]),
    });
    const remote = await within(screen).findByTestId("summoning-row-reports");
    const elsewhere = within(remote).getByText("Elsewhere");
    expect(elsewhere.title).toBe("Its controller runs in another process");
    expectAbsent(within(remote).queryByTestId("summoning-readiness"));
    expectAbsent(within(remote).queryByTestId("summoning-inert"));
    // A local row in the same list keeps its badge.
    const local = within(screen).getByTestId("summoning-row-emails");
    expect(within(local).getByTestId("summoning-readiness").textContent).toBe(
      "Ready",
    );
    expectAbsent(within(local).queryByText("Elsewhere"));
  });

  it("reads an exhausted window in the warning tone, and an unknown outcome as its raw string", async () => {
    const { screen } = await openScreen({
      "GET /summon": list([
        controller({
          last: {
            id: "s-2",
            outcome: "hibernated" as SummonOutcomeKind,
            at: NOW,
            detail: "no capacity",
          },
          budget: { ...controller().budget!, day: 300 },
        }),
      ]),
    });
    const row = await within(screen).findByTestId("summoning-row-emails");
    const day = within(row).getByTestId("summoning-budget-emails-day");
    expect(day.dataset.exhausted).toBe("true");
    expect(within(day).getByText("Exhausted").className).toContain(
      "badge-warning",
    );
    expect(
      within(row).getByTestId("summoning-budget-emails-hour").dataset.exhausted,
    ).toBe("false");
    const last = within(row).getByTestId("summoning-last").textContent;
    expect(last).toContain("hibernated");
    expect(last).toContain("no capacity");
  });

  it("explains an empty list: controllers run in the API's process, and none runs here", async () => {
    const { screen } = await openScreen({ "GET /summon": list([]) });
    const empty = await within(screen).findByText("No summon controllers here");
    expect(empty.closest(".empty-state")?.textContent).toContain(
      "Summon controllers run in the API's own process",
    );
    expect(screen.textContent).toContain("None runs in this one");
    expectAbsent(within(screen).queryByRole("table"));
  });

  it("shows an error view with Retry when the read fails, and recovers on Retry", async () => {
    let fail = true;
    const { screen } = await openScreen({
      "GET /summon": () =>
        fail
          ? {
              status: 500,
              body: problem(500, "INTERNAL", "The store is down"),
            }
          : list([controller()]),
    });
    await within(screen).findByText("Could not load the summon controllers");
    expectAbsent(within(screen).queryByRole("table"));
    fail = false;
    fireEvent.click(within(screen).getByRole("button", { name: /Retry/ }));
    await within(screen).findByTestId("summoning-row-emails");
  });
});
