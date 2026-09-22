/**
 * Option tour: analytics, worker attribution, and the jobs added in a range —
 * each through the library and through the management API
 * (`createJobsApi`, asked socket-free with `router.fetch`).
 *
 * ```bash
 * bun 10-options/analytics-and-attribution.ts
 * EXAMPLE_DRIVER=file bun 10-options/analytics-and-attribution.ts
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://localhost:6379/13 \
 *   bun 10-options/analytics-and-attribution.ts
 * ```
 *
 * Worth knowing:
 *
 * - **Analytics are counted as things happen**, into one-second and
 *   one-minute buckets, and read back as series over a range. A queue, worker
 *   or runner has no reading method of its own: the library reads them from
 *   the driver (`getQueueMetrics`, `getWorkerMetrics`, …) and the API serves
 *   them on the `/analytics/*` routes and in `/overview`'s `analytics` block.
 * - **Deterministic without sleeping.** Every range here is either resolved
 *   against a fixed `now` (`resolveAnalyticsRange` is a pure function), or
 *   spans the whole tour, so the minute a job happens to settle in does not
 *   matter. Counts are flushed by closing the component that gathered them and
 *   calling `driver.flushMetrics()` — never by waiting a second.
 * - **`processedBy` is new; `workerId` clearing on settle is not.** A job's
 *   `workerId` has always meant "holding it right now" and been `null` once an
 *   attempt settles. `processedBy` is what survives the settle.
 * - **Driver-limited features are asserted, never skipped.** `countAdded()`
 *   and `sort: "createdAt"` exist on memory, SQL and MongoDB only; on file and
 *   Redis the tour asserts the flag, the refusal and the documented fallback.
 *   The file driver keeps minute buckets only, and says so.
 * - **On SQL, attribution is live.** `capabilities.jobAttribution` reads
 *   `false` before `connect()`, and stays `false` on a jobs table an older
 *   version created, until `syncSchema()` adds the four `processed_by_*`
 *   columns (non-blocking). A shared server's example tables can be that old,
 *   so the tour asserts whichever it finds, and syncs.
 * - A runner's series is stored under `runnerKey(id)`, not the bare id, when
 *   read from the driver directly.
 */
import type {
  JobsDriver,
  JobState,
  MetricsSupport,
  SqlDriver,
} from "@kingsleyweb/bun-jobs";
import type {
  AddedByStateDto,
  JobDto,
  MetaDto,
  OverviewDto,
  RunnerAnalyticsDto,
  RunnersAnalyticsDto,
  WorkerAnalyticsDto,
  WorkersAnalyticsDto,
} from "@kingsleyweb/bun-jobs/api/contract";
import process from "node:process";
import { BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  countAddedByScan,
  createDriver,
  createJobsApi,
  DEFAULT_SECOND_RETENTION_MS,
  emptyAddedCounts,
  HOST,
  MAX_ANALYTICS_BUCKETS,
  MAX_ANALYTICS_SERIES,
  MAX_ANALYTICS_SPAN_MS,
  MAX_SECOND_RETENTION_MS,
  metricsSupportOf,
  MIN_ANALYTICS_SPAN_MS,
  MINUTE_BUCKET_MS,
  resolveAnalyticsRange,
  resolveMetricsOptions,
  runnerKey,
  sortByCreated,
  supportsCreatedSort,
} from "@kingsleyweb/bun-jobs";
import { MAX_JOB_FILTER_VALUES } from "@kingsleyweb/bun-jobs/api/contract";
import {
  exampleBackend,
  exampleDriver,
  exampleNamespace,
} from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Option tour: analytics, worker attribution, jobs added in a range");

const backend = exampleBackend();
const namespace = exampleNamespace("tour-analytics");

/** How long to wait for anything a busy server might slow down. */
const LONG = { timeout: 30_000 };

/** The instant the tour started: every "whole tour" range starts here. */
const tourStart = Date.now();

/**
 * The driver every section shares. Its config carries `metrics`, which is
 * where `secondRetentionMs` takes effect: a driver built from a config keeps
 * what the config says, and a driver *instance* passed to a queue, worker or
 * runner keeps whatever it was built with.
 */
const driver = createDriver({
  ...exampleDriver(),
  metrics: { secondRetentionMs: MAX_SECOND_RETENTION_MS },
});

/** The work handler the runners share (it also fails on request). */
const WORK = new URL("./handlers/runner-work.ts", import.meta.url);

/**
 * The same driver with some members hidden or replaced, as a driver written
 * without them would be. Methods are bound to the real driver so its private
 * state still works.
 */
