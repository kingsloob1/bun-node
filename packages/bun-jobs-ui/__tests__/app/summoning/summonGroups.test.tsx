import type {
  SummonBudgetDto,
  SummonGroupListDto,
  SummonGroupStatusDto,
  SummonListDto,
  SummonListItemDto,
} from "../../../app/api/types";
import type { MockHandler, MockReply } from "../mockFetch";
import { describe, expect, it } from "bun:test";
import { utcResetLabel } from "../../../app/screens/queues/panels/budgetText";
import { expectAbsent } from "../assert";
import { fireEvent, page, setupDom, visit, waitFor, within } from "../dom";
import { metaFixture, problem } from "../fixtures";
import { renderApp } from "../renderApp";

setupDom();

/**
 * The Summoning screen's summon groups (`GET /summon/groups`), under the
 * controllers table where the API reads summon state from storage
 * (`features.summonRemoteStatus`): one row per group — its budget, its shared
 * circuit per kind, and the member queues charged today — with `?group=`
 * marking one row and scrolling it into view. And a controller row's
 * "Circuit open" badge.
 */

const NOW = Date.now();

/** A budget that is on: 4 of 20 this hour, 13 of 200 today. */
const BUDGET: SummonBudgetDto = {
  hour: 4,
  perHour: 20,
  day: 13,
  perDay: 200,
  hourResetsAt: NOW + 23 * 60_000,
  dayResetsAt: NOW + 9 * 3_600_000,
};

/** One controller as `GET /summon` lists it. */
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
    budget: BUDGET,
    ...overrides,
  };
}

/** The group `gpu`: budget on, ECS circuit open by `reports`, K8s closed, two queues charged. */
function gpu(
  overrides: Partial<SummonGroupStatusDto> = {},
): SummonGroupStatusDto {
  return {
    name: "gpu",
    budget: BUDGET,
    queues: {
      emails: { day: 3, lastAt: NOW - 60_000 },
      reports: { day: 7, lastAt: NOW - 120_000 },
    },
    circuits: {
      k8s: { failures: 1 },
      ecs: {
        failures: 5,
        openUntil: NOW + 900_000,
        openedBy: { queue: "reports", id: "s-3", detail: "quota spent" },
      },
    },
    ...overrides,
  };
}

/** The group `cpu`: budget off, no shared circuit, nothing charged today. */
function cpu(): SummonGroupStatusDto {
  return {
    name: "cpu",
    budget: {
      hour: 0,
      day: 0,
      off: true,
      hourResetsAt: NOW + 23 * 60_000,
      dayResetsAt: NOW + 9 * 3_600_000,
    },
    queues: {},
  };
}

/** `GET /summon/groups` answering these groups. */
function groups(list: SummonGroupStatusDto[]): MockReply {
  const body: SummonGroupListDto = { groups: list };
  return { body };
}

/** Meta with `summonRemoteStatus` set to `value`. */
function remote(value: boolean): MockReply {
  return {
    body: metaFixture({
      features: { ...metaFixture().features, summonRemoteStatus: value },
    }),
  };
}

/** Opens `path` (default `/summon`) with these handlers, and resolves the screen once the controllers render. */
async function openScreen(
  handlers: Record<string, MockHandler | MockReply> = {},
  path = "/jobs/summon",
) {
  visit(path);
  const controllers: SummonListDto = { controllers: [controller()] };
  const rendered = renderApp({
    handlers: {
      "GET /meta": remote(true),
      "GET /summon": { body: controllers },
      "GET /summon/groups": groups([gpu(), cpu()]),
      ...handlers,
    },
  });
  const screen = await page().findByTestId(
    "summoning-screen",
    {},
    { timeout: 5_000 },
  );
  await within(screen).findByTestId("summoning-row-emails");
  return { ...rendered, screen };
}

/**
 * Runs `body` with `Element.prototype.scrollIntoView` replaced by `stub`
 * (`undefined` removes it), restoring the original after.
 */
