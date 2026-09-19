/**
 * Option tour: `JobsNotifier` — one live stream of every queue, worker and
 * runner event in a namespace, from whichever process published it.
 *
 * ```bash
 * bun 10-options/notifier.ts
 * EXAMPLE_DRIVER=sqlite bun 10-options/notifier.ts
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://localhost:6379/13 bun 10-options/notifier.ts
 * ```
 *
 * Covers every `JobsNotifierOptions` field — `queues` and `runners` (`"all"`
 * and a list), `discoveryInterval`, `bufferSize` — and every member: `start`,
 * `close`, `for await`, `on("event" | "subscribed" | "error")`, `following`,
 * `wants`, `follow`, `hold`, `unfollow`, `dropped`, `namespace`. Then what it
 * hears: each queue and runner event with its payload, nothing from producers
 * that do not publish, events from another process, and nothing from another
 * namespace.
 *
 * Points worth knowing:
 *
 * - **It hears only what is published.** `publishEvents` on a `BunJobs`
 *   turns publishing on for everything it creates; `publish` on one queue,
 *   worker or runner wins over it either way.
 * - **Discovery has a gap.** A queue another process starts using is found on
 *   the next pass, and what it published before that is not heard. `follow()`
 *   a queue before it is used — or name it in `queues` — to hear it from its
 *   first event. Queues and runners made by the notifier's own `BunJobs` are
 *   followed as they are created.
 * - **A single `retry()` publishes `retried`** with `ids: [id]`, as
 *   `retryJobs()` and `retryAll()` do for a batch.
 * - **Iterators share one buffer.** Two `for await` loops open at once split
 *   the events between them; iterate once and fan out from there.
 */
import type {
  DriverEvent,
  JobsDriver,
  JobsNotifierEvents,
} from "@kingsleyweb/bun-jobs";
import type { Subprocess } from "bun";
import type { NotifierHandlerArgs } from "./helpers/notifier-handler";
import process from "node:process";
import {
  BunJobs,
  BunQueue,
  BunQueueWorker,
  BunRunner,
  createDriver,
  JobsNotifier,
  parseToken,
} from "@kingsleyweb/bun-jobs";
import {
  crossProcessDriver,
  exampleDriver,
  exampleNamespace,
} from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

title("Option tour: JobsNotifier");

/** Any queue event. */
type QueueEvent = Extract<DriverEvent, { kind: "queue" }>;
/** Any runner event. */
type RunnerEvent = Extract<DriverEvent, { kind: "runner" }>;
/** The queue event with that name. */
type QueueEventOf<TType extends QueueEvent["type"]> = Extract<
  QueueEvent,
  { type: TType }
>;
/** The runner event with that name. */
type RunnerEventOf<TType extends RunnerEvent["type"]> = Extract<
  RunnerEvent,
  { type: TType }
>;

/** What an `orders` job carries. */
interface Order {
  /** Amount in cents. */
  cents: number;
}

/** What an `orders` job returns. */
interface OrderResult {
  /** The amount charged. */
  charged: number;
}

/** Generous, because other suites may share this machine. */
const WAIT = { timeout: 30_000, interval: 10 };

const config = exampleDriver();
const driver = createDriver(config);
const namespace = exampleNamespace("notifier-tour");
const handlerFile = new URL("./helpers/notifier-handler.ts", import.meta.url)
  .pathname;

/** Every child process started here, so none outlives the tour. */
const children: Subprocess[] = [];
process.once("exit", () => {
  for (const child of children) child.kill("SIGKILL");
});

/** The first queue event of that name matching `where`, once it has arrived. */
async function queueEvent<TType extends QueueEvent["type"]>(
  events: DriverEvent[],
  type: TType,
  where: (event: QueueEventOf<TType>) => boolean = () => true,
): Promise<QueueEventOf<TType>> {
  const find = (): QueueEventOf<TType> | undefined => {
    return events.find((event): event is QueueEventOf<TType> => {
      return (
        event.kind === "queue" &&
        event.type === type &&
        where(event as QueueEventOf<TType>)
      );
    });
  };

  await waitFor(`queue event "${type}"`, () => find() !== undefined, WAIT);
  return find()!;
}

/** The first runner event of that name matching `where`, once it has arrived. */
async function runnerEvent<TType extends RunnerEvent["type"]>(
  events: DriverEvent[],
  type: TType,
  where: (event: RunnerEventOf<TType>) => boolean = () => true,
): Promise<RunnerEventOf<TType>> {
  const find = (): RunnerEventOf<TType> | undefined => {
    return events.find((event): event is RunnerEventOf<TType> => {
      return (
        event.kind === "runner" &&
        event.type === type &&
        where(event as RunnerEventOf<TType>)
      );
    });
  };

  await waitFor(`runner event "${type}"`, () => find() !== undefined, WAIT);
  return find()!;
}

