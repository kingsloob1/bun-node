/**
 * Option tour: the per-job methods — `fail`, `schedule`, `update`, `disable`
 * and `enable` on a `Job`, the queue's `disableRepeatable` /
 * `enableRepeatable`, what `remove` / `promote` / `retry` announce, and how
 * `progress` is typed.
 *
 * ```bash
 * bun 10-options/job-methods.ts
 * EXAMPLE_DRIVER=sqlite bun 10-options/job-methods.ts
 * ```
 *
 * Worth knowing:
 *
 * - **`job.fail(reason)` always ends in `dead`**, whatever attempts are left.
 *   Inside the processor it only records the reason, and the attempt ends that
 *   way when the processor returns or throws — the reason wins over anything
 *   thrown after it. Anywhere else it buries the job at once, an active one
 *   included: its worker learns at its next heartbeat that the lock is gone,
 *   and aborts. A string reason has no `cause`; an `Error` becomes the cause.
 * - **Failed from outside, a job is filed only in its own `deadLetter`**
 *   queue. No worker is involved, so no worker's `deadLetterQueue` is either.
 * - **Disabling a series keeps it and stops its future**: the pending
 *   occurrence is removed and nothing schedules another. Enabling schedules
 *   the next occurrence from now, and nothing missed is run. Adding the series
 *   again does not re-enable it; removing it does clear the flag.
 * - **A job view announces what it does to itself**: `remove()`, `promote()`
 *   and `retry()` emit on the queue the view came from and publish, exactly
 *   as the queue's own methods of those names do.
 */
import type { DriverEvent, Job, RunProgress } from "@kingsleyweb/bun-jobs";
import { noopLogger } from "@kingsleyweb/bun-common";
import {
  BunQueue,
  BunQueueWorker,
  createDriver,
  JobsNotifier,
} from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Option tour: the per-job methods");

const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("tour-job-methods");
/** Generous, for a busy database server. */
const WAIT = { timeout: 30_000, interval: 10 };
/** Short waits, so the tour spends its time on the work. */
const fast = { pollInterval: 10, maxBlock: 50 };

/** Every queue whose published events the tour listens to. */
const WATCHED = ["inside", "outside", "announce", "series"];

// Another process's view of the namespace, as far as events go: what the
// queues and workers below publish is what a dashboard elsewhere would hear.
const notifier = new JobsNotifier(driver, namespace, {
  queues: WATCHED,
  runners: [],
});
await notifier.start();
/** Every published event heard, in order. */
const published: DriverEvent[] = [];
notifier.on("event", (event) => {
  published.push(event);
});

/** Whether a published queue event is about job `id`. */
function isAbout(event: DriverEvent, id: string): boolean {
  if (event.kind !== "queue") {
    return false;
  }
  if (event.id === id) {
    return true;
  }
  const ids = (event.payload as { ids?: unknown }).ids;
  return Array.isArray(ids) && ids.includes(id);
}

/** The types of the published events about job `id`, in arrival order. */
function publishedTypes(id: string): string[] {
  return published
    .filter((event) => isAbout(event, id))
    .map((event) => event.type);
}

/** How many published events of `type` are about job `id`. */
function publishedCount(id: string, type: string): number {
  return publishedTypes(id).filter((name) => name === type).length;
}

/**
 * Waits until the notifier has heard `type` about job `id` — used as a
 * marker: events published before it, by the same process, have arrived too.
 */
async function heard(id: string, type: string): Promise<void> {
  await waitFor(
    `the published "${type}" of ${id}`,
    () => publishedCount(id, type) > 0,
    WAIT,
  );
}

/** Everything opened here, closed at the end in reverse. */
const closers: (() => Promise<unknown>)[] = [];

/** A queue in the tour's namespace that publishes its events. */
function queue<TData>(name: string): BunQueue<TData, unknown> {
  const opened = new BunQueue<TData, unknown>(name, {
    namespace,
    driver,
    logger: noopLogger,
    publish: true,
  });
  closers.push(() => opened.close());
  return opened;
}

/* ------------------------------------------------------------------ */
step("fail() inside the processor: dead, and the reason wins");