async function withScrollIntoView(
  stub: ((this: Element) => void) | undefined,
  body: () => Promise<void>,
): Promise<void> {
  const proto = Element.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "scrollIntoView");
  Object.defineProperty(proto, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: stub,
  });
  try {
    await body();
  } finally {
    if (original === undefined) {
      Reflect.deleteProperty(proto, "scrollIntoView");
    } else {
      Object.defineProperty(proto, "scrollIntoView", original);
    }
  }
}

describe("the Summoning screen's summon groups", () => {
  it("is absent, and the groups are not read, where the API reads no remote summon state (negative control)", async () => {
    const { screen, calls } = await openScreen({ "GET /meta": remote(false) });
    // Give a stray read the chance to be made.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expectAbsent(within(screen).queryByTestId("summon-groups"));
    expect(screen.textContent).not.toContain("Summon groups");
    expect(calls.some((call) => call.path === "/summon/groups")).toBe(false);
  });

  it("lists each group under the controllers: budget, shared circuit per kind, and the queues charged today", async () => {
    const { screen } = await openScreen();
    const section = await within(screen).findByTestId("summon-groups");
    expect(within(section).getByRole("heading", { level: 2 }).textContent).toBe(
      "Summon groups",
    );
    const controllers = within(screen).getByRole("region", {
      name: "Summon controllers",
    });
    expect(
      controllers.compareDocumentPosition(section) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    const row = await within(section).findByTestId("summon-group-row-gpu");
    expect(row.id).toBe("summon-group-gpu");
    expect(within(row).getByRole("rowheader").textContent).toBe("gpu");
    expect(
      within(row).getByTestId("summon-groups-budget-gpu-hour").textContent,
    ).toStartWith("16 of 20 left this hour");
    const open = within(row).getByTestId("summon-groups-circuit-gpu-ecs");
    expect(open.dataset.open).toBe("true");
    expect(open.className).toContain("is-open");
    expect(open.textContent).toMatch(
      /^ecs: open until (\d\d:\d\d|midnight) UTC \(in 15m\), opened by reports$/,
    );
    expect(open.title).toBe(
      "5 consecutive failures across the group: quota spent",
    );
    expect(
      within(open).getByRole("link", { name: "reports" }).getAttribute("href"),
    ).toBe("/jobs/queues/reports?panel=summon");
    expect(
      within(row).getByTestId("summon-groups-circuit-gpu-k8s").textContent,
    ).toBe("k8s: closed");
    const members = [
      ...row.querySelectorAll<HTMLElement>(
        '[data-testid^="summon-groups-share-gpu-"]',
      ),
    ];
    expect(members.map((member) => member.textContent)).toEqual([
      "reports 7",
      "emails 3",
    ]);
    expect(
      within(members[1]!)
        .getByRole("link", { name: "emails" })
        .getAttribute("href"),
    ).toBe("/jobs/queues/emails?panel=summon");
    expect(section.textContent).not.toMatch(/shared by/i);

    const off = within(section).getByTestId("summon-group-row-cpu");
    expect(
      within(off).getByTestId("summon-groups-budget-cpu").textContent,
    ).toBe("Off: 0 this hour, 0 today (UTC), no limit");
    expect(off.textContent).toContain("None today");
    expectAbsent(off.querySelector('[data-testid^="summon-groups-circuit-"]'));
    // No `?group=`: nothing is marked.
    expect(row.hasAttribute("aria-current")).toBe(false);
  });

  it("marks the ?group= row and scrolls it into view once", async () => {
    const scrolled: Element[] = [];
    await withScrollIntoView(
      function (this: Element) {
        scrolled.push(this);
      },
      async () => {
        const { screen } = await openScreen({}, "/jobs/summon?group=gpu");
        const row = await within(screen).findByTestId("summon-group-row-gpu");
        expect(row.getAttribute("aria-current")).toBe("true");
        expect(row.className).toContain("is-current");
        const other = within(screen).getByTestId("summon-group-row-cpu");
        expect(other.hasAttribute("aria-current")).toBe(false);
        expect(other.className).not.toContain("is-current");
        await waitFor(() => expect(scrolled).toHaveLength(1));
        expect(scrolled[0]).toBe(row);
        // Not again while the screen stays.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(scrolled).toHaveLength(1);
      },
    );
  });

  it("marks the row without scrolling where scrollIntoView is missing", async () => {
    await withScrollIntoView(undefined, async () => {
      const { screen } = await openScreen({}, "/jobs/summon?group=cpu");
      const row = await within(screen).findByTestId("summon-group-row-cpu");
      expect(row.getAttribute("aria-current")).toBe("true");
      expect(within(screen).getByTestId("summon-group-row-gpu")).toBeTruthy();
    });
  });

  it("says so in one line where the namespace has no summon groups", async () => {
    const { screen } = await openScreen({ "GET /summon/groups": groups([]) });
    const empty = await within(screen).findByTestId("summon-groups-empty");
    expect(empty.textContent).toBe("No summon groups in this namespace.");
    const section = within(screen).getByTestId("summon-groups");
    expectAbsent(section.querySelector("table"));
  });

  it("shows a failed read inside the section, with Retry, and keeps the controllers", async () => {
    let fail = true;
    const { screen } = await openScreen({
      "GET /summon/groups": () =>
        fail
          ? { status: 500, body: problem(500, "INTERNAL", "The store is down") }
          : groups([gpu()]),
    });
    const section = within(screen).getByTestId("summon-groups");
    await within(section).findByText("Could not load the summon groups");
    expect(within(screen).getByTestId("summoning-row-emails")).toBeTruthy();
    fail = false;
    fireEvent.click(within(section).getByRole("button", { name: /Retry/ }));
    await within(section).findByTestId("summon-group-row-gpu");
  });

  it("refuses a group without a budget object", async () => {
    const { screen } = await openScreen({
      "GET /summon/groups": { body: { groups: [{ name: "gpu", queues: {} }] } },
    });
    const section = within(screen).getByTestId("summon-groups");
    await within(section).findByText("Could not load the summon groups");
    expect(section.textContent).toContain("Expected the summon groups");
    expect(within(screen).getByTestId("summoning-row-emails")).toBeTruthy();
  });

  it("refuses a group whose queues are not an object, and a list that is not an array", async () => {
    for (const body of [
      { groups: [{ name: "gpu", budget: BUDGET, queues: [] }] },
      { groups: { gpu: gpu() } },
    ]) {
      const { screen, unmount } = await openScreen({
        "GET /summon/groups": { body },
      });
      const section = within(screen).getByTestId("summon-groups");
      await within(section).findByText("Could not load the summon groups");
      unmount();
    }
  });
});

describe("a controller row's circuit", () => {
  it("shows Circuit open in the warning tone, with the reset time in UTC in its title", async () => {
    const until = NOW + 900_000;
    const { screen } = await openScreen({
      "GET /summon": {
        body: {
          controllers: [
            controller({ circuitOpenUntil: until, inert: true }),
            controller({ queue: "reports" }),
          ],
        },
      },
    });
    const row = within(screen).getByTestId("summoning-row-emails");
    const badge = within(row).getByTestId("summoning-circuit");
    expect(badge.textContent).toBe("Circuit open");
    expect(badge.className).toContain("badge-warning");
    expect(badge.title).toStartWith(
      `Circuit open until ${utcResetLabel(until, Date.now())}:`,
    );
    // In the readiness cell, after the inert badge.
    const inert = within(row).getByTestId("summoning-inert");
    expect(inert.parentElement).toBe(badge.parentElement);
    expect(
      inert.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("shows no circuit badge on a row whose circuit is closed (negative control)", async () => {
    const { screen } = await openScreen();
    const row = within(screen).getByTestId("summoning-row-emails");
    expectAbsent(within(row).queryByTestId("summoning-circuit"));
    expect(row.textContent).not.toContain("Circuit open");
  });
});