/** Events that are about one job or run, by its id. */
function about(events: DriverEvent[], id: string): DriverEvent[] {
  return events.filter((event) => event.id === id);
}

/* ------------------------------------------------------------------ */
step("Constructing: the namespace, and what is followed before start()");

await checkRejects(
  "a notifier on an invalid namespace",
  () => new JobsNotifier(driver, "not a namespace!"),
  { name: "ConfigError" },
);
await checkRejects(
  "a queue list with an invalid name",
  () => new JobsNotifier(driver, namespace, { queues: ["bad name"] }),
  { name: "ConfigError" },
);

const jobs = new BunJobs({ namespace, driver, publishEvents: true });

// Through the context: started, and closed with it.
const notifier = await jobs.notifier();
const heard: DriverEvent[] = [];
notifier.on("event", (event) => {
  heard.push(event);
});

/** `<kind>:<target>` for each of the main notifier's subscriptions in place. */
const ready = new Set<string>();
notifier.on("subscribed", (kind, name) => {
  ready.add(`${kind}:${name}`);
});

/** Resolves once the main notifier's subscription to one target is in place. */
async function subscribedTo(key: string): Promise<void> {
  await waitFor(`the subscription to ${key}`, () => ready.has(key), WAIT);
}

checkEqual("namespace", notifier.namespace, namespace);
checkEqual("a fresh namespace: nothing to follow yet", notifier.following, []);
check(
  'queues and runners default to "all"',
  notifier.wants("queue", "anything") && notifier.wants("runner", "anything"),
);

/* ------------------------------------------------------------------ */
step("Queue events from a producer and a worker (publishEvents: true)");

// Created through the notifier's own context, so — as documented — it is
// followed the moment it is created, with no gap: an add made straight after
// creating the queue is heard.
const orders = jobs.queue<Order, OrderResult>("orders");
const firstAdd = await orders.add("open", { cents: 0 });
await subscribedTo("queue:orders");
check(
  "followed the queue its context created",
  notifier.following.includes("queue:orders"),
  notifier.following,
);

// No gap: a queue this context creates publishes nothing until its notifiers
// are following it, so even the add made the moment it was created is heard.
// The wait is bounded so the rest of the tour still runs if it is not.
const heardFirstAdd = await waitFor(
  "the add made as the queue was created",
  () => about(heard, firstAdd.id).some((event) => event.type === "added"),
  { timeout: 10_000, interval: 10 },
).then(
  () => true,
  () => false,
);
check(
  "no gap: an add made the moment its queue was created is heard",
  heardFirstAdd,
  about(heard, firstAdd.id),
);

// From here the subscription is known to be in place.
const first = await orders.add(
  "charge",
  { cents: 1999 },
  { removeOnComplete: false },
);

const worker = jobs.worker<Order, OrderResult>(
  "orders",
  async (job) => {
    if (job.name === "boom") {
      throw new TypeError("card declined");
    }

    await job.updateProgress(50);
    return { charged: job.data.cents };
  },
  { concurrency: 2, pollInterval: 20 },
);
void worker.run();

const added = await queueEvent(heard, "added", (e) => e.id === first.id);
const waiting = await queueEvent(heard, "waiting", (e) => e.id === first.id);
check(
  "added: the envelope",
  added.v === 1 &&
    added.ns === namespace &&
    added.kind === "queue" &&
    added.target === "orders" &&
    typeof added.at === "number" &&
    typeof added.origin === "string",
  added,
);
checkEqual("added: payload.id", added.payload.id, first.id);
check(
  "waiting follows added (the job was claimable at once)",
  heard.indexOf(added) < heard.indexOf(waiting),
);

const active = await queueEvent(heard, "active", (e) => e.id === first.id);
checkEqual("active: payload.id", active.payload.id, first.id);
const progress = await queueEvent(heard, "progress", (e) => e.id === first.id);
checkEqual("progress: payload.progress", progress.payload.progress, 50);
const completed = await queueEvent(
  heard,
  "completed",
  (e) => e.id === first.id,
);
checkEqual("completed: payload.returnValue", completed.payload.returnValue, {
  charged: 1999,
});

// Failure: two attempts, both failing.
const doomed = await orders.add(
  "boom",
  { cents: 1 },
  { attempts: 2, backoff: 20 },
);
const dead = await queueEvent(heard, "dead", (e) => e.id === doomed.id);
// Each event is its own notification, and a transport such as Postgres
// LISTEN may hand over the last attempt's `failed` after `dead`: wait for both
// rather than reading what happens to have arrived.
await waitFor(
  "a failed event for each attempt",
  () => about(heard, doomed.id).filter((e) => e.type === "failed").length >= 2,
  WAIT,
);
const failures = about(heard, doomed.id).filter((e) => e.type === "failed");
const retrying = await queueEvent(heard, "retrying", (e) => e.id === doomed.id);

