/**
 * What the live-events socket delivers, checked on whichever backend
 * `EXAMPLE_DRIVER` names: a queue or runner nobody has discovered yet, the
 * multi-job events on a job's channel, and broad channels that hide a queue
 * and a runner their host denies.
 *
 * ```bash
 * bun 11-management-api/live-events-delivery.ts
 * EXAMPLE_DRIVER=redis EXAMPLE_REDIS_URL=redis://localhost:6379/13 \
 *   bun 11-management-api/live-events-delivery.ts
 * ```
 *
 * [`live-events.ts`](./live-events.ts) is the walk-through; this file asserts
 * the three guarantees whose events travel through the driver, so it is worth
 * running against each backend rather than only in memory:
 *
 * - **Subscribing to a queue or runner follows it.** The notifier behind the
 *   socket finds new ones on a discovery pass (every two seconds). A
 *   `queue/<q>` or `runner/<r>` subscription does not wait for one: the `ack`
 *   comes back once it is followed, so its first event is heard even if
 *   nothing has discovered it.
 * - **A job's channel hears about it among several.** `stalled`, `retried`
 *   and `cleaned` name their jobs in `payload.ids`; each of those jobs'
 *   channels receives the event — once per connection, listing every channel
 *   it matched.
 * - **Broad channels are authorized per target.** `all`, `queues` and
 *   `runners` carry every queue's or runner's events, so `authorize` is asked
 *   again for each target, on its first event — `{ action: "events.subscribe",
 *   transport: "ws", channel: "all", queue }` (or `runner`) — and a target it
 *   denies never appears there.
 * - **The broad `workers` channel follows queues created after it.** A queue
 *   the API's own `BunJobs` creates is followed at once — its worker's first
 *   start (a `state` with no `previous`) arrives, and no gap. One another
 *   process creates is followed from the server's next discovery pass, with
 *   exactly one `gap { reason: "queue-discovered", channels: ["workers"],
 *   fromSeq: 0 }` per pass, sent only to `workers` subscribers: what that
 *   queue's workers published before the pass was never heard, so refetch
 *   `GET /workers`. That listing shows a worker on a just-created queue at
 *   once, whatever the queue cache (`limits.queueCacheMs`) holds.
 */
import type { WorkerEventPayloads } from "@kingsleyweb/bun-jobs";
import type { Frame } from "./helpers/jobs-socket";
import process from "node:process";
import { BunHttpAdapter, BunRouter, noopLogger } from "@kingsleyweb/bun-common";
import {
  BunJobs,
  BunQueue,
  BunRunner,
  createDriver,
  createJobsApi,
} from "@kingsleyweb/bun-jobs";
import {
  crossProcessDriver,
  exampleDriver,
  exampleNamespace,
} from "../shared/backend";
import { check, checkEqual, summary } from "../shared/check";
import { show, step, title, waitFor } from "../shared/console";
import { connectJobsSocket } from "./helpers/jobs-socket";

title("The management API: what the socket delivers");

/** Generous, because a database server may be shared with other suites. */
const WAIT = { timeout: 30_000, interval: 10 };

/* ------------------------------------------------------------------ */
step("A context, a queue it did not create, and an API");

// One driver instance, shared by the context and the stray queue below — on
// the memory driver that is what makes them one store.
const driver = createDriver(exampleDriver());
const namespace = exampleNamespace("live-delivery");
const jobs = new BunJobs({
  namespace,
  driver,
  publishEvents: true,
  logger: noopLogger,
});

/** Every `events.subscribe` decision asked for, as `<channel> <queue>`. */
const asked: string[] = [];
/** The same for runners, as `<channel> <runner>`. */
const askedRunners: string[] = [];

const api = createJobsApi({
  jobs,
  basePath: "/admin/jobs",
  logger: noopLogger,
  // An auditor (`x-role: audit`) sees everything; anyone else may not see the
  // `payroll` queue or the `payroll-export` runner — not by name, and not
  // through a broad channel either.
  authorize: (req, context) => {
    if (context.action === "events.subscribe" && context.queue) {
      asked.push(`${context.channel ?? "?"} ${context.queue}`);
    }
    if (context.action === "events.subscribe" && context.runner) {
      askedRunners.push(`${context.channel ?? "?"} ${context.runner}`);
    }
    return (
      req.getHeader("x-role") === "audit" ||
      (context.queue !== "payroll" && context.runner !== "payroll-export") || {
        allow: false,
        reason: "payroll is private",
      }
    );
  },
  websocket: { heartbeatMs: 0, coalesceProgressMs: 0 },
});