/** What an `inside` job asks its processor to do. */
interface InsideData {
  /** How the processor fails the job. */
  how: "string-then-throw" | "error-then-return";
}

const inside = queue<InsideData>("inside");
const insideLetters = queue<unknown>("inside-letters");
/** What each `fail()` call inside the processor answered, by job id. */
const insideAnswers = new Map<string, boolean[]>();
/** Local `failed` / `dead` events on the worker, as `type id`. */
const insideLocal: string[] = [];

const insideWorker = new BunQueueWorker<InsideData, unknown>(
  "inside",
  async (job) => {
    const answers: boolean[] = [];
    insideAnswers.set(job.id, answers);

    if (job.data.how === "string-then-throw") {
      answers.push(await job.fail("not worth retrying"));
      // A second call is not a change of mind: the first reason stands.
      answers.push(await job.fail("a change of mind"));
      // Very often the processor's own way of stopping once it has failed.
      throw new Error("thrown after fail()");
    }

    answers.push(
      await job.fail(
        new Error("card declined", { cause: new Error("gateway timeout") }),
      ),
    );
    return "returned anyway";
  },
  { namespace, driver, logger: noopLogger, publish: true, ...fast },
);
closers.push(() => insideWorker.close());
insideWorker.on("failed", (job) => insideLocal.push(`failed ${job.id}`));
insideWorker.on("dead", (job) => insideLocal.push(`dead ${job.id}`));
insideWorker.on("retrying", (job) => insideLocal.push(`retrying ${job.id}`));
void insideWorker.run();

const byString = await inside.add(
  "charge",
  { how: "string-then-throw" },
  { attempts: 3, backoff: 0, deadLetter: "inside-letters" },
);
const byError = await inside.add(
  "charge",
  { how: "error-then-return" },
  { attempts: 3, backoff: 0, deadLetter: "inside-letters" },
);
await waitFor(
  "both inside jobs to die",
  async () =>
    (await inside.getJob(byString.id))?.state === "dead" &&
    (await inside.getJob(byError.id))?.state === "dead",
  WAIT,
);
await heard(byString.id, "dead");
await heard(byError.id, "dead");

const stringDead = await inside.getJob(byString.id);
checkEqual(
  "fail() inside answered true, both times",
  insideAnswers.get(byString.id),
  [true, true],
);
checkEqual(
  "dead after one attempt of three, however many were left",
  [stringDead?.state, stringDead?.attemptsMade, stringDead?.maxAttempts],
  ["dead", 1, 3],
);
checkEqual(
  "the first reason wins over the second call and the later throw",
  [stringDead?.failedReason?.name, stringDead?.failedReason?.message],
  ["UnrecoverableJobError", "not worth retrying"],
);
checkEqual(
  "a string reason has no cause",
  stringDead?.failedReason?.cause,
  undefined,
);

const errorDead = await inside.getJob(byError.id);
const errorCause = errorDead?.failedReason?.cause as Error | undefined;
checkEqual(
  "an Error reason: its message, and the Error itself as the cause",
  [
    errorDead?.failedReason?.message,
    errorCause?.message,
    (errorCause?.cause as Error | undefined)?.message,
  ],
  ["card declined", "card declined", "gateway timeout"],
);
checkEqual(
  "and what the processor returned is discarded",
  [errorDead?.state, errorDead?.returnValue],
  ["dead", null],
);

checkEqual(
  "the worker emitted failed and dead once each, and never retrying",
  insideLocal.filter((line) => line.endsWith(byString.id)).sort(),
  [`dead ${byString.id}`, `failed ${byString.id}`],
);
checkEqual(
  "and published them once each",
  [publishedCount(byString.id, "failed"), publishedCount(byString.id, "dead")],
  [1, 1],
);

await waitFor(
  "both dead letters",
  async () => (await insideLetters.count("waiting")) === 2,
  WAIT,
);
checkEqual(
  "each is filed in the job's deadLetter queue, with the reason given",
  (await insideLetters.list("waiting"))
    .map((letter) => {
      const data = letter.data as {
        id: string;
        failedReason: { message: string };
      };
      return `${data.id === byString.id ? "string" : "error"}: ${data.failedReason.message}`;
    })
    .sort(),
  ["error: card declined", "string: not worth retrying"],
);
await insideWorker.close();

