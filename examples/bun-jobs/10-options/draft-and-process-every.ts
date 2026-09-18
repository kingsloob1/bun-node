/**
 * Option tour: `jobs.create()` / `JobDraft` and `processEvery` — every member
 * called, every option set, every rule asserted.
 *
 * ```bash
 * bun 10-options/draft-and-process-every.ts
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://localhost:6379/13 bun 10-options/draft-and-process-every.ts
 * ```
 *
 * The points that are easy to get wrong:
 *
 * - **A draft is saved once.** An unchanged second save answers with the same
 *   job and writes nothing, even racing; any setter after a save began — even
 *   one restating a value — makes the next save a `ConfigError`. A save that
 *   threw saved nothing and can be retried.
 * - **Precedence, bottom to top:** `defaultJobOptions`, the definition's
 *   options, the draft. On a series, `schedule()` and `startAt` share one
 *   start, so the later word stands; each `repeatEvery()` replaces the whole
 *   series description.
 * - **`processEvery` sets `pollInterval`, and `maxBlock` only on a blocking
 *   driver.** Explicit `start()` options win over it, a later call wins over
 *   both. It never touches the stalled sweep or housekeeping, and never
 *   delays a new job.
 * - **A wait in progress** is cut short on a polling driver and left to
 *   finish on a blocking one.
 * - **Series setters** — `limit()`, `tz()`, `endingAt()`, `catchUp()`,
 *   `immediately()` — change one field of the series and leave the rest.
 *   Called before `repeatEvery()` they throw `ConfigError` at once; a later
 *   `repeatEvery()` replaces what they set.
 * - **Date phrases are read at `save()`**, so "in 1 hour" is an hour from the
 *   save, and an unreadable one fails there — naming `schedule()` or
 *   `endingAt()` and quoting the phrase.
 * - **`jobs.processEveryMs`** reads back what `processEvery` was given, in
 *   milliseconds (`undefined` when never set) — what was asked for, not what
 *   a worker started with its own `pollInterval` uses.
 */
import type {
  Job,
  JobsDriver,
  RepeatEveryOptions,
} from "@kingsleyweb/bun-jobs";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  BunQueueWorker,
  ConfigError,
  createDriver,
  JobDraft,
  MAX_TIMER_MS,
  RedisDriver,
} from "@kingsleyweb/bun-jobs";
import {
  exampleBackend,
  exampleDriver,
  exampleNamespace,
} from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Option tour: jobs.create() and processEvery");

/** Generous ceiling for anything a busy machine might slow down. */
const WAIT = { timeout: 30_000, interval: 10 };
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The bound the refusals name, built from the constant rather than repeated. */
const TOO_LONG = new RegExp(String(MAX_TIMER_MS));