const adapter = new BunHttpAdapter(0, { logger: noopLogger });
adapter.use(api.basePath, api.router);
api.websocket!.attach(adapter);
const server = await adapter.listen(0);
const url = `ws://127.0.0.1:${server.port}${api.websocket!.path}`;
show("backend", driver.constructor.name);

/* ------------------------------------------------------------------ */
step("A queue nothing has discovered: its first event is heard");

// Made directly rather than through `jobs`, so the API's notifier has no
// reason to know about it — only a discovery pass would find it.
const stray = new BunQueue("stray", { namespace, driver, publish: true });

const watcher = await connectJobsSocket(url);
await watcher.next("hello");
watcher.send({ op: "subscribe", id: "stray", channels: ["queue/stray"] });
const strayAck = await watcher.next("ack", (frame) => frame.id === "stray");
checkEqual("the queue channel is accepted", strayAck.channels, ["queue/stray"]);

// Straight after the ack — no pause for a discovery pass.
const first = await stray.add("first", {});
const firstAdded = await watcher.next(
  "event",
  (frame) => frame.event.type === "added" && frame.event.id === first.id,
);
checkEqual("its very first event arrived", firstAdded.subscriptions, [
  "queue/stray",
]);

/* ------------------------------------------------------------------ */
step("A runner nothing has discovered: its first event is heard too");

/** The runs below: quick, and in this process. */
const work = new URL("../10-options/handlers/runner-work.ts", import.meta.url);

// Made directly, like the stray queue, so only a discovery pass would find it.
const strayRunner = new BunRunner({
  id: "stray-runner",
  namespace,
  driver,
  file: work,
  executionMode: "in-process",
  publish: true,
  logger: noopLogger,
});
await strayRunner.start();
watcher.send({
  op: "subscribe",
  id: "stray-runner",
  channels: ["runner/stray-runner"],
});
await watcher.next("ack", (frame) => frame.id === "stray-runner");
await strayRunner.trigger();
const strayStarted = await watcher.next(
  "event",
  (frame) =>
    frame.event.kind === "runner" &&
    frame.event.target === "stray-runner" &&
    frame.event.type === "started",
);
checkEqual("its first run's start arrived", strayStarted.subscriptions, [
  "runner/stray-runner",
]);

/* ------------------------------------------------------------------ */
step("retried and cleaned reach each job's own channel");

const invoices = jobs.queue<{ n: number }>("invoices");
const worker = jobs.worker<{ n: number }, number>(
  "invoices",
  async (job) => job.data.n,
  { pollInterval: 25 },
);
const running = worker.run();
const one = await invoices.add("send", { n: 1 });
const two = await invoices.add("send", { n: 2 });
await waitFor(
  "both invoices to complete",
  async () => (await invoices.count()).completed >= 2,
  WAIT,
);
// Stopped, so the retried jobs stay waiting for the `clean` below.
await worker.close();
await running;

const jobChannels = [
  `queue/invoices/job/${encodeURIComponent(one.id)}`,
  `queue/invoices/job/${encodeURIComponent(two.id)}`,
];
watcher.send({ op: "subscribe", id: "jobs", channels: jobChannels });
await watcher.next("ack", (frame) => frame.id === "jobs");

const retriedIds = await invoices.retryJobs([one.id, two.id]);
checkEqual("both went back to the queue", retriedIds.length, 2);
const retried = await watcher.next(
  "event",
  (frame) => frame.event.type === "retried",
);
checkEqual(
  "one retried frame, listing both job channels it matched",
  [...retried.subscriptions].sort(),
  [...jobChannels].sort(),
);
checkEqual(
  "…carrying both ids",
  [...(retried.event.payload as { ids: string[] }).ids].sort(),
  [one.id, two.id].sort(),
);

// `olderThan: 0` still compares timestamps, so let the clock move past the
// retry before asking for everything waiting.
const retriedAt = Date.now();
await waitFor("the clock to pass the retry", () => Date.now() > retriedAt + 5);
const cleanedIds = await invoices.clean("waiting", { olderThan: 0 });
checkEqual("clean removed both", cleanedIds.length, 2);
const cleaned = await watcher.next(
  "event",
  (frame) => frame.event.type === "cleaned",
);
checkEqual(
  "cleaned reaches both job channels, once",
  [...cleaned.subscriptions].sort(),
  [...jobChannels].sort(),
);
checkEqual(
  "exactly one frame per event",
  watcher
    .all("event")
    .filter((frame) => ["retried", "cleaned"].includes(frame.event.type))
    .length,
  2,
);

