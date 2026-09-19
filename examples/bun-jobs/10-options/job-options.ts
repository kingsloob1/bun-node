/**
 * Option tour: every field of `JobOptions`, `RepeatOptions` and
 * `DebounceOptions`, each one set and then asserted.
 *
 * ```bash
 * bun 10-options/job-options.ts
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://localhost:6379/13 bun 10-options/job-options.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - Options merge **per field, not deeply**: built-in ← queue
 *   `defaultJobOptions` ← the call. `resolveJobOptions` is that merge, and
 *   `DEFAULT_JOB_OPTIONS` is the bottom layer.
 * - `runAt` wins over `delay`. Priority is clamped to ±1,048,576 rather than
 *   rejected, and a non-finite priority is refused.
 * - A retention *count* caps how many jobs in that state the whole queue
 *   keeps, not how many of one name, so each retention form gets a queue of
 *   its own here.
 * - A backoff delay is observed from the `retrying` event: the true delay lies
 *   between `runAt - (when the event fired)` and `runAt - processedOn`, so the
 *   checks assert that window overlaps the expected value rather than timing
 *   anything.
 * - `catchUp` is decided by the worker that schedules the next occurrence,
 *   which is why that section adds a series and starts its worker late.
 */
import type { LogEvent } from "@kingsleyweb/bun-common";
import type {
  BunQueueWorkerOptions,
  Job,
  JobOptions,
  JobProcessor,
} from "@kingsleyweb/bun-jobs";
import {
  BunQueue,
  BunQueueWorker,
  createDriver,
  DEFAULT_JOB_OPTIONS,
  DEFAULT_KEEP_LOGS,
  DEFAULT_KEEP_STACKTRACES,
  DEFAULT_RESULT_TTL,
  resolveJobOptions,
  resolveRunAt,
  retentionExpiry,
} from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

/** What every job in this tour carries. */
interface Payload {
  /** A label to recognise the job by. */
  label?: string;
  /** A number, for jobs that need telling apart. */
  n?: number;
  /** Makes the processor throw. */
  fail?: boolean;
}

/** One observed retry, bracketing the delay the worker chose. */
interface ObservedRetry {
  /** The attempt that just failed, 1-based. */
  attempt: number;
  /** A lower bound on the delay: `runAt` minus when the event fired. */
  low: number;
  /** An upper bound on the delay: `runAt` minus when the attempt was claimed. */
  high: number;
}

/** One run of a repeat occurrence, as the processor saw it. */
interface RepeatRun {
  /** When the occurrence was due. */
  runAt: number;
  /** When a worker claimed it. */
  processedOn: number;
}

title("Option tour: JobOptions, RepeatOptions, DebounceOptions");

const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("job-options");

/** Generous waits: other suites share this machine and the servers. */
const WAIT = { timeout: 30_000, interval: 20 };

/** Everything opened here, closed at the end. */
const closers: (() => Promise<void>)[] = [];

/** A queue in this tour's namespace, on the shared driver. */
function openQueue(name: string): BunQueue<Payload, unknown, string> {
  const queue = new BunQueue<Payload, unknown, string>(name, {
    namespace,
    driver,
  });
  closers.push(async () => await queue.close());
  return queue;
}

/** A running worker in this tour's namespace, polling briskly. */
function startWorker(
  name: string,
  processor: JobProcessor<Payload, unknown>,
  options: Partial<BunQueueWorkerOptions> = {},
): BunQueueWorker<Payload, unknown> {
  const worker = new BunQueueWorker<Payload, unknown>(name, processor, {
    namespace,
    driver,
    pollInterval: 20,
    ...options,
  });
  closers.unshift(async () => await worker.close());
  void worker.run();
  return worker;
}

/** Waits until the clock has moved past `instant`, so timestamps differ. */
async function clockPast(instant: number): Promise<void> {
  await waitFor("the clock to move on", () => Date.now() > instant, WAIT);
}

/** Waits for `predicate`, answering whether it came true in time. */
async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeout = 10_000,
): Promise<boolean> {
  try {
    await waitFor("a condition", predicate, { timeout, interval: 20 });
    return true;
  } catch {
    return false;
  }
}

/** Resolves once every id has completed or died in `queue`. */
async function settledIn(
  queue: BunQueue<Payload, unknown, string>,
  ids: string[],
): Promise<void> {
  await waitFor(
    `${ids.length} job(s) in ${queue.name} to finish`,
    async () => {
      for (const id of ids) {
        const state = (await queue.getJob(id))?.state;
        if (state !== "completed" && state !== "dead") {
          return false;
        }
      }
      return true;
    },
    WAIT,
  );
}

/* ------------------------------------------------------------------ */
step(
  "Defaults: DEFAULT_JOB_OPTIONS, resolveJobOptions, resolveRunAt, retentionExpiry",
);

checkEqual(
  "DEFAULT_JOB_OPTIONS holds the documented defaults",
  DEFAULT_JOB_OPTIONS,
  {
    priority: 0,
    attempts: 1,
    backoff: { type: "exponential", delay: 1_000, max: 300_000, jitter: 0.1 },
    timeout: 0,
    removeOnComplete: { ttl: DEFAULT_RESULT_TTL },
    removeOnFail: false,
    keepStacktraces: DEFAULT_KEEP_STACKTRACES,
  },
);
checkEqual(
  "the result TTL defaults to 24 hours",
  DEFAULT_RESULT_TTL,
  86_400_000,
);
checkEqual("keepStacktraces defaults to 5", DEFAULT_KEEP_STACKTRACES, 5);
checkEqual("keepLogs defaults to 1000", DEFAULT_KEEP_LOGS, 1_000);
checkEqual(
  "resolveJobOptions with nothing is DEFAULT_JOB_OPTIONS",
  resolveJobOptions(undefined, undefined),
  DEFAULT_JOB_OPTIONS,
);

const layered = resolveJobOptions(
  {
    attempts: 3,
    priority: 4,
    timeout: 500,
    backoff: { type: "fixed", delay: 5 },
  },
  {
    priority: 1,
    keepLogs: 10,
    deadLetter: "graveyard",
    backoff: { type: "linear" },
  },
);
checkEqual("the call wins over the queue default", layered.priority, 1);
checkEqual("a queue default the call leaves alone stays", layered.attempts, 3);
checkEqual("so does its timeout", layered.timeout, 500);
checkEqual("an object option is replaced whole, not merged", layered.backoff, {
  type: "linear",
});
checkEqual("keepLogs is carried when set", layered.keepLogs, 10);
checkEqual("deadLetter is carried when set", layered.deadLetter, "graveyard");
check(
  "keepLogs and deadLetter are absent when nobody set them",
  !("keepLogs" in DEFAULT_JOB_OPTIONS) &&
    !("deadLetter" in resolveJobOptions(undefined, {})),
);

