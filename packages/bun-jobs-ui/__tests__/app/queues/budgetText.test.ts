import type { SummonBudgetDto } from "../../../app/api/types";
import type {
  BudgetOffView,
  BudgetOnView,
} from "../../../app/screens/queues/panels/budgetText";
import { describe, expect, it } from "bun:test";
import {
  budgetOff,
  budgetUsedText,
  summonBudgetView,
  utcResetLabel,
} from "../../../app/screens/queues/panels/budgetText";
import { expectUndefined } from "../assert";

/**
 * The summon budget in plain words (`budgetText.ts`), which the Summon panel
 * and the Summoning screen both render: what each UTC window has left, when
 * it is exhausted, and when it resets — against a fixed `now`.
 */

/** 13:37 UTC on 6 October 2026. */
const NOW = Date.UTC(2026, 9, 6, 13, 37);
/** The next UTC hour after {@link NOW}. */
const NEXT_HOUR = Date.UTC(2026, 9, 6, 14);
/** The next UTC midnight after {@link NOW}. */
const MIDNIGHT = Date.UTC(2026, 9, 7);

/** A budget that is on, with some of each window used. */
function budget(overrides: Partial<SummonBudgetDto> = {}): SummonBudgetDto {
  return {
    hour: 2,
    perHour: 30,
    day: 10,
    perDay: 300,
    hourResetsAt: NEXT_HOUR,
    dayResetsAt: MIDNIGHT,
    ...overrides,
  };
}

/** The view of a budget that must be on. */
function on(input: SummonBudgetDto, now = NOW): BudgetOnView {
  const view = summonBudgetView(input, now);
  if (view.off) {
    throw new Error("expected the budget to be on");
  }
  return view;
}

/** The view of a budget that must be off. */
function off(input: SummonBudgetDto, now = NOW): BudgetOffView {
  const view = summonBudgetView(input, now);
  if (!view.off) {
    throw new Error("expected the budget to be off");
  }
  return view;
}

describe("a budget that is on", () => {
  it("says what each window has left, and when it resets in UTC", () => {
    const view = on(budget());
    expect(view.hour).toEqual({
      window: "hour",
      used: 2,
      limit: 30,
      remaining: 28,
      exhausted: false,
      resetsAt: NEXT_HOUR,
      left: "28 of 30 left this hour",
      usedText: "2 of 30 used this hour",
      resetAt: "14:00 UTC",
    });
    expect(view.day).toMatchObject({
      remaining: 290,
      exhausted: false,
      left: "290 of 300 left today",
      usedText: "10 of 300 used today",
      resetAt: "midnight UTC",
    });
    expect(view.exhausted).toBe(false);
    // The used counts stay visible beside what is left.
    expect(view.usedText).toBe("Used 2 of 30 this hour, 10 of 300 today (UTC)");
  });

  it("formats large counts as the app does", () => {
    const view = on(budget({ day: 1_500, perDay: 10_000 }));
    expect(view.day.left).toBe("8,500 of 10,000 left today");
  });
});

describe("an exhausted window", () => {
  it("is exhausted at its limit, with nothing left", () => {
    const view = on(budget({ hour: 30 }));
    expect(view.hour).toMatchObject({
      remaining: 0,
      exhausted: true,
      left: "0 of 30 left this hour",
    });
    expect(view.day.exhausted).toBe(false);
    expect(view.exhausted).toBe(true);
  });

  it("is exhausted over its limit too (a limit lowered after the count), never below 0 left", () => {
    const view = on(budget({ day: 320 }));
    expect(view.day).toMatchObject({
      remaining: 0,
      exhausted: true,
      left: "0 of 300 left today",
    });
    expect(view.hour.exhausted).toBe(false);
    expect(view.exhausted).toBe(true);
  });

  it("is not exhausted one short of its limit (negative control)", () => {
    const view = on(budget({ hour: 29, day: 299 }));
    expect(view.hour).toMatchObject({ remaining: 1, exhausted: false });
    expect(view.day).toMatchObject({ remaining: 1, exhausted: false });
    expect(view.exhausted).toBe(false);
  });

  it("treats a limit of 0 as always exhausted", () => {
    expect(on(budget({ hour: 0, perHour: 0 })).hour).toMatchObject({
      remaining: 0,
      exhausted: true,
    });
  });
});

describe("a budget that is off", () => {
  it("shows the counts with no limit, as before, and the reset times apart", () => {
    const input: SummonBudgetDto = {
      hour: 41,
      day: 120,
      off: true,
      hourResetsAt: NEXT_HOUR,
      dayResetsAt: MIDNIGHT,
    };
    expect(budgetOff(input)).toBe(true);
    expect(off(input)).toEqual({
      off: true,
      text: "Off: 41 this hour, 120 today (UTC), no limit",
      resets: "Counts reset at 14:00 UTC and at midnight UTC",
    });
    expectUndefined(budgetUsedText(input));
  });

  it("is off when a limit is missing, rather than measured against an invented one", () => {
    expect(off(budget({ perDay: undefined })).text).toBe(
      "Off: 2 this hour, 10 today (UTC), no limit",
    );
    expect(off(budget({ perHour: undefined })).off).toBe(true);
  });

  it("is on with both limits and no off flag (negative control)", () => {
    expect(budgetOff(budget())).toBe(false);
    expect(budgetUsedText(budget())).toBe(
      "Used 2 of 30 this hour, 10 of 300 today (UTC)",
    );
  });
});

describe("the reset times", () => {
  it("names a UTC hour by its time, and the start of a day as midnight", () => {
    expect(utcResetLabel(NEXT_HOUR, NOW)).toBe("14:00 UTC");
    expect(utcResetLabel(MIDNIGHT, NOW)).toBe("midnight UTC");
    expect(utcResetLabel(Date.UTC(2026, 9, 6, 9, 5), NOW)).toBe("09:05 UTC");
  });

  it("reads the time in UTC, whatever the local zone", () => {
    // 14:00 UTC is 14:00 here whatever offset the machine runs at.
    expect(utcResetLabel(Date.parse("2026-10-06T16:00:00+02:00"), NOW)).toBe(
      "14:00 UTC",
    );
  });

  it("adds the date to a reset a day or more away, either side of now", () => {
    expect(utcResetLabel(Date.UTC(2026, 9, 7, 14), NOW)).toBe(
      "2026-10-07 14:00 UTC",
    );
    // A stale read: the window reset a day ago.
    expect(utcResetLabel(Date.UTC(2026, 9, 5, 13), NOW)).toBe(
      "2026-10-05 13:00 UTC",
    );
    // Just under a day away: the time alone (negative control).
    expect(utcResetLabel(NOW + 86_399_000, NOW)).toBe("13:36 UTC");
  });

  it("carries both windows' reset instants through the view", () => {
    const view = on(budget());
    expect(view.hour.resetsAt).toBe(NEXT_HOUR);
    expect(view.day.resetsAt).toBe(MIDNIGHT);
  });
});