/* ------------------------------------------------------------------ */
step("A broad channel never shows a queue the host denies");

const staff = await connectJobsSocket(url);
await staff.next("hello");
staff.send({
  op: "subscribe",
  id: "broad",
  channels: ["all", "queues", "queue/payroll"],
});
const broadAck = await staff.next("ack", (frame) => frame.id === "broad");
checkEqual("the broad channels are accepted", broadAck.channels, [
  "all",
  "queues",
]);
checkEqual(
  "while the payroll channel is refused by name",
  broadAck.rejected?.map((rejection) => [rejection.channel, rejection.code]),
  [["queue/payroll", "FORBIDDEN"]],
);

// The auditor's own view of payroll: its arrival proves the hub stamped the
// event, and therefore offered it to the staff connection as well.
const auditor = await connectJobsSocket(url, {
  headers: { "x-role": "audit" },
});
await auditor.next("hello");
auditor.send({ op: "subscribe", id: "p", channels: ["queue/payroll"] });
await auditor.next("ack", (frame) => frame.id === "p");

const payroll = jobs.queue("payroll");
const mail = jobs.queue("mail");
const salary = await payroll.add("pay", {});
const letter = await mail.add("send", {});

await auditor.next(
  "event",
  (frame) => frame.event.type === "waiting" && frame.event.id === salary.id,
);
await staff.next(
  "event",
  (frame) => frame.event.type === "waiting" && frame.event.id === letter.id,
);
await waitFor(
  "each broad channel to have asked about payroll",
  () => asked.includes("all payroll") && asked.includes("queues payroll"),
  WAIT,
);
// A round trip on the staff connection: anything already queued for it has
// arrived by the time its pong does.
staff.send({ op: "ping", id: "flush" });
await staff.next("pong", (frame) => frame.id === "flush");

check(
  "no payroll event reached the staff connection",
  !staff.all("event").some((frame) => frame.event.target === "payroll"),
  staff
    .all("event")
    .map((frame) => `${frame.event.target}:${frame.event.type}`),
);
check(
  "while mail arrived on both broad channels",
  staff
    .all("event")
    .some(
      (frame) =>
        frame.event.target === "mail" &&
        frame.subscriptions.includes("all") &&
        frame.subscriptions.includes("queues"),
    ),
);
checkEqual(
  "authorize was asked once per broad channel and queue",
  asked
    .filter((entry) => entry.startsWith("all ") || entry.startsWith("queues "))
    .filter((entry) => entry.endsWith(" payroll") || entry.endsWith(" mail"))
    .sort(),
  ["all mail", "all payroll", "queues mail", "queues payroll"],
);
show("decisions asked for", asked);

/* ------------------------------------------------------------------ */
step("The runners channel hides a runner the host denies, the same way");

const exporter = jobs.runner({
  id: "payroll-export",
  file: work,
  executionMode: "in-process",
});
const report = jobs.runner({
  id: "weekly-report",
  file: work,
  executionMode: "in-process",
});
await Promise.all([exporter.start(), report.start()]);

staff.send({ op: "subscribe", id: "runners", channels: ["runners"] });
await staff.next("ack", (frame) => frame.id === "runners");
auditor.send({
  op: "subscribe",
  id: "export",
  channels: ["runner/payroll-export"],
});
await auditor.next("ack", (frame) => frame.id === "export");

await exporter.trigger();
await report.trigger();
/** Whether a frame is one runner's `succeeded` event. */
const succeeded = (
  frame: { event: { kind: string; type: string; target: string } },
  runner: string,
) =>
  frame.event.kind === "runner" &&
  frame.event.type === "succeeded" &&
  frame.event.target === runner;
await auditor.next("event", (frame) => succeeded(frame, "payroll-export"));
await staff.next("event", (frame) => succeeded(frame, "weekly-report"));
await waitFor(
  "each broad channel to have asked about payroll-export",
  () =>
    askedRunners.includes("all payroll-export") &&
    askedRunners.includes("runners payroll-export"),
  WAIT,
);
staff.send({ op: "ping", id: "flush-runners" });
await staff.next("pong", (frame) => frame.id === "flush-runners");

check(
  "no payroll-export event reached the staff connection",
  !staff.all("event").some((frame) => frame.event.target === "payroll-export"),
);
check(
  "while weekly-report arrived on both `all` and `runners`",
  staff
    .all("event")
    .some(
      (frame) =>
        frame.event.target === "weekly-report" &&
        frame.subscriptions.includes("all") &&
        frame.subscriptions.includes("runners"),
    ),
);
checkEqual(
  "authorize was asked once per broad channel and runner",
  askedRunners
    .filter((entry) =>
      /^(?:all|runners) (?:payroll-export|weekly-report)$/.test(entry),
    )
    .sort(),
  [
    "all payroll-export",
    "all weekly-report",
    "runners payroll-export",
    "runners weekly-report",
  ],
);