check("failed: once per attempt", failures.length >= 2, failures.length);
const failed = failures[0] as QueueEventOf<"failed">;
checkEqual(
  "failed: payload.error is serialized",
  { name: failed.payload.error.name, message: failed.payload.error.message },
  { name: "TypeError", message: "card declined" },
);
check(
  "retrying: payload.error and a numeric runAt",
  retrying.payload.error.message === "card declined" &&
    typeof retrying.payload.runAt === "number" &&
    retrying.payload.runAt >= doomed.createdAt,
  retrying.payload,
);
checkEqual(
  "dead: payload.error.message",
  dead.payload.error.message,
  "card declined",
);

// Retried: a dead job back in the queue.
const retriedIds = await orders.retryJobs([doomed.id]);
const retried = await queueEvent(heard, "retried", (e) => {
  return e.payload.ids.includes(doomed.id);
});
checkEqual("retried: payload.ids", retried.payload.ids, retriedIds);

// A single retry() publishes `retried` too, with just its id — the same event
// a batch sends. The retried job fails its two attempts again first.
const deadEvents = (): DriverEvent[] =>
  heard.filter(
    (e) => e.kind === "queue" && e.type === "dead" && e.id === doomed.id,
  );
await waitFor(
  "the retried job to die again",
  () => deadEvents().length >= 2,
  WAIT,
);
const retriedEvents = (): QueueEventOf<"retried">[] =>
  heard.filter(
    (e): e is QueueEventOf<"retried"> =>
      e.kind === "queue" &&
      e.type === "retried" &&
      (e as QueueEventOf<"retried">).payload.ids.includes(doomed.id),
  );
checkEqual(
  "retry() of a dead job answers true",
  await orders.retry(doomed.id),
  true,
);
await waitFor(
  "a second retried event",
  () => retriedEvents().length >= 2,
  WAIT,
);
checkEqual(
  "retried: a single retry() publishes payload.ids [id]",
  retriedEvents()[1]?.payload.ids,
  [doomed.id],
);

// Cleaned: remove the completed job that was kept.
await waitFor(
  "the completed job to be cleaned",
  async () => {
    const removed = await orders.clean("completed", { olderThan: 0 });
    return removed.length > 0;
  },
  WAIT,
);
const cleaned = await queueEvent(heard, "cleaned", (e) => {
  return e.payload.ids.includes(first.id);
});
checkEqual("cleaned: payload.state", cleaned.payload.state, "completed");

/* ------------------------------------------------------------------ */
step("Queue events from managing a queue with no worker");

const parked = jobs.queue<{ n: number }>("parked");
await subscribedTo("queue:parked");

const duplicateOf = await parked.add("once", { n: 0 }, { jobId: "once" });
await parked.add("once", { n: 0 }, { jobId: "once" });
const duplicate = await queueEvent(heard, "duplicate", (e) => {
  return e.id === duplicateOf.id;
});
checkEqual("duplicate: payload.id", duplicate.payload.id, "once");

const later = await parked.add("later", { n: 1 }, { delay: 60_000 });
const delayed = await queueEvent(heard, "delayed", (e) => e.id === later.id);
checkEqual("delayed: payload.runAt", delayed.payload.runAt, later.runAt);

await parked.remove(later.id);
const removed = await queueEvent(heard, "removed", (e) => e.id === later.id);
checkEqual("removed: payload.id", removed.payload.id, later.id);

const early = await parked.add("early", { n: 2 }, { delay: 60_000 });
await parked.promote(early.id);
const promoted = await queueEvent(heard, "promoted", (e) => e.id === early.id);
checkEqual("promoted: payload.id", promoted.payload.id, early.id);

await parked.pause();
const paused = await queueEvent(heard, "paused");
checkEqual("paused: an empty payload", paused.payload, {});
await parked.resume();
const resumed = await queueEvent(heard, "resumed");
checkEqual("resumed: an empty payload", resumed.payload, {});

const drainedCount = await parked.drain({ delayed: true });
const drained = await queueEvent(heard, "drained");
checkEqual("drained: payload.count", drained.payload.count, drainedCount);
check("drained: the pending jobs", drainedCount >= 2, drainedCount);

const debounceOpener = await parked.add(
  "digest",
  { n: 1 },
  { debounce: { id: "digest", ttl: "30 seconds" } },
);
await parked.add(
  "digest",
  { n: 2 },
  { debounce: { id: "digest", ttl: "30 seconds" } },
);
const debounced = await queueEvent(heard, "debounced");
checkEqual(
  "debounced: the pending job's id",
  debounced.payload.id,
  debounceOpener.id,
);

const throttleOpener = await parked.add(
  "ping",
  { n: 1 },
  { throttle: { id: "ping", ttl: 30_000 } },
);
await parked.add("ping", { n: 2 }, { throttle: { id: "ping", ttl: 30_000 } });
const throttled = await queueEvent(heard, "throttled");
checkEqual(
  "throttled: the window's job id",
  throttled.payload.id,
  throttleOpener.id,
);