await checkRejects(
  "attempts 0 is refused",
  () => resolveJobOptions(undefined, { attempts: 0 }),
  {
    name: "ConfigError",
    code: "CONFIG",
  },
);
await checkRejects(
  "fractional attempts are refused",
  () => resolveJobOptions(undefined, { attempts: 2.5 }),
  {
    name: "ConfigError",
  },
);
await checkRejects(
  "a NaN priority is refused",
  () => resolveJobOptions(undefined, { priority: Number.NaN }),
  {
    name: "ConfigError",
  },
);
await checkRejects(
  "negative keepLogs is refused",
  () => resolveJobOptions(undefined, { keepLogs: -1 }),
  {
    name: "ConfigError",
  },
);
await checkRejects(
  "a deadLetter that is not a queue name is refused",
  () => resolveJobOptions(undefined, { deadLetter: "no spaces" }),
  {
    name: "ConfigError",
  },
);

const now = Date.now();
checkEqual(
  "resolveRunAt with nothing is now",
  resolveRunAt(undefined, now),
  now,
);
checkEqual(
  "resolveRunAt reads delay from now",
  resolveRunAt({ delay: 250 }, now),
  now + 250,
);
checkEqual(
  "resolveRunAt prefers runAt over delay",
  resolveRunAt({ runAt: now + 1_000, delay: 5 }, now),
  now + 1_000,
);
checkEqual(
  "resolveRunAt accepts a Date",
  resolveRunAt({ runAt: new Date(now + 42) }, now),
  now + 42,
);
await checkRejects(
  "a negative delay is refused",
  () => resolveRunAt({ delay: -1 }, now),
  {
    name: "ConfigError",
  },
);
await checkRejects(
  "an invalid runAt is refused",
  () => resolveRunAt({ runAt: new Date("never") }, now),
  {
    name: "ConfigError",
  },
);

checkEqual(
  "retentionExpiry(true) is null — removed, nothing to expire",
  retentionExpiry(true, now),
  null,
);
checkEqual(
  "retentionExpiry(false) is null — kept forever",
  retentionExpiry(false, now),
  null,
);
checkEqual(
  "retentionExpiry(count) is null — a count has no TTL",
  retentionExpiry(10, now),
  null,
);
checkEqual(
  "retentionExpiry({ count }) is null",
  retentionExpiry({ count: 3 }, now),
  null,
);
checkEqual(
  "retentionExpiry({ ttl }) is now + ttl",
  retentionExpiry({ ttl: 5_000 }, now),
  now + 5_000,
);
checkEqual(
  "retentionExpiry({ count, ttl }) is now + ttl",
  retentionExpiry({ count: 3, ttl: 5_000 }, now),
  now + 5_000,
);

/* ------------------------------------------------------------------ */
step("priority: lower runs first, ties FIFO, clamped to ±1,048,576");

const priorityQueue = openQueue("priority");
const ranInOrder: string[] = [];
const priorityPlan: [string, number][] = [
  ["five", 5],
  ["zero-a", 0],
  ["minus-three", -3],
  ["zero-b", 0],
  ["clamped-high", 1e9],
  ["clamped-low", -1e9],
];
const priorityJobs = new Map<string, Job<Payload, unknown>>();

for (const [label, priority] of priorityPlan) {
  const job = await priorityQueue.add("rank", { label }, { priority });
  priorityJobs.set(label, job);
  // Distinct creation times, so the zero-priority tie is broken by order.
  await clockPast(job.createdAt);
}

checkEqual(
  "a huge priority is clamped",
  priorityJobs.get("clamped-high")?.priority,
  1_048_576,
);
checkEqual(
  "and stored clamped in its options",
  priorityJobs.get("clamped-high")?.opts.priority,
  1_048_576,
);
checkEqual(
  "a hugely negative one too",
  priorityJobs.get("clamped-low")?.priority,
  -1_048_576,
);
await checkRejects(
  "an infinite priority is refused by add()",
  () => priorityQueue.add("rank", {}, { priority: Infinity }),
  {
    name: "ConfigError",
  },
);

const priorityWorker = startWorker(
  "priority",
  (job) => {
    ranInOrder.push(job.data.label ?? "");
  },
  { concurrency: 1 },
);
await waitFor(
  "every ranked job",
  () => ranInOrder.length === priorityPlan.length,
  WAIT,
);
show("ran in order", ranInOrder);
checkEqual("ran lowest priority first, ties in the order added", ranInOrder, [
  "clamped-low",
  "minus-three",
  "zero-a",
  "zero-b",
  "five",
  "clamped-high",
]);
await priorityWorker.close();

/* ------------------------------------------------------------------ */
step("delay and runAt: not claimable before; runAt wins over delay");

const timingQueue = openQueue("timing");
const before = Date.now();
const delayed = await timingQueue.add(
  "delay",
  { label: "delay" },
  { delay: 400 },
);
const scheduled = await timingQueue.add(
  "runAt",
  { label: "runAt" },
  { runAt: new Date(before + 250) },
);
const both = await timingQueue.add(
  "both",
  { label: "both" },
  { delay: 60_000, runAt: before + 300 },
);
const past = await timingQueue.add(
  "past",
  { label: "past" },
  { runAt: before - 10_000 },
);

checkEqual("a delayed job starts out delayed", delayed.state, "delayed");
checkEqual(
  "its runAt is createdAt + delay",
  delayed.runAt - delayed.createdAt,
  400,
);
checkEqual("a runAt in the future is delayed", scheduled.state, "delayed");
checkEqual("a runAt Date is stored as epoch ms", scheduled.runAt, before + 250);
checkEqual("given both, runAt wins over delay", both.runAt, before + 300);
checkEqual("a runAt in the past is waiting at once", past.state, "waiting");

startWorker("timing", () => "ran");
await settledIn(timingQueue, [delayed.id, scheduled.id, both.id, past.id]);

for (const job of [delayed, scheduled, both]) {
  const done = await job.refresh();
  check(
    `"${job.name}" was not claimed before its runAt`,
    (done?.processedOn ?? 0) >= job.runAt,
    { runAt: job.runAt, processedOn: done?.processedOn },
  );
}
check(
  "the job given both ran long before its 60s delay",
  ((await both.refresh())?.processedOn ?? Infinity) < both.createdAt + 60_000,
);

/* ------------------------------------------------------------------ */
step(
  "attempts and backoff: a number, each built-in type, delay/factor/max/jitter, a named strategy",
);

const failuresQueue = openQueue("failures");
const retries = new Map<string, ObservedRetry[]>();
const aborted = new Set<string>();
const workerLogs: LogEvent[] = [];