/* ------------------------------------------------------------------ */
step("The workers channel follows a queue this context creates: no gap");

/** A worker `state` event's payload, as the socket delivers it. */
type StateWire = WorkerEventPayloads["state"];

/** Whether a frame is a worker `state` event on `queue`. */
function isStateOn(frame: Frame<"event">, queue: string): boolean {
  return (
    frame.event.kind === "worker" &&
    frame.event.type === "state" &&
    frame.event.target === queue
  );
}

/** A frame's payload, read as a worker `state`. */
const stateOf = (frame: Frame<"event">) => frame.event.payload as StateWire;

const crew = await connectJobsSocket(url);
await crew.next("hello");
crew.send({ op: "subscribe", id: "crew", channels: ["workers"] });
await crew.next("ack", (frame) => frame.id === "crew");

// `digest` does not exist yet: the worker's first `run()` creates it, and the
// channel, subscribed before, follows it before anything is published there.
const digest = jobs.worker("digest", async () => null, { pollInterval: 25 });
const digestRunning = digest.run();
/** Whether a frame is a worker `state` event on `digest`. */
const onDigest = (frame: Frame<"event">) => isStateOn(frame, "digest");
const digestFirst = await crew.next("event", onDigest);
checkEqual(
  "its worker's first start arrived: running, with no previous",
  [
    stateOf(digestFirst).state,
    stateOf(digestFirst).worker,
    Object.hasOwn(stateOf(digestFirst), "previous"),
    digestFirst.subscriptions,
  ],
  ["running", digest.id, false, ["workers"]],
);
await digest.pause();
const digestPaused = await crew.next(
  "event",
  (frame) => onDigest(frame) && frame.seq !== digestFirst.seq,
);
checkEqual(
  "a later change carries previous",
  [stateOf(digestPaused).previous, stateOf(digestPaused).state],
  ["running", "paused"],
);
crew.send({ op: "ping", id: "crew-flush" });
await crew.next("pong", (frame) => frame.id === "crew-flush");
checkEqual("nothing was missed, so no gap", crew.all("gap"), []);

/* ------------------------------------------------------------------ */
step("GET /workers lists a worker on a just-created queue at once");

// An API with a long queue cache, so a queue newer than the cached list
// would stay hidden for a minute if a live worker did not prove it exists.
const listing = createJobsApi({
  jobs,
  basePath: "/listing",
  logger: noopLogger,
  authorize: () => true,
  limits: { queueCacheMs: 60_000 },
});
const listingRouter = new BunRouter();
listingRouter.use(listing.basePath, listing.router);

/** A GET against the listing API, parsed. */
async function list(path: string) {
  const response = await listingRouter.fetch(`/listing${path}`);
  return {
    status: response.status,
    body: (await response.json()) as {
      items?: { id?: string; name?: string; queue?: string }[];
      rows?: { key: string; queue: string }[];
    },
  };
}

// Fills the queue cache while `ledger` does not exist.
const namesBefore = (await list("/queues")).body.items?.map((q) => q.name);
check("the cached queue list has no ledger", !namesBefore?.includes("ledger"));
await list("/workers");

const ledger = jobs.worker("ledger", async () => null, { pollInterval: 25 });
const ledgerRunning = ledger.run();
await waitFor(
  "the ledger worker to report",
  async () =>
    (await jobs.listWorkers()).some((worker) => worker.id === ledger.id),
  WAIT,
);
check(
  "GET /workers lists it straight away, inside the cache window",
  (await list("/workers")).body.items?.some(
    (worker) => worker.id === ledger.id,
  ) === true,
);
check(
  "and the fresh read refreshed the cache: GET /queues has ledger now",
  (await list("/queues")).body.items?.some((q) => q.name === "ledger") === true,
);
const workersAnalytics = await list("/analytics/workers");
if (workersAnalytics.status === 200) {
  check(
    "GET /analytics/workers has its row too",
    workersAnalytics.body.rows?.some((row) => row.queue === "ledger") === true,
    workersAnalytics.body.rows,
  );
} else {
  show(
    "skipped: GET /analytics/workers is not served on this backend",
    workersAnalytics.status,
  );
}

/* ------------------------------------------------------------------ */
step("A queue another process creates: one queue-discovered gap");