await parked.add(
  "tick",
  { n: 0 },
  {
    repeat: { every: 60_000, key: "tour-repeat" },
  },
);
const repeatScheduled = await queueEvent(heard, "repeatScheduled");
check(
  "repeatScheduled: payload.key and a later nextRunAt",
  repeatScheduled.payload.key === "tour-repeat" &&
    repeatScheduled.payload.nextRunAt > repeatScheduled.at,
  repeatScheduled.payload,
);
await parked.removeRepeatable("tour-repeat");

/* ------------------------------------------------------------------ */
step("Runner events");

const reports = jobs.runner<NotifierHandlerArgs, string>({
  id: "reports",
  file: handlerFile,
  executionMode: "in-process",
  runMode: "single",
  queueRuns: true,
});
await reports.start();
await subscribedTo("runner:reports");

const ok = await reports.trigger({ args: { action: "ok" } });
const okRun = ok.outcome === "started" ? ok.runId : "";
const started = await runnerEvent(heard, "started", (e) => e.id === okRun);
check(
  "started: the envelope and payload.runId",
  started.kind === "runner" &&
    started.target === "reports" &&
    started.payload.runId === okRun,
  started,
);
const succeeded = await runnerEvent(heard, "succeeded", (e) => e.id === okRun);
check(
  "succeeded: a numeric durationMs",
  typeof succeeded.payload.durationMs === "number" &&
    succeeded.payload.durationMs >= 0,
  succeeded.payload,
);

const bad = await reports.trigger({ args: { action: "fail" } });
const badRun = bad.outcome === "started" ? bad.runId : "";
const runFailed = await runnerEvent(heard, "failed", (e) => e.id === badRun);
checkEqual(
  "failed: payload.error.message",
  runFailed.payload.error.message,
  "the report could not be built",
);

const hanging = await reports.trigger({ args: { action: "hang" } });
const hangRun = hanging.outcome === "started" ? hanging.runId : "";
await runnerEvent(heard, "started", (e) => e.id === hangRun);

// Single mode, a run in flight, queueRuns: the next trigger waits.
const queuedAt = Date.now();
const waitingTrigger = await reports.trigger({ args: { action: "ok" } });
checkEqual("a trigger while busy is queued", waitingTrigger.outcome, "queued");
const queued = await runnerEvent(heard, "queued", (e) => e.at >= queuedAt);
check(
  "queued: payload.runId",
  typeof queued.payload.runId === "string",
  queued,
);

await reports.kill(hangRun, { reason: "enough" });
const killed = await runnerEvent(heard, "killed", (e) => e.id === hangRun);
checkEqual("killed: payload.reason", killed.payload.reason, "enough");

// The queued trigger runs once the lock is free: a second success, after the
// first run's.
await waitFor(
  "the queued run to succeed",
  () => {
    return (
      heard.filter((e) => {
        return (
          e.kind === "runner" &&
          e.target === "reports" &&
          e.type === "succeeded"
        );
      }).length === 2
    );
  },
  WAIT,
);

await reports.pause();
const skip = await reports.trigger({ args: { action: "ok" } });
checkEqual("a trigger while paused is skipped", skip, {
  outcome: "skipped",
  reason: "paused",
});
const skipped = await runnerEvent(heard, "skipped");
checkEqual("skipped: payload.reason", skipped.payload.reason, "paused");
await reports.resume();

// A controller announces every change it makes, whether or not the runner
// publishes its own events: that is what an owner with remoteControl follows.
const controlledAt = Date.now();
await (await jobs.runners.remote("reports")).pause();
const controlEvent = await runnerEvent(
  heard,
  "control",
  (e) => e.at >= controlledAt,
);
checkEqual("control: payload.action", controlEvent.payload.action, "pause");
await reports.resume();

const slow = jobs.runner<NotifierHandlerArgs, string>({
  id: "slow",
  file: handlerFile,
  executionMode: "in-process",
  timeout: 150,
  closeTimeout: 1_000,
});
await subscribedTo("runner:slow");
const late = await slow.trigger({ args: { action: "hang" } });
const lateRun = late.outcome === "started" ? late.runId : "";
const timeout = await runnerEvent(heard, "timeout", (e) => e.id === lateRun);
checkEqual("timeout: payload.runId", timeout.payload.runId, lateRun);
check(
  "a timeout is also published as failed",
  heard.some(
    (e) => e.kind === "runner" && e.type === "failed" && e.id === lateRun,
  ),
);

/* ------------------------------------------------------------------ */
step("for await, and close() ending an open iterator");

const stream = await jobs.notifier({ queues: ["orders"], runners: [] });
checkEqual("a list follows exactly that", stream.following, ["queue:orders"]);
check(
  "wants: in the list, and nothing outside it",
  stream.wants("queue", "orders") &&
    !stream.wants("queue", "parked") &&
    !stream.wants("runner", "reports"),
);