const failuresWorker = startWorker(
  "failures",
  async (job, ctx) => {
    switch (job.name) {
      case "slow":
        // Waits for its signal; a timeout aborts it.
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener(
            "abort",
            () => {
              aborted.add(job.id);
              reject(ctx.signal.reason);
            },
            { once: true },
          );
        });
        return "unreachable";
      case "sleepy":
        await Bun.sleep(300);
        return "slept";
      default:
        throw new Error(`attempt ${ctx.attempt}`);
    }
  },
  {
    concurrency: 32,
    logger: (event) => {
      workerLogs.push(event);
    },
    backoffStrategies: {
      // 40ms per attempt so far; the job's `max` caps it.
      slowRamp: ({ attempt }) => attempt * 40,
      // Stop retrying now, whatever attempts are left.
      giveUp: () => false,
    },
  },
);

failuresWorker.on("retrying", (job, _error, runAt) => {
  const firedAt = Date.now();
  const list = retries.get(job.id) ?? [];
  list.push({
    attempt: job.attemptsMade,
    low: runAt - firedAt,
    high: runAt - (job.processedOn ?? firedAt),
  });
  retries.set(job.id, list);
});

/** A backoff case: its options and the delay range each retry must fall in. */
interface BackoffCase {
  /** What the case shows. */
  label: string;
  /** The options the job is added with. */
  options: JobOptions;
  /** The inclusive range the delay after `attempt` must fall in. */
  expect: (attempt: number) => [number, number];
}

const fib = (n: number): number => (n <= 2 ? 1 : fib(n - 1) + fib(n - 2));
const exactly = (ms: number): [number, number] => [ms, ms];

const backoffCases: BackoffCase[] = [
  {
    label: "backoff: 30 (a number is fixed ms)",
    options: { attempts: 3, backoff: 30 },
    expect: () => exactly(30),
  },
  {
    label: "type omitted defaults to fixed",
    options: { attempts: 3, backoff: { delay: 35 } },
    expect: () => exactly(35),
  },
  {
    label: "fixed",
    options: { attempts: 3, backoff: { type: "fixed", delay: 30 } },
    expect: () => exactly(30),
  },
  {
    label: "exponential with factor 3",
    options: {
      attempts: 4,
      backoff: { type: "exponential", delay: 20, factor: 3 },
    },
    expect: (attempt) => exactly(20 * 3 ** (attempt - 1)),
  },
  {
    label: "linear",
    options: { attempts: 4, backoff: { type: "linear", delay: 25 } },
    expect: (attempt) => exactly(25 * attempt),
  },
  {
    label: "fibonacci",
    options: { attempts: 5, backoff: { type: "fibonacci", delay: 20 } },
    expect: (attempt) => exactly(20 * fib(attempt)),
  },
  {
    label: "exponential capped by max",
    options: {
      attempts: 4,
      backoff: { type: "exponential", delay: 40, factor: 4, max: 100 },
    },
    expect: (attempt) => exactly(Math.min(40 * 4 ** (attempt - 1), 100)),
  },
  {
    label: "jitter: 0.5 spreads ±50%",
    options: {
      attempts: 3,
      backoff: { type: "fixed", delay: 200, jitter: 0.5 },
    },
    expect: () => [100, 300],
  },
  {
    label: "jitter: true spreads ±10%",
    options: {
      attempts: 3,
      backoff: { type: "fixed", delay: 200, jitter: true },
    },
    expect: () => [180, 220],
  },
  {
    label: "full-jitter is between 0 and the capped exponential",
    options: {
      attempts: 4,
      backoff: { type: "full-jitter", delay: 80, factor: 2, max: 120 },
    },
    expect: (attempt) => [0, Math.min(80 * 2 ** (attempt - 1), 120)],
  },
  {
    label: "decorrelated-jitter stays between delay and max",
    options: {
      attempts: 4,
      backoff: { type: "decorrelated-jitter", delay: 30, max: 150 },
    },
    expect: () => [30, 150],
  },
  {
    label: "a named strategy, capped by the job's max",
    options: { attempts: 4, backoff: { type: "slowRamp", max: 90 } },
    expect: (attempt) => exactly(Math.min(attempt * 40, 90)),
  },
  {
    label:
      "a strategy this worker was not given falls back to the default (1s ±10%)",
    options: { attempts: 2, backoff: { type: "noSuchStrategy" } },
    expect: () => [900, 1_100],
  },
];

const backoffJobs = new Map<BackoffCase, Job<Payload, unknown>>();
for (const backoffCase of backoffCases) {
  backoffJobs.set(
    backoffCase,
    await failuresQueue.add(
      "fail",
      { label: backoffCase.label },
      backoffCase.options,
    ),
  );
}
const givesUp = await failuresQueue.add(
  "fail",
  { label: "giveUp" },
  {
    attempts: 5,
    backoff: { type: "giveUp" },
  },
);

await settledIn(failuresQueue, [
  ...[...backoffJobs.values()].map((job) => job.id),
  givesUp.id,
]);

for (const [backoffCase, job] of backoffJobs) {
  const attempts = backoffCase.options.attempts!;
  const done = await job.refresh();
  const observed = retries.get(job.id) ?? [];

  check(
    `${backoffCase.label}: died after all ${attempts} attempts`,
    done?.state === "dead" &&
      done.attemptsMade === attempts &&
      observed.length === attempts - 1,
    {
      state: done?.state,
      attemptsMade: done?.attemptsMade,
      retries: observed.length,
    },
  );

  const outOfRange = observed.filter((retry) => {
    const [min, max] = backoffCase.expect(retry.attempt);
    // The true delay lies in [low, high]; it must meet [min, max]. 1ms of
    // slack for a fractional jittered runAt.
    return retry.low > max + 1 || retry.high < min - 1;
  });
  check(`${backoffCase.label}: every delay in range`, outOfRange.length === 0, {
    observed,
    expected: observed.map((retry) => backoffCase.expect(retry.attempt)),
  });
}

const gaveUp = await givesUp.refresh();
check(
  "a strategy answering false kills the job with attempts left",
  gaveUp?.state === "dead" &&
    gaveUp.attemptsMade === 1 &&
    !retries.has(givesUp.id),
  { state: gaveUp?.state, attemptsMade: gaveUp?.attemptsMade },
);
check(
  "the unknown strategy name was logged as a warning",
  workerLogs.some(
    (event) =>
      event.level === "warn" && event.message.includes("noSuchStrategy"),
  ),
);

/* ------------------------------------------------------------------ */
step("keepStacktraces: failures kept newest first, trimmed to the count");

const traced = await failuresQueue.add(
  "fail",
  {},
  { attempts: 4, backoff: 0, keepStacktraces: 2 },
);
const untraced = await failuresQueue.add(
  "fail",
  {},
  { attempts: 3, backoff: 0, keepStacktraces: 0 },
);
const defaultTraced = await failuresQueue.add(
  "fail",
  {},
  { attempts: 7, backoff: 0 },
);
await settledIn(failuresQueue, [traced.id, untraced.id, defaultTraced.id]);