/* ------------------------------------------------------------------ */
step("fail() from outside: a pending job is buried at once");

const outside = queue<{ n: number }>("outside");
const outsideLetters = queue<unknown>("outside-letters");
const workerLetters = queue<unknown>("worker-letters");
/** Local `failed` / `dead` events, from the queue and the worker, as `who type id`. */
const outsideLocal: string[] = [];
outside.on("failed", (job) => outsideLocal.push(`queue failed ${job.id}`));
outside.on("dead", (job) => outsideLocal.push(`queue dead ${job.id}`));

const waiting = await outside.add(
  "pending",
  { n: 1 },
  { attempts: 5, deadLetter: "outside-letters" },
);
const delayed = await outside.add("pending", { n: 2 }, { delay: 60_000 });

checkEqual(
  "fail() on a waiting and a delayed job answers true",
  [
    await waiting.fail("customer cancelled"),
    await delayed.fail(new TypeError("bad input")),
  ],
  [true, true],
);
const waitingDead = await outside.getJob(waiting.id);
checkEqual(
  "dead now, without an attempt, and with no cause for a string",
  [
    waitingDead?.state,
    waitingDead?.attemptsMade,
    waitingDead?.failedReason?.name,
    waitingDead?.failedReason?.message,
    waitingDead?.failedReason?.cause,
  ],
  ["dead", 0, "UnrecoverableJobError", "customer cancelled", undefined],
);
checkEqual(
  "an Error reason is kept as the cause, its class name included",
  [
    (await outside.getJob(delayed.id))?.failedReason?.message,
    ((await outside.getJob(delayed.id))?.failedReason?.cause as Error)?.name,
  ],
  ["bad input", "TypeError"],
);
checkEqual(
  "failing it again changes nothing, and answers false",
  [
    await waiting.fail("twice"),
    (await outside.getJob(waiting.id))?.failedReason?.message,
  ],
  [false, "customer cancelled"],
);
const gone = await outside.add("pending", { n: 3 });
await gone.remove();
checkEqual("a job that is gone answers false", await gone.fail("gone"), false);
checkEqual(
  "the queue it was failed through emitted failed and dead",
  outsideLocal.filter((line) => line.endsWith(waiting.id)),
  [`queue failed ${waiting.id}`, `queue dead ${waiting.id}`],
);
await heard(waiting.id, "dead");
checkEqual(
  "and published them",
  [publishedCount(waiting.id, "failed"), publishedCount(waiting.id, "dead")],
  [1, 1],
);
checkEqual(
  "a copy is filed in the job's own deadLetter queue",
  (await outsideLetters.list("waiting")).map(
    (letter) => (letter.data as { id: string }).id,
  ),
  [waiting.id],
);

/* ------------------------------------------------------------------ */
step(
  "fail() from outside on an active job: its worker aborts at the heartbeat",
);

// The worker's own heartbeat timer is set far out, so the only heartbeat is
// the one the processor asks for: the moment the worker notices is chosen
// here, not by a clock.
let started = false;
let release!: () => void;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
/** `ctx.signal.aborted` before and after the processor's heartbeat. */
const abortedAt: boolean[] = [];
/** Set once the processor has thrown, after its heartbeat. */
let processorDone = false;