// Its own context and API, on a backend two processes can share: on the
// memory default that is a temporary SQLite file.
const sharedConfig = crossProcessDriver();
const home = new BunJobs({
  namespace: exampleNamespace("live-discovered"),
  driver: sharedConfig,
  publishEvents: true,
  logger: noopLogger,
});
const homeApi = createJobsApi({
  jobs: home,
  basePath: "/admin/jobs",
  logger: noopLogger,
  authorize: () => true,
  websocket: { heartbeatMs: 0, coalesceProgressMs: 0 },
});
const homeAdapter = new BunHttpAdapter(0, { logger: noopLogger });
homeAdapter.use(homeApi.basePath, homeApi.router);
homeApi.websocket!.attach(homeAdapter);
const homeServer = await homeAdapter.listen(0);
const homeUrl = `ws://127.0.0.1:${homeServer.port}${homeApi.websocket!.path}`;

const onWorkers = await connectJobsSocket(homeUrl);
const homeHello = await onWorkers.next("hello");
onWorkers.send({ op: "subscribe", id: "w", channels: ["workers"] });
await onWorkers.next("ack", (frame) => frame.id === "w");
const elsewhere = await connectJobsSocket(homeUrl);
await elsewhere.next("hello");
elsewhere.send({ op: "subscribe", id: "q", channels: ["queues", "runners"] });
await elsewhere.next("ack", (frame) => frame.id === "q");

const child = Bun.spawn({
  cmd: [
    process.execPath,
    new URL("./helpers/discovered-queue.ts", import.meta.url).pathname,
  ],
  env: {
    ...process.env,
    NAMESPACE: home.namespace,
    DRIVER_CONFIG: JSON.stringify(sharedConfig),
  },
  stdin: "pipe",
  stdout: "ignore",
  stderr: "inherit",
});
process.once("exit", () => child.kill("SIGKILL"));

// The server learns of `imports` only from its discovery pass (every 2 s).
const discovered = await onWorkers.next(
  "gap",
  (frame) => frame.reason === "queue-discovered",
);
checkEqual(
  "a workers subscriber is told: queue-discovered, scoped to workers, from 0",
  [
    discovered.reason,
    discovered.channels,
    discovered.fromSeq,
    discovered.epoch,
    typeof discovered.toSeq,
  ],
  ["queue-discovered", ["workers"], 0, homeHello.epoch, "number"],
);

// Followed from here on: the child's worker's first start is heard.
child.stdin.write("run\n");
child.stdin.flush();
/** Whether a frame is a worker `state` event on `imports`. */
const onImports = (frame: Frame<"event">) => isStateOn(frame, "imports");
const importsFirst = await onWorkers.next("event", onImports);
checkEqual(
  "then its worker's first start arrives: running, no previous",
  [
    stateOf(importsFirst).state,
    Object.hasOwn(stateOf(importsFirst), "previous"),
    importsFirst.subscriptions,
  ],
  ["running", false, ["workers"]],
);
await home.workers
  .controller("imports")
  .pause({ id: stateOf(importsFirst).worker });
const importsPaused = await onWorkers.next(
  "event",
  (frame) => onImports(frame) && frame.seq !== importsFirst.seq,
);
checkEqual(
  "and a remote pause arrives as running -> paused",
  [stateOf(importsPaused).previous, stateOf(importsPaused).state],
  ["running", "paused"],
);

// Two more discovery passes' worth, then a round trip on each connection.
await Bun.sleep(4_500);
for (const [client, id] of [
  [onWorkers, "w-flush"],
  [elsewhere, "q-flush"],
] as const) {
  client.send({ op: "ping", id });
  await client.next("pong", (frame) => frame.id === id);
}
checkEqual(
  "exactly one gap for the pass that found it",
  onWorkers.all("gap").length,
  1,
);
checkEqual(
  "and none to a connection without the workers channel",
  elsewhere.all("gap").filter((frame) => frame.reason === "queue-discovered"),
  [],
);

child.stdin.write("exit\n");
child.stdin.flush();
checkEqual("the other process exited cleanly", await child.exited, 0);

/* ------------------------------------------------------------------ */
step("Cleaning up: only this run's namespaces");

for (const client of [watcher, staff, auditor, crew, onWorkers, elsewhere]) {
  client.close();
}
await homeApi.close();
await homeAdapter.close();
await home.purge();
await home.close();
await digest.close();
await ledger.close();
await Promise.all([digestRunning, ledgerRunning]);
await listing.close();
await api.close();
await adapter.close();
await stray.close();
await strayRunner.stop();
await jobs.purge();
await jobs.close();
await driver.close();

summary();
