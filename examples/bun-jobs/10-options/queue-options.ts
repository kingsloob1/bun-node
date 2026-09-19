/**
 * Option tour: every `BunQueueOptions` field, and every public `BunQueue`
 * method with every option it takes, each asserted — plus every event a
 * queue emits.
 *
 * ```bash
 * bun 10-options/queue-options.ts
 * EXAMPLE_DRIVER=postgres EXAMPLE_POSTGRES_URL=postgres://user:pass@localhost/jobs bun 10-options/queue-options.ts
 * ```
 *
 * A few things worth knowing before reading it:
 *
 * - A queue given a driver **config** builds that driver and closes it on
 *   `close()`; a queue given an **instance** shares it and never closes it.
 * - `publish` is independent of `subscribe` and defaults to it. A queue that
 *   only publishes is heard by subscribers but hears nothing itself; a
 *   subscriber never hears its own events echoed back.
 * - A `retry()` that went emits one `retried` with `[id]`, and one that
 *   changed nothing emits nothing; `retryJobs()` and `retryAll()` emit one
 *   `retried` per batch. `retryAll`'s `reason` is matched against
 *   `"<error name>: <message>"`, so it never matches a completed job.
 * - `update()` answers `null` rather than throwing when the patch cannot
 *   apply, and `onlyIn` refuses the *whole* patch, not just `runAt`.
 * - Most sections use a queue of their own, so what one does — a count, a
 *   drain, a clean — cannot be disturbed by another.
 */
