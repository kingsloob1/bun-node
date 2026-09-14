/**
 * Cron and schedule helpers — validate, parse and preview schedules without
 * running anything.
 *
 * ```bash
 * bun 04-scheduling/cron-helpers.ts
 * ```
 *
 * Useful for an admin form that accepts a cron expression ("is this valid,
 * and when would it fire?") and for tests. The runner and repeatable jobs use
 * these same functions, so a preview here is exactly what they will do.
 *
 * Cron here is five fields (minute first) or six (seconds first). A time zone
 * is worth pinning: without one the expression is read in the system zone of
 * whichever host evaluates it.
 */
import {
  nextCronDate,
  nextFireDate,
  normalizeSchedule,
  parseCron,
  validateCron,
} from "@kingsleyweb/bun-jobs";
import { show, step, title } from "../shared/console";

title("Cron and schedule helpers");

/* ------------------------------------------------------------------ */
step("validateCron: is it an expression at all?");

for (const expression of [
  "*/15 * * * *", // every 15 minutes
  "0 9 * * 1-5", // 09:00 on weekdays
  "30 */10 * * * *", // six fields: second 30 of every 10th minute
  "0 0 1 1,4,7,10 *", // quarterly
  "61 * * * *", // minute 61 does not exist
  "every tuesday", // words are not cron
]) {
  show(expression.padEnd(18), validateCron(expression));
}

/* ------------------------------------------------------------------ */
step("parseCron: what it fires on");

const parsed = parseCron("30 */10 * * * *", { tz: "UTC" });
show("parsed", parsed);

/* ------------------------------------------------------------------ */
step("nextCronDate: the next five weekday 09:00s, in two time zones");

const from = new Date();
for (const tz of ["America/New_York", "Asia/Tokyo"]) {
  const upcoming: string[] = [];
  let cursor: Date | null = from;

  while (cursor && upcoming.length < 5) {
    cursor = nextCronDate("0 9 * * 1-5", cursor, { tz });
    if (cursor) upcoming.push(cursor.toISOString());
  }

  show(tz, upcoming);
}

/* ------------------------------------------------------------------ */
step("normalizeSchedule + nextFireDate: every shape a runner accepts");

const inputs = [
  ["cron string", "0 * * * *"],
  ["cron with a zone", { cron: "0 6 * * *", tz: "Africa/Lagos" }],
  ["interval (ms)", 90_000],
  ["interval on a grid", { every: 3_600_000, anchor: new Date("2026-01-01") }],
  ["one-shot Date", new Date(Date.now() + 5 * 60_000)],
  ["manual only", null],
] as const;

for (const [label, input] of inputs) {
  const schedule = normalizeSchedule(input);
  show(label.padEnd(18), {
    normalized: schedule,
    next: nextFireDate(schedule)?.toISOString() ?? null,
  });
}
