/**
 * Schedules in words — "tomorrow at 9am", "every 2 weeks starting next
 * monday", "every day from tomorrow until next month".
 *
 * ```bash
 * bun 04-scheduling/human-schedules.ts
 * ```
 *
 * Durations (`"5 minutes"`, `"1h 30m"`) and cron expressions need nothing
 * extra. Phrases that name *dates* are read by `chrono-node`, an optional peer
 * dependency loaded the first time a phrase needs it (`bun add chrono-node`).
 * Without it, such a phrase fails with a `ConfigError` saying so.
 *
 * Words are read when the job is added, relative to then. A relative start
 * ("starting tomorrow") therefore resolves differently on each run, and since a
 * series is identified by its schedule and start, give it a `repeatKey` when
 * re-adding it should update it rather than create another.
 *
 * No worker runs here: the example prints when things were scheduled for.
 */
import type { Job, RepeatRecord } from "@kingsleyweb/bun-jobs";
import { BunJobs } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title } from "../shared/console";

title("Schedules in words");

const jobs = new BunJobs({
  namespace: exampleNamespace("words"),
  driver: exampleDriver(),
});
jobs.define("sendDigest", () => "sent");
const registry = jobs.queue("jobs");

/** A timestamp as local time, for reading. */
const at = (ms: number | null | undefined): string =>
  ms ? new Date(ms).toString().slice(0, 24) : "—";

/** A millisecond interval as the largest whole unit. */
function interval(ms: number | undefined): string {
  if (ms === undefined) return "—";
  const units: [string, number][] = [
    ["week", 604_800_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  const [unit, size] = units.find(([, size]) => ms % size === 0) ?? ["ms", 1];
  return `${ms / size} ${unit}(s)`;
}

/** Prints a one-off job's run time. */
function printJob(phrase: string, job: Job): void {
  show(`"${phrase}"`, `runs ${at(job.runAt)}`);
}

/** Prints the series stored under `key`. */
async function printSeries(phrase: string, key: string): Promise<void> {
  const series: RepeatRecord | undefined = (
    await registry.listRepeatables()
  ).find((candidate) => candidate.key === key);

  show(`"${phrase}"`, {
    every: series?.cron ?? interval(series?.every),
    startAt: at(series?.startAt),
    endAt: at(series?.endAt),
    firstRun: at(series?.nextRunAt),
  });
}

show("now", at(Date.now()));

/* ------------------------------------------------------------------ */
step("One-off: on(<words>) and in(<duration>)");

for (const phrase of ["tomorrow at 9am", "next friday at 17:30", "in 3 days"]) {
  printJob(phrase, await jobs.run("sendDigest").on(phrase).start());
}
printJob('in("1h 30m")', await jobs.run("sendDigest").in("1h 30m").start());

/* ------------------------------------------------------------------ */
step("Repeating: every(<words>)");

const phrases = [
  "2 days",
  "daily",
  "every monday",
  "0 9 * * 1-5", // cron — recognised by its shape
  "every 2 weeks starting next monday",
  "every day from tomorrow until next month",
];

for (const [index, phrase] of phrases.entries()) {
  const key = `words-${index}`;
  await jobs
    .schedule("sendDigest")
    .every(phrase)
    .withOptions({ repeatKey: key })
    .start();
  await printSeries(phrase, key);
}

/* ------------------------------------------------------------------ */
step("Start and end given separately");

await jobs
  .schedule("sendDigest")
  .every("1 hour")
  .startingAt("tomorrow at 9am")
  .endingAt("tomorrow at 5pm")
  .withOptions({ repeatKey: "office-hours" })
  .start();
await printSeries("every 1 hour, tomorrow 9am–5pm", "office-hours");

// The same vocabulary works on a plain queue's `repeat` option.
await registry.add("sendDigest", undefined, {
  repeat: { every: "3 days", startAt: "next wednesday at noon", key: "raw" },
});
await printSeries(
  "repeat: { every: '3 days', startAt: 'next wednesday at noon' }",
  "raw",
);

/* ------------------------------------------------------------------ */
step("Moving a job with words");

const moved = await (
  await jobs.run("sendDigest").in("1 minute").start()
).reschedule("the day after tomorrow at 8am");
show("rescheduled to", at(moved?.runAt));

await jobs.purge();
await jobs.close();
