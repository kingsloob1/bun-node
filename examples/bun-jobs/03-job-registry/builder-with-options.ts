/**
 * The job builder — chained, or described as data with `withOptions()`.
 *
 * ```bash
 * bun 03-job-registry/builder-with-options.ts
 * ```
 *
 * `jobs.schedule(name)` answers with a `JobBuilder`. Each method describes one
 * thing; `start()` is the only one that adds anything, so a builder can be
 * passed around and finished elsewhere, or dropped without side effects.
 *
 * `withOptions({...})` says the same things as one object — for when the
 * description is *data*: loaded from a config file, posted by an admin form,
 * stored per tenant. Every field goes through the method of the same name, so
 * `"30 seconds"` or `"every 2 days"` is read identically either way.
 *
 * No worker runs here: the example inspects what was stored.
 */
import type { JobBuilderOptions } from "@kingsleyweb/bun-jobs";
import { BunJobs, ConfigError } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title } from "../shared/console";

/** What a report job carries. */
interface Report {
  /** Which report to build. */
  report: string;
  /** Who receives it. */
  recipients: string[];
}

title("Job builder");

const jobs = new BunJobs({
  namespace: exampleNamespace("reports"),
  driver: exampleDriver(),
});
jobs.define<Report>("buildReport", async () => undefined, { attempts: 2 });

// The registry's queue, to look at what was added.
const registry = jobs.queue<Report>("jobs");

/* ------------------------------------------------------------------ */
step("A chain reads as a sentence");

const chained = await jobs
  .schedule<Report>("buildReport")
  .withData({ report: "revenue", recipients: ["cfo@example.com"] })
  .in("10 minutes")
  .priority(-1)
  .timeout("30 seconds")
  .attempts(5) // overrides the definition's 2
  .backoff({ type: "linear", delay: 2_000, max: 60_000 })
  .unique("revenue-report-2026-09") // id + idempotency key
  .deadLetter("reports-dlq")
  .keepLogs(200)
  .start();

show("stored", {
  id: chained.id,
  state: chained.state,
  runsInMinutes: Math.round((chained.runAt - Date.now()) / 60_000),
  priority: chained.priority,
  opts: chained.opts,
});

/* ------------------------------------------------------------------ */
step("The same, as data — e.g. from a tenant's settings");

/** Report schedules as they might arrive from a config file. */
const fromConfig: { name: string; options: JobBuilderOptions<Report> }[] = [
  {
    name: "buildReport",
    options: {
      data: { report: "signups", recipients: ["growth@example.com"] },
      every: "1 day",
      tz: "Africa/Lagos",
      repeatKey: "daily-signups",
      attempts: 3,
    },
  },
  {
    name: "buildReport",
    options: {
      data: { report: "churn", recipients: ["cs@example.com"] },
      every: "0 8 * * 1", // cron, recognised by its shape: Mondays 08:00
      tz: "UTC",
      repeatKey: "weekly-churn",
      timeout: "2 minutes",
    },
  },
  {
    name: "buildReport",
    options: {
      data: { report: "one-off audit", recipients: ["audit@example.com"] },
      in: "2 hours",
      unique: "audit-2026",
    },
  },
];

for (const { name, options } of fromConfig) {
  await jobs.schedule<Report>(name).withOptions(options).start();
}

show(
  "repeat series",
  (await registry.listRepeatables()).map((series) => ({
    key: series.key,
    every: series.every,
    cron: series.cron,
    tz: series.tz,
    nextRunAt: series.nextRunAt && new Date(series.nextRunAt).toISOString(),
  })),
);

/* ------------------------------------------------------------------ */
step("Chain and options mix; whatever is said last wins");

const mixed = await jobs
  .schedule<Report>("buildReport")
  .withOptions({ data: { report: "draft", recipients: [] }, priority: 5 })
  .priority(1)
  .start();
show("priority", mixed.priority);

/* ------------------------------------------------------------------ */
step("A builder that is never started adds nothing");

const before = await registry.count("delayed");
const unused = jobs.schedule<Report>("buildReport").in("1 hour");
void unused; // described, never started
show("delayed jobs before / after", [before, await registry.count("delayed")]);

/* ------------------------------------------------------------------ */
step("Ambiguity is refused, not guessed at");

for (const options of [
  { in: "5 minutes", delay: 1_000 }, // `in` and `delay` mean the same thing
  { every: "every fortnightish" }, // not an interval, a cron or a phrase
  // A zone is checked against the runtime's zone database as it is given,
  // for an interval series as well as a cron one: Lagos is in Africa/.
  { every: "1 day", tz: "Europe/Lagos" },
] satisfies JobBuilderOptions<Report>[]) {
  let refused = false;
  try {
    await jobs.schedule<Report>("buildReport").withOptions(options).start();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    refused = true;
    show("ConfigError", error.message);
  }
  if (!refused)
    throw new Error(`expected a ConfigError for ${JSON.stringify(options)}`);
}

await jobs.purge();
await jobs.close();
