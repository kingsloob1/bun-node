import type {
  BackoffStrategy,
  BunJobs,
  BunQueueWorker,
  DeadLetter,
  Job,
} from "@kingsleyweb/bun-jobs";

/**
 * Every way bun-jobs lets you say *when*, *how often* and *what if it fails*,
 * one seeded job per answer, on two queues of their own:
 *
 * | Queue          | Worker (stable key)            | What it is for |
 * |----------------|--------------------------------|----------------|
 * | `notifications`| `api.notifications.scheduler`  | one job at a time, so the order the queue chose is legible |
 * | `dead-letters` | `api.dead-letters.archive`     | where a job that died is filed, from here and from `previews` |
 *
 * The seeds below are grouped by the option they exist to show, and each one
 * says what to look for. Nothing here repeats faster than every two minutes,
 * so `PLAYGROUND_INTERVAL_MS=0` stays a quiet, complete picture.
 *
 * Where to look: Queues → `notifications` (the job list's *Delayed* tab holds
 * the delayed, scheduled and debounced ones), Queues → `notifications` →
 * Repeatables for the six series, and Queues → `dead-letters` for the
 * letters.
 */

/** What a notification job carries. */
export interface NotificationData {
  /** What the job is pretending to do; the first line of its log. */
  about: string;
  /** How long the work takes, in ms. Defaults to `300`. */
  ms?: number;
  /** Fails every attempt with this message, so retries and backoff are visible. */
  fail?: string;
  /** Writes this many extra log lines, so `keepLogs` has something to trim. */
  chatter?: number;
}

/** What a notification job answers with. */
export interface NotificationResult {
  /** What it did. */
  about: string;
  /** Which attempt finally worked. */
  attempt: number;
}

/** The scheduling queues' workers, for the caller to close with the rest. */
export interface ScheduledWorld {
  /** The workers this module started. */
  workers: BunQueueWorker<any, any>[];
  /** Adds one ordinary notification, for the producer to call now and then. */
  addNotification: () => Promise<unknown>;
}

/** Waits `ms`, resolving early when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** A random element. */
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

const CHANNELS = ["push", "sms", "in-app", "slack"];