const outsideWorker = new BunQueueWorker<{ n: number }, unknown>(
  "outside",
  async (job, ctx) => {
    if (job.name !== "long") {
      return "sentinel";
    }
    started = true;
    try {
      await gate;
      abortedAt.push(ctx.signal.aborted);
      await ctx.heartbeat();
      abortedAt.push(ctx.signal.aborted);
      // A processor that notices the abort stops, typically by throwing.
      throw new Error("stopped: the lock was lost");
    } finally {
      processorDone = true;
    }
  },
  {
    namespace,
    driver,
    logger: noopLogger,
    publish: true,
    concurrency: 1,
    lockDuration: 120_000,
    heartbeatInterval: 60_000,
    deadLetterQueue: "worker-letters",
    maintenance: false,
    ...fast,
  },
);
closers.push(() => outsideWorker.close({ force: true }));
/** Local events on the worker, as `worker type id`. */
const lockLost: string[] = [];
outsideWorker.on("lockLost", (job) => lockLost.push(job.id));
/** Records one local worker event about `job`. */
const onWorker = (type: string) => (job: Job<{ n: number }, unknown>) => {
  outsideLocal.push(`worker ${type} ${job.id}`);
};
outsideWorker.on("failed", onWorker("failed"));
outsideWorker.on("dead", onWorker("dead"));
outsideWorker.on("retrying", onWorker("retrying"));
outsideWorker.on("completed", onWorker("completed"));
void outsideWorker.run();

const long = await outside.add(
  "long",
  { n: 4 },
  { attempts: 3, backoff: 0, deadLetter: "outside-letters" },
);
await waitFor("the long job to start", () => started, WAIT);
const active = await outside.getJob(long.id);
checkEqual("read while it runs, it is active", active?.state, "active");
checkEqual(
  "fail() from outside, under the lock it was read with, answers true",
  await active!.fail("pulled by support"),
  true,
);
checkEqual(
  "it is dead at once, while the processor is still running",
  (await outside.getJob(long.id))?.state,
  "dead",
);

release();
await waitFor("the processor to finish", () => processorDone, WAIT);
checkEqual(
  "the processor's signal: not aborted before its heartbeat, aborted after",
  abortedAt,
  [false, true],
);
await waitFor("lockLost", () => lockLost.includes(long.id), WAIT);
check("the worker reported the lost lock", lockLost.includes(long.id));

// A job after it, on a single-slot worker: once the worker has published its
// `completed`, it has finished settling the one before.
const sentinel = await outside.add("sentinel", { n: 5 });
await heard(sentinel.id, "completed");

const longAfter = await outside.getJob(long.id);
checkEqual(
  "still dead with the reason given, and nothing more was recorded",
  [
    longAfter?.state,
    longAfter?.failedReason?.message,
    longAfter?.returnValue,
    longAfter?.attemptsMade,
  ],
  ["dead", "pulled by support", null, 1],
);
// The worker's processor then threw, after the job was buried under it: that
// must not make a second failure. Exactly once, locally and published.
checkEqual(
  "failed and dead arrive exactly once locally, from any emitter",
  outsideLocal.filter((line) => line.endsWith(long.id)).sort(),
  [`queue dead ${long.id}`, `queue failed ${long.id}`],
);
checkEqual(
  "and exactly once published, with no retrying or completed",
  publishedTypes(long.id).filter((type) =>
    ["failed", "dead", "retrying", "completed"].includes(type),
  ),
  ["failed", "dead"],
);
checkEqual(
  "one letter, in the job's deadLetter: none from the worker's second report, none in its deadLetterQueue",
  [
    (await outsideLetters.list("waiting")).filter(
      (letter) => (letter.data as { id: string }).id === long.id,
    ).length,
    await workerLetters.count("waiting"),
  ],
  [1, 0],
);
checkEqual(
  "the worker whose failure was refused reported lockLost, and no failed, dead, retrying or completed",
  [
    lockLost.includes(long.id),
    outsideLocal.filter(
      (line) => line.startsWith("worker ") && line.endsWith(long.id),
    ),
  ],
  [true, []],
);
show(
  "lockLost events for it (the heartbeat, then the refused failure)",
  lockLost.filter((id) => id === long.id).length,
);
await outsideWorker.close();

/* ------------------------------------------------------------------ */
step("schedule(), update() and `this | null`");

const changes = queue<{ v: number }>("changes");
const later = await changes.add("later", { v: 1 }, { delay: 60_000 });