import type { LogEvent } from "@kingsleyweb/bun-common";
import type {
  BunQueueOptions,
  BunQueueWorkerOptions,
  DateParser,
  Job,
  JobOptions,
  JobProcessor,
  JobsDriver,
} from "@kingsleyweb/bun-jobs";
import { BunQueue, BunQueueWorker, createDriver } from "@kingsleyweb/bun-jobs";
import { exampleDriver, exampleNamespace } from "../shared/backend";
import { check, checkEqual, checkRejects, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";

/** What every job in this tour carries. */
interface Payload {
  /** A label to recognise the job by. */
  label?: string;
  /** A number, for jobs that need telling apart. */
  n?: number;
  /** A version, for updates. */
  v?: number;
  /** Makes the processor throw. */
  fail?: boolean;
  /** The message the processor throws with. */
  reason?: string;
  /** The name the thrown error is given. */
  errorName?: string;
}

/** One event a queue emitted. */
interface Heard {
  /** The queue that emitted it. */
  queue: string;
  /** The event's name. */
  event: string;
  /** The arguments it was emitted with. */
  args: unknown[];
}

title("Option tour: BunQueueOptions and every BunQueue method");

const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("queue-options");
const otherNamespace = exampleNamespace("queue-options-other");

/** Generous waits: other suites share this machine and the servers. */
const WAIT = { timeout: 30_000, interval: 20 };

/** Every event a `BunQueue` emits, apart from `error` and the worker-side ones. */
const QUEUE_EVENTS = [
  "added",
  "duplicate",
  "waiting",
  "delayed",
  "removed",
  "promoted",
  "paused",
  "resumed",
  "drained",
  "cleaned",
  "retried",
  "debounced",
  "throttled",
  "repeatScheduled",
] as const;

/** Every event heard from every queue opened with {@link openQueue}. */
const heard: Heard[] = [];

/** Everything opened here, closed at the end — workers first. */
const closers: (() => Promise<void>)[] = [];

/** A queue in this tour's namespace, with every event recorded. */
function openQueue(
  name: string,
  options: Partial<BunQueueOptions> = {},
): BunQueue<Payload, unknown, string> {
  const queue = new BunQueue<Payload, unknown, string>(name, {
    namespace,
    driver,
    ...options,
  });

  for (const event of QUEUE_EVENTS) {
    // Every listener has the same shape here, so one cast covers them all.
    queue.on(event as "paused", (...args: unknown[]) => {
      heard.push({ queue: name, event, args });
    });
  }

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

/** The arguments of each `event` from `queue` since `mark`. */
function heardSince(mark: number, queue: string, event: string): unknown[][] {
  return heard
    .slice(mark)
    .filter((entry) => entry.queue === queue && entry.event === event)
    .map((entry) => entry.args);
}

/** The ids of the jobs each `event` from `queue` carried since `mark`. */
function jobIdsSince(mark: number, queue: string, event: string): string[] {
  return heardSince(mark, queue, event).map(
    (args) => (args[0] as Job<Payload, unknown>).id,
  );
}

/** Waits for `predicate`, answering whether it came true in time. */
async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeout = 20_000,
): Promise<boolean> {
  try {
    await waitFor("a condition", predicate, { timeout, interval: 20 });
    return true;
  } catch {
    return false;
  }
}

/** Waits until the clock has moved past `instant`. */
async function clockPast(instant: number): Promise<void> {
  await waitFor("the clock to move on", () => Date.now() > instant, WAIT);
}

/** Waits until every id in `queue` is in one of `states`. */
async function reach(
  queue: BunQueue<Payload, unknown, string>,
  ids: string[],
  states: string[],
): Promise<void> {
  await waitFor(
    `${ids.length} job(s) in ${queue.name} to reach ${states.join("/")}`,
    async () => {
      for (const id of ids) {
        if (!states.includes((await queue.getJob(id))?.state ?? "missing")) {
          return false;
        }
      }
      return true;
    },
    WAIT,
  );
}

/** Ids in a stable order, for comparing sets. */
function sorted(ids: string[]): string[] {
  return ids.toSorted();
}

/** Labels of jobs, in the order given. */
function labels(jobs: Job<Payload, unknown>[]): (string | undefined)[] {
  return jobs.map((job) => job.data.label);
}

/* ------------------------------------------------------------------ */
step("namespace: the same queue name in two namespaces is two queues");

const orders = openQueue("orders");
const neighbour = new BunQueue<Payload, unknown, string>("orders", {
  namespace: otherNamespace,
  driver,
});
closers.push(async () => await neighbour.close());

const mine = await orders.add("invoice", { n: 0 });
checkEqual(
  "name, namespace and ref",
  [orders.name, orders.namespace, orders.ref],
  ["orders", namespace, { ns: namespace, queue: "orders" }],
);
checkEqual(
  "the job is in this namespace",
  (await orders.getJob(mine.id))?.id,
  mine.id,
);
checkEqual("…and not in the other", await neighbour.getJob(mine.id), null);
checkEqual(
  "the other namespace's queue is empty",
  await neighbour.count("waiting"),
  0,
);
await orders.remove(mine.id);

await checkRejects(
  "a namespace is required",
  () => new BunQueue("orders", { namespace: "" }),
  {
    name: "ConfigError",
    code: "CONFIG",
  },
);
await checkRejects(
  "…and must be one segment",
  () => new BunQueue("orders", { namespace: "has spaces" }),
  {
    name: "ConfigError",
  },
);
await checkRejects(
  "a queue name must be one segment too",
  () => new BunQueue("a/b", { namespace }),
  {
    name: "ConfigError",
  },
);

/* ------------------------------------------------------------------ */
step(
  "driver: a config is built and closed by the queue; an instance is shared",
);

/** Counts calls to a driver's `close()`, passing each one through. */
function countCloses(target: JobsDriver): () => number {
  let calls = 0;
  const original = target.close.bind(target);
  target.close = async () => {
    calls++;
    await original();
  };
  return () => calls;
}

const owning = new BunQueue<Payload, unknown, string>("owned", {
  namespace,
  driver: exampleDriver(),
});
const ownedCloses = countCloses(owning.driver);
check("a config builds a driver of the queue's own", owning.driver !== driver);
checkEqual("…which works", (await owning.add("x", {})).wasAdded, true);
await owning.close();
checkEqual("close() closes a driver the queue built", ownedCloses(), 1);

const sharedCloses = countCloses(driver);
const sharing = new BunQueue<Payload, unknown, string>("shared", {
  namespace,
  driver,
});
checkEqual("an instance is used as it is", sharing.driver, driver);
await sharing.add("x", {});
await sharing.close();
checkEqual("close() leaves a driver it was given open", sharedCloses(), 0);
check("…still reachable", await driver.ping());
const stillOpen = await orders.add("still-open", {});
checkEqual(
  "…and still usable by the queues sharing it",
  stillOpen.wasAdded,
  true,
);
await orders.remove(stillOpen.id);

const implicit = new BunQueue<Payload, unknown, string>("implicit", {
  namespace,
});
checkEqual(
  "no driver at all means a memory driver",
  implicit.driver.name,
  "memory",
);
const implicitCloses = countCloses(implicit.driver);
await implicit.close();
checkEqual("…which the queue owns, and closes", implicitCloses(), 1);

/* ------------------------------------------------------------------ */
step("logger: anything resolveLogger accepts, bound to the queue");

const records: LogEvent[] = [];
const logged = openQueue("logged", {
  logger: (event: LogEvent) => {
    records.push(event);
  },
});
logged.logger.info("order received", { orderId: 7 });
const record = records.at(-1);
checkEqual(
  "a bare sink function receives the queue's records",
  record?.message,
  "order received",
);
checkEqual("…with the call's fields", record?.fields, { orderId: 7 });
checkEqual(
  "…and the queue's namespace and name bound",
  [record?.bindings.namespace, record?.bindings.queue],
  [namespace, "logged"],
);

/* ------------------------------------------------------------------ */
step("defaultJobOptions: merged under every add, field by field");

const withDefaults = openQueue("defaults", {
  defaultJobOptions: {
    attempts: 4,
    priority: 3,
    timeout: 900,
    delay: 60_000,
    backoff: { type: "fixed", delay: 10 },
    keepLogs: 20,
  },
});
const bare = await withDefaults.add("x", {});
checkEqual(
  "the queue's defaults apply to a bare add",
  [
    bare.opts.attempts,
    bare.opts.priority,
    bare.opts.timeout,
    bare.opts.keepLogs,
    bare.opts.backoff,
  ],
  [4, 3, 900, 20, { type: "fixed", delay: 10 }],
);
checkEqual(
  "built-ins fill whatever the queue leaves unset",
  [
    bare.opts.keepStacktraces,
    bare.opts.removeOnFail,
    bare.opts.removeOnComplete,
  ],
  [5, false, { ttl: 86_400_000 }],
);
checkEqual(
  "…and a default delay delays it",
  [bare.state, bare.runAt - bare.createdAt],
  ["delayed", 60_000],
);

const overridden = await withDefaults.add(
  "x",
  {},
  { priority: -1, delay: 0, backoff: { type: "linear" } },
);
checkEqual(
  "the call wins, field by field",
  [overridden.opts.priority, overridden.opts.attempts, overridden.state],
  [-1, 4, "waiting"],
);
checkEqual(
  "an object option from the call replaces the default whole",
  overridden.opts.backoff,
  { type: "linear" },
);
const pinnedAt = Date.now() + 5_000;
const pinned = await withDefaults.add("x", {}, { runAt: pinnedAt });
checkEqual(
  "a call's runAt wins over the default delay",
  pinned.runAt,
  pinnedAt,
);

/* ------------------------------------------------------------------ */
step("subscribe and publish: hearing other instances' events");

const watcher = openQueue("events", { subscribe: true });
const silent = openQueue("events");
const announcer = openQueue("events", { publish: true });
const subscriber = openQueue("events", { subscribe: true });
const watcherAdds: string[] = [];
const announcerAdds: string[] = [];
watcher.on("added", (job) => {
  watcherAdds.push(job.id);
});
announcer.on("added", (job) => {
  announcerAdds.push(job.id);
});
// The subscription opens on connect, which any method does; done up front so
// it is in place before the adds below.
await watcher.connect();
await subscriber.connect();

const quiet = await silent.add("x", { label: "quiet" });
const loud = await announcer.add("x", { label: "loud" });
check(
  "publish: true is heard by a subscriber, without subscribing itself",
  await eventually(() => watcherAdds.includes(loud.id)),
  watcherAdds,
);
check(
  "a queue that neither publishes nor subscribes is not heard",
  !watcherAdds.includes(quiet.id),
  { quiet: quiet.id, watcherAdds },
);
const fromSubscriber = await subscriber.add("x", { label: "subscriber" });
check(
  "publish defaults to subscribe: a subscriber is heard too",
  await eventually(() => watcherAdds.includes(fromSubscriber.id)),
  watcherAdds,
);
const own = await watcher.add("x", { label: "own" });
const marker = await announcer.add("x", { label: "marker" });
await eventually(() => watcherAdds.includes(marker.id));
checkEqual(
  "a subscriber hears its own add once, not echoed back",
  watcherAdds.filter((id) => id === own.id).length,
  1,
);
checkEqual("without subscribe, a queue hears only itself", announcerAdds, [
  loud.id,
  marker.id,
]);

/* ------------------------------------------------------------------ */
step("dateParser: reads the words in a repeat");

const PAYDAY = Date.UTC(2031, 0, 28, 9);
const payday: DateParser = {
  parse(text) {
    const index = text.toLowerCase().indexOf("payday");
    return index < 0
      ? []
      : [
          {
            index,
            text: text.slice(index, index + "payday".length),
            start: { date: () => new Date(PAYDAY) },
          },
        ];
  },
};
const dated = openQueue("dated", { dateParser: payday });
check("queue.dateParser is the parser given", dated.dateParser === payday);
checkEqual("…and undefined when none was", orders.dateParser, undefined);

const salary = await dated.add(
  "salary",
  {},
  { repeat: { every: "30 days", startAt: "payday", key: "salary" } },
);
checkEqual("repeat.startAt words are read by it", salary.runAt, PAYDAY);
const fortnightly = await dated.add(
  "fortnightly",
  {},
  {
    repeat: { every: "every 2 weeks from payday", key: "fortnightly" },
  },
);
const fortnightlySeries = (await dated.listRepeatables()).find(
  (entry) => entry.key === "fortnightly",
);
checkEqual(
  "…and so are the dates inside an every phrase",
  [fortnightlySeries?.every, fortnightlySeries?.startAt, fortnightly.runAt],
  [1_209_600_000, PAYDAY, PAYDAY],
);
await checkRejects(
  "a dateParser without parse is refused when the queue is built",
  () =>
    new BunQueue("x", {
      namespace,
      driver,
      dateParser: {} as DateParser,
    }),
  { name: "ConfigError" },
);
await dated.removeRepeatable("salary");
await dated.removeRepeatable("fortnightly");

/* ------------------------------------------------------------------ */
step("connect(): idempotent, and called for you");

await orders.connect();
await orders.connect();
check("connect() may be called repeatedly", true);
const lazy = openQueue("lazy");
checkEqual(
  "every method connects on its own",
  (await lazy.add("x", {})).wasAdded,
  true,
);

/* ------------------------------------------------------------------ */
step(
  "add(): waiting or delayed, with added / waiting / delayed, and a name-scoped event",
);

let mark = heard.length;
const waitingJob = await orders.add("invoice", { n: 1 });
const delayedJob = await orders.add("invoice", { n: 2 }, { delay: 60_000 });
checkEqual(
  "a job due now is waiting; one for later is delayed",
  [waitingJob.state, delayedJob.state],
  ["waiting", "delayed"],
);
checkEqual("added fired for both", jobIdsSince(mark, "orders", "added"), [
  waitingJob.id,
  delayedJob.id,
]);
checkEqual(
  "waiting fired for the claimable one",
  jobIdsSince(mark, "orders", "waiting"),
  [waitingJob.id],
);
checkEqual(
  "delayed fired with its runAt",
  heardSince(mark, "orders", "delayed").map(([job, runAt]) => [
    (job as Job<Payload, unknown>).id,
    runAt,
  ]),
  [[delayedJob.id, delayedJob.runAt]],
);
await checkRejects("a job needs a name", () => orders.add("", {}), {
  name: "ConfigError",
});
await checkRejects(
  "data must survive JSON",
  () => orders.add("x", { n: 10n } as unknown as Payload),
  {
    name: "SerializationError",
    code: "SERIALIZATION",
  },
);

const scopedAdds: string[] = [];
const scopedDelays: number[] = [];
orders.on("added:receipt", (job) => {
  scopedAdds.push(job.id);
});
orders.on("delayed:receipt", (_job, runAt) => {
  scopedDelays.push(runAt);
});
const receipt = await orders.add("receipt", {}, { delay: 30_000 });
await orders.add("invoice", {}, { delay: 30_000 });
checkEqual("added:receipt fires only for jobs named receipt", scopedAdds, [
  receipt.id,
]);
checkEqual(
  "delayed:receipt takes the same arguments as delayed",
  scopedDelays,
  [receipt.runAt],
);

/* ------------------------------------------------------------------ */
step("addBulk(): options per entry, idempotent per id, repeats allowed");

mark = heard.length;
const bulk = await orders.addBulk([
  { name: "bulk", data: { n: 1 } },
  { name: "bulk", data: { n: 2 }, opts: { jobId: "bulk-fixed", priority: 2 } },
  { name: "bulk", data: { n: 3 }, opts: { delay: 60_000 } },
]);
checkEqual(
  "every entry was added",
  bulk.map((job) => job.wasAdded),
  [true, true, true],
);
checkEqual(
  "…each with its own options",
  [bulk[1]?.id, bulk[1]?.priority, bulk[2]?.state],
  ["bulk-fixed", 2, "delayed"],
);
const bulkAgain = await orders.addBulk([
  { name: "bulk", data: { n: 9 }, opts: { jobId: "bulk-fixed" } },
  { name: "bulk", data: { n: 4 } },
]);
checkEqual(
  "a known id in a bulk add is a duplicate",
  bulkAgain.map((job) => job.wasAdded),
  [false, true],
);
checkEqual(
  "added and duplicate fired per entry",
  [
    jobIdsSince(mark, "orders", "added").length,
    jobIdsSince(mark, "orders", "duplicate"),
  ],
  [4, ["bulk-fixed"]],
);
const withRepeat = await orders.addBulk([
  { name: "bulk", data: {} },
  {
    name: "bulk-repeat",
    data: {},
    opts: { repeat: { every: 3_600_000, key: "bulk-repeat" } },
  },
]);
checkEqual(
  "a bulk add may include a repeat",
  [withRepeat.length, withRepeat[1]?.isRepeat],
  [2, true],
);

/* ------------------------------------------------------------------ */
step("getJob(), list() and count()");

const fetched = await orders.getJob(waitingJob.id);
checkEqual(
  "getJob() reads a job back",
  [fetched?.id, fetched?.name, fetched?.data],
  [waitingJob.id, "invoice", { n: 1 }],
);
checkEqual("…or answers null", await orders.getJob("no-such-job"), null);

const listing = openQueue("listing");
for (const priority of [5, 4, 3, 2, 1]) {
  await listing.add("rank", { label: `p${priority}` }, { priority });
}
// Added soonest first, so due time and creation time agree: the SQL and
// MongoDB drivers list a single state other than waiting by creation time,
// the others by due time.
await listing.add("sooner", { label: "d1" }, { delay: 60_000 });
await listing.add("later", { label: "d2" }, { delay: 120_000 });

checkEqual(
  "list(state) is in that state's order: claim order for waiting",
  labels(await listing.list("waiting")),
  ["p1", "p2", "p3", "p4", "p5"],
);
checkEqual(
  "offset and limit page it",
  labels(await listing.list("waiting", { offset: 1, limit: 2 })),
  ["p2", "p3"],
);
checkEqual(
  "order: desc reverses it",
  labels(await listing.list("waiting", { order: "desc" })),
  ["p5", "p4", "p3", "p2", "p1"],
);
checkEqual(
  "list(state) for delayed jobs",
  labels(await listing.list("delayed")),
  ["d1", "d2"],
);
checkEqual(
  "list([states]) takes several",
  labels(await listing.list(["waiting", "delayed"])).toSorted(),
  ["d1", "d2", "p1", "p2", "p3", "p4", "p5"],
);
checkEqual(
  "…and pages them too",
  (await listing.list(["waiting", "delayed"], { limit: 3 })).length,
  3,
);

const counts = await listing.count();
checkEqual(
  "count() counts each state",
  [
    counts.waiting,
    counts.delayed,
    counts.active,
    counts.completed,
    counts.failed,
    counts.dead,
  ],
  [5, 2, 0, 0, 0, 0],
);
checkEqual("count(state) counts one", await listing.count("waiting"), 5);

/* ------------------------------------------------------------------ */
step("remove(): refused while active");

mark = heard.length;
const removable = await orders.add("x", {});
checkEqual(
  "remove() removes a waiting job",
  await orders.remove(removable.id),
  true,
);
checkEqual(
  "…emitting removed with its id",
  heardSince(mark, "orders", "removed"),
  [[removable.id]],
);
checkEqual("…and it is gone", await orders.getJob(removable.id), null);
checkEqual(
  "removing it again answers false",
  await orders.remove(removable.id),
  false,
);

const busy = openQueue("busy");
const gate = Promise.withResolvers<void>();
startWorker("busy", async () => {
  await gate.promise;
  return "released";
});
const running = await busy.add("x", {});
await reach(busy, [running.id], ["active"]);
checkEqual(
  "remove() refuses an active job",
  await busy.remove(running.id),
  false,
);
check("…and leaves it in place", (await busy.getJob(running.id)) !== null);
gate.resolve();
await reach(busy, [running.id], ["completed"]);

/* ------------------------------------------------------------------ */
step("update(): data, priority, runAt, onlyIn");

const updating = openQueue("updating");
const first = await updating.add("x", { v: 1 }, { priority: 5 });
const second = await updating.add("x", { v: 2 }, { priority: 6 });

checkEqual(
  "data: answers with the job as it now is",
  (await updating.update(first.id, { data: { v: 10 } }))?.data,
  {
    v: 10,
  },
);
checkEqual("…and stores it", (await updating.getJob(first.id))?.data, {
  v: 10,
});
checkEqual(
  "priority: changes it",
  (await updating.update(second.id, { priority: -1 }))?.priority,
  -1,
);
checkEqual(
  "…and reorders the waiting jobs",
  (await updating.list("waiting")).map((job) => job.id),
  [second.id, first.id],
);

const future = Date.now() + 60_000;
const moved = await updating.update(first.id, { runAt: new Date(future) });
checkEqual(
  "runAt (a Date) in the future makes it delayed",
  [moved?.state, moved?.runAt],
  ["delayed", future],
);
checkEqual(
  "runAt (ms) in the past makes it waiting",
  (await updating.update(first.id, { runAt: Date.now() - 1_000 }))?.state,
  "waiting",
);

const refused = await updating.update(first.id, {
  data: { v: 99 },
  priority: 50,
  onlyIn: ["delayed"],
});
checkEqual(
  "onlyIn: a job in another state is not changed — null",
  refused,
  null,
);
const untouched = await updating.getJob(first.id);
checkEqual(
  "…and none of the patch applied",
  [untouched?.data, untouched?.priority],
  [{ v: 10 }, 5],
);
checkEqual(
  "onlyIn: a job in one of the states is changed",
  (
    await updating.update(first.id, {
      data: { v: 11 },
      onlyIn: ["waiting", "delayed"],
    })
  )?.data,
  { v: 11 },
);
checkEqual(
  "an unknown id answers null",
  await updating.update("no-such-job", { data: {} }),
  null,
);
checkEqual(
  "runAt cannot move a finished job",
  await busy.update(running.id, { runAt: Date.now() }),
  null,
);
checkEqual(
  "…but its data can still change",
  (await busy.update(running.id, { data: { v: 3 } }))?.data,
  { v: 3 },
);
await checkRejects(
  "a non-finite priority is refused",
  () => updating.update(first.id, { priority: Number.NaN }),
  {
    name: "ConfigError",
  },
);
await checkRejects(
  "an invalid runAt is refused",
  () => updating.update(first.id, { runAt: new Date("never") }),
  {
    name: "ConfigError",
  },
);

/* ------------------------------------------------------------------ */
step("retry(), retryJobs() and retryAll()");

const failing = openQueue("failing");
const failWorker = startWorker(
  "failing",
  (job) => {
    if (!job.data.fail) {
      return "ok";
    }
    const error = new Error(job.data.reason ?? "failed");
    if (job.data.errorName) {
      error.name = job.data.errorName;
    }
    throw error;
  },
  { concurrency: 8 },
);

/** Adds a job that will die with `reason`, and answers with its id. */
async function addFailure(
  name: string,
  reason: string,
  extra: Partial<Payload> = {},
  options: JobOptions = {},
): Promise<string> {
  return (await failing.add(name, { fail: true, reason, ...extra }, options))
    .id;
}

const twoAttempts: JobOptions = { attempts: 2, backoff: 0 };
const x1 = await addFailure("retry-me", "x", {}, twoAttempts);
const x2 = await addFailure("retry-me", "x", {}, twoAttempts);
const x3 = await addFailure("retry-me", "x", {}, twoAttempts);
const x4 = await addFailure("retry-me", "x", {}, twoAttempts);
const r1 = await addFailure("email", "ECONNREFUSED 10.0.0.1:25", { n: 1 });
const r2 = await addFailure("email", "ECONNREFUSED 10.0.0.2:25", { n: 2 });
const r3a = await addFailure("email", "mailbox full", { n: 3 });
const r3b = await addFailure("email", "mailbox full", { n: 4 });
const r4 = await addFailure("sms", "ECONNREFUSED gateway", { n: 5 });
const r5 = await addFailure("email", "bad payload", {
  n: 6,
  errorName: "TypeError",
});
const r6 = await addFailure("email", "quota", { n: 7 }, twoAttempts);
const ok1 = (await failing.add("report", { n: 8 })).id;
const ok2 = (await failing.add("report", { n: 9 })).id;
await reach(
  failing,
  [x1, x2, x3, x4, r1, r2, r3a, r3b, r4, r5, r6, ok1, ok2],
  ["completed", "dead"],
);
// Nothing may claim what is retried below.
await failWorker.close();

mark = heard.length;
checkEqual(
  "retry() returns a dead job to the queue",
  await failing.retry(x1, { resetAttempts: false }),
  true,
);
const keptAttempts = await failing.getJob(x1);
checkEqual(
  "resetAttempts: false keeps its attempts",
  [keptAttempts?.state, keptAttempts?.attemptsMade],
  ["waiting", 2],
);
checkEqual("retry() resets attempts by default", await failing.retry(x2), true);
checkEqual("…to zero", (await failing.getJob(x2))?.attemptsMade, 0);
checkEqual(
  "each retry() that went emitted one retried, with [id]",
  heardSince(mark, "failing", "retried"),
  [[[x1]], [[x2]]],
);
mark = heard.length;
checkEqual(
  "retrying a job that is already waiting answers false",
  await failing.retry(x1),
  false,
);
checkEqual("…as does an unknown id", await failing.retry("no-such-job"), false);
checkEqual(
  "a retry() that changed nothing emits no retried",
  heardSince(mark, "failing", "retried").length,
  0,
);

mark = heard.length;
const batch = await failing.retryJobs([x3, x4, x1, "no-such-job"], {
  resetAttempts: false,
});
checkEqual(
  "retryJobs() answers with the ids that went",
  sorted(batch),
  sorted([x3, x4]),
);
checkEqual(
  "…emitting one retried for the batch, with just those ids",
  heardSince(mark, "failing", "retried").map(([ids]) =>
    sorted(ids as string[]),
  ),
  [sorted([x3, x4])],
);
checkEqual(
  "resetAttempts: false kept their attempts",
  (await failing.getJob(x3))?.attemptsMade,
  2,
);
mark = heard.length;
checkEqual("retryJobs([]) retries nothing", await failing.retryJobs([]), []);
checkEqual(
  "…and emits nothing",
  heardSince(mark, "failing", "retried").length,
  0,
);

checkEqual(
  "retryAll name: only that name",
  await failing.retryAll("dead", { name: "sms" }),
  [r4],
);
checkEqual(
  "reason as a RegExp, against 'name: message' — every match, even with a global pattern",
  sorted(
    await failing.retryAll("dead", {
      reason: /Error: ECONNREFUSED 10\.0\.0\.\d/g,
    }),
  ),
  sorted([r1, r2]),
);
const firstMailbox = await failing.retryAll("dead", {
  reason: "mailbox full",
  limit: 1,
});
check(
  "limit: stops after that many",
  firstMailbox.length === 1 && [r3a, r3b].includes(firstMailbox[0]!),
  firstMailbox,
);
checkEqual(
  "reason as a substring: the other one",
  await failing.retryAll("dead", { reason: "mailbox full" }),
  [r3a, r3b].filter((id) => id !== firstMailbox[0]),
);
checkEqual(
  "the error's name is part of what reason matches",
  await failing.retryAll("dead", { reason: /^TypeError: bad payload$/ }),
  [r5],
);
checkEqual(
  "filter: only jobs it accepts",
  await failing.retryAll("dead", {
    filter: (job) => job.data.n === 7,
    resetAttempts: false,
  }),
  [r6],
);
checkEqual(
  "…resetAttempts: false kept its attempts",
  (await failing.getJob(r6))?.attemptsMade,
  2,
);
checkEqual(
  "reason never matches a completed job",
  await failing.retryAll("completed", { reason: "ok" }),
  [],
);
checkEqual(
  "retryAll('completed') re-runs finished jobs",
  sorted(await failing.retryAll("completed", { name: "report" })),
  sorted([ok1, ok2]),
);
checkEqual(
  "…resetting their attempts by default",
  (await failing.getJob(ok1))?.attemptsMade,
  0,
);
checkEqual("nothing dead is left to retry", await failing.retryAll("dead"), []);
checkEqual(
  "every retryAll that retried something emitted retried once",
  heardSince(mark, "failing", "retried").length,
  7,
);

/* ------------------------------------------------------------------ */
step("cleanWindows(): stale debounce and throttle pointers");

const windows = openQueue("windows");
let lastWindowAt = 0;
for (let n = 1; n <= 5; n++) {
  await windows.add("ping", {}, { throttle: { id: `w${n}`, ttl: 100 } });
  lastWindowAt = Date.now();
}
await clockPast(lastWindowAt + 150);
checkEqual(
  "limit: examines at most that many entries",
  await windows.cleanWindows({ limit: 2 }),
  2,
);
checkEqual("with no limit, the rest", await windows.cleanWindows(), 3);
checkEqual("and then nothing is left", await windows.cleanWindows(), 0);
const pendingDebounce = await windows.add(
  "save",
  {},
  { debounce: { id: "d1", ttl: 60_000 } },
);
await windows.add("ping", {}, { throttle: { id: "open", ttl: 60_000 } });
checkEqual(
  "a debounce whose job is pending, and an open throttle, are kept",
  await windows.cleanWindows(),
  0,
);
await windows.remove(pendingDebounce.id);
checkEqual(
  "a debounce whose job is gone is removed",
  await windows.cleanWindows(),
  1,
);

/* ------------------------------------------------------------------ */
step("getJobLogs(): offset, limit, order");

const withLog = await orders.add("logged", {}, { delay: 3_600_000 });
for (let line = 1; line <= 5; line++) {
  await withLog.log(`line ${line}`);
}
checkEqual("oldest first by default", await orders.getJobLogs(withLog.id), {
  logs: ["line 1", "line 2", "line 3", "line 4", "line 5"],
  count: 5,
});
checkEqual(
  "offset and limit page it",
  await orders.getJobLogs(withLog.id, { offset: 1, limit: 2 }),
  {
    logs: ["line 2", "line 3"],
    count: 5,
  },
);
checkEqual(
  "order: desc is newest first",
  await orders.getJobLogs(withLog.id, { order: "desc", limit: 2 }),
  {
    logs: ["line 5", "line 4"],
    count: 5,
  },
);
checkEqual(
  "…and offsets from the newest",
  await orders.getJobLogs(withLog.id, { order: "desc", offset: 1, limit: 1 }),
  {
    logs: ["line 4"],
    count: 5,
  },
);
checkEqual(
  "an unknown job has no log",
  await orders.getJobLogs("no-such-job"),
  { logs: [], count: 0 },
);

/* ------------------------------------------------------------------ */
step("promote(): a delayed job, now");

mark = heard.length;
const promotable = await orders.add("later", {}, { delay: 60_000 });
checkEqual(
  "promote() makes a delayed job claimable",
  await orders.promote(promotable.id),
  true,
);
const promotedJob = await orders.getJob(promotable.id);
check(
  "…waiting, and due now",
  promotedJob?.state === "waiting" && promotedJob.runAt <= Date.now(),
  promotedJob?.toJSON(),
);
checkEqual(
  "…emitting promoted with its id",
  heardSince(mark, "orders", "promoted"),
  [[promotable.id]],
);
checkEqual(
  "a waiting job cannot be promoted",
  await orders.promote(promotable.id),
  false,
);
checkEqual("…nor an unknown one", await orders.promote("no-such-job"), false);

/* ------------------------------------------------------------------ */
step("setLimits() and getLimits()");

const limited = openQueue("limited");
checkEqual(
  "getLimits() is null until limits are set",
  await limited.getLimits(),
  null,
);
await limited.setLimits({
  rate: { max: 10, duration: "1 minute" },
  concurrency: 3,
  names: {
    sendEmail: { concurrency: 1, rate: { max: 2, duration: 500 } },
    unlimited: {},
  },
});
checkEqual(
  "stored with durations in ms, a name with no limits dropped",
  await limited.getLimits(),
  {
    rate: { max: 10, duration: 60_000 },
    concurrency: 3,
    names: { sendEmail: { concurrency: 1, rate: { max: 2, duration: 500 } } },
  },
);
await limited.setLimits({ concurrency: 2 });
checkEqual("setLimits() replaces them whole", await limited.getLimits(), {
  concurrency: 2,
});
await limited.setLimits(null);
checkEqual("null removes them", await limited.getLimits(), null);
await limited.setLimits(null);
checkEqual("…and removing none is harmless", await limited.getLimits(), null);
await checkRejects(
  "concurrency 0 is refused",
  () => limited.setLimits({ concurrency: 0 }),
  { name: "ConfigError" },
);
await checkRejects(
  "a fractional rate max is refused",
  () => limited.setLimits({ rate: { max: 1.5, duration: 1_000 } }),
  {
    name: "ConfigError",
  },
);
await checkRejects(
  "a rate duration that is not a duration is refused",
  () =>
    limited.setLimits({
      rate: { max: 1, duration: "soon" },
    }),
  { name: "ConfigError" },
);

/* ------------------------------------------------------------------ */
step("pause(), resume() and isPaused()");

const pausing = openQueue("pausing");
mark = heard.length;
checkEqual(
  "isPaused() is false to begin with",
  await pausing.isPaused(),
  false,
);
await pausing.pause();
checkEqual("pause() pauses every worker", await pausing.isPaused(), true);
const held = await pausing.add("x", {});
startWorker("pausing", () => "ran");
await clockPast(Date.now() + 600);
checkEqual(
  "a paused queue's job is not claimed",
  (await pausing.getJob(held.id))?.state,
  "waiting",
);
await pausing.resume();
checkEqual("resume() lets them claim again", await pausing.isPaused(), false);
check(
  "…and the held job runs",
  await eventually(
    async () => (await pausing.getJob(held.id))?.state === "completed",
  ),
);
checkEqual(
  "paused and resumed were emitted",
  [
    heardSince(mark, "pausing", "paused").length,
    heardSince(mark, "pausing", "resumed").length,
  ],
  [1, 1],
);

/* ------------------------------------------------------------------ */
step("drain(): waiting jobs, and delayed ones when asked");

const draining = openQueue("draining");
mark = heard.length;
await draining.add("x", {});
await draining.add("x", {});
await draining.add("x", {}, { delay: 60_000 });
checkEqual("drain() drops the waiting jobs", await draining.drain(), 2);
checkEqual(
  "…and leaves delayed ones",
  [await draining.count("waiting"), await draining.count("delayed")],
  [0, 1],
);
await draining.add("x", {});
checkEqual(
  "drain({ delayed: true }) drops those too",
  await draining.drain({ delayed: true }),
  2,
);
checkEqual(
  "…leaving nothing pending",
  [await draining.count("waiting"), await draining.count("delayed")],
  [0, 0],
);
checkEqual(
  "drained carried each count",
  heardSince(mark, "draining", "drained"),
  [[2], [2]],
);

/* ------------------------------------------------------------------ */
step("clean(): each state, olderThan, limit");

const cleaning = openQueue("cleaning");
const cleanWorker = startWorker(
  "cleaning",
  (job) => {
    if (job.data.fail) {
      throw new Error("failed on purpose");
    }
    return "ok";
  },
  { concurrency: 4 },
);
const completedIds: string[] = [];
for (let n = 0; n < 3; n++) {
  completedIds.push((await cleaning.add("x", { n })).id);
}
const deadOne = await cleaning.add("x", { fail: true });
const retryPending = await cleaning.add(
  "x",
  { fail: true },
  { attempts: 2, backoff: 60_000 },
);
await reach(cleaning, completedIds, ["completed"]);
await reach(cleaning, [deadOne.id], ["dead"]);
await reach(cleaning, [retryPending.id], ["failed"]);
await cleanWorker.close();
const waitingOne = await cleaning.add("x", {});
const waitingTwo = await cleaning.add("x", {});
const delayedOne = await cleaning.add("x", {}, { delay: 60_000 });
await clockPast(Date.now());

mark = heard.length;
checkEqual(
  "olderThan: nothing finished a minute ago",
  await cleaning.clean("completed", { olderThan: 60_000 }),
  [],
);
checkEqual(
  "…and an empty clean emits nothing",
  heardSince(mark, "cleaning", "cleaned").length,
  0,
);
const cleanedTwo = await cleaning.clean("completed", {
  olderThan: 0,
  limit: 2,
});
checkEqual(
  "limit: removes at most that many",
  [cleanedTwo.length, await cleaning.count("completed")],
  [2, 1],
);
checkEqual(
  "cleaned carries the ids and the state",
  heardSince(mark, "cleaning", "cleaned").map(([ids, state]) => [
    sorted(ids as string[]),
    state,
  ]),
  [[sorted(cleanedTwo), "completed"]],
);
checkEqual(
  "completed: the rest",
  (await cleaning.clean("completed", { olderThan: 0 })).length,
  1,
);
checkEqual("dead", await cleaning.clean("dead", { olderThan: 0 }), [
  deadOne.id,
]);
// Age is measured from when the job finished or was added — not from when it
// is due — so a job waiting for a future retry is still old enough to clean.
checkEqual(
  "failed (awaiting a retry)",
  await cleaning.clean("failed", { olderThan: 0 }),
  [retryPending.id],
);
checkEqual(
  "waiting",
  sorted(await cleaning.clean("waiting", { olderThan: 0 })),
  sorted([waitingOne.id, waitingTwo.id]),
);
checkEqual("delayed", await cleaning.clean("delayed", { olderThan: 0 }), [
  delayedOne.id,
]);

/* ------------------------------------------------------------------ */
step("listRepeatables() and removeRepeatable()");

mark = heard.length;
const hourly = await orders.add(
  "report",
  {},
  { repeat: { every: 3_600_000, key: "hourly-report" } },
);
const listed = (await orders.listRepeatables()).find(
  (entry) => entry.key === "hourly-report",
);
checkEqual(
  "listRepeatables() reports the series and its next occurrence",
  [listed?.name, listed?.every, listed?.nextJobId, listed?.nextRunAt],
  ["report", 3_600_000, hourly.id, hourly.runAt],
);
checkEqual(
  "repeatScheduled carried its key and when",
  heardSince(mark, "orders", "repeatScheduled"),
  [["hourly-report", hourly.runAt]],
);
checkEqual(
  "removeRepeatable() removes it",
  await orders.removeRepeatable("hourly-report"),
  true,
);
checkEqual(
  "…and the occurrence it had scheduled",
  await orders.getJob(hourly.id),
  null,
);
check(
  "…and it is no longer listed",
  !(await orders.listRepeatables()).some(
    (entry) => entry.key === "hourly-report",
  ),
);
checkEqual(
  "removing it again answers false",
  await orders.removeRepeatable("hourly-report"),
  false,
);
await orders.removeRepeatable("bulk-repeat");

/* ------------------------------------------------------------------ */
step("debounced and throttled");

mark = heard.length;
const debouncedJob = await orders.add(
  "save",
  {},
  { debounce: { id: "events", ttl: 60_000 } },
);
await orders.add("save", {}, { debounce: { id: "events", ttl: 60_000 } });
const throttledJob = await orders.add(
  "ping",
  {},
  { throttle: { id: "events", ttl: 60_000 } },
);
await orders.add("ping", {}, { throttle: { id: "events", ttl: 60_000 } });
checkEqual(
  "debounced carries the pending job",
  jobIdsSince(mark, "orders", "debounced"),
  [debouncedJob.id],
);
checkEqual(
  "throttled carries the job that opened the window",
  jobIdsSince(mark, "orders", "throttled"),
  [throttledJob.id],
);

/* ------------------------------------------------------------------ */
step("Every queue event was heard at least once");

for (const event of QUEUE_EVENTS) {
  check(
    event,
    heard.some((entry) => entry.event === event),
  );
}
show("events heard", heard.length);

/* ------------------------------------------------------------------ */
step("close(): a closed queue refuses work");

await orders.close();
await checkRejects("add() after close()", () => orders.add("x", {}), {
  name: "QueueClosedError",
  code: "QUEUE_CLOSED",
});
await checkRejects("connect() after close()", () => orders.connect(), {
  name: "QueueClosedError",
});

/* ------------------------------------------------------------------ */
step("Cleaning up");

for (const close of closers) {
  await close();
}
await driver.purge(namespace);
await driver.purge(otherNamespace);
await driver.close();

summary();