/** Creates the scheduling queues, starts their workers, and seeds every mode. */
export async function startScheduling(jobs: BunJobs): Promise<ScheduledWorld> {
  const notifications = jobs.queue<NotificationData, NotificationResult>(
    "notifications",
  );
  // `dead-letters` is not opened here: nothing produces to it directly. It is
  // created by the first letter filed into it — which, with the seeds below
  // and the corrupt preview in `targets.ts`, is a few seconds away.

  /**
   * A custom backoff, resolved by name on the worker below.
   *
   * A job's options are stored — in a row, a hash, a document — and read back
   * by whichever process claims it, so a *function* cannot be among them. The
   * job says `backoff: { type: "triage" }` and this is where that name means
   * something. Returning `false` stops the retries whatever `attempts` says.
   */
  const triage: Record<string, BackoffStrategy> = {
    triage: ({ attempt }) => {
      // Fast once (a blip), then slowly (something is actually down), then
      // give up rather than burning the remaining attempts on the same wall.
      const ladder = [1_000, 10_000, 60_000];
      return ladder[attempt - 1] ?? false;
    },
  };

  const scheduler = jobs.worker<NotificationData, NotificationResult>(
    "notifications",
    async (job: Job<NotificationData, NotificationResult>, ctx) => {
      await job.log(
        `attempt ${ctx.attempt}: ${job.data.about} (priority ${job.priority})`,
      );
      for (let line = 1; line <= (job.data.chatter ?? 0); line++) {
        await job.log(`chatter ${line} of ${job.data.chatter}`);
      }
      await sleep(job.data.ms ?? 300, ctx.signal);
      if (ctx.signal.aborted) {
        // The worker has already failed this attempt (a timeout, a close or a
        // lost lock); unwinding rather than reporting success keeps the two
        // stories the same.
        throw new Error(`${job.data.about} was cut short`);
      }
      if (job.data.fail !== undefined) {
        throw new Error(job.data.fail);
      }
      return { about: job.data.about, attempt: ctx.attempt };
    },
    {
      // One at a time, on purpose: the order jobs come out in is then the
      // order the queue chose, which is what makes the `priority` seeds below
      // legible. Every other worker in the playground runs several at once.
      concurrency: 1,
      // Where `backoff: { type: "triage" }` is resolved.
      backoffStrategies: triage,
      // Jobs that exhaust their attempts here are filed as letters, unless
      // they name a `deadLetter` of their own (one seed below does).
      deadLetterQueue: "dead-letters",
      // `drained` only after a second of quiet. With one job at a time and a
      // seed full of short jobs, the default `0` would emit it in every gap.
      drainDelay: 1_000,
      // Writes its heartbeat record twice as often as the default 10 s, so the
      // Workers page keeps up while you drive its buttons.
      reportInterval: 5_000,
      // The object form, spelled out. `BunJobs` already turns remote control
      // on; subscribing (rather than polling) makes a Pause from the UI land
      // in tens of milliseconds on every driver, and `interval` is the
      // fallback read for the drivers where a subscription is itself a poll.
      control: { enabled: true, subscribe: true, interval: 1_000 },
      // A Stop from the UI is recorded against the *key*, so it survives a
      // restart of the playground and would reach every replica carrying that
      // key — and `stopPersistenceOverridable` lets the Stop dialog offer the
      // other choice ("until this process restarts") instead.
      stopPersistence: "key",
      stopPersistenceOverridable: true,
      name: "scheduler",
    },
  );

  const archive = jobs.worker<DeadLetter<unknown>, { filed: string }>(
    "dead-letters",
    async (job: Job<DeadLetter<unknown>, { filed: string }>) => {
      const letter = job.data;
      await job.log(
        `${letter.queue}/${letter.id} (${letter.name}) died after ${letter.attemptsMade} attempts: ${letter.failedReason.message}`,
      );
      return { filed: `${letter.queue}/${letter.id}` };
    },
    {
      concurrency: 1,
      // Normally inherited from `BunJobs` (`service: "api"`); named here to
      // show what the first segment of a derived key comes from.
      service: "api",
      // Set outright rather than derived, which is the reason the option
      // exists: an operator reading a settings override sees a name they
      // recognise instead of `api.dead-letters.1`.
      key: "api.dead-letters.archive",
      // It writes one short job per death, so a per-worker analytics series
      // for it is all overhead. `{ workers: false }` is the first lever to
      // reach for on a real fleet, where workers are the term that grows.
      metrics: { workers: false },
      // The only worker on `dead-letters`, and it opts out of housekeeping —
      // so this queue has nobody pruning expired results or healing repeat
      // series, and its Workers panel says so. That note is what this setting
      // is here to show.
      //
      // Safe to demonstrate since bun-jobs #121: `maintenance` decides the
      // housekeeping pass alone. Delayed jobs are still promoted and stalled
      // ones recovered on every worker, whatever it says — which is why a
      // dead letter added here is still archived. Before #121 this same line
      // stranded jobs on `imports` (see `targets.ts`).
      maintenance: false,
    },
  );

  // Started at the very end of this function, after every seed below has
  // landed. Started first, the worker claims the first job the moment it is
  // added, and the `priority` seeds then read as an argument against
  // priorities: the one that happened to be alone in the queue goes first,
  // whatever its number.

  /** Adds one ordinary notification. */
  const addNotification = async () =>
    await notifications.add("notify", {
      about: `${pick(CHANNELS)} to ${pick(["ada", "grace", "alan"])}`,
      ms: 200 + Math.floor(Math.random() * 400),
    });

  // ----- when it may run ------------------------------------------------

  // `priority`: lower runs first, ties break FIFO. Added worst-first, so the
  // job list proves the queue reordered them rather than keeping the order
  // they arrived in. Visible because this worker runs one job at a time.
  for (const [priority, about] of [
    [20, "priority 20 — the nightly digest, whenever"],
    [10, "priority 10 — a marketing blast"],
    [1, "priority 1 — a two-factor code, ahead of everything"],
  ] as const) {
    await notifications.add("notify", { about, ms: 800 }, { priority });
  }

  // `delay`: milliseconds from now. Sits in Delayed until then.
  await notifications.add(
    "notify",
    { about: "delay — a receipt, 45 s after the payment" },
    { delay: 45_000 },
  );

  // `runAt`: an absolute instant, and it **wins over `delay`** — both are
  // given here, and the job runs in ten minutes, not in one second.
  await notifications.add(
    "notify",
    { about: "runAt — a reminder at a fixed time, not a delay from now" },
    { delay: 1_000, runAt: new Date(Date.now() + 10 * 60_000) },
  );

  // `jobId`: the id is also the idempotency key. The second add returns the
  // first job untouched — same id, one job, and the second payload is
  // discarded rather than queued.
  const first = await notifications.add(
    "notify",
    { about: "jobId — added once" },
    { jobId: "welcome-ada" },
  );
  const again = await notifications.add(
    "notify",
    { about: "jobId — added twice, and this text never reaches the queue" },
    { jobId: "welcome-ada" },
  );
  // Written onto the job the second add answered with, so the evidence is on
  // the job's own screen: the same id came back, and its payload still says
  // "added once".
  await again.log(
    `added twice under jobId "welcome-ada": the second add answered with ${
      first.id === again.id ? "the same job" : "a second job, which is a bug"
    }, untouched`,
  );

  // `debounce`: one pending job per id, and each add pushes it back to `ttl`
  // from now with the newest payload. Three adds, one job, running 20 s after
  // the last of them — which is what "settle down before you run" looks like.
  for (const term of ["dogs", "dog food", "dog food delivery"]) {
    await notifications.add(
      "notify",
      { about: `debounce — reindex search for "${term}"` },
      { debounce: { id: "search-reindex", ttl: "20 seconds" } },
    );
  }

  // `throttle`: at most one job per id per window; an add inside it adds
  // nothing and answers with the job that opened the window. Three adds, one
  // job, and this one runs now rather than at the end.
  for (let i = 1; i <= 3; i++) {
    await notifications.add(
      "notify",
      { about: `throttle — status page ping ${i}` },
      { throttle: { id: "status-page", ttl: "1 minute" } },
    );
  }

  // ----- what if it fails -----------------------------------------------

  // `attempts` with a **fixed number** of milliseconds: 4 s between each of
  // the three attempts, then the job is dead.
  await notifications.add(
    "notify",
    { about: "backoff 4000 — fixed, three attempts", fail: "carrier timeout" },
    { attempts: 3, backoff: 4_000 },
  );

  // `attempts` with an **exponential** schedule: 2 s, 4 s, 8 s, capped at
  // 30 s, ±20% so a thousand of these would not all retry on the same tick.
  await notifications.add(
    "notify",
    {
      about: "backoff exponential — 2 s, 4 s, 8 s, ±20%",
      fail: "503 upstream",
    },
    {
      attempts: 4,
      backoff: { type: "exponential", delay: 2_000, max: 30_000, jitter: 0.2 },
    },
  );

  // `attempts` with a **custom strategy**, named here and resolved on the
  // worker above: 1 s, then 10 s, then the strategy says `false` and the job
  // dies with an attempt still unused.
  await notifications.add(
    "notify",
    {
      about: "backoff triage — custom strategy, gives up early",
      fail: "pager down",
    },
    { attempts: 5, backoff: { type: "triage" } },
  );

  // `timeout`: a per-attempt clock. The work takes 6 s against a 1.5 s
  // timeout, so every attempt fails with a `JobTimeoutError`.
  await notifications.add(
    "notify",
    { about: "timeout — 6 s of work against a 1.5 s limit", ms: 6_000 },
    { timeout: 1_500, attempts: 2, backoff: 3_000 },
  );

  // `deadLetter`: this job's own, which wins over the worker's
  // `deadLetterQueue`. It dies on its only attempt and a letter carrying its
  // id, payload and error turns up in `dead-letters`.
  await notifications.add(
    "notify",
    {
      about: "deadLetter — filed in dead-letters when it dies",
      fail: "no route to carrier",
    },
    { attempts: 1, deadLetter: "dead-letters" },
  );

  // ----- what is kept ---------------------------------------------------

  // `removeOnComplete` as a **TTL**: the job's copy is kept for two minutes
  // after it completes and then swept. Watch the completed count on this
  // queue fall by three a couple of minutes in.
  //
  // The `{ count }` form is deliberately *not* used here, and the reason is
  // worth knowing: a count sweeps the **whole queue's** finished set down to
  // that many, not this job's own copies. On a queue shared by a dozen
  // demonstrations it would quietly delete the other eleven. `imports`, in
  // `targets.ts`, is where the count form is shown — nothing else runs there.
  for (let i = 1; i <= 3; i++) {
    await notifications.add(
      "notify",
      { about: `removeOnComplete — copy ${i} of 3, kept for two minutes` },
      // `removeOnFail: false` is the default, spelled out beside its opposite:
      // a job that dies is kept until somebody looks at it.
      { removeOnComplete: { ttl: 120_000 }, removeOnFail: false },
    );
  }

  // `removeOnComplete: true` / `removeOnFail: true`: remove the copy the
  // instant it settles. Two jobs are added here and neither is ever in the job
  // list — one succeeds, one dies. All the first leaves behind is a tick on
  // the queue's throughput; the second still files its letter in
  // `dead-letters` first, which is the point of filing one. It is what a
  // high-volume queue does when the outcome is written somewhere else already.
  await notifications.add(
    "notify",
    { about: "removeOnComplete true — gone the moment it succeeds" },
    { removeOnComplete: true },
  );
  await notifications.add(
    "notify",
    {
      about: "removeOnFail true — gone the moment it dies",
      fail: "nobody will ever read this",
    },
    { attempts: 1, removeOnFail: true },
  );

  // `keepLogs`: the log keeps the newest N lines and drops the rest. This one
  // writes 21 (the opening line plus 20 of chatter) and keeps 5.
  await notifications.add(
    "notify",
    { about: "keepLogs 5 — writes 21 lines, keeps the last 5", chatter: 20 },
    { keepLogs: 5 },
  );

  // `keepStacktraces`: a job keeps the traces of its last N failures rather
  // than all of them. Four attempts, two traces on the failure panel.
  await notifications.add(
    "notify",
    {
      about: "keepStacktraces 2 — four attempts, the last two traces",
      fail: "the same wall, again",
    },
    { attempts: 4, backoff: 2_000, keepStacktraces: 2 },
  );

  // ----- flows ----------------------------------------------------------

  // A flow: the parent is added `waiting-children` and runs once both children
  // have settled, reading their results with `job.getChildrenValues()`.
  //
  // - `render-cover` is in **another queue** (`previews`), where an off-thread
  //   worker runs it — a flow spans the queues of one namespace.
  // - `lint-notes` **always fails**, and `ignoreFailure` says the parent
  //   carries on anyway, with the failure available beside the other child's
  //   result instead of killing the flow.
  await notifications.addFlow({
    name: "publish-release",
    data: { about: "flow — publish the release once both children settle" },
    opts: { jobId: "publish-release-2026-09" },
    children: [
      {
        name: "render-cover",
        data: { asset: "release-notes-cover.png", flakiness: 0 },
        queue: "previews",
        opts: { attempts: 3, backoff: { type: "decode-ramp" } },
      },
      {
        name: "lint-notes",
        data: {
          about: "flow child — fails, and is ignored",
          fail: "two typos",
        },
        opts: { attempts: 1, ignoreFailure: true },
      },
    ],
  });

  // ----- repeats --------------------------------------------------------

  // `cron` with `tz`: a wall-clock schedule that survives a daylight-saving
  // change, which a fixed interval cannot. Five fields; six would start with
  // seconds.
  await notifications.add(
    "notify",
    { about: "repeat cron — every fifth minute, London time" },
    {
      repeat: {
        cron: "*/5 * * * *",
        tz: "Europe/London",
        key: "cron-five-minutely",
      },
    },
  );

  // `every` as a **duration in milliseconds**: the plainest form.
  await notifications.add(
    "notify",
    { about: "repeat every 180000 — milliseconds" },
    { repeat: { every: 180_000, key: "every-three-minutes" } },
  );

  // `every` as a **phrase**: read when the job is added. "every other minute"
  // is two minutes; "daily", "fortnightly" and "every 2 weeks" read too. A
  // phrase that names *dates* ("starting 1st december") needs the optional
  // `chrono-node`; an interval alone never loads it.
  await notifications.add(
    "notify",
    { about: 'repeat "every other minute" — a phrase, not a number' },
    { repeat: { every: "every other minute", key: "every-other-minute" } },
  );

  // `startAt` / `endAt` / `limit`: a window, and a count. This series opens in
  // 30 s, closes in ten minutes, and stops after five occurrences whichever
  // comes first — the Repeatables screen counts them down.
  //
  // Removed first, because a **persistent** driver keeps the series between
  // runs and an existing one keeps its `count`: re-adding an exhausted series
  // — five occurrences used, or its window closed — throws `ConfigError`,
  // "has no occurrences left to schedule", whatever window the new options
  // ask for. That crashed `PLAYGROUND_DRIVER=sqlite` on its second start.
  // Removing is how a series is reset, and the playground wants a fresh
  // window each run. It answers `false` when there was nothing to remove.
  await notifications.removeRepeatable("burst-window");
  await notifications.add(
    "notify",
    { about: "repeat window — five occurrences inside a ten-minute window" },
    {
      repeat: {
        every: "1 minute",
        startAt: new Date(Date.now() + 30_000),
        endAt: new Date(Date.now() + 10 * 60_000),
        limit: 5,
        key: "burst-window",
      },
    },
  );

  // `immediately`: run once as the series is created, then follow the
  // schedule. Without it the first occurrence would be ten minutes away, and a
  // health check that first reports in ten minutes is not a health check.
  await notifications.add(
    "notify",
    { about: "repeat immediately — runs now, then every ten minutes" },
    {
      repeat: { every: "10 minutes", immediately: true, key: "health-check" },
    },
  );

  // `catchUp`: replay the occurrences missed while nothing was consuming, one
  // per completion, instead of skipping to the next one. It is what a series
  // whose runs each do a bounded piece of work still owed — billing a period,
  // rolling up a day — wants, and the wrong answer for one that reports a
  // current state. Nothing is missed on a fresh start, so to see it: run with
  // `PLAYGROUND_DRIVER=sqlite`, stop the playground for ten minutes, start it
  // again, and watch this series work through the gap.
  await notifications.add(
    "notify",
    { about: "repeat catchUp — replays what was missed while it was down" },
    { repeat: { every: "5 minutes", catchUp: true, key: "usage-rollup" } },
  );

  // Now, with the whole seed in the queue (see above).
  for (const worker of [scheduler, archive]) {
    void worker.run();
  }

  return { workers: [scheduler, archive], addNotification };
}
