import type { SummonBudgetDto } from "../../../api/types";
import { formatNumber } from "../../../format";

/**
 * A summon budget in plain words: how many attempts each UTC window has
 * left, whether one is exhausted, and when each resets — as the Summon panel
 * and the Summoning screen both show it.
 *
 * Pure: the time of day is read in UTC, since the server counts the windows
 * in UTC (`hourResetsAt` is the next UTC hour, `dayResetsAt` the next UTC
 * midnight), and `now` is passed in, so a test can fix it. The relative hint
 * ("in 23m") is the app's `RelativeTime`, rendered beside these words.
 */

/** One of the budget's two windows. */
export type BudgetWindow = "hour" | "day";

/** One window of a budget that is on. */
export interface BudgetWindowView {
  /** Which window. */
  window: BudgetWindow;
  /** Attempts counted in it. */
  used: number;
  /** Its limit. */
  limit: number;
  /** Attempts left before it is exhausted; never below 0, even over the limit. */
  remaining: number;
  /** Whether it is at or over its limit: nothing is summoned until it resets. */
  exhausted: boolean;
  /** When it resets and its count starts again from 0, epoch ms. */
  resetsAt: number;
  /** The attempts left: `"28 of 30 left this hour"`. */
  left: string;
  /** The attempts used: `"2 of 30 used this hour"`. */
  usedText: string;
  /** When it resets, absolute and in UTC: `"14:00 UTC"`, `"midnight UTC"`. */
  resetAt: string;
}

/** A budget the policy limits. */
export interface BudgetOnView {
  /** The budget is on. */
  state: "on";
  /** The UTC hour. */
  hour: BudgetWindowView;
  /** The UTC day. */
  day: BudgetWindowView;
  /** Whether either window is exhausted. */
  exhausted: boolean;
  /** Both windows' used counts, in one line: `"Used 2 of 30 this hour, 10 of 300 today (UTC)"`. */
  usedText: string;
}

/** A budget the policy turned off: counts, and no limit. */
export interface BudgetOffView {
  /** The budget is off. */
  state: "off";
  /** The counts: `"Off: 41 this hour, 120 today (UTC), no limit"`. */
  text: string;
  /** When the counts reset: `"Counts reset at 14:00 UTC and at midnight UTC"`. */
  resets: string;
}

/**
 * A budget whose limits were never stored (`limitsUnknown`): read from
 * storage, for a queue whose controller runs in another process and has not
 * claimed since it began recording them. The counts are real; the limits are
 * not known here, which is not the same as none.
 */
export interface BudgetUnknownView {
  /** The limits are unknown. */
  state: "unknown";
  /** The counts: `"1 this hour, 1 today (UTC), limits unknown"`. */
  text: string;
  /** Why, and when the counts reset. */
  hint: string;
}

/** A budget in plain words: {@link BudgetOnView}, {@link BudgetOffView} or {@link BudgetUnknownView}. */
export type BudgetView = BudgetOnView | BudgetOffView | BudgetUnknownView;

/** How far ahead a reset may be and still be named by its time of day alone. */
const SAME_DAY_MS = 86_400_000;

/** What each window is called in a sentence. */
const PHRASE: Readonly<Record<BudgetWindow, string>> = {
  hour: "this hour",
  day: "today",
};

/**
 * `ms` as a UTC time of day: `"14:00 UTC"`, or `"midnight UTC"` on the hour
 * a day starts. A reset more than a day away from `now` (or as far behind
 * it: a stale read, a skewed clock) also names its date,
 * `"2026-01-02 14:00 UTC"`, since a time of day alone would mislead.
 */
export function utcResetLabel(ms: number, now: number): string {
  const iso = new Date(ms).toISOString();
  const time = iso.slice(11, 16);
  if (Math.abs(ms - now) >= SAME_DAY_MS) {
    return `${iso.slice(0, 10)} ${time} UTC`;
  }
  return time === "00:00" ? "midnight UTC" : `${time} UTC`;
}

/** One window of a budget that is on. */
export function budgetWindow(
  window: BudgetWindow,
  used: number,
  limit: number,
  resetsAt: number,
  now: number,
): BudgetWindowView {
  const remaining = Math.max(0, limit - used);
  const phrase = PHRASE[window];
  return {
    window,
    used,
    limit,
    remaining,
    exhausted: used >= limit,
    resetsAt,
    left: `${formatNumber(remaining)} of ${formatNumber(limit)} left ${phrase}`,
    usedText: `${formatNumber(used)} of ${formatNumber(limit)} used ${phrase}`,
    resetAt: utcResetLabel(resetsAt, now),
  };
}

/**
 * Whether a budget is off: turned off by the policy, or missing a limit
 * without `limitsUnknown`, which the contract sends only then. A budget whose
 * limits are unknown is not off.
 */
export function budgetOff(budget: SummonBudgetDto): boolean {
  return (
    budget.off === true ||
    (budget.limitsUnknown !== true &&
      (budget.perHour === undefined || budget.perDay === undefined))
  );
}

/** Whether a budget's limits are unknown here (`limitsUnknown`), and it is not off. */
export function budgetLimitsUnknown(budget: SummonBudgetDto): boolean {
  return budget.off !== true && budget.limitsUnknown === true;
}

/**
 * Both windows' used counts in one line, `"Used 2 of 30 this hour, 10 of 300
 * today (UTC)"`; `undefined` for a budget that is off or whose limits are
 * unknown, whose counts are already its whole text.
 */
export function budgetUsedText(budget: SummonBudgetDto): string | undefined {
  if (budgetOff(budget) || budgetLimitsUnknown(budget)) {
    return undefined;
  }
  return `Used ${formatNumber(budget.hour)} of ${formatNumber(budget.perHour ?? 0)} this hour, ${formatNumber(budget.day)} of ${formatNumber(budget.perDay ?? 0)} today (UTC)`;
}

/**
 * A budget in plain words. Off when the policy turned it off (`off: true`),
 * and also when a limit is missing, which the contract sends only then: the
 * counts are shown with no limit rather than against an invented one. With
 * `limitsUnknown` the counts are shown as such, never as off.
 */
export function summonBudgetView(
  budget: SummonBudgetDto,
  now: number,
): BudgetView {
  const resets = `Counts reset at ${utcResetLabel(budget.hourResetsAt, now)} and at ${utcResetLabel(budget.dayResetsAt, now)}`;
  if (budgetLimitsUnknown(budget)) {
    return {
      state: "unknown",
      text: `${formatNumber(budget.hour)} this hour, ${formatNumber(budget.day)} today (UTC), limits unknown`,
      hint: `Its limits are set where its controller runs, and show here after its next summon attempt. ${resets}`,
    };
  }
  if (
    budget.off === true ||
    budget.perHour === undefined ||
    budget.perDay === undefined
  ) {
    // Spelled out rather than `budgetOff()`, so the limits narrow below.
    return {
      state: "off",
      text: `Off: ${formatNumber(budget.hour)} this hour, ${formatNumber(budget.day)} today (UTC), no limit`,
      resets,
    };
  }
  const hour = budgetWindow(
    "hour",
    budget.hour,
    budget.perHour,
    budget.hourResetsAt,
    now,
  );
  const day = budgetWindow(
    "day",
    budget.day,
    budget.perDay,
    budget.dayResetsAt,
    now,
  );
  return {
    state: "on",
    hour,
    day,
    exhausted: hour.exhausted || day.exhausted,
    usedText: budgetUsedText(budget) ?? "",
  };
}