/** What a mail job carries. */
interface Mail {
  /** Recipient, or any marker a check needs. */
  to: string;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Every context this tour made, for cleanup. */
const opened: { jobs: BunJobs; driver: JobsDriver }[] = [];

/** One call a spied driver method received. */
interface Call {
  /** The budget given, for `waitForJob`; `0` for the others. */
  ms: number;
  /** When it was made. */
  at: number;
}

/** A context on a driver instance of its own, with its driver spied on. */
interface Spied {
  /** The context. */
  jobs: BunJobs;
  /** Its driver, lent, so the tour closes it. */
  driver: JobsDriver;
  /** Every `waitForJob` budget, in order. */
  waits: Call[];
  /** Every `promoteDelayed` call. */
  promotions: Call[];
  /** Every `recoverStalled` call. */
  stalls: Call[];
  /** Every `pruneExpired` call. */
  prunes: Call[];
}

/**
 * A `BunJobs` on a fresh instance of the example driver, spied at the driver
 * boundary — where `processEvery` is meant to make a difference. One instance
 * per context means nothing another section runs shows up in its counts.
 */
async function spiedContext(
  base: string,
  options: {
    /** Passed to the context as its `processEvery` option. */
    processEvery?: number | string;
    /** A driver instance to use instead of one built from `EXAMPLE_DRIVER`. */
    driver?: JobsDriver;
  } = {},
): Promise<Spied> {
  const driver = options.driver ?? createDriver(exampleDriver());
  const waits: Call[] = [];
  const promotions: Call[] = [];
  const stalls: Call[] = [];
  const prunes: Call[] = [];

  const wait = driver.waitForJob.bind(driver);
  driver.waitForJob = async (q, ms, signal) => {
    waits.push({ ms, at: Date.now() });
    return await wait(q, ms, signal);
  };
  const promote = driver.promoteDelayed.bind(driver);
  driver.promoteDelayed = async (q, now, limit) => {
    promotions.push({ ms: 0, at: Date.now() });
    return await promote(q, now, limit);
  };
  const recover = driver.recoverStalled.bind(driver);
  driver.recoverStalled = async (...args) => {
    stalls.push({ ms: 0, at: Date.now() });
    return await recover(...args);
  };
  const prune = driver.pruneExpired.bind(driver);
  driver.pruneExpired = async (...args) => {
    prunes.push({ ms: 0, at: Date.now() });
    return await prune(...args);
  };

  await driver.connect();
  const jobs = new BunJobs({
    namespace: exampleNamespace(base),
    driver,
    logger: noopLogger,
    ...(options.processEvery === undefined
      ? {}
      : { processEvery: options.processEvery }),
  });
  opened.push({ jobs, driver });
  return { jobs, driver, waits, promotions, stalls, prunes };
}

/** Stops, purges and closes a context and its driver. */
async function dispose({
  jobs,
  driver,
}: {
  jobs: BunJobs;
  driver: JobsDriver;
}): Promise<void> {
  const index = opened.findIndex((entry) => entry.jobs === jobs);
  if (index >= 0) opened.splice(index, 1);
  await jobs.stop().catch(() => {});
  await jobs.purge().catch(() => {});
  await jobs.close();
  await driver.close();
}

/** How many entries `calls` gains over `ms`. */
async function countOver(calls: unknown[], ms: number): Promise<number> {
  const from = calls.length;
  await Bun.sleep(ms);
  return calls.length - from;
}

/** Every job the queue holds, in any state. */
async function total(queue: {
  count: () => Promise<Record<string, number>>;
}): Promise<number> {
  const counts = await queue.count();
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

/** What `run` threw or rejected with, or `undefined`. */
async function caught(run: () => unknown): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

/* ------------------------------------------------------------------ */
/* The draft context                                                   */
/* ------------------------------------------------------------------ */

const draftDriver = createDriver(exampleDriver());
await draftDriver.connect();
const jobs = new BunJobs({
  namespace: exampleNamespace("draft-tour"),
  driver: draftDriver,
  logger: noopLogger,
  // The context's defaults, under the definition's and the draft's.
  defaultJobOptions: { keepStacktraces: 9 },
});
opened.push({ jobs, driver: draftDriver });
jobs.define<Mail>("mail", async () => null, {
  attempts: 5,
  priority: 3,
  timeout: 1_000,
});
/** The registry's queue, where a saved draft lands. */
const queue = jobs.queue<Mail>("jobs");

/** The stored series with `key`. */
async function seriesFor(key: string) {
  return (await queue.listRepeatables()).find((record) => record.key === key);
}

/* ------------------------------------------------------------------ */
step("create(): a draft, not a job");

{
  const draft = jobs.create<Mail>("mail", { to: "ops" });
  check("create() answers with a JobDraft", draft instanceof JobDraft);
  checkEqual("name: the defined name", draft.name, "mail");
  checkEqual("isSaved: false before a save", draft.isSaved, false);
  checkEqual("job: undefined before a save", draft.job, undefined);
  checkEqual("nothing is written by create()", await total(queue), 0);

  const job = await draft.save();
  checkEqual("isSaved: true after a save", draft.isSaved, true);
  check("job: the job save() answered with", draft.job === job);
  checkEqual("save(): wasAdded", job.wasAdded, true);
  const stored = await queue.getJob(job.id);
  checkEqual(
    "save(): the stored job is what was described",
    [stored?.name, stored?.data, stored?.state],
    ["mail", { to: "ops" }, "waiting"],
  );

  const refused = await checkRejects(
    "create(undefined name) throws at create()",
    () => jobs.create("neverDefined"),
    { name: "ConfigError", code: "CONFIG" },
  );
  const viaNow = await caught(() => jobs.now("neverDefined"));
  checkEqual(
    "create(undefined name): the same message as now()",
    refused?.message,
    (viaNow as Error | undefined)?.message,
  );
  await jobs.drain({ delayed: true });
}

/* ------------------------------------------------------------------ */
step("Every setter reaches the stored job");

{
  const before = Date.now();
  const job = await jobs
    .create<Mail>("mail", { to: "first" })
    .withData({ to: "second" })
    .jobId("all-setters")
    .priority(4)
    .attempts(7)
    .backoff({ type: "fixed", delay: 500 })
    .timeout("30 seconds")
    .removeOnComplete({ count: 5 })
    .removeOnFail(2)
    .keepStacktraces(2)
    .keepLogs(10)
    .deadLetter("mail-dead")
    .delay("5 minutes")
    .save();
  const after = Date.now();
  const stored = await queue.getJob("all-setters");

  for (const [label, view] of [
    ["returned", job],
    ["stored", stored],
  ] as const) {
    checkEqual(
      `${label}: withData, jobId, state`,
      [view?.data, view?.id, view?.state],
      [{ to: "second" }, "all-setters", "delayed"],
    );
    check(
      `${label}: delay("5 minutes")`,
      view !== null &&
        view.runAt >= before + 5 * MINUTE &&
        view.runAt <= after + 5 * MINUTE,
      view?.runAt,
    );
    checkEqual(
      `${label}: priority, attempts, backoff, timeout, retention, keepLogs, deadLetter`,
      {
        priority: view?.opts.priority,
        attempts: view?.opts.attempts,
        backoff: view?.opts.backoff,
        timeout: view?.opts.timeout,
        removeOnComplete: view?.opts.removeOnComplete,
        removeOnFail: view?.opts.removeOnFail,
        keepStacktraces: view?.opts.keepStacktraces,
        keepLogs: view?.opts.keepLogs,
        deadLetter: view?.opts.deadLetter,
      },
      {
        priority: 4,
        attempts: 7,
        backoff: { type: "fixed", delay: 500 },
        timeout: 30_000,
        removeOnComplete: { count: 5 },
        removeOnFail: 2,
        keepStacktraces: 2,
        keepLogs: 10,
        deadLetter: "mail-dead",
      },
    );
  }

  const numeric = await jobs
    .create<Mail>("mail")
    .timeout(2_500)
    .removeOnComplete(true)
    .removeOnFail(false)
    .delay(1_000)
    .save();
  checkEqual(
    "timeout(ms), removeOnComplete(true), removeOnFail(false)",
    [
      numeric.opts.timeout,
      numeric.opts.removeOnComplete,
      numeric.opts.removeOnFail,
    ],
    [2_500, true, false],
  );
  check(
    "delay(ms)",
    numeric.state === "delayed" && numeric.runAt - numeric.createdAt >= 1_000,
    { state: numeric.state, runAt: numeric.runAt, at: numeric.createdAt },
  );

  const saidAt = Date.now();
  const prefixed = await jobs.create<Mail>("mail").delay("in 5 minutes").save();
  checkEqual(
    'delay("in 5 minutes"): a leading "in" is allowed',
    Math.round((prefixed.runAt - saidAt) / MINUTE),
    5,
  );
  await jobs.drain({ delayed: true });
}

/* ------------------------------------------------------------------ */
step("unique() / jobId(): the idempotency key across drafts");

{
  const added: string[] = [];
  const duplicates: string[] = [];
  const onAdded = (job: Job<Mail, unknown>) => added.push(job.id);
  const onDuplicate = (job: Job<Mail, unknown>) => duplicates.push(job.id);
  queue.on("added", onAdded);
  queue.on("duplicate", onDuplicate);

  const first = await jobs
    .create<Mail>("mail", { to: "1" })
    .unique("once")
    .save();
  const second = await jobs
    .create<Mail>("mail", { to: "2" })
    .jobId("once")
    .save();
  checkEqual(
    "unique then jobId with the same id: wasAdded",
    [first.wasAdded, second.wasAdded],
    [true, false],
  );
  checkEqual("the second answers with the stored job", second.data, {
    to: "1",
  });
  checkEqual(
    "events: added once, then duplicate once",
    [added, duplicates],
    [["once"], ["once"]],
  );
  checkEqual("one job stored", await total(queue), 1);

  queue.off("added", onAdded);
  queue.off("duplicate", onDuplicate);
  await jobs.drain();
}

/* ------------------------------------------------------------------ */
step("schedule(): a Date, epoch ms or words; over delay(); last one stands");

{
  const at = Date.now() + HOUR;
  const byDate = await jobs.create<Mail>("mail").schedule(new Date(at)).save();
  const byMs = await jobs
    .create<Mail>("mail")
    .schedule(at + 1)
    .save();
  const delayFirst = await jobs
    .create<Mail>("mail")
    .delay(1_000)
    .schedule(at + 2)
    .save();
  const delayLast = await jobs
    .create<Mail>("mail")
    .schedule(at + 3)
    .delay(1_000)
    .save();

  for (const [label, job, runAt] of [
    ["schedule(Date)", byDate, at],
    ["schedule(ms)", byMs, at + 1],
    ["delay() then schedule(): schedule wins", delayFirst, at + 2],
    ["schedule() then delay(): schedule still wins", delayLast, at + 3],
  ] as const) {
    checkEqual(
      label,
      [job.state, job.runAt, (await queue.getJob(job.id))?.runAt],
      ["delayed", runAt, runAt],
    );
  }

  const before = Date.now();
  const byWords = await jobs
    .create<Mail>("mail")
    .schedule("in 20 minutes")
    .save();
  check(
    'schedule("in 20 minutes"), read at save',
    byWords.runAt >= before + 20 * MINUTE &&
      byWords.runAt < before + 21 * MINUTE,
    byWords.runAt - before,
  );

  const instantLast = await jobs
    .create<Mail>("mail")
    .schedule("in 5 minutes")
    .schedule(new Date(at + 4))
    .save();
  const phraseLast = await jobs
    .create<Mail>("mail")
    .schedule(new Date(at + 5))
    .schedule("in 5 minutes")
    .save();
  checkEqual(
    "schedule(phrase) then schedule(Date): the Date",
    instantLast.runAt,
    at + 4,
  );
  checkEqual(
    "schedule(Date) then schedule(phrase): the phrase",
    Math.round((phraseLast.runAt - Date.now()) / MINUTE),
    5,
  );
  await jobs.drain({ delayed: true });
}

/* ------------------------------------------------------------------ */
step("repeatEvery(): every RepeatEveryOptions field");

{
  const start = Date.now() + DAY;
  const end = start + 30 * DAY;
  const options: RepeatEveryOptions = {
    key: "every-2-days",
    limit: 3,
    startAt: start,
    endAt: end,
    catchUp: true,
  };
  const job = await jobs
    .create<Mail>("mail", { to: "series" })
    .repeatEvery("2 days", options)
    .save();

  checkEqual(
    "the saved job: isRepeat, repeatKey, runAt is startAt",
    [job.isRepeat, job.repeatKey, job.runAt],
    [true, "every-2-days", start],
  );
  const series = await seriesFor("every-2-days");
  checkEqual(
    "the stored series: every, limit, startAt, endAt, catchUp",
    [
      series?.name,
      series?.every,
      series?.limit,
      series?.startAt,
      series?.endAt,
      series?.catchUp,
    ],
    ["mail", 2 * DAY, 3, start, end, true],
  );

  // `false` is the default, and a series given it explicitly reports it back.
  await jobs
    .create<Mail>("mail")
    .repeatEvery("1 day", { key: "no-catch-up", catchUp: false })
    .save();
  checkEqual(
    "catchUp: false is stored as false",
    (await seriesFor("no-catch-up"))?.catchUp,
    false,
  );
  checkEqual(
    "the definition's options reach the series",
    series?.opts.attempts,
    5,
  );

  const cron = await jobs
    .create<Mail>("mail")
    .repeatEvery("0 9 * * 1", { tz: "Europe/London" })
    .save();
  checkEqual(
    "a cron expression and tz: the default key",
    cron.repeatKey,
    "mail|0 9 * * 1@Europe/London|",
  );
  const cronSeries = await seriesFor("mail|0 9 * * 1@Europe/London|");
  checkEqual(
    "the stored cron series",
    [cronSeries?.cron, cronSeries?.tz],
    ["0 9 * * 1", "Europe/London"],
  );

  const ms = await jobs
    .create<Mail>("mail")
    .repeatEvery(MINUTE, { key: "not-immediate" })
    .save();
  const immediate = await jobs
    .create<Mail>("mail")
    .repeatEvery(MINUTE, { key: "immediate", immediately: true })
    .save();
  checkEqual(
    "immediately: false by default (delayed), true runs now (waiting)",
    [ms.state, immediate.state],
    ["delayed", "waiting"],
  );
  checkEqual(
    "repeatEvery(ms): the interval as given",
    (await seriesFor("not-immediate"))?.every,
    MINUTE,
  );

  const named = await jobs
    .create<Mail>("mail")
    .unique("series-id")
    .repeatEvery("1 hour")
    .save();
  checkEqual(
    "unique() on a series names the series",
    named.repeatKey,
    "series-id",
  );
}

/* ------------------------------------------------------------------ */
step("repeatEvery(): each call replaces the series; starts and schedule()");

{
  const start = Date.now() + 5 * DAY;

  await jobs
    .create<Mail>("mail")
    .repeatEvery("1 day", {
      limit: 3,
      tz: "Europe/London",
      endAt: start + 30 * DAY,
      key: "replaced",
    })
    .repeatEvery("2 days", { key: "replaced" })
    .save();
  const replaced = await seriesFor("replaced");
  checkEqual(
    "a second repeatEvery(): new interval; limit, tz, endAt dropped",
    [
      replaced?.every,
      replaced?.limit ?? undefined,
      replaced?.tz ?? undefined,
      replaced?.endAt ?? undefined,
    ],
    [2 * DAY, undefined, undefined, undefined],
  );

  await jobs
    .create<Mail>("mail")
    .repeatEvery("1 day", { startAt: start, key: "start-dropped" })
    .repeatEvery("1 day", { key: "start-dropped" })
    .save();
  check(
    "a start given by an earlier repeatEvery() is dropped with it",
    (await seriesFor("start-dropped"))?.startAt !== start,
    await seriesFor("start-dropped"),
  );

  const kept = await jobs
    .create<Mail>("mail")
    .schedule(start)
    .repeatEvery("1 day", { limit: 2, key: "start-kept" })
    .repeatEvery("2 days", { key: "start-kept" })
    .save();
  const keptSeries = await seriesFor("start-kept");
  checkEqual(
    "a start given by schedule() stays; the limit does not",
    [kept.runAt, keptSeries?.startAt, keptSeries?.limit ?? undefined],
    [start, start, undefined],
  );

  const at = Date.now() + 3 * DAY;
  const after = await jobs
    .create<Mail>("mail")
    .repeatEvery("1 day", { key: "schedule-after" })
    .schedule(new Date(at))
    .save();
  const before = await jobs
    .create<Mail>("mail")
    .schedule(at)
    .repeatEvery("1 day", { key: "schedule-before" })
    .save();
  checkEqual(
    "schedule() after or before repeatEvery(): the series starts there",
    [
      after.runAt,
      (await seriesFor("schedule-after"))?.startAt,
      before.runAt,
      (await seriesFor("schedule-before"))?.startAt,
    ],
    [at, at, at, at],
  );

  const restated = await jobs
    .create<Mail>("mail")
    .repeatEvery("1 day", { startAt: "in 5 minutes", key: "restated" })
    .repeatEvery("1 day", { startAt: start, key: "restated" })
    .save();
  checkEqual(
    "startAt: the later repeatEvery()'s stands",
    restated.runAt,
    start,
  );

  for (const [early, late] of [
    ["phrase", "Date"],
    ["Date", "phrase"],
  ] as const) {
    const when = (form: "phrase" | "Date", days: number) =>
      form === "phrase" ? `in ${days} days` : new Date(Date.now() + days * DAY);
    const scheduleLast = await jobs
      .create<Mail>("mail")
      .repeatEvery("1 day", { key: `${early}-a`, startAt: when(early, 5) })
      .schedule(when(late, 9))
      .save();
    const startAtLast = await jobs
      .create<Mail>("mail")
      .schedule(when(early, 5))
      .repeatEvery("1 day", { key: `${early}-b`, startAt: when(late, 9) })
      .save();
    checkEqual(
      `startAt (${early}) vs schedule() (${late}): the later word, either way`,
      [scheduleLast, startAtLast].map((job) =>
        Math.round((job.runAt - Date.now()) / DAY),
      ),
      [9, 9],
    );
  }
}

/* ------------------------------------------------------------------ */
step(
  "The builder's side: on()/startingAt(), repeatEvery(), a definition's runAt",
);

{
  const cases = [
    [
      "on(Date) then startingAt(phrase)",
      (days: [number, number]) =>
        jobs
          .schedule<Mail>("mail")
          .every("1 day")
          .on(new Date(Date.now() + days[0] * DAY))
          .startingAt(`in ${days[1]} days`),
    ],
    [
      "startingAt(Date) then on(phrase)",
      (days: [number, number]) =>
        jobs
          .schedule<Mail>("mail")
          .every("1 day")
          .startingAt(new Date(Date.now() + days[0] * DAY))
          .on(`in ${days[1]} days`),
    ],
  ] as const;
  let index = 0;
  for (const [label, build] of cases) {
    const job = await build([5, 9])
      .withOptions({ repeatKey: `builder-order-${index++}` })
      .start();
    checkEqual(
      `JobBuilder ${label}: the last start stands`,
      Math.round((job.runAt - Date.now()) / DAY),
      9,
    );
  }

  const built = await jobs
    .schedule<Mail>("mail")
    .repeatEvery("1 day", { limit: 2, key: "builder-repeat-every" })
    .start();
  checkEqual(
    "JobBuilder.repeatEvery(interval, options)",
    [built.repeatKey, (await seriesFor("builder-repeat-every"))?.limit],
    ["builder-repeat-every", 2],
  );
  await checkRejects(
    "JobBuilder.repeatEvery(unreadable): named repeatEvery(), not every()",
    () => jobs.schedule("mail").repeatEvery("whenever"),
    { name: "ConfigError", message: /repeatEvery\(\)/ },
  );

  const at = Date.now() + 4 * DAY;
  const explicit = Date.now() + 6 * DAY;
  jobs.define<Mail>("dated", async () => null, { runAt: at });
  const defaulted = await jobs
    .schedule<Mail>("dated")
    .every("1 day")
    .withOptions({ repeatKey: "dated-default" })
    .start();
  const started = await jobs
    .create<Mail>("dated")
    .repeatEvery("1 day", { key: "dated-explicit", startAt: explicit })
    .save();
  checkEqual(
    "a definition's runAt starts its series (it used to be ignored)",
    [defaulted.runAt, (await seriesFor("dated-default"))?.startAt],
    [at, at],
  );
  checkEqual(
    "an explicit start wins over the definition's runAt",
    [started.runAt, (await seriesFor("dated-explicit"))?.startAt],
    [explicit, explicit],
  );
  const single = await jobs.create<Mail>("dated").save();
  checkEqual(
    "a definition's runAt on a one-off draft: still when it runs",
    [single.state, single.runAt],
    ["delayed", at],
  );

  for (const repeatable of await queue.listRepeatables()) {
    await queue.removeRepeatable(repeatable.key);
  }
  await jobs.drain({ delayed: true });
}

/* ------------------------------------------------------------------ */
step("Series setters: limit(), tz(), endingAt(), catchUp(), immediately()");

// Each changes ONE field of the series `repeatEvery()` described and leaves
// the rest — unlike `repeatEvery()` itself, which replaces the whole series.
// Without a series to change they throw at once: spreading an absent series
// would otherwise have manufactured `{ limit: 3 }`, a repeat with nothing to
// repeat.

{
  const before = await total(queue);
  const setters = [
    ["limit", (draft: JobDraft<Mail>) => draft.limit(3)],
    ["tz", (draft: JobDraft<Mail>) => draft.tz("UTC")],
    ["endingAt", (draft: JobDraft<Mail>) => draft.endingAt("in 2 days")],
    ["catchUp", (draft: JobDraft<Mail>) => draft.catchUp()],
    ["immediately", (draft: JobDraft<Mail>) => draft.immediately()],
  ] as const;

  for (const [method, call] of setters) {
    const draft = jobs.create<Mail>("mail", { to: method });
    const error = await checkRejects(
      `${method}() before repeatEvery() throws at the setter`,
      () => call(draft),
      {
        name: "ConfigError",
        code: "CONFIG",
        message: new RegExp(
          `^${method}\\(\\) .*needs repeatEvery\\(\\) before it`,
        ),
      },
    );
    checkEqual(
      `${method}(): context names the method and the job`,
      (error as ConfigError | undefined)?.context,
      { name: "mail", method: `${method}()` },
    );

    // Refused before it touched anything: the draft is still a plain one-off
    // and saves as one — no series, and no stray field from the refused call.
    const saved = await draft.save();
    checkEqual(
      `${method}(): the refused draft still saves, as a one-off`,
      [saved.isRepeat, saved.repeatKey, saved.state],
      [false, null, "waiting"],
    );
  }
  checkEqual(
    "…one job per refused draft, and no series",
    [(await total(queue)) - before, (await queue.listRepeatables()).length],
    [setters.length, 0],
  );
  await jobs.drain({ delayed: true });

  // One field each, the rest left as repeatEvery() gave it.
  await jobs
    .create<Mail>("mail")
    .repeatEvery("1 hour", { key: "one-field", limit: 9, tz: "UTC" })
    .limit(3)
    .catchUp()
    .save();
  const oneField = await seriesFor("one-field");
  checkEqual(
    "limit(3).catchUp(): those two changed; every and tz kept",
    [oneField?.every, oneField?.limit, oneField?.tz, oneField?.catchUp],
    [HOUR, 3, "UTC", true],
  );

  // tz() on a cron series: the zone is part of the generated key.
  const zoned = await jobs
    .create<Mail>("mail")
    .repeatEvery("0 9 * * 1")
    .tz("Asia/Tokyo")
    .save();
  checkEqual(
    "tz(): the cron is read in that zone, and the default key says so",
    [zoned.repeatKey, (await seriesFor("mail|0 9 * * 1@Asia/Tokyo|"))?.tz],
    ["mail|0 9 * * 1@Asia/Tokyo|", "Asia/Tokyo"],
  );

  // endingAt(): a Date, epoch ms or words — a phrase read at save().
  const endAt = Date.now() + 20 * DAY;
  for (const [form, when] of [
    ["a Date", new Date(endAt)],
    ["epoch ms", endAt],
  ] as const) {
    await jobs
      .create<Mail>("mail")
      .repeatEvery("1 day", { key: `ending-${form}` })
      .endingAt(when)
      .save();
    checkEqual(
      `endingAt(${form})`,
      (await seriesFor(`ending-${form}`))?.endAt,
      endAt,
    );
  }
  await jobs
    .create<Mail>("mail")
    .repeatEvery("1 day", { key: "ending-words" })
    .endingAt("in 20 days")
    .save();
  const wordsEnd = (await seriesFor("ending-words"))?.endAt ?? 0;
  check(
    'endingAt("in 20 days"): read at save()',
    Math.abs(wordsEnd - (Date.now() + 20 * DAY)) < MINUTE,
    wordsEnd,
  );

  // catchUp(false) and immediately(false) undo what repeatEvery()'s options
  // said; bare immediately() runs the first occurrence now.
  await jobs
    .create<Mail>("mail")
    .repeatEvery("1 hour", { key: "no-catch", catchUp: true })
    .catchUp(false)
    .save();
  const notNow = await jobs
    .create<Mail>("mail")
    .repeatEvery("1 hour", { key: "not-now", immediately: true })
    .immediately(false)
    .save();
  const now = await jobs
    .create<Mail>("mail")
    .repeatEvery("1 hour", { key: "now" })
    .immediately()
    .save();
  checkEqual(
    "catchUp(false) over { catchUp: true }; immediately(false) and immediately()",
    [(await seriesFor("no-catch"))?.catchUp, notNow.state, now.state],
    [false, "delayed", "waiting"],
  );

  // A later repeatEvery() replaces the series — setters' fields included.
  await jobs
    .create<Mail>("mail")
    .repeatEvery("1 hour", { key: "reset" })
    .limit(3)
    .repeatEvery("2 hours", { key: "reset" })
    .save();
  const reset = await seriesFor("reset");
  checkEqual(
    "repeatEvery() after limit(): the limit goes with the old series",
    [reset?.every, reset?.limit ?? undefined],
    [2 * HOUR, undefined],
  );

  // withOptions({ every }) describes a series just as repeatEvery() does.
  await jobs
    .create<Mail>("mail")
    .withOptions({ every: "2 days", repeatKey: "via-options" })
    .limit(4)
    .save();
  checkEqual(
    "withOptions({ every }) then limit(): allowed, and applied",
    (await seriesFor("via-options"))?.limit,
    4,
  );

  // A series setter is a setter: after a save it makes the next save refuse.
  const savedSeries = jobs
    .create<Mail>("mail")
    .repeatEvery("1 hour", { key: "saved-series" });
  await savedSeries.save();
  savedSeries.limit(2);
  await checkRejects(
    "limit() after a save: the next save() is refused",
    () => savedSeries.save(),
    { name: "ConfigError", message: /already saved/ },
  );

  // The builder's limit() has the same guard: with no interval it throws at
  // the setter, rather than inventing a repeat with nothing to repeat.
  await checkRejects(
    "JobBuilder.limit() with no every(): refused at the setter",
    () => jobs.schedule<Mail>("mail").limit(3),
    {
      name: "ConfigError",
      message: /^limit\(\) .*needs every\(\) or repeatEvery\(\) before it/,
    },
  );

  // And the values are read at the setter too, on either side: limit() wants
  // a whole number of at least 1, and tz() a zone the runtime knows — on an
  // interval series as well as a cron one.
  for (const [label, call] of [
    [
      "draft limit(0)",
      () => jobs.create<Mail>("mail").repeatEvery("1 hour").limit(0),
    ],
    [
      "draft limit(1.5)",
      () => jobs.create<Mail>("mail").repeatEvery("1 hour").limit(1.5),
    ],
    [
      "builder limit(-1)",
      () => jobs.schedule<Mail>("mail").every("1 hour").limit(-1),
    ],
  ] as const) {
    await checkRejects(`${label}: refused at the setter`, call, {
      name: "ConfigError",
      message: /^limit\(\) needs a whole number of occurrences, at least 1/,
    });
  }
  for (const [label, call] of [
    [
      "draft tz() on an interval series",
      () => jobs.create<Mail>("mail").repeatEvery("1 hour").tz("Europe/Lagos"),
    ],
    [
      "builder tz() on an interval series",
      () => jobs.schedule<Mail>("mail").every("1 hour").tz("Europe/Lagos"),
    ],
    [
      "withOptions({ every, tz })",
      () =>
        jobs
          .schedule<Mail>("mail")
          .withOptions({ every: "1 hour", tz: "Europe/Lagos" }),
    ],
  ] as const) {
    const error = await checkRejects(
      `${label}: an unknown zone is refused`,
      call,
      {
        name: "ConfigError",
        message: /^tz\(\) does not know the time zone "Europe\/Lagos"/,
      },
    );
    checkEqual(
      `${label}: context names the method and the zone`,
      (error as ConfigError | undefined)?.context,
      { method: "tz()", tz: "Europe/Lagos" },
    );
  }

  for (const repeatable of await queue.listRepeatables()) {
    await queue.removeRepeatable(repeatable.key);
  }
  await jobs.drain({ delayed: true });
}

/* ------------------------------------------------------------------ */
step("Date phrases are read at save(), and an unreadable one names its setter");

{
  // Read at save, not at the setter: "in 1 hour" is an hour from the save.
  const draft = jobs.create<Mail>("mail").schedule("in 1 hour");
  await Bun.sleep(300);
  const savedAt = Date.now();
  const job = await draft.save();
  check(
    'schedule("in 1 hour"): an hour from save(), not from schedule()',
    job.runAt >= savedAt + HOUR - 50,
    { runAt: job.runAt, savedAt },
  );

  // An unreadable phrase fails at save() — so the error names the method it
  // was given to and quotes it, instead of `runAt could not be understood`,
  // an option name the caller never wrote.
  const before = await total(queue);
  const unreadable = jobs
    .create<Mail>("mail")
    .schedule("the twelfth of Octember");
  const error = await checkRejects(
    "schedule(unreadable): refused at save()",
    () => unreadable.save(),
    { name: "ConfigError", code: "CONFIG" },
  );
  checkEqual(
    "…naming schedule() and quoting the phrase",
    error?.message,
    'schedule() could not read "the twelfth of Octember" as a date',
  );
  checkEqual(
    "…with the method in its context",
    (error as ConfigError | undefined)?.context?.method,
    "schedule()",
  );
  checkEqual(
    "…and nothing written, the draft unsaved",
    [(await total(queue)) - before, unreadable.isSaved],
    [0, false],
  );
  const fixed = await unreadable.schedule(Date.now() + HOUR).save();
  checkEqual(
    "a readable schedule() replaces it, and the draft saves",
    fixed.state,
    "delayed",
  );

  await checkRejects(
    "endingAt(unreadable): refused at save(), naming endingAt()",
    () =>
      jobs
        .create<Mail>("mail")
        .repeatEvery("1 hour")
        .endingAt("the fifth of Octember")
        .save(),
    {
      name: "ConfigError",
      message:
        /^endingAt\(\) could not read "the fifth of Octember" as a date$/,
    },
  );

  // A different ConfigError from the same save() is not renamed.
  const other = await checkRejects(
    "an unrelated refusal from save() keeps its own message",
    () =>
      jobs
        .create<Mail>("mail")
        .schedule("in 2 hours")
        .unique("u")
        .debounce("d", 1_000)
        .save(),
    { name: "ConfigError" },
  );
  check(
    "…not blamed on schedule()",
    !other?.message.includes("schedule()"),
    other?.message,
  );
  await jobs.drain({ delayed: true });
}

/* ------------------------------------------------------------------ */
step("debounce() and throttle()");

{
  const start = await total(queue);
  const first = await jobs
    .create<Mail>("mail", { to: "v1" })
    .debounce("doc-1", "1 minute")
    .save();
  const second = await jobs
    .create<Mail>("mail", { to: "v2" })
    .debounce("doc-1", "1 minute")
    .save();
  checkEqual(
    "debounce(id, ttl): one job, the latest data",
    [second.id === first.id, (await queue.getJob(first.id))?.data],
    [true, { to: "v2" }],
  );

  const opened = await jobs
    .create<Mail>("mail", { to: "v1" })
    .throttle("t-1", MINUTE)
    .save();
  const inside = await jobs
    .create<Mail>("mail", { to: "v2" })
    .throttle("t-1", MINUTE)
    .save();
  checkEqual(
    "throttle(id, ttl): one job, the first data",
    [inside.id === opened.id, (await queue.getJob(opened.id))?.data],
    [true, { to: "v1" }],
  );
  checkEqual("two jobs in all", (await total(queue)) - start, 2);
  await jobs.drain({ delayed: true });
}

/* ------------------------------------------------------------------ */
step("withOptions(): the builder's names, the raw ones, mixed with setters");

{
  const job = await jobs
    .create<Mail>("mail")
    .withOptions({ unique: "as-object", priority: 6, in: "1 hour" })
    .save();
  const stored = await queue.getJob("as-object");
  checkEqual(
    "withOptions({ unique, priority, in })",
    [job.id, stored?.opts.priority, stored?.state],
    ["as-object", 6, "delayed"],
  );

  const raw = await jobs
    .create<Mail>("mail")
    .withOptions({ jobId: "raw-names", delay: 60_000, data: { to: "raw" } })
    .save();
  checkEqual(
    "withOptions({ jobId, delay, data })",
    [raw.id, raw.state, raw.data],
    ["raw-names", "delayed", { to: "raw" }],
  );

  const setterLast = await jobs
    .create<Mail>("mail")
    .withOptions({ priority: 5 })
    .priority(1)
    .save();
  const objectLast = await jobs
    .create<Mail>("mail")
    .priority(1)
    .withOptions({ priority: 5 })
    .save();
  checkEqual(
    "whatever is said last wins",
    [setterLast.opts.priority, objectLast.opts.priority],
    [1, 5],
  );

  const repeating = await jobs
    .create<Mail>("mail")
    .withOptions({ every: "1 day", repeatKey: "object-series", limit: 4 })
    .save();
  checkEqual(
    "withOptions({ every, repeatKey, limit })",
    [repeating.repeatKey, (await seriesFor("object-series"))?.limit],
    ["object-series", 4],
  );
  await queue.removeRepeatable("object-series");
  await jobs.drain({ delayed: true });
}

/* ------------------------------------------------------------------ */
step("A setter that cannot read its argument fails at the setter");

{
  const draft = jobs.create<Mail>("mail");
  await checkRejects(
    'repeatEvery("whenever")',
    () => draft.repeatEvery("whenever"),
    { name: "ConfigError", code: "CONFIG", message: /repeatEvery\(\)/ },
  );
  await checkRejects('delay("soonish")', () => draft.delay("soonish"), {
    name: "ConfigError",
    code: "CONFIG",
    message: /delay\(\)/,
  });
  await checkRejects(
    'timeout("eventually")',
    () => draft.timeout("eventually"),
    {
      name: "ConfigError",
      code: "CONFIG",
      message: /timeout\(\)/,
    },
  );
  checkEqual(
    "a refused setter left the draft unsaved and saveable",
    draft.isSaved,
    false,
  );
}

/* ------------------------------------------------------------------ */
step("Precedence: context defaults, then the definition, then the draft");

{
  const drafted = await jobs.create<Mail>("mail").priority(1).save();
  const viaNow = await jobs.now<Mail>("mail", undefined, { priority: 1 });

  for (const [label, job] of [
    ["draft", drafted],
    ["now()", viaNow],
  ] as const) {
    const stored = await queue.getJob(job.id);
    checkEqual(
      `${label}: the draft's priority, the definition's attempts and timeout, the context's keepStacktraces`,
      [
        stored?.opts.priority,
        stored?.opts.attempts,
        stored?.opts.timeout,
        stored?.opts.keepStacktraces,
      ],
      [1, 5, 1_000, 9],
    );
  }
  checkEqual("a draft's options equal now()'s", drafted.opts, viaNow.opts);

  const bare = await jobs.create<Mail>("mail").save();
  checkEqual(
    "a bare draft inherits the definition's priority",
    bare.opts.priority,
    3,
  );
  await jobs.drain({ delayed: true });
}

/* ------------------------------------------------------------------ */
step("A combination the queue refuses is refused at save, writing nothing");

{
  const before = await total(queue);
  const drafts = [
    [
      "repeatEvery + debounce",
      jobs.create<Mail>("mail").repeatEvery("1 hour").debounce("d", 1_000),
    ],
    [
      "repeatEvery + throttle",
      jobs.create<Mail>("mail").repeatEvery("1 hour").throttle("d", 1_000),
    ],
    [
      "debounce + throttle",
      jobs.create<Mail>("mail").debounce("d", 1_000).throttle("d", 1_000),
    ],
    [
      "unique + debounce",
      jobs.create<Mail>("mail").unique("u").debounce("d", 1_000),
    ],
    [
      "unique + throttle",
      jobs.create<Mail>("mail").unique("u").throttle("d", 1_000),
    ],
  ] as const;

  for (const [label, draft] of drafts) {
    await checkRejects(`save(): ${label}`, () => draft.save(), {
      name: "ConfigError",
      code: "CONFIG",
    });
    checkEqual(`${label}: not saved`, draft.isSaved, false);
  }
  checkEqual(
    "nothing written: no job, no series",
    [(await total(queue)) - before, (await queue.listRepeatables()).length],
    [0, 0],
  );
}

/* ------------------------------------------------------------------ */
step("Saving twice");

{
  const draft = jobs.create<Mail>("mail", { to: "twice" });
  const first = await draft.save();

  const events: string[] = [];
  const onAdded = (job: Job<Mail, unknown>) => events.push(`added:${job.id}`);
  const onDuplicate = (job: Job<Mail, unknown>) =>
    events.push(`duplicate:${job.id}`);
  queue.on("added", onAdded);
  queue.on("duplicate", onDuplicate);

  const again = await draft.save();
  check("an unchanged second save: the same Job instance", again === first);
  checkEqual(
    "an unchanged second save: no added or duplicate event",
    events,
    [],
  );

  const racing = jobs.create<Mail>("mail", { to: "race" });
  const before = await total(queue);
  const [a, b] = await Promise.all([racing.save(), racing.save()]);
  check("two racing saves: the same job", a === b);
  checkEqual(
    "two racing saves: one job added",
    (await total(queue)) - before,
    1,
  );
  checkEqual(
    "two racing saves: one added event",
    events.filter((event) => event.startsWith("added:")).length,
    1,
  );
  queue.off("added", onAdded);
  queue.off("duplicate", onDuplicate);

  const changed = jobs.create<Mail>("mail").priority(2);
  const saved = await changed.save();
  changed.priority(9);
  await checkRejects(
    "a setter after a save: save() refuses, naming the job",
    () => changed.save(),
    { name: "ConfigError", code: "CONFIG", message: new RegExp(saved.id) },
  );
  checkEqual(
    "the stored job is as the first save left it",
    (await queue.getJob(saved.id))?.opts.priority,
    2,
  );
  checkEqual(
    "isSaved and job are kept",
    [changed.isSaved, changed.job === saved],
    [true, true],
  );

  const restated = jobs.create<Mail>("mail").priority(2);
  await restated.save();
  restated.priority(2);
  await checkRejects(
    "a setter restating the same value still counts",
    () => restated.save(),
    { name: "ConfigError" },
  );

  const inFlight = jobs.create<Mail>("mail");
  const saving = inFlight.save();
  inFlight.priority(7);
  await checkRejects(
    "a setter during a save in flight: a joining save refuses",
    () => inFlight.save(),
    { name: "ConfigError", message: /while it was being saved/ },
  );
  const inFlightJob = await saving;
  checkEqual(
    "the save in flight used the draft as it began (the definition's 3)",
    inFlightJob.opts.priority,
    3,
  );
  await checkRejects(
    "and once it lands, the next save refuses too",
    () => inFlight.save(),
    { name: "ConfigError", message: new RegExp(inFlightJob.id) },
  );

  const beforeFailure = await total(queue);
  const failing = jobs.create<Mail>("mail").schedule("zzqx vbnm");
  // Handled at once: awaiting anything first would leave the rejection
  // unhandled for as long as that await took.
  const failingSave = caught(() => failing.save());
  failing.priority(4); // made during a save that then fails
  const failure = await failingSave;
  check(
    "a save that throws — ConfigError",
    failure instanceof ConfigError,
    failure,
  );
  checkEqual(
    "it was not saved, and wrote nothing",
    [failing.isSaved, failing.job, (await total(queue)) - beforeFailure],
    [false, undefined, 0],
  );
  const at = Date.now() + HOUR;
  const retried = await failing.schedule(at).save();
  checkEqual(
    "corrected and saved: the correction and the edit made in flight",
    [retried.runAt, retried.opts.priority, failing.isSaved],
    [at, 4, true],
  );
  check(
    "and it saves again as any unchanged draft does",
    (await failing.save()) === retried,
  );
  await jobs.drain({ delayed: true });
}

/* ------------------------------------------------------------------ */
step("Saved drafts run: lower priority first, ties in order");

{
  const ordering = new BunJobs({
    namespace: exampleNamespace("draft-tour-order"),
    driver: draftDriver,
    logger: noopLogger,
  });
  const ran: string[] = [];
  ordering.define<Mail, string>("mail", async (job) => {
    ran.push(job.data.to);
    return job.data.to;
  });

  for (const [to, priority] of [
    ["p5", 5],
    ["p1", 1],
    ["p3-a", 3],
    ["p3-b", 3],
  ] as const) {
    await ordering
      .create<Mail, string>("mail", { to })
      .priority(priority)
      .save();
  }

  const worker = await ordering.start({ concurrency: 1, pollInterval: 25 });
  const results: string[] = [];
  worker.on("completed", (_job, result) => {
    results.push(result as string);
  });
  await waitFor("four drafted jobs", () => ran.length === 4, WAIT);
  checkEqual("run order", ran, ["p1", "p3-a", "p3-b", "p5"]);
  await waitFor("four completed events", () => results.length === 4, WAIT);
  checkEqual("completed events carry each result", results, ran);

  await ordering.stop();
  await ordering.purge();
  await ordering.close();
}

await jobs.purge();
await jobs.close();
await draftDriver.close();
opened.splice(
  opened.findIndex((entry) => entry.jobs === jobs),
  1,
);

/* ------------------------------------------------------------------ */
step("processEvery(): what it reads, and what it refuses");

{
  const ctx = await spiedContext("every-read");
  ctx.jobs.define("tick", async () => null);

  for (const [input, expected] of [
    [1_500, 1_500],
    ["250ms", 250],
    ["every 2 seconds", 2_000],
    ["1m 30s", 90_000],
    [MAX_TIMER_MS, MAX_TIMER_MS],
  ] as const) {
    check(
      `processEvery(${JSON.stringify(input)}) chains`,
      ctx.jobs.processEvery(input) === ctx.jobs,
    );
    const worker = await ctx.jobs.start();
    checkEqual(
      `processEvery(${JSON.stringify(input)}): pollInterval`,
      worker.pollInterval,
      expected,
    );
    await ctx.jobs.stop();
  }

  ctx.jobs.processEvery(400);
  for (const bad of [0, -5, Number.NaN, Infinity, "whenever", "0s", ""]) {
    await checkRejects(
      `processEvery(${typeof bad === "number" ? String(bad) : JSON.stringify(bad)})`,
      () => ctx.jobs.processEvery(bad),
      { name: "ConfigError", code: "CONFIG", message: /processEvery\(\)/ },
    );
  }
  for (const tooLong of ["30 days", MAX_TIMER_MS + 1]) {
    const error = await checkRejects(
      `processEvery(${JSON.stringify(tooLong)}): longer than a timer can wait`,
      () => ctx.jobs.processEvery(tooLong),
      { name: "ConfigError", code: "CONFIG", message: TOO_LONG },
    );
    checkEqual(
      `processEvery(${JSON.stringify(tooLong)}): context carries the max`,
      (error as ConfigError | undefined)?.context?.max,
      MAX_TIMER_MS,
    );
    await checkRejects(
      `new BunJobs({ processEvery: ${JSON.stringify(tooLong)} })`,
      () =>
        new BunJobs({
          namespace: "draft-tour-refused",
          driver: ctx.driver,
          processEvery: tooLong,
        }),
      { name: "ConfigError", message: TOO_LONG },
    );
  }
  for (const bad of [0, -1, Number.NaN, "whenever", "0s"]) {
    await checkRejects(
      `new BunJobs({ processEvery: ${typeof bad === "number" ? String(bad) : JSON.stringify(bad)} })`,
      () =>
        new BunJobs({
          namespace: "draft-tour-refused",
          driver: ctx.driver,
          processEvery: bad,
        }),
      { name: "ConfigError", code: "CONFIG", message: /processEvery\(\)/ },
    );
  }
  const worker = await ctx.jobs.start();
  checkEqual(
    "a refused call leaves the last good value in place",
    worker.pollInterval,
    400,
  );

  await ctx.jobs.stop();
  const waitsBefore = ctx.waits.length;
  ctx.jobs.processEvery(MAX_TIMER_MS);
  await ctx.jobs.start();
  await waitFor("a first wait", () => ctx.waits.length > waitsBefore, WAIT);
  check(
    "at the longest interval it waits rather than spins",
    (await countOver(ctx.waits, 300)) <= 2,
  );
  await dispose(ctx);
}

/* ------------------------------------------------------------------ */
step("processEveryMs: what was asked for, readable before start()");

{
  const unset = await spiedContext("every-ms-unset");
  checkEqual(
    "never set: undefined, leaving the worker its own defaults",
    unset.jobs.processEveryMs,
    undefined,
  );
  await dispose(unset);

  const optioned = await spiedContext("every-ms-option", {
    processEvery: "90 seconds",
  });
  checkEqual(
    'the processEvery option: "90 seconds" reads back as ms, before start()',
    optioned.jobs.processEveryMs,
    90_000,
  );
  optioned.jobs.processEvery("250ms");
  checkEqual(
    "processEvery(): the later call wins",
    optioned.jobs.processEveryMs,
    250,
  );
  await caught(() => optioned.jobs.processEvery("whenever"));
  checkEqual(
    "a refused call leaves it as it was",
    optioned.jobs.processEveryMs,
    250,
  );

  // It reports what was *asked for*. start()'s own pollInterval wins over it
  // for that worker, and the getter does not pretend otherwise.
  optioned.jobs.define("tick", async () => null);
  const worker = await optioned.jobs.start({ pollInterval: 999 });
  checkEqual(
    "start({ pollInterval }): the worker uses 999, processEveryMs still says 250",
    [worker.pollInterval, optioned.jobs.processEveryMs],
    [999, 250],
  );
  await dispose(optioned);
}

/* ------------------------------------------------------------------ */
step("processEvery: never set, the option, start() options, later calls");

{
  const plain = await spiedContext("every-plain");
  plain.jobs.define("tick", async () => null);
  const blocking = plain.driver.capabilities.blockingWait;
  show("driver", { name: plain.driver.name, blockingWait: blocking });

  const defaults = await plain.jobs.start();
  checkEqual(
    "never set: the worker's defaults",
    [defaults.pollInterval, defaults.maxBlock],
    [1_000, 5_000],
  );
  await waitFor("a first wait", () => plain.waits.length > 0, WAIT);
  checkEqual(
    "never set: waits use maxBlock on a blocking driver, pollInterval elsewhere",
    plain.waits[0]!.ms,
    blocking ? 5_000 : 1_000,
  );

  await plain.jobs.stop();
  plain.jobs.processEvery(70);
  const restarted = await plain.jobs.start();
  check("stop() then start(): a new worker", restarted !== defaults);
  checkEqual(
    "processEvery() between stop() and start() reaches the next worker",
    restarted.pollInterval,
    70,
  );
  await dispose(plain);

  const option = await spiedContext("every-option", { processEvery: "250ms" });
  option.jobs.define("tick", async () => null);
  const fromOption = await option.jobs.start();
  checkEqual(
    "the processEvery option: pollInterval, and maxBlock only where it blocks",
    [fromOption.pollInterval, fromOption.maxBlock],
    [250, blocking ? 250 : 5_000],
  );

  await option.jobs.stop();
  const explicit = await option.jobs.start({ pollInterval: 40, maxBlock: 60 });
  checkEqual(
    "start({ pollInterval, maxBlock }) wins over the option",
    [explicit.pollInterval, explicit.maxBlock],
    [40, 60],
  );
  option.jobs.processEvery(90);
  checkEqual(
    "a later processEvery() wins over start()'s options, on the running worker",
    [explicit.pollInterval, explicit.maxBlock],
    [90, blocking ? 90 : 60],
  );

  await option.jobs.stop();
  const partly = await option.jobs.start({ pollInterval: 40 });
  checkEqual(
    "start({ pollInterval }) alone: maxBlock still follows processEvery where it blocks",
    [partly.pollInterval, partly.maxBlock],
    [40, blocking ? 90 : 5_000],
  );
  await dispose(option);
}

/* ------------------------------------------------------------------ */
step("BunQueueWorker: pollInterval and maxBlock at runtime");

{
  const ctx = await spiedContext("every-worker");
  const worker = ctx.jobs.worker("plain", async () => null);
  checkEqual(
    "getters: the defaults",
    [worker.pollInterval, worker.maxBlock],
    [1_000, 5_000],
  );

  for (const [label, set] of [
    ["pollInterval = 0", () => (worker.pollInterval = 0)],
    ["pollInterval = -1", () => (worker.pollInterval = -1)],
    ["maxBlock = NaN", () => (worker.maxBlock = Number.NaN)],
    ["maxBlock = Infinity", () => (worker.maxBlock = Infinity)],
  ] as const) {
    await checkRejects(label, set, {
      name: "ConfigError",
      code: "CONFIG",
      message: /positive number of milliseconds/,
    });
  }
  for (const [label, set] of [
    ["pollInterval = MAX + 1", () => (worker.pollInterval = MAX_TIMER_MS + 1)],
    ["maxBlock = MAX + 1", () => (worker.maxBlock = MAX_TIMER_MS + 1)],
  ] as const) {
    await checkRejects(label, set, {
      name: "ConfigError",
      code: "CONFIG",
      message: TOO_LONG,
    });
  }
  checkEqual(
    "refused values leave both unchanged",
    [worker.pollInterval, worker.maxBlock],
    [1_000, 5_000],
  );
  worker.pollInterval = MAX_TIMER_MS;
  worker.maxBlock = MAX_TIMER_MS;
  checkEqual(
    "the longest a timer can wait is accepted",
    [worker.pollInterval, worker.maxBlock],
    [MAX_TIMER_MS, MAX_TIMER_MS],
  );

  worker.pollInterval = 10;
  checkEqual(
    "a worker never run: the value is stored, no promotion timer is armed",
    [worker.pollInterval, await countOver(ctx.promotions, 200)],
    [10, 0],
  );

  const closed = ctx.jobs.worker("closed", async () => null);
  void closed.run();
  await waitFor("the worker to run", () => closed.isRunning, WAIT);
  await closed.close();
  await Bun.sleep(50);
  closed.pollInterval = 10;
  checkEqual(
    "a closed worker: setting it arms nothing",
    await countOver(ctx.promotions, 200),
    0,
  );

  const gate = Promise.withResolvers<void>();
  const closing = ctx.jobs.worker("closing", async () => {
    await gate.promise;
  });
  void closing.run();
  const closingQueue = ctx.jobs.queue("closing");
  await closingQueue.add("hold", {});
  await waitFor("the held job", () => closing.activeCount === 1, WAIT);
  const closeDone = closing.close();
  await Bun.sleep(20);
  closing.pollInterval = 10;
  closing.maxBlock = 10;
  checkEqual(
    "a closing worker: setters are stored",
    [closing.pollInterval, closing.maxBlock],
    [10, 10],
  );
  checkEqual(
    "a closing worker: setters arm nothing",
    await countOver(ctx.promotions, 200),
    0,
  );
  const late = await closingQueue.add("late", {});
  gate.resolve();
  await closeDone;
  checkEqual(
    "a closing worker claims nothing new, whatever its interval",
    [closing.isRunning, (await closingQueue.getJob(late.id))?.state],
    [false, "waiting"],
  );
  await dispose(ctx);
}

/* ------------------------------------------------------------------ */
step("BunQueueWorker.run(): a failed connect resets, and can be retried");

{
  const driver = createDriver(exampleDriver());
  const promotions: number[] = [];
  const promote = driver.promoteDelayed.bind(driver);
  driver.promoteDelayed = async (q, now, limit) => {
    promotions.push(Date.now());
    return await promote(q, now, limit);
  };
  const connect = driver.connect.bind(driver);
  let connects = 0;
  let unreachable = true;
  driver.connect = async () => {
    connects++;
    if (unreachable) {
      await Bun.sleep(50);
      throw new Error("backend unreachable");
    }
    await connect();
  };

  const worker = new BunQueueWorker("unreachable", async () => null, {
    namespace: exampleNamespace("draft-tour-connect"),
    driver,
    logger: noopLogger,
  });
  const readies: number[] = [];
  worker.on("ready", () => readies.push(Date.now()));

  const running = caught(() => worker.run());
  worker.pollInterval = 10; // while run() is still connecting
  const failure = await running;
  checkEqual(
    "run() rethrows the connect failure",
    (failure as Error | undefined)?.message,
    "backend unreachable",
  );
  checkEqual(
    "and resets: not running, no ready event, no promotion timer",
    [worker.isRunning, readies.length, await countOver(promotions, 300)],
    [false, 0, 0],
  );

  const retry = await caught(() => worker.run());
  checkEqual(
    "run() again connects again rather than joining the dead start",
    [(retry as Error | undefined)?.message, connects],
    ["backend unreachable", 2],
  );

  // The very worker whose start failed twice, once the backend is reachable.
  unreachable = false;
  const connectsBeforeRetry = connects;
  void worker.run();
  await waitFor(
    "the failed worker to start on retry",
    () => readies.length === 1,
    WAIT,
  );
  checkEqual(
    "a later run() starts the worker, keeping the interval set during the failure",
    [worker.isRunning, worker.pollInterval],
    [true, 10],
  );
  // At least one more connect: a SQL, MongoDB or Redis driver's own methods
  // also call `connect()`, so the exact count past the retry is the driver's.
  check("the later run() connected again", connects > connectsBeforeRetry, {
    connectsBeforeRetry,
    connects,
  });
  await worker.close();

  // A second worker whose start failed: close() must not wait for a loop
  // that never started.
  unreachable = true;
  const stranded = new BunQueueWorker("stranded", async () => null, {
    namespace: exampleNamespace("draft-tour-connect"),
    driver,
    logger: noopLogger,
  });
  await caught(() => stranded.run());
  const outcome = await Promise.race([
    stranded.close().then(() => "closed" as const),
    Bun.sleep(1_000).then(() => "hung" as const),
  ]);
  checkEqual(
    "close() after a failed start does not hang",
    [outcome, stranded.isRunning],
    ["closed", false],
  );
  unreachable = false;
  await driver.purge(exampleNamespace("draft-tour-connect")).catch(() => {});
  await driver.close();
}

/* ------------------------------------------------------------------ */
step(
  "A wait in progress: cut short when polling, left to finish when blocking",
);

{
  const ctx = await spiedContext("every-wait");
  const ran: unknown[] = [];
  ctx.jobs.define<Mail>("tick", async (job) => {
    ran.push(job.data);
  });
  const blocking = ctx.driver.capabilities.blockingWait;

  if (!blocking) {
    const worker = await ctx.jobs.start({ pollInterval: 30_000 });
    await waitFor(
      "a 30-second wait",
      () => ctx.waits.some((call) => call.ms === 30_000),
      WAIT,
    );
    const changedAt = Date.now();
    ctx.jobs.processEvery(30);
    let cut = true;
    await waitFor(
      "a new, short wait",
      () => ctx.waits.some((call) => call.at >= changedAt && call.ms <= 30),
      { timeout: 1_500 },
    ).catch(() => {
      cut = false;
    });
    check(
      "polling driver: the 30s wait was cut short",
      cut,
      ctx.waits.slice(-5),
    );
    checkEqual("polling driver: maxBlock untouched", worker.maxBlock, 5_000);
  } else {
    await ctx.jobs.start();
    await waitFor("a first wait", () => ctx.waits.length > 0, WAIT);
    await Bun.sleep(50);
    const changedAt = Date.now();
    ctx.jobs.processEvery(30);
    checkEqual(
      "blocking driver: the wait in progress is left to finish",
      await countOver(ctx.waits, 300),
      0,
    );
    await ctx.jobs.now<Mail>("tick", { to: "wake" });
    await waitFor("the waking job", () => ran.length === 1, WAIT);
    let next = true;
    await waitFor(
      "the next wait at the new value",
      () => ctx.waits.some((call) => call.at >= changedAt && call.ms <= 30),
      { timeout: 3_000 },
    ).catch(() => {
      next = false;
    });
    check(
      "blocking driver: the next wait uses the new value",
      next,
      ctx.waits.slice(-5),
    );
  }
  await dispose(ctx);
}

/* ------------------------------------------------------------------ */
step(
  "A new job is picked up at once, even after raising the interval mid-wait",
);

{
  const ctx = await spiedContext("every-new-job");
  const ran: number[] = [];
  ctx.jobs.define("tick", async () => {
    ran.push(Date.now());
  });
  await ctx.jobs.start();
  await waitFor("a first wait", () => ctx.waits.length > 0, WAIT);
  await Bun.sleep(100);

  ctx.jobs.processEvery("1 minute");
  await Bun.sleep(20);
  const addedAt = Date.now();
  await ctx.jobs.now("tick");
  let picked = true;
  await waitFor("the new job", () => ran.length === 1, {
    timeout: 1_500,
  }).catch(() => {
    picked = false;
  });
  check('processEvery("1 minute"): a new job still runs within 1.5s', picked, {
    waitedMs: Date.now() - addedAt,
  });
  if (picked) show("picked up after", `${ran[0]! - addedAt}ms`);
  await dispose(ctx);
}

/* ------------------------------------------------------------------ */
step(
  "The promotion sweep follows, capped at once a second; other sweeps do not",
);

{
  const ctx = await spiedContext("every-cadence");
  const gate = Promise.withResolvers<void>();
  ctx.jobs.define("hold", async () => {
    await gate.promise;
  });
  const worker = await ctx.jobs.start({ concurrency: 1 });
  // Full, so the loop waits for a slot and never promotes on its own: every
  // call counted below is the sweep's.
  await ctx.jobs.now("hold");
  await waitFor("the held job", () => worker.activeCount === 1, WAIT);
  await Bun.sleep(150);

  const atDefault = await countOver(ctx.promotions, 1_100);
  check("default: about once a second", atDefault <= 2, atDefault);

  const stallsBefore = ctx.stalls.length;
  const prunesBefore = ctx.prunes.length;
  ctx.jobs.processEvery(50);
  const fast = await countOver(ctx.promotions, 1_000);
  check("processEvery(50): the sweep runs at that cadence", fast >= 8, fast);
  checkEqual(
    "processEvery(50): the stalled sweep and housekeeping keep their intervals",
    [ctx.stalls.length - stallsBefore, ctx.prunes.length - prunesBefore],
    [0, 0],
  );

  ctx.jobs.processEvery(5_000);
  await Bun.sleep(150);
  const capped = await countOver(ctx.promotions, 1_100);
  check(
    "processEvery(5000): back to the once-a-second cap, the 50ms timer gone",
    capped >= 1 && capped <= 2,
    capped,
  );
  gate.resolve();
  await dispose(ctx);
}

/* ------------------------------------------------------------------ */
step("Interactions: pause and resume, a paused queue");

{
  const ctx = await spiedContext("every-pause", { processEvery: "2 seconds" });
  const ran: string[] = [];
  ctx.jobs.define<Mail>("tick", async (job) => {
    ran.push(job.data.to);
  });
  const worker = await ctx.jobs.start();
  const events: string[] = [];
  worker.on("paused", () => events.push("paused"));
  worker.on("resumed", () => events.push("resumed"));

  await worker.pause();
  ctx.jobs.processEvery(40);
  checkEqual(
    "processEvery() while paused: applied, still paused",
    [worker.pollInterval, worker.isPaused()],
    [40, true],
  );
  await ctx.jobs.now<Mail>("tick", { to: "while-paused" });
  await Bun.sleep(400);
  checkEqual("a paused worker claims nothing", ran, []);

  const resumedAt = Date.now();
  worker.resume();
  await waitFor("the job after resume", () => ran.length === 1, WAIT);
  check("resume() picks it up promptly", Date.now() - resumedAt < 1_500, {
    ms: Date.now() - resumedAt,
  });
  checkEqual("paused and resumed events", events, ["paused", "resumed"]);

  const registry = ctx.jobs.queue<Mail>("jobs");
  await registry.pause();
  // Past the worker's one-second pause cache, so it has seen the pause.
  await Bun.sleep(1_300);
  await ctx.jobs.now<Mail>("tick", { to: "queue-paused" });
  await Bun.sleep(400);
  checkEqual("a paused queue: nothing claimed", ran.length, 1);
  await registry.resume();
  const queueResumedAt = Date.now();
  await waitFor(
    "the job after the queue resumes",
    () => ran.length === 2,
    WAIT,
  );
  check(
    "a resumed queue: picked up within the pause cache plus the interval",
    Date.now() - queueResumedAt < 3_000,
    { ms: Date.now() - queueResumedAt },
  );
  await dispose(ctx);
}

/* ------------------------------------------------------------------ */
step("Redis: a block is also capped by maxBlockSeconds");

const redisBase = exampleDriver();
if (redisBase.type === "redis") {
  const ctx = await spiedContext("every-redis-cap", {
    processEvery: "1 minute",
    // An instance, because `maxBlockSeconds` is a `RedisDriver` option the
    // `{ type: "redis" }` config does not carry. A short cap, so a
    // minute-long wait visibly re-checks at it.
    driver: new RedisDriver({
      url: redisBase.url,
      keyPrefix: redisBase.keyPrefix,
      maxBlockSeconds: 0.2,
    }),
  });
  ctx.jobs.define("tick", async () => null);
  const worker = await ctx.jobs.start();
  checkEqual("maxBlock follows processEvery", worker.maxBlock, MINUTE);
  await waitFor("a first wait", () => ctx.waits.length > 0, WAIT);
  const blocks = await countOver(ctx.waits, 1_200);
  check(
    "each 1-minute wait re-checks at the 0.2s cap",
    blocks >= 3 && ctx.waits.every((call) => call.ms <= MINUTE),
    { blocks, budgets: ctx.waits.slice(-3).map((call) => call.ms) },
  );
  await dispose(ctx);
} else {
  show(`not redis (${exampleBackend()}): nothing to check here`);
}

/* ------------------------------------------------------------------ */
step("Clean up");

for (const entry of [...opened]) {
  await dispose(entry);
}

summary();
