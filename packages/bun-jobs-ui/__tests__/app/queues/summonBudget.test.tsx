import type { SummonBudgetDto, SummonStatusDto } from "../../../app/api/types";
import type { MockReply, RecordedCall } from "../mockFetch";
import { describe, expect, it } from "bun:test";
import { expectAbsent, expectUndefined } from "../assert";
import { fireEvent, page, setupDom, waitFor, within } from "../dom";
import { metaFixture, permissionsFixture } from "../fixtures";
import { findDialog, notifications, renderQueue } from "./fixtures";

setupDom();

/**
 * The Summon panel's budget: what each UTC window has left, as a meter and
 * in words, with when it resets (absolute in UTC, and relative), a window at
 * its limit read as exhausted; and Reset's "Also clear budget usage", offered
 * only where the API takes `{ budget: true }` (`features.summonResetBudget`).
 *
 * The harness is `summonPanel.test.tsx`'s.
 */

/** `ms` as the panel names a UTC time of day: `HH:MM UTC`, or `midnight UTC` at 00:00. */
function utcTime(ms: number): string {
  const time = new Date(ms).toISOString().slice(11, 16);
  return time === "00:00" ? "midnight UTC" : `${time} UTC`;
}

/** 23 minutes and a few seconds from now, so it reads "in 23m". */
const HOUR_RESET = Date.now() + 23 * 60_000 + 5_000;
/**
 * Five hours and a few seconds from now, so it reads "in 5h" whatever the time
 * of day. (The real day window resets at the next UTC midnight, which early in
 * the day is far enough away to read "tomorrow"; the formatter's own tests
 * cover the midnight label with a fixed clock.)
 */
const DAY_RESET = Date.now() + 5 * 3_600_000 + 5_000;

/** A budget that is on: 3 of 30 used this hour, 12 of 300 today. */
function budgetFixture(
  overrides: Partial<SummonBudgetDto> = {},
): SummonBudgetDto {
  return {
    hour: 3,
    perHour: 30,
    day: 12,
    perDay: 300,
    hourResetsAt: HOUR_RESET,
    dayResetsAt: DAY_RESET,
    ...overrides,
  };
}

/** A summon status: a local, working controller with nothing on its way. */
function statusFixture(
  overrides: Partial<SummonStatusDto> = {},
): SummonStatusDto {
  return {
    queue: "emails",
    local: true,
    inert: false,
    pending: [],
    failures: 0,
    budget: budgetFixture(),
    ...overrides,
  };
}

/** The grants and handlers a summon-capable caller has. */
function granted(
  status: SummonStatusDto = statusFixture(),
  extra: Record<string, MockReply> = {},
): Record<string, MockReply> {
  return {
    "GET /meta/permissions": {
      body: permissionsFixture({ "queues.summon": true }),
    },
    "GET /queues/emails/summon": { body: status },
    ...extra,
  };
}

/** Opens the Summon panel of `emails`. */
async function openPanel(handlers: Record<string, MockReply>) {
  const rendered = renderQueue({
    path: "/queues/emails?panel=summon",
    handlers,
  });
  const panel = await page().findByTestId(
    "queue-summon",
    {},
    { timeout: 5_000 },
  );
  return { ...rendered, panel };
}

describe("the Summon panel's budget", () => {
  it("shows what each window has left, with a meter, and when it resets in UTC and from now", async () => {
    const { panel } = await openPanel(granted());
    const hour = within(panel).getByTestId("summon-budget-hour");
    const day = within(panel).getByTestId("summon-budget-day");
    expect(hour.textContent).toMatch(
      new RegExp(
        `^27 of 30 left this hour, resets at ${utcTime(HOUR_RESET)} \\(in 23m\\)$`,
      ),
    );
    expect(day.textContent).toMatch(
      new RegExp(
        `^288 of 300 left today, resets at ${utcTime(DAY_RESET)} \\(in 5h\\)$`,
      ),
    );
    // The relative part is the app's RelativeTime: a <time> with the instant.
    expect(day.querySelector("time")?.getAttribute("dateTime")).toBe(
      new Date(DAY_RESET).toISOString(),
    );
    // A meter per window, of what is left against the limit.
    const hourMeter = hour.querySelector("meter");
    expect(hourMeter?.getAttribute("value")).toBe("27");
    expect(hourMeter?.getAttribute("max")).toBe("30");
    expect(day.querySelector("meter")?.getAttribute("value")).toBe("288");
    // The used counts stay in view, under the row and as its tooltip.
    const used = "Used 3 of 30 this hour, 12 of 300 today (UTC)";
    expect(panel.textContent).toContain(used);
    expect(within(panel).getByTestId("summon-budget").title).toBe(used);
    // Nothing is exhausted: no warning anywhere (negative control for the next test).
    expect(within(panel).getByTestId("summon-budget").dataset.exhausted).toBe(
      "false",
    );
    expect(panel.textContent).not.toContain("Exhausted");
  });

  it("reads a window at its limit as exhausted, in the warning tone, and only that window", async () => {
    const { panel } = await openPanel(
      granted(statusFixture({ budget: budgetFixture({ hour: 30 }) })),
    );
    const hour = within(panel).getByTestId("summon-budget-hour");
    const day = within(panel).getByTestId("summon-budget-day");
    expect(hour.dataset.exhausted).toBe("true");
    expect(hour.className).toContain("is-exhausted");
    const badge = within(hour).getByText("Exhausted");
    expect(badge.className).toContain("badge-warning");
    expect(hour.textContent).toContain("Exhausted 0 of 30 left this hour");
    expect(hour.querySelector("meter")?.getAttribute("value")).toBe("0");
    // The day still has room.
    expect(day.dataset.exhausted).toBe("false");
    expect(day.className).not.toContain("is-exhausted");
    expect(day.textContent).not.toContain("Exhausted");
    expect(within(panel).getByTestId("summon-budget").dataset.exhausted).toBe(
      "true",
    );
  });

  it("keeps the off text as it was, with no meter, and the reset times as its tooltip", async () => {
    const { panel } = await openPanel(
      granted(
        statusFixture({
          budget: {
            hour: 41,
            day: 120,
            off: true,
            hourResetsAt: HOUR_RESET,
            dayResetsAt: DAY_RESET,
          },
        }),
      ),
    );
    const budget = within(panel).getByTestId("summon-budget");
    expect(budget.textContent).toBe(
      "Off: 41 this hour, 120 today (UTC), no limit",
    );
    expect(budget.querySelectorAll("meter").length).toBe(0);
    expect(budget.title).toBe(
      `Counts reset at ${utcTime(HOUR_RESET)} and at ${utcTime(DAY_RESET)}`,
    );
    expectAbsent(within(panel).queryByTestId("summon-budget-hour"));
    // No used-counts note either: the counts are the text.
    expect(panel.textContent).not.toContain("Used 41");
  });
});