const iterated: DriverEvent[] = [];
let target = "";
let firstLoopDone = false;
void (async () => {
  for await (const event of stream) {
    iterated.push(event);
    // Stop once all three are in, in whatever order they arrived: on a polling
    // backend an event whose write commits late is delivered late, so
    // `completed` can come before `active`.
    const seen = new Set<string>(
      iterated
        .filter((heard) => heard.kind === "queue" && heard.id === target)
        .map((heard) => heard.type),
    );
    if (["added", "active", "completed"].every((type) => seen.has(type))) {
      break;
    }
  }
  firstLoopDone = true;
})();

target = (await orders.add("charge", { cents: 42 })).id;
await waitFor("the loop to see its job complete", () => firstLoopDone, WAIT);
const iteratedTypes: string[] = iterated
  .filter((event) => event.id === target)
  .map((event) => event.type);
check(
  "the loop saw added, active and completed",
  ["added", "active", "completed"].every((type) =>
    iteratedTypes.includes(type),
  ),
  iteratedTypes,
);

let secondLoopDone = false;
void (async () => {
  for await (const _event of stream) {
    // Waits for events that never come.
  }
  secondLoopDone = true;
})();
await Bun.sleep(50); // let the loop park on next()
await stream.close();
await waitFor("close() to end the waiting loop", () => secondLoopDone, WAIT);
check("close() ended the open iterator", secondLoopDone);
await stream.close(); // a second close is a no-op

/* ------------------------------------------------------------------ */
step("bufferSize: a consumer that falls behind loses the oldest");

const burstNotifier = new JobsNotifier(driver, namespace, {
  queues: ["burst"],
  runners: [],
  bufferSize: 3,
});
await burstNotifier.start();
const burstHeard: DriverEvent[] = [];
burstNotifier.on("event", (event) => {
  burstHeard.push(event);
});

// Opened, and never read until the burst is over.
const slowConsumer = burstNotifier[Symbol.asyncIterator]();
const burst = jobs.queue("burst");
for (let n = 0; n < 5; n++) await burst.add("spike", { n });

await waitFor(
  "ten events (added + waiting, five times)",
  () => burstHeard.length === 10,
  WAIT,
);
checkEqual("dropped: all but bufferSize", burstNotifier.dropped, 7);

const kept: DriverEvent[] = [];
for (let n = 0; n < 3; n++) {
  const next = await slowConsumer.next();
  if (!next.done) kept.push(next.value);
}
checkEqual(
  "the newest three survived, in order",
  kept.map((event) => `${event.type}:${event.id}`),
  burstHeard.slice(-3).map((event) => `${event.type}:${event.id}`),
);
await slowConsumer.return?.();
await burstNotifier.close();
checkEqual(
  "an iterator on a closed notifier is done",
  await burstNotifier[Symbol.asyncIterator]().next(),
  {
    value: undefined,
    done: true,
  },
);

/* ------------------------------------------------------------------ */
step("discoveryInterval, subscribed, follow() and wants()");

const discovering = new JobsNotifier(driver, namespace, {
  runners: [],
  discoveryInterval: 100,
});
const discovered: DriverEvent[] = [];
const subscribed: Parameters<JobsNotifierEvents["subscribed"]>[] = [];
discovering.on("event", (event) => {
  discovered.push(event);
});
discovering.on("subscribed", (kind, name) => {
  subscribed.push([kind, name]);
});
await discovering.start();
check(
  "start() subscribed to the queues already there",
  ["orders", "parked", "burst"].every((name) =>
    discovering.following.includes(`queue:${name}`),
  ),
  discovering.following,
);
check(
  "subscribed fired for each",
  subscribed.some(([kind, name]) => kind === "queue" && name === "parked"),
  subscribed,
);

// A queue this notifier's context did not create: found by discovery.
const lateQueue = new BunQueue("late", { namespace, driver, publish: true });
const lookedAt = Date.now();
await lateQueue.add("first", {});
await waitFor(
  "discovery to find the late queue",
  () => subscribed.some(([kind, name]) => kind === "queue" && name === "late"),
  WAIT,
);
const foundIn = Date.now() - lookedAt;
show("found the late queue after (ms)", foundIn);
check(
  "found within a few discovery passes (slack for load)",
  foundIn < 15_000,
  foundIn,
);

const afterDiscovery = await lateQueue.add("second", {});
await queueEvent(discovered, "added", (e) => e.id === afterDiscovery.id);
check("events from a discovered queue arrive", true);