const tracedDone = await traced.refresh();
checkEqual(
  "keepStacktraces: 2 keeps the last two failures, newest first",
  tracedDone?.stacktrace.map((error) => error.message),
  ["attempt 4", "attempt 3"],
);
checkEqual(
  "failedReason is the last failure",
  tracedDone?.failedReason?.message,
  "attempt 4",
);
checkEqual(
  "keepStacktraces: 0 keeps none",
  (await untraced.refresh())?.stacktrace.length,
  0,
);
checkEqual(
  "the default keeps 5 of 7",
  (await defaultTraced.refresh())?.stacktrace.map((error) => error.message),
  ["attempt 7", "attempt 6", "attempt 5", "attempt 4", "attempt 3"],
);

/* ------------------------------------------------------------------ */
step("timeout: a per-attempt limit that aborts the signal; 0 means none");

const timesOut = await failuresQueue.add(
  "slow",
  {},
  { timeout: 150, attempts: 2, backoff: 0 },
);
const noLimit = await failuresQueue.add("sleepy", {}, { timeout: 0 });
await settledIn(failuresQueue, [timesOut.id, noLimit.id]);

const timedOut = await timesOut.refresh();
checkEqual(
  "a timed-out job used both attempts and died",
  [timedOut?.state, timedOut?.attemptsMade],
  ["dead", 2],
);
checkEqual(
  "its failure is a JobTimeoutError",
  timedOut?.failedReason?.name,
  "JobTimeoutError",
);
check("the processor's signal was aborted", aborted.has(timesOut.id));
checkEqual(
  "timeout: 0 let a 300ms job finish",
  (await noLimit.refresh())?.state,
  "completed",
);

/* ------------------------------------------------------------------ */
step(
  "removeOnComplete / removeOnFail: true, false, a count, { count, ttl }, and the defaults",
);

/** Runs jobs that fail when asked to, on a queue of their own. */
function retentionWorker(name: string): BunQueueWorker<Payload, unknown> {
  return startWorker(
    name,
    (job) => {
      if (job.data.fail) {
        throw new Error("failed on purpose");
      }
      return "done";
    },
    { concurrency: 4 },
  );
}

// true — removed the moment it finishes.
const removeQueue = openQueue("keep-true");
const removeWorker = retentionWorker("keep-true");
const finished = new Set<string>();
removeWorker.on("completed", (job) => finished.add(job.id));
removeWorker.on("dead", (job) => finished.add(job.id));

const gone = await removeQueue.add("x", {}, { removeOnComplete: true });
const goneDead = await removeQueue.add(
  "x",
  { fail: true },
  { removeOnFail: true },
);
await waitFor(
  "both removable jobs",
  () => finished.has(gone.id) && finished.has(goneDead.id),
  WAIT,
);
checkEqual(
  "removeOnComplete: true removes the completed job",
  await removeQueue.getJob(gone.id),
  null,
);
checkEqual(
  "removeOnFail: true removes the dead job",
  await removeQueue.getJob(goneDead.id),
  null,
);

// A number — keeps that many in the state.
const countQueue = openQueue("keep-count");
const countWorker = retentionWorker("keep-count");
const countFinished = new Set<string>();
countWorker.on("completed", (job) => countFinished.add(job.id));
countWorker.on("dead", (job) => countFinished.add(job.id));
const countIds: string[] = [];
for (let n = 0; n < 5; n++) {
  countIds.push((await countQueue.add("x", { n }, { removeOnComplete: 2 })).id);
}
for (let n = 0; n < 3; n++) {
  countIds.push(
    (await countQueue.add("x", { n, fail: true }, { removeOnFail: 1 })).id,
  );
}
await waitFor(
  "the counted jobs",
  () => countIds.every((id) => countFinished.has(id)),
  WAIT,
);
check(
  "removeOnComplete: 2 keeps two completed jobs",
  await eventually(async () => (await countQueue.count("completed")) === 2),
  { completed: await countQueue.count("completed") },
);
check(
  "removeOnFail: 1 keeps one dead job",
  await eventually(async () => (await countQueue.count("dead")) === 1),
  { dead: await countQueue.count("dead") },
);

// { count, ttl } — both.
const bothQueue = openQueue("keep-both");
const bothWorker = retentionWorker("keep-both");
const bothFinished = new Set<string>();
bothWorker.on("completed", (job) => bothFinished.add(job.id));
bothWorker.on("dead", (job) => bothFinished.add(job.id));
const bothIds: string[] = [];
for (let n = 0; n < 5; n++) {
  bothIds.push(
    (
      await bothQueue.add(
        "x",
        { n },
        { removeOnComplete: { count: 3, ttl: 60_000 } },
      )
    ).id,
  );
}
const ttlDead = await bothQueue.add(
  "x",
  { fail: true },
  { removeOnFail: { ttl: 60_000 } },
);
await waitFor(
  "the count-and-ttl jobs",
  () => [...bothIds, ttlDead.id].every((id) => bothFinished.has(id)),
  WAIT,
);
// The count holds however the completions arrive — one at a time, or several
// written together in one batch.
check(
  "{ count: 3, ttl } keeps three completed jobs",
  await eventually(async () => (await bothQueue.count("completed")) === 3),
  { completed: await bothQueue.count("completed") },
);
const keptWithTtl = await bothQueue.list("completed");
check(
  "…each expiring 60s after it finished",
  keptWithTtl.length > 0 &&
    keptWithTtl.every(
      (job) =>
        Math.abs((job.expiresAt ?? 0) - (job.finishedOn ?? 0) - 60_000) <=
        1_000,
    ),
  keptWithTtl.map((job) => ({
    finishedOn: job.finishedOn,
    expiresAt: job.expiresAt,
  })),
);
const ttlDeadDone = await ttlDead.refresh();
check(
  "removeOnFail: { ttl } keeps the dead job and stamps its expiry",
  ttlDeadDone?.state === "dead" &&
    Math.abs(
      (ttlDeadDone.expiresAt ?? 0) - (ttlDeadDone.finishedOn ?? 0) - 60_000,
    ) <= 1_000,
  { expiresAt: ttlDeadDone?.expiresAt, finishedOn: ttlDeadDone?.finishedOn },
);