const inTwoHours = Date.now() + 2 * 3_600_000;
const scheduled = await later.schedule(new Date(inTwoHours));
checkEqual(
  "schedule() is reschedule(): the job moves, and the answer is the job now",
  [scheduled?.runAt, scheduled?.state, scheduled?.wasAdded],
  [inTwoHours, "delayed", false],
);
const inWords = await later.schedule("in 3 hours");
check(
  "schedule() takes words, as reschedule() does",
  (inWords?.runAt ?? 0) > Date.now() + 2.9 * 3_600_000,
  inWords?.runAt,
);

const dataOnly = await later.update({ data: { v: 2 } });
checkEqual("update({ data })", dataOnly?.data, { v: 2 });
const priorityOnly = await later.update({ priority: 7 });
checkEqual(
  "update({ priority }) leaves the data as it was",
  [priorityOnly?.priority, priorityOnly?.data],
  [7, { v: 2 }],
);
const runAtOnly = await later.update({ runAt: "in 10 minutes" });
check(
  "update({ runAt }) takes words too",
  Math.abs((runAtOnly?.runAt ?? 0) - (Date.now() + 600_000)) < 5_000,
  runAtOnly?.runAt,
);
const all = await later.update({
  data: { v: 3 },
  priority: 1,
  runAt: inTwoHours,
  onlyIn: ["delayed"],
});
checkEqual(
  "all four in one step, when the state is one onlyIn names",
  [all?.data, all?.priority, all?.runAt],
  [{ v: 3 }, 1, inTwoHours],
);
checkEqual(
  "onlyIn naming another state refuses the whole change: null",
  await later.update({ data: { v: 99 }, priority: 9, onlyIn: ["waiting"] }),
  null,
);
checkEqual(
  "and nothing changed",
  [
    (await changes.getJob(later.id))?.data,
    (await changes.getJob(later.id))?.priority,
  ],
  [{ v: 3 }, 1],
);
await checkRejects(
  "a priority that is not a number",
  () => later.update({ priority: Number.NaN }),
  { name: "ConfigError" },
);

// Answered as `this`: the same type as the job asked, so a job narrowed by a
// typed registry stays narrowed. A compile-time check, and a runtime one.
const sameType: typeof later | null = await later.update({ priority: 2 });
check("the answer is a Job", sameType?.id === later.id);

await later.remove();
checkEqual(
  "a job that is gone: every one of them answers null",
  [
    await later.schedule("in 1 hour"),
    await later.reschedule("in 1 hour"),
    await later.update({ priority: 1 }),
    await later.updateData({ v: 4 }),
    await later.setPriority(4),
    await later.refresh(),
  ],
  [null, null, null, null, null, null],
);

/* ------------------------------------------------------------------ */
step("disable() and enable() on an occurrence; a ConfigError on a one-off");

const series = queue<{ report: string }>("series");
const occurrence = await series.add(
  "digest",
  { report: "daily" },
  { repeat: { every: 60_000, key: "from-job" } },
);
check("an occurrence knows its series", occurrence.isRepeat);
/** Whether the listed `from-job` series is disabled. */
const fromJobDisabled = async () => {
  const listed = await series.listRepeatables();
  return listed.find((info) => info.key === "from-job")?.disabled;
};
checkEqual("disable() answers true", await occurrence.disable(), true);
checkEqual(
  "the series is listed disabled, and its pending occurrence is gone",
  [await fromJobDisabled(), await series.getJob(occurrence.id)],
  [true, null],
);
checkEqual("disabling again answers false", await occurrence.disable(), false);
checkEqual("enable() answers true", await occurrence.enable(), true);
checkEqual("the series is enabled again", await fromJobDisabled(), false);
checkEqual("enabling again answers false", await occurrence.enable(), false);

const oneOff = await series.add("digest", { report: "once" });
await checkRejects("disable() on a job in no series", () => oneOff.disable(), {
  name: "ConfigError",
  message: /disable\(\) applies to an occurrence of a repeat series/,
});
await checkRejects("enable() on a job in no series", () => oneOff.enable(), {
  name: "ConfigError",
  message: /enable\(\) applies to an occurrence of a repeat series/,
});
await series.removeRepeatable("from-job");
await oneOff.remove();

/* ------------------------------------------------------------------ */
step("queue.disableRepeatable() / enableRepeatable()");

