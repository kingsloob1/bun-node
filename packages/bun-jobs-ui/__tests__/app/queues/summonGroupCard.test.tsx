import type {
  SummonGroupStatusDto,
  SummonStatusDto,
} from "../../../app/api/types";
import type { MockReply } from "../mockFetch";
import { describe, expect, it } from "bun:test";
import { summonGroupPath } from "../../../app/screens/summoning/paths";
import { expectAbsent } from "../assert";
import { page, setupDom, within } from "../dom";
import { metaFixture } from "../fixtures";
import { renderQueue } from "./fixtures";

setupDom();

/**
 * The Summon tab's group card: the summon group a queue's controller is in
 * (`status.group`) — its name linked to its row on the Summoning screen, its
 * budget, the shared circuit per provider kind, and today's attempts charged
 * to it by each member queue the caller may read, this queue's marked. And
 * the queue's own Budget row, which says the group's budget applies where
 * the queue's own is off.
 */

const NOW = Date.now();

/** The group: a budget that is on, and three member queues charged today. */
function groupFixture(
  overrides: Partial<SummonGroupStatusDto> = {},
): SummonGroupStatusDto {
  return {
    name: "gpu pool",
    budget: {
      hour: 4,
      perHour: 20,
      day: 13,
      perDay: 200,
      hourResetsAt: NOW + 23 * 60_000,
      dayResetsAt: NOW + 9 * 3_600_000,
    },
    queues: {
      emails: { day: 3, lastAt: NOW - 60_000 },
      reports: { day: 7, lastAt: NOW - 120_000 },
      alerts: { day: 3, lastAt: NOW - 180_000 },
    },
    ...overrides,
  };
}

/** A summon status of `emails`: a local ECS controller in the group. */
function statusFixture(
  overrides: Partial<SummonStatusDto> = {},
): SummonStatusDto {
  return {
    queue: "emails",
    local: true,
    inert: false,
    summoner: {
      provider: {
        name: "@acme/bun-jobs-ecs",
        version: "1.2.0",
        kind: "ecs",
        displayName: "Amazon ECS",
        apiVersion: { core: "0.1", summon: "0.1" },
      },
      readiness: "ready",
      facts: {},
    },
    pending: [],
    failures: 0,
    budget: {
      hour: 3,
      perHour: 30,
      day: 12,
      perDay: 300,
      hourResetsAt: NOW + 23 * 60_000,
      dayResetsAt: NOW + 9 * 3_600_000,
    },
    group: groupFixture(),
    ...overrides,
  };
}

/** Meta with `summonRemoteStatus` set to `value`. */
function remote(value: boolean): MockReply {
  return {
    body: metaFixture({
      features: { ...metaFixture().features, summonRemoteStatus: value },
    }),
  };
}

/** Opens the Summon panel of `emails` answering `status`. */
async function openPanel(
  status: SummonStatusDto,
  handlers: Record<string, MockReply> = {},
) {
  renderQueue({
    path: "/queues/emails?panel=summon",
    handlers: {
      "GET /meta": remote(true),
      "GET /queues/emails/summon": { body: status },
      ...handlers,
    },
  });
  return page().findByTestId("queue-summon", {}, { timeout: 5_000 });
}

/** The queue names of the share table's rows, in order. */
function shareRows(card: HTMLElement): HTMLElement[] {
  return [
    ...card.querySelectorAll<HTMLElement>(
      'tbody tr[data-testid^="summon-group-share-"]',
    ),
  ];
}

