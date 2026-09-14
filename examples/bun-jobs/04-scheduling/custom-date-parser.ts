/**
 * A custom date parser — teach schedules your own vocabulary.
 *
 * ```bash
 * bun 04-scheduling/custom-date-parser.ts
 * ```
 *
 * `dateParser` replaces `chrono-node` for every queue a context creates. Give
 * one to read words chrono does not know ("payday", "month end", a fiscal
 * calendar), or to avoid installing chrono at all.
 *
 * A parser is synchronous and returns every date it found with *where* it
 * found it. Whatever the results do not cover is what an interval is read
 * from — so `"every 2 weeks from payday"` is the interval `"every 2 weeks"`
 * plus the date `payday`.
 */
import type { DateParser, DateParseResult } from "@kingsleyweb/bun-jobs";
import { BunJobs, ConfigError } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title } from "../shared/console";

title("Custom date parser");

/** The next 25th of a month at 09:00 after `reference`. */
function nextPayday(reference: Date): Date {
  const candidate = new Date(reference);
  candidate.setDate(25);
  candidate.setHours(9, 0, 0, 0);

  if (candidate <= reference) {
    candidate.setMonth(candidate.getMonth() + 1);
  }

  return candidate;
}

/** The last day of `reference`'s month at 18:00, or next month's if passed. */
function monthEnd(reference: Date): Date {
  const end = new Date(
    reference.getFullYear(),
    reference.getMonth() + 1,
    0,
    18,
  );
  return end > reference
    ? end
    : new Date(reference.getFullYear(), reference.getMonth() + 2, 0, 18);
}

/** The words this parser knows, and the date each one means. */
const vocabulary: [word: string, resolve: (reference: Date) => Date][] = [
  ["payday", nextPayday],
  ["month end", monthEnd],
];

const companyCalendar: DateParser = {
  parse(text, reference) {
    const results: DateParseResult[] = [];
    const lower = text.toLowerCase();

    for (const [word, resolve] of vocabulary) {
      const index = lower.indexOf(word);

      if (index >= 0) {
        results.push({
          index,
          // Exactly the characters matched: text.slice(index, index + length).
          text: text.slice(index, index + word.length),
          start: { date: () => resolve(reference) },
        });
      }
    }

    return results;
  },
};

const jobs = new BunJobs({
  namespace: exampleNamespace("payroll"),
  driver: exampleDriver(),
  dateParser: companyCalendar,
});
jobs.define("runPayroll", () => "paid");
jobs.define("closeBooks", () => "closed");

/** A timestamp as local time, for reading. */
const at = (ms: number | null | undefined): string =>
  ms ? new Date(ms).toString().slice(0, 24) : "—";

/* ------------------------------------------------------------------ */
step("One-off jobs on the company's own dates");

const payroll = await jobs.run("runPayroll").on("payday").start();
show('on("payday")', at(payroll.runAt));

const books = await jobs.run("closeBooks").on("month end").start();
show('on("month end")', at(books.runAt));

/* ------------------------------------------------------------------ */
step("A series that starts on one");

await jobs
  .schedule("runPayroll")
  .every("every 2 weeks from payday")
  .withOptions({ repeatKey: "fortnightly-payroll" })
  .start();

const [series] = await jobs.queue("jobs").listRepeatables();
show('every("every 2 weeks from payday")', {
  everyDays: (series?.every ?? 0) / 86_400_000,
  startAt: at(series?.startAt),
  firstRun: at(series?.nextRunAt),
});

/* ------------------------------------------------------------------ */
step("A parser of the wrong shape is refused when the context is built");

try {
  // eslint-disable-next-line no-new
  new BunJobs({
    namespace: "broken",
    dateParser: { parseDate: () => null } as unknown as DateParser,
  });
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  show("ConfigError", error.message.split("\n")[0]);
}

await jobs.purge();
await jobs.close();