/** A `series` worker's runs, by job id. */
const seriesRuns: string[] = [];
let seriesGate: Promise<void> = Promise.resolve();
const seriesWorker = new BunQueueWorker<{ report: string }, unknown>(
  "series",
  async (job) => {
    seriesRuns.push(job.id);
    await seriesGate;
    return null;
  },
  { namespace, driver, logger: noopLogger, maintenance: false, ...fast },
);
closers.push(() => seriesWorker.close({ force: true }));

await series.add(
  "digest",
  { report: "weekly" },
  { repeat: { every: 60_000, key: "weekly" } },
);
/** The listed `weekly` series. */
const weekly = async () =>
  (await series.listRepeatables()).find((info) => info.key === "weekly");
const pending = (await weekly())!.nextJobId!;
checkEqual(
  "listRepeatables() reports disabled: false, with a pending occurrence",
  [(await weekly())?.disabled, (await series.getJob(pending))?.state],
  [false, "delayed"],
);

checkEqual(
  "disableRepeatable() answers true",
  await series.disableRepeatable("weekly"),
  true,
);
checkEqual(
  "listed disabled: true, and the pending occurrence is removed",
  [(await weekly())?.disabled, await series.getJob(pending)],
  [true, null],
);
checkEqual(
  "idempotent: again answers false; an unknown key answers false",
  [
    await series.disableRepeatable("weekly"),
    await series.disableRepeatable("no-such-series"),
    await series.enableRepeatable("no-such-series"),
  ],
  [false, false, false],
);
checkEqual(
  "nothing is pending while it is disabled",
  [await series.count("waiting"), await series.count("delayed")],
  [0, 0],
);

// Re-adding it with add({ repeat }) does not re-enable it.
await series.add(
  "digest",
  { report: "weekly" },
  { repeat: { every: 60_000, key: "weekly" } },
);
checkEqual(
  "add({ repeat }) for a disabled series leaves it disabled",
  (await weekly())?.disabled,
  true,
);
// It does schedule an occurrence, which maintenance then removes: a disabled
// series keeps nothing pending once a worker's maintenance has passed.
const readded = (await weekly())!.nextJobId!;
show("add({ repeat }) scheduled", {
  readded,
  state: (await series.getJob(readded))?.state,
});
const healer = new BunQueueWorker<{ report: string }, unknown>(
  "series",
  async () => null,
  {
    namespace,
    driver,
    logger: noopLogger,
    maintenance: true,
    stalledInterval: 50,
    ...fast,
  },
);
closers.push(() => healer.close({ force: true }));
void healer.run();
await waitFor(
  "maintenance to remove the disabled series' pending occurrence",
  async () => (await series.getJob(readded)) === null,
  WAIT,
);
checkEqual(
  "maintenance removed it, and scheduled no replacement",
  [
    await series.count("waiting"),
    await series.count("delayed"),
    (await weekly())?.disabled,
  ],
  [0, 0, true],
);
await healer.close();

// Enable schedules the next occurrence from now.
/** `repeatScheduled` events, as `[key, at]`. */
const scheduledEvents: [string, number][] = [];
series.on("repeatScheduled", (key, nextRunAt) => {
  scheduledEvents.push([key, nextRunAt]);
});
const enabledAt = Date.now();
checkEqual(
  "enableRepeatable() answers true",
  await series.enableRepeatable("weekly"),
  true,
);
const afterEnable = (await weekly())!;
const next = await series.getJob(afterEnable.nextJobId!);
check(
  "the next occurrence is the series' next point after now",
  next !== null &&
    next.state === "delayed" &&
    next.runAt > enabledAt &&
    next.runAt <= Date.now() + 60_000,
  { enabledAt, runAt: next?.runAt },
);
checkEqual(
  "exactly one occurrence is pending",
  [await series.count("waiting"), await series.count("delayed")],
  [0, 1],
);
checkEqual("it announced repeatScheduled for it", scheduledEvents, [
  ["weekly", afterEnable.nextRunAt!],
]);
checkEqual(
  "enabling again answers false",
  await series.enableRepeatable("weekly"),
  false,
);