describe("the Summon tab's group card", () => {
  it("names the group, linked to its row on the Summoning screen, and shows its budget", async () => {
    const panel = await openPanel(statusFixture());
    const card = within(panel).getByTestId("summon-group");
    const heading = within(card).getByRole("heading", { level: 3 });
    expect(heading.textContent).toBe("Summon group gpu pool");
    const name = within(card).getByTestId("summon-group-name");
    expect(name.tagName).toBe("A");
    expect(summonGroupPath("gpu pool")).toBe("/summon?group=gpu%20pool");
    expect(name.getAttribute("href")).toBe("/jobs/summon?group=gpu%20pool");
    expect(
      within(card).getByTestId("summon-group-budget-hour").textContent,
    ).toStartWith("16 of 20 left this hour");
    expect(
      within(card).getByTestId("summon-group-budget-day").textContent,
    ).toStartWith("187 of 200 left today");
    // After the queue's own state list.
    const state = panel.querySelector(".kv");
    expect(
      state !== null &&
        (state.compareDocumentPosition(card) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
          0,
    ).toBe(true);
  });

  it("names the group without a link where the Summoning screen lists no groups", async () => {
    const panel = await openPanel(statusFixture(), {
      "GET /meta": remote(false),
    });
    const name = within(panel).getByTestId("summon-group-name");
    expect(name.tagName).toBe("SPAN");
    expect(name.textContent).toBe("gpu pool");
  });

  it("shows today's shares, most attempts first then by name, with this queue marked", async () => {
    const panel = await openPanel(statusFixture());
    const card = within(panel).getByTestId("summon-group");
    expect(card.textContent).toContain("Charged today");
    expect(card.textContent).not.toMatch(/shared by/i);
    const rows = shareRows(card);
    expect(rows.map((row) => row.dataset.testid)).toEqual([
      "summon-group-share-reports",
      "summon-group-share-alerts",
      "summon-group-share-emails",
    ]);
    const mine = within(card).getByTestId("summon-group-share-emails");
    expect(mine.getAttribute("aria-current")).toBe("true");
    expect(mine.className).toContain("is-current");
    expect(mine.textContent).toContain("(this queue)");
    expect(mine.querySelectorAll("td")[0]?.textContent).toBe("3");
    expect(mine.querySelector("time")).not.toBeNull();
    const other = within(card).getByTestId("summon-group-share-reports");
    expect(other.hasAttribute("aria-current")).toBe(false);
    expect(other.textContent).not.toContain("(this queue)");
    expect(
      within(other).getByRole("link", { name: "reports" }).getAttribute("href"),
    ).toBe("/jobs/queues/reports?panel=summon");
  });

  it("says when no attempt was charged to the group today", async () => {
    const panel = await openPanel(
      statusFixture({ group: groupFixture({ queues: {} }) }),
    );
    const card = within(panel).getByTestId("summon-group");
    expect(
      within(card).getByTestId("summon-group-shares-empty").textContent,
    ).toBe("No attempts charged to the group today.");
    expectAbsent(card.querySelector("table"));
  });

  it("shows the group's one circuit, closed, by the summoner's kind with its failures", async () => {
    const panel = await openPanel(
      statusFixture({ group: groupFixture({ circuit: { failures: 2 } }) }),
    );
    const circuit = within(panel).getByTestId("summon-group-circuit-ecs");
    expect(circuit.dataset.open).toBe("false");
    expect(circuit.textContent).toBe(
      "Closed 2 consecutive failures across the group",
    );
    expect(within(panel).getByText("Shared circuit, ecs")).toBeTruthy();
  });

  it("shows every kind's circuit: an open one in the warning tone, until when, who opened it and why", async () => {
    const panel = await openPanel(
      statusFixture({
        group: groupFixture({
          circuit: { failures: 5, openUntil: NOW + 900_000 },
          circuits: {
            k8s: { failures: 1 },
            ecs: {
              failures: 5,
              openUntil: NOW + 900_000,
              openedBy: { queue: "reports", id: "s-3", detail: "quota spent" },
            },
          },
        }),
      }),
    );
    const open = within(panel).getByTestId("summon-group-circuit-ecs");
    expect(open.dataset.open).toBe("true");
    const badge = within(open).getByText("Open");
    expect(badge.className).toContain("badge-warning");
    expect(open.querySelector("time")).not.toBeNull();
    expect(open.textContent).toMatch(
      /^Open until (\d\d:\d\d|midnight) UTC \(in 15m\), opened by reports — quota spent$/,
    );
    expect(
      within(open).getByRole("link", { name: "reports" }).getAttribute("href"),
    ).toBe("/jobs/queues/reports?panel=summon");
    const closed = within(panel).getByTestId("summon-group-circuit-k8s");
    expect(closed.dataset.open).toBe("false");
    expect(closed.textContent).toContain("Closed");
  });

  it("names the circuit for this summoner where the status names no kind", async () => {
    const panel = await openPanel(
      statusFixture({
        local: false,
        summoner: undefined,
        group: groupFixture({ circuit: { failures: 0 } }),
      }),
    );
    expect(
      within(panel).getByTestId("summon-group-circuit-this-summoner")
        .textContent,
    ).toContain("Closed");
    expect(
      within(panel).getByText("Shared circuit, this summoner"),
    ).toBeTruthy();
  });

  it("shows no circuit row where the group shares no circuit", async () => {
    const panel = await openPanel(statusFixture());
    const card = within(panel).getByTestId("summon-group");
    expectAbsent(card.querySelector('[data-testid^="summon-group-circuit"]'));
    expect(card.textContent).not.toContain("Shared circuit");
  });

  it("reads the queue's own budget, off, as the group's applying, its counts in the tooltip", async () => {
    const panel = await openPanel(
      statusFixture({
        budget: {
          hour: 41,
          day: 120,
          off: true,
          hourResetsAt: NOW + 23 * 60_000,
          dayResetsAt: NOW + 9 * 3_600_000,
        },
      }),
    );
    const own = within(panel).getByTestId("summon-budget");
    expect(own.textContent).toBe("Off: the group's budget applies");
    expect(own.title).toStartWith(
      "This queue's own count: 41 this hour, 120 today (UTC).",
    );
  });

  it("reads the queue's off budget as no limit when the group's budget is off too", async () => {
    const panel = await openPanel(
      statusFixture({
        budget: {
          hour: 41,
          day: 120,
          off: true,
          hourResetsAt: NOW + 23 * 60_000,
          dayResetsAt: NOW + 9 * 3_600_000,
        },
        group: groupFixture({
          budget: {
            hour: 4,
            day: 13,
            off: true,
            hourResetsAt: NOW + 23 * 60_000,
            dayResetsAt: NOW + 9 * 3_600_000,
          },
        }),
      }),
    );
    // Neither budget limits it, so "the group's budget applies" would be untrue.
    expect(within(panel).getByTestId("summon-budget").textContent).toBe(
      "Off: 41 this hour, 120 today (UTC), no limit",
    );
    expect(within(panel).getByTestId("summon-group-budget").textContent).toBe(
      "Off: 4 this hour, 13 today (UTC), no limit",
    );
  });

  it("is absent, and the queue's off budget reads as no limit, outside a group (negative control)", async () => {
    const panel = await openPanel(
      statusFixture({
        group: undefined,
        budget: {
          hour: 41,
          day: 120,
          off: true,
          hourResetsAt: NOW + 23 * 60_000,
          dayResetsAt: NOW + 9 * 3_600_000,
        },
      }),
    );
    expectAbsent(within(panel).queryByTestId("summon-group"));
    expect(within(panel).getByTestId("summon-budget").textContent).toBe(
      "Off: 41 this hour, 120 today (UTC), no limit",
    );
  });
});