// follow() before a queue exists hears it from its first event.
await discovering.follow("queue", "not-yet");
await discovering.follow("queue", "not-yet"); // already followed: nothing happens
checkEqual(
  "follow() twice subscribes once",
  subscribed.filter(([kind, name]) => kind === "queue" && name === "not-yet")
    .length,
  1,
);
const newcomer = new BunQueue("not-yet", { namespace, driver, publish: true });
const opener = await newcomer.add("hello", {});
const openerEvent = await queueEvent(
  discovered,
  "added",
  (e) => e.target === "not-yet",
);
checkEqual(
  "the very first event of a followed queue is heard",
  openerEvent.id,
  opener.id,
);
await checkRejects(
  "follow() with an invalid name",
  () => discovering.follow("queue", "no spaces"),
  { name: "ConfigError" },
);

// Lists: exactly what was named, and no discovery timer.
const listed = new JobsNotifier(driver, namespace, {
  queues: ["late"],
  runners: ["reports"],
  discoveryInterval: 10,
});
await listed.start();
checkEqual("lists follow exactly the named targets", listed.following, [
  "queue:late",
  "runner:reports",
]);
await Bun.sleep(300); // an observation window: many 10ms passes, were there any
checkEqual("…and discover nothing more", listed.following, [
  "queue:late",
  "runner:reports",
]);
check(
  "wants: named only",
  listed.wants("queue", "late") &&
    listed.wants("runner", "reports") &&
    !listed.wants("queue", "orders") &&
    !listed.wants("runner", "slow"),
);

// runners: "all" discovers the runners the backend knows about.
const runnersOnly = new JobsNotifier(driver, namespace, {
  queues: [],
  runners: "all",
});
await runnersOnly.start();
check(
  'runners: "all" followed every runner and no queue',
  runnersOnly.following.includes("runner:reports") &&
    runnersOnly.following.includes("runner:slow") &&
    runnersOnly.following.every((key) => key.startsWith("runner:")),
  runnersOnly.following,
);

await Promise.all([
  discovering.close(),
  listed.close(),
  runnersOnly.close(),
  lateQueue.close(),
  newcomer.close(),
]);

/* ------------------------------------------------------------------ */
step("hold() and unfollow(): following only while something needs it");

// `follow()` is for good. `hold()` is for followers whose names come from
// outside — the management API's socket holds a queue while a client is
// subscribed to it, and a client may name one that never exists — so it is
// reference-counted, and `unfollow()` releases one hold.

/** Set while the tour wants subscriptions to wait. */
let subscribeGate: PromiseWithResolvers<void> | undefined;
/** Every queue list the driver answered with, in order. */
const listings: string[][] = [];

// The real driver, except that a subscribe can be held at a gate and every
// listing is recorded. Methods are bound so its private state works.
const observed = new Proxy(driver, {
  get(real, property) {
    if (property === "subscribe") {
      const subscribe: JobsDriver["subscribe"] = async (...args) => {
        await subscribeGate?.promise;
        return await real.subscribe(...args);
      };
      return subscribe;
    }
    if (property === "listQueues") {
      const listQueues: JobsDriver["listQueues"] = async (ns) => {
        const queues = await real.listQueues(ns);
        listings.push(queues);
        return queues;
      };
      return listQueues;
    }
    const value = Reflect.get(real, property, real) as unknown;
    return typeof value === "function" ? value.bind(real) : value;
  },
});

const holding = new JobsNotifier(observed, namespace, {
  runners: [],
  discoveryInterval: 100,
});
const holdSubscribed: string[] = [];
holding.on("subscribed", (kind, name) => {
  holdSubscribed.push(`${kind}:${name}`);
});
await holding.start();

// `following` lists live subscriptions only — not one still being set up.
subscribeGate = Promise.withResolvers<void>();
const firstHold = holding.hold("queue", "held");
check(
  "a subscription in flight is not listed in following",
  !holding.following.includes("queue:held"),
  holding.following,
);
subscribeGate.resolve();
subscribeGate = undefined;
await firstHold;
check(
  "hold() resolves once it is live, and listed",
  holding.following.includes("queue:held"),
  holding.following,
);

await holding.hold("queue", "held");
checkEqual(
  "two holds, one subscription",
  holdSubscribed.filter((key) => key === "queue:held").length,
  1,
);
await holding.unfollow("queue", "held");
check(
  "releasing one of two holds keeps it",
  holding.following.includes("queue:held"),
  holding.following,
);
await holding.unfollow("queue", "held");
check(
  "releasing the last drops it",
  !holding.following.includes("queue:held"),
  holding.following,
);
await holding.unfollow("queue", "held");
await holding.unfollow("queue", "never-held");
check("releasing what is not held does nothing", true);

// Discovery, the configured lists and follow() follow for good, and a hold
// never undoes them.
await holding.follow("queue", "kept");
await holding.hold("queue", "kept");
await holding.unfollow("queue", "kept");
check(
  "follow() then hold(): the unfollow leaves it followed",
  holding.following.includes("queue:kept"),
  holding.following,
);
await holding.hold("queue", "promoted");
await holding.follow("queue", "promoted");
await holding.unfollow("queue", "promoted");
check(
  "hold() then follow(): followed for good from then on",
  holding.following.includes("queue:promoted"),
  holding.following,
);