// No backfill: a series every 100ms, disabled for several of its intervals,
// gets one occurrence after the enable — none for the slots it missed.
await series.add(
  "digest",
  { report: "often" },
  { repeat: { every: 100, key: "often" } },
);
checkEqual(
  "a fast series disabled",
  await series.disableRepeatable("often"),
  true,
);
await Bun.sleep(450); // four or so of its slots pass while it is disabled
const oftenEnabledAt = Date.now();
checkEqual("and enabled again", await series.enableRepeatable("often"), true);
const often = (await series.listRepeatables()).find(
  (info) => info.key === "often",
)!;
/** Pending jobs of one series, by its listed key. */
const pendingOf = async (key: string) =>
  [...(await series.list("waiting")), ...(await series.list("delayed"))].filter(
    (job) => job.repeatKey?.replace(/^k:/, "") === key,
  );
checkEqual(
  "it has exactly one pending occurrence, however many slots it missed",
  (await pendingOf("often")).length,
  1,
);
check(
  "due after the enable, within one interval: nothing missed is run",
  often.nextRunAt !== null &&
    often.nextRunAt > oftenEnabledAt &&
    often.nextRunAt <= Date.now() + 100,
  { oftenEnabledAt, nextRunAt: often.nextRunAt },
);
await series.removeRepeatable("often");

// An occurrence already running when its series is disabled finishes, and
// schedules nothing after it.
let releaseRun!: () => void;
seriesGate = new Promise<void>((resolve) => {
  releaseRun = resolve;
});
await series.add(
  "digest",
  { report: "hourly" },
  { repeat: { every: 60_000, key: "hourly", immediately: true } },
);
void seriesWorker.run();
await waitFor(
  "the hourly occurrence to start",
  () => seriesRuns.length > 0,
  WAIT,
);
const inFlight = seriesRuns[0]!;
const hourly = async () =>
  (await series.listRepeatables()).find((info) => info.key === "hourly");
// The worker scheduled the next occurrence as it claimed this one.
const scheduledOnClaim = (await hourly())!.nextJobId!;
checkEqual(
  "disabling mid-run answers true",
  await series.disableRepeatable("hourly"),
  true,
);
checkEqual(
  "the next occurrence, scheduled on claim, is removed",
  await series.getJob(scheduledOnClaim),
  null,
);
releaseRun();
await waitFor(
  "the in-flight occurrence to complete",
  async () => {
    const job = await series.getJob(inFlight);
    // Completed, or already removed by its retention.
    return job === null || job.state === "completed";
  },
  WAIT,
);
checkEqual(
  "the one in flight ran to the end, and it was the only run",
  seriesRuns,
  [inFlight],
);
checkEqual(
  "nothing of the hourly series is pending; weekly's one occurrence is",
  [(await pendingOf("hourly")).length, (await pendingOf("weekly")).length],
  [0, 1],
);
await seriesWorker.close();

// Removing a series clears its flag: added again, it starts enabled.
await series.disableRepeatable("weekly");
checkEqual(
  "removeRepeatable() on a disabled series answers true",
  await series.removeRepeatable("weekly"),
  true,
);
await series.add(
  "digest",
  { report: "weekly" },
  { repeat: { every: 60_000, key: "weekly" } },
);
checkEqual(
  "added again after removal, it is enabled",
  (await weekly())?.disabled,
  false,
);
await series.removeRepeatable("weekly");
await series.removeRepeatable("hourly");

/* ------------------------------------------------------------------ */
step("remove(), promote() and retry() on a job emit and publish");

const announce = queue<{ n: number }>("announce");
/** Local events on the queue the views came from. */
const announced: string[] = [];
announce.on("removed", (id) => announced.push(`removed ${id}`));
announce.on("promoted", (id) => announced.push(`promoted ${id}`));
announce.on("retried", (ids) => announced.push(`retried ${ids.join(",")}`));

const toRemove = await announce.add("x", { n: 1 });
const toPromote = await announce.add("x", { n: 2 }, { delay: 60_000 });
const toRetry = await announce.add("x", { n: 3 });
await toRetry.fail("to be retried");