// false, and the defaults.
const defaultQueue = openQueue("keep-default");
const defaultWorker = retentionWorker("keep-default");
const defaultFinished = new Set<string>();
defaultWorker.on("completed", (job) => defaultFinished.add(job.id));
defaultWorker.on("dead", (job) => defaultFinished.add(job.id));
const keptForever = await defaultQueue.add(
  "x",
  {},
  { removeOnComplete: false },
);
const keptDefault = await defaultQueue.add("x", {});
const deadDefault = await defaultQueue.add("x", { fail: true });
await waitFor(
  "the default-retention jobs",
  () =>
    [keptForever, keptDefault, deadDefault].every((job) =>
      defaultFinished.has(job.id),
    ),
  WAIT,
);
const foreverDone = await keptForever.refresh();
checkEqual(
  "removeOnComplete: false keeps it with no expiry",
  [foreverDone?.state, foreverDone?.expiresAt],
  ["completed", null],
);
const defaultDone = await keptDefault.refresh();
check(
  "the default keeps a completed job for 24 hours",
  Math.abs(
    (defaultDone?.expiresAt ?? 0) -
      (defaultDone?.finishedOn ?? 0) -
      DEFAULT_RESULT_TTL,
  ) <= 1_000,
  { expiresAt: defaultDone?.expiresAt, finishedOn: defaultDone?.finishedOn },
);
const deadDefaultDone = await deadDefault.refresh();
checkEqual(
  "removeOnFail defaults to false: kept, no expiry",
  [deadDefaultDone?.state, deadDefaultDone?.expiresAt],
  ["dead", null],
);

/* ------------------------------------------------------------------ */
step("keepLogs: trims the oldest lines; 0 keeps every line");

const logQueue = openQueue("logs");
const chattyCounts: number[] = [];
startWorker("logs", async (job, ctx) => {
  for (let line = 1; line <= 5; line++) {
    chattyCounts.push(await ctx.log(`line ${line}`));
  }
  return "logged";
});
const chatty = await logQueue.add("chatty", {}, { keepLogs: 3 });
await settledIn(logQueue, [chatty.id]);
const chattyLogs = await chatty.getLogs();
checkEqual("keepLogs: 3 keeps the newest three lines", chattyLogs, {
  logs: ["line 3", "line 4", "line 5"],
  count: 3,
});
checkEqual(
  "ctx.log answers with how many lines are kept",
  chattyCounts,
  [1, 2, 3, 3, 3],
);

// Logged by the producer, on jobs no worker will run for an hour.
const logStore = openQueue("log-store");
const keepsAll = await logStore.add(
  "quiet",
  {},
  { delay: 3_600_000, keepLogs: 0 },
);
const keepsDefault = await logStore.add("quiet", {}, { delay: 3_600_000 });
const lines = DEFAULT_KEEP_LOGS + 5;
let allCount = 0;
let defaultCount = 0;
for (let line = 1; line <= lines; line++) {
  allCount = await keepsAll.log(`line ${line}`);
  defaultCount = await keepsDefault.log(`line ${line}`);
}
checkEqual(`keepLogs: 0 kept all ${lines} lines`, allCount, lines);
checkEqual(
  `the default kept ${DEFAULT_KEEP_LOGS}`,
  defaultCount,
  DEFAULT_KEEP_LOGS,
);
checkEqual(
  "…dropping the oldest five",
  (await keepsDefault.getLogs({ limit: 1 })).logs,
  ["line 6"],
);

/* ------------------------------------------------------------------ */
step(
  "deadLetter: a copy of the dead job, winning over the worker's deadLetterQueue",
);

const letters = openQueue("letters");
const dlq = openQueue("letters-dlq");
const fallbackDlq = openQueue("letters-dlq-default");
const lettered = new Map<string, string>();
const workerErrors: { error: Error; context: string }[] = [];

const lettersWorker = startWorker(
  "letters",
  (job) => {
    throw new Error(`boom ${job.data.label}`);
  },
  { deadLetterQueue: "letters-dlq-default", concurrency: 4 },
);
lettersWorker.on("deadLettered", (job, letter) => {
  lettered.set(job.id, letter.id);
});
lettersWorker.on("error", (error, context) => {
  workerErrors.push({ error, context });
});

const named = await letters.add(
  "charge",
  { label: "named" },
  { deadLetter: "letters-dlq" },
);
const unnamed = await letters.add("charge", { label: "unnamed" });
const twice = await letters.add(
  "charge",
  { label: "twice" },
  { deadLetter: "letters-dlq", attempts: 2, backoff: 0 },
);
const removedToo = await letters.add(
  "charge",
  { label: "removed" },
  { deadLetter: "letters-dlq", removeOnFail: true },
);
const toItself = await letters.add(
  "charge",
  { label: "self" },
  { deadLetter: "letters" },
);

await waitFor(
  "three letters",
  () =>
    [named, unnamed, twice, removedToo].every((job) => lettered.has(job.id)),
  WAIT,
);
await waitFor(
  "the self-addressed letter to be refused",
  () => workerErrors.some((entry) => entry.context === "deadLetter"),
  WAIT,
);

const letter = await dlq.getJob(`letters:${named.id}:${named.createdAt}`);
checkEqual(
  "the letter's id is derived from the job's",
  lettered.get(named.id),
  letter?.id,
);
checkEqual("the letter keeps the job's name", letter?.name, "charge");
const letterData = letter?.data as unknown as {
  queue: string;
  id: string;
  name: string;
  data: Payload;
  failedReason: { message: string };
  attemptsMade: number;
  diedAt: number;
};
checkEqual(
  "the letter carries queue, id, name, data, failure and attempts",
  [
    letterData.queue,
    letterData.id,
    letterData.name,
    letterData.data,
    letterData.failedReason.message,
    letterData.attemptsMade,
  ],
  ["letters", named.id, "charge", { label: "named" }, "boom named", 1],
);
check(
  "…and when it died",
  typeof letterData.diedAt === "number" && letterData.diedAt >= named.createdAt,
);
checkEqual(
  "a job's own deadLetter wins: nothing in the worker's queue for it",
  await fallbackDlq.getJob(`letters:${named.id}:${named.createdAt}`),
  null,
);
check(
  "a job naming none goes to the worker's deadLetterQueue",
  (await fallbackDlq.getJob(`letters:${unnamed.id}:${unnamed.createdAt}`)) !==
    null,
);
checkEqual(
  "a retried job files one letter, after its last attempt",
  (
    (await dlq.getJob(`letters:${twice.id}:${twice.createdAt}`))
      ?.data as unknown as { attemptsMade: number }
  )?.attemptsMade,
  2,
);
checkEqual(
  "the dead job is still kept by removeOnFail as usual",
  (await named.refresh())?.state,
  "dead",
);
checkEqual(
  "…or removed, with removeOnFail: true",
  await removedToo.refresh(),
  null,
);
check(
  "removeOnFail: true still files the letter",
  (await dlq.getJob(`letters:${removedToo.id}:${removedToo.createdAt}`)) !==
    null,
);
check(
  "a job naming its own queue files nothing and reports a ConfigError",
  !lettered.has(toItself.id) &&
    workerErrors.some(
      (entry) =>
        entry.context === "deadLetter" && entry.error.name === "ConfigError",
    ),
);