function wrapped(
  real: JobsDriver,
  hide: string[],
  capabilities?: Partial<JobsDriver["capabilities"]>,
): JobsDriver {
  return new Proxy(real, {
    get(target, property) {
      if (hide.includes(property as string)) {
        return undefined;
      }
      if (property === "capabilities" && capabilities) {
        return { ...target.capabilities, ...capabilities };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** What one request through a mounted API answered. */
interface Answer {
  /** The HTTP status. */
  status: number;
  /** The parsed JSON body. */
  body: any;
}

/** Every API mounted, closed at the end. */
const mounted: ReturnType<typeof createJobsApi>[] = [];

/**
 * Mounts an API over a context under `/admin/jobs` and answers a function
 * that sends a GET through it — no socket, the production pipeline.
 */
function mount(
  jobs: BunJobs,
  overrides: Partial<Parameters<typeof createJobsApi>[0]> = {},
) {
  const api = createJobsApi({
    jobs,
    basePath: "/admin/jobs",
    allowUnauthenticated: true,
    logger: noopLogger,
    ...overrides,
  });
  const root = new BunRouter();
  root.use(api.basePath, api.router);
  mounted.push(api);

  return async (path: string): Promise<Answer> => {
    const response = await root.fetch(`/admin/jobs${path}`);
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : undefined,
    };
  };
}

/** A query string from a record; arrays repeat the key. */
function qs(
  params: Record<string, string | number | (string | number)[]>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      search.append(key, String(item));
    }
  }
  return `?${search.toString()}`;
}

/** Waits for the clock to move on, so two adds get different `createdAt`s. */
async function nextMillisecond(after: number): Promise<void> {
  await waitFor("the clock to tick", () => Date.now() > after, { interval: 1 });
}

/* ------------------------------------------------------------------ */
step("SQL: attribution is live, and needs the four processed_by columns");

if (["sqlite", "postgres", "mysql", "mariadb"].includes(backend)) {
  const sql = driver as SqlDriver;
  checkEqual(
    "before connect(), capabilities.jobAttribution reads false",
    sql.capabilities.jobAttribution,
    false,
  );
  await sql.connect();

  /** The planned additions of the four attribution columns. */
  const attributionColumns = async () =>
    (await sql.syncSchema({ dryRun: true }))
      .filter(
        (change) =>
          change.kind === "add-column" &&
          change.target.startsWith("processed_by_"),
      )
      .map((change) => [change.target, change.blocking, change.applied]);

  if (sql.capabilities.jobAttribution === true) {
    checkEqual(
      "a table in the current shape: true once connected, and no columns to add",
      await attributionColumns(),
      [],
    );
  } else {
    // A jobs table an older version created (a shared server's tables outlive
    // the version that made them). Claims run unstamped, and a worker filter
    // is refused rather than answering "that worker ran nothing".
    show("this jobs table predates attribution; syncing it");
    const before = new BunJobs({ namespace, driver: sql, logger: noopLogger });
    await checkRejects(
      "an older table: a workerKey filter is a ConfigError naming syncSchema()",
      () => before.queue("mail").list("completed", { workerKey: "any" }),
      { name: "ConfigError", message: /syncSchema/ },
    );
    await before.close();
    checkEqual(
      "syncSchema({ dryRun: true }) plans the four columns: non-blocking, not applied",
      (await attributionColumns()).sort(),
      [
        ["processed_by_host", false, false],
        ["processed_by_id", false, false],
        ["processed_by_key", false, false],
        ["processed_by_pid", false, false],
      ],
    );
    await sql.syncSchema();
    checkEqual(
      "after syncSchema(), the capability turns true in this process",
      sql.capabilities.jobAttribution,
      true,
    );
  }
} else {
  checkEqual(
    `${backend}: attribution is always recorded`,
    driver.capabilities.jobAttribution,
    true,
  );
}

/* ------------------------------------------------------------------ */
step("The metrics option: defaults, caps, and what a backend can do");

{
  const defaults = resolveMetricsOptions();
  checkEqual(
    "every field is on by default, per-second buckets kept 5 minutes",
    {
      resolution: defaults.resolution,
      secondRetentionMs: defaults.secondRetentionMs,
      workers: defaults.workers,
      runners: defaults.runners,
      durations: defaults.durations,
    },
    {
      resolution: "second",
      secondRetentionMs: DEFAULT_SECOND_RETENTION_MS,
      workers: true,
      runners: true,
      durations: true,
    },
  );
  checkEqual(
    "DEFAULT_SECOND_RETENTION_MS is 5 minutes",
    DEFAULT_SECOND_RETENTION_MS,
    300_000,
  );
  checkEqual(
    "minute buckets are kept a day",
    defaults.minuteRetentionMs,
    86_400_000,
  );
  checkEqual(
    "secondRetentionMs is floored at a second",
    resolveMetricsOptions({ secondRetentionMs: 10 }).secondRetentionMs,
    1_000,
  );
  checkEqual(
    "… and capped at MAX_SECOND_RETENTION_MS (15 minutes)",
    resolveMetricsOptions({ secondRetentionMs: 3_600_000 }).secondRetentionMs,
    MAX_SECOND_RETENTION_MS,
  );
  checkEqual(
    "resolution: minute turns the per-second buckets off",
    metricsSupportOf(resolveMetricsOptions({ resolution: "minute" }))
      .resolutions,
    [60],
  );
  checkEqual(
    "a backend that cannot keep seconds (the file driver) is left with minutes",
    metricsSupportOf(resolveMetricsOptions({}, { seconds: false })).recording,
    {
      resolution: "minute",
      secondRetentionMs: 0,
      workers: true,
      runners: true,
      durations: true,
    },
  );

  // What the shared driver was built with.
  const support = driver.getMetricsSupport!();
  show("driver.getMetricsSupport()", support);
  if (backend === "file") {
    checkEqual(
      "file: minutes only, whatever the config asked for",
      { resolutions: support.resolutions, retention: support.retentionMs },
      { resolutions: [60], retention: { 60: 86_400_000 } },
    );
  } else {
    checkEqual(
      "the config's secondRetentionMs reached the driver",
      { resolutions: support.resolutions, retention: support.retentionMs },
      {
        resolutions: [1, 60],
        retention: { 1: MAX_SECOND_RETENTION_MS, 60: 86_400_000 },
      },
    );
  }
}

/* ------------------------------------------------------------------ */
step("Ranges: resolved against a fixed now, so every answer is exact");

{
  /** A fixed instant, a minute boundary, so bucket starts are round. */
  const now = Date.UTC(2026, 8, 21, 10, 0, 0);
  const seconds: MetricsSupport = metricsSupportOf(resolveMetricsOptions());
  const minutes: MetricsSupport = metricsSupportOf(
    resolveMetricsOptions({}, { seconds: false }),
  );
  const min = (n: number) => n * MINUTE_BUCKET_MS;

  const five = resolveAnalyticsRange(
    { from: now - min(5), to: now, resolution: 60, now },
    seconds,
  );
  checkEqual(
    "a 5-minute range at 60 s is 5 buckets; to is the LAST bucket's start, end the exclusive end",
    {
      resolution: five.resolution,
      count: five.count,
      from: five.from,
      to: five.to,
      end: five.end,
      clamped: five.clamped,
    },
    {
      resolution: 60,
      count: 5,
      from: now - min(5),
      to: now - min(1),
      end: now,
      clamped: false,
    },
  );

  const finest = resolveAnalyticsRange(
    { from: now - min(5), to: now, now },
    seconds,
  );
  checkEqual(
    "no resolution asked: the finest kept for the whole span (1 s, 300 buckets)",
    [finest.resolution, finest.count, finest.clamped],
    [1, 300, false],
  );

  const ten = resolveAnalyticsRange(
    { from: now - min(10), to: now, resolution: 1, now },
    seconds,
  );
  checkEqual(
    "10 minutes at 1 s with 5-minute retention: served at 60 s, reason retention",
    [ten.resolution, ten.clamped, ten.reason],
    [60, true, "retention"],
  );

  const day = 86_400_000;

  // Retention is compared by BUCKET, not by instant: a range is short of
  // retention only when the bucket its `from` falls in is gone. So "the last
  // 24 hours" against 24 h of minute buckets is served whole — even when the
  // client's clock runs a few ms behind the server's.
  /** The fields that say whether, and why, a range was clamped. */
  const verdict = (range: ReturnType<typeof resolveAnalyticsRange>) => ({
    resolution: range.resolution,
    from: range.from,
    count: range.count,
    clamped: range.clamped,
    reason: range.reason,
  });
  checkEqual(
    "exactly 24 h at 60 s, with 24 h retention: not clamped, no reason",
    verdict(
      resolveAnalyticsRange(
        { from: now - day, to: now, resolution: 60, now },
        seconds,
      ),
    ),
    {
      resolution: 60,
      from: now - day,
      count: 1_440,
      clamped: false,
      reason: undefined,
    },
  );
  {
    // Half a minute past a boundary: `from` and the oldest instant kept fall
    // in the same bucket, which is served, so an unaligned span touches 1,441.
    const off = now + 30_000;
    checkEqual(
      "exactly 24 h from an unaligned start: not clamped; first bucket = from's bucket",
      verdict(
        resolveAnalyticsRange(
          { from: off - day, to: off, resolution: 60, now: off },
          seconds,
        ),
      ),
      {
        resolution: 60,
        from: now - day,
        count: 1_441,
        clamped: false,
        reason: undefined,
      },
    );
    checkEqual(
      "… and with the client's clock 5 ms behind (from before the oldest instant kept, same bucket)",
      verdict(
        resolveAnalyticsRange(
          { from: off - 5 - day, to: off - 5, resolution: 60, now: off },
          seconds,
        ),
      ),
      {
        resolution: 60,
        from: now - day,
        count: 1_441,
        clamped: false,
        reason: undefined,
      },
    );
    // The same 5 ms two milliseconds after a boundary puts `from` in the
    // bucket before, which retention has already dropped: that one IS clamped.
    checkEqual(
      "5 ms behind across a bucket boundary: from's bucket is gone, clamped (retention)",
      verdict(
        resolveAnalyticsRange(
          {
            from: now + 2 - 5 - day,
            to: now - 3,
            resolution: 60,
            now: now + 2,
          },
          seconds,
        ),
      ),
      {
        resolution: 60,
        from: now - day,
        count: 1_440,
        clamped: true,
        reason: "retention",
      },
    );
  }
  checkEqual(
    "just over retention (1 ms): clamped forward, reason retention",
    verdict(
      resolveAnalyticsRange(
        { from: now - day - 1, to: now, resolution: 60, now },
        seconds,
      ),
    ),
    {
      resolution: 60,
      from: now - day,
      count: 1_440,
      clamped: true,
      reason: "retention",
    },
  );
  checkEqual(
    "24 h with no resolution named: served at 60 s, but clamped — 1 s was not kept that long",
    verdict(resolveAnalyticsRange({ from: now - day, to: now, now }, seconds)),
    {
      resolution: 60,
      from: now - day,
      count: 1_440,
      clamped: true,
      reason: "retention",
    },
  );
  checkEqual(
    "… while a backend keeping minutes only serves the same request unclamped",
    verdict(resolveAnalyticsRange({ from: now - day, to: now, now }, minutes)),
    {
      resolution: 60,
      from: now - day,
      count: 1_440,
      clamped: false,
      reason: undefined,
    },
  );

  const partly = resolveAnalyticsRange(
    { from: now - day - min(60), to: now - day + min(60), resolution: 60, now },
    seconds,
  );
  check(
    "partly older than a day: from moved forward to what is kept, reason retention",
    partly.reason === "retention" &&
      partly.from > partly.requested.from &&
      partly.from >= partly.retainedFrom - MINUTE_BUCKET_MS &&
      !partly.outOfRetention,
    partly,
  );

  const gone = resolveAnalyticsRange(
    { from: now - 2 * day, to: now - day - min(60), resolution: 60, now },
    seconds,
  );
  checkEqual(
    "wholly older than a day: outOfRetention (the API's 400 RANGE_NOT_RETAINED)",
    [gone.outOfRetention, gone.retainedFrom],
    [true, now - day],
  );

  const capped = resolveAnalyticsRange(
    { from: now - min(2), to: now, now, maxBuckets: 10 },
    seconds,
  );
  checkEqual(
    "more buckets than allowed at 1 s: coarser, reason maxBuckets",
    [capped.resolution, capped.count, capped.reason],
    [60, 2, "maxBuckets"],
  );
  checkEqual("MAX_ANALYTICS_BUCKETS", MAX_ANALYTICS_BUCKETS, 1_500);

  const busy = resolveAnalyticsRange(
    { from: now - min(5), to: now, resolution: 1, now, minIntervalMs: 10_000 },
    seconds,
  );
  checkEqual(
    "a series sampled every 10 s (busyness) asked for 1 s: reason resolution",
    [busy.resolution, busy.reason],
    [60, "resolution"],
  );

  const file = resolveAnalyticsRange(
    { from: now - min(5), to: now, resolution: 1, now },
    minutes,
  );
  checkEqual(
    "a backend keeping minutes only asked for 1 s: reason driver",
    [file.resolution, file.reason],
    [60, "driver"],
  );
}

/* ------------------------------------------------------------------ */
step("Recording: two workers on one queue, and a job that moves between them");

const jobs = new BunJobs({
  namespace,
  driver,
  service: "tour",
  logger: noopLogger,
});

/** The queue whose analytics and attribution the tour reads. */
const mail = jobs.queue("mail");

/** Whether a processor should fail this job. */
interface MailData {
  /** Throw on this attempt. */
  fail?: boolean;
}

// Worker A fails whatever asks to; the retry of `flaky` waits an hour, so it
// is still pending when A closes, and worker B runs it.
const workerA = jobs.worker<MailData>(
  "mail",
  async (job) => {
    if (job.data.fail) {
      throw new Error(`A failed ${job.id}`);
    }
    return "sent by A";
  },
  { key: "mail.a", pollInterval: 20, reportInterval: 100 },
);

await mail.addBulk([
  { name: "send", data: {}, opts: { jobId: "ok-1" } },
  { name: "send", data: {}, opts: { jobId: "ok-2" } },
  { name: "send", data: {}, opts: { jobId: "ok-3" } },
  {
    name: "send",
    data: { fail: true },
    opts: {
      jobId: "flaky",
      attempts: 2,
      backoff: { type: "fixed", delay: 3_600_000 },
    },
  },
  {
    name: "send",
    data: { fail: true },
    opts: { jobId: "doomed", attempts: 1 },
  },
  { name: "send", data: {}, opts: { jobId: "later", delay: 3_600_000 } },
]);

void workerA.run();

await waitFor(
  "A to finish its share",
  async () =>
    (await mail.count("completed")) === 3 &&
    (await mail.count("failed")) === 1 &&
    (await mail.count("dead")) === 1,
  LONG,
);

{
  const pending = await mail.getJob("flaky");
  checkEqual(
    "a retry pending: processedBy names the worker whose attempt just failed",
    [pending?.state, pending?.processedBy?.key, pending?.processedBy?.id],
    ["failed", "mail.a", workerA.id],
  );
  checkEqual(
    "… and a failed (retrying) job has no finishedOn: it has not finished",
    pending?.finishedOn ?? null,
    null,
  );
}

// Closing a worker writes the counts it had gathered, so nothing waits a second.
await workerA.close();

const workerB = jobs.worker<MailData>("mail", async () => "sent by B", {
  key: "mail.b",
  pollInterval: 20,
  reportInterval: 100,
});
void workerB.run();
check(
  "promote() makes the pending retry claimable now",
  await mail.promote("flaky"),
);
await waitFor(
  "B to finish flaky",
  async () => (await mail.getJob("flaky"))?.state === "completed",
  LONG,
);
await workerB.close();

// A worker whose context turns per-worker series off. Its own `metrics` sets
// `resolution` and gives `workers` as undefined — neither undoes the
// context's `workers: false`, since options merge field by field and an
// undefined field hides nothing.
const quietJobs = new BunJobs({
  namespace,
  driver,
  logger: noopLogger,
  metrics: { workers: false },
});
const quiet = quietJobs.queue("quiet");
await quiet.addBulk([
  { name: "q", data: {}, opts: { jobId: "q-1" } },
  { name: "q", data: {}, opts: { jobId: "q-2" } },
]);
const quietWorker = quietJobs.worker("quiet", async () => "done", {
  key: "quiet.w",
  pollInterval: 20,
  reportInterval: 100,
  metrics: { resolution: "minute", workers: undefined },
});
void quietWorker.run();
await waitFor(
  "the quiet worker's heartbeat record to count both jobs",
  async () =>
    (await quiet.listWorkers()).some(
      (info) => info.key === "quiet.w" && info.completed === 2,
    ),
  LONG,
);
check(
  "the heartbeat record's completed/failed are written whatever metrics says",
  (await quiet.listWorkers()).some(
    (info) =>
      info.key === "quiet.w" && info.completed === 2 && info.failed === 0,
  ),
);
await quietWorker.close();

/* ------------------------------------------------------------------ */
step("Recording: a runner's runs, by outcome, with durations");

const report = jobs.runner({
  id: "report",
  file: WORK,
  executionMode: "in-process",
  logger: noopLogger,
});
const slow = jobs.runner({
  id: "slow",
  file: WORK,
  executionMode: "in-process",
  timeout: 50,
  logger: noopLogger,
});
// Runner series off for this one: its runs are counted in stats() only.
const unrecorded = jobs.runner({
  id: "unrecorded",
  file: WORK,
  executionMode: "in-process",
  logger: noopLogger,
  metrics: { runners: false, durations: false },
});

/** Triggers one run and waits for it to settle. */
async function runOnce(
  runner: typeof report,
  args: { ms?: number; fail?: string },
): Promise<void> {
  const before = (await runner.stats()).total;
  const outcome = await runner.trigger({ args });
  check(
    `${runner.id}: a trigger started a run`,
    outcome.outcome === "started",
    outcome,
  );
  await waitFor(
    `${runner.id} to settle a run`,
    async () => {
      const stats = await runner.stats();
      return (
        stats.total > before && stats.success + stats.failed === stats.total
      );
    },
    LONG,
  );
}

await runOnce(report, {});
await runOnce(report, {});
await runOnce(report, { fail: "boom" });
await runOnce(slow, { ms: 5_000 });
await runOnce(unrecorded, {});

{
  const stats = await slow.stats();
  checkEqual(
    "stats().failed counts a timeout as a failure too (a series does not)",
    [stats.failed, stats.timeout],
    [1, 1],
  );
}

// Everything gathered is written: the workers already closed, so the rest is
// whatever the driver still buffers (SQL, MongoDB, Redis's roll-up).
await driver.flushMetrics?.();

/* ------------------------------------------------------------------ */
step("Reading through the library: the driver's analytics reads");

/** Buckets covering the whole tour at 60 s, as the API would resolve them. */
const tourRange = () =>
  resolveAnalyticsRange(
    {
      from: tourStart - MINUTE_BUCKET_MS,
      to: Date.now() + MINUTE_BUCKET_MS,
      resolution: 60,
      now: Date.now(),
    },
    driver.getMetricsSupport!(),
  );

/** Adds up counter buckets. */
function sum<K extends string>(
  buckets: readonly (Partial<Record<K, number>> & { at: number })[],
  keys: readonly K[],
): Record<K, number> {
  const totals = Object.fromEntries(keys.map((key) => [key, 0])) as Record<
    K,
    number
  >;
  for (const bucket of buckets) {
    for (const key of keys) {
      totals[key] += bucket[key] ?? 0;
    }
  }
  return totals;
}

{
  const range = tourRange();
  const query = { from: range.from, to: range.to, interval: range.interval };
  const JOBS = ["completed", "failed"] as const;

  checkEqual(
    "queue series: 4 completed, 2 failed ATTEMPTS (flaky's first, doomed's only)",
    sum(
      await driver.getQueueMetrics!({ ns: namespace, queue: "mail" }, query),
      JOBS,
    ),
    { completed: 4, failed: 2 },
  );
  checkEqual(
    "the queue series counts the quiet queue too: the driver writes it, not the worker",
    sum(
      await driver.getQueueMetrics!({ ns: namespace, queue: "quiet" }, query),
      JOBS,
    ),
    { completed: 2, failed: 0 },
  );
  checkEqual(
    "worker A, by its stable key: 3 completed, 2 failed attempts",
    sum(
      (
        await driver.getWorkerMetrics!(
          { ns: namespace, queue: "mail" },
          "mail.a",
          query,
        )
      ).jobs,
      JOBS,
    ),
    { completed: 3, failed: 2 },
  );
  checkEqual(
    "worker B: the retry it completed",
    sum(
      (
        await driver.getWorkerMetrics!(
          { ns: namespace, queue: "mail" },
          "mail.b",
          query,
        )
      ).jobs,
      JOBS,
    ),
    { completed: 1, failed: 0 },
  );
  checkEqual(
    "metrics.workers false (from the context) recorded no worker series",
    sum(
      (
        await driver.getWorkerMetrics!(
          { ns: namespace, queue: "quiet" },
          "quiet.w",
          query,
        )
      ).jobs,
      JOBS,
    ),
    { completed: 0, failed: 0 },
  );

  const busy = await driver.getWorkerMetrics!(
    { ns: namespace, queue: "mail" },
    "mail.a",
    { ...query, busyness: true },
  );
  check(
    "busyness: sampled on A's heartbeat reports, concurrency 1",
    (busy.busyness ?? []).some(
      (bucket) => bucket.samples > 0 && bucket.concurrency === 1,
    ),
    busy.busyness,
  );

  const RUNS = [
    "started",
    "succeeded",
    "failed",
    "timeout",
    "killed",
    "skipped",
  ] as const;
  // A runner's series is stored under its runner key, `runnerKey(id)`, as
  // everything else about it is — not under the bare id.
  const reportRead = await driver.getRunnerMetrics!(
    namespace,
    runnerKey("report"),
    {
      ...query,
      durations: true,
    },
  );
  checkEqual(
    "runner series: 3 started, 2 succeeded, 1 failed (threw)",
    sum(reportRead.runs, RUNS),
    { started: 3, succeeded: 2, failed: 1, timeout: 0, killed: 0, skipped: 0 },
  );
  checkEqual(
    "durations: one per finished run",
    (reportRead.durations ?? []).reduce(
      (total, bucket) => total + bucket.count,
      0,
    ),
    3,
  );
  checkEqual(
    "a timeout counts in timeout only, not in failed",
    sum(
      (await driver.getRunnerMetrics!(namespace, runnerKey("slow"), query))
        .runs,
      RUNS,
    ),
    { started: 1, succeeded: 0, failed: 0, timeout: 1, killed: 0, skipped: 0 },
  );
  checkEqual(
    "metrics.runners false on a runner: nothing recorded for it",
    sum(
      (
        await driver.getRunnerMetrics!(
          namespace,
          runnerKey("unrecorded"),
          query,
        )
      ).runs,
      RUNS,
    ),
    { started: 0, succeeded: 0, failed: 0, timeout: 0, killed: 0, skipped: 0 },
  );

  const rollup = await driver.getNamespaceMetrics!(namespace, {
    ...query,
    kinds: ["jobs", "runs", "workerJobs"],
  });
  checkEqual(
    "namespace roll-up: every queue, every recorded runner, every recorded worker",
    {
      jobs: sum(rollup.jobs ?? [], JOBS),
      runs: sum(rollup.runs ?? [], RUNS),
      workerJobs: sum(rollup.workerJobs ?? [], JOBS),
    },
    {
      jobs: { completed: 6, failed: 2 },
      runs: {
        started: 4,
        succeeded: 2,
        failed: 1,
        timeout: 1,
        killed: 0,
        skipped: 0,
      },
      workerJobs: { completed: 4, failed: 2 },
    },
  );
}

/* ------------------------------------------------------------------ */
step("The analytics routes");

const get = mount(jobs);
/** The whole tour, as a request range: epoch ms, `to` exclusive. */
const whole = () => ({
  from: tourStart - MINUTE_BUCKET_MS,
  to: Date.now() + MINUTE_BUCKET_MS,
  resolution: 60,
});

{
  const meta = (await get("/meta")).body as MetaDto;
  show("meta.analytics", meta.analytics);
  checkEqual(
    "meta.analytics: what the backend serves, and what is recorded",
    {
      resolutions: meta.analytics?.resolutions,
      maxSpanMs: meta.analytics?.maxSpanMs,
      maxBuckets: meta.analytics?.maxBuckets,
      maxSeries: meta.analytics?.maxSeries,
      recording: meta.analytics?.recording,
    },
    {
      resolutions: backend === "file" ? [60] : [1, 60],
      maxSpanMs: MAX_ANALYTICS_SPAN_MS,
      maxBuckets: MAX_ANALYTICS_BUCKETS,
      maxSeries: MAX_ANALYTICS_SERIES,
      recording: {
        resolution: backend === "file" ? "minute" : "second",
        secondRetentionMs: backend === "file" ? 0 : MAX_SECOND_RETENTION_MS,
        workers: true,
        runners: true,
        durations: true,
      },
    },
  );
  checkEqual(
    "features: runner and worker metrics, and attribution, on every built-in driver",
    [
      meta.features.runnerMetrics,
      meta.features.workerMetrics,
      meta.features.jobAttribution,
    ],
    [true, true, true],
  );

  const queueSeries = await get(`/queues/mail/analytics/jobs${qs(whole())}`);
  checkEqual(
    "GET /queues/mail/analytics/jobs: the same totals the driver read",
    [queueSeries.status, queueSeries.body.totals],
    [200, { completed: 4, failed: 2 }],
  );
  const range = queueSeries.body.range;
  check(
    "range: contiguous buckets from range.from to range.to (the last start); end = to + interval",
    range.end === range.to + range.interval &&
      queueSeries.body.buckets.length ===
        (range.to - range.from) / range.interval + 1 &&
      queueSeries.body.buckets[0].at === range.from,
    range,
  );

  checkEqual(
    "GET /analytics/jobs: the namespace roll-up",
    (await get(`/analytics/jobs${qs(whole())}`)).body.totals,
    { completed: 6, failed: 2 },
  );

  const workers = (
    await get(`/analytics/workers${qs({ ...whole(), keys: "mail.a,mail.b" })}`)
  ).body as WorkersAnalyticsDto;
  checkEqual(
    "GET /analytics/workers: rows by completed, then key; summed series",
    {
      series: workers.series.totals,
      rows: workers.rows
        .filter((row) => row.queue === "mail")
        .map((row) => [row.key, row.totals.completed, row.totals.failed]),
    },
    {
      series: { completed: 4, failed: 2 },
      rows: [
        ["mail.a", 3, 2],
        ["mail.b", 1, 0],
      ],
    },
  );
  checkEqual(
    "?keys= comes back in seriesByKey, in the order asked",
    workers.seriesByKey?.map((entry) => [
      entry.key,
      entry.jobs.totals.completed,
    ]),
    [
      ["mail.a", 3],
      ["mail.b", 1],
    ],
  );

  const one = (await get(`/queues/mail/analytics/workers/mail.a${qs(whole())}`))
    .body as WorkerAnalyticsDto;
  checkEqual("GET …/analytics/workers/mail.a: jobs", one.jobs.totals, {
    completed: 3,
    failed: 2,
  });
  check(
    "… and busyness, on its own range, never finer than the heartbeat",
    one.busyness !== undefined &&
      one.busyness.range.interval >= 10_000 &&
      one.busyness.totals.samples > 0,
    one.busyness,
  );
  const nobody = await get(
    `/queues/mail/analytics/workers/nobody${qs(whole())}`,
  );
  checkEqual(
    "an unknown worker key reads as zeros, not 404",
    [nobody.status, nobody.body.jobs.totals],
    [200, { completed: 0, failed: 0 }],
  );

  const runner = (await get(`/runners/report/analytics${qs(whole())}`))
    .body as RunnerAnalyticsDto;
  checkEqual(
    "GET /runners/report/analytics: runs, durations, and runningNow",
    [runner.runs.totals, runner.durations?.totals.count, runner.runningNow],
    [
      {
        started: 3,
        succeeded: 2,
        failed: 1,
        timeout: 0,
        killed: 0,
        skipped: 0,
      },
      3,
      0,
    ],
  );
  const runners = (
    await get(
      `/analytics/runners${qs({ ...whole(), ids: ["report", "slow"] })}`,
    )
  ).body as RunnersAnalyticsDto;
  checkEqual(
    "GET /analytics/runners: rows sorted by runs started; ?ids= in seriesByRunner",
    {
      series: runners.series.totals.started,
      rows: runners.rows.map((row) => [row.runner, row.totals.started]),
      batch: runners.seriesByRunner?.map((entry) => entry.runner),
    },
    {
      series: 4,
      rows: [
        ["report", 3],
        ["slow", 1],
        ["unrecorded", 0],
      ],
      batch: ["report", "slow"],
    },
  );

  const overview = (await get(`/overview${qs(whole())}`)).body as OverviewDto;
  checkEqual(
    "GET /overview: the analytics block (range, jobs, and the grouped runners and workers)",
    {
      resolution: overview.analytics?.range.resolution,
      jobs: overview.analytics?.jobs.totals,
      runners: overview.analytics?.runners?.series.totals.started,
      workers: overview.analytics?.workers?.series.totals,
    },
    {
      resolution: 60,
      jobs: { completed: 6, failed: 2 },
      runners: 4,
      workers: { completed: 4, failed: 2 },
    },
  );
}

/* ------------------------------------------------------------------ */
step("The analytics routes: every range rule");

{
  const now = Date.now();
  const min = (n: number) => n * MINUTE_BUCKET_MS;
  const day = 86_400_000;

  const five = (
    await get(
      `/analytics/jobs${qs({ from: now - min(5), to: now, resolution: 1 })}`,
    )
  ).body.range;
  if (backend === "file") {
    checkEqual(
      "file: 1 s asked, a minute served, reason driver",
      [five.resolution, five.clamped, five.reason],
      [60, true, "driver"],
    );
  } else {
    checkEqual(
      "5 minutes at 1 s: served as asked",
      [five.resolution, five.clamped],
      [1, false],
    );
  }

  const twenty = (
    await get(
      `/analytics/jobs${qs({ from: now - min(20), to: now, resolution: 1 })}`,
    )
  ).body.range;
  checkEqual(
    "20 minutes at 1 s, past the 15-minute retention: a minute, clamped",
    [twenty.resolution, twenty.clamped, twenty.reason],
    [60, true, backend === "file" ? "driver" : "retention"],
  );

  const partly = (
    await get(
      `/analytics/jobs${qs({ from: now - day - min(60), to: now - day + min(60) })}`,
    )
  ).body.range;
  check(
    "partly older than a day: clamped forward, reason retention",
    partly.clamped &&
      partly.reason === "retention" &&
      partly.from > partly.requested.from,
    partly,
  );

  const gone = await get(
    `/analytics/jobs${qs({ from: now - 2 * day, to: now - day - min(60) })}`,
  );
  check(
    "wholly older: 400 RANGE_NOT_RETAINED with context.retainedFrom and resolution",
    gone.status === 400 &&
      gone.body.code === "RANGE_NOT_RETAINED" &&
      typeof gone.body.context?.retainedFrom === "number" &&
      gone.body.context?.resolution === 60,
    gone,
  );

  // On minute boundaries, a 5-minute range at 60 s is exactly 5 buckets; an
  // unaligned one touches 6, since each end is floored to its bucket.
  const minute = Math.floor(now / MINUTE_BUCKET_MS) * MINUTE_BUCKET_MS;
  const iso = await get(
    `/queues/mail/analytics/jobs${qs({ from: new Date(minute - min(5)).toISOString(), to: new Date(minute).toISOString(), resolution: 60 })}`,
  );
  checkEqual(
    "RFC 3339 bounds, on minute boundaries: 5 buckets, the last starting a minute before to",
    [
      iso.status,
      iso.body.buckets.length,
      iso.body.range.to,
      iso.body.range.end,
    ],
    [200, 5, minute - min(1), minute],
  );

  const refused: [string, string, string][] = [
    ["resolution=5", qs({ resolution: 5 }), "VALIDATION"],
    ["to not after from", qs({ from: now, to: now }), "INVALID_ARGUMENT"],
    [
      "a span over a day",
      qs({ from: now - 2 * day, to: now }),
      "INVALID_ARGUMENT",
    ],
    [
      "a span under a second",
      qs({ from: now - 500, to: now }),
      "INVALID_ARGUMENT",
    ],
  ];
  for (const [label, query, code] of refused) {
    const answer = await get(`/analytics/jobs${query}`);
    checkEqual(
      `${label}: 400 ${code}`,
      [answer.status, answer.body.code],
      [400, code],
    );
  }

  const many = Array.from(
    { length: MAX_ANALYTICS_SERIES + 1 },
    (_, i) => `r${i}`,
  );
  const bulk = await get(`/analytics/runners${qs({ ids: many.join(",") })}`);
  checkEqual(
    `${MAX_ANALYTICS_SERIES + 1} ids: 400 BULK_LIMIT`,
    [bulk.status, bulk.body.code],
    [400, "BULK_LIMIT"],
  );
}

{
  // A driver without the three base analytics methods serves no analytics:
  // every analytics route is pruned (a JSON 404, never a 501).
  const plainJobs = new BunJobs({
    namespace,
    driver: wrapped(driver, [
      "getMetricsSupport",
      "getNamespaceMetrics",
      "getQueueMetrics",
    ]),
    logger: noopLogger,
  });
  plainJobs.queue("mail");
  const plain = mount(plainJobs);
  const meta = (await plain("/meta")).body as MetaDto;
  checkEqual(
    "a driver without analytics: meta.analytics null, runner/worker metrics off",
    [meta.analytics, meta.features.runnerMetrics, meta.features.workerMetrics],
    [null, false, false],
  );
  const pruned = await plain("/analytics/jobs");
  checkEqual(
    "… and /analytics/jobs is 404 ROUTE_NOT_FOUND",
    [pruned.status, pruned.body.code],
    [404, "ROUTE_NOT_FOUND"],
  );
  checkEqual(
    "… and /overview has no analytics block",
    ((await plain("/overview")).body as OverviewDto).analytics,
    undefined,
  );
  await plainJobs.close();
}

/* ------------------------------------------------------------------ */
step("Worker attribution: processedBy, through the library");

{
  checkEqual(
    "every built-in driver records attribution (SQL once connect confirmed the columns)",
    driver.capabilities.jobAttribution,
    true,
  );

  const flaky = await mail.getJob("flaky");
  checkEqual(
    "failed on A, completed on B: processedBy names B alone (the last attempt)",
    flaky?.processedBy,
    { id: workerB.id, key: "mail.b", host: HOST, pid: process.pid },
  );
  checkEqual(
    "workerId is null once the attempt settled — as it always has been; processedBy is the new part",
    flaky?.workerId,
    null,
  );
  checkEqual(
    "a job that died on A keeps A's stamp",
    [
      (await mail.getJob("doomed"))?.state,
      (await mail.getJob("doomed"))?.processedBy?.key,
    ],
    ["dead", "mail.a"],
  );
  checkEqual(
    "a job never claimed has processedBy null",
    (await mail.getJob("later"))?.processedBy,
    null,
  );

  const ids = async (
    states: JobState | JobState[],
    options: Parameters<typeof mail.list>[1],
  ) => (await mail.list(states, options)).map((job) => job.id).sort();

  checkEqual(
    "list({ workerKey }): the jobs whose last attempt that key ran",
    await ids("completed", { workerKey: "mail.a" }),
    ["ok-1", "ok-2", "ok-3"],
  );
  checkEqual(
    "workerKey as an array, across states",
    await ids(["completed", "dead"], { workerKey: ["mail.a", "mail.b"] }),
    ["doomed", "flaky", "ok-1", "ok-2", "ok-3"],
  );
  checkEqual(
    "workerId: by incarnation",
    await ids(["completed", "dead"], { workerId: workerB.id }),
    ["flaky"],
  );
  checkEqual(
    "an empty array matches nothing",
    await ids("completed", { workerKey: [] }),
    [],
  );

  const page = await mail.page(["completed", "dead"], {
    workerKey: "mail.a",
    limit: 2,
  });
  checkEqual(
    "page(): the filter narrows before the page is cut, so total counts matches",
    [page.jobs.length, page.total],
    [2, 4],
  );

  // finishedOn ranges: [from, to), on completed and dead jobs only. The
  // expected set is read off the jobs themselves, so the millisecond each
  // happened to finish in does not matter.
  const finished = await mail.list(["completed", "dead"], { limit: 100 });
  const at = flaky!.finishedOn!;
  const expected = finished
    .filter((job) => job.finishedOn === at)
    .map((job) => job.id)
    .sort();
  checkEqual(
    "finishedFrom (inclusive) / finishedTo (exclusive): a 1 ms window",
    await ids(["completed", "dead"], { finishedFrom: at, finishedTo: at + 1 }),
    expected,
  );
  check("… which holds flaky", expected.includes("flaky"), expected);
  checkEqual(
    "a range with a key: B's completions since flaky finished",
    await ids("completed", { workerKey: "mail.b", finishedFrom: new Date(at) }),
    ["flaky"],
  );
  checkEqual(
    "a range never matches a state without finishedOn",
    await ids(["failed", "delayed", "waiting"], { finishedFrom: tourStart }),
    [],
  );

  await checkRejects(
    "finishedTo equal to finishedFrom: ConfigError, not an empty page",
    () => mail.list("completed", { finishedFrom: at, finishedTo: at }),
    { name: "ConfigError" },
  );
  await checkRejects(
    "a bound that is not a date: ConfigError",
    () => mail.list("completed", { finishedFrom: new Date("not a date") }),
    { name: "ConfigError" },
  );

  // A driver that does not declare the capability: the worker filters are
  // refused (there is no stamp to match), a finishedOn range is answered by a
  // scan, which is correct but linear.
  const blind = wrapped(driver, [], { jobAttribution: false });
  const blindJobs = new BunJobs({
    namespace,
    driver: blind,
    logger: noopLogger,
  });
  const blindMail = blindJobs.queue("mail");
  await checkRejects(
    "no jobAttribution: a workerKey filter is a ConfigError",
    () => blindMail.list("completed", { workerKey: "mail.a" }),
    { name: "ConfigError", message: /syncSchema/ },
  );
  checkEqual(
    "… while a finishedOn range still answers, by scan",
    (
      await blindMail.list(["completed", "dead"], {
        finishedFrom: at,
        finishedTo: at + 1,
      })
    )
      .map((job) => job.id)
      .sort(),
    expected,
  );

  step("Worker attribution: through the API");

  const flakyDto = (await get("/queues/mail/jobs/flaky")).body as JobDto;
  checkEqual(
    "JobDto.processedBy, host and pid included by default",
    [flakyDto.processedBy, flakyDto.workerId],
    [{ id: workerB.id, key: "mail.b", host: HOST, pid: process.pid }, null],
  );
  const hidden = mount(jobs, { serialize: { exposeHosts: false } });
  checkEqual(
    "serialize.exposeHosts false: host and pid hidden (still stored)",
    ((await hidden("/queues/mail/jobs/flaky")).body as JobDto).processedBy,
    { id: workerB.id, key: "mail.b" },
  );

  const listed = async (query: string) => {
    const answer = await get(`/queues/mail/jobs${query}`);
    return answer.status === 200
      ? (answer.body.items as JobDto[]).map((job) => job.id).sort()
      : answer;
  };
  checkEqual(
    "?workerKey= filters the job list",
    await listed(qs({ state: "completed", workerKey: "mail.a" })),
    ["ok-1", "ok-2", "ok-3"],
  );
  checkEqual(
    "?workerId= repeated, and finishedFrom/finishedTo",
    await listed(
      qs({
        state: ["completed", "dead"],
        workerId: [workerA.id, workerB.id],
        finishedFrom: at,
        finishedTo: at + 1,
      }),
    ),
    expected,
  );
  const inverted = await get(
    `/queues/mail/jobs${qs({ state: "completed", finishedFrom: at, finishedTo: at })}`,
  );
  checkEqual(
    "finishedTo not after finishedFrom: 400 INVALID_ARGUMENT",
    [inverted.status, inverted.body.code],
    [400, "INVALID_ARGUMENT"],
  );
  const tooMany = Array.from(
    { length: MAX_JOB_FILTER_VALUES + 1 },
    (_, i) => `k${i}`,
  );
  const capped = await get(
    `/queues/mail/jobs${qs({ workerKey: tooMany.join(",") })}`,
  );
  checkEqual(
    `${MAX_JOB_FILTER_VALUES + 1} workerKey values: 400 (the API's cap; the library takes any number)`,
    capped.status,
    400,
  );
  checkEqual(
    "the library takes the same list",
    await ids("completed", { workerKey: [...tooMany, "mail.b"] }),
    ["flaky"],
  );

  const blindGet = mount(blindJobs);
  checkEqual(
    "no jobAttribution: features.jobAttribution false in /meta",
    ((await blindGet("/meta")).body as MetaDto).features.jobAttribution,
    false,
  );
  const blindAnswer = await blindGet(
    `/queues/mail/jobs${qs({ state: "completed", workerKey: "mail.a" })}`,
  );
  check(
    "… and ?workerKey= is 400 INVALID_ARGUMENT, naming syncSchema()",
    blindAnswer.status === 400 &&
      blindAnswer.body.code === "INVALID_ARGUMENT" &&
      /syncSchema/.test(blindAnswer.body.detail ?? ""),
    blindAnswer,
  );
  await blindJobs.close();
}

/* ------------------------------------------------------------------ */
step("Jobs added in a range, and sort: createdAt");

{
  const arrivals = jobs.queue("arrivals");
  // Added one at a time, a millisecond apart, so each createdAt is distinct —
  // and the delays run the other way, so a delayed job's natural order (by
  // runAt) is the reverse of its creation order.
  const addedFrom = Date.now();
  const added: { id: string; delay?: number }[] = [
    { id: "w-3" },
    { id: "w-2" },
    { id: "w-1" },
    { id: "d-late", delay: 7_200_000 },
    { id: "d-soon", delay: 3_600_000 },
  ];
  for (const entry of added) {
    const job = await arrivals.add(
      "arrive",
      {},
      {
        jobId: entry.id,
        ...(entry.delay ? { delay: entry.delay } : {}),
      },
    );
    await nextMillisecond(job.createdAt);
  }
  const addedTo = Date.now();
  await arrivals.add("arrive", { again: true }, { jobId: "w-3" });

  const supported = supportsCreatedSort(driver);
  const get2 = get;
  const meta = (await get2("/meta")).body as MetaDto;
  checkEqual(
    "features.addedByState: memory, SQL and MongoDB, not file or Redis",
    [supported, meta.features.addedByState],
    backend === "file" || backend === "redis" ? [false, false] : [true, true],
  );

  // The documented fallback where the backend cannot: read the jobs and
  // count them. Correct, and linear in the jobs read — fine for a tour, not
  // for a dashboard polling it.
  const everything = await arrivals.list(
    [
      "waiting",
      "delayed",
      "active",
      "completed",
      "failed",
      "dead",
      "waiting-children",
    ],
    { limit: 100 },
  );
  const byScan = countAddedByScan(
    everything.map((job) => ({ state: job.state, createdAt: job.createdAt })),
    { from: addedFrom, to: addedTo },
  );
  checkEqual(
    "countAddedByScan: the same counts by reading every job (a re-add added nothing)",
    byScan,
    { ...emptyAddedCounts(), waiting: 3, delayed: 2 },
  );
  checkEqual(
    "sortByCreated: the same order by reading every job",
    sortByCreated([...everything], "asc").map((job) => job.id),
    ["w-3", "w-2", "w-1", "d-late", "d-soon"],
  );
  checkEqual(
    "sort: natural works everywhere — delayed by runAt",
    (await arrivals.list("delayed", { sort: "natural" })).map((job) => job.id),
    ["d-soon", "d-late"],
  );

  // The API refuses a span under a second (MIN_ANALYTICS_SPAN_MS), so its
  // range runs at least that long; nothing else is added to the namespace
  // meanwhile, so it counts the same jobs.
  const apiTo = Math.max(addedTo, addedFrom + MIN_ANALYTICS_SPAN_MS);
  const range = qs({ from: addedFrom, to: apiTo });
  if (supported) {
    checkEqual(
      "countAdded({ from, to }): by the state each is in now",
      await arrivals.countAdded({ from: addedFrom, to: addedTo }),
      byScan,
    );
    checkEqual(
      "countAdded: from inclusive, to exclusive — a range ending at the first add is empty",
      await arrivals.countAdded({ from: addedFrom - 60_000, to: addedFrom }),
      emptyAddedCounts(),
    );
    await checkRejects(
      "countAdded with to equal to from: ConfigError",
      () => arrivals.countAdded({ from: addedFrom, to: addedFrom }),
      { name: "ConfigError" },
    );
    checkEqual(
      "list({ sort: createdAt }): creation order, not runAt",
      (await arrivals.list("delayed", { sort: "createdAt" })).map(
        (job) => job.id,
      ),
      ["d-late", "d-soon"],
    );
    checkEqual(
      "order: desc reverses it — newest first, across states",
      (
        await arrivals.list(["waiting", "delayed"], {
          sort: "createdAt",
          order: "desc",
        })
      ).map((job) => job.id),
      ["d-soon", "d-late", "w-1", "w-2", "w-3"],
    );

    const one = (await get(`/queues/arrivals/counts/added${range}`))
      .body as AddedByStateDto;
    checkEqual(
      "GET /queues/arrivals/counts/added",
      [one.from, one.to, one.counts, one.total, one.queues],
      [addedFrom, apiTo, byScan, 5, 1],
    );
    const all = (await get(`/overview/added${range}`)).body as AddedByStateDto;
    checkEqual(
      "GET /overview/added sums every queue the caller may see",
      [all.counts.waiting, all.counts.delayed, all.total],
      [3, 2, 5],
    );
    for (const [label, query] of [
      ["to not after from", qs({ from: addedFrom, to: addedFrom })],
      [
        "a span over a day",
        qs({ from: addedTo - 25 * 3_600_000, to: addedTo }),
      ],
      ["a span under a second", qs({ from: addedFrom, to: addedFrom + 999 })],
    ] as const) {
      const answer = await get(`/overview/added${query}`);
      checkEqual(
        `counts/added, ${label}: 400 INVALID_ARGUMENT`,
        [answer.status, answer.body.code],
        [400, "INVALID_ARGUMENT"],
      );
    }
    const sorted = await get(
      `/queues/arrivals/jobs${qs({ state: "delayed", sort: "createdAt", order: "desc" })}`,
    );
    checkEqual(
      "?sort=createdAt&order=desc on the job list",
      (sorted.body.items as JobDto[]).map((job) => job.id),
      ["d-soon", "d-late"],
    );
  } else {
    await checkRejects(
      "countAdded() on this backend: NotSupportedError, needing countAddedJobs",
      () => arrivals.countAdded({ from: addedFrom, to: addedTo }),
      { name: "NotSupportedError" },
    );
    await checkRejects(
      "list({ sort: createdAt }): ConfigError rather than a page in the wrong order",
      () => arrivals.list("delayed", { sort: "createdAt" }),
      { name: "ConfigError", message: /countAddedJobs/ },
    );
    for (const path of ["/overview/added", "/queues/arrivals/counts/added"]) {
      const answer = await get(`${path}${range}`);
      checkEqual(
        `${path}: pruned, 404 ROUTE_NOT_FOUND`,
        [answer.status, answer.body.code],
        [404, "ROUTE_NOT_FOUND"],
      );
    }
    const sorted = await get(
      `/queues/arrivals/jobs${qs({ state: "delayed", sort: "createdAt" })}`,
    );
    checkEqual(
      "?sort=createdAt: 400 INVALID_ARGUMENT",
      [sorted.status, sorted.body.code],
      [400, "INVALID_ARGUMENT"],
    );
  }

  // On every backend: a driver without countAddedJobs, as file and Redis are,
  // and as a custom driver written before it would be.
  const withoutJobs = new BunJobs({
    namespace,
    driver: wrapped(driver, ["countAddedJobs"]),
    logger: noopLogger,
  });
  withoutJobs.queue("arrivals");
  const withoutGet = mount(withoutJobs);
  checkEqual(
    "a driver without countAddedJobs: addedByState false",
    ((await withoutGet("/meta")).body as MetaDto).features.addedByState,
    false,
  );
  checkEqual(
    "… its count routes pruned",
    (await withoutGet(`/queues/arrivals/counts/added${range}`)).status,
    404,
  );
  checkEqual(
    "… and ?sort=createdAt refused",
    (
      await withoutGet(
        `/queues/arrivals/jobs${qs({ state: "delayed", sort: "createdAt" })}`,
      )
    ).status,
    400,
  );
  await withoutJobs.close();
}

/* ------------------------------------------------------------------ */
step("Clean up: this run's namespace only");

await Promise.all(mounted.map((api) => api.close()));
await jobs.purge();
await quietJobs.close();
await jobs.close();
await driver.close();

summary();