// Views read back through the queue, not the ones `add` answered.
checkEqual(
  "each answers true",
  [
    await (await announce.getJob(toRemove.id))!.remove(),
    await (await announce.getJob(toPromote.id))!.promote(),
    await (await announce.getJob(toRetry.id))!.retry(),
  ],
  [true, true, true],
);
checkEqual("each emitted on the queue, as its own methods do", announced, [
  `removed ${toRemove.id}`,
  `promoted ${toPromote.id}`,
  `retried ${toRetry.id}`,
]);
await heard(toRetry.id, "retried");
checkEqual(
  "and each published its event",
  [
    publishedCount(toRemove.id, "removed"),
    publishedCount(toPromote.id, "promoted"),
    publishedCount(toRetry.id, "retried"),
  ],
  [1, 1, 1],
);
checkEqual(
  "the published retried carries ids, as the queue's retry() does",
  (
    published.find(
      (event) => event.type === "retried" && isAbout(event, toRetry.id),
    )?.payload as { ids?: string[] }
  )?.ids,
  [toRetry.id],
);
checkEqual(
  "a call that changes nothing announces nothing",
  [await (await announce.getJob(toPromote.id))!.promote(), announced.length],
  [false, 3],
);

/* ------------------------------------------------------------------ */
step(
  "progress: RunProgress | null; extendLock() only from the processor's view",
);

/** What the processor saw, and what its own view could do. */
const seen: {
  before?: RunProgress | null;
  after?: RunProgress | null;
  ownTouch?: boolean;
} = {};
let progressDone = false;
let holdProgress!: () => void;
const progressGate = new Promise<void>((resolve) => {
  holdProgress = resolve;
});
/** Values the `progress` event carried. */
const progressEvents: RunProgress[] = [];

const progressWorker = new BunQueueWorker<{ n: number }, unknown>(
  "announce",
  async (job) => {
    // The jobs retried and promoted above are claimed here too.
    if (job.name !== "report") {
      return null;
    }
    // Typed, not `unknown`: this line is a compile-time check.
    seen.before = job.progress;
    await job.updateProgress(40);
    await job.updateProgress({ step: "upload", done: 3 });
    seen.after = (await job.refresh())?.progress ?? null;
    seen.ownTouch = await job.touch(60_000);
    await progressGate;
    progressDone = true;
    return null;
  },
  { namespace, driver, logger: noopLogger, ...fast },
);
closers.push(() => progressWorker.close({ force: true }));
progressWorker.on("progress", (_job, value) => {
  // `value` is a RunProgress: a number or a record.
  const typed: RunProgress = value;
  progressEvents.push(typed);
});
void progressWorker.run();

const reporting = await announce.add("report", { n: 4 });
await waitFor(
  "the progress to be reported",
  () => seen.ownTouch !== undefined,
  WAIT,
);

const outsideView = await announce.getJob(reporting.id);
checkEqual(
  "extendLock() and touch() from any other view answer false",
  [
    outsideView?.state,
    await outsideView!.extendLock(60_000),
    await outsideView!.touch(60_000),
  ],
  ["active", false, false],
);
checkEqual("while the processor's own view extends it", seen.ownTouch, true);
holdProgress();
await waitFor("the progress job to finish", () => progressDone, WAIT);

checkEqual(
  "null before any progress, then the last value reported",
  [seen.before, seen.after],
  [null, { step: "upload", done: 3 }],
);
checkEqual("the progress event carried each value", progressEvents, [
  40,
  { step: "upload", done: 3 },
]);
const stored: RunProgress | null =
  (await announce.getJob(reporting.id))?.progress ?? null;
show("stored progress", stored);

// Compile-time only: a string is neither shape.
if (stored !== null) {
  // @ts-expect-error progress is a number or a record, never a string
  const _asString: string = stored;
}
await progressWorker.close();

/* ------------------------------------------------------------------ */
step("Cleaning up");

for (const close of closers.reverse()) {
  await close();
}
await notifier.close();
await driver.purge(namespace);
await driver.close();

summary();
