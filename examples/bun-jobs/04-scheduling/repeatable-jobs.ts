/**
 * Repeatable jobs — intervals, cron (with seconds), windows, limits, and
 * managing a series.
 *
 * ```bash
 * bun 04-scheduling/repeatable-jobs.ts
 * ```
 *
 * `add(name, data, { repeat })` stores a *series*, not a job: a definition
 * plus the next occurrence. Each occurrence is an ordinary job whose id is
 * derived from the series and its due time, so several producers — or several
 * deployments starting at once — adding the same series schedule each
 * occurrence exactly once.
 *
 * Every worker heals series as part of its maintenance, so a series survives
 * every process restarting; `catchUp: true` additionally runs the occurrences
 * missed while nothing was consuming (by default they are skipped).
 */
import { BunQueue, BunQueueWorker, createDriver } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { show, step, title, waitFor } from "../shared/console";

/** What each occurrence carries. */
interface Tick {
  /** Which series it belongs to, for printing. */
  series: string;
}

title("Repeatable jobs");

const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("maintenance");
const queue = new BunQueue<Tick, string>("maintenance", { namespace, driver });

/** How many occurrences of each series have run. */
const ran = new Map<string, number>();

const worker = new BunQueueWorker<Tick, string>(
  "maintenance",
  async (job) => {
    ran.set(job.data.series, (ran.get(job.data.series) ?? 0) + 1);
    show(`${job.data.series} #${ran.get(job.data.series)}`, `job ${job.id}`);
    return "ok";
  },
  { namespace, driver, pollInterval: 25 },
);
void worker.run();

/* ------------------------------------------------------------------ */
step("every: a fixed interval, four times, starting immediately");

const interval = await queue.add(
  "flushMetrics",
  { series: "interval" },
  { repeat: { every: 250, limit: 4, immediately: true } },
);
show("series key (derived from the options)", interval.repeatKey);

/* ------------------------------------------------------------------ */
step("cron: six fields means the first is seconds — every second, 3 times");

await queue.add(
  "rotateLogs",
  { series: "cron" },
  { repeat: { cron: "* * * * * *", tz: "UTC", limit: 3, key: "rotate-logs" } },
);

/* ------------------------------------------------------------------ */
step("startAt / endAt: only inside a window");

const opens = Date.now() + 400;
await queue.add(
  "warmCache",
  { series: "window" },
  { repeat: { every: 200, startAt: opens, endAt: opens + 700 } },
);

/* ------------------------------------------------------------------ */
step("key: re-adding a series with the same key updates it");

await queue.add(
  "vacuum",
  { series: "nightly" },
  { repeat: { cron: "0 3 * * *", tz: "UTC", key: "nightly-vacuum" } },
);
await queue.add(
  "vacuum",
  { series: "nightly" },
  { repeat: { cron: "30 3 * * *", tz: "UTC", key: "nightly-vacuum" } },
);

show(
  "series now stored",
  (await queue.listRepeatables()).map((series) => ({
    key: series.key,
    name: series.name,
    every: series.every,
    cron: series.cron,
    limit: series.limit,
    count: series.count,
    nextRunAt: series.nextRunAt && new Date(series.nextRunAt).toISOString(),
  })),
);

await waitFor(
  "four interval runs, three cron runs, and the window to close",
  () =>
    ran.get("interval") === 4 &&
    ran.get("cron") === 3 &&
    Date.now() > opens + 1_000,
);

show("occurrences run per series", Object.fromEntries(ran));

/* ------------------------------------------------------------------ */
step("removeRepeatable: stop a series and drop its pending occurrence");

show("removed nightly-vacuum", await queue.removeRepeatable("nightly-vacuum"));
show(
  "series left (finished ones stay listed until removed)",
  (await queue.listRepeatables()).map(
    (series) => `${series.key}: ran ${series.count}, next ${series.nextRunAt}`,
  ),
);

await worker.close();
await queue.close();
await driver.purge(namespace);
await driver.close();