/* ------------------------------------------------------------------ */
step("jobId: an idempotency key");

const idem = openQueue("idempotent");
const duplicates: string[] = [];
idem.on("duplicate", (job) => {
  duplicates.push(job.id);
});
const first = await idem.add("invoice", { n: 1 }, { jobId: "invoice-42" });
const again = await idem.add(
  "invoice",
  { n: 2 },
  { jobId: "invoice-42", priority: 9 },
);
checkEqual(
  "the first add created it under that id",
  [first.id, first.wasAdded],
  ["invoice-42", true],
);
checkEqual("the second add created nothing", again.wasAdded, false);
checkEqual(
  "…and answered with the stored job, untouched",
  [again.data, again.priority],
  [{ n: 1 }, 0],
);
checkEqual("…and emitted duplicate", duplicates, ["invoice-42"]);
checkEqual("one job in the queue", await idem.count("waiting"), 1);
const [bulkAgain] = await idem.addBulk([
  { name: "invoice", data: { n: 3 }, opts: { jobId: "invoice-42" } },
]);
checkEqual("addBulk honours the same key", bulkAgain?.wasAdded, false);
await idem.remove("invoice-42");
checkEqual(
  "once removed, the id can be used again",
  (await idem.add("invoice", { n: 4 }, { jobId: "invoice-42" })).wasAdded,
  true,
);

/* ------------------------------------------------------------------ */
step("debounce: one pending job per id, data replaced, run time pushed back");

const debounceQueue = openQueue("debounce");
const debounceRuns: { id: string; data: Payload; processedOn: number }[] = [];
const debounced: string[] = [];
debounceQueue.on("debounced", (job) => {
  debounced.push(job.id);
});
startWorker("debounce", (job) => {
  debounceRuns.push({
    id: job.id,
    data: job.data,
    processedOn: job.processedOn ?? 0,
  });
});

const opened = await debounceQueue.add(
  "save",
  { n: 1 },
  // A generous window: a slow round trip between adds must not let it start.
  { debounce: { id: "doc-7", ttl: 5_000 }, priority: 7 },
);
const second = await debounceQueue.add(
  "save",
  { n: 2 },
  { debounce: { id: "doc-7", ttl: 5_000 }, priority: 1 },
);
const third = await debounceQueue.add(
  "save",
  { n: 3 },
  { debounce: { id: "doc-7", ttl: "5 seconds" } },
);

checkEqual(
  "the first add creates a delayed job",
  [opened.wasAdded, opened.state],
  [true, "delayed"],
);
checkEqual(
  "later adds answer with the same job",
  [second.id, third.id],
  [opened.id, opened.id],
);
checkEqual(
  "…without creating one",
  [second.wasAdded, third.wasAdded],
  [false, false],
);
checkEqual("…and emit debounced", debounced, [opened.id, opened.id]);
check(
  "each add pushes the run time back",
  third.runAt >= second.runAt && second.runAt >= opened.runAt,
  {
    runAts: [opened.runAt, second.runAt, third.runAt],
  },
);
checkEqual("the data is the latest add's", third.data, { n: 3 });
checkEqual("the first add's other options stay", third.priority, 7);

await waitFor("the debounced job to run", () => debounceRuns.length >= 1, WAIT);
checkEqual(
  "it ran once, with the last data",
  debounceRuns.map((run) => [run.id, run.data]),
  [[opened.id, { n: 3 }]],
);
check(
  "not before the pushed-back run time",
  (debounceRuns[0]?.processedOn ?? 0) >= third.runAt,
);
await settledIn(debounceQueue, [opened.id]);
const afterRun = await debounceQueue.add(
  "save",
  { n: 4 },
  { debounce: { id: "doc-7", ttl: 1_000 } },
);
check(
  "once it has started, the next add is a new job",
  afterRun.wasAdded && afterRun.id !== opened.id,
);

await checkRejects(
  "debounce with throttle is refused",
  () =>
    debounceQueue.add(
      "save",
      {},
      {
        debounce: { id: "a", ttl: 100 },
        throttle: { id: "a", ttl: 100 },
      },
    ),
  { name: "ConfigError" },
);
await checkRejects(
  "debounce with jobId is refused",
  () =>
    debounceQueue.add(
      "save",
      {},
      { debounce: { id: "a", ttl: 100 }, jobId: "x" },
    ),
  {
    name: "ConfigError",
  },
);
await checkRejects(
  "debounce with repeat is refused",
  () =>
    debounceQueue.add(
      "save",
      {},
      {
        debounce: { id: "a", ttl: 100 },
        repeat: { every: 1_000 },
      },
    ),
  { name: "ConfigError" },
);
await checkRejects(
  "an empty debounce id is refused",
  () => debounceQueue.add("save", {}, { debounce: { id: "", ttl: 100 } }),
  {
    name: "ConfigError",
  },
);
await checkRejects(
  "a ttl that is not a duration is refused",
  () => debounceQueue.add("save", {}, { debounce: { id: "a", ttl: "soon" } }),
  {
    name: "ConfigError",
  },
);
await checkRejects(
  "a zero ttl is refused",
  () => debounceQueue.add("save", {}, { throttle: { id: "a", ttl: 0 } }),
  {
    name: "ConfigError",
  },
);
await checkRejects(
  "throttle with jobId is refused",
  () =>
    debounceQueue.add(
      "save",
      {},
      { throttle: { id: "a", ttl: 100 }, jobId: "x" },
    ),
  {
    name: "ConfigError",
  },
);

/* ------------------------------------------------------------------ */
step("throttle: at most one job per id per window");

const throttleQueue = openQueue("throttle");
const throttled: string[] = [];
throttleQueue.on("throttled", (job) => {
  throttled.push(job.id);
});
const windowOpener = await throttleQueue.add(
  "ping",
  { n: 1 },
  { throttle: { id: "user-1", ttl: 2_000 } },
);
const openedAt = Date.now();
const insideWindow = await throttleQueue.add(
  "ping",
  { n: 2 },
  { throttle: { id: "user-1", ttl: "2 seconds" } },
);
const otherId = await throttleQueue.add(
  "ping",
  { n: 3 },
  { throttle: { id: "user-2", ttl: 2_000 } },
);

checkEqual(
  "an add inside the window answers with the job that opened it",
  insideWindow.id,
  windowOpener.id,
);
checkEqual(
  "…adds nothing, and keeps the opener's data",
  [insideWindow.wasAdded, insideWindow.data],
  [false, { n: 1 }],
);
checkEqual("…and emits throttled", throttled, [windowOpener.id]);
check(
  "another id has a window of its own",
  otherId.wasAdded && otherId.id !== windowOpener.id,
);
const throttledDelay = await throttleQueue.add(
  "ping",
  {},
  { throttle: { id: "user-3", ttl: 2_000 }, delay: 60_000 },
);
checkEqual("a throttled job keeps its delay", throttledDelay.state, "delayed");