// A held name that a discovery pass later finds becomes permanent too.
await holding.hold("queue", "found-later");
const foundLater = new BunQueue("found-later", {
  namespace,
  driver,
  publish: true,
});
await foundLater.add("first", {});
const listingsBefore = listings.length;
await waitFor(
  "a discovery pass to list found-later",
  () =>
    listings
      .slice(listingsBefore)
      .some((queues) => queues.includes("found-later")),
  WAIT,
);
await holding.unfollow("queue", "found-later");
check(
  "a held name discovery found stays followed after its last unfollow",
  holding.following.includes("queue:found-later"),
  holding.following,
);

const configured = new JobsNotifier(driver, namespace, {
  queues: ["late"],
  runners: [],
});
await configured.start();
await configured.hold("queue", "late");
await configured.unfollow("queue", "late");
checkEqual(
  "a configured name stays followed after hold and unfollow",
  configured.following,
  ["queue:late"],
);

await holding.hold("queue", "at-close");
await holding.close();
checkEqual("close() drops every hold with the rest", holding.following, []);
await Promise.all([configured.close(), foundLater.close()]);

/* ------------------------------------------------------------------ */
step('on("error"): a failed subscription and a failed discovery pass');

let refuseListing = false;

// The real driver, except that it refuses one subscription, and listing when
// told to. Methods are bound to the real driver so its private state works.
const flaky = new Proxy(driver, {
  get(real, property) {
    if (property === "subscribe") {
      const subscribe: JobsDriver["subscribe"] = async (
        ns,
        kind,
        name,
        listener,
      ) => {
        if (name === "broken") {
          throw new Error("subscription refused");
        }
        return await real.subscribe(ns, kind, name, listener);
      };
      return subscribe;
    }

    if (property === "listQueues" && refuseListing) {
      return async () => {
        throw new Error("listing refused");
      };
    }

    const value = Reflect.get(real, property, real) as unknown;
    return typeof value === "function" ? value.bind(real) : value;
  },
});

const fragile = new JobsNotifier(flaky, namespace, {
  runners: [],
  discoveryInterval: 50,
});
const errors: { message: string; context: string }[] = [];
fragile.on("error", (error, context) => {
  errors.push({ message: error.message, context });
});
await fragile.start();

await fragile.follow("queue", "broken");
checkEqual("a failed subscription is reported, not thrown", errors[0], {
  message: "subscription refused",
  context: "subscribe queue:broken",
});
check(
  "…and is not counted as followed",
  !fragile.following.includes("queue:broken"),
  fragile.following,
);

refuseListing = true;
await waitFor(
  "a discovery pass to fail",
  () => errors.some((e) => e.context === "discover"),
  WAIT,
);
check(
  "a failed discovery pass is reported with context discover",
  errors.some(
    (e) => e.context === "discover" && e.message === "listing refused",
  ),
);
await fragile.close();

/* ------------------------------------------------------------------ */
step(
  "Nothing is heard from a producer, worker or runner that does not publish",
);

const quietJobs = new BunJobs({ namespace, driver }); // publishEvents: false
await notifier.follow("queue", "quiet");

let quietDone = 0;
const quietWorker = quietJobs.worker("quiet", async () => "done", {
  pollInterval: 20,
});
quietWorker.on("completed", () => {
  quietDone++;
});
void quietWorker.run();

const unheard = await quietJobs.queue("quiet").add("hush", {});
await waitFor("the quiet job to complete", () => quietDone === 1, WAIT);
await quietWorker.close();

// A publishing producer on the same queue: its event arrives after anything
// the quiet ones would have said, so its arrival closes the window.
const control = await jobs.queue("quiet").add("loud", {});
await queueEvent(heard, "added", (e) => e.id === control.id);
checkEqual(
  "publishEvents off: no event about the quiet job",
  about(heard, unheard.id),
  [],
);

// publish: false on one queue wins over its context's publishEvents.
const muted = jobs.queue("muted", { publish: false });
await notifier.follow("queue", "muted");
await subscribedTo("queue:muted");
const mutedJob = await muted.add("hush", {});
const loudMuted = new BunQueue("muted", { namespace, driver, publish: true });
const mutedControl = await loudMuted.add("loud", {});
await queueEvent(heard, "added", (e) => e.id === mutedControl.id);
checkEqual(
  "publish: false wins over publishEvents",
  about(heard, mutedJob.id),
  [],
);
await loudMuted.close();

// …and on one runner.
const silent = jobs.runner<NotifierHandlerArgs, string>({
  id: "silent",
  file: handlerFile,
  executionMode: "in-process",
  publish: false,
});
await notifier.follow("runner", "silent");
await subscribedTo("runner:silent");
let silentFinished = false;
silent.on("finished", () => {
  silentFinished = true;
});
const silentRun = await silent.trigger({ args: { action: "ok" } });
await waitFor("the silent run to finish", () => silentFinished, WAIT);
await silent.stop();