describe("Reset's Also clear budget usage", () => {
  /** Opens Reset… and resolves its dialog. */
  async function openReset(panel: HTMLElement): Promise<HTMLElement> {
    fireEvent.click(within(panel).getByRole("button", { name: "Reset…" }));
    return findDialog();
  }

  /** The reset POSTs the mock received. */
  function resets(calls: readonly RecordedCall[]): RecordedCall[] {
    return calls.filter(
      (call) =>
        call.method === "POST" && call.path === "/queues/emails/summon/reset",
    );
  }

  /** Handlers whose reset answers the status with the usage cleared. */
  function withReset(extra: Record<string, MockReply> = {}) {
    return granted(statusFixture(), {
      "POST /queues/emails/summon/reset": {
        body: statusFixture({ budget: budgetFixture({ hour: 0, day: 0 }) }),
      },
      ...extra,
    });
  }

  it("is offered, unchecked, where the API takes it", async () => {
    const { panel } = await openPanel(withReset());
    const dialog = await openReset(panel);
    const box = within(dialog).getByLabelText(
      "Also clear budget usage",
    ) as HTMLInputElement;
    expect(box.type).toBe("checkbox");
    expect(box.checked).toBe(false);
  });

  it("is not offered where the API does not take it (features.summonResetBudget false)", async () => {
    const { panel } = await openPanel(
      withReset({
        "GET /meta": {
          body: metaFixture({
            features: { ...metaFixture().features, summonResetBudget: false },
          }),
        },
      }),
    );
    const dialog = await openReset(panel);
    // The dialog is there, and says what Reset does; only the box is missing.
    expect(dialog.textContent).toContain("Clears the consecutive failures");
    expectAbsent(within(dialog).queryByLabelText("Also clear budget usage"));
    expectAbsent(within(dialog).queryByRole("checkbox"));
  });

  it("checked, sends { budget: true }, says the usage was cleared and re-reads the status", async () => {
    const { panel, calls } = await openPanel(withReset());
    const reads = () =>
      calls.filter(
        (call) =>
          call.method === "GET" && call.path === "/queues/emails/summon",
      ).length;
    const before = reads();
    const dialog = await openReset(panel);
    fireEvent.click(within(dialog).getByLabelText("Also clear budget usage"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
    await waitFor(() =>
      expect(notifications().textContent).toContain(
        "Reset the summon state of emails: failures, backoff, circuit and budget usage cleared",
      ),
    );
    const posts = resets(calls);
    expect(posts.length).toBe(1);
    expect(JSON.parse(posts[0]!.body!)).toEqual({ budget: true });
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });

  it("unchecked, sends no body, as before the option existed", async () => {
    const { panel, calls } = await openPanel(withReset());
    const dialog = await openReset(panel);
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
    await waitFor(() =>
      expect(notifications().textContent).toContain(
        "Reset the summon state of emails: failures, backoff and circuit cleared",
      ),
    );
    const posts = resets(calls);
    expect(posts.length).toBe(1);
    expectUndefined(posts[0]!.body);
  });

  it("starts unchecked each time the dialog opens", async () => {
    const { panel, calls } = await openPanel(withReset());
    let dialog = await openReset(panel);
    fireEvent.click(within(dialog).getByLabelText("Also clear budget usage"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(resets(calls).length).toBe(1));
    await waitFor(() =>
      expect(
        within(panel).getByRole("button", { name: "Reset…" }),
      ).toHaveProperty("disabled", false),
    );
    dialog = await openReset(panel);
    expect(
      (
        within(dialog).getByLabelText(
          "Also clear budget usage",
        ) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });
});