await clockPast(openedAt + 2_000);
const nextWindow = await throttleQueue.add(
  "ping",
  { n: 4 },
  { throttle: { id: "user-1", ttl: 2_000 } },
);
check(
  "after the window, the next add opens a new one",
  nextWindow.wasAdded && nextWindow.id !== windowOpener.id,
);

/* ------------------------------------------------------------------ */
step("repeat: every, cron, tz, startAt/endAt, limit, key, immediately");

const repeatQueue = openQueue("repeat");
const repeatRuns = new Map<string, RepeatRun[]>();
const scheduledKeys: string[] = [];
repeatQueue.on("repeatScheduled", (key) => {
  scheduledKeys.push(key);
});
startWorker(
  "repeat",
  (job) => {
    const key = job.repeatKey ?? "none";
    const list = repeatRuns.get(key) ?? [];
    list.push({ runAt: job.runAt, processedOn: job.processedOn ?? 0 });
    repeatRuns.set(key, list);
  },
  { concurrency: 8 },
);

/** The stored series for `key`, or undefined. */
async function series(key: string) {
  return (await repeatQueue.listRepeatables()).find(
    (entry) => entry.key === key,
  );
}

// every: milliseconds, with limit.
const ticking = await repeatQueue.add(
  "tick",
  {},
  { repeat: { every: 150, limit: 3 } },
);
checkEqual(
  "an occurrence knows its series",
  [ticking.isRepeat, ticking.repeatKey],
  [true, "tick|every:150|"],
);
check(
  "adding a series emits repeatScheduled",
  scheduledKeys.includes("tick|every:150|"),
);
await waitFor(
  "the limited series to finish",
  async () => (await series("tick|every:150|"))?.nextRunAt === null,
  WAIT,
);
const tickSeries = await series("tick|every:150|");
checkEqual(
  "limit: 3 ran three occurrences",
  repeatRuns.get("tick|every:150|")?.length,
  3,
);
checkEqual(
  "…counted three, with nothing left scheduled",
  [tickSeries?.count, tickSeries?.nextJobId],
  [3, null],
);

// every: a duration, and the "every …" phrasing.
const twoMinutes = await repeatQueue.add(
  "report",
  {},
  { repeat: { every: "2 minutes", key: "two-min" } },
);
const twoMinSeries = await series("two-min");
checkEqual(
  "every: '2 minutes' is stored as milliseconds",
  twoMinSeries?.every,
  120_000,
);
checkEqual(
  "the first occurrence is one interval after creation",
  twoMinutes.runAt - (twoMinSeries?.createdAt ?? 0),
  120_000,
);
await repeatQueue.add(
  "report",
  {},
  { repeat: { every: "every 5 minutes", key: "two-min" } },
);
const updatedSeries = await repeatQueue.listRepeatables();
checkEqual(
  "key: re-adding under the same key updates the one series",
  updatedSeries
    .filter((entry) => entry.key === "two-min")
    .map((entry) => entry.every),
  [300_000],
);

// A repeat added twice with no key derives the same key, so it is one series.
const once = await repeatQueue.add(
  "hourly",
  {},
  { repeat: { every: 3_600_000 } },
);
const twiceAdded = await repeatQueue.add(
  "hourly",
  {},
  { repeat: { every: 3_600_000 } },
);
checkEqual(
  "the same repeat added twice is the same occurrence",
  [twiceAdded.id, twiceAdded.wasAdded],
  [once.id, false],
);
checkEqual(
  "…and one series",
  (await repeatQueue.listRepeatables()).filter(
    (entry) => entry.key === once.repeatKey,
  ).length,
  1,
);

// every: a cron-shaped string is read as cron.
const everySecond = await repeatQueue.add(
  "cron-tick",
  {},
  { repeat: { every: "*/1 * * * * *", limit: 2 } },
);
const cronSeries = await series(everySecond.repeatKey ?? "");
checkEqual(
  "a cron-shaped every is stored as cron",
  [cronSeries?.cron, cronSeries?.every],
  ["*/1 * * * * *", undefined],
);
await waitFor(
  "the cron series to finish",
  async () => (await series(everySecond.repeatKey ?? ""))?.nextRunAt === null,
  WAIT,
);
const cronRuns = repeatRuns.get(everySecond.repeatKey ?? "") ?? [];
checkEqual("it ran its limit of two", cronRuns.length, 2);
check(
  "on whole seconds, at least a second apart",
  cronRuns.every((run) => run.runAt % 1_000 === 0) &&
    (cronRuns[1]?.runAt ?? 0) - (cronRuns[0]?.runAt ?? 0) >= 1_000,
  cronRuns,
);

// cron + tz.
const tokyo = await repeatQueue.add(
  "nine-am",
  {},
  { repeat: { cron: "0 9 * * *", tz: "Asia/Tokyo" } },
);
const newYork = await repeatQueue.add(
  "nine-am",
  {},
  { repeat: { cron: "0 9 * * *", tz: "America/New_York" } },
);
const tokyoAt = new Date(tokyo.runAt);
checkEqual(
  "9am in Tokyo is midnight UTC",
  [tokyoAt.getUTCHours(), tokyoAt.getUTCMinutes()],
  [0, 0],
);
check(
  "9am in New York is 13:00 or 14:00 UTC",
  [13, 14].includes(new Date(newYork.runAt).getUTCHours()),
  new Date(newYork.runAt),
);
check(
  "the time zone is part of the key",
  tokyo.repeatKey !== newYork.repeatKey,
  [tokyo.repeatKey, newYork.repeatKey],
);
check(
  "each is the next occurrence, within a day",
  [tokyo, newYork].every(
    (job) => job.runAt > Date.now() && job.runAt - Date.now() <= 86_400_000,
  ),
);