const loudRunner = new BunRunner<NotifierHandlerArgs, string>({
  id: "silent",
  namespace,
  driver,
  file: handlerFile,
  executionMode: "in-process",
  publish: true,
});
const loudRun = await loudRunner.trigger({ args: { action: "ok" } });
const loudRunId = loudRun.outcome === "started" ? loudRun.runId : "";
await runnerEvent(heard, "succeeded", (e) => e.id === loudRunId);
checkEqual(
  "a runner with publish: false says nothing",
  about(heard, silentRun.outcome === "started" ? silentRun.runId : "?"),
  [],
);
await loudRunner.stop();

/* ------------------------------------------------------------------ */
step("Nothing is heard from another namespace");

const otherNamespace = `${namespace}-other`;
const otherJobs = new BunJobs({
  namespace: otherNamespace,
  driver,
  publishEvents: true,
});
const foreign = await otherJobs.queue("parked").add("elsewhere", {});
const homeControl = await parked.add("here", { n: 9 });
await queueEvent(heard, "added", (e) => e.id === homeControl.id);
checkEqual(
  "no event about the other namespace's job",
  about(heard, foreign.id),
  [],
);
check(
  "every event heard belongs to this namespace",
  heard.every((event) => event.ns === namespace),
);
await otherJobs.purge();
await otherJobs.close();

/* ------------------------------------------------------------------ */
step("Events from another process");

// A backend both processes can reach: memory becomes a temporary SQLite file.
const sharedConfig = crossProcessDriver();
const sharedDriver = createDriver(sharedConfig);
const sharedNamespace = exampleNamespace("notifier-remote");

const remote = new JobsNotifier(sharedDriver, sharedNamespace, {
  queues: ["remote"],
  runners: [],
});
const remoteHeard: DriverEvent[] = [];
remote.on("event", (event) => {
  remoteHeard.push(event);
});
await remote.start();

/** Starts `helpers/notifier-remote.ts` in a role. */
function spawnRemote(role: "produce-and-consume" | "hang"): Subprocess {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("./helpers/notifier-remote.ts", import.meta.url).pathname,
    ],
    {
      env: {
        ...process.env,
        ROLE: role,
        NAMESPACE: sharedNamespace,
        DRIVER_CONFIG: JSON.stringify(sharedConfig),
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  children.push(child);
  return child;
}

const producer = spawnRemote("produce-and-consume");
const remoteCompleted = await queueEvent(remoteHeard, "completed", (e) => {
  return e.target === "remote";
});
checkEqual(
  "completed in the child, heard here, with its return value",
  remoteCompleted.payload.returnValue,
  { from: producer.pid },
);
const remoteAdded = await queueEvent(remoteHeard, "added", (e) => {
  return e.id === remoteCompleted.id;
});
checkEqual(
  "origin: the child's process",
  parseToken(remoteAdded.origin)?.pid,
  producer.pid,
);
await waitFor("the producer to exit", () => producer.exitCode !== null, WAIT);

// Stalled: a child claims a job and is killed holding it.
const sharedQueue = new BunQueue("remote", {
  namespace: sharedNamespace,
  driver: sharedDriver,
});
const stuck = await sharedQueue.add("stuck", {});
const hanger = spawnRemote("hang");
await queueEvent(remoteHeard, "active", (e) => e.id === stuck.id);
hanger.kill("SIGKILL");
await hanger.exited;
show("killed the child holding", stuck.id);

const rescuer = new BunQueueWorker("remote", async () => "recovered", {
  namespace: sharedNamespace,
  driver: sharedDriver,
  publish: true,
  lockDuration: 500,
  stalledInterval: 200,
  pollInterval: 20,
});
void rescuer.run();
const stalled = await queueEvent(remoteHeard, "stalled", (e) => {
  return e.payload.ids.includes(stuck.id);
});
checkEqual(
  "stalled: payload.ids",
  stalled.payload.ids.includes(stuck.id),
  true,
);
const rescued = await queueEvent(remoteHeard, "completed", (e) => {
  return e.id === stuck.id;
});
checkEqual(
  "the recovered job completed here",
  rescued.payload.returnValue,
  "recovered",
);

await rescuer.close();
await sharedQueue.close();
await remote.close();
await sharedDriver.purge(sharedNamespace);
await sharedDriver.close();

/* ------------------------------------------------------------------ */
step("Closing");

await jobs.close(); // closes the notifiers it opened, its workers and runners
await quietJobs.close();
check(
  "a notifier opened through BunJobs is closed with it",
  notifier.following.length === 0,
  notifier.following,
);
await driver.purge(namespace);
await driver.close();

summary();