// A zone Intl does not know is refused before anything is written, on an
// interval series as well as a cron one — and an empty zone is refused rather
// than read as "none". "Europe/Lagos" is the realistic slip: Lagos is in
// Africa/.
const repeatsBeforeZones = (await repeatQueue.listRepeatables()).length;
for (const [label, zone, repeat] of [
  [
    "an interval series",
    "Europe/Lagos",
    { every: "1 day", tz: "Europe/Lagos" },
  ],
  ["a cron series", "Europe/Lagos", { cron: "0 9 * * *", tz: "Europe/Lagos" }],
  ["an empty zone", "", { every: "1 day", tz: "" }],
] as const) {
  const error = await checkRejects(
    `repeat.tz on ${label} is refused`,
    () => repeatQueue.add("zoned", {}, { repeat }),
    {
      name: "ConfigError",
      message: /^repeat\.tz does not know the time zone /,
    },
  );
  checkEqual(
    `repeat.tz on ${label}: the message quotes the zone; context names the option and it`,
    [error?.message, (error as { context?: unknown } | undefined)?.context],
    [
      `repeat.tz does not know the time zone "${zone}"`,
      { option: "repeat.tz", tz: zone },
    ],
  );
}
checkEqual(
  "…and no series was written for any of them",
  (await repeatQueue.listRepeatables()).length,
  repeatsBeforeZones,
);
await checkRejects(
  "two different crons, in cron and every, are refused",
  () =>
    repeatQueue.add(
      "x",
      {},
      {
        repeat: { cron: "0 9 * * *", every: "0 10 * * *" },
      },
    ),
  { name: "ConfigError" },
);
await checkRejects(
  "a repeat with neither cron nor every is refused",
  () => repeatQueue.add("x", {}, { repeat: { limit: 1 } }),
  {
    name: "ConfigError",
  },
);

// startAt / endAt.
const windowStart = Date.now() + 400;
const windowed = await repeatQueue.add(
  "windowed",
  {},
  {
    repeat: {
      every: 200,
      startAt: new Date(windowStart),
      endAt: windowStart + 600,
      key: "windowed",
    },
  },
);
checkEqual(
  "startAt: the first occurrence is due exactly then",
  [windowed.runAt, windowed.state],
  [windowStart, "delayed"],
);
await waitFor(
  "the windowed series to end",
  async () => (await series("windowed"))?.nextRunAt === null,
  WAIT,
);
const windowedRuns = repeatRuns.get("windowed") ?? [];
check(
  "it ran between one and four times, every run inside [startAt, endAt] on the grid",
  windowedRuns.length >= 1 &&
    windowedRuns.length <= 4 &&
    windowedRuns.every(
      (run) =>
        run.runAt >= windowStart &&
        run.runAt <= windowStart + 600 &&
        (run.runAt - windowStart) % 200 === 0 &&
        run.processedOn >= windowStart,
    ),
  windowedRuns,
);
const inWords = await repeatQueue.add(
  "later",
  {},
  {
    repeat: {
      every: "10 minutes",
      startAt: "in 1 hour",
      endAt: "in 2 hours",
      key: "in-words",
    },
  },
);
const wordsSeries = await series("in-words");
check(
  "startAt and endAt accept words",
  Math.abs((wordsSeries?.startAt ?? 0) - (Date.now() + 3_600_000)) < 10_000 &&
    Math.abs((wordsSeries?.endAt ?? 0) - (Date.now() + 7_200_000)) < 10_000 &&
    inWords.runAt === wordsSeries?.startAt,
  wordsSeries,
);
await checkRejects(
  "a series whose endAt has passed has nothing to schedule",
  () =>
    repeatQueue.add(
      "x",
      {},
      {
        repeat: { every: 100, endAt: Date.now() - 1_000 },
      },
    ),
  { name: "ConfigError", message: /no occurrences left/ },
);

// immediately.
const rightAway = await repeatQueue.add(
  "now-then-hourly",
  {},
  {
    repeat: { every: 3_600_000, immediately: true, key: "immediately" },
  },
);
checkEqual(
  "immediately: the first occurrence is waiting now",
  rightAway.state,
  "waiting",
);
await waitFor(
  "the immediate occurrence to run",
  () => (repeatRuns.get("immediately")?.length ?? 0) >= 1,
  WAIT,
);
const immediateSeries = await series("immediately");
checkEqual(
  "…then the series follows its schedule, one interval on",
  (immediateSeries?.nextRunAt ?? 0) - (immediateSeries?.createdAt ?? 0),
  3_600_000,
);
const notImmediately = await repeatQueue.add(
  "hourly-later",
  {},
  { repeat: { every: 3_600_000, key: "not-immediately" } },
);
checkEqual(
  "without it, the first occurrence waits an interval",
  notImmediately.state,
  "delayed",
);

for (const entry of await repeatQueue.listRepeatables()) {
  await repeatQueue.removeRepeatable(entry.key);
}

/* ------------------------------------------------------------------ */
step("repeat.catchUp: missed occurrences replayed, or skipped");

const catchUpQueue = openQueue("catchup");
const EVERY = 250;
const catching = await catchUpQueue.add(
  "on",
  {},
  { repeat: { every: EVERY, limit: 5, catchUp: true, key: "catch-up" } },
);
const skipping = await catchUpQueue.add(
  "off",
  {},
  { repeat: { every: EVERY, limit: 5, key: "skip" } },
);
show("series added; no worker yet");

// Let at least four occurrences of each go by with nothing consuming.
await clockPast(Math.max(catching.runAt, skipping.runAt) + 4 * EVERY);

const catchUpRuns = new Map<string, RepeatRun[]>();
startWorker("catchup", (job) => {
  const list = catchUpRuns.get(job.name) ?? [];
  list.push({ runAt: job.runAt, processedOn: job.processedOn ?? 0 });
  catchUpRuns.set(job.name, list);
});
show("worker started late");

await waitFor(
  "the catch-up series to finish and the skipping one to run twice",
  async () => {
    const done =
      (await catchUpQueue.listRepeatables()).find(
        (entry) => entry.key === "catch-up",
      )?.nextRunAt === null;
    return done && (catchUpRuns.get("off")?.length ?? 0) >= 2;
  },
  WAIT,
);

const on = catchUpRuns.get("on") ?? [];
const off = catchUpRuns.get("off") ?? [];
show(
  "catchUp: true ran (runAt offsets)",
  on.map((run) => run.runAt - catching.runAt),
);
show(
  "catchUp: false ran (runAt offsets)",
  off.map((run) => run.runAt - skipping.runAt),
);

checkEqual("catchUp: true ran all five occurrences", on.length, 5);
check(
  "…one grid step apart, none skipped",
  on.every(
    (run, index) => index === 0 || run.runAt - on[index - 1]!.runAt === EVERY,
  ),
  on,
);
check(
  "…the missed ones run late, as a backlog",
  (on[1]?.processedOn ?? 0) - (on[1]?.runAt ?? 0) > EVERY,
  on[1],
);
check(
  "catchUp: false skipped the missed occurrences",
  (off[1]?.runAt ?? 0) - (off[0]?.runAt ?? 0) > EVERY,
  off,
);
check(
  "…and scheduled the next one in the future",
  (off[1]?.runAt ?? 0) > (off[0]?.processedOn ?? Infinity),
  off,
);

for (const entry of await catchUpQueue.listRepeatables()) {
  await catchUpQueue.removeRepeatable(entry.key);
}

/* ------------------------------------------------------------------ */
step("Cleaning up");

for (const close of closers) {
  await close();
}
await driver.purge(namespace);
await driver.close();

summary();
